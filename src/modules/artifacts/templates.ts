/**
 * Artefaktkatalog (Briefing Kap. 12) als versionierte Konfiguration.
 *
 * Jede Vorlage beschreibt: Verantwortliche/Auslöser, Abschnitte (mit Leitfragen), Datenbezug (an welches Objekt
 * das Artefakt gebunden wird), Qualitätskriterium und die aktuelle Umsetzung:
 *  - ANSICHT: das Artefakt existiert als lebende Ansicht in der Anwendung (z. B. A1 Accountplan)
 *  - TEXTENTWURF: bearbeitbarer, versionierter Textentwurf mit Abschnitten (dieses Modul)
 *  - FOLGT: Objektbezug noch nicht modelliert (z. B. Bedarf/Angebot in Etappe 5); Textentwurf ist trotzdem möglich
 *
 * Änderungen an Vorlagen erhöhen TEMPLATE_REGISTRY_VERSION; der Seed synchronisiert die Tabelle artifact_templates.
 * Bestehende Artefaktversionen behalten die Vorlagenversion, mit der sie erstellt wurden.
 */

export const TEMPLATE_REGISTRY_VERSION = 1;

export type ScopeType = "ACCOUNT" | "SETUP" | "SIGNAL" | "HANDOVER" | "ACCESS_PLAN" | "PERSON" | "REVIEW" | "OPPORTUNITY" | "OFFER" | "ORDER" | "ASSIGNMENT" | "GOAL";
export type Implementation = "ANSICHT" | "TEXTENTWURF" | "FOLGT";

export type TemplateSection = {
  key: string;
  label: string;
  hint: string; // Leitfrage / erwarteter Inhalt
  required?: boolean;
  /** Abschnitt darf in der externen Variante erscheinen (Standard: nein) */
  externalAllowed?: boolean;
};

export type ArtifactTemplate = {
  code: string; // A1 … A16, SETUP, WEEKLY, ZIEL
  name: string;
  responsible: string;
  trigger: string;
  scopeType: ScopeType;
  implementation: Implementation;
  viewPath?: string; // bei ANSICHT: Pfadmuster mit {id}
  qualityCriterion: string;
  externalVariantAllowed: boolean; // darf es eine Kundentext-Variante geben?
  sections: TemplateSection[];
};

