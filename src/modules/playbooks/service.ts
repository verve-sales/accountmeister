import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "@/db/client";
import type { PlaybookScope } from "@/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { canCreateSetup, canEditSetup, canReassignResponsibility, canViewSetup, loadSetupContext } from "@/modules/identity/authz";
import { listVisibleAccounts } from "@/modules/accounts/service";
import { ALTKUNDEN_CODE, DEFAULT_PLAYBOOKS } from "./defaults";

/**
 * Vorgehensmuster (Etappe 20): ein Standard-Vorgehen als Gerüst.
 *  - Muster pflegen: Principal, CEO oder Betriebsverwaltung. Lesen: alle mit fachlicher Rolle (dient auch der Einarbeitung).
 *  - Anwenden: auf einen Kunden (über ein bestehendes oder neues Setup), ein Setup oder eine Chance.
 *  - Immer genau ein Schritt ist aktiv und als normale Aktion angelegt (Meine Arbeit, Weekly). Wird die Aktion
 *    erledigt oder verworfen – egal wo –, rückt das Vorgehen zum nächsten Schritt vor.
 *  - Keine Pflichtschleuse: Schritte dürfen begründet übersprungen, Vorgehen begründet zurückgestellt werden.
 */

type RunRow = typeof schema.playbookRuns.$inferSelect;
type RunStepRow = typeof schema.playbookRunSteps.$inferSelect;

// ---------------------------------------------------------------------------
// Muster
// ---------------------------------------------------------------------------

export function canManagePlaybooks(actor: Actor): boolean {
  // Workspace-weite Führungsrolle oder Betriebsverwaltung (kundenbezogene Principals pflegen keine arbeitsraumweiten Muster)
  return actor.roles.has("PRINCIPAL") || actor.roles.has("CEO") || actor.roles.has("ADMIN");
}

function assertManage(actor: Actor) {
  if (!canManagePlaybooks(actor)) throw new ForbiddenError("Vorgehensmuster pflegen Principal, CEO oder die Betriebsverwaltung.");
}

/** Legt die Standardmuster im Arbeitsraum an, falls noch nicht vorhanden (idempotent über den Code). */
export async function ensureDefaultPlaybooks(workspaceId: string, tx: Tx | Db = db): Promise<void> {
  for (const p of DEFAULT_PLAYBOOKS) {
    const [row] = await tx
      .insert(schema.playbooks)
      .values({ workspaceId, code: p.code, name: p.name, description: p.description, scope: p.scope })
      .onConflictDoNothing({ target: [schema.playbooks.workspaceId, schema.playbooks.code] })
      .returning();
    if (row) {
      await tx.insert(schema.playbookSteps).values(p.steps.map((s, i) => ({ playbookId: row.id, position: i + 1, ...s })));
    }
  }
}

export async function listPlaybooks(actor: Actor, opts: { scope?: PlaybookScope; activeOnly?: boolean } = {}) {
  await ensureDefaultPlaybooks(actor.workspaceId);
  const rows = await db.query.playbooks.findMany({
    where: and(
      eq(schema.playbooks.workspaceId, actor.workspaceId),
      opts.scope ? eq(schema.playbooks.scope, opts.scope) : undefined,
      opts.activeOnly ? eq(schema.playbooks.active, true) : undefined,
    ),
    orderBy: [asc(schema.playbooks.name)],
  });
  const ids = rows.map((r) => r.id);
  const steps = ids.length ? await db.query.playbookSteps.findMany({ where: inArray(schema.playbookSteps.playbookId, ids), orderBy: [asc(schema.playbookSteps.position)] }) : [];
  return rows.map((p) => ({ ...p, steps: steps.filter((s) => s.playbookId === p.id) }));
}

async function requirePlaybook(actor: Actor, playbookId: string, tx: Tx | Db = db) {
  const p = await tx.query.playbooks.findFirst({ where: and(eq(schema.playbooks.id, playbookId), eq(schema.playbooks.workspaceId, actor.workspaceId)) });
  if (!p) throw new NotFoundError("Vorgehensmuster");
  return p;
}

const optText = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

export const createPlaybookInput = z.object({
  name: z.string().trim().min(3, "Name ist zu kurz").max(120),
  description: optText(1000),
  scope: z.enum(schema.playbookScopeEnum.enumValues),
});

