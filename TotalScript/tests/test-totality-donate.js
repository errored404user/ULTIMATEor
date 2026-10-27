// 1.74.0 — Totality + Donate.
//  · The built-in work mode is shown as "Totality" (badge TOTALITY, aqua instead
//    of gold); its stored id stays "creation" so saved settings and custom
//    Public-Skill modes keep working. The long mode paragraph under "Work mode"
//    (tray + popup) is gone.
//  · Donate sections: Settings tray (named Robux game passes with prices),
//    popup card, desktop app (Home + Settings → Donate).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = process.env.TOTALSCRIPT_ROOT || path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const main = read("src/core/main.js");
const config = read("src/core/config.js");
const ps = read("src/core/public_skills.js");
const css = read("overlay.css");
const popupHtml = read("popup.html");
const popupJs = read("popup.js");
const gui = read("agent/src/gui.rs");
const results = []; const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  — " + extra : "")); if (!cond) process.exitCode = 1; };

const PASSES = [["SmallDono", 10, 1941336506], ["NormalDono", 25, 1941228530], ["BigDono", 100, 1940736510], ["HUGEDONO", 500, 1941672495]];

// ── Totality ──
ok("main: the built-in mode card is named Totality / TOTALITY (id stays creation)", main.includes('name: "Totality", badge: "TOTALITY", short: "Totality",') && main.includes("creation: {\n      name: \"Totality\"") && main.includes('let workMode = "creation"'));
ok("main: toast + help topic say Totality", /toast: "Totality Work Mode — /.test(main) && main.includes('workmode:{title:"Work mode: Totality"') && main.includes("Totality runs on the shared OPERATING LOOP"));
ok("main: the long mode paragraph under 'Work mode' is gone (cards + quick starts remain)", !main.includes("return pm ? escRs(pm.note || pm.sub) : WORK_MODES[workMode].note;") && /<div class="rs-sec-label"><span>Work mode<\/span>[\s\S]{0,400}<div class="rs-work-row rs-work-creation rs-work-modes"/.test(main) && main.includes('class="rs-work-starters"'));
vm.runInThisContext(config + ";globalThis.__RS=RS;", { filename: "config.js" });
const RS = globalThis.__RS;
ok("config: prompt headings read TOTALITY WORK MODE (full + tight) and TOTALITY CHECK", (config.match(/━━━ TOTALITY WORK MODE \(default — engineer, modeler, VFX \/ UI artist and animator in one\) ━━━/g) || []).length === 2 && RS.workModeChecklist("creation").startsWith("TOTALITY CHECK:") && !/CREATION WORK MODE|CREATION CHECK/.test(config));
ok("config: workModeLabel maps the stored id to Totality; the switch note uses it", RS.workModeLabel("creation") === "Totality" && RS.workModeLabel("ultimate") === "Totality" && RS.workModeSwitchNote("creation").startsWith("━━━ WORK MODE SWITCHED → TOTALITY ━━━"));
ok("public skills: custom modes say 'layered on TOTALITY' / 'on Totality' (base id unchanged)", ps.includes('const baseLabel = (b) => (String(b || "") === "creation" ? "Totality" : titleCase(b));') && ps.includes("layered on ${BASE})") && ps.includes("custom work mode on ${baseLabel(item.base)}"));
ok("popup: Totality card, no long help paragraph, WORK_HELP removed", popupHtml.includes('<span class="work-name">Totality</span>') && !popupHtml.includes('id="work-help"') && !popupJs.includes("WORK_HELP") && !popupJs.includes("work-help"));
ok("css: badge + card are aqua now (no gold gradient left on the mode)", css.includes('#rs-work-badge[data-work="creation"]   { background: linear-gradient(135deg, #9ff3ff 0%, #22d3ee 45%, #0e7490 100%); color: #03161c;') && css.includes('.rs-work-modes .rs-work-card[data-work="creation"]::before   { background: linear-gradient(90deg, #9ff3ff, #22d3ee, #0e7490); }') && /\.rs-work-card\[data-work="creation"\]\.on \{\s*background: linear-gradient\(135deg, rgba\(34,211,238,\.40\), rgba\(14,116,144,\.28\)\) !important;/.test(css) && !/data-work="creation"\][^\n]*#d6ae4f/.test(css) && popupHtml.includes("#work-creation.on{background:linear-gradient(135deg,#9ff3ff 0%,#22d3ee 45%,#0e7490 100%); color:#03161c}"));

const readme = read("README.md");
ok("README: 1.74.0 entry + Donate section + Totality in the mode paragraph", readme.includes("**1.74.0 — Totality, aqua; shorter Work mode; Donate.**") && readme.includes("## Donate") && readme.includes("there is one built-in mode, **Totality**") && PASSES.every(([n, r, id]) => readme.includes(`| ${n} | ${r} | https://www.roblox.com/game-pass/${id}/${n} |`)));
ok("version pins 1.78.1 (manifest / crate / plugin)", JSON.parse(read("manifest.json")).version === "1.78.1" && /^version = "1\.78\.1"/m.test(read("agent/Cargo.toml")) && read("plugin/TotalScript.lua").includes('local VERSION = "1.78.1"'));

// ── Donate ──
const LABELS = { SmallDono: ["Small thanks", "a quick thank-you"], NormalDono: ["Supporter", "fuels the next update"], BigDono: ["Big thanks", "keeps TotalScript free"], HUGEDONO: ["Legend", "huge \u2014 thank you"] };
ok("main: ROBUX_PASSES carry name + price + human label + one-line meaning for the four passes", PASSES.every(([n, r, id]) => new RegExp(`\\{ id: ${id}, name: "${n}",\\s+robux: ${r},\\s+label: "${LABELS[n][0]}",\\s+sub: "${LABELS[n][1].replace("\u2014", "\\\\u2014")}" \\}`).test(main)));
ok("main: Settings tray Donate section — title, plain-words note (free, pay on roblox.com, unlocks nothing), tiered buttons with label + sub-line + price pill, thank-you footer (static price shown, live lookup only overrides)", main.includes('<section class="rs-menu-sec rs-donate-sec">') && main.includes('<div class="rs-sec-label"><span>Donate</span><span class="rs-sec-state">Robux game passes</span></div>') && main.includes('<span class="rs-donate-title">Enjoying TotalScript?</span>') && /rs-donate-text">It is free and stays free for everyone\. If it saves you hours in Studio, you can say thanks with a Robux game pass .* the pass page opens on roblox\.com and you pay there, never here\. Donations unlock nothing; they just keep the work going\.<\/span>/.test(main) && main.includes('class="rs-rbx-grid rs-donate-grid"') && main.includes('class="rs-tip-opt rs-tip-rbx rs-dono-${ROBUX_PASSES.indexOf(p) + 1}"') && main.includes('<span class="rs-rbx-info"><span class="rs-rbx-name">${p.label}</span><span class="rs-rbx-sub">${p.sub} \\u00b7 ${p.name}</span></span><span class="rs-rbx-price"><span class="rs-rbx-cur">R$</span><span class="rs-rbx-amt">${p.robux}</span></span>') && main.includes('<div class="rs-donate-foot">Thank you to everyone who already chipped in.</div>') && main.includes("if (amt && price > 0) amt.textContent = String(price);") && !main.includes("Support with Robux") && !main.includes("a game-pass donation keeps it going"));
ok("css: donate grid styles appended (1.74.0 base + 1.75.1 tiers/copy)", /1\.74\.0 — DONATE/.test(css) && /1\.75\.1 — DONATE/.test(css) && css.includes("#rs-bar .rs-donate-grid .rs-rbx-price") && [1, 2, 3, 4].every((i) => css.includes(`#rs-bar .rs-donate-grid .rs-dono-${i} { --dono-glow:`)) && css.includes("#rs-bar .rs-donate-grid .rs-rbx-sub {") && css.includes("#rs-bar .rs-donate-title {") && css.includes("#rs-bar .rs-donate-foot {"));
ok("popup: Donate card — title, plain-words note, four tiered buttons (label, sub-line with pass name, price pill, roblox.com URL, title tooltip), footer; wired to chrome.tabs.create", popupHtml.includes('<div class="card" id="donate-card">') && popupHtml.includes('<div class="donate-title">Enjoying TotalScript?</div>') && /donate-note">It is free and stays free for everyone\. .*pay there, never here\. Donations unlock nothing, they just keep the work going\.<\/div>/.test(popupHtml) && PASSES.every(([n, r, id], i) => popupHtml.includes(`<button type="button" class="dono dono-${i + 1}" data-dono="https://www.roblox.com/game-pass/${id}/${n}" title="Opens the ${n} game pass (${r} Robux) on roblox.com"><span class="dono-info"><span class="dono-name">${LABELS[n][0]}</span><small>${LABELS[n][1]} \u00b7 ${n}</small></span><b>R$ ${r}</b></button>`)) && popupHtml.includes('<div class="row config-note donate-foot">Thank you to everyone who already chipped in.</div>') && [1, 2, 3, 4].every((i) => popupHtml.includes(`.dono-${i}{--dono-glow:`)) && popupHtml.includes(".dono-4 b{") && !popupHtml.includes("A Robux game-pass donation keeps it going") && popupJs.includes('document.querySelectorAll(".dono[data-dono]").forEach((b) => b.addEventListener("click", () => { chrome.tabs.create({ url: b.dataset.dono }); }));'));
ok("desktop app: DONATION_PASSES table (name, Robux, URL) + donation_row on Home and in Settings → Donate", gui.includes("pub const DONATION_PASSES: [(&str, u32, &str); 4] = [") && PASSES.every(([n, r, id]) => gui.includes(`("${n}", ${r}, "https://www.roblox.com/game-pass/${id}/${n}")`)) && gui.includes("fn donation_row(ui: &mut egui::Ui, t: Theme) {") && gui.includes('settings_section(ui, t, "Donate", |ui| {') && (gui.match(/donation_row\(ui, t\);/g) || []).length === 2 && gui.includes('if pill(ui, t, &format!("{name} · R$ {robux}"), false).on_hover_text(url).clicked() { open_external(url); }'));

// ── jsdom: tray renders Totality card without the paragraph, Donate section with 4 buttons ──
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch { JSDOM = null; }
if (!JSDOM) { console.log("SKIP  jsdom walk (jsdom not installed)"); finish(); } else { walk().catch((e) => { ok("jsdom walk completed", false, String(e && e.stack || e)); finish(); }); }
function finish() { const failed = results.filter((r) => !r[1]); console.log(`\n${results.length - failed.length}/${results.length} checks passed`); if (failed.length) { console.log("FAILURES:"); failed.forEach((r) => console.log("  - " + r[0])); } }

async function walk() {
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
  w.navigator.clipboard = { writeText: async () => {}, readText: async () => "" };
  w.URL.createObjectURL = () => "blob:harness"; w.URL.revokeObjectURL = () => {};
  const opened = [];
  w.open = (u) => { opened.push(String(u)); return null; }; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
  const storage = {};
  const storageApi = () => ({
    get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
    set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  });
  const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
  const background = (msg) => { switch (msg && msg.type) { case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true }; case "studio_status": return { ok: true, studio: true }; case "tools": case "list_tools": return { ok: true, tools: TOOLS }; case "web_fetch": return { ok: false }; default: return { ok: true }; } };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {}, removeListener() {} }, lastError: null, getManifest: () => JSON.parse(read("manifest.json")) }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {}, removeListener() {} } } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const pageErrors = [];
  w.onerror = (m) => { pageErrors.push(String(m)); };
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = read(s) + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout waiting for " + label); }

  await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
  await sleep(700);
  const badge = d.getElementById("rs-work-badge");
  ok("walk: bar badge reads TOTALITY on data-work=creation", badge && badge.textContent === "TOTALITY" && badge.dataset.work === "creation" && d.documentElement.getAttribute("data-rs-work") === "creation");
  const settingsBtn = d.getElementById("rs-settings-btn");
  settingsBtn.click(); await sleep(200);
  const menu = await waitFor(() => { const m = d.getElementById("rs-menu"); return m && !m.hidden ? m : null; }, 3000, "settings menu");
  const card = menu.querySelector('.rs-work-card[data-work="creation"]');
  ok("walk: Work mode card says Totality and is selected", card && card.querySelector(".rs-work-name").textContent === "Totality" && card.classList.contains("on"));
  const workSec = card.closest(".rs-menu-sec");
  const label = workSec.querySelector(".rs-sec-label");
  ok("walk: nothing but the cards follows the 'Work mode' label (long paragraph removed)", /Work mode/.test(label.textContent) && label.nextElementSibling && label.nextElementSibling.classList.contains("rs-work-modes") && !workSec.textContent.includes("One creator mode: senior Luau engineer"));
  ok("walk: Work mode state pill says Totality", /Totality/.test(label.querySelector(".rs-sec-state").textContent));
  const dono = menu.querySelector(".rs-donate-sec");
  const btns = dono ? [...dono.querySelectorAll(".rs-donate-grid .rs-tip-rbx")] : [];
  ok("walk: Donate section renders title + note + four tiered passes (label, sub-line with pass name, price) in order + footer", dono && /Donate/.test(dono.querySelector(".rs-sec-label").textContent) && dono.querySelector(".rs-donate-title") && dono.querySelector(".rs-donate-title").textContent === "Enjoying TotalScript?" && /pay there, never here/.test(dono.querySelector(".rs-donate-text").textContent) && btns.length === 4 && btns.map((b) => b.querySelector(".rs-rbx-name").textContent + ":" + b.querySelector(".rs-rbx-amt").textContent).join(",") === "Small thanks:10,Supporter:25,Big thanks:100,Legend:500" && btns.map((b) => b.querySelector(".rs-rbx-sub").textContent).join("|") === "a quick thank-you \u00b7 SmallDono|fuels the next update \u00b7 NormalDono|keeps TotalScript free \u00b7 BigDono|huge \u2014 thank you \u00b7 HUGEDONO" && btns.every((b, i) => b.classList.contains("rs-dono-" + (i + 1)) && b.getAttribute("type") === "button" && /opens the .* game pass/.test(b.title)) && dono.querySelector(".rs-donate-foot") && /Thank you to everyone/.test(dono.querySelector(".rs-donate-foot").textContent), btns.map((b) => b.textContent).join(","));
  ok("walk: each button targets its game pass on roblox.com", btns.every((b, i) => b.dataset.u === "https://www.roblox.com/game-pass/" + PASSES[i][2]));
  btns[3].click(); await sleep(50);
  ok("walk: clicking HUGEDONO opens the pass page", opened.some((u) => u === "https://www.roblox.com/game-pass/1941672495"), opened.join(","));
  ok("walk: no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  finish();
  setTimeout(() => process.exit(process.exitCode || 0), 50);
}
