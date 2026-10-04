import { NextResponse } from "next/server";
import { mocoEnabled } from "@/modules/moco/client";
import { handleMocoWebhook } from "@/modules/moco/sync";

/**
 * Moco-Webhook (Etappe 31): HTTPS-POST mit Kopfzeilen X-Moco-Target, X-Moco-Event, X-Moco-Signature (HMAC-SHA256
 * über die rohe Nutzlast mit dem Schlüssel aus der Moco-Webhook-Übersicht). Antwort innerhalb von 10 s, sonst
 * wiederholt Moco; nach 500 Fehlern schaltet Moco den Hook ab.
 */
export async function POST(req: Request) {
  if (!mocoEnabled()) return NextResponse.json({ ok: false, reason: "Moco-Anbindung aus" }, { status: 404 });
  const raw = await req.text();
  const r = await handleMocoWebhook({ target: req.headers.get("x-moco-target"), event: req.headers.get("x-moco-event"), signature: req.headers.get("x-moco-signature") }, raw);
  return NextResponse.json({ ok: r.accepted, reason: r.reason }, { status: r.accepted ? 200 : 401 });
}
