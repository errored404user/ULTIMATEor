//! AI chat engine for the desktop window's side panel.
//!
//! The panel talks to any OpenAI-compatible `/v1/chat/completions` endpoint
//! (CodeCraft, OpenAI, OpenRouter, Groq, DeepSeek, Gemini's OpenAI layer,
//! xAI, Mistral, Together, a local Ollama / LM Studio, or a custom URL) with
//! the user's own API key. The selected model receives the bridge's whole
//! toolkit as OpenAI *function tools* — Studio MCP (`execute_luau`,
//! `screen_capture`, `get_studio_state`), the TotalScript Studio plugin commands
//! and the workspace file tools — and this module runs the agent loop:
//! stream the reply, execute every requested tool through the same code paths
//! the browser extension uses, feed the results back, repeat until the model
//! answers in plain text (or the step budget is spent / the user presses Stop).
//!
//! Everything here runs on the tokio runtime; the GUI thread only sends a
//! [`TurnRequest`] and polls [`ChatEvent`]s from a std channel.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::Sender,
        Arc,
    },
    time::{Duration, Instant},
};

use futures::StreamExt;
use serde_json::{json, Value};

use crate::{plugin, workspace, AppState, McpToolOutput};

// ───────────────────────────── providers ─────────────────────────────

/// A preset for the provider picker. `base_url` is the OpenAI-compatible root
/// (the part before `/chat/completions`).
#[derive(Clone, Copy, Debug)]
pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    pub needs_key: bool,
    pub key_hint: &'static str,
}

pub const PROVIDERS: &[Provider] = &[
    Provider { id: "codecraft", name: "CodeCraft API", base_url: "https://codecraftapi.com/v1", needs_key: true, key_hint: "cc_… key from codecraftapi.com → Dashboard → API keys" },
    Provider { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", needs_key: true, key_hint: "sk-… key from platform.openai.com/api-keys" },
    Provider { id: "openrouter", name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", needs_key: true, key_hint: "sk-or-… key from openrouter.ai/keys (hundreds of models)" },
    Provider { id: "groq", name: "Groq", base_url: "https://api.groq.com/openai/v1", needs_key: true, key_hint: "gsk_… key from console.groq.com/keys" },
    Provider { id: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com/v1", needs_key: true, key_hint: "key from platform.deepseek.com/api_keys" },
    Provider { id: "gemini", name: "Google Gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", needs_key: true, key_hint: "AI Studio key from aistudio.google.com/apikey" },
    Provider { id: "xai", name: "xAI Grok", base_url: "https://api.x.ai/v1", needs_key: true, key_hint: "xai-… key from console.x.ai" },
    Provider { id: "mistral", name: "Mistral", base_url: "https://api.mistral.ai/v1", needs_key: true, key_hint: "key from console.mistral.ai/api-keys" },
    Provider { id: "together", name: "Together AI", base_url: "https://api.together.xyz/v1", needs_key: true, key_hint: "key from api.together.ai/settings/api-keys" },
    Provider { id: "ollama", name: "Ollama (local)", base_url: "http://127.0.0.1:11434/v1", needs_key: false, key_hint: "no key — run `ollama serve` and pull a tool-capable model (qwen2.5, llama3.1…)" },
    Provider { id: "lmstudio", name: "LM Studio (local)", base_url: "http://127.0.0.1:1234/v1", needs_key: false, key_hint: "no key — start the LM Studio local server" },
    Provider { id: "custom", name: "Custom endpoint", base_url: "", needs_key: false, key_hint: "any OpenAI-compatible base URL (…/v1); key optional" },
];

pub fn provider(id: &str) -> &'static Provider {
    PROVIDERS.iter().find(|p| p.id == id).unwrap_or(&PROVIDERS[0])
}

/// Normalise a base URL: trim, drop trailing slashes and a trailing
/// `/chat/completions` if someone pasted the full endpoint.
pub fn normalize_base(url: &str) -> String {
    let mut s = url.trim().trim_end_matches('/').to_string();
    for suffix in ["/chat/completions", "/models"] {
        if s.ends_with(suffix) { s.truncate(s.len() - suffix.len()); }
    }
    s
}

// ───────────────────────────── protocol with the GUI ─────────────────────────────

/// One user turn. `messages` is the OpenAI-format history *without* the
/// system prompt (the engine builds that from live bridge state).
#[derive(Clone, Debug)]
pub struct TurnRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<Value>,
    pub tools: bool,
    pub max_steps: usize,
    pub temperature: f32,
    pub send_images: bool,
    pub instructions: String,
}

#[derive(Debug)]
pub enum ChatEvent {
    /// Short progress line for the status bar ("contacting model", "step 3/16").
    Status(String),
    /// Streamed assistant text (append to the current bubble).
    Delta(String),
    /// Streamed reasoning / thinking text (DeepSeek R1, o-series via some
    /// gateways, Gemini thinking…). Shown collapsed, never sent back.
    Thinking(String),
    /// A new assistant message starts (after tool calls, the model speaks again).
    AssistantStart,
    ToolStart { id: String, name: String, args: Value },
    ToolDone { id: String, name: String, ok: bool, text: String, images: Vec<(String, String)>, elapsed_ms: u128 },
    /// A guarded tool (shell / process / delete / download / open) wants to
    /// run. The turn is paused until the window answers through `reply`
    /// (true = run it). Dropping the sender counts as Deny.
    Approval { name: String, args: Value, reply: tokio::sync::oneshot::Sender<bool> },
    /// Turn finished. `appended` are the messages to add to the GUI's history
    /// (assistant + tool messages) so the next turn has full context.
    Finished { appended: Vec<Value>, prompt_tokens: u64, completion_tokens: u64, steps: usize, error: Option<String> },
}

/// Tools that run programs or destroy / fetch data on the user's PC. They
/// never run unattended from the desktop chat: the turn pauses and the window
/// asks Allow / Deny (same rule the browser extension applies in Sandbox and
/// Ask access modes). Studio Luau and workspace file writes are the product's
/// normal output and stay automatic; the write tools keep backups instead.
pub const GUARDED_TOOLS: &[&str] = &["run_command", "process_kill", "delete_path", "download_file", "open_path"];
/// How long a paused turn waits for Allow / Deny before the call is denied.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

pub fn is_guarded(name: &str) -> bool {
    let bare = name.rsplit('/').next().unwrap_or(name);
    GUARDED_TOOLS.contains(&bare)
}

/// Ask the window and wait. `Ok(())` = allowed; `Err(text)` = the reason the
/// tool must not run (denied, timed out, window gone, turn stopped).
async fn await_approval(events: &Sender<ChatEvent>, cancel: &Arc<AtomicBool>, name: &str, args: &Value) -> Result<(), String> {
    let (tx, mut rx) = tokio::sync::oneshot::channel::<bool>();
    if events.send(ChatEvent::Approval { name: name.to_string(), args: args.clone(), reply: tx }).is_err() {
        return Err(format!("'{name}' was not run: the window that must approve it is gone"));
    }
    let deadline = Instant::now() + APPROVAL_TIMEOUT;
    loop {
        if cancel.load(Ordering::Relaxed) { return Err(format!("'{name}' was not run: stopped by the user")); }
        match tokio::time::timeout(Duration::from_millis(200), &mut rx).await {
            Ok(Ok(true)) => return Ok(()),
            Ok(Ok(false)) => return Err(format!("'{name}' was DENIED by the user. Do not retry it; ask the user what they want instead")),
            Ok(Err(_)) => return Err(format!("'{name}' was not run: the approval prompt was dismissed")),
            Err(_) if Instant::now() >= deadline => return Err(format!("'{name}' was not run: nobody answered the Allow / Deny prompt within {} s. Stop and ask the user to answer it in the TotalScript window", APPROVAL_TIMEOUT.as_secs())),
            Err(_) => continue,
        }
    }
}

// ───────────────────────────── models ─────────────────────────────

fn http_client(timeout: Duration) -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(timeout)
        .user_agent(concat!("TotalScript total-core/", env!("CARGO_PKG_VERSION")))
        .build()?)
}

