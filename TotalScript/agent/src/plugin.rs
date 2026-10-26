//! TotalScript Studio plugin hub.
//!
//! The Luau plugin in `plugin/TotalScript.lua` runs inside Roblox Studio and
//! long-polls this bridge for jobs. It gives TotalScript plugin-level APIs (CSG,
//! open-script, live script edits, import prompts, publish, insert by id, ribbon
//! tools, undo/redo, camera framing) and a faster `execute_luau` path than the
//! stdio MCP helper. Open Cloud calls (game passes / developer products) run
//! here in Rust with the user's API key, because Studio's HttpService refuses
//! every roblox.com domain.
//!
//! HTTP (loopback only, mounted by `run_server`):
//!   POST /api/plugin/hello    plugin announces itself (+ optional Open Cloud key)
//!   GET  /api/plugin/poll     long poll (~20 s) for the next job
//!   POST /api/plugin/result   job outcome
//!   GET  /api/plugin/status   connection + capability summary
//!   POST /api/plugin/config   {open_cloud_key}
use std::{
    collections::{HashMap, VecDeque},
    io::Cursor,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex, Notify};

use crate::{AppState, McpToolOutput};

/// Embedded copy of the Studio plugin; `install()` writes it into the local
/// plugins folder so a `cargo build` is the only step the user needs.
pub const PLUGIN_SOURCE: &str = include_str!("../../plugin/TotalScript.lua");
pub const PLUGIN_FILE: &str = "TotalScript.lua";
/// The plugin says hello every ~25 s and polls continuously; anything quieter
/// than this is a closed Studio or a paused worker.
const STALE_AFTER: Duration = Duration::from_secs(45);
const POLL_WAIT: Duration = Duration::from_secs(20);
const NOT_CONNECTED: &str = "the TotalScript Studio plugin is not connected. In Roblox Studio open Plugins → TotalScript and check the panel says 'connected to total-core' (the plugin file is installed by total-core into the local Plugins folder; restart Studio once after the first install and click Allow on the HTTP permission prompt).";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PluginInfo {
    pub client_id: String,
    pub version: String,
    pub place_name: String,
    pub place_id: u64,
    pub universe_id: u64,
    pub creator_id: u64,
    pub creator_type: String,
    pub user_id: u64,
    pub user_name: String,
    pub studio_version: String,
    pub is_published: bool,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub name: String,
    pub args: Value,
}

/// A job the plugin did not answer in time. `in_flight` tells the caller
/// whether Studio had already picked the job up (it may still be running —
/// re-running the same Luau elsewhere would duplicate its side effects) or
/// whether it was still waiting in the queue (safe to run another way).
#[derive(Debug, Clone)]
pub struct PluginTimeout {
    pub name: String,
    pub secs: u64,
    pub in_flight: bool,
}

impl std::fmt::Display for PluginTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.in_flight {
            write!(f, "the TotalScript Studio plugin picked up '{}' but did not finish it within {} s - it may still be running in Studio, so it was NOT re-run. Check the Output window before retrying (Studio busy, a modal dialog open, or an infinite loop in the code)", self.name, self.secs)
        } else {
            write!(f, "the TotalScript Studio plugin did not pick up '{}' within {} s (Studio busy, a modal dialog open, or the worker paused in the TotalScript panel)", self.name, self.secs)
        }
    }
}

impl std::error::Error for PluginTimeout {}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct JobResult {
    pub id: String,
    pub ok: bool,
    pub result: Value,
    pub error: Option<String>,
    /// `result` is already the final text (plugin_execute_luau), not JSON data.
    pub text: bool,
    pub elapsed_ms: u64,
}

pub struct Hub {
    info: Mutex<Option<(PluginInfo, Instant)>>,
    queue: Mutex<VecDeque<Job>>,
    wake: Notify,
    results: broadcast::Sender<JobResult>,
    key: Mutex<Option<String>>,
    seq: AtomicU64,
    installed: Mutex<Option<String>>,
}

impl Hub {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel::<JobResult>(64);
        Self {
            info: Mutex::new(None),
            queue: Mutex::new(VecDeque::new()),
            wake: Notify::new(),
            results: tx,
            key: Mutex::new(std::env::var("TOTAL_OPEN_CLOUD_KEY").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())),
            seq: AtomicU64::new(1),
            installed: Mutex::new(None),
        }
    }

    pub async fn connected(&self) -> bool {
        matches!(&*self.info.lock().await, Some((_, at)) if at.elapsed() < STALE_AFTER)
    }

    pub async fn info(&self) -> Option<PluginInfo> {
        self.info.lock().await.as_ref().filter(|(_, at)| at.elapsed() < STALE_AFTER).map(|(i, _)| i.clone())
    }

    async fn touch(&self) {
        if let Some(entry) = self.info.lock().await.as_mut() {
            entry.1 = Instant::now();
        }
    }

    pub async fn key(&self) -> Option<String> {
        self.key.lock().await.clone()
    }

    pub async fn set_key(&self, key: Option<String>) {
        *self.key.lock().await = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    }

    pub async fn set_installed(&self, path: Option<String>) {
        *self.installed.lock().await = path;
    }

    /// Queue a job for the plugin and wait for its result.
    pub async fn run(&self, name: &str, args: Value, timeout: Duration) -> anyhow::Result<JobResult> {
        if !self.connected().await {
            anyhow::bail!("{NOT_CONNECTED}");
        }
        let id = format!("job-{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let mut rx = self.results.subscribe();
        self.queue.lock().await.push_back(Job { id: id.clone(), name: name.to_string(), args });
        self.wake.notify_one();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Ok(res)) => {
                    if res.id == id {
                        return Ok(res);
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(_)) => anyhow::bail!("plugin result channel closed"),
                Err(_) => {
                    // Still queued → Studio never saw it; remove it so it cannot
                    // run later behind the caller's back. Already dequeued →
                    // it is (or was) running: report that instead of a plain
                    // timeout so callers never execute the same code twice.
                    let in_flight = {
                        let mut q = self.queue.lock().await;
                        let before = q.len();
                        q.retain(|j| j.id != id);
                        before == q.len()
                    };
                    return Err(anyhow::Error::new(PluginTimeout { name: name.to_string(), secs: timeout.as_secs(), in_flight }));
                }
            }
        }
    }
}

fn exec_via_plugin_enabled() -> bool {
    !matches!(std::env::var("TOTAL_PLUGIN_EXEC").as_deref(), Ok("0") | Ok("false") | Ok("off"))
}

