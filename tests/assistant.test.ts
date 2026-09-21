import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { resetConfigCacheForTests } from "@/lib/config";
import { archiveThread, decideCard, getThreadView, sendMessage, setInterviewMode, splitReply } from "@/modules/assistant/service";
import { TestProvider } from "@/modules/ai/providers/test";
import { ASSISTANT_CARDS_MARKER, type AssistantCard } from "@/modules/ai/schemas";
import type { AIProvider, AssistantInput } from "@/modules/ai/provider";
import { listMySuggestions } from "@/modules/suggestions/service";
import { actorFor, ensureSeed } from "./helpers";

process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "verve-uploads-"));

function cardsOf(view: Awaited<ReturnType<typeof getThreadView>>): AssistantCard[] {
  return view.messages.flatMap((m) => m.cards);
}

describe("Etappe 8: Assistent (Dialog mit Vorschlagskarten)", () => {
  it("Gespräche sind je Kontext und Nutzer getrennt; Eröffnung nennt offene Punkte und fehlende Informationen", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const david = await actorFor("david");
    const lars = await actorFor("lars");

    const global = await getThreadView(david, { type: "GLOBAL" });
    expect(global.thread.contextType).toBe("GLOBAL");
    expect(global.context.label).toBe("Allgemein");
    expect(global.missing.some((m) => /Organisation|Kunde/i.test(m))).toBe(true);
    // Zweiter Aufruf liefert dasselbe Gespräch
    const again = await getThreadView(david, { type: "GLOBAL" });
    expect(again.thread.id).toBe(global.thread.id);

    const setupView = await getThreadView(david, { type: "SETUP", id: seed.setupId });
    expect(setupView.thread.id).not.toBe(global.thread.id);
    expect(setupView.context.canWrite).toBe(true);
    expect(setupView.openPoints.length).toBeGreaterThan(0);

    // Fremder BD sieht das Setup nicht – der Assistent fällt auf „Allgemein“ zurück statt etwas preiszugeben
    const larsView = await getThreadView(lars, { type: "SETUP", id: seed.setupId });
    expect(larsView.thread.contextType).toBe("GLOBAL");
    expect(larsView.context.label).toBe("Allgemein");
    // Anderer Nutzer bekommt am selben Kontext ein eigenes Gespräch
    const petra = await actorFor("petra");
    const petraView = await getThreadView(petra, { type: "SETUP", id: seed.setupId });
    expect(petraView.thread.id).not.toBe(setupView.thread.id);
  });

  it("Neuer Kunde im allgemeinen Kontext: Karte KUNDE übernehmen legt Kunde+Setup an und bindet das Gespräch um; danach Personen und Bedarfe", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    await ensureSeed();
    const david = await actorFor("david");
    const view = await archiveThread(david, (await getThreadView(david, { type: "GLOBAL" })).thread.id).then(() => getThreadView(david, { type: "GLOBAL" }));
    const chunks: string[] = [];
    const r1 = await sendMessage(david, { threadId: view.thread.id, text: "Es geht um die Nordlicht Logistik GmbH, ein mittelständischer Logistiker. Gesprochen habe ich mit Herrn Berger, Leiter IT, zuständig für die Systemlandschaft. Herr Berger sucht Unterstützung bei der Testkoordination." }, { onDelta: (c) => chunks.push(c) });
    expect(chunks.join("")).not.toContain(ASSISTANT_CARDS_MARKER); // Marker wird nie gestreamt
    expect(r1.message.role).toBe("ASSISTENT");
    const kunde = r1.cards.find((c) => c.item.type === "KUNDE");
    expect(kunde).toBeDefined();
    expect(r1.cards.some((c) => c.item.type === "PERSON")).toBe(true);

    // Person vor dem Kunden geht nicht – verständliche Meldung
    const person = r1.cards.find((c) => c.item.type === "PERSON")!;
    await expect(decideCard(david, { threadId: view.thread.id, messageId: r1.message.id, cardId: person.id, decision: "UEBERNEHMEN" })).rejects.toBeInstanceOf(ValidationError);

    const k = await decideCard(david, { threadId: view.thread.id, messageId: r1.message.id, cardId: kunde!.id, decision: "UEBERNEHMEN" });
    expect(k.card.status).toBe("UEBERNOMMEN");
    expect(k.thread.contextType).toBe("SETUP");
    const setupId = k.thread.contextId!;
    const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.name, "Nordlicht Logistik GmbH") });
    expect(account).toBeDefined();
    // Doppelte Entscheidung ist nicht möglich
    await expect(decideCard(david, { threadId: view.thread.id, messageId: r1.message.id, cardId: kunde!.id, decision: "UEBERNEHMEN" })).rejects.toBeInstanceOf(TransitionError);

    // Jetzt Person und Bedarf übernehmen
    const p = await decideCard(david, { threadId: view.thread.id, messageId: r1.message.id, cardId: person.id, decision: "UEBERNEHMEN" });
    expect(p.card.resultType).toBe("PERSON");
    const persons = await db.query.persons.findMany({ where: eq(schema.persons.accountId, account!.id) });
    expect(persons.map((x) => x.displayName)).toContain("Herr Berger");
    const bedarf = r1.cards.find((c) => c.item.type === "CHANCE");
    if (bedarf) {
      const b = await decideCard(david, { threadId: view.thread.id, messageId: r1.message.id, cardId: bedarf.id, decision: "UEBERNEHMEN" });
      expect(b.card.resultType).toBe("OPPORTUNITY");
      const opps = await db.query.opportunities.findMany({ where: eq(schema.opportunities.setupId, setupId) });
      expect(opps.length).toBeGreaterThan(0);
    }
    // Verwerfen einer Karte
    const rest = r1.cards.find((c) => c.status === "NEU" && !["KUNDE", "PERSON", "CHANCE"].includes(c.item.type) || (c.item.type === "PERSON" && c.id !== person.id));
    if (rest) {
      const v = await decideCard(david, { threadId: view.thread.id, messageId: r1.message.id, cardId: rest.id, decision: "VERWERFEN" });
      expect(v.card.status).toBe("VERWORFEN");
    }
    // Quelle „Assistent-Dialog“ hängt am Setup
    const sources = await db.query.sources.findMany({ where: eq(schema.sources.setupId, setupId) });
    expect(sources.some((s) => s.type === "INTERVIEW" && /Assistent/.test(s.title))).toBe(true);

    // Im Setup-Kontext: Aktion und Kontaktaufnahme landen als Vorschläge in „Meine Arbeit“
    const r2 = await sendMessage(david, { threadId: view.thread.id, text: "Herr Berger schickt bis 30.09. das Grobkonzept. Zu Herrn Dr. Kaya, CIO, besteht noch kein Kontakt; Herr Berger könnte den Kontakt herstellen." });
    const aktion = r2.cards.find((c) => c.item.type === "AKTION");
    const kontakt = r2.cards.find((c) => c.item.type === "KONTAKT");
    expect(aktion ?? kontakt).toBeDefined();
    for (const c of [aktion, kontakt].filter(Boolean) as AssistantCard[]) {
      const d = await decideCard(david, { threadId: view.thread.id, messageId: r2.message.id, cardId: c.id, decision: "UEBERNEHMEN" });
      expect(d.card.resultType).toBe("SUGGESTION");
    }
    const mine = await listMySuggestions(david);
    expect(mine.some((s) => s.setupId === setupId)).toBe(true);
    const after = await getThreadView(david, { type: "SETUP", id: setupId });
    expect(cardsOf(after).filter((c) => c.status === "UEBERNOMMEN").length).toBeGreaterThanOrEqual(3);
  });

  it("Belegpflicht: Karten ohne Textstelle werden verworfen; nicht schemakonforme Antworten führen zu einer Notiz statt zu Karten", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const david = await actorFor("david");
    const view = await getThreadView(david, { type: "SETUP", id: seed.setupId });
    const fake = (reply: string): AIProvider => ({
      ...new TestProvider(),
      info: () => ({ id: "test", enabled: true, model: "test", description: "Fake" }),
      assistantReply: async (_i: AssistantInput, _o?: unknown, onDelta?: (c: string) => void) => {
        onDelta?.(reply);
        return reply;
      },
    }) as AIProvider;
    const good = { type: "SIGNAL", observation: "Budget ist freigegeben", relevanceHypothesis: "", evidenceQuote: "Budget ist freigegeben" };
    const bad = { type: "SIGNAL", observation: "Erfunden", relevanceHypothesis: "", evidenceQuote: "Diese Textstelle gibt es nicht" };
    const r = await sendMessage(david, { threadId: view.thread.id, text: "Frau Keller sagte: Budget ist freigegeben." }, { provider: fake(`Verstanden.\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ items: [good, bad], missing: [] })}`) });
    expect(r.cards).toHaveLength(1);
    expect(r.message.text).toMatch(/1 Vorschlag.*verworfen/);

    const r2 = await sendMessage(david, { threadId: view.thread.id, text: "Noch etwas." }, { provider: fake(`Nur Prosa ohne Karten.`) });
    expect(r2.cards).toHaveLength(0);
    expect(r2.message.text).toMatch(/keine auswertbaren Karten/);
    expect(splitReply("a\n===KARTEN===\nkein json").json).toBeNull();
  });

  it("Ohne KI schweigt der Assistent nicht: Antwort mit offenen Punkten und fehlenden Informationen; Interviewmodus stellt die erste Frage", async () => {
    process.env.AI_PROVIDER = "disabled";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const nina = await actorFor("nina");
    const view = await getThreadView(nina, { type: "SETUP", id: seed.setupId });
    const r = await sendMessage(nina, { threadId: view.thread.id, text: "Was steht an?" });
    expect(r.message.text).toMatch(/deaktiviert/);
    expect(r.cards).toHaveLength(0);
    const mode = await setInterviewMode(nina, { threadId: view.thread.id, interviewMode: "true" });
    expect(mode.interviewMode).toBe(true);
    const v2 = await getThreadView(nina, { type: "SETUP", id: seed.setupId });
    expect(v2.thread.interviewMode).toBe(true);
    expect(v2.messages[v2.messages.length - 1]?.text).toMatch(/Organisation/);
    // Fremder Nutzer kann im Gespräch weder schreiben noch entscheiden
    const lars = await actorFor("lars");
    await expect(sendMessage(lars, { threadId: view.thread.id, text: "Hallo" })).rejects.toBeInstanceOf(NotFoundError);
    // Nur-Leser (CEO) bekommt beim Übernehmen einer Setup-Karte eine verständliche Ablehnung
    const clemens = await actorFor("clemens");
    const cv = await getThreadView(clemens, { type: "SETUP", id: seed.setupId });
    expect(cv.context.canWrite).toBe(false);
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const rc = await sendMessage(clemens, { threadId: cv.thread.id, text: "Frau Keller sagte: Budget ist freigegeben." });
    const sig = rc.cards.find((c) => c.item.type === "SIGNAL");
    if (sig) await expect(decideCard(clemens, { threadId: cv.thread.id, messageId: rc.message.id, cardId: sig.id, decision: "UEBERNEHMEN" })).rejects.toBeInstanceOf(ForbiddenError);
    // Archivieren liefert ein frisches Gespräch
    const fresh = await archiveThread(nina, view.thread.id);
    expect(fresh.id).not.toBe(view.thread.id);
    await expect(sendMessage(nina, { threadId: view.thread.id, text: "Hallo" })).rejects.toBeInstanceOf(TransitionError);
  });
});

