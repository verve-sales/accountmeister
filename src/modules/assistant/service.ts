import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import { hasRole, type Actor } from "@/modules/identity/actor";
import { canCreateAccount, canCreateSetup, canEditSetup, canReassignResponsibility, canViewSetup, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { getAIProvider } from "@/modules/ai";
import { createInitiative, parseDueHint, procurementLabel, updateProcurement } from "@/modules/agenda/service";
import { createSos } from "@/modules/sos/service";
import { getHealth, matchUserByName, recordExistingEngagement, riskLabel, saveHealthAnswer } from "@/modules/health/service";
import { createPriority } from "@/modules/accountplan/service";
import { priorityKindLabel } from "@/lib/labels";

import { buildHelpText } from "@/modules/help/service";
import { looksLikeHowTo, type HelpSection } from "@/modules/help/knowledge";
import { ASSISTANT_PROMPT_VERSION, type AIProvider, type AssistantInput, type TaskOptions } from "@/modules/ai/provider";
import { ASSISTANT_CARDS_MARKER, assistantItemSchema, interviewTopicLabel, interviewTopicValues, type AssistantCard, type AssistantItem } from "@/modules/ai/schemas";
import { resolveTaskOptions } from "@/modules/ai/settings";
import { parseJsonLoose } from "@/modules/ai/providers/langdock";
import { UsageLimitError } from "@/modules/suggestions/service";
import { getAccount, createAccount, listVisibleAccounts, reassignAccountBd } from "@/modules/accounts/service";
import { addMember, createSetup } from "@/modules/setups/service";
import { createPerson } from "@/modules/people/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { createAccountGoal } from "@/modules/leadership/service";
import { upsertAssessment, getBuyingCenter } from "@/modules/people/assessments";
import { insertSuggestionCard } from "./suggestions";

/**
 * Assistent (Etappe 8, E-041): ein Dialog je Nutzer und Kontext (allgemein, Kunde, Setup). Der Assistent antwortet
 * in Prosa, legt Vorschlagskarten daneben (Personen, Signale, Chancen, Aktionen, Kontaktaufnahmen, Fragen, Kunde,
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
    if (Number(opps?.n ?? 0) === 0) m.push("Kein Chance erfasst: Was will der Kunde erreichen, in seinen Worten – und woran macht er fest, dass ihm etwas fehlt?");
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
  if (res.ref.type === "GLOBAL") {
    // Einsortierung (Etappe 14): nur so kann das Modell einen eingefügten Text/E-Mail-Text einem bekannten Kunden zuordnen.
    const known = (await listVisibleAccounts(actor)).filter((a) => a.status !== "ARCHIVED").map((a) => a.name);
    if (known.length) lines.push(`Bekannte Kunden (nur exakt so vorschlagen, wenn einer davon gemeint ist – nie abwandeln oder neue Namen erfinden): ${known.join("; ")}`);
  }
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
    if (opps.length) lines.push(`Chancen: ${opps.map((o) => `${o.title} [${o.status}${o.kind ? `, ${o.kind}` : ""}${o.horizon ? `, ${o.horizon}` : ""}]`).join("; ")}`);
    else lines.push("Chancen: noch keine – worauf läuft es hinaus?");
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
  // Hilfe-Wissen (Etappe 25): Suche über die letzte und die vorletzte Nutzernachricht (Rückfragen wie „und wer darf das?“)
  const prevUser = [...prior].reverse().find((m) => m.role === "NUTZER")?.text ?? "";
  const [contextText, openPoints, missingNow, help] = await Promise.all([buildContextText(actor, res), computeOpenPoints(actor, res), computeMissing(actor, res), buildHelpText(actor, text.split(/\s+/).length < 8 && prevUser ? `${text}\n${prevUser}` : text)]);
  const howTo = looksLikeHowTo(text) && help.sections.length > 0;
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
    const taskOpts: TaskOptions = await resolveTaskOptions(actor.workspaceId, "ASSISTANT", info.id);
    const input: AssistantInput = { contextText, history, interviewMode: thread.interviewMode, openPoints: openPointsText, helpText: help.text };
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
      const usage = provider.lastUsage?.() ?? null;
      const allowedText = `${history.map((h) => h.text).join("\n")}\n${contextText}`;
      // Karten je Element prüfen (ein fehlerhaftes Element verwirft nicht alle), fehlende Karten im JSON-Modus nachziehen
      let outcome = validateCards(parsedOut.json, allowedText);
      let secondStep = false;
      if (outcome.items.length === 0 && (parsedOut.json === null || outcome.invalid > 0 || /karte|vorschl|angelegt|erstellt|vorbereitet/i.test(replyText)) && provider.assistantCards) {
        try {
          const raw = await provider.assistantCards({ ...input, prose: replyText }, taskOpts);
          const second = validateCards(raw, allowedText);
          if (second.items.length > 0 || second.missing.length > 0) {
            outcome = second;
            secondStep = true;
          }
        } catch {
          /* zweiter Schritt fehlgeschlagen – unten wird es gesagt */
        }
      }
      cards = outcome.items.map((item) => ({ id: randomUUID(), item, status: "NEU" as const }));
      missing = outcome.missing;
      const notes: string[] = [];
      if (outcome.rejected > 0) notes.push(`${outcome.rejected} Vorschlag/Vorschläge ohne belegbare Textstelle wurden verworfen.`);
      if (outcome.invalid > 0) notes.push(`${outcome.invalid} Karte(n) waren nicht schemakonform und wurden verworfen.`);
      if (secondStep) notes.push("Die Karten wurden in einem zweiten Schritt aus der Antwort erzeugt.");
      if (cards.length === 0 && /\b(angelegt|erstellt|gespeichert|erzeugt|angehängt|vorbereitet)\b/i.test(replyText)) notes.push("Hinweis: Ich lege nichts selbst an – gespeichert wird nur, was du aus einer Karte übernimmst. Diesmal kamen keine Karten zustande; schreib kurz, was angelegt werden soll (z. B. „Kunde X anlegen“), dann schlage ich Karten vor.");
      else if (cards.length === 0 && parsedOut.json === null && !secondStep) notes.push("Die Antwort enthielt keine auswertbaren Karten.");
      note = notes.join(" ");
      if (job) await db.update(schema.aiJobs).set({ status: cards.length > 0 || parsedOut.json !== null || secondStep ? "ERFOLGREICH" : "FEHLER", itemCount: cards.length, rejectedCount: outcome.rejected + outcome.invalid, error: cards.length === 0 && parsedOut.json === null && !secondStep ? "Keine Karten" : null, tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null, model: usage?.model || job.model, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
      if (!replyText.trim()) replyText = cards.length ? `Ich habe ${cards.length} Vorschläge abgeleitet.` : "Ich konnte daraus nichts Belastbares ableiten.";
    } catch (e) {
      const msg = (e instanceof Error ? e.message : "Anbieterfehler").slice(0, 300);
      if (job) await db.update(schema.aiJobs).set({ status: "ABGELEHNT", error: msg, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
      replyText = howTo ? helpReply(help.sections, `Die KI ist gerade nicht erreichbar (${msg}); hier der passende Abschnitt aus der Hilfe.`) : fallbackReply(openPoints, missingNow, `Die KI ist gerade nicht erreichbar (${msg}).`);
      missing = missingNow;
      deps.onDelta?.(replyText);
    }
  } else {
    replyText = howTo ? helpReply(help.sections, "Die KI ist deaktiviert – hier der passende Abschnitt aus der Hilfe.") : fallbackReply(openPoints, missingNow, "Die KI ist deaktiviert; ich kann dir die offenen Punkte zeigen und sagen, was fehlt.");
    missing = howTo ? [] : missingNow;
    deps.onDelta?.(replyText);
  }
  if (note) replyText = `${replyText}\n\n${note}`;
  const [saved] = await db.insert(schema.assistantMessages).values({ threadId, seq: prior.length + 2, role: "ASSISTENT", text: replyText, cards, missing, aiJobId }).returning();
  await db.update(schema.assistantThreads).set({ updatedAt: new Date() }).where(eq(schema.assistantThreads.id, threadId));
  return { message: saved!, cards, missing };
}

/** Ohne KI: Bedienfragen direkt mit dem passenden Hilfe-Abschnitt beantworten (wörtlich, nichts dazuerfunden). */
function helpReply(sections: HelpSection[], head: string): string {
  const [first, ...rest] = sections;
  const parts = [head, `${first!.title} – Wo: ${first!.where}`, first!.body];
  if (rest.length) parts.push(`Siehe auch: ${rest.map((r) => r.title).join(" · ")} (Seite „Hilfe“).`);
  return parts.join("\n\n");
}

function fallbackReply(openPoints: OpenPoint[], missing: string[], head: string): string {
  const parts = [head];
  if (openPoints.length) parts.push(`Offene Punkte: ${openPoints.slice(0, 4).map((p) => p.text).join(" · ")}`);
  if (missing.length) parts.push(`Damit ich Vorschläge machen kann, fehlt mir: ${missing[0]}`);
  return parts.join("\n\n");
}

/** Antwort in Prosa und Karten-JSON trennen – tolerant gegenüber Markervarianten, Codezäunen und fehlendem Marker. */
export function splitReply(full: string): { prose: string; json: unknown | null } {
  const markerRe = /^[ \t]*`{0,3}[ \t]*={2,}\s*KARTEN\s*={2,}[ \t]*`{0,3}[ \t]*$|^\s*KARTEN\s*:\s*$/im;
  const m = markerRe.exec(full);
  let prose: string;
  let rest: string;
  if (m) {
    prose = full.slice(0, m.index).trim();
    rest = full.slice(m.index + m[0].length).trim();
  } else {
    // Kein Marker: JSON-Objekt mit "items" im Text suchen (typisch am Ende, ggf. in einem Codezaun)
    const idx = full.search(/\{\s*"items"\s*:/);
    if (idx < 0) return { prose: full.replace(/```(?:json)?\s*```/g, "").trim(), json: null };
    prose = full.slice(0, idx).replace(/```(?:json)?\s*$/, "").trim();
    rest = full.slice(idx).trim();
  }
  try {
    return { prose, json: parseJsonLoose(rest) };
  } catch {
    return { prose, json: null };
  }
}

/** Karten einzeln prüfen: Schema je Element, Textstelle im erlaubten Text. */
export function validateCards(json: unknown, allowedText: string): { items: AssistantItem[]; missing: string[]; rejected: number; invalid: number } {
  if (!json || typeof json !== "object") return { items: [], missing: [], rejected: 0, invalid: 0 };
  const obj = json as { items?: unknown; missing?: unknown };
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const norm = normalize(allowedText);
  const items: AssistantItem[] = [];
  let rejected = 0;
  let invalid = 0;
  for (const raw of rawItems.slice(0, 40)) {
    const r = assistantItemSchema.safeParse(raw);
    if (!r.success) {
      invalid++;
      continue;
    }
    const q = r.data.evidenceQuote;
    if (allowedText.includes(q) || norm.includes(normalize(q))) items.push(r.data);
    else rejected++;
  }
  const missing = Array.isArray(obj.missing) ? obj.missing.filter((x): x is string => typeof x === "string" && x.trim().length >= 3).map((x) => x.trim().slice(0, 300)).slice(0, 8) : [];
  return { items: items.slice(0, 30), missing, rejected, invalid };
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

/** Chance eines Setups nach Titel finden (unscharf) – für das Wofür der Karten. */
async function matchOpportunity(setupId: string, purpose: string) {
  const opps = await db.query.opportunities.findMany({ where: eq(schema.opportunities.setupId, setupId) });
  const q = purpose.trim().toLowerCase();
  if (!q) return null;
  return opps.find((o) => o.title.toLowerCase() === q) ?? opps.find((o) => o.title.toLowerCase().includes(q) || q.includes(o.title.toLowerCase())) ?? null;
}

type ApplyResult = { type: string; id: string; note?: string; rebind?: { type: "SETUP" | "ACCOUNT"; id: string; title: string } };

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
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email.trim()) ? item.email.trim() : "";
    const person = await createPerson(actor, { accountId: res.account.id, displayName: item.displayName, functionTitle: item.functionTitle, knownResponsibility: item.knownResponsibility, email, phone: item.phone.trim().slice(0, 50), setupId: res.ctx?.setup.id ?? "", accessClass: "ACCOUNT_TEAM" });
    let note = `Person „${person.displayName}“ angelegt.`;
    if (res.ctx && (item.decisionRole || item.stance !== "UNBEKANNT" || item.influence !== "UNBEKANNT")) {
      const sourceId = await db.transaction(async (tx) => ensureThreadSource(tx, actor, thread, res.ctx!.setup.id));
      await upsertAssessment(actor, { personId: person.id, setupId: res.ctx.setup.id, decisionRole: item.decisionRole ?? "", stance: item.stance, influence: item.influence, note: item.assessmentNote, sourceId, confirm: false });
      note += " Einschätzung als Hypothese gespeichert.";
    }
    return { type: "PERSON", id: person.id, note };
  }
  if (item.type === "ACCOUNTZIEL") {
    if (!res.account) throw new ValidationError("Für ein Accountziel fehlt der Kunde – öffne den Assistenten auf der Kundenseite.");
    if (!hasRole(actor, "PRINCIPAL") && !hasRole(actor, "CEO")) throw new ForbiddenError("Accountziele legen Principal oder CEO an.");
    const goal = await createAccountGoal(actor, { accountId: res.account.id, title: item.title, desiredOutcome: item.desiredOutcome, roleFamily: item.roleFamily ?? "", targetHeadcount: item.targetHeadcount ?? undefined, horizon: item.horizon, successCriterion: item.successCriterion });
    return { type: "GOAL", id: goal.id, note: `Accountziel „${goal.title}“ als Entwurf angelegt – zur Abstimmung mit dem CEO bereit (Ziele → „${goal.title}“).` };
  }
  if (item.type === "EINSORTIERUNG") {
    const accounts = await listVisibleAccounts(actor);
    const account = accounts.find((a) => a.name === item.accountName);
    if (!account) throw new ValidationError(`Kunde „${item.accountName}“ wurde nicht gefunden oder ist für dich nicht sichtbar.`);
    let matchedSetup: typeof schema.projectSetups.$inferSelect | null = null;
    if (item.setupName) {
      const setups = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, account.id) });
      matchedSetup = setups.find((s) => s.name.toLowerCase() === item.setupName.toLowerCase()) ?? null;
    }
    if (matchedSetup) {
      const ctx = await loadSetupContext(actor, matchedSetup.id);
      if (!ctx || !canViewSetup(actor, ctx)) throw new ForbiddenError("Dieses Setup ist für dich nicht sichtbar.");
      return { type: "SETUP", id: matchedSetup.id, note: `Zuordnung übernommen – das Gespräch bezieht sich jetzt auf „${account.name} · ${matchedSetup.name}“.`, rebind: { type: "SETUP", id: matchedSetup.id, title: "Assistent · Setup" } };
    }
    return { type: "ACCOUNT", id: account.id, note: `Zuordnung übernommen – das Gespräch bezieht sich jetzt auf „${account.name}“. Als Nächstes kannst du z. B. ein Setup vorschlagen lassen.`, rebind: { type: "ACCOUNT", id: account.id, title: "Assistent · Kunde" } };
  }
  // Etappe 26: Karten auf Kundenebene (Kundenagenda, Beschaffung, Risiko, Hebel, Team, SOS)
  if (item.type === "INITIATIVE" || item.type === "BESCHAFFUNG" || item.type === "RISIKO" || item.type === "HEBEL" || item.type === "TEAM" || item.type === "SOS") {
    if (!res.account) throw new ValidationError("Dafür fehlt der Kunde – übernimm zuerst die Karte „Kunde“ oder öffne den Assistenten auf der Kundenseite.");
    const account = await getAccount(actor, res.account.id);
    if (item.type === "INITIATIVE") {
      const ini = await createInitiative(actor, { accountId: account.id, kind: item.kind, title: item.title, description: item.description, dueHint: item.dueHint });
      return { type: "INITIATIVE", id: ini.id, note: `In die Kundenagenda aufgenommen${ini.dueDate ? ` (Termin ${ini.dueDate} – der Accountmeister erinnert rechtzeitig)` : ""}.` };
    }
    if (item.type === "BESCHAFFUNG") {
      await updateProcurement(actor, account.id, { version: account.version, procurementChannel: item.channel, intermediaryName: item.intermediaryName, procurementNote: item.note });
      return { type: "ACCOUNT", id: account.id, note: `Beschaffungsweg gespeichert: ${procurementLabel[item.channel]}${item.intermediaryName ? ` (${item.intermediaryName})` : ""}.` };
    }
    if (item.type === "RISIKO") {
      const h = await getHealth(actor, account.id);
      const items = [...new Set([...(h.answers.risks?.items ?? []), item.risk])];
      const note = [h.answers.risks?.note, item.note].filter(Boolean).join(" · ").slice(0, 1000);
      await saveHealthAnswer(actor, account.id, { key: "RISKS", items, note });
      return { type: "ACCOUNT", id: account.id, note: `Risiko „${riskLabel[item.risk] ?? item.risk}“ im Health-Check vermerkt.` };
    }
    if (item.type === "HEBEL") {
      const pr = await createPriority(actor, { accountId: account.id, setupId: res.ctx?.setup.id ?? "", kind: item.lever, title: item.title, rationale: item.rationale || `Aus dem Assistenten: „${item.evidenceQuote.slice(0, 300)}“` });
      return { type: "PRIORITY", id: pr.id, note: `Als Vorhaben (${priorityKindLabel[item.lever] ?? item.lever}) in den Accountplan aufgenommen – zur Abstimmung vorgeschlagen.` };
    }
    if (item.type === "SOS") {
      const sos = await createSos(actor, { accountId: account.id, setupId: res.ctx?.setup.id ?? "", kind: item.kind, title: item.title, situation: item.situation, need: item.need });
      return { type: "SOS", id: sos.id, note: "SOS ausgelöst – BD und Principal sehen es sofort auf der Startseite." };
    }
    // TEAM: Verve-Kolleginnen und -Kollegen per Namen zuordnen – nur eindeutige Treffer, nichts wird geraten
    const notes: string[] = [];
    if (item.bdName) {
      const u = await matchUserByName(actor.workspaceId, item.bdName);
      if (!u) notes.push(`BD „${item.bdName}“ nicht eindeutig gefunden.`);
      else if (u.id === account.responsibleBdUserId) notes.push(`${u.displayName} ist bereits zuständiger BD.`);
      else if (!canReassignResponsibility(actor, account)) notes.push(`BD ${u.displayName} bitte von Principal oder zuständigem BD umstellen lassen.`);
      else {
        await reassignAccountBd(actor, account.id, { version: account.version, responsibleBdUserId: u.id });
        notes.push(`Zuständiger BD: ${u.displayName}.`);
      }
    }
    for (const name of item.ankerNames) {
      const u = await matchUserByName(actor.workspaceId, name);
      if (!u) notes.push(`Anker „${name}“ nicht eindeutig gefunden.`);
      else if (!res.ctx) notes.push(`Anker ${u.displayName}: bitte im Setup als Beteiligung eintragen.`);
      else {
        await addMember(actor, res.ctx.setup.id, { userId: u.id, contribution: "ANKER_KONTEXT", contributionNote: "Aus dem Assistenten übernommen (Account-Anker)." });
        notes.push(`${u.displayName} als Anker im Setup „${res.ctx.setup.name}“ eingetragen.`);
      }
    }
    if (item.principalName) notes.push(`Principal „${item.principalName}“: Die kundenbezogene Principal-Rolle vergibt die Betriebsverwaltung (Verwaltung → Rolle zuweisen).`);
    if (item.consultantName) notes.push(`Operativer Berater „${item.consultantName}“: wird am Einsatz eingetragen (Karte „Einsatz“ oder Health-Check → Einsätze).`);
    return { type: "ACCOUNT", id: account.id, note: notes.join(" ") || "Nichts zuzuordnen." };
  }
  if (item.type === "EINSATZ") {
    if (!res.account || !res.ctx) throw new ValidationError("Für einen laufenden Einsatz braucht es Kunde und Setup – übernimm zuerst die Karte „Kunde“.");
    const plannedEnd = /^\d{4}-\d{2}-\d{2}$/.test(item.plannedEnd) ? item.plannedEnd : parseDueHint(item.endHint || item.plannedEnd) ?? "";
    const order = await recordExistingEngagement(actor, res.account.id, { setupId: res.ctx.setup.id, title: item.title, kind: item.kind, plannedEnd, evidenceText: `Aus dem Assistenten übernommen: „${item.evidenceQuote.slice(0, 400)}“`, consultantName: item.consultantName });
    return { type: "ORDER", id: order.id, note: `Laufender Einsatz nachgetragen${plannedEnd ? ` (Ende ${plannedEnd} – die Verlängerungsregel greift rechtzeitig)` : " – Einsatzende bitte im Health-Check ergänzen"}.` };
  }
  // Alles Weitere braucht ein Setup mit Bearbeitungsrecht
  if (!res.ctx) throw new ValidationError("Dafür braucht es ein Setup. Lege zuerst Kunde und Setup an (Karten „Kunde“/„Setup“) oder öffne den Assistenten in einem Setup.");
  if (!canEditSetup(actor, res.ctx)) throw new ForbiddenError("Sie sind an diesem Setup nicht bearbeitend beteiligt.");
  const setupId = res.ctx.setup.id;
  const sourceId = await db.transaction(async (tx) => ensureThreadSource(tx, actor, thread, setupId));
  // Wofür (E-045): purpose gegen bestehende Chancen des Setups auflösen (Titel, unscharf)
  const purpose = "purpose" in item ? item.purpose : "";
  const linkedOpp = purpose ? await matchOpportunity(setupId, purpose) : null;
  const purposeNote = linkedOpp ? ` Wofür: „${linkedOpp.title}“.` : purpose ? ` Wofür (noch ohne Chance): ${purpose}.` : "";
  if (item.type === "SIGNAL") {
    const id = await db.transaction(async (tx) => {
      const [signal] = await tx.insert(schema.signals).values({ workspaceId: actor.workspaceId, setupId, observation: item.observation, relevanceHypothesis: item.relevanceHypothesis || (purpose && !linkedOpp ? `Wofür: ${purpose}` : null), opportunityId: linkedOpp?.id ?? null, status: "NEU", sourceId, createdBy: actor.userId }).returning();
      if (!signal) throw new Error("Beobachtung");
      const [assertion] = await tx.insert(schema.assertions).values({ workspaceId: actor.workspaceId, setupId, subjectType: "SETUP", subjectId: setupId, content: item.observation, epistemicStatus: "AUSSAGE_WIEDERGEGEBEN", createdBy: actor.userId }).returning();
      if (assertion) await tx.insert(schema.assertionEvidence).values({ assertionId: assertion.id, sourceId, excerpt: item.observation.slice(0, 500) });
      await recordAudit(tx, actor, "signal.created", "SIGNAL", signal.id, { setupId, herkunft: "ASSISTENT" });
      return signal.id;
    });
    return { type: "SIGNAL", id, note: `Beobachtung (neu) angelegt.${purposeNote}` };
  }
  if (item.type === "CHANCE") {
    const opp = await createOpportunity(actor, { setupId, title: item.title, needDescription: item.needDescription, trigger: origin, kind: item.kind, roleName: item.roleName, headcount: item.headcount ?? undefined, horizon: item.horizon, anticipated: item.anticipated });
    return { type: "OPPORTUNITY", id: opp.id, note: `Chance (${item.anticipated ? "antizipiert" : "in Klärung"}) angelegt${item.roleName ? ` – Rolle „${item.roleName}“` : ""}.` };
  }
  if (item.type === "AKTION") {
    const id = await db.transaction(async (tx) => insertSuggestionCard(tx, actor, setupId, sourceId, origin, { type: "AKTION", title: item.title.slice(0, 200), targetRole: item.ownerRole, observation: item.description || item.title, evidenceQuote: item.evidenceQuote, nextStep: item.title, whyNow: item.dueHint ? `Frist/Hinweis: ${item.dueHint}` : "", uncertainty: "Vorschlag aus dem Assistenten – erst die Annahme macht daraus eine Aufgabe.", priority: "KONKRETE_ANFRAGE", opportunityId: linkedOpp?.id ?? null, purpose }));
    return { type: "SUGGESTION", id, note: `Als Vorschlag für ${item.ownerRole} in „Meine Arbeit“ abgelegt.${purposeNote}` };
  }
  if (item.type === "KONTAKT") {
    const id = await db.transaction(async (tx) => insertSuggestionCard(tx, actor, setupId, sourceId, origin, { type: "KONTAKTAUFNAHME", title: `Kontaktaufnahme ${item.personName}`.slice(0, 200), targetRole: "ANKER", observation: item.occasion, evidenceQuote: item.evidenceQuote, hypothesis: item.viaVerveName ? `Möglicher Weg: über ${item.viaVerveName}` : "", nextStep: item.draftMessage, mentionedPersonName: item.personName, uncertainty: "Entwurf zum Bearbeiten – wird nie automatisch versendet.", priority: "ZUGANGSLUECKE", opportunityId: linkedOpp?.id ?? null, purpose }));
    return { type: "SUGGESTION", id, note: `Als Kontaktaufnahme-Vorschlag für den Anker abgelegt.${purposeNote}` };
  }
  if (item.type === "FRAGE") {
    const id = await db.transaction(async (tx) => insertSuggestionCard(tx, actor, setupId, sourceId, origin, { type: "OFFENE_FRAGE", title: item.question.slice(0, 200), targetRole: "BD", observation: item.question, evidenceQuote: item.evidenceQuote, proposedQuestion: item.question, uncertainty: "Vor der Bestätigung zu klären.", priority: "NEUE_INFORMATION", opportunityId: linkedOpp?.id ?? null, purpose }));
    return { type: "SUGGESTION", id, note: `Als offene Frage vorgemerkt.${purposeNote}` };
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
