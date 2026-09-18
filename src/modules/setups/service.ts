import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canCreateSetup, canEditSetup, canViewSetup, canViewSource, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { getAccount } from "@/modules/accounts/service";
import { getSinceForSetup, listReviewsForSetup } from "@/modules/reviews/service";

/**
 * Anlage eines Projektsetups (Briefing 6.1): minimal Kunde, Name, Kontextsatz ODER bewusster Entwurf,
 * Ersteller und Sichtbarkeit. BD-Zuordnung darf offen bleiben („Zuordnung offen“).
 */
export const createSetupInput = z.object({
  accountId: z.string().min(1),
  name: z.string().trim().min(3, "Setup-Name ist zu kurz").max(200),
  contextNote: z.string().trim().max(2000).optional().or(z.literal("")),
  visibility: z.enum(schema.setupVisibilityEnum.enumValues).default("MITGLIEDER"),
  bdUserId: z.string().optional().nullable().or(z.literal("")),
  creatorContribution: z.enum(schema.membershipContributionEnum.enumValues).default("ANKER_KONTEXT"),
  contributionNote: z.string().trim().max(500).optional().or(z.literal("")),
});

export async function createSetup(actor: Actor, raw: unknown) {
  const parsed = createSetupInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const account = await getAccount(actor, input.accountId);
  if (!canCreateSetup(actor, account)) throw new ForbiddenError("Für diesen Kunden dürfen Sie kein Setup anlegen.");
  const bdUserId = input.bdUserId ? input.bdUserId : null;

  return db.transaction(async (tx) => {
    const [setup] = await tx
      .insert(schema.projectSetups)
      .values({
        workspaceId: actor.workspaceId,
        accountId: account.id,
        name: input.name,
        contextNote: input.contextNote ? input.contextNote : null,
        status: input.contextNote ? "AKTIV" : "ENTWURF",
        visibility: input.visibility,
        bdUserId,
        createdBy: actor.userId,
      })
      .returning();
    if (!setup) throw new Error("Anlage fehlgeschlagen");

    // Ersteller wird Mitglied mit dem vereinbarten Beitrag.
    await tx.insert(schema.setupMemberships).values({
      setupId: setup.id,
      userId: actor.userId,
      contribution: bdUserId === actor.userId ? "BD_ZUSTAENDIG" : input.creatorContribution,
      contributionNote: input.contributionNote || null,
      canEdit: true,
    });
    // Zugeordneter BD wird Mitglied (Doppelrolle: keine zweite Mitgliedschaft für dieselbe Person).
    if (bdUserId && bdUserId !== actor.userId) {
      await tx.insert(schema.setupMemberships).values({ setupId: setup.id, userId: bdUserId, contribution: "BD_ZUSTAENDIG", canEdit: true });
    }
    await recordAudit(tx, actor, "setup.created", "SETUP", setup.id, { name: setup.name, bdZugeordnet: bdUserId !== null });
    return setup;
  });
}

export async function requireSetupContext(actor: Actor, setupId: string): Promise<SetupContext> {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  return ctx;
}

export async function requireEditableSetup(actor: Actor, setupId: string): Promise<SetupContext> {
  const ctx = await requireSetupContext(actor, setupId);
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Sie dürfen dieses Setup nicht bearbeiten.");
  return ctx;
}

export const updateSetupInput = z.object({
  version: z.coerce.number().int().positive(),
  name: z.string().trim().min(3).max(200).optional(),
  contextNote: z.string().trim().max(2000).optional(),
  status: z.enum(schema.setupStatusEnum.enumValues).optional(),
  visibility: z.enum(schema.setupVisibilityEnum.enumValues).optional(),
});

export async function updateSetup(actor: Actor, setupId: string, raw: unknown) {
  const parsed = updateSetupInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  await requireEditableSetup(actor, setupId);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.projectSetups)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.contextNote !== undefined ? { contextNote: input.contextNote || null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        version: input.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.projectSetups.id, setupId), eq(schema.projectSetups.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    await recordAudit(tx, actor, "setup.updated", "SETUP", setupId, { felder: Object.keys(input).filter((k) => k !== "version") });
    return updated;
  });
}