fn auth(req: reqwest::RequestBuilder, base: &str, key: &str) -> reqwest::RequestBuilder {
    let mut req = req;
    if !key.trim().is_empty() {
        req = req.header("Authorization", format!("Bearer {}", key.trim()));
    }
    if base.contains("openrouter.ai") {
        req = req.header("HTTP-Referer", "https://github.com/errored404user/ULTIMATEor").header("X-Title", "TotalScript total-core");
    }
    req
}

/// `GET {base}/models` → sorted model ids.
pub async fn list_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    let base = normalize_base(base_url);
    if base.is_empty() { return Err("set a base URL first".into()); }
    let client = http_client(Duration::from_secs(30)).map_err(|e| e.to_string())?;
    let resp = auth(client.get(format!("{base}/models")), &base, api_key)
        .send()
        .await
        .map_err(|e| format!("{base}/models unreachable: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {} from /models: {}", status.as_u16(), short_error(&body)));
    }
    let val: Value = serde_json::from_str(&body).map_err(|e| format!("/models did not return JSON: {e}"))?;
    let arr = val.get("data").and_then(|v| v.as_array()).cloned()
        .or_else(|| val.get("models").and_then(|v| v.as_array()).cloned())
        .or_else(|| val.as_array().cloned())
        .unwrap_or_default();
    let mut ids: Vec<String> = arr.iter().filter_map(|m| {
        m.get("id").and_then(|v| v.as_str())
            .or_else(|| m.get("name").and_then(|v| v.as_str()))
            .or_else(|| m.as_str())
            .map(str::to_string)
    }).collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() { return Err("the endpoint returned no models".into()); }
    Ok(ids)
}

/// Readable text for an `error` member of a JSON reply (string or object).
fn error_text(err: &Value) -> String {
    match err {
        Value::String(s) => s.clone(),
        other => short_error(&json!({"error": other}).to_string()),
    }
}

/// Pull a readable message out of an API error body.
fn short_error(body: &str) -> String {
    let text = serde_json::from_str::<Value>(body).ok()
        .and_then(|v| {
            v.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_string)
                .or_else(|| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
                .or_else(|| v.get("error").and_then(|m| m.as_str()).map(str::to_string))
                .or_else(|| v.get("detail").and_then(|m| m.as_str()).map(str::to_string))
        })
        .unwrap_or_else(|| body.trim().to_string());
    let text = text.replace('\n', " ");
    if text.chars().count() > 300 { text.chars().take(299).collect::<String>() + "…" } else { text }
}

// ───────────────────────────── tool catalogue ─────────────────────────────

struct ToolDef {
    /// Name as advertised to the model (sanitised for OpenAI's `^[a-zA-Z0-9_-]{1,64}$`).
    wire: String,
    /// Real tool name for the bridge.
    name: String,
    engine: &'static str,
    def: Value,
}

fn wire_name(name: &str) -> String {
    let mut s: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    if s.is_empty() { s = "tool".into(); }
    if s.len() > 64 { s.truncate(64); }
    s
}

fn clean_schema(schema: Option<&Value>) -> Value {
    let mut s = match schema {
        Some(Value::Object(m)) => Value::Object(m.clone()),
        _ => json!({}),
    };
    if let Some(obj) = s.as_object_mut() {
        obj.remove("$schema");
        obj.entry("type").or_insert(json!("object"));
        if !obj.get("properties").map(|p| p.is_object()).unwrap_or(false) {
            obj.insert("properties".into(), json!({}));
        }
        if obj.get("required").map(|r| !r.is_array()).unwrap_or(false) { obj.remove("required"); }
    }
    s
}

fn to_defs(values: &[Value], engine: &'static str, out: &mut Vec<ToolDef>, seen: &mut HashMap<String, ()>) {
    for v in values {
        let Some(name) = v.get("name").and_then(|n| n.as_str()) else { continue };
        let mut wire = wire_name(name);
        if seen.contains_key(&wire) {
            wire = wire_name(&format!("{engine}_{name}"));
            if seen.contains_key(&wire) { continue; }
        }
        seen.insert(wire.clone(), ());
        let mut description = v.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string();
        if description.chars().count() > 1000 { description = description.chars().take(999).collect::<String>() + "…"; }
        let def = json!({
            "type": "function",
            "function": {
                "name": wire,
                "description": description,
                "parameters": clean_schema(v.get("inputSchema").or_else(|| v.get("input_schema")).or_else(|| v.get("parameters"))),
            }
        });
        out.push(ToolDef { wire, name: name.to_string(), engine, def });
    }
}

struct Catalogue {
    tools: Vec<ToolDef>,
    studio_linked: bool,
    plugin_connected: bool,
    note: String,
}

async fn catalogue(state: &AppState) -> Catalogue {
    let mut tools = Vec::new();
    let mut seen = HashMap::new();
    let mut note = String::new();
    // Only talk to the MCP helper when a Studio process exists — otherwise the
    // list would just stall on a launcher that has nothing to attach to.
    let studio = if !state.ui.studio_running.load(Ordering::Relaxed) && !state.ui.studio_connected.load(Ordering::Relaxed) {
        note = "Roblox Studio is not running — open a place in Studio to unlock execute_luau / screen_capture.".into();
        false
    } else {
        match crate::roblox_tools(state).await {
            Ok(list) => { to_defs(&list, "roblox", &mut tools, &mut seen); true }
            Err(e) => { note = format!("Studio MCP tools unavailable right now ({}).", crate::gui_truncate(&format!("{e:#}"), 160)); false }
        }
    };
    let plugin_connected = state.plugin.connected().await;
    let key_set = state.plugin.key().await.is_some();
    let plugin_tools = plugin::tools(plugin_connected, key_set);
    to_defs(&plugin_tools, "roblox", &mut tools, &mut seen);
    let local = workspace::catalog();
    to_defs(&local, "local", &mut tools, &mut seen);
    Catalogue { tools, studio_linked: studio, plugin_connected, note }
}

