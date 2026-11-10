import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { todayIso } from "@/modules/work/calendar";
import { isInternalMocoCompany } from "@/modules/moco/client";
import { deleteEngagementTx } from "@/modules/moco/import";
import { engagementAccess, requireManagedEngagement, type EngagementRow } from "@/modules/engagements/authz";
import { changeEngagementStatus, isOverdueEngagement } from "@/modules/engagements/service";
import { duplicateGroups, mergePersons } from "@/modules/people/service";

/**
 * Bereinigung (e37): sucht Unstimmigkeiten im Bestand zusammen – nichts wird automatisch geändert. Jede Korrektur
 * gibt GF, Sales Operations oder Administration mit einem Klick frei:
 *  - Einsätze mit überschrittenem Ende → abschließen
 *  - doppelte Einsätze (gleiche Person beim gleichen Kunden, überlappende Laufzeit) → zusammenführen
 *  - Einsätze interner Moco-Projekte (Kunde „Verve Consulting“) → entfernen, Kunde archivieren
 *  - doppelte Setups und Personen je Kunde → zusammenführen
 */

export function canClean(actor: Actor): boolean {
  return hasRole(actor, "CEO") || actor.roles.has("SALES_OPS") || actor.roles.has("ADMIN");
}
function requireCleaner(actor: Actor) {
  if (!canClean(actor)) throw new ForbiddenError("Die Bereinigung führen Geschäftsführung, Sales Operations oder Administration durch.");
}

const CLOSED = ["ABGESCHLOSSEN", "ABGEBROCHEN"];
const personOf = (e: Pick<EngagementRow, "freelancerId" | "internalUserId">) => (e.freelancerId ? `f:${e.freelancerId}` : e.internalUserId ? `u:${e.internalUserId}` : null);
const startOf = (e: EngagementRow) => e.actualStart ?? e.plannedStart ?? "0000-01-01";
const endOf = (e: EngagementRow) => e.actualEnd ?? e.plannedEnd ?? "9999-12-31";

// ---------------------------------------------------------------------------
// Generisches Umhängen von Verweisen (für Zusammenführen)
// ---------------------------------------------------------------------------

type Fk = { table: string; column: string; refTable: string };

/**
 * Hängt alle Fremdschlüssel-Verweise auf `table.id = dropId` auf `keepId` um. Zeilen, die dadurch gegen eine
 * Eindeutigkeit verstoßen (z. B. dieselbe Mitgliedschaft zweimal), werden als Doppel entfernt.
 */
async function repointReferences(tx: Tx, fks: Fk[], table: string, dropId: string, keepId: string, skip: ReadonlySet<string> = new Set()): Promise<{ moved: number; dropped: number }> {
  const { Cascade } = await import("@/modules/accounts/deletion");
  let moved = 0;
  let dropped = 0;
  for (const fk of fks.filter((f) => f.refTable === table && !skip.has(`${f.table}.${f.column}`))) {
    const col = sql.identifier(fk.column);
    const tbl = sql.identifier(fk.table);
    const hasId = ((await tx.execute(sql`select 1 from information_schema.columns where table_schema = current_schema() and table_name = ${fk.table} and column_name = 'id'`)) as unknown as { rows?: unknown[] }).rows?.length ?? 0;
    if (hasId) {
      const rows = ((await tx.execute(sql`select id from ${tbl} where ${col} = ${dropId}`)) as unknown as { rows: { id: string }[] }).rows;
      for (const r of rows) {
        try {
          await tx.transaction(async (sp) => {
            await sp.execute(sql`update ${tbl} set ${col} = ${keepId} where id = ${r.id}`);
          });
          moved++;
        } catch {
          await new Cascade(tx, fks).deleteRows(fk.table, [String(r.id)]);
          dropped++;
        }
      }
    } else {
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`update ${tbl} set ${col} = ${keepId} where ${col} = ${dropId}`);
        });
        moved++;
      } catch {
        await tx.execute(sql`delete from ${tbl} where ${col} = ${dropId}`);
        dropped++;
      }
    }
  }
  return { moved, dropped };
}

