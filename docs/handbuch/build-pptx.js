/* eslint-disable */
// Erzeugt das Foliendeck als PowerPoint-Datei: node docs/handbuch/build-pptx.js
const path = require("node:path");
const pptxgen = require("pptxgenjs");
const { BRAND, APP_URL } = require("./content.js");

const NAVY = BRAND.navy; // 161927
const GREEN = BRAND.green; // 55BF36
const INK = BRAND.ink; // 1F2937
const MUTED = BRAND.muted; // 6B7280
const LIGHT = BRAND.light; // F3F6F4
const WHITE = BRAND.white; // FFFFFF

const FONT = "Calibri";
const HEAD = "Calibri";

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5"
pres.defineLayout({ name: "LAYOUT_WIDE", width: 13.33, height: 7.5 });
pres.layout = "LAYOUT_WIDE";

const W = 13.33;
const H = 7.5;
const MX = 0.6; // Rand

function newSlide(bg) {
  const s = pres.addSlide();
  s.background = { color: bg || WHITE };
  return s;
}

function footer(s, dark) {
  s.addText(`Accountmeister · Anwenderhandbuch für BDs und Principals`, {
    x: MX, y: H - 0.42, w: 8, h: 0.3, fontFace: FONT, fontSize: 9, color: dark ? "9AA3B2" : MUTED, isTextBox: true, margin: 0,
  });
  s.addText(`fiktive Beispiele`, {
    x: W - MX - 3.0, y: H - 0.42, w: 1.9, h: 0.3, fontFace: FONT, fontSize: 9, color: dark ? "9AA3B2" : MUTED, align: "right", isTextBox: true, margin: 0,
  });
}

function kicker(s, text, dark) {
  s.addText(text.toUpperCase(), {
    x: MX, y: 0.42, w: 10, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: dark ? GREEN : GREEN, charSpacing: 2, isTextBox: true, margin: 0,
  });
}

function title(s, text, opts = {}) {
  s.addText(text, {
    x: MX, y: opts.y ?? 0.72, w: opts.w ?? 11.8, h: opts.h ?? 0.8, fontFace: HEAD, fontSize: opts.size ?? 32, bold: true, color: opts.color ?? NAVY, isTextBox: true, margin: 0,
  });
}

function lead(s, text, y) {
  s.addText(text, {
    x: MX, y: y ?? 1.5, w: 11.6, h: 0.9, fontFace: FONT, fontSize: 15, italic: true, color: NAVY, isTextBox: true, margin: 0, lineSpacingMultiple: 1.15,
  });
}

function pageNo(s, n) {
  s.addText(String(n), { x: W - MX - 0.5, y: H - 0.42, w: 0.5, h: 0.3, fontFace: FONT, fontSize: 9, color: MUTED, align: "right", isTextBox: true, margin: 0 });
}

// ---------- Folie 1: Titel ----------
{
  const s = newSlide(NAVY);
  s.addShape("ellipse", { x: 10.2, y: -2.4, w: 6.5, h: 6.5, fill: { color: "1E2233" }, line: { type: "none" } });
  s.addShape("ellipse", { x: 11.6, y: 4.6, w: 3.6, h: 3.6, fill: { color: GREEN, transparency: 88 }, line: { type: "none" } });
  s.addText("VERVE AI", { x: MX, y: 0.75, w: 4, h: 0.5, fontFace: HEAD, fontSize: 18, bold: true, color: GREEN, charSpacing: 3, isTextBox: true, margin: 0 });
  s.addText("Accountmeister", { x: MX, y: 2.75, w: 11, h: 1.3, fontFace: HEAD, fontSize: 54, bold: true, color: WHITE, isTextBox: true, margin: 0 });
  s.addText("Anwenderhandbuch für BDs und Principals", { x: MX, y: 3.95, w: 10.5, h: 0.7, fontFace: FONT, fontSize: 22, color: "CBD3E1", isTextBox: true, margin: 0 });
  s.addText("Wie wir aus Gesprächen, Notizen und Dokumenten den Weg zur Vermittlung finden – und nichts vergessen, was dafür noch fehlt.", {
    x: MX, y: 4.75, w: 8.6, h: 0.9, fontFace: FONT, fontSize: 14, italic: true, color: "9AA3B2", isTextBox: true, margin: 0, lineSpacingMultiple: 1.2,
  });
  s.addShape("line", { x: MX, y: 6.35, w: 1.1, h: 0, line: { color: GREEN, width: 2.5 } });
  s.addText(`Stand: September 2026  ·  Verve Consulting  ·  intern  ·  ${APP_URL}`, {
    x: MX, y: 6.5, w: 10, h: 0.4, fontFace: FONT, fontSize: 11, color: "9AA3B2", isTextBox: true, margin: 0,
  });
  s.addText("Alle Beispiele in diesem Handbuch sind fiktiv.", {
    x: MX, y: 6.85, w: 10, h: 0.35, fontFace: FONT, fontSize: 10, color: "6E7893", isTextBox: true, margin: 0,
  });
}

