import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { Db, Tx } from "@/db/client";
import type { DecisionRole, EngagementStatus, OfferStatus, OpportunityStatus, OrderStatus, RequirementStatus } from "@/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, canViewSource, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { listVisibleAccounts } from "@/modules/accounts/service";

/**
 * Bedarfe, Buyingcenter, Angebote, Aufträge, Startvoraussetzungen (Briefing 8.3, 9.1–9.4, 15.2, Etappe 5).
 *  - Je Setup mehrere Bedarfe mit unabhängigen Zuständen; kein gemeinsamer Kunden-Pipelinestatus (F02).
 *  - Ein Bedarf kann direkt erfasst werden – ohne vollständiges Setup oder MEDDPICC (F08, Fast-Track 9.4).
 *  - Kritische Übergänge (9.3) brauchen dokumentierte Ereignisse mit Quelle: bestätigt, vorgestellt (F09),
 *    beauftragt, startbereit, gestartet. Ein Entwurf oder ein erreichtes Datum genügt nie.
 *  - Positive Rückmeldung zu einem Angebot ist kein Auftrag (F10).
 *  - Profile und Nachweise nur als freigegebene Referenzen/Quellen, kein Kandidaten- oder Vertragsmanagement.
 */

// ---------------------------------------------------------------------------
// Zugriff
// ---------------------------------------------------------------------------

