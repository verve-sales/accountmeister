// Werbevideo (intern): Problem → Lösung → Demo → Nutzen → Aufruf. ~5 Minuten.
import fs from "node:fs";
import path from "node:path";
import { slide as modelSlide } from "./intro.mjs";

const logo = `data:image/png;base64,${fs.readFileSync(path.resolve("public/verve-ai-lockup.png")).toString("base64")}`;
const PAGE = fs.readFileSync(path.resolve("tests/fixtures/account-page.md"), "utf8");
const ACC = "Beispielkonzern AG (fiktiv)";
const NEW_ACC = "Nordbahn Logistik AG (fiktiv)";

const BASE_CSS = `*{box-sizing:border-box;margin:0}
body{width:1280px;height:720px;background:#F6F6F4;font-family:"DejaVu Sans",sans-serif;color:#161927;overflow:hidden;padding:56px 72px}
.top{display:flex;align-items:center;gap:18px}.top img{height:34px}.top span{font-weight:700;font-size:22px}
h1{font-size:44px;line-height:1.18;margin:34px 0 12px;max-width:1100px}
.lead{font-size:22px;color:#4B5563;margin-bottom:30px}
.step{opacity:0;transform:translateY(14px);transition:opacity .6s ease,transform .6s ease}.step.on{opacity:1;transform:none}`;

