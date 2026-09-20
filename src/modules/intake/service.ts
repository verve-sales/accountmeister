import { createHash } from "node:crypto";
import { and, count, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canCreateAccount } from "@/modules/identity/authz";
import { getAIProvider } from "@/modules/ai";
import { ANALYZE_DOCUMENT_PROMPT_VERSION, type AIProvider, type TaskOptions } from "@/modules/ai/provider";
import { intakeProposalSchema, type IntakeProposal } from "@/modules/ai/schemas";
import { requireTaskOptions } from "@/modules/ai/settings";
import { UsageLimitError } from "@/modules/suggestions/service";
import { attachSourceToSetup, getDocumentForSource, uploadDocument, type UploadedFile } from "@/modules/documents/service";
import { createAccount, listVisibleAccounts } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { createPerson } from "@/modules/people/service";
import { createOpportunity } from "@/modules/opportunities/service";

/**
 * Kundenanlage aus Dokument (Etappe 6B): Dokument hochladen → KI schlägt Organisation, Setup, Personen, Signale und
 * mögliche Bedarfe vor → der BD prüft, ändert, streicht und übernimmt. Ohne KI funktioniert der Weg genauso, nur ohne
 * Vorbefüllung. Es entsteht nichts ohne Bestätigung; alles Erzeugte startet in ungeprüften Zuständen.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[„“"'.,;:!?()\-–]/g, "").trim();

export type IntakePayload = IntakeProposal & { rejected: number; aiStatus: "vorschlag" | "ohne_ki" | "fehler"; aiNote: string };

const emptyProposal = (): IntakeProposal => ({ organization: null, setup: null, persons: [], signals: [], needs: [], openQuestions: [], summary: "", noProposalReason: "" });

export async function startIntake(actor: Actor, raw: unknown, file: UploadedFile | null, deps: { provider?: AIProvider } = {}) {
  if (!canCreateAccount(actor)) throw new ForbiddenError("Nur BD oder Principal legen Kunden an.");
  const upload = await uploadDocument(actor, { ...(raw as Record<string, string>), setupId: "" }, file);
  const source = await db.query.sources.findFirst({ where: eq(schema.sources.id, upload.sourceId) });
  if (!source) throw new NotFoundError("Quelle");

  let payload: IntakePayload = { ...emptyProposal(), rejected: 0, aiStatus: "ohne_ki", aiNote: "" };
  let aiJobId: string | null = null;
  const text = source.body ?? "";
  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  if (!info.enabled || !provider.analyzeDocument) {
    payload.aiNote = info.enabled ? "Der aktive KI-Anbieter unterstützt die Dokumentanalyse nicht." : "KI ist deaktiviert – bitte die Felder von Hand ausfüllen.";
  } else if (text.trim().length < 40) {
    payload.aiNote = upload.extract.note ?? "Das Dokument enthält zu wenig Text für eine Analyse.";
  } else {
    const r = await analyzeWithProvider(actor, provider, { documentText: text, fileName: upload.title, sourceId: source.id });
    payload = { ...r.proposal, rejected: r.rejected, aiStatus: r.aiStatus, aiNote: r.aiNote };
    aiJobId = r.jobId;
  }
  const [proposal] = await db.insert(schema.intakeProposals).values({ workspaceId: actor.workspaceId, actorUserId: actor.userId, sourceId: source.id, aiJobId, payload }).returning();
  if (!proposal) throw new Error("Anlagevorschlag konnte nicht gespeichert werden");
  await recordAudit(db, actor, "intake.started", "INTAKE", proposal.id, { sourceId: source.id, aiStatus: payload.aiStatus, extractStatus: upload.extract.status });
  return proposal;
}

async function analyzeWithProvider(actor: Actor, provider: AIProvider, input: { documentText: string; fileName: string; sourceId: string }) {
  const cfg = getConfig();
  const info = provider.info();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const [cnt] = await db.select({ n: count() }).from(schema.aiJobs).where(and(eq(schema.aiJobs.workspaceId, actor.workspaceId), gte(schema.aiJobs.startedAt, since)));
  if (Number(cnt?.n ?? 0) >= cfg.AI_DAILY_JOB_LIMIT) throw new UsageLimitError(cfg.AI_DAILY_JOB_LIMIT);

  const taskOpts: TaskOptions = info.id === "langdock" ? await requireTaskOptions(actor.workspaceId, "ANALYZE_DOCUMENT") : {};
  const modelLabel = taskOpts.model ?? info.model;
  const knownAccounts = (await listVisibleAccounts(actor)).map((a) => a.name);
  const inputHash = sha(input.documentText);
  const [job] = await db
    .insert(schema.aiJobs)
    .values({ workspaceId: actor.workspaceId, type: "ANALYZE_DOCUMENT", actorUserId: actor.userId, provider: info.id, model: modelLabel, promptVersion: ANALYZE_DOCUMENT_PROMPT_VERSION, inputHash, inputChars: input.documentText.length, dedupeKey: sha(`intake:${input.sourceId}:${inputHash}`) })
    .returning();
  if (!job) throw new Error("KI-Auftrag konnte nicht angelegt werden");

  let raw: unknown;
  try {
    raw = await provider.analyzeDocument!({ documentText: input.documentText, fileName: input.fileName, knownAccountNames: knownAccounts }, taskOpts);
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
  // Quellenprüfung: Jedes Element muss seine Textstelle im Dokument haben; bekannte Kunden nur aus der Liste.
  const norm = normalize(input.documentText);
  const has = (q: string) => input.documentText.includes(q) || norm.includes(normalize(q));
  const p = parsed.data;
  let rejected = 0;
  const keep = <T extends { evidenceQuote: string }>(arr: T[]) => arr.filter((x) => (has(x.evidenceQuote) ? true : (rejected++, false)));
  const proposal: IntakeProposal = {
    ...p,
    organization: p.organization && has(p.organization.evidenceQuote) ? { ...p.organization, possibleExistingAccount: knownAccounts.includes(p.organization.possibleExistingAccount) ? p.organization.possibleExistingAccount : "" } : (p.organization ? (rejected++, null) : null),
    persons: keep(p.persons),
    signals: keep(p.signals),
    needs: keep(p.needs),
  };
  const itemCount = (proposal.organization ? 1 : 0) + proposal.persons.length + proposal.signals.length + proposal.needs.length;
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
  return { proposal, payload: proposal.payload as IntakePayload, source, document, accounts, bds: Array.from(new Map(bds.map((b) => [b.id, b])).values()) };
}

export async function listMyIntakes(actor: Actor) {
  return db.query.intakeProposals.findMany({ where: and(eq(schema.intakeProposals.workspaceId, actor.workspaceId), eq(schema.intakeProposals.actorUserId, actor.userId)), orderBy: desc(schema.intakeProposals.createdAt), limit: 20 });
}

/** Formulardaten der Übernahme: alles editierbar, Listen per Index; Elemente ohne Häkchen werden nicht angelegt. */
export const applyIntakeInput = z.object({
  existingAccountId: z.string().optional().or(z.literal("")),
  orgName: z.string().trim().max(200).optional().or(z.literal("")),
  orgType: z.enum(schema.orgTypeEnum.enumValues).default("SONSTIGE"),
  responsibleBdUserId: z.string().optional().or(z.literal("")),
  setupName: z.string().trim().min(3, "Setup-Name ist zu kurz").max(200),
  contextNote: z.string().trim().max(2000).optional().or(z.literal("")),
  documentAccessClass: z.enum(schema.accessClassEnum.enumValues).default("SETUP"),
  persons: z.array(z.object({ include: z.boolean(), displayName: z.string().trim().max(200), functionTitle: z.string().trim().max(200), email: z.string().trim().max(200), knownResponsibility: z.string().trim().max(500) })).default([]),
  signals: z.array(z.object({ include: z.boolean(), observation: z.string().trim().max(2000), relevanceHypothesis: z.string().trim().max(2000) })).default([]),
  needs: z.array(z.object({ include: z.boolean(), title: z.string().trim().max(200), needDescription: z.string().trim().max(4000) })).default([]),
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
    persons: list("persons", ["displayName", "functionTitle", "email", "knownResponsibility"]),
    signals: list("signals", ["observation", "relevanceHypothesis"]),
    needs: list("needs", ["title", "needDescription"]),
  };
}

