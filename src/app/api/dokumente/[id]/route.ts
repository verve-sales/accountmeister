import { publicUrl } from "@/lib/public-url";
import { NextResponse } from "next/server";
import { DomainError } from "@/lib/errors";
import { getCurrentActor } from "@/modules/identity/session";
import { getDocumentFile } from "@/modules/documents/service";

/** Originaldatei eines Dokuments – nur mit Leserecht auf die Quelle; jeder Abruf wird protokolliert. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentActor();
  if (!actor) return NextResponse.redirect(publicUrl("/anmelden", _req));
  const { id } = await ctx.params;
  try {
    const { doc, data } = await getDocumentFile(actor, id);
    const safeName = doc.fileName.replace(/[^\w.\- äöüÄÖÜß]/g, "_");
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "content-type": doc.mimeType,
        "content-length": String(data.length),
        "content-disposition": `attachment; filename="${safeName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    const status = e instanceof DomainError ? e.httpStatus : 500;
    return NextResponse.json({ error: e instanceof DomainError ? e.message : "Fehler" }, { status });
  }
}
