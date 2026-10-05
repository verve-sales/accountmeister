import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { opportunityStatusLabel } from "@/lib/labels";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { baseUrl } from "@/modules/notifications/mailer";
import { plusDaysIso } from "@/modules/work/calendar";
import { getMocoClient, type MocoClient, type MocoDeal, type MocoDealCategory } from "./client";
import { canRunMocoImport, normName } from "./import";

/**
 * Lead-Push Accountmeister → Moco (Etappe 32, erster Schritt).
 *
 * Offene Chancen werden als Leads (Deals) in Moco angelegt. Der Accountmeister bleibt für Chancen führend; in Moco dient
 * der Lead der Sichtbarkeit in der Akquise-Pipeline. Jede Chance wird höchstens einmal übertragen (`opportunities.moco_deal_id`).
 * Gibt es in Moco bereits einen Lead gleichen Namens bei derselben Firma, wird nur verknüpft, nicht neu angelegt.
 */

/** Chancen in diesen Zuständen sind Leads; beauftragte/beendete haben in Moco ein Projekt bzw. nichts mehr zu suchen. */
export const LEAD_STATUSES = ["ANTIZIPIERT", "IN_KLAERUNG", "BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG", "ZURUECKGESTELLT"] as const;
type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Grobe Wahrscheinlichkeit je AM-Status, um die passende Moco-Phase vorzuschlagen (in Prozent). */
const STATUS_PROBABILITY: Record<LeadStatus, number> = { ANTIZIPIERT: 5, IN_KLAERUNG: 15, BESTAETIGT: 40, PROFIL_ANGEBOT_VORGESTELLT: 65, AUSWAHL_BESTELLUNG: 90, ZURUECKGESTELLT: 10 };

export function suggestCategory(status: string, cats: MocoDealCategory[]): MocoDealCategory | null {
  if (!cats.length) return null;
  const target = STATUS_PROBABILITY[status as LeadStatus] ?? 20;
  return [...cats].sort((a, b) => Math.abs(a.probability - target) - Math.abs(b.probability - target) || a.probability - b.probability)[0] ?? null;
}

export type LeadCandidate = {
  opportunityId: string;
  title: string;
  status: string;
  accountId: string;
  accountName: string;
  setupTitle: string;
  ownerName: string;
  /** Firma in Moco: verknüpft, per Namensgleichheit vorgeschlagen oder fehlt */
  company: { id: number; name: string; source: "VERKNUEPFT" | "VORSCHLAG" } | null;
  /** Moco-Nutzer, der den Lead besitzt (Chancen-Verantwortlicher, sonst wer überträgt) */
  mocoUserId: number | null;
  /** Bereits in Moco vorhandener Lead gleichen Namens bei dieser Firma → wird nur verknüpft */
  existingDeal: { id: number; name: string } | null;
  suggestedCategoryId: number | null;
  ready: boolean;
  blocker: string | null;
};

async function loadOpenOpportunities(workspaceId: string, ids?: string[]) {
  const where = [eq(schema.opportunities.workspaceId, workspaceId), isNull(schema.opportunities.mocoDealId), inArray(schema.opportunities.status, [...LEAD_STATUSES])];
  if (ids) where.push(inArray(schema.opportunities.id, ids));
  const rows = await db
    .select({
      opp: schema.opportunities,
      accountName: schema.accounts.name,
      accountMocoCompanyId: schema.accounts.mocoCompanyId,
      setupTitle: schema.projectSetups.name,
      ownerName: schema.users.displayName,
      ownerMocoUserId: schema.users.mocoUserId,
    })
    .from(schema.opportunities)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.opportunities.accountId))
    .innerJoin(schema.projectSetups, eq(schema.projectSetups.id, schema.opportunities.setupId))
    .innerJoin(schema.users, eq(schema.users.id, schema.opportunities.ownerUserId))
    .where(and(...where));
  return rows.sort((a, b) => a.accountName.localeCompare(b.accountName, "de") || a.opp.title.localeCompare(b.opp.title, "de"));
}

async function actorMocoUserId(actor: Actor): Promise<number | null> {
  const me = await db.query.users.findFirst({ where: eq(schema.users.id, actor.userId), columns: { mocoUserId: true } });
  return me?.mocoUserId ?? null;
}

function findExistingDeal(deals: MocoDeal[], companyId: number | null, title: string): MocoDeal | null {
  if (!companyId) return null;
  const n = normName(title);
  return deals.find((d) => d.company?.id === companyId && normName(d.name) === n && d.status !== "dropped" && d.status !== "lost") ?? null;
}

export type LeadOverview = { candidates: LeadCandidate[]; categories: MocoDealCategory[]; actorMocoUserId: number | null };

