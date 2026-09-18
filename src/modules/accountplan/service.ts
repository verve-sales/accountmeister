import { and, asc, desc, eq, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { PriorityStatus } from "@/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { hasRole } from "@/modules/identity/actor";
import { canViewSetup, canViewSource, hasRoleForAccountWrite, isResponsibleBd, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { getAccount } from "@/modules/accounts/service";
import { getLastConfirmedVersion } from "@/modules/reviews/service";

/**
 * Accountplan (Briefing 7 / A1): verdichtete Kundenübersicht aus bestätigten Setups, Kundeninformationen
 * und bewusst gesetzten Prioritäten. Kein zweiter Datenbestand – alles wird live aus den Objekten gebaut.
 * Unbestätigte Potenzialzahlen werden nicht als Forecast dargestellt; es gibt hier gar keine Zahlenfelder.
 */

export type AccountPlanView = {
  generatedAt: string;
  account: { id: string; name: string; responsibleBd: string | null };
  setups: { id: string; name: string; status: string; bd: string | null; contextNote: string | null; lastConfirmedWeekly: { title: string; scheduledFor: string; confirmedAt: string; confirmedBy: string } | null }[];
  /** Bestehende Zusammenarbeit: bestätigte Aussagen zu Einsätzen (Erkenntnisstatus „Sachverhalt bestätigt“) */
  engagements: { content: string; setupName: string; confirmedAt: string | null; hasEvidence: boolean }[];
  /** Relevante Veränderungen: offene Hinweise */
  changes: { id: string; setupName: string; observation: string; status: string; owner: string | null; createdAt: string }[];
  /** Belegte Beziehungen und Zugangslücken */
  relationships: { person: string; holder: string; state: string; hasEvidence: boolean }[];
  accessGaps: { target: string; occasion: string; status: string; owner: string; unprovenSteps: number }[];
  /** Priorisierte Vorhaben */
  priorities: { id: string; kind: string; title: string; status: string; rationale: string | null; prerequisites: string | null; goalReference: string | null; deferredReason: string | null; rank: number; version: number; setupName: string | null }[];
  /** Offene Fragen und Risiken: zurückgestellte Hinweise + blockierte Aktionen */
  openQuestions: { text: string; kind: "ZURUECKGESTELLT" | "BLOCKIERT"; setupName: string }[];
  /** Vereinbarte Aktionen und Unterstützung */
  actions: { id: string; title: string; owner: string; status: string; dueDate: string | null; setupName: string }[];
  handovers: { responsibility: string; from: string; to: string; status: string }[];
  decisions: { content: string; decidedOn: string; setupName: string }[];
  goals: { note: string };
  dataQuality: { setupsWithoutConfirmedWeekly: number; hiddenSourcesNote: string | null };
};

export async function canEditAccountPlan(actor: Actor, accountId: string): Promise<boolean> {
  const account = await getAccount(actor, accountId);
  return hasRoleForAccountWrite(actor, account) || isResponsibleBd(actor, account) || hasRole(actor, "PRINCIPAL", account.id);
}

export async function buildAccountPlan(actor: Actor, accountId: string): Promise<AccountPlanView> {
  const account = await getAccount(actor, accountId);
  const users = await db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId) });
  const un = (id: string | null | undefined) => (id ? users.find((u) => u.id === id)?.displayName ?? "?" : null);

  // Nur Setups im Berechtigungsbereich
  const setupRows = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, accountId), orderBy: asc(schema.projectSetups.name) });
  const ctxs: SetupContext[] = [];
  for (const s of setupRows) {
    const ctx = await loadSetupContext(actor, s.id);
    if (ctx && canViewSetup(actor, ctx)) ctxs.push(ctx);
  }
  const setupIds = ctxs.map((c) => c.setup.id);
  const setupName = new Map(ctxs.map((c) => [c.setup.id, c.setup.name]));
  const emptyIds = setupIds.length === 0;

  const [assertions, evidence, signals, actions, handovers, relationships, persons, plans, steps, priorities, decisions, sources] = await Promise.all([
    emptyIds ? [] : db.query.assertions.findMany({ where: and(inArray(schema.assertions.setupId, setupIds), eq(schema.assertions.epistemicStatus, "SACHVERHALT_BESTAETIGT")) }),
    db.query.assertionEvidence.findMany(),
    emptyIds ? [] : db.query.signals.findMany({ where: inArray(schema.signals.setupId, setupIds), orderBy: desc(schema.signals.createdAt) }),
    emptyIds ? [] : db.query.actions.findMany({ where: and(inArray(schema.actions.setupId, setupIds), ne(schema.actions.status, "ERLEDIGT"), ne(schema.actions.status, "VERWORFEN")), orderBy: asc(schema.actions.dueDate) }),
    emptyIds ? [] : db.query.handovers.findMany({ where: and(inArray(schema.handovers.setupId, setupIds), or(eq(schema.handovers.status, "ANGEFRAGT"), eq(schema.handovers.status, "ANGENOMMEN"))) }),
    emptyIds ? [] : db.query.relationships.findMany({ where: inArray(schema.relationships.setupId, setupIds) }),
    db.query.persons.findMany({ where: eq(schema.persons.accountId, accountId) }),
    emptyIds ? [] : db.query.accessPlans.findMany({ where: and(inArray(schema.accessPlans.setupId, setupIds), ne(schema.accessPlans.status, "BEENDET")) }),
    db.query.accessPlanSteps.findMany(),
    db.query.accountPriorities.findMany({ where: eq(schema.accountPriorities.accountId, accountId), orderBy: [asc(schema.accountPriorities.rank), asc(schema.accountPriorities.createdAt)] }),
    emptyIds ? [] : db.query.decisions.findMany({ where: inArray(schema.decisions.setupId, setupIds), orderBy: desc(schema.decisions.decidedOn) }),
    emptyIds ? [] : db.query.sources.findMany({ where: inArray(schema.sources.setupId, setupIds) }),
  ]);
  const pn = new Map(persons.map((p) => [p.id, p.displayName]));
  const evidenceByAssertion = new Map<string, number>();
  for (const e of evidence) evidenceByAssertion.set(e.assertionId, (evidenceByAssertion.get(e.assertionId) ?? 0) + 1);

  const setupsView = [];
  let withoutWeekly = 0;
  for (const c of ctxs) {
    const last = await getLastConfirmedVersion(c.setup.id);
    if (!last) withoutWeekly++;
    setupsView.push({
      id: c.setup.id,
      name: c.setup.name,
      status: c.setup.status,
      bd: un(c.setup.bdUserId),
      contextNote: c.setup.contextNote,
      lastConfirmedWeekly: last ? { title: last.review.title, scheduledFor: last.review.scheduledFor, confirmedAt: last.version.confirmedAt.toISOString(), confirmedBy: un(last.version.confirmedBy) ?? "?" } : null,
    });
  }

  const hiddenSources = sources.filter((s) => !canViewSource(actor, s, ctxs.find((c) => c.setup.id === s.setupId) ?? null)).length;

  return {
    generatedAt: new Date().toISOString(),
    account: { id: account.id, name: account.name, responsibleBd: un(account.responsibleBdUserId) },
    setups: setupsView,
    engagements: assertions
      .filter((a) => a.subjectType === "ASSIGNMENT")
      .map((a) => ({ content: a.content, setupName: setupName.get(a.setupId ?? "") ?? "", confirmedAt: a.confirmedAt?.toISOString() ?? null, hasEvidence: (evidenceByAssertion.get(a.id) ?? 0) > 0 })),
    changes: signals
      .filter((s) => s.status !== "BEENDET" && s.status !== "ZURUECKGESTELLT")
      .map((s) => ({ id: s.id, setupName: setupName.get(s.setupId) ?? "", observation: s.observation, status: s.status, owner: un(s.ownerUserId), createdAt: s.createdAt.toISOString() })),
    relationships: relationships
      .filter((r) => r.state !== "NICHT_AKTIV")
      .map((r) => ({ person: pn.get(r.personId) ?? "?", holder: un(r.holderUserId) ?? "?", state: r.state, hasEvidence: !!r.evidenceSourceId })),
    accessGaps: plans.map((p) => ({
      target: p.targetPersonId ? pn.get(p.targetPersonId) ?? "?" : p.targetFunction ?? "?",
      occasion: p.occasion,
      status: p.status,
      owner: un(p.ownerUserId) ?? "?",
      unprovenSteps: steps.filter((s) => s.accessPlanId === p.id && s.kind !== "BELEGT").length,
    })),
    priorities: priorities.map((p) => ({ id: p.id, kind: p.kind, title: p.title, status: p.status, rationale: p.rationale, prerequisites: p.prerequisites, goalReference: p.goalReference, deferredReason: p.deferredReason, rank: p.rank, version: p.version, setupName: p.setupId ? setupName.get(p.setupId) ?? null : null })),
    openQuestions: [
      ...signals.filter((s) => s.status === "ZURUECKGESTELLT").map((s) => ({ text: `${s.observation}${s.closedReason ? ` – zurückgestellt: ${s.closedReason}` : ""}`, kind: "ZURUECKGESTELLT" as const, setupName: setupName.get(s.setupId) ?? "" })),
      ...actions.filter((a) => a.status === "BLOCKIERT").map((a) => ({ text: `${a.title}${a.result ? ` – blockiert: ${a.result}` : ""}`, kind: "BLOCKIERT" as const, setupName: setupName.get(a.setupId ?? "") ?? "" })),
    ],
    actions: actions.map((a) => ({ id: a.id, title: a.title, owner: un(a.ownerUserId) ?? "?", status: a.status, dueDate: a.dueDate, setupName: setupName.get(a.setupId ?? "") ?? "" })),
    handovers: handovers.map((h) => ({ responsibility: h.responsibility, from: un(h.senderUserId) ?? "?", to: un(h.receiverUserId) ?? "?", status: h.status })),
    decisions: decisions.slice(0, 10).map((d) => ({ content: d.content, decidedOn: d.decidedOn, setupName: setupName.get(d.setupId ?? "") ?? "" })),
    goals: { note: "Vereinbarte Portfolio-/Kundenziele folgen mit dem Zielgespräch (Etappe 4). Zielbezug wird bis dahin als Text an der Priorität geführt." },
    dataQuality: { setupsWithoutConfirmedWeekly: withoutWeekly, hiddenSourcesNote: hiddenSources > 0 ? `${hiddenSources} Quelle(n) außerhalb Ihres Berechtigungsbereichs sind nicht berücksichtigt.` : null },
  };
}