/** Verweise ohne Fremdschlüssel (Objekt-Typ + ID) mitziehen. */
async function repointSubjects(tx: Tx, types: string[], dropId: string, keepId: string) {
  const list = sql.join(types.map((t) => sql`${t}`), sql`, `);
  await tx.execute(sql`update work_items set subject_id = ${keepId} where subject_id = ${dropId} and subject_type in (${list})`);
  await tx.execute(sql`update comments set subject_id = ${keepId} where subject_id = ${dropId} and subject_type in (${list})`);
  await tx.execute(sql`update moco_hints set subject_id = ${keepId} where subject_id = ${dropId} and subject_type in (${list})`);
  if (types.includes("SETUP")) await tx.execute(sql`update handovers set subject_id = ${keepId} where subject_id = ${dropId} and subject_type = 'SETUP'`);
}

// ---------------------------------------------------------------------------
// Befund
// ---------------------------------------------------------------------------

export type EngRef = { id: string; title: string; status: string; start: string | null; end: string | null; moco: number | null; bdUserId: string; createdAt: Date; score: number };
export type EngagementDuplicate = { accountId: string; accountName: string; personName: string; keep: EngRef; drop: EngRef[]; reason: string };
export type SetupDuplicate = { accountId: string; accountName: string; name: string; keep: { id: string; name: string; score: number }; drop: { id: string; name: string; score: number }[] };
export type PersonDuplicate = { accountId: string; accountName: string; name: string; keepId: string; dropIds: string[]; emails: string[] };

export function normSetupName(n: string) {
  return n.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9äöüß]+/g, "");
}

async function engagementScores(ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const [docs, periods, cis, rens] = await Promise.all([
    db.query.engagementDocuments.findMany({ where: inArray(schema.engagementDocuments.engagementId, ids), columns: { engagementId: true } }),
    db.query.engagementPeriods.findMany({ where: and(inArray(schema.engagementPeriods.engagementId, ids), eq(schema.engagementPeriods.kind, "BESTAETIGT")), columns: { engagementId: true } }),
    db.query.checkins.findMany({ where: and(inArray(schema.checkins.engagementId, ids), eq(schema.checkins.status, "ERLEDIGT")), columns: { engagementId: true } }),
    db.query.renewalDecisions.findMany({ where: inArray(schema.renewalDecisions.engagementId, ids), columns: { engagementId: true } }),
  ]);
  const m = new Map<string, number>(ids.map((i) => [i, 0]));
  for (const d of docs) m.set(d.engagementId, m.get(d.engagementId)! + 10);
  for (const p of periods) m.set(p.engagementId, m.get(p.engagementId)! + 5);
  for (const r of rens) m.set(r.engagementId, m.get(r.engagementId)! + 3);
  for (const c of cis) m.set(c.engagementId, m.get(c.engagementId)! + 1);
  return m;
}

