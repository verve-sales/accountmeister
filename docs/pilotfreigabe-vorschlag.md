# Pilotfreigabe – Vorschlag zur Unterzeichnung

Stand: 21.09.2026 · Ausgefertigte und unterzeichnete Fassung für Verve Consulting (vgl. unterschriebenes Dokument `Pilotfreigabe_ausgefuehrt_sig.docx`) · Anwendung „Accountmeister“ (Verve Sales-Arbeitsumgebung), `https://accountmeister.verveconsulting.ai`

Dieses Dokument ist der ausgefüllte Vorschlag zu `docs/pilotfreigabe.md`. Es beschreibt, wie der Pilot mit echten Daten betrieben werden soll, wer wofür verantwortlich ist und welche Regeln gelten. Wo eine Entscheidung nur Verve treffen kann, steht ein Vorschlag mit einem Kasten zum Ausfüllen. Es ersetzt keine Rechtsberatung; die Geschäftsführung (oder eine beauftragte Datenschutzberatung) prüft und unterschreibt. Nach der Unterschrift ist der Echtdatenbetrieb im beschriebenen Umfang freigegeben.

## 1. Was der Pilot ist und was nicht

Der Pilot ist die interne Arbeitsumgebung des Vertriebs von Verve Consulting: Kunden (Organisationen), Setups (Arbeitszusammenhänge), Ansprechpartner mit Funktion und Beziehungsstand, Quellen (Notizen, Protokolle, hochgeladene Dokumente, importierte E-Mails/Termine), Hinweise, Bedarfe, Angebote und Aufträge, Weeklys, Aktionen, Übergaben, Accountpläne, Artefakte, Führungs- und Zielgespräche. Nutzer sind ausschließlich Beschäftigte und Partner von Verve mit Microsoft-365-Konto im Verve-Mandanten.

Nicht enthalten sind Kandidaten- oder Vertragsmanagement, Rechnungs- oder Provisionsabrechnung, automatischer Outreach, Bewertung individueller Arbeitsleistung, Kundenzugang und Synchronisation mit einem CRM. Der Pilot läuft mit einer Anwendungsinstanz auf einem IONOS-Server in Deutschland. Ausgewählte Microsoft-365-Postfächer und -Kalender dürfen für den Pilot importiert werden. Microsoft Bing Grounding darf ausschließlich für öffentliche, nicht vertrauliche Webrecherchen verwendet werden.

## 2. Verantwortliche

| Rolle | Aufgabe | Vorschlag | Festgelegt |
|---|---|---|---|
| Verantwortlicher im Sinne der DSGVO | Verve Consulting GmbH (Geschäftsführung) | – | ☒ bestätigt |
| Betriebsverantwortlicher (technisch) | Server, Updates, Sicherungen, Zugänge und Rollen, KI-Konfiguration | Ivo Seifert | ☒ Name: Raimund Bendl |
| Stellvertretung Betrieb | wie oben bei Abwesenheit | IT-Administrator von Verve | ☒ Name: *(noch nicht benannt – offen)* |
| Ansprechperson Datenschutz | Auskunfts- und Löschverlangen entgegennehmen, Verfahren nach Abschnitt 7 auslösen, Verzeichnis der Verarbeitungstätigkeiten pflegen | Geschäftsführung oder externer Datenschutzbeauftragter, falls bestellt | ☒ Name: Michael Schmitz |
| Fachliche Verantwortung Vertriebsdaten | entscheidet über Zugriffsklassen bei Zweifeln, gibt Artefakte frei | Leitung Vertrieb / Principal | ☒ Name: *(noch nicht benannt – offen)* |

## 3. Zwecke und Rechtsgrundlagen

