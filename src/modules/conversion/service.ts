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
 * der Position. Seit e43 läuft je Position ein eigener Vorgang. Der Vorgang endet von selbst, wenn die Chance geschlossen wird, und ruht, wenn sie zurückgestellt ist.
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
  /** die Position dieses Vorgangs (leer, solange die Chance noch keine hat) */
  position: ConversionPosition | null;
  positions: ConversionPosition[];
  /** „Rolle – Person“ zur Unterscheidung der Vorgänge einer Chance */
  label: string;
  /** Angebotsnummer aus einem Parallel-Vorgang derselben Chance, als Vorschlag */
  siblingOffer: { number: string; label: string } | null;
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

type OppRow = typeof schema.opportunities.$inferSelect;
const RUNNING = ["LAUFEND", "RUHEND"];
const IN_USE = ["LAUFEND", "RUHEND", "ABGESCHLOSSEN"];

/**
 * Ein Vorgang je Position (e43): Besetzung, Freelancer-Vertrag, Bestellung und Übergabe gehören zu einer Person.
 * Anfrage und Klärung kommen von der Chance und werden an neue Vorgänge vererbt. Solange die Chance noch keine
 * Position hat, läuft ein Vorgang ohne Position; er geht auf die erste Position über. Sobald eine Chance mit dem
 * Vorgang geführt wird, bekommt jede weitere Position ihren eigenen. Bricht eine Position ab, endet ihr Vorgang.
 */
async function ensureConversions(opp: OppRow): Promise<ConversionRow[]> {
  const load = () => db.query.conversions.findMany({ where: eq(schema.conversions.opportunityId, opp.id), orderBy: asc(schema.conversions.createdAt) });
  let rows = await load();
  if (!rows.length) return rows;
  const positions = await db.query.staffingPositions.findMany({ where: eq(schema.staffingPositions.opportunityId, opp.id), orderBy: asc(schema.staffingPositions.createdAt), columns: { id: true, status: true } });
  let changed = false;
  for (const r of rows) {
    if (!r.positionId || !RUNNING.includes(r.status) || r.orderAt) continue;
    if (positions.find((p) => p.id === r.positionId)?.status === "ABGEBROCHEN") {
      await db.update(schema.conversions).set({ status: "ABGEBROCHEN", endedReason: "Position abgebrochen", updatedAt: new Date() }).where(eq(schema.conversions.id, r.id));
      changed = true;
    }
  }
  const inUse = rows.filter((r) => IN_USE.includes(r.status));
  if (inUse.length) {
    const taken = new Set(rows.map((r) => r.positionId).filter(Boolean));
    const free = positions.filter((p) => p.status !== "ABGEBROCHEN" && !taken.has(p.id));
    const open = rows.find((r) => !r.positionId && RUNNING.includes(r.status));
    if (open && free.length) {
      await db.update(schema.conversions).set({ positionId: free.shift()!.id, updatedAt: new Date() }).where(eq(schema.conversions.id, open.id));
      changed = true;
    }
    if (free.length && !["BEENDET", "ZURUECKGESTELLT"].includes(opp.status)) {
      const t = open ?? inUse[inUse.length - 1]!;
      await db
        .insert(schema.conversions)
        .values(free.map((p) => ({ workspaceId: opp.workspaceId, opportunityId: opp.id, positionId: p.id, clarifiedAt: t.clarifiedAt, intermediaryCheckedAt: t.intermediaryCheckedAt, intermediaryCheckedBy: t.intermediaryCheckedBy, intermediaryCheckNote: t.intermediaryCheckNote, createdBy: t.createdBy })))
        .onConflictDoNothing();
      changed = true;
    }
  }
  if (changed) rows = await load();
  return rows;
}

/**
 * Vorgang starten: je Position der Chance einer; ohne Position zunächst ein Vorgang, der auf die erste Position übergeht.
 * Mit positionId wird nur der Vorgang dieser Position (wieder) gestartet, z. B. nach einem Abbruch.
 */
