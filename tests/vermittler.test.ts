import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { getThreadView, sendMessage } from "@/modules/assistant/service";
import { asgIntermediaryRequests, closeRequest, expireIntermediaryRequests, markRequestProfileSent } from "@/modules/assignments/service";
import { ASSISTANT_CARDS_MARKER } from "@/modules/ai/schemas";
import { TestProvider } from "@/modules/ai/providers/test";
import { actorFor } from "./helpers";

const fake = (reply: string) => ({ ...new TestProvider(), info: () => ({ id: "test", enabled: true, model: "test", description: "Fake" }), assistantReply: async () => reply }) as never;

describe("e57: Vermittler-Anfragen", () => {
  it("V01: Mail mit zwei vorgeschlagenen Kolleg:innen → Vermittler als Kunde, zwei Chancen mit Kandidatur und Satz; Bearbeitung im Assignmentmanager", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const ceo = await actorFor("clemens");
    const tag = Date.now().toString(36);
    const vm = `Vermittlung${tag} AG (fiktiv)`;
    const text = `Bitte anlegen: Anfrage von ${vm}, BA/RE Testdaten, wir haben Nin und Lar vorgeschlagen, für beide 95 € pro Stunde`;
    const item = {
      type: "VERMITTLER_ANFRAGE", intermediaryName: vm, contactName: "Alex Muster (fiktiv)", contactEmail: "alex.muster@vermittlung.example", contactFunction: "Key Account Manager",
      endCustomer: "großes Versicherungsunternehmen", title: "Business Analyst / Requirements Engineer", tasks: "Testdatenmanagement", mustHave: "BA-Erfahrung", location: "NRW, 10 % vor Ort",
      desiredStart: "2027-01-01", durationHint: "12 Monate", scopeAmount: 100, scopeUnit: "PROZENT",
      candidates: [{ name: "Nin", resourceKind: "INTERN", status: "VORGESTELLT", rate: "95", rateUnit: "STUNDE", note: "Bank-Einsatz endet" }, { name: "Lar", resourceKind: "INTERN", status: "VORGESTELLT", rate: "95", rateUnit: "STUNDE" }],
      evidenceQuote: "wir haben Nin und Lar vorgeschlagen",
    };
    const view = await getThreadView(ceo, { type: "GLOBAL", id: "" });
    const r = await sendMessage(ceo, { threadId: view.thread.id, text }, { provider: fake(`Mach ich.\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ items: [item], execute: [0], missing: [] })}`) });
    expect(r.cards[0]!.status).toBe("UEBERNOMMEN");
    expect(r.message.text).toMatch(/2 Chancen bei Vermittlung.* \(Vermittler\) angelegt: Nina Demo.*Profil verschickt.*95 €\/Std\./);
    const acc = (await db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, ceo.workspaceId) })).find((a) => a.name === vm)!;
    expect(acc.accountKind).toBe("VERMITTLER");
    expect((await db.query.persons.findMany({ where: eq(schema.persons.accountId, acc.id) })).map((p) => p.displayName)).toContain("Alex Muster (fiktiv)");
    const opps = await db.query.opportunities.findMany({ where: eq(schema.opportunities.accountId, acc.id) });
    expect(opps).toHaveLength(2);
    expect(opps.every((o) => o.status === "PROFIL_ANGEBOT_VORGESTELLT" && o.endCustomerNote === "großes Versicherungsunternehmen")).toBe(true);
    const pos = await db.query.staffingPositions.findMany({ where: inArray(schema.staffingPositions.opportunityId, opps.map((o) => o.id)) });
    const cands = await db.query.candidacies.findMany({ where: inArray(schema.candidacies.positionId, pos.map((p) => p.id)) });
    expect(cands.map((c) => [c.status, String(c.vkRate), c.rateUnit])).toEqual([["VORGESTELLT", "95.00", "STUNDE"], ["VORGESTELLT", "95.00", "STUNDE"]]);
    // Assignmentmanager
    const list = (await asgIntermediaryRequests(ceo)).filter((x) => x.intermediary === vm);
    expect(list).toHaveLength(2);
    expect(list.every((x) => x.phase === "ANGEBOT" && x.rate === "95,00 €/Std." && x.expiresInDays === null)).toBe(true);
    await closeRequest(ceo, list[0]!.opportunityId);
    expect((await asgIntermediaryRequests(ceo)).filter((x) => x.intermediary === vm)).toHaveLength(1);
    await expect(asgIntermediaryRequests(await actorFor("nina"))).rejects.toThrow();

    // Zweite Anfrage desselben Vermittlers ohne Personen: gleicher Kunde, offene Position, läuft aus
    const item2 = { ...item, title: "Testmanager", candidates: [], evidenceQuote: "Testmanager gesucht" };
    const v2 = await getThreadView(ceo, { type: "GLOBAL", id: "" });
    await sendMessage(ceo, { threadId: v2.thread.id, text: `${vm}: Testmanager gesucht` }, { provider: fake(`Mach ich.\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ items: [item2], execute: [0], missing: [] })}`) });
    expect((await db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, ceo.workspaceId) })).filter((a) => a.name === vm)).toHaveLength(1);
    const open = (await asgIntermediaryRequests(ceo)).find((x) => x.intermediary === vm && x.title === "Testmanager")!;
    expect(open.phase).toBe("ANFRAGE");
    expect(open.expiresInDays).toBe(14);
    await db.update(schema.opportunities).set({ updatedAt: new Date(Date.now() - 20 * 86400000) }).where(eq(schema.opportunities.id, open.opportunityId));
    expect(await expireIntermediaryRequests()).toBeGreaterThanOrEqual(1);
    expect((await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, open.opportunityId) }))?.status).toBe("BEENDET");
    // CV verschickt hebt eine offene Anfrage an
    await sendMessage(ceo, { threadId: v2.thread.id, text: `${vm}: Testmanager gesucht` }, { provider: fake(`Mach ich.\n${ASSISTANT_CARDS_MARKER}\n${JSON.stringify({ items: [item2], execute: [0], missing: [] })}`) });
    const again = (await asgIntermediaryRequests(ceo)).find((x) => x.intermediary === vm && x.title === "Testmanager")!;
    await markRequestProfileSent(ceo, again.opportunityId);
    expect((await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, again.opportunityId) }))?.status).toBe("PROFIL_ANGEBOT_VORGESTELLT");
  });
});
