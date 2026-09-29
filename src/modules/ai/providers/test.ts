import { looksLikeHowTo } from "@/modules/help/knowledge";
import { extractAccountPage } from "@/modules/assistant/accountPage";
import { decisionRoleLabel } from "@/lib/labels";
import type { TaskOptions } from "../provider";
import type { AIProvider, AnalyzeDocumentInput, AssistantInput, BuyingCenterAdviceInput, FormSuggestInput, InterviewNextInput, ProviderInfo, StrategyInput, StructureNoteInput } from "../provider";
import type { AssistantItem, BuyingCenterProposal, FormSuggestion, IntakeProposal, InterviewNext, StrategyProposal, StructuredItem, StructureNoteOutput } from "../schemas";
import { ruleBasedStepDrafts, type StepDrafts } from "@/modules/playbooks/drafts";
import type { PlaybookStepDraftInput } from "../provider";
import { ASSISTANT_CARDS_MARKER, decisionRoleValues, interviewTopicValues } from "../schemas";

/**
 * Deterministischer Testanbieter (Briefing 2.3): regelbasiert, ohne Netzwerk, ohne Modell.
 * Er dient der Entwicklung des Vorschlagslebenszyklus und der Evaluationsfälle. Er erfindet nichts:
 * Jeder Vorschlag zitiert wörtlich einen Satz der Notiz (evidenceQuote) und ordnet nur bekannte Namen zu.
 * Aufforderungen im Text („ignoriere …“, „markiere als bestätigt“) sind für ihn gewöhnliche Sätze – er führt nichts aus.
 */

/** Hinweise auf zusätzliche Rollen/Kapazität (Freelancer-Hebel, Etappe 21) */
const FREELANCER_HINT = /weitere(n)? (profile|rollen|spezialist|kapazit|unterstützung)|zusätzliche(n|r)? (profile|rollen|kapazit|unterstützung|ressourcen|aufwand)|skill-paket|engpass|unterbesetzt|fehlende(n)? kapazit|externe(r|n)? unterstützung|vendor|lieferantenlist/i;

