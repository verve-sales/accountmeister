# Implementierungsübersicht – Verve Sales-Arbeitsumgebung

Stand: 18.09.2026 · Etappen 0 und 1 abgeschlossen; Etappe 2 abgeschlossen; Etappe 3 umgesetzt: KI-Schnittstelle, Vorschlagslebenszyklus, Protokollimport, Outlook/Graph-Adapter (Fixture-Modus; echter Abruf nach App-Registrierung).
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
| Reviews | `src/modules/reviews` | BD-/Anker-Weekly: Vorbereitung aus letztem bestätigtem Stand, Notiz nur als Entwurf, Beobachtungen/Aktionen/Entscheidungen mit Weekly-Bezug, Bestätigung als versionierter Snapshot in einer Transaktion, Korrekturversionen; Setup-Abschnitt 2 bezieht sich auf den bestätigten Stand |
| Accountplan | `src/modules/accountplan` | A1 als Live-Übersicht aus bestätigten Daten (Einsätze mit Beleg, offene Hinweise, Beziehungen/Kontaktwege, Prioritäten, offene Fragen, Aktionen, Entscheidungen); Prioritäten (A13) mit Vier-Augen-Vereinbarung BD + Principal und begründeter Zurückstellung; gespeicherte Review-Stände bleiben unverändert erhalten |
| Artifacts | `src/modules/artifacts` | Alle 19 Artefakttypen (A1–A16, Setup, Weekly, Ziel) als versionierte Konfiguration registriert und in `artifact_templates` synchronisiert; je Typ Umsetzungsstand (Ansicht / Textentwurf / Objektbezug folgt); Textentwürfe mit Abschnitten, Vorbefüllung aus berechtigten Daten, Versionen, Prüfung/Freigabe, Empfängerkreis, Quellen; interne Notiz und Kundentext getrennt |
| AI / Suggestions | `src/modules/ai`, `src/modules/suggestions` | Anbietervertrag mit drei Adaptern (deaktiviert, deterministischer Testanbieter, gesperrter Produktivadapter), versionierter Prompt `structure-note.v1` + Zod-Ausgabeschema + Evaluationsfälle; Verarbeitungskette 14.4 mit Schema-/Quellenprüfung, erneuter Rechteprüfung (S05), Nutzungsgrenze, Dedupe/Wiederholungsregel (F15); Vorschläge mit allen Pflichtfeldern 14.2 und transparenten Prioritätskategorien 14.3; Annahme erzeugt nur ungeprüfte Objekte (Hinweis neu, Aktion vorgeschlagen, offene Frage, Entscheidung im offenen Weekly); Feedbackgründe; KI-Aufträge ohne Rohtext |
| Integrations / Imports | `src/modules/integrations`, `src/modules/imports` | Adaptervertrag 13.4 (verbinden, Berechtigungen, listen, abrufen, Änderung erkennen, widerrufen, Fehlerstatus); Microsoft-Graph-Adapter mit minimalen lesenden Scopes und Fixture-Modus, echter Verbindungsaufbau wird bis zur App-Registrierung ehrlich abgewiesen; Importprozess 13.2 für Protokolltext/-datei (.txt/.md) und einzelne Mails/Termine: Zielvorschlag, Umfang, Empfängerkreis, Nur-Text-Übernahme (S10), Quellenversionen, idempotente externe Kennungen, Zuordnungsprüfliste ohne automatische Zusammenführung, Strukturierung über die KI-Kette, Bestätigung mit Protokoll |
| Goals | – | Noch nicht begonnen (Etappen 3–4); Navigation zeigt dies ehrlich an |

## 3. Datenmodell (Etappe 0/1)

`src/db/schema.ts`, Migrationen `0000_init.sql`, `0001_kontaktwege.sql`, `0002_weeklys.sql`, `0003_accountplan.sql`, `0004_artefakte.sql`, `0005_ki-vorschlaege.sql`, `0006_quellenanbindung.sql`. Umgesetzt: workspaces, users, role_assignments, accounts, org_units, project_setups, setup_memberships, persons, person_functions, relationships, sources, assertions, assertion_evidence, signals, actions, handovers, access_plans, access_plan_steps, reviews, review_participants, review_versions, decisions, account_priorities, account_plan_snapshots, artifact_templates, artifact_versions, ai_jobs, suggestions, open_questions, integration_connections, import_jobs, source_versions, merge_review_items, audit_events.

