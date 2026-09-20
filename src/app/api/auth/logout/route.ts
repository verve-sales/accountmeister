import { publicUrl } from "@/lib/public-url";
import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { getSession } from "@/modules/identity/session";
import { buildLogoutUrl, discover } from "@/modules/identity/oidc";

export const dynamic = "force-dynamic";

/** Abmelden: lokale Sitzung löschen und – falls möglich – auch beim Identitätsanbieter abmelden. */
export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const session = await getSession();
  const wasOidc = session.mode === "oidc";
  session.destroy();
  const back = publicUrl("/anmelden", req).toString();
  if (cfg.AUTH_MODE === "oidc" && wasOidc && cfg.OIDC_ISSUER) {
    try {
      const doc = await discover(cfg.OIDC_ISSUER);
      const url = buildLogoutUrl(doc, back);
      if (url) return NextResponse.redirect(url);
    } catch {
      // Lokale Abmeldung genügt, wenn der Anbieter nicht erreichbar ist
    }
  }
  return NextResponse.redirect(back);
}