export async function startConversion(actor: Actor, opportunityId: string, positionId?: string) {
  const { opp, canEdit } = await access(actor, opportunityId);
  if (!canEdit) throw new ForbiddenError("Den Vorgang startet BD, Principal, Sales Operations oder Geschäftsführung.");
  if (["BEENDET", "ZURUECKGESTELLT"].includes(opp.status)) throw new TransitionError("Für eine beendete oder zurückgestellte Chance wird kein Vorgang gestartet.");
  const rows = await ensureConversions(opp);
  const running = rows.filter((r) => RUNNING.includes(r.status));
  const positions = (await db.query.staffingPositions.findMany({ where: eq(schema.staffingPositions.opportunityId, opp.id), orderBy: asc(schema.staffingPositions.createdAt), columns: { id: true, status: true } })).filter((p) => p.status !== "ABGEBROCHEN");
  if (positionId && !positions.some((p) => p.id === positionId)) throw new ValidationError("Diese Position gehört nicht zur Chance oder ist abgebrochen.");
  if (positionId) {
    const mine = running.find((r) => r.positionId === positionId);
    if (mine) return mine;
  } else if (running.length) return running[0]!;
  const clarifiedAt = ["BESTAETIGT", "PROFIL_ANGEBOT_VORGESTELLT", "AUSWAHL_BESTELLUNG", "BEAUFTRAGT"].includes(opp.status) ? new Date() : null;
  const done = new Set(rows.filter((r) => IN_USE.includes(r.status)).map((r) => r.positionId));
  const targets: (string | null)[] = positionId ? [positionId] : positions.length ? positions.filter((p) => !done.has(p.id)).map((p) => p.id) : [null];
  if (!targets.length) throw new TransitionError("Alle Positionen dieser Chance sind bereits beauftragt und übergeben.");
  const created = await db
    .insert(schema.conversions)
    .values(targets.map((pid) => ({ workspaceId: actor.workspaceId, opportunityId: opp.id, positionId: pid, clarifiedAt, createdBy: actor.userId })))
    .returning();
  await recordAudit(db, actor, "conversion.started", "OPPORTUNITY", opp.id, { vorgaenge: created.length });
  return created[0]!;
}

/** Vorgang an den Stand der Chance anpassen: geschlossen → abgebrochen, zurückgestellt → ruht, wieder offen → läuft. */
async function syncWithOpportunity(c: ConversionRow, oppStatus: string): Promise<ConversionRow> {
  let next: string | null = null;
  let reason: string | null = null;
  if (oppStatus === "BEENDET" && RUNNING.includes(c.status) && !c.orderAt) {
    next = "ABGEBROCHEN";
    reason = "Chance geschlossen";
  } else if (oppStatus === "ZURUECKGESTELLT" && c.status === "LAUFEND") next = "RUHEND";
  else if (c.status === "RUHEND" && !["ZURUECKGESTELLT", "BEENDET"].includes(oppStatus) && c.endedReason === null) next = "LAUFEND";
  if (!next) return c;
  const [u] = await db.update(schema.conversions).set({ status: next, endedReason: reason, updatedAt: new Date() }).where(eq(schema.conversions.id, c.id)).returning();
  return u ?? c;
}

