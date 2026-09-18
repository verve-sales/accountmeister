import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { NotFoundError } from "@/lib/errors";
import type { Actor } from "@/modules/identity/actor";
import { canViewSource, loadSetupContext } from "@/modules/identity/authz";

/** „Quelle ansehen“ – Originalquelle nur mit passender Berechtigung (13.5, 16.2). */
export async function getSource(actor: Actor, sourceId: string) {
  const source = await db.query.sources.findFirst({ where: and(eq(schema.sources.id, sourceId), eq(schema.sources.workspaceId, actor.workspaceId)) });
  if (!source) throw new NotFoundError("Quelle");
  const ctx = source.setupId ? await loadSetupContext(actor, source.setupId) : null;
  if (!canViewSource(actor, source, ctx)) throw new NotFoundError("Quelle");
  const owner = await db.query.users.findFirst({ where: eq(schema.users.id, source.ownerUserId) });
  const evidence = await db
    .select({ assertionId: schema.assertionEvidence.assertionId, content: schema.assertions.content, epistemicStatus: schema.assertions.epistemicStatus })
    .from(schema.assertionEvidence)
    .innerJoin(schema.assertions, eq(schema.assertions.id, schema.assertionEvidence.assertionId))
    .where(eq(schema.assertionEvidence.sourceId, sourceId));
  return { source, ownerName: owner?.displayName ?? "?", setup: ctx?.setup ?? null, evidence };
}
