import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { hasRole } from "@/modules/identity/actor";
import { isResponsibleBd } from "@/modules/identity/authz";
import { deleteStoredFile } from "@/modules/documents/storage";
import { getAccount } from "./service";

/**
 * Kunden löschen – zwei Schritte (E-042):
 *  1. Archivieren: Kunde verschwindet aus den Arbeitslisten, alles bleibt erhalten und ist rückholbar.
 *  2. Endgültig löschen: nur für archivierte Kunden, mit Begründung und Namensbestätigung. Entfernt den Kunden
 *     mit allen Setups, Ansprechpartnern, Beziehungen, Einschätzungen, Quellen (samt Dokumentdateien), Signalen,
 *     Bedarfen, Aktionen, Vorschlägen, Reviews, Interviews und Assistentengesprächen.
 *
 * Die Kaskade wird zur Laufzeit aus den Fremdschlüsseln der Datenbank abgeleitet – so kann keine Tabelle vergessen
 * werden, wenn das Schema wächst. Was nicht zum Kunden gehört (Ziele, Importe, KI-Protokolle, Artefaktvorlagen,
 * Prüfprotokoll), wird nur vom Kunden gelöst (Verweis auf NULL), nicht gelöscht.
 */

/** Verweise, die beim Löschen gelöst statt gelöscht werden: Zeilen dieser Tabellen gehören nicht dem Kunden. */
const DETACH: ReadonlySet<string> = new Set([
  "accounts.parent_account_id",
  "goals.account_id",
  "goal_contributions.account_id",
  "goal_contributions.setup_id",
  "goal_contributions.priority_id",
  "goal_contributions.evidence_source_id",
  "goal_versions.baseline_source_id",
  "artifact_versions.account_id",
  "artifact_versions.setup_id",
  "import_jobs.account_id",
  "import_jobs.setup_id",
  "import_jobs.source_id",
  "ai_jobs.setup_id",
  "ai_jobs.review_id",
  "merge_review_items.decided_person_id",
  "intake_proposals.result_account_id",
  "intake_proposals.result_setup_id",
  "intake_proposals.target_setup_id",
  "assistant_threads.source_id",
  "source_versions.import_job_id",
]);

/** Tabellen, deren Zeilen nie über die Kaskade gelöscht werden dürfen. */
const PROTECTED: ReadonlySet<string> = new Set(["users", "workspaces", "audit_events", "ai_jobs", "goals", "goal_versions", "import_jobs", "merge_review_items", "artifact_templates", "integration_connections", "ai_task_settings", "role_assignments_workspace", "standard_roles"]);

type Fk = { table: string; column: string; refTable: string };

async function loadForeignKeys(tx: Tx): Promise<Fk[]> {
  const rows = await tx.execute(sql`
    select tc.table_name as "table", kcu.column_name as "column", ccu.table_name as "refTable"
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = current_schema()
  `);
  return rowsOf<Fk>(rows).map((r) => ({ table: String(r.table), column: String(r.column), refTable: String(r.refTable) }));
}

async function hasIdColumn(tx: Tx, table: string): Promise<boolean> {
  const rows = await tx.execute(sql`select 1 from information_schema.columns where table_schema = current_schema() and table_name = ${table} and column_name = 'id'`);
  return rowsOf(rows).length > 0;
}

export type DeletionReport = { deleted: Record<string, number>; detached: Record<string, number>; files: number };

class Cascade {
  private readonly visited = new Set<string>();
  readonly report: DeletionReport = { deleted: {}, detached: {}, files: 0 };
  private readonly idCache = new Map<string, boolean>();
  constructor(
    private readonly tx: Tx,
    private readonly fks: Fk[],
  ) {}

  private async tableHasId(table: string): Promise<boolean> {
    if (!this.idCache.has(table)) this.idCache.set(table, await hasIdColumn(this.tx, table));
    return this.idCache.get(table)!;
  }

