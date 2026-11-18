import { desc, eq } from "drizzle-orm";
import JSZip from "jszip";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { todayIso } from "@/modules/work/calendar";
import { defaultSpClient, sharePointEnabled, type SpClient } from "./client";
import { setFieldsSafe } from "./documents";
import { folderName, KUNDE_SUB, LIB, libraryMap, PICK_KINDS, yearFolder, type PickKind } from "./service";

/**
 * Angebot erzeugen (e49b): Grundlage ist das letzte Angebot (oder eine Vorlage) als Excel-Datei aus SharePoint.
 * Geändert werden nur die Zellen, die sich je Angebot ändern – Nummer, Datum, Zeitraum, Personentage, Tagessatz;
 * Layout, Formeln, Auswahllisten und alle übrigen Angaben bleiben unangetastet. Die neue Datei landet unter
 * Kunden › Kunde › Angebote › Jahr und hängt als Unterlage „Angebot“ am Einsatz.
 * Unterstützt wird das Angebotsformular der ERGO-Gruppe (Blatt „Offer overview“).
 */

export const ERGO_SHEET = "Offer overview";
export const ERGO_CELLS = { requestDate: "I9", offerDate: "O9", offerNumber: "S9", personDays: "Q28", rate: "U28", rateDiscounted: "X28", from: "M54", until: "Q54" } as const;

type CellValue = { n: number } | { s: string } | { empty: true };
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Excel-Datum (Tage seit 30.12.1899). */
export const excelDate = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);

async function sheetPath(zip: JSZip, sheetName: string): Promise<string> {
  const wb = await zip.file("xl/workbook.xml")!.async("string");
  const m = new RegExp(`<sheet [^>]*name="${sheetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*r:id="([^"]+)"`).exec(wb);
  if (!m) throw new ValidationError(`Dieses Angebotsformat kenne ich noch nicht (Blatt „${sheetName}“ fehlt). Bitte ein Angebot im ERGO-Formular als Grundlage wählen.`);
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const r = new RegExp(`<Relationship [^>]*Id="${m[1]}"[^>]*Target="([^"]+)"|<Relationship [^>]*Target="([^"]+)"[^>]*Id="${m[1]}"`).exec(rels);
  const target = r?.[1] ?? r?.[2];
  if (!target) throw new ValidationError("Die Excel-Datei ist beschädigt (Blattverweis fehlt).");
  return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
}

const cellRe = (ref: string) => new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);

/** Zahlwert einer Zelle (null, wenn leer oder Text). */
export async function readNumber(bytes: ArrayBuffer, sheetName: string, ref: string): Promise<number | null> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file(await sheetPath(zip, sheetName))!.async("string");
  const m = cellRe(ref).exec(xml);
  if (!m || / t="/.test(m[1] ?? "")) return null;
  const v = /<v>([^<]*)<\/v>/.exec(m[2] ?? "");
  return v && v[1] !== "" && Number.isFinite(Number(v[1])) ? Number(v[1]) : null;
}

