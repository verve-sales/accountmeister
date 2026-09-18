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

## E-018 · 2026-09-18 · Mail-/Kalenderanbieter: Microsoft 365 / Outlook
Entscheidung des Auftraggebers (Ivo Seifert): Verve nutzt Microsoft Outlook. Der Adapter wird gegen Microsoft Graph gebaut (lesend, minimale delegierte Berechtigungen für ausgewählte Mails und Termine; keine Schreibrechte). Voraussetzungen vor echtem Import: App-Registrierung im Verve-Tenant, Freigabe der Berechtigungen, Datenschutzbewertung (Zweck, Rechtsgrundlage, Datenklassen, Aufbewahrung). Bis dahin: Adaptervertrag mit Testfixtures; kein Anbieter wird als angeschlossen dargestellt.

## E-019 · 2026-09-18 · KI-Anbieter im Pilot: deterministischer Testanbieter
`AI_PROVIDER=test` ist ein regelbasierter Anbieter ohne Sprachmodell und ohne Netzwerk. Er dient dazu, Vorschlagslebenszyklus, Schema-/Quellenprüfung und Evaluationsfälle vollständig lokal zu entwickeln. Der Produktivadapter (`production`) existiert als Konfigurationswert, wirft aber, bis Anbieter, Modell, Vertrag, Datenklassen und Datenschutzfreigabe entschieden sind. In Produktion ist `test` gesperrt (S09). Prompt- und Schemaversion (`structure-note.v1`) werden an jedem Vorschlag und Auftrag gespeichert.

## E-020 · 2026-09-18 · Vorschlagsverarbeitung
Kette: berechtigten Kontext laden (nur Notiztext, Namen, bestätigte Aussagen) → Anbieter → Zod-Schema → Quellenprüfung (Zitat muss wörtlich in der Notiz stehen; zugeordnete Personen müssen Teilnehmende sein) → Rechte erneut laden (S05) → speichern → Mensch entscheidet. Dedupe je Setup über Typ + normalisiertes Zitat; bereits entschiedene Vorschläge werden ohne neue Information nicht wiederholt (F15). Auftragsprotokolle speichern Hash und Länge des Eingabetexts, nie den Text (16.4). Annahme erzeugt ausschließlich ungeprüfte Objekte; Aktionen aus Vorschlägen für andere starten als „vorgeschlagen“. Nutzungsgrenze `AI_DAILY_JOB_LIMIT` je Arbeitsraum und Tag.

## E-021 · 2026-09-18 · Import: Nur-Text, freigegebene Dateitypen, Idempotenz, Versionen
Importierte Inhalte werden ausschließlich als Nur-Text übernommen (Skripte, Bilder/Tracker, Auszeichnungen entfernt; Links bleiben Text und werden nie serverseitig abgerufen – S10/17.4). Dateien: nur .txt und .md bis 2 MB; PDF/DOCX erst nach Prüfung einer isolierten Verarbeitung. Externe Kennung (Mail-/Termin-ID bzw. Inhalts-Hash) macht Wiederimporte idempotent; geänderter Inhalt erzeugt eine neue Quellenversion, die alte bleibt. Anhänge werden nie übernommen, nur im Importumfang genannt.

## E-022 · 2026-09-18 · Keine automatische Personenzusammenführung
Namensgleichheit ist kein Identitätsbeweis (13.4). Nur ein eindeutiger E-Mail-Treffer gilt als sichere Zuordnung; alle anderen Nennungen landen in einer Prüfliste (zusammenführen / neue Person / ignorieren), die vor der Importbestätigung abgearbeitet sein muss. Verve-eigene Nutzer erscheinen nicht in der Prüfliste. Ein Termin belegt Planung, nicht Teilnahme – der Import erzeugt keine Beziehung.

