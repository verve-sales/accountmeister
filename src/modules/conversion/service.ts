import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, loadSetupContext } from "@/modules/identity/authz";
import { createHandover, type HandoverKind } from "./handover";

/**
 * Konvertierungsvorgang (Etappe 51): sechs Schritte von der Anfrage bis zur Beauftragung.
 *   1 Anfrage · 2 Klärung · 3 Besetzung · 4 Angebot · 5 Freelancer-Vertrag · 6 Beauftragung
 * Der Stand jedes Schritts ergibt sich aus Chance, Positionen, Unterlagen und den Zeitpunkten am Vorgang.
 * Welche Schritte gelten, bestimmen der Angebotsweg am Setup, der Beschaffungsweg des Kunden und die Besetzungsart
 * je Position. Der Vorgang endet von selbst, wenn die Chance geschlossen wird, und ruht, wenn sie zurückgestellt ist.
 */

export const offerPathValues = ["MOCO", "MOCO_KUNDENVORLAGE", "KEIN_ANGEBOT"] as const;
export type OfferPath = (typeof offerPathValues)[number];
export const offerPathLabel: Record<string, string> = { MOCO: "Angebot aus Moco", MOCO_KUNDENVORLAGE: "Moco-Angebot und Kundenvorlage", KEIN_ANGEBOT: "kein Angebot – Konditionen per Mail (Vermittler)" };

export type ConversionRow = typeof schema.conversions.$inferSelect;
export type StepState = "ERLEDIGT" | "AKTUELL" | "OFFEN" | "ENTFAELLT";
export type Step = { no: number; key: "ANFRAGE" | "KLAERUNG" | "BESETZUNG" | "ANGEBOT" | "VERTRAG" | "BEAUFTRAGUNG"; title: string; state: StepState; note: string };

export type ConversionPosition = {
  id: string;
  title: string;
  resourceKind: string;
  status: string;
  personName: string | null;
  engagementId: string | null;
  freelancerId: string | null;
  /** Stand des Freelancer-Vertrags zu diesem Einsatz */
  contractStatus: string | null;
};

export type ConversionView = {
  conversion: ConversionRow;
  opportunity: typeof schema.opportunities.$inferSelect;
  accountName: string;
  setupName: string;
  channel: string;
  offerPath: OfferPath;
  positions: ConversionPosition[];
  steps: Step[];
  canEdit: boolean;
  /** Freelancer bei einem Kunden mit Vermittler: Prüfhinweis nötig und noch nicht bestätigt */
  intermediaryCheckOpen: boolean;
  handovers: { id: string; kind: string; status: string; createdAt: Date; engagementId: string }[];
};

async function access(actor: Actor, opportunityId: string) {
  const opp = await db.query.opportunities.findFirst({ where: and(eq(schema.opportunities.id, opportunityId), eq(schema.opportunities.workspaceId, actor.workspaceId)) });
  if (!opp) throw new NotFoundError("Chance");
  const ctx = await loadSetupContext(actor, opp.setupId);
  const wide = hasRole(actor, "CEO") || actor.roles.has("SALES_OPS");
  if (!wide && (!ctx || !canViewSetup(actor, ctx))) throw new NotFoundError("Chance");
  const canEdit = wide || (!!ctx && canEditSetup(actor, ctx));
  return { opp, canEdit };
}

async function requireEditable(actor: Actor, conversionId: string) {
  const c = await db.query.conversions.findFirst({ where: and(eq(schema.conversions.id, conversionId), eq(schema.conversions.workspaceId, actor.workspaceId)) });
  if (!c) throw new NotFoundError("Vorgang");
  const a = await access(actor, c.opportunityId);
  if (!a.canEdit) throw new ForbiddenError("Den Vorgang führen BD, Principal, Sales Operations oder Geschäftsführung.");
  if (c.status !== "LAUFEND") throw new TransitionError(c.status === "RUHEND" ? "Der Vorgang ruht – erst fortsetzen." : "Der Vorgang ist beendet.");
  return { c, ...a };
}

