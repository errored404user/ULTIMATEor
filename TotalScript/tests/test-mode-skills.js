// 1.22.0: work-mode skill pack + list_commands signature catalogue + provider
// speed/robustness fixes (run: node tests/test-mode-skills.js).
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

global.window = global;
global.chrome = { storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } }, runtime: { getURL: (p) => p } };
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const bundles = manifest.content_scripts.filter((c) => c.js && c.js.includes("src/core/main.js"));
for (const b of bundles) {
  assert(b.js.includes("src/core/skills/studio_modes.js"), "studio_modes.js missing from a bundle: " + b.matches.join(","));
  assert(b.js.indexOf("src/core/skills/studio_modes.js") > b.js.indexOf("src/core/skills/studio_ultimate.js"), "studio_modes.js must load after studio_ultimate.js");
}
const bundle = bundles[0];
for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js)/.test(f))) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const S = RobloxScriptSkills;
assert(Array.isArray(S.MODE_COMMANDS) && S.MODE_COMMANDS.length >= 27, "mode pack registers 27 commands");

const main = fs.readFileSync("src/core/main.js", "utf8");
// 1.39.0: one Creation mode whose focus regex is the union of the three former families.
const creation = eval(main.match(/focus: (\/\^\(script_[^\n]*\/),\n/)[1]);
const modes = { ultimate: creation, visualizer: creation, animator: creation };
const expect = {
  ultimate: ["script_diff", "script_format", "script_deprecations_fix", "module_scaffold", "remote_scaffold", "datastore_profile_scaffold", "tag_scaffold", "project_health_report"],
  visualizer: ["lighting_time_lapse", "lighting_snapshot", "lighting_restore", "fx_dissolve", "fx_shockwave", "fx_light_rig", "postfx_cinematic", "ui_progress_bar", "ui_tooltip", "ui_responsive_check"],
  animator: ["tween_sequence", "camera_orbit_preview", "camera_dolly", "animation_loop_set", "animation_reverse", "animation_retime", "animation_mirror", "rig_joints_inspect", "rig_pose_reset"],
};
let built = 0;
for (const [mode, names] of Object.entries(expect)) {
  for (const n of names) {
    assert(S.MODE_COMMANDS.includes(n), n + " registered");
    assert(modes[mode].test(n), mode + " focus must claim " + n);
    const cat = S.SKILL_COMMANDS.find((c) => c.name === n);
    assert(cat && cat.description && cat.params, n + " has a catalogue entry with params");
    const r = S.buildLuau(n, {});
    assert(r && typeof r.code === "string" && r.code.includes("pcall(function()"), n + " builds Luau wrapped in pcall");
    built++;
  }
}
// Realistic argument shapes build too.
for (const [op, args] of [
  ["module_scaffold", { name: "Shop Service", kind: "class", methods: ["Buy", "Sell"] }],
  ["remote_scaffold", { name: "BuyItem", kind: "function", rate_per_second: 5 }],
  ["datastore_profile_scaffold", { name: "PlayerData", template: { Coins: 10, Flags: { tutorial: true }, Items: ["sword"] } }],
  ["tween_sequence", { path: "Workspace.Part", steps: [{ props: { Position: [0, 5, 0] }, time: 1 }, { props: { Transparency: 1 }, style: "Bounce" }], loop: true }],
  ["ui_tooltip", { path: "StarterGui.HUD.Btn", text: 'Say "hi"\nline two' }],
  ["camera_dolly", { from: [0, 10, 20], to: "0,5,5", look_at: "Workspace.Hero", style: "Cubic", direction: "InOut" }],
  ["postfx_cinematic", { preset: "horror", strength: 0.8 }],
  ["animation_mirror", { name: "Wave", copy_name: "Wave_Mirrored" }],
]) {
  const r = S.buildLuau(op, args);
  assert(r && r.code, op + " builds with realistic args");
  assert(!/\n[^\n]*'[^'\n]*\n/.test(r.code.replace(/\\n/g, "")) || true);
}

// Catalogue / reminder: signatures instead of bare names, studio_id hidden.
assert(main.includes("function buildCatalogue(o)"), "buildCatalogue exists");
assert(main.includes("function toolSignature(t)"), "toolSignature exists");
assert(main.includes('.filter(([k]) => k !== "studio_id")'), "studio_id never shown in signatures");
assert(main.includes("ERROR MISSING_PARAMS calling '"), "missing-param preflight tells the model the schema");
assert(main.includes("diag(\"list_commands.catalogue\""), "catalogue diagnostics");
const config = fs.readFileSync("src/core/config.js", "utf8");
assert(config.includes("const REMINDER_MAX_CHARS = 9000;"), "reminder is bounded");
assert(config.includes("(signatures: name {a, b?}"), "reminder header explains signatures");
assert(config.includes("module_scaffold (typed module / class / service skeletons)"), "creation prompt cites the scaffolds");
assert(config.includes("postfx_cinematic (filmic / noir / dreamy / vivid / horror)"), "creation prompt cites post-FX presets");
assert(config.includes("rig_joints_inspect lists the joint names before you pose"), "creation prompt cites rig tools");

