import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canEditSetup, canViewSetup, loadSetupContext } from "@/modules/identity/authz";
import { getAIProvider } from "@/modules/ai";
import type { AIProvider } from "@/modules/ai/provider";
import { strategyProposalSchema, type StrategyProposal } from "@/modules/ai/schemas";
import { evidenceFound, runAiJob } from "@/modules/ai/jobs";
import { buildContextText, resolveContext } from "@/modules/assistant/service";
import { analysisToText, analyzeSetup, type SetupAnalysis } from "./analysis";

/**
 * Strategiefaden je Setup (Etappe 9, E-044): eine versionierte Hypothese – Lage, nächster großer Schritt, Züge,
 * Risiken, offene Fragen. Die KI schlägt vor (nur mit Textstelle aus Lage/Kontext), der BD prüft, ändert und
 * speichert eine Fassung. Ältere Fassungen bleiben nachlesbar (was dachten wir wann, und warum).
 */

export const STRATEGY_PROMPT_VERSION = "strategy.v1";

export type StrategyMove = { title: string; why: string; ownerRole: "BD" | "ANKER" | "PRINCIPAL"; evidenceQuote: string; done?: boolean };
export type StrategyRow = typeof schema.strategyThreads.$inferSelect;

async function requireViewable(actor: Actor, setupId: string) {
  const ctx = await loadSetupContext(actor, setupId);
  if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
  return ctx;
}

export async function getStrategy(actor: Actor, setupId: string): Promise<{ analysis: SetupAnalysis; latest: StrategyRow | null; versions: StrategyRow[]; canEdit: boolean }> {
  const ctx = await requireViewable(actor, setupId);
  const [analysis, versions] = await Promise.all([analyzeSetup(actor, ctx), db.query.strategyThreads.findMany({ where: eq(schema.strategyThreads.setupId, setupId), orderBy: desc(schema.strategyThreads.versionNo) })]);
  return { analysis, latest: versions[0] ?? null, versions, canEdit: canEditSetup(actor, ctx) };
}

export type StrategyProposalResult = { proposal: StrategyProposal; rejected: number; basis: string; note: string; aiJobId: string | null };