/** Vorgang zur Chance starten (einer je Chance). */
export async function startConversion(actor: Actor, opportunityId: string) {
  const { opp, canEdit } = await access(actor, opportunityId);
  if (!canEdit) throw new ForbiddenError("Den Vorgang startet BD, Principal, Sales Operations oder Geschäftsführung.");
  if (["BEENDET", "ZURUECKGESTELLT"].includes(opp.status)) throw new TransitionError("Für eine beendete oder zurückgestellte Chance wird kein Vorgang gestartet.");
  const existing = await db.query.conversions.findFirst({ where: and(eq(schema.conversions.opportunityId, opp.id), inArray(schema.conversions.status, ["LAUFEND", "RUHEND"])) });
  if (existing) return existing;
  const [c] = await db
    .insert(schema.conversions)
    .values({ workspaceId: actor.workspaceId, opportunityId: opp.id, clarifiedAt: ["BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG", "BEAUFTRAGT"].includes(opp.status) ? new Date() : null, createdBy: actor.userId })
    .returning();
  await recordAudit(db, actor, "conversion.started", "OPPORTUNITY", opp.id, { vorgang: c!.id });
  return c!;
}

/** Vorgang an den Stand der Chance anpassen: geschlossen → abgebrochen, zurückgestellt → ruht, wieder offen → läuft. */
async function syncWithOpportunity(c: ConversionRow, oppStatus: string): Promise<ConversionRow> {
  let next: string | null = null;
  let reason: string | null = null;
  if (oppStatus === "BEENDET" && ["LAUFEND", "RUHEND"].includes(c.status) && !c.orderAt) {
    next = "ABGEBROCHEN";
    reason = "Chance geschlossen";
  } else if (oppStatus === "ZURUECKGESTELLT" && c.status === "LAUFEND") next = "RUHEND";
  else if (c.status === "RUHEND" && !["ZURUECKGESTELLT", "BEENDET"].includes(oppStatus) && c.endedReason === null) next = "LAUFEND";
  if (!next) return c;
  const [u] = await db.update(schema.conversions).set({ status: next, endedReason: reason, updatedAt: new Date() }).where(eq(schema.conversions.id, c.id)).returning();
  return u ?? c;
}