// ---------- Folie 2: Worum es geht ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Das Grundprinzip");
  title(s, "Alles ordnet sich der Frage „Wofür?“ unter");
  lead(s, "Das Ergebnis unserer Vertriebsarbeit ist eine Vermittlung – im Tool „Chance“ genannt. Beobachtungen, Personen, Fragen und Aktionen dienen immer einer Chance.", 1.55);

  // Diagramm: zentrale Chance mit vier zulaufenden Elementen
  const cx = 9.6, cy = 4.55, cr = 1.05;
  s.addShape("ellipse", { x: cx - cr, y: cy - cr, w: cr * 2, h: cr * 2, fill: { color: NAVY }, line: { type: "none" } });
  s.addText("Wofür?\nChance", { x: cx - cr, y: cy - 0.42, w: cr * 2, h: 0.84, fontFace: HEAD, fontSize: 15, bold: true, color: WHITE, align: "center", isTextBox: true, margin: 0 });

  const satellites = [
    { label: "Beobachtungen", x: 6.7, y: 2.75 },
    { label: "Personen", x: 12.05, y: 2.75 },
    { label: "Fragen", x: 6.7, y: 6.05 },
    { label: "Aktionen", x: 12.05, y: 6.05 },
  ];
  for (const sat of satellites) {
    s.addShape("line", { x: Math.min(sat.x, cx) + 0.55, y: Math.min(sat.y, cy) + 0.4, w: Math.abs(sat.x - cx) - 1.1, h: Math.abs(sat.y - cy) - 0.8, line: { color: "C9D6C7", width: 1.25, dashType: "dash" } });
  }
  for (const sat of satellites) {
    s.addShape("ellipse", { x: sat.x - 0.62, y: sat.y - 0.42, w: 1.24, h: 0.84, fill: { color: LIGHT }, line: { color: GREEN, width: 1.5 } });
    s.addText(sat.label, { x: sat.x - 0.62, y: sat.y - 0.42, w: 1.24, h: 0.84, fontFace: FONT, fontSize: 11, bold: true, color: NAVY, align: "center", valign: "middle", isTextBox: true, margin: 0 });
  }

  s.addShape("roundRect", { x: MX, y: 5.0, w: 5.5, h: 1.75, rectRadius: 0.08, fill: { color: LIGHT }, line: { type: "none" } });
  s.addText([
    { text: "Nur dokumentiert, nie geschätzt.  ", options: { bold: true, color: NAVY } },
    { text: "Keine Umsätze, keine Wahrscheinlichkeiten, kein Forecast. Die KI ist Sparringspartner und Erfasser, kein Entscheider – nichts entsteht ohne Klick.", options: { color: INK } },
  ], { x: MX + 0.25, y: 5.18, w: 5.0, h: 1.4, fontFace: FONT, fontSize: 12.5, isTextBox: true, margin: 0, lineSpacingMultiple: 1.2, valign: "top" });

  footer(s); pageNo(s, 2);
}

// ---------- Folie 3: Die Begriffe ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Vokabular");
  title(s, "Sieben Begriffe reichen für die tägliche Arbeit");

  const terms = [
    ["Kunde", "Die Organisation, mit der wir arbeiten oder arbeiten wollen."],
    ["Setup", "Ein Arbeitszusammenhang beim Kunden: Team, Bereich oder Vorhaben."],
    ["Chance", "Worauf es hinausläuft – mit Rolle, Anzahl, Horizont und Reifegrad."],
    ["Person / Buyingcenter", "Ansprechpartner mit Funktion, Beziehungsstand und Einschätzung."],
    ["Beobachtung", "Ein Sachverhalt aus Gespräch oder Dokument, immer mit Quelle."],
    ["Aktion / Frage", "Was wir als Nächstes tun oder klären – mit Termin und Wofür."],
    ["Weekly", "Der bestätigte Wochenstand je Setup – Grundlage für alles Weitere."],
  ];
  const cols = 2, cardW = 5.75, gapX = 0.3, cardH = 1.05, gapY = 0.18, startY = 1.55;
  terms.forEach((t, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = MX + col * (cardW + gapX);
    const y = startY + row * (cardH + gapY);
    s.addShape("roundRect", { x, y, w: cardW, h: cardH, rectRadius: 0.07, fill: { color: LIGHT }, line: { type: "none" } });
    s.addShape("ellipse", { x: x + 0.22, y: y + cardH / 2 - 0.09, w: 0.18, h: 0.18, fill: { color: GREEN }, line: { type: "none" } });
    s.addText(t[0], { x: x + 0.55, y: y + 0.1, w: cardW - 0.75, h: 0.32, fontFace: HEAD, fontSize: 13, bold: true, color: NAVY, isTextBox: true, margin: 0 });
    s.addText(t[1], { x: x + 0.55, y: y + 0.42, w: cardW - 0.75, h: cardH - 0.5, fontFace: FONT, fontSize: 10.5, color: INK, isTextBox: true, margin: 0, lineSpacingMultiple: 1.05 });
  });
  s.addText("Rollen im Tool: BD (operativ für Kunden/Setups) · Anker (Projektkontext aus laufenden Einsätzen) · Principal (Portfolio, Unterstützungsaufträge) · CEO (Gesamtbild ohne Rohquellen).", {
    x: MX, y: startY + 4 * (cardH + gapY) + 0.05, w: 11.9, h: 0.5, fontFace: FONT, fontSize: 11, italic: true, color: MUTED, isTextBox: true, margin: 0,
  });
  footer(s); pageNo(s, 3);
}

