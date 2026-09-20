import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/config";

/**
 * Dateiablage für Dokumente: UPLOAD_DIR/<workspaceId>/<documentId>.<ext>.
 * Der Name im Dateisystem ist nie der Originalname (keine Pfadtricks, keine Rückschlüsse); der Originalname
 * steht nur in der Datenbank. Der relative Pfad wird in documents.storage_path geführt.
 */

function baseDir(): string {
  return path.resolve(getConfig().UPLOAD_DIR);
}

function safeRelative(rel: string): string {
  const full = path.resolve(baseDir(), rel);
  if (!full.startsWith(baseDir() + path.sep)) throw new Error("Ungültiger Ablagepfad");
  return full;
}

export function relativePathFor(workspaceId: string, documentId: string, ext: string): string {
  return path.join(workspaceId.replace(/[^a-zA-Z0-9-]/g, ""), `${documentId.replace(/[^a-zA-Z0-9-]/g, "")}.${ext}`);
}

export async function storeFile(rel: string, data: Buffer): Promise<void> {
  const full = safeRelative(rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data, { flag: "wx", mode: 0o600 });
}

export async function readStoredFile(rel: string): Promise<Buffer> {
  return readFile(safeRelative(rel));
}

export async function deleteStoredFile(rel: string): Promise<void> {
  await rm(safeRelative(rel), { force: true });
}
