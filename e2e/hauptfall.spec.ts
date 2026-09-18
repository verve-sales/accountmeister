import { test, expect, type Page } from "@playwright/test";

/**
 * End-to-End: Hauptfall aus Briefing 19.1 (Schritte 1–5) in der Oberfläche.
 * Läuft gegen die Entwicklungsdatenbank mit Seed-Daten (fiktiv).
 */

async function loginAs(page: Page, namePart: string) {
  await page.goto("/anmelden");
  const select = page.getByLabel("Fiktive Person");
  const options = await select.locator("option").allTextContents();
  const match = options.find((o) => o.includes(namePart));
  if (!match) throw new Error(`Person ${namePart} nicht in Anmeldeliste`);
  await select.selectOption({ label: match });
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page).toHaveURL(/meine-arbeit/);
}

async function logout(page: Page) {
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/anmelden/);
}

test("Setup anlegen → Beobachtung → Übergabe → Annahme → Aktion erledigen", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const setupName = `E2E Migrationsteam ${suffix}`;

  // 1. Nina (Anker) legt ein lückenhaftes Setup an – BD-Zuordnung offen
  await loginAs(page, "Nina");
  await page.getByRole("link", { name: "Kunden", exact: true }).click();
  await page.getByRole("link", { name: /Beispielkonzern/ }).click();
  await page.locator("summary", { hasText: "Setup anlegen" }).click();
  await page.getByLabel("Verständlicher Setup-Name").fill(setupName);
  await page.getByRole("button", { name: "Setup anlegen" }).click();
  await expect(page.getByRole("heading", { name: setupName })).toBeVisible();
  await expect(page.getByText("Zuordnung offen").first()).toBeVisible();
  await expect(page.getByText("bewusster Entwurf")).toBeVisible();

  // 2. Beobachtung erfassen → Hinweis „Neu“
  await page.getByLabel(/Sichere Beobachtung/).fill("Im Migrationsteam wird zusätzlicher Testkoordinationsaufwand diskutiert.");
  await page.getByLabel(/Vermutung/).fill("Externe Unterstützung könnte relevant werden – noch unklar.");
  await page.getByRole("button", { name: "Beobachtung speichern" }).click();
  await expect(page.getByText("Beobachtung erfasst")).toBeVisible();
  await expect(page.getByText("Neu", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Quelle ansehen" })).toBeVisible();

  // 3. Übergabe an David (kein Auto-Owner vor Annahme)
  await page.locator("summary", { hasText: "Übergabe an eine andere Person" }).click();
  await page.getByLabel("Empfänger").selectOption({ label: "David Demo (BD)" });
  await page.getByLabel(/Welche konkrete Verantwortung/).fill("Klären, wer im Migrationsteam externe Kapazitäten plant.");
  await page.getByRole("button", { name: "Übergabe anfragen" }).click();
  await expect(page.getByText("Übergabe angefragt")).toBeVisible();
  await expect(page.getByText("Prüfung: niemand")).toBeVisible();
  const setupUrl = page.url().split("?")[0]!;
  await logout(page);

  // 4. David nimmt an → Owner des Hinweises
  await loginAs(page, "David");
  await expect(page.getByText("Klären, wer im Migrationsteam externe Kapazitäten plant.")).toBeVisible();
  await page.getByRole("button", { name: "Annehmen" }).first().click();
  await expect(page.getByText("Rückmeldung zur Übergabe gespeichert")).toBeVisible();
  await page.goto(setupUrl);
  await expect(page.getByText("Prüfung übernommen", { exact: true })).toBeVisible();
  await expect(page.getByText("Prüfung: David Demo (BD)")).toBeVisible();

  // 5. David vereinbart eine Aktion und erledigt sie mit Ergebnis
  await page.locator("summary", { hasText: "Aktion vereinbaren" }).click();
  await page.getByLabel("Was wird getan?").fill("Frau Keller fragen, wer die Planung koordiniert");
  await page.getByRole("button", { name: "Aktion speichern" }).click();
  await expect(page.getByText("Aktion gespeichert")).toBeVisible();
  await expect(page.getByText("Angenommen", { exact: true }).first()).toBeVisible();
  // Erledigt ohne Ergebnis → Fehler
  const row = page.getByRole("row", { name: /Frau Keller fragen/ });
  await row.getByRole("button", { name: "Erledigt" }).click();
  await expect(page.locator("p.error")).toContainText("Ergebnis dokumentieren");
  await row.getByPlaceholder("Ergebnis / Blocker").fill("Planung liegt bei Frau Brandt; Austausch angeboten.");
  await row.getByRole("button", { name: "Erledigt" }).click();
  await expect(page.getByText("Aktions-Status geändert")).toBeVisible();
  await expect(page.getByText(/Erledigte Aktionen \(1\)/)).toBeVisible();
  await logout(page);

  // Zugriff: Lars (BD anderer Kunde) sieht das Setup nicht
  await loginAs(page, "Lars");
  await page.goto(setupUrl);
  await expect(page.getByRole("heading", { name: "Nicht gefunden oder keine Berechtigung" })).toBeVisible();
});

test("Health-Endpunkt meldet erreichbare Datenbank und Entwicklungsmodus", async ({ request }) => {
  const res = await request.get("/health");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.status).toBe("ok");
  expect(body.authMode).toBe("development");
});

