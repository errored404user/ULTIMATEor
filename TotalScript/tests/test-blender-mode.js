// 1.95.0 — BLENDER work mode (Blender-first 3D artist). MOCKED: no Blender, no
// Studio, no AI site. Run from the TotalScript root:
//   NODE_PATH=/path/to/jsdom/node_modules node tests/test-blender-mode.js
//
// What this proves:
//   A. config.js: the Blender profile (full + tight), checklist, playbooks and
//      label exist next to Totality; budgets hold (ChatGPT / Vani 14k, Gemini +
//      the BLENDER MCP block < 48k); every command the profile cites exists
//      (Blender btools in background.js or a core/skill command); it teaches
//      what to do when Blender is NOT connected; the Totality prompt is
//      byte-identical to the committed 1.94.0 output (nothing else changed).
//   B. main.js: WORK_MODES.blender (card copy, 8 quick starts, focus regex),
//      normaliser, blenderModeTools() folds the Blender server's tools into
//      the default catalogue ONLY in Blender mode, FAMILY_ORDER.blender puts
//      the BLENDER family first and the real buildCatalogue honours it, the
//      asset / import evidence gates fire and stay silent correctly, the
//      scripts / look gates are shared.
//   C. UI: overlay.css badge + card accents, popup picker (popup.js / .html).
//   D. README changelog + test listing.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), cp = require("child_process");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let failed = 0;
const ok = (name, cond, extra) => { if (cond) console.log("ok   " + name); else { failed++; console.log("FAIL " + name + (extra !== undefined ? " — " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "")); } };

const main = read("src/core/main.js"), config = read("src/core/config.js"), css = read("overlay.css"), popup = read("popup.js"), popupHtml = read("popup.html"), bg = read("background.js"), readme = read("README.md");
global.window = global; global.chrome = { runtime: { getURL: (p) => p }, storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } } };
window.__rsWorkMode = () => "creation";
vm.runInThisContext(read("src/core/parser.js") + ";globalThis.RSParse=RSParse;");
vm.runInThisContext(config + ";globalThis.__RS=RS;");
const RS = globalThis.__RS;

