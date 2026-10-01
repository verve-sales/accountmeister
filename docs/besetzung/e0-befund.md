# Besetzung – E0: Codeabgleich, Architekturentscheidung, Migrationsskizze

Stand: 1. Oktober 2026 · Branch `besetzung-e1` · Grundlage: Coder-Briefing „Besetzung und Einsatzbetreuung im Accountmeister“ v1.0.
Vertrauliche Befunde zur Vergütung stehen nicht in diesem Dokument (gesonderter Befund an die Geschäftsführung).

## 1. Befundtabelle (bestätigt / widerlegt / ungeprüft)

| Thema | Briefing-Annahme | Befund | Fundstelle |
|-|-|-|-|
| Rollen | `SALES_OPS` vorhanden, arbeitsraumweit | **bestätigt**; zusätzlich: Sales Ops darf heute über `canViewSetup`/`canEditSetup` *alle* Setups sehen und pflegen (Etappe 22). Für Besetzungsdaten wird das bewusst **nicht** übernommen (eigene Prüfung in `staffing/authz.ts`). | `src/modules/identity/actor.ts` (`isSalesOps`), `src/modules/identity/authz.ts:86–114`, `assertCanCarryResponsibility` (Sales Ops trägt keine Verantwortung) |
| Principal | „darf alles am Account“ | **bestätigt** für Setups/Chancen (`canEditSetup`: PRINCIPAL am Kunden → true). Für Besetzung: Principal = Manager am Kunden (Freigabe/Auswahl), aber keine Vorlage für neue Datenklassen über das Setup-Recht. | `authz.ts:101–113` |
| Quellen | Zugriffsklassen | **bestätigt**: `access_class` PERSOENLICH/SETUP/ACCOUNT_TEAM/…; `canViewSource` erlaubt seit Etappe 26 auch dem zuständigen BD die SETUP-Klasse. Texteingang legt Quellen mit Klasse SETUP an. | `src/db/schema.ts:57`, `authz.ts:124` |
| `actions` / `handovers` | Ein führender Vorgang | **teilweise widerlegt (positiv)**: Seit Etappe 27 existiert `work_items` (Anfrage/Annahme/Prüfung/Abnahme, Team-Warteschlange, Leitung, Werktagsfristen, Vertretung, Benachrichtigungen). `actions` (Weekly-Aktionen) und `handovers` laufen parallel weiter. Besetzung nutzt **ausschließlich `work_items`** (kind `SUCHE`, subject `POSITION`) und ergänzt `RUECKFRAGE`/`BEANTWORTEN`/`ABGEBEN`. Keine neue Aufgabentabelle. | `src/modules/work/service.ts`, `work/teams.ts`, Migration 0027 |
| `orders` | „möglicherweise Auftrag, nicht genau ein Einsatz“ | **bestätigt**: `orders` hängt an `opportunities` (1:n), hat Bestellreferenz, Start/Ende, `consultantUserId`/`consultantName`, Vertrag (`contractSourceId`/`contractLink`), Statuswerte IN_VORBEREITUNG → BEAUFTRAGUNG_BESTAETIGT; dazu `engagement_status` GEPLANT/STARTBEREIT/GESTARTET/BEENDET, Start-Requirements. Interne Berater und Freelancer sind nur über `consultantUserId` (intern) vs. `consultantName` (frei) unterscheidbar – **kein** Freelancer-Vertragsmodell. E1 fasst `orders` nicht an; E2 braucht eine Zuordnungstabelle Auswahl → Einsatz. | `schema.ts:1122–1123, 1225–1255`, `opportunities/service.ts` (`createOrder`, `confirmOrder`, `markReady`, `markStarted`) |
| Opportunity-Status | Abschlussprozess vorhanden | **bestätigt**: `AUSWAHL_BESTELLUNG → BEAUFTRAGT` entsteht nur über `confirmOrder`; „vorgestellt“ nur über Angebot. Besetzung ändert den Chancen-Status **nicht**; Teilbesetzung wird am Block gezeigt und verlinkt auf `#auftrag`. | `opportunities/service.ts:245, 280–286` |
| Verlängerung | Standardaufgaben + Fahrplan | **bestätigt**: `health/renewal.ts` (`renewal-ping` 90 Tage, Fahrplan PING/START/WIRKUNG/BEDARF/ANGEBOT/ESKALATION/ENDE aus Standardaufgaben und Playbook-Schritten). Eine führende Logik, keine zweite 12/8/4-Wochen-Regel. E2 integriert Catch-ups dort. | `src/modules/health/renewal.ts`, `health/service.ts` (`renewalRoadmaps`) |
| KI | Provider-Abstraktion, versionierte Prompts, Jobs mit Limit | **bestätigt**: `AIProvider` (disabled/test/langdock/production), `runAiJob` (Tageslimit, Hash-Logging, Belegprüfung `evidenceFound`), Tasks in `AI_TASKS`. Zwei neue Tasks `STAFFING_AD_DRAFT`, `STAFFING_NOTE_STRUCTURE`; Prompts als **vorläufig** markiert. | `src/modules/ai/{provider,jobs,settings}.ts`, `prompts/index.ts` |
| KI-Kontext | Rechtefilter | **bestätigt** für Assistent (`buildContextText` rechtegefiltert). **Befund**: Hilfewissen ist für alle gleich und ging in den Assistent-Kontext – inklusive eines Satzes zur Provisionsstaffel (bereinigt, siehe Abschnitt 4). | `src/modules/help/{knowledge,service}.ts`, `assistant/service.ts` |
| Vergütung | Ausgabepfade prüfen | **geprüft**: Provisionsservice (`provision/model.ts`), Client-Bundle (`ProvisionCalculator.tsx` importierte die volle Konfiguration), Legende/Warnhinweis, Hilfe, Handbuch, Videos, Tests. Härtung in diesem Branch; Details vertraulich. | s. gesonderter Befund |
| Technik | Next/Drizzle/Zod/Entra | **bestätigt**: Next 16, React 19, Drizzle 0.45, Zod 4, Vitest 5, Playwright; Lockfile unverändert, keine neuen Pakete. | `package.json`, `package-lock.json` |
| Betrieb | Compose, Migrationen beim Start | **bestätigt**: `scripts/start.sh` → `migrate.mjs`; Feature-Flag `FEATURE_BESETZUNG` (Compose-Default `false`). | `docker-compose.yml`, `src/lib/config.ts` |
| Scheduler | Worker nötig? | **bestätigt vorhanden**: Takt im App-Prozess (`src/instrumentation.ts` → `notifications/worker.ts`: minütlich Mails, stündlich Überfällig, täglich Digest). E2 hängt Catch-ups daran. | `src/modules/notifications/worker.ts` |
| Ungeprüft | Restore-Probe mit Produktionsabbild (A30), Mehrfachrollen-Policy für Vergütungs-Scopes (A08 produktiv) | **ungeprüft** – nicht Teil von E1; keine Produktionsdaten verwendet. | – |

