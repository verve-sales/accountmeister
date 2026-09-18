import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ConflictError, ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { addDecision, confirmReview, correctReview, createReview, listReviews, prepareReview, saveReviewDraft } from "@/modules/reviews/service";
import { captureObservation } from "@/modules/signals/service";
import { createAction } from "@/modules/actions/service";
import { createSetup, getSetupDetail } from "@/modules/setups/service";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 2: BD-/Anker-Weekly (Briefing 11.1, F07, F11)", () => {
  it("Zwei aufeinanderfolgende Weeklys bauen nachvollziehbar aufeinander auf", async () => {
    const s = await ensureSeed();
    const nina = await actorFor("nina");
    const david = await actorFor("david");
    // Eigenes Setup, damit der Test unabhängig vom Seed-Setup bleibt
    const setup = await createSetup(david, { accountId: s.accountId, name: "Weekly-Testsetup", contextNote: "Kontext für Weekly-Test", bdUserId: david.userId });
    await db.insert(schema.setupMemberships).values({ setupId: setup.id, userId: nina.userId, contribution: "ANKER_KONTEXT", canEdit: true });

    // Weekly 1
    const w1 = await createReview(nina, { setupId: setup.id, scheduledFor: "2026-09-21" });
    expect(w1.status).toBe("GEPLANT");
    let prep = await prepareReview(nina, w1.id);
    expect(prep.lastConfirmed).toBeNull();
    expect(prep.participants.map((p) => p.userId).sort()).toEqual([david.userId, nina.userId].sort());

    // Bestätigen ohne Durchführung ist nicht möglich
    await expect(confirmReview(david, w1.id, { version: w1.version })).rejects.toBeInstanceOf(TransitionError);

    // Durchführung: Notiz (nur Entwurf), Beobachtung, Aktion als Idee (F07), Entscheidung
    const draft = await saveReviewDraft(nina, w1.id, { version: w1.version, noteDraft: "Gemeinsame Notiz Weekly 1." });
    expect(draft.status).toBe("LAUFEND");
    const { signal } = await captureObservation(nina, { setupId: setup.id, observation: "Im Weekly 1 beobachtet: Team plant zusätzliche Testtermine.", reviewId: w1.id });
    const idea = await createAction(nina, { setupId: setup.id, title: "Idee: David fragt nach Testkoordination", ownerUserId: david.userId, reviewId: w1.id });
    expect(idea.status).toBe("VORGESCHLAGEN"); // Idee im Protokoll ist keine vereinbarte Aufgabe
    const agreed = await createAction(nina, { setupId: setup.id, title: "David spricht Frau Keller an", ownerUserId: david.userId, reviewId: w1.id, agreedInConversation: "true" });
    expect(agreed.status).toBe("ANGENOMMEN");
    const dec = await addDecision(david, { reviewId: w1.id, content: "Keine Ansprache neuer Personen durch Nina; David führt Kontakt." });

    // Ergebnisvorschau zeigt genau das im Weekly Erfasste
    prep = await prepareReview(david, w1.id);
    expect(prep.inThisReview.signals.map((x) => x.id)).toEqual([signal.id]);
    expect(prep.inThisReview.actions.map((x) => x.id).sort()).toEqual([idea.id, agreed.id].sort());
    expect(prep.inThisReview.decisions.map((x) => x.id)).toEqual([dec.id]);

    // Bestätigung nur durch Teilnehmende; Petra (Principal, kein Teilnehmer) darf nicht
    const petra = await actorFor("petra");
    await expect(confirmReview(petra, w1.id, { version: draft.version })).rejects.toBeInstanceOf(ForbiddenError);

    // F11: Bestätigung erzeugt Version mit Bestätiger und konsistentem Snapshot
    const confirmed = await confirmReview(david, w1.id, { version: draft.version });
    expect(confirmed.review.status).toBe("BESTAETIGT");
    expect(confirmed.version.confirmedBy).toBe(david.userId);
    expect(confirmed.version.versionNo).toBe(1);
    const snap = confirmed.version.snapshot as { signalIds: string[]; actionIds: string[]; decisionIds: string[]; since: string | null };
    expect(snap.signalIds).toEqual([signal.id]);
    expect(snap.actionIds.sort()).toEqual([idea.id, agreed.id].sort());
    expect(snap.since).toBeNull();
    // Die Idee bleibt Vorschlag – Bestätigung wandelt sie nicht um
    const ideaAfter = await db.query.actions.findFirst({ where: eq(schema.actions.id, idea.id) });
    expect(ideaAfter?.status).toBe("VORGESCHLAGEN");
    // Doppelte Bestätigung / veraltete Version → Konflikt oder Übergangsfehler
    await expect(confirmReview(david, w1.id, { version: draft.version })).rejects.toBeInstanceOf(TransitionError);

    // Setup-Abschnitt 2 bezieht sich jetzt auf den bestätigten Stand
    const detail = await getSetupDetail(david, setup.id);
    expect(detail.recentSince.getTime()).toBe(confirmed.version.confirmedAt.getTime());
    expect(detail.recentLabel).toContain("Weekly");

    // Zwischen den Weeklys: neue Beobachtung außerhalb eines Weeklys
    const { signal: between } = await captureObservation(david, { setupId: setup.id, observation: "Zwischen den Weeklys: Frau Keller bestätigt Zuständigkeit von Frau Brandt." });

    // Weekly 2: Vorbereitung zeigt letzten bestätigten Stand und das Neue seitdem
    const w2 = await createReview(david, { setupId: setup.id, scheduledFor: "2026-09-28" });
    const prep2 = await prepareReview(nina, w2.id);
    expect(prep2.lastConfirmed?.reviewTitle).toBe(w1.title);
    expect(prep2.lastConfirmed?.confirmedBy).toContain("David");
    expect(prep2.newSignals.map((x) => x.id)).toEqual([between.id]);
    expect(prep2.newSignals.map((x) => x.id)).not.toContain(signal.id);
    expect(prep2.openActions.some((a) => a.id === agreed.id)).toBe(true);

    const d2 = await saveReviewDraft(david, w2.id, { version: w2.version, noteDraft: "Weekly 2: Zuständigkeit geklärt." });
    const c2 = await confirmReview(nina, w2.id, { version: d2.version });
    const snap2 = c2.version.snapshot as { since: string | null };
    expect(snap2.since).toBe(confirmed.version.confirmedAt.toISOString());

    // Verlauf: beide bestätigt, sortiert
    const lists = await listReviews(david);
    expect(lists.past.map((r) => r.id)).toEqual(expect.arrayContaining([w1.id, w2.id]));
  });

  it("Korrektur eines bestätigten Weeklys erzeugt neue Version; alte bleibt erhalten", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const w = await createReview(david, { setupId: s.setupId, scheduledFor: "2026-10-05" });
    const d = await saveReviewDraft(david, w.id, { version: w.version, noteDraft: "Ursprüngliche Notiz" });
    const c = await confirmReview(david, w.id, { version: d.version });
    await expect(saveReviewDraft(david, w.id, { version: c.review.version, noteDraft: "Nachträglich" })).rejects.toBeInstanceOf(TransitionError);
    await expect(correctReview(david, w.id, { version: c.review.version, note: "Korrigierte Notiz", correctionNote: "" })).rejects.toBeInstanceOf(ValidationError);
    const corr = await correctReview(david, w.id, { version: c.review.version, note: "Korrigierte Notiz", correctionNote: "Tippfehler und fehlende Aktion ergänzt." });
    expect(corr.version.versionNo).toBe(2);
    expect(corr.version.supersedesVersionId).toBe(c.version.id);
    const versions = await db.query.reviewVersions.findMany({ where: eq(schema.reviewVersions.reviewId, w.id) });
    expect(versions).toHaveLength(2);
    expect(versions.find((v) => v.versionNo === 1)?.note).toBe("Ursprüngliche Notiz");
    await expect(correctReview(david, w.id, { version: c.review.version, note: "x", correctionNote: "veraltete Version" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("Zugriff: fremder BD sieht das Weekly nicht; CEO sieht die Zusammenfassung nur lesend", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const lars = await actorFor("lars");
    const ceo = await actorFor("clemens");
    const w = await createReview(david, { setupId: s.setupId, scheduledFor: "2026-10-12" });
    await expect(prepareReview(lars, w.id)).rejects.toBeInstanceOf(NotFoundError);
    const view = await prepareReview(ceo, w.id);
    expect(view.canWork).toBe(false);
    await expect(saveReviewDraft(ceo, w.id, { version: w.version, noteDraft: "CEO schreibt mit" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