export async function getConversion(actor: Actor, opportunityId: string): Promise<ConversionView | null> {
  const { opp, canEdit } = await access(actor, opportunityId);
  const found = await db.query.conversions.findFirst({ where: eq(schema.conversions.opportunityId, opp.id), orderBy: desc(schema.conversions.createdAt) });
  if (!found) return null;
  const c = await syncWithOpportunity(found, opp.status);
  const [account, setup, positions, engs] = await Promise.all([
    db.query.accounts.findFirst({ where: eq(schema.accounts.id, opp.accountId) }),
    db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, opp.setupId) }),
    db.query.staffingPositions.findMany({ where: eq(schema.staffingPositions.opportunityId, opp.id), orderBy: asc(schema.staffingPositions.createdAt) }),
    db.query.engagements.findMany({ where: eq(schema.engagements.opportunityId, opp.id) }),
  ]);
  const live = positions.filter((p) => p.status !== "ABGEBROCHEN");
  const [fls, users, links, handovers] = await Promise.all([
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...engs.map((e) => e.freelancerId).filter((x): x is string => !!x), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: inArray(schema.users.id, [...engs.map((e) => e.internalUserId).filter((x): x is string => !!x), "-"]), columns: { id: true, displayName: true } }),
    engs.length ? db.query.engagementDocuments.findMany({ where: inArray(schema.engagementDocuments.engagementId, engs.map((e) => e.id)) }) : Promise.resolve([]),
    engs.length ? db.query.backofficeHandovers.findMany({ where: inArray(schema.backofficeHandovers.engagementId, engs.map((e) => e.id)), orderBy: desc(schema.backofficeHandovers.createdAt) }) : Promise.resolve([]),
  ]);
  const docs = links.length ? await db.query.contractDocuments.findMany({ where: and(inArray(schema.contractDocuments.id, links.map((l) => l.documentId)), eq(schema.contractDocuments.side, "FREELANCER")) }) : [];
  const rank: Record<string, number> = { ENTWURF: 1, VERSENDET: 2, UNTERSCHRIEBEN: 3 };
  const pos: ConversionPosition[] = live.map((p) => {
    const e = engs.find((x) => x.positionId === p.id) ?? null;
    const mine = e ? docs.filter((d) => links.some((l) => l.engagementId === e.id && l.documentId === d.id) && ["EINZELBEAUFTRAGUNG", "RAHMENVERTRAG"].includes(d.docType) && d.signedStatus !== "GEKUENDIGT") : [];
    const best = mine.sort((a, b) => (rank[b.signedStatus] ?? 0) - (rank[a.signedStatus] ?? 0))[0] ?? null;
    return {
      id: p.id,
      title: p.title,
      resourceKind: p.resourceKind,
      status: p.status,
      personName: e ? (e.freelancerId ? fls.find((f) => f.id === e.freelancerId)?.displayName : users.find((u) => u.id === e.internalUserId)?.displayName) ?? null : null,
      engagementId: e?.id ?? null,
      freelancerId: e?.freelancerId ?? null,
      contractStatus: best?.signedStatus ?? null,
    };
  });
  const channel = account?.procurementChannel ?? "DIREKT";
  const offerPath = ((setup?.offerPath as OfferPath) ?? "MOCO") as OfferPath;
  const hasFreelancer = pos.some((p) => p.resourceKind === "FREELANCER");
  const intermediaryCheckOpen = hasFreelancer && channel === "VERMITTLER" && !c.intermediaryCheckedAt;

  // Schritte
  const done2 = !!c.clarifiedAt;
  const done3 = pos.length > 0 && pos.every((p) => p.status === "BESETZT" && p.engagementId);
  const noOffer = offerPath === "KEIN_ANGEBOT";
  const done4 = !!c.offerSentAt && !!c.commitAt;
  const freelancerPos = pos.filter((p) => p.resourceKind === "FREELANCER");
  const skip5 = freelancerPos.length === 0;
  // Schritt 5 gilt mit „versendet“ als weiterführbar; die Unterschrift wird nachgehalten
  const done5 = !skip5 && freelancerPos.every((p) => p.contractStatus === "VERSENDET" || p.contractStatus === "UNTERSCHRIEBEN");
  const signed5 = !skip5 && freelancerPos.every((p) => p.contractStatus === "UNTERSCHRIEBEN");
  const openHandover = handovers.some((h) => h.status === "OFFEN");
  const done6 = !!c.orderAt && !!c.orderReference && handovers.length > 0 && !openHandover;
  const raw: { key: Step["key"]; title: string; done: boolean; skip?: boolean; note: string }[] = [
    { key: "ANFRAGE", title: "Anfrage", done: true, note: "Chance ist angelegt." },
    { key: "KLAERUNG", title: "Klärung", done: done2, note: done2 ? "Anforderung ist klar." : "Anforderung klären und Pflichtunterlagen des Kunden prüfen." },
    { key: "BESETZUNG", title: "Besetzung", done: done3, note: pos.length === 0 ? "Noch keine Position – an der Chance eine Position anlegen." : done3 ? "Alle Positionen sind besetzt." : `${pos.filter((p) => p.status === "BESETZT").length} von ${pos.length} Positionen besetzt.` },
    { key: "ANGEBOT", title: noOffer ? "Konditionen an den Vermittler" : "Angebot", done: done4, note: done4 ? "Abgegeben, Kunde hat zugesagt." : c.offerSentAt ? "Abgegeben – Zusage des Kunden steht aus." : noOffer ? "Profil und Konditionen per Mail an den Vermittler." : "Angebot in Moco anlegen und Nummer hier eintragen." },
    { key: "VERTRAG", title: "Freelancer-Vertrag", done: done5, skip: skip5, note: skip5 ? "Entfällt bei interner Besetzung." : signed5 ? "Unterschrieben." : done5 ? "Versendet – Unterschrift steht aus." : c.commitAt ? "Kunde hat zugesagt: Vertrag jetzt erzeugen und versenden." : "Wird fällig, sobald der Kunde zugesagt hat." },
    { key: "BEAUFTRAGUNG", title: "Beauftragung", done: done6, note: done6 ? "Bestellung liegt vor, Backoffice hat quittiert." : c.orderAt && c.orderReference ? "Bestellung liegt vor – Quittung des Backoffice steht aus." : c.provisionalStart ? "Start mit Zusage per Mail – Bestellung offen." : "Bestellnummer eintragen; die Übergabe ans Backoffice geht dann raus." },
  ];
  let currentSet = false;
  const steps: Step[] = raw.map((s, i) => {
    let state: StepState = s.skip ? "ENTFAELLT" : s.done ? "ERLEDIGT" : "OFFEN";
    if (state === "OFFEN" && !currentSet) {
      state = "AKTUELL";
      currentSet = true;
    }
    return { no: i + 1, key: s.key, title: s.title, state, note: s.note };
  });
  let conv = c;
  if (done6 && c.status === "LAUFEND") {
    const [u] = await db.update(schema.conversions).set({ status: "ABGESCHLOSSEN", updatedAt: new Date() }).where(eq(schema.conversions.id, c.id)).returning();
    conv = u ?? c;
  }
  return {
    conversion: conv,
    opportunity: opp,
    accountName: account?.name ?? "?",
    setupName: setup?.name ?? "?",
    channel,
    offerPath,
    positions: pos,
    steps,
    canEdit: canEdit && conv.status === "LAUFEND",
    intermediaryCheckOpen,
    handovers: handovers.map((h) => ({ id: h.id, kind: h.kind, status: h.status, createdAt: h.createdAt, engagementId: h.engagementId })),
  };
}

