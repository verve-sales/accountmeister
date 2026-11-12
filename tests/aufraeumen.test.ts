import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { resetConfigCacheForTests } from "@/lib/config";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { createAction, changeActionStatus } from "@/modules/actions/service";
import { captureObservation, changeSignalStatus } from "@/modules/signals/service";
import { createOpportunity, changeOpportunityStatus } from "@/modules/opportunities/service";
import { changePositionStatus, createPosition, quickFill } from "@/modules/staffing/service";
import { listConversions, startConversion, cancelConversion } from "@/modules/conversion/service";
import { discardIntakeCards, eingangFromText, moveIntakeCard } from "@/modules/eingang/service";
import { moveToSetup } from "@/modules/move/service";
import { FixtureSpClient, resetFixture, type SpClient } from "@/modules/sharepoint/client";
import { filesFor, fileFreelancerContract, linkSharePointFile, setupSite } from "@/modules/sharepoint/service";
import { loadActor } from "@/modules/identity/actor";
import { plusDaysIso, todayIso } from "@/modules/work/calendar";
import { actorFor, ensureSeed } from "./helpers";

function env() {
  process.env.AI_PROVIDER = "test";
  process.env.FEATURE_BESETZUNG = "true";
  process.env.SHAREPOINT_MODE = "fixture";
  resetConfigCacheForTests();
}

