/**
 * Schritt-Assistent (Etappe 20b): konkrete Entwürfe für den aktuellen Schritt eines Vorgehens –
 * Mail, Gesprächsleitfaden, Metriken, Fragen, Pitch-Text, Checkliste. Reine Funktionen ohne Datenbank,
 * damit Test-Anbieter und KI-freier Betrieb denselben regelbasierten Entwurf nutzen.
 *
 * Grundsatz: Entwürfe sind Formulierungshilfen. Tatsachen über den Kunden stammen nur aus den Daten;
 * wo etwas fehlt (Name, Kennzahl, Termin), steht ein Platzhalter in eckigen Klammern. Nichts wird versendet.
 */
import { z } from "zod";

export const draftKinds = ["EMAIL", "GESPRAECHSLEITFADEN", "METRIKEN", "FRAGEN", "PITCH", "CHECKLISTE", "NOTIZ"] as const;
export type DraftKind = (typeof draftKinds)[number];
export const draftKindLabel: Record<DraftKind, string> = {
  EMAIL: "Mail-Entwurf",
  GESPRAECHSLEITFADEN: "Gesprächsleitfaden",
  METRIKEN: "Metriken",
  FRAGEN: "Fragen",
  PITCH: "Pitch-Text",
  CHECKLISTE: "Checkliste",
  NOTIZ: "Notiz",
};

export type PlaybookStepInput = {
  playbookName: string;
  step: { position: number; total: number; title: string; goal: string; meddpicc: string; suggestedAction: string; doneCriterion: string };
  accountName: string;
  setupName: string;
  /** Bekannte Personen beim Kunden: „Name (Funktion)“ */
  people: string[];
  /** Offene Chancen dieses Setups (Titel) */
  opportunities: string[];
  /** Beobachtungen/Notizen des Setups (wörtlich) */
  observations: string[];
  /** Ergebnisse der bisherigen Schritte: „Schritt n – Titel: Ergebnis“ */
  previousResults: string[];
  /** Weiterer Kontext als Text (Quellen-Zusammenfassungen, Setup-Kontext) */
  contextText: string;
};

const loose = z.string().trim().max(6000).catch("");
export const stepDraftSchema = z.object({
  summary: z.string().trim().max(1200).catch(""),
  drafts: z
    .array(
      z.object({
        kind: z.enum(draftKinds).catch("NOTIZ"),
        title: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(6000),
        basedOn: z.array(loose).max(6).catch([]).default([]),
      }),
    )
    .max(6),
  openQuestions: z.array(z.string().trim().max(400)).max(6).catch([]).default([]),
});
export type StepDrafts = z.infer<typeof stepDraftSchema>;

const PROPOSITION =
  "bewährte Verve-Qualität – und durch unsere Geschäftserweiterung jetzt alle Spezialistenprofile aus einer Hand: Unser Team wird durch persönlich ausgewählte Freelancer in gleicher Qualität ergänzt, Verve steht für Auswahl und Ergebnis ein.";

function firstPerson(i: PlaybookStepInput): string {
  return i.people[0]?.replace(/\s*\(.*\)$/, "") || "[Name des früheren Ansprechpartners]";
}

function refFacts(i: PlaybookStepInput): string[] {
  // Beobachtungen, die nach früherer Leistung/Referenz klingen, zuerst
  const ref = i.observations.filter((o) => /verve|projekt|erbracht|geliefert|referenz|rollout|coaching|training/i.test(o));
  return (ref.length ? ref : i.observations).slice(0, 3);
}