describe("Robuste Kartenauswertung (Produktionsmodelle halten das Format nicht immer ein)", () => {
  it("splitReply erkennt Markervarianten, Codezäune und markerloses JSON; validateCards rettet gültige Karten einzeln", async () => {
    const { validateCards } = await import("@/modules/assistant/service");
    const json = JSON.stringify({ items: [{ type: "FRAGE", question: "Wer entscheidet?", purpose: "", evidenceQuote: "Wer entscheidet" }], missing: ["Budget?"] });
    expect(splitReply(`Prosa.\n=== KARTEN ===\n${json}`).json).not.toBeNull();
    expect(splitReply(`Prosa.\n===KARTEN===\n\`\`\`json\n${json}\n\`\`\``).json).not.toBeNull();
    expect(splitReply(`Prosa.\n\`\`\`json\n${json}\n\`\`\``).json).not.toBeNull();
    expect(splitReply(`Prosa ohne Marker. ${json}`).prose).toBe("Prosa ohne Marker.");
    expect(splitReply("Nur Prosa.").json).toBeNull();
    const v = validateCards({ items: [{ type: "FRAGE", question: "Wer entscheidet?", evidenceQuote: "Wer entscheidet" }, { type: "PERSON", displayName: "X" /* evidenceQuote fehlt */ }, { type: "SIGNAL", observation: "Budget frei", evidenceQuote: "gibt es nicht" }], missing: ["Budget?", 7] }, "Frage: Wer entscheidet über das Budget?");
    expect(v.items).toHaveLength(1);
    expect(v.invalid).toBe(1);
    expect(v.rejected).toBe(1);
    expect(v.missing).toEqual(["Budget?"]);
  });

  it("Ohne auswertbare Karten werden sie im zweiten Schritt (JSON-Modus) nachgezogen; Behauptungen wie „ich habe angelegt“ bekommen einen Hinweis", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const david = await actorFor("david");
    const view = await getThreadView(david, { type: "SETUP", id: seed.setupId });
    const text = "Frau Keller sagte: Budget ist freigegeben. Herr Berger schickt bis 30.09. das Konzept.";
    // Anbieter, der im Dialog das Format nicht einhält, im JSON-Modus aber liefert
    const flaky = {
      ...new TestProvider(),
      info: () => ({ id: "test", enabled: true, model: "test", description: "Flaky" }),
      assistantReply: async (_i: AssistantInput, _o?: unknown, onDelta?: (c: string) => void) => {
        const reply = "Ich habe Kunde, Personen und Aktionen angelegt und unten als Karten angehängt.";
        onDelta?.(reply);
        return reply;
      },
      assistantCards: async () => ({ items: [{ type: "SIGNAL", observation: "Budget ist freigegeben", relevanceHypothesis: "", purpose: "", evidenceQuote: "Budget ist freigegeben" }, { type: "AKTION", title: "Konzept von Herrn Berger nachhalten", description: "", ownerRole: "BD", dueHint: "30.09.", purpose: "", evidenceQuote: "schickt bis 30.09. das Konzept" }], missing: [] }),
    } as unknown as AIProvider;
    const r = await sendMessage(david, { threadId: view.thread.id, text }, { provider: flaky });
    expect(r.cards).toHaveLength(2);
    expect(r.message.text).toMatch(/zweiten Schritt/);
    // Gar keine Karten möglich + Behauptung „angelegt“ → ehrlicher Hinweis
    const liar = {
      ...new TestProvider(),
      info: () => ({ id: "test", enabled: true, model: "test", description: "Liar" }),
      assistantReply: async () => "Ich habe den Kunden jetzt angelegt.",
      assistantCards: async () => ({ items: [], missing: [] }),
    } as unknown as AIProvider;
    const r2 = await sendMessage(david, { threadId: view.thread.id, text: "Und?" }, { provider: liar });
    expect(r2.cards).toHaveLength(0);
    expect(r2.message.text).toMatch(/lege nichts selbst an/);
  });
});

