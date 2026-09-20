import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { db, schema } from "@/db/client";
import { getConfig } from "@/lib/config";
import { ForbiddenError } from "@/lib/errors";

/**
 * Unternehmensanmeldung über OpenID Connect (Microsoft Entra ID / Microsoft 365).
 * Ablauf: Authorization Code mit PKCE, State und Nonce in der verschlüsselten Sitzung;
 * ID-Token wird gegen die JWKS des Ausstellers geprüft (Aussteller, Zielgruppe, Nonce, Ablauf).
 * Zuordnung zu einem Zugang: zuerst stabile Kennung (oid/sub), dann E-Mail. Rollen kommen nie aus dem
 * Token, sondern aus der Rollenverwaltung (Briefing 16.2); Ausnahme: ADMIN_EMAILS erhalten beim ersten
 * Anmelden die Verwaltungsrolle, damit der Erstzugang ohne Datenbankeingriff möglich ist.
 */

export type DiscoveryDocument = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
};

const discoveryCache = new Map<string, { doc: DiscoveryDocument; fetchedAt: number }>();

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<DiscoveryDocument> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) return cached.doc;
  const url = issuer.replace(/\/$/, "") + "/.well-known/openid-configuration";
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OIDC-Discovery fehlgeschlagen (${res.status})`);
  const doc = (await res.json()) as DiscoveryDocument;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error("OIDC-Discovery unvollständig");
  discoveryCache.set(issuer, { doc, fetchedAt: Date.now() });
  return doc;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type PendingLogin = { state: string; nonce: string; verifier: string; returnTo: string; startedAt: number };

export function createPendingLogin(returnTo = "/start"): PendingLogin {
  return { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(48)), returnTo: returnTo.startsWith("/") ? returnTo : "/start", startedAt: Date.now() };
}

export function buildAuthorizationUrl(doc: DiscoveryDocument, pending: PendingLogin, cfg = getConfig()): string {
  const challenge = b64url(createHash("sha256").update(pending.verifier).digest());
  const u = new URL(doc.authorization_endpoint);
  u.searchParams.set("client_id", cfg.OIDC_CLIENT_ID ?? "");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", cfg.OIDC_REDIRECT_URI ?? "");
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", "openid profile email");
  u.searchParams.set("state", pending.state);
  u.searchParams.set("nonce", pending.nonce);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export type IdentityClaims = { subject: string; email: string; displayName: string; tenantId?: string };

/** Code gegen Token tauschen und ID-Token prüfen. Kein Access-Token wird gespeichert – wir brauchen nur die Identität. */
export async function exchangeCode(doc: DiscoveryDocument, code: string, pending: PendingLogin, cfg = getConfig(), fetchImpl: typeof fetch = fetch): Promise<IdentityClaims> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.OIDC_CLIENT_ID ?? "",
    client_secret: cfg.OIDC_CLIENT_SECRET ?? "",
    code,
    redirect_uri: cfg.OIDC_REDIRECT_URI ?? "",
    code_verifier: pending.verifier,
  });
  const res = await fetchImpl(doc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new ForbiddenError("Die Anmeldung wurde vom Identitätsanbieter nicht bestätigt.");
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new ForbiddenError("Kein ID-Token erhalten.");
  const jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
  const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: doc.issuer, audience: cfg.OIDC_CLIENT_ID, clockTolerance: 60 });
  return claimsFromPayload(payload, pending.nonce);
}

export function claimsFromPayload(payload: JWTPayload, expectedNonce: string): IdentityClaims {
  if (payload.nonce !== expectedNonce) throw new ForbiddenError("Anmeldeantwort passt nicht zur gestarteten Anmeldung (Nonce).");
  const p = payload as JWTPayload & { oid?: string; preferred_username?: string; email?: string; upn?: string; name?: string; tid?: string };
  const subject = p.oid ?? p.sub;
  if (!subject) throw new ForbiddenError("ID-Token ohne Subjekt.");
  const email = (p.email ?? p.preferred_username ?? p.upn ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) throw new ForbiddenError("Der Identitätsanbieter hat keine E-Mail-Adresse geliefert.");
  return { subject, email, displayName: (p.name ?? email).trim(), tenantId: p.tid };
}

export function adminEmails(cfg = getConfig()): Set<string> {
  return new Set((cfg.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}

/**
 * Identität einem Zugang zuordnen. Rückgabe: userId oder Fehler mit klarer Begründung.
 * Kein Zugang → keine Rolle → kein Inhalt. Erst-Admin über ADMIN_EMAILS; optional automatische Anlage ohne Rolle.
 */
export async function resolveOidcUser(claims0: IdentityClaims, cfg = getConfig()): Promise<{ userId: string; created: boolean; madeAdmin: boolean }> {
  const claims = { ...claims0, email: claims0.email.trim().toLowerCase() };
  const admins = adminEmails(cfg);
  const isAdminEmail = admins.has(claims.email);
  return db.transaction(async (tx) => {
    let user = await tx.query.users.findFirst({ where: eq(schema.users.externalSubject, claims.subject) });
    if (!user) {
      user = await tx.query.users.findFirst({ where: sql`lower(${schema.users.email}) = ${claims.email}` });
      if (user && user.externalSubject && user.externalSubject !== claims.subject) throw new ForbiddenError("Diese E-Mail-Adresse ist bereits einer anderen Identität zugeordnet.");
      if (user) await tx.update(schema.users).set({ externalSubject: claims.subject }).where(eq(schema.users.id, user.id));
    }
    let created = false;
    let madeAdmin = false;
    if (!user) {
      if (!isAdminEmail && cfg.OIDC_AUTO_CREATE_USERS !== "true") throw new ForbiddenError("Für diese Anmeldung ist noch kein Zugang eingerichtet. Bitte an die Betriebsverwaltung wenden.");
      let ws = await tx.query.workspaces.findFirst();
      if (!ws) {
        if (!isAdminEmail) throw new ForbiddenError("Der Arbeitsraum ist noch nicht eingerichtet.");
        [ws] = await tx.insert(schema.workspaces).values({ name: cfg.WORKSPACE_NAME }).returning();
      }
      if (!ws) throw new Error("Arbeitsraum");
      [user] = await tx.insert(schema.users).values({ workspaceId: ws.id, email: claims.email, displayName: claims.displayName, externalSubject: claims.subject }).returning();
      created = true;
    }
    if (!user) throw new Error("Zugang");
    if (user.status !== "ACTIVE") throw new ForbiddenError("Dieser Zugang ist deaktiviert.");
    if (isAdminEmail) {
      const hasAdmin = await tx.query.roleAssignments.findFirst({ where: and(eq(schema.roleAssignments.userId, user.id), eq(schema.roleAssignments.role, "ADMIN")) });
      if (!hasAdmin) {
        await tx.insert(schema.roleAssignments).values({ workspaceId: user.workspaceId, userId: user.id, role: "ADMIN", scope: "WORKSPACE" });
        madeAdmin = true;
      }
    }
    await tx.update(schema.users).set({ lastLoginAt: new Date(), displayName: user.displayName || claims.displayName, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
    await tx.insert(schema.auditEvents).values({ workspaceId: user.workspaceId, actorUserId: user.id, action: created ? "user.first_login" : "user.login", objectType: "USER", objectId: user.id, changes: madeAdmin ? { adminBootstrap: true } : null });
    return { userId: user.id, created, madeAdmin };
  });
}

export function buildLogoutUrl(doc: DiscoveryDocument, postLogoutRedirect: string): string | null {
  if (!doc.end_session_endpoint) return null;
  const u = new URL(doc.end_session_endpoint);
  u.searchParams.set("post_logout_redirect_uri", postLogoutRedirect);
  return u.toString();
}
