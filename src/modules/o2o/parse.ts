import { extractOrderNumber } from "@/modules/sharepoint/documents";

/**
 * Auftragseingang (e67/e68): Angebot, Bestellung oder Projekteinzelvertrag vorlesen. Zwei Stufen:
 *  1. Regeln (immer, auch ohne KI): Vertragsparteien („Zwischen … und …“), Endkunde („für … (nachfolgend „Kunde“)“),
 *     Nummer, Laufzeit, Verrechnungssatz (Stunde oder Tag), Umfang, eingesetzte Person, Rolle.
 *  2. KI (wenn eingeschaltet, siehe ai.ts): dieselben Felder mit wörtlicher Textstelle; nur belegte Werte zählen.
 * Jedes Feld kommt mit der Textstelle, aus der es stammt; nichts wird geraten, was nicht im Text steht.
 */

export type Field<T = string> = { value: T; evidence: string; by?: "REGEL" | "KI" } | null;
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
  /** Vertragspartner laut Dokument (die Partei, die nicht wir sind) */
  sender: Field;
};

export type ParseContext = { knownPersons?: string[]; ownNames?: string[] };

const clip = (t: string, i: number, len: number) => t.slice(Math.max(0, i - 15), i + len + 60).replace(/\s+/g, " ").trim();

function hit<T>(text: string, re: RegExp, map: (m: RegExpExecArray) => T | null): Field<T> {
  const m = re.exec(text);
  if (!m) return null;
  const v = map(m);
  return v == null ? null : { value: v, evidence: clip(text, m.index, m[0].length), by: "REGEL" };
}

/** Alle Treffer eines Musters (mit /g) als Liste. */
function hits(text: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    out.push(m);
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}

const ORDER_TITLE = /projekteinzelvertrag|einzelvertrag|einzelauftrag|einzelbeauftragung|bestellung|purchase order|auftragsbestätigung|abrufauftrag|\babruf\b|leistungsschein|beauftragung|auftrag nr|vertrag nr/i;
const OFFER_TITLE = /\bangebot\b|quotation|\boffer\b|kostenvoranschlag/i;

/** Dokumentart: Titel (erste Zeilen) zählt dreifach, Dateiname doppelt; ein Angebot erwähnt oft „bei Bestellung …“. */
export function detectKind(text: string, fileName = ""): Field<DocKind> {
  const head = text.split(/\n/).slice(0, 15).join("\n");
  const body = text.slice(0, 6000);
  const count = (s: string, res: RegExp[]) => res.reduce((n, re) => n + (s.match(new RegExp(re.source, "gi"))?.length ?? 0), 0);
  const orderRes = [/\bbestellung\b/, /\bbestellnummer\b/, /purchase order/, /\bwir bestellen\b/, /\bbestellen hiermit\b/, /\bbeauftragen (?:sie )?hiermit\b/, /\bauftragsbestätigung\b/, /\babruf\b(?!bar)/, /\bPO[- ]?(?:Nr|Number|No)\b/, /projekteinzelvertrag/, /einzelvertrag/, /einzelauftrag/, /leistungsschein/, /der auftrag umfasst/, /verrechnungssatz beträgt/, /setzt der auftragnehmer/];
  const offerRes = [/\bangebot\b/, /\bangebotsnummer\b/, /\bquotation\b/, /\bunser angebot\b/, /\bbieten (?:wir )?ihnen\b/, /\bgültig bis\b/, /\bfreibleibend\b/];
  const fn = fileName.toLowerCase();
  const order = count(body, orderRes) + 3 * (ORDER_TITLE.test(head) ? 1 : 0) + 2 * (/bestell|order|\bpo\b|vertrag|auftrag|abruf/.test(fn) ? 1 : 0);
  const offer = count(body, offerRes) + 3 * (OFFER_TITLE.test(head) && !ORDER_TITLE.test(head) ? 1 : 0) + 2 * (/angebot|offer|quot/.test(fn) ? 1 : 0);
  if (order === 0 && offer === 0) return null;
  const kind: DocKind = order >= offer ? "BESTELLUNG" : "ANGEBOT";
  const re = kind === "BESTELLUNG" ? ORDER_TITLE : OFFER_TITLE;
  const m = re.exec(head) ?? re.exec(body);
  return { value: kind, evidence: m ? clip(m.input, m.index, m[0].length) : fileName, by: "REGEL" };
}

