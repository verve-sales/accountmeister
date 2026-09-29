import { and, eq, inArray, or } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { isSalesOpsOnlyUser } from "@/modules/identity/authz";
import { ensureDefaultPlaybooks, startPlaybookRun } from "@/modules/playbooks/service";
import { DAY, renewalTriggerDate } from "./service";

/**
 * Verlängerungsregel (Etappe 23): Für jeden laufenden Einsatz mit bekanntem Ende bzw. bekannter Verlängerungsfrist
 * startet das Tool am Auslösetag (Frist − 14 Tage, sonst Ende − 8 Wochen) einmalig das Vorgehen
 * „Verlängerung vor Einsatzende“ an der Chance. Der erste Schritt kommt als Vorschlag – der BD nimmt ihn an.
 * Berechnet beim Öffnen von Start/Meine Arbeit für die Einsätze, die der Akteur verantwortet.
 */
export async function ensureRenewalRuns(actor: Actor, now = new Date()): Promise<number> {
  const rows = await db
    .select({ o: schema.orders, opp: schema.opportunities, bd: schema.accounts.responsibleBdUserId })
    .from(schema.orders)
    .innerJoin(schema.opportunities, eq(schema.opportunities.id, schema.orders.opportunityId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.opportunities.accountId))
    .where(and(eq(schema.orders.workspaceId, actor.workspaceId), eq(schema.orders.status, "BEAUFTRAGUNG_BESTAETIGT"), eq(schema.orders.engagementStatus, "GESTARTET"), or(eq(schema.opportunities.ownerUserId, actor.userId), eq(schema.accounts.responsibleBdUserId, actor.userId))));
  const t = now.toISOString().slice(0, 10);
  const due = rows.filter((r) => {
    const trig = renewalTriggerDate(r.o);
    const end = r.o.plannedEnd ?? r.o.renewalDeadline;
    return trig !== null && trig <= t && (!end || end >= t);
  });
  if (due.length === 0) return 0;
  const keys = due.map((r) => `renewal:order:${r.o.id}`);
  const done = new Set((await db.query.standardTasks.findMany({ where: and(eq(schema.standardTasks.workspaceId, actor.workspaceId), inArray(schema.standardTasks.key, keys)) })).map((x) => x.key));
  await ensureDefaultPlaybooks(actor.workspaceId);
  const pb = await db.query.playbooks.findFirst({ where: and(eq(schema.playbooks.workspaceId, actor.workspaceId), eq(schema.playbooks.code, "VERLAENGERUNG"), eq(schema.playbooks.active, true)) });
  if (!pb) return 0;
  let started = 0;
  for (const r of due) {
    const key = `renewal:order:${r.o.id}`;
    if (done.has(key)) continue;
    const [log] = await db.insert(schema.standardTasks).values({ workspaceId: actor.workspaceId, key, kind: "RENEWAL", accountId: r.opp.accountId, ownerUserId: actor.userId }).onConflictDoNothing().returning();
    if (!log) continue;
    const owner = (await isSalesOpsOnlyUser(r.opp.ownerUserId)) ? (r.bd ?? actor.userId) : r.opp.ownerUserId;
    try {
      await startPlaybookRun(actor, { playbookId: pb.id, setupId: r.opp.setupId, opportunityId: r.opp.id, ownerUserId: owner }, { proposalOnly: true });
      started++;
      await recordAudit(db, actor, "renewal.auto_started", "ORDER", r.o.id, { ende: r.o.plannedEnd, frist: r.o.renewalDeadline });
    } catch {
      // läuft bereits oder Chance beendet – der Anlass ist trotzdem erledigt
    }
  }
  return started;
}

export async function ensureRenewalRunsSafe(actor: Actor): Promise<number> {
  try {
    return await ensureRenewalRuns(actor);
  } catch (e) {
    console.error("Verlängerungsregel konnte nicht geprüft werden", e);
    return 0;
  }
}

export type RenewalRow = { accountId: string; accountName: string; orderId: string; opportunityId: string; title: string; plannedEnd: string | null; renewalDeadline: string | null; daysToEnd: number | null; runStatus: "OHNE_VORGEHEN" | "LAEUFT" | "ABGESCHLOSSEN"; currentStep: string | null; escalate: boolean };

/** Auslaufende Einsätze (≤ 12 Wochen) für die Kunden einer Sicht – mit Stand der Verlängerung und Eskalation (≤ 4 Wochen ohne Fortschritt). */
export async function listRenewals(accountIds: string[], now = new Date()): Promise<RenewalRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await db
    .select({ o: schema.orders, opp: schema.opportunities, accountName: schema.accounts.name })
    .from(schema.orders)
    .innerJoin(schema.opportunities, eq(schema.opportunities.id, schema.orders.opportunityId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.opportunities.accountId))
    .where(and(inArray(schema.opportunities.accountId, accountIds), eq(schema.orders.status, "BEAUFTRAGUNG_BESTAETIGT"), eq(schema.orders.engagementStatus, "GESTARTET")));
  const t = now.getTime();
  const soon = rows.filter((r) => r.o.plannedEnd && new Date(r.o.plannedEnd).getTime() - t <= 84 * DAY && new Date(r.o.plannedEnd).getTime() >= t - DAY);
  if (soon.length === 0) return [];
  const runs = await db.query.playbookRuns.findMany({ where: inArray(schema.playbookRuns.opportunityId, soon.map((r) => r.opp.id)) });
  const runSteps = runs.length ? await db.query.playbookRunSteps.findMany({ where: inArray(schema.playbookRunSteps.runId, runs.map((r) => r.id)) }) : [];
  return soon
    .map((r) => {
      const run = runs.filter((x) => x.opportunityId === r.opp.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const steps = run ? runSteps.filter((s) => s.runId === run.id) : [];
      const cur = steps.find((s) => s.status === "OFFEN");
      const progressed = steps.some((s) => s.status === "ERLEDIGT");
      const daysToEnd = Math.round((new Date(r.o.plannedEnd!).getTime() - t) / DAY);
      return {
        accountId: r.opp.accountId,
        accountName: r.accountName,
        orderId: r.o.id,
        opportunityId: r.opp.id,
        title: r.opp.title,
        plannedEnd: r.o.plannedEnd,
        renewalDeadline: r.o.renewalDeadline,
        daysToEnd,
        runStatus: !run ? ("OHNE_VORGEHEN" as const) : run.status === "AKTIV" ? ("LAEUFT" as const) : ("ABGESCHLOSSEN" as const),
        currentStep: cur ? cur.title : null,
        escalate: daysToEnd <= 28 && (!run || (run.status === "AKTIV" && !progressed)),
      };
    })
    .sort((a, b) => (a.daysToEnd ?? 999) - (b.daysToEnd ?? 999));
}
