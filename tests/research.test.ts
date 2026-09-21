import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { NotFoundError } from "@/lib/errors";
import { createAccount } from "@/modules/accounts/service";
import { getCompanyResearch, refreshCompanyResearch, type CompanyFact } from "@/modules/research/service";
import { actorFor, ensureSeed } from "./helpers";

/**
 * Etappe 16: öffentliche Unternehmensrecherche – eng begrenzte Ausnahme von „die KI recherchiert nicht im
 * Internet“. Der Fixture-Adapter liefert nie echte Web-Ergebnisse; geprüft wird die Begrenzung (nur der
 * Kunden-Firmenname geht ein, nie eine Person), die Speicherung als einzige aktuelle Fassung je Kunde, und dass
 * Sichtbarkeitsregeln des Kunden greifen.
 */
describe("Etappe 16: Öffentliche Unternehmensrecherche (Fixture-Anbieter)", () => {
  it("liefert Fixture-Fakten mit Quelle für den Seed-Kunden, speichert nur eine aktuelle Fassung je Kunde", async () => {
    const seed = await ensureSeed();
    const david = await actorFor("david");

    const before = await getCompanyResearch(david, seed.accountId);
    expect(before.latest).toBeNull();
    expect(before.adapterAvailable).toBe(true);

    const row = await refreshCompanyResearch(david, seed.accountId);
    expect(row.fixtureMode).toBe(true);
    const facts = row.facts as CompanyFact[];
    expect(facts.length).toBeGreaterThan(0);
    // Nur Firmenbezogene Angaben mit Quelle, keine Personennamen
    for (const f of facts) {
      expect(f.sourceLabel.length).toBeGreaterThan(0);
      expect(f.label).not.toMatch(/herr|frau/i);
    }

    const after = await getCompanyResearch(david, seed.accountId);
    expect(after.latest?.id).toBe(row.id);

    // Erneute Recherche überschreibt die Fassung (kein Verlauf) – weiterhin genau eine Zeile je Kunde
    await refreshCompanyResearch(david, seed.accountId);
    const rows = await db.query.companyResearch.findMany({ where: eq(schema.companyResearch.accountId, seed.accountId) });
    expect(rows).toHaveLength(1);

    // Auftragsprotokoll (Prüfspur)
    const audit = await db.query.auditEvents.findMany({ where: eq(schema.auditEvents.action, "research.company_refreshed") });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("Kunde ohne Fixture-Treffer erhält eine ehrliche Leermeldung statt erfundener Fakten", async () => {
    const david = await actorFor("david");
    const account = await createAccount(david, { name: `Unbekannte Firma ${Date.now().toString(36)} GmbH`, responsibleBdUserId: david.userId });
    const row = await refreshCompanyResearch(david, account.id);
    expect((row.facts as CompanyFact[])).toEqual([]);
    expect(row.note).toMatch(/keine Fixture-Daten/);
  });

  it("fremder BD sieht den Kunden nicht – weder lesend noch beim Aktualisieren", async () => {
    const seed = await ensureSeed();
    const lars = await actorFor("lars"); // BD eines anderen Kunden
    await expect(getCompanyResearch(lars, seed.accountId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(refreshCompanyResearch(lars, seed.accountId)).rejects.toBeInstanceOf(NotFoundError);
  });
});
