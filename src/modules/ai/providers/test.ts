import type { AIProvider, ProviderInfo, StructureNoteInput } from "../provider";
import type { StructuredItem, StructureNoteOutput } from "../schemas";

/**
 * Deterministischer Testanbieter (Briefing 2.3): regelbasiert, ohne Netzwerk, ohne Modell.
 * Er dient der Entwicklung des Vorschlagslebenszyklus und der Evaluationsfälle. Er erfindet nichts:
 * Jeder Vorschlag zitiert wörtlich einen Satz der Notiz (evidenceQuote) und ordnet nur bekannte Namen zu.
 * Aufforderungen im Text („ignoriere …“, „markiere als bestätigt“) sind für ihn gewöhnliche Sätze – er führt nichts aus.
 */

const SPECULATION = /\b(könnte|vielleicht|möglicherweise|eventuell|wahrscheinlich|vermutlich|scheint|unklar ob)\b/i;
const DECISION = /\b(entschieden|beschlossen|vereinbart|wir haben uns geeinigt|einigung|festgelegt)\b/i;
const ACTION_VERB = /\b(übernimmt|kümmert sich|fragt|klärt|spricht .{0,40}? an|prüft|bereitet .{0,30}? vor|erstellt|schickt|sendet|ruft .{0,30}? an|meldet sich|organisiert|stellt .{0,30}? vor|bringt .{0,30}? mit)\b/i;
const OBSERVATION_VERB = /\b(wird|wurde|werden|gibt es|sucht|plant|planen|spricht|sprechen|berichtet|erwähnt|gesagt|hat gesagt|läuft|steht an|fehlt|braucht|benötigt|steigt|sinkt|beginnt|endet)\b/i;
const DATE = /\b(\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2}|q[1-4]\s?\d{2,4}|ende \w+|anfang \w+|mitte \w+)\b/i;
const PERSON_TITLE = /\b(Frau|Herr|Hr\.|Fr\.)\s+([A-ZÄÖÜ][\wäöüß-]+)/g;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-–•*\s]+/, "").trim())
    .filter((s) => s.length >= 12);
}

function findName(sentence: string, names: string[]): string {
  const lower = sentence.toLowerCase();
  for (const n of names) {
    const first = n.split(/\s+/)[0]?.replace(/[()]/g, "") ?? "";
    if (first.length >= 3 && lower.includes(first.toLowerCase())) return n;
  }
  return "";
}

export class TestProvider implements AIProvider {
  info(): ProviderInfo {
    return { id: "test", model: "regelbasiert-v1", enabled: true, description: "Deterministischer Testanbieter – kein Sprachmodell, keine externe Verarbeitung. Nur für Entwicklung und Tests." };
  }

