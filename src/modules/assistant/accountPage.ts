import type { AssistantItem } from "@/modules/ai/schemas";

/**
 * Deterministische Auswertung einer eingefügten Account-Seite (z. B. aus Notion) – Etappe 26.
 * Genutzt vom Testanbieter und als Referenz für das Sprachmodell: Jede Karte zitiert eine Zeile wörtlich.
 * Erkannt werden Kundenagenda (Prioritäten, Schlüssel-Initiativen, Herausforderungen), Stakeholder-Tabelle,
 * Vermittler, Einsatzende, Risiken (z. B. Nachbarteam), Kurzangebots-Ideen mit Hebel, Verve-Team und SOS.
 * Umsatz-/Revenue-Abschnitte und leere Vorlagenfelder werden bewusst übergangen.
 */

type Section = "PRIORITAET" | "INITIATIVE" | "HERAUSFORDERUNG" | "STAKEHOLDER" | "IDEEN" | "SOS" | "SKIP" | "OTHER";

const clean = (l: string) => l.replace(/\*\*/g, "").replace(/^\s*(?:[-*•⇒→]|—>|->)\s*/, "").replace(/^#+\s*/, "").trim();
const isPlaceholder = (t: string) => !t || /^_+$/.test(t.replace(/[\s|:]/g, "")) || /^leer$/i.test(t);

export function dueHintOf(text: string): string {
  const m =
    /\b(ende|mitte|anfang)\s+(\d{4})\b/i.exec(text) ??
    /\bq[1-4]\s*\/?\s*\d{4}\b/i.exec(text) ??
    /\b(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+\d{4}\b/i.exec(text) ??
    /\b\d{1,2}\.\d{1,2}\.\d{4}\b/.exec(text);
  return m ? m[0] : "";
}

function sectionOf(heading: string): Section | null {
  const h = heading.toLowerCase();
  if (/priorit(ä|ae)ten/.test(h)) return "PRIORITAET";
  if (/schl(ü|ue)ssel[- ]?init/.test(h) || /initiativen/.test(h)) return "INITIATIVE";
  if (/herausforderung|problembereich/.test(h)) return "HERAUSFORDERUNG";
  if (/stakeholder/.test(h)) return "STAKEHOLDER";
  if (/ideen f(ü|ue)r kurzangebote|kurzangebot/.test(h)) return "IDEEN";
  if (/^sos/.test(h)) return "SOS";
  if (/revenue|umsatz|action plan/.test(h)) return "SKIP";
  return null;
}

const DECISION: Record<string, "BEDARFSTRAEGER" | "BUDGETVERANTWORTUNG" | "UNTERSTUETZER_SPONSOR" | "EINKAUF_VERTRAGSWEG" | "FACHLICHE_BEWERTUNG"> = {
  operativ: "BEDARFSTRAEGER",
  budgetnah: "BUDGETVERANTWORTUNG",
  budget: "BUDGETVERANTWORTUNG",
  sponsor: "UNTERSTUETZER_SPONSOR",
  einkauf: "EINKAUF_VERTRAGSWEG",
  fachlich: "FACHLICHE_BEWERTUNG",
};

function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ")
    .replace(/oe/g, "ö")
    .replace(/ae/g, "ä")
    .replace(/ue/g, "ü");
}

export function extractAccountPage(text: string, opts: { hasCustomer: boolean }): { items: AssistantItem[]; missing: string[]; recognized: boolean } {
  const lines = text.split(/\r?\n/);
  const items: AssistantItem[] = [];
  const missing: string[] = [];
  let section: Section = "OTHER";
  let recognizedSections = 0;
  type AgendaItem = { kind: "PRIORITAET" | "INITIATIVE" | "HERAUSFORDERUNG"; title: string; quote: string; desc: string[] };
  type Idea = { title: string; quote: string; rationale: string[]; lever: string | null };
  let current = null as AgendaItem | null;
  const agenda: AgendaItem[] = [];
  let idea = null as Idea | null;
  const ideas: Idea[] = [];
  const team = { bdName: "", ankerNames: [] as string[], principalName: "", consultantName: "", quote: "" };
  let endQuote = "";
  let plannedEnd = "";
  let endHint = "";
  let pendingEndHeading = false;
  let customerName = "";
  let lastArt = "";

  const flushAgenda = () => {
    if (current) agenda.push(current);
    current = null;
  };
  const flushIdea = () => {
    if (idea) ideas.push(idea);
    idea = null;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    const line = raw.trimEnd();
    if (!line.trim() || /^-{3,}$/.test(line.trim())) continue;
    const indent = raw.length - raw.trimStart().length;
    const t = clean(line);

    // Kopf: „# Deutsche Bahn“ oder „Kunde: …“
    if (!customerName && /^#\s+\S/.test(line.trim()) && !sectionOf(t) && !/overview|wachstum|key facts/i.test(t)) customerName = t;
    const km = /^kunde\s*:\s*(.+)$/i.exec(t);
    if (km && !customerName) customerName = km[1]!.trim();

    // Überschriften und fette Zwischenzeilen wechseln den Abschnitt
    const isHeading = /^#{1,6}\s/.test(line.trim()) || /^\*\*[^*]+\*\*:?\s*$/.test(line.trim());
    if (isHeading) {
      const sec = sectionOf(t);
      pendingEndHeading = /ablauf projekte/i.test(t) && !dueHintOf(t);
      if (/ablauf projekte/i.test(t) && dueHintOf(t)) {
        endHint = dueHintOf(t);
        endQuote ||= t;
      }
      if (sec) {
        flushAgenda();
        flushIdea();
        section = sec;
        recognizedSections++;
        continue;
      }
      if (/key facts|einkauf|beschaffung|account wachstum|business overview/i.test(t)) {
        flushAgenda();
        flushIdea();
        section = "OTHER";
        continue;
      }
    }

    if (pendingEndHeading && dueHintOf(t)) {
      endHint = dueHintOf(t);
      endQuote ||= t;
      pendingEndHeading = false;
      continue;
    }

    // Team-Eigenschaften (Notion-Properties): „Account-Anker  Ferdinand Henze“, „Bussiness Development: …“
    const tm = /^(principal[\w .…-]*|bus+iness develop[\w .…-]*|business development|account[- ]anker|anker|operative[\w .…-]*berater[\w .…-]*)\s*[:\t]\s*(.+)$/i.exec(t) ?? /^(principal[\w.…-]*|bus+iness develo[\w.…-]*|account-anker|operative berater[\w.…-]*)\s{2,}(.+)$/i.exec(t);
    if (tm && !isPlaceholder(tm[2]!.trim())) {
      const role = tm[1]!.toLowerCase();
      const name = tm[2]!.trim();
      if (role.startsWith("principal")) team.principalName = name;
      else if (role.startsWith("bus") || role === "bd") team.bdName = name;
      else if (role.includes("anker")) team.ankerNames.push(name);
      else if (role.includes("berater")) team.consultantName = name;
      team.quote ||= t;
      continue;
    }

    // Vermittler / Beschaffung
    const vm = /^vermittler\s*:\s*(.+)$/i.exec(t);
    if (vm && !isPlaceholder(vm[1]!.trim())) {
      items.push({ type: "BESCHAFFUNG", channel: "VERMITTLER", intermediaryName: vm[1]!.trim(), note: "", evidenceQuote: t });
      continue;
    }
    if (/^rahmenvertrag\s*:/i.test(t)) {
      items.push({ type: "BESCHAFFUNG", channel: "RAHMENVERTRAG", intermediaryName: t.split(":")[1]?.trim() ?? "", note: "", evidenceQuote: t });
      continue;
    }

    // Einsatzende
    const em = /^(enddatum|vertragsende|einsatzende|laufzeit bis)\s*:\s*(.+)$/i.exec(t);
    if (em) {
      const d = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(em[2]!);
      if (d) plannedEnd = `${d[3]}-${d[2]!.padStart(2, "0")}-${d[1]!.padStart(2, "0")}`;
      else endHint = dueHintOf(em[2]!) || em[2]!.trim();
      endQuote = t;
      continue;
    }

    // Risiken aus dem Text
    if (/positionier\w*\s+sich\s+gegen|stell\w*\s+sich\s+quer|blockier\w*\s+änderungen|gegen änderungen/i.test(t)) {
      items.push({ type: "RISIKO", risk: "NACHBARTEAM", note: t, evidenceQuote: t });
    } else if (/wettbewerber|konkurrenz\s+(ist|im)/i.test(t)) items.push({ type: "RISIKO", risk: "WETTBEWERBER", note: t, evidenceQuote: t });
    else if (/sparprogramm|budgetk(ü|ue)rzung/i.test(t)) items.push({ type: "RISIKO", risk: "BUDGETKUERZUNG", note: t, evidenceQuote: t });

    if (section === "SKIP") continue;

    if (section === "PRIORITAET" || section === "INITIATIVE" || section === "HERAUSFORDERUNG") {
      if (indent < 2 && (/^\s*[-*•⇒]/.test(raw) || !/^\s/.test(raw))) {
        flushAgenda();
        if (t.length >= 3) current = { kind: section, title: t, quote: t, desc: [] };
      } else if (current) current.desc.push(t);
      continue;
    }

    if (section === "STAKEHOLDER" && t.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.replace(/\*\*/g, "").trim());
      if (cells.every((c) => /^-*$/.test(c)) || /ansprechpartner/i.test(cells.join(" "))) continue;
      const [artCell = "", name = "", position = "", email = "", phone = ""] = cells;
      const art = artCell || lastArt; // Folgezeilen ohne „Art“ gehören zur vorherigen Gruppe
      if (artCell) lastArt = artCell;
      const role = DECISION[art.toLowerCase().split(/[\s/]/)[0] ?? ""] ?? null;
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      const displayName = name || (emailOk ? nameFromEmail(email) : "");
      if (!displayName) {
        if (art && role) missing.push(`Wer ist beim Kunden ${art.toLowerCase()} (${role === "BUDGETVERANTWORTUNG" ? "Budgetverantwortung" : art})?`);
        continue;
      }
      const quote = name || email;
      items.push({ type: "PERSON", displayName, functionTitle: position, email: emailOk ? email : "", phone, knownResponsibility: art ? `Stakeholder: ${art}` : "", decisionRole: role, stance: "UNBEKANNT", influence: "UNBEKANNT", assessmentNote: name ? "" : "Name aus der E-Mail-Adresse abgeleitet – bitte prüfen.", evidenceQuote: quote });
      continue;
    }

    if (section === "IDEEN") {
      const im = /^\d+\)\s*idee\s*:\s*(.*)$/i.exec(t);
      if (im) {
        flushIdea();
        const title = im[1]!.trim();
        if (!isPlaceholder(title)) idea = { title, quote: title, rationale: [], lever: null };
        continue;
      }
      const lm = /^\*?hebel\s*:?\*?\s*:?\s*(.+)$/i.exec(t.replace(/\*/g, ""));
      if (lm && idea) {
        const v = lm[1]!.trim();
        if (!v.includes("/")) {
          const k = v.toLowerCase();
          idea.lever = k.startsWith("verl") ? "VERLAENGERN" : k.startsWith("ausw") ? "AUSWEITEN" : k.startsWith("vert") ? "VERTIEFEN" : k.startsWith("übert") || k.startsWith("uebert") ? "UEBERTRAGEN" : null;
        }
        continue;
      }
      if (/^(nächster schritt|naechster schritt|datum|owner)/i.test(t)) continue;
      if (idea && t.length >= 3) idea.rationale.push(t);
      continue;
    }

    if (section === "SOS" && /^\s*[-*•]/.test(raw) && t.length >= 10) {
      const kind = /l(ä|ae)uft aus|auslauf|verl(ä|ae)ngerung/i.test(t) ? "EINSATZ_LAEUFT_AUS" : /anker|komme?n? nicht weiter|kein zugang/i.test(t) ? "ANKER_BLOCKIERT" : "LAGE_ENG";
      items.push({ type: "SOS", kind, title: t.slice(0, 120), situation: t, need: "", evidenceQuote: t });
    }
  }
  flushAgenda();
  flushIdea();

  const out: AssistantItem[] = [];
  if (!opts.hasCustomer && customerName) out.push({ type: "KUNDE", name: customerName, orgType: "KONZERN", setupName: `${customerName} – Account`.slice(0, 200), contextNote: "Aus einer eingefügten Account-Seite angelegt.", evidenceQuote: customerName });
  if (team.quote) out.push({ type: "TEAM", bdName: team.bdName, ankerNames: team.ankerNames.slice(0, 5), principalName: team.principalName, consultantName: team.consultantName, evidenceQuote: team.quote });
  for (const a of agenda) out.push({ type: "INITIATIVE", kind: a.kind, title: a.title.slice(0, 300), description: a.desc.join("\n").slice(0, 2000), dueHint: dueHintOf([a.title, ...a.desc].join(" ")), evidenceQuote: a.quote.slice(0, 500) });
  out.push(...items.filter((i) => i.type === "PERSON"));
  out.push(...items.filter((i) => i.type === "BESCHAFFUNG"));
  if (endQuote) out.push({ type: "EINSATZ", title: "Laufender Einsatz", kind: "VERVE_EXPERTE", plannedEnd, endHint: plannedEnd ? "" : endHint, consultantName: team.consultantName, evidenceQuote: endQuote });
  for (const i of ideas) {
    const rationale = i.rationale.join(" ").slice(0, 1000);
    if (i.lever) out.push({ type: "HEBEL", lever: i.lever as "AUSWEITEN", title: i.title.slice(0, 300), rationale, evidenceQuote: i.quote });
    const need = `${i.title}${rationale ? ` – ${rationale}` : ""}`;
    if (need.length >= 10) out.push({ type: "CHANCE", title: i.title.slice(0, 200), needDescription: need.slice(0, 4000), kind: "VERVE_EXPERTE", roleName: "", headcount: null, horizon: "", anticipated: true, evidenceQuote: i.quote });
  }
  out.push(...items.filter((i) => i.type === "RISIKO" || i.type === "SOS"));
  if (!opts.hasCustomer && !customerName) missing.unshift("Um welchen Kunden geht es? (Name, damit ich die Karte „Kunde“ vorschlagen kann)");
  return { items: out.slice(0, 30), missing: [...new Set(missing)].slice(0, 8), recognized: recognizedSections >= 2 || (recognizedSections >= 1 && out.length >= 3) };
}
