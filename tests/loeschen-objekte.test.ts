import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createOpportunity } from "@/modules/opportunities/service";
import { createSetup } from "@/modules/setups/service";
import { quickFill } from "@/modules/staffing/service";
import { changeEngagementStatus } from "@/modules/engagements/service";
import { deleteEngagementPermanently, deleteOpportunityPermanently, deleteSetupPermanently, previewOpportunityDeletion, previewSetupDeletion } from "@/modules/deletion/objects";
import { actorFor, ensureSeed } from "./helpers";

describe("Endgültiges Löschen: Einsatz, Chance, Setup (rekursiv)", () => {
  it("Einsatz löschen nimmt Kandidatur/Position/Auftrag mit; Chance bleibt; Statuswechsel führt den Auftrag mit", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const opp = await createOpportunity(david, { setupId: s.setupId, title: "Löschfall Einsatz", needDescription: "Bedarf für den Löschfall im Plattformteam.", kind: "VERVE_EXPERTE", ownerUserId: david.userId });
    const r = await quickFill(david, opp.id, { title: "Löschfall", resourceKind: "INTERN", internalUserId: s.users.nina, desiredStart: "2026-09-01", endOpen: "on" });
    // Auftrag anlegen und verknüpfen wie beim Import
    const [order] = await db.insert(schema.orders).values({ workspaceId: s.workspaceId, opportunityId: opp.id, status: "BEAUFTRAGUNG_BESTAETIGT", confirmedAt: new Date(), confirmedBy: david.userId, engagementStatus: "GESTARTET", startedAt: new Date(), createdBy: david.userId }).returning();
    await db.update(schema.engagements).set({ orderId: order!.id, status: "AKTIV", actualStart: "2026-09-01" }).where(eq(schema.engagements.id, r.engagement.id));
    const e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, r.engagement.id) }))!;
    const ended = await changeEngagementStatus(david, e.id, { version: e.version, status: "ENDET", actualDate: "2026-10-01" });
    expect(ended.status).toBe("ENDET");
    expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, order!.id) }))?.engagementStatus).toBe("BEENDET");
    // Rechte und Pflichtangaben
    await expect(deleteEngagementPermanently(await actorFor("nina"), e.id, { reason: "Testfall Löschen", confirm: "on" })).rejects.toThrow();
    await expect(deleteEngagementPermanently(david, e.id, { reason: "kurz", confirm: "on" })).rejects.toBeInstanceOf(ValidationError);
    await expect(deleteEngagementPermanently(david, e.id, { reason: "Testfall Löschen Einsatz", confirm: "" })).rejects.toBeInstanceOf(ValidationError);
    const rep = await deleteEngagementPermanently(david, e.id, { reason: "Testfall Löschen Einsatz", confirm: "on" });
    expect(rep.deleted.engagements).toBe(1);
    expect(await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e.id) })).toBeUndefined();
    expect(await db.query.candidacies.findFirst({ where: eq(schema.candidacies.id, r.candidacy.id) })).toBeUndefined();
    expect(await db.query.staffingPositions.findFirst({ where: eq(schema.staffingPositions.id, r.position.id) })).toBeUndefined();
    expect(await db.query.orders.findFirst({ where: eq(schema.orders.id, order!.id) })).toBeUndefined();
    expect(await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, opp.id) })).toBeTruthy();
  });

  it("Chance löschen nimmt Position/Einsatz mit, löst Beobachtungen; Setup löschen rekursiv", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const petra = await actorFor("petra");
    const setup = await createSetup(david, { accountId: s.accountId, name: "Löschfall Setup", bdUserId: david.userId });
    const opp = await createOpportunity(david, { setupId: setup.id, title: "Löschfall Chance", needDescription: "Bedarf für den Löschfall Chance.", kind: "FREELANCER_EXPERTE", ownerUserId: david.userId });
    const r = await quickFill(david, opp.id, { title: "Löschfall", resourceKind: "FREELANCER", newName: "Lösch Freelancer (fiktiv)", ekRate: "700", desiredStart: "2026-09-01", endOpen: "on" });
    const [sig] = await db.insert(schema.signals).values({ workspaceId: s.workspaceId, setupId: setup.id, observation: "Beobachtung zur Chance, soll überleben.", opportunityId: opp.id, createdBy: david.userId }).returning();
    const pv = await previewOpportunityDeletion(david, opp.id);
    expect(pv.engagements).toBe(1);
    await expect(deleteOpportunityPermanently(await actorFor("nina"), opp.id, { reason: "Testfall Löschen Chance", confirm: "on" })).rejects.toBeInstanceOf(ForbiddenError);
    const rep = await deleteOpportunityPermanently(david, opp.id, { reason: "Testfall Löschen Chance", confirm: "on" });
    expect(rep.deleted.opportunities).toBe(1);
    expect(await db.query.engagements.findFirst({ where: eq(schema.engagements.id, r.engagement.id) })).toBeUndefined();
    const sigAfter = await db.query.signals.findFirst({ where: eq(schema.signals.id, sig!.id) });
    expect(sigAfter).toBeTruthy();
    expect(sigAfter?.opportunityId).toBeNull();
    // Setup rekursiv
    const opp2 = await createOpportunity(david, { setupId: setup.id, title: "Löschfall Chance 2", needDescription: "Noch ein Bedarf für den Löschfall.", kind: "VERVE_EXPERTE", ownerUserId: david.userId });
    await quickFill(david, opp2.id, { title: "Löschfall 2", resourceKind: "INTERN", internalUserId: s.users.nina, desiredStart: "2026-09-01", endOpen: "on" });
    const spv = await previewSetupDeletion(petra, setup.id);
    expect(spv.opportunities).toBe(1);
    expect(spv.engagements).toBe(1);
    expect(spv.signals).toBe(1);
    const srep = await deleteSetupPermanently(petra, setup.id, { reason: "Testfall Löschen Setup rekursiv", confirm: "on" });
    expect(srep.deleted.project_setups).toBe(1);
    expect(srep.deleted.engagements).toBe(1);
    expect(await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, setup.id) })).toBeUndefined();
    expect(await db.query.signals.findFirst({ where: eq(schema.signals.id, sig!.id) })).toBeUndefined();
    expect(await db.query.accounts.findFirst({ where: eq(schema.accounts.id, s.accountId) })).toBeTruthy();
  });
});
