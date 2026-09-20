import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, canViewSource, loadSetupContext, type SetupContext } from "@/modules/identity/authz";

/**
 * Personenbewertung je Setup (Etappe 7B), an MEDDPICC angelehnt: Rolle in der Entscheidung, Haltung zu Verve, Einfluss.
 * Jede Bewertung ist eine Hypothese, bis sie mit Quelle bestätigt wird (E-040). Sichtbar für BD, Principal und den
 * Beziehungshalter (Anker) der Person – nicht pauschal für CEO (analog zur Quellenregel S02).
 */

export type AssessmentRow = typeof schema.personAssessments.$inferSelect;

async function isRelationshipHolder(actor: Actor, personId: string, setupId: string): Promise<boolean> {
  const rel = await db.query.relationships.findFirst({ where: and(eq(schema.relationships.personId, personId), eq(schema.relationships.holderUserId, actor.userId)) });
  return !!rel && (rel.setupId === null || rel.setupId === setupId);
}

/** Wer darf Bewertungen eines Setups sehen: BD/Principal mit Setup-Sicht, Setup-Bearbeitende; Anker nur für Personen, zu denen er die Beziehung hält. */
export async function canViewAssessment(actor: Actor, ctx: SetupContext, personId: string): Promise<boolean> {
  if (!canViewSetup(actor, ctx)) return false;
  if (hasRole(actor, "BD") || hasRole(actor, "PRINCIPAL") || hasRole(actor, "BD", ctx.account.id) || hasRole(actor, "PRINCIPAL", ctx.account.id)) return true;
  if (canEditSetup(actor, ctx) && !hasRole(actor, "CEO")) return true;
  return isRelationshipHolder(actor, personId, ctx.setup.id);
}

export const assessmentInput = z.object({
  personId: z.string().min(1),
  setupId: z.string().min(1),
  decisionRole: z.enum([...schema.decisionRoleEnum.enumValues, ""]).optional().default(""),
  stance: z.enum(schema.stanceEnum.enumValues).default("UNBEKANNT"),
  influence: z.enum(schema.influenceEnum.enumValues).default("UNBEKANNT"),
  note: z.string().trim().max(500).optional().or(z.literal("")),
  /** Quelle, die die Einschätzung stützt – Pflicht beim Bestätigen */
  sourceId: z.string().optional().or(z.literal("")),
  confirm: z.union([z.boolean(), z.enum(["on", "true", "false"])]).optional(),
  version: z.coerce.number().int().positive().optional(),
});

