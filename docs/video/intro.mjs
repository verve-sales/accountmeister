// Einführungs-Szene je Video: Ansprache + Verve-Salesmodell als Schaubild, Rolle der Zielgruppe hervorgehoben.
import fs from "node:fs";
import path from "node:path";

const logo = `data:image/png;base64,${fs.readFileSync(path.resolve("public/verve-ai-lockup.png")).toString("base64")}`;

const ROLES = [
  { key: "ANKER", name: "Anker", text: "arbeitet im Kundenteam und erkennt, was gebraucht wird" },
  { key: "BD", name: "BD", text: "macht daraus Chancen und Vermittlungen" },
  { key: "PRINCIPAL", name: "Principal", text: "steuert Portfolio und Ziele, unterstützt die BDs" },
  { key: "SALES_OPS", name: "Sales Operations", text: "bereitet Angebote und Ausschreibungen vor" },
  { key: "CEO", name: "CEO", text: "sieht das Gesamtbild und setzt den Fokus" },
];

function slide(question, highlight) {
  const cards = ROLES.map(
    (r, i) => `<div class="role step ${highlight.includes(r.key) ? "me" : ""}" data-step="1" style="transition-delay:${i * 0.18}s"><div class="rn">${r.name}</div><div class="rt">${r.text}</div>${highlight.includes(r.key) ? '<div class="you">du</div>' : ""}</div>`,
  ).join("");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:1280px;height:720px;background:#F6F6F4;font-family:"DejaVu Sans",sans-serif;color:#161927;overflow:hidden;padding:56px 72px}
  .top{display:flex;align-items:center;gap:18px}
  .top img{height:34px}
  .top span{font-weight:700;font-size:22px}
  h1{font-size:40px;line-height:1.2;margin:36px 0 10px;max-width:1080px}
  .lead{font-size:21px;color:#4B5563;margin-bottom:34px}
  .step{opacity:0;transform:translateY(14px);transition:opacity .6s ease,transform .6s ease}
  .step.on{opacity:1;transform:none}
  .flow{display:flex;align-items:center;gap:12px;font-size:17px;color:#4B5563;margin-bottom:22px}
  .flow b{background:#fff;border:1px solid #D1D5DB;border-radius:999px;padding:6px 14px;color:#161927;font-weight:600}
  .flow i{font-style:normal;color:#55BF36;font-weight:700}
  .roles{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}
  .role{position:relative;background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:18px 16px;min-height:132px}
  .role.me{border:3px solid #55BF36;box-shadow:0 0 0 5px rgba(85,191,54,.15)}
  .rn{font-weight:700;font-size:20px;margin-bottom:8px}
  .rt{font-size:15.5px;line-height:1.35;color:#374151}
  .you{position:absolute;top:-13px;right:14px;background:#55BF36;color:#fff;font-size:13px;font-weight:700;padding:3px 10px;border-radius:999px}
  .gains{display:flex;gap:14px;margin-top:30px}
  .gain{flex:1;background:#161927;color:#fff;border-radius:14px;padding:16px 18px;font-size:17px;line-height:1.35}
  .gain b{color:#7EDB5E;display:block;font-size:15px;margin-bottom:4px;letter-spacing:.02em}
  </style></head><body>
  <div class="top"><img src="${logo}" alt=""><span>Accountmeister</span></div>
  <h1>${question}</h1>
  <p class="lead">Unser Vertriebswerkzeug – aufgebaut auf dem Verve-Salesmodell.</p>
  <div class="flow step" data-step="1"><b>Kunde</b><i>→</i><b>Setup</b><i>→</i><b>Chance</b><i>→</i><b>Vermittlung</b><span style="margin-left:8px">Verve-Experte · Freelancer · Ausschreibung</span></div>
  <div class="roles">${cards}</div>
  <div class="gains">
    <div class="gain step" data-step="2"><b>EIN ORT</b>Alles, was wir über einen Kunden wissen – für alle Beteiligten sichtbar</div>
    <div class="gain step" data-step="3" style="transition-delay:.15s"><b>BELEGT</b>Sachverhalte mit Quelle, Vermutungen getrennt, KI nur als Vorschlag</div>
    <div class="gain step" data-step="4" style="transition-delay:.3s"><b>TRANSPARENT</b>Wo wir stehen, was als Nächstes kommt, wer was beiträgt</div>
  </div>
  </body></html>`;
}

const CORE = (who) =>
  `Der Accountmeister ist das Vertriebswerkzeug von Verve und baut auf unserem Salesmodell auf: ${who} Alles, was wir über einen Kunden wissen, liegt an einem Ort – belegt und für alle Beteiligten sichtbar. Das verbessert die Zusammenarbeit und macht transparent, wo wir stehen und was als Nächstes zu tun ist.`;

export function introScene(role) {
  const cfg = {
    BD: {
      q: "Du möchtest den Accountmeister als BD nutzen?",
      hl: ["BD"],
      say: `Du möchtest den Accountmeister als BD nutzen? Dann ist dieses Video für dich. ${CORE("Anker arbeiten im Kundenteam und erkennen, was gebraucht wird. Du als BD machst daraus Chancen und Vermittlungen. Principals steuern das Portfolio, Sales Operations bereitet vor.")}`,
    },
    PRINCIPAL: {
      q: "Du möchtest den Accountmeister als Principal nutzen?",
      hl: ["PRINCIPAL"],
      say: `Du möchtest den Accountmeister als Principal nutzen? Dann ist dieses Video für dich. ${CORE("Anker erkennen im Kundenteam, was gebraucht wird, BDs machen daraus Chancen und Vermittlungen – und du als Principal steuerst das Portfolio, setzt Ziele und unterstützt die BDs.")}`,
    },
    ANKER_SALESOPS: {
      q: "Du bist Anker im Kundenteam – oder unterstützt als Sales Operations?",
      hl: ["ANKER", "SALES_OPS"],
      say: `Du arbeitest als Anker im Kundenteam oder unterstützt die BDs als Sales Operations? Dann ist dieses Video für dich. ${CORE("Als Anker erkennst du beim Kunden, was gebraucht wird. Der BD macht daraus Chancen und Vermittlungen, und Sales Operations bereitet Angebote und Ausschreibungen vor.")}`,
    },
    CEO: {
      q: "Du möchtest als CEO sehen, wo wir bei unseren Kunden stehen?",
      hl: ["CEO"],
      say: `Du möchtest als CEO sehen, wo Verve bei seinen Kunden steht? Dann ist dieses Video für dich. ${CORE("Anker erkennen im Kundenteam, was gebraucht wird, BDs machen daraus Chancen und Vermittlungen, Principals steuern das Portfolio – und du siehst das Gesamtbild und setzt den strategischen Fokus.")}`,
    },
  }[role];
  return {
    html: slide(cfg.q, cfg.hl),
    say: cfg.say,
    async run(h) {
      await h.at(0.12);
      await h.show(1);
      await h.at(0.6);
      await h.show(2);
      await h.at(0.68);
      await h.show(3);
      await h.at(0.86);
      await h.show(4);
    },
  };
}
