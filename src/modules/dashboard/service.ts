import { and, eq, inArray, or } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { Role } from "@/db/schema";
import type { Actor } from "@/modules/identity/actor";
import { hasRole } from "@/modules/identity/actor";
import { canViewAccount, canViewSetup, isResponsibleBd, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { analyzeSetup, type SetupAnalysis, type Stage, STAGES } from "@/modules/strategy/analysis";
import { listVisibleAccounts } from "@/modules/accounts/service";
import { listGoals } from "@/modules/leadership/service";
import { buildActivityOverview, buildBdPerformance, buildTeamActivity, type AccountActivity, type BdPerformance, type TeamActivity } from "@/modules/activity/service";
import { buildChanceOverview, MATURITY, type ChanceRow } from "@/modules/strategy/chancen";

/**
 * Dashboard je Rolle (Etappe 9, E-043). Eine „Sicht“ ist eine Brille, keine Rechteerweiterung: Wählbar sind nur
 * Rollen, die der Person tatsächlich zugewiesen sind; jede Sicht zeigt den Zuordnungsbereich dieser Rolle
 * (BD: eigene Kunden/Setups als zuständiger BD; Anker: Setups mit Anker-Beitrag; Principal: Principal-Kunden;
 * CEO: alle Kunden zusammenfassend, ohne Rohquellen). Rechteprüfungen bleiben die der Dienste.
 */

export const DASHBOARD_VIEWS = ["BD", "ANKER", "PRINCIPAL", "CEO", "SALES_OPS"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export const viewLabel: Record<DashboardView, string> = { BD: "BD", ANKER: "Anker", PRINCIPAL: "Principal", CEO: "CEO", SALES_OPS: "Sales Operations" };
export const viewDescription: Record<DashboardView, string> = {
  BD: "Meine Kunden und Setups als zuständiger BD: was diese Woche dran ist, wo der nächste große Schritt hängt.",
  ANKER: "Setups, in denen ich Kontext beitrage: Rückfragen an mich, Kontaktaufnahmen, die auf mich warten.",
  PRINCIPAL: "Mein Portfolio: Unterstützungsaufträge, Kunden mit Stillstand oder Lücken, Zielbezug.",
  CEO: "Gesamtbild ohne Rohquellen: Stand je Kunde, Ziele, wo es hakt.",
  SALES_OPS: "Für die BDs vorzubereiten: Vorbereitungsschritte und Unterstützungsaufträge an mich, Kunden mit Lücken (Personen, Buyingcenter, Recherche).",
};

/** Welche Sichten stehen dieser Person offen? */
export async function availableViews(actor: Actor): Promise<DashboardView[]> {
  const views: DashboardView[] = [];
  const has = (r: Role) => actor.roles.has(r) || [...actor.accountRoles.values()].some((s) => s.has(r));
  if (has("BD")) views.push("BD");
  let anker = has("ANKER");
  if (!anker) {
    const m = await db.query.setupMemberships.findFirst({ where: and(eq(schema.setupMemberships.userId, actor.userId), inArray(schema.setupMemberships.contribution, ["ANKER_KONTEXT", "ANKER_RUECKFRAGEN", "ANKER_EINFUEHRUNG"])) });
    anker = !!m;
  }
  if (anker) views.push("ANKER");
  if (has("PRINCIPAL")) views.push("PRINCIPAL");
  if (has("CEO")) views.push("CEO");
  if (has("SALES_OPS")) views.push("SALES_OPS");
  return views;
}

export async function resolveView(actor: Actor, requested: string | null | undefined): Promise<{ view: DashboardView | null; available: DashboardView[] }> {
  const available = await availableViews(actor);
  if (available.length === 0) return { view: null, available };
  const wanted = DASHBOARD_VIEWS.find((v) => v === requested);
  return { view: wanted && available.includes(wanted) ? wanted : available[0]!, available };
}

// ---------------------------------------------------------------------------

export type AccountCard = {
  accountId: string;
  accountName: string;
  responsibleBdName: string | null;
  stage: Stage;
  stageLabel: string;
  nextStep: string;
  /** Wofür: alle aktiven Chancen des Kunden, kompakt */
  purpose: string;
  chanceCount: number;
  setups: SetupAnalysis[];
  blockers: string[];
  missing: string[];
  moves: { text: string; href: string }[];
  daysSinceActivity: number;
  /** Aufmerksamkeitswert für die Sortierung: Blocker zählen doppelt. */
  attention: number;
};

export type WeekItem = { kind: "AKTION" | "UEBERGABE" | "VORSCHLAG" | "UNTERSTUETZUNG" | "REVIEW" | "FRAGE"; text: string; href: string; due: string | null; overdue: boolean; today: boolean };

export type Dashboard = {
  view: DashboardView;
  available: DashboardView[];
  week: WeekItem[];
  accounts: AccountCard[];
  ideas: { text: string; detail: string; href: string; setupName: string }[];
  goals: { title: string; status: string; href: string }[];
  /** Nur für die Principal-Sicht befüllt: Zusammenarbeit der letzten Woche je Kunde (Etappe 12). */
  activity: AccountActivity[];
  /** Nur für die Principal-Sicht befüllt: aussichtsreichste Chancen je Kunde (accountId → Top 3). */
  topOpportunities: Record<string, ChanceRow[]>;
  /** Nur für die Principal-Sicht befüllt: offene, unentschiedene Beobachtungen, die auf eine mögliche neue Chance hindeuten. */
  opportunityHints: { text: string; detail: string; href: string; accountName: string }[];
  /** Nur für die BD-Sicht befüllt: eigene Performance (Aktivität, eigene Chancen) – Etappe 15. */
  bdPerformance: BdPerformance | null;
  /** Für Teamleiter (Rolle Leitung in einem Linien-Team, Etappe 31): Aktivitätsindex der Mitglieder – in jeder Sicht. */
  teamActivity: TeamActivity[];
  note: string;
  empty: string | null;
};

/** Setups im Zuordnungsbereich der Sicht – nur solche, die der Akteur sehen darf. */
async function scopedContexts(actor: Actor, view: DashboardView): Promise<SetupContext[]> {
  const accounts = (await listVisibleAccounts(actor)).filter((a) => a.status !== "ARCHIVED");
  let setups: (typeof schema.projectSetups.$inferSelect)[] = [];
  if (view === "BD") {
    const myAccountIds = accounts.filter((a) => isResponsibleBd(actor, a) || actor.accountRoles.get(a.id)?.has("BD")).map((a) => a.id);
    setups = await db.query.projectSetups.findMany({ where: and(eq(schema.projectSetups.workspaceId, actor.workspaceId), or(eq(schema.projectSetups.bdUserId, actor.userId), myAccountIds.length ? inArray(schema.projectSetups.accountId, myAccountIds) : undefined)) });
  } else if (view === "ANKER") {
    const m = await db.query.setupMemberships.findMany({ where: and(eq(schema.setupMemberships.userId, actor.userId), inArray(schema.setupMemberships.contribution, ["ANKER_KONTEXT", "ANKER_RUECKFRAGEN", "ANKER_EINFUEHRUNG"])) });
    const ids = m.map((x) => x.setupId);
    setups = ids.length ? await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.id, ids) }) : [];
  } else if (view === "PRINCIPAL") {
    const ids = accounts.filter((a) => hasRole(actor, "PRINCIPAL", a.id)).map((a) => a.id);
    setups = ids.length ? await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.accountId, ids) }) : [];
  } else {
    const ids = accounts.filter((a) => canViewAccount(actor, a)).map((a) => a.id);
    setups = ids.length ? await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.accountId, ids) }) : [];
  }
  const out: SetupContext[] = [];
  for (const s of setups.filter((s) => s.status !== "ARCHIVIERT")) {
    const ctx = await loadSetupContext(actor, s.id);
    if (ctx && canViewSetup(actor, ctx) && ctx.account.status !== "ARCHIVED") out.push(ctx);
  }
  return out;
}

