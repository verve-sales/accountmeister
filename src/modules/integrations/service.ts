import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/audit";
import type { Actor } from "@/modules/identity/actor";
import { hasAnyContentRole } from "@/modules/identity/actor";
import { getMailCalendarAdapter, AdapterError } from "./index";
import type { SelectableKind } from "./adapter";

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
    const items = await getMailCalendarAdapter().listSelectable({ tokenRef: conn.tokenRef, fixture: conn.fixtureMode, kind, query, limit: 25 });
    await db.update(schema.integrationConnections).set({ lastSuccessfulFetchAt: new Date(), lastError: null }).where(eq(schema.integrationConnections.id, conn.id));
    return { connection: conn, items };
  } catch (e) {
    const err = adapterErrorToDomain(e);
    await db.update(schema.integrationConnections).set({ lastError: err.message, status: err.code === "ADAPTER_AUTH" ? "ABGELAUFEN" : conn.status, updatedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
    throw err;
  }
}