/** Übersicht der übertragbaren Chancen samt Prüfung, was Moco dafür braucht. */
export async function listLeadCandidates(actor: Actor, client: MocoClient = getMocoClient(), opportunityIds?: string[]): Promise<LeadOverview> {
  if (!canRunMocoImport(actor)) throw new ForbiddenError("Leads nach Moco übertragen CEO oder Principal.");
  const [rows, companies, categories, deals, myMocoId] = await Promise.all([loadOpenOpportunities(actor.workspaceId, opportunityIds), client.companies({ type: "customer" }), client.dealCategories(), client.deals(), actorMocoUserId(actor)]);
  const byNorm = new Map(companies.filter((c) => c.active !== false).map((c) => [normName(c.name), c]));
  const byId = new Map(companies.map((c) => [c.id, c]));
  const candidates: LeadCandidate[] = rows.map((r) => {
    let company: LeadCandidate["company"] = null;
    if (r.accountMocoCompanyId) {
      company = { id: r.accountMocoCompanyId, name: byId.get(r.accountMocoCompanyId)?.name ?? `Moco-Firma ${r.accountMocoCompanyId}`, source: "VERKNUEPFT" };
    } else {
      const m = byNorm.get(normName(r.accountName));
      if (m) company = { id: m.id, name: m.name, source: "VORSCHLAG" };
    }
    const mocoUserId = r.ownerMocoUserId ?? myMocoId;
    const existing = findExistingDeal(deals, company?.id ?? null, r.opp.title);
    const blocker = !company ? "Kunde ist mit keiner Moco-Firma verknüpft (Firma zuerst in Moco anlegen oder Kunden per Prüfliste verknüpfen)." : !mocoUserId ? "Weder die/der Verantwortliche noch Sie sind mit einem Moco-Nutzer verknüpft." : !categories.length && !existing ? "In Moco sind keine Lead-Phasen angelegt." : null;
    return {
      opportunityId: r.opp.id,
      title: r.opp.title,
      status: r.opp.status,
      accountId: r.opp.accountId,
      accountName: r.accountName,
      setupTitle: r.setupTitle,
      ownerName: r.ownerName,
      company,
      mocoUserId,
      existingDeal: existing ? { id: existing.id, name: existing.name } : null,
      suggestedCategoryId: suggestCategory(r.opp.status, categories)?.id ?? null,
      ready: !blocker,
      blocker,
    };
  });
  return { candidates, categories, actorMocoUserId: myMocoId };
}

export type LeadPushItem = { opportunityId: string; dealCategoryId?: number | null };
export type LeadPushResult = { created: { opportunityId: string; title: string; dealId: number }[]; linked: { opportunityId: string; title: string; dealId: number }[]; skipped: { opportunityId: string; title: string; reason: string }[] };

function buildInfo(c: LeadCandidate, opp: typeof schema.opportunities.$inferSelect): string {
  const lines = [
    `Aus dem Accountmeister: ${baseUrl()}/bedarfe/${opp.id}`,
    `Setup: ${c.setupTitle}`,
    `Status im Accountmeister: ${opportunityStatusLabel[opp.status] ?? opp.status}`,
    `Verantwortlich: ${c.ownerName}`,
  ];
  if (opp.headcount) lines.push(`Anzahl: ${opp.headcount}`);
  if (opp.horizon) lines.push(`Zeithorizont: ${opp.horizon}`);
  if (opp.needDescription) lines.push("", opp.needDescription);
  return lines.join("\n");
}

/** Überträgt die gewählten Chancen als Leads nach Moco (oder verknüpft bereits vorhandene). */
export async function pushLeads(actor: Actor, items: LeadPushItem[], client: MocoClient = getMocoClient()): Promise<LeadPushResult> {
  if (!canRunMocoImport(actor)) throw new ForbiddenError("Leads nach Moco übertragen CEO oder Principal.");
  const ids = [...new Set(items.map((i) => i.opportunityId).filter(Boolean))];
  if (!ids.length) throw new ValidationError("Keine Chance ausgewählt.");
  const overview = await listLeadCandidates(actor, client, ids);
  const byId = new Map(overview.candidates.map((c) => [c.opportunityId, c]));
  const result: LeadPushResult = { created: [], linked: [], skipped: [] };
  const currency = "EUR";
  for (const item of items) {
    const c = byId.get(item.opportunityId);
    if (!c) {
      result.skipped.push({ opportunityId: item.opportunityId, title: item.opportunityId, reason: "Chance ist nicht (mehr) übertragbar – bereits übertragen, beauftragt oder beendet." });
      continue;
    }
    if (!c.ready || !c.company || !c.mocoUserId) {
      result.skipped.push({ opportunityId: c.opportunityId, title: c.title, reason: c.blocker ?? "nicht bereit" });
      continue;
    }
    const opp = (await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, c.opportunityId) }))!;
    let dealId: number;
    let created = false;
    if (c.existingDeal) {
      dealId = c.existingDeal.id;
    } else {
      const categoryId = item.dealCategoryId ?? c.suggestedCategoryId;
      if (!categoryId || !overview.categories.some((k) => k.id === categoryId)) {
        result.skipped.push({ opportunityId: c.opportunityId, title: c.title, reason: "Keine gültige Lead-Phase gewählt." });
        continue;
      }
      try {
        const deal = await client.createDeal({
          name: opp.title,
          currency,
          money: 0,
          reminder_date: plusDaysIso(new Date().toISOString().slice(0, 10), 14),
          user_id: c.mocoUserId,
          deal_category_id: categoryId,
          company_id: c.company.id,
          info: buildInfo(c, opp),
          status: opp.status === "ZURUECKGESTELLT" ? "pending" : "potential",
          tags: ["Accountmeister"],
        });
        dealId = deal.id;
        created = true;
      } catch (e) {
        result.skipped.push({ opportunityId: c.opportunityId, title: c.title, reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
    }
    await db.transaction(async (tx) => {
      await tx.update(schema.opportunities).set({ mocoDealId: dealId, updatedAt: new Date() }).where(eq(schema.opportunities.id, opp.id));
      if (c.company!.source === "VORSCHLAG") {
        await tx.update(schema.accounts).set({ mocoCompanyId: c.company!.id }).where(and(eq(schema.accounts.id, c.accountId), isNull(schema.accounts.mocoCompanyId)));
        await recordAudit(tx, actor, "account.updated", "ACCOUNT", c.accountId, { mocoCompanyId: c.company!.id, quelle: "Lead-Push" });
      }
      await recordAudit(tx, actor, created ? "opportunity.moco_lead_created" : "opportunity.moco_lead_linked", "OPPORTUNITY", opp.id, { mocoDealId: dealId });
    });
    (created ? result.created : result.linked).push({ opportunityId: opp.id, title: opp.title, dealId });
  }
  return result;
}
