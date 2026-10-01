/**
 * Demo-Durchlauf Besetzung E1 (fiktive Daten) – Playwright gegen einen laufenden Entwicklungsserver.
 *
 *   createdb verve_e1 && DATABASE_URL=postgresql://…/verve_e1 npx drizzle-kit migrate && DATABASE_URL=… npm run db:seed
 *   DATABASE_URL=… AI_PROVIDER=test FEATURE_BESETZUNG=true npx next dev -p 3100
 *   node docs/besetzung/demo-e1.mjs [Ausgabeordner]
 *
 * Voraussetzung: eine Nutzerin mit Rolle SALES_OPS (Anzeigename enthält „Sofia“) und eine Chance beim Beispielkonzern.
 * Der Ablauf entspricht der Demo-Anleitung in docs/besetzung/e1-abnahme.md.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3100";
const OUT = process.argv[2] ?? "/tmp/besetzung-e1";
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

const david = await login("David Demo");
await david.goto(BASE + "/kunden", { timeout: 180000 });
const kunde = await david.$eval("main a[href^='/kunden/']:not([href*='anlage'])", (a) => a.getAttribute("href"));
await david.goto(BASE + kunde, { timeout: 180000 });
const opp = await david.$eval("main a[href^='/bedarfe/']", (a) => a.getAttribute("href"));
await david.goto(BASE + opp + "#besetzung", { timeout: 180000 });

// 1) Texteingang → Vorschau → Übernahme (drei Positionen als Entwurf)
await david.locator("#besetzung summary:has-text('Aus Text übernehmen')").click();
await david.fill(
  "#besetzung textarea[name=text]",
  "Hallo Herr Demo, für den Ausbau unserer Datenplattform suchen wir ab 1. Dezember 2026 zwei Data Engineer und einen Scrum Master. Erfahrung in Spark und Kafka ist zwingend erforderlich, Kenntnisse in Databricks wären wünschenswert. Umfang 4 Tage pro Woche, davon 2 Tage vor Ort in Köln, Rest remote. Deutsch und Englisch. Laufzeit bis Ende Juni 2027.",
);
await Promise.all([nav(david), david.click("#besetzung button:has-text('Vorschläge erzeugen')")]);
await shot(david, "01-texteingang-vorschau", true);
await Promise.all([nav(david), david.click("button:has-text('Ausgewählte als Entwurf anlegen')")]);
await david.locator("#besetzung").scrollIntoViewIfNeeded();
await shot(david, "02-chance-besetzung");

// 2) Erste Position: Konditionen, offen setzen, Suchauftrag
await Promise.all([nav(david), david.click("#besetzung a[href^='/besetzung/']")]);
const bedarf = david.locator("details:has(> summary:has-text('Bedarf'))").first();
if (!(await bedarf.evaluate((d) => d.open))) await bedarf.locator("> summary").click();
await david.locator("summary:has-text('Bedarf bearbeiten')").click();
await david.fill("#e-ekmax", "850");
await david.fill("#e-vkmin", "1050");
await david.fill("#e-due", "2026-10-20");
await Promise.all([nav(david), david.click("form:has(#e-title) button:has-text('Speichern')")]);
await Promise.all([nav(david), david.click("button:has-text('Auf „offen“ setzen')")]);
await david.fill("#s-res", "Zwei qualifizierte Profile mit EK bis 850 €/Tag, verfügbar ab Dezember.");
await Promise.all([nav(david), david.click("button:has-text('An Sales Operations geben')")]);
await shot(david, "03-position-offen-suchauftrag", true);
const posUrl = new URL(david.url()).pathname;

// 3) Sales Operations: Vorschau, Übernahme, Kandidaturen bis „vorgeschlagen“
const sofia = await login("Sofia");
await sofia.goto(BASE + posUrl, { timeout: 180000 });
await shot(sofia, "04-teamvorschau");
await sofia.goto(BASE + "/meine-arbeit?v=team#vorgaenge", { timeout: 180000 });
await Promise.all([nav(sofia), sofia.click("#vorgaenge a[href^='/vorgaenge/']")]);
await sofia.click("button:has-text('Übernehmen')");
await sofia.waitForURL(/[?&]ok=/, { timeout: 120000 });
await sofia.goto(BASE + posUrl + "#kandidaturen", { timeout: 180000 });
for (const [name, ek, skills] of [["Mara Muster (fiktiv)", "820", "Spark, Kafka, Databricks"], ["Tom Test (fiktiv)", "900", "Spark"]]) {
  await sofia.locator("summary:has-text('Kandidatur anlegen')").click();
  await sofia.fill("#c-name", name);
  await sofia.fill("#c-skills", skills);
  await sofia.fill("#c-from", "2026-12-01");
  await sofia.fill("#c-ek", ek);
  await Promise.all([nav(sofia), sofia.click("form:has(#c-name) button:has-text('Kandidatur anlegen')")]);
}
for (const st of ["KONTAKT", "QUALIFIZIERT", "VORGESCHLAGEN"]) {
  const li = sofia.locator("#kandidaturen li:has-text('Mara Muster')");
  await li.locator("select[aria-label='Nächster Status']").selectOption(st);
  await Promise.all([nav(sofia), li.locator("button:has-text('Weiter')").click()]);
}
await shot(sofia, "05-kandidaturen-sofia", true);

// 4) BD: Freigabe, Vorstellung, Interview, Auswahl
await david.goto(BASE + posUrl + "#kandidaturen", { timeout: 180000 });
let li = david.locator("#kandidaturen li:has-text('Mara Muster')");
await li.locator("select[aria-label='Nächster Status']").selectOption("FREIGEGEBEN");
await Promise.all([nav(david), li.locator("button:has-text('Weiter')").click()]);
li = david.locator("#kandidaturen li:has-text('Mara Muster')");
await li.locator("summary:has-text('Vorstellung beim Kunden dokumentieren')").click();
await li.locator("input[name=at]").fill("2026-10-10");
await li.locator("input[name=recipientText]").fill("Frau Keller (Leiterin IT)");
await li.locator("input[name=profileRef]").fill("CV_Muster_v3.pdf");
await li.locator("input[name=releaseScope]").fill("Profil ohne Kontaktdaten, Stand 09.10., per Mail bestätigt von M. Muster");
await li.locator("input[name=pricePresented]").fill("1080");
await Promise.all([nav(david), li.locator("button:has-text('Vorstellung dokumentieren')").click()]);
li = david.locator("#kandidaturen li:has-text('Mara Muster')");
await li.locator("summary:has-text('Interview dokumentieren')").click();
await li.locator("select[name=interviewStatus]").selectOption("DURCHGEFUEHRT");
await li.locator("input[name=interviewAt]").fill("2026-10-14T10:00");
await li.locator("textarea[name=outcome]").fill("Fachlich überzeugend; Kunde möchte starten.");
await Promise.all([nav(david), li.locator("form:has(select[name=interviewStatus]) button:has-text('Speichern')").click()]);
await shot(david, "06-vorstellung-interview", true);
li = david.locator("#kandidaturen li:has-text('Mara Muster')");
await li.locator("input[name=confirm]").check();
await Promise.all([nav(david), li.locator("button:has-text('Auswahl bestätigen')").click()]);
await shot(david, "07-besetzt", true);

// 5) Teilbesetzung an der Chance, Ausschreibungsentwurf an Position 2, Liste, Anker ohne Zugriff
await david.goto(BASE + opp + "#besetzung", { timeout: 180000 });
await david.locator("#besetzung").scrollIntoViewIfNeeded();
await shot(david, "08-chance-teilbesetzt");
const links = await david.$$eval("#besetzung a[href^='/besetzung/']", (as) => as.map((a) => a.getAttribute("href")));
await david.goto(BASE + links[1] + "#ausschreibung", { timeout: 180000 });
await Promise.all([nav(david), david.click("button:has-text('Entwurf erzeugen')")]);
await david.locator("#ausschreibung").scrollIntoViewIfNeeded();
await shot(david, "09-ausschreibung");
await david.goto(BASE + "/besetzung", { timeout: 180000 });
await shot(david, "10-liste");
const nina = await login("Nina Demo");
await nina.goto(BASE + posUrl, { timeout: 180000 });
await shot(nina, "11-anker-kein-zugriff");
await browser.close();
console.log("Demo durchgelaufen:", posUrl, "Screenshots in", OUT);
