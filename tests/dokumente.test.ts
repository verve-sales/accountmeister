import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { resetConfigCacheForTests } from "@/lib/config";
import { eraseDocumentFile, getDocumentFile, uploadDocument, type UploadedFile } from "@/modules/documents/service";
import { extractDocumentText, extensionOf } from "@/modules/documents/extract";
import { eraseSourceContent, lockSource } from "@/modules/governance/service";
import { getSource } from "@/modules/knowledge/service";
import { createSetup } from "@/modules/setups/service";
import { structureSource, listSuggestionsForSetup } from "@/modules/suggestions/service";
import { applyIntake, discardIntake, formToApplyInput, getIntake, startIntake } from "@/modules/intake/service";
import { LangdockProvider, LangdockError, parseJsonLoose } from "@/modules/ai/providers/langdock";
import { TestProvider } from "@/modules/ai/providers/test";
import { intakeProposalSchema } from "@/modules/ai/schemas";
import { getTaskOptions, saveTaskSetting } from "@/modules/ai/settings";
import { listOpportunitiesForSetup } from "@/modules/opportunities/service";
import { actorFor, ensureSeed } from "./helpers";

const uploadDir = mkdtempSync(path.join(tmpdir(), "verve-uploads-"));

function file(name: string, content: string | Buffer, type = "text/plain"): UploadedFile {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return { name, type, size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
}

const DOC = `Gesprächsnotiz Musterwerk GmbH, 18.09.2026
Teilnehmende: Herr Berger, Leiter IT; Frau Sommer, Einkauf.
Die Musterwerk GmbH plant die Ablösung des Altsystems im Lager bis Mitte 2027.
Herr Berger sucht Unterstützung bei der Testkoordination für die Migration.
Das Budget wurde noch nicht freigegeben.`;

describe("Etappe 6A: Dokumente als Quellen", () => {
  it("Upload im Setup: Text wird extrahiert, Quelle vom Typ DOKUMENT mit Datei; fremder BD sieht nichts; Löschen entfernt Text und Datei", async () => {
    process.env.UPLOAD_DIR = uploadDir;
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const lars = await actorFor("lars");
    const setup = await createSetup(david, { accountId: s.accountId, name: `Dokumenttest ${Date.now().toString(36)}`, contextNote: "Kontext", bdUserId: david.userId });

    await expect(uploadDocument(david, { setupId: setup.id }, file("virus.exe", "x"))).rejects.toBeInstanceOf(ValidationError);
    await expect(uploadDocument(david, { setupId: setup.id }, null)).rejects.toBeInstanceOf(ValidationError);
    await expect(uploadDocument(lars, { setupId: setup.id }, file("n.txt", DOC))).rejects.toBeInstanceOf(NotFoundError);

    const r = await uploadDocument(david, { setupId: setup.id, title: "Gesprächsnotiz Musterwerk" }, file("notiz.txt", DOC));
    expect(r.extract.status).toBe("OK");
    const q = await getSource(david, r.sourceId);
    expect(q.source.type).toBe("DOKUMENT");
    expect(q.source.body).toContain("Testkoordination");
    expect(q.document?.fileName).toBe("notiz.txt");
    expect(q.document?.storagePath).toBeTruthy();
    expect(existsSync(path.join(uploadDir, q.document!.storagePath!))).toBe(true);

    // Download: nur mit Leserecht; jeder Abruf protokolliert
    const dl = await getDocumentFile(david, r.documentId);
    expect(dl.data.toString("utf8")).toContain("Musterwerk");
    await expect(getDocumentFile(lars, r.documentId)).rejects.toBeInstanceOf(NotFoundError);
    const audit = await db.query.auditEvents.findMany({ where: eq(schema.auditEvents.objectId, r.sourceId) });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["document.uploaded", "document.downloaded"]));

    // Strukturieren des Dokuments erzeugt Vorschläge mit Quellenbezug (Testanbieter)
    const st = await structureSource(david, r.sourceId);
    expect(st.created).toBeGreaterThan(0);
    const sugg = await listSuggestionsForSetup(david, setup.id);
    expect([...sugg.prominent, ...sugg.more].some((x) => x.sourceIds.includes(r.sourceId))).toBe(true);
    const again = await structureSource(david, r.sourceId);
    expect(again.repeated).toBe(true);

    // Sperren + Inhalt entfernen: Text weg, Datei weg, Metadaten bleiben
    await lockSource(david, r.sourceId, { reason: "Löschverlangen im Test" });
    const erased = await eraseSourceContent(david, r.sourceId, { reason: "Löschverlangen im Test" });
    expect(erased.fileErased).toBe(true);
    const after = await db.query.documents.findFirst({ where: eq(schema.documents.sourceId, r.sourceId) });
    expect(after?.storagePath).toBeNull();
    expect(after?.deletedAt).toBeTruthy();
    expect(after?.fileName).toBe("notiz.txt");
    expect(existsSync(path.join(uploadDir, q.document!.storagePath!))).toBe(false);
    await expect(getDocumentFile(david, r.documentId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("Extraktion: CSV, Markdown und leere Dateien; unbekannte Endungen abgelehnt", async () => {
    expect(extensionOf("Bericht.PDF")).toBe("pdf");
    expect(extensionOf("bild.png")).toBeNull();
    const csv = await extractDocumentText(Buffer.from("Name;Funktion\nBerger;Leiter IT\nSommer;Einkauf\n"), "csv");
    expect(csv.status).toBe("OK");
    expect(csv.text).toContain("Berger | Leiter IT");
    const md = await extractDocumentText(Buffer.from("# Titel\n\nEin Absatz mit genügend Text für die Prüfung."), "md");
    expect(md.status).toBe("OK");
    const empty = await extractDocumentText(Buffer.from("  "), "txt");
    expect(empty.status).toBe("LEER");
    const broken = await extractDocumentText(Buffer.from("kein pdf"), "pdf");
    expect(["FEHLER", "LEER"]).toContain(broken.status);
    const ok = await eraseDocumentFile(db, "gibt-es-nicht");
    expect(ok).toBe(false);
  });
});

describe("Etappe 6B: Kundenanlage aus Dokument", () => {
  it("Dokument → Vorschlag (Testanbieter) → Übernahme legt Kunde, Setup, Person, Signal und Bedarf an; Dokument wird dem Setup zugeordnet", async () => {
    process.env.UPLOAD_DIR = uploadDir;
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    await ensureSeed();
    const david = await actorFor("david");
    const nina = await actorFor("nina");
    await expect(startIntake(nina, {}, file("n.txt", DOC))).rejects.toBeInstanceOf(ForbiddenError);

    const proposal = await startIntake(david, { title: "Musterwerk Notiz" }, file("musterwerk.txt", DOC));
    const d = await getIntake(david, proposal.id);
    expect(d.payload.aiStatus).toBe("vorschlag");
    expect(d.payload.organization?.name).toContain("Musterwerk GmbH");
    expect(d.payload.persons.map((p) => p.displayName)).toEqual(expect.arrayContaining(["Herr Berger", "Frau Sommer"]));
    expect(d.payload.needs.length).toBeGreaterThan(0);
    expect(d.source?.setupId).toBeNull();
    expect(d.source?.accessClass).toBe("PERSOENLICH");
    // Fremder Nutzer sieht den Vorschlag nicht
    const lars = await actorFor("lars");
    await expect(getIntake(lars, proposal.id)).rejects.toBeInstanceOf(NotFoundError);

    const form = formToApplyInput({
      orgName: "Musterwerk GmbH",
      orgType: "SONSTIGE",
      setupName: "Erstkontakt Musterwerk",
      contextNote: "Lagerlogistik-Migration",
      documentAccessClass: "SETUP",
      "persons.0.include": "on",
      "persons.0.displayName": "Herr Berger",
      "persons.0.functionTitle": "Leiter IT",
      "persons.0.email": "",
      "persons.0.knownResponsibility": "",
      "persons.1.displayName": "Frau Sommer", // kein Häkchen → nicht angelegt
      "persons.1.functionTitle": "Einkauf",
      "signals.0.include": "on",
      "signals.0.observation": "Die Musterwerk GmbH plant die Ablösung des Altsystems im Lager bis Mitte 2027.",
      "signals.0.relevanceHypothesis": "",
      "needs.0.include": "on",
      "needs.0.title": "Testkoordination Migration",
      "needs.0.needDescription": "Unterstützung bei der Testkoordination für die Migration des Lagersystems.",
    });
    const res = await applyIntake(david, proposal.id, form);
    expect(res.problems).toEqual([]);
    expect(res.created).toMatchObject({ persons: 1, signals: 1, needs: 1 });
    const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, res.accountId) });
    expect(account?.name).toBe("Musterwerk GmbH");
    expect(account?.responsibleBdUserId).toBe(david.userId);
    const src = await db.query.sources.findFirst({ where: eq(schema.sources.id, proposal.sourceId) });
    expect(src?.setupId).toBe(res.setupId);
    expect(src?.accessClass).toBe("SETUP");
    const persons = await db.query.persons.findMany({ where: eq(schema.persons.accountId, res.accountId) });
    expect(persons.map((p) => p.displayName)).toEqual(["Herr Berger"]);
    const signals = await db.query.signals.findMany({ where: eq(schema.signals.setupId, res.setupId) });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.sourceId).toBe(proposal.sourceId);
    expect(signals[0]?.status).toBe("NEU");
    const opps = await listOpportunitiesForSetup(david, res.setupId);
    expect(opps).toHaveLength(1);
    expect(opps[0]?.status).toBe("IN_KLAERUNG");
    // Zweite Übernahme ist ausgeschlossen
    await expect(applyIntake(david, proposal.id, form)).rejects.toBeInstanceOf(TransitionError);
  });

  it("Ohne KI: Vorschlag entsteht leer, Übernahme mit bestehendem Kunden funktioniert; Verwerfen möglich", async () => {
    process.env.UPLOAD_DIR = uploadDir;
    process.env.AI_PROVIDER = "disabled";
    resetConfigCacheForTests();
    const s = await ensureSeed();
    const david = await actorFor("david");
    const p = await startIntake(david, {}, file("kurz.txt", DOC));
    const d = await getIntake(david, p.id);
    expect(d.payload.aiStatus).toBe("ohne_ki");
    expect(d.payload.organization).toBeNull();
    const res = await applyIntake(david, p.id, formToApplyInput({ existingAccountId: s.accountId, setupName: "Nachtrag aus Dokument", documentAccessClass: "ACCOUNT_TEAM" }));
    expect(res.accountId).toBe(s.accountId);
    const p2 = await startIntake(david, {}, file("kurz2.txt", DOC));
    await discardIntake(david, p2.id);
    const after = await db.query.intakeProposals.findFirst({ where: eq(schema.intakeProposals.id, p2.id) });
    expect(after?.status).toBe("VERWORFEN");
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
  });

  it("Testanbieter liefert schemakonforme Anlagevorschläge; Elemente ohne Textbeleg werden vom Dienst verworfen", async () => {
    const raw = await new TestProvider().analyzeDocument({ documentText: DOC, fileName: "x.txt", knownAccountNames: ["Beispielkonzern"] });
    expect(intakeProposalSchema.safeParse(raw).success).toBe(true);
    process.env.UPLOAD_DIR = uploadDir;
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    await ensureSeed();
    const david = await actorFor("david");
    const halluzinierend = {
      info: () => ({ id: "test" as const, model: "halluziniert", enabled: true, description: "" }),
      async structureNote() {
        return { items: [] };
      },
      async analyzeDocument() {
        return {
          organization: { name: "Erfundene AG", orgType: "KONZERN", possibleExistingAccount: "Beispielkonzern", evidenceQuote: "steht nirgends im Text" },
          setup: { name: "Setup X" },
          persons: [{ displayName: "Herr Berger", functionTitle: "Leiter IT", evidenceQuote: "Herr Berger, Leiter IT" }, { displayName: "Dr. Niemand", evidenceQuote: "nicht vorhanden" }],
          signals: [],
          needs: [],
        };
      },
    };
    const p = await startIntake(david, {}, file("h.txt", DOC), { provider: halluzinierend });
    const d = await getIntake(david, p.id);
    expect(d.payload.organization).toBeNull();
    expect(d.payload.persons.map((x) => x.displayName)).toEqual(["Herr Berger"]);
    expect(d.payload.rejected).toBe(2);
    const job = await db.query.aiJobs.findFirst({ where: eq(schema.aiJobs.id, p.aiJobId!) });
    expect(job?.status).toBe("ERFOLGREICH");
    expect(job?.rejectedCount).toBe(2);
  });
});

