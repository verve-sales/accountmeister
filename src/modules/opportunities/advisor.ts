import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { OpportunityStatus } from "@/db/schema";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { opportunityStatusLabel } from "@/lib/labels";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import type { SetupContext } from "@/modules/identity/authz";
import { getAIProvider } from "@/modules/ai";
import type { AIProvider } from "@/modules/ai/provider";
import { strategyProposalSchema, type StrategyProposal } from "@/modules/ai/schemas";
import { evidenceFound, runAiJob } from "@/modules/ai/jobs";
import { buildContextText, resolveContext } from "@/modules/assistant/service";
import { getOpportunityDetail } from "./service";

/**
 * Persönlicher KI-Berater je Chance (Etappe 15, aus dem BD-Wunsch „ein persönlicher KI-Berater, der mir hilft,
 * die nächsten Schritte zur Konvertierung von Opportunities zu gehen“). Analog zum Strategiefaden (Etappe 9),
 * aber je Bedarf statt je Setup: eine versionierte Hypothese – Lage dieser einen Chance, nächster Schritt zur
 * Konvertierung, Züge, Risiken, offene Fragen. Die KI schlägt vor (nur mit Textstelle), der BD prüft, ändert und
 * speichert eine Fassung. Ältere Fassungen bleiben nachlesbar.
 */

export const OPPORTUNITY_ADVICE_PROMPT_VERSION = "opportunity-advice.v1";

export type OpportunityAdviceRow = typeof schema.opportunityAdvice.$inferSelect;

/** Der nächste große Schritt je Status dieser einen Chance – als Satz, den der BD lesen kann. */
const NEXT_STEP: Record<OpportunityStatus, string> = {
  ANTIZIPIERT: "Prüfen, ob der Kunde den Bedarf inzwischen angesprochen hat.",
  IN_KLAERUNG: "Chance mit dem Bedarfsträger bestätigen – mit Beleg (Gesprächsnotiz, Mail).",
  BESTAETIGT: "Passendes Profil oder Angebot vorstellen und Rückmeldung vereinbaren.",
  PROFIL_ANGEBOT_VORGESTELLT: "Rückmeldung zum Angebot einholen; Entscheidungsweg und Freigaben klären.",
  AUSWAHL_BESTELLUNG: "Beauftragung mit Nachweis festhalten (Bestellung, Bestätigung).",
  BEAUFTRAGT: "Startvoraussetzungen abschließen und Start terminieren.",
  ZURUECKGESTELLT: "Grund prüfen – ist eine Reaktivierung sinnvoll?",
  BEENDET: "Beendet – kein weiterer Schritt zu dieser Chance.",
};

export type OpportunityAnalysis = {
  opportunityId: string;
  title: string;
  accountName: string;
  setupName: string;
  status: OpportunityStatus;
  statusLabel: string;
  nextStep: string;
  /** Was die Konvertierung dieser Chance aufhält (dokumentierte Hindernisse). */
  blockers: string[];
  /** Was fehlt, damit der nächste Schritt gelingen kann (Lücken). */
  missing: string[];
  /** Naheliegende Züge, die im Tool schon vorbereitet sind. */
  moves: string[];
  ageDays: number;
};

