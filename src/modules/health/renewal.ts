import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { isSalesOpsOnlyUser } from "@/modules/identity/authz";
import { ensureDefaultPlaybooks, startPlaybookRun } from "@/modules/playbooks/service";
import { DAY, renewalPingDate, renewalTriggerDate } from "./service";

/**
 * Verlängerungsregel (Etappe 23): Für jeden laufenden Einsatz mit bekanntem Ende bzw. bekannter Verlängerungsfrist
 * startet das Tool am Auslösetag (Frist − 14 Tage, sonst Ende − 8 Wochen) einmalig das Vorgehen
 * „Verlängerung vor Einsatzende“ an der Chance. Der erste Schritt kommt als Vorschlag – der BD nimmt ihn an.
 * Berechnet beim Öffnen von Start/Meine Arbeit für die Einsätze, die der Akteur verantwortet.
 */
export async function ensureRenewalRuns(actor: Actor, now = new Date()): Promise<number> {
  const { ensureOrdersEnded } = await import("./service");
  await ensureOrdersEnded(actor.workspaceId).catch(() => 0);
  let rows = await db
    .select({ o: schema.orders, opp: schema.opportunities, bd: schema.accounts.responsibleBdUserId })
    .from(schema.orders)
    .innerJoin(schema.opportunities, eq(schema.opportunities.id, schema.orders.opportunityId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.opportunities.accountId))
    .where(and(eq(schema.orders.workspaceId, actor.workspaceId), eq(schema.orders.status, "BEAUFTRAGUNG_BESTAETIGT"), eq(schema.orders.engagementStatus, "GESTARTET"), or(eq(schema.opportunities.ownerUserId, actor.userId), eq(schema.accounts.responsibleBdUserId, actor.userId))));
  const t = now.toISOString().slice(0, 10);
  // Etappe 33: Die Einsatzakte führt die Verlängerung. Läuft dort schon eine Entscheidung (angestoßen, bestätigt, abgelehnt),
  // erzeugt die Auftragsschicht weder Ping noch Vorgehen; dasselbe gilt je Chance nur einmal (Dubletten aus Mehrfach-Import).
  const handled = new Set(
    (await db
      .select({ orderId: schema.engagements.orderId })
      .from(schema.renewalDecisions)
      .innerJoin(schema.engagements, eq(schema.engagements.id, schema.renewalDecisions.engagementId))
      .where(and(eq(schema.renewalDecisions.workspaceId, actor.workspaceId), inArray(schema.renewalDecisions.status, ["IN_ABSTIMMUNG", "ANGEBOTEN", "BESTAETIGT", "ABGELEHNT"])))).map((x) => x.orderId).filter((x): x is string => !!x),
  );
  const seenOpp = new Set<string>();
  rows = rows.filter((r) => {
    if (handled.has(r.o.id)) return false;
    if (seenOpp.has(r.opp.id)) return false;
    seenOpp.add(r.opp.id);
    return true;
  });
  // Fahrplan Schritt 1 (Feedback Pilot): ab 3 Monaten Restlaufzeit ein Ping an den BD – „Verlängerung ansprechen“
  const pingDue = rows.filter((r) => {
    const ping = renewalPingDate(r.o);
    const end = r.o.plannedEnd ?? r.o.renewalDeadline;
    return ping !== null && ping <= t && (!end || end >= t);
  });
  if (pingDue.length) {
    const pingKeys = pingDue.map((r) => `renewal-ping:order:${r.o.id}`);
    const have = new Set((await db.query.standardTasks.findMany({ where: and(eq(schema.standardTasks.workspaceId, actor.workspaceId), inArray(schema.standardTasks.key, pingKeys)) })).map((x) => x.key));
    for (const r of pingDue) {
      const key = `renewal-ping:order:${r.o.id}`;
      if (have.has(key)) continue;
      const owner = (await isSalesOpsOnlyUser(r.opp.ownerUserId)) ? (r.bd ?? actor.userId) : r.opp.ownerUserId;
      await db.transaction(async (tx) => {
        const [log] = await tx.insert(schema.standardTasks).values({ workspaceId: actor.workspaceId, key, kind: "RENEWAL_PING", accountId: r.opp.accountId, ownerUserId: owner }).onConflictDoNothing().returning();
        if (!log) return;
        const end = r.o.plannedEnd ?? r.o.renewalDeadline;
        const [a] = await tx
          .insert(schema.actions)
          .values({ workspaceId: actor.workspaceId, setupId: r.opp.setupId, opportunityId: r.opp.id, title: `Verlängerung ansprechen: „${r.opp.title.slice(0, 80)}“ endet am ${end}`, agreement: "Fahrplan Verlängerung, Schritt 1 (3 Monate vor Ende): Beim nächsten Kontakt mit dem Kunden die Verlängerung ansprechen – Zufriedenheit, Anschlussbedarf, Bestellweg und Fristen. Acht Wochen vor Ende startet das Vorgehen „Verlängerung vor Einsatzende“.", ownerUserId: owner, status: "VORGESCHLAGEN", dueDate: new Date(now.getTime() + 7 * DAY).toISOString().slice(0, 10), createdBy: actor.userId })
          .returning();
        await tx.update(schema.standardTasks).set({ actionId: a!.id }).where(eq(schema.standardTasks.id, log.id));
        await recordAudit(tx, actor, "renewal.ping", "ORDER", r.o.id, { ende: end });
      });
    }
  }
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

export type RenewalRow = { accountId: string; accountName: string; orderId: string; opportunityId: string; engagementId: string | null; person: string | null; title: string; plannedEnd: string | null; renewalDeadline: string | null; daysToEnd: number | null; runStatus: "OHNE_VORGEHEN" | "LAEUFT" | "ABGESCHLOSSEN"; currentStep: string | null; /** Stand aus der Einsatzakte (führend), sonst null */ decisionStatus: string | null; decisionTo: string | null; escalate: boolean };

/** Auslaufende Einsätze (≤ 3 Monate) für die Kunden einer Sicht – mit Stand der Verlängerung und Eskalation (≤ 4 Wochen ohne Fortschritt). */
export async function listRenewals(accountIds: string[], now = new Date()): Promise<RenewalRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await db
    .select({ o: schema.orders, opp: schema.opportunities, accountName: schema.accounts.name })
    .from(schema.orders)
    .innerJoin(schema.opportunities, eq(schema.opportunities.id, schema.orders.opportunityId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.opportunities.accountId))
    .where(and(inArray(schema.opportunities.accountId, accountIds), eq(schema.orders.status, "BEAUFTRAGUNG_BESTAETIGT"), eq(schema.orders.engagementStatus, "GESTARTET")));
  const t = now.getTime();
  const soon = rows.filter((r) => r.o.plannedEnd && new Date(r.o.plannedEnd).getTime() - t <= 92 * DAY && new Date(r.o.plannedEnd).getTime() >= t - DAY);
  if (soon.length === 0) return [];
  const runs = await db.query.playbookRuns.findMany({ where: inArray(schema.playbookRuns.opportunityId, soon.map((r) => r.opp.id)) });
  const runSteps = runs.length ? await db.query.playbookRunSteps.findMany({ where: inArray(schema.playbookRunSteps.runId, runs.map((r) => r.id)) }) : [];
  const engs = await db.query.engagements.findMany({ where: inArray(schema.engagements.orderId, soon.map((r) => r.o.id)) });
  const decisions = engs.length ? await db.query.renewalDecisions.findMany({ where: inArray(schema.renewalDecisions.engagementId, engs.map((e) => e.id)), orderBy: desc(schema.renewalDecisions.createdAt) }) : [];
  const fls = await db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(engs.map((e) => e.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } });
  const us = await db.query.users.findMany({ where: inArray(schema.users.id, [...new Set(engs.map((e) => e.internalUserId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } });
  const fn = new Map(fls.map((f) => [f.id, f.displayName]));
  const un = new Map(us.map((u) => [u.id, u.displayName]));
  const seen = new Set<string>();
  return soon
    .filter((r) => {
      // Dubletten (mehrere Aufträge derselben Chance mit gleichem Ende) nur einmal zeigen
      const k = `${r.opp.id}:${r.o.plannedEnd}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => {
      const eng = engs.find((e) => e.orderId === r.o.id) ?? null;
      const dec = eng ? decisions.find((x) => x.engagementId === eng.id) ?? null : null;
      const person = eng ? (eng.freelancerId ? fn.get(eng.freelancerId) ?? null : eng.internalUserId ? un.get(eng.internalUserId) ?? null : null) : null;
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
        engagementId: eng?.id ?? null,
        person,
        title: eng?.title ?? r.opp.title,
        plannedEnd: eng?.plannedEnd ?? r.o.plannedEnd,
        renewalDeadline: r.o.renewalDeadline,
        daysToEnd,
        runStatus: !run ? ("OHNE_VORGEHEN" as const) : run.status === "AKTIV" ? ("LAEUFT" as const) : ("ABGESCHLOSSEN" as const),
        currentStep: cur ? cur.title : null,
        decisionStatus: dec?.status ?? null,
        decisionTo: dec?.proposedTo ?? null,
        escalate: daysToEnd <= 28 && !(dec && dec.status !== "ZU_KLAEREN") && (!run || (run.status === "AKTIV" && !progressed)),
      };
    })
    .sort((a, b) => (a.daysToEnd ?? 999) - (b.daysToEnd ?? 999));
}
