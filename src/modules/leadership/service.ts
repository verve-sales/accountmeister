import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { GoalStatus, SupportRequestStatus } from "@/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewAccount, canViewSetup, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { listVisibleAccounts } from "@/modules/accounts/service";
import { buildAccountPlan, type AccountPlanView } from "@/modules/accountplan/service";

/**
 * Führungsebenen (Briefing 3, 10.2, 11.2–11.4, 4.3):
 *  - Unterstützungsaufträge: begrenzt, konkret; Fallverantwortung bleibt beim BD (F13).
 *  - Principal-/BD-Weekly und CEO-/Principal-Zielgespräch: Reviews ohne Setup-Bezug, Zugriff über Teilnehmerkreis.
 *  - Portfolio: dieselbe Datenbasis wie der operative Fall (Accountpläne), keine Doppelpflege, keine Rohquellen.
 *  - Ziele: versioniert; keine erfundenen Zielwerte, keine automatischen Quoten (F12).
 *  - Vertrauliche Notizen: expliziter Empfängerkreis, nie in Setup-, Accountplan- oder KI-Zusammenfassungen (S04).
 */

// ---------------------------------------------------------------------------
// Unterstützungsaufträge (10.2)
// ---------------------------------------------------------------------------

export const createSupportRequestInput = z.object({
  addresseeUserId: z.string().min(1, "Adressat fehlt"),
  setupId: z.string().optional().or(z.literal("")),
  reviewId: z.string().optional().or(z.literal("")),
  task: z.string().trim().min(10, "Bitte den Unterstützungsauftrag konkret benennen (mindestens 10 Zeichen).").max(1000),
  context: z.string().trim().max(2000).optional().or(z.literal("")),
  dueDate: z.string().optional().or(z.literal("")),
});

