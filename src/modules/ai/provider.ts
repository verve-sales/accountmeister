import type { StructureNoteOutput } from "./schemas";

export const STRUCTURE_NOTE_PROMPT_VERSION = "structure-note.v1";

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

export type ProviderInfo = { id: "disabled" | "test" | "production"; model: string; enabled: boolean; description: string };

/**
 * Anbietervertrag (Briefing 2.3 / 14.4): Der Anbieter liefert ausschließlich Vorschlagsdaten; er hat keinen
 * Zugriff auf Datenbank oder Tools und kann keine externen Aktionen auslösen.
 */
export interface AIProvider {
  info(): ProviderInfo;
  structureNote(input: StructureNoteInput): Promise<unknown>; // roh – wird vom Aufrufer gegen das Schema geprüft
}

export type { StructureNoteOutput };
