import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { asgOverview, canUseAssignments } from "@/modules/assignments/service";
import { engagementAccess } from "@/modules/engagements/authz";
import { findPlausibility } from "@/modules/cleanup/service";
import { computeHealthFor } from "@/modules/health/service";
import { lanes } from "@/components/AsgTimeline";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

/** e63 Red Team – Rechte und Datenwidersprüche mit echter Datenbank. Alle Namen fiktiv. */

function env() {
  process.env.AI_PROVIDER = "test";
  process.env.FEATURE_BESETZUNG = "true";
  process.env.SHAREPOINT_MODE = "off";
  resetConfigCacheForTests();
}
const u = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function einsatz(label: string, from = -30, to = 60) {
  const s = await ensureSeed();
  const david = await actorFor("david");
  const opp = await createOpportunity(david, { setupId: s.setupId, title: `RT ${label} ${u()}`, needDescription: "Red-Team-Einsatz (fiktiv).", kind: "FREELANCER_EXPERTE" });
  const q = await quickFill(david, opp.id, { title: "Tester", resourceKind: "FREELANCER", newName: `${label} ${u()} (fiktiv)`, ekRate: "640", vkRate: "1000", desiredStart: plusDaysIso(todayIso(), from), plannedEnd: plusDaysIso(todayIso(), to) });
  return q.engagement;
}

describe("e63 Red Team: Einkaufssatz nur für den berechtigten Kreis", () => {
  it("RT01: Die Administration öffnet den Assignmentmanager, sieht aber keinen EK; die Geschäftsführung schon", async () => {
    env();
    const e = await einsatz("Ella EK");
    const admin = await actorFor("admin");
    expect(await canUseAssignments(admin)).toBe(true);
    const asAdmin = (await asgOverview(admin)).engagements.find((x) => x.id === e.id)!;
    expect(asAdmin.ek).toBeNull();
    expect(asAdmin.vk).toBe("1000.00");
    const asCeo = (await asgOverview(await actorFor("clemens"))).engagements.find((x) => x.id === e.id)!;
    expect(asCeo.ek).toBe("640.00");
  });

  it("RT02: Anker und BD eines anderen Kunden kommen nicht an den Einsatz", async () => {
    env();
    const e = await einsatz("Fritz Fremd");
    const row = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e.id) }))!;
    expect(await engagementAccess(await actorFor("nina"), row)).toBeNull();
    expect(await engagementAccess(await actorFor("lars"), row)).toBeNull();
    expect((await engagementAccess(await actorFor("david"), row))?.commercial).toBe(true);
  });

  it("RT03: Einsatz aus einem anderen Arbeitsraum bleibt unsichtbar, auch für die Geschäftsführung", async () => {
    env();
    const e = await einsatz("Wanda Workspace");
    const row = (await db.query.engagements.findFirst({ where: eq(schema.engagements.id, e.id) }))!;
    expect(await engagementAccess(await actorFor("clemens"), { ...row, workspaceId: "00000000-0000-0000-0000-000000000000" })).toBeNull();
  });

  it("RT04: BD und Anker haben keinen Zugang zum Assignmentmanager", async () => {
    env();
    expect(await canUseAssignments(await actorFor("david"))).toBe(false);
    expect(await canUseAssignments(await actorFor("nina"))).toBe(false);
  });
});

