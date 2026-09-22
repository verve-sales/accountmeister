import { publicUrl } from "@/lib/public-url";
import { NextResponse, type NextRequest } from "next/server";
import { DomainError } from "@/lib/errors";
import { checkRateLimit, LIMITS } from "@/lib/ratelimit";
import { getCurrentActor, getSession } from "@/modules/identity/session";
import { beginMailboxConnect } from "@/modules/integrations/service";

export const dynamic = "force-dynamic";

/** Startet den echten Postfach-Verbindungsaufbau (Briefing 13.1): State/Verifier in der Sitzung, Weiterleitung zu Microsoft. */
export async function GET(req: NextRequest) {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.redirect(publicUrl("/anmelden", req));
  const rl = checkRateLimit(`mailconnect:${actor.userId}`, LIMITS.login.limit, LIMITS.login.windowMs);
  if (!rl.allowed) return NextResponse.redirect(publicUrl(`/einstellungen?fehler=${encodeURIComponent(`Zu viele Versuche. Bitte in ${rl.retryAfterSeconds} Sekunden erneut versuchen.`)}`, req));
  try {
    const { authorizationUrl, pending } = await beginMailboxConnect(actor);
    const session = await getSession();
    session.pendingMailConnect = pending;
    await session.save();
    return NextResponse.redirect(authorizationUrl);
  } catch (e) {
    const msg = e instanceof DomainError ? e.message : "Die Verbindung zu Microsoft konnte nicht gestartet werden.";
    return NextResponse.redirect(publicUrl("/einstellungen?fehler=" + encodeURIComponent(msg), req));
  }
}
