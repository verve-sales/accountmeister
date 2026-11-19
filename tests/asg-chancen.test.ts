import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createOpportunity } from "@/modules/opportunities/service";
import { addCandidacy, createPosition, quickFill } from "@/modules/staffing/service";
import { asgOpportunities, asgOverview } from "@/modules/assignments/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

describe("e55: Chancen in der Zeitleiste des Assignmentmanagers", () => {
  it("Z01: Kandidatur erscheint mit Phase; Überschneidung mit laufendem Einsatz wird markiert; Position ohne Person gezählt", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const ceo = await actorFor("clemens");
    const tag = Date.now().toString(36);
    // laufender Einsatz eines Freelancers bis +60 Tage
    const o1 = await createOpportunity(david, { setupId: s.setupId, title: `Z01 Einsatz ${tag}`, needDescription: "Testbedarf Zeitleiste.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, o1.id, { title: "Tester", resourceKind: "FREELANCER", newName: `Zora Zeit ${tag} (fiktiv)`, ekRate: "600", vkRate: "900", desiredStart: plusDaysIso(todayIso(), -30), plannedEnd: plusDaysIso(todayIso(), 60) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -30) }).where(eq(schema.engagements.id, q.engagement.id));
    // neue Chance mit Profil verschickt, Start in 30 Tagen → überschneidet sich
    const o2 = await createOpportunity(david, { setupId: s.setupId, title: `Z01 Chance ${tag}`, needDescription: "Neuer Bedarf beim Kunden.", kind: "FREELANCER_EXPERTE" });
    await db.update(schema.opportunities).set({ status: "PROFIL_ANGEBOT_VORGESTELLT" }).where(eq(schema.opportunities.id, o2.id));
    const pos = await createPosition(david, o2.id, { title: "Test Lead", resourceKind: "FREELANCER", desiredStart: plusDaysIso(todayIso(), 30), plannedEnd: plusDaysIso(todayIso(), 150), endOpen: "false" });
    await addCandidacy(david, pos.id, { freelancerId: q.engagement.freelancerId! });
    await createPosition(david, o2.id, { title: "Zweite Stelle", resourceKind: "FREELANCER", desiredStart: "", plannedEnd: "", endOpen: "false" });
    const ov = await asgOverview(ceo);
    const r = await asgOpportunities(ceo, ov.engagements);
    const it = r.items.find((x) => x.opportunityId === o2.id)!;
    expect(it.phase).toBe("ANGEBOT");
    expect(it.person).toMatch(/Zora Zeit/);
    expect(it.conflict).toMatch(/Einsatz/);
    expect(it.estimated).toBe(false);
    expect(r.withoutPerson).toBeGreaterThanOrEqual(1);
    // lose Anfrage → Phase „Anfrage“
    await db.update(schema.opportunities).set({ status: "IN_KLAERUNG" }).where(eq(schema.opportunities.id, o2.id));
    expect((await asgOpportunities(ceo, ov.engagements)).items.find((x) => x.opportunityId === o2.id)!.phase).toBe("ANFRAGE");
    await expect(asgOpportunities(david, ov.engagements)).rejects.toThrow();
  });
});
