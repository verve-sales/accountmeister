import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { resetConfigCacheForTests } from "@/lib/config";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { assignRole } from "@/modules/governance/service";
import { loadActor, type Actor } from "@/modules/identity/actor";
import { computeActuals, listPrincipals, quarterOf } from "@/modules/principals/service";
import { accountKinds, buildRound, closeRound, prepareRoundNote, setAccountFlags } from "@/modules/rounds/service";
import { decideRenewal, startRenewal } from "@/modules/engagements/care";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

const u = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

async function customer(bd: Actor, label: string, opts: { end?: string; status?: string } = {}) {
  const acc = await createAccount(bd, { name: `${label} ${u()} (fiktiv)`, orgType: "KONZERN", responsibleBdUserId: bd.userId });
  const b = (await loadActor(bd.userId))!;
  const setup = await createSetup(b, { accountId: acc.id, name: `${label}-Setup`, bdUserId: b.userId, creatorContribution: "BD_ZUSTAENDIG" });
  let engagementId: string | null = null;
  if (opts.status) {
    const opp = await createOpportunity(b, { setupId: setup.id, title: `${label} Bedarf ${u()}`, needDescription: "Testautomatisierung im Kernteam.", kind: "FREELANCER_EXPERTE", ownerUserId: b.userId });
    const r = await quickFill(b, opp.id, { title: "Tester:in", resourceKind: "FREELANCER", newName: `${label} Kopf ${u()} (fiktiv)`, ekRate: "800", vkRate: "1000", desiredStart: plusDaysIso(todayIso(), -60), plannedEnd: opts.end ?? plusDaysIso(todayIso(), 200) });
    await db.update(schema.engagements).set({ status: opts.status, actualStart: plusDaysIso(todayIso(), -60), plannedEnd: opts.end ?? plusDaysIso(todayIso(), 200) }).where(eq(schema.engagements.id, r.engagement.id));
    engagementId = r.engagement.id;
  }
  return { acc, setup, engagementId, bd: (await loadActor(bd.userId))! };
}

async function newUser(workspaceId: string, name: string) {
  const [x] = await db.insert(schema.users).values({ workspaceId, email: `${name.toLowerCase()}-${u()}@verve.example`, displayName: `${name} (fiktiv)` }).returning();
  return x!;
}

