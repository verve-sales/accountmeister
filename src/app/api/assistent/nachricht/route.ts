import { NextResponse } from "next/server";
import { ASSISTANT_CARDS_MARKER } from "@/modules/ai/schemas";
import { sendMessage } from "@/modules/assistant/service";
import { DomainError } from "@/lib/errors";
import { errorResponse, readJson, requireApiActor, writeLimited } from "../_common";

export const maxDuration = 180;

/**
 * Nachricht senden. Antwort ist ein Textstrom: erst die Prosa des Assistenten (gestreamt), dann eine Zeile mit dem
 * Marker und ein JSON-Objekt {message, cards, missing}. Der Client trennt am Marker.
 */
export async function POST(req: Request) {
  const actor = await requireApiActor();
  if (actor instanceof NextResponse) return actor;
  const limited = writeLimited(actor);
  if (limited) return limited;
  const body = await readJson(req);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      try {
        const r = await sendMessage(actor, body, { onDelta: send });
        send(`\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ message: { id: r.message.id, text: r.message.text }, cards: r.cards, missing: r.missing })}`);
      } catch (e) {
        const msg = e instanceof DomainError ? e.message : "Unerwarteter Fehler.";
        if (!(e instanceof DomainError)) console.error(e);
        send(`\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ error: msg })}`);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store", "x-accel-buffering": "no" } });
}

export async function GET() {
  return errorResponse(new DomainError("METHOD", "Nur POST.", 405));
}
