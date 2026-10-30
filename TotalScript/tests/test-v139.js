// 1.39.0 — Creation: ONE work mode.
//
//  The three built-in modes (Ultimate = Luau engineering + modeling,
//  Visualizer = VFX / lighting / UI, Animator = rigs / keyframes / tweens /
//  camera) are merged into a single "creation" profile. Nothing was dropped:
//  four equal-weight mandates on the shared OPERATING LOOP, twelve playbooks,
//  three evidence gates merged into one system note, a union focus regex, a
//  single family order, and legacy ids (stored settings, popup, public-skill
//  bases, .orskill packs) all normalise to creation.
// Run: node tests/test-v139.js  (from TotalScript/)
const fs = require("fs");
const vm = require("vm");
let failed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : "  -> " + extra}`); if (!cond) failed++; };
const read = (p) => fs.readFileSync(p, "utf8");
const main = read("src/core/main.js"), config = read("src/core/config.js"), css = read("overlay.css");
const popup = read("popup.js"), popupHtml = read("popup.html"), publicSrc = read("src/core/public_skills.js"), readme = read("README.md");
const cut = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("anchor missing: " + a); return src.slice(i, j); };

// ── A. model ──
const modesBlock = cut(main, "  const WORK_MODES = {", "  const WORK_MODE_IDS");
const mctx = { window: {} }; vm.createContext(mctx);
vm.runInContext(modesBlock + "\nthis.WORK_MODES = WORK_MODES;", mctx);
ok("WORK_MODES has exactly three built-in modes: creation + blender (1.95.0) + animate (1.99.4)", Object.keys(mctx.WORK_MODES).join() === "creation,blender,animate");
const C = mctx.WORK_MODES.creation;
ok("creation card: name / badge / short / sub / note / toast", C.name === "Totality" && C.badge === "TOTALITY" && C.short === "Totality" && /Luau systems · Modeling · VFX & Lighting · UI · Animation & Camera/.test(C.sub) && /engineer, 3D modeler, VFX \/ lighting \/ UI artist and animator/.test(C.note) && /^Totality Work Mode — /.test(C.toast));
ok("eight quick starts drawn from all three former modes", Array.isArray(C.starters) && C.starters.length === 8 && ["Index this place", "Shop + currency", "Build a house", "Fix my errors", "Cinematic mood", "Hero spell VFX", "Game HUD", "Sword swing"].every((l) => C.starters.some((s) => s.label === l && s.prompt.length > 80)));
ok("focus regex is the union of the former script / fx / animation families", C.focus && typeof C.focus.test === "function" && ["script_read", "blueprint_install", "part_create", "terrain_height", "fx_magic_circle", "lighting_set_preset", "ui_build", "design_tokens_set", "gfx_capture", "animation_create", "tween_create", "camera_shake", "ik_control_setup", "total_screenshot"].every((n) => C.focus.test(n)) && !C.focus.test("list_commands") && !C.focus.test("public_skill_create"));
ok("normalizeWorkMode maps everything unknown (incl. the legacy ids) to creation", main.includes('const normalizeWorkMode = (id) => (WORK_MODE_IDS.includes(id) ? id : "creation");'));
const norm = (id) => (["creation"].includes(id) ? id : "creation");
ok("…including ultimate / visualizer / animator / adaptive / undefined", ["ultimate", "visualizer", "animator", "adaptive", "fast", undefined, "", null].every((id) => norm(id) === "creation") && norm("creation") === "creation");
ok("default + stored-value migration target are creation", main.includes('let workMode = "creation"') && main.includes('if (r.rsWorkMode !== workMode) chrome.storage.local.set({rsWorkMode:"creation"});'));
ok("no legacy mode id literal survives in main.js", !main.includes('"ultimate"') && !main.includes('"visualizer"') && !main.includes('"animator"') && !/\b(ultimate|visualizer|animator)\s*:\s*\{/.test(main));
ok("FAMILY_ORDER has the merged creation order plus the Blender-first order (1.95.0) and the fallback points at creation", /const FAMILY_ORDER = \{\s*creation: \["script", "blueprint", "data", "build", "physics", "lighting", "vfx", "ui", "animation", "motion", "gameplay", "terrain", "gfx", "blender", "audio", "play", "studio", "web", "other"\],\s*blender: \["blender", "build", "script", [^\]]*"other"\],\s*animate: \["animation", "motion", "script", [^\]]*"other"\],\s*\};/.test(main) && main.includes("FAMILY_ORDER[modeId] || FAMILY_ORDER.creation") && main.includes("(WORK_MODES[modeId] || WORK_MODES.creation).badge"));
ok("tray row class + custom-mode card title use the single mode", main.includes('class="rs-work-row rs-work-creation rs-work-modes"') && main.includes('title="Custom mode on ${escRs(WORK_MODES[normalizeWorkMode(m.base)].name)}"'));
ok("public mode template bases on creation", main.includes('title: "My Mode", badge: "MYMODE", base: "creation"'));
ok("help topic describes the merge, the gates and the migration", main.includes('workmode:{title:"Work mode: Totality"') && main.includes("Legacy stored modes (Ultimate / Visualizer / Animator) migrate to Totality automatically"));

// ── B. catalogue: the union focus is not dumped as a 7k name list; signatures are shared fairly across families ──
ok("focus block skips the name dump when the focus set is large (Creation ≈ 425 names)", main.includes('${P.compactCommandList || focusNames.length > 240 ? "" : focusNames.join(", ") + "\\n"}'));
ok("signature budget is spent in two passes (fair share per family, then the remainder)", main.includes("const fairChars = Math.max(420, Math.floor(sigBudget / Math.max(1, groups.length)));") && main.includes("for (const pass of [0, 1]) {") && main.includes("const charCap = pass === 0 ? Math.min(fairChars, sigBudget) : sigBudget;"));
{
  global.window = global; global.chrome = { runtime: { getURL: (p) => p }, storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } } };
  const manifest = JSON.parse(read("manifest.json"));
  const bundle = manifest.content_scripts.find((c) => c.js && c.js.includes("src/core/skills/studio_skills.js"));
  for (const f of bundle.js.filter((f) => /src\/core\/(skills\/|studio_bridge\.js|animlib)/.test(f))) vm.runInThisContext(read(f), { filename: f });
  const block = cut(main, "  const UNIVERSAL_COMMANDS = [", "  const UNIVERSAL_SET") + cut(main, "  const PRIORITY_COMMAND_RE", "  // ── Project Index map cache (1.32) ──") + "\n" + modesBlock;
  const ctx = { window: null, console, RS: { TOOL_NOTES: {} }, bareToolName: (n) => String(n).split("/").pop(), RobloxScriptSkills, RSAnim, PublicSkills: undefined, TotalTaskList: undefined, WORK_MODE_IDS: ["creation"] };
  ctx.window = ctx; ctx.window.__rsWorkMode = () => "creation"; vm.createContext(ctx);
  vm.runInContext(block + "\nthis.buildCatalogue=buildCatalogue;", ctx);
  const lines = [...RSAnim.describeCommands(), ...RobloxScriptSkills.describeCommands()];
  const native = [{ name: "execute_luau", inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } }, { name: "script_read", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } }];
  const t = ctx.buildCatalogue({ toolName: "list_commands", requested: "roblox", heading: "━━━ COMMAND CATALOGUE (embedded) ━━━", nativeTools: native, virtualLines: lines, webLines: [], focusBlock: "━━━ TOTALITY WORK MODE FOCUS — x ━━━\n\n", focusNames: [], compact: false, limit: 20000, lineLimit: 420, modeId: "creation" });
  const fams = [...t.matchAll(/^── (.+?) \(\d+\) ──$/gm)].map((m) => m[1]);
  ok(`full catalogue carries signatures for ${fams.length} families (was 7 for Ultimate before the fair share)`, fams.length >= 14 && ["SCRIPTING", "LIGHTING & ATMOSPHERE", "VFX & PARTICLES", "UI & HUD", "ANIMATION", "TWEENS, SPRINGS & CAMERA"].every((f) => fams.includes(f)), fams.join("|"));
  ok("…scripting still comes first and the catalogue stays within budget", fams[0] === "SCRIPTING" && t.length <= 20000 && t.split("\n").length <= 420, t.length + " chars");
  const sigNames = [...t.split("NAMES ONLY")[0].matchAll(/(?:^|·\s+)([a-z][a-z0-9_]*) \{/gm)].map((m) => m[1]);
  const nameOnly = (t.split("NAMES ONLY")[1] || "").split("\n").slice(1).flatMap((row) => row.split(": ").slice(1).join(": ").split(", ").map((x) => x.trim())).filter(Boolean);
  ok("two-pass packing never repeats a command between signatures and names", nameOnly.every((n) => !sigNames.includes(n)) && new Set(sigNames).size === sigNames.length);
  const tc = ctx.buildCatalogue({ toolName: "list_commands", requested: "roblox", heading: "━━━ COMMAND CATALOGUE (embedded) ━━━", nativeTools: native, virtualLines: lines, webLines: [], focusBlock: "━━━ TOTALITY WORK MODE FOCUS — x ━━━\n\n", focusNames: [], compact: true, limit: 9000, lineLimit: 200, modeId: "creation" });
  const cf = [...tc.matchAll(/^── (.+?) \(\d+\) ──$/gm)].map((m) => m[1]);
  ok("compact catalogue (9k) still shows lighting / VFX / UI / animation signatures", ["LIGHTING & ATMOSPHERE", "VFX & PARTICLES", "UI & HUD", "ANIMATION"].every((f) => cf.includes(f)) && tc.length <= 9000, cf.join("|"));
}

// ── C. gates ──
const gateBlock = cut(main, "  const MODE_GATES = {", "  // 1.38.0: skill programs that legitimately run long");
const gctx = { window: { __rsWorkMode: () => "visualizer" }, normalizeWorkMode: norm, bareToolName: (n) => String(n).split("/").pop(), WORK_MODES: { creation: { badge: "CREATION" } } };
vm.createContext(gctx); vm.runInContext(gateBlock + "\nthis.modeGateNudge=modeGateNudge;this.MODE_GATES=MODE_GATES;", gctx);
ok("MODE_GATES.creation lists the five gates (scripts, look, motion + 1.47.0 quality + 1.99.6 systems)", Array.isArray(gctx.MODE_GATES.creation) && gctx.MODE_GATES.creation.map((g) => g.id).join() === "scripts,look,motion,quality,systems" && gctx.MODE_GATES.creation.every((g) => g.did && typeof g.did.test === "function" && g.proof && typeof g.proof.test === "function" && typeof g.nudge === "string"));
const G = (names) => gctx.modeGateNudge(new Set(names));
ok("scripts gate fires alone", /━━━ CREATION GATE \(System note from TotalScript, not the user\) ━━━\n- SCRIPTS:/.test(G(["script_create", "multi_edit"])) && !/LOOK:|MOTION:/.test(G(["script_create"])));
ok("look gate fires alone", /^━━━ CREATION GATE[^\n]*\n- LOOK:/.test(G(["lighting_set_preset", "fx_create_vfx"])) && !/SCRIPTS:|MOTION:/.test(G(["lighting_set_preset"])));
ok("motion gate fires alone", /^━━━ CREATION GATE[^\n]*\n- MOTION:/.test(G(["animation_create", "animation_add_keyframe"])) && !/SCRIPTS:|LOOK:/.test(G(["tween_sequence"])));
ok("several unproven families merge into ONE note with one line each", (() => { const n = G(["script_set_source", "bloom_set", "cutscene_camera_track"]); return (n.match(/━━━ CREATION GATE/g) || []).length === 1 && n.includes("- SCRIPTS:") && n.includes("- LOOK:") && n.includes("- MOTION:") && /Do not acknowledge this note/.test(n); })());
ok("each family is silenced by its own proof only", G(["script_create", "script_read", "script_check", "bloom_set"]).includes("- LOOK:") && !G(["script_create", "script_read", "script_check", "bloom_set"]).includes("- SCRIPTS:") && G(["script_create", "start_stop_play", "bloom_set"]).includes("- LOOK:") && !G(["script_create", "start_stop_play", "bloom_set"]).includes("- SCRIPTS:") && G(["bloom_set", "total_screenshot", "animation_create"]) === "" /* total_screenshot at the key poses is motion proof too */);
ok("all proven / pure inspection → no note", G(["script_create", "start_stop_play", "lighting_set", "total_screenshot", "animation_create", "animation_preview"]) === "" && G(["get_studio_state", "search_game_tree", "execute_luau", "ui_audit"]) === "" && G([]) === "");

// ── D. prompts ──
vm.runInThisContext(config + ";globalThis.__RS=RS;", { filename: "config.js" });
const RS = globalThis.__RS;
ok("WORK_MODE_PROMPTS / CHECKLIST / PLAYBOOKS each hold exactly creation + blender (1.95.0) + animate (1.99.4)", Object.keys(RS.WORK_MODE_PROMPTS).join() === "creation,blender,animate" && Object.keys(RS.WORK_MODE_PLAYBOOKS).join() === "creation,blender,animate" && config.includes('function normalizeModeId(wm) { return WORK_MODE_PROMPTS[wm] ? wm : "creation"; }') && config.includes('const wm = (window.__rsWorkMode && window.__rsWorkMode()) || "creation";'));
const full = RS.WORK_MODE_PROMPTS.creation.full, tight = RS.WORK_MODE_PROMPTS.creation.tight;
ok("both variants open with the CREATION heading and carry the four mandates", [full, tight].every((t) => t.startsWith("━━━ TOTALITY WORK MODE (default — engineer, modeler, VFX / UI artist and animator in one) ━━━") && ["LUAU ENGINEERING MANDATE", "MODELING MANDATE", "VISUAL MANDATE", "MOTION MANDATE"].every((h) => t.includes(h))));
ok("FIRST MOVE routes by request type (system / place / build / bug / look / animation / trivial)", /FIRST MOVE: pick ONE that matches the request \(never run openers blindly, never before Studio is connected\)/.test(full) && /a look \/ VFX \/ UI task → total_screenshot \{target:"studio"\} \+ lighting_inspect; an animation → animation_select_rig \{path\}/.test(full) && /FIRST MOVE: pick the one that matches \(never blindly, never while Studio is offline\)/.test(tight) && /a look \/ VFX \/ UI task → total_screenshot \+ lighting_inspect; an animation → animation_select_rig/.test(tight));
ok("full profile keeps the pinned pack sentences (blueprints, project index, gfx studio, design mandate)", ["SYSTEM BLUEPRINTS (1.31 BUILD pack)", "PROJECT INDEX (1.32 BUILD pack - read before you write)", "THUMBNAIL & ICON STUDIO (1.30 gfx pack)", "DESIGN THE UI AS A SYSTEM (DESIGN MANDATE)", "module_scaffold (typed module / class / service skeletons)", "postfx_cinematic (filmic / noir / dreamy / vivid / horror)", "rig_joints_inspect lists the joint names before you pose", "ECLIPSE ANIMATOR (when installed - eclipse_status once)"].every((s) => full.includes(s)));
ok("one combined HAND-OFF (report + VISUAL SPEC + MOTION SPEC) and one NEVER list covering all three crafts", /HAND-OFF: a short report with full paths plus, where they apply, a VISUAL SPEC .* and a MOTION SPEC/.test(full) && /NEVER: write a script you have not read back; leave a remote unvalidated; ship a build or a look without a screenshot; a default-settings emitter, a grey Frame or Offset-only UI; a two-keyframe linear clip, a hero animation without a camera beat, or motion "done" without animation_preview/.test(full));
ok("twelve playbooks, each ending in a verification step", (RS.WORK_MODE_PLAYBOOKS.creation.match(/^- [A-Z]/gm) || []).length === 12 && RS.WORK_MODE_PLAYBOOKS.creation.split("\n").slice(1).every((l) => /(report|clean|polish|summarise|screenshot|shows|game"\}|gfx_teardown|animation_preview|animation_test|extremes|timings)\.$/.test(l.trim())));
ok("checklist is one TOTALITY CHECK line naming all three proofs", /^TOTALITY CHECK: /.test(RS.workModeChecklist("creation")) && /script_check/.test(RS.workModeChecklist("creation")) && /total_screenshot/.test(RS.workModeChecklist("creation")) && /animation_preview/.test(RS.workModeChecklist("creation")));
ok("legacy ids resolve to the creation prompt / checklist / playbook / switch note", ["ultimate", "visualizer", "animator", "adaptive", "nope"].every((id) => RS.workModePrompt(id) === RS.workModePrompt("creation") && RS.workModeChecklist(id) === RS.workModeChecklist("creation") && RS.workModePlaybook(id) === RS.WORK_MODE_PLAYBOOKS.creation && RS.workModeSwitchNote(id) === RS.workModeSwitchNote("creation") && RS.workModeSwitchNote("creation").startsWith("━━━ WORK MODE SWITCHED → TOTALITY ━━━")));
const sizes = { full: RS.workModePrompt("creation").length, tight: RS.workModePrompt("creation", { tight: true }).length };
ok(`budgets: full loop+profile+playbooks ${sizes.full} < 18500, tight ${sizes.tight} < 3600`, sizes.full < 18500 && sizes.full > 12000 && sizes.tight < 3600 && sizes.tight > 2500);
window.__rsWorkMode = () => "creation";
const byProvider = {};
for (const [id, mx] of [["chatgpt", 14000], ["vani", 14000], ["notion", 8000], ["codecraft", 20000], ["gemini", 0], ["claude", 0]]) byProvider[id] = RS.buildSystemPrompt({ siteName: id, providerId: id, engine: "roblox", maxChars: mx }).length;
ok("ChatGPT / Vani (14k budget) stay within 14k with the merged tight profile", byProvider.chatgpt <= 14000 && byProvider.vani <= 14000, JSON.stringify(byProvider));
ok("full providers stay under 48k without the catalogue", byProvider.gemini < 48000 && byProvider.claude < 48000, JSON.stringify(byProvider));
for (const legacy of ["ultimate", "visualizer", "animator"]) {
  window.__rsWorkMode = () => legacy;
  ok(`a stale window.__rsWorkMode() === "${legacy}" still yields the CREATION block`, RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" }).includes("━━━ TOTALITY WORK MODE") && !RS.buildSystemPrompt({ siteName: "Gemini", providerId: "gemini", engine: "roblox" }).includes("━━━ " + legacy.toUpperCase() + " WORK MODE"));
}
window.__rsWorkMode = () => "creation";

// ── E. popup + css ──
ok("popup: creation + blender, legacy map, normaliser used on load and on storage change", popup.includes('const WORK_MODES = ["creation", "blender", "animate"];') && popup.includes('const LEGACY_WORK_MODES = { ultimate: "creation", visualizer: "creation", animator: "creation", adaptive: "creation" };') && popup.includes('const normalizeWorkMode = (id) => (WORK_MODES.includes(id) ? id : (LEGACY_WORK_MODES[id] || "creation"));') && popup.includes("if (r.rsWorkMode) settings.workMode = normalizeWorkMode(r.rsWorkMode);") && popup.includes("settings.workMode = normalizeWorkMode(changes.rsWorkMode.newValue);") && popup.includes('workMode: "creation"') && !popup.includes("WORK_HELP")); // 1.75.0: long help paragraph removed
{
  const pctx = { console, settings: {}, document: undefined, chrome: undefined }; vm.createContext(pctx);
  vm.runInContext(cut(popup, "const WORK_MODES = [", "const WORK_PRESETS") + "\nthis.normalizeWorkMode = normalizeWorkMode;", pctx);
  ok("popup normaliser behaves", ["ultimate", "visualizer", "animator", "adaptive", "x", undefined].every((id) => pctx.normalizeWorkMode(id) === "creation") && pctx.normalizeWorkMode("creation") === "creation");
}
// 1.75.0: the card is named Totality and coloured aqua (was gold); the long mode help paragraph is gone.
ok("popup.html: the aqua Totality card + the orange Blender card (1.95.0) + the violet Animator card (1.99.4), no long help paragraph", popupHtml.includes('<button type="button" class="work-card" data-work="creation" id="work-creation">') && popupHtml.includes('<button type="button" class="work-card" data-work="blender" id="work-blender">') && popupHtml.includes('<button type="button" class="work-card" data-work="animate" id="work-animate">') && (popupHtml.match(/class="work-card" data-work="/g) || []).length === 3 && popupHtml.includes("#work-creation.on{background:linear-gradient(135deg,#9ff3ff 0%,#22d3ee 45%,#0e7490 100%)") && popupHtml.includes('<span class="work-name">Totality</span>') && !popupHtml.includes('id="work-help"') && !popupHtml.includes("#work-visualizer") && !popupHtml.includes("#work-animator"));
ok("overlay.css: creation badge / card / row, no legacy selectors", css.includes('#rs-work-badge[data-work="creation"]') && css.includes('.rs-work-modes .rs-work-card[data-work="creation"]::before') && css.includes('html[data-rs-theme] .rs-work-modes .rs-work-card[data-work="creation"].on {') && css.includes(".rs-work-row.rs-work-creation{grid-template-columns:minmax(0,1fr)}") && !/data-work="(ultimate|visualizer|animator)"/.test(css) && !css.includes("rs-work-ultimate"));

// ── F. public skills: bases ──
{
  const pctx = { window: {}, console, chrome: undefined }; pctx.window = pctx; vm.createContext(pctx);
  vm.runInContext(publicSrc, pctx);
  const PS = pctx.PublicSkills || pctx.window.PublicSkills;
  ok("PublicSkills.BASES = [creation] + LEGACY_BASES + normalizeBase exported", PS && Array.isArray(PS.BASES) && PS.BASES.join() === "creation" && PS.LEGACY_BASES && Object.keys(PS.LEGACY_BASES).sort().join() === "adaptive,animator,ultimate,visualizer" && typeof PS.normalizeBase === "function");
  ok("normalizeBase maps legacy / unknown / mixed-case to creation", ["ultimate", "Visualizer", "ANIMATOR", "adaptive", "", null, undefined, "weird"].every((b) => PS.normalizeBase(b) === "creation") && PS.normalizeBase("creation") === "creation");
  const mandate = "You are a horror ambience specialist. Every scene needs Atmosphere fog, low ambient light, a flickering light and a sound layer; verify with a screenshot after each pass.";
  const v = PS.validate({ kind: "mode", title: "Horror Builder", badge: "HORROR", base: "animator", description: "Dread: fog, flicker, low light, sound.", mandate, focus: ["execute_luau"] });
  ok("validate() rewrites a legacy base to creation (this is what load() runs on stored items and imported packs)", v.ok && v.item.base === "creation" && /custom work mode on Totality$/.test(v.item.toast), JSON.stringify(v.errors));
  ok("modePrompt says 'layered on TOTALITY'", /layered on TOTALITY\)/.test(PS.modePrompt(v.item)) && /FOCUS COMMANDS[^\n]*on top of the TOTALITY focus list/.test(PS.modePrompt(v.item)));
  const fp = PS.fromPrompt("You are a senior horror-map specialist. Build dread with fog, flicker and low light; verify every pass with a screenshot and keep emitters cheap.", { kind: "mode", title: "Horror Map" });
  ok("fromPrompt kind=mode always proposes base creation", fp.ok && fp.def.base === "creation", JSON.stringify(fp).slice(0, 200));
  ok("DEFINITION_DOC documents the single base and the legacy aliases", /base \('creation' - the only built-in mode; legacy 'ultimate'\|'visualizer'\|'animator' map to it\)/.test(PS.DEFINITION_DOC || publicSrc));
}

// ── G. bookkeeping ──
const mf = JSON.parse(read("manifest.json"));
ok("manifest 1.99.6", mf.version === "1.99.6", mf.version);
ok("plugin + crate pinned at 1.99.6", read("plugin/TotalScript.lua").includes('local VERSION = "1.99.6"') && read("plugin/TotalScript.lua").includes("(TotalScript 1.99.6)") && /^version = "1\.99\.6"/m.test(read("agent/Cargo.toml")) && /name = "total-agent"\nversion = "1\.99\.6"/.test(read("agent/Cargo.lock")) && readme.includes("`total-agent` 1.99.6"));
ok("README changelog 1.39.0 + mode paragraph + test listed", readme.includes("**1.39.0 — Creation: one work mode.**") && readme.includes("tests/test-v139.js") && readme.includes("there is one built-in mode, **Totality** (named Creation until 1.73; stored id `creation`)") /* 1.75.0 rename */);
ok("tests pinned to the old ids were updated (no test expects three built-in modes)", !read("tests/test-work-modes.js").includes('for (const wm of ["ultimate", "visualizer", "animator"])') && !read("tests/test-v138.js").includes('WORK_MODE_IDS: ["ultimate", "visualizer", "animator"]') && !read("tests/test-public-skills.js").includes('const WORK_MODES = ["ultimate", "visualizer", "animator"]'));

console.log(failed ? `\n${failed} check(s) failed` : "\nall 1.39.0 checks passed");
process.exitCode = failed ? 1 : 0;