describe("Etappe 6C: Langdock-Adapter und Modellwahl je Aufgabe", () => {
  it("Langdock: Anfrage im JSON-Modus, Verbrauch wird erfasst, Fehler werden verständlich gemeldet", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini", owned_by: "openai" }, { id: "claude-sonnet-4", owned_by: "anthropic" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: u, body });
      if (body.model === "kaputt") return new Response("nope", { status: 404 });
      if (body.model === "abgelehnt") return new Response("nope", { status: 401 });
      return new Response(JSON.stringify({ model: String(body.model), usage: { prompt_tokens: 120, completion_tokens: 30 }, choices: [{ message: { content: "```json\n{\"items\":[],\"noSuggestionReason\":\"nichts\"}\n```" } }] }), { status: 200 });
    }) as typeof fetch;
    const p = new LangdockProvider({ apiKey: "k", baseUrl: "https://api.langdock.test/openai/eu/v1", defaultModel: "gpt-4o-mini", fetchImpl });
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-4", "gpt-4o-mini"]);
    const out = await p.structureNote({ noteText: "Text der Notiz", setupName: "S", participantNames: ["David"], knownPersonNames: [], confirmedAssertions: [] }, { model: "claude-sonnet-4", temperature: 0 });
    expect(out).toEqual({ items: [], noSuggestionReason: "nichts" });
    expect(calls[0]?.url).toBe("https://api.langdock.test/openai/eu/v1/chat/completions");
    expect(calls[0]?.body.model).toBe("claude-sonnet-4");
    expect(calls[0]?.body.response_format).toEqual({ type: "json_object" });
    expect(String((calls[0]?.body.messages as { content: string }[])[1]?.content)).toContain("Text der Notiz");
    expect(p.lastUsage()).toEqual({ tokensIn: 120, tokensOut: 30, model: "claude-sonnet-4" });
    await expect(p.analyzeDocument({ documentText: "x", fileName: "f", knownAccountNames: [] }, { model: "kaputt" })).rejects.toBeInstanceOf(LangdockError);
    await expect(p.analyzeDocument({ documentText: "x", fileName: "f", knownAccountNames: [] }, { model: "abgelehnt" })).rejects.toThrow(/Schlüssel/);
    expect(parseJsonLoose('Hier: {"a":1} fertig')).toEqual({ a: 1 });
    // HTTP 400 auf den strikten Aufruf → genau ein konservativer zweiter Versuch (ohne JSON-Modus/Temperatur, max_completion_tokens)
    const strictCalls: Record<string, unknown>[] = [];
    const picky = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      strictCalls.push(body);
      if (body.response_format) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'response_format'" } }), { status: 400 });
      return new Response(JSON.stringify({ model: "o-modell", usage: { prompt_tokens: 5, completion_tokens: 2 }, choices: [{ message: { content: '{"items":[]}' } }] }), { status: 200 });
    }) as typeof fetch;
    const p2 = new LangdockProvider({ apiKey: "k", baseUrl: "https://api.langdock.test/openai/eu/v1", defaultModel: "o-modell", fetchImpl: picky });
    expect(await p2.structureNote({ noteText: "x", setupName: "S", participantNames: [], knownPersonNames: [], confirmedAssertions: [] })).toEqual({ items: [] });
    expect(strictCalls).toHaveLength(2);
    expect(strictCalls[1]).not.toHaveProperty("response_format");
    expect(strictCalls[1]).not.toHaveProperty("temperature");
    expect(strictCalls[1]).toHaveProperty("max_completion_tokens");
    // Bleibt es bei 400, nennt der Fehler den Anbietertext
    const stubborn = (async () => new Response(JSON.stringify({ error: { message: "model does not support system messages" } }), { status: 400 })) as typeof fetch;
    const p3 = new LangdockProvider({ apiKey: "k", baseUrl: "https://api.langdock.test/openai/eu/v1", defaultModel: "m", fetchImpl: stubborn });
    await expect(p3.ping()).rejects.toThrow(/HTTP 400.*system messages/);
    expect(() => parseJsonLoose("kein json")).toThrow(LangdockError);
  });

  it("Modellwahl je Aufgabe: Standard aus Konfiguration, Speichern nur durch ADMIN, Änderung protokolliert", async () => {
    await ensureSeed();
    const admin = await actorFor("admin");
    const david = await actorFor("david");
    const def = await getTaskOptions(admin.workspaceId, "ANALYZE_DOCUMENT");
    expect(def.source).toBe("standard");
    await expect(saveTaskSetting(david, { task: "ANALYZE_DOCUMENT", model: "gpt-4o" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveTaskSetting(admin, { task: "UNBEKANNT", model: "gpt-4o" })).rejects.toBeInstanceOf(ValidationError);
    await saveTaskSetting(admin, { task: "ANALYZE_DOCUMENT", model: "gpt-4o", temperature: "0.1", maxOutputTokens: "6000", enabled: "on" });
    const after = await getTaskOptions(admin.workspaceId, "ANALYZE_DOCUMENT");
    expect(after).toMatchObject({ model: "gpt-4o", temperature: 0.1, maxOutputTokens: 6000, enabled: true, source: "konfiguriert" });
    await saveTaskSetting(admin, { task: "ANALYZE_DOCUMENT", model: "gpt-4o" });
    expect((await getTaskOptions(admin.workspaceId, "ANALYZE_DOCUMENT")).enabled).toBe(false);
    const audit = await db.query.auditEvents.findMany({ where: eq(schema.auditEvents.action, "ai.task_setting_saved") });
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit[0]?.changes)).not.toContain("Bearer");
  });
});
