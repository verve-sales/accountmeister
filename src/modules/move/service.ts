import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canEditAction, canEditSetup, canViewAction, loadSetupContext } from "@/modules/identity/authz";

/**
 * Falsch zugeordnete Aufgaben und Beobachtungen umhängen (e47): Die KI hat sie manchmal dem falschen Setup oder
 * sogar dem falschen Kunden zugeordnet. Verschoben wird ohne Begründung; der Bezug zu einer Chance des alten Setups
 * fällt weg, weil er dort nicht mehr passt.
 */
export const movableKinds = ["ACTION", "SIGNAL"] as const;
export type MovableKind = (typeof movableKinds)[number];

async function target(actor: Actor, setupId: string) {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canEditSetup(actor, ctx)) throw new ValidationError("Ziel-Setup nicht gefunden oder nicht bearbeitbar.");
  return ctx;
}

export async function moveToSetup(actor: Actor, kind: MovableKind, id: string, targetSetupId: string) {
  if (!targetSetupId) throw new ValidationError("Bitte das richtige Setup wählen.");
  if (kind === "ACTION") {
    const a = await db.query.actions.findFirst({ where: and(eq(schema.actions.id, id), eq(schema.actions.workspaceId, actor.workspaceId)) });
    if (!a) throw new NotFoundError("Aufgabe");
    const ctx = a.setupId ? await loadSetupContext(actor, a.setupId) : null;
    if (!canViewAction(actor, a, ctx)) throw new NotFoundError("Aufgabe");
    if (!canEditAction(actor, a, ctx)) throw new ForbiddenError();
    if (a.setupId === targetSetupId) return { setupId: targetSetupId, changed: false };
    const t = await target(actor, targetSetupId);
    await db.update(schema.actions).set({ setupId: t.setup.id, opportunityId: null, version: a.version + 1, updatedAt: new Date() }).where(eq(schema.actions.id, a.id));
    await recordAudit(db, actor, "action.moved", "ACTION", a.id, { von: a.setupId, nach: t.setup.id });
    return { setupId: t.setup.id, changed: true };
  }
  const s = await db.query.signals.findFirst({ where: and(eq(schema.signals.id, id), eq(schema.signals.workspaceId, actor.workspaceId)) });
  if (!s) throw new NotFoundError("Beobachtung");
  const from = await loadSetupContext(actor, s.setupId);
  if (!from || !(canEditSetup(actor, from) || s.ownerUserId === actor.userId)) throw new ForbiddenError();
  if (s.setupId === targetSetupId) return { setupId: targetSetupId, changed: false };
  const t = await target(actor, targetSetupId);
  await db.update(schema.signals).set({ setupId: t.setup.id, opportunityId: null, version: s.version + 1, updatedAt: new Date() }).where(eq(schema.signals.id, s.id));
  await recordAudit(db, actor, "signal.moved", "SIGNAL", s.id, { von: s.setupId, nach: t.setup.id });
  return { setupId: t.setup.id, changed: true };
}
