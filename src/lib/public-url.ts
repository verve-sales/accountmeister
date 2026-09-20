import { getConfig } from "@/lib/config";

/**
 * Öffentliche Basisadresse für Weiterleitungen aus Route-Handlern. Hinter dem Reverse-Proxy ist `req.url`
 * die interne Adresse (http://localhost:3000); wir nehmen deshalb den Ursprung aus OIDC_REDIRECT_URI, sonst
 * die vom Proxy gesetzten Forwarded-Header, zuletzt die Anfrage-URL (lokale Entwicklung).
 */
export function publicUrl(path: string, req: Request): URL {
  const cfg = getConfig();
  if (cfg.OIDC_REDIRECT_URI) return new URL(path, new URL(cfg.OIDC_REDIRECT_URI).origin);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? (host && !/^(localhost|127\.0\.0\.1)/.test(host) ? "https" : "http");
  if (host) return new URL(path, `${proto}://${host}`);
  return new URL(path, req.url);
}