async function requireOpportunity(actor: Actor, id: string) {
  const opp = await db.query.opportunities.findFirst({ where: and(eq(schema.opportunities.id, id), eq(schema.opportunities.workspaceId, actor.workspaceId)) });
  if (!opp) throw new NotFoundError("Bedarf");
  const ctx = await loadSetupContext(actor, opp.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Bedarf");
  return { opp, ctx };
}

async function requireEditableOpportunity(actor: Actor, id: string) {
  const r = await requireOpportunity(actor, id);
  if (!canEditSetup(actor, r.ctx)) throw new ForbiddenError("Sie sind an diesem Setup nicht bearbeitend beteiligt.");
  return r;
}

/**
 * Beleg auflösen: entweder eine vorhandene, für den Akteur sichtbare Quelle oder eine neue Belegnotiz.
 * Ohne Beleg wird kein kritischer Übergang gespeichert (9.3).
 */
async function resolveEvidence(tx: Tx | Db, actor: Actor, ctx: SetupContext, raw: { sourceId?: string; evidenceText?: string }, title: string): Promise<string> {
  if (raw.sourceId) {
    const src = await tx.query.sources.findFirst({ where: and(eq(schema.sources.id, raw.sourceId), eq(schema.sources.workspaceId, actor.workspaceId)) });
    if (!src || !canViewSource(actor, src, ctx)) throw new NotFoundError("Quelle");
    if (src.isLocked) throw new ValidationError("Diese Quelle ist gesperrt und kann nicht als Beleg dienen.");
    return src.id;
  }
  const text = (raw.evidenceText ?? "").trim();
  if (text.length < 10) throw new ValidationError("Bitte einen Beleg angeben: vorhandene Quelle wählen oder eine Belegnotiz (mind. 10 Zeichen) erfassen.");
  const [src] = await tx
    .insert(schema.sources)
    .values({ workspaceId: actor.workspaceId, setupId: ctx.setup.id, type: "NOTIZ", title, body: text, origin: "manuell", sourceTime: new Date(), ownerUserId: actor.userId, accessClass: "SETUP" })
    .returning();
  if (!src) throw new Error("Quelle");
  return src.id;
}

// ---------------------------------------------------------------------------
// Bedarfe
// ---------------------------------------------------------------------------

export const createOpportunityInput = z.object({
  setupId: z.string().min(1, "Setup fehlt"),
  title: z.string().trim().min(3, "Titel fehlt").max(200),
  needDescription: z.string().trim().min(10, "Bitte den Bedarf in Kundensprache beschreiben (mind. 10 Zeichen).").max(4000),
  trigger: z.string().trim().max(2000).optional().or(z.literal("")),
  fastTrack: z.union([z.literal("on"), z.literal("true"), z.boolean()]).optional(),
  signalId: z.string().optional().or(z.literal("")),
});

/** Bedarf anlegen: minimal (Titel + Beschreibung). Kein vorgeschaltetes MEDDPICC, kein vollständiges Setup nötig (F08). */
export async function createOpportunity(actor: Actor, raw: unknown) {
  const parsed = createOpportunityInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const ctx = await loadSetupContext(actor, input.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Sie sind an diesem Setup nicht bearbeitend beteiligt.");
  const fastTrack = input.fastTrack === "on" || input.fastTrack === "true" || input.fastTrack === true;
  return db.transaction(async (tx) => {
    let signal: typeof schema.signals.$inferSelect | null = null;
    if (input.signalId) {
      signal = (await tx.query.signals.findFirst({ where: and(eq(schema.signals.id, input.signalId), eq(schema.signals.setupId, ctx.setup.id)) })) ?? null;
      if (!signal) throw new NotFoundError("Hinweis");
      if (signal.status === "BEENDET") throw new TransitionError("Ein beendeter Hinweis wird nicht mehr mit einem Bedarf verknüpft.");
    }
    const [opp] = await tx
      .insert(schema.opportunities)
      .values({
        workspaceId: actor.workspaceId,
        accountId: ctx.account.id,
        setupId: ctx.setup.id,
        title: input.title,
        needDescription: input.needDescription,
        trigger: input.trigger || null,
        ownerUserId: actor.userId,
        fastTrack,
        requestedAt: fastTrack ? new Date() : null,
        signalId: signal?.id ?? null,
        createdBy: actor.userId,
      })
      .returning();
    if (!opp) throw new Error("Bedarf");
    if (signal) {
      // Hinweis → „mit Bedarf verknüpft“ (9.2); der Hinweis bleibt als Herkunft nachvollziehbar
      await tx.update(schema.signals).set({ status: "MIT_BEDARF_VERKNUEPFT", version: signal.version + 1, updatedAt: new Date() }).where(eq(schema.signals.id, signal.id));
      await recordAudit(tx, actor, "signal.status_changed", "SIGNAL", signal.id, { von: signal.status, nach: "MIT_BEDARF_VERKNUEPFT" });
    }
    await recordAudit(tx, actor, "opportunity.created", "OPPORTUNITY", opp.id, { fastTrack });
    return opp;
  });
}

export const updateOpportunityInput = z.object({
  version: z.coerce.number().int().positive(),
  title: z.string().trim().min(3).max(200),
  needDescription: z.string().trim().min(10).max(4000),
  trigger: z.string().trim().max(2000).optional().or(z.literal("")),
  ownerUserId: z.string().optional().or(z.literal("")),
});

export async function updateOpportunity(actor: Actor, id: string, raw: unknown) {
  const parsed = updateOpportunityInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { opp } = await requireEditableOpportunity(actor, id);
  if (opp.status === "BEENDET") throw new TransitionError("Ein beendeter Bedarf wird nicht mehr geändert.");
  const [u] = await db
    .update(schema.opportunities)
    .set({ title: input.title, needDescription: input.needDescription, trigger: input.trigger || null, ownerUserId: input.ownerUserId || opp.ownerUserId, version: input.version + 1, updatedAt: new Date() })
    .where(and(eq(schema.opportunities.id, id), eq(schema.opportunities.version, input.version)))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "opportunity.updated", "OPPORTUNITY", id);
  return u;
}

export const MEDDPICC_KEYS = [
  ["metrics", "Metrics – messbarer Nutzen (nur belegbar)"],
  ["economicBuyer", "Economic Buyer – tatsächliche Budgetentscheidung"],
  ["decisionCriteria", "Decision Criteria – Auswahlkriterien"],
  ["decisionProcess", "Decision Process – Entscheidungsweg"],
  ["paperProcess", "Paper Process – Beschaffungs-/Vertragsweg"],
  ["identifyPain", "Identify Pain – konkreter Anlass"],
  ["champion", "Champion – belegter interner Unterstützer"],
  ["competition", "Competition – Alternativen inkl. intern lösen / nichts tun"],
] as const;

/** MEDDPICC (9.4) als optionale Hilfe: freie Felder, keine Pflicht, keine Bewertung oder Ampel. */
export async function saveMeddpicc(actor: Actor, id: string, raw: { version: number; fields: Record<string, string> }) {
  const { opp } = await requireEditableOpportunity(actor, id);
  const allowed = new Set(MEDDPICC_KEYS.map(([k]) => k));
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.fields)) {
    if (!allowed.has(k as (typeof MEDDPICC_KEYS)[number][0])) continue;
    const t = (v ?? "").trim();
    if (t) fields[k] = t.slice(0, 2000);
  }
  const [u] = await db
    .update(schema.opportunities)
    .set({ meddpicc: fields, version: Number(raw.version) + 1, updatedAt: new Date() })
    .where(and(eq(schema.opportunities.id, opp.id), eq(schema.opportunities.version, Number(raw.version))))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "opportunity.meddpicc_saved", "OPPORTUNITY", id, { felder: Object.keys(fields).length });
  return u;
}

const oppTransitions: Record<OpportunityStatus, OpportunityStatus[]> = {
  IN_KLAERUNG: ["BESTAETIGT", "ZURUECKGESTELLT", "BEENDET"],
  BESTAETIGT: ["PROFIL_ANGEBOT_VORGESTELLT", "ZURUECKGESTELLT", "BEENDET"],
  PROFIL_ANGEBOT_VORGESTELLT: ["AUSWAHL_BESTELLUNG", "ZURUECKGESTELLT", "BEENDET"],
  AUSWAHL_BESTELLUNG: ["BEAUFTRAGT", "ZURUECKGESTELLT", "BEENDET"],
  BEAUFTRAGT: ["BEENDET"],
  ZURUECKGESTELLT: ["IN_KLAERUNG", "BESTAETIGT", "BEENDET"],
  BEENDET: [],
};

export const confirmOpportunityInput = z.object({
  version: z.coerce.number().int().positive(),
  sourceId: z.string().optional().or(z.literal("")),
  evidenceText: z.string().trim().max(4000).optional().or(z.literal("")),
  confirmedNote: z.string().trim().max(1000).optional().or(z.literal("")),
});

