import { ResearchAdapterError, type CompanyResearchAdapter, type CompanyResearchResult, type ResearchState } from "../adapter";
import { fixtureFactsFor } from "./fixtures";

/**
 * Fixture-Adapter für die öffentliche Unternehmensrecherche (Etappe 16).
 *
 * Stand: Vertrag, Begrenzung (nur Firmenname, nie Personenname) und Anzeige sind vollständig; ein echter
 * Web-Suchdienst ist bewusst NICHT angebunden. Voraussetzungen für den Echtbetrieb (außerhalb dieses Codes):
 * Auswahl eines Suchdienstes/Anbieters, API-Schlüssel in der Serverkonfiguration, Prüfung der Nutzungsbedingungen
 * dieses Anbieters, Kostenrahmen. Bis dahin liefert der Adapter Fixture-Fakten und kennzeichnet dies eindeutig.
 */
export class FixtureResearchAdapter implements CompanyResearchAdapter {
  readonly providerId = "WEB_RESEARCH" as const;

  async status(): Promise<ResearchState> {
    return { available: true, fixtureMode: true, lastError: null };
  }

  async research(input: { fixture: boolean; companyName: string }): Promise<CompanyResearchResult> {
    if (!input.fixture) {
      throw new ResearchAdapterError("NOT_CONFIGURED", "Echte Web-Recherche ist noch nicht konfiguriert (Suchdienst, API-Schlüssel und Prüfung der Nutzungsbedingungen fehlen).");
    }
    const name = input.companyName.trim();
    if (!name) throw new ResearchAdapterError("NOT_FOUND", "Kein Firmenname angegeben.");
    const { facts, matched } = fixtureFactsFor(name);
    const note = matched
      ? "Fixture-Daten (fiktiv) – kein echter Internetzugriff. Ausschließlich öffentliche Firmenangaben, keine Personennamen, ggf. veraltet."
      : `Für „${name}“ liegen keine Fixture-Daten vor (Demo-Anbieter kennt nur den Beispielkunden). Kein echter Internetzugriff bis ein Suchdienst konfiguriert ist.`;
    return { companyName: name, facts, note, fixtureMode: true };
  }
}
