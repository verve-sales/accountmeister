import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError } from "@/lib/errors";

/**
 * Entwicklungsanmeldung (Briefing 2.3): ausschließlich lokal, deutlich markiert, ohne Passwort.
 * In Produktion verhindert getConfig() den Start; zusätzlich wird hier hart geprüft.
 */
export function assertDevLoginAllowed(): void {
  const cfg = getConfig();
  if (cfg.AUTH_MODE !== "development" || cfg.NODE_ENV === "production") throw new ForbiddenError("Entwicklungsanmeldung ist nicht aktiv.");
}

export async function listDevLoginUsers() {
  assertDevLoginAllowed();
  const users = await db.query.users.findMany({ where: eq(schema.users.status, "ACTIVE"), orderBy: (u, { asc }) => [asc(u.displayName)] });
  const roles = await db.select().from(schema.roleAssignments);
  return users.map((u) => ({
    id: u.id,
    displayName: u.displayName,
    email: u.email,
    roles: [...new Set(roles.filter((r) => r.userId === u.id).map((r) => (r.scope === "WORKSPACE" ? r.role : `${r.role} (Kunde)`)))],
  }));
}

export async function resolveDevLoginUser(userId: string) {
  assertDevLoginAllowed();
  return db.query.users.findFirst({ where: and(eq(schema.users.id, userId), eq(schema.users.status, "ACTIVE")) });
}
