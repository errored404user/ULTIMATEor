// 1.48.0 → 1.50.1 — GUI Studio: the Paint-style visual GUI builder (src/core/guistudio.js), the 1.50 template library (src/core/guistudio_templates.js) + the
// extra GUI command pack (src/core/skills/studio_guistudio.js) and their wiring.
// Run: NODE_PATH=/tmp/harness/node_modules node tests/test-gui-studio.js
const fs = require("fs"), path = require("path"), assert = require("assert");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const main = read("src/core/main.js"), css = read("overlay.css"), manifest = read("manifest.json"), codecraft = read("codecraft.html");
const studio = read("src/core/guistudio.js"), pack = read("src/core/skills/studio_guistudio.js"), tplLib = read("src/core/guistudio_templates.js");
let n = 0; const ok = (name, cond, detail) => { n++; if (!cond) { console.error("FAIL " + name + (detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 300) : "")); process.exit(1); } };

// ── registration ─────────────────────────────────────────────────────────────
const m = JSON.parse(manifest);
const lists = m.content_scripts.map((c) => c.js).filter((js) => js.includes("src/core/main.js"));
ok("manifest has content-script lists that load main.js", lists.length >= 5, lists.length);
for (const js of lists) {
  const p = js.indexOf("src/core/paint.js"), g = js.indexOf("src/core/guistudio.js"), mn = js.indexOf("src/core/main.js"), sk = js.indexOf("src/core/skills/studio_guistudio.js"), q = js.indexOf("src/core/skills/studio_quality.js");
  ok("guistudio.js loads after paint.js and before main.js in every list", p >= 0 && g > p && mn > g, js);
  ok("studio_guistudio.js pack loads right after studio_quality.js and before main.js", sk === q + 1 && mn > sk, js);
}
ok("1.50: guistudio_templates.js loads right before guistudio.js in every list + codecraft.html", lists.every((js) => js.indexOf("src/core/guistudio_templates.js") >= 0 && js.indexOf("src/core/guistudio.js") === js.indexOf("src/core/guistudio_templates.js") + 1) && codecraft.indexOf('<script src="src/core/guistudio_templates.js"></script>') > 0 && codecraft.indexOf('<script src="src/core/guistudio_templates.js"></script>') < codecraft.indexOf('<script src="src/core/guistudio.js"></script>'));
ok("every provider list (16) carries both new files", lists.length === 16 && lists.every((js) => js.includes("src/core/guistudio.js") && js.includes("src/core/skills/studio_guistudio.js")), lists.length);
ok("codecraft.html loads the pack and the designer in order", codecraft.indexOf('<script src="src/core/skills/studio_guistudio.js"></script>') > codecraft.indexOf('<script src="src/core/skills/studio_quality.js"></script>') && codecraft.indexOf('<script src="src/core/guistudio.js"></script>') > codecraft.indexOf('<script src="src/core/paint.js"></script>') && codecraft.indexOf('<script src="src/core/guistudio.js"></script>') < codecraft.indexOf('<script src="src/core/main.js"></script>'));

// ── main.js wiring ───────────────────────────────────────────────────────────
for (const s of [
  'id="rs-gui-btn"',
  'root.querySelector("#rs-gui-btn")',
  "if (window.__rsOpenGuiStudio) window.__rsOpenGuiStudio();",
  '(e.key === "G" || e.key === "g") && !e.altKey',
  'if (typeof ORGuiStudio !== "undefined" && ORGuiStudio.isOpen()) return;',
  "function openGuiStudio() {",
  'if (typeof ORGuiStudio === "undefined") { ui.toast("GUI Studio module missing — reload the extension"); return; }',
  "send: (text, onStatus) => sendPainting(text, null, onStatus),",
  "runTool: guiStudioRunTool,",
  "return runTool({ tool: name, arguments: Object.assign({}, args || {}, { _orInternal: true }) });",
  "studioReady: () => { try { return currentEngineIsLive(); } catch { return false; } },",
  "window.__rsOpenGuiStudio = openGuiStudio;",
  'gui:{title:"GUI Studio (1.48 visual GUI builder)"',
  "gui:/gui studio|gui builder|gui editor|gui designer|",
  'ui_build_spec: "Next: ui_responsive_fix {path} + ui_layout_report {path}',
  '"ui_build_spec","ui_component","ui_tokens_apply","ui_responsive_fix","ui_to_scale","ui_bulk_set","ui_state_toggle","ui_tween","ui_screen_create",',
]) ok("main.js contains " + s, main.includes(s));
ok("GUI button sits between Paint and Settings in the bar", main.indexOf('id="rs-paint-btn"') < main.indexOf('id="rs-gui-btn"') && main.indexOf('id="rs-gui-btn"') < main.indexOf('id="rs-settings-btn"'));
ok("Paint shortcut still intact", main.includes('(e.key === "P" || e.key === "p") && !e.altKey'));

// ── overlay.css ──────────────────────────────────────────────────────────────
for (const s of ["#rs-gui {", "#rs-gui.open {", "html.rs-gui-open #rs-root { visibility: hidden !important; }", ".rsg-shell {", ".rsg-tools {", ".rsg-stage {", ".rsg-screen {", ".rsg-n.sel {", ".rsg-h-nw {", ".rsg-side {", ".rsg-tab.on {", ".rsg-btn.primary {", ".rsg-btn.accent {", ".rsg-preset {", ".rsg-tr.sel {", ".rsg-marquee {", ".rsg-guides i {", 'html[data-rs-hide~="paint"] #rs-gui-btn { display: none !important; }', ":is(#rs-settings-btn, #rs-paint-btn, #rs-gui-btn)"])
  ok("overlay.css has " + s, css.includes(s));
ok("GUI Studio CSS sits after the Paint block", css.indexOf("#rs-gui {") > css.indexOf("#rs-paint {"));
ok("[hidden] wins over the display rules inside the overlay (tabs / Build / Import really hide)", css.includes("#rs-gui [hidden] { display: none !important; }"));
ok("overlay toast + empty-stage styles present", css.includes(".rsg-toast.show {") && css.includes(".rsg-empty-stage {"));
ok("stage centres the device with margin:auto (no clipped top-left when zoomed in)", css.includes(".rsg-stage-wrap { position: relative; flex: none; margin: auto; }"));
ok("screen does not clip handles / tags", css.includes("overflow: visible; user-select: none; -webkit-user-select: none; touch-action: none; }"));
ok("nodes carry no inner border that would shift children", css.includes(".rsg-n { position: absolute; }"));
ok("no bare paint-only bar selector left behind", !css.includes(":is(#rs-settings-btn, #rs-paint-btn)"));

// ── pack (string level) ──────────────────────────────────────────────────────
ok("pack version 1.48.0", pack.includes('const GUISTUDIO_VERSION = "1.48.0";'));
for (const op of ["ui_build_spec", "ui_export_spec", "ui_component", "ui_align", "ui_distribute", "ui_anchor_preset", "ui_to_scale", "ui_responsive_fix", "ui_text_fit", "ui_zorder_fix", "ui_tokens_apply", "ui_tween", "ui_state_toggle", "ui_find", "ui_bulk_set", "ui_screen_create", "ui_layout_report"])
  ok("pack declares " + op, pack.includes(`{ name: "${op}",`));
