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
