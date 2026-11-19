import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { getThreadView, sendMessage, validateCards } from "@/modules/assistant/service";
import { actorFor } from "./helpers";

function env() {
  process.env.AI_PROVIDER = "test";
  resetConfigCacheForTests();
}

describe("e53: Assistent erledigt Aufträge direkt", () => {
  it("A01: GF legt im allgemeinen Kontext einen Kunden an – ohne Klick, Gespräch hängt danach am Setup", async () => {
    env();
    const ceo = await actorFor("clemens");
    const view = await getThreadView(ceo, { type: "GLOBAL", id: "" });
    expect(view.context.canWrite).toBe(true);
    const tag = Date.now().toString(36);
    const r = await sendMessage(ceo, { threadId: view.thread.id, text: `lege einfach einen neuen kunden Westnetz${tag} GmbH an` });
    const card = r.cards.find((c) => c.item.type === "KUNDE")!;
    expect(card.status).toBe("UEBERNOMMEN");
    expect(card.auto).toBe(true);
    expect(r.message.text).toMatch(/^Erledigt: Kunde „Westnetz/);
    expect(r.message.text).not.toMatch(/zweiten Schritt|Textstelle/);
    expect(r.thread?.contextType).toBe("SETUP");
    const acc = (await db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, ceo.workspaceId) })).filter((a) => a.name.toLowerCase().startsWith(`westnetz${tag}`));
    expect(acc).toHaveLength(1);
    // Zweiter Auftrag im neuen Gespräch: kein Doppel, bestehender Kunde wird verwendet
    const v2 = await getThreadView(ceo, { type: "GLOBAL", id: "" });
    const r2 = await sendMessage(ceo, { threadId: v2.thread.id, text: `lege einen neuen kunden westnetz${tag} gmbh an` });
    expect(r2.cards[0]!.note).toMatch(/gibt es schon/);
    expect((await db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, ceo.workspaceId) })).filter((a) => a.name.toLowerCase().startsWith(`westnetz${tag}`))).toHaveLength(1);
  });

  it("A02: Aufgabe mit Priorität und Datum; ausgeführt wird nur, was in der letzten Nachricht steht", async () => {
    env();
    const ceo = await actorFor("clemens");
    const view = await getThreadView(ceo, { type: "GLOBAL", id: "" });
    const r = await sendMessage(ceo, { threadId: view.thread.id, text: "Erinnere mich, dringend die Rahmenvertragsliste zu prüfen" });
    const c = r.cards[0]!;
    expect(c.status).toBe("UEBERNOMMEN");
    const w = await db.query.workItems.findFirst({ where: eq(schema.workItems.id, c.resultId!) });
    expect(w?.priority).toBe("HOCH");
    expect(w?.dueDate).toBeTruthy();
    // execute auf eine Karte, deren Beleg nicht aus der letzten Nachricht stammt → bleibt Vorschlag
    const v = validateCards({ items: [{ type: "FRAGE", question: "Wer entscheidet?", purpose: "", evidenceQuote: "Rahmenvertragsliste" }], execute: [0] }, "Rahmenvertragsliste");
    expect(v.execute).toEqual([0]);
  });
});

