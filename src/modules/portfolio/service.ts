import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { buildDashboard, type AccountCard } from "@/modules/dashboard/service";
import { computeHealthFor, type Level as HealthLevel } from "@/modules/health/service";
import { createWorkItem } from "@/modules/work/service";
import { recordAudit } from "@/modules/audit/audit";
import { todayIso } from "@/modules/work/calendar";

/**
 * „Meine BDs“ (Etappe 33, Use Case 5): Principal und CEO gehen durch die Kunden ihrer BDs – eine Zeile je Kunde mit Team,
 * laufendem Geschäft, neuem Geschäft, letztem Kontakt, offenen Entscheidungen und Ampel; von dort in eine kompakte
 * Kundenzusammenfassung mit Blättern und einem Feld „Entscheidung oder Hinweis für den BD“, das als Vorgang beim BD landet.
 * Sichtbarkeit: nur zugeordnete Kunden (Principal am Kunden; CEO alle) – wie überall.
 */

export type PortfolioRow = {
  accountId: string;
  accountName: string;
  bdUserId: string | null;
  bdName: string;
  ankerNames: string[];
  principalNames: string[];
  runningEngagements: number;
  nextEnd: string | null;
  nextEndPerson: string | null;
  chancesInWork: number;
  chancesAnticipated: number;
  openDecisions: number;
  daysSinceActivity: number;
  health: { score: number | null; level: HealthLevel; coverage: number };
  nextStep: string;
  attention: number;
};

export function canBrowsePortfolio(actor: Actor): boolean {
  return hasRole(actor, "CEO") || actor.roles.has("PRINCIPAL") || [...actor.accountRoles.values()].some((r) => r.has("PRINCIPAL"));
}

const IN_WORK = ["IN_KLAERUNG", "BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG"] as const;

async function teamFor(workspaceId: string, accountIds: string[]) {
  const t = todayIso();
  const rows = await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.workspaceId, workspaceId), inArray(schema.roleAssignments.role, ["ANKER", "PRINCIPAL"])) });
  const live = rows.filter((r) => !r.validTo || r.validTo >= t);
  const userIds = [...new Set(live.map((r) => r.userId))];
  const users = userIds.length ? await db.query.users.findMany({ where: and(inArray(schema.users.id, userIds), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true } }) : [];
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const out = new Map<string, { anker: string[]; principal: string[] }>();
  for (const id of accountIds) {
    const anker = live.filter((r) => r.role === "ANKER" && r.accountId === id).map((r) => un.get(r.userId)).filter((x): x is string => !!x);
    const principal = live.filter((r) => r.role === "PRINCIPAL" && (r.accountId === id || r.scope === "WORKSPACE")).map((r) => un.get(r.userId)).filter((x): x is string => !!x);
    out.set(id, { anker: [...new Set(anker)], principal: [...new Set(principal)] });
  }
  return out;
}

