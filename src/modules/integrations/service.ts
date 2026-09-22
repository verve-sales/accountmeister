import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { hasAnyContentRole } from "@/modules/identity/actor";
import { getMailCalendarAdapter, AdapterError } from "./index";
import type { SelectableKind } from "./adapter";
import { fetchGraphMe } from "./graph/client";
import { buildAuthorizationUrl, createPendingMailConnect, exchangeCodeForGraphTokens, graphOAuthAvailable, graphRedirectUri, refreshGraphAccessToken, type PendingMailConnect } from "./graph/oauth";
import { decryptRefreshToken, encryptRefreshToken } from "./graph/tokenCrypto";

type IntegrationConnectionRow = typeof schema.integrationConnections.$inferSelect;

/**
 * Persönliche Anbieterverbindung (Briefing 13.1/13.4): Nur der Nutzer selbst verbindet, sieht und widerruft sein Postfach.
 * Kein pauschales Einlesen; die Verbindung liefert nur eine Auswahl-Liste, aus der einzelne Objekte importiert werden.
 */

export function adapterErrorToDomain(e: unknown): DomainError {
  if (e instanceof AdapterError) {
    const map: Record<AdapterError["kind"], number> = { AUTH: 401, RATE_LIMIT: 429, TEMPORARY: 503, NOT_FOUND: 404, NOT_CONFIGURED: 409, UNSAFE_CONTENT: 422 };
    return new DomainError(`ADAPTER_${e.kind}`, e.message, map[e.kind]);
  }
  return new DomainError("ADAPTER_ERROR", "Anbieterfehler. Bitte später erneut versuchen.", 503);
}

export async function getMyConnection(actor: Actor) {
  const conn = await db.query.integrationConnections.findFirst({ where: and(eq(schema.integrationConnections.userId, actor.userId), eq(schema.integrationConnections.provider, "MICROSOFT_GRAPH")) });
  const adapter = getMailCalendarAdapter();
  const state = await adapter.status(conn?.tokenRef ?? null, conn?.fixtureMode ?? true);
  return { connection: conn ?? null, state, requestedScopes: adapter.requestedScopes() };
}

/** Verbinden – im Pilot ausschließlich Fixture-Modus; ein echter Verbindungsversuch wird ehrlich abgewiesen. */
export async function connectMailbox(actor: Actor, opts: { fixture: boolean }) {
  if (!hasAnyContentRole(actor)) throw new ForbiddenError("Nur fachliche Rollen verbinden ein Postfach.");
  const adapter = getMailCalendarAdapter();
  let result;
  try {
    result = await adapter.connect({ userEmail: actor.email, fixture: opts.fixture });
  } catch (e) {
    throw adapterErrorToDomain(e);
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.integrationConnections)
      .values({
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        provider: "MICROSOFT_GRAPH",
        grantedScopes: result.state.grantedScopes,
        tokenRef: result.tokenRef ?? null,
        accountLabel: result.state.accountLabel,
        status: opts.fixture ? "VERBUNDEN_FIXTURE" : "VERBUNDEN",
        fixtureMode: opts.fixture,
      })
      .onConflictDoUpdate({
        target: [schema.integrationConnections.userId, schema.integrationConnections.provider],
        set: { grantedScopes: result.state.grantedScopes, tokenRef: result.tokenRef ?? null, accountLabel: result.state.accountLabel, status: opts.fixture ? "VERBUNDEN_FIXTURE" : "VERBUNDEN", fixtureMode: opts.fixture, lastError: null, updatedAt: new Date() },
      })
      .returning();
    await recordAudit(tx, actor, "integration.connected", "INTEGRATION", row?.id ?? "?", { provider: "MICROSOFT_GRAPH", fixture: opts.fixture, scopes: result.state.grantedScopes });
    return row;
  });
}

/**
 * Echter Verbindungsaufbau, Schritt 1: Autorisierungs-URL erzeugen. Der eigentliche Verbindungsaufbau (Token
 * entgegennehmen, verschlüsselt speichern) passiert erst in `completeMailboxConnect`, nach der Rückkehr von
 * Microsoft (Route-Handler `/api/integrations/microsoft/callback`) – vorher liegt noch kein Token vor.
 */
export async function beginMailboxConnect(actor: Actor): Promise<{ authorizationUrl: string; pending: PendingMailConnect }> {
  if (!hasAnyContentRole(actor)) throw new ForbiddenError("Nur fachliche Rollen verbinden ein Postfach.");
  if (!graphOAuthAvailable()) {
    throw new DomainError("ADAPTER_NOT_CONFIGURED", "Microsoft-Graph-Anbindung ist noch nicht konfiguriert (App-Registrierung, Client-ID, Redirect-URI und Datenschutzfreigabe fehlen).", 409);
  }
  const redirectUri = graphRedirectUri();
  if (!redirectUri) throw new DomainError("ADAPTER_NOT_CONFIGURED", "Keine öffentliche Adresse (OIDC_REDIRECT_URI) konfiguriert.", 409);
  const pending = createPendingMailConnect();
  return { authorizationUrl: buildAuthorizationUrl(redirectUri, pending), pending };
}