Konventionen: UUID-Text-IDs, `created_at`/`updated_at` (timestamptz), `created_by`, `version` (optimistische Sperre auf Setup, Signal, Aktion, Übergabe), `workspace_id` überall. Fälligkeiten als `date`, Zeitpunkte als `timestamptz`; Anzeige in Europe/Berlin. Kein Soft-Delete-only: Quellen haben `is_locked` (Sperrung) getrennt von Löschung, das vollständige Löschkonzept folgt mit der Datenschutzentscheidung.

Noch nicht modelliert (folgt je Etappe): Opportunity, DecisionParticipation (Buyingcenter je Bedarf), Goal/GoalVersion/GoalContribution, SupportRequest, Offer/Order/StartRequirement, CandidateProfileReference, AccessGrant, PolicyVersion (bisher nur Textfeld am Workspace).

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
| Fachliche Regeln | `tests/hauptfall.test.ts`: F01, F03, F05, F07, Begründungspflicht, Übergänge, optimistische Sperre · `tests/personen-zugang.test.ts`: F06, Belegpflicht Beziehungsstand, Funktionswechsel, Zugriff auf Personen/Kontaktwege · `tests/weekly.test.ts`: F07 im Weekly, F11, zwei aufeinander aufbauende Weeklys, Korrekturversion, Zugriff · `tests/accountplan.test.ts`: F14, Prioritäten-Vereinbarung, Snapshot bleibt erhalten, Zugriff · `tests/artefakte.test.ts`: Registervollständigkeit, Versionen/Freigabe, F09 und Kundentext-Trennung, A14-Empfängerkreis, Zugriff · `tests/ai-provider.test.ts`: Evaluationsfälle (Halluzination, Prompt-Injection, Konflikt, kein Vorschlag), Schema · `tests/vorschlaege.test.ts`: Verarbeitungskette, S05, S06, F15, Halluzinations-Zurückweisung, KI deaktiviert, Nutzungsgrenze · `tests/import.test.ts`: S10 Sanitizer/Dateitypen, Protokollimport mit Versionen und Idempotenz, Prüfliste gleichnamiger Personen, Fixture-Adapter (Scopes, Auswahl, Import, Termin ≠ Beziehung, Anhänge, Widerruf), Zugriff | 39 Tests grün |
| Zugriff/Sicherheit | `tests/zugriff.test.ts`: S01, S02, S09, persönliche Quelle, ADMIN ohne Inhalt, Principal lesend | 7 Tests grün |
| End-to-End | `e2e/hauptfall.spec.ts` (Playwright): Hauptfall 19.1 Schritte 1–5, Zugriffsverweigerung, Health-Endpunkt, Personen & Zugang (Belegpflicht, F06), zwei aufeinander aufbauende Weeklys, Accountplan mit Vier-Augen-Vereinbarung und gespeichertem Stand, Artefaktkatalog und Entwurf→Version→Freigabe, Notiz strukturieren → Vorschlag annehmen/ablehnen, Postfach verbinden → Mail importieren → Protokoll importieren → Prüfliste → bestätigen | 8 Tests grün |
| Technisch | Migration von leerer DB (Test-Setup macht das bei jedem Lauf), Seed idempotent, Build, Typecheck, Lint | grün |

Noch offen: F02, F04, F08, F10, F12, F13, F16; S03, S04, S07, S08, S11, S12 – jeweils mit den zugehörigen Etappen.

## 6. Nächste Schritte (Etappe 1 abschließen, Etappe 2 beginnen)

Etappe 4 (alle Führungsebenen):
1. Principal-/BD-Weekly: Portfolioveränderungen, Zugangslücken, Unterstützungsaufträge (SupportRequest) mit Annahme und Ergebnis, Prioritäten vs. Zeit.
2. CEO-/Principal-Zielgespräch: Goal/GoalVersion/GoalContribution (Ergebnis, Geltungsbereich, Kriterium, Ausgangslage mit Quelle, Zielwert nur wenn vereinbart), Bestätigung, Änderungshistorie; keine automatischen Quoten.
3. Ziele & Portfolio als Ansicht; vertrauliche Coaching-/Führungsbereiche mit gesondertem Empfängerkreis (S04).
Nachgelagert: echter Graph-Abruf (App-Registrierung im Verve-Tenant, Token-Verschlüsselung, Datenschutzfreigabe); PDF/DOCX-Import nach Prüfung sicherer Verarbeitung.
Nachgelagert: Setup-Übergabe aus dem Eingang direkt bedienbar; Buyingcenter je Bedarf (Etappe 5); grafische Beziehungskarte.
