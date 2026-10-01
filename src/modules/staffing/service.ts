import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canViewSetup, loadSetupContext } from "@/modules/identity/authz";
import { notify } from "@/modules/notifications/service";
import { createWorkItem, FINAL as WORK_FINAL } from "@/modules/work/service";
import { ensureDefaultTeams } from "@/modules/work/teams";
import { todayIso } from "@/modules/work/calendar";
import { canBrowseFreelancerPool, isStaffingManager, positionAccess, requireFullPosition, requireViewablePosition, SEARCH_KINDS, type PositionAccess, type PositionRow } from "./authz";

/**
 * Besetzung (Etappe 28, E1): Position → Suchauftrag an Sales Operations → Kandidatur → Vorschlag an BD → Freigabe →
 * Vorstellung/Interview → bestätigte Auswahl. Deterministische, serverseitige Zustände; jede Änderung mit Audit.
 * Keine Stundenzettel, keine CV-Erstellung, kein Ranking.
 */

// ---------------------------------------------------------------------------
// Zustände
// ---------------------------------------------------------------------------

export const positionStatusValues = ["ENTWURF", "OFFEN", "PAUSIERT", "BESETZT", "ABGEBROCHEN"] as const;
export type PositionStatus = (typeof positionStatusValues)[number];
export const positionStatusLabel: Record<string, string> = { ENTWURF: "Entwurf", OFFEN: "offen", PAUSIERT: "pausiert", BESETZT: "besetzt", ABGEBROCHEN: "abgebrochen" };
const POSITION_TRANSITIONS: Record<PositionStatus, PositionStatus[]> = {
  ENTWURF: ["OFFEN", "ABGEBROCHEN"],
  OFFEN: ["PAUSIERT", "ABGEBROCHEN", "BESETZT"],
  PAUSIERT: ["OFFEN", "ABGEBROCHEN"],
  BESETZT: [],
  ABGEBROCHEN: [],
};
export function assertPositionTransition(from: string, to: PositionStatus) {
  if (!(POSITION_TRANSITIONS[from as PositionStatus] ?? []).includes(to)) throw new TransitionError(`Position: Übergang von „${positionStatusLabel[from] ?? from}“ nach „${positionStatusLabel[to]}“ ist nicht vorgesehen.`);
}

export const candidacyStatusValues = ["IDENTIFIZIERT", "KONTAKT", "QUALIFIZIERT", "VORGESCHLAGEN", "FREIGEGEBEN", "VORGESTELLT", "INTERVIEW", "AUSGEWAEHLT", "ABGELEHNT", "ZURUECKGEZOGEN", "NICHT_VERFUEGBAR"] as const;
export type CandidacyStatus = (typeof candidacyStatusValues)[number];
export const CANDIDACY_FLOW: CandidacyStatus[] = ["IDENTIFIZIERT", "KONTAKT", "QUALIFIZIERT", "VORGESCHLAGEN", "FREIGEGEBEN", "VORGESTELLT", "INTERVIEW", "AUSGEWAEHLT"];
export const CANDIDACY_TERMINAL: CandidacyStatus[] = ["ABGELEHNT", "ZURUECKGEZOGEN", "NICHT_VERFUEGBAR"];
export const candidacyStatusLabel: Record<string, string> = {
  IDENTIFIZIERT: "identifiziert",
  KONTAKT: "in Kontakt",
  QUALIFIZIERT: "qualifiziert",
  VORGESCHLAGEN: "dem BD vorgeschlagen",
  FREIGEGEBEN: "zur Vorstellung freigegeben",
  VORGESTELLT: "vorgestellt",
  INTERVIEW: "im Interview",
  AUSGEWAEHLT: "ausgewählt",
  ABGELEHNT: "abgelehnt",
  ZURUECKGEZOGEN: "zurückgezogen",
  NICHT_VERFUEGBAR: "nicht verfügbar",
};

export const scopeUnitLabel: Record<string, string> = { TAGE_PRO_WOCHE: "Tage/Woche", STUNDEN_PRO_WOCHE: "Stunden/Woche", PROZENT: "%" };
export const rateUnitLabel: Record<string, string> = { TAG: "€/Tag", STUNDE: "€/Stunde" };

const issues = (e: z.ZodError) => e.issues.map((i) => i.message).join("; ");
const money = z
  .string()
  .trim()
  .regex(/^\d{1,7}([.,]\d{1,2})?$/, "Betrag mit höchstens zwei Nachkommastellen")
  .transform((v) => v.replace(",", "."))
  .optional()
  .or(z.literal(""));
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als JJJJ-MM-TT").optional().or(z.literal(""));
const opt = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));
const nul = (v: string | undefined) => (v ? v : null);

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export const positionInput = z.object({
  title: z.string().trim().min(3, "Titel/Rolle fehlt").max(200),
  roleId: opt(100),
  tasks: opt(4000),
  mustHave: opt(4000),
  niceToHave: opt(4000),
  location: opt(200),
  language: opt(100),
  desiredStart: dateStr,
  plannedEnd: dateStr,
  endOpen: z.union([z.boolean(), z.enum(["true", "false", "on"])]).optional(),
  scopeAmount: z.coerce.number().int().min(0).max(1000).optional().or(z.literal("")),
  scopeUnit: z.enum(["TAGE_PRO_WOCHE", "STUNDEN_PRO_WOCHE", "PROZENT", ""]).optional(),
  proposalDue: dateStr,
  bdUserId: opt(100),
  internalNotes: opt(4000),
  ekMin: money,
  ekMax: money,
  vkMin: money,
  vkMax: money,
  rateUnit: z.enum(["TAG", "STUNDE"]).optional(),
});
const truthy = (v: unknown) => v === true || v === "true" || v === "on";

function positionValues(i: z.infer<typeof positionInput>) {
  return {
    title: i.title,
    roleId: nul(i.roleId),
    tasks: nul(i.tasks),
    mustHave: nul(i.mustHave),
    niceToHave: nul(i.niceToHave),
    location: nul(i.location),
    language: nul(i.language),
    desiredStart: nul(i.desiredStart),
    plannedEnd: nul(i.plannedEnd),
    endOpen: truthy(i.endOpen),
    scopeAmount: i.scopeAmount === "" || i.scopeAmount === undefined ? null : i.scopeAmount,
    scopeUnit: i.scopeUnit || null,
    proposalDue: nul(i.proposalDue),
    internalNotes: nul(i.internalNotes),
    ekMin: nul(i.ekMin),
    ekMax: nul(i.ekMax),
    vkMin: nul(i.vkMin),
    vkMax: nul(i.vkMax),
    rateUnit: i.rateUnit ?? "TAG",
  };
}

