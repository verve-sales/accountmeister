import { publicUrl } from "@/lib/public-url";
import { NextResponse, type NextRequest } from "next/server";
import { DomainError } from "@/lib/errors";
import { getCurrentActor, getSession } from "@/modules/identity/session";
import { completeMailboxConnect } from "@/modules/integrations/service";

export const dynamic = "force-dynamic";

/** Rückkehr von Microsoft: State prüfen, Code tauschen, Verbindung verschlüsselt speichern. */
export async function GET(req: NextRequest) {
  const fail = (msg: string) => NextResponse.redirect(publicUrl("/einstellungen?fehler=" + encodeURIComponent(msg), req));
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.redirect(publicUrl("/anmelden", req));
  const session = await getSession();
  const pending = session.pendingMailConnect;
  const params = req.nextUrl.searchParams;
  if (params.get("error")) {
    session.pendingMailConnect = undefined;
    await session.save();
    return fail("Verbindung abgebrochen: " + (params.get("error_description") ?? params.get("error") ?? "").slice(0, 200));
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!pending || !code || !state || state !== pending.state || Date.now() - pending.startedAt > 10 * 60 * 1000) {
    session.pendingMailConnect = undefined;
    await session.save();
    return fail("Der Verbindungsaufbau ist abgelaufen oder ungültig. Bitte erneut starten.");
  }
  session.pendingMailConnect = undefined;
  await session.save();
  try {
    await completeMailboxConnect(actor, code, pending.verifier);
    return NextResponse.redirect(publicUrl("/einstellungen?ok=" + encodeURIComponent("Postfach verbunden."), req));
  } catch (e) {
    if (e instanceof DomainError) return fail(e.message);
    console.error("Postfach-Verbindungsaufbau fehlgeschlagen:", e instanceof Error ? e.message : e);
    return fail("Der Verbindungsaufbau konnte nicht abgeschlossen werden.");
  }
}
