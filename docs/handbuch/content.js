// Inhalt des Anwenderhandbuchs „Accountmeister“ für BDs und Principals – gemeinsame Quelle für Word und PowerPoint.
// Nur fiktive Beispiele. Stand: Etappe 10 (September 2026).

const BRAND = { navy: "161927", green: "55BF36", ink: "1F2937", muted: "6B7280", light: "F3F6F4", white: "FFFFFF", warn: "8A6D1F" };

const APP_URL = "https://accountmeister.verveconsulting.ai";

const chapters = [
  {
    title: "Worum es geht",
    lead: "Accountmeister ist unsere Sales-Arbeitsumgebung. Sie hilft dabei, aus Gesprächen, Notizen und Dokumenten den Weg zur Vermittlung zu finden – und nichts zu vergessen, was dafür noch fehlt.",
    paras: [
      "Das Ergebnis unserer Vertriebsarbeit ist eine Vermittlung: ein Verve-Consultant in einer unserer Standardrollen, ein Freelancer auf einer Spezialistenrolle oder eine Ausschreibung bzw. ein Rahmenvertrag, aus dem mehrere Vermittlungen folgen. Genau dieses Ergebnis heißt im Tool „Chance“. Alles andere – Beobachtungen, Personen, Fragen, Aktionen – ordnet sich der Frage unter, welcher Chance es dient. Diese Frage nennt das Tool „Wofür“.",
      "Das Tool erfasst nur, was dokumentiert ist, und unterscheidet konsequent zwischen belegten Sachverhalten und Vermutungen. Es rechnet keine Umsätze, keine Wahrscheinlichkeiten und keinen Forecast. Es zählt und benennt, was da ist, und sagt, was fehlt.",
      "Die KI ist Sparringspartner und Erfasser, kein Entscheider. Sie schlägt vor – als Karten, mit wörtlicher Textstelle als Beleg – und ihr übernehmt oder verwerft. Nichts entsteht ohne Klick, nichts wird automatisch an Kunden verschickt, und die KI recherchiert nicht im Internet.",
    ],
  },
  {
    title: "Die Begriffe",
    lead: "Sieben Begriffe reichen für die tägliche Arbeit.",
    table: {
      header: ["Begriff", "Bedeutung", "Beispiel (fiktiv)"],
      rows: [
        ["Kunde", "Die Organisation, mit der wir arbeiten oder arbeiten wollen.", "Musterwerke GmbH"],
        ["Setup", "Ein Arbeitszusammenhang beim Kunden: ein Team, ein Bereich, ein Vorhaben. Ein Kunde hat meist mehrere Setups.", "Plattformteam, Migration Lagersystem"],
        ["Chance", "Worauf es hinausläuft: Verve-Experte, Freelancer-Experte oder Ausschreibung – mit Standardrolle, Anzahl, Zeithorizont und Reifegrad.", "2× Test Management, Q1 2027, antizipiert"],
        ["Person / Buyingcenter", "Ansprechpartner beim Kunden mit Funktion, Beziehungsstand und – je Setup – Einschätzung (Entscheidungsrolle, Haltung, Einfluss).", "Frau Keller, Leiterin IT, Budgetverantwortung, positiv"],
        ["Beobachtung", "Ein Sachverhalt aus einem Gespräch oder Dokument, immer mit Quelle. Vermutungen stehen getrennt daneben.", "„Das Migrationsteam plant zusätzliche Testtermine.“"],
        ["Aktion / Frage", "Was wir als Nächstes tun bzw. im nächsten Gespräch klären – mit Verantwortlichem, Termin und Wofür.", "Bis 30.09. Grobkonzept nachhalten (BD)"],
        ["Weekly", "Der bestätigte Wochenstand je Setup: Was hat sich geändert, was ist vereinbart. Grundlage für alles, was danach kommt.", "W38 Plattformteam, bestätigt von David"],
      ],
    },
    paras: [
      "Rollen im Tool: Der BD ist operativ für Kunden und Setups zuständig. Der Anker bringt Projektkontext aus laufenden Einsätzen ein und beantwortet Rückfragen; er spricht keine neuen Personen an, wenn das nicht vereinbart ist. Der Principal sieht sein Portfolio, nimmt Unterstützungsaufträge an und führt die Weeklys mit den BDs. Der CEO sieht das Gesamtbild ohne Rohquellen.",
    ],
  },
  {
    title: "Einstieg: Anmeldung und Startseite",
    lead: "Anmelden mit dem Microsoft-365-Konto, danach landet ihr auf „Start“.",
    paras: [
      `Die Anwendung läuft unter ${APP_URL}. Die Anmeldung erfolgt über Microsoft 365 (Entra ID); ein eigenes Passwort gibt es nicht. Wer keine fachliche Rolle hinterlegt hat, wendet sich an die Betriebsverwaltung.`,
      "Die Startseite ist das Dashboard eurer Rolle. Wer mehrere Rollen hat (zum Beispiel Principal und BD bei verschiedenen Kunden), wählt oben die Sicht; angeboten werden nur Rollen, die euch tatsächlich zugewiesen sind. Die Sicht ist eine Brille, keine Rechteänderung: Die BD-Sicht zeigt eure Kunden als zuständiger BD, die Principal-Sicht euer Portfolio, die Anker-Sicht die Setups mit eurem Kontextbeitrag.",
      "Links steht „Diese Woche dran“: überfällige und bis Wochenende fällige Aktionen, Übergaben an euch, an euch adressierte Vorschläge, Unterstützungsaufträge und anstehende Weeklys. Überfälliges ist rot, Heutiges fett.",
      "Rechts steht je Kunde eine Karte. Die erste Zeile ist das Wofür: alle aktiven Chancen mit Rolle, Anzahl, Horizont und Reifegrad. Darunter die Stufe („Kontakt & Kontext“ bis „Einsatz gestartet“), der nächste große Schritt und drei Spalten: Blockiert (dokumentierte Hindernisse wie überfällige Aktionen oder Chancen, die seit über drei Wochen in Klärung hängen), Was fehlt (Lücken wie fehlender Kontextsatz, keine Personen, unbesetzte Entscheidungsrollen, kein nächster Schritt) und Naheliegende Züge (offene Fragen, Vorschläge, Rückmeldungen, die im Tool schon vorbereitet sind). Die fünf Kunden mit dem größten Aufmerksamkeitsbedarf stehen ausführlich, der Rest als Tabelle.",
      "Ein Kunde ohne Chance trägt die gelbe Zeile „Noch keine Chance benannt – worauf läuft es hinaus?“. Das ist bewusst unbequem: Ohne Wofür bleibt jede Aktivität Selbstzweck.",
    ],
  },
  {
    title: "Der Assistent",
    lead: "Unten rechts auf jeder Seite: der Dialog, der mitdenkt, Karten vorschlägt und fragt, was fehlt.",
    paras: [
      "Der Assistent kennt den Kontext der Seite, auf der ihr ihn öffnet – ein Setup, einen Kunden oder allgemein. Er eröffnet mit den offenen Punkten und dem, was ihm fehlt, um Vorschläge machen zu können. Ihr schreibt oder diktiert (Windows-Diktat mit Win + H), er antwortet und legt Karten vor.",
      "Karten sind Vorschläge: Kunde (mit erstem Setup), Setup, Person mit Einschätzung, Beobachtung, Chance mit Art, Rolle und Horizont, Aktion mit Rolle, Kontaktaufnahme mit Nachrichtenentwurf und offene Frage. Jede Karte trägt die wörtliche Textstelle, auf die sie sich stützt, und das Wofür – die Chance, der sie dient. Steht dort „Wofür unklar“, übernehmt sie nur, wenn ihr den Zweck kennt.",
      "Übernehmen legt den Gegenstand an: Aus einer Kunde-Karte werden Kunde und Setup, aus einer Chance-Karte eine antizipierte Chance, aus Aktionen und Kontaktaufnahmen Vorschläge in „Meine Arbeit“ der adressierten Rolle. Verwerfen verwirft. Der Assistent legt nichts selbst an – wenn er schreibt „ich habe angelegt“, ist das falsch, und das Tool weist darauf hin.",
      "Der Interviewmodus (Schaltfläche „Interview“ oder „Mit dem Assistenten erfassen“ auf der Kundenseite) lässt den Assistenten aktiv durch die Erfassung führen: Organisation, Anlass, Personen, Entscheidungsweg, Bedarf, Zeit und Budget, Bestand und Wettbewerb, Beziehungen und Zugang, nächste Schritte. Ihr könnt gern mehrere Dinge auf einmal erzählen; er fragt nach, was fehlt.",
      "Praktisch: Ein Gesprächsprotokoll oder Dossier könnt ihr in den Assistenten einfügen oder unter „Kunden → Dokument hochladen“ als Datei geben (PDF, Word, Excel, Text, E-Mail). In beiden Fällen entsteht ein Vorschlag, den ihr prüft, ändert und übernehmt.",
    ],
  },
  {
    title: "Kunde, Setup und Chance anlegen",
    lead: "Drei Wege zum Kunden, ein Formular für die Chance – und immer die Frage: Wofür?",
    paras: [
      "Einen neuen Kunden legt ihr auf der Seite „Kunden“ an: mit dem Assistenten (Dialog oder Interview), aus einem hochgeladenen Dokument oder von Hand. In allen Fällen entsteht ein Kunde mit einem ersten Setup; Personen, Beobachtungen und Chancen kommen als Vorschläge dazu. Wer Kunden anlegen darf: BD und Principal.",
      "Ein Setup braucht nur einen verständlichen Namen und einen Kontextsatz („Was läuft hier?“); die Sichtbarkeit legt fest, wer es sieht (nur Beteiligte, Kundenteam oder Arbeitsraum). Jedes Setup hat Reiter: Überblick, Strategiefaden, Personen & Zugang, Artefakte, Weeklys. „Vorschlagen lassen“ belegt das Formular aus dem bekannten Kundenkontext vor.",
      "Eine Chance erfasst ihr im Setup unter „Chance erfassen“: Titel, Art (Verve-Experte, Freelancer-Experte, Ausschreibung), Standardrolle aus dem Katalog, Anzahl, Zeithorizont, Beschreibung in Kundensprache und Anlass. Das Häkchen „Antizipiert“ heißt: Wir vermuten das aus Beobachtungen, der Kunde hat es noch nicht ausgesprochen. Sobald er es tut, klickt ihr auf der Chance „In Klärung nehmen“.",
      "Reifegrade einer Chance: antizipiert → in Klärung → bestätigt → im Angebot/Auswahl → beauftragt → gestartet. Kritische Übergänge brauchen einen Beleg: „bestätigt“ eine Quelle oder Belegnotiz, „vorgestellt“ ein tatsächlich vorgestelltes Angebot, „beauftragt“ einen Nachweis, „startbereit“ den bestätigten Stand aller Startvoraussetzungen. Eine positive Rückmeldung zu einem Angebot ist noch kein Auftrag.",
      "Die Chance-Seite zeigt außerdem, was auf sie einzahlt: Aktionen, Beobachtungen, offene Fragen und Vorschläge, die dieser Chance zugeordnet sind. Beim Anlegen einer Aktion wählt ihr im Feld „Wofür“ die Chance; bei nur einer aktiven Chance ist sie vorbelegt.",
    ],
  },
  {
    title: "Standardrollen",
    lead: "Chancen zeigen auf Rollen aus dem Verve-Katalog – so wird das Zielbild zählbar.",
    table: {
      header: ["Rollenfamilie", "Rollen"],
      rows: [
        ["Delivery Management", "Projektleitung · Programmleitung · PMO · Delivery Manager · Governance, RAID-Management, Reporting, Ressourcensteuerung"],
        ["Agile Leadership", "Scrum Master · Agile Coach · Release Train Engineer (RTE) · SAFe-, LeSS- oder Kanban-orientierte Führungsrollen"],
        ["Business Analyse & Beratung", "Business Analyst · Requirements Engineer · Fachkonzeption · Prozessberatung · Demand Management und Anforderungsanalyse"],
        ["Solution & Architektur", "Solution Architect · Enterprise Architect · Cloud-, SAP- und Integrationsarchitektur · API- und Schnittstellendesign · Security-by-Design und Zielarchitekturen"],
        ["Test & Qualitätssicherung", "Test Management · Test Analyse · QA · Qualitäts- und Abnahmesicherung"],
      ],
    },
    paras: [
      "Bei einer Ausschreibung reicht oft die Rollenfamilie. Fehlt eine Rolle im Katalog, ergänzt die Betriebsverwaltung sie unter Verwaltung → Rollen; die KI ordnet Rollennamen aus Texten dem Katalog unscharf zu und lässt die Rolle offen, wenn nichts passt – das erscheint dann als Lücke.",
    ],
  },
  {
    title: "Personen und Buyingcenter",
    lead: "Wer entscheidet, wer bewertet, wer ist auf unserer Seite – und zu wem fehlt noch der Kontakt?",
    paras: [
      "Unter „Personen & Zugang“ pflegt ihr Ansprechpartner mit Funktion und Beziehungsstand (Name/Funktion bekannt, Vorstellung angefragt, vorgestellt, im Austausch, konkrete Zusammenarbeit). Jede Beziehung hat einen Halter bei Verve; ein Beziehungsstand ab „vorgestellt“ braucht einen Beleg.",
      "Die Einschätzung je Person und Setup ist an MEDDPICC angelehnt: Entscheidungsrolle (Bedarfsträger, fachliche Bewertung, Budgetverantwortung, Einkauf/Vertragsweg, zusätzliche Freigabe, Unterstützer/Sponsor), Haltung zu Verve (positiv, neutral, kritisch) und Einfluss (hoch, mittel, niedrig). Eine Einschätzung ist zunächst Hypothese; bestätigt wird sie nur mit sichtbarer Quelle. Sichtbar ist sie für BD, Principal und den Beziehungshalter, nicht pauschal für alle.",
      "Das Buyingcenter benennt die Lücken: unbesetzte Entscheidungsrollen, Entscheider ohne Kontakt, kritische Haltungen ohne Gegenposition, unbestätigte Hypothesen. Diese Lücken erscheinen auch auf dem Dashboard unter „Was fehlt“.",
      "Kontaktwege dokumentieren, über wen wir an eine Person herankommen könnten. Kontaktaufnahmen, die der Assistent vorschlägt, sind Entwürfe für Menschen – sie werden nie automatisch versendet.",
    ],
  },
  {
    title: "Weeklys, Notizen und Vorschläge",
    lead: "Der Wochenrhythmus je Setup: Notiz erfassen, strukturieren lassen, Vorschläge prüfen, Stand bestätigen.",
    paras: [
      "Ein Weekly gehört zu einem Setup. Ihr bereitet es vor, erfasst die Freitextnotiz, lasst sie strukturieren und bestätigt am Ende den Stand. Der bestätigte Stand ist die Grundlage für das nächste Weekly („Was hat sich seit dem letzten Weekly geändert?“) und für den Accountplan des Kunden.",
      "„Notiz strukturieren“ zerlegt die Notiz in Vorschläge: Beobachtungen, Aktionen, Entscheidungen, offene Fragen, Personen, Konflikte, Kontaktaufnahmen. Jeder Vorschlag zitiert wörtlich die Stelle der Notiz und trägt sein Wofür. Annehmen legt an – eine Beobachtung entsteht als „neu“, eine Aktion als Vorschlag der adressierten Person; ablehnen braucht einen Grund, damit die KI lernt, was unpassend war.",
      "Vorschläge, die an euch adressiert sind, stehen auf der Startseite unter „Diese Woche dran“ und in „Meine Arbeit“. Offene Vorschläge im Setup erscheinen als „Ideen aus den Quellen“.",
    ],
  },
  {
    title: "Der Strategiefaden",
    lead: "Je Setup eine versionierte Hypothese: Wo stehen wir, was ist der nächste große Schritt, welche Züge lohnen sich.",
    paras: [
      "Der Reiter „Strategiefaden“ zeigt zuerst die Lage, wie das Tool sie aus dem Dokumentierten ableitet: Stufe, nächster großer Schritt, Blocker, Lücken, naheliegende Züge, Wofür. Darunter die aktuelle Fassung des Fadens und ein Formular für eine neue Fassung.",
      "„Vorschlag der KI einholen“ belegt das Formular vor: Lage in zwei bis vier Sätzen (belegt und vermutlich getrennt), nächster großer Schritt, bis zu fünf Züge mit Rolle und Begründung, belegte Risiken, offene Fragen. Züge ohne Textstelle aus Lage oder Kontext werden verworfen. Ihr prüft, ändert, entfernt – und speichert eine Fassung. Jede Speicherung ist eine neue Version; frühere Fassungen bleiben nachlesbar, damit später klar ist, was wir wann dachten und warum.",
      "Pflegen darf, wer das Setup bearbeiten darf; alle anderen Berechtigten lesen mit. Der Faden ist ein guter Anker für das Weekly zwischen BD und Principal.",
    ],
  },
  {
    title: "Für Principals: Portfolio und Zielbild",
    lead: "Wohin läuft das Portfolio, wo hakt es, wer braucht Unterstützung.",
    paras: [
      "Die Principal-Sicht auf der Startseite zeigt die eigenen Kunden mit Wofür, Blockern und Lücken, dazu Unterstützungsaufträge, die an euch gerichtet sind, und laufende Ziele.",
      "Unter „Ziele & Portfolio“ steht das Zielbild: eine Matrix Rollenfamilie × Reifegrad mit der Zahl der Positionen (Summe der Anzahl je Chance), darunter alle Chancen im Portfolio mit Kunde, Setup, Wofür, Reifegrad und Horizont. Zurückgestellte und beendete Chancen zählen nicht. Es gibt keine Beträge und keine Wahrscheinlichkeiten – das ist Absicht: Wir zählen dokumentierte Chancen und nennen ihren Reifegrad.",
      "Die Portfolioübersicht darunter zeigt je Kunde Zählungen aus den Accountplänen (Setups ohne bestätigtes Weekly, offene Beobachtungen, offene Fragen, Zugangslücken, unbelegte Beziehungen, vereinbarte und vorgeschlagene Ausbau-Vorhaben, offene und blockierte Aktionen, offene Unterstützungsaufträge). Unterstützungsaufträge stellen BDs an Principal oder CEO; ihr nehmt an, gebt zurück oder tragt das Ergebnis ein. Ziele werden mit Zustimmung beider Rollen vereinbart und in Versionen geführt.",
      "Führungs-Weeklys (Principal/BD) und das Zielgespräch (CEO/Principal) haben eigene Reviews mit Teilnehmerkreis; vertrauliche Führungsnotizen haben einen expliziten Empfängerkreis und tauchen nirgends sonst auf.",
    ],
  },
  {
    title: "Regeln, die das Tool durchsetzt",
    lead: "Damit das Bild belastbar bleibt – und damit wir mit echten Kundendaten sauber arbeiten.",
    list: [
      "Die KI schlägt nur vor. Nichts wird ohne Klick angelegt; nichts wird automatisch an Kunden verschickt; die KI recherchiert nicht im Internet und erhält nur den Text, den ihr ihr gebt, plus die im Tool bekannten Namen.",
      "Jeder KI-Vorschlag trägt eine wörtliche Textstelle. Vorschläge ohne belegbare Textstelle werden verworfen – ihr seht die Zahl.",
      "Sachverhalt und Vermutung bleiben getrennt: Beobachtungen sind belegt, Einschätzungen sind Hypothesen, bis eine Quelle sie bestätigt. Ein Reifegrad springt nie ohne Beleg.",
      "Zugriffsklassen regeln, wer was sieht: nur Beteiligte, Kundenteam, Arbeitsraum, persönlich. Quellen (Notizen, Dokumente) sieht nur, wer im Setup beteiligt ist; CEO und ADMIN sehen keine Rohquellen.",
      "Personenbezogene Daten von Geschäftskontakten (Name, Funktion, Zuständigkeit) dürfen ins Tool. Besonders schutzwürdige Inhalte – Gesundheit, Vergütung einzelner Personen, private Konflikte – bleiben draußen oder in der Zugriffsklasse „persönlich“.",
      "Löschen ist möglich, aber bewusst: Eine Quelle kann gesperrt oder ihr Inhalt entfernt werden (Folgewirkung wird angezeigt). Ein Kunde wird in zwei Schritten gelöscht – archivieren, dann endgültig löschen mit Begründung – durch den zuständigen BD, den Principal oder die Betriebsverwaltung. Alles steht im Prüfprotokoll.",
      "Sitzungen laufen nach zwei Stunden Inaktivität ab; Änderungen sind auf ein vernünftiges Maß pro Zeit begrenzt. Hinter jeder Änderung steht ein Name.",
    ],
  },
  {
    title: "Häufige Fragen",
    faq: [
      ["Ich sehe den Kunden nicht, den der Assistent „angelegt“ hat.", "Der Assistent legt nichts selbst an. Sucht die Karte „Kunde“ in seiner Antwort und klickt „Übernehmen“. Kamen keine Karten, schreibt kurz „Kunde X anlegen“ – dann schlägt er die Karte vor."],
      ["Der Assistent sagt „KI nicht verfügbar“ oder „nicht schemakonform“.", "Meist ist unter Verwaltung → KI kein passendes Modell für die Aufgabe gewählt. Die Betriebsverwaltung prüft die Verbindung und wählt ein Modell mit guter Instruktionstreue. Ohne KI zeigt der Assistent weiterhin offene Punkte und Lücken."],
      ["Welche Sichten kann ich wählen?", "Nur die Rollen, die euch zugewiesen sind. Wer die Anker-Sicht sehen will, wird als Anker in ein Setup eingetragen – das ist protokolliert."],
      ["Wann ist eine Chance „antizipiert“, wann „in Klärung“?", "Antizipiert: Wir vermuten sie aus Beobachtungen. In Klärung: Der Kunde hat den Bedarf ausgesprochen. Bestätigt: Er hat ihn bestätigt, und wir haben einen Beleg dafür."],
      ["Muss ich Anzahl und Zeithorizont angeben?", "Nein. Bei antizipierten Chancen weiß das oft noch niemand. Eine Anzahl ohne Angabe zählt im Zielbild als eine Position."],
      ["Wie diktiere ich?", "Windows-Diktat mit Win + H in jedem Textfeld, auch im Assistenten. Eine eigene Audioaufnahme mit Transkription ist noch nicht eingebaut."],
      ["Was gehört in den Kontextsatz eines Setups?", "Ein Satz, der einem Kollegen erklärt, was dort beim Kunden läuft: „Verve unterstützt das Plattformteam mit zwei Einsätzen; nächste Phase ist die Migration auf die neue Plattform.“"],
      ["Wer sieht meine Einschätzung einer Person?", "BD und Principal des Kunden sowie der Beziehungshalter der Person. Nicht pauschal der CEO, nicht die Betriebsverwaltung."],
    ],
  },
];

module.exports = { BRAND, APP_URL, chapters };
