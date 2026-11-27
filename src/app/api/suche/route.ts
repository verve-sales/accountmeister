import { NextResponse } from "next/server";
import { errorResponse, requireApiActor } from "../assistent/_common";
import { searchAll } from "@/modules/search/service";

/** e65: Sofortergebnisse für die Suche in der Kopfzeile – dieselbe rechtegeprüfte Suche wie die Suchseite, nur lesend. */
export async function GET(req: Request) {
  const auth = await requireApiActor();
  if (auth instanceof NextResponse) return auth;
  try {
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 100);
    if (q.length < 2) return NextResponse.json({ q, groups: [] });
    return NextResponse.json(await searchAll(auth, q, 5));
  } catch (e) {
    return errorResponse(e);
  }
}