fn num_u64(v: Option<&Value>) -> u64 {
    match v {
        Some(Value::Number(n)) => n.as_u64().or_else(|| n.as_f64().map(|f| if f > 0.0 { f as u64 } else { 0 })).unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}
fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

// ───────────────────────── HTTP handlers ─────────────────────────

pub async fn hello_handler(State(state): State<AppState>, Json(req): Json<Value>) -> impl IntoResponse {
    let info = PluginInfo {
        client_id: str_of(&req, "client_id"),
        version: str_of(&req, "version"),
        place_name: str_of(&req, "place_name"),
        place_id: num_u64(req.get("place_id")),
        universe_id: num_u64(req.get("universe_id")),
        creator_id: num_u64(req.get("creator_id")),
        creator_type: str_of(&req, "creator_type"),
        user_id: num_u64(req.get("user_id")),
        user_name: str_of(&req, "user_name"),
        studio_version: str_of(&req, "studio_version"),
        is_published: req.get("is_published").and_then(|v| v.as_bool()).unwrap_or(false),
        capabilities: req
            .get("capabilities")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
    };
    let fresh = {
        let mut guard = state.plugin.info.lock().await;
        let fresh = match &*guard {
            Some((old, at)) => old.client_id != info.client_id || at.elapsed() >= STALE_AFTER,
            None => true,
        };
        *guard = Some((info.clone(), Instant::now()));
        fresh
    };
    if let Some(k) = req.get("open_cloud_key").and_then(|v| v.as_str()).map(str::trim).filter(|k| !k.is_empty()) {
        state.plugin.set_key(Some(k.to_string())).await;
    }
    if fresh {
        state.ui.track(
            "studio",
            format!(
                "TotalScript Studio plugin {} connected · {} (place {}, universe {}, {} commands)",
                info.version, info.place_name, info.place_id, info.universe_id, info.capabilities.len()
            ),
        );
        tracing::info!("studio plugin connected: {:?}", info);
    }
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "key_set": state.plugin.key().await.is_some(),
        "exec_via_plugin": exec_via_plugin_enabled(),
        "client_id": info.client_id,
    }))
}

pub async fn poll_handler(State(state): State<AppState>, Query(_q): Query<HashMap<String, String>>) -> impl IntoResponse {
    state.plugin.touch().await;
    let deadline = tokio::time::Instant::now() + POLL_WAIT;
    loop {
        if let Some(job) = state.plugin.queue.lock().await.pop_front() {
            return Json(json!({ "ok": true, "job": job }));
        }
        if tokio::time::timeout_at(deadline, state.plugin.wake.notified()).await.is_err() {
            return Json(json!({ "ok": true, "job": Value::Null }));
        }
    }
}

pub async fn result_handler(State(state): State<AppState>, Json(res): Json<JobResult>) -> impl IntoResponse {
    state.plugin.touch().await;
    let _ = state.plugin.results.send(res);
    Json(json!({ "ok": true }))
}

pub async fn status_handler(State(state): State<AppState>) -> impl IntoResponse {
    Json(status_json(&state).await)
}

pub async fn config_handler(State(state): State<AppState>, Json(req): Json<Value>) -> impl IntoResponse {
    if let Some(v) = req.get("open_cloud_key") {
        state.plugin.set_key(v.as_str().map(|s| s.to_string())).await;
    }
    Json(json!({ "ok": true, "key_set": state.plugin.key().await.is_some() }))
}

pub async fn status_json(state: &AppState) -> Value {
    let info = state.plugin.info().await;
    json!({
        "connected": info.is_some(),
        "plugin": info,
        "exec_via_plugin": exec_via_plugin_enabled(),
        "open_cloud_key_set": state.plugin.key().await.is_some(),
        "installed_file": &*state.plugin.installed.lock().await,
        "queue": state.plugin.queue.lock().await.len(),
        "how_to_connect": NOT_CONNECTED,
    })
}

// ───────────────────────── tool catalogue ─────────────────────────

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": props, "required": required },
        "server": "roblox",
        "plugin": true,
    })
}

/// Commands the plugin executes inside Studio (name → timeout seconds).
const STUDIO_COMMANDS: &[(&str, u64)] = &[
    ("plugin_execute_luau", 60),
    ("csg_union", 120),
    ("csg_negate", 120),
    ("csg_separate", 120),
    ("open_script", 20),
    ("script_live_update", 30),
    ("studio_import_file", 600),
    ("studio_publish_selection", 600),
    ("studio_prompt_asset_id", 600),
    ("studio_insert_asset", 90),
    ("studio_place_info", 20),
    ("studio_select_tool", 20),
    ("studio_undo", 20),
    ("studio_redo", 20),
    ("studio_notify", 20),
    ("screenshot_frame", 20),
    ("gamepass_handler_create", 30),
    ("developer_product_handler_create", 30),
    // 1.24.0 — full Studio control
    ("studio_playtest", 30),
    ("studio_settings", 20),
    ("studio_selection", 30),
    ("studio_camera", 20),
    ("studio_script_editor", 30),
    ("studio_history", 20),
    ("studio_service_call", 120),
    ("studio_macro", 60),
    ("studio_save", 600),
    ("studio_output", 20),
    ("studio_test_run", 60),
    ("studio_mouse", 20),
    // 1.24.0 — other plugins
    ("plugins_list", 30),
    ("plugin_widget", 30),
    ("plugin_invoke", 120),
    ("plugin_module_call", 120),
    ("plugin_source_read", 30),
    // 1.24.0 — Eclipse Animator bridge
    ("eclipse_status", 30),
    ("eclipse_open", 30),
    ("eclipse_handoff", 60),
    ("eclipse_import", 120),
    ("eclipse_play", 30),
    // 1.45.0 — animation publishing
    ("animation_export", 60),
    ("animation_apply", 30),
];
const CLOUD_COMMANDS: &[&str] = &["cloud_gamepass_create", "cloud_gamepass_update", "cloud_gamepass_list", "cloud_product_create", "cloud_product_update", "cloud_product_list", "cloud_animation_publish"];

pub fn is_plugin_tool(name: &str) -> bool {
    let bare = name.rsplit('/').next().unwrap_or(name);
    bare == "studio_plugin_status" || STUDIO_COMMANDS.iter().any(|(n, _)| *n == bare) || CLOUD_COMMANDS.contains(&bare)
}