| Datenklasse | Beispiele | Zweck | Rechtsgrundlage (Vorschlag) |
|---|---|---|---|
| Kundenorganisationen | Name, Typ, Konzernbezug, Setups | Vertriebssteuerung, Kundenbetreuung | Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an Vertrieb und Kundenpflege); Organisationsdaten sind überwiegend nicht personenbezogen |
| Geschäftliche Ansprechpartner | Name, Funktion, geschäftliche E-Mail/Telefon, Zuständigkeit, Beziehungsstand | Kontaktpflege, Zuordnung von Bedarfen und Entscheidungsrollen | Art. 6 Abs. 1 lit. f DSGVO – berechtigtes Interesse; Abwägung: nur geschäftliche Kontaktdaten, keine privaten Merkmale, Betroffene erwarten Kontaktaufnahme im B2B-Kontext |
| Gesprächsinhalte und Dokumente | Notizen, Protokolle, hochgeladene Dokumente, importierte Mails/Termine | Nachvollziehbare Vertriebsarbeit, Belege für Bedarfe und Angebote | Art. 6 Abs. 1 lit. f DSGVO; bei Vertragsanbahnung mit dem Kunden zusätzlich lit. b |
| Beschäftigtendaten Verve | Name, E-Mail, Rollen, Aktionen, Weekly-Beiträge, Ziele, Protokolleinträge | Zusammenarbeit, Zuständigkeiten, Nachvollziehbarkeit | § 26 BDSG / Art. 6 Abs. 1 lit. b DSGVO (Beschäftigungsverhältnis); keine Leistungsbewertung einzelner Personen (Briefing 21) |
| Vertrauliche Führungsnotizen | Notizen mit explizitem Empfängerkreis | Führungsarbeit | § 26 BDSG; nur für benannte Empfänger sichtbar |
| Protokolle (Audit) | Akteur, Aktion, Objekt, Zeit, Feldnamen | Nachweis der Verarbeitung, Missbrauchserkennung | Art. 6 Abs. 1 lit. c/f DSGVO (Rechenschaftspflicht Art. 5 Abs. 2) |

**Nicht erfassen:** Gesundheitsdaten, politische oder religiöse Ansichten, private Lebensumstände von Ansprechpartnern, Vergütungen einzelner Personen beim Kunden, Bewertungen der Persönlichkeit. Wer solche Angaben in einer Quelle vorfindet, lässt sie weg oder wählt die Zugriffsklasse „persönlich“ und informiert die Ansprechperson Datenschutz.

☒ Rechtsgrundlagen bestätigt · ☒ Interessenabwägung für Ansprechpartner dokumentiert (Vorlage: dieser Abschnitt)

## 4. Information der Betroffenen

Ansprechpartner beim Kunden werden nicht aktiv über die Aufnahme in das System informiert – das ist im B2B-Vertrieb üblich und nach Art. 14 Abs. 5 lit. b DSGVO vertretbar, wenn die Information einen unverhältnismäßigen Aufwand bedeutet und die Verarbeitung erwartbar ist. Vorschlag: Die Datenschutzhinweise auf der Verve-Website erhalten einen Absatz „Geschäftskontakte“, der Zwecke, Rechtsgrundlage, Speicherdauer und Betroffenenrechte nennt. Beschäftigte werden mit einer kurzen internen Information (eine Seite) über den Pilot unterrichtet.

☒ Absatz auf der Website ergänzt · ☒ Beschäftigteninformation verschickt am: *(Datum im unterschriebenen Dokument nicht eingetragen – offen)*

## 5. Datenschutz-Folgenabschätzung (DSFA)

Vorschlag: Eine DSFA ist nicht erforderlich. Begründung: keine besonderen Kategorien, keine systematische Überwachung, keine Bewertung oder Scoring von Personen (die Anwendung priorisiert nach transparenten Kategorien, nicht nach Personen), kein Profiling, keine Zusammenführung großer Datenbestände, überschaubarer Personenkreis. Die KI-Nutzung erzeugt Vorschläge aus einzelnen Texten, die ein Mensch bestätigt; sie trifft keine Entscheidungen über Personen. Diese Einschätzung wird schriftlich festgehalten (dieser Abschnitt genügt) und bei Erweiterungen (CRM-Sync, automatischer Mailimport aller Postfächer, Leistungsauswertungen) erneut geprüft.

☐ Einschätzung bestätigt · ☐ DSFA doch erforderlich – Begründung: ____________

*Hinweis: Diese beiden Kästchen sind auch im unterschriebenen Dokument nicht angekreuzt, obwohl die Begründung oben ausformuliert ist. Das ist noch offen und wurde der Geschäftsführung am 21.09.2026 zur Klärung zurückgemeldet.*

## 6. Aufbewahrung und Löschkonzept

Vorschlag für Fristen. Die Anwendung setzt heute keine automatischen Fristen; die Fristen werden durch den Betriebsverantwortlichen halbjährlich per Bestandsübersicht („Verwaltung → Bestand“) geprüft und manuell umgesetzt, bis eine automatische Ablauflogik nachgerüstet ist.

