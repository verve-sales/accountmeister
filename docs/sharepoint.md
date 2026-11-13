# SharePoint-Ablage (e45)

Der Accountmeister legt Unterlagen in der SharePoint-Site „Vertrieb und Verträge“ ab. Er nutzt dafür seine eigene App-Registrierung in Entra ID (dieselbe wie für die Anmeldung) mit der Graph-Berechtigung `Sites.Selected`. Sie gilt nur für diese eine Site.

## Einschalten

In `.env.production` ergänzen und die App neu starten:

```
SHAREPOINT_MODE=graph
SHAREPOINT_SITE_ID=oubtth.sharepoint.com,bea5a83f-b4fe-4f16-a5bc-272328533b49,80ad6c05-57b7-41fa-9a5b-7bb4fa6a0b28
```

Danach in der Verwaltung → SharePoint-Ablage auf „SharePoint einrichten“ klicken. Die Seite ist auch über die Sales-Ops-Sicht erreichbar.

## Was der Accountmeister anlegt

- Bibliotheken: Kunden, Freelancer, Vorlagen.
- Spalten in Kunden und Freelancer, mit festen internen Namen: `Dokumentart`, `Kunde`, `Person`, `Bestellnummer`, `Angebotsnummer`, `MocoProjekt`, `GueltigVon`, `GueltigBis`, `DokStatus`.
- Ordner je Kunde und je Freelancer mit laufendem Einsatz:
  - Kunden: Rahmen und Einkauf, Angebote, Bestellungen.
  - Freelancer: „Nachname, Vorname“ mit den Unterordnern Verträge und Nachweise.
- Erzeugte Projekteinzelverträge legt er unter Freelancer › Person › Verträge ab. Er füllt die Spalten und trägt den Link am Dokument ein.
- Einen Statuswechsel am Einsatz (versendet, unterschrieben) führt er in der Spalte Status nach.

## Was er nicht kann

Mit einem App-Kennwort (statt Zertifikat) lässt Microsoft über Graph weder Rechte für Personen noch Ansichten zu. Beides setzt der Besitzer der Site von Hand. Die Seite „SharePoint-Ablage“ zeigt dafür die Klickschritte und die Personen aus den Rollen im Accountmeister.

## Recht der App zurückstufen

Für die Einrichtung (Bibliotheken, Spalten) braucht die App Vollzugriff auf die Site. Für den laufenden Betrieb (Ordner, Dateien, Spaltenwerte) genügt Schreibrecht. Zum Zurückstufen ruft ein Admin im Graph Explorer auf:

```
PATCH https://graph.microsoft.com/v1.0/sites/<Site-ID>/permissions/<Kennung der Berechtigung>
{ "roles": ["write"] }
```

Die Kennung der Berechtigung liefert `GET https://graph.microsoft.com/v1.0/sites/<Site-ID>/permissions`. Neue Spalten oder Bibliotheken kann die App danach nicht mehr anlegen; neue Kundenordner schon.

## e48: Dokumentenfluss

- Neue Spalten „Tagessatz“ (Satz) und „Zahlungsziel“ sowie die Dokumentart „Einsatzblatt“: einmal unter Verwaltung › SharePoint „Einrichten“ klicken – es wird nur Fehlendes ergänzt. Bis dahin werden diese Felder einfach ausgelassen.
- Hochgeladene Unterlagen am Einsatz landen automatisch im Kunden- bzw. Freelancer-Ordner.
- „Unterschrieben“ gilt beim erzeugten Vertragsentwurf nur mit hochgeladener unterschriebener Fassung; der Entwurf steht danach auf „ersetzt“.
- Beim Quittieren einer Übergabe entsteht ein Einsatzblatt (Excel): im Kundenordner › Bestellungen mit Verkaufssatz, Rechnungsanschrift und -weg; bei Freelancern zusätzlich im Freelancer-Ordner › Verträge mit Einkaufssatz und Zahlungsziel.
- Bestellnummer, Moco-Projekt und „gültig bis“ werden bei Bestellung, Quittung, Verlängerung und Einsatzende an allen Unterlagen nachgeführt.
- Bestell-Mails (Weiterleitung ans Postfach oder Ordner „Accountmeister“): PDF-/Office-Anhänge landen unter Kunden › Kunde › Bestellungen, mit erkannter Bestellnummer; Sales Operations bekommt einen Hinweis.

## e48b: Jahresordner

- Angebote, Bestellungen (Kunden) sowie Verträge und Nachweise (Freelancer) haben je Jahr einen Unterordner, z. B. `Kunden/ITERGO/Angebote/2026/`. „Rahmen und Einkauf“ bleibt ohne Jahre.
- Maßgeblich ist das Datum vorn im Dateinamen (`JJJJ-MM-TT_…`), sonst das Änderungsdatum.
- Der Accountmeister legt automatisch ins richtige Jahr ab. „Einrichten“ legt das aktuelle Jahr an und sortiert lose Dateien in ihr Jahr ein.
- Die Auswahl „Aus SharePoint übernehmen“ zeigt lose Dateien, das aktuelle und das Vorjahr.