pub fn tools(connected: bool, key_set: bool) -> Vec<Value> {
    let mut v = vec![tool(
        "studio_plugin_status",
        "Is the TotalScript Studio plugin connected? Returns place/universe/user info, the plugin's command list, whether execute_luau is routed through it, and whether an Open Cloud key is set.",
        json!({}),
        &[],
    )];
    if connected {
        v.extend([
            tool("plugin_execute_luau", "Run Luau inside the TotalScript Studio plugin (plugin-level security: the `plugin` global, ScriptEditorService, StudioService are available; prints are captured; 60 s budget). execute_luau already routes here while the plugin is connected.", json!({"code": {"type": "string"}}), &["code"]),
            tool("csg_union", "Solid-model UNION of two or more BaseParts (or every part under the given paths) into a UnionOperation - the real Studio CSG, not a Luau fake. Omit paths to use the current selection.", json!({"paths": {"type": "array", "items": {"type": "string"}}, "name": {"type": "string"}}), &[]),
            tool("csg_negate", "Turn parts into NegateOperations (cutters); then csg_union them with the part they should carve to subtract.", json!({"paths": {"type": "array", "items": {"type": "string"}}, "path": {"type": "string"}}), &[]),
            tool("csg_separate", "Separate a UnionOperation back into its parts.", json!({"path": {"type": "string"}}), &[]),
            tool("open_script", "Open a script in the Studio script editor at a line (shows the user exactly what you changed).", json!({"path": {"type": "string"}, "line": {"type": "number"}}), &["path"]),
            tool("script_live_update", "Replace a script's source through ScriptEditorService so an editor tab that has it open updates live (plain Source writes are ignored by open tabs).", json!({"path": {"type": "string"}, "source": {"type": "string"}}), &["path", "source"]),
            tool("studio_import_file", "Open Studio's import dialog for the user: kind=fbx_rig (ImportFbxRig), fbx_animation (ImportFbxAnimation onto rig_path/selection) or file (any file; small text files are returned).", json!({"kind": {"type": "string", "enum": ["fbx_rig", "fbx_animation", "file"]}, "rig_path": {"type": "string"}, "r15": {"type": "boolean"}, "extensions": {"type": "array", "items": {"type": "string"}}}), &[]),
            tool("studio_publish_selection", "Open the Publish-to-Roblox dialog for the selected model (or paths) - the user confirms name/description.", json!({"paths": {"type": "array", "items": {"type": "string"}}}), &[]),
            tool("studio_prompt_asset_id", "Ask the user to pick one of their existing assets (Model, Decal, Audio...) and return its id.", json!({"asset_type": {"type": "string"}}), &[]),
            tool("studio_insert_asset", "Insert a free/owned asset by id (InsertService:LoadAsset) under parent (default Workspace).", json!({"asset_id": {"type": "number"}, "parent": {"type": "string"}}), &["asset_id"]),
            tool("studio_place_info", "Place name/id, universe id, creator, signed-in Studio user, Studio version, selection and active script.", json!({}), &[]),
            tool("studio_select_tool", "Select a ribbon tool: select | move | scale | rotate | transform | none.", json!({"tool": {"type": "string"}}), &["tool"]),
            tool("studio_undo", "Undo the last N Studio changes (ChangeHistoryService).", json!({"steps": {"type": "number"}}), &[]),
            tool("studio_redo", "Redo N Studio changes.", json!({"steps": {"type": "number"}}), &[]),
            tool("studio_notify", "Show a message in the TotalScript Studio panel and the Output window (kind=info|warn).", json!({"title": {"type": "string"}, "message": {"type": "string"}, "kind": {"type": "string"}}), &["title"]),
            tool("screenshot_frame", "Frame the Studio camera on a model/part (orbit yaw/pitch in degrees, distance as a multiple of its size, optional fov) and clear the selection outline, so the next total_screenshot {target:'studio'} is a deliberate hero shot.", json!({"path": {"type": "string"}, "yaw": {"type": "number"}, "pitch": {"type": "number"}, "distance": {"type": "number"}, "fov": {"type": "number"}, "hide_selection": {"type": "boolean"}}), &[]),
            tool("gamepass_handler_create", "Write the production server handler for a game pass id: UserOwnsGamePassAsync on join + PromptGamePassPurchaseFinished, with a benefit stub (speed | coins | tool | custom) and a ReplicatedStorage.Monetization marker. Use after gamepass_create.", json!({"gamepass_id": {"type": "number"}, "name": {"type": "string"}, "benefit": {"type": "string", "enum": ["speed", "coins", "tool", "custom"]}, "amount": {"type": "number"}, "tool_name": {"type": "string"}}), &["gamepass_id"]),
            tool("developer_product_handler_create", "Write an idempotent ProcessReceipt handler (DataStore receipt log) for a developer product id.", json!({"product_id": {"type": "number"}, "name": {"type": "string"}}), &["product_id"]),
            // ── 1.24.0 full Studio control ──
            tool("studio_playtest", "Control the Studio simulation: action=run (F8 Run in this DataModel; the plugin keeps working), pause, stop, state. Play Solo (F5) has no plugin API.", json!({"action": {"type": "string", "enum": ["state", "run", "pause", "stop"]}}), &["action"]),
            tool("studio_settings", "Read or write Studio settings(): category (Studio | Rendering | Physics | Network | Lua | Debug | UserGameSettings), name (e.g. Theme, QualityLevel, 'Auto-Save Enabled'); omit value to read. category=Studio with no name lists the available themes.", json!({"category": {"type": "string"}, "name": {"type": "string"}, "value": {}}), &[]),
            tool("studio_selection", "Drive the Studio selection: get | set | add | remove | clear (paths), or by_class / by_name under root (class_name, name_pattern, limit).", json!({"action": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}, "root": {"type": "string"}, "class_name": {"type": "string"}, "name_pattern": {"type": "string"}, "limit": {"type": "number"}}), &["action"]),
            tool("studio_camera", "Studio camera: get | set {position, look_at | cframe, fov} | look_at {path | position} | focus {path, yaw, pitch, distance} | fov {fov}.", json!({"action": {"type": "string"}, "position": {"type": "array", "items": {"type": "number"}}, "look_at": {"type": "array", "items": {"type": "number"}}, "cframe": {"type": "array", "items": {"type": "number"}}, "path": {"type": "string"}, "fov": {"type": "number"}, "yaw": {"type": "number"}, "pitch": {"type": "number"}, "distance": {"type": "number"}}), &["action"]),
            tool("studio_script_editor", "The script editor itself (ScriptEditorService documents): list open tabs | open {path, line} | close | text {start_line, end_line} | find {query} | cursor {line, char} | insert {line, text} | replace_range {start_line, start_char, end_line, end_char, text} - edits land in the open tab live and are undoable.", json!({"action": {"type": "string"}, "path": {"type": "string"}, "line": {"type": "number"}, "char": {"type": "number"}, "text": {"type": "string"}, "query": {"type": "string"}, "start_line": {"type": "number"}, "start_char": {"type": "number"}, "end_line": {"type": "number"}, "end_char": {"type": "number"}, "max_chars": {"type": "number"}}), &["action"]),
            tool("studio_history", "ChangeHistoryService: status (can_undo / can_redo) | waypoint {label} | undo | redo {steps} | enable | disable.", json!({"action": {"type": "string"}, "label": {"type": "string"}, "steps": {"type": "number"}}), &["action"]),
            tool("studio_service_call", "Call ANY method or read/write ANY property of a service, instance, `plugin` or `settings` with plugin security - the escape hatch for every Studio API that has no dedicated command. args are JSON (strings 'Enum.X.Y' and instance paths are resolved; {__type:'Vector3'|'CFrame'|'Color3'|'UDim2', value:[…]} builds datatypes). Example: {service:'StudioService', method:'PromptImportFile'} or {service:'Lighting', property:'ClockTime', value:14}.", json!({"service": {"type": "string"}, "method": {"type": "string"}, "args": {"type": "array"}, "property": {"type": "string"}, "value": {}}), &["service"]),
            tool("studio_macro", "Persistent TotalScript toolbar buttons that run Luau in plugin context: create {name, code, tooltip} | run {name} | remove {name} | list. Give the user one-click tools (align, rename, export …) that survive Studio restarts.", json!({"action": {"type": "string"}, "name": {"type": "string"}, "code": {"type": "string"}, "tooltip": {"type": "string"}, "icon": {"type": "string"}}), &[]),
            tool("studio_save", "Save / publish dialogs: selection_to_roblox (publish the selection as a model/animation asset) | prompt_save_selection {name} (save selection to an .rbxm file). The place itself cannot be saved by a plugin - tell the user Ctrl+S.", json!({"action": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}, "name": {"type": "string"}}), &["action"]),
            tool("studio_output", "Last N Output window messages from inside Studio (level=error|warning|info|output) - instant, no MCP round trip.", json!({"count": {"type": "number"}, "level": {"type": "string"}}), &[]),
            tool("studio_test_run", "Run TestService (TestService:Run) and return the messages it produced.", json!({"wait": {"type": "number"}}), &[]),
            tool("studio_mouse", "Viewport ray under the user's mouse (or the viewport centre / given viewport_x, viewport_y): hit instance, position, normal, material - 'what is the user pointing at'.", json!({"action": {"type": "string"}, "viewport_x": {"type": "number"}, "viewport_y": {"type": "number"}, "distance": {"type": "number"}}), &[]),
            // ── 1.24.0 other plugins ──
            tool("plugins_list", "Discover other Studio plugins and how TotalScript can use them: known plugins detected (Eclipse Animator, Moon Animator, Roblox Animation Editor, F3X, Rojo, Tag Editor …) with evidence, commands registered on the TotalScript bus (shared.TotalScript.register), every plugin widget (name/title/enabled/buttons), save folders / exported modules, PluginDebugService entries and shared/_G APIs.", json!({}), &[]),
            tool("plugin_widget", "Another plugin's panel: info | show | hide | toggle | tree {depth, limit} (read its UI: labels, buttons, textboxes) | find {text} | click {text} (reports the button - Studio does not let plugins press another plugin's buttons, the user must).", json!({"name": {"type": "string"}, "action": {"type": "string"}, "text": {"type": "string"}, "depth": {"type": "number"}, "limit": {"type": "number"}}), &["name"]),
            tool("plugin_invoke", "Use another plugin's API: plugin = a name registered on the TotalScript bus, a shared.X / _G.X table, or the path of a BindableFunction / ModuleScript it exposes; command = the function; args = JSON array or object.", json!({"plugin": {"type": "string"}, "command": {"type": "string"}, "args": {}}), &["plugin", "command"]),
            tool("plugin_module_call", "require a ModuleScript (e.g. one a plugin installed or exported) and list its keys, or call method with args.", json!({"path": {"type": "string"}, "method": {"type": "string"}, "args": {}}), &["path"]),
            tool("plugin_source_read", "Read another plugin's scripts through PluginDebugService (needs Studio Settings → Plugin Debugging Enabled): omit script to list them, pass script to read it (offset, max_chars). Learn a plugin's real API before plugin_invoke.", json!({"plugin": {"type": "string"}, "script": {"type": "string"}, "offset": {"type": "number"}, "max_chars": {"type": "number"}}), &[]),
            // ── 1.24.0 Eclipse Animator ──
            tool("eclipse_status", "Is Eclipse Animator (riftkuro's animation plugin, Creator Store 86116556258301) installed in this Studio? Returns widgets, version, its saves / exported modules in the place, bus registration and the TotalScript ⇄ Eclipse workflow.", json!({}), &[]),
            tool("eclipse_open", "Select the rig and open the Eclipse Animator panel so the user can animate it there.", json!({"rig_path": {"type": "string"}}), &[]),
            tool("eclipse_handoff", "TotalScript → Eclipse: copy an AnimLib animation (animation name) or any KeyframeSequence (path) into <rig>.AnimSaves + ServerStorage.TotalScriptAnimations, select the rig and open Eclipse - import it from Eclipse's library/import menu.", json!({"animation": {"type": "string"}, "path": {"type": "string"}, "rig_path": {"type": "string"}, "name": {"type": "string"}}), &[]),
            tool("eclipse_import", "Eclipse → TotalScript: convert an Eclipse save / export (KeyframeSequence, folder, Module Exporter ModuleScript, or Animation asset) into a KeyframeSequence in ServerStorage.RobloxScript.AnimLib (+ <rig>.AnimSaves) so animation_open / animation_preview / animation_retime / animation_mirror work on it. fps overrides frame-based tables; overwrite replaces an existing name.", json!({"path": {"type": "string"}, "rig_path": {"type": "string"}, "name": {"type": "string"}, "fps": {"type": "number"}, "overwrite": {"type": "boolean"}}), &["path"]),
            tool("eclipse_play", "Preview a KeyframeSequence / Animation (path) or AnimLib clip (animation) on the rig in edit mode (Animator:StepAnimations): loop, speed, duration; action=stop ends it. Pair with total_screenshot.", json!({"path": {"type": "string"}, "animation": {"type": "string"}, "rig_path": {"type": "string"}, "loop": {"type": "boolean"}, "speed": {"type": "number"}, "duration": {"type": "number"}, "action": {"type": "string"}}), &[]),
            // ── 1.45.0 animation publishing ──
            tool("animation_export", "Serialise a KeyframeSequence (path, or animation = AnimLib / AnimSaves name, or the Explorer selection) to .rbxmx XML plus creator ids, ready for upload. Used by animation_publish.", json!({"path": {"type": "string"}, "animation": {"type": "string"}, "rig_path": {"type": "string"}}), &[]),
            tool("animation_apply", "After an upload: create / update ReplicatedStorage.Animations.<name> (Animation with AnimationId rbxassetid://asset_id), tag the source KeyframeSequence, optionally copy it under rig_path.Animations.", json!({"asset_id": {"type": "number"}, "name": {"type": "string"}, "path": {"type": "string"}, "parent": {"type": "string"}, "rig_path": {"type": "string"}}), &["asset_id"]),
        ]);
    }
    if key_set {
        v.extend([
            tool("cloud_gamepass_create", "Create a GAME PASS on the published universe through Open Cloud (total-core, API key from the TotalScript Studio panel): name, description, optional Robux price (sets it for sale), optional icon_path (PNG/JPG on this PC; a generated icon is used otherwise). Returns the game pass id.", json!({"name": {"type": "string"}, "description": {"type": "string"}, "price": {"type": "number"}, "icon_path": {"type": "string"}, "universe_id": {"type": "number"}}), &["name"]),
            tool("cloud_gamepass_update", "Update a game pass: name, description, price / for_sale (Open Cloud).", json!({"gamepass_id": {"type": "number"}, "name": {"type": "string"}, "description": {"type": "string"}, "price": {"type": "number"}, "for_sale": {"type": "boolean"}}), &["gamepass_id"]),
            tool("cloud_gamepass_list", "List the universe's game passes (id, name, price).", json!({"universe_id": {"type": "number"}}), &[]),
            tool("cloud_product_create", "Create a DEVELOPER PRODUCT on the universe through Open Cloud: name, description, price in Robux. Returns the product id.", json!({"name": {"type": "string"}, "description": {"type": "string"}, "price": {"type": "number"}, "universe_id": {"type": "number"}}), &["name", "price"]),
            tool("cloud_product_update", "Update a developer product: name, description, price / for_sale, icon_path (Open Cloud).", json!({"product_id": {"type": "number"}, "name": {"type": "string"}, "description": {"type": "string"}, "price": {"type": "number"}, "for_sale": {"type": "boolean"}, "icon_path": {"type": "string"}, "universe_id": {"type": "number"}}), &["product_id"]),
            tool("cloud_product_list", "List the universe's developer products (Open Cloud).", json!({"universe_id": {"type": "number"}}), &[]),
            tool("cloud_animation_publish", "Upload a KeyframeSequence (the .rbxmx from animation_export) as a real Animation asset through Open Cloud (asset:write). Returns asset_id / rbxassetid://. Prefer the animation_publish command, which runs export → upload → animation_apply.", json!({"xml": {"type": "string"}, "name": {"type": "string"}, "description": {"type": "string"}, "creator_type": {"type": "string"}, "creator_id": {"type": "number"}, "user_id": {"type": "number"}}), &["xml"]),
        ]);
    }
    v
}