ok("pack exposes guiComponentNode for the designer", pack.includes("RobloxScriptSkills.guiComponentNode = function (kind, args)"));
ok("no HttpService:JSONDecode in main.js (pins test-v111)", !/HttpService:JSONDecode/.test(main));
const config = read("src/core/config.js");
ok("Creation full prompt teaches the GUI STUDIO hand-off", config.includes('GUI STUDIO (1.48): a "GUI STUDIO HAND-OFF" message carries an exact spec - run ui_build_spec {spec, replace:true} verbatim, never redesign it; ui_component / ui_align / ui_tokens_apply / ui_layout_report finish it.'));
ok("ui_text_fit / ui_zorder_fix are hidden from the catalogue (budget) but still declared", pack.includes('{ name: "ui_text_fit", hidden: true,') && pack.includes('{ name: "ui_zorder_fix", hidden: true,'));

// ── designer in jsdom ────────────────────────────────────────────────────────
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.requestAnimationFrame = (f) => setTimeout(f, 0);
w.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 }; };
w.HTMLElement.prototype.scrollIntoView = function () {};
w.URL.createObjectURL = () => "blob:x"; w.URL.revokeObjectURL = () => {};
w.prompt = () => null; w.confirm = () => true;
Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get() { return 900; } });
Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get() { return 600; } });
const errors = []; w.addEventListener("error", (e) => errors.push(String(e.message)));
const load = (f) => { const el = w.document.createElement("script"); el.textContent = read(f); w.document.head.appendChild(el); };
for (const f of ["src/core/skills/studio_skills.js", "src/core/skills/studio_design.js", "src/core/skills/studio_gui.js", "src/core/skills/studio_guistudio.js", "src/core/guistudio_templates.js", "src/core/guistudio.js"]) load(f);
// ── 1.50 template library ───────────────────────────────────────────────────
{ const L = w.ORGuiTemplates;
  ok("1.50: ORGuiTemplates library exposes 100+ templates in 12 categories", L && L.count >= 100 && L.list.length === L.count && L.categories.length === 12, L && L.count);
  ok("1.50: every category has at least 6 templates and every template belongs to a category", L.categories.every((c) => L.list.filter((t) => t.cat === c.id).length >= 6) && L.list.every((t) => L.categories.some((c) => c.id === t.cat)));
  ok("1.50: template ids are unique, labelled, tagged and carry a known preset", new Set(L.list.map((t) => t.id)).size === L.list.length && L.list.every((t) => t.label && t.screen && Array.isArray(t.tags) && t.tags.length && ["midnight", "clean_light", "candy", "neon", "royal_gold", "forest", "horror", "ocean", "sakura", "retro"].includes(t.preset)));
  ok("1.50: at least 8 featured templates, original 10 ids preserved", L.list.filter((t) => t.featured).length >= 8 && ["hud", "menu", "shop", "inventory", "settings", "leaderboard", "quests", "dialogue", "loading", "rewards"].every((id) => L.get(id)));
  ok("1.50: presets are spread across the library (≥6 distinct) — templates look different, not all midnight", new Set(L.list.map((t) => t.preset)).size >= 6);
}
ok("scripts load without window errors", errors.length === 0, errors);
const G = w.ORGuiStudio;
ok("window.ORGuiStudio exported", G && typeof G.open === "function" && typeof G.toLuau === "function");
ok("only the stage binds pointerdown (the screen binding doubled every press)", !studio.includes('D.screen.addEventListener("pointerdown", onDown)') && studio.includes('D.stage.addEventListener("pointerdown", guarded((e) => {'));
ok("children render relative to the parent box", studio.includes("style=\"left:${box.x - pb.x}px;top:${box.y - pb.y}px;") && studio.includes("map((c) => renderNode(c, box))"));
ok("prop rows are divs (no nested labels double-toggling checkboxes)", studio.includes('return `<div class="rsg-f" ${hint ? `title="${esc(hint)}"` : ""}><span>${esc(label)}</span>${html}</div>`;'));
ok("props panel keeps focus + scroll across re-renders", studio.includes("function renderPropsInner()") && studio.includes("el.focus({ preventScroll: true })") && studio.includes("D.side.scrollTop = scroll;"));
const ev = (src) => { const el = w.document.createElement("script"); el.textContent = "window.__t = (" + src + ");"; w.document.head.appendChild(el); return w.__t; };
const SK = ev("RobloxScriptSkills");
ok("hidden ops stay callable through SKILL_OPS", SK.SKILL_OPS.includes("ui_text_fit") && SK.SKILL_OPS.includes("ui_zorder_fix") && SK.hiddenCommandNames().has("ui_zorder_fix") && !SK.hiddenCommandNames().has("ui_build_spec"));
ok("pack catalogue: 17 ops / 24 component kinds / 10 presets", SK.GUISTUDIO_VERSION === "1.48.0" && SK.GUI_COMPONENT_KINDS.length === 24 && Object.keys(SK.GUI_TOKEN_PRESETS).length === 10, [SK.GUI_COMPONENT_KINDS && SK.GUI_COMPONENT_KINDS.length, SK.GUI_TOKEN_PRESETS && Object.keys(SK.GUI_TOKEN_PRESETS).length]);