const DATE_RE = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})/;
const D = DATE_RE.source;
function isoOf(m: RegExpExecArray | RegExpMatchArray, offset = 1): string | null {
  const d = Number(m[offset]);
  const mo = Number(m[offset + 1]);
  let y = Number(m[offset + 2]);
  if (y < 100) y += 2000;
  if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100)) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Zeitraum: „beginnt am … und endet (voraussichtlich) am …“, „vom … bis …“, „Zeitraum: … – …“, „Beginn: … Ende: …“. */
export function detectPeriod(text: string): { start: Field; end: Field } {
  const patterns = [
    new RegExp(`(?:beginnt|startet)\\s+(?:am\\s+)?${D}[\\s\\S]{0,60}?(?:endet|läuft)\\s+(?:voraussichtlich\\s+|spätestens\\s+)?(?:am\\s+|bis\\s+(?:zum\\s+)?)?${D}`, "i"),
    new RegExp(`(?:vom|von|zeitraum|laufzeit|einsatzzeitraum|leistungszeitraum|projektlaufzeit|period)?\\s*:?\\s*${D}\\s*(?:bis|-|–|—|to)\\s*(?:zum\\s*|einschließlich\\s*)?${D}`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const s = isoOf(m, 1);
    const e = isoOf(m, 4);
    if (s && e && e >= s) {
      const ev = clip(text, m.index, m[0].length);
      return { start: { value: s, evidence: ev, by: "REGEL" }, end: { value: e, evidence: ev, by: "REGEL" } };
    }
  }
  const start = hit(text, new RegExp(`(?:projektbeginn|einsatzbeginn|leistungsbeginn|beginn|start|ab dem)\\s*:?\\s*(?:am\\s+)?${D}`, "i"), (m) => isoOf(m));
  const end = hit(text, new RegExp(`(?:projektende|einsatzende|leistungsende|ende|bis zum|endet am)\\s*:?\\s*(?:am\\s+)?${D}`, "i"), (m) => isoOf(m));
  return { start, end: end && start && end.value < start.value ? null : end };
}

const num = (s: string) => Number(s.replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
const AMOUNT = "(\\d{1,3}(?:\\.\\d{3})*(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
/** Beträge, die kein Verrechnungssatz sind (Reisepauschalen, Spesen, Vertragsstrafen …) */
const NOT_A_RATE = /reise|pauschale|mehraufwand|spesen|übernachtung|hotel|kilometer|km\b|vertragsstrafe|haftung|versicherung|mindestlohn|kaution|gebühr/i;

/** Verrechnungssatz: Stunde oder Tag; ein Stundensatz wird × 8 auf den Tag gerechnet. Reisepauschalen zählen nicht. */
export function detectRate(text: string): Field<number> {
  type Cand = { perDay: number; hourly: boolean; score: number; m: RegExpExecArray };
  const cands: Cand[] = [];
  for (const m of hits(text, new RegExp(`${AMOUNT}\\s*(?:€|eur\\b|euro\\b)([^\\n]{0,70})`, "i"))) {
    const after = m[2]!.toLowerCase();
    const before = text.slice(Math.max(0, m.index - 120), m.index).toLowerCase();
    const ctx = `${before} ${after}`;
    if (NOT_A_RATE.test(after) || NOT_A_RATE.test(before.slice(-60))) continue;
    const v = num(m[1]!);
    const hourly = /(stunde|std\b|std\.|\/\s?h\b|hour)/.test(after.slice(0, 50));
    const daily = /(\btag\b|tages|\bpt\b|personentag|manntag|beratertag|\bday\b)/.test(after.slice(0, 50));
    if (!hourly && !daily && !/(verrechnungssatz|stundensatz|tagessatz|vergütung|honorar|satz)/.test(before.slice(-80))) continue;
    const isHourly = hourly || (!daily && /stundensatz|je stunde|pro stunde/.test(before.slice(-80)));
    const perDay = isHourly ? v * 8 : v;
    if (isHourly ? v < 20 || v > 600 : v < 100 || v > 5000) continue;
    const score = (/(verrechnungssatz|stundensatz|tagessatz|honorar|vergütung)/.test(ctx) ? 3 : 0) + (/geleistete|projektstunde|personentag/.test(after) ? 1 : 0);
    cands.push({ perDay, hourly: isHourly, score, m });
  }
  // auch „Tagessatz: 960“ ohne Währung
  for (const m of hits(text, new RegExp(`(tagessatz|stundensatz|verrechnungssatz)\\s*(?:beträgt|von|:)?\\s*:?\\s*(?:€|eur)?\\s*${AMOUNT}(?!\\s*(?:€|eur))`, "i"))) {
    const v = num(m[2]!);
    const isHourly = /stunden/i.test(m[1]!);
    const perDay = isHourly ? v * 8 : v;
    if (isHourly ? v < 20 || v > 600 : v < 100 || v > 5000) continue;
    cands.push({ perDay, hourly: isHourly, score: 2, m });
  }
  if (!cands.length) return null;
  const best = cands.sort((a, b) => b.score - a.score || a.m.index - b.m.index)[0]!;
  const ev = clip(text, best.m.index, best.m[0].length);
  return { value: Math.round(best.perDay * 100) / 100, evidence: best.hourly ? `${ev} (Stundensatz × 8)` : ev, by: "REGEL" };
}

/** Umfang in Tagen: Personentage direkt, Stunden ÷ 8. Zahlungsziele („45 Tage netto“) und Fristen zählen nicht. */
export function detectDays(text: string): Field<number> {
  for (const m of hits(text, /(\d{1,4}(?:\.\d{3})?)\s*(personentage|beratertage|manntage|arbeitstage|PT\b|tage\b)([^\n]{0,30})/i)) {
    const after = m[3]!.toLowerCase();
    const before = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
    if (/netto|nach|fällig|frist|kündig|zahlung|vorher|vorab|innerhalb/.test(after) || /zahlung|frist|kündig|innerhalb|binnen|spätestens/.test(before)) continue;
    const v = num(m[1]!);
    if (v > 0 && v <= 2000) return { value: v, evidence: clip(text, m.index, m[0].length), by: "REGEL" };
  }
  for (const m of hits(text, /(?:maximal|bis zu|insgesamt|umfang[^\n]{0,40}?|kontingent[^\n]{0,30}?|budget[^\n]{0,30}?)\s*(\d{1,5}(?:\.\d{3})?)\s*(?:stunden|std\.?)\b/i)) {
    const h = num(m[1]!);
    if (h >= 8 && h <= 16000) return { value: Math.round((h / 8) * 10) / 10, evidence: `${clip(text, m.index, m[0].length)} (Stunden ÷ 8)`, by: "REGEL" };
  }
  return null;
}

export function detectOfferNumber(text: string, fileName = ""): Field {
  const moco = /(?<![A-Za-z0-9])([A-Z]{2,5}-[A-Z0-9]{2,6}-\d{2}[_-]\d{3,5})(?![0-9])/;
  const inName = moco.exec(fileName);
  if (inName) return { value: inName[1]!, evidence: `Dateiname: ${fileName}`, by: "REGEL" };
  return hit(text, /(?:angebots?(?:nummer|-?nr\.?)|angebot nr\.?|quotation (?:no\.?|number)|offer (?:no\.?|number)|bezug(?:nehmend)? auf (?:unser )?angebot)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-_/.]{3,30})/i, (m) => (/\d/.test(m[1]!) ? m[1]!.replace(/[.]$/, "") : null)) ?? hit(text, moco, (m) => m[1]!);
}

