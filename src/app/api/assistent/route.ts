import { NextResponse } from "next/server";
import { getThreadView } from "@/modules/assistant/service";
import { errorResponse, requireApiActor } from "./_common";

/** Gesprächsfaden zum Kontext laden (legt ihn bei Bedarf an) inkl. offener Punkte und fehlender Informationen. */
export async function GET(req: Request) {
  const actor = await requireApiActor();
  if (actor instanceof NextResponse) return actor;
  const url = new URL(req.url);
  try {
    const view = await getThreadView(actor, { type: url.searchParams.get("type") ?? "GLOBAL", id: url.searchParams.get("id") ?? "" });
    return NextResponse.json(view, { headers: { "cache-control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