test("Personen & Zugang: Beziehungsstand mit Beleg, Kontaktweg mit belegter und hypothetischer Verbindung", async ({ page }) => {
  await loginAs(page, "David");
  await page.getByRole("link", { name: "Plattformteam", exact: true }).first().click();
  await page.getByRole("link", { name: "Personen & Zugang →" }).click();
  await expect(page.getByRole("heading", { name: /Personen & Zugang/ })).toBeVisible();
  await expect(page.getByText("Frau Keller (fiktiv)").first()).toBeVisible();

  // Beziehungsstand „Vorgestellt“ ohne Beleg → Fehler; mit Belegnotiz → gespeichert
  await page.locator("summary", { hasText: "Beziehungsstand setzen" }).click();
  await page.locator("#rPerson").selectOption({ label: "Frau Brandt (fiktiv)" });
  await page.locator("#rState").selectOption("VORGESTELLT");
  await page.getByLabel("Kontext (Pflicht)").fill("Frau Keller hat David per Mail vorgestellt.");
  await page.getByRole("button", { name: "Beziehungsstand speichern" }).click();
  await expect(page.locator("p.error")).toContainText("Beleg");
  await page.locator("summary", { hasText: "Beziehungsstand setzen" }).click();
  await page.locator("#rPerson").selectOption({ label: "Frau Brandt (fiktiv)" });
  await page.locator("#rState").selectOption("VORGESTELLT");
  await page.getByLabel("Kontext (Pflicht)").fill("Frau Keller hat David per Mail vorgestellt.");
  await page.getByLabel(/Oder Belegnotiz/).fill("Demo-Mail 20.09.: „Ich verbinde Sie gern.“");
  await page.getByRole("button", { name: "Beziehungsstand speichern" }).click();
  await expect(page.getByText("Beziehungsstand gespeichert")).toBeVisible();

  // Kontaktweg anlegen und Schritt als „belegt“ ohne Beleg → abgelehnt
  await page.locator("summary", { hasText: "Kontaktweg anlegen" }).click();
  await page.getByLabel("Zielperson").selectOption({ label: "Frau Brandt (fiktiv)" });
  await page.getByLabel("Fachlicher Anlass (Pflicht)").fill(`E2E Kontaktweg ${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Kontaktweg anlegen" }).click();
  await expect(page.getByText("Kontaktweg angelegt")).toBeVisible();
  const planBox = page.locator("div.border", { hasText: "E2E Kontaktweg" }).first();
  await planBox.locator("summary", { hasText: "Schritt ergänzen" }).click();
  await planBox.getByLabel("Von (Verve)").selectOption({ label: "David Demo (BD)" });
  await planBox.getByLabel("Zu", { exact: true }).selectOption({ label: "Frau Keller (fiktiv)" });
  await planBox.getByLabel("Verbindung").selectOption("BELEGT");
  await planBox.getByRole("button", { name: "Schritt speichern" }).click();
  await expect(page.locator("p.error")).toContainText("hypothetisch");
});

test("Etappe 2: Zwei Weeklys bauen aufeinander auf (Vorbereitung → Notiz → Ergebnis → Bestätigung)", async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAs(page, "David");
  // Eigenes Setup für den Test
  await page.getByRole("link", { name: "Kunden", exact: true }).click();
  await page.getByRole("link", { name: /Beispielkonzern/ }).click();
  await page.locator("summary", { hasText: "Setup anlegen" }).click();
  await page.getByLabel("Verständlicher Setup-Name").fill(`E2E Weekly-Setup ${tag}`);
  await page.getByLabel(/Kontextsatz/).fill("Kontext für den Weekly-Test.");
  await page.getByLabel("Zuständiger BD").selectOption({ label: "David Demo (BD)" });
  await page.getByRole("button", { name: "Setup anlegen" }).click();
  await expect(page.getByRole("heading", { name: `E2E Weekly-Setup ${tag}` })).toBeVisible();

  // Weekly 1 anlegen
  await page.getByRole("link", { name: "Weeklys →" }).click();
  await page.waitForURL(/\/weeklys\?setup=/);
  await page.locator("#scheduledFor").fill("2026-09-21");
  await page.getByLabel("Titel (optional)").fill(`W1 ${tag}`);
  await page.getByRole("button", { name: "Weekly anlegen" }).click();
  await expect(page.getByRole("heading", { name: `W1 ${tag}` })).toBeVisible();
  await expect(page.getByText("Noch kein bestätigtes Weekly für dieses Setup")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stand bestätigen" })).toBeDisabled();

  // Notiz als Entwurf, Beobachtung, Aktion als Idee
  await page.getByLabel(/Freitextnotiz/).fill("Weekly 1: Team plant zusätzliche Testtermine.");
  await page.getByRole("button", { name: "Entwurf speichern" }).click();
  await expect(page.getByText("Notiz als Entwurf gespeichert")).toBeVisible();
  await page.locator("summary", { hasText: "Beobachtung festhalten" }).click();
  await page.getByLabel("Sichere Beobachtung").fill("Beobachtung aus Weekly 1: zusätzliche Testtermine geplant.");
  await page.getByRole("button", { name: "Beobachtung speichern" }).click();
  await expect(page.getByText("Beobachtung erfasst")).toBeVisible();
  await page.locator("summary", { hasText: "Aktion festhalten" }).click();
  await page.getByLabel("Was wird getan?").fill("Idee: Nina fragt nach Testumfang");
  await page.getByLabel("Wer übernimmt?").selectOption({ label: "Nina Demo (Anker)" });
  await page.getByRole("button", { name: "Aktion speichern" }).click();
  await expect(page.getByText("Aktion gespeichert")).toBeVisible();
  await expect(page.getByText("(Idee, noch nicht angenommen)")).toBeVisible();

  // Bestätigen
  await page.getByRole("button", { name: "Stand bestätigen" }).click();
  await expect(page.getByText("Weekly bestätigt")).toBeVisible();
  await expect(page.getByText(/Bestätigt von/)).toContainText("David Demo (BD)");
  const w1Url = page.url().split("?")[0]!;

  // Zwischenzeitlich eine Beobachtung außerhalb des Weeklys im Setup
  await page.getByRole("link", { name: `E2E Weekly-Setup ${tag}` }).click();
  await page.waitForURL(/\/setups\/[^/]+$/);
  await expect(page.getByText(/Seit dem bestätigten Weekly „W1/)).toBeVisible();
  await page.locator("summary", { hasText: "Beobachtung erfassen" }).click();
  await page.getByLabel(/Sichere Beobachtung/).fill("Zwischenstand: Frau Keller nennt Frau Brandt als zuständig.");
  await page.getByRole("button", { name: "Beobachtung speichern" }).click();
  await expect(page.getByText("Beobachtung erfasst")).toBeVisible();

  // Weekly 2: Vorbereitung zeigt W1 als letzten Stand und die neue Beobachtung
  await page.getByRole("link", { name: "Weeklys →" }).click();
  await page.waitForURL(/\/weeklys\?setup=/);
  await page.locator("#scheduledFor").fill("2026-09-28");
  await page.getByLabel("Titel (optional)").fill(`W2 ${tag}`);
  await page.getByRole("button", { name: "Weekly anlegen" }).click();
  await expect(page.getByRole("heading", { name: `W2 ${tag}` })).toBeVisible();
  await expect(page.getByText("Letzter bestätigter Stand:")).toContainText(`W1 ${tag}`);
  await expect(page.getByText("Zwischenstand: Frau Keller nennt Frau Brandt als zuständig.")).toBeVisible();
  await expect(page.getByText("Beobachtung aus Weekly 1: zusätzliche Testtermine geplant.")).toHaveCount(0);

  // W1 bleibt bestätigt und unverändert erreichbar
  await page.goto(w1Url);
  await expect(page.locator("pre", { hasText: "Weekly 1: Team plant zusätzliche Testtermine." })).toBeVisible();
  await expect(page.getByText(/Bestätigt von/)).toContainText("Version 1");
});

test("Accountplan: Vorhaben vorschlagen, Zustimmung beider Rollen, Stand speichern bleibt erhalten", async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAs(page, "David");
  await page.getByRole("link", { name: "Kunden", exact: true }).click();
  await page.getByRole("link", { name: /Beispielkonzern/ }).click();
  await expect(page.getByRole("heading", { name: "Überblick – Accountplan" })).toBeVisible();
  await expect(page.getByText("Bestehende Zusammenarbeit")).toBeVisible();
  await expect(page.getByText(/Einsatz A .* beauftragt/)).toBeVisible();

  await page.locator("summary", { hasText: "Vorhaben vorschlagen" }).click();
  await page.getByLabel("Vorhaben", { exact: true }).fill(`E2E Vorhaben ${tag}`);
  await page.getByLabel("Begründung").fill("Aus Weekly-Hinweis.");
  await page.getByRole("button", { name: "Als Vorschlag aufnehmen" }).click();
  await expect(page.getByText("Vorhaben als Vorschlag aufgenommen")).toBeVisible();

  // David stimmt zu → noch nicht vereinbart
  await page.locator("summary", { hasText: "Priorität ändern" }).click();
  const row = page.locator("li", { hasText: `E2E Vorhaben ${tag}` }).first();
  await row.getByRole("button", { name: "Zustimmen" }).click();
  await expect(page.getByText("Ihre Zustimmung ist gespeichert")).toBeVisible();
  await logout(page);

  // Petra (Principal) stimmt zu → vereinbart
  await loginAs(page, "Petra");
  await page.getByRole("link", { name: "Kunden", exact: true }).click();
  await page.getByRole("link", { name: /Beispielkonzern/ }).click();
  await page.locator("summary", { hasText: "Priorität ändern" }).click();
  await page.locator("li", { hasText: `E2E Vorhaben ${tag}` }).first().getByRole("button", { name: "Zustimmen" }).click();
  await expect(page.getByText("Priorität aktualisiert")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(`E2E Vorhaben ${tag}`) })).toContainText("Vereinbart");

  // Stand speichern und prüfen, dass er erhalten bleibt
  await page.getByLabel("Aktuellen Stand speichern als").fill(`Review ${tag}`);
  await page.getByRole("button", { name: "Stand speichern" }).click();
  await expect(page.getByRole("heading", { name: `Review ${tag}` })).toBeVisible();
  await expect(page.getByText("Gespeicherter Stand · erzeugt")).toBeVisible();
  await expect(page.getByText(`E2E Vorhaben ${tag}`)).toBeVisible();
});

test("Artefakte: Katalog vollständig, Gesprächsvorbereitung entwerfen, Version speichern, Freigabe prüft Pflichtabschnitt", async ({ page }) => {
  await loginAs(page, "David");
  await page.getByRole("link", { name: "Artefakte", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Artefaktkatalog" })).toBeVisible();
  for (const code of ["A1", "A6", "A16", "ZIEL"]) await expect(page.getByRole("cell", { name: code, exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Plattformteam", exact: true }).first().click();
  await page.waitForURL(/artefakte$/);
  await page.getByLabel("Vorlage").selectOption("A6");
  await page.getByRole("button", { name: "Entwurf anlegen" }).click();
  await expect(page.getByText("Entwurf angelegt")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Gesprächsvorbereitung – Plattformteam/ })).toBeVisible();
  // Vorbefüllung sichtbar
  await expect(page.locator("#sec-kontext")).toHaveValue(/Plattformteam/);
  // Freigabe ohne Pflichtabschnitt „Ziel“ → Fehler
  await page.getByRole("button", { name: "Freigeben" }).click();
  await expect(page.locator("p.error")).toContainText("Ziel des Gesprächs");
  // Ziel ausfüllen → Version 2 → Freigabe
  await page.locator("#sec-ziel").fill("Verstehen, ob externe Testkoordination relevant ist.");
  await page.locator("#sec-grenzen").fill("Nina nicht als Quelle nennen.");
  await page.getByRole("button", { name: "Als neue Version speichern" }).click();
  await expect(page.getByText("Neue Version gespeichert")).toBeVisible();
  await expect(page.getByText(/Version 2/).first()).toBeVisible();
  await page.getByRole("button", { name: "Freigeben" }).click();
  await expect(page.getByText("Freigegeben. Das ist kein Versand")).toBeVisible();
  await expect(page.getByText("Freigegeben", { exact: true }).first()).toBeVisible();
});

test("Etappe 3: Weekly-Notiz strukturieren → Vorschläge prüfen → annehmen erzeugt ungeprüften Hinweis, ablehnen braucht Grund", async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAs(page, "David");
  await page.getByRole("link", { name: "Weeklys", exact: true }).click();
  await page.locator("summary", { hasText: "Weekly anlegen" }).click();
  await page.locator("#setupId").selectOption({ label: "Beispielkonzern AG (fiktiv) – Plattformteam" });
  await page.locator("#scheduledFor").fill("2026-11-02");
  await page.getByLabel("Titel (optional)").fill(`KI-Weekly ${tag}`);
  await page.getByRole("button", { name: "Weekly anlegen" }).click();
  await expect(page.getByRole("heading", { name: `KI-Weekly ${tag}` })).toBeVisible();

  await page.getByLabel(/Freitextnotiz/).fill(`Im Migrationsteam wird über zusätzlichen Testkoordinationsaufwand ${tag} gesprochen. Möglicherweise entsteht Bedarf an externer Unterstützung ${tag}. Wer entscheidet im Migrationsteam über externe Kapazitäten ${tag}?`);
  await page.getByRole("button", { name: "Entwurf speichern" }).click();
  await expect(page.getByText("Notiz als Entwurf gespeichert")).toBeVisible();
  await page.getByRole("button", { name: "Notiz strukturieren" }).click();
  await expect(page.getByText(/Vorschlag\/Vorschläge erzeugt/)).toBeVisible();
  await expect(page.getByText("Idee / Vermutung (nicht belegt)").first()).toBeVisible();

  // Erster prominenter Vorschlag annehmen → Hinweis „Neu“ in der Ergebnisvorschau
  const first = page.locator("li.border", { hasText: "Beleg (Zitat)" }).first();
  await first.getByRole("button", { name: "Annehmen" }).click();
  await expect(page.getByText("Vorschlag angenommen")).toBeVisible();
  // Ablehnen ohne Grund → Fehler
  const next = page.locator("li.border", { hasText: "Beleg (Zitat)" }).filter({ hasText: "Neu" }).first();
  await next.getByRole("button", { name: "Ablehnen" }).click();
  await expect(page.locator("p.error")).toContainText("Ablehnungsgrund");
  // Kein Fakt entstanden: Ergebnisvorschau zeigt Beobachtung, keine Bestätigung
  await expect(page.getByRole("heading", { name: /Neue Beobachtungen \(1\)/ })).toBeVisible();
});

test("Etappe 3B: Postfach im Fixture-Modus verbinden, Mail auswählen und importieren, Protokoll einfügen, Prüfliste, bestätigen", async ({ page }) => {
  const tag = Date.now().toString(36);
  await loginAs(page, "David");
  await page.getByRole("link", { name: "Einstellungen", exact: true }).click();
  await page.waitForURL(/einstellungen/);
  await expect(page.getByRole("heading", { name: "Mein Postfach (Microsoft 365 / Outlook)" })).toBeVisible();
  // Vorherige Verbindung (aus früheren Läufen) zurücksetzen
  if (await page.getByRole("button", { name: "Verbindung widerrufen" }).isVisible()) {
    await page.getByRole("button", { name: "Verbindung widerrufen" }).click();
    await expect(page.getByText("Verbindung widerrufen; Zugangsdaten gelöscht.")).toBeVisible();
  }
  // Echt → ehrlich abgewiesen
  await page.getByRole("button", { name: "Echtes Postfach verbinden" }).click();
  await expect(page.locator("p.error")).toContainText("noch nicht konfiguriert");
  await page.getByRole("button", { name: "Verbinden (Fixture-Modus)" }).click();
  await expect(page.getByText("Postfach verbunden (Fixture-Modus")).toBeVisible();
  await expect(page.getByText("Verbunden (Fixture-Modus)", { exact: true })).toBeVisible();

  // Eingang: Mail auswählen und importieren
  await page.locator("nav").getByRole("link", { name: "Eingang" }).click();
  await expect(page.getByText("Fixture-Modus: fiktive Testquellen")).toBeVisible();
  const row = page.getByRole("row", { name: /Kapazitäten nächste Phase/ });
  if (await row.getByRole("button", { name: "Übernehmen" }).isVisible()) {
    await row.getByLabel("Zielsetup").selectOption({ label: "Plattformteam" });
    await row.getByRole("button", { name: "Übernehmen" }).click();
    await expect(page.getByText(/übernommen und ausgewertet/)).toBeVisible();
  }
  await expect(page.getByRole("row", { name: /Kapazitäten nächste Phase/ })).toContainText("bereits importiert");

  // Protokolltext importieren – mit mehrdeutiger Person? Nur bekannte Namen: Keller eindeutig → keine Prüfliste
  await page.getByLabel("Titel", { exact: true }).fill(`Protokoll ${tag}`);
  await page.locator("#impSetup").selectOption({ label: "Beispielkonzern AG (fiktiv) – Plattformteam" });
  await page.getByLabel(/Protokolltext/).fill(`Frau Keller berichtet ${tag}: Das Migrationsteam plant zusätzliche Testtermine. Möglicherweise wird externe Unterstützung nötig.`);
  await page.getByRole("button", { name: "Quelle übernehmen" }).click();
  await expect(page.getByText(/Quelle übernommen/)).toBeVisible();
  const job = page.locator("li.border", { hasText: `Protokoll ${tag}` });
  await expect(job).toContainText("Ausgewertet");
  // Namensnennung im Text ist kein Identitätsbeweis → Prüfliste entscheiden, dann bestätigen
  await expect(job).toContainText("Unklare Personenzuordnung");
  await job.getByRole("button", { name: "Import bestätigen" }).click();
  await expect(page.locator("p.error")).toContainText("Personenzuordnung");
  const jobAgain = page.locator("li.border", { hasText: `Protokoll ${tag}` });
  await jobAgain.getByRole("button", { name: "Ist diese Person" }).first().click();
  await expect(page.getByText("Zuordnung entschieden")).toBeVisible();
  await page.locator("li.border", { hasText: `Protokoll ${tag}` }).getByRole("button", { name: "Import bestätigen" }).click();
  await expect(page.getByText("Import bestätigt und protokolliert")).toBeVisible();

  // Widerruf
  await page.getByRole("link", { name: "Einstellungen", exact: true }).click();
  await page.getByRole("button", { name: "Verbindung widerrufen" }).click();
  await expect(page.getByText("Verbindung widerrufen; Zugangsdaten gelöscht.")).toBeVisible();
});

test("Etappe 4: Unterstützungsauftrag BD → Principal, Principal-Weekly mit vertraulicher Notiz, Ziel mit Zustimmung CEO+Principal", async ({ page }) => {
  const suffix = Date.now().toString(36);

  // 1. David (BD) fragt aus dem Setup Unterstützung bei Petra (Principal) an
  await loginAs(page, "David");
  await page.getByRole("link", { name: "Kunden", exact: true }).click();
  await page.getByRole("link", { name: /Beispielkonzern/ }).click();
  await page.getByRole("link", { name: "Plattformteam", exact: true }).first().click();
  await page.locator("summary", { hasText: "Unterstützung anfragen" }).click();
  const task = `Kontakt zur Bereichsleitung Einkauf herstellen ${suffix}`;
  await page.locator("#srTask").fill(task);
  await page.locator("#srAddressee").selectOption({ label: "Petra Demo (Principal)" });
  await page.getByRole("button", { name: "Unterstützung anfragen" }).click();
  await expect(page.getByText("Unterstützungsauftrag angefragt")).toBeVisible();
  await expect(page.getByText(task)).toBeVisible();
  await logout(page);

  // 2. Petra sieht den Auftrag in „Meine Arbeit“, nimmt an, legt ein Principal-/BD-Weekly an
  await loginAs(page, "Petra");
  const item = page.locator("li", { hasText: task }).first();
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Annehmen" }).click();
  await expect(page.getByText("Rückmeldung zum Unterstützungsauftrag gespeichert")).toBeVisible();

  await page.getByRole("link", { name: "Ziele & Portfolio" }).click();
  await expect(page.getByRole("heading", { name: /^Portfolio \(/ })).toBeVisible();
  await page.locator("summary", { hasText: "Review anlegen" }).click();
  await page.locator("#rType").selectOption("PRINCIPAL_BD_WEEKLY");
  await page.locator("#rDate").fill("2026-10-02");
  await page.locator("#rTitle").fill(`Principal-Weekly ${suffix}`);
  await page.getByLabel("David Demo (BD)", { exact: true }).check();
  await page.getByRole("button", { name: "Review anlegen" }).click();
  await expect(page).toHaveURL(/\/fuehrung\//);
  await expect(page.getByText(task)).toBeVisible(); // offener Unterstützungsauftrag in der Vorbereitung
  await page.locator("#lNote").fill("Portfolio besprochen; Einkaufskontakt wird von Petra hergestellt.");
  await page.getByRole("button", { name: "Entwurf speichern" }).click();
  await expect(page.getByText("Notiz als Entwurf gespeichert")).toBeVisible();
  // Vertrauliche Notiz nur für Petra selbst (Empfängerkreis leer = nur Autorin)
  await page.locator("summary", { hasText: "Vertrauliche Notiz hinzufügen" }).click();
  await page.locator("#cnBody").fill(`Coaching-Notiz ${suffix}: Priorisierung im Gespräch üben.`);
  await page.getByRole("button", { name: "Vertraulich speichern" }).click();
  await expect(page.getByText("Vertrauliche Notiz gespeichert")).toBeVisible();
  const reviewUrl = page.url();
  await logout(page);

  // 3. David sieht das Weekly, aber nicht die vertrauliche Notiz
  await loginAs(page, "David");
  await page.goto(reviewUrl);
  await expect(page.getByRole("heading", { name: `Principal-Weekly ${suffix}` })).toBeVisible();
  await expect(page.getByText(`Coaching-Notiz ${suffix}`)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Vertrauliche Notizen/ })).toHaveCount(0);
  await logout(page);

  // 4. Clemens (CEO) legt ein Ziel an und stimmt zu → noch nicht vereinbart
  await loginAs(page, "Clemens");
  await page.getByRole("link", { name: "Ziele & Portfolio" }).click();
  await page.locator("summary", { hasText: "Ziel anlegen" }).click();
  const goalTitle = `Zwei Referenzkunden im Plattformbereich ${suffix}`;
  await page.locator("#gTitle").fill(goalTitle);
  await page.locator("#gOwner").selectOption({ label: "Petra Demo (Principal)" });
  await page.locator("#gOutcome").fill("Zwei dokumentierte, freigegebene Referenzen aus laufenden Plattform-Setups.");
  await page.locator("#gCrit").fill("Freigegebene Referenztexte (Artefakt) liegen vor.");
  await page.locator("#gBase").fill("unbekannt");
  await page.getByRole("button", { name: "Ziel anlegen" }).click();
  await expect(page).toHaveURL(/\/ziele\//);
  await expect(page.getByText("Ziel als Entwurf angelegt")).toBeVisible();
  await page.getByRole("button", { name: "Zustimmen (vereinbaren)" }).click();
  await expect(page.getByText("Ihre Zustimmung ist gespeichert")).toBeVisible();
  await expect(page.getByText("Zur Abstimmung", { exact: true })).toBeVisible();
  const goalUrl = page.url();
  await logout(page);

  // 5. Petra stimmt zu → vereinbart
  await loginAs(page, "Petra");
  await page.goto(goalUrl);
  await page.getByRole("button", { name: "Zustimmen (vereinbaren)" }).click();
  await expect(page.getByText("Zielstatus geändert")).toBeVisible();
  await expect(page.getByText("Vereinbart", { exact: true })).toBeVisible();
  await expect(page.getByText(/zugestimmt von .*Clemens.*Petra|zugestimmt von .*Petra.*Clemens/)).toBeVisible();
});

test("Etappe 5: Bedarf direkt erfassen → bestätigen mit Beleg → Buyingcenter → Angebot geprüft → vorgestellt mit Beleg → akzeptiert (kein Auftrag) → Auftrag mit Nachweis → Startvoraussetzungen → startbereit → gestartet", async ({ page }) => {
  const suffix = Date.now().toString(36);
  await loginAs(page, "David");

  // Profilreferenz (nur Verweis) in den Einstellungen
  await page.getByRole("link", { name: "Einstellungen" }).click();
  await page.locator("summary", { hasText: "Profilreferenz anlegen" }).click();
  await page.locator("#prLabel").fill(`Profil Testkoordination ${suffix}`);
  await page.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Profilreferenz angelegt")).toBeVisible();

  // Bedarf direkt im Setup erfassen (F08, Fast-Track)
  await page.getByRole("link", { name: "Kunden", exact: true }).click();
  await page.getByRole("link", { name: /Beispielkonzern/ }).click();
  await page.getByRole("link", { name: "Plattformteam", exact: true }).first().click();
  await page.locator("summary", { hasText: "Bedarf erfassen" }).click();
  const title = `Testkoordination Release ${suffix}`;
  await page.locator("#opTitle").fill(title);
  await page.locator("#opNeed").fill("Der Kunde braucht kurzfristig Unterstützung in der Testkoordination für das Q4-Release.");
  await page.getByLabel(/Direkte Anfrage/).check();
  await page.getByRole("button", { name: "Bedarf anlegen" }).click();
  await expect(page).toHaveURL(/\/bedarfe\//);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("In Klärung", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Direkte Anfrage (Fast-Track)")).toBeVisible();

  // Bestätigen ohne Beleg scheitert, mit Belegnotiz gelingt
  await page.locator("summary", { hasText: "Bedarf bestätigen" }).click();
  await page.getByRole("button", { name: "Bedarf bestätigen", exact: true }).click();
  await expect(page.getByText(/Bitte einen Beleg angeben/)).toBeVisible();
  await page.locator("summary", { hasText: "Bedarf bestätigen" }).click();
  await page.locator("#confText").fill("Frau Keller hat den Bedarf im Termin am 15.09. ausdrücklich bestätigt.");
  await page.getByRole("button", { name: "Bedarf bestätigen", exact: true }).click();
  await expect(page.getByText("Bedarf bestätigt – mit Quelle")).toBeVisible();

  // Buyingcenter: offene Funktion ohne Person
  await page.locator("summary", { hasText: "Rolle hinzufügen" }).click();
  await page.locator("#pRole").selectOption("BUDGETVERANTWORTUNG");
  await page.getByRole("button", { name: "Rolle speichern" }).click();
  await expect(page.getByText("Funktion bekannt, Person offen").first()).toBeVisible();

  // Angebot: Entwurf → geprüft → vorgestellt mit Beleg
  await page.locator("summary", { hasText: "Angebot anlegen" }).click();
  await page.locator("#ofTitle").fill(`Profilvorstellung ${suffix}`);
  await page.getByLabel(`Profil Testkoordination ${suffix}`).check();
  await page.getByRole("button", { name: "Angebot anlegen", exact: true }).click();
  await expect(page.getByText("Ein Entwurf gilt nicht als vorgestellt")).toBeVisible();
  await page.getByRole("button", { name: "Als geprüft markieren" }).click();
  await expect(page.getByText("Geprüft", { exact: true })).toBeVisible();
  await page.locator("summary", { hasText: "Vorstellungsereignis bestätigen" }).click();
  await page.locator("input[name=presentedTo]").fill("Frau Keller, Herr Brandt");
  await page.locator("input[name=evidenceText]").last().fill("Profil am 17.09. per Mail gesendet; Eingang bestätigt.");
  await page.getByRole("button", { name: "Als tatsächlich vorgestellt festhalten" }).click();
  await expect(page.getByText("Vorstellungsereignis bestätigt und belegt")).toBeVisible();
  await expect(page.getByText("Profil/Angebot vorgestellt", { exact: true }).first()).toBeVisible();

  // Akzeptiert → Auswahl/Bestellung, aber kein Auftrag (F10)
  await page.getByRole("button", { name: "Akzeptiert", exact: true }).click();
  await expect(page.getByText("Ein akzeptiertes Angebot ist noch kein Auftrag")).toBeVisible();
  await expect(page.getByText("Auswahl/Bestellung", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Noch kein Auftrag.", { exact: true })).toBeVisible();

  // Auftrag anlegen, Beauftragung mit Nachweis
  await page.locator("summary", { hasText: "Auftrag anlegen" }).click();
  await page.locator("#odStart").fill("2026-11-02");
  await page.getByRole("button", { name: "Auftrag anlegen", exact: true }).click();
  await expect(page.getByText("Auftrag in Vorbereitung angelegt")).toBeVisible();
  await page.locator("summary", { hasText: "Beauftragung bestätigen" }).click();
  await page.locator("input[name=orderReference]").first().fill(`PO-${suffix}`);
  await page.locator("input[name=evidenceText]").last().fill("Bestellung liegt als PDF im Auftragsordner; Laufzeit 02.11.–31.03.");
  await page.getByRole("button", { name: "Beauftragung bestätigen", exact: true }).click();
  await expect(page.getByText("Beauftragung mit Nachweis bestätigt")).toBeVisible();
  await expect(page.getByText("Beauftragt", { exact: true }).first()).toBeVisible();

  // Startbereit ohne Voraussetzungen scheitert (leere Prüfliste)
  await page.getByRole("button", { name: /Startbereit setzen/ }).click();
  await expect(page.getByText(/leere Prüfliste gilt nicht/)).toBeVisible();
  await page.locator("summary", { hasText: "Startvoraussetzung erfassen" }).click();
  await page.locator("input[name=requirement]").fill("Geheimhaltungsvereinbarung unterschrieben");
  await page.getByRole("button", { name: "Hinzufügen", exact: true }).click();
  await expect(page.getByText("Startvoraussetzung erfasst")).toBeVisible();
  await page.getByRole("button", { name: /Startbereit setzen/ }).click();
  await expect(page.getByText(/ohne bestätigten Nachweis/)).toBeVisible();
  await page.locator("summary", { hasText: "Nachweis / Stand setzen" }).click();
  await page.locator("input[name=evidenceText]").last().fill("NDA unterschrieben am 21.10., im Vertragsordner abgelegt.");
  await page.getByRole("button", { name: "Speichern", exact: true }).last().click();
  await expect(page.getByText("Stand der Startvoraussetzung gespeichert")).toBeVisible();
  await page.getByRole("button", { name: /Startbereit setzen/ }).click();
  await expect(page.getByText("Einsatz startbereit")).toBeVisible();

  // Gestartet als bestätigtes Ereignis
  await page.locator("input[name=note][placeholder*='Kick-off']").fill("Kick-off am 02.11. mit Frau Keller durchgeführt.");
  await page.getByRole("button", { name: "Start bestätigen" }).click();
  await expect(page.getByText("Start als bestätigtes Ereignis festgehalten")).toBeVisible();
  await expect(page.getByText("Gestartet", { exact: true }).first()).toBeVisible();
});