export async function createSupportRequest(actor: Actor, raw: unknown) {
  const parsed = createSupportRequestInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  if (input.addresseeUserId === actor.userId) throw new ValidationError("Ein Unterstützungsauftrag an sich selbst ist nicht vorgesehen.");
  // Keine pauschale Eskalation: Auftrag ist konkret (Mindestlänge) und hat genau einen Adressaten mit Führungsrolle
  const addressee = await db.query.users.findFirst({ where: and(eq(schema.users.id, input.addresseeUserId), eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")) });
  if (!addressee) throw new ValidationError("Adressat nicht gefunden.");
  const roles = await db.query.roleAssignments.findMany({ where: eq(schema.roleAssignments.userId, addressee.id) });
  if (!roles.some((r) => r.role === "PRINCIPAL" || r.role === "CEO")) throw new ValidationError("Unterstützungsaufträge richten sich an Principal oder CEO.");
  let ctx: SetupContext | null = null;
  if (input.setupId) {
    ctx = await loadSetupContext(actor, input.setupId);
    if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
    if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Nur Bearbeitende des Setups fragen Unterstützung an.");
  }
  return db.transaction(async (tx) => {
    const [r] = await tx
      .insert(schema.supportRequests)
      .values({
        workspaceId: actor.workspaceId,
        requesterUserId: actor.userId,
        addresseeUserId: input.addresseeUserId,
        setupId: ctx?.setup.id ?? null,
        accountId: ctx?.account.id ?? null,
        reviewId: input.reviewId || null,
        task: input.task,
        context: input.context || null,
        dueDate: input.dueDate || null,
      })
      .returning();
    if (!r) throw new Error("Unterstützungsauftrag konnte nicht angelegt werden");
    await recordAudit(tx, actor, "support.requested", "SUPPORT_REQUEST", r.id, { addressee: input.addresseeUserId, setupId: ctx?.setup.id ?? null });
    return r;
  });
}

const supportTransitions: Record<SupportRequestStatus, SupportRequestStatus[]> = {
  ANGEFRAGT: ["ANGENOMMEN", "ZURUECKGEGEBEN", "ZURUECKGEZOGEN"],
  ANGENOMMEN: ["ERLEDIGT", "ZURUECKGEGEBEN"],
  ZURUECKGEGEBEN: ["ANGEFRAGT", "ZURUECKGEZOGEN"],
  ERLEDIGT: [],
  ZURUECKGEZOGEN: [],
};

export const respondSupportInput = z.object({
  version: z.coerce.number().int().positive(),
  decision: z.enum(["ANNEHMEN", "ZURUECKGEBEN", "ERLEDIGEN", "ZURUECKZIEHEN"]),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

/** Adressat nimmt an / gibt zurück / meldet Ergebnis; Antragsteller zieht zurück. Übernommene Hilfe ohne Ergebnis bleibt sichtbar. */
export async function respondToSupportRequest(actor: Actor, id: string, raw: unknown) {
  const parsed = respondSupportInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const r = await db.query.supportRequests.findFirst({ where: and(eq(schema.supportRequests.id, id), eq(schema.supportRequests.workspaceId, actor.workspaceId)) });
  if (!r || (r.requesterUserId !== actor.userId && r.addresseeUserId !== actor.userId)) throw new NotFoundError("Unterstützungsauftrag");
  const map = { ANNEHMEN: "ANGENOMMEN", ZURUECKGEBEN: "ZURUECKGEGEBEN", ERLEDIGEN: "ERLEDIGT", ZURUECKZIEHEN: "ZURUECKGEZOGEN" } as const;
  const target = map[input.decision];
  if (input.decision === "ZURUECKZIEHEN" && r.requesterUserId !== actor.userId) throw new ForbiddenError("Nur der Antragsteller zieht zurück.");
  if (input.decision !== "ZURUECKZIEHEN" && r.addresseeUserId !== actor.userId) throw new ForbiddenError("Nur der Adressat nimmt an, gibt zurück oder meldet das Ergebnis.");
  if (!supportTransitions[r.status].includes(target)) throw new TransitionError(`Übergang von „${r.status}“ nach „${target}“ ist nicht vorgesehen.`);
  if ((input.decision === "ERLEDIGEN" || input.decision === "ZURUECKGEBEN") && !input.note) throw new ValidationError(input.decision === "ERLEDIGEN" ? "Bitte das Ergebnis der Unterstützung festhalten." : "Bitte die Rückgabe begründen.");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.supportRequests)
      .set({ status: target, responseNote: input.decision === "ERLEDIGEN" ? r.responseNote : input.note || r.responseNote, result: input.decision === "ERLEDIGEN" ? input.note : r.result, respondedAt: new Date(), version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.supportRequests.id, id), eq(schema.supportRequests.version, input.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, `support.${target.toLowerCase()}`, "SUPPORT_REQUEST", id);
    return u;
  });
}

export async function listMySupportRequests(actor: Actor) {
  const rows = await db.query.supportRequests.findMany({
    where: and(eq(schema.supportRequests.workspaceId, actor.workspaceId), or(eq(schema.supportRequests.requesterUserId, actor.userId), eq(schema.supportRequests.addresseeUserId, actor.userId))),
    orderBy: desc(schema.supportRequests.createdAt),
  });
  return decorate(actor, rows);
}

export async function listSupportRequestsForSetup(actor: Actor, setupId: string) {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  const rows = await db.query.supportRequests.findMany({ where: eq(schema.supportRequests.setupId, setupId), orderBy: desc(schema.supportRequests.createdAt) });
  return decorate(actor, rows);
}

async function decorate(actor: Actor, rows: (typeof schema.supportRequests.$inferSelect)[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.requesterUserId, r.addresseeUserId]))];
  const users = ids.length ? await db.query.users.findMany({ where: inArray(schema.users.id, ids) }) : [];
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const setupIds = [...new Set(rows.map((r) => r.setupId).filter((x): x is string => !!x))];
  const setups = setupIds.length ? await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.id, setupIds) }) : [];
  const sn = new Map(setups.map((s) => [s.id, s.name]));
  return rows.map((r) => ({ ...r, requesterName: un.get(r.requesterUserId) ?? "?", addresseeName: un.get(r.addresseeUserId) ?? "?", setupName: r.setupId ? sn.get(r.setupId) ?? "" : "", isAddressee: r.addresseeUserId === actor.userId, isRequester: r.requesterUserId === actor.userId }));
}

// ---------------------------------------------------------------------------
// Portfolio (11.2, 4.3) – dieselbe Datenbasis wie Accountpläne, gefiltert nach Berechtigung
// ---------------------------------------------------------------------------

export type PortfolioEntry = {
  accountId: string;
  accountName: string;
  responsibleBd: string | null;
  setups: number;
  setupsWithoutWeekly: number;
  openChanges: number;
  openQuestions: number;
  accessGaps: number;
  unprovenRelationships: number;
  agreedPriorities: number;
  proposedPriorities: number;
  openActions: number;
  blockedActions: number;
  openSupport: number;
  lastConfirmedWeekly: string | null;
};