describe("e56: Verlängerung am bestehenden Einsatz, Setup ohne Rückfrage", () => {
  it("A03: Im Kundenkontext wird die Verlängerung am Einsatz angestoßen und eine Chance im vorhandenen Setup angelegt", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const { ASSISTANT_CARDS_MARKER } = await import("@/modules/ai/schemas");
    const { TestProvider } = await import("@/modules/ai/providers/test");
    const { createOpportunity } = await import("@/modules/opportunities/service");
    const { quickFill } = await import("@/modules/staffing/service");
    const { plusDaysIso, todayIso } = await import("@/modules/work/calendar");
    const { ensureSeed } = await import("./helpers");
    const s = await ensureSeed();
    const david = await actorFor("david");
    const tag = Date.now().toString(36);
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `A03 ${tag}`, needDescription: "Testbedarf Verlängerung.", kind: "VERVE_EXPERTE" });
    const name = `Paula Probe${tag}`;
    const q = await quickFill(david, opp.id, { title: "Projektleitung", resourceKind: "FREELANCER", newName: `${name} (fiktiv)`, ekRate: "700", vkRate: "1000", desiredStart: plusDaysIso(todayIso(), -60), plannedEnd: plusDaysIso(todayIso(), 40) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -60) }).where(eq(schema.engagements.id, q.engagement.id));
    const text = `${name} bei uns: die möchten ev verlängern bis 30.04.2027, außerdem suchen sie einen Tester`;
    const reply = `Mach ich.\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ items: [
      { type: "EINSATZ_VERLAENGERN", engagementPerson: `${name} (fiktiv)`, signal: "VERLAENGERN", wishEnd: "2027-04-30", note: "noch unsicher", evidenceQuote: "die möchten ev verlängern bis 30.04.2027" },
      { type: "CHANCE", title: "Tester gesucht", needDescription: "Kunde sucht einen Tester", kind: "FREELANCER_EXPERTE", roleName: "Test Management", headcount: null, horizon: "", anticipated: true, evidenceQuote: "suchen sie einen Tester" },
    ], execute: [0, 1], missing: [] })}`;
    const provider = { ...new TestProvider(), info: () => ({ id: "test", enabled: true, model: "test", description: "Fake" }), assistantReply: async () => reply } as never;
    const view = await getThreadView(david, { type: "ACCOUNT", id: s.accountId });
    const r = await sendMessage(david, { threadId: view.thread.id, text }, { provider });
    expect(r.cards.every((c) => c.status === "UEBERNOMMEN")).toBe(true);
    expect(r.message.text).toMatch(/Verlängerung für .* angestoßen – Wunschende 30\.04\.2027/);
    expect(r.message.text).toMatch(/Setup/);
    const ren = await db.query.renewalDecisions.findFirst({ where: eq(schema.renewalDecisions.engagementId, q.engagement.id) });
    expect(ren?.status).toBe("IN_ABSTIMMUNG");
    expect(ren?.proposedTo).toBe("2027-04-30");
    const chance = await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, r.cards[1]!.resultId!) });
    expect(chance?.accountId).toBe(s.accountId);
    expect(r.thread?.contextType).toBe("SETUP");
  });
});

describe("e58: mögliche Verlängerung als Chance im Setup des Einsatzes", () => {
  it("A04: im allgemeinen Kontext entsteht die Chance im Setup des laufenden Einsatzes, plus Aufgabe zur Frist", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const { ASSISTANT_CARDS_MARKER } = await import("@/modules/ai/schemas");
    const { TestProvider } = await import("@/modules/ai/providers/test");
    const { createOpportunity } = await import("@/modules/opportunities/service");
    const { quickFill } = await import("@/modules/staffing/service");
    const { plusDaysIso, todayIso } = await import("@/modules/work/calendar");
    const { ensureSeed } = await import("./helpers");
    const s = await ensureSeed();
    const david = await actorFor("david");
    const tag = Date.now().toString(36);
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `A04 ${tag}`, needDescription: "Testbedarf Verlängerung.", kind: "VERVE_EXPERTE" });
    const name = `Peter Probe${tag}`;
    const q = await quickFill(david, opp.id, { title: "Testmanagement", resourceKind: "FREELANCER", newName: `${name} (fiktiv)`, ekRate: "700", vkRate: "1000", desiredStart: plusDaysIso(todayIso(), -60), plannedEnd: plusDaysIso(todayIso(), 40) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -60) }).where(eq(schema.engagements.id, q.engagement.id));
    const text = `der kunde überlegt, ${name} zu verlängern, sie müssen Budget klären und geben bis zum 01.12. Bescheid`;
    const reply = `Mach ich.\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ items: [
      { type: "CHANCE", title: `Verlängerung ${name}`, needDescription: "Kunde überlegt zu verlängern, Budget wird geklärt.", kind: "VERVE_EXPERTE", roleName: "", headcount: null, horizon: "", anticipated: false, engagementPerson: `${name} (fiktiv)`, evidenceQuote: `überlegt, ${name} zu verlängern` },
      { type: "VORGANG", title: "Entscheidung Verlängerung nachhalten", description: "", target: "ICH", personName: "", serviceKey: "", dueHint: "01.12.", priority: "NORMAL", accountName: "", evidenceQuote: "geben bis zum 01.12. Bescheid" },
    ], execute: [0, 1], missing: [] })}`;
    const provider = { ...new TestProvider(), info: () => ({ id: "test", enabled: true, model: "test", description: "Fake" }), assistantReply: async () => reply } as never;
    const view = await getThreadView(david, { type: "GLOBAL", id: "" });
    const r = await sendMessage(david, { threadId: view.thread.id, text }, { provider });
    expect(r.cards.map((c) => c.status)).toEqual(["UEBERNOMMEN", "UEBERNOMMEN"]);
    const chance = await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, r.cards[0]!.resultId!) });
    expect(chance?.setupId).toBe(q.engagement.setupId);
    expect(chance?.kind).toBe("FREELANCER_EXPERTE");
    expect(r.message.text).toMatch(/im Setup/);
    // keine Verlängerungsentscheidung angelegt
    expect(await db.query.renewalDecisions.findFirst({ where: eq(schema.renewalDecisions.engagementId, q.engagement.id) })).toBeUndefined();
  });
});
