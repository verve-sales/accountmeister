import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ForbiddenError } from "@/lib/errors";
import { loadActor, isReadOnlyActor, isReadOnlyFor, type Actor } from "@/modules/identity/actor";
import { assignRole } from "@/modules/governance/service";
import { getAccount } from "@/modules/accounts/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { getEngagementDetail, listEngagements } from "@/modules/engagements/service";
import { startRenewal } from "@/modules/engagements/care";
import { buildPortfolio, canLeaveDecision, leaveDecision } from "@/modules/portfolio/service";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { buildDashboard, resolveView } from "@/modules/dashboard/service";
import { acceptSuggestionAsChance, smartDump } from "@/modules/suggestions/service";
import { addComment, canComment } from "@/modules/comments/service";
import { createWorkItem } from "@/modules/work/service";
import { createSos } from "@/modules/sos/service";
import { loadSetupContext } from "@/modules/identity/authz";
import { analyzeSetup } from "@/modules/strategy/analysis";
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

  it("C04: gemischter Coach-Zugang – auf echten Kunden keine Kommentare, Vorgänge, SOS; im Testkunden schon; Start in der Coach-Sicht", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const admin = await actorFor("admin");
    const petra = await actorFor("petra");
    const coach0 = await makeCoach();
    const test = await createAccount(petra, { name: `Testkunde C04 ${Date.now()} (fiktiv)` });
    await assignRole(admin, { userId: coach0.userId, role: "BD", accountId: test.id }).catch(() => null);
    const flora = (await loadActor(coach0.userId))!;
    expect(isReadOnlyFor(flora, s.accountId)).toBe(true);
    expect(isReadOnlyFor(flora, test.id)).toBe(false);
    await expect(addComment(flora, { subjectType: "KUNDE", subjectId: s.accountId, body: "Hinweis vom Coach" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await canComment(flora, "KUNDE", s.accountId)).toBe(false);
    expect(await canComment(flora, "KUNDE", test.id)).toBe(true);
    await expect(createWorkItem(flora, { title: "Bitte anrufen", subjectType: "KUNDE", subjectId: s.accountId, target: "me" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createSos(flora, { accountId: s.accountId, kind: "LAGE_ENG", title: "Darf nicht", situation: "Coach darf kein SOS auslösen." })).rejects.toBeInstanceOf(ForbiddenError);
    const c = await addComment(flora, { subjectType: "KUNDE", subjectId: test.id, body: "Im Testkunden ausprobiert" });
    expect(c.comment.id).toBeTruthy();
    const { view, available } = await resolveView(flora, null);
    expect(available).toContain("COACH");
    expect(view).toBe("COACH");
  });

  it("C05: Beobachtung aus der KI mit einem Klick als Chance übernehmen; laufender Einsatz ohne Auftrag zählt als gestartet", async () => {
    process.env.AI_PROVIDER = "test";
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const r = await smartDump(david, { setupId: s.setupId, text: "Gespräch mit der Teamleitung: Das Plattformteam plant im Frühjahr eine Lasttest-Offensive und sucht dafür Performance-Tester." });
    expect(r.created).toBeGreaterThan(0);
    const sugg = await db.query.suggestions.findFirst({ where: and(eq(schema.suggestions.setupId, s.setupId), eq(schema.suggestions.type, "BEOBACHTUNG"), eq(schema.suggestions.status, "NEU")) });
    expect(sugg).toBeTruthy();
    const res = await acceptSuggestionAsChance(david, sugg!.id, { version: sugg!.version, chanceTitle: "Performance-Tester Lasttest-Offensive" });
    expect(res.opportunity.status).toBe("IN_KLAERUNG");
    expect(res.opportunity.title).toBe("Performance-Tester Lasttest-Offensive");
    const sig = await db.query.signals.findFirst({ where: eq(schema.signals.id, res.acceptedObjectId) });
    expect(sig?.opportunityId).toBe(res.opportunity.id);
    // Schnellbesetzung ohne Auftrag, Einsatz aktiv → Setup-Stufe „gestartet“
    const setupName = `Stufe ${Date.now()}`;
    const st = await createSetup(david, { accountId: s.accountId, name: setupName, bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
    const opp = await createOpportunity(david, { setupId: st.id, title: "Einsatz ohne Auftrag", needDescription: "Läuft bereits beim Kunden.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "Tester:in", resourceKind: "FREELANCER", newName: `Ina Ohneauftrag ${Date.now()} (fiktiv)`, ekRate: "700", vkRate: "900", desiredStart: plusDaysIso(todayIso(), -10), plannedEnd: plusDaysIso(todayIso(), 100) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -10) }).where(eq(schema.engagements.id, q.engagement.id));
    const ctx = (await loadSetupContext(david, st.id))!;
    const a = await analyzeSetup(david, ctx);
    expect(a.stage).toBe("GESTARTET");
  });
});

