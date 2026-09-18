import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { SignalStatus } from "@/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, loadSetupContext } from "@/modules/identity/authz";
import { requireEditableSetup } from "@/modules/setups/service";

/**
 * „Beobachtung erfassen“ (Briefing 18.2, A3 Signalnotiz): Beobachtung, Quelle, Zeitpunkt,
 * sichere Aussage, Vermutung, Nutzungsgrenze. Eine Beobachtung ist KEIN bestätigter Bedarf.
 */
export const captureObservationInput = z.object({
  setupId: z.string().min(1),
  observation: z.string().trim().min(5, "Bitte die Beobachtung in einem Satz beschreiben.").max(4000),
  relevanceHypothesis: z.string().trim().max(2000).optional().or(z.literal("")),
  usageLimit: z.string().trim().max(500).optional().or(z.literal("")),
  sourceTitle: z.string().trim().max(200).optional().or(z.literal("")),
  sourceTime: z.string().optional().or(z.literal("")), // ISO-Datum/-Zeit aus dem Formular
  sourceAccessClass: z.enum(schema.accessClassEnum.enumValues).default("SETUP"),
  reviewId: z.string().optional().or(z.literal("")), // im Weekly erfasst
});

export async function captureObservation(actor: Actor, raw: unknown) {
  const parsed = captureObservationInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  await requireEditableSetup(actor, input.setupId);

  return db.transaction(async (tx) => {
    // Jede Beobachtung erhält eine Quelle (Notiz), damit „Quelle ansehen“ immer möglich ist.
    const [source] = await tx
      .insert(schema.sources)
      .values({
        workspaceId: actor.workspaceId,
        setupId: input.setupId,
        type: "NOTIZ",
        title: input.sourceTitle || (input.reviewId ? `Weekly-Notiz ${actor.displayName}` : `Beobachtung von ${actor.displayName}`),
        body: [input.observation, input.relevanceHypothesis ? `Vermutung: ${input.relevanceHypothesis}` : null].filter(Boolean).join("\n\n"),
        origin: "manuell",
        sourceTime: input.sourceTime ? new Date(input.sourceTime) : new Date(),
        ownerUserId: actor.userId,
        accessClass: input.sourceAccessClass,
      })
      .returning();
    if (!source) throw new Error("Quelle konnte nicht angelegt werden");

    const [signal] = await tx
      .insert(schema.signals)
      .values({
        workspaceId: actor.workspaceId,
        setupId: input.setupId,
        observation: input.observation,
        relevanceHypothesis: input.relevanceHypothesis || null,
        usageLimit: input.usageLimit || null,
        status: "NEU",
        sourceId: source.id,
        reviewId: input.reviewId || null,
        createdBy: actor.userId,
      })
      .returning();
    if (!signal) throw new Error("Hinweis konnte nicht angelegt werden");

    // Die Beobachtung selbst als Aussage mit Status „Aussage korrekt wiedergegeben“ (15.3) festhalten.
    const [assertion] = await tx
      .insert(schema.assertions)
      .values({
        workspaceId: actor.workspaceId,
        setupId: input.setupId,
        subjectType: "SETUP",
        subjectId: input.setupId,
        content: input.observation,
        epistemicStatus: "AUSSAGE_WIEDERGEGEBEN",
        createdBy: actor.userId,
      })
      .returning();
    if (assertion) await tx.insert(schema.assertionEvidence).values({ assertionId: assertion.id, sourceId: source.id, excerpt: input.observation.slice(0, 500) });
    if (input.relevanceHypothesis) {
      const [hyp] = await tx
        .insert(schema.assertions)
        .values({
          workspaceId: actor.workspaceId,
          setupId: input.setupId,
          subjectType: "SETUP",
          subjectId: input.setupId,
          content: input.relevanceHypothesis,
          epistemicStatus: "HYPOTHESE",
          createdBy: actor.userId,
        })
        .returning();
      if (hyp) await tx.insert(schema.assertionEvidence).values({ assertionId: hyp.id, sourceId: source.id, evidenceKind: "KONTEXT" });
    }

    await recordAudit(tx, actor, "signal.created", "SIGNAL", signal.id, { setupId: input.setupId });
    return { signal, source };
  });
}

