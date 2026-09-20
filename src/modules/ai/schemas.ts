import { z } from "zod";

/**
 * Ausgabeschema der KI-Strukturierung (Briefing 14.1 „Strukturierung“, 14.2 Standardstruktur).
 * Alles, was das Modell liefert, wird hiergegen validiert; ungültige Referenzen werden zurückgewiesen.
 * Version des Schemas = Version des Prompts (STRUCTURE_NOTE_PROMPT_VERSION).
 */

export const suggestionTypeValues = ["BEOBACHTUNG", "AKTION", "ENTSCHEIDUNG", "OFFENE_FRAGE", "PERSON", "KONFLIKT", "KONTAKTAUFNAHME"] as const;
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

export const decisionRoleValues = ["BEDARFSTRAEGER", "FACHLICHE_BEWERTUNG", "BUDGETVERANTWORTUNG", "EINKAUF_VERTRAGSWEG", "ZUSAETZLICHE_FREIGABE", "UNTERSTUETZER_SPONSOR"] as const;
export const stanceValues = ["UNBEKANNT", "POSITIV", "NEUTRAL", "KRITISCH"] as const;
export const influenceValues = ["UNBEKANNT", "HOCH", "MITTEL", "NIEDRIG"] as const;

export const intakePersonSchema = z.object({
  displayName: z.string().min(2).max(200),
  functionTitle: z.string().max(200).optional().default(""),
  email: z.string().max(200).optional().default(""),
  knownResponsibility: z.string().max(500).optional().default(""),
  /** Etappe 7B: Einschätzung (Hypothese) zur Rolle in der Entscheidung, Haltung zu Verve, Einfluss – leer, wenn der Text nichts hergibt */
  decisionRole: z.enum(decisionRoleValues).nullable().optional().default(null),
  stance: z.enum(stanceValues).optional().default("UNBEKANNT"),
  influence: z.enum(influenceValues).optional().default("UNBEKANNT"),
  assessmentNote: z.string().max(500).optional().default(""),
  ...quoted,
});

/** Folgeaktivität mit adressierter Rolle (Etappe 7A) */
export const intakeActionSchema = z.object({
  title: z.string().min(3).max(300),
  description: z.string().max(2000).optional().default(""),
  ownerRole: z.enum(["BD", "ANKER", "PRINCIPAL"]).default("BD"),
  dueHint: z.string().max(100).optional().default(""),
  ...quoted,
});

/** Vorschlag für eine Kontaktaufnahme: über wen, mit welchem Anlass, Entwurf zum Bearbeiten – nie zum Versand */
export const intakeContactSchema = z.object({
  personName: z.string().min(2).max(200),
  viaVerveName: z.string().max(200).optional().default(""),
  occasion: z.string().min(3).max(500),
  draftMessage: z.string().max(1500).optional().default(""),
  ...quoted,
});

export const artifactCodeValues = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12", "A13", "A14", "A15", "A16"] as const;
export const intakeArtifactSchema = z.object({ code: z.enum(artifactCodeValues), why: z.string().min(3).max(500) });

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
  /** Etappe 7A: Folgeaktivitäten, Kontaktaufnahmen, Artefaktempfehlungen */
  actions: z.array(intakeActionSchema).max(15).default([]),
  contacts: z.array(intakeContactSchema).max(15).default([]),
  artifacts: z.array(intakeArtifactSchema).max(6).default([]),
  /** Kurze Zusammenfassung des Dokuments in Kundensprache (Sachverhalt, keine Bewertung) */
  summary: z.string().max(2000).optional().default(""),
  noProposalReason: z.string().max(500).optional().default(""),
});

// ---------------------------------------------------------------------------
// Etappe 7A: Interview – nächste Frage
// ---------------------------------------------------------------------------

export const interviewTopicValues = ["ORGANISATION", "ANLASS_KONTEXT", "PERSONEN_ROLLEN", "ENTSCHEIDUNGSWEG", "BEDARF", "ZEIT_BUDGET", "WETTBEWERB_BESTAND", "BEZIEHUNGEN_ZUGANG", "NAECHSTE_SCHRITTE"] as const;
export type InterviewTopic = (typeof interviewTopicValues)[number];

export const interviewTopicLabel: Record<InterviewTopic, string> = {
  ORGANISATION: "Organisation",
  ANLASS_KONTEXT: "Anlass und Kontext",
  PERSONEN_ROLLEN: "Personen und Funktionen",
  ENTSCHEIDUNGSWEG: "Entscheidungsweg",
  BEDARF: "Bedarf in Kundensprache",
  ZEIT_BUDGET: "Zeit und Budget",
  WETTBEWERB_BESTAND: "Bestand und Wettbewerb",
  BEZIEHUNGEN_ZUGANG: "Beziehungen und Zugang",
  NAECHSTE_SCHRITTE: "Nächste Schritte",
};

export const interviewNextSchema = z.object({
  /** Leer, wenn done=true */
  question: z.string().max(600).default(""),
  /** Warum diese Frage jetzt (wird dem Nutzer gezeigt) */
  rationale: z.string().max(300).optional().default(""),
  topic: z.enum(interviewTopicValues).optional().nullable().default(null),
  /** Welche Themen der Verlauf bereits ausreichend abdeckt */
  covered: z.array(z.enum(interviewTopicValues)).default([]),
  done: z.boolean().default(false),
});
export type InterviewNext = z.infer<typeof interviewNextSchema>;

