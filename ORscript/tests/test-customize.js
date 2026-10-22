// 1.43.0 — Customize: users can change ORscript's name, logo, colours, button
// style / radius / labels and which bar buttons show (Settings → Customize).
//
//   static  — the model, the sanitiser, where the brand is rendered, CSS §16,
//             the popup mirror
//   walk    — jsdom boot of the real page with a hostile stored preset, then
//             every control in the Customize section, malicious logos, the
//             preset export / import, cross-tab sync and Reset all
//
// Run: NODE_PATH=/tmp/harness/node_modules node tests/test-customize.js
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const main = read("src/core/main.js"), css = read("overlay.css"), popup = read("popup.js"), popupHtml = read("popup.html");
let JSDOM = null; try { ({ JSDOM } = require("jsdom")); } catch {}

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (extra ? "  → " + String(extra).slice(0, 300) : "")); }
}
function finish() { console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); }

// ───────────────────────── static ─────────────────────────
ok("S: brand model + sanitiser + apply + persist exist", ["function sanitizeBrand(raw)", "function applyBrand()", "function setBrand(patch, opts)", "const BRAND_LOGO_RE = ", "const BRAND_STYLES = [\"glow\", \"flat\", \"outline\", \"glass\"]", "const BRAND_HIDEABLE = [\"think\", \"voice\", \"discord\", \"paint\", \"logo\", \"badge\", \"status\", \"corners\", \"motion\"]"].every((s) => main.includes(s)));
ok("S: the visible product name is the custom name, else the skin default (literal kept for older pins)", main.includes('const productName = () => BRAND.name || defaultProductName();') && main.includes('(orTheme==="void"?"VoidScript":"OrScript")'));
ok("S: bar, settings head and cards brand render the brand (name escaped, logo via brandLogoUrl) instead of the hard-coded icon", main.includes('src="${brandLogoUrl()}">') && main.includes('<span id="rs-brand" data-rs-brand>${escRs(productName())}</span>') && main.includes('<span data-rs-brand>${escRs(productName())}</span>') && main.includes("src=\"' + brandLogoUrl() + '\"><span class=\"rs-cards-kicker\" data-rs-brand-short>' + escRs(productName())") && !main.includes('src="${chrome.runtime.getURL("assets/icon128.png")}"'));
ok("S: logo accepts only inline PNG/JPEG/WebP/GIF data URLs under the size cap (no http, svg, javascript:, blob)", /BRAND_LOGO_RE = \/\^data:image\\\/\(\?:png\|jpeg\|webp\|gif\);base64,\[a-z0-9\+\/=\]\+\$\/i/.test(main) && main.includes("logo.length <= BRAND_LOGO_MAX && BRAND_LOGO_RE.test(logo)"));
ok("S: custom text is applied as textContent / attributes, never innerHTML", /document\.querySelectorAll\("#rs-brand, \[data-rs-brand\], \[data-rs-brand-short\]"\)\.forEach\(\(el\) => \{ if \(el\.textContent !== name\) el\.textContent = name; \}\)/.test(main) && !/innerHTML\s*=\s*[^;]*BRAND\.name/.test(main));
ok("S: colours become inline custom properties the section-4 pills already read (--orx-a/-b/-on/-glow, --orx-r)", ['st.setProperty("--orx-a", a)', 'st.setProperty("--orx-b", b)', 'st.setProperty("--orx-on", relLuma(a) > 0.45 ? "#15130f" : "#ffffff")', 'st.setProperty("--orx-r", BRAND.radius + "px")', 'html.setAttribute("data-rs-btn", BRAND.style)', 'html.setAttribute("data-rs-hide", BRAND.hide.join(" "))'].every((s) => main.includes(s)));
ok("S: Start / Stop / Think / Voice labels are read through the brand", main.includes('if (BRAND.labels.start) { if (kind === "start") label = ') && main.includes('stopBtn.textContent = brandLabel("stop", BRAND_LABEL_DEFAULTS.stop);') && main.includes('voiceBtn.textContent=brandLabel("voice", BRAND_LABEL_DEFAULTS.voice)') && main.includes('think.textContent = brandLabel("think", BRAND_LABEL_DEFAULTS.think)'));
ok("S: Settings → Customize section is built and wired (name, logo upload, colours, style cards, radius, labels, show toggles, copy / paste / reset)", ["function brandSectionHtml()", "function wireBrandSection()", "${brandSectionHtml()}", "try { wireBrandSection(); }", 'id="rs-brand-name"', 'id="rs-brand-logo-file"', 'id="rs-brand-accent"', 'data-brand-style="${id}"', 'id="rs-brand-radius"', 'data-brand-label="${k}"', 'data-brand-show="${k}"', 'id="rs-brand-export"', 'id="rs-brand-import"', 'id="rs-brand-reset"'].every((s) => main.includes(s)));
ok("S: uploaded logos are shrunk to a 128 px PNG on a canvas before storage (type + 8 MB checks first)", main.includes("function brandLogoFromFile(file)") && main.includes('if (!/^image\\/(?:png|jpeg|webp|gif)$/.test(file.type || ""))') && main.includes("file.size > 8 * 1024 * 1024") && main.includes('c.toDataURL("image/png")'));
ok("S: the Customize section is not advanced-only and the brand is loaded with the skin settings + synced across tabs", /<section class="rs-menu-sec rs-brand-sec" data-rs-brand-sec>/.test(main) && main.includes('chrome.storage.local.get("rsBrand", (r) => { if (r && r.rsBrand) { BRAND = sanitizeBrand(r.rsBrand); try { applyBrand(); } catch {} } });') && main.includes("if (area !== \"local\" || !changes.rsBrand) return;"));
ok("S: the bar repaints after a brand change (signature reset hook)", main.includes("window.__rsBrandRefresh = () => { lastBarSig = \"\"; try { renderBar(); } catch {} };") && main.includes('if (typeof window.__rsBrandRefresh === "function") window.__rsBrandRefresh();'));
ok("S: no rsAppearance / theme picker came back", !main.includes("rsAppearance") && main.includes('const orTheme = "night";'));
ok("S: 1.44.0 knobs — typeface, size, name style, glow, panel / text colours, background picture, extra hides — exist in the model, sanitiser and applier", ['const BRAND_FONTS = ["system", "rounded", "mono", "serif", "display"]', 'const BRAND_SIZES = ["compact", "large"]', 'const BRAND_NAME_STYLES = ["upper", "wide", "light"]', 'const BRAND_HIDEABLE = ["think", "voice", "discord", "paint", "logo", "badge", "status", "corners", "motion"]', 'if (bg.length <= BRAND_BG_MAX && BRAND_LOGO_RE.test(bg)) out.bg = bg;', 'out.panel = hex(src.panel);', 'out.text = hex(src.text);', 'html.setAttribute("data-rs-font", BRAND.font)', 'html.setAttribute("data-rs-size", BRAND.size)', 'html.setAttribute("data-rs-name", BRAND.nameStyle)', 'st.setProperty("--orx-img", `url("${BRAND.bg}") center / cover no-repeat`)', 'st.setProperty("--orx-bg", BRAND.panel)', 'st.setProperty("--or-fg", BRAND.text)', 'id="rs-brand-font"', 'id="rs-brand-size"', 'id="rs-brand-name-style"', 'id="rs-brand-glow"', 'id="rs-brand-panel"', 'id="rs-brand-text"', 'id="rs-brand-bg-file"', "function brandBackgroundFromFile(file)"].every((s) => main.includes(s)));
const sec16 = css.slice(css.indexOf("/* ── 16. 1.43.0 — Customize"));
ok("S: overlay.css §16 — hide rules, flat / outline / glass button styles, contain-fit custom logo, section styles", sec16.length > 2000 && ['html[data-rs-hide~="think"] #rs-extra', 'html[data-rs-hide~="voice"] #rs-voice', 'html[data-rs-hide~="discord"] #rs-discord', 'html[data-rs-hide~="paint"] #rs-paint-btn', 'html[data-rs-btn="flat"] #rs-action[data-kind="start"]', 'html[data-rs-btn="outline"] #rs-action[data-kind="start"]', 'html[data-rs-btn="glass"] #rs-action[data-kind="start"]', "#rs-logo.rs-logo.rs-logo-custom", ".rs-brand-grid {", ".rs-brand-tgl.on {", ".rs-brand-colors input[type=\"color\"] {"].every((s) => sec16.includes(s)));
ok("S: overlay.css §16 — 1.44.0 rules: fonts, zoom density, name styles, extra hides, motion off, custom text, bg preview", ['html[data-rs-font="mono"]', 'html[data-rs-font="serif"]', 'html[data-rs-size="compact"]', 'zoom: 1.14', 'html[data-rs-name="wide"] #rs-brand', 'html[data-rs-hide~="badge"] #rs-work-badge', 'html[data-rs-hide~="status"] #rs-status-pill', 'html[data-rs-hide~="corners"] #rs-root .rs-theme-corners', 'html[data-rs-hide~="motion"]', 'html[data-rs-custom-text]', '.rs-brand-bg-preview {', 'select.rs-brand-select'].every((s) => sec16.includes(s)));
ok("S: overlay.css braces balanced", (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length);
ok("S: popup mirrors the custom name + logo through the same sanitiser rules", popup.includes("function sanitizeBrandLite(raw)") && popup.includes('"rsBgMode", "rsBrand"') && popup.includes('logo.textContent = "OrScript"') && popup.includes("if (logo && settings.brand && settings.brand.name) logo.textContent = settings.brand.name;") && popup.includes('crest.src = custom || "assets/icon.png"') && popupHtml.includes(".crest img.custom{object-fit:contain"));

// ───────────────────────── walk ─────────────────────────
if (!JSDOM) { console.log("skip jsdom walk (jsdom not installed)"); finish(); }

(async () => {
  const pageHtml = read("codecraft.html");
  const scripts = [...pageHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const htmlNoScripts = pageHtml.replace(/<script src="[^"]+"><\/script>\s*/g, "").replace(/<link rel="stylesheet"[^>]*>/g, "");
  const dom = new JSDOM(htmlNoScripts, { url: "chrome-extension://harness-ext/codecraft.html", pretendToBeVisual: true, runScripts: "dangerously" });
  const w = dom.window, d = w.document;
  Object.defineProperty(w, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(w, "innerHeight", { value: 860, configurable: true });
  Object.defineProperty(d, "hidden", { value: false, configurable: true });
  Object.defineProperty(d, "visibilityState", { value: "visible", configurable: true });
  w.Element.prototype.getBoundingClientRect = function () { const r = { x: 210, y: 300, width: 860, height: 40 }; return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() {} }; };
  w.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return 860; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 40; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return d.body; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.Element.prototype.scrollTo = function () {}; w.scrollTo = () => {};
  w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16); w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.elementFromPoint = d.elementFromPoint = () => null; d.execCommand = () => false;
  w.HTMLCanvasElement.prototype.getContext = () => null;
  if (!w.crypto) w.crypto = require("crypto").webcrypto;
  w.Audio = class { play() { return Promise.resolve(); } pause() {} }; w.AudioContext = undefined;
  w.ReadableStream = ReadableStream; w.Response = Response; w.Headers = Headers; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  const clipboard = [];
  w.navigator.clipboard = { writeText: async (t) => { clipboard.push(t); }, readText: async () => "" };
  w.URL.createObjectURL = () => "blob:harness"; w.URL.revokeObjectURL = () => {};
  w.open = () => null; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
  const storage = {};
  const changeListeners = [];
  const fireChange = (changes) => { for (const fn of changeListeners) { try { fn(changes, "local"); } catch {} } };
  const storageApi = () => ({
    get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
    set(obj, cb) { const ch = {}; for (const [k, v] of Object.entries(obj)) { ch[k] = { oldValue: storage[k], newValue: v }; storage[k] = v; } setTimeout(() => fireChange(ch), 0); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    remove(keys, cb) { const ch = {}; for (const k of [].concat(keys)) { ch[k] = { oldValue: storage[k], newValue: undefined }; delete storage[k]; } setTimeout(() => fireChange(ch), 0); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  });
  const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
  const background = (msg) => {
    switch (msg && msg.type) {
      case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true };
      case "studio_status": return { ok: true, studio: true };
      case "tools": case "list_tools": return { ok: true, tools: TOOLS };
      case "call_tool": return { ok: true, text: "ok" };
      default: return { ok: true, tools: TOOLS };
    }
  };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {} }, lastError: null, getManifest: () => JSON.parse(read("manifest.json")) }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener(fn) { changeListeners.push(fn); } } }, tabs: { create() {} } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  // A hostile / sloppy stored preset: every bad field must be dropped, every good one kept.
  storage.rsBrand = { name: "  Forge<script>alert(1)</script>  ", logo: "javascript:alert(1)", accent: "red", accent2: "#12AB34", style: "neon", radius: 999, labels: { start: "Go!", stop: "<b>x</b>", bogus: "no" }, hide: ["engine", "voice", "settings"] };
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const pageErrors = [];
  w.onerror = (m) => { pageErrors.push(String(m)); };
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = read(s) + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout waiting for " + label); }
  const htmlEl = d.documentElement;
  const cssVar = (n) => htmlEl.style.getPropertyValue(n).trim();
  const setInput = (el, v) => { el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const ICON = "chrome-extension://harness-ext/assets/icon128.png";
  // a real 1×1 PNG
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  try {
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    await sleep(700);

    // 1 — boot with the hostile preset
    const b0 = w.__rsBrand();
    ok("walk 1: stored preset is sanitised on load (tags stripped, bad logo/colour/style dropped, radius clamped, unknown labels / hide keys ignored)",
      b0.name === "Forgescriptalert(1)/scri" && b0.name.length === 24 && b0.logo === "" && b0.accent === "" && b0.accent2 === "#12ab34" && b0.style === "glow" && b0.radius === 40 && b0.labels.start === "Go!" && b0.labels.stop === "bx/b" && !("bogus" in b0.labels) && JSON.stringify(b0.hide) === '["voice"]', JSON.stringify(b0));
    ok("walk 1: the bar shows the custom name as text (no HTML), the custom Start label, radius var and hidden Voice", d.getElementById("rs-brand").textContent === b0.name && !d.getElementById("rs-brand").querySelector("*") && /Go!/.test(d.getElementById("rs-action").textContent) && cssVar("--orx-r") === "40px" && htmlEl.getAttribute("data-rs-hide") === "voice" && htmlEl.hasAttribute("data-rs-custom") && !htmlEl.hasAttribute("data-rs-btn"), d.getElementById("rs-action").textContent + " | " + cssVar("--orx-r"));
    ok("walk 1: no accent → no colour vars leak from accent2 alone", cssVar("--orx-a") === "" && cssVar("--orx-b") === "");

    // 2 — the Settings section
    d.getElementById("rs-settings-btn").click(); await sleep(200);
    const menu = d.getElementById("rs-menu");
    const sec = menu && menu.querySelector("[data-rs-brand-sec]");
    ok("walk 2: Settings shows the Customize section with every control, prefilled from the brand", !!sec && !menu.hidden && sec.querySelector("#rs-brand-name").value === b0.name && sec.querySelector("#rs-brand-state").textContent === "custom look" && sec.querySelectorAll("[data-brand-style]").length === 4 && sec.querySelectorAll("[data-brand-label]").length === 4 && sec.querySelectorAll("[data-brand-show]").length === 9 && sec.querySelector("#rs-brand-font") && sec.querySelector("#rs-brand-size") && sec.querySelector("#rs-brand-name-style") && sec.querySelector("#rs-brand-glow") && sec.querySelector("#rs-brand-panel") && sec.querySelector("#rs-brand-text") && sec.querySelector("#rs-brand-bg-pick") && sec.querySelector('[data-brand-show="voice"]').getAttribute("aria-pressed") === "false" && sec.querySelector("#rs-brand-radius").value === "40" && sec.querySelector("#rs-brand-logo-preview").getAttribute("src") === ICON, sec ? "" : "no section (menu hidden=" + (menu && menu.hidden) + ")");
    ok("walk 2: the section is visible in the beginner view (not .rs-adv)", !!sec && !sec.classList.contains("rs-adv") && menu.classList.contains("rs-menu-simple"));

    // 3 — name: live, debounced, persisted, mirrored in the settings head
    setInput(sec.querySelector("#rs-brand-name"), " My   Studio "); await sleep(450);
    ok("walk 3: typing a name updates the bar + settings head live and persists after the debounce", w.__rsBrand().name === "My Studio" && d.getElementById("rs-brand").textContent === "My Studio" && menu.querySelector(".rs-menu-tag [data-rs-brand], .rs-menu-tag").textContent.includes("My Studio") && storage.rsBrand && storage.rsBrand.name === "My Studio" && d.activeElement === sec.querySelector("#rs-brand-name") || d.activeElement === d.body, w.__rsBrand().name + " | " + d.getElementById("rs-brand").textContent + " | " + JSON.stringify(storage.rsBrand && storage.rsBrand.name));
    ok("walk 3: the input keeps its value (menu not rebuilt under the user's hands)", sec.isConnected && sec.querySelector("#rs-brand-name").value === " My   Studio ");

    // 4 — colours
    setInput(sec.querySelector("#rs-brand-accent"), "#3b82f6"); await sleep(150);
    ok("walk 4: accent from the colour input → --orx-a/--or-accent inline, derived gradient end, white text on a dark accent, glow rgba", cssVar("--orx-a") === "#3b82f6" && cssVar("--or-accent") === "#3b82f6" && cssVar("--orx-b") === "#12ab34" && cssVar("--orx-on") === "#ffffff" && /^rgba\(59,130,246,\.32\)$/.test(cssVar("--orx-glow")), [cssVar("--orx-a"), cssVar("--orx-b"), cssVar("--orx-on"), cssVar("--orx-glow")].join(" "));
    w.__rsSetBrand({ accent: "#ffee00", accent2: "" });
    ok("walk 4: a light accent gets dark text and an auto-derived darker gradient end", cssVar("--orx-on") === "#15130f" && cssVar("--orx-b") === "#b8ab00", cssVar("--orx-on") + " " + cssVar("--orx-b"));
    w.__rsSetBrand({ accent: "rgb(1,2,3)" });
    ok("walk 4: a non-hex accent is refused (vars cleared, not poisoned)", w.__rsBrand().accent === "" && cssVar("--orx-a") === "" && !/rgb\(/.test(htmlEl.getAttribute("style") || ""));
    sec.querySelector("#rs-brand-color-reset").disabled = false; sec.querySelector("#rs-brand-color-reset").click(); await sleep(50);
    ok("walk 4: Default colours clears both", w.__rsBrand().accent === "" && w.__rsBrand().accent2 === "" && cssVar("--orx-b") === "");

    // 5 — button style + radius
    sec.querySelector('[data-brand-style="outline"]').click(); await sleep(30);
    ok("walk 5: style card → <html data-rs-btn=outline>, card selected", htmlEl.getAttribute("data-rs-btn") === "outline" && sec.querySelector('[data-brand-style="outline"]').classList.contains("on") && sec.querySelector('[data-brand-style="outline"]').getAttribute("aria-checked") === "true" && !sec.querySelector('[data-brand-style="glow"]').classList.contains("on"));
    sec.querySelector('[data-brand-style="glass"]').click(); await sleep(30);
    ok("walk 5: glass", htmlEl.getAttribute("data-rs-btn") === "glass");
    sec.querySelector('[data-brand-style="glow"]').click(); await sleep(30);
    ok("walk 5: back to glow removes the attribute (default = no override)", !htmlEl.hasAttribute("data-rs-btn") && w.__rsBrand().style === "glow");
    setInput(sec.querySelector("#rs-brand-radius"), "0"); await sleep(30);
    ok("walk 5: radius 0 → --orx-r 0px + --ti-radius-ctl, label '0 px'", cssVar("--orx-r") === "0px" && cssVar("--ti-radius-ctl") === "0px" && sec.querySelector("#rs-brand-radius-val").textContent === "0 px" && w.__rsBrand().radius === 0);
    sec.querySelector("#rs-brand-radius-reset").click(); await sleep(30);
    ok("walk 5: radius reset → theme radius (vars removed, button disabled)", cssVar("--orx-r") === "" && w.__rsBrand().radius === null && sec.querySelector("#rs-brand-radius-val").textContent === "theme" && sec.querySelector("#rs-brand-radius-reset").disabled);

    // 6 — labels + show toggles
    setInput(sec.querySelector('[data-brand-label="stop"]'), "Halt"); setInput(sec.querySelector('[data-brand-label="think"]'), "Deep"); setInput(sec.querySelector('[data-brand-label="start"]'), ""); await sleep(300);
    ok("walk 6: labels → Stop / Think text; clearing Start restores the default Start label", d.getElementById("rs-stop").textContent === "Halt" && d.getElementById("rs-extra").textContent === "Deep" && !("start" in w.__rsBrand().labels) && /Start Agent/.test(d.getElementById("rs-action").textContent), d.getElementById("rs-action").textContent);
    sec.querySelector('[data-brand-show="discord"]').click(); await sleep(30);
    ok("walk 6: hiding Discord adds it to data-rs-hide (CSS hides it), chip off", /\bdiscord\b/.test(htmlEl.getAttribute("data-rs-hide")) && /\bvoice\b/.test(htmlEl.getAttribute("data-rs-hide")) && sec.querySelector('[data-brand-show="discord"]').getAttribute("aria-pressed") === "false");
    sec.querySelector('[data-brand-show="discord"]').click(); sec.querySelector('[data-brand-show="voice"]').click(); await sleep(30);
    ok("walk 6: showing both again removes the attribute", !htmlEl.hasAttribute("data-rs-hide") && w.__rsBrand().hide.length === 0);

    // 7 — logo
    w.__rsSetBrand({ logo: PNG }); await sleep(30);
    const mark = menu.querySelector(".rs-menu-mark-logo");
    ok("walk 7: a PNG data URL becomes the bar logo, the settings mark and the preview (contain-fit class)", d.getElementById("rs-logo").getAttribute("src") === PNG && d.getElementById("rs-logo").classList.contains("rs-logo-custom") && sec.querySelector("#rs-brand-logo-preview").getAttribute("src") === PNG && mark && mark.style.backgroundImage.includes("data:image/png;base64,") && !sec.querySelector("#rs-brand-logo-reset").disabled, [d.getElementById("rs-logo").getAttribute("src") === PNG, d.getElementById("rs-logo").className, sec.querySelector("#rs-brand-logo-preview").getAttribute("src") === PNG, mark && mark.style.backgroundImage, sec.querySelector("#rs-brand-logo-reset").disabled].join(" | "));
    const bad = ["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "https://evil.example/logo.png", "javascript:alert(1)", "blob:chrome-extension://x/y", "data:text/html;base64,PGI+", "data:image/png;base64," + "A".repeat(400001)];
    const badResults = bad.map((u) => { w.__rsSetBrand({ logo: PNG }); const r = w.__rsSetBrand({ logo: u }); return r.logo === "" && d.getElementById("rs-logo").getAttribute("src") === ICON && !d.getElementById("rs-logo").classList.contains("rs-logo-custom"); });
    ok("walk 7: SVG / http / javascript: / blob / text / oversize logos are refused → default icon", badResults.every(Boolean), badResults.join(","));
    w.__rsSetBrand({ logo: PNG }); sec.querySelector("#rs-brand-logo-reset").click(); await sleep(30);
    ok("walk 7: Default logo button restores the icon", w.__rsBrand().logo === "" && d.getElementById("rs-logo").getAttribute("src") === ICON, w.__rsBrand().logo.slice(0, 30) + " | " + d.getElementById("rs-logo").getAttribute("src").slice(0, 40));

    // 7b — 1.44.0 knobs
    const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
    const fontSel = sec.querySelector("#rs-brand-font"), sizeSel = sec.querySelector("#rs-brand-size"), nameSel = sec.querySelector("#rs-brand-name-style");
    fontSel.value = "mono"; fontSel.dispatchEvent(new w.Event("change", { bubbles: true }));
    sizeSel.value = "compact"; sizeSel.dispatchEvent(new w.Event("change", { bubbles: true }));
    nameSel.value = "wide"; nameSel.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(30);
    ok("walk 7b: typeface / size / name style selects → data-rs-font / data-rs-size / data-rs-name", htmlEl.getAttribute("data-rs-font") === "mono" && htmlEl.getAttribute("data-rs-size") === "compact" && htmlEl.getAttribute("data-rs-name") === "wide" && w.__rsBrand().font === "mono" && w.__rsBrand().size === "compact" && w.__rsBrand().nameStyle === "wide");
    fontSel.value = ""; fontSel.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(20);
    ok("walk 7b: 'Default' typeface removes the attribute; bogus values are refused", !htmlEl.hasAttribute("data-rs-font") && w.__rsSetBrand({ font: "comic", size: "huge", nameStyle: "<b>" }).font === "" && !htmlEl.hasAttribute("data-rs-size") && !htmlEl.hasAttribute("data-rs-name"));
    setInput(sec.querySelector("#rs-brand-glow"), "0"); await sleep(30);
    ok("walk 7b: glow 0 % → fully transparent glow on the live accent (default accent when none is set)", /^rgba\(236,228,216,0\)$/.test(cssVar("--orx-glow")) && cssVar("--or-glow") === cssVar("--orx-glow") && sec.querySelector("#rs-brand-glow-val").textContent === "0 %", cssVar("--orx-glow"));
    w.__rsSetBrand({ accent: "#3b82f6", glow: 100 }); await sleep(20);
    ok("walk 7b: glow 100 % on a custom accent → alpha .6 of that accent", cssVar("--orx-glow") === "rgba(59,130,246,0.6)", cssVar("--orx-glow"));
    sec.querySelector("#rs-brand-glow-reset").click(); await sleep(20);
    ok("walk 7b: glow reset → the accent's own .32 glow again, button disabled", cssVar("--orx-glow") === "rgba(59,130,246,.32)" && w.__rsBrand().glow === null && sec.querySelector("#rs-brand-glow-reset").disabled, cssVar("--orx-glow"));
    setInput(sec.querySelector("#rs-brand-panel"), "#101820"); setInput(sec.querySelector("#rs-brand-text"), "#e0f2fe"); await sleep(150);
    ok("walk 7b: panel + text colours → --orx-bg/--or-bg, --or-fg + derived --or-muted, data-rs-custom-text", cssVar("--orx-bg") === "#101820" && cssVar("--or-bg") === "#101820" && cssVar("--or-fg") === "#e0f2fe" && /^#[0-9a-f]{6}$/.test(cssVar("--or-muted")) && cssVar("--or-muted") !== "#e0f2fe" && htmlEl.hasAttribute("data-rs-custom-text") && !sec.querySelector("#rs-brand-color-reset").disabled, [cssVar("--orx-bg"), cssVar("--or-fg"), cssVar("--or-muted")].join(" "));
    sec.querySelector("#rs-brand-color-reset").click(); await sleep(30);
    ok("walk 7b: Default colours also clears panel / text", cssVar("--orx-bg") === "" && cssVar("--or-fg") === "" && !htmlEl.hasAttribute("data-rs-custom-text") && w.__rsBrand().panel === "" && w.__rsBrand().text === "");
    w.__rsSetBrand({ bg: JPG }); await sleep(20);
    ok("walk 7b: a JPEG data URL becomes the tray background (--orx-img) with data-rs-custom-bg + preview", cssVar("--orx-img").startsWith('url("data:image/jpeg;base64,') && /center \/ cover no-repeat$/.test(cssVar("--orx-img")) && htmlEl.hasAttribute("data-rs-custom-bg") && sec.querySelector("#rs-brand-bg-preview").classList.contains("on") && !sec.querySelector("#rs-brand-bg-reset").disabled, cssVar("--orx-img").slice(0, 60));
    const badBg = ["https://evil.example/bg.jpg", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data:image/jpeg;base64," + "A".repeat(480001)].map((u) => w.__rsSetBrand({ bg: u }).bg === "" && cssVar("--orx-img") === "" && !htmlEl.hasAttribute("data-rs-custom-bg"));
    ok("walk 7b: http / SVG / oversize backgrounds are refused", badBg.every(Boolean), badBg.join(","));
    w.__rsSetBrand({ bg: JPG }); sec.querySelector("#rs-brand-bg-reset").click(); await sleep(20);
    ok("walk 7b: Remove clears the background", w.__rsBrand().bg === "" && cssVar("--orx-img") === "");
    for (const k of ["logo", "badge", "status", "corners", "motion"]) sec.querySelector(`[data-brand-show="${k}"]`).click(); await sleep(30);
    ok("walk 7b: Logo / Mode badge / Status pill / Corner marks / Animations toggles land in data-rs-hide (CSS does the hiding)", ["logo", "badge", "status", "corners", "motion"].every((k) => new RegExp("\\b" + k + "\\b").test(htmlEl.getAttribute("data-rs-hide"))) && sec.querySelectorAll("[data-brand-show]").length === 9, htmlEl.getAttribute("data-rs-hide"));
    for (const k of ["logo", "badge", "status", "corners", "motion"]) sec.querySelector(`[data-brand-show="${k}"]`).click(); await sleep(30);
    ok("walk 7b: … and leave again", !htmlEl.hasAttribute("data-rs-hide"));

    // 8 — preset export / import
    w.__rsSetBrand({ name: "Exported", accent: "#ff0066", style: "flat", labels: { think: "Deep" }, font: "serif", size: "large", glow: 20, panel: "#000000" }, { replace: true }); await sleep(30);
    sec.querySelector("#rs-brand-export").click(); await sleep(50);
    let exported = null; try { exported = JSON.parse(clipboard[clipboard.length - 1]); } catch {}
    ok("walk 8: Copy preset puts the sanitised brand JSON on the clipboard", !!exported && exported.orscriptPreset === 1 && exported.name === "Exported" && exported.accent === "#ff0066" && exported.style === "flat" && exported.labels.think === "Deep" && exported.font === "serif" && exported.size === "large" && exported.glow === 20 && exported.panel === "#000000", clipboard[clipboard.length - 1]);
    w.prompt = () => JSON.stringify({ name: "Imported", style: "outline", hide: ["paint"], logo: "https://evil.example/x.png", accent: "#00aa88" });
    sec.querySelector("#rs-brand-import").click(); await sleep(200);
    const bi = w.__rsBrand();
    ok("walk 8: Paste preset REPLACES the look (old labels gone), sanitised (bad logo dropped), menu rebuilt", bi.name === "Imported" && bi.style === "outline" && JSON.stringify(bi.hide) === '["paint"]' && bi.logo === "" && bi.accent === "#00aa88" && !("think" in bi.labels) && bi.font === "" && bi.size === "" && bi.glow === null && bi.panel === "" && !htmlEl.hasAttribute("data-rs-font") && !htmlEl.hasAttribute("data-rs-size") && htmlEl.getAttribute("data-rs-btn") === "outline" && d.getElementById("rs-brand").textContent === "Imported" && d.getElementById("rs-extra").textContent === "Think" && storage.rsBrand.name === "Imported", JSON.stringify(bi));
    const sec2 = menu.querySelector("[data-rs-brand-sec]");
    w.prompt = () => "this is not json";
    sec2.querySelector("#rs-brand-import").click(); await sleep(60);
    ok("walk 8: garbage preset is refused with a message and nothing changes", w.__rsBrand().name === "Imported" && /not a preset/.test(sec2.querySelector("#rs-brand-status").textContent));

    // 9 — another tab changes the brand
    fireChange({ rsBrand: { oldValue: storage.rsBrand, newValue: { name: "Other tab", style: "glass", font: "rounded", text: "#ffffff" } } }); await sleep(40);
    ok("walk 9: a storage change from another tab is applied (name + style + font + text)", d.getElementById("rs-brand").textContent === "Other tab" && htmlEl.getAttribute("data-rs-btn") === "glass" && htmlEl.getAttribute("data-rs-font") === "rounded" && cssVar("--or-fg") === "#ffffff");

    // 10 — reset all
    sec2.querySelector("#rs-brand-reset").click(); await sleep(300);
    const bf = w.__rsBrand();
    ok("walk 10: Reset all → defaults everywhere, storage key removed", bf.name === "" && bf.logo === "" && bf.accent === "" && bf.style === "glow" && bf.radius === null && Object.keys(bf.labels).length === 0 && bf.hide.length === 0 && d.getElementById("rs-brand").textContent === "OrScript" && !htmlEl.hasAttribute("data-rs-custom") && !htmlEl.hasAttribute("data-rs-btn") && !htmlEl.hasAttribute("data-rs-hide") && cssVar("--orx-a") === "" && cssVar("--or-fg") === "" && cssVar("--orx-img") === "" && !htmlEl.hasAttribute("data-rs-font") && !htmlEl.hasAttribute("data-rs-size") && !htmlEl.hasAttribute("data-rs-name") && !htmlEl.hasAttribute("data-rs-custom-text") && !htmlEl.hasAttribute("data-rs-custom-bg") && bf.font === "" && bf.size === "" && bf.nameStyle === "" && bf.glow === null && bf.panel === "" && bf.text === "" && bf.bg === "" && !("rsBrand" in storage) && d.getElementById("rs-stop").textContent === "\u25A0 Stop", JSON.stringify(bf) + " " + JSON.stringify(Object.keys(storage)));
    const sec3 = menu.querySelector("[data-rs-brand-sec]");
    ok("walk 10: section reflects the default state (Reset disabled, 'default look')", sec3 && sec3.querySelector("#rs-brand-reset").disabled && sec3.querySelector("#rs-brand-state").textContent === "default look");
    ok("walk: no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (e) {
    ok("walk: completed", false, (e && e.stack) || String(e));
  }
  finish();
})();
