import { createHash } from "node:crypto";
import { AdapterError, type ConnectionState, type FetchedSource, type MailCalendarAdapter, type SelectableItem, type SelectableKind } from "../adapter";
import { FIXTURE_EVENTS, FIXTURE_MAILS, toSelectable } from "./fixtures";
import { fetchRealSource, listRealSelectable } from "./client";
import { GRAPH_SCOPES, graphOAuthAvailable } from "./oauth";

/**
 * Microsoft-Graph-Adapter (Outlook / Microsoft 365) – Entscheidung E-018.
 *
 * Fixture-Modus (fixtureMode=true): keine Berechtigungen, keine Anmeldedaten nötig; liefert erfundene
 * Testdaten und kennzeichnet dies in jedem Verbindungsstatus.
 *
 * Echter Modus (fixtureMode=false): erst möglich, seit die Pilotfreigabe den M365-Postfach-/Kalenderimport
 * ausdrücklich erlaubt UND die App-Registrierung in Entra ID die Berechtigungen Mail.Read/Calendars.Read/
 * offline_access hat (`docs/installation-ionos.md` Schritt 4b). Der eigentliche OAuth-Austausch (Autorisierungs-URL,
 * Code-Tausch, Refresh) läuft in `graph/oauth.ts` und wird vom Service-Layer orchestriert (dort liegt die
 * Verschlüsselung des Refresh-Tokens und die einzige Datenbankberührung – der Adapter selbst kennt keine
 * Datenbank). Für die Methoden hier gilt deshalb eine Namenskonvention: `tokenRef` ist im Fixture-Modus die
 * interne Fixture-Referenz, im echten Modus dagegen ein bereits gültiges, kurzlebiges Access-Token, das der
 * Service je Aufruf frisch per Refresh-Token besorgt hat.
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
      // Der eigentliche Verbindungsaufbau läuft über eine Weiterleitung zu Microsoft (siehe
      // /api/integrations/microsoft/authorize) und nicht über diese Methode, weil dafür eine Rückkehr-Adresse
      // und eine Sitzung nötig sind. Ist die App-Registrierung überhaupt nicht vorhanden, weisen wir das hier
      // trotzdem ehrlich ab, damit ein direkter Aufruf dieser Methode nicht in die Irre führt.
      if (!graphOAuthAvailable()) {
        throw new AdapterError("NOT_CONFIGURED", "Microsoft-Graph-Anbindung ist noch nicht konfiguriert (App-Registrierung, Client-ID, Redirect-URI und Datenschutzfreigabe fehlen).");
      }
      throw new AdapterError("NOT_CONFIGURED", "Bitte den Verbindungsaufbau über „Echtes Postfach verbinden“ starten (Weiterleitung zu Microsoft).");
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
      grantedScopes: fixture ? REQUESTED_SCOPES : GRAPH_SCOPES,
      requestedScopes: REQUESTED_SCOPES,
      expiresAt: null,
      lastError: null,
    };
  }

  async listSelectable(input: { tokenRef: string | null; fixture: boolean; kind: SelectableKind; query?: string; limit?: number }): Promise<SelectableItem[]> {
    this.assertConnected(input.tokenRef);
    if (!input.fixture) return listRealSelectable(input.tokenRef!, input.kind, input.query, input.limit ?? 25);
    const all = (input.kind === "MAIL" ? FIXTURE_MAILS : FIXTURE_EVENTS).map(toSelectable);
    const q = input.query?.toLowerCase().trim();
    const filtered = q ? all.filter((s) => s.subject.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q) || (s.from?.name.toLowerCase().includes(q) ?? false)) : all;
    return filtered.slice(0, input.limit ?? 25);
  }

  async fetch(input: { tokenRef: string | null; fixture: boolean; kind: SelectableKind; externalId: string }): Promise<FetchedSource> {
    this.assertConnected(input.tokenRef);
    if (!input.fixture) {
      const real = await fetchRealSource(input.tokenRef!, input.kind, input.externalId);
      return { ...real, bodyText: sanitizeToText(real.bodyText) };
    }
    const found = (input.kind === "MAIL" ? FIXTURE_MAILS : FIXTURE_EVENTS).find((s) => s.externalId === input.externalId);
    if (!found) throw new AdapterError("NOT_FOUND", "Quelle nicht (mehr) zugänglich.");
    return { ...found, bodyText: sanitizeToText(found.bodyText) };
  }

  async detectChange(input: { tokenRef: string | null; fixture: boolean; kind: SelectableKind; externalId: string; knownHash: string }) {
    const current = await this.fetch(input);
    return { changed: current.contentHash !== input.knownHash, currentHash: current.contentHash };
  }

  async revoke(_tokenRef: string | null): Promise<void> {
    void _tokenRef; // Fixture: nichts zu widerrufen; echt: Der Service löscht den verschlüsselten Refresh-Token lokal.
    // Microsoft selbst bietet keinen zuverlässigen Server-zu-Server-Widerruf für einzelne Refresh-Tokens ohne
    // Nutzerinteraktion; die betroffene Person kann die Zustimmung zusätzlich unter myapps.microsoft.com selbst entziehen.
  }

  private assertConnected(tokenRef: string | null) {
    if (!tokenRef) throw new AdapterError("AUTH", "Keine Verbindung. Bitte zuerst verbinden.");
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