/** Zusammenstellung für die Setup-Seite: vier Abschnitte (6.3) + Details. */
export async function getSetupDetail(actor: Actor, setupId: string) {
  const ctx = await requireSetupContext(actor, setupId);
  const [members, signals, actions, sources, handovers] = await Promise.all([
    db
      .select({
        userId: schema.setupMemberships.userId,
        contribution: schema.setupMemberships.contribution,
        contributionNote: schema.setupMemberships.contributionNote,
        canEdit: schema.setupMemberships.canEdit,
        displayName: schema.users.displayName,
      })
      .from(schema.setupMemberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.setupMemberships.userId))
      .where(eq(schema.setupMemberships.setupId, setupId)),
    db.query.signals.findMany({ where: eq(schema.signals.setupId, setupId), orderBy: desc(schema.signals.createdAt) }),
    db.query.actions.findMany({ where: eq(schema.actions.setupId, setupId), orderBy: desc(schema.actions.createdAt) }),
    db.query.sources.findMany({ where: eq(schema.sources.setupId, setupId), orderBy: desc(schema.sources.createdAt) }),
    db.query.handovers.findMany({ where: eq(schema.handovers.setupId, setupId), orderBy: desc(schema.handovers.createdAt) }),
  ]);
  const [sinceInfo, reviews] = await Promise.all([getSinceForSetup(setupId), listReviewsForSetup(setupId)]);
  const visibleSources = sources.filter((s) => canViewSource(actor, s, ctx));
  const hiddenSourceCount = sources.length - visibleSources.length;
  const userIds = new Set<string>();
  for (const s of signals) {
    userIds.add(s.createdBy);
    if (s.ownerUserId) userIds.add(s.ownerUserId);
  }
  for (const a of actions) userIds.add(a.ownerUserId);
  for (const h of handovers) {
    userIds.add(h.senderUserId);
    userIds.add(h.receiverUserId);
  }
  if (ctx.setup.bdUserId) userIds.add(ctx.setup.bdUserId);
  const users = userIds.size ? await db.query.users.findMany({ where: inArray(schema.users.id, [...userIds]) }) : [];
  const userNames = new Map(users.map((u) => [u.id, u.displayName]));
  return {
    ...ctx,
    // „Was hat sich geändert?“ bezieht sich auf den letzten bestätigten Weekly-Stand (Briefing 6.3).
    recentSince: sinceInfo.since ?? new Date(0),
    recentLabel: sinceInfo.label,
    reviews,
    canEdit: canEditSetup(actor, ctx),
    members,
    signals,
    actions,
    sources: visibleSources,
    hiddenSourceCount,
    handovers,
    userNames,
  };
}

/** Setups in der Eingangsliste: BD-Zuordnung offen, für den Akteur sichtbar (5. Eingang). */
export async function listSetupsWithOpenAssignment(actor: Actor) {
  const rows = await db.query.projectSetups.findMany({
    where: and(eq(schema.projectSetups.workspaceId, actor.workspaceId), isNull(schema.projectSetups.bdUserId)),
    orderBy: desc(schema.projectSetups.createdAt),
  });
  const result = [];
  for (const setup of rows) {
    const ctx = await loadSetupContext(actor, setup.id);
    if (ctx && canViewSetup(actor, ctx)) result.push({ setup, account: ctx.account });
  }
  return result;
}

/** Setups, an denen der Akteur beteiligt ist oder die er als BD verantwortet. */
export async function listMySetups(actor: Actor) {
  const memberRows = await db
    .select({ setupId: schema.setupMemberships.setupId })
    .from(schema.setupMemberships)
    .where(eq(schema.setupMemberships.userId, actor.userId));
  const ids = memberRows.map((r) => r.setupId);
  const setups = await db.query.projectSetups.findMany({
    where: and(
      eq(schema.projectSetups.workspaceId, actor.workspaceId),
      or(ids.length ? inArray(schema.projectSetups.id, ids) : undefined, eq(schema.projectSetups.bdUserId, actor.userId), eq(schema.projectSetups.createdBy, actor.userId)),
    ),
    orderBy: desc(schema.projectSetups.updatedAt),
  });
  const accountIds = [...new Set(setups.map((s) => s.accountId))];
  const accounts = accountIds.length ? await db.query.accounts.findMany({ where: inArray(schema.accounts.id, accountIds) }) : [];
  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));
  return setups.map((s) => ({ ...s, accountName: accountNames.get(s.accountId) ?? "" }));
}

export async function listSetupsForAccount(actor: Actor, accountId: string) {
  await getAccount(actor, accountId);
  const rows = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, accountId), orderBy: desc(schema.projectSetups.updatedAt) });
  const visible = [];
  for (const setup of rows) {
    const ctx = await loadSetupContext(actor, setup.id);
    if (ctx && canViewSetup(actor, ctx)) visible.push(setup);
  }
  return visible;
}

export const addMemberInput = z.object({
  userId: z.string().min(1),
  contribution: z.enum(schema.membershipContributionEnum.enumValues),
  contributionNote: z.string().trim().max(500).optional().or(z.literal("")),
});

export async function addMember(actor: Actor, setupId: string, raw: unknown) {
  const parsed = addMemberInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  await requireEditableSetup(actor, setupId);
  const input = parsed.data;
  return db.transaction(async (tx) => {
    await tx
      .insert(schema.setupMemberships)
      .values({ setupId, userId: input.userId, contribution: input.contribution, contributionNote: input.contributionNote || null })
      .onConflictDoUpdate({
        target: [schema.setupMemberships.setupId, schema.setupMemberships.userId],
        set: { contribution: input.contribution, contributionNote: input.contributionNote || null },
      });
    await recordAudit(tx, actor, "setup.member_set", "SETUP", setupId, { userId: input.userId, contribution: input.contribution });
  });
}
