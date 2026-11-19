// Renders popup.html (and welcome.html) in headless Chromium (tray rows: tray-wrap.js) with chrome-shim.js
// standing in for the extension APIs, and writes PNGs to ui/snapshots/.
// Dev tool: node tools/popup-shots/shoot.js [outDir]
//   needs: npm i @sparticuz/chromium puppeteer-core  (+ LD_LIBRARY_PATH to al2023 libs on Debian)
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const fs = require("fs"), path = require("path");
const HERE = __dirname, EXT = path.resolve(HERE, "..", "..");
const OUT = path.resolve(process.argv[2] || path.join(EXT, "ui", "snapshots"));
fs.mkdirSync(OUT, { recursive: true });
const SCENARIOS = require("./scenarios.js");
(async () => {
  const exe = await chromium.executablePath();
  const browser = await puppeteer.launch({ executablePath: exe, args: chromium.args.concat(["--no-sandbox", "--allow-file-access-from-files"]), headless: true, defaultViewport: { width: 420, height: 600, deviceScaleFactor: 1 } });
  const report = [];
  for (const sc of SCENARIOS) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });
    await page.setViewport({ width: sc.width || 420, height: sc.height || 600, deviceScaleFactor: sc.scale || 1 });
    await page.evaluateOnNewDocument((shot) => { window.__SHOT = shot; }, sc.shot || {});
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(HERE, "chrome-shim.js"), "utf8"));
    await page.goto("file://" + path.join(EXT, sc.file || "popup.html"), { waitUntil: "load" });
    if (sc.fullPage) await page.addStyleTag({ content: "body{height:auto!important;overflow:visible!important} main{overflow:visible!important} .ts-view{position:static!important;overflow:visible!important}" });
    await new Promise((r) => setTimeout(r, 350));
    if (sc.steps) for (const st of sc.steps) { await page.evaluate(st); await new Promise((r) => setTimeout(r, 250)); }
    const metrics = await page.evaluate(() => {
      // Overflow audit: any element whose text is clipped horizontally, or that
      // leaks outside the document width.
      const docW = document.documentElement.clientWidth;
      const bad = [];
      for (const el of document.querySelectorAll("body *")) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.right > docW + 1 && cs.position !== "fixed") bad.push("leak:" + (el.id || el.className || el.tagName).toString().slice(0, 40) + " right=" + Math.round(r.right));
        if (el.scrollWidth > el.clientWidth + 2 && /hidden|clip/.test(cs.overflowX) && cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.textContent.trim()) bad.push("clip:" + (el.id || el.className || el.tagName).toString().slice(0, 40) + " '" + el.textContent.trim().slice(0, 30) + "'");
      }
      return { height: document.documentElement.scrollHeight, bad: bad.slice(0, 20) };
    });
    const file = path.join(OUT, sc.name + ".png");
    await page.screenshot({ path: file, fullPage: !!sc.fullPage });
    const line = `${sc.name}: ${metrics.height}px tall · ${metrics.bad.length} layout issue(s) · ${errors.length} page error(s)` + (metrics.bad.length ? "\n    " + metrics.bad.join("\n    ") : "") + (errors.length ? "\n    " + errors.join("\n    ") : "");
    console.log(line); report.push(line);
    await page.close();
  }
  fs.writeFileSync(path.join(OUT, "report.txt"), report.join("\n") + "\n");
  await browser.close();
})().catch((e) => { console.error("ERR", e && e.stack || e); process.exit(1); });