// ── A. config.js profile ───────────────────────────────────────────────────
const full = RS.workModePrompt("blender"), tight = RS.workModePrompt("blender", { tight: true });
ok("A1 WORK_MODE_PROMPTS has creation + blender; normalizeModeId keeps blender and still folds unknown ids to creation", Object.keys(RS.WORK_MODE_PROMPTS).join() === "creation,blender" && RS.workModeLabel("blender") === "Blender" && RS.workModeLabel("ultimate") === "Totality" && RS.workModePrompt("nope") === RS.workModePrompt("creation"));
ok("A2 full profile: shared loop first, own heading, FIRST MOVE get_scene_info, mandate + proof + never list, playbooks appended", full.startsWith("━━━ OPERATING LOOP (every work mode) ━━━") && full.includes("━━━ BLENDER WORK MODE (Blender-first") && /FIRST MOVE: get_scene_info/.test(full) && /ASSET MANDATE/.test(full) && /PROVE IT \(structure, then pixels, then Studio\)/.test(full) && /\nNEVER: start by dropping primitives/.test(full) && full.includes("PLAYBOOKS (Blender mode"));
ok("A3 tight profile: own heading, pipeline in one paragraph, no playbooks", tight.startsWith("━━━ OPERATING LOOP ━━━") && tight.includes("━━━ BLENDER WORK MODE (Blender-first 3D artist; Studio is the destination) ━━━") && /PIPELINE: blender_asset_plan/.test(tight) && !tight.includes("PLAYBOOKS ("));
ok(`A4 budgets: full ${full.length} in (9000, 15000), tight ${tight.length} in (1800, 3000)`, full.length > 9000 && full.length < 15000 && tight.length > 1800 && tight.length < 3000);
ok("A5 Blender is prioritised: geometry comes from Blender, Studio part assembly is a fallback the user agrees to", /Blender is the modeling engine and Roblox Studio is the destination/.test(full) && /model_build \/ model_prefab \/ part_create\) is a fallback only when the user asks for it, or Blender is unavailable and the user agrees/.test(full) && /Studio part assembly only if the user asks, or Blender is unavailable and they agree/.test(tight));
ok("A6 not-connected path is explicit in both variants (ask to Start MCP Server + Connect Blender, then WAIT - never build cubes instead)", /Start MCP Server in Blender \(N panel → MCP for Blender\) and then Connect Blender in TotalScript Settings → MCP servers, and WAIT - never quietly build cubes in Studio instead/.test(full) && /press Start MCP Server in Blender \(N panel\) and Connect Blender in TotalScript Settings, then wait/.test(tight));
ok("A7 the whole pipeline is named in order (plan → build → validate → inspect → bake → light / camera / render → send → mesh_import_verify → screenshot → model_report)", ["blender_asset_plan", "blender_asset_build", "blender_asset_validate", "blender_asset_inspect", "blender_asset_bake", "blender_light_rig", "blender_camera_rig", "blender_render_setup", "blender_render_shot", "blender_turntable", "blender_send_to_studio", "mesh_import_verify", "total_screenshot", "model_report"].every((n) => full.includes(n) && tight.includes(n)) && full.indexOf("blender_asset_plan") < full.indexOf("blender_asset_build") && full.indexOf("blender_asset_validate") < full.indexOf("blender_asset_inspect") && full.indexOf("blender_send_to_studio") < full.indexOf("mesh_import_verify"));
ok("A8 honesty rules: triangle budgets, 20k per mesh, characters not pipeline assets, never invent asset ids / uploads / results", /hero 4-8k triangles, prop 1-3k/.test(full) && /20k per mesh/.test(full) && /Characters and rigged creatures are NOT built by the asset pipeline/.test(full) && /Never claim an upload, a publish or an asset id you did not get/.test(full) && /never invent an asset id, an upload or a Blender result/.test(tight));
ok("A9 nine playbooks, each a real command chain ending in a verification step", (() => { const pb = RS.WORK_MODE_PLAYBOOKS.blender; const names = ["HERO PROP / WEAPON:", "MODULAR KIT:", "ENVIRONMENT SET:", "VEHICLE / MACHINE:", "PRODUCT RENDER / TURNTABLE:", "TEXTURES + FILES:", "FIX A BAD IMPORT:", "EXISTING FILE:", "DRESS IT IN STUDIO:"]; const lines = pb.split("\n").slice(1); return names.every((n) => pb.includes("- " + n)) && lines.length === 9 && lines.every((l) => /(mesh_import_verify( again)?|total_screenshot( from two angles)?|model_report|blender_studio_clear|quality_audit \{path\}|nothing is uploaded|report)\.$/.test(l.trim())); })(), RS.WORK_MODE_PLAYBOOKS.blender.split("\n").slice(1).map((l) => l.slice(-40)));
ok("A10 checklist + switch note", RS.workModeChecklist("blender").startsWith("BLENDER CHECK: get_scene_info first") && RS.workModeChecklist("blender").includes("mesh_import_verify clean") && RS.workModeSwitchNote("blender").startsWith("━━━ WORK MODE SWITCHED → BLENDER") && RS.workModeSwitchNote("blender").includes("PLAYBOOKS (Blender mode") && !RS.workModeSwitchNote("blender", { tight: true }).includes("PLAYBOOKS ("));
// every cited command exists: a Blender btool (background.js) or a core / skill command
{
  const src = ["src/core", "src/providers"].flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => read(d + "/" + f))).join("\n");
  const btools = new Set([...bg.matchAll(/btool\("([a-z_]+)"/g)].map((m) => m[1]));
  const block = full + "\n" + tight + " " + RS.workModeChecklist("blender");
  const NOT_COMMANDS = new Set(["total_textures"]); // a folder name in the bake sentence
  const cited = [...new Set([...block.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]))].filter((n) => !NOT_COMMANDS.has(n));
  const missing = cited.filter((n) => !btools.has(n) && !new RegExp("[\"'`]" + n + "[\"'`:]|\\b" + n + "\\s*:").test(src));
  ok(`A11 every command the Blender profile cites exists (${cited.length} names; ${cited.filter((n) => btools.has(n)).length} Blender btools)`, missing.length === 0 && cited.filter((n) => btools.has(n)).length >= 40, missing);
  ok("A12 recipe names cited are real assetplan recipes", ["tree_procedural", "terrain_tile", "rock_cluster", "crystal_cluster", "wall_module", "door_module", "window_module", "lamp_post"].every((r) => new RegExp("[\"'`]" + r + "[\"'`:]|\\b" + r + "\\s*:").test(read("src/core/assetplan.js"))));
}
// budgets in the live prompt
window.__rsWorkMode = () => "blender";
const cg = RS.buildSystemPrompt({ siteName: "ChatGPT", providerId: "chatgpt", engine: "roblox", maxChars: 14000 });
const vn = RS.buildSystemPrompt({ siteName: "Vani Chat", providerId: "vani", engine: "roblox", maxChars: 14000, commandFormat: "plain" });
window.__rsBlender = () => true;
const gm = RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" });
window.__rsBlender = () => false;
ok(`A13 live budgets in Blender mode: ChatGPT ${cg.length} ≤ 14000, Vani (plain) ${vn.length} ≤ 14000, Gemini + BLENDER MCP block ${gm.length} < 48000`, cg.length <= 14000 && vn.length <= 14000 && gm.length < 48000 && cg.includes("━━━ BLENDER WORK MODE") && gm.includes("━━━ BLENDER MCP IS CONNECTED ━━━") && gm.includes("PLAYBOOKS (Blender mode"));
ok("A14 the Blender profile adds no json fence (Vani stays on the plain protocol)", !full.includes("```") && !tight.includes("```") && !vn.includes("```json"));
// Totality unchanged vs the committed 1.94.0 config.js
{
  let committed = "";
  try { committed = cp.execSync("git show HEAD:TotalScript/src/core/config.js", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
  if (committed && committed.includes('WORK_MODE_LABELS = { creation: "Totality" }')) {
    const c = { window: {}, console, chrome: global.chrome, RSParse: globalThis.RSParse }; c.window = c; c.window.__rsWorkMode = () => "creation"; vm.createContext(c);
    vm.runInContext(committed + ";this.__RS=RS;", c);
    window.__rsWorkMode = () => "creation";
    const same = ["creation", "ultimate", undefined].every((id) => c.__RS.workModePrompt(id) === RS.workModePrompt(id) && c.__RS.workModePrompt(id, { tight: true }) === RS.workModePrompt(id, { tight: true }) && c.__RS.workModeChecklist(id) === RS.workModeChecklist(id));
    const sameSys = c.__RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" }) === RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" });
    ok("A15 Totality prompt / checklist / full system prompt are byte-identical to the committed 1.94.0 config.js", same && sameSys);
  } else {
    ok("A15 (skipped: committed config.js is already 1.95.0 or git unavailable) Totality label still present", config.includes('creation: "Totality", blender: "Blender"'));
  }
}