/** „Bedarf bestätigt“ (9.3): dokumentierte Bestätigung mit Quelle und Zeitpunkt; Budget-/Beschaffungsinfo nicht zwingend. */
export async function confirmOpportunity(actor: Actor, id: string, raw: unknown) {
  const parsed = confirmOpportunityInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { opp, ctx } = await requireEditableOpportunity(actor, id);
  if (!oppTransitions[opp.status].includes("BESTAETIGT")) throw new TransitionError(`Aus „${opp.status}“ ist keine Bestätigung vorgesehen.`);
  return db.transaction(async (tx) => {
    const sourceId = await resolveEvidence(tx, actor, ctx, { sourceId: input.sourceId || undefined, evidenceText: input.evidenceText || undefined }, `Bedarfsbestätigung: ${opp.title}`);
    const [u] = await tx
      .update(schema.opportunities)
      .set({ status: "BESTAETIGT", confirmedAt: new Date(), confirmedSourceId: sourceId, confirmedNote: input.confirmedNote || null, statusReason: null, version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.opportunities.id, id), eq(schema.opportunities.version, input.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "opportunity.confirmed", "OPPORTUNITY", id, { sourceId });
    return u;
  });
}

/** Sonstige Statuswechsel: Zurückstellen/Beenden brauchen Begründung; „vorgestellt“/„beauftragt“ entstehen nur über Angebot/Auftrag. */
export async function changeOpportunityStatus(actor: Actor, id: string, raw: { version: number; status: OpportunityStatus; reason?: string }) {
  const { opp } = await requireEditableOpportunity(actor, id);
  const to = raw.status;
  if (to === "BESTAETIGT") throw new TransitionError("Bestätigung erfolgt über „Bedarf bestätigen“ mit Beleg.");
  if (to === "PROFIL_ANGEBOT_VORGESTELLT") throw new TransitionError("„Vorgestellt“ entsteht nur über ein tatsächlich vorgestelltes Angebot (F09).");
  if (to === "BEAUFTRAGT") throw new TransitionError("„Beauftragt“ entsteht nur über einen Auftrag mit Nachweis.");
  if (!oppTransitions[opp.status].includes(to)) throw new TransitionError(`Übergang von „${opp.status}“ nach „${to}“ ist nicht vorgesehen.`);
  const reason = (raw.reason ?? "").trim();
  if ((to === "ZURUECKGESTELLT" || to === "BEENDET") && reason.length < 3) throw new ValidationError("Bitte begründen, warum der Bedarf zurückgestellt bzw. beendet wird.");
  const [u] = await db
    .update(schema.opportunities)
    .set({ status: to, statusReason: reason || null, version: Number(raw.version) + 1, updatedAt: new Date() })
    .where(and(eq(schema.opportunities.id, id), eq(schema.opportunities.version, Number(raw.version))))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "opportunity.status_changed", "OPPORTUNITY", id, { von: opp.status, nach: to });
  return u;
}

// ---------------------------------------------------------------------------
// Buyingcenter (8.3)
// ---------------------------------------------------------------------------

export const participationInput = z.object({
  opportunityId: z.string().min(1),
  role: z.enum(schema.decisionRoleEnum.enumValues),
  personId: z.string().optional().or(z.literal("")),
  epistemicStatus: z.enum(schema.epistemicStatusEnum.enumValues).optional(),
  evidenceSourceId: z.string().optional().or(z.literal("")),
  note: z.string().trim().max(1000).optional().or(z.literal("")),
});

/** Rolle im Buyingcenter: Person optional (offene Funktion ohne erfundene Person); „bestätigt“ nur mit Quelle. */
export async function addParticipation(actor: Actor, raw: unknown) {
  const parsed = participationInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { opp, ctx } = await requireEditableOpportunity(actor, input.opportunityId);
  if (input.personId) {
    const person = await db.query.persons.findFirst({ where: and(eq(schema.persons.id, input.personId), eq(schema.persons.accountId, ctx.account.id)) });
    if (!person) throw new NotFoundError("Person");
  }
  const status = input.epistemicStatus ?? "HYPOTHESE";
  if (status === "SACHVERHALT_BESTAETIGT" && !input.evidenceSourceId) throw new ValidationError("Eine bestätigte Rolle im Buyingcenter braucht eine Quelle. Ein Titel allein belegt keine Entscheidungsvollmacht.");
  if (input.evidenceSourceId) {
    const src = await db.query.sources.findFirst({ where: eq(schema.sources.id, input.evidenceSourceId) });
    if (!src || !canViewSource(actor, src, ctx)) throw new NotFoundError("Quelle");
  }
  const [p] = await db
    .insert(schema.decisionParticipations)
    .values({ opportunityId: opp.id, role: input.role, personId: input.personId || null, epistemicStatus: status, evidenceSourceId: input.evidenceSourceId || null, note: input.note || null, createdBy: actor.userId })
    .returning();
  await recordAudit(db, actor, "opportunity.participation_added", "OPPORTUNITY", opp.id, { role: input.role, offen: !input.personId });
  return p;
}

export async function removeParticipation(actor: Actor, participationId: string) {
  const p = await db.query.decisionParticipations.findFirst({ where: eq(schema.decisionParticipations.id, participationId) });
  if (!p) throw new NotFoundError("Rolle");
  await requireEditableOpportunity(actor, p.opportunityId);
  await db.delete(schema.decisionParticipations).where(eq(schema.decisionParticipations.id, participationId));
  await recordAudit(db, actor, "opportunity.participation_removed", "OPPORTUNITY", p.opportunityId, { role: p.role });
}

