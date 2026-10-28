import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { createInitiative } from "@/modules/agenda/service";
import { eingangFromText } from "@/modules/eingang/service";
import { acceptSuggestion, listCardsByInitiative, listMySuggestions } from "@/modules/suggestions/service";
import type { IntakeItem } from "@/modules/ai/schemas";
import { loadActor } from "@/modules/identity/actor";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 43: KI-Vorschläge an der Schlüssel-Initiative", () => {
  it("I01: Karte zahlt auf die Initiative ein → erscheint in der Kundenagenda; übernommene Chance hängt an der Initiative", async () => {
    process.env.AI_PROVIDER = "test";
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    await ensureSeed();
    const d0 = await actorFor("david");
    const acc = await createAccount(d0, { name: `Initiativbank ${Date.now().toString(36)} (fiktiv)`, orgType: "KONZERN", responsibleBdUserId: d0.userId });
    const david = (await loadActor(d0.userId))!;
    const setup = await createSetup(david, { accountId: acc.id, name: "Tooling", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
    const ini = await createInitiative(david, { accountId: acc.id, kind: "INITIATIVE", title: "Jira-Ablösung bis Ende 2026" });
    const text = "Hallo Herr Beispiel,\nfür die Jira-Ablösung brauchen wir ab Januar zwei Scrum Master. Nächster Schritt: Profile bis Ende des Monats schicken.\nViele Grüße";
    const r = await eingangFromText(david, { text, setupId: setup.id });
    const cards = (await db.query.suggestions.findMany({ where: eq(schema.suggestions.type, "KARTE") })).filter((c) => c.sourceIds.includes(r.sourceId));
    const linked = cards.filter((c) => c.initiativeId === ini.id);
    expect(linked.length).toBeGreaterThan(0);
    const byIni = await listCardsByInitiative(david, acc.id);
    expect(byIni[ini.id]?.map((c) => c.id).sort()).toEqual(linked.map((c) => c.id).sort());
    // Start: gruppiert nach Kunde, Kundenname dabei
    expect((await listMySuggestions(david)).some((x) => x.accountName === acc.name)).toBe(true);
    // Chance übernehmen → zahlt auf die Initiative ein
    const chance = linked.find((c) => (c.payload as { item: IntakeItem }).item.type === "CHANCE");
    expect(chance).toBeTruthy();
    const a = await acceptSuggestion(david, chance!.id, { version: chance!.version });
    const opp = (await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, a.acceptedObjectId!) }))!;
    expect(opp.initiativeId).toBe(ini.id);
    // Fremde sehen die Karten an der Initiative nicht
    expect(Object.keys(await listCardsByInitiative(await actorFor("lars"), acc.id).catch(() => ({})))).toHaveLength(0);
  });
});
