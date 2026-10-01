/**
 * Hilfe-Wissen (Etappe 25): Handbuch, Funktionen und Einstellungen als eine gepflegte Quelle.
 *  - Der Assistent bekommt daraus die zur Frage passenden Abschnitte (Stichwortsuche, kein Embedding) und
 *    beantwortet Rückfragen zur Anwendung nur daraus – mit Menüpfad, ohne Funktionen zu erfinden.
 *  - Dieselben Abschnitte zeigt die Seite /hilfe.
 *  - Pflegeregel: Wer eine Funktion ändert, ändert hier den Abschnitt mit (Test „hilfe.test.ts“ prüft Grundaussagen).
 */

export type HelpSection = {
  id: string;
  title: string;
  /** Wo man es findet (Menüpfad) */
  where: string;
  /** Suchbegriffe (klein, ohne Umlaute-Sonderfälle – die Suche normalisiert) */
  keywords: string[];
  body: string;
};

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: "grundidee",
    title: "Worum es geht: Kunde, Setup, Chance, Wofür",
    where: "Kunden → Kunde → Setup → Chance",
    keywords: ["begriff", "kunde", "setup", "chance", "wofuer", "grundidee", "vermittlung", "struktur", "aufbau"],
    body: `Das Ergebnis unserer Vertriebsarbeit ist eine Vermittlung. Im Tool heißt sie „Chance“ – mit drei Arten: Verve-Experte in einer Standardrolle, Freelancer-Experte auf einer Spezialistenrolle oder Ausschreibung/Rahmenvertrag.
Ein Kunde ist die Organisation. Ein Setup ist ein Arbeitszusammenhang beim Kunden (Team, Bereich, Vorhaben); ein Kunde hat meist mehrere Setups, ein Setup mehrere Chancen.
Beobachtungen, Personen, Aktionen und offene Fragen tragen immer ein „Wofür“: die Chance, auf die sie einzahlen. Auf der Chance-Seite zeigt der Block „Was auf diese Chance einzahlt“ genau das.
Das Tool rechnet keine Umsätze, Wahrscheinlichkeiten oder Forecasts; es zählt, was dokumentiert ist, und sagt, was fehlt.`,
  },
  {
    id: "chance-status",
    title: "Chancen-Status und wie man weiterkommt",
    where: "Kunden → Kunde → Chance öffnen (oder Start → „Wo stehen wir? – je Chance“ → Button „Nächster Schritt“)",
    keywords: ["status", "stufe", "antizipiert", "in klaerung", "klaerung", "bestaetigt", "bestaetigen", "beleg", "angebot", "vorgestellt", "auswahl", "bestellung", "beauftragt", "auftrag", "zurueckstellen", "beenden", "weiterklicken", "naechster schritt", "fortschritt", "stepper"],
    body: `Der Status hängt immer an der einzelnen Chance – nicht am Setup und nicht am Kunden. Kunden- und Setup-Seite zeigen deshalb unter „Wo stehen wir? – je Chance“ eine Zeile je offener Chance mit eigenem Fortschrittsbalken und dem Button „Nächster Schritt“.
Stufen: Antizipiert → In Klärung → Bestätigt → Profil/Angebot vorgestellt → Auswahl/Bestellung → Beauftragt. Daneben: Zurückgestellt und Beendet.
So kommt man weiter (alles auf der Chance-Seite, Block „Chance“):
- Antizipiert → In Klärung: Button „In Klärung nehmen“.
- → Bestätigt: Aufklapper „Chance bestätigen (Beleg optional)“. Ein Beleg (vorhandene Quelle oder kurze Notiz, z. B. „Bestätigung durch den Kunden“) ist hilfreich, aber keine Pflicht – Bestellnummern und Verträge liegen oft in anderen Systemen. Bestätigen geht aus Antizipiert, In Klärung oder Zurückgestellt.
- → Profil/Angebot vorgestellt: im Block „Angebote / Profilvorstellungen“ ein Angebot anlegen (Entwurf), auf „Geprüft“ setzen und dann „Vorstellungsereignis bestätigen“. Ein Entwurf gilt nie als vorgestellt.
- → Beauftragt: im Block „Auftrag und Einsatz“ einen Auftrag anlegen und „Beauftragung bestätigen (Nachweis optional)“.
- Zurückstellen oder Beenden: Aufklapper „Zurückstellen / Beenden (mit Begründung)“; von dort auch „Wieder in Klärung“.
Wer darf: die verantwortliche Person der Chance, Setup-Beteiligte, der zuständige BD, Principals und Sales Operations (Sales Operations bereitet vor, bestätigen/entscheiden bleibt beim BD). Fehlt ein Button, fehlt meist die Bearbeitungsberechtigung – oder die Chance ist beendet.`,
  },
  {
    id: "chance-seite",
    title: "Die Chance-Seite: Aufbau",
    where: "Chance öffnen (Link aus Kunde, Setup, Start oder Meine Arbeit)",
    keywords: ["chance seite", "buyingcenter", "meddpicc", "berater", "angebote", "auftrag", "einsatz", "startvoraussetzung", "startbereit", "gestartet", "einzahlt", "rolle hinzufuegen"],
    body: `Reihenfolge: Fortschrittsbalken mit „Nächster Schritt“ → Block „Chance“ (Status, Bestätigen, Bearbeiten, Zurückstellen) → „Was auf diese Chance einzahlt“ → „Vorgehen“ (Vorgehensmuster; das Startformular ist zugeklappt) → Buyingcenter für diese Chance mit Buying-Center-Berater → Qualifizierungshilfe (MEDDPICC, optional) → Angebote / Profilvorstellungen → Auftrag und Einsatz.
Im Auftrag: Startvoraussetzungen erfassen und nachweisen, dann „Startbereit“ und „Gestartet“. Geplantes Ende und Verlängerungsfrist eintragen – daraus entsteht die Verlängerungsregel (siehe Health-Check).`,
  },
  {
    id: "anlegen",
    title: "Kunde, Setup und Chance anlegen",
    where: "Kunden → „Kunde aus Dialog, Dokument oder Interview anlegen“; im Assistenten über Karten",
    keywords: ["anlegen", "lege", "neu", "neuen", "neuer kunde", "kunde anlegen", "setup anlegen", "chance anlegen", "dokument", "import", "interview", "karte", "karten", "uebernehmen"],
    body: `Drei Wege: (1) Im Assistenten erzählen oder Text einfügen – er schlägt Karten vor (Kunde, Setup, Person, Beobachtung, Chance, Aktion, Kontakt, Frage); angelegt wird nur, was du aus einer Karte übernimmst. (2) Kunden → „Kunde aus Dokument anlegen“: Dokument hochladen, Vorschläge prüfen. (3) Geführtes Interview.
Eine Chance legst du auch direkt im Setup an (Abschnitt „Chancen“). Chancen sind in Kundensprache formuliert und bleiben „antizipiert“, bis der Kunde den Bedarf ausgesprochen hat.`,
  },
  {
    id: "assistent",
    title: "Der Assistent",
    where: "Rechts unten auf jeder Seite (Panel „Assistent“); Kontext = aktuelle Kunden-/Setup-Seite oder „Allgemein“",
    keywords: ["assistent", "ki", "karten", "interview modus", "interviewmodus", "einsortierung", "email einfuegen", "mail", "vorschlag", "gespraech"],
    body: `Der Assistent ist Sparringspartner und Erfasser, kein Entscheider. Er antwortet kurz, schlägt Karten mit wörtlichem Beleg vor und fragt nach, was fehlt. Im Interview-Modus führt er aktiv durch die Themen.
Im allgemeinen Kontext kannst du eine E-Mail einfügen; er schlägt dann eine Einsortierung zu einem bekannten Kunden vor. Er legt nie selbst etwas an, verschickt nichts und recherchiert nicht im Internet. Rückfragen zur Bedienung beantwortet er aus diesem Hilfe-Wissen.`,
  },
  {
    id: "rollen",
    title: "Rollen und Rechte",
    where: "Verwaltung → „Zugänge und Rollen“ (nur Betriebsverwaltung)",
    keywords: ["rolle", "rollen", "rechte", "berechtigung", "darf", "principal", "bd", "anker", "ceo", "sales ops", "sales operations", "admin", "verwaltung", "sehen", "zugriff", "kein button", "fehlt button"],
    body: `BD: verantwortet Kunden, Setups und Chancen, trifft Vertriebsentscheidungen.
Anker: Verve-Kolleg:in im Kundenteam; bringt Kontext, fachliche Rückfragen oder Einführungen ein (Beteiligung je Setup).
Principal: Führungsrolle, arbeitsraumweit oder je Kunde. Hat volle Rechte auf seinen Kunden: sieht und pflegt Setups und Chancen, stellt BD, Anker und Verantwortliche um. Arbeitsraumweite Principals pflegen außerdem Vorgehensmuster und den strategischen Fokus. Persönliche Notizen anderer bleiben privat.
Sales Operations: unterstützt alle BDs – sieht und pflegt Kunden, Setups, Chancen und Personen, bereitet Angebote und Ausschreibungen vor. Entscheidungen (z. B. Chance bestätigen) und Verantwortung (Zuständigkeit) bleiben beim BD.
CEO: CEO-Dashboard (Aktivität, Ist/Ziel, Sattelfestigkeit, Freelancer-Hebel je BD); Zusammenfassungen, keine Rohquellen.
Betriebsverwaltung (Admin): Zugänge, Rollen, KI-Konfiguration, Fristenprüfung – ohne inhaltliche Vertriebsrechte.
Rollen vergibt die Betriebsverwaltung unter Verwaltung → „Rolle zuweisen“ (arbeitsraumweit oder für einen Kunden).`,
  },
  {
    id: "delegation",
    title: "Zuständigkeit umstellen (Delegation)",
    where: "Kunde → „Zuständigkeit“; Setup → Beteiligte; Chance → „Chance bearbeiten“ → Verantwortlich",
    keywords: ["zustaendig", "zustaendigkeit", "umstellen", "stelle", "bd", "delegation", "delegieren", "verantwortlich", "owner", "bd wechseln", "anker", "uebergabe", "uebergeben", "beteiligung"],
    body: `Principal, CEO und der zuständige BD können jederzeit umstellen: auf der Kundenseite unter „Zuständigkeit“ den zuständigen BD, im Setup den Setup-BD und die Anker-Beteiligungen (Beitrag: Kontext, fachliche Rückfragen, Einführung möglich), in der Chance die verantwortliche Person. Der neue BD erhält automatisch die kundenbezogene Rolle.
Sales-Operations-Zugänge können keine Verantwortung tragen. Für einzelne Beobachtungen gibt es zusätzlich „Übergabe an eine andere Person“ – die Empfängerin nimmt sie unter Meine Arbeit an.`,
  },
  {
    id: "vorgehen",
    title: "Vorgehensmuster und Schritt-Assistent",
    where: "Mehr → Vorgehen (Muster pflegen); Chance/Setup/Kunde → Block „Vorgehen“ (starten)",
    keywords: ["vorgehen", "vorgehensmuster", "playbook", "muster", "schritt", "schritt assistent", "entwurf", "reaktivierung", "altkunde", "verlaengerung", "ausschreibung", "erstgespraech", "starten", "pausieren"],
    body: `Ein Vorgehensmuster ist eine bewährte Schrittfolge (Ziel, MEDDPICC-Bezug, empfohlene Aktion, Erledigt-Kriterium, Frist). Standardmuster: Altkunden-Reaktivierung, Verlängerung vor Einsatzende, Ausschreibung bearbeiten (einige Schritte an Sales Operations), Neues Setup: Erstgespräch.
Starten: auf der Chance-, Setup- oder Kundenseite im Block „Vorgehen“ den Aufklapper „Vorgehen starten“ öffnen und ein passendes Muster wählen; die Chance-Seite schlägt passende Muster vor. Jeder Schritt wird als Aktion angelegt; erledigte Aktionen schließen den Schritt. Läufe lassen sich zurückstellen, fortsetzen und einer anderen Person geben.
Schritt-Assistent: Zu einem Schritt entwirft die KI passende Texte (z. B. Mail mit Referenzbitte, Gesprächsleitfaden) – als Entwurf, nie versendet.
Muster pflegen (Mehr → Vorgehen) dürfen arbeitsraumweite Principals, CEO und Betriebsverwaltung. Dort liegt auch „Reaktivierung prüfen – ruhende Kunden“.`,
  },
  {
    id: "ruhend",
    title: "Ruhende Kunden und Reaktivierung",
    where: "Kunden → „Reaktivierung prüfen“; Mehr → Vorgehen; Kunde → „Zuständigkeit“ (ruhend stellen)",
    keywords: ["ruhend", "ruhende", "reaktivierung", "reaktivieren", "altkunde", "inaktiv", "schlafend"],
    body: `Unter „Reaktivierung prüfen“ erscheinen Kunden, die als ruhend markiert sind oder seit mehr als 180 Tagen keine dokumentierte Aktivität haben. Von dort startest du das Muster „Altkunden-Reaktivierung“ und kommst Schritt für Schritt wieder ins Gespräch. Auf der Kundenseite (Bereich „Zuständigkeit“) markierst du einen Kunden mit „Als ruhend markieren“ bzw. „Wieder als aktiv führen“ – das dürfen der zuständige BD, Principal und CEO.`,
  },
  {
    id: "fokus",
    title: "Strategischer Fokus und Freelancer-Hebel",
    where: "Mehr → Vorgehen → „Strategischer Fokus“ → „Fokus bearbeiten“",
    keywords: ["fokus", "strategisch", "freelancer", "freelancer hebel", "hebel", "standardaufgabe", "standardaufgaben", "wachstum", "kachel", "spezialist"],
    body: `Der strategische Fokus (derzeit „Wachstum über Freelancer“) ist ein Text, den alle KI-Agenten berücksichtigen, ohne ihre Regeln zu lockern. Der Schalter „Freelancer-Hebel“ aktiviert zusätzlich:
- Standardaufgaben als Vorschläge für die zuständige Person: Freelancer-Check bei neuer/bestätigter Chance („Braucht das Team weitere Rollen?“), Ausweitung zwei Wochen nach Einsatzstart („Weitere Profile anbieten“), Freelancer-Potenzial bei Kunden seit 90 Tagen ohne Freelancer-Chance (je Quartal). Sie entstehen beim Öffnen von Start/Meine Arbeit und werden wie jeder Vorschlag angenommen oder verworfen.
- die Kachel „Freelancer-Hebel“ auf Start und die Auswertung je BD im CEO-Dashboard.
- eine Weekly-Frage („Welche Rollen könnten wir zusätzlich besetzen …?“).
Bearbeiten dürfen arbeitsraumweite Principals, CEO und Betriebsverwaltung; lesen alle.`,
  },
  {
    id: "health",
    title: "Kunden-Health-Check und Verlängerungsregel",
    where: "Kunde → „Health-Check – wie sicher sitzen wir im Sattel?“ → Interview; Start → Hinweisbanner und „Auslaufende Einsätze“",
    keywords: ["health", "health check", "fahrplan", "vertrag", "bestellung", "ping", "restlaufzeit", "healthcheck", "score", "sattel", "sattelfest", "wackelig", "gefaehrdet", "zufriedenheit", "listung", "rahmenvertrag", "risiko", "risiken", "einsatz", "einsaetze", "auslaufend", "verlaengerung", "verlaengerungsregel", "datenlage", "punkte"],
    body: `Der Health-Check bewertet je Kunde mit 0–100 Punkten, wie sicher wir im Sattel sitzen – nach festen, sichtbaren Regeln: Einsätze (25), Beziehungsbreite (20), Zufriedenheit (20), Vertrag & Listung (15), Pipeline (10), Aktivität (10); Risiken im Umfeld ziehen ab. Ab 70 „sattelfest“, ab 45 „wackelig“, darunter „gefährdet“; „zu wenig Daten“, wenn zu viel unbekannt ist. Unbekanntes zählt nicht als schlecht, sondern senkt die getrennt ausgewiesene Datenlage.
Fehlende Angaben (Zufriedenheit, Listung, Risiken) fragt ein kurzes Interview ab; die Startseite weist unübersehbar darauf hin, bei welchen Kunden Angaben fehlen.
Einsätze kommen aus den Aufträgen (geplantes Ende, Verlängerungsfrist). Verlängerungsregel: 14 Tage vor der Verlängerungsfrist bzw. 8 Wochen vor dem Einsatzende startet automatisch das Vorgehen „Verlängerung vor Einsatzende“ als Vorschlag. Vorher, 3 Monate vor Ende (bzw. 30 Tage vor der Verlängerungsfrist), bekommt der BD einen Ping „Verlängerung ansprechen“. Den ganzen Ablauf zeigt der „Fahrplan Verlängerung“ im Health-Check je Einsatz: Ping (3 Monate) → Vorgehen startet (8 Wochen) → Anschlussbedarf klären → Angebot → Eskalation an Principal/CEO (4 Wochen vor Ende, wenn nichts erledigt ist) → Entscheidung zum Einsatzende – jeweils mit Datum und Stand (erledigt, steht an, überfällig). „Auslaufende Einsätze“ auf Start zeigt alles mit Ende in den nächsten 3 Monaten.
Vertrag oder Bestellung hinterlegst du im Health-Check bei „Einsätze“ → „hinterlegen“: Datei hochladen oder Link/Ablageort im führenden System eintragen. Sichtbar für das Kundenteam – zuständiger BD, Principal, Sales Operations und Beteiligte –, damit Enddatum und Fristen nachschlagbar sind. Der Score bewertet Kunden, nie Personen, und sperrt nichts.`,
  },
  {
    id: "start",
    title: "Startseite und Meine Arbeit",
    where: "Start; Mehr → Meine Arbeit",
    keywords: ["start", "startseite", "dashboard", "meine arbeit", "diese woche", "uebersicht", "aufgaben", "offene aktionen"],
    body: `Start zeigt: „Wo stehen wir insgesamt?“ (Chancen je Stufe), Health-Check-Hinweise, auslaufende Einsätze, die Kachel Freelancer-Hebel, „Diese Woche dran“ und je Kunde, wo der nächste große Schritt hängt (mit Health-Badge).
Meine Arbeit sammelt alles, was bei dir liegt: offene Übernahmen an dich, Unterstützungsaufträge, deine offenen Aktionen und Chancen, nächste Weeklys und deine Setups.`,
  },
  {
    id: "agenda",
    title: "Kundenagenda, Beschaffungsweg und Berater im Einsatz",
    where: "Kunde → „Kundenagenda – was treibt den Kunden?“ und „Einkauf & Beschaffung“; Health-Check → Einsätze (Spalte Berater)",
    keywords: ["kundenagenda", "agenda", "prioritaeten", "prioritaet", "initiative", "initiativen", "schluessel initiative", "herausforderung", "herausforderungen", "problembereich", "beschaffung", "beschaffungsweg", "vermittler", "einkauf", "berater", "operativer berater", "kurzangebot", "hebel", "ausweiten", "vertiefen"],
    body: `Die Kundenagenda hält fest, was den Kunden treibt – in seinen Worten und getrennt von unseren Chancen: Prioritäten des Kunden, Schlüssel-Initiativen (z. B. „Toolvertrag läuft Ende 2026 aus“) und Herausforderungen. Einträge mit Datum oder ungefährem Termin („Ende 2026“, „Q2 2027“) erinnern 120 Tage vorher: Der zuständige BD bekommt eine vorgeschlagene Aktion „Kundeninitiative steht an – Chance prüfen“. Auf der Chance-Seite ordnest du unter „Zahlt ein auf (Kundenagenda)“ zu, auf welche Initiative eine Chance einzahlt.
Unter „Einkauf & Beschaffung“ steht, ob wir direkt, über einen Vermittler (mit Namen) oder über einen Rahmenvertrag arbeiten; der Health-Check zeigt das bei „Vertrag & Listung“.
Je Einsatz trägst du im Health-Check den operativen Berater ein (Verve-Kolleg:in oder, z. B. bei Freelancern, nur der Name); ist er zugleich Anker, steht das dabei.
Ideen für Kurzangebote werden als Vorhaben mit Hebel (Verlängern, Ausweiten, Vertiefen, Übertragen) im Accountplan und als antizipierte Chance erfasst; für den Text gibt es die Artefakt-Vorlage „Kurzangebot“ (A17). Umsatzschätzungen führt der Accountmeister bewusst nicht.`,
  },
  {
    id: "sos",
    title: "SOS-Protokolle",
    where: "Kunde → „SOS-Protokolle“ → „SOS auslösen“; Startseite (rotes SOS-Feld)",
    keywords: ["sos", "ausloesen", "sos protokoll", "notfall", "eskalation", "eng", "wird eng", "anker kommt nicht weiter", "blockiert", "hilfe anfordern", "auslaufend", "auslaufende assignments", "kein anschluss"],
    body: `Ein SOS löst jeder aus dem Kundenteam aus – auch der Anker –, wenn es eng wird: ein Einsatz läuft aus und kein Anschluss ist in Sicht, der Anker kommt beim Kunden nicht mehr weiter, oder die Lage spitzt sich zu (Budget, Zufriedenheit, Konflikt). Du beschreibst kurz die Lage und was helfen würde. Das SOS erscheint sofort unübersehbar auf der Startseite von BD und Principal und zählt im Health-Check als akutes Risiko (je −5, höchstens −10), bis jemand „Gelöst“ mit einer kurzen Lösung dokumentiert. Mit „Ich kümmere mich“ übernimmt jemand die Bearbeitung. Auch der Assistent kann aus deinem Text eine SOS-Karte vorschlagen.`,
  },
  {
    id: "accountseite",
    title: "Bestehende Account-Seite übernehmen (z. B. aus Notion)",
    where: "Assistent (auf der Kundenseite oder allgemein) → Seite einfügen → „Alle übernehmen“",
    keywords: ["notion", "account seite", "accountseite", "einfuegen", "importieren", "uebernehmen", "alle uebernehmen", "migration", "bestehende seite", "kundenanlage"],
    body: `Füge eine bestehende Account-Seite (z. B. aus Notion) einfach in den Assistenten ein – bei einem neuen Kunden am besten mit dem Namen in der ersten Zeile („Kunde: …“). Der Assistent schlägt dann Karten vor: Kunde, Verve-Team (BD, Anker, Berater), jeden Punkt der Kundenagenda, die Stakeholder als Personen (mit Rolle im Buyingcenter, E-Mail und Telefon), den Beschaffungsweg, laufende Einsätze mit Ende (damit greift die Verlängerungsregel), Risiken wie ein Nachbarteam, das sich querstellt, Ideen für Kurzangebote als Hebel und Chance sowie SOS-Fälle. Leere Vorlagenfelder und Umsatzschätzungen übernimmt er nicht. Mit „Alle übernehmen“ legst du alles in der richtigen Reihenfolge an (Kunde zuerst); einzelne Karten kannst du vorher verwerfen.`,
  },
  {
    id: "provision",
    title: "Provisionsrechner",
    where: "Mehr → Provisionsrechner (Anker, BD, Principal, CEO)",
    keywords: ["provision", "provisionsrechner", "marge", "nettomarge", "finding fee", "signing fee", "provisionssatz", "basisprovision", "ek", "vk", "einkauf", "verkauf", "vermittlung"],
    body: `Der Provisionsrechner zeigt, welche Provision eine Vermittlung bringt. Je Deal wählst du das Profil – eine interne Rolle mit festem EK (Associate 500, Analyst Consultant 576, Consultant 672, Consultant Lvl 2 736, Specialist 828, Senior Specialist 874, Senior Consultant 880, Executive Consultant 1.012, Director 1.320 €/Tag) oder „Freelancer“ mit frei eingetragenem EK – und trägst VK, Einsatztage und deinen Anteil an Finding und Signing Fee ein.
Rechnung: Nettomarge = Tage × (VK − EK) − Kostenpauschale (40 € je Einsatztag); Nettomarge % = Nettomarge / Umsatz. Provisionssatz nach Stufe: unter 10 % keine Basisprovision, ab 10 % → 10 %, ab 17 % → 15 %, ab 20 % → 20 %; nur für Principals zusätzlich ab 45 % → 43 %. BDs und Anker erhalten höchstens 20 %. Basisprovision = Nettomarge × Satz; dazu Finding Fee (250 €) und Signing Fee (1.000 €) je Deal, jeweils mit deinem Anteil. Der Rechner speichert nichts; verbindlich ist die Abrechnung.`,
  },
  {
    id: "ceo",
    title: "CEO-Dashboard",
    where: "Hauptmenü → CEO-Dashboard (nur CEO)",
    keywords: ["ceo", "ceo dashboard", "aktivitaetskoeffizient", "koeffizient", "zielbild", "ist vs ziel", "sattelfestigkeit", "gesamtbild", "fuehrung", "management"],
    body: `Das CEO-Dashboard zeigt das Gesamtbild ohne Rohquellen (keine Mails, keine persönlichen Notizen):
- Aktivitätskoeffizient je Kunde: dokumentierte Aktivitäten der letzten 7 Tage × Anzahl beteiligter Rollen (Principal, BD, Anker) ÷ 3 – hoch, wenn viel passiert und die Rollen zusammenarbeiten.
- Ist- vs. Zielbild: Positionen je vereinbartem Accountziel (Ist aus den dokumentierten Chancen, Ziel aus dem Accountziel).
- Sattelfestigkeit je Kunde aus dem Health-Check, sortiert nach Handlungsbedarf (viele Einsätze bei niedriger Sattelfestigkeit zuerst); ein Klick auf den Kunden öffnet die Begründung.
- Freelancer-Hebel je BD: offene und neue Freelancer-Chancen, vorgestellte Profile, Kunden ohne Freelancer-Chance.
- Je Kunde eine Karte mit Zielen vs. Ist-Stand, Top-Chancen und der Zusammenarbeit dieser Woche.
Alles sind Zählungen dokumentierter Objekte – keine Umsatz-, Forecast- oder Wahrscheinlichkeitswerte. Accountziele gelten erst als vereinbart, wenn Principal und CEO zugestimmt haben; das Zielgespräch CEO/Principal liegt unter Ziele & Portfolio → „Führungs-Reviews“.`,
  },
  {
    id: "weekly",
    title: "Weeklys und Führungs-Reviews",
    where: "Hauptmenü → Weeklys → „Weekly anlegen“ (je Setup); Ziele & Portfolio → „Führungs-Reviews“ → „Review anlegen“ (Principal-/BD-Weekly, Zielgespräch)",
    keywords: ["weekly", "weeklys", "wochenstand", "review", "reviews", "fuehrungs review", "principal bd weekly", "zielgespraech", "entscheidung", "notiz"],
    body: `Ein BD-/Anker-Weekly ist der bestätigte Wochenstand je Setup: unter Weeklys anlegen → vorbereiten (das Tool zeigt, was sich seit dem letzten bestätigten Weekly geändert hat) → Entscheidungen erfassen → bestätigen. Bestätigte Stände lassen sich nur über eine Korrektur ändern. Die Setup-Seite ist entlang der Weekly-Fragen aufgebaut (Was läuft? Was hat sich geändert? Was ist vereinbart? Welche Anregungen helfen?).
Principal-/BD-Weeklys und CEO-/Principal-Zielgespräche sind Führungs-Reviews ohne festes Setup; sie werden unter Ziele & Portfolio → „Führungs-Reviews“ → „Review anlegen“ angelegt und haben Vorbereitung, Notizen, Entscheidungen und vertrauliche Notizen.`,
  },
  {
    id: "personen",
    title: "Personen, Buyingcenter und Kontaktwege",
    where: "Setup → „Personen & Zugang“; Chance → „Buyingcenter für diese Chance“",
    keywords: ["person", "personen", "ansprechpartner", "buyingcenter", "buying center", "entscheider", "budget", "haltung", "einfluss", "kontaktweg", "kontakt", "zugang"],
    body: `Personen gehören zum Kunden; ihre Einschätzung (Entscheidungsrolle, Haltung, Einfluss) gilt je Setup bzw. je Chance. Unter „Personen & Zugang“ pflegst du Personen, Kontaktwege (wer bei Verve kennt wen) und das Buyingcenter; der Buying-Center-Berater auf der Chance-Seite zeigt Lücken (z. B. keine Budgetverantwortung benannt).`,
  },
  {
    id: "strategie",
    title: "Strategiefaden und Chancen-Berater",
    where: "Setup → Strategiefaden; Chance → Buying-Center-Berater",
    keywords: ["strategie", "strategiefaden", "lage", "berater", "naechster grosser schritt", "analyse"],
    body: `Der Strategiefaden fasst je Setup die Lage zusammen: eine regelbasierte Lageanalyse (was dokumentiert ist, was fehlt) plus eine KI-Fassung als Vorschlag, die du speicherst oder verwirfst. Der „nächste große Schritt im Setup“ steht auch auf der Setup-Seite.`,
  },
  {
    id: "ziele",
    title: "Ziele & Portfolio, Accountziele",
    where: "Hauptmenü → Ziele & Portfolio",
    keywords: ["ziel", "ziele", "portfolio", "accountziel", "zielbild", "fuehrung", "unterstuetzung", "unterstuetzungsauftrag"],
    body: `Ziele & Portfolio zeigt alle Chancen im Portfolio, Unterstützungsaufträge, Ziele (als Entwurf anlegen, dann vereinbaren) und Führungs-Reviews. Accountziele (z. B. „drei Solution-Architektur-Rollen bis Q4 2027“) setzen Principal oder CEO je Kunde; die Ausgangslage rechnet das Tool aus den dokumentierten Chancen.`,
  },
  {
    id: "eingang",
    title: "Eingang, Importe und Outlook",
    where: "Mehr → Eingang; Mehr → Einstellungen → „Mein Postfach (Microsoft 365 / Outlook)“",
    keywords: ["eingang", "import", "importe", "protokoll", "outlook", "postfach", "mail importieren", "e-mail", "microsoft", "zuordnung"],
    body: `Im Eingang liegen Setups mit offener BD-Zuordnung und zu prüfende Importe; dort importierst du Gesprächsprotokolle oder einzelne Mails aus dem eigenen Postfach. Das Postfach verbindest du unter Einstellungen → „Mein Postfach“ – lesend, mit minimalen Berechtigungen; es wird nie ein ganzes Postfach eingelesen, du wählst einzelne Nachrichten.`,
  },
  {
    id: "artefakte",
    title: "Artefakte (Textentwürfe)",
    where: "Mehr → Artefakte; Setup → Artefakte",
    keywords: ["artefakt", "artefakte", "textentwurf", "profilangebot", "freigabe", "entwurf", "vorlage"],
    body: `Artefakte sind Textentwürfe für Kunden (z. B. Profilangebot, Einseiter). Sie durchlaufen Prüfung und Freigabe mit Versionen; nichts wird automatisch versendet.`,
  },
  {
    id: "einstellungen",
    title: "Einstellungen und Verwaltung",
    where: "Mehr → Einstellungen; Verwaltung (nur Betriebsverwaltung): Zugänge & Rollen, KI-Konfiguration, Standardrollen, Fristenprüfung",
    keywords: ["einstellung", "einstellungen", "konfiguration", "ki konfiguration", "ki modell", "modell", "anbieter", "langdock", "verbrauch", "standardrollen", "fristen", "fristenpruefung", "aufbewahrung", "loeschen", "archivieren", "profilreferenz", "zugang anlegen"],
    body: `Einstellungen (alle): eigenes Postfach, Status der Anbindungen, freigegebene Profilreferenzen, Hinweise zu Administration und Aufbewahrung.
Verwaltung (Betriebsverwaltung): Zugänge anlegen und Rollen zuweisen, Protokoll; KI-Konfiguration (Anbieter, Modelle je Aufgabe, Verbrauch der letzten 30 Tage, Nutzungsgrenze je Tag); Standardrollen-Katalog ergänzen; Fristenprüfung (Aufbewahrung von Personen, Quellen, Protokollen).
Einen Kunden löschst du in zwei Schritten: erst archivieren, dann endgültig löschen (Kunde → Löschen).`,
  },
  {
    id: "regeln",
    title: "Regeln, die das Tool durchsetzt",
    where: "überall",
    keywords: ["regel", "regeln", "warum", "geht nicht", "nicht moeglich", "fehler", "beleg", "nachweis", "version", "konflikt", "gleichzeitig"],
    body: `Bestätigen, Vorstellen und Beauftragen sind eigene, bewusste Schritte; Belege und Nachweise sind optional (ohne Beleg steht „ohne Beleg“ dabei). KI-Ergebnisse sind immer Vorschläge; jede Karte braucht eine wörtliche Textstelle. Beendete Chancen werden nicht mehr geändert. Hat jemand anderes denselben Datensatz gerade gespeichert, meldet das Tool einen Konflikt – Seite neu laden und erneut speichern. Persönliche Notizen und vertrauliche Führungsnotizen bleiben privat.`,
  },
];

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["ich", "du", "wie", "was", "wo", "der", "die", "das", "den", "dem", "ein", "eine", "einen", "und", "oder", "ist", "sind", "kann", "man", "mich", "mir", "bei", "auf", "von", "mit", "zu", "zum", "zur", "fuer", "im", "in", "es", "nicht", "noch", "auch", "hier", "da", "dann", "wenn", "gibt", "habe", "hat", "bitte", "mal"]);

