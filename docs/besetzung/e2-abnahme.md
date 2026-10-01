# Einsatz und Betreuung – E2: Lieferumfang, Entwicklungsdefaults, Testnachweis, Demo

Stand: 1. Oktober 2026 · auf `main` (Etappe 29) · fiktive Daten, Testanbieter.

## Entwicklungsdefaults für die vier offenen E2-Entscheidungen (umgesetzt, änderbar)

1. **Einsatz-Mapping:** eigene Tabelle `engagements`, genau ein Einsatz je bestätigter Kandidatur (Unique, idempotent, in derselben Transaktion wie die Auswahl). `orders` bleibt der Beleg der Bestellung und wird optional am Einsatz verknüpft. Bestandsaufträge ohne Besetzung werden **nicht** zu Einsätzen umgewandelt (A26); Health-Check und Verlängerungsfahrplan arbeiten weiter auf `orders`.
2. **Betreuungskontext für Sales Ops:** Einsatzakte (Überblick, Status lesen), Betreuung, Verträge/Unterlagen (sehen, hochladen, verknüpfen), Perioden lesen, Check-ins führen, Verlängerung vorbereiten. Keine Account-/Setup-Rechte, kein Statuswechsel, keine Bestätigung/Ablehnung der Verlängerung, keine direkte Vergabe von Betreuung.
3. **Beschaffungsprofil:** je Kunde pflegbar (Kundenseite → „Beschaffungsprofil“), Freigabe durch zuständigen BD, Principal oder CEO. Ohne freigegebenes Profil ist die Vertragslage „unbestimmt“; „geplant“ dann nur mit begründeter Ausnahme (protokolliert mit Person und Zeit).
4. **Konditions-Sichtbarkeit:** BD-Kontext, Principal, CEO voll; Betreuungsperson liest Perioden (für Verlängerungsvorbereitung). Vor Echtdaten zu bestätigen.

## Umgesetzt

- **Einsatzakte** `/einsaetze/[id]`: Kopf (Status, Kunde, Freelancer, Betreuung, Laufzeit, nächste Frist), Überblick (BD, Vertragslage, Verlängerung, Frist, Auftrag, Moco-Referenz nur als Link), Status in Vorbereitung → geplant (Betreuung + Vertragslage/Ausnahme) → aktiv (bestätigter Start, kein Datumsablauf) → endet (bestätigtes Ende) → abgeschlossen (keine offene Verlängerungsentscheidung; offene Check-ins begründen); pausiert (Grund, Prüftermin), abgebrochen. Verlängerung ist kein Status.
- **Betreuung**: dauerhafte Zuordnung je Funktion (Kunde/Freelancer), Übergabe als Vorgang (kind BETREUUNG, Pflichtinhalt Grund/Kontakte/Historie/Zusagen/nächster Schritt) – Annahme aktiviert die Zuordnung in derselben Transaktion, beendet die alte mit Datum und hängt offene Check-ins um; Abschluss des Vorgangs beendet die Betreuung nicht (A06); direkte Umstellung durch BD-Kontext (A07).
- **Verträge/Bestellungen**: `contract_documents` (Seite, Typ, Version, Gültigkeit, Status, Beleg als Datei/Link, Prüfung) getrennt vom Dokument; Verknüpfung mit mehreren Einsätzen; „unterschrieben“ nur mit Beleg; Dateieingang über den bestehenden Upload (PDF, DOCX, XLSX, CSV, TXT, EML) mit regelbasiertem Typ-Vorschlag samt Belegstelle; Scan → „nicht ausgewertet“ (A28).
- **Perioden**: Plan/bestätigt, EK/VK als Decimal, Umfang, Quelle, Ablösung statt Überschreiben; Überlappung bestätigter Perioden nur als ausdrückliche Korrektur (A22). Keine Umsatzhochrechnung.
- **Check-ins**: Kunde alle 42 Tage nach tatsächlichem Gespräch (sonst Start + 42), Freelancer separat; fällig → angefragt → geplant (Zeitpunkt) → erledigt (Termin + Ergebnis); verschoben ändert nur die Fälligkeit (A20); Pause/Ende beenden Routine (A24). Liste „Meine Check-ins“ unter Meine Arbeit mit Schnellerfassung.
- **Sales-Rückkopplung**: Sales-Hinweis im Check-in wird als Beobachtung/Signal im Setup zur Prüfung an den BD gegeben (erlaubte Verwendung dokumentiert); ohne Setup-Recht bleibt der Hinweis am Check-in und der BD wird benachrichtigt.
- **Verlängerung**: Entscheidung je Einsatz (zu klären → in Abstimmung → angeboten → bestätigt/abgelehnt/erledigt), automatisch 90 Tage vor Ende bzw. 30 Tage vor Kündigungs-/Optionsfrist (früheste Frist zählt, A21); Bestätigung nur BD-Kontext mit Zeitraum, Konditionen, Vertragsfolge → neue bestätigte Periode, Einsatzende angepasst.
- **Hintergrundprozess**: stündliche Regeln (Catch-ups, Check-in-Hinweise, Verlängerungsentscheidungen) idempotent über Schlüssel; `job_runs` mit Heartbeat/Fehlern unter Verwaltung sichtbar (A23 teilweise: Wiederholung erzeugt keine Doppelwirkung).
- **Übersicht** `/einsaetze` mit Filtern aktiv, meine Betreuung, Vertragslage offen, enden ≤ 30/60/90, Check-in überfällig, abgeschlossen (Rechte vor Zählung).
- Hilfe (zwei Abschnitte), Navigation, Migration 0029 (additiv).

