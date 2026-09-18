import { describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { resetConfigCacheForTests } from "@/lib/config";
import { checkRateLimit, resetRateLimitsForTests } from "@/lib/ratelimit";
import { isSessionExpired, SESSION_IDLE_SECONDS, SESSION_MAX_AGE_SECONDS } from "@/modules/identity/session";
import { assignRole, dataInventory, eraseSourceContent, listAuditEvents, listUsersWithRoles, lockSource, revokeRole } from "@/modules/governance/service";
import { createSetup, getSetupDetail } from "@/modules/setups/service";
import { createReview, saveReviewDraft } from "@/modules/reviews/service";
import { structureReviewNote, listSuggestionsForSetup, acceptSuggestion } from "@/modules/suggestions/service";
import { createDraft } from "@/modules/artifacts/service";
import { captureObservation } from "@/modules/signals/service";
import { getSource } from "@/modules/knowledge/service";
import { importProtocol } from "@/modules/imports/service";
import { actorFor, ensureSeed } from "./helpers";

const NOTE = "Im Plattformteam wird über zusätzlichen Testkoordinationsaufwand gesprochen. Möglicherweise entsteht Bedarf an externer Unterstützung. David fragt Frau Keller, wer die Kapazitätsplanung koordiniert.";

describe("Etappe 5 Teil B: Härtung (Briefing 16.2, 16.4, 17.4; S07, S08, S09)", () => {
  it("S07: Sperren einer Quelle markiert abhängige Vorschläge, Artefaktfassungen und Aussagen als überholt; Löschen entfernt Inhalt, behält Metadaten und Protokoll", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const setup = await createSetup(david, { accountId: s.accountId, name: `Sperrtest ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });
    // Beobachtung → Quelle + Aussage; Weekly-Notiz → Vorschläge; Artefakt-Entwurf nutzt sichtbare Quellen
    const { source, signal } = await captureObservation(david, { setupId: setup.id, observation: "Frau Keller hat den zusätzlichen Testkoordinationsaufwand ausdrücklich bestätigt." });
    const r = await createReview(david, { setupId: setup.id, scheduledFor: "2026-10-19" });
    const draft = await saveReviewDraft(david, r.id, { version: r.version, noteDraft: NOTE });
    await structureReviewNote(david, draft.id);
    const before = await listSuggestionsForSetup(david, setup.id, { reviewId: draft.id });
    expect([...before.prominent, ...before.more].length).toBeGreaterThan(0);
    const art = await createDraft(david, { templateCode: "A6", setupId: setup.id });
    expect(art.sourceIds).toContain(source.id);

    // Fremder BD darf weder sperren noch Existenz erfahren
    const lars = await actorFor("lars");
    await expect(lockSource(lars, source.id, { reason: "Fremdversuch" })).rejects.toBeInstanceOf(NotFoundError);
    // Ohne Grund keine Sperrung
    await expect(lockSource(david, source.id, { reason: "" })).rejects.toBeInstanceOf(ValidationError);

    const res = await lockSource(david, source.id, { reason: "Löschverlangen der betroffenen Person." });
    expect(res.artifactVersionsSuperseded).toBeGreaterThanOrEqual(1);
    expect(res.assertionsSuperseded).toBeGreaterThanOrEqual(1);
    const artAfter = await db.query.artifactVersions.findFirst({ where: eq(schema.artifactVersions.id, art.id) });
    expect(artAfter?.status).toBe("UEBERHOLT");
    const assertionsAfter = await db.query.assertions.findMany({ where: eq(schema.assertions.setupId, setup.id) });
    expect(assertionsAfter.some((a) => a.epistemicStatus === "UEBERHOLT")).toBe(true);
    // Gesperrte Quelle: andere sehen sie nicht mehr, Inhaber weiterhin
    const nina = await actorFor("nina");
    await db.insert(schema.setupMemberships).values({ setupId: setup.id, userId: nina.userId, contribution: "ANKER_KONTEXT", canEdit: true });
    await expect(getSource(nina, source.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getSource(david, source.id)).source.isLocked).toBe(true);
    // Vorschläge aus einem importierten Protokoll tragen die Quelle; Sperrung macht sie überholt und nicht mehr annehmbar
    const imp = await importProtocol(david, { title: "Protokoll Sperrtest", text: NOTE + " Wer entscheidet über externe Kapazitäten?", setupId: setup.id, accessClass: "SETUP", structure: true });
    expect(imp.structured?.created).toBeGreaterThan(0);
    const r2 = await lockSource(david, imp.sourceId, { reason: "Protokoll enthält vertrauliche Aussage; Sperrung bis Klärung." });
    expect(r2.suggestionsSuperseded).toBeGreaterThan(0);
    const after = await listSuggestionsForSetup(david, setup.id);
    expect([...after.prominent, ...after.more].some((x) => x.sourceIds.includes(imp.sourceId))).toBe(false);
    const superseded = await db.query.suggestions.findMany({ where: and(eq(schema.suggestions.setupId, setup.id), eq(schema.suggestions.status, "UEBERHOLT")) });
    expect(superseded.length).toBe(r2.suggestionsSuperseded);
    await expect(acceptSuggestion(david, superseded[0]!.id, { version: superseded[0]!.version })).rejects.toBeInstanceOf(TransitionError);
    // Zweifache Sperrung, Löschen ohne Sperrung
    await expect(lockSource(david, source.id, { reason: "noch einmal sperren" })).rejects.toBeInstanceOf(TransitionError);
    const other = await captureObservation(david, { setupId: setup.id, observation: "Zweite Beobachtung ohne Sperrung, nur zur Kontrolle." });
    await expect(eraseSourceContent(david, other.source.id, { reason: "Direkt löschen ohne Sperrung" })).rejects.toBeInstanceOf(TransitionError);
    // Löschen: Inhalt weg, Metadaten bleiben
    const erased = await eraseSourceContent(david, source.id, { reason: "Löschverlangen umgesetzt." });
    expect(erased.sourceId).toBe(source.id);
    const src = await db.query.sources.findFirst({ where: eq(schema.sources.id, source.id) });
    expect(src?.body).toBeNull();
    expect(src?.title).toBe("[Inhalt gelöscht]");
    expect(src?.type).toBe("NOTIZ");
    expect(src?.sourceTime).toBeInstanceOf(Date);
    // Abgeleitete Inhalte ohne andere Grundlage verlieren ihren Text; der Hinweis bleibt als begründet beendetes Objekt
    const sig = await db.query.signals.findFirst({ where: eq(schema.signals.id, signal.id) });
    expect(sig?.sourceId).toBe(source.id);
    expect(sig?.observation).not.toContain("Testkoordinationsaufwand");
    expect(sig?.status).toBe("BEENDET");
    const derived = await db.query.assertions.findMany({ where: eq(schema.assertions.setupId, setup.id) });
    expect(derived.some((a) => a.content.includes("Frau Keller hat den zusätzlichen"))).toBe(false);
    expect(erased.assertionsErased).toBeGreaterThanOrEqual(1);
    // Protokoll: Sperr- und Löschereignis ohne Inhalt
    const audit = await db.query.auditEvents.findMany({ where: and(eq(schema.auditEvents.objectId, source.id), inArray(schema.auditEvents.action, ["source.locked", "source.erased"])) });
    expect(audit.map((a) => a.action).sort()).toEqual(["source.erased", "source.locked"]);
    expect(JSON.stringify(audit)).not.toContain("Testkoordinationsaufwand");
    const detail = await getSetupDetail(david, setup.id);
    expect(detail.setup.id).toBe(setup.id);
  });

  it("S08: Protokoll und KI-Aufträge enthalten keine Rohtexte, Tokens oder überlangen Felder", async () => {
    await ensureSeed();
    const all = await db.query.auditEvents.findMany();
    expect(all.length).toBeGreaterThan(0);
    for (const ev of all) {
      const json = JSON.stringify(ev.changes ?? {});
      expect(json.length).toBeLessThan(600);
      expect(json).not.toMatch(/token|secret|password|bearer/i);
    }
    const jobs = await db.query.aiJobs.findMany();
    for (const j of jobs) expect(JSON.stringify(j)).not.toMatch(/Testkoordinationsaufwand|Kapazitätsplanung/);
    const conns = await db.query.integrationConnections.findMany();
    for (const c of conns) expect(JSON.stringify(c)).not.toMatch(/eyJ|access_token/);
  });

  it("Verwaltung: nur ADMIN sieht Rollen, Protokoll und Bestand – ohne Inhalte; ADMIN erhält keine Setup-Inhalte", async () => {
    const s = await ensureSeed();
    const admin = await actorFor("admin");
    const david = await actorFor("david");
    const clemens = await actorFor("clemens");
    await expect(listAuditEvents(david)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listUsersWithRoles(clemens)).rejects.toBeInstanceOf(ForbiddenError);
    const events = await listAuditEvents(admin, 50);
    expect(events.length).toBeGreaterThan(0);
    // Nur Feldnamen, keine Werte
    for (const e of events) expect(Object.keys(e).sort()).toEqual(["action", "actor", "at", "changeKeys", "id", "objectId", "objectType"]);
    const inv = await dataInventory(admin);
    expect(inv.fall.setups).toBeGreaterThan(0);
    expect(JSON.stringify(inv)).not.toMatch(/Beispielkonzern|Keller/);
    // ADMIN ohne Inhaltszugriff (16.2)
    await expect(getSetupDetail(admin, s.setupId)).rejects.toBeInstanceOf(NotFoundError);
    // Rollenpflege
    const users = await listUsersWithRoles(admin);
    const nina = users.find((u) => u.displayName.includes("Nina"))!;
    await expect(assignRole(admin, { userId: nina.id, role: "ANKER", accountId: s.accountId })).rejects.toBeInstanceOf(ValidationError); // kundenbezogen nur BD/Principal
    await expect(assignRole(admin, { userId: nina.id, role: "ANKER" })).rejects.toBeInstanceOf(ValidationError); // bereits vorhanden
    const r = await assignRole(admin, { userId: nina.id, role: "BD", accountId: s.otherAccountId });
    expect(r?.scope).toBe("ACCOUNT");
    await revokeRole(admin, r!.id);
    const own = users.find((u) => u.id === admin.userId)!.roles.find((x) => x.role === "ADMIN")!;
    await expect(revokeRole(admin, own.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("17.4: Nutzungsgrenze und Sitzungsablauf", () => {
    resetRateLimitsForTests();
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) expect(checkRateLimit("k", 3, 1000, now).allowed).toBe(true);
    const blocked = checkRateLimit("k", 3, 1000, now + 10);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(checkRateLimit("k", 3, 1000, now + 1001).allowed).toBe(true);
    const t = Date.now();
    expect(isSessionExpired({ userId: "u", issuedAt: t, lastSeenAt: t }, t)).toBe(false);
    expect(isSessionExpired({ userId: "u", issuedAt: t, lastSeenAt: t }, t + (SESSION_IDLE_SECONDS + 1) * 1000)).toBe(true);
    expect(isSessionExpired({ userId: "u", issuedAt: t, lastSeenAt: t + SESSION_MAX_AGE_SECONDS * 1000 }, t + (SESSION_MAX_AGE_SECONDS + 1) * 1000)).toBe(true);
    expect(isSessionExpired({}, t)).toBe(true);
  });
});
