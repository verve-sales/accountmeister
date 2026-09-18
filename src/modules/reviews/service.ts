import { and, asc, desc, eq, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { ReviewStatus } from "@/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, loadSetupContext, type SetupContext } from "@/modules/identity/authz";

/**
 * BD-/Anker-Weekly (Briefing 11.1): Vorbereitung aus dem letzten bestätigten Stand, gemeinsame Notiz
 * (automatisch nur als Entwurf), Ergebnisvorschau, Bestätigung durch eine verantwortliche Person mit
 * sichtbarem Bestätiger, versionierter Stand; spätere Änderungen erzeugen eine Korrekturversion (11.4).
 *
 * Daten werden verknüpft, nicht kopiert: Hinweise/Aktionen/Entscheidungen tragen die review_id.
 */

export type ReviewSnapshot = {
  signalIds: string[]; // im Weekly erfasste Hinweise
  actionIds: string[]; // im Weekly vereinbarte/vorgeschlagene Aktionen
  decisionIds: string[];
  openSignalCount: number;
  openActionCount: number;
  openHandoverCount: number;
  contextNote: string | null;
  since: string | null; // Zeitpunkt des vorherigen bestätigten Stands
};

export const createReviewInput = z.object({
  setupId: z.string().min(1),
  title: z.string().trim().max(200).optional().or(z.literal("")),
  scheduledFor: z.string().min(10, "Termin fehlt"),
  participantIds: z.array(z.string()).optional(),
});

export async function createReview(actor: Actor, raw: unknown) {
  const data = raw as Record<string, unknown>;
  const participantIds = Array.isArray(data.participantIds) ? data.participantIds : typeof data.participantIds === "string" ? [data.participantIds] : undefined;
  const parsed = createReviewInput.safeParse({ ...data, participantIds });
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const ctx = await loadSetupContext(actor, input.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Sie dürfen für dieses Setup kein Weekly anlegen.");
  // Teilnehmer: Angabe oder alle bearbeitenden Setup-Beteiligten
  let participants = input.participantIds?.filter(Boolean) ?? [];
  if (participants.length === 0) {
    const members = await db.query.setupMemberships.findMany({ where: eq(schema.setupMemberships.setupId, ctx.setup.id) });
    participants = members.map((m) => m.userId);
  }
  if (!participants.includes(actor.userId)) participants.push(actor.userId);
  return db.transaction(async (tx) => {
    const [review] = await tx
      .insert(schema.reviews)
      .values({
        workspaceId: actor.workspaceId,
        type: "BD_ANKER_WEEKLY",
        setupId: ctx.setup.id,
        accountId: ctx.account.id,
        title: input.title || `Weekly ${ctx.setup.name} ${input.scheduledFor}`,
        scheduledFor: input.scheduledFor,
        createdBy: actor.userId,
      })
      .returning();
    if (!review) throw new Error("Weekly konnte nicht angelegt werden");
    await tx.insert(schema.reviewParticipants).values(participants.map((userId) => ({ reviewId: review.id, userId })));
    await recordAudit(tx, actor, "review.created", "REVIEW", review.id, { setupId: ctx.setup.id });
    return review;
  });
}

export async function requireReview(actor: Actor, reviewId: string) {
  const review = await db.query.reviews.findFirst({ where: and(eq(schema.reviews.id, reviewId), eq(schema.reviews.workspaceId, actor.workspaceId)) });
  if (!review || !review.setupId) throw new NotFoundError("Weekly");
  const ctx = await loadSetupContext(actor, review.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Weekly");
  const participants = await db.query.reviewParticipants.findMany({ where: eq(schema.reviewParticipants.reviewId, reviewId) });
  const isParticipant = participants.some((p) => p.userId === actor.userId);
  return { review, ctx, participants, isParticipant, canWork: isParticipant || canEditSetup(actor, ctx) };
}

/** Letzter bestätigter Stand eines Setups – Basis für „Was hat sich geändert?“ und die Vorbereitung. */
export async function getLastConfirmedVersion(setupId: string, beforeReviewId?: string) {
  const confirmed = await db.query.reviews.findMany({
    where: and(eq(schema.reviews.setupId, setupId), eq(schema.reviews.status, "BESTAETIGT"), beforeReviewId ? ne(schema.reviews.id, beforeReviewId) : undefined),
    orderBy: desc(schema.reviews.scheduledFor),
  });
  for (const r of confirmed) {
    if (!r.confirmedVersionId) continue;
    const v = await db.query.reviewVersions.findFirst({ where: eq(schema.reviewVersions.id, r.confirmedVersionId) });
    if (v) return { review: r, version: v };
  }
  return null;
}

/**
 * Vorbereitung (11.1): Stand des letzten bestätigten Weeklys, neue Quellen/Hinweise, offene Übernahmen,
 * vereinbarte Aktionen und deren Veränderung seit dem letzten Stand.
 */
export async function prepareReview(actor: Actor, reviewId: string) {
  const { review, ctx, participants, canWork, isParticipant } = await requireReview(actor, reviewId);
  const setupId = ctx.setup.id;
  const last = await getLastConfirmedVersion(setupId, review.id);
  const since = last?.version.confirmedAt ?? null;
  const [signals, actions, handovers, decisions, versions, users] = await Promise.all([
    db.query.signals.findMany({ where: eq(schema.signals.setupId, setupId), orderBy: desc(schema.signals.createdAt) }),
    db.query.actions.findMany({ where: eq(schema.actions.setupId, setupId), orderBy: asc(schema.actions.dueDate) }),
    db.query.handovers.findMany({ where: and(eq(schema.handovers.setupId, setupId), or(eq(schema.handovers.status, "ANGEFRAGT"), eq(schema.handovers.status, "ANGENOMMEN"))) }),
    db.query.decisions.findMany({ where: eq(schema.decisions.setupId, setupId), orderBy: desc(schema.decisions.createdAt) }),
    db.query.reviewVersions.findMany({ where: eq(schema.reviewVersions.reviewId, reviewId), orderBy: desc(schema.reviewVersions.versionNo) }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId) }),
  ]);
  const userNames = new Map(users.map((u) => [u.id, u.displayName]));
  const isNewSince = (d: Date) => !since || d > since;
  return {
    review,
    ctx,
    participants: participants.map((p) => ({ userId: p.userId, name: userNames.get(p.userId) ?? "?" })),
    isParticipant,
    canWork,
    canEditSetup: canEditSetup(actor, ctx),
    lastConfirmed: last ? { reviewTitle: last.review.title, scheduledFor: last.review.scheduledFor, confirmedAt: last.version.confirmedAt, confirmedBy: userNames.get(last.version.confirmedBy) ?? "?", note: last.version.note, snapshot: last.version.snapshot as ReviewSnapshot } : null,
    since,
    newSignals: signals.filter((s) => isNewSince(s.createdAt) && s.reviewId !== review.id),
    inThisReview: {
      signals: signals.filter((s) => s.reviewId === review.id),
      actions: actions.filter((a) => a.reviewId === review.id),
      decisions: decisions.filter((d) => d.reviewId === review.id),
    },
    openSignals: signals.filter((s) => s.status !== "BEENDET"),
    openActions: actions.filter((a) => a.status !== "ERLEDIGT" && a.status !== "VERWORFEN"),
    changedActions: actions.filter((a) => isNewSince(a.updatedAt) && a.reviewId !== review.id),
    openHandovers: handovers,
    versions,
    userNames,
  };
}

const transitions: Record<ReviewStatus, ReviewStatus[]> = {
  GEPLANT: ["IN_VORBEREITUNG", "LAUFEND"],
  IN_VORBEREITUNG: ["LAUFEND"],
  LAUFEND: ["BESTAETIGUNG_OFFEN"],
  BESTAETIGUNG_OFFEN: ["LAUFEND", "BESTAETIGT"],
  BESTAETIGT: [],
};

function assertTransition(from: ReviewStatus, to: ReviewStatus) {
  if (from === to) return;
  if (!transitions[from].includes(to)) throw new TransitionError(`Übergang von „${from}“ nach „${to}“ ist nicht vorgesehen.`);
}

export const saveDraftInput = z.object({ version: z.coerce.number().int().positive(), noteDraft: z.string().max(20000), toStatus: z.enum(["LAUFEND", "BESTAETIGUNG_OFFEN"]).optional() });

/** Gemeinsame Notiz speichern – ausschließlich als Entwurf; kein bestätigter Stand entsteht. */
export async function saveReviewDraft(actor: Actor, reviewId: string, raw: unknown) {
  const parsed = saveDraftInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { review, canWork } = await requireReview(actor, reviewId);
  if (!canWork) throw new ForbiddenError("Nur Teilnehmende bearbeiten das Weekly.");
  if (review.status === "BESTAETIGT") throw new TransitionError("Ein bestätigtes Weekly wird über eine Korrekturversion geändert.");
  const target: ReviewStatus = input.toStatus ?? (review.status === "GEPLANT" || review.status === "IN_VORBEREITUNG" ? "LAUFEND" : review.status);
  assertTransition(review.status, target);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.reviews)
      .set({ noteDraft: input.noteDraft, status: target, version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.reviews.id, reviewId), eq(schema.reviews.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    await recordAudit(tx, actor, "review.draft_saved", "REVIEW", reviewId, { status: target });
    return updated;
  });
}