export type ApplyResult = { accountId: string; setupId: string; created: { persons: number; signals: number; needs: number }; problems: string[] };

export async function applyIntake(actor: Actor, proposalId: string, raw: unknown): Promise<ApplyResult> {
  const parsed = applyIntakeInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { proposal, source } = await getIntake(actor, proposalId);
  if (proposal.status !== "ENTWURF") throw new TransitionError("Dieser Anlagevorschlag wurde bereits übernommen oder verworfen.");
  if (!source) throw new NotFoundError("Quelle");
  if (!input.existingAccountId && (input.orgName ?? "").length < 2) throw new ValidationError("Bitte einen Kundennamen eingeben oder einen bestehenden Kunden wählen.");

  // 1) Kunde (neu oder bestehend) und Setup – über die geprüften Services, damit alle Rechte- und Rollenregeln gelten
  const bd = input.responsibleBdUserId || actor.userId;
  const accountId = input.existingAccountId || (await createAccount(actor, { name: input.orgName, orgType: input.orgType, responsibleBdUserId: bd })).id;
  const setup = await createSetup(actor, { accountId, name: input.setupName, contextNote: input.contextNote || `Angelegt aus Dokument „${source.title}“.`, bdUserId: bd, creatorContribution: "ANKER_KONTEXT" });

  // 2) Dokument dem Setup zuordnen
  await db.transaction(async (tx) => {
    await attachSourceToSetup(tx, actor, source.id, setup.id, input.documentAccessClass);
  });

  const problems: string[] = [];
  const created = { persons: 0, signals: 0, needs: 0 };
  // 3) Personen mit Beziehung „Name/Funktion bekannt“
  for (const p of input.persons.filter((x) => x.include && x.displayName.length >= 2)) {
    try {
      await createPerson(actor, { accountId, displayName: p.displayName, functionTitle: p.functionTitle, email: p.email, knownResponsibility: p.knownResponsibility, setupId: setup.id, accessClass: "ACCOUNT_TEAM" });
      created.persons++;
    } catch (e) {
      problems.push(`Person „${p.displayName}“: ${e instanceof Error ? e.message : "Fehler"}`);
    }
  }
  // 4) Signale (Status neu) mit dem Dokument als Quelle – ohne zweite Notizquelle
  for (const s of input.signals.filter((x) => x.include && x.observation.length >= 5)) {
    try {
      await db.transaction(async (tx) => {
        const [signal] = await tx
          .insert(schema.signals)
          .values({ workspaceId: actor.workspaceId, setupId: setup.id, observation: s.observation, relevanceHypothesis: s.relevanceHypothesis || null, status: "NEU", sourceId: source.id, createdBy: actor.userId })
          .returning();
        if (!signal) throw new Error("Hinweis");
        const [assertion] = await tx
          .insert(schema.assertions)
          .values({ workspaceId: actor.workspaceId, setupId: setup.id, subjectType: "SETUP", subjectId: setup.id, content: s.observation, epistemicStatus: "AUSSAGE_WIEDERGEGEBEN", createdBy: actor.userId })
          .returning();
        if (assertion) await tx.insert(schema.assertionEvidence).values({ assertionId: assertion.id, sourceId: source.id, excerpt: s.observation.slice(0, 500) });
        await recordAudit(tx, actor, "signal.created", "SIGNAL", signal.id, { setupId: setup.id, ausDokument: true });
      });
      created.signals++;
    } catch (e) {
      problems.push(`Signal: ${e instanceof Error ? e.message : "Fehler"}`);
    }
  }
  // 5) Mögliche Bedarfe (Status identifiziert)
  for (const n of input.needs.filter((x) => x.include && x.title.length >= 3)) {
    try {
      await createOpportunity(actor, { setupId: setup.id, title: n.title, needDescription: n.needDescription.length >= 10 ? n.needDescription : `${n.needDescription} (aus Dokument „${source.title}“)`, trigger: `Dokument „${source.title}“` });
      created.needs++;
    } catch (e) {
      problems.push(`Bedarf „${n.title}“: ${e instanceof Error ? e.message : "Fehler"}`);
    }
  }

  await db.transaction(async (tx) => {
    await tx.update(schema.intakeProposals).set({ status: "UEBERNOMMEN", resultAccountId: accountId, resultSetupId: setup.id, updatedAt: new Date() }).where(eq(schema.intakeProposals.id, proposal.id));
    await recordAudit(tx, actor, "intake.applied", "INTAKE", proposal.id, { accountId, setupId: setup.id, ...created, probleme: problems.length });
  });
  return { accountId, setupId: setup.id, created, problems };
}

export async function discardIntake(actor: Actor, proposalId: string) {
  const { proposal } = await getIntake(actor, proposalId);
  if (proposal.status !== "ENTWURF") throw new TransitionError("Dieser Anlagevorschlag ist bereits abgeschlossen.");
  await db.transaction(async (tx) => {
    await tx.update(schema.intakeProposals).set({ status: "VERWORFEN", updatedAt: new Date() }).where(eq(schema.intakeProposals.id, proposal.id));
    await recordAudit(tx, actor, "intake.discarded", "INTAKE", proposal.id);
  });
}
