import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { decideRenewal, listRenewalCards, startRenewal } from "@/modules/engagements/care";
import { ensureRenewalRuns } from "@/modules/health/renewal";
import { recordExistingEngagement } from "@/modules/health/service";
import { listPlaybooks, listRuns, startPlaybookRun } from "@/modules/playbooks/service";
import { acknowledgeHandover, getHandover, listHandovers } from "@/modules/conversion/handover";
import { ensureBackofficeTeam } from "@/modules/conversion/profile";
import { listNotifications, markSeen, notify, unreadCount } from "@/modules/notifications/service";
import { createWorkItem, generateOverdueNotifications } from "@/modules/work/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

function env(automation: "on" | "off" = "off") {
  process.env.FEATURE_BESETZUNG = "true";
  process.env.MOCO_MODE = "off";
  process.env.RENEWAL_AUTOMATION = automation;
  resetConfigCacheForTests();
}
const iso = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

describe("e44: Namen nach vorn, Verlängerung entschlackt, Benachrichtigungen ohne Rauschen", () => {
  it("E01: Verlängerung in einem Schritt mit neuer Bestellnummer – Nummer am Einsatz und in der Übergabe, keine Bitte um Bestätigung", async () => {
    env();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const name = `Vera Verlängert ${Date.now().toString(36)} (fiktiv)`;
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `E44 Verlängerung ${Date.now()}`, needDescription: "Laufender Einsatz.", kind: "FREELANCER_EXPERTE", ownerUserId: david.userId });
    const q = await quickFill(david, opp.id, { title: "Scrum Master", resourceKind: "FREELANCER", newName: name, ekRate: "600", vkRate: "960", desiredStart: plusDaysIso(todayIso(), -30), plannedEnd: plusDaysIso(todayIso(), 40) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -30), mocoProjectId: 990044 }).where(eq(schema.engagements.id, q.engagement.id));
    const team = await ensureBackofficeTeam(s.workspaceId);
    await db.insert(schema.teamMembers).values({ teamId: team.id, userId: s.users.admin, role: "MITGLIED" }).onConflictDoNothing();
    const before = (await listNotifications(await actorFor("petra"), 500)).length;
    const newEnd = plusDaysIso(todayIso(), 220);
    // der BD darf selbst entscheiden: anstoßen (ohne Bitte um Bestätigung) und bestätigen in einem Zug
    await startRenewal(david, q.engagement.id, { newEnd, conditions: "UNVERAENDERT" }, { direct: true });
    const r = await decideRenewal(david, q.engagement.id, { decision: "BESTAETIGEN", orderReference: "4500777001" });
    expect(r.decision.status).toBe("BESTAETIGT");
    const e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, q.engagement.id) }))!;
    expect(e.plannedEnd).toBe(newEnd);
    expect(e.orderReference).toBe("4500777001");
    expect((await listNotifications(await actorFor("petra"), 500)).length).toBe(before); // Principal bekommt keine „bitte bestätigen“-Meldung
    const admin = await actorFor("admin");
    const h = (await db.query.backofficeHandovers.findFirst({ where: and(eq(schema.backofficeHandovers.engagementId, e.id), eq(schema.backofficeHandovers.kind, "VERLAENGERT")) }))!;
    expect((await listHandovers(admin)).some((x) => x.id === h.id)).toBe(true);
    const hv = await getHandover(admin, h.id);
    expect(hv.payload.bestellnummer).toBe("4500777001");
    expect(hv.payload.hinweis).toMatch(/Neue Bestellnummer: 4500777001/);
    // Hinweis ans Backoffice nennt Person und Kunde; mit der Quittung ist er für alle erledigt
    const note = (await listNotifications(admin, 500)).find((n) => n.link === `/uebergaben/${h.id}`)!;
    expect(note.title).toContain(name);
    expect(note.readAt).toBeNull();
    await acknowledgeHandover(admin, h.id, {});
    expect((await listNotifications(admin, 500)).find((n) => n.id === note.id)!.readAt).not.toBeNull();
    // die Karte kennt, wer selbst bestätigen darf
    const opp2 = await createOpportunity(david, { setupId: s.setupId, title: `E44 Karte ${Date.now()}`, needDescription: "Laufender Einsatz.", kind: "FREELANCER_EXPERTE", ownerUserId: david.userId });
    const q2 = await quickFill(david, opp2.id, { title: "Tester", resourceKind: "FREELANCER", newName: `Karl Karte ${Date.now().toString(36)} (fiktiv)`, ekRate: "500", vkRate: "800", desiredStart: plusDaysIso(todayIso(), -30), plannedEnd: plusDaysIso(todayIso(), 40) });
    await db.update(schema.engagements).set({ status: "AKTIV" }).where(eq(schema.engagements.id, q2.engagement.id));
    await db.insert(schema.renewalDecisions).values({ workspaceId: s.workspaceId, engagementId: q2.engagement.id, status: "ZU_KLAEREN", createdBy: david.userId });
    const card = (await listRenewalCards(david)).find((c) => c.engagementId === q2.engagement.id)!;
    expect(card.mode).toBe("ANSTOSSEN");
    expect(card.canDecide).toBe(true);
  });

  it("E02: Verlängerungs-Automatik aus – kein Ping, kein Vorgehen; unberührte Reste werden einmalig zurückgestellt, von Hand Gestartetes bleibt", async () => {
    env("on");
    const s = await ensureSeed();
    const david = await actorFor("david");
    const order = await recordExistingEngagement(david, s.accountId, { setupId: s.setupId, title: `E44 Automatik ${Date.now().toString(36)}`, plannedEnd: iso(40) });
    expect(await ensureRenewalRuns(david)).toBeGreaterThanOrEqual(1);
    const auto = (await db.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.opportunityId, order.opportunityId) }))!;
    expect(auto.status).toBe("AKTIV");
    const ping = (await db.query.standardTasks.findFirst({ where: eq(schema.standardTasks.key, `renewal-ping:order:${order.id}`) }))!;
    expect((await db.query.actions.findFirst({ where: eq(schema.actions.id, ping.actionId!) }))!.status).toBe("VORGESCHLAGEN");
    // von Hand gestartetes Vorgehen an einer anderen Chance
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `E44 Hand ${Date.now()}`, needDescription: "Von Hand gestartetes Vorgehen.", kind: "FREELANCER_EXPERTE", ownerUserId: david.userId });
    const pb = (await listPlaybooks(david, {})).find((p) => p.code === "VERLAENGERUNG")!;
    const manual = await startPlaybookRun(david, { playbookId: pb.id, setupId: s.setupId, opportunityId: opp.id });

    env("off");
    const order2 = await recordExistingEngagement(david, s.accountId, { setupId: s.setupId, title: `E44 ohne Automatik ${Date.now().toString(36)}`, plannedEnd: iso(40) });
    expect(await ensureRenewalRuns(david)).toBe(0);
    expect(await db.query.standardTasks.findFirst({ where: eq(schema.standardTasks.key, `renewal-ping:order:${order2.id}`) })).toBeUndefined();
    expect(await db.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.opportunityId, order2.opportunityId) })).toBeUndefined();
    // Reste: Ping verworfen, automatisches Vorgehen zurückgestellt (wieder aufnehmbar), das von Hand gestartete läuft weiter
    expect((await db.query.actions.findFirst({ where: eq(schema.actions.id, ping.actionId!) }))!.status).toBe("VERWORFEN");
    const after = (await db.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.id, auto.id) }))!;
    expect(after.status).toBe("ZURUECKGESTELLT");
    expect(after.closedReason).toMatch(/Automatik abgeschaltet/);
    expect((await db.query.playbookRuns.findFirst({ where: eq(schema.playbookRuns.id, manual.id) }))!.status).toBe("AKTIV");
    // die Aufgabe eines Vorgehens nennt die Person im Einsatz, die Liste auch
    const name = `Paula Person ${Date.now().toString(36)} (fiktiv)`;
    const opp3 = await createOpportunity(david, { setupId: s.setupId, title: `E44 Name ${Date.now()}`, needDescription: "Chance mit einer Person im Einsatz.", kind: "FREELANCER_EXPERTE", ownerUserId: david.userId });
    await quickFill(david, opp3.id, { title: "Analystin", resourceKind: "FREELANCER", newName: name, ekRate: "500", vkRate: "800", desiredStart: plusDaysIso(todayIso(), -10), plannedEnd: plusDaysIso(todayIso(), 50) });
    const run = await startPlaybookRun(david, { playbookId: pb.id, setupId: s.setupId, opportunityId: opp3.id });
    const view = (await listRuns(david, { opportunityId: opp3.id })).find((r) => r.id === run.id)!;
    expect(view.persons).toEqual([name]);
    const step = view.steps.find((x) => x.status === "OFFEN")!;
    expect((await db.query.actions.findFirst({ where: eq(schema.actions.id, step.actionId!) }))!.title.startsWith(`${name}: `)).toBe(true);
  });

  it("E03: Glocke zählt nur, was eine Handlung verlangt; Überfälliges wird einmal gemeldet; Öffnen der Seite und Erledigen markieren gelesen", async () => {
    env();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    await db.update(schema.notifications).set({ readAt: new Date() }).where(eq(schema.notifications.userId, nina.userId));
    expect(await unreadCount(nina)).toBe(0);
    await notify(db, { workspaceId: s.workspaceId, userIds: [nina.userId], kind: "KOMMENTAR", title: "Zur Kenntnis (Test)", link: "/setups/x", actorUserId: david.userId });
    await notify(db, { workspaceId: s.workspaceId, userIds: [nina.userId], kind: "ERLEDIGT", title: "Erledigt (Test)", link: "/setups/x", actorUserId: david.userId });
    expect(await unreadCount(nina)).toBe(0);
    await notify(db, { workspaceId: s.workspaceId, userIds: [nina.userId], kind: "ZUGEWIESEN", title: "Bitte tun (Test)", link: "/einsaetze/e44-test#verlaengerung", actorUserId: david.userId });
    expect(await unreadCount(nina)).toBe(1);
    await markSeen(nina, "/einsaetze/e44-test"); // Seite geöffnet → Hinweis mit Sprungmarke ist gelesen
    expect(await unreadCount(nina)).toBe(0);
    // überfälliger Vorgang: ein Hinweis, auch bei mehrfachem Lauf; mit dem Abschluss ist er für alle erledigt
    const item = await createWorkItem(david, { title: `E44 überfällig ${Date.now()}`, target: nina.userId, dueDate: plusDaysIso(todayIso(), 3) });
    await db.update(schema.workItems).set({ dueDate: plusDaysIso(todayIso(), -2) }).where(eq(schema.workItems.id, item.id));
    await generateOverdueNotifications(s.workspaceId);
    await generateOverdueNotifications(s.workspaceId);
    const mine = (await listNotifications(nina, 500)).filter((n) => n.link === `/vorgaenge/${item.id}` && n.kind === "UEBERFAELLIG");
    expect(mine).toHaveLength(1);
    expect(await unreadCount(nina)).toBeGreaterThanOrEqual(1);
    await db.update(schema.notifications).set({ createdAt: new Date(Date.now() - 86400000) }).where(and(eq(schema.notifications.userId, nina.userId), eq(schema.notifications.link, `/vorgaenge/${item.id}`)));
    await generateOverdueNotifications(s.workspaceId); // am nächsten Tag: kein zweiter Hinweis
    expect((await listNotifications(nina, 500)).filter((n) => n.link === `/vorgaenge/${item.id}` && n.kind === "UEBERFAELLIG")).toHaveLength(1);
  });
});
