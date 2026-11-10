//! TotalScript Blockbench plugin hub (2.20.0).
//!
//! `plugin/TotalScript-Blockbench.js` runs inside the Blockbench desktop app
//! and long-polls this bridge for jobs - the same shape as the Studio plugin
//! (`plugin.rs`), so Blockbench needs no listening port, no MCP session and no
//! Origin games: the only thing that ever talks to the plugin is this loopback
//! server, and the only thing the plugin talks to is us. The `bb_*` tools are
//! served to the desktop chat and to the browser extension alike; the plugin
//! validates and executes them with Blockbench's real API.
//!
//! HTTP (loopback only, mounted by `run_server`):
//!   POST /api/blockbench/hello    plugin announces itself (+ capabilities)
//!   GET  /api/blockbench/poll     long poll (~20 s) for the next job
//!   POST /api/blockbench/result   job outcome ({id, ok, result, error?})
//!   GET  /api/blockbench/status   connection summary + where the plugin file is

use std::{
    collections::{HashMap, VecDeque},
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

pub const PLUGIN_SOURCE: &str = include_str!("../../plugin/TotalScript-Blockbench.js");
pub const PLUGIN_FILE: &str = "TotalScript-Blockbench.js";
const STALE_AFTER: Duration = Duration::from_secs(45);
const POLL_WAIT: Duration = Duration::from_secs(20);
pub const EXPORT_DIR: &str = "blockbench_exports";

pub fn not_connected(plugin_file: Option<&str>) -> String {
    let where_ = plugin_file
        .map(|p| format!(" The plugin file is at {p} (also plugin/TotalScript-Blockbench.js in the extension folder)."))
        .unwrap_or_default();
    format!("Blockbench is not connected. Open the Blockbench desktop app with the TotalScript Bridge plugin loaded (once: File → Plugins → Load Plugin from File → TotalScript-Blockbench.js; it then loads on every start and connects to this app by itself - Tools → TotalScript shows the state).{where_}")
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PluginInfo {
    pub client_id: String,
    pub version: String,
    pub blockbench_version: String,
    pub project: String,
    pub format: String,
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
    pub code: Option<String>,
    pub elapsed_ms: u64,
}

pub struct Hub {
    info: Mutex<Option<(PluginInfo, Instant)>>,
    queue: Mutex<VecDeque<Job>>,
    wake: Notify,
    results: broadcast::Sender<JobResult>,
    seq: AtomicU64,
    installed: Mutex<Option<String>>,
}

impl Default for Hub {
    fn default() -> Self { Self::new() }
}

impl Hub {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel::<JobResult>(64);
        Self {
            info: Mutex::new(None),
            queue: Mutex::new(VecDeque::new()),
            wake: Notify::new(),
            results: tx,
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

    pub async fn set_installed(&self, path: Option<String>) {
        *self.installed.lock().await = path;
    }

    pub async fn installed(&self) -> Option<String> {
        self.installed.lock().await.clone()
    }

    /// Queue a job for the plugin and wait for its result.
    pub async fn run(&self, name: &str, args: Value, timeout: Duration) -> anyhow::Result<JobResult> {
        if !self.connected().await {
            anyhow::bail!("{}", not_connected(self.installed().await.as_deref()));
        }
        let id = format!("bbjob-{}", self.seq.fetch_add(1, Ordering::Relaxed));
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
                Ok(Err(_)) => anyhow::bail!("blockbench result channel closed"),
                Err(_) => {
                    let in_flight = {
                        let mut q = self.queue.lock().await;
                        let before = q.len();
                        q.retain(|j| j.id != id);
                        before == q.len()
                    };
                    if in_flight {
                        anyhow::bail!("the Blockbench plugin picked up '{name}' but did not finish it within {} s - it may still be running (a dialog open in Blockbench?). Check Blockbench before retrying.", timeout.as_secs());
                    }
                    anyhow::bail!("the Blockbench plugin did not pick up '{name}' within {} s (Blockbench busy, a modal dialog open, or the link paused under Tools → TotalScript)", timeout.as_secs());
                }
            }
        }
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
        blockbench_version: str_of(&req, "blockbench_version"),
        project: str_of(&req, "project"),
        format: str_of(&req, "format"),
        capabilities: req
            .get("capabilities")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
    };
    state.ui.blockbench_touch();
    let fresh = {
        let mut guard = state.blockbench.info.lock().await;
        let fresh = match &*guard {
            Some((old, at)) => old.client_id != info.client_id || at.elapsed() >= STALE_AFTER,
            None => true,
        };
        *guard = Some((info.clone(), Instant::now()));
        fresh
    };
    if fresh {
        state.ui.track(
            "blockbench",
            format!(
                "Blockbench plugin {} connected · Blockbench {} · {} ({} commands)",
                info.version,
                info.blockbench_version,
                if info.project.is_empty() { "no project open".to_string() } else { format!("project '{}'", info.project) },
                info.capabilities.len()
            ),
        );
        tracing::info!("blockbench plugin connected: {:?}", info);
    }
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "client_id": info.client_id }))
}