const allowedTransitions: Record<SignalStatus, SignalStatus[]> = {
  NEU: ["PRUEFUNG_UEBERNOMMEN", "ZURUECKGESTELLT", "BEENDET"],
  PRUEFUNG_UEBERNOMMEN: ["IN_KLAERUNG", "ZURUECKGESTELLT", "BEENDET"],
  IN_KLAERUNG: ["MIT_BEDARF_VERKNUEPFT", "ZURUECKGESTELLT", "BEENDET"],
  MIT_BEDARF_VERKNUEPFT: ["BEENDET"],
  ZURUECKGESTELLT: ["PRUEFUNG_UEBERNOMMEN", "IN_KLAERUNG", "BEENDET"],
  BEENDET: [],
};

export function assertSignalTransition(from: SignalStatus, to: SignalStatus): void {
  if (!allowedTransitions[from].includes(to)) throw new TransitionError(`Übergang von „${from}“ nach „${to}“ ist nicht vorgesehen.`);
}

export async function requireSignal(actor: Actor, signalId: string) {
  const signal = await db.query.signals.findFirst({ where: and(eq(schema.signals.id, signalId), eq(schema.signals.workspaceId, actor.workspaceId)) });
  if (!signal) throw new NotFoundError("Hinweis");
  const ctx = await loadSetupContext(actor, signal.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Hinweis");
  return { signal, ctx };
}

/**
 * Prüfung übernehmen: Der Akteur wird Owner des Hinweises. Zulässig für Bearbeitende des Setups.
 * Die Übernahme durch eine andere Person läuft über eine angenommene Übergabe (handovers/service.ts).
 */
export async function takeOverSignal(actor: Actor, signalId: string, expectedVersion: number) {
  const { signal, ctx } = await requireSignal(actor, signalId);
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Sie sind an diesem Setup nicht bearbeitend beteiligt.");
  assertSignalTransition(signal.status, "PRUEFUNG_UEBERNOMMEN");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.signals)
      .set({ status: "PRUEFUNG_UEBERNOMMEN", ownerUserId: actor.userId, version: expectedVersion + 1, updatedAt: new Date() })
      .where(and(eq(schema.signals.id, signalId), eq(schema.signals.version, expectedVersion)))
      .returning();
    if (!updated) throw new ConflictError();
    await recordAudit(tx, actor, "signal.taken_over", "SIGNAL", signalId);
    return updated;
  });
}

export const changeSignalStatusInput = z.object({
  version: z.coerce.number().int().positive(),
  status: z.enum(schema.signalStatusEnum.enumValues),
  closedReason: z.string().trim().max(1000).optional().or(z.literal("")),
});

export async function changeSignalStatus(actor: Actor, signalId: string, raw: unknown) {
  const parsed = changeSignalStatusInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { signal, ctx } = await requireSignal(actor, signalId);
  const isOwner = signal.ownerUserId === actor.userId;
  if (!isOwner && !canEditSetup(actor, ctx)) throw new ForbiddenError();
  assertSignalTransition(signal.status, input.status);
  if ((input.status === "BEENDET" || input.status === "ZURUECKGESTELLT") && !input.closedReason) {
    throw new ValidationError("Bitte begründen, warum der Hinweis beendet bzw. zurückgestellt wird.");
  }
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.signals)
      .set({
        status: input.status,
        closedReason: input.closedReason || null,
        ownerUserId: signal.ownerUserId ?? (input.status === "PRUEFUNG_UEBERNOMMEN" ? actor.userId : null),
        version: input.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.signals.id, signalId), eq(schema.signals.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    await recordAudit(tx, actor, "signal.status_changed", "SIGNAL", signalId, { von: signal.status, nach: input.status });
    return updated;
  });
}
