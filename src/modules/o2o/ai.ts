import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { Actor } from "@/modules/identity/actor";
import { getAIProvider } from "@/modules/ai";
import { evidenceFound, runAiJob } from "@/modules/ai/jobs";
import { parseDocument, type Field, type ParsedDoc } from "./parse";
import { ORDER_DOCUMENT_PROMPT_VERSION } from "./prompt";

/**
 * e68: Vorlesen in zwei Stufen – die KI liest (wenn eingeschaltet) jedes Feld mit wörtlicher Textstelle; nur belegte und
 * plausible Werte zählen. Die Regeln laufen immer mit und füllen, was die KI nicht belegt, oder springen ganz ein, wenn
 * die KI aus ist oder ausfällt. Jedes Feld trägt, woher es kommt („KI“ oder „Regel“).
 */

const q = <T extends z.ZodTypeAny>(v: T) => z.object({ value: v, quote: z.string().max(400) }).nullable().optional();
const aiSchema = z.object({
  kind: q(z.enum(["BESTELLUNG", "ANGEBOT"])),
  contractPartner: q(z.string().max(200)),
  isIntermediary: q(z.boolean()),
  endCustomer: q(z.string().max(200)),
  orderNumber: q(z.string().max(80)),
  offerNumber: q(z.string().max(80)),
  brokerRef: q(z.string().max(80)),
  start: q(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  end: q(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  rate: q(z.object({ amount: z.number().positive(), unit: z.enum(["STUNDE", "TAG"]) })),
  volume: q(z.object({ amount: z.number().positive(), unit: z.enum(["STUNDEN", "TAGE"]) })),
  person: q(z.string().max(120)),
  role: q(z.string().max(160)),
});
export type AiOrderDoc = z.infer<typeof aiSchema>;

export type ReadResult = { parsed: ParsedDoc & { intermediary: Field<boolean> }; mode: "KI" | "REGELN"; note: string; model: string | null };

/** Eigene Firma: Name des Arbeitsraums und sein erstes Wort (z. B. „Verve Consulting“, „Verve“). */
export async function ownCompanyNames(workspaceId: string): Promise<string[]> {
  const ws = await db.query.workspaces.findFirst({ where: eq(schema.workspaces.id, workspaceId), columns: { name: true } });
  const name = ws?.name?.trim() ?? "";
  const first = name.split(/\s+/)[0] ?? "";
  return [...new Set([name, first.length >= 4 ? first : ""].filter(Boolean))];
}

const fieldOf = <T>(text: string, x: { value: T; quote: string } | null | undefined): Field<T> => (x && x.quote && evidenceFound(text, x.quote) ? { value: x.value, evidence: x.quote.replace(/\s+/g, " ").trim(), by: "KI" } : null);

/** KI-Ergebnis in die Felder des Vorlesens übersetzen; nur belegte, plausible Werte. */
export function fromAi(text: string, a: AiOrderDoc): Partial<ParsedDoc> & { intermediary?: Field<boolean> } {
  const out: Partial<ParsedDoc> & { intermediary?: Field<boolean> } = {};
  out.kind = fieldOf(text, a.kind);
  out.sender = fieldOf(text, a.contractPartner);
  out.intermediary = fieldOf(text, a.isIntermediary);
  out.endCustomer = fieldOf(text, a.endCustomer);
  out.orderNumber = fieldOf(text, a.orderNumber);
  out.offerNumber = fieldOf(text, a.offerNumber);
  out.brokerRef = fieldOf(text, a.brokerRef);
  out.start = fieldOf(text, a.start);
  out.end = out.start && a.end && a.end.value < out.start.value ? null : fieldOf(text, a.end);
  const rate = fieldOf(text, a.rate);
  if (rate) {
    const perDay = rate.value.unit === "STUNDE" ? rate.value.amount * 8 : rate.value.amount;
    const ok = rate.value.unit === "STUNDE" ? rate.value.amount >= 20 && rate.value.amount <= 600 : rate.value.amount >= 100 && rate.value.amount <= 5000;
    out.dailyRate = ok ? { value: Math.round(perDay * 100) / 100, evidence: rate.value.unit === "STUNDE" ? `${rate.evidence} (Stundensatz × 8)` : rate.evidence, by: "KI" } : null;
  }
  const vol = fieldOf(text, a.volume);
  if (vol) {
    const days = vol.value.unit === "STUNDEN" ? Math.round((vol.value.amount / 8) * 10) / 10 : vol.value.amount;
    out.days = days > 0 && days <= 2000 ? { value: days, evidence: vol.value.unit === "STUNDEN" ? `${vol.evidence} (Stunden ÷ 8)` : vol.evidence, by: "KI" } : null;
  }
  out.person = fieldOf(text, a.person);
  out.role = fieldOf(text, a.role);
  return out;
}

/** KI-Wert, wenn belegt; sonst Regelwert. */
export function merge(rules: ParsedDoc, ai: Partial<ParsedDoc> & { intermediary?: Field<boolean> }): ParsedDoc & { intermediary: Field<boolean> } {
  const keys = Object.keys(rules) as (keyof ParsedDoc)[];
  const out = { ...rules, intermediary: ai.intermediary ?? null } as ParsedDoc & { intermediary: Field<boolean> };
  for (const k of keys) if (ai[k]) (out as Record<string, unknown>)[k] = ai[k];
  return out;
}

export async function readDocument(actor: Actor, input: { text: string; fileName: string; knownPersons: string[]; knownAccounts: string[] }): Promise<ReadResult> {
  const ownCompany = await ownCompanyNames(actor.workspaceId);
  const rules = parseDocument(input.text, input.fileName, { knownPersons: input.knownPersons, ownNames: ownCompany });
  const provider = getAIProvider();
  const info = provider.info();
  if (!info.enabled || !provider.readOrderDocument || input.text.trim().length < 40) {
    return { parsed: { ...rules, intermediary: null }, mode: "REGELN", note: info.enabled ? "Kaum Text im Dokument – regelbasiert gelesen." : "KI ist aus – regelbasiert gelesen.", model: null };
  }
  try {
    const run = await runAiJob(
      actor,
      { task: "ORDER_DOCUMENT", promptVersion: ORDER_DOCUMENT_PROMPT_VERSION, inputText: input.text, dedupeKey: `o2o:${input.fileName}:${Date.now()}`, provider },
      async (prov, opts) => {
        const raw = await prov.readOrderDocument!({ text: input.text, fileName: input.fileName, ownCompany, knownAccounts: input.knownAccounts, knownPersons: input.knownPersons }, opts);
        const p = aiSchema.safeParse(raw);
        if (!p.success) throw new Error("Die KI-Antwort entsprach nicht dem Schema.");
        const f = fromAi(input.text, p.data);
        const offered = Object.values(p.data).filter(Boolean).length;
        const kept = Object.values(f).filter(Boolean).length;
        return { result: f, itemCount: kept, rejectedCount: Math.max(0, offered - kept) };
      },
    );
    return { parsed: merge(rules, run.result), mode: "KI", note: `Von der KI gelesen (${run.model}); jedes Feld mit Textstelle, nicht belegte Werte verworfen, Lücken regelbasiert ergänzt.`, model: run.model };
  } catch (e) {
    return { parsed: { ...rules, intermediary: null }, mode: "REGELN", note: `KI nicht verfügbar (${e instanceof Error ? e.message.slice(0, 100) : "Fehler"}) – regelbasiert gelesen.`, model: null };
  }
}
