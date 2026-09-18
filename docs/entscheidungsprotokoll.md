# Entscheidungsprotokoll

Format: Datum · Entscheidung · Begründung · Auswirkung/Rückweg. Offene Produktionsfreigaben am Ende.

## E-001 · 2026-09-18 · Drizzle ORM statt Prisma
Das Briefing (17.1) nennt Prisma als Beispiel. Prisma benötigt für Migrationen einen Binär-Download von `binaries.prisma.sh`, der in der Entwicklungsumgebung durch die Netzwerkrichtlinie gesperrt ist (403). Drizzle ORM 0.45 + drizzle-kit 0.31 liefern typisierte Abfragen und versionierte SQL-Migrationen ohne Binärabhängigkeit. Rückweg: Migrationen sind reines SQL und mit jedem Werkzeug weiterführbar.

## E-002 · 2026-09-18 · Fixierte Versionen
Next.js 16.3.5, React 19.3.0, TypeScript 5.9.3 (nicht 7.x: Ökosystem-Kompatibilität), Zod 4.6.5, Tailwind 4.3.3, Vitest 5.0.1, Playwright 1.63.0, iron-session 9.0.1, pg 8.23, PostgreSQL 16. `npm audit`: 4 moderate Meldungen ausschließlich in drizzle-kit (esbuild-Dev-Server, wird nicht genutzt) – akzeptiert, bei Update von drizzle-kit prüfen.

## E-003 · 2026-09-18 · Entwicklungsanmeldung per Nutzerwahl
`AUTH_MODE=development`: Anmeldung ohne Passwort durch Auswahl einer fiktiven Person, deutlich als Entwicklungsmodus gekennzeichnet. `getConfig()` verweigert den Start in Produktion mit Entwicklungsanmeldung, Test-KI oder Beispiel-Sitzungsgeheimnis (S09, verifiziert: `next start` liefert 503 am Health-Endpunkt). OIDC-Anbieter: offen.

## E-004 · 2026-09-18 · Berechtigungsmodell für den Pilot
Rollen arbeitsraumweit oder je Kunde (`role_assignments.scope`). Setup-Mitgliedschaft mit „vereinbartem Beitrag“ statt pauschaler Rollenpflicht (Briefing 3). CEO/Principal sehen Zusammenfassungen, keine Rohquellen über den Titel. ADMIN ohne Inhaltszugriff. Nicht gefunden = keine Berechtigung (einheitliche Antwort).

## E-005 · 2026-09-18 · Beobachtung erzeugt immer Quelle + Aussagen
Jede erfasste Beobachtung legt eine Notiz-Quelle (mit gewählter Zugriffsklasse) sowie Aussagen mit Erkenntnisstatus „Aussage wiedergegeben“ und ggf. „Hypothese“ an. Damit ist „Quelle ansehen“ ab dem ersten Datensatz möglich und Beobachtung/Vermutung bleiben getrennt.

## E-006 · 2026-09-18 · Übernahme nur durch Annahme
Ein Hinweis wechselt den Verantwortlichen entweder durch eigene Übernahme (Setup-Bearbeitende) oder durch eine angenommene Übergabe. Selbstübergaben sind gesperrt (F05). Aktionen für andere starten als „vorgeschlagen“, außer sie sind als im Gespräch vereinbart markiert; annehmen darf nur die verantwortliche Person.

## E-007 · 2026-09-18 · „Was hat sich geändert?“ – ersetzt durch E-012
Vorläufiges 7-Tage-Fenster; seit Etappe 2 bezieht sich Abschnitt 2 des Setups auf den letzten bestätigten Weekly-Stand (ohne bestätigtes Weekly: alle Einträge).

## E-008 · 2026-09-18 · Noch nicht umgesetzte Bereiche sichtbar kennzeichnen
Weeklys, Ziele & Portfolio, Einstellungen sind in der Navigation vorhanden und zeigen einen klaren Hinweis „noch nicht umgesetzt (Etappe X)“ statt leerer Funktionen (Briefing 21).

