import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import {
  addConfidentialNote, addGoalContribution, buildPortfolio, changeGoalStatus, confirmLeadershipReview, createGoal, createLeadershipReview, createSupportRequest,
  getGoal, listGoals, listSupportRequestsForSetup, prepareLeadershipReview, respondToSupportRequest, saveLeadershipDraft, updateGoal,
} from "@/modules/leadership/service";
import { getSetupDetail } from "@/modules/setups/service";
import { buildAccountPlan } from "@/modules/accountplan/service";
import { structureText } from "@/modules/suggestions/service";
import { loadSetupContext } from "@/modules/identity/authz";
import { resetConfigCacheForTests } from "@/lib/config";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 4: Führungsebenen (Briefing 10.2, 11.2–11.4, F12, F13, S04)", () => {
  it("F13: Unterstützungsauftrag – Auftrag beim Principal, operative Verantwortung bleibt beim BD; begrenzt und konkret", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const petra = await actorFor("petra");
    const nina = await actorFor("nina");
    await expect(createSupportRequest(david, { addresseeUserId: nina.userId, setupId: s.setupId, task: "Sparring zur Gesprächsfrage" })).rejects.toBeInstanceOf(ValidationError); // Anker ist kein Adressat
    await expect(createSupportRequest(david, { addresseeUserId: petra.userId, setupId: s.setupId, task: "Hilfe" })).rejects.toBeInstanceOf(ValidationError); // zu unkonkret
    const r = await createSupportRequest(david, { addresseeUserId: petra.userId, setupId: s.setupId, task: "Prüfen, ob ein bestehender Sponsor eine Einführung bei Frau Brandt ermöglichen kann.", dueDate: "2026-10-01" });
    expect(r.status).toBe("ANGEFRAGT");
    // Nur der Adressat nimmt an
    await expect(respondToSupportRequest(david, r.id, { version: r.version, decision: "ANNEHMEN" })).rejects.toBeInstanceOf(ForbiddenError);
    const acc = await respondToSupportRequest(petra, r.id, { version: r.version, decision: "ANNEHMEN" });
    expect(acc.status).toBe("ANGENOMMEN");
    // Setup: BD bleibt zuständig, Setup-Zuordnung unverändert
    const setup = await db.query.projectSetups.findFirst({ where: eq(schema.projectSetups.id, s.setupId) });
    expect(setup?.bdUserId).toBe(david.userId);
    const inSetup = await listSupportRequestsForSetup(david, s.setupId);
    expect(inSetup.some((x) => x.id === r.id && x.addresseeName.includes("Petra"))).toBe(true);
    // Erledigen braucht Ergebnis
    await expect(respondToSupportRequest(petra, r.id, { version: acc.version, decision: "ERLEDIGEN" })).rejects.toBeInstanceOf(ValidationError);
    const done = await respondToSupportRequest(petra, r.id, { version: acc.version, decision: "ERLEDIGEN", note: "Sponsor im Programm-Management angesprochen; Einführung nächste Woche möglich." });
    expect(done.status).toBe("ERLEDIGT");
    expect(done.result).toContain("Sponsor");
  });

  it("Portfolio: dieselbe Datenbasis wie Accountpläne, nur Zählungen, gefiltert nach Berechtigung; BD ohne Portfolio-Rolle abgelehnt", async () => {
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    const clemens = await actorFor("clemens");
    const nina = await actorFor("nina");
    const p = await buildPortfolio(petra);
    const entry = p.entries.find((e) => e.accountId === s.accountId)!;
    expect(entry).toBeDefined();
    const plan = await buildAccountPlan(petra, s.accountId);
    expect(entry.openChanges).toBe(plan.changes.length);
    expect(entry.setups).toBe(plan.setups.length);
    expect(JSON.stringify(p.entries)).not.toMatch(/umsatz|forecast|€/i);
    const c = await buildPortfolio(clemens);
    expect(c.entries.length).toBeGreaterThan(0);
    await expect(buildPortfolio(nina)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Principal-/BD-Weekly: nur Teilnehmende; Vorbereitung enthält Portfolio und offene Unterstützung; Bestätigung mit Version", async () => {
    await ensureSeed();
    const petra = await actorFor("petra");
    const david = await actorFor("david");
    const lars = await actorFor("lars");
    const r = await createLeadershipReview(petra, { type: "PRINCIPAL_BD_WEEKLY", scheduledFor: "2026-10-06", participantIds: [david.userId] });
    await expect(prepareLeadershipReview(lars, r.id)).rejects.toBeInstanceOf(NotFoundError);
    const prep = await prepareLeadershipReview(david, r.id);
    expect(prep.participants.map((x) => x.userId).sort()).toEqual([david.userId, petra.userId].sort());
    expect(prep.portfolio?.entries.length ?? 0).toBeGreaterThan(0);
    await expect(confirmLeadershipReview(petra, r.id, { version: r.version })).rejects.toBeInstanceOf(TransitionError);
    const d = await saveLeadershipDraft(david, r.id, { version: r.version, noteDraft: "Zugang zum Migrationsteam fehlt; Petra prüft Sponsor." });
    const c = await confirmLeadershipReview(petra, r.id, { version: d.version });
    expect(c.review.status).toBe("BESTAETIGT");
    expect(c.version.confirmedBy).toBe(petra.userId);
  });

  it("S04 / 11.4: vertrauliche Coaching-Notiz nur für Empfängerkreis; nicht im Setup, Accountplan oder KI-Kontext", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    const clemens = await actorFor("clemens");
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    const r = await createLeadershipReview(clemens, { type: "CEO_PRINCIPAL_ZIELGESPRAECH", scheduledFor: "2026-10-13", participantIds: [petra.userId, david.userId] });
    await expect(addConfidentialNote(david, { reviewId: r.id, body: "David darf das nicht" })).rejects.toBeInstanceOf(ForbiddenError);
    const secret = `VERTRAULICH-${Date.now().toString(36)} Coaching: David braucht Unterstützung bei Einkaufsgesprächen.`;
    const note = await addConfidentialNote(petra, { reviewId: r.id, body: secret, aboutUserId: david.userId, audienceUserIds: [clemens.userId] });
    expect(note?.audienceUserIds.sort()).toEqual([clemens.userId, petra.userId].sort());
    // David (Teilnehmer, aber nicht im Empfängerkreis) sieht die Notiz nicht
    const davidView = await prepareLeadershipReview(david, r.id);
    expect(davidView.confidential).toHaveLength(0);
    const petraView = await prepareLeadershipReview(petra, r.id);
    expect(petraView.confidential.some((n) => n.body === secret)).toBe(true);
    // Nicht im Setup, nicht im Accountplan, nicht im KI-Kontext
    const detail = await getSetupDetail(nina, s.setupId);
    expect(JSON.stringify(detail)).not.toContain("VERTRAULICH-");
    const plan = await buildAccountPlan(david, s.accountId);
    expect(JSON.stringify(plan)).not.toContain("VERTRAULICH-");
    const ctx = (await loadSetupContext(david, s.setupId))!;
    const res = await structureText(david, ctx, { text: "Kurzer Test: Team plant Termine im November.", dedupeScope: `s04-${Date.now()}`, sourceIds: [], trigger: "Test", participantUserIds: [david.userId] });
    const sugg = await db.query.suggestions.findMany({ where: eq(schema.suggestions.aiJobId, res.job.id) });
    expect(JSON.stringify(sugg)).not.toContain("VERTRAULICH-");
    // Audit enthält keinen Inhalt
    const audits = await db.query.auditEvents.findMany({ where: eq(schema.auditEvents.action, "confidential_note.created") });
    expect(JSON.stringify(audits)).not.toContain("VERTRAULICH-");
  });

  it("F12 / 11.3: Ziel ohne Zahlen bleibt ohne Zielwert; Zielwert braucht Ausgangslage + Kriterium; Vereinbarung braucht CEO und Principal; Versionen", async () => {
    const s = await ensureSeed();
    const petra = await actorFor("petra");
    const clemens = await actorFor("clemens");
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    await expect(createGoal(david, { title: "BD-Ziel", ownerUserId: david.userId, desiredOutcome: "x".repeat(10) })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createGoal(petra, { title: "Mit Zahl ohne Basis", ownerUserId: petra.userId, desiredOutcome: "Zwei neue Setups beim Beispielkonzern", targetValue: "2" })).rejects.toBeInstanceOf(ValidationError);
    const g = await createGoal(petra, { title: "Zugang im Migrationsteam aufbauen", ownerUserId: petra.userId, accountId: s.accountId, desiredOutcome: "Belegter Kontakt zur Kapazitätsplanung des Migrationsteams.", successCriterion: "Beziehungsstand ‚Im Austausch‘ mit Beleg", baseline: "unbekannt – bisher nur Name/Funktion bekannt", periodTo: "2026-12-31" });
    expect(g.status).toBe("ENTWURF");
    const got = await getGoal(petra, g.id);
    expect(got.current?.targetValue).toBeNull();
    expect(got.versions).toHaveLength(1);
    // Petra stimmt zu → zur Abstimmung; Clemens stimmt zu → vereinbart
    const s1 = await changeGoalStatus(petra, g.id, { version: g.version, status: "VEREINBART" });
    expect(s1.pendingAgreement).toBe(true);
    expect(s1.goal.status).toBe("ZUR_ABSTIMMUNG");
    const s2 = await changeGoalStatus(clemens, g.id, { version: s1.goal.version, status: "VEREINBART" });
    expect(s2.pendingAgreement).toBe(false);
    expect(s2.goal.status).toBe("VEREINBART");
    expect(s2.goal.agreedByUserIds.sort()).toEqual([clemens.userId, petra.userId].sort());
    // Änderung eines vereinbarten Ziels braucht Grund, erzeugt Version 2, setzt Zustimmungen zurück
    await expect(updateGoal(petra, g.id, { version: s2.goal.version, title: g.title, ownerUserId: petra.userId, desiredOutcome: "Belegter Kontakt zur Kapazitätsplanung und Einkauf." })).rejects.toBeInstanceOf(ValidationError);
    const u = await updateGoal(petra, g.id, { version: s2.goal.version, title: g.title, ownerUserId: petra.userId, desiredOutcome: "Belegter Kontakt zur Kapazitätsplanung und Einkauf.", changeNote: "Einkauf als zweite Zielgruppe ergänzt." });
    expect(u.status).toBe("GEAENDERT");
    expect(u.agreedByUserIds).toEqual([]);
    expect((await getGoal(petra, g.id)).versions).toHaveLength(2);
    // Beiträge: belegt nur mit Quelle; BD darf für eigenes Setup melden
    await expect(addGoalContribution(david, { goalId: g.id, setupId: s.setupId, evidencedContribution: "Frau Brandt vorgestellt" })).rejects.toBeInstanceOf(ValidationError);
    const src = await db.query.sources.findFirst({ where: eq(schema.sources.setupId, s.setupId) });
    const c = await addGoalContribution(david, { goalId: g.id, setupId: s.setupId, expectedContribution: "Kontaktweg über Frau Keller", evidencedContribution: "Vorstellung angefragt", evidenceSourceId: src!.id });
    expect(c?.evidenceSourceId).toBe(src!.id);
    // Sichtbarkeit: Nina (Anker mit Setup-Mitgliedschaft am Kunden) sieht das Ziel wegen Kundenbezug; Lars nicht
    expect((await listGoals(nina)).some((x) => x.id === g.id)).toBe(true);
    const lars = await actorFor("lars");
    expect((await listGoals(lars)).some((x) => x.id === g.id)).toBe(false);
    // Kein Ziel erzeugt automatische individuelle Quoten: keine Aktion/kein Wert am BD
    expect((await db.query.actions.findMany({ where: eq(schema.actions.ownerUserId, david.userId) })).some((a) => a.title.includes("Zugang im Migrationsteam"))).toBe(false);
  });
});
