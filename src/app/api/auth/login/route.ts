import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { checkRateLimit, LIMITS } from "@/lib/ratelimit";
import { getSession } from "@/modules/identity/session";
import { buildAuthorizationUrl, createPendingLogin, discover } from "@/modules/identity/oidc";

export const dynamic = "force-dynamic";

/** Startet die Unternehmensanmeldung: State/Nonce/PKCE in der Sitzung, Weiterleitung zum Identitätsanbieter. */
export async function GET(req: NextRequest) {
  const cfg = getConfig();
  if (cfg.AUTH_MODE !== "oidc") return NextResponse.redirect(new URL("/anmelden", req.url));
  const ip = (req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "lokal").split(",")[0]!.trim();
  const rl = checkRateLimit(`login:${ip}`, LIMITS.login.limit, LIMITS.login.windowMs);
  if (!rl.allowed) return NextResponse.redirect(new URL(`/anmelden?fehler=${encodeURIComponent(`Zu viele Anmeldeversuche. Bitte in ${rl.retryAfterSeconds} Sekunden erneut versuchen.`)}`, req.url));
  try {
    const doc = await discover(cfg.OIDC_ISSUER!);
    const pending = createPendingLogin(req.nextUrl.searchParams.get("weiter") ?? "/meine-arbeit");
    const session = await getSession();
    session.pendingLogin = pending;
    await session.save();
    return NextResponse.redirect(buildAuthorizationUrl(doc, pending, cfg));
  } catch (e) {
    console.error("OIDC-Start fehlgeschlagen:", e instanceof Error ? e.message : e);
    return NextResponse.redirect(new URL("/anmelden?fehler=" + encodeURIComponent("Der Identitätsanbieter ist gerade nicht erreichbar. Bitte später erneut versuchen."), req.url));
  }
}