// ───────────────────────── dispatch ─────────────────────────

fn text_out(text: String) -> McpToolOutput {
    McpToolOutput { text, images: Vec::new() }
}

pub fn render(res: JobResult, name: &str) -> anyhow::Result<McpToolOutput> {
    if !res.ok {
        anyhow::bail!("{}", res.error.unwrap_or_else(|| format!("{name} failed in the Studio plugin")));
    }
    let text = if res.text {
        match &res.result {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    } else {
        serde_json::to_string_pretty(&res.result).unwrap_or_else(|_| res.result.to_string())
    };
    Ok(text_out(text))
}

/// `execute_luau` fast path: run in the plugin when it is connected and the
/// call targets the Edit DataModel. `Ok(None)` means "use the MCP helper".
pub async fn try_execute_luau(state: &AppState, args: &Value) -> Option<anyhow::Result<McpToolOutput>> {
    if !exec_via_plugin_enabled() || !state.plugin.connected().await {
        return None;
    }
    let dm = args.get("datamodel_type").and_then(|v| v.as_str()).unwrap_or("Edit");
    if !dm.eq_ignore_ascii_case("edit") {
        return None;
    }
    match state.plugin.run("plugin_execute_luau", args.clone(), Duration::from_secs(60)).await {
        Ok(res) => Some(render(res, "execute_luau")),
        // Studio already took the job: it may still be running. Falling back
        // to the MCP helper here used to run the SAME Luau a second time
        // (duplicate models, double DataStore writes). Surface the timeout.
        Err(e) if matches!(e.downcast_ref::<PluginTimeout>(), Some(t) if t.in_flight) => {
            tracing::warn!("plugin execute_luau still running after its budget — not re-running it through the MCP helper");
            Some(Err(e))
        }
        Err(e) => {
            tracing::warn!("plugin execute_luau unavailable ({e:#}) — falling back to the MCP helper");
            None
        }
    }
}

pub async fn call(state: &AppState, name: &str, args: Value) -> anyhow::Result<McpToolOutput> {
    let bare = name.rsplit('/').next().unwrap_or(name).to_string();
    let args = if args.is_object() { args } else { json!({}) };
    match bare.as_str() {
        "studio_plugin_status" => Ok(text_out(serde_json::to_string_pretty(&status_json(state).await).unwrap_or_default())),
        "cloud_gamepass_create" => cloud::gamepass_create(state, &args).await.map(|v| text_out(v.to_string())),
        "cloud_gamepass_update" => cloud::gamepass_update(state, &args).await.map(|v| text_out(v.to_string())),
        "cloud_gamepass_list" => cloud::gamepass_list(state, &args).await.map(|v| text_out(v.to_string())),
        "cloud_product_create" => cloud::product_create(state, &args).await.map(|v| text_out(v.to_string())),
        "cloud_product_update" => cloud::product_update(state, &args).await.map(|v| text_out(v.to_string())),
        "cloud_product_list" => cloud::product_list(state, &args).await.map(|v| text_out(v.to_string())),
        "cloud_animation_publish" => cloud::animation_publish(state, &args).await.map(|v| text_out(v.to_string())),
        _ => {
            let secs = STUDIO_COMMANDS.iter().find(|(n, _)| *n == bare).map(|(_, s)| *s).unwrap_or(60);
            let res = state.plugin.run(&bare, args, Duration::from_secs(secs)).await?;
            render(res, &bare)
        }
    }
}

// ───────────────────────── install ─────────────────────────

fn plugins_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Roblox").join("Plugins"))
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Documents").join("Roblox").join("Plugins"))
    }
}