/** Regelbasierter Entwurf je Schritttyp – erkennt den Typ am Titel/Vorschlag (Muster sind frei bearbeitbar). */
export function ruleBasedStepDrafts(i: PlaybookStepInput): StepDrafts {
  const t = `${i.step.title} ${i.step.suggestedAction}`.toLowerCase();
  const person = firstPerson(i);
  const facts = refFacts(i);
  const chance = i.opportunities[0] ?? "[Thema des möglichen Bedarfs]";
  const prev = i.previousResults.length ? `Bisher: ${i.previousResults.join(" · ")}` : "";
  const drafts: StepDrafts["drafts"] = [];
  const questions: string[] = [];

  if (/rückblick|referenz/.test(t)) {
    drafts.push({
      kind: "EMAIL",
      title: "Mail: Ergebnisrückblick und Referenzbitte",
      text: [
        `Betreff: Rückblick auf unser gemeinsames Projekt bei ${i.accountName}`,
        "",
        `Guten Tag ${person},`,
        "",
        `wir haben unser gemeinsames Projekt bei ${i.accountName} noch einmal zusammengefasst – was wir damals gemeinsam erreicht haben und welche Wirkung es hatte. Den einseitigen Rückblick finden Sie im Anhang.`,
        "",
        "Zwei kurze Fragen dazu:",
        "1. Stimmt das so aus Ihrer Sicht, oder würden Sie etwas ergänzen?",
        "2. Dürfen wir den Rückblick als Referenz verwenden (gern auch anonymisiert)?",
        "",
        "Gern würde ich mich auch kurz austauschen, was sich bei Ihnen seitdem getan hat – hätten Sie in den nächsten Wochen 20 Minuten?",
        "",
        "Viele Grüße",
        "[Ihr Name]",
      ].join("\n"),
      basedOn: facts,
    });
    drafts.push({
      kind: "NOTIZ",
      title: "Gliederung des Einseiters",
      text: [
        `Ergebnisrückblick ${i.accountName}`,
        "• Ausgangslage: [Was war die Herausforderung?]",
        `• Unsere Leistung: ${facts.length ? facts.join(" / ") : "[Leistungen aus dem Projekt]"}`,
        "• Wirkung: [belegbare Ergebnisse – z. B. Zeit, Qualität, Adoption; nur mit Quelle]",
        "• Zitat/Stimme des Kunden: [falls vorhanden]",
        "• Team und Zeitraum: [Rollen, Dauer]",
      ].join("\n"),
      basedOn: facts,
    });
    if (!i.people.length) questions.push("Wer war damals der Ansprechpartner – und ist die Person noch im Unternehmen?");
  } else if (/metrik|kennzahl/.test(t)) {
    drafts.push({
      kind: "METRIKEN",
      title: "Metriken zum Mitbringen",
      text: [
        "Aus dem früheren Projekt (nur belegte Zahlen verwenden):",
        "• [Kennzahl 1, z. B. Durchlaufzeit vorher/nachher]",
        "• [Kennzahl 2, z. B. Anzahl eingeführter Nutzer/Teams]",
        "• [Kennzahl 3, z. B. eingesparte Aufwände]",
        "",
        "Beim Kunden erfragen:",
        "• Woran messen Sie heute Erfolg in diesem Bereich?",
        "• Welche Kennzahl würde sich in 6 Monaten verbessert haben müssen?",
      ].join("\n"),
      basedOn: facts,
    });
    drafts.push({
      kind: "GESPRAECHSLEITFADEN",
      title: "Gesprächsleitfaden (20–30 Minuten)",
      text: [
        "1. Einstieg: Dank für die Rückmeldung zum Rückblick; kurz, was damals erreicht wurde.",
        "2. Heute: Was hat sich seitdem verändert? Welche Vorhaben stehen an?",
        "3. Metriken: Woran messen Sie Erfolg? Wo drückt es gerade?",
        `4. Brücke: Wie wir damals geholfen haben – übertragbar auf ${chance}?`,
        "5. Nächster Schritt: Folgetermin mit den richtigen Personen vereinbaren.",
        prev,
      ].filter(Boolean).join("\n"),
      basedOn: [],
    });
  } else if (/proposition|qualitätsnachweis|pitch-text/.test(t)) {
    drafts.push({
      kind: "PITCH",
      title: "Proposition in drei Sätzen",
      text: [
        `Sie kennen uns aus ${facts.length ? "unserer früheren Zusammenarbeit" : "[früheres Projekt]"} – ${PROPOSITION}`,
        "Das heißt für Sie: ein Ansprechpartner, ein Vertrag, alle Profile – von der Projektleitung bis zur Spezialistin.",
        "Jede Person wählen wir persönlich aus und begleiten den Einsatz selbst; die Qualität, die Sie von uns kennen, bleibt der Maßstab.",
      ].join("\n\n"),
      basedOn: facts,
    });
    drafts.push({
      kind: "FRAGEN",
      title: "Mögliche Einwände – und Antworten",
      text: [
        "„Freelancer – ist das nicht schlechtere Qualität?“ → Persönliche Auswahl nach unseren Kriterien, Verve verantwortet das Ergebnis, [Auswahlprozess kurz erläutern].",
        "„Wie läuft das vertraglich / im Einkauf?“ → [Vertragsmodell erläutern; Fragen zum Freelancer-Einsatz vorbereitet haben].",
        "„Wir haben schon Dienstleister.“ → Ergänzung für Profile, die dort fehlen – ohne zusätzlichen Vertragsaufwand.",
      ].join("\n"),
      basedOn: [],
    });
  } else if (/entscheid|kontakt|einkauf|lieferant|beschaffung/.test(t)) {
    drafts.push({
      kind: "FRAGEN",
      title: "Fragen zum Entscheidungsweg",
      text: [
        "• Wer entscheidet bei Ihnen über den Einsatz externer Spezialisten?",
        "• Wie kommt ein Dienstleister auf Ihre Lieferantenliste bzw. in den Rahmenvertrag – und wer betreut das?",
        "• Gibt es einen Beschaffungsweg über eine Plattform oder einen Vendor-Manager?",
        "• Wer wäre fachlich die richtige Person für ein erstes Gespräch?",
        "• Dürfen wir uns dabei auf Sie beziehen?",
      ].join("\n"),
      basedOn: i.observations.filter((o) => /vendor|liefer|vertrag|einkauf|beschaff/i.test(o)).slice(0, 2),
    });
    drafts.push({
      kind: "EMAIL",
      title: "Mail: Bitte um Einführung",
      text: [
        "Betreff: Kurze Bitte – Kontakt zu [Name/Funktion]",
        "",
        `Guten Tag ${person},`,
        "",
        "vielen Dank für das gute Gespräch. Wie besprochen würde ich mich gern mit [Name/Funktion] austauschen, um zu verstehen, wie wir bei Ihnen als Dienstleister gelistet werden können.",
        "Wären Sie so freundlich, uns kurz miteinander bekannt zu machen? Ein kurzer Satz per Mail genügt völlig.",
        "",
        "Viele Grüße",
        "[Ihr Name]",
      ].join("\n"),
      basedOn: [],
    });
  } else if (/listung|zurückstell|pitch/.test(t)) {
    drafts.push({
      kind: "EMAIL",
      title: "Mail: Listung anfragen",
      text: [
        "Betreff: Aufnahme als Dienstleister – Verve Consulting",
        "",
        "Guten Tag [Name Vendor-/Lieferantenmanagement],",
        "",
        `auf Empfehlung von ${person} melde ich mich bei Ihnen: Wir haben bei ${i.accountName} bereits erfolgreich zusammengearbeitet und würden gern wieder als Dienstleister gelistet werden.`,
        "Welche Unterlagen und welchen Weg benötigen Sie dafür von uns?",
        "",
        "Viele Grüße",
        "[Ihr Name]",
      ].join("\n"),
      basedOn: facts.slice(0, 1),
    });
    drafts.push({
      kind: "NOTIZ",
      title: "Entscheidungshilfe",
      text: [
        "• Konkreter Bedarf erkennbar? → Chance anlegen und Pitch-Termin vereinbaren.",
        "• Nur Listung möglich? → Listung beantragen, Wiedervorlage setzen.",
        "• Gerade kein Bedarf? → Vorgehen zurückstellen, Grund und Wiedervorlage festhalten.",
        prev,
      ].filter(Boolean).join("\n"),
      basedOn: [],
    });
  } else {
    drafts.push({
      kind: "CHECKLISTE",
      title: "Checkliste für diesen Schritt",
      text: [
        "• Öffentliche Unternehmensrecherche aktualisieren (Kundenseite → „Aktualisieren“).",
        `• Frühere Ansprechpartner prüfen: ${i.people.length ? i.people.join(", ") : "[aus dem alten Projekt nachtragen]"} – noch da? gewechselt?`,
        "• Frühere Fürsprecher, die gewechselt sind: beim neuen Arbeitgeber als eigene Chance notieren.",
        "• Aktuelle Vorhaben, Umstrukturierungen, Ausschreibungen notieren.",
        "• Einen konkreten Anlass für die Kontaktaufnahme formulieren.",
      ].join("\n"),
      basedOn: [],
    });
    if (!i.people.length) questions.push("Welche Personen aus dem früheren Projekt sind bekannt?");
  }

  return {
    summary: `${i.step.title} (Schritt ${i.step.position}/${i.step.total}) für ${i.accountName}: ${drafts.length} Entwurf/Entwürfe als Ausgangspunkt – Platzhalter in [eckigen Klammern] ergänzen, nichts wird automatisch versendet.`,
    drafts,
    openQuestions: questions,
  };
}

export function stepInputToText(i: PlaybookStepInput): string {
  return [
    `Vorgehen: ${i.playbookName} – Schritt ${i.step.position}/${i.step.total}: ${i.step.title}`,
    i.step.goal && `Ziel: ${i.step.goal}`,
    i.step.meddpicc && `MEDDPICC: ${i.step.meddpicc}`,
    i.step.suggestedAction && `Vorschlag: ${i.step.suggestedAction}`,
    i.step.doneCriterion && `Erledigt, wenn: ${i.step.doneCriterion}`,
    `Kunde: ${i.accountName} · Setup: ${i.setupName}`,
    i.people.length ? `Bekannte Personen: ${i.people.join("; ")}` : "Bekannte Personen: keine erfasst",
    i.opportunities.length ? `Chancen: ${i.opportunities.join("; ")}` : "",
    i.observations.length ? `Beobachtungen:\n${i.observations.map((o) => `- ${o}`).join("\n")}` : "",
    i.previousResults.length ? `Ergebnisse bisheriger Schritte:\n${i.previousResults.map((o) => `- ${o}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
