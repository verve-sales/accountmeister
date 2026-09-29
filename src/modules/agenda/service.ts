import { and, asc, eq, inArray, isNotNull, lte, gte } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canViewAccount, hasRoleForAccountWrite, canReassignResponsibility } from "@/modules/identity/authz";
import { getAccount } from "@/modules/accounts/service";

/**
 * Kundenagenda (Etappe 26): Was treibt den Kunden? Seine Prioritäten, Schlüssel-Initiativen (z. B. „Jira-Vertrag läuft
 * Ende 2026 aus“) und Herausforderungen – als Sachverhalte des Kunden, getrennt von unseren Chancen. Chancen verweisen
 * auf die Initiative, auf die sie einzahlen. Initiativen mit Datum erinnern rechtzeitig (Vorschlag, keine Pflicht).
 * Dazu der Beschaffungsweg (direkt, Vermittler, Rahmenvertrag) und der operative Berater je Einsatz.
 */

export const initiativeKindValues = ["PRIORITAET", "INITIATIVE", "HERAUSFORDERUNG"] as const;
export type InitiativeKind = (typeof initiativeKindValues)[number];
export const initiativeKindLabel: Record<InitiativeKind, string> = { PRIORITAET: "Priorität des Kunden", INITIATIVE: "Schlüssel-Initiative", HERAUSFORDERUNG: "Herausforderung" };
export const initiativeStatusValues = ["OFFEN", "ERLEDIGT", "VERWORFEN"] as const;

export const procurementValues = ["DIREKT", "VERMITTLER", "RAHMENVERTRAG"] as const;
export const procurementLabel: Record<string, string> = { DIREKT: "direkt beim Kunden", VERMITTLER: "über Vermittler", RAHMENVERTRAG: "über Rahmenvertrag" };

/** Wie viele Tage vor dem Datum einer Initiative der Accountmeister erinnert. */
export const INITIATIVE_REMINDER_DAYS = 120;

const dateOpt = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum bitte als JJJJ-MM-TT").optional().or(z.literal(""));

export function canMaintainAgenda(actor: Actor, account: typeof schema.accounts.$inferSelect): boolean {
  return canViewAccount(actor, account) && (hasRoleForAccountWrite(actor, account) || canReassignResponsibility(actor, account));
}

async function requireAgendaAccount(actor: Actor, accountId: string) {
  const account = await getAccount(actor, accountId);
  if (!canMaintainAgenda(actor, account)) throw new ForbiddenError("Die Kundenagenda pflegen BD, Anker, Principal oder Sales Operations des Kunden.");
  return account;
}

/** Freitext wie „Ende 2026“, „Q2 2027“, „März 2027“ oder „31.12.2026“ in ein Datum übersetzen (sonst null). */
export function parseDueHint(hint: string | null | undefined): string | null {
  if (!hint) return null;
  const t = hint.trim().toLowerCase();
  let m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return m[0];
  m = /q([1-4])\s*\/?\s*(\d{4})/.exec(t);
  if (m) return `${m[2]}-${["03-31", "06-30", "09-30", "12-31"][Number(m[1]) - 1]}`;
  const months = ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];
  m = new RegExp(`(${months.join("|")})\\s+(\\d{4})`).exec(t);
  if (m) {
    const mi = months.indexOf(m[1]!) + 1;
    const last = new Date(Date.UTC(Number(m[2]), mi, 0)).getUTCDate();
    return `${m[2]}-${String(mi).padStart(2, "0")}-${last}`;
  }
  m = /(ende|mitte|anfang)\s+(\d{4})/.exec(t);
  if (m) return `${m[2]}-${m[1] === "ende" ? "12-31" : m[1] === "mitte" ? "06-30" : "03-31"}`;
  return null;
}

export const initiativeInput = z.object({
  accountId: z.string().min(1),
  kind: z.enum(initiativeKindValues),
  title: z.string().trim().min(3, "Bitte kurz benennen").max(300),
  description: z.string().trim().max(4000).optional().or(z.literal("")),
  dueDate: dateOpt,
  dueHint: z.string().trim().max(100).optional().or(z.literal("")),
  sourceId: z.string().optional().or(z.literal("")),
});

export async function createInitiative(actor: Actor, raw: unknown) {
  const parsed = initiativeInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  await requireAgendaAccount(actor, i.accountId);
  const dueDate = i.dueDate || parseDueHint(i.dueHint) || null;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.accountInitiatives)
      .values({ workspaceId: actor.workspaceId, accountId: i.accountId, kind: i.kind, title: i.title, description: i.description || null, dueDate, dueHint: i.dueHint || null, sourceId: i.sourceId || null, createdBy: actor.userId })
      .returning();
    await recordAudit(tx, actor, "initiative.created", "ACCOUNT", i.accountId, { art: i.kind, titel: i.title });
    return row!;
  });
}

