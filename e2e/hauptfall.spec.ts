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
  await page.getByRole("link", { name: "Kunden" }).click();
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