async function requireOpportunityForStaffing(actor: Actor, opportunityId: string) {
  const opp = await db.query.opportunities.findFirst({ where: and(eq(schema.opportunities.id, opportunityId), eq(schema.opportunities.workspaceId, actor.workspaceId)) });
  if (!opp) throw new NotFoundError("Chance");
  const ctx = await loadSetupContext(actor, opp.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Chance");
  return { opp, ctx };
}

/** Darf der Akteur an dieser Chance Positionen anlegen/pflegen? (BD-Kontext, Principal, CEO – nicht Sales Operations, nicht Anker) */
export async function canManageStaffingAt(actor: Actor, opportunityId: string): Promise<boolean> {
  try {
    const { opp, ctx } = await requireOpportunityForStaffing(actor, opportunityId);
    return isStaffingManager(actor, ctx.account, ctx.setup.bdUserId, opp.ownerUserId === actor.userId ? actor.userId : null);
  } catch {
    return false;
  }
}

export async function createPosition(actor: Actor, opportunityId: string, raw: unknown, extra: { sourceId?: string | null; copiedFromId?: string | null; replacesPositionId?: string | null; tx?: Tx } = {}) {
  const p = positionInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const { opp, ctx } = await requireOpportunityForStaffing(actor, opportunityId);
  const manager = isStaffingManager(actor, ctx.account, ctx.setup.bdUserId, opp.ownerUserId === actor.userId ? actor.userId : null);
  if (!manager) throw new ForbiddenError("Positionen legt der zuständige BD, der Setup-BD, Principal oder CEO an.");
  if (opp.status === "BEENDET") throw new TransitionError("An einer beendeten Chance werden keine Positionen angelegt.");
  const bdUserId = p.data.bdUserId || (opp.ownerUserId ?? ctx.setup.bdUserId ?? ctx.account.responsibleBdUserId ?? actor.userId);
  const bd = await db.query.users.findFirst({ where: and(eq(schema.users.id, bdUserId), eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")) });
  if (!bd) throw new ValidationError("Verantwortlicher BD nicht gefunden.");
  const { assertCanCarryResponsibility } = await import("@/modules/identity/authz");
  await assertCanCarryResponsibility(bd.id);
  const run = async (tx: Tx) => {
    const [row] = await tx
      .insert(schema.staffingPositions)
      .values({ workspaceId: actor.workspaceId, opportunityId: opp.id, accountId: ctx.account.id, setupId: ctx.setup.id, bdUserId: bd.id, ...positionValues(p.data), sourceId: extra.sourceId ?? null, copiedFromId: extra.copiedFromId ?? null, replacesPositionId: extra.replacesPositionId ?? null, createdBy: actor.userId })
      .returning();
    await recordAudit(tx, actor, "position.created", "POSITION", row!.id, { chance: opp.id, titel: row!.title, kopieVon: extra.copiedFromId ?? null });
    return row!;
  };
  return extra.tx ? run(extra.tx) : db.transaction(run);
}

export async function updatePosition(actor: Actor, positionId: string, raw: unknown) {
  const p = positionInput.extend({ version: z.coerce.number().int().positive() }).safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireFullPosition(actor, positionId);
  if (!a.manage) throw new ForbiddenError("Positionsdaten ändert der verantwortliche BD, Principal oder CEO.");
  if (["BESETZT", "ABGEBROCHEN"].includes(a.position.status)) throw new TransitionError("Eine besetzte oder abgebrochene Position wird nicht mehr geändert.");
  const values = positionValues(p.data);
  if (p.data.bdUserId && p.data.bdUserId !== a.position.bdUserId) {
    const { assertCanCarryResponsibility } = await import("@/modules/identity/authz");
    await assertCanCarryResponsibility(p.data.bdUserId);
  }
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.staffingPositions)
      .set({ ...values, bdUserId: p.data.bdUserId || a.position.bdUserId, version: p.data.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.staffingPositions.id, positionId), eq(schema.staffingPositions.version, p.data.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "position.updated", "POSITION", positionId, { titel: u.title });
    if (p.data.bdUserId && p.data.bdUserId !== a.position.bdUserId) await notify(tx, { workspaceId: actor.workspaceId, userIds: [p.data.bdUserId], kind: "ZUGEWIESEN", title: `Position „${u.title}“ – du bist jetzt verantwortlich`, link: `/besetzung/${u.id}`, actorUserId: actor.userId });
    return u;
  });
}

/** Mindestangaben für „offen“: Titel, Chance, BD und Muss-Anforderungen (Default aus Briefing 4.1). */
export function openReadiness(p: PositionRow): string[] {
  const missing: string[] = [];
  if (!p.title || p.title.trim().length < 3) missing.push("Titel/Rolle");
  if (!p.mustHave || p.mustHave.trim().length < 10) missing.push("Muss-Anforderungen (mindestens ein Satz)");
  if (!p.bdUserId) missing.push("verantwortlicher BD");
  return missing;
}

export const positionStatusInput = z.object({
  version: z.coerce.number().int().positive(),
  status: z.enum(["OFFEN", "PAUSIERT", "ABGEBROCHEN"]),
  reason: opt(2000),
  holdReviewDate: dateStr,
});

export async function changePositionStatus(actor: Actor, positionId: string, raw: unknown) {
  const p = positionStatusInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireFullPosition(actor, positionId);
  if (!a.manage) throw new ForbiddenError("Den Status ändert der verantwortliche BD, Principal oder CEO.");
  const i = p.data;
  assertPositionTransition(a.position.status, i.status);
  if (i.status === "OFFEN") {
    const miss = openReadiness(a.position);
    if (miss.length) throw new ValidationError(`Bevor die Position offen ist, fehlt noch: ${miss.join(", ")}.`);
  }
  if (i.status === "PAUSIERT" && (!i.reason || !i.holdReviewDate)) throw new ValidationError("Pausieren braucht einen Grund und einen nächsten Prüftermin.");
  if (i.status === "ABGEBROCHEN" && (!i.reason || i.reason.length < 3)) throw new ValidationError("Bitte begründen, warum die Position ohne Besetzung endet.");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.staffingPositions)
      .set({ status: i.status, statusReason: i.reason || null, holdReviewDate: i.status === "PAUSIERT" ? i.holdReviewDate || null : null, version: i.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.staffingPositions.id, positionId), eq(schema.staffingPositions.version, i.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "position.status", "POSITION", positionId, { von: a.position.status, nach: i.status, grund: i.reason || null });
    if (i.status === "ABGEBROCHEN") {
      // Offene Aufträge nachvollziehbar schließen
      const open = await tx.query.workItems.findMany({ where: and(eq(schema.workItems.subjectType, "POSITION"), eq(schema.workItems.subjectId, positionId), notInArray(schema.workItems.status, WORK_FINAL)) });
      for (const w of open) {
        await tx.update(schema.workItems).set({ status: "VERWORFEN", statusNote: `Position abgebrochen: ${i.reason}`, completedAt: new Date(), version: w.version + 1, updatedAt: new Date() }).where(eq(schema.workItems.id, w.id));
        await recordAudit(tx, actor, "work.status_changed", "WORK_ITEM", w.id, { von: w.status, nach: "VERWORFEN", grund: "Position abgebrochen" });
        await notify(tx, { workspaceId: actor.workspaceId, userIds: [w.assigneeUserId, w.requesterUserId], kind: "KOMMENTAR", title: `Suchauftrag beendet – Position „${u.title}“ abgebrochen`, link: `/besetzung/${positionId}`, actorUserId: actor.userId });
      }
    }
    return u;
  });
}