/** Echter Verbindungsaufbau, Schritt 2: Code gegen Tokens tauschen, Postfach-Kennung abrufen, verschlüsselt speichern. */
export async function completeMailboxConnect(actor: Actor, code: string, verifier: string) {
  if (!hasAnyContentRole(actor)) throw new ForbiddenError("Nur fachliche Rollen verbinden ein Postfach.");
  const redirectUri = graphRedirectUri();
  if (!redirectUri) throw new DomainError("ADAPTER_NOT_CONFIGURED", "Keine öffentliche Adresse (OIDC_REDIRECT_URI) konfiguriert.", 409);
  let tokens;
  try {
    tokens = await exchangeCodeForGraphTokens(redirectUri, code, verifier);
  } catch {
    throw new DomainError("ADAPTER_AUTH", "Der Token-Austausch mit Microsoft ist fehlgeschlagen. Bitte erneut versuchen.", 401);
  }
  let me: Awaited<ReturnType<typeof fetchGraphMe>>;
  try {
    me = await fetchGraphMe(tokens.access_token);
  } catch {
    throw new DomainError("ADAPTER_AUTH", "Postfach konnte nicht bestätigt werden.", 401);
  }
  const accountLabel = me.mail ?? me.userPrincipalName ?? me.displayName ?? actor.email;
  const grantedScopes = tokens.scope.split(" ").filter(Boolean);
  const tokenRef = encryptRefreshToken(tokens.refresh_token);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.integrationConnections)
      .values({ workspaceId: actor.workspaceId, userId: actor.userId, provider: "MICROSOFT_GRAPH", grantedScopes, tokenRef, accountLabel, status: "VERBUNDEN", fixtureMode: false })
      .onConflictDoUpdate({
        target: [schema.integrationConnections.userId, schema.integrationConnections.provider],
        set: { grantedScopes, tokenRef, accountLabel, status: "VERBUNDEN", fixtureMode: false, lastError: null, lastSuccessfulFetchAt: null, updatedAt: new Date() },
      })
      .returning();
    await recordAudit(tx, actor, "integration.connected", "INTEGRATION", row?.id ?? "?", { provider: "MICROSOFT_GRAPH", fixture: false, scopes: grantedScopes });
    return row;
  });
}

/**
 * Liefert das für einen Abruf zu verwendende Token: im Fixture-Modus unverändert die Fixture-Referenz, sonst ein
 * frisches Access-Token, das per Refresh-Token bei Microsoft besorgt wird. Rotiert Microsoft dabei das Refresh-Token,
 * wird die verschlüsselte Ablage sofort aktualisiert – das ist die einzige Stelle, die das tut.
 */
async function resolveCallToken(conn: IntegrationConnectionRow): Promise<string> {
  if (conn.fixtureMode) return conn.tokenRef ?? "";
  if (!conn.tokenRef) throw new AdapterError("AUTH", "Keine Verbindung. Bitte zuerst verbinden.");
  let refreshToken: string;
  try {
    refreshToken = decryptRefreshToken(conn.tokenRef);
  } catch {
    throw new AdapterError("AUTH", "Der gespeicherte Zugang ist ungültig. Bitte Verbindung neu herstellen.");
  }
  let refreshed;
  try {
    refreshed = await refreshGraphAccessToken(refreshToken);
  } catch {
    throw new AdapterError("AUTH", "Microsoft hat die Verbindung nicht mehr bestätigt. Bitte erneut verbinden.");
  }
  if (refreshed.refresh_token !== refreshToken) {
    await db.update(schema.integrationConnections).set({ tokenRef: encryptRefreshToken(refreshed.refresh_token), updatedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
  }
  return refreshed.access_token;
}

export async function revokeMailbox(actor: Actor) {
  const conn = await db.query.integrationConnections.findFirst({ where: and(eq(schema.integrationConnections.userId, actor.userId), eq(schema.integrationConnections.provider, "MICROSOFT_GRAPH")) });
  if (!conn) throw new NotFoundError("Verbindung");
  try {
    await getMailCalendarAdapter().revoke(conn.tokenRef);
  } catch (e) {
    throw adapterErrorToDomain(e);
  }
  return db.transaction(async (tx) => {
    await tx.update(schema.integrationConnections).set({ status: "WIDERRUFEN", tokenRef: null, grantedScopes: [], updatedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
    await recordAudit(tx, actor, "integration.revoked", "INTEGRATION", conn.id);
  });
}

/** Auswählbare Objekte des eigenen Postfachs – nur Metadaten und Textvorschau; nichts wird gespeichert. */
export async function listSelectable(actor: Actor, kind: SelectableKind, query?: string) {
  const conn = await db.query.integrationConnections.findFirst({ where: and(eq(schema.integrationConnections.userId, actor.userId), eq(schema.integrationConnections.provider, "MICROSOFT_GRAPH")) });
  if (!conn || conn.status === "WIDERRUFEN" || !conn.tokenRef) throw new ValidationError("Kein verbundenes Postfach. Bitte zuerst unter Einstellungen verbinden.");
  try {
    const callToken = await resolveCallToken(conn);
    const items = await getMailCalendarAdapter().listSelectable({ tokenRef: callToken, fixture: conn.fixtureMode, kind, query, limit: 25 });
    await db.update(schema.integrationConnections).set({ lastSuccessfulFetchAt: new Date(), lastError: null }).where(eq(schema.integrationConnections.id, conn.id));
    return { connection: conn, items };
  } catch (e) {
    const err = adapterErrorToDomain(e);
    await db.update(schema.integrationConnections).set({ lastError: err.message, status: err.code === "ADAPTER_AUTH" ? "ABGELAUFEN" : conn.status, updatedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
    throw err;
  }
}

/** Für den Importschritt (`modules/imports/service.ts`): dieselbe Token-Auflösung, damit sie nicht doppelt existiert. */
export async function resolveMailboxCallToken(conn: IntegrationConnectionRow): Promise<string> {
  return resolveCallToken(conn);
}