/** Bestellnummer: Nummer im Titel (Projekteinzelvertrag/Auftrag/Bestellung Nr.), sonst Bestell-/PO-Nummer, sonst SAP-Nummer. */
export function detectOrderNumber(text: string): Field {
  const t = hit(text, /(?:projekteinzelvertrag|einzelvertrag|einzelauftrag|abruf(?:auftrag)?|auftrag|bestellung|vertrag|leistungsschein|purchase order|PO)\s*(?:-|–)?\s*(?:nr\.?|nummer|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]{4,30})/i, (m) => (/\d/.test(m[1]!) ? m[1]! : null));
  if (t) return t;
  const n = extractOrderNumber(text);
  return n ? { value: n, evidence: clip(text, Math.max(0, text.indexOf(n)), n.length), by: "REGEL" } : null;
}

export function detectBrokerRef(text: string): Field {
  return hit(text, /(?:projekt(?:nummer|-?nr\.?|-?id)|referenz(?:nummer)?|ref\.?\s?-?nr\.?|job-?id|anfrage-?(?:nr\.?|nummer)|vakanz(?:-?nr\.?)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-_/]{2,24})/i, (m) => (/\d/.test(m[1]!) ? m[1]! : null));
}

export function detectRole(text: string): Field {
  return (
    hit(text, /(?:leistungen|tätigkeiten|aufgaben)\s+im\s+bereich\s*:?\s*\n?\s*([^\n]{3,90})/i, (m) => m[1]!.trim().replace(/[.,:]$/, "")) ??
    hit(text, /(?:^|[\n;,.]\s*)(?:rolle|projektrolle|position|funktion|tätigkeit|leistung|vakanz)[ \t]*:[ \t]*([^\n;]{3,90})/i, (m) => m[1]!.trim().replace(/[.,]$/, "")) ??
    hit(text, /\bals\s+((?:senior\s+|junior\s+|lead\s+)?[A-ZÄÖÜ][\wäöüß-]+(?:\s+[A-ZÄÖÜ][\wäöüß-]+){0,3})\s+(?:tätig|eingesetzt|beauftragt)/, (m) => m[1]!.trim())
  );
}

