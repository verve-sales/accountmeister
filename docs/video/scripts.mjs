import { introScene } from "./intro.mjs";
import { PROMO } from "./promo.mjs";
// Drehbücher der Erklärvideos: je Szene Sprechertext (= Untertitel) und Klickweg.
// Aussprache-Hilfen für die Sprachausgabe (nur gesprochen, Untertitel bleiben korrekt geschrieben).
export const SAY_MAP = [
  [/Accountmeister/g, "Äkkaunt-Meister"],
  [/Health-Check/g, "Hälls-Tscheck"],
  [/Sales Operations/g, "Säils Opperäischens"],
  [/Weeklys/g, "Wieklies"],
  [/Weekly/g, "Wiekli"],
  [/Principals/g, "Prinnsipels"],
  [/Principal/g, "Prinnsipel"],
  [/\bBDs\b/g, "Be-Des"],
  [/\bBD\b/g, "Be-De"],
  [/Setups/g, "Setapps"],
  [/Setup/g, "Setapp"],
  [/Freelancer/g, "Frielanser"],
  [/Buyingcenter/g, "Baiing-Center"],
  [/Go\/No-Go/g, "Go oder No-Go"],
  [/KI-/g, "Ka-I-"],
  [/\bKI\b/g, "Ka-I"],
  [/Q1 2027/g, "erstes Quartal 2027"],
  [/Salesmodell/g, "Säils-Modell"],
  [/Verve/g, "Wörv"],
  [/Notion/g, "Nouschen"],
  [/\bSOS\b/g, "S-O-S"],
  [/Pitch/g, "Pitsch"],
  [/Setup/g, "Setapp"],
  [/CEO-Dashboard/g, "Si-I-O-Däschbord"],
  [/\bCEO\b/g, "Si-I-O"],
];

const ACC = "Beispielkonzern AG (fiktiv)";

