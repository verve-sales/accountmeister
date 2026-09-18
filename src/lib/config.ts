import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL fehlt"),
  AUTH_MODE: z.enum(["development", "oidc"]).default("development"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET muss mindestens 32 Zeichen haben"),
  AI_PROVIDER: z.enum(["disabled", "test", "production"]).default("disabled"),
  /** Nutzungsgrenze: KI-Aufträge je Arbeitsraum und Tag (Briefing 17.4) */
  AI_DAILY_JOB_LIMIT: z.coerce.number().int().min(1).max(100000).default(200),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

/**
 * Liest und validiert die Konfiguration. Unsichere Produktivkonfigurationen
 * (Entwicklungsanmeldung oder Test-KI in Produktion) führen zum Abbruch (Briefing 17.4, S09).
 */
export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error("Ungültige Konfiguration: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const cfg = parsed.data;
  assertSafeForEnvironment(cfg);
  cached = cfg;
  return cfg;
}

export function assertSafeForEnvironment(cfg: Pick<AppConfig, "NODE_ENV" | "AUTH_MODE" | "AI_PROVIDER" | "SESSION_SECRET">): void {
  if (cfg.NODE_ENV !== "production") return;
  const problems: string[] = [];
  if (cfg.AUTH_MODE === "development") problems.push("AUTH_MODE=development ist in Produktion nicht zulässig");
  if (cfg.AI_PROVIDER === "test") problems.push("AI_PROVIDER=test ist in Produktion nicht zulässig");
  if (cfg.SESSION_SECRET.startsWith("entwicklung-")) problems.push("SESSION_SECRET ist der Entwicklungs-Beispielwert");
  if (problems.length > 0) throw new Error("Start verweigert – unsichere Produktivkonfiguration: " + problems.join("; "));
}

export function resetConfigCacheForTests(): void {
  cached = undefined;
}
