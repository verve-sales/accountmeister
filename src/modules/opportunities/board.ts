import { and, gte, inArray, notInArray, or } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { Actor } from "@/modules/identity/actor";
import { listVisibleAccounts } from "@/modules/accounts/service";

/**
 * Pipeline als Board (e69, Entscheidung E4): offene Chancen je Stufe, dazu die in den letzten 60 Tagen beauftragten.
 * Nur Kunden, die die Person sehen darf. Werte: Köpfe und Verkaufssatz aus den Positionen (Mitte des Rahmens).
 */
export const BOARD_STAGES = ["ANTIZIPIERT", "IN_KLAERUNG", "BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG", "BEAUFTRAGT"] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];
export type BoardCard = { id: string; version: number; title: string; status: BoardStage; accountId: string; accountName: string; projectName: string; ownerName: string; heads: number; vkPerDay: number | null; daysInStage: number; stageLag: boolean };

export async function boardData(actor: Actor): Promise<BoardCard[]> {
  const accounts = (await listVisibleAccounts(actor)).filter((a) => a.status === "ACTIVE");
  if (!accounts.length) return [];
  const since = new Date(Date.now() - 60 * 86400000);
  const opps = await db.query.opportunities.findMany({
    where: and(inArray(schema.opportunities.accountId, accounts.map((a) => a.id)), or(inArray(schema.opportunities.status, ["ANTIZIPIERT", "IN_KLAERUNG", "BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG"]), and(inArray(schema.opportunities.status, ["BEAUFTRAGT"]), gte(schema.opportunities.updatedAt, since)))),
  });
  if (!opps.length) return [];
  const ids = opps.map((o) => o.id);
  const [positions, setups, users, running] = await Promise.all([
    db.query.staffingPositions.findMany({ where: and(inArray(schema.staffingPositions.opportunityId, ids), notInArray(schema.staffingPositions.status, ["ABGEBROCHEN"])), columns: { opportunityId: true, vkMin: true, vkMax: true, rateUnit: true } }),
    db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.id, [...new Set(opps.map((o) => o.setupId))]), columns: { id: true, name: true } }),
    db.query.users.findMany({ where: inArray(schema.users.id, [...new Set(opps.map((o) => o.ownerUserId))]), columns: { id: true, displayName: true } }),
    db.query.engagements.findMany({ where: and(inArray(schema.engagements.opportunityId, ids), inArray(schema.engagements.status, ["GEPLANT", "AKTIV", "PAUSIERT", "ENDET"])), columns: { opportunityId: true } }),
  ]);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const sn = new Map(setups.map((s) => [s.id, s.name]));
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const runningOpp = new Set(running.map((r) => r.opportunityId));
  const today = Date.now();
  return opps
    .map((o) => {
      const ps = positions.filter((p) => p.opportunityId === o.id);
      const rates = ps
        .map((p) => {
          const lo = p.vkMin != null ? Number(p.vkMin) : null;
          const hi = p.vkMax != null ? Number(p.vkMax) : null;
          const mid = lo != null && hi != null ? (lo + hi) / 2 : lo ?? hi;
          return mid == null ? null : p.rateUnit === "STUNDE" ? mid * 8 : mid;
        })
        .filter((x): x is number => x != null);
      return {
        id: o.id,
        version: o.version,
        title: o.title,
        status: o.status as BoardStage,
        accountId: o.accountId,
        accountName: an.get(o.accountId) ?? "?",
        projectName: sn.get(o.setupId) ?? "",
        ownerName: un.get(o.ownerUserId) ?? "?",
        heads: ps.length || o.headcount || 1,
        vkPerDay: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0)) : null,
        daysInStage: Math.max(0, Math.floor((today - o.updatedAt.getTime()) / 86400000)),
        stageLag: o.status !== "BEAUFTRAGT" && runningOpp.has(o.id),
      };
    })
    .sort((a, b) => b.daysInStage - a.daysInStage);
}
