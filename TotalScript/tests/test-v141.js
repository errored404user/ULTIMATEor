#!/usr/bin/env node
// 1.41.0 — Workspace panel: the Templates tray is a two-column workspace
// (left rail with brand / title / icon nav / tip, content column) and every
// tab got a reworked layout on the same hooks:
//   Activity → status filters + timeline + "Ask the AI to fix it" on failures
//   Tasks    → progress ring, Next-up card, Open/Done filters, hover actions
//   Public   → Create hero + side guide, kind filters, kind-coloured cards
//   Library  → sticky toolbar, denser cards
// Every pre-1.41 hook (ids, data-* attributes, row classes) is unchanged, so
// the older panel tests keep passing untouched. String checks always run; the
// jsdom walk runs when jsdom is installed.
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = process.env.TOTALSCRIPT_ROOT || path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const main = read("src/core/main.js");
const css = read("overlay.css");
const readme = read("README.md");
const results = []; const ok = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  — " + extra : "")); if (!cond) process.exitCode = 1; };
let JSDOM = null; try { ({ JSDOM } = require("jsdom")); } catch {}

// ── A. shell ──
ok("rail: tip + optional 'turn on the task list' link rendered after the tabs", /<div class="rs-cards-rail-foot"><span class="rs-cards-rail-tip">' \+ railTip \+ '<\/span>'/.test(main) && /data-cards-enable-tasks/.test(main) && /const railTip = cardsTab === "activity"/.test(main));
ok("rail link enables the task list and jumps to the Tasks tab", /enableTasks\.onclick = [^\n]*setTaskList\(true\); cardsTab = "tasks"; renderCards\(panel\);/.test(main));
ok("heading / tabs / brand markup unchanged (older pins)", /rs-cards-heading">' \+ tabHead\[0\] \+ '<\/span><span class="rs-cards-subheading">/.test(main) && main.includes('data-tab="library"') && main.includes('data-tab="activity"') && main.includes('data-tab="public"') && main.includes('data-tab="tasks"'));
const sec = css.slice(css.indexOf("§15 · 1.41.0 Workspace panel"));
ok("overlay.css §15 exists and is the last panel block", sec.length > 6000 && !/§16/.test(sec));
ok("§15: two-column grid (rail + content), rail stacks under 860px", /#rs-cards-panel\[data-cards-tab\] \{[^}]*grid-template-columns: var\(--cp-rail\) minmax\(0, 1fr\) !important/.test(sec) && /@media \(max-width: 860px\) \{\s*#rs-cards-panel\[data-cards-tab\],[^{]*\{ grid-template-columns: minmax\(0, 1fr\) !important/.test(sec));
ok("§15: vertical nav with SVG mask icons per tab + count pills", /\.rs-cards-tabs \{[^}]*flex-direction: column !important/.test(sec) && ['[data-tab="library"]', '[data-tab="activity"]', '[data-tab="public"]', '[data-tab="tasks"]'].every((t) => sec.includes(".rs-cards-tab" + t + " { --tab-ico: url(")) && /\.rs-cards-tab b \{[^}]*border-radius: 999px/.test(sec));
ok("§15 selectors use [data-cards-tab] so they outrank the earlier :has(.rs-template-library) layers", (sec.match(/#rs-cards-panel\[data-cards-tab\]/g) || []).length > 100 && !/#rs-cards-panel \./.test(sec));
ok("§15: body still scrolls (test-v137 contract)", /> \.rs-cards-body \{[^}]*overflow-y: auto !important/.test(sec));
ok("earlier sections untouched", css.includes("11. 1.34.1 — Cards panel: ONE design") && css.includes("12. 1.37.0 — Templates tray XL") && css.includes("1.40.0 Beginner mode"));

// ── B. Activity ──
ok("Activity: filter state helper + chips All/Done/Failed/Running", /var cardsActFilter = "all"/.test(main) && /function activityFilterState\(\)/.test(main) && /chip\("all", "All", all\.length\) \+ chip\("ok", "Done", okAll\) \+ chip\("err", "Failed", errAll\) \+ chip\("run", "Running", runAll\)/.test(main));
ok("Activity: up to 40 rows, failed rows carry data-act-ask", /return \{ shown: filtered\.slice\(0, 40\), filters \};/.test(main) && /const fix = c\.status === "err" \? '<div class="rs-template-actions rs-act-actions"><button type="button" class="rs-template-run" data-act-ask="' \+ realIdx/.test(main));
ok("Activity: Ask-the-AI drafts a fix request via pasteLibraryCard and closes the panel", /const actAsk = e\.target\.closest && e\.target\.closest\("\[data-act-ask\]"\);/.test(main) && /pasteLibraryCard\(\{ title: "Fix " \+ c\.tool, prompt: `The command \$\{c\.tool\} failed with:/.test(main) && /if \(okP\) \{ setCardsOpen\(false\);/.test(main));
ok("Activity: row model + head/count/Clear unchanged (test-v1341 pins)", /rs-template-row rs-activity-row rs-card rs-card-' \+ cls/.test(main) && /<button id="rs-cards-clear" type="button" class="rs-btn-secondary"' \+ \(recentCards\.length \? "" : " disabled"\)/.test(main));
ok("§15: timeline rail + status dots + pulsing running dot", /\.rs-activity-list::before \{[^}]*width: 2px/.test(sec) && /\.rs-activity-row\.rs-card-done::after \{ background: var\(--cp-ok\)/.test(sec) && /@keyframes rs-act-pulse/.test(sec));

// ── C. Tasks ──
ok("Tasks: filters All/Open/Done + progress ring + Next-up card", /var cardsTaskFilter = "all"/.test(main) && /tchip\("all", "All", p\.total\)\}\$\{tchip\("open", "Open", p\.open\)\}\$\{tchip\("done", "Done", p\.done \+ p\.skipped\)\}/.test(main) && /<svg class="rs-task-ring" viewBox="0 0 36 36"/.test(main) && /<div class="rs-task-next" data-task-id="\$\{escRs\(nextT\.id\)\}">/.test(main));
ok("Tasks: Next-up card reuses the row actions (run / toggle / skip) through data-task-id delegation", /rs-task-next[^\n]*data-task-action="run">Run with AI<\/button><button type="button" data-task-action="toggle">Mark done<\/button><button type="button" data-task-action="skip">Skip<\/button>/.test(main) && /const row=e\.target\.closest&&e\.target\.closest\("\[data-task-id\]"\);/.test(main));
ok("Tasks: rows / add form / tools / disable unchanged (test-tasklist pins)", main.includes('class="rs-task-row rs-task-${t.status}" data-task-id="${escRs(t.id)}"') && main.includes('<form class="rs-task-add" data-task-add-form>') && main.includes("[data-task-disable]"));
ok("§15: ring, next card, hover-reveal actions", /\.rs-task-ring-fg \{ stroke: var\(--totalx-a/.test(sec) && /\.rs-task-next \{/.test(sec) && /\.rs-task-actions \{ opacity: \.25/.test(sec) && /\.rs-task-row:hover \.rs-task-actions[^{]*\{ opacity: 1; \}/.test(sec));

// ── D. Public ──
ok("Public: kind filters + two-column create zone + Import in the head", /var cardsPublicFilter = "all"/.test(main) && /pchip\("all", "All", allItems\.length\)\}\$\{pchip\("skill", "Skills", kcount\("skill"\)\)\}\$\{pchip\("ability", "Abilities", kcount\("ability"\)\)\}\$\{pchip\("mode", "Work modes", kcount\("mode"\)\)\}/.test(main) && /<div class="rs-public-grid"><div class="rs-public-side"><ol class="rs-public-ways">/.test(main) && /<div class="rs-public-compose" data-public-drop><div class="rs-public-compose-head"><b>Create one<\/b>/.test(main) && /rs-template-head-actions"><button type="button" class="rs-btn-secondary" data-public-import>Import file \/ code…<\/button><button type="button" class="rs-btn-secondary" data-public-manual>New by hand<\/button>/.test(main));
ok("Public: ways / share box / composer / save-as-is / load hooks unchanged", main.includes("rs-public-sharebox") && main.includes("[data-public-save-text]") && main.includes("[data-public-load-text]") && main.includes('id="rs-public-prompt"') && main.includes("[data-public-export-all]"));
ok("Public: filter click handlers wired", /const pubF = e\.target\.closest && e\.target\.closest\("\[data-public-filter\]"\);/.test(main) && /const taskF = e\.target\.closest && e\.target\.closest\("\[data-task-filter\]"\);/.test(main) && /const actF = e\.target\.closest && e\.target\.closest\("\[data-act-filter\]"\);/.test(main));
ok("§15: kind-coloured cards (skill blue / ability purple / mode amber), active mode glow, card grid", /--cp-skill: #60a5fa; --cp-ability: #c084fc; --cp-mode: #f59e0b/.test(sec) && /\.rs-public-row:has\(\.rs-public-kind-ability\) \{ --kind: var\(--cp-ability\); \}/.test(sec) && /\.rs-public-row:has\(\.rs-public-active\)/.test(sec) && /\.rs-public-list \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(360px, 1fr\)\)/.test(sec));

// ── E. Library + version ──
ok("§15: sticky library toolbar + card hover lift", /\.rs-template-controls \{ position: sticky; top: 0; z-index: 3;/.test(sec) && /\.rs-template-card:hover \{ transform: translateY\(-2px\)/.test(sec));
const mf = JSON.parse(read("manifest.json"));
const semver = (v) => String(v).split(".").map(Number).reduce((acc, x, i) => acc + x * [1e6, 1e3, 1][i], 0);
const V = mf.version;
ok("manifest is a release at or above 1.41.1", /^\d+\.\d+\.\d+$/.test(V) && semver(V) >= 1041001, V);
ok("plugin + crate pinned to the manifest version", read("plugin/TotalScript.lua").includes(`local VERSION = "${V}"`) && read("agent/Cargo.toml").includes(`version = "${V}"`) && read("agent/Cargo.lock").includes(`name = "total-agent"\nversion = "${V}"`));
ok("README changelog + test listed", readme.includes("**1.41.0 — Workspace panel.**") && readme.includes("**1.41.1 — Workspace panel: rail stays in its column.**") && readme.includes("node tests/test-v141.js") && readme.includes("(`total-agent` " + V + ")"));
// 1.41.1 — the §12 open-state rule (#rs-bar.rs-cards-open #rs-cards-panel, specificity 2-1-0) forces
// display:flex/column; the grid must be declared at >= 2-2-0 or the rail stacks on top of the content.
ok("§15 declares the grid on the open-state selectors too (outranks §12's display:flex)", /#rs-cards-panel\[data-cards-tab\],\s*#rs-bar\.rs-cards-open #rs-cards-panel\[data-cards-tab\],\s*#rs-bar\.rs-bar-inline\.rs-cards-open #rs-cards-panel\[data-cards-tab\],\s*#rs-bar\.rs-tray-below\.rs-cards-open #rs-cards-panel\[data-cards-tab\] \{\s*display: grid !important;\s*flex-direction: unset !important;\s*grid-template-columns: var\(--cp-rail\) minmax\(0, 1fr\) !important/.test(sec) && /#rs-bar\.rs-cards-open #rs-cards-panel\[data-cards-tab\] > \.rs-cards-top,\s*#rs-bar\.rs-cards-open #rs-cards-panel\[data-cards-tab\] > \.rs-cards-body \{ flex: unset !important; min-height: 0 !important;/.test(sec));
ok("§15: narrow stack also declared on the open-state selectors", /@media \(max-width: 860px\) \{\s*#rs-cards-panel\[data-cards-tab\],\s*#rs-bar\.rs-cards-open #rs-cards-panel\[data-cards-tab\],\s*#rs-bar\.rs-bar-inline\.rs-cards-open #rs-cards-panel\[data-cards-tab\] \{ grid-template-columns: minmax\(0, 1fr\) !important/.test(sec));
ok("§15: rail text is not force-uppercased (Turkish-locale İ)", /\.rs-cards-tab \{[^}]*text-transform: none !important/.test(sec) && /\.rs-cards-heading \{[^}]*text-transform: none !important/.test(sec) && /\.rs-cards-kicker \{[^}]*text-transform: none !important/.test(sec));

if (!JSDOM) { console.log("SKIP  jsdom walk (jsdom not installed)"); finish(); } else { render().catch((e) => { ok("jsdom walk completed", false, String(e && e.stack || e)); finish(); }); }
function finish() { const failed = results.filter((r) => !r[1]); console.log(`\n${results.length - failed.length}/${results.length} checks passed`); if (failed.length) { console.log("FAILURES:"); failed.forEach((r) => console.log("  - " + r[0])); } process.exit(failed.length ? 1 : 0); }

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
  ok("walk: panel opens with rail (brand + heading + nav + tip) and content column", panel && !panel.hidden && panel.querySelector(".rs-cards-top .rs-cards-brand .rs-cards-heading") && panel.querySelectorAll(".rs-cards-top .rs-cards-tabs .rs-cards-tab").length >= 3 && panel.querySelector(".rs-cards-top .rs-cards-rail-foot .rs-cards-rail-tip") && panel.querySelector(".rs-cards-body > .rs-template-library"));
  ok("walk: task list off → rail offers 'Turn on the task list' and there is no Tasks tab", !!panel.querySelector("[data-cards-enable-tasks]") && !panel.querySelector('.rs-cards-tab[data-tab="tasks"]'));
  const tab = (t) => { const b = panel.querySelector(`.rs-cards-tab[data-tab="${t}"]`); b.click(); };
  // Activity
  tab("activity"); await sleep(60);
  ok("walk: empty Activity has no filter chips", !panel.querySelector(".rs-act-filters"));
  w.__rsTrackCard("create_part", "ok", "Part 'Floor' created", "roblox");
  w.__rsTrackCard("execute_luau", "err", "attempt to index nil", "tool");
  w.__rsTrackCard("inspect_instance", "run", "reading…", "read");
  await sleep(80);
  const chips = [...panel.querySelectorAll(".rs-act-filters .rs-act-chip")];
  ok("walk: Activity shows All 3 / Done 1 / Failed 1 / Running 1 chips", chips.map((c) => c.dataset.actFilter + ":" + c.querySelector("i").textContent).join(",") === "all:3,ok:1,err:1,run:1", chips.map((c) => c.textContent).join(","));
  ok("walk: failed row carries 'Ask the AI to fix it', ok row does not", panel.querySelector(".rs-activity-row.rs-card-err [data-act-ask]") && !panel.querySelector(".rs-activity-row.rs-card-done [data-act-ask]"));
  chips.find((c) => c.dataset.actFilter === "err").click(); await sleep(60);
  const errRows = panel.querySelectorAll(".rs-activity-row");
  ok("walk: Failed filter leaves only the failed row, chip is on", errRows.length === 1 && errRows[0].classList.contains("rs-card-err") && panel.querySelector('.rs-act-chip[data-act-filter="err"]').classList.contains("on"));
  const ta = d.getElementById("cc-input");
  panel.querySelector("[data-act-ask]").click(); await sleep(80);
  ok("walk: Ask-the-AI drafts the fix request into the composer and closes the panel", /execute_luau failed with: "attempt to index nil"/.test(ta.value) && panel.hidden === true, ta.value.slice(0, 80));
  ta.value = "";
  cardsBtn.click(); await sleep(100);
  panel.querySelector('.rs-act-chip[data-act-filter="all"]').click(); await sleep(60);
  // Public
  tab("public"); await sleep(60);
  ok("walk: Public has the two-column create zone (compose + side guide) and Import in the head", panel.querySelector(".rs-public .rs-public-grid > .rs-public-compose[data-public-drop] .rs-public-compose-head") && panel.querySelectorAll(".rs-public .rs-public-grid > .rs-public-side .rs-public-ways li").length === 3 && panel.querySelector(".rs-public .rs-template-head-actions [data-public-import]"));
  const PS = w.PublicSkills;
  const inst = PS.upsert({ kind: "ability", name: "audit_scripts", title: "Audit scripts", description: "Audits every script for deprecated APIs and fixes them.", params: [], instructions: "Audit and fix.", steps: ["Find", "Fix"], commands: ["script_read"] }, { source: "manual" });
  const inst2 = PS.upsert({ kind: "mode", name: "horror_builder", title: "Horror builder", badge: "HORROR", base: "creation", sub: "Fog and dread", note: "Horror", description: "A horror-focused work mode with fog, flicker and sound.", mandate: "You are a horror level builder. Priorities: atmosphere. Pipeline: plan, build, verify.", focus: ["part_create"] }, { source: "manual" });
  tab("public"); await sleep(80);
  const pchips = [...panel.querySelectorAll(".rs-public-filters .rs-act-chip")];
  ok("walk: two installed items → kind chips All 2 / Skills 0 / Abilities 1 / Work modes 1", inst.ok && inst2.ok && pchips.map((c) => c.dataset.publicFilter + ":" + c.querySelector("i").textContent).join(",") === "all:2,skill:0,ability:1,mode:1", JSON.stringify([inst.ok || inst.errors, inst2.ok || inst2.errors, pchips.map((c) => c.textContent)]));
  pchips.find((c) => c.dataset.publicFilter === "mode").click(); await sleep(60);
  ok("walk: Work-modes filter leaves the mode card only", panel.querySelectorAll(".rs-public-list .rs-public-row").length === 1 && panel.querySelector(".rs-public-list .rs-public-row .rs-public-kind-mode"));
  panel.querySelector('.rs-act-chip[data-public-filter="all"]').click(); await sleep(60);
  // Tasks (enable through the rail link)
  panel.querySelector("[data-cards-enable-tasks]").click(); await sleep(120);
  ok("walk: rail link turns the task list on and opens the Tasks tab", panel.dataset.cardsTab === "tasks" && panel.querySelector('.rs-cards-tab[data-tab="tasks"].on') && panel.querySelector(".rs-tasks .rs-task-ring"));
  ok("walk: empty task list → no Next-up card, no filters", !panel.querySelector(".rs-task-next") && !panel.querySelector(".rs-task-filters"));
  const TL = w.TotalTaskList;
  // the add box auto-focuses and re-renders are held while an editor in the
  // panel has focus (1.35.0) - blur it like a user clicking elsewhere would.
  const blur = () => { try { if (d.activeElement && panel.contains(d.activeElement)) d.activeElement.blur(); } catch {} };
  blur();
  TL.add("Create a part named SimPart"); TL.add("Add a PointLight to it"); TL.add("Write a save script");
  await sleep(600);
  const nextCard = panel.querySelector(".rs-task-next");
  ok("walk: Next-up card names task #1 with Run / Mark done / Skip, filters All 3 / Open 3 / Done 0", nextCard && /#1 Create a part named SimPart/.test(nextCard.querySelector("b").textContent) && nextCard.querySelector('[data-task-action="run"]') && nextCard.querySelector('[data-task-action="toggle"]') && [...panel.querySelectorAll(".rs-task-filters .rs-act-chip")].map((c) => c.querySelector("i").textContent).join("/") === "3/3/0", nextCard && nextCard.textContent.slice(0, 80));
  nextCard.querySelector('[data-task-action="toggle"]').click(); blur(); await sleep(600);
  const next2 = panel.querySelector(".rs-task-next");
  ok("walk: Mark done on the Next-up card ticks #1 and advances to #2; ring + count update", TL.list()[0].status === "done" && next2 && /#2 Add a PointLight/.test(next2.querySelector("b").textContent) && panel.querySelector(".rs-tasks .rs-template-count").textContent === "1/3" && /stroke-dasharray:3[23]\./.test(panel.querySelector(".rs-task-ring-fg").getAttribute("style")), panel.querySelector(".rs-task-ring-fg").getAttribute("style"));
  panel.querySelector('.rs-act-chip[data-task-filter="done"]').click(); blur(); await sleep(80);
  ok("walk: Done filter shows only the finished row", panel.querySelectorAll(".rs-task-list .rs-task-row").length === 1 && panel.querySelector(".rs-task-list .rs-task-row.rs-task-done"));
  panel.querySelector('.rs-act-chip[data-task-filter="open"]').click(); blur(); await sleep(80);
  ok("walk: Open filter shows the two open rows", panel.querySelectorAll(".rs-task-list .rs-task-row").length === 2);
  // Library still intact
  tab("library"); await sleep(60);
  ok("walk: Library tab still renders controls → grid → idea generator", panel.querySelector(".rs-cards-body > .rs-template-library > .rs-template-controls") && panel.querySelector("#rs-cards-grid-wrap") && panel.querySelector(".rs-idea-generator"));
  ok("walk: no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  finish();
}