// ---------- Folie 4: Einstieg ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Einstieg");
  title(s, "Anmeldung und Startseite");
  lead(s, "Anmelden mit dem Microsoft-365-Konto – danach landet ihr auf „Start“, dem Dashboard eurer Rolle.", 1.55);

  s.addText([
    { text: "Sicht wählen, keine Rechteänderung.  ", options: { bold: true, color: NAVY } },
    { text: "Wer mehrere Rollen hat, wählt oben die Sicht – BD, Anker oder Principal. Angeboten werden nur Rollen, die euch zugewiesen sind.", options: { color: INK } },
  ], { x: MX, y: 2.55, w: 5.9, h: 1.3, fontFace: FONT, fontSize: 13, isTextBox: true, margin: 0, lineSpacingMultiple: 1.2 });

  s.addText([
    { text: "„Diese Woche dran“.  ", options: { bold: true, color: NAVY } },
    { text: "Überfällige und bis Wochenende fällige Aktionen, Übergaben, adressierte Vorschläge, Unterstützungsaufträge und anstehende Weeklys. Überfälliges rot, Heutiges fett.", options: { color: INK } },
  ], { x: MX, y: 4.1, w: 5.9, h: 1.5, fontFace: FONT, fontSize: 13, isTextBox: true, margin: 0, lineSpacingMultiple: 1.2 });

  // Kundenkarten-Mockup rechts
  const kx = 7.05, ky = 2.35, kw = 5.7, kh = 4.05;
  s.addShape("roundRect", { x: kx, y: ky, w: kw, h: kh, rectRadius: 0.08, fill: { color: NAVY }, line: { type: "none" } });
  s.addText("Kundenkarte", { x: kx + 0.35, y: ky + 0.25, w: kw - 0.7, h: 0.4, fontFace: HEAD, fontSize: 14, bold: true, color: GREEN, isTextBox: true, margin: 0 });
  s.addText("Musterwerke GmbH", { x: kx + 0.35, y: ky + 0.62, w: kw - 0.7, h: 0.4, fontFace: HEAD, fontSize: 18, bold: true, color: WHITE, isTextBox: true, margin: 0 });
  const rows4 = [
    ["Wofür", "2× Test Management, Q1 2027 (antizipiert)"],
    ["Stufe", "Kontakt & Kontext → Einsatz gestartet"],
    ["Blockiert", "1 überfällige Aktion"],
    ["Was fehlt", "Keine Entscheidungsrolle „Einkauf“ besetzt"],
    ["Naheliegende Züge", "2 offene Vorschläge aus dem letzten Weekly"],
  ];
  let ry = ky + 1.2;
  for (const [k, v] of rows4) {
    s.addText(k, { x: kx + 0.35, y: ry, w: 1.7, h: 0.55, fontFace: FONT, fontSize: 10.5, bold: true, color: "9AA3B2", isTextBox: true, margin: 0 });
    s.addText(v, { x: kx + 2.05, y: ry, w: kw - 2.4, h: 0.55, fontFace: FONT, fontSize: 10.5, color: WHITE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.05 });
    ry += 0.57;
  }
  footer(s); pageNo(s, 4);
}

// ---------- Folie 5: Der Assistent ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Der Assistent");
  title(s, "Der Dialog, der mitdenkt, Karten vorschlägt und fragt, was fehlt");
  lead(s, "Er kennt den Kontext der Seite – ein Setup, einen Kunden oder allgemein – und eröffnet mit den offenen Punkten.", 1.55);

  const cards5 = ["Kunde", "Setup", "Person", "Chance", "Beobachtung", "Aktion", "Kontaktaufnahme", "Frage"];
  const cw = 2.72, ch = 0.85, gx = 0.18, startX5 = MX, startY5 = 2.55;
  cards5.forEach((c, i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const x = startX5 + col * (cw + gx);
    const y = startY5 + row * (ch + 0.22);
    s.addShape("roundRect", { x, y, w: cw, h: ch, rectRadius: 0.09, fill: { color: LIGHT }, line: { color: GREEN, width: 1 } });
    s.addText(c, { x, y, w: cw, h: ch, fontFace: HEAD, fontSize: 13, bold: true, color: NAVY, align: "center", valign: "middle", isTextBox: true, margin: 0 });
  });
  s.addText("Jede Karte trägt die wörtliche Textstelle, auf die sie sich stützt, und das Wofür.", {
    x: MX, y: startY5 + 2 * (ch + 0.22) + 0.05, w: 11.8, h: 0.4, fontFace: FONT, fontSize: 12, italic: true, color: MUTED, isTextBox: true, margin: 0,
  });

  s.addShape("roundRect", { x: MX, y: 5.55, w: 11.8, h: 1.15, rectRadius: 0.08, fill: { color: NAVY }, line: { type: "none" } });
  s.addText([
    { text: "Der Assistent legt nichts selbst an.  ", options: { bold: true, color: GREEN } },
    { text: "Übernehmen legt an, Verwerfen verwirft. Schreibt er „ich habe angelegt“, ist das falsch – und das Tool weist darauf hin.", options: { color: WHITE } },
  ], { x: MX + 0.3, y: 5.55, w: 11.2, h: 1.15, fontFace: FONT, fontSize: 13, isTextBox: true, margin: 0, valign: "middle", lineSpacingMultiple: 1.2 });
  footer(s); pageNo(s, 5);
}