/** Zellen eines Blatts setzen; die Zellen müssen in der Datei vorhanden sein (Formatierung bleibt). Formeln rechnet Excel beim Öffnen neu. */
export async function patchCells(bytes: ArrayBuffer, sheetName: string, patches: Record<string, CellValue>): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(bytes);
  const path = await sheetPath(zip, sheetName);
  let xml = await zip.file(path)!.async("string");
  for (const [ref, val] of Object.entries(patches)) {
    const re = cellRe(ref);
    const m = re.exec(xml);
    if (!m) throw new ValidationError(`Zelle ${ref} fehlt in der Grundlage – bitte ein vollständiges Angebot als Grundlage wählen.`);
    const style = /\ss="\d+"/.exec(m[1] ?? "")?.[0] ?? "";
    const cell = "empty" in val ? `<c r="${ref}"${style}/>` : "n" in val ? `<c r="${ref}"${style}><v>${val.n}</v></c>` : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val.s)}</t></is></c>`;
    xml = xml.replace(re, () => cell);
  }
  zip.file(path, xml);
  // gespeicherte Formelergebnisse entfernen: sonst zeigt eine Vorschau ohne Neuberechnung die alten Summen
  for (const name of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))) {
    const src = name === path ? xml : await zip.file(name)!.async("string");
    zip.file(name, src.replace(/(<c [^>]*>)(<f[^>]*(?:\/>|>[\s\S]*?<\/f>))<v>[^<]*<\/v>/g, "$1$2"));
  }
  // gespeicherte Formelergebnisse sind jetzt veraltet → Excel rechnet beim Öffnen alles neu
  let wb = await zip.file("xl/workbook.xml")!.async("string");
  wb = /<calcPr[^>]*\/>/.test(wb) ? wb.replace(/<calcPr([^>]*?)\/>/, (_a, attrs: string) => `<calcPr${attrs.replace(/\sfullCalcOnLoad="[^"]*"/, "")} fullCalcOnLoad="1"/>`) : wb.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>');
  zip.file("xl/workbook.xml", wb);
  if (zip.file("xl/calcChain.xml")) {
    zip.remove("xl/calcChain.xml");
    const relsPath = "xl/_rels/workbook.xml.rels";
    zip.file(relsPath, (await zip.file(relsPath)!.async("string")).replace(/<Relationship [^>]*calcChain[^>]*\/>/, ""));
    const ct = "[Content_Types].xml";
    zip.file(ct, (await zip.file(ct)!.async("string")).replace(/<Override [^>]*calcChain[^>]*\/>/, ""));
  }
  const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum fehlt");
const amount = z.string().trim().transform((v) => v.replace(/\s|€/g, "").replace(",", ".")).refine((v) => v === "" || /^\d{1,7}(\.\d{1,2})?$/.test(v), "Betrag bitte als Zahl, z. B. 968,64").optional().default("");
export const offerInput = z.object({
  /** Grundlage: Datei aus SharePoint (Auswahl „Laufwerk|Datei|Ordnerart“) – letztes Angebot oder Vorlage */
  basePick: z.string().min(3, "Bitte die Grundlage wählen (letztes Angebot oder Vorlage)."),
  offerNumber: z.string().trim().min(3, "Bitte die Angebotsnummer aus Moco eintragen.").max(100),
  offerDate: iso.optional().or(z.literal("")),
  from: iso,
  until: iso,
  /** leer = wie in der Grundlage */
  personDays: z.string().trim().regex(/^\d{0,4}$/, "Personentage als ganze Zahl").optional().default(""),
  dailyRate: amount,
});

export type OfferResult = { fileName: string; webUrl: string; documentId: string; personDays: number | null; dailyRate: number | null };

export async function generateOffer(actor: Actor, engagementId: string, raw: unknown, deps: { client?: SpClient } = {}): Promise<OfferResult> {
  const p = offerInput.safeParse(raw);
  if (!p.success) throw new ValidationError(p.error.issues.map((i) => i.message).join("; "));
  const i = p.data;
  if (i.until < i.from) throw new ValidationError("„bis“ liegt vor „von“.");
  if (!deps.client && !sharePointEnabled()) throw new ValidationError("Angebote entstehen in SharePoint – die SharePoint-Ablage ist nicht eingeschaltet.");
  const { requireEngagement } = await import("@/modules/engagements/authz");
  const a = await requireEngagement(actor, engagementId);
  if (!(a.manage || a.care)) throw new ForbiddenError();
  const e = a.engagement;
  const [drive, itemId, kind] = i.basePick.split("|");
  if (!drive || !itemId || !(kind === "VORLAGE" || (kind && kind in PICK_KINDS))) throw new ValidationError("Bitte die Grundlage aus der Liste wählen.");
  const client = deps.client ?? (await defaultSpClient());
  const base = await client.item(drive, itemId);
  if (base.folder || !/\.xlsx$/i.test(base.name)) throw new ValidationError("Die Grundlage muss eine Excel-Datei (.xlsx) sein.");
  const bytes = await client.download(drive, itemId);
  const offerDate = i.offerDate || todayIso();
  const patches: Record<string, CellValue> = {
    [ERGO_CELLS.requestDate]: { n: excelDate(offerDate) },
    [ERGO_CELLS.offerDate]: { n: excelDate(offerDate) },
    [ERGO_CELLS.offerNumber]: { s: i.offerNumber },
    [ERGO_CELLS.from]: { n: excelDate(i.from) },
    [ERGO_CELLS.until]: { n: excelDate(i.until) },
  };
  if (i.personDays) patches[ERGO_CELLS.personDays] = { n: Number(i.personDays) };
  if (i.dailyRate) {
    // Das Formular kennt den Satz laut Vertrag (U28) und den rabattierten Satz (X28): gesetzt wird, was in der Grundlage gefüllt ist
    const [u, x] = await Promise.all([readNumber(bytes, ERGO_SHEET, ERGO_CELLS.rate), readNumber(bytes, ERGO_SHEET, ERGO_CELLS.rateDiscounted)]);
    if (x !== null) patches[ERGO_CELLS.rateDiscounted] = { n: Number(i.dailyRate) };
    if (u !== null || x === null) patches[ERGO_CELLS.rate] = { n: Number(i.dailyRate) };
  }
  const out = await patchCells(bytes, ERGO_SHEET, patches);
  const [fl, internal] = await Promise.all([
    e.freelancerId ? db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, e.freelancerId), columns: { displayName: true } }) : Promise.resolve(null),
    e.internalUserId ? db.query.users.findFirst({ where: eq(schema.users.id, e.internalUserId), columns: { displayName: true } }) : Promise.resolve(null),
  ]);
  const person = (fl?.displayName ?? internal?.displayName ?? "Person").replace(/\(.*?\)/g, "").trim();
  const fileSafe = (s: string) => s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  // Nachname wie in der Grundlage, wenn sie zur selben Person gehört (z. B. „Hueper“), sonst aus dem Namen
  const fromBase = /_Angebot_[^_]+_([^_]+)_/.exec(base.name)?.[1] ?? "";
  const surname = fromBase && fileSafe(person).toLowerCase().includes(fromBase.toLowerCase()) ? fromBase : fileSafe(person.split(/\s+/).pop() ?? "Person");
  const short = /_Angebot_([^_]+)_/.exec(base.name)?.[1] ?? fileSafe(a.account.name.split(/\s+/)[0] ?? "Kunde");
  const fileName = `${offerDate}_Angebot_${short}_${surname}_${i.offerNumber.replace(/[^A-Za-z0-9_-]+/g, "-")}.xlsx`;
  const libs = await libraryMap(client);
  const kdrive = await client.driveOf(libs.get(LIB.KUNDEN)!);
  const item = await client.upload(kdrive, yearFolder([folderName(a.account.name), KUNDE_SUB[1]], fileName), fileName, out);
  await setFieldsSafe(client, kdrive, item.id, { Dokumentart: "Angebot", Kunde: a.account.name, Person: person, Angebotsnummer: i.offerNumber, GueltigVon: i.from, GueltigBis: i.until, DokStatus: "Entwurf" });
  const { addContractDocument } = await import("@/modules/engagements/service");
  const { document } = await addContractDocument(actor, engagementId, { side: "KUNDE", docType: "ANGEBOT", title: `Angebot ${i.offerNumber} – ${person}`.slice(0, 200), reference: i.offerNumber, validFrom: i.from, validTo: i.until, signedStatus: "ENTWURF", link: item.webUrl }, null);
  await db.update(schema.contractDocuments).set({ spDriveId: kdrive, spItemId: item.id }).where(eq(schema.contractDocuments.id, document.id));
  // An der Verlängerung vermerken: offene zuerst, sonst die jüngste zum selben Zeitraum.
  // e49f: Gibt es noch keine und reicht das Angebot über das heutige Ende hinaus, entsteht die Verlängerung hier –
  // so zeigt die Übersicht „Verlängerung läuft“, egal ob man über „Verlängern“ oder „Angebot erzeugen“ kommt.
  const rens = await db.query.renewalDecisions.findMany({ where: eq(schema.renewalDecisions.engagementId, engagementId), orderBy: desc(schema.renewalDecisions.createdAt) });
  const open = rens.find((r) => ["ZU_KLAEREN", "IN_ABSTIMMUNG", "ANGEBOTEN"].includes(r.status)) ?? null;
  const confirmed = rens.find((r) => r.status === "BESTAETIGT" && r.proposedTo === i.until) ?? null;
  const extends_ = !!e.plannedEnd && i.until > e.plannedEnd;
  const rateNote = i.dailyRate ? `Angebot ${i.offerNumber}: Tagessatz ${i.dailyRate.replace(".", ",")} €` : `Angebot ${i.offerNumber}`;
  if (open) {
    await db.update(schema.renewalDecisions).set({ offerNumber: i.offerNumber, offerLink: item.webUrl, status: "ANGEBOTEN", ...(extends_ && !open.proposedTo ? { proposedFrom: i.from, proposedTo: i.until, conditionsNote: open.conditionsNote ?? rateNote } : {}), version: open.version + 1, updatedAt: new Date() }).where(eq(schema.renewalDecisions.id, open.id));
  } else if (confirmed) {
    await db.update(schema.renewalDecisions).set({ offerNumber: i.offerNumber, offerLink: item.webUrl, updatedAt: new Date() }).where(eq(schema.renewalDecisions.id, confirmed.id));
  } else if (extends_ && ["AKTIV", "PAUSIERT", "GEPLANT", "ENDET"].includes(e.status)) {
    await db.insert(schema.renewalDecisions).values({ workspaceId: actor.workspaceId, engagementId, status: "ANGEBOTEN", triggerDate: todayIso(), proposedFrom: i.from, proposedTo: i.until, conditionsNote: rateNote, offerNumber: i.offerNumber, offerLink: item.webUrl, commercialOwnerUserId: e.bdUserId, createdBy: actor.userId });
  }
  await recordAudit(db, actor, "offer.generated", "ENGAGEMENT", engagementId, { angebotsnummer: i.offerNumber, grundlage: base.name, datei: fileName });
  return { fileName, webUrl: item.webUrl, documentId: document.id, personDays: i.personDays ? Number(i.personDays) : await readNumber(bytes, ERGO_SHEET, ERGO_CELLS.personDays), dailyRate: i.dailyRate ? Number(i.dailyRate) : null };
}