describe("e63 Red Team: Datenwidersprüche", () => {
  it("RT05: Laufender Einsatz ohne Auftrag zählt im Health-Check (keine Lücke zu „Im Einsatz“)", async () => {
    env();
    const s = await ensureSeed();
    const e = await einsatz("Hanna Health");
    await db.update(schema.engagements).set({ status: "AKTIV" }).where(eq(schema.engagements.id, e.id));
    const acc = (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, s.accountId) }))!;
    const [h] = await computeHealthFor([{ id: acc.id, name: acc.name }]);
    expect(h!.engagements.some((x) => x.engagementId === e.id)).toBe(true);
  });

  it("RT06: Abgeschlossene Einsätze zählen nicht als laufend", async () => {
    env();
    const s = await ensureSeed();
    const e = await einsatz("Otto Over", -200, -10);
    await db.update(schema.engagements).set({ status: "ABGESCHLOSSEN" }).where(eq(schema.engagements.id, e.id));
    const acc = (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, s.accountId) }))!;
    const [h] = await computeHealthFor([{ id: acc.id, name: acc.name }]);
    expect(h!.engagements.some((x) => x.engagementId === e.id)).toBe(false);
  });

  it("RT07: Plausibilität findet Einsatz ohne Ende und Ende vor Start", async () => {
    env();
    const a = await einsatz("Paul Plausibel");
    const b = await einsatz("Berta Rückwärts");
    await db.update(schema.engagements).set({ status: "AKTIV", plannedEnd: null, actualEnd: null }).where(eq(schema.engagements.id, a.id));
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), 10), plannedEnd: plusDaysIso(todayIso(), 5) }).where(eq(schema.engagements.id, b.id));
    const f = await findPlausibility(await actorFor("clemens"));
    expect(f.find((x) => x.href === `/einsaetze/${a.id}`)?.kind).toBe("OHNE_ENDE");
    expect(f.find((x) => x.href === `/einsaetze/${b.id}`)?.kind).toBe("ENDE_VOR_START");
  });

  it("RT08: Plausibilität findet doppelt angelegte Kunden trotz Rechtsform und Schreibweise, archivierte nicht", async () => {
    env();
    const s = await ensureSeed();
    const tag = u();
    const createdBy = s.users.clemens;
    const [x] = await db.insert(schema.accounts).values({ workspaceId: s.workspaceId, name: `Dublo ${tag} GmbH (fiktiv)`, createdBy }).returning();
    const [y] = await db.insert(schema.accounts).values({ workspaceId: s.workspaceId, name: `DUBLO ${tag} (fiktiv)`, createdBy }).returning();
    const [z] = await db.insert(schema.accounts).values({ workspaceId: s.workspaceId, name: `Dublo ${tag} AG`, status: "ARCHIVED", createdBy }).returning();
    const f = (await findPlausibility(await actorFor("clemens"))).filter((r) => r.kind === "KUNDE_DOPPELT");
    expect(f.some((r) => r.href === `/kunden/${x!.id}`)).toBe(true);
    expect(f.some((r) => r.href === `/kunden/${y!.id}`)).toBe(true);
    expect(f.some((r) => r.href === `/kunden/${z!.id}`)).toBe(false);
  });

  it("RT09: Plausibilität sieht nur den eigenen Arbeitsraum", async () => {
    env();
    const f = await findPlausibility({ ...(await actorFor("clemens")), workspaceId: "00000000-0000-0000-0000-000000000000" });
    expect(f).toEqual([]);
  });
});

describe("e63 Red Team: Zeitleiste mit parallelen Einsätzen", () => {
  const e = (id: string, start: string | null, end: string | null, renewalTo: string | null = null) => ({ id, start, end, renewalTo });
  it("RT10: zwei parallele Einsätze → zwei Spuren", () => {
    const l = lanes([e("a", "2026-01-01", "2026-12-31"), e("b", "2026-06-01", "2027-03-31")]);
    expect([l.get("a"), l.get("b")]).toEqual([0, 1]);
  });
  it("RT11: Einsätze nacheinander → eine Spur", () => {
    const l = lanes([e("a", "2026-01-01", "2026-05-31"), e("b", "2026-06-01", "2026-12-31")]);
    expect([l.get("a"), l.get("b")]).toEqual([0, 0]);
  });
  it("RT12: eine angebotene Verlängerung belegt die Spur bis zum neuen Ende", () => {
    const l = lanes([e("a", "2026-01-01", "2026-05-31", "2026-09-30"), e("b", "2026-06-01", "2026-12-31")]);
    expect(l.get("b")).toBe(1);
  });
  it("RT13: frei gewordene Spur wird wiederverwendet", () => {
    const l = lanes([e("a", "2026-01-01", "2026-03-31"), e("b", "2026-02-01", "2026-12-31"), e("c", "2026-05-01", "2026-08-31")]);
    expect([l.get("a"), l.get("b"), l.get("c")]).toEqual([0, 1, 0]);
  });
  it("RT14: Einsatz ohne Start und Ende stürzt nicht ab", () => {
    expect(lanes([e("a", null, null), e("b", null, null)]).size).toBe(2);
  });
});
