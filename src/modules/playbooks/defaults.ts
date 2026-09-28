/**
 * Standard-Vorgehensmuster (Etappe 20). Werden je Arbeitsraum einmalig angelegt (Code ist stabil) und sind
 * danach frei bearbeitbar – Änderungen an den Vorlagen hier wirken nur auf neue Arbeitsräume.
 * Grundsatz: Gerüst zur Orientierung, keine Pflichtschleuse. Jeder Schritt darf begründet übersprungen werden.
 */
import type { PlaybookScope } from "@/db/schema";

export type DefaultStep = {
  title: string;
  goal: string;
  meddpicc: string;
  suggestedAction: string;
  doneCriterion: string;
  dueInDays: number;
};

export type DefaultPlaybook = { code: string; name: string; description: string; scope: PlaybookScope; steps: DefaultStep[] };

export const ALTKUNDEN_CODE = "ALTKUNDEN_REAKTIVIERUNG";

export const DEFAULT_PLAYBOOKS: DefaultPlaybook[] = [
  {
    code: ALTKUNDEN_CODE,
    name: "Altkunden-Reaktivierung",
    description:
      "Frühere Kunden gezielt wieder ansprechen: erst geben (Ergebnisrückblick), dann bitten (Referenz, Kontakte). MEDDPICC-basiert; endet mit Listung, Pitch oder bewusstem Zurückstellen.",
    scope: "ACCOUNT",
    steps: [
      {
        title: "Lage und Anlass prüfen",
        goal: "Wissen, was sich beim Kunden seit dem letzten Projekt verändert hat – und warum jetzt ein guter Zeitpunkt ist.",
        meddpicc: "Identify Pain, Champion",
        suggestedAction:
          "Öffentliche Unternehmensrecherche aktualisieren. Prüfen, wer von den früheren Ansprechpartnern noch da ist und wer gewechselt ist (frühere Fürsprecher bei neuen Arbeitgebern sind eigene Chancen). Aktuelle Vorhaben, Umstrukturierungen oder Ausschreibungen notieren.",
        doneCriterion: "Aktuelle Ansprechpartner und ein konkreter Anlass für die Kontaktaufnahme sind dokumentiert.",
        dueInDays: 7,
      },
      {
        title: "Ergebnisrückblick als Referenzbitte",
        goal: "Mit einem Mehrwert wieder ins Gespräch kommen statt mit einer Bitte – und dabei die Referenzfreigabe klären.",
        meddpicc: "Champion, Metrics",
        suggestedAction:
          "Einseitigen Rückblick auf das frühere Projekt vorbereiten (Ausgangslage, was geliefert wurde, belegbare Wirkung). Dem früheren Ansprechpartner schicken: „Stimmt das so – und dürfen wir es als Referenz nutzen?“",
        doneCriterion: "Rückmeldung des Kunden liegt vor; Referenzfreigabe ja/nein ist festgehalten.",
        dueInDays: 14,
      },
      {
        title: "Gespräch mit passenden Metriken",
        goal: "Den Nutzen früherer Arbeit auf die heutige Lage des Kunden übertragen.",
        meddpicc: "Metrics, Identify Pain",
        suggestedAction:
          "Termin vereinbaren. Zwei bis drei belegbare Kennzahlen aus vergleichbaren Projekten mitbringen und fragen, woran der Kunde heute Erfolg misst.",
        doneCriterion: "Gespräch geführt; aktuelle Ziele/Schmerzpunkte des Kunden und seine Reaktion sind notiert.",
        dueInDays: 21,
      },
      {
        title: "Proposition mit Qualitätsnachweis",
        goal: "Die erweiterte Leistung glaubwürdig vorstellen – ohne dass „Freelancer“ als Qualitätsverlust verstanden wird.",
        meddpicc: "Decision Criteria",
        suggestedAction:
          "Bewährte Verve-Qualität, jetzt ein Partner für alle Spezialistenprofile: durch die Geschäftserweiterung ergänzen persönlich ausgewählte Freelancer das Team zu gleicher Qualität, Verve steht für Auswahl und Ergebnis ein. Auswahlprozess und Vertragsmodell erläutern; typische Einkaufsfragen zum Freelancer-Einsatz vorbereitet haben.",
        doneCriterion: "Proposition vorgestellt; Einwände und Auswahlkriterien des Kunden sind notiert.",
        dueInDays: 28,
      },
      {
        title: "Entscheidungsweg klären und um Kontakte bitten",
        goal: "Verstehen, wer über externe Spezialisten entscheidet und wie man dorthin kommt.",
        meddpicc: "Economic Buyer, Decision Process, Paper Process",
        suggestedAction:
          "Fragen: Wer entscheidet über externe Spezialisten? Wie kommt man auf die Lieferantenliste bzw. in den Rahmenvertrag? Um Einführung bei den passenden Personen bitten (mehrere Kontakte, nicht nur einen).",
        doneCriterion: "Entscheider, Beschaffungsweg und mindestens ein neuer Kontakt oder Termin sind dokumentiert.",
        dueInDays: 35,
      },
      {
        title: "Listung, Pitch oder bewusstes Zurückstellen",
        goal: "Die Reaktivierung in einen konkreten nächsten Zustand überführen.",
        meddpicc: "Paper Process",
        suggestedAction:
          "Je nach Ergebnis: Listung beantragen, Pitch-Termin vereinbaren oder Einführung wahrnehmen. Bei konkretem Bedarf eine Chance anlegen. Passt es gerade nicht: Vorgehen mit Begründung zurückstellen und Wiedervorlage vereinbaren.",
        doneCriterion: "Chance angelegt, Listung beantragt, Pitch terminiert – oder begründet zurückgestellt.",
        dueInDays: 49,
      },
    ],
  },
  {
    code: "VERLAENGERUNG",
    name: "Verlängerung vor Einsatzende",
    description: "Laufende Einsätze rechtzeitig verlängern oder ausweiten – startet idealerweise sechs bis acht Wochen vor Einsatzende.",
    scope: "SETUP",
    steps: [
      { title: "Zufriedenheit und Wirkung abfragen", goal: "Belegen, was der Einsatz bewirkt hat.", meddpicc: "Metrics, Champion", suggestedAction: "Kurzes Gespräch mit dem Ansprechpartner: Was hat sich verbessert, was fehlt noch?", doneCriterion: "Rückmeldung und belegbare Wirkung sind notiert.", dueInDays: 7 },
      { title: "Anschlussbedarf klären", goal: "Herausfinden, was nach dem Einsatzende ansteht.", meddpicc: "Identify Pain", suggestedAction: "Nächste Vorhaben, offene Themen und zusätzliche Rollen im Team erfragen.", doneCriterion: "Anschlussbedarf (oder: kein Bedarf) ist dokumentiert.", dueInDays: 14 },
      { title: "Verlängerung oder Ausweitung anbieten", goal: "Rechtzeitig vor Einsatzende ein Angebot vorlegen.", meddpicc: "Decision Process, Paper Process", suggestedAction: "Angebot mit Laufzeit/Umfang abstimmen; Bestell- und Freigabeweg klären.", doneCriterion: "Angebot vorgelegt oder Ende des Einsatzes bewusst bestätigt.", dueInDays: 28 },
    ],
  },
  {
    code: "AUSSCHREIBUNG",
    name: "Ausschreibung bearbeiten",
    description: "Strukturiert durch eine Ausschreibung: bewusste Go/No-Go-Entscheidung, Fristen, Profile, Abgabe, Nachfassen.",
    scope: "OPPORTUNITY",
    steps: [
      { title: "Unterlagen sichten und Go/No-Go", goal: "Nur Ausschreibungen bearbeiten, die wir gewinnen können.", meddpicc: "Decision Criteria, Competition", suggestedAction: "Anforderungen, Zuschlagskriterien und Fristen prüfen; eigene Chancen und Wettbewerb einschätzen; Go/No-Go mit Begründung.", doneCriterion: "Go/No-Go-Entscheidung mit Begründung ist dokumentiert.", dueInDays: 3 },
      { title: "Bieterfragen fristgerecht stellen", goal: "Unklarheiten vor der Abgabe ausräumen.", meddpicc: "Decision Process", suggestedAction: "Offene Punkte sammeln und innerhalb der Fragefrist einreichen.", doneCriterion: "Fragen gestellt (oder: keine nötig).", dueInDays: 7 },
      { title: "Profile und Angebot erstellen", goal: "Passende Profile und ein vollständiges Angebot.", meddpicc: "Decision Criteria", suggestedAction: "Profile auswählen und freigeben lassen; Angebot und Pflichtunterlagen vollständig machen.", doneCriterion: "Angebot vollständig und intern freigegeben.", dueInDays: 14 },
      { title: "Abgabe und Nachfassen", goal: "Fristgerecht abgeben und dranbleiben.", meddpicc: "Paper Process", suggestedAction: "Fristgerecht abgeben; Termin für Nachfrage bzw. Präsentation festhalten.", doneCriterion: "Abgabe bestätigt; Ergebnis oder nächster Termin dokumentiert.", dueInDays: 21 },
    ],
  },
  {
    code: "ERSTGESPRAECH",
    name: "Neues Setup: Erstgespräch",
    description: "Für ein neues Team oder Vorhaben beim Kunden: Anlass klären, Buyingcenter kartieren, nächsten Termin sichern.",
    scope: "SETUP",
    steps: [
      { title: "Anlass und Ziel klären", goal: "Verstehen, was das Team erreichen will.", meddpicc: "Identify Pain, Metrics", suggestedAction: "Im Gespräch Ziele, Zeitrahmen und aktuelle Hindernisse erfragen.", doneCriterion: "Anlass und Ziel sind im Setup dokumentiert.", dueInDays: 7 },
      { title: "Buyingcenter kartieren", goal: "Wissen, wer entscheidet, wer beeinflusst und wer nutzt.", meddpicc: "Economic Buyer, Champion", suggestedAction: "Beteiligte Personen und ihre Rollen im Buyingcenter der Chance erfassen.", doneCriterion: "Mindestens Entscheider und Fürsprecher sind benannt (oder als offen markiert).", dueInDays: 14 },
      { title: "Nächsten Termin sichern", goal: "Aus dem Erstgespräch einen verbindlichen nächsten Schritt machen.", meddpicc: "Decision Process", suggestedAction: "Folgetermin oder konkrete Zusage vereinbaren.", doneCriterion: "Folgetermin steht oder Setup ist bewusst ruhend gestellt.", dueInDays: 21 },
    ],
  },
];
