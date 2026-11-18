import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createOpportunity } from "@/modules/opportunities/service";
import { createFreelancer, quickFill } from "@/modules/staffing/service";
import { findFreelancerDuplicates, mergeFreelancers, mergeEngagements, findEngagementDuplicates } from "@/modules/cleanup/service";
import { freelancerKey } from "@/modules/staffing/dedupe";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { ForbiddenError } from "@/lib/errors";
import { actorFor, ensureSeed } from "./helpers";

function env() {
  process.env.FEATURE_BESETZUNG = "true";
  resetConfigCacheForTests();
}

async function engagementFor(freelancerId: string, label: string) {
  const s = await ensureSeed();
  const david = await actorFor("david");
  const opp = await createOpportunity(david, { setupId: s.setupId, title: `${label} ${Date.now().toString(36)}`, needDescription: "Testbedarf Dubletten.", kind: "FREELANCER_EXPERTE" });
  const q = await quickFill(david, opp.id, { title: label, resourceKind: "FREELANCER", freelancerId, ekRate: "800", vkRate: "1000", desiredStart: plusDaysIso(todayIso(), -30), plannedEnd: plusDaysIso(todayIso(), 90) });
  await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -30) }).where(eq(schema.engagements.id, q.engagement.id));
  return q.engagement.id;
}

describe("e51: Freelancer-Dubletten", () => {
  it("D01: Namensschlüssel ignoriert Reihenfolge, Umlaute, Zusätze", () => {
    expect(freelancerKey("Wagner, Marcel")).toBe(freelancerKey("marcel  wagner (fiktiv)"));
    expect(freelancerKey("Jörg Müller")).toBe(freelancerKey("Joerg Mueller"));
    expect(freelancerKey("Anna Berg")).not.toBe(freelancerKey("Anna Bergmann"));
  });

  it("D02: Dublette wird gefunden, zusammengeführt; Einsätze ziehen um und lassen sich danach zusammenführen", async () => {
    env();
    const s = await ensureSeed();
    const ceo = await actorFor("clemens");
    const tag = Date.now().toString(36);
    // zwei Datensätze direkt anlegen (wie früher durch Import + Hand)
    const [a] = await db.insert(schema.freelancers).values({ workspaceId: s.workspaceId, displayName: `Dublo ${tag} Testfrau (fiktiv)`, mocoUserId: 990000 + Math.floor(Math.random() * 9999), createdBy: s.users.david }).returning();
    const [b] = await db.insert(schema.freelancers).values({ workspaceId: s.workspaceId, displayName: `Testfrau, Dublo ${tag}`, email: `dublo-${tag}@example.test`, phone: "0000", createdBy: s.users.david }).returning();
    const e1 = await engagementFor(a!.id, `D02a ${tag}`);
    const e2 = await engagementFor(b!.id, `D02b ${tag}`);
    const g = (await findFreelancerDuplicates(ceo)).find((x) => x.keep.id === a!.id)!;
    expect(g).toBeTruthy();
    expect(g.drop.map((d) => d.id)).toEqual([b!.id]);
    await expect(mergeFreelancers(await actorFor("nina"), a!.id, [b!.id])).rejects.toBeInstanceOf(ForbiddenError);
    const r = await mergeFreelancers(ceo, a!.id, [b!.id]);
    expect(r.removed).toBe(1);
    expect(r.engagementDuplicates).toBeGreaterThanOrEqual(1);
    const kept = (await db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, a!.id) }))!;
    expect(kept.email).toBe(`dublo-${tag}@example.test`);
    expect(kept.phone).toBe("0000");
    expect((await db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, b!.id) }))!.mergedIntoId).toBe(a!.id);
    expect((await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e2) }))!.freelancerId).toBe(a!.id);
    expect((await findFreelancerDuplicates(ceo)).some((x) => x.keep.id === a!.id)).toBe(false);
    const eg = (await findEngagementDuplicates(ceo)).find((x) => [x.keep.id, ...x.drop.map((d) => d.id)].includes(e1))!;
    expect(eg).toBeTruthy();
    await mergeEngagements(ceo, eg.keep.id, eg.drop.map((d) => d.id));
    expect((await findEngagementDuplicates(ceo)).some((x) => [x.keep.id, ...x.drop.map((d) => d.id)].includes(e1))).toBe(false);
  });

  it("D03: Automatischer Check – neuer Freelancer mit gleichem Namen oder E-Mail verwendet den bestehenden", async () => {
    env();
    const david = await actorFor("david");
    const tag = Date.now().toString(36);
    const f1 = await createFreelancer(david, { displayName: `Auto ${tag} Check (fiktiv)`, email: "" });
    const f2 = await createFreelancer(david, { displayName: `check, auto ${tag}`, email: `auto-${tag}@example.test` });
    expect(f2.id).toBe(f1.id);
    expect(f2.email).toBe(`auto-${tag}@example.test`);
    const f3 = await createFreelancer(david, { displayName: `Ganz Anders ${tag}`, email: `auto-${tag}@example.test` });
    expect(f3.id).toBe(f1.id);
  });
});
