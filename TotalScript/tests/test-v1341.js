// 1.34.1 / 1.34.2 — Cards panel consistency + Templates gallery: Library / Activity / Public / Tasks share one
// shell (.rs-template-library header + .rs-template-row rows), the panel heading
// names the open tab, and overlay.css section 11 maps every tab onto the same
// row model + theme pill buttons. String checks always run; the jsdom render
// part runs when jsdom is installed (cd TotalScript && npm i --no-save jsdom).
const fs = require("fs");
const path = require("path");
const ROOT = process.env.TOTALSCRIPT_ROOT || path.join(__dirname, "..");
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
ok("every button in the panel is a 36px pill; primaries use the theme gradient, the rest the ghost pill", /\.rs-template-library button:not\(\.rs-cards-tab\)[^{]*\{[^}]*min-height: 36px !important;[^}]*border-radius: var\(--cp-r-ctl\)/.test(sec) && /button\[data-public-create\],\s*html\[data-rs-theme\] #rs-cards-panel \.rs-template-library button\[data-public-import\],\s*html\[data-rs-theme\] #rs-cards-panel \.rs-template-library button\[data-task-run-all\] \{\s*background: var\(--totalx-grad\)/.test(sec) && /background: linear-gradient\(180deg, var\(--totalx-ghost-hi\), var\(--totalx-ghost\)\) !important;\s*color: var\(--totalx-ghost-fg\)/.test(sec));
ok("inputs / selects / textarea are 40px wells with accent focus ring", /#rs-cards-panel \.rs-template-library select \{ height: 40px !important/.test(sec) && /textarea:focus \{[^}]*box-shadow: 0 0 0 3px color-mix/.test(sec));
ok("Public: ways, share box, composer, kind badges on the same tokens", /\.rs-public-ways li \{[^}]*border-radius: var\(--cp-r\)/.test(sec) && /\.rs-public-sharebox \{[^}]*border-radius: var\(--cp-r\)/.test(sec) && /\.rs-public-compose \{[^}]*border-radius: var\(--cp-r\)/.test(sec) && /\.rs-public-kind, #rs-cards-panel \.rs-public-active, #rs-cards-panel \.rs-public-disabled \{[^}]*height: 22px/.test(sec) && /\.rs-public-kind-mode\s*\{ color: #ffd37a/.test(sec));
ok("Tasks: rows, check box, add form, progress bar on the same tokens", /\.rs-task-row \{[^}]*border-radius: var\(--cp-r\)/.test(sec) && /\.rs-task-check \{ width: 26px/.test(sec) && /\.rs-task-text \{ font-size: 14px/.test(sec) && /\.rs-task-progress span \{ background: var\(--totalx-grad/.test(sec) && /\.rs-task-actions button \{ min-height: 32px/.test(sec));
ok("Idea generator + Session view restyled with the same card language", /\.rs-idea-generator \{[^}]*border-radius: var\(--cp-r\)/.test(sec) && /\.rs-idea-generator select \{ height: 40px/.test(sec) && /\.rs-session \.rs-cards-title \{ font-size: 16px/.test(sec));
ok("responsive + reduced-motion rules for the unified panel", /@media \(max-width: 720px\) \{\s*#rs-cards-panel \{ --cp-x: 12px; \}/.test(sec) && /prefers-reduced-motion: reduce\) \{\s*#rs-cards-panel \.rs-template-library button/.test(sec));
ok("legacy classes the tests/handlers rely on still exist in the markup", main.includes('#rs-cards-clear') && main.includes("rs-card-title") && main.includes("rs-card-detail") && main.includes("rs-cards-count") && css.includes(".rs-public-compose") && css.includes(".rs-task-row"));

// ── 1.34.2 — Templates gallery ──
ok("1.34.2: Library renders header → toolbar → category chips → gallery → Idea Generator (generator no longer on top)", /<section class="rs-template-library" aria-label="Template library"><div class="rs-template-controls"><header/.test(main) && /\$\{templateChipsHtml\(\)\}<\/div><div id="rs-cards-grid-wrap">\$\{gridHtml\(\)\}<\/div>\$\{ideaGeneratorHtml\(\)\}<\/section>/.test(main));
ok("1.34.2: cards carry a type tile + type/category/env/commands/version badges + updated date", /function templateCardHtml\(c,i\)/.test(main) && /rs-template-row rs-template-card" data-prompt-index="\$\{i\}" data-template-type=/.test(main) && /<div class="rs-template-ico" aria-hidden="true">\$\{glyph\}<\/div>/.test(main) && /<i class="rs-tag rs-tag-type">\$\{typeLabel\}<\/i>/.test(main) && /<i class="rs-tag rs-tag-env">/.test(main) && /command\$\{cmdN===1\?"":"s"\}/.test(main) && /<time>Updated /.test(main));
ok("1.34.2: one primary Run + Edit + ⋯ menu (Improve with AI, Copy, Export, Archive/Restore, Delete)", /<button type="button" class="rs-template-run" data-template-action="run">Run template<\/button><button type="button" data-template-action="open">Edit<\/button><details class="rs-template-more"><summary aria-label="More actions" title="More actions">(?:\u22EF|\\u22EF)<\/summary><div><button type="button" class="rs-template-improve" data-template-action="improve">Improve with AI<\/button><button type="button" data-template-action="duplicate">Copy<\/button>/.test(main));
ok("1.34.2: category chips with counts drive the same filter as the select (both stay in sync)", /function templateChipsHtml\(\)/.test(main) && /data-template-chip="\$\{escRs\(x\)\}" class="\$\{cardsCategory===x\?"on":""\}" aria-pressed=/.test(main) && /const applyTemplateCategory=\(value\)=>\{cardsCategory=value;/.test(main) && /if\(sel&&sel\.value!==value\)sel\.value=value;/.test(main) && /b\.classList\.toggle\("on",on\)/.test(main));
ok("1.34.2: empty state distinguishes 'no match' from 'no templates yet'", /No templates match/.test(main) && /No templates yet\. Create your first template/.test(main));
ok("1.34.2: Idea Generator has a titled head", /<div class="rs-idea-head"><div class="rs-idea-mark" aria-hidden="true">\u2726<\/div><div><b>Idea Generator<\/b>/.test(main));
const sec12 = css.slice(css.indexOf("── 12. 1.34.2"));
ok("1.34.2: overlay.css section 12 — gallery grid, type-coloured cards, chips, footer actions, idea strip", sec12.length > 3000 && /\.rs-template-gallery \{ display: grid !important; grid-template-columns: repeat\(auto-fill, minmax\(340px, 1fr\)\)/.test(sec12) && /\.rs-template-card\[data-template-type="roblox"\]\s*\{ --card-accent: var\(--tt-roblox\); \}/.test(sec12) && /#rs-cards-panel \.rs-template-ico \{/.test(sec12) && /\.rs-template-chips button\.on \{\s*background: var\(--totalx-grad\)/.test(sec12) && /\.rs-template-card \.rs-template-run \{ flex: 1 1 auto/.test(sec12) && /\.rs-template-card \.rs-template-more > summary \{\s*width: 38px/.test(sec12) && /#rs-cards-panel \.rs-idea-head \{/.test(sec12) && /@media \(max-width: 760px\) \{\s*#rs-cards-panel \.rs-template-gallery \{ grid-template-columns: 1fr !important; \}/.test(sec12));
ok("1.34.2: search field gets an inline magnifier and the toolbar loses its dark band", /#rs-cards-search \{\s*padding-left: 40px !important;\s*background-image: url\("data:image\/svg\+xml/.test(sec12) && /\.rs-template-toolbar \{[^}]*background: transparent !important; border-bottom: 0 !important;/.test(sec12));

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
  const R = w.TotalTemplateRegistry;
  const made = [];
  for (const t of [
    { name: "Boss arena", description: "Circular arena with pillars, neon ring and a throne platform.", type: "roblox", category: "Building", environment: "ROBLOX_STUDIO", instructions: ["Build a 120-stud circular floor"], workflow: [{ title: "Floor", command: "part_create" }, { title: "Ring", command: "part_create" }] },
    { name: "Shop UI", description: "A responsive shop ScreenGui with a currency label.", type: "ui", category: "UI", environment: "ROBLOX_STUDIO", instructions: ["Create the ScreenGui"] },
    { name: "Daily brief", description: "Prompt that summarises the place and proposes next steps.", type: "prompt", category: "Planning", environment: "GENERAL", instructions: ["Summarise"] },
  ]) { const r = await R.createTemplate(t); made.push(r); }
  ok("render: three templates created in the registry (roblox / ui / prompt)", made.every((r) => r && r.success), JSON.stringify(made.filter((r) => !r.success).map((r) => r.error)));
  const cardsBtn = await waitFor(() => d.getElementById("rs-cards-btn"), 4000, "cards button");
  cardsBtn.click(); await sleep(150);
  const panel = d.getElementById("rs-cards-panel");
  ok("render: cards panel opens", panel && !panel.hidden);
  // 1.73.0 — the templates button opens the panel in the centred Templates
  // window (#rs-cards-window) and the Library tab IS the embedded Template
  // Creator (#rs-tcreator.rst-embedded): list of saved templates on the left,
  // form on the right. The gallery/chips/idea-generator strip of 1.34.1 only
  // remains in the bar-attached fallback tray.
  const win = d.getElementById("rs-cards-window");
  ok("render: panel lives inside the centred Templates window (not the bar)", win && win.classList.contains("open") && win.contains(panel) && !d.getElementById("rs-bar").contains(panel) && d.documentElement.classList.contains("rs-cards-window-open"));
  const slot = panel.querySelector(".rs-cards-body > .rs-cards-creator-slot");
  const creator = slot && slot.querySelector("#rs-tcreator.rst-embedded.open");
  ok("render: Library tab = embedded Template Creator (rail + creator slot)", !!creator && panel.querySelector(":scope > .rs-cards-top .rs-cards-tab.on[data-tab=\"library\"]") && w.TotalTemplateCreator.isOpen() && w.TotalTemplateCreator.state().embedded === true);
  await waitFor(() => creator.querySelectorAll(".rst-list > .rst-card").length === 3, 3000, "creator list");
  const cards = creator.querySelectorAll(".rst-list > .rst-card");
  ok("render: the three templates render as creator cards with name, category badge, meta and Run/Edit/Duplicate/Export/Archive/Delete", cards.length === 3 && [...cards].every((c) => c.querySelector(".rst-card-top b") && c.querySelector(".rst-badge") && c.querySelector(".rst-card-meta") && ["run","edit","duplicate","export","archive","delete"].every((a) => c.querySelector('.rst-card-actions [data-act="' + a + '"]'))), String(cards.length));
  const boss = [...cards].find((c) => /Boss arena/.test(c.textContent));
  ok("render: roblox card shows its category badge 'Building' and the blank/step counts", boss && boss.querySelector(".rst-badge").textContent === "Building" && /2 steps/.test(boss.querySelector(".rst-card-meta").textContent), boss && boss.querySelector(".rst-card-meta").textContent);
  ok("render: list count pill = 3", creator.querySelector(".rst-count").textContent === "3");
  const search = creator.querySelector(".rst-search");
  search.value = "shop"; search.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(60);
  ok("render: searching 'shop' filters the list to 1 card", creator.querySelectorAll(".rst-list > .rst-card").length === 1 && /Shop UI/.test(creator.querySelector(".rst-list").textContent));
  search.value = ""; search.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(60);
  const archived = creator.querySelector(".rst-archived");
  archived.checked = true; archived.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(60);
  ok("render: Archived toggle (empty) shows the 'Nothing archived' state", /Nothing archived/.test(creator.querySelector(".rst-list").textContent));
  archived.checked = false; archived.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(60);
  ok("render: toggling back restores the 3 cards", creator.querySelectorAll(".rst-list > .rst-card").length === 3);
  const boss2 = [...creator.querySelectorAll(".rst-list > .rst-card")].find((c) => /Boss arena/.test(c.textContent)); // list re-rendered by the toggles
  boss2.querySelector('[data-act="edit"]').click(); await sleep(60);
  ok("render: Edit loads the template into the form (name field, selected card)", creator.querySelector(".rst-form").elements.name.value === "Boss arena" && creator.querySelector(".rst-list > .rst-card.on") && /Boss arena/.test(creator.querySelector(".rst-list > .rst-card.on").textContent));
  ok("render: the AI-draft sentence row and the blank/step editors are part of the Library", !!creator.querySelector(".rst-sentence") && !!creator.querySelector(".rst-draft") && !!creator.querySelector(".rst-blank-rows") && !!creator.querySelector(".rst-step-rows"));
  // panel re-renders (tab click, template sync, activity on this tab) rebuild
  // the rail only - the creator host and the form survive
  const hostBefore = creator;
  panel.querySelector('[data-tab="library"]').click(); await sleep(80);
  ok("render: a panel re-render keeps the same creator element mounted with its form intact (typing is never interrupted)", panel.querySelector("#rs-tcreator") === hostBefore && hostBefore.isConnected && creator.querySelector(".rst-form").elements.name.value === "Boss arena");
  const headTxt = () => (panel.querySelector(".rs-cards-heading") || {}).textContent;
  const subTxt = () => (panel.querySelector(".rs-cards-subheading") || {}).textContent || "";
  const shell = () => panel.querySelector(".rs-cards-body > .rs-template-library");
  ok("render: Library tab → rail heading 'Templates' + data-cards-tab=library", headTxt() === "Templates" && panel.dataset.cardsTab === "library", headTxt());

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
  ok("render: back to Library restores the Templates heading and re-mounts the creator", headTxt() === "Templates" && panel.dataset.cardsTab === "library" && panel.querySelector(".rs-cards-creator-slot > #rs-tcreator.rst-embedded"));
  // close: Esc → window closes, panel hidden, bar visible again
  win.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(60);
  ok("render: Escape closes the Templates window (panel hidden, html class cleared, creator closed)", !win.classList.contains("open") && panel.hidden && !d.documentElement.classList.contains("rs-cards-window-open") && !w.TotalTemplateCreator.isOpen());
  cardsBtn.click(); await sleep(120);
  ok("render: the templates button re-opens the window", win.classList.contains("open") && !panel.hidden);
  ok("render: no page errors while switching tabs", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  finish();
  setTimeout(() => process.exit(process.exitCode || 0), 50);
}
