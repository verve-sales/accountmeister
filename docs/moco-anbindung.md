# Moco-Anbindung (Etappe 31) – Briefing und Umsetzungsstand

Stand: Oktober 2026. Entscheidungen aus dem Gespräch mit Ivo Seifert (Verve), Red-Team-Prüfung des Prozesses inklusive.

## 1. Führendes System je Objekt

| Objekt | Führend | Das andere System |
|---|---|---|
| Kunde (Stammdaten) | Moco (Company) | AM spiegelt Name + `moco_company_id`; neue Kunden entstehen im AM in der Lead-Phase, Moco-Company folgt beim ersten Lead-Push (Etappe 32) |
| Bereich / Setup | Moco-Projektgruppe (eine Company, mehrere Projekte) | AM-Setup mit `moco_project_group_id`; Setups ohne Gruppe bleiben AM-eigene (Lead-Phase) |
| Chance / Lead | **AM** | Moco-Deal per Lead-Push aus dem AM (Mehr → Moco → Leads, seit Etappe 32a), in Moco nur lesen |
| Angebot, Auftrag, Beschaffungsweg, Vertragslage, EK | AM | – |
| Projekt, Zuweisung (Contract), Stundensatz (VK), Zeiten, Rechnung | **Moco** | AM-Einsatz mit `moco_project_id`/`moco_contract_id`; Laufzeit/Person im AM schreibgeschützt gedacht, Änderungen kommen als Hinweis |
| Betreuung, Check-ins, Verlängerungsentscheidung, Sales-Signale | AM | Projektende nach Verlängerung → Moco (Etappe 32, einzige Schreibrichtung) |
| Personen, Teams, Teamleiter | Moco (User, Unit, Rolle „Teamleiter“) | AM zieht nach: Zugang + Rolle Anker, Team + Leitung; Freelancer (Moco-Team „Freelancer“) in den Pool |
| Sales-Rollen (BD, Principal, Sales Ops) | **AM** (Verwaltung bzw. Prüfliste je Setup) | Moco-Projektleiter und Gruppenverantwortlicher sind keine Sales-Begriffe und werden ignoriert (Ausnahme: Gruppenverantwortlicher wird als Principal-Vorschlag genommen, wenn die Person im AM Principal/CEO ist) |

## 2. Umgesetzt in dieser Etappe

- **Client** `src/modules/moco/client.ts`: Moco-REST v1 (`Authorization: Token token=…`, Pagination 100/Seite, 429-Wartezeit), Feld-Whitelist (keine IBAN, Adresse, Geburtstag). Modi `http` (Produktion) und `fixture` (JSON im Moco-Format, `tests/fixtures/moco`).
- **Startimport mit Prüfliste** `src/modules/moco/import.ts`, Seiten `/moco` und `/moco/import/[id]` (CEO, Principal):
  - Personen: Moco-User → Zugang per E-Mail/Name verknüpft oder neu (Rolle Anker, wenn keine fachliche Rolle); Moco-Team „Freelancer“ → Freelancer-Pool; Moco-Rolle „Teamleiter“ → Leitung des Teams.
  - Teams: Moco-Units → `teams` (`moco:<unit>`), Mitglieder und Leitung.
  - Kunden: Companies mit aktiven Projekten → Kunde verknüpfen (Namensähnlichkeit, Moco-Name wird übernommen) oder neu.
  - Setups: Projektgruppe → Setup verknüpfen (Name, oder Heuristik „Person dieses Projekts hat dort schon einen Einsatz“) oder neu; Projekte ohne Gruppe → „Ohne Bereich“ je Kunde. **BD und Principal je Setup** in der Prüfliste; Principal als Beteiligung `PRINCIPAL_ZUSTAENDIG` (Zuständigkeit, keine Rechteänderung – Weg A).
  - Einsätze: je aktiver Contract eines aktiven Projekts → bestehenden Einsatz derselben Person beim Kunden verknüpfen oder neu: Chance „beauftragt“ + Auftrag + Position (besetzt) + Kandidatur (ausgewählt) + Einsatz **aktiv** (Start = Projektstart, Ende = Projektende, VK = Stundensatz in €/Stunde, EK leer). Freelancer-Einsätze: Check-ins Kunde **und** Freelancer alle 6 Wochen, erste Termine über 5 Wochen gestaffelt; interne Einsätze ohne automatische Check-ins (auch im Hintergrundlauf).
  - Idempotent: zweiter Lauf schlägt überall „verknüpfen – bereits verknüpft“ vor und legt nichts doppelt an.
- **Sync** `src/modules/moco/sync.ts`: stündlicher Lauf `moco-sync` (nur wenn eingeschaltet) und Webhook `/api/moco/webhook` (HMAC-SHA256 über die rohe Nutzlast, Kopfdaten in `moco_events`, Abgleich im Hintergrund). Neue Nutzer automatisch als Anker (inkl. Team), neue Freelancer in den Pool. Abweichungen als **Hinweise** (`moco_hints`, dedupliziert) mit Ein-Klick-Übernahme am Einsatz und unter `/moco`: Projektende geändert, Projekt beendet, Zuweisung inaktiv (→ Einsatz endet, Check-ins entfallen), Gruppe gewechselt (→ Einsatz/Chance/Position ins Ziel-Setup), neues Projekt / neue Zuweisung (→ per Importlauf), Nutzer deaktiviert (→ Zugang deaktivieren).
- **Teamleiter-Kachel** „Mein Team“ auf der Startseite: Aktivitätsindex je Mitglied (28 Tage, Vorperiode, zuletzt aktiv) – nur Zahlen.
- Konfiguration: `MOCO_MODE`, `MOCO_SUBDOMAIN`, `MOCO_API_KEY`, `MOCO_WEBHOOK_SECRET`, `MOCO_FREELANCER_UNIT` (Standard „Freelancer“), `MOCO_TEAMLEAD_ROLE` (Standard „Teamleiter“). Migration 0031.