export const addDecisionInput = z.object({
  reviewId: z.string().min(1),
  content: z.string().trim().min(5, "Entscheidung fehlt").max(4000),
  scope: z.string().trim().max(500).optional().or(z.literal("")),
  rationale: z.string().trim().max(4000).optional().or(z.literal("")),
});

export async function addDecision(actor: Actor, raw: unknown) {
  const parsed = addDecisionInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { review, ctx, canWork, participants } = await requireReview(actor, input.reviewId);
  if (!canWork) throw new ForbiddenError();
  if (review.status === "BESTAETIGT") throw new TransitionError("Ein bestätigtes Weekly wird über eine Korrekturversion geändert.");
  return db.transaction(async (tx) => {
    const [d] = await tx
      .insert(schema.decisions)
      .values({
        workspaceId: actor.workspaceId,
        setupId: ctx.setup.id,
        reviewId: review.id,
        content: input.content,
        scope: input.scope || null,
        rationale: input.rationale || null,
        decidedByUserIds: participants.map((p) => p.userId),
        decidedOn: review.scheduledFor,
        createdBy: actor.userId,
      })
      .returning();
    if (!d) throw new Error("Entscheidung konnte nicht gespeichert werden");
    if (review.status === "GEPLANT" || review.status === "IN_VORBEREITUNG") {
      await tx.update(schema.reviews).set({ status: "LAUFEND", updatedAt: new Date() }).where(eq(schema.reviews.id, review.id));
    }
    await recordAudit(tx, actor, "decision.created", "DECISION", d.id, { reviewId: review.id });
    return d;
  });
}

