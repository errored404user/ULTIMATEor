#!/usr/bin/env node
// 2.0.0 — Explorer & Inspector panel: pure-module checks for
// src/core/explorer.js (probes, state machine, render, target brief) plus the
// main.js / manifest / codecraft.html / overlay.css wiring pins. Run from the
// TotalScript root:
//   node tests/test-explorer.js
// Mocked only: no Studio is involved (tests/explorer-sim.py executes the probe
// Luau on the lupa DataModel).
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); } };

const X = require(path.join(ROOT, "src/core/explorer.js"));
const main = read("src/core/main.js");
const css = read("overlay.css");
const manifest = JSON.parse(read("manifest.json"));
const html = read("codecraft.html");

// ── module surface ──────────────────────────────────────────────────────────
ok("A1 TotalExplorer VERSION 2.0.0, frozen, Workspace first in ROOTS, caps 200 / 60", X.VERSION === "2.0.0" && Object.isFrozen(X) && X.ROOTS[0] === "Workspace" && X.ROOTS.includes("StarterGui") && X.CHILD_CAP === 200 && X.SEARCH_CAP === 60);
const probes = [X.rootLua(), X.childrenLua("Workspace.Hero"), X.propsLua("Workspace.Hero"), X.searchLua("crate")];
ok("A2 read-only probes: marked, JSONEncode, no Instance.new / Destroy / Source = / Parent =", probes.every((c) => c.startsWith(X.PROBE_MARK) && /return hs:JSONEncode\(/.test(c) && !/Instance\.new|:Destroy\(|\.Source\s*=|\.Parent\s*=/.test(c)));
ok("A3 probe Luau stays plain Lua (no +=, no continue) so the lupa sim can run it", probes.concat([X.selectLua("Workspace.X")]).every((c) => !/\+=/.test(c) && !/\bcontinue\b/.test(c)));
ok("A4 the probe mark matches the mode-probe convention (read-only, excluded by harnesses)", /^-- TotalScript explorer probe \(read-only\)$/.test(X.PROBE_MARK));
ok("A5 paths are quoted safely (quotes / backslashes / newlines escaped)", /resolve\('It\\'s\\\\n\\n'\)/.test(X.childrenLua("It's\\n\n")) && /local q='a\\'b'/.test(X.searchLua("A'B")));
ok("A6 childrenLua clamps the cap to [1, 200] and searchLua lower-cases the query", /if i>200 then/.test(X.childrenLua("Workspace", 9999)) && /if i>1 then/.test(X.childrenLua("Workspace", -4)) && /local q='crate'/.test(X.searchLua("  CRATE ")));
ok("A7 propsLua covers the classes that matter (BasePart, MeshPart, Model, Humanoid, scripts, GUI, text, KeyframeSequence, Light, Sound, ValueBase, Decal, Camera, Lighting) + attributes + tags", ["BasePart", "MeshPart", "Model", "Humanoid", "LuaSourceContainer", "LayerCollector", "GuiObject", "TextLabel", "KeyframeSequence", "Light", "Sound", "ValueBase", "ParticleEmitter", "Decal", "Camera", "GetService('Lighting')", "GetAttributes", "CollectionService"].every((k) => X.propsLua("W").includes(k)));
ok("A8 propsLua never ships the whole Source (length + first line only, capped)", /SourceLength/.test(X.propsLua("W")) && /FirstLine/.test(X.propsLua("W")) && !/p\.Source\s*=|put\('Source'/.test(X.propsLua("W")));
ok("A9 selectLua is the only write and only touches Selection", /Selection'\):Set\(\{t\}\)/.test(X.selectLua("Workspace.X")) && !/Instance\.new|:Destroy|\.Parent\s*=/.test(X.selectLua("Workspace.X")) && !X.selectLua("Workspace.X").startsWith(X.PROBE_MARK));
ok("A10 rootLua reads the Selection (first 5) so the tree can mark what is selected in Studio", /Selection'\):Get\(\)/.test(X.rootLua()) && /if i>5 then break end/.test(X.rootLua()));
ok("A11 parse() tolerates prefixed / wrapped JSON and rejects garbage", X.parse("Output of 'execute_luau':\n{\"a\":1}").a === 1 && X.parse("{\"b\":2}").b === 2 && X.parse("nope") === null && X.parse("") === null && X.parse(null) === null);

// ── state machine ───────────────────────────────────────────────────────────
const st = X.createState();
ok("B1 createState: empty, no target, no error", st.roots.length === 0 && st.target === null && st.error === "" && st.selected === "" && st.props === null);
X.applyRoot(st, { roots: [{ name: "Workspace", class: "Workspace", n: 3, path: "Workspace" }, { name: "Lighting", class: "Lighting", n: 0, path: "Lighting" }], selection: ["Workspace.Hero"] });
ok("B2 applyRoot: roots in order, nodes created, zero-child node pre-resolved, selection kept", st.roots.join(",") === "Workspace,Lighting" && st.nodes.Workspace.n === 3 && st.nodes.Lighting.children !== null && st.nodes.Lighting.children.length === 0 && st.selection[0] === "Workspace.Hero");
ok("B3 applyRoot with garbage → honest error, roots untouched", (() => { const s2 = X.createState(); X.applyRoot(s2, null); return /could not be read/.test(s2.error) && s2.roots.length === 0; })());
ok("B4 toggle on unknown children → 'load' once (then 'loading' while pending)", X.toggle(st, "Workspace") === "load" && X.toggle(st, "Workspace") === "loading" && st.loading.Workspace === true);
X.applyChildren(st, "Workspace", { found: true, path: "Workspace", children: [{ name: "Hero", class: "Model", n: 17, path: "Workspace.Hero" }, { name: "Crate", class: "Part", n: 0, path: "Workspace.Crate" }, { name: "Camera", class: "Camera", n: 0, path: "Workspace.Camera" }], more: 0 });
ok("B5 applyChildren: open, loading cleared, children ordered as Studio returned them", st.nodes.Workspace.open === true && !st.loading.Workspace && st.nodes.Workspace.children.join(",") === "Workspace.Hero,Workspace.Crate,Workspace.Camera" && st.nodes["Workspace.Hero"].class === "Model");
ok("B6 toggle on loaded children flips open/closed", X.toggle(st, "Workspace") === "closed" && X.toggle(st, "Workspace") === "open");
ok("B7 applyChildren with found=false marks the node (no crash, no fake children)", (() => { X.toggle(st, "Workspace.Hero"); X.applyChildren(st, "Workspace.Hero", { found: false, path: "Workspace.Hero" }); return st.nodes["Workspace.Hero"].children.length === 0 && st.nodes["Workspace.Hero"].error === "not found"; })());
ok("B8 game. prefix normalised everywhere", X.normPath("game.Workspace.Crate") === "Workspace.Crate" && (X.select(st, "game.Workspace.Crate"), st.selected === "Workspace.Crate") && st.loading["props:Workspace.Crate"] === true && st.props === null);
X.applyProps(st, "Workspace.Crate", { found: true, path: "Workspace.Crate", name: "Crate", class: "Part", parent: "Workspace", children: 0, props: { Size: [4, 4, 4], Anchored: true, Color: "#ff0000", Material: "Plastic" }, attributes: { Kind: "loot" }, attributeCount: 1, tags: ["Loot"] });
ok("B9 applyProps: inspector data + node class refreshed, loading cleared", st.props.class === "Part" && st.props.props.Size.join("x") === "4x4x4" && st.props.tags[0] === "Loot" && !st.loading["props:Workspace.Crate"] && st.nodes["Workspace.Crate"].class === "Part");
ok("B10 applyProps found=false → missing (never invents properties)", (() => { const s2 = X.createState(); X.select(s2, "Workspace.Gone"); X.applyProps(s2, "Workspace.Gone", { found: false }); return s2.props.missing === true && s2.props.path === "Workspace.Gone"; })());
const t = X.setTarget(st, "Workspace.Crate");
ok("B11 setTarget records path/class/name/at; null clears", t.path === "Workspace.Crate" && t.class === "Part" && t.name === "Crate" && t.at > 0 && X.setTarget(st, null) === null && st.target === null);
X.setTarget(st, "Workspace.Crate");
X.applySearch(st, { query: "cr", results: [{ name: "Crate", class: "Part", n: 0, path: "Workspace.Crate" }], more: 2 });
ok("B12 applySearch: rows + more; garbage → error row list", st.results.rows[0] === "Workspace.Crate" && st.results.more === 2 && (() => { const s2 = X.createState(); X.applySearch(s2, null); return s2.results.error && s2.results.rows.length === 0; })());
ok("B13 expandTo opens every loaded ancestor of a path", (() => { st.nodes.Workspace.open = false; X.expandTo(st, "Workspace.Hero.Humanoid"); return st.nodes.Workspace.open === true; })());

// ── render ──────────────────────────────────────────────────────────────────
st.results = null;
const h = X.render(st);
ok("C1 render: versioned root, search box, reload, target chip with untarget", /data-rs-explorer="2\.0\.0"/.test(h) && /data-ex-search/.test(h) && /data-ex-action="reload"/.test(h) && /Target: <b>Crate<\/b>/.test(h) && /data-ex-action="untarget"/.test(h));
ok("C2 render: tree rows carry data-ex-toggle / data-ex-select, depth var, aria tree roles", /role="tree"/.test(h) && /data-ex-toggle="Workspace"/.test(h) && /data-ex-select="Workspace.Hero"/.test(h) && /style="--d:1"/.test(h) && /role="treeitem"/.test(h));
ok("C3 render: selected row + target pill + 'selected in Studio' pill", /rs-ex-row on rs-ex-target/.test(h) && /<b class="rs-ex-pill">target<\/b>/.test(h) && /selected in Studio/.test(h));
ok("C4 render: inspector shows class, parent, property rows, colour swatch, attribute, tags and all five actions", /<b>Crate<\/b> <small>Part<\/small>/.test(h) && /<th>Parent<\/th><td>Workspace<\/td>/.test(h) && /<th>Size<\/th><td>4, 4, 4<\/td>/.test(h) && /rs-ex-swatch" style="background:#ff0000"/.test(h) && /<th>@Kind<\/th><td>loot<\/td>/.test(h) && /<th>Tags<\/th><td>Loot<\/td>/.test(h) && ["target|untarget", "studio-select", "copy", "ask", "refresh"].every((a) => new RegExp('data-ex-action="(' + a + ')"').test(h)));
ok("C5 render: target already set → the primary action reads as 'clear'", /data-ex-action="untarget">✓ Target of the next request/.test(h));
ok("C6 render escapes names / paths / values (no raw HTML from the place)", (() => { const s2 = X.createState(); X.applyRoot(s2, { roots: [{ name: "<img src=x onerror=1>", class: "Folder\"", n: 0, path: "Workspace.<img src=x onerror=1>" }] }); const r = X.render(s2); return !/<img src=x/.test(r) && /&lt;img src=x onerror=1&gt;/.test(r) && /Folder&quot;/.test(r); })());
ok("C7 render: empty state asks to start the agent / load; loading state says so; error state has Retry", /load the place/.test(X.render(X.createState())) && (() => { const s2 = X.createState(); s2.loading.root = true; return /Reading the place/.test(X.render(s2)); })() && (() => { const s2 = X.createState(); s2.error = "Studio did not answer"; return /Studio did not answer/.test(X.render(s2)) && /data-ex-action="reload">Retry/.test(X.render(s2)); })());
ok("C8 render: search results replace the tree with a count + back link; empty result says so", (() => { st.results = { query: "cr", rows: ["Workspace.Crate"], more: 2 }; const r = X.render(st); st.results = { query: "zz", rows: [], more: 0 }; const r0 = X.render(st); st.results = null; return /1\+ result for "cr"/.test(r) && /data-ex-action="clear-search"/.test(r) && !/data-ex-toggle="Workspace"/.test(r) && /Nothing named like "zz"/.test(r0); })());
ok("C9 render: '… N more' row under a capped parent", (() => { st.nodes.Workspace.more = 12; st.nodes.Workspace.open = true; const r = X.render(st); st.nodes.Workspace.more = 0; return /… 12 more \(search to find them\)/.test(r); })());

// ── target brief ────────────────────────────────────────────────────────────
const brief = X.targetBrief({ path: "Workspace.Crate", class: "Part", name: "Crate" });
ok("D1 targetBrief: System-note header, path + class, read-back-first rule, no acknowledgement", /^━━━ USER TARGET \(System note from TotalScript, not the user\) ━━━/.test(brief) && /Workspace\.Crate \[Part\]/.test(brief) && /Read it back/.test(brief) && /never recreate it/.test(brief) && /Do not acknowledge/.test(brief));
ok("D2 targetBrief is short (< 600 chars) and '' without a target", brief.length < 600 && X.targetBrief(null) === "" && X.targetBrief({}) === "");
ok("D3 targetTag for status lines", X.targetTag({ path: "Workspace.Crate" }) === "target=Workspace.Crate" && X.targetTag(null) === "");

// ── wiring ──────────────────────────────────────────────────────────────────
const cs = manifest.content_scripts || [];
ok("E1 manifest: explorer.js loads in every content-script block, after public_skills.js and before gui_standard.js", cs.length > 0 && cs.filter((b) => (b.js || []).includes("src/core/public_skills.js")).length === 12 && cs.filter((b) => (b.js || []).includes("src/core/public_skills.js")).every((b) => { const js = b.js || []; const i = js.indexOf("src/core/explorer.js"); return i > js.indexOf("src/core/public_skills.js") && i < js.indexOf("src/core/gui_standard.js"); }));
ok("E2 codecraft.html loads explorer.js in the same slot", /public_skills\.js"><\/script>\n\s*<script src="src\/core\/explorer\.js"><\/script>/.test(html));
ok("E3 main.js: TotalExplorer guarded, probes through bg call_tool execute_luau (Edit) with a bounded race", /const EX = \(typeof TotalExplorer !== "undefined" && TotalExplorer\) \? TotalExplorer : null;/.test(main) && /async function runExplorerLua\(code, ms\)[\s\S]{0,400}name: "execute_luau", arguments: \{ code, datamodel_type: "Edit" \}, timeout: ms/.test(main) && /Promise\.race\(\[req, new Promise\(\(res\) => setTimeout\(\(\) => res\(null\), ms\)\)\]\)/.test(main.slice(main.indexOf("async function runExplorerLua"))));
ok("E4 main.js: explorer object has reload / toggle / select / search / studioSelect / setTarget / render and a listeners list", ["async reload()", "async toggle(path)", "async select(path)", "async search(q)", "async studioSelect(path)", "setTarget(path)", "render() { return EX.render(this.state); }", "listeners: []"].every((k) => main.includes(k)));
ok("E5 main.js: setTarget stores A.explorerTarget (sent:false), toasts, syncs the bar chip; failed probes → honest error text, never fake nodes", /A\.explorerTarget = t \? \{ \.\.\.t, sent: false \} : null;/.test(main) && /syncExplorerChip\(\)/.test(main) && /Studio did not answer/.test(main) && /EX\.applyChildren\(st, path, data && !data\.__err \? data : null\)/.test(main));
ok("E6 main.js: the USER TARGET brief rides right after the mode brief on the FIRST tool result (never the composer), once per request, re-armed at each preflight start", /const mb = await takeModeBrief\(\);[^\n]*\n[^\n]*\n\s*try \{ const tb = explorerTargetBrief\(\); if \(tb\) toSend \+= "\\n\\n" \+ tb; \} catch \{\}/.test(main) && !/editorSet\([^)]*explorerTarget/.test(main) && /A\.modeBrief = null;\n\s*try \{ if \(A\.explorerTarget\) A\.explorerTarget\.sent = false; \} catch \{\}/.test(main) && /function explorerTargetBrief\(\)[\s\S]{0,200}t\.sent = true;[\s\S]{0,120}return EX\.targetBrief\(t\);/.test(main));
ok("E7 main.js: Explorer tab in the cards panel (button, body, heading, tip) and every tab normaliser accepts 'explorer'", /data-tab="explorer">Explorer/.test(main) && /cardsTab === "explorer" \? explorerHtml\(\)/.test(main) && /\["Explorer", "Your place, live - pick what the AI should work on"\]/.test(main) && (main.match(/tab\.dataset\.tab === "explorer" \? "explorer"|tab\.dataset\.tab==="explorer"\?"explorer"|t === "explorer" \? t/g) || []).length === 3);
ok("E8 main.js: delegated actions (toggle / select / reload / refresh / target / untarget / studio-select / copy / ask / clear-search) + debounced search input + Enter / Escape", ["[data-ex-toggle]", "[data-ex-select]", "[data-ex-action]", 'act === "reload"', 'act === "refresh"', 'act === "target"', 'act === "untarget"', 'act === "studio-select"', 'act === "copy"', 'act === "ask"', 'act === "clear-search"', "exSearchTimer = setTimeout(() => { explorer.search(q); }, 320);", 'if (e.key === "Enter") { e.preventDefault(); clearTimeout(exSearchTimer); explorer.search(inp.value); }', 'if (e.key === "Escape")'].every((k) => main.includes(k)));
ok("E9 main.js: 'Ask the AI about it' drafts via pasteLibraryCard (silent) and never sends; the explorer tab is hidden for the local engine", /pasteLibraryCard\(\{ title: "Inspect " \+ st\.selected\.split\("\."\)\.pop\(\), prompt: "Look at " \+ st\.selected/.test(main) && /Do not change anything yet\." \}, \{ silent: true \}\)/.test(main) && /explorer && !local \? '<button type="button" class="rs-cards-tab' \+ \(cardsTab === "explorer"/.test(main));
ok("E10 main.js: state listener re-renders only .rs-ex (keeps search focus + caret) and refreshes the tab counter", /const host = cardsPanel\.querySelector\("\.rs-cards-body \.rs-ex"\);/.test(main) && /hadFocus = search && document\.activeElement === search/.test(main) && /host\.replaceWith\(tmp\.firstElementChild\)/.test(main) && /tabBtn\.innerHTML = "Explorer"/.test(main));
ok("E11 main.js: #rs-target-chip in the bar next to the task pill, click clears the target; explorerHtml auto-loads once the agent started", /<button type="button" id="rs-task-pill" hidden title="Task list"><\/button>\n\s*<button type="button" id="rs-target-chip" hidden title="Explorer target"><\/button>/.test(main) && /targetChip\.addEventListener\("click"[^\n]*explorer\.setTarget\(null\)/.test(main) && /!explorer\.state\.error && A\.started\) \{ try \{ explorer\.reload\(\); \} catch \{\} \}/.test(main));
ok("E12 main.js: harness hook window.__rsExplorer + diag events (reload / target / targetSent / studioSelect)", /window\.__rsExplorer = explorer;/.test(main) && ["explorer.reload", "explorer.target", "explorer.targetSent", "explorer.studioSelect"].every((d) => main.includes('diag("' + d + '"')));
ok("E13 overlay.css: chip + tree + inspector styles (aqua target, light theme, narrow stack)", ["#rs-target-chip{", ".rs-ex-split{", ".rs-ex-row.on{", ".rs-ex-pill{", ".rs-ex-props th{", ".rs-ex-btn-primary{", "html.rs-light .rs-ex-tree", "@media (max-width:760px){.rs-ex-split{grid-template-columns:1fr}"].every((k) => css.includes(k)));
ok("E14 the visible command catalogue is untouched (Explorer is UI + bridge, not a model command)", !/explorer_/.test(read("src/core/skills/studio_100.js")) && !/"explorer"/.test(read("src/core/command_contract.js")));

// ── jsdom walk: the real page with a fake bridge ────────────────────────────
// Boots codecraft.html (every core script incl. explorer.js + main.js), opens
// the Templates window on the Explorer tab and drives it: root probe → tree,
// expand Workspace → children probe, click Crate → props probe + inspector,
// "Use as target" → bar chip + USER TARGET brief (once per request), "Select
// in Studio" → Selection:Set probe, search → search probe.
let JSDOM = null; try { ({ JSDOM } = require("jsdom")); } catch {}
function finish() { console.log(`\ntest-explorer: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
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
  const clip = []; w.navigator.clipboard = { writeText: async (t) => { clip.push(t); }, readText: async () => "" };
  w.URL.createObjectURL = () => "blob:harness"; w.URL.revokeObjectURL = () => {};
  w.open = () => null; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
  const storage = {};
  const storageApi = () => ({
    get(keys, cb) { const out = {}; const ks = keys == null ? Object.keys(storage) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); for (const k of ks) { if (k in storage) out[k] = storage[k]; else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k]; } if (cb) setTimeout(() => cb(out), 0); return Promise.resolve(out); },
    set(obj, cb) { Object.assign(storage, obj); if (cb) setTimeout(cb, 0); return Promise.resolve(); },
    remove(keys, cb) { for (const k of [].concat(keys)) delete storage[k]; if (cb) setTimeout(cb, 0); return Promise.resolve(); },
  });
  const TOOLS = [{ name: "execute_luau", description: "Run Luau", inputSchema: { type: "object", properties: { code: { type: "string" } } } }];
  const calls = [];
  const SEL = [];
  const background = (msg) => {
    switch (msg && msg.type) {
      case "status": return { ok: true, type: "rs-status", connected: true, mcpAlive: true, studio: true, roblox_connected: true };
      case "studio_status": return { ok: true, studio: true };
      case "tools": case "list_tools": return { ok: true, tools: TOOLS };
      case "call_tool": {
        calls.push({ name: msg.name, args: msg.arguments, timeout: msg.timeout });
        const code = String((msg.arguments || {}).code || "");
        if (code.startsWith(X.PROBE_MARK)) {
          if (/out=\{roots=\{\}\}/.test(code)) return { ok: true, text: JSON.stringify({ roots: [{ name: "Workspace", class: "Workspace", n: 2, path: "Workspace" }, { name: "ReplicatedStorage", class: "ReplicatedStorage", n: 0, path: "ReplicatedStorage" }, { name: "StarterGui", class: "StarterGui", n: 1, path: "StarterGui" }], selection: ["Workspace.Hero"] }) };
          if (/local kids=t:GetChildren\(\)/.test(code)) return { ok: true, text: "Output of 'execute_luau':\n" + JSON.stringify({ found: true, path: "Workspace", children: [{ name: "Hero", class: "Model", n: 17, path: "Workspace.Hero" }, { name: "Crate", class: "Part", n: 0, path: "Workspace.Crate" }], more: 0 }) };
          if (/local p=\{\}/.test(code)) return { ok: true, text: JSON.stringify({ found: true, path: "Workspace.Crate", name: "Crate", class: "Part", parent: "Workspace", children: 0, props: { Size: [4, 4, 4], Anchored: true, Color: "#ff0000", Material: "Plastic" }, attributes: { Kind: "loot" }, attributeCount: 1, tags: [] }) };
          if (/out=\{query=q/.test(code)) return { ok: true, text: JSON.stringify({ query: "cra", results: [{ name: "Crate", class: "Part", n: 0, path: "Workspace.Crate" }], more: 0 }) };
        }
        if (/Selection'\):Set\(\{t\}\)/.test(code)) { SEL.push(code.match(/resolve\('([^']+)'\)/)[1]); return { ok: true, text: JSON.stringify({ found: true, path: "Workspace.Crate", selected: true }) }; }
        return { ok: true, text: "ok" };
      }
      case "blender_status": case "blender_connect": return { ok: false, blender: false };
      default: return { ok: true, tools: TOOLS };
    }
  };
  w.chrome = { runtime: { id: "harness-ext", getURL: (p) => "chrome-extension://harness-ext/" + p, sendMessage(msg, cb) { const r = background(msg); if (typeof cb === "function") setTimeout(() => cb(r), 0); return Promise.resolve(r); }, onMessage: { addListener() {}, removeListener() {} }, lastError: null, getManifest: () => JSON.parse(read("manifest.json")) }, storage: { local: storageApi(), sync: storageApi(), onChanged: { addListener() {}, removeListener() {} } }, tabs: { create() {} } };
  storage.rsCodeCraft = { key: "cc_" + "a".repeat(48), model: "kimi-k3" };
  storage.rsWorkMode = "creation";
  w.fetch = async (url) => { if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } }); return new Response("{}", { status: 200 }); };
  const pageErrors = [];
  w.onerror = (m) => { pageErrors.push(String(m)); };
  for (const sc of scripts) { const el = d.createElement("script"); el.textContent = read(sc) + "\n//# sourceURL=" + sc; d.body.appendChild(el); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, ms, label) { const until = Date.now() + ms; while (Date.now() < until) { try { const v = pred(); if (v) return v; } catch {} await sleep(40); } throw new Error("timeout waiting for " + label); }
  try {
    await waitFor(() => d.getElementById("rs-bar"), 8000, "#rs-bar");
    await sleep(700);
    ok("walk W1: page boots with TotalExplorer + __rsExplorer on window and no page errors", w.TotalExplorer && w.TotalExplorer.VERSION === "2.0.0" && w.__rsExplorer && typeof w.__rsExplorer.reload === "function" && pageErrors.length === 0, pageErrors.join(" | "));
    const chip = d.getElementById("rs-target-chip");
    ok("walk W2: #rs-target-chip exists in the bar and is hidden while no target is set", !!chip && chip.hidden === true);
    d.getElementById("rs-cards-btn").click(); await sleep(250);
    const panel = d.getElementById("rs-cards-panel");
    const tab = panel && panel.querySelector('.rs-cards-tab[data-tab="explorer"]');
    ok("walk W3: the Templates window shows an Explorer tab", !!tab && /Explorer/.test(tab.textContent));
    calls.length = 0;
    tab.click(); await sleep(400);
    const ex = panel.querySelector(".rs-cards-body .rs-ex");
    ok("walk W4: Explorer tab renders the module root and the heading", !!ex && panel.dataset.cardsTab === "explorer" && /Explorer/.test((panel.querySelector(".rs-cards-title") || panel).textContent));
    // The page is not "started" in the harness → explicit load via the ↻ button.
    panel.querySelector('[data-ex-action="reload"]').click();
    await waitFor(() => panel.querySelector('[data-ex-toggle="Workspace"]'), 3000, "root rows");
    const rootCall = calls.find((c) => c.name === "execute_luau" && /out=\{roots=\{\}\}/.test(c.args.code));
    ok("walk W5: reload ran the root probe through execute_luau {datamodel_type:Edit} and rendered the services", !!rootCall && rootCall.args.datamodel_type === "Edit" && panel.querySelectorAll(".rs-ex-row").length === 3 && /selected in Studio/.test(panel.innerHTML) === false);
    panel.querySelector('[data-ex-toggle="Workspace"]').click();
    await waitFor(() => panel.querySelector('[data-ex-select="Workspace.Crate"]'), 3000, "children rows");
    ok("walk W6: expanding Workspace ran the children probe (cap 200) and rendered Hero + Crate under it; Hero marked 'selected in Studio'", calls.some((c) => /local kids=t:GetChildren/.test(c.args.code) && /if i>200 then/.test(c.args.code)) && panel.querySelector('[data-ex-select="Workspace.Hero"] .rs-ex-pill-sel') && panel.querySelector('.rs-ex-row[data-ex-path="Workspace.Crate"]').style.getPropertyValue("--d") === "1");
    panel.querySelector('[data-ex-select="Workspace.Crate"]').click();
    await waitFor(() => /<th>Size<\/th>/.test(panel.querySelector(".rs-ex-inspector").innerHTML), 3000, "inspector");
    ok("walk W7: clicking Crate ran the props probe and the inspector shows Part properties + attribute + actions", calls.some((c) => /local p=\{\}/.test(c.args.code) && /resolve\('Workspace\.Crate'\)/.test(c.args.code)) && /4, 4, 4/.test(panel.querySelector(".rs-ex-inspector").textContent) && /@Kind/.test(panel.querySelector(".rs-ex-inspector").textContent) && panel.querySelector('[data-ex-action="target"]'));
    panel.querySelector('[data-ex-action="target"]').click(); await sleep(120);
    ok("walk W8: 'Use as target' sets the target: bar chip visible with the name, tab counter, row pill, module state", chip.hidden === false && /Target:/.test(chip.textContent) && /Crate/.test(chip.textContent) && w.__rsExplorer.state.target.path === "Workspace.Crate" && panel.querySelector('.rs-ex-row[data-ex-path="Workspace.Crate"].rs-ex-target') && /<b>1<\/b>/.test(panel.querySelector('.rs-cards-tab[data-tab="explorer"]').innerHTML));
    const b1 = w.__rsExplorerBrief(); const b2 = w.__rsExplorerBrief();
    ok("walk W9: the USER TARGET brief is produced once per request (second call empty) and names the path + class", /USER TARGET/.test(b1) && /Workspace\.Crate \[Part\]/.test(b1) && b2 === "");
    w.__rsModePreflight(); await sleep(30);
    ok("walk W10: a new request (preflight start) re-arms the brief", /Workspace\.Crate/.test(w.__rsExplorerBrief()));
    panel.querySelector('[data-ex-action="studio-select"]').click(); await sleep(150);
    ok("walk W11: 'Select in Studio' ran the Selection:Set probe for the selected path", SEL.length === 1 && SEL[0] === "Workspace.Crate");
    panel.querySelector('[data-ex-action="copy"]').click(); await sleep(60);
    ok("walk W12: 'Copy path' writes the path to the clipboard", clip[0] === "Workspace.Crate");
    const search = panel.querySelector("[data-ex-search]");
    search.value = "cra"; search.dispatchEvent(new w.Event("input", { bubbles: true }));
    await waitFor(() => /result for "cra"/.test(panel.querySelector(".rs-ex-tree").textContent), 3000, "search results");
    ok("walk W13: typing in the search box (debounced) ran the search probe and listed the hit with a back link", calls.some((c) => /out=\{query=q/.test(c.args.code) && /local q='cra'/.test(c.args.code)) && panel.querySelector('[data-ex-action="clear-search"]') && panel.querySelector('[data-ex-select="Workspace.Crate"]'));
    panel.querySelector('[data-ex-action="clear-search"]').click(); await sleep(60);
    ok("walk W14: 'Back to the tree' restores the tree (Workspace still open, target still marked)", panel.querySelector('[data-ex-toggle="Workspace"]') && panel.querySelector('.rs-ex-row[data-ex-path="Workspace.Crate"].rs-ex-target'));
    chip.click(); await sleep(80);
    ok("walk W15: clicking the bar chip clears the target everywhere", chip.hidden === true && w.__rsExplorer.state.target === null && !panel.querySelector(".rs-ex-target") && w.__rsExplorerBrief() === "");
    ok("walk W16: no uncaught page errors during the walk", pageErrors.length === 0, pageErrors.join(" | "));
  } catch (e) {
    ok("walk: completed without harness exceptions", false, e && e.stack || e);
  }
  finish();
})();