/** Alle Vorgänge einer Chance, in der Reihenfolge der Positionen; abgebrochene nur, wenn die Position keinen neueren hat. */
export async function listConversions(actor: Actor, opportunityId: string): Promise<ConversionView[]> {
  const { opp, canEdit } = await access(actor, opportunityId);
  const all = await ensureConversions(opp);
  if (!all.length) return [];
  const [account, setup, positions, engs] = await Promise.all([
    db.query.accounts.findFirst({ where: eq(schema.accounts.id, opp.accountId) }),
    db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, opp.setupId) }),
    db.query.staffingPositions.findMany({ where: eq(schema.staffingPositions.opportunityId, opp.id), orderBy: asc(schema.staffingPositions.createdAt) }),
    db.query.engagements.findMany({ where: eq(schema.engagements.opportunityId, opp.id) }),
  ]);
  const [fls, users, links, handovers] = await Promise.all([
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...engs.map((e) => e.freelancerId).filter((x): x is string => !!x), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: inArray(schema.users.id, [...engs.map((e) => e.internalUserId).filter((x): x is string => !!x), "-"]), columns: { id: true, displayName: true } }),
    engs.length ? db.query.engagementDocuments.findMany({ where: inArray(schema.engagementDocuments.engagementId, engs.map((e) => e.id)) }) : Promise.resolve([]),
    engs.length ? db.query.backofficeHandovers.findMany({ where: inArray(schema.backofficeHandovers.engagementId, engs.map((e) => e.id)), orderBy: desc(schema.backofficeHandovers.createdAt) }) : Promise.resolve([]),
  ]);
  const docs = links.length ? await db.query.contractDocuments.findMany({ where: and(inArray(schema.contractDocuments.id, links.map((l) => l.documentId)), eq(schema.contractDocuments.side, "FREELANCER")) }) : [];
  const rank: Record<string, number> = { ENTWURF: 1, VERSENDET: 2, UNTERSCHRIEBEN: 3 };
  const channel = account?.procurementChannel ?? "DIREKT";
  const offerPath = ((setup?.offerPath as OfferPath) ?? "MOCO") as OfferPath;
  const noOffer = offerPath === "KEIN_ANGEBOT";
  // je Position der jüngste Vorgang; Vorgänge ohne Position hinten
  const latest = new Map<string, ConversionRow>();
  for (const r of all) latest.set(r.positionId ?? `ohne:${r.id}`, r);
  const order = (r: ConversionRow) => (r.positionId ? positions.findIndex((p) => p.id === r.positionId) : 9999);
  const chosen = [...latest.values()].sort((x, y) => order(x) - order(y));
  const out: ConversionView[] = [];
  for (const row of chosen) {
    const c = await syncWithOpportunity(row, opp.status);
    const p = c.positionId ? positions.find((x) => x.id === c.positionId) ?? null : null;
    // e47: entfernte (abgebrochene) Positionen verschwinden aus der Liste
    if (p?.status === "ABGEBROCHEN") continue;
    const e = p ? engs.find((x) => x.positionId === p.id) ?? null : null;
    const mine = e ? docs.filter((d) => links.some((l) => l.engagementId === e.id && l.documentId === d.id) && ["EINZELBEAUFTRAGUNG", "RAHMENVERTRAG"].includes(d.docType) && d.signedStatus !== "GEKUENDIGT") : [];
    const best = mine.sort((a, b) => (rank[b.signedStatus] ?? 0) - (rank[a.signedStatus] ?? 0))[0] ?? null;
    const position: ConversionPosition | null = p
      ? {
          id: p.id,
          title: p.title,
          resourceKind: p.resourceKind,
          status: p.status,
          personName: e ? (e.freelancerId ? fls.find((f) => f.id === e.freelancerId)?.displayName : users.find((u) => u.id === e.internalUserId)?.displayName) ?? null : null,
          engagementId: e?.id ?? null,
          freelancerId: e?.freelancerId ?? null,
          contractStatus: best?.signedStatus ?? null,
        }
      : null;
    const own = e ? handovers.filter((h) => h.engagementId === e.id) : [];
    const isFreelancer = position?.resourceKind === "FREELANCER";
    const intermediaryCheckOpen = isFreelancer && channel === "VERMITTLER" && !c.intermediaryCheckedAt;

    const done2 = !!c.clarifiedAt;
    const done3 = !!position && position.status === "BESETZT" && !!position.engagementId;
    const done4 = !!c.offerSentAt && !!c.commitAt;
    const skip5 = !isFreelancer;
    // Schritt 5 gilt mit „versendet“ als weiterführbar; die Unterschrift wird nachgehalten
    const signed5 = isFreelancer && position?.contractStatus === "UNTERSCHRIEBEN";
    const done5 = isFreelancer && (position?.contractStatus === "VERSENDET" || signed5);
    const done6 = !!c.orderAt && !!c.orderReference && own.length > 0 && !own.some((h) => h.status === "OFFEN");
    const raw: { key: Step["key"]; title: string; done: boolean; skip?: boolean; note: string }[] = [
      { key: "ANFRAGE", title: "Anfrage", done: true, note: "Chance ist angelegt." },
      { key: "KLAERUNG", title: "Klärung", done: done2, note: done2 ? "Anforderung ist klar." : "Anforderung klären und Pflichtunterlagen des Kunden prüfen." },
      { key: "BESETZUNG", title: "Besetzung", done: done3, note: !position ? "Noch keine Position – an der Chance eine Position anlegen." : done3 ? `Besetzt mit ${position.personName ?? "?"}.` : "Noch nicht besetzt – Kandidaten prüfen, vorstellen, auswählen." },
      { key: "ANGEBOT", title: noOffer ? "Konditionen an den Vermittler" : "Angebot", done: done4, note: done4 ? "Abgegeben, Kunde hat zugesagt." : c.offerSentAt ? "Abgegeben – Zusage des Kunden steht aus." : noOffer ? "Profil und Konditionen per Mail an den Vermittler." : "Angebot in Moco anlegen und Nummer hier eintragen." },
      { key: "VERTRAG", title: "Freelancer-Vertrag", done: done5, skip: skip5, note: !position ? "Ergibt sich aus der Besetzung." : skip5 ? "Entfällt bei interner Besetzung." : signed5 ? "Unterschrieben." : done5 ? "Versendet – Unterschrift steht aus." : c.commitAt ? "Kunde hat zugesagt: Vertrag jetzt erzeugen und versenden." : "Wird fällig, sobald der Kunde zugesagt hat." },
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
    out.push({
      conversion: conv,
      opportunity: opp,
      accountName: account?.name ?? "?",
      setupName: setup?.name ?? "?",
      channel,
      offerPath,
      position,
      positions: position ? [position] : [],
      label: position ? `${position.title}${position.personName ? ` – ${position.personName}` : " – noch offen"}` : "Position noch nicht angelegt",
      siblingOffer: null,
      steps,
      canEdit: canEdit && conv.status === "LAUFEND",
      intermediaryCheckOpen,
      handovers: own.map((h) => ({ id: h.id, kind: h.kind, status: h.status, createdAt: h.createdAt, engagementId: h.engagementId })),
    });
  }
  // Angebotsnummer eines Parallel-Vorgangs als Vorschlag (ein Angebot kann mehrere Personen abdecken)
  for (const v of out) {
    if (v.conversion.offerNumber) continue;
    const sib = out.find((x) => x !== v && x.conversion.offerNumber && x.conversion.status !== "ABGEBROCHEN");
    if (sib) v.siblingOffer = { number: sib.conversion.offerNumber!, label: sib.label };
  }
  return out;
}

