// Real-browser layout check for the ORscript bar + trays on a DeepSeek-shaped page.
// Loads the content scripts in manifest order (with chrome-shim.js standing in
// for the extension APIs), opens the settings tray and the templates panel, and
// reports where each one lands relative to the bar. See README.md.
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const fs = require("fs"), path = require("path");
const HERE = __dirname, EXT = process.env.EXT || path.resolve(HERE, "..", "..");
const VH = Number(process.argv[2] || 800);
(async () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const cs = m.content_scripts.find(c => c.matches.some(x => x.includes("deepseek")));
  const exe = await chromium.executablePath();
  const args = chromium.args.concat(["--no-sandbox", "--host-resolver-rules=MAP chat.deepseek.com 127.0.0.1:8443", "--ignore-certificate-errors"]);
  const browser = await puppeteer.launch({ executablePath: exe, args, headless: true, defaultViewport: { width: 1280, height: VH } });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("[pageerror]", String(e.message).slice(0, 200)));
  await page.goto("https://chat.deepseek.com/", { waitUntil: "load" });
  await page.addScriptTag({ content: fs.readFileSync(path.join(HERE, "chrome-shim.js"), "utf8") });
  for (const css of cs.css || []) await page.addStyleTag({ url: "/__ext/" + css });
  for (const js of cs.js) { try { await page.addScriptTag({ url: "/__ext/" + js }); } catch (e) { console.log("script fail", js, e.message); } }
  await page.waitForSelector("#rs-bar", { timeout: 15000 });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await wait(1500);
  const rect = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), cls: e.className }; }, sel);
  const report = async (label, surfaceSel, shot) => {
    const bar = await rect("#rs-bar"), surf = await rect(surfaceSel), card = await rect("#card");
    const where = !surf ? "missing" : surf.bottom <= bar.top ? "ABOVE bar" : surf.top >= bar.bottom ? "BELOW bar" : "OVERLAPS bar";
    console.log(`${label}: ${where}  bar=${bar.top}-${bar.bottom}  surface=${surf && surf.top}-${surf && surf.bottom}  composer=${card.top}-${card.bottom}  flags=${bar.cls.replace(/rs-prov-\S+|tone-\S+/g, "").trim()}`);
    await page.screenshot({ path: path.join(HERE, shot) });
  };
  await page.evaluate(() => document.querySelector("#rs-settings-btn").click()); await wait(900);
  await report("settings tray  ", "#rs-menu", `shot-settings-${VH}.png`);
  await page.evaluate(() => document.querySelector("#rs-settings-btn").click()); await wait(400);
  await page.evaluate(() => document.querySelector("#rs-cards-btn").click()); await wait(900);
  await report("templates panel", "#rs-cards-panel", `shot-templates-${VH}.png`);
  await browser.close();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
