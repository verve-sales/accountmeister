import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { changeArtifactStatus, createDraft, listArtifactsForSetup, listTemplates, listVersions, requireArtifact, saveNewVersion } from "@/modules/artifacts/service";
import { ARTIFACT_TEMPLATES } from "@/modules/artifacts/templates";
import { actorFor, ensureSeed } from "./helpers";

describe("Artefakte (Briefing 12, F09)", () => {
  it("Alle Artefakttypen sind registriert (A1–A16 + Setup, Weekly, Ziel) und in der Datenbank synchronisiert", async () => {
    await ensureSeed();
    const codes = listTemplates().map((t) => t.code);
    for (let i = 1; i <= 16; i++) expect(codes).toContain(`A${i}`);
    expect(codes).toEqual(expect.arrayContaining(["SETUP", "WEEKLY", "ZIEL"]));
    const rows = await db.query.artifactTemplates.findMany();
    expect(rows.length).toBe(ARTIFACT_TEMPLATES.length);
    // Jede Vorlage hat einen Umsetzungsstand – nichts wird stillschweigend als fertig ausgegeben
    expect(rows.every((r) => ["ANSICHT", "TEXTENTWURF", "FOLGT"].includes(r.implementation))).toBe(true);
  });

  it("Entwurf aus Vorlage wird aus berechtigten Daten vorbefüllt; Speichern erzeugt Versionen; Freigabe prüft Pflichtabschnitte", async () => {
    const s = await ensureSeed();
    const nina = await actorFor("nina");
    const v1 = await createDraft(nina, { templateCode: "A6", setupId: s.setupId });
    expect(v1.status).toBe("ENTWURF");
    expect(v1.versionNo).toBe(1);
    const c1 = v1.content as Record<string, string>;
    expect(c1.kontext).toContain("Plattformteam");
    expect(c1.grenzen).toContain("Nina nicht als Quelle nennen");
    // Ninas Vorbefüllung enthält Davids persönliche Quelle nicht
    expect(v1.sourceIds).not.toContain(s.privateSourceId);

    // Freigabe ohne Pflichtabschnitt „Ziel“ → Fehler
    await expect(changeArtifactStatus(nina, { versionId: v1.id, status: "FREIGEGEBEN" })).rejects.toBeInstanceOf(ValidationError);
    const v2 = await saveNewVersion(nina, { versionId: v1.id, title: "Gesprächsvorbereitung Frau Keller", content: { ...c1, ziel: "Verstehen, ob externe Testkoordination relevant ist." } });
    expect(v2.versionNo).toBe(2);
    // Von einer veralteten Version aus kann nicht gespeichert werden
    await expect(saveNewVersion(nina, { versionId: v1.id, title: "Veraltete Basis", content: c1 })).rejects.toBeInstanceOf(TransitionError);
    const approved = await changeArtifactStatus(nina, { versionId: v2.id, status: "FREIGEGEBEN" });
    expect(approved?.status).toBe("FREIGEGEBEN");
    expect(approved?.approvedBy).toBe(nina.userId);
    // Neue Version nach Freigabe: alte wird „überholt“, neue ist Entwurf
    const v3 = await saveNewVersion(nina, { versionId: v2.id, title: "Gesprächsvorbereitung Frau Keller", content: { ...c1, ziel: "Aktualisiert." } });
    expect(v3.status).toBe("ENTWURF");
    const versions = await listVersions(nina, v1.artifactKey);
    expect(versions.map((v) => v.status)).toEqual(["ENTWURF", "UEBERHOLT", "ENTWURF"]);
    const latest = await listArtifactsForSetup(nina, s.setupId);
    expect(latest.find((a) => a.artifactKey === v1.artifactKey)?.versionNo).toBe(3);
  });

  it("F09 / 12.2: Kundentext-Variante startet leer, erlaubt nur freigegebene Abschnitte, keine persönlichen Quellen, Freigabe mit Bestätigung – kein Vorstellungsstatus", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    await expect(createDraft(david, { templateCode: "A6", setupId: s.setupId, variant: "EXTERN" })).rejects.toBeInstanceOf(ValidationError);
    const ext = await createDraft(david, { templateCode: "A5", setupId: s.setupId, variant: "EXTERN", audience: "ACCOUNT_TEAM" });
    expect(Object.values(ext.content as Record<string, string>).every((x) => x === "")).toBe(true);
    expect(ext.sourceIds).toEqual([]);
    // interner Abschnitt im Kundentext → abgelehnt
    await expect(saveNewVersion(david, { versionId: ext.id, title: "Vorstellung", content: { vorstellung: "David betreut …", intern: "Herkunft: Weekly-Notiz Nina" } })).rejects.toBeInstanceOf(ValidationError);
    // persönliche Quelle im Kundentext → abgelehnt
    await expect(saveNewVersion(david, { versionId: ext.id, title: "Vorstellung", content: { vorstellung: "David betreut …" }, sourceIds: [s.privateSourceId] })).rejects.toBeInstanceOf(ValidationError);
    const ok = await saveNewVersion(david, { versionId: ext.id, title: "Vorstellung", content: { vorstellung: "David betreut bei Verve unsere Zusammenarbeit im Plattformbereich. Er würde gern klären, ob externe Unterstützung bei der Testkoordination sinnvoll sein könnte." } });
    await expect(changeArtifactStatus(david, { versionId: ok.id, status: "FREIGEGEBEN" })).rejects.toBeInstanceOf(ValidationError);
    const rel = await changeArtifactStatus(david, { versionId: ok.id, status: "FREIGEGEBEN", confirmNoConfidential: true });
    expect(rel?.status).toBe("FREIGEGEBEN");
    // Freigabe verändert keinen Beziehungsstand und keinen Kontaktweg (kein „vorgestellt“)
    const rels = await db.query.relationships.findMany({ where: eq(schema.relationships.setupId, s.setupId) });
    expect(rels.filter((r) => r.state === "VORGESTELLT" && r.contextNote?.includes("Artefakt"))).toHaveLength(0);
  });

  it("Coaching-Notiz (A14) hat gesonderten Empfängerkreis; Zugriff auf Artefakte folgt Empfängerkreis und Setup", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    const lars = await actorFor("lars");
    const petra = await actorFor("petra");
    await expect(createDraft(david, { templateCode: "A14", setupId: s.setupId, audience: "SETUP" })).rejects.toBeInstanceOf(ValidationError);
    const coaching = await createDraft(david, { templateCode: "A14", setupId: s.setupId, audience: "PERSOENLICH", title: "Coaching Fall Migrationsteam" });
    // Nina (Setup-Mitglied) sieht die persönliche Coaching-Notiz nicht; David schon
    await expect(requireArtifact(nina, coaching.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listArtifactsForSetup(nina, s.setupId)).some((a) => a.artifactKey === coaching.artifactKey)).toBe(false);
    expect((await requireArtifact(david, coaching.id)).version.id).toBe(coaching.id);
    // Petra (Principal) darf ohne Mitgliedschaft nicht entwerfen, aber Kundenteam-Artefakte lesen
    await expect(createDraft(petra, { templateCode: "A6", setupId: s.setupId })).rejects.toBeInstanceOf(ForbiddenError);
    const teamDraft = await createDraft(david, { templateCode: "A8", setupId: s.setupId, audience: "ACCOUNT_TEAM" });
    expect((await requireArtifact(petra, teamDraft.id)).canEdit).toBe(false);
    // Fremder BD: nichts
    await expect(requireArtifact(lars, teamDraft.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listArtifactsForSetup(lars, s.setupId)).rejects.toBeInstanceOf(NotFoundError);
  });
});
