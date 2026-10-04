import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { NotFoundError } from "@/lib/errors";
import type { Actor } from "@/modules/identity/actor";
import { canViewSetup, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { getAccount, listVisibleAccounts } from "@/modules/accounts/service";
import { MATURITY, maturityOf, type Maturity } from "@/modules/strategy/chancen";

/**
 * Aktivitäts-Tracking und Zusammenarbeits-Score (Etappe 12): Grundlage für die Dashboards von CEO, Principal
 * und BD (Etappen 13–15). Keine zweite Datenhaltung – die Zählungen kommen live aus den vorhandenen Objekten
 * (Beobachtungen, Aktionen, entschiedene Vorschläge, bestätigte Weeklys, gepflegte Beziehungen/Einschätzungen),
 * genau wie der Accountplan (siehe dort: „dieselbe Datenbasis wie der operative Fall, keine Doppelpflege“).
 *
 * Der „Aktivitätskoeffizient“ ist bewusst keine geschätzte Kennzahl, sondern eine nachvollziehbare Formel aus
 * gezählten, dokumentierten Ereignissen: Summe der Aktivitäten × (Anzahl der beitragenden Rollen / 3). Ein Kunde,
 * an dem nur eine Rolle aktiv ist, bekommt also einen niedrigeren Koeffizienten als einer mit vergleichbarer
 * Aktivität, an der BD, Anker und Principal zusammen mitwirken – das Ziel ist Zusammenarbeit, nicht bloß Menge.
 */

export const CONTRIBUTOR_ROLES = ["BD", "ANKER", "PRINCIPAL"] as const;
export type ContributorRole = (typeof CONTRIBUTOR_ROLES)[number] | "CEO" | "OTHER";

export type ActivityCounts = {
  weeklysBestaetigt: number;
  beobachtungenErfasst: number;
  aktionenErfasstOderErledigt: number;
  vorschlaegeEntschieden: number;
  kontakteGepflegt: number;
};

const emptyCounts = (): ActivityCounts => ({ weeklysBestaetigt: 0, beobachtungenErfasst: 0, aktionenErfasstOderErledigt: 0, vorschlaegeEntschieden: 0, kontakteGepflegt: 0 });

function totalOf(c: ActivityCounts): number {
  return c.weeklysBestaetigt + c.beobachtungenErfasst + c.aktionenErfasstOderErledigt + c.vorschlaegeEntschieden + c.kontakteGepflegt;
}

/**
 * Rolle je Nutzer für die Zuordnung von Aktivität: Workspace-Rollen (CEO/PRINCIPAL/BD/ANKER) gehen vor,
 * sonst entscheidet der vereinbarte Beitrag im Setup (setup_memberships.contribution). Ohne beides: OTHER.
 * Bewusst grob – die Formel zählt dokumentierte Ereignisse, keine erfundene Genauigkeit über „wer eigentlich
 * zuständig ist“.
 */
async function resolveContributorRoles(workspaceId: string, userIds: string[], setupIds: string[]): Promise<Map<string, ContributorRole>> {
  const ids = [...new Set(userIds)];
  const result = new Map<string, ContributorRole>();
  if (ids.length === 0) return result;
  const [assignments, memberships] = await Promise.all([
    db.query.roleAssignments.findMany({ where: and(inArray(schema.roleAssignments.userId, ids)) }),
    setupIds.length ? db.query.setupMemberships.findMany({ where: inArray(schema.setupMemberships.setupId, setupIds) }) : Promise.resolve([]),
  ]);
  const relevantAssignments = assignments.filter((a) => a.workspaceId === workspaceId);
  for (const userId of ids) {
    const roles = relevantAssignments.filter((a) => a.userId === userId).map((a) => a.role);
    if (roles.includes("CEO")) {
      result.set(userId, "CEO");
    } else if (roles.includes("PRINCIPAL")) {
      result.set(userId, "PRINCIPAL");
    } else if (roles.includes("BD")) {
      result.set(userId, "BD");
    } else if (roles.includes("ANKER")) {
      result.set(userId, "ANKER");
    } else {
      const own = memberships.filter((m) => m.userId === userId);
      if (own.some((m) => m.contribution === "BD_ZUSTAENDIG")) result.set(userId, "BD");
      else if (own.some((m) => m.contribution === "ANKER_KONTEXT" || m.contribution === "ANKER_RUECKFRAGEN" || m.contribution === "ANKER_EINFUEHRUNG")) result.set(userId, "ANKER");
      else result.set(userId, "OTHER");
    }
  }
  return result;
}

export type AccountActivity = {
  accountId: string;
  accountName: string;
  sinceDays: number;
  since: string;
  byRole: Record<(typeof CONTRIBUTOR_ROLES)[number], ActivityCounts>;
  totalActivities: number;
  activeRoles: (typeof CONTRIBUTOR_ROLES)[number][];
  coefficient: number;
  note: string;
};

/**
 * Aktivität eines Kunden im Zeitraum (Standard: letzte 7 Tage = „diese Woche“). Nur Setups, die der Akteur
 * sehen darf, gehen ein – wie beim Accountplan.
 */
export async function buildAccountActivity(actor: Actor, accountId: string, opts: { days?: number } = {}): Promise<AccountActivity> {
  const account = await getAccount(actor, accountId);
  const days = opts.days ?? 7;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const setupRows = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, accountId), orderBy: asc(schema.projectSetups.name) });
  const ctxs: SetupContext[] = [];
  for (const s of setupRows) {
    const ctx = await loadSetupContext(actor, s.id);
    if (ctx && canViewSetup(actor, ctx)) ctxs.push(ctx);
  }
  const setupIds = ctxs.map((c) => c.setup.id);
  const byRole: Record<(typeof CONTRIBUTOR_ROLES)[number], ActivityCounts> = { BD: emptyCounts(), ANKER: emptyCounts(), PRINCIPAL: emptyCounts() };
  if (setupIds.length === 0) {
    return { accountId: account.id, accountName: account.name, sinceDays: days, since: since.toISOString(), byRole, totalActivities: 0, activeRoles: [], coefficient: 0, note: "Keine sichtbaren Setups bei diesem Kunden." };
  }

  const [signals, actions, suggestions, reviewRows, reviewVersions, persons, relationships, assessments] = await Promise.all([
    db.query.signals.findMany({ where: and(inArray(schema.signals.setupId, setupIds), gte(schema.signals.createdAt, since)) }),
    db.query.actions.findMany({ where: and(inArray(schema.actions.setupId, setupIds), gte(schema.actions.updatedAt, since)) }),
    db.query.suggestions.findMany({ where: and(inArray(schema.suggestions.setupId, setupIds), gte(schema.suggestions.decidedAt, since)) }),
    db.query.reviews.findMany({ where: inArray(schema.reviews.setupId, setupIds) }),
    db.query.reviewVersions.findMany({ where: gte(schema.reviewVersions.confirmedAt, since) }),
    db.query.persons.findMany({ where: eq(schema.persons.accountId, accountId) }),
    db.query.relationships.findMany({ where: inArray(schema.relationships.setupId, setupIds) }),
    db.query.personAssessments.findMany({ where: and(inArray(schema.personAssessments.setupId, setupIds), gte(schema.personAssessments.updatedAt, since)) }),
  ]);

  const reviewIds = new Set(reviewRows.map((r) => r.id));
  const confirmedInPeriod = reviewVersions.filter((v) => reviewIds.has(v.reviewId));
  const personIds = new Set(persons.map((p) => p.id));
  const contactsInPeriod = relationships.filter((r) => personIds.has(r.personId) && r.createdAt >= since);
  // Aktionen: neu erfasst ODER erledigt im Zeitraum (kein eigenes Abschlussdatum – updatedAt bei Status ERLEDIGT genügt)
  const actionEvents = actions.filter((a) => a.createdAt >= since || a.status === "ERLEDIGT");

  const contributorIds = [
    ...signals.map((s) => s.createdBy),
    ...actionEvents.map((a) => a.ownerUserId ?? a.createdBy),
    ...suggestions.map((s) => s.decidedBy).filter((x): x is string => !!x),
    ...confirmedInPeriod.map((v) => v.confirmedBy),
    ...contactsInPeriod.map((r) => r.createdBy),
    ...assessments.map((a) => a.createdBy),
  ];
  const roleOf = await resolveContributorRoles(actor.workspaceId, contributorIds, setupIds);

  const add = (userId: string | null | undefined, key: keyof ActivityCounts) => {
    if (!userId) return;
    const role = roleOf.get(userId);
    if (role === "BD" || role === "ANKER" || role === "PRINCIPAL") byRole[role][key]++;
  };
  for (const s of signals) add(s.createdBy, "beobachtungenErfasst");
  for (const a of actionEvents) add(a.ownerUserId ?? a.createdBy, "aktionenErfasstOderErledigt");
  for (const s of suggestions) add(s.decidedBy, "vorschlaegeEntschieden");
  for (const v of confirmedInPeriod) add(v.confirmedBy, "weeklysBestaetigt");
  for (const r of contactsInPeriod) add(r.createdBy, "kontakteGepflegt");
  for (const a of assessments) add(a.createdBy, "kontakteGepflegt");

  const totalActivities = CONTRIBUTOR_ROLES.reduce((n, r) => n + totalOf(byRole[r]), 0);
  const activeRoles = CONTRIBUTOR_ROLES.filter((r) => totalOf(byRole[r]) > 0);
  const coefficient = Math.round(((totalActivities * activeRoles.length) / 3) * 10) / 10;
  const note =
    totalActivities === 0
      ? `Keine dokumentierte Aktivität in den letzten ${days} Tagen.`
      : `${totalActivities} dokumentierte Aktivität(en) in den letzten ${days} Tagen, ${activeRoles.length} von 3 Rollen beteiligt (${activeRoles.join(", ") || "keine"}).`;

  return { accountId: account.id, accountName: account.name, sinceDays: days, since: since.toISOString(), byRole, totalActivities, activeRoles, coefficient, note };
}

