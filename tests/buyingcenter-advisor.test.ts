import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { resetConfigCacheForTests } from "@/lib/config";
import { addParticipation, createOpportunity } from "@/modules/opportunities/service";
import { getBuyingCenterAdvice, proposeBuyingCenterAdvice, saveBuyingCenterAdvice } from "@/modules/opportunities/buyingCenterAdvisor";
import { suggestFormFields } from "@/modules/strategy/formsuggest";
import { createPerson } from "@/modules/people/service";
import { createSetup } from "@/modules/setups/service";
import { actorFor, ensureSeed } from "./helpers";

/**
 * Etappe 17: Buying-Center-Berater (geht die sechs Entscheidungsrollen einer Chance durch, gibt Hinweise zu
 * Lücken) und MEDDPICC-Vorbefüllung über den bestehenden „Vorschlagen lassen“-Mechanismus. Beide sind nur mit
 * Textstelle, wo eine konkrete Angabe gemeint ist – reine Methodik-Hinweise brauchen keinen Beleg.
 */
describe("Etappe 17: Buying-Center-Berater und MEDDPICC-Vorbefüllung", () => {
  it("Rollenstatus wird aus dem Buyingcenter berechnet (offen/Hypothese/bestätigt); Hinweise nur zu Lücken, Person nur mit Beleg", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    const setup = await createSetup(david, { accountId: s.accountId, name: `BC-Test ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });
    const opp = await createOpportunity(david, { setupId: setup.id, title: "Testkoordination", needDescription: "Der Kunde braucht kurzfristig Unterstützung in der Testkoordination." });

    // Noch keine Rolle erfasst → alle sechs offen
    const before = await getBuyingCenterAdvice(david, opp.id);
    expect(before.roleStatus).toHaveLength(6);
    expect(before.roleStatus.every((r) => r.state === "OFFEN")).toBe(true);
    expect(before.latest).toBeNull();

    // Eine Rolle als Hypothese (ohne Quelle erlaubt)
    const person = await createPerson(david, { accountId: s.accountId, setupId: setup.id, displayName: `Frau Muster ${Date.now().toString(36)}` });
    await addParticipation(david, { opportunityId: opp.id, role: "BUDGETVERANTWORTUNG", personId: person.id, epistemicStatus: "HYPOTHESE" });

    // Eine Rolle bestätigt (Quelle nötig)
    const [src] = await db
      .insert(schema.sources)
      .values({ workspaceId: david.workspaceId, setupId: setup.id, type: "NOTIZ", title: "Beleg", body: "Herr Beispiel hat den Einkaufsweg im Termin erläutert.", origin: "manuell", sourceTime: new Date(), ownerUserId: david.userId, accessClass: "SETUP" })
      .returning();
    const person2 = await createPerson(david, { accountId: s.accountId, setupId: setup.id, displayName: `Herr Beispiel ${Date.now().toString(36)}` });
    await addParticipation(david, { opportunityId: opp.id, role: "EINKAUF_VERTRAGSWEG", personId: person2.id, epistemicStatus: "SACHVERHALT_BESTAETIGT", evidenceSourceId: src!.id });

    const mid = await getBuyingCenterAdvice(david, opp.id);
    const budget = mid.roleStatus.find((r) => r.role === "BUDGETVERANTWORTUNG")!;
    const einkauf = mid.roleStatus.find((r) => r.role === "EINKAUF_VERTRAGSWEG")!;
    const bedarf = mid.roleStatus.find((r) => r.role === "BEDARFSTRAEGER")!;
    expect(budget.state).toBe("HYPOTHESE");
    expect(budget.participants[0]?.name).toContain("Frau Muster");
    expect(einkauf.state).toBe("BESTAETIGT");
    expect(bedarf.state).toBe("OFFEN");

    // KI-Vorschlag: Hinweise nur zu Lücken (nicht zur bestätigten Rolle); Hypothese-Rolle darf mit Textstelle einen Personennamen nennen
    const p = await proposeBuyingCenterAdvice(david, opp.id);
    expect(p.proposal.roles.some((r) => r.role === "EINKAUF_VERTRAGSWEG")).toBe(false);
    const budgetHint = p.proposal.roles.find((r) => r.role === "BUDGETVERANTWORTUNG");
    expect(budgetHint?.hint).toBeTruthy();
    expect(budgetHint?.proposedPersonName).toContain("Frau Muster");
    expect(budgetHint?.evidenceQuote).toBeTruthy();
    const bedarfHint = p.proposal.roles.find((r) => r.role === "BEDARFSTRAEGER");
    expect(bedarfHint?.proposedPersonName ?? "").toBe(""); // offen, ohne Person – nichts erfunden

    // Speichern legt eine neue Fassung an, überschreibt nie
    const saved = await saveBuyingCenterAdvice(david, { opportunityId: opp.id, summary: p.proposal.summary, roles: p.proposal.roles, openQuestions: p.proposal.openQuestions });
    expect(saved.versionNo).toBe(1);
    const saved2 = await saveBuyingCenterAdvice(david, { opportunityId: opp.id, summary: "Zweite Fassung.", roles: [], openQuestions: [] });
    expect(saved2.versionNo).toBe(2);
    const after = await getBuyingCenterAdvice(david, opp.id);
    expect(after.versions).toHaveLength(2);
    expect(after.latest?.versionNo).toBe(2);

    // Nina sieht dieses frische Setup gar nicht – weder lesend noch schreibend
    await expect(proposeBuyingCenterAdvice(nina, opp.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveBuyingCenterAdvice(nina, { opportunityId: opp.id, summary: "Unbefugter Versuch einer Fassung.", roles: [], openQuestions: [] })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("MEDDPICC-Vorbefüllung über „Vorschlagen lassen“: nur Felder mit Grundlage, nichts erfunden, nichts gespeichert", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const setup = await createSetup(david, { accountId: s.accountId, name: `MEDDPICC-Test ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });
    const opp = await createOpportunity(david, {
      setupId: setup.id,
      title: "Testkoordination Release Q4",
      needDescription: "Der Kunde sucht kurzfristig Unterstützung in der Testkoordination für das Q4-Release.",
      trigger: "Ein wichtiger Kunde hat für Dezember eine Vertragsstrafe angedroht, falls das Release nicht pünktlich kommt.",
    });
    const person = await createPerson(david, { accountId: s.accountId, setupId: setup.id, displayName: `Budget Beispiel ${Date.now().toString(36)}` });
    await addParticipation(david, { opportunityId: opp.id, role: "BUDGETVERANTWORTUNG", personId: person.id, epistemicStatus: "HYPOTHESE" });

    const fields = [
      { name: "identifyPain", label: "Identify Pain" },
      { name: "economicBuyer", label: "Economic Buyer" },
      { name: "champion", label: "Champion" },
      { name: "metrics", label: "Metrics" },
    ];
    const f = await suggestFormFields(david, { kind: "MEDDPICC", opportunityId: opp.id, fields });
    expect(f.suggestion?.fields.identifyPain).toContain("Vertragsstrafe");
    expect(f.suggestion?.fields.economicBuyer).toContain("Budget Beispiel");
    expect(f.suggestion?.fields.champion).toBeUndefined(); // kein Unterstützer/Sponsor erfasst – nichts erfunden
    expect(f.suggestion?.fields.metrics).toBeUndefined();
    // Nichts wurde gespeichert
    const fresh = await db.query.opportunities.findFirst({ where: eq(schema.opportunities.id, opp.id) });
    expect(fresh?.meddpicc).toBeNull();

    // Ohne opportunityId lehnt der Dienst ab, statt zu raten
    await expect(suggestFormFields(david, { kind: "MEDDPICC", fields })).rejects.toBeInstanceOf(ValidationError);
  });
});
