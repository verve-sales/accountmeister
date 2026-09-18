import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { ActionStatus } from "@/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canEditAction, canViewAction, loadSetupContext } from "@/modules/identity/authz";
import { requireEditableSetup } from "@/modules/setups/service";

/**
 * Aktion (Briefing 6.2 „Aktionen“, 9.2): Verantwortlicher, Vereinbarung, Termin, Ergebnis.
 * Eine im Protokoll genannte Idee ist keine vereinbarte Aufgabe (F07): Aktionen starten als
 * „vorgeschlagen“ und werden vom Verantwortlichen angenommen.
 */
export const createActionInput = z.object({
  setupId: z.string().min(1),
  signalId: z.string().optional().or(z.literal("")),
  title: z.string().trim().min(3, "Titel fehlt").max(300),
  agreement: z.string().trim().max(2000).optional().or(z.literal("")),
  ownerUserId: z.string().min(1, "Verantwortliche Person fehlt"),
  dueDate: z.string().optional().or(z.literal("")),
  /** true = im Gespräch gemeinsam vereinbart, direkt „angenommen“; false = Vorschlag */
  agreedInConversation: z.union([z.boolean(), z.enum(["true", "false", "on"])]).optional(),
});

export async function createAction(actor: Actor, raw: unknown) {
  const parsed = createActionInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  await requireEditableSetup(actor, input.setupId);
  const owner = await db.query.users.findFirst({ where: and(eq(schema.users.id, input.ownerUserId), eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")) });
  if (!owner) throw new ValidationError("Verantwortliche Person nicht gefunden.");
  const agreed = input.agreedInConversation === true || input.agreedInConversation === "true" || input.agreedInConversation === "on";
  // Selbst übernommene Aufgaben gelten als angenommen; fremde nur, wenn im Gespräch vereinbart.
  const status: ActionStatus = agreed || input.ownerUserId === actor.userId ? "ANGENOMMEN" : "VORGESCHLAGEN";

  return db.transaction(async (tx) => {
    const [a] = await tx
      .insert(schema.actions)
      .values({
        workspaceId: actor.workspaceId,
        setupId: input.setupId,
        signalId: input.signalId || null,
        title: input.title,
        agreement: input.agreement || null,
        ownerUserId: input.ownerUserId,
        status,
        dueDate: input.dueDate || null,
        createdBy: actor.userId,
      })
      .returning();
    if (!a) throw new Error("Aktion konnte nicht angelegt werden");
    await recordAudit(tx, actor, "action.created", "ACTION", a.id, { status, owner: input.ownerUserId });
    return a;
  });
}

const transitions: Record<ActionStatus, ActionStatus[]> = {
  VORGESCHLAGEN: ["ANGENOMMEN", "VERWORFEN"],
  ANGENOMMEN: ["IN_ARBEIT", "BLOCKIERT", "ERLEDIGT", "VERWORFEN"],
  IN_ARBEIT: ["BLOCKIERT", "ERLEDIGT", "VERWORFEN"],
  BLOCKIERT: ["IN_ARBEIT", "ERLEDIGT", "VERWORFEN"],
  ERLEDIGT: [],
  VERWORFEN: [],
};

export function assertActionTransition(from: ActionStatus, to: ActionStatus): void {
  if (!transitions[from].includes(to)) throw new TransitionError(`Übergang von „${from}“ nach „${to}“ ist nicht vorgesehen.`);
}

export const changeActionStatusInput = z.object({
  version: z.coerce.number().int().positive(),
  status: z.enum(schema.actionStatusEnum.enumValues),
  result: z.string().trim().max(4000).optional().or(z.literal("")),
});

export async function changeActionStatus(actor: Actor, actionId: string, raw: unknown) {
  const parsed = changeActionStatusInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const action = await db.query.actions.findFirst({ where: and(eq(schema.actions.id, actionId), eq(schema.actions.workspaceId, actor.workspaceId)) });
  if (!action) throw new NotFoundError("Aktion");
  const ctx = action.setupId ? await loadSetupContext(actor, action.setupId) : null;
  if (!canViewAction(actor, action, ctx)) throw new NotFoundError("Aktion");
  if (!canEditAction(actor, action, ctx)) throw new ForbiddenError();
  // Annehmen darf nur die verantwortliche Person selbst.
  if (input.status === "ANGENOMMEN" && action.status === "VORGESCHLAGEN" && action.ownerUserId !== actor.userId) {
    throw new ForbiddenError("Nur die verantwortliche Person kann eine vorgeschlagene Aktion annehmen.");
  }
  assertActionTransition(action.status, input.status);
  // „Erledigt“ dokumentiert das Ergebnis (9.3).
  if (input.status === "ERLEDIGT" && !input.result) throw new ValidationError("Bitte das Ergebnis dokumentieren, bevor die Aktion als erledigt gilt.");
  if (input.status === "BLOCKIERT" && !input.result) throw new ValidationError("Bitte kurz festhalten, was blockiert.");

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.actions)
      .set({ status: input.status, result: input.result || action.result, version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.actions.id, actionId), eq(schema.actions.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    await recordAudit(tx, actor, "action.status_changed", "ACTION", actionId, { von: action.status, nach: input.status });
    return updated;
  });
}

/** Offene Aktionen des Akteurs für „Meine Arbeit“. */
export async function listMyOpenActions(actor: Actor) {
  const rows = await db.query.actions.findMany({
    where: and(eq(schema.actions.workspaceId, actor.workspaceId), eq(schema.actions.ownerUserId, actor.userId), ne(schema.actions.status, "ERLEDIGT"), ne(schema.actions.status, "VERWORFEN")),
    orderBy: [asc(schema.actions.dueDate), asc(schema.actions.createdAt)],
  });
  const setupIds = [...new Set(rows.map((r) => r.setupId).filter((x): x is string => !!x))];
  const setups = setupIds.length ? await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.id, setupIds) }) : [];
  const names = new Map(setups.map((s) => [s.id, s.name]));
  return rows.map((r) => ({ ...r, setupName: r.setupId ? names.get(r.setupId) ?? "" : "" }));
}
