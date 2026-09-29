// Erklärvideos erzeugen: Bildschirmaufnahme (Playwright) + Sprecherstimme (Piper, offline) + Untertitel (ffmpeg/libass).
// Aufruf siehe docs/video/README.md. Nur fiktive Daten (eigene Datenbank verve_video).
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { VIDEOS, SAY_MAP } from "./scripts.mjs";

const BASE = process.env.VIDEO_BASE_URL ?? "http://localhost:3200";
const DB_URL = process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/verve_video";
const VOICE = process.env.PIPER_VOICE; // Pfad zu de_DE-thorsten-high.onnx
const OUT = path.resolve(process.env.VIDEO_OUT ?? "docs/video/out");
const WORK = path.join(OUT, "work");
const W = 1280, H = 720;
const only = process.argv.slice(2);

if (!VOICE || !fs.existsSync(VOICE)) throw new Error("PIPER_VOICE (Pfad zur .onnx-Stimme) fehlt");
fs.mkdirSync(WORK, { recursive: true });

const sh = (cmd, args, input) => execFileSync(cmd, args, { stdio: input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"], input, maxBuffer: 1 << 26 }).toString();
const duration = (f) => parseFloat(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Datenbank
function resetDb() {
  const env = { ...process.env, DATABASE_URL: DB_URL };
  execFileSync("psql", [DB_URL, "-qc", "DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;"], { env, stdio: "ignore" });
  execFileSync("node", ["scripts/migrate.mjs"], { env, stdio: "ignore" });
  execFileSync("npx", ["tsx", "docs/video/video-seed.ts"], { env, stdio: "ignore" });
}
async function lookup(sql, params) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    const r = await c.query(sql, params);
    return r.rows[0] ? Object.values(r.rows[0])[0] : null;
  } finally {
    await c.end();
  }
}
const ids = {
  account: (name) => lookup("select id from accounts where name = $1", [name]),
  setup: (name) => lookup("select id from project_setups where name = $1", [name]),
  chance: (title) => lookup("select id from opportunities where title = $1", [title]),
  review: () => lookup("select id from reviews order by scheduled_for limit 1", []),
  playbook: (name) => lookup("select id from playbooks where name = $1", [name]),
};

// ---------------------------------------------------------------- Ton und Untertitel
function speak(text, file) {
  let spoken = text;
  for (const [k, v] of SAY_MAP) spoken = spoken.replace(k, v);
  sh("python3", ["-m", "piper", "-m", VOICE, "-f", file, "--sentence-silence", "0.35", "--length-scale", "1.08"], spoken);
  return duration(file);
}
const assTime = (t) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = (t % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
};
function chunks(text) {
  const sentences = text.match(/[^.!?]+[.!?]+["“”]?\s*/g) ?? [text];
  const out = [];
  for (const s of sentences.map((x) => x.trim())) {
    if (s.length <= 95) { out.push(s); continue; }
    // lange Sätze an Komma/Gedankenstrich teilen
    const parts = s.split(/(?<=[,–:;])\s+/);
    let cur = "";
    for (const p of parts) {
      if ((cur + " " + p).trim().length > 95 && cur) { out.push(cur.trim()); cur = p; } else cur = `${cur} ${p}`;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}
function writeAss(text, dur, file, lead = 0.25) {
  const cs = chunks(text);
  const total = cs.reduce((a, c) => a + c.length, 0);
  let t = lead;
  const avail = dur - lead;
  const lines = cs.map((c) => {
    const d = (c.length / total) * avail;
    const line = `Dialogue: 0,${assTime(t)},${assTime(t + d)},Sub,,0,0,0,,${c.replace(/\n/g, " ")}`;
    t += d;
    return line;
  });
  fs.writeFileSync(file, `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Sub,DejaVu Sans,26,&H00FFFFFF,&H00FFFFFF,&H00271916,&H40271916,0,0,0,0,100,100,0,0,3,10,0,2,120,120,26,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------- Browser-Helfer
const INIT = `
(() => {
  const css = document.createElement('style');
  css.textContent = '.notice-dev{display:none!important} nextjs-portal{display:none!important} html{scroll-behavior:smooth}' +
    '#vcur{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .65s cubic-bezier(.4,0,.2,1);}' +
    '#vcur svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))}' +
    '.vring{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid #55BF36;z-index:2147483646;pointer-events:none;animation:vr .55s ease-out forwards}' +
    '@keyframes vr{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}' +
    '.vhl{position:absolute;border:3px solid #55BF36;border-radius:10px;box-shadow:0 0 0 4px rgba(85,191,54,.18);z-index:2147483645;pointer-events:none;transition:opacity .4s}';
  const add = () => {
    document.head.appendChild(css);
    const c = document.createElement('div'); c.id = 'vcur';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#161927" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    const p = JSON.parse(sessionStorage.getItem('vcur') || '[640,360]');
    c.style.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px)';
    document.body.appendChild(c);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})();`;

function helpers(page, getD, tBegin) {
  const loc = (target) => (typeof target === "string" ? page.locator(target).first() : target);
  const h = {
    page,
    get D() { return getD(); },
    async at(frac) {
      const due = tBegin() + frac * getD() * 1000;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
    },
    wait: sleep,
    async goto(p) {
      await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 120000 });
      await sleep(300);
    },
    async scrollTo(target, block = "center") {
      const l = loc(target);
      await l.waitFor({ state: "attached", timeout: 20000 });
      await l.evaluate((el, b) => el.scrollIntoView({ behavior: "smooth", block: b }), block);
      await sleep(900);
    },
    async top() {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
      await sleep(700);
    },
    async move(target) {
      const l = loc(target);
      await l.waitFor({ state: "visible", timeout: 20000 });
      const inView = await l.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top > 60 && r.bottom < window.innerHeight - 60; });
      if (!inView) await h.scrollTo(l);
      const b = await l.boundingBox();
      const x = Math.round(b.x + Math.min(b.width / 2, 60)), y = Math.round(b.y + b.height / 2);
      await page.evaluate(([x, y]) => { const c = document.getElementById("vcur"); if (c) c.style.transform = `translate(${x}px,${y}px)`; sessionStorage.setItem("vcur", JSON.stringify([x, y])); }, [x, y]);
      await sleep(700);
      return [x, y];
    },
    async click(target, { navigate = false } = {}) {
      const l = loc(target);
      const [x, y] = await h.move(l);
      await page.evaluate(([x, y]) => { const r = document.createElement("div"); r.className = "vring"; r.style.left = x + "px"; r.style.top = y + "px"; document.body.appendChild(r); setTimeout(() => r.remove(), 700); }, [x, y]);
      await sleep(180);
      if (navigate) await Promise.all([page.waitForLoadState("networkidle"), l.click()]);
      else await l.click();
      await sleep(500);
    },
    async type(target, text, delay = 28) {
      const l = loc(target);
      await h.click(l);
      await l.pressSequentially(text, { delay });
      await sleep(300);
    },
    async select(target, labelOrValue) {
      const l = loc(target);
      await h.move(l);
      await l.selectOption(labelOrValue).catch(() => l.selectOption({ label: labelOrValue }));
      await sleep(500);
    },
    async highlight(target, ms = 2200, pad = 6) {
      const l = loc(target);
      await l.waitFor({ state: "visible", timeout: 20000 });
      const inView = await l.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top > 60 && r.bottom < window.innerHeight - 40; });
      if (!inView) await h.scrollTo(l);
      await l.evaluate((el, [ms, pad]) => {
        const r = el.getBoundingClientRect();
        const d = document.createElement("div");
        d.className = "vhl";
        Object.assign(d.style, { left: r.left + scrollX - pad + "px", top: r.top + scrollY - pad + "px", width: r.width + 2 * pad + "px", height: r.height + 2 * pad + "px" });
        document.body.appendChild(d);
        setTimeout(() => { d.style.opacity = "0"; setTimeout(() => d.remove(), 450); }, ms);
      }, [ms, pad]);
      await sleep(400);
    },
    async assistant(text) {
      const panel = page.locator("#assistent-panel");
      if (!(await panel.isVisible().catch(() => false))) await h.click(page.getByRole("button", { name: "Assistent", exact: true }));
      await page.locator("#assistent-panel textarea").waitFor({ state: "visible" });
      await h.type("#assistent-panel textarea", text, 22);
      await h.click(page.locator("#assistent-panel button[type=submit]"));
      await page.locator("#assistent-panel textarea").waitFor({ state: "visible" });
      await sleep(1500);
    },
    /** Schaubild: Elemente mit data-step=n einblenden */
    async show(n) {
      await page.evaluate((n) => document.querySelectorAll(`[data-step="${n}"]`).forEach((e) => e.classList.add("on")), n);
    },
    ids,
  };
  return h;
}

// ---------------------------------------------------------------- Login
async function storageFor(browser, userLabel) {
  const file = path.join(WORK, `state-${userLabel.replace(/\W+/g, "_")}.json`);
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/anmelden", { timeout: 180000 });
  const opts = await page.$$eval("select option", (o) => o.map((x) => [x.value, x.textContent]));
  const u = opts.find((o) => o[1].includes(userLabel));
  if (!u) throw new Error(`Nutzer ${userLabel} nicht in der Entwicklungsanmeldung`);
  await page.selectOption("select", u[0]);
  await Promise.all([page.waitForNavigation({ timeout: 180000 }), page.click("button[type=submit]")]);
  await ctx.storageState({ path: file });
  await ctx.close();
  return file;
}

// ---------------------------------------------------------------- Karten (Titel/Abspann)
function card(file, title, subtitle, secs) {
  const logo = path.resolve("public/verve-ai-lockup.png");
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%");
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  const bold = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const vf = [
    `[1:v]scale=-1:64[lg]`,
    `[0:v][lg]overlay=(W-w)/2:200[b]`,
    `[b]drawtext=fontfile=${bold}:text='${esc(title)}':fontcolor=0x161927:fontsize=46:x=(w-text_w)/2:y=320,drawtext=fontfile=${font}:text='${esc(subtitle)}':fontcolor=0x4B5563:fontsize=26:x=(w-text_w)/2:y=392,drawbox=x=(iw-120)/2:y=450:w=120:h=5:color=0x55BF36:t=fill,format=yuv420p[v]`,
  ].join(";");
  sh("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=0xF6F6F4:s=${W}x${H}:d=${secs}:r=30`, "-i", logo, "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-filter_complex", vf, "-map", "[v]", "-map", "2:a", "-t", String(secs), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-ar", "22050", "-ac", "1", file]);
}

// ---------------------------------------------------------------- Aufnahme
async function recordVideo(browser, video) {
  console.log(`\n=== ${video.id}: ${video.title}`);
  resetDb();
  const segs = [];
  const titleFile = path.join(WORK, `${video.id}-00-title.mp4`);
  card(titleFile, video.title, video.subtitle, 3.2);
  segs.push(titleFile);
  const states = {};
  for (const [i, scene] of video.scenes.entries()) {
    const n = String(i + 1).padStart(2, "0");
    const wav = path.join(WORK, `${video.id}-${n}.wav`);
    const D = speak(scene.say, wav);
    const tail = 0.9;
    const user = scene.user ?? video.user;
    states[user] ??= await storageFor(browser, user);
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, storageState: states[user], recordVideo: { dir: WORK, size: { width: W, height: H } } });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    const tPage = Date.now();
    let begin = 0;
    const h = helpers(page, () => D, () => begin);
    if (scene.html) {
      await page.setContent(scene.html, { waitUntil: "load" });
      await sleep(300);
    } else await h.goto(typeof scene.start === "function" ? await scene.start(h) : scene.start);
    if (scene.prepare) await scene.prepare(h).catch((e) => console.error(`  Vorbereitung: ${e.message.split("\n")[0]}`));
    await sleep(400);
    begin = Date.now();
    const offset = (begin - tPage) / 1000;
    try {
      await scene.run(h);
    } catch (e) {
      console.error(`  Szene ${n}: ${e.message.split("\n")[0]}`);
      await page.screenshot({ path: path.join(WORK, `${video.id}-${n}-error.png`) });
    }
    const rest = begin + (D + tail) * 1000 - Date.now();
    if (rest > 0) await sleep(rest);
    const overrun = (Date.now() - begin) / 1000 - (D + tail);
    const vpath = await page.video().path();
    await ctx.close();
    const len = D + tail + Math.max(0, overrun);
    const ass = path.join(WORK, `${video.id}-${n}.ass`);
    writeAss(scene.say, D, ass);
    const out = path.join(WORK, `${video.id}-${n}.mp4`);
    sh("ffmpeg", ["-y", "-ss", offset.toFixed(2), "-i", vpath, "-i", wav, "-filter_complex", `[0:v]fps=30,scale=${W}:${H},ass=${ass},format=yuv420p[v];[1:a]apad[a]`, "-map", "[v]", "-map", "[a]", "-t", len.toFixed(2), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-ar", "22050", "-ac", "1", out]);
    fs.rmSync(vpath, { force: true });
    console.log(`  Szene ${n}: ${len.toFixed(1)} s${overrun > 0.2 ? ` (Aktionen ${overrun.toFixed(1)} s länger als Sprache)` : ""}`);
    segs.push(out);
  }
  const endFile = path.join(WORK, `${video.id}-99-end.mp4`);
  card(endFile, "Fragen zur Bedienung?", "Assistent fragen oder Seite „Hilfe“ öffnen", 3);
  segs.push(endFile);
  const list = path.join(WORK, `${video.id}-list.txt`);
  fs.writeFileSync(list, segs.map((s) => `file '${s}'`).join("\n"));
  const final = path.join(OUT, `${video.file}.mp4`);
  sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", final]);
  console.log(`  → ${final} (${duration(final).toFixed(0)} s)`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
try {
  // Seiten einmal vorwärmen (Entwicklungsserver kompiliert beim ersten Aufruf)
  if (!process.env.SKIP_WARMUP) {
    resetDb();
    const st = await storageFor(browser, "Petra");
    const ctx = await browser.newContext({ storageState: st });
    const p = await ctx.newPage();
    const acc = await ids.account("Beispielkonzern AG (fiktiv)");
    const warm = ["/start", "/ceo", "/kunden", `/kunden/${acc}`, `/kunden/${acc}/health`, `/setups/${await ids.setup("Migrationsteam")}`, `/bedarfe/${await ids.chance("Testmanagement für die Migration")}`, "/meine-arbeit", "/ziele", "/vorgehen", "/weeklys", "/hilfe", `/weeklys/${await ids.review()}`, `/vorgehen/${await ids.playbook("Altkunden-Reaktivierung")}`];
    for (const w of warm) await p.goto(BASE + w, { timeout: 180000 }).catch(() => {});
    await ctx.close();
  }
  for (const v of VIDEOS) if (!only.length || only.includes(v.id)) await recordVideo(browser, v);
} finally {
  await browser.close();
}