fn system_prompt(state: &AppState, cat: &Catalogue, instructions: &str, tools_enabled: bool) -> String {
    let root = state.ui.root();
    let mut s = String::new();
    s.push_str("You are TotalScript, an expert Roblox engineer working inside the total-core desktop bridge on the user's PC. ");
    if tools_enabled {
        s.push_str("You act through tools — call them instead of describing what you would do. Never claim something was built, changed or verified unless a tool result shows it.\n\n");
        s.push_str("STUDIO TOOLS\n");
        s.push_str("- execute_luau {code, datamodel_type:\"edit\"} runs Luau inside Roblox Studio (Edit mode, full Instance API, plugin security). Everything you print() comes back as the result — print what you need to inspect or verify. Build with Instance.new, set properties, set Parent last. Scripts: Instance.new(\"Script\"/\"LocalScript\"/\"ModuleScript\") and assign .Source as a string. Use game:GetService(\"ChangeHistoryService\"):SetWaypoint() after edits so the user can undo. One logical step per call; keep each script under ~200 lines; on an error read the message, fix the code and retry.\n");
        s.push_str("- get_studio_state / studio_plugin_status report what is open. screen_capture returns a viewport screenshot (look at it to judge visuals). Plugin commands (studio_*, csg_*, open_script, script_live_update, screenshot_frame…) exist only while the TotalScript Studio plugin is connected.\n");
        s.push_str("- Workspace tools (read_file, write_file, edit_file, tree, run_command…) operate on the user's project folder");
        if !root.is_empty() { s.push_str(&format!(" at {root}")); }
        s.push_str(". Use them for Rojo-style projects, assets and notes.\n\n");
        s.push_str("WORKING STYLE\n- Plan briefly in one or two sentences, then execute. Verify results (count children, print names/positions, take a screenshot for visuals) before reporting.\n- Prefer complete, production-quality Luau: typed where sensible, services cached, no deprecated APIs, server/client split respected (LocalScripts under StarterPlayerScripts/StarterGui, Scripts under ServerScriptService).\n- Destructive actions (deleting many instances, overwriting scripts, running shell commands) need an explicit user request. run_command, process_kill, delete_path, download_file and open_path pause the turn until the user clicks Allow in this window — if the result says DENIED, do not retry, ask instead. write_file / edit_file keep a copy of the previous version in .totalscript-backups/.\n- Final answers are short: what was done, where it lives, what to check. No filler.\n\n");
    } else {
        s.push_str("Tools are disabled for this chat — answer with code and precise Studio instructions the user can apply by hand.\n\n");
    }
    s.push_str("LIVE STATUS\n");
    s.push_str(&format!("- Roblox Studio MCP: {}\n", if cat.studio_linked { "linked (execute_luau / screen_capture available)" } else { "NOT linked — Studio tools will fail until the user opens Studio with MCP enabled; say so instead of retrying blindly" }));
    s.push_str(&format!("- TotalScript Studio plugin: {}\n", if cat.plugin_connected { "connected" } else { "not connected (plugin commands unavailable)" }));
    if !cat.note.is_empty() { s.push_str(&format!("- {}\n", cat.note)); }
    s.push_str(&format!("- Date: {}\n", chrono::Local::now().format("%Y-%m-%d")));
    let extra = instructions.trim();
    if !extra.is_empty() {
        s.push_str("\nUSER INSTRUCTIONS\n");
        s.push_str(extra);
        s.push('\n');
    }
    s
}

// ───────────────────────────── streaming completion ─────────────────────────────

#[derive(Default, Debug, Clone)]
struct ToolCallAcc {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default, Debug)]
struct Completion {
    text: String,
    tool_calls: Vec<ToolCallAcc>,
    prompt_tokens: u64,
    completion_tokens: u64,
    finish_reason: String,
    reasoning: String,
}

fn absorb_usage(c: &mut Completion, v: &Value) {
    if let Some(u) = v.get("usage") {
        if let Some(p) = u.get("prompt_tokens").and_then(|x| x.as_u64()) { c.prompt_tokens = p; }
        if let Some(o) = u.get("completion_tokens").and_then(|x| x.as_u64()) { c.completion_tokens = o; }
    }
}

fn absorb_tool_calls(acc: &mut Vec<ToolCallAcc>, calls: &[Value]) {
    for (i, call) in calls.iter().enumerate() {
        let idx = call.get("index").and_then(|x| x.as_u64()).map(|x| x as usize).unwrap_or(i);
        while acc.len() <= idx { acc.push(ToolCallAcc::default()); }
        let slot = &mut acc[idx];
        if let Some(id) = call.get("id").and_then(|x| x.as_str()) { if !id.is_empty() { slot.id = id.to_string(); } }
        if let Some(f) = call.get("function") {
            if let Some(n) = f.get("name").and_then(|x| x.as_str()) { if !n.is_empty() { slot.name.push_str(n); } }
            match f.get("arguments") {
                Some(Value::String(a)) => slot.arguments.push_str(a),
                Some(Value::Object(o)) => slot.arguments.push_str(&Value::Object(o.clone()).to_string()),
                _ => {}
            }
        }
    }
}

/// Apply one SSE JSON chunk (streaming delta) to the accumulator.
fn absorb_chunk(c: &mut Completion, v: &Value, events: &Sender<ChatEvent>) -> Result<(), String> {
    if let Some(err) = v.get("error") {
        return Err(error_text(err));
    }
    absorb_usage(c, v);
    if let Some(choice) = v.get("choices").and_then(|x| x.as_array()).and_then(|a| a.first()) {
        if let Some(fr) = choice.get("finish_reason").and_then(|x| x.as_str()) { c.finish_reason = fr.to_string(); }
        let delta = choice.get("delta").or_else(|| choice.get("message"));
        if let Some(d) = delta {
            if let Some(text) = d.get("content").and_then(|x| x.as_str()) {
                if !text.is_empty() {
                    c.text.push_str(text);
                    let _ = events.send(ChatEvent::Delta(text.to_string()));
                }
            }
            if let Some(think) = d.get("reasoning_content").or_else(|| d.get("reasoning")).and_then(|x| x.as_str()) {
                if !think.is_empty() {
                    c.reasoning.push_str(think);
                    let _ = events.send(ChatEvent::Thinking(think.to_string()));
                }
            }
            if let Some(calls) = d.get("tool_calls").and_then(|x| x.as_array()) {
                absorb_tool_calls(&mut c.tool_calls, calls);
            }
        }
    }
    Ok(())
}

