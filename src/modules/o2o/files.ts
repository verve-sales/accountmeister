import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { readStoredFile } from "@/modules/documents/storage";
import type { SpClient } from "@/modules/sharepoint/client";
import { todayIso } from "@/modules/work/calendar";

/**
 * SharePoint-Ablage des Auftragseingangs (e74, Konzept „Ablage nur über die App“):
 * - Dateiname <Datum>_<Dokumentart>_<Nummer>_<Nachname>.<Endung>, z. B. 2026-11-27_Bestellung_4711_Dalipi.pdf
 * - Ordner beim Kunden; beim Vermittler ohne bekannten Endkunden beim Vermittler (Wartebereich), Spalte „Endkunde“
 * - wird der Endkunde bekannt, zieht die Datei in dessen Ordner (Links laufen über die Dateikennung, R4)
 * - fehlgeschlagene Ablagen werden wiederholt (Schaltfläche am Vorgang, täglicher Abgleich)
 */
export type SpState = { state: "ABGELEGT" | "FEHLER" | "AUS"; note: string | null; link: string | null };

const clean = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

/** Dateiname nach Konzept; ohne Nummer die Vorgangsnummer, ohne Person nichts. */
export function caseFileName(p: { kind: string; number: string | null; caseNumber: string; personName: string | null; originalName: string; date?: string }): string {
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(p.originalName)?.[1] ?? "pdf").toLowerCase();
  const kind = p.kind === "BESTELLUNG" ? "Bestellung" : p.kind === "ANGEBOT" ? "Angebot" : "Dokument";
  const last = p.personName ? p.personName.replace(/\(.*?\)/g, " ").trim().split(/[\s,]+/).filter(Boolean) : [];
  const lastName = p.personName?.includes(",") ? last[0] : last.at(-1);
  return [p.date ?? todayIso(), kind, clean(p.number || p.caseNumber), lastName ? clean(lastName) : null].filter(Boolean).join("_") + `.${ext}`;
}

async function clientOf(client?: SpClient | null): Promise<SpClient | null> {
  if (client !== undefined) return client;
  const { sharePointEnabled, defaultSpClient } = await import("@/modules/sharepoint/client");
  return sharePointEnabled() ? defaultSpClient() : null;
}

/** Alle noch nicht abgelegten Unterlagen eines Vorgangs ablegen und den Stand am Vorgang speichern. */
export async function fileCaseDocuments(caseId: string, deps: { client?: SpClient | null } = {}): Promise<SpState> {
  const c = await db.query.orderCases.findFirst({ where: eq(schema.orderCases.id, caseId) });
  if (!c) return { state: "FEHLER", note: "Vorgang nicht gefunden.", link: null };
  const client = await clientOf(deps.client);
  const prev = ((c.systems ?? {}) as { sharepoint?: SpState }).sharepoint;
  if (!client) return prev ?? { state: "AUS", note: "SharePoint ist nicht eingerichtet.", link: null };
  const links = await db.query.orderCaseDocuments.findMany({ where: eq(schema.orderCaseDocuments.caseId, c.id) });
  const docs = links.length ? await db.query.contractDocuments.findMany({ where: inArray(schema.contractDocuments.id, links.map((l) => l.documentId)) }) : [];
  const accIds = [c.partnerAccountId, c.endCustomerAccountId].filter((x): x is string => !!x);
  const accs = accIds.length ? await db.query.accounts.findMany({ where: inArray(schema.accounts.id, accIds), columns: { id: true, name: true } }) : [];
  const endName = accs.find((a) => a.id === c.endCustomerAccountId)?.name ?? c.endCustomerHint ?? null;
  const { fileDocument } = await import("@/modules/sharepoint/documents");
  let state: SpState = prev?.state === "ABGELEGT" ? prev : { state: "AUS", note: "Keine Datei zum Ablegen (Angebot ohne Dokument).", link: null };
  for (const d of docs) {
    if (d.spItemId) { state = { state: "ABGELEGT", note: null, link: d.link ?? state.link }; continue; }
    // Sammelbestellung: dieselbe Datei gehört zu mehreren Vorgängen – nur einmal ablegen, Verweis teilen
    if (d.sourceId) {
      const twin = await db.query.contractDocuments.findFirst({ where: and(eq(schema.contractDocuments.sourceId, d.sourceId), isNotNull(schema.contractDocuments.spItemId)) });
      if (twin?.spItemId) {
        await db.update(schema.contractDocuments).set({ link: twin.link, spDriveId: twin.spDriveId, spItemId: twin.spItemId, updatedAt: new Date() }).where(eq(schema.contractDocuments.id, d.id));
        state = { state: "ABGELEGT", note: null, link: twin.link };
        continue;
      }
    }
    try {
      const file = d.sourceId ? await db.query.documents.findFirst({ where: eq(schema.documents.sourceId, d.sourceId) }) : null;
      if (!file?.storagePath) continue;
      const bytes = await readStoredFile(file.storagePath);
      const kind = links.find((l) => l.documentId === d.id)?.kind ?? d.docType;
      const name = caseFileName({ kind, number: kind === "BESTELLUNG" ? c.orderNumber : c.offerNumber ?? c.brokerRef, caseNumber: c.number, personName: c.personName, originalName: file.fileName });
      const r = await fileDocument(d.id, file.fileName, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { client }, { name, fields: { Endkunde: c.channel === "VERMITTLER" ? endName : null, Vorgang: c.number, ...(c.offerNumber ? { Angebotsnummer: c.offerNumber } : {}) } });
      if (r) state = { state: "ABGELEGT", note: null, link: r.webUrl };
    } catch (err) {
      state = { state: "FEHLER", note: (err as Error).message.slice(0, 200), link: null };
      break;
    }
  }
  await db.update(schema.orderCases).set({ systems: { ...((c.systems ?? {}) as Record<string, unknown>), sharepoint: state }, updatedAt: new Date() }).where(eq(schema.orderCases.id, c.id));
  return state;
}

/** Endkunde bekannt: abgelegte Dateien aus dem Wartebereich beim Vermittler in den Ordner des Endkunden ziehen. */
export async function moveCaseDocumentsToEndCustomer(caseId: string, deps: { client?: SpClient | null } = {}): Promise<number> {
  const c = await db.query.orderCases.findFirst({ where: eq(schema.orderCases.id, caseId) });
  if (!c?.endCustomerAccountId) return 0;
  const client = await clientOf(deps.client);
  if (!client) return 0;
  const acc = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, c.endCustomerAccountId), columns: { name: true } });
  if (!acc) return 0;
  const links = await db.query.orderCaseDocuments.findMany({ where: eq(schema.orderCaseDocuments.caseId, c.id) });
  const docs = links.length ? await db.query.contractDocuments.findMany({ where: inArray(schema.contractDocuments.id, links.map((l) => l.documentId)) }) : [];
  const { folderFor, setFieldsSafe } = await import("@/modules/sharepoint/documents");
  const { yearFolder } = await import("@/modules/sharepoint/service");
  let n = 0;
  for (const d of docs) {
    if (!d.spItemId || !d.spDriveId) continue;
    const item = await client.item(d.spDriveId, d.spItemId);
    const target = folderFor(d, acc.name, null);
    const moved = await client.move(d.spDriveId, d.spItemId, yearFolder(target.path, item.name));
    await setFieldsSafe(client, d.spDriveId, moved.id, { Kunde: acc.name, Endkunde: acc.name });
    await db.update(schema.contractDocuments).set({ link: moved.webUrl, spItemId: moved.id, updatedAt: new Date() }).where(eq(schema.contractDocuments.id, d.id));
    n++;
  }
  return n;
}