/// Copy the embedded plugin into Studio's local plugins folder (skipped with
/// `TOTAL_NO_PLUGIN_INSTALL=1` or when the platform has no such folder).
/// Returns the path and whether the file was (re)written.
pub fn install() -> anyhow::Result<Option<(PathBuf, bool)>> {
    if matches!(std::env::var("TOTAL_NO_PLUGIN_INSTALL").as_deref(), Ok("1") | Ok("true")) {
        return Ok(None);
    }
    let Some(dir) = plugins_dir() else { return Ok(None) };
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(PLUGIN_FILE);
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current == PLUGIN_SOURCE {
        return Ok(Some((path, false)));
    }
    std::fs::write(&path, PLUGIN_SOURCE)?;
    Ok(Some((path, true)))
}

// ───────────────────────── Open Cloud (game passes / products / animations) ─────────────────────────
//
// 1.45.0: Roblox retired the legacy monetization endpoints on 2026-04-23
// (POST game-passes/v1/game-passes, …/{id}/details, developer-products/v1
// …/developerproducts, games.roblox.com/v1/games/{id}/game-passes). Everything
// below uses the documented Open Cloud routes, which take the same `x-api-key`:
//   POST  /game-passes/v1/universes/{u}/game-passes                 (multipart)
//   PATCH /game-passes/v1/universes/{u}/game-passes/{id}            (multipart)
//   GET   /game-passes/v1/universes/{u}/game-passes/creator
//   POST  /developer-products/v2/universes/{u}/developer-products   (multipart)
//   PATCH /developer-products/v2/universes/{u}/developer-products/{id}
//   GET   /developer-products/v2/universes/{u}/developer-products/creator
//   POST  /assets/v1/assets  (assetType Animation, .rbxmx body) + GET /assets/v1/operations/{id}

mod cloud {
    use super::*;

