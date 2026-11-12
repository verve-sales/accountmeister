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