export const VIDEOS = [
  // ======================================================================= BD
  {
    id: "bd",
    file: "Accountmeister-Erklaervideo-BD",
    title: "Accountmeister für BDs",
    subtitle: "Vom ersten Gespräch zur bestätigten Chance",
    user: "David",
    scenes: [
      introScene("BD"),
      {
        start: "/start",
        say: "Los geht's auf der Startseite. Oben siehst du, wie viele Chancen auf welcher Stufe stehen. Darunter meldet der Health-Check, welche Angaben noch fehlen. Und die Liste der auslaufenden Einsätze zeigt dir, wo eine Verlängerung ansteht.",
        async run(h) {
          await h.at(0.3);
          await h.highlight(h.page.locator("section", { hasText: "Wo stehen wir insgesamt?" }).first(), 3000);
          await h.at(0.55);
          await h.highlight(h.page.locator("section", { hasText: "Health-Check: Accountmeister braucht" }).first(), 3500);
          await h.at(0.8);
          await h.highlight(h.page.locator("section", { hasText: "Auslaufende Einsätze" }).first(), 3500);
        },
      },
      {
        start: async (h) => `/setups/${await h.ids.setup("Migrationsteam")}`,
        say: "Neues aus einem Gespräch erfasst du am schnellsten mit dem Assistenten. Schreib einfach auf, was passiert ist – in deinen eigenen Worten. Der Assistent schlägt daraus Karten vor, zum Beispiel eine Person, eine Beobachtung oder eine Chance. Angelegt wird nur, was du mit „Übernehmen“ bestätigst.",
        async run(h) {
          await h.at(0.08);
          await h.assistant("Heute mit Frau Brandt gesprochen: Herr Vogel, Leiter Qualitätssicherung, sucht Unterstützung im Testmanagement.");
          await h.at(0.62);
          const card = h.page.locator("#assistent-panel").getByRole("button", { name: "Übernehmen" }).first();
          await h.move(card);
          await h.at(0.82);
          await h.click(card);
        },
      },
      {
        start: async (h) => `/kunden/${await h.ids.account(ACC)}`,
        say: "Auf der Kundenseite siehst du unter „Wo stehen wir“ jede offene Chance mit ihrem eigenen Fortschritt. Der Status gehört immer zur einzelnen Chance, nicht zum Kunden. Mit „Nächster Schritt“ springst du direkt an die Stelle, an der es weitergeht.",
        async run(h) {
          await h.at(0.1);
          await h.highlight(h.page.locator("section", { hasText: "Wo stehen wir? – je Chance" }).first(), 4000);
          await h.at(0.45);
          const row = h.page.locator("tr, li, div").filter({ hasText: "Testmanagement für die Migration" }).filter({ has: h.page.getByRole("link", { name: /Nächster Schritt|In Klärung/ }) }).last();
          await h.highlight(row, 3000, 4);
          await h.at(0.8);
          await h.click(row.getByRole("link").last(), { navigate: true });
        },
      },
      {
        start: async (h) => `/bedarfe/${await h.ids.chance("Testmanagement für die Migration")}`,
        say: "Auf der Chance-Seite bringst du die Chance voran. Hat der Kunde den Bedarf angesprochen, nimmst du sie in Klärung. Bestätigt wird sie nur mit einem Beleg – zum Beispiel einer kurzen Notiz, wer was wann zugesagt hat. So bleibt nachvollziehbar, worauf sich jede Stufe stützt.",
        async run(h) {
          await h.at(0.08);
          await h.highlight(h.page.locator("ol, nav, div").filter({ hasText: /Antizipiert.*In Klärung.*Bestätigt/ }).filter({ has: h.page.getByRole("button", { name: "In Klärung nehmen" }) }).last(), 2500);
          await h.at(0.22);
          await h.click(h.page.getByRole("button", { name: "In Klärung nehmen" }).first(), { navigate: true });
          await h.at(0.42);
          await h.type("#confText", "Frau Brandt hat den Bedarf am 29.09. telefonisch bestätigt.");
          await h.at(0.8);
          await h.click(h.page.getByRole("button", { name: "Chance bestätigen" }), { navigate: true });
          await h.top();
        },
      },
      {
        start: async (h) => `/bedarfe/${await h.ids.chance("Testmanagement für die Migration")}`,
        say: "Darunter siehst du, was auf die Chance einzahlt – Aktionen und Beobachtungen. Mit einem Vorgehensmuster bekommst du bewährte Schritte als Aktionen vorgeschlagen. Und der Freelancer-Check erinnert dich daran, ob das Team weitere Spezialistenrollen braucht.",
        async run(h) {
          await h.at(0.05);
          await h.highlight(h.page.locator("section", { hasText: "Was auf diese Chance einzahlt" }).first(), 3500);
          await h.at(0.4);
          await h.scrollTo(h.page.locator("section", { hasText: "Vorgehen (" }).first());
          await h.click(h.page.locator("summary", { hasText: "Vorgehen starten" }).first());
          await h.at(0.72);
          await h.highlight(h.page.getByText(/Freelancer-Check: Braucht das Team/).first(), 3000);
        },
      },
      {
        start: async (h) => `/kunden/${await h.ids.account(ACC)}/health`,
        say: "Wie sicher wir beim Kunden im Sattel sitzen, zeigt der Health-Check. Der Punktwert entsteht aus festen, sichtbaren Regeln – jede Punktzahl hat eine Begründung. Fehlende Angaben fragt ein kurzes Interview ab, zum Beispiel, ob wir beim Kunden gelistet sind oder welche Risiken es gibt.",
        async run(h) {
          await h.at(0.1);
          await h.highlight(h.page.locator("section").first(), 3500);
          await h.at(0.6);
          await h.scrollTo("#interview", "start");
          await h.highlight("#interview", 3000);
          const sel = h.page.locator("#interview select").first();
          if (await sel.count()) {
            await h.at(0.82);
            await h.move(sel);
          }
        },
      },
      {
        start: "/meine-arbeit",
        say: "Unter „Meine Arbeit“ liegt alles, was gerade bei dir ist: Aktionen, Chancen und die nächsten Weeklys. Und wenn du einmal nicht weiterweißt, frag einfach den Assistenten. Er kennt das Handbuch, die Funktionen und deine Einstellungen. Viel Erfolg!",
        async run(h) {
          await h.at(0.05);
          await h.highlight(h.page.locator("section", { hasText: "Meine offenen Aktionen" }).first(), 3000);
          await h.at(0.35);
          await h.assistant("Wie bestätige ich eine Chance?");
          await h.wait(4000);
        },
      },
    ],
  },

  // ======================================================================= Principal
  {
    id: "principal",
    file: "Accountmeister-Erklaervideo-Principal",
    title: "Accountmeister für Principals",
    subtitle: "Portfolio steuern, Zuständigkeit, Fokus und Vorgehen",
    user: "Petra",
    scenes: [
      introScene("PRINCIPAL"),
      {
        start: "/start",
        say: "Als Principal hast du bei deinen Kunden volle Rechte: Du siehst und pflegst Setups und Chancen, und du steuerst, wer zuständig ist. Auf der Startseite siehst du dein ganzes Portfolio – Chancen je Stufe, fehlende Angaben im Health-Check und auslaufende Einsätze.",
        async run(h) {
          await h.at(0.35);
          await h.highlight(h.page.locator("section", { hasText: "Wo stehen wir insgesamt?" }).first(), 3000);
          await h.at(0.62);
          await h.highlight(h.page.locator("section", { hasText: "Health-Check: Accountmeister braucht" }).first(), 3000);
          await h.at(0.85);
          await h.highlight(h.page.locator("section", { hasText: "Auslaufende Einsätze" }).first(), 2500);
        },
      },
      {
        start: "/ziele",
        say: "Unter „Ziele und Portfolio“ siehst du alle Chancen im Portfolio, eure Ziele und die Führungs-Reviews. Accountziele – etwa drei Architekturrollen bis Ende 2027 – setzt du je Kunde. Die Ausgangslage rechnet das Tool selbst aus den dokumentierten Chancen.",
        async run(h) {
          await h.at(0.1);
          await h.highlight(h.page.locator("section", { hasText: "Wohin läuft es" }).first(), 3500);
          await h.at(0.5);
          await h.scrollTo(h.page.locator("h2", { hasText: /^Ziele \(/ }).first());
          await h.highlight(h.page.locator("section", { has: h.page.locator("h2", { hasText: /^Ziele \(/ }) }).first(), 3500);
        },
      },
      {
        start: async (h) => `/kunden/${await h.ids.account(ACC)}`,
        say: "Auf der Kundenseite stellst du unter „Zuständigkeit“ jederzeit den verantwortlichen BD um. Genauso im Setup die Anker-Beteiligungen und in der Chance die verantwortliche Person. Wer neu zuständig wird, bekommt die nötigen Rechte automatisch.",
        async run(h) {
          await h.at(0.08);
          const sec = h.page.locator("section", { hasText: "Zuständigkeit" }).filter({ has: h.page.locator("#reassignBd") }).first();
          await h.highlight(sec, 3500);
          await h.at(0.3);
          await h.move("#reassignBd");
          await h.at(0.6);
          await h.highlight(h.page.locator("section", { hasText: "Wo stehen wir? – je Chance" }).first(), 3500);
        },
      },
      {
        start: async (h) => `/kunden/${await h.ids.account(ACC)}/health`,
        say: "Der Health-Check zeigt dir je Kunde, wie sattelfest ihr seid – von sattelfest über wackelig bis gefährdet. Unbekanntes zählt nicht als schlecht, sondern senkt die Datenlage. Läuft ein Einsatz aus, startet die Verlängerungsregel acht Wochen vor dem Ende automatisch das passende Vorgehen.",
        async run(h) {
          await h.at(0.08);
          await h.highlight(h.page.locator("section").first(), 3500);
          await h.at(0.62);
          const eins = h.page.locator("section", { has: h.page.locator("h2", { hasText: /^Einsätze/ }) }).first();
          await h.scrollTo(eins);
          await h.highlight(eins, 4000);
        },
      },
      {
        start: "/vorgehen",
        say: "Unter „Vorgehen“ setzt du den strategischen Fokus – aktuell Wachstum über Freelancer. Der Text fließt in alle KI-Agenten ein. Der Freelancer-Hebel erzeugt zusätzlich Standardaufgaben, zum Beispiel den Freelancer-Check bei jeder neuen Chance.",
        async run(h) {
          await h.at(0.08);
          await h.highlight(h.page.locator("section", { hasText: "Strategischer Fokus" }).first(), 4000);
          await h.at(0.5);
          await h.click(h.page.locator("summary", { hasText: "Fokus bearbeiten" }).first());
          await h.at(0.7);
          await h.highlight("#fText", 3000);
        },
      },
      {
        start: "/vorgehen",
        prepare: async (h) => { await h.page.evaluate(() => window.scrollTo(0, 0)); },
        say: "Darunter pflegst du die Vorgehensmuster – bewährte Schrittfolgen wie die Altkunden-Reaktivierung oder die Verlängerung vor Einsatzende. Kunden, bei denen lange nichts passiert ist, erscheinen unter „Reaktivierung prüfen“. Von dort startest du das Reaktivierungs-Vorgehen.",
        async run(h) {
          await h.at(0.05);
          const pb = (name) => h.page.locator("section", { has: h.page.locator("h2", { hasText: name }) }).first();
          await h.scrollTo(pb("Altkunden-Reaktivierung"));
          await h.highlight(pb("Altkunden-Reaktivierung"), 2500);
          await h.at(0.3);
          await h.scrollTo(pb("Verlängerung vor Einsatzende"));
          await h.highlight(pb("Verlängerung vor Einsatzende"), 2500);
          await h.at(0.58);
          const re = h.page.locator("section", { hasText: "Reaktivierung prüfen" }).first();
          await h.scrollTo(re);
          await h.highlight(re, 4000);
        },
      },
      {
        start: "/ziele",
        prepare: async (h) => { await h.scrollTo(h.page.locator("section", { hasText: "Führungs-Reviews" }).first(), "center"); },
        say: "Principal-BD-Weeklys und Zielgespräche legst du unter „Ziele und Portfolio“ bei den Führungs-Reviews an. Und für jede Rückfrage zur Bedienung gilt: Frag den Assistenten – zum Beispiel, wer den strategischen Fokus ändern darf.",
        async run(h) {
          await h.at(0.03);
          await h.highlight(h.page.locator("section", { hasText: "Führungs-Reviews" }).first(), 3000);
          await h.at(0.4);
          await h.assistant("Wer darf den strategischen Fokus ändern?");
          await h.wait(4000);
        },
      },
    ],
  },

  // ======================================================================= Anker & Sales Operations
  {
    id: "anker-salesops",
    file: "Accountmeister-Erklaervideo-Anker-und-Sales-Operations",
    title: "Accountmeister für Anker und Sales Operations",
    subtitle: "Kontext beitragen und BDs den Rücken freihalten",
    user: "Nina",
    scenes: [
      introScene("ANKER_SALESOPS"),
      {
        start: "/meine-arbeit",
        say: "Zuerst die Sicht als Anker. Unter „Meine Arbeit“ findest du die Setups, an denen du beteiligt bist, und deine nächsten Weeklys.",
        async run(h) {
          await h.at(0.45);
          await h.highlight(h.page.locator("section", { hasText: "Meine Setups" }).first(), 3000);
          await h.at(0.75);
          await h.highlight(h.page.locator("section", { hasText: "Nächste Weeklys" }).first(), 2500);
        },
      },
      {
        start: async (h) => `/setups/${await h.ids.setup("Migrationsteam")}`,
        say: "Die Setup-Seite folgt den Weekly-Fragen: Was läuft hier? Was hat sich geändert? Was ist vereinbart? Welche Anregungen helfen jetzt? Deine Beteiligung – etwa Kontextbeitrag oder fachliche Rückfragen – ist dort festgehalten. Neue Personen sprichst du nur in Abstimmung mit dem BD an.",
        async run(h) {
          await h.at(0.05);
          await h.highlight(h.page.locator("section", { hasText: "1. Was läuft hier?" }).first(), 3000);
          await h.at(0.35);
          const s3 = h.page.locator("section", { hasText: "3. Was haben wir als Nächstes vereinbart?" }).first();
          await h.scrollTo(s3);
          await h.highlight(s3, 3000);
          await h.at(0.62);
          const who = h.page.getByText(/Anker – Kontextbeitrag/).first();
          if (await who.count()) { await h.scrollTo(who); await h.highlight(who, 3500); }
        },
      },
      {
        start: async (h) => `/setups/${await h.ids.setup("Migrationsteam")}`,
        say: "Hast du beim Kunden etwas mitbekommen, erzähl es dem Assistenten. Er macht daraus eine Beobachtung – als Sachverhalt mit Quelle, Vermutungen getrennt daneben – und ordnet sie der passenden Chance zu. Der BD sieht sie sofort und kann daraus eine neue Chance machen.",
        async run(h) {
          await h.at(0.05);
          await h.assistant("Im Jour fixe hat Frau Brandt erzählt, dass für die Schnittstellen zur neuen Plattform noch ein Cloud-Architekt fehlt.");
          await h.at(0.7);
          await h.click(h.page.locator("#assistent-panel").getByRole("button", { name: "Übernehmen" }).last());
        },
      },
      {
        user: "Sara",
        start: "/kunden",
        say: "Jetzt die Sicht von Sales Operations. Du unterstützt alle BDs: Du siehst und pflegst Kunden, Setups, Chancen und Personen und bereitest Angebote und Ausschreibungen vor. Entscheidungen – zum Beispiel eine Chance zu bestätigen – und die Zuständigkeit bleiben beim BD.",
        async run(h) {
          await h.at(0.2);
          await h.highlight(h.page.locator("table").first(), 4500);
          await h.at(0.7);
          await h.highlight(h.page.locator("header").getByText(/Sales Operations/).first(), 2500);
        },
      },
      {
        user: "Sara",
        start: "/meine-arbeit",
        say: "Vorbereitungsschritte landen direkt bei dir. Beim Vorgehen „Ausschreibung bearbeiten“ übernimmst du zum Beispiel die Bieterfragen sowie Profile und Angebot. Du findest sie unter „Meine Arbeit“. Nimm den Vorschlag an – und los geht's.",
        async run(h) {
          await h.at(0.1);
          const row = h.page.locator("tr", { hasText: "Bieterfragen" }).first();
          await h.highlight(row, 4000);
          await h.at(0.72);
          await h.click(row.getByRole("button", { name: "Annehmen" }), { navigate: true });
        },
      },
      {
        user: "Sara",
        start: async (h) => `/bedarfe/${await h.ids.chance("Rahmenvertrag IT-Dienstleistungen 2027")}`,
        prepare: async (h) => { await h.scrollTo(h.page.locator("section", { hasText: "Vorgehen (" }).first(), "start"); },
        say: "Auf der Chance siehst du den laufenden Schritt mit Ziel und Erledigt-Kriterium. Der Schritt-Assistent entwirft dir passende Texte – immer als Entwurf, nichts wird verschickt. Ist der Schritt erledigt, hältst du das Ergebnis fest, und der nächste Schritt startet automatisch.",
        async run(h) {
          await h.at(0.05);
          await h.highlight(h.page.getByText(/Aktueller Schritt 2\/4/).first(), 3500);
          await h.at(0.35);
          await h.click(h.page.getByRole("button", { name: "Entwürfe erstellen" }).first(), { navigate: true });
          await h.at(0.72);
          const res = h.page.getByPlaceholder("Was ist herausgekommen?").first();
          await h.scrollTo(res);
          await h.type(res, "Drei Bieterfragen eingereicht.");
        },
      },
      {
        user: "Sara",
        start: async (h) => `/bedarfe/${await h.ids.chance("Rahmenvertrag IT-Dienstleistungen 2027")}`,
        prepare: async (h) => { await h.scrollTo(h.page.locator("section", { hasText: "Angebote / Profilvorstellungen" }).first(), "start"); },
        say: "Angebote legst du als Entwurf an und lässt sie prüfen. Als vorgestellt gilt ein Angebot erst, wenn das Vorstellungsereignis mit Beleg bestätigt ist. Und bei Fragen zur Bedienung hilft dir der Assistent – er kennt Handbuch und Rollen.",
        async run(h) {
          await h.at(0.05);
          await h.click(h.page.locator("summary", { hasText: "Angebot anlegen (Entwurf)" }).first());
          await h.highlight(h.page.locator("details", { hasText: "Angebot anlegen (Entwurf)" }).first(), 3500);
          await h.at(0.55);
          await h.assistant("Was darf Sales Operations?");
          await h.wait(4000);
        },
      },
    ],
  },
  // ======================================================================= CEO
  {
    id: "ceo",
    file: "Accountmeister-Erklaervideo-CEO",
    title: "Accountmeister für den CEO",
    subtitle: "Das Gesamtbild – ohne Rohquellen",
    user: "Clemens",
    scenes: [
      introScene("CEO"),
      {
        start: "/start",
        say: "Als CEO siehst du im Accountmeister das Gesamtbild – ohne Rohquellen wie Mails oder persönliche Notizen. Schon die Startseite zeigt dir, wie viele Chancen auf welcher Stufe stehen, wo im Health-Check Angaben fehlen und welche Einsätze bald auslaufen.",
        async run(h) {
          await h.at(0.35);
          await h.highlight(h.page.locator("section", { hasText: "Wo stehen wir insgesamt?" }).first(), 3000);
          await h.at(0.62);
          await h.highlight(h.page.locator("section", { hasText: "Health-Check: Accountmeister braucht" }).first(), 3000);
          await h.at(0.85);
          await h.highlight(h.page.locator("section", { hasText: "Auslaufende Einsätze" }).first(), 2500);
        },
      },
      {
        start: "/start",
        say: "Dein wichtigstes Werkzeug ist das CEO-Dashboard. Links siehst du den Aktivitätskoeffizienten je Kunde: wie viel in den letzten sieben Tagen dokumentiert wurde – und wie viele Rollen daran beteiligt waren. Rechts steht das Ist- gegenüber dem Zielbild aus den vereinbarten Accountzielen.",
        async run(h) {
          await h.at(0.05);
          await h.click(h.page.locator("header").getByRole("link", { name: "CEO-Dashboard" }), { navigate: true });
          await h.at(0.3);
          await h.highlight(h.page.locator("section", { hasText: "Aktivitätskoeffizient je Kunde" }).first(), 4000);
          await h.at(0.7);
          await h.highlight(h.page.locator("section", { hasText: "Ist- vs. Zielbild" }).first(), 3500);
        },
      },
      {
        start: "/ceo",
        say: "Die Sattelfestigkeit je Kunde kommt aus dem Health-Check. Sortiert wird nach Handlungsbedarf: Kunden mit vielen Einsätzen und niedriger Sattelfestigkeit stehen oben. Ein Klick auf den Kunden zeigt dir die Begründung je Dimension.",
        async run(h) {
          await h.at(0.05);
          const sec = h.page.locator("section", { hasText: "Sattelfestigkeit je Kunde" }).first();
          await h.scrollTo(sec);
          await h.highlight(sec, 4500);
          await h.at(0.7);
          await h.click(sec.getByRole("link", { name: "Beispielkonzern AG (fiktiv)" }), { navigate: true });
        },
      },
      {
        start: "/ceo",
        prepare: async (h) => { await h.scrollTo(h.page.locator("section", { hasText: "Freelancer-Hebel je BD" }).first()); },
        say: "Wie gut der strategische Fokus greift, zeigt der Freelancer-Hebel je BD: offene und neue Freelancer-Chancen, vorgestellte Profile und Kunden ohne Freelancer-Chance. Das sind Zählungen aus dokumentierten Chancen – keine Umsatz- oder Wahrscheinlichkeitswerte.",
        async run(h) {
          await h.at(0.05);
          await h.highlight(h.page.locator("section", { hasText: "Freelancer-Hebel je BD" }).first(), 5000);
          await h.at(0.6);
          await h.highlight(h.page.locator("section", { hasText: "Freelancer-Hebel je BD" }).locator("tbody tr").first(), 3000, 3);
        },
      },
      {
        start: "/ceo",
        prepare: async (h) => { await h.scrollTo(h.page.locator("article", { hasText: "Zusammenarbeit diese Woche" }).first(), "start"); },
        say: "Darunter bekommst du je Kunde eine Karte: die Ziele gegenüber dem Ist-Stand, die wichtigsten Chancen und wer diese Woche zusammengearbeitet hat – Principal, BD und Anker. So erkennst du schnell, wo ein Kunde Aufmerksamkeit braucht.",
        async run(h) {
          await h.at(0.05);
          const card = h.page.locator("article", { hasText: "Zusammenarbeit diese Woche" }).first();
          await h.highlight(card, 3000);
          await h.at(0.25);
          await h.highlight(card.getByText("Ziele vs. Ist-Stand").locator("..").first(), 2500, 4);
          await h.at(0.45);
          await h.highlight(card.getByText("Top-Chancen").locator("..").first(), 2500, 4);
          await h.at(0.65);
          await h.highlight(card.getByText("Zusammenarbeit diese Woche").locator("..").first(), 3000, 4);
        },
      },
      {
        start: "/ziele",
        say: "Ziele vereinbarst du gemeinsam mit dem Principal. Ein Accountziel gilt erst als vereinbart, wenn Principal und CEO zugestimmt haben. Euer Zielgespräch findest du unter „Ziele und Portfolio“ bei den Führungs-Reviews.",
        async run(h) {
          await h.at(0.05);
          const goals = h.page.locator("section", { has: h.page.locator("h2", { hasText: /^Ziele \(/ }) }).first();
          await h.scrollTo(goals);
          await h.highlight(goals, 4000);
          await h.at(0.6);
          const rev = h.page.locator("section", { hasText: "Führungs-Reviews" }).first();
          await h.scrollTo(rev);
          await h.highlight(rev, 3500);
        },
      },
      {
        start: "/vorgehen",
        say: "Den strategischen Fokus – aktuell Wachstum über Freelancer – setzt du unter „Vorgehen“. Und bei Fragen zur Bedienung hilft dir der Assistent, zum Beispiel: Was zeigt das CEO-Dashboard?",
        async run(h) {
          await h.at(0.03);
          await h.highlight(h.page.locator("section", { hasText: "Strategischer Fokus" }).first(), 3000);
          await h.at(0.4);
          await h.assistant("Was zeigt das CEO-Dashboard?");
          await h.wait(4000);
        },
      },
    ],
  },
  PROMO,
];
