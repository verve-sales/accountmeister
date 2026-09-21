import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import type { DecisionRole } from "@/db/schema";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { decisionRoleLabel, epistemicLabel } from "@/lib/labels";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { getAIProvider } from "@/modules/ai";
import type { AIProvider, BuyingCenterAdviceInput } from "@/modules/ai/provider";
import { buyingCenterProposalSchema, decisionRoleValues, type BuyingCenterProposal, type BuyingCenterRoleHint } from "@/modules/ai/schemas";
import { evidenceFound, runAiJob } from "@/modules/ai/jobs";
import { buildContextText, resolveContext } from "@/modules/assistant/service";
import { analyzeOpportunity, opportunityAnalysisToText, type OpportunityAnalysis } from "./advisor";
import { getOpportunityDetail } from "./service";

/**
 * Buying-Center-Berater je Chance (Etappe 17, Anker-/BD-Wunsch: „ein Assistent, der die Buying-Center-Rollen
 * durchgeht, berät und Hinweise zum Lückenfüllen gibt“). Analog zum Chancen-Berater (Etappe 15): eine
 * versionierte Fassung, die KI schlägt vor (nur mit Textstelle, wo eine konkrete Angabe gemeint ist), der BD
 * prüft, ändert und speichert eine Fassung. Der Status je Rolle wird nicht gespeichert, sondern bei jedem
 * Aufruf aus dem Buyingcenter dieser Chance (decision_participations) berechnet – kein zweiter Datenbestand.
 */

export const BUYING_CENTER_ADVICE_PROMPT_VERSION = "buying-center-advice.v1";

export type BuyingCenterAdviceRow = typeof schema.buyingCenterAdvice.$inferSelect;

export type RoleStatus = {
  role: DecisionRole;
  label: string;
  state: "OFFEN" | "HYPOTHESE" | "BESTAETIGT";
  participants: { name: string; epistemicStatus: string }[];
};

/** Status je der sechs Entscheidungsrollen dieser Chance, aus dem Buyingcenter berechnet – keine KI beteiligt. */
export function computeRoleStatus(participations: { role: DecisionRole; personName: string | null; epistemicStatus: string }[]): RoleStatus[] {
  return decisionRoleValues.map((role) => {
    const rows = participations.filter((p) => p.role === role);
    const state: RoleStatus["state"] = rows.length === 0 ? "OFFEN" : rows.some((r) => r.epistemicStatus === "SACHVERHALT_BESTAETIGT") ? "BESTAETIGT" : "HYPOTHESE";
    return { role, label: decisionRoleLabel[role] ?? role, state, participants: rows.map((r) => ({ name: r.personName ?? "Funktion bekannt, Person offen", epistemicStatus: epistemicLabel[r.epistemicStatus] ?? r.epistemicStatus })) };
  });
}

/** Textfassung des Buyingcenter-Stands – Grundlage für KI-Eingaben und für die Grundierung der Belege. */
export function roleStatusToText(analysis: OpportunityAnalysis, roleStatus: RoleStatus[]): string {
  const lines = [
    `Chance: ${analysis.title} (Kunde: ${analysis.accountName} · Status ${analysis.statusLabel})`,
    ...roleStatus.map((r) => `${r.label}: ${r.state === "OFFEN" ? "offen" : r.state === "BESTAETIGT" ? "bestätigt" : "Hypothese"}${r.participants.length ? ` – ${r.participants.map((p) => `${p.name} (${p.epistemicStatus})`).join(", ")}` : ""}`),
  ];
  return lines.join("\n");
}

async function requireEditableBuyingCenter(actor: Actor, opportunityId: string) {
  const { analysis, ctx, canEdit } = await analyzeOpportunity(actor, opportunityId);
  const d = await getOpportunityDetail(actor, opportunityId);
  const roleStatus = computeRoleStatus(d.participations);
  return { analysis, ctx, canEdit, roleStatus };
}

export async function getBuyingCenterAdvice(actor: Actor, opportunityId: string) {
  const { analysis, canEdit, roleStatus } = await requireEditableBuyingCenter(actor, opportunityId);
  const versions = await db.query.buyingCenterAdvice.findMany({ where: eq(schema.buyingCenterAdvice.opportunityId, opportunityId), orderBy: desc(schema.buyingCenterAdvice.versionNo) });
  return { analysis, roleStatus, latest: versions[0] ?? null, versions, canEdit };
}

export type BuyingCenterAdviceProposalResult = { proposal: BuyingCenterProposal; rejected: number; basis: string; note: string; aiJobId: string | null };