// ---------------------------------------------------------------------------
// Profilreferenzen (nur Verweise)
// ---------------------------------------------------------------------------

export const profileRefInput = z.object({
  label: z.string().trim().min(3, "Bezeichnung fehlt").max(200),
  sourceRef: z.string().trim().max(500).optional().or(z.literal("")),
  availabilityNote: z.string().trim().max(500).optional().or(z.literal("")),
});

/** Profilreferenz anlegen – nur BD/Principal/CEO (Konditionen-/Profilinformationen nur für berechtigte Rollen, 16.2). */
export async function createProfileReference(actor: Actor, raw: unknown) {
  if (!hasRole(actor, "BD") && !hasRole(actor, "PRINCIPAL") && !hasRole(actor, "CEO")) throw new ForbiddenError("Profilreferenzen pflegen BD, Principal und CEO.");
  const parsed = profileRefInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const [r] = await db
    .insert(schema.candidateProfileReferences)
    .values({ workspaceId: actor.workspaceId, label: input.label, sourceRef: input.sourceRef || null, availabilityNote: input.availabilityNote || null, approvedBy: actor.userId, approvedAt: new Date(), createdBy: actor.userId })
    .returning();
  await recordAudit(db, actor, "profile_reference.created", "PROFILE_REFERENCE", r?.id ?? "");
  return r;
}

export async function listProfileReferences(actor: Actor) {
  if (!hasRole(actor, "BD") && !hasRole(actor, "PRINCIPAL") && !hasRole(actor, "CEO")) return [];
  return db.query.candidateProfileReferences.findMany({ where: eq(schema.candidateProfileReferences.workspaceId, actor.workspaceId), orderBy: desc(schema.candidateProfileReferences.createdAt) });
}

// ---------------------------------------------------------------------------
// Angebote / Profilvorstellungen (F09, F10)
// ---------------------------------------------------------------------------

export const offerInput = z.object({
  opportunityId: z.string().min(1),
  title: z.string().trim().min(3, "Titel fehlt").max(200),
  summary: z.string().trim().max(4000).optional().or(z.literal("")),
  profileReferenceIds: z.array(z.string()).optional(),
  artifactVersionId: z.string().optional().or(z.literal("")),
});

export async function createOffer(actor: Actor, raw: unknown) {
  const parsed = offerInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { opp } = await requireEditableOpportunity(actor, input.opportunityId);
  if (opp.status === "BEENDET" || opp.status === "BEAUFTRAGT") throw new TransitionError("Für diesen Bedarf werden keine neuen Angebote mehr angelegt.");
  const refs = input.profileReferenceIds ?? [];
  if (refs.length) {
    const found = await db.query.candidateProfileReferences.findMany({ where: and(inArray(schema.candidateProfileReferences.id, refs), eq(schema.candidateProfileReferences.workspaceId, actor.workspaceId)) });
    if (found.length !== refs.length) throw new NotFoundError("Profilreferenz");
  }
  const existing = await db.query.offers.findMany({ where: eq(schema.offers.opportunityId, opp.id) });
  const [o] = await db
    .insert(schema.offers)
    .values({ workspaceId: actor.workspaceId, opportunityId: opp.id, title: input.title, summary: input.summary || null, profileReferenceIds: refs, artifactVersionId: input.artifactVersionId || null, versionNo: existing.length + 1, createdBy: actor.userId })
    .returning();
  await recordAudit(db, actor, "offer.created", "OFFER", o?.id ?? "", { opportunityId: opp.id });
  return o;
}

const offerTransitions: Record<OfferStatus, OfferStatus[]> = {
  ENTWURF: ["GEPRUEFT", "ZURUECKGEZOGEN"],
  GEPRUEFT: ["VORGESTELLT", "ENTWURF", "ZURUECKGEZOGEN"],
  VORGESTELLT: ["RUECKMELDUNG_OFFEN", "AKZEPTIERT", "ABGELEHNT", "ZURUECKGEZOGEN"],
  RUECKMELDUNG_OFFEN: ["AKZEPTIERT", "ABGELEHNT", "ZURUECKGEZOGEN"],
  AKZEPTIERT: [],
  ABGELEHNT: [],
  ZURUECKGEZOGEN: [],
};

export const presentOfferInput = z.object({
  version: z.coerce.number().int().positive(),
  presentedTo: z.string().trim().min(3, "Bitte angeben, wem vorgestellt wurde.").max(500),
  presentedAt: z.string().optional().or(z.literal("")),
  sourceId: z.string().optional().or(z.literal("")),
  evidenceText: z.string().trim().max(4000).optional().or(z.literal("")),
});