const sent = [], calls = [], toasts = [], diags = [];
const byPath = (g, p) => { let list = g._state.nodes, cur = null; for (const part of p.split(".")) { cur = list.find((n) => n.name === part); if (!cur) return null; list = cur.children; } return cur; };
const studioSpec = { screen: { name: "Imported" }, preset: "ocean", children: [{ class: "Frame", name: "A", size: [0, 100, 0, 50], children: [{ class: "TextLabel", name: "L", text: "hi", size: [1, 0, 1, 0] }] }] };
G.open({
  send: async (t, s) => { sent.push(t); s && s("status"); return true; },
  runTool: async (name, args) => {
    calls.push([name, args]);
    if (name === "ui_build_spec") return "Output of 'ui_build_spec':\n" + JSON.stringify({ ok: true, data: { count: 7, screen: "StarterGui.X", behaviours: 2 } });
    if (name === "ui_export_spec" && !args.path) return "Output of 'ui_export_spec':\n" + JSON.stringify({ ok: true, data: { screens: [{ path: "StarterGui.Imported", name: "Imported", children: 1 }] } });
    return "Output of 'ui_export_spec':\n" + JSON.stringify({ ok: true, data: { spec: studioSpec, nodes: 2 } });
  },
  studioReady: () => true, engine: () => "roblox", toast: (m) => toasts.push(m), diag: (e, d) => diags.push(e),
});
ok("open() flips the host + html classes", G.isOpen() && w.document.getElementById("rs-gui").classList.contains("open") && w.document.documentElement.classList.contains("rs-gui-open"));
const host = w.document.getElementById("rs-gui");
// ── Simple mode (default) ────────────────────────────────────────────────────
ok("Simple mode is the default and marks the host", G._state.simple === true && host.classList.contains("rsg-simple") && host.querySelector('.rsg-mode [data-mode="simple"]').classList.contains("on"));
ok("Simple: 6 click-to-add elements + plain-named ready-made components", host.querySelectorAll(".rsg-tools-simple .rsg-add").length === 6 && host.querySelectorAll(".rsg-tools-simple .rsg-comp").length === 12 && G.SIMPLE_ELEMENTS.length === 6);
ok("Simple: advanced-only controls carry rsg-adv (grid, snap, import, open, save, copyLua, screen name, Code tab)", ["grid", "snap", "import", "open", "save", "copyLua"].every((a) => host.querySelector(`[data-act="${a}"]`).classList.contains("rsg-adv")) && host.querySelector(".rsg-screen-name").closest(".rsg-rf").classList.contains("rsg-adv") && host.querySelector('.rsg-tab[data-tab="code"]').classList.contains("rsg-adv"));
ok("Simple: empty screen offers 8 featured templates as thumbnail start cards + a browse-all button", host.querySelectorAll(".rsg-empty-stage .rsg-start [data-tpl]").length === 8 && host.querySelectorAll(".rsg-empty-stage .rsg-start .rsg-start-card .rsg-gal-thumb[data-thumb]").length === 8 && /Browse all 1\d\d templates/.test(host.querySelector('.rsg-empty-stage [data-act="gallery"]').textContent));
ok("Simple: ribbon has a Templates button that shows the count", host.querySelector('.rsg-ribbon [data-act="gallery"]') && !host.querySelector('.rsg-ribbon [data-act="gallery"]').classList.contains("rsg-adv") && /1\d\d/.test(host.querySelector('.rsg-ribbon [data-act="gallery"]').textContent));
ok("Simple: Props shows the how-it-works steps when nothing is selected", host.querySelector(".rsg-props .rsg-steps") && host.querySelectorAll(".rsg-props .rsg-steps li").length === 4);
host.querySelector('.rsg-add[data-add="TextButton"]').click();
ok("Simple: clicking Add → Button drops a centred default-size button and selects it", G.getSpec().children.length === 1 && G.getSpec().children[0].class === "TextButton" && G.getSpec().children[0].size[1] === 200 && G.getSpec().children[0].position[1] === Math.round((1366 - 200) / 2) && G._state.sel.length === 1 && G._state.tool === "select", G.getSpec().children[0]);
ok("Simple: toast explains the next move", host.querySelector(".rsg-toast").textContent.includes("drag it to move"));
ok("Simple inspector: Name / Text / colours / size / When clicked, no UDim fields", host.querySelector('.rsg-props [data-sk="name"]') && host.querySelector('.rsg-props [data-sk="text"]') && host.querySelector('.rsg-props [data-sk="bg"]') && host.querySelector('.rsg-props [data-sk="w"]') && host.querySelector('.rsg-props [data-sk="act_do"]') && !host.querySelector('.rsg-props [data-k="position.0"]'));
{ const wIn = host.querySelector('.rsg-props [data-sk="w"]'); wIn.value = "320"; wIn.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("Simple: Width field resizes in pixels", G.getSpec().children[0].size[1] === 320, G.getSpec().children[0].size);
  const xIn = host.querySelector('.rsg-props [data-sk="x"]'); xIn.value = "40"; xIn.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("Simple: X field moves in pixels", G.getSpec().children[0].position[1] === 40, G.getSpec().children[0].position);
  const tIn = host.querySelector('.rsg-props [data-sk="text"]'); tIn.value = "PLAY"; tIn.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("Simple: Text field sets the label", G.getSpec().children[0].text === "PLAY");
  host.querySelector('.rsg-add[data-add="Frame"]').click();
  ok("Simple: a Panel added while a button is selected becomes its sibling (not its child)", G.getSpec().children.length === 2 && G.getSpec().children[1].class === "Frame" && G.getSpec().children[1].name === "Panel");
  G._state.sel = [G._state.nodes[0]]; G._computeGeometry(); G._reindex(); host.querySelector(".rsg-tab[data-tab=\"props\"]").click();
  const doSel = host.querySelector('.rsg-props [data-sk="act_do"]'); doSel.value = "toggle"; doSel.dispatchEvent(new w.Event("change", { bubbles: true }));
  const tgt = host.querySelector('.rsg-props [data-sk="act_target"]');
  ok("Simple: 'When clicked → show / hide' adds a click action and offers the other elements as targets", G.getSpec().children[0].actions[0].do === "toggle" && tgt && Array.from(tgt.options).some((o) => o.value === "gui.Panel"), G.getSpec().children[0].actions);
  tgt.value = "gui.Panel"; tgt.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("Simple: target stored", G.getSpec().children[0].actions[0].target === "gui.Panel");
  const none = host.querySelector('.rsg-props [data-sk="bg_none"]'); none.checked = true; none.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok("Simple: 'no fill' sets full background transparency", G.getSpec().children[0].bg_t === 1); }
host.querySelector('.rsg-props [data-mode="advanced"]').click();
ok("'More options…' switches to Advanced mode and shows the full inspector", !host.classList.contains("rsg-simple") && G._state.simple === false && host.querySelector('.rsg-props input[data-k="name"]'));
host.querySelector('[data-act="clear"]').click();
ok("start cards also appear in Advanced when empty", host.querySelectorAll(".rsg-start [data-tpl]").length === 8);
host.querySelector('.rsg-start [data-tpl="hud"]').click();
ok("clicking a start card loads that template", G.getSpec().screen.name === "HUD" && G.getSpec().children.length > 0);
G._state.history.length = 0; G._state.redo.length = 0;
ok("1.50: polish — most templates use gradients or glass (bg_t) panels, and every one builds without throwing", G.TEMPLATES.filter((t) => /"gradient"|"bg_t"/.test(JSON.stringify(t.build()))).length >= G.TEMPLATES.length * 0.8);
ok("catalogues: 100+ templates / 12 categories / 4 devices / 9 element tools", G.TEMPLATES.length >= 100 && G.TEMPLATES.length === w.ORGuiTemplates.count && G.TEMPLATE_CATEGORIES.length === 12 && G.DEVICES.length === 4 && G.ELEMENT_TOOLS.length === 9, G.TEMPLATES.length);
{ const errs = []; let warnTotal = 0; const saved = G.getSpec();
  for (const t of G.TEMPLATES) { G.loadSpec({ screen: { name: t.screen }, preset: t.preset, children: t.build() }); const is = G.check(); warnTotal += is.length; for (const i of is) if (i.level === "error") errs.push(t.id + " " + i.path + ": " + i.msg); }
  G.loadSpec(saved);
  ok("1.50: every template passes the pre-flight Check with zero errors", errs.length === 0, errs.slice(0, 5));
  ok("1.50: self-acting behaviours (switch / tab / select_slot / show_while_hover) are not flagged as missing a target, toggle still is", (G.loadSpec({ children: [{ class: "TextButton", name: "Sw", text: "", size: [0, 56, 0, 30], actions: [{ on: "click", do: "switch" }] }, { class: "TextButton", name: "Tb", text: "T", size: [0, 56, 0, 30], actions: [{ on: "click", do: "tab" }] }, { class: "TextButton", name: "Sl", text: "", size: [0, 56, 0, 30], actions: [{ on: "click", do: "select_slot" }] }, { class: "TextLabel", name: "Tip", text: "x", size: [0, 56, 0, 30], actions: [{ on: "parent_hover", do: "show_while_hover" }] }, { class: "TextButton", name: "Go", text: "Go", size: [0, 56, 0, 30], actions: [{ on: "click", do: "toggle" }] }] }), G.check().filter((i) => i.level === "error").map((i) => i.path).join(",") === "Go"), G.check().filter((i) => i.level === "error"));
  G.loadSpec(saved); void warnTotal; }
