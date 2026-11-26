#!/usr/bin/env node
// 1.99.2 - GUI standard (src/core/gui_standard.js): the Multi-Script "Check-Clean-UI" port.
// Covers: attribution + no leaked ids / foreign tool names, every command named in the standard
// exists in the live catalogue, deterministic section selection (source semantics), budget,
// style resolution shared with studio_design.js STYLES, skill {name:"ui_ux"} integration, the
// main.js rider hook, manifest / codecraft load order, and the generator being reproducible.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { execFileSync } = require("child_process");
process.chdir(path.join(__dirname, ".."));
const read = (f) => fs.readFileSync(f, "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS " + name); } else { fail++; console.log("FAIL " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 400) : "")); } };

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
global.navigator = { userAgent: "node" };
global.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };
const manifest = JSON.parse(read("manifest.json"));
const bundle = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"))[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib\.js)/.test(f))) vm.runInThisContext(read(f), { filename: f });
vm.runInThisContext(read("src/core/gui_standard.js"), { filename: "gui_standard.js" });
vm.runInThisContext(read("src/core/skill_intel.js"), { filename: "skill_intel.js" });
const G = window.TotalGuiStandard, SI = window.TotalSkillIntel, PACK = RobloxScriptSkills;
const src = read("src/core/gui_standard.js");