/** KI-Vorschlag einholen – wird nicht gespeichert; der BD übernimmt ihn in das Formular. */
export async function proposeBuyingCenterAdvice(actor: Actor, opportunityId: string, deps: { provider?: AIProvider } = {}): Promise<BuyingCenterAdviceProposalResult> {
  const { analysis, ctx, canEdit, roleStatus } = await requireEditableBuyingCenter(actor, opportunityId);
  if (!canEdit) throw new ForbiddenError("Den Buying-Center-Berater pflegen Beteiligte mit Bearbeitungsrecht am Setup.");
  const basis = `${roleStatusToText(analysis, roleStatus)}\n${opportunityAnalysisToText(analysis)}`;
  const contextText = await buildContextText(actor, await resolveContext(actor, { type: "SETUP", id: ctx.setup.id }));
  const latest = await db.query.buyingCenterAdvice.findFirst({ where: eq(schema.buyingCenterAdvice.opportunityId, opportunityId), orderBy: desc(schema.buyingCenterAdvice.versionNo) });
  const provider = deps.provider ?? getAIProvider();
  const info = provider.info();
  if (!info.enabled || !provider.adviseBuyingCenter) {
    return { proposal: ruleBasedBuyingCenterAdvice(analysis, roleStatus), rejected: 0, basis, note: "KI deaktiviert – regelbasierter Vorschlag aus dem dokumentierten Buyingcenter-Stand.", aiJobId: null };
  }
  const input: BuyingCenterAdviceInput = { analysisText: basis, contextText, previous: latest ? { summary: latest.summary, createdAt: latest.createdAt.toISOString().slice(0, 10) } : null };
  const allowed = `${basis}\n${contextText}`;
  const run = await runAiJob(actor, { task: "BUYING_CENTER_ADVICE", setupId: ctx.setup.id, promptVersion: BUYING_CENTER_ADVICE_PROMPT_VERSION, inputText: JSON.stringify(input), dedupeKey: `buying-center-advice:${opportunityId}:${Date.now()}`, provider }, async (p, opts) => {
    const raw = await p.adviseBuyingCenter!(input, opts);
    const parsed = buyingCenterProposalSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError("Die KI-Antwort entsprach nicht dem Schema.");
    let rejected = 0;
    const roles = parsed.data.roles
      .filter((r) => decisionRoleValues.includes(r.role))
      .map((r) => {
        if (!r.evidenceQuote) return { ...r, proposedPersonName: "" }; // reine Methodik-Empfehlung: kein Beleg nötig, aber auch keine Person ohne Beleg
        if (!evidenceFound(allowed, r.evidenceQuote)) {
          rejected++;
          return { ...r, proposedPersonName: "", evidenceQuote: "" };
        }
        return r;
      });
    return { result: { proposal: { ...parsed.data, roles }, rejected }, itemCount: roles.length, rejectedCount: rejected };
  });
  const note = run.result.rejected > 0 ? `${run.result.rejected} Namensnennung(en) ohne belegbare Textstelle wurden verworfen (die Handlungsempfehlung selbst bleibt erhalten).` : "";
  return { proposal: run.result.proposal, rejected: run.result.rejected, basis, note, aiJobId: run.jobId };
}

const ROLE_HINTS: Record<DecisionRole, string> = {
  BEDARFSTRAEGER: "Im nächsten Gespräch klären, wer den Bedarf tatsächlich formuliert hat oder täglich davon betroffen ist.",
  FACHLICHE_BEWERTUNG: "Klären, wer die fachliche Eignung eines Profils bewertet – oft eine andere Person als der Bedarfsträger.",
  BUDGETVERANTWORTUNG: "Gezielt fragen, wer die Budgetentscheidung tatsächlich trifft – ein Titel allein belegt das nicht.",
  EINKAUF_VERTRAGSWEG: "Den Einkaufs-/Vertragsweg erfragen, bevor ein Angebot vorbereitet wird.",
  ZUSAETZLICHE_FREIGABE: "Prüfen, ob eine zusätzliche Freigabe (z. B. Compliance, Betriebsrat) nötig ist.",
  UNTERSTUETZER_SPONSOR: "Einen internen Unterstützer identifizieren, der den nächsten Schritt intern voranbringt.",
};