## E-023 · 2026-09-18 · Graph-Adapter im Fixture-Modus
Der Adapter fordert nur User.Read, Mail.Read, Calendars.Read, offline_access (lesend, delegiert). Ein echter Verbindungsaufbau wird abgewiesen, bis Client-ID, Tenant-ID, Redirect-URI und Datenschutzfreigabe konfiguriert sind; der Fixture-Modus wird in Status, Quelle und Importwarnungen als solcher gekennzeichnet. Tokens werden nur als Referenz gespeichert (im Echtbetrieb serverseitig verschlüsselt); Widerruf löscht Referenz und Scopes.

## E-024 · 2026-09-18 · Unterstützungsaufträge statt Eskalation
Ein Unterstützungsauftrag (11.1, F13) hat genau einen Adressaten mit Principal- oder CEO-Rolle, einen konkreten Auftragstext (Mindestlänge) und optional Frist und Setup-Bezug; Aufträge an sich selbst sind ausgeschlossen. Der Adressat nimmt an, gibt zurück oder meldet ein Ergebnis; der Anfragende kann zurückziehen. Die Fallverantwortung bleibt beim BD; das Setup zeigt Aufträge im Kontext, „Meine Arbeit“ zeigt offene Aufträge beider Seiten. Kein pauschaler „Eskalations“-Mechanismus.

## E-025 · 2026-09-18 · Portfolio als Zählung, nicht als Bewertung
Die Portfolioübersicht (11.2) verwendet dieselbe Datenbasis wie die Accountpläne und zeigt ausschließlich Zählungen dokumentierter Objekte (Setups ohne bestätigtes Weekly, Änderungen, offene Fragen, Zugangslücken, unbelegte Beziehungen, Prioritäten, blockierte Aktionen, offene Unterstützung, letztes bestätigtes Weekly). Keine Umsatz-, Forecast-, Potenzial- oder Personenbewertungen (Briefing 7). Rohquellen sind nicht enthalten; der CEO sieht nur Zusammenfassungen.

## E-026 · 2026-09-18 · Führungs-Reviews ohne Setup, Zugriff über Teilnehmerkreis
Principal-/BD-Weekly und CEO-/Principal-Zielgespräch sind Reviews ohne Setup-Bezug. Zugriff haben ausschließlich Teilnehmende; Nicht-Teilnehmende erhalten „nicht gefunden“ (S01/S02). Gleiche Semantik wie beim BD-/Anker-Weekly: Notiz nur als Entwurf, Entscheidungen, Bestätigung als Snapshot (Entscheidungen, Unterstützungsaufträge, vereinbarte Ziele).

## E-027 · 2026-09-18 · Ziele: Zustimmung beider Rollen, Zielwert nur mit Ausgangslage
Ein Ziel (11.3, F12) wird „Vereinbart“ erst, wenn eine Person mit CEO-Rolle **und** eine mit Principal-Rolle zugestimmt haben; die erste Zustimmung wird gespeichert („Zur Abstimmung“). Jede inhaltliche Änderung erzeugt eine neue Version mit Änderungsgrund; ein vereinbartes Ziel wird dadurch „Geändert“ und braucht die erneute Zustimmung beider Rollen. Ein Zielwert ist nur zulässig mit dokumentierter Ausgangslage (ggf. ausdrücklich „unbekannt“) und beobachtbarem Erfolgskriterium. Keine automatischen Quoten, keine Ableitung von Zielwerten aus Portfolio- oder Umsatzdaten. Zielbeiträge führen erwartet und belegt getrennt; ein belegter Beitrag braucht eine Quelle.

## E-028 · 2026-09-18 · Vertrauliche Führungsnotizen
Vertrauliche Notizen (11.4, S04) werden nur von Principal/CEO in einem Führungs-Review angelegt und haben einen expliziten Empfängerkreis (Autor plus gewählte Teilnehmende). Sie erscheinen nie im Setup, im Accountplan, in Artefakten oder im KI-Kontext und werden Nicht-Empfängern auch nicht als Abschnitt angezeigt.

