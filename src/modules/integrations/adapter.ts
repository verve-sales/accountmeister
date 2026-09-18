/**
 * Mail-/Kalender-Adaptervertrag (Briefing 13.4).
 * Funktionen: Verbindung herstellen, Berechtigungen anzeigen, auswählbare Objekte listen, ausgewählte Quelle abrufen,
 * Änderungen erkennen, Verbindung widerrufen, Fehlerstatus liefern. Keine Schreibzugriffe (kein Senden, keine Termine).
 * Der Adapter kennt keine Datenbank; er liefert nur Daten an den Import-Service.
 */

export type SelectableKind = "MAIL" | "TERMIN";

export type SelectableItem = {
  kind: SelectableKind;
  externalId: string;
  subject: string;
  /** Absender bzw. Organisator – Anzeigename und Adresse, sofern vorhanden */
  from: { name: string; email?: string } | null;
  participants: { name: string; email?: string }[];
  /** Zeitpunkt der Quelle (Empfang bzw. Termin-Beginn) */
  at: string; // ISO
  preview: string; // kurzer Textauszug, ohne HTML
  hasAttachments: boolean;
};

export type FetchedSource = {
  kind: SelectableKind;
  externalId: string;
  subject: string;
  from: { name: string; email?: string } | null;
  participants: { name: string; email?: string }[];
  at: string;
  /** Nur-Text-Körper. HTML wird nie geliefert; der Adapter konvertiert oder verweigert. */
  bodyText: string;
  /** Anhänge werden nicht übernommen – nur Namen zur Anzeige des Importumfangs */
  attachmentNames: string[];
  /** Termine: geplante Teilnahme belegt keine Teilnahme (13.3) */
  meetingAcceptedByUser?: boolean;
  /** Änderungserkennung */
  contentHash: string;
};

export type ConnectionState = {
  connected: boolean;
  fixtureMode: boolean;
  accountLabel: string | null;
  grantedScopes: string[];
  requestedScopes: string[];
  expiresAt: string | null;
  lastError: string | null;
};

export interface MailCalendarAdapter {
  readonly providerId: "MICROSOFT_GRAPH";
  /** Welche Berechtigungen der Adapter tatsächlich braucht (minimal, lesend) */
  requestedScopes(): string[];
  /** Verbindung herstellen. Im Fixture-Modus ohne externen Aufruf; sonst OAuth-Autorisierungs-URL zurückgeben. */
  connect(input: { userEmail: string; fixture: boolean }): Promise<{ state: ConnectionState; authorizationUrl?: string; tokenRef?: string }>;
  status(tokenRef: string | null, fixture: boolean): Promise<ConnectionState>;
  listSelectable(input: { tokenRef: string | null; fixture: boolean; kind: SelectableKind; query?: string; limit?: number }): Promise<SelectableItem[]>;
  fetch(input: { tokenRef: string | null; fixture: boolean; kind: SelectableKind; externalId: string }): Promise<FetchedSource>;
  /** Änderungserkennung: liefert die aktuelle Inhalts-Prüfsumme, um Wiederimporte idempotent zu halten */
  detectChange(input: { tokenRef: string | null; fixture: boolean; kind: SelectableKind; externalId: string; knownHash: string }): Promise<{ changed: boolean; currentHash: string }>;
  revoke(tokenRef: string | null): Promise<void>;
}

export class AdapterError extends Error {
  readonly kind: "AUTH" | "RATE_LIMIT" | "TEMPORARY" | "NOT_FOUND" | "NOT_CONFIGURED" | "UNSAFE_CONTENT";
  constructor(kind: AdapterError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}
