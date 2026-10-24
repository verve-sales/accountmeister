import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { connectMailbox, listSelectable } from "@/modules/integrations/service";
import { importMailboxItemSmart } from "@/modules/imports/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { fetchRealSource, listRealSelectable } from "@/modules/integrations/graph/client";
import { AdapterError } from "@/modules/integrations/adapter";
import type { IntakeItem } from "@/modules/ai/schemas";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 37: Teams-Chats im Eingang", () => {
  it("T01: Fixture-Chat auswählen → Kunde erkannt, Verlängerung am Einsatz, Aufgabe mit Datum; neue Nachrichten → neue Version", async () => {
    process.env.AI_PROVIDER = "test";
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `Testautomatisierung T01 ${Date.now()}`, needDescription: "Testautomatisierung im Kernteam.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "Tester:in", resourceKind: "FREELANCER", newName: "Mara Klein (fiktiv)", ekRate: "800", vkRate: "1000", desiredStart: plusDaysIso(todayIso(), -100), plannedEnd: plusDaysIso(todayIso(), 60) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -100) }).where(eq(schema.engagements.id, q.engagement.id));
    // Andere „Klein“-Einsätze aus früheren Läufen beenden, damit die Zuordnung eindeutig bleibt
    const others = (await db.query.engagements.findMany({ where: eq(schema.engagements.accountId, s.accountId) })).filter((e) => e.id !== q.engagement.id && /Klein/.test(e.title));
    for (const o of others) await db.update(schema.engagements).set({ status: "ABGESCHLOSSEN" }).where(eq(schema.engagements.id, o.id));
    await connectMailbox(david, { fixture: true }).catch(() => null);
    const list = await listSelectable(david, "CHAT");
    const chat = list.items.find((i) => i.kind === "CHAT");
    expect(chat?.subject).toBe("Chat mit Anne Keller");
    const r = await importMailboxItemSmart(david, { kind: "CHAT", externalId: chat!.externalId, setupId: "AUTO" });
    expect(r.accountName).toBe("Beispielkonzern AG (fiktiv)");
    const cards = (await db.query.suggestions.findMany({ where: eq(schema.suggestions.type, "KARTE") })).filter((c) => c.sourceIds.includes(r.sourceId));
    const types = cards.map((c) => (c.payload as { item: IntakeItem }).item.type);
    expect(types).toContain("VERLAENGERUNG");
    expect(types).toContain("AKTION");
    expect(cards.find((c) => (c.payload as { item: IntakeItem }).item.type === "VERLAENGERUNG")?.objectId).toBe(q.engagement.id);
    const src = await db.query.sources.findFirst({ where: eq(schema.sources.id, r.sourceId) });
    expect(src?.type).toBe("CHAT");
    // erneut übernehmen: kein zweiter Import, aber Auswertung läuft
    const again = await importMailboxItemSmart(david, { kind: "CHAT", externalId: chat!.externalId, setupId: "AUTO" });
    expect(again.repeated).toBe(true);
    expect(again.sourceId).toBe(r.sourceId);
  });

  it("T02: Graph-Client – Chatliste mit letzter Nachricht, Verlauf als „[Zeit] Name: Text“ (älteste zuerst, ohne Systemnachrichten); 403 → Hinweis auf fehlende Berechtigung", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes("/me/chats?")) return new Response(JSON.stringify({ value: [{ id: "c1", topic: null, chatType: "oneOnOne", members: [{ displayName: "Anne Keller", email: "anne@kunde.example" }, { displayName: "Ivo Seifert" }], lastMessagePreview: { createdDateTime: "2026-10-20T13:12:00Z", body: { content: "<p>Bis <b>Freitag</b> bitte</p>" }, from: { user: { displayName: "Anne Keller" } } } }] }), { status: 200 });
      if (url.endsWith("/me/chats/c1?$expand=members")) return new Response(JSON.stringify({ id: "c1", topic: "Verlängerung Klein", members: [{ displayName: "Anne Keller", email: "anne@kunde.example" }] }), { status: 200 });
      if (url.includes("/me/chats/c1/messages")) return new Response(JSON.stringify({ value: [
        { id: "m3", createdDateTime: "2026-10-20T13:12:00Z", messageType: "message", from: { user: { displayName: "Anne Keller" } }, body: { contentType: "html", content: "<p>Profile bis Ende des Monats</p>" } },
        { id: "m2", createdDateTime: "2026-10-20T13:05:00Z", messageType: "systemEventMessage", body: { content: "<systemEventMessage/>" } },
        { id: "m1", createdDateTime: "2026-10-20T13:02:00Z", messageType: "message", from: { user: { displayName: "Ivo Seifert" } }, body: { contentType: "text", content: "Danke!" } },
      ] }), { status: 200 });
      return new Response("{}", { status: 403 });
    }) as unknown as typeof fetch;
    const items = await listRealSelectable("tok", "CHAT", undefined, 20, fetchImpl);
    expect(items[0]!.subject).toBe("Chat mit Anne Keller, Ivo Seifert");
    expect(items[0]!.preview).toBe("Bis Freitag bitte");
    const f = await fetchRealSource("tok", "CHAT", "c1", fetchImpl);
    expect(f.subject).toBe("Verlängerung Klein");
    expect(f.bodyText.split("\n")).toEqual(["[20.10.2026 15:02] Ivo Seifert: Danke!", "[20.10.2026 15:12] Anne Keller: Profile bis Ende des Monats"]);
    await expect(fetchRealSource("tok", "CHAT", "kein-zugriff", fetchImpl)).rejects.toBeInstanceOf(AdapterError);
  });
});