/** Endkunde: „für ERGO Group AG (nachfolgend: „Kunde“)“, „Endkunde: …“, „Einsatz bei …“. */
export function detectEndCustomer(text: string): Field {
  const flat = text.replace(/[ \t]+/g, " ");
  return (
    hit(flat, /\bfür\s+(?:die\s+|den\s+|das\s+)?([A-ZÄÖÜ0-9][^\n]{1,80}?)\s*\(\s*(?:nachfolgend|im folgenden)\s*:?\s*[„"“]?(?:end)?kunde/i, (m) => m[1]!.trim()) ??
    hit(flat, /(?:endkunde|end customer|einsatz bei|kunde des vermittlers|auftraggeber \(endkunde\))[ \t]*:[ \t]*([^\n;]{2,90})/i, (m) => m[1]!.trim().replace(/[.,]$/, "")) ??
    hit(flat, /\bbeim\s+(?:end)?kunden\s+([A-ZÄÖÜ][^\n,;()]{2,60}?)(?:\s*\(|,|\.|\n|$)/, (m) => m[1]!.trim())
  );
}

const COMPANY_WORD = /\b(gmbh|ag|se|kg|kgaa|mbh|ug|e\.?\s?k\.?|ltd|limited|inc|llc|s\.?a\.?|b\.?v\.?|plc|solutions|consulting|group|gruppe|holding)\b|\(fiktiv\)/i;
const cleanParty = (s: string) => s.replace(/^(der|die|dem|den|das|firma)\s+/i, "").replace(/\s*[–-]\s*nachfolgend.*$/i, "").replace(/[,;]$/, "").trim();

/** Vertragsparteien aus „Zwischen … und …“ (Vertragskopf). */
export function detectParties(text: string): string[] {
  const m = /zwischen\s+([^\n]{2,90})\n[\s\S]{0,400}?\n\s*und\s+([^\n]{2,90})/i.exec(text);
  if (!m) return [];
  return [cleanParty(m[1]!), cleanParty(m[2]!)].filter((x) => x.length >= 2);
}

const isOwn = (name: string, own: string[]) => own.some((o) => o.length >= 3 && name.toLowerCase().includes(o.toLowerCase()));

/** Vertragspartner: die Partei im Vertragskopf, die nicht wir sind; sonst der Briefkopf (erste Firmenzeile, nicht wir). */
export function detectSender(text: string, ownNames: string[] = []): Field {
  const parties = detectParties(text);
  const other = parties.find((p) => !isOwn(p, ownNames));
  if (other && parties.length === 2) {
    const i = text.indexOf(other);
    return { value: other, evidence: clip(text, Math.max(0, i), other.length), by: "REGEL" };
  }
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 12);
  for (const l of lines) {
    if (l.length > 80 || /bestell|angebot|betreff|datum|seite|rev\.|vertrag/i.test(l) || isOwn(l, ownNames)) continue;
    if (COMPANY_WORD.test(l)) return { value: cleanParty(l), evidence: l, by: "REGEL" };
  }
  return null;
}

/**
 * Person: zuerst die ausdrückliche Nennung („setzt der Auftragnehmer NAME ein“, „eingesetzte Person: NAME“, „Berater: NAME“),
 * auf einen bekannten Namen abgebildet; sonst ein bekannter vollständiger Name im Text – aber nicht im Unterschriftenblock.
 */
export function detectPerson(text: string, known: string[]): Field {
  const norm = (s: string) => s.replace(/\(.*?\)/g, "").replace(/,.*$/, "").trim();
  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();
  const NAME = "((?:[A-ZÄÖÜ][a-zäöüß]+[- ]){1,2}[A-ZÄÖÜ][a-zäöüß-]+)";
  const explicit =
    hit(flat, new RegExp(`setzt\\s+(?:[Dd]er\\s+[Aa]uftragnehmer\\s+|[Dd]ie\\s+[Aa]uftragnehmerin\\s+|[Dd]er\\s+[Dd]ienstleister\\s+)?(?:[Hh]errn?\\s+|[Ff]rau\\s+)?${NAME}\\s+ein`), (m) => m[1]!.trim()) ??
    hit(flat, new RegExp(`(?:[Ee]ingesetzte [Pp]erson|[Ee]ingesetzter [Bb]erater|[Bb]erater(?:in)?|[Cc]onsultant|[Ee]xpert(?:e|in)|[Kk]andidat(?:in)?|[Ff]reelancer(?:in)?|[Rr]essource)\\s*:\\s*(?:[Hh]errn?\\s+|[Ff]rau\\s+)?${NAME}`), (m) => m[1]!.trim());
  if (explicit) {
    const k = known.find((n) => norm(n).toLowerCase() === explicit.value.toLowerCase()) ?? known.find((n) => norm(n).split(/\s+/).length >= 2 && explicit.value.toLowerCase().includes(norm(n).toLowerCase()));
    if (k) return { ...explicit, value: k };
    // nur Vorname bekannt (z. B. aus Moco übernommen) – nur wenn eindeutig
    const first = explicit.value.split(/\s+/)[0]!.toLowerCase();
    const byFirst = known.filter((n) => norm(n).toLowerCase() === first);
    return byFirst.length === 1 ? { ...explicit, value: byFirst[0]!, evidence: `${explicit.evidence} (bekannt nur als „${norm(byFirst[0]!)}“)` } : explicit;
  }
  const SIGN = /unterschrift|zeitstempel|signiert|signature|docusign|gez\.|i\.\s?a\.|i\.\s?v\.|geschäftsführer|ort, datum/i;
  for (const name of [...known].sort((a, b) => norm(b).length - norm(a).length)) {
    const n = norm(name);
    if (n.split(/\s+/).length < 2 || n.length < 5) continue;
    let from = 0;
    let i: number;
    while ((i = lower.indexOf(n.toLowerCase(), from)) >= 0) {
      const around = flat.slice(Math.max(0, i - 80), i + n.length + 80);
      if (!SIGN.test(around)) return { value: name, evidence: clip(flat, i, n.length), by: "REGEL" };
      from = i + n.length;
    }
  }
  return null;
}

export function parseDocument(text: string, fileName: string, ctx: ParseContext | string[] = {}): ParsedDoc {
  const c: ParseContext = Array.isArray(ctx) ? { knownPersons: ctx } : ctx;
  const period = detectPeriod(text);
  const kind = detectKind(text, fileName);
  return {
    kind,
    orderNumber: kind?.value === "BESTELLUNG" ? detectOrderNumber(text) : null,
    offerNumber: detectOfferNumber(text, fileName),
    brokerRef: detectBrokerRef(text),
    start: period.start,
    end: period.end,
    dailyRate: detectRate(text),
    days: detectDays(text),
    role: detectRole(text),
    person: detectPerson(text, c.knownPersons ?? []),
    endCustomer: detectEndCustomer(text),
    sender: detectSender(text, c.ownNames ?? []),
  };
}