pub async fn poll_handler(State(state): State<AppState>, Query(_q): Query<HashMap<String, String>>) -> impl IntoResponse {
    state.blockbench.touch().await;
    state.ui.blockbench_touch();
    let deadline = tokio::time::Instant::now() + POLL_WAIT;
    loop {
        if let Some(job) = state.blockbench.queue.lock().await.pop_front() {
            return Json(json!({ "ok": true, "job": job }));
        }
        if tokio::time::timeout_at(deadline, state.blockbench.wake.notified()).await.is_err() {
            return Json(json!({ "ok": true, "job": Value::Null }));
        }
    }
}

pub async fn result_handler(State(state): State<AppState>, Json(res): Json<JobResult>) -> impl IntoResponse {
    state.blockbench.touch().await;
    state.ui.blockbench_touch();
    let _ = state.blockbench.results.send(res);
    Json(json!({ "ok": true }))
}

pub async fn status_handler(State(state): State<AppState>) -> impl IntoResponse {
    Json(status_json(&state).await)
}

pub async fn status_json(state: &AppState) -> Value {
    let info = state.blockbench.info().await;
    let installed = state.blockbench.installed().await;
    json!({
        "connected": info.is_some(),
        "plugin": info,
        "plugin_file": installed,
        "queue": state.blockbench.queue.lock().await.len(),
        "how_to_connect": not_connected(installed.as_deref()),
    })
}

// ───────────────────────── tool catalogue ─────────────────────────

/// Every `bb_*` name belongs to the Blockbench plugin.
pub fn is_tool(name: &str) -> bool {
    name.rsplit('/').next().unwrap_or(name).starts_with("bb_")
}

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "server": "blockbench",
        "inputSchema": { "type": "object", "properties": props, "required": required },
    })
}

/// Per-command timeout: exports and screenshots take longer than edits.
fn secs_for(name: &str) -> u64 {
    match name {
        "bb_export" | "bb_screenshot" => 90,
        "bb_texture" => 60,
        _ => 45,
    }
}

