import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { recordAudit } from "@/modules/audit/audit";
import { createWorkItem } from "@/modules/work/service";
import { todayIso } from "@/modules/work/calendar";

/**
 * „Meine Principals“ (Etappe 38, Use Case 7): Die Geschäftsführung setzt je Principal und Quartal Ziele –
 * Köpfe je Kunde, Neukunden, Verlängerungsquote – und führt mit dem Principal ein Gespräch entlang
 * Lage → Zahlen → offene Entscheidungen → Vereinbarungen. Stichtag ist das Quartalsende; im laufenden Quartal
 * zählt der Stand von heute. Kein Umsatz (bewusst, Entscheidung 26.10.2026).
 */

export const METRICS = ["KOEPFE", "NEUKUNDEN", "VERLAENGERUNGSQUOTE"] as const;
export type Metric = (typeof METRICS)[number];
export const metricLabel: Record<Metric, string> = { KOEPFE: "Köpfe", NEUKUNDEN: "Neukunden", VERLAENGERUNGSQUOTE: "Verlängerungsquote" };

// --- Quartal ----------------------------------------------------------------

export type Quarter = { key: string; label: string; start: string; end: string };

export function quarterOf(iso: string): Quarter {
  const y = Number(iso.slice(0, 4));
  const q = Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
  return quarterFromKey(`${y}-Q${q}`)!;
}