/** Portfolioübersicht: Kennzahlen sind Zählungen dokumentierter Objekte – keine Umsatz- oder Potenzialwerte. */
export async function buildPortfolio(actor: Actor): Promise<{ entries: PortfolioEntry[]; note: string }> {
  if (!hasRole(actor, "PRINCIPAL") && !hasRole(actor, "CEO") && actor.accountRoles.size === 0) throw new ForbiddenError("Die Portfolioübersicht steht Principal und CEO zur Verfügung.");
  const accounts = await listVisibleAccounts(actor);
  const support = await db.query.supportRequests.findMany({ where: and(eq(schema.supportRequests.workspaceId, actor.workspaceId), or(eq(schema.supportRequests.status, "ANGEFRAGT"), eq(schema.supportRequests.status, "ANGENOMMEN"))) });
  const entries: PortfolioEntry[] = [];
  for (const a of accounts) {
    if (!canViewAccount(actor, a)) continue;
    let plan: AccountPlanView;
    try {
      plan = await buildAccountPlan(actor, a.id);
    } catch {
      continue;
    }
    const latestWeekly = plan.setups.map((s) => s.lastConfirmedWeekly?.confirmedAt ?? null).filter((x): x is string => !!x).sort().pop() ?? null;
    entries.push({
      accountId: a.id,
      accountName: a.name,
      responsibleBd: plan.account.responsibleBd,
      setups: plan.setups.length,
      setupsWithoutWeekly: plan.dataQuality.setupsWithoutConfirmedWeekly,
      openChanges: plan.changes.length,
      openQuestions: plan.openQuestions.length,
      accessGaps: plan.accessGaps.length,
      unprovenRelationships: plan.relationships.filter((r) => !r.hasEvidence).length,
      agreedPriorities: plan.priorities.filter((p) => p.status === "VEREINBART").length,
      proposedPriorities: plan.priorities.filter((p) => p.status === "VORGESCHLAGEN").length,
      openActions: plan.actions.length,
      blockedActions: plan.actions.filter((x) => x.status === "BLOCKIERT").length,
      openSupport: support.filter((s) => s.accountId === a.id).length,
      lastConfirmedWeekly: latestWeekly,
    });
  }
  entries.sort((x, y) => y.openChanges + y.blockedActions + y.openSupport - (x.openChanges + x.blockedActions + x.openSupport));
  return { entries, note: "Zählungen dokumentierter Objekte aus den Accountplänen. Keine Umsatz-, Forecast- oder Potenzialwerte (Briefing 7, 11.3). Rohquellen sind hier nicht enthalten." };
}

// ---------------------------------------------------------------------------
// Führungs-Reviews (Principal/BD-Weekly, CEO/Principal-Zielgespräch) – ohne Setup, Zugriff über Teilnehmerkreis
// ---------------------------------------------------------------------------

export const createLeadershipReviewInput = z.object({
  type: z.enum(["PRINCIPAL_BD_WEEKLY", "CEO_PRINCIPAL_ZIELGESPRAECH"]),
  title: z.string().trim().max(200).optional().or(z.literal("")),
  scheduledFor: z.string().min(10, "Termin fehlt"),
  participantIds: z.array(z.string()).min(1, "Mindestens eine weitere Person"),
});

export async function createLeadershipReview(actor: Actor, raw: unknown) {
  const data = raw as Record<string, unknown>;
  const participantIds = Array.isArray(data.participantIds) ? data.participantIds : typeof data.participantIds === "string" ? [data.participantIds] : [];
  const parsed = createLeadershipReviewInput.safeParse({ ...data, participantIds });
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const isLeader = hasRole(actor, "PRINCIPAL") || hasRole(actor, "CEO");
  const isBd = hasRole(actor, "BD") || actor.accountRoles.size > 0;
  if (input.type === "PRINCIPAL_BD_WEEKLY" && !isLeader && !isBd) throw new ForbiddenError();
  if (input.type === "CEO_PRINCIPAL_ZIELGESPRAECH" && !isLeader) throw new ForbiddenError("Zielgespräche legen CEO oder Principal an.");
  const participants = [...new Set([...input.participantIds.filter(Boolean), actor.userId])];
  return db.transaction(async (tx) => {
    const [r] = await tx
      .insert(schema.reviews)
      .values({ workspaceId: actor.workspaceId, type: input.type, setupId: null, accountId: null, title: input.title || (input.type === "PRINCIPAL_BD_WEEKLY" ? `Principal-/BD-Weekly ${input.scheduledFor}` : `Zielgespräch ${input.scheduledFor}`), scheduledFor: input.scheduledFor, createdBy: actor.userId })
      .returning();
    if (!r) throw new Error("Review konnte nicht angelegt werden");
    await tx.insert(schema.reviewParticipants).values(participants.map((userId) => ({ reviewId: r.id, userId })));
    await recordAudit(tx, actor, "review.created", "REVIEW", r.id, { type: input.type });
    return r;
  });
}

