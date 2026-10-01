import type { StaffingAdInput, StaffingTextInput } from "@/modules/ai/provider";
import type { StaffingAd, StaffingTextProposal } from "@/modules/ai/schemas";

/**
 * Regelbasierte Entwürfe der Besetzung (Etappe 28): dienen dem deterministischen Testanbieter und als Ersatzweg bei
 * deaktivierter KI. Erfinden nichts – jede Zeile stammt aus den Eingabefeldern.
 */

const lines = (s: string) =>
  s
    .split(/\r?\n|;|•|^\s*[-–*]\s+/m)
    .map((x) => x.replace(/^\s*[-–*•]\s*/, "").trim())
    .filter((x) => x.length > 1);

export function ruleBasedStaffingAd(i: StaffingAdInput): StaffingAd {
  const missing: string[] = [];
  const conditions: string[] = [];
  if (i.desiredStart) conditions.push(`Start: ${i.desiredStart}`);
  else missing.push("gewünschter Start");
  if (i.plannedEnd) conditions.push(`Ende: ${i.plannedEnd}`);
  else conditions.push("Laufzeit: offen");
  if (i.scope) conditions.push(`Umfang: ${i.scope}`);
  else missing.push("Umfang (Tage/Stunden pro Woche)");
  if (i.location) conditions.push(`Einsatzort/Remote: ${i.location}`);
  else missing.push("Einsatzort bzw. Remote-Anteil");
  if (i.language) conditions.push(`Sprache: ${i.language}`);
  if (!i.mustHave.trim()) missing.push("Muss-Anforderungen");
  if (!i.tasks.trim()) missing.push("Aufgabenbeschreibung");
  const who = i.releasedInfo.trim() ? `Für ${i.releasedInfo.trim()}` : i.channel === "INTERN" ? "Für einen Kundeneinsatz" : "Für unseren Kunden";
  const intro = i.tone === "ANSPRECHEND" ? `${who} suchen wir eine erfahrene Person als ${i.title}. Es erwartet dich ein klar umrissener Einsatz mit direktem Draht zum Fachbereich.` : `${who} suchen wir: ${i.title}.`;
  return {
    title: i.channel === "INTERN" ? `[intern] ${i.title}` : i.title,
    intro,
    tasks: lines(i.tasks),
    must: lines(i.mustHave),
    nice: lines(i.niceToHave),
    conditions,
    missing,
  };
}

const MONTHS: Record<string, string> = { januar: "01", februar: "02", maerz: "03", märz: "03", april: "04", mai: "05", juni: "06", juli: "07", august: "08", september: "09", oktober: "10", november: "11", dezember: "12" };

function isoFrom(text: string): { iso: string; hint: string } {
  const m1 = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (m1) return { iso: `${m1[3]}-${m1[2]!.padStart(2, "0")}-${m1[1]!.padStart(2, "0")}`, hint: m1[0] };
  const m2 = text.match(/\b(?:ab|zum|am)\s+(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})?/);
  if (m2 && MONTHS[m2[2]!.toLowerCase()]) return { iso: m2[3] ? `${m2[3]}-${MONTHS[m2[2]!.toLowerCase()]}-${m2[1]!.padStart(2, "0")}` : "", hint: m2[0] };
  const m3 = text.match(/\b(?:ab|zum)\s+([A-Za-zäöüÄÖÜ]+)\s+(\d{4})/);
  if (m3 && MONTHS[m3[1]!.toLowerCase()]) return { iso: `${m3[2]}-${MONTHS[m3[1]!.toLowerCase()]}-01`, hint: m3[0] };
  const m4 = text.match(/\b(?:ab|zum|start)\s+(sofort|q[1-4]\s*\d{4}|kw\s*\d{1,2})/i);
  if (m4) return { iso: "", hint: m4[0] };
  return { iso: "", hint: "" };
}

