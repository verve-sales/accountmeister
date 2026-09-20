import { createHash } from "node:crypto";
import { and, count, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canCreateAccount, canEditSetup, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { getAIProvider } from "@/modules/ai";
import { ANALYZE_DOCUMENT_PROMPT_VERSION, type AIProvider, type TaskOptions } from "@/modules/ai/provider";
import { artifactCodeValues, intakeProposalSchema, type IntakeProposal } from "@/modules/ai/schemas";
import { requireTaskOptions } from "@/modules/ai/settings";
import { UsageLimitError } from "@/modules/suggestions/service";
import { attachSourceToSetup, getDocumentForSource, uploadDocument, type UploadedFile } from "@/modules/documents/service";
import { createAccount, listVisibleAccounts } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { createPerson } from "@/modules/people/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { upsertAssessment } from "@/modules/people/assessments";
import { insertSuggestionCard } from "@/modules/assistant/suggestions";

/**
 * Anlagevorschlag (Etappe 6B/7A): aus einem Dokument oder einem Interview schlägt die KI Organisation, Setup, Personen
 * (mit Einschätzung), Signale, Bedarfe, Folgeaktivitäten, Kontaktaufnahmen und Artefakte vor → der BD prüft, ändert,
 * streicht und übernimmt – in einen neuen Kunden oder ein bestehendes Setup. Ohne KI funktioniert der Weg genauso, nur
 * ohne Vorbefüllung. Es entsteht nichts ohne Bestätigung; alles Erzeugte startet in ungeprüften Zuständen.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[„“"'.,;:!?()\-–]/g, "").trim();

export type IntakePayload = IntakeProposal & { rejected: number; aiStatus: "vorschlag" | "ohne_ki" | "fehler"; aiNote: string };

export const emptyProposal = (): IntakeProposal => ({ organization: null, setup: null, persons: [], signals: [], needs: [], openQuestions: [], actions: [], contacts: [], artifacts: [], summary: "", noProposalReason: "" });

/** Dokument hochladen und Anlagevorschlag erzeugen (Kundenanlage aus Dokument). */
export async function startIntake(actor: Actor, raw: unknown, file: UploadedFile | null, deps: { provider?: AIProvider } = {}) {
  if (!canCreateAccount(actor)) throw new ForbiddenError("Nur BD oder Principal legen Kunden an.");
  const upload = await uploadDocument(actor, { ...(raw as Record<string, string>), setupId: "" }, file);
  const source = await db.query.sources.findFirst({ where: eq(schema.sources.id, upload.sourceId) });
  if (!source) throw new NotFoundError("Quelle");
  const payloadInfo = upload.extract.status !== "OK" && (source.body ?? "").trim().length < 40 ? upload.extract.note : null;
  return createProposalFromSource(actor, { source, title: upload.title, kind: "DOKUMENT", targetSetupId: null, interviewId: null, knownContext: "", tooShortNote: payloadInfo ?? undefined }, deps);
}

/**
 * Aus einer Quelle (Dokument oder Interviewtranskript) einen Anlagevorschlag erzeugen. Bei targetSetupId wird kein
 * neuer Kunde vorgeschlagen, sondern das Setup ergänzt.
 */
export async function createProposalFromSource(
  actor: Actor,
  input: { source: typeof schema.sources.$inferSelect; title: string; kind: "DOKUMENT" | "INTERVIEW"; targetSetupId: string | null; interviewId: string | null; knownContext: string; tooShortNote?: string },
  deps: { provider?: AIProvider } = {},
) {
  let payload: IntakePayload = { ...emptyProposal(), rejected: 0, aiStatus: "ohne_ki", aiNote: "" };
  let aiJobId: string | null = null;
  const text = input.source.body ?? "";
  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  if (!info.enabled || !provider.analyzeDocument) {
    payload.aiNote = info.enabled ? "Der aktive KI-Anbieter unterstützt die Auswertung nicht." : "KI ist deaktiviert – bitte die Felder von Hand ausfüllen.";
  } else if (text.trim().length < 40) {
    payload.aiNote = input.tooShortNote ?? "Der Text ist zu kurz für eine Auswertung.";
  } else {
    const r = await analyzeWithProvider(actor, provider, { documentText: text, fileName: input.title, sourceId: input.source.id, knownContext: input.knownContext });
    payload = { ...r.proposal, rejected: r.rejected, aiStatus: r.aiStatus, aiNote: r.aiNote };
    aiJobId = r.jobId;
  }
  const [proposal] = await db
    .insert(schema.intakeProposals)
    .values({ workspaceId: actor.workspaceId, actorUserId: actor.userId, sourceId: input.source.id, aiJobId, payload, kind: input.kind, interviewId: input.interviewId, targetSetupId: input.targetSetupId })
    .returning();
  if (!proposal) throw new Error("Anlagevorschlag konnte nicht gespeichert werden");
  await recordAudit(db, actor, "intake.started", "INTAKE", proposal.id, { sourceId: input.source.id, kind: input.kind, aiStatus: payload.aiStatus, targetSetupId: input.targetSetupId });
  return proposal;
}

async function analyzeWithProvider(actor: Actor, provider: AIProvider, input: { documentText: string; fileName: string; sourceId: string; knownContext: string }) {
  const cfg = getConfig();
  const info = provider.info();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const [cnt] = await db.select({ n: count() }).from(schema.aiJobs).where(and(eq(schema.aiJobs.workspaceId, actor.workspaceId), gte(schema.aiJobs.startedAt, since)));
  if (Number(cnt?.n ?? 0) >= cfg.AI_DAILY_JOB_LIMIT) throw new UsageLimitError(cfg.AI_DAILY_JOB_LIMIT);

  const taskOpts: TaskOptions = info.id === "langdock" ? await requireTaskOptions(actor.workspaceId, "ANALYZE_DOCUMENT") : {};
  const modelLabel = taskOpts.model ?? info.model;
  const knownAccounts = (await listVisibleAccounts(actor)).map((a) => a.name);
  const fullText = input.knownContext ? `${input.documentText}\n\n[Bekannter Kontext]\n${input.knownContext}` : input.documentText;
  const inputHash = sha(fullText);
  const [job] = await db
    .insert(schema.aiJobs)
    .values({ workspaceId: actor.workspaceId, type: "ANALYZE_DOCUMENT", actorUserId: actor.userId, provider: info.id, model: modelLabel, promptVersion: ANALYZE_DOCUMENT_PROMPT_VERSION, inputHash, inputChars: fullText.length, dedupeKey: sha(`intake:${input.sourceId}:${inputHash}`) })
    .returning();
  if (!job) throw new Error("KI-Auftrag konnte nicht angelegt werden");

  let raw: unknown;
  try {
    raw = await provider.analyzeDocument!({ documentText: fullText, fileName: input.fileName, knownAccountNames: knownAccounts }, taskOpts);
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : "Anbieterfehler";
    await db.update(schema.aiJobs).set({ status: "ABGELEHNT", error: msg, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    return { proposal: emptyProposal(), rejected: 0, aiStatus: "fehler" as const, aiNote: `KI-Analyse nicht möglich: ${msg}`, jobId: job.id };
  }
  const usage = provider.lastUsage?.() ?? null;
  const parsed = intakeProposalSchema.safeParse(raw);
  if (!parsed.success) {
    await db.update(schema.aiJobs).set({ status: "FEHLER", error: "Ausgabe entspricht nicht dem Schema", tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    return { proposal: emptyProposal(), rejected: 0, aiStatus: "fehler" as const, aiNote: "Die KI-Ausgabe entsprach nicht dem Ausgabeschema und wurde verworfen. Bitte von Hand ausfüllen oder erneut versuchen.", jobId: job.id };
  }
  // Quellenprüfung: Jedes Element muss seine Textstelle im Text haben; bekannte Kunden nur aus der Liste; Kontaktaufnahmen nur für genannte Personen.
  const norm = normalize(fullText);
  const has = (q: string) => fullText.includes(q) || norm.includes(normalize(q));
  const p = parsed.data;
  let rejected = 0;
  const keep = <T extends { evidenceQuote: string }>(arr: T[]) => arr.filter((x) => (has(x.evidenceQuote) ? true : (rejected++, false)));
  const persons = keep(p.persons);
  const personNames = new Set(persons.map((x) => normalize(x.displayName)));
  const contacts = keep(p.contacts).filter((c) => (personNames.has(normalize(c.personName)) || norm.includes(normalize(c.personName)) ? true : (rejected++, false)));
  const artifacts = p.artifacts.filter((a) => (artifactCodeValues as readonly string[]).includes(a.code)).slice(0, 3);
  const proposal: IntakeProposal = {
    ...p,
    organization: p.organization && has(p.organization.evidenceQuote) ? { ...p.organization, possibleExistingAccount: knownAccounts.includes(p.organization.possibleExistingAccount) ? p.organization.possibleExistingAccount : "" } : (p.organization ? (rejected++, null) : null),
    persons,
    signals: keep(p.signals),
    needs: keep(p.needs),
    actions: keep(p.actions),
    contacts,
    artifacts,
  };
  const itemCount = (proposal.organization ? 1 : 0) + proposal.persons.length + proposal.signals.length + proposal.needs.length + proposal.actions.length + proposal.contacts.length;
  await db.update(schema.aiJobs).set({ status: "ERFOLGREICH", itemCount, rejectedCount: rejected, tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null, model: usage?.model || modelLabel, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
  return { proposal, rejected, aiStatus: "vorschlag" as const, aiNote: rejected > 0 ? `${rejected} Element(e) ohne belegbare Textstelle wurden verworfen.` : "", jobId: job.id };
}

export async function getIntake(actor: Actor, proposalId: string) {
  const proposal = await db.query.intakeProposals.findFirst({ where: and(eq(schema.intakeProposals.id, proposalId), eq(schema.intakeProposals.workspaceId, actor.workspaceId)) });
  if (!proposal || proposal.actorUserId !== actor.userId) throw new NotFoundError("Anlagevorschlag");
  const source = await db.query.sources.findFirst({ where: eq(schema.sources.id, proposal.sourceId) });
  const document = await getDocumentForSource(proposal.sourceId);
  const accounts = await listVisibleAccounts(actor);
  const bds = await db
    .select({ id: schema.users.id, displayName: schema.users.displayName })
    .from(schema.roleAssignments)
    .innerJoin(schema.users, eq(schema.users.id, schema.roleAssignments.userId))
    .where(and(eq(schema.roleAssignments.workspaceId, actor.workspaceId), eq(schema.roleAssignments.role, "BD")));
  let targetCtx: SetupContext | null = null;
  if (proposal.targetSetupId) {
    targetCtx = await loadSetupContext(actor, proposal.targetSetupId);
    if (!targetCtx || !canEditSetup(actor, targetCtx)) throw new NotFoundError("Anlagevorschlag");
  }
  return { proposal, payload: normalizePayload(proposal.payload), source, document, accounts, bds: Array.from(new Map(bds.map((b) => [b.id, b])).values()), targetCtx };
}

/** Ältere Vorschläge (vor Etappe 7) kennen Folgeaktivitäten, Kontaktaufnahmen und Artefakte noch nicht – Listen ergänzen, statt die Seite abstürzen zu lassen. */
export function normalizePayload(raw: unknown): IntakePayload {
  const p = (raw && typeof raw === "object" ? raw : {}) as Partial<IntakePayload>;
  const base = emptyProposal();
  return {
    ...base,
    ...p,
    organization: p.organization ?? null,
    setup: p.setup ?? null,
    persons: Array.isArray(p.persons) ? p.persons : [],
    signals: Array.isArray(p.signals) ? p.signals : [],
    needs: Array.isArray(p.needs) ? p.needs : [],
    openQuestions: Array.isArray(p.openQuestions) ? p.openQuestions : [],
    actions: Array.isArray(p.actions) ? p.actions : [],
    contacts: Array.isArray(p.contacts) ? p.contacts : [],
    artifacts: Array.isArray(p.artifacts) ? p.artifacts : [],
    summary: typeof p.summary === "string" ? p.summary : "",
    noProposalReason: typeof p.noProposalReason === "string" ? p.noProposalReason : "",
    rejected: typeof p.rejected === "number" ? p.rejected : 0,
    aiStatus: p.aiStatus ?? "ohne_ki",
    aiNote: typeof p.aiNote === "string" ? p.aiNote : "",
  } as IntakePayload;
}

export async function listMyIntakes(actor: Actor) {
  return db.query.intakeProposals.findMany({ where: and(eq(schema.intakeProposals.workspaceId, actor.workspaceId), eq(schema.intakeProposals.actorUserId, actor.userId)), orderBy: desc(schema.intakeProposals.createdAt), limit: 20 });
}

const ownerRoleValues = ["BD", "ANKER", "PRINCIPAL"] as const;

/** Formulardaten der Übernahme: alles editierbar, Listen per Index; Elemente ohne Häkchen werden nicht angelegt. */
export const applyIntakeInput = z.object({
  existingAccountId: z.string().optional().or(z.literal("")),
  orgName: z.string().trim().max(200).optional().or(z.literal("")),
  orgType: z.enum(schema.orgTypeEnum.enumValues).default("SONSTIGE"),
  responsibleBdUserId: z.string().optional().or(z.literal("")),
  setupName: z.string().trim().max(200).optional().or(z.literal("")),
  contextNote: z.string().trim().max(2000).optional().or(z.literal("")),
  documentAccessClass: z.enum(schema.accessClassEnum.enumValues).default("SETUP"),
  persons: z
    .array(
      z.object({
        include: z.boolean(),
        displayName: z.string().trim().max(200),
        functionTitle: z.string().trim().max(200),
        email: z.string().trim().max(200),
        knownResponsibility: z.string().trim().max(500),
        decisionRole: z.enum([...schema.decisionRoleEnum.enumValues, ""]).optional().default(""),
        stance: z.enum([...schema.stanceEnum.enumValues, ""]).optional().default("UNBEKANNT").transform((v) => (v === "" ? "UNBEKANNT" : v)),
        influence: z.enum([...schema.influenceEnum.enumValues, ""]).optional().default("UNBEKANNT").transform((v) => (v === "" ? "UNBEKANNT" : v)),
        assessmentNote: z.string().trim().max(500).optional().default(""),
      }),
    )
    .default([]),
  signals: z.array(z.object({ include: z.boolean(), observation: z.string().trim().max(2000), relevanceHypothesis: z.string().trim().max(2000) })).default([]),
  needs: z.array(z.object({ include: z.boolean(), title: z.string().trim().max(200), needDescription: z.string().trim().max(4000), kind: z.preprocess((v) => (v === "" || v === undefined || v === null ? "VERVE_EXPERTE" : v), z.enum(["VERVE_EXPERTE", "FREELANCER_EXPERTE", "AUSSCHREIBUNG"])), roleName: z.string().trim().max(120).default(""), horizon: z.string().trim().max(60).default("") })).default([]),
  actions: z.array(z.object({ include: z.boolean(), title: z.string().trim().max(300), description: z.string().trim().max(2000), ownerRole: z.enum([...ownerRoleValues, ""]).default("BD").transform((v) => (v === "" ? "BD" : v)), dueHint: z.string().trim().max(100) })).default([]),
  contacts: z.array(z.object({ include: z.boolean(), personName: z.string().trim().max(200), viaVerveName: z.string().trim().max(200), occasion: z.string().trim().max(500), draftMessage: z.string().trim().max(1500) })).default([]),
  openQuestions: z.array(z.object({ include: z.boolean(), question: z.string().trim().max(500) })).default([]),
});

export type ApplyIntakeInput = z.infer<typeof applyIntakeInput>;

/** FormData mit indizierten Feldern (persons.0.displayName …) in das Eingabeobjekt überführen. */
export function formToApplyInput(data: Record<string, string>): unknown {
  const list = (prefix: string, fields: string[]) => {
    const idx = new Set<number>();
    for (const k of Object.keys(data)) {
      const m = new RegExp(`^${prefix}\\.(\\d+)\\.`).exec(k);
      if (m) idx.add(Number(m[1]));
    }
    return Array.from(idx)
      .sort((a, b) => a - b)
      .map((i) => {
        const o: Record<string, string | boolean> = { include: data[`${prefix}.${i}.include`] === "on" };
        for (const f of fields) o[f] = data[`${prefix}.${i}.${f}`] ?? "";
        return o;
      });
  };
  return {
    ...data,
    persons: list("persons", ["displayName", "functionTitle", "email", "knownResponsibility", "decisionRole", "stance", "influence", "assessmentNote"]),
    signals: list("signals", ["observation", "relevanceHypothesis"]),
    needs: list("needs", ["title", "needDescription", "kind", "roleName", "horizon"]),
    actions: list("actions", ["title", "description", "ownerRole", "dueHint"]),
    contacts: list("contacts", ["personName", "viaVerveName", "occasion", "draftMessage"]),
    openQuestions: list("openQuestions", ["question"]),
  };
}

export type ApplyResult = { accountId: string; setupId: string; created: { persons: number; signals: number; needs: number; actions: number; contacts: number; questions: number; assessments: number }; problems: string[] };

export async function applyIntake(actor: Actor, proposalId: string, raw: unknown): Promise<ApplyResult> {
  const parsed = applyIntakeInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { proposal, source, targetCtx } = await getIntake(actor, proposalId);
  if (proposal.status !== "ENTWURF") throw new TransitionError("Dieser Anlagevorschlag wurde bereits übernommen oder verworfen.");
  if (!source) throw new NotFoundError("Quelle");
  const originLabel = proposal.kind === "INTERVIEW" ? `Interview „${source.title}“` : `Dokument „${source.title}“`;

  let accountId: string;
  let setupId: string;
  if (targetCtx) {
    // Ergänzung eines bestehenden Setups: kein neuer Kunde, kein neues Setup
    accountId = targetCtx.account.id;
    setupId = targetCtx.setup.id;
    if (!source.setupId) await db.transaction(async (tx) => attachSourceToSetup(tx, actor, source.id, setupId, input.documentAccessClass));
  } else {
    if (!input.existingAccountId && (input.orgName ?? "").length < 2) throw new ValidationError("Bitte einen Kundennamen eingeben oder einen bestehenden Kunden wählen.");
    if ((input.setupName ?? "").length < 3) throw new ValidationError("Setup-Name ist zu kurz.");
    // 1) Kunde (neu oder bestehend) und Setup – über die geprüften Services, damit alle Rechte- und Rollenregeln gelten
    const bd = input.responsibleBdUserId || actor.userId;
    accountId = input.existingAccountId || (await createAccount(actor, { name: input.orgName, orgType: input.orgType, responsibleBdUserId: bd })).id;
    const setup = await createSetup(actor, { accountId, name: input.setupName, contextNote: input.contextNote || `Angelegt aus ${originLabel}.`, bdUserId: bd, creatorContribution: "ANKER_KONTEXT" });
    setupId = setup.id;
    // 2) Quelle dem Setup zuordnen
    await db.transaction(async (tx) => attachSourceToSetup(tx, actor, source.id, setupId, input.documentAccessClass));
  }

  const problems: string[] = [];
  const created = { persons: 0, signals: 0, needs: 0, actions: 0, contacts: 0, questions: 0, assessments: 0 };
  // 3) Personen mit Beziehung „Name/Funktion bekannt“ und optionaler Einschätzung (Hypothese, mit Quelle)
  for (const p of input.persons.filter((x) => x.include && x.displayName.length >= 2)) {
    try {
      const person = await createPerson(actor, { accountId, displayName: p.displayName, functionTitle: p.functionTitle, email: p.email, knownResponsibility: p.knownResponsibility, setupId, accessClass: "ACCOUNT_TEAM" });
      created.persons++;
      if (p.decisionRole || p.stance !== "UNBEKANNT" || p.influence !== "UNBEKANNT") {
        await upsertAssessment(actor, { personId: person.id, setupId, decisionRole: p.decisionRole || "", stance: p.stance, influence: p.influence, note: p.assessmentNote, sourceId: source.id, confirm: false });
        created.assessments++;
      }
    } catch (e) {
      problems.push(`Person „${p.displayName}“: ${e instanceof Error ? e.message : "Fehler"}`);
    }
  }
  // 4) Signale (Status neu) mit der Quelle – ohne zweite Notizquelle
  for (const s of input.signals.filter((x) => x.include && x.observation.length >= 5)) {
    try {
      await db.transaction(async (tx) => {
        const [signal] = await tx
          .insert(schema.signals)
          .values({ workspaceId: actor.workspaceId, setupId, observation: s.observation, relevanceHypothesis: s.relevanceHypothesis || null, status: "NEU", sourceId: source.id, createdBy: actor.userId })
          .returning();
        if (!signal) throw new Error("Hinweis");
        const [assertion] = await tx
          .insert(schema.assertions)
          .values({ workspaceId: actor.workspaceId, setupId, subjectType: "SETUP", subjectId: setupId, content: s.observation, epistemicStatus: "AUSSAGE_WIEDERGEGEBEN", createdBy: actor.userId })
          .returning();
        if (assertion) await tx.insert(schema.assertionEvidence).values({ assertionId: assertion.id, sourceId: source.id, excerpt: s.observation.slice(0, 500) });
        await recordAudit(tx, actor, "signal.created", "SIGNAL", signal.id, { setupId, herkunft: proposal.kind });
      });
      created.signals++;
    } catch (e) {
      problems.push(`Signal: ${e instanceof Error ? e.message : "Fehler"}`);
    }
  }
  // 5) Mögliche Bedarfe (Status in Klärung)
  for (const n of input.needs.filter((x) => x.include && x.title.length >= 3)) {
    try {
      await createOpportunity(actor, { setupId, title: n.title, needDescription: n.needDescription.length >= 10 ? n.needDescription : `${n.needDescription} (aus ${originLabel})`, trigger: originLabel, kind: n.kind, roleName: n.roleName, horizon: n.horizon, anticipated: true });
      created.needs++;
    } catch (e) {
      problems.push(`Bedarf „${n.title}“: ${e instanceof Error ? e.message : "Fehler"}`);
    }
  }
  // 6) Folgeaktivitäten, Kontaktaufnahmen und offene Fragen als Vorschläge – landen bei der adressierten Rolle in „Meine Arbeit“
  const quoteOf = <T extends { evidenceQuote: string }>(needle: string, arr: T[], match: (x: T) => boolean) => arr.find(match)?.evidenceQuote ?? needle.slice(0, 200);
  const payload = normalizePayload(proposal.payload);
  await db.transaction(async (tx) => {
    for (const a of input.actions.filter((x) => x.include && x.title.length >= 3)) {
      const ev = quoteOf(a.title, payload.actions, (x) => x.title === a.title);
      await insertSuggestionCard(tx, actor, setupId, source.id, originLabel, { type: "AKTION", title: a.title.slice(0, 200), targetRole: a.ownerRole, observation: a.description || a.title, evidenceQuote: ev, nextStep: a.title, whyNow: a.dueHint ? `Frist/Hinweis: ${a.dueHint}` : "", uncertainty: "Vorschlag aus der Auswertung – erst die Annahme macht daraus eine Aufgabe.", priority: "KONKRETE_ANFRAGE" });
      created.actions++;
    }
    for (const c of input.contacts.filter((x) => x.include && x.personName.length >= 2)) {
      const ev = quoteOf(c.occasion, payload.contacts, (x) => x.personName === c.personName);
      await insertSuggestionCard(tx, actor, setupId, source.id, originLabel, { type: "KONTAKTAUFNAHME", title: `Kontaktaufnahme ${c.personName}`.slice(0, 200), targetRole: "ANKER", observation: c.occasion, evidenceQuote: ev, hypothesis: c.viaVerveName ? `Möglicher Weg: über ${c.viaVerveName}` : "", nextStep: c.draftMessage, mentionedPersonName: c.personName, uncertainty: "Entwurf zum Bearbeiten – wird nie automatisch versendet.", priority: "ZUGANGSLUECKE" });
      created.contacts++;
    }
    for (const q of input.openQuestions.filter((x) => x.include && x.question.length >= 3)) {
      await insertSuggestionCard(tx, actor, setupId, source.id, originLabel, { type: "OFFENE_FRAGE", title: q.question.slice(0, 200), targetRole: "BD", observation: q.question, evidenceQuote: q.question.slice(0, 200), proposedQuestion: q.question, uncertainty: "Vor der Bestätigung zu klären.", priority: "NEUE_INFORMATION" });
      created.questions++;
    }
    await tx.update(schema.intakeProposals).set({ status: "UEBERNOMMEN", resultAccountId: accountId, resultSetupId: setupId, updatedAt: new Date() }).where(eq(schema.intakeProposals.id, proposal.id));
    await recordAudit(tx, actor, "intake.applied", "INTAKE", proposal.id, { accountId, setupId, ...created, probleme: problems.length, kind: proposal.kind });
  });
  return { accountId, setupId, created, problems };
}

export async function discardIntake(actor: Actor, proposalId: string) {
  const { proposal } = await getIntake(actor, proposalId);
  if (proposal.status !== "ENTWURF") throw new TransitionError("Dieser Anlagevorschlag ist bereits abgeschlossen.");
  await db.transaction(async (tx) => {
    await tx.update(schema.intakeProposals).set({ status: "VERWORFEN", updatedAt: new Date() }).where(eq(schema.intakeProposals.id, proposal.id));
    await recordAudit(tx, actor, "intake.discarded", "INTAKE", proposal.id);
  });
}
