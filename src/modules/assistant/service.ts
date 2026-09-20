import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { canCreateAccount, canCreateSetup, canEditSetup, canViewSetup, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { getAIProvider } from "@/modules/ai";
import { ASSISTANT_PROMPT_VERSION, type AIProvider, type AssistantInput, type TaskOptions } from "@/modules/ai/provider";
import { ASSISTANT_CARDS_MARKER, assistantOutputSchema, interviewTopicLabel, interviewTopicValues, type AssistantCard, type AssistantItem } from "@/modules/ai/schemas";
import { requireTaskOptions } from "@/modules/ai/settings";
import { parseJsonLoose } from "@/modules/ai/providers/langdock";
import { UsageLimitError } from "@/modules/suggestions/service";
import { getAccount, createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { createPerson } from "@/modules/people/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { upsertAssessment, getBuyingCenter } from "@/modules/people/assessments";
import { insertSuggestionCard } from "./suggestions";

/**
 * Assistent (Etappe 8, E-041): ein Dialog je Nutzer und Kontext (allgemein, Kunde, Setup). Der Assistent antwortet
 * in Prosa, legt Vorschlagskarten daneben (Personen, Signale, Bedarfe, Aktionen, Kontaktaufnahmen, Fragen, Kunde,
 * Setup) und benennt, was ihm für weitere Vorschläge fehlt. Er sieht nur, was die Person sieht; er schreibt nichts
 * ohne Klick; jede Karte braucht eine Textstelle aus dem Dialog oder dem Kontext. Der Dialog wird bei der ersten
 * Übernahme zur Quelle (Typ INTERVIEW) und bleibt als Beleg erhalten.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[„“"'.,;:!?()\-–]/g, "").trim();

export type AssistantContextRef = { type: "GLOBAL" | "ACCOUNT" | "SETUP"; id: string | null };

export const contextInput = z.object({ type: z.enum(["GLOBAL", "ACCOUNT", "SETUP"]).default("GLOBAL"), id: z.string().optional().or(z.literal("")) });

type Resolved = { ref: AssistantContextRef; ctx: SetupContext | null; account: typeof schema.accounts.$inferSelect | null; canWrite: boolean };

/** Kontext auflösen und Rechte prüfen. Ungültige oder unsichtbare Kontexte fallen auf „allgemein“ zurück. */
export async function resolveContext(actor: Actor, raw: unknown): Promise<Resolved> {
  const parsed = contextInput.safeParse(raw);
  const c = parsed.success ? parsed.data : { type: "GLOBAL" as const, id: "" };
  if (c.type === "SETUP" && c.id) {
    const ctx = await loadSetupContext(actor, c.id);
    if (ctx && canViewSetup(actor, ctx)) return { ref: { type: "SETUP", id: ctx.setup.id }, ctx, account: ctx.account, canWrite: canEditSetup(actor, ctx) };
  }
  if (c.type === "ACCOUNT" && c.id) {
    try {
      const account = await getAccount(actor, c.id);
      return { ref: { type: "ACCOUNT", id: account.id }, ctx: null, account, canWrite: canCreateSetup(actor, account) };
    } catch {
      /* unten */
    }
  }
  return { ref: { type: "GLOBAL", id: null }, ctx: null, account: null, canWrite: canCreateAccount(actor) };
}

export async function getOrCreateThread(actor: Actor, ref: AssistantContextRef) {
  const existing = await db.query.assistantThreads.findFirst({
    where: and(eq(schema.assistantThreads.userId, actor.userId), eq(schema.assistantThreads.contextType, ref.type), ref.id ? eq(schema.assistantThreads.contextId, ref.id) : isNull(schema.assistantThreads.contextId), isNull(schema.assistantThreads.archivedAt)),
    orderBy: desc(schema.assistantThreads.createdAt),
  });
  if (existing) return existing;
  const title = ref.type === "GLOBAL" ? "Assistent" : ref.type === "ACCOUNT" ? "Assistent · Kunde" : "Assistent · Setup";
  const [t] = await db.insert(schema.assistantThreads).values({ workspaceId: actor.workspaceId, userId: actor.userId, contextType: ref.type, contextId: ref.id, title }).returning();
  if (!t) throw new Error("Gesprächsfaden");
  return t;
}

async function requireThread(actor: Actor, threadId: string) {
  const t = await db.query.assistantThreads.findFirst({ where: and(eq(schema.assistantThreads.id, threadId), eq(schema.assistantThreads.workspaceId, actor.workspaceId)) });
  if (!t || t.userId !== actor.userId) throw new NotFoundError("Gespräch");
  return t;
}

export type OpenPoint = { kind: string; text: string; href: string | null };

/**
 * Offene Punkte – deterministisch aus den Daten, ohne KI: adressierte Vorschläge, überfällige Aktionen, Lücken im
 * Buyingcenter, offene Fragen, Stillstand. Je Kontext gefiltert; Rechte über die bestehenden Regeln.
 */
export async function computeOpenPoints(actor: Actor, res: Resolved): Promise<OpenPoint[]> {
  const points: OpenPoint[] = [];
  const setupIds: string[] = [];
  if (res.ref.type === "SETUP" && res.ctx) setupIds.push(res.ctx.setup.id);
  else if (res.ref.type === "ACCOUNT" && res.account) {
    const setups = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, res.account.id) });
    for (const s of setups) {
      const c = await loadSetupContext(actor, s.id);
      if (c && canViewSetup(actor, c)) setupIds.push(s.id);
    }
  } else {
    const memberships = await db.query.setupMemberships.findMany({ where: eq(schema.setupMemberships.userId, actor.userId) });
    setupIds.push(...memberships.map((m) => m.setupId));
  }
  const setupName = new Map<string, string>();
  if (setupIds.length) for (const s of await db.query.projectSetups.findMany({ where: inArray(schema.projectSetups.id, setupIds) })) setupName.set(s.id, s.name);
  const tag = (sid: string | null) => (res.ref.type === "SETUP" || !sid ? "" : ` (${setupName.get(sid) ?? "Setup"})`);

  if (setupIds.length) {
    // Adressierte / offene Vorschläge
    const sugg = await db.query.suggestions.findMany({ where: and(inArray(schema.suggestions.setupId, setupIds), or(eq(schema.suggestions.status, "NEU"), eq(schema.suggestions.status, "GEPRUEFT"))), orderBy: desc(schema.suggestions.computedAt), limit: 30 });
    const mine = sugg.filter((s) => s.proposedOwnerUserId === actor.userId);
    for (const s of mine.slice(0, 3)) points.push({ kind: "VORSCHLAG", text: `An dich adressierter Vorschlag: ${s.title}${tag(s.setupId)}`, href: `/setups/${s.setupId}` });
    const others = sugg.length - mine.length;
    if (others > 0) points.push({ kind: "VORSCHLAG", text: `${others} offene Vorschläge warten auf Entscheidung${setupIds.length === 1 ? "" : " in deinen Setups"}.`, href: res.ref.type === "SETUP" ? `/setups/${setupIds[0]}` : "/meine-arbeit" });
    // Überfällige Aktionen des Akteurs
    const today = new Date().toISOString().slice(0, 10);
    const overdue = await db.query.actions.findMany({ where: and(inArray(schema.actions.setupId, setupIds), eq(schema.actions.ownerUserId, actor.userId), lt(schema.actions.dueDate, today), inArray(schema.actions.status, ["VORGESCHLAGEN", "ANGENOMMEN", "IN_ARBEIT"])), limit: 5 });
    for (const a of overdue) points.push({ kind: "AKTION", text: `Überfällig seit ${a.dueDate ?? "?"}: ${a.title}${tag(a.setupId)}`, href: `/setups/${a.setupId ?? ""}` });
    // Offene Fragen
    const [oq] = await db.select({ n: count() }).from(schema.openQuestions).where(and(inArray(schema.openQuestions.setupId, setupIds), eq(schema.openQuestions.status, "OFFEN")));
    if (Number(oq?.n ?? 0) > 0) points.push({ kind: "FRAGE", text: `${oq!.n} offene Frage(n) fürs nächste Kundengespräch.`, href: res.ref.type === "SETUP" ? `/setups/${setupIds[0]}` : "/meine-arbeit" });
    // Stillstand: keine Aktualisierung seit 14 Tagen
    const stale = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const staleSetups = await db.query.projectSetups.findMany({ where: and(inArray(schema.projectSetups.id, setupIds), lt(schema.projectSetups.updatedAt, stale), inArray(schema.projectSetups.status, ["ENTWURF", "AKTIV"])), limit: 5 });
    for (const s of staleSetups) points.push({ kind: "STILLSTAND", text: `„${s.name}“ hat seit über zwei Wochen keine Änderung.`, href: `/setups/${s.id}` });
  }
  // Buyingcenter-Lücken nur im Setup-Kontext (bewertungsberechtigt)
  if (res.ref.type === "SETUP" && res.ctx) {
    try {
      const bc = await getBuyingCenter(actor, res.ctx.setup.id);
      for (const g of bc.gaps.slice(0, 4)) points.push({ kind: "BUYINGCENTER", text: g, href: `/setups/${res.ctx.setup.id}/personen` });
    } catch {
      /* keine Sicht */
    }
  }
  return points.slice(0, 12);
}