/// The curated command table (names and required arguments mirror
/// `src/core/blockbench_tools.js`, which the node test pins against this file).
pub fn tools(connected: bool) -> Vec<Value> {
    let mut v = vec![tool(
        "bb_status",
        "Blockbench: read the open project (format, name, texture size, cube / mesh / group / texture / animation counts) and the outliner tree. Run it FIRST and after every build pass. Also the quickest way to see whether Blockbench is connected.",
        json!({"max_depth": {"type": "integer", "description": "Outliner depth to list (1-32, default 4)."}}),
        &[],
    )];
    if !connected {
        return v;
    }
    v.extend([
        tool("bb_project", "Blockbench: create a new project. format = Blockbench format id (free = unconstrained cubes + meshes, best for OBJ / glTF export to Roblox).", json!({"name": {"type": "string"}, "format": {"type": "string"}}), &["name"]),
        tool("bb_cubes", "Blockbench: place 1-200 cubes in one undoable edit. cubes = [{name, from:[x,y,z], to:[x,y,z], origin?, rotation?, inflate?, color?}] in Blockbench units (16 = one block); group? = parent group; texture? = texture to apply.", json!({"cubes": {"type": "array"}, "group": {"type": "string"}, "texture": {"type": "string"}}), &["cubes"]),
        tool("bb_cube_edit", "Blockbench: change one cube by name: from, to, origin, rotation, inflate, rename, color, visible, group.", json!({"name": {"type": "string"}, "from": {"type": "array"}, "to": {"type": "array"}, "origin": {"type": "array"}, "rotation": {"type": "array"}, "inflate": {"type": "number"}, "rename": {"type": "string"}, "color": {"type": "integer"}, "visible": {"type": "boolean"}, "group": {"type": "string"}}), &["name"]),
        tool("bb_group", "Blockbench: create (or update) a group = bone. origin = pivot [x,y,z]; parent? = parent group; move? = names of cubes / meshes / groups to move inside.", json!({"name": {"type": "string"}, "parent": {"type": "string"}, "origin": {"type": "array"}, "rotation": {"type": "array"}, "move": {"type": "array"}}), &["name"]),
        tool("bb_remove", "Blockbench: delete cubes, meshes or groups by name (one undo step).", json!({"names": {"type": "array"}}), &["names"]),
        tool("bb_mesh", "Blockbench: create a free-form mesh from vertices [[x,y,z]…] and faces [[i,j,k(,l)]…] (3 or 4 indices each, counter-clockwise seen from outside). group?, origin?, texture?.", json!({"name": {"type": "string"}, "vertices": {"type": "array"}, "faces": {"type": "array"}, "group": {"type": "string"}, "origin": {"type": "array"}, "texture": {"type": "string"}}), &["name", "vertices", "faces"]),
        tool("bb_mesh_primitive", "Blockbench: build a mesh primitive: shape = cylinder | cone | pyramid | plane | sphere | torus; diameter, height, sides (3-64), tube (torus), position = base centre [x,y,z]; group?, texture?.", json!({"shape": {"type": "string"}, "name": {"type": "string"}, "diameter": {"type": "number"}, "height": {"type": "number"}, "sides": {"type": "integer"}, "tube": {"type": "number"}, "position": {"type": "array"}, "group": {"type": "string"}, "texture": {"type": "string"}}), &["shape", "name"]),
        tool("bb_mesh_edit", "Blockbench: transform a mesh by name: move [dx,dy,dz], scale (number or [sx,sy,sz]), rotate [x,y,z] degrees around its origin, rename, origin, group.", json!({"name": {"type": "string"}, "move": {"type": "array"}, "scale": {}, "rotate": {"type": "array"}, "rename": {"type": "string"}, "origin": {"type": "array"}, "group": {"type": "string"}}), &["name"]),
        tool("bb_texture", "Blockbench: action=list | create {name, width, height, fill_color '#rrggbb', apply_to?} | import {path, name?, apply_to?} | apply {texture, targets:[cube / mesh / group names] or 'all'}.", json!({"action": {"type": "string"}, "name": {"type": "string"}, "width": {"type": "integer"}, "height": {"type": "integer"}, "fill_color": {"type": "string"}, "path": {"type": "string"}, "texture": {"type": "string"}, "targets": {"type": "array"}, "apply_to": {"type": "array"}}), &["action"]),
        tool("bb_animate", "Blockbench: create an animation on GROUPS (bones): bones = {GroupName: [{time, rotation?:[x,y,z], position?:[x,y,z], scale?:[x,y,z]}]}, length seconds, loop (default true).", json!({"name": {"type": "string"}, "length": {"type": "number"}, "loop": {"type": "boolean"}, "bones": {"type": "object"}}), &["name", "bones"]),
        tool("bb_camera", "Blockbench: frame the viewport: view = front | back | left | right | top | bottom | isometric_right | isometric_left, or position + target [x,y,z], or focus = element / group name.", json!({"view": {"type": "string"}, "position": {"type": "array"}, "target": {"type": "array"}, "focus": {"type": "string"}}), &[]),
        tool("bb_screenshot", "Blockbench: capture the 3D viewport as a PNG you can see (max_size 128-2048, default 1024; view? = camera preset first). Do it after EVERY build pass.", json!({"max_size": {"type": "integer"}, "view": {"type": "string"}}), &[]),
        tool("bb_export", "Blockbench: write the model to a FILE for Roblox Studio's Import 3D: format = obj (+ mtl + textures) | gltf | glb | bbmodel (editable project, not importable); name?; overwrite? (default: a -2 suffix). Files land in <workspace>/blockbench_exports (or ~/Documents/TotalScript/blockbench_exports). Nothing is uploaded or inserted.", json!({"format": {"type": "string"}, "name": {"type": "string"}, "overwrite": {"type": "boolean"}}), &["format"]),
        tool("bb_undo", "Blockbench: undo the last N edits (1-20).", json!({"steps": {"type": "integer"}}), &[]),
        tool("bb_redo", "Blockbench: redo N edits (1-20).", json!({"steps": {"type": "integer"}}), &[]),
        tool("bb_tools", "Blockbench: list what the TotalScript Blockbench plugin can do (commands, formats, camera views, mesh primitives).", json!({}), &[]),
    ]);
    v
}

