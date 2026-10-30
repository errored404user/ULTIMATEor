"use strict";
// 1.78.0 — ART DIRECTION engine: TotalScript can build cinematic / stylised
// GUIs (Hollow-Knight-class title screens, glowing serif titles, ornaments,
// generated + published textures, Creator Store images, custom fonts,
// particles) instead of flat app panels. Static checks on the pack, the
// catalogue, the prompts and the gates.
// tests/artui-sim.py executes the generated Luau and the LocalScripts.
const fs = require("fs"), vm = require("vm");
let n = 0;
function ok(label, cond, detail) { n++; if (!cond) { console.log("FAIL  " + label + (detail ? " — " + String(detail).slice(0, 400) : "")); process.exitCode = 1; } else console.log("PASS  " + label); }

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p, getManifest: () => ({ version: "0" }) } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
ok("every main.js bundle loads studio_artui.js after studio_cutscene.js and studio_guistudio.js, before studio_bridge.js", bundles.length > 0 && bundles.every((b) => {
  const i = b.js.indexOf("src/core/skills/studio_artui.js");
  return i > b.js.indexOf("src/core/skills/studio_cutscene.js") && i > b.js.indexOf("src/core/skills/studio_guistudio.js") && i < b.js.indexOf("src/core/studio_bridge.js");
}));
ok("codecraft.html loads the pack in the same place", (() => { const h = fs.readFileSync("codecraft.html", "utf8"); const i = h.indexOf("skills/studio_artui.js"); return i > h.indexOf("skills/studio_cutscene.js") && i < h.indexOf("src/core/studio_bridge.js"); })());
const bundle = bundles[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = RobloxScriptSkills;
const pack = fs.readFileSync("src/core/skills/studio_artui.js", "utf8");

// ── pack + catalogue ──
ok("pack header + version", pack.includes("TotalScript ART DIRECTION pack (1.78.0)") && /const VERSION = "1\.78\.0"/.test(pack) && S.ARTUI_VERSION === "1.78.0");
ok("no 'configured' fake result anywhere in the pack", !/configured'\)/.test(pack));
const names = ["ui_art_theme_set", "ui_art_theme_get", "ui_texture_create", "ui_image_find", "ui_font_set", "ui_text_fx", "ui_decor_add", "ui_art_build", "ui_art_restyle"];
ok("ARTUI_COMMANDS exports the 9 names", JSON.stringify(S.ARTUI_COMMANDS) === JSON.stringify(names));
for (const nm of names) {
  const hits = S.SKILL_COMMANDS.filter((c) => c.name === nm);
  ok("catalogue has exactly one " + nm + " with a real description", hits.length === 1 && hits[0].description.length > 60 && hits[0].params && typeof hits[0].params === "object");
}
ok("ui_art_theme_get and ui_image_find are hidden (reachable, not in the visible budget); the other 7 are visible", S.SKILL_COMMANDS.filter((c) => names.includes(c.name) && c.hidden).map((c) => c.name).sort().join() === "ui_art_theme_get,ui_image_find");
ok("SKILL_OPS lists every art command (in-place catalogue mutation, describeCommands keeps its reference)", names.every((nm) => S.SKILL_OPS.includes(nm)) && typeof S.describeCommands === "function" && names.filter((nm) => !/theme_get|image_find/.test(nm)).every((nm) => String(S.describeCommands()).includes(nm)) && !String(S.describeCommands()).includes("ui_art_theme_get"));
ok("9 themes / 14 texture kinds / 11 decor kinds / 48 font names exported", S.ARTUI_THEMES.length === 9 && S.ARTUI_THEMES.includes("hollow") && S.ARTUI_TEXTURES.length === 14 && S.ARTUI_TEXTURES.includes("flourish") && S.ARTUI_DECOR.length === 11 && S.ARTUI_DECOR.includes("corner_ornaments") && S.ARTUI_FONTS.length === 48 && S.ARTUI_FONTS.includes("Garamond"));

// ── generated Luau shape ──
const build = S.buildLuau("ui_art_build", { name: "MainMenu", spec: { theme: "hollow", title: { text: "Hollow Knight", tracking: 6 }, menu: { items: ["Start", "Options", "Quit"] }, backdrop: { image: "store:dark cave" } } });
ok("ui_art_build returns {code, lib, body} like the other packs (library-cache friendly)", build && !build.err && typeof build.lib === "string" && typeof build.body === "string" && build.code === build.lib + "\n" + build.body);
ok("the body stays small (spec + call); the big builder lives in the shared library", build.body.length < 4000 && build.lib.includes("local function artBuild(spec,parentPath,replace)"), build.body.length);
ok("library: EditableImage pixel pipeline (CreateEditableImage → buffer → WritePixelsBuffer) and CreateAssetAsync publishing in pcall with the honest live-preview fallback (Content.fromObject + TotalTextureLive)", /AssetService:CreateEditableImage\(\{Size=Vector2\.new\(w,h\)\}\)/.test(build.lib) && /buffer\.writeu8/.test(build.lib) && /img:WritePixelsBuffer\(/.test(build.lib) && /pcall\(function\(\) return AssetService:CreateAssetAsync\(img,Enum\.AssetType\.Image/.test(build.lib) && /Content\.fromObject\(tex\.live\)/.test(build.lib) && /TotalTextureLive/.test(build.lib));
ok("library: texture cache in ReplicatedStorage.Total_Art.Textures keyed by kind/size/colours", /folder\(artRoot\(\),'Textures'\)/.test(build.lib) && /local function texKey\(kind,size,c1,c2,o\)/.test(build.lib));
ok("library: fonts through FontFace - Font.fromEnum(Enum.Font[name]).Family + Font.new(family, weight, style) and Font.new('rbxassetid://id') for uploaded fonts", /Font\.fromEnum\(Enum\.Font\[tostring\(name or 'GothamMedium'\)\]\)\.Family/.test(build.lib) && /Font\.new\('rbxassetid:\/\/'\.\.id,w,st\)/.test(build.lib) && /Font\.new\(fam,w,st\)/.test(build.lib));
ok("library: Creator Store search = InsertService:GetFreeDecals in pcall (never catalog HTTP from Luau)", /pcall\(function\(\) return InsertService:GetFreeDecals\(tostring\(query\),tonumber\(page\) or 0\) end\)/.test(build.lib) && !/catalog\.roblox\.com/.test(pack));
ok("library: image sources id / rbxassetid:// / store:<query> / tex:<kind>", /v:match\('\^store:\(\.\+\)\$'\)/.test(build.lib) && /v:match\('\^tex:\(%w\+\)\$'\)/.test(build.lib) && /v:match\('\^%d\+\$'\)/.test(build.lib));
ok("library: text glow = stacked UIStroke clones behind the label; per-letter tracking via utf8 + horizontal UIListLayout; wrapper only when the parent lays children out", /local function textGlow\(label,color,size,layers,pulse\)/.test(build.lib) && /utf8\.codes\(text\)/.test(build.lib) && /FillDirection=Enum\.FillDirection\.Horizontal/.test(build.lib) && /local function hasLayout\(p\)/.test(build.lib));
ok("library: 9 themes incl. hollow (Garamond, uppercase, tracking 5, flourish markers) and the 1280x720 canvas with root UIScale", /hollow=\{label='Hollow - pale serif capitals/.test(build.lib) && /font='Garamond',weight=600/.test(build.lib) && /canvas:SetAttribute\('TotalCanvas','1280x720'\)/.test(build.lib) && /sc\.Scale=math\.min\(cam\.ViewportSize\.X\/1280,cam\.ViewportSize\.Y\/720\)/.test(build.lib));
ok("the three LocalScripts are exported and Luau-safe (no backticks / continue); the menu controller handles hover, keyboard + gamepad, actions and the bus", [S.ARTUI_MOTION_SRC, S.ARTUI_PARTICLES_SRC, S.ARTUI_MENU_SRC].every((src) => src.length > 800 && !/`/.test(src) && !/\bcontinue\b/.test(src)) && /Enum\.KeyCode\.DPadDown/.test(S.ARTUI_MENU_SRC) && /Enum\.KeyCode\.ButtonA/.test(S.ARTUI_MENU_SRC) && /bus:Fire\(gui\.Name, btn\.Name, action\)/.test(S.ARTUI_MENU_SRC) && /kind == "remote"/.test(S.ARTUI_MENU_SRC) && /RenderStepped:Connect/.test(S.ARTUI_MOTION_SRC) && /GetAttribute\("TotalCanvas"\)/.test(S.ARTUI_MOTION_SRC));
ok("ui_art_build without a spec / with nothing to draw fails at build time (no silent default screen)", /return fail\('ui_art_build needs spec/.test(S.buildLuau("ui_art_build", {}).code) && /nothing to draw/.test(S.buildLuau("ui_art_build", { spec: { theme: "hollow" } }).code));
ok("ui_texture_create / ui_decor_add validate their kind lists at build time", /return fail\('ui_texture_create: kind must be one of glow\|soft_circle/.test(S.buildLuau("ui_texture_create", { kind: "x" }).code) && /return fail\('ui_decor_add: kind must be one of vignette\|backdrop/.test(S.buildLuau("ui_decor_add", { parent: "StarterGui.X", kind: "x" }).code));
ok("ui_text_fx builds only the requested layers (glow + tracking here, no shadow / outline / gradient)", (() => { const c = S.buildLuau("ui_text_fx", { path: "StarterGui.A.T", glow: true, tracking: 3 }).body; return /textGlow\(g,/.test(c) && /trackText\(g,3\)/.test(c) && !/textShadow\(/.test(c) && !/UIGradient/.test(c); })());
ok("colours accept hex / short hex / names / rgb arrays", (() => { const c = S.buildLuau("ui_art_theme_set", { theme: "royal", accent: "gold", text: "#fff", glow: [255, 128, 0] }).body; return /\['accent'\]="#d4af37"/.test(c) && /\['text'\]="#ffffff"/.test(c) && /\['glow'\]="#ff8000"/.test(c); })());

// ── prompts, gates, name index ──
const config = fs.readFileSync("src/core/config.js", "utf8");
const main = fs.readFileSync("src/core/main.js", "utf8");
ok("config.js name index lists the art commands (and the index was deduped to pay for them)", /ui_art_theme_set, ui_art_build, ui_art_restyle, ui_text_fx, ui_decor_add, ui_font_set, ui_texture_create, ui_image_find,/.test(config));
ok("DESIGN MANDATE carries the ART LAYER (theme once, ui_art_build for title / pause / menu screens, restyle + text fx + decor elsewhere, three image sources)", /ART LAYER: ui_art_theme_set once; ui_art_build \{spec\} for title \/ pause \/ menu screens; ui_art_restyle \+ ui_text_fx \+ ui_decor_add on other screens; images: ui_texture_create \/ ui_image_find \/ own ids\./.test(config));
vm.runInThisContext(config + ";globalThis.__RS=RS;");
const RS = globalThis.__RS; window.__rsWorkMode = () => "creation";
const base = RS.guiBrief({}), ref = RS.guiBrief({ reference: true, imageAttached: true });
ok("GUI brief step 2 = art direction with the art pack (theme list, textures, image sources, text fx, decor, fonts)", base.includes("2. ART DIRECTION:") && base.includes("ui_art_theme_set {theme: hollow|dark_fantasy|arcane|scifi|cartoon|horror|royal|minimal_lux|pixel") && base.includes("ui_texture_create (glow, vignette, fog, rays, divider, flourish, frame_border) / ui_image_find {query} / the user's asset ids") && base.includes("ui_text_fx (layered glow, tracking, shadow, gradient)") && base.includes("ui_decor_add (vignette, particles, rays, fog, frame, corner_ornaments, markers, glow_blob)") && base.includes("ui_font_set for real typography"));
ok("GUI brief step 3 = ui_art_build for title / pause / chapter / results screens, ui_build_spec + ui_art_restyle for the rest", base.includes("3. BUILD IN ONE SHOT: a title / pause / chapter / results screen is ONE ui_art_build {name, spec:{theme, backdrop, title, menu, footer, extras, intro}} call") && base.includes("then ui_art_restyle {path} + ui_decor_add so it carries the art direction."));
ok("GUI brief reference protocol = CLONE, do not approximate (real images via ui_image_find / ui_texture_create / user ids, typeface via ui_font_set + tracking, ui_art_build for menu screens)", ref.includes("CLONE, do not approximate") && ref.includes("ui_image_find {query} for store assets") && ref.includes("font_asset_id when the user uploads the TTF") && ref.includes("ui_art_build territory") && !base.includes("CLONE, do not approximate"));
ok("prompt budgets still hold after the art lines (v134 < 38000 without catalogue, full < 18500, tight <= 14000)", (() => { const cat = "━━━ COMMAND CATALOGUE (embedded; this IS the list_commands result) ━━━\nx {}"; const live = RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox", catalogue: cat }); const tight = RS.buildSystemPrompt({ siteName: "ChatGPT", providerId: "chatgpt", engine: "roblox", maxChars: 14000 }); return live.length - cat.length < 38000 && RS.workModePrompt("creation").length < 18500 && tight.length <= 14000; })());
ok("look gate: art commands count as 'did' but the read-only ui_image_find / ui_art_theme_get do not", (() => { const m = main.match(/id: "look",\s*did: (\/[^\n]*\/),/); if (!m) return false; const re = eval(m[1]); return re.test("ui_art_build") && re.test("ui_text_fx") && re.test("ui_decor_add") && re.test("ui_texture_create") && !re.test("ui_image_find") && !re.test("ui_art_theme_get") && !re.test("ui_list_tree"); })());
ok("UI family regex groups ui_art_* / ui_text_fx / ui_decor_add under UI & HUD", (() => { const m = main.match(/id: "ui", label: "UI & HUD", re: (\/[^\n]*?\/) \}/); if (!m) return false; const re = eval(m[1]); return re.test("ui_art_build") && re.test("ui_decor_add") && re.test("ui_texture_create"); })());

// (1.90.0: the GUI Studio window and its art panel were removed; the art pack + GUI brief above are the whole art route)

// ── docs, tests, versions ──
const readme = fs.readFileSync("README.md", "utf8");
ok("README changelog + test list", /\*\*1\.78\.0 — Art direction engine/.test(readme) && /test-artui\.js/.test(readme) && /artui-sim\.py/.test(readme) && names.filter((x) => !/theme_get/.test(x)).every((x) => readme.includes("`" + x)));
ok("test-command-dedup.js scans the art pack", /"studio_artui\.js"/.test(fs.readFileSync("tests/test-command-dedup.js", "utf8")));
ok("simulator stubs for the pack are real stand-ins (EditableImage buffer, CreateAssetAsync ids, GetFreeDecals, Font / buffer / Content)", (() => { const sim = fs.readFileSync("tests/roblox_sim.py", "utf8"); return /function methods:CreateEditableImage/.test(sim) && /function methods:WritePixelsBuffer/.test(sim) && /function methods:CreateAssetAsync/.test(sim) && /function methods:GetFreeDecals/.test(sim) && /_G\.Font = \{/.test(sim) && /_G\.buffer = \{/.test(sim) && /_G\.Content = \{/.test(sim); })());
ok("version pins 1.99.4 (manifest, plugin, crate)", manifest.version === "1.99.4" && fs.readFileSync("plugin/TotalScript.lua", "utf8").includes('local VERSION = "1.99.4"') && /^version = "1\.99\.4"/m.test(fs.readFileSync("agent/Cargo.toml", "utf8")));

console.log(`\n${n} checks, exit ${process.exitCode || 0}`);