export async function requireLeadershipReview(actor: Actor, reviewId: string) {
  const review = await db.query.reviews.findFirst({ where: and(eq(schema.reviews.id, reviewId), eq(schema.reviews.workspaceId, actor.workspaceId)) });
  if (!review || review.setupId) throw new NotFoundError("Review");
  const participants = await db.query.reviewParticipants.findMany({ where: eq(schema.reviewParticipants.reviewId, reviewId) });
  const isParticipant = participants.some((p) => p.userId === actor.userId);
  // Nur Teilnehmende sehen Führungs-Reviews – kein Zugriff über Titel (S02/S04)
  if (!isParticipant) throw new NotFoundError("Review");
  return { review, participants };
}

/** Vorbereitung eines Führungs-Reviews: Portfolio, offene Unterstützung, vereinbarte Ziele, Entscheidungen des letzten Standes. */
export async function prepareLeadershipReview(actor: Actor, reviewId: string) {
  const { review, participants } = await requireLeadershipReview(actor, reviewId);
  const users = await db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId) });
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const [versions, decisions, confidential, support] = await Promise.all([
    db.query.reviewVersions.findMany({ where: eq(schema.reviewVersions.reviewId, reviewId), orderBy: desc(schema.reviewVersions.versionNo) }),
    db.query.decisions.findMany({ where: eq(schema.decisions.reviewId, reviewId), orderBy: desc(schema.decisions.createdAt) }),
    db.query.confidentialNotes.findMany({ where: eq(schema.confidentialNotes.reviewId, reviewId), orderBy: desc(schema.confidentialNotes.createdAt) }),
    listMySupportRequests(actor),
  ]);
  let portfolio: Awaited<ReturnType<typeof buildPortfolio>> | null = null;
  try {
    portfolio = await buildPortfolio(actor);
  } catch {
    portfolio = null;
  }
  const goals = await listGoals(actor);
  // Letztes bestätigtes Review desselben Typs (ohne dieses) als Bezug
  const prior = await db.query.reviews.findMany({ where: and(eq(schema.reviews.type, review.type), eq(schema.reviews.status, "BESTAETIGT"), ne(schema.reviews.id, review.id)), orderBy: desc(schema.reviews.scheduledFor) });
  let last: { title: string; scheduledFor: string; note: string | null; confirmedBy: string; decisions: string[] } | null = null;
  for (const p of prior) {
    const ps = await db.query.reviewParticipants.findMany({ where: eq(schema.reviewParticipants.reviewId, p.id) });
    if (!ps.some((x) => x.userId === actor.userId) || !p.confirmedVersionId) continue;
    const v = await db.query.reviewVersions.findFirst({ where: eq(schema.reviewVersions.id, p.confirmedVersionId) });
    if (!v) continue;
    const d = await db.query.decisions.findMany({ where: eq(schema.decisions.reviewId, p.id) });
    last = { title: p.title, scheduledFor: p.scheduledFor, note: v.note, confirmedBy: un.get(v.confirmedBy) ?? "?", decisions: d.map((x) => x.content) };
    break;
  }
  return {
    review,
    participants: participants.map((p) => ({ userId: p.userId, name: un.get(p.userId) ?? "?" })),
    versions,
    decisions,
    // Vertrauliche Notizen nur für Personen im Empfängerkreis (S04)
    confidential: confidential.filter((n) => n.audienceUserIds.includes(actor.userId)),
    support: support.filter((s) => s.status === "ANGEFRAGT" || s.status === "ANGENOMMEN"),
    portfolio,
    goals,
    last,
    userNames: un,
  };
}

/** Notiz-Entwurf, Entscheidung, Bestätigung, Korrektur: gleiche Semantik wie beim BD-/Anker-Weekly, Zugriff über Teilnehmer. */
export async function saveLeadershipDraft(actor: Actor, reviewId: string, raw: { version: number; noteDraft: string }) {
  const { review } = await requireLeadershipReview(actor, reviewId);
  if (review.status === "BESTAETIGT") throw new TransitionError("Ein bestätigtes Review wird über eine Korrekturversion geändert.");
  const [u] = await db
    .update(schema.reviews)
    .set({ noteDraft: raw.noteDraft, status: "LAUFEND", version: Number(raw.version) + 1, updatedAt: new Date() })
    .where(and(eq(schema.reviews.id, reviewId), eq(schema.reviews.version, Number(raw.version))))
    .returning();
  if (!u) throw new ConflictError();
  return u;
}