/** „Tatsächlich vorgestellt“ (F09): manuell bestätigtes Vorstellungsereignis mit Beleg; ein Entwurf genügt nicht. */
export async function presentOffer(actor: Actor, offerId: string, raw: unknown) {
  const parsed = presentOfferInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const offer = await db.query.offers.findFirst({ where: and(eq(schema.offers.id, offerId), eq(schema.offers.workspaceId, actor.workspaceId)) });
  if (!offer) throw new NotFoundError("Angebot");
  const { opp, ctx } = await requireEditableOpportunity(actor, offer.opportunityId);
  if (offer.status === "ENTWURF") throw new TransitionError("Ein Entwurf gilt nicht als vorgestellt. Bitte zuerst prüfen (Status „Geprüft“), dann das Vorstellungsereignis bestätigen.");
  if (!offerTransitions[offer.status].includes("VORGESTELLT")) throw new TransitionError(`Aus „${offer.status}“ ist „Vorgestellt“ nicht vorgesehen.`);
  return db.transaction(async (tx) => {
    const sourceId = await resolveEvidence(tx, actor, ctx, { sourceId: input.sourceId || undefined, evidenceText: input.evidenceText || undefined }, `Vorstellung: ${offer.title}`);
    const presentedAt = input.presentedAt ? new Date(input.presentedAt) : new Date();
    if (presentedAt.getTime() > Date.now() + 60_000) throw new ValidationError("Ein Vorstellungsereignis liegt nicht in der Zukunft.");
    const [u] = await tx
      .update(schema.offers)
      .set({ status: "VORGESTELLT", presentedAt, presentedTo: input.presentedTo, presentedSourceId: sourceId, version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.offers.id, offerId), eq(schema.offers.version, input.version)))
      .returning();
    if (!u) throw new ConflictError();
    if (opp.status === "BESTAETIGT") {
      await tx.update(schema.opportunities).set({ status: "PROFIL_ANGEBOT_VORGESTELLT", version: opp.version + 1, updatedAt: new Date() }).where(eq(schema.opportunities.id, opp.id));
      await recordAudit(tx, actor, "opportunity.status_changed", "OPPORTUNITY", opp.id, { von: opp.status, nach: "PROFIL_ANGEBOT_VORGESTELLT" });
    }
    await recordAudit(tx, actor, "offer.presented", "OFFER", offerId, { sourceId });
    return u;
  });
}

/** Übrige Angebotsübergänge. Akzeptiert ≠ Auftrag (F10): Der Bedarf wechselt höchstens nach „Auswahl/Bestellung“. */
export async function changeOfferStatus(actor: Actor, offerId: string, raw: { version: number; status: OfferStatus; note?: string }) {
  const offer = await db.query.offers.findFirst({ where: and(eq(schema.offers.id, offerId), eq(schema.offers.workspaceId, actor.workspaceId)) });
  if (!offer) throw new NotFoundError("Angebot");
  const { opp } = await requireEditableOpportunity(actor, offer.opportunityId);
  const to = raw.status;
  if (to === "VORGESTELLT") throw new TransitionError("„Vorgestellt“ wird über das Vorstellungsereignis mit Beleg gesetzt.");
  if (!offerTransitions[offer.status].includes(to)) throw new TransitionError(`Übergang von „${offer.status}“ nach „${to}“ ist nicht vorgesehen.`);
  const note = (raw.note ?? "").trim();
  if ((to === "ABGELEHNT" || to === "ZURUECKGEZOGEN") && note.length < 3) throw new ValidationError("Bitte den Grund festhalten.");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.offers)
      .set({ status: to, feedbackNote: to === "AKZEPTIERT" || to === "ABGELEHNT" || to === "RUECKMELDUNG_OFFEN" ? note || offer.feedbackNote : offer.feedbackNote, statusReason: to === "ZURUECKGEZOGEN" ? note : offer.statusReason, version: Number(raw.version) + 1, updatedAt: new Date() })
      .where(and(eq(schema.offers.id, offerId), eq(schema.offers.version, Number(raw.version))))
      .returning();
    if (!u) throw new ConflictError();
    if (to === "AKZEPTIERT" && opp.status === "PROFIL_ANGEBOT_VORGESTELLT") {
      // Positive Rückmeldung: Auswahl/Bestellung läuft – noch kein Auftrag, kein Start (F10)
      await tx.update(schema.opportunities).set({ status: "AUSWAHL_BESTELLUNG", version: opp.version + 1, updatedAt: new Date() }).where(eq(schema.opportunities.id, opp.id));
      await recordAudit(tx, actor, "opportunity.status_changed", "OPPORTUNITY", opp.id, { von: opp.status, nach: "AUSWAHL_BESTELLUNG" });
    }
    await recordAudit(tx, actor, "offer.status_changed", "OFFER", offerId, { von: offer.status, nach: to });
    return u;
  });
}

// ---------------------------------------------------------------------------
// Aufträge und Startvoraussetzungen (9.3)
// ---------------------------------------------------------------------------

export const orderInput = z.object({
  opportunityId: z.string().min(1),
  offerId: z.string().optional().or(z.literal("")),
  orderReference: z.string().trim().max(200).optional().or(z.literal("")),
  plannedStart: z.string().optional().or(z.literal("")),
  plannedEnd: z.string().optional().or(z.literal("")),
});