/** Deterministische Extraktion: Rollen mit Anzahl („2 Java-Entwickler“, „einen Testmanager“), Umfang, Ort, Sprache, Start. */
export function ruleBasedStaffingText(i: StaffingTextInput): StaffingTextProposal {
  const text = i.text.replace(/\r/g, "");
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const NUM: Record<string, number> = { ein: 1, eine: 1, einen: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6 };
  const ROLE = /\b(?:(\d{1,2}|ein|eine|einen|zwei|drei|vier|fünf|sechs)\s+)?((?:[A-ZÄÖÜ][\wäöüß+#./-]*(?:[- ](?:[A-ZÄÖÜ][\wäöüß+#./-]*|und))*\s+)?(?:Entwickler(?:in|innen)?|Developer|Engineer|Architekt(?:in|innen)?|Architect|Tester(?:in|innen)?|Testmanager(?:in|innen)?|Test Manager|Projektleiter(?:in|innen)?|Projektmanager(?:in|innen)?|Project Manager|Scrum Master|Product Owner|Business Analyst(?:in|innen)?|Analyst(?:in|innen)?|Berater(?:in|innen)?|Consultant|Data Scientist|DevOps|Administrator(?:in|innen)?|Designer(?:in|innen)?))\b/g;
  const found: { count: number; title: string; quote: string }[] = [];
  for (const s of sentences) {
    for (const m of s.matchAll(ROLE)) {
      const n = m[1] ? NUM[m[1].toLowerCase()] ?? Number(m[1]) : 1;
      const title = m[2]!.replace(/\s+/g, " ").trim();
      if (title.length < 4) continue;
      if (found.some((f) => f.title.toLowerCase() === title.toLowerCase())) continue;
      found.push({ count: Number.isFinite(n) && n > 0 ? Math.min(n, 12) : 1, title, quote: s.slice(0, 300) });
    }
  }
  const scope = text.match(/\b(\d{1,2})\s*(Tage|Tag)\s*(?:pro|\/|je)\s*Woche|\b(\d{1,3})\s*%|\b(\d{1,2})\s*(?:h|Stunden)\s*(?:pro|\/|je)\s*Woche|\bVollzeit\b|\bTeilzeit\b/i)?.[0] ?? "";
  const location = text.match(/\b(?:\d{1,3}\s*%\s*)?(?:remote|vor Ort|hybrid|onsite)\b[^.;\n]{0,60}/i)?.[0]?.trim() ?? text.match(/\b(?:in|Standort)\s+([A-ZÄÖÜ][a-zäöüß]+(?:\s[A-ZÄÖÜ][a-zäöüß]+)?)/)?.[0] ?? "";
  const language = text.match(/\b(Deutsch|Englisch|German|English)(?:\s*(?:und|\/|,)\s*(Deutsch|Englisch|German|English))?\b[^.;\n]{0,30}/i)?.[0]?.trim() ?? "";
  const start = isoFrom(text);
  const end = text.match(/\b(?:bis|Ende|Laufzeit)\s+([^.;\n]{3,40})/i);
  const rate = text.match(/\b(?:\d{2,4}\s*(?:€|EUR|Euro)\s*(?:\/|pro|je)?\s*(?:Tag|Stunde|h|PT)?|Tagessatz[^.;\n]{0,40}|Budget[^.;\n]{0,40})/i)?.[0] ?? "";
  // Teilsätze getrennt einordnen, damit „X ist zwingend, Y wäre wünschenswert“ nicht doppelt landet
  const clauses = sentences.flatMap((s) => s.split(/[,;]\s+(?=[A-ZÄÖÜa-zäöü])/).map((c) => c.trim()).filter((c) => c.length > 3));
  const NICE = /\b(wünschenswert|idealerweise|von vorteil|nice to have|ein plus|wäre(n)? (gut|schön|hilfreich))\b/i;
  const MUST = /\b(muss|zwingend|erforderlich|voraussetzung|mindestens|erfahrung in|kenntnisse in|pflicht)\b/i;
  const nice = clauses.filter((c) => NICE.test(c)).join("\n");
  const must = clauses.filter((c) => MUST.test(c) && !NICE.test(c)).join("\n");
  const tasks = sentences.filter((s) => /\b(aufgabe|verantwort|soll|unterstütz|übernimmt|baut|entwickelt|betreut|leitet)\b/i.test(s) && !/\bmuss\b/i.test(s)).slice(0, 6).join("\n");
  const positions: StaffingTextProposal["positions"] = [];
  for (const f of found) {
    for (let k = 0; k < f.count; k++) {
      positions.push({ title: f.title, tasks, mustHave: must, niceToHave: nice, location, language, desiredStart: start.iso, startHint: start.hint, plannedEnd: "", endHint: end?.[1]?.trim() ?? "", scopeText: scope, rateHint: rate, evidenceQuote: f.quote });
    }
  }
  const missing: string[] = [];
  if (!positions.length) missing.push("Welche Rolle(n) sollen besetzt werden? Im Text wurde keine erkannt.");
  if (!start.iso) missing.push("Gewünschter Start (Datum)?");
  if (!scope) missing.push("Umfang (Tage/Stunden pro Woche)?");
  if (!must) missing.push("Muss-Anforderungen?");
  return { positions: positions.slice(0, 12), missing, summary: positions.length ? `${positions.length} Position(en) aus ${found.length} erkannten Rolle(n) für „${i.opportunityTitle}“ (${i.accountName}).` : "Keine Rolle erkannt – bitte manuell anlegen." };
}