## E-009 · 2026-09-18 · Playwright gegen Entwicklungsserver
E2E-Tests laufen gegen `next dev`, weil der Produktionsstart die Entwicklungsanmeldung korrekt blockiert. Produktionsbuild wird separat mit `npm run build` geprüft.

## E-010 · 2026-09-18 · Belegpflicht für Beziehungsstand und Kontaktweg
Beziehungsstände „Vorgestellt“, „Im Austausch“, „Konkrete Zusammenarbeit“ erfordern einen Beleg (vorhandene Quelle oder Belegnotiz, die als Quelle mit Zugriff „Setup“ gespeichert wird); Kontext ist bei jedem Stand Pflicht. Kontaktweg-Schritte dürfen nur „belegt“ heißen, wenn sie auf eine dokumentierte Beziehung (mindestens „Vorstellung angefragt“) oder Quelle verweisen; sonst „geplant“ oder „hypothetisch“ (F06). „Vermittlung zugesagt“ braucht einen Schritt mit Bereitschaft „bereit“; „Vorgestellt“ braucht eine Quelle und setzt den Beziehungsstand der Zielperson mit diesem Beleg.

## E-011 · 2026-09-18 · Personenfelder bewusst begrenzt
Die Person trägt nur Name, berufliche Kontaktdaten, Organisation, Funktion (zeitlich gültig), bekannte Zuständigkeit, Zugriffsklasse und Herkunft. Es gibt kein Freitext-Bewertungsfeld und keine Sponsor-/Champion-Markierung an der Person; solche Rollen werden später je Bedarf (Buyingcenter) mit Beleg geführt (Briefing 8.1/8.3).

## E-012 · 2026-09-18 · Weekly-Modell: Entwurf, Bestätigung, Snapshot, Korrekturversion
Die gemeinsame Notiz wird ausschließlich als Entwurf gespeichert. Beobachtungen, Aktionen und Entscheidungen aus dem Weekly werden als normale Objekte mit `review_id` angelegt (verknüpft, nicht kopiert). Die Bestätigung durch eine Teilnehmerin/einen Teilnehmer schreibt in einer Transaktion eine `review_version` mit Snapshot (IDs der erfassten Objekte, Anzahl offener Hinweise/Aktionen/Übergaben, Kontextsatz, Bezugszeitpunkt) und setzt das Review auf „bestätigt“. Ideen bleiben „vorgeschlagen“ (F07). Änderungen danach erzeugen eine Korrekturversion mit Pflichtbegründung; alte Versionen bleiben erhalten (11.4). Bestätigen darf nur ein Teilnehmender; Setup-Bearbeitende ohne Teilnahme dürfen mitschreiben, aber nicht bestätigen.

## E-013 · 2026-09-18 · Review-Zustände
Umgesetzt: geplant → laufend → Bestätigung offen → bestätigt („in Vorbereitung“ als optionaler Zwischenzustand). „Ersetzt“ aus Briefing 9.2 wird nicht als Review-Status geführt, sondern über `supersedes_version_id` an der Version – das Review selbst bleibt bestätigt, der gültige Stand zeigt auf die neueste Version.

## E-014 · 2026-09-18 · Accountplan ohne Zahlenfelder, Prioritäten mit Vier-Augen-Vereinbarung
Der Accountplan wird bei jedem Aufruf aus den Objekten gebaut (kein zweiter Datenbestand). Er enthält bewusst keine Betrags-, Potenzial- oder Forecast-Felder (Briefing 7). „Bestehende Zusammenarbeit“ zeigt nur Aussagen mit Erkenntnisstatus „Sachverhalt bestätigt“ und weist fehlende Belege aus. Prioritäten werden als „vorgeschlagen“ angelegt; „vereinbart“ setzt Zustimmungen aus beiden Rollen (zuständiger/account-bezogener BD und Principal) voraus – die erste Zustimmung wird gespeichert, ohne den Status zu ändern. Zurückstellen braucht einen Grund („bewusst zurückgestellte Themen“, A13). Der Zielbezug ist bis zum Zielobjekt (Etappe 4) ein Textfeld.

