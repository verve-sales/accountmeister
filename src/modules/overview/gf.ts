import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError } from "@/lib/errors";
import { EXPIRY_URGENT_DAYS, EXPIRY_WINDOW_DAYS } from "@/lib/window";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { listEngagements, RUNNING_STATUSES } from "@/modules/engagements/service";
import { renewalStatusLabel } from "@/modules/engagements/care";
import { buildRound } from "@/modules/rounds/service";
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
export type GfPipeline = { opportunityId: string; title: string; accountId: string; accountName: string; status: string; daysInStage: number; owner: string; heads: number; vkPerDay: number | null; next: string | null; nextDue: string | null; overdue: boolean };
export type GfTeam = { userId: string; name: string; open: number; overdue: number; oldestOverdue: string | null; lastActive: string | null };
export type GfOverview = {
  windowDays: number;
  kpis: { heads: number; endingUndecided: number; pipelinePerDay: number; pipelineCount: number; red: number; yellow: number; teamOverdue: number; openSuggestions: number };
  expiring: GfExpiring[];
  customers: GfCustomer[];
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
  const opps = await db.query.opportunities.findMany({ where: and(eq(schema.opportunities.workspaceId, ws), inArray(schema.opportunities.status, [...OPEN_OPP])) });
  const oppIds = opps.map((o) => o.id);
  const [accs, positions, events, oppActions] = await Promise.all([
    opps.length ? db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(opps.map((o) => o.accountId))]), columns: { id: true, name: true } }) : Promise.resolve([]),
    oppIds.length ? db.query.staffingPositions.findMany({ where: and(inArray(schema.staffingPositions.opportunityId, oppIds), notInArray(schema.staffingPositions.status, ["ABGEBROCHEN"])) }) : Promise.resolve([]),
    oppIds.length ? db.query.auditEvents.findMany({ where: and(eq(schema.auditEvents.objectType, "OPPORTUNITY"), inArray(schema.auditEvents.objectId, oppIds), eq(schema.auditEvents.action, "opportunity.status_changed")), orderBy: desc(schema.auditEvents.at), columns: { objectId: true, at: true } }) : Promise.resolve([]),
    oppIds.length ? db.query.actions.findMany({ where: and(inArray(schema.actions.opportunityId, oppIds), inArray(schema.actions.status, [...OPEN_ACTION])), columns: { opportunityId: true, title: true, dueDate: true } }) : Promise.resolve([]),
  ]);
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
  const heads = engs.items.filter((e) => (RUNNING_STATUSES as readonly string[]).includes(e.status) && e.status !== "VORBEREITUNG").length;

  return {
    windowDays: EXPIRY_WINDOW_DAYS,
    kpis: {
      heads,
      endingUndecided: expiring.filter((e) => !e.decided).length,
      pipelinePerDay: pipeline.reduce((s, p) => s + (p.vkPerDay ?? 0), 0),
      pipelineCount: pipeline.length,
      red: customers.filter((c) => c.ampel === "ROT").length,
      yellow: customers.filter((c) => c.ampel === "GELB").length,
      teamOverdue: team.reduce((s, t) => s + t.overdue, 0),
      openSuggestions,
    },
    expiring,
    customers,
    pipeline,
    team,
  };
}
