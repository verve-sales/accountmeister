import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ValidationError } from "@/lib/errors";
import { linkedinSearchUrl } from "@/lib/linkedin";
import { createAction } from "@/modules/actions/service";
import { createPerson, setPersonLinkedIn } from "@/modules/people/service";
import { createSetup } from "@/modules/setups/service";
import { actorFor, ensureSeed } from "./helpers";

/**
 * Etappe 18: LinkedIn als reine Referenz – keine Anbindung, nur ein von Hand gepflegter Profillink je Person,
 * ein Kanal „LinkedIn“ an Aktionen mit optionalem Link, und ein Deep-Link zur normalen LinkedIn-Personensuche
 * für offene Buying-Center-Rollen. Nichts davon ruft LinkedIn von der Anwendung aus auf.
 */
describe("Etappe 18: LinkedIn als Referenz (kein API-Zugriff)", () => {
  it("Person: LinkedIn-Profillink setzen, ändern und entfernen; nur ein linkedin.com-Link wird akzeptiert", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const setup = await createSetup(david, { accountId: s.accountId, name: `LinkedIn-Test ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });
    const person = await createPerson(david, { accountId: s.accountId, setupId: setup.id, displayName: `Frau LinkedIn ${Date.now().toString(36)}` });

    await expect(setPersonLinkedIn(david, { personId: person.id, linkedinUrl: "https://example.com/nicht-linkedin" })).rejects.toBeInstanceOf(ValidationError);

    await setPersonLinkedIn(david, { personId: person.id, linkedinUrl: "https://www.linkedin.com/in/frau-linkedin" });
    let row = await db.query.persons.findFirst({ where: eq(schema.persons.id, person.id) });
    expect(row?.linkedinUrl).toBe("https://www.linkedin.com/in/frau-linkedin");

    await setPersonLinkedIn(david, { personId: person.id, linkedinUrl: "" });
    row = await db.query.persons.findFirst({ where: eq(schema.persons.id, person.id) });
    expect(row?.linkedinUrl).toBeNull();
  });

  it("Person anlegen kann den LinkedIn-Link gleich mitgeben", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const setup = await createSetup(david, { accountId: s.accountId, name: `LinkedIn-Anlage ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });
    const person = await createPerson(david, { accountId: s.accountId, setupId: setup.id, displayName: `Herr Anlage ${Date.now().toString(36)}`, linkedinUrl: "https://www.linkedin.com/in/herr-anlage" });
    expect(person.linkedinUrl).toBe("https://www.linkedin.com/in/herr-anlage");
  });

  it("Aktion: Kanal LinkedIn mit Profillink speichern; ein Kanal ohne Link bleibt möglich", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const setup = await createSetup(david, { accountId: s.accountId, name: `Aktion-LinkedIn ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });
    const a = await createAction(david, { setupId: setup.id, title: "Auf LinkedIn nachfassen", ownerUserId: david.userId, channel: "LINKEDIN", linkedinUrl: "https://www.linkedin.com/in/kontaktperson" });
    expect(a.channel).toBe("LINKEDIN");
    expect(a.linkedinUrl).toBe("https://www.linkedin.com/in/kontaktperson");

    const b = await createAction(david, { setupId: setup.id, title: "Telefonat vereinbaren", ownerUserId: david.userId, channel: "TELEFON" });
    expect(b.channel).toBe("TELEFON");
    expect(b.linkedinUrl).toBeNull();

    const c = await createAction(david, { setupId: setup.id, title: "Ohne Kanalangabe", ownerUserId: david.userId });
    expect(c.channel).toBeNull();
  });

  it("Aktion: ein Link, der nicht zu linkedin.com gehört, wird abgelehnt", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const setup = await createSetup(david, { accountId: s.accountId, name: `Aktion-LinkedIn-invalid ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });
    await expect(createAction(david, { setupId: setup.id, title: "Auf LinkedIn nachfassen", ownerUserId: david.userId, channel: "LINKEDIN", linkedinUrl: "https://böse-seite.example/phish" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("linkedinSearchUrl baut einen Deep-Link zur LinkedIn-Personensuche aus Firma und Rolle, ohne Personennamen vorauszusetzen", () => {
    const url = linkedinSearchUrl("Beispiel GmbH", "Budgetverantwortung");
    expect(url).toBe(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent("Beispiel GmbH Budgetverantwortung")}`);
    expect(linkedinSearchUrl("Nur Firma", null, undefined, "")).toBe(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent("Nur Firma")}`);
  });
});