/** Doppelte Einsätze: gleiche Person beim gleichen Kunden, nicht abgeschlossen, Laufzeiten überlappen. */
export async function findEngagementDuplicates(actor: Actor, rows?: EngagementRow[]): Promise<EngagementDuplicate[]> {
  const all = rows ?? (await db.query.engagements.findMany({ where: and(eq(schema.engagements.workspaceId, actor.workspaceId), notInArray(schema.engagements.status, CLOSED)) }));
  const open = all.filter((e) => !CLOSED.includes(e.status) && personOf(e));
  const byKey = new Map<string, EngagementRow[]>();
  for (const e of open) {
    const k = `${e.accountId}|${personOf(e)}`;
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  const candidates = [...byKey.values()].filter((g) => g.length > 1);
  if (!candidates.length) return [];
  const scores = await engagementScores(candidates.flat().map((e) => e.id));
  const [accounts, fls, users] = await Promise.all([
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(candidates.flat().map((e) => e.accountId))]), columns: { id: true, name: true } }),
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(candidates.flat().map((e) => e.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true } }),
  ]);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const pn = new Map<string, string>([...fls.map((f) => [`f:${f.id}`, f.displayName] as [string, string]), ...users.map((u) => [`u:${u.id}`, u.displayName] as [string, string])]);
  const out: EngagementDuplicate[] = [];
  for (const g of candidates) {
    // Überlappungs-Komponenten bilden
    const sorted = [...g].sort((a, b) => startOf(a).localeCompare(startOf(b)));
    const comps: EngagementRow[][] = [];
    let cur: EngagementRow[] = [];
    let curEnd = "";
    for (const e of sorted) {
      if (cur.length && startOf(e) <= curEnd) {
        cur.push(e);
        if (endOf(e) > curEnd) curEnd = endOf(e);
      } else {
        if (cur.length > 1) comps.push(cur);
        cur = [e];
        curEnd = endOf(e);
      }
    }
    if (cur.length > 1) comps.push(cur);
    for (const c of comps) {
      // Einsätze mit überschrittenem Ende sind Vorgänger, keine Dubletten – die räumt „Ende überschritten“ auf
      const t = todayIso();
      const live = c.filter((e) => !isOverdueEngagement(e, t));
      const list = live.length > 1 ? live : c;
      if (list.length < 2) continue;
      const refs = list.map((e) => ({ id: e.id, title: e.title, status: e.status, start: e.actualStart ?? e.plannedStart, end: e.actualEnd ?? e.plannedEnd, moco: e.mocoContractId, bdUserId: e.bdUserId, createdAt: e.createdAt, score: (scores.get(e.id) ?? 0) + (e.mocoContractId ? 2 : 0) }));
      refs.sort((a, b) => b.score - a.score || a.createdAt.getTime() - b.createdAt.getTime());
      const sameContract = new Set(list.map((e) => e.mocoContractId).filter(Boolean)).size === 1 && list.every((e) => e.mocoContractId);
      const mixed = list.some((e) => e.mocoContractId) && list.some((e) => !e.mocoContractId);
      out.push({
        accountId: list[0]!.accountId,
        accountName: an.get(list[0]!.accountId) ?? "?",
        personName: pn.get(personOf(list[0]!)!) ?? "?",
        keep: refs[0]!,
        drop: refs.slice(1),
        reason: sameContract ? "derselbe Moco-Vertrag mehrfach importiert" : mixed ? "aus Moco und zusätzlich von Hand angelegt" : "überlappende Laufzeit",
      });
    }
  }
  return out.sort((a, b) => a.accountName.localeCompare(b.accountName) || a.personName.localeCompare(b.personName));
}

async function setupScores(ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const r = (await db.execute(sql`
    select s.id,
      (select count(*) from opportunities o where o.setup_id = s.id) * 5
      + (select count(*) from engagements e where e.setup_id = s.id) * 5
      + (select count(*) from setup_memberships m where m.setup_id = s.id)
      + (select count(*) from signals g where g.setup_id = s.id)
      + case when s.context_note is not null then 2 else 0 end as score
    from project_setups s where s.id in ${sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`}`)) as unknown as { rows: { id: string; score: string | number }[] };
  return new Map(r.rows.map((x) => [x.id, Number(x.score)]));
}

/** Setups eines Kunden mit gleichem Namen (ohne Zusätze in Klammern, Groß-/Kleinschreibung, Satzzeichen). */
export async function findSetupDuplicates(actor: Actor): Promise<SetupDuplicate[]> {
  const setups = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.workspaceId, actor.workspaceId), columns: { id: true, name: true, accountId: true, status: true } });
  const groups = new Map<string, typeof setups>();
  for (const s of setups) {
    if (s.status === "ARCHIVIERT") continue;
    const k = `${s.accountId}|${normSetupName(s.name)}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const dup = [...groups.values()].filter((g) => g.length > 1);
  if (!dup.length) return [];
  const scores = await setupScores(dup.flat().map((s) => s.id));
  const accounts = await db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(dup.flat().map((s) => s.accountId))]), columns: { id: true, name: true } });
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  return dup.map((g) => {
    const refs = g.map((s) => ({ id: s.id, name: s.name, score: scores.get(s.id) ?? 0 })).sort((a, b) => b.score - a.score);
    return { accountId: g[0]!.accountId, accountName: an.get(g[0]!.accountId) ?? "?", name: refs[0]!.name, keep: refs[0]!, drop: refs.slice(1) };
  });
}