/** Ein Vorgang der Chance: der genannte, sonst der erste laufende, sonst der erste. */
export async function getConversion(actor: Actor, opportunityId: string, conversionId?: string): Promise<ConversionView | null> {
  const all = await listConversions(actor, opportunityId);
  if (conversionId) return all.find((v) => v.conversion.id === conversionId) ?? null;
  return all.find((v) => v.conversion.status === "LAUFEND") ?? all[0] ?? null;
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
  /** Auswahl aus SharePoint (e47) – gilt, wenn kein Link eingetragen ist */
  offerLinkPick: z.string().trim().max(500).optional().default(""),
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
  const i = { ...p.data, offerLink: p.data.offerLink || p.data.offerLinkPick };
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
  orderLinkPick: z.string().trim().max(500).optional().default(""),
  provisional: z.union([z.literal("1"), z.literal("on"), z.literal(""), z.boolean()]).optional(),
  evidence: z.string().trim().max(1000).optional().default(""),
});

/**
 * Beauftragung festhalten und die Übergabe ans Backoffice auslösen – für den Einsatz dieser Position.
 *  - mit Bestellnummer: „beauftragt“ (oder „Bestellung nachgereicht“, wenn vorher vorläufig gestartet wurde)
 *  - ohne Bestellnummer, mit vereinbarter Zusage per Mail: „vorläufig beauftragt“, Vermerk „Bestellung offen“
 */
