/**
 * Zentrale, deterministische Berechtigungsregeln (Briefing 16.2).
 * Alle Services prüfen hierüber – nie in UI-Komponenten und nie in mehreren Kopien.
 *
 * Grundsatz: kein Zugriff ohne passende Berechtigung. Führungstitel (CEO/Principal) geben
 * Zusammenfassungs-, aber keine pauschale Originalquelleneinsicht.
 */
import { and, eq } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "@/db/client";
import type { AccessClass } from "@/db/schema";
import { hasAnyContentRole, hasRole, type Actor } from "./actor";

export type AccountRow = typeof schema.accounts.$inferSelect;
export type SetupRow = typeof schema.projectSetups.$inferSelect;
export type MembershipRow = typeof schema.setupMemberships.$inferSelect;
export type SourceRow = typeof schema.sources.$inferSelect;

export type SetupContext = {
  setup: SetupRow;
  account: AccountRow;
  membership: MembershipRow | null; // Mitgliedschaft des Akteurs
};

export async function loadSetupContext(actor: Actor, setupId: string, tx: Tx | Db = db): Promise<SetupContext | null> {
  const setup = await tx.query.projectSetups.findFirst({
    where: and(eq(schema.projectSetups.id, setupId), eq(schema.projectSetups.workspaceId, actor.workspaceId)),
  });
  if (!setup) return null;
  const account = await tx.query.accounts.findFirst({ where: eq(schema.accounts.id, setup.accountId) });
  if (!account) return null;
  const membership =
    (await tx.query.setupMemberships.findFirst({
      where: and(eq(schema.setupMemberships.setupId, setupId), eq(schema.setupMemberships.userId, actor.userId)),
    })) ?? null;
  return { setup, account, membership };
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export function isResponsibleBd(actor: Actor, account: AccountRow): boolean {
  return account.responsibleBdUserId === actor.userId && hasRole(actor, "BD", account.id);
}

/** Zusammenfassende Kundensicht (Überblick, Setup-Liste) */
export function canViewAccount(actor: Actor, account: AccountRow): boolean {
  if (account.workspaceId !== actor.workspaceId) return false;
  if (isResponsibleBd(actor, account)) return true;
  if (hasRole(actor, "PRINCIPAL", account.id) || hasRole(actor, "CEO")) return true;
  // Account-bezogene Rollen (z. B. BD/ANKER mit Scope auf diesen Kunden)
  if (actor.accountRoles.has(account.id)) return true;
  return false;
}

export function canCreateAccount(actor: Actor): boolean {
  return hasRole(actor, "BD") || hasRole(actor, "PRINCIPAL");
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function canViewSetup(actor: Actor, ctx: SetupContext): boolean {
  if (ctx.setup.workspaceId !== actor.workspaceId) return false;
  if (ctx.membership) return true;
  if (ctx.setup.createdBy === actor.userId || ctx.setup.bdUserId === actor.userId) return true;
  if (isResponsibleBd(actor, ctx.account)) return true;
  if (hasRole(actor, "PRINCIPAL", ctx.account.id)) return true;
  if (ctx.setup.visibility === "ACCOUNT_TEAM" && canViewAccount(actor, ctx.account)) return true;
  if (ctx.setup.visibility === "WORKSPACE" && hasAnyContentRole(actor)) return true;
  // CEO: Zusammenfassung sichtbar, aber keine Rohquellen (siehe canViewSource)
  if (hasRole(actor, "CEO")) return true;
  return false;
}

export function canEditSetup(actor: Actor, ctx: SetupContext): boolean {
  if (ctx.setup.workspaceId !== actor.workspaceId) return false;
  if (ctx.setup.status === "ARCHIVIERT") return false;
  if (ctx.membership?.canEdit) return true;
  if (ctx.setup.createdBy === actor.userId) return true; // Ersteller bis zur angenommenen Übergabe (6.1)
  if (ctx.setup.bdUserId === actor.userId) return true;
  if (isResponsibleBd(actor, ctx.account)) return true;
  return false;
}

/** Wer darf ein Setup für einen Kunden anlegen? Anker (Kontext) und BD; Principal ebenfalls. */
export function canCreateSetup(actor: Actor, account: AccountRow): boolean {
  if (!canViewAccount(actor, account) && !hasRole(actor, "BD") && !hasRole(actor, "ANKER")) return false;
  return hasRole(actor, "ANKER", account.id) || hasRole(actor, "BD", account.id) || hasRole(actor, "PRINCIPAL", account.id);
}

// ---------------------------------------------------------------------------
// Quellen (Ebene 1: Originalquelle) – Briefing 13.5 / 16.2
// ---------------------------------------------------------------------------

export function canViewSource(actor: Actor, source: SourceRow, ctx: SetupContext | null): boolean {
  if (source.workspaceId !== actor.workspaceId) return false;
  if (source.isLocked && source.ownerUserId !== actor.userId) return false;
  if (source.ownerUserId === actor.userId) return true;
  const cls: AccessClass = source.accessClass;
  if (cls === "PERSOENLICH") return false;
  // CEO erhält keinen pauschalen Rohquellenzugriff (S02) – nur Arbeitsraum-weit freigegebene Quellen.
  const isCeoOnly = hasRole(actor, "CEO") && !hasRole(actor, "BD") && !hasRole(actor, "PRINCIPAL") && !hasRole(actor, "ANKER") && actor.accountRoles.size === 0;
  if (isCeoOnly) return cls === "WORKSPACE";
  if (cls === "WORKSPACE") return hasAnyContentRole(actor);
  if (!ctx) return false;
  if (cls === "SETUP") return ctx.membership !== null || ctx.setup.bdUserId === actor.userId;
  if (cls === "ACCOUNT_TEAM") return ctx.membership !== null || isResponsibleBd(actor, ctx.account) || hasRole(actor, "PRINCIPAL", ctx.account.id) || ctx.setup.bdUserId === actor.userId;
  return false;
}

// ---------------------------------------------------------------------------
// Aktionen / Übergaben
// ---------------------------------------------------------------------------

export function canEditAction(actor: Actor, action: typeof schema.actions.$inferSelect, ctx: SetupContext | null): boolean {
  if (action.workspaceId !== actor.workspaceId) return false;
  if (action.ownerUserId === actor.userId || action.createdBy === actor.userId) return true;
  return ctx ? canEditSetup(actor, ctx) : false;
}

export function canViewAction(actor: Actor, action: typeof schema.actions.$inferSelect, ctx: SetupContext | null): boolean {
  if (action.workspaceId !== actor.workspaceId) return false;
  if (action.ownerUserId === actor.userId || action.createdBy === actor.userId) return true;
  return ctx ? canViewSetup(actor, ctx) : false;
}

export function isParty(actor: Actor, h: typeof schema.handovers.$inferSelect): boolean {
  return h.senderUserId === actor.userId || h.receiverUserId === actor.userId;
}

/** Schreibrecht auf Kundenebene (Personen anlegen/pflegen): zuständiger BD, Principal, account-bezogene BD/Anker-Rollen. */
export function hasRoleForAccountWrite(actor: Actor, account: AccountRow): boolean {
  if (account.workspaceId !== actor.workspaceId) return false;
  if (isResponsibleBd(actor, account)) return true;
  if (hasRole(actor, "PRINCIPAL", account.id)) return true;
  const acc = actor.accountRoles.get(account.id);
  return !!acc && (acc.has("BD") || acc.has("ANKER"));
}
