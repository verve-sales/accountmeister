import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createOpportunity } from "@/modules/opportunities/service";
import { quickFill } from "@/modules/staffing/service";
import { ensureRenewalDecisions } from "@/modules/engagements/care";
import { acceptSuggestion, engagementContext, matchEngagementByName, smartDump } from "@/modules/suggestions/service";
import { addMonthsIsoForTest } from "./mail-helpers";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

const MAIL = readFileSync("tests/fixtures/mails/verlaengerung-verlauf.txt", "utf8");

describe("Etappe 35: Mail-Auswertung – Funktion aus Signatur, Verlängerung dem Einsatz zugeordnet", () => {
  it("M01: Verlängerungsmail → Karte am richtigen Einsatz, BD bestätigt mit einem Klick (offene Klärung erledigt); Personen mit Funktion/Bereich; keine Verve-Person", async () => {
    process.env.AI_PROVIDER = "test";
    process.env.FEATURE_BESETZUNG = "true";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    // „Max Beispiel“ ist bei Verve (wie im echten Verlauf der Absender auf Verve-Seite)
    if (!(await db.query.users.findFirst({ where: eq(schema.users.email, "max.beispiel@verveconsulting.de") }))) await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: "max.beispiel@verveconsulting.de", displayName: "Max Beispiel" });
    // interne Beraterin „Sophia Rosenblatt“, seit einem Jahr im Einsatz, Ende in 60 Tagen → Verlängerung „zu klären“
    const [sophia] = await db.insert(schema.users).values({ workspaceId: s.workspaceId, email: `sophia-${Date.now()}@verve.example`, displayName: "Sophia Rosenblatt" }).returning();
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `ANÜ HR ${Date.now()}`, needDescription: "Arbeitnehmerüberlassung im HR-Bereich.", kind: "VERVE_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "HR-Referentin", resourceKind: "INTERN", internalUserId: sophia!.id, desiredStart: plusDaysIso(todayIso(), -365), plannedEnd: plusDaysIso(todayIso(), 60), vkRate: "900" });
    await db.update(schema.engagements).set({ status: "AKTIV", actualStart: plusDaysIso(todayIso(), -365) }).where(eq(schema.engagements.id, q.engagement.id));
    await ensureRenewalDecisions(s.workspaceId);
    const before = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, q.engagement.id), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG"])) });
    expect(before?.status).toBe("ZU_KLAEREN");

    const ctxList = await engagementContext(s.accountId);
    expect(ctxList.some((e) => e.person === "Sophia Rosenblatt" && e.renewal === "zu klären")).toBe(true);
    expect(matchEngagementByName(ctxList, "Bitte um Verlängerung des Vertrags von Frau Rosenblatt.")?.id).toBe(q.engagement.id);

    const r = await smartDump(david, { setupId: s.setupId, text: MAIL });
    expect(r.created).toBeGreaterThan(0);
    const sugg = await db.query.suggestions.findMany({ where: and(eq(schema.suggestions.setupId, s.setupId), eq(schema.suggestions.aiJobId, r.job.id)) });
    const ren = sugg.find((x) => x.type === "VERLAENGERUNG");
    expect(ren?.objectType).toBe("ENGAGEMENT");
    expect(ren?.objectId).toBe(q.engagement.id);
    const sabine = sugg.find((x) => x.type === "PERSON" && x.mentionedPersonName === "Sabine Sander");
    expect(sabine?.mentionedPersonRole).toBe("HR Business Partner (K) & Rekrutierung");
    expect(sabine?.mentionedPersonEmail).toBe("sabine.sander@musterversicherung.example");
    const silke = sugg.find((x) => x.type === "PERSON" && x.mentionedPersonName === "Silke Dornbusch");
    expect(silke?.mentionedPersonUnit).toBe("Dienstleistungs-Einkauf");
    expect(sugg.some((x) => x.type === "PERSON" && /Beispiel/.test(x.mentionedPersonName ?? ""))).toBe(false);
    expect(sugg.some((x) => x.type === "PERSON" && /Grüße/.test(x.mentionedPersonName ?? ""))).toBe(false);

    // BD übernimmt die Verlängerung: Ende +12 Monate vorbelegt, direkt bestätigt
    const newEnd = addMonthsIsoForTest(plusDaysIso(todayIso(), 60), 12);
    const acc = await acceptSuggestion(david, ren!.id, { version: ren!.version, newEnd });
    expect(acc.acceptedObjectType).toBe("RENEWAL");
    expect(acc.message).toMatch(/bestätigt/);
    const eng = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, q.engagement.id) });
    expect(eng?.plannedEnd).toBe(newEnd);
    const open = await db.query.renewalDecisions.findFirst({ where: and(eq(schema.renewalDecisions.engagementId, q.engagement.id), inArray(schema.renewalDecisions.status, ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"])) });
    expect(open).toBeUndefined();

    // Person mit Funktion übernehmen → angelegt mit Funktion und E-Mail
    const pa = await acceptSuggestion(david, sabine!.id, { version: sabine!.version });
    expect(pa.acceptedObjectType).toBe("PERSON");
    const person = await db.query.persons.findFirst({ where: eq(schema.persons.id, pa.acceptedObjectId) });
    expect(person?.email).toBe("sabine.sander@musterversicherung.example");
    const fn = await db.query.personFunctions.findFirst({ where: eq(schema.personFunctions.personId, pa.acceptedObjectId) });
    expect(fn?.functionTitle).toBe("HR Business Partner (K) & Rekrutierung");
    const pu = await acceptSuggestion(david, silke!.id, { version: silke!.version });
    const fu = await db.query.personFunctions.findFirst({ where: eq(schema.personFunctions.personId, pu.acceptedObjectId) });
    const unit = fu?.orgUnitId ? await db.query.orgUnits.findFirst({ where: eq(schema.orgUnits.id, fu.orgUnitId) }) : null;
    expect(unit?.name).toBe("Dienstleistungs-Einkauf");
  });
});