export async function copyPosition(actor: Actor, positionId: string) {
  const a = await requireFullPosition(actor, positionId);
  if (!a.manage) throw new ForbiddenError("Kopieren darf der verantwortliche BD, Principal oder CEO.");
  const p = a.position;
  return createPosition(
    actor,
    p.opportunityId,
    {
      title: p.title,
      roleId: p.roleId ?? "",
      tasks: p.tasks ?? "",
      mustHave: p.mustHave ?? "",
      niceToHave: p.niceToHave ?? "",
      location: p.location ?? "",
      language: p.language ?? "",
      desiredStart: p.desiredStart ?? "",
      plannedEnd: p.plannedEnd ?? "",
      endOpen: p.endOpen,
      scopeAmount: p.scopeAmount ?? "",
      scopeUnit: p.scopeUnit ?? "",
      proposalDue: p.proposalDue ?? "",
      bdUserId: p.bdUserId,
      internalNotes: p.internalNotes ?? "",
      ekMin: p.ekMin ?? "",
      ekMax: p.ekMax ?? "",
      vkMin: p.vkMin ?? "",
      vkMax: p.vkMax ?? "",
      rateUnit: p.rateUnit as "TAG" | "STUNDE",
    },
    { copiedFromId: p.id },
  );
}

// ---------------------------------------------------------------------------
// Suchauftrag (Vorgang an Sales Operations)
// ---------------------------------------------------------------------------

export const searchOrderInput = z.object({
  expectedResult: z.string().trim().min(10, "Bitte beschreiben, was als Ergebnis erwartet wird (z. B. „zwei qualifizierte Profile mit EK bis …“).").max(2000),
  dueDate: dateStr,
  priority: z.enum(["NORMAL", "HOCH"]).default("NORMAL"),
  /** optional: gewünschte Person im Team */
  preferredUserId: opt(100),
});

export async function requestSearch(actor: Actor, positionId: string, raw: unknown) {
  const p = searchOrderInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireFullPosition(actor, positionId);
  if (!a.manage) throw new ForbiddenError("Einen Suchauftrag erteilt der verantwortliche BD, Principal oder CEO.");
  if (a.position.status !== "OFFEN") throw new TransitionError("Suchaufträge gibt es nur für offene Positionen – erst die Position auf „offen“ setzen.");
  const existing = await db.query.workItems.findFirst({ where: and(eq(schema.workItems.subjectType, "POSITION"), eq(schema.workItems.subjectId, positionId), eq(schema.workItems.kind, "SUCHE"), notInArray(schema.workItems.status, WORK_FINAL)) });
  if (existing) throw new ConflictError("Für diese Position läuft bereits ein Suchauftrag.");
  await ensureDefaultTeams(actor.workspaceId);
  const team = await db.query.teams.findFirst({ where: and(eq(schema.teams.workspaceId, actor.workspaceId), eq(schema.teams.key, "SALES_OPS")) });
  if (!team) throw new ValidationError("Team Sales Operations fehlt.");
  const due = p.data.dueDate || a.position.proposalDue || "";
  if (!due) throw new ValidationError("Bitte eine Fälligkeit angeben (oder den Zieltermin für Vorschläge an der Position pflegen).");
  const w = await createWorkItem(actor, {
    title: `Suche: ${a.position.title} (${a.accountName})`,
    description: `Erwartetes Ergebnis: ${p.data.expectedResult}`,
    subjectType: "POSITION",
    subjectId: positionId,
    target: p.data.preferredUserId || `team:${team.id}`,
    dueDate: due,
    priority: p.data.priority,
    reviewRequired: "on",
    kind: "SUCHE",
    checklistText: "Kandidaten identifiziert und kontaktiert\nVerfügbarkeit und EK je Kandidat erfasst\nShortlist dem BD vorgeschlagen",
  });
  await recordAudit(db, actor, "position.search_requested", "POSITION", positionId, { vorgang: w.id, an: p.data.preferredUserId || team.key });
  return w;
}

export async function searchOrderFor(positionId: string) {
  return db.query.workItems.findFirst({ where: and(eq(schema.workItems.subjectType, "POSITION"), eq(schema.workItems.subjectId, positionId), eq(schema.workItems.kind, "SUCHE")), orderBy: desc(schema.workItems.createdAt) });
}

// ---------------------------------------------------------------------------
// Freelancer-Minimalstamm
// ---------------------------------------------------------------------------

export const freelancerInput = z.object({
  displayName: z.string().trim().min(2, "Name fehlt").max(200),
  email: z.string().trim().max(200).optional().or(z.literal("")).refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "E-Mail ungültig"),
  phone: opt(50),
  company: opt(200),
  skills: opt(2000),
  availabilityNote: opt(500),
  availabilityAsOf: dateStr,
  availabilitySource: opt(200),
  externalCvRef: opt(500),
  externalToolRef: opt(500),
});

/** Freelancer anlegen – erlaubt für alle, die an einer Position Kandidaturen pflegen dürfen (Prüfung geschieht beim Anlegen der Kandidatur) oder den Pool sehen. */
export async function createFreelancer(actor: Actor, raw: unknown, tx0?: Tx) {
  const p = freelancerInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const i = p.data;
  const run = async (tx: Tx) => {
    const [f] = await tx
      .insert(schema.freelancers)
      .values({ workspaceId: actor.workspaceId, displayName: i.displayName, email: nul(i.email), phone: nul(i.phone), company: nul(i.company), skills: nul(i.skills), availabilityNote: nul(i.availabilityNote), availabilityAsOf: nul(i.availabilityAsOf), availabilitySource: nul(i.availabilitySource), externalCvRef: nul(i.externalCvRef), externalToolRef: nul(i.externalToolRef), createdBy: actor.userId })
      .returning();
    await recordAudit(tx, actor, "freelancer.created", "FREELANCER", f!.id, { name: f!.displayName });
    return f!;
  };
  return tx0 ? run(tx0) : db.transaction(run);
}

export async function updateFreelancer(actor: Actor, freelancerId: string, raw: unknown) {
  const p = freelancerInput.extend({ version: z.coerce.number().int().positive() }).safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const f = await requireFreelancer(actor, freelancerId);
  const i = p.data;
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.freelancers)
      .set({ displayName: i.displayName, email: nul(i.email), phone: nul(i.phone), company: nul(i.company), skills: nul(i.skills), availabilityNote: nul(i.availabilityNote), availabilityAsOf: nul(i.availabilityAsOf), availabilitySource: nul(i.availabilitySource), externalCvRef: nul(i.externalCvRef), externalToolRef: nul(i.externalToolRef), version: i.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.freelancers.id, f.id), eq(schema.freelancers.version, i.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "freelancer.updated", "FREELANCER", f.id, {});
    return u;
  });
}

/** Sichtbar: Pool-Berechtigte oder wer mindestens eine Kandidatur dieses Freelancers an einer eigenen Position sieht. */
export async function requireFreelancer(actor: Actor, freelancerId: string) {
  const f = await db.query.freelancers.findFirst({ where: and(eq(schema.freelancers.id, freelancerId), eq(schema.freelancers.workspaceId, actor.workspaceId)) });
  if (!f) throw new NotFoundError("Freelancer");
  if (canBrowseFreelancerPool(actor)) return f;
  const cands = await db.query.candidacies.findMany({ where: eq(schema.candidacies.freelancerId, f.id), columns: { positionId: true } });
  for (const c of [...new Set(cands.map((x) => x.positionId))]) {
    const pos = await db.query.staffingPositions.findFirst({ where: eq(schema.staffingPositions.id, c) });
    if (pos && (await positionAccess(actor, pos))?.full) return f;
  }
  throw new NotFoundError("Freelancer");
}