export const ARTIFACT_TEMPLATES: ArtifactTemplate[] = [
  {
    code: "A1",
    name: "Kundenübersicht / Accountplan",
    responsible: "BD",
    trigger: "Kundenreview oder Änderung",
    scopeType: "ACCOUNT",
    implementation: "ANSICHT",
    viewPath: "/kunden/{id}",
    qualityCriterion: "Setups, eigene Aufträge, bestätigte Gespräche; Überblick ohne erfundene Potenzialzahlen",
    externalVariantAllowed: false,
    sections: [],
  },
  {
    code: "A2",
    name: "Kontakte und Beziehungen",
    responsible: "BD",
    trigger: "Neuer Kontakt oder Wechsel",
    scopeType: "SETUP",
    implementation: "ANSICHT",
    viewPath: "/setups/{id}/personen",
    qualityCriterion: "Kontaktverlauf und bestätigte Zuständigkeit; Einfluss und Zugang getrennt",
    externalVariantAllowed: false,
    sections: [],
  },
  {
    code: "A3",
    name: "Signalnotiz",
    responsible: "Anker oder BD",
    trigger: "Neue Beobachtung",
    scopeType: "SIGNAL",
    implementation: "ANSICHT",
    viewPath: "/setups/{setupId}",
    qualityCriterion: "Berechtigter Projektkontext; Beobachtung nicht in bestätigten Bedarf umdeuten",
    externalVariantAllowed: false,
    sections: [],
  },
  {
    code: "A4",
    name: "Übernahme / Rückmeldung",
    responsible: "BD bzw. Empfänger",
    trigger: "Übergabe",
    scopeType: "HANDOVER",
    implementation: "ANSICHT",
    viewPath: "/meine-arbeit",
    qualityCriterion: "Explizite Übernahme; Weiterleitung allein reicht nicht",
    externalVariantAllowed: false,
    sections: [],
  },
  {
    code: "A5",
    name: "Kontaktanbahnung",
    responsible: "BD",
    trigger: "Fehlender Zugang",
    scopeType: "ACCESS_PLAN",
    implementation: "ANSICHT",
    viewPath: "/setups/{setupId}/personen",
    qualityCriterion: "Bestehende Beziehungen; jede angenommene Verbindung kennzeichnen",
    externalVariantAllowed: true,
    sections: [
      { key: "vorstellung", label: "Weiterleitbare Vorstellung (Entwurf)", hint: "Kurzer Text, den der Beziehungshalter weitergeben kann. Nur zutreffende, freigegebene Angaben. Kein automatischer Versand.", externalAllowed: true },
      { key: "intern", label: "Interne Hinweise", hint: "Was bleibt intern? Herkunft der Information, Nutzungsgrenzen." },
    ],
  },
  {
    code: "A6",
    name: "Gesprächsvorbereitung",
    responsible: "Gesprächsführer",
    trigger: "Konkreter Termin",
    scopeType: "SETUP",
    implementation: "TEXTENTWURF",
    qualityCriterion: "Quellen und erlaubter Anlass; keine allgemeine Unternehmenspräsentation als Standard",
    externalVariantAllowed: false,
    sections: [
      { key: "ziel", label: "Ziel des Gesprächs", hint: "Welches Ergebnis soll das Gespräch bringen?", required: true },
      { key: "kontext", label: "Kontext", hint: "Was läuft beim Kunden, was wissen wir belegt?", required: true },
      { key: "beteiligte", label: "Beteiligte und Rollen", hint: "Wer eröffnet? Wer erklärt den fachlichen Kontext? Wer stellt die Bedarfsfragen? Wer fasst zusammen?" },
      { key: "fragen", label: "Relevante Fragen", hint: "Verständnisfragen statt Verkaufsargumente." },
      { key: "grenzen", label: "Grenzen", hint: "Welche Informationen bleiben intern? Was darf nicht angesprochen werden?", required: true },
      { key: "naechster_schritt", label: "Gewünschter nächster Schritt", hint: "Was wäre ein gutes Gesprächsende?" },
    ],
  },
  {
    code: "A7",
    name: "Bedarfsbriefing",
    responsible: "BD",
    trigger: "Konkrete Anfrage",
    scopeType: "OPPORTUNITY",
    implementation: "FOLGT",
    qualityCriterion: "Bedarfsträger und bestehender Prozess; offene Punkte sichtbar, kein Vollständigkeitszwang",
    externalVariantAllowed: false,
    sections: [
      { key: "aufgabe", label: "Aufgabe", hint: "Was soll die Person tun?", required: true },
      { key: "muss_erfahrung", label: "Muss-Erfahrung", hint: "Nur tatsächlich genannte Anforderungen." },
      { key: "rahmen", label: "Start, Dauer, Umfang, Standort/Arbeitsmodell", hint: "Offene Punkte als offen markieren." },
      { key: "kommerziell", label: "Rate / Budgetstand", hint: "Nur freigegebene Angaben; unbekannt ist nicht null." },
      { key: "auswahl", label: "Auswahl und Bestellweg", hint: "Wer entscheidet fachlich, wer beschafft?" },
      { key: "offen", label: "Offene Punkte", hint: "Was ist noch unklar und wer klärt es?" },
    ],
  },
  {
    code: "A8",
    name: "Risiko- / Qualifizierungsnotiz",
    responsible: "BD, bei Bedarf Principal",
    trigger: "Entscheidende Unsicherheit",
    scopeType: "SETUP",
    implementation: "TEXTENTWURF",
    qualityCriterion: "Zuständige fachliche/budgetäre/Einkaufsrollen; nur relevante Vertiefung",
    externalVariantAllowed: false,
    sections: [
      { key: "unsicherheit", label: "Entscheidende Unsicherheit", hint: "Was wissen wir nicht, das die nächste Entscheidung beeinflusst?", required: true },
      { key: "konsequenz", label: "Konsequenz", hint: "Was passiert, wenn die Annahme falsch ist?" },
      { key: "beleg", label: "Beleg", hint: "Worauf stützt sich die Einschätzung? Quelle nennen." },
      { key: "klaerung", label: "Klärungsaktion", hint: "Wer klärt was bis wann?" },
      { key: "meddpicc", label: "MEDDPICC (optional)", hint: "Metrics, Economic Buyer, Decision Criteria, Decision Process, Paper Process, Identify Pain, Champion (belegt!), Competition. Keine Pflicht, keine erfundenen Werte." },
    ],
  },
  {
    code: "A9",
    name: "Profilangebot",
    responsible: "BD",
    trigger: "Geprüftes Profil liegt vor",
    scopeType: "OFFER",
    implementation: "FOLGT",
    qualityCriterion: "Freigegebenes Profil/Matching; keine erfundenen Skills oder Kandidaten",
    externalVariantAllowed: true,
    sections: [
      { key: "passung", label: "Belegte Passung", hint: "Nur aus dem freigegebenen Profil.", required: true, externalAllowed: true },
      { key: "verfuegbarkeit", label: "Tatsächliche Verfügbarkeit", hint: "Bestätigt, nicht geschätzt.", externalAllowed: true },
      { key: "offen", label: "Offene Punkte", hint: "Was ist noch zu klären?" },
      { key: "konditionen", label: "Konditionen (soweit freigegeben)", hint: "Nur berechtigte Rollen sehen Konditionen." },
      { key: "naechster_schritt", label: "Nächster Schritt", hint: "Vorschlag für das weitere Vorgehen.", externalAllowed: true },
    ],
  },
  {
    code: "A10",
    name: "Auswahl- / Entscheidungsstand",
    responsible: "BD",
    trigger: "Nach Vorstellung",
    scopeType: "OPPORTUNITY",
    implementation: "FOLGT",
    qualityCriterion: "Bestätigte Rückmeldung; Interesse nicht als Auftrag markieren",
    externalVariantAllowed: false,
    sections: [
      { key: "feedback", label: "Rückmeldung des Kunden", hint: "Wörtlich oder sinngemäß mit Quelle.", required: true },
      { key: "auswaehlende", label: "Auswählende und Kriterien", hint: "Wer entscheidet nach welchen Kriterien?" },
      { key: "termin", label: "Vereinbarter Termin", hint: "Nur tatsächlich vereinbarte Termine." },
      { key: "beschaffung", label: "Beschaffungsstand", hint: "Interesse ist kein Auftrag." },
    ],
  },
  {
    code: "A11",
    name: "Auftrags- / Startübergabe",
    responsible: "BD mit zuständigen Funktionen",
    trigger: "Vor Start",
    scopeType: "ORDER",
    implementation: "FOLGT",
    qualityCriterion: "Geltender Vertrags-/Delivery-Prozess; keine eigene rechtliche Einsatzfreigabe durch KI",
    externalVariantAllowed: false,
    sections: [
      { key: "beauftragung", label: "Beauftragung und Vertragsweg", hint: "Nachweise referenzieren, nicht behaupten.", required: true },
      { key: "freigaben", label: "Erforderliche Freigaben", hint: "Compliance, Onboarding – Stand je Anforderung." },
      { key: "abrechnung", label: "Abrechnung und Zuständigkeiten", hint: "Wer ist wofür verantwortlich?" },
    ],
  },
  {
    code: "A12",
    name: "Verlängerung / Entwicklung",
    responsible: "BD mit Anker",
    trigger: "Laufender Einsatz",
    scopeType: "SETUP",
    implementation: "TEXTENTWURF",
    qualityCriterion: "Auftrag und Kundengespräch; Verlängerung nicht voraussetzen",
    externalVariantAllowed: false,
    sections: [
      { key: "laufzeit", label: "Laufzeit (beauftragt vs. geplant)", hint: "Ist das Enddatum beauftragt oder bisher nur geplant?", required: true },
      { key: "zufriedenheit", label: "Zufriedenheit", hint: "Belegte Rückmeldungen, keine Vermutungen." },
      { key: "naechste_phase", label: "Nächste Phase beim Kunden", hint: "Was muss in der nächsten Phase erreicht werden?" },
      { key: "planung", label: "Planung und offene Entscheidung", hint: "Wer entscheidet wann über eine Verlängerung?" },
    ],
  },
  {
    code: "A13",
    name: "Accountprioritäten",
    responsible: "Principal und BD",
    trigger: "Review",
    scopeType: "ACCOUNT",
    implementation: "ANSICHT",
    viewPath: "/kunden/{id}",
    qualityCriterion: "Gemeinsame Entscheidung; Priorität nicht allein aus KI-Schätzung",
    externalVariantAllowed: false,
    sections: [],
  },
  {
    code: "A14",
    name: "Coaching / Eskalation",
    responsible: "Principal bei Beteiligung",
    trigger: "Fallreview",
    scopeType: "SETUP",
    implementation: "TEXTENTWURF",
    qualityCriterion: "Fallreview; operative Verantwortung bleibt sichtbar; gesonderter Empfängerkreis",
    externalVariantAllowed: false,
    sections: [
      { key: "blockade", label: "Konkrete Blockade", hint: "Was blockiert den Fall – sachlich, ohne Personenbewertung.", required: true },
      { key: "hilfe", label: "Benötigte Hilfe", hint: "Begrenzt und konkret, z. B. Sparring oder Einführung über bestehenden Sponsor." },
      { key: "entscheidung", label: "Entscheidung / Auftrag", hint: "Was wurde vereinbart, wer übernimmt?" },
      { key: "rueckmeldung", label: "Rückmeldung", hint: "Wie und wann wird zurückgemeldet?" },
    ],
  },
  {
    code: "A15",
    name: "Falllernen",
    responsible: "BD mit Beteiligten",
    trigger: "Abschluss oder Richtungswechsel",
    scopeType: "SETUP",
    implementation: "TEXTENTWURF",
    qualityCriterion: "Tatsächlicher Verlauf; keine unbelegten Kausalitätsbehauptungen",
    externalVariantAllowed: false,
    sections: [
      { key: "was_geschah", label: "Was geschah", hint: "Verlauf anhand der dokumentierten Weeklys und Aktionen.", required: true },
      { key: "was_half", label: "Was half", hint: "Belegbar, nicht vermutet." },
      { key: "was_fehlte", label: "Was fehlte", hint: "Informationen, Zugang, Zeit?" },
      { key: "erkenntnis", label: "Übertragbare Erkenntnis", hint: "Was gilt auch für andere Fälle – vorsichtig formuliert." },
    ],
  },
  {
    code: "A16",
    name: "Zusatzleistungsnachweis",
    responsible: "Leistungserbringer",
    trigger: "Belegbarer Beitrag",
    scopeType: "SETUP",
    implementation: "TEXTENTWURF",
    qualityCriterion: "Nur freigegebene Vergütungsregeln; keine automatische Auszahlung oder Credit-Höhe",
    externalVariantAllowed: false,
    sections: [
      { key: "leistung", label: "Leistung", hint: "Was wurde konkret beigetragen?", required: true },
      { key: "zeitpunkt", label: "Zeitpunkt", hint: "Wann?" },
      { key: "wirkung", label: "Wirkung / Ergebnis", hint: "Belegbar; keine Kausalitätsbehauptung ohne Beleg." },
      { key: "belege", label: "Belege", hint: "Quellen referenzieren." },
      { key: "regel", label: "Regelreferenz und Prüfstatus", hint: "Vergütungsregeln sind noch nicht freigegeben – hier wird nichts berechnet." },
    ],
  },
  {
    code: "SETUP",
    name: "Projektsetup",
    responsible: "Anker und BD",
    trigger: "Neuer Einsatz-/Entwicklungskontext",
    scopeType: "SETUP",
    implementation: "ANSICHT",
    viewPath: "/setups/{id}",
    qualityCriterion: "Lebender Arbeitsbereich; Informationen dürfen unvollständig bleiben",
    externalVariantAllowed: false,
    sections: [],
  },
  {
    code: "WEEKLY",
    name: "Weekly-Protokoll",
    responsible: "Teilnehmende",
    trigger: "Weekly",
    scopeType: "REVIEW",
    implementation: "ANSICHT",
    viewPath: "/weeklys/{id}",
    qualityCriterion: "Bestätigter, versionierter Stand; Bestätiger sichtbar",
    externalVariantAllowed: false,
    sections: [],
  },
  {
    code: "ZIEL",
    name: "Zielvereinbarung",
    responsible: "CEO und Principal",
    trigger: "Zielgespräch",
    scopeType: "GOAL",
    implementation: "FOLGT",
    qualityCriterion: "Keine erfundenen Zielwerte, keine automatischen Quoten",
    externalVariantAllowed: false,
    sections: [
      { key: "ergebnis", label: "Gewünschtes Ergebnis", hint: "Was soll erreicht werden?", required: true },
      { key: "geltung", label: "Geltungsbereich und Zeitraum", hint: "Für wen, bis wann?" },
      { key: "kriterium", label: "Beobachtbares Erfolgskriterium", hint: "Woran erkennen wir Fortschritt?" },
      { key: "ausgangslage", label: "Ausgangslage mit Quelle", hint: "Unbekannt bleibt unbekannt." },
      { key: "voraussetzungen", label: "Voraussetzungen", hint: "Zeit, Budget, Zugang, Fähigkeiten, Freigaben." },
    ],
  },
];

export function getTemplate(code: string): ArtifactTemplate | undefined {
  return ARTIFACT_TEMPLATES.find((t) => t.code === code);
}
