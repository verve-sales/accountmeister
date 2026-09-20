import { createHash } from "node:crypto";
import { and, count, eq, gte } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import type { Actor } from "@/modules/identity/actor";
import { getAIProvider } from "./index";
import type { AIProvider, TaskOptions } from "./provider";
import { requireTaskOptions, type AiTaskKey } from "./settings";
import { UsageLimitError } from "@/modules/suggestions/service";

/**
 * Gemeinsame Klammer für KI-Aufträge (Etappe 9): Tageslimit, Auftragsprotokoll ohne Rohtext (Hash, Länge,
 * Token-Verbrauch), Modellwahl je Aufgabe, verständliche Fehler. Der eigentliche Aufruf und die Schemaprüfung
 * bleiben beim Aufrufer.
 */

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const normalizeForEvidence = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[„“"'.,;:!?()\-–]/g, "").trim();

/** Prüft, ob eine Textstelle wörtlich (oder nach Normalisierung) im erlaubten Text vorkommt. */
export function evidenceFound(allowed: string, quote: string): boolean {
  if (!quote.trim()) return false;
  return allowed.includes(quote) || normalizeForEvidence(allowed).includes(normalizeForEvidence(quote));
}

export type AiJobRun<T> = { result: T; jobId: string | null; model: string };

export async function runAiJob<T>(
  actor: Actor,
  meta: { task: AiTaskKey; setupId?: string | null; promptVersion: string; inputText: string; dedupeKey: string; provider?: AIProvider },
  call: (provider: AIProvider, opts: TaskOptions) => Promise<{ result: T; itemCount?: number; rejectedCount?: number }>,
): Promise<AiJobRun<T>> {
  const provider = meta.provider ?? getAIProvider();
  const info = provider.info();
  const cfg = getConfig();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const [cnt] = await db.select({ n: count() }).from(schema.aiJobs).where(and(eq(schema.aiJobs.workspaceId, actor.workspaceId), gte(schema.aiJobs.startedAt, since)));
  if (Number(cnt?.n ?? 0) >= cfg.AI_DAILY_JOB_LIMIT) throw new UsageLimitError(cfg.AI_DAILY_JOB_LIMIT);
  const opts: TaskOptions = info.id === "langdock" ? await requireTaskOptions(actor.workspaceId, meta.task) : {};
  const [job] = await db
    .insert(schema.aiJobs)
    .values({ workspaceId: actor.workspaceId, type: meta.task, actorUserId: actor.userId, setupId: meta.setupId ?? null, provider: info.id, model: opts.model ?? info.model, promptVersion: meta.promptVersion, inputHash: sha(meta.inputText), inputChars: meta.inputText.length, dedupeKey: meta.dedupeKey })
    .returning();
  try {
    const out = await call(provider, opts);
    const usage = provider.lastUsage?.() ?? null;
    if (job) await db.update(schema.aiJobs).set({ status: "ERFOLGREICH", itemCount: out.itemCount ?? null, rejectedCount: out.rejectedCount ?? null, tokensIn: usage?.tokensIn ?? null, tokensOut: usage?.tokensOut ?? null, model: usage?.model || job.model, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    return { result: out.result, jobId: job?.id ?? null, model: usage?.model || job?.model || info.model };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : "Anbieterfehler").slice(0, 300);
    if (job) await db.update(schema.aiJobs).set({ status: "FEHLER", error: msg, finishedAt: new Date() }).where(eq(schema.aiJobs.id, job.id));
    throw e;
  }
}
