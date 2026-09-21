import type { IntakeProposal, StructureNoteOutput } from "./schemas";

export const STRUCTURE_NOTE_PROMPT_VERSION = "structure-note.v1";
export const ANALYZE_DOCUMENT_PROMPT_VERSION = "analyze-document.v2";
export const INTERVIEW_NEXT_PROMPT_VERSION = "interview-next.v1";
export const ASSISTANT_PROMPT_VERSION = "assistant.v1";

/** Berechtigter Kontext, den der Anbieter erhalten darf – keine Rohquellen außer dem zu strukturierenden Text. */
export type StructureNoteInput = {
  noteText: string;
  setupName: string;
  /** Anzeigenamen der beteiligten Verve-Personen (für Zuordnung von Aktionen) */
  participantNames: string[];
  /** Anzeigenamen bekannter Kundenpersonen (für PERSON-Erkennung) */
  knownPersonNames: string[];
  /** Bereits dokumentierte bestätigte Aussagen (für KONFLIKT-Erkennung), nur Text */
  confirmedAssertions: string[];
};

/** Kontext für „Dokument analysieren“ (Kundenanlage): nur der Dokumenttext und Namen bereits bekannter Kunden. */
export type AnalyzeDocumentInput = {
  documentText: string;
  fileName: string;
  knownAccountNames: string[];
};

/** Kontext für die nächste Interviewfrage: bekannter Stand als Text, bisheriger Verlauf, Grenzen. */
export type InterviewNextInput = {
  kind: "KUNDE_NEU" | "SETUP_ERGAENZUNG";
  /** Kurzer, berechtigter Kontext (Namen, Setup, bekannte Personen, offene Bedarfe) als Text */
  knownContext: string;
  transcript: { role: "KI" | "NUTZER"; text: string }[];
  questionCount: number;
  maxQuestions: number;
};

/** Kontext für den Assistenten: berechtigter Kontext als Text, Verlauf, Modus. */
export type AssistantInput = {
  contextText: string;
  history: { role: "NUTZER" | "ASSISTENT"; text: string }[];
  interviewMode: boolean;
  /** Vom System ermittelte offene Punkte und fehlende Informationen (Text) */
  openPoints: string;
};

/** Strategiefaden (Etappe 9): Lageanalyse (regelbasiert) + Kontext als Text, letzte Fassung des Fadens. */
export type StrategyInput = {
  analysisText: string;
  contextText: string;
  previous: { summary: string; nextStep: string; createdAt: string } | null;
};

/**
 * Chancen-Berater (Etappe 15): identische Form wie der Strategiefaden, aber je Bedarf statt je Setup – die
 * Lageanalyse bezieht sich auf genau eine Chance (Status, Buyingcenter, Angebot/Auftrag), nicht auf das ganze Setup.
 */
export type OpportunityAdviceInput = StrategyInput;

/** Formularvorschlag (Etappe 9): welches Formular, welche Felder mit Bedeutung, bekannter Kontext. */
export type FormSuggestInput = {
  kind: "VORHABEN" | "SETUP" | "CHANCE";
  fields: { name: string; label: string; options?: string[] }[];
  contextText: string;
  analysisText: string;
};

/** Aufgabenbezogene Modellwahl (Verwaltung → KI). Anbieter ohne Modellwahl ignorieren sie. */
export type TaskOptions = { model?: string; temperature?: number; maxOutputTokens?: number };

export type Usage = { tokensIn: number | null; tokensOut: number | null; model: string };

export type ProviderId = "disabled" | "test" | "langdock" | "production";
export type ProviderInfo = { id: ProviderId; model: string; enabled: boolean; description: string };

export type ModelInfo = { id: string; ownedBy?: string };

/**
 * Anbietervertrag (Briefing 2.3 / 14.4): Der Anbieter liefert ausschließlich Vorschlagsdaten; er hat keinen
 * Zugriff auf Datenbank oder Tools und kann keine externen Aktionen auslösen. Rückgaben sind roh und werden
 * vom Aufrufer gegen das jeweilige Schema geprüft.
 */
export interface AIProvider {
  info(): ProviderInfo;
  structureNote(input: StructureNoteInput, opts?: TaskOptions): Promise<unknown>;
  /** Kundenanlage aus Dokument – optional; Anbieter ohne diese Fähigkeit werfen oder lassen es weg. */
  analyzeDocument?(input: AnalyzeDocumentInput, opts?: TaskOptions): Promise<unknown>;
  /** Nächste Interviewfrage (Etappe 7A) – optional. */
  interviewNext?(input: InterviewNextInput, opts?: TaskOptions): Promise<unknown>;
  /**
   * Assistent (Etappe 8): Antwort als Text (Prosa, dann ===KARTEN=== und JSON). onDelta liefert Textstücke zum
   * Streamen; die Rückgabe ist der vollständige Text.
   */
  assistantReply?(input: AssistantInput, opts?: TaskOptions, onDelta?: (chunk: string) => void): Promise<string>;
  /** Karten nachziehen (JSON-Modus), wenn die Assistenten-Antwort keine auswertbaren Karten enthielt – optional. */
  assistantCards?(input: AssistantInput & { prose: string }, opts?: TaskOptions): Promise<unknown>;
  /** Strategiefaden-Vorschlag (Etappe 9) – optional. */
  strategize?(input: StrategyInput, opts?: TaskOptions): Promise<unknown>;
  /** Chancen-Berater-Vorschlag (Etappe 15): nächste Schritte zur Konvertierung genau einer Chance – optional. */
  adviseOpportunity?(input: OpportunityAdviceInput, opts?: TaskOptions): Promise<unknown>;
  /** Formularfelder vorbelegen (Etappe 9) – optional. */
  suggestForm?(input: FormSuggestInput, opts?: TaskOptions): Promise<unknown>;
  /** Verbrauch des letzten Aufrufs (Kostenspur), falls der Anbieter ihn liefert. */
  lastUsage?(): Usage | null;
  /** Verfügbare Modelle im Arbeitsraum des Anbieters (für die Konfigurationsseite). */
  listModels?(): Promise<ModelInfo[]>;
  /** Minimale Testanfrage ohne Inhalte (Verbindungsprüfung, wenn die Modellliste nicht erlaubt ist). */
  ping?(opts?: TaskOptions): Promise<void>;
}

export type { StructureNoteOutput, IntakeProposal };
