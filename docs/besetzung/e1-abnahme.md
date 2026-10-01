# Besetzung – E1: Lieferumfang, Testnachweis, Demo-Anleitung

Branch `besetzung-e1` (nicht in `main` gemergt, kein Deployment). Fiktive Daten, Testanbieter bzw. KI aus.

## Umgesetzt

- **Position** an einer Chance (ein Platz; Kopieren für weitere Plätze): Bedarfsfelder, getrennte interne Konditionen (EK-/Angebotsrahmen, Einheit Tag/Stunde, Währung, unbekannt = leer), Status Entwurf → offen (Mindestangaben) → besetzt; pausiert (Grund + Prüftermin) und abgebrochen (Grund, offene Aufträge werden nachvollziehbar geschlossen). Kopie und Nachbesetzung als verknüpfte neue Position.
- **Suchauftrag** als Vorgang an das Team Sales Operations (erwartetes Ergebnis, Fälligkeit, Checkliste, Prüfung durch Auftraggeber:in). Team-Eingang, Übernahme (genau eine Person, Konflikt bei paralleler Annahme), Rückfrage vor/nach Annahme mit Antwort, Abgeben in die Warteschlange, Abnahme.
- **Teamvorschau**: Sales Ops sieht vor der Übernahme nur Titel, Kunde/Chance, BD, Muss-Anforderungen, Start, Umfang/Ort, Zieltermin.
- **Freelancer-Minimalstamm** (Pool für Sales Ops/Principal/CEO; BDs sehen Freelancer nur über eigene Kandidaturen; fremde Kandidaturhistorie bleibt verborgen).
- **Kandidatur** mit Zuständen identifiziert → in Kontakt → qualifiziert → vorgeschlagen (EK-Stand Pflicht) → freigegeben (nur BD-Kontext) → vorgestellt (Datum, Empfänger, Profilstand mit Prüfsumme, erlaubte Weitergabe, Preis) → Interview → ausgewählt; Absage/Rückzug/nicht verfügbar mit Grund, Wiederaufnahme mit Grund und Verfügbarkeit; Überspringen mit Grund, nie an Freigabe/Auswahl vorbei; Kundenrückmeldung als Ereignis.
- **Auswahl** nur durch BD-Kontext mit ausdrücklicher Bestätigung; atomar genau eine je Position; idempotent; Chance bleibt im bestehenden Abschlussprozess (Link zu Angebot/Auftrag).
- **Ausschreibungsentwurf** (KI-Task `STAFFING_AD_DRAFT`, Prompt vorläufig) nur aus freigegebenen Feldern; editierbar; Freigabe durch BD; Text zum Kopieren; regelbasiert ohne KI.
- **Texteingang** (KI-Task `STAFFING_NOTE_STRUCTURE`, Prompt vorläufig): Text → Quelle am Setup → Vorschläge mit Belegstellen → Vorschau → ausgewählte Positionen als Entwürfe (Sätze nur als Notiz).
- **Hilfe** („Besetzung“, „Ausschreibungsentwurf und Texteingang“), Navigation „Besetzung“, Feature-Flag `FEATURE_BESETZUNG` (Compose-Default aus).
- **Härtung** der Vertraulichkeit im Provisionsrechner (Konfiguration je Berechtigung, Hilfetext bereinigt) – Details im gesonderten Befund.

Bewusst nicht gebaut: Stundenzettel, CV-Erstellung, Ranking/Matching, zweite App, externer Versand, Plattform-APIs, Vertrags-/Provisionsfreigaben, Opportunity-Statusänderungen.

## Testnachweis (ausgeführt am 1. Oktober 2026)

```
npx tsc --noEmit -p .                 → ohne Befund
timeout 100 npm run lint              → ohne Befund
timeout 170 npx vitest run            → 39 Dateien, 197 Tests grün
  davon tests/besetzung.test.ts       → 7 Tests (Positionen, Rechte A01/A04, Ende-zu-Ende mit A03/A05/A14–A19/A25, KI-Entwurf A27, Texteingang A12, Hilfe)
  tests/provision.test.ts             → +1 Test A10 (Client-Konfiguration ohne vertrauliche Stufe)
  tests/kollaboration.test.ts         → 13 Tests (Vorgänge, Teams, Rückfrage, Benachrichtigungen)
npx next build                        → erfolgreich (inkl. Routen /besetzung/**)
node docs/besetzung/demo-e1.mjs       → Ende-zu-Ende im Browser, 11 Screenshots
```

