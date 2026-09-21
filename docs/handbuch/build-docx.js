/* eslint-disable */
// Erzeugt das Anwenderhandbuch als Word-Datei: node docs/handbuch/build-docx.js
const fs = require("node:fs");
const path = require("node:path");
const docx = require("docx");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType, LevelFormat, BorderStyle, PageBreak, ImageRun, Header, Footer, PageNumber, TabStopType } = docx;
const { BRAND, APP_URL, chapters } = require("./content.js");

const FONT = "Calibri";
const logo = fs.readFileSync(path.join(__dirname, "..", "..", "public", "verve-ai-lockup.png"));

const p = (text, opts = {}) => new Paragraph({ spacing: { after: 140, line: 300 }, ...opts, children: [new TextRun({ text, font: FONT, size: 22, color: BRAND.ink, ...(opts.run ?? {}) })] });
const lead = (text) => new Paragraph({ spacing: { after: 200, line: 300 }, children: [new TextRun({ text, font: FONT, size: 24, italics: true, color: BRAND.navy })] });
const h1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 160 }, children: [new TextRun({ text, font: FONT, size: 34, bold: true, color: BRAND.navy })] });
const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 }, children: [new TextRun({ text, font: FONT, size: 26, bold: true, color: BRAND.navy })] });
const bullet = (text) => new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 100, line: 300 }, children: [new TextRun({ text, font: FONT, size: 22, color: BRAND.ink })] });

const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: "D9DEDB" };
const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

function table(header, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cell = (text, w, isHead, alt) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      borders,
      shading: isHead ? { type: ShadingType.CLEAR, fill: BRAND.navy, color: "auto" } : alt ? { type: ShadingType.CLEAR, fill: BRAND.light, color: "auto" } : undefined,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ spacing: { after: 0, line: 276 }, children: [new TextRun({ text, font: FONT, size: 20, bold: isHead, color: isHead ? BRAND.white : BRAND.ink })] })],
    });
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, widths[i], true, false)) }), ...rows.map((r, ri) => new TableRow({ children: r.map((c, i) => cell(c, widths[i], false, ri % 2 === 1)) }))],
  });
}

const children = [];
// Titelseite
children.push(new Paragraph({ spacing: { before: 2400, after: 400 }, children: [new ImageRun({ type: "png", data: logo, transformation: { width: 326, height: 80 } })] }));
children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: "Accountmeister", font: FONT, size: 64, bold: true, color: BRAND.navy })] }));
children.push(new Paragraph({ spacing: { after: 600 }, children: [new TextRun({ text: "Anwenderhandbuch für BDs und Principals", font: FONT, size: 32, color: BRAND.ink })] }));
children.push(p("Wie wir aus Gesprächen, Notizen und Dokumenten den Weg zur Vermittlung finden – und nichts vergessen, was dafür noch fehlt.", { run: { size: 24, italics: true, color: BRAND.muted } }));
children.push(new Paragraph({ spacing: { before: 3000, after: 0 }, children: [new TextRun({ text: `Stand: September 2026 · Verve Consulting · intern · ${APP_URL}`, font: FONT, size: 18, color: BRAND.muted })] }));
children.push(p("Alle Beispiele in diesem Handbuch sind fiktiv.", { run: { size: 18, color: BRAND.muted } }));
children.push(new Paragraph({ children: [new PageBreak()] }));

// Inhaltsverzeichnis
children.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: "Inhalt", font: FONT, size: 34, bold: true, color: BRAND.navy })] }));
// Manuelles Inhaltsverzeichnis (Feld-basierte Verzeichnisse verlangen in Word ein Aktualisieren der Felder)
[...chapters.map((c) => c.title), "Schnellreferenz"].forEach((t, i) => children.push(new Paragraph({ spacing: { after: 90 }, children: [new TextRun({ text: `${i + 1}.  ${t}`, font: FONT, size: 24, color: BRAND.ink })] })));
children.push(new Paragraph({ children: [new PageBreak()] }));

// Kapitel
chapters.forEach((ch, idx) => {
  children.push(h1(`${idx + 1}. ${ch.title}`));
  if (ch.lead) children.push(lead(ch.lead));
  if (ch.table) {
    const widths = ch.table.header.length === 3 ? [2000, 4600, 2760] : [2600, 6760];
    children.push(table(ch.table.header, ch.table.rows, widths));
    children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
  }
  for (const t of ch.paras ?? []) children.push(p(t));
  if (ch.list) for (const t of ch.list) children.push(bullet(t));
  if (ch.faq) {
    for (const [q, a] of ch.faq) {
      children.push(h2(q));
      children.push(p(a));
    }
  }
});

// Anhang: Schnellreferenz
children.push(h1(`${chapters.length + 1}. Schnellreferenz`));
children.push(
  table(
    ["Ich will …", "… dann"],
    [
      ["einen neuen Kunden anlegen", "Kunden → „Mit dem Assistenten erfassen“ oder „Dokument hochladen“, Karten prüfen, Kunde-Karte übernehmen"],
      ["eine Chance festhalten", "Setup → Überblick → „Chance erfassen“: Art, Rolle, Anzahl, Horizont, Beschreibung; „Antizipiert“, wenn nur vermutet"],
      ["wissen, was diese Woche dran ist", "Start → „Diese Woche dran“; überfällig rot, heute fett"],
      ["sehen, woran es bei einem Kunden hängt", "Start → Kundenkarte: Wofür, Blockiert, Was fehlt, Naheliegende Züge"],
      ["das Weekly vorbereiten", "Weeklys → Setup wählen → Notiz erfassen → „Notiz strukturieren“ → Vorschläge prüfen → Stand bestätigen"],
      ["die Strategie festhalten", "Setup → Reiter „Strategiefaden“ → „Vorschlag der KI einholen“ → prüfen → „Fassung speichern“"],
      ["eine Person einschätzen", "Setup → „Personen & Zugang“ → Einschätzung (Rolle, Haltung, Einfluss) als Hypothese; bestätigen nur mit Quelle"],
      ["Unterstützung vom Principal", "Setup → „Unterstützung durch Principal/CEO“ → konkreten Auftrag mit einem Adressaten stellen"],
      ["das Zielbild sehen (Principal)", "Ziele & Portfolio → „Wohin läuft es“: Rollenfamilie × Reifegrad"],
      ["einen Kunden löschen", "Kundenseite → „Kunde archivieren oder löschen“ → archivieren → endgültig löschen mit Begründung"],
    ],
    [2800, 6560],
  ),
);

const doc = new Document({
  creator: "Verve Consulting",
  title: "Accountmeister – Anwenderhandbuch",
  styles: { default: { document: { run: { font: FONT, size: 22 } } } },
  numbering: { config: [{ reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
  sections: [
    {
      properties: { page: { margin: { top: 1300, bottom: 1200, left: 1300, right: 1300 } } },
      headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: "Accountmeister · Anwenderhandbuch", font: FONT, size: 16, color: BRAND.muted })] })] }) },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              tabStops: [{ type: TabStopType.RIGHT, position: 9360 }],
              children: [new TextRun({ text: "Verve Consulting · intern · fiktive Beispiele", font: FONT, size: 16, color: BRAND.muted }), new TextRun({ text: "\tSeite ", font: FONT, size: 16, color: BRAND.muted }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: BRAND.muted })],
            }),
          ],
        }),
      },
      children,
    },
  ],
});

const out = process.argv[2] || path.join(__dirname, "Accountmeister-Anwenderhandbuch.docx");
Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(out, buf);
  console.log("geschrieben:", out, buf.length, "Bytes");
});
