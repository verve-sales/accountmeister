import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { listEngagements } from "@/modules/engagements/service";
import { loadRenewalContacts, setEngagementContacts, setSetupContacts } from "@/modules/engagements/contacts";
import { cleanInternalAccount, cleanupReport, closeOverdueEngagements, mergeEngagements, mergeSetups } from "@/modules/cleanup/service";
import { mergePersons } from "@/modules/people/service";
import { captureAssignment, salesOpsOverview } from "@/modules/salesops/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { ForbiddenError } from "@/lib/errors";
import { actorFor, ensureSeed } from "./helpers";

function env() {
  process.env.FEATURE_BESETZUNG = "true";
  resetConfigCacheForTests();
}

async function engagement(label: string, start: string, end: string, freelancerId?: string, setupId?: string) {
  const s = await ensureSeed();
  const david = await actorFor("david");
  const opp = await createOpportunity(david, { setupId: setupId ?? s.setupId, title: `${label} ${Date.now().toString(36)}`, needDescription: "Testbedarf für die Bereinigung.", kind: "FREELANCER_EXPERTE" });
  const q = await quickFill(david, opp.id, { title: label, resourceKind: "FREELANCER", ...(freelancerId ? { freelancerId } : { newName: `${label} ${Date.now().toString(36)} (fiktiv)` }), ekRate: "800", vkRate: "1000", desiredStart: start, plannedEnd: end });
  await db.update(schema.engagements).set({ status: "AKTIV", actualStart: start }).where(eq(schema.engagements.id, q.engagement.id));
  return (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, q.engagement.id) }))!;
}

async function person(name: string, email?: string) {
  const s = await ensureSeed();
  const [p] = await db.insert(schema.persons).values({ workspaceId: s.workspaceId, accountId: s.accountId, displayName: name, email: email ?? null, createdBy: s.users.david }).returning();
  return p!;
}