describe("Etappe 45: Kundenverantwortung (Account Lead/Principal), Kundenart, Kundenrunde", () => {
  it("R01: Genau eine Kundenverantwortung je Kunde; Stufe Account Lead; arbeitsraumweit zählt keine Kunden", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const [admin, david] = await Promise.all([actorFor("admin"), actorFor("david")]);
    const philip = await newUser(s.workspaceId, "Philip");
    const { acc } = await customer(david, "Leadkunde");
    await assignRole(admin, { userId: philip.id, role: "PRINCIPAL", accountId: acc.id, level: "ACCOUNT_LEAD" });
    await expect(assignRole(admin, { userId: (await actorFor("clemens")).userId, role: "PRINCIPAL", accountId: acc.id })).rejects.toBeInstanceOf(ValidationError);
    const p = (await listPrincipals(s.workspaceId)).find((x) => x.userId === philip.id)!;
    expect(p.level).toBe("ACCOUNT_LEAD");
    expect(p.accountIds).toEqual([acc.id]);
    // Petra ist arbeitsraumweit Principal: Rechte überall, aber keine eigenen Kunden
    expect((await listPrincipals(s.workspaceId)).some((x) => x.userId === (s.users.petra))).toBe(false);
  });

  it("R02: Kundenrunde – nur Bestandskunden ohne Nebengeschäft, Rot zuerst, Radar für Prospects/Ex-Kunden, Vorbereitung und Abschluss", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const [admin, david, clemens, lars] = await Promise.all([actorFor("admin"), actorFor("david"), actorFor("clemens"), actorFor("lars")]);
    const philipU = await newUser(s.workspaceId, "Philipp");
    const a = await customer(david, "Bestand", { status: "AKTIV", end: plusDaysIso(todayIso(), 10) });
    const b = await customer(david, "Durchreiche", { status: "AKTIV" });
    const c = await customer(david, "Prospect");
    const d = await customer(david, "Exkunde", { status: "ABGESCHLOSSEN", end: plusDaysIso(todayIso(), -30) });
    const e = await customer(david, "Kaltprospect");
    for (const x of [a, c]) await assignRole(admin, { userId: philipU.id, role: "PRINCIPAL", accountId: x.acc.id, level: "ACCOUNT_LEAD" });
    const philip = (await loadActor(philipU.id))!;
    const kinds = await accountKinds([a.acc.id, c.acc.id, d.acc.id]);
    expect([kinds.get(a.acc.id), kinds.get(c.acc.id), kinds.get(d.acc.id)]).toEqual(["BESTAND", "PROSPECT", "EX"]);
    await setAccountFlags(david, b.acc.id, { sideBusiness: true });
    await setAccountFlags(philip, c.acc.id, { onRadar: true });
    await setAccountFlags(clemens, d.acc.id, { onRadar: true });
    await expect(setAccountFlags(lars, e.acc.id, { onRadar: true })).rejects.toBeInstanceOf(ForbiddenError);

    // Köpfe aus Nebengeschäft zählen nicht
    const act = await computeActuals([a.acc.id, b.acc.id], quarterOf(todayIso()));
    expect(act.heads.get(b.acc.id)).toBe(0);
    expect(act.heads.get(a.acc.id)).toBe(1);

    const gf = await buildRound(clemens);
    const ids = gf.groups.flatMap((g) => g.accounts.map((x) => x.accountId));
    expect(ids).toContain(a.acc.id);
    expect(ids).not.toContain(b.acc.id);
    expect(ids).not.toContain(c.acc.id);
    const group = gf.groups.find((g) => g.userId === philip.userId)!;
    expect(group.level).toBe("ACCOUNT_LEAD");
    const row = group.accounts.find((x) => x.accountId === a.acc.id)!;
    expect(row.ampel).toBe("ROT");
    expect(row.reasons.join(" ")).toMatch(/endet in 10 Tagen/);
    expect(gf.radar.map((x) => x.accountId).sort()).toEqual([c.acc.id, d.acc.id].sort());
    expect(gf.radar.some((x) => x.accountId === e.acc.id)).toBe(false);

    // Account Lead sieht nur seine Kunden und bereitet vor; Fremde dürfen nicht
    const own = await buildRound(philip);
    expect(own.groups.flatMap((g) => g.accounts.map((x) => x.accountId))).toEqual([a.acc.id]);
    expect(own.radar.map((x) => x.accountId)).toEqual([c.acc.id]);
    await prepareRoundNote(philip, a.acc.id, "Verlängerung ist mündlich zugesagt, Bestellung kommt nächste Woche.");
    await expect(prepareRoundNote(lars, a.acc.id, "x")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await buildRound(clemens)).groups.find((g) => g.userId === philip.userId)!.accounts.find((x) => x.accountId === a.acc.id)!.prep?.note).toMatch(/mündlich zugesagt/);

    // Abschluss nur durch die Geschäftsführung; danach beginnt die Vorbereitung neu
    await expect(closeRound(philip, {})).rejects.toBeInstanceOf(ForbiddenError);
    await closeRound(clemens, { note: "Runde KW 44" });
    const after = await buildRound(clemens);
    expect(after.lastRound?.heldOn).toBe(todayIso());
    expect(after.groups.find((g) => g.userId === philip.userId)!.accounts.find((x) => x.accountId === a.acc.id)!.prep).toBeNull();
  });

  it("R03: Account-Lead-Kunde – Verlängerung mit neuen Konditionen geht zur Freigabe an die Geschäftsführung", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    process.env.MOCO_MODE = "off";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const [admin, david, clemens] = await Promise.all([actorFor("admin"), actorFor("david"), actorFor("clemens")]);
    const lead = await newUser(s.workspaceId, "Lea");
    const k = await customer(david, "Freigabekunde", { status: "AKTIV", end: plusDaysIso(todayIso(), 60) });
    await assignRole(admin, { userId: lead.id, role: "PRINCIPAL", accountId: k.acc.id, level: "ACCOUNT_LEAD" });
    const bd = (await loadActor(david.userId))!;
    await startRenewal(bd, k.engagementId!, { newEnd: plusDaysIso(todayIso(), 240), conditions: "NEU", ek: "820", vk: "1050" });
    const r = await decideRenewal(bd, k.engagementId!, { decision: "BESTAETIGEN" });
    expect(r.pendingApproval).toBe(true);
    expect(r.decision.status).not.toBe("BESTAETIGT");
    expect(r.decision.commercialOwnerUserId).toBe(clemens.userId);
    const ok = await decideRenewal(clemens, k.engagementId!, { decision: "BESTAETIGEN" });
    expect(ok.pendingApproval).toBeFalsy();
    expect(ok.decision.status).toBe("BESTAETIGT");
  });
});