// ── B. main.js ─────────────────────────────────────────────────────────────
const cut = (a, b) => { const i = main.indexOf(a), j = main.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor missing: " + a); return main.slice(i, j); };
const modesBlock = cut("  const WORK_MODES = {", "  const WORK_MODE_IDS");
const mctx = { window: null, console }; mctx.window = mctx; vm.createContext(mctx);
vm.runInContext(modesBlock + "\nthis.WORK_MODES = WORK_MODES;", mctx);
const B = mctx.WORK_MODES.blender;
ok("B1 WORK_MODES = creation + blender; blender card copy, badge, toast", Object.keys(mctx.WORK_MODES).join() === "creation,blender" && B.name === "Blender" && B.badge === "BLENDER" && B.short === "Blender" && /Blender-first 3D: plan → build → validate → inspect → texture → render → send to Studio, verified/.test(B.sub) && /Blender builds the geometry, Studio receives it/.test(B.toast) && /Connect Blender/.test(B.note));
ok("B2 eight quick starts, every one a Blender job that ends in verification", B.starters.length === 8 && ["Hero sword", "Modular dungeon kit", "Island terrain set", "Sci-fi crate", "Vehicle blockout", "Product render", "Bake + export", "Fix my import"].every((l) => B.starters.some((s) => s.label === l)) && B.starters.every((s) => /Blender|mesh_import_verify|turntable/i.test(s.prompt) && /verif|turntable|Clear the rig|resend|Do not upload/i.test(s.prompt)));
ok("B3 focus regex: Blender tools + the Studio read-back / dressing commands, not scripting", ["blender_asset_build", "get_scene_info", "execute_blender_code", "mesh_import_verify", "mesh_decimate", "uv_unwrap", "model_report", "quality_audit", "lighting_set_preset", "instance_move", "rotate_model", "total_screenshot"].every((n) => B.focus.test(n)) && ["script_create", "blueprint_install", "animation_create", "fx_create_vfx", "material_x"].every((n) => !B.focus.test(n)));
ok("B4 normaliser keeps blender and folds legacy ids to creation (source)", main.includes('const normalizeWorkMode = (id) => (WORK_MODE_IDS.includes(id) ? id : "creation");') && main.includes("WORK_MODES.blender = {"));
// blenderModeTools
{
  const fnSrc = cut("  function blenderModeTools(requested) {", "  // UNIVERSAL commands:");
  const tools = [{ name: "get_studio_state" }, { name: "get_scene_info", server: "blender" }, { name: "blender_asset_build", server: "blender" }, { name: "blender_hidden", server: "blender", hidden: true }];
  const c = { window: { __rsWorkMode: () => "blender" }, A: { toolList: tools }, normalizeWorkMode: (id) => (["creation", "blender"].includes(id) ? id : "creation") };
  vm.createContext(c); vm.runInContext(fnSrc + "\nthis.blenderModeTools = blenderModeTools;", c);
  const inMode = c.blenderModeTools("roblox").map((t) => t.name);
  c.window.__rsWorkMode = () => "creation";
  const offMode = c.blenderModeTools("roblox");
  c.window.__rsWorkMode = () => "blender";
  ok("B5 blenderModeTools: Blender server tools (not hidden) only in Blender mode, never when the Blender server itself was requested, empty when no Blender tools", inMode.join() === "get_scene_info,blender_asset_build" && offMode.length === 0 && c.blenderModeTools("blender").length === 0 && (c.A.toolList = [{ name: "x" }], c.blenderModeTools("roblox").length === 0));
  ok("B6 list_commands AND the embedded catalogue fold them in (source)", (main.match(/allScoped\.push\(\.\.\.blenderModeTools\(requested\)\);/g) || []).length === 2);
}
// families + catalogue
{
  const manifest = JSON.parse(read("manifest.json"));
  const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
  for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib)/.test(f))) vm.runInThisContext(read(f), { filename: f });
  const block = cut("  const UNIVERSAL_COMMANDS = [", "  const UNIVERSAL_SET") + cut("  const PRIORITY_COMMAND_RE", "  // ── Project Index map cache (1.32) ──") + "\n" + modesBlock;
  const ctx = { window: null, console, RS: { TOOL_NOTES: {} }, bareToolName: (n) => String(n).split("/").pop(), RobloxScriptSkills, RSAnim, PublicSkills: undefined, TotalTaskList: undefined, WORK_MODE_IDS: ["creation", "blender"] };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(block + "\nthis.buildCatalogue=buildCatalogue;this.commandFamily=commandFamily;this.COMMAND_FAMILIES=COMMAND_FAMILIES;this.FAMILY_ORDER=FAMILY_ORDER;", ctx);
  ok("B7 COMMAND_FAMILIES: blender family first, OTHER last; both orders hold every family exactly once", ctx.COMMAND_FAMILIES[0].id === "blender" && ctx.COMMAND_FAMILIES[ctx.COMMAND_FAMILIES.length - 1].id === "other" && ["creation", "blender"].every((m) => new Set(ctx.FAMILY_ORDER[m]).size === ctx.COMMAND_FAMILIES.length && ctx.COMMAND_FAMILIES.every((f) => ctx.FAMILY_ORDER[m].includes(f.id))) && ctx.FAMILY_ORDER.blender[0] === "blender" && ctx.FAMILY_ORDER.creation[0] === "script");
  ok("B8 commandFamily routes Blender tools + mesh_import_verify to BLENDER and leaves Studio families alone", ["blender_asset_build", "get_scene_info", "execute_blender_code", "get_viewport_screenshot", "mesh_import_verify"].every((n) => ctx.commandFamily(n) === "blender") && ctx.commandFamily("script_create") === "script" && ctx.commandFamily("model_build") === "build" && ctx.commandFamily("meshpart_create") === "build" && ctx.commandFamily("get_studio_state") !== "blender");
  const native = [
    { name: "execute_luau", inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } },
    { name: "get_studio_state", inputSchema: { type: "object", properties: {} } },
    { name: "script_read", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
    { name: "get_scene_info", server: "blender", inputSchema: { type: "object", properties: {} } },
    { name: "blender_asset_build", server: "blender", inputSchema: { type: "object", properties: { spec: { type: "object" }, brief: { type: "string" } } } },
    { name: "blender_send_to_studio", server: "blender", inputSchema: { type: "object", properties: { objects: { type: "array" }, scale: { type: "number" } } } },
  ];
  const cats = {};
  for (const mode of ["creation", "blender"]) {
    ctx.window.__rsWorkMode = () => mode;
    cats[mode] = ctx.buildCatalogue({ toolName: "list_commands", requested: "roblox", heading: "━━━ COMMAND CATALOGUE (embedded) ━━━", nativeTools: native, virtualLines: [...RSAnim.describeCommands(), ...RobloxScriptSkills.describeCommands()], webLines: [], focusBlock: `━━━ ${mode.toUpperCase()} WORK MODE FOCUS — x ━━━\n\n`, focusNames: [], compact: true, limit: 20000, lineLimit: 420, modeId: mode });
  }
  const fams = (t) => [...t.matchAll(/^── (.+?) \(\d+\) ──$/gm)].map((m) => m[1]);
  ok("B9 real buildCatalogue: Blender mode lists the BLENDER family first with signatures, then MODELING & BUILD, then SCRIPTING", fams(cats.blender).slice(0, 3).join("|") === "BLENDER (3D ASSET PIPELINE → STUDIO)|MODELING & BUILD|SCRIPTING" && /blender_asset_build \{(brief\?, spec\?[^}]*|spec\?[^,]*, brief\?)\}/.test(cats.blender) && /get_scene_info \{\}/.test(cats.blender) && cats.blender.includes("SIGNATURES BY FAMILY (callable as shown; BLENDER families first):"), fams(cats.blender).slice(0, 5));
  ok("B10 Totality catalogue order unchanged (scripting first) and within budget", fams(cats.creation).slice(0, 4).join("|") === "SCRIPTING|SYSTEM BLUEPRINTS|DATA, REMOTES, NETWORK & MONETIZATION|MODELING & BUILD" && cats.creation.length <= 20000 && cats.blender.length <= 20000);
}
// evidence gates
{
  const gateBlock = cut("  const MODE_GATES = {", "  // Returns the gate nudge for the active mode") + cut("  function modeGateNudge(runTools) {", "  // 1.38.0: skill programs that legitimately run long");
  const g = { window: { __rsWorkMode: () => "blender" }, normalizeWorkMode: (id) => (["creation", "blender"].includes(id) ? id : "creation"), bareToolName: (n) => String(n).split("/").pop(), WORK_MODES: { creation: { badge: "TOTALITY" }, blender: { badge: "BLENDER" } } };
  vm.createContext(g); vm.runInContext(gateBlock + "\nthis.modeGateNudge=modeGateNudge;this.MODE_GATES=MODE_GATES;", g);
  ok("B11 MODE_GATES.blender = asset + import + shared scripts + look (creation gates untouched: scripts / look / motion / quality)", g.MODE_GATES.blender.map((x) => x.id).join() === "asset,import,scripts,look" && g.MODE_GATES.creation.map((x) => x.id).join() === "scripts,look,motion,quality" && g.MODE_GATES.blender[2] === g.MODE_GATES.creation[0]);
  ok("B12 asset gate fires on Blender geometry without validate / inspect", /BLENDER GATE[\s\S]*- ASSET:/.test(g.modeGateNudge(new Set(["get_scene_info", "blender_asset_build"]))) && /- ASSET:/.test(g.modeGateNudge(new Set(["blender_add_cube", "blender_bevel"]))) && /- ASSET:/.test(g.modeGateNudge(new Set(["execute_blender_code"]))));
  ok("B13 asset gate silent once validated / inspected / rendered", g.modeGateNudge(new Set(["blender_asset_build", "blender_asset_validate"])) === "" && g.modeGateNudge(new Set(["blender_bevel", "blender_asset_inspect"])) === "" && g.modeGateNudge(new Set(["blender_add_cube", "blender_render_shot"])) === "");
  ok("B14 import gate fires on a send without mesh_import_verify and is silent with it", /- IMPORT:/.test(g.modeGateNudge(new Set(["blender_asset_build", "blender_asset_validate", "blender_send_to_studio"]))) && g.modeGateNudge(new Set(["blender_send_to_studio", "mesh_import_verify"])) === "");
  ok("B15 read-only Blender runs and plain Studio inspection never trip the gates", g.modeGateNudge(new Set(["get_scene_info", "blender_asset_validate", "blender_asset_inspect", "get_studio_state"])) === "" && g.modeGateNudge(new Set(["blender_list_objects", "blender_stats"])) === "");
  ok("B16 shared gates still fire in Blender mode (scripts without read-back, look without screenshot) and merge into ONE note", (() => { const n = g.modeGateNudge(new Set(["blender_asset_build", "script_create", "lighting_set_preset"])); return /System note from TotalScript, not the user/.test(n) && n.includes("- ASSET:") && n.includes("- SCRIPTS:") && n.includes("- LOOK:") && /Do not acknowledge this note/.test(n); })());
  g.window.__rsWorkMode = () => "creation";
  ok("B17 in Totality the Blender gates do not exist (Blender builds there are governed by the Totality gates only)", !/- ASSET:|- IMPORT:/.test(g.modeGateNudge(new Set(["blender_asset_build", "blender_send_to_studio"]))));
}