describe("e37: Bereinigung und Verlängerungs-Ansprechpartner", () => {
  it("C01: Doppelter Einsatz (Moco + von Hand) wird gefunden und zusammengeführt – Moco-Verknüpfung und Check-ins bleiben", async () => {
    env();
    const ceo = await actorFor("clemens");
    const a = await engagement("Scrum Master C01", plusDaysIso(todayIso(), -60), plusDaysIso(todayIso(), 120));
    const b = await engagement("ELBE_Scrum Master C01", plusDaysIso(todayIso(), -30), plusDaysIso(todayIso(), 150), a.freelancerId!);
    await db.update(schema.engagements).set({ mocoContractId: 77001, mocoProjectId: 7700 }).where(eq(schema.engagements.id, b.id));
    const done = await db.insert(schema.checkins).values({ workspaceId: a.workspaceId, engagementId: a.id, side: "KUNDE", dueDate: plusDaysIso(todayIso(), -10), status: "ERLEDIGT", heldAt: new Date(), ownerUserId: a.bdUserId, createdBy: a.bdUserId, note: "Stimmung: positiv" }).returning();
    const rep = await cleanupReport(ceo);
    const g = rep.engagementDuplicates.find((x) => [x.keep.id, ...x.drop.map((d) => d.id)].includes(a.id))!;
    expect(g).toBeTruthy();
    expect(g.reason).toMatch(/Moco und zusätzlich/);
    // Moco-Einsatz b behalten erzwingen? Nein: behalten wird a (von Hand), Moco-Verknüpfung wandert von b herüber
    await expect(mergeEngagements(await actorFor("nina"), a.id, [b.id])).rejects.toBeInstanceOf(ForbiddenError);
    const r = await mergeEngagements(ceo, a.id, [b.id]);
    expect(r.removed).toBe(1);
    const kept = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, a.id) }))!;
    expect(kept.mocoContractId).toBe(77001);
    expect(kept.mocoProjectId).toBe(7700);
    expect(await db.query.engagements.findFirst({ where: eq(schema.engagements.id, b.id) })).toBeUndefined();
    expect((await db.query.checkins.findFirst({ where: eq(schema.checkins.id, done[0]!.id) }))?.engagementId).toBe(a.id);
    expect((await cleanupReport(ceo)).engagementDuplicates.some((x) => [x.keep.id, ...x.drop.map((d) => d.id)].includes(a.id))).toBe(false);
  });

  it("C02: Ende überschritten – nicht mehr in „laufend“, Sammelabschluss setzt abgeschlossen", async () => {
    env();
    const ceo = await actorFor("clemens");
    const e = await engagement("Altvertrag C02", plusDaysIso(todayIso(), -200), plusDaysIso(todayIso(), -20));
    const list = await listEngagements(ceo);
    expect(list.items.some((x) => x.id === e.id)).toBe(false);
    const over = await listEngagements(ceo, "ende_ueberschritten");
    expect(over.items.some((x) => x.id === e.id)).toBe(true);
    const rep = await cleanupReport(ceo);
    expect(rep.overdue.some((x) => x.id === e.id)).toBe(true);
    const r = await closeOverdueEngagements(ceo, [e.id]);
    expect(r.closed + r.ended).toBe(1);
    const after = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e.id) }))!;
    expect(["ABGESCHLOSSEN", "ENDET"]).toContain(after.status);
    expect(after.actualEnd).toBe(plusDaysIso(todayIso(), -20));
  });

  it("C03: Interne Moco-Firma (Verve Consulting) – Einsätze entfernt, Kunde archiviert", async () => {
    env();
    const s = await ensureSeed();
    const ceo = await actorFor("clemens");
    const [acc] = await db.insert(schema.accounts).values({ workspaceId: s.workspaceId, name: "Verve Consulting GmbH", orgType: "SONSTIGE", createdBy: s.users.clemens, responsibleBdUserId: s.users.david }).returning();
    const [setup] = await db.insert(schema.projectSetups).values({ workspaceId: s.workspaceId, accountId: acc!.id, name: "Ohne Bereich", createdBy: s.users.clemens, bdUserId: s.users.david }).returning();
    const e = await engagement("Interne Weiterbildung C03", plusDaysIso(todayIso(), -10), plusDaysIso(todayIso(), 50), undefined, setup!.id);
    const rep = await cleanupReport(ceo);
    expect(rep.internal.find((x) => x.accountId === acc!.id)?.engagements.map((x) => x.id)).toContain(e.id);
    const r = await cleanInternalAccount(ceo, acc!.id);
    expect(r.removed).toBe(1);
    expect(await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e.id) })).toBeUndefined();
    expect((await db.query.accounts.findFirst({ where: eq(schema.accounts.id, acc!.id) }))?.status).toBe("ARCHIVED");
    expect((await cleanupReport(ceo)).internal.some((x) => x.accountId === acc!.id)).toBe(false);
  });

  it("C04: Doppelte Setups eines Kunden werden zusammengeführt – Chancen und Einsätze ziehen um", async () => {
    env();
    const s = await ensureSeed();
    const ceo = await actorFor("clemens");
    const mk = async (name: string) => (await db.insert(schema.projectSetups).values({ workspaceId: s.workspaceId, accountId: s.accountId, name, createdBy: s.users.clemens, bdUserId: s.users.david }).returning())[0]!;
    const s1 = await mk("Plattform C04");
    const s2 = await mk("plattform c04 (KI)");
    await db.insert(schema.setupMemberships).values([{ setupId: s1.id, userId: s.users.david, contribution: "ANKER_KONTEXT" }, { setupId: s2.id, userId: s.users.david, contribution: "ANKER_KONTEXT" }]).onConflictDoNothing();
    const e = await engagement("Entwickler C04", plusDaysIso(todayIso(), -5), plusDaysIso(todayIso(), 90), undefined, s2.id);
    const g = (await cleanupReport(ceo)).setupDuplicates.find((x) => [x.keep.id, ...x.drop.map((d) => d.id)].includes(s1.id))!;
    expect(g.drop.length + 1).toBe(2);
    await mergeSetups(ceo, s1.id, [s2.id]);
    expect(await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, s2.id) })).toBeUndefined();
    expect((await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e.id) }))?.setupId).toBe(s1.id);
    expect((await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, e.opportunityId) }))?.setupId).toBe(s1.id);
  });

  it("C05: Ansprechpartner – Vorgabe am Setup, Abweichung am Einsatz, Zusammenführen von Personen hängt um", async () => {
    env();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const e = await engagement("Tester C05", plusDaysIso(todayIso(), -5), plusDaysIso(todayIso(), 40));
    const fach = await person("Frieda Fach C05 (fiktiv)", "frieda.c05@beispiel.example");
    const einkauf = await person("Egon Einkauf C05 (fiktiv)");
    const einkauf2 = await person("Egon Einkauf C05 (fiktiv)");
    await setSetupContacts(david, s.setupId, { renewalContactPersonId: fach.id, orderContactPersonId: einkauf2.id, renewalApproach: "SALES_OPS" });
    let c = (await loadRenewalContacts([e])).get(e.id)!;
    expect(c.source).toBe("SETUP");
    expect(c.renewal?.email).toBe("frieda.c05@beispiel.example");
    expect(c.approach).toBe("SALES_OPS");
    await setEngagementContacts(david, e.id, { renewalApproach: "BERATER" });
    const fresh = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e.id) }))!;
    c = (await loadRenewalContacts([fresh])).get(e.id)!;
    expect(c.source).toBe("EINSATZ");
    expect(c.approach).toBe("BERATER");
    expect(c.renewal?.id).toBe(fach.id); // Feld leer am Einsatz → Vorgabe greift weiter
    await mergePersons(david, einkauf.id, [einkauf2.id]);
    expect((await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, s.setupId) }))?.orderContactPersonId).toBe(einkauf.id);
    const other = (await db.insert(schema.persons).values({ workspaceId: s.workspaceId, accountId: s.otherAccountId, displayName: "Fremd C05 (fiktiv)", createdBy: s.users.lars }).returning())[0]!;
    await expect(setEngagementContacts(david, e.id, { renewalContactPersonId: other.id })).rejects.toThrow(/Personen dieses Kunden/);
    const list = await listEngagements(david, "ohne_ansprechpartner");
    expect(list.items.some((x) => x.id === e.id)).toBe(false);
    await db.update(schema.projectSetups).set({ renewalContactPersonId: null, orderContactPersonId: null, renewalApproach: null }).where(eq(schema.projectSetups.id, s.setupId));
  });
  it("C06: Sales Operations erfasst ein neues Assignment (Chance, Auftrag, Einsatz aktiv, Ansprechpartner) – BD ohne Sales-Ops-Rolle nicht", async () => {
    env();
    const s = await ensureSeed();
    await db.insert(schema.roleAssignments).values({ workspaceId: s.workspaceId, userId: s.users.nina, role: "SALES_OPS" });
    const ops = await actorFor("nina");
    const fach = await person("Fiona Fachbereich C06 (fiktiv)");
    await expect(captureAssignment(await actorFor("david"), { setupId: s.setupId, title: "Scrum Master", newName: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    const e = await captureAssignment(ops, { setupId: s.setupId, title: "Scrum Master C06", person: "FREELANCER", newName: "Sven Sprint C06 (fiktiv)", start: plusDaysIso(todayIso(), -3), end: plusDaysIso(todayIso(), 180), ekRate: "700", vkRate: "950", orderReference: "BE-4711", renewalContactPersonId: fach.id, renewalApproach: "SALES_OPS" });
    expect(e.status).toBe("AKTIV");
    expect(e.renewalContactPersonId).toBe(fach.id);
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, e.orderId!) });
    expect(order?.orderReference).toBe("BE-4711");
    expect((await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, e.opportunityId) }))?.status).toBe("BEAUFTRAGT");
    const o = await salesOpsOverview(ops);
    expect(o.kpis.laufend).toBeGreaterThan(0);
    await db.delete(schema.roleAssignments).where(eq(schema.roleAssignments.userId, s.users.nina));
    await db.insert(schema.roleAssignments).values({ workspaceId: s.workspaceId, userId: s.users.nina, role: "ANKER" });
  });
});
