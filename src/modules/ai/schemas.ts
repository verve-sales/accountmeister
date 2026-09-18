import { z } from "zod";

/**
 * Ausgabeschema der KI-Strukturierung (Briefing 14.1 „Strukturierung“, 14.2 Standardstruktur).
 * Alles, was das Modell liefert, wird hiergegen validiert; ungültige Referenzen werden zurückgewiesen.
 * Version des Schemas = Version des Prompts (STRUCTURE_NOTE_PROMPT_VERSION).
 */

export const suggestionTypeValues = ["BEOBACHTUNG", "AKTION", "ENTSCHEIDUNG", "OFFENE_FRAGE", "PERSON", "KONFLIKT"] as const;
export type SuggestionType = (typeof suggestionTypeValues)[number];

export const structuredItemSchema = z.object({
  type: z.enum(suggestionTypeValues),
  title: z.string().min(3).max(200),
  /** Wörtlich oder sinngemäß aus der Quelle – der Sachverhalt */
  observation: z.string().min(3).max(2000),
  /** Getrennt gekennzeichnete Idee/Vermutung des Modells (darf leer sein) */
  hypothesis: z.string().max(2000).optional().default(""),
  /** Textstelle in der Quelle, auf die sich der Vorschlag stützt – muss in der Quelle vorkommen */
  evidenceQuote: z.string().min(3).max(500),
  /** Erklärte Unsicherheit oder Voraussetzung */
  uncertainty: z.string().max(500).optional().default(""),
  whyNow: z.string().max(500).optional().default(""),
  nextStep: z.string().max(500).optional().default(""),
  proposedQuestion: z.string().max(500).optional().default(""),
  expectedResult: z.string().max(500).optional().default(""),
  /** Anzeigename einer beteiligten Verve-Person, falls im Text genannt (wird serverseitig aufgelöst) */
  proposedOwnerName: z.string().max(200).optional().default(""),
  /** Anzeigename einer erwähnten Kundenperson (nur bei type=PERSON) */
  mentionedPersonName: z.string().max(200).optional().default(""),
});

export const structureNoteOutputSchema = z.object({
  items: z.array(structuredItemSchema).max(30),
  /** Ehrliche Aussage des Anbieters, wenn keine belastbare Ergänzung möglich ist (14.6) */
  noSuggestionReason: z.string().max(500).optional().default(""),
});

export type StructuredItem = z.infer<typeof structuredItemSchema>;
export type StructureNoteOutput = z.infer<typeof structureNoteOutputSchema>;
