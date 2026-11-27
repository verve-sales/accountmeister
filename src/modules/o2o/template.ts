import type { Field, ParsedDoc } from "./parse";

/**
 * e71: Angebotsformular der ERGO-Gruppe (Excel, Blatt „Offer overview“) fest auslesen – dieselben Zellen, die die App beim
 * Erzeugen des Angebots füllt. Das ist verlässlicher als jede Texterkennung: Werte kommen direkt aus der Zelle, die Fundstelle
 * ist die Zelladresse. Unbekannte Excel-Dateien liefern null und laufen über KI und Regeln.
 */
const SHEET = "Offer overview";
const CELLS = { offerNumber: "S9", personDays: "Q28", rate: "U28", rateDiscounted: "X28", from: "M54", until: "Q54" } as const;

function plain(v: unknown): unknown {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as { result?: unknown; richText?: { text: string }[]; text?: string };
    if (o.result !== undefined) return plain(o.result);
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.text) return o.text;
    return null;
  }
  return v;
}
const iso = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
function dateOf(v: unknown): string | null {
  const p = plain(v);
  if (p instanceof Date) return iso(p);
  if (typeof p === "number" && p > 30000 && p < 80000) return iso(new Date(Date.UTC(1899, 11, 30) + p * 86400000));
  if (typeof p === "string") {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(p.trim());
    if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  return null;
}
const numOf = (v: unknown): number | null => {
  const p = plain(v);
  if (typeof p === "number" && Number.isFinite(p)) return p;
  if (typeof p === "string" && /^\d+([.,]\d+)?$/.test(p.trim())) return Number(p.trim().replace(",", "."));
  return null;
};

export async function readOfferTemplate(buf: Buffer): Promise<Partial<ParsedDoc> | null> {
  try {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet(SHEET);
    if (!ws) return null;
    const f = <T>(value: T | null, cell: string, what: string): Field<T> => (value == null ? null : { value, evidence: `Formular, Zelle ${cell} (${what})`, by: "REGEL" });
    const below = (label: RegExp): { value: string; cell: string } | null => {
      let found: { value: string; cell: string } | null = null;
      ws.eachRow((row, n) => {
        if (found) return;
        row.eachCell((c) => {
          if (found || (c.isMerged && c.master.address !== c.address)) return;
          if (typeof plain(c.value) === "string" && label.test(String(plain(c.value)))) {
            for (let d = 1; d <= 2; d++) {
              const t = ws.getCell(n + d, Number(c.col));
              const v = plain(t.master?.value ?? t.value);
              if (typeof v === "string" && v.trim()) {
                found = { value: v.trim(), cell: t.address };
                return;
              }
            }
          }
        });
      });
      return found;
    };
    const rateDisc = numOf(ws.getCell(CELLS.rateDiscounted).value);
    const rateBase = numOf(ws.getCell(CELLS.rate).value);
    const rate = rateDisc && rateDisc >= 100 && rateDisc <= 5000 ? { v: rateDisc, c: CELLS.rateDiscounted, w: "Daily rate discounted" } : rateBase && rateBase >= 100 && rateBase <= 5000 ? { v: rateBase, c: CELLS.rate, w: "Daily rate" } : null;
    const days = numOf(ws.getCell(CELLS.personDays).value);
    const from = dateOf(ws.getCell(CELLS.from).value);
    const until = dateOf(ws.getCell(CELLS.until).value);
    const no = plain(ws.getCell(CELLS.offerNumber).value);
    const summary = below(/brief summary of the service description/i);
    const offerFor = below(/^offer for$/i);
    void offerFor;
    return {
      kind: { value: "ANGEBOT", evidence: `Angebotsformular (Blatt „${SHEET}“)`, by: "REGEL" },
      offerNumber: f(typeof no === "string" && /\d/.test(no) ? no.trim() : null, CELLS.offerNumber, "Offer no."),
      dailyRate: rate ? f(rate.v, rate.c, rate.w) : null,
      days: f(days && days > 0 && days <= 2000 ? days : null, CELLS.personDays, "PD"),
      start: f(from, CELLS.from, "Service period from"),
      end: f(until && (!from || until >= from) ? until : null, CELLS.until, "Service period until"),
      role: summary ? f(summary.value.replace(/^verlängerung:\s*/i, "").slice(0, 160), summary.cell, "Brief summary") : null,
    };
  } catch {
    return null;
  }
}
