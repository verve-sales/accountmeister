import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { NotFoundError, ForbiddenError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canCreateAccount, canViewAccount } from "@/modules/identity/authz";

export const createAccountInput = z.object({
  name: z.string().trim().min(2, "Kundenname ist zu kurz").max(200),
  orgType: z.enum(schema.orgTypeEnum.enumValues).default("SONSTIGE"),
  parentAccountId: z.string().optional().nullable(),
  responsibleBdUserId: z.string().optional().nullable(),
});

export async function createAccount(actor: Actor, raw: unknown) {
  if (!canCreateAccount(actor)) throw new ForbiddenError("Nur BD oder Principal legen Kunden an.");
  const parsed = createAccountInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.accounts)
      .values({
        workspaceId: actor.workspaceId,
        name: input.name,
        orgType: input.orgType,
        parentAccountId: input.parentAccountId ?? null,
        responsibleBdUserId: input.responsibleBdUserId ?? null,
        createdBy: actor.userId,
      })
      .returning();
    if (!row) throw new Error("Anlage fehlgeschlagen");
    // Zuständiger BD erhält automatisch die Account-Rolle BD (falls noch nicht vorhanden)
    if (input.responsibleBdUserId) {
      await tx.insert(schema.roleAssignments).values({
        workspaceId: actor.workspaceId,
        userId: input.responsibleBdUserId,
        role: "BD",
        scope: "ACCOUNT",
        accountId: row.id,
      });
    }
    await recordAudit(tx, actor, "account.created", "ACCOUNT", row.id, { name: row.name });
    return row;
  });
}

/** Kunden, die der Akteur sehen darf – gefiltert nach Berechtigung, nicht nur nach Existenz. */
export async function listVisibleAccounts(actor: Actor) {
  const all = await db.query.accounts.findMany({
    where: and(eq(schema.accounts.workspaceId, actor.workspaceId)),
    orderBy: (a, { asc }) => [asc(a.name)],
  });
  // Mitglieder eines Setups sehen dessen Kunden (zusammenfassend)
  const memberSetups = await db
    .select({ accountId: schema.projectSetups.accountId })
    .from(schema.setupMemberships)
    .innerJoin(schema.projectSetups, eq(schema.projectSetups.id, schema.setupMemberships.setupId))
    .where(eq(schema.setupMemberships.userId, actor.userId));
  const memberAccountIds = new Set(memberSetups.map((m) => m.accountId));
  return all.filter((a) => canViewAccount(actor, a) || memberAccountIds.has(a.id));
}

export async function getAccount(actor: Actor, accountId: string) {
  const account = await db.query.accounts.findFirst({
    where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.workspaceId, actor.workspaceId)),
  });
  if (!account) throw new NotFoundError("Kunde");
  if (!canViewAccount(actor, account)) {
    const member = await db
      .select({ id: schema.projectSetups.id })
      .from(schema.setupMemberships)
      .innerJoin(schema.projectSetups, eq(schema.projectSetups.id, schema.setupMemberships.setupId))
      .where(and(eq(schema.setupMemberships.userId, actor.userId), eq(schema.projectSetups.accountId, accountId)))
      .limit(1);
    if (member.length === 0) throw new NotFoundError("Kunde");
  }
  return account;
}

export async function getUsersByIds(userIds: string[]) {
  if (userIds.length === 0) return [];
  return db.query.users.findMany({ where: inArray(schema.users.id, userIds) });
}
