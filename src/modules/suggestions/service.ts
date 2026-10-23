import { createHash } from "node:crypto";
import { and, count, desc, eq, gte, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { PriorityCategory, SuggestionStatus } from "@/db/schema";
import { getConfig } from "@/lib/config";
import { ConflictError, DomainError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { loadActor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, canViewSource, loadSetupContext, type SetupContext } from "@/modules/identity/authz";
import { getAIProvider } from "@/modules/ai";
import { STRUCTURE_NOTE_PROMPT_VERSION, type AIProvider, type StructureNoteInput, type TaskOptions } from "@/modules/ai/provider";
import { resolveTaskOptions } from "@/modules/ai/settings";
import { structureNoteOutputSchema, type StructuredItem } from "@/modules/ai/schemas";
import { requireReview } from "@/modules/reviews/service";
import { captureObservation } from "@/modules/signals/service";
import { createAction } from "@/modules/actions/service";
import { addDecision } from "@/modules/reviews/service";

/**
 * Vorschläge (Briefing 14): Verarbeitungskette
 *   Ereignis → berechtigten Kontext laden → regelbasierte Prüfung → KI-Ausgabe → Schema-/Quellenprüfung
 *   → Berechtigung erneut prüfen → Vorschlag speichern → menschliche Entscheidung.
 * Das Modell löst keine Datenbankänderungen aus; erst die Annahme durch eine Person erzeugt Objekte –
 * und zwar in ungeprüften Zuständen („Prüfe, ob Bedarf besteht“ erzeugt nie „Bedarf bestätigt“).
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[„“"'.,;:!?()]/g, "").trim();

/** Laufende Einsätze eines Kunden als Kontext für die KI (Kürzel E1, E2 …) – nur Person, Rolle, Ende, Verlängerungsstand. */
export async function engagementContext(accountId: string) {
  const engs = await db.query.engagements.findMany({ where: and(eq(schema.engagements.accountId, accountId), inArray(schema.engagements.status, ["GEPLANT", "AKTIV", "PAUSIERT", "ENDET"])), orderBy: [schema.engagements.plannedEnd] });
  if (!engs.length) return [];
  const [fls, us, renewals] = await Promise.all([
    db.query.freelancers.findMany({ where: inArray(schema.freelancers.id, [...engs.map((e) => e.freelancerId).filter((x): x is string => !!x), "-"]), columns: { id: true, displayName: true } }),
    db.query.users.findMany({ where: inArray(schema.users.id, [...engs.map((e) => e.internalUserId).filter((x): x is string => !!x), "-"]), columns: { id: true, displayName: true } }),
    db.query.renewalDecisions.findMany({ where: and(inArray(schema.renewalDecisions.engagementId, engs.map((e) => e.id)), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])) }),
  ]);
  const name = (e: (typeof engs)[number]) => (e.freelancerId ? fls.find((f) => f.id === e.freelancerId)?.displayName : e.internalUserId ? us.find((u) => u.id === e.internalUserId)?.displayName : null) ?? e.title.split(" – ").pop() ?? e.title;
  const label: Record<string, string> = { ZU_KLAEREN: "zu klären", IN_ABSTIMMUNG: "in Abstimmung", ANGEBOTEN: "angeboten" };
  return engs.map((e, i) => {
    const r = renewals.find((x) => x.engagementId === e.id);
    return { ref: `E${i + 1}`, id: e.id, opportunityId: e.opportunityId, person: name(e).replace(/\s*\((fiktiv|intern)\)\s*/gi, " ").trim(), title: e.title, plannedEnd: e.plannedEnd, renewal: r ? `${label[r.status] ?? r.status}${r.proposedTo ? ` bis ${r.proposedTo}` : ""}` : null };
  });
}