/// Apply a non-streaming completion object.
fn absorb_full(c: &mut Completion, v: &Value, events: &Sender<ChatEvent>) -> Result<(), String> {
    if let Some(err) = v.get("error") {
        return Err(error_text(err));
    }
    absorb_usage(c, v);
    let Some(choice) = v.get("choices").and_then(|x| x.as_array()).and_then(|a| a.first()) else {
        return Err("response has no choices".into());
    };
    if let Some(fr) = choice.get("finish_reason").and_then(|x| x.as_str()) { c.finish_reason = fr.to_string(); }
    if let Some(m) = choice.get("message") {
        match m.get("content") {
            Some(Value::String(text)) => {
                if !text.is_empty() { c.text.push_str(text); let _ = events.send(ChatEvent::Delta(text.clone())); }
            }
            Some(Value::Array(parts)) => {
                for p in parts {
                    if let Some(text) = p.get("text").and_then(|x| x.as_str()) {
                        c.text.push_str(text);
                        let _ = events.send(ChatEvent::Delta(text.to_string()));
                    }
                }
            }
            _ => {}
        }
        if let Some(think) = m.get("reasoning_content").or_else(|| m.get("reasoning")).and_then(|x| x.as_str()) {
            if !think.is_empty() {
                c.reasoning.push_str(think);
                let _ = events.send(ChatEvent::Thinking(think.to_string()));
            }
        }
        if let Some(calls) = m.get("tool_calls").and_then(|x| x.as_array()) {
            absorb_tool_calls(&mut c.tool_calls, calls);
        }
    }
    Ok(())
}

async fn complete(
    base: &str,
    key: &str,
    body: &Value,
    events: &Sender<ChatEvent>,
    cancel: &AtomicBool,
) -> Result<Completion, String> {
    let client = http_client(Duration::from_secs(900)).map_err(|e| e.to_string())?;
    let resp = auth(client.post(format!("{base}/chat/completions")), base, key)
        .header("Accept", "text/event-stream, application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
    let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok());
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let msg = short_error(&text);
        let code = status.as_u16();
        let hint = match code {
            401 | 403 => " — check the API key",
            402 => " — the account is out of credits / tokens",
            404 => " — wrong base URL or model id",
            429 => " — rate limited, wait a moment",
            _ => "",
        };
        let ra = retry_after.map(|secs| format!(" (retry-after {secs}s)")).unwrap_or_default();
        return Err(format!("HTTP {code}{hint}{ra}: {msg}"));
    }
    let mut out = Completion::default();
    if !content_type.contains("text/event-stream") {
        // Provider ignored `stream` — a single JSON document.
        let text = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
        let trimmed = text.trim_start();
        if trimmed.starts_with("data:") {
            for line in trimmed.lines() { sse_line(line, &mut out, events)?; }
        } else {
            let v: Value = serde_json::from_str(&text).map_err(|e| format!("non-JSON reply: {e} — {}", crate::gui_truncate(&text, 160)))?;
            absorb_full(&mut out, &v, events)?;
        }
        return Ok(out);
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut done = false;
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) { return Err("stopped".into()); }
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim_end_matches('\r').to_string();
            buf.drain(..=pos);
            if line.trim() == "data: [DONE]" || line.trim() == "data:[DONE]" { done = true; continue; }
            sse_line(&line, &mut out, events)?;
        }
        if done { break; }
    }
    if !buf.trim().is_empty() && !done {
        let rest = buf.clone();
        sse_line(rest.trim_end(), &mut out, events)?;
    }
    Ok(out)
}

fn sse_line(line: &str, out: &mut Completion, events: &Sender<ChatEvent>) -> Result<(), String> {
    let line = line.trim();
    if line.is_empty() || line.starts_with(':') { return Ok(()); }
    let Some(payload) = line.strip_prefix("data:") else { return Ok(()); };
    let payload = payload.trim();
    if payload.is_empty() || payload == "[DONE]" { return Ok(()); }
    match serde_json::from_str::<Value>(payload) {
        Ok(v) => absorb_chunk(out, &v, events),
        Err(_) => Ok(()), // keep-alive / partial junk
    }
}

// ───────────────────────────── tool execution ─────────────────────────────

async fn execute(state: &AppState, engine: &str, name: &str, args: Value) -> anyhow::Result<McpToolOutput> {
    let fut = async {
        match engine {
            "local" => workspace::dispatch(&state.workspace, name, args).await
                .map(|text| McpToolOutput { text, images: Vec::new() })
                .map_err(anyhow::Error::msg),
            _ => {
                if plugin::is_plugin_tool(name) { plugin::call(state, name, args).await } else { crate::roblox_tool(state, name, args).await }
            }
        }
    };
    match tokio::time::timeout(Duration::from_secs(300), fut).await {
        Ok(r) => r,
        Err(_) => Err(anyhow::anyhow!("tool call timed out after 300 s")),
    }
}

fn parse_args(raw: &str) -> Result<Value, String> {
    let s = raw.trim();
    if s.is_empty() { return Ok(json!({})); }
    match serde_json::from_str::<Value>(s) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(Value::Null) => Ok(json!({})),
        Ok(other) => Err(format!("arguments must be a JSON object, got {other}")),
        Err(e) => {
            // Some models wrap the object in quotes or append junk — one lenient retry.
            if let (Some(a), Some(b)) = (s.find('{'), s.rfind('}')) {
                if a < b {
                    if let Ok(v) = serde_json::from_str::<Value>(&s[a..=b]) { if v.is_object() { return Ok(v); } }
                }
            }
            Err(format!("arguments are not valid JSON ({e})"))
        }
    }
}

const RESULT_MAX_CHARS: usize = 24_000;

fn clamp_result(text: &str) -> String {
    let n = text.chars().count();
    if n <= RESULT_MAX_CHARS { return text.to_string(); }
    let head: String = text.chars().take(RESULT_MAX_CHARS - 200).collect();
    format!("{head}\n…[truncated {} characters — ask for a narrower slice]", n - (RESULT_MAX_CHARS - 200))
}

// ───────────────────────────── failure taxonomy (1.69) ─────────────────────────────

