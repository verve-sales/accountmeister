import { NextResponse } from "next/server";
import { archiveThread } from "@/modules/assistant/service";
import { errorResponse, readJson, requireApiActor, writeLimited } from "../_common";

/** Aktuelles Gespräch archivieren und ein neues zum selben Kontext beginnen. */
export async function POST(req: Request) {
  const actor = await requireApiActor();
  if (actor instanceof NextResponse) return actor;
  const limited = writeLimited(actor);
  if (limited) return limited;
  try {
    const body = await readJson(req);
    const t = await archiveThread(actor, String(body.threadId ?? ""));
    return NextResponse.json({ thread: { id: t.id } });
  } catch (e) {
    return errorResponse(e);
  }
}