// ---------- Folie 6: Kunde, Setup, Chance anlegen ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Anlegen");
  title(s, "Drei Wege zum Kunden – ein Formular für die Chance");
  lead(s, "Immer die Frage: Wofür? Personen, Beobachtungen und Chancen kommen als Vorschläge dazu.", 1.55);

  const steps6 = [
    ["1", "Kunde", "Mit dem Assistenten (Dialog/Interview), aus einem Dokument oder von Hand. Anlegen dürfen BD und Principal."],
    ["2", "Setup", "Verständlicher Name + Kontextsatz „Was läuft hier?“. Sichtbarkeit: Beteiligte, Kundenteam oder Arbeitsraum."],
    ["3", "Chance", "Titel, Art, Standardrolle, Anzahl, Horizont, Anlass. „Antizipiert“ = vermutet, Kunde hat es noch nicht ausgesprochen."],
  ];
  const sw = 3.75, sgap = 0.35, sy = 2.55, sh = 3.0;
  steps6.forEach((st, i) => {
    const x = MX + i * (sw + sgap);
    s.addShape("roundRect", { x, y: sy, w: sw, h: sh, rectRadius: 0.08, fill: { color: i === 2 ? NAVY : LIGHT }, line: { type: "none" } });
    s.addShape("ellipse", { x: x + 0.3, y: sy + 0.3, w: 0.55, h: 0.55, fill: { color: GREEN }, line: { type: "none" } });
    s.addText(st[0], { x: x + 0.3, y: sy + 0.3, w: 0.55, h: 0.55, fontFace: HEAD, fontSize: 18, bold: true, color: WHITE, align: "center", valign: "middle", isTextBox: true, margin: 0 });
    s.addText(st[1], { x: x + 0.3, y: sy + 1.0, w: sw - 0.6, h: 0.45, fontFace: HEAD, fontSize: 17, bold: true, color: i === 2 ? WHITE : NAVY, isTextBox: true, margin: 0 });
    s.addText(st[2], { x: x + 0.3, y: sy + 1.5, w: sw - 0.6, h: sh - 1.7, fontFace: FONT, fontSize: 12, color: i === 2 ? "D8DEE8" : INK, isTextBox: true, margin: 0, lineSpacingMultiple: 1.2 });
    if (i < 2) {
      s.addShape("line", { x: x + sw + 0.03, y: sy + sh / 2, w: sgap - 0.06, h: 0, line: { color: GREEN, width: 2, endArrowType: "triangle" } });
    }
  });
  footer(s); pageNo(s, 6);
}

// ---------- Folie 7: Reifegrade einer Chance ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Reifegrade");
  title(s, "Kritische Übergänge brauchen einen Beleg");
  lead(s, "Eine positive Rückmeldung zu einem Angebot ist noch kein Auftrag.", 1.55);

  const stages = ["antizipiert", "in Klärung", "bestätigt", "im Angebot / Auswahl", "beauftragt", "gestartet"];
  const n = stages.length;
  const lineY = 3.6, x0 = MX + 0.3, x1 = W - MX - 0.3;
  s.addShape("line", { x: x0, y: lineY, w: x1 - x0, h: 0, line: { color: "D9DEDB", width: 3 } });
  stages.forEach((st, i) => {
    const cx = x0 + (i / (n - 1)) * (x1 - x0);
    s.addShape("ellipse", { x: cx - 0.16, y: lineY - 0.16, w: 0.32, h: 0.32, fill: { color: i === n - 1 ? GREEN : NAVY }, line: { color: WHITE, width: 2 } });
    s.addText(st, { x: cx - 0.85, y: lineY + 0.28, w: 1.7, h: 0.7, fontFace: FONT, fontSize: 11, bold: true, color: NAVY, align: "center", isTextBox: true, margin: 0, lineSpacingMultiple: 1.05 });
    s.addText(String(i + 1), { x: cx - 0.85, y: lineY - 0.75, w: 1.7, h: 0.4, fontFace: HEAD, fontSize: 12, color: MUTED, align: "center", isTextBox: true, margin: 0 });
  });

  s.addShape("roundRect", { x: MX, y: 5.0, w: 11.8, h: 1.75, rectRadius: 0.08, fill: { color: LIGHT }, line: { type: "none" } });
  s.addText([
    { text: "Belege je Übergang:  ", options: { bold: true, color: NAVY } },
    { text: "„bestätigt“ eine Quelle oder Belegnotiz · „vorgestellt“ ein tatsächlich vorgestelltes Angebot · „beauftragt“ ein Nachweis · „startbereit“ der bestätigte Stand aller Startvoraussetzungen.", options: { color: INK } },
  ], { x: MX + 0.3, y: 5.2, w: 11.2, h: 1.4, fontFace: FONT, fontSize: 13, isTextBox: true, margin: 0, valign: "middle", lineSpacingMultiple: 1.25 });
  footer(s); pageNo(s, 7);
}

