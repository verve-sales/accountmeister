import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError } from "@/lib/errors";
import { EXPIRY_URGENT_DAYS, EXPIRY_WINDOW_DAYS } from "@/lib/window";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { listEngagements, RUNNING_STATUSES } from "@/modules/engagements/service";
import { renewalStatusLabel } from "@/modules/engagements/care";
import { buildRound } from "@/modules/rounds/service";
import { computeHealthFor } from "@/modules/health/service";
import { todayIso } from "@/modules/work/calendar";

/**
 * GF-Start (e48): eine Seite, die die Montagsfragen der Geschäftsführung beantwortet – nichts eingeklappt.
 * Wer ist wo bis wann, was läuft in 8 Wochen aus, wie stehen die Kunden, was steckt in der Pipeline (VK × Köpfe),
 * wo bleibt im Team etwas liegen. Reine Lesesicht aus vorhandenen Daten.
 */

const OPEN_OPP = ["ANTIZIPIERT", "IN_KLAERUNG", "BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG"] as const;
const OPEN_ACTION = ["ANGENOMMEN", "IN_ARBEIT", "BLOCKIERT"] as const;
const OPEN_WORK = ["ANGEFRAGT", "OFFEN", "IN_ARBEIT", "BLOCKIERT", "ZUR_PRUEFUNG"];
/** Arbeitstage je Monat für die grobe Monatsangabe (kein Forecast, nur Umrechnung des Tagessatzes) */
export const DAYS_PER_MONTH = 20;

export type GfExpiring = { engagementId: string; person: string; accountId: string; accountName: string; end: string; daysToEnd: number; renewal: string; decided: boolean; owner: string; mood: string | null; urgent: boolean };
export type GfCustomer = { accountId: string; name: string; ampel: "ROT" | "GELB" | "GRUEN"; score: number | null; level: string | null; coverage: number | null; heads: number; headsDelta: number; nextEnd: string | null; owner: string; sentence: string };
export type GfPipeline = { opportunityId: string; title: string; accountId: string; accountName: string; status: string; daysInStage: number; owner: string; heads: number; vkPerDay: number | null; next: string | null; nextDue: string | null; overdue: boolean; stageLag: boolean };
export type GfTeam = { userId: string; name: string; open: number; overdue: number; oldestOverdue: string | null; lastActive: string | null };
export type GfOverview = {
  windowDays: number;
  /** e65: Köpfe je Woche – 12 Wochen zurück (aus Start/Ende der Einsätze) und 12 Wochen voraus (geplante Enden) */
  headsTrend: { date: string; value: number; future: boolean }[];
  kpis: { heads: number; persons: number; endingUndecided: number; pipelinePerDay: number; pipelineCount: number; red: number; yellow: number; teamOverdue: number; openSuggestions: number; revenueMonth: number | null; expiringMonth: number | null };
  expiring: GfExpiring[];
  customers: GfCustomer[];
  /** e66: gefährdete Kunden ohne laufenden Einsatz – stehen nicht in der Kundenrunde, sollen aber nicht fehlen */
  atRiskOther: Array<{ accountId: string; name: string; score: number | null; level: string; coverage: number }>;
  pipeline: GfPipeline[];
  team: GfTeam[];
};

const num = (v: string | null | undefined): number | null => (v == null || v === "" ? null : Number(v));
const dayDiff = (a: string, b: string) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);

