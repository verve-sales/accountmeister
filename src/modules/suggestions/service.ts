import { createHash } from "node:crypto";
import { and, count, desc, eq, gte, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { PriorityCategory, SuggestionStatus } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { ConflictError, DomainError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { loadActor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { getAIProvider } from "@/modules/ai";
import { STRUCTURE_NOTE_PROMPT_VERSION, type AIProvider, type StructureNoteInput } from "@/modules/ai/provider";
import { structureNoteOutputSchema, type StructuredItem } from "@/modules/ai/schemas";
import { requireReview } from "@/modules/reviews/service";
import { captureObservation } from "@/modules/signals/service";
import { createAction } from "@/modules/actions/service";
import { addDecision } from "@/modules/reviews/service";

/**
 * Vorschläge (Briefing 14): Verarbeitungskette
 *   Ereignis → berechtigten Kontext laden → regelbasierte Prüfung → KI-Ausgabe → Schema-/Quellenprüfung
 *   → Berechtigung erneut prüfen → Vorschlag speichern → menschliche Entscheidung.
 * Das Modell löst keine Datenbankänderungen aus; erst die Annahme durch eine Person erzeugt Objekte –
 * und zwar in ungeprüften Zuständen („Prüfe, ob Bedarf besteht“ erzeugt nie „Bedarf bestätigt“).
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[„“"'.,;:!?()]/g, "").trim();

export class UsageLimitError extends DomainError {
  constructor(limit: number) {
    super("AI_LIMIT", `Die tägliche Nutzungsgrenze für KI-Aufträge (${limit}) ist erreicht. Manuelle Dokumentation ist weiterhin möglich.`, 429);
  }
}

export function getProviderStatus() {
  const info = getAIProvider().info();
  return { ...info, promptVersion: STRUCTURE_NOTE_PROMPT_VERSION, dailyLimit: getConfig().AI_DAILY_JOB_LIMIT };
}

/** Priorisierung nach transparenten Kategorien (14.3) – keine KI-Scores. */
export function categorize(item: StructuredItem): PriorityCategory {
  if (item.type === "KONFLIKT") return "PLANUNGSANLASS";
  if (item.type === "AKTION" && /termin|bis \d|deadline|frist|anfrage|angefragt/i.test(item.observation)) return "KONKRETE_ANFRAGE";
  if (item.type === "OFFENE_FRAGE" && /wer (entscheidet|koordiniert|plant|verantwortet)|zuständig/i.test(item.observation)) return "ZUGANGSLUECKE";
  if (item.type === "PERSON") return "ZUGANGSLUECKE";
  if (/verlänger|nächste phase|laufzeit|planung/i.test(item.observation)) return "PLANUNGSANLASS";
  if (item.type === "BEOBACHTUNG" || item.type === "ENTSCHEIDUNG") return "NEUE_INFORMATION";
  return "VERBESSERUNGSIDEE";
}

const CATEGORY_ORDER: Record<PriorityCategory, number> = { KONKRETE_ANFRAGE: 0, BLOCKIERTE_AKTION: 1, NEUE_INFORMATION: 2, ZUGANGSLUECKE: 3, PLANUNGSANLASS: 4, VERBESSERUNGSIDEE: 5 };

/**
 * Weekly-Notiz strukturieren. Rechte: Teilnehmende bzw. Setup-Bearbeitende. Die Notiz ist die einzige Rohquelle,
 * die der Anbieter erhält; dazu kommen nur Anzeigenamen und bestätigte Aussagen als Text.
 */
export async function structureReviewNote(actor: Actor, reviewId: string, deps: { provider?: AIProvider } = {}) {
  const { review, ctx, participants, canWork } = await requireReview(actor, reviewId);
  if (!canWork) throw new ForbiddenError("Nur Teilnehmende oder Setup-Bearbeitende strukturieren die Notiz.");
  if (review.status === "BESTAETIGT") throw new TransitionError("Ein bestätigtes Weekly wird nicht mehr strukturiert.");
  const noteText = (review.noteDraft ?? "").trim();
  if (noteText.length < 12) throw new ValidationError("Die Notiz ist leer oder zu kurz, um sie zu strukturieren.");
  return structureText(actor, ctx, {
    text: noteText,
    dedupeScope: reviewId,
    reviewId,
    sourceIds: [],
    trigger: `Weekly-Notiz „${review.title}“`,
    participantUserIds: participants.map((p) => p.userId),
  }, deps);
}

export type StructureTextInput = {
  text: string;
  /** Idempotenz-Bereich des Auftrags (z. B. Review-ID oder Import-ID) */
  dedupeScope: string;
  reviewId?: string;
  sourceIds: string[];
  trigger: string;
  participantUserIds: string[];
};

/**
 * Gemeinsame Verarbeitungskette für Weekly-Notizen und importierte Quellen (Briefing 14.4).
 * Der Anbieter erhält nur den Text, Anzeigenamen und bestätigte Aussagen – keine weiteren Rohquellen.
 */
export async function structureText(actor: Actor, ctx: SetupContext, input0: StructureTextInput, deps: { provider?: AIProvider } = {}) {
  const cfg = getConfig();
  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  const noteText = input0.text.trim();
  if (noteText.length < 12) throw new ValidationError("Der Text ist leer oder zu kurz, um ihn zu strukturieren.");

  // Nutzungsgrenze je Arbeitsraum und Tag (17.4)
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const [cnt] = await db.select({ n: count() }).from(schema.aiJobs).where(and(eq(schema.aiJobs.workspaceId, actor.workspaceId), gte(schema.aiJobs.startedAt, since)));
  if (Number(cnt?.n ?? 0) >= cfg.AI_DAILY_JOB_LIMIT) throw new UsageLimitError(cfg.AI_DAILY_JOB_LIMIT);

  // Berechtigten Kontext laden (nur Namen/Texte, keine Rohquellen)
  const participantIds = input0.participantUserIds.length ? input0.participantUserIds : [actor.userId];
  const [users, persons, confirmed] = await Promise.all([
    db.query.users.findMany({ where: inArray(schema.users.id, participantIds) }),
    db.query.persons.findMany({ where: eq(schema.persons.accountId, ctx.account.id) }),
    db.query.assertions.findMany({ where: and(eq(schema.assertions.setupId, ctx.setup.id), eq(schema.assertions.epistemicStatus, "SACHVERHALT_BESTAETIGT")) }),
  ]);
  const input: StructureNoteInput = {
    noteText,
    setupName: ctx.setup.name,
    participantNames: users.map((u) => u.displayName),
    knownPersonNames: persons.map((p) => p.displayName),
    confirmedAssertions: confirmed.map((a) => a.content),
  };
  const inputHash = sha(noteText);
  const jobDedupe = sha(`${input0.dedupeScope}:${inputHash}:${STRUCTURE_NOTE_PROMPT_VERSION}`);

  const prior = await db.query.aiJobs.findFirst({ where: and(eq(schema.aiJobs.dedupeKey, jobDedupe), eq(schema.aiJobs.status, "ERFOLGREICH")) });
  if (prior) return { job: prior, created: 0, skipped: 0, rejected: 0, repeated: true, noSuggestionReason: "" };

  const [job] = await db
    .insert(schema.aiJobs)
    .values({ workspaceId: actor.workspaceId, type: "STRUCTURE_NOTE", actorUserId: actor.userId, setupId: ctx.setup.id, reviewId: input0.reviewId ?? null, provider: info.id, model: info.model, promptVersion: STRUCTURE_NOTE_PROMPT_VERSION, inputHash, inputChars: noteText.length, dedupeKey: jobDedupe })
    .returning();
  if (!job) throw new Error("KI-Auftrag konnte nicht angelegt werden");

  let raw: unknown;
  try {
    raw = await provider.structureNote(input);
  } catch (e) {
    await db.update(schema.aiJobs).set({ status: "ABGELEHNT", error: e instanceof Error ? e.message.slice(0, 300) : "Anbieterfehler", finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    throw e;
  }

  const parsed = structureNoteOutputSchema.safeParse(raw);
  if (!parsed.success) {
    await db.update(schema.aiJobs).set({ status: "FEHLER", error: "Ausgabe entspricht nicht dem Schema", finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    throw new ValidationError("Die KI-Ausgabe entspricht nicht dem Ausgabeschema und wurde verworfen.");
  }
  const valid: StructuredItem[] = [];
  let rejected = 0;
  for (const item of parsed.data.items) {
    if (!noteText.includes(item.evidenceQuote) || (item.proposedOwnerName && !input.participantNames.includes(item.proposedOwnerName))) {
      rejected++;
      continue;
    }
    valid.push(item);
  }

  // Berechtigung erneut prüfen (S05)
  const fresh = await loadActor(actor.userId);
  const freshCtx = fresh ? await loadSetupContext(fresh, ctx.setup.id) : null;
  if (!fresh || !freshCtx || !canViewSetup(fresh, freshCtx)) {
    await db.update(schema.aiJobs).set({ status: "ABGELEHNT", error: "Berechtigung während der Verarbeitung entzogen", finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    throw new ForbiddenError("Ihre Berechtigung hat sich während der Verarbeitung geändert; es wurde nichts gespeichert.");
  }

  const nameToUser = new Map(users.map((u) => [u.displayName, u.id]));
  let created = 0;
  let skipped = 0;
  await db.transaction(async (tx) => {
    for (const item of valid) {
      const dedupeKey = sha(`${item.type}:${normalize(item.evidenceQuote)}`);
      const existing = await tx.query.suggestions.findFirst({ where: and(eq(schema.suggestions.setupId, ctx.setup.id), eq(schema.suggestions.dedupeKey, dedupeKey)) });
      if (existing) {
        skipped++;
        continue;
      }
      await tx.insert(schema.suggestions).values({
        workspaceId: actor.workspaceId,
        type: item.type,
        title: item.title,
        targetRole: item.type === "PERSON" || item.type === "OFFENE_FRAGE" ? "BD" : "TEILNEHMENDE",
        setupId: ctx.setup.id,
        reviewId: input0.reviewId ?? null,
        trigger: input0.trigger,
        sourceIds: input0.sourceIds,
        evidenceQuote: item.evidenceQuote,
        observation: item.observation,
        hypothesis: item.hypothesis || null,
        uncertainty: item.uncertainty || null,
        whyNow: item.whyNow || null,
        nextStep: item.nextStep || null,
        proposedQuestion: item.proposedQuestion || null,
        expectedResult: item.expectedResult || null,
        proposedOwnerUserId: item.proposedOwnerName ? nameToUser.get(item.proposedOwnerName) ?? null : null,
        mentionedPersonName: item.mentionedPersonName || null,
        priorityCategory: categorize(item),
        dedupeKey,
        recheckTrigger: "Neue Notiz oder neue Quelle im Setup",
        provider: info.id,
        model: info.model,
        promptVersion: STRUCTURE_NOTE_PROMPT_VERSION,
        aiJobId: job.id,
      });
      created++;
    }
    await tx.update(schema.aiJobs).set({ status: "ERFOLGREICH", itemCount: created, rejectedCount: rejected, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    await recordAudit(tx, actor, "ai.structure_text", input0.reviewId ? "REVIEW" : "SETUP", input0.reviewId ?? ctx.setup.id, { erzeugt: created, uebersprungen: skipped, zurueckgewiesen: rejected, provider: info.id });
  });
  return { job, created, skipped, rejected, repeated: false, noSuggestionReason: parsed.data.noSuggestionReason };
}

// ---------------------------------------------------------------------------
// Menschliche Entscheidung
// ---------------------------------------------------------------------------

async function requireSuggestion(actor: Actor, id: string) {
  const s = await db.query.suggestions.findFirst({ where: and(eq(schema.suggestions.id, id), eq(schema.suggestions.workspaceId, actor.workspaceId)) });
  if (!s) throw new NotFoundError("Vorschlag");
  const ctx = await loadSetupContext(actor, s.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Vorschlag");
  return { suggestion: s, ctx };
}

const transitions: Record<SuggestionStatus, SuggestionStatus[]> = {
  NEU: ["GEPRUEFT", "ANGENOMMEN", "VERAENDERT", "ZURUECKGESTELLT", "ABGELEHNT", "UEBERHOLT"],
  GEPRUEFT: ["ANGENOMMEN", "VERAENDERT", "ZURUECKGESTELLT", "ABGELEHNT", "UEBERHOLT"],
  ZURUECKGESTELLT: ["GEPRUEFT", "ANGENOMMEN", "VERAENDERT", "ABGELEHNT", "UEBERHOLT"],
  ANGENOMMEN: ["ERLEDIGT", "UEBERHOLT"],
  VERAENDERT: ["ERLEDIGT", "UEBERHOLT"],
  ABGELEHNT: [],
  ERLEDIGT: [],
  UEBERHOLT: [],
};

export const acceptInput = z.object({
  version: z.coerce.number().int().positive(),
  /** Bearbeiteter Text (→ Status „verändert“), sonst Vorschlagstext */
  editedText: z.string().trim().max(4000).optional().or(z.literal("")),
  ownerUserId: z.string().optional().or(z.literal("")),
});

/**
 * Annahme erzeugt das passende Objekt – stets im ungeprüften Zustand:
 * BEOBACHTUNG/KONFLIKT → Hinweis (neu) mit Aussage „wiedergegeben“/„Hypothese“; AKTION → Aktion „vorgeschlagen“;
 * ENTSCHEIDUNG → Entscheidung (nur wenn das Weekly noch offen ist); OFFENE_FRAGE → offene Frage; PERSON → offene Frage nach Funktion.
 * Die Annahme bestätigt nicht die Hypothese (14.5).
 */
export async function acceptSuggestion(actor: Actor, id: string, raw: unknown) {
  const parsed = acceptInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { suggestion: s, ctx } = await requireSuggestion(actor, id);
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError();
  const target: SuggestionStatus = input.editedText ? "VERAENDERT" : "ANGENOMMEN";
  if (!transitions[s.status].includes(target)) throw new TransitionError(`Vorschlag ist „${s.status}“ und kann nicht mehr angenommen werden.`);
  const text = input.editedText || s.observation;

  let acceptedObjectType = "";
  let acceptedObjectId = "";
  if (s.type === "BEOBACHTUNG" || s.type === "KONFLIKT") {
    const { signal } = await captureObservation(actor, {
      setupId: s.setupId,
      observation: text,
      relevanceHypothesis: s.hypothesis ?? "",
      usageLimit: s.type === "KONFLIKT" ? "Widerspruch zu bestätigter Aussage – beide Angaben bleiben sichtbar." : "",
      sourceTitle: `Aus Weekly-Notiz strukturiert (${s.provider})`,
      reviewId: s.reviewId ?? "",
    });
    acceptedObjectType = "SIGNAL";
    acceptedObjectId = signal.id;
  } else if (s.type === "AKTION") {
    const owner = input.ownerUserId || s.proposedOwnerUserId || actor.userId;
    // Nie „vereinbart“ aus einem Vorschlag: Aktion startet als Vorschlag (außer der Akteur übernimmt sie selbst)
    const a = await createAction(actor, { setupId: s.setupId, title: text.slice(0, 300), ownerUserId: owner, reviewId: s.reviewId ?? "", agreedInConversation: false });
    acceptedObjectType = "ACTION";
    acceptedObjectId = a.id;
  } else if (s.type === "ENTSCHEIDUNG") {
    if (!s.reviewId) throw new ValidationError("Entscheidungen brauchen ein Weekly.");
    const d = await addDecision(actor, { reviewId: s.reviewId, content: text, rationale: "Aus Weekly-Notiz strukturiert; Prüfung durch Teilnehmende bei Bestätigung des Weeklys." });
    acceptedObjectType = "DECISION";
    acceptedObjectId = d.id;
  } else {
    const [q] = await db
      .insert(schema.openQuestions)
      .values({
        workspaceId: actor.workspaceId,
        setupId: s.setupId,
        question: s.type === "PERSON" ? `Welche Funktion und Zuständigkeit hat ${s.mentionedPersonName ?? "die genannte Person"}? (${text})` : text,
        decisionImpact: s.uncertainty ?? null,
        possibleSource: s.nextStep ?? null,
        ownerUserId: input.ownerUserId || s.proposedOwnerUserId || null,
        createdBy: actor.userId,
      })
      .returning();
    if (!q) throw new Error("Offene Frage konnte nicht angelegt werden");
    acceptedObjectType = "OPEN_QUESTION";
    acceptedObjectId = q.id;
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.suggestions)
      .set({ status: target, decidedBy: actor.userId, decidedAt: new Date(), acceptedObjectType, acceptedObjectId, version: input.version + 1 })
      .where(and(eq(schema.suggestions.id, id), eq(schema.suggestions.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    await recordAudit(tx, actor, "suggestion.accepted", "SUGGESTION", id, { status: target, objekt: acceptedObjectType });
    return { suggestion: updated, acceptedObjectType, acceptedObjectId };
  });
}

export const feedbackInput = z.object({
  version: z.coerce.number().int().positive(),
  status: z.enum(["GEPRUEFT", "ZURUECKGESTELLT", "ABGELEHNT", "ERLEDIGT", "UEBERHOLT"]),
  feedbackReason: z.enum(schema.feedbackReasonEnum.enumValues).optional().or(z.literal("")),
  feedbackNote: z.string().trim().max(1000).optional().or(z.literal("")),
});

export async function giveFeedback(actor: Actor, id: string, raw: unknown) {
  const parsed = feedbackInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { suggestion: s, ctx } = await requireSuggestion(actor, id);
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError();
  if (!transitions[s.status].includes(input.status)) throw new TransitionError(`Übergang von „${s.status}“ nach „${input.status}“ ist nicht vorgesehen.`);
  if (input.status === "ABGELEHNT" && !input.feedbackReason) throw new ValidationError("Bitte einen Ablehnungsgrund wählen (hilft, Wiederholungen zu vermeiden).");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.suggestions)
      .set({ status: input.status, feedbackReason: input.feedbackReason || null, feedbackNote: input.feedbackNote || null, decidedBy: actor.userId, decidedAt: new Date(), version: input.version + 1 })
      .where(and(eq(schema.suggestions.id, id), eq(schema.suggestions.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    await recordAudit(tx, actor, "suggestion.feedback", "SUGGESTION", id, { status: input.status, grund: input.feedbackReason || null });
    return updated;
  });
}

/** Offene Vorschläge eines Setups, nach Kategorie priorisiert; die ersten `prominent` werden hervorgehoben (max. 3). */
export async function listSuggestionsForSetup(actor: Actor, setupId: string, opts: { reviewId?: string } = {}) {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  const rows = await db.query.suggestions.findMany({
    where: and(eq(schema.suggestions.setupId, setupId), opts.reviewId ? eq(schema.suggestions.reviewId, opts.reviewId) : undefined),
    orderBy: desc(schema.suggestions.computedAt),
  });
  const open = rows.filter((r) => r.status === "NEU" || r.status === "GEPRUEFT" || r.status === "ZURUECKGESTELLT").sort((a, b) => CATEGORY_ORDER[a.priorityCategory] - CATEGORY_ORDER[b.priorityCategory] || b.computedAt.getTime() - a.computedAt.getTime());
  const decided = rows.filter((r) => !open.includes(r));
  const userIds = [...new Set(rows.flatMap((r) => [r.proposedOwnerUserId, r.decidedBy].filter((x): x is string => !!x)))];
  const users = userIds.length ? await db.query.users.findMany({ where: inArray(schema.users.id, userIds) }) : [];
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  return { prominent: open.slice(0, 3), more: open.slice(3), decided, userNames: un, canDecide: canEditSetup(actor, ctx) };
}

/** Vorschläge für „Meine Arbeit“: offene Vorschläge in Setups, die der Akteur bearbeitet, bevorzugt an ihn adressiert. */
export async function listMySuggestions(actor: Actor) {
  const rows = await db.query.suggestions.findMany({
    where: and(eq(schema.suggestions.workspaceId, actor.workspaceId), or(eq(schema.suggestions.status, "NEU"), eq(schema.suggestions.status, "GEPRUEFT"))),
    orderBy: desc(schema.suggestions.computedAt),
  });
  const out = [];
  const cache = new Map<string, SetupContext | null>();
  for (const r of rows) {
    let ctx = cache.get(r.setupId);
    if (ctx === undefined) {
      ctx = await loadSetupContext(actor, r.setupId);
      cache.set(r.setupId, ctx);
    }
    if (ctx && canEditSetup(actor, ctx)) out.push({ ...r, setupName: ctx.setup.name, addressed: r.proposedOwnerUserId === actor.userId });
  }
  out.sort((a, b) => Number(b.addressed) - Number(a.addressed) || CATEGORY_ORDER[a.priorityCategory] - CATEGORY_ORDER[b.priorityCategory]);
  return out.slice(0, 10);
}

export async function listOpenQuestionsForSetup(setupId: string) {
  return db.query.openQuestions.findMany({ where: and(eq(schema.openQuestions.setupId, setupId), ne(schema.openQuestions.status, "BEANTWORTET")), orderBy: desc(schema.openQuestions.createdAt) });
}
