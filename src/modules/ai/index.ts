import { getConfig } from "@/lib/config";
import type { AIProvider } from "./provider";
import { DisabledProvider } from "./providers/disabled";
import { TestProvider } from "./providers/test";
import { ProductionProvider } from "./providers/production";

/** Auswahl des Anbieters ausschließlich über Konfiguration (AI_PROVIDER). In Produktion ist „test“ gesperrt (getConfig). */
export function getAIProvider(): AIProvider {
  const cfg = getConfig();
  switch (cfg.AI_PROVIDER) {
    case "test":
      return new TestProvider();
    case "production":
      return new ProductionProvider();
    default:
      return new DisabledProvider();
  }
}