/**
 * Kontextprüfung: Was fehlt, damit der Assistent überhaupt Vorschläge machen kann – als konkrete Fragen.
 * Das ist die Grundregel aus E-041: Wenn Vorschläge nicht möglich sind, wird gefragt und gesagt, was fehlt.
 */
export async function computeMissing(actor: Actor, res: Resolved): Promise<string[]> {
  const m: string[] = [];
  if (res.ref.type === "GLOBAL") {
    m.push("Um welchen Kunden oder welches Vorhaben geht es? Nenn mir Organisation (mit Rechtsform) und Anlass – dann schlage ich Kunde und Setup vor.");
    return m;
  }
  if (res.ref.type === "ACCOUNT" && res.account) {
    const setups = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, res.account.id) });
    if (setups.length === 0) m.push(`Für ${res.account.name} gibt es noch kein Setup. Woran arbeitet der Kunde gerade, und warum seid ihr im Gespräch? Daraus mache ich einen Setup-Vorschlag.`);
    const persons = await db.query.persons.findMany({ where: eq(schema.persons.accountId, res.account.id) });
    if (persons.length === 0) m.push("Es sind noch keine Ansprechpartner erfasst. Mit wem hast du gesprochen – Name, Funktion, Zuständigkeit?");
    return m;
  }
  if (res.ctx) {
    if (!res.ctx.setup.contextNote) m.push("Dem Setup fehlt die Kontextnotiz: Was läuft hier, in ein bis zwei Sätzen?");
    const persons = await db.query.persons.findMany({ where: eq(schema.persons.accountId, res.ctx.account.id) });
    if (persons.length === 0) m.push("Noch keine Ansprechpartner: Mit wem hast du gesprochen – Name, Funktion, Zuständigkeit?");
    const [opps] = await db.select({ n: count() }).from(schema.opportunities).where(eq(schema.opportunities.setupId, res.ctx.setup.id));
    if (Number(opps?.n ?? 0) === 0) m.push("Kein Bedarf erfasst: Was will der Kunde erreichen, in seinen Worten – und woran macht er fest, dass ihm etwas fehlt?");
    const [sig] = await db.select({ n: count() }).from(schema.signals).where(eq(schema.signals.setupId, res.ctx.setup.id));
    if (Number(sig?.n ?? 0) === 0) m.push("Keine Beobachtungen: Was wurde im letzten Gespräch konkret gesagt oder gezeigt?");
    if (persons.length > 0) {
      const assessed = await db.query.personAssessments.findMany({ where: eq(schema.personAssessments.setupId, res.ctx.setup.id) });
      if (!assessed.some((a) => a.decisionRole === "BUDGETVERANTWORTUNG")) m.push("Wer entscheidet über das Budget? Dafür fehlt noch eine Person mit dieser Rolle.");
    }
  }
  return m.slice(0, 5);
}