export async function markClarified(actor: Actor, conversionId: string) {
  const { c } = await requireEditable(actor, conversionId);
  await db.update(schema.conversions).set({ clarifiedAt: c.clarifiedAt ?? new Date(), updatedAt: new Date() }).where(eq(schema.conversions.id, c.id));
  await recordAudit(db, actor, "conversion.clarified", "OPPORTUNITY", c.opportunityId, {});
}

/** Prüfhinweis „Freelancer über Vermittler“ bestätigen (mit kurzer Begründung, z. B. Vertragsklausel). */
export async function confirmIntermediaryCheck(actor: Actor, conversionId: string, note: string) {
  const { c } = await requireEditable(actor, conversionId);
  if (note.trim().length < 5) throw new ValidationError("Bitte kurz festhalten, warum ein Freelancer hier zulässig ist (z. B. Rahmenvertragspartner, Klausel).");
  await db.update(schema.conversions).set({ intermediaryCheckedAt: new Date(), intermediaryCheckedBy: actor.userId, intermediaryCheckNote: note.trim().slice(0, 500), updatedAt: new Date() }).where(eq(schema.conversions.id, c.id));
  await recordAudit(db, actor, "conversion.intermediary_checked", "OPPORTUNITY", c.opportunityId, {});
}

const offerInput = z.object({
  offerNumber: z.string().trim().max(100).optional().default(""),
  offerLink: z.string().trim().max(500).optional().default(""),
  sent: z.union([z.literal("1"), z.literal("on"), z.literal(""), z.boolean()]).optional(),
  newVersion: z.union([z.literal("1"), z.literal("on"), z.literal(""), z.boolean()]).optional(),
});
const truthy = (v: unknown) => v === true || v === "1" || v === "on";

/** Angebot festhalten: Moco-Nummer (bis zur Anbindung von Hand), Link, „abgegeben“; „neue Fassung“ zählt die Fassung hoch. */
export async function saveOffer(actor: Actor, conversionId: string, raw: unknown) {
  const p = offerInput.safeParse(raw);
  if (!p.success) throw new ValidationError("Angaben zum Angebot ungültig.");
  const { c, opp } = await requireEditable(actor, conversionId);
  const setup = await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, opp.setupId), columns: { offerPath: true } });
  const noOffer = setup?.offerPath === "KEIN_ANGEBOT";
  const i = p.data;
  const sent = truthy(i.sent);
  if (sent && !noOffer && !i.offerNumber && !c.offerNumber) throw new ValidationError("Bitte die Moco-Angebotsnummer eintragen, bevor das Angebot als abgegeben gilt.");
  const version = truthy(i.newVersion) ? c.offerVersion + 1 : c.offerVersion;
  await db
    .update(schema.conversions)
    .set({ offerNumber: i.offerNumber || c.offerNumber, offerLink: i.offerLink || c.offerLink, offerVersion: version, offerSentAt: sent ? new Date() : truthy(i.newVersion) ? null : c.offerSentAt, commitAt: truthy(i.newVersion) ? null : c.commitAt, updatedAt: new Date() })
    .where(eq(schema.conversions.id, c.id));
  await recordAudit(db, actor, "conversion.offer", "OPPORTUNITY", c.opportunityId, { nummer: i.offerNumber || c.offerNumber, fassung: version, abgegeben: sent });
}

/** Zusage des Kunden festhalten (mündlich oder per Mail). Ab hier wird der Freelancer gebunden. */
export async function recordCommit(actor: Actor, conversionId: string, note: string) {
  const { c } = await requireEditable(actor, conversionId);
  if (!c.offerSentAt) throw new ValidationError("Erst das Angebot bzw. die Konditionen als abgegeben festhalten.");
  if (note.trim().length < 5) throw new ValidationError("Bitte festhalten, wer wann was zugesagt hat (Satz, Start, Umfang).");
  await db.update(schema.conversions).set({ commitAt: new Date(), commitNote: note.trim().slice(0, 1000), updatedAt: new Date() }).where(eq(schema.conversions.id, c.id));
  await recordAudit(db, actor, "conversion.commit", "OPPORTUNITY", c.opportunityId, {});
}

