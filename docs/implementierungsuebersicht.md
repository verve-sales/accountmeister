# Implementierungsübersicht – Verve Sales-Arbeitsumgebung

Stand: 18.09.2026 · Etappe 0 abgeschlossen, Etappe 1 umgesetzt (vertikaler Hauptfall + Personen & Zugang).
Referenz: `docs/briefing.md` (Produkt- und Entwicklungsbriefing). Entscheidungen: `docs/entscheidungsprotokoll.md`.

## 1. Architektur

Modularer Monolith (Briefing 17.1): Next.js 16 (App Router, Server Components, Server Actions) mit TypeScript, PostgreSQL 16 als persistente Datenbank, Drizzle ORM mit versionierten SQL-Migrationen, Zod für Eingabevalidierung, iron-session für die verschlüsselte Sitzung, Vitest für Integrationstests gegen die echte Testdatenbank und Playwright für End-to-End-Tests im Browser.

Schichten (17.2): UI (`src/app`) → Server Actions (`src/app/actions.ts`, nur Formularbrücke) → fachliche Services (`src/modules/*/service.ts`) → Datenzugriff (`src/db`). Berechtigungs- und Übergangslogik liegt ausschließlich in `src/modules/identity/authz.ts` und den Services; die UI blendet nur an, was der Service ohnehin erzwingt.

## 2. Fachmodule und Stand

| Modul (17.2) | Verzeichnis | Stand |
|---|---|---|
| Identity/Access | `src/modules/identity` | Akteur pro Anfrage frisch geladen; Arbeitsraum- und Account-Rollen; zentrale Regeln `authz.ts`; Entwicklungsanmeldung (Nutzerwahl, nur `AUTH_MODE=development`) |
| Accounts/Setups | `src/modules/accounts`, `src/modules/setups` | Kunden anlegen/listen (berechtigungsgefiltert); Setup anlegen mit minimalen Angaben, „Zuordnung offen“, Beteiligte mit vereinbartem Beitrag, optimistische Sperre |
| Knowledge/Sources | `src/modules/knowledge`, Tabellen `sources`, `assertions`, `assertion_evidence` | Quelle mit Zugriffsklasse (persönlich/Setup/Kundenteam/Arbeitsraum); Aussagen mit Erkenntnisstatus (15.3) und Quellenbezug; „Quelle ansehen“ |
| Signals | `src/modules/signals` | Beobachtung erfassen (A3): Beobachtung, Vermutung, Nutzungsgrenze getrennt; Zustandsmaschine 9.2; Übernahme; Beenden/Zurückstellen mit Begründung |
| Actions/Handovers | `src/modules/actions`, `src/modules/handovers` | Aktion mit Vorschlag/Annahme (F07), Erledigt nur mit Ergebnis (9.3); Übergabe mit Pflichtinhalt 10.1, Annahme/Rückgabe/Abschluss, keine Selbstübergabe (F05) |
| Audit/Policies | `src/modules/audit` | Audit-Ereignisse je schreibender Operation (minimal, keine Rohquellen); `policy_version` am Workspace |
| People/AccessPaths | `src/modules/people`, `src/modules/accesspaths` | Personen (nur berufliche Felder), zeitlich gültige Funktionen, Beziehungsstand mit Kontext- und Belegpflicht, Kontaktweg (A5) mit Schritten belegt/geplant/hypothetisch und Statuslogik; Seite „Personen & Zugang“ je Setup (tabellarisch; Karte folgt) |
| Reviews/Goals, Artifacts/Suggestions, Integrations/Jobs | – | Noch nicht begonnen (Etappen 2–4); Navigation zeigt dies ehrlich an |

## 3. Datenmodell (Etappe 0/1)

`src/db/schema.ts`, Migrationen `0000_init.sql`, `0001_kontaktwege.sql`. Umgesetzt: workspaces, users, role_assignments, accounts, org_units, project_setups, setup_memberships, persons, person_functions, relationships, sources, assertions, assertion_evidence, signals, actions, handovers, access_plans, access_plan_steps, audit_events.