ok("template select groups the library by category", host.querySelectorAll(".rsg-template-sel optgroup").length === 12 && host.querySelectorAll(".rsg-template-sel option[value]:not([value=''])").length === G.TEMPLATES.length);
// ── 1.50 gallery ────────────────────────────────────────────────────────────
{ const gal = host.querySelector(".rsg-gallery");
  ok("gallery is hidden until opened", gal && gal.hidden === true);
  host.querySelector('.rsg-ribbon [data-act="gallery"]').click();
  ok("Templates button opens the gallery with every card + category chips", gal.hidden === false && G._state.galleryOpen && host.querySelectorAll(".rsg-gal-grid .rsg-gal-card[data-tpl]").length === G.TEMPLATES.length && host.querySelectorAll(".rsg-gal-cats [data-galcat]").length === 14, host.querySelectorAll(".rsg-gal-grid .rsg-gal-card").length);
  ok("gallery cards carry a lazy thumbnail slot, label, category and theme dot", Array.from(host.querySelectorAll(".rsg-gal-card")).every((c) => c.querySelector(".rsg-gal-thumb[data-thumb]") && c.querySelector(".rsg-gal-meta b").textContent && c.querySelector(".rsg-gal-meta small").textContent && c.querySelector(".rsg-gal-dot")));
  host.querySelector('.rsg-gal-cats [data-galcat="shop"]').click();
  ok("category chip filters the grid", host.querySelectorAll(".rsg-gal-grid .rsg-gal-card").length === G.TEMPLATES.filter((t) => t.cat === "shop").length && host.querySelector('.rsg-gal-cats [data-galcat="shop"]').classList.contains("on"));
  host.querySelector('.rsg-gal-cats [data-galcat="all"]').click();
  const search = host.querySelector(".rsg-gal-search"); search.value = "timer"; search.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok("search filters by name / tags", G._galleryFiltered().length > 0 && G._galleryFiltered().length < G.TEMPLATES.length && G._galleryFiltered().every((t) => /timer/i.test(t.label + " " + t.tags.join(" ") + " " + t.screen)) && host.querySelectorAll(".rsg-gal-grid .rsg-gal-card").length === G._galleryFiltered().length);
  search.value = "zzzz-nothing"; search.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok("no-match search shows a friendly hint", host.querySelector(".rsg-gal-none") && host.querySelectorAll(".rsg-gal-card").length === 0);
  search.value = ""; search.dispatchEvent(new w.Event("input", { bubbles: true }));
  const before = G.getSpec();
  const card = host.querySelector('.rsg-gal-card[data-tpl="shop_pass"]') || host.querySelectorAll(".rsg-gal-card")[20];
  const picked = G.TEMPLATES.find((t) => t.id === card.dataset.tpl);
  card.click();
  ok("clicking a gallery card loads the template, switches to its theme preset and closes the gallery", gal.hidden === true && !G._state.galleryOpen && G.getSpec().screen.name === picked.screen && G._state.preset === picked.preset && G._state.tokens.primary === G._state.tokens.primary && host.querySelector(".rsg-preset-sel").value === picked.preset, [G.getSpec().screen.name, G._state.preset]);
  ok("the previous design is on the undo stack", G._state.history.length > 0);
  G.openGallery("featured");
  ok("openGallery('featured') shows only featured cards", host.querySelectorAll(".rsg-gal-card").length === G.TEMPLATES.filter((t) => t.featured).length);
  host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok("Escape closes the gallery", gal.hidden === true && !G._state.galleryOpen);
  // thumbnails: rendered once from the template's own preset, cached, state restored
  const t0 = G.TEMPLATES.find((t) => t.id === "hud");
  const savedNodes = G._state.nodes, savedPreset = G._state.preset;
  const html = G._renderThumbHtml(t0);
  ok("thumbnail renders the template at 1366×768 scaled into the card and restores designer state", /class="rsg-gal-shot" style="width:1366px;height:768px;--s:0\.1698/.test(html) && html.includes("rsg-n") && G._state.nodes === savedNodes && G._state.preset === savedPreset && G._thumbCache.get("hud") === html && G._renderThumbHtml(t0) === html);
  const menuThumb = G._renderThumbHtml(G.TEMPLATES.find((t) => t.id === "menu"));
  { const menuT = G.TEMPLATES.find((t) => t.id === "menu"); const roots = menuT.build(); const hiddenRoots = roots.filter((r) => r.visible === false);
    ok("thumbnails skip hidden windows (menu: 2 hidden roots not drawn, visible root drawn)", hiddenRoots.length === 2 && hiddenRoots.every((r) => !new RegExp('data-id="[^"]*"[^>]*>[^<]*' + r.name).test(menuThumb) && !menuThumb.includes(`>${r.name}<`)) && (menuThumb.match(/class="rsg-n/g) || []).length > 3 && (menuThumb.match(/class="rsg-n/g) || []).length < roots.reduce(function cnt(acc, n) { return acc + 1 + (n.children || []).reduce(cnt, 0); }, 0)); }
  void before; }
ok("24 component buttons rendered (advanced list)", host.querySelectorAll(".rsg-tools-full .rsg-comp").length === 24, host.querySelectorAll(".rsg-tools-full .rsg-comp").length);
Array.from(host.querySelectorAll(".rsg-tab")).find((b) => b.dataset.tab === "theme").click();
ok("10 theme presets rendered on the Theme tab", host.querySelectorAll(".rsg-preset").length === 10, host.querySelectorAll(".rsg-preset").length);
ok("4 side tabs (Props / Tree / Theme / Code)", host.querySelectorAll(".rsg-tab").length === 4);
// ── 1.50.1 GUI Studio logo ──────────────────────────────────────────────────
{ const sz = (f) => fs.statSync(path.join(R, f)).size;
  ok("1.50.1: the GUI Studio mark + wordmark assets ship and stay lean (< 100 KB each)", sz("assets/gui-studio-mark.png") > 2000 && sz("assets/gui-studio-mark.png") < 100000 && sz("assets/gui-studio-wordmark.png") > 5000 && sz("assets/gui-studio-wordmark.png") < 100000, [sz("assets/gui-studio-mark.png"), sz("assets/gui-studio-wordmark.png")]);
  ok("1.50.1: manifest exposes both logo assets in every web_accessible_resources block", JSON.parse(manifest).web_accessible_resources.length >= 2 && JSON.parse(manifest).web_accessible_resources.every((w) => w.resources.includes("assets/gui-studio-mark.png") && w.resources.includes("assets/gui-studio-wordmark.png")));
  const brandImg = host.querySelector(".rsg-title .rsg-brand img.rsg-logo");
  ok("1.50.1: title bar shows the GUI Studio mark + 'GUI Studio by ORscript'", brandImg && /assets\/gui-studio-mark\.png$/.test(brandImg.getAttribute("src")) && /GUI Studio/.test(host.querySelector(".rsg-brand").textContent) && host.querySelector(".rsg-brand small").textContent === "by ORscript", brandImg && brandImg.getAttribute("src"));
  ok("1.50.1: gallery header carries the mark", /gui-studio-mark\.png$/.test(host.querySelector(".rsg-gal-head img.rsg-gal-logo").getAttribute("src")));
  const spec0 = G.getSpec(); host.querySelector('[data-act="clear"]').click();
  ok("1.50.1: empty screen shows the full wordmark lockup above the start cards", /gui-studio-wordmark\.png$/.test(host.querySelector(".rsg-empty-stage img.rsg-empty-logo").getAttribute("src")) && host.querySelector(".rsg-empty-stage .rsg-empty-logo").compareDocumentPosition(host.querySelector(".rsg-empty-stage .rsg-start")) & 4);
  G.loadSpec(spec0);
  ok("1.50.1: bar button uses the mark (window + sidebar + solid pill + cursor) as inline SVG", main.includes('id="rs-gui-btn"') && main.includes('<rect x="10" y="12" width="7" height="3.5" rx="1.75" fill="currentColor" stroke="none"/><path d="M15 14.5l6.5 2.6-2.6 1 1.6 2.6-1.5.9-1.6-2.6-1.8 2.1z" fill="currentColor" stroke="none"/>'));
  ok("1.50.1: assetUrl falls back to a relative path on the hosted chat page", studio.includes('const assetUrl = (p) => { try { if (window.chrome && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL(p); } catch {} return p; };'));
  for (const c of [".rsg-logo {", ".rsg-brand small {", ".rsg-gal-logo {", ".rsg-empty-logo {"]) ok("css: " + c, css.includes(c)); }

setTimeout(async () => {
  try {
    const sel = host.querySelector(".rsg-template-sel");
    const pick = (id) => { sel.value = id; sel.dispatchEvent(new w.Event("change", { bubbles: true })); G._computeGeometry(); };
    for (const t of G.TEMPLATES) {
      const nodes = t.build();
      ok("template " + t.id + " builds nodes", Array.isArray(nodes) && nodes.length > 0);
      pick(t.id);
      const spec = G.getSpec();
      ok("template " + t.id + " loads into the canvas", spec.screen.name === t.screen && spec.children.length === nodes.length && host.querySelectorAll(".rsg-n").length > 0, [spec.screen.name, spec.children.length]);
      const lua = G.toLuau(spec);
      ok("template " + t.id + " exports Luau", /Instance\.new\("ScreenGui"\)/.test(lua) && lua.includes(`"${t.screen}"`), lua.slice(0, 200));
    }
    pick("menu");
    ok("menu template: 3 roots, 2 hidden windows", G.getSpec().children.length === 3 && G.getSpec().children.filter((c) => c.visible === false).length === 2);
    // programmatic node
    const node = G._makeNode("TextButton", { name: "Buy", text: "BUY", size: [0, 120, 0, 40], position: [0, 10, 0, 10] });
    G._adopt(node, null); G._state.nodes.push(node); G._reindex(); G._computeGeometry();
    const spec = G.getSpec();
    ok("getSpec() carries the new node with its props", spec.children.length === 4 && spec.children[3].class === "TextButton" && spec.children[3].text === "BUY" && !("id" in spec.children[3]) && !("_el" in spec.children[3]), spec.children[3]);
    ok("toLuau mentions the button and the screen", /TextButton/.test(G.toLuau(spec)) && /MainMenu/.test(G.toLuau(spec)));
    const copy = JSON.parse(JSON.stringify(spec));
    ok("loadSpec round-trips getSpec", G.loadSpec(copy) !== false && JSON.stringify(G.getSpec().children) === JSON.stringify(copy.children) && G.getSpec().screen.name === "MainMenu");
    // message
    const msg = G.buildMessage("make the play button start the round");
    ok("buildMessage: hand-off header + intent + ui_build_spec command block", msg.startsWith("GUI STUDIO HAND-OFF (ORscript)") && msg.includes("make the play button start the round") && msg.includes('{"command":"ui_build_spec","params":{"spec":') && msg.includes('"replace":true}}') && msg.includes("```json"), msg.slice(0, 300));
    // side tabs
    Array.from(host.querySelectorAll(".rsg-tab")).find((b) => b.dataset.tab === "code").click();
    ok("Code tab shows JSON + Luau", host.querySelector(".rsg-code-json").value.includes('"MainMenu"') && host.querySelector(".rsg-code-lua").value.includes("ScreenGui"));
    // theme preset switch re-tokens
    Array.from(host.querySelectorAll(".rsg-tab")).find((b) => b.dataset.tab === "theme").click();
    const neon = Array.from(host.querySelectorAll(".rsg-preset")).find((p) => p.dataset.preset === "neon"); neon.click();
    ok("theme preset click switches tokens", G.getSpec().preset === "neon" && G.getSpec().tokens.primary === SK.GUI_TOKEN_PRESETS.neon.primary, G.getSpec().tokens);
    // build in Studio
    host.querySelector('[data-act="build"]').click(); await new Promise((r) => setTimeout(r, 30));
    ok("Build runs ui_build_spec {spec, replace:true} through the hook", calls[0] && calls[0][0] === "ui_build_spec" && calls[0][1].replace === true && calls[0][1].spec.children.length === 4, calls[0] && calls[0][1]);
    ok("Build success reported in the overlay's own toast (the bar toasts are hidden under it)", host.querySelector(".rsg-send-status").textContent.includes("Built 7 object(s)") && host.querySelector(".rsg-toast").textContent === "Built in Studio" && host.querySelector(".rsg-toast").classList.contains("show") && !toasts.includes("Built in Studio"), host.querySelector(".rsg-toast").textContent);
    // import from Studio
    host.querySelector('[data-act="import"]').click(); await new Promise((r) => setTimeout(r, 30));
    const isel = host.querySelector(".rsg-import-sel");
    ok("Build verifies against Studio's real viewport afterwards (ui_layout_report on the built screen)", calls[1] && calls[1][0] === "ui_layout_report" && calls[1][1].path === "StarterGui.X", calls[1]);
    ok("Import lists the ScreenGuis", calls[2][0] === "ui_export_spec" && isel && isel.options.length === 1 && isel.options[0].value === "StarterGui.Imported", calls[1]);
    host.querySelector('[data-act="importGo"]').click(); await new Promise((r) => setTimeout(r, 30));
    ok("Import loads the exported spec", calls[3][0] === "ui_export_spec" && calls[3][1].path === "StarterGui.Imported" && G.getSpec().screen.name === "Imported" && G.getSpec().preset === "ocean" && G.getSpec().children.length === 1 && G.getSpec().children[0].children[0].name === "L", G.getSpec());
    // undo back to the pre-import design
    host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    ok("Ctrl+Z undoes the import", G.getSpec().screen.name === "MainMenu" && G.getSpec().children.length === 4, G.getSpec().screen);
    host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true }));
    ok("Ctrl+Y redoes it", G.getSpec().screen.name === "Imported");
    // send to AI
    host.querySelector(".rsg-intent").value = "wire everything"; host.querySelector(".rsg-intent").dispatchEvent(new w.Event("input", { bubbles: true }));
    host.querySelector('[data-act="send"]').click(); await new Promise((r) => setTimeout(r, 60));
    ok("Send to AI posts the hand-off through the send hook", sent.length === 1 && sent[0].startsWith("GUI STUDIO HAND-OFF (ORscript)") && sent[0].includes("wire everything") && sent[0].includes('"Imported"'), sent[0] && sent[0].slice(0, 200));
    ok("send diag recorded with the gui. prefix", diags.includes("gui.sent") && diags.includes("gui.built") && diags.includes("gui.open"), diags);
    // ── pointer interaction: clear, draw a Frame, draw a Button inside it, move, resize, marquee, nudge, dup, delete
    host.querySelector('[data-act="clear"]').click(); G._state.zoom = 1; G._computeGeometry();
    ok("clear empties the design and shows the empty-stage hint", G.getSpec().children.length === 0 && !!host.querySelector(".rsg-empty-stage"));
    const PE = w.PointerEvent || w.MouseEvent;
    const screen = host.querySelector(".rsg-screen");
    const pe = (type, x, y, extra) => new PE(type, Object.assign({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }, extra || {}));
    const dragOn = (target, x0, y0, x1, y1, extra) => { target.dispatchEvent(pe("pointerdown", x0, y0, extra)); w.dispatchEvent(pe("pointermove", (x0 + x1) / 2, (y0 + y1) / 2, extra)); w.dispatchEvent(pe("pointermove", x1, y1, extra)); w.dispatchEvent(pe("pointerup", x1, y1, extra)); G._computeGeometry(); };
    Array.from(host.querySelectorAll(".rsg-tool")).find((b) => b.dataset.tool === "frame").click();
    dragOn(screen, 96, 96, 400, 296);
    let roots = G.getSpec().children;
    ok("drag with the Frame tool creates a 304x200 Frame at 96,96 (grid-snapped)", roots.length === 1 && roots[0].class === "Frame" && roots[0].size[1] === 304 && roots[0].size[3] === 200 && roots[0].position[1] === 96 && roots[0].position[3] === 96, roots[0]);
    ok("empty-stage hint gone once something exists", !host.querySelector(".rsg-empty-stage"));
    ok("tool returns to Select after a create", host.querySelector(".rsg-stage").dataset.tool === "select" && G._state.tool === "select");
    const frameEl = screen.querySelector(".rsg-n");
    Array.from(host.querySelectorAll(".rsg-tool")).find((b) => b.dataset.tool === "button").click();
    dragOn(frameEl, 120, 120, 280, 168);
    roots = G.getSpec().children;
    { const fe = screen.querySelector(".rsg-n"), ce = fe.querySelector(".rsg-n");
      ok("nested child DOM box is relative to its parent (no double offset)", fe.style.left === "96px" && fe.style.top === "96px" && ce && ce.style.left === "24px" && ce.style.top === "24px", [fe.style.left, fe.style.top, ce && ce.style.left, ce && ce.style.top]); }
    ok("button drawn inside the frame nests under it with a relative position", roots.length === 1 && roots[0].children.length === 1 && roots[0].children[0].class === "TextButton" && roots[0].children[0].position[1] === 24 && roots[0].children[0].position[3] === 24 && roots[0].children[0].size[1] === 160 && roots[0].children[0].size[3] === 48, roots[0].children[0]);
    // move the frame by +50,+30 (select tool: pointerdown on the frame element itself)
    G._state.sel = []; G._computeGeometry();
    dragOn(screen.querySelector(".rsg-n"), 110, 110, 158, 142);
    roots = G.getSpec().children;
    ok("dragging the frame moves it (+48,+32) and keeps the child", roots[0].position[1] === 144 && roots[0].position[3] === 128 && roots[0].children.length === 1, roots[0].position);
    // resize via the SE handle
    const se = screen.querySelector(".rsg-h-se");
    ok("resize handles rendered for the single selection", !!se && screen.querySelectorAll(".rsg-h").length === 8);
    dragOn(se, 448, 328, 496, 376);
    roots = G.getSpec().children;
    ok("SE handle resize grows the frame by 48x48", roots[0].size[1] === 352 && roots[0].size[3] === 248, roots[0].size);
    // marquee on empty space selects everything inside
    dragOn(screen, 20, 20, 700, 600);
    ok("marquee selects the frame (not its child twice)", G._state.sel.length === 1 && G._state.sel[0].class === "Frame", G._state.sel.map((x) => x.class));
    // Shift+click toggles membership exactly once per press (pointerdown used to run twice)
    { const fe = screen.querySelector(".rsg-n"); const ce = fe.querySelector(".rsg-n");
      ce.dispatchEvent(pe("pointerdown", 200, 200, {})); w.dispatchEvent(pe("pointerup", 200, 200, {}));
      ok("plain click on a nested child selects its top-level parent first (Figma-style)", G._state.sel.length === 1 && G._state.sel[0].class === "Frame", G._state.sel.map((x) => x.class));
      screen.querySelector(".rsg-n .rsg-n").dispatchEvent(new w.MouseEvent("dblclick", { bubbles: true }));
      ok("double-click drills into the child", G._state.sel.length === 1 && G._state.sel[0].class === "TextButton", G._state.sel.map((x) => x.class));
      G._state.sel = []; G._computeGeometry(); screen.querySelector(".rsg-n .rsg-n") && null;
      const ce1 = screen.querySelector(".rsg-n .rsg-n");
      ce1.dispatchEvent(pe("pointerdown", 200, 200, { altKey: true })); w.dispatchEvent(pe("pointerup", 200, 200, { altKey: true }));
      ok("Alt+click grabs the deepest element directly", G._state.sel.length === 1 && G._state.sel[0].class === "TextButton", G._state.sel.map((x) => x.class));
      const fe2 = screen.querySelector(".rsg-n");
      fe2.dispatchEvent(pe("pointerdown", 100, 100, { shiftKey: true })); w.dispatchEvent(pe("pointerup", 100, 100, { shiftKey: true }));
      ok("Shift+click adds the frame to the selection (exactly once per press)", G._state.sel.length === 2, G._state.sel.map((x) => x.class));
      screen.querySelector(".rsg-n").dispatchEvent(pe("pointerdown", 100, 100, { shiftKey: true })); w.dispatchEvent(pe("pointerup", 100, 100, { shiftKey: true }));
      ok("Shift+click again removes it", G._state.sel.length === 1 && G._state.sel[0].class === "TextButton", G._state.sel.map((x) => x.class));
      G._state.sel = [byPath(G, "MainPanel") || G._state.nodes[0]]; }
    G._state.sel = [G._state.nodes[0]]; G._computeGeometry();
    // keyboard nudge
    host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    roots = G.getSpec().children;
    ok("Shift+Right nudges 10 px, Down nudges 1 px", roots[0].position[1] === 154 && roots[0].position[3] === 129, roots[0].position);
    Array.from(host.querySelectorAll(".rsg-tab")).find((b) => b.dataset.tab === "props").click();
    const nameInp = host.querySelector('.rsg-props input[data-k="name"]');
    ok("Props tab shows the Name field of the selected frame", nameInp && nameInp.value === "Frame", nameInp && nameInp.value);
    nameInp.value = "MainPanel"; nameInp.dispatchEvent(new w.Event("change", { bubbles: true }));
    ok("editing Name in Props renames the node", G.getSpec().children[0].name === "MainPanel", G.getSpec().children[0].name);
    host.querySelector('[data-act="dup"]').click(); G._computeGeometry();
    ok("duplicate creates a second root with a unique name", G.getSpec().children.length === 2 && G.getSpec().children[0].name !== G.getSpec().children[1].name, G.getSpec().children.map((c) => c.name));
    host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    ok("Delete removes the duplicate", G.getSpec().children.length === 1);
    // ── 1.49 accuracy + stability ─────────────────────────────────────────
    ok("source: 58 px topbar inset on every device (GuiService:GetGuiInset after the 2024 topbar)", G.DEVICES.every((d) => d.inset === 58) && studio.includes("58 px with the current Roblox topbar"));
    ok("source: Luau exporter is hardened (finite UDim2s, validated fonts, bracketed raw-prop keys, tokens restored in finally)", studio.includes("function luaFont(v) { const f = tokenFont(v); return FONTS.includes(f) ? f : \"GothamMedium\"; }") && studio.includes("const luaKey = (k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? \".\" + k : `[${luaStr(k)}]`);") && studio.includes("} finally { S.tokens = saveTokens; }"));
    ok("source: pointer handlers are guarded and a drag is cancelled on pointercancel / window blur / Escape", studio.includes('window.addEventListener("pointercancel", () => { if (S.open && drag) cancelDrag(); });') && studio.includes('window.addEventListener("blur", () => { if (S.open && drag) cancelDrag(); });') && studio.includes("if (drag && drag.kind !== \"none\") { e.preventDefault(); cancelDrag(); return; }"));
    ok("source: renderAll has an error boundary that undoes the last change", studio.includes('toast("Something went wrong while drawing — the last change was undone")'));
    ok("source: stage re-renders during drags are coalesced into animation frames", studio.includes("function renderStageSoon()") && studio.includes("renderStageSoon(); showGuides(gx, gy);"));
    ok("source: live colour drags push history once (undo reverts the colour)", studio.includes("const pushUnlessLive = (k) => { if (liveKey === k) { liveKey = null; return; } liveKey = null; pushHistory(); };"));
    ok("source: autosave is saved before unload and before every build", studio.includes('window.addEventListener("beforeunload", () => { if (S.nodes.length) autosaveNow(); });') && studio.includes("autosaveNow();\n    try {\n      const fb = await S.hooks.runTool(\"ui_build_spec\""));
    ok("source: an autosaved design is offered back on an empty open (Restore it / Start fresh) and never wiped by an empty render", studio.includes('<button type="button" class="rsg-btn sm primary" data-act="restore">Restore it</button><button type="button" class="rsg-btn sm" data-act="restoreDismiss">Start fresh</button>') && studio.includes("function autosaveNow() { if (!S.nodes.length) return;") && studio.includes("const saved = loadAutosave(); if (saved) {"));
    ok("css: text is no longer padded or clipped (Roblox draws text edge to edge and lets it overflow) + inline edit + restore + issues styles", css.includes(".rsg-txt { position: absolute; inset: 0; display: flex; padding: 0; overflow: visible;") && css.includes(".rsg-txt.editing {") && css.includes(".rsg-restore { pointer-events: auto;") && css.includes(".rsg-issue.error i { background: #ff5c5c; }"));
    // adopt() sanitises hostile specs
    G.loadSpec({ children: [{ class: "Frame", name: "Bad.Name", size: ["x", null, 0, "50"], position: [NaN, 10, 0, 0], anchor: [2, -1], children: [{ class: "ViewportFrame", name: "Dup" }, { class: "TextLabel", name: "Dup", text: 42 }, null, "nope"] }, { class: "Frame", name: "Bad_Name" }] });
    { const r = G.getSpec().children; const k = r[0].children;
      ok("adopt: dots leave names, duplicate siblings are renamed, non-objects dropped, unknown classes become Frame, text is a string", r[0].name === "Bad_Name" && r[1].name === "Bad_Name2" && k.length === 2 && k[0].class === "Frame" && k[0].name === "Dup" && k[1].name === "Dup2" && k[1].text === "42", [r.map((x) => x.name), k.map((x) => x.name + ":" + x.class)]);
      ok("adopt: non-finite UDim numbers become 0, anchors are clamped to 0..1", r[0].size.join() === "0,0,0,50" && r[0].position.join() === "0,10,0,0" && r[0].anchor.join() === "1,0", [r[0].size, r[0].position, r[0].anchor]); }
    // renames follow into behaviour targets
    G.loadSpec({ children: [{ class: "Frame", name: "Shop", size: [0, 300, 0, 200], visible: false, children: [{ class: "TextButton", name: "Close", text: "x", actions: [{ on: "click", do: "close", target: "parent" }] }] }, { class: "TextButton", name: "Open", text: "Shop", size: [0, 100, 0, 40], actions: [{ on: "click", do: "toggle", target: "gui.Shop" }] }, { class: "TextButton", name: "Sib", text: "s", size: [0, 100, 0, 40], actions: [{ on: "click", do: "open", target: "Shop" }] }] });
    G._rename(G._state.nodes[0], "Store.Window");
    { const r = G.getSpec().children;
      ok("rename: the dot is replaced and gui.Shop / bare sibling 'Shop' targets become the new name", r[0].name === "Store_Window" && r[1].actions[0].target === "gui.Store_Window" && r[2].actions[0].target === "Store_Window", [r[0].name, r[1].actions[0].target, r[2].actions[0].target]);
      ok("rename: a clash with a sibling gets a numbered name instead of a duplicate", (G._rename(G._state.nodes[2], "Open"), G._state.nodes[2].name === "Open2"), G._state.nodes[2].name);
      ok("resolveTarget mirrors OR_UIBehaviours byPath (parent / gui.Path / bare name anywhere)", G._resolveTarget(G._state.nodes[0].children[0], "parent") === G._state.nodes[0] && G._resolveTarget(G._state.nodes[1], "gui.Store_Window") === G._state.nodes[0] && G._resolveTarget(G._state.nodes[1], "Close") === G._state.nodes[0].children[0] && G._resolveTarget(G._state.nodes[1], "gui.Nope") === null); }
    // the checker
    G.loadSpec({ children: [{ class: "TextButton", name: "Buy", text: "Buy", size: [0, 100, 0, 40], actions: [{ on: "click", do: "open", target: "gui.Missing" }] }, { class: "TextButton", name: "Go", text: "Go", size: [0, 100, 0, 40], position: [0, 0, 0, 60], actions: [{ on: "click", do: "toggle" }] }, { class: "ImageLabel", name: "Icon", size: [0, 40, 0, 40], position: [0, 0, 0, 120] }, { class: "Frame", name: "Far", size: [0, 50, 0, 50], position: [0, 5000, 0, 0] }, { class: "TextLabel", name: "Long", text: "This is a very long caption that will not fit", text_size: 24, size: [0, 60, 0, 30], position: [0, 0, 0, 200] }] });
    { const issues = G.check(); const msgs = issues.map((i) => i.path + ": " + i.msg);
      ok("check(): missing target, dangling gui.Path, image without id, off-screen, overflowing text are all reported", msgs.some((m) => m.startsWith("Buy: target \"gui.Missing\" does not exist")) && msgs.some((m) => m.startsWith("Go: \"toggle\" needs a target")) && msgs.some((m) => m.startsWith("Icon: has no image id")) && msgs.some((m) => m.startsWith("Far: is completely off-screen")) && msgs.some((m) => m.startsWith("Long: text \"This is a very long cap") && m.includes("wider than the box")), msgs);
      ok("check(): unresolved targets are errors, the rest warnings", issues.filter((i) => i.level === "error").length === 2 && issues.filter((i) => i.level === "warn").length >= 3, issues.map((i) => i.level));
      calls.length = 0; host.querySelector('[data-act="build"]').click();
      ok("Build refuses to run with unresolved behaviour targets and opens the Check list instead of calling Studio", calls.length === 0 && host.querySelector(".rsg-issues") && host.querySelectorAll(".rsg-issue.error").length === 2 && host.querySelector(".rsg-send-status").textContent.includes("gui.Missing"), [calls.length, host.querySelector(".rsg-send-status").textContent]);
      host.querySelector(".rsg-issue.error").click();
      ok("clicking an issue selects the offending element", G._state.sel.length === 1 && G._state.sel[0].name === "Buy", G._state.sel.map((x) => x.name));
      host.querySelector('[data-act="check"]').click();
      ok("footer Check button re-runs the checker and summarises it in the overlay toast", /2 problems, \d+ warnings?/.test(host.querySelector(".rsg-toast").textContent), host.querySelector(".rsg-toast").textContent); }
    // layout accuracy: hidden children take no slot, grid alignment, automatic size
    G.loadSpec({ children: [{ class: "Frame", name: "L", size: [0, 200, 0, 300], layout: { kind: "list", gap: 10 }, children: [{ class: "Frame", name: "A", size: [1, 0, 0, 40] }, { class: "Frame", name: "H", size: [1, 0, 0, 40], visible: false }, { class: "Frame", name: "B", size: [1, 0, 0, 40] }] }, { class: "Frame", name: "Gr", size: [0, 200, 0, 100], position: [0, 300, 0, 0], layout: { kind: "grid", cell: [0, 40, 0, 40], gap: 0, h_align: "Center" }, children: [{ class: "Frame", name: "c1" }, { class: "Frame", name: "c2" }] }, { class: "TextLabel", name: "Auto", text: "Hello world", text_size: 20, size: [0, 10, 0, 10], position: [0, 0, 0, 400], automatic_size: "XY" }] });
    G._computeGeometry();
    { const bp = (nm) => G._geo.get(byPath(G, nm).id);
      ok("list layout skips invisible children like UIListLayout (B sits right after A)", bp("L.B").y === bp("L.A").y + 50, [bp("L.A"), bp("L.B")]);
      ok("grid layout honours HorizontalAlignment Center", bp("Gr.c1").x === 300 + (200 - 80) / 2 && bp("Gr.c2").x === bp("Gr.c1").x + 40, [bp("Gr.c1"), bp("Gr.c2")]);
      ok("AutomaticSize XY grows a text label to its text (canvas-less fallback: 0.55 em per glyph)", bp("Auto").w > 100 && bp("Auto").h >= 23 && bp("Auto").h <= 24, bp("Auto")); }
    // TextScaled fit: the preview font size is the largest that fits the box (<= 100)
    { const big = G._fitTextSize({ text: "Hi", font: "GothamBold" }, { w: 1000, h: 400 }); const small = G._fitTextSize({ text: "A fairly long sentence in here", font: "Gotham" }, { w: 120, h: 30 }); const fit = G._fitTextSize({ text: "Hi", font: "Gotham", text_fit: { min: 10, max: 32 } }, { w: 1000, h: 400 });
      ok("fitTextSize caps at 100 (Roblox limit), shrinks long text into small boxes, and obeys text_fit max", big === 100 && small >= 6 && small <= 16 && fit === 32, [big, small, fit]); }
    // inline text editing replaces prompt()
    G.loadSpec({ children: [{ class: "TextButton", name: "Btn", text: "Old", size: [0, 200, 0, 50], position: [0, 100, 0, 100] }] });
    G._state.sel = [G._state.nodes[0]]; G._computeGeometry(); host.querySelector('.rsg-tab[data-tab="props"]').click();
    { const el = screen.querySelector('.rsg-n[data-id="' + G._state.nodes[0].id + '"] > .rsg-txt');
      screen.querySelector(".rsg-n").dispatchEvent(new w.MouseEvent("dblclick", { bubbles: true }));
      const ed = screen.querySelector(".rsg-txt.editing");
      ok("double-click on the selected button starts inline editing (contenteditable, no prompt)", !!ed && ed.getAttribute("contenteditable") === "true", !!ed);
      ed.textContent = "New label"; ed.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      ok("Enter commits the new text (one undo step) and leaves edit mode", G.getSpec().children[0].text === "New label" && !screen.querySelector(".rsg-txt.editing") && G._state.history.length > 0, G.getSpec().children[0].text);
      const before = G._state.history.length; screen.querySelector(".rsg-n").dispatchEvent(new w.MouseEvent("dblclick", { bubbles: true }));
      const ed2 = screen.querySelector(".rsg-txt.editing"); ed2.textContent = "Discarded"; ed2.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      ok("Escape cancels the edit without touching the text or history", G.getSpec().children[0].text === "New label" && G._state.history.length === before, G.getSpec().children[0].text); void el; }
    // live colour undo: the input stream pushes history once, change does not push again
    G._state.history.length = 0; // (the 1.50 gallery checks above filled the 120-entry history cap)
    { const n0 = G._state.nodes[0]; G._state.sel = [n0]; host.querySelector('.rsg-tab[data-tab="props"]').click();
      const col = host.querySelector('.rsg-props input[data-sk="bg"], .rsg-props input[data-k="bg"][data-kind="color"]'); const h0 = G._state.history.length; const was = n0.bg;
      col.value = "#112233"; col.dispatchEvent(new w.Event("input", { bubbles: true })); col.value = "#445566"; col.dispatchEvent(new w.Event("input", { bubbles: true })); col.dispatchEvent(new w.Event("change", { bubbles: true }));
      ok("colour drag = one history entry, Ctrl+Z restores the original colour", G._state.history.length === h0 + 1 && n0.bg === "#445566" && (host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })), G.getSpec().children[0].bg === was), [G._state.history.length - h0, G.getSpec().children[0].bg, was]); }
    ok("Fill button names its real target in Simple mode", studio.includes('${parentOf(n) ? "Fill its panel" : "Fill the screen"}'));
    ok("Luau: text_fit forces TextScaled, raw prop keys are bracketed when not identifiers", (() => { const lua = G.toLuau({ children: [{ class: "TextLabel", name: "T", text: "x", text_size: 18, text_fit: { min: 8, max: 20 }, props: { "Weird Key": 1, ClearTextOnFocus: false } }] }); return lua.includes("o1.TextScaled = true") && !lua.includes("o1.TextSize = 18") && lua.includes('o1["Weird Key"] = 1') && lua.includes("o1.ClearTextOnFocus = false"); })());
    // escape closes
    host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    ok("Escape closes the studio", !G.isOpen() && !w.document.documentElement.classList.contains("rs-gui-open"));
    G.open({}); ok("re-open without hooks hides Build / Import", G.isOpen() && host.querySelector('[data-act="build"]').hidden && host.querySelector('[data-act="import"]').hidden); G.close();
    ok("no window errors during the run", errors.length === 0, errors);
    console.log(`test-gui-studio: ${n} checks passed`);
    process.exit(0);
  } catch (e) { console.error("THROW", e && e.stack || e); process.exit(1); }
}, 30);