/**
 * Angebot zur Verlängerung (e49c): eine Verlängerung – erst recht zu neuen Konditionen – ist ein neues Angebot mit
 * eigener Nummer. Grundlage ist das letzte Angebot der Person (sonst die Vorlage); Zeitraum aus der Verlängerung,
 * Tagessatz aus dem neuen bzw. geltenden VK (Stundensatz × 8).
 */
export async function offerForRenewal(actor: Actor, engagementId: string, input: { offerNumber: string; vk?: string; personDays?: string }, deps: { client?: SpClient } = {}): Promise<OfferResult> {
  const e = await db.query.engagements.findFirst({ where: eq(schema.engagements.id, engagementId) });
  if (!e) throw new ValidationError("Einsatz nicht gefunden.");
  const [acc, fl, internal, ren, periods] = await Promise.all([
    db.query.accounts.findFirst({ where: eq(schema.accounts.id, e.accountId), columns: { name: true } }),
    e.freelancerId ? db.query.freelancers.findFirst({ where: eq(schema.freelancers.id, e.freelancerId), columns: { displayName: true } }) : Promise.resolve(null),
    e.internalUserId ? db.query.users.findFirst({ where: eq(schema.users.id, e.internalUserId), columns: { displayName: true } }) : Promise.resolve(null),
    db.query.renewalDecisions.findFirst({ where: eq(schema.renewalDecisions.engagementId, engagementId), orderBy: desc(schema.renewalDecisions.createdAt) }),
    db.query.engagementPeriods.findMany({ where: eq(schema.engagementPeriods.engagementId, engagementId) }),
  ]);
  if (!ren?.proposedTo) throw new ValidationError("Für das Angebot fehlt das neue Ende der Verlängerung.");
  const bases = await offerBases({ accountName: acc?.name ?? "", personName: fl?.displayName ?? internal?.displayName ?? "" }, deps);
  if (!bases?.preselect) throw new ValidationError(`Für das neue Angebot fehlt die Grundlage: Bitte das letzte Angebot unter Kunden › ${acc?.name ?? "Kunde"} › Angebote oder eine Vorlage unter Vorlagen › Angebot Kunde ablegen (Excel).`);
  const { currentPeriod } = await import("@/modules/engagements/service");
  const cur = currentPeriod(periods);
  const vk = (input.vk ?? "").replace(",", ".") || cur?.vk || "";
  const dailyRate = vk ? (Number(vk) * ((cur?.rateUnit ?? "TAG") === "STUNDE" ? 8 : 1)).toFixed(2) : "";
  return generateOffer(actor, engagementId, { basePick: bases.preselect, offerNumber: input.offerNumber, from: ren.proposedFrom ?? todayIso(), until: ren.proposedTo, personDays: input.personDays ?? "", dailyRate }, deps);
}

