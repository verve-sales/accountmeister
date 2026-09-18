import { createHash } from "node:crypto";
import { AdapterError, type ConnectionState, type FetchedSource, type MailCalendarAdapter, type SelectableItem, type SelectableKind } from "../adapter";
import { FIXTURE_EVENTS, FIXTURE_MAILS, toSelectable } from "./fixtures";

/**
 * Microsoft-Graph-Adapter (Outlook / Microsoft 365) – Entscheidung E-018.
 *
 * Stand: Struktur, Berechtigungen und Datenfluss sind vollständig; der echte Abruf ist bewusst NICHT aktiviert.
 * Voraussetzungen für den Echtbetrieb (außerhalb dieses Codes): App-Registrierung im Verve-Tenant (Entra ID),
 * Client-ID/Tenant-ID/Redirect-URI in der Konfiguration, Freigabe der delegierten Berechtigungen, Datenschutzbewertung.
 * Bis dahin liefert der Adapter Fixtures und kennzeichnet dies in jedem Verbindungsstatus (fixtureMode=true).
 *
 * Minimale delegierte Berechtigungen (lesend): Mail.Read, Calendars.Read, User.Read, offline_access.
 * Keine Schreibrechte (kein Mail.Send, kein Calendars.ReadWrite).
 */
const REQUESTED_SCOPES = ["User.Read", "Mail.Read", "Calendars.Read", "offline_access"];

export class GraphAdapter implements MailCalendarAdapter {
  readonly providerId = "MICROSOFT_GRAPH" as const;

  requestedScopes(): string[] {
    return [...REQUESTED_SCOPES];
  }

  async connect(input: { userEmail: string; fixture: boolean }) {
    if (!input.fixture) {
      // Echter OAuth-Flow ist bis zur App-Registrierung nicht konfiguriert – ehrlich verweigern statt still Fixtures liefern.
      throw new AdapterError("NOT_CONFIGURED", "Microsoft-Graph-Anbindung ist noch nicht konfiguriert (App-Registrierung, Client-ID, Redirect-URI und Datenschutzfreigabe fehlen).");
    }
    const tokenRef = `fixture:${createHash("sha256").update(input.userEmail).digest("hex").slice(0, 16)}`;
    return { state: await this.status(tokenRef, true), tokenRef };
  }

  async status(tokenRef: string | null, fixture: boolean): Promise<ConnectionState> {
    if (!tokenRef) return { connected: false, fixtureMode: fixture, accountLabel: null, grantedScopes: [], requestedScopes: REQUESTED_SCOPES, expiresAt: null, lastError: null };
    return {
      connected: true,
      fixtureMode: fixture,
      accountLabel: fixture ? "Fixture-Postfach (fiktiv) – kein echter Abruf" : null,
      grantedScopes: fixture ? REQUESTED_SCOPES : [],
      requestedScopes: REQUESTED_SCOPES,
      expiresAt: null,
      lastError: null,
    };
  }

  async listSelectable(input: { tokenRef: string | null; fixture: boolean; kind: SelectableKind; query?: string; limit?: number }): Promise<SelectableItem[]> {
    this.assertFixture(input.fixture, input.tokenRef);
    const all = (input.kind === "MAIL" ? FIXTURE_MAILS : FIXTURE_EVENTS).map(toSelectable);
    const q = input.query?.toLowerCase().trim();
    const filtered = q ? all.filter((s) => s.subject.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q) || (s.from?.name.toLowerCase().includes(q) ?? false)) : all;
    return filtered.slice(0, input.limit ?? 25);
  }

  async fetch(input: { tokenRef: string | null; fixture: boolean; kind: SelectableKind; externalId: string }): Promise<FetchedSource> {
    this.assertFixture(input.fixture, input.tokenRef);
    const found = (input.kind === "MAIL" ? FIXTURE_MAILS : FIXTURE_EVENTS).find((s) => s.externalId === input.externalId);
    if (!found) throw new AdapterError("NOT_FOUND", "Quelle nicht (mehr) zugänglich.");
    return { ...found, bodyText: sanitizeToText(found.bodyText) };
  }

  async detectChange(input: { tokenRef: string | null; fixture: boolean; kind: SelectableKind; externalId: string; knownHash: string }) {
    const current = await this.fetch(input);
    return { changed: current.contentHash !== input.knownHash, currentHash: current.contentHash };
  }

  async revoke(_tokenRef: string | null): Promise<void> {
    void _tokenRef; // Fixture: nichts zu widerrufen; echt: Token beim Anbieter invalidieren und lokal löschen
  }

  private assertFixture(fixture: boolean, tokenRef: string | null) {
    if (!tokenRef) throw new AdapterError("AUTH", "Keine Verbindung. Bitte zuerst verbinden.");
    if (!fixture) throw new AdapterError("NOT_CONFIGURED", "Echter Abruf ist nicht konfiguriert.");
  }
}

/**
 * Sicherheitsregel 17.4: kein ungeprüftes HTML aus Mails, keine Trackingbilder, keine Skripte, keine serverseitigen Link-Abrufe.
 * Der Import übernimmt ausschließlich Nur-Text; Links bleiben als Text stehen und werden nie abgerufen.
 */
export function sanitizeToText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<img[^>]*>/gi, " [Bild entfernt] ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