/** Berechtigter Kontext als Text für das Modell – nur, was die Person selbst sieht. */
export async function buildContextText(actor: Actor, res: Resolved): Promise<string> {
  const lines: string[] = [`Angemeldet: ${actor.displayName} (Rollen: ${[...actor.roles].join(", ") || "keine"})`];
  if (res.account) lines.push(`Kunde: ${res.account.name} (${res.account.orgType})`);
  if (res.ctx) {
    lines.push(`Setup: ${res.ctx.setup.name} [${res.ctx.setup.status}]${res.ctx.setup.contextNote ? ` – ${res.ctx.setup.contextNote}` : ""}`);
    const [persons, fns, opps, signals, actions, oq] = await Promise.all([
      db.query.persons.findMany({ where: eq(schema.persons.accountId, res.ctx.account.id) }),
      db.query.personFunctions.findMany({}),
      db.query.opportunities.findMany({ where: eq(schema.opportunities.setupId, res.ctx.setup.id) }),
      db.query.signals.findMany({ where: eq(schema.signals.setupId, res.ctx.setup.id), orderBy: desc(schema.signals.createdAt), limit: 10 }),
      db.query.actions.findMany({ where: eq(schema.actions.setupId, res.ctx.setup.id), orderBy: desc(schema.actions.createdAt), limit: 10 }),
      db.query.openQuestions.findMany({ where: and(eq(schema.openQuestions.setupId, res.ctx.setup.id), eq(schema.openQuestions.status, "OFFEN")), limit: 10 }),
    ]);
    if (persons.length) lines.push(`Bekannte Personen: ${persons.map((p) => `${p.displayName}${fns.find((f) => f.personId === p.id && !f.validTo)?.functionTitle ? ` (${fns.find((f) => f.personId === p.id && !f.validTo)!.functionTitle})` : ""}`).join("; ")}`);
    if (opps.length) lines.push(`Bedarfe: ${opps.map((o) => `${o.title} [${o.status}]`).join("; ")}`);
    if (signals.length) lines.push(`Letzte Beobachtungen: ${signals.map((s) => s.observation.slice(0, 160)).join(" | ")}`);
    if (actions.length) lines.push(`Aktionen: ${actions.map((a) => `${a.title} [${a.status}${a.dueDate ? `, bis ${a.dueDate}` : ""}]`).join("; ")}`);
    if (oq.length) lines.push(`Offene Fragen: ${oq.map((q) => q.question).join(" | ")}`);
  } else if (res.account) {
    const [setups, persons] = await Promise.all([db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, res.account.id) }), db.query.persons.findMany({ where: eq(schema.persons.accountId, res.account.id) })]);
    const visible = [];
    for (const s of setups) {
      const c = await loadSetupContext(actor, s.id);
      if (c && canViewSetup(actor, c)) visible.push(s.name);
    }
    if (visible.length) lines.push(`Setups: ${visible.join("; ")}`);
    if (persons.length) lines.push(`Bekannte Personen: ${persons.map((p) => p.displayName).join("; ")}`);
  }
  return lines.join("\n");
}