## 2a. Lead-Push AM → Moco (Etappe 32a, umgesetzt)

- `src/modules/moco/leads.ts`: `listLeadCandidates` (offene Chancen ohne `moco_deal_id`, Status antizipiert … Auswahl/Bestellung, zurückgestellt) und `pushLeads`. Nur CEO/Principal, ausgelöst von Hand unter Mehr → Moco → „Chancen als Leads nach Moco übertragen“ (Tabelle mit Auswahl, Phase je Chance).
- Abbildung: `name` = Titel der Chance, `company_id` = `accounts.moco_company_id` (fehlt die Verknüpfung, wird eine Moco-Firma gleichen Namens vorgeschlagen und beim Push am Kunden gespeichert), `user_id` = Moco-Nutzer der/des Verantwortlichen, sonst der übertragenden Person, `deal_category_id` = Phase mit der zum AM-Status passendsten Wahrscheinlichkeit (5/15/40/65/90 %, änderbar), `money` = 0 (keine erfundenen Beträge), `currency` EUR, `reminder_date` = heute + 14, `status` potential (zurückgestellt: pending), `info` mit Rückverweis `/bedarfe/<id>`, Setup, Status, Verantwortliche/r, Anzahl, Zeithorizont, Bedarfsbeschreibung; Tag „Accountmeister“.
- Dubletten: existiert bei der Firma ein Lead gleichen (normalisierten) Namens, der weder lost noch dropped ist, wird nur verknüpft. Jede Chance wird höchstens einmal übertragen (`moco_deal_id`), Audit `opportunity.moco_lead_created|linked`.
- `POST /deals` ist der einzige schreibende Aufruf des Clients (`HttpMocoClient.createDeal`); der Fixture-Client hält angelegte Leads im Prozess.

## 3. Noch offen (Etappe 32)

1. **Lead-Statusspiegel**: potential/pending/won/lost nach Moco, wenn sich der AM-Status ändert; automatischer Push beim Übergang „in Klärung“; einmaliger Erstimport bestehender Moco-Leads nach AM.
2. **Vorgang „Projekt in Moco anlegen“** bei „Auftrag bestätigt“ an Sales Operations/Backoffice mit allen Daten; Sync verknüpft das neue Projekt über `deal_id` mit dem bestehenden Einsatz statt zu duplizieren.
3. **Projektende nach bestätigter Verlängerung nach Moco schreiben** (einzige Schreib-Ausnahme, protokolliert).
4. Lieferanten-Verweise: `moco_supplier_id` am Freelancer (Rechnungsstelle) und am Vermittler des Kunden.
5. Aus Moco stammende Felder im AM als „aus Moco“ schreibgeschützt kennzeichnen (Laufzeit, Person, VK) – heute nur Hinweis im Kopf des Einsatzes.

## 4. Arbeitsregeln (organisatorisch)

- Projekte in Moco immer einer Projektgruppe zuordnen (sonst „Ohne Bereich“) und – ab Etappe 32 – mit dem Deal verknüpfen.
- Freelancer in Moco im Team „Freelancer“ führen; Teamleiter mit der Rolle „Teamleiter“.
- API-Key des technischen Moco-Nutzers `salesagent@verveconsulting.de` (Moco kennt keinen Lesezugriff, daher Vollzugriff; der Client schreibt ausschließlich Leads (`POST /deals`), alles andere nur GET). Dieses Konto wird nicht als Person übernommen (`MOCO_IGNORE_EMAILS`).
- Dokumente liegen weder im AM noch in Moco, sondern in der Ablage; beide halten nur Links.

## 5. Betrieb

```
MOCO_MODE=http
MOCO_SUBDOMAIN=<subdomain>
MOCO_API_KEY=<key des technischen Nutzers>
MOCO_WEBHOOK_SECRET=<32 Hex-Zeichen aus der Webhook-Übersicht>
```

Webhooks in Moco (Einstellungen → Integrationen → Webhooks): Ziel `https://<host>/api/moco/webhook`, Targets Project, Company, User, Events create/update/delete. Moco erwartet die Antwort in 10 s (der AM antwortet sofort und gleicht im Hintergrund ab); nach 500 Fehlern schaltet Moco den Hook ab – Status unter `/moco` prüfen. Ratenlimit Standardplan 120 Anfragen je 2 Minuten; der Import holt Nutzer, Companies, Gruppen und Projekte je einmal seitenweise.

Quellen: https://everii-group.github.io/mocoapp-api-docs/ (Projects, Project Groups, Users, Companies, Deals, Web Hooks).