/** Standardrolle im Satz erkennen (Verve-Katalog, grob). */
function detectRole(s: string): string | null {
  const R: [RegExp, string][] = [
    [/testkoordinat|testmanag/i, "Test Management"],
    [/testanaly/i, "Test Analyse"],
    [/\bQA\b|qualitätssich|abnahme/i, "QA"],
    [/projektleit/i, "Projektleitung"],
    [/programmleit/i, "Programmleitung"],
    [/\bPMO\b/i, "PMO"],
    [/delivery manag/i, "Delivery Manager"],
    [/scrum master/i, "Scrum Master"],
    [/agile coach/i, "Agile Coach"],
    [/release train|\bRTE\b/i, "Release Train Engineer (RTE)"],
    [/business analy/i, "Business Analyst"],
    [/requirements|anforderungsanaly/i, "Requirements Engineer"],
    [/fachkonzept/i, "Fachkonzeption"],
    [/prozessberat/i, "Prozessberatung"],
    [/solution archit/i, "Solution Architect"],
    [/enterprise archit/i, "Enterprise Architect"],
    [/cloud|sap|integrationsarchit/i, "Cloud-, SAP- und Integrationsarchitektur"],
    [/\bAPI\b|schnittstellen/i, "API- und Schnittstellendesign"],
    [/security/i, "Security-by-Design / Zielarchitektur"],
  ];
  for (const [re, name] of R) if (re.test(s)) return name;
  return null;
}

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

  async structureNote(input: StructureNoteInput, opts?: TaskOptions): Promise<StructureNoteOutput> {
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

      // Strategischer Fokus „Freelancer-Hebel“ (Etappe 21): Hinweise auf zusätzliche Rollen/Kapazität als eigene Beobachtung
      if (opts?.focus?.freelancerLever && FREELANCER_HINT.test(s) && items.length < 30) {
        items.push({
          type: "BEOBACHTUNG",
          title: `Freelancer-Potenzial: ${s.length > 60 ? s.slice(0, 57) + "…" : s}`,
          observation: s,
          hypothesis: "Möglicher Bedarf an zusätzlichen Profilen – prüfen, ob Verve (auch über Freelancer) weitere Rollen besetzen kann.",
          evidenceQuote: s,
          uncertainty: "Vermutung aus dem Fokus „Freelancer-Hebel“; kein bestätigter Bedarf.",
          whyNow: "Strategischer Fokus: Wachstum über Freelancer.",
          nextStep: "Im nächsten Gespräch fragen, welche weiteren Rollen im Team fehlen.",
          proposedQuestion: "Welche weiteren Rollen fehlen im Team?",
          expectedResult: "Beobachtung mit Einschätzung; bei Bestätigung Chance der Art Freelancer-Experte.",
          proposedOwnerName: owner,
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
        const role = detectRole(s);
        const kind = /ausschreib|rahmenvertrag|vergabe/i.test(s) ? "AUSSCHREIBUNG" : /freelanc|freiberufl|spezialist/i.test(s) ? "FREELANCER_EXPERTE" : "VERVE_EXPERTE";
        const horizon = s.match(/\b(Q[1-4]\s?\d{4}|(?:Anfang|Mitte|Ende)\s+\d{4}|\d{4})\b/)?.[0] ?? "";
        needs.push({ title: (role ? `${role}: ${s}` : s).length > 80 ? (role ? `${role}: ${s}` : s).slice(0, 77) + "…" : role ? `${role}: ${s}` : s, needDescription: s.length >= 10 ? s : s + " (aus Dokument)", kind, roleName: role ?? "", horizon, evidenceQuote: s });
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
  /** Strategiefaden aus der Lageanalyse: Züge aus Blockern/Lücken/Zügen der Analyse, jeweils mit der Zeile als Textstelle. */
  async strategize(input: StrategyInput): Promise<StrategyProposal> {
    const lines = input.analysisText.split("\n").map((l) => l.trim()).filter(Boolean);
    const pick = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
    const stage = pick("Stufe:");
    const nextStep = stage.includes("Nächster großer Schritt:") ? stage.split("Nächster großer Schritt:")[1]!.trim() : "Nächsten Schritt festlegen.";
    const split = (v: string) => (v ? v.split(" | ").map((x) => x.trim()).filter(Boolean) : []);
    const blockers = split(pick("Blocker:"));
    const missing = split(pick("Fehlt:"));
    const moves = split(pick("Naheliegende Züge:"));
    const quoteFor = (frag: string) => (lines.find((l) => l.includes(frag)) ?? frag).slice(0, 380);
    const out: StrategyProposal = {
      summary: `Belegt: ${stage.split(".")[0] || "Lage unklar"}. ${blockers.length ? `${blockers.length} dokumentierte Blocker.` : "Keine dokumentierten Blocker."} ${missing.length ? `Es fehlen ${missing.length} Grundlagen.` : "Grundlagen vollständig."}`,
      nextStep,
      moves: [
        ...moves.slice(0, 2).map((m) => ({ title: m.replace(/\.$/, ""), why: "Bereits im Tool vorbereitet – geringster Aufwand.", ownerRole: "BD" as const, evidenceQuote: quoteFor(m) })),
        ...blockers.slice(0, 2).map((b) => ({ title: `Blocker lösen: ${b.split(" – ")[0]!.replace(/\.$/, "").slice(0, 120)}`, why: "Blockiert den nächsten großen Schritt.", ownerRole: "BD" as const, evidenceQuote: quoteFor(b) })),
        ...missing.slice(0, 1).map((m) => ({ title: `Lücke schließen: ${m.replace(/\.$/, "").slice(0, 120)}`, why: "Ohne diese Grundlage bleibt der Schritt Hypothese.", ownerRole: (/Anker|Kontext/i.test(m) ? "ANKER" : "BD") as "ANKER" | "BD", evidenceQuote: quoteFor(m) })),
      ].slice(0, 5),
      risks: blockers.filter((b) => /Tagen|überfällig|Blockiert/i.test(b)).slice(0, 2).map((b) => ({ text: `Vermutlich: Stillstand – ${b.replace(/\.$/, "")}.`, evidenceQuote: quoteFor(b) })),
      openQuestions: missing.filter((m) => m.endsWith("?")).slice(0, 3),
    };
    return out;
  }

  /** Chancen-Berater aus der Lageanalyse genau einer Chance: gleiche Textform wie der Strategiefaden, andere Zeilenpräfixe. */
  async adviseOpportunity(input: StrategyInput): Promise<StrategyProposal> {
    const lines = input.analysisText.split("\n").map((l) => l.trim()).filter(Boolean);
    const pick = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
    const chanceLine = pick("Chance:");
    const nextStep = pick("Nächster Schritt:") || "Nächsten Schritt zu dieser Chance festlegen.";
    const split = (v: string) => (v ? v.split(" | ").map((x) => x.trim()).filter(Boolean) : []);
    const blockers = split(pick("Blocker:"));
    const missing = split(pick("Fehlt:"));
    const moves = split(pick("Naheliegende Züge:"));
    const quoteFor = (frag: string) => (lines.find((l) => l.includes(frag)) ?? frag).slice(0, 380);
    const out: StrategyProposal = {
      summary: `Belegt: ${chanceLine || "Chance"}. ${blockers.length ? `${blockers.length} dokumentierte(r) Blocker.` : "Keine dokumentierten Blocker."} ${missing.length ? `Es fehlen ${missing.length} Grundlagen.` : "Grundlagen vollständig."}`,
      nextStep,
      moves: [
        ...moves.slice(0, 2).map((m) => ({ title: m.replace(/\.$/, ""), why: "Bereits im Tool vorbereitet – geringster Aufwand.", ownerRole: "BD" as const, evidenceQuote: quoteFor(m) })),
        ...blockers.slice(0, 2).map((b) => ({ title: `Blocker lösen: ${b.split(" – ")[0]!.replace(/\.$/, "").slice(0, 120)}`, why: "Blockiert die Konvertierung dieser Chance.", ownerRole: "BD" as const, evidenceQuote: quoteFor(b) })),
        ...missing.slice(0, 1).map((m) => ({ title: `Lücke schließen: ${m.replace(/\.$/, "").slice(0, 120)}`, why: "Ohne diese Grundlage bleibt der nächste Schritt Hypothese.", ownerRole: (/Anker|Kontext/i.test(m) ? "ANKER" : "BD") as "ANKER" | "BD", evidenceQuote: quoteFor(m) })),
      ].slice(0, 5),
      risks: blockers.filter((b) => /Tagen|überfällig|unvollständig/i.test(b)).slice(0, 2).map((b) => ({ text: `Vermutlich: Stillstand – ${b.replace(/\.$/, "")}.`, evidenceQuote: quoteFor(b) })),
      openQuestions: missing.filter((m) => m.endsWith("?")).slice(0, 3),
    };
    return out;
  }

  /** Buying-Center-Berater: aus dem Buyingcenter-Stand (Zeilen „Rolle: offen/Hypothese/bestätigt – Personen“) je offener/Hypothese-Rolle einen Hinweis. */
  async adviseBuyingCenter(input: BuyingCenterAdviceInput): Promise<BuyingCenterProposal> {
    const lines = input.analysisText.split("\n").map((l) => l.trim()).filter(Boolean);
    const HINT: Record<string, string> = {
      BEDARFSTRAEGER: "Im nächsten Gespräch klären, wer den Bedarf tatsächlich formuliert hat.",
      FACHLICHE_BEWERTUNG: "Klären, wer die fachliche Eignung bewertet.",
      BUDGETVERANTWORTUNG: "Gezielt fragen, wer die Budgetentscheidung tatsächlich trifft.",
      EINKAUF_VERTRAGSWEG: "Den Einkaufs-/Vertragsweg erfragen.",
      ZUSAETZLICHE_FREIGABE: "Prüfen, ob eine zusätzliche Freigabe nötig ist.",
      UNTERSTUETZER_SPONSOR: "Einen internen Unterstützer identifizieren.",
    };
    const roles: BuyingCenterProposal["roles"] = [];
    let gapCount = 0;
    for (const role of decisionRoleValues) {
      const label = decisionRoleLabel[role] ?? role;
      const line = lines.find((l) => l.startsWith(`${label}:`));
      if (!line) continue;
      const rest = line.slice(label.length + 1).trim();
      if (rest.startsWith("bestätigt")) continue;
      gapCount++;
      const isHypothese = rest.startsWith("Hypothese");
      const personMatch = rest.match(/–\s*([^(]+)\s*\(/);
      roles.push({
        role,
        hint: isHypothese ? `Nur Hypothese – mit Quelle bestätigen. ${HINT[role] ?? ""}`.trim() : (HINT[role] ?? "Lücke schließen."),
        proposedPersonName: isHypothese && personMatch ? personMatch[1]!.trim() : "",
        evidenceQuote: isHypothese ? line : "",
      });
    }
    return {
      summary: `Belegt: ${gapCount === 0 ? "Alle sechs Rollen bestätigt." : `${gapCount} von 6 Rollen offen oder nur Hypothese.`}`,
      roles,
      openQuestions: roles.filter((r) => !r.evidenceQuote).slice(0, 5).map((r) => `Wer übernimmt bei diesem Kunden die Rolle „${decisionRoleLabel[r.role] ?? r.role}“?`),
    };
  }

  /** Formularvorschlag: nimmt Titel/Kontext aus Kontextzeilen, wählt Optionen regelbasiert. */
  /** Schritt-Assistent: derselbe regelbasierte Entwurf wie ohne KI – deterministisch, erfindet nichts. */
  async draftPlaybookStep(input: PlaybookStepDraftInput): Promise<StepDrafts> {
    return ruleBasedStepDrafts(input.structured);
  }

  async suggestForm(input: FormSuggestInput): Promise<FormSuggestion> {
    const ctx = input.contextText;
    const line = (prefix: string) => ctx.split("\n").find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
    const kunde = line("Kunde:").split(" (")[0] ?? "";
    const setup = line("Setup:");
    const bedarfe = line("Chancen:");
    const beobachtungen = line("Letzte Beobachtungen:");
    const fields: Record<string, string> = {};
    const missing: string[] = [];
    let evidence = "";
    const has = (n: string) => input.fields.some((f) => f.name === n);
    const firstOption = (n: string, prefer: string[]) => {
      const f = input.fields.find((x) => x.name === n);
      if (!f?.options) return undefined;
      return prefer.find((p) => f.options!.includes(p)) ?? f.options[0];
    };
    if (input.kind === "VORHABEN") {
      const stage = input.analysisText.split("\n").find((l) => l.startsWith("Stufe:")) ?? "";
      const running = /gestartet|Beauftragt/i.test(stage);
      if (has("title")) fields.title = running ? `Einsatz bei ${kunde || "dem Kunden"} verlängern und ausweiten` : bedarfe ? `Bedarf „${bedarfe.split(" [")[0]}“ zur Beauftragung führen` : `Ersten Bedarf bei ${kunde || "dem Kunden"} erschließen`;
      if (has("kind")) fields.kind = firstOption("kind", running ? ["VERLAENGERN", "AUSWEITEN"] : ["VERTIEFEN", "AUSWEITEN"]) ?? "";
      if (has("rationale")) fields.rationale = stage ? `Belegt: ${stage.replace(/^Stufe:\s*/, "")}` : "Aus der Lage abgeleitet.";
      evidence = stage || bedarfe || kunde;
      if (!bedarfe) missing.push("Welchen Bedarf soll das Vorhaben adressieren?");
    } else if (input.kind === "SETUP") {
      if (has("name")) fields.name = bedarfe ? `Team ${bedarfe.split(" [")[0]!.split(" ").slice(0, 3).join(" ")}` : `Erstkontakt ${kunde || "Kunde"}`;
      if (has("contextNote")) fields.contextNote = beobachtungen ? beobachtungen.split(" | ")[0]! : setup ? setup.split(" – ").slice(1).join(" – ") : "";
      if (has("visibility")) fields.visibility = firstOption("visibility", ["ACCOUNT_TEAM"]) ?? "";
      evidence = beobachtungen.split(" | ")[0] || bedarfe || kunde;
      if (!beobachtungen && !setup) missing.push("Was läuft beim Kunden – ein Satz Kontext?");
    } else if (input.kind === "CHANCE") {
      const obs = beobachtungen.split(" | ")[0] ?? "";
      const role = detectRole(obs) ?? detectRole(ctx);
      if (has("title")) fields.title = role ? `${role} für ${kunde || "den Kunden"}` : obs ? obs.split(/[,.;]/)[0]!.slice(0, 80) : `Unterstützung für ${kunde || "den Kunden"}`;
      if (has("needDescription")) fields.needDescription = obs || "";
      if (has("trigger")) fields.trigger = obs ? "Aus Beobachtung im Setup." : "";
      if (has("kind")) fields.kind = firstOption("kind", [/ausschreib/i.test(ctx) ? "AUSSCHREIBUNG" : "VERVE_EXPERTE"]) ?? "";
      if (has("roleName") && role) fields.roleName = role;
      evidence = obs || kunde;
      if (!obs) missing.push("Woran macht der Kunde fest, dass ihm etwas fehlt?");
    } else {
      // MEDDPICC (Etappe 17): aus Bedarfsbeschreibung/Anlass und dem Buyingcenter-Stand dieser Chance.
      const lines = input.analysisText.split("\n").map((l) => l.trim()).filter(Boolean);
      const pick = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
      const anlass = pick("Anlass:");
      const bedarf = pick("Bedarfsbeschreibung:");
      const budget = lines.find((l) => l.startsWith(`${decisionRoleLabel.BUDGETVERANTWORTUNG}:`)) ?? "";
      const champion = lines.find((l) => l.startsWith(`${decisionRoleLabel.UNTERSTUETZER_SPONSOR}:`)) ?? "";
      const nameFrom = (line: string) => line.match(/–\s*([^(]+)\s*\(/)?.[1]?.trim() ?? "";
      if (has("identifyPain") && (anlass || bedarf)) fields.identifyPain = anlass || bedarf;
      if (has("economicBuyer") && nameFrom(budget)) fields.economicBuyer = nameFrom(budget);
      if (has("champion") && nameFrom(champion)) fields.champion = nameFrom(champion);
      evidence = anlass || bedarf || budget || champion;
      if (!anlass && !bedarf) missing.push("Was ist der konkrete Anlass (Identify Pain)?");
      if (!nameFrom(budget)) missing.push("Wer entscheidet über das Budget (Economic Buyer)?");
    }
    return { fields, rationale: Object.keys(fields).length ? "Aus dem bekannten Kontext abgeleitet – bitte prüfen und anpassen." : "Zu wenig Kontext für einen Vorschlag.", evidenceQuote: evidence || "Kunde", missing };
  }

  async assistantCards(input: AssistantInput & { prose: string }): Promise<unknown> {
    const full = await this.assistantReply(input);
    const idx = full.indexOf(ASSISTANT_CARDS_MARKER);
    return idx >= 0 ? JSON.parse(full.slice(idx + ASSISTANT_CARDS_MARKER.length).trim()) : { items: [], missing: [] };
  }

  async assistantReply(input: AssistantInput, _opts?: unknown, onDelta?: (chunk: string) => void): Promise<string> {
    void _opts;
    const lastUser = [...input.history].reverse().find((h) => h.role === "NUTZER")?.text ?? "";
    // Bedienfrage (Etappe 25): deterministisch aus dem ersten passenden Hilfe-Abschnitt antworten, keine Karten
    const helpBlock = input.helpText?.split("Passende Abschnitte zur Frage:")[1]?.split("\nDeine Einstellungen")[0] ?? "";
    const firstSection = helpBlock.split(/\n(?=## )/).map((x) => x.trim()).find((x) => x.startsWith("## "));
    if (firstSection && looksLikeHowTo(lastUser)) {
      const [titleLine, whereLine, ...body] = firstSection.split("\n");
      const out = `Laut Hilfe („${titleLine!.slice(3)}“) – ${whereLine}. ${body.join(" ").slice(0, 700)}\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ items: [], missing: [] })}`;
      onDelta?.(out);
      return out;
    }
    // Eingefügte Account-Seite (Etappe 26): Kundenagenda, Stakeholder, Beschaffung, Einsatzende, Hebel, Team, SOS
    const page = extractAccountPage(lastUser, { hasCustomer: /Kunde:/.test(input.contextText) });
    if (page.recognized) {
      const count = (t: string) => page.items.filter((i) => i.type === t).length;
      const parts = [count("INITIATIVE") && `${count("INITIATIVE")}× Kundenagenda`, count("PERSON") && `${count("PERSON")}× Person`, count("BESCHAFFUNG") && "Beschaffungsweg", count("EINSATZ") && "laufender Einsatz", count("HEBEL") && `${count("HEBEL")}× Hebel`, count("RISIKO") && `${count("RISIKO")}× Risiko`, count("SOS") && `${count("SOS")}× SOS`, count("TEAM") && "Verve-Team"].filter(Boolean).join(", ");
      const prosa = `Ich habe die Account-Seite ausgewertet und ${page.items.length} Vorschläge abgeleitet (${parts}). Umsatzschätzungen und leere Vorlagenfelder übernehme ich bewusst nicht.${page.missing.length ? ` Offen: ${page.missing[0]}` : ""}`;
      const out = `${prosa}\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ items: page.items, missing: page.missing })}`;
      onDelta?.(out);
      return out;
    }
    const allUser = input.history.filter((h) => h.role === "NUTZER").map((h) => h.text).join("\n");
    const p = await this.analyzeDocument({ documentText: lastUser || allUser, fileName: "Dialog", knownAccountNames: [] });
    const items: AssistantItem[] = [];
    const hasCustomer = /Kunde:/.test(input.contextText);
    if (p.organization && !hasCustomer) items.push({ type: "KUNDE", name: p.organization.name, orgType: p.organization.orgType, setupName: `Erstkontakt ${p.organization.name}`.slice(0, 200), contextNote: "", evidenceQuote: p.organization.evidenceQuote });
    for (const x of p.persons) items.push({ type: "PERSON", phone: "", ...x });
    // Wofür: bestehende Chancen aus dem Kontext oder die hier vorgeschlagene(n) Chance(n)
    const known = (input.contextText.split("\n").find((l) => l.startsWith("Chancen:")) ?? "").slice("Chancen:".length).split(";").map((x) => x.split(" [")[0]!.trim()).filter(Boolean);
    const purposeFor = (text: string) => p.needs.find((n) => text.includes(n.evidenceQuote) || n.evidenceQuote.includes(text))?.title ?? known.find((k) => text.toLowerCase().includes(k.toLowerCase().split(" ")[0] ?? "\u0000")) ?? p.needs[0]?.title ?? known[0] ?? "";
    for (const x of p.signals) items.push({ type: "SIGNAL", ...x, purpose: purposeFor(x.observation) });
    for (const x of p.needs) items.push({ type: "CHANCE", title: x.title, needDescription: x.needDescription, kind: x.kind, roleName: x.roleName, headcount: null, horizon: x.horizon, anticipated: !/bestätigt|beauftragt|Anfrage/i.test(x.needDescription), evidenceQuote: x.evidenceQuote });
    for (const x of p.actions) items.push({ type: "AKTION", ...x, purpose: purposeFor(x.title) });
    for (const x of p.contacts) items.push({ type: "KONTAKT", ...x, purpose: purposeFor(x.occasion) });
    const missing: string[] = [];
    if (!hasCustomer && !p.organization) missing.push("Um welche Organisation geht es (mit Rechtsform)?");
    if (p.persons.length === 0 && !/Bekannte Personen:/.test(input.contextText)) missing.push("Mit wem hast du gesprochen – Name und Funktion?");
    if (p.needs.length === 0 && !/Chancen:/.test(input.contextText)) missing.push("Worauf läuft das hinaus – welche Rolle (Verve-Experte, Freelancer) oder Ausschreibung könnte daraus werden?");
    const prosa = items.length > 0
      ? `Danke, ich habe ${items.length} ${items.length === 1 ? "Vorschlag" : "Vorschläge"} daraus abgeleitet – bitte prüfen und übernehmen, was passt.${missing.length ? ` Damit ich weiter vorschlagen kann, fehlt mir noch etwas: ${missing[0]}` : ""}`
      : `Daraus kann ich noch nichts Belastbares vorschlagen. ${missing[0] ?? "Erzähl mir mehr über den Anlass und die beteiligten Personen."}`;
    const out = `${prosa}\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ items: items.slice(0, 20), missing })}`;
    onDelta?.(out);
    return out;
  }
}
