/**
 * Werktagsrechnung für Fristen und SLAs (Etappe 27): Montag–Freitag ohne gesetzliche Feiertage in NRW
 * (Sitz Verve Consulting). Alle Datumswerte als ISO-Datum (YYYY-MM-DD), Berechnung in UTC ohne Zeitzonensprünge.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Ostersonntag (Gauß/Anonymous Gregorian) */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

const cache = new Map<number, Set<string>>();

/** Gesetzliche Feiertage NRW */
export function holidaysNrw(year: number): Set<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const e = easterSunday(year);
  const set = new Set<string>([
    iso(utc(year, 1, 1)), // Neujahr
    iso(addDays(e, -2)), // Karfreitag
    iso(addDays(e, 1)), // Ostermontag
    iso(utc(year, 5, 1)), // Tag der Arbeit
    iso(addDays(e, 39)), // Christi Himmelfahrt
    iso(addDays(e, 50)), // Pfingstmontag
    iso(addDays(e, 60)), // Fronleichnam
    iso(utc(year, 10, 3)), // Tag der Deutschen Einheit
    iso(utc(year, 11, 1)), // Allerheiligen
    iso(utc(year, 12, 25)),
    iso(utc(year, 12, 26)),
  ]);
  cache.set(year, set);
  return set;
}

export function isWorkday(isoDate: string): boolean {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !holidaysNrw(d.getUTCFullYear()).has(isoDate);
}

/** n Werktage nach dem Startdatum (Start zählt nicht mit); n = 0 → nächster Werktag ab Start (inklusive). */
export function addWorkdays(startIso: string, n: number): string {
  let d = new Date(`${startIso}T00:00:00Z`);
  if (n <= 0) {
    while (!isWorkday(iso(d))) d = addDays(d, 1);
    return iso(d);
  }
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isWorkday(iso(d))) left--;
  }
  return iso(d);
}

/** Heutiges Datum in Europe/Berlin als ISO */
export function todayIso(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function plusDaysIso(isoDate: string, n: number): string {
  return iso(addDays(new Date(`${isoDate}T00:00:00Z`), n));
}

const WEEKDAYS = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];

/** Kurze Fristangaben aus Gesprächen: „morgen“, „bis Freitag“, „nächste Woche“, „in 3 Tagen“, „in 2 Wochen“, „15.11.“ / „15.11.2026“. */
export function parseRelativeDue(hint: string | null | undefined, today = todayIso()): string | null {
  if (!hint) return null;
  const h = hint.toLowerCase().replace(/^bis\s+/, "").trim();
  if (/^(heute)\b/.test(h)) return today;
  if (/^(morgen)\b/.test(h)) return plusDaysIso(today, 1);
  if (/^übermorgen\b/.test(h)) return plusDaysIso(today, 2);
  if (/^(nächste|kommende)\s+woche\b/.test(h)) return plusDaysIso(today, 7);
  let m = h.match(/^in\s+(\d{1,3})\s+(tag|tagen|woche|wochen)\b/);
  if (m) return plusDaysIso(today, Number(m[1]) * (m[2]!.startsWith("woche") ? 7 : 1));
  m = h.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
  if (m) {
    const y0 = Number(today.slice(0, 4));
    const d = `${m[3] ?? y0}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
    if (!m[3] && d < today) return `${y0 + 1}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  }
  const wd = WEEKDAYS.findIndex((w) => h.startsWith(w));
  if (wd >= 0) {
    const cur = new Date(`${today}T00:00:00Z`).getUTCDay();
    const diff = (wd - cur + 7) % 7 || 7;
    return plusDaysIso(today, diff);
  }
  return null;
}