export async function getThreadView(actor: Actor, rawContext: unknown) {
  const res = await resolveContext(actor, rawContext);
  const thread = await getOrCreateThread(actor, res.ref);
  const messages = await db.query.assistantMessages.findMany({ where: eq(schema.assistantMessages.threadId, thread.id), orderBy: asc(schema.assistantMessages.seq) });
  const [openPoints, missing] = await Promise.all([computeOpenPoints(actor, res), computeMissing(actor, res)]);
  const provider = getAIProvider().info();
  return {
    thread: { id: thread.id, title: thread.title, contextType: thread.contextType, contextId: thread.contextId, interviewMode: thread.interviewMode },
    context: { label: res.ctx ? `${res.account?.name} · ${res.ctx.setup.name}` : res.account ? res.account.name : "Allgemein", canWrite: res.canWrite },
    messages: messages.map((m) => ({ id: m.id, role: m.role, text: m.text, cards: m.cards as AssistantCard[], missing: m.missing as string[], createdAt: m.createdAt })),
    openPoints,
    missing,
    ai: { enabled: provider.enabled, description: provider.description },
  };
}

export const messageInput = z.object({ threadId: z.string().min(1), text: z.string().trim().min(1, "Bitte etwas schreiben.").max(8000) });

/**
 * Nachricht senden: Nutzertext speichern, Modell antworten lassen (gestreamt), Karten prüfen und speichern.
 * Ohne KI antwortet der Assistent mit den offenen Punkten und fehlenden Informationen – er schweigt nie.
 */