pub fn tool_names(connected: bool) -> Vec<String> {
    tools(connected).into_iter().filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())).collect()
}

// ───────────────────────── dispatch ─────────────────────────

pub fn render(res: JobResult, name: &str) -> anyhow::Result<McpToolOutput> {
    if !res.ok {
        anyhow::bail!("{}", res.error.unwrap_or_else(|| format!("{name} failed in the Blockbench plugin")));
    }
    let text = match res.result.get("text").and_then(|t| t.as_str()) {
        Some(t) => t.to_string(),
        None => serde_json::to_string_pretty(&res.result).unwrap_or_else(|_| res.result.to_string()),
    };
    let images: Vec<Value> = res
        .result
        .get("images")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter(|img| img.get("data").and_then(|d| d.as_str()).map(|d| !d.is_empty()).unwrap_or(false))
                .map(|img| json!({ "mimeType": img.get("mimeType").and_then(|m| m.as_str()).unwrap_or("image/png"), "data": img.get("data") }))
                .collect()
        })
        .unwrap_or_default();
    Ok(McpToolOutput { text, images })
}

/// Where `bb_export` writes: the agent workspace when one is attached.
fn export_dir(state: &AppState) -> Option<String> {
    if state.workspace.ready() {
        Some(PathBuf::from(state.workspace.root_display()).join(EXPORT_DIR).display().to_string())
    } else {
        None
    }
}

pub async fn call(state: &AppState, name: &str, args: Value) -> anyhow::Result<McpToolOutput> {
    let bare = name.rsplit('/').next().unwrap_or(name).to_string();
    let mut args = if args.is_object() { args } else { json!({}) };
    if bare == "bb_status" && !state.blockbench.connected().await {
        return Ok(McpToolOutput { text: format!("ERROR BLOCKBENCH_OFFLINE: {}", not_connected(state.blockbench.installed().await.as_deref())), images: Vec::new() });
    }
    if bare == "bb_export" {
        if let Some(dir) = export_dir(state) {
            if let Some(obj) = args.as_object_mut() {
                obj.insert("_export_dir".to_string(), Value::String(dir));
            }
        }
    }
    let res = state.blockbench.run(&bare, args, Duration::from_secs(secs_for(&bare))).await?;
    if bare == "bb_export" && res.ok {
        if let Some(p) = res.result.get("path").and_then(|p| p.as_str()) {
            state.ui.track("blockbench", format!("export written: {p}"));
        }
    }
    render(res, &bare)
}

// ───────────────────────── install ─────────────────────────