export async function addLeadershipDecision(actor: Actor, raw: { reviewId: string; content: string; scope?: string; rationale?: string }) {
  const { review, participants } = await requireLeadershipReview(actor, raw.reviewId);
  if (review.status === "BESTAETIGT") throw new TransitionError("Ein bestätigtes Review wird über eine Korrekturversion geändert.");
  if (!raw.content || raw.content.trim().length < 5) throw new ValidationError("Entscheidung fehlt.");
  const [d] = await db
    .insert(schema.decisions)
    .values({ workspaceId: actor.workspaceId, setupId: null, reviewId: review.id, content: raw.content.trim(), scope: raw.scope?.trim() || null, rationale: raw.rationale?.trim() || null, decidedByUserIds: participants.map((p) => p.userId), decidedOn: review.scheduledFor, createdBy: actor.userId })
    .returning();
  if (review.status === "GEPLANT") await db.update(schema.reviews).set({ status: "LAUFEND" }).where(eq(schema.reviews.id, review.id));
  return d;
}

export async function confirmLeadershipReview(actor: Actor, reviewId: string, raw: { version: number }) {
  const { review } = await requireLeadershipReview(actor, reviewId);
  if (review.status === "BESTAETIGT") throw new TransitionError("Bereits bestätigt.");
  if (review.status === "GEPLANT") throw new TransitionError("Bitte zuerst die Notiz erfassen.");
  return db.transaction(async (tx) => {
    const decisions = await tx.query.decisions.findMany({ where: eq(schema.decisions.reviewId, reviewId) });
    const support = await tx.query.supportRequests.findMany({ where: eq(schema.supportRequests.reviewId, reviewId) });
    const goalsAgreed = await tx.query.goals.findMany({ where: and(eq(schema.goals.workspaceId, actor.workspaceId), eq(schema.goals.status, "VEREINBART")) });
    const [v] = await tx
      .insert(schema.reviewVersions)
      .values({ reviewId, versionNo: 1, note: review.noteDraft, snapshot: { decisionIds: decisions.map((d) => d.id), supportRequestIds: support.map((s) => s.id), agreedGoalIds: goalsAgreed.map((g) => g.id), openSignalCount: 0, openActionCount: 0, openHandoverCount: 0, signalIds: [], actionIds: [], contextNote: null, since: null }, confirmedBy: actor.userId })
      .returning();
    if (!v) throw new Error("Version");
    const [u] = await tx
      .update(schema.reviews)
      .set({ status: "BESTAETIGT", confirmedVersionId: v.id, version: Number(raw.version) + 1, updatedAt: new Date() })
      .where(and(eq(schema.reviews.id, reviewId), eq(schema.reviews.version, Number(raw.version)), ne(schema.reviews.status, "BESTAETIGT")))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "review.confirmed", "REVIEW", reviewId, { type: review.type });
    return { review: u, version: v };
  });
}

/** Vertrauliche Notiz (11.4): nur für den expliziten Empfängerkreis; nie in Setup/Accountplan/KI-Kontext. */
export const addConfidentialNoteInput = z.object({
  reviewId: z.string().min(1),
  body: z.string().trim().min(3).max(8000),
  aboutUserId: z.string().optional().or(z.literal("")),
  audienceUserIds: z.array(z.string()).optional(),
});

export async function addConfidentialNote(actor: Actor, raw: unknown) {
  const data = raw as Record<string, unknown>;
  const audienceUserIds = Array.isArray(data.audienceUserIds) ? data.audienceUserIds : typeof data.audienceUserIds === "string" ? [data.audienceUserIds] : undefined;
  const parsed = addConfidentialNoteInput.safeParse({ ...data, audienceUserIds });
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { review, participants } = await requireLeadershipReview(actor, input.reviewId);
  if (!hasRole(actor, "PRINCIPAL") && !hasRole(actor, "CEO")) throw new ForbiddenError("Vertrauliche Führungsnotizen schreiben Principal oder CEO.");
  // Empfängerkreis: Teilmenge der Teilnehmenden, Verfasser immer enthalten; betroffene Person ist standardmäßig NICHT enthalten
  const participantIds = new Set(participants.map((p) => p.userId));
  const audience = [...new Set([actor.userId, ...(input.audienceUserIds ?? []).filter((id) => participantIds.has(id))])];
  const [n] = await db
    .insert(schema.confidentialNotes)
    .values({ workspaceId: actor.workspaceId, reviewId: review.id, setupId: null, aboutUserId: input.aboutUserId || null, body: input.body, audienceUserIds: audience, createdBy: actor.userId })
    .returning();
  await recordAudit(db, actor, "confidential_note.created", "REVIEW", review.id, { audience: audience.length }); // kein Inhalt im Audit
  return n;
}