## E-015 · 2026-09-18 · Gespeicherte Accountplan-Stände
Ein gespeicherter Stand ist eine unveränderliche JSON-Kopie der Live-Übersicht mit Bestätiger und Zeitpunkt (Briefing 7: „Ein gespeicherter Review-Stand bleibt erhalten“). Er wird mit den Berechtigungen des Speichernden erzeugt – Inhalte außerhalb dessen Berechtigungsbereichs fehlen darin und werden im Stand als Hinweis ausgewiesen. Lesen darf, wer den Kunden sehen darf.

## E-016 · 2026-09-18 · Artefaktkatalog als versionierte Konfiguration
Die 19 Artefakttypen liegen in `src/modules/artifacts/templates.ts` (Registerversion) und werden per Seed in `artifact_templates` synchronisiert – damit sind Vorlagen „ohne Neubau justierbar“ (Briefing 2.2), bleiben aber im Repository nachvollziehbar. Jede Vorlage trägt ihren Umsetzungsstand: bereits als lebende Ansicht vorhanden (A1–A5, A13, Setup, Weekly), als Textentwurf verfügbar (A6, A8, A12, A14–A16) oder Textentwurf verfügbar mit noch folgendem Objektbezug (A7, A9–A11, Ziel). Keine Vorlage wird als fertig ausgegeben, wenn ihr Objekt fehlt.

## E-017 · 2026-09-18 · Artefaktversionen, Freigabe und Kundentext
Jedes Speichern erzeugt eine neue Version; freigegebene Versionen werden nie überschrieben, sondern „überholt“. Freigabe prüft Pflichtabschnitte und ist ausdrücklich kein Versand und kein Vorstellungsereignis (F09). Kundentext-Varianten (nur A5, A9) starten leer, erlauben nur dafür markierte Abschnitte, dürfen keine persönlichen Quellen referenzieren und brauchen zur Freigabe die Bestätigung, dass keine vertrauliche Herkunft, interne Bewertung oder nicht freigegebene Projektdetails enthalten sind (12.2). Coaching-/Eskalationsnotizen (A14) sind auf die Empfängerkreise „persönlich“ oder „Kundenteam“ beschränkt (11.4). Der Empfängerkreis wird pro Artefakt gesetzt und bei Lesezugriffen erzwungen.

## Offene Entscheidungen (Briefing 2.3) – Stand unverändert offen
| Thema | Aktueller lokaler Ersatz | Entscheidung nötig vor |
|---|---|---|
| Hosting/Produktivregion | lokal, PostgreSQL 16 | Echtdatenbetrieb |
| Unternehmensanmeldung (OIDC-Anbieter) | Entwicklungsanmeldung | Bereitstellung für reale Nutzer |
| Mail-/Kalenderanbieter | keiner; Adaptervertrag folgt in Etappe 3 | echtem Import |
| KI-Anbieter/Modell | `AI_PROVIDER=disabled`; Testanbieter folgt in Etappe 3 | KI-Verarbeitung echter Inhalte |
| Führendes CRM/Staffing-System | eigener Pilotdatenbestand | Synchronisation realer Stammdaten |
| Datenschutz (Zweck, Rechtsgrundlage, DSFA, Aufbewahrung, Löschkonzept) | Zugriffsklassen + Sperrung technisch vorbereitet | Echtdatenbetrieb |
| Sales-/Vergütungsregeln (A16) | nicht implementiert, keine Berechnung | Aktivierung entsprechender Prüfungen |
| Git-Remote | lokales Repository | Teamarbeit / CI |
