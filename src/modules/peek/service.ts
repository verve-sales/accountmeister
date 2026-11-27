import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { NotFoundError } from "@/lib/errors";
import { opportunityStatusLabel } from "@/lib/labels";
import type { Actor } from "@/modules/identity/actor";

/**
 * e78: Kurzansicht (Seitenblatt) für Chance, Einsatz und Kunde – aus Board, Zeitleiste und Listen. Nur lesend und über
 * dieselben rechtegeprüften Abfragen wie die vollen Seiten; keine Einkaufssätze.
 */
export type Peek = { kind: string; title: string; subtitle: string | null; status: string | null; tone: "ok" | "warn" | "bad" | null; facts: [string, string][]; next: string | null; href: string; links: { label: string; href: string }[] };

const de = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join(".") : "–");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function peek(actor: Actor, type: string, id: string): Promise<Peek> {
  if (!UUID.test(id)) throw new NotFoundError("Eintrag");
  if (type === "bedarfe") {
    const { getOpportunityDetail } = await import("@/modules/opportunities/service");
    const d = await getOpportunityDetail(actor, id);
    const o = d.opp;
    const [positions, engs] = await Promise.all([
      db.query.staffingPositions.findMany({ where: eq(schema.staffingPositions.opportunityId, id), columns: { id: true, title: true, status: true, vkMin: true, vkMax: true, rateUnit: true, desiredStart: true, plannedEnd: true } }),
      db.query.engagements.findMany({ where: and(eq(schema.engagements.opportunityId, id), inArray(schema.engagements.status, ["GEPLANT", "AKTIV", "PAUSIERT", "ENDET"])), columns: { id: true, title: true, plannedEnd: true } }),
    ]);
    const openActions = d.linked.actions.filter((a) => a.status !== "ERLEDIGT" && a.status !== "VERWORFEN").sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
    const days = Math.max(0, Math.floor((Date.now() - o.updatedAt.getTime()) / 86400000));
    const pos = positions.find((p) => p.status !== "ABGEBROCHEN");
    const rate = pos?.vkMax ?? pos?.vkMin;
    return {
      kind: "Chance",
      title: o.title,
      subtitle: `${d.ctx.account.name} · ${d.ctx.setup.name}`,
      status: opportunityStatusLabel[o.status] ?? o.status,
      tone: o.status === "BEAUFTRAGT" ? "ok" : days >= 30 ? "bad" : days >= 14 ? "warn" : null,
      facts: [
        ["Verantwortlich", d.userNames.get(o.ownerUserId) ?? "?"],
        ["In dieser Stufe seit", `${days} ${days === 1 ? "Tag" : "Tagen"}`],
        ...(rate ? ([["Verkaufssatz", `${Number(rate)} € je ${pos!.rateUnit === "STUNDE" ? "Stunde" : "Tag"}`]] as [string, string][]) : []),
        ...(pos?.desiredStart ? ([["Zeitraum", `${de(pos.desiredStart)} – ${de(pos.plannedEnd)}`]] as [string, string][]) : []),
        ["Angebote", String(d.offers.length)],
        ["Buying Center", `${d.participations.length} ${d.participations.length === 1 ? "Person" : "Personen"}`],
        ...(engs.length ? ([["Einsatz", `läuft${engs[0]!.plannedEnd ? ` bis ${de(engs[0]!.plannedEnd)}` : ""}`]] as [string, string][]) : []),
      ],
      next: openActions[0] ? `${openActions[0].title}${openActions[0].dueDate ? ` (fällig ${de(openActions[0].dueDate)})` : ""}` : engs.length && o.status !== "BEAUFTRAGT" ? "Einsatz läuft bereits – Stufe nachziehen." : "Kein nächster Schritt geplant.",
      href: `/bedarfe/${id}`,
      links: [{ label: "Kunde", href: `/kunden/${d.ctx.account.id}` }, { label: "Projekt", href: `/setups/${d.ctx.setup.id}` }, ...engs.slice(0, 1).map((e) => ({ label: "Einsatz", href: `/einsaetze/${e.id}` }))],
    };
  }
  if (type === "einsaetze") {
    const { getEngagementDetail, engagementStatusLabel } = await import("@/modules/engagements/service");
    const { renewalStatusLabel } = await import("@/modules/engagements/care");
    const d = await getEngagementDetail(actor, id);
    const e = d.view;
    const ren = d.renewals.find((r) => ["ZU_KLAEREN", "MOEGLICH", "IN_ABSTIMMUNG", "ANGEBOTEN"].includes(r.status));
    const soon = e.daysToEnd !== null && e.daysToEnd <= 30 && e.status === "AKTIV";
    return {
      kind: "Einsatz",
      title: `${e.personName} bei ${e.accountName}`,
      subtitle: e.title,
      status: engagementStatusLabel[e.status] ?? e.status,
      tone: e.checkinOverdue || soon ? "bad" : e.status === "AKTIV" ? "ok" : null,
      facts: [
        ["Laufzeit", `${de(e.actualStart ?? e.plannedStart)} – ${e.plannedEnd ? `${de(e.plannedEnd)}${e.daysToEnd !== null ? ` (${e.daysToEnd} Tage)` : ""}` : "offen"}`],
        ["BD", e.bdName],
        ["Betreuung", e.careNames.length ? e.careNames.join(", ") : "offen"],
        ["Bestellnummer", e.orderReference ?? "fehlt"],
        ["Verlängerung", ren ? `${renewalStatusLabel[ren.status] ?? ren.status}${ren.proposedTo ? ` bis ${de(ren.proposedTo)}` : ""}` : "–"],
        ["Nächster Check-in", e.nextCheckin ? `${de(e.nextCheckin)}${e.checkinOverdue ? " (überfällig)" : ""}` : "–"],
      ],
      next: e.checkinOverdue ? "Check-in ist überfällig." : ren?.status === "ZU_KLAEREN" ? "Verlängerung klären." : soon ? `Endet in ${e.daysToEnd} Tagen.` : null,
      href: `/einsaetze/${id}`,
      links: [{ label: "Kunde", href: `/kunden/${e.accountId}` }, { label: "Verlängerung", href: `/einsaetze/${id}#verlaengerung` }],
    };
  }
  if (type === "kunden") {
    const { getAccount } = await import("@/modules/accounts/service");
    const a = await getAccount(actor, id);
    const [opps, engs, bd, snap] = await Promise.all([
      db.query.opportunities.findMany({ where: and(eq(schema.opportunities.accountId, id), inArray(schema.opportunities.status, ["ANTIZIPIERT", "IN_KLAERUNG", "BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG"])), columns: { id: true } }),
      db.query.engagements.findMany({ where: and(eq(schema.engagements.accountId, id), inArray(schema.engagements.status, ["GEPLANT", "AKTIV", "PAUSIERT", "ENDET"])), columns: { id: true, plannedEnd: true } }),
      a.responsibleBdUserId ? db.query.users.findFirst({ where: eq(schema.users.id, a.responsibleBdUserId), columns: { displayName: true } }) : null,
      db.query.accountHealthSnapshots.findFirst({ where: eq(schema.accountHealthSnapshots.accountId, id), orderBy: (h, { desc }) => [desc(h.createdAt)] }),
    ]);
    const nextEnd = engs.map((e) => e.plannedEnd).filter((x): x is string => !!x).sort()[0] ?? null;
    return {
      kind: "Kunde",
      title: a.name,
      subtitle: a.accountKind === "VERMITTLER" ? "Vermittler" : null,
      status: snap?.score != null ? `Health ${snap.score}` : null,
      tone: snap?.score == null ? null : snap.score < 45 ? "bad" : snap.score < 65 ? "warn" : "ok",
      facts: [
        ["Verantwortlicher BD", bd?.displayName ?? "offen"],
        ["Laufende Einsätze", String(engs.length)],
        ["Nächstes Einsatzende", de(nextEnd)],
        ["Offene Chancen", String(opps.length)],
        ...(snap ? ([["Health-Check", `${snap.score ?? "kein Score"} · Datenlage ${snap.coverage} %`]] as [string, string][]) : []),
      ],
      next: !a.responsibleBdUserId ? "Noch kein BD zugeordnet." : null,
      href: `/kunden/${id}`,
      links: [{ label: "Health-Check", href: `/kunden/${id}/health` }, { label: "Chancen", href: `/chancen?kunde=${id}` }],
    };
  }
  throw new NotFoundError("Eintrag");
}