export async function findPersonDuplicates(actor: Actor): Promise<PersonDuplicate[]> {
  const people = await db.query.persons.findMany({ where: eq(schema.persons.workspaceId, actor.workspaceId), columns: { id: true, displayName: true, email: true, createdAt: true, accountId: true } });
  const byAcc = new Map<string, typeof people>();
  for (const p of people) if (p.accountId) byAcc.set(p.accountId, [...(byAcc.get(p.accountId) ?? []), p]);
  const out: PersonDuplicate[] = [];
  const accIds: string[] = [];
  for (const [acc, list] of byAcc) {
    for (const g of duplicateGroups(list)) {
      out.push({ accountId: acc, accountName: "", name: g[0]!.displayName, keepId: g[0]!.id, dropIds: g.slice(1).map((x) => x.id), emails: [...new Set(g.map((x) => x.email).filter((x): x is string => !!x))] });
      accIds.push(acc);
    }
  }
  if (accIds.length) {
    const accounts = await db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(accIds)]), columns: { id: true, name: true } });
    const an = new Map(accounts.map((a) => [a.id, a.name]));
    for (const o of out) o.accountName = an.get(o.accountId) ?? "?";
  }
  return out.sort((a, b) => a.accountName.localeCompare(b.accountName));
}

export type InternalFinding = { accountId: string; accountName: string; status: string; engagements: { id: string; title: string; status: string }[]; openHints: number };

/** Kunden, die interne Moco-Firmen sind (Konfiguration MOCO_INTERNAL_COMPANIES), mit ihren Einsätzen. */
export async function findInternalAccounts(actor: Actor): Promise<InternalFinding[]> {
  const accounts = await db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, actor.workspaceId), columns: { id: true, name: true, status: true } });
  const internal = accounts.filter((a) => isInternalMocoCompany(a.name));
  if (!internal.length) return [];
  const engs = await db.query.engagements.findMany({ where: inArray(schema.engagements.accountId, internal.map((a) => a.id)), columns: { id: true, title: true, status: true, accountId: true } });
  const out: InternalFinding[] = [];
  for (const a of internal) {
    const mine = engs.filter((e) => e.accountId === a.id);
    if (!mine.length && a.status === "ARCHIVED") continue;
    out.push({ accountId: a.id, accountName: a.name, status: a.status, engagements: mine.map((e) => ({ id: e.id, title: e.title, status: e.status })), openHints: 0 });
  }
  return out;
}

export type OverdueRef = { id: string; title: string; accountName: string; personName: string; status: string; end: string; renewalOpen: boolean };

