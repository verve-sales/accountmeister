import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { hasRole } from "@/modules/identity/actor";
import { getAIProvider } from "./index";
import type { ModelInfo, TaskOptions } from "./provider";

/**
 * KI-Aufgaben und ihre Modellwahl (Verwaltung → KI). Der API-Schlüssel steht ausschließlich in der
 * Serverkonfiguration; hier werden nur Modell, Temperatur und Ausgabegrenze je Aufgabe geführt.
 */

export const AI_TASKS = [
  { key: "STRUCTURE_NOTE", label: "Notiz strukturieren", description: "Weekly-Notizen und importierte Quellen in prüffähige Vorschläge zerlegen (Beobachtung, Aktion, Entscheidung, offene Frage, Person, Konflikt)." },
  { key: "ANALYZE_DOCUMENT", label: "Dokument/Interview auswerten (Anlagevorschlag)", description: "Aus einem Dokument oder Interviewverlauf Organisation, Setup, Personen mit Einschätzung, Signale, Bedarfe, Folgeaktivitäten, Kontaktaufnahmen und Artefaktempfehlungen vorschlagen – zur Bestätigung durch den BD." },
  { key: "INTERVIEW_NEXT", label: "Interview: nächste Frage", description: "Im geführten Interview die jeweils nächste Frage stellen, abgeleitet aus dem, was noch fehlt. Kleines, schnelles Modell genügt." },
  { key: "ASSISTANT", label: "Assistent (Dialog mit Vorschlagskarten)", description: "Laufender Dialog im Seitenpanel: antwortet, schlägt Karten vor (Personen, Signale, Bedarfe, Aktionen, Kontaktaufnahmen, Fragen) und benennt fehlende Informationen. Ein schnelles Modell mit guter Instruktionstreue empfohlen." },
  { key: "STRATEGY", label: "Strategiefaden (Lage, nächster Schritt, Züge)", description: "Aus der regelbasierten Lageanalyse und dem bekannten Kontext einen Strategiefaden je Setup vorschlagen – Züge und Risiken nur mit Textstelle; der BD prüft und speichert eine Fassung." },
  { key: "FORM_SUGGEST", label: "Formularvorschläge (Vorhaben, Setup, Bedarf)", description: "Formularfelder aus dem bekannten Kundenkontext vorbelegen („Vorschlagen lassen“). Kleines, schnelles Modell genügt." },
] as const;

export type AiTaskKey = (typeof AI_TASKS)[number]["key"];

export const aiTaskKeys = AI_TASKS.map((t) => t.key) as [AiTaskKey, ...AiTaskKey[]];

export type TaskSettingRow = typeof schema.aiTaskSettings.$inferSelect;

/** Wirksame Optionen einer Aufgabe: gespeicherte Einstellung oder Standardmodell aus der Konfiguration. */
export async function getTaskOptions(workspaceId: string, task: AiTaskKey): Promise<TaskOptions & { enabled: boolean; source: "konfiguriert" | "geerbt" | "standard" }> {
  const rows = await db.query.aiTaskSettings.findMany({ where: eq(schema.aiTaskSettings.workspaceId, workspaceId) });
  const row = rows.find((r) => r.task === task);
  if (row) return { model: row.model, temperature: row.temperature, maxOutputTokens: row.maxOutputTokens, enabled: row.enabled, source: "konfiguriert" };
  // Noch nicht konfigurierte Aufgabe: das Modell einer bereits konfigurierten Aufgabe erben (funktioniert im Arbeitsraum nachweislich),
  // sonst der Standard aus der Konfiguration.
  const inherit = rows.find((r) => r.task === "STRUCTURE_NOTE" && r.enabled) ?? rows.find((r) => r.enabled);
  if (inherit) return { model: inherit.model, temperature: 0.2, maxOutputTokens: task === "INTERVIEW_NEXT" || task === "FORM_SUGGEST" ? 800 : 4000, enabled: true, source: "geerbt" };
  return { model: getConfig().LANGDOCK_DEFAULT_MODEL, temperature: 0.2, maxOutputTokens: 4000, enabled: true, source: "standard" };
}

export class TaskDisabledError extends ForbiddenError {
  constructor(label: string) {
    super(`Die KI-Aufgabe „${label}“ ist unter Verwaltung → KI deaktiviert.`);
  }
}

export async function requireTaskOptions(workspaceId: string, task: AiTaskKey): Promise<TaskOptions> {
  const o = await getTaskOptions(workspaceId, task);
  if (!o.enabled) throw new TaskDisabledError(AI_TASKS.find((t) => t.key === task)?.label ?? task);
  return { model: o.model, temperature: o.temperature, maxOutputTokens: o.maxOutputTokens };
}

function assertAdmin(actor: Actor) {
  if (!hasRole(actor, "ADMIN")) throw new ForbiddenError("Die KI-Konfiguration steht der Betriebsverwaltung (ADMIN) zur Verfügung.");
}

export const saveTaskSettingInput = z.object({
  task: z.enum(aiTaskKeys),
  model: z.string().trim().min(1, "Modell fehlt").max(120),
  temperature: z.coerce.number().min(0).max(1).default(0.2),
  maxOutputTokens: z.coerce.number().int().min(256).max(32000).default(4000),
  enabled: z.union([z.literal("on"), z.literal("true"), z.literal("false"), z.boolean()]).optional(),
});

