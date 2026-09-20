import { NextResponse } from "next/server";
import { decideCard } from "@/modules/assistant/service";
import { errorResponse, readJson, requireApiActor, writeLimited } from "../_common";

/** Karte übernehmen oder verwerfen. */
export async function POST(req: Request) {
  const actor = await requireApiActor();
  if (actor instanceof NextResponse) return actor;
  const limited = writeLimited(actor);
  if (limited) return limited;
  try {
    const r = await decideCard(actor, await readJson(req));
    return NextResponse.json({ card: r.card, thread: { id: r.thread.id, contextType: r.thread.contextType, contextId: r.thread.contextId, title: r.thread.title } });
  } catch (e) {
    return errorResponse(e);
  }
}
