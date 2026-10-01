import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db, schema, type Db, type Tx } from "@/db/client";
import { NotFoundError } from "@/lib/errors";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { isResponsibleBd, type AccountRow } from "@/modules/identity/authz";

/**
 * Rechte der Besetzung (Etappe 28, E1). Prüfprinzip: Fähigkeit × Objektbezug × Datenklasse.
 *
 * Datenklassen:
 *  - operativer Kontext (Position ohne Konditionen/Notizen): BD-Kontext des Kunden, Principal, CEO, angenommene Suchbearbeiter:in
 *  - Teamvorschau (nur Titel, Kunde, Muss-Anforderungen, Zieltermin): Mitglieder des Teams eines offenen Suchauftrags
 *  - interne Konditionen (EK/VK-Rahmen, Kandidaten-EK, interne Notizen): wie operativer Kontext, NICHT die Teamvorschau
 *  - Kandidaturen: wie interne Konditionen
 *  - Freelancer-Stammdaten: über eine sichtbare Kandidatur oder als Mitglied Sales Operations / Principal / CEO (Pool)
 *
 * Bewusst NICHT abgeleitet: canEditSetup (dort darf Sales Operations arbeitsraumweit), Setup-Mitgliedschaft von Ankern,
 * die Dashboard-Sicht. Anker sehen keine Positionen und keine Kandidaturen.
 */

export type PositionRow = typeof schema.staffingPositions.$inferSelect;
export const SEARCH_KINDS = ["SUCHE", "SHORTLIST", "NACHFASSEN"] as const;
const FINAL = ["ERLEDIGT", "VERWORFEN", "ABGELEHNT"];

export type PositionAccess = {
  position: PositionRow;
  account: AccountRow;
  accountName: string;
  /** vollständiger operativer Zugriff (Daten, Kandidaturen, Konditionen) */
  full: boolean;
  /** darf Position anlegen/ändern, Vorstellung freigeben, Auswahl bestätigen (BD-Kontext, Principal, CEO) */
  manage: boolean;
  /** angenommene Suchbearbeiter:in (arbeitet an Kandidaturen, sieht Konditionen) */
  searcher: boolean;
  /** nur Teamvorschau (offener Suchauftrag im eigenen Team) */
  preview: boolean;
};

/** BD-Kontext an einem Kunden/Setup: Positions-BD, zuständiger BD, Setup-BD, kundenbezogener oder arbeitsraumweiter Principal, CEO. */
export function isStaffingManager(actor: Actor, account: AccountRow, setupBdUserId: string | null, positionBdUserId?: string | null): boolean {
  if (account.workspaceId !== actor.workspaceId) return false;
  if (positionBdUserId && positionBdUserId === actor.userId && (hasRole(actor, "BD", account.id) || hasRole(actor, "PRINCIPAL", account.id))) return true;
  if (isResponsibleBd(actor, account)) return true;
  if (setupBdUserId === actor.userId && hasRole(actor, "BD", account.id)) return true;
  if (hasRole(actor, "PRINCIPAL", account.id)) return true;
  if (hasRole(actor, "CEO")) return true;
  return false;
}

async function acceptedSearchItem(actor: Actor, positionId: string, tx: Tx | Db) {
  return tx.query.workItems.findFirst({
    where: and(eq(schema.workItems.subjectType, "POSITION"), eq(schema.workItems.subjectId, positionId), eq(schema.workItems.assigneeUserId, actor.userId), inArray(schema.workItems.kind, [...SEARCH_KINDS]), notInArray(schema.workItems.status, ["ANGEFRAGT", "VERWORFEN", "ABGELEHNT"])),
    columns: { id: true, status: true },
  });
}

async function openTeamSearchItem(actor: Actor, positionId: string, tx: Tx | Db) {
  const items = await tx.query.workItems.findMany({
    where: and(eq(schema.workItems.subjectType, "POSITION"), eq(schema.workItems.subjectId, positionId), inArray(schema.workItems.kind, [...SEARCH_KINDS]), notInArray(schema.workItems.status, FINAL)),
    columns: { teamId: true },
  });
  const teamIds = [...new Set(items.map((i) => i.teamId).filter((x): x is string => !!x))];
  if (!teamIds.length) return false;
  const { isTeamMember } = await import("@/modules/work/teams");
  const teams = await tx.query.teams.findMany({ where: inArray(schema.teams.id, teamIds) });
  for (const t of teams) if (await isTeamMember(actor, t, tx)) return true;
  return false;
}

export async function positionAccess(actor: Actor, position: PositionRow, tx: Tx | Db = db): Promise<PositionAccess | null> {
  if (position.workspaceId !== actor.workspaceId) return null;
  const account = await tx.query.accounts.findFirst({ where: eq(schema.accounts.id, position.accountId) });
  if (!account) return null;
  const setup = await tx.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, position.setupId), columns: { bdUserId: true } });
  const manage = isStaffingManager(actor, account, setup?.bdUserId ?? null, position.bdUserId);
  const searcher = !manage && !!(await acceptedSearchItem(actor, position.id, tx));
  const preview = !manage && !searcher && (await openTeamSearchItem(actor, position.id, tx));
  if (!manage && !searcher && !preview) return null;
  return { position, account, accountName: account.name, full: manage || searcher, manage, searcher, preview };
}

/** Position mit vollem oder Vorschau-Zugriff – sonst „nicht gefunden“ (keine Metadaten nach außen). */
export async function requireViewablePosition(actor: Actor, positionId: string, tx: Tx | Db = db): Promise<PositionAccess> {
  const position = await tx.query.staffingPositions.findFirst({ where: and(eq(schema.staffingPositions.id, positionId), eq(schema.staffingPositions.workspaceId, actor.workspaceId)) });
  if (!position) throw new NotFoundError("Position");
  const a = await positionAccess(actor, position, tx);
  if (!a) throw new NotFoundError("Position");
  return a;
}

export async function requireFullPosition(actor: Actor, positionId: string, tx: Tx | Db = db): Promise<PositionAccess> {
  const a = await requireViewablePosition(actor, positionId, tx);
  if (!a.full) throw new NotFoundError("Position");
  return a;
}

/** Zugriff auf den Freelancer-Pool (Liste aller Stammdaten): Sales Operations, Principal, CEO. BDs sehen Freelancer nur über Kandidaturen. */
export function canBrowseFreelancerPool(actor: Actor): boolean {
  return actor.roles.has("SALES_OPS") || actor.roles.has("PRINCIPAL") || actor.roles.has("CEO");
}
