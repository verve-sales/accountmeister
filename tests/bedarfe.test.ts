import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import {
  addParticipation, addStartRequirement, changeOfferStatus, changeOpportunityStatus, confirmOpportunity, confirmOrder, createOffer, createOpportunity, createOrder,
  createProfileReference, getOpportunityDetail, listOpportunitiesForAccount, listProfileReferences, markReady, markStarted, presentOffer, saveMeddpicc, setRequirementStatus,
} from "@/modules/opportunities/service";
import { captureObservation } from "@/modules/signals/service";
import { createSetup } from "@/modules/setups/service";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 5: Bedarfe, Angebote, Aufträge (Briefing 8.3, 9.2–9.4, F02, F08, F09, F10, F16)", () => {
  it("F08: Bedarf direkt erfassen – ohne vollständiges Setup, ohne MEDDPICC; Fast-Track mit Messstart", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const setup = await createSetup(david, { accountId: s.accountId, name: "Direkte Anfrage Einkauf", contextNote: "", bdUserId: david.userId });
    const opp = await createOpportunity(david, { setupId: setup.id, title: "Testkoordination Release Q4", needDescription: "Der Kunde sucht kurzfristig Unterstützung in der Testkoordination für das Q4-Release.", fastTrack: "on" });
    expect(opp.status).toBe("IN_KLAERUNG");
    expect(opp.fastTrack).toBe(true);
    expect(opp.requestedAt).toBeInstanceOf(Date);
    expect(opp.meddpicc).toBeNull();
    // MEDDPICC optional, ohne Pflicht, ohne Bewertung
    const m = await saveMeddpicc(david, opp.id, { version: opp.version, fields: { identifyPain: "Release-Termin im Dezember, Testteam unterbesetzt", unbekannt: "wird ignoriert" } });
    expect(m.meddpicc).toEqual({ identifyPain: "Release-Termin im Dezember, Testteam unterbesetzt" });
  });

  it("F02: mehrere Bedarfe je Kunde mit unabhängigen Zuständen; Hinweis wird „mit Bedarf verknüpft“", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const { signal } = await captureObservation(david, { setupId: s.setupId, observation: "Im Plattformteam wird eine zusätzliche Architekturrolle diskutiert." });
    const a = await createOpportunity(david, { setupId: s.setupId, title: "Architekturrolle Plattform", needDescription: "Zusätzliche Architekturrolle für die Plattform ab Q1.", signalId: signal.id });
    const b = await createOpportunity(david, { setupId: s.setupId, title: "Coaching Product Owner", needDescription: "Begleitung der Product Owner im Plattformteam über drei Monate." });
    const sig = await db.query.signals.findFirst({ where: eq(schema.signals.id, signal.id) });
    expect(sig?.status).toBe("MIT_BEDARF_VERKNUEPFT");
    // Bestätigung nur mit Beleg
    await expect(confirmOpportunity(david, a.id, { version: a.version })).rejects.toBeInstanceOf(ValidationError);
    const aConfirmed = await confirmOpportunity(david, a.id, { version: a.version, evidenceText: "Frau Keller hat den Bedarf im Termin am 15.09. ausdrücklich bestätigt." });
    expect(aConfirmed.status).toBe("BESTAETIGT");
    expect(aConfirmed.confirmedSourceId).toBeTruthy();
    expect(aConfirmed.confirmedAt).toBeInstanceOf(Date);
    const list = await listOpportunitiesForAccount(david, s.accountId);
    const sa = list.find((o) => o.id === a.id)!;
    const sb = list.find((o) => o.id === b.id)!;
    expect(sa.status).toBe("BESTAETIGT");
    expect(sb.status).toBe("IN_KLAERUNG"); // unabhängig
    // Zurückstellen braucht Begründung; direkte Sprünge zu „vorgestellt“/„beauftragt“ sind nicht möglich
    await expect(changeOpportunityStatus(david, b.id, { version: b.version, status: "ZURUECKGESTELLT" })).rejects.toBeInstanceOf(ValidationError);
    await expect(changeOpportunityStatus(david, b.id, { version: b.version, status: "BEAUFTRAGT" })).rejects.toBeInstanceOf(TransitionError);
    const zb = await changeOpportunityStatus(david, b.id, { version: b.version, status: "ZURUECKGESTELLT", reason: "Budgetentscheidung erst im Januar." });
    expect(zb.status).toBe("ZURUECKGESTELLT");
  });

  it("8.3 Buyingcenter: offene Funktion ohne erfundene Person; bestätigte Rolle braucht Quelle; Titel ≠ Entscheidungsvollmacht", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const opp = await createOpportunity(david, { setupId: s.setupId, title: "Buyingcenter-Test", needDescription: "Bedarf zur Prüfung des Buyingcenters." });
    const keller = await db.query.persons.findFirst({ where: eq(schema.persons.accountId, s.accountId) });
    const personId = keller!.id;
    const open = await addParticipation(david, { opportunityId: opp.id, role: "BUDGETVERANTWORTUNG", note: "Funktion bekannt, Person noch nicht" });
    expect(open!.personId).toBeNull();
    expect(open!.epistemicStatus).toBe("HYPOTHESE");
    await expect(addParticipation(david, { opportunityId: opp.id, role: "BEDARFSTRAEGER", personId: personId, epistemicStatus: "SACHVERHALT_BESTAETIGT" })).rejects.toBeInstanceOf(ValidationError);
    const { source } = await captureObservation(david, { setupId: s.setupId, observation: "Frau Keller hat sich als Bedarfsträgerin für die Architekturrolle bezeichnet." });
    const confirmed = await addParticipation(david, { opportunityId: opp.id, role: "BEDARFSTRAEGER", personId: personId, epistemicStatus: "SACHVERHALT_BESTAETIGT", evidenceSourceId: source.id });
    expect(confirmed!.evidenceSourceId).toBe(source.id);
    // Eine Person kann mehrere Rollen haben
    const second = await addParticipation(david, { opportunityId: opp.id, role: "UNTERSTUETZER_SPONSOR", personId: personId });
    expect(second!.personId).toBe(personId);
    const d = await getOpportunityDetail(david, opp.id);
    expect(d.participations).toHaveLength(3);
  });

  it("F09/F10: Entwurf ist nicht vorgestellt; Vorstellung braucht Ereignis + Beleg; akzeptiert ≠ Auftrag/Start", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const opp0 = await createOpportunity(david, { setupId: s.setupId, title: "Angebotsfall", needDescription: "Bedarf für den Angebotsdurchlauf." });
    const opp = await confirmOpportunity(david, opp0.id, { version: opp0.version, evidenceText: "Bestätigung im Jour fixe am 16.09. durch den Bereichsleiter." });
    const ref = await createProfileReference(david, { label: "Profil Senior Testkoordination (freigegeben 09/2026)", sourceRef: "Ablage/Profile/TK-2026-09" });
    const offer = await createOffer(david, { opportunityId: opp.id, title: "Profilvorstellung Testkoordination", profileReferenceIds: [ref!.id] });
    expect(offer!.status).toBe("ENTWURF");
    // Entwurf kann nicht „vorgestellt“ werden
    await expect(presentOffer(david, offer!.id, { version: offer!.version, presentedTo: "Frau Keller", evidenceText: "Profil per Mail gesendet am 17.09." })).rejects.toBeInstanceOf(TransitionError);
    const checked = await changeOfferStatus(david, offer!.id, { version: offer!.version, status: "GEPRUEFT" });
    // Ohne Beleg keine Vorstellung
    await expect(presentOffer(david, offer!.id, { version: checked.version, presentedTo: "Frau Keller" })).rejects.toBeInstanceOf(ValidationError);
    // Direktes Setzen von „vorgestellt“ ohne Ereignis ist gesperrt
    await expect(changeOfferStatus(david, offer!.id, { version: checked.version, status: "VORGESTELLT" })).rejects.toBeInstanceOf(TransitionError);
    const presented = await presentOffer(david, offer!.id, { version: checked.version, presentedTo: "Frau Keller, Herr Brandt (Einkauf)", evidenceText: "Profil am 17.09. per Mail an Frau Keller und Herrn Brandt gesendet; Eingang bestätigt." });
    expect(presented.status).toBe("VORGESTELLT");
    expect(presented.presentedSourceId).toBeTruthy();
    let d = await getOpportunityDetail(david, opp.id);
    expect(d.opp.status).toBe("PROFIL_ANGEBOT_VORGESTELLT");
    // Positive Rückmeldung → Auswahl/Bestellung, aber kein Auftrag und kein Start (F10)
    const accepted = await changeOfferStatus(david, offer!.id, { version: presented.version, status: "AKZEPTIERT", note: "Profil positiv bewertet, Kunde möchte starten." });
    expect(accepted.status).toBe("AKZEPTIERT");
    d = await getOpportunityDetail(david, opp.id);
    expect(d.opp.status).toBe("AUSWAHL_BESTELLUNG");
    expect(d.orders).toHaveLength(0);
  });

  it("9.3: Beauftragung nur mit Nachweis; startbereit nicht über leere Prüfliste; gestartet ist ein bestätigtes Ereignis", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const opp0 = await createOpportunity(david, { setupId: s.setupId, title: "Auftragsfall", needDescription: "Bedarf für den Auftragsdurchlauf." });
    const opp = await confirmOpportunity(david, opp0.id, { version: opp0.version, evidenceText: "Bestätigung schriftlich per Mail vom 16.09." });
    const order = await createOrder(david, { opportunityId: opp.id, plannedStart: "2026-11-02" });
    expect(order!.status).toBe("IN_VORBEREITUNG");
    // Startbereit vor Beauftragung unmöglich
    await expect(markReady(david, order!.id, { version: order!.version })).rejects.toBeInstanceOf(TransitionError);
    // Beauftragung ohne Nachweis unmöglich
    await expect(confirmOrder(david, order!.id, { version: order!.version, orderReference: "PO-4711" })).rejects.toBeInstanceOf(ValidationError);
    const confirmed = await confirmOrder(david, order!.id, { version: order!.version, orderReference: "PO-4711", evidenceText: "Bestellung PO-4711 vom 20.10. liegt als PDF im Auftragsordner; Laufzeit 02.11.–31.03." });
    expect(confirmed.status).toBe("BEAUFTRAGUNG_BESTAETIGT");
    expect(confirmed.evidenceSourceId).toBeTruthy();
    let d = await getOpportunityDetail(david, opp.id);
    expect(d.opp.status).toBe("BEAUFTRAGT");
    // Leere Prüfliste ist keine Freigabe
    await expect(markReady(david, order!.id, { version: confirmed.version })).rejects.toBeInstanceOf(ValidationError);
    const r1 = await addStartRequirement(david, { orderId: order!.id, requirement: "Geheimhaltungsvereinbarung unterschrieben", checkedBy: "Backoffice" });
    const r2 = await addStartRequirement(david, { orderId: order!.id, requirement: "Zugangsdaten/Onboarding beim Kunden beantragt", checkedBy: "BD" });
    await expect(markReady(david, order!.id, { version: confirmed.version })).rejects.toBeInstanceOf(ValidationError);
    // Bestätigung braucht Nachweis
    await expect(setRequirementStatus(david, r1!.id, { version: r1!.version, status: "BESTAETIGT" })).rejects.toBeInstanceOf(ValidationError);
    await setRequirementStatus(david, r1!.id, { version: r1!.version, status: "BESTAETIGT", evidenceText: "NDA unterschrieben am 21.10., abgelegt im Vertragsordner." });
    await setRequirementStatus(david, r2!.id, { version: r2!.version, status: "NICHT_ANWENDBAR", evidenceNote: "Kunde stellt Zugänge erst am ersten Tag vor Ort bereit; keine Vorab-Beantragung." });
    const ready = await markReady(david, order!.id, { version: confirmed.version });
    expect(ready.engagementStatus).toBe("STARTBEREIT");
    // Gestartet: bestätigtes Ereignis, nicht Datum
    await expect(markStarted(david, order!.id, { version: ready.version })).rejects.toBeInstanceOf(ValidationError);
    await expect(markStarted(david, order!.id, { version: ready.version, startedAt: "2099-01-01", note: "Kick-off" })).rejects.toBeInstanceOf(ValidationError);
    const started = await markStarted(david, order!.id, { version: ready.version, note: "Kick-off am 02.11. mit Frau Keller durchgeführt; Berater vor Ort." });
    expect(started.engagementStatus).toBe("GESTARTET");
    expect(started.startedAt).toBeInstanceOf(Date);
    d = await getOpportunityDetail(david, opp.id);
    expect(d.orders[0]?.requirements).toHaveLength(2);
  });

  it("F16/Zugriff: Profilreferenzen nur für berechtigte Rollen; fremder Bedarf unsichtbar (S01); nur Bearbeitende schreiben", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    const lars = await actorFor("lars");
    const clemens = await actorFor("clemens");
    await expect(createProfileReference(nina, { label: "Profil X" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listProfileReferences(nina)).toEqual([]);
    const opp = await createOpportunity(david, { setupId: s.setupId, title: "Zugriffsfall", needDescription: "Bedarf zur Prüfung der Zugriffsregeln." });
    // Lars (BD anderer Kunde) sieht den Bedarf nicht – auch nicht per ID
    await expect(getOpportunityDetail(lars, opp.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(confirmOpportunity(lars, opp.id, { version: opp.version, evidenceText: "Versuch eines Fremdzugriffs auf den Bedarf." })).rejects.toBeInstanceOf(NotFoundError);
    // Nina ist Beteiligte (Kontext) – darf lesen, aber nicht bestätigen, wenn sie nicht bearbeitend ist
    const d = await getOpportunityDetail(nina, opp.id);
    expect(d.opp.id).toBe(opp.id);
    if (!d.canEdit) await expect(confirmOpportunity(nina, opp.id, { version: opp.version, evidenceText: "Bestätigung durch Nina ohne Bearbeitungsrecht." })).rejects.toBeInstanceOf(ForbiddenError);
    // CEO sieht den Bedarf (Zusammenfassung), keine Vergütungs-/Konditionsberechnung irgendwo
    const c = await getOpportunityDetail(clemens, opp.id);
    expect(JSON.stringify(c.opp)).not.toMatch(/provision|verguetung|vergütung|tagessatz/i);
  });
});