/** Namensähnliche Freelancer (Dublettenhinweis) – nur erlaubte Felder. */
export async function similarFreelancers(actor: Actor, name: string) {
  const q = name.trim().toLowerCase();
  if (q.length < 3) return [];
  const rows = await db.query.freelancers.findMany({ where: and(eq(schema.freelancers.workspaceId, actor.workspaceId), isNull(schema.freelancers.mergedIntoId)), orderBy: asc(schema.freelancers.displayName), limit: 500 });
  const parts = q.split(/\s+/).filter((x) => x.length >= 3);
  return rows.filter((r) => parts.some((pt) => r.displayName.toLowerCase().includes(pt))).slice(0, 8).map((r) => ({ id: r.id, displayName: r.displayName, company: r.company, skills: r.skills }));
}

export async function listFreelancerPool(actor: Actor) {
  if (!canBrowseFreelancerPool(actor)) throw new ForbiddenError("Den Freelancer-Pool sehen Sales Operations, Principals und CEO.");
  const rows = await db.query.freelancers.findMany({ where: and(eq(schema.freelancers.workspaceId, actor.workspaceId), isNull(schema.freelancers.mergedIntoId)), orderBy: asc(schema.freelancers.displayName) });
  const counts = await db.select({ freelancerId: schema.candidacies.freelancerId, n: sql<number>`count(*)` }).from(schema.candidacies).where(eq(schema.candidacies.workspaceId, actor.workspaceId)).groupBy(schema.candidacies.freelancerId);
  const cn = new Map(counts.map((c) => [c.freelancerId, Number(c.n)]));
  return rows.map((r) => ({ ...r, candidacyCount: cn.get(r.id) ?? 0 }));
}

// ---------------------------------------------------------------------------
// Kandidatur
// ---------------------------------------------------------------------------

export const candidacyInput = z.object({
  freelancerId: opt(100),
  /** neu anlegen, wenn keine freelancerId */
  newName: opt(200),
  newEmail: opt(200),
  newCompany: opt(200),
  newSkills: opt(2000),
  availableFrom: dateStr,
  availableTo: dateStr,
  ekRate: money,
  ekAsOf: dateStr,
  ekNote: opt(500),
  vkRate: money,
  rateUnit: z.enum(["TAG", "STUNDE"]).optional(),
  originRef: opt(300),
  notes: opt(4000),
  nextStep: opt(300),
  nextStepDue: dateStr,
});

function candidacyValues(i: z.infer<typeof candidacyInput>) {
  return {
    availableFrom: nul(i.availableFrom),
    availableTo: nul(i.availableTo),
    ekRate: nul(i.ekRate),
    ekAsOf: i.ekRate ? i.ekAsOf || todayIso() : nul(i.ekAsOf),
    ekNote: nul(i.ekNote),
    vkRate: nul(i.vkRate),
    rateUnit: i.rateUnit ?? "TAG",
    originRef: nul(i.originRef),
    notes: nul(i.notes),
    nextStep: nul(i.nextStep),
    nextStepDue: nul(i.nextStepDue),
  };
}

function requireCandidacyWork(a: PositionAccess) {
  if (!a.full) throw new NotFoundError("Position");
  if (!(a.manage || a.searcher)) throw new ForbiddenError("Kandidaturen pflegen die angenommene Suchbearbeiter:in und der verantwortliche BD.");
  if (["BESETZT", "ABGEBROCHEN"].includes(a.position.status)) throw new TransitionError("Die Position ist abgeschlossen.");
}

export async function addCandidacy(actor: Actor, positionId: string, raw: unknown) {
  const p = candidacyInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const a = await requireFullPosition(actor, positionId);
  requireCandidacyWork(a);
  const i = p.data;
  return db.transaction(async (tx) => {
    let freelancerId = i.freelancerId || "";
    if (!freelancerId) {
      if (!i.newName || i.newName.length < 2) throw new ValidationError("Bitte einen Freelancer wählen oder einen Namen für einen neuen eintragen.");
      const f = await createFreelancer(actor, { displayName: i.newName, email: i.newEmail, company: i.newCompany, skills: i.newSkills }, tx);
      freelancerId = f.id;
    } else {
      const f = await tx.query.freelancers.findFirst({ where: and(eq(schema.freelancers.id, freelancerId), eq(schema.freelancers.workspaceId, actor.workspaceId)) });
      if (!f) throw new ValidationError("Freelancer nicht gefunden.");
    }
    const dup = await tx.query.candidacies.findFirst({ where: and(eq(schema.candidacies.positionId, positionId), eq(schema.candidacies.freelancerId, freelancerId), eq(schema.candidacies.isActive, true)) });
    if (dup) throw new ConflictError("Für diese Person gibt es an der Position bereits eine aktive Kandidatur – bitte dort weiterarbeiten oder sie wieder aufnehmen.");
    const [c] = await tx
      .insert(schema.candidacies)
      .values({ workspaceId: actor.workspaceId, positionId, freelancerId, handlerUserId: actor.userId, ...candidacyValues(i), createdBy: actor.userId })
      .returning();
    await tx.insert(schema.candidacyEvents).values({ workspaceId: actor.workspaceId, candidacyId: c!.id, kind: "STATUS", toStatus: "IDENTIFIZIERT", createdBy: actor.userId });
    await recordAudit(tx, actor, "candidacy.created", "CANDIDACY", c!.id, { position: positionId });
    return c!;
  });
}

export async function updateCandidacy(actor: Actor, candidacyId: string, raw: unknown) {
  const p = candidacyInput.extend({ version: z.coerce.number().int().positive() }).safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const { candidacy: c, access: a } = await requireCandidacy(actor, candidacyId);
  requireCandidacyWork(a);
  if (CANDIDACY_TERMINAL.includes(c.status as CandidacyStatus) || c.status === "AUSGEWAEHLT") throw new TransitionError("Eine abgeschlossene Kandidatur wird nicht mehr geändert – ggf. wieder aufnehmen.");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.candidacies)
      .set({ ...candidacyValues(p.data), version: p.data.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.candidacies.id, candidacyId), eq(schema.candidacies.version, p.data.version)))
      .returning();
    if (!u) throw new ConflictError();
    await recordAudit(tx, actor, "candidacy.updated", "CANDIDACY", candidacyId, { ek: !!p.data.ekRate });
    return u;
  });
}

export async function requireCandidacy(actor: Actor, candidacyId: string) {
  const candidacy = await db.query.candidacies.findFirst({ where: and(eq(schema.candidacies.id, candidacyId), eq(schema.candidacies.workspaceId, actor.workspaceId)) });
  if (!candidacy) throw new NotFoundError("Kandidatur");
  const access = await requireFullPosition(actor, candidacy.positionId);
  return { candidacy, access };
}

export const candidacyStatusInput = z.object({
  version: z.coerce.number().int().positive(),
  status: z.enum(candidacyStatusValues),
  reason: opt(2000),
  /** bei Wiederaufnahme Pflicht */
  availabilityNote: opt(500),
});

