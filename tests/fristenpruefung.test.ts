import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, TransitionError } from "@/lib/errors";
import { createOpportunity } from "@/modules/opportunities/service";
import { purgeExpiredLogs, pseudonymizePerson, retentionReview } from "@/modules/governance/service";
import { createPerson, setRelationship } from "@/modules/people/service";
import { createSetup } from "@/modules/setups/service";
import { actorFor, ensureSeed } from "./helpers";

function yearsAgo(years: number): Date {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

/**
 * Etappe 18: Löschung von Ansprechpartnern ohne aktive Beziehung und automatische Fristenprüfung
 * (docs/pilotfreigabe-vorschlag.md Abschnitt 6/7). Nur ADMIN; nichts wird ohne bewusste Aktion verändert.
 */
describe("Etappe 18: Fristenprüfung und Löschung von Ansprechpartnern", () => {
  it("Ansprechpartner ohne aktive Beziehung: Löschung nur nach 'nicht aktiv', pseudonymisiert Stammdaten, Metadaten bleiben", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const admin = await actorFor("admin");
    const setup = await createSetup(david, { accountId: s.accountId, name: `Löschtest ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });
    const person = await createPerson(david, { accountId: s.accountId, setupId: setup.id, displayName: `Herr Loeschbar ${Date.now().toString(36)}`, email: "loeschbar@kunde.example", phone: "+49 123", functionTitle: "Leiter Einkauf", knownResponsibility: "Verantwortet den Rahmenvertrag." });

    // Aktive Beziehung → Löschung abgelehnt
    await expect(pseudonymizePerson(admin, { personId: person.id, reason: "Testlöschung" })).rejects.toBeInstanceOf(TransitionError);

    // Beziehung auf „nicht aktiv“ setzen
    await setRelationship(david, { personId: person.id, setupId: setup.id, holderUserId: david.userId, state: "NICHT_AKTIV", contextNote: "Kein Kontakt mehr seit Projektende." });

    // Nur ADMIN darf löschen
    await expect(pseudonymizePerson(david, { personId: person.id, reason: "Testlöschung" })).rejects.toBeInstanceOf(ForbiddenError);

    const r = await pseudonymizePerson(admin, { personId: person.id, reason: "Fristenprüfung: keine aktive Beziehung mehr." });
    expect(r.relationships).toBeGreaterThanOrEqual(1);
    const after = await db.query.persons.findFirst({ where: eq(schema.persons.id, person.id) });
    expect(after?.displayName).toBe("[gelöscht]");
    expect(after?.email).toBeNull();
    expect(after?.phone).toBeNull();
    expect(after?.accountId).toBe(s.accountId); // Metadaten bleiben
    const fn = await db.query.personFunctions.findFirst({ where: eq(schema.personFunctions.personId, person.id) });
    expect(fn?.knownResponsibility).toBeNull();
    const rel = await db.query.relationships.findFirst({ where: eq(schema.relationships.personId, person.id) });
    expect(rel?.contextNote).toBe("[Inhalt gelöscht]");

    // Erneute Löschung abgelehnt
    await expect(pseudonymizePerson(admin, { personId: person.id, reason: "Nochmal" })).rejects.toBeInstanceOf(TransitionError);
  });

  it("Fristenprüfung: ermittelt fällige Ansprechpartner (>3 Jahre ohne aktive Beziehung) und fällige Quellen (>3 Jahre), zählt Protokoll/KI-Aufträge/Belege", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const admin = await actorFor("admin");
    await expect(retentionReview(david)).rejects.toBeInstanceOf(ForbiddenError);

    const setup = await createSetup(david, { accountId: s.accountId, name: `Fristen ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });

    // Person ohne aktive Beziehung, aber erst kürzlich inaktiv geworden → noch nicht fällig
    const recentPerson = await createPerson(david, { accountId: s.accountId, setupId: setup.id, displayName: `Frau Kuerzlich ${Date.now().toString(36)}` });
    await setRelationship(david, { personId: recentPerson.id, setupId: setup.id, holderUserId: david.userId, state: "NICHT_AKTIV", contextNote: "Gerade erst inaktiv." });

    // Person ohne aktive Beziehung, seit über 3 Jahren → fällig
    const overduePerson = await createPerson(david, { accountId: s.accountId, setupId: setup.id, displayName: `Herr Ueberfaellig ${Date.now().toString(36)}` });
    await setRelationship(david, { personId: overduePerson.id, setupId: setup.id, holderUserId: david.userId, state: "NICHT_AKTIV", contextNote: "Lange inaktiv." });
    await db.update(schema.relationships).set({ updatedAt: yearsAgo(4) }).where(eq(schema.relationships.personId, overduePerson.id));

    // Person mit aktiver Beziehung, aber sehr alt → nie fällig, solange die Beziehung aktiv ist
    const activePerson = await createPerson(david, { accountId: s.accountId, setupId: setup.id, displayName: `Frau Aktiv ${Date.now().toString(36)}` });
    await setRelationship(david, { personId: activePerson.id, setupId: setup.id, holderUserId: david.userId, state: "IM_AUSTAUSCH", contextNote: "Laufender Austausch.", evidenceNote: "Telefonat am Montag besprochen." });
    await db.update(schema.relationships).set({ updatedAt: yearsAgo(5) }).where(eq(schema.relationships.personId, activePerson.id));

    // Quelle, seit über 3 Jahren, nicht gesperrt → fällig
    const [oldSource] = await db
      .insert(schema.sources)
      .values({ workspaceId: david.workspaceId, setupId: setup.id, type: "NOTIZ", title: "Alte Notiz", body: "Text", origin: "manuell", sourceTime: yearsAgo(4), ownerUserId: david.userId, accessClass: "SETUP" })
      .returning();
    // Quelle, seit über 3 Jahren, aber gesperrt → nicht in der Liste (bewusst ausgeschlossen, damit Sperrgrund erst gilt)
    await db.insert(schema.sources).values({ workspaceId: david.workspaceId, setupId: setup.id, type: "NOTIZ", title: "Alte, gesperrte Notiz", body: "Text", origin: "manuell", sourceTime: yearsAgo(4), ownerUserId: david.userId, accessClass: "SETUP", isLocked: true });
    // Quelle, aktuell → nicht fällig
    await db.insert(schema.sources).values({ workspaceId: david.workspaceId, setupId: setup.id, type: "NOTIZ", title: "Neue Notiz", body: "Text", origin: "manuell", sourceTime: new Date(), ownerUserId: david.userId, accessClass: "SETUP" });

    // KI-Auftrag, seit über 1 Jahr → fällig
    const [oldJob] = await db.insert(schema.aiJobs).values({ workspaceId: david.workspaceId, type: "FORM_SUGGEST", actorUserId: david.userId, provider: "test", model: "test", promptVersion: "v1", inputHash: "x", inputChars: 10, dedupeKey: `job-${Date.now()}` }).returning();
    await db.update(schema.aiJobs).set({ startedAt: yearsAgo(2) }).where(eq(schema.aiJobs.id, oldJob!.id));

    // Audit-Ereignis, seit über 3 Jahren → fällig
    const [oldAudit] = await db.insert(schema.auditEvents).values({ workspaceId: david.workspaceId, actorUserId: david.userId, action: "test.manual", objectType: "TEST", objectId: "x" }).returning();
    await db.update(schema.auditEvents).set({ at: yearsAgo(4) }).where(eq(schema.auditEvents.id, oldAudit!.id));

    // Angebot/Auftrag mit Belegcharakter, seit über 10 Jahren → fällig
    const opp = await createOpportunity(david, { setupId: setup.id, title: "Alte Chance", needDescription: "Alte Chance, längst abgeschlossen." });
    const [oldOffer] = await db.insert(schema.offers).values({ workspaceId: david.workspaceId, opportunityId: opp.id, title: "Altes Angebot", createdBy: david.userId }).returning();
    await db.update(schema.offers).set({ createdAt: yearsAgo(11) }).where(eq(schema.offers.id, oldOffer!.id));

    const review = await retentionReview(admin);
    expect(review.contacts.items.map((c) => c.personId)).toContain(overduePerson.id);
    expect(review.contacts.items.map((c) => c.personId)).not.toContain(recentPerson.id);
    expect(review.contacts.items.map((c) => c.personId)).not.toContain(activePerson.id);
    expect(review.sources.items.map((x) => x.id)).toContain(oldSource!.id);
    expect(review.sources.items.length).toBe(1); // gesperrte und neue Quelle nicht enthalten
    expect(review.aiJobs.total).toBeGreaterThanOrEqual(1);
    expect(review.auditEvents.total).toBeGreaterThanOrEqual(1);
    expect(review.belege.offers).toBeGreaterThanOrEqual(1);
  });

  it("Fällige Protokoll-/KI-Auftragseinträge löschen: entfernt nur, was die Frist überschritten hat; Verweise darauf werden gelöst statt die Fassung mitzulöschen", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const admin = await actorFor("admin");
    await expect(purgeExpiredLogs(david)).rejects.toBeInstanceOf(ForbiddenError);

    const setup = await createSetup(david, { accountId: s.accountId, name: `Purge ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });
    const opp = await createOpportunity(david, { setupId: setup.id, title: "Chance für Purge-Test", needDescription: "Testkoordination für den Löschtest der KI-Auftragsprotokolle." });

    const [oldJob] = await db.insert(schema.aiJobs).values({ workspaceId: david.workspaceId, type: "BUYING_CENTER_ADVICE", actorUserId: david.userId, provider: "test", model: "test", promptVersion: "v1", inputHash: "x", inputChars: 10, dedupeKey: `job-old-${Date.now()}` }).returning();
    await db.update(schema.aiJobs).set({ startedAt: yearsAgo(2) }).where(eq(schema.aiJobs.id, oldJob!.id));
    const [recentJob] = await db.insert(schema.aiJobs).values({ workspaceId: david.workspaceId, type: "BUYING_CENTER_ADVICE", actorUserId: david.userId, provider: "test", model: "test", promptVersion: "v1", inputHash: "y", inputChars: 10, dedupeKey: `job-new-${Date.now()}` }).returning();

    // Eine Berater-Fassung verweist auf den alten Auftrag – die Fassung selbst darf nicht verschwinden
    const [advice] = await db.insert(schema.buyingCenterAdvice).values({ workspaceId: david.workspaceId, opportunityId: opp.id, versionNo: 1, summary: "Testfassung, die den alten KI-Auftrag referenziert.", basis: "Testgrundlage", status: "ENTWURF", aiJobId: oldJob!.id, createdBy: david.userId }).returning();

    const [oldAudit] = await db.insert(schema.auditEvents).values({ workspaceId: david.workspaceId, actorUserId: david.userId, action: "test.old", objectType: "TEST", objectId: "x" }).returning();
    await db.update(schema.auditEvents).set({ at: yearsAgo(4) }).where(eq(schema.auditEvents.id, oldAudit!.id));
    const [recentAudit] = await db.insert(schema.auditEvents).values({ workspaceId: david.workspaceId, actorUserId: david.userId, action: "test.new", objectType: "TEST", objectId: "y" }).returning();

    const r = await purgeExpiredLogs(admin);
    expect(r.aiJobs).toBeGreaterThanOrEqual(1);
    expect(r.auditEvents).toBeGreaterThanOrEqual(1);

    expect(await db.query.aiJobs.findFirst({ where: eq(schema.aiJobs.id, oldJob!.id) })).toBeUndefined();
    expect(await db.query.aiJobs.findFirst({ where: eq(schema.aiJobs.id, recentJob!.id) })).toBeDefined();
    expect(await db.query.auditEvents.findFirst({ where: eq(schema.auditEvents.id, oldAudit!.id) })).toBeUndefined();
    expect(await db.query.auditEvents.findFirst({ where: eq(schema.auditEvents.id, recentAudit!.id) })).toBeDefined();

    // Die Fassung bleibt vollständig erhalten, nur der Verweis auf den gelöschten Auftrag entfällt
    const adviceAfter = await db.query.buyingCenterAdvice.findFirst({ where: eq(schema.buyingCenterAdvice.id, advice!.id) });
    expect(adviceAfter).toBeDefined();
    expect(adviceAfter?.summary).toBe("Testfassung, die den alten KI-Auftrag referenziert.");
    expect(adviceAfter?.aiJobId).toBeNull();
  });
});