// ---------------------------------------------------------------------------
// Prioritäten (A13): gemeinsame Entscheidung von Principal und BD; nicht aus KI-Schätzung
// ---------------------------------------------------------------------------

export const createPriorityInput = z.object({
  accountId: z.string().min(1),
  setupId: z.string().optional().or(z.literal("")),
  kind: z.enum(schema.priorityKindEnum.enumValues),
  title: z.string().trim().min(3, "Bezeichnung des Vorhabens fehlt").max(300),
  rationale: z.string().trim().max(2000).optional().or(z.literal("")),
  prerequisites: z.string().trim().max(2000).optional().or(z.literal("")),
  goalReference: z.string().trim().max(500).optional().or(z.literal("")),
  rank: z.coerce.number().int().min(1).max(999).default(100),
});

export async function createPriority(actor: Actor, raw: unknown) {
  const parsed = createPriorityInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  if (!(await canEditAccountPlan(actor, input.accountId))) throw new ForbiddenError("Prioritäten pflegen der zuständige BD und der Principal.");
  if (input.setupId) {
    const s = await db.query.projectSetups.findFirst({ where: and(eq(schema.projectSetups.id, input.setupId), eq(schema.projectSetups.accountId, input.accountId)) });
    if (!s) throw new ValidationError("Setup gehört nicht zu diesem Kunden.");
  }
  return db.transaction(async (tx) => {
    const [p] = await tx
      .insert(schema.accountPriorities)
      .values({
        workspaceId: actor.workspaceId,
        accountId: input.accountId,
        setupId: input.setupId || null,
        kind: input.kind,
        title: input.title,
        rationale: input.rationale || null,
        prerequisites: input.prerequisites || null,
        goalReference: input.goalReference || null,
        rank: input.rank,
        createdBy: actor.userId,
      })
      .returning();
    if (!p) throw new Error("Priorität konnte nicht angelegt werden");
    await recordAudit(tx, actor, "priority.created", "ACCOUNT_PRIORITY", p.id, { accountId: input.accountId });
    return p;
  });
}

