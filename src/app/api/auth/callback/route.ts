import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { DomainError } from "@/lib/errors";
import { getSession } from "@/modules/identity/session";
import { discover, exchangeCode, resolveOidcUser } from "@/modules/identity/oidc";

export const dynamic = "force-dynamic";

/** Rückkehr vom Identitätsanbieter: State prüfen, Code tauschen, ID-Token verifizieren, Zugang zuordnen, Sitzung setzen. */
export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const fail = (msg: string) => NextResponse.redirect(new URL("/anmelden?fehler=" + encodeURIComponent(msg), req.url));
  if (cfg.AUTH_MODE !== "oidc") return fail("Unternehmensanmeldung ist nicht aktiv.");
  const session = await getSession();
  const pending = session.pendingLogin;
  const params = req.nextUrl.searchParams;
  if (params.get("error")) {
    session.pendingLogin = undefined;
    await session.save();
    return fail("Anmeldung abgebrochen: " + (params.get("error_description") ?? params.get("error") ?? "").slice(0, 200));
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!pending || !code || !state || state !== pending.state || Date.now() - pending.startedAt > 10 * 60 * 1000) {
    session.pendingLogin = undefined;
    await session.save();
    return fail("Die Anmeldung ist abgelaufen oder ungültig. Bitte erneut starten.");
  }
  try {
    const doc = await discover(cfg.OIDC_ISSUER!);
    const claims = await exchangeCode(doc, code, pending, cfg);
    const r = await resolveOidcUser(claims, cfg);
    session.pendingLogin = undefined;
    session.userId = r.userId;
    session.mode = "oidc";
    session.issuedAt = Date.now();
    session.lastSeenAt = Date.now();
    await session.save();
    const ok = r.madeAdmin ? "?ok=" + encodeURIComponent("Willkommen. Ihnen wurde die Verwaltungsrolle zugewiesen (ADMIN_EMAILS). Rollen für weitere Personen vergeben Sie unter „Verwaltung“.") : "";
    return NextResponse.redirect(new URL((r.madeAdmin ? "/verwaltung" : pending.returnTo) + ok, req.url));
  } catch (e) {
    session.pendingLogin = undefined;
    await session.save();
    if (e instanceof DomainError) return fail(e.message);
    console.error("OIDC-Callback fehlgeschlagen:", e instanceof Error ? e.message : e);
    return fail("Die Anmeldung konnte nicht abgeschlossen werden.");
  }
}
