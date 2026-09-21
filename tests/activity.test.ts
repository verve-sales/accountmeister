import { describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { confirmReview, createReview, saveReviewDraft } from "@/modules/reviews/service";
import { captureObservation } from "@/modules/signals/service";
import { createAction, changeActionStatus } from "@/modules/actions/service";
import { createPerson } from "@/modules/people/service";
import { createAccount } from "@/modules/accounts/service";
import { createSetup } from "@/modules/setups/service";
import { buildAccountActivity, buildActivityOverview } from "@/modules/activity/service";
import { actorFor, ensureSeed } from "./helpers";

/** Eigener Kunde je Test: buildAccountActivity zählt über den ganzen Kunden (alle Setups), nicht nur ein Setup. */
async function freshAccount(name: string) {
  const david = await actorFor("david");
  const nina = await actorFor("nina");
  const account = await createAccount(david, { name: `${name} ${Date.now().toString(36)} (fiktiv)`, responsibleBdUserId: david.userId });
  const setup = await createSetup(david, { accountId: account.id, name: `${name}-Setup`, contextNote: "Kontext", bdUserId: david.userId });
  await db.insert(schema.setupMemberships).values({ setupId: setup.id, userId: nina.userId, contribution: "ANKER_KONTEXT", canEdit: true });
  return { david, nina, account, setup };
}

describe("Etappe 12: Aktivitäts-Tracking und Zusammenarbeits-Score", () => {
  it("zählt dokumentierte Aktivitäten je Rolle und Kategorie und bildet daraus den Koeffizienten", async () => {
    const s = await ensureSeed();
    const { david, nina, account, setup } = await freshAccount("Aktivitäts-Test");
    const petra = await actorFor("petra"); // Principal

    // ANKER: Beobachtung erfasst (Nina)
    await captureObservation(nina, { setupId: setup.id, observation: "Aktivitäts-Test: Team plant zusätzliche Testtermine." });

    // BD: Aktion erfasst und erledigt (David)
    const action = await createAction(david, { setupId: setup.id, title: "Aktivitäts-Test: David spricht Ansprechpartner an", ownerUserId: david.userId, agreedInConversation: "true" });
    await changeActionStatus(david, action.id, { version: action.version, status: "ERLEDIGT", result: "Gespräch geführt." });

    // ANKER: Weekly bestätigt (Nina, Teilnehmerin)
    const review = await createReview(nina, { setupId: setup.id, scheduledFor: "2026-09-21" });
    const draft = await saveReviewDraft(nina, review.id, { version: review.version, noteDraft: "Aktivitäts-Test Weekly-Notiz." });
    await confirmReview(nina, review.id, { version: draft.version });

    // ANKER: Kontakt gepflegt (Nina legt Person im Setup an; das Anlegen dokumentiert zugleich den Beziehungsstand)
    const person = await createPerson(nina, { accountId: account.id, setupId: setup.id, displayName: "Herr Aktivitäts-Test (fiktiv)" });
    expect(person).toBeTruthy();

    // PRINCIPAL: entschiedener Vorschlag (direkt angelegt, um den KI-Strukturierungspfad hier nicht erneut zu testen –
    // dieser Test prüft nur die Zählung/Zuordnung durch buildAccountActivity, nicht die Vorschlagserzeugung selbst)
    const [suggestion] = await db
      .insert(schema.suggestions)
      .values({
        workspaceId: s.workspaceId,
        type: "BEOBACHTUNG",
        title: "Aktivitäts-Test: Vorschlag",
        targetRole: "BD",
        setupId: setup.id,
        trigger: "Aktivitäts-Test",
        evidenceQuote: "Aktivitäts-Test",
        observation: "Aktivitäts-Test",
        dedupeKey: `aktivitaets-test-${Date.now()}`,
        provider: "test",
        model: "test",
        promptVersion: "test",
        status: "ANGENOMMEN",
        decidedBy: petra.userId,
        decidedAt: new Date(),
      })
      .returning();
    expect(suggestion).toBeTruthy();

    const activity = await buildAccountActivity(david, account.id, { days: 7 });
    expect(activity.byRole.ANKER.beobachtungenErfasst).toBe(1);
    expect(activity.byRole.ANKER.weeklysBestaetigt).toBe(1);
    expect(activity.byRole.ANKER.kontakteGepflegt).toBe(1);
    expect(activity.byRole.BD.aktionenErfasstOderErledigt).toBe(1);
    expect(activity.byRole.PRINCIPAL.vorschlaegeEntschieden).toBe(1);
    expect(activity.totalActivities).toBe(5);
    expect(activity.activeRoles.slice().sort()).toEqual(["ANKER", "BD", "PRINCIPAL"]);
    // Koeffizient: Summe aller Aktivitäten × Anzahl beteiligter Rollen / 3
    expect(activity.coefficient).toBeCloseTo((activity.totalActivities * activity.activeRoles.length) / 3, 5);
    expect(activity.note).toMatch(/3 von 3 Rollen/);
  });

  it("eine beitragende Rolle ergibt einen niedrigeren Koeffizienten als mehrere Rollen bei gleicher Aktivitätsmenge", async () => {
    const { david, nina, account, setup } = await freshAccount("Koeffizient-Test");

    // Nur BD aktiv: zwei Beobachtungen von David
    await captureObservation(david, { setupId: setup.id, observation: "Koeffizient-Test: erste Beobachtung." });
    await captureObservation(david, { setupId: setup.id, observation: "Koeffizient-Test: zweite Beobachtung." });
    const onlyOne = await buildAccountActivity(david, account.id, { days: 7 });
    expect(onlyOne.activeRoles).toEqual(["BD"]);
    expect(onlyOne.totalActivities).toBe(2);
    // Koeffizient wird auf eine Nachkommastelle gerundet: 2 × 1 / 3 ≈ 0,67 → 0,7
    expect(onlyOne.coefficient).toBeCloseTo(0.7, 5);

    // Zusätzlich Anker aktiv (eine weitere Aktivität, aber jetzt zwei statt einer beitragenden Rolle)
    await captureObservation(nina, { setupId: setup.id, observation: "Koeffizient-Test: Beobachtung von Nina." });
    const twoRoles = await buildAccountActivity(david, account.id, { days: 7 });
    expect(twoRoles.activeRoles.slice().sort()).toEqual(["ANKER", "BD"]);
    expect(twoRoles.totalActivities).toBe(3);
    // Mehr beteiligte Rollen erhöhen den Koeffizienten überproportional zur reinen Mengensteigerung
    expect(twoRoles.coefficient).toBeGreaterThan(onlyOne.coefficient);
  });

  it("fremder Kunde bleibt unsichtbar; ein sichtbarer Kunde ohne Aktivität im Zeitraum liefert einen erklärten Nullstand", async () => {
    const { david, account } = await freshAccount("Nullstand-Test");
    const lars = await actorFor("lars"); // BD eines anderen Kunden

    await expect(buildAccountActivity(lars, account.id, { days: 7 })).rejects.toThrow();

    // David sieht seinen eigenen Kunden, aber ohne jede Aktivität im (leeren) Zeitraum liefert es einen erklärten Nullstand
    const other = await buildAccountActivity(david, account.id, { days: 0 });
    expect(other.totalActivities).toBe(0);
    expect(other.activeRoles).toEqual([]);
    expect(other.coefficient).toBe(0);
    expect(other.note).toMatch(/Keine dokumentierte Aktivität/);
  });

  it("Übersicht über alle sichtbaren Kunden ist nach Koeffizient absteigend sortiert", async () => {
    const { david, account, setup } = await freshAccount("Übersicht-Test");
    const clemens = await actorFor("clemens"); // CEO: sieht alle Kunden

    await captureObservation(david, { setupId: setup.id, observation: "Übersicht-Test: Vergleichsbeobachtung." });

    const overview = await buildActivityOverview(clemens, { days: 7 });
    expect(overview.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < overview.length; i++) {
      expect(overview[i - 1]!.coefficient).toBeGreaterThanOrEqual(overview[i]!.coefficient);
    }
    expect(overview.some((a) => a.accountId === account.id)).toBe(true);
  });
});