export function quarterFromKey(key: string | null | undefined): Quarter | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(key ?? "");
  if (!m) return null;
  const y = Number(m[1]);
  const q = Number(m[2]);
  const sm = (q - 1) * 3 + 1;
  const em = sm + 2;
  const lastDay = new Date(Date.UTC(y, em, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { key: `${y}-Q${q}`, label: `Q${q} ${y}`, start: `${y}-${pad(sm)}-01`, end: `${y}-${pad(em)}-${pad(lastDay)}` };
}

export function shiftQuarter(q: Quarter, by: number): Quarter {
  const [y, n] = [Number(q.key.slice(0, 4)), Number(q.key.slice(6))];
  const idx = y * 4 + (n - 1) + by;
  return quarterFromKey(`${Math.floor(idx / 4)}-Q${(idx % 4) + 1}`)!;
}

/** Stichtag: Quartalsende; im laufenden Quartal heute; ein künftiges Quartal hat noch keinen Ist-Wert. */
export function referenceDate(q: Quarter, today = todayIso()): string | null {
  if (today < q.start) return null;
  return today < q.end ? today : q.end;
}

// --- Rechte -----------------------------------------------------------------

export function canSetTargets(actor: Actor): boolean {
  return hasRole(actor, "CEO");
}

function isPrincipal(actor: Actor): boolean {
  return actor.roles.has("PRINCIPAL") || [...actor.accountRoles.values()].some((r) => r.has("PRINCIPAL"));
}

/** Gesprächsseite: Geschäftsführung für alle, ein Principal nur für sich selbst. */
function assertCanView(actor: Actor, principalUserId: string) {
  if (canSetTargets(actor)) return;
  if (isPrincipal(actor) && actor.userId === principalUserId) return;
  throw new ForbiddenError("Ziele und Gespräch eines Principals sehen die Geschäftsführung und der Principal selbst.");
}

// --- Principals und ihre Kunden ---------------------------------------------

export type PrincipalRef = { userId: string; name: string; accountIds: string[]; workspaceWide: boolean; level: "PRINCIPAL" | "ACCOUNT_LEAD" };
export const levelLabel = { PRINCIPAL: "Principal", ACCOUNT_LEAD: "Account Lead" } as const;

export async function listPrincipals(workspaceId: string): Promise<PrincipalRef[]> {
  const t = todayIso();
  const roles = (await db.query.roleAssignments.findMany({ where: and(eq(schema.roleAssignments.workspaceId, workspaceId), eq(schema.roleAssignments.role, "PRINCIPAL")) })).filter((r) => !r.validTo || r.validTo >= t);
  if (!roles.length) return [];
  const users = await db.query.users.findMany({ where: and(inArray(schema.users.id, [...new Set(roles.map((r) => r.userId))]), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true } });
  const accounts = await db.query.accounts.findMany({ where: and(eq(schema.accounts.workspaceId, workspaceId), inArray(schema.accounts.status, ["ACTIVE", "DORMANT"])), columns: { id: true } });
  const live = new Set(accounts.map((a) => a.id));
  // Kundenverantwortung (Etappe 45): gezählt werden nur kundenbezogene Zuordnungen – eine arbeitsraumweite
  // Principal-Rolle gibt Rechte bei allen Kunden, macht aber nicht für alle verantwortlich
  return users
    .map((u) => {
      const mine = roles.filter((r) => r.userId === u.id);
      const workspaceWide = mine.some((r) => r.scope === "WORKSPACE");
      const own = mine.filter((r) => r.scope === "ACCOUNT" && r.accountId && live.has(r.accountId));
      const accountIds = [...new Set(own.map((r) => r.accountId!))];
      const level: PrincipalRef["level"] = own.length && own.every((r) => r.level === "ACCOUNT_LEAD") ? "ACCOUNT_LEAD" : "PRINCIPAL";
      return { userId: u.id, name: u.displayName, accountIds, workspaceWide, level };
    })
    .filter((p) => p.accountIds.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

// --- Ist-Werte --------------------------------------------------------------

type Eng = typeof schema.engagements.$inferSelect;
const COUNTING = (e: Eng) => !["VORBEREITUNG", "ABGEBROCHEN"].includes(e.status);
const startOf = (e: Eng) => e.actualStart ?? e.plannedStart;
const endOf = (e: Eng) => e.actualEnd ?? e.plannedEnd;

/** Köpfe am Stichtag: verschiedene Personen mit laufendem Einsatz beim Kunden. */
export function headsAt(engs: Eng[], ref: string): number {
  const people = new Set<string>();
  for (const e of engs) {
    if (!COUNTING(e)) continue;
    const s = startOf(e);
    const en = endOf(e);
    if (!s || s > ref) continue;
    if (en && en < ref) continue;
    people.add(e.freelancerId ?? e.internalUserId ?? e.id);
  }
  return people.size;
}

export type Actuals = {
  ref: string | null;
  heads: Map<string, number>;
  headsTotal: number;
  newCustomers: { accountId: string; name: string; since: string }[];
  renewals: { confirmed: number; rejected: number; quote: number | null };
};

export async function computeActuals(accountIds: string[], q: Quarter, today = todayIso()): Promise<Actuals> {
  const ref = referenceDate(q, today);
  const empty: Actuals = { ref, heads: new Map(), headsTotal: 0, newCustomers: [], renewals: { confirmed: 0, rejected: 0, quote: null } };
  if (!accountIds.length || !ref) return empty;
  const [engs, accounts] = await Promise.all([
    db.query.engagements.findMany({ where: inArray(schema.engagements.accountId, accountIds) }),
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, accountIds), columns: { id: true, name: true, sideBusiness: true } }),
  ]);
  // Köpfe aus Nebengeschäft (kleine Serviceaufträge, Durchreiche) zählen nicht (Etappe 45)
  const side = new Set(accounts.filter((a) => a.sideBusiness).map((a) => a.id));
  const heads = new Map<string, number>();
  for (const id of accountIds) heads.set(id, side.has(id) ? 0 : headsAt(engs.filter((e) => e.accountId === id), ref));
  // Neukunde: erster zählender Einsatz des Kunden beginnt im Quartal (bis zum Stichtag)
  const newCustomers: Actuals["newCustomers"] = [];
  for (const a of accounts) {
    const starts = engs.filter((e) => e.accountId === a.id && COUNTING(e) && startOf(e)).map((e) => startOf(e)!).sort();
    const first = starts[0];
    if (first && first >= q.start && first <= ref) newCustomers.push({ accountId: a.id, name: a.name, since: first });
  }
  // Verlängerungsquote: im Quartal entschiedene Verlängerungen – bestätigt ÷ (bestätigt + abgelehnt)
  const decs = engs.length ? await db.query.renewalDecisions.findMany({ where: and(inArray(schema.renewalDecisions.engagementId, engs.map((e) => e.id)), inArray(schema.renewalDecisions.status, ["BESTAETIGT", "ABGELEHNT"])) }) : [];
  let confirmed = 0;
  let rejected = 0;
  for (const d of decs) {
    const day = (d.decidedAt ?? d.updatedAt ?? d.createdAt).toISOString().slice(0, 10);
    if (day < q.start || day > ref) continue;
    if (d.status === "BESTAETIGT") confirmed++;
    else rejected++;
  }
  const total = confirmed + rejected;
  return {
    ref,
    heads,
    headsTotal: [...heads.values()].reduce((a, b) => a + b, 0),
    newCustomers: newCustomers.sort((a, b) => a.since.localeCompare(b.since)),
    renewals: { confirmed, rejected, quote: total ? Math.round((confirmed / total) * 100) : null },
  };
}

