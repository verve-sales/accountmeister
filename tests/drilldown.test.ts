import { describe, expect, it } from "vitest";
import { resetConfigCacheForTests } from "@/lib/config";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { loadActor } from "@/modules/identity/actor";
import { drilldown, drillHref } from "@/modules/opportunities/drilldown";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 46: Kennzahlen führen auf die Chancen und Kunden dahinter", () => {
  it("D01: Freelancer-Chancen je BD, neu in 90 Tagen, Kunden ohne Freelancer-Chance; nur sichtbare Kunden", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    await ensureSeed();
    const d0 = await actorFor("david");
    const tag = Date.now().toString(36);
    const withFl = await createAccount(d0, { name: `Drill mit ${tag} (fiktiv)`, orgType: "KONZERN", responsibleBdUserId: d0.userId });
    const without = await createAccount(d0, { name: `Drill ohne ${tag} (fiktiv)`, orgType: "KONZERN", responsibleBdUserId: d0.userId });
    const david = (await loadActor(d0.userId))!;
    const st = await createSetup(david, { accountId: withFl.id, name: "Drill-Setup", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
    const opp = await createOpportunity(david, { setupId: st.id, title: `Freelancer Drill ${tag}`, needDescription: "Ein Spezialist für Lasttests.", kind: "FREELANCER_EXPERTE", ownerUserId: david.userId });
    const ceo = await actorFor("clemens");
    const open = await drilldown(ceo, { bd: david.userId, art: "FREELANCER_EXPERTE", stufe: "offen" });
    expect(open.mode).toBe("chancen");
    expect(open.chances.map((c) => c.id)).toContain(opp.id);
    expect(open.title).toMatch(/Freelancer-Experte/);
    const neu = await drilldown(ceo, { bd: david.userId, art: "FREELANCER_EXPERTE", neu: "90" });
    expect(neu.chances.map((c) => c.id)).toContain(opp.id);
    const ohne = await drilldown(ceo, { bd: david.userId, ohne: "FREELANCER_EXPERTE" });
    expect(ohne.mode).toBe("kunden");
    expect(ohne.accounts.map((a) => a.id)).toContain(without.id);
    expect(ohne.accounts.map((a) => a.id)).not.toContain(withFl.id);
    // ein fremder BD sieht die Kunden nicht
    expect((await drilldown(await actorFor("lars"), { art: "FREELANCER_EXPERTE", stufe: "offen" })).chances.some((c) => c.id === opp.id)).toBe(false);
    expect(drillHref({ bd: "x", art: "FREELANCER_EXPERTE", stufe: "offen" })).toBe("/chancen?bd=x&art=FREELANCER_EXPERTE&stufe=offen");
  });
});