    const APIS: &str = "https://apis.roblox.com";

    fn client() -> anyhow::Result<reqwest::Client> {
        Ok(reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent(concat!("TotalScript total-core/", env!("CARGO_PKG_VERSION")))
            .build()?)
    }

    async fn key(state: &AppState) -> anyhow::Result<String> {
        state.plugin.key().await.ok_or_else(|| anyhow::anyhow!(
            "no Open Cloud API key. Create one at https://create.roblox.com/dashboard/credentials (add this experience with game-pass:write, developer-product:write and, for animations, asset:write), paste it in Studio → Plugins → TotalScript → Open Cloud API key → Save, or start total-core with TOTAL_OPEN_CLOUD_KEY=… . Without a key, gamepass_create / developer_product_create / animation_publish still work through your roblox.com browser session."
        ))
    }

    async fn universe(state: &AppState, args: &Value) -> anyhow::Result<u64> {
        let explicit = num_u64(args.get("universe_id")).max(num_u64(args.get("universeId")));
        if explicit > 0 {
            return Ok(explicit);
        }
        if let Some(info) = state.plugin.info().await {
            if info.universe_id > 0 {
                return Ok(info.universe_id);
            }
            anyhow::bail!("this place is not published yet (universe id 0) - File → Publish to Roblox first, or pass universe_id");
        }
        anyhow::bail!("pass universe_id (the Studio plugin is not connected, so the universe cannot be read from the open place)");
    }

    fn dashboard(universe: u64, what: &str) -> String {
        format!("https://create.roblox.com/dashboard/creations/experiences/{universe}/monetization/{}", if what == "game pass" { "passes" } else { "developer-products" })
    }

    fn explain(status: reqwest::StatusCode, body: &str, what: &str, universe: u64) -> anyhow::Error {
        let hint = match status.as_u16() {
            401 => "the Open Cloud key was rejected (wrong key, expired, or IP-restricted)",
            403 => "the key lacks permission - in Creator Dashboard → Open Cloud → API keys add this experience with the write scope for this feature (game-pass:write / developer-product:write / asset:write)",
            404 => "endpoint or universe not found - publish the place and check the universe id",
            429 => "rate limited by Roblox - wait a minute and retry",
            _ => "the request failed",
        };
        let snippet: String = body.chars().take(300).collect();
        let fallback = if universe > 0 { format!(" Manual fallback: {}", dashboard(universe, what)) } else { String::new() };
        anyhow::anyhow!("could not change the {what}: HTTP {status} - {hint}. Response: {snippet}.{fallback}")
    }

    fn mp_field(body: &mut Vec<u8>, b: &str, name: &str, value: &str) {
        body.extend_from_slice(format!("--{b}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    fn mp_file(body: &mut Vec<u8>, b: &str, name: &str, filename: &str, mime: &str, data: &[u8]) {
        body.extend_from_slice(format!("--{b}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    fn mp_end(body: &mut Vec<u8>, b: &str) {
        body.extend_from_slice(format!("--{b}--\r\n").as_bytes());
    }
    fn boundary() -> String {
        format!("----TotalScriptBoundary{}", chrono::Utc::now().timestamp_millis())
    }

    /// 512×512 PNG placeholder icon (gold gradient disc on a dark field) so a
    /// pass can be created without the user drawing one first.
    fn placeholder_icon() -> anyhow::Result<Vec<u8>> {
        let size = 512u32;
        let img = image::RgbaImage::from_fn(size, size, |x, y| {
            let fx = x as f32 / size as f32;
            let fy = y as f32 / size as f32;
            let dx = fx - 0.5;
            let dy = fy - 0.5;
            let d = (dx * dx + dy * dy).sqrt();
            if d < 0.36 {
                let t = (d / 0.36).powf(1.4);
                let r = (255.0 - 40.0 * t) as u8;
                let g = (200.0 - 90.0 * t) as u8;
                let b = (60.0 - 40.0 * t).max(0.0) as u8;
                image::Rgba([r, g, b, 255])
            } else if d < 0.40 {
                image::Rgba([40, 34, 18, 255])
            } else {
                let v = (28.0 + 16.0 * fy) as u8;
                image::Rgba([v, v + 2, v + 8, 255])
            }
        });
        let mut buf = Vec::new();
        img.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)?;
        Ok(buf)
    }

    /// Icon bytes from `icon_path` (a PNG/JPG on this PC) or `icon_data_url`
    /// (base64 data URL from the browser / Paint), else the placeholder.
    fn icon_bytes(args: &Value, allow_placeholder: bool) -> anyhow::Result<Option<(Vec<u8>, &'static str, String)>> {
        if let Some(p) = args.get("icon_path").and_then(|v| v.as_str()).map(str::trim).filter(|p| !p.is_empty()) {
            let data = std::fs::read(p).map_err(|e| anyhow::anyhow!("icon_path {p}: {e}"))?;
            let lower = p.to_lowercase();
            let mime = if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { "image/jpeg" } else { "image/png" };
            let name = std::path::Path::new(p).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "icon.png".into());
            return Ok(Some((data, mime, name)));
        }
        if let Some(d) = args.get("icon_data_url").and_then(|v| v.as_str()).map(str::trim).filter(|d| d.starts_with("data:image/")) {
            if let Some((head, b64)) = d.split_once(",") {
                use base64::Engine as _;
                if let Ok(data) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                    let mime = if head.contains("image/jpeg") { "image/jpeg" } else { "image/png" };
                    let name = if mime == "image/jpeg" { "icon.jpg" } else { "icon.png" };
                    return Ok(Some((data, mime, name.to_string())));
                }
            }
            anyhow::bail!("icon_data_url is not a decodable base64 image data URL");
        }
        if allow_placeholder {
            return Ok(Some((placeholder_icon()?, "image/png", "icon.png".into())));
        }
        Ok(None)
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({ "raw": text }))
    }

