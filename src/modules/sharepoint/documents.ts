import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { todayIso } from "@/modules/work/calendar";
import { defaultSpClient, sharePointEnabled, type SpClient } from "./client";
import { docTypeOf, folderName, freelancerFolder, FREELANCER_SUB, KUNDE_SUB, LIB, libraryMap, statusOf } from "./service";

/**
 * Dokumentenfluss nach SharePoint (e48): hochgeladene Unterlagen, Kundenbestellungen aus Mails, Einsatzblätter für
 * die Buchhaltung und das Nachführen von Bestellnummer, Moco-Projekt und Laufzeit an allen Unterlagen eines Einsatzes.
 * Alles hier ist „best effort“: SharePoint aus → nichts passiert; ein Fehler wirft, der Aufrufer meldet ihn nur.
 */

type Deps = { client?: SpClient };
const NEW_FIELDS = ["Satz", "Zahlungsziel"];

async function clientOf(deps: Deps): Promise<SpClient | null> {
  if (deps.client) return deps.client;
  if (!sharePointEnabled()) return null;
  return defaultSpClient();
}

/** Spalten setzen; fehlen auf einer älteren Site die neuen Spalten oder Auswahlwerte, ohne sie erneut versuchen. */
export async function setFieldsSafe(client: SpClient, drive: string, item: string, fields: Record<string, string | null>) {
  try {
    await client.setFields(drive, item, fields);
  } catch {
    const base = Object.fromEntries(Object.entries(fields).filter(([k]) => !NEW_FIELDS.includes(k)));
    if (base.Dokumentart === "Einsatzblatt") base.Dokumentart = "Sonstiges";
    await client.setFields(drive, item, base);
  }
}

async function driveFor(client: SpClient, lib: string) {
  const libs = await libraryMap(client);
  const listId = libs.get(lib);
  if (!listId) throw new Error(`In SharePoint fehlt die Bibliothek „${lib}“ – bitte unter Verwaltung › SharePoint einrichten.`);
  return client.driveOf(listId);
}

/** Zielordner einer Unterlage nach Seite und Typ. */
export function folderFor(d: { side: string; docType: string }, accountName: string, freelancerName: string | null): { lib: string; path: string[] } {
  if (d.side === "FREELANCER" && freelancerName) return { lib: LIB.FREELANCER, path: [freelancerFolder(freelancerName), d.docType === "SONSTIGES" ? FREELANCER_SUB[1] : FREELANCER_SUB[0]] };
  const sub = ["BESTELLUNG", "EINZELBEAUFTRAGUNG", "NACHTRAG", "KUENDIGUNG"].includes(d.docType) ? KUNDE_SUB[2] : KUNDE_SUB[0];
  return { lib: LIB.KUNDEN, path: [folderName(accountName), sub] };
}

const datePrefix = (name: string) => (/^\d{4}-\d{2}-\d{2}_/.test(name) ? name : `${todayIso()}_${name}`);

/** Eine hochgeladene Unterlage in den passenden Ordner legen und am Dokument verknüpfen. */
export async function fileDocument(documentId: string, fileName: string, bytes: ArrayBuffer, deps: Deps = {}): Promise<{ webUrl: string } | null> {
  const client = await clientOf(deps);
  if (!client) return null;
  const d = await db.query.contractDocuments.findFirst({ where: eq(schema.contractDocuments.id, documentId) });
  if (!d) return null;
  const [acc, fl, link] = await Promise.all([
    db.query.accounts.findFirst({ where: eq(schema.accounts.id, d.accountId), columns: { name: true } }),
    d.freelancerId ? db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, d.freelancerId), columns: { displayName: true } }) : Promise.resolve(null),
    db.query.engagementDocuments.findFirst({ where: eq(schema.engagementDocuments.documentId, d.id) }),
  ]);
  const eng = link ? await db.query.engagements.findFirst({ where: eq(schema.engagements.id, link.engagementId), columns: { mocoProjectId: true, orderReference: true } }) : null;
  const target = folderFor(d, acc?.name ?? "Ohne Kunde", fl?.displayName ?? null);
  const drive = await driveFor(client, target.lib);
  const item = await client.upload(drive, target.path, datePrefix(fileName), bytes);
  await setFieldsSafe(client, drive, item.id, {
    Dokumentart: docTypeOf[d.docType] ?? "Sonstiges",
    Kunde: acc?.name ?? null,
    Person: fl?.displayName.replace(/\s*\(.*?\)\s*/g, " ").trim() ?? null,
    Bestellnummer: d.reference ?? eng?.orderReference ?? null,
    MocoProjekt: eng?.mocoProjectId ? String(eng.mocoProjectId) : null,
    GueltigVon: d.validFrom,
    GueltigBis: d.validTo,
    DokStatus: statusOf[d.signedStatus] ?? "Entwurf",
  });
  await db.update(schema.contractDocuments).set({ link: item.webUrl, spDriveId: drive, spItemId: item.id, updatedAt: new Date() }).where(eq(schema.contractDocuments.id, d.id));
  return { webUrl: item.webUrl };
}