/** Aktivitätsübersicht über alle für den Akteur sichtbaren Kunden – Grundlage für CEO-/Principal-Dashboard. */
export async function buildActivityOverview(actor: Actor, opts: { days?: number } = {}): Promise<AccountActivity[]> {
  const accounts = (await listVisibleAccounts(actor)).filter((a) => a.status !== "ARCHIVED");
  const result: AccountActivity[] = [];
  for (const a of accounts) {
    try {
      result.push(await buildAccountActivity(actor, a.id, opts));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
  return result.sort((a, b) => b.coefficient - a.coefficient);
}

/** Dieselben Kategorien wie oben, aber personenbezogen: nur Ereignisse genau dieses Nutzers, nicht rollengebündelt. */
async function personalActivityCounts(userId: string, setupIds: string[], since: Date): Promise<ActivityCounts> {
  if (setupIds.length === 0) return emptyCounts();
  const [signals, actions, suggestions, reviewRows, reviewVersions, relationships, assessments] = await Promise.all([
    db.query.signals.findMany({ where: and(inArray(schema.signals.setupId, setupIds), gte(schema.signals.createdAt, since), eq(schema.signals.createdBy, userId)) }),
    db.query.actions.findMany({ where: and(inArray(schema.actions.setupId, setupIds), gte(schema.actions.updatedAt, since)) }),
    db.query.suggestions.findMany({ where: and(inArray(schema.suggestions.setupId, setupIds), gte(schema.suggestions.decidedAt, since), eq(schema.suggestions.decidedBy, userId)) }),
    db.query.reviews.findMany({ where: inArray(schema.reviews.setupId, setupIds) }),
    db.query.reviewVersions.findMany({ where: and(gte(schema.reviewVersions.confirmedAt, since), eq(schema.reviewVersions.confirmedBy, userId)) }),
    db.query.relationships.findMany({ where: and(inArray(schema.relationships.setupId, setupIds), gte(schema.relationships.createdAt, since), eq(schema.relationships.createdBy, userId)) }),
    db.query.personAssessments.findMany({ where: and(inArray(schema.personAssessments.setupId, setupIds), gte(schema.personAssessments.updatedAt, since), eq(schema.personAssessments.createdBy, userId)) }),
  ]);
  const reviewIds = new Set(reviewRows.map((r) => r.id));
  const confirmedInPeriod = reviewVersions.filter((v) => reviewIds.has(v.reviewId));
  const actionEvents = actions.filter((a) => (a.ownerUserId === userId || a.createdBy === userId) && (a.createdAt >= since || a.status === "ERLEDIGT"));
  return {
    weeklysBestaetigt: confirmedInPeriod.length,
    beobachtungenErfasst: signals.length,
    aktionenErfasstOderErledigt: actionEvents.length,
    vorschlaegeEntschieden: suggestions.length,
    kontakteGepflegt: relationships.length + assessments.length,
  };
}

export type BdAccountPerformance = { accountId: string; accountName: string; myActivities: ActivityCounts; totalMyActivities: number; activeOpportunities: number; convertedOpportunities: number };

export type BdPerformance = {
  userId: string;
  sinceDays: number;
  since: string;
  myActivities: ActivityCounts;
  totalMyActivities: number;
  opportunities: { active: number; converted: number; createdRecently: number; byMaturity: Record<Maturity, number> };
  accounts: BdAccountPerformance[];
  note: string;
};

/**
 * Meine Performance (Etappe 15, BD-Wunsch: „ein Dashboard bei Start, mit dem ich meine Performance sehen kann“):
 * eigene dokumentierte Aktivität (personenbezogen, nicht rollengebündelt) über alle sichtbaren Kunden, plus die
 * eigenen Chancen (Verantwortlich = dieser BD) – aktiv, beauftragt, neu angelegt im Zeitraum.
 */
export async function buildBdPerformance(actor: Actor, opts: { days?: number } = {}): Promise<BdPerformance> {
  const days = opts.days ?? 7;
  const since = new Date();
  since.setDate(since.getDate() - days);
  const accounts = (await listVisibleAccounts(actor)).filter((a) => a.status !== "ARCHIVED");
  const myOpps = await db.query.opportunities.findMany({ where: eq(schema.opportunities.ownerUserId, actor.userId) });
  const active = myOpps.filter((o) => o.status !== "ZURUECKGESTELLT" && o.status !== "BEENDET").length;
  const converted = myOpps.filter((o) => o.status === "BEAUFTRAGT").length;
  const createdRecently = myOpps.filter((o) => o.createdAt >= since).length;
  const byMaturity = Object.fromEntries(MATURITY.map((m) => [m, 0])) as Record<Maturity, number>;
  for (const o of myOpps) {
    const m = maturityOf(o.status);
    if (m) byMaturity[m]++;
  }

  const total = emptyCounts();
  const accountRows: BdAccountPerformance[] = [];
  for (const a of accounts) {
    const setupRows = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, a.id) });
    const ctxs: SetupContext[] = [];
    for (const s of setupRows) {
      const ctx = await loadSetupContext(actor, s.id);
      if (ctx && canViewSetup(actor, ctx)) ctxs.push(ctx);
    }
    const setupIds = ctxs.map((c) => c.setup.id);
    const myCounts = await personalActivityCounts(actor.userId, setupIds, since);
    const myTotal = totalOf(myCounts);
    const activeOpportunities = myOpps.filter((o) => o.accountId === a.id && o.status !== "ZURUECKGESTELLT" && o.status !== "BEENDET").length;
    const convertedOpportunities = myOpps.filter((o) => o.accountId === a.id && o.status === "BEAUFTRAGT").length;
    if (myTotal > 0 || activeOpportunities > 0) {
      accountRows.push({ accountId: a.id, accountName: a.name, myActivities: myCounts, totalMyActivities: myTotal, activeOpportunities, convertedOpportunities });
      for (const k of Object.keys(total) as (keyof ActivityCounts)[]) total[k] += myCounts[k];
    }
  }
  accountRows.sort((a, b) => b.totalMyActivities - a.totalMyActivities || b.activeOpportunities - a.activeOpportunities);
  const totalMyActivities = totalOf(total);
  const note =
    totalMyActivities === 0 && active === 0
      ? `Keine eigene dokumentierte Aktivität und keine aktiven Chancen in den letzten ${days} Tagen.`
      : `${totalMyActivities} eigene dokumentierte Aktivität(en) in den letzten ${days} Tagen; ${active} aktive Chance(n), davon ${converted} beauftragt.`;

  return { userId: actor.userId, sinceDays: days, since: since.toISOString(), myActivities: total, totalMyActivities, opportunities: { active, converted, createdRecently, byMaturity }, accounts: accountRows, note };
}

