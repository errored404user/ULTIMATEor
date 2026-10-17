//! ORscript Studio plugin hub.
//!
//! The Luau plugin in `plugin/ORscript.lua` runs inside Roblox Studio and
//! long-polls this bridge for jobs. It gives ORscript plugin-level APIs (CSG,
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
pub const PLUGIN_SOURCE: &str = include_str!("../../plugin/ORscript.lua");
pub const PLUGIN_FILE: &str = "ORscript.lua";
/// The plugin says hello every ~25 s and polls continuously; anything quieter
/// than this is a closed Studio or a paused worker.
const STALE_AFTER: Duration = Duration::from_secs(45);
const POLL_WAIT: Duration = Duration::from_secs(20);
const NOT_CONNECTED: &str = "the ORscript Studio plugin is not connected. In Roblox Studio open Plugins → ORscript and check the panel says 'connected to or-core' (the plugin file is installed by or-core into the local Plugins folder; restart Studio once after the first install and click Allow on the HTTP permission prompt).";

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
            key: Mutex::new(std::env::var("OR_OPEN_CLOUD_KEY").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())),
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
                    self.queue.lock().await.retain(|j| j.id != id);
                    anyhow::bail!(
                        "the ORscript Studio plugin did not answer '{name}' within {} s (Studio busy, a modal dialog open, or the worker paused in the ORscript panel)",
                        timeout.as_secs()
                    );
                }
            }
        }
    }
}

fn exec_via_plugin_enabled() -> bool {
    !matches!(std::env::var("OR_PLUGIN_EXEC").as_deref(), Ok("0") | Ok("false") | Ok("off"))
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
                "ORscript Studio plugin {} connected · {} (place {}, universe {}, {} commands)",
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
];
const CLOUD_COMMANDS: &[&str] = &["cloud_gamepass_create", "cloud_gamepass_update", "cloud_gamepass_list", "cloud_product_create", "cloud_product_list"];

pub fn is_plugin_tool(name: &str) -> bool {
    let bare = name.rsplit('/').next().unwrap_or(name);
    bare == "studio_plugin_status" || STUDIO_COMMANDS.iter().any(|(n, _)| *n == bare) || CLOUD_COMMANDS.contains(&bare)
}