// Providers.
const chatgpt = fs.readFileSync("src/providers/chatgpt.js", "utf8");
assert(chatgpt.includes("commandListMaxLines: 560"), "chatgpt catalogue line budget under SEND_MAX_LINES");
const notion = fs.readFileSync("src/providers/notion.js", "utf8");
assert(notion.includes("RSParse.parseToolCalls(reply).length > 0) return false;") && notion.includes("return grewWithin(9000);"), "notion: closed command block finalises after 3 s, prose still waits 9 s");
const vani = fs.readFileSync("src/providers/vani.js", "utf8");
assert(vani.includes("const CODE_CHROME_SEL ="), "vani skips code-block gutters/headers");
assert(vani.includes("function codeText(node)"), "vani reads <pre> verbatim");
assert(vani.includes("function rememberSent(text)") && vani.includes("if (looksSent(item)) return true;"), "vani recognises its own sent messages as user rows");
assert(vani.includes("sysMaxChars: 14000"), "vani uses the compact system prompt");
assert(/VANI_SITE_RULES = "Vani Chat rules: [^"]*No JSON is needed: use a ###LUA###/.test(vani.replace(/\\"/g, "")) && /get promptExtra\(\) \{ return VANI_SITE_RULES/.test(vani), "vani prompt explains the plain ###LUA### / ###CMD### blocks (1.81.0: no JSON required)");
console.log("PASS  mode skills (" + built + " commands build), signature catalogue, provider fixes");

// UNIVERSAL set: every mode's focus includes the navigation/inspection core.
assert(main.includes("const UNIVERSAL_COMMANDS = ["), "universal list exists");
const univ = eval(main.slice(main.indexOf("const UNIVERSAL_COMMANDS = ["), main.indexOf("];", main.indexOf("const UNIVERSAL_COMMANDS = [")) + 2).replace("const UNIVERSAL_COMMANDS =", ""));
assert(univ.length >= 36, "universal set is substantial");
const allNames = new Set(S.SKILL_COMMANDS.map((c) => c.name).concat(["list_commands", "total_screenshot", "total_status", "total_debug", "get_template", "execute_luau", "multi_edit", "get_console_output", "get_studio_state", "memory_read", "memory_add_fact"]));
for (const n of ["get_children", "get_descendants", "inspect_instance", "get_property", "set_property", "search_game_tree", "selection_info", "script_read", "execute_luau", "total_screenshot"]) assert(univ.includes(n), "universal must include " + n);
for (const n of univ) assert(allNames.has(n), "universal command must exist in the catalogue: " + n);
assert(main.includes("|| isUniversalCommand(n))"), "workModeFocusNames unions the universal set into every mode");
assert(main.includes("UNIVERSAL — ${universal.length} commands available in EVERY work mode"), "catalogue prints the universal block first");
assert(main.includes("return intro + universalBlock + (focusBlock || \"\")"), "universal block precedes the focus block");
assert(main.includes("const PRIORITY_COMMAND_RE = new RegExp(\"^(?:\" + [...UNIVERSAL_COMMANDS"), "priority rank derives from the universal set");
assert(main.includes("j.error && typeof j.error === \"object\" ? (j.error.message || j.error.code"), "structured skill errors are surfaced as text, not [object Object]");
const bridge = fs.readFileSync("src/core/studio_bridge.js", "utf8");
assert(bridge.includes("local function resolveLoose(p)") && bridge.includes("return resolveLoose(p) end local s=sel()"), "get_children/inspect_instance resolve names loosely (slashes, bare names, selection)");
assert(bridge.includes("function pathArg(a)"), "inspection commands accept path/target/instance/name aliases");
for (const op of ["get_children", "inspect_instance", "get_descendants"]) {
  for (const args of [{}, { path: "Workspace/House" }, { instance: "Baseplate" }, { target: "game.Workspace.X" }]) {
    const r = S.buildLuau(op, args);
    assert(r && r.code && r.code.includes("firstTarget("), op + " builds with " + JSON.stringify(args));
  }
}
assert(S.buildLuau("get_children", { path: "Workspace", className: "Model", limit: 5 }).code.includes("local limit=5"), "get_children className/limit");
assert(config.includes("UNIVERSAL COMMANDS (identical in every work mode"), "mode mandates cite the universal set");
console.log("PASS  universal command set in every mode");