    async fn send_multipart(method: reqwest::Method, url: String, key: &str, b: &str, body: Vec<u8>) -> anyhow::Result<(reqwest::StatusCode, String)> {
        let resp = client()?
            .request(method, url)
            .header("x-api-key", key)
            .header("content-type", format!("multipart/form-data; boundary={b}"))
            .body(body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Ok((status, text))
    }

    /// Price in the v2 config payloads lives under `priceInformation`.
    fn price_of(v: &Value) -> Value {
        if let Some(p) = v.get("price").filter(|p| !p.is_null()) {
            return p.clone();
        }
        if let Some(pi) = v.get("priceInformation") {
            for k in ["defaultPriceInRobux", "price", "priceInRobux"] {
                if let Some(p) = pi.get(k).filter(|p| !p.is_null()) {
                    return p.clone();
                }
            }
        }
        Value::Null
    }

    // ── game passes ──

    pub async fn gamepass_create(state: &AppState, args: &Value) -> anyhow::Result<Value> {
        let key = key(state).await?;
        let universe = universe(state, args).await?;
        let name = str_of(args, "name");
        if name.trim().is_empty() {
            anyhow::bail!("name is required");
        }
        let description = { let d = str_of(args, "description"); if d.is_empty() { name.clone() } else { d } };
        let price = num_u64(args.get("price")).max(num_u64(args.get("priceInRobux")));
        let for_sale = args.get("for_sale").and_then(|v| v.as_bool()).unwrap_or(price > 0);
        let b = boundary();
        let mut body = Vec::new();
        mp_field(&mut body, &b, "name", name.trim());
        mp_field(&mut body, &b, "description", description.trim());
        if price > 0 {
            mp_field(&mut body, &b, "price", &price.to_string());
        }
        mp_field(&mut body, &b, "isForSale", if for_sale && price > 0 { "true" } else { "false" });
        if let Some((icon, mime, filename)) = icon_bytes(args, true)? {
            mp_file(&mut body, &b, "imageFile", &filename, mime, &icon);
        }
        mp_end(&mut body, &b);
        let (status, text) = send_multipart(reqwest::Method::POST, format!("{APIS}/game-passes/v1/universes/{universe}/game-passes"), &key, &b, body).await?;
        if !status.is_success() {
            return Err(explain(status, &text, "game pass", universe));
        }
        let created = parse(&text);
        let id = num_u64(created.get("gamePassId")).max(num_u64(created.get("id")));
        Ok(json!({
            "ok": true,
            "gamepass_id": id,
            "universe_id": universe,
            "name": name.trim(),
            "price": if price > 0 { json!(price) } else { Value::Null },
            "for_sale": for_sale && price > 0,
            "response": created,
            "dashboard": dashboard(universe, "game pass"),
            "next": "gamepass_handler_create {gamepass_id} writes the server handler; the client prompts with MarketplaceService:PromptGamePassPurchase(player, id)",
        }))
    }

    pub async fn gamepass_update(state: &AppState, args: &Value) -> anyhow::Result<Value> {
        let key = key(state).await?;
        let universe = universe(state, args).await?;
        let id = num_u64(args.get("gamepass_id")).max(num_u64(args.get("id")));
        if id == 0 {
            anyhow::bail!("gamepass_id is required");
        }
        let b = boundary();
        let mut body = Vec::new();
        let mut fields = 0;
        if let Some(n) = args.get("name").and_then(|v| v.as_str()).filter(|n| !n.trim().is_empty()) { mp_field(&mut body, &b, "name", n.trim()); fields += 1; }
        if let Some(d) = args.get("description").and_then(|v| v.as_str()) { mp_field(&mut body, &b, "description", d); fields += 1; }
        let price = args.get("price").map(|p| num_u64(Some(p)));
        if let Some(p) = price { mp_field(&mut body, &b, "price", &p.to_string()); fields += 1; }
        let for_sale = args.get("for_sale").and_then(|v| v.as_bool()).or(match price { Some(p) if p > 0 => Some(true), _ => None });
        if let Some(s) = for_sale { mp_field(&mut body, &b, "isForSale", if s { "true" } else { "false" }); fields += 1; }
        if let Some((icon, mime, filename)) = icon_bytes(args, false)? { mp_file(&mut body, &b, "imageFile", &filename, mime, &icon); fields += 1; }
        if fields == 0 {
            anyhow::bail!("nothing to update - pass name, description, price, for_sale or icon_path");
        }
        mp_end(&mut body, &b);
        let (status, text) = send_multipart(reqwest::Method::PATCH, format!("{APIS}/game-passes/v1/universes/{universe}/game-passes/{id}"), &key, &b, body).await?;
        if !status.is_success() {
            return Err(explain(status, &text, "game pass", universe));
        }
        Ok(json!({ "ok": true, "gamepass_id": id, "universe_id": universe, "updated": fields, "response": if text.trim().is_empty() { json!({ "status": status.as_u16() }) } else { parse(&text) } }))
    }

    pub async fn gamepass_list(state: &AppState, args: &Value) -> anyhow::Result<Value> {
        let key = key(state).await?;
        let universe = universe(state, args).await?;
        let resp = client()?
            .get(format!("{APIS}/game-passes/v1/universes/{universe}/game-passes/creator?pageSize=100"))
            .header("x-api-key", &key)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(explain(status, &text, "game pass", universe));
        }
        let v = parse(&text);
        let passes: Vec<Value> = v.get("gamePasses").and_then(|d| d.as_array()).cloned().unwrap_or_default()
            .into_iter()
            .map(|p| json!({
                "id": p.get("gamePassId").cloned().unwrap_or(Value::Null),
                "name": p.get("name").cloned().unwrap_or(Value::Null),
                "price": price_of(&p),
                "for_sale": p.get("isForSale").cloned().unwrap_or(Value::Null),
            }))
            .collect();
        Ok(json!({ "ok": true, "universe_id": universe, "count": passes.len(), "game_passes": passes }))
    }

    // ── developer products ──

    pub async fn product_create(state: &AppState, args: &Value) -> anyhow::Result<Value> {
        let key = key(state).await?;
        let universe = universe(state, args).await?;
        let name = str_of(args, "name");
        if name.trim().is_empty() {
            anyhow::bail!("name is required");
        }
        let price = num_u64(args.get("price")).max(num_u64(args.get("priceInRobux")));
        if price == 0 {
            anyhow::bail!("price (Robux, >= 1) is required");
        }
        let description = { let d = str_of(args, "description"); if d.is_empty() { name.clone() } else { d } };
        let b = boundary();
        let mut body = Vec::new();
        mp_field(&mut body, &b, "name", name.trim());
        mp_field(&mut body, &b, "description", description.trim());
        mp_field(&mut body, &b, "price", &price.to_string());
        mp_field(&mut body, &b, "isForSale", if args.get("for_sale").and_then(|v| v.as_bool()).unwrap_or(true) { "true" } else { "false" });
        if let Some((icon, mime, filename)) = icon_bytes(args, false)? {
            mp_file(&mut body, &b, "imageFile", &filename, mime, &icon);
        }
        mp_end(&mut body, &b);
        let (status, text) = send_multipart(reqwest::Method::POST, format!("{APIS}/developer-products/v2/universes/{universe}/developer-products"), &key, &b, body).await?;
        if !status.is_success() {
            return Err(explain(status, &text, "developer product", universe));
        }
        let v = parse(&text);
        let id = num_u64(v.get("productId")).max(num_u64(v.get("id")));
        Ok(json!({
            "ok": true,
            "product_id": id,
            "universe_id": universe,
            "name": name.trim(),
            "price": price,
            "response": v,
            "dashboard": dashboard(universe, "developer product"),
            "next": "developer_product_handler_create {product_id} writes the ProcessReceipt handler",
        }))
    }

