import { and, gte, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { Actor } from "@/modules/identity/actor";
import { listVisibleAccounts } from "@/modules/accounts/service";
import { chanceKindLabel, chanceKindValues } from "@/modules/ai/schemas";
import { opportunityStatusLabel } from "@/lib/labels";

/**
 * Drill-down zu Kennzahlen (Etappe 46): Jede Zahl auf Start und im CEO-Dashboard führt auf die Chancen bzw. Kunden,
 * aus denen sie gezählt ist – mit denselben Regeln wie die Zählung. Nur Kunden, die die Person sehen darf.
 *
 * Parameter: art (Chancenart), bd (User-ID des zuständigen BD, „offen“ = ohne BD), stufe (Status oder „offen“),
 * neu (Tage seit Anlage), vorgestellt (Tage seit Vorstellung eines Angebots), ohne (Kunden ohne offene/neue Chance
 * dieser Art), kunden=alle (Kundenliste), sicht (Kundenkreis einer Dashboard-Sicht), kunde (ein Kunde).
 */
export type DrillParams = { art?: string; bd?: string; stufe?: string; neu?: string; vorgestellt?: string; ohne?: string; kunden?: string; sicht?: string; kunde?: string };

const DAY = 86400000;
const CLOSED = ["BEENDET", "ZURUECKGESTELLT"];

export async function drilldown(actor: Actor, p: DrillParams, now = new Date()) {
  let accounts = (await listVisibleAccounts(actor)).filter((a) => a.status === "ACTIVE" || (p.sicht && a.status === "DORMANT"));
  if (p.sicht) {
    const { buildDashboard } = await import("@/modules/dashboard/service");
    const d = await buildDashboard(actor, p.sicht);
    const ids = new Set((d?.accounts ?? []).map((c) => c.accountId));
    accounts = accounts.filter((a) => ids.has(a.id));
  }
  if (p.bd) accounts = accounts.filter((a) => (p.bd === "offen" ? !a.responsibleBdUserId : a.responsibleBdUserId === p.bd));
  if (p.kunde) accounts = accounts.filter((a) => a.id === p.kunde);
  const ids = accounts.map((a) => a.id);
  const art = chanceKindValues.find((k) => k === (p.ohne || p.art));
  const users = await db.query.users.findMany({ where: inArray(schema.users.id, [...new Set(accounts.map((a) => a.responsibleBdUserId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } });
  const bdName = (id: string | null) => (id ? users.find((u) => u.id === id)?.displayName ?? "?" : "BD offen");
  const opps = ids.length ? await db.query.opportunities.findMany({ where: inArray(schema.opportunities.accountId, ids) }) : [];
  const setups = opps.length ? await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.id, [...new Set(opps.map((o) => o.setupId))]), columns: { id: true, name: true } }) : [];

  const parts: string[] = [];
  if (art) parts.push(chanceKindLabel[art]);
  if (p.bd) parts.push(p.bd === "offen" ? "Kunden ohne BD" : `BD ${bdName(p.bd)}`);
  if (p.kunde && accounts[0]) parts.push(accounts[0].name);

  // Kundenlisten
  if (p.ohne || p.kunden === "alle") {
    const since = new Date(now.getTime() - 90 * DAY);
    const covered = new Set(opps.filter((o) => (!art || o.kind === art) && (o.createdAt >= since || !CLOSED.includes(o.status))).map((o) => o.accountId));
    const list = (p.ohne ? accounts.filter((a) => !covered.has(a.id)) : accounts).map((a) => ({
      id: a.id,
      name: a.name,
      bdName: bdName(a.responsibleBdUserId),
      openChances: opps.filter((o) => o.accountId === a.id && !CLOSED.includes(o.status) && o.status !== "BEAUFTRAGT").length,
    }));
    const title = p.ohne ? `Kunden ohne ${art ? `${chanceKindLabel[art]}-Chance` : "Chance"} (offen oder neu in 90 Tagen)` : "Kunden";
    return { mode: "kunden" as const, title: [title, ...parts.filter((x) => !art || x !== chanceKindLabel[art])].join(" · "), accounts: list.sort((x, y) => x.name.localeCompare(y.name, "de")), chances: [] };
  }

  // Chancenlisten
  let list = opps.filter((o) => !art || o.kind === art);
  if (p.stufe === "offen") { list = list.filter((o) => !CLOSED.includes(o.status)); parts.push("offen"); }
  else if (p.stufe) { list = list.filter((o) => o.status === p.stufe); parts.push(opportunityStatusLabel[p.stufe] ?? p.stufe); }
  if (p.neu) { const since = new Date(now.getTime() - Number(p.neu) * DAY); list = list.filter((o) => o.createdAt >= since); parts.push(`neu in ${p.neu} Tagen`); }
  let offerCount = new Map<string, number>();
  if (p.vorgestellt) {
    const since = new Date(now.getTime() - Number(p.vorgestellt) * DAY);
    const offers = list.length ? await db.query.offers.findMany({ where: and(inArray(schema.offers.opportunityId, list.map((o) => o.id)), gte(schema.offers.presentedAt, since)) }) : [];
    offerCount = new Map<string, number>();
    for (const of of offers) offerCount.set(of.opportunityId, (offerCount.get(of.opportunityId) ?? 0) + 1);
    list = list.filter((o) => offerCount.has(o.id));
    parts.push(`mit vorgestelltem Angebot/Profil in ${p.vorgestellt} Tagen`);
  }
  const accName = new Map(accounts.map((a) => [a.id, a]));
  return {
    mode: "chancen" as const,
    title: ["Chancen", ...parts].join(" · "),
    accounts: [],
    chances: list
      .map((o) => ({ id: o.id, title: o.title, kind: chanceKindLabel[o.kind as (typeof chanceKindValues)[number]] ?? o.kind, status: opportunityStatusLabel[o.status] ?? o.status, accountId: o.accountId, accountName: accName.get(o.accountId)?.name ?? "?", setupName: setups.find((s) => s.id === o.setupId)?.name ?? "", bdName: bdName(accName.get(o.accountId)?.responsibleBdUserId ?? null), createdAt: o.createdAt, offers: offerCount.get(o.id) ?? 0 }))
      .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime()),
  };
}

/** Link-Helfer für Kennzahlen. */
export function drillHref(p: DrillParams): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) q.set(k, String(v));
  return `/chancen?${q.toString()}`;
}
