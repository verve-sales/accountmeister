import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { ValidationError } from "@/lib/errors";

/**
 * Projekteinzelvertrag aus der freigegebenen Word-Vorlage befüllen (Etappe 51) – ohne KI, rein durch Ersetzen der
 * Platzhalter. Die Vorlagen liegen unter templates/vertrag; jeder Platzhalter steht dort in einem einzigen Textlauf.
 * Die Aufgaben stehen als ein Listenabsatz `{#aufgaben}{.}{/aufgaben}`, der je Aufgabe wiederholt wird.
 * Die Vorlage enthält keine Unterschriften: Beide Seiten unterschreiben selbst.
 */

export const CONTRACT_TEMPLATE_VERSION = "projekteinzelvertrag.2026-11";
export type ContractVariant = "PERSON" | "GESELLSCHAFT";

export type ContractData = {
  variant: ContractVariant;
  rolle: string;
  leistungsbereich: string;
  aufgaben: string[];
  auftragnehmer_name?: string;
  auftragnehmer_firma?: string;
  auftragnehmer_strasse: string;
  auftragnehmer_plz_ort: string;
  steuernummer?: string;
  vertreter_name?: string;
  vertreter_funktion?: string;
  endkunde: string;
  endkunde_ort: string;
  beginn: string;
  ende: string;
  kontingent_tage: string;
  stunden_je_projekttag: string;
  bedingung_frist: string;
  einsatzort: string;
  stundensatz: string;
  zahlungsziel_tage: string;
  kuendigungsfrist_tage: string;
  ort: string;
  datum: string;
};

const FILES: Record<ContractVariant, string> = { PERSON: "projekteinzelvertrag-einzelperson.docx", GESELLSCHAFT: "projekteinzelvertrag-gesellschaft.docx" };
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Datum JJJJ-MM-TT → TT.MM.JJJJ (sonst unverändert). */
export function deDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Betrag als „75,00“. */
export function deMoney(v: string | number): string {
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) throw new ValidationError("Der Satz ist keine Zahl.");
  return n.toFixed(2).replace(".", ",");
}

/** Füllt das Dokument-XML: Aufgabenabsatz vervielfältigen, dann alle Platzhalter ersetzen. Unbekannte Platzhalter sind ein Fehler. */
export function fillDocumentXml(source: string, data: ContractData): string {
  let x = source;
  const loop = /<w:p[ >](?:(?!<\/w:p>)[\s\S])*\{#aufgaben\}\{\.\}\{\/aufgaben\}(?:(?!<\/w:p>)[\s\S])*<\/w:p>/.exec(x);
  if (!loop) throw new Error("Vertragsvorlage: Aufgabenabsatz nicht gefunden.");
  const tasks = data.aufgaben.map((t) => t.trim()).filter(Boolean);
  if (!tasks.length) throw new ValidationError("Bitte mindestens eine Aufgabe angeben.");
  x = x.replace(loop[0], tasks.map((t) => loop[0].replace("{#aufgaben}{.}{/aufgaben}", xml(t))).join(""));
  const values: Record<string, string | undefined> = { ...data, aufgaben: undefined, variant: undefined } as unknown as Record<string, string | undefined>;
  x = x.replace(/\{([a-z_]+)\}/g, (whole, key: string) => {
    const v = values[key];
    if (v === undefined || v === null || String(v).trim() === "") throw new ValidationError(`Für den Vertrag fehlt die Angabe „${LABELS[key] ?? key}“.`);
    return xml(String(v).trim());
  });
  return x;
}

const LABELS: Record<string, string> = {
  rolle: "Rolle",
  leistungsbereich: "Leistungsbereich",
  auftragnehmer_name: "Name des Auftragnehmers",
  auftragnehmer_firma: "Firma des Auftragnehmers",
  auftragnehmer_strasse: "Straße des Auftragnehmers (im Freelancer-Profil)",
  auftragnehmer_plz_ort: "PLZ und Ort des Auftragnehmers (im Freelancer-Profil)",
  steuernummer: "Steuernummer (im Freelancer-Profil)",
  vertreter_name: "Vertretungsberechtigte Person (im Freelancer-Profil)",
  vertreter_funktion: "Funktion der vertretungsberechtigten Person (im Freelancer-Profil)",
  endkunde: "Endkunde",
  endkunde_ort: "Ort des Endkunden",
  beginn: "Beginn",
  ende: "Ende",
  kontingent_tage: "Kontingent in Projekttagen",
  stunden_je_projekttag: "Stunden je Projekttag",
  bedingung_frist: "Frist für die Beauftragung durch den Endkunden",
  einsatzort: "Einsatzort",
  stundensatz: "Stundensatz",
  zahlungsziel_tage: "Zahlungsziel in Tagen",
  kuendigungsfrist_tage: "Kündigungsfrist in Tagen",
  ort: "Ort",
  datum: "Datum",
};

export async function renderContract(data: ContractData, opts: { templateDir?: string } = {}): Promise<Buffer> {
  const dir = opts.templateDir ?? path.join(process.cwd(), "templates", "vertrag");
  const zip = await JSZip.loadAsync(await readFile(path.join(dir, FILES[data.variant])));
  const doc = zip.file("word/document.xml");
  if (!doc) throw new Error("Vertragsvorlage ist beschädigt.");
  zip.file("word/document.xml", fillDocumentXml(await doc.async("string"), data));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