export async function findOverdueEngagements(actor: Actor): Promise<OverdueRef[]> {
  const rows = await db.query.engagements.findMany({ where: and(eq(schema.engagements.workspaceId, actor.workspaceId), inArray(schema.engagements.status, ["AKTIV", "PAUSIERT", "ENDET"])) });
  const t = todayIso();
  const over = rows.filter((e) => isOverdueEngagement(e, t));
  if (!over.length) return [];
  const ids = over.map((e) => e.id);
  const [accounts, fls, users, rens] = await Promise.all([
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(over.map((e) => e.accountId))]), columns: { id: true, name: true } }),
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(over.map((e) => e.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true } }),
    db.query.renewalDecisions.findMany({ where: and(inArray(schema.renewalDecisions.engagementId, ids), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])), columns: { engagementId: true } }),
  ]);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const pn = new Map<string, string>([...fls.map((f) => [`f:${f.id}`, f.displayName] as [string, string]), ...users.map((u) => [`u:${u.id}`, u.displayName] as [string, string])]);
  const open = new Set(rens.map((r) => r.engagementId));
  return over
    .map((e) => ({ id: e.id, title: e.title, accountName: an.get(e.accountId) ?? "?", personName: pn.get(personOf(e) ?? "") ?? "?", status: e.status, end: (e.actualEnd ?? e.plannedEnd)!, renewalOpen: open.has(e.id) }))
    .sort((a, b) => a.end.localeCompare(b.end));
}

export async function cleanupReport(actor: Actor) {
  requireCleaner(actor);
  const [overdue, engagementDuplicates, setupDuplicates, personDuplicates, internal] = await Promise.all([
    findOverdueEngagements(actor),
    findEngagementDuplicates(actor),
    findSetupDuplicates(actor),
    findPersonDuplicates(actor),
    findInternalAccounts(actor),
  ]);
  const total = overdue.length + engagementDuplicates.length + setupDuplicates.length + personDuplicates.length + internal.length;
  return { overdue, engagementDuplicates, setupDuplicates, personDuplicates, internal, total };
}

/** Nur die Anzahl (für Hinweise in Navigation und Sales-Ops-Sicht). */
export async function cleanupCount(actor: Actor): Promise<number> {
  if (!canClean(actor)) return 0;
  return (await cleanupReport(actor)).total;
}

// ---------------------------------------------------------------------------
// Korrekturen
// ---------------------------------------------------------------------------

/** Einsätze mit überschrittenem Ende abschließen: aktiv/pausiert → endet (zum Enddatum) → abgeschlossen. Offene
 *  Verlängerungsentscheidung verhindert nur den letzten Schritt. */
export async function closeOverdueEngagements(actor: Actor, ids: string[]) {
  requireCleaner(actor);
  const t = todayIso();
  const res = { closed: 0, ended: 0, skipped: [] as string[] };
  for (const id of ids) {
    let e = await db.query.engagements.findFirst({ where: and(eq(schema.engagements.id, id), eq(schema.engagements.workspaceId, actor.workspaceId)) });
    if (!e || !isOverdueEngagement(e, t)) continue;
    const a = await engagementAccess(actor, e);
    if (!a?.manage) {
      res.skipped.push(`${e.title}: keine Berechtigung`);
      continue;
    }
    const end = (e.actualEnd ?? e.plannedEnd)!;
    try {
      if (e.status !== "ENDET") {
        await changeEngagementStatus(actor, id, { version: e.version, status: "ENDET", actualDate: end, reason: "Ende überschritten – in der Bereinigung beendet" });
        e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, id) }))!;
      }
      await changeEngagementStatus(actor, id, { version: e.version, status: "ABGESCHLOSSEN", reason: "Ende überschritten – in der Bereinigung abgeschlossen" });
      res.closed++;
    } catch (err) {
      const now = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, id), columns: { status: true } });
      if (now?.status === "ENDET") res.ended++;
      res.skipped.push(`${e.title}: ${err instanceof Error ? err.message : "nicht möglich"}`);
    }
    await db.update(schema.mocoHints).set({ status: "UEBERNOMMEN", resolvedAt: new Date(), resolvedBy: actor.userId }).where(and(eq(schema.mocoHints.subjectType, "ENGAGEMENT"), eq(schema.mocoHints.subjectId, id), eq(schema.mocoHints.kind, "ENDE_UEBERSCHRITTEN"), eq(schema.mocoHints.status, "OFFEN")));
  }
  return res;
}