  async structureNote(input: StructureNoteInput): Promise<StructureNoteOutput> {
    const items: StructuredItem[] = [];
    const sentences = splitSentences(input.noteText);
    const seenPersons = new Set<string>();

    for (const s of sentences) {
      if (items.length >= 30) break;
      const owner = findName(s, input.participantNames);
      const known = findName(s, input.knownPersonNames);

      // Konflikt mit bestätigter Aussage: gleicher Gegenstand (erste zwei Wörter), abweichendes Datum
      const dateInSentence = s.match(DATE)?.[0];
      if (dateInSentence) {
        for (const a of input.confirmedAssertions) {
          const subject = a.split(/\s+/).slice(0, 2).join(" ");
          const dateInAssertion = a.match(DATE)?.[0];
          if (subject.length > 3 && s.toLowerCase().includes(subject.toLowerCase()) && dateInAssertion && dateInAssertion.toLowerCase() !== dateInSentence.toLowerCase()) {
            items.push({
              type: "KONFLIKT",
              title: `Widerspruch zu bestätigter Aussage: ${subject}`,
              observation: s,
              hypothesis: "",
              evidenceQuote: s,
              uncertainty: `Bestätigt ist: „${a}“. Die Notiz nennt ${dateInSentence}. Beide Angaben bleiben sichtbar, bis der Konflikt entschieden ist.`,
              whyNow: "Widersprüchliche Laufzeit-/Terminangaben beeinflussen Planung und Verlängerung.",
              nextStep: "Konflikt prüfen und mit Quelle entscheiden.",
              proposedQuestion: "",
              expectedResult: "Aussage mit Erkenntnisstatus „bestätigt“ oder „überholt“.",
              proposedOwnerName: owner,
              mentionedPersonName: "",
            });
          }
        }
      }

      if (s.includes("?")) {
        items.push({
          type: "OFFENE_FRAGE",
          title: s.length > 80 ? s.slice(0, 77) + "…" : s,
          observation: s,
          hypothesis: "",
          evidenceQuote: s,
          uncertainty: "Frage aus der Notiz; Entscheidungsauswirkung und mögliche Quelle sind zu ergänzen.",
          whyNow: "Offene Frage aus dem letzten Gespräch.",
          nextStep: "Klären, wer die Antwort kennt und über welchen Kontaktweg sie legitim erfragt werden kann.",
          proposedQuestion: s,
          expectedResult: "Antwort mit Quelle oder bewusste Zurückstellung.",
          proposedOwnerName: owner,
          mentionedPersonName: known,
        });
      } else if (DECISION.test(s)) {
        items.push({
          type: "ENTSCHEIDUNG",
          title: s.length > 80 ? s.slice(0, 77) + "…" : s,
          observation: s,
          hypothesis: "",
          evidenceQuote: s,
          uncertainty: "Bitte prüfen, ob dies eine gemeinsame Entscheidung der Teilnehmenden war.",
          whyNow: "",
          nextStep: "Als Entscheidung im Weekly festhalten.",
          proposedQuestion: "",
          expectedResult: "Dokumentierte Entscheidung mit Geltungsbereich.",
          proposedOwnerName: "",
          mentionedPersonName: known,
        });
      } else if (owner && ACTION_VERB.test(s)) {
        items.push({
          type: "AKTION",
          title: s.length > 80 ? s.slice(0, 77) + "…" : s,
          observation: s,
          hypothesis: "",
          evidenceQuote: s,
          uncertainty: "Idee oder vereinbarte Aufgabe? Erst die Annahme durch die verantwortliche Person macht daraus eine Aufgabe.",
          whyNow: "Im Gespräch genannter nächster Schritt.",
          nextStep: s,
          proposedQuestion: "",
          expectedResult: "Aktion mit Verantwortlichem und Ergebnis.",
          proposedOwnerName: owner,
          mentionedPersonName: known,
        });
      } else if (SPECULATION.test(s)) {
        items.push({
          type: "BEOBACHTUNG",
          title: s.length > 80 ? s.slice(0, 77) + "…" : s,
          observation: `Im Gespräch geäußert: „${s}“`,
          hypothesis: s,
          evidenceQuote: s,
          uncertainty: "Vermutung, kein bestätigter Sachverhalt. Kein Bedarf ableiten.",
          whyNow: "Neue Information mit möglicher Relevanz.",
          nextStep: "Als Hinweis erfassen und klären, ob und wie die Vermutung geprüft werden kann.",
          proposedQuestion: "",
          expectedResult: "Hinweis mit getrennter Beobachtung/Vermutung.",
          proposedOwnerName: owner,
          mentionedPersonName: known,
        });
      } else if (OBSERVATION_VERB.test(s)) {
        items.push({
          type: "BEOBACHTUNG",
          title: s.length > 80 ? s.slice(0, 77) + "…" : s,
          observation: s,
          hypothesis: "",
          evidenceQuote: s,
          uncertainty: "Aussage aus der Notiz; Richtigkeit nicht geprüft.",
          whyNow: "Neue Information aus dem Weekly.",
          nextStep: "Als Hinweis erfassen oder verwerfen.",
          proposedQuestion: "",
          expectedResult: "Hinweis (Status neu).",
          proposedOwnerName: "",
          mentionedPersonName: known,
        });
      }

      // Genannte Kundenpersonen (bekannt oder mit Anrede) – ohne Entscheidungsvollmacht abzuleiten
      const titled = [...s.matchAll(PERSON_TITLE)].map((m) => `${m[1]} ${m[2]}`);
      for (const name of [known, ...titled].filter(Boolean)) {
        const key = name.replace(/\(.*?\)/g, "").trim().toLowerCase(); // „Frau Keller (fiktiv)“ und „Frau Keller“ sind dieselbe Person
        if (seenPersons.has(key)) continue;
        seenPersons.add(key);
        items.push({
          type: "PERSON",
          title: `Person erwähnt: ${name}`,
          observation: s,
          hypothesis: "",
          evidenceQuote: s,
          uncertainty: input.knownPersonNames.some((k) => k.toLowerCase().startsWith(key.split(" ")[0] ?? key)) ? "Person ist bereits bekannt; Funktion/Zuständigkeit prüfen." : "Neue Person – Funktion und Zuständigkeit unbekannt. Aus dem Titel folgt keine Entscheidungsvollmacht.",
          whyNow: "",
          nextStep: "Funktion und Beziehungsstand dokumentieren, falls relevant.",
          proposedQuestion: "",
          expectedResult: "Person mit Funktion und Beziehungsstand.",
          proposedOwnerName: "",
          mentionedPersonName: name,
        });
      }
    }

    return items.length > 0 ? { items, noSuggestionReason: "" } : { items: [], noSuggestionReason: "Aus dieser Notiz lässt sich kein belastbarer zusätzlicher Vorschlag ableiten." };
  }
}
