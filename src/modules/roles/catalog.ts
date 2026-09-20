import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "@/db/client";
import type { RoleFamily } from "@/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";

/**
 * Verve-Standardrollenkatalog (Etappe 10, E-045): Rollenfamilien und Rollen, auf die Chancen zeigen.
 * Der Katalog wird je Arbeitsraum geführt (Verwaltung → Rollen) und beim ersten Zugriff aus dem Verve-Standard befüllt.
 */

export const roleFamilyLabel: Record<RoleFamily, string> = {
  DELIVERY_MANAGEMENT: "Delivery Management",
  AGILE_LEADERSHIP: "Agile Leadership",
  BUSINESS_ANALYSE: "Business Analyse & Beratung",
  SOLUTION_ARCHITEKTUR: "Solution & Architektur",
  TEST_QS: "Test & Qualitätssicherung",
};

export const roleFamilyValues = Object.keys(roleFamilyLabel) as RoleFamily[];

/** Der Verve-Standard – Namen genügen; Beschreibungen sind Orientierung für KI und Neue. */
export const VERVE_STANDARD_ROLES: { family: RoleFamily; name: string; description?: string }[] = [
  { family: "DELIVERY_MANAGEMENT", name: "Projektleitung" },
  { family: "DELIVERY_MANAGEMENT", name: "Programmleitung" },
  { family: "DELIVERY_MANAGEMENT", name: "PMO" },
  { family: "DELIVERY_MANAGEMENT", name: "Delivery Manager" },
  { family: "DELIVERY_MANAGEMENT", name: "Governance / RAID / Reporting / Ressourcensteuerung", description: "Governance, RAID-Management, Reporting, Ressourcensteuerung" },
  { family: "AGILE_LEADERSHIP", name: "Scrum Master" },
  { family: "AGILE_LEADERSHIP", name: "Agile Coach" },
  { family: "AGILE_LEADERSHIP", name: "Release Train Engineer (RTE)" },
  { family: "AGILE_LEADERSHIP", name: "Agile Führungsrolle (SAFe / LeSS / Kanban)", description: "SAFe-, LeSS- oder Kanban-orientierte Führungsrollen" },
  { family: "BUSINESS_ANALYSE", name: "Business Analyst" },
  { family: "BUSINESS_ANALYSE", name: "Requirements Engineer" },
  { family: "BUSINESS_ANALYSE", name: "Fachkonzeption" },
  { family: "BUSINESS_ANALYSE", name: "Prozessberatung" },
  { family: "BUSINESS_ANALYSE", name: "Demand Management / Anforderungsanalyse" },
  { family: "SOLUTION_ARCHITEKTUR", name: "Solution Architect" },
  { family: "SOLUTION_ARCHITEKTUR", name: "Enterprise Architect" },
  { family: "SOLUTION_ARCHITEKTUR", name: "Cloud-, SAP- und Integrationsarchitektur" },
  { family: "SOLUTION_ARCHITEKTUR", name: "API- und Schnittstellendesign" },
  { family: "SOLUTION_ARCHITEKTUR", name: "Security-by-Design / Zielarchitektur" },
  { family: "TEST_QS", name: "Test Management" },
  { family: "TEST_QS", name: "Test Analyse" },
  { family: "TEST_QS", name: "QA" },
  { family: "TEST_QS", name: "Qualitäts- und Abnahmesicherung" },
];

export type StandardRole = typeof schema.standardRoles.$inferSelect;

/** Katalog sicherstellen: leerer Arbeitsraum bekommt den Verve-Standard (einmalig, idempotent). */
export async function ensureRoleCatalog(workspaceId: string, tx: Tx | Db = db): Promise<void> {
  const existing = await tx.query.standardRoles.findFirst({ where: eq(schema.standardRoles.workspaceId, workspaceId) });
  if (existing) return;
  await tx.insert(schema.standardRoles).values(VERVE_STANDARD_ROLES.map((r, i) => ({ workspaceId, family: r.family, name: r.name, description: r.description ?? null, sortOrder: i })));
}

export async function listRoles(workspaceId: string, opts: { includeInactive?: boolean } = {}): Promise<StandardRole[]> {
  await ensureRoleCatalog(workspaceId);
  const rows = await db.query.standardRoles.findMany({ where: eq(schema.standardRoles.workspaceId, workspaceId), orderBy: [asc(schema.standardRoles.sortOrder), asc(schema.standardRoles.name)] });
  return opts.includeInactive ? rows : rows.filter((r) => r.active);
}

export function groupByFamily(roles: StandardRole[]): { family: RoleFamily; label: string; roles: StandardRole[] }[] {
  return roleFamilyValues.map((f) => ({ family: f, label: roleFamilyLabel[f], roles: roles.filter((r) => r.family === f) })).filter((g) => g.roles.length > 0);
}

/** Rolle finden – nach ID oder (unscharf) nach Name; für KI-Vorschläge, die Rollennamen liefern. */
export function matchRole(roles: StandardRole[], nameOrId: string | null | undefined): StandardRole | null {
  if (!nameOrId) return null;
  const q = nameOrId.trim().toLowerCase();
  return roles.find((r) => r.id === nameOrId) ?? roles.find((r) => r.name.toLowerCase() === q) ?? roles.find((r) => r.name.toLowerCase().includes(q) || q.includes(r.name.toLowerCase())) ?? null;
}

function assertAdmin(actor: Actor) {
  if (!hasRole(actor, "ADMIN")) throw new ForbiddenError("Den Rollenkatalog pflegt die Betriebsverwaltung (ADMIN).");
}

export const addRoleInput = z.object({ family: z.enum(roleFamilyValues as [RoleFamily, ...RoleFamily[]]), name: z.string().trim().min(2, "Rollenname fehlt").max(120), description: z.string().trim().max(400).optional().or(z.literal("")) });

export async function addRole(actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const parsed = addRoleInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  await ensureRoleCatalog(actor.workspaceId);
  const dup = await db.query.standardRoles.findFirst({ where: and(eq(schema.standardRoles.workspaceId, actor.workspaceId), eq(schema.standardRoles.name, i.name)) });
  if (dup) throw new ValidationError("Eine Rolle mit diesem Namen gibt es bereits.");
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(schema.standardRoles).values({ workspaceId: actor.workspaceId, family: i.family, name: i.name, description: i.description || null, sortOrder: 1000 }).returning();
    await recordAudit(tx, actor, "role.added", "STANDARD_ROLE", row!.id, { family: i.family, name: i.name });
    return row!;
  });
}

export async function setRoleActive(actor: Actor, roleId: string, active: boolean) {
  assertAdmin(actor);
  const row = await db.query.standardRoles.findFirst({ where: and(eq(schema.standardRoles.id, roleId), eq(schema.standardRoles.workspaceId, actor.workspaceId)) });
  if (!row) throw new NotFoundError("Rolle");
  return db.transaction(async (tx) => {
    const [u] = await tx.update(schema.standardRoles).set({ active }).where(eq(schema.standardRoles.id, roleId)).returning();
    await recordAudit(tx, actor, active ? "role.activated" : "role.deactivated", "STANDARD_ROLE", roleId, { name: row.name });
    return u!;
  });
}