/** Regelbasierte Lageanalyse genau einer Chance – Grundlage für den Berater-Faden. */
export async function analyzeOpportunity(actor: Actor, opportunityId: string): Promise<{ analysis: OpportunityAnalysis; ctx: SetupContext; canEdit: boolean }> {
  const d = await getOpportunityDetail(actor, opportunityId);
  const { opp, ctx } = d;
  const blockers: string[] = [];
  const missing: string[] = [];
  const moves: string[] = [];
  const ageDays = Math.floor((Date.now() - opp.createdAt.getTime()) / (24 * 60 * 60 * 1000));

  if (opp.status === "IN_KLAERUNG" && ageDays > 21) blockers.push(`Seit ${ageDays} Tagen in Klärung – Bestätigung mit Beleg einholen oder zurückstellen.`);
  if (!opp.confirmedAt && opp.status !== "ANTIZIPIERT") missing.push("Chance ist noch nicht mit Beleg bestätigt.");
  if (!opp.roleId && opp.kind !== "AUSSCHREIBUNG") missing.push("Standardrolle noch offen.");
  if (d.participations.length === 0) missing.push("Buyingcenter: noch keine Rolle erfasst.");

  const openOffers = d.offers.filter((o) => o.status === "VORGESTELLT" || o.status === "RUECKMELDUNG_OFFEN");
  if (openOffers.length) moves.push("Rückmeldung zum vorgestellten Angebot einholen.");
  if (opp.status === "BESTAETIGT" && d.offers.length === 0) moves.push("Angebot oder Profilvorstellung vorbereiten.");

  const incompleteOrders = d.orders.filter((o) => o.status === "NACHWEISE_UNVOLLSTAENDIG");
  if (incompleteOrders.length) blockers.push("Auftrag: Nachweise unvollständig – Beauftragung ist nicht belegt.");
  const readyToStart = d.orders.filter((o) => o.status === "BEAUFTRAGUNG_BESTAETIGT" && o.engagementStatus === "GEPLANT");
  if (readyToStart.length) moves.push("Startvoraussetzungen prüfen und Start terminieren.");

  if (d.linked.suggestions.length) moves.push(`${d.linked.suggestions.length} offene Vorschläge zu dieser Chance.`);
  if (d.linked.questions.length) moves.push(`${d.linked.questions.length} offene Frage(n) ins nächste Kundengespräch mitnehmen.`);
  if (d.linked.signals.length) moves.push(`${d.linked.signals.length} Beobachtung(en) mit Bezug auf diese Chance.`);
  if (opp.status === "ANTIZIPIERT") moves.push("Im nächsten Gespräch prüfen, ob der Kunde den Bedarf ausspricht.");

  return {
    analysis: {
      opportunityId: opp.id,
      title: opp.title,
      accountName: ctx.account.name,
      setupName: ctx.setup.name,
      status: opp.status,
      statusLabel: opportunityStatusLabel[opp.status] ?? opp.status,
      nextStep: NEXT_STEP[opp.status],
      blockers,
      missing,
      moves,
      ageDays,
    },
    ctx,
    canEdit: d.canEdit,
  };
}