// ---------------------------------------------------------------------------
// Ziele (11.3)
// ---------------------------------------------------------------------------

export const goalInput = z.object({
  title: z.string().trim().min(3, "Titel fehlt").max(200),
  ownerUserId: z.string().min(1, "Verantwortliche Person fehlt"),
  accountId: z.string().optional().or(z.literal("")),
  desiredOutcome: z.string().trim().min(5, "Gewünschtes Ergebnis fehlt").max(2000),
  scope: z.string().trim().max(500).optional().or(z.literal("")),
  periodFrom: z.string().optional().or(z.literal("")),
  periodTo: z.string().optional().or(z.literal("")),
  successCriterion: z.string().trim().max(1000).optional().or(z.literal("")),
  baseline: z.string().trim().max(1000).optional().or(z.literal("")),
  baselineSourceId: z.string().optional().or(z.literal("")),
  targetValue: z.string().trim().max(200).optional().or(z.literal("")),
  supportNeeded: z.string().trim().max(1000).optional().or(z.literal("")),
  prerequisites: z.string().trim().max(1000).optional().or(z.literal("")),
  changeNote: z.string().trim().max(1000).optional().or(z.literal("")),
});

function assertLeader(actor: Actor) {
  if (!hasRole(actor, "PRINCIPAL") && !hasRole(actor, "CEO")) throw new ForbiddenError("Ziele vereinbaren CEO und Principal.");
}

/** Ziel anlegen (Entwurf, Version 1). Ein Zielwert ohne Ausgangslage mit Quelle wird nicht akzeptiert. */
export async function createGoal(actor: Actor, raw: unknown) {
  assertLeader(actor);
  const parsed = goalInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  validateTarget(input);
  return db.transaction(async (tx) => {
    const [g] = await tx.insert(schema.goals).values({ workspaceId: actor.workspaceId, title: input.title, ownerUserId: input.ownerUserId, accountId: input.accountId || null, createdBy: actor.userId }).returning();
    if (!g) throw new Error("Ziel");
    const [v] = await tx.insert(schema.goalVersions).values({ goalId: g.id, versionNo: 1, ...versionFields(input), createdBy: actor.userId }).returning();
    await tx.update(schema.goals).set({ currentVersionId: v?.id ?? null }).where(eq(schema.goals.id, g.id));
    await recordAudit(tx, actor, "goal.created", "GOAL", g.id);
    return { ...g, currentVersionId: v?.id ?? null };
  });
}

function validateTarget(input: z.infer<typeof goalInput>) {
  if (input.targetValue && !input.baseline) throw new ValidationError("Ein Zielwert braucht eine dokumentierte Ausgangslage (oder ausdrücklich „unbekannt“).");
  if (input.targetValue && !input.successCriterion) throw new ValidationError("Ein Zielwert braucht ein beobachtbares Erfolgskriterium.");
}

function versionFields(input: z.infer<typeof goalInput>) {
  return {
    desiredOutcome: input.desiredOutcome,
    scope: input.scope || null,
    periodFrom: input.periodFrom || null,
    periodTo: input.periodTo || null,
    successCriterion: input.successCriterion || null,
    baseline: input.baseline || null,
    baselineSourceId: input.baselineSourceId || null,
    targetValue: input.targetValue || null,
    supportNeeded: input.supportNeeded || null,
    prerequisites: input.prerequisites || null,
    changeNote: input.changeNote || null,
  };
}

