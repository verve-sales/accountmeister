import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ForbiddenError } from "@/lib/errors";
import { loadActor, isReadOnlyActor, type Actor } from "@/modules/identity/actor";
import { assignRole } from "@/modules/governance/service";
import { getAccount } from "@/modules/accounts/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { getEngagementDetail, listEngagements } from "@/modules/engagements/service";
import { startRenewal } from "@/modules/engagements/care";
import { buildPortfolio, canLeaveDecision, leaveDecision } from "@/modules/portfolio/service";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { buildDashboard } from "@/modules/dashboard/service";
import { smartDump } from "@/modules/suggestions/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

async function makeCoach(accountId?: string): Promise<Actor> {
  const s = await ensureSeed();
  const [u] = await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: `coach-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}@extern.example`, displayName: "Flora Coach (fiktiv)" }).returning();
  await assignRole(await actorFor("admin"), { userId: u!.id, role: "COACH", accountId: accountId ?? "" });
  return (await loadActor(u!.id))!;
}

describe("Etappe 33: Rolle Coach (nur lesen)", () => {
  it("C01: kundenbezogener Coach sieht Kunde, Setups, Einsätze und Meine BDs – ändert nichts", async () => {
    process.env.AI_PROVIDER = "test";
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const coach = await makeCoach(s.accountId);
    expect(isReadOnlyActor(coach)).toBe(true);
    expect((await getAccount(coach, s.accountId)).id).toBe(s.accountId);
    const d = await buildDashboard(coach, null);
    expect(d?.view).toBe("COACH");
    expect(d?.accounts.some((a) => a.accountId === s.accountId)).toBe(true);
    const p = await buildPortfolio(coach);
    expect(p.rows.some((r) => r.accountId === s.accountId)).toBe(true);
    await expect(leaveDecision(coach, s.accountId, { text: "Bitte anrufen" })).rejects.toBeInstanceOf(ForbiddenError);
    // Einsatz lesen, aber nicht verlängern
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `Coach-Sicht ${Date.now()}`, needDescription: "Testfall Coach.", kind: "VERVE_EXPERTE", ownerUserId: david.userId });
    const r = await quickFill(david, opp.id, { title: "Testrolle", resourceKind: "INTERN", internalUserId: david.userId, desiredStart: todayIso(), plannedEnd: plusDaysIso(todayIso(), 60) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: todayIso() }).where(eq(schema.engagements.id, r.engagement.id));
    const det = await getEngagementDetail(coach, r.engagement.id);
    expect(det.access).toMatchObject({ readOnly: true, manage: false, care: false, commercial: false });
    expect((await listEngagements(coach)).items.some((x) => x.id === r.engagement.id)).toBe(true);
    await expect(startRenewal(coach, r.engagement.id, { newEnd: plusDaysIso(todayIso(), 200) })).rejects.toBeInstanceOf(ForbiddenError);
    // Keine Eingaben in Setups
    await expect(smartDump(coach, { setupId: s.setupId, text: "Neue Information vom Kunden, bitte aufnehmen." })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createOpportunity(coach, { setupId: s.setupId, title: "Darf nicht", needDescription: "Coach legt nichts an.", kind: "VERVE_EXPERTE" })).rejects.toThrow();
  });

  it("C02: Coach für einen Kunden sieht andere Kunden nicht", async () => {
    const s = await ensureSeed();
    const lars = await actorFor("lars");
    const other = (await db.query.accounts.findMany({ where: eq(schema.accounts.workspaceId, s.workspaceId) })).find((a) => a.id !== s.accountId && a.responsibleBdUserId === lars.userId);
    const coach = await makeCoach(s.accountId);
    if (other) await expect(getAccount(coach, other.id)).rejects.toThrow();
    const p = await buildPortfolio(coach);
    expect(p.rows.every((r) => r.accountId === s.accountId)).toBe(true);
  });

  it("C03: Coach auf echten Kunden + BD/Principal auf eigenem Testkunden: experimentiert im Testkunden, echte Kunden bleiben nur lesbar", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const admin = await actorFor("admin");
    const petra = await actorFor("petra");
    const coach0 = await makeCoach(s.accountId);
    const test = await createAccount(petra, { name: `Testkunde Coaching ${Date.now()} (fiktiv)` });
    await assignRole(admin, { userId: coach0.userId, role: "BD", accountId: test.id });
    await assignRole(admin, { userId: coach0.userId, role: "PRINCIPAL", accountId: test.id });
    await db.update(schema.accounts).set({ responsibleBdUserId: coach0.userId }).where(eq(schema.accounts.id, test.id));
    const flora = (await loadActor(coach0.userId))!;
    expect(isReadOnlyActor(flora)).toBe(false);
    const setup = await createSetup(flora, { accountId: test.id, name: "Spielwiese" });
    const r = await smartDump(flora, { setupId: setup.id, text: "Frau Muster (fiktiv) sagt, ab Q1 werden zwei Tester gebraucht; Budget kommt aus dem Programm Nord." });
    expect(r.created + r.skipped + r.rejected).toBeGreaterThanOrEqual(0);
    // Echter Kunde: weiter nur lesen
    await expect(smartDump(flora, { setupId: s.setupId, text: "Darf hier nichts einspielen, nur lesen." })).rejects.toBeInstanceOf(ForbiddenError);
    expect(canLeaveDecision(flora, s.accountId)).toBe(false);
    expect(canLeaveDecision(flora, test.id)).toBe(true);
    await expect(leaveDecision(flora, s.accountId, { text: "Bitte anrufen" })).rejects.toBeInstanceOf(ForbiddenError);
    // Meine BDs zeigt beide Kunden
    const p = await buildPortfolio(flora);
    expect(p.rows.some((x) => x.accountId === s.accountId)).toBe(true);
    expect(p.rows.some((x) => x.accountId === test.id)).toBe(true);
  });
});
