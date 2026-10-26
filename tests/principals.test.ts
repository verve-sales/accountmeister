import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { resetConfigCacheForTests } from "@/lib/config";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { addAgreement, buildPrincipalOverview, buildTalk, computeActuals, headsAt, listPrincipals, loadTargets, quarterFromKey, quarterOf, referenceDate, saveTargets, shiftQuarter } from "@/modules/principals/service";
import { actorFor, ensureSeed } from "./helpers";

type Eng = typeof schema.engagements.$inferSelect;
const eng = (p: Partial<Eng>): Eng => ({ id: Math.random().toString(36), status: "AKTIV", freelancerId: null, internalUserId: null, actualStart: null, plannedStart: null, actualEnd: null, plannedEnd: null, ...p }) as Eng;

async function placeHead(david: Awaited<ReturnType<typeof actorFor>>, setupId: string, label: string) {
  const opp = await createOpportunity(david, { setupId, title: `${label} ${Date.now()}`, needDescription: "Testautomatisierung im Kernteam.", kind: "FREELANCER_EXPERTE", ownerUserId: david.userId });
  const r = await quickFill(david, opp.id, { title: "Tester:in", resourceKind: "FREELANCER", newName: `${label} ${Date.now().toString(36)} (fiktiv)`, ekRate: "800", vkRate: "1000", desiredStart: todayIso(), plannedEnd: plusDaysIso(todayIso(), 120) });
  await db.update(schema.engagements).set({ status: "AKTIV", actualStart: todayIso() }).where(eq(schema.engagements.id, r.engagement.id));
  return r.engagement.id;
}

