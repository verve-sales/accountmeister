import { extractOrderNumber } from "@/modules/sharepoint/documents";

/**
 * Auftragseingang (e67): Angebot oder Bestellung regelbasiert vorlesen. Jedes Feld kommt mit der Textstelle, aus der es
 * stammt; nichts wird geraten, was nicht im Text steht. Die Person bestätigt beim Hochladen Feld für Feld (R2).
 */

export type Field<T = string> = { value: T; evidence: string } | null;
export type DocKind = "ANGEBOT" | "BESTELLUNG";

export type ParsedDoc = {
  kind: Field<DocKind>;
  orderNumber: Field;
  offerNumber: Field;
  brokerRef: Field;
  start: Field;
  end: Field;
  /** Tagessatz in Euro (Stundensatz × 8, falls nur ein Stundensatz genannt ist) */
  dailyRate: Field<number>;
  days: Field<number>;
  role: Field;
  person: Field;
  endCustomer: Field;
  sender: Field;
};

const clip = (t: string, i: number, len: number) => t.slice(Math.max(0, i - 15), i + len + 60).replace(/\s+/g, " ").trim();

function hit<T>(text: string, re: RegExp, map: (m: RegExpExecArray) => T | null): Field<T> {
  const m = re.exec(text);
  if (!m) return null;
  const v = map(m);
  return v == null ? null : { value: v, evidence: clip(text, m.index, m[0].length) };
}

/** Dokumentart: gewichtete Hinweise statt erstem Treffer – ein Angebot erwähnt oft „bei Bestellung …“. */
export function detectKind(text: string, fileName = ""): Field<DocKind> {
  const head = `${fileName}\n${text.slice(0, 3000)}`;
  const score = (res: RegExp[]) => res.reduce((n, re) => n + (head.match(re)?.length ?? 0), 0);
  const order = score([/\bbestellung\b/gi, /\bbestellnummer\b/gi, /purchase order/gi, /\bwir bestellen\b/gi, /\bbestellen hiermit\b/gi, /\bbeauftragen (?:sie )?hiermit\b/gi, /\bauftragsbestätigung\b/gi, /\babruf\b(?!bar)/gi, /\bPO[- ]?(?:Nr|Number|No)\b/g]);
  const offer = score([/\bangebot\b/gi, /\bangebotsnummer\b/gi, /\bquotation\b/gi, /\bunser angebot\b/gi, /\bbieten (?:wir )?ihnen\b/gi, /\bgültig bis\b/gi, /\bprofil\b/gi]);
  // Dateiname zählt doppelt
  const fn = fileName.toLowerCase();
  const o2 = order + (/bestell|order|\bpo\b/.test(fn) ? 2 : 0);
  const f2 = offer + (/angebot|offer|quot/.test(fn) ? 2 : 0);
  if (o2 === 0 && f2 === 0) return null;
  const kind: DocKind = o2 >= f2 ? "BESTELLUNG" : "ANGEBOT";
  const re = kind === "BESTELLUNG" ? /bestellung|bestellnummer|purchase order|bestellen|beauftragen|abruf/i : /angebot|quotation|bieten/i;
  const m = re.exec(head);
  return { value: kind, evidence: m ? clip(head, m.index, m[0].length) : fileName };
}

const DATE = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})/;
function isoOf(m: RegExpExecArray | RegExpMatchArray, offset = 1): string | null {
  const d = Number(m[offset]);
  const mo = Number(m[offset + 1]);
  let y = Number(m[offset + 2]);
  if (y < 100) y += 2000;
  if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100)) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Zeitraum: „vom 1.12.2026 bis 31.3.2027“, „Zeitraum: 01.12.2026 – 31.03.2027“, „Beginn: … Ende: …“. */
export function detectPeriod(text: string): { start: Field; end: Field } {
  const range = /(?:vom|von|zeitraum|laufzeit|einsatzzeitraum|leistungszeitraum|period)?\s*:?\s*(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})\s*(?:bis|-|–|—|to)\s*(?:zum\s*)?(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})/i.exec(text);
  if (range) {
    const s = isoOf(range, 1);
    const e = isoOf(range, 4);
    if (s && e && e >= s) {
      const ev = clip(text, range.index, range[0].length);
      return { start: { value: s, evidence: ev }, end: { value: e, evidence: ev } };
    }
  }
  const start = hit(text, new RegExp(`(?:beginn|start|einsatzbeginn|ab dem|ab)\\s*:?\\s*${DATE.source}`, "i"), (m) => isoOf(m));
  const end = hit(text, new RegExp(`(?:ende|einsatzende|bis zum|bis)\\s*:?\\s*${DATE.source}`, "i"), (m) => isoOf(m));
  return { start, end: end && start && end.value < start.value ? null : end };
}

const num = (s: string) => Number(s.replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));

/** Tagessatz in Euro; ein Stundensatz wird × 8 umgerechnet (Moco rechnet umgekehrt ÷ 8). */
export function detectRate(text: string): Field<number> {
  const day =
    hit(text, /(?:tagessatz|tagesrate|daily rate|pt-satz|satz je (?:tag|pt))\s*:?\s*(?:€|eur)?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i, (m) => num(m[1]!)) ??
    hit(text, /(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)\s*(?:\/|pro|je|per)\s*(?:tag|pt|personentag|manntag|day)\b/i, (m) => num(m[1]!));
  if (day && day.value >= 100 && day.value <= 5000) return day;
  const hour =
    hit(text, /(?:stundensatz|hourly rate)\s*:?\s*(?:€|eur)?\s*(\d+(?:[.,]\d{1,2})?)/i, (m) => num(m[1]!)) ??
    hit(text, /(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)\s*(?:\/|pro|je|per)\s*(?:std\.?|stunde|h|hour)\b/i, (m) => num(m[1]!));
  if (hour && hour.value >= 20 && hour.value <= 600) return { value: Math.round(hour.value * 8 * 100) / 100, evidence: `${hour.evidence} (× 8 Stunden)` };
  return null;
}