/**
 * Statuswechsel ohne Ereignisdaten (Suchphasen, Vorschlag, Freigabe, Interview-Status, Absage, Wiederaufnahme).
 * VORGESTELLT entsteht nur über recordPresentation, AUSGEWAEHLT nur über selectCandidacy.
 */
export async function changeCandidacyStatus(actor: Actor, candidacyId: string, raw: unknown) {
  const p = candidacyStatusInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const { candidacy: c, access: a } = await requireCandidacy(actor, candidacyId);
  requireCandidacyWork(a);
  const to = p.data.status;
  const from = c.status as CandidacyStatus;
  if (to === "VORGESTELLT") throw new TransitionError("„Vorgestellt“ wird mit Datum, Empfänger und Profilstand dokumentiert (Vorstellung erfassen).");
  if (to === "AUSGEWAEHLT") throw new TransitionError("Die Auswahl bestätigt der verantwortliche BD über „Auswahl bestätigen“.");
  if (to === from) throw new TransitionError("Die Kandidatur hat diesen Status bereits.");
  const patch: Partial<typeof schema.candidacies.$inferInsert> = { status: to, statusReason: p.data.reason || null };
  if (CANDIDACY_TERMINAL.includes(to)) {
    if (!p.data.reason || p.data.reason.length < 3) throw new ValidationError("Bitte den Grund festhalten.");
    if (from === "AUSGEWAEHLT") throw new TransitionError("Eine bestätigte Auswahl wird nicht per Status zurückgenommen – dafür Nachbesetzung anlegen.");
  } else if (CANDIDACY_TERMINAL.includes(from)) {
    // Wiederaufnahme: Grund und aktualisierte Verfügbarkeit, zurück in die Qualifizierung
    if (to !== "QUALIFIZIERT") throw new TransitionError("Wiederaufnahme führt zurück nach „qualifiziert“.");
    if (!p.data.reason || !p.data.availabilityNote) throw new ValidationError("Wiederaufnahme braucht Grund und aktualisierte Verfügbarkeit.");
    patch.notes = `${c.notes ?? ""}\nWiederaufnahme ${todayIso()}: ${p.data.reason}; Verfügbarkeit: ${p.data.availabilityNote}`.trim();
  } else {
    const fi = CANDIDACY_FLOW.indexOf(from);
    const ti = CANDIDACY_FLOW.indexOf(to);
    if (ti < fi) throw new TransitionError("Rückwärts geht es nur über Absage/Rückzug und Wiederaufnahme.");
    if (ti > fi + 1 && !p.data.reason) throw new ValidationError("Beim Überspringen von Schritten bitte den Grund angeben.");
    if (to === "FREIGEGEBEN") {
      if (!a.manage) throw new ForbiddenError("Zur Vorstellung freigeben darf nur der verantwortliche BD (bzw. Principal/CEO).");
      patch.presentationApprovedBy = actor.userId;
      patch.presentationApprovedAt = new Date();
    }
    if (to === "INTERVIEW" && from !== "VORGESTELLT") throw new TransitionError("Ein Interview setzt eine dokumentierte Vorstellung voraus.");
    if (to === "VORGESCHLAGEN" && !c.ekRate) throw new ValidationError("Vor dem Vorschlag an den BD bitte den EK-Stand der Kandidatur erfassen.");
  }
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.candidacies)
      .set({ ...patch, version: p.data.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.candidacies.id, candidacyId), eq(schema.candidacies.version, p.data.version)))
      .returning();
    if (!u) throw new ConflictError();
    await tx.insert(schema.candidacyEvents).values({ workspaceId: actor.workspaceId, candidacyId, kind: CANDIDACY_TERMINAL.includes(to) ? "ABSAGE" : CANDIDACY_TERMINAL.includes(from) ? "WIEDERAUFNAHME" : "STATUS", fromStatus: from, toStatus: to, reason: p.data.reason || null, createdBy: actor.userId });
    await recordAudit(tx, actor, "candidacy.status", "CANDIDACY", candidacyId, { von: from, nach: to });
    const f = await tx.query.freelancers.findFirst({ where: eq(schema.freelancers.id, c.freelancerId), columns: { displayName: true } });
    if (to === "VORGESCHLAGEN" && a.position.bdUserId !== actor.userId) await notify(tx, { workspaceId: actor.workspaceId, userIds: [a.position.bdUserId], kind: "ZUR_PRUEFUNG", title: `Kandidat vorgeschlagen für „${a.position.title}“: ${f?.displayName ?? ""}`, link: `/besetzung/${a.position.id}`, actorUserId: actor.userId });
    if (to === "FREIGEGEBEN" && c.handlerUserId !== actor.userId) await notify(tx, { workspaceId: actor.workspaceId, userIds: [c.handlerUserId], kind: "ANGENOMMEN", title: `Zur Vorstellung freigegeben: ${f?.displayName ?? ""} („${a.position.title}“)`, link: `/besetzung/${a.position.id}`, actorUserId: actor.userId });
    return u;
  });
}

export const presentationInput = z.object({
  version: z.coerce.number().int().positive(),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum der Vorstellung fehlt"),
  recipientPersonId: opt(100),
  recipientText: opt(200),
  profileRef: z.string().trim().min(3, "Profilstand/CV-Referenz fehlt (z. B. Dateiname oder Link mit Versionsdatum)").max(500),
  summary: opt(4000),
  releaseScope: z.string().trim().min(3, "Erlaubte Weitergabe fehlt (Umfang, Stand, wer bestätigt hat)").max(500),
  releaseConfirmedBy: opt(200),
  releaseAsOf: dateStr,
  pricePresented: money,
  priceUnit: z.enum(["TAG", "STUNDE"]).optional(),
  communicationRef: opt(300),
  nextStep: opt(300),
});

/** Vorstellung beim Kunden dokumentieren: nur nach Freigabe; Profilstand wird als Prüfsumme festgehalten (unveränderlich). */
export async function recordPresentation(actor: Actor, candidacyId: string, raw: unknown) {
  const p = presentationInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const { candidacy: c, access: a } = await requireCandidacy(actor, candidacyId);
  if (!a.manage) throw new ForbiddenError("Die Vorstellung beim Kunden dokumentiert der verantwortliche BD.");
  if (!["FREIGEGEBEN", "VORGESTELLT", "INTERVIEW"].includes(c.status)) throw new TransitionError("Vorstellen setzt die Freigabe zur Vorstellung voraus.");
  if (!p.data.recipientPersonId && !p.data.recipientText) throw new ValidationError("Bitte angeben, wem vorgestellt wurde.");
  if (p.data.recipientPersonId) {
    const person = await db.query.persons.findFirst({ where: and(eq(schema.persons.id, p.data.recipientPersonId), eq(schema.persons.accountId, a.position.accountId)) });
    if (!person) throw new ValidationError("Die Ansprechperson gehört nicht zu diesem Kunden.");
  }
  const i = p.data;
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.candidacies)
      .set({ status: c.status === "FREIGEGEBEN" ? "VORGESTELLT" : c.status, nextStep: i.nextStep || c.nextStep, version: i.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.candidacies.id, candidacyId), eq(schema.candidacies.version, i.version)))
      .returning();
    if (!u) throw new ConflictError();
    const [ev] = await tx
      .insert(schema.candidacyEvents)
      .values({
        workspaceId: actor.workspaceId,
        candidacyId,
        kind: "VORSTELLUNG",
        at: new Date(`${i.at}T12:00:00Z`),
        recipientPersonId: nul(i.recipientPersonId),
        recipientText: nul(i.recipientText),
        profileRef: i.profileRef,
        profileHash: createHash("sha256").update(`${i.profileRef}|${i.summary ?? ""}|${i.pricePresented ?? ""}`).digest("hex").slice(0, 16),
        summary: nul(i.summary),
        releaseScope: i.releaseScope,
        releaseConfirmedBy: nul(i.releaseConfirmedBy),
        releaseAsOf: nul(i.releaseAsOf),
        pricePresented: nul(i.pricePresented),
        priceUnit: i.pricePresented ? i.priceUnit ?? "TAG" : null,
        communicationRef: nul(i.communicationRef),
        fromStatus: c.status,
        toStatus: u.status,
        createdBy: actor.userId,
      })
      .returning();
    await recordAudit(tx, actor, "candidacy.presented", "CANDIDACY", candidacyId, { ereignis: ev!.id, am: i.at });
    return { candidacy: u, event: ev! };
  });
}

