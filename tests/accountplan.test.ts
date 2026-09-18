import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { buildAccountPlan, changePriority, createPriority, getAccountPlanSnapshot, listAccountPlanSnapshots, saveAccountPlanSnapshot } from "@/modules/accountplan/service";
import { captureObservation, changeSignalStatus } from "@/modules/signals/service";
import { actorFor, ensureSeed } from "./helpers";

describe("Accountplan (Briefing 7, A1, A13, F14)", () => {
  it("F14: Übersicht wird aus bestätigten Daten gebaut – Einsätze mit Beleg, offene Hinweise, Beziehungen, keine Zahlenfelder", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const plan = await buildAccountPlan(david, s.accountId);
    expect(plan.account.name).toContain("Beispielkonzern");
    expect(plan.engagements.length).toBeGreaterThanOrEqual(2);
    expect(plan.engagements.every((e) => e.hasEvidence)).toBe(true);
    expect(plan.relationships.some((r) => r.person.startsWith("Frau Keller") && r.hasEvidence)).toBe(true);
    expect(plan.setups.some((x) => x.name === "Plattformteam")).toBe(true);
    // Kein Forecast: keine Felder mit Beträgen/Prozenten
    expect(JSON.stringify(plan)).not.toMatch(/umsatz|forecast|potenzial|€/i);
    // Zurückgestellte Hinweise landen unter offenen Fragen, nicht unter Veränderungen
    const { signal } = await captureObservation(david, { setupId: s.setupId, observation: "Accountplan-Test: unklare Budgetlage im Migrationsteam." });
    await changeSignalStatus(david, signal.id, { version: signal.version, status: "ZURUECKGESTELLT", closedReason: "Bis Budgetrunde im Oktober." });
    const plan2 = await buildAccountPlan(david, s.accountId);
    expect(plan2.openQuestions.some((q) => q.kind === "ZURUECKGESTELLT" && q.text.includes("Budgetlage"))).toBe(true);
    expect(plan2.changes.some((c) => c.id === signal.id)).toBe(false);
  });

  it("Prioritäten: BD schlägt vor, „vereinbart“ erst mit Zustimmung beider Rollen; Zurückstellen braucht Begründung", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const petra = await actorFor("petra");
    const nina = await actorFor("nina");
    await expect(createPriority(nina, { accountId: s.accountId, kind: "AUSWEITEN", title: "Nina darf nicht" })).rejects.toBeInstanceOf(ForbiddenError);
    const p = await createPriority(david, { accountId: s.accountId, setupId: s.setupId, kind: "AUSWEITEN", title: "Testkoordination im Migrationsteam anbieten", rationale: "Hinweis aus Weekly; Zuständigkeit geklärt.", prerequisites: "Vorstellung bei Frau Brandt", rank: 1 });
    expect(p.status).toBe("VORGESCHLAGEN");
    // David allein: Zustimmung gespeichert, noch nicht vereinbart
    const r1 = await changePriority(david, p.id, { version: p.version, status: "VEREINBART" });
    expect(r1.pendingAgreement).toBe(true);
    expect(r1.priority.status).toBe("VORGESCHLAGEN");
    expect(r1.priority.agreedByUserIds).toContain(david.userId);
    // Petra (Principal) stimmt zu → vereinbart
    const r2 = await changePriority(petra, p.id, { version: r1.priority.version, status: "VEREINBART" });
    expect(r2.pendingAgreement).toBe(false);
    expect(r2.priority.status).toBe("VEREINBART");
    // Zurückstellen ohne Grund → Fehler; mit Grund ok
    await expect(changePriority(david, p.id, { version: r2.priority.version, status: "ZURUECKGESTELLT" })).rejects.toBeInstanceOf(ValidationError);
    const r3 = await changePriority(david, p.id, { version: r2.priority.version, status: "ZURUECKGESTELLT", deferredReason: "Kapazität erst ab Q1." });
    expect(r3.priority.status).toBe("ZURUECKGESTELLT");
    const plan = await buildAccountPlan(petra, s.accountId);
    expect(plan.priorities.some((x) => x.id === p.id && x.deferredReason === "Kapazität erst ab Q1.")).toBe(true);
  });

  it("Gespeicherter Stand bleibt erhalten, auch wenn sich die Live-Übersicht ändert; Zugriff gefiltert", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const lars = await actorFor("lars");
    const ceo = await actorFor("clemens");
    const before = await buildAccountPlan(david, s.accountId);
    const snap = await saveAccountPlanSnapshot(david, { accountId: s.accountId, title: "Kundenreview September", note: "Stand vor Budgetrunde." });
    const { signal } = await captureObservation(david, { setupId: s.setupId, observation: "Nach dem Snapshot: neue Beobachtung." });
    const after = await buildAccountPlan(david, s.accountId);
    expect(after.changes.some((c) => c.id === signal.id)).toBe(true);
    const stored = await getAccountPlanSnapshot(david, snap.id);
    expect(stored.content.changes.some((c) => c.id === signal.id)).toBe(false);
    expect(stored.content.changes.length).toBe(before.changes.length);
    expect(stored.confirmedByName).toContain("David");
    expect((await listAccountPlanSnapshots(david, s.accountId)).some((x) => x.id === snap.id)).toBe(true);
    // Fremder BD: weder Plan noch Snapshot
    await expect(buildAccountPlan(lars, s.accountId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getAccountPlanSnapshot(lars, snap.id)).rejects.toBeInstanceOf(NotFoundError);
    // CEO liest die Zusammenfassung, darf aber keinen Stand speichern und keine Priorität setzen
    const ceoPlan = await buildAccountPlan(ceo, s.accountId);
    expect(ceoPlan.dataQuality.hiddenSourcesNote).toBeTruthy();
    await expect(saveAccountPlanSnapshot(ceo, { accountId: s.accountId, title: "CEO-Stand" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPriority(ceo, { accountId: s.accountId, kind: "VERTIEFEN", title: "CEO-Priorität" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
