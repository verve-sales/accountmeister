# Betriebsunterlagen – Verve Sales-Arbeitsumgebung (Pilot)

Stand: 20.09.2026. Diese Unterlage beschreibt, wie die Anwendung auf einem Server betrieben wird. Sie ersetzt keine Datenschutz- oder Rechtsfreigabe (Briefing 16.3); die Pilotfreigabe-Checkliste steht in `docs/pilotfreigabe.md`.

## 1. Architektur im Betrieb

Die Anwendung besteht aus zwei Prozessen: dem Next.js-Server (Node.js 22) und einer PostgreSQL-16-Datenbank. Hochgeladene Dokumente liegen als Dateien im Volume `uploads` (`/data/uploads`); ihr extrahierter Text steht in der Datenbank. Nutzer greifen per Browser zu. Ein Reverse-Proxy (z. B. Caddy, nginx, Traefik) übernimmt TLS und leitet an Port 3000 weiter; die Anwendung selbst lauscht nur auf 127.0.0.1. Es gibt keine weiteren Dienste; die KI-Anbindung und der Mail-/Kalenderabruf laufen als Adapter im Anwendungsprozess und sind im Pilot deaktiviert bzw. gesperrt, bis die Entscheidungen aus dem Entscheidungsprotokoll getroffen sind.

## 2. Konfiguration (nur über Umgebungsvariablen)

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `DATABASE_URL` | ja | PostgreSQL-Verbindung |
| `SESSION_SECRET` | ja | mind. 32 zufällige Zeichen; Beispielwerte werden verweigert |
| `AUTH_MODE` | ja | `oidc` in Produktion; `development` wird verweigert (S09) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | bei `oidc` | Microsoft Entra ID: `https://login.microsoftonline.com/<Mandant>/v2.0`, Anwendungs-ID, geheimer Clientschlüssel (Wert), `https://<Domain>/api/auth/callback` |
| `ADMIN_EMAILS` | empfohlen | Adressen, die beim ersten Anmelden die Verwaltungsrolle erhalten |
| `OIDC_AUTO_CREATE_USERS` | nein | `false` (Standard): Zugänge vorher in der Verwaltung anlegen |
| `DOMAIN` | ja (Compose) | öffentliche Adresse für Caddy/TLS und die Redirect-URI |
| `AI_PROVIDER` | ja | `disabled` (aus) oder `langdock` (Produktiv, E-037); `test` wird in Produktion verweigert (S09); `production` ist ein gesperrter Platzhalter |
| `LANGDOCK_API_KEY`, `LANGDOCK_BASE_URL`, `LANGDOCK_DEFAULT_MODEL` | bei `langdock` | API-Schlüssel (nur Server), OpenAI-kompatible Basis-URL (Standard `https://api.langdock.com/openai/eu/v1`), Standardmodell, wenn je Aufgabe keines gewählt ist |
| `UPLOAD_DIR`, `MAX_UPLOAD_MB` | nein | Ablage hochgeladener Dokumente (Compose: Volume `uploads` unter `/data/uploads`), Größenlimit je Datei (Standard 25) |
| `AI_DAILY_JOB_LIMIT` | nein | KI-Aufträge je Arbeitsraum und Tag (Standard 200) |
| `SESSION_MAX_AGE_SECONDS`, `SESSION_IDLE_SECONDS` | nein | Sitzungsdauer (Standard 12 h) und Inaktivitätsgrenze (Standard 2 h) |
| `RATE_LIMIT_LOGIN_PER_15MIN`, `RATE_LIMIT_WRITES_PER_MIN` | nein | Nutzungsgrenzen (Standard 20 bzw. 120) |
| `RUN_MIGRATIONS` | nein | `true` (Standard): Migrationen beim Start anwenden |

Geheimnisse liegen ausschließlich in `.env.production` auf dem Server (nicht im Git) oder im Secret-Store der Plattform. Beispiel: `.env.production.example`.

## 3. Start mit Docker Compose

```
cp .env.production.example .env.production   # Werte setzen
docker compose up -d --build
curl -s http://127.0.0.1:3000/health           # {"status":"ok","database":"erreichbar",...}
```

`scripts/start.sh` prüft die Konfiguration, wendet die Migrationen an (`scripts/migrate.mjs`, ohne Entwicklungswerkzeuge) und startet die Anwendung. Eine unsichere Konfiguration bricht den Start ab – das ist gewollt.