// --- Ziele ------------------------------------------------------------------

export type Targets = { heads: Map<string, number>; headsTotal: number | null; newCustomers: number | null; renewalQuote: number | null };

export async function loadTargets(principalUserId: string, q: Quarter): Promise<Targets> {
  const rows = await db.query.principalTargets.findMany({ where: and(eq(schema.principalTargets.principalUserId, principalUserId), eq(schema.principalTargets.quarter, q.key)) });
  const heads = new Map<string, number>();
  for (const r of rows) if (r.metric === "KOEPFE" && r.accountId) heads.set(r.accountId, r.target);
  return {
    heads,
    headsTotal: heads.size ? [...heads.values()].reduce((a, b) => a + b, 0) : null,
    newCustomers: rows.find((r) => r.metric === "NEUKUNDEN")?.target ?? null,
    renewalQuote: rows.find((r) => r.metric === "VERLAENGERUNGSQUOTE")?.target ?? null,
  };
}

const targetsInput = z.object({
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/, "Quartal im Format 2026-Q4."),
  heads: z.record(z.string(), z.string()).default({}),
  newCustomers: z.string().default(""),
  renewalQuote: z.string().default(""),
});

function parseCount(v: string, label: string, max: number): number | null {
  const s = v.trim();
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  if (!Number.isInteger(n) || n < 0 || n > max) throw new ValidationError(`${label}: bitte eine ganze Zahl von 0 bis ${max}.`);
  return n;
}

/** Ziele setzen (nur Geschäftsführung). Leeres Feld = kein Ziel. */
export async function saveTargets(actor: Actor, principalUserId: string, raw: unknown) {
  if (!canSetTargets(actor)) throw new ForbiddenError("Ziele der Principals setzt die Geschäftsführung.");
  const p = targetsInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const principal = (await listPrincipals(actor.workspaceId)).find((x) => x.userId === principalUserId);
  if (!principal) throw new NotFoundError("Principal");
  const wanted: { metric: Metric; accountId: string | null; target: number }[] = [];
  for (const [accountId, v] of Object.entries(p.data.heads)) {
    if (!principal.accountIds.includes(accountId)) continue;
    const n = parseCount(v, "Köpfe", 500);
    if (n !== null) wanted.push({ metric: "KOEPFE", accountId, target: n });
  }
  const nc = parseCount(p.data.newCustomers, "Neukunden", 100);
  if (nc !== null) wanted.push({ metric: "NEUKUNDEN", accountId: null, target: nc });
  const rq = parseCount(p.data.renewalQuote, "Verlängerungsquote", 100);
  if (rq !== null) wanted.push({ metric: "VERLAENGERUNGSQUOTE", accountId: null, target: rq });
  await db.transaction(async (tx) => {
    await tx.delete(schema.principalTargets).where(and(eq(schema.principalTargets.principalUserId, principalUserId), eq(schema.principalTargets.quarter, p.data.quarter)));
    if (wanted.length) await tx.insert(schema.principalTargets).values(wanted.map((w) => ({ ...w, workspaceId: actor.workspaceId, principalUserId, quarter: p.data.quarter, setBy: actor.userId })));
    await recordAudit(tx, actor, "principal.targets_set", "USER", principalUserId, { quartal: p.data.quarter, ziele: wanted.length });
  });
  return wanted.length;
}

// --- Vereinbarungen ---------------------------------------------------------