| Datenklasse | Aufbewahrung | Auslöser der Löschung |
|---|---|---|
| Ansprechpartner ohne aktive Beziehung | 3 Jahre nach letzter dokumentierter Interaktion | Prüfung halbjährlich; Beziehungsstand „nicht aktiv“ |
| Quellen (Notizen, Dokumente, Mails, Termine) | 3 Jahre nach Quellenzeit; bei laufendem Auftrag bis 3 Jahre nach Auftragsende | Prüfung halbjährlich |
| Bedarfe, Angebote, Aufträge | 10 Jahre (handels-/steuerrechtliche Aufbewahrung der zugehörigen Belege), Inhalte ohne Belegcharakter 3 Jahre | Prüfung jährlich |
| Weeklys, Aktionen, Übergaben, Accountpläne | 3 Jahre | Prüfung halbjährlich |
| Vertrauliche Führungsnotizen, Zielgespräche | Dauer des Beschäftigungsverhältnisses + 1 Jahr | Austritt |
| Zugänge Beschäftigter | Deaktivierung am Austrittstag; Datensatz bleibt für Nachvollziehbarkeit der Protokolle, Name nach 3 Jahren pseudonymisieren | Austritt (Verwaltung → Zugang deaktivieren) |
| Audit-Protokolle | 3 Jahre | Prüfung jährlich |
| KI-Auftragsprotokolle (Hash, Länge, Tokens) | 1 Jahr | Prüfung jährlich |
| Sicherungen | 14 Tage täglich auf dem Server; wöchentliche Kopie an zweitem Ort 3 Monate | automatisch (Ablauf statt Einzellöschung) |

Löschungen in Sicherungen: Einzelne Datensätze werden aus Sicherungen nicht entfernt; sie laufen mit der Aufbewahrung der Sicherung ab. Wird eine Sicherung zurückgespielt, werden vorher dokumentierte Sperr- und Löschentscheidungen erneut angewendet (sie stehen in der Datenbank und werden mit wiederhergestellt, S12); zwischenzeitlich eingegangene Löschverlangen werden anhand des Verfahrensverzeichnisses nachgezogen.

☒ Fristen bestätigt (ggf. angepasst) · ☒ Zweiter Sicherungsort festgelegt: *(Ort im unterschriebenen Dokument nicht eingetragen – offen; Vorschlag: IONOS-Backup im Cloud Panel oder wöchentlicher `scp` auf ein Verve-Laufwerk)*

## 7. Verfahren bei Auskunfts- und Löschverlangen

Eingang bei der Ansprechperson Datenschutz (E-Mail-Adresse: michael.schmitz@verveconsulting.de). Frist: Antwort innerhalb eines Monats.

Auskunft: Betriebsverantwortlicher sucht Person unter „Kunden → Ansprechpartner“ und Quellen mit Nennung, exportiert die Angaben (Stammdaten, Funktion, Beziehungsstand, Liste der Quellen mit Titel und Datum) und übergibt sie der Ansprechperson Datenschutz zur Beantwortung. Interne Vermutungen (Zugriffsklasse „persönlich“) werden nach rechtlicher Prüfung beauskunftet.

Löschung: Für jede betroffene Quelle den zweistufigen Ablauf ausführen – auf der Quellenseite **Sperren** (Grund eintragen), danach **Inhalt entfernen**. Die Anwendung markiert abhängige Vorschläge, Aussagen und Artefaktfassungen als überholt und löscht bei Dokumenten auch die Datei. Personendatensatz: Beziehung auf „nicht aktiv“ setzen, Stammdaten auf „[gelöscht]“ pseudonymisieren (bis eine Löschfunktion für Personen nachgerüstet ist: durch den Betriebsverantwortlichen in Abstimmung mit der Ansprechperson Datenschutz). Eintrag ins Verfahrensverzeichnis mit Datum; Sicherungen laufen ab (Abschnitt 6).

Widerspruch gegen die Verarbeitung (Art. 21): wie Löschung behandeln, sofern keine zwingenden Gründe (laufender Auftrag) entgegenstehen.

☒ Eingangsadresse festgelegt · ☒ Verfahrensverzeichnis angelegt (Datei/Ort: *(im unterschriebenen Dokument nicht eingetragen – offen)*)

## 8. Auftragsverarbeiter und Übermittlungen

