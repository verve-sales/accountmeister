import { and, desc, eq, gte, inArray, lte, ne, notInArray, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { getFocus } from "./service";

/**
 * Standardaufgaben zum Fokus „Freelancer-Hebel“ (Etappe 21). Sie entstehen als VORGESCHLAGENE Aktionen für die
 * zuständige Person – annehmen oder verwerfen wie jeden anderen Vorschlag. Jeder Anlass erzeugt höchstens eine
 * Aufgabe (Schlüssel in standard_tasks). Berechnet beim Öffnen von Start/Meine Arbeit – kein Hintergrunddienst.
 *
 *  - FL_CHECK_CHANCE: neue oder bestätigte Chance → „Braucht das Team weitere Rollen?“
 *  - FL_AUSWEITUNG:   zwei Wochen nach Einsatzstart → „Weitere Profile anbieten“
 *  - FL_POTENZIAL:    Kunde seit 90 Tagen ohne Freelancer-Chance → „Freelancer-Potenzial prüfen“ (je Quartal)
 */

export type StandardTaskKind = "FL_CHECK_CHANCE" | "FL_AUSWEITUNG" | "FL_POTENZIAL";
export const standardTaskKindLabel: Record<StandardTaskKind, string> = {
  FL_CHECK_CHANCE: "Freelancer-Check zur Chance",
  FL_AUSWEITUNG: "Ausweitung nach Einsatzstart",
  FL_POTENZIAL: "Freelancer-Potenzial beim Kunden",
};

const MAX_NEW_PER_RUN = 5;
const DAY = 86400000;

function quarterKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
function isoIn(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
}

type Candidate = { key: string; kind: StandardTaskKind; accountId: string; setupId: string; opportunityId: string | null; title: string; agreement: string; dueInDays: number };

/** Erzeugt fällige Standardaufgaben für den Akteur selbst (er ist BD bzw. verantwortlich). Gibt die Anzahl neuer zurück. */
export async function ensureStandardTasks(actor: Actor, now = new Date()): Promise<number> {
  const focus = await getFocus(actor.workspaceId);
  if (!focus.freelancerLever) return 0;
  const candidates: Candidate[] = [];

  // 1) Chancen, für die der Akteur verantwortlich ist (neu/bestätigt, in den letzten 60 Tagen bewegt)
  const opps = await db.query.opportunities.findMany({
    where: and(
      eq(schema.opportunities.workspaceId, actor.workspaceId),
      eq(schema.opportunities.ownerUserId, actor.userId),
      inArray(schema.opportunities.status, ["ANTIZIPIERT", "IN_KLAERUNG", "BESTAETIGT"]),
      gte(schema.opportunities.updatedAt, new Date(now.getTime() - 60 * DAY)),
    ),
    orderBy: desc(schema.opportunities.updatedAt),
    limit: 20,
  });
  for (const o of opps) {
    candidates.push({
      key: `fl-check:opp:${o.id}`,
      kind: "FL_CHECK_CHANCE",
      accountId: o.accountId,
      setupId: o.setupId,
      opportunityId: o.id,
      title: `Freelancer-Check: Braucht das Team zu „${o.title.slice(0, 80)}“ weitere Rollen?`,
      agreement: "Standardaufgabe (Fokus Freelancer): Im nächsten Gespräch fragen, welche weiteren Rollen oder Profile im Team fehlen (z. B. Test, Architektur, Analyse, Projektleitung). Gefundene Bedarfe als Chance der Art „Freelancer-Experte“ erfassen.",
      dueInDays: 7,
    });
  }

  // 2) Einsätze, die seit mindestens 14 Tagen laufen (Chance des Akteurs)
  const started = await db
    .select({ orderId: schema.orders.id, oppId: schema.opportunities.id, title: schema.opportunities.title, accountId: schema.opportunities.accountId, setupId: schema.opportunities.setupId })
    .from(schema.orders)
    .innerJoin(schema.opportunities, eq(schema.opportunities.id, schema.orders.opportunityId))
    .where(and(eq(schema.orders.workspaceId, actor.workspaceId), eq(schema.opportunities.ownerUserId, actor.userId), eq(schema.orders.engagementStatus, "GESTARTET"), lte(schema.orders.startedAt, new Date(now.getTime() - 14 * DAY))))
    .limit(20);
  for (const o of started) {
    candidates.push({
      key: `fl-ausweitung:order:${o.orderId}`,
      kind: "FL_AUSWEITUNG",
      accountId: o.accountId,
      setupId: o.setupId,
      opportunityId: o.oppId,
      title: `Ausweitung: weitere Profile anbieten („${o.title.slice(0, 80)}“ läuft)`,
      agreement: "Standardaufgabe (Fokus Freelancer): Der Einsatz läuft seit zwei Wochen. Kurz Zufriedenheit abfragen und fragen, welche weiteren Rollen im Team fehlen – Verve kann alle Spezialistenprofile stellen.",
      dueInDays: 7,
    });
  }

  // 3) Kunden des Akteurs ohne Freelancer-Chance seit 90 Tagen (je Quartal höchstens einmal)
  const accounts = await db.query.accounts.findMany({ where: and(eq(schema.accounts.workspaceId, actor.workspaceId), eq(schema.accounts.responsibleBdUserId, actor.userId), eq(schema.accounts.status, "ACTIVE")) });
  if (accounts.length) {
    const ids = accounts.map((a) => a.id);
    const recentFl = await db
      .select({ accountId: schema.opportunities.accountId })
      .from(schema.opportunities)
      .where(and(inArray(schema.opportunities.accountId, ids), eq(schema.opportunities.kind, "FREELANCER_EXPERTE"), gte(schema.opportunities.createdAt, new Date(now.getTime() - 90 * DAY))));
    const withFl = new Set(recentFl.map((r) => r.accountId));
    const setups = await db.query.projectSetups.findMany({ where: and(inArray(schema.projectSetups.accountId, ids), ne(schema.projectSetups.status, "ARCHIVIERT")), orderBy: desc(schema.projectSetups.updatedAt) });
    for (const a of accounts) {
      if (withFl.has(a.id)) continue;
      if (now.getTime() - a.createdAt.getTime() < 90 * DAY) continue; // neuer Kunde: erst einmal ankommen lassen
      const setup = setups.find((s) => s.accountId === a.id);
      if (!setup) continue;
      candidates.push({
        key: `fl-potenzial:${a.id}:${quarterKey(now)}`,
        kind: "FL_POTENZIAL",
        accountId: a.id,
        setupId: setup.id,
        opportunityId: null,
        title: `Freelancer-Potenzial bei ${a.name} prüfen`,
        agreement: "Standardaufgabe (Fokus Freelancer): Bei diesem Kunden gibt es seit 90 Tagen keine Freelancer-Chance. Prüfen: Welche Teams haben Engpässe oder zusätzliche Vorhaben? Sind wir gelistet? Wer könnte weitere Profile brauchen?",
        dueInDays: 14,
      });
    }
  }

  if (candidates.length === 0) return 0;
  const existing = await db.query.standardTasks.findMany({ where: and(eq(schema.standardTasks.workspaceId, actor.workspaceId), inArray(schema.standardTasks.key, candidates.map((c) => c.key))) });
  const have = new Set(existing.map((e) => e.key));
  const fresh = candidates.filter((c) => !have.has(c.key)).slice(0, MAX_NEW_PER_RUN);
  let created = 0;
  for (const c of fresh) {
    await db.transaction(async (tx) => {
      // Schlüssel zuerst sichern – bei parallelem Seitenaufruf entsteht so keine Doppelung
      const [log] = await tx.insert(schema.standardTasks).values({ workspaceId: actor.workspaceId, key: c.key, kind: c.kind, accountId: c.accountId, ownerUserId: actor.userId }).onConflictDoNothing().returning();
      if (!log) return;
      const [a] = await tx
        .insert(schema.actions)
        .values({ workspaceId: actor.workspaceId, setupId: c.setupId, opportunityId: c.opportunityId, title: c.title, agreement: c.agreement, ownerUserId: actor.userId, status: "VORGESCHLAGEN", dueDate: isoIn(c.dueInDays), createdBy: actor.userId })
        .returning();
      await tx.update(schema.standardTasks).set({ actionId: a!.id }).where(eq(schema.standardTasks.id, log.id));
      await recordAudit(tx, actor, "standard_task.created", "ACTION", a!.id, { kind: c.kind, key: c.key });
      created++;
    });
  }
  return created;
}

/** Wie ensureStandardTasks, aber ohne die Seite je scheitern zu lassen. */
export async function ensureStandardTasksSafe(actor: Actor): Promise<number> {
  try {
    return await ensureStandardTasks(actor);
  } catch (e) {
    console.error("Standardaufgaben konnten nicht berechnet werden", e);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Kennzahlen „Freelancer-Hebel“
// ---------------------------------------------------------------------------

export type FreelancerStats = {
  openFreelancerChances: number;
  newFreelancerChances90d: number;
  presentedOffers90d: number;
  accountsWithoutFreelancerChance: number;
  accountsTotal: number;
  openChecks: number;
};

/** Kennzahlen für eine Menge Kunden (Sicht des Akteurs) – nur Zählungen, keine Bewertung einzelner Personen. */
export async function freelancerStats(actor: Actor, accountIds: string[], now = new Date()): Promise<FreelancerStats> {
  const since = new Date(now.getTime() - 90 * DAY);
  const empty: FreelancerStats = { openFreelancerChances: 0, newFreelancerChances90d: 0, presentedOffers90d: 0, accountsWithoutFreelancerChance: 0, accountsTotal: 0, openChecks: 0 };
  const openChecks = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.standardTasks)
    .innerJoin(schema.actions, eq(schema.actions.id, schema.standardTasks.actionId))
    .where(and(eq(schema.standardTasks.workspaceId, actor.workspaceId), eq(schema.standardTasks.ownerUserId, actor.userId), notInArray(schema.actions.status, ["ERLEDIGT", "VERWORFEN"])));
  if (accountIds.length === 0) return { ...empty, openChecks: Number(openChecks[0]?.n ?? 0) };
  const fl = await db.query.opportunities.findMany({ where: and(inArray(schema.opportunities.accountId, accountIds), eq(schema.opportunities.kind, "FREELANCER_EXPERTE")) });
  const open = fl.filter((o) => o.status !== "BEENDET" && o.status !== "ZURUECKGESTELLT");
  const flIds = fl.map((o) => o.id);
  const offers = flIds.length ? await db.query.offers.findMany({ where: and(inArray(schema.offers.opportunityId, flIds), gte(schema.offers.presentedAt, since)) }) : [];
  const withRecent = new Set(fl.filter((o) => o.createdAt >= since || (o.status !== "BEENDET" && o.status !== "ZURUECKGESTELLT")).map((o) => o.accountId));
  return {
    openFreelancerChances: open.length,
    newFreelancerChances90d: fl.filter((o) => o.createdAt >= since).length,
    presentedOffers90d: offers.length,
    accountsWithoutFreelancerChance: accountIds.filter((id) => !withRecent.has(id)).length,
    accountsTotal: accountIds.length,
    openChecks: Number(openChecks[0]?.n ?? 0),
  };
}

/** CEO-Sicht: dieselben Zählungen je zuständigem BD. */
export async function freelancerStatsByBd(workspaceId: string, now = new Date()) {
  const since = new Date(now.getTime() - 90 * DAY);
  const accounts = await db.query.accounts.findMany({ where: and(eq(schema.accounts.workspaceId, workspaceId), eq(schema.accounts.status, "ACTIVE")) });
  if (accounts.length === 0) return [];
  const ids = accounts.map((a) => a.id);
  const fl = await db.query.opportunities.findMany({ where: and(inArray(schema.opportunities.accountId, ids), eq(schema.opportunities.kind, "FREELANCER_EXPERTE")) });
  const flIds = fl.map((o) => o.id);
  const offers = flIds.length ? await db.query.offers.findMany({ where: and(inArray(schema.offers.opportunityId, flIds), gte(schema.offers.presentedAt, since)) }) : [];
  const accountOfOpp = new Map(fl.map((o) => [o.id, o.accountId]));
  const bdIds = [...new Set(accounts.map((a) => a.responsibleBdUserId).filter((x): x is string => !!x))];
  const users = bdIds.length ? await db.query.users.findMany({ where: inArray(schema.users.id, bdIds) }) : [];
  const name = new Map(users.map((u) => [u.id, u.displayName]));
  const groups = new Map<string, { bdName: string; accounts: string[] }>();
  for (const a of accounts) {
    const k = a.responsibleBdUserId ?? "";
    const g = groups.get(k) ?? { bdName: k ? (name.get(k) ?? "?") : "BD offen", accounts: [] };
    g.accounts.push(a.id);
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => {
      const set = new Set(g.accounts);
      const mine = fl.filter((o) => set.has(o.accountId));
      const withRecent = new Set(mine.filter((o) => o.createdAt >= since || (o.status !== "BEENDET" && o.status !== "ZURUECKGESTELLT")).map((o) => o.accountId));
      return {
        bdName: g.bdName,
        accounts: g.accounts.length,
        openFreelancerChances: mine.filter((o) => o.status !== "BEENDET" && o.status !== "ZURUECKGESTELLT").length,
        newFreelancerChances90d: mine.filter((o) => o.createdAt >= since).length,
        presentedOffers90d: offers.filter((of) => set.has(accountOfOpp.get(of.opportunityId) ?? "")).length,
        accountsWithoutFreelancerChance: g.accounts.filter((id) => !withRecent.has(id)).length,
      };
    })
    .sort((a, b) => a.bdName.localeCompare(b.bdName));
}