/** Auftrag in Vorbereitung anlegen; „Beauftragung bestätigt“ folgt nur mit Nachweis. */
export async function createOrder(actor: Actor, raw: unknown) {
  const parsed = orderInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { opp } = await requireEditableOpportunity(actor, input.opportunityId);
  if (opp.status === "BEENDET" || opp.status === "ZURUECKGESTELLT") throw new TransitionError("Für einen beendeten oder zurückgestellten Bedarf wird kein Auftrag angelegt.");
  if (input.offerId) {
    const offer = await db.query.offers.findFirst({ where: and(eq(schema.offers.id, input.offerId), eq(schema.offers.opportunityId, opp.id)) });
    if (!offer) throw new NotFoundError("Angebot");
  }
  const [o] = await db
    .insert(schema.orders)
    .values({ workspaceId: actor.workspaceId, opportunityId: opp.id, offerId: input.offerId || null, orderReference: input.orderReference || null, plannedStart: input.plannedStart || null, plannedEnd: input.plannedEnd || null, createdBy: actor.userId })
    .returning();
  await recordAudit(db, actor, "order.created", "ORDER", o?.id ?? "", { opportunityId: opp.id });
  return o;
}

async function requireOrder(actor: Actor, orderId: string) {
  const order = await db.query.orders.findFirst({ where: and(eq(schema.orders.id, orderId), eq(schema.orders.workspaceId, actor.workspaceId)) });
  if (!order) throw new NotFoundError("Auftrag");
  const r = await requireEditableOpportunity(actor, order.opportunityId);
  return { order, ...r };
}

export const confirmOrderInput = z.object({
  version: z.coerce.number().int().positive(),
  orderReference: z.string().trim().min(2, "Bestell-/Vertragsreferenz fehlt").max(200),
  sourceId: z.string().optional().or(z.literal("")),
  evidenceText: z.string().trim().max(4000).optional().or(z.literal("")),
  evidenceNote: z.string().trim().max(1000).optional().or(z.literal("")),
});

/** „Beauftragung bestätigt“: prüfbarer Bestell-/Vertragsnachweis (Quelle) + Referenz. */
export async function confirmOrder(actor: Actor, orderId: string, raw: unknown) {
  const parsed = confirmOrderInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { order, opp, ctx } = await requireOrder(actor, orderId);
  if (order.status === "BEAUFTRAGUNG_BESTAETIGT") throw new TransitionError("Bereits bestätigt.");
  if (order.status === "BEENDET_STORNIERT") throw new TransitionError("Ein beendeter/stornierter Auftrag wird nicht bestätigt.");
  return db.transaction(async (tx) => {
    const sourceId = await resolveEvidence(tx, actor, ctx, { sourceId: input.sourceId || undefined, evidenceText: input.evidenceText || undefined }, `Bestell-/Vertragsnachweis ${input.orderReference}`);
    const [u] = await tx
      .update(schema.orders)
      .set({ status: "BEAUFTRAGUNG_BESTAETIGT", orderReference: input.orderReference, evidenceSourceId: sourceId, evidenceNote: input.evidenceNote || null, confirmedAt: new Date(), confirmedBy: actor.userId, version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.version, input.version)))
      .returning();
    if (!u) throw new ConflictError();
    if (opp.status !== "BEAUFTRAGT" && opp.status !== "BEENDET") {
      await tx.update(schema.opportunities).set({ status: "BEAUFTRAGT", version: opp.version + 1, updatedAt: new Date() }).where(eq(schema.opportunities.id, opp.id));
      await recordAudit(tx, actor, "opportunity.status_changed", "OPPORTUNITY", opp.id, { von: opp.status, nach: "BEAUFTRAGT" });
    }
    await recordAudit(tx, actor, "order.confirmed", "ORDER", orderId, { sourceId });
    return u;
  });
}

export async function markOrderEvidenceIncomplete(actor: Actor, orderId: string, raw: { version: number; note: string }) {
  const { order } = await requireOrder(actor, orderId);
  if (order.status !== "IN_VORBEREITUNG" && order.status !== "NACHWEISE_UNVOLLSTAENDIG") throw new TransitionError("Nur vor der Bestätigung möglich.");
  const note = (raw.note ?? "").trim();
  if (note.length < 3) throw new ValidationError("Bitte festhalten, welcher Nachweis fehlt.");
  const [u] = await db
    .update(schema.orders)
    .set({ status: "NACHWEISE_UNVOLLSTAENDIG", statusReason: note, version: Number(raw.version) + 1, updatedAt: new Date() })
    .where(and(eq(schema.orders.id, orderId), eq(schema.orders.version, Number(raw.version))))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "order.evidence_incomplete", "ORDER", orderId);
  return u;
}

export async function cancelOrder(actor: Actor, orderId: string, raw: { version: number; reason: string }) {
  const { order } = await requireOrder(actor, orderId);
  if (order.status === "BEENDET_STORNIERT") throw new TransitionError("Bereits beendet/storniert.");
  const reason = (raw.reason ?? "").trim();
  if (reason.length < 3) throw new ValidationError("Bitte den Grund festhalten.");
  const [u] = await db
    .update(schema.orders)
    .set({ status: "BEENDET_STORNIERT", engagementStatus: order.engagementStatus === "GESTARTET" ? "BEENDET" : order.engagementStatus, statusReason: reason, version: Number(raw.version) + 1, updatedAt: new Date() })
    .where(and(eq(schema.orders.id, orderId), eq(schema.orders.version, Number(raw.version))))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "order.cancelled", "ORDER", orderId);
  return u;
}

