import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { resetConfigCacheForTests } from "@/lib/config";
import { answerInterview, discardInterview, finishInterview, getInterview, startInterview } from "@/modules/interviews/service";
import { applyIntake, formToApplyInput, getIntake } from "@/modules/intake/service";
import { getBuyingCenter, upsertAssessment } from "@/modules/people/assessments";
import { acceptSuggestion, listMySuggestions, listSuggestionsForSetup } from "@/modules/suggestions/service";
import { addMember, createSetup } from "@/modules/setups/service";
import { createPerson } from "@/modules/people/service";
import { captureObservation } from "@/modules/signals/service";
import { TestProvider } from "@/modules/ai/providers/test";
import { interviewNextSchema } from "@/modules/ai/schemas";
import { actorFor, ensureSeed } from "./helpers";

process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "verve-uploads-"));

describe("Etappe 7A: Interview mit Rückfragen und Folgeaktivitäten", () => {
  it("Neuer Kunde: Fragen folgen den offenen Themen, vage Antwort löst Nachfrage aus, Abschluss erzeugt Quelle INTERVIEW und Anlagevorschlag mit Aktionen und Kontaktaufnahmen", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    await ensureSeed();
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    await expect(startInterview(nina, { kind: "KUNDE_NEU" })).rejects.toBeInstanceOf(ForbiddenError);

    const iv = await startInterview(david, { kind: "KUNDE_NEU", title: "Testinterview Musterwerk" });
    let d = await getInterview(david, iv.id);
    expect(d.turns).toHaveLength(1);
    expect(d.turns[0]?.role).toBe("KI");
    expect(d.turns[0]?.text).toMatch(/Organisation/);

    // Fremder sieht das Interview nicht
    const lars = await actorFor("lars");
    await expect(getInterview(lars, iv.id)).rejects.toBeInstanceOf(NotFoundError);
    // Abschluss ohne Antwort ist nicht möglich
    await expect(finishInterview(david, iv.id)).rejects.toBeInstanceOf(ValidationError);

    await answerInterview(david, { interviewId: iv.id, text: "Es geht um die Musterwerk GmbH, ein mittelständischer Logistiker." });
    await answerInterview(david, { interviewId: iv.id, text: "Anlass ist die Ablösung des Lagersystems; die Musterwerk GmbH plant den Start bald." });
    d = await getInterview(david, iv.id);
    const lastQ = d.turns[d.turns.length - 1];
    expect(lastQ?.role).toBe("KI");
    expect(lastQ?.text).toMatch(/^Du sagtest/); // Nachfrage bei „bald“
    await answerInterview(david, { interviewId: iv.id, text: "Herr Berger sagte: Start der Migration ist für Mitte 2027 geplant." });
    await answerInterview(david, { interviewId: iv.id, text: "Gesprochen habe ich mit Herrn Berger, Leiter IT, zuständig für die Systemlandschaft; Frau Sommer, Einkauf, war dabei. Zu Herrn Dr. Kaya, CIO, besteht noch kein Kontakt." });
    await answerInterview(david, { interviewId: iv.id, text: "Herr Berger sucht Unterstützung bei der Testkoordination. Herr Berger schickt bis 30.09. das Grobkonzept." });
    await answerInterview(david, { interviewId: iv.id, text: "fertig" });
    d = await getInterview(david, iv.id);
    expect(d.interview.status).toBe("LAUFEND");
    expect(d.turns[d.turns.length - 1]?.role).toBe("NUTZER"); // keine weitere Frage nach „fertig“
    expect(d.topics.filter((t) => t.covered).length).toBeGreaterThanOrEqual(3);

    const fin = await finishInterview(david, iv.id);
    expect(fin.source.type).toBe("INTERVIEW");
    expect(fin.source.setupId).toBeNull();
    expect(fin.source.accessClass).toBe("PERSOENLICH");
    expect(fin.source.body).toContain("Antwort: Es geht um die Musterwerk GmbH");
    await expect(answerInterview(david, { interviewId: iv.id, text: "noch etwas" })).rejects.toBeInstanceOf(TransitionError);

    const prop = await getIntake(david, fin.proposal.id);
    expect(prop.proposal.kind).toBe("INTERVIEW");
    expect(prop.payload.organization?.name).toContain("Musterwerk GmbH");
    expect(prop.payload.persons.map((p) => p.displayName)).toEqual(expect.arrayContaining(["Herr Berger", "Frau Sommer"]));
    expect(prop.payload.actions.length).toBeGreaterThan(0);
    expect(prop.payload.contacts.some((c) => c.personName.includes("Kaya"))).toBe(true);
    const berger = prop.payload.persons.find((p) => p.displayName === "Herr Berger");
    expect(berger?.decisionRole).toBe("BUDGETVERANTWORTUNG");

    // Übernahme: Aktionen/Kontaktaufnahmen werden Vorschläge für die adressierte Rolle; Einschätzung als Hypothese mit Quelle
    const form = formToApplyInput({
      orgName: "Musterwerk GmbH",
      setupName: "Erstkontakt Musterwerk (Interview)",
      documentAccessClass: "SETUP",
      "persons.0.include": "on",
      "persons.0.displayName": "Herr Berger",
      "persons.0.functionTitle": "Leiter IT",
      "persons.0.decisionRole": "BUDGETVERANTWORTUNG",
      "persons.0.stance": "POSITIV",
      "persons.0.influence": "HOCH",
      "persons.0.assessmentNote": "Aus dem Interview",
      "actions.0.include": "on",
      "actions.0.title": "Grobkonzept von Herrn Berger nachhalten",
      "actions.0.ownerRole": "BD",
      "actions.0.dueHint": "bis 30.09.",
      "contacts.0.include": "on",
      "contacts.0.personName": "Herr Dr. Kaya",
      "contacts.0.viaVerveName": "",
      "contacts.0.occasion": "Entscheider ohne Kontakt",
      "contacts.0.draftMessage": "Guten Tag Herr Dr. Kaya, … (Entwurf)",
      "openQuestions.0.include": "on",
      "openQuestions.0.question": "Wer gibt das Budget frei?",
    });
    const res = await applyIntake(david, fin.proposal.id, form);
    expect(res.problems).toEqual([]);
    expect(res.created).toMatchObject({ persons: 1, actions: 1, contacts: 1, questions: 1, assessments: 1 });
    const src = await db.query.sources.findFirst({ where: eq(schema.sources.id, fin.source.id) });
    expect(src?.setupId).toBe(res.setupId);
    const sugg = await listSuggestionsForSetup(david, res.setupId);
    const all = [...sugg.prominent, ...sugg.more];
    const kontakt = all.find((s) => s.type === "KONTAKTAUFNAHME");
    expect(kontakt?.targetRole).toBe("ANKER");
    expect(kontakt?.nextStep).toContain("Entwurf");
    expect(all.some((s) => s.type === "AKTION" && s.title.includes("Grobkonzept"))).toBe(true);
    expect(all.some((s) => s.type === "OFFENE_FRAGE")).toBe(true);
    // Vorschläge erscheinen in „Meine Arbeit“ des BD
    const mine = await listMySuggestions(david);
    expect(mine.some((s) => s.setupId === res.setupId)).toBe(true);
    // Annahme der Kontaktaufnahme erzeugt eine Aktion mit dem Entwurf als Vereinbarungstext
    const acc = await acceptSuggestion(david, kontakt!.id, { version: kontakt!.version });
    expect(acc.acceptedObjectType).toBe("ACTION");
    const action = await db.query.actions.findFirst({ where: eq(schema.actions.id, acc.acceptedObjectId) });
    expect(action?.title).toContain("Kontaktaufnahme Herr Dr. Kaya");
    expect(action?.agreement).toContain("Entwurf");
    // Einschätzung: Hypothese mit Interviewquelle
    const bc = await getBuyingCenter(david, res.setupId);
    const bergerRow = bc.rows.find((r) => r.person.displayName === "Herr Berger");
    expect(bergerRow?.assessment?.decisionRole).toBe("BUDGETVERANTWORTUNG");
    expect(bergerRow?.assessment?.epistemicStatus).toBe("HYPOTHESE");
    expect(bergerRow?.assessment?.sourceId).toBe(fin.source.id);
    expect(bc.gaps.some((g) => g.includes("Hypothesen"))).toBe(true);
  });

  it("Setup-Ergänzung: bekannter Kontext wird nicht erneut gefragt; Vorschlag ergänzt das bestehende Setup ohne neuen Kunden; ohne KI feste Fragenfolge", async () => {
    process.env.AI_PROVIDER = "disabled";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const lars = await actorFor("lars");
    const setup = await createSetup(david, { accountId: s.accountId, name: `Interviewtest ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });
    await expect(startInterview(lars, { kind: "SETUP_ERGAENZUNG", setupId: setup.id })).rejects.toBeInstanceOf(NotFoundError);
    const iv = await startInterview(david, { kind: "SETUP_ERGAENZUNG", setupId: setup.id });
    let d = await getInterview(david, iv.id);
    expect(d.turns[0]?.text).not.toMatch(/Organisation/); // Kunde ist bekannt
    expect(d.turns[0]?.rationale).toMatch(/ohne KI/);
    await answerInterview(david, { interviewId: iv.id, text: "Anlass ist die Verlängerung; Frau Keller, Einkauf, entscheidet über den Rahmenvertrag." });
    const fin = await finishInterview(david, iv.id);
    expect(fin.source.setupId).toBe(setup.id);
    expect(fin.source.accessClass).toBe("SETUP");
    const prop = await getIntake(david, fin.proposal.id);
    expect(prop.proposal.targetSetupId).toBe(setup.id);
    expect(prop.payload.aiStatus).toBe("ohne_ki");
    const res = await applyIntake(david, fin.proposal.id, formToApplyInput({ documentAccessClass: "ACCOUNT_TEAM", "signals.0.include": "on", "signals.0.observation": "Frau Keller entscheidet über den Rahmenvertrag.", "signals.0.relevanceHypothesis": "" }));
    expect(res.accountId).toBe(s.accountId);
    expect(res.setupId).toBe(setup.id);
    expect(res.created.signals).toBe(1);
    const src = await db.query.sources.findFirst({ where: eq(schema.sources.id, fin.source.id) });
    expect(src?.accessClass).toBe("SETUP"); // bereits zugeordnet, Zugriffsklasse bleibt
    d = await getInterview(david, iv.id);
    expect(d.interview.status).toBe("ABGESCHLOSSEN");
    // Verwerfen eines zweiten Interviews
    const iv2 = await startInterview(david, { kind: "SETUP_ERGAENZUNG", setupId: setup.id });
    await discardInterview(david, iv2.id);
    expect((await getInterview(david, iv2.id)).interview.status).toBe("VERWORFEN");
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
  });

  it("Testanbieter liefert schemakonforme Interviewfragen und beendet bei „fertig“", async () => {
    const p = new TestProvider();
    const first = await p.interviewNext({ kind: "KUNDE_NEU", knownContext: "", transcript: [], questionCount: 0, maxQuestions: 14 });
    expect(interviewNextSchema.safeParse(first).success).toBe(true);
    expect(first.done).toBe(false);
    const done = await p.interviewNext({ kind: "KUNDE_NEU", knownContext: "", transcript: [{ role: "KI", text: first.question }, { role: "NUTZER", text: "fertig" }], questionCount: 1, maxQuestions: 14 });
    expect(done.done).toBe(true);
  });
});

describe("Etappe 7B: Personenbewertung und Buyingcenter", () => {
  it("Bewertung als Hypothese; Bestätigung nur mit sichtbarer Quelle; Sichtbarkeit BD/Principal/Beziehungshalter, nicht CEO; Lücken werden benannt", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const petra = await actorFor("petra");
    const clemens = await actorFor("clemens");
    const nina = await actorFor("nina");
    const lars = await actorFor("lars");
    const setup = await createSetup(david, { accountId: s.accountId, name: `Bewertungstest ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });
    const person = await createPerson(david, { accountId: s.accountId, displayName: "Frau Test-Budget", functionTitle: "CFO", setupId: setup.id });
    // Anker Nina ist Mitglied (lesend) und hält die Beziehung zu einer zweiten Person
    await addMember(david, setup.id, { userId: nina.userId, contribution: "ANKER_EINFUEHRUNG" });
    const person2 = await createPerson(david, { accountId: s.accountId, displayName: "Herr Test-Fach", functionTitle: "Architekt", setupId: setup.id });
    await db.insert(schema.relationships).values({ personId: person2.id, holderUserId: nina.userId, setupId: setup.id, state: "IM_AUSTAUSCH", createdBy: nina.userId });

    await expect(upsertAssessment(lars, { personId: person.id, setupId: setup.id, stance: "POSITIV" })).rejects.toBeInstanceOf(NotFoundError);
    // Bestätigen ohne Quelle abgelehnt
    await expect(upsertAssessment(david, { personId: person.id, setupId: setup.id, decisionRole: "BUDGETVERANTWORTUNG", confirm: true })).rejects.toBeInstanceOf(ValidationError);
    const hyp = await upsertAssessment(david, { personId: person.id, setupId: setup.id, decisionRole: "BUDGETVERANTWORTUNG", stance: "KRITISCH", influence: "HOCH", note: "Vermutung aus dem Gespräch" });
    expect(hyp.epistemicStatus).toBe("HYPOTHESE");
    const { source } = await captureObservation(david, { setupId: setup.id, observation: "Frau Test-Budget hat gesagt, sie entscheidet über das Budget." });
    const confirmed = await upsertAssessment(david, { personId: person.id, setupId: setup.id, decisionRole: "BUDGETVERANTWORTUNG", stance: "NEUTRAL", influence: "HOCH", sourceId: source.id, confirm: true, version: hyp.version });
    expect(confirmed.epistemicStatus).toBe("SACHVERHALT_BESTAETIGT");
    expect(confirmed.version).toBe(hyp.version + 1);

    // Anker Nina (Mitglied) bewertet „ihre“ Person; CEO ohne Mitgliedschaft und Beziehung darf nicht bewerten
    await upsertAssessment(nina, { personId: person2.id, setupId: setup.id, decisionRole: "FACHLICHE_BEWERTUNG", stance: "POSITIV", influence: "MITTEL" });
    await expect(upsertAssessment(clemens, { personId: person.id, setupId: setup.id, stance: "POSITIV" })).rejects.toBeInstanceOf(ForbiddenError);

    // Sichtbarkeit
    const bcDavid = await getBuyingCenter(david, setup.id);
    expect(bcDavid.rows.filter((r) => r.assessment).length).toBe(2);
    expect(bcDavid.gaps.some((g) => g.includes("Bedarfsträger"))).toBe(true);
    expect(bcDavid.gaps.some((g) => g.includes("noch kein Kontakt"))).toBe(true); // Frau Test-Budget nur „Name/Funktion bekannt“
    const bcPetra = await getBuyingCenter(petra, setup.id);
    expect(bcPetra.rows.filter((r) => r.assessment).length).toBe(2);
    const bcClemens = await getBuyingCenter(clemens, setup.id);
    expect(bcClemens.rows.every((r) => r.assessment === null)).toBe(true);
    expect(bcClemens.rows.filter((r) => r.assessmentHidden).length).toBe(2);
    const bcNina = await getBuyingCenter(nina, setup.id);
    expect(bcNina.rows.find((r) => r.person.id === person2.id)?.assessment).toBeTruthy();
    const audit = await db.query.auditEvents.findMany({ where: and(eq(schema.auditEvents.objectType, "PERSON_ASSESSMENT"), eq(schema.auditEvents.objectId, confirmed.id)) });
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit.map((a) => a.changes))).not.toContain("Vermutung aus dem Gespräch");
  });
});