export async function buildPortfolio(actor: Actor): Promise<{ rows: PortfolioRow[]; byBd: { bdName: string; bdUserId: string | null; rows: PortfolioRow[] }[] }> {
  if (!canBrowsePortfolio(actor)) throw new ForbiddenError("„Meine BDs“ sehen Principal und CEO.");
  const d = await buildDashboard(actor, hasRole(actor, "CEO") ? "CEO" : "PRINCIPAL");
  const cards: AccountCard[] = d?.accounts ?? [];
  if (!cards.length) return { rows: [], byBd: [] };
  const ids = cards.map((c) => c.accountId);
  const [accounts, engs, opps, decisions, health, team] = await Promise.all([
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, ids), columns: { id: true, responsibleBdUserId: true } }),
    db.query.engagements.findMany({ where: and(inArray(schema.engagements.accountId, ids), inArray(schema.engagements.status, ["AKTIV", "PAUSIERT", "GEPLANT", "VORBEREITUNG"])), columns: { id: true, accountId: true, plannedEnd: true, freelancerId: true, internalUserId: true } }),
    db.query.opportunities.findMany({ where: and(inArray(schema.opportunities.accountId, ids), inArray(schema.opportunities.status, [...IN_WORK, "ANTIZIPIERT"])), columns: { accountId: true, status: true } }),
    db.query.renewalDecisions.findMany({ where: and(eq(schema.renewalDecisions.workspaceId, actor.workspaceId), inArray(schema.renewalDecisions.status, ["IN_ABSTIMMUNG", "ANGEBOTEN"])), columns: { engagementId: true } }),
    computeHealthFor(cards.map((c) => ({ id: c.accountId, name: c.accountName }))).catch(() => []),
    teamFor(actor.workspaceId, ids),
  ]);
  const engIds = new Set(engs.map((e) => e.id));
  const decByAcc = new Map<string, number>();
  const engAcc = new Map(engs.map((e) => [e.id, e.accountId]));
  for (const dcs of decisions) if (engIds.has(dcs.engagementId)) decByAcc.set(engAcc.get(dcs.engagementId)!, (decByAcc.get(engAcc.get(dcs.engagementId)!) ?? 0) + 1);
  const [fls, us] = await Promise.all([
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(engs.map((e) => e.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: inArray(schema.users.id, [...new Set(engs.map((e) => e.internalUserId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } }),
  ]);
  const fn = new Map(fls.map((f) => [f.id, f.displayName]));
  const un = new Map(us.map((u) => [u.id, u.displayName]));
  const hb = new Map(health.map((h) => [h.accountId, h]));
  const bdOf = new Map(accounts.map((a) => [a.id, a.responsibleBdUserId]));
  const rows: PortfolioRow[] = cards.map((c) => {
    const mine = engs.filter((e) => e.accountId === c.accountId);
    const next = mine.filter((e) => e.plannedEnd).sort((a, b) => a.plannedEnd!.localeCompare(b.plannedEnd!))[0] ?? null;
    const h = hb.get(c.accountId);
    const tm = team.get(c.accountId) ?? { anker: [], principal: [] };
    return {
      accountId: c.accountId,
      accountName: c.accountName,
      bdUserId: bdOf.get(c.accountId) ?? null,
      bdName: c.responsibleBdName ?? "ohne BD",
      ankerNames: tm.anker,
      principalNames: tm.principal,
      runningEngagements: mine.length,
      nextEnd: next?.plannedEnd ?? null,
      nextEndPerson: next ? (next.freelancerId ? fn.get(next.freelancerId) ?? null : next.internalUserId ? un.get(next.internalUserId) ?? null : null) : null,
      chancesInWork: opps.filter((o) => o.accountId === c.accountId && (IN_WORK as readonly string[]).includes(o.status)).length,
      chancesAnticipated: opps.filter((o) => o.accountId === c.accountId && o.status === "ANTIZIPIERT").length,
      openDecisions: decByAcc.get(c.accountId) ?? 0,
      daysSinceActivity: c.daysSinceActivity,
      health: { score: h?.score ?? null, level: h?.level ?? "UNKLAR", coverage: h?.coverage ?? 0 },
      nextStep: c.nextStep,
      attention: c.attention,
    };
  });
  rows.sort((a, b) => a.bdName.localeCompare(b.bdName, "de") || b.attention - a.attention || a.accountName.localeCompare(b.accountName, "de"));
  const byBd: { bdName: string; bdUserId: string | null; rows: PortfolioRow[] }[] = [];
  for (const r of rows) {
    let g = byBd.find((x) => x.bdName === r.bdName);
    if (!g) {
      g = { bdName: r.bdName, bdUserId: r.bdUserId, rows: [] };
      byBd.push(g);
    }
    g.rows.push(r);
  }
  return { rows, byBd };
}

/** Kompakte Kundenzusammenfassung für das Durchgehen – Nachbarn fürs Blättern inklusive. */
export async function portfolioAccount(actor: Actor, accountId: string) {
  const { rows } = await buildPortfolio(actor);
  const idx = rows.findIndex((r) => r.accountId === accountId);
  if (idx < 0) throw new NotFoundError("Kunde");
  const row = rows[idx]!;
  const d = await buildDashboard(actor, hasRole(actor, "CEO") ? "CEO" : "PRINCIPAL");
  const card = d?.accounts.find((c) => c.accountId === accountId) ?? null;
  const [engs, opps, lastHints] = await Promise.all([
    db.query.engagements.findMany({ where: and(eq(schema.engagements.accountId, accountId), inArray(schema.engagements.status, ["AKTIV", "PAUSIERT", "GEPLANT", "VORBEREITUNG"])) }),
    db.query.opportunities.findMany({ where: and(eq(schema.opportunities.accountId, accountId), inArray(schema.opportunities.status, [...IN_WORK, "ANTIZIPIERT"])), columns: { id: true, title: true, status: true, updatedAt: true, ownerUserId: true } }),
    db.query.workItems.findMany({ where: and(eq(schema.workItems.workspaceId, actor.workspaceId), eq(schema.workItems.subjectType, "KUNDE"), eq(schema.workItems.subjectId, accountId)), columns: { id: true, title: true, status: true, dueDate: true, assigneeUserId: true, requesterUserId: true, createdAt: true } }),
  ]);
  const [fls, us, rens] = await Promise.all([
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(engs.map((e) => e.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true } }),
    engs.length ? db.query.renewalDecisions.findMany({ where: inArray(schema.renewalDecisions.engagementId, engs.map((e) => e.id)) }) : Promise.resolve([]),
  ]);
  const fn = new Map(fls.map((f) => [f.id, f.displayName]));
  const un = new Map(us.map((u) => [u.id, u.displayName]));
  const t = todayIso();
  return {
    row,
    prev: rows[idx - 1] ?? null,
    next: rows[idx + 1] ?? null,
    position: { index: idx + 1, total: rows.length },
    card,
    engagements: engs
      .map((e) => {
        const ren = rens.filter((r) => r.engagementId === e.id).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return { id: e.id, title: e.title, person: e.freelancerId ? fn.get(e.freelancerId) ?? "?" : e.internalUserId ? `${un.get(e.internalUserId) ?? "?"} (intern)` : "?", status: e.status, plannedEnd: e.plannedEnd, daysToEnd: e.plannedEnd ? Math.round((new Date(e.plannedEnd).getTime() - new Date(t).getTime()) / 86400000) : null, renewal: ren ? { status: ren.status, to: ren.proposedTo } : null };
      })
      .sort((a, b) => (a.plannedEnd ?? "9999").localeCompare(b.plannedEnd ?? "9999")),
    chances: opps.map((o) => ({ ...o, ownerName: un.get(o.ownerUserId) ?? "?" })).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    hints: lastHints.filter((w) => w.requesterUserId === actor.userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 5).map((w) => ({ ...w, assigneeName: w.assigneeUserId ? un.get(w.assigneeUserId) ?? "?" : "–" })),
  };
}

/** Entscheidung oder Hinweis für den BD: wird ein Vorgang (Aktion) beim BD mit Bezug auf den Kunden. */
export async function leaveDecision(actor: Actor, accountId: string, raw: { text?: string; dueDate?: string; targetUserId?: string; priority?: string }) {
  if (!canBrowsePortfolio(actor)) throw new ForbiddenError("„Meine BDs“ sehen Principal und CEO.");
  const { rows } = await buildPortfolio(actor);
  const row = rows.find((r) => r.accountId === accountId);
  if (!row) throw new NotFoundError("Kunde");
  const target = raw.targetUserId || row.bdUserId;
  if (!target) throw new ForbiddenError("Für diesen Kunden ist kein BD zugeordnet – bitte zuerst einen BD zuordnen.");
  const text = (raw.text ?? "").trim();
  const title = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  const w = await createWorkItem(actor, { title: `${row.accountName}: ${title}`, description: text, subjectType: "KUNDE", subjectId: accountId, target, dueDate: raw.dueDate || "", priority: raw.priority === "HOCH" ? "HOCH" : "NORMAL", kind: "AKTION" });
  await recordAudit(db, actor, "portfolio.decision", "ACCOUNT", accountId, { an: target, text: title });
  return w;
}