## E-029 · 2026-09-18 · Bedarfe: eigener Zustand je Bedarf, Bestätigung nur mit Beleg
Bedarfe (Opportunity) hängen an einem Setup und haben je einen eigenen Zustand (9.2); es gibt keinen Kunden-Pipelinestatus (F02). Ein Bedarf ist mit Titel und Beschreibung anlegbar – ohne vollständiges Setup, Buyingcenter oder MEDDPICC (F08). Fast-Track setzt den Messstart manuell beim Anlegen; die Anwendung garantiert keine Besetzung. „Bestätigt“ braucht einen Beleg (vorhandene Quelle oder neue Belegnotiz) und speichert den Zeitpunkt; Budget-/Beschaffungsinformation ist nicht Voraussetzung. „Vorgestellt“ und „Beauftragt“ entstehen ausschließlich über Angebot bzw. Auftrag, nie durch direkten Statuswechsel. Ein aus einem Hinweis hervorgegangener Bedarf setzt den Hinweis auf „mit Bedarf verknüpft“.

## E-030 · 2026-09-18 · Buyingcenter und MEDDPICC ohne erfundene Sicherheit
Rollen im Buyingcenter (8.3) werden je Bedarf geführt; eine Funktion kann ohne Person angelegt werden, eine Person mehrere Rollen haben. Der Erkenntnisstatus startet als Hypothese; „bestätigt“ braucht eine Quelle – ein Titel belegt keine Entscheidungsvollmacht. MEDDPICC (9.4) sind acht freie Textfelder ohne Pflicht, Vollständigkeitsanzeige, Ampel oder Bewertung.

## E-031 · 2026-09-18 · Angebot: Entwurf ist nie „vorgestellt“; akzeptiert ist kein Auftrag
Ein Angebot durchläuft Entwurf → geprüft → tatsächlich vorgestellt (F09: nur mit Empfängerangabe, Zeitpunkt nicht in der Zukunft und Beleg) → Rückmeldung. Eine positive Rückmeldung setzt den Bedarf höchstens auf „Auswahl/Bestellung“ – kein Auftrag, kein Start (F10). Profile werden nur als freigegebene Referenzen (Bezeichnung, Ablageort, Verfügbarkeit) verwaltet, sichtbar für BD/Principal/CEO; kein Kandidatenmanagement, keine Profilinhalte.

## E-032 · 2026-09-18 · Auftrag und Start nur mit Nachweisen
„Beauftragung bestätigt“ braucht Referenz und Nachweisquelle. Startvoraussetzungen werden je Auftrag erfasst (Anforderung, prüfende Stelle, Regelbezug); „bestätigt“ braucht einen Nachweis, „nicht anwendbar“ eine Begründung. „Startbereit“ verlangt mindestens eine erfasste und bestätigte bzw. begründet nicht anwendbare Voraussetzung – eine leere Prüfliste gilt nicht als erfüllt. „Gestartet“ ist ein manuell bestätigtes Ereignis mit Zeitpunkt, nie die Folge eines erreichten Datums. Ohne freigegebene Regelkonfiguration zeigt die Anwendung den dokumentierten Stand und behauptet keine produktive Einsatzfreigabe. Vergütungs-/Provisionsberechnung (A16) bleibt außerhalb des Umfangs.

## E-033 · 2026-09-19 · Sperren vor Löschen, Löschen mit Folgewirkung
Löschverlangen werden in zwei protokollierten Schritten umgesetzt: Sperren (Quelle für andere unsichtbar; Vorschläge, Artefaktfassungen und allein darauf gestützte Aussagen „überholt“, S07) und danach Inhalt entfernen (Quellentext und -versionen gelöscht; allein abgeleitete Aussagen und Hinweistexte entfernt, Hinweis begründet beendet). Typ, Zeitpunkte, Herkunft und Protokoll bleiben, weil die Nachvollziehbarkeit der Verarbeitung erhalten bleiben muss (16.4); das Protokoll enthält den Grund, nie den Inhalt. Berechtigt: Quelleninhaber, zuständige Führungsrolle, Betriebsverwaltung. Sicherungen: Ablauf statt Einzellöschung; Wiederherstellung wendet die in der Datenbank gespeicherten Sperr-/Löschzustände automatisch mit an (S12) – Aufbewahrung der Sicherungen bleibt offene Entscheidung.