// ── C. UI ──────────────────────────────────────────────────────────────────
ok("C1 overlay.css: Blender badge + card accent + selected card (orange), Totality rules untouched", css.includes('#rs-work-badge[data-work="blender"]') && css.includes('.rs-work-modes .rs-work-card[data-work="blender"]::before') && css.includes('html[data-rs-theme] .rs-work-modes .rs-work-card[data-work="blender"].on {') && css.includes('#rs-work-badge[data-work="creation"]   { background: linear-gradient(135deg, #9ff3ff 0%, #22d3ee 45%, #0e7490 100%);'));
ok("C2 settings tray renders one card per built-in mode from WORK_MODE_IDS (data-driven, no new markup)", main.includes("${WORK_MODE_IDS.map((id) => `<button type=\"button\" class=\"rs-work-card ${workMode===id&&!publicMode()?\"on\":\"\"}\" data-work=\"${id}\"") && main.includes('class="rs-work-row rs-work-creation rs-work-modes"'));
ok("C3 popup: WORK_MODES + preset + card + orange selected style + two-column grid", popup.includes('const WORK_MODES = ["creation", "blender"];') && /blender: \{ thinking: "max", extra: false \}/.test(popup) && popupHtml.includes('data-work="blender" id="work-blender"') && popupHtml.includes("#work-blender.on{background:linear-gradient(135deg,#ffd9a8 0%,#f5792a 45%,#a63d12 100%)") && popupHtml.includes('<div class="work work-modes">') && popupHtml.includes(".work.work-modes{grid-template-columns:1fr 1fr}"));
{
  const pctx = { console }; vm.createContext(pctx);
  vm.runInContext(popup.slice(popup.indexOf("const WORK_MODES = ["), popup.indexOf("const WORK_PRESETS")) + "\nthis.normalizeWorkMode = normalizeWorkMode;", pctx);
  ok("C4 popup normaliser: blender kept, legacy ids → creation", pctx.normalizeWorkMode("blender") === "blender" && ["ultimate", "visualizer", "animator", "adaptive", "x", undefined].every((id) => pctx.normalizeWorkMode(id) === "creation"));
}

// ── D. docs ────────────────────────────────────────────────────────────────
ok("D1 README documents 1.95.0 and lists this test", /\*\*1\.95\.0 — Blender work mode/.test(readme) && readme.includes("test-blender-mode.js"));

console.log(failed ? `\n${failed} FAILED` : "\nALL OK");
process.exit(failed ? 1 : 0);