/// Blockbench only loads plugins the user picked once (File → Plugins → Load
/// Plugin from File), so there is no silent install: we keep an up-to-date copy
/// of the embedded plugin next to the executable and show that path in the
/// desktop app and the popup. Skipped with `TOTAL_NO_PLUGIN_INSTALL=1`.
pub fn install() -> anyhow::Result<Option<(PathBuf, bool)>> {
    if matches!(std::env::var("TOTAL_NO_PLUGIN_INSTALL").as_deref(), Ok("1") | Ok("true")) {
        return Ok(None);
    }
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let Some(dir) = dir else { return Ok(None) };
    let path = dir.join(PLUGIN_FILE);
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current == PLUGIN_SOURCE {
        return Ok(Some((path, false)));
    }
    std::fs::write(&path, PLUGIN_SOURCE)?;
    Ok(Some((path, true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_shape() {
        let off = tools(false);
        assert_eq!(off.len(), 1, "only bb_status while disconnected");
        let on = tools(true);
        assert_eq!(on.len(), 17);
        let names = tool_names(true);
        for n in ["bb_status", "bb_project", "bb_cubes", "bb_cube_edit", "bb_group", "bb_remove", "bb_mesh", "bb_mesh_primitive", "bb_mesh_edit", "bb_texture", "bb_animate", "bb_camera", "bb_screenshot", "bb_export", "bb_undo", "bb_redo", "bb_tools"] {
            assert!(names.iter().any(|x| x == n), "missing {n}");
        }
        for t in &on {
            assert_eq!(t["server"], "blockbench");
            assert_eq!(t["inputSchema"]["type"], "object");
            assert!(is_tool(t["name"].as_str().unwrap()));
        }
        assert!(!is_tool("execute_luau"));
        assert!(is_tool("blockbench/bb_cubes"));
    }

    #[test]
    fn plugin_source_is_the_bridge_plugin() {
        assert!(PLUGIN_SOURCE.contains("BBPlugin.register(PLUGIN_ID"));
        assert!(PLUGIN_SOURCE.contains("/api/blockbench/hello"));
        assert!(PLUGIN_SOURCE.contains("/api/blockbench/poll"));
        assert!(PLUGIN_SOURCE.contains("/api/blockbench/result"));
        // every catalogue command is implemented by the plugin
        for n in tool_names(true) {
            assert!(PLUGIN_SOURCE.contains(&format!("JOBS.{n} =")), "plugin lacks {n}");
        }
    }

    #[test]
    fn render_text_and_images() {
        let ok = JobResult { id: "1".into(), ok: true, result: json!({"text": "hi", "images": [{"mimeType": "image/png", "data": "AAAA"}, {"mimeType": "image/png", "data": ""}]}), error: None, code: None, elapsed_ms: 1 };
        let out = render(ok, "bb_screenshot").unwrap();
        assert_eq!(out.text, "hi");
        assert_eq!(out.images.len(), 1, "empty images are dropped");
        assert_eq!(out.images[0]["mimeType"], "image/png");
        let plain = JobResult { id: "2".into(), ok: true, result: json!({"a": 1}), error: None, code: None, elapsed_ms: 1 };
        assert!(render(plain, "bb_status").unwrap().text.contains("\"a\": 1"));
        let bad = JobResult { id: "3".into(), ok: false, result: Value::Null, error: Some("ERROR INVALID_ARGUMENT in bb_cubes: cubes (non-empty array) is required".into()), code: Some("INVALID_ARGUMENT".into()), elapsed_ms: 1 };
        let e = render(bad, "bb_cubes").unwrap_err().to_string();
        assert!(e.starts_with("ERROR INVALID_ARGUMENT in bb_cubes"));
    }

    #[test]
    fn not_connected_mentions_the_file() {
        let s = not_connected(Some("C:/TotalScript/bin/TotalScript-Blockbench.js"));
        assert!(s.contains("Load Plugin from File"));
        assert!(s.contains("C:/TotalScript/bin/TotalScript-Blockbench.js"));
        assert!(!not_connected(None).contains("The plugin file is at"));
    }

    #[test]
    fn timeouts() {
        assert_eq!(secs_for("bb_export"), 90);
        assert_eq!(secs_for("bb_screenshot"), 90);
        assert_eq!(secs_for("bb_cubes"), 45);
    }
}