Die Nutzungsgrenzen (Rate-Limits) werden im Prozessspeicher geführt und gelten je Anwendungsinstanz. Für den Pilot mit einer Instanz ist das ausreichend; bei mehreren Instanzen ist ein gemeinsamer Speicher nachzurüsten.

## 4. Migrationen mit Sicherung und Rückfallplan

Migrationen sind versionierte SQL-Dateien in `src/db/migrations` (Journal in `meta/_journal.json`). Ablauf bei einem Update:

1. Sicherung ziehen: `DATABASE_URL=… sh scripts/backup.sh /pfad/backups`.
2. Neues Abbild bauen und starten; `scripts/start.sh` wendet ausstehende Migrationen in einer Transaktion je Datei an.
3. Prüfen: `/health`, Anmeldung, Stichprobe im Setup.
4. Rückfall: altes Abbild starten mit `RUN_MIGRATIONS=false`. Enthält die neue Migration nur additive Änderungen (neue Tabellen/Spalten – der Regelfall in diesem Projekt), läuft der alte Stand weiter. Bei destruktiven Änderungen die Sicherung in eine leere Datenbank zurückspielen (`scripts/restore.sh`) und die Verbindung umstellen.

## 5. Sicherung und Wiederherstellung

Die Sicherung umfasst zwei Teile: die Datenbank (`pg_dump`, Custom-Format) und das Dokumentenvolume (`tar` von `/data/uploads`). Der vom Installationsskript eingerichtete Cron-Job (03:15 Uhr) sichert beides nach `/var/backups/verve-sales` und behält 14 Tage; `scripts/update-server.sh` sichert zusätzlich vor jedem Update. `scripts/backup.sh` erzeugt einen `pg_dump` im Custom-Format mit Prüfsumme. `scripts/restore.sh` spielt ihn in eine leere Zieldatenbank zurück und prüft die Prüfsumme. Das Dokumentenarchiv wird mit `docker compose exec -T app tar -C /data -xzf - < verve-sales-uploads-<Datum>.tar.gz` zurückgespielt; Datenbank und Dokumente müssen vom selben Tag stammen, sonst fehlen Dateien zu Quellen (die Anwendung zeigt dann „Datei entfernt“). `scripts/restore-check.sql` zählt danach Objekte, gesperrte und gelöschte Quellen sowie Protokolleinträge; diese Zahlen müssen dem Sicherungsstand entsprechen (S12: Lösch- und Sperrentscheidungen bleiben nach Wiederherstellung konsistent, weil sie in der Datenbank selbst liegen).

Der Wiederherstellungstest wurde am 19.09.2026 mit dem Entwicklungsdatenbestand durchgeführt (Sicherung → leere Datenbank → identische Zählungen). Er ist vor Echtdatenbetrieb mit dem Produktionsabbild zu wiederholen und dann regelmäßig einzuplanen.

Sicherungen enthalten personenbezogene Daten: verschlüsselt ablegen, Zugriff begrenzen. Die Aufbewahrungsdauer der Sicherungen und der Umgang mit Löschverlangen gegenüber Sicherungen (Ablauf statt Einzellöschung, Löschmarkierungen beim Wiederherstellen erneut anwenden) sind Teil des offenen Löschkonzepts.

## 6. Sperren und Löschen von Quellen (16.4)

Zwei dokumentierte Schritte, ausführbar durch Quelleninhaber, zuständige Führungsrolle oder Betriebsverwaltung auf der Quellenseite:

1. Sperren: Die Quelle ist für andere unsichtbar; alle Vorschläge, Artefaktfassungen und Aussagen, die sich allein auf sie stützen, werden als „überholt“ markiert und müssen erneut geprüft werden (S07).
2. Inhalt entfernen: Text der Quelle und aller Quellenversionen wird gelöscht, bei Dokumenten auch die Datei im Volume; Typ, Zeitpunkte, Herkunft, Dateiname/Prüfsumme und Protokolleinträge bleiben für die Nachvollziehbarkeit.

Beide Schritte werden protokolliert – mit Grund, aber ohne Inhalt. Suchindex und externe Exporte existieren im Pilot nicht; kommen sie hinzu, sind sie in diesen Ablauf aufzunehmen.

## 7. Protokolle und Logs (S08)