const priorityTransitions: Record<PriorityStatus, PriorityStatus[]> = {
  VORGESCHLAGEN: ["VEREINBART", "ZURUECKGESTELLT", "VERWORFEN"],
  VEREINBART: ["ZURUECKGESTELLT", "ERREICHT", "VERWORFEN"],
  ZURUECKGESTELLT: ["VEREINBART", "VERWORFEN"],
  ERREICHT: [],
  VERWORFEN: [],
};

export const changePriorityInput = z.object({
  version: z.coerce.number().int().positive(),
  status: z.enum(schema.priorityStatusEnum.enumValues).optional(),
  rank: z.coerce.number().int().min(1).max(999).optional(),
  deferredReason: z.string().trim().max(1000).optional().or(z.literal("")),
});

/** „Vereinbart“ erfordert, dass BD und Principal die Priorität gemeinsam tragen: erst der zweite Bestätiger aus der anderen Rolle setzt den Status. */
export async function changePriority(actor: Actor, priorityId: string, raw: unknown) {
  const parsed = changePriorityInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const p = await db.query.accountPriorities.findFirst({ where: and(eq(schema.accountPriorities.id, priorityId), eq(schema.accountPriorities.workspaceId, actor.workspaceId)) });
  if (!p) throw new NotFoundError("Priorität");
  if (!(await canEditAccountPlan(actor, p.accountId))) throw new ForbiddenError();
  const account = await getAccount(actor, p.accountId);

  let newStatus: PriorityStatus = p.status;
  const agreedBy = [...p.agreedByUserIds];
  if (input.status && input.status !== p.status) {
    if (!priorityTransitions[p.status].includes(input.status)) throw new TransitionError(`Übergang von „${p.status}“ nach „${input.status}“ ist nicht vorgesehen.`);
    if (input.status === "ZURUECKGESTELLT" && !input.deferredReason) throw new ValidationError("Bitte begründen, warum das Vorhaben bewusst zurückgestellt wird.");
    if (input.status === "VEREINBART") {
      if (!agreedBy.includes(actor.userId)) agreedBy.push(actor.userId);
      const roles = await rolesOfAgreeing(agreedBy, account.id, account.responsibleBdUserId);
      if (!(roles.has("BD") && roles.has("PRINCIPAL"))) {
        // Zustimmung gespeichert, Status bleibt bis zur zweiten Rolle unverändert
        newStatus = p.status;
      } else newStatus = "VEREINBART";
    } else newStatus = input.status;
  }
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.accountPriorities)
      .set({
        status: newStatus,
        agreedByUserIds: agreedBy,
        rank: input.rank ?? p.rank,
        deferredReason: input.status === "ZURUECKGESTELLT" ? input.deferredReason || null : p.deferredReason,
        version: input.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.accountPriorities.id, priorityId), eq(schema.accountPriorities.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    await recordAudit(tx, actor, "priority.changed", "ACCOUNT_PRIORITY", priorityId, { von: p.status, nach: newStatus, zustimmungen: agreedBy.length });
    return { priority: updated, pendingAgreement: input.status === "VEREINBART" && newStatus !== "VEREINBART" };
  });
}