/** Neue Version eines Ziels (Änderungshistorie). Ein vereinbartes Ziel wird dadurch „geändert“ und braucht erneute Vereinbarung. */
export async function updateGoal(actor: Actor, goalId: string, raw: unknown) {
  assertLeader(actor);
  const parsed = goalInput.extend({ version: z.coerce.number().int().positive() }).safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  validateTarget(input);
  const g = await db.query.goals.findFirst({ where: and(eq(schema.goals.id, goalId), eq(schema.goals.workspaceId, actor.workspaceId)) });
  if (!g) throw new NotFoundError("Ziel");
  if (g.status === "BEENDET") throw new TransitionError("Beendete Ziele werden nicht mehr geändert.");
  if (g.status !== "ENTWURF" && !input.changeNote) throw new ValidationError("Bitte den Grund der Änderung angeben.");
  return db.transaction(async (tx) => {
    const versions = await tx.query.goalVersions.findMany({ where: eq(schema.goalVersions.goalId, goalId), orderBy: desc(schema.goalVersions.versionNo) });
    const [v] = await tx.insert(schema.goalVersions).values({ goalId, versionNo: (versions[0]?.versionNo ?? 0) + 1, ...versionFields(input), createdBy: actor.userId }).returning();
    const newStatus: GoalStatus = g.status === "ENTWURF" ? "ENTWURF" : "GEAENDERT";
    const [u] = await tx
      .update(schema.goals)
      .set({ title: input.title, ownerUserId: input.ownerUserId, accountId: input.accountId || g.accountId, currentVersionId: v?.id ?? null, status: newStatus, agreedByUserIds: newStatus === "GEAENDERT" ? [] : g.agreedByUserIds, version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.goals.id, goalId), eq(schema.goals.version, input.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "goal.version_added", "GOAL", goalId, { versionNo: v?.versionNo });
    return u;
  });
}

const goalTransitions: Record<GoalStatus, GoalStatus[]> = {
  ENTWURF: ["ZUR_ABSTIMMUNG", "VEREINBART", "BEENDET"],
  ZUR_ABSTIMMUNG: ["VEREINBART", "ENTWURF", "BEENDET"],
  VEREINBART: ["GEAENDERT", "BEENDET"],
  GEAENDERT: ["ZUR_ABSTIMMUNG", "VEREINBART", "BEENDET"],
  BEENDET: [],
};

/** Statuswechsel. „Vereinbart“ setzt Zustimmung beider Rollen (CEO und Principal) voraus; die erste Zustimmung wird gespeichert. */
export async function changeGoalStatus(actor: Actor, goalId: string, raw: { version: number; status: GoalStatus }) {
  assertLeader(actor);
  const g = await db.query.goals.findFirst({ where: and(eq(schema.goals.id, goalId), eq(schema.goals.workspaceId, actor.workspaceId)) });
  if (!g) throw new NotFoundError("Ziel");
  if (!goalTransitions[g.status].includes(raw.status)) throw new TransitionError(`Übergang von „${g.status}“ nach „${raw.status}“ ist nicht vorgesehen.`);
  let agreed = [...g.agreedByUserIds];
  let target: GoalStatus = raw.status;
  let pending = false;
  if (raw.status === "VEREINBART") {
    if (!agreed.includes(actor.userId)) agreed.push(actor.userId);
    const roles = await db.query.roleAssignments.findMany({ where: inArray(schema.roleAssignments.userId, agreed) });
    const hasCeo = roles.some((r) => r.role === "CEO");
    const hasPrincipal = roles.some((r) => r.role === "PRINCIPAL");
    if (!(hasCeo && hasPrincipal)) {
      target = g.status === "ENTWURF" ? "ZUR_ABSTIMMUNG" : g.status;
      pending = true;
    }
  } else if (raw.status === "ENTWURF" || raw.status === "GEAENDERT") agreed = [];
  const [u] = await db
    .update(schema.goals)
    .set({ status: target, agreedByUserIds: agreed, version: Number(raw.version) + 1, updatedAt: new Date() })
    .where(and(eq(schema.goals.id, goalId), eq(schema.goals.version, Number(raw.version))))
    .returning();
  if (!u) throw new ConflictError();
  await recordAudit(db, actor, "goal.status_changed", "GOAL", goalId, { von: g.status, nach: target, zustimmungen: agreed.length });
  return { goal: u, pendingAgreement: pending };
}

export const contributionInput = z.object({
  goalId: z.string().min(1),
  accountId: z.string().optional().or(z.literal("")),
  setupId: z.string().optional().or(z.literal("")),
  priorityId: z.string().optional().or(z.literal("")),
  expectedContribution: z.string().trim().max(1000).optional().or(z.literal("")),
  evidencedContribution: z.string().trim().max(1000).optional().or(z.literal("")),
  evidenceSourceId: z.string().optional().or(z.literal("")),
});

/** Zielbeitrag: erwartet und belegt getrennt; ein belegter Beitrag braucht eine Quelle. */
export async function addGoalContribution(actor: Actor, raw: unknown) {
  const parsed = contributionInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const g = await db.query.goals.findFirst({ where: and(eq(schema.goals.id, input.goalId), eq(schema.goals.workspaceId, actor.workspaceId)) });
  if (!g) throw new NotFoundError("Ziel");
  const isLeader = hasRole(actor, "PRINCIPAL") || hasRole(actor, "CEO");
  if (!isLeader) {
    // BD darf Beiträge für eigene Setups melden
    if (!input.setupId) throw new ForbiddenError();
    const ctx = await loadSetupContext(actor, input.setupId);
    if (!ctx || !canEditSetup(actor, ctx)) throw new ForbiddenError();
  }
  if (input.evidencedContribution && !input.evidenceSourceId) throw new ValidationError("Ein belegter Beitrag braucht eine Quelle.");
  if (!input.expectedContribution && !input.evidencedContribution) throw new ValidationError("Bitte erwarteten oder belegten Beitrag angeben.");
  const [c] = await db
    .insert(schema.goalContributions)
    .values({ goalId: g.id, accountId: input.accountId || null, setupId: input.setupId || null, priorityId: input.priorityId || null, expectedContribution: input.expectedContribution || null, evidencedContribution: input.evidencedContribution || null, evidenceSourceId: input.evidenceSourceId || null, createdBy: actor.userId })
    .returning();
  await recordAudit(db, actor, "goal.contribution_added", "GOAL", g.id);
  return c;
}

/** Ziele sichtbar für CEO/Principal (alle) und für BD/Anker nur, wenn sie über Beiträge/Kunden beteiligt sind. */
export async function listGoals(actor: Actor) {
  const all = await db.query.goals.findMany({ where: eq(schema.goals.workspaceId, actor.workspaceId), orderBy: desc(schema.goals.updatedAt) });
  const isLeader = hasRole(actor, "PRINCIPAL") || hasRole(actor, "CEO");
  const goalIds = all.map((g) => g.id);
  const [versions, contributions, users] = await Promise.all([
    goalIds.length ? db.query.goalVersions.findMany({ where: inArray(schema.goalVersions.goalId, goalIds), orderBy: desc(schema.goalVersions.versionNo) }) : [],
    goalIds.length ? db.query.goalContributions.findMany({ where: inArray(schema.goalContributions.goalId, goalIds) }) : [],
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId) }),
  ]);
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const visibleAccounts = new Set((await listVisibleAccounts(actor)).map((a) => a.id));
  const contribSetupIds = [...new Set(contributions.map((c) => c.setupId).filter((x): x is string => !!x))];
  const contribSetups = contribSetupIds.length ? await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.id, contribSetupIds) }) : [];
  const setupAccount = new Map(contribSetups.map((s) => [s.id, s.accountId]));
  const result = [];
  for (const g of all) {
    const contribs = contributions.filter((c) => c.goalId === g.id);
    const involved =
      isLeader ||
      g.ownerUserId === actor.userId ||
      (g.accountId && visibleAccounts.has(g.accountId)) ||
      contribs.some((c) => (c.accountId && visibleAccounts.has(c.accountId)) || (c.setupId && visibleAccounts.has(setupAccount.get(c.setupId) ?? "")));
    if (!involved) continue;
    const current = versions.find((v) => v.id === g.currentVersionId) ?? versions.find((v) => v.goalId === g.id) ?? null;
    result.push({ ...g, ownerName: un.get(g.ownerUserId) ?? "?", agreedByNames: g.agreedByUserIds.map((id) => un.get(id) ?? "?"), current, versionCount: versions.filter((v) => v.goalId === g.id).length, contributions: contribs });
  }
  return result;
}

export async function getGoal(actor: Actor, goalId: string) {
  const goals = await listGoals(actor);
  const g = goals.find((x) => x.id === goalId);
  if (!g) throw new NotFoundError("Ziel");
  const versions = await db.query.goalVersions.findMany({ where: eq(schema.goalVersions.goalId, goalId), orderBy: desc(schema.goalVersions.versionNo) });
  return { ...g, versions };
}

/** Führungs-Reviews, an denen der Akteur teilnimmt. */
export async function listLeadershipReviews(actor: Actor) {
  const parts = await db.query.reviewParticipants.findMany({ where: eq(schema.reviewParticipants.userId, actor.userId) });
  const ids = parts.map((p) => p.reviewId);
  if (ids.length === 0) return [];
  const rows = await db.query.reviews.findMany({ where: and(inArray(schema.reviews.id, ids), eq(schema.reviews.workspaceId, actor.workspaceId), ne(schema.reviews.type, "BD_ANKER_WEEKLY")), orderBy: desc(schema.reviews.scheduledFor) });
  return rows;
}