/// What a failed `/chat/completions` call means for the retry policy.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ErrClass {
    /// HTTP 429 — wait (Retry-After when given) and resend, at most twice.
    RateLimit,
    /// HTTP 5xx / overloaded — short back-off, at most twice.
    Server,
    /// The request never reached the server (DNS, refused, reset) — at most twice.
    Network,
    /// HTTP 4xx saying the prompt is longer than the model's window — drop the
    /// oldest exchange and resend.
    ContextLength,
    /// HTTP 4xx rejecting a request field (`temperature` on reasoning models…).
    UnsupportedParam,
    /// Everything else (bad key, wrong model, invalid request…) — never retried.
    Permanent,
}

fn classify_error(e: &str) -> ErrClass {
    let l = e.to_lowercase();
    // Mid-stream failures are never resent: tokens were already shown and a resend would double any tool work.
    if l.starts_with("stream error") { return ErrClass::Permanent; }
    if l.starts_with("http 429") { return ErrClass::RateLimit; }
    if l.starts_with("http 5") || l.contains("overloaded") || l.contains("server is busy") { return ErrClass::Server; }
    if l.starts_with("request failed:") { return ErrClass::Network; }
    if l.starts_with("http 4") {
        if ["context length", "context_length", "maximum context", "too many tokens", "reduce the length", "prompt is too long", "input is too long", "exceeds the model", "token limit", "context window", "max_tokens"].iter().any(|k| l.contains(k)) {
            return ErrClass::ContextLength;
        }
        if ["unsupported parameter", "unknown parameter", "unrecognized request argument", "temperature", "is not supported with", "not supported for this model"].iter().any(|k| l.contains(k)) {
            return ErrClass::UnsupportedParam;
        }
    }
    ErrClass::Permanent
}

fn class_label(c: ErrClass) -> &'static str {
    match c {
        ErrClass::RateLimit => "rate limited",
        ErrClass::Server => "provider error",
        ErrClass::Network => "connection failed",
        ErrClass::ContextLength => "context too long",
        ErrClass::UnsupportedParam => "unsupported parameter",
        ErrClass::Permanent => "request rejected",
    }
}

/// Seconds announced by a `Retry-After` header that `complete` folded into the
/// error text as ` (retry-after Ns)`.
fn retry_after_secs(e: &str) -> Option<u64> {
    let l = e.to_lowercase();
    let i = l.find("retry-after ")?;
    let digits: String = l[i + "retry-after ".len()..].chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Drop the oldest exchange — everything from the first non-system message up
/// to (not including) the next user message — so a context-length rejection
/// can be retried with a shorter history. Whole exchanges only, so an
/// assistant `tool_calls` message is never separated from its `tool` results.
/// Returns false when only the current exchange is left (nothing to drop).
fn trim_history(messages: &mut Vec<Value>) -> bool {
    let first = match messages.iter().position(|m| m["role"] != "system") { Some(i) => i, None => return false };
    let next_user = (first + 1..messages.len()).find(|&i| messages[i]["role"] == "user");
    match next_user {
        Some(end) if end > first => { messages.drain(first..end); true }
        _ => false,
    }
}

/// Required parameters (per the tool's JSON schema) that the model left out or
/// sent empty. `studio_id` is injected by the bridge and never required of the
/// model.
fn missing_required(schema: &Value, args: &Value) -> Vec<String> {
    let Some(req) = schema.get("required").and_then(|r| r.as_array()) else { return Vec::new() };
    req.iter()
        .filter_map(|k| k.as_str())
        .filter(|k| *k != "studio_id")
        .filter(|k| match args.get(*k) {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => s.trim().is_empty(),
            Some(_) => false,
        })
        .map(str::to_string)
        .collect()
}

/// Compact one-line schema for an error message: `name {a: string, b?: integer}`.
fn schema_line(wire: &str, schema: &Value) -> String {
    let required: Vec<&str> = schema.get("required").and_then(|r| r.as_array()).map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    if let Some(props) = schema.get("properties").and_then(|p| p.as_object()) {
        for (k, v) in props.iter().take(24) {
            let ty = v.get("type").map(|t| match t { Value::String(s) => s.clone(), Value::Array(a) => a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("|"), _ => "any".into() }).unwrap_or_else(|| "any".into());
            let en = v.get("enum").and_then(|e| e.as_array()).map(|a| format!(" ∈ {{{}}}", a.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", "))).unwrap_or_default();
            parts.push(format!("{k}{}: {ty}{en}", if required.contains(&k.as_str()) { "" } else { "?" }));
        }
    }
    format!("{wire} {{{}}}", parts.join(", "))
}

// ───────────────────────────── the agent loop ─────────────────────────────