export async function saveTaskSetting(actor: Actor, raw: unknown) {
  assertAdmin(actor);
  const parsed = saveTaskSettingInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  const enabled = i.enabled === "on" || i.enabled === "true" || i.enabled === true;
  return db.transaction(async (tx) => {
    const existing = await tx.query.aiTaskSettings.findFirst({ where: and(eq(schema.aiTaskSettings.workspaceId, actor.workspaceId), eq(schema.aiTaskSettings.task, i.task)) });
    const values = { model: i.model, temperature: i.temperature, maxOutputTokens: i.maxOutputTokens, enabled, updatedBy: actor.userId, updatedAt: new Date() };
    if (existing) await tx.update(schema.aiTaskSettings).set(values).where(eq(schema.aiTaskSettings.id, existing.id));
    else await tx.insert(schema.aiTaskSettings).values({ workspaceId: actor.workspaceId, task: i.task, ...values });
    await recordAudit(tx, actor, "ai.task_setting_saved", "AI_TASK", i.task, { model: i.model, temperature: i.temperature, maxOutputTokens: i.maxOutputTokens, enabled, vorher: existing ? { model: existing.model, enabled: existing.enabled } : null });
    return { task: i.task, model: i.model, enabled };
  });
}

/** Übersicht für die Konfigurationsseite: Anbieterstatus, Modelle, Einstellungen je Aufgabe, Verbrauch. */
export async function getAiOverview(actor: Actor) {
  assertAdmin(actor);
  const cfg = getConfig();
  const provider = getAIProvider();
  const info = provider.info();
  let models: ModelInfo[] = [];
  let modelsError: string | null = null;
  if (provider.listModels) {
    try {
      models = await provider.listModels();
    } catch (e) {
      modelsError = e instanceof Error ? e.message : "Modellliste nicht abrufbar";
    }
  }
  const rows = await db.query.aiTaskSettings.findMany({ where: eq(schema.aiTaskSettings.workspaceId, actor.workspaceId) });
  const byTask = new Map(rows.map((r) => [r.task, r]));
  const tasks = await Promise.all(
    AI_TASKS.map(async (t) => {
      const opt = await getTaskOptions(actor.workspaceId, t.key);
      const row = byTask.get(t.key);
      return { ...t, ...opt, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
    }),
  );
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const usage = await db
    .select({
      type: schema.aiJobs.type,
      model: schema.aiJobs.model,
      jobs: sql<number>`count(*)`,
      ok: sql<number>`count(*) filter (where ${schema.aiJobs.status} = 'ERFOLGREICH')`,
      tokensIn: sql<number>`coalesce(sum(${schema.aiJobs.tokensIn}), 0)`,
      tokensOut: sql<number>`coalesce(sum(${schema.aiJobs.tokensOut}), 0)`,
    })
    .from(schema.aiJobs)
    .where(and(eq(schema.aiJobs.workspaceId, actor.workspaceId), gte(schema.aiJobs.startedAt, since30)))
    .groupBy(schema.aiJobs.type, schema.aiJobs.model)
    .orderBy(desc(sql`count(*)`));
  const recent = await db.query.aiJobs.findMany({ where: eq(schema.aiJobs.workspaceId, actor.workspaceId), orderBy: desc(schema.aiJobs.startedAt), limit: 15 });
  return {
    provider: { ...info, configured: cfg.AI_PROVIDER, baseUrl: cfg.AI_PROVIDER === "langdock" ? cfg.LANGDOCK_BASE_URL : null, keyPresent: !!cfg.LANGDOCK_API_KEY, dailyLimit: cfg.AI_DAILY_JOB_LIMIT },
    models,
    modelsError,
    tasks,
    usage: usage.map((u) => ({ ...u, jobs: Number(u.jobs), ok: Number(u.ok), tokensIn: Number(u.tokensIn), tokensOut: Number(u.tokensOut) })),
    recent,
  };
}

/**
 * Verbindungstest. Zuerst die Modellliste (kostet nichts); ist sie mit diesem Schlüssel nicht erlaubt (persönliche
 * Langdock-Schlüssel erreichen nur die Completion-Endpunkte), folgt eine minimale Testanfrage ohne Inhalte.
 */
export async function testConnection(actor: Actor): Promise<{ models: number; viaCompletion: boolean; model: string; detail: string }> {
  assertAdmin(actor);
  const provider = getAIProvider();
  if (!provider.listModels || !provider.ping) throw new ValidationError("Der aktive Anbieter hat keine Verbindungsprüfung (AI_PROVIDER ist nicht „langdock“).");
  let result: { models: number; viaCompletion: boolean; model: string; detail: string };
  try {
    const models = await provider.listModels();
    result = { models: models.length, viaCompletion: false, model: "", detail: `${models.length} Modell(e) verfügbar.` };
  } catch (e) {
    const first = e instanceof Error ? e.message : "Modellliste nicht abrufbar";
    const opts = await getTaskOptions(actor.workspaceId, "STRUCTURE_NOTE");
    const model = opts.model ?? getConfig().LANGDOCK_DEFAULT_MODEL;
    try {
      await provider.ping({ model });
      result = { models: 0, viaCompletion: true, model, detail: `Modellliste nicht erlaubt (${first}) – Testanfrage an „${model}“ erfolgreich. Vermutlich ein persönlicher Schlüssel: Modelle bitte von Hand eintragen.` };
    } catch (e2) {
      throw e2;
    }
  }
  await recordAudit(db, actor, "ai.connection_tested", "AI_PROVIDER", provider.info().id, { models: result.models, viaCompletion: result.viaCompletion });
  return result;
}