/** Rückfall, wenn die KI keinen Einsatz nennt: eindeutiger Treffer über den Nachnamen der Person im Text. */
export function matchEngagementByName<T extends { person: string }>(engs: T[], text: string): T | null {
  const t = text.toLowerCase();
  const hits = engs.filter((e) => {
    const parts = e.person.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    const last = parts[parts.length - 1];
    return !!last && new RegExp(`\\b${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t);
  });
  return hits.length === 1 ? hits[0]! : null;
}

export class UsageLimitError extends DomainError {
  constructor(limit: number) {
    super("AI_LIMIT", `Die tägliche Nutzungsgrenze für KI-Aufträge (${limit}) ist erreicht. Manuelle Dokumentation ist weiterhin möglich.`, 429);
  }
}

export function getProviderStatus() {
  const info = getAIProvider().info();
  return { ...info, promptVersion: STRUCTURE_NOTE_PROMPT_VERSION, dailyLimit: getConfig().AI_DAILY_JOB_LIMIT };
}

/** Priorisierung nach transparenten Kategorien (14.3) – keine KI-Scores. */
export function categorize(item: StructuredItem): PriorityCategory {
  if (item.type === "VERLAENGERUNG") return "KONKRETE_ANFRAGE";
  if (item.type === "KONFLIKT") return "PLANUNGSANLASS";
  if (item.type === "KONTAKTAUFNAHME") return "ZUGANGSLUECKE";
  if (item.type === "AKTION" && /termin|bis \d|deadline|frist|anfrage|angefragt/i.test(item.observation)) return "KONKRETE_ANFRAGE";
  if (item.type === "OFFENE_FRAGE" && /wer (entscheidet|koordiniert|plant|verantwortet)|zuständig/i.test(item.observation)) return "ZUGANGSLUECKE";
  if (item.type === "PERSON") return "ZUGANGSLUECKE";
  if (/verlänger|nächste phase|laufzeit|planung/i.test(item.observation)) return "PLANUNGSANLASS";
  if (item.type === "BEOBACHTUNG" || item.type === "ENTSCHEIDUNG") return "NEUE_INFORMATION";
  return "VERBESSERUNGSIDEE";
}

const CATEGORY_ORDER: Record<PriorityCategory, number> = { KONKRETE_ANFRAGE: 0, BLOCKIERTE_AKTION: 1, NEUE_INFORMATION: 2, ZUGANGSLUECKE: 3, PLANUNGSANLASS: 4, VERBESSERUNGSIDEE: 5 };

/**
 * Weekly-Notiz strukturieren. Rechte: Teilnehmende bzw. Setup-Bearbeitende. Die Notiz ist die einzige Rohquelle,
 * die der Anbieter erhält; dazu kommen nur Anzeigenamen und bestätigte Aussagen als Text.
 */
export async function structureReviewNote(actor: Actor, reviewId: string, deps: { provider?: AIProvider } = {}) {
  const { review, ctx, participants, canWork } = await requireReview(actor, reviewId);
  if (!canWork) throw new ForbiddenError("Nur Teilnehmende oder Setup-Bearbeitende strukturieren die Notiz.");
  if (review.status === "BESTAETIGT") throw new TransitionError("Ein bestätigtes Weekly wird nicht mehr strukturiert.");
  const noteText = (review.noteDraft ?? "").trim();
  if (noteText.length < 12) throw new ValidationError("Die Notiz ist leer oder zu kurz, um sie zu strukturieren.");
  return structureText(actor, ctx, {
    text: noteText,
    dedupeScope: reviewId,
    reviewId,
    sourceIds: [],
    trigger: `Weekly-Notiz „${review.title}“`,
    participantUserIds: participants.map((p) => p.userId),
  }, deps);
}

/**
 * Eine Quelle im Setup (z. B. hochgeladenes Dokument) strukturieren. Rechte: Setup-Bearbeitende mit Leserecht
 * auf die Quelle. Der Anbieter erhält nur den Quellentext.
 */
export async function structureSource(actor: Actor, sourceId: string, deps: { provider?: AIProvider } = {}) {
  const source = await db.query.sources.findFirst({ where: and(eq(schema.sources.id, sourceId), eq(schema.sources.workspaceId, actor.workspaceId)) });
  if (!source || !source.setupId) throw new NotFoundError("Quelle");
  const ctx = await loadSetupContext(actor, source.setupId);
  if (!ctx || !canViewSource(actor, source, ctx)) throw new NotFoundError("Quelle");
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Nur Setup-Bearbeitende strukturieren Quellen.");
  if (source.isLocked) throw new TransitionError("Eine gesperrte Quelle wird nicht strukturiert.");
  const text = (source.body ?? "").trim();
  if (text.length < 12) throw new ValidationError("Die Quelle enthält keinen Text, der strukturiert werden könnte.");
  const members = await db.query.setupMemberships.findMany({ where: eq(schema.setupMemberships.setupId, ctx.setup.id) });
  return structureText(actor, ctx, {
    text,
    dedupeScope: `source:${source.id}`,
    sourceIds: [source.id],
    trigger: `${source.type === "DOKUMENT" ? "Dokument" : "Quelle"} „${source.title}“`,
    participantUserIds: Array.from(new Set([actor.userId, ...members.map((m) => m.userId)])),
  }, deps);
}

export const smartDumpInput = z.object({
  setupId: z.string().min(1, "Setup fehlt"),
  text: z.string().trim().min(12, "Bitte mehr Text einfügen (mind. 12 Zeichen).").max(20000),
  title: z.string().trim().max(200).optional().or(z.literal("")),
});

/**
 * Smart-Dump (Etappe 16, Anker-Wunsch): beliebigen Text direkt einfügen – ohne den Umweg über eine eigene
 * Quellen-Unterseite. Legt eine NOTIZ-Quelle an und strukturiert sie sofort (dieselbe Kette wie bei einem
 * hochgeladenen Dokument): die KI schlägt nur Karten mit wörtlicher Textstelle vor, gespeichert wird nichts
 * automatisch. Rechte wie bei jeder Quelle: nur Setup-Bearbeitende.
 */
export async function smartDump(actor: Actor, raw: unknown, deps: { provider?: AIProvider } = {}) {
  const parsed = smartDumpInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const ctx = await loadSetupContext(actor, input.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Nur Setup-Bearbeitende können einen Smart-Dump erfassen.");
  const title = input.title || `Smart-Dump ${new Date().toISOString().slice(0, 10)}`;
  const [source] = await db
    .insert(schema.sources)
    .values({ workspaceId: actor.workspaceId, setupId: ctx.setup.id, type: "NOTIZ", title, body: input.text, origin: "Smart-Dump", sourceTime: new Date(), ownerUserId: actor.userId, accessClass: "SETUP" })
    .returning();
  if (!source) throw new Error("Quelle");
  const result = await structureSource(actor, source.id, deps);
  return { sourceId: source.id, ...result };
}

export type StructureTextInput = {
  text: string;
  /** Idempotenz-Bereich des Auftrags (z. B. Review-ID oder Import-ID) */
  dedupeScope: string;
  reviewId?: string;
  sourceIds: string[];
  trigger: string;
  participantUserIds: string[];
};

/**
 * Gemeinsame Verarbeitungskette für Weekly-Notizen und importierte Quellen (Briefing 14.4).
 * Der Anbieter erhält nur den Text, Anzeigenamen und bestätigte Aussagen – keine weiteren Rohquellen.
 */
export async function structureText(actor: Actor, ctx: SetupContext, input0: StructureTextInput, deps: { provider?: AIProvider } = {}) {
  const cfg = getConfig();
  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  const noteText = input0.text.trim();
  if (noteText.length < 12) throw new ValidationError("Der Text ist leer oder zu kurz, um ihn zu strukturieren.");

  // Nutzungsgrenze je Arbeitsraum und Tag (17.4)
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const [cnt] = await db.select({ n: count() }).from(schema.aiJobs).where(and(eq(schema.aiJobs.workspaceId, actor.workspaceId), gte(schema.aiJobs.startedAt, since)));
  if (Number(cnt?.n ?? 0) >= cfg.AI_DAILY_JOB_LIMIT) throw new UsageLimitError(cfg.AI_DAILY_JOB_LIMIT);

  // Berechtigten Kontext laden (nur Namen/Texte, keine Rohquellen)
  const participantIds = input0.participantUserIds.length ? input0.participantUserIds : [actor.userId];
  const [users, persons, confirmed, engContext, workspaceUsers] = await Promise.all([
    db.query.users.findMany({ where: inArray(schema.users.id, participantIds) }),
    db.query.persons.findMany({ where: eq(schema.persons.accountId, ctx.account.id) }),
    db.query.assertions.findMany({ where: and(eq(schema.assertions.setupId, ctx.setup.id), eq(schema.assertions.epistemicStatus, "SACHVERHALT_BESTAETIGT")) }),
    engagementContext(ctx.account.id),
    db.query.users.findMany({ where: eq(schema.users.workspaceId, actor.workspaceId), columns: { displayName: true, email: true } }),
  ]);
  const functions = persons.length ? await db.query.personFunctions.findMany({ where: inArray(schema.personFunctions.personId, persons.map((p) => p.id)) }) : [];
  const currentFunction = (pid: string) => functions.filter((f) => f.personId === pid && !f.validTo).map((f) => f.functionTitle)[0] ?? null;
  const input: StructureNoteInput = {
    noteText,
    setupName: ctx.setup.name,
    participantNames: users.map((u) => u.displayName),
    knownPersonNames: persons.map((p) => p.displayName),
    knownPersons: persons.map((p) => ({ name: p.displayName, functionTitle: currentFunction(p.id) })),
    confirmedAssertions: confirmed.map((a) => a.content),
    engagements: engContext.map((e) => ({ ref: e.ref, person: e.person, title: e.title, plannedEnd: e.plannedEnd, renewal: e.renewal })),
  };
  const inputHash = sha(noteText);
  const jobDedupe = sha(`${input0.dedupeScope}:${inputHash}:${STRUCTURE_NOTE_PROMPT_VERSION}`);
  // Modellwahl je Aufgabe (Verwaltung → KI); Anbieter ohne Modellwahl ignorieren sie
  const taskOpts: TaskOptions = await resolveTaskOptions(actor.workspaceId, "STRUCTURE_NOTE", info.id);
  const modelLabel = taskOpts.model ?? info.model;

  const prior = await db.query.aiJobs.findFirst({ where: and(eq(schema.aiJobs.dedupeKey, jobDedupe), eq(schema.aiJobs.status, "ERFOLGREICH")) });
  if (prior) return { job: prior, created: 0, skipped: 0, rejected: 0, repeated: true, noSuggestionReason: "" };

  const [job] = await db
    .insert(schema.aiJobs)
    .values({ workspaceId: actor.workspaceId, type: "STRUCTURE_NOTE", actorUserId: actor.userId, setupId: ctx.setup.id, reviewId: input0.reviewId ?? null, provider: info.id, model: modelLabel, promptVersion: STRUCTURE_NOTE_PROMPT_VERSION, inputHash, inputChars: noteText.length, dedupeKey: jobDedupe })
    .returning();
  if (!job) throw new Error("KI-Auftrag konnte nicht angelegt werden");

  let raw: unknown;
  try {
    raw = await provider.structureNote(input, taskOpts);
  } catch (e) {
    await db.update(schema.aiJobs).set({ status: "ABGELEHNT", error: e instanceof Error ? e.message.slice(0, 300) : "Anbieterfehler", finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    throw e;
  }

  const usage = provider.lastUsage?.() ?? null;
  if (usage) await db.update(schema.aiJobs).set({ tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, model: usage.model || modelLabel }).where(eq(schema.aiJobs.id, job.id));
  const parsed = structureNoteOutputSchema.safeParse(raw);
  if (!parsed.success) {
    await db.update(schema.aiJobs).set({ status: "FEHLER", error: "Ausgabe entspricht nicht dem Schema", finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    throw new ValidationError("Die KI-Ausgabe entspricht nicht dem Ausgabeschema und wurde verworfen.");
  }
  const valid: StructuredItem[] = [];
  let rejected = 0;
  // Beleg wörtlich – aber tolerant gegenüber Leerraum (E-Mails enthalten geschützte Leerzeichen und Umbrüche)
  const ws = (t: string) => t.replace(/[\s\u00a0\u200b]+/g, " ").trim();
  const noteFlat = ws(noteText);
  const verveNames = new Set(workspaceUsers.map((u) => normalize(u.displayName.replace(/\(.*?\)/g, ""))));
  const ownDomains = new Set(workspaceUsers.map((u) => u.email.split("@")[1]?.toLowerCase()).filter((d): d is string => !!d && !/example$/.test(d)));
  const verveLast = new Set([...verveNames].map((n) => n.split(" ").pop()!).filter((n) => n.length >= 3));
  const isVerve = (name: string, email: string) => {
    const n = normalize(name.replace(/\(.*?\)/g, ""));
    const titled = /^(frau|herr|fr|hr)\s+/.test(n);
    const bare = n.replace(/^(frau|herr|fr|hr)\s+/, "");
    return (!!bare && verveNames.has(bare)) || (titled && verveLast.has(bare.split(" ").pop() ?? "")) || (!!email && ownDomains.has(email.split("@")[1]?.toLowerCase() ?? "")) || /verve/i.test(email);
  };
  for (const item of parsed.data.items) {
    if (!noteFlat.includes(ws(item.evidenceQuote)) || (item.proposedOwnerName && !input.participantNames.includes(item.proposedOwnerName))) {
      rejected++;
      continue;
    }
    // Verve-Personen sind keine Kundenpersonen
    if (item.type === "PERSON" && isVerve(item.mentionedPersonName, item.mentionedPersonEmail)) {
      rejected++;
      continue;
    }
    if (item.mentionedPersonEmail && !noteFlat.toLowerCase().includes(item.mentionedPersonEmail.toLowerCase())) item.mentionedPersonEmail = "";
    if (item.proposedEnd && !/^\d{4}-\d{2}-\d{2}$/.test(item.proposedEnd)) item.proposedEnd = "";
    // Einsatzbezug auflösen; Verlängerung ohne eindeutigen Einsatz → Beobachtung
    let eng = item.engagementRef ? engContext.find((e) => e.ref === item.engagementRef.trim().toUpperCase()) ?? null : null;
    if (!eng && item.type === "VERLAENGERUNG") eng = matchEngagementByName(engContext, `${item.title} ${item.observation} ${item.evidenceQuote}`);
    item.engagementRef = eng?.id ?? "";
    if (item.type === "VERLAENGERUNG" && !eng) {
      item.type = "BEOBACHTUNG";
      item.uncertainty = `${item.uncertainty ? `${item.uncertainty} ` : ""}Kein laufender Einsatz eindeutig zuzuordnen.`.trim();
    }
    valid.push(item);
  }

  // Berechtigung erneut prüfen (S05)
  const fresh = await loadActor(actor.userId);
  const freshCtx = fresh ? await loadSetupContext(fresh, ctx.setup.id) : null;
  if (!fresh || !freshCtx || !canViewSetup(fresh, freshCtx)) {
    await db.update(schema.aiJobs).set({ status: "ABGELEHNT", error: "Berechtigung während der Verarbeitung entzogen", finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    throw new ForbiddenError("Ihre Berechtigung hat sich während der Verarbeitung geändert; es wurde nichts gespeichert.");
  }

  const nameToUser = new Map(users.map((u) => [u.displayName, u.id]));
  // Wofür (E-045): aktive Chancen des Setups; eine einzige Chance ist das Wofür aller Vorschläge, sonst unscharf nach Titelwörtern
  const chances = (await db.query.opportunities.findMany({ where: eq(schema.opportunities.setupId, ctx.setup.id) })).filter((o) => !["ZURUECKGESTELLT", "BEENDET"].includes(o.status));
  const purposeFor = (text: string): { id: string | null; purpose: string | null } => {
    if (chances.length === 1) return { id: chances[0]!.id, purpose: chances[0]!.title };
    const t = text.toLowerCase();
    const hit = chances.find((c) => c.title.toLowerCase().split(/\s+/).filter((w) => w.length > 4).some((w) => t.includes(w)));
    return hit ? { id: hit.id, purpose: hit.title } : { id: null, purpose: null };
  };
  let created = 0;
  let skipped = 0;
  await db.transaction(async (tx) => {
    for (const item of valid) {
      const dedupeKey = sha(`${item.type}:${item.type === "PERSON" ? normalize(item.mentionedPersonName) + ":" : ""}${normalize(item.evidenceQuote)}`);
      const wofuer = purposeFor(`${item.title} ${item.observation} ${item.evidenceQuote}`);
      const existing = await tx.query.suggestions.findFirst({ where: and(eq(schema.suggestions.setupId, ctx.setup.id), eq(schema.suggestions.dedupeKey, dedupeKey)) });
      if (existing) {
        skipped++;
        continue;
      }
      await tx.insert(schema.suggestions).values({
        workspaceId: actor.workspaceId,
        type: item.type,
        title: item.title,
        opportunityId: item.engagementRef ? (engContext.find((e) => e.id === item.engagementRef)?.opportunityId ?? wofuer.id) : wofuer.id,
        purpose: item.engagementRef ? `Einsatz ${engContext.find((e) => e.id === item.engagementRef)?.title ?? ""}`.trim() : wofuer.purpose,
        targetRole: item.type === "PERSON" || item.type === "OFFENE_FRAGE" || item.type === "VERLAENGERUNG" ? "BD" : "TEILNEHMENDE",
        setupId: ctx.setup.id,
        reviewId: input0.reviewId ?? null,
        trigger: input0.trigger,
        sourceIds: input0.sourceIds,
        evidenceQuote: item.evidenceQuote,
        observation: item.observation,
        hypothesis: item.hypothesis || null,
        uncertainty: item.uncertainty || null,
        whyNow: item.whyNow || null,
        nextStep: item.nextStep || null,
        proposedQuestion: item.proposedQuestion || null,
        expectedResult: item.expectedResult || null,
        proposedOwnerUserId: item.proposedOwnerName ? nameToUser.get(item.proposedOwnerName) ?? null : null,
        mentionedPersonName: item.mentionedPersonName || null,
        mentionedPersonRole: item.mentionedPersonRole || null,
        mentionedPersonUnit: item.mentionedPersonUnit || null,
        mentionedPersonEmail: item.mentionedPersonEmail || null,
        objectType: item.engagementRef ? "ENGAGEMENT" : null,
        objectId: item.engagementRef || null,
        proposedDate: item.proposedEnd || null,
        conditionsNote: item.conditionsNote || null,
        priorityCategory: categorize(item),
        dedupeKey,
        recheckTrigger: "Neue Notiz oder neue Quelle im Setup",
        provider: info.id,
        model: usage?.model || modelLabel,
        promptVersion: STRUCTURE_NOTE_PROMPT_VERSION,
        aiJobId: job.id,
      });
      created++;
    }
    await tx.update(schema.aiJobs).set({ status: "ERFOLGREICH", itemCount: created, rejectedCount: rejected, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    await recordAudit(tx, actor, "ai.structure_text", input0.reviewId ? "REVIEW" : "SETUP", input0.reviewId ?? ctx.setup.id, { erzeugt: created, uebersprungen: skipped, zurueckgewiesen: rejected, provider: info.id });
  });
  return { job, created, skipped, rejected, repeated: false, noSuggestionReason: parsed.data.noSuggestionReason };
}

// ---------------------------------------------------------------------------
// Menschliche Entscheidung
// ---------------------------------------------------------------------------

async function requireSuggestion(actor: Actor, id: string) {
  const s = await db.query.suggestions.findFirst({ where: and(eq(schema.suggestions.id, id), eq(schema.suggestions.workspaceId, actor.workspaceId)) });
  if (!s) throw new NotFoundError("Vorschlag");
  const ctx = await loadSetupContext(actor, s.setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Vorschlag");
  return { suggestion: s, ctx };
}

const transitions: Record<SuggestionStatus, SuggestionStatus[]> = {
  NEU: ["GEPRUEFT", "ANGENOMMEN", "VERAENDERT", "ZURUECKGESTELLT", "ABGELEHNT", "UEBERHOLT"],
  GEPRUEFT: ["ANGENOMMEN", "VERAENDERT", "ZURUECKGESTELLT", "ABGELEHNT", "UEBERHOLT"],
  ZURUECKGESTELLT: ["GEPRUEFT", "ANGENOMMEN", "VERAENDERT", "ABGELEHNT", "UEBERHOLT"],
  ANGENOMMEN: ["ERLEDIGT", "UEBERHOLT"],
  VERAENDERT: ["ERLEDIGT", "UEBERHOLT"],
  ABGELEHNT: [],
  ERLEDIGT: [],
  UEBERHOLT: [],
};

export const acceptInput = z.object({
  version: z.coerce.number().int().positive(),
  /** Bearbeiteter Text (→ Status „verändert“), sonst Vorschlagstext */
  editedText: z.string().trim().max(4000).optional().or(z.literal("")),
  ownerUserId: z.string().optional().or(z.literal("")),
  /** VERLAENGERUNG: neues Ende (vorbelegt aus dem Text bzw. +12 Monate) und Vertragsfolge */
  newEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Neues Ende als Datum angeben").optional().or(z.literal("")),
  contractFollowUp: z.string().trim().max(200).optional().or(z.literal("")),
});

/**
 * Annahme erzeugt das passende Objekt – stets im ungeprüften Zustand:
 * BEOBACHTUNG/KONFLIKT → Hinweis (neu) mit Aussage „wiedergegeben“/„Hypothese“; AKTION → Aktion „vorgeschlagen“;
 * ENTSCHEIDUNG → Entscheidung (nur wenn das Weekly noch offen ist); OFFENE_FRAGE → offene Frage; PERSON → offene Frage nach Funktion.
 * Die Annahme bestätigt nicht die Hypothese (14.5).
 */
export async function acceptSuggestion(actor: Actor, id: string, raw: unknown) {
  const parsed = acceptInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { suggestion: s, ctx } = await requireSuggestion(actor, id);
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError();
  const target: SuggestionStatus = input.editedText ? "VERAENDERT" : "ANGENOMMEN";
  if (!transitions[s.status].includes(target)) throw new TransitionError(`Vorschlag ist „${s.status}“ und kann nicht mehr angenommen werden.`);
  const text = input.editedText || s.observation;

  let acceptedObjectType = "";
  let acceptedObjectId = "";
  let message = "";
  if (s.type === "VERLAENGERUNG") {
    const r = await acceptRenewalSuggestion(actor, s, input.newEnd || s.proposedDate || "", input.contractFollowUp || "", input.editedText || "");
    acceptedObjectType = "RENEWAL";
    acceptedObjectId = r.decisionId;
    message = r.message;
  } else if (s.type === "PERSON" && (s.mentionedPersonRole || s.mentionedPersonUnit || s.mentionedPersonEmail)) {
    const r = await acceptPersonSuggestion(actor, s, ctx);
    acceptedObjectType = "PERSON";
    acceptedObjectId = r.personId;
    message = r.message;
  } else if (s.type === "BEOBACHTUNG" || s.type === "KONFLIKT") {
    const { signal } = await captureObservation(actor, {
      setupId: s.setupId,
      observation: text,
      relevanceHypothesis: s.hypothesis ?? "",
      usageLimit: s.type === "KONFLIKT" ? "Widerspruch zu bestätigter Aussage – beide Angaben bleiben sichtbar." : "",
      sourceTitle: `Aus Weekly-Notiz strukturiert (${s.provider})`,
      reviewId: s.reviewId ?? "",
    });
    acceptedObjectType = "SIGNAL";
    acceptedObjectId = signal.id;
  } else if (s.type === "AKTION") {
    const owner = input.ownerUserId || s.proposedOwnerUserId || actor.userId;
    // Nie „vereinbart“ aus einem Vorschlag: Aktion startet als Vorschlag (außer der Akteur übernimmt sie selbst)
    const a = await createAction(actor, { setupId: s.setupId, title: text.slice(0, 300), ownerUserId: owner, reviewId: s.reviewId ?? "", agreedInConversation: false, opportunityId: s.opportunityId ?? "" });
    acceptedObjectType = "ACTION";
    acceptedObjectId = a.id;
  } else if (s.type === "KONTAKTAUFNAHME") {
    // Kontaktaufnahme → Aktion für den Anker/BD mit dem Entwurf als Vereinbarungstext; Versand bleibt Handarbeit
    const owner = input.ownerUserId || s.proposedOwnerUserId || actor.userId;
    const a = await createAction(actor, { setupId: s.setupId, title: `Kontaktaufnahme ${s.mentionedPersonName ?? ""}: ${text}`.slice(0, 300), agreement: (s.nextStep ?? "").slice(0, 2000), ownerUserId: owner, agreedInConversation: false, opportunityId: s.opportunityId ?? "" });
    acceptedObjectType = "ACTION";
    acceptedObjectId = a.id;
  } else if (s.type === "ENTSCHEIDUNG") {
    if (!s.reviewId) throw new ValidationError("Entscheidungen brauchen ein Weekly.");
    const d = await addDecision(actor, { reviewId: s.reviewId, content: text, rationale: "Aus Weekly-Notiz strukturiert; Prüfung durch Teilnehmende bei Bestätigung des Weeklys." });
    acceptedObjectType = "DECISION";
    acceptedObjectId = d.id;
  } else {
    const [q] = await db
      .insert(schema.openQuestions)
      .values({
        workspaceId: actor.workspaceId,
        setupId: s.setupId,
        opportunityId: s.opportunityId ?? null,
        question: s.type === "PERSON" ? `Welche Funktion und Zuständigkeit hat ${s.mentionedPersonName ?? "die genannte Person"}? (${text})` : text,
        decisionImpact: s.uncertainty ?? null,
        possibleSource: s.nextStep ?? null,
        ownerUserId: input.ownerUserId || s.proposedOwnerUserId || null,
        createdBy: actor.userId,
      })
      .returning();
    if (!q) throw new Error("Offene Frage konnte nicht angelegt werden");
    acceptedObjectType = "OPEN_QUESTION";
    acceptedObjectId = q.id;
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.suggestions)
      .set({ status: target, decidedBy: actor.userId, decidedAt: new Date(), acceptedObjectType, acceptedObjectId, version: input.version + 1 })
      .where(and(eq(schema.suggestions.id, id), eq(schema.suggestions.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    await recordAudit(tx, actor, "suggestion.accepted", "SUGGESTION", id, { status: target, objekt: acceptedObjectType });
    return { suggestion: updated, acceptedObjectType, acceptedObjectId, message };
  });
}

export const feedbackInput = z.object({
  version: z.coerce.number().int().positive(),
  status: z.enum(["GEPRUEFT", "ZURUECKGESTELLT", "ABGELEHNT", "ERLEDIGT", "UEBERHOLT"]),
  feedbackReason: z.enum(schema.feedbackReasonEnum.enumValues).optional().or(z.literal("")),
  feedbackNote: z.string().trim().max(1000).optional().or(z.literal("")),
});

export async function giveFeedback(actor: Actor, id: string, raw: unknown) {
  const parsed = feedbackInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const { suggestion: s, ctx } = await requireSuggestion(actor, id);
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError();
  if (!transitions[s.status].includes(input.status)) throw new TransitionError(`Übergang von „${s.status}“ nach „${input.status}“ ist nicht vorgesehen.`);
  if (input.status === "ABGELEHNT" && !input.feedbackReason) throw new ValidationError("Bitte einen Ablehnungsgrund wählen (hilft, Wiederholungen zu vermeiden).");
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.suggestions)
      .set({ status: input.status, feedbackReason: input.feedbackReason || null, feedbackNote: input.feedbackNote || null, decidedBy: actor.userId, decidedAt: new Date(), version: input.version + 1 })
      .where(and(eq(schema.suggestions.id, id), eq(schema.suggestions.version, input.version)))
      .returning();
    if (!updated) throw new ConflictError();
    await recordAudit(tx, actor, "suggestion.feedback", "SUGGESTION", id, { status: input.status, grund: input.feedbackReason || null });
    return updated;
  });
}

/** Offene Vorschläge eines Setups, nach Kategorie priorisiert; die ersten `prominent` werden hervorgehoben (max. 3). */
export async function listSuggestionsForSetup(actor: Actor, setupId: string, opts: { reviewId?: string } = {}) {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  const rows = await db.query.suggestions.findMany({
    where: and(eq(schema.suggestions.setupId, setupId), opts.reviewId ? eq(schema.suggestions.reviewId, opts.reviewId) : undefined),
    orderBy: desc(schema.suggestions.computedAt),
  });
  const open = rows.filter((r) => r.status === "NEU" || r.status === "GEPRUEFT" || r.status === "ZURUECKGESTELLT").sort((a, b) => CATEGORY_ORDER[a.priorityCategory] - CATEGORY_ORDER[b.priorityCategory] || b.computedAt.getTime() - a.computedAt.getTime());
  const decided = rows.filter((r) => !open.includes(r));
  const userIds = [...new Set(rows.flatMap((r) => [r.proposedOwnerUserId, r.decidedBy].filter((x): x is string => !!x)))];
  const users = userIds.length ? await db.query.users.findMany({ where: inArray(schema.users.id, userIds) }) : [];
  const un = new Map(users.map((u) => [u.id, u.displayName]));
  return { prominent: open.slice(0, 3), more: open.slice(3), decided, userNames: un, canDecide: canEditSetup(actor, ctx) };
}

/** Vorschläge für „Meine Arbeit“: offene Vorschläge in Setups, die der Akteur bearbeitet, bevorzugt an ihn adressiert. */
export async function listMySuggestions(actor: Actor) {
  const rows = await db.query.suggestions.findMany({
    where: and(eq(schema.suggestions.workspaceId, actor.workspaceId), or(eq(schema.suggestions.status, "NEU"), eq(schema.suggestions.status, "GEPRUEFT"))),
    orderBy: desc(schema.suggestions.computedAt),
  });
  const out = [];
  const cache = new Map<string, SetupContext | null>();
  for (const r of rows) {
    let ctx = cache.get(r.setupId);
    if (ctx === undefined) {
      ctx = await loadSetupContext(actor, r.setupId);
      cache.set(r.setupId, ctx);
    }
    if (ctx && canEditSetup(actor, ctx)) out.push({ ...r, setupName: ctx.setup.name, addressed: r.proposedOwnerUserId === actor.userId });
  }
  out.sort((a, b) => Number(b.addressed) - Number(a.addressed) || CATEGORY_ORDER[a.priorityCategory] - CATEGORY_ORDER[b.priorityCategory]);
  return out.slice(0, 10);
}

export async function listOpenQuestionsForSetup(setupId: string) {
  return db.query.openQuestions.findMany({ where: and(eq(schema.openQuestions.setupId, setupId), ne(schema.openQuestions.status, "BEANTWORTET")), orderBy: desc(schema.openQuestions.createdAt) });
}

/**
 * „Als Chance übernehmen“ (Etappe 34): eine KI-Beobachtung, die einen konkreten Bedarf beschreibt, mit einem Klick
 * als Chance „in Klärung“ anlegen. Die Beobachtung entsteht wie bei „Annehmen“ und bleibt als Herkunft verknüpft.
 */
export async function acceptSuggestionAsChance(actor: Actor, id: string, raw: unknown) {
  const { suggestion: s } = await requireSuggestion(actor, id);
  if (s.type !== "BEOBACHTUNG") throw new ValidationError("Nur eine Beobachtung lässt sich als Chance übernehmen.");
  const data = (raw ?? {}) as Record<string, unknown>;
  const edited = typeof data.editedText === "string" ? data.editedText.trim() : "";
  const res = await acceptSuggestion(actor, id, { version: data.version, editedText: edited });
  const { createOpportunity } = await import("@/modules/opportunities/service");
  const title = (typeof data.chanceTitle === "string" && data.chanceTitle.trim().length >= 3 ? data.chanceTitle.trim() : s.title).slice(0, 200);
  const need = (edited || s.observation).padEnd(10, ".").slice(0, 4000);
  const opp = await createOpportunity(actor, { setupId: s.setupId, title, needDescription: need, signalId: res.acceptedObjectId, trigger: s.evidenceQuote ? `„${s.evidenceQuote}“` : "" });
  return { ...res, opportunity: opp };
}

type SuggestionRow = typeof schema.suggestions.$inferSelect;

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Vorbelegung für das neue Ende einer Verlängerungskarte: Datum aus dem Text, sonst heutiges Ende + 12 Monate. */
export async function renewalDefaults(s: Pick<SuggestionRow, "objectId" | "proposedDate">) {
  const e = s.objectId ? await db.query.engagements.findFirst({ where: eq(schema.engagements.id, s.objectId) }) : null;
  if (!e) return null;
  const open = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, e.id), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])) });
  const base = e.plannedEnd ?? new Date().toISOString().slice(0, 10);
  return { engagementId: e.id, title: e.title, currentEnd: e.plannedEnd, newEnd: s.proposedDate || open?.proposedTo || addMonthsIso(base, 12), openStatus: open?.status ?? null };
}

/**
 * Verlängerung aus einer KI-Karte: BD/Principal/CEO bestätigen direkt (Periode, Einsatzende, Moco-Projektende,
 * offene Klärung erledigt); Sales Operations/Betreuung stoßen an – die Entscheidung geht an den BD.
 */
async function acceptRenewalSuggestion(actor: Actor, s: SuggestionRow, newEnd: string, contractFollowUp: string, note: string) {
  if (!s.objectId) throw new ValidationError("Diese Karte ist keinem Einsatz zugeordnet.");
  if (!newEnd) throw new ValidationError("Bitte das neue Ende angeben.");
  const { engagementAccess } = await import("@/modules/engagements/authz");
  const { decideRenewal, startRenewal } = await import("@/modules/engagements/care");
  const e = await db.query.engagements.findFirst({ where: and(eq(schema.engagements.id, s.objectId), eq(schema.engagements.workspaceId, actor.workspaceId)) });
  if (!e) throw new NotFoundError("Einsatz");
  const a = await engagementAccess(actor, e);
  if (!a || !(a.manage || a.care)) throw new ForbiddenError("Für diesen Einsatz dürfen Sie keine Verlängerung anstoßen.");
  const open = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, e.id), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])) });
  const quote = `Laut ${s.trigger}: „${s.evidenceQuote.slice(0, 200)}“${note ? ` – ${note}` : ""}`;
  if (!open || open.proposedTo !== newEnd) await startRenewal(actor, e.id, { newEnd, conditions: "UNVERAENDERT", note: quote.slice(0, 1000) });
  if (a.commercial) {
    const r = await decideRenewal(actor, e.id, { decision: "BESTAETIGEN", contractFollowUp: contractFollowUp || "Nachtrag", note: s.conditionsNote ?? "" });
    const moco = r.mocoWritten ? " Das Projektende in Moco ist aktualisiert." : r.mocoError ? " Moco konnte nicht aktualisiert werden – Sales Operations ist informiert." : "";
    return { decisionId: r.decision.id, message: `Verlängerung bis ${newEnd.split("-").reverse().join(".")} bestätigt – die offene Klärung ist erledigt.${moco}` };
  }
  const cur = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, e.id), inArray(schema.renewalDecisions.status, ["IN_ABSTIMMUNG"])) });
  return { decisionId: cur?.id ?? "", message: `Verlängerung bis ${newEnd.split("-").reverse().join(".")} angestoßen – die Entscheidung liegt beim BD.` };
}

/** Person aus einer KI-Karte: bestehende Person (E-Mail oder Name) um Funktion/Bereich/E-Mail ergänzen, sonst neu anlegen. */
async function acceptPersonSuggestion(actor: Actor, s: SuggestionRow, ctx: SetupContext) {
  const { createPerson, resolveOrgUnit } = await import("@/modules/people/service");
  const name = (s.mentionedPersonName ?? "").replace(/^(Frau|Herr|Fr\.|Hr\.)\s+/i, "").trim();
  if (name.length < 2) throw new ValidationError("Der Vorschlag nennt keinen Namen.");
  const persons = await db.query.persons.findMany({ where: eq(schema.persons.accountId, ctx.account.id) });
  const clean = (n: string) => n.replace(/\(.*?\)/g, "").replace(/^(Frau|Herr|Fr\.|Hr\.)\s+/i, "").trim().toLowerCase();
  const email = (s.mentionedPersonEmail ?? "").toLowerCase();
  const hit =
    (email && persons.find((p) => p.email?.toLowerCase() === email)) ||
    persons.find((p) => clean(p.displayName) === name.toLowerCase()) ||
    (() => {
      const last = name.toLowerCase().split(/\s+/).pop()!;
      const same = persons.filter((p) => clean(p.displayName).split(/\s+/).pop() === last);
      return same.length === 1 ? same[0] : undefined;
    })();
  const role = s.mentionedPersonRole ?? "";
  const unit = s.mentionedPersonUnit ?? "";
  if (!hit) {
    const p = await createPerson(actor, { accountId: ctx.account.id, displayName: name, email: s.mentionedPersonEmail ?? "", functionTitle: role, orgUnitName: unit, setupId: ctx.setup.id });
    return { personId: p.id, message: `${name} angelegt${role ? ` als ${role}` : ""}${unit ? ` (${unit})` : ""}.` };
  }
  await db.transaction(async (tx) => {
    if (email && !hit.email) await tx.update(schema.persons).set({ email: s.mentionedPersonEmail, updatedAt: new Date() }).where(eq(schema.persons.id, hit.id));
    if (role || unit) {
      const cur = (await tx.query.personFunctions.findMany({ where: eq(schema.personFunctions.personId, hit.id) })).find((f) => !f.validTo);
      const unitId = unit ? await resolveOrgUnit(tx, ctx.account.id, undefined, unit) : cur?.orgUnitId ?? null;
      if (!cur || (role && cur.functionTitle !== role) || (unit && cur.orgUnitId !== unitId)) {
        const today = new Date().toISOString().slice(0, 10);
        if (cur) await tx.update(schema.personFunctions).set({ validTo: today }).where(eq(schema.personFunctions.id, cur.id));
        await tx.insert(schema.personFunctions).values({ personId: hit.id, orgUnitId: unitId, functionTitle: role || cur?.functionTitle || "Funktion noch unbekannt", validFrom: today, sourceId: s.sourceIds[0] ?? null });
      }
    }
    await recordAudit(tx, actor, "person.updated_from_suggestion", "PERSON", hit.id, { funktion: role || null, bereich: unit || null });
  });
  return { personId: hit.id, message: `${hit.displayName.replace(/\(.*?\)/g, "").trim()} ergänzt${role ? `: ${role}` : ""}${unit ? ` (${unit})` : ""}.` };
}
