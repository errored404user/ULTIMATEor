// Layout probe for the on-page settings tray (overlay.css only — no main.js):
// renders the real row markup (.rs-tip-opt / .rs-tgl-row / .rs-site-opt /
// .rs-mcp-item / .rs-sec-label) at the tray's 300 px width in headless
// Chromium and counts the line boxes of every label. A label that wraps to
// more lines than it has words is being squeezed letter-by-letter — the
// 2.12.0 regression this guards against. Optional second arg = an older
// overlay.css to compare with.
//   node tools/popup-shots/tray-wrap.js [overlay.css] [old-overlay.css]
const chromium = require("@sparticuz/chromium").default;
const puppeteer = require("puppeteer-core");
const fs = require("fs"), path = require("path");
const EXT = path.resolve(__dirname, "..", "..");
const files = [["NEW", process.argv[2] || path.join(EXT, "overlay.css")]];
if (process.argv[3]) files.unshift(["OLD", process.argv[3]]);
const ROWS = [
  ["#a > span:first-child", "Getting-started checklist", `<button class="rs-tip-opt rs-tip-star" id="a"><span>Getting-started checklist</span><span class="rs-tip-sub">live 4-step setup — agent app, Studio, place, Start</span></button>`],
  ["#b > span:first-child", "Read the Tutorial", `<button class="rs-tip-opt" id="b"><span>Read the Tutorial</span><span class="rs-tip-sub">plain-language walkthrough — always up to date</span></button>`],
  ["#c > span:first-child", "Çalışma günlüğü ve hata görüntüleyici", `<button class="rs-tip-opt" id="c"><span>Çalışma günlüğü ve hata görüntüleyici</span><span class="rs-tip-sub">kayıt · Türkçe karakter testi</span></button>`],
  [".rs-tgl-name", "Auto-fix playtest errors", `<div class="rs-tgl-row" data-mode="autofix" role="switch" tabindex="0"><span class="rs-tgl-info"><span class="rs-tgl-name">Auto-fix playtest errors</span><span class="rs-tgl-sub">Watches Output during Play and sends new errors to the AI.</span></span><span class="rs-tgl on"></span></div>`],
  ["#d .rs-site-name > span:first-child", "DeepSeek chat (web)", `<button class="rs-site-opt" data-u="x" id="d"><span class="rs-site-name"><span>DeepSeek chat (web)</span><span class="rs-site-sub">chat.deepseek.com</span></span><span class="rs-site-go">→</span></button>`],
  ["#e", "blender-mcp local server", `<div class="rs-mcp-item"><span class="rs-mcp-health rs-mcp-health-ok"></span><div class="rs-mcp-info"><span class="rs-mcp-name" id="e">blender-mcp local server</span><span class="rs-mcp-url">npx -y @some/very-long-mcp-server-name --flag</span></div><button class="rs-mcp-remove">✕</button></div>`],
  [".rs-sec-label > span:first-child", "Reasoning effort", ``],
];
const page = (css, theme) => `<!doctype html><html data-theme="aqua"${theme ? ` data-rs-theme="${theme}"` : ""}><head><meta charset="utf-8"><style>${css}</style>
<style>body{margin:0;background:#111;padding:20px}#rs-menu{display:block!important;position:static!important;transform:none!important;opacity:1!important}</style></head>
<body><div id="rs-root"><div id="rs-menu"><section class="rs-menu-sec"><div class="rs-sec-label"><span>Reasoning effort</span><span class="rs-sec-state">Medium · balanced · +1</span></div>${ROWS.map((r) => r[2]).join("\n")}</section></div></div></body></html>`;
(async () => {
  const exe = await chromium.executablePath();
  const browser = await puppeteer.launch({ executablePath: exe, args: chromium.args.concat(["--no-sandbox"]), headless: true, defaultViewport: { width: 420, height: 760 } });
  let bad = 0;
  for (const [tag, file] of files) {
    const css = fs.readFileSync(file, "utf8");
    for (const theme of ["", "night", "void"]) {
      const p = await browser.newPage();
      await p.setContent(page(css, theme), { waitUntil: "load" });
      const r = await p.evaluate((rows) => {
        const lines = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); return new Set([...rg.getClientRects()].map((x) => Math.round(x.top))).size; };
        return rows.map(([sel, text]) => { const el = document.querySelector(sel); return el ? { sel, text, lines: lines(el), words: text.split(/\s+/).length, width: Math.round(el.getBoundingClientRect().width), left: Math.round(el.getBoundingClientRect().left) } : { sel, missing: true }; });
      }, ROWS.map((r) => [r[0], r[1]]));
      const menuW = await p.evaluate(() => Math.round(document.getElementById("rs-menu").getBoundingClientRect().width));
      const label = r[r.length - 1];
      for (const x of r) {
        const squeezed = !x.missing && x.lines > x.words;
        if (squeezed && tag === "NEW") bad++;
        console.log(`${tag} ${(theme || "base").padEnd(5)} menu=${menuW}px  ${squeezed ? "SQUEEZED" : "ok      "} ${String(x.lines).padStart(2)} line(s) / ${x.words} word(s)  w=${x.width}  ${x.text}`);
      }
      if (label && !label.missing && label.left > 80) { console.log(`${tag} ${(theme || "base").padEnd(5)} section label pushed to x=${label.left} (should hug the left edge)`); if (tag === "NEW") bad++; }
      await p.screenshot({ path: path.join("/tmp", `tray-${tag}-${theme || "base"}.png`) });
      await p.close();
    }
  }
  await browser.close();
  console.log(bad ? `tray-wrap: ${bad} problem(s) in NEW` : "tray-wrap: 0 problems in NEW");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("ERR", e && e.stack || e); process.exit(1); });