## 2. Architekturentscheidung (ADR-Kurzform)

**Entscheidung:** Modularer Monolith im Accountmeister. Neue Domäne `src/modules/staffing` (Position, Freelancer-Minimalstamm, Kandidatur, Ereignisse, Texteingang, KI-Entwürfe) mit eigener Rechteprüfung `staffing/authz.ts`. Arbeitsaufträge über den bestehenden Kern `work` (Etappe 27), kein zweites Ticket-System. Einsatz/Betreuung (E2) als Domäne `engagements` auf Basis von `orders` plus Zuordnungstabelle.

**Domänengrenzen:**
- `opportunities` bleibt führend für Chance, Angebot, Auftrag und Status. `staffing` referenziert `opportunityId` und leitet Account/Setup daraus ab (keine freie Wahl dreier IDs).
- `work` liefert Suchauftrag (`kind=SUCHE`, `subjectType=POSITION`), Warteschlange, Annahme, Rückfrage, Rückgabe, Abnahme, Benachrichtigung.
- `staffing` kennt Sales Ops nicht als Rolle, sondern nur als **angenommene Suchbearbeiter:in** eines Vorgangs (Objektbezug statt Rollenpauschale).
- Vergütung bleibt in `provision` (reine Rechenlogik, keine Speicherung) und wird in `staffing` nicht importiert.

**Verworfen:** separate App (Vorgabe F01), Erweiterung des Opportunity-Statusmodells (6.1), Ableitung der Besetzungsrechte aus `canEditSetup` (würde Sales Ops arbeitsraumweit alle Kandidaturen zeigen).

## 3. Schema-/Migrationsskizze (umgesetzt in Migration 0028, additiv)

| Briefing 3.x | Tabelle | Anmerkung |
|-|-|-|
| 3.1 Position | `staffing_positions` | ein Platz; `opportunity_id` + abgeleitete `account_id`/`setup_id`; Konditionen als `numeric(10,2)` getrennt EK/VK, `null` = offen; Status ENTWURF/OFFEN/PAUSIERT/BESETZT/ABGEBROCHEN; `filled_candidacy_id` (genau eine erfolgreiche Auswahl); `copied_from_id`, `replaces_position_id`; `ad_draft` + `ad_status` |
| 3.2 Freelancer | `freelancers` | Minimalstamm, `merged_into_id` für spätere Zusammenführung; keine Bank-/Ausweis-/Steuerdaten |
| 3.3 Kandidatur | `candidacies` | Unique-Index aktive Kandidatur je Position/Freelancer (`WHERE is_active`), Konditionsstand mit Datum, kundenspezifische Notizen getrennt vom Stamm |
| 3.4 Vorstellung/Interview | `candidacy_events` | unveränderlich; Vorstellung mit Empfänger, Profilreferenz + Prüfsumme, Weitergabe (Umfang/Stand/Bestätigung), Preis; Interview-Status; Rückmeldung; Absage; Wiederaufnahme; Auswahl |
| 3.5 Arbeitsauftrag | `work_items` (bestehend) + `resume_status` | Typen SUCHE/SHORTLIST/NACHFASSEN; Status RUECKFRAGE; Aktionen RUECKFRAGE/BEANTWORTEN/ABGEBEN |
| 7.3 Texteingang | `staffing_intakes` + `sources` | Vorschlag mit Belegstellen, Status OFFEN/UEBERNOMMEN/VERWORFEN |
| 3.6–3.10 | – | E2 (Betreuungszuordnung, Einsatz-Mapping auf `orders`, Perioden, Vertragsunterlagen, Check-ins) |