export const requirementInput = z.object({
  orderId: z.string().min(1),
  requirement: z.string().trim().min(3, "Anforderung fehlt").max(500),
  policyRef: z.string().trim().max(200).optional().or(z.literal("")),
  checkedBy: z.string().trim().max(200).optional().or(z.literal("")),
});

/** Startvoraussetzung erfassen (geltende Anforderung, prüfende Stelle). */
export async function addStartRequirement(actor: Actor, raw: unknown) {
  const parsed = requirementInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { order } = await requireOrder(actor, input.orderId);
  if (order.engagementStatus === "GESTARTET" || order.engagementStatus === "BEENDET") throw new TransitionError("Nach dem Start werden keine Startvoraussetzungen mehr ergänzt.");
  const [r] = await db
    .insert(schema.startRequirements)
    .values({ orderId: order.id, requirement: input.requirement, policyRef: input.policyRef || null, checkedBy: input.checkedBy || null, createdBy: actor.userId })
    .returning();
  await recordAudit(db, actor, "order.requirement_added", "ORDER", order.id);
  return r;
}

export const requirementStatusInput = z.object({
  version: z.coerce.number().int().positive(),
  status: z.enum(schema.requirementStatusEnum.enumValues),
  sourceId: z.string().optional().or(z.literal("")),
  evidenceText: z.string().trim().max(4000).optional().or(z.literal("")),
  evidenceNote: z.string().trim().max(1000).optional().or(z.literal("")),
});

