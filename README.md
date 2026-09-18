# Verve Sales-Arbeitsumgebung (Pilot)

Interne, datenbankgestützte Sales-Arbeitsumgebung für Verve Consulting. Stand: Etappe 0 + Etappe 1 (Setup → Beobachtung → Hinweis → Übergabe → Aktion; Personen & Zugang mit Kontaktwegen). **Ausschließlich fiktive Daten. Kein Produktivbetrieb.**

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
src/modules      Fachmodule: identity, accounts, setups, knowledge, signals, actions, handovers, people, accesspaths, audit
src/db           Schema (Drizzle), Migrationen, Client, Seed
src/lib          Konfiguration (mit Produktionsschutz), Fehlerklassen, Anzeigetexte
tests            Integrationstests (Vitest) gegen PostgreSQL
e2e              End-to-End-Tests (Playwright)
docs             Briefing, Implementierungsübersicht, Entscheidungsprotokoll
```

## Bekannte Einschränkungen (Stand Etappe 1)
- Kontaktwege nur tabellarisch; die grafische Beziehungskarte folgt. Buyingcenter je Bedarf folgt mit dem Bedarfsobjekt.
- Weeklys, Accountplan, Ziele/Portfolio, Vorschläge, Importe: noch nicht umgesetzt; die Navigation kennzeichnet dies.
- „Was hat sich geändert?“ nutzt vorläufig ein 7-Tage-Fenster statt des letzten bestätigten Weeklys.
- Keine Unternehmensanmeldung, kein KI-Anbieter, keine Mail-/Kalenderanbindung (Entscheidungen offen, siehe Entscheidungsprotokoll).