function endOfWeek(): string {
  const d = new Date();
  const day = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() + (7 - day));
  return d.toISOString().slice(0, 10);
}

async function buildWeek(actor: Actor, view: DashboardView, ctxs: SetupContext[]): Promise<WeekItem[]> {
  const items: WeekItem[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const eow = endOfWeek();
  const setupIds = ctxs.map((c) => c.setup.id);
  const setupName = new Map(ctxs.map((c) => [c.setup.id, `${c.account.name} · ${c.setup.name}`]));

  // Eigene offene Aktionen – überfällig oder bis Wochenende fällig; ohne Frist: die ältesten drei
  const actions = await db.query.actions.findMany({ where: and(eq(schema.actions.ownerUserId, actor.userId), inArray(schema.actions.status, ["VORGESCHLAGEN", "ANGENOMMEN", "IN_ARBEIT", "BLOCKIERT"])) });
  const dated = actions.filter((a) => a.dueDate && a.dueDate <= eow).sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1));
  for (const a of dated) items.push({ kind: "AKTION", text: `${a.title}${a.setupId && setupName.get(a.setupId) ? ` – ${setupName.get(a.setupId)}` : ""}`, href: a.setupId ? `/setups/${a.setupId}` : "/meine-arbeit", due: a.dueDate, overdue: a.dueDate! < today, today: a.dueDate === today });
  const undated = actions.filter((a) => !a.dueDate).slice(0, 3);
  for (const a of undated) items.push({ kind: "AKTION", text: `${a.title} (ohne Frist)`, href: a.setupId ? `/setups/${a.setupId}` : "/meine-arbeit", due: null, overdue: false, today: false });

  // Übergaben an mich
  const handovers = await db.query.handovers.findMany({ where: and(eq(schema.handovers.receiverUserId, actor.userId), eq(schema.handovers.status, "ANGEFRAGT")) });
  for (const h of handovers) items.push({ kind: "UEBERGABE", text: `Übergabe annehmen: ${h.responsibility}`, href: "/meine-arbeit", due: h.dueDate, overdue: !!h.dueDate && h.dueDate < today, today: h.dueDate === today });

  // An mich adressierte Vorschläge (nicht für CEO – Vorschläge stammen aus Quellen)
  if (view !== "CEO" && setupIds.length) {
    const sugg = await db.query.suggestions.findMany({ where: and(inArray(schema.suggestions.setupId, setupIds), eq(schema.suggestions.proposedOwnerUserId, actor.userId), inArray(schema.suggestions.status, ["NEU", "GEPRUEFT"])), limit: 5 });
    for (const s of sugg) items.push({ kind: "VORSCHLAG", text: `Vorschlag prüfen: ${s.title} – ${setupName.get(s.setupId) ?? ""}`, href: "/meine-arbeit", due: null, overdue: false, today: false });
  }

  // Unterstützungsaufträge (Principal/CEO: an mich; BD: meine offenen)
  const support = await db.query.supportRequests.findMany({ where: and(eq(schema.supportRequests.workspaceId, actor.workspaceId), or(eq(schema.supportRequests.addresseeUserId, actor.userId), eq(schema.supportRequests.requesterUserId, actor.userId)), inArray(schema.supportRequests.status, ["ANGEFRAGT", "ANGENOMMEN"])) });
  for (const s of support) {
    const toMe = s.addresseeUserId === actor.userId;
    if (view === "BD" && toMe) continue;
    if ((view === "PRINCIPAL" || view === "CEO" || view === "SALES_OPS") && !toMe) continue;
    items.push({ kind: "UNTERSTUETZUNG", text: `${toMe ? "Unterstützung erbeten" : "Meine Anfrage"}: ${s.task.slice(0, 120)}`, href: s.setupId ? `/setups/${s.setupId}` : "/meine-arbeit", due: s.dueDate, overdue: !!s.dueDate && s.dueDate < today, today: s.dueDate === today });
  }

  // Reviews diese Woche (setupbezogen im Bereich, oder Führungs-Reviews mit mir)
  if (setupIds.length) {
    const reviews = await db.query.reviews.findMany({ where: and(inArray(schema.reviews.setupId, setupIds), inArray(schema.reviews.status, ["GEPLANT", "IN_VORBEREITUNG", "LAUFEND", "BESTAETIGUNG_OFFEN"])) });
    for (const r of reviews.filter((r) => r.scheduledFor <= eow)) items.push({ kind: "REVIEW", text: `Weekly ${setupName.get(r.setupId!) ?? ""}${r.status === "BESTAETIGUNG_OFFEN" ? " – Bestätigung offen" : ""}`, href: `/weeklys/${r.id}`, due: r.scheduledFor, overdue: r.scheduledFor < today, today: r.scheduledFor === today });
  }

  items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.today) - Number(a.today) || (a.due ?? "9").localeCompare(b.due ?? "9"));
  return items.slice(0, 15);
}