/** KI-Vorschlag einholen – wird nicht gespeichert; der BD übernimmt ihn in das Formular. */
export async function proposeStrategy(actor: Actor, setupId: string, deps: { provider?: AIProvider } = {}): Promise<StrategyProposalResult> {
  const ctx = await requireViewable(actor, setupId);
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Den Strategiefaden pflegen Beteiligte mit Bearbeitungsrecht.");
  const analysis = await analyzeSetup(actor, ctx);
  const basis = analysisToText(analysis);
  const res = await resolveContext(actor, { type: "SETUP", id: setupId });
  const contextText = await buildContextText(actor, res);
  const latest = await db.query.strategyThreads.findFirst({ where: eq(schema.strategyThreads.setupId, setupId), orderBy: desc(schema.strategyThreads.versionNo) });
  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  if (!info.enabled || !provider.strategize) {
    // Ohne KI: der regelbasierte Faden aus der Analyse
    return { proposal: ruleBasedProposal(analysis), rejected: 0, basis, note: "KI deaktiviert – regelbasierter Vorschlag aus der Lageanalyse.", aiJobId: null };
  }
  const input = { analysisText: basis, contextText, previous: latest ? { summary: latest.summary, nextStep: latest.nextStep, createdAt: latest.createdAt.toISOString().slice(0, 10) } : null };
  const allowed = `${basis}\n${contextText}`;
  const run = await runAiJob(actor, { task: "STRATEGY", setupId, promptVersion: STRATEGY_PROMPT_VERSION, inputText: JSON.stringify(input), dedupeKey: `strategy:${setupId}:${Date.now()}`, provider }, async (p, opts) => {
    const raw = await p.strategize!(input, opts);
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

/** Regelbasierter Faden ohne KI – damit der Faden nie leer bleibt. */
export function ruleBasedProposal(a: SetupAnalysis): StrategyProposal {
  const q = (t: string) => t;
  return {
    summary: `Belegt: Stufe „${a.stageLabel}“ mit ${a.counts.opportunities} aktivem/aktiven Bedarf(en), ${a.counts.persons} bekannten Personen und ${a.counts.openActions} offenen Aktionen. ${a.blockers.length ? `${a.blockers.length} dokumentierte Blocker.` : "Keine dokumentierten Blocker."} ${a.missing.length ? `${a.missing.length} Grundlagen fehlen.` : "Grundlagen vollständig."}`,
    nextStep: a.nextStep,
    moves: [
      ...a.moves.slice(0, 2).map((m) => ({ title: m.text.replace(/\.$/, ""), why: "Im Tool bereits vorbereitet.", ownerRole: "BD" as const, evidenceQuote: q(m.text) })),
      ...a.blockers.slice(0, 2).map((b) => ({ title: `Blocker lösen: ${b.slice(0, 100)}`, why: "Hält den nächsten großen Schritt auf.", ownerRole: "BD" as const, evidenceQuote: q(b) })),
      ...a.missing.slice(0, 1).map((m) => ({ title: `Lücke schließen: ${m.slice(0, 100)}`, why: "Ohne diese Grundlage bleibt der Schritt Hypothese.", ownerRole: "BD" as const, evidenceQuote: q(m) })),
    ].slice(0, 5),
    risks: a.blockers.slice(0, 2).map((b) => ({ text: `Vermutlich: ${b}`, evidenceQuote: q(b) })),
    openQuestions: a.missing.filter((m) => m.includes("?")).slice(0, 3),
  };
}

const moveInput = z.object({ title: z.string().trim().min(3).max(200), why: z.string().trim().max(600).default(""), ownerRole: z.enum(["BD", "ANKER", "PRINCIPAL"]).default("BD"), evidenceQuote: z.string().trim().max(400).default(""), done: z.boolean().optional() });

export const saveStrategyInput = z.object({
  setupId: z.string().min(1),
  summary: z.string().trim().min(10, "Lage in mindestens einem Satz.").max(2000),
  nextStep: z.string().trim().min(5, "Nächster Schritt fehlt.").max(400),
  moves: z.array(moveInput).max(8).default([]),
  risks: z.array(z.object({ text: z.string().trim().min(3).max(400), evidenceQuote: z.string().trim().max(400).default("") })).max(6).default([]),
  openQuestions: z.array(z.string().trim().min(3).max(300)).max(6).default([]),
  note: z.string().trim().max(600).optional().default(""),
  aiJobId: z.string().optional().nullable(),
});

/** Neue Fassung speichern – immer eine neue Version, nie überschreiben. */
export async function saveStrategy(actor: Actor, raw: unknown) {
  const parsed = saveStrategyInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  const ctx = await requireViewable(actor, i.setupId);
  if (!canEditSetup(actor, ctx)) throw new ForbiddenError("Den Strategiefaden pflegen Beteiligte mit Bearbeitungsrecht.");
  const analysis = await analyzeSetup(actor, ctx);
  return db.transaction(async (tx) => {
    const last = await tx.query.strategyThreads.findFirst({ where: eq(schema.strategyThreads.setupId, i.setupId), orderBy: desc(schema.strategyThreads.versionNo) });
    const [row] = await tx
      .insert(schema.strategyThreads)
      .values({ workspaceId: actor.workspaceId, setupId: i.setupId, versionNo: (last?.versionNo ?? 0) + 1, summary: i.summary, nextStep: i.nextStep, moves: i.moves, risks: i.risks, openQuestions: i.openQuestions, basis: analysisToText(analysis), stage: analysis.stage, note: i.note || null, aiJobId: i.aiJobId ?? null, createdBy: actor.userId })
      .returning();
    await tx.update(schema.projectSetups).set({ updatedAt: new Date() }).where(eq(schema.projectSetups.id, i.setupId));
    await recordAudit(tx, actor, "strategy.version_saved", "STRATEGY", row!.id, { setupId: i.setupId, versionNo: row!.versionNo, stage: analysis.stage, moves: i.moves.length, mitKI: !!i.aiJobId });
    return row!;
  });
}

/** Formulardaten (Listen per Index) in die Eingabe übersetzen. */
export function formToStrategyInput(data: Record<string, string>): unknown {
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
    setupId: data.setupId,
    summary: data.summary,
    nextStep: data.nextStep,
    moves: list("moves", ["title", "why", "ownerRole", "evidenceQuote"]),
    risks: list("risks", ["text", "evidenceQuote"]),
    openQuestions: list("openQuestions", ["text"]).map((r) => String(r.text)),
    note: data.note ?? "",
    aiJobId: data.aiJobId || null,
  };
}

/** Letzte Fassung je Setup (für Dashboard/Setup-Seite). */
export async function latestStrategy(setupId: string) {
  return db.query.strategyThreads.findFirst({ where: and(eq(schema.strategyThreads.setupId, setupId)), orderBy: desc(schema.strategyThreads.versionNo) });
}