export async function addAgreement(actor: Actor, principalUserId: string, raw: { quarter?: string; text?: string; dueDate?: string }) {
  if (!canSetTargets(actor)) throw new ForbiddenError("Vereinbarungen hält die Geschäftsführung im Gespräch fest.");
  const q = quarterFromKey(raw.quarter);
  if (!q) throw new ValidationError("Quartal fehlt.");
  const text = (raw.text ?? "").trim();
  if (text.length < 3) throw new ValidationError("Bitte die Vereinbarung kurz beschreiben.");
  if (!raw.dueDate) throw new ValidationError("Bitte eine Frist setzen – Vereinbarungen ohne Frist gehen unter.");
  const principal = (await listPrincipals(actor.workspaceId)).find((x) => x.userId === principalUserId);
  if (!principal) throw new NotFoundError("Principal");
  const title = text.length > 110 ? `${text.slice(0, 107)}…` : text;
  const w = await createWorkItem(actor, { title: `Vereinbarung ${q.label}: ${title}`, description: text, subjectType: "OHNE", target: principalUserId, dueDate: raw.dueDate, priority: "NORMAL", kind: "AKTION" });
  const [row] = await db.insert(schema.principalAgreements).values({ workspaceId: actor.workspaceId, principalUserId, quarter: q.key, text, dueDate: raw.dueDate, workItemId: w.id, createdBy: actor.userId }).returning();
  await recordAudit(db, actor, "principal.agreement", "USER", principalUserId, { quartal: q.key, frist: raw.dueDate });
  return row!;
}

export type AgreementView = { id: string; text: string; dueDate: string | null; status: string; done: boolean; overdue: boolean; quarter: string; workItemId: string | null; createdAt: Date };

export async function listAgreements(principalUserId: string, today = todayIso()): Promise<AgreementView[]> {
  const rows = await db.query.principalAgreements.findMany({ where: eq(schema.principalAgreements.principalUserId, principalUserId) });
  const wis = rows.some((r) => r.workItemId) ? await db.query.workItems.findMany({ where: inArray(schema.workItems.id, rows.map((r) => r.workItemId).filter((x): x is string => !!x)), columns: { id: true, status: true } }) : [];
  const ws = new Map(wis.map((w) => [w.id, w.status]));
  return rows
    .map((r) => {
      const status = (r.workItemId ? ws.get(r.workItemId) : null) ?? "ANGEFRAGT";
      const done = status === "ERLEDIGT" || status === "VERWORFEN";
      return { id: r.id, text: r.text, dueDate: r.dueDate, status, done, overdue: !done && !!r.dueDate && r.dueDate < today, quarter: r.quarter, workItemId: r.workItemId, createdAt: r.createdAt };
    })
    .sort((a, b) => Number(a.done) - Number(b.done) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
}

// --- Übersicht und Gespräch -------------------------------------------------

export type PrincipalSummary = {
  principal: PrincipalRef;
  targets: Targets;
  actuals: Actuals;
  openAgreements: number;
  overdueAgreements: number;
  openRenewals: number;
};

async function openRenewalCount(accountIds: string[]): Promise<number> {
  if (!accountIds.length) return 0;
  const engs = await db.query.engagements.findMany({ where: and(inArray(schema.engagements.accountId, accountIds), inArray(schema.engagements.status, ["AKTIV", "PAUSIERT", "GEPLANT", "ENDET"])), columns: { id: true } });
  if (!engs.length) return 0;
  const d = await db.query.renewalDecisions.findMany({ where: and(inArray(schema.renewalDecisions.engagementId, engs.map((e) => e.id)), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])), columns: { id: true } });
  return d.length;
}

async function summarize(p: PrincipalRef, q: Quarter, today: string): Promise<PrincipalSummary> {
  const [targets, actuals, agreements, openRenewals] = await Promise.all([loadTargets(p.userId, q), computeActuals(p.accountIds, q, today), listAgreements(p.userId, today), openRenewalCount(p.accountIds)]);
  return { principal: p, targets, actuals, openAgreements: agreements.filter((a) => !a.done).length, overdueAgreements: agreements.filter((a) => a.overdue).length, openRenewals };
}

/** Übersicht „Meine Principals“ – nur Geschäftsführung. */
export async function buildPrincipalOverview(actor: Actor, quarterKey?: string | null, today = todayIso()) {
  if (!canSetTargets(actor)) throw new ForbiddenError("„Meine Principals“ sieht die Geschäftsführung.");
  const q = quarterFromKey(quarterKey) ?? quarterOf(today);
  const principals = await listPrincipals(actor.workspaceId);
  const rows: PrincipalSummary[] = [];
  for (const p of principals) rows.push(await summarize(p, q, today));
  return { quarter: q, rows };
}

