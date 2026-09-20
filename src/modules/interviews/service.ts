import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canCreateAccount, canEditSetup, canViewSetup, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { getAIProvider } from "@/modules/ai";
import { INTERVIEW_NEXT_PROMPT_VERSION, type AIProvider, type InterviewNextInput, type TaskOptions } from "@/modules/ai/provider";
import { interviewNextSchema, interviewTopicValues, type InterviewNext, type InterviewTopic } from "@/modules/ai/schemas";
import { requireTaskOptions } from "@/modules/ai/settings";
import { UsageLimitError } from "@/modules/suggestions/service";
import { createProposalFromSource } from "@/modules/intake/service";

/**
 * Geführtes Interview (Etappe 7A): Die KI stellt die jeweils nächste Frage, abgeleitet aus dem, was noch fehlt; der
 * BD antwortet in Text (auch per Diktierfunktion). Der Verlauf wird beim Abschluss zur Quelle vom Typ INTERVIEW und
 * durch dieselbe Auswertung wie ein Dokument in einen Anlagevorschlag überführt. Ohne KI stellt die Anwendung eine
 * feste Fragenfolge – das Interview funktioniert immer.
 */

const MAX_QUESTIONS = 14;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const FALLBACK_QUESTIONS: Record<InterviewTopic, string> = {
  ORGANISATION: "Um welche Organisation geht es – bitte mit Rechtsform, und gehört sie zu einem Konzern?",
  ANLASS_KONTEXT: "Was ist der Anlass, dass ihr jetzt im Gespräch seid, und woran arbeitet der Kunde gerade?",
  PERSONEN_ROLLEN: "Mit wem hast du gesprochen – Name, Funktion und wofür die Person zuständig ist?",
  ENTSCHEIDUNGSWEG: "Wer entscheidet dort über eine Beauftragung, und wer bewertet fachlich oder muss freigeben?",
  BEDARF: "Was will der Kunde erreichen, in seinen Worten – und woran macht er fest, dass ihm etwas fehlt?",
  ZEIT_BUDGET: "Welche Termine wurden genannt, und wie ist der Stand beim Budget?",
  WETTBEWERB_BESTAND: "Wer arbeitet dort bisher, und welche Alternativen zu Verve sind im Spiel?",
  BEZIEHUNGEN_ZUGANG: "Wer bei Verve kennt jemanden dort, und zu wem besteht noch kein Kontakt?",
  NAECHSTE_SCHRITTE: "Was wurde konkret zugesagt oder vereinbart, und was ist noch zu klären?",
};

export const startInterviewInput = z.object({
  kind: z.enum(schema.interviewKindEnum.enumValues),
  setupId: z.string().optional().or(z.literal("")),
  title: z.string().trim().max(200).optional().or(z.literal("")),
});

export async function startInterview(actor: Actor, raw: unknown, deps: { provider?: AIProvider } = {}) {
  const parsed = startInterviewInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  let ctx: SetupContext | null = null;
  if (i.kind === "SETUP_ERGAENZUNG") {
    if (!i.setupId) throw new ValidationError("Für eine Setup-Ergänzung fehlt das Setup.");
    ctx = await loadSetupContext(actor, i.setupId);
    if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
    if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Nur Setup-Bearbeitende führen ein Interview zu diesem Setup.");
  } else if (!canCreateAccount(actor)) {
    throw new ForbiddenError("Nur BD oder Principal legen Kunden an.");
  }
  const title = i.title || (ctx ? `Interview ${ctx.setup.name} ${new Date().toLocaleDateString("de-DE")}` : `Interview neuer Kunde ${new Date().toLocaleDateString("de-DE")}`);
  const [interview] = await db.insert(schema.interviews).values({ workspaceId: actor.workspaceId, actorUserId: actor.userId, kind: i.kind, setupId: ctx?.setup.id ?? null, title }).returning();
  if (!interview) throw new Error("Interview konnte nicht angelegt werden");
  await recordAudit(db, actor, "interview.started", "INTERVIEW", interview.id, { kind: i.kind, setupId: ctx?.setup.id ?? null });
  await askNext(actor, interview.id, deps);
  return interview;
}