export async function buildGfOverview(actor: Actor, today = todayIso()): Promise<GfOverview> {
  if (!hasRole(actor, "CEO")) throw new ForbiddenError("Die GF-Übersicht sieht die Geschäftsführung.");
  const ws = actor.workspaceId;
  const [round, engs, users] = await Promise.all([
    buildRound(actor, today),
    listEngagements(actor, "laufend"),
    db.query.users.findMany({ where: and(eq(schema.users.workspaceId, ws), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true } }),
  ]);
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const respByAccount = new Map<string, string>();
  for (const g of round.groups) for (const a of g.accounts) respByAccount.set(a.accountId, g.userId ? g.name : "");

  // 1) Laufen aus in 8 Wochen – aus den Einsätzen (Name immer vorhanden), überschrittene zuerst
  const expiring: GfExpiring[] = engs.items
    .filter((e) => e.daysToEnd !== null && e.daysToEnd <= EXPIRY_WINDOW_DAYS)
    .map((e) => {
      const decided = e.renewalStatus === "BESTAETIGT" || e.renewalStatus === "ABGELEHNT" || e.renewalStatus === "ERLEDIGT";
      return {
        engagementId: e.id,
        person: e.personName,
        accountId: e.accountId,
        accountName: e.accountName,
        end: e.plannedEnd!,
        daysToEnd: e.daysToEnd!,
        renewal: e.renewalStatus ? renewalStatusLabel[e.renewalStatus] ?? e.renewalStatus : "nicht angestoßen",
        decided,
        owner: e.bdName,
        mood: e.moodKunde?.mood ?? null,
        urgent: !decided && e.daysToEnd! <= EXPIRY_URGENT_DAYS,
      };
    })
    .sort((a, b) => a.daysToEnd - b.daysToEnd);
  // überschrittene Einsätze (Ende vorbei, nicht abgeschlossen) gehören auch hierher
  const overdueEngs = (await listEngagements(actor, "ende_ueberschritten")).items;
  for (const e of overdueEngs) {
    expiring.unshift({ engagementId: e.id, person: e.personName, accountId: e.accountId, accountName: e.accountName, end: e.endDate ?? e.plannedEnd ?? today, daysToEnd: e.daysToEnd ?? 0, renewal: "Ende überschritten – abschließen oder verlängern", decided: false, owner: e.bdName, mood: e.moodKunde?.mood ?? null, urgent: true });
  }

  // 2) Kunden – Kundenrunde als Tabelle
  const customers: GfCustomer[] = round.groups
    .flatMap((g) => g.accounts.map((a) => ({ a, owner: g.userId ? g.name : "offen" })))
    .map(({ a, owner }) => ({
      accountId: a.accountId,
      name: a.name,
      ampel: a.ampel,
      score: a.health?.score ?? null,
      level: a.health?.level ?? null,
      coverage: a.health?.coverage ?? null,
      heads: a.headsNow,
      headsDelta: a.headsNow - a.headsBefore,
      nextEnd: a.ending[0]?.plannedEnd ?? null,
      owner,
      sentence: a.reasons[0] ?? (a.ending.length ? `${a.ending[0]!.person}: ${a.ending[0]!.renewal}` : "Keine Auffälligkeit."),
    }))
    .sort((x, y) => ({ ROT: 0, GELB: 1, GRUEN: 2 })[x.ampel] - ({ ROT: 0, GELB: 1, GRUEN: 2 })[y.ampel] || y.heads - x.heads || x.name.localeCompare(y.name, "de"));

  // 3) Pipeline – offene Chancen mit VK × Köpfe und Tagen in der Stufe
  const inRound = new Set(customers.map((c) => c.accountId));
  const otherAccounts = (await db.query.accounts.findMany({ where: and(eq(schema.accounts.workspaceId, ws), eq(schema.accounts.status, "ACTIVE")), columns: { id: true, name: true } })).filter((a) => !inRound.has(a.id));
  const atRiskOther = (await computeHealthFor(otherAccounts))
    .filter((h) => h.level === "GEFAEHRDET")
    .map((h) => ({ accountId: h.accountId, name: h.accountName, score: h.score, level: h.level, coverage: h.coverage }))
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const opps = await db.query.opportunities.findMany({ where: and(eq(schema.opportunities.workspaceId, ws), inArray(schema.opportunities.status, [...OPEN_OPP])) });
  const oppIds = opps.map((o) => o.id);
  const [accs, positions, events, oppActions] = await Promise.all([
    opps.length ? db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(opps.map((o) => o.accountId))]), columns: { id: true, name: true } }) : Promise.resolve([]),
    oppIds.length ? db.query.staffingPositions.findMany({ where: and(inArray(schema.staffingPositions.opportunityId, oppIds), notInArray(schema.staffingPositions.status, ["ABGEBROCHEN"])) }) : Promise.resolve([]),
    oppIds.length ? db.query.auditEvents.findMany({ where: and(eq(schema.auditEvents.objectType, "OPPORTUNITY"), inArray(schema.auditEvents.objectId, oppIds), eq(schema.auditEvents.action, "opportunity.status_changed")), orderBy: desc(schema.auditEvents.at), columns: { objectId: true, at: true } }) : Promise.resolve([]),
    oppIds.length ? db.query.actions.findMany({ where: and(inArray(schema.actions.opportunityId, oppIds), inArray(schema.actions.status, [...OPEN_ACTION])), columns: { opportunityId: true, title: true, dueDate: true } }) : Promise.resolve([]),
  ]);
  const runningOpp = new Set((oppIds.length ? await db.query.engagements.findMany({ where: and(inArray(schema.engagements.opportunityId, oppIds), inArray(schema.engagements.status, ["GEPLANT", "AKTIV", "PAUSIERT", "ENDET"])), columns: { opportunityId: true } }) : []).map((e) => e.opportunityId));
  const posIds = positions.map((p) => p.id);
  const cands = posIds.length ? await db.query.candidacies.findMany({ where: and(inArray(schema.candidacies.positionId, posIds), isNotNull(schema.candidacies.vkRate)), columns: { positionId: true, vkRate: true, rateUnit: true, status: true } }) : [];
  const an = new Map(accs.map((a) => [a.id, a.name]));
  const perDay = (v: number | null, unit: string) => (v == null ? null : unit === "STUNDE" ? v * 8 : v);
  const positionVk = (p: (typeof positions)[number]): number | null => {
    // bevorzugt der Satz der ausgewählten bzw. weitesten Kandidatur, sonst die Mitte des Angebotsrahmens
    const c = cands.filter((x) => x.positionId === p.id && !["ABGELEHNT", "ZURUECKGEZOGEN", "NICHT_VERFUEGBAR"].includes(x.status)).sort((a, b) => (b.status === "AUSGEWAEHLT" ? 1 : 0) - (a.status === "AUSGEWAEHLT" ? 1 : 0))[0];
    if (c) return perDay(num(c.vkRate), c.rateUnit);
    const lo = num(p.vkMin);
    const hi = num(p.vkMax);
    const mid = lo != null && hi != null ? (lo + hi) / 2 : lo ?? hi;
    return perDay(mid, p.rateUnit);
  };
  const pipeline: GfPipeline[] = opps.map((o) => {
    const ps = positions.filter((p) => p.opportunityId === o.id);
    const heads = ps.length || o.headcount || 1;
    const vks = ps.map(positionVk).filter((x): x is number => x != null);
    const vkPerDay = vks.length ? vks.reduce((a, b) => a + b, 0) + (ps.length > vks.length && vks.length ? (vks.reduce((a, b) => a + b, 0) / vks.length) * (ps.length - vks.length) : 0) : null;
    const lastChange = events.find((e) => e.objectId === o.id)?.at ?? o.createdAt;
    const next = oppActions.filter((a) => a.opportunityId === o.id).sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"))[0] ?? null;
    return {
      opportunityId: o.id,
      title: o.title,
      accountId: o.accountId,
      accountName: an.get(o.accountId) ?? "?",
      status: o.status,
      daysInStage: Math.max(0, dayDiff(today, lastChange.toISOString().slice(0, 10))),
      owner: un.get(o.ownerUserId) ?? "?",
      heads,
      vkPerDay: vkPerDay != null ? Math.round(vkPerDay) : null,
      next: next?.title ?? null,
      nextDue: next?.dueDate ?? null,
      overdue: !!next?.dueDate && next.dueDate < today,
      stageLag: runningOpp.has(o.id),
    };
  }).sort((a, b) => b.daysInStage - a.daysInStage);

  // 4) Team – offene und überfällige Aufgaben je Person (Aktionen, Arbeitsaufträge, Übergaben)
  const [acts, works, hos, lastSeen] = await Promise.all([
    db.query.actions.findMany({ where: and(eq(schema.actions.workspaceId, ws), inArray(schema.actions.status, [...OPEN_ACTION])), columns: { ownerUserId: true, dueDate: true } }),
    db.query.workItems.findMany({ where: and(eq(schema.workItems.workspaceId, ws), inArray(schema.workItems.status, OPEN_WORK), isNotNull(schema.workItems.assigneeUserId)), columns: { assigneeUserId: true, dueDate: true } }),
    db.query.handovers.findMany({ where: and(eq(schema.handovers.workspaceId, ws), eq(schema.handovers.status, "ANGEFRAGT")), columns: { receiverUserId: true, dueDate: true } }),
    db.select({ userId: schema.auditEvents.actorUserId, at: schema.auditEvents.at }).from(schema.auditEvents).where(eq(schema.auditEvents.workspaceId, ws)).orderBy(desc(schema.auditEvents.at)).limit(5000),
  ]);
  const items = [...acts.map((a) => ({ u: a.ownerUserId, due: a.dueDate })), ...works.map((w) => ({ u: w.assigneeUserId!, due: w.dueDate })), ...hos.map((h) => ({ u: h.receiverUserId, due: h.dueDate }))];
  const last = new Map<string, string>();
  for (const e of lastSeen) if (e.userId && !last.has(e.userId)) last.set(e.userId, e.at.toISOString().slice(0, 10));
  const team: GfTeam[] = users
    .map((u) => {
      const mine = items.filter((i) => i.u === u.id);
      const od = mine.filter((i) => i.due && i.due < today).map((i) => i.due!).sort();
      return { userId: u.id, name: u.displayName, open: mine.length, overdue: od.length, oldestOverdue: od[0] ?? null, lastActive: last.get(u.id) ?? null };
    })
    .filter((t) => t.open > 0)
    .sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.name.localeCompare(b.name, "de"));

  const openSuggestions = (await db.query.suggestions.findMany({ where: and(eq(schema.suggestions.workspaceId, ws), inArray(schema.suggestions.status, ["NEU", "GEPRUEFT"])), columns: { id: true } })).length;
  const runningNow = engs.items.filter((e) => (RUNNING_STATUSES as readonly string[]).includes(e.status) && e.status !== "VORBEREITUNG");
  const heads = runningNow.length;
  const persons = new Set(runningNow.map((e) => e.freelancerId ?? e.internalUserId ?? e.id)).size;
  // e65: Verlauf und Ausblick der Köpfe aus den Laufzeiten aller Einsätze (ohne abgebrochene und reine Vorbereitung)
  const allEngs = await db.query.engagements.findMany({ where: and(eq(schema.engagements.workspaceId, ws), notInArray(schema.engagements.status, ["ABGEBROCHEN", "VORBEREITUNG"])), columns: { freelancerId: true, internalUserId: true, id: true, actualStart: true, plannedStart: true, actualEnd: true, plannedEnd: true } });
  const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const headsTrend = Array.from({ length: 25 }, (_, k) => {
    const date = plusDays(today, (k - 12) * 7);
    const active = allEngs.filter((e) => { const st = e.actualStart ?? e.plannedStart; const en = e.actualEnd ?? e.plannedEnd; return !!st && st <= date && (!en || en >= date); });
    return { date, value: new Set(active.map((e) => e.freelancerId ?? e.internalUserId ?? e.id)).size, future: k > 12 };
  });

  return {
    windowDays: EXPIRY_WINDOW_DAYS,
    headsTrend,
    kpis: {
      heads,
      persons,
      endingUndecided: expiring.filter((e) => !e.decided).length,
      pipelinePerDay: pipeline.reduce((s, p) => s + (p.vkPerDay ?? 0), 0),
      pipelineCount: pipeline.length,
      red: customers.filter((c) => c.ampel === "ROT").length,
      yellow: customers.filter((c) => c.ampel === "GELB").length,
      teamOverdue: team.reduce((s, t) => s + t.overdue, 0),
      openSuggestions,
      ...(await revenueKpis(engs.items.map((e) => e.id), new Set(expiring.filter((x) => !x.decided).map((x) => x.engagementId)))),
    },
    expiring,
    customers,
    atRiskOther,
    pipeline,
    team,
  };
}

