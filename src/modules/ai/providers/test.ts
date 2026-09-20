import type { AIProvider, AnalyzeDocumentInput, AssistantInput, InterviewNextInput, ProviderInfo, StructureNoteInput } from "../provider";
import type { AssistantItem, IntakeProposal, InterviewNext, StructuredItem, StructureNoteOutput } from "../schemas";
import { ASSISTANT_CARDS_MARKER, interviewTopicValues } from "../schemas";

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
    .split(/(?<!\b(?:Dr|Prof|Hr|Fr|Nr|ca|bzw|z\.B)\.)(?<=[.!?])\s+|\n+/)
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

  /**
   * Dokument analysieren – regelbasiert, für Entwicklung und Tests: Organisation aus der ersten Zeile mit Rechtsform,
   * Personen aus „Herr/Frau Nachname“, Beobachtungen und mögliche Bedarfe aus Sätzen mit typischen Verben.
   * Jedes Element zitiert wörtlich aus dem Text.
   */
  async analyzeDocument(input: AnalyzeDocumentInput): Promise<IntakeProposal> {
    const text = input.documentText;
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const ORG = /\b([A-ZÄÖÜ][\wäöüß&.\- ]{1,60}?\s(GmbH & Co\. KG|GmbH|AG|SE|KG|e\.V\.|Stadt|Landkreis|Ministerium))\b/;
    let organization: IntakeProposal["organization"] = null;
    for (const l of lines) {
      const m = ORG.exec(l);
      if (m) {
        // Satzanfänge wie „Es geht um die …“ oder „Kunde ist die …“ vom Namen trennen: bis zum letzten Kleinwort abschneiden.
        const name = m[1]!.trim().replace(/^(?:[A-ZÄÖÜ][a-zäöüß]*\s+)?(?:[a-zäöüß][\wäöüß]*\s+)+/u, "").trim() || m[1]!.trim();
        const known = input.knownAccountNames.find((k) => name.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(name.toLowerCase())) ?? "";
        const orgType = /Stadt|Landkreis|Ministerium/.test(name) ? "OEFFENTLICH" : /AG|SE/.test(m[2] ?? "") ? "KONZERN" : "SONSTIGE";
        organization = { name, orgType, possibleExistingAccount: known, evidenceQuote: m[0] };
        break;
      }
    }
    const persons: IntakeProposal["persons"] = [];
    const byName = new Map<string, IntakeProposal["persons"][number]>();
    for (const m of text.matchAll(/\b(Frau|Herrn?|Hr\.|Fr\.)\s+((?:Dr\.\s+|Prof\.\s+)?[A-ZÄÖÜ][\wäöüß-]+(?:\s[A-ZÄÖÜ][\wäöüß-]+)?)(?:\s*[,(]\s*([^,.;()\n]{3,60}))?/g)) {
      const name = `${m[1] === "Herrn" ? "Herr" : m[1]} ${m[2]}`;
      const fn = (m[3] ?? "").trim();
      const existing = byName.get(name);
      if (existing && (existing.functionTitle || !fn)) continue;
      if (!existing && byName.size >= 30) continue;
      const decisionRole = /einkauf/i.test(fn) ? "EINKAUF_VERTRAGSWEG" : /leiter|leitung|head|cio|cto|cfo|geschäftsführ/i.test(fn) ? "BUDGETVERANTWORTUNG" : null;
      byName.set(name, { displayName: name, functionTitle: fn, email: "", knownResponsibility: "", decisionRole, stance: "UNBEKANNT", influence: decisionRole ? "HOCH" : "UNBEKANNT", assessmentNote: decisionRole ? `Aus der Funktion „${fn}“ abgeleitet.` : "", evidenceQuote: m[0] });
    }
    persons.push(...byName.values());
    const signals: IntakeProposal["signals"] = [];
    const needs: IntakeProposal["needs"] = [];
    for (const s of splitSentences(text)) {
      if (/\b(sucht|suchen|benötigt|benötigen|braucht|brauchen|plant|planen|will|wollen|möchte|möchten)\b/i.test(s) && needs.length < 15) {
        needs.push({ title: s.length > 80 ? s.slice(0, 77) + "…" : s, needDescription: s.length >= 10 ? s : s + " (aus Dokument)", evidenceQuote: s });
      } else if (OBSERVATION_VERB.test(s) && signals.length < 30) {
        signals.push({ observation: s, relevanceHypothesis: SPECULATION.test(s) ? "Im Dokument als Vermutung formuliert." : "", evidenceQuote: s });
      }
    }
    // Folgeaktivitäten aus Zusagen („schickt … bis“), Kontaktaufnahmen für Personen ohne Kontakt („noch kein Kontakt“)
    const actions: IntakeProposal["actions"] = [];
    for (const s of splitSentences(text)) {
      if (/\b(schickt|sendet|meldet sich|liefert|bereitet .* vor|klärt|prüft)\b/i.test(s) && actions.length < 15) {
        const due = s.match(/bis\s+(\d{1,2}\.\d{1,2}\.?(\d{2,4})?|Ende \w+|Mitte \w+|Anfang \w+)/i)?.[0] ?? "";
        actions.push({ title: s.length > 120 ? s.slice(0, 117) + "…" : s, description: "", ownerRole: /Kontakt|vorstell|Beziehung/i.test(s) ? "ANKER" : "BD", dueHint: due, evidenceQuote: s });
      }
    }
    const contacts: IntakeProposal["contacts"] = [];
    for (const s of splitSentences(text)) {
      const m = /\b(Frau|Herrn?|Hr\.|Fr\.)\s+((?:Dr\.\s+|Prof\.\s+)?[A-ZÄÖÜ][\wäöüß-]+)/.exec(s);
      if (m && /noch kein Kontakt|nicht bekannt|kennen wir nicht|kein direkter Kontakt/i.test(s) && contacts.length < 15) {
        const via = /über\s+([A-ZÄÖÜ][\wäöüß]+(?:\s[A-ZÄÖÜ][\wäöüß]+)?)/.exec(s)?.[1] ?? "";
        const anrede = m[1] === "Herrn" ? "Herr" : m[1];
        contacts.push({ personName: `${anrede} ${m[2]}`, viaVerveName: via, occasion: s, draftMessage: `Guten Tag ${anrede} ${m[2]}, wir sind über ${organization?.name ?? "Ihr Haus"} im Austausch und würden uns gern kurz vorstellen. Hätten Sie in den nächsten zwei Wochen 20 Minuten Zeit? (Entwurf)`, evidenceQuote: s });
      }
    }
    const artifacts: IntakeProposal["artifacts"] = organization ? [{ code: "A6", why: "Vor dem nächsten Gespräch die Gesprächsvorbereitung aus den erfassten Beobachtungen ableiten." }] : [];
    if (contacts.length > 0) artifacts.push({ code: "A5", why: "Für die vorgeschlagenen Kontaktaufnahmen einen Anbahnungsplan festhalten." });
    return {
      organization,
      setup: organization ? { name: `Erstkontakt ${organization.name}`.slice(0, 200), contextNote: `Angelegt aus Dokument „${input.fileName}“.` } : null,
      persons,
      signals,
      needs,
      actions,
      contacts,
      artifacts,
      openQuestions: organization ? [] : ["Welche Organisation ist gemeint? Im Dokument wurde keine Rechtsform gefunden."],
      summary: lines.slice(0, 3).join(" ").slice(0, 600),
      noProposalReason: organization ? "" : "Keine Organisation mit erkennbarer Rechtsform im Text gefunden.",
    };
  }

  /** Interview – regelbasiert: feste Reihenfolge der Themen, ein Nachhaken bei vagen Antworten, Abschluss auf „fertig“. */
  async interviewNext(input: InterviewNextInput): Promise<InterviewNext> {
    const QUESTIONS: Record<(typeof interviewTopicValues)[number], string> = {
      ORGANISATION: "Um welche Organisation geht es – bitte mit Rechtsform, und gehört sie zu einem Konzern?",
      ANLASS_KONTEXT: "Was ist der Anlass, dass ihr jetzt im Gespräch seid, und woran arbeitet der Kunde gerade?",
      PERSONEN_ROLLEN: "Mit wem hast du gesprochen – Name, Funktion und wofür die Person zuständig ist?",
      ENTSCHEIDUNGSWEG: "Wer entscheidet dort über eine Beauftragung, und wer bewertet fachlich oder muss freigeben?",
      BEDARF: "Was will der Kunde erreichen, in seinen Worten – und woran macht er fest, dass ihm etwas fehlt?",
      ZEIT_BUDGET: "Welche Termine wurden genannt, und wie ist der Stand beim Budget?",
      WETTBEWERB_BESTAND: "Wer arbeitet dort bisher, und welche Alternativen zu Verve sind im Spiel?",
      BEZIEHUNGEN_ZUGANG: "Wer bei Verve kennt jemanden dort, und zu wem besteht noch kein Kontakt?",
      NAECHSTE_SCHRITTE: "Was wurde konkret zugesagt oder vereinbart, und was ist noch zu klären?",
    };
    const last = input.transcript[input.transcript.length - 1];
    const topicOf = (q: string) => interviewTopicValues.find((k) => QUESTIONS[k] === q) ?? null;
    if (last?.role === "NUTZER" && /^(fertig|das war.?s|mehr weiß ich nicht|ende)\.?$/i.test(last.text.trim())) return { question: "", rationale: "", topic: null, covered: [...interviewTopicValues], done: true };
    // Abgedeckt = Themenfrage gestellt und beantwortet
    const covered: (typeof interviewTopicValues)[number][] = [];
    input.transcript.forEach((t, i) => {
      const k = t.role === "KI" ? topicOf(t.text) : null;
      if (k && input.transcript[i + 1]?.role === "NUTZER" && !covered.includes(k)) covered.push(k);
    });
    const alreadyProbed = input.transcript.some((t) => t.role === "KI" && t.text.startsWith("Du sagtest"));
    if (last?.role === "NUTZER" && !alreadyProbed && /\b(bald|irgendwann|irgendwer|weiß nicht genau|keine ahnung)\b/i.test(last.text)) {
      const prevQ = input.transcript[input.transcript.length - 2];
      return { question: `Du sagtest „${last.text.slice(0, 60)}“ – woran machst du das fest, oder gibt es eine konkretere Angabe?`, rationale: "Nachfrage bei vager Antwort.", topic: prevQ?.role === "KI" ? topicOf(prevQ.text) : null, covered, done: false };
    }
    const known = input.knownContext.toLowerCase();
    const next = interviewTopicValues.find((k) => !covered.includes(k) && !(k === "ORGANISATION" && known.includes("kunde:")));
    if (!next || input.questionCount >= input.maxQuestions) return { question: "", rationale: "", topic: null, covered, done: true };
    return { question: QUESTIONS[next], rationale: `Thema „${next}“ ist noch offen.`, topic: next, covered, done: false };
  }

  /** Assistent – regelbasiert: Karten aus der letzten Nutzernachricht (über analyzeDocument), fehlende Themen als Fragen. */
  async assistantReply(input: AssistantInput, _opts?: unknown, onDelta?: (chunk: string) => void): Promise<string> {
    void _opts;
    const lastUser = [...input.history].reverse().find((h) => h.role === "NUTZER")?.text ?? "";
    const allUser = input.history.filter((h) => h.role === "NUTZER").map((h) => h.text).join("\n");
    const p = await this.analyzeDocument({ documentText: lastUser || allUser, fileName: "Dialog", knownAccountNames: [] });
    const items: AssistantItem[] = [];
    const hasCustomer = /Kunde:/.test(input.contextText);
    if (p.organization && !hasCustomer) items.push({ type: "KUNDE", name: p.organization.name, orgType: p.organization.orgType, setupName: `Erstkontakt ${p.organization.name}`.slice(0, 200), contextNote: "", evidenceQuote: p.organization.evidenceQuote });
    for (const x of p.persons) items.push({ type: "PERSON", ...x });
    for (const x of p.signals) items.push({ type: "SIGNAL", ...x });
    for (const x of p.needs) items.push({ type: "BEDARF", ...x });
    for (const x of p.actions) items.push({ type: "AKTION", ...x });
    for (const x of p.contacts) items.push({ type: "KONTAKT", ...x });
    const missing: string[] = [];
    if (!hasCustomer && !p.organization) missing.push("Um welche Organisation geht es (mit Rechtsform)?");
    if (p.persons.length === 0 && !/Bekannte Personen:/.test(input.contextText)) missing.push("Mit wem hast du gesprochen – Name und Funktion?");
    if (p.needs.length === 0 && !/Bedarfe:/.test(input.contextText)) missing.push("Was will der Kunde erreichen, in seinen Worten?");
    const prosa = items.length > 0
      ? `Danke, ich habe ${items.length} ${items.length === 1 ? "Vorschlag" : "Vorschläge"} daraus abgeleitet – bitte prüfen und übernehmen, was passt.${missing.length ? ` Damit ich weiter vorschlagen kann, fehlt mir noch etwas: ${missing[0]}` : ""}`
      : `Daraus kann ich noch nichts Belastbares vorschlagen. ${missing[0] ?? "Erzähl mir mehr über den Anlass und die beteiligten Personen."}`;
    const out = `${prosa}\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ items: items.slice(0, 20), missing })}`;
    onDelta?.(out);
    return out;
  }
}
