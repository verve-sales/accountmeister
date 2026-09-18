import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { createSetup, getSetupDetail, listSetupsWithOpenAssignment, updateSetup } from "@/modules/setups/service";
import { captureObservation, changeSignalStatus, takeOverSignal } from "@/modules/signals/service";
import { createHandover, respondToHandover } from "@/modules/handovers/service";
import { changeActionStatus, createAction, listMyOpenActions } from "@/modules/actions/service";
import { actorFor, ensureSeed } from "./helpers";

describe("Hauptfall Etappe 1: Setup → Beobachtung → Hinweis → Übergabe → Aktion", () => {
  it("F01: lückenhaftes Setup speichern ist möglich; BD-Zuordnung bleibt offen und erscheint im Eingang", async () => {
    const s = await ensureSeed();
    const nina = await actorFor("nina");
    // Nina ist Anker mit Arbeitsraum-Rolle; für den Kunden angelegt über Account-Sicht durch Mitgliedschaft
    const setup = await createSetup(nina, { accountId: s.accountId, name: "Datenplattform (Entwurf)", contextNote: "", visibility: "MITGLIEDER", bdUserId: "" });
    expect(setup.status).toBe("ENTWURF");
    expect(setup.bdUserId).toBeNull();
    expect(setup.contextNote).toBeNull();
    const inbox = await listSetupsWithOpenAssignment(await actorFor("petra"));
    expect(inbox.some((e) => e.setup.id === setup.id)).toBe(true);
    // Ersteller behält Bearbeitungsverantwortung
    const detail = await getSetupDetail(nina, setup.id);
    expect(detail.canEdit).toBe(true);
  });

  it("Beobachtung erfassen erzeugt Hinweis (NEU), Quelle und Aussagen mit getrenntem Erkenntnisstatus", async () => {
    const s = await ensureSeed();
    const nina = await actorFor("nina");
    const { signal, source } = await captureObservation(nina, {
      setupId: s.setupId,
      observation: "Das Migrationsteam sucht nach eigenen Angaben zusätzliche Testkoordination.",
      relevanceHypothesis: "Externe Unterstützung könnte relevant werden.",
      usageLimit: "Nina nicht als Quelle nennen.",
    });
    expect(signal.status).toBe("NEU");
    expect(signal.sourceId).toBe(source.id);
    const assertions = await db.query.assertions.findMany({ where: eq(schema.assertions.setupId, s.setupId) });
    const statuses = assertions.map((a) => a.epistemicStatus);
    expect(statuses).toContain("AUSSAGE_WIEDERGEGEBEN");
    expect(statuses).toContain("HYPOTHESE");
    // Keine Beobachtung wird zu „bestätigtem Bedarf“
    expect(assertions.filter((a) => a.content.includes("Testkoordination")).every((a) => a.epistemicStatus !== "SACHVERHALT_BESTAETIGT")).toBe(true);
  });

  it("F03: Hinweis aus Weekly per Übergabe übernehmen – erst die Annahme begründet die Übernahme", async () => {
    const s = await ensureSeed();
    const nina = await actorFor("nina");
    const david = await actorFor("david");

    const h = await createHandover(nina, {
      subjectType: "SIGNAL",
      subjectId: s.signalId,
      receiverUserId: david.userId,
      context: "Beobachtung aus dem Weekly zum Migrationsteam.",
      proven: "Es wird über zusätzlichen Aufwand gesprochen.",
      open: "Ob externe Unterstützung vorgesehen ist.",
      allowedUse: "Nur als Anlass für eine Verständnisfrage; Nina nicht als Quelle nennen.",
      responsibility: "Klären, wer die Kapazitätsplanung im Migrationsteam koordiniert.",
      feedbackChannel: "Nächstes Weekly",
    });
    expect(h.status).toBe("ANGEFRAGT");
    // Vor Annahme: Hinweis unverändert, kein Owner
    let signal = await db.query.signals.findFirst({ where: eq(schema.signals.id, s.signalId) });
    expect(signal?.ownerUserId).toBeNull();
    expect(signal?.status).toBe("NEU");

    // Nina (Sender) kann nicht selbst annehmen
    await expect(respondToHandover(nina, h.id, { version: h.version, decision: "ANNEHMEN" })).rejects.toBeInstanceOf(ForbiddenError);

    // David nimmt an → Owner, Status „Prüfung übernommen“
    const accepted = await respondToHandover(david, h.id, { version: h.version, decision: "ANNEHMEN" });
    expect(accepted.status).toBe("ANGENOMMEN");
    signal = await db.query.signals.findFirst({ where: eq(schema.signals.id, s.signalId) });
    expect(signal?.ownerUserId).toBe(david.userId);
    expect(signal?.status).toBe("PRUEFUNG_UEBERNOMMEN");

    // Abschluss ohne Rückmeldung nicht möglich; mit Rückmeldung ja
    await expect(respondToHandover(david, h.id, { version: accepted.version, decision: "ABSCHLIESSEN" })).rejects.toBeInstanceOf(ValidationError);
    const closed = await respondToHandover(david, h.id, { version: accepted.version, decision: "ABSCHLIESSEN", responseNote: "Frau Keller angefragt; Rückmeldung im nächsten Weekly." });
    expect(closed.status).toBe("ABGESCHLOSSEN");
  });

  it("F05: Doppelrolle – keine Selbstübergabe; direkte Übernahme ist der vorgesehene Weg", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const { signal } = await captureObservation(david, { setupId: s.setupId, observation: "Eigene Beobachtung von David im Kundentermin." });
    await expect(
      createHandover(david, { subjectType: "SIGNAL", subjectId: signal.id, receiverUserId: david.userId, context: "x".repeat(10), responsibility: "y".repeat(10) }),
    ).rejects.toBeInstanceOf(ValidationError);
    const taken = await takeOverSignal(david, signal.id, signal.version);
    expect(taken.ownerUserId).toBe(david.userId);
    const handovers = await db.query.handovers.findMany({ where: eq(schema.handovers.subjectId, signal.id) });
    expect(handovers).toHaveLength(0);
  });

  it("F07/Aktionen: fremde Aktion startet als Vorschlag, nur Verantwortliche nimmt an; Erledigt braucht Ergebnis", async () => {
    const s = await ensureSeed();
    const nina = await actorFor("nina");
    const david = await actorFor("david");
    const a = await createAction(nina, { setupId: s.setupId, signalId: s.signalId, title: "Frau Keller fragen, wer die Kapazitätsplanung koordiniert", ownerUserId: david.userId });
    expect(a.status).toBe("VORGESCHLAGEN");
    await expect(changeActionStatus(nina, a.id, { version: a.version, status: "ANGENOMMEN" })).rejects.toBeInstanceOf(ForbiddenError);
    const accepted = await changeActionStatus(david, a.id, { version: a.version, status: "ANGENOMMEN" });
    expect(accepted.status).toBe("ANGENOMMEN");
    expect((await listMyOpenActions(david)).some((x) => x.id === a.id)).toBe(true);
    await expect(changeActionStatus(david, accepted.id, { version: accepted.version, status: "ERLEDIGT" })).rejects.toBeInstanceOf(ValidationError);
    const done = await changeActionStatus(david, accepted.id, { version: accepted.version, status: "ERLEDIGT", result: "Frau Keller: Planung liegt bei Frau Brandt; Vorstellung angeboten." });
    expect(done.status).toBe("ERLEDIGT");
    await expect(changeActionStatus(david, done.id, { version: done.version, status: "IN_ARBEIT" })).rejects.toBeInstanceOf(TransitionError);
    expect((await listMyOpenActions(david)).some((x) => x.id === a.id)).toBe(false);
  });

  it("Zurückstellen/Beenden eines Hinweises braucht eine Begründung", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const { signal } = await captureObservation(david, { setupId: s.setupId, observation: "Kein externer Bedarf: Team löst Testkoordination intern." });
    await expect(changeSignalStatus(david, signal.id, { version: signal.version, status: "BEENDET" })).rejects.toBeInstanceOf(ValidationError);
    const closed = await changeSignalStatus(david, signal.id, { version: signal.version, status: "BEENDET", closedReason: "Intern gelöst, kein externer Bedarf." });
    expect(closed.status).toBe("BEENDET");
  });

  it("Optimistische Sperre: parallele Bearbeitung erzeugt Konflikt statt stillem Überschreiben", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const setup = await createSetup(david, { accountId: s.accountId, name: "Parallelbearbeitung", contextNote: "Test", bdUserId: david.userId });
    const first = await updateSetup(david, setup.id, { version: setup.version, contextNote: "Stand A" });
    expect(first.version).toBe(setup.version + 1);
    await expect(updateSetup(david, setup.id, { version: setup.version, contextNote: "Stand B (veraltet)" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("Unbekannter Hinweis liefert 'nicht gefunden' ohne Unterschied zu 'keine Berechtigung'", async () => {
    const nina = await actorFor("nina");
    await expect(takeOverSignal(nina, "00000000-0000-0000-0000-000000000000", 1)).rejects.toBeInstanceOf(NotFoundError);
  });
});
