import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { listRenewalCards, remindPossibleRenewals, signalRenewal } from "@/modules/engagements/care";
import { asgOverview } from "@/modules/assignments/service";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

describe("e60: Verlängerung „möglich – noch zu früh“", () => {
  it("M01: festhalten ohne Prozess, Zeitleiste zeigt sie, Wiedervorlage holt sie zurück, „Jetzt umsetzen“ startet den Prozess", async () => {
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const ceo = await actorFor("clemens");
    const tag = Date.now().toString(36);
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `M01 ${tag}`, needDescription: "Testbedarf Verlängerung möglich.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "Tester", resourceKind: "FREELANCER", newName: `Mia Möglich ${tag} (fiktiv)`, ekRate: "600", vkRate: "900", desiredStart: plusDaysIso(todayIso(), -60), plannedEnd: plusDaysIso(todayIso(), 70) });
    const eid = q.engagement.id;
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -60) }).where(eq(schema.engagements.id, eid));
    const notesBefore = (await db.query.notifications.findMany({ where: eq(schema.notifications.link, `/einsaetze/${eid}#verlaengerung`) })).length;
    const wish = plusDaysIso(todayIso(), 200);
    const fu = plusDaysIso(todayIso(), 10);
    const r = await signalRenewal(david, eid, { signal: "MOEGLICH", wishEnd: wish, followUp: fu, note: "Budget wird geklärt" });
    expect(r.status).toBe("MOEGLICH");
    expect(r.proposedTo).toBe(wish);
    // keine Benachrichtigung an Sales Ops/Backoffice
    expect((await db.query.notifications.findMany({ where: eq(schema.notifications.link, `/einsaetze/${eid}#verlaengerung`) })).length).toBe(notesBefore);
    // Zeitleiste: Verlängerung sichtbar, aber kein „Verlängerung umsetzen“
    const ov = await asgOverview(ceo);
    const row = ov.engagements.find((e) => e.id === eid)!;
    expect(row.renewalStatus).toBe("MOEGLICH");
    expect(row.renewalTo).toBe(wish);
    expect(row.state).not.toBe("VERLAENGERUNG");
    expect(ov.tasks.some((t) => t.key === `ren:${eid}` && /umsetzen/.test(t.title))).toBe(false);
    // vor der Wiedervorlage keine Karte beim BD
    expect((await listRenewalCards(david)).some((c) => c.engagementId === eid)).toBe(false);
    await db.update(schema.renewalDecisions).set({ followUpDate: todayIso() }).where(eq(schema.renewalDecisions.id, r.id));
    const card = (await listRenewalCards(david)).find((c) => c.engagementId === eid);
    expect(card?.mode).toBe("ANSTOSSEN");
    expect(card?.status).toBe("MOEGLICH");
    expect(await remindPossibleRenewals()).toBeGreaterThanOrEqual(1);
    // jetzt umsetzen
    const r2 = await signalRenewal(david, eid, { signal: "VERLAENGERN", wishEnd: wish });
    expect(r2.id).toBe(r.id);
    expect(r2.status).toBe("IN_ABSTIMMUNG");
    expect(r2.followUpDate).toBeNull();
    expect((await asgOverview(ceo)).engagements.find((e) => e.id === eid)!.state).toBe("VERLAENGERUNG");
    // „möglich“ passt nicht mehr, wenn schon in Umsetzung
    await expect(signalRenewal(david, eid, { signal: "MOEGLICH", wishEnd: wish })).rejects.toThrow(/Umsetzung/);
    expect(await db.query.renewalDecisions.findMany({ where: and(eq(schema.renewalDecisions.engagementId, eid)) })).toHaveLength(1);
  });
});