  /** Löscht die Zeilen `ids` der Tabelle `table`, zuvor rekursiv alles, was darauf verweist. */
  async deleteRows(table: string, ids: string[]): Promise<void> {
    const fresh = ids.filter((id) => !this.visited.has(`${table}:${id}`));
    if (fresh.length === 0) return;
    if (PROTECTED.has(table)) throw new TransitionError(`Löschen würde geschützte Daten in „${table}“ betreffen – abgebrochen.`);
    for (const id of fresh) this.visited.add(`${table}:${id}`);
    for (const fk of this.fks.filter((f) => f.refTable === table)) {
      const key = `${fk.table}.${fk.column}`;
      if (DETACH.has(key)) {
        const r = await this.tx.execute(sql`update ${sql.identifier(fk.table)} set ${sql.identifier(fk.column)} = null where ${sql.identifier(fk.column)} in ${sqlList(fresh)}`);
        const n = rowCount(r);
        if (n > 0) this.report.detached[key] = (this.report.detached[key] ?? 0) + n;
        continue;
      }
      if (await this.tableHasId(fk.table)) {
        const childRows = await this.tx.execute(sql`select id from ${sql.identifier(fk.table)} where ${sql.identifier(fk.column)} in ${sqlList(fresh)}`);
        const childIds = rowsOf<{ id: string }>(childRows).map((r) => String(r.id));
        if (fk.table === "documents") await this.deleteDocumentFiles(childIds);
        await this.deleteRows(fk.table, childIds);
      } else {
        if (PROTECTED.has(fk.table)) throw new TransitionError(`Löschen würde geschützte Daten in „${fk.table}“ betreffen – abgebrochen.`);
        const r = await this.tx.execute(sql`delete from ${sql.identifier(fk.table)} where ${sql.identifier(fk.column)} in ${sqlList(fresh)}`);
        const n = rowCount(r);
        if (n > 0) this.report.deleted[fk.table] = (this.report.deleted[fk.table] ?? 0) + n;
      }
    }
    const r = await this.tx.execute(sql`delete from ${sql.identifier(table)} where id in ${sqlList(fresh)}`);
    const n = rowCount(r);
    if (n > 0) this.report.deleted[table] = (this.report.deleted[table] ?? 0) + n;
  }

  private async deleteDocumentFiles(documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) return;
    const docs = await this.tx.query.documents.findMany({ where: inArray(schema.documents.id, documentIds) });
    for (const d of docs) {
      if (!d.storagePath) continue;
      try {
        await deleteStoredFile(d.storagePath);
        this.report.files++;
      } catch {
        /* Datei fehlt bereits – kein Grund, die Löschung abzubrechen */
      }
    }
  }
}

function sqlList(ids: string[]) {
  return sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

function rowsOf<T = Record<string, unknown>>(r: unknown): T[] {
  const x = r as { rows?: T[] };
  return Array.isArray(x.rows) ? x.rows : Array.isArray(r) ? (r as T[]) : [];
}

function rowCount(r: unknown): number {
  const x = r as { rowCount?: number | null; count?: number };
  return Number(x.rowCount ?? x.count ?? 0);
}

// ---------------------------------------------------------------------------

/** Wer darf einen Kunden archivieren und löschen? Zuständiger BD, Principal des Kunden oder ADMIN. */
export function canDeleteAccount(actor: Actor, account: typeof schema.accounts.$inferSelect): boolean {
  if (account.workspaceId !== actor.workspaceId) return false;
  if (hasRole(actor, "ADMIN")) return true;
  if (isResponsibleBd(actor, account)) return true;
  if (hasRole(actor, "PRINCIPAL", account.id)) return true;
  return false;
}

async function requireDeletable(actor: Actor, accountId: string) {
  // Die Betriebsverwaltung (ADMIN) sieht Kunden fachlich nicht, darf sie aber löschen (z. B. Fehlanlagen, Betroffenenrechte).
  const account = hasRole(actor, "ADMIN")
    ? await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.workspaceId, actor.workspaceId)) })
    : await getAccount(actor, accountId).catch(() => null);
  if (!account) throw new NotFoundError("Kunde");
  if (!canDeleteAccount(actor, account)) throw new ForbiddenError("Kunden archivieren oder löschen dürfen nur der zuständige BD, der Principal des Kunden oder die Betriebsverwaltung.");
  return account;
}

export async function archiveAccount(actor: Actor, accountId: string) {
  const account = await requireDeletable(actor, accountId);
  if (account.isDemo && !hasRole(actor, "ADMIN")) throw new ForbiddenError("Demo-Kunden archiviert nur die Betriebsverwaltung.");
  if (account.status === "ARCHIVED") throw new TransitionError("Der Kunde ist bereits archiviert.");
  return db.transaction(async (tx) => {
    const [row] = await tx.update(schema.accounts).set({ status: "ARCHIVED", updatedAt: new Date() }).where(eq(schema.accounts.id, account.id)).returning();
    await recordAudit(tx, actor, "account.archived", "ACCOUNT", account.id, { name: account.name, vorher: account.status });
    return row!;
  });
}