export const initiativeStatusInput = z.object({ version: z.coerce.number().int().positive(), status: z.enum(initiativeStatusValues) });

export async function setInitiativeStatus(actor: Actor, initiativeId: string, raw: unknown) {
  const parsed = initiativeStatusInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError("Ungültiger Status.");
  const row = await db.query.accountInitiatives.findFirst({ where: and(eq(schema.accountInitiatives.id, initiativeId), eq(schema.accountInitiatives.workspaceId, actor.workspaceId)) });
  if (!row) throw new NotFoundError("Eintrag der Kundenagenda");
  await requireAgendaAccount(actor, row.accountId);
  const [u] = await db
    .update(schema.accountInitiatives)
    .set({ status: parsed.data.status, updatedAt: new Date(), version: row.version + 1 })
    .where(and(eq(schema.accountInitiatives.id, initiativeId), eq(schema.accountInitiatives.version, parsed.data.version)))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "initiative.status", "ACCOUNT", row.accountId, { status: parsed.data.status });
  return u;
}

export async function listInitiatives(actor: Actor, accountId: string) {
  const account = await getAccount(actor, accountId);
  const rows = await db.query.accountInitiatives.findMany({ where: eq(schema.accountInitiatives.accountId, account.id), orderBy: [asc(schema.accountInitiatives.createdAt)] });
  const opps = await db.query.opportunities.findMany({ where: and(eq(schema.opportunities.accountId, account.id), isNotNull(schema.opportunities.initiativeId)), columns: { id: true, title: true, status: true, initiativeId: true } });
  return rows.map((r) => ({ ...r, chances: opps.filter((o) => o.initiativeId === r.id) }));
}

/** Chance einer Initiative zuordnen (oder lösen). */
export async function linkChanceToInitiative(actor: Actor, opportunityId: string, initiativeId: string | null) {
  const opp = await db.query.opportunities.findFirst({ where: and(eq(schema.opportunities.id, opportunityId), eq(schema.opportunities.workspaceId, actor.workspaceId)) });
  if (!opp) throw new NotFoundError("Chance");
  await requireAgendaAccount(actor, opp.accountId);
  if (initiativeId) {
    const ini = await db.query.accountInitiatives.findFirst({ where: eq(schema.accountInitiatives.id, initiativeId) });
    if (!ini || ini.accountId !== opp.accountId) throw new ValidationError("Die Initiative gehört nicht zu diesem Kunden.");
  }
  await db.update(schema.opportunities).set({ initiativeId, updatedAt: new Date() }).where(eq(schema.opportunities.id, opportunityId));
  await recordAudit(db, actor, "opportunity.initiative_linked", "OPPORTUNITY", opportunityId, { initiativeId });
}

// ---------------------------------------------------------------------------
// Beschaffungsweg
// ---------------------------------------------------------------------------

export const procurementInput = z.object({
  version: z.coerce.number().int().positive(),
  procurementChannel: z.enum(procurementValues).or(z.literal("")),
  intermediaryName: z.string().trim().max(200).optional().or(z.literal("")),
  procurementNote: z.string().trim().max(1000).optional().or(z.literal("")),
});

export async function updateProcurement(actor: Actor, accountId: string, raw: unknown) {
  const parsed = procurementInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  const account = await requireAgendaAccount(actor, accountId);
  if (i.procurementChannel === "VERMITTLER" && !i.intermediaryName) throw new ValidationError("Bitte den Vermittler nennen.");
  const [u] = await db
    .update(schema.accounts)
    .set({ procurementChannel: i.procurementChannel || null, intermediaryName: i.procurementChannel === "VERMITTLER" ? i.intermediaryName || null : i.intermediaryName || null, procurementNote: i.procurementNote || null, updatedAt: new Date(), version: account.version + 1 })
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.version, i.version)))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "account.procurement", "ACCOUNT", accountId, { weg: i.procurementChannel || null, vermittler: i.intermediaryName || null });
  return u;
}

// ---------------------------------------------------------------------------
// Operativer Berater je Einsatz
// ---------------------------------------------------------------------------

export const consultantInput = z.object({ version: z.coerce.number().int().positive(), consultantUserId: z.string().optional().or(z.literal("")), consultantName: z.string().trim().max(200).optional().or(z.literal("")) });