async function requireInterview(actor: Actor, id: string) {
  const interview = await db.query.interviews.findFirst({ where: and(eq(schema.interviews.id, id), eq(schema.interviews.workspaceId, actor.workspaceId)) });
  if (!interview || interview.actorUserId !== actor.userId) throw new NotFoundError("Interview");
  return interview;
}

export async function getInterview(actor: Actor, id: string) {
  const interview = await requireInterview(actor, id);
  const turns = await db.query.interviewTurns.findMany({ where: eq(schema.interviewTurns.interviewId, id), orderBy: asc(schema.interviewTurns.seq) });
  const ctx = interview.setupId ? await loadSetupContext(actor, interview.setupId) : null;
  const coverage = (interview.coverage ?? {}) as Record<string, boolean>;
  return { interview, turns, ctx, coverage, topics: interviewTopicValues.map((t) => ({ key: t, covered: !!coverage[t] })), maxQuestions: MAX_QUESTIONS };
}

export async function listMyInterviews(actor: Actor) {
  return db.query.interviews.findMany({ where: and(eq(schema.interviews.workspaceId, actor.workspaceId), eq(schema.interviews.actorUserId, actor.userId)), orderBy: desc(schema.interviews.createdAt), limit: 20 });
}

/** Berechtigter Kontext als Text: nur, was der Akteur im Setup ohnehin sieht (Namen, Funktionen, offene Bedarfe). */
async function buildKnownContext(actor: Actor, interview: typeof schema.interviews.$inferSelect): Promise<string> {
  if (!interview.setupId) return "";
  const ctx = await loadSetupContext(actor, interview.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) return "";
  const [persons, fns, opps] = await Promise.all([
    db.query.persons.findMany({ where: eq(schema.persons.accountId, ctx.account.id) }),
    db.query.personFunctions.findMany({}),
    db.query.opportunities.findMany({ where: eq(schema.opportunities.setupId, ctx.setup.id) }),
  ]);
  const lines = [`Kunde: ${ctx.account.name}`, `Setup: ${ctx.setup.name}${ctx.setup.contextNote ? ` – ${ctx.setup.contextNote}` : ""}`];
  if (persons.length) lines.push(`Bekannte Personen: ${persons.map((p) => `${p.displayName}${fns.find((f) => f.personId === p.id && !f.validTo)?.functionTitle ? ` (${fns.find((f) => f.personId === p.id && !f.validTo)!.functionTitle})` : ""}`).join("; ")}`);
  if (opps.length) lines.push(`Bedarfe: ${opps.map((o) => `${o.title} [${o.status}]`).join("; ")}`);
  return lines.join("\n");
}

function fallbackNext(transcript: { role: "KI" | "NUTZER"; text: string }[], knownContext: string, questionCount: number): InterviewNext {
  const covered: InterviewTopic[] = [];
  transcript.forEach((t, i) => {
    if (t.role !== "KI") return;
    const k = interviewTopicValues.find((x) => FALLBACK_QUESTIONS[x] === t.text);
    if (k && transcript[i + 1]?.role === "NUTZER" && !covered.includes(k)) covered.push(k);
  });
  const last = transcript[transcript.length - 1];
  if (last?.role === "NUTZER" && /^(fertig|das war.?s|mehr weiß ich nicht|ende)\.?$/i.test(last.text.trim())) return { question: "", rationale: "", topic: null, covered: [...interviewTopicValues], done: true };
  const next = interviewTopicValues.find((k) => !covered.includes(k) && !(k === "ORGANISATION" && knownContext.includes("Kunde:")));
  if (!next || questionCount >= MAX_QUESTIONS) return { question: "", rationale: "", topic: null, covered, done: true };
  return { question: FALLBACK_QUESTIONS[next], rationale: "Feste Fragenfolge (ohne KI).", topic: next, covered, done: false };
}

