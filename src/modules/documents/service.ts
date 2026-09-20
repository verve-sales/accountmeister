import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Db, type Tx } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { canCreateAccount, canViewSource, loadSetupContext } from "@/modules/identity/authz";
import { requireEditableSetup } from "@/modules/setups/service";
import { canonicalMime, extensionOf, extractDocumentText, type ExtractResult } from "./extract";
import { deleteStoredFile, readStoredFile, relativePathFor, storeFile } from "./storage";

/**
 * Dokumente als Quellen (Etappe 6A). Eine hochgeladene Datei wird zu einer Quelle vom Typ DOKUMENT:
 * Der extrahierte Text ist die Originalquelle (Ebene 1), die Datei bleibt zum Nachlesen gespeichert.
 * Zugriff folgt den Zugriffsklassen der Quelle (16.2); „Inhalt entfernen“ löscht Text UND Datei.
 */

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export const uploadDocumentInput = z.object({
  /** Setup, dem das Dokument zugeordnet wird; leer = persönliches Dokument ohne Setup (z. B. Kundenanlage aus Dokument) */
  setupId: z.string().optional().or(z.literal("")),
  title: z.string().trim().max(200).optional().or(z.literal("")),
  accessClass: z.enum(schema.accessClassEnum.enumValues).default("SETUP"),
  sourceTime: z.string().optional().or(z.literal("")),
});

export type UploadedFile = { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> };

export type UploadResult = { sourceId: string; documentId: string; extract: ExtractResult; title: string };

export async function uploadDocument(actor: Actor, raw: unknown, file: UploadedFile | null): Promise<UploadResult> {
  const parsed = uploadDocumentInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  if (!file || file.size === 0) throw new ValidationError("Bitte eine Datei auswählen.");
  const cfg = getConfig();
  if (file.size > cfg.MAX_UPLOAD_MB * 1024 * 1024) throw new ValidationError(`Die Datei ist größer als ${cfg.MAX_UPLOAD_MB} MB.`);
  const ext = extensionOf(file.name);
  if (!ext) throw new ValidationError("Dateityp nicht unterstützt. Möglich sind PDF, Word (.docx), Excel (.xlsx), CSV, Text, Markdown, JSON und E-Mail (.eml).");

  let setupId: string | null = null;
  if (input.setupId) {
    await requireEditableSetup(actor, input.setupId);
    setupId = input.setupId;
  } else if (!canCreateAccount(actor)) {
    throw new ForbiddenError("Dokumente ohne Setup-Bezug können nur BD oder Principal hochladen (Kundenanlage).");
  }
  // Ohne Setup gibt es keinen Berechtigungskontext – deshalb immer persönlich, bis das Dokument einem Setup zugeordnet wird.
  const accessClass = setupId ? input.accessClass : "PERSOENLICH";

  const buf = Buffer.from(await file.arrayBuffer());
  const hash = sha(buf);
  const extract = await extractDocumentText(buf, ext);
  if (extract.status === "FEHLER") throw new ValidationError(extract.note ?? "Die Datei konnte nicht gelesen werden.");
  const title = input.title || file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 200) || "Dokument";

  const { sourceId, documentId, rel } = await db.transaction(async (tx) => {
    const [source] = await tx
      .insert(schema.sources)
      .values({
        workspaceId: actor.workspaceId,
        setupId,
        type: "DOKUMENT",
        title,
        body: extract.text || null,
        origin: `Upload ${file.name}`,
        sourceTime: input.sourceTime ? new Date(input.sourceTime) : new Date(),
        ownerUserId: actor.userId,
        accessClass,
      })
      .returning();
    if (!source) throw new Error("Quelle konnte nicht angelegt werden");
    await tx.insert(schema.sourceVersions).values({ sourceId: source.id, versionNo: 1, body: extract.text || null, contentHash: sha(extract.text) });
    const [doc] = await tx
      .insert(schema.documents)
      .values({
        workspaceId: actor.workspaceId,
        sourceId: source.id,
        fileName: file.name.slice(0, 255),
        mimeType: canonicalMime(ext),
        sizeBytes: file.size,
        sha256: hash,
        storagePath: null,
        extractStatus: extract.status,
        extractNote: extract.note,
        pageCount: extract.pageCount,
        uploadedBy: actor.userId,
      })
      .returning();
    if (!doc) throw new Error("Dokument konnte nicht angelegt werden");
    const rel = relativePathFor(actor.workspaceId, doc.id, ext);
    await tx.update(schema.documents).set({ storagePath: rel }).where(eq(schema.documents.id, doc.id));
    await recordAudit(tx, actor, "document.uploaded", "SOURCE", source.id, { setupId, accessClass, sizeBytes: file.size, extractStatus: extract.status });
    return { sourceId: source.id, documentId: doc.id, rel };
  });
  // Datei erst nach erfolgreicher Buchung ablegen; schlägt das fehl, wird die Buchung als „ohne Datei“ markiert.
  try {
    await storeFile(rel, buf);
  } catch (e) {
    await db.update(schema.documents).set({ storagePath: null, extractNote: `Datei konnte nicht abgelegt werden: ${e instanceof Error ? e.message.slice(0, 120) : "Fehler"}` }).where(eq(schema.documents.id, documentId));
  }
  return { sourceId, documentId, extract, title };
}

