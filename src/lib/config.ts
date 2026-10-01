import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL fehlt"),
  AUTH_MODE: z.enum(["development", "oidc"]).default("development"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET muss mindestens 32 Zeichen haben"),
  /** KI-Anbieter: disabled | test (nur Entwicklung) | langdock (Produktiv, OpenAI-kompatible API von Langdock) | production (gesperrter Platzhalter) */
  AI_PROVIDER: z.enum(["disabled", "test", "langdock", "production"]).default("disabled"),
  /** Langdock: API-Schlüssel (nur auf dem Server) und Basis-URL der OpenAI-kompatiblen Schnittstelle (Region eu) */
  LANGDOCK_API_KEY: z.string().min(1).optional(),
  LANGDOCK_BASE_URL: z.string().url().default("https://api.langdock.com/openai/eu/v1"),
  /** Standardmodell, wenn für eine Aufgabe noch keines konfiguriert ist (Verwaltung → KI) */
  LANGDOCK_DEFAULT_MODEL: z.string().default("gpt-4o-mini"),
  /** Ablage hochgeladener Dokumente (außerhalb des Codes; im Container ein Volume) */
  UPLOAD_DIR: z.string().default("./data/uploads"),
  /** Maximale Dateigröße je Upload in Megabyte */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(25),
  /** Nutzungsgrenze: KI-Aufträge je Arbeitsraum und Tag (Briefing 17.4) */
  AI_DAILY_JOB_LIMIT: z.coerce.number().int().min(1).max(100000).default(200),
  /** Unternehmensanmeldung (OIDC, Microsoft Entra ID): nur bei AUTH_MODE=oidc erforderlich */
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  /** Kommagetrennte E-Mail-Adressen, die beim ersten Anmelden die Verwaltungsrolle (ADMIN) erhalten */
  ADMIN_EMAILS: z.string().optional(),
  /** Unbekannte, erfolgreich angemeldete Personen als Zugang ohne Rolle anlegen (Standard: nein) */
  OIDC_AUTO_CREATE_USERS: z.enum(["true", "false"]).default("false"),
  /** Name des Arbeitsraums, der beim ersten Admin-Login angelegt wird, falls keiner existiert */
  WORKSPACE_NAME: z.string().default("Verve Consulting"),
  /** Basis-URL für Links in E-Mails (sonst aus OIDC_REDIRECT_URI abgeleitet) */
  APP_BASE_URL: z.string().url().optional(),
  /** E-Mail-Versand der Benachrichtigungen: off (Standard) | file (Entwicklung, schreibt .eml-Dateien) | graph (Microsoft Graph, Mail.Send) */
  MAIL_TRANSPORT: z.enum(["off", "file", "graph"]).default("off"),
  /** Absender-Postfach für Graph (UPN, z. B. accountmeister@verveconsulting.de) */
  MAIL_SENDER: z.string().email().optional(),
  MAIL_FILE_DIR: z.string().default("./data/mails"),
  /** Mandant für Graph; Standard: aus OIDC_ISSUER */
  MAIL_GRAPH_TENANT_ID: z.string().min(1).optional(),
  /** Uhrzeit (Europe/Berlin) des Tagesdigests */
  MAIL_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(7),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

/**
 * Liest und validiert die Konfiguration. Unsichere Produktivkonfigurationen
 * (Entwicklungsanmeldung oder Test-KI in Produktion) führen zum Abbruch (Briefing 17.4, S09).
 */
/** Leere Werte (z. B. `LANGDOCK_API_KEY=` aus Compose) gelten als nicht gesetzt, damit Standardwerte und Optionalität greifen. */
export function normalizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== "") out[k] = v;
  return out;
}

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(normalizeEnv(process.env));
  if (!parsed.success) {
    throw new Error("Ungültige Konfiguration: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const cfg = parsed.data;
  assertSafeForEnvironment(cfg);
  cached = cfg;
  return cfg;
}

export function assertSafeForEnvironment(cfg: Pick<AppConfig, "NODE_ENV" | "AUTH_MODE" | "AI_PROVIDER" | "SESSION_SECRET"> & Partial<Pick<AppConfig, "OIDC_ISSUER" | "OIDC_CLIENT_ID" | "OIDC_CLIENT_SECRET" | "OIDC_REDIRECT_URI" | "LANGDOCK_API_KEY">>): void {
  const problems: string[] = [];
  if (cfg.AI_PROVIDER === "langdock" && !cfg.LANGDOCK_API_KEY) problems.push("AI_PROVIDER=langdock verlangt LANGDOCK_API_KEY");
  if (cfg.AUTH_MODE === "oidc") {
    const missing = (["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI"] as const).filter((k) => !cfg[k]);
    if (missing.length > 0) problems.push("AUTH_MODE=oidc verlangt: " + missing.join(", "));
  }
  if (cfg.NODE_ENV === "production") {
    if (cfg.AUTH_MODE === "development") problems.push("AUTH_MODE=development ist in Produktion nicht zulässig");
    if (cfg.AI_PROVIDER === "test") problems.push("AI_PROVIDER=test ist in Produktion nicht zulässig");
    if (cfg.SESSION_SECRET.startsWith("entwicklung-")) problems.push("SESSION_SECRET ist der Entwicklungs-Beispielwert");
  }
  if (problems.length > 0) throw new Error("Start verweigert – unsichere Konfiguration: " + problems.join("; "));
}

export function resetConfigCacheForTests(): void {
  cached = undefined;
}
