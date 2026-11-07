// 2.8.0 pair mode pins: Studio plugin watcher (Luau) ⇄ desktop hub (Rust) ⇄
// chat prompt ⇄ window. Source-level checks; the crate is compiled by the
// desktop CI job and the Lua logic runs in tests/plugin-lua-check.py.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const lua = read("plugin/TotalScript.lua");
const plugin = read("agent/src/plugin.rs");
const gui = read("agent/src/gui.rs");
const main = read("agent/src/main.rs");
const chat = read("agent/src/chat.rs");
const readme = read("README.md");
const luaCheck = read("tests/plugin-lua-check.py");
let failures = 0;
const ok = (name, value) => {
  console.log(`${value ? "PASS" : "FAIL"}  ${name}`);
  if (!value) failures++;
};
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ""; const j = s.indexOf(b, i); return j < 0 ? s.slice(i) : s.slice(i, j); };

// ── A. Studio plugin (Luau) ─────────────────────────────────────────────
const caps = between(lua, "local CAPABILITIES = {", "}");
ok("A1 pair_watch is advertised in CAPABILITIES", /"pair_watch"/.test(caps));
ok("A2 H.pair_watch handler exists and returns the status shape", /function H\.pair_watch\(a\)/.test(lua) && /pending_events\s*=/.test(lua) && /dirty_scripts\s*=/.test(lua));
ok("A3 events are POSTed in batches to /api/plugin/event with the client id", /request\("POST", "\/api\/plugin\/event", \{ client_id = CLIENT_ID, events = batch \}\)/.test(lua));
ok("A4 the four event kinds exist", ["script", "select", "prop", "instances"].every((k) => new RegExp(`kind = "${k}"`).test(lua)));
ok("A5 script events carry source (capped), excerpt window and missing refs", /PAIR_SOURCE_CAP/.test(lua) && /ev\.excerpt, ev\.from_line, ev\.to_line = pairExcerpt\(/.test(lua) && /ev\.missing = okM and missing or \{\}/.test(lua));
ok("A6 nothing is recorded while a TotalScript job runs (jobsActive gate + cool-down)", /PAIR\.jobsActive > 0 or os\.clock\(\) - PAIR\.lastJobEnd < 1\.5/.test(lua) && /PAIR\.jobsActive = PAIR\.jobsActive \+ 1/.test(lua) && /PAIR\.jobsActive = math\.max\(0, PAIR\.jobsActive - 1\)/.test(lua) && /lastJobEnd = -10/.test(lua));
ok("A7 noise filter skips CoreGui / PluginGuiService / Camera / TotalScript / Players", /\^CoreGui/.test(lua) && /\^PluginGuiService/.test(lua) && /Workspace%\.Camera/.test(lua) && /full:find\("TotalScript"\)/.test(lua) && /\^Players%\./.test(lua));
ok("A8 script edits debounce on ScriptEditorService.TextDocumentDidChange (2 s idle)", /ScriptEditorService\.TextDocumentDidChange/.test(lua) && /PAIR_IDLE = 2|PAIR_IDLE\s*=\s*.*\b2\b/.test(lua));
ok("A9 selection / instance / property hooks + clean stop", /Selection\.SelectionChanged/.test(lua) && /game\.DescendantAdded/.test(lua) && /game\.DescendantRemoving/.test(lua) && /inst\.Changed:Connect/.test(lua) && /local function pairStop\(\)/.test(lua) && /plugin\.Unloading:Connect\(function\(\)[\s\S]{0,120}pcall\(pairStop\)/.test(lua));
ok("A10 missing-ref check: WaitForChild / FindFirstChild / game.Svc.X, aliases, workspace global, cap 8", /GetService%s\*%\(/.test(lua) && /alias\.workspace = "Workspace"/.test(lua) && /WaitForChild%s\*%\(/.test(lua) && /FindFirstChild%s\*%\(/.test(lua) && /#out >= 8/.test(lua) && /TOTALSCRIPT_ENV\.missingRefs = pairMissingRefs/.test(lua));
ok("A11 bounded buffers: 40 events, 24000 source chars, 24 excerpt lines", /PAIR_MAX_EVENTS, PAIR_SOURCE_CAP, PAIR_EXCERPT_LINES, PAIR_IDLE = 40, 24000, 24, 2/.test(lua));
ok("A12 pair mode is only ever sent to the loopback bridge (same request() helper, no other host)", !/https?:\/\/(?!127\.0\.0\.1|localhost)[^"']+\/api\/plugin\/event/.test(lua));
ok("A13 plugin-lua-check.py executes pairMissingRefs against a stub place", /pairMissingRefs\(SRC\)/.test(luaCheck) && /cap at 8/.test(luaCheck) && /nothing recorded while a TotalScript job runs/.test(luaCheck));

// ── B. Desktop hub (plugin.rs) ──────────────────────────────────────────
ok("B1 /api/plugin/event route + handler", /\.route\("\/api\/plugin\/event", post\(plugin::event_handler\)\)/.test(main) && /pub async fn event_handler\(State\(state\): State<AppState>, Json\(req\): Json<Value>\)/.test(plugin));
ok("B2 pair_watch registered as a plugin command and both tools exposed to the model", /\("pair_watch", 15\)/.test(plugin) && /tool\("pair_watch",/.test(plugin) && /tool\("pair_feed",/.test(plugin) && /bare == "pair_feed"/.test(plugin));
ok("B3 PairState is bounded (60 events, 12 findings, 40 AI windows)", /PAIR_EVENTS_CAP: usize = 60/.test(plugin) && /PAIR_FINDINGS_CAP: usize = 12/.test(plugin) && /PAIR_AI_WINDOWS_CAP: usize = 40/.test(plugin));
ok("B4 script events run luau_check + plugin missing refs → findings, latest edit per path wins, source dropped", /crate::workspace::luau_check\(&ev\.source\)/.test(plugin) && /p\.findings\.retain\(\|f\| f\.path != ev\.path\)/.test(plugin) && /ev\.source\.clear\(\)/.test(plugin) && /#\[serde\(skip_serializing\)\]\s*pub source: String/.test(plugin));
ok("B5 TotalScript's own Studio work is filtered: ai_begin guards around plugin jobs, plugin execute_luau and MCP roblox_tool", /pub fn ai_begin\(self: &std::sync::Arc<Self>\) -> AiActivity/.test(plugin) && (plugin.match(/let _ai = state\.plugin\.ai_begin\(\);/g) || []).length >= 2 && /async fn roblox_tool\([\s\S]{0,400}let _ai = state\.plugin\.ai_begin\(\);/.test(main) && /self\.ai_busy_at\(ev\.at\) \|\| p\.ai_windows\.iter\(\)\.any/.test(plugin));
ok("B6 one malformed event never drops the batch", /filter_map\(\|e\| serde_json::from_value\(e\.clone\(\)\)\.ok\(\)\)/.test(plugin));
ok("B7 prompt block: rules, ≤20 unseen events, open findings, marks seen; empty when off", /PAIR MODE \(on\): the user is building by hand in Studio and you are watching\. Rules: never redo or undo what the user just did; comment only on concrete findings/.test(plugin) && /saturating_sub\(20\)/.test(plugin) && /p\.seen_seq = p\.seq;/.test(plugin) && /if !p\.enabled \{ return String::new\(\); \}/.test(plugin));
ok("B8 the desktop switch is re-armed in Studio on a fresh hello when the plugin supports it", /state\.plugin\.pair_enabled\(\)\.await && info\.capabilities\.iter\(\)\.any\(\|c\| c == "pair_watch"\)/.test(plugin));
ok("B9 the model's pair_watch also flips the desktop switch, and survives a disconnected plugin", /"pair_watch" => \{[\s\S]{0,200}state\.plugin\.set_pair_enabled\(on\)\.await/.test(plugin) && /applied automatically when the plugin \(re\)connects/.test(plugin));
ok("B10 activity lines per edited script (clean / N finding(s)) for the window", /state\.ui\.track\("pair", format!\("\{label\} edited — \{findings\} finding\(s\), see AI Chat → Pair"\)\)/.test(plugin) && /edited — clean/.test(plugin));
ok("B11 Rust unit test pair_feed_checks_scripts_and_marks_seen exists (run by desktop CI)", /async fn pair_feed_checks_scripts_and_marks_seen\(\)/.test(plugin) && /dropped_ai, 2/.test(plugin));

// ── C. Chat prompt ──────────────────────────────────────────────────────
ok("C1 run_turn fetches the pair block and passes it into system_prompt", /let pair = state\.plugin\.pair_prompt_block\(\)\.await;/.test(chat) && /system_prompt\(&state, &cat, &req\.instructions, req\.tools && !cat\.tools\.is_empty\(\), &pair\)/.test(chat));
ok("C2 the block is appended only when non-empty, with the pair_feed / pair_watch hint", /if !pair\.is_empty\(\) \{[\s\S]{0,200}s\.push_str\(pair\);/.test(chat) && /pair_feed \{\} returns the whole recorded feed; pair_watch \{enabled:false\} stops watching/.test(chat));
ok("C3 STUDIO TOOLS line teaches pair_watch only on request", /pair_watch \{enabled:true\} starts PAIR MODE[^"]*only when they ask you to watch/.test(chat));

// ── D. Window ───────────────────────────────────────────────────────────
ok("D1 Settings.pair_mode persisted (default off)", /pub pair_mode: bool,/.test(gui) && /pair_mode: false,/.test(gui));
ok("D2 UiCommand::SetPair handled off the command loop (spawned) and forwarded to the plugin", /SetPair\(bool\),/.test(gui) && /gui::UiCommand::SetPair\(on\) => \{\s*let state2 = state\.clone\(\);\s*tokio::spawn/.test(main) && /state2\.plugin\.run\("pair_watch", serde_json::json!\(\{"enabled": on\}\)/.test(main));
ok("D3 Pair pill in the chat header toggles + saves + mirrors immediately", /pill\(ui, t, "Pair", pair_on\)/.test(gui) && /self\.settings\.pair_mode = !pair_on;\s*let _ = self\.settings\.save\(\);\s*self\.shared\.set_pair\(!pair_on, 0, Vec::new\(\)\);\s*let _ = self\.cmd_tx\.send\(UiCommand::SetPair\(!pair_on\)\);/.test(gui));
ok("D4 status line under the header: waiting / watching · N events · M findings, with 'Ask AI to review'", /fn chat_pair_line\(&mut self, ui: &mut egui::Ui\)/.test(gui) && /Pair · waiting for the Studio plugin/.test(gui) && /Pair · watching · \{events\} event/.test(gui) && /"Ask AI to review"/.test(gui) && /Review the findings and fix them \(explain each change briefly, keep the rest of my code as it is\)/.test(gui) && /self\.chat_send\(\);/.test(between(gui, "fn chat_pair_line", "fn chat_setup")));
ok("D5 UiShared mirror (set_pair) + the switch restored at boot", /pub fn set_pair\(&self, enabled: bool, events: usize, findings: Vec<\(String, usize\)>\)/.test(gui) && /let pair_at_boot = settings\.pair_mode;/.test(main) && /if pair_at_boot \{[\s\S]{0,120}state\.plugin\.set_pair_enabled\(true\)\.await;/.test(main));
ok("D6 toasts only for findings and on/off, never for clean edits; pair colour in the feed", /"pair" if !a\.text\.contains\(" clean"\) => self\.toast/.test(gui) && /"pair" => t\.warn/.test(gui));
ok("D7 Help → AI Chat explains pair mode honestly (filters own work, off by default)", /Pair \(header pill\): pair mode\./.test(gui) && /Changes made by TotalScript itself are filtered out\. Off by default; the switch is remembered\./.test(gui));

// ── E. Docs / version ───────────────────────────────────────────────────
ok("E1 README 2.8.0 block documents pair mode + the event endpoint", /\*\*2\.8\.0 — Pair mode/.test(readme) && /\/api\/plugin\/event/.test(readme));
ok("E2 README Testing line for this file", /node tests\/test-desktop-pair\.js/.test(readme));
ok("E3 plugin VERSION and Cargo version agree", (() => { const v = (lua.match(/local VERSION = "([\d.]+)"/) || [])[1]; const c = (read("agent/Cargo.toml").match(/^version = "([\d.]+)"/m) || [])[1]; return v && v === c; })());

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