## E-034 · 2026-09-19 · Verwaltung ohne Inhaltszugriff, Grenzen im Prozessspeicher
Die Rolle ADMIN pflegt Rollen und Zugänge und sieht Protokoll (nur Feldnamen) und Bestandszahlen je Schutzbereich – keine Setups, Quellen, Notizen oder Vorschläge (16.2). Sitzungen haben eine Höchstdauer (12 h) und eine Inaktivitätsgrenze (2 h). Nutzungsgrenzen für Anmeldeversuche (20 / 15 min je Herkunft) und schreibende Aktionen (120 / min je Person) laufen im Prozessspeicher; für mehrere Instanzen ist ein gemeinsamer Speicher nachzurüsten. Für die E2E-Suite wird die Anmeldegrenze über die Umgebung angehoben; Produktionswerte bleiben unverändert.

## E-035 · 2026-09-19 · Betrieb: Container, Startverweigerung, Sicherung
Betrieb als Docker-Container (Node 22) mit PostgreSQL 16 hinter einem TLS-Reverse-Proxy; die Anwendung lauscht nur lokal. `scripts/start.sh` verweigert den Start bei Entwicklungsanmeldung, Test-KI oder Beispiel-Secret (S09) und wendet Migrationen mit `scripts/migrate.mjs` ohne Entwicklungswerkzeuge an. Sicherung per `pg_dump` (Custom-Format, Prüfsumme), Wiederherstellung in eine leere Datenbank mit Konsistenzprüfung. Geheimnisse ausschließlich über Umgebungsvariablen (`.env.production`, nicht im Git).

## Offene Entscheidungen (Briefing 2.3) – Stand unverändert offen
| Thema | Aktueller lokaler Ersatz | Entscheidung nötig vor |
|---|---|---|
| Hosting/Produktivregion | lokal, PostgreSQL 16; Docker/Compose vorbereitet (E-035) | Echtdatenbetrieb |
| Unternehmensanmeldung (OIDC-Anbieter) | Entwicklungsanmeldung | Bereitstellung für reale Nutzer |
| Mail-/Kalenderanbieter | **entschieden: Microsoft 365/Outlook (E-018)**; Graph-Adapter im Fixture-Modus vorhanden (E-023) | echtem Import: App-Registrierung im Verve-Tenant + Datenschutzfreigabe |
| KI-Anbieter/Modell | `AI_PROVIDER=test` (regelbasiert, lokal); Produktivadapter gesperrt | KI-Verarbeitung echter Inhalte |
| Führendes CRM/Staffing-System | eigener Pilotdatenbestand | Synchronisation realer Stammdaten |
| Datenschutz (Zweck, Rechtsgrundlage, DSFA, Aufbewahrung, Löschkonzept) | Zugriffsklassen, Sperr-/Löschablauf mit Folgewirkung (E-033), Bestandszahlen; Aufbewahrungsfristen nicht gesetzt | Echtdatenbetrieb |
| Sales-/Vergütungsregeln (A16) | nicht implementiert, keine Berechnung | Aktivierung entsprechender Prüfungen |
| Startvoraussetzungs-Regelwerk (Vertrag/Compliance/Onboarding) | frei erfasste Voraussetzungen je Auftrag, Regelbezug als Text | produktiver Einsatzfreigabe |
| Git-Remote | **entschieden: github.com/verve-sales/accountmeister**; Auslieferung aus dieser Sitzung per Bundle | – |