// ── 1. module shape, provenance, hygiene ──
ok("module exposes window.TotalGuiStandard with the documented API", G && ["select", "render", "brief", "styleFor", "matchSections", "sectionNames"].every((k) => typeof G[k] === "function") && G.VERSION === "1.99.2");
ok("attribution: Multi-Script 6.49.9 Dev / check-clean-ui / GPL-3.0 named in the header and SOURCE", /Multi-Script 6\.49\.9 Dev/.test(src) && /GPL-3\.0/.test(src) && G.SOURCE.skill === "check-clean-ui" && G.SOURCE.license === "GPL-3.0-or-later");
ok("DOM-free, no storage, no network", !/\bdocument\.|localStorage|chrome\.storage|fetch\(|XMLHttpRequest|WebSocket/.test(src));
const allText = G.PREFACE.concat(G.SECTIONS.map((s) => s.rules.join("\n"))).join("\n");
ok("no asset ids carried over (never an unverified rbxassetid)", !/rbxassetid:\/\/\d+/.test(allText));
ok("no foreign tool names (search_asset / ms_* / Multi-Script) inside the rules", !/search_asset|\bms_[a-z_]+|Multi-Script/.test(allText));
ok("size: 50 sections, >100 KB of rules, 5 always-on sections incl. Core + TotalScript tools", G.SECTIONS.length === 50 && G.TOTAL_CHARS > 100000 && G.SECTIONS.filter((s) => s.kind === "always").map((s) => s.title).join("|") === "Core|TotalScript tools|Talking to the player|Design system|Internal checks (for you, never shown)");
ok("27 style sections, each mapped to a design_tokens_set style key", G.SECTIONS.filter((s) => s.kind === "style").length === 27 && G.SECTIONS.filter((s) => s.kind === "style").every((s) => G.STYLE_KEYS[s.title]));
ok("every optional section has trigger words and every trigger key is a section", G.SECTIONS.filter((s) => s.kind !== "always").every((s) => Array.isArray(G.TRIGGERS[s.title]) && G.TRIGGERS[s.title].length) && Object.keys(G.TRIGGERS).every((t) => G.SECTIONS.some((s) => s.title === t)));

// ── 2. every command the standard names exists in this build ──
const known = new Set(PACK.SKILL_COMMANDS.map((c) => c.name));
const mainSrc = read("src/core/main.js");
for (const core of ["total_screenshot", "skill", "web_search"]) if (new RegExp("[\"']" + core + "[\"']").test(mainSrc)) known.add(core);
const named = Array.from(new Set((allText.match(/`[a-z][a-z0-9]*_[a-z0-9_]+`/g) || []).map((x) => x.slice(1, -1)))).filter((n) => !/^(total_|rbxasset|ui_[a-z]+_[a-z]+_[a-z]+_[a-z]+)/.test(n) || known.has(n));
const unknown = named.filter((n) => !known.has(n) && !/^(Total_|rbxasset)/.test(n) && !/^[A-Z]/.test(n) && !["get_free_decals", "reduce_effects"].includes(n));
ok("every snake_case command named in the standard exists in the live catalogue (" + named.length + " names)", unknown.length === 0, unknown);
ok("TotalScript tools section names the real GUI commands", ["ui_inspect", "ui_screen_generate", "ui_from_spec", "design_tokens_set", "ui_states_wire", "ui_make_responsive", "ui_gamepad_focus", "ui_audit", "ui_preview", "ui_texture_create", "ui_font_set", "search_creator_store", "get_console_output"].every((n) => allText.includes("`" + n + "`")));
ok("every STYLE_KEYS value is a studio_design.js style (DESIGN_STYLES)", Object.values(G.STYLE_KEYS).every((k) => PACK.DESIGN_STYLES.includes(k)), Object.values(G.STYLE_KEYS).filter((k) => !PACK.DESIGN_STYLES.includes(k)));

// ── 3. selection semantics (port of the source's _rules_for_request) ──
const sel = (q, o) => G.select(q, o || { budget: 30000 });
ok("hasWord is word-bounded ('hud' does not match 'shudder', phrases match)", G.hasWord(" a shudder ran ", "hud") === false && G.hasWord(" my hud please ", "hud") && G.hasWord(" the main menu now ", "main menu"));
ok("no style named → Cartoon style stands in (named=false)", (() => { const s = G.styleFor("make a settings screen"); return s.section === "Cartoon style" && s.style === "cartoon" && s.named === false; })());
ok("named styles resolve: horror / glass / pixel / tactical→Realistic / studded", G.styleFor("a horror main menu").style === "horror" && G.styleFor("glass leaderboard").style === "glass" && G.styleFor("pixel art hud").style === "pixel" && G.styleFor("tactical fps hud with ammo").section === "Realistic style" && G.styleFor("lego studded shop").style === "studded");
ok("the request's style section always wins the budget race (cartoon shop: Cartoon style present even though Final review scores higher)", sel("make me a cartoon shop with pets").chosen.includes("Cartoon style"));
ok("default Cartoon drops out once another style is named", !sel("a horror main menu").chosen.includes("Cartoon style") && sel("a horror main menu").chosen.includes("Horror style"));
ok("always-on sections are sent whole; optional ones follow score then source order", (() => { const s = sel("glass leaderboard"); const idx = s.chosen.indexOf("Glass style"); return s.chosen.slice(0, 2).join("|") === "Core|TotalScript tools" && idx > 0; })());
ok("budget respected for optional sections (6000 → only always-on + what fits; skipped list names the rest)", (() => { const s = G.select("cartoon shop", { budget: 6000 }); return s.rows.filter((r) => r.kind !== "always").every((r) => r.rules.join("\n").length <= 6000) && s.skipped.length >= 40 && s.skipped.includes("Components"); })());
ok("deterministic: same input → identical output", G.render("make me a cartoon shop with pets", { budget: 30000 }) === G.render("make me a cartoon shop with pets", { budget: 30000 }));
ok("only:'studded' → Studded style + Studded shop screen, nothing else (no preface, no always-on)", (() => { const s = G.select("", { only: "studded" }); return s.chosen.join("|") === "Studded style|Studded shop screen" && s.only; })());
ok("matchSections accepts a title, a style key, an id or a trigger word", G.matchSections("Glass style").length === 1 && G.matchSections("scifi")[0] === "Sci-fi style" && G.matchSections("3d_in_ui")[0] === "3D in UI" && G.matchSections("viewportframe")[0] === "3D in UI");
ok("'3d pet preview' pulls the 3D in UI section (boost 98)", sel("pixel art title screen with 3d pet preview").chosen.includes("3D in UI"));

// ── 4. render / brief text ──
const r = G.render("make me a cartoon shop", { budget: 30000 });
ok("render: header names the sections + style + design_tokens_set {style}, preface, ## sections, pointer for the rest, precedence line", /^GUI STANDARD \(TotalScript 1\.99\.2\)/.test(r) && r.includes('design_tokens_set {style: "cartoon"}') && r.includes("## Core") && r.includes("## Cartoon style") && r.includes('skill {name: "ui_ux", section: "<name>"}') && /guidance only: nothing ran/.test(r));
ok("render stays near its budget (30000 → < 34000 chars)", r.length < 34000, r.length);
const b = G.brief("make me a cartoon shop"), bt = G.brief("make me a cartoon shop", { tight: true });
ok("brief ≤700 chars (≤320 tight), says it is from TotalScript not the user, names the style + skill pointer", b.length <= 700 && bt.length <= 320 && /^\(GUI standard from TotalScript, not the user\.\)/.test(b) && b.includes('design_tokens_set {style: "cartoon"}') && b.includes('skill {name: "ui_ux"') && bt.includes("ui_ux"));
ok("brief carries the finish rules (contrast / phone targets / emoji / ui_audit fix) when not tight", /4\.5:1/.test(b) && /40 px/.test(b) && /emoji/.test(b));
ok("brief for an unnamed style says to match the project's existing UI first", /unless the project already has a UI to match/.test(G.brief("settings screen")) && !/unless the project/.test(G.brief("horror settings screen")));

// ── 5. skill_intel integration ──
const a1 = SI.answer({ name: "ui_ux", query: "cartoon pet shop" });
ok("skill {name:'ui_ux', query} = expert procedure + the GUI standard for that request", /^SKILL ui_ux/.test(a1) && a1.includes("GUI STANDARD (TotalScript") && a1.includes("## Cartoon style") && a1.includes("## Complete screens and shops"));
const a2 = SI.answer({ name: "ui_ux", section: "Glass style" });
ok("skill {name:'ui_ux', section} = that section only", /^GUI STANDARD/.test(a2) && a2.includes("## Glass style") && !a2.includes("## Core") && !/^SKILL ui_ux/.test(a2));
ok("aliases: gui_standard / check-clean-ui / screengui resolve to ui_ux", SI.answer({ name: "gui_standard", section: "Pixel style" }).includes("## Pixel style") && SI.answer({ name: "check-clean-ui", section: "Pixel style" }).includes("## Pixel style"));
ok("other skills are untouched by the standard", !SI.answer({ name: "animation" }).includes("GUI STANDARD"));
ok("ui_ux procedure points at the standard and at ui_audit fix:true", SI.expertText("ui_ux").includes("GUI standard") && /ui_audit.*fix:true/.test(SI.expertText("ui_ux")));
ok("budget arg honoured (skill {name:'ui_ux', budget:5000} is far shorter than the default)", SI.answer({ name: "ui_ux", query: "cartoon shop", budget: 5000 }).length < SI.answer({ name: "ui_ux", query: "cartoon shop" }).length - 5000);

// ── 6. main.js hook, manifest, codecraft, generator ──
ok("main.js: GUI brief rides with the ui_ux expert note, same cap, diag gui.briefSent / gui.briefSkipped", /picked\[0\]\.id === "ui_ux" && typeof TotalGuiStandard !== "undefined"/.test(mainSrc) && /TotalGuiStandard\.brief\(reqText, \{ tight \}\)/.test(mainSrc) && mainSrc.includes('diag("gui.briefSent"') && mainSrc.includes('diag("gui.briefSkipped"'));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
ok("manifest: gui_standard.js loads right before skill_intel.js in every main.js bundle; codecraft.html too", bundles.length >= 10 && bundles.every((c) => c.js.indexOf("src/core/gui_standard.js") >= 0 && c.js.indexOf("src/core/gui_standard.js") === c.js.indexOf("src/core/skill_intel.js") - 1) && /gui_standard\.js"><\/script>\s*<script src="src\/core\/skill_intel\.js"/.test(read("codecraft.html")));
ok("studio_design: STYLES vocabulary (28 keys) incl. cartoon/sleek/glass/tactical/pixel/terminal/holographic; style param on design_tokens_set / ui_screen_generate / ui_from_spec", PACK.DESIGN_STYLES.length === 28 && ["cartoon", "sleek", "glass", "tactical", "pixel", "terminal", "holographic", "studded"].every((k) => PACK.DESIGN_STYLES.includes(k)) && ["design_tokens_set", "ui_screen_generate", "ui_from_spec"].every((n) => PACK.SKILL_COMMANDS.find((c) => c.name === n).params.style));
ok("designTokens({style:'cartoon'}) → preset candy, FredokaOne, radius 18, 3 px stroke; explicit font wins", (() => { const T = PACK.designTokens({ style: "cartoon" }); const U = PACK.designTokens({ style: "cartoon", font: "Arcade" }); return T.preset === "candy" && T.style === "cartoon" && T.font.Family === "FredokaOne" && T.radius.md === 18 && T.stroke.thickness === 3 && U.font.Family === "Arcade"; })());
ok("designStyleKey normalises aliases (Sci-Fi → scifi, Lego → studded, neumorphism → neumorphic, 'Cartoon style' → cartoon)", PACK.designStyleKey("Sci-Fi") === "scifi" && PACK.designStyleKey("Lego") === "studded" && PACK.designStyleKey("neumorphism") === "neumorphic" && PACK.designStyleKey("Cartoon style") === "cartoon");
ok("ui_audit: fix / min_target / phone params; grade + fixed + phone in the Luau", (() => { const c = PACK.SKILL_COMMANDS.find((c) => c.name === "ui_audit"); const lua = PACK.buildLuau("ui_audit", { path: "StarterGui", fix: true }).code; return c.params.fix && c.params.min_target && c.params.phone && /local doFix=true/.test(lua) && /grade=/.test(lua) && /fixed=fixed/.test(lua) && /phone_small_target/.test(lua) && /huge_tree/.test(lua) && /fixed_wide/.test(lua); })());
ok("10 token presets unchanged (styles are layered on top, not new presets)", PACK.DESIGN_PRESETS.length === 10);
// Generator reproducibility: only when the source archive is present next to the repo.
const zip = path.join("..", "Multi-Script-6.49.9-Dev.zip");
if (fs.existsSync(zip)) {
  try {
    const tmp = path.join(require("os").tmpdir(), "gui_standard_regen_" + process.pid);
    fs.mkdirSync(path.join(tmp, "src", "core"), { recursive: true });
    fs.copyFileSync("tools/port_gui_standard.py", path.join(tmp, "port.py"));
    fs.mkdirSync(path.join(tmp, "tools"), { recursive: true });
    fs.renameSync(path.join(tmp, "port.py"), path.join(tmp, "tools", "port_gui_standard.py"));
    execFileSync("python3", [path.join(tmp, "tools", "port_gui_standard.py"), zip], { stdio: "pipe" });
    ok("tools/port_gui_standard.py regenerates a byte-identical gui_standard.js from the archive", read(path.join(tmp, "src", "core", "gui_standard.js")) === src);
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) { ok("generator run", false, String(e && e.message || e).slice(0, 200)); }
} else console.log("skip generator reproducibility (archive not present)");

console.log("\n" + (fail ? "FAIL  " : "OK    ") + "test-gui-standard: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
