import { and, eq, isNull } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "@/db/client";
import { NotFoundError } from "@/lib/errors";
import { hasRole, type Actor } from "@/modules/identity/actor";
import type { AccountRow } from "@/modules/identity/authz";
import { isStaffingManager } from "@/modules/staffing/authz";

/**
 * Rechte der Einsatzakte (Etappe 29, E2).
 *  - manage: BD-Kontext des Kunden (Einsatz-BD, zuständiger BD, Setup-BD), Principal am Kunden, CEO – alles inkl. Konditionen,
 *    Statuswechsel, Betreuung vergeben, Ausnahme vom Beschaffungscheck.
 *  - care: aktive Betreuungszuordnung (CUSTOMER_CARE/FREELANCER_CARE) – Einsatzkontext, Check-ins, Verlängerung
 *    vorbereiten, Unterlagen sehen/hochladen, Perioden lesen (Entwicklungsdefault, Abschnitt 5.2); keine
 *    Account-Rechte, keine Vergabe von Betreuung, kein Statuswechsel außer Pause-/Ende-Vorschlag.
 *  - ops (Etappe 33, Zielbild Bedienung): Sales Operations ist Prozessinhaberin der Freelancer-Platzierung – sieht alle
 *    Einsätze des Arbeitsraums, pflegt Konditionen, Unterlagen, Betreuung, Status und stößt Verlängerungen an (zählt als
 *    `manage`), trifft aber keine kommerzielle Entscheidung: Verlängerung bestätigen/ablehnen bleibt `commercial`
 *    (BD-Kontext, Principal am Kunden, CEO).
 *  Anker ohne Zuordnung sehen nichts. Betreuung überlebt den Abschluss des Übergabe-Vorgangs.
 */
export type EngagementRow = typeof schema.engagements.$inferSelect;

export type EngagementAccess = {
  engagement: EngagementRow;
  account: AccountRow;
  manage: boolean;
  /** kommerzielle Entscheidung (Verlängerung bestätigen/ablehnen, VK-Freigabe): BD-Kontext, Principal am Kunden, CEO */
  commercial: boolean;
  /** Sales Operations ohne BD-Kontext */
  ops: boolean;
  care: boolean;
  careRoles: string[];
};

export function isSalesOps(actor: Actor): boolean {
  return actor.roles.has("SALES_OPS");
}

export async function engagementAccess(actor: Actor, e: EngagementRow, tx: Tx | Db = db): Promise<EngagementAccess | null> {
  if (e.workspaceId !== actor.workspaceId) return null;
  const account = await tx.query.accounts.findFirst({ where: eq(schema.accounts.id, e.accountId) });
  if (!account) return null;
  const setup = await tx.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, e.setupId), columns: { bdUserId: true } });
  const commercial = isStaffingManager(actor, account, setup?.bdUserId ?? null, e.bdUserId) || hasRole(actor, "CEO");
  const ops = !commercial && isSalesOps(actor);
  const manage = commercial || ops;
  const cares = await tx.query.careAssignments.findMany({ where: and(eq(schema.careAssignments.engagementId, e.id), eq(schema.careAssignments.userId, actor.userId), isNull(schema.careAssignments.toDate)) });
  const care = cares.length > 0;
  if (!manage && !care) return null;
  return { engagement: e, account, manage, commercial, ops, care, careRoles: cares.map((c) => c.role) };
}

export async function requireEngagement(actor: Actor, id: string, tx: Tx | Db = db): Promise<EngagementAccess> {
  const e = await tx.query.engagements.findFirst({ where: and(eq(schema.engagements.id, id), eq(schema.engagements.workspaceId, actor.workspaceId)) });
  if (!e) throw new NotFoundError("Einsatz");
  const a = await engagementAccess(actor, e, tx);
  if (!a) throw new NotFoundError("Einsatz");
  return a;
}

export async function requireManagedEngagement(actor: Actor, id: string, tx: Tx | Db = db): Promise<EngagementAccess> {
  const a = await requireEngagement(actor, id, tx);
  if (!a.manage) throw new NotFoundError("Einsatz");
  return a;
}
