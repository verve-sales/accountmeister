import { NextResponse } from "next/server";
import { setInterviewMode } from "@/modules/assistant/service";
import { errorResponse, readJson, requireApiActor, writeLimited } from "../_common";

export async function POST(req: Request) {
  const actor = await requireApiActor();
  if (actor instanceof NextResponse) return actor;
  const limited = writeLimited(actor);
  if (limited) return limited;
  try {
    return NextResponse.json(await setInterviewMode(actor, await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