// ---------- Folie 8: Standardrollen ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Standardrollen");
  title(s, "Chancen zeigen auf Rollen aus dem Verve-Katalog");
  lead(s, "So wird das Zielbild zählbar.", 1.55);

  const fam = [
    ["Delivery Management", "Projektleitung · Programmleitung · PMO · Delivery Manager · Governance, RAID, Reporting"],
    ["Agile Leadership", "Scrum Master · Agile Coach · Release Train Engineer · SAFe-, LeSS-, Kanban-Führung"],
    ["Business Analyse & Beratung", "Business Analyst · Requirements Engineer · Fachkonzeption · Prozessberatung"],
    ["Solution & Architektur", "Solution/Enterprise Architect · Cloud-, SAP-, Integrationsarchitektur · API-Design"],
    ["Test & Qualitätssicherung", "Test Management · Test Analyse · QA · Qualitäts- und Abnahmesicherung"],
  ];
  let fy = 2.5;
  fam.forEach((f, i) => {
    const fh = 0.82;
    s.addShape("roundRect", { x: MX, y: fy, w: 11.8, h: fh, rectRadius: 0.06, fill: { color: i % 2 === 0 ? LIGHT : WHITE }, line: i % 2 === 0 ? { type: "none" } : { color: "E5E9E7", width: 0.75 } });
    s.addShape("ellipse", { x: MX + 0.2, y: fy + fh / 2 - 0.16, w: 0.32, h: 0.32, fill: { color: GREEN }, line: { type: "none" } });
    s.addText(String(i + 1), { x: MX + 0.2, y: fy + fh / 2 - 0.16, w: 0.32, h: 0.32, fontFace: HEAD, fontSize: 12, bold: true, color: WHITE, align: "center", valign: "middle", isTextBox: true, margin: 0 });
    s.addText(f[0], { x: MX + 0.7, y: fy + 0.08, w: 3.1, h: fh - 0.16, fontFace: HEAD, fontSize: 12.5, bold: true, color: NAVY, valign: "middle", isTextBox: true, margin: 0 });
    s.addText(f[1], { x: MX + 3.95, y: fy + 0.08, w: 7.65, h: fh - 0.16, fontFace: FONT, fontSize: 11, color: INK, valign: "middle", isTextBox: true, margin: 0, lineSpacingMultiple: 1.05 });
    fy += fh + 0.12;
  });
  s.addText("Fehlt eine Rolle: Betriebsverwaltung ergänzt sie unter Verwaltung → Rollen. Passt nichts, bleibt die Rolle offen – das erscheint als Lücke.", {
    x: MX, y: fy + 0.08, w: 11.8, h: 0.4, fontFace: FONT, fontSize: 11, italic: true, color: MUTED, isTextBox: true, margin: 0,
  });
  footer(s); pageNo(s, 8);
}

// ---------- Folie 9: Personen und Buyingcenter ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Personen & Buyingcenter");
  title(s, "Wer entscheidet, wer bewertet, wer ist auf unserer Seite?");
  lead(s, "Und zu wem fehlt noch der Kontakt?", 1.55);

  s.addText("Einschätzung je Person und Setup (an MEDDPICC angelehnt)", { x: MX, y: 2.35, w: 11.8, h: 0.35, fontFace: HEAD, fontSize: 13, bold: true, color: NAVY, isTextBox: true, margin: 0 });
  const dims = [
    ["Entscheidungsrolle", "Bedarfsträger, fachliche Bewertung, Budget, Einkauf, Freigabe, Unterstützer"],
    ["Haltung zu Verve", "positiv · neutral · kritisch"],
    ["Einfluss", "hoch · mittel · niedrig"],
  ];
  const dw = 3.75, dgap = 0.32;
  dims.forEach((d, i) => {
    const x = MX + i * (dw + dgap);
    s.addShape("roundRect", { x, y: 2.8, w: dw, h: 1.55, rectRadius: 0.07, fill: { color: LIGHT }, line: { type: "none" } });
    s.addText(d[0], { x: x + 0.22, y: 2.95, w: dw - 0.44, h: 0.4, fontFace: HEAD, fontSize: 13, bold: true, color: NAVY, isTextBox: true, margin: 0 });
    s.addText(d[1], { x: x + 0.22, y: 3.35, w: dw - 0.44, h: 0.95, fontFace: FONT, fontSize: 11, color: INK, isTextBox: true, margin: 0, lineSpacingMultiple: 1.15 });
  });

  s.addText("Beziehungsstand", { x: MX, y: 4.7, w: 11.8, h: 0.35, fontFace: HEAD, fontSize: 13, bold: true, color: NAVY, isTextBox: true, margin: 0 });
  const states = ["Name/Funktion bekannt", "Vorstellung angefragt", "vorgestellt", "im Austausch", "konkrete Zusammenarbeit"];
  let sx = MX;
  const sy2 = 5.1, sh2 = 0.55;
  states.forEach((st, i) => {
    const sw2 = st.length * 0.078 + 0.62;
    s.addShape("roundRect", { x: sx, y: sy2, w: sw2, h: sh2, rectRadius: 0.28, fill: { color: i >= 2 ? NAVY : "E5E9E7" }, line: { type: "none" } });
    s.addText(st, { x: sx, y: sy2, w: sw2, h: sh2, fontFace: FONT, fontSize: 9.5, bold: i >= 2, color: i >= 2 ? WHITE : INK, align: "center", valign: "middle", isTextBox: true, margin: 0 });
    sx += sw2 + 0.13;
  });
  s.addText("Ab „vorgestellt“ braucht der Beziehungsstand einen Beleg. Kontaktaufnahmen sind Entwürfe für Menschen – nie automatisch versendet.", {
    x: MX, y: 6.0, w: 11.8, h: 0.5, fontFace: FONT, fontSize: 12, italic: true, color: MUTED, isTextBox: true, margin: 0, lineSpacingMultiple: 1.15,
  });
  footer(s); pageNo(s, 9);
}

