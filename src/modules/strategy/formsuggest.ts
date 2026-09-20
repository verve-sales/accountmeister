import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import type { Actor } from "@/modules/identity/actor";
import { canCreateSetup, canEditSetup, canViewSetup, loadSetupContext } from "@/modules/identity/authz";
import { getAccount } from "@/modules/accounts/service";
import { canEditAccountPlan } from "@/modules/accountplan/service";
import { getAIProvider } from "@/modules/ai";
import type { AIProvider, FormSuggestInput } from "@/modules/ai/provider";
import { formKinds, formSuggestionSchema, type FormSuggestion } from "@/modules/ai/schemas";
import { evidenceFound, runAiJob } from "@/modules/ai/jobs";
import { buildContextText, resolveContext } from "@/modules/assistant/service";
import { analysisToText, analyzeSetup } from "./analysis";

/**
 * „Vorschlagen lassen“ in Formularen (Etappe 9, E-043): Die KI belegt Felder aus dem bekannten Kundenkontext vor.
 * Nichts wird gespeichert – der Vorschlag landet im Formular, der Mensch ändert und speichert. Jeder Vorschlag nennt
 * seine Textstelle; ohne belegbare Textstelle wird er verworfen und stattdessen gesagt, was fehlt.
 */

export const FORM_SUGGEST_PROMPT_VERSION = "form-suggest.v1";

export const formSuggestRequest = z.object({
  kind: z.enum(formKinds),
  accountId: z.string().optional().or(z.literal("")),
  setupId: z.string().optional().or(z.literal("")),
  fields: z.array(z.object({ name: z.string().min(1).max(60), label: z.string().min(1).max(200), options: z.array(z.string().max(60)).max(20).optional() })).min(1).max(12),
});

export type FormSuggestResult = { suggestion: FormSuggestion | null; note: string; missing: string[] };

export async function suggestFormFields(actor: Actor, raw: unknown, deps: { provider?: AIProvider } = {}): Promise<FormSuggestResult> {
  const parsed = formSuggestRequest.safeParse(raw);
  if (!parsed.success) throw new ValidationError("Ungültige Anfrage.");
  const req = parsed.data;

  // Kontext und Rechte: Wer das Formular ausfüllen darf, darf sich auch Vorschläge holen.
  let contextText = "";
  let analysisText = "";
  let setupId: string | null = null;
  if (req.setupId) {
    const ctx = await loadSetupContext(actor, req.setupId);
    if (!ctx || !canViewSetup(actor, ctx)) throw new NotFoundError("Setup");
    if (req.kind === "BEDARF" && !canEditSetup(actor, ctx)) throw new ForbiddenError("Bedarfe erfassen Beteiligte mit Bearbeitungsrecht.");
    setupId = ctx.setup.id;
    analysisText = analysisToText(await analyzeSetup(actor, ctx));
    contextText = await buildContextText(actor, await resolveContext(actor, { type: "SETUP", id: ctx.setup.id }));
  } else if (req.accountId) {
    const account = await getAccount(actor, req.accountId);
    if (req.kind === "SETUP" && !canCreateSetup(actor, account)) throw new ForbiddenError("Setups legen Anker, BD oder Principal des Kunden an.");
    if (req.kind === "VORHABEN" && !(await canEditAccountPlan(actor, account.id))) throw new ForbiddenError("Vorhaben schlagen BD und Principal des Kunden vor.");
    contextText = await buildContextText(actor, await resolveContext(actor, { type: "ACCOUNT", id: account.id }));
    // Lage über die sichtbaren Setups des Kunden (kurz)
    const setups = await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, account.id) });
    const parts: string[] = [];
    for (const s of setups.slice(0, 5)) {
      const ctx = await loadSetupContext(actor, s.id);
      if (ctx && canViewSetup(actor, ctx)) parts.push(analysisToText(await analyzeSetup(actor, ctx)));
    }
    analysisText = parts.join("\n---\n");
  } else {
    throw new ValidationError("Für einen Vorschlag braucht es Kunde oder Setup.");
  }

  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  if (!info.enabled || !provider.suggestForm) return { suggestion: null, note: "KI ist deaktiviert – bitte von Hand ausfüllen.", missing: [] };

  const input: FormSuggestInput = { kind: req.kind, fields: req.fields, contextText, analysisText };
  const allowed = `${contextText}\n${analysisText}`;
  const allowedNames = new Set(req.fields.map((f) => f.name));
  const run = await runAiJob(actor, { task: "FORM_SUGGEST", setupId, promptVersion: FORM_SUGGEST_PROMPT_VERSION, inputText: JSON.stringify(input), dedupeKey: `form:${req.kind}:${setupId ?? req.accountId}:${Date.now()}`, provider }, async (p, opts) => {
    const raw = await p.suggestForm!(input, opts);
    const out = formSuggestionSchema.safeParse(raw);
    if (!out.success) throw new ValidationError("Die KI-Antwort entsprach nicht dem Schema.");
    // Nur bekannte Felder, Optionen nur aus der Liste
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.data.fields)) {
      if (!allowedNames.has(k)) continue;
      const def = req.fields.find((f) => f.name === k)!;
      if (def.options && !def.options.includes(v)) continue;
      if (v.trim()) fields[k] = v.trim();
    }
    const ok = evidenceFound(allowed, out.data.evidenceQuote);
    return { result: { ...out.data, fields, evidenceOk: ok }, itemCount: Object.keys(fields).length, rejectedCount: ok ? 0 : 1 };
  });
  const r = run.result;
  if (!r.evidenceOk || Object.keys(r.fields).length === 0) {
    return { suggestion: null, note: r.evidenceOk ? "Aus dem bekannten Kontext lässt sich noch nichts Belastbares vorschlagen." : "Der Vorschlag hatte keine belegbare Textstelle und wurde verworfen.", missing: r.missing.length ? r.missing : ["Erzähl dem Assistenten mehr zum Kunden (Anlass, Personen, Bedarf) – dann kann hier vorgeschlagen werden."] };
  }
  return { suggestion: { fields: r.fields, rationale: r.rationale, evidenceQuote: r.evidenceQuote, missing: r.missing }, note: "", missing: r.missing };
}