describe("e47: Aufräumen – ohne Begründung beenden, umhängen, zusammenlegen, SharePoint-Dateien wählen", () => {
  it("A01: Aufgabe, Beobachtung, Chance, Vorgang und Position enden ohne Begründung", async () => {
    env();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const a = await createAction(david, { setupId: s.setupId, title: `E47 Aufgabe ${Date.now()}`, ownerUserId: david.userId });
    const done = await changeActionStatus(david, a.id, { version: a.version, status: a.status === "VORGESCHLAGEN" ? "VERWORFEN" : "ERLEDIGT" });
    expect(["VERWORFEN", "ERLEDIGT"]).toContain(done.status);
    const { signal } = await captureObservation(david, { setupId: s.setupId, observation: "E47: Beobachtung ohne Begründung beenden." });
    expect((await changeSignalStatus(david, signal.id, { version: signal.version, status: "BEENDET" })).status).toBe("BEENDET");
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `E47 Chance ${Date.now()}`, needDescription: "Chance, die ohne Grund endet.", kind: "FREELANCER_EXPERTE" });
    const c = await startConversion(david, opp.id);
    expect((await cancelConversion(david, c.id, "")).endedReason).toBe("ohne Angabe");
    expect((await changeOpportunityStatus(david, opp.id, { version: opp.version, status: "BEENDET" })).status).toBe("BEENDET");
    // überzählige Position verschwindet aus den Vorgängen
    const opp2 = await createOpportunity(david, { setupId: s.setupId, title: `E47 Positionen ${Date.now()}`, needDescription: "Zwei Plätze, drei Positionen angelegt.", kind: "FREELANCER_EXPERTE" });
    await startConversion(david, opp2.id);
    await quickFill(david, opp2.id, { title: "Scrum Master", resourceKind: "FREELANCER", newName: `Eva Eins ${Date.now().toString(36)} (fiktiv)`, ekRate: "600", vkRate: "960", desiredStart: plusDaysIso(todayIso(), 14), plannedEnd: plusDaysIso(todayIso(), 120) });
    const extra = await createPosition(david, opp2.id, { title: "Scrum Master", resourceKind: "FREELANCER" });
    expect(await listConversions(david, opp2.id)).toHaveLength(2);
    await changePositionStatus(david, extra.id, { version: extra.version, status: "ABGEBROCHEN" });
    const rest = await listConversions(david, opp2.id);
    expect(rest).toHaveLength(1);
    expect(rest[0]!.position?.personName).toMatch(/Eva Eins/);
  });

  it("A02: Aufgabe und Beobachtung in ein anderes Setup (auch anderen Kunden) umhängen; Chancenbezug fällt weg", async () => {
    env();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const acc = await createAccount(david, { name: `Umhang AG ${Date.now().toString(36)} (fiktiv)`, orgType: "KONZERN", responsibleBdUserId: david.userId });
    const d2 = (await loadActor(david.userId))!;
    const other = await createSetup(d2, { accountId: acc.id, name: "Richtiges Team", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
    const opp = await createOpportunity(d2, { setupId: s.setupId, title: `E47 Bezug ${Date.now()}`, needDescription: "Chance im alten Setup.", kind: "FREELANCER_EXPERTE" });
    const a = await createAction(d2, { setupId: s.setupId, opportunityId: opp.id, title: "Falsch zugeordnete Aufgabe", ownerUserId: david.userId });
    const r = await moveToSetup(d2, "ACTION", a.id, other.id);
    expect(r.changed).toBe(true);
    const moved = (await db.query.actions.findFirst({ where: eq(schema.actions.id, a.id) }))!;
    expect(moved.setupId).toBe(other.id);
    expect(moved.opportunityId).toBeNull();
    const { signal } = await captureObservation(d2, { setupId: s.setupId, observation: "E47: gehört eigentlich zu einem anderen Kunden." });
    await moveToSetup(d2, "SIGNAL", signal.id, other.id);
    expect((await db.query.signals.findFirst({ where: eq(schema.signals.id, signal.id) }))!.setupId).toBe(other.id);
    await expect(moveToSetup(await actorFor("lars"), "SIGNAL", signal.id, s.setupId)).rejects.toThrow();
  });

  it("A03: Mail-Karten: einzeln verschieben (Bezüge des alten Kunden fallen weg) und ohne Rückfrage verwerfen, auch die ganze Mail", async () => {
    env();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const name = `Nordwind Logistik ${Date.now().toString(36)} GmbH`;
    const text = `${name}\nHamburg\n\nHallo Herr Beispiel,\nwir brauchen ab Januar zwei Scrum Master für unser Lagerprojekt. Nächster Schritt: Profile bis Ende des Monats schicken.\n\nViele Grüße\nPetra Wind\n--\n${name}`;
    const r = await eingangFromText(david, { text, setupId: s.setupId });
    const cards = (await db.query.suggestions.findMany({ where: eq(schema.suggestions.type, "KARTE") })).filter((c) => c.sourceIds.includes(r.sourceId) && ["NEU", "GEPRUEFT"].includes(c.status));
    expect(cards.length).toBeGreaterThan(1);
    const acc = await createAccount(david, { name: `Kartenziel AG ${Date.now().toString(36)} (fiktiv)`, orgType: "KONZERN", responsibleBdUserId: david.userId });
    const d2 = (await loadActor(david.userId))!;
    const target = await createSetup(d2, { accountId: acc.id, name: "Zielteam", bdUserId: david.userId, creatorContribution: "BD_ZUSTAENDIG" });
    const m = await moveIntakeCard(d2, cards[0]!.id, target.id);
    expect(m.accountName).toBe(acc.name);
    const after = (await db.query.suggestions.findFirst({ where: eq(schema.suggestions.id, cards[0]!.id) }))!;
    expect(after.setupId).toBe(target.id);
    expect(after.accountId).toBe(acc.id);
    expect(after.opportunityId).toBeNull();
    expect(await discardIntakeCards(d2, cards[1]!.id, false)).toBe(1);
    const n = await discardIntakeCards(d2, cards[0]!.id, true);
    expect(n).toBeGreaterThanOrEqual(1);
    const left = await db.query.suggestions.findMany({ where: inArray(schema.suggestions.id, cards.map((c) => c.id)) });
    expect(left.every((c) => c.status === "ABGELEHNT")).toBe(true);
  });

  it("A04: SharePoint – Dateien des Kunden und Freelancers auflisten und als Unterlage übernehmen; Seite und Typ folgen dem Ordner", async () => {
    env();
    resetFixture();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const ceo = await actorFor("clemens");
    const name = `Rita Rahmen ${Date.now().toString(36)} (fiktiv)`;
    const opp = await createOpportunity(david, { setupId: s.setupId, title: `E47 SharePoint ${Date.now()}`, needDescription: "Einsatz mit Unterlagen aus SharePoint.", kind: "FREELANCER_EXPERTE" });
    const q = await quickFill(david, opp.id, { title: "Scrum Master", resourceKind: "FREELANCER", newName: name, ekRate: "600", vkRate: "960", desiredStart: plusDaysIso(todayIso(), 14), plannedEnd: plusDaysIso(todayIso(), 120) });
    await setupSite(ceo);
    const acc = (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, s.accountId) }))!;
    // eine Bestellung liegt schon im Kundenordner, ein Vertrag beim Freelancer
    const client: SpClient = new FixtureSpClient();
    const libs = await client.libraries();
    const kunden = await client.driveOf(libs.find((l) => l.name === "Kunden")!.id);
    await client.upload(kunden, [acc.name, "Bestellungen"], "2026-11-12_Bestellung_Beispiel_4500.pdf", new ArrayBuffer(4));
    await fileFreelancerContract({ documentId: "-", accountName: acc.name, freelancerName: name, fileName: "Vertrag.docx", bytes: new ArrayBuffer(4), validFrom: null, validTo: null, status: "ENTWURF" });
    const files = await filesFor({ accountName: acc.name, freelancerName: name });
    expect(files?.error).toBeNull();
    const best = files!.groups.find((g) => g.kind === "KUNDE_BESTELLUNG")!;
    expect(best.files[0]!.name).toMatch(/Bestellung/);
    expect(files!.groups.some((g) => g.kind === "FL_VERTRAG")).toBe(true);
    const doc = await linkSharePointFile(david, q.engagement.id, best.files[0]!.value, { reference: "4500" });
    expect(doc).toMatchObject({ side: "KUNDE", docType: "BESTELLUNG", signedStatus: "UNTERSCHRIEBEN", reference: "4500" });
    expect(doc.link).toMatch(/Bestellungen/);
    expect((await db.query.contractDocuments.findFirst({ where: eq(schema.contractDocuments.id, doc.id) }))!.spItemId).toBeTruthy();
    // nur Kundenordner gefragt → keine Freelancer-Gruppen
    const onlyOffers = await filesFor({ accountName: acc.name, kinds: ["KUNDE_ANGEBOT", "KUNDE_BESTELLUNG"] });
    expect(onlyOffers!.groups.map((g) => g.kind)).toEqual(["KUNDE_BESTELLUNG"]);
    await expect(linkSharePointFile(david, q.engagement.id, "kaputt")).rejects.toThrow(/SharePoint wählen/);
  });
});