export const confirmInput = z.object({ version: z.coerce.number().int().positive(), note: z.string().max(20000).optional() });

/**
 * Bestätigung (11.1 / F11 / 15.4): Die verantwortliche Person bestätigt den dokumentierten Stand.
 * In EINER Transaktion: Snapshot der im Weekly erfassten Hinweise, Aktionen und Entscheidungen sowie
 * der offenen Punkte; Version anlegen; Review auf „bestätigt“. Ideen bleiben Vorschläge (F07) –
 * die Bestätigung wandelt keine vorgeschlagene Aktion in eine angenommene um.
 * Wer bestätigt hat, bleibt sichtbar; sie ist kein Einverständnis aller Beteiligten.
 */
export async function confirmReview(actor: Actor, reviewId: string, raw: unknown) {
  const parsed = confirmInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { review, ctx, isParticipant } = await requireReview(actor, reviewId);
  if (!isParticipant) throw new ForbiddenError("Nur Teilnehmende bestätigen den Stand des Weeklys.");
  if (review.status === "BESTAETIGT") throw new TransitionError("Dieses Weekly ist bereits bestätigt. Änderungen erzeugen eine Korrekturversion.");
  if (review.status === "GEPLANT" || review.status === "IN_VORBEREITUNG") throw new TransitionError("Bitte zuerst die Notiz erfassen (Weekly durchführen), dann bestätigen.");

  return db.transaction(async (tx) => {
    const snapshot = await buildSnapshot(tx, ctx, review.id);
    const note = input.note ?? review.noteDraft;
    const [v] = await tx
      .insert(schema.reviewVersions)
      .values({ reviewId: review.id, versionNo: 1, note: note || null, snapshot, confirmedBy: actor.userId })
      .returning();
    if (!v) throw new Error("Version konnte nicht angelegt werden");
    const [updated] = await tx
      .update(schema.reviews)
      .set({ status: "BESTAETIGT", noteDraft: note || null, confirmedVersionId: v.id, version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.reviews.id, review.id), eq(schema.reviews.version, input.version), ne(schema.reviews.status, "BESTAETIGT")))
      .returning();
    if (!updated) throw new ConflictError("Das Weekly wurde inzwischen geändert oder bereits bestätigt. Bitte neu laden.");
    await recordAudit(tx, actor, "review.confirmed", "REVIEW", review.id, { versionId: v.id, versionNo: 1 });
    return { review: updated, version: v };
  });
}

export const correctInput = z.object({ version: z.coerce.number().int().positive(), note: z.string().max(20000), correctionNote: z.string().trim().min(5, "Bitte den Grund der Korrektur angeben.").max(2000) });