export const interviewInput = z.object({
  version: z.coerce.number().int().positive(),
  interviewStatus: z.enum(["ANGEFRAGT", "GEPLANT", "DURCHGEFUEHRT", "ABGESAGT"]),
  interviewAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Termin als Datum und Uhrzeit").optional().or(z.literal("")),
  participants: opt(500),
  outcome: opt(2000),
  reason: opt(500),
});

export async function recordInterview(actor: Actor, candidacyId: string, raw: unknown) {
  const p = interviewInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const { candidacy: c, access: a } = await requireCandidacy(actor, candidacyId);
  if (!(a.manage || a.searcher)) throw new ForbiddenError("Interviews dokumentieren BD und Suchbearbeiter:in.");
  if (!["VORGESTELLT", "INTERVIEW"].includes(c.status)) throw new TransitionError("Interviews gibt es erst nach einer dokumentierten Vorstellung.");
  const i = p.data;
  if ((i.interviewStatus === "GEPLANT" || i.interviewStatus === "DURCHGEFUEHRT") && !i.interviewAt) throw new ValidationError("Für geplante oder durchgeführte Interviews fehlt der Termin.");
  if (i.interviewStatus === "DURCHGEFUEHRT" && !i.outcome) throw new ValidationError("Bitte das Ergebnis des Interviews kurz festhalten.");
  if (i.interviewStatus === "ABGESAGT" && !i.reason) throw new ValidationError("Bitte den Grund der Absage festhalten.");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(schema.candidacies)
      .set({ status: "INTERVIEW", version: i.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.candidacies.id, candidacyId), eq(schema.candidacies.version, i.version)))
      .returning();
    if (!u) throw new ConflictError();
    await tx.insert(schema.candidacyEvents).values({ workspaceId: actor.workspaceId, candidacyId, kind: "INTERVIEW", interviewStatus: i.interviewStatus, interviewAt: i.interviewAt ? new Date(`${i.interviewAt}:00+02:00`) : null, participants: nul(i.participants), outcome: nul(i.outcome), reason: nul(i.reason), fromStatus: c.status, toStatus: "INTERVIEW", createdBy: actor.userId });
    await recordAudit(tx, actor, "candidacy.interview", "CANDIDACY", candidacyId, { status: i.interviewStatus });
    return u;
  });
}

export const feedbackInput = z.object({ version: z.coerce.number().int().positive(), feedback: z.string().trim().min(3, "Rückmeldung fehlt").max(4000) });

export async function recordCustomerFeedback(actor: Actor, candidacyId: string, raw: unknown) {
  const p = feedbackInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  const { candidacy: c, access: a } = await requireCandidacy(actor, candidacyId);
  if (!a.manage) throw new ForbiddenError("Kundenrückmeldungen dokumentiert der verantwortliche BD.");
  await db.transaction(async (tx) => {
    const r = await tx.update(schema.candidacies).set({ version: p.data.version + 1, updatedAt: new Date() }).where(and(eq(schema.candidacies.id, candidacyId), eq(schema.candidacies.version, p.data.version))).returning({ id: schema.candidacies.id });
    if (!r.length) throw new ConflictError();
    await tx.insert(schema.candidacyEvents).values({ workspaceId: actor.workspaceId, candidacyId, kind: "RUECKMELDUNG", outcome: p.data.feedback, fromStatus: c.status, toStatus: c.status, createdBy: actor.userId });
    await recordAudit(tx, actor, "candidacy.feedback", "CANDIDACY", candidacyId, {});
  });
}

export const selectInput = z.object({ version: z.coerce.number().int().positive(), reason: opt(2000), confirm: z.union([z.boolean(), z.enum(["true", "on"])]) });

/**
 * Auswahl bestätigen (BD-Kontext): genau eine erfolgreiche Kandidatur je Position; idempotent (erneuter Aufruf für
 * dieselbe Kandidatur ändert nichts). Die Position wird „besetzt“; andere Kandidaturen bleiben mit Verlauf bestehen.
 */