/** Nachweis zu einer Startvoraussetzung: „bestätigt“ nur mit Quelle; „nicht anwendbar“ mit Begründung. */
export async function setRequirementStatus(actor: Actor, requirementId: string, raw: unknown) {
  const parsed = requirementStatusInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const req = await db.query.startRequirements.findFirst({ where: eq(schema.startRequirements.id, requirementId) });
  if (!req) throw new NotFoundError("Startvoraussetzung");
  const { order, ctx } = await requireOrder(actor, req.orderId);
  if (order.engagementStatus === "GESTARTET" || order.engagementStatus === "BEENDET") throw new TransitionError("Nach dem Start werden Startvoraussetzungen nicht mehr geändert.");
  return db.transaction(async (tx) => {
    let sourceId: string | null = req.evidenceSourceId;
    if (input.status === "BESTAETIGT" || input.status === "NACHWEIS_VORGELEGT") {
      sourceId = await resolveEvidence(tx, actor, ctx, { sourceId: input.sourceId || undefined, evidenceText: input.evidenceText || undefined }, `Nachweis: ${req.requirement}`);
    }
    if (input.status === "NICHT_ANWENDBAR" && !(input.evidenceNote ?? "").trim()) throw new ValidationError("Bitte begründen, warum die Anforderung hier nicht gilt.");
    const [u] = await tx
      .update(schema.startRequirements)
      .set({ status: input.status, evidenceSourceId: sourceId, evidenceNote: input.evidenceNote || req.evidenceNote, confirmedBy: input.status === "BESTAETIGT" ? actor.userId : null, confirmedAt: input.status === "BESTAETIGT" ? new Date() : null, version: input.version + 1 })
      .where(and(eq(schema.startRequirements.id, requirementId), eq(schema.startRequirements.version, input.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "order.requirement_status", "ORDER", order.id, { status: input.status });
    return u;
  });
}

/**
 * „Startbereit“: bestätigter Stand aller Startvoraussetzungen. Eine leere Liste gilt nicht als erfüllt (9.3);
 * ohne freigegebene Regelkonfiguration wird nur der dokumentierte Stand gezeigt.
 */
export async function markReady(actor: Actor, orderId: string, raw: { version: number }) {
  const { order } = await requireOrder(actor, orderId);
  if (order.status !== "BEAUFTRAGUNG_BESTAETIGT") throw new TransitionError("„Startbereit“ setzt eine bestätigte Beauftragung voraus.");
  if (order.engagementStatus !== "GEPLANT") throw new TransitionError(`Aus „${order.engagementStatus}“ ist „Startbereit“ nicht vorgesehen.`);
  const reqs = await db.query.startRequirements.findMany({ where: eq(schema.startRequirements.orderId, orderId) });
  if (reqs.length === 0) throw new ValidationError("Ohne erfasste Startvoraussetzungen gibt es keine Startfreigabe – eine leere Prüfliste gilt nicht als erfüllt.");
  const open = reqs.filter((r) => r.status !== "BESTAETIGT" && r.status !== "NICHT_ANWENDBAR");
  if (open.length > 0) throw new ValidationError(`Noch ${open.length} Startvoraussetzung(en) ohne bestätigten Nachweis.`);
  const [u] = await db
    .update(schema.orders)
    .set({ engagementStatus: "STARTBEREIT", version: Number(raw.version) + 1, updatedAt: new Date() })
    .where(and(eq(schema.orders.id, orderId), eq(schema.orders.version, Number(raw.version))))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "order.ready", "ORDER", orderId, { requirements: reqs.length });
  return u;
}

/** „Gestartet“: tatsächlich bestätigtes Ereignis mit Zeitpunkt – nie die Folge eines erreichten Datums. */
export async function markStarted(actor: Actor, orderId: string, raw: { version: number; startedAt?: string; note?: string }) {
  const { order } = await requireOrder(actor, orderId);
  if (order.engagementStatus !== "STARTBEREIT") throw new TransitionError("„Gestartet“ setzt „Startbereit“ voraus.");
  const note = (raw.note ?? "").trim();
  if (note.length < 3) throw new ValidationError("Bitte das Startereignis kurz bestätigen (z. B. „Kick-off am … mit … durchgeführt“).");
  const startedAt = raw.startedAt ? new Date(raw.startedAt) : new Date();
  if (startedAt.getTime() > Date.now() + 60_000) throw new ValidationError("Ein Startereignis liegt nicht in der Zukunft.");
  const [u] = await db
    .update(schema.orders)
    .set({ engagementStatus: "GESTARTET", startedAt, statusReason: note, version: Number(raw.version) + 1, updatedAt: new Date() })
    .where(and(eq(schema.orders.id, orderId), eq(schema.orders.version, Number(raw.version))))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "order.started", "ORDER", orderId);
  return u;
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

export async function listOpportunitiesForSetup(actor: Actor, setupId: string) {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  return db.query.opportunities.findMany({ where: eq(schema.opportunities.setupId, setupId), orderBy: desc(schema.opportunities.updatedAt) });
}

/** Bedarfe eines Kunden – jeder Bedarf mit eigenem Zustand, keine Verdichtung zu einem Kundenstatus (F02). */
export async function listOpportunitiesForAccount(actor: Actor, accountId: string) {
  const rows = await db.query.opportunities.findMany({ where: and(eq(schema.opportunities.accountId, accountId), eq(schema.opportunities.workspaceId, actor.workspaceId)), orderBy: desc(schema.opportunities.updatedAt) });
  const out = [];
  for (const o of rows) {
    const ctx = await loadSetupContext(actor, o.setupId);
    if (ctx && canViewSetup(actor, ctx)) out.push({ ...o, setupName: ctx.setup.name });
  }
  return out;
}

/** Offene Bedarfe, für die der Akteur verantwortlich ist (Meine Arbeit). */
export async function listMyOpportunities(actor: Actor) {
  const rows = await db.query.opportunities.findMany({ where: and(eq(schema.opportunities.ownerUserId, actor.userId), eq(schema.opportunities.workspaceId, actor.workspaceId)), orderBy: desc(schema.opportunities.updatedAt) });
  const visibleAccounts = new Map((await listVisibleAccounts(actor)).map((a) => [a.id, a.name]));
  return rows.filter((o) => o.status !== "BEENDET" && visibleAccounts.has(o.accountId)).map((o) => ({ ...o, accountName: visibleAccounts.get(o.accountId) ?? "?" }));
}

export async function getOpportunityDetail(actor: Actor, id: string) {
  const { opp, ctx } = await requireOpportunity(actor, id);
  const [participations, offers, orders, persons, users, setupSources, signal] = await Promise.all([
    db.query.decisionParticipations.findMany({ where: eq(schema.decisionParticipations.opportunityId, id), orderBy: desc(schema.decisionParticipations.createdAt) }),
    db.query.offers.findMany({ where: eq(schema.offers.opportunityId, id), orderBy: desc(schema.offers.versionNo) }),
    db.query.orders.findMany({ where: eq(schema.orders.opportunityId, id), orderBy: desc(schema.orders.createdAt) }),
    db.query.persons.findMany({ where: eq(schema.persons.accountId, ctx.account.id) }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId) }),
    db.query.sources.findMany({ where: and(eq(schema.sources.setupId, ctx.setup.id), eq(schema.sources.isLocked, false)), orderBy: desc(schema.sources.importedAt) }),
    opp.signalId ? db.query.signals.findFirst({ where: eq(schema.signals.id, opp.signalId) }) : Promise.resolve(null),
  ]);
  const orderIds = orders.map((o) => o.id);
  const requirements = orderIds.length ? await db.query.startRequirements.findMany({ where: inArray(schema.startRequirements.orderId, orderIds), orderBy: desc(schema.startRequirements.createdAt) }) : [];
  const profileRefs = await listProfileReferences(actor);
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const pn = new Map(persons.map((p) => [p.id, p.displayName]));
  // Quellen nur, soweit der Akteur sie sehen darf (persönliche Quellen anderer bleiben außen vor)
  const visibleSources = setupSources.filter((s) => canViewSource(actor, s, ctx));
  return {
    opp,
    ctx,
    canEdit: canEditSetup(actor, ctx),
    participations: participations.map((p) => ({ ...p, personName: p.personId ? pn.get(p.personId) ?? "?" : null })),
    offers,
    orders: orders.map((o) => ({ ...o, requirements: requirements.filter((r) => r.orderId === o.id) })),
    persons,
    users,
    userNames: un,
    sources: visibleSources.map((s) => ({ id: s.id, title: s.title, type: s.type })),
    profileRefs,
    signal: signal ?? null,
  };
}

// Für Tests/Anzeige
export const opportunityTransitions = oppTransitions;
export type { OpportunityStatus, OfferStatus, OrderStatus, EngagementStatus, RequirementStatus, DecisionRole };
