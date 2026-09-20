import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type Tx } from "@/db/client";
import type { Actor } from "@/modules/identity/actor";
import { ANALYZE_DOCUMENT_PROMPT_VERSION } from "@/modules/ai/provider";

/** Vorschlag (Aktion, Kontaktaufnahme, offene Frage) aus einer Übernahme in die Vorschlagsliste des Setups schreiben. */
export type SuggestionSeed = {
  type: (typeof schema.suggestionTypeEnum.enumValues)[number];
  title: string;
  targetRole: string;
  observation: string;
  evidenceQuote: string;
  hypothesis?: string;
  nextStep?: string;
  whyNow?: string;
  uncertainty?: string;
  proposedQuestion?: string;
  mentionedPersonName?: string;
  priority: (typeof schema.priorityCategoryEnum.enumValues)[number];
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[„“"'.,;:!?()\-–]/g, "").trim();

export async function insertSuggestionCard(tx: Tx, actor: Actor, setupId: string, sourceId: string, trigger: string, s: SuggestionSeed): Promise<string> {
  const dedupeKey = sha(`${s.type}:${normalize(s.title)}:${sourceId}`);
  const existing = await tx.query.suggestions.findFirst({ where: and(eq(schema.suggestions.setupId, setupId), eq(schema.suggestions.dedupeKey, dedupeKey)) });
  if (existing) return existing.id;
  const [row] = await tx
    .insert(schema.suggestions)
    .values({
      workspaceId: actor.workspaceId,
      type: s.type,
      title: s.title,
      targetRole: s.targetRole,
      setupId,
      trigger,
      sourceIds: [sourceId],
      evidenceQuote: s.evidenceQuote.slice(0, 500),
      observation: s.observation.slice(0, 2000),
      hypothesis: s.hypothesis || null,
      uncertainty: s.uncertainty || null,
      whyNow: s.whyNow || null,
      nextStep: s.nextStep || null,
      proposedQuestion: s.proposedQuestion || null,
      mentionedPersonName: s.mentionedPersonName || null,
      priorityCategory: s.priority,
      dedupeKey,
      recheckTrigger: "Neue Quelle im Setup",
      provider: "intake",
      model: "uebernahme",
      promptVersion: ANALYZE_DOCUMENT_PROMPT_VERSION,
    })
    .returning();
  if (!row) throw new Error("Vorschlag konnte nicht angelegt werden");
  return row.id;
}