Nicht gebaut (wie vorgegeben): Stundenzettel, CV, Ranking, externer Versand, Kalenderbuchung, juristische Vollständigkeitsprüfung, Vertragsgenerierung, Forecast.

## Testnachweis

```
npx tsc --noEmit -p .   → ohne Befund
npm run lint            → ohne Befund
npx vitest run          → 40 Dateien, 204 Tests grün
  tests/einsatz.test.ts → 7 Tests: A15 Idempotenz, geplant/aktiv-Regeln, A22 Perioden, A28 Scan, A06/A07 Betreuung, A20/A24 Check-ins + Signal, A21 Verlängerung, Hilfe
npx next build          → erfolgreich
node docs/besetzung/demo-e1.mjs && node docs/besetzung/demo-e2.mjs → Ende-zu-Ende im Browser, 19 Screenshots
```
Ausstehend: A23 Crash mitten im Lauf (nur Wiederholung getestet), A29 Benachrichtigungsrechte nach Entzug (Titel sind neutral, Rechteprüfung beim Öffnen), A30 Restore-Probe, Playwright-E2E im Testprojekt.

## Demo-Anleitung (nach dem E1-Durchlauf)

1. **David (BD)**: Mehr → Einsätze → den Einsatz öffnen (entstand mit der Auswahl). Auf der Kundenseite „Beschaffungsprofil“ pflegen und freigeben (z. B. Kunde: Bestellung, Freelancer: Einzelbeauftragung).
2. Im Einsatz unter „Verträge und Bestellungen“ beide Unterlagen anlegen (unterschrieben mit Link oder Datei) → „Auf geplant setzen“ → „Start bestätigen“ (Datum heute).
3. „Betreuung übergeben“ an Sofia (Grund, Zusagen). **Sofia** nimmt den Vorgang unter Meine Arbeit an → sie sieht den Einsatz als Betreuung.
4. Sofia legt einen Kunden-Check-in an, führt ihn (Termin, Ergebnis, Sales-Hinweis) → der nächste Check-in liegt 42 Tage später; der Hinweis erscheint als Signal im Setup beim BD.
5. Sofia setzt die Verlängerung auf „in Abstimmung“; **David** bestätigt mit Zeitraum, EK/VK, Vertragsfolge → neue Periode, neues Ende.
6. **Nina (Anker)** sieht `/einsaetze` leer; Sofia ohne Zuordnung sieht einen fremden Einsatz nicht.
