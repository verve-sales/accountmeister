# Betriebsunterlagen – Verve Sales-Arbeitsumgebung (Pilot)

Stand: 19.09.2026. Diese Unterlage beschreibt, wie die Anwendung auf einem Server betrieben wird. Sie ersetzt keine Datenschutz- oder Rechtsfreigabe (Briefing 16.3); die Pilotfreigabe-Checkliste steht in `docs/pilotfreigabe.md`.

## 1. Architektur im Betrieb

Die Anwendung besteht aus zwei Prozessen: dem Next.js-Server (Node.js 22) und einer PostgreSQL-16-Datenbank. Nutzer greifen per Browser zu. Ein Reverse-Proxy (z. B. Caddy, nginx, Traefik) übernimmt TLS und leitet an Port 3000 weiter; die Anwendung selbst lauscht nur auf 127.0.0.1. Es gibt keine weiteren Dienste; die KI-Anbindung und der Mail-/Kalenderabruf laufen als Adapter im Anwendungsprozess und sind im Pilot deaktiviert bzw. gesperrt, bis die Entscheidungen aus dem Entscheidungsprotokoll getroffen sind.

## 2. Konfiguration (nur über Umgebungsvariablen)

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `DATABASE_URL` | ja | PostgreSQL-Verbindung |
| `SESSION_SECRET` | ja | mind. 32 zufällige Zeichen; Beispielwerte werden verweigert |
| `AUTH_MODE` | ja | `oidc` in Produktion; `development` wird verweigert (S09) |
| `AI_PROVIDER` | ja | `disabled` bis zur KI-Entscheidung; `test` wird verweigert (S09); `production` wirft bis zur Freigabe |
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

`scripts/backup.sh` erzeugt einen `pg_dump` im Custom-Format mit Prüfsumme. `scripts/restore.sh` spielt ihn in eine leere Zieldatenbank zurück und prüft die Prüfsumme. `scripts/restore-check.sql` zählt danach Objekte, gesperrte und gelöschte Quellen sowie Protokolleinträge; diese Zahlen müssen dem Sicherungsstand entsprechen (S12: Lösch- und Sperrentscheidungen bleiben nach Wiederherstellung konsistent, weil sie in der Datenbank selbst liegen).

Der Wiederherstellungstest wurde am 19.09.2026 mit dem Entwicklungsdatenbestand durchgeführt (Sicherung → leere Datenbank → identische Zählungen). Er ist vor Echtdatenbetrieb mit dem Produktionsabbild zu wiederholen und dann regelmäßig einzuplanen.

Sicherungen enthalten personenbezogene Daten: verschlüsselt ablegen, Zugriff begrenzen. Die Aufbewahrungsdauer der Sicherungen und der Umgang mit Löschverlangen gegenüber Sicherungen (Ablauf statt Einzellöschung, Löschmarkierungen beim Wiederherstellen erneut anwenden) sind Teil des offenen Löschkonzepts.

## 6. Sperren und Löschen von Quellen (16.4)

Zwei dokumentierte Schritte, ausführbar durch Quelleninhaber, zuständige Führungsrolle oder Betriebsverwaltung auf der Quellenseite:

1. Sperren: Die Quelle ist für andere unsichtbar; alle Vorschläge, Artefaktfassungen und Aussagen, die sich allein auf sie stützen, werden als „überholt“ markiert und müssen erneut geprüft werden (S07).
2. Inhalt entfernen: Text der Quelle und aller Quellenversionen wird gelöscht; Typ, Zeitpunkte, Herkunft und Protokolleinträge bleiben für die Nachvollziehbarkeit.

Beide Schritte werden protokolliert – mit Grund, aber ohne Inhalt. Suchindex und externe Exporte existieren im Pilot nicht; kommen sie hinzu, sind sie in diesen Ablauf aufzunehmen.

## 7. Protokolle und Logs (S08)

Das Anwendungsprotokoll (`audit_events`) speichert Akteur, Aktion, Objekttyp/-ID, Zeitpunkt und minimale Änderungsinformation, nie Rohtexte oder Tokens. KI-Aufträge speichern Hash und Länge des Eingabetexts. Die Verwaltungsansicht zeigt Änderungsdetails nur als Feldnamen. Server-Logs des Node-Prozesses enthalten Fehlermeldungen ohne Nutzdaten; Reverse-Proxy-Logs sollten ohne Query-Strings geführt werden.

## 8. Rollen und Zugänge

Die Betriebsverwaltung (Rolle ADMIN) pflegt unter „Verwaltung“ Rollen und Zugangsstatus und sieht Protokoll und Bestandszahlen – ohne Inhalte. Die eigene ADMIN-Rolle und der eigene Zugang können nicht entzogen werden. In der Pilotphase mit Entwicklungsanmeldung existieren nur fiktive Zugänge; reale Zugänge entstehen erst mit der Unternehmensanmeldung (OIDC).

## 9. Umgang mit Ausfall (17.5)

KI nicht verfügbar oder deaktiviert: Alles außer „Notiz strukturieren“ funktioniert; der Status wird ehrlich angezeigt. Datenbank nicht erreichbar: `/health` meldet 503, der Proxy sollte eine Wartungsseite zeigen. Import fehlgeschlagen: Auftrag bleibt im Status „Fehler“ und kann wiederholt werden, kein Teilstand gilt als bestätigt. Verbindung zum Postfach abgelaufen: Status „Abgelaufen – erneut anmelden“, letzter erfolgreicher Abruf bleibt sichtbar.

## 10. Was vor Echtdatenbetrieb noch fehlt

Unternehmensanmeldung (OIDC), TLS-Abschluss im Proxy, Sicherungsplan mit Aufbewahrung, Datenschutzfreigabe und Löschkonzept, App-Registrierung für Microsoft Graph, KI-Anbieterentscheidung, Regelwerk für Startvoraussetzungen. Alles in `docs/pilotfreigabe.md` als Checkliste.