export async function selectCandidacy(actor: Actor, candidacyId: string, raw: unknown) {
  const p = selectInput.safeParse(raw);
  if (!p.success) throw new ValidationError(issues(p.error));
  if (!(p.data.confirm === true || p.data.confirm === "true" || p.data.confirm === "on")) throw new ValidationError("Bitte die Auswahl ausdrücklich bestätigen.");
  const { candidacy: c, access: a } = await requireCandidacy(actor, candidacyId);
  if (!a.manage) throw new ForbiddenError("Die Auswahl bestätigt der verantwortliche BD (bzw. Principal/CEO).");
  if (a.position.status === "BESETZT" && a.position.filledCandidacyId === c.id) return { candidacy: c, position: a.position, already: true };
  if (a.position.status !== "OFFEN") throw new TransitionError("Nur an einer offenen Position kann ausgewählt werden.");
  if (!["FREIGEGEBEN", "VORGESTELLT", "INTERVIEW"].includes(c.status)) throw new TransitionError("Ausgewählt werden kann nur eine zur Vorstellung freigegebene Kandidatur.");
  if (c.status !== "INTERVIEW" && !p.data.reason) throw new ValidationError("Auswahl ohne Interview: bitte kurz begründen.");
  return db.transaction(async (tx) => {
    // Position atomar besetzen – schützt vor zwei gleichzeitigen Auswahlen
    const [pos] = await tx
      .update(schema.staffingPositions)
      .set({ status: "BESETZT", filledCandidacyId: c.id, filledAt: new Date(), version: a.position.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.staffingPositions.id, a.position.id), eq(schema.staffingPositions.status, "OFFEN"), isNull(schema.staffingPositions.filledCandidacyId), eq(schema.staffingPositions.version, a.position.version)))
      .returning();
    if (!pos) throw new ConflictError("Die Position wurde inzwischen geändert oder bereits besetzt.");
    const [u] = await tx
      .update(schema.candidacies)
      .set({ status: "AUSGEWAEHLT", selectedBy: actor.userId, selectedAt: new Date(), statusReason: p.data.reason || null, version: p.data.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.candidacies.id, c.id), eq(schema.candidacies.version, p.data.version)))
      .returning();
    if (!u) throw new ConflictError();
    await tx.insert(schema.candidacyEvents).values({ workspaceId: actor.workspaceId, candidacyId: c.id, kind: "AUSWAHL", fromStatus: c.status, toStatus: "AUSGEWAEHLT", reason: p.data.reason || null, createdBy: actor.userId });
    await recordAudit(tx, actor, "position.filled", "POSITION", pos.id, { kandidatur: c.id });
    // Einsatzakte (Etappe 29) – idempotent, eine je Kandidatur; beweist weder Vertragslage noch Start
    const { ensureEngagementForSelection } = await import("@/modules/engagements/service");
    const engagement = await ensureEngagementForSelection(tx, actor, c.id);
    void engagement;
    // Offenen Suchauftrag zur Abnahme bringen bzw. als erledigt kennzeichnen
    const open = await tx.query.workItems.findMany({ where: and(eq(schema.workItems.subjectType, "POSITION"), eq(schema.workItems.subjectId, pos.id), eq(schema.workItems.kind, "SUCHE"), notInArray(schema.workItems.status, WORK_FINAL)) });
    for (const w of open) {
      await tx.update(schema.workItems).set({ status: "ERLEDIGT", result: `${w.result ?? ""}\nPosition besetzt (Auswahl bestätigt).`.trim(), completedAt: new Date(), version: w.version + 1, updatedAt: new Date() }).where(eq(schema.workItems.id, w.id));
      await recordAudit(tx, actor, "work.status_changed", "WORK_ITEM", w.id, { von: w.status, nach: "ERLEDIGT", grund: "Position besetzt" });
      if (w.assigneeUserId) await notify(tx, { workspaceId: actor.workspaceId, userIds: [w.assigneeUserId], kind: "ERLEDIGT", title: `Position besetzt: „${pos.title}“`, link: `/besetzung/${pos.id}`, actorUserId: actor.userId });
    }
    return { candidacy: u, position: pos, already: false };
  });
}

// ---------------------------------------------------------------------------
// Listen und Detail
// ---------------------------------------------------------------------------

export type PositionView = PositionRow & {
  accountName: string;
  opportunityTitle: string;
  bdName: string;
  searcherName: string | null;
  searchStatus: string | null;
  searchWorkItemId: string | null;
  candidacyCount: number;
  presentedCount: number;
  nextDue: string | null;
  overdue: boolean;
  progress: string;
  access: "full" | "preview";
};

async function decoratePositions(actor: Actor, rows: PositionRow[], accessOf: (p: PositionRow) => "full" | "preview"): Promise<PositionView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [accounts, opps, users, cands, works] = await Promise.all([
    db.query.accounts.findMany({ where: inArray(schema.accounts.id, [...new Set(rows.map((r) => r.accountId))]), columns: { id: true, name: true } }),
    db.query.opportunities.findMany({ where: inArray(schema.opportunities.id, [...new Set(rows.map((r) => r.opportunityId))]), columns: { id: true, title: true } }),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { id: true, displayName: true } }),
    db.query.candidacies.findMany({ where: inArray(schema.candidacies.positionId, ids), columns: { positionId: true, status: true, isActive: true, nextStepDue: true } }),
    db.query.workItems.findMany({ where: and(eq(schema.workItems.subjectType, "POSITION"), inArray(schema.workItems.subjectId, ids), eq(schema.workItems.kind, "SUCHE")), orderBy: desc(schema.workItems.createdAt) }),
  ]);
  const an = new Map(accounts.map((a) => [a.id, a.name]));
  const on = new Map(opps.map((o) => [o.id, o.title]));
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  const today = todayIso();
  return rows.map((r) => {
    const cs = cands.filter((c) => c.positionId === r.id && c.isActive);
    const w = works.find((x) => x.subjectId === r.id && !WORK_FINAL.includes(x.status as (typeof WORK_FINAL)[number])) ?? works.find((x) => x.subjectId === r.id) ?? null;
    const presented = cs.filter((c) => ["VORGESTELLT", "INTERVIEW", "AUSGEWAEHLT"].includes(c.status)).length;
    const dues = [r.proposalDue, w && !WORK_FINAL.includes(w.status as (typeof WORK_FINAL)[number]) ? w.dueDate : null, ...cs.map((c) => c.nextStepDue), r.status === "PAUSIERT" ? r.holdReviewDate : null].filter((d): d is string => !!d).sort();
    const nextDue = ["BESETZT", "ABGEBROCHEN"].includes(r.status) ? null : (dues[0] ?? null);
    const progress =
      r.status === "BESETZT" ? "Auswahl bestätigt" : cs.some((c) => c.status === "INTERVIEW") ? "Interview läuft" : presented ? "vorgestellt" : cs.some((c) => c.status === "FREIGEGEBEN") ? "zur Vorstellung freigegeben" : cs.some((c) => c.status === "VORGESCHLAGEN") ? "Shortlist beim BD" : cs.length ? `${cs.length} Kandidatur(en) in Prüfung` : w && w.status === "ANGEFRAGT" ? "Suchauftrag wartet auf Übernahme" : w && !WORK_FINAL.includes(w.status as (typeof WORK_FINAL)[number]) ? "Suche läuft" : r.status === "OFFEN" ? "offen – noch kein Suchauftrag" : positionStatusLabel[r.status] ?? r.status;
    return {
      ...r,
      accountName: an.get(r.accountId) ?? "?",
      opportunityTitle: on.get(r.opportunityId) ?? "?",
      bdName: un.get(r.bdUserId) ?? "?",
      searcherName: w?.assigneeUserId ? un.get(w.assigneeUserId) ?? "?" : null,
      searchStatus: w?.status ?? null,
      searchWorkItemId: w?.id ?? null,
      candidacyCount: cs.length,
      presentedCount: presented,
      nextDue,
      overdue: !!nextDue && nextDue < today,
      progress,
      access: accessOf(r),
    };
  });
}

/** Für die Teamvorschau: nur erlaubte Felder. */
export function previewOf(v: PositionView) {
  return { id: v.id, title: v.title, accountName: v.accountName, opportunityTitle: v.opportunityTitle, mustHave: v.mustHave, desiredStart: v.desiredStart, scopeAmount: v.scopeAmount, scopeUnit: v.scopeUnit, location: v.location, proposalDue: v.proposalDue, status: v.status, progress: v.progress, nextDue: v.nextDue, overdue: v.overdue, bdName: v.bdName, searchWorkItemId: v.searchWorkItemId, searchStatus: v.searchStatus, access: "preview" as const };
}

export const positionFilterValues = ["alle", "meine", "team", "offen", "pausiert", "ueberfaellig", "besetzt"] as const;
export type PositionFilter = (typeof positionFilterValues)[number];

