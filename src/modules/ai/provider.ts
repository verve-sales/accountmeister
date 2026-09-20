import type { IntakeProposal, StructureNoteOutput } from "./schemas";

export const STRUCTURE_NOTE_PROMPT_VERSION = "structure-note.v1";
export const ANALYZE_DOCUMENT_PROMPT_VERSION = "analyze-document.v2";
export const INTERVIEW_NEXT_PROMPT_VERSION = "interview-next.v1";

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
  /** Verbrauch des letzten Aufrufs (Kostenspur), falls der Anbieter ihn liefert. */
  lastUsage?(): Usage | null;
  /** Verfügbare Modelle im Arbeitsraum des Anbieters (für die Konfigurationsseite). */
  listModels?(): Promise<ModelInfo[]>;
  /** Minimale Testanfrage ohne Inhalte (Verbindungsprüfung, wenn die Modellliste nicht erlaubt ist). */
  ping?(opts?: TaskOptions): Promise<void>;
}

export type { StructureNoteOutput, IntakeProposal };
