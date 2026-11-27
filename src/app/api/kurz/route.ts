import { NextResponse } from "next/server";
import { errorResponse, requireApiActor } from "../assistent/_common";
import { peek } from "@/modules/peek/service";

/** e78: Kurzansicht für das Seitenblatt – nur lesend, dieselben Rechte wie die vollen Seiten. */
export async function GET(req: Request) {
  const auth = await requireApiActor();
  if (auth instanceof NextResponse) return auth;
  try {
    const u = new URL(req.url).searchParams;
    return NextResponse.json(await peek(auth, u.get("typ") ?? "", u.get("id") ?? ""));
  } catch (e) {
    return errorResponse(e);
  }
}