/** Alte Fassung in SharePoint als „ersetzt“ markieren (z. B. Entwurf, wenn die unterschriebene Fassung da ist). */
export async function markReplaced(drive: string, itemId: string, deps: Deps = {}) {
  const client = await clientOf(deps);
  if (!client) return;
  await client.setFields(drive, itemId, { DokStatus: "ersetzt" });
}

/** Bestellnummer aus Betreff/Text/Dateiname – nur, wenn eindeutig erkennbar. */
export function extractOrderNumber(...texts: string[]): string | null {
  const t = texts.join("\n");
  const m = /(?:Bestell(?:ung|nummer|-?nr\.?)|PO[- ]?(?:Nr\.?|Number|No\.?)|Purchase Order)\s*[:#.]?\s*(?:Nr\.?\s*)?([A-Z0-9][A-Z0-9\-/]{3,24})/i.exec(t);
  if (m && /\d/.test(m[1]!)) return m[1]!;
  const sap = /\b(4[0-9]{9})\b/.exec(t);
  return sap ? sap[1]! : null;
}

/** Sieht die Mail bzw. Datei nach einer Kundenbestellung aus? */
export function looksLikeOrder(subject: string, body: string, fileName: string): boolean {
  return /bestellung|bestellnummer|purchase order|\bPO\b|auftragsbest|beauftragung|abruf/i.test(`${subject}\n${fileName}\n${body.slice(0, 2000)}`);
}

/** Kundenbestellung (Mail-Anhang) nach Kunden › Kunde › Bestellungen legen. */
export async function fileCustomerOrder(input: { accountName: string; fileName: string; bytes: ArrayBuffer; reference: string | null }, deps: Deps = {}): Promise<{ webUrl: string; driveId: string; itemId: string } | null> {
  const client = await clientOf(deps);
  if (!client) return null;
  const drive = await driveFor(client, LIB.KUNDEN);
  const item = await client.upload(drive, [folderName(input.accountName), KUNDE_SUB[2]], datePrefix(input.fileName.replace(/[\\/:*?"<>|]/g, "-")), input.bytes);
  await setFieldsSafe(client, drive, item.id, { Dokumentart: "Bestellung", Kunde: input.accountName, Bestellnummer: input.reference, DokStatus: "unterschrieben" });
  return { webUrl: item.webUrl, driveId: drive, itemId: item.id };
}

/**
 * Bestellnummer, Moco-Projekt und ggf. Laufzeit an allen in SharePoint liegenden Unterlagen eines Einsatzes nachführen –
 * damit die Ansichten der Buchhaltung nicht leer bleiben.
 */
export async function syncEngagementDocs(engagementId: string, extra: { validTo?: string | null } = {}, deps: Deps = {}): Promise<number> {
  const client = await clientOf(deps);
  if (!client) return 0;
  const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, engagementId) });
  if (!e) return 0;
  const links = await db.query.engagementDocuments.findMany({ where: eq(schema.engagementDocuments.engagementId, e.id) });
  const docs = links.length ? (await db.query.contractDocuments.findMany({ where: inArray(schema.contractDocuments.id, links.map((l) => l.documentId)) })).filter((d) => d.spDriveId && d.spItemId) : [];
  let n = 0;
  for (const d of docs) {
    const fields: Record<string, string | null> = { MocoProjekt: e.mocoProjectId ? String(e.mocoProjectId) : null };
    if (d.side === "KUNDE" || d.docType === "EINZELBEAUFTRAGUNG") fields.Bestellnummer = d.reference ?? e.orderReference ?? null;
    if (extra.validTo !== undefined && d.signedStatus !== "GEKUENDIGT") fields.GueltigBis = extra.validTo;
    await setFieldsSafe(client, d.spDriveId!, d.spItemId!, fields);
    n++;
  }
  return n;
}

const money = (v: string | null | undefined, unit: string | null | undefined) => (v ? `${new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2 }).format(Number(v))} € je ${unit === "STUNDE" ? "Stunde" : "Tag"}` : "–");
const de = (iso: string | null | undefined) => (iso ? iso.split("-").reverse().join(".") : "–");

async function sheet(title: string, rows: [string, string][]): Promise<ArrayBuffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Accountmeister";
  const ws = wb.addWorksheet("Einsatzblatt");
  ws.columns = [{ width: 28 }, { width: 70 }];
  ws.addRow([title]).font = { bold: true, size: 13 };
  ws.addRow([]);
  for (const [k, v] of rows) {
    const r = ws.addRow([k, v]);
    r.getCell(1).font = { bold: true };
    r.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
  ws.addRow([]);
  ws.addRow([`Erzeugt vom Accountmeister am ${de(todayIso())}. Führend sind Moco und die Unterlagen im selben Ordner.`]).font = { italic: true, size: 9 };
  const buf = await wb.xlsx.writeBuffer();
  return (buf as unknown as Uint8Array).buffer.slice(0) as ArrayBuffer;
}

/**
 * Einsatzblatt für Backoffice und Buchhaltung (e48), beim Quittieren einer Übergabe:
 *  - Kunden › Kunde › Bestellungen: Bestellnummer, Moco-Projekt, Person, Laufzeit, Verkaufssatz, Rechnungsanschrift und -weg.
 *  - Freelancer › Person › Verträge (nur bei Freelancern): Einkaufssatz, Zahlungsziel, Rechnungsdaten.
 * Einkaufssätze stehen damit nie im Kundenordner.
 */
export async function writeEinsatzblatt(engagementId: string, p: { kunde: string; person: string; personArt: string; rolle: string; beginn: string | null; ende: string | null; bestellnummer: string | null; vk: string | null; vkEinheit: string | null; kontingent: string | null; rechnungsanschrift?: string | null; rechnungsweg?: string | null; rechnungshinweis: string | null; ek: string | null; ekEinheit: string | null; zahlungszielTage?: number | null; freelancerRechnungsdaten: string | null }, mocoProjectId: number | null, deps: Deps = {}): Promise<{ kunde: string | null; freelancer: string | null }> {
  const client = await clientOf(deps);
  if (!client) return { kunde: null, freelancer: null };
  const last = p.person.replace(/\(.*?\)/g, "").trim().split(/\s+/).pop() ?? "Person";
  const base = `${todayIso()}_Einsatzblatt_${folderName(p.kunde).replace(/\s+/g, "-")}_${last}`;
  const common: [string, string][] = [
    ["Kunde", p.kunde],
    ["Person", `${p.person}${p.personArt === "INTERN" ? " (intern)" : " (Freelancer)"}`],
    ["Rolle", p.rolle],
    ["Laufzeit", `${de(p.beginn)} – ${de(p.ende)}`],
    ["Kontingent", p.kontingent ?? "–"],
    ["Bestellnummer", p.bestellnummer ?? "fehlt noch"],
    ["Moco-Projekt", mocoProjectId ? String(mocoProjectId) : "–"],
  ];
  const kdrive = await driveFor(client, LIB.KUNDEN);
  const kItem = await client.upload(kdrive, [folderName(p.kunde), KUNDE_SUB[2]], `${base}.xlsx`, await sheet(`Einsatzblatt ${p.person} bei ${p.kunde}`, [...common, ["Verkaufssatz", money(p.vk, p.vkEinheit)], ["Rechnungsanschrift", p.rechnungsanschrift ?? "fehlt – am Kunden im Accountmeister eintragen"], ["Rechnungsweg", p.rechnungsweg ?? "–"], ["Hinweis zur Rechnung", p.rechnungshinweis ?? "–"]]));
  await setFieldsSafe(client, kdrive, kItem.id, { Dokumentart: "Einsatzblatt", Kunde: p.kunde, Person: p.person, Bestellnummer: p.bestellnummer, MocoProjekt: mocoProjectId ? String(mocoProjectId) : null, GueltigVon: p.beginn, GueltigBis: p.ende, Satz: money(p.vk, p.vkEinheit), DokStatus: "unterschrieben" });
  let fUrl: string | null = null;
  if (p.personArt === "FREELANCER") {
    const fdrive = await driveFor(client, LIB.FREELANCER);
    const fItem = await client.upload(fdrive, [freelancerFolder(p.person), FREELANCER_SUB[0]], `${base}_Einkauf.xlsx`, await sheet(`Einsatzblatt Einkauf ${p.person}`, [...common, ["Einkaufssatz", money(p.ek, p.ekEinheit)], ["Zahlungsziel", p.zahlungszielTage ? `${p.zahlungszielTage} Tage` : "–"], ["Rechnungsdaten Freelancer", p.freelancerRechnungsdaten ?? "–"]]));
    await setFieldsSafe(client, fdrive, fItem.id, { Dokumentart: "Einsatzblatt", Kunde: p.kunde, Person: p.person, Bestellnummer: p.bestellnummer, MocoProjekt: mocoProjectId ? String(mocoProjectId) : null, GueltigVon: p.beginn, GueltigBis: p.ende, Satz: money(p.ek, p.ekEinheit), Zahlungsziel: p.zahlungszielTage ? `${p.zahlungszielTage} Tage` : null, DokStatus: "unterschrieben" });
    fUrl = fItem.webUrl;
  }
  return { kunde: kItem.webUrl, freelancer: fUrl };
}