pub async fn run_turn(state: AppState, req: TurnRequest, events: Sender<ChatEvent>, cancel: Arc<AtomicBool>) {
    let base = normalize_base(&req.base_url);
    let mut appended: Vec<Value> = Vec::new();
    let mut prompt_tokens = 0u64;
    let mut completion_tokens = 0u64;
    let mut steps = 0usize;
    let finish = |appended: Vec<Value>, pt: u64, ct: u64, steps: usize, error: Option<String>| {
        let _ = events.send(ChatEvent::Finished { appended, prompt_tokens: pt, completion_tokens: ct, steps, error });
    };
    if base.is_empty() { finish(appended, 0, 0, 0, Some("no base URL — pick a provider in the chat setup".into())); return; }
    if req.model.trim().is_empty() { finish(appended, 0, 0, 0, Some("pick a model first (press Refresh next to the model box)".into())); return; }

    let _ = events.send(ChatEvent::Status("collecting bridge tools".into()));
    let cat = if req.tools { catalogue(&state).await } else { Catalogue { tools: Vec::new(), studio_linked: state.ui.studio_connected.load(Ordering::Relaxed), plugin_connected: state.plugin.connected().await, note: String::new() } };
    let system = system_prompt(&state, &cat, &req.instructions, req.tools && !cat.tools.is_empty());
    let tool_defs: Vec<Value> = cat.tools.iter().map(|t| t.def.clone()).collect();
    let by_wire: HashMap<String, (&'static str, String)> = cat.tools.iter().map(|t| (t.wire.clone(), (t.engine, t.name.clone()))).collect();
    let schema_by_wire: HashMap<String, Value> = cat.tools.iter().map(|t| (t.wire.clone(), t.def.pointer("/function/parameters").cloned().unwrap_or(json!({})))).collect();
    // 1.69: loop guard — the same failing call repeated verbatim.
    let mut last_fail_key = String::new();
    let mut last_fail_count: u32 = 0;
    let mut use_tools = req.tools && !tool_defs.is_empty();

    let mut messages: Vec<Value> = Vec::with_capacity(req.messages.len() + 1);
    messages.push(json!({"role": "system", "content": system}));
    messages.extend(req.messages.iter().cloned());

    let max_steps = req.max_steps.clamp(1, 64);
    let started = Instant::now();
    state.ui.track("chat", format!("turn started · {} · {} tools", req.model, tool_defs.len()));

    loop {
        if cancel.load(Ordering::Relaxed) { finish(appended, prompt_tokens, completion_tokens, steps, Some("stopped".into())); return; }
        if steps >= max_steps {
            let note = format!("Step limit ({max_steps}) reached — raise it in the chat setup or send \"continue\".");
            finish(appended, prompt_tokens, completion_tokens, steps, Some(note));
            return;
        }
        steps += 1;
        let _ = events.send(ChatEvent::Status(if steps == 1 { format!("contacting {}", req.model) } else { format!("step {steps}/{max_steps} · waiting for {}", req.model) }));
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            "temperature": req.temperature,
        });
        if use_tools {
            body["tools"] = Value::Array(tool_defs.clone());
            body["tool_choice"] = json!("auto");
        }
        let _ = events.send(ChatEvent::AssistantStart);
        // 1.69: bounded recovery BEFORE anything streamed — transient classes
        // (429 / 5xx / connection) back off and resend (max 2 retries, honouring
        // Retry-After), a rejected `temperature` is dropped once, a context-length
        // rejection drops the oldest exchange (max 3 times). Permanent failures
        // (bad key, wrong model, invalid request) fall through untouched.
        let mut transient_retries: u32 = 0;
        let mut trims: u32 = 0;
        let mut result: Result<Completion, String> = loop {
            let err = match complete(&base, &req.api_key, &body, &events, &cancel).await { Ok(c) => break Ok(c), Err(e) => e };
            if cancel.load(Ordering::Relaxed) { break Err(err); }
            let class = classify_error(&err);
            match class {
                ErrClass::RateLimit | ErrClass::Server | ErrClass::Network if transient_retries < 2 => {
                    transient_retries += 1;
                    let base_wait: u64 = match class { ErrClass::RateLimit => 8 * transient_retries as u64, ErrClass::Network => 2 * transient_retries as u64, _ => 4 * transient_retries as u64 };
                    let wait = retry_after_secs(&err).map(|s| s.clamp(base_wait, 120)).unwrap_or(base_wait);
                    let _ = events.send(ChatEvent::Status(format!("{} — retrying in {wait}s (attempt {transient_retries}/2)", class_label(class))));
                    state.ui.track("chat", format!("retry {transient_retries} ({}) after: {}", class_label(class), crate::gui_truncate(&err, 120)));
                    let t0 = Instant::now();
                    while t0.elapsed() < Duration::from_secs(wait) && !cancel.load(Ordering::Relaxed) {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                    if cancel.load(Ordering::Relaxed) { break Err(err); }
                    continue;
                }
                ErrClass::UnsupportedParam if err.to_lowercase().contains("temperature") && body.get("temperature").is_some() => {
                    let _ = events.send(ChatEvent::Status("model rejected `temperature` — retrying without it".into()));
                    state.ui.track("chat", format!("{} rejected temperature; resending without it", req.model));
                    if let Some(obj) = body.as_object_mut() { obj.remove("temperature"); }
                    continue;
                }
                ErrClass::ContextLength if trims < 3 => {
                    if !trim_history(&mut messages) { break Err(err); }
                    trims += 1;
                    let _ = events.send(ChatEvent::Status(format!("context too long for {} — dropped the oldest exchange, retrying ({trims}/3)", req.model)));
                    state.ui.track("chat", format!("context length exceeded; history trimmed to {} messages", messages.len()));
                    body["messages"] = Value::Array(messages.clone());
                    continue;
                }
                _ => break Err(err),
            }
        };
        // Providers / models without tool support usually answer 400 mentioning
        // "tools" — retry once without the catalogue instead of dying.
        if let Err(e) = &result {
            let lower = e.to_lowercase();
            if use_tools && lower.starts_with("http 4") && (lower.contains("tool") || lower.contains("function")) && !cancel.load(Ordering::Relaxed) {
                let _ = events.send(ChatEvent::Status("model rejected tools — retrying without them".into()));
                use_tools = false;
                if let Some(obj) = body.as_object_mut() { obj.remove("tools"); obj.remove("tool_choice"); }
                result = complete(&base, &req.api_key, &body, &events, &cancel).await;
            }
        }
        let comp = match result {
            Ok(c) => c,
            Err(e) => {
                state.ui.track("error", format!("chat: {}", crate::gui_truncate(&e, 160)));
                finish(appended, prompt_tokens, completion_tokens, steps, Some(e));
                return;
            }
        };
        prompt_tokens += comp.prompt_tokens;
        completion_tokens += comp.completion_tokens;
        let calls: Vec<ToolCallAcc> = comp.tool_calls.into_iter().filter(|c| !c.name.is_empty()).collect();

        // An empty reply must never look like "nothing happened": say why.
        if calls.is_empty() && comp.text.trim().is_empty() {
            let fr = if comp.finish_reason.is_empty() { "none".to_string() } else { comp.finish_reason.clone() };
            let why = if !comp.reasoning.trim().is_empty() {
                " — it only produced reasoning (see the thinking block). Ask again, or pick a non-reasoning model."
            } else if fr == "length" {
                " — the output limit was hit before any text; raise max tokens on the provider or ask for a shorter answer."
            } else if fr == "content_filter" {
                " — the provider's content filter blocked it."
            } else {
                " — try again, or pick another model."
            };
            let msg = format!("The model returned an empty reply (finish_reason: {fr}){why}");
            state.ui.track("error", format!("chat: {}", crate::gui_truncate(&msg, 160)));
            finish(appended, prompt_tokens, completion_tokens, steps, Some(msg));
            return;
        }

        // Record the assistant message exactly as the API expects it back.
        let content = if comp.text.is_empty() { Value::Null } else { Value::String(comp.text.clone()) };
        let mut assistant = json!({"role": "assistant", "content": content});
        if !calls.is_empty() {
            let tc: Vec<Value> = calls.iter().enumerate().map(|(i, c)| {
                let id = if c.id.is_empty() { format!("call_{}_{}", steps, i) } else { c.id.clone() };
                let arguments = if c.arguments.trim().is_empty() { "{}".to_string() } else { c.arguments.clone() };
                json!({"id": id, "type": "function", "function": {"name": c.name, "arguments": arguments}})
            }).collect();
            assistant["tool_calls"] = Value::Array(tc);
        }
        messages.push(assistant.clone());
        appended.push(assistant.clone());

        if calls.is_empty() {
            state.ui.track("chat", format!("turn done · {steps} step(s) · {} ms", started.elapsed().as_millis()));
            finish(appended, prompt_tokens, completion_tokens, steps, None);
            return;
        }

        // Execute every requested tool in order, then loop back to the model.
        let ids: Vec<String> = assistant["tool_calls"].as_array().map(|a| a.iter().map(|c| c["id"].as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
        let mut image_parts: Vec<Value> = Vec::new();
        for (i, call) in calls.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                // Keep the history valid: every tool_call needs a tool message.
                let tool_msg = json!({"role": "tool", "tool_call_id": ids[i], "content": "[cancelled by the user]"});
                messages.push(tool_msg.clone());
                appended.push(tool_msg);
                continue;
            }
            let id = ids[i].clone();
            let (engine, real) = by_wire.get(&call.name).cloned().unwrap_or(("roblox", call.name.clone()));
            let args = match parse_args(&call.arguments) {
                Ok(a) => a,
                Err(e) => {
                    let _ = events.send(ChatEvent::ToolStart { id: id.clone(), name: real.clone(), args: Value::String(call.arguments.clone()) });
                    let text = format!("ERROR: {e}");
                    let _ = events.send(ChatEvent::ToolDone { id: id.clone(), name: real.clone(), ok: false, text: text.clone(), images: Vec::new(), elapsed_ms: 0 });
                    let tool_msg = json!({"role": "tool", "tool_call_id": id, "content": text});
                    messages.push(tool_msg.clone());
                    appended.push(tool_msg);
                    continue;
                }
            };
            // 1.69: answer a call that misses required parameters instantly WITH
            // the schema, instead of a bridge round trip that comes back as an
            // opaque MCP / Luau error.
            if let Some(schema) = schema_by_wire.get(&call.name) {
                let missing = missing_required(schema, &args);
                if !missing.is_empty() {
                    let text = format!("ERROR MISSING_PARAMS: '{real}' needs {} — schema: {}. Fix the call and retry.", missing.join(", "), schema_line(&call.name, schema));
                    let _ = events.send(ChatEvent::ToolStart { id: id.clone(), name: real.clone(), args: args.clone() });
                    let _ = events.send(ChatEvent::ToolDone { id: id.clone(), name: real.clone(), ok: false, text: text.clone(), images: Vec::new(), elapsed_ms: 0 });
                    state.ui.track("chat", format!("{real} not run: missing {}", missing.join(", ")));
                    let tool_msg = json!({"role": "tool", "tool_call_id": id, "content": text});
                    messages.push(tool_msg.clone());
                    appended.push(tool_msg);
                    continue;
                }
            }
            let _ = events.send(ChatEvent::Status(format!("step {steps}/{max_steps} · running {real}")));
            let _ = events.send(ChatEvent::ToolStart { id: id.clone(), name: real.clone(), args: args.clone() });
            let fail_key = format!("{real}\n{}", args); // 1.69: taken before `args` moves into the executor
            let t0 = Instant::now();
            let outcome = if !by_wire.contains_key(&call.name) {
                Err(anyhow::anyhow!("unknown tool '{}' — only the advertised tools exist", call.name))
            } else if is_guarded(&real) {
                let _ = events.send(ChatEvent::Status(format!("step {steps}/{max_steps} · waiting for your Allow / Deny on {real}")));
                match await_approval(&events, &cancel, &real, &args).await {
                    Ok(()) => execute(&state, engine, &real, args).await,
                    Err(why) => { state.ui.track("chat", format!("{real} not run: approval missing")); Err(anyhow::anyhow!("{why}")) }
                }
            } else {
                execute(&state, engine, &real, args).await
            };
            let elapsed_ms = t0.elapsed().as_millis();
            let (ok, text, images) = match outcome {
                Ok(o) => {
                    let images: Vec<(String, String)> = o.images.iter().filter_map(|img| {
                        let data = img.get("data").and_then(|v| v.as_str())?.to_string();
                        let mime = img.get("mimeType").and_then(|v| v.as_str()).unwrap_or("image/png").to_string();
                        Some((mime, data))
                    }).collect();
                    state.ui.track("tool", format!("{real} ({engine}) · {elapsed_ms} ms · chat"));
                    (true, o.text, images)
                }
                Err(e) => {
                    state.ui.track("error", format!("{real} ({engine}) failed: {}", crate::gui_truncate(&e.to_string(), 140)));
                    (false, format!("{e:#}"), Vec::new())
                }
            };
            let _ = events.send(ChatEvent::ToolDone { id: id.clone(), name: real.clone(), ok, text: text.clone(), images: images.clone(), elapsed_ms });
            let mut content = if ok { text.clone() } else { format!("ERROR: {text}") };
            if content.trim().is_empty() { content = if ok { "(no output)".into() } else { "ERROR (no message)".into() }; }
            // 1.69: repeated-failure guard. The identical call failing again and
            // again is the classic dead loop; tell the model after the second
            // time, stop the turn after the fourth.
            if ok {
                last_fail_key.clear();
                last_fail_count = 0;
            } else {
                if fail_key == last_fail_key { last_fail_count += 1; } else { last_fail_key = fail_key; last_fail_count = 1; }
                if last_fail_count >= 2 {
                    content.push_str(&format!("\n[TotalScript: this exact call has now failed {last_fail_count} times in a row — change the arguments or the approach; do not repeat it verbatim.]"));
                }
                if last_fail_count >= 4 {
                    let tool_msg = json!({"role": "tool", "tool_call_id": id, "content": clamp_result(&content)});
                    messages.push(tool_msg.clone());
                    appended.push(tool_msg);
                    let note = format!("Stopped: {real} failed {last_fail_count} times with identical arguments. Last error: {}", crate::gui_truncate(&text, 200));
                    state.ui.track("error", format!("chat: {}", crate::gui_truncate(&note, 160)));
                    finish(appended, prompt_tokens, completion_tokens, steps, Some(note));
                    return;
                }
            }
            if !images.is_empty() {
                let where_ = if req.send_images { " in the next message" } else { " — shown to the user; image forwarding is off" };
                content.push_str(&format!("\n[{} image(s) attached{where_}]", images.len()));
                if req.send_images {
                    for (mime, data) in images.iter().take(2) {
                        image_parts.push(json!({"type": "image_url", "image_url": {"url": format!("data:{mime};base64,{data}")}}));
                    }
                }
            }
            let tool_msg = json!({"role": "tool", "tool_call_id": id, "content": clamp_result(&content)});
            messages.push(tool_msg.clone());
            appended.push(tool_msg);
        }
        if !image_parts.is_empty() {
            let mut parts = vec![json!({"type": "text", "text": "Screenshot(s) returned by the tool call(s) above."})];
            parts.extend(image_parts);
            let img_msg = json!({"role": "user", "content": parts});
            messages.push(img_msg.clone());
            appended.push(img_msg);
        }
        if cancel.load(Ordering::Relaxed) {
            finish(appended, prompt_tokens, completion_tokens, steps, Some("stopped".into()));
            return;
        }
    }
}