/** Grundlagen für ein neues Angebot: Angebote des Kunden (passende Person zuerst) und Vorlagen aus „Vorlagen › Angebot Kunde“. */
export async function offerBases(input: { accountName: string; personName: string }, deps: { client?: SpClient } = {}): Promise<{ options: { value: string; label: string }[]; preselect: string | null; templates: number } | null> {
  if (!deps.client && !sharePointEnabled()) return null;
  try {
    const client = deps.client ?? (await defaultSpClient());
    const { filesFor } = await import("./service");
    const files = await filesFor({ accountName: input.accountName, kinds: ["KUNDE_ANGEBOT" as PickKind] }, { client });
    const norm = (s: string) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
    // Nachname(n): alle Namensteile außer dem Vornamen, mindestens 3 Zeichen
    const parts = norm(input.personName.replace(/\(.*?\)/g, "")).split(/[\s,]+/).filter((w) => w.length >= 3);
    const lasts = parts.length > 1 ? parts.slice(1) : parts;
    const offers = (files?.groups[0]?.files ?? []).filter((f) => /\.xlsx$/i.test(f.name));
    const mine = offers.filter((f) => lasts.some((l) => norm(f.name).includes(l)));
    const libs = await libraryMap(client);
    const vid = libs.get(LIB.VORLAGEN);
    let templates: { value: string; label: string }[] = [];
    if (vid) {
      const vdrive = await client.driveOf(vid);
      // Vorlagen direkt im Ordner und eine Ebene darunter (z. B. je Kunde)
      const top = await client.children(vdrive, ["Angebot Kunde"]);
      const nested = (await Promise.all(top.filter((x) => x.folder).map(async (f) => (await client.children(vdrive, ["Angebot Kunde", f.name])).map((x) => ({ ...x, name: `${f.name} › ${x.name}` }))))).flat();
      templates = [...top, ...nested].filter((x) => !x.folder && /\.xlsx$/i.test(x.name)).map((x) => ({ value: `${vdrive}|${x.id}|VORLAGE`, label: `Vorlage: ${x.name}` }));
    }
    const options = [...mine.map((f) => ({ value: f.value, label: `Letztes Angebot: ${f.name}` })), ...templates, ...offers.filter((f) => !mine.includes(f)).map((f) => ({ value: f.value, label: `Anderes Angebot: ${f.name}` }))];
    return { options, preselect: mine[0]?.value ?? templates[0]?.value ?? null, templates: templates.length };
  } catch {
    return { options: [], preselect: null, templates: 0 };
  }
}
