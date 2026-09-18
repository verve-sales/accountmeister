import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { createPerson, listPeopleForAccount, setPersonFunction, setRelationship } from "@/modules/people/service";
import { addAccessPlanStep, changeAccessPlanStatus, createAccessPlan, listAccessPlansForSetup } from "@/modules/accesspaths/service";
import { actorFor, ensureSeed } from "./helpers";

describe("Personen & Zugang (Briefing 8, F06)", () => {
  it("Person anlegen mit Funktion; nur berufliche Felder; Funktionswechsel schließt alte Funktion zeitlich ab", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const p = await createPerson(david, { accountId: s.accountId, displayName: "Herr Özdemir (fiktiv)", functionTitle: "Einkauf IT-Dienstleistungen", setupId: s.setupId });
    expect(p.accountId).toBe(s.accountId);
    expect(Object.keys(p)).not.toContain("notes"); // keine Freitext-Bewertungen an der Person
    await setPersonFunction(david, { personId: p.id, functionTitle: "Leitung Einkauf IT" });
    const fns = await db.query.personFunctions.findMany({ where: eq(schema.personFunctions.personId, p.id) });
    expect(fns).toHaveLength(2);
    expect(fns.filter((f) => !f.validTo)).toHaveLength(1);
    expect(fns.find((f) => !f.validTo)?.functionTitle).toBe("Leitung Einkauf IT");
    const list = await listPeopleForAccount(david, s.accountId, s.setupId);
    const entry = list.find((e) => e.person.id === p.id);
    expect(entry?.currentFunction?.functionTitle).toBe("Leitung Einkauf IT");
    expect(entry?.relationships[0]?.state).toBe("NAME_FUNKTION_BEKANNT");
  });

  it("Beziehungsstand ab „Vorgestellt“ braucht Beleg; Kontext ist immer Pflicht", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const brandt = (await db.query.persons.findMany({ where: eq(schema.persons.accountId, s.accountId) })).find((p) => p.displayName.startsWith("Frau Brandt"));
    expect(brandt).toBeDefined();
    await expect(setRelationship(david, { personId: brandt!.id, setupId: s.setupId, holderUserId: david.userId, state: "VORGESTELLT", contextNote: "Von Frau Keller vorgestellt." })).rejects.toBeInstanceOf(ValidationError);
    await expect(setRelationship(david, { personId: brandt!.id, setupId: s.setupId, holderUserId: david.userId, state: "VORSTELLUNG_ANGEFRAGT", contextNote: "" })).rejects.toBeInstanceOf(ValidationError);
    const rel = await setRelationship(david, {
      personId: brandt!.id,
      setupId: s.setupId,
      holderUserId: david.userId,
      state: "VORGESTELLT",
      contextNote: "Frau Keller hat David per Mail vorgestellt.",
      evidenceNote: "Fiktive Demo-Mail vom 20.09.: „Ich verbinde Sie gern mit Herrn Demo.“",
    });
    expect(rel?.state).toBe("VORGESTELLT");
    expect(rel?.evidenceSourceId).toBeTruthy();
  });

  it("F06: Kontaktweg – belegte Verbindung nur mit Beziehung/Quelle, sonst hypothetisch; Vorstellung braucht Beleg", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const persons = await db.query.persons.findMany({ where: eq(schema.persons.accountId, s.accountId) });
    const keller = persons.find((p) => p.displayName.startsWith("Frau Keller"))!;
    const brandt = persons.find((p) => p.displayName.startsWith("Frau Brandt"))!;
    const kellerRel = await db.query.relationships.findFirst({ where: eq(schema.relationships.personId, keller.id) });
    expect(kellerRel?.state).toBe("IM_AUSTAUSCH");

    const plan = await createAccessPlan(david, {
      setupId: s.setupId,
      targetPersonId: brandt.id,
      occasion: "Klären, ob externe Testkoordination für die nächste Phase relevant ist.",
      desiredOutcome: "Kurzer Austausch mit Frau Brandt.",
      allowedIntroContent: "Bestehende Zusammenarbeit im Plattformteam; keine internen Beobachtungen.",
    });
    expect(plan.status).toBe("ENTWURF");

    // Schritt 1: David → Frau Keller, belegt über bestehende Beziehung
    const step1 = await addAccessPlanStep(david, { accessPlanId: plan.id, fromUserId: david.userId, toPersonId: keller.id, kind: "BELEGT", relationshipId: kellerRel!.id });
    expect(step1?.kind).toBe("BELEGT");

    // Schritt 2: Frau Keller → Frau Brandt als „belegt“ ohne Beleg → abgelehnt
    await expect(addAccessPlanStep(david, { accessPlanId: plan.id, fromPersonId: keller.id, toPersonId: brandt.id, kind: "BELEGT" })).rejects.toBeInstanceOf(ValidationError);
    // Beziehung „Name/Funktion bekannt“ belegt keine Verbindung
    const unknown = await createPerson(david, { accountId: s.accountId, displayName: "Herr Nur-Bekannt (fiktiv)", setupId: s.setupId });
    const unknownRel = await db.query.relationships.findFirst({ where: eq(schema.relationships.personId, unknown.id) });
    expect(unknownRel?.state).toBe("NAME_FUNKTION_BEKANNT");
    await expect(addAccessPlanStep(david, { accessPlanId: plan.id, fromUserId: david.userId, toPersonId: unknown.id, kind: "BELEGT", relationshipId: unknownRel!.id })).rejects.toBeInstanceOf(ValidationError);
    // Als hypothetisch ist der Schritt zulässig
    const step2 = await addAccessPlanStep(david, { accessPlanId: plan.id, fromPersonId: keller.id, toPersonId: brandt.id, kind: "HYPOTHETISCH", note: "Vermutlich kennen sich beide aus dem Programm." });
    expect(step2?.kind).toBe("HYPOTHETISCH");

    const listed = await listAccessPlansForSetup(david, s.setupId);
    const mine = listed.find((p) => p.id === plan.id)!;
    expect(mine.steps.map((x) => x.kind)).toEqual(["BELEGT", "HYPOTHETISCH"]);

    // Statuslogik: Zusage braucht Bereitschaft „bereit“; Vorstellung braucht Quelle
    const inAbst = await changeAccessPlanStatus(david, plan.id, { version: plan.version, status: "IN_ABSTIMMUNG" });
    await expect(changeAccessPlanStatus(david, plan.id, { version: inAbst.version, status: "VERMITTLUNG_ZUGESAGT" })).rejects.toBeInstanceOf(ValidationError);
    await addAccessPlanStep(david, { accessPlanId: plan.id, fromPersonId: keller.id, toPersonId: brandt.id, kind: "GEPLANT", mediationReadiness: "BEREIT", note: "Frau Keller hat zugesagt zu verbinden." });
    const zugesagt = await changeAccessPlanStatus(david, plan.id, { version: inAbst.version, status: "VERMITTLUNG_ZUGESAGT" });
    await expect(changeAccessPlanStatus(david, plan.id, { version: zugesagt.version, status: "VORGESTELLT" })).rejects.toBeInstanceOf(ValidationError);
    const src = await db.query.sources.findFirst({ where: eq(schema.sources.setupId, s.setupId) });
    const vorgestellt = await changeAccessPlanStatus(david, plan.id, { version: zugesagt.version, status: "VORGESTELLT", evidenceSourceId: src!.id });
    expect(vorgestellt.status).toBe("VORGESTELLT");
    await expect(changeAccessPlanStatus(david, plan.id, { version: vorgestellt.version, status: "ENTWURF" })).rejects.toBeInstanceOf(TransitionError);
  });

  it("Zugriff: fremder BD sieht Personen und Kontaktwege nicht; Principal liest, pflegt aber nicht", async () => {
    const s = await ensureSeed();
    const lars = await actorFor("lars");
    const petra = await actorFor("petra");
    await expect(listPeopleForAccount(lars, s.accountId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listAccessPlansForSetup(lars, s.setupId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listPeopleForAccount(petra, s.accountId)).length).toBeGreaterThan(0);
    const keller = (await db.query.persons.findMany({ where: eq(schema.persons.accountId, s.accountId) })).find((p) => p.displayName.startsWith("Frau Keller"))!;
    await expect(setRelationship(petra, { personId: keller.id, setupId: s.setupId, holderUserId: petra.userId, state: "VORSTELLUNG_ANGEFRAGT", contextNote: "Petra möchte vorgestellt werden." })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