Rückweg: Migration ist rein additiv (neue Tabellen, eine Spalte). Code-Rollback lässt Tabellen stehen; `DROP TABLE` nur nach Freigabe.

## 4. Rechte-Matrix E1

Datenklassen: **OP** operativer Kontext (Bedarf ohne Konditionen) · **VP** Teamvorschau (Titel, Kunde, Muss, Termin) · **IK** interne Konditionen (EK/VK-Rahmen, Kandidaten-EK, interne Notizen) · **KA** Kandidaturen/Ereignisse · **FS** Freelancer-Stammdaten · **AD** Ausschreibungsentwurf · **PR** Provision (unverändert, nicht Teil der Besetzung).

| Akteur | OP | VP | IK | KA | FS | AD | Anlegen/Status | Suchauftrag | Freigabe Vorstellung / Auswahl |
|-|-|-|-|-|-|-|-|-|-|
| Positions-BD / zuständiger BD / Setup-BD (mit BD-Rolle am Kunden) | ja | – | ja | ja | nur via eigene Kandidaturen | ja + freigeben | ja | erteilen | ja |
| Principal (kundenbezogen oder arbeitsraumweit), CEO | ja | – | ja | ja | Pool | ja + freigeben | ja | erteilen | ja |
| Sales Ops **nach** Annahme des Suchauftrags | ja | – | ja | ja (pflegen) | Pool | erzeugen/bearbeiten | nein | übernehmen, Rückfrage, abgeben | nein |
| Sales Ops **vor** Annahme (Team-Mitglied) | nein | ja | nein | nein | Pool | nein | nein | sehen/übernehmen | nein |
| Anker (auch Setup-Mitglied) | nein | nein | nein | nein | nein | nein | nein | nein | nein |
| fremder BD / anderer Workspace | nein | nein | nein | nein | nur via eigene Kandidaturen | nein | nein | nein | nein |
| Admin | nein (nur Betrieb) | – | nein | nein | nein | nein | nein | nein | nein |

Negative Tests (grün): A01 fremde ID/Anker/Sales Ops ohne Auftrag → 404; A03 Vorschau ohne EK/Kandidaturen; A04 Sales Ops/Anker können keine Position anlegen, Freigabe/Auswahl nur Manager; A05 parallele Annahme → Konflikt; A14/A15 genau eine Auswahl, Wiederholung ohne zweite Wirkung; A16 fremde Kandidaturhistorie verborgen; A17 Vorstellungsstand unveränderlich; A18 kein Vorstellen ohne Freigabe, keine Auswahl ohne Bestätigung; A19 zurückgegebener Auftrag bleibt sichtbar; A25 veraltete Version → Konflikt; A27 ohne KI vollständig manuell; A10 Client-Konfiguration ohne vertrauliche Stufe. Offen (E2/Produktion): A06–A09, A11, A13, A20–A24, A26, A28–A30.

Nicht neu vergeben: Freigaberechte für Verträge/Vergütung, Mehrfachrollen-Scopes, Delegation an beliebige Personen (Abschnitt 16).

## 5. Implementierungs-Checkliste E1 (Stand)

- [x] Migration 0028 (additiv), Feature-Flag `FEATURE_BESETZUNG`
- [x] `staffing/authz.ts` (Fähigkeit × Objekt × Datenklasse), `staffing/service.ts` (Position, Suchauftrag, Freelancer, Kandidatur, Vorstellung, Interview, Rückmeldung, Auswahl, Listen), `staffing/ai.ts` (Ausschreibungsentwurf, Texteingang), `staffing/drafts.ts` (regelbasierter Ersatzweg)
- [x] `work`: Bezug POSITION, Typen SUCHE/SHORTLIST/NACHFASSEN, Rückfrage/Beantworten/Abgeben, Konflikt bei veralteter Version
- [x] UI: Block „Besetzung“ an der Chance, `/besetzung` (Filter meine/Team/offen/pausiert/überfällig/besetzt), `/besetzung/[id]` (Vorschau- und Vollsicht), `/besetzung/eingang/[id]`, `/besetzung/freelancer[/id]`, Navigation
- [x] KI-Tasks + vorläufige Prompts, Testanbieter deterministisch
- [x] Hilfe (zwei Abschnitte), Tests (`tests/besetzung.test.ts`, A10 in `tests/provision.test.ts`), Demo-Skript `docs/besetzung/demo-e1.mjs`
- [ ] E2: Einsatzakte, Betreuungszuordnung, Perioden, Vertragsstatus, Catch-ups, Dateieingang
