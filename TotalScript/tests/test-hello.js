// 1.75.0 — Hello page after install, shown exactly once.
// background.js opens welcome.html from onInstalled when reason === "install"
// and the rsHelloShown flag is not set; the flag is written before the tab
// opens. Updates / browser updates / a second onInstalled never reopen it.
const fs = require("fs");
const path = require("path");
const ROOT = process.env.TOTALSCRIPT_ROOT || path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const bg = read("background.js");
const html = read("welcome.html");
const js = read("welcome.js");
const manifest = JSON.parse(read("manifest.json"));
const results = []; const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  — " + extra : "")); if (!cond) process.exitCode = 1; };

// ── wiring pins ──
ok("background: onInstalled still reconnects AND calls maybeShowHello(details)", bg.includes('chrome.runtime.onInstalled.addListener((details) => { connect(); maybeShowHello(details); });') && !bg.includes("onInstalled.addListener(connect)"));
ok("background: hello only on reason install, guarded by rsHelloShown, flag written BEFORE the tab opens", /if \(!details \|\| details\.reason !== "install"\) return false;/.test(bg) && /const got = await chrome\.storage\.local\.get\("rsHelloShown"\);\s*if \(got && got\.rsHelloShown\) return false;\s*await chrome\.storage\.local\.set\(\{ rsHelloShown: Date\.now\(\) \}\);\s*await chrome\.tabs\.create\(\{ url: chrome\.runtime\.getURL\(HELLO_PAGE\) \}\);/.test(bg) && bg.includes('const HELLO_PAGE = "welcome.html";'));
ok("welcome.html: hello headline, four steps, actions, no inline script (MV3 CSP), loads welcome.js", /<h1 id="hello-title">Hello! <span>TotalScript is installed\.<\/span><\/h1>/.test(html) && (html.match(/<li><i>\d<\/i>/g) || []).length === 4 && html.includes('id="open-ai"') && html.includes('id="open-discord"') && html.includes('id="close"') && !/<script>[\s\S]*?<\/script>/.test(html) && !/\son[a-z]+="/.test(html) && html.includes('<script src="welcome.js"></script>'));
ok("welcome.html: says it is shown once", /shown once, right after installation/.test(html));
ok("welcome.js: buttons open the AI chat / Discord via chrome.tabs.create, Close closes the tab", js.includes('const DEFAULT_AI_URL = "https://chat.deepseek.com/";') && js.includes('const DISCORD_URL = "https://discord.gg/YqVZaZYuy";') && js.includes('document.getElementById("open-ai")?.addEventListener("click", () => openTab(DEFAULT_AI_URL));') && js.includes('document.getElementById("open-discord")?.addEventListener("click", () => openTab(DISCORD_URL));') && /window\.close\(\)/.test(js));
ok("manifest: extension-page CSP allows the page (script-src 'self', inline styles) and the icon is shipped", /script-src 'self'/.test(manifest.content_security_policy.extension_pages) && /style-src 'self' 'unsafe-inline'/.test(manifest.content_security_policy.extension_pages) && fs.existsSync(path.join(ROOT, "assets/icon128.png")) && fs.existsSync(path.join(ROOT, "assets/icon32.png")));

ok("README: 1.75.0 entry", /\*\*1\.75\.0 — Hello page after install, shown exactly once\.\*\*/.test(read("README.md")));
ok("version pins 1.99.7", manifest.version === "1.99.7" && /^version = "1\.99\.7"/m.test(read("agent/Cargo.toml")));

// ── behaviour: run maybeShowHello against a fake chrome ──
const fnSrc = bg.slice(bg.indexOf("const HELLO_PAGE ="), bg.indexOf("chrome.runtime.onInstalled.addListener((details)"));
function makeChrome(store) {
  const created = [];
  const chrome = {
    storage: { local: { get: async (k) => (k in store ? { [k]: store[k] } : {}), set: async (o) => { Object.assign(store, o); } } },
    tabs: { create: async (o) => { created.push(o.url); return { id: 1 }; } },
    runtime: { getURL: (p) => "chrome-extension://harness/" + p },
  };
  return { chrome, created };
}
async function run(details, store) {
  const { chrome, created } = makeChrome(store);
  const maybeShowHello = new Function("chrome", fnSrc + "; return maybeShowHello;")(chrome);
  const r = await maybeShowHello(details);
  return { r, created, store };
}
(async () => {
  const store = {};
  const a = await run({ reason: "install" }, store);
  ok("fresh install → hello tab opens once and the flag is written", a.r === true && a.created.length === 1 && a.created[0] === "chrome-extension://harness/welcome.html" && typeof store.rsHelloShown === "number");
  const b = await run({ reason: "install" }, store);
  ok("a second onInstalled(install) with the flag set → nothing opens", b.r === false && b.created.length === 0);
  const c = await run({ reason: "update", previousVersion: "1.75.0" }, {});
  ok("extension update → nothing opens (even without the flag)", c.r === false && c.created.length === 0);
  const d = await run({ reason: "chrome_update" }, {});
  ok("browser update → nothing opens", d.r === false && d.created.length === 0);
  const e = await run(undefined, {});
  ok("missing details → nothing opens, no throw", e.r === false && e.created.length === 0);
  // flag write happens before tabs.create: a failing tabs.create still leaves the flag (never a retry loop)
  const store2 = {};
  const { chrome } = makeChrome(store2);
  chrome.tabs.create = async () => { throw new Error("no tabs"); };
  const f = await new Function("chrome", fnSrc + "; return maybeShowHello;")(chrome)({ reason: "install" });
  ok("tabs.create failure is swallowed (returns false) and the flag is already set", f === false && typeof store2.rsHelloShown === "number");

  // ── jsdom: the page itself ──
  let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch { JSDOM = null; }
  if (JSDOM) {
    const dom = new JSDOM(html.replace('<script src="welcome.js"></script>', ""), { url: "chrome-extension://harness/welcome.html", runScripts: "dangerously", pretendToBeVisual: true });
    const w = dom.window, d = w.document;
    const opened = []; let closed = false;
    w.chrome = { tabs: { create: (o) => opened.push(o.url) } };
    w.close = () => { closed = true; };
    Object.defineProperty(w.navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", configurable: true });
    const el = d.createElement("script"); el.textContent = js; d.body.appendChild(el);
    ok("page: run command adapts to the host (Windows → bin/total-core.exe)", d.getElementById("run-cmd").textContent === "bin/total-core.exe");
    d.getElementById("open-ai").click(); d.getElementById("open-discord").click(); d.getElementById("close").click();
    ok("page: Open an AI chat → DeepSeek, Join the Discord → invite, Close → window.close", opened.join(",") === "https://chat.deepseek.com/,https://discord.gg/YqVZaZYuy" && closed);
  } else console.log("SKIP  jsdom page check");
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("FAILURES:"); failed.forEach((r) => console.log("  - " + r[0])); }
})();
