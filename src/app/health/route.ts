import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cfg = getConfig();
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok", database: "erreichbar", authMode: cfg.AUTH_MODE, aiProvider: cfg.AI_PROVIDER });
  } catch (e) {
    return Response.json({ status: "fehler", detail: e instanceof Error ? e.message : "unbekannt" }, { status: 503 });
  }
}