async function rolesOfAgreeing(userIds: string[], accountId: string, responsibleBdUserId: string | null): Promise<Set<"BD" | "PRINCIPAL">> {
  const roles = new Set<"BD" | "PRINCIPAL">();
  if (userIds.length === 0) return roles;
  const assignments = await db.query.roleAssignments.findMany({ where: inArray(schema.roleAssignments.userId, userIds) });
  for (const a of assignments) {
    if (a.role === "PRINCIPAL" && (a.scope === "WORKSPACE" || a.accountId === accountId)) roles.add("PRINCIPAL");
    if (a.role === "BD" && (a.userId === responsibleBdUserId || a.accountId === accountId)) roles.add("BD");
  }
  return roles;
}

// ---------------------------------------------------------------------------
// Gespeicherter Review-Stand
// ---------------------------------------------------------------------------

export const saveSnapshotInput = z.object({ accountId: z.string().min(1), title: z.string().trim().min(3).max(200), note: z.string().trim().max(4000).optional().or(z.literal("")) });

export async function saveAccountPlanSnapshot(actor: Actor, raw: unknown) {
  const parsed = saveSnapshotInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  if (!(await canEditAccountPlan(actor, input.accountId))) throw new ForbiddenError("Stände speichern der zuständige BD und der Principal.");
  const content = await buildAccountPlan(actor, input.accountId);
  return db.transaction(async (tx) => {
    const [snap] = await tx
      .insert(schema.accountPlanSnapshots)
      .values({ workspaceId: actor.workspaceId, accountId: input.accountId, title: input.title, content, note: input.note || null, confirmedBy: actor.userId })
      .returning();
    if (!snap) throw new Error("Stand konnte nicht gespeichert werden");
    await recordAudit(tx, actor, "accountplan.snapshot_saved", "ACCOUNT_PLAN_SNAPSHOT", snap.id, { accountId: input.accountId });
    return snap;
  });
}

export async function listAccountPlanSnapshots(actor: Actor, accountId: string) {
  await getAccount(actor, accountId);
  const rows = await db.query.accountPlanSnapshots.findMany({ where: eq(schema.accountPlanSnapshots.accountId, accountId), orderBy: desc(schema.accountPlanSnapshots.confirmedAt) });
  const users = await db.query.users.findMany({ where: inArray(schema.users.id, rows.length ? [...new Set(rows.map((r) => r.confirmedBy))] : ["-"]) });
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  return rows.map((r) => ({ ...r, confirmedByName: un.get(r.confirmedBy) ?? "?" }));
}

export async function getAccountPlanSnapshot(actor: Actor, snapshotId: string) {
  const snap = await db.query.accountPlanSnapshots.findFirst({ where: and(eq(schema.accountPlanSnapshots.id, snapshotId), eq(schema.accountPlanSnapshots.workspaceId, actor.workspaceId)) });
  if (!snap) throw new NotFoundError("Gespeicherter Stand");
  await getAccount(actor, snap.accountId); // Berechtigung
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, snap.confirmedBy) });
  return { ...snap, content: snap.content as AccountPlanView, confirmedByName: user?.displayName ?? "?" };
}