/** Alle Positionen, die der Akteur sehen darf – Rechte vor Zählung und Filter. */
export async function listPositions(actor: Actor, filter: PositionFilter = "alle") {
  const rows = await db.query.staffingPositions.findMany({ where: eq(schema.staffingPositions.workspaceId, actor.workspaceId), orderBy: [asc(schema.staffingPositions.proposalDue), desc(schema.staffingPositions.createdAt)] });
  const full: PositionRow[] = [];
  const preview: PositionRow[] = [];
  for (const r of rows) {
    const a = await positionAccess(actor, r);
    if (!a) continue;
    (a.full ? full : preview).push(r);
  }
  const views = await decoratePositions(actor, [...full, ...preview], (p) => (full.includes(p) ? "full" : "preview"));
  const counts = {
    alle: views.length,
    meine: views.filter((v) => v.bdUserId === actor.userId || (v.access === "full" && v.searcherName && v.searchStatus && !WORK_FINAL.includes(v.searchStatus as (typeof WORK_FINAL)[number]) && v.searchWorkItemId && v.searcherName === "")).length,
    team: views.filter((v) => v.access === "preview" || (v.searchStatus === "ANGEFRAGT" && v.access === "full")).length,
    offen: views.filter((v) => v.status === "OFFEN").length,
    pausiert: views.filter((v) => v.status === "PAUSIERT").length,
    ueberfaellig: views.filter((v) => v.overdue).length,
    besetzt: views.filter((v) => v.status === "BESETZT").length,
  };
  const myItems = await db.query.workItems.findMany({ where: and(eq(schema.workItems.subjectType, "POSITION"), eq(schema.workItems.assigneeUserId, actor.userId), inArray(schema.workItems.kind, [...SEARCH_KINDS])), columns: { subjectId: true } });
  const mine = new Set(myItems.map((m) => m.subjectId));
  counts.meine = views.filter((v) => v.bdUserId === actor.userId || mine.has(v.id)).length;
  const filtered =
    filter === "meine" ? views.filter((v) => v.bdUserId === actor.userId || mine.has(v.id))
    : filter === "team" ? views.filter((v) => v.access === "preview" || v.searchStatus === "ANGEFRAGT")
    : filter === "offen" ? views.filter((v) => v.status === "OFFEN")
    : filter === "pausiert" ? views.filter((v) => v.status === "PAUSIERT")
    : filter === "ueberfaellig" ? views.filter((v) => v.overdue)
    : filter === "besetzt" ? views.filter((v) => v.status === "BESETZT")
    : views;
  return { items: filtered.map((v) => (v.access === "preview" ? previewOf(v) : v)), counts };
}

export async function listPositionsForOpportunity(actor: Actor, opportunityId: string) {
  const rows = await db.query.staffingPositions.findMany({ where: and(eq(schema.staffingPositions.opportunityId, opportunityId), eq(schema.staffingPositions.workspaceId, actor.workspaceId)), orderBy: asc(schema.staffingPositions.createdAt) });
  const visible: PositionRow[] = [];
  for (const r of rows) if ((await positionAccess(actor, r))?.full) visible.push(r);
  return decoratePositions(actor, visible, () => "full");
}

export async function getPositionDetail(actor: Actor, positionId: string) {
  const a = await requireViewablePosition(actor, positionId);
  const [view] = await decoratePositions(actor, [a.position], () => (a.full ? "full" : "preview"));
  const search = await searchOrderFor(positionId);
  const users = await db.query.users.findMany({ where: and(eq(schema.users.workspaceId, actor.workspaceId), eq(schema.users.status, "ACTIVE")), columns: { id: true, displayName: true } });
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  if (!a.full) {
    return { access: a, view: previewOf(view!), search: search ? { id: search.id, status: search.status, dueDate: search.dueDate, assigneeName: search.assigneeUserId ? un.get(search.assigneeUserId) ?? "?" : null } : null, candidacies: [], events: [], persons: [], users: [], roles: [], readiness: [] as string[], history: [] as { at: Date; who: string; action: string; changes: Record<string, unknown> | null }[] };
  }
  const cands = await db.query.candidacies.findMany({ where: eq(schema.candidacies.positionId, positionId), orderBy: asc(schema.candidacies.createdAt) });
  const fls = cands.length ? await db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, cands.map((c) => c.freelancerId)) }) : [];
  const fm = new Map(fls.map((f) => [f.id, f]));
  const events = cands.length ? await db.query.candidacyEvents.findMany({ where: inArray(schema.candidacyEvents.candidacyId, cands.map((c) => c.id)), orderBy: asc(schema.candidacyEvents.at) }) : [];
  const persons = await db.query.persons.findMany({ where: eq(schema.persons.accountId, a.position.accountId), columns: { id: true, displayName: true } });
  const roles = await db.query.standardRoles.findMany({ where: and(eq(schema.standardRoles.workspaceId, actor.workspaceId), eq(schema.standardRoles.active, true)), orderBy: asc(schema.standardRoles.name), columns: { id: true, name: true } });
  const history = await db.query.auditEvents.findMany({ where: and(eq(schema.auditEvents.objectType, "POSITION"), eq(schema.auditEvents.objectId, positionId)), orderBy: asc(schema.auditEvents.at) });
  const pn = new Map(persons.map((p) => [p.id, p.displayName]));
  return {
    access: a,
    view: view!,
    search: search ? { id: search.id, status: search.status, dueDate: search.dueDate, assigneeName: search.assigneeUserId ? un.get(search.assigneeUserId) ?? "?" : null, statusNote: search.statusNote, description: search.description } : null,
    candidacies: cands.map((c) => ({ ...c, freelancer: fm.get(c.freelancerId)!, handlerName: un.get(c.handlerUserId) ?? "?", events: events.filter((e) => e.candidacyId === c.id).map((e) => ({ ...e, who: un.get(e.createdBy) ?? "?", recipientName: e.recipientPersonId ? pn.get(e.recipientPersonId) ?? null : null })) })),
    events,
    persons,
    users: users.map((u) => ({ id: u.id, name: u.displayName })),
    roles,
    readiness: openReadiness(a.position),
    history: history.map((h) => ({ at: h.at, who: h.actorUserId ? un.get(h.actorUserId) ?? "?" : "System", action: h.action, changes: h.changes as Record<string, unknown> | null })),
  };
}

export async function getFreelancerDetail(actor: Actor, freelancerId: string) {
  const f = await requireFreelancer(actor, freelancerId);
  const cands = await db.query.candidacies.findMany({ where: eq(schema.candidacies.freelancerId, f.id), orderBy: desc(schema.candidacies.createdAt) });
  // Kundenspezifische Kandidaturen nur, soweit die Position sichtbar ist (A16: keine fremde Historie)
  const visible = [];
  for (const c of cands) {
    const pos = await db.query.staffingPositions.findFirst({ where: eq(schema.staffingPositions.id, c.positionId) });
    if (!pos) continue;
    const acc = await positionAccess(actor, pos);
    if (acc?.full) visible.push({ candidacy: c, position: pos, accountName: acc.accountName });
  }
  return { freelancer: f, candidacies: visible, hiddenCount: cands.length - visible.length };
}

/** Kurze Zusammenfassung für die Chance-Seite: Zahl offener/besetzter Positionen. */
export async function staffingSummary(actor: Actor, opportunityId: string) {
  const list = await listPositionsForOpportunity(actor, opportunityId);
  return { total: list.length, open: list.filter((p) => p.status === "OFFEN").length, filled: list.filter((p) => p.status === "BESETZT").length, items: list };
}

