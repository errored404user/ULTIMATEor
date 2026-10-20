// 1.23.0 — Roblox Studio plugin (plugin/ORscript.lua) + or-core hub + real game passes.
// Static checks: the plugin source is balanced Lua with every advertised
// handler, or-core embeds/serves it, and the extension exposes gamepass_*
// end to end (catalogue → main.js intercept → background.js browser session →
// Open Cloud fallback → Studio plugin handler).
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
function assert(c, m) { if (c) pass++; else { fail++; console.error("FAIL:", m); } }

const lua = read("plugin/ORscript.lua");
const rs = read("agent/src/plugin.rs");
const mainRs = read("agent/src/main.rs");
const main = read("src/core/main.js");
const bg = read("background.js");
const plus = read("src/core/skills/studio_plus.js");
const config = read("src/core/config.js");
const manifest = JSON.parse(read("manifest.json"));
const cargo = read("agent/Cargo.toml");

// ── plugin source ──
assert(lua.startsWith("--!nocheck"), "plugin disables type checking (plugin globals)");
assert(lua.includes('local VERSION = "1.49.0"'), "plugin version 1.49.0");
assert(manifest.version === "1.49.0", "manifest 1.49.0");
assert(/version = "1\.49\.0"/.test(cargo), "crate 1.49.0");
assert(lua.includes("if RunService:IsRunning() then return end"), "plugin is edit-mode only");
assert(lua.includes('"/api/plugin/hello"') && lua.includes('"/api/plugin/poll?client_id="') && lua.includes('"/api/plugin/result"'), "plugin speaks the hub protocol");
assert(lua.includes('http://127.0.0.1:3000'), "default bridge URL is or-core");
assert(lua.includes("ORscriptOpenCloudKey") && lua.includes("open_cloud_key"), "plugin forwards the Open Cloud key");
const handlers = ["studio_plugin_ping", "studio_place_info", "plugin_execute_luau", "csg_union", "csg_negate", "csg_separate", "open_script", "script_live_update", "studio_import_file", "studio_publish_selection", "studio_prompt_asset_id", "studio_insert_asset", "studio_select_tool", "studio_undo", "studio_redo", "studio_notify", "screenshot_frame", "gamepass_handler_create", "developer_product_handler_create", "studio_playtest", "studio_settings", "studio_selection", "studio_camera", "studio_script_editor", "studio_history", "studio_service_call", "studio_macro", "studio_save", "studio_output", "studio_test_run", "studio_mouse", "plugins_list", "plugin_widget", "plugin_invoke", "plugin_module_call", "plugin_source_read", "eclipse_status", "eclipse_open", "eclipse_handoff", "eclipse_import", "eclipse_play"];
for (const h of handlers) assert(lua.includes("H." + h + " = function") || lua.includes("function H." + h), "plugin handler " + h);
assert(lua.includes("setfenv") && lua.includes("loadstring"), "plugin_execute_luau sandboxes with loadstring + setfenv");
assert(lua.includes("ChangeHistoryService:TryBeginRecording") || lua.includes("ChangeHistoryService:SetWaypoint"), "edits are undoable");
assert(lua.includes("plugin:Union(") && lua.includes("plugin:Negate(") && lua.includes("plugin:Separate("), "real CSG via the plugin API");
assert(lua.includes("ScriptEditorService:UpdateSourceAsync") || lua.includes("UpdateSourceAsync"), "script_live_update uses ScriptEditorService");
assert(lua.includes("PromptGamePassPurchaseFinished") && lua.includes("UserOwnsGamePassAsync"), "gamepass handler template is real");
assert(lua.includes("ProcessReceipt"), "developer product handler template is real");
assert(lua.includes("unknown plugin command"), "unknown jobs answer with an error instead of hanging");
// Block balance: every block opener has a matching `end` (comments/strings
// removed by a tiny scanner so `--` inside strings and quotes inside comments
// cannot fool the count).
function stripLua(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "-" && n === "-") {
      const m = /^--\[(=*)\[/.exec(src.slice(i, i + 12));
      if (m) { const close = "]" + m[1] + "]"; const j = src.indexOf(close, i); i = j < 0 ? src.length : j + close.length; continue; }
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === "\\") i++; i++; }
      i++; out += '""'; continue;
    }
    if (c === "[" && /^\[=*\[/.test(src.slice(i, i + 12))) {
      const m = /^\[(=*)\[/.exec(src.slice(i, i + 12)); const close = "]" + m[1] + "]"; const j = src.indexOf(close, i);
      i = j < 0 ? src.length : j + close.length; out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}
const code = stripLua(lua);
const tokens = code.match(/\b(function|if|do|repeat|until|end)\b/g) || [];
let depth = 0, neg = false;
for (const t of tokens) {
  if (t === "function" || t === "do" || t === "if" || t === "repeat") depth++;
  else if (t === "end" || t === "until") depth--;
  if (depth < 0) neg = true;
}
assert(!neg, "plugin never closes more blocks than it opened");
assert(depth === 0, "plugin block depth balances to 0 (got " + depth + ")");
assert(!/\bgoto\b/.test(code), "no goto (Luau has none)");

// ── or-core hub ──
assert(mainRs.includes("mod plugin;"), "main.rs declares the plugin module");
assert(rs.includes('include_str!("../../plugin/ORscript.lua")'), "plugin embedded in the binary");
for (const r of ['"/api/plugin/hello"', '"/api/plugin/poll"', '"/api/plugin/result"', '"/api/plugin/status"', '"/api/plugin/config"']) assert(mainRs.includes(r), "route " + r);
assert(mainRs.includes("plugin: Arc<plugin::Hub>"), "AppState carries the hub");
assert(mainRs.includes("plugin::install()"), "or-core installs the plugin on start");
assert(mainRs.includes("plugin::try_execute_luau(state, &args).await"), "execute_luau fast path through the plugin");
assert(mainRs.includes("if plugin::is_plugin_tool(&name) { plugin::call(&state2, &name, args).await }"), "plugin tools dispatched from call_tool");
assert(mainRs.includes("roblox_tools_with_plugin(&state).await"), "list_tools includes plugin commands");
assert(rs.includes("pub async fn run(&self, name: &str, args: Value, timeout: Duration)"), "hub runs jobs with a timeout");
assert(rs.includes("rx = self.results.subscribe();") && rs.indexOf("self.results.subscribe()") < rs.indexOf("push_back(Job"), "subscribe before enqueue (no lost results)");
assert(rs.includes("OR_PLUGIN_EXEC") && rs.includes("OR_NO_PLUGIN_INSTALL") && rs.includes("OR_OPEN_CLOUD_KEY"), "env switches");
for (const t of handlers.filter((h) => h !== "studio_plugin_ping")) assert(rs.includes('"' + t + '"'), "or-core advertises " + t);
for (const t of ["cloud_gamepass_create", "cloud_gamepass_update", "cloud_gamepass_list", "cloud_product_create", "cloud_product_update", "cloud_product_list", "cloud_animation_publish"]) assert(rs.includes('"' + t + '"'), "Open Cloud tool " + t);
assert(rs.includes('format!("{APIS}/game-passes/v1/universes/{universe}/game-passes")') && rs.includes('format!("{APIS}/game-passes/v1/universes/{universe}/game-passes/{id}")') && rs.includes("reqwest::Method::PATCH"), "Open Cloud game pass endpoints (1.49.0: universe-scoped create + PATCH, the legacy /details route is retired)");
assert(rs.includes("multipart/form-data; boundary=") && !/reqwest::multipart/.test(rs), "multipart built by hand (no extra reqwest feature)");
assert(rs.includes("x-api-key"), "Open Cloud key header");
assert(rs.includes("/monetization/") && rs.includes('"passes"'), "errors point at the dashboard fallback");
assert(rs.includes('cfg!(windows)') && rs.includes("Roblox").length !== 0 && rs.includes('join("Plugins")'), "plugins folder per platform");

// ── extension: game passes ──
for (const n of ["gamepass_create", "gamepass_update", "gamepass_list"]) {
  assert(plus.includes('{ name: "' + n + '"'), "catalogue entry " + n);
  assert(main.includes('bareName === "' + n + '"'), "main.js intercepts " + n);
}
assert(main.includes('"gamepass_create","gamepass_list","gamepass_update"'), "gamepass_* are virtual (not sent to Studio Luau)");
assert(/PUBLISH_OPS=new Set\(\[[^\]]*"gamepass_create"/.test(main), "gamepass_create behind the publish approval gate");
assert(main.includes('type: "create_game_pass"') && main.includes('type: "update_game_pass"') && main.includes('type: "list_game_passes"'), "main.js calls the background game-pass messages");
assert(main.includes('pluginToolAvailable("cloud_gamepass_create")'), "Open Cloud fallback when the browser session fails");
assert(main.includes('bridgeTool("gamepass_handler_create"') && main.includes('tool: "marketplace_setup", arguments: { gamepass_id: gamePassId'), "handler wiring: plugin first, Luau skill second");
assert(main.includes('return await createGamePass({...args,universe_id:args.universeId||args.universe_id});'), "creator.createGamePass routes to the real flow");
assert(main.includes('create_game_pass: "gamepass_create"'), "alias create_game_pass");
for (const c of ['case "create_game_pass"', 'case "update_game_pass"', 'case "list_game_passes"']) assert(bg.includes(c), "background " + c);
assert(bg.includes("async function robloxCreateGamePass") && bg.includes('RBX_APIS + "/game-passes/v1/universes/" + universeId + "/game-passes"') && bg.includes('form.append("imageFile", icon, "icon.png")'), "browser-session create uses the universe-scoped multipart route with icon");
assert(bg.includes('"/game-passes/" + gamePassId, { method: "PATCH", body: form }') && bg.includes('form.append("isForSale"') && bg.includes('form.append("price", String(price))'), "price set at creation and via PATCH (no retired /details route)");
assert(bg.includes("opts.body instanceof FormData"), "robloxAuthedFetch does not force JSON on FormData");
assert(bg.includes('"/game-passes/v1/universes/" + universeId + "/game-passes/creator?pageSize=100"') && !bg.includes("games.roblox.com/v1/games/\" + universeId"), "list via the Open Cloud creator route (games.roblox.com list was removed by Roblox)");
assert(manifest.host_permissions.some((h) => h === "https://*.roblox.com/*"), "games.roblox.com covered by host permissions");
assert(config.includes("STUDIO PLUGIN (when studio_plugin_status reports connected"), "mandates mention the plugin");
assert(config.includes("gamepass_create {name, price, benefit}"), "mandates teach gamepass_create");

console.log(`test-studio-plugin: ${pass} passed, ${fail} failed`);
// ── 1.24.0: full Studio control, plugin interop bus, Eclipse Animator ──
for (const h of ["studio_playtest", "studio_settings", "studio_selection", "studio_camera", "studio_script_editor", "studio_history", "studio_service_call", "studio_macro", "studio_save", "studio_output", "studio_test_run", "studio_mouse", "plugins_list", "plugin_widget", "plugin_invoke", "plugin_module_call", "plugin_source_read", "eclipse_status", "eclipse_open", "eclipse_handoff", "eclipse_import", "eclipse_play"]) {
  assert(lua.includes('"' + h + '"'), "capability advertised " + h);
  assert(main.includes('"' + h + '"'), "extension knows plugin command " + h);
}
assert(lua.includes("RunService:Run()") && lua.includes("RunService:Pause()") && lua.includes("RunService:Stop()"), "studio_playtest drives RunService");
assert(lua.includes("settings():GetService(category)") && lua.includes("GetAvailableThemes"), "studio_settings reaches settings()");
assert(lua.includes("ScriptEditorService:GetScriptDocuments()") && lua.includes("EditTextAsync") && lua.includes("ForceSetSelectionAsync"), "script editor documents are driven live");
assert(lua.includes("shared.ORscript = BUS") && lua.includes('busFn.Name = "ORscriptBus"') && lua.includes("function BUS.register(spec)"), "plugin bus for other plugins");
assert(lua.includes('"PluginGuiService"') && lua.includes('"PluginDebugService"'), "discovers widgets and debug plugins");
assert(lua.includes("Studio does not allow a plugin to click another plugin's buttons"), "plugin_widget click is honest about the Studio limit");
assert(lua.includes("ECLIPSE_ID = 86116556258301"), "Eclipse Animator asset id");
assert(lua.includes("tableToKeyframeSequence") && lua.includes("KeyframeSequenceProvider:RegisterKeyframeSequence") && lua.includes("animator:StepAnimations"), "Eclipse exports convert to KeyframeSequences and preview in edit mode");
assert(lua.includes('f.Name = "AnimSaves"') && lua.includes('"ORscriptAnimations"'), "handoff writes the standard AnimSaves import location");
assert(lua.includes("ORscript = ORSCRIPT_ENV"), "plugin_execute_luau exposes the ORscript helper table");
assert(/"studio_service_call", 120/.test(rs) && /"eclipse_import", 120/.test(rs) && /"plugin_invoke", 120/.test(rs), "or-core timeouts for the new commands");
assert(config.includes("FULL STUDIO CONTROL (1.24.0") && config.includes("ECLIPSE ANIMATOR") && config.includes("eclipse_handoff {animation, rig_path: "), "prompts teach the new surface");
assert(main.includes('eclipse_animator_open: "eclipse_open"') && main.includes('list_plugins: "plugins_list"'), "aliases");

process.exit(fail ? 1 : 0);
