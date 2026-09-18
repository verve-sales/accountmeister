import { and, eq, isNull, or, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { Role } from "@/db/schema";

/**
 * Der Akteur ist der geladene Berechtigungsstand einer Person zum Zeitpunkt der Anfrage.
 * Er wird pro Anfrage (nicht aus Caches) geladen, damit entzogene Rechte sofort wirken (Briefing 14.4).
 */
export type Actor = {
  userId: string;
  workspaceId: string;
  displayName: string;
  email: string;
  /** Arbeitsraum-weite Rollen */
  roles: ReadonlySet<Role>;
  /** Rollen mit Account-Scope: accountId -> Rollen */
  accountRoles: ReadonlyMap<string, ReadonlySet<Role>>;
};

export async function loadActor(userId: string): Promise<Actor | null> {
  const user = await db.query.users.findFirst({ where: and(eq(schema.users.id, userId), eq(schema.users.status, "ACTIVE")) });
  if (!user) return null;
  const today = sql`current_date`;
  const assignments = await db
    .select()
    .from(schema.roleAssignments)
    .where(
      and(
        eq(schema.roleAssignments.userId, userId),
        lte(schema.roleAssignments.validFrom, today),
        or(isNull(schema.roleAssignments.validTo), gte(schema.roleAssignments.validTo, today)),
      ),
    );
  const roles = new Set<Role>();
  const accountRoles = new Map<string, Set<Role>>();
  for (const a of assignments) {
    if (a.scope === "WORKSPACE") roles.add(a.role);
    else if (a.accountId) {
      const set = accountRoles.get(a.accountId) ?? new Set<Role>();
      set.add(a.role);
      accountRoles.set(a.accountId, set);
    }
  }
  return { userId: user.id, workspaceId: user.workspaceId, displayName: user.displayName, email: user.email, roles, accountRoles };
}

export function hasRole(actor: Actor, role: Role, accountId?: string): boolean {
  if (actor.roles.has(role)) return true;
  if (accountId) return actor.accountRoles.get(accountId)?.has(role) ?? false;
  return false;
}

/** Fachliche (inhaltliche) Rollen – ADMIN ist Betriebsverwaltung ohne automatischen Inhaltszugriff (16.2). */
export function hasAnyContentRole(actor: Actor): boolean {
  const content: Role[] = ["ANKER", "BD", "PRINCIPAL", "CEO"];
  if (content.some((r) => actor.roles.has(r))) return true;
  for (const set of actor.accountRoles.values()) if (content.some((r) => set.has(r))) return true;
  return false;
}
