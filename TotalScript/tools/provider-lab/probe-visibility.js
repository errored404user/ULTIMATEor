// Visibility probe: does the bar stay on screen on a late-mounting composer and on a non-AI route?
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const fs = require("fs"), path = require("path");
const EXT = path.resolve(process.env.EXT || path.join(__dirname, "..", "..")), HOST = "www.notion.so";
const URL_PATH = process.env.URL_PATH || "/ai?late=5000";
(async () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const cs = m.content_scripts.find(c => c.matches.includes("https://www.notion.so/*") && c.world !== "MAIN");
  const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args.concat(["--no-sandbox", `--host-resolver-rules=MAP ${HOST} 127.0.0.1:8443`, "--ignore-certificate-errors"]), headless: true, defaultViewport: { width: 1280, height: 800 } });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("[pageerror]", String(e.message).slice(0, 300)));
  await page.goto(`https://${HOST}${URL_PATH}`, { waitUntil: "load" });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, "studio-shim.js"), "utf8") });
  for (const css of cs.css || []) await page.addStyleTag({ url: "/__ext/" + css });
  for (const js of cs.js) await page.addScriptTag({ url: "/__ext/" + js });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const snap = () => page.evaluate(() => { const b = document.querySelector("#rs-bar"); if (!b) return "NO BAR"; const r = b.getBoundingClientRect(); return { display: getComputedStyle(b).display, top: Math.round(r.top), h: Math.round(r.height), left: Math.round(r.left), w: Math.round(r.width), cls: b.className.replace(/rs-prov-notion |tone-\w+ /g, ""), state: (document.querySelector("#rs-bar .rs-state-txt") || {}).textContent, action: (document.querySelector("#rs-action") || {}).textContent, actionDisabled: (document.querySelector("#rs-action") || {}).disabled, composer: !!document.getElementById("composer") && document.getElementById("composer").isConnected }; });
  for (const t of [1500, 3500, 7500, 9500]) { await wait(t === 1500 ? 1500 : 2000); console.log(`t≈${t}ms`, JSON.stringify(await snap())); }
  await page.screenshot({ path: path.join(__dirname, "shot-visibility.png") });
  await browser.close();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
