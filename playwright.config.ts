import { defineConfig } from "@playwright/test";

// Der vorinstallierte Chromium in dieser Entwicklungsumgebung kann über
// PW_CHROMIUM_PATH gesetzt werden; ohne Variable nutzt Playwright seinen Standard.
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    // Entwicklungsserver: Die Entwicklungsanmeldung ist unter NODE_ENV=production bewusst gesperrt (S09).
    command: "npx next dev -p 3100",
    url: "http://localhost:3100/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
