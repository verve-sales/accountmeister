import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { loadActor } from "@/modules/identity/actor";
import { assignRole } from "@/modules/governance/service";
import { endOrder, ensureOrdersEnded, getHealth, recordExistingEngagement, renewalTriggerDate, saveHealthAnswer, snapshotHealth, updateOrderDates } from "@/modules/health/service";
import { ensureRenewalRuns, listRenewals } from "@/modules/health/renewal";
import { quickFill, topCandidatesForOpportunities } from "@/modules/staffing/service";
import { actorFor, ensureSeed } from "./helpers";

const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

describe("Etappe 23: Kunden-Health-Check und Verlängerungsregel", () => {
  it("Auslöser: Frist − 14 Tage, sonst Ende − 8 Wochen", () => {
    expect(renewalTriggerDate({ plannedEnd: "2027-03-31", renewalDeadline: "2027-02-28" })).toBe("2027-02-14");
    expect(renewalTriggerDate({ plannedEnd: "2027-03-31", renewalDeadline: null })).toBe("2027-02-03");
    expect(renewalTriggerDate({ plannedEnd: null, renewalDeadline: null })).toBeNull();
  });

  it("Unbekanntes senkt die Datenlage, nicht den Score; Interview-Antworten schließen die Lücken", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const before = await getHealth(david, s.accountId);
    expect(before.coverage).toBeLessThan(100);
    const keys = before.questions.map((q) => q.key);
    expect(keys).toEqual(expect.arrayContaining(["FEEDBACK", "LISTING", "RISKS"]));
    expect(before.dimensions.find((d) => d.key === "ZUFRIEDENHEIT")!.known).toBe(false);

    await saveHealthAnswer(david, s.accountId, { key: "FEEDBACK", tone: "POSITIV", date: inDays(-10), note: "Sehr zufrieden mit dem Testteam." });
    await saveHealthAnswer(david, s.accountId, { key: "LISTING", status: "RAHMENVERTRAG", validUntil: inDays(400) });
    await saveHealthAnswer(david, s.accountId, { key: "RISKS", items: [] });
    const after = await getHealth(david, s.accountId);
    expect(after.coverage).toBeGreaterThan(before.coverage);
    expect(after.score).not.toBeNull();
    expect(after.questions.map((q) => q.key)).not.toContain("FEEDBACK");
    expect(after.dimensions.find((d) => d.key === "LISTUNG")!.points).toBe(15);
    await expect(saveHealthAnswer(david, s.accountId, { key: "FEEDBACK", tone: "SUPER" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("Bestandseinsatz nachtragen (nur mit Entscheidungsrecht), Daten pflegen, Verlängerung startet automatisch als Vorschlag", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const admin = await actorFor("admin");
    const [u] = await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: `ops-h-${Date.now().toString(36)}@verve.example`, displayName: "Ops Health" }).returning();
    await assignRole(admin, { userId: u!.id, role: "SALES_OPS" });
    const ops = (await loadActor(u!.id))!;
    const input = { setupId: s.setupId, title: "Testmanagement Kernbanksystem", kind: "VERVE_EXPERTE", headcount: "2", plannedStart: inDays(-200), plannedEnd: inDays(20), evidenceText: "Bestellung 4711 vom Januar, läuft seit Februar." };
    await expect(recordExistingEngagement(ops, s.accountId, input)).rejects.toBeInstanceOf(ForbiddenError);
    const order = await recordExistingEngagement(david, s.accountId, input);
    expect(order.engagementStatus).toBe("GESTARTET");

    const h = await getHealth(david, s.accountId);
    expect(h.engagements.map((e) => e.orderId)).toContain(order.id);
    expect(h.dimensions.find((d) => d.key === "EINSAETZE")!.reasons.join(" ")).toMatch(/8 Wochen/);

    await expect(updateOrderDates(david, order.id, { version: order.version, plannedEnd: inDays(20), renewalDeadline: inDays(30) })).rejects.toBeInstanceOf(ValidationError);

    // Eskalation vor Start des Vorgehens
    let ren = await listRenewals([s.accountId]);
    expect(ren.find((r) => r.orderId === order.id)?.escalate).toBe(true);

    expect(await ensureRenewalRuns(david)).toBe(1);
    expect(await ensureRenewalRuns(david)).toBe(0); // je Einsatz genau einmal
    const run = await db.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.opportunityId, order.opportunityId) });
    expect(run?.playbookName).toMatch(/Verlängerung/);
    const step1 = await db.query.playbookRunSteps.findFirst({ where: and(eq(schema.playbookRunSteps.runId, run!.id), eq(schema.playbookRunSteps.position, 1)) });
    const a = await db.query.actions.findFirst({ where: eq(schema.actions.id, step1!.actionId!) });
    expect(a?.status).toBe("VORGESCHLAGEN"); // Vorschlag, den der BD annimmt
    expect(a?.ownerUserId).toBe(david.userId);
    ren = await listRenewals([s.accountId]);
    expect(ren.find((r) => r.orderId === order.id)?.runStatus).toBe("LAEUFT");
  });

  it("deutlicher Rückgang der Sattelfestigkeit erzeugt eine Aufgabe für den BD", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    await saveHealthAnswer(david, s.accountId, { key: "FEEDBACK", tone: "POSITIV", date: inDays(-5) });
    await saveHealthAnswer(david, s.accountId, { key: "LISTING", status: "RAHMENVERTRAG" });
    await saveHealthAnswer(david, s.accountId, { key: "RISKS", items: [] });
    const high = await snapshotHealth(david, s.accountId);
    await saveHealthAnswer(david, s.accountId, { key: "FEEDBACK", tone: "KRITISCH", date: inDays(-1) });
    const low = await saveHealthAnswer(david, s.accountId, { key: "RISKS", items: ["BUDGETKUERZUNG", "WETTBEWERBER", "FUERSPRECHER_WEG"] });
    expect((high.health.score ?? 0) - (low.health.score ?? 0)).toBeGreaterThan(10);
    const drops = await db.query.standardTasks.findMany({ where: and(eq(schema.standardTasks.accountId, s.accountId), eq(schema.standardTasks.kind, "HEALTH_DROP")) });
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  it("Beendete Einsätze verschwinden: Aufräumregel beendet Aufträge mit lange überschrittenem Ende; „Beendet“-Knopf beendet Auftrag samt Einsatzakte", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    // Altlast: Auftrag gestartet, Ende vor 99 Tagen, keine Einsatzakte
    const old = await recordExistingEngagement(david, s.accountId, { setupId: s.setupId, title: `Altlast ${Date.now()}`, kind: "VERVE_EXPERTE", plannedStart: inDays(-300), plannedEnd: inDays(-99), evidenceText: "Bestellung aus dem Vorjahr." });
    expect(old.engagementStatus).toBe("GESTARTET");
    expect(await ensureOrdersEnded(s.workspaceId)).toBeGreaterThanOrEqual(1);
    expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, old.id) }))?.engagementStatus).toBe("BEENDET");
    expect((await getHealth(david, s.accountId)).engagements.map((e) => e.orderId)).not.toContain(old.id);
    expect((await listRenewals([s.accountId])).some((r) => r.orderId === old.id)).toBe(false);
    // Laufender Auftrag (Ende in 20 Tagen) bleibt – und lässt sich per Knopf beenden
    const cur = await recordExistingEngagement(david, s.accountId, { setupId: s.setupId, title: `Läuft noch ${Date.now()}`, kind: "VERVE_EXPERTE", plannedStart: inDays(-100), plannedEnd: inDays(20), evidenceText: "Bestellung 4712." });
    expect(await ensureOrdersEnded(s.workspaceId)).toBe(0);
    const r = await endOrder(david, cur.id, { version: cur.version, endDate: inDays(-1), reason: "Projekt vorzeitig beendet" });
    expect(r.end).toBe(inDays(-1));
    expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, cur.id) }))?.engagementStatus).toBe("BEENDET");
    expect((await getHealth(david, s.accountId)).engagements.map((e) => e.orderId)).not.toContain(cur.id);
  });

  it("Konvertierte Chance ohne Person (im Health-Check nachgetragen): Person hinterlegen legt Einsatz an, verknüpft ihn mit dem Auftrag und setzt ihn aktiv", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    const s = await ensureSeed();
    const david = await actorFor("david");
    const order = await recordExistingEngagement(david, s.accountId, { setupId: s.setupId, title: `UX Unterstützung ${Date.now()}`, kind: "VERVE_EXPERTE", plannedStart: inDays(-60), plannedEnd: inDays(80), evidenceText: "Bestellung UX, 50 %." });
    const r = await quickFill(david, order.opportunityId, { title: "UX Unterstützung", resourceKind: "INTERN", internalUserId: david.userId, desiredStart: "", plannedEnd: "", endOpen: "false" });
    const e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, r.engagement.id) }))!;
    expect(e.orderId).toBe(order.id);
    expect(e.status).toBe("AKTIV");
    expect(e.plannedEnd).toBe(inDays(80));
    expect((await topCandidatesForOpportunities([order.opportunityId])).get(order.opportunityId)).toEqual({ name: expect.stringMatching(/David.*\(intern\)/), status: "BESETZT" });
    expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, order.id) }))?.consultantUserId).toBe(david.userId);
  });
});
