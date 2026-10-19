// 1.48.0 — GUI Studio: the Paint-style visual GUI builder (src/core/guistudio.js) + the
// extra GUI command pack (src/core/skills/studio_guistudio.js) and their wiring.
// Run: NODE_PATH=/tmp/harness/node_modules node tests/test-gui-studio.js
const fs = require("fs"), path = require("path"), assert = require("assert");
const R = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
const main = read("src/core/main.js"), css = read("overlay.css"), manifest = read("manifest.json"), codecraft = read("codecraft.html");
const studio = read("src/core/guistudio.js"), pack = read("src/core/skills/studio_guistudio.js");
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
  "return runTool({ tool: name, arguments: args || {} });",
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
for (const f of ["src/core/skills/studio_skills.js", "src/core/skills/studio_design.js", "src/core/skills/studio_gui.js", "src/core/skills/studio_guistudio.js", "src/core/guistudio.js"]) load(f);
ok("scripts load without window errors", errors.length === 0, errors);
const G = w.ORGuiStudio;
ok("window.ORGuiStudio exported", G && typeof G.open === "function" && typeof G.toLuau === "function");
const ev = (src) => { const el = w.document.createElement("script"); el.textContent = "window.__t = (" + src + ");"; w.document.head.appendChild(el); return w.__t; };
const SK = ev("RobloxScriptSkills");
ok("hidden ops stay callable through SKILL_OPS", SK.SKILL_OPS.includes("ui_text_fit") && SK.SKILL_OPS.includes("ui_zorder_fix") && SK.hiddenCommandNames().has("ui_zorder_fix") && !SK.hiddenCommandNames().has("ui_build_spec"));
ok("pack catalogue: 17 ops / 24 component kinds / 10 presets", SK.GUISTUDIO_VERSION === "1.48.0" && SK.GUI_COMPONENT_KINDS.length === 24 && Object.keys(SK.GUI_TOKEN_PRESETS).length === 10, [SK.GUI_COMPONENT_KINDS && SK.GUI_COMPONENT_KINDS.length, SK.GUI_TOKEN_PRESETS && Object.keys(SK.GUI_TOKEN_PRESETS).length]);

const sent = [], calls = [], toasts = [], diags = [];
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
ok("catalogues: 10 templates / 4 devices / 9 element tools", G.TEMPLATES.length === 10 && G.DEVICES.length === 4 && G.ELEMENT_TOOLS.length === 9);
ok("24 component buttons rendered", host.querySelectorAll(".rsg-comp").length === 24, host.querySelectorAll(".rsg-comp").length);
Array.from(host.querySelectorAll(".rsg-tab")).find((b) => b.dataset.tab === "theme").click();
ok("10 theme presets rendered on the Theme tab", host.querySelectorAll(".rsg-preset").length === 10, host.querySelectorAll(".rsg-preset").length);
ok("4 side tabs (Props / Tree / Theme / Code)", host.querySelectorAll(".rsg-tab").length === 4);

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
    ok("Build success reported", host.querySelector(".rsg-send-status").textContent.includes("Built 7 object(s)") && toasts.includes("Built in Studio"), host.querySelector(".rsg-send-status").textContent);
    // import from Studio
    host.querySelector('[data-act="import"]').click(); await new Promise((r) => setTimeout(r, 30));
    const isel = host.querySelector(".rsg-import-sel");
    ok("Import lists the ScreenGuis", calls[1][0] === "ui_export_spec" && isel && isel.options.length === 1 && isel.options[0].value === "StarterGui.Imported", calls[1]);
    host.querySelector('[data-act="importGo"]').click(); await new Promise((r) => setTimeout(r, 30));
    ok("Import loads the exported spec", calls[2][0] === "ui_export_spec" && calls[2][1].path === "StarterGui.Imported" && G.getSpec().screen.name === "Imported" && G.getSpec().preset === "ocean" && G.getSpec().children.length === 1 && G.getSpec().children[0].children[0].name === "L", G.getSpec());
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
    ok("clear empties the design", G.getSpec().children.length === 0);
    const PE = w.PointerEvent || w.MouseEvent;
    const screen = host.querySelector(".rsg-screen");
    const pe = (type, x, y, extra) => new PE(type, Object.assign({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }, extra || {}));
    const dragOn = (target, x0, y0, x1, y1, extra) => { target.dispatchEvent(pe("pointerdown", x0, y0, extra)); w.dispatchEvent(pe("pointermove", (x0 + x1) / 2, (y0 + y1) / 2, extra)); w.dispatchEvent(pe("pointermove", x1, y1, extra)); w.dispatchEvent(pe("pointerup", x1, y1, extra)); G._computeGeometry(); };
    Array.from(host.querySelectorAll(".rsg-tool")).find((b) => b.dataset.tool === "frame").click();
    dragOn(screen, 96, 96, 400, 296);
    let roots = G.getSpec().children;
    ok("drag with the Frame tool creates a 304x200 Frame at 96,96 (grid-snapped)", roots.length === 1 && roots[0].class === "Frame" && roots[0].size[1] === 304 && roots[0].size[3] === 200 && roots[0].position[1] === 96 && roots[0].position[3] === 96, roots[0]);
    ok("tool returns to Select after a create", host.querySelector(".rsg-stage").dataset.tool === "select" && G._state.tool === "select");
    const frameEl = screen.querySelector(".rsg-n");
    Array.from(host.querySelectorAll(".rsg-tool")).find((b) => b.dataset.tool === "button").click();
    dragOn(frameEl, 120, 120, 280, 168);
    roots = G.getSpec().children;
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
    // escape closes
    host.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    ok("Escape closes the studio", !G.isOpen() && !w.document.documentElement.classList.contains("rs-gui-open"));
    G.open({}); ok("re-open without hooks hides Build / Import", G.isOpen() && host.querySelector('[data-act="build"]').hidden && host.querySelector('[data-act="import"]').hidden); G.close();
    ok("no window errors during the run", errors.length === 0, errors);
    console.log(`test-gui-studio: ${n} checks passed`);
    process.exit(0);
  } catch (e) { console.error("THROW", e && e.stack || e); process.exit(1); }
}, 30);