export type IntakeProposal = z.infer<typeof intakeProposalSchema>;
export type IntakePerson = z.infer<typeof intakePersonSchema>;
export type IntakeSignal = z.infer<typeof intakeSignalSchema>;
export type IntakeNeed = z.infer<typeof intakeNeedSchema>;
export type IntakeAction = z.infer<typeof intakeActionSchema>;
export type IntakeContact = z.infer<typeof intakeContactSchema>;

// ---------------------------------------------------------------------------
// Etappe 8: Assistent – Antwort in Prosa plus Vorschlagskarten
// ---------------------------------------------------------------------------

export const ASSISTANT_CARDS_MARKER = "===KARTEN===";

const q = { evidenceQuote: z.string().min(3).max(500) };

export const assistantItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("KUNDE"), name: z.string().min(2).max(200), orgType: z.enum(orgTypeValues).optional().default("SONSTIGE"), setupName: z.string().min(3).max(200), contextNote: z.string().max(2000).optional().default(""), ...q }),
  z.object({ type: z.literal("SETUP"), name: z.string().min(3).max(200), contextNote: z.string().max(2000).optional().default(""), ...q }),
  z.object({ type: z.literal("PERSON"), displayName: z.string().min(2).max(200), functionTitle: z.string().max(200).optional().default(""), knownResponsibility: z.string().max(500).optional().default(""), decisionRole: z.enum(decisionRoleValues).nullable().optional().default(null), stance: z.enum(stanceValues).optional().default("UNBEKANNT"), influence: z.enum(influenceValues).optional().default("UNBEKANNT"), assessmentNote: z.string().max(500).optional().default(""), ...q }),
  z.object({ type: z.literal("SIGNAL"), observation: z.string().min(5).max(2000), relevanceHypothesis: z.string().max(2000).optional().default(""), ...q }),
  z.object({ type: z.literal("BEDARF"), title: z.string().min(3).max(200), needDescription: z.string().min(10).max(4000), ...q }),
  z.object({ type: z.literal("AKTION"), title: z.string().min(3).max(300), description: z.string().max(2000).optional().default(""), ownerRole: z.enum(["BD", "ANKER", "PRINCIPAL"]).default("BD"), dueHint: z.string().max(100).optional().default(""), ...q }),
  z.object({ type: z.literal("KONTAKT"), personName: z.string().min(2).max(200), viaVerveName: z.string().max(200).optional().default(""), occasion: z.string().min(3).max(500), draftMessage: z.string().max(1500).optional().default(""), ...q }),
  z.object({ type: z.literal("FRAGE"), question: z.string().min(3).max(500), ...q }),
]);
export type AssistantItem = z.infer<typeof assistantItemSchema>;

export const assistantOutputSchema = z.object({
  items: z.array(assistantItemSchema).max(20).default([]),
  /** Informationen, die für weitere Vorschläge fehlen – als konkrete Fragen formuliert */
  missing: z.array(z.string().min(3).max(300)).max(8).default([]),
});
export type AssistantOutput = z.infer<typeof assistantOutputSchema>;

/** Gespeicherte Karte: Vorschlag plus Entscheidung */
export type AssistantCard = { id: string; item: AssistantItem; status: "NEU" | "UEBERNOMMEN" | "VERWORFEN"; resultType?: string; resultId?: string; note?: string };

// ---------------------------------------------------------------------------
// Etappe 9: Strategiefaden und Formularvorschläge
// ---------------------------------------------------------------------------

export const strategyMoveSchema = z.object({
  title: z.string().trim().min(3).max(200),
  why: z.string().trim().max(600).default(""),
  ownerRole: z.enum(["BD", "ANKER", "PRINCIPAL"]).default("BD"),
  /** Wörtliche Textstelle aus der Lage (Analyse/Kontext), auf die sich der Zug stützt */
  evidenceQuote: z.string().trim().min(3).max(400),
});

export const strategyProposalSchema = z.object({
  /** Lage in 2–4 Sätzen: Wo stehen wir, was ist der Kern */
  summary: z.string().trim().min(10).max(1500),
  /** Der nächste große Schritt (Meilenstein), ein Satz */
  nextStep: z.string().trim().min(5).max(400),
  moves: z.array(strategyMoveSchema).max(5).default([]),
  risks: z.array(z.object({ text: z.string().trim().min(3).max(400), evidenceQuote: z.string().trim().min(3).max(400) })).max(5).default([]),
  openQuestions: z.array(z.string().trim().min(3).max(300)).max(5).default([]),
});
export type StrategyProposal = z.infer<typeof strategyProposalSchema>;

export const formKinds = ["VORHABEN", "SETUP", "BEDARF"] as const;
export type FormKind = (typeof formKinds)[number];

export const formSuggestionSchema = z.object({
  /** Feldname → Wert; nur Felder, für die es im Kontext eine Grundlage gibt */
  fields: z.record(z.string(), z.string().max(2000)),
  /** Warum so – ein bis zwei Sätze, werden angezeigt */
  rationale: z.string().trim().max(600).default(""),
  /** Wörtliche Textstelle aus dem Kontext, auf die sich der Vorschlag stützt */
  evidenceQuote: z.string().trim().min(3).max(400),
  /** Was fehlt, um besser vorschlagen zu können */
  missing: z.array(z.string().trim().min(3).max(300)).max(4).default([]),
});
export type FormSuggestion = z.infer<typeof formSuggestionSchema>;