describe("Etappe 38 (Use Case 7): Meine Principals – Ziele je Quartal und Gespräch", () => {
  it("P01: Quartal, Stichtag und Köpfe-Zählung", () => {
    const q = quarterFromKey("2026-Q4")!;
    expect(q).toMatchObject({ label: "Q4 2026", start: "2026-10-01", end: "2026-12-31" });
    expect(quarterOf("2026-02-14").key).toBe("2026-Q1");
    expect(quarterFromKey("2026-Q1")!.end).toBe("2026-03-31");
    expect(shiftQuarter(q, 1).key).toBe("2027-Q1");
    expect(shiftQuarter(quarterFromKey("2026-Q1")!, -1).key).toBe("2025-Q4");
    expect(referenceDate(q, "2026-10-26")).toBe("2026-10-26");
    expect(referenceDate(q, "2027-01-15")).toBe("2026-12-31");
    expect(referenceDate(q, "2026-09-30")).toBeNull();
    // gleiche Person in zwei Einsätzen zählt einmal; beendete, abgebrochene und künftige nicht
    const engs = [
      eng({ freelancerId: "f1", actualStart: "2026-01-01" }),
      eng({ freelancerId: "f1", plannedStart: "2026-06-01", plannedEnd: "2027-01-31" }),
      eng({ freelancerId: "f2", plannedStart: "2026-01-01", plannedEnd: "2026-09-30" }),
      eng({ freelancerId: "f3", status: "ABGEBROCHEN", plannedStart: "2026-01-01" }),
      eng({ internalUserId: "u1", plannedStart: "2027-01-01" }),
      eng({ internalUserId: "u2", plannedStart: "2026-10-01", actualEnd: "2026-12-31" }),
    ];
    expect(headsAt(engs, "2026-12-31")).toBe(2);
  });

  it("P02: GF setzt Ziele; Ist zählt Köpfe, Neukunden, Verlängerungsquote; Rechte; Vereinbarung wird Vorgang beim Principal", async () => {
    process.env.AI_PROVIDER = "test";
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const [clemens, petra, david] = await Promise.all([actorFor("clemens"), actorFor("petra"), actorFor("david")]);
    const q = quarterOf(todayIso());
    const p = (await listPrincipals(s.workspaceId)).find((x) => x.userId === petra.userId)!;
    expect(p.accountIds).toContain(s.accountId);
    const before = await computeActuals(p.accountIds, q);

    // Ein weiterer Kopf beim Seed-Kunden
    await placeHead(david, s.setupId, "Kopf");
    // Neukunde: erster Einsatz beginnt heute
    const acc = await createAccount(david, { name: `Neukunde ${Date.now().toString(36)} (fiktiv)`, responsibleBdUserId: david.userId });
    const setup = await createSetup(david, { accountId: acc.id, name: "Neukunden-Setup", contextNote: "Kontext", bdUserId: david.userId });
    const newEng = await placeHead(david, setup.id, "Erstkopf");
    // Verlängerungen: eine bestätigt, eine abgelehnt – heute entschieden
    for (const status of ["BESTAETIGT", "ABGELEHNT"]) await db.insert(schema.renewalDecisions).values({ workspaceId: s.workspaceId, engagementId: newEng, status, decidedAt: new Date(), decidedBy: clemens.userId, createdBy: clemens.userId });

    const p2 = (await listPrincipals(s.workspaceId)).find((x) => x.userId === petra.userId)!;
    const after = await computeActuals(p2.accountIds, q);
    expect(after.heads.get(s.accountId)).toBe((before.heads.get(s.accountId) ?? 0) + 1);
    expect(after.heads.get(acc.id)).toBe(1);
    expect(after.newCustomers.map((n) => n.accountId)).toContain(acc.id);
    expect(after.renewals.confirmed).toBe(before.renewals.confirmed + 1);
    expect(after.renewals.rejected).toBe(before.renewals.rejected + 1);

    // Ziele: nur die Geschäftsführung
    await expect(saveTargets(petra, petra.userId, { quarter: q.key, newCustomers: "9" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveTargets(clemens, petra.userId, { quarter: q.key, renewalQuote: "140" })).rejects.toBeInstanceOf(ValidationError);
    expect(await saveTargets(clemens, petra.userId, { quarter: q.key, heads: { [s.accountId]: "6", [acc.id]: "2" }, newCustomers: "2", renewalQuote: "80" })).toBe(4);
    let t = await loadTargets(petra.userId, q);
    expect(t).toMatchObject({ headsTotal: 8, newCustomers: 2, renewalQuote: 80 });
    // erneut speichern ersetzt (leeres Feld = kein Ziel)
    await saveTargets(clemens, petra.userId, { quarter: q.key, heads: { [s.accountId]: "5" }, newCustomers: "", renewalQuote: "75" });
    t = await loadTargets(petra.userId, q);
    expect(t).toMatchObject({ headsTotal: 5, newCustomers: null, renewalQuote: 75 });

    // Übersicht nur GF; Gespräch: GF und der Principal selbst
    await expect(buildPrincipalOverview(petra)).rejects.toBeInstanceOf(ForbiddenError);
    const ov = await buildPrincipalOverview(clemens);
    expect(ov.rows.find((r) => r.principal.userId === petra.userId)!.targets.headsTotal).toBe(5);
    await expect(buildTalk(david, petra.userId)).rejects.toBeInstanceOf(ForbiddenError);
    const own = await buildTalk(petra, petra.userId);
    expect(own.canEdit).toBe(false);
    expect(own.lage.find((a) => a.accountId === acc.id)!.headsNow).toBe(1);

    // Vereinbarung: Frist Pflicht, wird Vorgang beim Principal
    await expect(addAgreement(clemens, petra.userId, { quarter: q.key, text: "Zwei Köpfe mehr" })).rejects.toBeInstanceOf(ValidationError);
    await expect(addAgreement(petra, petra.userId, { quarter: q.key, text: "Selbst eintragen", dueDate: plusDaysIso(todayIso(), 7) })).rejects.toBeInstanceOf(ForbiddenError);
    const ag = await addAgreement(clemens, petra.userId, { quarter: q.key, text: "Bei Neukunde zwei weitere Köpfe platzieren", dueDate: plusDaysIso(todayIso(), 14) });
    const wi = (await db.query.workItems.findFirst({ where: eq(schema.workItems.id, ag.workItemId!) }))!;
    expect(wi.assigneeUserId).toBe(petra.userId);
    expect(wi.dueDate).toBe(plusDaysIso(todayIso(), 14));
    const talk = await buildTalk(clemens, petra.userId);
    expect(talk.canEdit).toBe(true);
    expect(talk.agreements.find((a) => a.id === ag.id)).toMatchObject({ done: false, overdue: false });
    expect(talk.summary.openAgreements).toBeGreaterThan(0);
  });
});