function wordMatch(q: string, k: string): boolean {
  if (q === k) return true;
  if (q.length < 6 || k.length < 6) return false;
  // grobe Stammform: „bestaetige“ ~ „bestaetigen“, „verlaengerungsregel“ ~ „verlaengerung“
  return k.startsWith(q.slice(0, Math.max(6, q.length - 2))) || q.startsWith(k.slice(0, Math.max(6, k.length - 2)));
}

/** Wie viele Abschnitte ein Suchbegriff hat – seltene Begriffe zählen mehr (einfaches IDF). */
const KEYWORD_SPREAD = (() => {
  const m = new Map<string, number>();
  for (const s of HELP_SECTIONS) for (const k of new Set(s.keywords)) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
})();

/** Einfache Stichwortsuche: Treffer in Suchbegriffen zählen am meisten (seltene mehr), dann Titel, dann Text. */
export function searchHelp(query: string, limit = 3): { section: HelpSection; score: number }[] {
  const q = ` ${norm(query)} `;
  const words = norm(query).split(" ").filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return [];
  const scored = HELP_SECTIONS.map((section) => {
    let score = 0;
    for (const k of section.keywords) {
      const weight = 3 / (KEYWORD_SPREAD.get(k) ?? 1);
      if (k.includes(" ")) {
        if (q.includes(` ${k} `)) score += weight + 2;
      } else if (words.some((w) => wordMatch(w, k))) score += weight;
    }
    const titleWords = norm(section.title).split(" ");
    const bodyWords = new Set(norm(`${section.body} ${section.where}`).split(" "));
    for (const w of words) {
      if (titleWords.some((t) => wordMatch(w, t))) score += 1.5;
      else if (w.length > 4 && bodyWords.has(w)) score += 0.3;
    }
    return { section, score };
  });
  return scored.filter((s) => s.score >= 2.5).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Erkennt Fragen zur Bedienung („wie kann ich…“, „wo finde ich…“, „warum geht … nicht“). */
export function looksLikeHowTo(text: string): boolean {
  const t = norm(text);
  return /\b(wie \w+ (ich|man|wir)\b|was (darf|kann|muss|soll) |wie (kann|komme|kriege|bekomme|mache|geht|funktioniert|stelle|lege|finde|setze|aendere|starte)|wo (finde|ist|sehe|stelle|kann)|was (bedeutet|heisst|ist|macht|passiert|zeigt)|warum (kann|geht|sehe|fehlt|ist)|wer darf|darf ich|kann ich|gibt es|welche (rechte|rolle|einstellung)|hilfe|handbuch|erklaer)/.test(t);
}

export function formatSection(s: HelpSection): string {
  return `## ${s.title}\nWo: ${s.where}\n${s.body}`;
}

/** Inhaltsverzeichnis – immer im Kontext, damit der Assistent weiß, was es gibt. */
export function helpIndex(): string {
  return HELP_SECTIONS.map((s) => `- ${s.title} (${s.where})`).join("\n");
}