pub fn tools(connected: bool, key_set: bool) -> Vec<Value> {
    let mut v = vec![tool(
        "studio_plugin_status",
        "Is the ORscript Studio plugin connected? Returns place/universe/user info, the plugin's command list, whether execute_luau is routed through it, and whether an Open Cloud key is set.",
        json!({}),
        &[],
    )];
    if connected {
        v.extend([
            tool("plugin_execute_luau", "Run Luau inside the ORscript Studio plugin (plugin-level security: the `plugin` global, ScriptEditorService, StudioService are available; prints are captured; 60 s budget). execute_luau already routes here while the plugin is connected.", json!({"code": {"type": "string"}}), &["code"]),
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
            tool("studio_notify", "Show a message in the ORscript Studio panel and the Output window (kind=info|warn).", json!({"title": {"type": "string"}, "message": {"type": "string"}, "kind": {"type": "string"}}), &["title"]),
            tool("screenshot_frame", "Frame the Studio camera on a model/part (orbit yaw/pitch in degrees, distance as a multiple of its size, optional fov) and clear the selection outline, so the next or_screenshot {target:'studio'} is a deliberate hero shot.", json!({"path": {"type": "string"}, "yaw": {"type": "number"}, "pitch": {"type": "number"}, "distance": {"type": "number"}, "fov": {"type": "number"}, "hide_selection": {"type": "boolean"}}), &[]),
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
            tool("studio_macro", "Persistent ORscript toolbar buttons that run Luau in plugin context: create {name, code, tooltip} | run {name} | remove {name} | list. Give the user one-click tools (align, rename, export …) that survive Studio restarts.", json!({"action": {"type": "string"}, "name": {"type": "string"}, "code": {"type": "string"}, "tooltip": {"type": "string"}, "icon": {"type": "string"}}), &[]),
            tool("studio_save", "Save / publish dialogs: selection_to_roblox (publish the selection as a model/animation asset) | prompt_save_selection {name} (save selection to an .rbxm file). The place itself cannot be saved by a plugin - tell the user Ctrl+S.", json!({"action": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}, "name": {"type": "string"}}), &["action"]),
            tool("studio_output", "Last N Output window messages from inside Studio (level=error|warning|info|output) - instant, no MCP round trip.", json!({"count": {"type": "number"}, "level": {"type": "string"}}), &[]),
            tool("studio_test_run", "Run TestService (TestService:Run) and return the messages it produced.", json!({"wait": {"type": "number"}}), &[]),
            tool("studio_mouse", "Viewport ray under the user's mouse (or the viewport centre / given viewport_x, viewport_y): hit instance, position, normal, material - 'what is the user pointing at'.", json!({"action": {"type": "string"}, "viewport_x": {"type": "number"}, "viewport_y": {"type": "number"}, "distance": {"type": "number"}}), &[]),
            // ── 1.24.0 other plugins ──
            tool("plugins_list", "Discover other Studio plugins and how ORscript can use them: known plugins detected (Eclipse Animator, Moon Animator, Roblox Animation Editor, F3X, Rojo, Tag Editor …) with evidence, commands registered on the ORscript bus (shared.ORscript.register), every plugin widget (name/title/enabled/buttons), save folders / exported modules, PluginDebugService entries and shared/_G APIs.", json!({}), &[]),
            tool("plugin_widget", "Another plugin's panel: info | show | hide | toggle | tree {depth, limit} (read its UI: labels, buttons, textboxes) | find {text} | click {text} (reports the button - Studio does not let plugins press another plugin's buttons, the user must).", json!({"name": {"type": "string"}, "action": {"type": "string"}, "text": {"type": "string"}, "depth": {"type": "number"}, "limit": {"type": "number"}}), &["name"]),
            tool("plugin_invoke", "Use another plugin's API: plugin = a name registered on the ORscript bus, a shared.X / _G.X table, or the path of a BindableFunction / ModuleScript it exposes; command = the function; args = JSON array or object.", json!({"plugin": {"type": "string"}, "command": {"type": "string"}, "args": {}}), &["plugin", "command"]),
            tool("plugin_module_call", "require a ModuleScript (e.g. one a plugin installed or exported) and list its keys, or call method with args.", json!({"path": {"type": "string"}, "method": {"type": "string"}, "args": {}}), &["path"]),
            tool("plugin_source_read", "Read another plugin's scripts through PluginDebugService (needs Studio Settings → Plugin Debugging Enabled): omit script to list them, pass script to read it (offset, max_chars). Learn a plugin's real API before plugin_invoke.", json!({"plugin": {"type": "string"}, "script": {"type": "string"}, "offset": {"type": "number"}, "max_chars": {"type": "number"}}), &[]),
            // ── 1.24.0 Eclipse Animator ──
            tool("eclipse_status", "Is Eclipse Animator (riftkuro's animation plugin, Creator Store 86116556258301) installed in this Studio? Returns widgets, version, its saves / exported modules in the place, bus registration and the ORscript ⇄ Eclipse workflow.", json!({}), &[]),
            tool("eclipse_open", "Select the rig and open the Eclipse Animator panel so the user can animate it there.", json!({"rig_path": {"type": "string"}}), &[]),
            tool("eclipse_handoff", "ORscript → Eclipse: copy an AnimLib animation (animation name) or any KeyframeSequence (path) into <rig>.AnimSaves + ServerStorage.ORscriptAnimations, select the rig and open Eclipse - import it from Eclipse's library/import menu.", json!({"animation": {"type": "string"}, "path": {"type": "string"}, "rig_path": {"type": "string"}, "name": {"type": "string"}}), &[]),
            tool("eclipse_import", "Eclipse → ORscript: convert an Eclipse save / export (KeyframeSequence, folder, Module Exporter ModuleScript, or Animation asset) into a KeyframeSequence in ServerStorage.RobloxScript.AnimLib (+ <rig>.AnimSaves) so animation_open / animation_preview / animation_retime / animation_mirror work on it. fps overrides frame-based tables; overwrite replaces an existing name.", json!({"path": {"type": "string"}, "rig_path": {"type": "string"}, "name": {"type": "string"}, "fps": {"type": "number"}, "overwrite": {"type": "boolean"}}), &["path"]),
            tool("eclipse_play", "Preview a KeyframeSequence / Animation (path) or AnimLib clip (animation) on the rig in edit mode (Animator:StepAnimations): loop, speed, duration; action=stop ends it. Pair with or_screenshot.", json!({"path": {"type": "string"}, "animation": {"type": "string"}, "rig_path": {"type": "string"}, "loop": {"type": "boolean"}, "speed": {"type": "number"}, "duration": {"type": "number"}, "action": {"type": "string"}}), &[]),
        ]);
    }
    if key_set {
        v.extend([
            tool("cloud_gamepass_create", "Create a GAME PASS on the published universe through Open Cloud (or-core, API key from the ORscript Studio panel): name, description, optional Robux price (sets it for sale), optional icon_path (PNG/JPG on this PC; a generated icon is used otherwise). Returns the game pass id.", json!({"name": {"type": "string"}, "description": {"type": "string"}, "price": {"type": "number"}, "icon_path": {"type": "string"}, "universe_id": {"type": "number"}}), &["name"]),
            tool("cloud_gamepass_update", "Update a game pass: name, description, price / for_sale (Open Cloud).", json!({"gamepass_id": {"type": "number"}, "name": {"type": "string"}, "description": {"type": "string"}, "price": {"type": "number"}, "for_sale": {"type": "boolean"}}), &["gamepass_id"]),
            tool("cloud_gamepass_list", "List the universe's game passes (id, name, price).", json!({"universe_id": {"type": "number"}}), &[]),
            tool("cloud_product_create", "Create a DEVELOPER PRODUCT on the universe through Open Cloud: name, description, price in Robux. Returns the product id.", json!({"name": {"type": "string"}, "description": {"type": "string"}, "price": {"type": "number"}, "universe_id": {"type": "number"}}), &["name", "price"]),
            tool("cloud_product_list", "List the universe's developer products (Open Cloud).", json!({"universe_id": {"type": "number"}}), &[]),
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
        "cloud_product_list" => cloud::product_list(state, &args).await.map(|v| text_out(v.to_string())),
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
/// `OR_NO_PLUGIN_INSTALL=1` or when the platform has no such folder).
/// Returns the path and whether the file was (re)written.
pub fn install() -> anyhow::Result<Option<(PathBuf, bool)>> {
    if matches!(std::env::var("OR_NO_PLUGIN_INSTALL").as_deref(), Ok("1") | Ok("true")) {
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

// ───────────────────────── Open Cloud (game passes / products) ─────────────────────────

mod cloud {
    use super::*;

    const GAMEPASS_API: &str = "https://apis.roblox.com/game-passes/v1/game-passes";
    const PRODUCTS_API: &str = "https://apis.roblox.com/developer-products/v1/universes";

    fn client() -> anyhow::Result<reqwest::Client> {
        Ok(reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent(concat!("ORscript or-core/", env!("CARGO_PKG_VERSION")))
            .build()?)
    }

    async fn key(state: &AppState) -> anyhow::Result<String> {
        state.plugin.key().await.ok_or_else(|| anyhow::anyhow!(
            "no Open Cloud API key. Create one at https://create.roblox.com/dashboard/credentials (add this experience with Game Passes + Developer Products write access), paste it in Studio → Plugins → ORscript → Open Cloud API key → Save, or start or-core with OR_OPEN_CLOUD_KEY=… . Without a key, gamepass_create / developer_product_create still work through your roblox.com browser session."
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
            403 => "the key lacks permission - in Creator Dashboard → Open Cloud → API keys add this experience with Game Passes / Developer Products write access",
            404 => "endpoint or universe not found - publish the place and check the universe id",
            429 => "rate limited by Roblox - wait a minute and retry",
            _ => "the request failed",
        };
        let snippet: String = body.chars().take(300).collect();
        anyhow::anyhow!("could not change the {what}: HTTP {status} - {hint}. Response: {snippet}. Manual fallback: {}", dashboard(universe, what))
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
        format!("----ORscriptBoundary{}", chrono::Utc::now().timestamp_millis())
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

    fn icon_bytes(args: &Value) -> anyhow::Result<(Vec<u8>, &'static str, String)> {
        if let Some(p) = args.get("icon_path").and_then(|v| v.as_str()).map(str::trim).filter(|p| !p.is_empty()) {
            let data = std::fs::read(p).map_err(|e| anyhow::anyhow!("icon_path {p}: {e}"))?;
            let lower = p.to_lowercase();
            let mime = if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { "image/jpeg" } else { "image/png" };
            let name = std::path::Path::new(p).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "icon.png".into());
            return Ok((data, mime, name));
        }
        Ok((placeholder_icon()?, "image/png", "icon.png".into()))
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({ "raw": text }))
    }

    pub async fn gamepass_create(state: &AppState, args: &Value) -> anyhow::Result<Value> {
        let key = key(state).await?;
        let universe = universe(state, args).await?;
        let name = str_of(args, "name");
        if name.trim().is_empty() {
            anyhow::bail!("name is required");
        }
        let description = { let d = str_of(args, "description"); if d.is_empty() { name.clone() } else { d } };
        let (icon, mime, filename) = icon_bytes(args)?;
        let b = boundary();
        let mut body = Vec::new();
        mp_field(&mut body, &b, "UniverseId", &universe.to_string());
        mp_field(&mut body, &b, "Name", name.trim());
        mp_field(&mut body, &b, "Description", description.trim());
        mp_file(&mut body, &b, "File", &filename, mime, &icon);
        mp_end(&mut body, &b);
        let resp = client()?
            .post(GAMEPASS_API)
            .header("x-api-key", &key)
            .header("content-type", format!("multipart/form-data; boundary={b}"))
            .body(body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(explain(status, &text, "game pass", universe));
        }
        let created = parse(&text);
        let id = num_u64(created.get("gamePassId")).max(num_u64(created.get("id")));
        let price = num_u64(args.get("price"));
        let mut out = json!({
            "ok": true,
            "gamepass_id": id,
            "universe_id": universe,
            "name": name.trim(),
            "response": created,
            "dashboard": dashboard(universe, "game pass"),
            "next": "gamepass_handler_create {gamepass_id} writes the server handler; the client prompts with MarketplaceService:PromptGamePassPurchase(player, id)",
        });
        if id > 0 && price > 0 {
            match update_details(&key, id, None, None, Some(price), Some(true)).await {
                Ok(v) => { out["price"] = json!(price); out["for_sale"] = json!(true); out["details"] = v; }
                Err(e) => { out["price_warning"] = json!(format!("created, but setting the price failed: {e:#}")); }
            }
        }
        Ok(out)
    }

    async fn update_details(key: &str, id: u64, name: Option<&str>, description: Option<&str>, price: Option<u64>, for_sale: Option<bool>) -> anyhow::Result<Value> {
        let b = boundary();
        let mut body = Vec::new();
        if let Some(n) = name { mp_field(&mut body, &b, "Name", n); }
        if let Some(d) = description { mp_field(&mut body, &b, "Description", d); }
        if let Some(p) = price { mp_field(&mut body, &b, "Price", &p.to_string()); }
        if let Some(s) = for_sale.or(if price.is_some() { Some(true) } else { None }) { mp_field(&mut body, &b, "IsForSale", if s { "true" } else { "false" }); }
        mp_end(&mut body, &b);
        let resp = client()?
            .post(format!("{GAMEPASS_API}/{id}/details"))
            .header("x-api-key", key)
            .header("content-type", format!("multipart/form-data; boundary={b}"))
            .body(body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(explain(status, &text, "game pass", 0));
        }
        Ok(parse(&text))
    }

    pub async fn gamepass_update(state: &AppState, args: &Value) -> anyhow::Result<Value> {
        let key = key(state).await?;
        let id = num_u64(args.get("gamepass_id")).max(num_u64(args.get("id")));
        if id == 0 {
            anyhow::bail!("gamepass_id is required");
        }
        let name = args.get("name").and_then(|v| v.as_str());
        let description = args.get("description").and_then(|v| v.as_str());
        let price = args.get("price").map(|p| num_u64(Some(p)));
        let for_sale = args.get("for_sale").and_then(|v| v.as_bool());
        let v = update_details(&key, id, name, description, price, for_sale).await?;
        Ok(json!({ "ok": true, "gamepass_id": id, "response": v }))
    }

    pub async fn gamepass_list(state: &AppState, args: &Value) -> anyhow::Result<Value> {
        let universe = universe(state, args).await?;
        let resp = client()?
            .get(format!("https://games.roblox.com/v1/games/{universe}/game-passes?limit=100&sortOrder=Asc"))
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(explain(status, &text, "game pass", universe));
        }
        let v = parse(&text);
        let passes: Vec<Value> = v.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default()
            .into_iter()
            .map(|p| json!({ "id": p.get("id").cloned().unwrap_or(Value::Null), "name": p.get("name").cloned().unwrap_or(Value::Null), "price": p.get("price").cloned().unwrap_or(Value::Null) }))
            .collect();
        Ok(json!({ "ok": true, "universe_id": universe, "count": passes.len(), "game_passes": passes }))
    }

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
        let price_s = price.to_string();
        let resp = client()?
            .post(format!("{PRODUCTS_API}/{universe}/developerproducts"))
            .query(&[("name", name.trim()), ("description", description.trim()), ("priceInRobux", price_s.as_str())])
            .header("x-api-key", &key)
            .header("content-length", "0")
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(explain(status, &text, "developer product", universe));
        }
        let v = parse(&text);
        let id = num_u64(v.get("id")).max(num_u64(v.get("productId")));
        Ok(json!({
            "ok": true,
            "product_id": id,
            "universe_id": universe,
            "name": name.trim(),
            "price": price,
            "response": v,
            "next": "developer_product_handler_create {product_id} writes the ProcessReceipt handler",
        }))
    }

    pub async fn product_list(state: &AppState, args: &Value) -> anyhow::Result<Value> {
        let key = key(state).await?;
        let universe = universe(state, args).await?;
        let resp = client()?
            .get(format!("{PRODUCTS_API}/{universe}/developerproducts?pageNumber=1&pageSize=100"))
            .header("x-api-key", &key)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(explain(status, &text, "developer product", universe));
        }
        Ok(json!({ "ok": true, "universe_id": universe, "products": parse(&text) }))
    }
}
