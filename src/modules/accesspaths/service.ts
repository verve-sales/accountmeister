import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { AccessPlanStatus } from "@/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, loadSetupContext } from "@/modules/identity/authz";

/**
 * Kontaktweg (Briefing 8.4 / A5): Zielperson oder gesuchte Funktion, Anlass, angestrebtes Ergebnis,
 * Ausgangskontakt/Beziehungshalter, Vermittlungsschritte mit Belegen, Bereitschaft, erlaubter Inhalt,
 * Alternative, Verantwortlicher und nächster Schritt.
 *
 * F06: Belegte, geplante und hypothetische Verbindungen werden strikt getrennt geführt.
 * Ein Schritt darf nur dann „belegt“ heißen, wenn er auf eine dokumentierte Beziehung oder Quelle verweist.
 */
export const createAccessPlanInput = z.object({
  setupId: z.string().min(1),
  targetPersonId: z.string().optional().or(z.literal("")),
  targetFunction: z.string().trim().max(200).optional().or(z.literal("")),
  occasion: z.string().trim().min(5, "Bitte den fachlichen Anlass nennen.").max(2000),
  desiredOutcome: z.string().trim().max(2000).optional().or(z.literal("")),
  allowedIntroContent: z.string().trim().max(2000).optional().or(z.literal("")),
  alternative: z.string().trim().max(2000).optional().or(z.literal("")),
  ownerUserId: z.string().optional().or(z.literal("")),
  nextStep: z.string().trim().max(1000).optional().or(z.literal("")),
});

