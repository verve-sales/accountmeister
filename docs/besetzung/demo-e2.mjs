/**
 * Demo-Durchlauf Einsatz E2 (fiktive Daten) – setzt den E1-Durchlauf voraus (eine besetzte Position mit Mara Muster).
 *   node docs/besetzung/demo-e2.mjs [Ausgabeordner]
 * Ablauf: BD öffnet den Einsatz → Beschaffungsprofil am Kunden freigeben → Unterlagen (Bestellung mit Link, Einzelbeauftragung)
 * → geplant → Start bestätigen → Betreuung an Sofia übergeben → Sofia nimmt an, führt Check-in mit Sales-Hinweis → Verlängerung.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3100";
const OUT = process.argv[2] ?? "/tmp/einsatz-e2";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
async function login(label) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(BASE + "/anmelden", { timeout: 180000 });
  const opts = await page.$$eval("select option", (o) => o.map((x) => [x.value, x.textContent]));
  await page.selectOption("select", opts.find((o) => (o[1] || "").includes(label))[0]);
  await Promise.all([page.waitForNavigation({ timeout: 180000 }), page.click("button[type=submit]")]);
  return page;
}
const nav = (p) => p.waitForNavigation({ timeout: 120000 });
const shot = (p, n, full = false) => p.screenshot({ path: `${OUT}/${n}.png`, fullPage: full });
const today = new Date().toISOString().slice(0, 10);

const david = await login("David Demo");
await david.goto(BASE + "/einsaetze", { timeout: 180000 });
await shot(david, "01-einsaetze");
const eng = await david.$eval("main a[href^='/einsaetze/']", (a) => a.getAttribute("href"));
await david.goto(BASE + eng, { timeout: 180000 });
await shot(david, "02-einsatz-vorbereitung", true);
// Beschaffungsprofil am Kunden
const kunde = await david.$eval("main a[href^='/kunden/']", (a) => a.getAttribute("href"));
await david.goto(BASE + kunde + "#beschaffungsprofil", { timeout: 180000 });
await david.locator("#beschaffungsprofil summary").click();
await david.check("input[name=req_KUNDE_BESTELLUNG]");
await david.check("input[name=req_FREELANCER_EINZELBEAUFTRAGUNG]");
await Promise.all([nav(david), david.click("#beschaffungsprofil button[name=approve]")]);
await david.locator("#beschaffungsprofil").scrollIntoViewIfNeeded();
await shot(david, "03-beschaffungsprofil");
// Unterlagen
await david.goto(BASE + eng + "#vertraege", { timeout: 180000 });
await david.locator("#vertraege summary:has-text('Unterlage hinzufügen')").click();
await david.selectOption("#vertraege select[name=side]", "KUNDE");
await david.selectOption("#vertraege select[name=docType]", "BESTELLUNG");
await david.selectOption("#vertraege select[name=signedStatus]", "UNTERSCHRIEBEN");
await david.fill("#vertraege input[name=title]", "Bestellung PO 4711");
await david.fill("#vertraege input[name=reference]", "4711");
await david.fill("#vertraege input[name=link]", "https://ablage.example/po-4711");
await Promise.all([nav(david), david.click("#vertraege form[enctype] button[type=submit]")]);
await david.locator("#vertraege summary:has-text('Unterlage hinzufügen')").click();
await david.selectOption("#vertraege select[name=side]", "FREELANCER");
await david.selectOption("#vertraege select[name=docType]", "EINZELBEAUFTRAGUNG");
await david.selectOption("#vertraege select[name=signedStatus]", "UNTERSCHRIEBEN");
await david.fill("#vertraege input[name=title]", "Einzelbeauftragung Mara Muster");
await david.fill("#vertraege input[name=link]", "https://ablage.example/eb-muster");
await Promise.all([nav(david), david.click("#vertraege form[enctype] button[type=submit]")]);
await david.locator("#vertraege").scrollIntoViewIfNeeded();
await shot(david, "04-vertraege");
// geplant → aktiv
await Promise.all([nav(david), david.click("button:has-text('Auf „geplant“ setzen')")]);
await david.fill("input[name=actualDate]", today);
await Promise.all([nav(david), david.click("button:has-text('Start bestätigen')")]);
await shot(david, "05-aktiv", true);
// Betreuung übergeben
await david.locator("#betreuung summary:has-text('Betreuung übergeben')").click();
const sofiaOpt = await david.$$eval("#betreuung select[name=target] option", (o) => o.map((x) => [x.value, x.textContent]).find((x) => x[1].includes("Sofia")));
await david.selectOption("#betreuung select[name=target]", sofiaOpt[0]);
await david.fill("#betreuung input[name=reason]", "Betreuung geht an Sales Operations, Account wächst.");
await david.fill("#betreuung input[name=commitments]", "Verlängerung bis März klären");
await Promise.all([nav(david), david.click("#betreuung button:has-text('Übergabe anfragen')")]);
// Sofia
const sofia = await login("Sofia");
await sofia.goto(BASE + "/meine-arbeit?v=mir#vorgaenge", { timeout: 180000 });
await Promise.all([nav(sofia), sofia.click("#vorgaenge a[href^='/vorgaenge/']")]);
await sofia.click("button:has-text('Annehmen')");
await sofia.waitForURL(/[?&]ok=/, { timeout: 120000 });
await sofia.goto(BASE + eng, { timeout: 180000 });
await shot(sofia, "06-einsatz-sofia-betreuung", true);
// Check-in anlegen und führen
await sofia.fill("#checkins input[name=dueDate]", today);
await Promise.all([nav(sofia), sofia.click("#checkins button:has-text('Check-in anlegen')")]);
await sofia.locator("#checkins summary:has-text('Bearbeiten')").first().click();
await sofia.fill("#checkins input[name=heldAt]", `${today}T10:00`);
await sofia.fill("#checkins textarea[name=note]", "Kunde zufrieden; Übergabe läuft gut.");
await sofia.fill("#checkins input[name=salesHint]", "Der Bereich plant ab Q2 zwei weitere Testautomatisierer.");
await Promise.all([nav(sofia), sofia.click("#checkins form button:has-text('Speichern')")]);
await sofia.locator("#checkins").scrollIntoViewIfNeeded();
await shot(sofia, "07-checkin-erledigt");
// Verlängerung vorbereiten (Sofia), bestätigen (David)
await sofia.locator("#verlaengerung details").evaluate((d) => { d.open = true; });
await sofia.selectOption("#verlaengerung select[name=status]", "IN_ABSTIMMUNG");
await sofia.fill("#verlaengerung input[name=availabilityNote]", "Freelancer bis Juni verfügbar");
await Promise.all([nav(sofia), sofia.click("#verlaengerung button:has-text('Speichern')")]);
await david.goto(BASE + eng + "#verlaengerung", { timeout: 180000 });
await david.locator("#verlaengerung details").evaluate((d) => { d.open = true; });
await david.selectOption("#verlaengerung select[name=status]", "BESTAETIGT");
await david.fill("#verlaengerung input[name=proposedFrom]", "2027-04-01");
await david.fill("#verlaengerung input[name=proposedTo]", "2027-09-30");
await david.fill("#verlaengerung input[name=ek]", "840");
await david.fill("#verlaengerung input[name=vk]", "1100");
await david.fill("#verlaengerung input[name=contractFollowUp]", "Nachtrag 1 zur Einzelbeauftragung");
await Promise.all([nav(david), david.click("#verlaengerung button:has-text('Speichern')")]);
await shot(david, "08-verlaengerung-bestaetigt", true);
await david.goto(BASE + "/verwaltung", { timeout: 180000 }).catch(() => {});
await browser.close();
console.log("Demo E2 durchgelaufen:", eng, "Screenshots in", OUT);
