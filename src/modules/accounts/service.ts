import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ConflictError, NotFoundError, ForbiddenError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { assertCanCarryResponsibility, canCreateAccount, canReassignResponsibility, canViewAccount } from "@/modules/identity/authz";

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
  // Verantwortliche einer Chance sehen den Kunden (zusammenfassend), auch ohne Setup-Beteiligung
  const ownedOpps = await db.select({ accountId: schema.opportunities.accountId }).from(schema.opportunities).where(and(eq(schema.opportunities.workspaceId, actor.workspaceId), eq(schema.opportunities.ownerUserId, actor.userId)));
  const memberAccountIds = new Set([...memberSetups.map((m) => m.accountId), ...ownedOpps.map((o) => o.accountId)]);
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
    if (member.length === 0) {
      const owned = await db.query.opportunities.findFirst({ where: and(eq(schema.opportunities.accountId, accountId), eq(schema.opportunities.ownerUserId, actor.userId)), columns: { id: true } });
      if (!owned) throw new NotFoundError("Kunde");
    }
  }
  return account;
}

export const reassignAccountBdInput = z.object({
  version: z.coerce.number().int().positive(),
  responsibleBdUserId: z.string().min(1, "Bitte einen zuständigen BD wählen."),
});

/**
 * Delegation (Briefing-Nachtrag, Etappe 19): der zugeordnete Principal (oder CEO oder der bisher zuständige BD)
 * kann die Kundenzuständigkeit jederzeit umstellen – bisher war responsibleBdUserId nur bei Anlage setzbar,
 * was BD-Zuordnungen faktisch dauerhaft festlegte.
 */
export async function reassignAccountBd(actor: Actor, accountId: string, raw: unknown) {
  const parsed = reassignAccountBdInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const account = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.workspaceId, actor.workspaceId)) });
  if (!account) throw new NotFoundError("Kunde");
  if (!canReassignResponsibility(actor, account)) throw new ForbiddenError("Sie dürfen die Kundenzuständigkeit hier nicht umstellen.");
  if (account.responsibleBdUserId === input.responsibleBdUserId) throw new ValidationError("Diese Person ist bereits zuständig.");
  const newBd = await db.query.users.findFirst({ where: and(eq(schema.users.id, input.responsibleBdUserId), eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")) });
  if (!newBd) throw new ValidationError("Person nicht gefunden oder inaktiv.");
  await assertCanCarryResponsibility(input.responsibleBdUserId);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.accounts)
      .set({ responsibleBdUserId: input.responsibleBdUserId, version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    // Neuer BD erhält automatisch die kundenbezogene Rolle, falls noch nicht vorhanden (wie bei Anlage).
    const hasBdRole = await tx.query.roleAssignments.findFirst({
      where: and(eq(schema.roleAssignments.userId, input.responsibleBdUserId), eq(schema.roleAssignments.role, "BD"), eq(schema.roleAssignments.accountId, accountId)),
    });
    if (!hasBdRole) {
      await tx.insert(schema.roleAssignments).values({ workspaceId: actor.workspaceId, userId: input.responsibleBdUserId, role: "BD", scope: "ACCOUNT", accountId });
    }
    await recordAudit(tx, actor, "account.bd_reassigned", "ACCOUNT", accountId, { von: account.responsibleBdUserId, nach: input.responsibleBdUserId });
    return updated;
  });
}

export async function getUsersByIds(userIds: string[]) {
  if (userIds.length === 0) return [];
  return db.query.users.findMany({ where: inArray(schema.users.id, userIds) });
}