// ---------------------------------------------------------------------------
// Mein Team (Etappe 31): Aktivitätsindex der Teammitglieder für Teamleiter – Zahlen, keine Inhalte
// ---------------------------------------------------------------------------

export type TeamMemberActivity = { userId: string; name: string; current: ActivityCounts; total: number; previousTotal: number; checkinsErledigt: number; lastActivityDays: number | null };
export type TeamActivity = { teamId: string; teamName: string; days: number; members: TeamMemberActivity[] };

/** Teams, die der Akteur leitet (Rolle LEITUNG) – ohne Sales-Operations-Warteschlange. */
export async function buildTeamActivity(actor: Actor, opts: { days?: number } = {}): Promise<TeamActivity[]> {
  const days = opts.days ?? 28;
  const leads = await db.query.teamMembers.findMany({ where: and(eq(schema.teamMembers.userId, actor.userId), eq(schema.teamMembers.role, "LEITUNG")) });
  if (!leads.length) return [];
  const since = new Date();
  since.setDate(since.getDate() - days);
  const before = new Date(since);
  before.setDate(before.getDate() - days);
  const setupIds = (await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.workspaceId, actor.workspaceId), columns: { id: true } })).map((s) => s.id);
  const out: TeamActivity[] = [];
  for (const l of leads) {
    const team = await db.query.teams.findFirst({ where: and(eq(schema.teams.id, l.teamId), eq(schema.teams.isActive, true)) });
    if (!team || team.key === "SALES_OPS") continue;
    const members = await db.query.teamMembers.findMany({ where: eq(schema.teamMembers.teamId, team.id) });
    const users = await db.query.users.findMany({ where: and(inArray(schema.users.id, members.map((m) => m.userId).concat("-")), eq(schema.users.status, "ACTIVE")) });
    const rows: TeamMemberActivity[] = [];
    for (const u of users) {
      const [current, previous, checkins, lastSignal, lastAction] = await Promise.all([
        personalActivityCounts(u.id, setupIds, since),
        personalActivityCounts(u.id, setupIds, before),
        db.query.checkins.findMany({ where: and(eq(schema.checkins.ownerUserId, u.id), eq(schema.checkins.status, "ERLEDIGT"), gte(schema.checkins.updatedAt, since)), columns: { id: true } }),
        db.query.signals.findFirst({ where: eq(schema.signals.createdBy, u.id), orderBy: (s, { desc }) => [desc(s.createdAt)], columns: { createdAt: true } }),
        db.query.actions.findFirst({ where: eq(schema.actions.ownerUserId, u.id), orderBy: (a, { desc }) => [desc(a.updatedAt)], columns: { updatedAt: true } }),
      ]);
      const last = [lastSignal?.createdAt, lastAction?.updatedAt].filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const total = totalOf(current) + checkins.length;
      // `previous` zählt ab Vorperiodenbeginn (beide Perioden) – Vorperiode = Differenz zur aktuellen
      rows.push({ userId: u.id, name: u.displayName, current, total, previousTotal: Math.max(0, totalOf(previous) - totalOf(current)), checkinsErledigt: checkins.length, lastActivityDays: last ? Math.floor((Date.now() - last.getTime()) / 86400000) : null });
    }
    rows.sort((a, b) => a.total - b.total);
    out.push({ teamId: team.id, teamName: team.name, days, members: rows });
  }
  return out;
}