export async function buildDashboard(actor: Actor, requested: string | null | undefined): Promise<Dashboard | null> {
  const { view, available } = await resolveView(actor, requested);
  if (!view) return null;
  const ctxs = await scopedContexts(actor, view);
  const analyses: SetupAnalysis[] = [];
  for (const ctx of ctxs) {
    try {
      analyses.push(await analyzeSetup(actor, ctx));
    } catch {
      /* Setup ohne Sicht – überspringen */
    }
  }
  // Kundenkarten
  const byAccount = new Map<string, SetupAnalysis[]>();
  for (const a of analyses) byAccount.set(a.accountId, [...(byAccount.get(a.accountId) ?? []), a]);
  const bdIds = [...new Set(ctxs.map((c) => c.account.responsibleBdUserId).filter((x): x is string => !!x))];
  const bdNames = new Map(bdIds.length ? (await db.query.users.findMany({ where: inArray(schema.users.id, bdIds) })).map((u) => [u.id, u.displayName]) : []);
  const cards: AccountCard[] = [];
  for (const [accountId, list] of byAccount) {
    const ctx = ctxs.find((c) => c.account.id === accountId)!;
    const top = [...list].sort((x, y) => STAGES.indexOf(y.stage) - STAGES.indexOf(x.stage))[0]!;
    const uniq = (xs: string[]) => [...new Set(xs)];
    const blockers = uniq(list.flatMap((a) => a.blockers)).slice(0, 4);
    const missing = uniq(list.flatMap((a) => a.missing)).slice(0, 4);
    const moves = list.flatMap((a) => a.moves).filter((m, i, arr) => arr.findIndex((x) => x.text === m.text) === i).slice(0, 4);
    cards.push({
      accountId,
      accountName: ctx.account.name,
      responsibleBdName: ctx.account.responsibleBdUserId ? (bdNames.get(ctx.account.responsibleBdUserId) ?? null) : null,
      stage: top.stage,
      stageLabel: top.stageLabel,
      nextStep: top.nextStep,
      purpose: list.some((a) => a.opportunities.length) ? list.flatMap((a) => a.opportunities).map((o) => `${o.headcount ? `${o.headcount}× ` : ""}${o.roleName ?? o.title}${o.kind !== "VERVE_EXPERTE" ? ` (${o.kindLabel})` : ""}${o.horizon ? ` ${o.horizon}` : ""} – ${o.statusKey === "ANTIZIPIERT" ? "antizipiert" : o.status.toLowerCase()}`).join("; ") : "Noch keine Chance benannt – worauf läuft es hinaus?",
      chanceCount: list.reduce((n, a) => n + a.opportunities.length, 0),
      setups: list,
      blockers,
      missing,
      moves,
      daysSinceActivity: Math.min(...list.map((a) => a.daysSinceActivity)),
      attention: blockers.length * 2 + missing.length + moves.length,
    });
  }
  cards.sort((a, b) => b.attention - a.attention || a.accountName.localeCompare(b.accountName));

  const week = await buildWeek(actor, view, ctxs);

  // Ideen: offene KI-Vorschläge im Bereich, die nicht an mich adressiert sind (Rohquellen bleiben außen vor; CEO: keine)
  let ideas: Dashboard["ideas"] = [];
  if (view !== "CEO" && ctxs.length) {
    const setupIds = ctxs.map((c) => c.setup.id);
    const setupName = new Map(ctxs.map((c) => [c.setup.id, `${c.account.name} · ${c.setup.name}`]));
    const sugg = await db.query.suggestions.findMany({ where: and(inArray(schema.suggestions.setupId, setupIds), inArray(schema.suggestions.status, ["NEU", "GEPRUEFT"])), orderBy: (s, { desc }) => desc(s.computedAt), limit: 40 });
    ideas = sugg
      .filter((s) => s.proposedOwnerUserId !== actor.userId)
      .slice(0, 8)
      .map((s) => ({ text: s.title, detail: s.nextStep || s.hypothesis || s.observation || "", href: `/setups/${s.setupId}`, setupName: setupName.get(s.setupId) ?? "" }));
  }

  // Ziele (Principal/CEO)
  let goals: Dashboard["goals"] = [];
  if (view === "PRINCIPAL" || view === "CEO") {
    try {
      const g = await listGoals(actor);
      goals = g.filter((x) => x.status !== "BEENDET").slice(0, 6).map((x) => ({ title: x.title, status: x.status, href: `/ziele/${x.id}` }));
    } catch {
      goals = [];
    }
  }

  const empty = ctxs.length === 0 ? (view === "BD" ? "Noch keine Kunden oder Setups, für die du als BD zuständig bist. Lege einen Kunden an oder lass dich einem Setup zuordnen." : view === "ANKER" ? "Du bist in keinem Setup als Anker eingetragen." : view === "PRINCIPAL" ? "Dir ist noch kein Kunde als Principal zugeordnet." : "Keine sichtbaren Kunden.") : null;

  // Principal-Start (Etappe 14): Zusammenarbeit der letzten Woche, Top-Chancen je Kunde, offene Hinweise auf mögliche neue Chancen.
  let activity: Dashboard["activity"] = [];
  let topOpportunities: Dashboard["topOpportunities"] = {};
  let opportunityHints: Dashboard["opportunityHints"] = [];
  if (view === "PRINCIPAL") {
    try {
      activity = await buildActivityOverview(actor, { days: 7 });
    } catch {
      activity = [];
    }
    try {
      const { rows } = await buildChanceOverview(actor);
      const byAccount = new Map<string, ChanceRow[]>();
      for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);
      for (const [accountId, list] of byAccount) {
        list.sort((a, b) => MATURITY.indexOf(b.maturity) - MATURITY.indexOf(a.maturity) || b.headcount - a.headcount);
        topOpportunities[accountId] = list.slice(0, 3);
      }
    } catch {
      topOpportunities = {};
    }
    if (ctxs.length) {
      const setupIds = ctxs.map((c) => c.setup.id);
      const accountOf = new Map(ctxs.map((c) => [c.setup.id, c.account.name]));
      // Unentschiedene, von der KI abgeleitete Beobachtungen (Kategorie „Neue Information“) – ein Hinweis, keine Vorhersage.
      const hints = await db.query.suggestions.findMany({
        where: and(inArray(schema.suggestions.setupId, setupIds), eq(schema.suggestions.type, "BEOBACHTUNG"), eq(schema.suggestions.priorityCategory, "NEUE_INFORMATION"), inArray(schema.suggestions.status, ["NEU", "GEPRUEFT"])),
        orderBy: (s, { desc }) => desc(s.computedAt),
        limit: 8,
      });
      opportunityHints = hints.map((h) => ({ text: h.title, detail: h.hypothesis || h.observation || "", href: `/setups/${h.setupId}`, accountName: accountOf.get(h.setupId) ?? "" }));
    }
  }

  // BD-Start (Etappe 15): eigene Performance – Aktivität, eigene Chancen.
  let bdPerformance: Dashboard["bdPerformance"] = null;
  if (view === "BD") {
    try {
      bdPerformance = await buildBdPerformance(actor, { days: 7 });
    } catch {
      bdPerformance = null;
    }
  }

  let teamActivity: TeamActivity[] = [];
  try {
    teamActivity = await buildTeamActivity(actor, { days: 28 });
  } catch {
    teamActivity = [];
  }

  return {
    view,
    available,
    week,
    accounts: cards,
    ideas,
    goals,
    activity,
    topOpportunities,
    opportunityHints,
    bdPerformance,
    teamActivity,
    note: "Alle Angaben sind Zählungen und Regeln über dokumentierte Objekte; keine Umsatz-, Forecast- oder Wahrscheinlichkeitswerte. Die Sicht ändert keine Rechte.",
    empty,
  };
}