/** Nächste Frage stellen (KI oder feste Folge) und als KI-Beitrag speichern; setzt Abdeckung und ggf. Abschlussreife. */
async function askNext(actor: Actor, interviewId: string, deps: { provider?: AIProvider } = {}): Promise<{ done: boolean }> {
  const interview = await requireInterview(actor, interviewId);
  if (interview.status !== "LAUFEND") throw new TransitionError("Das Interview ist abgeschlossen.");
  const turns = await db.query.interviewTurns.findMany({ where: eq(schema.interviewTurns.interviewId, interviewId), orderBy: asc(schema.interviewTurns.seq) });
  const transcript = turns.map((t) => ({ role: t.role as "KI" | "NUTZER", text: t.text }));
  const knownContext = await buildKnownContext(actor, interview);
  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  let next: InterviewNext;
  let aiJobId: string | null = null;
  if (info.enabled && provider.interviewNext) {
    const cfg = getConfig();
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const [cnt] = await db.select({ n: count() }).from(schema.aiJobs).where(and(eq(schema.aiJobs.workspaceId, actor.workspaceId), gte(schema.aiJobs.startedAt, since)));
    if (Number(cnt?.n ?? 0) >= cfg.AI_DAILY_JOB_LIMIT) throw new UsageLimitError(cfg.AI_DAILY_JOB_LIMIT);
    const taskOpts: TaskOptions = info.id === "langdock" ? await requireTaskOptions(actor.workspaceId, "INTERVIEW_NEXT") : {};
    const input: InterviewNextInput = { kind: interview.kind, knownContext, transcript, questionCount: interview.questionCount, maxQuestions: MAX_QUESTIONS };
    const inputText = JSON.stringify(input);
    const [job] = await db
      .insert(schema.aiJobs)
      .values({ workspaceId: actor.workspaceId, type: "INTERVIEW_NEXT", actorUserId: actor.userId, setupId: interview.setupId, provider: info.id, model: taskOpts.model ?? info.model, promptVersion: INTERVIEW_NEXT_PROMPT_VERSION, inputHash: sha(inputText), inputChars: inputText.length, dedupeKey: sha(`interview:${interviewId}:${turns.length}`) })
      .returning();
    aiJobId = job?.id ?? null;
    try {
      const raw = await provider.interviewNext(input, taskOpts);
      const parsed = interviewNextSchema.safeParse(raw);
      if (!parsed.success) throw new ValidationError("Antwort entspricht nicht dem Schema");
      next = parsed.data;
      const usage = provider.lastUsage?.() ?? null;
      if (job) await db.update(schema.aiJobs).set({ status: "ERFOLGREICH", itemCount: next.done ? 0 : 1, tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null, model: usage?.model || job.model, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    } catch (e) {
      // KI nicht verfügbar: feste Fragenfolge, das Interview läuft weiter (17.5)
      if (job) await db.update(schema.aiJobs).set({ status: "ABGELEHNT", error: (e instanceof Error ? e.message : "Anbieterfehler").slice(0, 300), finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
      next = fallbackNext(transcript, knownContext, interview.questionCount);
      const reason = (e instanceof Error ? e.message : "Anbieterfehler").slice(0, 160);
      next.rationale = `KI nicht verfügbar (${reason}) – feste Fragenfolge.`;
    }
  } else {
    next = fallbackNext(transcript, knownContext, interview.questionCount);
  }
  if (!next.done && !next.question.trim()) next = { ...next, done: true };
  if (!next.done && interview.questionCount >= MAX_QUESTIONS) next = { ...next, done: true, question: "" };
  const coverage = { ...((interview.coverage ?? {}) as Record<string, boolean>) };
  for (const k of next.covered) coverage[k] = true;
  await db.transaction(async (tx) => {
    if (!next.done) {
      await tx.insert(schema.interviewTurns).values({ interviewId, seq: turns.length + 1, role: "KI", text: next.question.trim(), rationale: next.rationale || null, aiJobId });
    }
    await tx.update(schema.interviews).set({ coverage, questionCount: interview.questionCount + (next.done ? 0 : 1), updatedAt: new Date() }).where(eq(schema.interviews.id, interviewId));
  });
  return { done: next.done };
}

export const answerInput = z.object({ interviewId: z.string().min(1), text: z.string().trim().min(1, "Bitte eine Antwort eingeben.").max(6000) });

/** Antwort speichern und nächste Frage holen. Rückgabe: ob das Interview abschlussreif ist. */
export async function answerInterview(actor: Actor, raw: unknown, deps: { provider?: AIProvider } = {}) {
  const parsed = answerInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const { interviewId, text } = parsed.data;
  const interview = await requireInterview(actor, interviewId);
  if (interview.status !== "LAUFEND") throw new TransitionError("Das Interview ist abgeschlossen.");
  const turns = await db.query.interviewTurns.findMany({ where: eq(schema.interviewTurns.interviewId, interviewId), orderBy: asc(schema.interviewTurns.seq) });
  const last = turns[turns.length - 1];
  if (!last || last.role !== "KI") throw new TransitionError("Es gibt gerade keine offene Frage.");
  await db.insert(schema.interviewTurns).values({ interviewId, seq: turns.length + 1, role: "NUTZER", text });
  return askNext(actor, interviewId, deps);
}

/** Interview abschließen: Verlauf → Quelle INTERVIEW → Anlagevorschlag (Ergänzung oder Neuanlage). */
export async function finishInterview(actor: Actor, interviewId: string, deps: { provider?: AIProvider } = {}) {
  const interview = await requireInterview(actor, interviewId);
  if (interview.status !== "LAUFEND") throw new TransitionError("Das Interview ist bereits abgeschlossen.");
  const turns = await db.query.interviewTurns.findMany({ where: eq(schema.interviewTurns.interviewId, interviewId), orderBy: asc(schema.interviewTurns.seq) });
  const answers = turns.filter((t) => t.role === "NUTZER");
  if (answers.length === 0) throw new ValidationError("Noch keine Antwort – bitte mindestens eine Frage beantworten oder das Interview verwerfen.");
  const transcript = turns.map((t) => `${t.role === "KI" ? "Frage" : "Antwort"}: ${t.text}`).join("\n\n");
  const setupId = interview.setupId;
  const source = await db.transaction(async (tx) => {
    const [src] = await tx
      .insert(schema.sources)
      .values({
        workspaceId: actor.workspaceId,
        setupId,
        type: "INTERVIEW",
        title: interview.title,
        body: transcript,
        origin: "Interview",
        sourceTime: new Date(),
        ownerUserId: actor.userId,
        accessClass: setupId ? "SETUP" : "PERSOENLICH",
      })
      .returning();
    if (!src) throw new Error("Quelle");
    await tx.insert(schema.sourceVersions).values({ sourceId: src.id, versionNo: 1, body: transcript, contentHash: sha(transcript) });
    await recordAudit(tx, actor, "interview.finished", "INTERVIEW", interviewId, { sourceId: src.id, fragen: turns.filter((t) => t.role === "KI").length, antworten: answers.length });
    return src;
  });
  const knownContext = await buildKnownContext(actor, interview);
  const proposal = await createProposalFromSource(actor, { source, title: interview.title, kind: "INTERVIEW", targetSetupId: setupId, interviewId, knownContext }, deps);
  await db.update(schema.interviews).set({ status: "ABGESCHLOSSEN", sourceId: source.id, proposalId: proposal.id, updatedAt: new Date() }).where(eq(schema.interviews.id, interviewId));
  return { interview, source, proposal };
}

export async function discardInterview(actor: Actor, interviewId: string) {
  const interview = await requireInterview(actor, interviewId);
  if (interview.status !== "LAUFEND") throw new TransitionError("Das Interview ist bereits abgeschlossen.");
  await db.transaction(async (tx) => {
    await tx.update(schema.interviews).set({ status: "VERWORFEN", updatedAt: new Date() }).where(eq(schema.interviews.id, interviewId));
    await recordAudit(tx, actor, "interview.discarded", "INTERVIEW", interviewId);
  });
}
