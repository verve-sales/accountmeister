import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { FixtureSpClient, resetFixture } from "@/modules/sharepoint/client";
import { filesFor, folderName, setupSite, takeOverOfferFromSharePoint } from "@/modules/sharepoint/service";
import { signalRenewal } from "@/modules/engagements/care";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

describe("e61: Angebote aus SharePoint übernehmen", () => {
  it("S01: Angebot in einem Unterordner wird gefunden (passende Person zuerst) und setzt die Verlängerung auf „angeboten“", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    process.env.SHAREPOINT_MODE = "fixture";
    resetConfigCacheForTests();
    resetFixture();
    const s = await ensureSeed();
    const david = await actorFor("david");
    await setupSite(await actorFor("clemens"), { client: new FixtureSpClient() });
    const acc = (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, s.accountId) }))!;
    const tag = Date.now().toString(36);
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `S01 ${tag}`, needDescription: "Angebot aus SharePoint.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "Tester", resourceKind: "FREELANCER", newName: `Otto Offerte${tag} (fiktiv)`, ekRate: "80", vkRate: "100", desiredStart: plusDaysIso(todayIso(), -60), plannedEnd: plusDaysIso(todayIso(), 40) });
    await db.update(schema.engagements).set({ status: "AKTIV" }).where(eq(schema.engagements.id, q.engagement.id));
    const client = new FixtureSpClient() as unknown as import("@/modules/sharepoint/client").SpClient;
    const kunden = await client.driveOf((await client.libraries()).find((l) => l.name === "Kunden")!.id);
    const y = todayIso().slice(0, 4);
    await client.upload(kunden, [folderName(acc.name), "Angebote", y], `${y}-01-01_Angebot_Anderer.xlsx`, new ArrayBuffer(2));
    await client.upload(kunden, [folderName(acc.name), "Angebote", y, "Berater"], `${y}-11-20_Angebot_Offerte${tag}_VCA-M26-11_0042.xlsx`, new ArrayBuffer(2));
    const files = await filesFor({ accountName: acc.name, kinds: ["KUNDE_ANGEBOT"], personName: `Otto Offerte${tag}` }, { client });
    const list = files!.groups[0]!.files;
    expect(list[0]!.name).toMatch(new RegExp(`Berater › .*Offerte${tag}`));
    // Verlängerung „möglich“ mit Wunschende → Angebot übernehmen setzt sie auf „angeboten“
    const wish = plusDaysIso(todayIso(), 220);
    await signalRenewal(david, q.engagement.id, { signal: "MOEGLICH", wishEnd: wish });
    const r = await takeOverOfferFromSharePoint(david, q.engagement.id, list[0]!.value);
    expect(r.renewal).toBe(true);
    const ren = (await db.query.renewalDecisions.findFirst({ where: eq(schema.renewalDecisions.engagementId, q.engagement.id) }))!;
    expect(ren.status).toBe("ANGEBOTEN");
    expect(ren.offerNumber).toBe("VCA-M26-11_0042");
    expect(ren.proposedTo).toBe(wish);
  });
});