| Dienst | Zweck | Ort | Vertrag |
|---|---|---|---|
| IONOS SE | Server (VPS), Sicherungen | Deutschland | AV-Vertrag im IONOS-Kundenkonto abschließen (Cloud Panel → Verträge/Datenschutz) ☒ |
| Cloudflare | nur DNS (kein Proxy, kein Verkehr über Cloudflare) | – | Keine Verarbeitung von Inhalten; kein AVV nötig, Standardbedingungen genügen ☒ geprüft |
| Microsoft (Entra ID) | Anmeldung | EU | Bestehender Microsoft-365-Vertrag inkl. DPA ☒ vorhanden |
| Langdock GmbH | KI-Analyse von Notizen und Dokumenten | EU | AV-Vertrag im Langdock-Vertrag ☒ vorhanden; Modelle laut Langdock in EU-Regionen gehostet ☒ geprüft; keine Nutzung der Inhalte zum Training laut Vertrag ☒ geprüft |
| Let's Encrypt | TLS-Zertifikat | – | Keine personenbezogenen Daten außer Domainname |
| GitHub | Quellcode (keine Daten) | USA | Nur Code, keine Produktivdaten; kein AVV für Daten nötig |

Kein weiterer Drittlandtransfer. Vor einem Mailimport aus Microsoft 365 (Graph) ist die App-Registrierung mit lesenden Mindestrechten und eine ergänzende Bewertung nötig (E-018/E-023).

## 9. Technische und organisatorische Maßnahmen (Stand der Anwendung)

Zugriff nur nach Anmeldung mit Microsoft-Konto des Verve-Mandanten; Rollen aus der Rollenverwaltung, kein Zugang ohne Rolle. Zugriffsklassen je Quelle (persönlich / Setup / Account-Team / Arbeitsraum), CEO und Verwaltung ohne pauschalen Rohquellenzugriff. TLS erzwungen (HSTS), Anwendung nur intern erreichbar, Server-Firewall auf 22/80/443, Proxy-Logs ohne Query-Strings. Sitzungen laufen nach 12 Stunden bzw. 2 Stunden Inaktivität ab; Nutzungsgrenzen gegen Missbrauch. Vollständiges Protokoll ohne Inhalte (Feldnamen, kein Text). Sperr-/Löschablauf mit Folgewirkung. Tägliche Sicherung von Datenbank und Dokumenten, 14 Tage, nur root lesbar. Geheimnisse ausschließlich in der Serverkonfiguration. KI: nur Vorschläge, wörtliche Textstellen, Schema- und Quellenprüfung, Protokoll ohne Inhalte, Tageslimit.

Organisatorisch umgesetzt: SSH-Zugang ausschließlich mit Schlüsseln, Passwort-Login deaktiviert ☒ · Cloud-Panel-Zugang mit Zwei-Faktor-Authentifizierung ☒ · Zugangsliste für Root, Cloud Panel, Cloudflare und Langdock-Schlüssel vorhanden ☒ · Vertreterregelung eingerichtet ☒

## 10. Vor der Freischaltung (Checkliste aus `docs/pilotfreigabe.md`, Abschnitt C)

1. ☒ Wiederherstellungstest mit einer Produktionssicherung (`docs/betrieb.md` Abschnitt 5) – Datum: *(nicht eingetragen – offen)*
2. ☒ Manueller Zugriffstest: zwei reale Nutzer mit unterschiedlichen Rollen rufen fremde Setup-/Quellen-Adressen direkt auf → „nicht gefunden“ – Datum: *(nicht eingetragen – offen)*
3. ☒ Reverse-Proxy geprüft: `https://` erzwungen, HSTS gesetzt, `http://accountmeister…:3000` von außen nicht erreichbar
4. ☒ Zugänge und Rollen der ersten Nutzer angelegt; Demo-/Seed-Daten nicht eingespielt (Produktion startet leer)
5. ☒ Abschnitte 2, 6, 7 ausgefüllt; Verfahrensverzeichnis angelegt
6. ☒ Ladezeiten mit realistischer Datenmenge einmal gemessen und in `docs/betrieb.md` notiert

## 11. Freigabe

Mit Unterschrift wird der Betrieb der Anwendung mit echten Kunden- und Kontaktdaten im Umfang der Abschnitte 1–3 freigegeben, einschließlich der KI-Verarbeitung über Langdock, des Imports aus ausgewählten Microsoft-365-Postfächern und -Kalendern sowie von Microsoft Bing Grounding ausschließlich für öffentliche, nicht vertrauliche Webrecherchen. Erweiterungen, insbesondere CRM-Synchronisation, weitere Postfächer, weitere Auftragsverarbeiter oder eine Ausweitung der Websuche auf vertrauliche Inhalte, benötigen eine erneute kurze Freigabe.

Ort, Datum: Verve Consulting, 21.09.2026

Geschäftsführung Verve Consulting: Ivo Seifert

Betriebsverantwortlicher: Raimund Bendl

Ansprechperson Datenschutz: Michael Schmitz
