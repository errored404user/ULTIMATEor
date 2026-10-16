// 1.34.1 — Cards panel consistency: Library / Activity / Public / Tasks share one
// shell (.rs-template-library header + .rs-template-row rows), the panel heading
// names the open tab, and overlay.css section 11 maps every tab onto the same
// row model + theme pill buttons. String checks always run; the jsdom render
// part runs when jsdom is installed (cd ORscript && npm i --no-save jsdom).
const fs = require("fs");
const path = require("path");
const ROOT = process.env.ORSCRIPT_ROOT || path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const main = read("src/core/main.js");
const css = read("overlay.css");
const results = []; const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  — " + extra : "")); if (!cond) process.exitCode = 1; };

// ── string checks ──
ok("activityHtml renders inside the Library shell with a template head + count", /function activityHtml\(\)[\s\S]{0,900}<header class="rs-template-head">[\s\S]{0,200}<b>Activity<\/b><span class="rs-template-count">[\s\S]{0,1200}rs-template-library rs-activity/.test(main));
ok("activity rows are .rs-template-row.rs-activity-row (same row model as templates)", /rs-template-row rs-activity-row rs-card rs-card-' \+ cls/.test(main) && /rs-template-list rs-activity-list/.test(main));
ok("activity Clear is a ghost pill in the head actions, disabled when empty", /<button id="rs-cards-clear" type="button" class="rs-btn-secondary"' \+ \(recentCards\.length \? "" : " disabled"\)/.test(main));
ok("activity empty state uses the template empty block", /rs-template-empty rs-cards-empty"><div class="rs-template-empty-mark">/.test(main) && /No results yet<\/b>/.test(main));
ok("panel heading + subheading follow the open tab", /const tabHead = cardsTab === "activity" \? \["Activity"/.test(main) && /\["Public Skills", /.test(main) && /\["Tasks", /.test(main) && /\["Templates", "Reusable workflows"\]/.test(main) && /rs-cards-heading">' \+ tabHead\[0\] \+ '<\/span><span class="rs-cards-subheading">' \+ tabHead\[1\]/.test(main));
ok("panel carries data-cards-tab for per-tab CSS", /panel\.dataset\.cardsTab = cardsTab;/.test(main));
ok("local-engine Session view is wrapped in the same shell", (main.match(/rs-template-library rs-session/g) || []).length === 2);
ok("Public and Tasks already use the shell (unchanged)", /rs-template-library rs-public/.test(main) && /rs-template-library rs-tasks/.test(main));
ok("trackCard is reachable for tests/other IIFEs", /window\.__rsTrackCard = trackCard/.test(main));

const sec = css.slice(css.indexOf("── 11. 1.34.1"));
ok("overlay.css has section 11 (cards panel: one design for every tab)", sec.length > 4000);
ok("panel tokens (row / line / fg / radius / status colours) + light overrides", /#rs-cards-panel \{\s*--cp-row:/.test(sec) && /html\.rs-light #rs-cards-panel \{/.test(sec) && /--cp-ok:/.test(sec) && /--cp-r: 14px/.test(sec));
ok("header/tabs sizing no longer depends on the Library tab (:has scoping dropped)", /#rs-cards-panel \.rs-cards-heading \{ font-size: 18px !important; \}/.test(sec) && /#rs-cards-panel \.rs-cards-tabs \{ height: 40px !important/.test(sec) && !/:has\(\.rs-template-library\)/.test(sec));
ok("one row model for every tab (84px, 14px radius, 14.5/12.5/11px type)", /#rs-cards-panel \.rs-template-row \{ min-height: 84px !important/.test(sec) && /\.rs-template-copy > b \{ font-size: 14\.5px/.test(sec) && /\.rs-template-copy > p \{ font-size: 12\.5px/.test(sec));
ok("activity cards mapped onto the row model (44px icon, mono title, status colours, accent bar)", /\.rs-activity-row \.rs-card-icon \{[^}]*width: 44px/.test(sec) && /\.rs-activity-row \.rs-card-title \{ font: 750 14px/.test(sec) && /\.rs-activity-row\.rs-card-done::before \{ background: var\(--cp-ok\)/.test(sec) && /\.rs-activity-row\.rs-card-err\s+\.rs-card-status \{ color: var\(--cp-err\)/.test(sec));
ok("every button in the panel is a 36px pill; primaries use the theme gradient, the rest the ghost pill", /\.rs-template-library button:not\(\.rs-cards-tab\)[^{]*\{[^}]*min-height: 36px !important;[^}]*border-radius: var\(--cp-r-ctl\)/.test(sec) && /button\[data-public-create\],\s*html\[data-rs-theme\] #rs-cards-panel \.rs-template-library button\[data-public-import\],\s*html\[data-rs-theme\] #rs-cards-panel \.rs-template-library button\[data-task-run-all\] \{\s*background: var\(--orx-grad\)/.test(sec) && /background: linear-gradient\(180deg, var\(--orx-ghost-hi\), var\(--orx-ghost\)\) !important;\s*color: var\(--orx-ghost-fg\)/.test(sec));
ok("inputs / selects / textarea are 40px wells with accent focus ring", /#rs-cards-panel \.rs-template-library select \{ height: 40px !important/.test(sec) && /textarea:focus \{[^}]*box-shadow: 0 0 0 3px color-mix/.test(sec));
ok("Public: ways, share box, composer, kind badges on the same tokens", /\.rs-public-ways li \{[^}]*border-radius: var\(--cp-r\)/.test(sec) && /\.rs-public-sharebox \{[^}]*border-radius: var\(--cp-r\)/.test(sec) && /\.rs-public-compose \{[^}]*border-radius: var\(--cp-r\)/.test(sec) && /\.rs-public-kind, #rs-cards-panel \.rs-public-active, #rs-cards-panel \.rs-public-disabled \{[^}]*height: 22px/.test(sec) && /\.rs-public-kind-mode\s*\{ color: #ffd37a/.test(sec));
ok("Tasks: rows, check box, add form, progress bar on the same tokens", /\.rs-task-row \{[^}]*border-radius: var\(--cp-r\)/.test(sec) && /\.rs-task-check \{ width: 26px/.test(sec) && /\.rs-task-text \{ font-size: 14px/.test(sec) && /\.rs-task-progress span \{ background: var\(--orx-grad/.test(sec) && /\.rs-task-actions button \{ min-height: 32px/.test(sec));
ok("Idea generator + Session view restyled with the same card language", /\.rs-idea-generator \{[^}]*border-radius: var\(--cp-r\)/.test(sec) && /\.rs-idea-generator select \{ height: 40px/.test(sec) && /\.rs-session \.rs-cards-title \{ font-size: 16px/.test(sec));
ok("responsive + reduced-motion rules for the unified panel", /@media \(max-width: 720px\) \{\s*#rs-cards-panel \{ --cp-x: 12px; \}/.test(sec) && /prefers-reduced-motion: reduce\) \{\s*#rs-cards-panel \.rs-template-library button/.test(sec));
ok("legacy classes the tests/handlers rely on still exist in the markup", main.includes('#rs-cards-clear') && main.includes("rs-card-title") && main.includes("rs-card-detail") && main.includes("rs-cards-count") && css.includes(".rs-public-compose") && css.includes(".rs-task-row"));

// ── jsdom render (optional) ──
let JSDOM; try { ({ JSDOM } = require("jsdom")); } catch { JSDOM = null; }
if (!JSDOM) { console.log("SKIP  jsdom render (jsdom not installed)"); finish(); } else { render().catch((e) => { ok("jsdom render completed", false, String(e && e.stack || e)); finish(); }); }

function finish() { const failed = results.filter((r) => !r[1]); console.log(`\n${results.length - failed.length}/${results.length} checks passed`); if (failed.length) { console.log("FAILURES:"); failed.forEach((r) => console.log("  - " + r[0])); } }

async function render() {
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
  w.open = () => null; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
  const storage = {};
  const storageApi = () => ({
    get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
    set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  });
  const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
  const background = (msg) => { switch (msg && msg.type) { case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true }; case "studio_status": return { ok: true, studio: true }; case "tools": case "list_tools": return { ok: true, tools: TOOLS }; default: return { ok: true, tools: TOOLS }; } };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {} }, lastError: null, getManifest: () => JSON.parse(read("manifest.json")) }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {} } }, tabs: { create() {} } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const pageErrors = [];
  w.onerror = (m) => { pageErrors.push(String(m)); };
  for (const s of scripts) { const el = d.createElement("script"); el.textContent = read(s) + "\n//# sourceURL=" + s; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout waiting for " + label); }

  await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
  await sleep(600);
  const cardsBtn = await waitFor(() => d.getElementById("rs-cards-btn"), 4000, "cards button");
  cardsBtn.click(); await sleep(150);
  const panel = d.getElementById("rs-cards-panel");
  ok("render: cards panel opens", panel && !panel.hidden);
  const headTxt = () => (panel.querySelector(".rs-cards-heading") || {}).textContent;
  const subTxt = () => (panel.querySelector(".rs-cards-subheading") || {}).textContent || "";
  const shell = () => panel.querySelector(".rs-cards-body > .rs-template-library");
  ok("render: Library tab → shell + heading 'Templates'", shell() && headTxt() === "Templates" && panel.dataset.cardsTab === "library", headTxt());
  ok("render: Library head uses .rs-template-head with count pill", !!panel.querySelector(".rs-template-head .rs-template-count"));

  panel.querySelector('[data-tab="activity"]').click(); await sleep(120);
  ok("render: Activity tab → same shell, heading 'Activity', data-cards-tab", shell() && shell().classList.contains("rs-activity") && headTxt() === "Activity" && panel.dataset.cardsTab === "activity" && /What the AI ran/.test(subTxt()), headTxt() + " / " + subTxt());
  ok("render: Activity head = .rs-template-head + count 0 + disabled Clear pill", panel.querySelector(".rs-activity .rs-template-head .rs-template-count") && panel.querySelector(".rs-activity .rs-template-head .rs-template-count").textContent === "0" && panel.querySelector("#rs-cards-clear.rs-btn-secondary[disabled]"));
  ok("render: Activity empty state = .rs-template-empty", !!panel.querySelector(".rs-activity .rs-template-empty .rs-template-empty-mark"));
  w.__rsTrackCard("create_part", "run", "executing…", "roblox");
  w.__rsTrackCard("create_part", "ok", "Part 'Floor' created in Workspace", "roblox");
  w.__rsTrackCard("execute_luau", "err", "attempt to index nil", "tool");
  await sleep(60);
  const rows = panel.querySelectorAll(".rs-activity .rs-template-list > .rs-template-row.rs-activity-row");
  ok("render: tool results become .rs-template-row.rs-activity-row cards (newest first)", rows.length === 2 && rows[0].classList.contains("rs-card-err") && rows[1].classList.contains("rs-card-done"), String(rows.length));
  ok("render: activity row has icon + mono title + detail + status/time meta", rows.length && rows[1].querySelector(".rs-card-icon") && rows[1].querySelector("b.rs-card-title").textContent === "create_part" && /Floor/.test(rows[1].querySelector("p.rs-card-detail").textContent) && rows[1].querySelector(".rs-card-meta .rs-card-status").textContent === "Done" && /ago$/.test(rows[1].querySelector(".rs-card-time").textContent));
  ok("render: head counts show 1 ok / 1 err and Clear is enabled", panel.querySelector(".rs-template-head .rs-cards-count") && panel.querySelector(".rs-template-head .rs-cards-count.err") && !panel.querySelector("#rs-cards-clear").disabled);
  panel.querySelector("#rs-cards-clear").click(); await sleep(80);
  ok("render: Clear empties the Activity tab again", !!panel.querySelector(".rs-activity .rs-template-empty"));

  panel.querySelector('[data-tab="public"]').click(); await sleep(120);
  ok("render: Public tab → same shell, heading 'Public Skills'", shell() && shell().classList.contains("rs-public") && headTxt() === "Public Skills" && panel.dataset.cardsTab === "public", headTxt());
  ok("render: Public head uses the same .rs-template-head + head actions", !!panel.querySelector(".rs-public .rs-template-head .rs-template-head-actions button"));

  panel.querySelector('[data-tab="library"]').click(); await sleep(80);
  ok("render: back to Library restores the Templates heading", headTxt() === "Templates" && panel.dataset.cardsTab === "library");
  ok("render: no page errors while switching tabs", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  finish();
  setTimeout(() => process.exit(process.exitCode || 0), 50);
}
