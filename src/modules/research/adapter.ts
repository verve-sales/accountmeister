/**
 * Anbietervertrag für die öffentliche Unternehmensrecherche (Etappe 16, Briefing-Ausnahme: die KI recherchiert
 * grundsätzlich nicht im Internet – hier eng begrenzt auf öffentliche Firmendaten). Strukturell erzwungen:
 * die einzige Eingabe ist ein Firmenname (aus dem Kundendatensatz), nie ein Personenname. Der Adapter liefert
 * ausschließlich Fakten mit Quellenangabe, keine Bewertung, keine Wahrscheinlichkeit, keine Kontaktvorschläge.
 */

export type CompanyFact = {
  label: string;
  value: string;
  sourceLabel: string;
  sourceUrl: string | null;
  /** Stand der Angabe, sofern bekannt (nicht der Abrufzeitpunkt) */
  asOf: string | null;
};

export type CompanyResearchResult = {
  companyName: string;
  facts: CompanyFact[];
  note: string;
  fixtureMode: boolean;
};

export type ResearchState = {
  available: boolean;
  fixtureMode: boolean;
  lastError: string | null;
};

export interface CompanyResearchAdapter {
  readonly providerId: "WEB_RESEARCH";
  status(): Promise<ResearchState>;
  /** Recherche zu genau einem Firmennamen – nie zu einer Person. */
  research(input: { fixture: boolean; companyName: string }): Promise<CompanyResearchResult>;
}

export class ResearchAdapterError extends Error {
  readonly kind: "NOT_CONFIGURED" | "TEMPORARY" | "NOT_FOUND";
  constructor(kind: ResearchAdapterError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}
