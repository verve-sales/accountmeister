import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, ValidationError, DomainError } from "@/lib/errors";
import { resetConfigCacheForTests } from "@/lib/config";
import { connectMailbox, getMyConnection, listSelectable, revokeMailbox } from "@/modules/integrations/service";
import { sanitizeToText } from "@/modules/integrations/graph/adapter";
import { confirmImport, decideMerge, importMailboxItem, importProtocol, listMyImports, proposeForText, validateFileName } from "@/modules/imports/service";
import { getSource } from "@/modules/knowledge/service";
import { actorFor, ensureSeed } from "./helpers";

describe("Etappe 3 Teil B: Protokollimport und Outlook-Adapter (Briefing 13, S10, 19.2)", () => {
  it("S10: HTML, Skripte und Trackingbilder werden entfernt; Links nie abgerufen; Dateitypen begrenzt", () => {
    const out = sanitizeToText('Hallo <script>alert(1)</script><img src="https://t.example/p.gif"> <b>Team</b> – siehe https://x.example/klick');
    expect(out).not.toContain("<");
    expect(out).not.toContain("alert");
    expect(out).toContain("[Bild entfernt]");
    expect(out).toContain("https://x.example/klick"); // bleibt Text
    expect(() => validateFileName("protokoll.txt")).not.toThrow();
    expect(() => validateFileName("notizen.md")).not.toThrow();
    expect(() => validateFileName("makro.docm")).toThrow(ValidationError);
    expect(() => validateFileName("seite.html")).toThrow(ValidationError);
  });

  it("Protokolltext importieren: Quelle mit Version, Importauftrag, Warnungen, Zielvorschlag; Wiederimport idempotent, geänderter Text = neue Version", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const text = "Protokoll 18.09.: Frau Keller berichtet, dass das Migrationsteam zusätzliche Testtermine plant. Möglicherweise wird externe Testkoordination gebraucht. <b>fett</b>";
    const proposal = await proposeForText(david, text);
    expect(proposal.suggestedSetups.some((x) => x.id === s.setupId)).toBe(true);
    expect(proposal.warnings.some((w) => w.includes("HTML"))).toBe(true);

    const r1 = await importProtocol(david, { title: "Protokoll Weekly 18.09.", text, setupId: s.setupId, accessClass: "SETUP", structure: true });
    expect(r1.repeated).toBe(false);
    expect(r1.job.status).toBe("AUSGEWERTET");
    expect(r1.structured?.created).toBeGreaterThan(0);
    const src = await getSource(david, r1.sourceId);
    expect(src.source.type).toBe("PROTOKOLL");
    expect(src.source.body).not.toContain("<b>");
    const versions = await db.query.sourceVersions.findMany({ where: eq(schema.sourceVersions.sourceId, r1.sourceId) });
    expect(versions).toHaveLength(1);
    // Vorschläge referenzieren die Quelle
    const sugg = await db.query.suggestions.findMany({ where: eq(schema.suggestions.setupId, s.setupId) });
    expect(sugg.some((x) => x.sourceIds.includes(r1.sourceId))).toBe(true);

    // Erneut importieren (identisch) → kein zweiter Auftrag, keine doppelten Vorschläge
    const before = sugg.length;
    const r2 = await importProtocol(david, { title: "Protokoll Weekly 18.09.", text, setupId: s.setupId, structure: true });
    expect(r2.repeated).toBe(true);
    expect(r2.job.id).toBe(r1.job.id);
    expect((await db.query.suggestions.findMany({ where: eq(schema.suggestions.setupId, s.setupId) })).length).toBe(before);
    expect((await db.query.importJobs.findMany({ where: eq(schema.importJobs.externalKey, r1.job.externalKey) })).length).toBe(1);
  });

  it("Datei-Import: Dateityp geprüft; unklare Personenzuordnung landet in der Prüfliste; Bestätigung erst nach Entscheidung", async () => {
    const s = await ensureSeed();
    const david = await actorFor("david");
    await expect(importProtocol(david, { title: "Böse Datei", text: "x".repeat(20), fileName: "makro.docm", setupId: s.setupId })).rejects.toBeInstanceOf(ValidationError);
    // Zwei gleichnamige Personen anlegen → Name im Text ist mehrdeutig
    await db.insert(schema.persons).values([
      { workspaceId: s.workspaceId, accountId: s.accountId, displayName: "Frau Schulz (Einkauf, fiktiv)", createdBy: david.userId },
      { workspaceId: s.workspaceId, accountId: s.accountId, displayName: "Frau Schulz (Fachbereich, fiktiv)", createdBy: david.userId },
    ]);
    const r = await importProtocol(david, { title: "Gesprächsnotiz Schulz", text: "Frau Schulz hat im Termin gesagt, dass die Planung im Oktober steht.", fileName: "notiz.md", setupId: s.setupId });
    const items = (await listMyImports(david)).find((j) => j.id === r.job.id)!.mergeItems;
    const schulz = items.find((i) => i.mentionedName.toLowerCase().includes("schulz"))!;
    expect(schulz).toBeDefined();
    expect(schulz.candidates.length).toBe(2);
    expect(schulz.status).toBe("OFFEN");
    await expect(confirmImport(david, { importJobId: r.job.id, version: r.job.version })).rejects.toBeInstanceOf(ValidationError);
    await expect(decideMerge(david, { itemId: schulz.id, decision: "ZUSAMMENGEFUEHRT", personId: "fremde-id" })).rejects.toBeInstanceOf(ValidationError);
    await decideMerge(david, { itemId: schulz.id, decision: "ZUSAMMENGEFUEHRT", personId: schulz.candidates[0]!.id });
    const confirmed = await confirmImport(david, { importJobId: r.job.id, version: r.job.version });
    expect(confirmed.status).toBe("BESTAETIGT");
    // Keine automatische Zusammenführung: Personenzahl unverändert
    expect((await db.query.persons.findMany({ where: eq(schema.persons.accountId, s.accountId) })).filter((p) => p.displayName.includes("Schulz"))).toHaveLength(2);
  });

  it("Outlook-Adapter: echter Verbindungsversuch wird ehrlich abgewiesen; Fixture-Verbindung listet Objekte, importiert einzeln, Termin belegt keine Beziehung; Widerruf", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    await expect(connectMailbox(david, { fixture: false })).rejects.toMatchObject({ code: "ADAPTER_NOT_CONFIGURED" });
    await expect(listSelectable(david, "MAIL")).rejects.toBeInstanceOf(ValidationError);
    const conn = await connectMailbox(david, { fixture: true });
    expect(conn?.fixtureMode).toBe(true);
    expect(conn?.tokenRef?.startsWith("fixture:")).toBe(true);
    const my = await getMyConnection(david);
    expect(my.state.connected).toBe(true);
    expect(my.state.grantedScopes).toEqual(expect.arrayContaining(["Mail.Read", "Calendars.Read"]));
    expect(my.state.grantedScopes.some((sc) => /Send|ReadWrite/.test(sc))).toBe(false);
    const { items } = await listSelectable(david, "MAIL", "Kapazitäten");
    expect(items).toHaveLength(1);
    expect(items[0]?.preview).not.toContain("<");

    // Mail importieren (persönlich) + strukturieren
    const imp = await importMailboxItem(david, { kind: "MAIL", externalId: "AAMkFIXTURE-0001", setupId: s.setupId, accessClass: "PERSOENLICH", structure: true });
    expect(imp.job.kind).toBe("MAIL");
    expect(imp.job.warnings.some((w) => w.includes("Fixture"))).toBe(true);
    const nina = await actorFor("nina");
    await expect(getSource(nina, imp.sourceId)).rejects.toBeInstanceOf(NotFoundError); // persönlich
    const mine = await getSource(david, imp.sourceId);
    expect(mine.source.type).toBe("EMAIL");
    expect(mine.source.body).toContain("Von: Keller, Anne");
    // Mail belegt eine Aussage, nicht ihre Richtigkeit: keine bestätigten Aussagen entstanden
    const confirmedAss = await db.query.assertions.findMany({ where: and(eq(schema.assertions.setupId, s.setupId), eq(schema.assertions.epistemicStatus, "SACHVERHALT_BESTAETIGT")) });
    expect(confirmedAss.every((a) => !a.content.includes("Brandt"))).toBe(true);
    // Idempotenz bei zweitem Import derselben Mail
    const again = await importMailboxItem(david, { kind: "MAIL", externalId: "AAMkFIXTURE-0001", setupId: s.setupId });
    expect(again.repeated).toBe(true);

    // Termin: Import erzeugt keine Beziehung („Kalendereintrag beweist keine Teilnahme“)
    const relBefore = (await db.query.relationships.findMany({ where: eq(schema.relationships.setupId, s.setupId) })).length;
    const ev = await importMailboxItem(david, { kind: "TERMIN", externalId: "AAMkEVENT-0001", setupId: s.setupId });
    expect((await getSource(david, ev.sourceId)).source.body).toContain("belegt Planung, nicht Teilnahme");
    expect((await db.query.relationships.findMany({ where: eq(schema.relationships.setupId, s.setupId) })).length).toBe(relBefore);
    // Anhänge nicht übernommen
    const mail2 = await importMailboxItem(david, { kind: "MAIL", externalId: "AAMkFIXTURE-0002", setupId: s.setupId });
    expect(mail2.job.warnings.some((w) => w.includes("Anhang"))).toBe(true);
    expect((await getSource(david, mail2.sourceId)).source.body).not.toContain("xlsx-Inhalt");
    // Newsletter mit Skript/Tracker: bereinigt
    const nl = await importMailboxItem(david, { kind: "MAIL", externalId: "AAMkFIXTURE-0003", setupId: s.setupId });
    const nlBody = (await getSource(david, nl.sourceId)).source.body ?? "";
    expect(nlBody).not.toContain("<script");
    expect(nlBody).not.toContain("<img");

    await revokeMailbox(david);
    await expect(listSelectable(david, "MAIL")).rejects.toBeInstanceOf(ValidationError);
    await expect(importMailboxItem(david, { kind: "MAIL", externalId: "AAMkFIXTURE-0001", setupId: s.setupId })).rejects.toBeInstanceOf(ValidationError);
  });

  it("Zugriff: fremder BD kann nicht in fremdes Setup importieren; nur eigene Importe sichtbar", async () => {
    const s = await ensureSeed();
    const lars = await actorFor("lars");
    await expect(importProtocol(lars, { title: "Fremd", text: "Lars versucht in ein fremdes Setup zu importieren.", setupId: s.setupId })).rejects.toBeInstanceOf(NotFoundError);
    const david = await actorFor("david");
    const mine = await listMyImports(david);
    const theirs = await listMyImports(lars);
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.some((j) => mine.some((m) => m.id === j.id))).toBe(false);
    void ForbiddenError;
    void DomainError;
  });
});
