# Verve Sales-Arbeitsumgebung (Pilot)

Interne, datenbankgestützte Sales-Arbeitsumgebung für Verve Consulting. Stand: Etappen 0–6 umgesetzt – vollständige Pilotversion mit fiktiven Daten, Dokumentenupload, Kundenanlage aus Dokument und KI über Langdock (Modelle je Aufgabe unter Verwaltung → KI). Anmeldung über Microsoft 365 (Entra ID) eingebaut; Installation auf dem IONOS Cloud Server: `docs/installation-ionos.md`. Echtdatenbetrieb erst nach den Freigaben in `docs/pilotfreigabe.md`; Betrieb siehe `docs/betrieb.md`. **Ausschließlich fiktive Daten. Kein Produktivbetrieb.**

Dokumente: `docs/briefing.md` (Auftrag), `docs/implementierungsuebersicht.md`, `docs/entscheidungsprotokoll.md`.

## Voraussetzungen
- Node.js 22 LTS und npm 10
- PostgreSQL 16 (lokal oder Docker), erreichbar mit einem Nutzer, der Datenbanken anlegen darf

## Lokaler Start (≈ 5 Minuten)
```bash
npm install
cp .env.example .env            # Werte prüfen: DATABASE_URL, TEST_DATABASE_URL
# Datenbanken anlegen (einmalig), z. B.:
#   psql -U postgres -c "CREATE DATABASE verve_sales_dev;" -c "CREATE DATABASE verve_sales_test;"
npm run db:migrate              # Migrationen aus src/db/migrations anwenden
npm run db:seed                 # fiktive Demo-Daten (idempotent)
npm run dev                     # http://localhost:3000
```
Anmelden unter `/anmelden` durch Auswahl einer fiktiven Person (Nina = Anker, David = BD, Petra = Principal, Clemens = CEO, Lars = BD eines anderen Kunden, Admin = Betrieb ohne Inhaltszugriff).

Mit Docker: `docker run --name verve-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16` – dann passt `.env.example` unverändert.

## Prüfen
```bash
npm run check          # Typecheck + Lint + Integrationstests (Testdatenbank wird bei jedem Lauf neu migriert)
npm run test:e2e       # Playwright gegen Entwicklungsserver auf Port 3100 (einmalig: npx playwright install chromium)
npm run build          # Produktionsbuild
```
Der Produktionsstart (`npm start`) verweigert absichtlich den Betrieb mit `AUTH_MODE=development`, `AI_PROVIDER=test` oder dem Beispiel-`SESSION_SECRET` (Briefing 17.4 / S09).

## Skripte
| Befehl | Zweck |
|---|---|
| `npm run db:generate` | Neue SQL-Migration aus `src/db/schema.ts` erzeugen |
| `npm run db:migrate` | Migrationen anwenden |
| `npm run db:seed` | Fiktive Demo-Daten einspielen |
| `npm run db:reset` | Lokale Datenbank leeren (nicht in Produktion) |

## Struktur
```
src/app          Seiten (App Router), Server Actions (Formularbrücke), globales Layout
src/modules      Fachmodule: identity, accounts, setups, knowledge, signals, actions, handovers, people, accesspaths, reviews, accountplan, artifacts, ai, suggestions, integrations, imports, audit
src/db           Schema (Drizzle), Migrationen, Client, Seed
src/lib          Konfiguration (mit Produktionsschutz), Fehlerklassen, Anzeigetexte
tests            Integrationstests (Vitest) gegen PostgreSQL
e2e              End-to-End-Tests (Playwright)
docs             Briefing, Implementierungsübersicht, Entscheidungsprotokoll, Betrieb, Pilotfreigabe
scripts          Start (Produktion), Migration, Sicherung, Wiederherstellung
```

## Bekannte Einschränkungen (Stand Etappe 6)
- Kontaktwege nur tabellarisch; die grafische Beziehungskarte folgt. Buyingcenter je Bedarf folgt mit dem Bedarfsobjekt.
- Startvoraussetzungen werden frei erfasst; ein freigegebenes Regelwerk (Vertrag/Compliance/Onboarding) und die Vergütungsregeln (A16) sind offen. Nachweise sind Quellen/Belegnotizen, keine Dokumentenverwaltung.
- Nutzungsgrenzen laufen im Prozessspeicher (eine Instanz). Docker-Abbild in dieser Umgebung nicht gebaut (kein Docker-Daemon) – erster Build auf dem Zielsystem prüfen. Zielbeiträge sind mit Setups/Kunden verknüpft; die Koppelung an Accountplan-Prioritäten ist im Datenmodell vorhanden, in der Oberfläche noch nicht.
- Outlook: Der Microsoft-Graph-Adapter läuft im Fixture-Modus mit fiktiven Testquellen; ein echter Abruf braucht eine App-Registrierung im Verve-Tenant und die Datenschutzfreigabe.
- KI: In der Entwicklung läuft der deterministische Testanbieter (`AI_PROVIDER=test`, kein Sprachmodell). Produktiv: Langdock (`AI_PROVIDER=langdock`, E-037); der Langdock-Adapter wurde gegen die dokumentierte Schnittstelle mit Attrappen getestet, der erste echte Aufruf ist auf dem Server über „Verwaltung → KI → Verbindung prüfen“ zu bestätigen. Dokumente: kein OCR (gescannte PDFs ohne Textebene ergeben „kein Text“); Dokumente werden nur einmal extrahiert, keine Versionierung bei erneutem Upload.
- Keine echte Mail-/Kalenderanbindung (Entscheidung offen, siehe Entscheidungsprotokoll). Unternehmensanmeldung über Microsoft Entra ID vorhanden (`AUTH_MODE=oidc`).
