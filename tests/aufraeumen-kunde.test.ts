import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { findEngagementDuplicates, findSetupDuplicates, mergeEngagements, mergeSetups } from "@/modules/cleanup/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor } from "./helpers";

describe("e59: Aufräumen beim Kunden", () => {
  it("U01: Platzhalter-Projekt neben echtem Projekt wird erkannt; BD führt zusammen; danach doppelter Einsatz zusammenführbar", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const david = await actorFor("david");
    const ceo = await actorFor("clemens");
    const tag = Date.now().toString(36);
    const acc = await createAccount(david, { name: `Aufräumbank ${tag} (fiktiv)`, orgType: "SONSTIGE", responsibleBdUserId: david.userId });
    const real = await createSetup(david, { accountId: acc.id, name: "Tester-Einsatz", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
    const ph = await createSetup(david, { accountId: acc.id, name: "Ohne Bereich", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
    const person = `Sven Seif ${tag} (fiktiv)`;
    const mk = async (setupId: string, label: string) => {
      const o = await createOpportunity(david, { setupId, title: `${label} ${tag}`, needDescription: "Testbedarf Aufräumen.", kind: "FREELANCER_EXPERTE" });
      const q = await quickFill(david, o.id, { title: "Tester", resourceKind: "FREELANCER", newName: person, ekRate: "600", vkRate: "900", desiredStart: plusDaysIso(todayIso(), -30), plannedEnd: plusDaysIso(todayIso(), 70) });
      await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -30) }).where(eq(schema.engagements.id, q.engagement.id));
      return q.engagement.id;
    };
    const e1 = await mk(real.id, "Testorganisation");
    const e2 = await mk(ph.id, "manuelles Testing");
    const sd = await findSetupDuplicates(david, acc.id);
    expect(sd).toHaveLength(1);
    expect(sd[0]!.keep.id).toBe(real.id);
    expect(sd[0]!.drop.map((x) => x.id)).toEqual([ph.id]);
    await mergeSetups(david, real.id, [ph.id]);
    expect(await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, ph.id) })).toBeUndefined();
    expect((await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e2) }))?.setupId).toBe(real.id);
    expect(await findSetupDuplicates(david, acc.id)).toHaveLength(0);
    const ed = await findEngagementDuplicates(ceo, undefined, acc.id);
    expect(ed).toHaveLength(1);
    await mergeEngagements(ceo, e1, [e2]);
    expect(await findEngagementDuplicates(ceo, undefined, acc.id)).toHaveLength(0);
    // fremder BD darf nicht
    await expect(mergeSetups(await actorFor("lars"), real.id, [real.id])).rejects.toThrow();
  });
});
