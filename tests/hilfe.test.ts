import { describe, expect, it } from "vitest";
import { resetConfigCacheForTests } from "@/lib/config";
import { getThreadView, sendMessage } from "@/modules/assistant/service";
import { TestProvider } from "@/modules/ai/providers/test";
import { ASSISTANT_CARDS_MARKER } from "@/modules/ai/schemas";
import type { AIProvider, AssistantInput } from "@/modules/ai/provider";
import { HELP_SECTIONS, looksLikeHowTo, searchHelp } from "@/modules/help/knowledge";
import { buildHelpText } from "@/modules/help/service";
import { actorFor, ensureSeed } from "./helpers";

/**
 * Etappe 25: Der Assistent kennt Handbuch, Funktionen und Einstellungen und beantwortet Bedienfragen daraus.
 */
describe("Etappe 25: Hilfe-Wissen für den Assistenten", () => {
  it("Stichwortsuche findet den passenden Abschnitt zu typischen Rückfragen", () => {
    expect(searchHelp("Wie komme ich von In Klärung nach Bestätigt?")[0]?.section.id).toBe("chance-status");
    expect(searchHelp("Wer darf den strategischen Fokus ändern?")[0]?.section.id).toBe("fokus");
    expect(searchHelp("Wann startet die Verlängerungsregel?")[0]?.section.id).toBe("health");
    expect(searchHelp("Was darf Sales Operations?")[0]?.section.id).toBe("rollen");
    expect(searchHelp("Wie stelle ich den BD um?")[0]?.section.id).toBe("delegation");
    expect(searchHelp("xyz qqq")).toHaveLength(0);
    expect(looksLikeHowTo("Wie kann ich eine Chance bestätigen?")).toBe(true);
    expect(looksLikeHowTo("Wie bestätige ich eine Chance?")).toBe(true);
    expect(looksLikeHowTo("Was darf Sales Operations?")).toBe(true);
    expect(looksLikeHowTo("Frau Keller sagte: Budget ist freigegeben.")).toBe(false);
  });

  it("Grundaussagen der Hilfe stimmen mit den Regeln der Anwendung überein", () => {
    const body = (id: string) => HELP_SECTIONS.find((s) => s.id === id)!.body;
    expect(body("chance-status")).toMatch(/Chance bestätigen \(mit Beleg\)/);
    expect(body("chance-status")).toMatch(/In Klärung nehmen/);
    expect(body("health")).toMatch(/14 Tage vor der Verlängerungsfrist bzw\. 8 Wochen vor dem Einsatzende/);
    expect(body("ruhend")).toMatch(/180 Tagen/);
    expect(new Set(HELP_SECTIONS.map((s) => s.id)).size).toBe(HELP_SECTIONS.length);
  });

  it("Der Hilfe-Block enthält Inhaltsverzeichnis, passende Abschnitte und die echten Rollen/Einstellungen der Person", async () => {
    await ensureSeed();
    const petra = await actorFor("petra");
    const { text, sections } = await buildHelpText(petra, "Wie bestätige ich eine Chance?");
    expect(sections[0]?.id).toBe("chance-status");
    expect(text).toMatch(/Inhaltsverzeichnis der Hilfe/);
    expect(text).toMatch(/Deine Rollen: .*Principal/);
    expect(text).toMatch(/den strategischen Fokus bearbeiten/);
    expect(text).toMatch(/Freelancer-Hebel (an|aus)/);
    expect(text).toMatch(/Aktive Vorgehensmuster: .*Altkunden-Reaktivierung/);
  });

  it("Der Assistent bekommt die Hilfe mitgeliefert und beantwortet Bedienfragen daraus – mit KI, ohne KI und als Rückfrage", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const seed = await ensureSeed();
    const david = await actorFor("david");
    const view = await getThreadView(david, { type: "SETUP", id: seed.setupId });

    // Das Modell sieht den Hilfe-Block
    let seen: AssistantInput | null = null;
    const spy: AIProvider = {
      ...new TestProvider(),
      info: () => ({ id: "test", enabled: true, model: "test", description: "Spy" }),
      assistantReply: async (i: AssistantInput, _o?: unknown, onDelta?: (c: string) => void) => {
        seen = i;
        const out = `Ok.\n${ASSISTANT_CARDS_MARKER}\n{"items":[],"missing":[]}`;
        onDelta?.(out);
        return out;
      },
    } as AIProvider;
    await sendMessage(david, { threadId: view.thread.id, text: "Wo finde ich den Health-Check?" }, { provider: spy });
    expect(seen!.helpText).toMatch(/Kunden-Health-Check und Verlängerungsregel/);
    // Rückfrage ohne eigene Stichworte nutzt die vorige Frage mit
    await sendMessage(david, { threadId: view.thread.id, text: "Und wer darf das?" }, { provider: spy });
    expect(seen!.helpText).toMatch(/Passende Abschnitte zur Frage:\n## Kunden-Health-Check/);

    // Testanbieter antwortet deterministisch aus dem Abschnitt, ohne Karten
    const r = await sendMessage(david, { threadId: view.thread.id, text: "Wie kann ich eine Chance von In Klärung auf Bestätigt setzen?" });
    expect(r.message.text).toMatch(/Laut Hilfe/);
    expect(r.message.text).toMatch(/Chance bestätigen \(mit Beleg\)/);
    expect(r.cards).toHaveLength(0);

    // Ohne KI: Abschnitt direkt aus der Hilfe
    process.env.AI_PROVIDER = "disabled";
    resetConfigCacheForTests();
    const r2 = await sendMessage(david, { threadId: view.thread.id, text: "Wie stelle ich den zuständigen BD um?" });
    expect(r2.message.text).toMatch(/deaktiviert – hier der passende Abschnitt/);
    expect(r2.message.text).toMatch(/Zuständigkeit umstellen/);
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
  });
});
