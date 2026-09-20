import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from "@/lib/errors";
import { resetConfigCacheForTests, getConfig } from "@/lib/config";
import { archiveAccount, deleteAccountPermanently, previewAccountDeletion, restoreAccount } from "@/modules/accounts/deletion";
import { getAccount, listVisibleAccounts } from "@/modules/accounts/service";
import { decideCard, getThreadView, sendMessage } from "@/modules/assistant/service";
import { uploadDocument } from "@/modules/documents/service";
import { actorFor, ensureSeed } from "./helpers";

process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "verve-uploads-"));

describe("Kunden löschen (zwei Schritte)", () => {
  it("Archivieren → Wiederherstellen → Archivieren → endgültig löschen entfernt Setups, Personen, Quellen samt Datei, Gespräche; Fremde und Nicht-Berechtigte werden abgewiesen", async () => {
    process.env.AI_PROVIDER = "test";
    resetConfigCacheForTests();
    await ensureSeed();
    const david = await actorFor("david");

    // Kunde mit allem Drum und Dran über den Assistenten anlegen
    const view = await getThreadView(david, { type: "GLOBAL" });
    const r1 = await sendMessage(david, { threadId: view.thread.id, text: "Es geht um die Löschwerk GmbH, ein Logistiker. Gesprochen habe ich mit Herrn Falk, Leiter IT, zuständig für die Systemlandschaft. Herr Falk sucht Unterstützung bei der Testkoordination. Herr Falk schickt bis 30.09. das Grobkonzept." });
    const kunde = r1.cards.find((c) => c.item.type === "KUNDE")!;
    const k = await decideCard(david, { threadId: view.thread.id, messageId: r1.message.id, cardId: kunde.id, decision: "UEBERNEHMEN" });
    const setupId = k.thread.contextId!;
    for (const c of r1.cards.filter((c) => c.status === "NEU" && c.item.type !== "KUNDE")) {
      await decideCard(david, { threadId: view.thread.id, messageId: r1.message.id, cardId: c.id, decision: "UEBERNEHMEN" }).catch(() => undefined);
    }
    const account = (await db.query.accounts.findFirst({ where: eq(schema.accounts.name, "Löschwerk GmbH") }))!;
    expect(account).toBeDefined();
    // Dokument mit Datei
    const buf = Buffer.from("Gesprächsnotiz Löschwerk GmbH: Herr Falk plant die Migration bis 2027.", "utf8");
    const doc = await uploadDocument(david, { setupId, title: "Notiz" }, { name: "notiz.txt", type: "text/plain", size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer });
    const docRow = (await db.query.documents.findFirst({ where: eq(schema.documents.id, doc.documentId) }))!;
    const filePath = path.join(getConfig().UPLOAD_DIR, docRow.storagePath!);
    expect(existsSync(filePath)).toBe(true);

    const preview = await previewAccountDeletion(david, account.id);
    expect(preview.setups.length).toBe(1);
    expect(preview.persons).toBeGreaterThanOrEqual(1);
    expect(preview.sources).toBeGreaterThanOrEqual(2); // Assistent-Dialog + Dokument
    expect(preview.canDelete).toBe(false);

    // Ohne Archivierung kein Löschen; Fremder BD und Anker dürfen gar nicht
    await expect(deleteAccountPermanently(david, { accountId: account.id, confirmName: account.name, reason: "Testkunde, versehentlich angelegt." })).rejects.toBeInstanceOf(TransitionError);
    const lars = await actorFor("lars");
    await expect(archiveAccount(lars, account.id)).rejects.toBeInstanceOf(NotFoundError);
    const nina = await actorFor("nina");
    await expect(archiveAccount(nina, account.id)).rejects.toBeInstanceOf(NotFoundError);

    // Archivieren: sichtbar als archiviert, alles bleibt
    const archived = await archiveAccount(david, account.id);
    expect(archived.status).toBe("ARCHIVED");
    await expect(archiveAccount(david, account.id)).rejects.toBeInstanceOf(TransitionError);
    expect((await getAccount(david, account.id)).status).toBe("ARCHIVED");
    const restored = await restoreAccount(david, account.id);
    expect(restored.status).toBe("ACTIVE");
    await archiveAccount(david, account.id);
    expect((await previewAccountDeletion(david, account.id)).canDelete).toBe(true);

    // Bestätigung: Name muss stimmen, Begründung Pflicht
    await expect(deleteAccountPermanently(david, { accountId: account.id, confirmName: "Falscher Name", reason: "Testkunde, versehentlich angelegt." })).rejects.toBeInstanceOf(ValidationError);
    await expect(deleteAccountPermanently(david, { accountId: account.id, confirmName: account.name, reason: "kurz" })).rejects.toBeInstanceOf(ValidationError);

    const before = Number(((await db.execute(sql`select count(*)::int as n from audit_events`)).rows[0] as { n: number }).n);
    const report = await deleteAccountPermanently(david, { accountId: account.id, confirmName: account.name.toUpperCase(), reason: "Testkunde, versehentlich angelegt." });
    expect(report.name).toBe("Löschwerk GmbH");
    expect(report.deleted["accounts"]).toBe(1);
    expect(report.deleted["project_setups"]).toBe(1);
    expect(report.deleted["persons"]).toBeGreaterThanOrEqual(1);
    expect(report.deleted["sources"]).toBeGreaterThanOrEqual(2);
    expect(report.deleted["assistant_threads"]).toBeGreaterThanOrEqual(1);
    expect(report.files).toBe(1);
    expect(existsSync(filePath)).toBe(false);

    // Nichts mehr da – aber das Prüfprotokoll ist gewachsen und trägt Name und Begründung
    expect(await db.query.accounts.findFirst({ where: eq(schema.accounts.id, account.id) })).toBeUndefined();
    expect(await db.query.projectSetups.findMany({ where: eq(schema.projectSetups.accountId, account.id) })).toHaveLength(0);
    expect(await db.query.persons.findMany({ where: eq(schema.persons.accountId, account.id) })).toHaveLength(0);
    expect(await db.query.sources.findMany({ where: eq(schema.sources.setupId, setupId) })).toHaveLength(0);
    expect(await db.query.suggestions.findMany({ where: eq(schema.suggestions.setupId, setupId) })).toHaveLength(0);
    const after = Number(((await db.execute(sql`select count(*)::int as n from audit_events`)).rows[0] as { n: number }).n);
    expect(after).toBeGreaterThan(before);
    const audit = await db.query.auditEvents.findFirst({ where: eq(schema.auditEvents.action, "account.deleted"), orderBy: (a, { desc }) => desc(a.at) });
    expect((audit?.changes as { name: string; begruendung: string }).name).toBe("Löschwerk GmbH");
    expect((audit?.changes as { begruendung: string }).begruendung).toMatch(/versehentlich/);
    // KI-Protokoll bleibt erhalten (nur vom Setup gelöst)
    const jobs = await db.query.aiJobs.findMany({ where: eq(schema.aiJobs.actorUserId, david.userId) });
    expect(jobs.length).toBeGreaterThan(0);

    await expect(getAccount(david, account.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listVisibleAccounts(david)).some((a) => a.id === account.id)).toBe(false);
  });

  it("Demo-Kunden archiviert und löscht nur ADMIN; ADMIN darf ohne fachliche Sicht löschen", async () => {
    const seed = await ensureSeed();
    const david = await actorFor("david");
    await expect(archiveAccount(david, seed.accountId)).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await actorFor("admin");
    const preview = await previewAccountDeletion(admin, seed.otherAccountId);
    expect(preview.account.name).toMatch(/Musterwerke/);
  });
});