export async function createPlaybook(actor: Actor, raw: unknown) {
  assertManage(actor);
  const parsed = createPlaybookInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const code = `EIGEN_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const [p] = await db.insert(schema.playbooks).values({ workspaceId: actor.workspaceId, code, name: input.name, description: input.description || null, scope: input.scope, createdBy: actor.userId }).returning();
  if (!p) throw new Error("Muster konnte nicht angelegt werden");
  await recordAudit(db, actor, "playbook.created", "PLAYBOOK", p.id, { name: p.name, scope: p.scope });
  return p;
}

export const updatePlaybookInput = z.object({
  version: z.coerce.number().int().positive(),
  name: z.string().trim().min(3).max(120),
  description: optText(1000),
  active: z.union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()]).optional(),
});

export async function updatePlaybook(actor: Actor, playbookId: string, raw: unknown) {
  assertManage(actor);
  const parsed = updatePlaybookInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  await requirePlaybook(actor, playbookId);
  const active = input.active === true || input.active === "on" || input.active === "true";
  const [u] = await db
    .update(schema.playbooks)
    .set({ name: input.name, description: input.description || null, active, version: input.version + 1, updatedAt: new Date() })
    .where(and(eq(schema.playbooks.id, playbookId), eq(schema.playbooks.version, input.version)))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "playbook.updated", "PLAYBOOK", playbookId, { active });
  return u;
}

export const stepInput = z.object({
  title: z.string().trim().min(3, "Schritt-Titel ist zu kurz").max(160),
  goal: optText(1000),
  meddpicc: optText(200),
  suggestedAction: optText(2000),
  doneCriterion: optText(1000),
  dueInDays: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : v), z.coerce.number().int().min(0).max(365).optional()),
});

function stepValues(i: z.infer<typeof stepInput>) {
  return { title: i.title, goal: i.goal || null, meddpicc: i.meddpicc || null, suggestedAction: i.suggestedAction || null, doneCriterion: i.doneCriterion || null, dueInDays: i.dueInDays ?? null };
}

export async function addPlaybookStep(actor: Actor, playbookId: string, raw: unknown) {
  assertManage(actor);
  const parsed = stepInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  await requirePlaybook(actor, playbookId);
  const [max] = await db.select({ m: sql<number>`coalesce(max(${schema.playbookSteps.position}), 0)` }).from(schema.playbookSteps).where(eq(schema.playbookSteps.playbookId, playbookId));
  const [s] = await db.insert(schema.playbookSteps).values({ playbookId, position: Number(max?.m ?? 0) + 1, ...stepValues(parsed.data) }).returning();
  await recordAudit(db, actor, "playbook.step_added", "PLAYBOOK", playbookId, { title: parsed.data.title });
  return s!;
}

async function requireStep(actor: Actor, stepId: string) {
  const s = await db.query.playbookSteps.findFirst({ where: eq(schema.playbookSteps.id, stepId) });
  if (!s) throw new NotFoundError("Schritt");
  await requirePlaybook(actor, s.playbookId);
  return s;
}

export async function updatePlaybookStep(actor: Actor, stepId: string, raw: unknown) {
  assertManage(actor);
  const parsed = stepInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const s = await requireStep(actor, stepId);
  await db.update(schema.playbookSteps).set(stepValues(parsed.data)).where(eq(schema.playbookSteps.id, stepId));
  await recordAudit(db, actor, "playbook.step_updated", "PLAYBOOK", s.playbookId, { stepId });
}

async function renumber(tx: Tx | Db, playbookId: string) {
  const steps = await tx.query.playbookSteps.findMany({ where: eq(schema.playbookSteps.playbookId, playbookId), orderBy: [asc(schema.playbookSteps.position), asc(schema.playbookSteps.createdAt)] });
  for (const [i, st] of steps.entries()) if (st.position !== i + 1) await tx.update(schema.playbookSteps).set({ position: i + 1 }).where(eq(schema.playbookSteps.id, st.id));
}

export async function removePlaybookStep(actor: Actor, stepId: string) {
  assertManage(actor);
  const s = await requireStep(actor, stepId);
  await db.transaction(async (tx) => {
    await tx.delete(schema.playbookSteps).where(eq(schema.playbookSteps.id, stepId));
    await renumber(tx, s.playbookId);
    await recordAudit(tx, actor, "playbook.step_removed", "PLAYBOOK", s.playbookId, { title: s.title });
  });
}

export async function movePlaybookStep(actor: Actor, stepId: string, direction: "up" | "down") {
  assertManage(actor);
  const s = await requireStep(actor, stepId);
  await db.transaction(async (tx) => {
    const steps = await tx.query.playbookSteps.findMany({ where: eq(schema.playbookSteps.playbookId, s.playbookId), orderBy: [asc(schema.playbookSteps.position)] });
    const i = steps.findIndex((x) => x.id === stepId);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= steps.length) return;
    await tx.update(schema.playbookSteps).set({ position: steps[j]!.position }).where(eq(schema.playbookSteps.id, steps[i]!.id));
    await tx.update(schema.playbookSteps).set({ position: steps[i]!.position }).where(eq(schema.playbookSteps.id, steps[j]!.id));
  });
}

// ---------------------------------------------------------------------------
// Läufe
// ---------------------------------------------------------------------------

export const startRunInput = z.object({
  playbookId: z.string().min(1, "Bitte ein Vorgehensmuster wählen."),
  accountId: optText(100),
  setupId: optText(100),
  opportunityId: optText(100),
  /** Nur bei Kunden-Mustern: neues Setup für das Vorgehen anlegen (Name), statt ein bestehendes zu nutzen */
  newSetupName: optText(200),
  ownerUserId: optText(100),
});

function dueDateIn(days: number | null): string | null {
  if (days === null || days === undefined) return null;
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

async function requireActiveUser(actor: Actor, userId: string, tx: Tx | Db = db) {
  const u = await tx.query.users.findFirst({ where: and(eq(schema.users.id, userId), eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")) });
  if (!u) throw new ValidationError("Person nicht gefunden oder inaktiv.");
  return u;
}

export async function startPlaybookRun(actor: Actor, raw: unknown) {
  const parsed = startRunInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  await ensureDefaultPlaybooks(actor.workspaceId);
  const playbook = await requirePlaybook(actor, input.playbookId);
  if (!playbook.active) throw new ValidationError("Dieses Vorgehensmuster ist deaktiviert.");
  const steps = await db.query.playbookSteps.findMany({ where: eq(schema.playbookSteps.playbookId, playbook.id), orderBy: [asc(schema.playbookSteps.position)] });
  if (steps.length === 0) throw new ValidationError("Das Vorgehensmuster hat noch keine Schritte.");

  // Ziel auflösen: Kunde (+ Setup bestehend/neu), Setup oder Chance
  let account: typeof schema.accounts.$inferSelect | undefined;
  let setupId: string | null = null;
  let opportunityId: string | null = null;
  if (playbook.scope === "OPPORTUNITY") {
    if (!input.opportunityId) throw new ValidationError("Dieses Muster wird auf eine Chance angewendet.");
    const opp = await db.query.opportunities.findFirst({ where: and(eq(schema.opportunities.id, input.opportunityId), eq(schema.opportunities.workspaceId, actor.workspaceId)) });
    if (!opp) throw new NotFoundError("Chance");
    if (opp.status === "BEENDET") throw new TransitionError("Auf eine beendete Chance wird kein Vorgehen mehr angewendet.");
    opportunityId = opp.id;
    setupId = opp.setupId;
  } else if (playbook.scope === "SETUP") {
    if (!input.setupId) throw new ValidationError("Dieses Muster wird auf ein Setup angewendet.");
    setupId = input.setupId;
    // Von einer Chance aus gestartet (z. B. Verlängerung): Vorgehen und Aktionen hängen an dieser Chance
    if (input.opportunityId) {
      const opp = await db.query.opportunities.findFirst({ where: and(eq(schema.opportunities.id, input.opportunityId), eq(schema.opportunities.workspaceId, actor.workspaceId)) });
      if (!opp || opp.setupId !== setupId) throw new ValidationError("Die Chance gehört nicht zu diesem Setup.");
      if (opp.status === "BEENDET") throw new TransitionError("Auf eine beendete Chance wird kein Vorgehen mehr angewendet.");
      opportunityId = opp.id;
    }
  } else {
    if (!input.accountId) throw new ValidationError("Dieses Muster wird auf einen Kunden angewendet.");
    if (input.setupId) setupId = input.setupId;
    else if (!input.newSetupName) throw new ValidationError("Bitte ein bestehendes Setup wählen oder einen Namen für ein neues Setup angeben.");
  }

  if (setupId) {
    const ctx = await loadSetupContext(actor, setupId);
    if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
    if (input.accountId && ctx.account.id !== input.accountId) throw new ValidationError("Setup gehört nicht zu diesem Kunden.");
    if (ctx.setup.status === "ARCHIVIERT") throw new TransitionError("Auf ein archiviertes Setup wird kein Vorgehen angewendet.");
    if (!canEditSetup(actor, ctx) && !canReassignResponsibility(actor, ctx.account)) throw new ForbiddenError("Sie dürfen hier kein Vorgehen starten.");
    account = ctx.account;
  } else {
    account = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, input.accountId!), eq(schema.accounts.workspaceId, actor.workspaceId)) });
    if (!account) throw new NotFoundError("Kunde");
    if (!canReassignResponsibility(actor, account) && !canCreateSetup(actor, account)) throw new ForbiddenError("Sie dürfen für diesen Kunden kein Vorgehen starten.");
  }
  if (account.status === "ARCHIVED") throw new TransitionError("Der Kunde ist archiviert – bitte zuerst wiederherstellen.");

  // Doppelte Läufe desselben Musters am selben Objekt vermeiden
  if (setupId) {
    const dup = await db.query.playbookRuns.findFirst({
      where: and(eq(schema.playbookRuns.playbookId, playbook.id), eq(schema.playbookRuns.setupId, setupId), eq(schema.playbookRuns.status, "AKTIV"), opportunityId ? eq(schema.playbookRuns.opportunityId, opportunityId) : undefined),
    });
    if (dup) throw new ValidationError("Dieses Vorgehen läuft hier bereits.");
  }

  const setupRow = setupId ? await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, setupId) }) : undefined;
  const ownerUserId = input.ownerUserId || setupRow?.bdUserId || account.responsibleBdUserId || actor.userId;
  await requireActiveUser(actor, ownerUserId);
  const acc = account;

  return db.transaction(async (tx) => {
    let targetSetupId = setupId;
    if (!targetSetupId) {
      const [s] = await tx
        .insert(schema.projectSetups)
        .values({ workspaceId: actor.workspaceId, accountId: acc.id, name: input.newSetupName!, contextNote: `Vorgehen „${playbook.name}“`, status: "AKTIV", visibility: "ACCOUNT_TEAM", bdUserId: ownerUserId, createdBy: actor.userId })
        .returning();
      if (!s) throw new Error("Setup konnte nicht angelegt werden");
      targetSetupId = s.id;
      await tx.insert(schema.setupMemberships).values({ setupId: s.id, userId: ownerUserId, contribution: "BD_ZUSTAENDIG", canEdit: true });
      if (ownerUserId !== actor.userId) await tx.insert(schema.setupMemberships).values({ setupId: s.id, userId: actor.userId, contribution: "BEOBACHTER", canEdit: true });
      await recordAudit(tx, actor, "setup.created", "SETUP", s.id, { name: s.name, ausVorgehen: playbook.code });
    }
    if (acc.status === "DORMANT") {
      await tx.update(schema.accounts).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(schema.accounts.id, acc.id));
      await recordAudit(tx, actor, "account.reactivated", "ACCOUNT", acc.id, { durch: playbook.code });
    }
    if (playbook.code === ALTKUNDEN_CODE) {
      // Im Accountplan sichtbar machen: Vorhaben „Reaktivieren“ (Zustimmung wie jedes Vorhaben im Accountplan)
      await tx.insert(schema.accountPriorities).values({ workspaceId: actor.workspaceId, accountId: acc.id, setupId: targetSetupId, kind: "REAKTIVIEREN", title: `Reaktivierung ${acc.name}`, rationale: `Vorgehen „${playbook.name}“ gestartet.`, createdBy: actor.userId });
    }
    const [run] = await tx
      .insert(schema.playbookRuns)
      .values({ workspaceId: actor.workspaceId, playbookId: playbook.id, playbookName: playbook.name, accountId: acc.id, setupId: targetSetupId!, opportunityId, ownerUserId, startedBy: actor.userId })
      .returning();
    if (!run) throw new Error("Vorgehen konnte nicht gestartet werden");
    const runSteps = await tx
      .insert(schema.playbookRunSteps)
      .values(steps.map((s) => ({ runId: run.id, stepId: s.id, position: s.position, title: s.title, goal: s.goal, meddpicc: s.meddpicc, suggestedAction: s.suggestedAction, doneCriterion: s.doneCriterion, dueInDays: s.dueInDays })))
      .returning();
    await activateStep(tx, actor, run, runSteps.sort((a, b) => a.position - b.position)[0]!, runSteps.length);
    await recordAudit(tx, actor, "playbook.run_started", "PLAYBOOK_RUN", run.id, { playbook: playbook.code, owner: ownerUserId });
    return run;
  });
}

/** Schritt aktivieren: als normale Aktion für die verantwortliche Person anlegen. */
async function activateStep(tx: Tx, actor: Actor, run: RunRow, step: RunStepRow, total: number) {
  const agreement = [step.suggestedAction, step.doneCriterion ? `Erledigt, wenn: ${step.doneCriterion}` : null].filter(Boolean).join("\n");
  const [a] = await tx
    .insert(schema.actions)
    .values({
      workspaceId: run.workspaceId,
      setupId: run.setupId,
      opportunityId: run.opportunityId,
      title: `${run.playbookName} · Schritt ${step.position}/${total}: ${step.title}`,
      agreement: agreement || null,
      ownerUserId: run.ownerUserId,
      status: run.ownerUserId === actor.userId ? "ANGENOMMEN" : "VORGESCHLAGEN",
      dueDate: dueDateIn(step.dueInDays),
      createdBy: actor.userId,
    })
    .returning();
  await tx.update(schema.playbookRunSteps).set({ status: "OFFEN", actionId: a!.id }).where(eq(schema.playbookRunSteps.id, step.id));
}

/** Nächsten wartenden Schritt aktivieren – oder das Vorgehen abschließen. */
async function advance(tx: Tx, actor: Actor, runId: string) {
  const run = await tx.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.id, runId) });
  if (!run || run.status !== "AKTIV") return;
  const steps = await tx.query.playbookRunSteps.findMany({ where: eq(schema.playbookRunSteps.runId, runId), orderBy: [asc(schema.playbookRunSteps.position)] });
  if (steps.some((s) => s.status === "OFFEN")) return;
  const next = steps.find((s) => s.status === "WARTET");
  if (next) {
    await activateStep(tx, actor, run, next, steps.length);
  } else {
    await tx.update(schema.playbookRuns).set({ status: "ABGESCHLOSSEN", version: run.version + 1, updatedAt: new Date() }).where(eq(schema.playbookRuns.id, runId));
    await recordAudit(tx, actor, "playbook.run_completed", "PLAYBOOK_RUN", runId);
  }
}

async function requireRunStep(actor: Actor, runStepId: string) {
  const step = await db.query.playbookRunSteps.findFirst({ where: eq(schema.playbookRunSteps.id, runStepId) });
  if (!step) throw new NotFoundError("Schritt");
  const { run, ctx } = await requireRun(actor, step.runId);
  return { step, run, ctx };
}

async function requireRun(actor: Actor, runId: string) {
  const run = await db.query.playbookRuns.findFirst({ where: and(eq(schema.playbookRuns.id, runId), eq(schema.playbookRuns.workspaceId, actor.workspaceId)) });
  if (!run) throw new NotFoundError("Vorgehen");
  const ctx = await loadSetupContext(actor, run.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Vorgehen");
  return { run, ctx };
}

function canWorkOnRun(actor: Actor, run: RunRow, ctx: NonNullable<Awaited<ReturnType<typeof loadSetupContext>>>): boolean {
  return run.ownerUserId === actor.userId || canEditSetup(actor, ctx) || canReassignResponsibility(actor, ctx.account);
}

export const completeStepInput = z.object({ result: z.string().trim().min(5, "Bitte das Ergebnis des Schritts festhalten (mind. 5 Zeichen).").max(4000) });

/** Schritt erledigen: Ergebnis dokumentieren; die zugehörige Aktion wird mit demselben Ergebnis erledigt. */
export async function completeRunStep(actor: Actor, runStepId: string, raw: unknown) {
  const parsed = completeStepInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const { step, run, ctx } = await requireRunStep(actor, runStepId);
  if (!canWorkOnRun(actor, run, ctx)) throw new ForbiddenError("Sie dürfen an diesem Vorgehen nicht arbeiten.");
  if (run.status !== "AKTIV") throw new TransitionError("Dieses Vorgehen ist nicht aktiv.");
  if (step.status !== "OFFEN") throw new TransitionError("Dieser Schritt ist nicht der aktuelle Schritt.");
  return db.transaction(async (tx) => {
    await closeStepAction(tx, step, "ERLEDIGT", parsed.data.result);
    await tx.update(schema.playbookRunSteps).set({ status: "ERLEDIGT", result: parsed.data.result, completedBy: actor.userId, completedAt: new Date() }).where(eq(schema.playbookRunSteps.id, step.id));
    await recordAudit(tx, actor, "playbook.step_completed", "PLAYBOOK_RUN", run.id, { schritt: step.position });
    await advance(tx, actor, run.id);
  });
}

export const skipStepInput = z.object({ reason: z.string().trim().min(5, "Bitte begründen, warum der Schritt übersprungen wird.").max(2000) });

export async function skipRunStep(actor: Actor, runStepId: string, raw: unknown) {
  const parsed = skipStepInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const { step, run, ctx } = await requireRunStep(actor, runStepId);
  if (!canWorkOnRun(actor, run, ctx)) throw new ForbiddenError("Sie dürfen an diesem Vorgehen nicht arbeiten.");
  if (run.status !== "AKTIV") throw new TransitionError("Dieses Vorgehen ist nicht aktiv.");
  if (step.status !== "OFFEN") throw new TransitionError("Dieser Schritt ist nicht der aktuelle Schritt.");
  return db.transaction(async (tx) => {
    await closeStepAction(tx, step, "VERWORFEN", `Übersprungen: ${parsed.data.reason}`);
    await tx.update(schema.playbookRunSteps).set({ status: "UEBERSPRUNGEN", skipReason: parsed.data.reason, completedBy: actor.userId, completedAt: new Date() }).where(eq(schema.playbookRunSteps.id, step.id));
    await recordAudit(tx, actor, "playbook.step_skipped", "PLAYBOOK_RUN", run.id, { schritt: step.position });
    await advance(tx, actor, run.id);
  });
}

async function closeStepAction(tx: Tx, step: RunStepRow, status: "ERLEDIGT" | "VERWORFEN", result: string) {
  if (!step.actionId) return;
  const a = await tx.query.actions.findFirst({ where: eq(schema.actions.id, step.actionId) });
  if (!a || a.status === "ERLEDIGT" || a.status === "VERWORFEN") return;
  await tx.update(schema.actions).set({ status, result, version: a.version + 1, updatedAt: new Date() }).where(eq(schema.actions.id, a.id));
}

/**
 * Wird aus changeActionStatus aufgerufen: eine Schritt-Aktion wurde anderswo (Setup-Seite, Meine Arbeit, Weekly)
 * erledigt oder verworfen → Schritt übernehmen und zum nächsten vorrücken.
 */
export async function syncRunStepFromAction(tx: Tx, actor: Actor, action: typeof schema.actions.$inferSelect) {
  if (action.status !== "ERLEDIGT" && action.status !== "VERWORFEN") return;
  const step = await tx.query.playbookRunSteps.findFirst({ where: and(eq(schema.playbookRunSteps.actionId, action.id), eq(schema.playbookRunSteps.status, "OFFEN")) });
  if (!step) return;
  const run = await tx.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.id, step.runId) });
  if (!run || run.status !== "AKTIV") return;
  if (action.status === "ERLEDIGT") {
    await tx.update(schema.playbookRunSteps).set({ status: "ERLEDIGT", result: action.result, completedBy: actor.userId, completedAt: new Date() }).where(eq(schema.playbookRunSteps.id, step.id));
  } else {
    await tx.update(schema.playbookRunSteps).set({ status: "UEBERSPRUNGEN", skipReason: action.result || "Aktion verworfen", completedBy: actor.userId, completedAt: new Date() }).where(eq(schema.playbookRunSteps.id, step.id));
  }
  await advance(tx, actor, run.id);
}

export const closeRunInput = z.object({ version: z.coerce.number().int().positive(), reason: z.string().trim().min(5, "Bitte begründen, warum das Vorgehen zurückgestellt wird.").max(2000) });

/** Vorgehen bewusst zurückstellen (z. B. „passt gerade nicht, Wiedervorlage in 6 Monaten“). */
export async function pauseRun(actor: Actor, runId: string, raw: unknown) {
  const parsed = closeRunInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const { run, ctx } = await requireRun(actor, runId);
  if (!canWorkOnRun(actor, run, ctx)) throw new ForbiddenError("Sie dürfen an diesem Vorgehen nicht arbeiten.");
  if (run.status !== "AKTIV") throw new TransitionError("Dieses Vorgehen ist nicht aktiv.");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.playbookRuns)
      .set({ status: "ZURUECKGESTELLT", closedReason: parsed.data.reason, version: parsed.data.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.playbookRuns.id, runId), eq(schema.playbookRuns.version, parsed.data.version)))
      .returning();
    if (!u) throw new ConflictError();
    // Offener Schritt geht zurück auf „wartet“, seine Aktion wird verworfen – bei Wiederaufnahme entsteht eine neue.
    const open = await tx.query.playbookRunSteps.findMany({ where: and(eq(schema.playbookRunSteps.runId, runId), eq(schema.playbookRunSteps.status, "OFFEN")) });
    for (const s of open) {
      await closeStepAction(tx, s, "VERWORFEN", `Vorgehen zurückgestellt: ${parsed.data.reason}`);
      await tx.update(schema.playbookRunSteps).set({ status: "WARTET", actionId: null }).where(eq(schema.playbookRunSteps.id, s.id));
    }
    await recordAudit(tx, actor, "playbook.run_paused", "PLAYBOOK_RUN", runId, { grund: parsed.data.reason });
    return u;
  });
}

export async function resumeRun(actor: Actor, runId: string, raw: { version: number | string }) {
  const version = Number(raw.version);
  const { run, ctx } = await requireRun(actor, runId);
  if (!canWorkOnRun(actor, run, ctx)) throw new ForbiddenError("Sie dürfen an diesem Vorgehen nicht arbeiten.");
  if (run.status !== "ZURUECKGESTELLT") throw new TransitionError("Nur zurückgestellte Vorgehen können wieder aufgenommen werden.");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.playbookRuns)
      .set({ status: "AKTIV", closedReason: null, version: version + 1, updatedAt: new Date() })
      .where(and(eq(schema.playbookRuns.id, runId), eq(schema.playbookRuns.version, version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "playbook.run_resumed", "PLAYBOOK_RUN", runId);
    await advance(tx, actor, runId);
    return u;
  });
}

export const reassignRunInput = z.object({ version: z.coerce.number().int().positive(), ownerUserId: z.string().min(1, "Bitte eine verantwortliche Person wählen.") });

/** Delegation (Etappe 19) auch für Vorgehen: Verantwortliche umstellen – der offene Schritt wandert mit. */
export async function reassignRunOwner(actor: Actor, runId: string, raw: unknown) {
  const parsed = reassignRunInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const { run, ctx } = await requireRun(actor, runId);
  if (run.ownerUserId !== actor.userId && !canReassignResponsibility(actor, ctx.account)) throw new ForbiddenError("Die Verantwortung stellen Principal, CEO, der zuständige BD oder die bisher verantwortliche Person um.");
  if (run.ownerUserId === parsed.data.ownerUserId) throw new ValidationError("Diese Person ist bereits verantwortlich.");
  await requireActiveUser(actor, parsed.data.ownerUserId);
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.playbookRuns)
      .set({ ownerUserId: parsed.data.ownerUserId, version: parsed.data.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.playbookRuns.id, runId), eq(schema.playbookRuns.version, parsed.data.version)))
      .returning();
    if (!u) throw new ConflictError();
    const open = await tx.query.playbookRunSteps.findMany({ where: and(eq(schema.playbookRunSteps.runId, runId), eq(schema.playbookRunSteps.status, "OFFEN")) });
    for (const s of open) {
      if (!s.actionId) continue;
      const a = await tx.query.actions.findFirst({ where: eq(schema.actions.id, s.actionId) });
      if (!a || a.status === "ERLEDIGT" || a.status === "VERWORFEN") continue;
      await tx.update(schema.actions).set({ ownerUserId: parsed.data.ownerUserId, status: parsed.data.ownerUserId === actor.userId ? "ANGENOMMEN" : "VORGESCHLAGEN", version: a.version + 1, updatedAt: new Date() }).where(eq(schema.actions.id, a.id));
    }
    // Neue verantwortliche Person wird Setup-Mitglied (bearbeitend), damit sie am Vorgehen arbeiten kann.
    await tx.insert(schema.setupMemberships).values({ setupId: run.setupId, userId: parsed.data.ownerUserId, contribution: "BD_ZUSTAENDIG", canEdit: true }).onConflictDoNothing();
    await recordAudit(tx, actor, "playbook.run_reassigned", "PLAYBOOK_RUN", runId, { von: run.ownerUserId, nach: parsed.data.ownerUserId });
    return u;
  });
}

/** Läufe für einen Kunden, ein Setup oder eine Chance – nur die für den Akteur sichtbaren. */
export async function listRuns(actor: Actor, where: { accountId?: string; setupId?: string; opportunityId?: string }) {
  const rows = await db.query.playbookRuns.findMany({
    where: and(
      eq(schema.playbookRuns.workspaceId, actor.workspaceId),
      where.accountId ? eq(schema.playbookRuns.accountId, where.accountId) : undefined,
      where.setupId ? eq(schema.playbookRuns.setupId, where.setupId) : undefined,
      where.opportunityId ? eq(schema.playbookRuns.opportunityId, where.opportunityId) : undefined,
    ),
    orderBy: [desc(schema.playbookRuns.createdAt)],
  });
  const visible: RunRow[] = [];
  const mayWork = new Map<string, boolean>();
  const mayReassign = new Map<string, boolean>();
  for (const r of rows) {
    const ctx = await loadSetupContext(actor, r.setupId);
    if (!ctx || !canViewSetup(actor, ctx)) continue;
    visible.push(r);
    mayWork.set(r.id, canWorkOnRun(actor, r, ctx));
    mayReassign.set(r.id, r.ownerUserId === actor.userId || canReassignResponsibility(actor, ctx.account));
  }
  if (visible.length === 0) return [];
  const runIds = visible.map((r) => r.id);
  const steps = await db.query.playbookRunSteps.findMany({ where: inArray(schema.playbookRunSteps.runId, runIds), orderBy: [asc(schema.playbookRunSteps.position)] });
  const actionIds = steps.map((s) => s.actionId).filter((x): x is string => !!x);
  const acts = actionIds.length ? await db.query.actions.findMany({ where: inArray(schema.actions.id, actionIds) }) : [];
  const actById = new Map(acts.map((a) => [a.id, a]));
  const setupIds = [...new Set(visible.map((r) => r.setupId))];
  const setups = await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.id, setupIds) });
  const setupNames = new Map(setups.map((s) => [s.id, s.name]));
  const oppIds = [...new Set(visible.map((r) => r.opportunityId).filter((x): x is string => !!x))];
  const oppRows = oppIds.length ? await db.query.opportunities.findMany({ where: inArray(schema.opportunities.id, oppIds), columns: { id: true, title: true } }) : [];
  const oppTitles = new Map(oppRows.map((o) => [o.id, o.title]));
  const userIds = [...new Set([...visible.map((r) => r.ownerUserId), ...acts.map((a) => a.ownerUserId)])];
  const users = userIds.length ? await db.query.users.findMany({ where: inArray(schema.users.id, userIds) }) : [];
  const names = new Map(users.map((u) => [u.id, u.displayName]));
  return visible.map((r) => ({
    ...r,
    ownerName: names.get(r.ownerUserId) ?? "?",
    setupName: setupNames.get(r.setupId) ?? "",
    opportunityTitle: r.opportunityId ? (oppTitles.get(r.opportunityId) ?? null) : null,
    canWork: mayWork.get(r.id) ?? false,
    canReassign: mayReassign.get(r.id) ?? false,
    steps: steps
      .filter((s) => s.runId === r.id)
      .map((s) => {
        const a = s.actionId ? actById.get(s.actionId) : undefined;
        return { ...s, action: a ? { id: a.id, status: a.status, dueDate: a.dueDate, ownerName: names.get(a.ownerUserId) ?? "?" } : null };
      }),
  }));
}

export type RunView = Awaited<ReturnType<typeof listRuns>>[number];

/**
 * Lernschleife (Unternehmensebene): Wie oft wurde ein Muster gestartet/abgeschlossen/zurückgestellt,
 * und welche Schritte werden erledigt bzw. übersprungen? Nur Zählungen, keine Bewertung einzelner Personen.
 */
export async function playbookStats(actor: Actor) {
  const runs = await db
    .select({ playbookId: schema.playbookRuns.playbookId, status: schema.playbookRuns.status, n: sql<number>`count(*)::int` })
    .from(schema.playbookRuns)
    .where(eq(schema.playbookRuns.workspaceId, actor.workspaceId))
    .groupBy(schema.playbookRuns.playbookId, schema.playbookRuns.status);
  const steps = await db
    .select({ playbookId: schema.playbookRuns.playbookId, position: schema.playbookRunSteps.position, status: schema.playbookRunSteps.status, n: sql<number>`count(*)::int` })
    .from(schema.playbookRunSteps)
    .innerJoin(schema.playbookRuns, eq(schema.playbookRuns.id, schema.playbookRunSteps.runId))
    .where(eq(schema.playbookRuns.workspaceId, actor.workspaceId))
    .groupBy(schema.playbookRuns.playbookId, schema.playbookRunSteps.position, schema.playbookRunSteps.status);
  type Stat = { runs: Record<string, number>; steps: Map<number, { erledigt: number; uebersprungen: number }> };
  const result = new Map<string, Stat>();
  const empty = (): Stat => ({ runs: {}, steps: new Map() });
  for (const r of runs) {
    const e = result.get(r.playbookId) ?? empty();
    e.runs[r.status] = Number(r.n);
    result.set(r.playbookId, e);
  }
  for (const s of steps) {
    const e = result.get(s.playbookId) ?? empty();
    const st = e.steps.get(s.position) ?? { erledigt: 0, uebersprungen: 0 };
    if (s.status === "ERLEDIGT") st.erledigt += Number(s.n);
    if (s.status === "UEBERSPRUNGEN") st.uebersprungen += Number(s.n);
    e.steps.set(s.position, st);
    result.set(s.playbookId, e);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Ruhende Kunden (Einstieg in die Reaktivierung)
// ---------------------------------------------------------------------------

export const DORMANT_AFTER_DAYS = 180;

/**
 * Kunden, die als „ruhend“ markiert sind oder seit DORMANT_AFTER_DAYS Tagen keine Aktivität mehr hatten
 * (Setups, Aktionen, Beobachtungen, Chancen). Sortiert nach längster Inaktivität.
 */
export async function listDormantAccounts(actor: Actor, days = DORMANT_AFTER_DAYS) {
  const accounts = (await listVisibleAccounts(actor)).filter((a) => a.status !== "ARCHIVED");
  if (accounts.length === 0) return [];
  const ids = accounts.map((a) => a.id);
  const rows = await db.execute(sql`
    select a.id as "accountId", greatest(
      a.created_at,
      coalesce((select max(s.updated_at) from project_setups s where s.account_id = a.id), a.created_at),
      coalesce((select max(x.updated_at) from actions x join project_setups s on s.id = x.setup_id where s.account_id = a.id), a.created_at),
      coalesce((select max(g.created_at) from signals g join project_setups s on s.id = g.setup_id where s.account_id = a.id), a.created_at),
      coalesce((select max(o.updated_at) from opportunities o where o.account_id = a.id), a.created_at)
    ) as "lastActivity"
    from accounts a where a.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
  `);
  const list = ((rows as unknown as { rows?: { accountId: string; lastActivity: Date | string }[] }).rows ?? []) as { accountId: string; lastActivity: Date | string }[];
  const last = new Map(list.map((r) => [r.accountId, new Date(r.lastActivity)]));
  const activeRuns = await db.query.playbookRuns.findMany({ where: and(inArray(schema.playbookRuns.accountId, ids), eq(schema.playbookRuns.status, "AKTIV")) });
  const withRun = new Set(activeRuns.map((r) => r.accountId));
  const cutoff = Date.now() - days * 86400000;
  return accounts
    .map((a) => ({ account: a, lastActivity: last.get(a.id) ?? a.createdAt, hasActiveRun: withRun.has(a.id) }))
    .filter((x) => x.account.status === "DORMANT" || x.lastActivity.getTime() < cutoff)
    .sort((x, y) => x.lastActivity.getTime() - y.lastActivity.getTime());
}

/** Kunde bewusst als „ruhend“ markieren bzw. wieder als aktiv führen. */
export async function setAccountDormant(actor: Actor, accountId: string, dormant: boolean) {
  const account = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.workspaceId, actor.workspaceId)) });
  if (!account) throw new NotFoundError("Kunde");
  if (!canReassignResponsibility(actor, account) && !hasRole(actor, "PRINCIPAL", account.id)) throw new ForbiddenError("Den Kundenstatus ändern der zuständige BD, Principal oder CEO.");
  if (account.status === "ARCHIVED") throw new TransitionError("Der Kunde ist archiviert.");
  const status = dormant ? "DORMANT" : "ACTIVE";
  if (account.status === status) return account;
  const [u] = await db.update(schema.accounts).set({ status, updatedAt: new Date() }).where(eq(schema.accounts.id, accountId)).returning();
  await recordAudit(db, actor, dormant ? "account.dormant" : "account.reactivated", "ACCOUNT", accountId);
  return u!;
}