/** Eigene Ziele eines Principals (für den Principal-Hut auf der Startseite). */
export async function myPrincipalSummary(actor: Actor, today = todayIso()): Promise<(PrincipalSummary & { quarter: Quarter }) | null> {
  if (!isPrincipal(actor)) return null;
  const p = (await listPrincipals(actor.workspaceId)).find((x) => x.userId === actor.userId);
  if (!p) return null;
  const q = quarterOf(today);
  return { ...(await summarize(p, q, today)), quarter: q };
}

/** Gesprächsseite: Lage → Zahlen → offene Entscheidungen → Vereinbarungen. */
export async function buildTalk(actor: Actor, principalUserId: string, quarterKey?: string | null, today = todayIso()) {
  assertCanView(actor, principalUserId);
  const q = quarterFromKey(quarterKey) ?? quarterOf(today);
  const p = (await listPrincipals(actor.workspaceId)).find((x) => x.userId === principalUserId);
  if (!p) throw new NotFoundError("Principal");
  const summary = await summarize(p, q, today);
  const accounts = p.accountIds.length ? await db.query.accounts.findMany({ where: inArray(schema.accounts.id, p.accountIds), columns: { id: true, name: true, responsibleBdUserId: true } }) : [];
  const engs = p.accountIds.length ? await db.query.engagements.findMany({ where: inArray(schema.engagements.accountId, p.accountIds) }) : [];
  const bdIds = [...new Set(accounts.map((a) => a.responsibleBdUserId).filter((x): x is string => !!x))];
  const users = await db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true } });
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const fls = await db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...new Set(engs.map((e) => e.freelancerId).filter((x): x is string => !!x)), "-"]), columns: { id: true, displayName: true } });
  const fn = new Map(fls.map((f) => [f.id, f.displayName]));
  const running = engs.filter((e) => ["AKTIV", "PAUSIERT", "GEPLANT", "ENDET"].includes(e.status));
  const decisions = running.length ? await db.query.renewalDecisions.findMany({ where: and(inArray(schema.renewalDecisions.engagementId, running.map((e) => e.id)), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])) }) : [];
  const accName = new Map(accounts.map((a) => [a.id, a.name]));
  const openDecisions = decisions
    .map((d) => {
      const e = running.find((x) => x.id === d.engagementId)!;
      const person = e.freelancerId ? fn.get(e.freelancerId) ?? "?" : e.internalUserId ? un.get(e.internalUserId) ?? "?" : "?";
      const daysToEnd = e.plannedEnd ? Math.round((new Date(e.plannedEnd).getTime() - new Date(today).getTime()) / 86400000) : null;
      return { engagementId: e.id, person, accountName: accName.get(e.accountId) ?? "?", status: d.status, plannedEnd: e.plannedEnd, proposedTo: d.proposedTo, daysToEnd, bdName: e.bdUserId ? un.get(e.bdUserId) ?? null : null };
    })
    .sort((a, b) => (a.daysToEnd ?? 9999) - (b.daysToEnd ?? 9999));
  const ref = summary.actuals.ref;
  const lage = accounts
    .map((a) => {
      const mine = running.filter((e) => e.accountId === a.id && e.plannedEnd).sort((x, y) => x.plannedEnd!.localeCompare(y.plannedEnd!));
      return {
        accountId: a.id,
        name: a.name,
        bdName: a.responsibleBdUserId ? un.get(a.responsibleBdUserId) ?? "?" : null,
        headsNow: headsAt(engs.filter((e) => e.accountId === a.id), today),
        headsRef: ref ? summary.actuals.heads.get(a.id) ?? 0 : null,
        headsTarget: summary.targets.heads.get(a.id) ?? null,
        nextEnd: mine[0]?.plannedEnd ?? null,
      };
    })
    .sort((a, b) => b.headsNow - a.headsNow || a.name.localeCompare(b.name, "de"));
  return { quarter: q, principal: p, summary, lage, bdCount: bdIds.length, openDecisions, agreements: await listAgreements(p.userId, today), canEdit: canSetTargets(actor) };
}