/**
 * e68 (Entscheidung E3): Wertblick für Geschäftsführung und Sales Operations – laufender Monatsumsatz aus dem aktuellen
 * Verkaufssatz der laufenden Einsätze (Tag bzw. Stunde × 8, × 20 Arbeitstage) und der Teil davon, der in 8 Wochen ohne
 * Entscheidung ausläuft. Keine Prognose, nur Umrechnung vorhandener Sätze; EK und Spanne bleiben außen vor.
 */
export async function revenueKpis(engagementIds: string[], expiringIds: Set<string>): Promise<{ revenueMonth: number | null; expiringMonth: number | null }> {
  if (!engagementIds.length) return { revenueMonth: null, expiringMonth: null };
  const today = todayIso();
  const periods = await db.query.engagementPeriods.findMany({ where: inArray(schema.engagementPeriods.engagementId, engagementIds), columns: { engagementId: true, vk: true, rateUnit: true, validFrom: true, validTo: true, supersededById: true, createdAt: true } });
  let total = 0;
  let expiring = 0;
  let any = false;
  for (const id of engagementIds) {
    const ps = periods.filter((p) => p.engagementId === id && !p.supersededById && p.vk != null && p.validFrom <= today && (!p.validTo || p.validTo >= today)).sort((a, b) => b.validFrom.localeCompare(a.validFrom) || b.createdAt.getTime() - a.createdAt.getTime());
    const p = ps[0] ?? periods.filter((x) => x.engagementId === id && !x.supersededById && x.vk != null).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
    if (!p) continue;
    const perDay = Number(p.vk) * (p.rateUnit === "STUNDE" ? 8 : 1);
    if (!Number.isFinite(perDay)) continue;
    any = true;
    total += perDay * DAYS_PER_MONTH;
    if (expiringIds.has(id)) expiring += perDay * DAYS_PER_MONTH;
  }
  return any ? { revenueMonth: Math.round(total), expiringMonth: Math.round(expiring) } : { revenueMonth: null, expiringMonth: null };
}