Das Anwendungsprotokoll (`audit_events`) speichert Akteur, Aktion, Objekttyp/-ID, Zeitpunkt und minimale Änderungsinformation, nie Rohtexte oder Tokens. KI-Aufträge speichern Hash und Länge des Eingabetexts. Die Verwaltungsansicht zeigt Änderungsdetails nur als Feldnamen. Server-Logs des Node-Prozesses enthalten Fehlermeldungen ohne Nutzdaten; Reverse-Proxy-Logs sollten ohne Query-Strings geführt werden.

## 8. Rollen und Zugänge

Die Betriebsverwaltung (Rolle ADMIN) pflegt unter „Verwaltung“ Rollen und Zugangsstatus und sieht Protokoll und Bestandszahlen – ohne Inhalte. Die eigene ADMIN-Rolle und der eigene Zugang können nicht entzogen werden. In der Pilotphase mit Entwicklungsanmeldung existieren nur fiktive Zugänge; reale Zugänge entstehen erst mit der Unternehmensanmeldung (OIDC).

## 9. Umgang mit Ausfall (17.5)

KI nicht verfügbar oder deaktiviert: Alles außer „Notiz strukturieren“ funktioniert; der Status wird ehrlich angezeigt. Datenbank nicht erreichbar: `/health` meldet 503, der Proxy sollte eine Wartungsseite zeigen. Import fehlgeschlagen: Auftrag bleibt im Status „Fehler“ und kann wiederholt werden, kein Teilstand gilt als bestätigt. Verbindung zum Postfach abgelaufen: Status „Abgelaufen – erneut anmelden“, letzter erfolgreicher Abruf bleibt sichtbar.

## 10. KI-Betrieb (Etappe 6)

Aktivierung: `AI_PROVIDER=langdock` und `LANGDOCK_API_KEY` in `.env.production`, dann `docker compose up -d` (Anleitung `docs/installation-ionos.md`, Schritt 8). Unter „Verwaltung → KI“ prüft die Betriebsverwaltung die Verbindung (nur Modellliste, keine Inhalte), wählt je Aufgabe Modell, Temperatur und Ausgabegrenze und sieht den Token-Verbrauch der letzten 30 Tage sowie die letzten Aufträge. Aufgaben: „Notiz strukturieren“ (Weeklys, importierte Quellen, Dokumente im Setup), „Dokument/Interview auswerten“ (Anlagevorschlag), „Interview: nächste Frage“ (kleines, schnelles Modell genügt; ein Aufruf je Frage) „Assistent“ (Dialog im Seitenpanel; ein Aufruf je Nachricht, gestreamt; ein schnelles Modell mit guter Instruktionstreue), „Strategiefaden“ (ein Aufruf je „Vorschlag der KI einholen“; ein stärkeres Modell lohnt sich) und „Formularvorschläge“ (ein Aufruf je „Vorschlagen lassen“; kleines Modell genügt; noch nicht konfigurierte Aufgaben erben das Modell einer konfigurierten Aufgabe – Anzeige „geerbt“). Fehler des Anbieters (Schlüssel abgelehnt, Modell nicht verfügbar, Rate-Limit) werden im Auftrag protokolliert und dem Nutzer verständlich gemeldet; manuelle Arbeit bleibt immer möglich. Der Schlüssel wird nirgends angezeigt; bei Verdacht auf Kompromittierung in Langdock widerrufen, neuen Schlüssel eintragen, Container neu starten.

## 11. Was vor Echtdatenbetrieb noch fehlt

Unterschrift unter den Freigabevorschlag (`docs/pilotfreigabe-vorschlag.md`: Verantwortliche, Fristen, Verfahren, zweiter Sicherungsort), App-Registrierung für Microsoft Graph (nur für Mailimport), Regelwerk für Startvoraussetzungen. Checkliste in `docs/pilotfreigabe.md`.

## Kunden löschen (E-042)
Zwei Schritte auf der Kundenseite („Kunde archivieren oder löschen“): Archivieren (wiederherstellbar) und danach endgültiges Löschen mit Namensbestätigung und Begründung. Berechtigt: zuständiger BD, Principal des Kunden, ADMIN (Demo-Kunden nur ADMIN). Die Löschung läuft in einer Transaktion; Dokumentdateien unter `UPLOAD_DIR` werden mitgelöscht. Das Prüfprotokoll (`audit_events`, Aktion `account.deleted`) hält Kundenname, Begründung und Umfang je Tabelle fest. Ein gelöschter Kunde ist nur noch aus der Sicherung (Datenbank + Uploads, siehe oben) wiederherstellbar – vor Löschverlangen also den Sicherungsstand beachten (Aufbewahrungsfrist der Sicherungen).