/** Korrektur eines bestätigten Weeklys: neue Version, alte bleibt nachvollziehbar erhalten (11.4). */
export async function correctReview(actor: Actor, reviewId: string, raw: unknown) {
  const parsed = correctInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { review, ctx, isParticipant } = await requireReview(actor, reviewId);
  if (!isParticipant) throw new ForbiddenError("Nur Teilnehmende korrigieren den Stand des Weeklys.");
  if (review.status !== "BESTAETIGT" || !review.confirmedVersionId) throw new TransitionError("Nur bestätigte Weeklys erhalten Korrekturversionen.");
  return db.transaction(async (tx) => {
    const prev = await tx.query.reviewVersions.findFirst({ where: eq(schema.reviewVersions.id, review.confirmedVersionId!) });
    if (!prev) throw new Error("Vorherige Version fehlt");
    const snapshot = await buildSnapshot(tx, ctx, review.id);
    const [v] = await tx
      .insert(schema.reviewVersions)
      .values({ reviewId: review.id, versionNo: prev.versionNo + 1, note: input.note || null, snapshot, confirmedBy: actor.userId, supersedesVersionId: prev.id, correctionNote: input.correctionNote })
      .returning();
    if (!v) throw new Error("Version konnte nicht angelegt werden");
    const [updated] = await tx
      .update(schema.reviews)
      .set({ noteDraft: input.note || null, confirmedVersionId: v.id, version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.reviews.id, review.id), eq(schema.reviews.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    await recordAudit(tx, actor, "review.corrected", "REVIEW", review.id, { versionNo: v.versionNo });
    return { review: updated, version: v };
  });
}

async function buildSnapshot(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], ctx: SetupContext, reviewId: string): Promise<ReviewSnapshot> {
  const setupId = ctx.setup.id;
  const [sig, act, dec, openSig, openAct, openHo, last] = await Promise.all([
    tx.query.signals.findMany({ where: eq(schema.signals.reviewId, reviewId) }),
    tx.query.actions.findMany({ where: eq(schema.actions.reviewId, reviewId) }),
    tx.query.decisions.findMany({ where: eq(schema.decisions.reviewId, reviewId) }),
    tx.query.signals.findMany({ where: and(eq(schema.signals.setupId, setupId), ne(schema.signals.status, "BEENDET")) }),
    tx.query.actions.findMany({ where: and(eq(schema.actions.setupId, setupId), ne(schema.actions.status, "ERLEDIGT"), ne(schema.actions.status, "VERWORFEN")) }),
    tx.query.handovers.findMany({ where: and(eq(schema.handovers.setupId, setupId), or(eq(schema.handovers.status, "ANGEFRAGT"), eq(schema.handovers.status, "ANGENOMMEN"))) }),
    getLastConfirmedVersion(setupId, reviewId),
  ]);
  const setup = await tx.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, setupId) });
  return {
    signalIds: sig.map((s) => s.id),
    actionIds: act.map((a) => a.id),
    decisionIds: dec.map((d) => d.id),
    openSignalCount: openSig.length,
    openActionCount: openAct.length,
    openHandoverCount: openHo.length,
    contextNote: setup?.contextNote ?? null,
    since: last?.version.confirmedAt.toISOString() ?? null,
  };
}

/** Weeklys im Berechtigungsbereich des Akteurs: anstehend und vergangen. */
export async function listReviews(actor: Actor) {
  const rows = await db.query.reviews.findMany({ where: eq(schema.reviews.workspaceId, actor.workspaceId), orderBy: desc(schema.reviews.scheduledFor) });
  const visible = [];
  const setupCache = new Map<string, SetupContext | null>();
  for (const r of rows) {
    if (!r.setupId) continue;
    let ctx = setupCache.get(r.setupId);
    if (ctx === undefined) {
      ctx = await loadSetupContext(actor, r.setupId);
      setupCache.set(r.setupId, ctx);
    }
    if (ctx && canViewSetup(actor, ctx)) visible.push({ ...r, setupName: ctx.setup.name, accountName: ctx.account.name });
  }
  const today = new Date().toISOString().slice(0, 10);
  return {
    upcoming: visible.filter((r) => r.status !== "BESTAETIGT" && r.scheduledFor >= today).sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor)),
    open: visible.filter((r) => r.status !== "BESTAETIGT" && r.scheduledFor < today),
    past: visible.filter((r) => r.status === "BESTAETIGT"),
  };
}

export async function listReviewsForSetup(setupId: string) {
  return db.query.reviews.findMany({ where: eq(schema.reviews.setupId, setupId), orderBy: desc(schema.reviews.scheduledFor) });
}

// Für Setup-Abschnitt 2: Zeitpunkt des letzten bestätigten Stands
export async function getSinceForSetup(setupId: string): Promise<{ since: Date | null; label: string }> {
  const last = await getLastConfirmedVersion(setupId);
  if (!last) return { since: null, label: "Noch kein bestätigtes Weekly – es werden alle Einträge gezeigt." };
  return { since: last.version.confirmedAt, label: `Seit dem bestätigten Weekly „${last.review.title}“ (${last.review.scheduledFor}).` };
}
