import { and, asc, desc, eq, lt, lte } from "drizzle-orm";
import { db, schema } from "@/db/client";

/**
 * e75: Trends an den GF-Kennzahlen. Je Tag ein Stand (der letzte Aufruf des Tages gilt; zusätzlich schreibt der
 * Hintergrunddienst täglich einen). Verglichen wird mit dem Stand vor sieben Tagen; gibt es den noch nicht, mit dem
 * ältesten vorhandenen (mindestens von gestern). Ohne Vergleichsstand zeigen die Kacheln keinen Trend.
 */
const KEYS = ["persons", "heads", "endingUndecided", "pipelinePerDay", "pipelineCount", "red", "yellow", "teamOverdue", "revenueMonth", "expiringMonth"] as const;

export async function recordSnapshot(workspaceId: string, day: string, kpis: Record<string, number | null>): Promise<void> {
  const values = Object.fromEntries(KEYS.map((k) => [k, kpis[k] ?? null]));
  await db.insert(schema.kpiSnapshots).values({ workspaceId, day, values }).onConflictDoUpdate({ target: [schema.kpiSnapshots.workspaceId, schema.kpiSnapshots.day], set: { values } });
}

export async function baseline(workspaceId: string, today: string): Promise<{ day: string; values: Record<string, number | null> } | null> {
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  const near = await db.query.kpiSnapshots.findFirst({ where: and(eq(schema.kpiSnapshots.workspaceId, workspaceId), lte(schema.kpiSnapshots.day, weekAgo)), orderBy: [desc(schema.kpiSnapshots.day)] });
  const row = near ?? (await db.query.kpiSnapshots.findFirst({ where: and(eq(schema.kpiSnapshots.workspaceId, workspaceId), lt(schema.kpiSnapshots.day, today)), orderBy: [asc(schema.kpiSnapshots.day)] }));
  return row ? { day: row.day, values: row.values } : null;
}

/** Hintergrunddienst: täglicher Stand, auch wenn niemand die Startseite öffnet. */
export async function snapshotAll(): Promise<number> {
  const { buildGfOverview } = await import("./gf");
  const { loadActor } = await import("@/modules/identity/actor");
  let n = 0;
  for (const ws of await db.query.workspaces.findMany({ columns: { id: true } })) {
    const ceo = await db.query.roleAssignments.findFirst({ where: and(eq(schema.roleAssignments.workspaceId, ws.id), eq(schema.roleAssignments.role, "CEO")) });
    const actor = ceo ? await loadActor(ceo.userId) : null;
    if (!actor || !actor.roles.has("CEO")) continue;
    await buildGfOverview(actor);
    n++;
  }
  return n;
}