export async function upsertAssessment(actor: Actor, raw: unknown) {
  const parsed = assessmentInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  const ctx = await loadSetupContext(actor, i.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  const holder = await isRelationshipHolder(actor, i.personId, i.setupId);
  if (!canEditSetup(actor, ctx) && !holder) throw new ForbiddenError("Bewertungen pflegen Setup-Bearbeitende oder der Beziehungshalter der Person.");
  const person = await db.query.persons.findFirst({ where: and(eq(schema.persons.id, i.personId), eq(schema.persons.accountId, ctx.account.id)) });
  if (!person) throw new NotFoundError("Person");
  const confirm = i.confirm === true || i.confirm === "on" || i.confirm === "true";
  if (confirm) {
    if (!i.sourceId) throw new ValidationError("Eine Bewertung wird nur mit Quelle bestätigt (Beleg).");
    const src = await db.query.sources.findFirst({ where: and(eq(schema.sources.id, i.sourceId), eq(schema.sources.workspaceId, actor.workspaceId)) });
    if (!src || !canViewSource(actor, src, ctx)) throw new NotFoundError("Quelle");
  }
  return db.transaction(async (tx) => {
    const existing = await tx.query.personAssessments.findFirst({ where: and(eq(schema.personAssessments.personId, i.personId), eq(schema.personAssessments.setupId, i.setupId)) });
    const values = {
      decisionRole: i.decisionRole ? i.decisionRole : null,
      stance: i.stance,
      influence: i.influence,
      epistemicStatus: confirm ? ("SACHVERHALT_BESTAETIGT" as const) : ("HYPOTHESE" as const),
      note: i.note || null,
      sourceId: i.sourceId || null,
      updatedAt: new Date(),
    };
    let row: AssessmentRow | undefined;
    if (existing) {
      const expected = i.version ?? existing.version;
      [row] = await tx
        .update(schema.personAssessments)
        .set({ ...values, version: expected + 1 })
        .where(and(eq(schema.personAssessments.id, existing.id), eq(schema.personAssessments.version, expected)))
        .returning();
      if (!row) throw new ConflictError();
    } else {
      [row] = await tx.insert(schema.personAssessments).values({ workspaceId: actor.workspaceId, personId: i.personId, setupId: i.setupId, createdBy: actor.userId, ...values }).returning();
    }
    if (!row) throw new Error("Bewertung");
    await recordAudit(tx, actor, existing ? "assessment.updated" : "assessment.created", "PERSON_ASSESSMENT", row.id, { personId: i.personId, setupId: i.setupId, decisionRole: values.decisionRole, stance: i.stance, influence: i.influence, status: values.epistemicStatus });
    return row;
  });
}

export const DECISION_ROLES_FOR_COVERAGE = ["BEDARFSTRAEGER", "FACHLICHE_BEWERTUNG", "BUDGETVERANTWORTUNG", "EINKAUF_VERTRAGSWEG"] as const;

/**
 * Buyingcenter eines Setups: Personen mit Funktion, Beziehungsstand (bester Stand über alle Halter), Bewertung,
 * und die Lücken – Entscheidungsrollen ohne Person, Personen ohne Kontakt, kritische Haltungen ohne Gegenüber.
 */
export async function getBuyingCenter(actor: Actor, setupId: string) {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  const people = await db.query.persons.findMany({ where: eq(schema.persons.accountId, ctx.account.id), orderBy: (p, { asc }) => [asc(p.displayName)] });
  const ids = people.map((p) => p.id);
  if (ids.length === 0) return { ctx, rows: [], gaps: coverageGaps([], []), canEdit: canEditSetup(actor, ctx) };
  const [functions, rels, assessments] = await Promise.all([
    db.query.personFunctions.findMany({ where: inArray(schema.personFunctions.personId, ids) }),
    db.query.relationships.findMany({ where: inArray(schema.relationships.personId, ids) }),
    db.query.personAssessments.findMany({ where: and(inArray(schema.personAssessments.personId, ids), eq(schema.personAssessments.setupId, setupId)) }),
  ]);
  const STATE_ORDER = ["NICHT_AKTIV", "NAME_FUNKTION_BEKANNT", "VORSTELLUNG_ANGEFRAGT", "VORGESTELLT", "IM_AUSTAUSCH", "KONKRETE_ZUSAMMENARBEIT"];
  const rows = [];
  for (const p of people) {
    const fn = functions.find((f) => f.personId === p.id && !f.validTo) ?? functions.find((f) => f.personId === p.id) ?? null;
    const myRels = rels.filter((r) => r.personId === p.id && (r.setupId === null || r.setupId === setupId));
    const best = myRels.map((r) => r.state).sort((a, b) => STATE_ORDER.indexOf(b) - STATE_ORDER.indexOf(a))[0] ?? null;
    const a = assessments.find((x) => x.personId === p.id) ?? null;
    const visible = await canViewAssessment(actor, ctx, p.id);
    rows.push({ person: p, functionTitle: fn?.functionTitle ?? null, relationshipState: best, holders: myRels.length, assessment: visible ? a : null, assessmentHidden: !visible && !!a });
  }
  const visibleAssessments = rows.map((r) => r.assessment).filter((x): x is AssessmentRow => !!x);
  return { ctx, rows, gaps: coverageGaps(visibleAssessments, rows.map((r) => ({ relationshipState: r.relationshipState, name: r.person.displayName, assessment: r.assessment }))), canEdit: canEditSetup(actor, ctx) };
}

function coverageGaps(assessments: AssessmentRow[], rows: { relationshipState: string | null; name: string; assessment: AssessmentRow | null }[]) {
  const gaps: string[] = [];
  for (const role of DECISION_ROLES_FOR_COVERAGE) if (!assessments.some((a) => a.decisionRole === role)) gaps.push(`Keine Person mit Rolle „${roleLabel(role)}“ bekannt.`);
  const noContact = rows.filter((r) => r.assessment?.decisionRole && (!r.relationshipState || r.relationshipState === "NAME_FUNKTION_BEKANNT" || r.relationshipState === "NICHT_AKTIV"));
  for (const r of noContact) gaps.push(`${r.name} (${roleLabel(r.assessment!.decisionRole!)}): noch kein Kontakt.`);
  for (const r of rows) if (r.assessment?.stance === "KRITISCH") gaps.push(`${r.name} ist als kritisch eingeschätzt – Gegenposition oder Klärung nötig.`);
  const unconfirmed = assessments.filter((a) => a.epistemicStatus === "HYPOTHESE").length;
  if (unconfirmed > 0) gaps.push(`${unconfirmed} Einschätzung(en) sind Hypothesen ohne bestätigte Quelle.`);
  return gaps;
}

export function roleLabel(role: string): string {
  const m: Record<string, string> = { BEDARFSTRAEGER: "Bedarfsträger", FACHLICHE_BEWERTUNG: "Fachliche Bewertung", BUDGETVERANTWORTUNG: "Budgetverantwortung", EINKAUF_VERTRAGSWEG: "Einkauf / Vertragsweg", ZUSAETZLICHE_FREIGABE: "Zusätzliche Freigabe", UNTERSTUETZER_SPONSOR: "Unterstützer / Sponsor" };
  return m[role] ?? role;
}
