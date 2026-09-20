import type { ExtractStatus } from "@/db/schema";

/**
 * Textextraktion aus hochgeladenen Dokumenten (Etappe 6A). Ergebnis ist reiner Text, der als Quelle
 * (sources.body) geführt wird. Kein OCR: gescannte PDFs ohne Textebene ergeben Status LEER mit Hinweis.
 * Die Extraktion läuft vollständig lokal auf dem Server – nichts verlässt die Anwendung.
 */

export type ExtractResult = { text: string; status: ExtractStatus; note: string | null; pageCount: number | null };

export const ALLOWED_EXTENSIONS = ["pdf", "docx", "xlsx", "csv", "txt", "md", "eml", "json"] as const;
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

const MIME_BY_EXT: Record<AllowedExtension, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  eml: "message/rfc822",
  json: "application/json",
};

/** Maximale Textlänge, die als Quelle übernommen wird (Schutz vor Speicher-/Prompt-Explosion). */
export const MAX_TEXT_CHARS = 400_000;

export function extensionOf(fileName: string): AllowedExtension | null {
  const m = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  const ext = (m?.[1] ?? "").toLowerCase();
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext) ? (ext as AllowedExtension) : null;
}

export function canonicalMime(ext: AllowedExtension): string {
  return MIME_BY_EXT[ext];
}

/** Steuerzeichen entfernen, Leerraum glätten, Länge begrenzen. */
export function cleanText(raw: string): string {
  const cleaned = raw
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > MAX_TEXT_CHARS ? cleaned.slice(0, MAX_TEXT_CHARS) : cleaned;
}

function finish(text: string, pageCount: number | null, truncated = false): ExtractResult {
  const t = cleanText(text);
  if (t.length < 20) return { text: t, status: "LEER", note: "Es konnte kein lesbarer Text gefunden werden (z. B. gescanntes Dokument ohne Textebene). Der Inhalt kann als Notiz abgetippt werden.", pageCount };
  if (truncated || text.length > MAX_TEXT_CHARS) return { text: t, status: "TEILWEISE", note: `Der Text wurde auf ${MAX_TEXT_CHARS.toLocaleString("de-DE")} Zeichen gekürzt.`, pageCount };
  return { text: t, status: "OK", note: null, pageCount };
}

async function extractPdf(buf: Buffer): Promise<ExtractResult> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return finish(text, totalPages);
}

async function extractDocx(buf: Buffer): Promise<ExtractResult> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: buf });
  const warn = result.messages.filter((m) => m.type === "warning").length;
  const r = finish(result.value, null);
  if (r.status === "OK" && warn > 0) return { ...r, status: "TEILWEISE", note: `${warn} Element(e) konnten nicht übernommen werden (z. B. eingebettete Objekte).` };
  return r;
}

async function extractXlsx(buf: Buffer): Promise<ExtractResult> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const parts: string[] = [];
  let truncated = false;
  wb.eachSheet((ws) => {
    parts.push(`## Tabellenblatt: ${ws.name}`);
    let rows = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows >= 5000) {
        truncated = true;
        return;
      }
      const cells = (row.values as unknown[]).slice(1).map((v) => cellToString(v));
      if (cells.some((c) => c.length > 0)) parts.push(cells.join(" | "));
      rows++;
    });
  });
  return finish(parts.join("\n"), wb.worksheets.length, truncated);
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; result?: unknown; text?: string; hyperlink?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.result !== undefined) return cellToString(o.result);
    if (o.text) return o.text;
    return "";
  }
  return String(v).trim();
}

function extractCsv(buf: Buffer): ExtractResult {
  const text = decodeText(buf);
  const lines = text.split(/\r?\n/);
  const sep = (lines[0] ?? "").split(";").length > (lines[0] ?? "").split(",").length ? ";" : ",";
  const out = lines.filter((l) => l.trim().length > 0).map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, "").trim()).join(" | "));
  return finish(out.join("\n"), null, lines.length > 5000);
}

function extractEml(buf: Buffer): ExtractResult {
  const raw = decodeText(buf);
  const sep = raw.indexOf("\n\n");
  const headerBlock = sep >= 0 ? raw.slice(0, sep) : raw;
  const body = sep >= 0 ? raw.slice(sep + 2) : "";
  const pick = (name: string) => {
    const m = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(headerBlock);
    return m?.[1]?.trim() ?? "";
  };
  const head = [`Von: ${pick("From")}`, `An: ${pick("To")}`, `Datum: ${pick("Date")}`, `Betreff: ${pick("Subject")}`].join("\n");
  // Nur den ersten Textteil übernehmen; HTML grob entkernen
  const plain = body.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  return finish(`${head}\n\n${plain}`, null);
}

function decodeText(buf: Buffer): string {
  // UTF-8 bevorzugt; bei vielen Ersatzzeichen Latin-1 annehmen (typisch für ältere Windows-Exporte)
  const utf8 = buf.toString("utf8");
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad > 0 && bad > utf8.length / 200) return buf.toString("latin1");
  return utf8.replace(/^﻿/, "");
}

export async function extractDocumentText(buf: Buffer, ext: AllowedExtension): Promise<ExtractResult> {
  try {
    switch (ext) {
      case "pdf":
        return await extractPdf(buf);
      case "docx":
        return await extractDocx(buf);
      case "xlsx":
        return await extractXlsx(buf);
      case "csv":
        return extractCsv(buf);
      case "eml":
        return extractEml(buf);
      case "json":
      case "txt":
      case "md":
        return finish(decodeText(buf), null);
    }
  } catch (e) {
    return { text: "", status: "FEHLER", note: `Die Datei konnte nicht gelesen werden (${e instanceof Error ? e.message.slice(0, 120) : "unbekannter Fehler"}). Ist sie beschädigt oder passwortgeschützt?`, pageCount: null };
  }
}