// ---------- Folie 10: Weeklys ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Weeklys");
  title(s, "Der Wochenrhythmus je Setup");
  lead(s, "Notiz erfassen, strukturieren lassen, Vorschläge prüfen, Stand bestätigen.", 1.55);

  const flow = ["Notiz erfassen", "Strukturieren lassen", "Vorschläge prüfen", "Stand bestätigen"];
  const fw = 2.72, fgap = 0.25, fy2 = 2.6, fh2 = 1.5;
  flow.forEach((f, i) => {
    const x = MX + i * (fw + fgap);
    s.addShape("roundRect", { x, y: fy2, w: fw, h: fh2, rectRadius: 0.08, fill: { color: i === 3 ? GREEN : NAVY }, line: { type: "none" } });
    s.addText(String(i + 1), { x: x + 0.2, y: fy2 + 0.15, w: 1, h: 0.4, fontFace: HEAD, fontSize: 16, bold: true, color: i === 3 ? NAVY : "8FE070", isTextBox: true, margin: 0 });
    s.addText(f, { x: x + 0.2, y: fy2 + 0.6, w: fw - 0.4, h: 0.8, fontFace: HEAD, fontSize: 13.5, bold: true, color: WHITE, isTextBox: true, margin: 0, lineSpacingMultiple: 1.1 });
    if (i < 3) s.addShape("line", { x: x + fw + 0.02, y: fy2 + fh2 / 2, w: fgap - 0.04, h: 0, line: { color: MUTED, width: 1.75, endArrowType: "triangle" } });
  });

  s.addText([
    { text: "„Notiz strukturieren“  ", options: { bold: true, color: NAVY } },
    { text: "zerlegt die Notiz in Vorschläge: Beobachtungen, Aktionen, Entscheidungen, offene Fragen, Personen, Konflikte, Kontaktaufnahmen – jede zitiert wörtlich ihre Stelle und trägt ihr Wofür.", options: { color: INK } },
  ], { x: MX, y: 4.55, w: 11.8, h: 0.9, fontFace: FONT, fontSize: 13, isTextBox: true, margin: 0, lineSpacingMultiple: 1.25 });
  s.addText([
    { text: "Ablehnen braucht einen Grund  ", options: { bold: true, color: NAVY } },
    { text: "– damit die KI lernt, was unpassend war. Offene Vorschläge erscheinen im Setup als „Ideen aus den Quellen“, adressierte in „Meine Arbeit“.", options: { color: INK } },
  ], { x: MX, y: 5.5, w: 11.8, h: 0.9, fontFace: FONT, fontSize: 13, isTextBox: true, margin: 0, lineSpacingMultiple: 1.25 });
  footer(s); pageNo(s, 10);
}

// ---------- Folie 11: Strategiefaden ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Der Strategiefaden");
  title(s, "Eine versionierte Hypothese je Setup");
  lead(s, "Wo stehen wir, was ist der nächste große Schritt, welche Züge lohnen sich.", 1.55);

  s.addText([
    { text: "Lage zuerst.  ", options: { bold: true, color: NAVY } },
    { text: "Der Reiter zeigt Stufe, nächsten großen Schritt, Blocker, Lücken, naheliegende Züge und Wofür – abgeleitet aus dem Dokumentierten.", options: { color: INK } },
  ], { x: MX, y: 2.6, w: 6.0, h: 1.1, fontFace: FONT, fontSize: 13, isTextBox: true, margin: 0, lineSpacingMultiple: 1.25 });
  s.addText([
    { text: "„Vorschlag der KI einholen“  ", options: { bold: true, color: NAVY } },
    { text: "belegt das Formular vor. Züge ohne Textstelle aus Lage oder Kontext werden verworfen.", options: { color: INK } },
  ], { x: MX, y: 3.85, w: 6.0, h: 1.1, fontFace: FONT, fontSize: 13, isTextBox: true, margin: 0, lineSpacingMultiple: 1.25 });
  s.addText([
    { text: "Pflegen darf, wer das Setup bearbeiten darf  ", options: { bold: true, color: NAVY } },
    { text: "– alle anderen Berechtigten lesen mit. Ein guter Anker für das Weekly zwischen BD und Principal.", options: { color: INK } },
  ], { x: MX, y: 5.1, w: 6.0, h: 1.1, fontFace: FONT, fontSize: 13, isTextBox: true, margin: 0, lineSpacingMultiple: 1.25 });

  // Rechts: Stat-Callout
  const bx = 7.1, bw = 5.65;
  s.addShape("roundRect", { x: bx, y: 2.55, w: bw, h: 3.9, rectRadius: 0.08, fill: { color: NAVY }, line: { type: "none" } });
  s.addText("bis zu 5", { x: bx + 0.4, y: 2.85, w: bw - 0.8, h: 0.85, fontFace: HEAD, fontSize: 44, bold: true, color: GREEN, isTextBox: true, margin: 0 });
  s.addText("vorgeschlagene Züge je Fassung, mit Rolle und Begründung", { x: bx + 0.4, y: 3.65, w: bw - 0.8, h: 0.6, fontFace: FONT, fontSize: 12, color: "D8DEE8", isTextBox: true, margin: 0, lineSpacingMultiple: 1.15 });
  s.addShape("line", { x: bx + 0.4, y: 4.45, w: bw - 0.8, h: 0, line: { color: "3A4152", width: 1 } });
  s.addText("jede Speicherung eine neue Version", { x: bx + 0.4, y: 4.65, w: bw - 0.8, h: 0.5, fontFace: FONT, fontSize: 13, bold: true, color: WHITE, isTextBox: true, margin: 0 });
  s.addText("frühere Fassungen bleiben nachlesbar – so ist später klar, was wir wann dachten und warum", { x: bx + 0.4, y: 5.15, w: bw - 0.8, h: 1.0, fontFace: FONT, fontSize: 11.5, color: "D8DEE8", isTextBox: true, margin: 0, lineSpacingMultiple: 1.2 });
  footer(s); pageNo(s, 11);
}