    pub async fn product_update(state: &AppState, args: &Value) -> anyhow::Result<Value> {
        let key = key(state).await?;
        let universe = universe(state, args).await?;
        let id = num_u64(args.get("product_id")).max(num_u64(args.get("id")));
        if id == 0 {
            anyhow::bail!("product_id is required");
        }
        let b = boundary();
        let mut body = Vec::new();
        let mut fields = 0;
        if let Some(n) = args.get("name").and_then(|v| v.as_str()).filter(|n| !n.trim().is_empty()) { mp_field(&mut body, &b, "name", n.trim()); fields += 1; }
        if let Some(d) = args.get("description").and_then(|v| v.as_str()) { mp_field(&mut body, &b, "description", d); fields += 1; }
        if let Some(p) = args.get("price").map(|p| num_u64(Some(p))).filter(|p| *p > 0) { mp_field(&mut body, &b, "price", &p.to_string()); fields += 1; }
        if let Some(s) = args.get("for_sale").and_then(|v| v.as_bool()) { mp_field(&mut body, &b, "isForSale", if s { "true" } else { "false" }); fields += 1; }
        if let Some((icon, mime, filename)) = icon_bytes(args, false)? { mp_file(&mut body, &b, "imageFile", &filename, mime, &icon); fields += 1; }
        if fields == 0 {
            anyhow::bail!("nothing to update - pass name, description, price, for_sale or icon_path");
        }
        mp_end(&mut body, &b);
        let (status, text) = send_multipart(reqwest::Method::PATCH, format!("{APIS}/developer-products/v2/universes/{universe}/developer-products/{id}"), &key, &b, body).await?;
        if !status.is_success() {
            return Err(explain(status, &text, "developer product", universe));
        }
        Ok(json!({ "ok": true, "product_id": id, "universe_id": universe, "updated": fields, "response": if text.trim().is_empty() { json!({ "status": status.as_u16() }) } else { parse(&text) } }))
    }

    pub async fn product_list(state: &AppState, args: &Value) -> anyhow::Result<Value> {
        let key = key(state).await?;
        let universe = universe(state, args).await?;
        let resp = client()?
            .get(format!("{APIS}/developer-products/v2/universes/{universe}/developer-products/creator?pageSize=100"))
            .header("x-api-key", &key)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(explain(status, &text, "developer product", universe));
        }
        let v = parse(&text);
        let products: Vec<Value> = v.get("developerProducts").and_then(|d| d.as_array()).cloned().unwrap_or_default()
            .into_iter()
            .map(|p| json!({
                "id": p.get("productId").cloned().unwrap_or(Value::Null),
                "name": p.get("name").cloned().unwrap_or(Value::Null),
                "price": price_of(&p),
                "for_sale": p.get("isForSale").cloned().unwrap_or(Value::Null),
            }))
            .collect();
        Ok(json!({ "ok": true, "universe_id": universe, "count": products.len(), "products": products }))
    }

    // ── animations ──

    /// Upload a KeyframeSequence (serialised to .rbxmx by the Studio plugin's
    /// animation_export) as an Animation asset. Returns the new asset id once
    /// the Open Cloud operation completes.
    pub async fn animation_publish(state: &AppState, args: &Value) -> anyhow::Result<Value> {
        let key = key(state).await?;
        let xml = str_of(args, "xml");
        if !xml.trim_start().starts_with("<roblox") || !xml.contains("class=\"KeyframeSequence\"") {
            anyhow::bail!("xml must be the .rbxmx of a KeyframeSequence (run animation_export in the Studio plugin first)");
        }
        if xml.len() > 4_000_000 {
            anyhow::bail!("animation is too large to upload ({} bytes) - split it or reduce keyframes", xml.len());
        }
        let name = { let n = str_of(args, "name"); if n.trim().is_empty() { "Animation".to_string() } else { n.trim().chars().take(50).collect() } };
        let description = { let d = str_of(args, "description"); if d.trim().is_empty() { name.clone() } else { d.trim().chars().take(1000).collect() } };
        let info = state.plugin.info().await;
        let creator_type = str_of(args, "creator_type").to_lowercase();
        let mut creator_id = num_u64(args.get("creator_id"));
        let is_group = creator_type.contains("group") && creator_id > 0;
        if !is_group {
            creator_id = num_u64(args.get("user_id")).max(creator_id);
            if creator_id == 0 {
                creator_id = info.as_ref().map(|i| i.user_id).unwrap_or(0);
            }
        }
        if creator_id == 0 {
            anyhow::bail!("creator unknown - pass user_id (or creator_type 'Group' + creator_id); the Studio plugin reports them in animation_export");
        }
        let creator = if is_group { json!({ "groupId": creator_id.to_string() }) } else { json!({ "userId": creator_id.to_string() }) };
        let request = json!({
            "assetType": "Animation",
            "displayName": name,
            "description": description,
            "creationContext": { "creator": creator },
        });
        let b = boundary();
        let mut body = Vec::new();
        mp_field(&mut body, &b, "request", &request.to_string());
        mp_file(&mut body, &b, "fileContent", "animation.rbxmx", "model/x-rbxm", xml.as_bytes());
        mp_end(&mut body, &b);
        let (status, text) = send_multipart(reqwest::Method::POST, format!("{APIS}/assets/v1/assets"), &key, &b, body).await?;
        if !status.is_success() {
            return Err(explain(status, &text, "animation upload", 0));
        }
        let op = parse(&text);
        let mut asset_id = num_u64(op.pointer("/response/assetId"));
        let op_path = op.get("path").and_then(|v| v.as_str()).map(str::to_string)
            .or_else(|| op.get("operationId").and_then(|v| v.as_str()).map(|id| format!("operations/{id}")));
        let mut last = op.clone();
        if asset_id == 0 {
            if let Some(path) = op_path.as_deref() {
                let url = format!("{APIS}/assets/v1/{path}");
                for _ in 0..30 {
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                    let resp = client()?.get(&url).header("x-api-key", &key).send().await?;
                    let st = resp.status();
                    let t = resp.text().await.unwrap_or_default();
                    if !st.is_success() {
                        continue;
                    }
                    last = parse(&t);
                    if last.get("done").and_then(|v| v.as_bool()).unwrap_or(false) {
                        asset_id = num_u64(last.pointer("/response/assetId"));
                        break;
                    }
                }
            }
        }
        if asset_id == 0 {
            if let Some(err) = last.get("error") {
                anyhow::bail!("Roblox rejected the animation: {err}");
            }
            anyhow::bail!("upload accepted but the asset id is not ready yet ({}). Check https://create.roblox.com/dashboard/creations?activeTab=Animation in a minute.", op_path.unwrap_or_default());
        }
        Ok(json!({
            "ok": true,
            "asset_id": asset_id,
            "animation_id": format!("rbxassetid://{asset_id}"),
            "name": name,
            "creator": if is_group { "group" } else { "user" },
            "creator_id": creator_id,
            "moderation": last.pointer("/response/moderationResult/moderationState").cloned().unwrap_or(Value::Null),
            "next": "animation_apply {asset_id, name} creates ReplicatedStorage.Animations.<name> with the AnimationId",
        }))
    }
}