/** Datei zum Herunterladen – nur mit Leserecht auf die Quelle. */
export async function getDocumentFile(actor: Actor, documentId: string) {
  const doc = await db.query.documents.findFirst({ where: and(eq(schema.documents.id, documentId), eq(schema.documents.workspaceId, actor.workspaceId)) });
  if (!doc) throw new NotFoundError("Dokument");
  const source = await db.query.sources.findFirst({ where: eq(schema.sources.id, doc.sourceId) });
  if (!source) throw new NotFoundError("Dokument");
  const ctx = source.setupId ? await loadSetupContext(actor, source.setupId) : null;
  if (!canViewSource(actor, source, ctx)) throw new NotFoundError("Dokument");
  if (!doc.storagePath || doc.deletedAt) throw new NotFoundError("Die Datei wurde entfernt.");
  const data = await readStoredFile(doc.storagePath);
  await recordAudit(db, actor, "document.downloaded", "SOURCE", source.id);
  return { doc, data };
}

export async function getDocumentForSource(sourceId: string) {
  return db.query.documents.findFirst({ where: eq(schema.documents.sourceId, sourceId) });
}

export async function getDocumentsForSources(sourceIds: string[]) {
  if (sourceIds.length === 0) return [];
  return db.query.documents.findMany({ where: inArray(schema.documents.sourceId, sourceIds) });
}

/** Wird von „Inhalt entfernen“ (Governance) aufgerufen: Datei löschen, Metadaten behalten. */
export async function eraseDocumentFile(tx: Tx | Db, sourceId: string): Promise<boolean> {
  const doc = await tx.query.documents.findFirst({ where: eq(schema.documents.sourceId, sourceId) });
  if (!doc) return false;
  if (doc.storagePath) await deleteStoredFile(doc.storagePath);
  await tx.update(schema.documents).set({ storagePath: null, deletedAt: new Date(), extractNote: "Inhalt entfernt" }).where(eq(schema.documents.id, doc.id));
  return true;
}

/** Persönliche Dokumente ohne Setup des Akteurs (Kundenanlage aus Dokument), neueste zuerst. */
export async function listMyUnassignedDocuments(actor: Actor) {
  const rows = await db
    .select({ source: schema.sources, doc: schema.documents })
    .from(schema.sources)
    .innerJoin(schema.documents, eq(schema.documents.sourceId, schema.sources.id))
    .where(and(eq(schema.sources.workspaceId, actor.workspaceId), eq(schema.sources.ownerUserId, actor.userId), isNull(schema.sources.setupId), eq(schema.sources.type, "DOKUMENT")))
    .orderBy(desc(schema.sources.createdAt))
    .limit(20);
  return rows;
}

/** Ein setup-loses Dokument dem (neu angelegten) Setup zuordnen. */
export async function attachSourceToSetup(tx: Tx | Db, actor: Actor, sourceId: string, setupId: string, accessClass: (typeof schema.accessClassEnum.enumValues)[number]) {
  const source = await tx.query.sources.findFirst({ where: and(eq(schema.sources.id, sourceId), eq(schema.sources.workspaceId, actor.workspaceId)) });
  if (!source) throw new NotFoundError("Quelle");
  if (source.ownerUserId !== actor.userId) throw new ForbiddenError("Nur der Quelleninhaber ordnet die Quelle zu.");
  if (source.setupId) throw new ValidationError("Die Quelle ist bereits einem Setup zugeordnet.");
  await tx.update(schema.sources).set({ setupId, accessClass }).where(eq(schema.sources.id, sourceId));
  await recordAudit(tx, actor, "source.attached_to_setup", "SOURCE", sourceId, { setupId, accessClass });
}
