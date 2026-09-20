import { getConfig } from "@/lib/config";
import type { AIProvider } from "./provider";
import { DisabledProvider } from "./providers/disabled";
import { TestProvider } from "./providers/test";
import { ProductionProvider } from "./providers/production";
import { LangdockProvider } from "./providers/langdock";

/**
 * Auswahl des Anbieters ausschließlich über Konfiguration (AI_PROVIDER). In Produktion ist „test“ gesperrt (getConfig).
 * „langdock“ ist der freigegebene Produktivanbieter (Entscheidung E-037); „production“ bleibt der gesperrte Platzhalter.
 */
export function getAIProvider(): AIProvider {
  const cfg = getConfig();
  switch (cfg.AI_PROVIDER) {
    case "test":
      return new TestProvider();
    case "langdock":
      return new LangdockProvider({ apiKey: cfg.LANGDOCK_API_KEY ?? "", baseUrl: cfg.LANGDOCK_BASE_URL, defaultModel: cfg.LANGDOCK_DEFAULT_MODEL });
    case "production":
      return new ProductionProvider();
    default:
      return new DisabledProvider();
  }
}