export async function restoreAccount(actor: Actor, accountId: string) {
  const account = await requireDeletable(actor, accountId);
  if (account.status !== "ARCHIVED") throw new TransitionError("Der Kunde ist nicht archiviert.");
  return db.transaction(async (tx) => {
    const [row] = await tx.update(schema.accounts).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(schema.accounts.id, account.id)).returning();
    await recordAudit(tx, actor, "account.restored", "ACCOUNT", account.id, { name: account.name });
    return row!;
  });
}

export const deleteAccountInput = z.object({
  accountId: z.string().min(1),
  confirmName: z.string().trim().min(1, "Bitte den Kundennamen zur Bestätigung eintippen."),
  reason: z.string().trim().min(10, "Bitte eine Begründung mit mindestens 10 Zeichen angeben (sie bleibt im Prüfprotokoll).").max(1000),
});

/** Was würde gelöscht? Für die Bestätigungsseite. */
export async function previewAccountDeletion(actor: Actor, accountId: string) {
  const account = await requireDeletable(actor, accountId);
  const setups = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, account.id), columns: { id: true, name: true } });
  const setupIds = setups.map((s) => s.id);
  const [persons] = await db.select({ n: sql<number>`count(*)` }).from(schema.persons).where(eq(schema.persons.accountId, account.id));
  const count = async (table: string): Promise<number> => {
    if (setupIds.length === 0) return 0;
    const r = await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where setup_id in ${sqlList(setupIds)}`);
    return Number(rowsOf<{ n: number }>(r)[0]?.n ?? 0);
  };
  return {
    account,
    setups,
    persons: Number(persons?.n ?? 0),
    sources: await count("sources"),
    signals: await count("signals"),
    opportunities: await count("opportunities"),
    actions: await count("actions"),
    suggestions: await count("suggestions"),
    reviews: await count("reviews"),
    canDelete: account.status === "ARCHIVED",
  };
}

/** Endgültig löschen. Nur archivierte Kunden; Name und Begründung sind Pflicht. */
export async function deleteAccountPermanently(actor: Actor, raw: unknown): Promise<DeletionReport & { name: string }> {
  const parsed = deleteAccountInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const { accountId, confirmName, reason } = parsed.data;
  const account = await requireDeletable(actor, accountId);
  if (account.isDemo && !hasRole(actor, "ADMIN")) throw new ForbiddenError("Demo-Kunden löscht nur die Betriebsverwaltung.");
  if (account.status !== "ARCHIVED") throw new TransitionError("Endgültig gelöscht werden nur archivierte Kunden – bitte zuerst archivieren.");
  if (confirmName.toLowerCase() !== account.name.trim().toLowerCase()) throw new ValidationError("Der eingetippte Name stimmt nicht mit dem Kundennamen überein.");

  return db.transaction(async (tx) => {
    const fks = await loadForeignKeys(tx);
    const cascade = new Cascade(tx, fks);
    // Assistentengespräche hängen ohne Fremdschlüssel am Kontext (Kunde/Setup) – von Hand mitnehmen.
    const setups = await tx.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, account.id), columns: { id: true } });
    const contextIds = [account.id, ...setups.map((s) => s.id)];
    const threads = await tx.query.assistantThreads.findMany({ where: and(eq(schema.assistantThreads.workspaceId, actor.workspaceId), inArray(schema.assistantThreads.contextId, contextIds)), columns: { id: true } });
    await cascade.deleteRows("assistant_threads", threads.map((t) => t.id));
    // Kundenbezogene Rollen verschwinden mit dem Kunden.
    const roles = await tx.execute(sql`delete from role_assignments where account_id = ${account.id}`);
    const roleCount = rowCount(roles);
    if (roleCount > 0) cascade.report.deleted["role_assignments"] = roleCount;
    await cascade.deleteRows("accounts", [account.id]);
    const report = cascade.report;
    await recordAudit(tx, actor, "account.deleted", "ACCOUNT", account.id, { name: account.name, orgType: account.orgType, begruendung: reason, geloescht: report.deleted, geloest: report.detached, dateien: report.files });
    return { ...report, name: account.name };
  });
}