const orderInput = z.object({
  orderReference: z.string().trim().max(200).optional().default(""),
  orderLink: z.string().trim().max(500).optional().default(""),
  provisional: z.union([z.literal("1"), z.literal("on"), z.literal(""), z.boolean()]).optional(),
  evidence: z.string().trim().max(1000).optional().default(""),
});

/**
 * Beauftragung festhalten und die Übergabe ans Backoffice auslösen – je Einsatz der Chance eine.
 *  - mit Bestellnummer: „beauftragt“ (oder „Bestellung nachgereicht“, wenn vorher vorläufig gestartet wurde)
 *  - ohne Bestellnummer, mit vereinbarter Zusage per Mail: „vorläufig beauftragt“, Vermerk „Bestellung offen“
 */
export async function recordOrder(actor: Actor, conversionId: string, raw: unknown) {
  const p = orderInput.safeParse(raw);
  if (!p.success) throw new ValidationError("Angaben zur Beauftragung ungültig.");
  const { c, opp } = await requireEditable(actor, conversionId);
  const i = p.data;
  const provisional = truthy(i.provisional) && !i.orderReference;
  if (!i.orderReference && !provisional) throw new ValidationError("Bitte die Bestellnummer eintragen – oder „Start mit Zusage per Mail“ wählen.");
  if (provisional && i.evidence.length < 5) throw new ValidationError("Für den Start ohne Bestellung bitte die Zusage-Mail festhalten (wer, wann, was).");
  if (!c.commitAt) throw new ValidationError("Erst die Zusage des Kunden festhalten.");
  const engs = await db.query.engagements.findMany({ where: and(eq(schema.engagements.opportunityId, opp.id), inArray(schema.engagements.status, ["VORBEREITUNG", "GEPLANT", "AKTIV", "PAUSIERT"])) });
  if (!engs.length) throw new ValidationError("Es gibt noch keinen Einsatz zu dieser Chance – erst die Position besetzen.");
  const kind: HandoverKind = provisional ? "VORLAEUFIG" : c.provisionalStart && !c.orderAt ? "BESTELLUNG_NACHGEREICHT" : "BEAUFTRAGT";
  await db.transaction(async (tx) => {
    await tx
      .update(schema.conversions)
      .set({ orderReference: i.orderReference || null, orderLink: i.orderLink || c.orderLink, orderAt: provisional ? null : new Date(), provisionalStart: provisional ? true : c.provisionalStart, commitNote: provisional ? `${c.commitNote ?? ""}\nStart mit Zusage per Mail: ${i.evidence}`.trim().slice(0, 1000) : c.commitNote, updatedAt: new Date() })
      .where(eq(schema.conversions.id, c.id));
    // Auftrag der Chance führen (Bestellnummer, bestätigt), damit Startseite und Health-Check denselben Stand zeigen
    let order = await tx.query.orders.findFirst({ where: and(eq(schema.orders.opportunityId, opp.id), inArray(schema.orders.status, ["IN_VORBEREITUNG", "NACHWEISE_UNVOLLSTAENDIG", "BEAUFTRAGUNG_BESTAETIGT"])), orderBy: desc(schema.orders.createdAt) });
    const first = engs[0]!;
    if (!order) {
      [order] = await tx
        .insert(schema.orders)
        .values({ workspaceId: actor.workspaceId, opportunityId: opp.id, orderReference: i.orderReference || null, evidenceNote: provisional ? `Zusage per Mail: ${i.evidence}` : "Bestellung im Konvertierungsvorgang erfasst", plannedStart: first.plannedStart, plannedEnd: first.plannedEnd, status: provisional ? "NACHWEISE_UNVOLLSTAENDIG" : "BEAUFTRAGUNG_BESTAETIGT", confirmedAt: provisional ? null : new Date(), confirmedBy: provisional ? null : actor.userId, contractLink: i.orderLink || null, createdBy: actor.userId })
        .returning();
    } else if (!provisional) {
      await tx.update(schema.orders).set({ orderReference: i.orderReference, status: "BEAUFTRAGUNG_BESTAETIGT", confirmedAt: order.confirmedAt ?? new Date(), confirmedBy: order.confirmedBy ?? actor.userId, contractLink: i.orderLink || order.contractLink, updatedAt: new Date() }).where(eq(schema.orders.id, order.id));
    }
    for (const e of engs) if (!e.orderId) await tx.update(schema.engagements).set({ orderId: order!.id, updatedAt: new Date() }).where(eq(schema.engagements.id, e.id));
    if (opp.status !== "BEAUFTRAGT") {
      await tx.update(schema.opportunities).set({ status: "BEAUFTRAGT", version: opp.version + 1, updatedAt: new Date() }).where(eq(schema.opportunities.id, opp.id));
      await recordAudit(tx, actor, "opportunity.status_changed", "OPPORTUNITY", opp.id, { von: opp.status, nach: "BEAUFTRAGT", ueber: "Konvertierungsvorgang" });
    }
    await recordAudit(tx, actor, "conversion.order", "OPPORTUNITY", opp.id, { bestellnummer: i.orderReference || null, vorlaeufig: provisional });
  });
  const created: string[] = [];
  for (const e of engs) created.push((await createHandover(actor, e.id, kind, { conversionId: c.id })).id);
  return { kind, handoverIds: created };
}

