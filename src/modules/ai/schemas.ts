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

// ---------------------------------------------------------------------------
// Etappe 6B: Anlagevorschlag aus einem Dokument („Dokument analysieren“)
// ---------------------------------------------------------------------------

export const orgTypeValues = ["KONZERN", "TOCHTERGESELLSCHAFT", "EINZELUNTERNEHMEN", "OEFFENTLICH", "SONSTIGE"] as const;

const quoted = { evidenceQuote: z.string().min(3).max(500) };

export const intakePersonSchema = z.object({
  displayName: z.string().min(2).max(200),
  functionTitle: z.string().max(200).optional().default(""),
  email: z.string().max(200).optional().default(""),
  knownResponsibility: z.string().max(500).optional().default(""),
  ...quoted,
});

export const intakeSignalSchema = z.object({
  observation: z.string().min(5).max(2000),
  relevanceHypothesis: z.string().max(2000).optional().default(""),
  ...quoted,
});

export const intakeNeedSchema = z.object({
  title: z.string().min(3).max(200),
  needDescription: z.string().min(10).max(4000),
  ...quoted,
});

/**
 * Was das Modell aus einem Dokument vorschlagen darf: eine Organisation, ein Setup-Name, Personen mit Funktion,
 * Beobachtungen (Signale) und mögliche Bedarfe – jeweils mit Textstelle. Nichts davon wird ohne Bestätigung angelegt;
 * Bedarfe entstehen als „in Klärung“, Signale als „neu“, Personen mit Beziehung „Name/Funktion bekannt“.
 */
export const intakeProposalSchema = z.object({
  organization: z.object({
    name: z.string().min(2).max(200),
    orgType: z.enum(orgTypeValues).optional().default("SONSTIGE"),
    /** Name eines bereits bekannten Kunden aus der übergebenen Liste, falls das Dokument offenbar dazu gehört */
    possibleExistingAccount: z.string().max(200).optional().default(""),
    ...quoted,
  }).nullable(),
  setup: z.object({ name: z.string().min(3).max(200), contextNote: z.string().max(2000).optional().default("") }).nullable(),
  persons: z.array(intakePersonSchema).max(30).default([]),
  signals: z.array(intakeSignalSchema).max(30).default([]),
  needs: z.array(intakeNeedSchema).max(15).default([]),
  openQuestions: z.array(z.string().min(3).max(500)).max(15).default([]),
  /** Kurze Zusammenfassung des Dokuments in Kundensprache (Sachverhalt, keine Bewertung) */
  summary: z.string().max(2000).optional().default(""),
  noProposalReason: z.string().max(500).optional().default(""),
});

export type IntakeProposal = z.infer<typeof intakeProposalSchema>;
export type IntakePerson = z.infer<typeof intakePersonSchema>;
export type IntakeSignal = z.infer<typeof intakeSignalSchema>;
export type IntakeNeed = z.infer<typeof intakeNeedSchema>;