#[cfg(test)]
mod approval_tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn guarded_set_covers_shell_and_destructive_tools_only() {
        for t in ["run_command", "process_kill", "delete_path", "download_file", "open_path", "local/run_command"] { assert!(is_guarded(t), "{t}"); }
        for t in ["execute_luau", "write_file", "edit_file", "read_file", "screen_capture", "get_studio_state"] { assert!(!is_guarded(t), "{t}"); }
    }

    #[tokio::test]
    async fn approval_allow_deny_and_dismiss() {
        let cancel = Arc::new(AtomicBool::new(false));
        // allow
        let (tx, rx) = channel::<ChatEvent>();
        let waiter = tokio::spawn({ let tx = tx.clone(); let cancel = cancel.clone(); async move { await_approval(&tx, &cancel, "run_command", &json!({"command": "dir"})).await } });
        let ev = tokio::task::spawn_blocking(move || rx.recv().unwrap()).await.unwrap();
        match ev { ChatEvent::Approval { name, reply, .. } => { assert_eq!(name, "run_command"); reply.send(true).unwrap(); } _ => panic!("expected Approval") }
        assert!(waiter.await.unwrap().is_ok());
        // deny
        let (tx, rx) = channel::<ChatEvent>();
        let waiter = tokio::spawn({ let tx = tx.clone(); let cancel = cancel.clone(); async move { await_approval(&tx, &cancel, "delete_path", &json!({"path": "x"})).await } });
        let ev = tokio::task::spawn_blocking(move || rx.recv().unwrap()).await.unwrap();
        if let ChatEvent::Approval { reply, .. } = ev { reply.send(false).unwrap(); }
        let err = waiter.await.unwrap().unwrap_err();
        assert!(err.contains("DENIED"), "{err}");
        // dismissed (sender dropped without an answer)
        let (tx, rx) = channel::<ChatEvent>();
        let waiter = tokio::spawn({ let tx = tx.clone(); let cancel = cancel.clone(); async move { await_approval(&tx, &cancel, "open_path", &json!({})).await } });
        let ev = tokio::task::spawn_blocking(move || rx.recv().unwrap()).await.unwrap();
        drop(ev);
        let err = waiter.await.unwrap().unwrap_err();
        assert!(err.contains("dismissed"), "{err}");
        // window gone (receiver dropped before the request)
        let (tx, rx) = channel::<ChatEvent>();
        drop(rx);
        let err = await_approval(&tx, &cancel, "run_command", &json!({})).await.unwrap_err();
        assert!(err.contains("window"), "{err}");
    }

    #[tokio::test]
    async fn approval_respects_stop() {
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, rx) = channel::<ChatEvent>();
        let waiter = tokio::spawn({ let tx = tx.clone(); let cancel = cancel.clone(); async move { await_approval(&tx, &cancel, "run_command", &json!({})).await } });
        let _keep = tokio::task::spawn_blocking(move || rx.recv().unwrap()).await.unwrap();
        cancel.store(true, Ordering::Relaxed);
        let err = waiter.await.unwrap().unwrap_err();
        assert!(err.contains("stopped"), "{err}");
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    #[test]
    fn error_classes_separate_transient_from_permanent() {
        assert_eq!(classify_error("HTTP 429 — rate limited, wait a moment (retry-after 20s): slow down"), ErrClass::RateLimit);
        assert_eq!(classify_error("HTTP 503: service unavailable"), ErrClass::Server);
        assert_eq!(classify_error("HTTP 502 bad gateway"), ErrClass::Server);
        assert_eq!(classify_error("request failed: error sending request for url"), ErrClass::Network);
        assert_eq!(classify_error("HTTP 400: This model's maximum context length is 128000 tokens"), ErrClass::ContextLength);
        assert_eq!(classify_error("HTTP 400: Unsupported parameter: 'temperature' is not supported with this model"), ErrClass::UnsupportedParam);
        assert_eq!(classify_error("HTTP 401 — check the API key: invalid api key"), ErrClass::Permanent);
        assert_eq!(classify_error("HTTP 404 — wrong base URL or model id: model not found"), ErrClass::Permanent);
        assert_eq!(classify_error("stream error: connection reset"), ErrClass::Permanent, "mid-stream failures are never resent (tokens already shown)");
        assert_eq!(retry_after_secs("HTTP 429 (retry-after 20s): x"), Some(20));
        assert_eq!(retry_after_secs("HTTP 429: x"), None);
    }

    #[test]
    fn trim_history_drops_whole_exchanges_and_keeps_the_last_user_turn() {
        let mut m = vec![
            json!({"role": "system", "content": "s"}),
            json!({"role": "user", "content": "u1"}),
            json!({"role": "assistant", "content": null, "tool_calls": [{"id": "c1"}]}),
            json!({"role": "tool", "tool_call_id": "c1", "content": "r1"}),
            json!({"role": "assistant", "content": "a1"}),
            json!({"role": "user", "content": "u2"}),
            json!({"role": "assistant", "content": "a2"}),
            json!({"role": "user", "content": "u3"}),
        ];
        assert!(trim_history(&mut m));
        assert_eq!(m.len(), 4);
        assert_eq!(m[1]["content"], "u2");
        assert!(trim_history(&mut m));
        assert_eq!(m.len(), 2);
        assert_eq!(m[1]["content"], "u3");
        assert!(!trim_history(&mut m), "only the current exchange left");
        assert_eq!(m.len(), 2);
        let mut none: Vec<Value> = vec![json!({"role": "system", "content": "s"})];
        assert!(!trim_history(&mut none));
    }

    #[test]
    fn missing_required_ignores_studio_id_and_flags_empty_strings() {
        let schema = json!({"type": "object", "properties": {"code": {"type": "string"}, "datamodel_type": {"type": "string", "enum": ["Edit", "Client", "Server"]}, "studio_id": {"type": "string"}}, "required": ["code", "datamodel_type", "studio_id"]});
        assert_eq!(missing_required(&schema, &json!({"code": "print(1)", "datamodel_type": "Edit"})), Vec::<String>::new());
        assert_eq!(missing_required(&schema, &json!({"code": "  "})), vec!["code".to_string(), "datamodel_type".to_string()]);
        assert_eq!(missing_required(&json!({}), &json!({})), Vec::<String>::new());
        let line = schema_line("execute_luau", &schema);
        assert!(line.starts_with("execute_luau {"), "{line}");
        assert!(line.contains("code: string") && line.contains("datamodel_type: string ∈ {\"Edit\", \"Client\", \"Server\"}"), "{line}");
    }
}