// ---------- Folie 12: Für Principals ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Für Principals");
  title(s, "Portfolio und Zielbild");
  lead(s, "Wohin läuft das Portfolio, wo hakt es, wer braucht Unterstützung.", 1.55);

  s.addText("Zielbild: Rollenfamilie × Reifegrad", { x: MX, y: 2.35, w: 6, h: 0.35, fontFace: HEAD, fontSize: 13, bold: true, color: NAVY, isTextBox: true, margin: 0 });
  const rowsFam = ["Delivery Mgmt.", "Agile Leadership", "Business Analyse", "Solution & Arch.", "Test & QS"];
  const colsStage = ["antiz.", "Klärung", "bestät.", "Angebot", "beauft.", "gestart."];
  const gx0 = MX, gy0 = 2.75, cellW = 0.78, cellH = 0.42, labelW = 2.0;
  colsStage.forEach((c, i) => {
    s.addText(c, { x: gx0 + labelW + i * cellW, y: gy0, w: cellW, h: 0.3, fontFace: FONT, fontSize: 8.5, color: MUTED, align: "center", isTextBox: true, margin: 0 });
  });
  const sample = [[2, 1, 0, 0, 0, 1], [1, 0, 1, 0, 0, 0], [0, 2, 0, 1, 0, 0], [1, 0, 0, 0, 1, 0], [0, 1, 1, 0, 0, 2]];
  rowsFam.forEach((r, ri) => {
    const y = gy0 + 0.35 + ri * cellH;
    s.addText(r, { x: gx0, y, w: labelW - 0.1, h: cellH, fontFace: FONT, fontSize: 9.5, color: INK, valign: "middle", isTextBox: true, margin: 0 });
    sample[ri].forEach((v, ci) => {
      const x = gx0 + labelW + ci * cellW;
      const fill = v === 0 ? "EDEFEE" : v === 1 ? "BFE2AE" : GREEN;
      s.addShape("rect", { x: x + 0.03, y: y + 0.03, w: cellW - 0.06, h: cellH - 0.06, fill: { color: fill }, line: { color: WHITE, width: 1 } });
      if (v > 0) s.addText(String(v), { x, y, w: cellW, h: cellH, fontFace: FONT, fontSize: 10, bold: true, color: v === 2 ? WHITE : NAVY, align: "center", valign: "middle", isTextBox: true, margin: 0 });
    });
  });

  // rechte Spalte: Portfolioübersicht Stat-Karten
  const px = 8.55, pw = 3.85;
  s.addText("Portfolioübersicht (Beispiel)", { x: px, y: 2.35, w: pw, h: 0.35, fontFace: HEAD, fontSize: 13, bold: true, color: NAVY, isTextBox: true, margin: 0 });
  const stats = [["4", "offene Unterstützungsaufträge"], ["9", "unbelegte Beziehungen"], ["3", "Setups ohne bestätigtes Weekly"]];
  let py = 2.78;
  stats.forEach(([num, lab]) => {
    s.addShape("roundRect", { x: px, y: py, w: pw, h: 0.72, rectRadius: 0.06, fill: { color: LIGHT }, line: { type: "none" } });
    s.addText(num, { x: px + 0.15, y: py + 0.06, w: 0.85, h: 0.6, fontFace: HEAD, fontSize: 24, bold: true, color: NAVY, valign: "middle", isTextBox: true, margin: 0 });
    s.addText(lab, { x: px + 1.05, y: py + 0.06, w: pw - 1.2, h: 0.6, fontFace: FONT, fontSize: 10.5, color: INK, valign: "middle", isTextBox: true, margin: 0, lineSpacingMultiple: 1.05 });
    py += 0.85;
  });

  s.addText("Keine Beträge, keine Wahrscheinlichkeiten – das ist Absicht. Wir zählen dokumentierte Chancen und nennen ihren Reifegrad.", {
    x: MX, y: 6.05, w: 11.8, h: 0.55, fontFace: FONT, fontSize: 12, italic: true, color: MUTED, isTextBox: true, margin: 0, lineSpacingMultiple: 1.2,
  });
  footer(s); pageNo(s, 12);
}