export function detectDays(text: string): Field<number> {
  const f = hit(text, /(\d{1,4})\s*(?:PT|personentage|manntage|beratertage|arbeitstage|tage\b)/i, (m) => Number(m[1]));
  return f && f.value > 0 && f.value <= 2000 ? f : null;
}

export function detectOfferNumber(text: string, fileName = ""): Field {
  const moco = /(?<![A-Za-z0-9])([A-Z]{2,5}-[A-Z0-9]{2,6}-\d{2}[_-]\d{3,5})(?![0-9])/;
  const inName = moco.exec(fileName);
  if (inName) return { value: inName[1]!, evidence: `Dateiname: ${fileName}` };
  return hit(text, /(?:angebots?(?:nummer|-?nr\.?)|angebot nr\.?|quotation (?:no\.?|number)|offer (?:no\.?|number))\s*[:#]?\s*([A-Z0-9][A-Z0-9\-_/.]{3,30})/i, (m) => (/\d/.test(m[1]!) ? m[1]!.replace(/[.]$/, "") : null)) ?? hit(text, moco, (m) => m[1]!);
}

export function detectBrokerRef(text: string): Field {
  return hit(text, /(?:projekt(?:nummer|-?nr\.?|-?id)|referenz(?:nummer)?|ref\.?\s?-?nr\.?|job-?id|anfrage-?(?:nr\.?|nummer)|vakanz(?:-?nr\.?)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-_/]{2,24})/i, (m) => (/\d/.test(m[1]!) ? m[1]! : null));
}

export function detectRole(text: string): Field {
  return hit(text, /(?:^|[\n;,.]\s*)(?:rolle|position|funktion|tätigkeit|leistung|vakanz)[ \t]*:[ \t]*([^\n;]{3,90})/i, (m) => m[1]!.trim().replace(/[.,]$/, ""));
}

export function detectEndCustomer(text: string): Field {
  return hit(text, /(?:endkunde|end customer|einsatz bei|kunde des vermittlers|auftraggeber \(endkunde\))[ \t]*:[ \t]*([^\n;]{2,90})/i, (m) => m[1]!.trim().replace(/[.,]$/, ""));
}

/** Person: bekannte Namen (Freelancer, interne Personen) im Text; sonst „Berater: Vorname Nachname“. */
export function detectPerson(text: string, known: string[]): Field {
  const norm = (s: string) => s.replace(/\(.*?\)/g, "").trim();
  const flat = text.replace(/\s+/g, " ");
  for (const name of known) {
    const n = norm(name);
    const last = n.split(" ").pop() ?? "";
    if (n.length >= 5 && flat.toLowerCase().includes(n.toLowerCase())) {
      const i = flat.toLowerCase().indexOf(n.toLowerCase());
      return { value: name, evidence: clip(flat, i, n.length) };
    }
    if (last.length >= 5) {
      const re = new RegExp(`\\b(?:herr|frau|hr\\.|fr\\.)\\s+${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const m = re.exec(flat);
      if (m) return { value: name, evidence: clip(flat, m.index, m[0].length) };
    }
  }
  return hit(text, /(?:berater(?:in)?|consultant|mitarbeiter(?:in)?|experte|expertin|kandidat(?:in)?|freelancer(?:in)?|ressource|name)\s*:\s*((?:[A-ZÄÖÜ][a-zäöüß-]+\s){1,2}[A-ZÄÖÜ][a-zäöüß-]+)/, (m) => m[1]!.trim());
}

/** Absender bzw. Vertragspartner: erste Zeile, die wie ein Firmenname aussieht (Briefkopf). */
export function detectSender(text: string): Field {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 8);
  for (const l of lines) {
    if (l.length > 80 || /bestell|angebot|betreff|datum|seite/i.test(l)) continue;
    if (/\b(gmbh|ag|se|kg|mbh|ug|e\.?\s?k\.?|ltd|limited|inc|solutions|consulting|group|gruppe)\b|\(fiktiv\)/i.test(l)) return { value: l.replace(/[,;]$/, ""), evidence: l };
  }
  return null;
}

export function parseDocument(text: string, fileName: string, knownPersons: string[] = []): ParsedDoc {
  const period = detectPeriod(text);
  const kind = detectKind(text, fileName);
  const orderNo = kind?.value === "BESTELLUNG" ? extractOrderNumber(text) : null;
  return {
    kind,
    orderNumber: orderNo ? { value: orderNo, evidence: clip(text, Math.max(0, text.indexOf(orderNo)), orderNo.length) } : null,
    offerNumber: detectOfferNumber(text, fileName),
    brokerRef: detectBrokerRef(text),
    start: period.start,
    end: period.end,
    dailyRate: detectRate(text),
    days: detectDays(text),
    role: detectRole(text),
    person: detectPerson(text, knownPersons),
    endCustomer: detectEndCustomer(text),
    sender: detectSender(text),
  };
}