Konventionen: UUID-Text-IDs, `created_at`/`updated_at` (timestamptz), `created_by`, `version` (optimistische Sperre auf Setup, Signal, Aktion, Übergabe), `workspace_id` überall. Fälligkeiten als `date`, Zeitpunkte als `timestamptz`; Anzeige in Europe/Berlin. Kein Soft-Delete-only: Quellen haben `is_locked` (Sperrung) getrennt von Löschung, das vollständige Löschkonzept folgt mit der Datenschutzentscheidung.

Noch nicht modelliert (folgt je Etappe): Opportunity, DecisionParticipation (Buyingcenter je Bedarf), OpenQuestion, Review/ReviewVersion, Decision, Goal/GoalVersion/GoalContribution, SupportRequest, Offer/Order/StartRequirement, CandidateProfileReference, Suggestion, ArtifactVersion, IntegrationConnection, ImportJob/AIJob, AccessGrant, PolicyVersion (bisher nur Textfeld am Workspace).

## 4. Berechtigungsmodell (16.2)

Serverseitig, deterministisch, pro Anfrage:

- Kunde sehen: zuständiger BD, Principal, CEO (Zusammenfassung), account-bezogene Rollen, Mitglieder eines Setups des Kunden.
- Setup sehen: Mitglieder, Ersteller, zugeordneter BD, zuständiger BD des Kunden, Principal, CEO (Zusammenfassung), je Sichtbarkeit Kundenteam/Arbeitsraum.
- Setup bearbeiten: Mitglieder mit Bearbeitungsrecht, Ersteller (bis zur angenommenen Übergabe), zugeordneter BD, zuständiger BD; nicht bei archiviertem Setup.
- Quelle sehen: Inhaber immer; „persönlich“ nur Inhaber; „Setup“ Mitglieder; „Kundenteam“ zusätzlich zuständiger BD/Principal; „Arbeitsraum“ alle inhaltlichen Rollen. CEO ohne weitere Rolle sieht nur Arbeitsraum-Quellen (S02). ADMIN hat keinen Inhaltszugriff.
- Fehlende Berechtigung und Nichtexistenz liefern dieselbe Antwort („nicht gefunden oder keine Berechtigung“) – keine Metadatenleckage (S01).

## 5. Testplan und Stand

| Bereich | Umsetzung | Stand |
|---|---|---|
| Fachliche Regeln | `tests/hauptfall.test.ts`: F01, F03, F05, F07, Begründungspflicht, Übergänge, optimistische Sperre · `tests/personen-zugang.test.ts`: F06, Belegpflicht Beziehungsstand, Funktionswechsel, Zugriff auf Personen/Kontaktwege | 12 Tests grün |
| Zugriff/Sicherheit | `tests/zugriff.test.ts`: S01, S02, S09, persönliche Quelle, ADMIN ohne Inhalt, Principal lesend | 7 Tests grün |
| End-to-End | `e2e/hauptfall.spec.ts` (Playwright): Hauptfall 19.1 Schritte 1–5, Zugriffsverweigerung, Health-Endpunkt, Personen & Zugang (Belegpflicht, F06 in der Oberfläche) | 3 Tests grün |
| Technisch | Migration von leerer DB (Test-Setup macht das bei jedem Lauf), Seed idempotent, Build, Typecheck, Lint | grün |

Noch offen: F02, F04, F08–F16; S03–S08, S10–S12 – jeweils mit den zugehörigen Etappen.

## 6. Nächste Schritte (Etappe 1 abschließen, Etappe 2 beginnen)

1. Setup-Übergabe aus dem Eingang (BD-Zuordnung) direkt bedienbar machen.
2. Weekly (Etappe 2): Vorbereitung aus letztem bestätigten Stand, Freitextnotiz, Änderungsvorschau, Bestätigung mit Version.
3. Accountplan (A1) als verdichtete Sicht aus bestätigten Daten.
4. Buyingcenter je Bedarf (DecisionParticipation) mit dem Bedarfsobjekt (Opportunity).
5. Grafische Beziehungskarte als gleichwertige Alternative zur Kontaktweg-Tabelle.