Nicht ausgeführt (ausstehend): echte UI-End-to-End-Tests im Playwright-Testprojekt (`e2e/`), Restore-Probe, Last-/Parallelitätstest über den Versionszähler hinaus, Tests mit produktiver KI.

## Demo-Anleitung (Rollenwechsel über die Entwicklungsanmeldung)

Vorbereitung: eigene Datenbank, Migration, Seed, Nutzerin mit Rolle Sales Operations (Verwaltung → Zugänge), `AI_PROVIDER=test` oder `disabled`, `FEATURE_BESETZUNG=true`.

1. **David (BD)** öffnet eine Chance beim Beispielkonzern → Block „Besetzung“ → „Aus Text übernehmen“, E-Mail-Text einfügen → Vorschau mit Belegstellen → drei Positionen als Entwurf anlegen. Alternativ „Position anlegen“.
2. David öffnet die erste Position → „Bedarf bearbeiten“ (EK-Rahmen, Zieltermin) → „Auf offen setzen“ → Suchauftrag „An Sales Operations geben“.
3. **Sofia (Sales Operations)** sieht die Position nur als Teamvorschau; unter Meine Arbeit → Team-Eingang den Suchauftrag öffnen → „Übernehmen“ (bei einem zweiten Auftrag stattdessen „Rückfrage“ stellen; David beantwortet sie auf der Vorgangsseite).
4. Sofia legt zwei Kandidaturen an (EK, Verfügbarkeit, Herkunft), führt Mara bis „dem BD vorgeschlagen“.
5. **David** gibt Mara frei → „Vorstellung dokumentieren“ (Empfänger, Profilstand, Weitergabe, Preis) → Interview dokumentieren → „Auswahl bestätigen“. Position ist besetzt, Suchauftrag erledigt, andere Positionen bleiben offen; an der Chance erscheint die Teilbesetzung mit Link zu Angebot/Auftrag.
6. David erzeugt an Position 2 einen Ausschreibungsentwurf, bearbeitet und gibt ihn frei, kopiert den Text.
7. **Nina (Anker)** öffnet die Positions-URL → „nicht gefunden“. **Lars (anderer BD)** sieht die Position nicht in `/besetzung`.
8. KI abschalten (`AI_PROVIDER=disabled`) und Schritte 1 und 6 wiederholen: regelbasierte Vorschläge, Ablauf vollständig manuell.

## Entscheidungen, die E2 wirklich braucht

1. **Einsatz-Mapping:** Auswahl → neuer Datensatz `engagements` mit Verweis auf `orders` (Vorschlag) oder `orders` um Freelancer-Felder erweitern? Vorschlag: eigene Tabelle `engagements` (1 Auswahl → 1 Einsatz, idempotent über `candidacyId`), `orders` bleibt Beleg der Bestellung; Altdaten werden nicht automatisch zu Einsätzen.
2. **Betreuung durch Sales Ops:** Welche Daten braucht die Betreuungsrolle (`CUSTOMER_CARE`) am Kunden mindestens – Personen, Einsatz, Gesprächsnotizen, SOS? Vorschlag: Einsatzakte + Personen des Setups + eigene Check-ins, keine Chancen/Angebote.
3. **Beschaffungsprofil für „geplant“:** Gibt es je Kunde bereits eine Liste Pflichtunterlagen (Rahmenvertrag, Einzelbeauftragung, Bestellung, NDA)? Ohne Profil setzt E2 nur dokumentierte Zustände, kein „grün“.
4. **Konditions-Sichtbarkeit produktiv:** Entwicklungsdefault (BD, Suchbearbeiter:in, Principal, CEO sehen EK/VK) vor Echtdaten bestätigen oder einschränken.
