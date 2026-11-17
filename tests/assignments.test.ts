import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { ForbiddenError } from "@/lib/errors";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { asgCheckins, asgOverview, canUseAssignments } from "@/modules/assignments/service";
import { decideRenewal, listRenewalCards, signalRenewal, startRenewal } from "@/modules/engagements/care";
import { engagementAccess } from "@/modules/engagements/authz";
import { ensureBackofficeTeam } from "@/modules/conversion/profile";
import { assignRole } from "@/modules/governance/service";
import { loadActor } from "@/modules/identity/actor";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

function env() {
  process.env.AI_PROVIDER = "test";
  process.env.FEATURE_BESETZUNG = "true";
  process.env.SHAREPOINT_MODE = "off";
  resetConfigCacheForTests();
}
const u = () => Date.now().toString(36);

async function person(workspaceId: string, name: string, role?: "SALES_OPS") {
  const [row] = await db.insert(schema.users).values({ workspaceId, email: `${name.toLowerCase().replace(/[^a-z]/g, "")}-${u()}@verve.example`, displayName: name }).returning();
  if (role) await assignRole(await actorFor("admin"), { userId: row!.id, role });
  return (await loadActor(row!.id))!;
}

describe("e49: Assignmentmanager – Übersicht, Aufgaben, Signal des BD", () => {
  it("AM01: Übersicht für Sales Operations, Backoffice und GF – Stand je Einsatz, Aufgaben aus dem Stand; BD hat keinen Zugang", async () => {
    env();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const ops = await person(s.workspaceId, "Olga Ops (fiktiv)", "SALES_OPS");
    const bo = await person(s.workspaceId, "Bert Backoffice (fiktiv)");
    const team = await ensureBackofficeTeam(s.workspaceId);
    await db.insert(schema.teamMembers).values({ teamId: team.id, userId: bo.userId, role: "MITGLIED" }).onConflictDoNothing();
    expect(await canUseAssignments(david)).toBe(false);
    expect(await canUseAssignments(ops)).toBe(true);
    expect(await canUseAssignments(bo)).toBe(true);
    expect(await canUseAssignments(await actorFor("clemens"))).toBe(true);
    await expect(asgOverview(david)).rejects.toBeInstanceOf(ForbiddenError);

    const name = `Zora Zeitleiste ${u()} (fiktiv)`;
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `E49 Übersicht ${u()}`, needDescription: "Einsatz für die Zeitleiste.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "Tester", resourceKind: "FREELANCER", newName: name, ekRate: "600", vkRate: "1000", desiredStart: plusDaysIso(todayIso(), -60), plannedEnd: plusDaysIso(todayIso(), 20) });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -60) }).where(eq(schema.engagements.id, q.engagement.id));
    await db.insert(schema.checkins).values({ workspaceId: s.workspaceId, engagementId: q.engagement.id, side: "FREELANCER", ownerUserId: ops.userId, dueDate: plusDaysIso(todayIso(), -2), createdBy: david.userId });

    const o = await asgOverview(bo);
    const e = o.engagements.find((x) => x.id === q.engagement.id)!;
    expect(e).toMatchObject({ person: name, kind: "FREELANCER", state: "DRINGEND", vk: "1000.00", ek: "600.00", contract: null, orderReference: null });
    const mine = o.tasks.filter((t) => t.person === name).map((t) => t.kind).sort();
    expect(mine).toEqual(["BESTELLUNG", "CHECKIN", "VERLAENGERUNG", "VERTRAG"]);
    expect(o.tasks.find((t) => t.person === name && t.kind === "VERLAENGERUNG")!.overdue).toBe(true);
    // Backoffice kommt jetzt auch an den Einsatz (wie Sales Operations)
    const eng = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, q.engagement.id) }))!;
    expect((await engagementAccess(bo, eng))?.ops).toBe(true);
    const ci = await asgCheckins(ops);
    expect(ci.find((c) => c.engagementId === q.engagement.id)).toMatchObject({ side: "FREELANCER", overdue: true });
  });

  it("AM02: Der BD gibt nur das Signal; Sales Operations setzt um und bestätigt – auch „endet“ geht mit einem Klick", async () => {
    env();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const ops = await person(s.workspaceId, "Sina Signal (fiktiv)", "SALES_OPS");
    const mk = async (label: string) => {
      const opp = await createOpportunity(david, { setupId: s.setupId, title: `E49 ${label} ${u()}`, needDescription: "Verlängerung per Signal.", kind: "FREELANCER_EXPERTE" });
      const q = await quickFill(david, opp.id, { title: "Tester", resourceKind: "FREELANCER", newName: `${label} ${u()} (fiktiv)`, ekRate: "600", vkRate: "1000", desiredStart: plusDaysIso(todayIso(), -60), plannedEnd: plusDaysIso(todayIso(), 40) });
      await db.update(schema.engagements).set({ status: "AKTIV" }).where(eq(schema.engagements.id, q.engagement.id));
      await db.insert(schema.renewalDecisions).values({ workspaceId: s.workspaceId, engagementId: q.engagement.id, status: "ZU_KLAEREN", commercialOwnerUserId: david.userId, createdBy: david.userId });
      return q.engagement.id;
    };
    const id = await mk("Vera Verlaengert");
    expect((await listRenewalCards(david)).find((c) => c.engagementId === id)?.mode).toBe("ANSTOSSEN");
    const wish = plusDaysIso(todayIso(), 220);
    const r = await signalRenewal(david, id, { signal: "VERLAENGERN", wishEnd: wish, note: "Kunde hat zugesagt" });
    expect(r).toMatchObject({ status: "IN_ABSTIMMUNG", proposedTo: wish });
    expect(r.availabilityNote).toMatch(/Kunde will verlängern.*Kunde hat zugesagt/);
    const note = await db.query.notifications.findFirst({ where: and(eq(schema.notifications.userId, ops.userId), eq(schema.notifications.link, `/einsaetze/${id}#verlaengerung`)) });
    expect(note?.title).toMatch(/Verlängerung umsetzen/);
    // Sales Operations sieht die Karte zur Entscheidung und bestätigt
    expect((await listRenewalCards(ops)).find((c) => c.engagementId === id)?.mode).toBe("ENTSCHEIDEN");
    await startRenewal(ops, id, { newEnd: wish, conditions: "UNVERAENDERT", orderReference: "4500888001" }, { direct: true });
    const d = await decideRenewal(ops, id, { decision: "BESTAETIGEN", orderReference: "4500888001" });
    expect(d.decision.status).toBe("BESTAETIGT");
    const e = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, id) }))!;
    expect(e).toMatchObject({ plannedEnd: wish, orderReference: "4500888001" });
    // „Endet“
    const id2 = await mk("Erik Endet");
    const r2 = await signalRenewal(david, id2, { signal: "ENDET", note: "Budget gestrichen" });
    expect(r2.status).toBe("ABGELEHNT");
    expect((await listRenewalCards(david)).some((c) => c.engagementId === id2)).toBe(false);
    await expect(signalRenewal(await actorFor("lars"), id2, { signal: "ENDET" })).rejects.toThrow();
  });
});
