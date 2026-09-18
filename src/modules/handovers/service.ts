import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canEditSetup, isParty, loadSetupContext } from "@/modules/identity/authz";
import { assertSignalTransition } from "@/modules/signals/service";

/**
 * Übergabe (Briefing 10.1 / A4): handlungsfähig nur mit Kontext, Belegt/Offen, erlaubter Nutzung,
 * konkreter Verantwortung, Sender/Empfänger, Rückmeldeweg. Erst die Annahme begründet die Übernahme.
 */
export const createHandoverInput = z.object({
  subjectType: z.enum(schema.handoverSubjectEnum.enumValues),
  subjectId: z.string().min(1),
  receiverUserId: z.string().min(1, "Empfänger fehlt"),
  context: z.string().trim().min(5, "Kontext fehlt").max(4000),
  proven: z.string().trim().max(4000).optional().or(z.literal("")),
  open: z.string().trim().max(4000).optional().or(z.literal("")),
  allowedUse: z.string().trim().max(2000).optional().or(z.literal("")),
  responsibility: z.string().trim().min(5, "Bitte die zu übernehmende Verantwortung konkret benennen.").max(2000),
  nextStep: z.string().trim().max(2000).optional().or(z.literal("")),
  dueDate: z.string().optional().or(z.literal("")),
  feedbackChannel: z.string().trim().max(500).optional().or(z.literal("")),
});

