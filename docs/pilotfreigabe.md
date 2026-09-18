# Pilotfreigabe – Checkliste

Stand: 19.09.2026. Die Anwendung ist als vollständiger Prototyp mit fiktiven Daten fertig (Etappen 0–5). Für den Betrieb mit echten Daten müssen die folgenden Punkte erledigt sein. Die Anwendung erzwingt einige davon technisch (Startverweigerung); die übrigen sind organisatorische Freigaben nach Briefing 2.3 und 16.3.

## A. Technisch erzwungen (Start scheitert sonst)

| Punkt | Stand |
|---|---|
| `AUTH_MODE` ≠ `development` in Produktion | erzwungen (S09) |
| `AI_PROVIDER` ≠ `test` in Produktion | erzwungen (S09) |
| `SESSION_SECRET` gesetzt, kein Beispielwert | erzwungen |
| Migrationen vollständig angewendet | beim Start (`scripts/start.sh`) |

## B. Entscheidungen, die vor dem jeweiligen Produktivschritt fallen müssen

| Entscheidung | Blockiert | Vorbereitet in der Anwendung |
|---|---|---|
| Hosting/Region | Echtdatenbetrieb | Docker/Compose, Reverse-Proxy-Anleitung |
| Unternehmensanmeldung (OIDC-Anbieter, Gruppen → Rollen) | Anmeldung realer Nutzer | `AUTH_MODE=oidc` als Konfigurationswert; Rollenpflege in der Verwaltung |
| Datenschutz: Zwecke, Rechtsgrundlagen, Informationen an Betroffene, DSFA-Bewertung, Beschäftigtenvertretung | Echtdatenbetrieb | Zugriffsklassen, Sperr-/Löschablauf, Protokoll ohne Inhalte, Bestandszahlen je Schutzbereich |
| Aufbewahrung je Datenklasse und Löschkonzept inkl. Sicherungen | Echtdatenbetrieb | Sperren + Inhalt entfernen; Wiederherstellungsprüfung; keine erfundenen Fristen |
| Microsoft Graph: App-Registrierung im Verve-Tenant, Redirect-URI, Token-Verschlüsselung, Datenschutzfreigabe | echter Mail-/Kalenderimport | Adapter mit minimalen lesenden Scopes im Fixture-Modus (E-018, E-023) |
| KI-Anbieter, Modell, Vertrag, Datenklassen, Drittlandtransfer | KI-Verarbeitung echter Inhalte | Anbietervertrag, Prompt-/Schemaversionen, Evaluationsfälle, Nutzungsgrenze; Produktivadapter gesperrt |
| Regelwerk Startvoraussetzungen (Vertrag, Compliance, Onboarding) | produktive Einsatzfreigabe | frei erfasste Voraussetzungen mit Nachweisen; „startbereit“ nie über leere Liste |
| Sales-/Vergütungsregeln (A16) | Vergütungsprüfungen | keine Berechnung; Nachweise als Quellen |
| Führendes CRM/Staffing-System | Synchronisation realer Stammdaten | eigener Pilotdatenbestand |

## C. Vor der Freischaltung durchführen

1. Wiederherstellungstest mit dem Produktionsabbild (`scripts/backup.sh` → `scripts/restore.sh` → `scripts/restore-check.sql`).
2. Direkte Objekt-ID-Aufrufe mit Fremdnutzern gegen die produktive Instanz (S01) – die automatisierten Tests decken die Regeln ab, der manuelle Test bestätigt die Konfiguration.
3. Reverse-Proxy: TLS, HSTS, Logs ohne Query-Strings, Anwendung nur intern erreichbar.
4. Rollen für die ersten realen Nutzer anlegen; Seed-Daten in Produktion nicht einspielen (der Seed ist nur für Entwicklung/Test).
5. Betriebsverantwortliche und Ansprechperson Datenschutz benennen; Verfahren für Löschverlangen (Quelle sperren → Inhalt entfernen → Sicherungen) schriftlich festlegen.
6. Performance mit realistischer Testdatenmenge messen und Lade-/Jobzeiten dokumentieren (20.3).

## D. Was der Pilot bewusst nicht ist

Kein Kandidaten- oder Vertragsmanagement, keine Rechnungs-/Provisionsabrechnung, kein automatischer Outreach, keine Bewertung individueller Arbeitsleistung, kein Kundenzugang (Briefing 21, „Nicht im ersten Auftrag enthalten“).