/** Vorgang abbrechen (jederzeit) – mit Grund. Die Chance bleibt, wie sie ist. */
export async function cancelConversion(actor: Actor, conversionId: string, reason: string) {
  const c = await db.query.conversions.findFirst({ where: and(eq(schema.conversions.id, conversionId), eq(schema.conversions.workspaceId, actor.workspaceId)) });
  if (!c) throw new NotFoundError("Vorgang");
  const a = await access(actor, c.opportunityId);
  if (!a.canEdit) throw new ForbiddenError("Den Vorgang bricht BD, Principal, Sales Operations oder Geschäftsführung ab.");
  if (!["LAUFEND", "RUHEND"].includes(c.status)) throw new TransitionError("Der Vorgang ist bereits beendet.");
  if (reason.trim().length < 3) throw new ValidationError("Bitte den Grund für den Abbruch festhalten.");
  const [u] = await db.update(schema.conversions).set({ status: "ABGEBROCHEN", endedReason: reason.trim().slice(0, 500), updatedAt: new Date(), version: c.version + 1 }).where(and(eq(schema.conversions.id, c.id), eq(schema.conversions.version, c.version))).returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "conversion.cancelled", "OPPORTUNITY", c.opportunityId, { grund: reason.trim().slice(0, 200) });
  return u;
}

/** Laufende Vorgänge, die der Akteur führen darf – für Start und Sales-Ops-Sicht. */
export async function listRunningConversions(actor: Actor) {
  const rows = await db.query.conversions.findMany({ where: and(eq(schema.conversions.workspaceId, actor.workspaceId), eq(schema.conversions.status, "LAUFEND")), orderBy: desc(schema.conversions.updatedAt), limit: 200 });
  const out: { id: string; opportunityId: string; title: string; accountName: string; step: string; stepNote: string }[] = [];
  for (const r of rows) {
    const v = await getConversion(actor, r.opportunityId).catch(() => null);
    if (!v || v.conversion.status !== "LAUFEND") continue;
    const cur = v.steps.find((s) => s.state === "AKTUELL");
    out.push({ id: r.id, opportunityId: r.opportunityId, title: v.opportunity.title, accountName: v.accountName, step: cur ? `${cur.no} ${cur.title}` : "–", stepNote: cur?.note ?? "" });
  }
  return out;
}

/** Angebotsweg am Setup pflegen: wer das Setup bearbeiten darf, Sales Operations, Geschäftsführung. */
export async function setSetupOfferPath(actor: Actor, setupId: string, value: string) {
  if (!(offerPathValues as readonly string[]).includes(value)) throw new ValidationError("Unbekannter Angebotsweg.");
  const ctx = await loadSetupContext(actor, setupId);
  const wide = hasRole(actor, "CEO") || actor.roles.has("SALES_OPS");
  if (!ctx && !wide) throw new NotFoundError("Setup");
  if (!wide && !(ctx && canEditSetup(actor, ctx))) throw new ForbiddenError("Den Angebotsweg pflegt, wer das Setup bearbeiten darf, Sales Operations oder die Geschäftsführung.");
  const [u] = await db.update(schema.projectSetups).set({ offerPath: value, updatedAt: new Date() }).where(and(eq(schema.projectSetups.id, setupId), eq(schema.projectSetups.workspaceId, actor.workspaceId))).returning({ id: schema.projectSetups.id });
  if (!u) throw new NotFoundError("Setup");
  await recordAudit(db, actor, "setup.offer_path", "SETUP", setupId, { angebotsweg: value });
}
