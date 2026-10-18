#!/usr/bin/env node
// Static checks for the or-core AI chat side panel (1.37.0): agent/src/chat.rs
// (providers, OpenAI-compatible streaming client, tool catalogue -> function
// tools, agent loop), the gui.rs panel (settings fields, commands, panel,
// shortcuts), the main.rs wiring, docs and version pins. cargo is not part of
// the JS test harness, so this guards the source shape and the contracts the
// three files share (event / request / command names must agree).
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);
let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log("PASS  " + name);
  else {
    failed++;
    console.log("FAIL  " + name + (detail ? " — " + String(detail).slice(0, 400) : ""));
  }
}
const read = (p) => fs.readFileSync(p, "utf8");
const chat = read("agent/src/chat.rs");
const gui = read("agent/src/gui.rs");
const main = read("agent/src/main.rs");
const cargo = read("agent/Cargo.toml");
const agentReadme = read("agent/README.md");
const readme = read("README.md");
const manifest = JSON.parse(read("manifest.json"));

// ── chat.rs: providers ──
const providerIds = [...chat.matchAll(/Provider \{ id: "([a-z]+)"/g)].map((m) => m[1]);
ok("12 provider presets", providerIds.length === 12, providerIds.join(","));
for (const id of ["codecraft", "openai", "openrouter", "groq", "deepseek", "gemini", "xai", "mistral", "together", "ollama", "lmstudio", "custom"]) {
  ok(`provider preset ${id}`, providerIds.includes(id));
}
ok("CodeCraft base url", chat.includes('base_url: "https://codecraftapi.com/v1"'));
ok("Gemini uses the OpenAI-compatible layer", chat.includes("generativelanguage.googleapis.com/v1beta/openai"));
ok("local providers need no key", /id: "ollama"[^\n]*needs_key: false/.test(chat) && /id: "lmstudio"[^\n]*needs_key: false/.test(chat));
ok("normalize_base strips /chat/completions", chat.includes("pub fn normalize_base") && chat.includes('"/chat/completions"'));

// ── chat.rs: client / streaming ──
ok("models via GET {base}/models", chat.includes("pub async fn list_models") && chat.includes('format!("{base}/models")'));
ok("chat via POST {base}/chat/completions", chat.includes('format!("{base}/chat/completions")'));
ok("Bearer auth header", chat.includes('"Authorization", format!("Bearer {}", key.trim())'));
ok("streams SSE through bytes_stream (no blocking reqwest)", chat.includes("resp.bytes_stream()") && !cargo.includes('"blocking"'));
ok("SSE data: lines + [DONE]", chat.includes('strip_prefix("data:")') && chat.includes("[DONE]"));
ok("non-stream JSON fallback", chat.includes('content_type.contains("text/event-stream")') && chat.includes("absorb_full"));
ok("tool_call deltas merged by index", chat.includes("fn absorb_tool_calls") && chat.includes('call.get("index")') && chat.includes("slot.arguments.push_str"));
ok("usage tokens captured", chat.includes('"prompt_tokens"') && chat.includes('"completion_tokens"'));
ok("HTTP error hints (401/402/404/429)", ["401 | 403", "402", "404", "429"].every((c) => chat.includes(c + " =>")));
ok("retries once without tools when a provider rejects them", chat.includes("model rejected tools") && chat.includes('obj.remove("tools")'));
ok("request timeout is long enough for slow models", /Duration::from_secs\(900\)/.test(chat));

// ── chat.rs: tool catalogue -> OpenAI function tools ──
ok("collects Studio MCP + plugin + workspace tools", chat.includes("crate::roblox_tools(state)") && chat.includes("plugin::tools(plugin_connected, key_set)") && chat.includes("workspace::catalog()"));
ok("skips MCP when Studio is not running", chat.includes("studio_running.load(Ordering::Relaxed)") && chat.includes("Roblox Studio is not running"));
ok("OpenAI tool shape", chat.includes('"type": "function"') && chat.includes('"parameters": clean_schema('));
ok("tool names sanitised to ^[a-zA-Z0-9_-]{1,64}$", chat.includes("fn wire_name") && chat.includes("s.truncate(64)"));
ok("schema cleaned (type object, properties, no $schema)", chat.includes('obj.remove("$schema")') && chat.includes('obj.entry("type").or_insert(json!("object"))'));
ok("tool_choice auto", chat.includes('body["tool_choice"] = json!("auto")'));

// ── chat.rs: agent loop ──
ok("run_turn entry point", chat.includes("pub async fn run_turn(state: AppState, req: TurnRequest, events: Sender<ChatEvent>, cancel: Arc<AtomicBool>)"));
ok("system prompt explains execute_luau", chat.includes("execute_luau {code, datamodel_type:\\\"edit\\\"}") && chat.includes("ChangeHistoryService"));
ok("system prompt carries live Studio / plugin status", chat.includes("LIVE STATUS") && chat.includes("Roblox Studio MCP:") && chat.includes("ORscript Studio plugin:"));
ok("standing instructions appended", chat.includes("USER INSTRUCTIONS"));
ok("tool calls run through the bridge's own paths", chat.includes("workspace::dispatch(&state.workspace, name, args)") && chat.includes("plugin::call(state, name, args)") && chat.includes("crate::roblox_tool(state, name, args)"));
ok("per-tool timeout", chat.includes("tokio::time::timeout(Duration::from_secs(300), fut)"));
ok("assistant + tool messages appended in OpenAI order", chat.includes('"role": "tool", "tool_call_id": id, "content": clamp_result(&content)') && chat.includes('assistant["tool_calls"] = Value::Array(tc)'));
ok("errors returned to the model as ERROR:", chat.includes('format!("ERROR: {text}")'));
ok("results clamped", chat.includes("const RESULT_MAX_CHARS: usize = 24_000"));
ok("screenshots forwarded as image_url parts (toggle)", chat.includes('"type": "image_url"') && chat.includes("req.send_images"));
ok("cancel keeps history valid", chat.includes("[cancelled by the user]"));
ok("step budget 1..=64", chat.includes("req.max_steps.clamp(1, 64)") && chat.includes("Step limit"));
ok("lenient JSON arguments", chat.includes("fn parse_args") && chat.includes("s.rfind('}')"));
ok("Finished event carries appended messages + usage", chat.includes("Finished { appended: Vec<Value>, prompt_tokens: u64, completion_tokens: u64, steps: usize, error: Option<String> }"));

// ── gui.rs ↔ chat.rs ↔ main.rs contracts ──
ok("main declares mod chat", /^mod chat;/m.test(main));
ok("UiCommand::ChatTurn + ChatModels", gui.includes("ChatTurn { request: crate::chat::TurnRequest, events: Sender<crate::chat::ChatEvent>, cancel: Arc<AtomicBool> }") && gui.includes("ChatModels { base_url: String, api_key: String, reply: Sender<Result<Vec<String>, String>> }"));
ok("ui_command_loop spawns run_turn / list_models", main.includes("chat::run_turn(state2, request, events, cancel).await") && main.includes("chat::list_models(&base_url, &api_key).await"));
const eventNames = ["Status", "Delta", "AssistantStart", "ToolStart", "ToolDone", "Finished"];
ok("gui handles every ChatEvent", eventNames.every((e) => gui.includes("E::" + e)));
const reqFields = ["base_url", "api_key", "model", "messages", "tools", "max_steps", "temperature", "send_images", "instructions"];
ok("gui builds every TurnRequest field", reqFields.every((f) => new RegExp("\\b" + f + ":\\s").test(gui.slice(gui.indexOf("crate::chat::TurnRequest {")))));
ok("Tools page Run routes plugin commands through plugin::call (fix)", main.includes('_ => if plugin::is_plugin_tool(&name) { plugin::call(&state2, &name, args).await } else { roblox_tool(&state2, &name, args).await },'));

// ── gui.rs: settings ──
for (const f of ["chat_provider: String", "chat_custom_url: String", "chat_keys: HashMap<String, String>", "chat_models: HashMap<String, String>", "chat_tools: bool", "chat_send_images: bool", "chat_max_steps: u32", "chat_temperature: f32", "chat_instructions: String", "chat_panel_open: bool", "chat_panel_width: f32"]) {
  ok(`Settings.${f.split(":")[0]}`, gui.includes("pub " + f + ","));
}
ok("Settings defaults (codecraft, tools on, 16 steps)", gui.includes('chat_provider: "codecraft".into()') && gui.includes("chat_tools: true") && gui.includes("chat_max_steps: 16"));
ok("settings keep serde(default) so old settings.json still loads", /#\[serde\(default\)\]\s*pub struct Settings/.test(gui));

// ── gui.rs: panel ──
ok("right side panel", gui.includes('egui::SidePanel::right("chat-panel")') && gui.includes("width_range(320.0..=760.0)"));
ok("panel drawn before the central panel on every page", gui.indexOf("self.chat_panel(ctx);") > 0 && gui.indexOf("self.chat_panel(ctx);") < gui.indexOf("Page::Home => self.page_home(ui)"));
ok("AI Chat is a sidebar page (second entry, Ctrl+2)", gui.includes("enum Page { Home, Chat, Explorer, Tools, Servers, Terminal, Settings }") && gui.includes("Page::Chat => egui::Key::Num2") && gui.includes('Page::Chat => "AI Chat"') && gui.includes("Page::Chat => self.page_chat(ui)"));
ok("sidebar page has its own icon + busy dot", gui.includes("Page::Chat => {\n            // speech bubble") && gui.includes("if page == Page::Chat && self.chat_turn.is_some()"));
ok("side panel hidden while the Chat page is shown", gui.includes("if self.page != Page::Chat { self.chat_panel(ctx); }"));
ok("page offers Side panel hand-off", gui.includes('pill(ui, t, "Side panel", false)') && gui.includes("fn page_chat"));
ok("setup is a floating window, never squeezing the transcript", gui.includes("fn chat_setup_window") && gui.includes('egui::Window::new("AI chat setup")') && gui.includes(".vscroll(true)") && !gui.includes("if self.chat_setup_open { self.chat_setup(ui); }"));
ok("sending closes setup; empty transcript offers setup", gui.includes("self.chat_setup_open = false;\n        self.chat_push(ChatRole::User") && gui.includes('"Open setup — provider, API key, model"'));
ok("reasoning streams land in a collapsed thinking block", chat.includes("ChatEvent::Thinking(") && chat.includes('"reasoning_content"') && gui.includes("E::Thinking(text)") && gui.includes('"chat-thinking"'));
ok("empty replies are explained, not swallowed", chat.includes("The model returned an empty reply (finish_reason: {fr}){why}"));
ok("assistant bubble has a header, 15px body text, left-aligned user bubble", gui.includes('RichText::new("ORSCRIPT").small().strong().color(t.accent)') && gui.includes("RichText::new(plain).size(15.0)") && gui.includes("Layout::top_down(Align::Max)"));
ok("chat page uses a fixed-width centred column (no centred labels)", gui.includes("fn page_chat") && gui.includes("allocate_ui_at_rect(rect") && !gui.slice(gui.indexOf("fn page_chat")).slice(0, 2500).includes("vertical_centered"));
ok("title-bar AI Chat pill", gui.includes('pill(ui, t, "AI Chat", chat_open)'));
ok("Ctrl+J toggles", gui.includes("if i.key_pressed(egui::Key::J) { chat = true; }") && gui.includes("if chat { self.toggle_chat(); }"));
ok("provider / model combos + Refresh", gui.includes('from_id_salt("chat-provider")') && gui.includes('from_id_salt("chat-model")') && gui.includes("fn chat_refresh_models"));
ok("API key field is a password box with show toggle", gui.includes(".password(!visible)") && gui.includes('selectable_label(visible, "show")'));
ok("keys stored per provider", gui.includes("self.settings.chat_keys.entry(p.id.to_string()).or_default()"));
ok("Enter sends, Shift+Enter newline", gui.includes("consume_key(egui::Modifiers::NONE, egui::Key::Enter)") && gui.includes("Shift+Enter = new line"));
ok("Stop / New / Export", gui.includes("fn chat_stop") && gui.includes("fn chat_new") && gui.includes("fn chat_export") && gui.includes("orscript-chat-"));
ok("tool cards with details + images", gui.includes("fn chat_tool_card") && gui.includes('"details"') && gui.includes("card.images"));
ok("fenced code rendered as copyable blocks", gui.includes("fn chat_rich_text") && gui.includes('text.split("```")'));
ok("screenshots also refresh the Home snapshot", gui.includes("self.store_snapshot(ctx, &images, &name)"));
ok("chat events polled every frame", gui.includes("self.chat_poll(ctx);") && gui.includes("self.chat_turn.is_some() || self.chat_models_rx.is_some()"));
ok("Settings page section", gui.includes('"AI chat (side panel)"') && gui.includes("Forget all API keys"));
ok("suggestion chips on empty transcript", gui.includes("Build a spawn lobby"));

// ── docs + pins ──
ok("agent README documents the panel", agentReadme.includes("## AI chat panel (1.37.0)") && agentReadme.includes("src/chat.rs"));
ok("README changelog 1.37.0", readme.includes("**1.37.0 — or-core: AI chat side panel that works in Studio.**"));
ok("README crate line updated", readme.includes("`or-agent` 1.41.2") && !readme.includes("removed desktop status window"));
ok("manifest version is 1.41.2", manifest.version === "1.41.2", manifest.version);
ok("crate / plugin pinned at 1.41.2", /^version = "1\.41\.2"/m.test(cargo) && read("plugin/ORscript.lua").includes('local VERSION = "1.41.2"') && /name = "or-agent"\nversion = "1\.41\.2"/.test(read("agent/Cargo.lock")));
ok("no new crates needed", !/^(eventsource|async-openai|openai)/m.test(cargo));

console.log(failed ? `\n${failed} check(s) failed` : "\nall agent-chat checks passed");
process.exit(failed ? 1 : 0);
