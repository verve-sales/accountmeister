import { createHash, randomBytes } from "node:crypto";
import { getConfig } from "@/lib/config";

/**
 * Echter OAuth-Flow (Authorization Code mit PKCE) für die Microsoft-Graph-Anbindung – Entscheidung E-018.
 * Dieselbe App-Registrierung wie für die Unternehmensanmeldung wird wiederverwendet (siehe
 * `docs/installation-ionos.md` Schritt 4b): Mandant und Client-Zugangsdaten kommen aus OIDC_ISSUER,
 * OIDC_CLIENT_ID und OIDC_CLIENT_SECRET, nur die Umleitungs-URI ist eine zweite, eigene.
 * Kein Schreibrecht wird angefragt (kein Mail.Send, kein Calendars.ReadWrite).
 */
export const GRAPH_SCOPES = ["offline_access", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Mail.Read", "https://graph.microsoft.com/Calendars.Read"];

export function graphTenantId(cfg = getConfig()): string | null {
  if (!cfg.OIDC_ISSUER) return null;
  const m = cfg.OIDC_ISSUER.match(/^https:\/\/login\.microsoftonline\.com\/([^/]+)\//i);
  return m?.[1] ?? null;
}

/** Ob eine echte Verbindung technisch möglich ist (App-Registrierung/Anmeldedaten vorhanden). Ersetzt keine Datenschutzfreigabe. */
export function graphOAuthAvailable(cfg = getConfig()): boolean {
  return Boolean(cfg.OIDC_CLIENT_ID && cfg.OIDC_CLIENT_SECRET && graphTenantId(cfg));
}

/** Zweite, eigene Umleitungs-URI neben der für die Anmeldung – aus derselben öffentlichen Adresse abgeleitet. */
export function graphRedirectUri(cfg = getConfig()): string | null {
  if (!cfg.OIDC_REDIRECT_URI) return null;
  try {
    return new URL("/api/integrations/microsoft/callback", new URL(cfg.OIDC_REDIRECT_URI).origin).toString();
  } catch {
    return null;
  }
}

function endpoints(tenantId: string) {
  return {
    authorization_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
    token_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
  };
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type PendingMailConnect = { state: string; verifier: string; startedAt: number };

export function createPendingMailConnect(): PendingMailConnect {
  return { state: b64url(randomBytes(24)), verifier: b64url(randomBytes(48)), startedAt: Date.now() };
}

export function buildAuthorizationUrl(redirectUri: string, pending: PendingMailConnect, cfg = getConfig()): string {
  const tenantId = graphTenantId(cfg);
  if (!tenantId) throw new Error("Kein Microsoft-Mandant ermittelbar (OIDC_ISSUER).");
  const challenge = b64url(createHash("sha256").update(pending.verifier).digest());
  const u = new URL(endpoints(tenantId).authorization_endpoint);
  u.searchParams.set("client_id", cfg.OIDC_CLIENT_ID ?? "");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", GRAPH_SCOPES.join(" "));
  u.searchParams.set("state", pending.state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  // Immer erneut nach Zustimmung fragen: dieselbe App-Registrierung fragt sonst nur die Anmelde-Scopes ab.
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

export type GraphTokens = { access_token: string; refresh_token: string; expires_in: number; scope: string };

export async function exchangeCodeForGraphTokens(redirectUri: string, code: string, verifier: string, cfg = getConfig(), fetchImpl: typeof fetch = fetch): Promise<GraphTokens> {
  const tenantId = graphTenantId(cfg);
  if (!tenantId) throw new Error("Kein Microsoft-Mandant ermittelbar (OIDC_ISSUER).");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.OIDC_CLIENT_ID ?? "",
    client_secret: cfg.OIDC_CLIENT_SECRET ?? "",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: GRAPH_SCOPES.join(" "),
  });
  const res = await fetchImpl(endpoints(tenantId).token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Token-Austausch fehlgeschlagen (${res.status})`);
  const json = (await res.json()) as Partial<GraphTokens>;
  if (!json.access_token || !json.refresh_token) throw new Error("Unvollständige Token-Antwort des Identitätsanbieters.");
  return { access_token: json.access_token, refresh_token: json.refresh_token, expires_in: json.expires_in ?? 3600, scope: json.scope ?? "" };
}

export type RefreshedGraphTokens = { access_token: string; refresh_token: string; expires_in: number };

export async function refreshGraphAccessToken(refreshToken: string, cfg = getConfig(), fetchImpl: typeof fetch = fetch): Promise<RefreshedGraphTokens> {
  const tenantId = graphTenantId(cfg);
  if (!tenantId) throw new Error("Kein Microsoft-Mandant ermittelbar (OIDC_ISSUER).");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: cfg.OIDC_CLIENT_ID ?? "",
    client_secret: cfg.OIDC_CLIENT_SECRET ?? "",
    refresh_token: refreshToken,
    scope: GRAPH_SCOPES.join(" "),
  });
  const res = await fetchImpl(endpoints(tenantId).token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Token-Erneuerung fehlgeschlagen (${res.status})`);
  const json = (await res.json()) as Partial<RefreshedGraphTokens>;
  if (!json.access_token) throw new Error("Unvollständige Token-Antwort des Identitätsanbieters.");
  // Microsoft liefert bei Rotation ein neues Refresh-Token; wird keins geliefert, bleibt das alte gültig.
  return { access_token: json.access_token, refresh_token: json.refresh_token ?? refreshToken, expires_in: json.expires_in ?? 3600 };
}
