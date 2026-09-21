import type { GoalStatus, RoleFamily } from "@/db/schema";
import { ForbiddenError } from "@/lib/errors";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { buildPortfolio, listGoals } from "@/modules/leadership/service";
import { buildChanceOverview, MATURITY, type ChanceRow } from "@/modules/strategy/chancen";
import { buildAccountActivity, buildActivityOverview, type AccountActivity } from "@/modules/activity/service";
import { roleFamilyLabel } from "@/modules/roles/catalog";

/**
 * CEO-Dashboard (Etappe 13): synthetisiert vorhandene Bausteine zu einem Gesamtbild je Kunde – erfindet keine
 * neuen Zahlen, sondern verknüpft: Accountziele (11.3) gegen die tatsächlich dokumentierten Positionen (Chancen,
 * 10), die aktuelle Zusammenarbeit (Aktivitätskoeffizient, Etappe 12) und die Portfolio-Gesundheitswerte (10.2).
 * Reine Lesesicht, keine neue Datenhaltung. Wie überall: keine Umsatz-, Forecast- oder Wahrscheinlichkeitswerte.
 */

function assertCeo(actor: Actor) {
  if (!hasRole(actor, "CEO")) throw new ForbiddenError("Das CEO-Dashboard steht der Rolle CEO zur Verfügung.");
}

export type CeoGoalRow = {
  id: string;
  title: string;
  status: GoalStatus;
  roleFamily: RoleFamily | null;
  roleFamilyLabel: string | null;
  targetHeadcount: number | null;
  currentHeadcount: number | null;
  horizon: string | null;
  successCriterion: string | null;
};

export type CeoAccountRow = {
  accountId: string;
  accountName: string;
  responsibleBd: string | null;
  goals: CeoGoalRow[];
  topOpportunities: ChanceRow[];
  activity: AccountActivity;
  openChanges: number | null;
  blockedActions: number | null;
  openSupport: number | null;
  lastConfirmedWeekly: string | null;
};

export type CeoDashboard = {
  sinceDays: number;
  since: string;
  accounts: CeoAccountRow[];
  leadershipGoals: Array<{ id: string; title: string; status: GoalStatus; successCriterion: string | null }>;
  note: string;
};

/**
 * Gesamtbild für den CEO: Performance je Kunde gegenüber vereinbarten Accountzielen, Aktivität der letzten
 * Woche und wie Principal, BD und Anker dabei zusammenwirken (Koeffizient), sowie die aussichtsreichsten
 * dokumentierten Chancen je Kunde. Baut ausschließlich auf bereits vorhandenen Bausteinen auf (buildPortfolio,
 * listGoals, buildChanceOverview, buildAccountActivity) – keine zweite Datenhaltung.
 */
export async function buildCeoDashboard(actor: Actor, opts: { days?: number } = {}): Promise<CeoDashboard> {
  assertCeo(actor);
  const days = opts.days ?? 7;
  const [{ entries: portfolioEntries }, goals, { rows: chanceRows }, activityOverview] = await Promise.all([
    buildPortfolio(actor),
    listGoals(actor),
    buildChanceOverview(actor),
    buildActivityOverview(actor, { days }),
  ]);

  const portfolioByAccount = new Map(portfolioEntries.map((p) => [p.accountId, p]));

  const opportunitiesByAccount = new Map<string, ChanceRow[]>();
  for (const row of chanceRows) {
    const list = opportunitiesByAccount.get(row.accountId) ?? [];
    list.push(row);
    opportunitiesByAccount.set(row.accountId, list);
  }
  for (const [accountId, list] of opportunitiesByAccount) {
    list.sort((a, b) => MATURITY.indexOf(b.maturity) - MATURITY.indexOf(a.maturity) || b.headcount - a.headcount);
    opportunitiesByAccount.set(accountId, list.slice(0, 3));
  }

  // Aktuell dokumentierte Positionen je Kunde/Rollenfamilie – aus denselben Chancen wie das Zielbild, nicht neu gezählt.
  const currentHeadcount = (accountId: string, roleFamily: RoleFamily | null): number =>
    chanceRows.filter((r) => r.accountId === accountId && (!roleFamily || r.family === roleFamily)).reduce((n, r) => n + r.headcount, 0);

  const activeGoals = goals.filter((g) => g.status !== "BEENDET");
  const goalsByAccount = new Map<string, CeoGoalRow[]>();
  const leadershipGoals: CeoDashboard["leadershipGoals"] = [];
  for (const g of activeGoals) {
    const family = (g.current?.roleFamily ?? null) as RoleFamily | null;
    const targetHeadcount = g.current?.targetHeadcount ?? null;
    if (!g.accountId) {
      leadershipGoals.push({ id: g.id, title: g.title, status: g.status, successCriterion: g.current?.successCriterion ?? null });
      continue;
    }
    const row: CeoGoalRow = {
      id: g.id,
      title: g.title,
      status: g.status,
      roleFamily: family,
      roleFamilyLabel: family ? roleFamilyLabel[family] : null,
      targetHeadcount,
      currentHeadcount: targetHeadcount != null ? currentHeadcount(g.accountId, family) : null,
      horizon: g.current?.horizon ?? null,
      successCriterion: g.current?.successCriterion ?? null,
    };
    const list = goalsByAccount.get(g.accountId) ?? [];
    list.push(row);
    goalsByAccount.set(g.accountId, list);
  }

  // Rückgrat: die Aktivitätsübersicht deckt bereits alle für den CEO sichtbaren, nicht archivierten Kunden ab
  // und ist nach Koeffizient absteigend sortiert – genau die Reihenfolge, die für dieses Dashboard sinnvoll ist.
  const accounts: CeoAccountRow[] = activityOverview.map((activity) => {
    const portfolio = portfolioByAccount.get(activity.accountId);
    return {
      accountId: activity.accountId,
      accountName: activity.accountName,
      responsibleBd: portfolio?.responsibleBd ?? null,
      goals: goalsByAccount.get(activity.accountId) ?? [],
      topOpportunities: opportunitiesByAccount.get(activity.accountId) ?? [],
      activity,
      openChanges: portfolio?.openChanges ?? null,
      blockedActions: portfolio?.blockedActions ?? null,
      openSupport: portfolio?.openSupport ?? null,
      lastConfirmedWeekly: portfolio?.lastConfirmedWeekly ?? null,
    };
  });

  return {
    sinceDays: days,
    since: activityOverview[0]?.since ?? new Date().toISOString(),
    accounts,
    leadershipGoals,
    note: "Zählungen dokumentierter Objekte (Ziele, Chancen, Aktivitäten, Accountplan). Keine Umsatz-, Forecast- oder Wahrscheinlichkeitswerte, keine Rohquellen.",
  };
}

/** Gesamtbild für genau einen Kunden – für eine Detailansicht aus dem CEO-Dashboard heraus. */
export async function buildCeoAccountDetail(actor: Actor, accountId: string, opts: { days?: number } = {}): Promise<CeoAccountRow> {
  const dashboard = await buildCeoDashboard(actor, opts);
  const row = dashboard.accounts.find((a) => a.accountId === accountId);
  if (row) return row;
  // Kunde ohne Eintrag in der Übersicht (z. B. Randfall) – Aktivität einzeln nachladen, Rest bleibt leer.
  const activity = await buildAccountActivity(actor, accountId, opts);
  return { accountId, accountName: activity.accountName, responsibleBd: null, goals: [], topOpportunities: [], activity, openChanges: null, blockedActions: null, openSupport: null, lastConfirmedWeekly: null };
}