// ---------- Folie 13: Regeln ----------
{
  const s = newSlide(NAVY);
  kicker(s, "Verbindlich", true);
  title(s, "Regeln, die das Tool durchsetzt", { color: WHITE });
  s.addText("Damit das Bild belastbar bleibt – und damit wir mit echten Kundendaten sauber arbeiten.", {
    x: MX, y: 1.5, w: 11.6, h: 0.5, fontFace: FONT, fontSize: 14, italic: true, color: "CBD3E1", isTextBox: true, margin: 0,
  });

  const rules = [
    ["KI schlägt nur vor", "Nichts wird ohne Klick angelegt oder automatisch an Kunden verschickt. Keine Internetrecherche."],
    ["Beleg für jeden Vorschlag", "Jede KI-Karte trägt eine wörtliche Textstelle – ohne Beleg wird verworfen."],
    ["Sachverhalt ≠ Vermutung", "Beobachtungen sind belegt, Einschätzungen Hypothesen bis zur Bestätigung. Kein Reifegrad-Sprung ohne Beleg."],
    ["Zugriffsklassen", "Nur Beteiligte, Kundenteam, Arbeitsraum oder persönlich sehen Rohquellen – CEO/ADMIN nicht pauschal."],
    ["Schutzwürdige Daten bleiben draußen", "Gesundheit, Vergütung, private Konflikte gehören nicht ins Tool oder nur in „persönlich“."],
    ["Löschen ist zweistufig", "Archivieren, dann endgültig löschen mit Begründung – alles im Prüfprotokoll."],
  ];
  const rw = 5.75, rgap = 0.3, rh = 1.55, rstartY = 2.25;
  rules.forEach((r, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = MX + col * (rw + rgap);
    const y = rstartY + row * (rh + 0.15);
    s.addShape("ellipse", { x, y: y + 0.05, w: 0.3, h: 0.3, fill: { color: GREEN }, line: { type: "none" } });
    s.addText(String(i + 1), { x, y: y + 0.05, w: 0.3, h: 0.3, fontFace: HEAD, fontSize: 11, bold: true, color: NAVY, align: "center", valign: "middle", isTextBox: true, margin: 0 });
    s.addText(r[0], { x: x + 0.45, y, w: rw - 0.45, h: 0.4, fontFace: HEAD, fontSize: 13, bold: true, color: WHITE, isTextBox: true, margin: 0 });
    s.addText(r[1], { x: x + 0.45, y: y + 0.4, w: rw - 0.45, h: rh - 0.45, fontFace: FONT, fontSize: 10.5, color: "C4CCDA", isTextBox: true, margin: 0, lineSpacingMultiple: 1.15 });
  });
  footer(s, true); pageNo(s, 13);
}

// ---------- Folie 14: Häufige Fragen ----------
{
  const s = newSlide(WHITE);
  kicker(s, "Häufige Fragen");
  title(s, "Was BDs und Principals am häufigsten fragen");

  const faqs = [
    ["Ich sehe den Kunden nicht, den der Assistent „angelegt“ hat.", "Der Assistent legt nichts selbst an. Sucht die Karte „Kunde“ und klickt „Übernehmen“."],
    ["„KI nicht verfügbar“ oder „nicht schemakonform“?", "Meist fehlt unter Verwaltung → KI ein passendes Modell. Ohne KI zeigt der Assistent trotzdem offene Punkte."],
    ["Wann „antizipiert“, wann „in Klärung“?", "Antizipiert: aus Beobachtungen vermutet. In Klärung: Der Kunde hat den Bedarf ausgesprochen."],
    ["Wer sieht meine Einschätzung einer Person?", "BD und Principal des Kunden sowie der Beziehungshalter – nicht pauschal CEO oder Betriebsverwaltung."],
  ];
  const qw = 5.75, qgap = 0.3, qh = 2.05, qstartY = 1.6;
  faqs.forEach((f, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = MX + col * (qw + qgap);
    const y = qstartY + row * (qh + 0.25);
    s.addShape("roundRect", { x, y, w: qw, h: qh, rectRadius: 0.07, fill: { color: LIGHT }, line: { type: "none" } });
    s.addText(f[0], { x: x + 0.28, y: y + 0.2, w: qw - 0.56, h: 0.7, fontFace: HEAD, fontSize: 13, bold: true, color: NAVY, isTextBox: true, margin: 0, lineSpacingMultiple: 1.1 });
    s.addText(f[1], { x: x + 0.28, y: y + 0.95, w: qw - 0.56, h: qh - 1.1, fontFace: FONT, fontSize: 11.5, color: INK, isTextBox: true, margin: 0, lineSpacingMultiple: 1.2 });
  });
  footer(s); pageNo(s, 14);
}

// ---------- Folie 15: Abschluss ----------
{
  const s = newSlide(NAVY);
  s.addShape("ellipse", { x: -2.5, y: 4.2, w: 6, h: 6, fill: { color: "1E2233" }, line: { type: "none" } });
  s.addText("VERVE AI", { x: MX, y: 2.6, w: 4, h: 0.5, fontFace: HEAD, fontSize: 16, bold: true, color: GREEN, charSpacing: 3, isTextBox: true, margin: 0 });
  s.addText("Fragen zum Tool?", { x: MX, y: 3.1, w: 10.5, h: 0.9, fontFace: HEAD, fontSize: 36, bold: true, color: WHITE, isTextBox: true, margin: 0 });
  s.addText("Betriebsverwaltung (Zugänge, Rollen, Modellwahl) · Principal (Vertriebsfragen, Zielbild) · Team Accountmeister (Fehler, Wünsche)", {
    x: MX, y: 4.05, w: 10, h: 0.6, fontFace: FONT, fontSize: 14, color: "CBD3E1", isTextBox: true, margin: 0, lineSpacingMultiple: 1.2,
  });
  s.addShape("line", { x: MX, y: 5.0, w: 1.1, h: 0, line: { color: GREEN, width: 2.5 } });
  s.addText(APP_URL, { x: MX, y: 5.15, w: 10, h: 0.4, fontFace: FONT, fontSize: 15, color: WHITE, isTextBox: true, margin: 0 });
  s.addText("Verve Consulting · intern · Alle Beispiele in diesem Handbuch sind fiktiv.", {
    x: MX, y: 5.55, w: 10, h: 0.35, fontFace: FONT, fontSize: 10.5, color: "6E7893", isTextBox: true, margin: 0,
  });
}

const out = process.argv[2] || require("node:path").join(__dirname, "Accountmeister-Handbuch-Folien.pptx");
pres.writeFile({ fileName: out }).then(() => {
  console.log("geschrieben:", out);
});
