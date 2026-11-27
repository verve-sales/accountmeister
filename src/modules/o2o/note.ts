import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Angebotsnotiz (e74, Konzept „Angebot ohne Dokument muss gehen“): Bei mündlichen Angeboten oder kurzen Mails an den
 * Vermittler erzeugt die App ein einseitiges PDF, damit auch hier ein Dokument am Anfang des Vorgangs steht.
 * Enthält nur, was erfasst wurde – kein Einkaufssatz, keine Unterschrift.
 */
export async function offerNotePdf(p: { caseNumber: string; date: string; author: string; rows: [string, string | null | undefined][] }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Angebotsnotiz ${p.caseNumber}`);
  doc.setProducer("Accountmeister");
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // WinAnsi: Zeichen außerhalb (z. B. Emojis) ersetzen, damit das PDF nie scheitert
  const safe = (s: string) => Array.from(s).map((ch) => { try { font.encodeText(ch); return ch; } catch { return "?"; } }).join("");
  const ink = rgb(0.08, 0.1, 0.15);
  const muted = rgb(0.4, 0.44, 0.5);
  let y = 780;
  page.drawText("Angebotsnotiz", { x: 56, y, size: 20, font: bold, color: ink });
  y -= 22;
  page.drawText(safe(`Vorgang ${p.caseNumber} · erfasst am ${p.date.split("-").reverse().join(".")} von ${p.author}`), { x: 56, y, size: 10, font, color: muted });
  y -= 34;
  for (const [label, value] of p.rows) {
    if (!value) continue;
    page.drawText(safe(label), { x: 56, y, size: 10, font, color: muted });
    const words = safe(value).split(/\s+/);
    let line = "";
    const lines: string[] = [];
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, 11) > 330) { lines.push(line); line = w; } else line = next;
    }
    if (line) lines.push(line);
    for (const l of lines) { page.drawText(l, { x: 210, y, size: 11, font, color: ink }); y -= 16; }
    y -= 6;
  }
  y -= 16;
  page.drawLine({ start: { x: 56, y }, end: { x: 539, y }, thickness: 0.5, color: rgb(0.85, 0.87, 0.9) });
  y -= 18;
  for (const l of ["Das Angebot wurde mündlich oder per kurzer Mail abgegeben. Diese Notiz hält fest, was angeboten wurde,", "damit der Vorgang mit einem Dokument beginnt. Sie wird nicht an den Kunden versendet."]) {
    page.drawText(l, { x: 56, y, size: 9, font, color: muted });
    y -= 13;
  }
  return doc.save();
}
