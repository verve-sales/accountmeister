# Mail-Eingang: Weiterleitungen an das Accountmeister-Postfach

Wer eine Mail an das Postfach weiterleitet (z. B. `sales@verveconsulting.de`), findet die Vorschläge nach ein bis zwei Minuten auf seiner Startseite zur Bestätigung.

## Was der Accountmeister tut – und was nicht

- Er liest alle zwei Minuten die neuen Nachrichten im Posteingang des Postfachs (nur Kopfdaten: Absender, Betreff, Zeit).
- Den Inhalt ruft er nur ab, wenn der Absender ein aktiver Accountmeister-Nutzer ist und Exchange ihn als intern bestätigt (`X-MS-Exchange-Organization-AuthAs: Internal`). Alles andere – etwa Bewerbungen von außen – wird übersprungen; dazu wird nur die Nachrichten-ID mit dem Vermerk „abgelehnt“ gespeichert, kein Betreff, kein Inhalt.
- Weitergeleitete Bewerbungen werden nicht ausgewertet; der Absender bekommt einen Hinweis.
- Anhänge werden nicht übernommen.
- Das Postfach wird nur gelesen: nichts wird verändert, verschoben, als gelesen markiert oder gelöscht.
- Beim ersten Lauf werden nur Nachrichten der letzten 24 Stunden betrachtet.

## Einrichtung (einmalig, IT)

1. **Graph-Recht:** In der bestehenden Entra-App-Registrierung des Accountmeisters unter „API-Berechtigungen“ die **Anwendungsberechtigung** `Mail.Read` (Microsoft Graph) hinzufügen und die Administratorzustimmung erteilen.
2. **Auf das eine Postfach beschränken** (Exchange Online PowerShell), sonst dürfte die App alle Postfächer lesen:

   ```powershell
   New-DistributionGroup -Name "Accountmeister-Eingang" -Type Security -Members sales@verveconsulting.de
   New-ApplicationAccessPolicy -AppId <Client-ID der App> -PolicyScopeGroupId "Accountmeister-Eingang" -AccessRight RestrictAccess -Description "Accountmeister liest nur das Sales-Postfach"
   Test-ApplicationAccessPolicy -Identity sales@verveconsulting.de -AppId <Client-ID der App>   # erwartet: Granted
   Test-ApplicationAccessPolicy -Identity <irgendein anderes Postfach> -AppId <Client-ID der App>   # erwartet: Denied
   ```

   Nutzt die App bereits `Mail.Send` für Benachrichtigungen, muss das Absender-Postfach (`MAIL_SENDER`) ebenfalls Mitglied der Gruppe sein.
3. **Server:** in `/opt/verve-sales/.env.production` ergänzen und die App neu starten:

   ```
   MAIL_INBOX_MODE=graph
   MAIL_INBOX=sales@verveconsulting.de
   ```

Ob der Abruf läuft, steht unter Verwaltung bei den Hintergrundläufen („mail-eingang“); Fehler (z. B. fehlendes Recht) erscheinen dort mit Meldung.

## Abschalten

`MAIL_INBOX_MODE=off` (Standard) – es findet kein Abruf statt.
