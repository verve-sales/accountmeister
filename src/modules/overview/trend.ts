import { and, asc, desc, eq, lt, lte } from "drizzle-orm";
import { db, schema } from "@/db/client";

/**
 * e75: Trends an den GF-Kennzahlen. Je Tag ein Stand (der letzte Aufruf des Tages gilt; zusätzlich schreibt der
 * Hintergrunddienst täglich einen). Verglichen wird mit dem Stand vor sieben Tagen; gibt es den noch nicht, mit dem
 * ältesten vorhandenen (mindestens von gestern). Ohne Vergleichsstand zeigen die Kacheln keinen Trend.
 */
const KEYS = ["persons", "heads", "endingUndecided", "pipelinePerDay", "pipelineCount", "red", "yellow", "teamOverdue", "revenueMonth", "expiringMonth"] as const;

async function merge(workspaceId: string, day: string, add: Record<string, number | null>): Promise<void> {
  const row = await db.query.kpiSnapshots.findFirst({ where: and(eq(schema.kpiSnapshots.workspaceId, workspaceId), eq(schema.kpiSnapshots.day, day)) });
  const values = { ...(row?.values ?? {}), ...add };
  await db.insert(schema.kpiSnapshots).values({ workspaceId, day, values }).onConflictDoUpdate({ target: [schema.kpiSnapshots.workspaceId, schema.kpiSnapshots.day], set: { values } });
}

export async function recordSnapshot(workspaceId: string, day: string, kpis: Record<string, number | null>): Promise<void> {
  await merge(workspaceId, day, Object.fromEntries(KEYS.map((k) => [k, kpis[k] ?? null])));
}

/** e79: Stand der persönlichen Kennzahlen (BD, Principal) – im selben Tagesstand unter „u:<Person>:<Sicht>:<Kennzahl>“. */
export async function recordPersonal(workspaceId: string, day: string, userId: string, view: string, kpis: Record<string, number>): Promise<void> {
  await merge(workspaceId, day, Object.fromEntries(Object.entries(kpis).map(([k, v]) => [`u:${userId}:${view}:${k}`, v])));
}

export async function personalBaseline(workspaceId: string, today: string, userId: string, view: string): Promise<{ day: string; values: Record<string, number | null> } | null> {
  const b = await baseline(workspaceId, today);
  if (!b) return null;
  const pre = `u:${userId}:${view}:`;
  const values = Object.fromEntries(Object.entries(b.values).filter(([k]) => k.startsWith(pre)).map(([k, v]) => [k.slice(pre.length), v]));
  return Object.keys(values).length ? { day: b.day, values } : null;
}

/** Köpfe je Woche: 12 Wochen zurück, 12 Wochen voraus – aus Start und Ende der Einsätze. */
export function headsTrendOf(rows: { id: string; freelancerId: string | null; internalUserId: string | null; plannedStart: string | null; actualStart: string | null; plannedEnd: string | null; actualEnd: string | null }[], today: string) {
  const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  return Array.from({ length: 25 }, (_, k) => {
    const date = plusDays(today, (k - 12) * 7);
    const active = rows.filter((e) => { const st = e.actualStart ?? e.plannedStart; const en = e.actualEnd ?? e.plannedEnd; return !!st && st <= date && (!en || en >= date); });
    return { date, value: new Set(active.map((e) => e.freelancerId ?? e.internalUserId ?? e.id)).size, future: k > 12 };
  });
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
