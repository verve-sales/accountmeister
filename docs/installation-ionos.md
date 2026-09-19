# Installation auf einem IONOS Cloud Server – Schritt für Schritt

Stand: 19.09.2026. Diese Anleitung richtet sich an jemanden ohne Server-Erfahrung. Sie dauert etwa 60 bis 90 Minuten, die meiste Zeit davon ist Warten. Du brauchst: den IONOS-Kundenlogin, den Cloudflare-Login für die Domain `verveconsulting.ai` (dort liegen die DNS-Einträge), Administratorrechte in eurem Microsoft 365 (für die Anmeldung) und einen GitHub-Zugang auf das Repository `verve-sales/accountmeister`.

Am Ende läuft die Anwendung unter `https://sales.verveconsulting.ai`, mit Anmeldung über eure Microsoft-365-Konten, täglicher Sicherung und automatischem TLS-Zertifikat.

## Überblick

Der Server bekommt Docker installiert; darin laufen drei Container: die Anwendung, die PostgreSQL-Datenbank und Caddy (nimmt die Anfragen aus dem Internet an, verschlüsselt sie, leitet sie weiter). Ein Skript erledigt fast alles; du gibst nur fünf Werte ein.

## Schritt 1: Server-Zugang und IP-Adresse (IONOS)

1. Melde dich unter login.ionos.de an und öffne „Server & Cloud“ (Vertrag „IONOS Cloud Server“). Es öffnet sich das Cloud Panel.
2. Klicke links auf „Server“ und dann auf deinen Server. Notiere die **öffentliche IPv4-Adresse** (z. B. 82.165.xx.xx).
3. Prüfe das Betriebssystem: Es sollte **Ubuntu 22.04 oder 24.04** sein (steht in der Serverübersicht unter „Image“). Falls Windows oder etwas anderes installiert ist: im Cloud Panel „Aktionen → Image neu installieren → Ubuntu 24.04“ (löscht den Server; bei einem unbenutzten Server unproblematisch).
4. Root-Passwort: Bei der Servererstellung hat IONOS eines vergeben (in der Bestellmail oder unter „Aktionen → Passwort zurücksetzen“). Setze dir ein neues, langes Passwort und bewahre es im Passwortmanager auf.
5. **Firewall im Cloud Panel öffnen** (das vergisst man leicht): Links „Netzwerk → Firewall-Richtlinien“, die Richtlinie deines Servers öffnen und Regeln hinzufügen: TCP 80, TCP 443 und UDP 443, jeweils Quelle „alle“. Port 22 (SSH) ist in der Regel schon offen.

## Schritt 2: Domain auf den Server zeigen lassen (Cloudflare)

Die Domain `verveconsulting.ai` ist zwar bei IONOS registriert, ihre DNS-Einträge werden aber bei **Cloudflare** verwaltet (im IONOS-Kundenbereich steht unter „Verwendungsart: Eigene Nameserver – hasslo.ns.cloudflare.com, cora.ns.cloudflare.com“). Änderungen im IONOS-DNS hätten deshalb keine Wirkung; die IONOS-Hinweise „SSL aktivieren“ und „Domain Guard“ kannst du ignorieren, das Zertifikat besorgt der Server selbst.

1. Bei dash.cloudflare.com anmelden, die Zone `verveconsulting.ai` öffnen, links „DNS → Records“.
2. „Add record“: Typ **A**, Name `sales`, IPv4-Adresse = die Server-IP aus Schritt 1, **Proxy status: „DNS only“ (graue Wolke, nicht orange)**, TTL Auto. Speichern.
   Die graue Wolke ist wichtig: Der Server holt sein Zertifikat direkt bei Let's Encrypt, und die Anwendung soll nicht durch den Cloudflare-Proxy laufen (Kundendaten bleiben dann zwischen Browser und eurem Server). Wer Cloudflare später bewusst als Schutzschicht vorschalten möchte, kann das nach der Inbetriebnahme umstellen.
3. Falls es schon einen Eintrag `sales` gibt, diesen ersetzen. Die Änderung ist bei Cloudflare in der Regel nach ein bis zwei Minuten aktiv.
4. Adresse der Anwendung ist damit: `https://sales.verveconsulting.ai`. Diese Adresse wird in Schritt 4 und 6 exakt so verwendet.

## Schritt 3: GitHub-Zugriff für den Server vorbereiten

Wenn das Repository privat ist (Standard), braucht der Server zum Herunterladen ein Zugangstoken; ein Passwort funktioniert bei GitHub nicht. Ist das Repository öffentlich, kannst du diesen Schritt überspringen und in Schritt 6 den Teil `-u "…"` weglassen.