describe("Etappe 11: Accountziel-Karte des Assistenten (KI-geführte Anlage durch den Principal)", () => {
  it("Nur Principal/CEO im Kundenkontext übernehmen eine Accountziel-Karte; die Ausgangslage kommt von der Anwendung, nicht vom Modell", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const petra = await actorFor("petra");
    const david = await actorFor("david");
    const text = "Wir wollen bis Q4 2027 drei Solution-Architektur-Rollen bei diesem Kunden aufbauen.";
    const provider = {
      ...new TestProvider(),
      info: () => ({ id: "test", enabled: true, model: "test", description: "Accountziel-Fake" }),
      assistantReply: async (_i: AssistantInput, _o?: unknown, onDelta?: (c: string) => void) => {
        const prose = "Verstanden, ich schlage ein Accountziel vor.";
        const json = JSON.stringify({ items: [{ type: "ACCOUNTZIEL", title: "Ausbau Solution-Architektur", desiredOutcome: text, roleFamily: "SOLUTION_ARCHITEKTUR", targetHeadcount: 3, horizon: "Q4 2027", successCriterion: "", evidenceQuote: text }], missing: [] });
        onDelta?.(prose);
        return `${prose}\n${ASSISTANT_CARDS_MARKER}\n${json}`;
      },
    } as unknown as AIProvider;

    // Principal im Kundenkontext: Karte erscheint und lässt sich übernehmen
    const view = await getThreadView(petra, { type: "ACCOUNT", id: seed.accountId });
    const r = await sendMessage(petra, { threadId: view.thread.id, text }, { provider });
    const card = r.cards.find((c) => c.item.type === "ACCOUNTZIEL");
    expect(card).toBeTruthy();
    const applied = await decideCard(petra, { threadId: view.thread.id, messageId: r.message.id, cardId: card!.id, decision: "UEBERNEHMEN" });
    expect(applied.card.resultType).toBe("GOAL");
    const goal = await db.query.goals.findFirst({ where: eq(schema.goals.id, applied.card.resultId!) });
    expect(goal?.accountId).toBe(seed.accountId);
    const version = await db.query.goalVersions.findFirst({ where: eq(schema.goalVersions.id, goal!.currentVersionId!) });
    expect(version?.targetValue).toBe("3");
    expect(version?.baseline).toMatch(/dokumentierte Position/); // von der Anwendung berechnet, nicht vom (Fake-)Modell geliefert

    // BD bekommt zwar die Karte angezeigt (der Fake-Anbieter prüft keine Rollen), darf sie aber nicht übernehmen
    const dView = await getThreadView(david, { type: "ACCOUNT", id: seed.accountId });
    const dr = await sendMessage(david, { threadId: dView.thread.id, text }, { provider });
    const dCard = dr.cards.find((c) => c.item.type === "ACCOUNTZIEL");
    expect(dCard).toBeTruthy();
    await expect(decideCard(david, { threadId: dView.thread.id, messageId: dr.message.id, cardId: dCard!.id, decision: "UEBERNEHMEN" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Etappe 14: Einsortierung eingefügter E-Mail-Texte einem bekannten Kunden zuordnen", () => {
  function einsortierungProvider(accountName: string, setupName: string, evidenceQuote: string): AIProvider {
    return {
      ...new TestProvider(),
      info: () => ({ id: "test", enabled: true, model: "test", description: "Einsortierung-Fake" }),
      assistantReply: async (_i: AssistantInput, _o?: unknown, onDelta?: (c: string) => void) => {
        const prose = "Das sieht nach einem bekannten Kunden aus, ich schlage die Einsortierung vor.";
        const json = JSON.stringify({ items: [{ type: "EINSORTIERUNG", accountName, setupName, reasoning: "Kundenname im Text erkannt.", evidenceQuote }], missing: [] });
        onDelta?.(prose);
        return `${prose}\n${ASSISTANT_CARDS_MARKER}\n${json}`;
      },
    } as unknown as AIProvider;
  }

  it("bindet das (allgemeine) Gespräch an den erkannten Kunden – ohne erkennbares Setup an den Kunden, sonst direkt an das Setup", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const petra = await actorFor("petra");
    const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, seed.accountId) });
    const text = `Kopie einer E-Mail von ${account!.name}: Wir würden uns über ein Update freuen.`;

    // Ohne erkennbares Setup: Zuordnung landet auf Kundenebene
    const view = await getThreadView(petra, { type: "GLOBAL", id: "" });
    const r = await sendMessage(petra, { threadId: view.thread.id, text }, { provider: einsortierungProvider(account!.name, "", text) });
    const card = r.cards.find((c) => c.item.type === "EINSORTIERUNG");
    expect(card).toBeTruthy();
    const applied = await decideCard(petra, { threadId: view.thread.id, messageId: r.message.id, cardId: card!.id, decision: "UEBERNEHMEN" });
    expect(applied.card.resultType).toBe("ACCOUNT");
    expect(applied.card.resultId).toBe(seed.accountId);
    expect(applied.thread.contextType).toBe("ACCOUNT");
    expect(applied.thread.contextId).toBe(seed.accountId);

    // Mit erkennbarem, bestehendem Setup: Zuordnung landet direkt auf dem Setup
    const view2 = await getThreadView(petra, { type: "GLOBAL", id: "" });
    const r2 = await sendMessage(petra, { threadId: view2.thread.id, text }, { provider: einsortierungProvider(account!.name, "Plattformteam", text) });
    const card2 = r2.cards.find((c) => c.item.type === "EINSORTIERUNG");
    expect(card2).toBeTruthy();
    const applied2 = await decideCard(petra, { threadId: view2.thread.id, messageId: r2.message.id, cardId: card2!.id, decision: "UEBERNEHMEN" });
    expect(applied2.card.resultType).toBe("SETUP");
    expect(applied2.card.resultId).toBe(seed.setupId);
    expect(applied2.thread.contextType).toBe("SETUP");
    expect(applied2.thread.contextId).toBe(seed.setupId);
  });

  it("erfundene oder unsichtbare Kundennamen werden nicht übernommen", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const petra = await actorFor("petra");
    const text = "Kopie einer E-Mail von einer Organisation, die im System nicht existiert.";
    const view = await getThreadView(petra, { type: "GLOBAL", id: "" });
    const r = await sendMessage(petra, { threadId: view.thread.id, text }, { provider: einsortierungProvider("Nicht existierende Organisation GmbH", "", text) });
    const card = r.cards.find((c) => c.item.type === "EINSORTIERUNG");
    expect(card).toBeTruthy();
    await expect(decideCard(petra, { threadId: view.thread.id, messageId: r.message.id, cardId: card!.id, decision: "UEBERNEHMEN" })).rejects.toBeInstanceOf(ValidationError);
  });
});