/** Kompakte Textfassung für KI-Eingaben und den Berater-Faden – ohne Rohquellen. */
export function opportunityAnalysisToText(a: OpportunityAnalysis): string {
  const lines = [
    `Chance: ${a.title} (Kunde: ${a.accountName} · Setup: ${a.setupName} · Status ${a.statusLabel}, ${a.ageDays} Tage alt)`,
    `Nächster Schritt: ${a.nextStep}`,
    a.blockers.length ? `Blocker: ${a.blockers.join(" | ")}` : "",
    a.missing.length ? `Fehlt: ${a.missing.join(" | ")}` : "",
    a.moves.length ? `Naheliegende Züge: ${a.moves.join(" | ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export async function getOpportunityAdvice(actor: Actor, opportunityId: string): Promise<{ analysis: OpportunityAnalysis; latest: OpportunityAdviceRow | null; versions: OpportunityAdviceRow[]; canEdit: boolean }> {
  const { analysis, canEdit } = await analyzeOpportunity(actor, opportunityId);
  const versions = await db.query.opportunityAdvice.findMany({ where: eq(schema.opportunityAdvice.opportunityId, opportunityId), orderBy: desc(schema.opportunityAdvice.versionNo) });
  return { analysis, latest: versions[0] ?? null, versions, canEdit };
}

export type OpportunityAdviceProposalResult = { proposal: StrategyProposal; rejected: number; basis: string; note: string; aiJobId: string | null };

/** KI-Vorschlag einholen – wird nicht gespeichert; der BD übernimmt ihn in das Formular. */
export async function proposeOpportunityAdvice(actor: Actor, opportunityId: string, deps: { provider?: AIProvider } = {}): Promise<OpportunityAdviceProposalResult> {
  const { analysis, ctx, canEdit } = await analyzeOpportunity(actor, opportunityId);
  if (!canEdit) throw new ForbiddenError("Den Chancen-Berater pflegen Beteiligte mit Bearbeitungsrecht am Setup.");
  const basis = opportunityAnalysisToText(analysis);
  const res = await resolveContext(actor, { type: "SETUP", id: ctx.setup.id });
  const contextText = await buildContextText(actor, res);
  const latest = await db.query.opportunityAdvice.findFirst({ where: eq(schema.opportunityAdvice.opportunityId, opportunityId), orderBy: desc(schema.opportunityAdvice.versionNo) });
  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  if (!info.enabled || !provider.adviseOpportunity) {
    // Ohne KI: der regelbasierte Faden aus der Analyse
    return { proposal: ruleBasedOpportunityAdvice(analysis), rejected: 0, basis, note: "KI deaktiviert – regelbasierter Vorschlag aus der Lageanalyse dieser Chance.", aiJobId: null };
  }
  const input = { analysisText: basis, contextText, previous: latest ? { summary: latest.summary, nextStep: latest.nextStep, createdAt: latest.createdAt.toISOString().slice(0, 10) } : null };
  const allowed = `${basis}\n${contextText}`;
  const run = await runAiJob(actor, { task: "OPPORTUNITY_ADVICE", setupId: ctx.setup.id, promptVersion: OPPORTUNITY_ADVICE_PROMPT_VERSION, inputText: JSON.stringify(input), dedupeKey: `opportunity-advice:${opportunityId}:${Date.now()}`, provider }, async (p, opts) => {
    const raw = await p.adviseOpportunity!(input, opts);
    const parsed = strategyProposalSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError("Die KI-Antwort entsprach nicht dem Schema.");
    let rejected = 0;
    const moves = parsed.data.moves.filter((m) => (evidenceFound(allowed, m.evidenceQuote) ? true : (rejected++, false)));
    const risks = parsed.data.risks.filter((r) => (evidenceFound(allowed, r.evidenceQuote) ? true : (rejected++, false)));
    return { result: { proposal: { ...parsed.data, moves, risks }, rejected }, itemCount: moves.length + risks.length, rejectedCount: rejected };
  });
  const note = run.result.rejected > 0 ? `${run.result.rejected} Zug/Züge bzw. Risiken ohne belegbare Textstelle wurden verworfen.` : "";
  return { proposal: run.result.proposal, rejected: run.result.rejected, basis, note, aiJobId: run.jobId };
}

/** Regelbasierter Faden ohne KI – damit der Berater nie leer bleibt. */
export function ruleBasedOpportunityAdvice(a: OpportunityAnalysis): StrategyProposal {
  const q = (t: string) => t;
  return {
    summary: `Belegt: Chance „${a.title}“ im Status „${a.statusLabel}“, ${a.ageDays} Tage alt. ${a.blockers.length ? `${a.blockers.length} dokumentierte(r) Blocker.` : "Keine dokumentierten Blocker."} ${a.missing.length ? `${a.missing.length} Grundlagen fehlen.` : "Grundlagen vollständig."}`,
    nextStep: a.nextStep,
    moves: [
      ...a.moves.slice(0, 2).map((m) => ({ title: m.replace(/\.$/, ""), why: "Im Tool bereits vorbereitet.", ownerRole: "BD" as const, evidenceQuote: q(m) })),
      ...a.blockers.slice(0, 2).map((b) => ({ title: `Blocker lösen: ${b.slice(0, 100)}`, why: "Hält die Konvertierung dieser Chance auf.", ownerRole: "BD" as const, evidenceQuote: q(b) })),
      ...a.missing.slice(0, 1).map((m) => ({ title: `Lücke schließen: ${m.slice(0, 100)}`, why: "Ohne diese Grundlage bleibt der Schritt Hypothese.", ownerRole: "BD" as const, evidenceQuote: q(m) })),
    ].slice(0, 5),
    risks: a.blockers.slice(0, 2).map((b) => ({ text: `Vermutlich: ${b}`, evidenceQuote: q(b) })),
    openQuestions: a.missing.filter((m) => m.includes("?")).slice(0, 3),
  };
}

const moveInput = z.object({ title: z.string().trim().min(3).max(200), why: z.string().trim().max(600).default(""), ownerRole: z.enum(["BD", "ANKER", "PRINCIPAL"]).default("BD"), evidenceQuote: z.string().trim().max(400).default(""), done: z.boolean().optional() });

export const saveOpportunityAdviceInput = z.object({
  opportunityId: z.string().min(1),
  summary: z.string().trim().min(10, "Lage in mindestens einem Satz.").max(2000),
  nextStep: z.string().trim().min(5, "Nächster Schritt fehlt.").max(400),
  moves: z.array(moveInput).max(8).default([]),
  risks: z.array(z.object({ text: z.string().trim().min(3).max(400), evidenceQuote: z.string().trim().max(400).default("") })).max(6).default([]),
  openQuestions: z.array(z.string().trim().min(3).max(300)).max(6).default([]),
  note: z.string().trim().max(600).optional().default(""),
  aiJobId: z.string().optional().nullable(),
});

/** Neue Fassung speichern – immer eine neue Version, nie überschreiben. */
export async function saveOpportunityAdvice(actor: Actor, raw: unknown) {
  const parsed = saveOpportunityAdviceInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  const { analysis, canEdit } = await analyzeOpportunity(actor, i.opportunityId);
  if (!canEdit) throw new ForbiddenError("Den Chancen-Berater pflegen Beteiligte mit Bearbeitungsrecht am Setup.");
  return db.transaction(async (tx) => {
    const last = await tx.query.opportunityAdvice.findFirst({ where: eq(schema.opportunityAdvice.opportunityId, i.opportunityId), orderBy: desc(schema.opportunityAdvice.versionNo) });
    const [row] = await tx
      .insert(schema.opportunityAdvice)
      .values({ workspaceId: actor.workspaceId, opportunityId: i.opportunityId, versionNo: (last?.versionNo ?? 0) + 1, summary: i.summary, nextStep: i.nextStep, moves: i.moves, risks: i.risks, openQuestions: i.openQuestions, basis: opportunityAnalysisToText(analysis), status: analysis.status, note: i.note || null, aiJobId: i.aiJobId ?? null, createdBy: actor.userId })
      .returning();
    await recordAudit(tx, actor, "opportunity_advice.version_saved", "OPPORTUNITY_ADVICE", row!.id, { opportunityId: i.opportunityId, versionNo: row!.versionNo, status: analysis.status, moves: i.moves.length, mitKI: !!i.aiJobId });
    return row!;
  });
}

/** Formulardaten (Listen per Index) in die Eingabe übersetzen. */
export function formToOpportunityAdviceInput(data: Record<string, string>): unknown {
  const list = (prefix: string, fields: string[]) => {
    const out: Record<string, string | boolean>[] = [];
    for (let k = 0; k < 10; k++) {
      const has = fields.some((f) => data[`${prefix}.${k}.${f}`] !== undefined);
      if (!has) continue;
      if (data[`${prefix}.${k}.keep`] !== undefined && data[`${prefix}.${k}.keep`] !== "on") continue;
      const row: Record<string, string | boolean> = {};
      for (const f of fields) row[f] = data[`${prefix}.${k}.${f}`] ?? "";
      if (String(row[fields[0]!]).trim()) out.push(row);
    }
    return out;
  };
  return {
    opportunityId: data.opportunityId,
    summary: data.summary,
    nextStep: data.nextStep,
    moves: list("moves", ["title", "why", "ownerRole", "evidenceQuote"]),
    risks: list("risks", ["text", "evidenceQuote"]),
    openQuestions: list("openQuestions", ["text"]).map((r) => String(r.text)),
    note: data.note ?? "",
    aiJobId: data.aiJobId || null,
  };
}

/** Letzte Fassung je Chance (für Setup-/Chancen-Seite). */
export async function latestOpportunityAdvice(opportunityId: string) {
  return db.query.opportunityAdvice.findFirst({ where: and(eq(schema.opportunityAdvice.opportunityId, opportunityId)), orderBy: desc(schema.opportunityAdvice.versionNo) });
}
