import { NextResponse } from "next/server";
import { errorResponse, readJson, requireApiActor, writeLimited } from "../assistent/_common";
import { suggestFormFields } from "@/modules/strategy/formsuggest";

/** „Vorschlagen lassen“: belegt Formularfelder aus dem Kundenkontext vor. Speichert nichts. */
export async function POST(req: Request) {
  const auth = await requireApiActor();
  if (auth instanceof NextResponse) return auth;
  const limited = writeLimited(auth);
  if (limited) return limited;
  try {
    const body = await readJson(req);
    const result = await suggestFormFields(auth, body);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