/**
 * Zwei (oder mehr) Einsätze derselben Person beim selben Kunden zusammenführen. Der behaltene Einsatz übernimmt
 * Moco-Verknüpfung, Auftrag, Enddatum und Ansprechpartner, wo er selbst nichts hat; Check-ins, Unterlagen,
 * Betreuung, Perioden und Verlängerungsentscheidungen ziehen um. Der andere wird entfernt.
 */
export async function mergeEngagements(actor: Actor, keepId: string, dropIds: string[]) {
  requireCleaner(actor);
  const keepA = await requireManagedEngagement(actor, keepId);
  const keep0 = keepA.engagement;
  const drops: EngagementRow[] = [];
  for (const id of dropIds.filter((d) => d !== keepId)) {
    const a = await requireManagedEngagement(actor, id);
    if (a.engagement.accountId !== keep0.accountId || personOf(a.engagement) !== personOf(keep0)) throw new ValidationError("Nur Einsätze derselben Person beim selben Kunden lassen sich zusammenführen.");
    drops.push(a.engagement);
  }
  if (!drops.length) throw new ValidationError("Bitte mindestens einen weiteren Einsatz wählen.");
  const { loadForeignKeys } = await import("@/modules/accounts/deletion");
  let moved = 0;
  await db.transaction(async (tx) => {
    const fks = await loadForeignKeys(tx);
    let keep = keep0;
    for (const d of drops) {
      const patch: Partial<typeof schema.engagements.$inferInsert> = {};
      if (!keep.mocoContractId && d.mocoContractId) {
        patch.mocoContractId = d.mocoContractId;
        patch.mocoProjectId = d.mocoProjectId;
        await tx.update(schema.engagements).set({ mocoContractId: null, mocoProjectId: null }).where(eq(schema.engagements.id, d.id));
      }
      if (!keep.orderId && d.orderId) patch.orderId = d.orderId;
      if (!keep.plannedEnd && d.plannedEnd) patch.plannedEnd = d.plannedEnd;
      if (!keep.plannedStart && d.plannedStart) patch.plannedStart = d.plannedStart;
      if (!keep.actualStart && d.actualStart) patch.actualStart = d.actualStart;
      if (!keep.renewalDeadline && d.renewalDeadline) patch.renewalDeadline = d.renewalDeadline;
      if (!keep.renewalContactPersonId && d.renewalContactPersonId) patch.renewalContactPersonId = d.renewalContactPersonId;
      if (!keep.orderContactPersonId && d.orderContactPersonId) patch.orderContactPersonId = d.orderContactPersonId;
      if (!keep.renewalApproach && d.renewalApproach) patch.renewalApproach = d.renewalApproach;
      if (!keep.externalRef && d.externalRef) patch.externalRef = d.externalRef;
      if (Object.keys(patch).length) {
        const [u] = await tx.update(schema.engagements).set({ ...patch, version: keep.version + 1, updatedAt: new Date() }).where(eq(schema.engagements.id, keep.id)).returning();
        keep = u!;
      }
      // Kandidatur/Position/Chance gehören zum entfernten Einsatz und gehen mit ihm
      const r = await repointReferences(tx, fks, "engagements", d.id, keep.id);
      moved += r.moved;
      await repointSubjects(tx, ["ENGAGEMENT"], d.id, keep.id);
      const fresh = (await tx.query.engagements.findFirst({ where: eq(schema.engagements.id, d.id) }))!;
      await deleteEngagementTx(tx, fresh);
      await recordAudit(tx, actor, "engagement.merged", "ENGAGEMENT", keep.id, { entfernt: d.id, titel: d.title, moco: d.mocoContractId });
    }
  });
  return { kept: keepId, removed: drops.length, moved };
}