1. Auf github.com oben rechts Profilbild → „Settings“ → ganz unten „Developer settings“ → „Personal access tokens“ → „Fine-grained tokens“ → „Generate new token“.
2. Name: „verve-sales-server“, Ablauf: 90 Tage (danach einfach ein neues erstellen), „Repository access“: „Only select repositories“ → `verve-sales/accountmeister`.
3. Unter „Permissions → Repository permissions“: **Contents: Read-only**. Sonst nichts. Token erzeugen und den Wert kopieren (wird nur einmal angezeigt).

## Schritt 4: Anwendung in Microsoft 365 registrieren (Entra ID)

Damit sich das Team mit dem Microsoft-Konto anmelden kann, muss die Anwendung eurem Microsoft-Mandanten bekannt sein. Das erledigt ein Administrator eures Microsoft 365 in etwa fünf Minuten.

1. entra.microsoft.com öffnen (oder portal.azure.com → „Microsoft Entra ID“). Links „Anwendungen → App-Registrierungen → Neue Registrierung“.
2. Name: „Verve Sales-Arbeitsumgebung“. Unterstützte Kontotypen: **„Nur Konten in diesem Organisationsverzeichnis“** (einzelner Mandant). Umleitungs-URI: Plattform „Web“, Wert `https://sales.verveconsulting.ai/api/auth/callback` (deine Adresse aus Schritt 2, exakt so, mit `/api/auth/callback`). Registrieren.
3. Auf der Übersichtsseite der neuen App zwei Werte notieren: **Anwendungs-ID (Client)** und **Verzeichnis-ID (Mandant)**. Beide sehen aus wie `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
4. Links „Zertifikate & Geheimnisse → Geheime Clientschlüssel → Neuer geheimer Clientschlüssel“. Beschreibung „Server“, Gültigkeit 24 Monate. Den Eintrag in der Spalte **„Wert“** sofort kopieren (nicht „Geheimnis-ID“); er wird nur einmal angezeigt. Trage dir den Ablauftermin in den Kalender ein.
5. Links „Authentifizierung“: unter „Front-Channel-Abmeldungs-URL“ optional `https://sales.verveconsulting.ai/anmelden` eintragen. Unter „Implizite Genehmigung“ nichts anhaken. Speichern.
6. Links „API-Berechtigungen“: Standardmäßig steht dort „Microsoft Graph → User.Read“. Das reicht. Klicke „Administratorzustimmung für <Firma> erteilen“, damit Mitarbeitende nicht einzeln zustimmen müssen.
7. Optional, empfohlen: „Tokenkonfiguration → Optionalen Anspruch hinzufügen → ID → email“ anhaken und hinzufügen. Dann liefert Microsoft die E-Mail-Adresse zuverlässig.

Die Anwendung fordert keine weiteren Berechtigungen an; sie liest nur Name und E-Mail-Adresse der angemeldeten Person. Die Anbindung an Outlook (Mail und Kalender) ist ein separater, späterer Schritt mit eigener Freigabe.

## Schritt 5: Auf dem Server anmelden

Unter Windows: Windows-Terminal oder PowerShell öffnen (Startmenü → „Terminal“). Eingeben:

```
ssh root@82.165.xx.xx
```

(mit deiner IP-Adresse). Beim ersten Mal fragt SSH „Are you sure you want to continue connecting?“ – `yes` eingeben. Dann das Root-Passwort eintippen (es wird beim Tippen nichts angezeigt) und Enter. Du bist jetzt auf dem Server; die Zeile beginnt mit `root@…`.

## Schritt 6: Installationsskript ausführen

Kopiere diese eine Zeile in das Server-Terminal und drücke Enter:

```
curl -fsSL -u "DEIN-GITHUB-NAME:DEIN-TOKEN" https://raw.githubusercontent.com/verve-sales/accountmeister/main/scripts/install-server.sh -o install-server.sh && bash install-server.sh
```

Ersetze `DEIN-GITHUB-NAME` durch deinen GitHub-Benutzernamen und `DEIN-TOKEN` durch das Token aus Schritt 3. Das Skript arbeitet sechs Abschnitte ab und meldet sich zwischendurch:

1. Docker installieren (2–3 Minuten).
2. Firewall des Servers (SSH, HTTP, HTTPS).
3. Quellcode holen. Hier fragt git nach „Username“ (GitHub-Name) und „Password“ – dort das **Token** einfügen (Rechtsklick fügt im Terminal ein).
4. Konfiguration: Das Skript fragt nacheinander nach Domain (`sales.verveconsulting.ai`), E-Mail der Betriebsverwaltung (deine Adresse), Verzeichnis-ID, Anwendungs-ID und Geheimen Clientschlüssel (Schritt 4). Passwörter für Datenbank und Sitzung erzeugt es selbst. Alles landet in `/opt/verve-sales/.env.production`, nur für root lesbar.
5. Bauen und Starten (5–8 Minuten beim ersten Mal). Am Ende steht „Anwendung läuft.“
6. Tägliche Sicherung um 03:15 Uhr nach `/var/backups/verve-sales`, 14 Tage Aufbewahrung.

Falls das Skript mit einer Fehlermeldung abbricht: die letzte Meldung kopieren und mir schicken; das Skript kann danach einfach erneut gestartet werden (`bash install-server.sh`), es überspringt Erledigtes.

## Schritt 7: Erster Aufruf und erste Anmeldung

1. Im Browser `https://sales.verveconsulting.ai` öffnen. Der erste Aufruf kann 10–20 Sekunden dauern, weil Caddy das Zertifikat bei Let's Encrypt holt. Erscheint eine Zertifikatswarnung oder ein Fehler, sind DNS (Schritt 2) oder die Cloud-Panel-Firewall (Schritt 1, Punkt 5) noch nicht fertig; 10 Minuten warten und neu laden.
2. „Mit Microsoft 365 anmelden“ klicken, mit deinem Konto anmelden. Weil deine Adresse in `ADMIN_EMAILS` steht, bekommst du automatisch die Verwaltungsrolle und landest auf „Verwaltung“.
3. Dort für jede Kollegin und jeden Kollegen einen **Zugang anlegen** (E-Mail des Microsoft-Kontos, Name) und **Rollen zuweisen**: Anker, BD, Principal, CEO. Ohne Rolle sieht niemand Inhalte. Eine BD-Rolle „arbeitsraumweit“ erlaubt das Anlegen von Kunden; die kundenbezogene Zuständigkeit wird dann am Kunden gesetzt.
4. Die Verwaltungsrolle selbst sieht keine Inhalte. Wenn du auch fachlich arbeiten willst, weise dir zusätzlich eine fachliche Rolle zu (z. B. CEO oder Principal).

Es gibt in Produktion keine fiktiven Demo-Daten; die Anwendung startet leer. Der erste fachliche Schritt ist „Kunden → Kunde anlegen“.

## Danach: Update, Logs, Sicherung

Alles auf dem Server als root im Ordner `/opt/verve-sales`:

```
cd /opt/verve-sales
git pull && docker compose --env-file .env.production up -d --build   # neue Version einspielen
docker compose --env-file .env.production logs -f app                 # Logs der Anwendung (Strg+C beendet)
docker compose --env-file .env.production ps                          # laufen alle drei Container?
ls -la /var/backups/verve-sales                                        # Sicherungen
```

Die Sicherungen liegen auf demselben Server. Für den Pilot reicht das; vor Echtdatenbetrieb sollte eine Kopie an einen zweiten Ort gehen (z. B. IONOS-Backup-Funktion im Cloud Panel für den ganzen Server aktivieren oder wöchentlich per `scp` herunterladen). Wie eine Sicherung zurückgespielt wird, steht in `docs/betrieb.md`, Abschnitt 5.

## Wenn etwas nicht geht

Seite nicht erreichbar: `docker compose --env-file .env.production ps` – alle drei Container „Up“? Dann DNS prüfen (`nslookup sales.verveconsulting.ai` auf deinem PC muss die Server-IP zeigen; zeigt es eine Cloudflare-Adresse, steht der Eintrag noch auf „Proxied“) und die Cloud-Panel-Firewall.

Anmeldung schlägt fehl mit „AADSTS…“: Meist stimmt die Umleitungs-URI in Entra nicht exakt mit `https://<Domain>/api/auth/callback` überein, oder der Clientschlüssel wurde als „Geheimnis-ID“ statt „Wert“ kopiert. Werte in `/opt/verve-sales/.env.production` korrigieren (`nano .env.production`), dann `docker compose --env-file .env.production up -d`.

„Für diese Anmeldung ist noch kein Zugang eingerichtet“: Die Person muss vorher unter „Verwaltung → Zugang anlegen“ mit genau der E-Mail-Adresse ihres Microsoft-Kontos eingetragen werden.

Anwendung startet nicht („Start verweigert“): In `.env.production` fehlt ein OIDC-Wert oder `AUTH_MODE` ist nicht `oidc`. Die Meldung in `docker compose … logs app` nennt den Grund.
