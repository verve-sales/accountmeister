import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canEditSetup, canReassignResponsibility, canViewSetup, loadSetupContext } from "@/modules/identity/authz";
import { getAIProvider } from "@/modules/ai";
import type { AIProvider } from "@/modules/ai/provider";
import { evidenceFound, runAiJob } from "@/modules/ai/jobs";
import { buildContextText, resolveContext } from "@/modules/assistant/service";
import { ruleBasedStepDrafts, stepDraftSchema, stepInputToText, type PlaybookStepInput, type StepDrafts } from "./drafts";

export const PLAYBOOK_STEP_PROMPT_VERSION = "playbook-step.v1";

/**
 * Schritt-Assistent (Etappe 20b): Entwürfe für den aktuellen Schritt – mit KI, sonst regelbasiert.
 * Die Entwürfe werden am Schritt gespeichert (neuer Aufruf ersetzt sie), damit das Team sie sieht.
 * Textstellen (basedOn), die sich in den Daten nicht finden, werden verworfen.
 */
export async function proposeStepDrafts(actor: Actor, runStepId: string, deps: { provider?: AIProvider } = {}): Promise<{ drafts: StepDrafts; note: string }> {
  const step = await db.query.playbookRunSteps.findFirst({ where: eq(schema.playbookRunSteps.id, runStepId) });
  if (!step) throw new NotFoundError("Schritt");
  const run = await db.query.playbookRuns.findFirst({ where: and(eq(schema.playbookRuns.id, step.runId), eq(schema.playbookRuns.workspaceId, actor.workspaceId)) });
  if (!run) throw new NotFoundError("Vorgehen");
  const ctx = await loadSetupContext(actor, run.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Vorgehen");
  if (run.ownerUserId !== actor.userId && !canEditSetup(actor, ctx) && !canReassignResponsibility(actor, ctx.account)) throw new ForbiddenError("Sie dürfen an diesem Vorgehen nicht arbeiten.");
  if (run.status !== "AKTIV" || step.status !== "OFFEN") throw new TransitionError("Entwürfe gibt es für den aktuellen Schritt eines laufenden Vorgehens.");

  const [allSteps, persons, opps, signals] = await Promise.all([
    db.query.playbookRunSteps.findMany({ where: eq(schema.playbookRunSteps.runId, run.id), orderBy: [asc(schema.playbookRunSteps.position)] }),
    db.query.persons.findMany({ where: eq(schema.persons.accountId, ctx.account.id), limit: 12 }),
    db.query.opportunities.findMany({ where: and(eq(schema.opportunities.setupId, run.setupId), ne(schema.opportunities.status, "BEENDET")), limit: 5 }),
    db.query.signals.findMany({ where: eq(schema.signals.setupId, run.setupId), orderBy: [desc(schema.signals.createdAt)], limit: 12 }),
  ]);
  const fns = persons.length ? await db.query.personFunctions.findMany({ where: inArray(schema.personFunctions.personId, persons.map((p) => p.id)) }) : [];
  const fnOf = new Map(fns.filter((f) => !f.validTo).map((f) => [f.personId, f.functionTitle]));
  const input: PlaybookStepInput = {
    playbookName: run.playbookName,
    step: { position: step.position, total: allSteps.length, title: step.title, goal: step.goal ?? "", meddpicc: step.meddpicc ?? "", suggestedAction: step.suggestedAction ?? "", doneCriterion: step.doneCriterion ?? "" },
    accountName: ctx.account.name,
    setupName: ctx.setup.name,
    people: persons.map((p) => (fnOf.get(p.id) ? `${p.displayName} (${fnOf.get(p.id)})` : p.displayName)),
    opportunities: opps.map((o) => o.title),
    observations: [ctx.setup.contextNote ?? "", ...signals.map((s) => s.observation)].filter(Boolean),
    previousResults: allSteps.filter((s) => s.position < step.position && (s.result || s.skipReason)).map((s) => `Schritt ${s.position} – ${s.title}: ${s.result ?? `übersprungen (${s.skipReason})`}`),
    contextText: "",
  };
  const res = await resolveContext(actor, { type: "SETUP", id: run.setupId });
  input.contextText = await buildContextText(actor, res);
  const stepText = stepInputToText(input);
  const allowed = `${stepText}\n${input.contextText}`;

  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  let drafts: StepDrafts;
  let note = "";
  let aiJobId: string | null = null;
  if (!info.enabled || !provider.draftPlaybookStep) {
    drafts = ruleBasedStepDrafts(input);
    note = "KI deaktiviert – regelbasierter Entwurf aus Schritt und bekannten Daten.";
  } else {
    const run2 = await runAiJob(
      actor,
      { task: "PLAYBOOK_STEP", setupId: run.setupId, promptVersion: PLAYBOOK_STEP_PROMPT_VERSION, inputText: allowed, dedupeKey: `playbook-step:${step.id}:${Date.now()}`, provider },
      async (p, opts) => {
        const raw = await p.draftPlaybookStep!({ stepText, contextText: input.contextText, structured: input }, opts);
        const parsed = stepDraftSchema.safeParse(raw);
        if (!parsed.success || parsed.data.drafts.length === 0) throw new ValidationError("Die KI-Antwort entsprach nicht dem Schema.");
        let rejected = 0;
        const cleaned = parsed.data.drafts.map((d) => ({ ...d, basedOn: d.basedOn.filter((q) => q && (evidenceFound(allowed, q) ? true : (rejected++, false))) }));
        return { result: { drafts: { ...parsed.data, drafts: cleaned }, rejected }, itemCount: cleaned.length, rejectedCount: rejected };
      },
    ).catch((e: unknown) => {
      // KI nicht erreichbar oder Antwort unbrauchbar: regelbasiert weiterarbeiten statt leer auszugehen
      note = `KI-Entwurf nicht möglich (${e instanceof Error ? e.message.slice(0, 120) : "Fehler"}) – regelbasierter Entwurf.`;
      return null;
    });
    if (run2) {
      drafts = run2.result.drafts;
      aiJobId = run2.jobId;
      note = run2.result.rejected > 0 ? `KI-Entwurf. ${run2.result.rejected} nicht belegbare Textstelle(n) entfernt – Inhalte vor dem Versand prüfen.` : "KI-Entwurf – vor dem Versand prüfen und Platzhalter ergänzen.";
    } else {
      drafts = ruleBasedStepDrafts(input);
    }
  }

  await db.update(schema.playbookRunSteps).set({ drafts, draftsNote: note, draftsAiJobId: aiJobId, draftsAt: new Date() }).where(eq(schema.playbookRunSteps.id, step.id));
  await recordAudit(db, actor, "playbook.step_drafted", "PLAYBOOK_RUN", run.id, { schritt: step.position, mitKI: !!aiJobId, entwuerfe: drafts.drafts.length });
  return { drafts, note };
}
