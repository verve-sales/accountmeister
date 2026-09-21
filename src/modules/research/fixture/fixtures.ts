import type { CompanyFact } from "../adapter";

/**
 * Fixture-Fakten (fiktiv) für die Demo/Entwicklung. Ausschließlich öffentliche, unternehmensbezogene Angaben –
 * keine Personennamen. Der Seed-Kunde „Beispielkonzern AG (fiktiv)“ hat einen passenden Eintrag; jeder andere
 * Name erhält einen ehrlichen Platzhalter statt erfundener Fakten.
 */
export const FIXTURE_COMPANIES: Record<string, CompanyFact[]> = {
  beispielkonzern: [
    { label: "Branche", value: "Industrie / Maschinenbau (fiktiv)", sourceLabel: "Unternehmenswebsite (fiktiv)", sourceUrl: "https://beispielkonzern.example/ueber-uns", asOf: "2026-01" },
    { label: "Hauptsitz", value: "Frankfurt am Main (fiktiv)", sourceLabel: "Handelsregistereintrag (fiktiv)", sourceUrl: null, asOf: "2025-11" },
    { label: "Rechtsform", value: "Aktiengesellschaft (fiktiv)", sourceLabel: "Handelsregistereintrag (fiktiv)", sourceUrl: null, asOf: "2025-11" },
    { label: "Mitarbeiterzahl (öffentlich genannt)", value: "ca. 12.000 (fiktiv, konzernweit)", sourceLabel: "Geschäftsbericht (fiktiv)", sourceUrl: "https://beispielkonzern.example/geschaeftsbericht-2025", asOf: "2025-12" },
    { label: "Jüngste öffentliche Meldung", value: "Ankündigung einer neuen Digitalisierungsinitiative im Konzern (fiktiv)", sourceLabel: "Pressemitteilung (fiktiv)", sourceUrl: "https://beispielkonzern.example/presse/digitalisierung-2026", asOf: "2026-02" },
  ],
};

export function fixtureFactsFor(companyName: string): { facts: CompanyFact[]; matched: boolean } {
  const key = Object.keys(FIXTURE_COMPANIES).find((k) => companyName.toLowerCase().includes(k));
  if (key) return { facts: FIXTURE_COMPANIES[key]!, matched: true };
  return { facts: [], matched: false };
}