export async function createAccessPlan(actor: Actor, raw: unknown) {
  const parsed = createAccessPlanInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  if (!input.targetPersonId && !input.targetFunction) throw new ValidationError("Bitte Zielperson oder gesuchte Funktion angeben.");
  const ctx = await loadSetupContext(actor, input.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Sie dürfen in diesem Setup keinen Kontaktweg anlegen.");
  if (input.targetPersonId) {
    const p = await db.query.persons.findFirst({ where: and(eq(schema.persons.id, input.targetPersonId), eq(schema.persons.accountId, ctx.account.id)) });
    if (!p) throw new ValidationError("Zielperson gehört nicht zu diesem Kunden.");
  }
  return db.transaction(async (tx) => {
    const [plan] = await tx
      .insert(schema.accessPlans)
      .values({
        workspaceId: actor.workspaceId,
        setupId: input.setupId,
        targetPersonId: input.targetPersonId || null,
        targetFunction: input.targetFunction || null,
        occasion: input.occasion,
        desiredOutcome: input.desiredOutcome || null,
        allowedIntroContent: input.allowedIntroContent || null,
        alternative: input.alternative || null,
        ownerUserId: input.ownerUserId || actor.userId,
        nextStep: input.nextStep || null,
        createdBy: actor.userId,
      })
      .returning();
    if (!plan) throw new Error("Kontaktweg konnte nicht angelegt werden");
    await recordAudit(tx, actor, "accessplan.created", "ACCESS_PLAN", plan.id, { setupId: input.setupId });
    return plan;
  });
}

export const addStepInput = z.object({
  accessPlanId: z.string().min(1),
  fromUserId: z.string().optional().or(z.literal("")),
  fromPersonId: z.string().optional().or(z.literal("")),
  toPersonId: z.string().min(1, "Zielperson des Schritts fehlt"),
  kind: z.enum(schema.accessStepKindEnum.enumValues),
  relationshipId: z.string().optional().or(z.literal("")),
  evidenceSourceId: z.string().optional().or(z.literal("")),
  mediationReadiness: z.enum(schema.mediationReadinessEnum.enumValues).default("UNBEKANNT"),
  note: z.string().trim().max(1000).optional().or(z.literal("")),
});

export async function addAccessPlanStep(actor: Actor, raw: unknown) {
  const parsed = addStepInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { plan, ctx } = await requirePlan(actor, input.accessPlanId);
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError();
  if (plan.status === "BEENDET" || plan.status === "NICHT_MOEGLICH") throw new TransitionError("Dieser Kontaktweg ist abgeschlossen.");
  if (!input.fromUserId && !input.fromPersonId) throw new ValidationError("Bitte den Ausgangspunkt (Verve-Beziehungshalter oder vermittelnde Person) angeben.");

  // F06: „belegt“ nur mit dokumentierter Beziehung oder Quelle.
  const relationshipId: string | null = input.relationshipId || null;
  if (input.kind === "BELEGT") {
    if (!relationshipId && !input.evidenceSourceId) {
      throw new ValidationError("Eine belegte Verbindung braucht eine dokumentierte Beziehung oder Quelle. Ohne Beleg bitte als „hypothetisch“ kennzeichnen.");
    }
    if (relationshipId) {
      const rel = await db.query.relationships.findFirst({ where: eq(schema.relationships.id, relationshipId) });
      if (!rel || rel.personId !== input.toPersonId) throw new ValidationError("Die gewählte Beziehung passt nicht zur Zielperson des Schritts.");
      if (rel.state === "NAME_FUNKTION_BEKANNT" || rel.state === "NICHT_AKTIV") {
        throw new ValidationError(`Der Beziehungsstand „${rel.state}“ belegt keine tragfähige Verbindung. Bitte als „hypothetisch“ oder „geplant“ führen.`);
      }
      if (input.fromUserId && rel.holderUserId !== input.fromUserId) throw new ValidationError("Die Beziehung wird von einer anderen Person gehalten.");
    }
  }
  if (input.kind === "GEPLANT" && input.mediationReadiness === "ABGELEHNT") throw new ValidationError("Eine abgelehnte Vermittlung kann nicht als geplant geführt werden.");

  const target = await db.query.persons.findFirst({ where: and(eq(schema.persons.id, input.toPersonId), eq(schema.persons.accountId, ctx.account.id)) });
  if (!target) throw new ValidationError("Zielperson des Schritts gehört nicht zu diesem Kunden.");

  return db.transaction(async (tx) => {
    const existing = await tx.query.accessPlanSteps.findMany({ where: eq(schema.accessPlanSteps.accessPlanId, plan.id) });
    const [step] = await tx
      .insert(schema.accessPlanSteps)
      .values({
        accessPlanId: plan.id,
        position: existing.length + 1,
        fromUserId: input.fromUserId || null,
        fromPersonId: input.fromPersonId || null,
        toPersonId: input.toPersonId,
        kind: input.kind,
        relationshipId,
        evidenceSourceId: input.evidenceSourceId || null,
        mediationReadiness: input.mediationReadiness,
        note: input.note || null,
      })
      .returning();
    await tx.update(schema.accessPlans).set({ updatedAt: new Date() }).where(eq(schema.accessPlans.id, plan.id));
    await recordAudit(tx, actor, "accessplan.step_added", "ACCESS_PLAN", plan.id, { kind: input.kind });
    return step;
  });
}

const planTransitions: Record<AccessPlanStatus, AccessPlanStatus[]> = {
  ENTWURF: ["IN_ABSTIMMUNG", "NICHT_MOEGLICH", "BEENDET"],
  IN_ABSTIMMUNG: ["VERMITTLUNG_ZUGESAGT", "NICHT_MOEGLICH", "BEENDET"],
  VERMITTLUNG_ZUGESAGT: ["VORGESTELLT", "NICHT_MOEGLICH", "BEENDET"],
  VORGESTELLT: ["BEENDET"],
  NICHT_MOEGLICH: ["ENTWURF"],
  BEENDET: [],
};

export const changePlanStatusInput = z.object({
  version: z.coerce.number().int().positive(),
  status: z.enum(schema.accessPlanStatusEnum.enumValues),
  nextStep: z.string().trim().max(1000).optional().or(z.literal("")),
  evidenceSourceId: z.string().optional().or(z.literal("")),
});

/**
 * „Vorgestellt“ ist ein tatsächliches Ereignis und braucht einen Beleg (Quelle) – ein Entwurf reicht nicht (9.3).
 * „Vermittlung zugesagt“ setzt voraus, dass mindestens ein Schritt die Bereitschaft „bereit“ trägt.
 */
export async function changeAccessPlanStatus(actor: Actor, planId: string, raw: unknown) {
  const parsed = changePlanStatusInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { plan, ctx } = await requirePlan(actor, planId);
  if (!canEditSetup(actor, ctx) && plan.ownerUserId !== actor.userId) throw new ForbiddenError();
  if (!planTransitions[plan.status].includes(input.status)) throw new TransitionError(`Übergang von „${plan.status}“ nach „${input.status}“ ist nicht vorgesehen.`);
  const steps = await db.query.accessPlanSteps.findMany({ where: eq(schema.accessPlanSteps.accessPlanId, plan.id) });
  if (input.status === "VERMITTLUNG_ZUGESAGT" && !steps.some((s) => s.mediationReadiness === "BEREIT")) {
    throw new ValidationError("„Vermittlung zugesagt“ braucht mindestens einen Schritt mit Bereitschaft „bereit“.");
  }
  if (input.status === "VORGESTELLT" && !input.evidenceSourceId) {
    throw new ValidationError("„Vorgestellt“ ist ein tatsächliches Ereignis – bitte die belegende Quelle angeben.");
  }
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.accessPlans)
      .set({ status: input.status, nextStep: input.nextStep || plan.nextStep, version: input.version + 1, updatedAt: new Date() })
      .where(and(eq(schema.accessPlans.id, plan.id), eq(schema.accessPlans.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    if (input.status === "VORGESTELLT" && plan.targetPersonId && input.evidenceSourceId) {
      // Beziehungsstand der Zielperson zum Verantwortlichen wird auf „vorgestellt“ gesetzt – mit Beleg.
      await tx
        .insert(schema.relationships)
        .values({
          personId: plan.targetPersonId,
          holderUserId: plan.ownerUserId,
          setupId: plan.setupId,
          state: "VORGESTELLT",
          contextNote: `Vorstellung über Kontaktweg „${plan.occasion}“.`,
          evidenceSourceId: input.evidenceSourceId,
          createdBy: actor.userId,
        });
    }
    await recordAudit(tx, actor, "accessplan.status_changed", "ACCESS_PLAN", plan.id, { von: plan.status, nach: input.status });
    return updated;
  });
}

export async function requirePlan(actor: Actor, planId: string) {
  const plan = await db.query.accessPlans.findFirst({ where: and(eq(schema.accessPlans.id, planId), eq(schema.accessPlans.workspaceId, actor.workspaceId)) });
  if (!plan) throw new NotFoundError("Kontaktweg");
  const ctx = await loadSetupContext(actor, plan.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Kontaktweg");
  return { plan, ctx };
}

/** Kontaktwege eines Setups mit Schritten (tabellarische Darstellung; Karte folgt später). */
export async function listAccessPlansForSetup(actor: Actor, setupId: string) {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  const plans = await db.query.accessPlans.findMany({ where: eq(schema.accessPlans.setupId, setupId), orderBy: desc(schema.accessPlans.updatedAt) });
  const planIds = plans.map((p) => p.id);
  const steps = planIds.length ? await db.query.accessPlanSteps.findMany({ where: inArray(schema.accessPlanSteps.accessPlanId, planIds), orderBy: asc(schema.accessPlanSteps.position) }) : [];
  const personIds = new Set<string>();
  const userIds = new Set<string>();
  for (const p of plans) {
    if (p.targetPersonId) personIds.add(p.targetPersonId);
    userIds.add(p.ownerUserId);
  }
  for (const s of steps) {
    personIds.add(s.toPersonId);
    if (s.fromPersonId) personIds.add(s.fromPersonId);
    if (s.fromUserId) userIds.add(s.fromUserId);
  }
  const [persons, users] = await Promise.all([
    personIds.size ? db.query.persons.findMany({ where: inArray(schema.persons.id, [...personIds]) }) : Promise.resolve([]),
    userIds.size ? db.query.users.findMany({ where: inArray(schema.users.id, [...userIds]) }) : Promise.resolve([]),
  ]);
  const pn = new Map(persons.map((p) => [p.id, p.displayName]));
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  return plans.map((p) => ({
    ...p,
    targetName: p.targetPersonId ? pn.get(p.targetPersonId) ?? "?" : p.targetFunction ?? "?",
    ownerName: un.get(p.ownerUserId) ?? "?",
    steps: steps
      .filter((s) => s.accessPlanId === p.id)
      .map((s) => ({
        ...s,
        fromName: s.fromUserId ? `${un.get(s.fromUserId) ?? "?"} (Verve)` : s.fromPersonId ? pn.get(s.fromPersonId) ?? "?" : "?",
        toName: pn.get(s.toPersonId) ?? "?",
      })),
  }));
}