export async function sendMessage(actor: Actor, raw: unknown, deps: { provider?: AIProvider; onDelta?: (chunk: string) => void } = {}) {
  const parsed = messageInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const { threadId, text } = parsed.data;
  const thread = await requireThread(actor, threadId);
  if (thread.archivedAt) throw new TransitionError("Dieses Gespräch ist archiviert.");
  const res = await resolveContext(actor, { type: thread.contextType, id: thread.contextId ?? "" });
  const prior = await db.query.assistantMessages.findMany({ where: eq(schema.assistantMessages.threadId, threadId), orderBy: asc(schema.assistantMessages.seq) });
  await db.insert(schema.assistantMessages).values({ threadId, seq: prior.length + 1, role: "NUTZER", text });
  const history = [...prior.map((m) => ({ role: (m.role === "NUTZER" ? "NUTZER" : "ASSISTENT") as "NUTZER" | "ASSISTENT", text: m.text })), { role: "NUTZER" as const, text }];
  const [contextText, openPoints, missingNow] = await Promise.all([buildContextText(actor, res), computeOpenPoints(actor, res), computeMissing(actor, res)]);
  const openPointsText = [...openPoints.map((p) => `- ${p.text}`), ...missingNow.map((m) => `- Fehlt: ${m}`)].join("\n");

  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  let replyText = "";
  let cards: AssistantCard[] = [];
  let missing: string[] = [];
  let aiJobId: string | null = null;
  let note = "";

  if (info.enabled && provider.assistantReply) {
    const cfg = getConfig();
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const [cnt] = await db.select({ n: count() }).from(schema.aiJobs).where(and(eq(schema.aiJobs.workspaceId, actor.workspaceId), gte(schema.aiJobs.startedAt, since)));
    if (Number(cnt?.n ?? 0) >= cfg.AI_DAILY_JOB_LIMIT) throw new UsageLimitError(cfg.AI_DAILY_JOB_LIMIT);
    const taskOpts: TaskOptions = info.id === "langdock" ? await requireTaskOptions(actor.workspaceId, "ASSISTANT") : {};
    const input: AssistantInput = { contextText, history, interviewMode: thread.interviewMode, openPoints: openPointsText };
    const inputText = JSON.stringify(input);
    const [job] = await db
      .insert(schema.aiJobs)
      .values({ workspaceId: actor.workspaceId, type: "ASSISTANT", actorUserId: actor.userId, setupId: res.ctx?.setup.id ?? null, provider: info.id, model: taskOpts.model ?? info.model, promptVersion: ASSISTANT_PROMPT_VERSION, inputHash: sha(inputText), inputChars: inputText.length, dedupeKey: sha(`assistant:${threadId}:${prior.length + 1}`) })
      .returning();
    aiJobId = job?.id ?? null;
    let full = "";
    let markerSeen = false;
    let carry = "";
    try {
      full = await provider.assistantReply(input, taskOpts, (chunk) => {
        if (markerSeen || !deps.onDelta) return;
        // Prosa streamen, aber den Marker (auch über Chunk-Grenzen) zurückhalten
        carry += chunk;
        const idx = carry.indexOf(ASSISTANT_CARDS_MARKER);
        if (idx >= 0) {
          deps.onDelta(carry.slice(0, idx));
          markerSeen = true;
          carry = "";
          return;
        }
        const keep = ASSISTANT_CARDS_MARKER.length - 1;
        if (carry.length > keep) {
          deps.onDelta(carry.slice(0, carry.length - keep));
          carry = carry.slice(carry.length - keep);
        }
      });
      if (!markerSeen && carry && deps.onDelta) deps.onDelta(carry);
      const parsedOut = splitReply(full);
      replyText = parsedOut.prose;
      const validated = assistantOutputSchema.safeParse(parsedOut.json);
      const usage = provider.lastUsage?.() ?? null;
      if (validated.success) {
        const allowedText = `${history.map((h) => h.text).join("\n")}\n${contextText}`;
        const norm = normalize(allowedText);
        let rejected = 0;
        const items = validated.data.items.filter((it) => (allowedText.includes(it.evidenceQuote) || norm.includes(normalize(it.evidenceQuote)) ? true : (rejected++, false)));
        cards = items.map((item) => ({ id: randomUUID(), item, status: "NEU" as const }));
        missing = validated.data.missing;
        if (rejected > 0) note = `${rejected} Vorschlag/Vorschläge ohne belegbare Textstelle wurden verworfen.`;
        if (job) await db.update(schema.aiJobs).set({ status: "ERFOLGREICH", itemCount: cards.length, rejectedCount: rejected, tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null, model: usage?.model || job.model, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
      } else {
        note = parsedOut.json === null ? "Die Antwort enthielt keine auswertbaren Karten." : "Die Karten entsprachen nicht dem Schema und wurden verworfen.";
        if (job) await db.update(schema.aiJobs).set({ status: "FEHLER", error: "Karten nicht schemakonform", tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
      }
      if (!replyText.trim()) replyText = cards.length ? `Ich habe ${cards.length} Vorschläge abgeleitet.` : "Ich konnte daraus nichts Belastbares ableiten.";
    } catch (e) {
      const msg = (e instanceof Error ? e.message : "Anbieterfehler").slice(0, 300);
      if (job) await db.update(schema.aiJobs).set({ status: "ABGELEHNT", error: msg, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
      replyText = fallbackReply(openPoints, missingNow, `Die KI ist gerade nicht erreichbar (${msg}).`);
      missing = missingNow;
      deps.onDelta?.(replyText);
    }
  } else {
    replyText = fallbackReply(openPoints, missingNow, "Die KI ist deaktiviert; ich kann dir die offenen Punkte zeigen und sagen, was fehlt.");
    missing = missingNow;
    deps.onDelta?.(replyText);
  }
  if (note) replyText = `${replyText}\n\n${note}`;
  const [saved] = await db.insert(schema.assistantMessages).values({ threadId, seq: prior.length + 2, role: "ASSISTENT", text: replyText, cards, missing, aiJobId }).returning();
  await db.update(schema.assistantThreads).set({ updatedAt: new Date() }).where(eq(schema.assistantThreads.id, threadId));
  return { message: saved!, cards, missing };
}

function fallbackReply(openPoints: OpenPoint[], missing: string[], head: string): string {
  const parts = [head];
  if (openPoints.length) parts.push(`Offene Punkte: ${openPoints.slice(0, 4).map((p) => p.text).join(" · ")}`);
  if (missing.length) parts.push(`Damit ich Vorschläge machen kann, fehlt mir: ${missing[0]}`);
  return parts.join("\n\n");
}

export function splitReply(full: string): { prose: string; json: unknown | null } {
  const idx = full.indexOf(ASSISTANT_CARDS_MARKER);
  if (idx < 0) return { prose: full.trim(), json: null };
  const prose = full.slice(0, idx).trim();
  const rest = full.slice(idx + ASSISTANT_CARDS_MARKER.length).trim();
  try {
    return { prose, json: parseJsonLoose(rest) };
  } catch {
    return { prose, json: null };
  }
}

// ---------------------------------------------------------------------------
// Karten übernehmen / verwerfen
// ---------------------------------------------------------------------------

export const cardDecisionInput = z.object({ threadId: z.string().min(1), messageId: z.string().min(1), cardId: z.string().min(1), decision: z.enum(["UEBERNEHMEN", "VERWERFEN"]) });

/** Dialog als Quelle führen (einmal je Gespräch anlegen, danach Text aktualisieren). */
async function ensureThreadSource(tx: Tx, actor: Actor, thread: typeof schema.assistantThreads.$inferSelect, setupId: string | null) {
  const msgs = await tx.query.assistantMessages.findMany({ where: eq(schema.assistantMessages.threadId, thread.id), orderBy: asc(schema.assistantMessages.seq) });
  const body = msgs.map((m) => `${m.role === "NUTZER" ? "Ich" : "Assistent"}: ${m.text}`).join("\n\n");
  if (thread.sourceId) {
    const src = await tx.query.sources.findFirst({ where: eq(schema.sources.id, thread.sourceId) });
    if (src) {
      const versions = await tx.query.sourceVersions.findMany({ where: eq(schema.sourceVersions.sourceId, src.id) });
      await tx.update(schema.sources).set({ body, setupId: src.setupId ?? setupId, accessClass: src.setupId || !setupId ? src.accessClass : "SETUP" }).where(eq(schema.sources.id, src.id));
      await tx.insert(schema.sourceVersions).values({ sourceId: src.id, versionNo: versions.length + 1, body, contentHash: sha(body) });
      return src.id;
    }
  }
  const [src] = await tx
    .insert(schema.sources)
    .values({ workspaceId: actor.workspaceId, setupId, type: "INTERVIEW", title: `Assistent-Dialog ${new Date().toLocaleDateString("de-DE")}`, body, origin: "Assistent", sourceTime: new Date(), ownerUserId: actor.userId, accessClass: setupId ? "SETUP" : "PERSOENLICH" })
    .returning();
  if (!src) throw new Error("Quelle");
  await tx.insert(schema.sourceVersions).values({ sourceId: src.id, versionNo: 1, body, contentHash: sha(body) });
  await tx.update(schema.assistantThreads).set({ sourceId: src.id }).where(eq(schema.assistantThreads.id, thread.id));
  return src.id;
}

export async function decideCard(actor: Actor, raw: unknown) {
  const parsed = cardDecisionInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const { threadId, messageId, cardId, decision } = parsed.data;
  const thread = await requireThread(actor, threadId);
  const msg = await db.query.assistantMessages.findFirst({ where: and(eq(schema.assistantMessages.id, messageId), eq(schema.assistantMessages.threadId, threadId)) });
  if (!msg) throw new NotFoundError("Nachricht");
  const cards = (msg.cards as AssistantCard[]).map((c) => ({ ...c }));
  const card = cards.find((c) => c.id === cardId);
  if (!card) throw new NotFoundError("Karte");
  if (card.status !== "NEU") throw new TransitionError("Diese Karte wurde bereits entschieden.");

  if (decision === "VERWERFEN") {
    card.status = "VERWORFEN";
    await db.transaction(async (tx) => {
      await tx.update(schema.assistantMessages).set({ cards }).where(eq(schema.assistantMessages.id, messageId));
      await recordAudit(tx, actor, "assistant.card_discarded", "ASSISTANT_CARD", cardId, { type: card.item.type });
    });
    return { card, thread };
  }

  const res = await resolveContext(actor, { type: thread.contextType, id: thread.contextId ?? "" });
  const result = await applyItem(actor, thread, res, card.item);
  card.status = "UEBERNOMMEN";
  card.resultType = result.type;
  card.resultId = result.id;
  card.note = result.note;
  await db.transaction(async (tx) => {
    await tx.update(schema.assistantMessages).set({ cards }).where(eq(schema.assistantMessages.id, messageId));
    if (result.rebind) await tx.update(schema.assistantThreads).set({ contextType: result.rebind.type, contextId: result.rebind.id, title: result.rebind.title, updatedAt: new Date() }).where(eq(schema.assistantThreads.id, threadId));
    await recordAudit(tx, actor, "assistant.card_applied", "ASSISTANT_CARD", cardId, { type: card.item.type, resultType: result.type, resultId: result.id });
  });
  return { card, thread: await requireThread(actor, threadId) };
}

type ApplyResult = { type: string; id: string; note?: string; rebind?: { type: "SETUP"; id: string; title: string } };

async function applyItem(actor: Actor, thread: typeof schema.assistantThreads.$inferSelect, res: Resolved, item: AssistantItem): Promise<ApplyResult> {
  const origin = "Assistent-Dialog";
  if (item.type === "KUNDE") {
    if (!canCreateAccount(actor)) throw new ForbiddenError("Nur BD oder Principal legen Kunden an.");
    const account = await createAccount(actor, { name: item.name, orgType: item.orgType, responsibleBdUserId: hasRole(actor, "BD") ? actor.userId : null });
    const setup = await createSetup(actor, { accountId: account.id, name: item.setupName, contextNote: item.contextNote || `Angelegt aus ${origin}.`, bdUserId: hasRole(actor, "BD") ? actor.userId : null, creatorContribution: "ANKER_KONTEXT" });
    await db.transaction(async (tx) => ensureThreadSource(tx, actor, thread, setup.id));
    return { type: "SETUP", id: setup.id, note: `Kunde „${account.name}“ und Setup „${setup.name}“ angelegt; das Gespräch gehört jetzt zu diesem Setup.`, rebind: { type: "SETUP", id: setup.id, title: "Assistent · Setup" } };
  }
  if (item.type === "SETUP") {
    if (!res.account) throw new ValidationError("Für ein Setup fehlt der Kunde – sag mir zuerst, um welche Organisation es geht.");
    const setup = await createSetup(actor, { accountId: res.account.id, name: item.name, contextNote: item.contextNote || `Angelegt aus ${origin}.`, bdUserId: hasRole(actor, "BD") ? actor.userId : null, creatorContribution: "ANKER_KONTEXT" });
    await db.transaction(async (tx) => ensureThreadSource(tx, actor, thread, setup.id));
    return { type: "SETUP", id: setup.id, note: `Setup „${setup.name}“ angelegt; das Gespräch gehört jetzt zu diesem Setup.`, rebind: { type: "SETUP", id: setup.id, title: "Assistent · Setup" } };
  }
  if (item.type === "PERSON") {
    if (!res.account) throw new ValidationError("Für eine Person fehlt der Kunde – lege zuerst den Kunden an (Karte „Kunde“).");
    const person = await createPerson(actor, { accountId: res.account.id, displayName: item.displayName, functionTitle: item.functionTitle, knownResponsibility: item.knownResponsibility, setupId: res.ctx?.setup.id ?? "", accessClass: "ACCOUNT_TEAM" });
    let note = `Person „${person.displayName}“ angelegt.`;
    if (res.ctx && (item.decisionRole || item.stance !== "UNBEKANNT" || item.influence !== "UNBEKANNT")) {
      const sourceId = await db.transaction(async (tx) => ensureThreadSource(tx, actor, thread, res.ctx!.setup.id));
      await upsertAssessment(actor, { personId: person.id, setupId: res.ctx.setup.id, decisionRole: item.decisionRole ?? "", stance: item.stance, influence: item.influence, note: item.assessmentNote, sourceId, confirm: false });
      note += " Einschätzung als Hypothese gespeichert.";
    }
    return { type: "PERSON", id: person.id, note };
  }
  // Alles Weitere braucht ein Setup mit Bearbeitungsrecht
  if (!res.ctx) throw new ValidationError("Dafür braucht es ein Setup. Lege zuerst Kunde und Setup an (Karten „Kunde“/„Setup“) oder öffne den Assistenten in einem Setup.");
  if (!canEditSetup(actor, res.ctx)) throw new ForbiddenError("Sie sind an diesem Setup nicht bearbeitend beteiligt.");
  const setupId = res.ctx.setup.id;
  const sourceId = await db.transaction(async (tx) => ensureThreadSource(tx, actor, thread, setupId));
  if (item.type === "SIGNAL") {
    const id = await db.transaction(async (tx) => {
      const [signal] = await tx.insert(schema.signals).values({ workspaceId: actor.workspaceId, setupId, observation: item.observation, relevanceHypothesis: item.relevanceHypothesis || null, status: "NEU", sourceId, createdBy: actor.userId }).returning();
      if (!signal) throw new Error("Hinweis");
      const [assertion] = await tx.insert(schema.assertions).values({ workspaceId: actor.workspaceId, setupId, subjectType: "SETUP", subjectId: setupId, content: item.observation, epistemicStatus: "AUSSAGE_WIEDERGEGEBEN", createdBy: actor.userId }).returning();
      if (assertion) await tx.insert(schema.assertionEvidence).values({ assertionId: assertion.id, sourceId, excerpt: item.observation.slice(0, 500) });
      await recordAudit(tx, actor, "signal.created", "SIGNAL", signal.id, { setupId, herkunft: "ASSISTENT" });
      return signal.id;
    });
    return { type: "SIGNAL", id, note: "Hinweis (neu) angelegt." };
  }
  if (item.type === "BEDARF") {
    const opp = await createOpportunity(actor, { setupId, title: item.title, needDescription: item.needDescription, trigger: origin });
    return { type: "OPPORTUNITY", id: opp.id, note: "Bedarf (in Klärung) angelegt." };
  }
  if (item.type === "AKTION") {
    const id = await db.transaction(async (tx) => insertSuggestionCard(tx, actor, setupId, sourceId, origin, { type: "AKTION", title: item.title.slice(0, 200), targetRole: item.ownerRole, observation: item.description || item.title, evidenceQuote: item.evidenceQuote, nextStep: item.title, whyNow: item.dueHint ? `Frist/Hinweis: ${item.dueHint}` : "", uncertainty: "Vorschlag aus dem Assistenten – erst die Annahme macht daraus eine Aufgabe.", priority: "KONKRETE_ANFRAGE" }));
    return { type: "SUGGESTION", id, note: `Als Vorschlag für ${item.ownerRole} in „Meine Arbeit“ abgelegt.` };
  }
  if (item.type === "KONTAKT") {
    const id = await db.transaction(async (tx) => insertSuggestionCard(tx, actor, setupId, sourceId, origin, { type: "KONTAKTAUFNAHME", title: `Kontaktaufnahme ${item.personName}`.slice(0, 200), targetRole: "ANKER", observation: item.occasion, evidenceQuote: item.evidenceQuote, hypothesis: item.viaVerveName ? `Möglicher Weg: über ${item.viaVerveName}` : "", nextStep: item.draftMessage, mentionedPersonName: item.personName, uncertainty: "Entwurf zum Bearbeiten – wird nie automatisch versendet.", priority: "ZUGANGSLUECKE" }));
    return { type: "SUGGESTION", id, note: "Als Kontaktaufnahme-Vorschlag für den Anker abgelegt." };
  }
  if (item.type === "FRAGE") {
    const id = await db.transaction(async (tx) => insertSuggestionCard(tx, actor, setupId, sourceId, origin, { type: "OFFENE_FRAGE", title: item.question.slice(0, 200), targetRole: "BD", observation: item.question, evidenceQuote: item.evidenceQuote, proposedQuestion: item.question, uncertainty: "Vor der Bestätigung zu klären.", priority: "NEUE_INFORMATION" }));
    return { type: "SUGGESTION", id, note: "Als offene Frage vorgemerkt." };
  }
  throw new ValidationError("Unbekannter Kartentyp.");
}

export const modeInput = z.object({ threadId: z.string().min(1), interviewMode: z.union([z.boolean(), z.enum(["true", "false"])]) });

export async function setInterviewMode(actor: Actor, raw: unknown) {
  const parsed = modeInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError("Ungültige Eingabe.");
  const thread = await requireThread(actor, parsed.data.threadId);
  const on = parsed.data.interviewMode === true || parsed.data.interviewMode === "true";
  await db.update(schema.assistantThreads).set({ interviewMode: on, updatedAt: new Date() }).where(eq(schema.assistantThreads.id, thread.id));
  if (on) {
    const prior = await db.query.assistantMessages.findMany({ where: eq(schema.assistantMessages.threadId, thread.id) });
    const intro = `Gut, ich führe dich durch die Erfassung. Themen: ${interviewTopicValues.map((t) => interviewTopicLabel[t]).join(", ")}. Erzähl einfach los – gern mehrere Dinge auf einmal; ich frage nach, was fehlt. Womit fangen wir an: Um welche Organisation geht es und was ist der Anlass?`;
    await db.insert(schema.assistantMessages).values({ threadId: thread.id, seq: prior.length + 1, role: "ASSISTENT", text: intro, cards: [], missing: [] });
  }
  return { interviewMode: on };
}

export async function archiveThread(actor: Actor, threadId: string) {
  const thread = await requireThread(actor, threadId);
  await db.update(schema.assistantThreads).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(schema.assistantThreads.id, thread.id));
  return getOrCreateThread(actor, { type: thread.contextType, id: thread.contextId });
}