export async function recordOrder(actor: Actor, conversionId: string, raw: unknown) {
  const p = orderInput.safeParse(raw);
  if (!p.success) throw new ValidationError("Angaben zur Beauftragung ungültig.");
  const { c, opp } = await requireEditable(actor, conversionId);
  const i = { ...p.data, orderLink: p.data.orderLink || p.data.orderLinkPick };
  const provisional = truthy(i.provisional) && !i.orderReference;
  if (!i.orderReference && !provisional) throw new ValidationError("Bitte die Bestellnummer eintragen – oder „Start mit Zusage per Mail“ wählen.");
  if (provisional && i.evidence.length < 5) throw new ValidationError("Für den Start ohne Bestellung bitte die Zusage-Mail festhalten (wer, wann, was).");
  if (!c.commitAt) throw new ValidationError("Erst die Zusage des Kunden festhalten.");
  if (!c.positionId) throw new ValidationError("Zu diesem Vorgang gibt es noch keine Position – erst an der Chance die Position anlegen und besetzen.");
  const engs = await db.query.engagements.findMany({ where: and(eq(schema.engagements.positionId, c.positionId), inArray(schema.engagements.status, ["VORBEREITUNG", "GEPLANT", "AKTIV", "PAUSIERT"])) });
  if (!engs.length) throw new ValidationError("Zu dieser Position gibt es noch keinen Einsatz – erst die Position besetzen.");
  const kind: HandoverKind = provisional ? "VORLAEUFIG" : c.provisionalStart && !c.orderAt ? "BESTELLUNG_NACHGEREICHT" : "BEAUFTRAGT";
  await db.transaction(async (tx) => {
    await tx
      .update(schema.conversions)
      .set({ orderReference: i.orderReference || null, orderLink: i.orderLink || c.orderLink, orderAt: provisional ? null : new Date(), provisionalStart: provisional ? true : c.provisionalStart, commitNote: provisional ? `${c.commitNote ?? ""}\nStart mit Zusage per Mail: ${i.evidence}`.trim().slice(0, 1000) : c.commitNote, updatedAt: new Date() })
      .where(eq(schema.conversions.id, c.id));
    // Auftrag führen (Bestellnummer, bestätigt), damit Startseite und Health-Check denselben Stand zeigen: der Auftrag des
    // Einsatzes, sonst ein Auftrag der Chance mit derselben Bestellnummer (eine Bestellung für mehrere Personen), sonst neu
    const first = engs[0]!;
    const active = ["IN_VORBEREITUNG", "NACHWEISE_UNVOLLSTAENDIG", "BEAUFTRAGUNG_BESTAETIGT"] as const;
    let order = first.orderId ? await tx.query.orders.findFirst({ where: and(eq(schema.orders.id, first.orderId), inArray(schema.orders.status, active)) }) : undefined;
    if (!order && i.orderReference) order = await tx.query.orders.findFirst({ where: and(eq(schema.orders.opportunityId, opp.id), eq(schema.orders.orderReference, i.orderReference), inArray(schema.orders.status, active)) });
    if (!order) {
      [order] = await tx
        .insert(schema.orders)
        .values({ workspaceId: actor.workspaceId, opportunityId: opp.id, orderReference: i.orderReference || null, evidenceNote: provisional ? `Zusage per Mail: ${i.evidence}` : "Bestellung im Konvertierungsvorgang erfasst", plannedStart: first.plannedStart, plannedEnd: first.plannedEnd, status: provisional ? "NACHWEISE_UNVOLLSTAENDIG" : "BEAUFTRAGUNG_BESTAETIGT", confirmedAt: provisional ? null : new Date(), confirmedBy: provisional ? null : actor.userId, contractLink: i.orderLink || null, createdBy: actor.userId })
        .returning();
    } else if (!provisional) {
      await tx.update(schema.orders).set({ orderReference: i.orderReference, status: "BEAUFTRAGUNG_BESTAETIGT", confirmedAt: order.confirmedAt ?? new Date(), confirmedBy: order.confirmedBy ?? actor.userId, contractLink: i.orderLink || order.contractLink, updatedAt: new Date() }).where(eq(schema.orders.id, order.id));
    }
    for (const e of engs) await tx.update(schema.engagements).set({ orderId: e.orderId ?? order!.id, orderReference: i.orderReference || e.orderReference, updatedAt: new Date() }).where(eq(schema.engagements.id, e.id));
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
  const [u] = await db.update(schema.conversions).set({ status: "ABGEBROCHEN", endedReason: reason.trim().slice(0, 500) || "ohne Angabe", updatedAt: new Date(), version: c.version + 1 }).where(and(eq(schema.conversions.id, c.id), eq(schema.conversions.version, c.version))).returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "conversion.cancelled", "OPPORTUNITY", c.opportunityId, { grund: reason.trim().slice(0, 200) });
  return u;
}

/** Laufende Vorgänge, die der Akteur führen darf – für Start und Sales-Ops-Sicht. Je Position eine Zeile. */
export async function listRunningConversions(actor: Actor) {
  const rows = await db.query.conversions.findMany({ where: and(eq(schema.conversions.workspaceId, actor.workspaceId), eq(schema.conversions.status, "LAUFEND")), orderBy: desc(schema.conversions.updatedAt), limit: 300, columns: { opportunityId: true } });
  const out: { id: string; opportunityId: string; title: string; label: string; accountName: string; step: string; stepNote: string }[] = [];
  for (const oid of [...new Set(rows.map((r) => r.opportunityId))]) {
    const views = await listConversions(actor, oid).catch(() => []);
    for (const v of views) {
      if (v.conversion.status !== "LAUFEND") continue;
      const cur = v.steps.find((s) => s.state === "AKTUELL");
      out.push({ id: v.conversion.id, opportunityId: oid, title: v.opportunity.title, label: v.label, accountName: v.accountName, step: cur ? `${cur.no} ${cur.title}` : "–", stepNote: cur?.note ?? "" });
    }
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
