import { chromium } from "playwright";
const OUT = "/tmp/claude-0/-home-claude/f5353c21-3e00-5c91-a17f-f05b353dc756/scratchpad/shots";
const [who, ...paths] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto("http://localhost:3200/anmelden", { timeout: 180000 });
const opts = await p.$$eval("select option", (o) => o.map((x) => [x.value, x.textContent]));
await p.selectOption("select", opts.find((o) => o[1].includes(who))[0]);
await Promise.all([p.waitForNavigation({ timeout: 180000 }), p.click("button[type=submit]")]);
for (const path of paths) {
  await p.goto("http://localhost:3200" + path, { timeout: 180000 });
  await p.screenshot({ path: `${OUT}/${who}${path.replace(/[^a-z0-9]+/gi, "_")}.png`, fullPage: true });
}
await b.close();
