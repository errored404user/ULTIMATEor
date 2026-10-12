// Quick Node smoke tests for the v1.15 features (run: node test-v115.js). Not shipped.
const fs = require("fs");
const path = require("path");
const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };

const root = path.join(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(root, "src/core/main.js"), "utf8");
const cfgSrc = fs.readFileSync(path.join(root, "src/core/config.js"), "utf8");
const skillSrc = fs.readFileSync(path.join(root, "src/core/skills/studio_skills.js"), "utf8");
const dailySrc = fs.readFileSync(path.join(root, "src/core/skills/studio_daily.js"), "utf8");
const opsPy = fs.readFileSync(path.join(root, "tools", "blender_ops.py"), "utf8");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(root, "popup.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(root, "overlay.css"), "utf8");
const manJs = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
const manifest = JSON.parse(manJs);

const THEMES = ["night", "blood-moon", "sakura", "starglaze", "autumn", "pixelated"];

ok("manifest 1.16+", (() => { const [maj, min] = manifest.version.split(".").map(Number); return maj > 1 || min >= 16; })());
ok("glass base opacity readable", cssSrc.includes("rgba(16, 17, 25, 0.82)"));
ok("glass has @supports fallback", cssSrc.includes("@supports not") && cssSrc.includes("rgba(16, 17, 25, 0.96)"));

for (const id of THEMES) {
  ok("overlay theme " + id, cssSrc.includes(`html[data-rs-theme="${id}"]`));
  ok("popup theme card " + id, popupHtml.includes(`id="theme-${id}"`));
}
ok("overlay applyOrSkin writes data-rs-theme", mainSrc.includes('setAttribute("data-rs-theme", orTheme)'));
ok("overlay brand supports appearance identity", mainSrc.includes("rs-cluster-left") && mainSrc.includes("productName()") && mainSrc.includes("data-rs-brand"));
ok("popup html data-theme", popupJs.includes('setAttribute("data-theme", settings.theme)'));

ok("discord invite overlay", mainSrc.includes("https://discord.gg/YqVZaZYuy") && mainSrc.includes("rs-discord"));
ok("discord invite popup", popupHtml.includes('id="discord"') && popupJs.includes("https://discord.gg/YqVZaZYuy"));
// copilot removed per request

ok("sound effects playSfx", mainSrc.includes("function playSfx(") && mainSrc.includes('playSfx("start")') && mainSrc.includes("A._sfxErr"));
ok("sounds persist rsSounds", mainSrc.includes("rsSounds") && popupJs.includes("tgl-sounds"));
ok("popup sounds toggle", popupHtml.includes('id="tgl-sounds"'));

ok("forge rewrite lua", skillSrc.includes("Rewritten Forge language") && skillSrc.includes("forge_hud") && skillSrc.includes("FORGE  ·  PACK"));
ok("forge prompt rewrite", cfgSrc.includes("gold ember") || cfgSrc.includes("#d4a054"));
ok("forge inject on ui_create_component", mainSrc.includes("window.__rsForge") && mainSrc.includes("forge: true"));

ok("plugin_list skill", skillSrc.includes('name: "plugin_list"') && skillSrc.includes("function api.plugin_list"));
ok("plugin_create skill", skillSrc.includes('name: "plugin_create"') && skillSrc.includes("Save as Local Plugin"));
ok("plugin_inspect skill", skillSrc.includes('name: "plugin_inspect"'));
ok("plugin_create in ASK_OPS", mainSrc.includes('"plugin_create"'));
ok("plugin tools in system prompt", cfgSrc.includes("plugin_list") && cfgSrc.includes("plugin_create"));
const guiSrc = fs.readFileSync(path.join(root, "src/core/skills/studio_gui.js"), "utf8");
const agentSrc = fs.readFileSync(path.join(root, "src/core/skills/agent_skills.js"), "utf8");
ok("gui mutation suite", guiSrc.includes("ui_set_image") && guiSrc.includes("ui_set_texture") && guiSrc.includes("ui_set_property") && guiSrc.includes("ui_paint") && manJs.includes("studio_gui.js"));
ok("agentscript extras suite", agentSrc.includes("append_file") && agentSrc.includes("replace_in_files") && agentSrc.includes("AgentScriptSkills") && manJs.includes("agent_skills.js"));
ok("gui mutation in system prompt", cfgSrc.includes("GUI MUTATION") && cfgSrc.includes("ui_set_image"));
ok("create prompt uses texture tools", mainSrc.includes("ui_set_image") && mainSrc.includes("ui_set_texture"));
ok("oxalpha provider", manJs.includes("oxalpha.com") && manJs.includes("src/providers/oxalpha.js"));
ok("blender camera align", fs.readFileSync(path.join(root, "tools", "blender_ops.py"), "utf8").includes("cmd_align_camera_axis") && fs.readFileSync(path.join(root, "background.js"), "utf8").includes("blender_align_camera"));
ok("ui_build daily", guiSrc.includes("ui_build") && guiSrc.includes("BUILTIN"));
ok("no leftover template backticks in lua lib", !/`plugin`/.test(skillSrc));

ok("popup keeps load-bearing IDs", ["ver","dot","state","tools","servers","hint-row","hint-engine","restart","reconnect","settings","engine-roblox","engine-local","run-hint","site-tag","engine-label"]
  .every((id) => popupHtml.includes(`id="${id}"`)));
ok("popup has 2 engine segments, no Anim/Unreal", popupHtml.includes("engine-roblox") && popupHtml.includes("engine-local") && !popupHtml.includes("engine-anim") && !popupHtml.includes("engine-unreal"));
ok("persona UI gone from overlay", !mainSrc.includes("Agent persona") && !mainSrc.includes("setPersona(") && !mainSrc.includes('id="rs-persona"'));
ok("persona gone from prompt builder", !cfgSrc.includes("PERSONA: BUILDER") && !cfgSrc.includes("buildPersonaBlock"));
ok("blender MCP connect in menu", mainSrc.includes("blender_connect") && mainSrc.includes("rs-mcp-blender") && !mainSrc.includes("uvx blender-mcp"));
ok("blender disconnect button", mainSrc.includes("rs-mcp-blender-off") && mainSrc.includes("blender_disconnect"));
ok("blender prompt when connected", cfgSrc.includes("BLENDER MCP IS CONNECTED") && cfgSrc.includes("Start MCP Server"));
ok("theme ornaments exist", cssSrc.includes("rs-ornament") && popupHtml.includes("theme-art") && mainSrc.includes("glyph"));
ok("popup illustrated hero", popupHtml.includes("ui/hero.jpg") && popupHtml.includes("assets/icon.png") && popupHtml.includes("class=\"hero\""));
ok("popup theme photographs", ["night","blood-moon","sakura","starglaze","autumn"].every((id) => popupHtml.includes("swatch-" + id + ".jpg")));
ok("overlay atelier skin", cssSrc.includes("atelier skin 1.17.12"));
ok("overlay float is a card not a capsule", cssSrc.includes("not a stretched capsule") && cssSrc.includes("border-radius: 18px"));
ok("overlay panels revamp", cssSrc.includes("atelier panels 1.17.13"));
ok("overlay settings menu has photo head", cssSrc.includes(".rs-menu-head") && cssSrc.includes("ui/hero.jpg"));
ok("overlay cards panel painted", cssSrc.includes("#rs-cards-panel::before"));
ok("user template interface", cssSrc.includes("User-owned Templates v2") && mainSrc.includes("rs-template-head") && mainSrc.includes("rs-template-editor"));
ok("no motion tab", !mainSrc.includes('data-tab="motion"') && !mainSrc.includes("MOTION_CLIPS") && !mainSrc.includes("motionBuildClip"));
ok("ui creator removed", !mainSrc.includes('data-tab="uicreator">UI Creator') && !mainSrc.includes("UI_STYLES") && !mainSrc.includes("uiCreatorHtml") && !cssSrc.includes(".rs-ui-style") && manJs.includes('"tabs"') && bg.includes("OffscreenCanvas"));
ok("forge gui toggle removed", !popupHtml.includes('id="tgl-forge"') && !mainSrc.includes('data-mode="forge"'));
ok("settings theme photos 1.17.18", cssSrc.includes("settings theme photos 1.17.18") && mainSrc.includes("rs-theme-art") && mainSrc.includes("ui/swatch-") && mainSrc.includes('chrome.runtime.getURL("ui/swatch-'));
ok("robux pass ids live prices", ["1941228530","1941336506","1940736510","1941672495"].every((id) => mainSrc.includes(id)) && mainSrc.includes("fillRobuxPrices") && !mainSrc.includes("1865342947") && !mainSrc.includes("ko-fi.com") && !popupHtml.includes('id="kofi"'));
ok("setup card 1.17.19", cssSrc.includes("setup card 1.17.19") && mainSrc.includes('setupCard.id = "rs-setup"') && mainSrc.includes('id="rs-setup-tutorial"') && !mainSrc.includes("<b>AN</b> animation"));
ok("chat gui atelier composer", fs.readFileSync(path.join(root, "popup.html"), "utf8").includes("ui/hero.jpg"));
ok("manifest exposes ui photos", JSON.stringify(manifest).includes("ui/*.jpg"));
ok("theme picker is settings-only", !mainSrc.includes('id="rs-theme"') && !mainSrc.includes("setOrTheme(tdot.dataset.theme)") && mainSrc.includes("rs-theme-card") && popupHtml.includes('id="theme-sakura"'));
ok("chat bar still skins by theme", ["night","blood-moon","sakura","starglaze","autumn"].every((id) => cssSrc.includes('data-rs-theme="' + id + '"] #rs-bar')));
ok("sharp edges on overlay chrome", cssSrc.includes("sharp edges 1.17.15") && cssSrc.includes("border-radius: 4px !important"));
ok("applyOrSkin syncs settings theme cards", mainSrc.includes(".rs-theme-card") && mainSrc.includes("data-or-theme"));

ok("mode lock SYSTEM_STATE", mainSrc.includes("MODE LOCK:") && mainSrc.includes("ENGINE=${eng}") && mainSrc.includes('name === "or_status"'));
ok("think button on bar", mainSrc.includes('id="rs-extra"') && mainSrc.includes("Think ON") && mainSrc.includes("grill every") && !mainSrc.includes("<span>Image to model</span>") && !mainSrc.includes("<span>Thinking</span>"));
ok("adaptive work mode replaces presets", mainSrc.includes('let workMode = "adaptive"') && !mainSrc.includes('data-work="fast"'));
ok("engine switch ignores echo", mainSrc.includes("lastManualEngineAt < 5000") && mainSrc.includes("restart the agent so it uses this engine"));
ok("adaptive approval planning replaces plan toggle", !mainSrc.includes('data-mode="plan"') && cfgSrc.includes("ADAPTIVE WORK MODE") && cfgSrc.includes("Approve this plan to begin"));
ok("old cards RNG removed for user templates", !mainSrc.includes('id="rs-cards-rng"') && !mainSrc.includes("function runRngTopic") && !cssSrc.includes("#rs-cards-rng"));
ok("script_read_analysis alias", mainSrc.includes('script_read_analysis: "script_analysis"') && mainSrc.includes("remapToolName") && skillSrc.includes("alias: script_read_analysis") && skillSrc.includes("SKIP[cn]"));
ok("analysis no loadstring / no task.wait false positive", skillSrc.includes("luauUnbalanced") && skillSrc.includes("bareCall") && skillSrc.includes(":WaitForChild%s*(%b())") && !skillSrc.includes('src:find("[^%w_]wait%s*%(")'));
ok("new studio daily commands", dailySrc.includes("script_set_source") && dailySrc.includes("weld_constraint") && dailySrc.includes("humanoid_set") && dailySrc.includes("instance_move") && dailySrc.includes("tag_remove"));
ok("new blender commands", opsPy.includes("def cmd_scale") && opsPy.includes("def cmd_bevel") && opsPy.includes("def cmd_keyframe_insert") && opsPy.includes("def cmd_track_to") && bg.includes("blender_subdivision") && bg.includes("blender_add_armature"));
ok("or_screenshot send-to-self", mainSrc.includes('name === "or_screenshot"') && mainSrc.includes("ORScreenshot.run") && mainSrc.includes('screenshot: "or_screenshot"') && manJs.includes("src/core/screenshot.js") && bg.includes("screenshot_capture") && mainSrc.includes("A.pendingImages"));
ok("condo lock removed", !mainSrc.includes("rsCondoLock") && !mainSrc.includes("function isCondoTopic") && !mainSrc.includes("CONDO LOCK") && !cfgSrc.includes("never build Roblox condo games"));
const plusSrc = fs.readFileSync(path.join(root, "src/core/skills/studio_plus.js"), "utf8");
const extra40Src = fs.readFileSync(path.join(root, "src/core/skills/studio_extra40.js"), "utf8");
const bridgeSrc = fs.readFileSync(path.join(root, "src/core/studio_bridge.js"), "utf8");
const claudeSrc = fs.readFileSync(path.join(root, "src/providers/claude.js"), "utf8");
const dsSrc = fs.readFileSync(path.join(root, "src/providers/deepseek.js"), "utf8");
ok("automatic debugger", mainSrc.includes("function attachAutoDebug") && mainSrc.includes("[AUTO DEBUG]") && mainSrc.includes("setAutoDebug") && cfgSrc.includes("AUTOMATIC DEBUGGER") && mainSrc.includes("or_debug"));
ok("undo transaction button", mainSrc.includes('id="rs-undo"') && mainSrc.includes("function wrapStudioTxn") && mainSrc.includes("function undoStudioTxn") && mainSrc.includes("ChangeHistoryService"));
ok("context compression", mainSrc.includes("function compressToolFeedback") && mainSrc.includes("OR context compression"));
ok("multi-agent", mainSrc.includes("setMultiAgent") && mainSrc.includes('name === "or_agent"') && cfgSrc.includes("MULTI-AGENT") && mainSrc.includes("planner") && mainSrc.includes("reviewer"));
ok("studio plus 40 commands file", plusSrc.includes("size_set") && plusSrc.includes("hinge_create") && plusSrc.includes("jump_pad") && manJs.includes("studio_plus.js") && manJs.includes("1.19.0"));
ok("deduplicated Studio extension commands", !extra40Src.includes('{ name: "material_set"') && extra40Src.includes("particle_emitter_create") && extra40Src.includes("proximity_prompt_create") && extra40Src.includes("ui_corner_create") && manJs.includes("studio_extra40.js"));
ok("developer product create", mainSrc.includes("function createDeveloperProduct") && mainSrc.includes("create_dev_product") && bg.includes("function robloxCreateDevProduct") && plusSrc.includes("developer_product_create") && cfgSrc.includes("developer_product_create") && manJs.includes("*.roblox.com"));
ok("v19 version", /^1\.19\./.test(manifest.version));
ok("devproduct reaches game", mainSrc.includes("function studioUniverseIds") && bg.includes("function robloxResolveUniverse") && bg.includes("develop.roblox.com/v1/user/universes"));
ok("claude sonnet5 no-refuse", claudeSrc.includes("sonnet5") && claudeSrc.includes("authorized local automation") && mainSrc.includes("function isCapabilityRefuse") && cfgSrc.includes("capabilityRefuse"));
ok("bridge reconnect retry", bg.includes("waitForConnection(20000)") && bg.includes('r.kind === "disconnected"'));
ok("request understanding in prompts", cfgSrc.includes("Production brief") && cfgSrc.includes("- Brief:") && cfgSrc.includes("- Craft:") && cfgSrc.includes("implied systems") && cfgSrc.includes("function wrapTaskPrompt") && cfgSrc.includes("creationFocus") && cfgSrc.includes("looks intentional"));
ok("task wrap + creation focus", mainSrc.includes("RS.wrapTaskPrompt") && mainSrc.includes("RS.FEEDBACK.creationFocus") && cfgSrc.includes("[Production brief"));
ok("assistant plugin noise stripped", mainSrc.includes("function stripStudioNoise") && mainSrc.includes("function isAssistantPluginNoise") && mainSrc.includes("sabuiltin_Assistant") && skillSrc.includes("Assistant plugin version changed"));
ok("web search has fallbacks", bg.includes("api.duckduckgo.com") && bg.includes("lite.duckduckgo.com") && bg.includes("en.wikipedia.org/w/api.php") && bg.includes("list=search") && bg.includes("search.brave.com") && bg.includes("r.jina.ai"));
ok("screenshot on every provider", !mainSrc.includes("or_screenshot cannot send a shot") && mainSrc.includes('or_capture: "or_screenshot"') && !mainSrc.includes("VISION_TOOLS.has(bare) && !P.supportsVision"));
ok("technical branding stays ORscript while visible brand is dynamic", manifest.name === "ORscript" && cfgSrc.includes('const APP_NAME = "ORscript"') && popupHtml.includes('data-rs-brand>OrScript</span>'));
ok("ui auto layout", guiSrc.includes("ui_auto_layout") && guiSrc.includes("ui_constraints") && cfgSrc.includes("Lay out like a design tool"));
ok("vfx extras", skillSrc.includes("VFX_BUILDERS.shockwave") && skillSrc.includes("VFX_BUILDERS.holy_burst") && skillSrc.includes("VFX_BUILDERS.confetti"));
ok("animation acting notes", cfgSrc.includes("anticipation") && cfgSrc.includes("follow-through"));
ok("provider templates", manJs.includes("src/core/templates.js") && fs.readFileSync(path.join(root, "src/core/templates.js"), "utf8").includes("ORTemplates") && mainSrc.includes("get_template") && mainSrc.includes("CLONES a match") && mainSrc.includes("<h3>4 · Screenshot</h3>") && !popupHtml.includes("tpl-row") && !mainSrc.includes("data-tpl") && cfgSrc.includes("get_template"));
ok("http_get and skill intercepts", mainSrc.includes('if (name === "http_get")') && mainSrc.includes('if (name === "skill")') && bridgeSrc.includes("instance_new") && bridgeSrc.includes("debris_add") && bridgeSrc.includes("wait_for_child"));
ok("providers respond faster", dsSrc.includes("GEN_IDLE_MS: 450") || dsSrc.includes("GEN_IDLE_MS: 550"));
ok("bridge mcp studio tools", manJs.includes("src/core/studio_bridge.js") && bridgeSrc.includes("search_game_tree") && bridgeSrc.includes("generate_material") && bridgeSrc.includes("character_navigation") && bridgeSrc.includes("set_active_studio") && cfgSrc.includes("Production brief") && mainSrc.includes("ALWAYS_BLOCKED_TOOLS = new Set([])"));
ok("capture_id studio and blender", dailySrc.includes('name: "capture_id"') && dailySrc.includes("uniqueId") && opsPy.includes("def cmd_capture_id") && bg.includes("blender_capture_id") && bg.includes('capture_id: "capture_id"'));
ok("deepseek screenshot always on", dsSrc.includes("get supportsVision() { return true; }") && dsSrc.includes("2026-09_flash41") && dsSrc.includes("pickFileInput") && dsSrc.includes("did not attach the screenshot") && dsSrc.includes("liveSpinner") && dsSrc.includes("TIMINGS_FLASH") && dsSrc.includes("!state.expertFound && !state.visionFound"));

// 1.18.1 additions
const shotSrc = fs.readFileSync(path.join(root, "src/core/screenshot.js"), "utf8");
ok("pixelated theme wired", cssSrc.includes('html[data-rs-theme="pixelated"]') && mainSrc.includes("pixelated:") && popupHtml.includes('id="theme-pixelated"') && popupJs.includes('"pixelated"') && fs.existsSync(path.join(root, "ui/swatch-pixelated.jpg")));
ok("extra theme decorations", cssSrc.includes("1.18.1 - Pixelated theme + extra per-theme decorations") && cssSrc.includes("#rs-menu::after { box-shadow: 8px 0 0 -5px #140609"));
ok("browser detection", mainSrc.includes("function detectBrowser") && mainSrc.includes("__rsBrowserName") && cfgSrc.includes("function browserLine") && cfgSrc.includes("BROWSER: the user is chatting from") && mainSrc.includes("browser: USER_BROWSER"));
// copilot cloud host covered removed
ok("screenshot tab retries hardened", bg.includes("captureVisibleTab returned an empty image") && shotSrc.includes("i < 5") && !shotSrc.includes("Keep the Chrome/Edge/Brave/Opera WINDOW on screen"));
ok("sounds richer envelopes", mainSrc.includes("createBuffer") && mainSrc.includes("freqEnd") && mainSrc.includes("highpass"));
ok("false-refusal legitimacy note", cfgSrc.includes("not a security bypass") && cfgSrc.includes("legitimate local automation") && mainSrc.includes("i have no (direct )?way to"));

ok("removed mode has no toggle or prompt", !mainSrc.includes('data-mode="cowork"') && !mainSrc.includes('data-mode="steering"') && !cfgSrc.includes("COWORK MODE") && !cfgSrc.includes("STEERING MODE (user enabled)"));

// Scan every supported provider verification
const { execSync } = require("child_process");
const scanOut = execSync("node tests/scan-all-providers.js", { cwd: root, encoding: "utf8" });
ok("scan all providers works", scanOut.includes("Arena (arena): ✅ WORKS") && scanOut.includes("DeepSeek (deepseek): ✅ WORKS") && !scanOut.includes("❌ NOT WORKS"));

if (process.exitCode) {
  console.log("\nSome v1.16 checks failed.");
} else {
  console.log("\nAll v1.16 checks passed.");
}