/** Regelbasierter Berater ohne KI – damit der Baustein nie leer bleibt. */
export function ruleBasedBuyingCenterAdvice(analysis: OpportunityAnalysis, roleStatus: RoleStatus[]): BuyingCenterProposal {
  const gaps = roleStatus.filter((r) => r.state !== "BESTAETIGT");
  const roles: BuyingCenterRoleHint[] = gaps.map((r) => ({
    role: r.role,
    hint: r.state === "HYPOTHESE" ? `Nur Hypothese – mit Quelle bestätigen (Gesprächsnotiz, Mail). ${ROLE_HINTS[r.role]}` : ROLE_HINTS[r.role],
    proposedPersonName: r.state === "HYPOTHESE" && r.participants[0] ? r.participants[0].name : "",
    evidenceQuote: r.state === "HYPOTHESE" ? roleStatusToText(analysis, [r]).split("\n")[1] ?? "" : "",
  }));
  return {
    summary: `Belegt: ${gaps.length === 0 ? "Alle sechs Rollen bestätigt." : `${gaps.length} von 6 Rollen offen oder nur Hypothese.`}`,
    roles,
    openQuestions: gaps.filter((r) => r.state === "OFFEN").slice(0, 5).map((r) => `Wer übernimmt bei diesem Kunden die Rolle „${r.label}“?`),
  };
}

const roleHintInput = z.object({ role: z.enum(decisionRoleValues), hint: z.string().trim().min(3).max(600), proposedPersonName: z.string().trim().max(200).optional().default(""), evidenceQuote: z.string().trim().max(400).optional().default("") });

export const saveBuyingCenterAdviceInput = z.object({
  opportunityId: z.string().min(1),
  summary: z.string().trim().min(10, "Lage in mindestens einem Satz.").max(1200),
  roles: z.array(roleHintInput).max(8).default([]),
  openQuestions: z.array(z.string().trim().min(3).max(300)).max(6).default([]),
  note: z.string().trim().max(600).optional().default(""),
  aiJobId: z.string().optional().nullable(),
});

/** Neue Fassung speichern – immer eine neue Version, nie überschreiben. */
export async function saveBuyingCenterAdvice(actor: Actor, raw: unknown) {
  const parsed = saveBuyingCenterAdviceInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const i = parsed.data;
  const { analysis, canEdit, roleStatus } = await requireEditableBuyingCenter(actor, i.opportunityId);
  if (!canEdit) throw new ForbiddenError("Den Buying-Center-Berater pflegen Beteiligte mit Bearbeitungsrecht am Setup.");
  const roles = i.roles.filter((r) => r.hint.trim()).map(({ role, hint, proposedPersonName, evidenceQuote }) => ({ role, hint, proposedPersonName, evidenceQuote }));
  return db.transaction(async (tx) => {
    const last = await tx.query.buyingCenterAdvice.findFirst({ where: eq(schema.buyingCenterAdvice.opportunityId, i.opportunityId), orderBy: desc(schema.buyingCenterAdvice.versionNo) });
    const [row] = await tx
      .insert(schema.buyingCenterAdvice)
      .values({ workspaceId: actor.workspaceId, opportunityId: i.opportunityId, versionNo: (last?.versionNo ?? 0) + 1, summary: i.summary, roles, openQuestions: i.openQuestions, basis: roleStatusToText(analysis, roleStatus), status: analysis.status, note: i.note || null, aiJobId: i.aiJobId ?? null, createdBy: actor.userId })
      .returning();
    await recordAudit(tx, actor, "buying_center_advice.version_saved", "BUYING_CENTER_ADVICE", row!.id, { opportunityId: i.opportunityId, versionNo: row!.versionNo, roles: roles.length });
    return row!;
  });
}

/** Formulardaten (ein festes Feld je der sechs Rollen, keine dynamische Liste) in die Eingabe übersetzen. */
export function formToBuyingCenterAdviceInput(data: Record<string, string>): unknown {
  const roles: Record<string, string>[] = [];
  for (const role of decisionRoleValues) {
    const hint = data[`role_${role}_hint`] ?? "";
    if (!hint.trim()) continue;
    roles.push({ role, hint, proposedPersonName: data[`role_${role}_person`] ?? "", evidenceQuote: data[`role_${role}_evidence`] ?? "" });
  }
  const openQuestions: string[] = [];
  for (let k = 0; k < 6; k++) {
    const v = data[`openQuestions.${k}.text`];
    if (v && v.trim()) openQuestions.push(v.trim());
  }
  return { opportunityId: data.opportunityId, summary: data.summary, roles, openQuestions, note: data.note ?? "", aiJobId: data.aiJobId || null };
}

export async function latestBuyingCenterAdvice(opportunityId: string) {
  return db.query.buyingCenterAdvice.findFirst({ where: and(eq(schema.buyingCenterAdvice.opportunityId, opportunityId)), orderBy: desc(schema.buyingCenterAdvice.versionNo) });
}