function cardsSlide({ kicker, title, lead, cards, dark = false }) {
  const items = cards
    .map((c, i) => `<div class="c step" data-step="${i + 1}"><div class="ic">${c.icon}</div><div class="ct">${c.title}</div><div class="cx">${c.text}</div></div>`)
    .join("");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${BASE_CSS}
  .k{color:#55BF36;font-weight:700;letter-spacing:.06em;font-size:15px;margin-top:30px}
  h1{margin-top:8px}
  .grid{display:grid;grid-template-columns:repeat(${Math.min(cards.length, 4)},1fr);gap:18px;margin-top:44px}
  .c{background:${dark ? "#161927" : "#fff"};color:${dark ? "#fff" : "#161927"};border:1px solid ${dark ? "#161927" : "#E5E7EB"};border-radius:16px;padding:26px 22px 28px;min-height:250px}
  .ic{font-size:40px;margin-bottom:14px}
  .ct{font-weight:700;font-size:23px;margin-bottom:10px;${dark ? "color:#7EDB5E;" : ""}}
  .cx{font-size:18px;line-height:1.45;color:${dark ? "#E5E7EB" : "#374151"}}
  </style></head><body>
  <div class="top"><img src="${logo}" alt=""><span>Accountmeister</span></div>
  <div class="k">${kicker}</div>
  <h1>${title}</h1>
  ${lead ? `<p class="lead">${lead}</p>` : ""}
  <div class="grid">${items}</div>
  </body></html>`;
}

function reveal(fracs) {
  return async (h) => {
    for (const [i, f] of fracs.entries()) {
      await h.at(f);
      await h.show(i + 1);
    }
  };
}

export const PROMO = {
  id: "werbung",
  file: "Accountmeister-Werbevideo",
  title: "Accountmeister",
  subtitle: "Gemeinsam mehr aus unseren Kunden machen",
  user: "David",
  lengthScale: 1.12,
  end: { title: "Accountmeister – jetzt loslegen", subtitle: "Ersten Kunden anlegen oder die Notion-Seite in den Assistenten einfügen", secs: 4 },
  scenes: [
    {
      html: cardsSlide({
        kicker: "KENNST DU DAS?",
        title: "Unser Kundenwissen ist überall – nur nicht an einem Ort.",
        cards: [
          { icon: "📄", title: "Verstreut", text: "Notion-Seiten, Mails, Excel-Listen und vieles nur im Kopf." },
          { icon: "⏰", title: "Zu spät", text: "Ein Einsatz läuft aus – die Verlängerung fällt erst auf, wenn es eng wird." },
          { icon: "🔇", title: "Verloren", text: "Der Anker hört von einem neuen Bedarf – der BD erfährt es nie." },
          { icon: "❓", title: "Unklar", text: "Wo stehen wir beim Kunden? Dafür muss man fünf Leute fragen." },
        ],
      }),
      say: "Kennst du das? Das Wissen über unsere Kunden steckt in Notion-Seiten, Mails, Excel-Listen und in vielen Köpfen. Ein Einsatz läuft aus, und die Verlängerung fällt erst auf, wenn es eng wird. Ein Anker hört beim Kunden von einem neuen Bedarf, aber der BD erfährt es nie. Und wer wissen will, wo wir bei einem Kunden stehen, muss erst einmal fünf Leute fragen.",
      run: reveal([0.2, 0.4, 0.6, 0.8]),
    },
    {
      html: modelSlide("Der Accountmeister: ein Ort für alles, was wir über unsere Kunden wissen.", []),
      say: "Dafür gibt es den Accountmeister, unser Vertriebswerkzeug, gebaut auf dem Verve-Salesmodell. Anker erkennen im Kundenteam, was gebraucht wird. BDs machen daraus Chancen und Vermittlungen. Principals steuern das Portfolio, Sales Operations bereitet vor, und der CEO setzt den Fokus. Alles, was wir über einen Kunden wissen, liegt an einem Ort – belegt und für alle Beteiligten sichtbar.",
      async run(h) {
        await h.at(0.15);
        await h.show(1);
        await h.at(0.72);
        await h.show(2);
        await h.at(0.8);
        await h.show(3);
        await h.at(0.88);
        await h.show(4);
      },
    },
    {
      start: "/start",
      say: "Der Tag beginnt auf der Startseite. Du siehst sofort, ob irgendwo ein SOS offen ist, wie viele Chancen auf welcher Stufe stehen, welche Kunden noch Angaben brauchen und welche Einsätze bald auslaufen. Kein Suchen, kein Nachfragen – der Accountmeister sagt dir, was diese Woche dran ist.",
      async run(h) {
        await h.at(0.12);
        await h.highlight(h.page.locator("section", { hasText: "SOS –" }).first(), 3000);
        await h.at(0.3);
        await h.highlight(h.page.locator("section", { hasText: "Wo stehen wir insgesamt?" }).first(), 2800);
        await h.at(0.5);
        await h.highlight(h.page.locator("section", { hasText: "Health-Check: Accountmeister braucht" }).first(), 2800);
        await h.at(0.68);
        await h.highlight(h.page.locator("section", { hasText: "Auslaufende Einsätze" }).first(), 2800);
        await h.at(0.86);
        await h.highlight(h.page.locator("section", { hasText: "Diese Woche dran" }).first(), 2500);
      },
    },
    {
      start: "/kunden",
      say: "Der schnellste Weg ins Tool ist der Assistent. Wir fügen einfach eine bestehende Account-Seite ein – so, wie sie heute in Notion liegt. Der Assistent erkennt Kundenagenda, Stakeholder, Beschaffungsweg, laufende Einsätze, Risiken und Ideen für Kurzangebote und schlägt alles als Karten vor. Jede Karte mit der wörtlichen Textstelle als Beleg.",
      async run(h) {
        await h.at(0.05);
        await h.click(h.page.getByRole("button", { name: "Assistent", exact: true }));
        await h.paste("#assistent-panel textarea", PAGE);
        await h.at(0.2);
        await h.click(h.page.locator("#assistent-panel button[type=submit]"));
        await h.page.getByRole("button", { name: /^Alle \d+ übernehmen$/ }).waitFor({ timeout: 60000 });
        await h.at(0.45);
        const cards = h.page.locator("#assistent-panel li");
        for (const [n, f] of [[3, 0.5], [8, 0.62], [12, 0.74], [15, 0.86]]) {
          await h.at(f);
          const c = cards.nth(n);
          if (await c.count()) await h.scrollTo(c);
        }
      },
    },
    {
      start: "/kunden",
      prepare: async (h) => {
        await h.page.getByRole("button", { name: "Assistent", exact: true }).click();
        await h.page.getByRole("button", { name: /^Alle \d+ übernehmen$/ }).waitFor({ timeout: 30000 });
        await h.page.getByRole("button", { name: /^Alle \d+ übernehmen$/ }).evaluate((el) => el.scrollIntoView({ block: "center" }));
      },
      say: "Ein Klick auf „Alle übernehmen“ – und der Kunde steht: mit Setup, Personen, Kundenagenda, Beschaffungsweg und laufendem Einsatz. Nichts entsteht ohne deine Bestätigung, und die KI erfindet nichts dazu. Aus einer Stunde Abtippen werden zwei Minuten.",
      async run(h) {
        await h.at(0.08);
        await h.click(h.page.getByRole("button", { name: /^Alle \d+ übernehmen$/ }));
        await h.page.waitForURL(/\/setups\//, { timeout: 60000 });
        await h.wait(1200);
        await h.at(0.55);
        await h.click(h.page.getByRole("button", { name: "Assistent schließen" }));
        await h.click(h.page.locator("main a, a").filter({ hasText: NEW_ACC }).first(), { navigate: true });
        await h.at(0.8);
        await h.highlight(h.page.locator("section", { hasText: "Wo stehen wir? – je Chance" }).first(), 2500);
      },
    },
    {
      start: async (h) => `/kunden/${await h.ids.account(NEW_ACC)}`,
      prepare: async (h) => { await h.scrollTo(h.page.locator("#agenda"), "start"); },
      say: "Auf der Kundenseite siehst du, was den Kunden treibt: seine Prioritäten, Schlüssel-Initiativen und Herausforderungen – in seinen Worten. Läuft zum Beispiel ein Toolvertrag Ende 2026 aus, erinnert dich der Accountmeister rechtzeitig. Und jede Chance zeigt, auf welche Initiative sie einzahlt.",
      async run(h) {
        await h.at(0.05);
        await h.highlight("#agenda", 3500);
        await h.at(0.4);
        await h.highlight(h.page.getByText("Tool-Vertrag läuft Ende 2026 aus").first(), 3500, 4);
        await h.at(0.75);
        await h.highlight(h.page.locator("section", { hasText: "Einkauf & Beschaffung" }).first(), 2500);
      },
    },
    {
      start: async (h) => `/bedarfe/${await h.ids.chance("Testmanagement für die Migration")}`,
      say: "Jede Chance hat ihren eigenen Fortschritt – von antizipiert bis beauftragt. Bestätigt wird nur mit Beleg, als vorgestellt gilt ein Angebot nur mit echtem Vorstellungsereignis. So weiß jeder, was wirklich stimmt – und was noch Vermutung ist.",
      async run(h) {
        await h.at(0.08);
        await h.highlight(h.page.locator("div, ol").filter({ hasText: /Antizipiert.*In Klärung.*Bestätigt/ }).filter({ has: h.page.getByRole("button", { name: "In Klärung nehmen" }) }).last(), 3000);
        await h.at(0.3);
        await h.click(h.page.getByRole("button", { name: "In Klärung nehmen" }).first(), { navigate: true });
        await h.at(0.55);
        await h.type("#confText", "Frau Brandt hat den Bedarf telefonisch bestätigt.");
        await h.at(0.82);
        await h.click(h.page.getByRole("button", { name: "Chance bestätigen" }), { navigate: true });
        await h.top();
      },
    },
    {
      start: async (h) => `/bedarfe/${await h.ids.chance("Rahmenvertrag IT-Dienstleistungen 2027")}`,
      prepare: async (h) => { await h.scrollTo(h.page.locator("section", { hasText: "Vorgehen (" }).first(), "start"); },
      say: "Für wiederkehrende Situationen gibt es Vorgehensmuster: Altkunden-Reaktivierung, Verlängerung vor Einsatzende oder Ausschreibungen. Jeder Schritt wird zur Aktion für die richtige Person – Vorbereitung landet direkt bei Sales Operations. Und der Schritt-Assistent entwirft dir Mail, Gesprächsleitfaden oder Pitch.",
      async run(h) {
        await h.at(0.05);
        await h.highlight(h.page.locator("section", { hasText: "Vorgehen (" }).first(), 3500);
        await h.at(0.4);
        await h.highlight(h.page.getByText(/Aktueller Schritt 2\/4/).first(), 3000);
        await h.at(0.68);
        await h.click(h.page.getByRole("button", { name: "Entwürfe erstellen" }).first(), { navigate: true });
      },
    },
    {
      user: "Petra",
      start: "/vorgehen",
      say: "Und der Accountmeister zieht in eine Richtung. Der strategische Fokus – aktuell Wachstum über Freelancer – fließt in alle KI-Agenten ein. Bei jeder neuen Chance fragt eine Standardaufgabe, ob das Team weitere Spezialistenrollen braucht. Und die Kachel „Freelancer-Hebel“ zeigt jedem BD, wie gut das gelingt.",
      async run(h) {
        await h.at(0.08);
        await h.highlight(h.page.locator("section", { hasText: "Strategischer Fokus" }).first(), 4500);
        await h.at(0.5);
        await h.goto("/start");
        await h.highlight(h.page.locator("section", { hasText: "Freelancer-Hebel" }).first(), 4000);
      },
    },
    {
      start: async (h) => `/kunden/${await h.ids.account(ACC)}/health`,
      say: "Wie sicher sitzen wir im Sattel? Der Health-Check bewertet jeden Kunden mit transparenten Regeln – Einsätze, Beziehungen, Zufriedenheit, Listung, Pipeline und Aktivität. Und läuft ein Einsatz aus, startet die Verlängerungsregel acht Wochen vorher automatisch das passende Vorgehen.",
      async run(h) {
        await h.at(0.05);
        await h.highlight(h.page.locator("section").first(), 4500);
        await h.at(0.62);
        const eins = h.page.locator("section", { has: h.page.locator("h2", { hasText: /^Einsätze/ }) }).first();
        await h.scrollTo(eins);
        await h.highlight(eins, 3500);
      },
    },
    {
      start: async (h) => `/kunden/${await h.ids.account(ACC)}`,
      prepare: async (h) => { await h.scrollTo("#sos", "start"); },
      say: "Wird es eng, löst jeder aus dem Kundenteam ein SOS aus – auch der Anker. Es landet sofort rot bei BD und Principal, zählt im Health-Check als Risiko und bleibt offen, bis die Lösung dokumentiert ist. So bleibt niemand mit einem Problem allein.",
      async run(h) {
        await h.at(0.05);
        await h.highlight("#sos", 4000);
        await h.at(0.55);
        const b = h.page.getByRole("button", { name: "Ich kümmere mich" }).first();
        if (await b.count()) await h.click(b, { navigate: true });
      },
    },
    {
      user: "Nina",
      start: "/meine-arbeit",
      say: "Auch für Anker ist es einfach. Unter „Meine Arbeit“ liegt, was gerade bei dir ist: deine Setups, Aktionen und die nächsten Weeklys. Im Weekly bestätigt ihr gemeinsam den Wochenstand – und das Tool zeigt, was sich seit dem letzten Mal geändert hat.",
      async run(h) {
        await h.at(0.1);
        await h.highlight(h.page.locator("section", { hasText: "Meine Setups" }).first(), 3000);
        await h.at(0.35);
        const w = h.page.locator("section", { hasText: "Nächste Weeklys" }).first();
        await h.highlight(w, 2500);
        await h.at(0.55);
        await h.click(w.getByRole("link").first(), { navigate: true });
      },
    },
    {
      user: "Clemens",
      start: "/ceo",
      say: "Für die Führung entsteht das Gesamtbild ganz nebenbei: Aktivität je Kunde, Ist gegenüber dem Zielbild, Sattelfestigkeit und der Freelancer-Hebel je BD. Alles Zählungen aus dokumentierten Fakten – keine geschätzten Umsätze und keine Bauchgefühl-Scores.",
      async run(h) {
        await h.at(0.1);
        await h.highlight(h.page.locator("section", { hasText: "Aktivitätskoeffizient je Kunde" }).first(), 2800);
        await h.at(0.3);
        await h.highlight(h.page.locator("section", { hasText: "Ist- vs. Zielbild" }).first(), 2800);
        await h.at(0.5);
        const s = h.page.locator("section", { hasText: "Sattelfestigkeit je Kunde" }).first();
        await h.scrollTo(s);
        await h.highlight(s, 2800);
        await h.at(0.72);
        const f = h.page.locator("section", { hasText: "Freelancer-Hebel je BD" }).first();
        await h.scrollTo(f);
        await h.highlight(f, 2800);
      },
    },
    {
      start: "/hilfe",
      say: "Und wenn du einmal nicht weiterweißt: Der Assistent kennt Handbuch, Funktionen und deine Rechte. Frag ihn einfach – zum Beispiel, was ein SOS ist und wer es auslösen darf.",
      async run(h) {
        await h.at(0.05);
        await h.highlight(h.page.locator("section", { hasText: "Deine Rollen und Einstellungen" }).first(), 2500);
        await h.at(0.3);
        await h.assistant("Was ist ein SOS und wer darf es auslösen?");
        await h.wait(3500);
      },
    },
    {
      html: cardsSlide({
        kicker: "DAS BRINGT UNS DER ACCOUNTMEISTER",
        title: "Weniger suchen. Nichts verpassen. Mehr Chancen.",
        dark: true,
        cards: [
          { icon: "⚡", title: "Schneller", text: "Gespräch erzählen oder Seite einfügen – der Assistent erfasst, du bestätigst." },
          { icon: "🔔", title: "Rechtzeitig", text: "Verlängerungen, Kundeninitiativen und SOS melden sich von selbst." },
          { icon: "📈", title: "Mehr Chancen", text: "Freelancer-Hebel und Kurzangebote machen aus Wissen neue Vermittlungen." },
          { icon: "🤝", title: "Gemeinsam", text: "Eine Sicht für Anker, BD, Sales Ops und Führung – belegt statt vermutet." },
        ],
      }),
      say: "Das bringt uns der Accountmeister: weniger Suchen und Abtippen, keine verpassten Verlängerungen, mehr Chancen – gerade über Freelancer – und eine gemeinsame Sicht für Anker, BD und Führung. Probier es aus: Leg deinen ersten Kunden an, oder füge einfach deine Notion-Seite in den Assistenten ein. Der Accountmeister – gemeinsam mehr aus unseren Kunden machen.",
      run: reveal([0.12, 0.25, 0.38, 0.52]),
    },
  ],
};
