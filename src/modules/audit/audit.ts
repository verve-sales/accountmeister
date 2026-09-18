import { schema, type Db, type Tx } from "@/db/client";
import type { Actor } from "@/modules/identity/actor";

export async function recordAudit(
  tx: Tx | Db,
  actor: Actor,
  action: string,
  objectType: string,
  objectId: string,
  changes?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    action,
    objectType,
    objectId,
    changes: changes ?? null,
  });
}