/** Setups eines Kunden zusammenführen: alles, was am entfernten Setup hängt, zieht ins behaltene. */
export async function mergeSetups(actor: Actor, keepId: string, dropIds: string[]) {
  requireCleaner(actor);
  const keep = await db.query.projectSetups.findFirst({ where: and(eq(schema.projectSetups.id, keepId), eq(schema.projectSetups.workspaceId, actor.workspaceId)) });
  if (!keep) throw new NotFoundError("Setup");
  const drops = await db.query.projectSetups.findMany({ where: and(inArray(schema.projectSetups.id, dropIds.filter((d) => d !== keepId).concat("-")), eq(schema.projectSetups.workspaceId, actor.workspaceId)) });
  if (!drops.length) throw new ValidationError("Bitte mindestens ein weiteres Setup wählen.");
  if (drops.some((d) => d.accountId !== keep.accountId)) throw new ValidationError("Nur Setups desselben Kunden lassen sich zusammenführen.");
  const { Cascade, loadForeignKeys } = await import("@/modules/accounts/deletion");
  let dropped = 0;
  await db.transaction(async (tx) => {
    const fks = await loadForeignKeys(tx);
    for (const d of drops) {
      await tx.update(schema.projectSetups).set({
        contextNote: keep.contextNote ?? d.contextNote,
        renewalContactPersonId: keep.renewalContactPersonId ?? d.renewalContactPersonId,
        orderContactPersonId: keep.orderContactPersonId ?? d.orderContactPersonId,
        renewalApproach: keep.renewalApproach ?? d.renewalApproach,
        bdUserId: keep.bdUserId ?? d.bdUserId,
        updatedAt: new Date(),
      }).where(eq(schema.projectSetups.id, keep.id));
      if (!keep.mocoProjectGroupId && d.mocoProjectGroupId) await tx.update(schema.projectSetups).set({ mocoProjectGroupId: d.mocoProjectGroupId }).where(eq(schema.projectSetups.id, keep.id));
      const r = await repointReferences(tx, fks, "project_setups", d.id, keep.id);
      dropped += r.dropped;
      await repointSubjects(tx, ["SETUP"], d.id, keep.id);
      await new Cascade(tx, fks).deleteRows("project_setups", [d.id]);
      await recordAudit(tx, actor, "setup.merged", "SETUP", keep.id, { entfernt: d.id, name: d.name });
    }
  });
  return { kept: keep.id, removed: drops.length, duplicatesDropped: dropped };
}

/** Personen-Dubletten eines Kunden zusammenführen (älteste bleibt). */
export async function mergePersonDuplicates(actor: Actor, keepId: string, dropIds: string[]) {
  requireCleaner(actor);
  return mergePersons(actor, keepId, dropIds);
}

/** Interne Moco-Firma: Einsätze entfernen und Kunde archivieren. */
export async function cleanInternalAccount(actor: Actor, accountId: string) {
  requireCleaner(actor);
  const account = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.workspaceId, actor.workspaceId)) });
  if (!account || !isInternalMocoCompany(account.name)) throw new ValidationError("Das ist keine interne Firma aus Moco.");
  const engs = await db.query.engagements.findMany({ where: eq(schema.engagements.accountId, accountId) });
  await db.transaction(async (tx) => {
    for (const e of engs) await deleteEngagementTx(tx, e);
    await tx.update(schema.mocoHints).set({ status: "VERWORFEN", resolvedAt: new Date(), resolvedBy: actor.userId }).where(and(eq(schema.mocoHints.workspaceId, actor.workspaceId), eq(schema.mocoHints.status, "OFFEN"), sql`${schema.mocoHints.payload}->>'accountId' = ${accountId}`));
    await tx.update(schema.accounts).set({ status: "ARCHIVED", mocoCompanyId: null, updatedAt: new Date() }).where(eq(schema.accounts.id, accountId));
    await recordAudit(tx, actor, "account.internal_cleaned", "ACCOUNT", accountId, { einsaetze: engs.length, name: account.name });
  });
  return { removed: engs.length };
}