export async function setOrderConsultant(actor: Actor, orderId: string, raw: unknown) {
  const parsed = consultantInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError("Ungültige Angabe zum Berater.");
  const order = await db.query.orders.findFirst({ where: and(eq(schema.orders.id, orderId), eq(schema.orders.workspaceId, actor.workspaceId)) });
  if (!order) throw new NotFoundError("Einsatz");
  const opp = await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, order.opportunityId) });
  await requireAgendaAccount(actor, opp!.accountId);
  const i = parsed.data;
  let consultantName = i.consultantName || null;
  if (i.consultantUserId) {
    const u = await db.query.users.findFirst({ where: and(eq(schema.users.id, i.consultantUserId), eq(schema.users.workspaceId, actor.workspaceId)) });
    if (!u) throw new ValidationError("Unbekannte Person.");
    consultantName = u.displayName;
  }
  const [u] = await db
    .update(schema.orders)
    .set({ consultantUserId: i.consultantUserId || null, consultantName, updatedAt: new Date(), version: order.version + 1 })
    .where(and(eq(schema.orders.id, orderId), eq(schema.orders.version, i.version)))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "order.consultant", "ORDER", orderId, { berater: consultantName });
  return u;
}

// ---------------------------------------------------------------------------
// Erinnerung vor dem Datum einer Initiative (als vorgeschlagene Aktion für den zuständigen BD)
// ---------------------------------------------------------------------------

const DAY = 86400000;

export async function ensureInitiativeReminders(actor: Actor, now = new Date()): Promise<number> {
  const accounts = await db.query.accounts.findMany({ where: and(eq(schema.accounts.workspaceId, actor.workspaceId), eq(schema.accounts.responsibleBdUserId, actor.userId), eq(schema.accounts.status, "ACTIVE")) });
  if (!accounts.length) return 0;
  const ids = accounts.map((a) => a.id);
  const horizon = new Date(now.getTime() + INITIATIVE_REMINDER_DAYS * DAY).toISOString().slice(0, 10);
  const todayIso = now.toISOString().slice(0, 10);
  const due = await db.query.accountInitiatives.findMany({ where: and(inArray(schema.accountInitiatives.accountId, ids), eq(schema.accountInitiatives.status, "OFFEN"), isNotNull(schema.accountInitiatives.dueDate), lte(schema.accountInitiatives.dueDate, horizon), gte(schema.accountInitiatives.dueDate, todayIso)) });
  if (!due.length) return 0;
  const keys = due.map((d) => `initiative:${d.id}`);
  const have = new Set((await db.query.standardTasks.findMany({ where: and(eq(schema.standardTasks.workspaceId, actor.workspaceId), inArray(schema.standardTasks.key, keys)) })).map((x) => x.key));
  const setups = await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.accountId, ids) });
  let created = 0;
  for (const d of due) {
    const key = `initiative:${d.id}`;
    if (have.has(key)) continue;
    const setup = setups.find((s) => s.accountId === d.accountId && s.status !== "ARCHIVIERT");
    if (!setup) continue;
    await db.transaction(async (tx) => {
      const [log] = await tx.insert(schema.standardTasks).values({ workspaceId: actor.workspaceId, key, kind: "INITIATIVE_FAELLIG", accountId: d.accountId, ownerUserId: actor.userId }).onConflictDoNothing().returning();
      if (!log) return;
      const [a] = await tx
        .insert(schema.actions)
        .values({
          workspaceId: actor.workspaceId,
          setupId: setup.id,
          title: `Kundeninitiative „${d.title.slice(0, 90)}“ steht am ${d.dueDate} an – Chance prüfen`,
          agreement: "Erinnerung aus der Kundenagenda: Was braucht der Kunde bis dahin? Wo können wir mit Verve-Experten oder Freelancern unterstützen? Ergebnis als Chance erfassen oder bewusst verwerfen.",
          ownerUserId: actor.userId,
          status: "VORGESCHLAGEN",
          dueDate: new Date(now.getTime() + 14 * DAY).toISOString().slice(0, 10),
          createdBy: actor.userId,
        })
        .returning();
      await tx.update(schema.standardTasks).set({ actionId: a!.id }).where(eq(schema.standardTasks.id, log.id));
      await recordAudit(tx, actor, "standard_task.created", "ACTION", a!.id, { kind: "INITIATIVE_FAELLIG", key });
      created++;
    });
  }
  return created;
}

export async function ensureInitiativeRemindersSafe(actor: Actor): Promise<number> {
  try {
    return await ensureInitiativeReminders(actor);
  } catch (e) {
    console.error("Erinnerungen zur Kundenagenda konnten nicht erzeugt werden", e);
    return 0;
  }
}