export async function createHandover(actor: Actor, raw: unknown) {
  const parsed = createHandoverInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;

  // F05: keine Selbstübergabe (Doppelrolle Anker+BD erzeugt keine künstlichen Übergaben an sich selbst).
  if (input.receiverUserId === actor.userId) throw new ValidationError("Eine Übergabe an sich selbst ist nicht vorgesehen. Übernehmen Sie den Hinweis direkt.");

  const receiver = await db.query.users.findFirst({ where: and(eq(schema.users.id, input.receiverUserId), eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")) });
  if (!receiver) throw new ValidationError("Empfänger nicht gefunden oder inaktiv.");

  const setupId = await resolveSetupId(actor, input.subjectType, input.subjectId);
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canEditSetup(actor, ctx)) throw new ForbiddenError("Sie dürfen aus diesem Setup keine Übergabe erstellen.");

  return db.transaction(async (tx) => {
    const [h] = await tx
      .insert(schema.handovers)
      .values({
        workspaceId: actor.workspaceId,
        setupId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        senderUserId: actor.userId,
        receiverUserId: input.receiverUserId,
        context: input.context,
        proven: input.proven || null,
        open: input.open || null,
        allowedUse: input.allowedUse || null,
        responsibility: input.responsibility,
        nextStep: input.nextStep || null,
        dueDate: input.dueDate || null,
        feedbackChannel: input.feedbackChannel || null,
        status: "ANGEFRAGT",
      })
      .returning();
    if (!h) throw new Error("Übergabe konnte nicht angelegt werden");
    await recordAudit(tx, actor, "handover.requested", "HANDOVER", h.id, { subjectType: input.subjectType, subjectId: input.subjectId, receiver: input.receiverUserId });
    return h;
  });
}

async function resolveSetupId(actor: Actor, subjectType: "SIGNAL" | "SETUP" | "AKTION", subjectId: string): Promise<string> {
  if (subjectType === "SETUP") return subjectId;
  if (subjectType === "SIGNAL") {
    const s = await db.query.signals.findFirst({ where: and(eq(schema.signals.id, subjectId), eq(schema.signals.workspaceId, actor.workspaceId)) });
    if (!s) throw new NotFoundError("Hinweis");
    return s.setupId;
  }
  const a = await db.query.actions.findFirst({ where: and(eq(schema.actions.id, subjectId), eq(schema.actions.workspaceId, actor.workspaceId)) });
  if (!a || !a.setupId) throw new NotFoundError("Aktion");
  return a.setupId;
}

async function requireHandover(actor: Actor, handoverId: string) {
  const h = await db.query.handovers.findFirst({ where: and(eq(schema.handovers.id, handoverId), eq(schema.handovers.workspaceId, actor.workspaceId)) });
  if (!h || !isParty(actor, h)) throw new NotFoundError("Übergabe");
  return h;
}

export const respondHandoverInput = z.object({
  version: z.coerce.number().int().positive(),
  decision: z.enum(["ANNEHMEN", "ZURUECKGEBEN", "ABSCHLIESSEN"]),
  responseNote: z.string().trim().max(2000).optional().or(z.literal("")),
});

/**
 * Empfänger nimmt an oder gibt begründet zurück. Bei Annahme eines SIGNAL-Subjekts wird der Empfänger
 * Owner des Hinweises (Status „Prüfung übernommen“). Bis dahin bleibt die bisherige Zuständigkeit sichtbar.
 */
export async function respondToHandover(actor: Actor, handoverId: string, raw: unknown) {
  const parsed = respondHandoverInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const h = await requireHandover(actor, handoverId);

  if (input.decision === "ABSCHLIESSEN") {
    if (h.status !== "ANGENOMMEN") throw new TransitionError("Nur angenommene Übergaben können abgeschlossen werden.");
    if (!input.responseNote) throw new ValidationError("Bitte das Ergebnis der Übergabe dokumentieren (Rückmeldung).");
  } else {
    if (h.receiverUserId !== actor.userId) throw new ForbiddenError("Nur der Empfänger kann annehmen oder zurückgeben.");
    if (h.status !== "ANGEFRAGT") throw new TransitionError("Diese Übergabe ist nicht mehr offen.");
    if (input.decision === "ZURUECKGEBEN" && !input.responseNote) throw new ValidationError("Bitte die Rückgabe begründen.");
  }

  const newStatus = input.decision === "ANNEHMEN" ? "ANGENOMMEN" : input.decision === "ZURUECKGEBEN" ? "ZURUECKGEGEBEN" : "ABGESCHLOSSEN";

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.handovers)
      .set({ status: newStatus, responseNote: input.responseNote || null, respondedAt: new Date(), version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.handovers.id, handoverId), eq(schema.handovers.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();

    if (input.decision === "ANNEHMEN" && h.subjectType === "SIGNAL") {
      const signal = await tx.query.signals.findFirst({ where: eq(schema.signals.id, h.subjectId) });
      if (signal && signal.status !== "BEENDET") {
        const target = signal.status === "NEU" || signal.status === "ZURUECKGESTELLT" ? "PRUEFUNG_UEBERNOMMEN" : signal.status;
        if (target !== signal.status) assertSignalTransition(signal.status, target);
        await tx
          .update(schema.signals)
          .set({ ownerUserId: actor.userId, status: target, version: signal.version + 1, updatedAt: new Date() })
          .where(and(eq(schema.signals.id, signal.id), eq(schema.signals.version, signal.version)));
        // Empfänger wird – falls noch nicht – bearbeitendes Mitglied des Setups.
        await tx
          .insert(schema.setupMemberships)
          .values({ setupId: signal.setupId, userId: actor.userId, contribution: "BD_ZUSTAENDIG", canEdit: true })
          .onConflictDoNothing();
      }
    }
    if (input.decision === "ANNEHMEN" && h.subjectType === "SETUP") {
      const setup = await tx.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, h.subjectId) });
      if (setup && !setup.bdUserId) {
        await tx.update(schema.projectSetups).set({ bdUserId: actor.userId, version: setup.version + 1, updatedAt: new Date() }).where(eq(schema.projectSetups.id, setup.id));
        await tx.insert(schema.setupMemberships).values({ setupId: setup.id, userId: actor.userId, contribution: "BD_ZUSTAENDIG", canEdit: true }).onConflictDoNothing();
      }
    }
    await recordAudit(tx, actor, `handover.${newStatus.toLowerCase()}`, "HANDOVER", handoverId);
    return updated;
  });
}

export async function listMyHandovers(actor: Actor) {
  const rows = await db.query.handovers.findMany({
    where: and(eq(schema.handovers.workspaceId, actor.workspaceId), or(eq(schema.handovers.receiverUserId, actor.userId), eq(schema.handovers.senderUserId, actor.userId))),
    orderBy: desc(schema.handovers.createdAt),
  });
  const userIds = [...new Set(rows.flatMap((r) => [r.senderUserId, r.receiverUserId]))];
  const users = userIds.length ? await db.query.users.findMany({ where: inArray(schema.users.id, userIds) }) : [];
  const names = new Map(users.map((u) => [u.id, u.displayName]));
  return rows.map((r) => ({ ...r, senderName: names.get(r.senderUserId) ?? "?", receiverName: names.get(r.receiverUserId) ?? "?" }));
}
