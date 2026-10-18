#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// ORscript Desktop targets Windows and macOS only (Roblox Studio does not run
// natively anywhere else). Fail loudly instead of producing a half-working
// binary on other platforms.
#[cfg(not(any(windows, target_os = "macos")))]
compile_error!("ORscript Desktop supports Windows and macOS only.");

use axum::{extract::{Query, State}, http::Method, response::IntoResponse, routing::{get, post}, Json, Router};
use clap::Parser;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, VecDeque}, fs::File, net::SocketAddr, path::PathBuf, process::Stdio, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc}, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{broadcast, Mutex, RwLock},
};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tracing::info;

// ───────────────────────── caller origin policy ─────────────────────────
// The bridge listens on loopback only, but every web page the user visits can
// still reach 127.0.0.1 (fetch / WebSocket from an https page to ws://127.0.0.1
// is not blocked as mixed content). Browsers always stamp such requests with
// an `Origin` header, and the only browser caller we have is the extension
// itself (chrome-extension:// / moz-extension:// …). The Studio plugin
// (HttpService) and local tools send no Origin at all. So: no Origin → local
// caller, allowed; extension scheme → allowed; any http(s)/null/file origin →
// a web page → refused before any handler runs (HTTP 403, WS handshake 403).
pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(o) = origin.map(str::trim) else { return true };
    if o.is_empty() { return true; }
    let lower = o.to_ascii_lowercase();
    ["chrome-extension://", "moz-extension://", "safari-web-extension://", "ms-browser-extension://"]
        .iter()
        .any(|scheme| lower.starts_with(scheme) && lower.len() > scheme.len())
}

async fn origin_guard(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let origin = req.headers().get(axum::http::header::ORIGIN).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    if !origin_allowed(origin.as_deref()) {
        tracing::warn!("refused bridge request from web origin {:?} ({} {})", origin.as_deref().unwrap_or(""), req.method(), req.uri().path());
        return (axum::http::StatusCode::FORBIDDEN, "ORscript bridge: requests from web pages are not allowed").into_response();
    }
    next.run(req).await
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Append-only file logger so the GUI-subsystem release build keeps visible
/// diagnostics in `<exe dir>/logs/agent.log` (stdout is invisible there).
#[derive(Clone)]
struct FileLog {
    file: Arc<std::sync::Mutex<File>>,
    ui: Option<Arc<gui::UiShared>>,
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for FileLog {
    type Writer = FileLog;
    fn make_writer(&'a self) -> Self::Writer { self.clone() }
}
impl std::io::Write for FileLog {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Some(ui) = &self.ui { ui.log(&String::from_utf8_lossy(buf)); }
        let mut f = self.file.lock().unwrap_or_else(|e| e.into_inner());
        std::io::Write::write(&mut *f, buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        let mut f = self.file.lock().unwrap_or_else(|e| e.into_inner());
        std::io::Write::flush(&mut *f)
    }
}

fn init_file_logger(ui: Option<Arc<gui::UiShared>>) {
    // Windows: <exe dir>/logs. macOS: the per-user data dir (see gui::data_dir).
    let dir = gui::data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("agent.log");
    // Rotate once the log passes 4 MB so a long-running tray instance never
    // fills the disk; one previous generation is kept as agent.log.1.
    if std::fs::metadata(&path).map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("agent.log.1"));
    }
    match File::options().create(true).append(true).open(&path) {
        Ok(file) => {
            tracing_subscriber::fmt()
                .with_env_filter("info")
                .with_ansi(false)
                .with_writer(FileLog { file: Arc::new(std::sync::Mutex::new(file)), ui })
                .init();
        }
        Err(_) => {
            tracing_subscriber::fmt().with_env_filter("info").init();
        }
    }
}

mod chat;
mod gui;
mod plugin;
mod workspace;

#[cfg(windows)]
mod win_msg {
    #[link(name = "user32")]
    extern "system" {
        pub fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            ty: u32,
        ) -> i32;
        pub fn FindWindowW(class_name: *const u16, window_name: *const u16) -> *mut core::ffi::c_void;
        pub fn ShowWindow(hwnd: *mut core::ffi::c_void, command: i32) -> i32;
        pub fn SetForegroundWindow(hwnd: *mut core::ffi::c_void) -> i32;
        pub fn PostMessageW(hwnd: *mut core::ffi::c_void, msg: u32, wparam: usize, lparam: isize) -> i32;
        pub fn EnumWindows(callback: unsafe extern "system" fn(*mut core::ffi::c_void, isize) -> i32, lparam: isize) -> i32;
        pub fn GetWindowTextW(hwnd: *mut core::ffi::c_void, text: *mut u16, max: i32) -> i32;
        pub fn GetWindowThreadProcessId(hwnd: *mut core::ffi::c_void, pid: *mut u32) -> u32;
    }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }

/// Every top-level window whose title is exactly `title`, with its owning pid.
/// `FindWindowW` alone was not safe: an Explorer window open on a folder named
/// "ORscript" matched too, so a fresh or-core "found itself", showed Explorer
/// and exited without ever starting the bridge.
#[cfg(windows)]
fn windows_titled(title: &str) -> Vec<(isize, u32)> {
    struct Ctx { title: Vec<u16>, found: Vec<(isize, u32)> }
    unsafe extern "system" fn visit(hwnd: *mut core::ffi::c_void, lparam: isize) -> i32 {
        let ctx = &mut *(lparam as *mut Ctx);
        let mut buf = [0u16; 512];
        let n = win_msg::GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if n > 0 && buf[..n as usize] == ctx.title[..] {
            let mut pid = 0u32;
            win_msg::GetWindowThreadProcessId(hwnd, &mut pid);
            ctx.found.push((hwnd as isize, pid));
        }
        1
    }
    let mut ctx = Ctx { title: title.encode_utf16().collect(), found: Vec::new() };
    unsafe { win_msg::EnumWindows(visit, &mut ctx as *mut Ctx as isize); }
    ctx.found
}

/// Find THIS process's eframe root window even while it is hidden. eframe 0.29
/// cannot reliably process `ViewportCommand::Visible(true)` after a window
/// becomes invisible on Windows 11, so tray actions use Win32 directly.
#[cfg(windows)]
pub(crate) fn agent_window() -> Option<isize> {
    let me = std::process::id();
    windows_titled(gui::WINDOW_TITLE).into_iter().find(|(_, pid)| *pid == me).map(|(hwnd, _)| hwnd)
}

/// Window of ANOTHER running ORscript Desktop instance (if any). Only trusted
/// when its bridge really answers on 127.0.0.1:3000, so a stray window with the
/// same title can never stop a new agent from starting.
#[cfg(windows)]
fn other_agent_window() -> Option<isize> {
    let me = std::process::id();
    let other = windows_titled(gui::WINDOW_TITLE).into_iter().find(|(_, pid)| *pid != me)?;
    if bridge_alive_on(3000) { Some(other.0) } else { None }
}

/// Blocking probe: does an or-agent/or-core bridge answer HTTP on this port?
fn bridge_alive_on(port: u16) -> bool {
    use std::io::{Read, Write};
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(600)) else { return false; };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    if stream.write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() { return false; }
    let mut buf = Vec::with_capacity(1024);
    let _ = stream.take(8192).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    text.contains("\"service\":\"or-agent\"") || text.contains("or-agent")
}

/// Platform default for the Roblox Studio MCP helper (stdio JSON-RPC):
///   Windows  cmd /C %LOCALAPPDATA%\Roblox\mcp.bat
///   macOS    /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP (run directly)
/// `OR_MCP_COMMAND` (or Settings → MCP launcher) always wins over this.
fn default_mcp_launcher() -> anyhow::Result<(String, Vec<String>)> {
    const ENABLE_HINT: &str = "In Studio: Assistant → … → Manage MCP Servers → Enable Studio as MCP server.";
    #[cfg(windows)]
    {
        let local = std::env::var("LOCALAPPDATA").map_err(|_| anyhow::anyhow!("LOCALAPPDATA is unavailable; set OR_MCP_COMMAND to Studio's MCP launcher"))?;
        let bat = PathBuf::from(local).join("Roblox").join("mcp.bat");
        if !bat.is_file() {
            anyhow::bail!("Roblox Studio MCP launcher not found at {}. {ENABLE_HINT}", bat.display());
        }
        Ok(("cmd".to_string(), vec!["/C".to_string(), bat.to_string_lossy().to_string()]))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        let candidates = [
            PathBuf::from("/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP"),
            PathBuf::from(&home).join("Applications/RobloxStudio.app/Contents/MacOS/StudioMCP"),
        ];
        match candidates.iter().find(|p| p.is_file()) {
            Some(p) => Ok((p.to_string_lossy().to_string(), Vec::new())),
            None => anyhow::bail!(
                "Roblox Studio MCP helper not found at {} (Studio not installed, or too old). {ENABLE_HINT}",
                candidates[0].display()
            ),
        }
    }
}

/// Human-readable default launcher, shown as the Settings placeholder.
pub(crate) fn default_mcp_launcher_hint() -> String {
    #[cfg(windows)]
    { r"%LOCALAPPDATA%\Roblox\mcp.bat (Studio default)".to_string() }
    #[cfg(target_os = "macos")]
    { "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP (Studio default)".to_string() }
}

/// Folder that contains the default launcher (for "Open launcher folder").
pub(crate) fn mcp_launcher_folder() -> Option<PathBuf> {
    #[cfg(windows)]
    { std::env::var("LOCALAPPDATA").ok().map(|l| PathBuf::from(l).join("Roblox")) }
    #[cfg(target_os = "macos")]
    { Some(PathBuf::from("/Applications/RobloxStudio.app/Contents/MacOS")) }
}

/// Ask an already-running ORscript Desktop (any OS) to raise its window.
fn ask_running_instance_to_show() -> bool {
    use std::io::{Read, Write};
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 3000));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(600)) else { return false; };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let body = br#"{"action":"show"}"#;
    let req = format!(
        "POST /api/window HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(req.as_bytes()).is_err() || stream.write_all(body).is_err() { return false; }
    let mut buf = Vec::with_capacity(512);
    let _ = stream.take(4096).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).contains("\"ok\":true")
}

#[cfg(windows)]
pub(crate) fn show_agent_window(hwnd: isize) {
    let hwnd = hwnd as *mut core::ffi::c_void;
    unsafe {
        // SW_RESTORE also recovers a minimized window; the user's tray click is
        // a foreground-activation gesture, so SetForegroundWindow is permitted.
        win_msg::ShowWindow(hwnd, 9);
        win_msg::SetForegroundWindow(hwnd);
    }
}

#[cfg(windows)]
pub(crate) fn hide_agent_window(hwnd: isize) {
    unsafe { win_msg::ShowWindow(hwnd as *mut core::ffi::c_void, 0); } // SW_HIDE
}

#[cfg(windows)]
pub(crate) fn close_agent_window(hwnd: isize) {
    unsafe {
        // Posting WM_CLOSE wakes winit even when the root viewport is hidden.
        win_msg::PostMessageW(hwnd as *mut core::ffi::c_void, 0x0010, 0, 0);
    }
}

#[cfg(windows)]
fn win_alert(title: &str, msg: &str) {
    // windows_subsystem = "windows" hides stderr. A MessageBox is the only way
    // the user sees *why* the agent did not open.
    let t = wide(title);
    let m = wide(msg);
    unsafe { win_msg::MessageBoxW(std::ptr::null_mut(), m.as_ptr(), t.as_ptr(), 0x10); }
}


#[derive(Parser, Debug)]
#[command(name = "or-agent", version = env!("CARGO_PKG_VERSION"), about = "OR Native Agent — Roblox Studio MCP + AgentScript")]
struct Args {
    #[arg(long, help = "Run without the desktop window (for autostart/background use)")]
    headless: bool,
    #[arg(long, help = "Start with the desktop window hidden in the notification area")]
    hidden: bool,
    #[arg(long, default_value = "127.0.0.1:3000")]
    roblox_addr: String,
    #[arg(long, help = "Workspace root for the LOCAL (FS) engine [env: OR_WORKSPACE_ROOT]")]
    workspace: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Payload { id: String, target: String, code: String, language: String, #[serde(default)] meta: serde_json::Value, }

#[derive(Clone)]
struct AppState {
    roblox_queue: Arc<Mutex<VecDeque<Payload>>>,
    roblox_clients: Arc<RwLock<HashMap<String, String>>>,
    local_clients: Arc<RwLock<HashMap<String, String>>>,
    workspace: Arc<workspace::Workspace>,
    result_tx: broadcast::Sender<ExecResult>,
    roblox_mcp: Arc<Mutex<McpRuntime>>,
    /// Count of in-flight MCP tools/list/probe calls. Status probes skip while
    /// this is non-zero so they never fight a 20s execute_luau for the mutex.
    mcp_in_flight: Arc<AtomicUsize>,
    roblox_proc: Arc<AtomicBool>,
    roblox_editor_connected: Arc<AtomicBool>,
    /// Desktop window state (status, tool catalog, recent activity).
    ui: Arc<gui::UiShared>,
    /// ORscript Studio plugin hub (jobs, Open Cloud key, install path).
    plugin: Arc<plugin::Hub>,
}

impl AppState {
    fn new(result_tx: broadcast::Sender<ExecResult>, mcp_alive: Arc<AtomicBool>, roblox_proc: Arc<AtomicBool>, workspace: Arc<workspace::Workspace>, ui: Arc<gui::UiShared>) -> Self {
        Self {
            roblox_queue: Arc::new(Mutex::new(VecDeque::new())),
            roblox_clients: Arc::new(RwLock::new(HashMap::new())),
            local_clients: Arc::new(RwLock::new(HashMap::new())),
            workspace,
            result_tx,
            roblox_mcp: Arc::new(Mutex::new(McpRuntime::new(mcp_alive))),
            mcp_in_flight: Arc::new(AtomicUsize::new(0)),
            roblox_proc,
            roblox_editor_connected: Arc::new(AtomicBool::new(false)),
            ui,
            plugin: Arc::new(plugin::Hub::new()),
        }
    }
}

/// Single place that flips the "Studio linked" flag so the desktop window and
/// the activity feed always agree with the bridge.
fn set_editor(state: &AppState, on: bool) {
    let was = state.roblox_editor_connected.swap(on, Ordering::Relaxed);
    state.ui.studio_connected.store(on, Ordering::Relaxed);
    if was != on {
        state.ui.track("studio", if on { "Roblox Studio linked through the MCP helper" } else { "Roblox Studio link lost" });
    }
}

async fn publish_clients(state: &AppState, engine: &str) {
    let count = if engine == "local" { state.local_clients.read().await.len() } else { state.roblox_clients.read().await.len() };
    state.ui.set_clients(engine, count);
}

/// Persistent stdio client for Roblox Studio's built-in MCP server.
struct McpRuntime {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: Option<Lines<BufReader<ChildStdout>>>,
    next_id: u64,
    tools: Vec<serde_json::Value>,
    alive: Arc<AtomicBool>,
    /// `studio_id` of the Studio instance this bridge targets, resolved from
    /// `list_roblox_studios` and cached briefly. Studio's MCP takes a
    /// `studio_id` on every tool; most tools infer it when a single Studio is
    /// open, but `screen_capture` refuses the call without one ("Missing
    /// required arg"), so or-core injects it the way the official clients do.
    studio_id: Option<(String, std::time::Instant)>,
}

// MCP tools can return mixed text + image content. Keeping only `text` made
// Studio's screen_capture look successful but empty, so the extension silently
// fell back to a browser-tab screenshot. Preserve image blocks across the native
// WebSocket bridge instead.
#[derive(Clone, Debug)]
struct McpToolOutput {
    text: String,
    images: Vec<serde_json::Value>,
}

impl McpRuntime {
    fn new(alive: Arc<AtomicBool>) -> Self {
        Self { child: None, stdin: None, stdout: None, next_id: 1, tools: Vec::new(), alive, studio_id: None }
    }

    fn launcher() -> anyhow::Result<(String, Vec<String>)> {
        if let Ok(raw) = std::env::var("OR_MCP_COMMAND").or_else(|_| std::env::var("ROBLOXSCRIPT_MCP_COMMAND")) {
            let mut parts = raw.split_whitespace();
            let program = parts.next().ok_or_else(|| anyhow::anyhow!("OR_MCP_COMMAND is empty"))?;
            return Ok((program.to_string(), parts.map(str::to_string).collect()));
        }
        default_mcp_launcher()
    }

    async fn reset(&mut self) {
        if self.child.is_some() {
            info!("MCP runtime reset — killing previous helper process");
            if let Some(child) = self.child.as_mut() {
                #[cfg(windows)]
                if let Some(pid) = child.id() {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &pid.to_string()])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
                let _ = child.kill().await;
            }
        }
        self.child = None; self.stdin = None; self.stdout = None; self.tools.clear(); self.next_id = 1;
        self.studio_id = None;
        self.alive.store(false, Ordering::Relaxed);
    }

    /// True if the helper process is still running. Uses try_wait so a crashed
    /// StudioMCP is not treated as alive just because Option<Child> is Some.
    fn child_alive(&mut self) -> bool {
        match self.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                Ok(Some(status)) => {
                    info!("MCP helper exited ({status})");
                    false
                }
                Err(e) => {
                    tracing::warn!("MCP try_wait failed: {e}");
                    false
                }
            },
            None => false,
        }
    }

    async fn ensure(&mut self) -> anyhow::Result<()> {
        if self.child_alive() && self.stdin.is_some() && self.stdout.is_some() {
            return Ok(());
        }
        self.reset().await;
        let (program, args) = Self::launcher()?;
        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| { tracing::error!("MCP helper spawn failed: {e}"); e })?;
        info!("MCP helper spawned OK");
        self.stdin = child.stdin.take();
        self.stdout = child.stdout.take().map(|s| BufReader::new(s).lines());
        self.child = Some(child);
        let _ = self.request_within("initialize", serde_json::json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "OR", "version": "1.14.1"}
        }), Duration::from_secs(25)).await.map_err(|e| { tracing::warn!("MCP initialize failed: {e:#}"); e })?;
        self.notify("notifications/initialized", serde_json::json!({})).await?;
        self.alive.store(true, Ordering::Relaxed);
        Ok(())
    }

    async fn notify(&mut self, method: &str, params: serde_json::Value) -> anyhow::Result<()> {
        let line = serde_json::json!({"jsonrpc":"2.0", "method":method, "params":params}).to_string() + "\n";
        self.stdin.as_mut().ok_or_else(|| anyhow::anyhow!("MCP stdin unavailable"))?.write_all(line.as_bytes()).await?;
        Ok(())
    }

    async fn request(&mut self, method: &str, params: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        self.request_within(method, params, Duration::from_secs(120)).await
    }

    /// Same as `request`, with an explicit deadline. Handshake and discovery
    /// calls use short deadlines so a wedged helper is recycled in seconds,
    /// not after the 120 s tool budget.
    async fn request_within(&mut self, method: &str, params: serde_json::Value, deadline: Duration) -> anyhow::Result<serde_json::Value> {
        let request_id = self.next_id; self.next_id += 1;
        let line = serde_json::json!({"jsonrpc":"2.0", "id":request_id, "method":method, "params":params}).to_string() + "\n";
        self.stdin.as_mut().ok_or_else(|| anyhow::anyhow!("MCP stdin unavailable"))?.write_all(line.as_bytes()).await?;
        self.stdin.as_mut().unwrap().flush().await?;
        let stdout = self.stdout.as_mut().ok_or_else(|| anyhow::anyhow!("MCP stdout unavailable"))?;
        loop {
            let line = tokio::time::timeout(deadline, stdout.next_line()).await
                .map_err(|_| anyhow::anyhow!("MCP request timed out after {}s: {method}", deadline.as_secs()))??
                .ok_or_else(|| anyhow::anyhow!("MCP server exited while handling {method}"))?;
            let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
            if message.get("id").and_then(|v| v.as_u64()) != Some(request_id) { continue; }
            if let Some(error) = message.get("error") { anyhow::bail!("MCP {method} failed: {error}"); }
            return message.get("result").cloned().ok_or_else(|| anyhow::anyhow!("MCP {method} returned no result"));
        }
    }

    async fn list_tools(&mut self) -> anyhow::Result<Vec<serde_json::Value>> {
        self.ensure().await?;
        let result = self.request_within("tools/list", serde_json::json!({}), Duration::from_secs(25)).await?;
        self.tools = result.get("tools").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        Ok(self.tools.clone())
    }

    async fn probe_studio(&mut self) -> anyhow::Result<()> {
        let output = self.call_tool_within("get_studio_state", serde_json::json!({}), Duration::from_secs(15)).await?;
        let text = output.text;
        if text.is_empty() || text.contains("Unable to find an active Studio instance")
            || text.contains("previously active Studio has disconnected")
            || text.contains("no active Studio") {
            anyhow::bail!("Roblox Studio is not connected");
        }
        Ok(())
    }

    /// Does the cached schema of `name` declare a `studio_id` parameter? An
    /// unknown tool (schema not cached yet) counts as yes, like the official
    /// Python client does.
    fn tool_wants_studio_id(&self, name: &str) -> bool {
        let bare = name.rsplit('/').next().unwrap_or(name);
        match self.tools.iter().find(|t| t.get("name").and_then(|v| v.as_str()).map(|n| n == name || n == bare).unwrap_or(false)) {
            Some(tool) => tool.get("inputSchema").and_then(|s| s.get("properties")).and_then(|p| p.get("studio_id")).is_some(),
            None => true,
        }
    }

    /// Resolve the target `studio_id` via `list_roblox_studios` (cached 20 s).
    /// Prefers an entry flagged active, otherwise the first one listed.
    async fn resolve_studio_id(&mut self) -> Option<String> {
        if let Some((id, at)) = &self.studio_id {
            if at.elapsed() < Duration::from_secs(20) { return Some(id.clone()); }
        }
        let output = self.call_tool_within("list_roblox_studios", serde_json::json!({}), Duration::from_secs(15)).await.ok()?;
        let id = studio_id_from_listing(&output.text)?;
        self.studio_id = Some((id.clone(), std::time::Instant::now()));
        Some(id)
    }

    async fn call_tool(&mut self, name: &str, args: serde_json::Value) -> anyhow::Result<McpToolOutput> {
        let mut args = if args.is_object() { args } else { serde_json::json!({}) };
        let bare = name.rsplit('/').next().unwrap_or(name);
        let had_id = args.get("studio_id").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
        if !had_id && bare != "list_roblox_studios" && self.tool_wants_studio_id(name) {
            if let Some(id) = self.resolve_studio_id().await { args["studio_id"] = serde_json::Value::String(id); }
        }
        let retryable = !had_id && bare != "list_roblox_studios";
        match self.call_tool_within(name, args.clone(), Duration::from_secs(120)).await {
            // Studio sometimes reports the missing argument as a SUCCESS whose
            // text is just the complaint; treat it like the error form.
            Ok(output) if retryable && output.images.is_empty() && missing_studio_id(&output.text) => {
                match self.retry_with_fresh_studio_id(name, args).await {
                    Some(result) => result,
                    None => Ok(output),
                }
            }
            Ok(output) => Ok(output),
            Err(error) => {
                if retryable && missing_studio_id(&format!("{error:#}")) {
                    match self.retry_with_fresh_studio_id(name, args).await {
                        Some(result) => result,
                        None => Err(error.context("Studio MCP wants a studio_id but list_roblox_studios returned none — is a place open in Studio with the MCP server enabled?")),
                    }
                } else { Err(error) }
            }
        }
    }

    /// One retry with a freshly listed `studio_id` (the cached one may belong
    /// to a Studio that was restarted — ids change on every restart).
    /// `None` when no Studio could be listed (caller keeps its original outcome).
    async fn retry_with_fresh_studio_id(&mut self, name: &str, mut args: serde_json::Value) -> Option<anyhow::Result<McpToolOutput>> {
        self.studio_id = None;
        let id = self.resolve_studio_id().await?;
        tracing::warn!("call_tool '{name}' needs studio_id — retrying with {id}");
        args["studio_id"] = serde_json::Value::String(id);
        Some(self.call_tool_within(name, args, Duration::from_secs(120)).await)
    }

    async fn call_tool_within(&mut self, name: &str, args: serde_json::Value, deadline: Duration) -> anyhow::Result<McpToolOutput> {
        self.ensure().await?;
        let result = self.request_within("tools/call", serde_json::json!({"name":name, "arguments":args}), deadline).await?;
        let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
        let mut text_parts = Vec::new();
        let mut images = Vec::new();
        if let Some(items) = result.get("content").and_then(|v| v.as_array()) {
            for item in items {
                match item.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "text" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            text_parts.push(text.to_string());
                        }
                    }
                    "image" => {
                        if let Some(data) = item.get("data").and_then(|v| v.as_str()) {
                            let mime = item.get("mimeType").or_else(|| item.get("mime_type"))
                                .and_then(|v| v.as_str()).unwrap_or("image/png");
                            images.push(serde_json::json!({"mimeType": mime, "data": data}));
                        }
                    }
                    _ => {}
                }
            }
        }
        let text = if text_parts.is_empty() && images.is_empty() {
            result.to_string()
        } else {
            text_parts.join("\n")
        };
        if is_error { anyhow::bail!("{text}"); }
        Ok(McpToolOutput { text, images })
    }
}

/// Studio's complaint when a tool that requires `studio_id` is called without it.
fn missing_studio_id(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("missing required arg")
        || ((lower.contains("studio_id") || lower.contains("studio id"))
            && (lower.contains("required") || lower.contains("missing") || lower.contains("not connected") || lower.contains("unknown")))
}

/// Extract a `studio_id` from the `list_roblox_studios` text: a JSON array, a
/// JSON object carrying the array under studios/instances/data/result, or a
/// loose "studio_id: …" line. Prefers an entry flagged active.
fn studio_id_from_listing(text: &str) -> Option<String> {
    fn id_of(node: &serde_json::Value) -> Option<String> {
        for key in ["studio_id", "studioId", "id"] {
            if let Some(id) = node.get(key) {
                if let Some(s) = id.as_str() { if !s.is_empty() { return Some(s.to_string()); } }
                if let Some(n) = id.as_u64() { return Some(n.to_string()); }
            }
        }
        None
    }
    fn is_active(node: &serde_json::Value) -> bool {
        ["active", "is_active", "isActive", "focused"].iter().any(|k| node.get(k).and_then(|v| v.as_bool()).unwrap_or(false))
    }
    fn walk(node: &serde_json::Value, found: &mut Vec<(String, bool)>) {
        match node {
            serde_json::Value::Array(items) => for item in items { walk(item, found); },
            serde_json::Value::Object(map) => {
                if let Some(id) = id_of(node) { found.push((id, is_active(node))); }
                for (_, child) in map { if child.is_array() || child.is_object() { walk(child, found); } }
            }
            _ => {}
        }
    }
    let mut found = Vec::new();
    for start in [text.find('['), text.find('{')] {
        let Some(start) = start else { continue };
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(text[start..].trim()) { walk(&value, &mut found); }
        if found.is_empty() {
            // Trailing prose after the JSON: cut at the last bracket.
            if let Some(end) = text.rfind(|c| c == ']' || c == '}') {
                if end > start { if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text[start..=end]) { walk(&value, &mut found); } }
            }
        }
        if !found.is_empty() { break; }
    }
    if let Some((id, _)) = found.iter().find(|(_, active)| *active).or_else(|| found.first()) { return Some(id.clone()); }
    // Loose text: "studio_id: abc" / "Studio ID = abc" / "id": "abc"
    let lower = text.to_lowercase();
    for needle in ["studio_id", "studioid", "studio id", "\"id\""] {
        if let Some(pos) = lower.find(needle) {
            let Some(rest) = text.get(pos + needle.len()..) else { continue };
            let rest = rest.trim_start_matches(|c: char| c == ':' || c == '=' || c == '"' || c == '\'' || c.is_whitespace());
            let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.')).collect();
            if !id.is_empty() { return Some(id); }
        }
    }
    None
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ExecResult { id: String, ok: bool, result: String, error: Option<String>, }

#[cfg(windows)]
fn port_owner_pid(port: u16) -> Option<u32> {
    let out = std::process::Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .creation_flags(CREATE_NO_WINDOW)
        .output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let needle = format!(":{}", port);
    for line in text.lines() {
        if !line.contains("LISTENING") || !line.contains(&needle) { continue; }
        if let Some(pid) = line.split_whitespace().last().and_then(|s| s.parse::<u32>().ok()) {
            return Some(pid);
        }
    }
    None
}
#[cfg(not(windows))]
fn port_owner_pid(port: u16) -> Option<u32> {
    // lsof ships with macOS; -sTCP:LISTEN
    // ignores clients that merely connected to the port.
    let out = std::process::Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().find_map(|l| l.trim().parse::<u32>().ok())
}

#[cfg(windows)]
fn process_image(pid: u32) -> Option<String> {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next()
        .and_then(|l| l.split(',').next())
        .map(|s| s.trim_matches('"').to_lowercase())
}
#[cfg(not(windows))]
fn process_image(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() { None } else {
        Some(std::path::Path::new(&text).file_name().map(|f| f.to_string_lossy().to_lowercase()).unwrap_or(text.to_lowercase()))
    }
}

#[cfg(windows)]
fn reclaim_port(port: u16) -> anyhow::Result<()> {
    let Some(pid) = port_owner_pid(port) else { return Ok(()); };
    if pid == std::process::id() { return Ok(()); }
    let image = process_image(pid).unwrap_or_default();
    if image.contains("or-agent") || image.contains("or-core") || image.contains("totalscript-agent") || image.contains("robloxscript-agent") {
        tracing::info!("killing stale OR Agent (pid {pid}) on port {port}...");
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        std::thread::sleep(Duration::from_millis(800));
        if port_owner_pid(port).is_some() {
            anyhow::bail!("Could not free port {port} — close the old agent manually.");
        }
        tracing::info!("port {port} is free, starting fresh agent.");
        return Ok(());
    }
    if image.contains("python") || image.contains("py") {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        tracing::info!("killed stale python bridge (pid {pid}) on port {port}");
        std::thread::sleep(Duration::from_millis(600));
        return Ok(());
    }
    anyhow::bail!(
        "Port {port} is held by '{image}' (pid {pid}). Close that program or pick a\
        \ndifferent port, then start the agent again."
    );
}
#[cfg(not(windows))]
fn reclaim_port(port: u16) -> anyhow::Result<()> {
    let Some(pid) = port_owner_pid(port) else { return Ok(()); };
    if pid == std::process::id() { return Ok(()); }
    let image = process_image(pid).unwrap_or_default();
    if image.contains("or-agent") || image.contains("or-core") || image.contains("totalscript-agent") || image.contains("robloxscript-agent") {
        tracing::info!("killing stale OR Agent (pid {pid}) on port {port}...");
        let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
        std::thread::sleep(Duration::from_millis(800));
        if port_owner_pid(port).is_some() {
            anyhow::bail!("Could not free port {port} — close the old agent manually.");
        }
        tracing::info!("port {port} is free, starting fresh agent.");
        return Ok(());
    }
    if image.starts_with("python") {
        let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
        tracing::info!("killed stale python bridge (pid {pid}) on port {port}");
        std::thread::sleep(Duration::from_millis(600));
        return Ok(());
    }
    anyhow::bail!(
        "Port {port} is held by '{image}' (pid {pid}). Close that program or pick a\
        \ndifferent port, then start the agent again."
    );
}

fn env_first(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| std::env::var(k).ok().filter(|s| !s.trim().is_empty()))
}

fn main() {
    // Double-clicking or-core.exe while it is already in the notification area
    // should reopen that instance, not start a doomed second bridge on the same
    // ports. FindWindowW sees hidden windows too.
    #[cfg(windows)]
    if let Some(hwnd) = other_agent_window() {
        show_agent_window(hwnd);
        return;
    }
    // Every OS: a live bridge on 3000 that answers /api/window is ours — raise
    // it instead of failing on the busy ports. (`--headless` instances still
    // get replaced by reclaim_port below when they do not own a window.)
    if bridge_alive_on(3000) && !std::env::args().any(|a| a == "--headless") && ask_running_instance_to_show() {
        return;
    }

    std::panic::set_hook(Box::new(|info| {
        let msg = format!("{info}");
        #[cfg(windows)]
        win_alert("OR Agent crashed", &msg);
        eprintln!("OR Agent panic: {msg}");
    }));
    if let Err(e) = start() {
        let msg = format!("{e:#}");
        #[cfg(windows)]
        win_alert("OR Agent failed to start", &msg);
        eprintln!("OR Agent failed to start: {msg}");
        std::process::exit(1);
    }
}

#[tokio::main]
async fn start() -> anyhow::Result<()> {
    let args = Arc::new(Args::parse());
    let settings = gui::Settings::load();
    // Settings saved from the desktop window are applied before anything reads
    // the environment, so the launcher override and workspace root behave
    // exactly as if they had been passed through OR_* variables.
    if !settings.mcp_command.trim().is_empty() && env_first(&["OR_MCP_COMMAND", "ROBLOXSCRIPT_MCP_COMMAND"]).is_none() {
        std::env::set_var("OR_MCP_COMMAND", settings.mcp_command.trim());
    }
    let mcp_alive = Arc::new(AtomicBool::new(false));
    let roblox_proc = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(gui::UiShared::new(mcp_alive.clone()));
    init_file_logger(Some(shared.clone()));
    info!("=== OR Rust Agent v{} start (pid={}) ===", env!("CARGO_PKG_VERSION"), std::process::id());
    let start = std::time::Instant::now();
    let (result_tx, _) = broadcast::channel::<ExecResult>(128);
    let addr: SocketAddr = args.roblox_addr.parse().unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 3000)));
    let ws_override = env_first(&["OR_WORKSPACE_ROOT", "ROBLOXSCRIPT_WORKSPACE_ROOT"])
        .or_else(|| args.workspace.clone())
        .or_else(|| if settings.workspace_root.trim().is_empty() { None } else { Some(settings.workspace_root.trim().to_string()) });
    let workspace = Arc::new(workspace::Workspace::new(ws_override.as_deref())?);
    if settings.full_access || env_first(&["OR_FULL_ACCESS", "ROBLOXSCRIPT_FULL_ACCESS"]).map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false) {
        workspace.set_full_access(true);
    }
    shared.attach_workspace(workspace.root_display(), workspace.full_flag());
    shared.log(&format!("ORscript Desktop v{} — native bridge for roblox studio / local fs", env!("CARGO_PKG_VERSION")));
    shared.log(&format!("workspace: {}", workspace.root_display()));
    if workspace.full_access() { shared.log("FULL PC ACCESS enabled at boot (OR_FULL_ACCESS=1)"); }
    shared.log("listening: http://127.0.0.1:3000 · ws 17613 (roblox) · 17615 (agentscript)");
    shared.log(&format!("settings: {}", gui::Settings::path().display()));
    let state = AppState::new(result_tx, mcp_alive, roblox_proc.clone(), workspace, shared.clone());
    // Studio plugin: keep the local copy in sync with the one embedded in this
    // build. Studio picks the file up on its next start (or Plugins → reload).
    match plugin::install() {
        Ok(Some((path, changed))) => {
            shared.log(&format!("studio plugin: {}{}", path.display(), if changed { " (installed/updated - restart Studio once, then allow its HTTP prompt)" } else { "" }));
            state.plugin.set_installed(Some(path.display().to_string())).await;
        }
        Ok(None) => shared.log("studio plugin: auto-install skipped (no local Plugins folder on this platform or OR_NO_PLUGIN_INSTALL=1) - copy plugin/ORscript.lua into Studio's Plugins folder yourself"),
        Err(e) => shared.log(&format!("studio plugin: install failed ({e}) - copy plugin/ORscript.lua into Studio's Plugins folder yourself")),
    }
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<gui::UiCommand>();
    tokio::spawn(ui_command_loop(state.clone(), cmd_rx));
    let ui_for_server = shared.clone();
    let ui_for_fatal = shared.clone();
    let shutdown_state = state.clone();
    let server = tokio::spawn(async move {
        if let Err(e) = run_server(state, addr, start, ui_for_server).await {
            tracing::error!("{e:#}");
            ui_for_fatal.set_fatal(format!("{e:#}"));
        }
    });
    if args.headless {
        let _ = server.await;
        Ok(())
    } else {
        let start_hidden = args.hidden || settings.start_hidden;
        match gui::run_gui(shared, cmd_tx, settings, start_hidden) {
            Ok(()) => {
                info!("ORscript quit requested — killing MCP helper tree and exiting");
                shutdown_state.roblox_mcp.lock().await.reset().await;
                std::process::exit(0);
            }
            Err(e) => {
                tracing::error!("GUI unavailable ({e:#}) — continuing headless");
                #[cfg(windows)]
                win_alert(
                    "ORscript",
                    &format!("The desktop window could not open ({e:#}).\nThe bridge is still running in the background (ports 3000 / 17613 / 17615)."),
                );
                let _ = server.await;
                Ok(())
            }
        }
    }
}

fn gui_truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max { text.to_string() } else { format!("{}…", text.chars().take(max).collect::<String>()) }
}

/// Serve requests coming from the desktop window (and the tray menu).
async fn ui_command_loop(state: AppState, mut rx: tokio::sync::mpsc::UnboundedReceiver<gui::UiCommand>) {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            gui::UiCommand::RestartMcp => {
                info!("desktop window requested MCP restart — resetting helper then re-ensuring");
                state.ui.track("studio", "MCP helper restart requested");
                {
                    let mut mcp = state.roblox_mcp.lock().await;
                    mcp.reset().await;
                }
                set_editor(&state, false);
                match roblox_tools(&state).await {
                    Ok(tools) => {
                        let studio = {
                            let mut mcp = state.roblox_mcp.lock().await;
                            mcp.probe_studio().await.is_ok()
                        };
                        set_editor(&state, studio);
                        info!("MCP helper re-ensured ({} tools, studio={studio})", tools.len());
                    }
                    Err(e) => {
                        tracing::warn!("MCP re-ensure after restart failed: {e:#}");
                        state.ui.track("error", format!("MCP restart failed: {}", gui_truncate(&format!("{e:#}"), 160)));
                    }
                }
            }
            gui::UiCommand::ProbeStudio => {
                if state.mcp_in_flight.load(Ordering::Relaxed) > 0 {
                    state.ui.track("studio", "probe skipped — a Studio tool is still running");
                    continue;
                }
                let _busy = InFlight::enter(&state.mcp_in_flight);
                let probed = {
                    let mut mcp = state.roblox_mcp.lock().await;
                    match mcp.probe_studio().await {
                        Ok(()) => true,
                        Err(e) => { tracing::warn!("probe_studio: {e:#}"); if helper_is_dead(&e) { mcp.reset().await; } false }
                    }
                };
                set_editor(&state, probed && state.roblox_proc.load(Ordering::Relaxed));
                state.ui.track("studio", if probed { "probe OK — Studio answered get_studio_state" } else { "probe failed — Studio is not linked" });
            }
            gui::UiCommand::KillStudio => {
                let killed = kill_studio_processes();
                state.ui.track("studio", format!("kill requested — {killed} Roblox Studio process(es) terminated"));
                set_editor(&state, false);
            }
            gui::UiCommand::SetFullAccess(on) => {
                state.workspace.set_full_access(on);
                info!("FULL PC ACCESS set to {on} from the desktop window");
                state.ui.track("bridge", format!("FULL PC ACCESS {}", if on { "enabled" } else { "disabled" }));
            }
            gui::UiCommand::RunTool { engine, name, args, reply } => {
                let state2 = state.clone();
                tokio::spawn(async move {
                    let started = std::time::Instant::now();
                    let outcome: anyhow::Result<McpToolOutput> = match engine.as_str() {
                        "local" => workspace::dispatch(&state2.workspace, &name, args).await
                            .map(|text| McpToolOutput { text, images: Vec::new() })
                            .map_err(anyhow::Error::msg),
                        _ => if plugin::is_plugin_tool(&name) { plugin::call(&state2, &name, args).await } else { roblox_tool(&state2, &name, args).await },
                    };
                    let elapsed_ms = started.elapsed().as_millis();
                    let out = match outcome {
                        Ok(o) => {
                            state2.ui.track("tool", format!("{name} ({engine}) · {elapsed_ms} ms · toolkit"));
                            let images: Vec<(String, String)> = o.images.iter().filter_map(|img| {
                                let data = img.get("data").and_then(|v| v.as_str())?.to_string();
                                let mime = img.get("mimeType").and_then(|v| v.as_str()).unwrap_or("image/png").to_string();
                                Some((mime, data))
                            }).collect();
                            gui::ToolReply { ok: true, text: o.text, images, elapsed_ms }
                        }
                        Err(e) => {
                            state2.ui.track("error", format!("{name} ({engine}) failed: {}", gui_truncate(&e.to_string(), 140)));
                            gui::ToolReply { ok: false, text: format!("{e:#}"), images: Vec::new(), elapsed_ms }
                        }
                    };
                    let _ = reply.send(out);
                });
            }
            gui::UiCommand::RunCommand { command, reply } => {
                let state2 = state.clone();
                tokio::spawn(async move {
                    let started = std::time::Instant::now();
                    let result = workspace::dispatch(&state2.workspace, "run_command", serde_json::json!({"command": command})).await;
                    let elapsed_ms = started.elapsed().as_millis();
                    let out = match result {
                        Ok(text) => { state2.ui.track("tool", format!("run_command · {elapsed_ms} ms · terminal")); gui::ToolReply { ok: true, text, images: Vec::new(), elapsed_ms } }
                        Err(e) => { state2.ui.track("error", format!("run_command failed: {}", gui_truncate(&e, 140))); gui::ToolReply { ok: false, text: e, images: Vec::new(), elapsed_ms } }
                    };
                    let _ = reply.send(out);
                });
            }
            gui::UiCommand::ChatTurn { request, events, cancel } => {
                let state2 = state.clone();
                tokio::spawn(async move {
                    chat::run_turn(state2, request, events, cancel).await;
                });
            }
            gui::UiCommand::ChatModels { base_url, api_key, reply } => {
                tokio::spawn(async move {
                    let result = chat::list_models(&base_url, &api_key).await;
                    let _ = reply.send(result);
                });
            }
            gui::UiCommand::SetWorkspace { path, reply } => {
                let result = match state.workspace.set_root(&path) {
                    Ok(shown) => {
                        state.ui.attach_workspace(shown.clone(), state.workspace.full_flag());
                        state.ui.track("bridge", format!("workspace switched to {shown}"));
                        Ok(shown)
                    }
                    Err(e) => {
                        state.ui.track("error", format!("workspace switch failed: {}", gui_truncate(&format!("{e:#}"), 160)));
                        Err(format!("{e:#}"))
                    }
                };
                let _ = reply.send(result);
            }
            gui::UiCommand::SetMcpCommand(command) => {
                let command = command.trim().to_string();
                if command.is_empty() {
                    std::env::remove_var("OR_MCP_COMMAND");
                    state.ui.track("studio", "MCP launcher override cleared — using Studio's mcp.bat");
                } else {
                    std::env::set_var("OR_MCP_COMMAND", &command);
                    state.ui.track("studio", format!("MCP launcher set to {}", gui_truncate(&command, 120)));
                }
                info!("MCP launcher override updated from the desktop window");
            }
        }
    }
}

fn kill_studio_processes() -> usize {
    let mut sys = sysinfo::System::new_all();
    sys.refresh_all();
    let mut killed = 0;
    for (pid, process) in sys.processes() {
        if process.name().to_string_lossy().to_lowercase().contains("robloxstudio") {
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                killed += 1;
            }
            #[cfg(not(windows))]
            {
                if process.kill() { killed += 1; }
                let _ = pid;
            }
        }
    }
    killed
}

async fn run_server(state: AppState, addr: SocketAddr, start: std::time::Instant, ui: Arc<gui::UiShared>) -> anyhow::Result<()> {
    let watcher_state = state.clone();
    let watcher_ui = ui.clone();
    tokio::spawn(async move {
        let mut sys = sysinfo::System::new_all();
        sys.refresh_all();
        let has_roblox = sys.processes().values().any(|p| p.name().to_string_lossy().to_lowercase().contains("robloxstudio"));
        watcher_ui.studio_running.store(has_roblox, Ordering::Relaxed);
        watcher_state.roblox_proc.store(has_roblox, Ordering::Relaxed);
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            sys.refresh_all();
            let has_roblox = sys.processes().values().any(|p| p.name().to_string_lossy().to_lowercase().contains("robloxstudio"));
            watcher_ui.studio_running.store(has_roblox, Ordering::Relaxed);
            watcher_state.roblox_proc.store(has_roblox, Ordering::Relaxed);
            if !has_roblox {
                watcher_state.roblox_clients.write().await.clear();
                watcher_state.ui.set_clients("roblox", 0);
                set_editor(&watcher_state, false);
            }
        }
    });
    // Warm the Studio MCP helper so the Tools page and the Studio card are
    // populated before any extension connects, then keep the Studio link probed
    // every 10 s while nothing else owns the helper (a running execute_luau
    // always wins: we never touch the mutex while mcp_in_flight > 0).
    let warm_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let mut tick: u32 = 0;
        loop {
            let studio_proc = warm_state.roblox_proc.load(Ordering::Relaxed);
            let tools_known = !warm_state.ui.roblox_tools.lock().unwrap_or_else(|e| e.into_inner()).is_empty();
            let busy = warm_state.mcp_in_flight.load(Ordering::Relaxed) > 0;
            if !busy {
                if !tools_known {
                    // Retry every 30 s while Studio runs, every 3 min otherwise; only when the launcher exists.
                    let due = if studio_proc { tick % 3 == 0 } else { tick % 18 == 0 };
                    if due && McpRuntime::launcher().is_ok() {
                        match roblox_tools(&warm_state).await {
                            Ok(tools) => {
                                info!("MCP helper warmed: {} Studio tools", tools.len());
                                warm_state.ui.track("studio", format!("MCP helper ready — {} Studio tools", tools.len()));
                            }
                            Err(e) => tracing::warn!("MCP warm-up failed: {e:#}"),
                        }
                    }
                } else if studio_proc {
                    let _busy = InFlight::enter(&warm_state.mcp_in_flight);
                    let probed = {
                        let mut mcp = warm_state.roblox_mcp.lock().await;
                        mcp.probe_studio().await.is_ok()
                    };
                    set_editor(&warm_state, probed);
                }
            }
            tick = tick.wrapping_add(1);
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
    reclaim_port(17613).map_err(|e| { tracing::error!("{e}"); e })?;
    let s1 = state.clone();
    tokio::spawn(async move { let _ = run_legacy_ws(s1, 17613, "roblox").await; });
    reclaim_port(17615).map_err(|e| { tracing::error!("{e}"); e })?;
    let s3 = state.clone();
    tokio::spawn(async move { let _ = run_legacy_ws(s3, 17615, "local").await; });
    let ws_root_display = state.workspace.root_display();
    // CORS only ever reflects extension origins; web-page origins are refused
    // outright by `origin_guard` (which also rejects their preflights).
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &axum::http::HeaderValue, _parts: &axum::http::request::Parts| origin_allowed(origin.to_str().ok())))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);
    let app = Router::new()
        .route("/", get(|| async { Json(serde_json::json!({"ok": true, "service": "or-agent", "version": env!("CARGO_PKG_VERSION")})) }))
        .route("/api/connect", post(connect_handler))
        .route("/api/poll", get(poll_handler))
        .route("/api/push", post(push_handler))
        .route("/api/result", post(result_handler))
        .route("/api/disconnect", post(disconnect_handler))
        .route("/api/status", get(status_handler))
        .route("/api/local-full", post(local_full_handler))
        .route("/api/window", post(window_handler))
        .route("/api/plugin/hello", post(plugin::hello_handler))
        .route("/api/plugin/poll", get(plugin::poll_handler))
        .route("/api/plugin/result", post(plugin::result_handler))
        .route("/api/plugin/status", get(plugin::status_handler))
        .route("/api/plugin/config", post(plugin::config_handler))
        .route("/ws", get(ws_handler))
        .with_state(state)
        .layer(cors)
        .layer(axum::middleware::from_fn(origin_guard));
    let http_port = addr.port();
    reclaim_port(http_port).map_err(|e| { tracing::error!("{e}"); e })?;
    info!("OR bridge listening on http://{} (WS /ws)", addr);
    info!("Legacy WS on ws://127.0.0.1:17613 (roblox) and 17615 (AgentScript FS: {})", ws_root_display);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    ui.bridge_listening.store(true, Ordering::Relaxed);
    ui.track("bridge", "listening on http 3000 · ws 17613 (roblox) · ws 17615 (local)");
    info!("Boot completed in {}ms", start.elapsed().as_millis());
    axum::serve(listener, app).await?;
    Ok(())
}

async fn connect_handler(State(state): State<AppState>, Json(req): Json<serde_json::Value>) -> impl IntoResponse {
    let client_id = req.get("client_id").and_then(|v| v.as_str()).unwrap_or("studio-1").to_string();
    let engine = req.get("engine").and_then(|v| v.as_str()).unwrap_or("roblox").to_string();
    let editor_connected = if engine.to_lowercase() == "local" {
        state.local_clients.write().await.insert(client_id.clone(), engine.clone());
        publish_clients(&state, "local").await;
        state.workspace.ready()
    } else {
        state.roblox_clients.write().await.insert(client_id.clone(), engine.clone());
        publish_clients(&state, "roblox").await;
        state.roblox_editor_connected.load(Ordering::Relaxed)
    };
    Json(serde_json::json!({
        "ok": true,
        "bridge_registered": true,
        "editor_connected": editor_connected,
        "client_id": client_id,
    }))
}
async fn poll_handler(State(state): State<AppState>, Query(_q): Query<HashMap<String,String>>) -> impl IntoResponse {
    let queue = &state.roblox_queue;
    for _ in 0..50 {
        { let mut guard = queue.lock().await; if let Some(p) = guard.pop_front() { return Json(serde_json::json!({"ok": true, "payload": p})).into_response(); } }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Json(serde_json::json!({"ok": true, "payload": null})).into_response()
}
async fn push_handler(State(state): State<AppState>, Json(req): Json<serde_json::Value>) -> impl IntoResponse {
    let engine = req.get("engine").and_then(|v| v.as_str()).or(req.get("target").and_then(|v| v.as_str())).unwrap_or("roblox");
    let payload = if let Some(p) = req.get("payload") { serde_json::from_value::<Payload>(p.clone()).unwrap_or(Payload{id: format!("p-{}", chrono::Utc::now().timestamp_millis()), target: engine.to_string(), code: p.to_string(), language: "luau".into(), meta: p.clone()}) } else { Payload{id: req.get("id").and_then(|v| v.as_str()).unwrap_or(&format!("p-{}", chrono::Utc::now().timestamp_millis())).to_string(), target: engine.to_string(), code: req.get("code").and_then(|v| v.as_str()).unwrap_or("").to_string(), language: req.get("language").and_then(|v| v.as_str()).unwrap_or("luau").to_string(), meta: req.clone()} };
    state.roblox_queue.lock().await.push_back(payload.clone());
    Json(serde_json::json!({"ok": true, "queued": payload.id}))
}
async fn result_handler(State(state): State<AppState>, Json(res): Json<ExecResult>) -> impl IntoResponse {
    let _ = state.result_tx.send(res);
    Json(serde_json::json!({"ok": true}))
}
async fn disconnect_handler(State(state): State<AppState>, Json(req): Json<serde_json::Value>) -> impl IntoResponse {
    if let Some(id) = req.get("client_id").and_then(|v| v.as_str()) {
        state.roblox_clients.write().await.remove(id);
        state.local_clients.write().await.remove(id);
        publish_clients(&state, "roblox").await;
        publish_clients(&state, "local").await;
    }
    Json(serde_json::json!({"ok": true}))
}

#[derive(serde::Deserialize)]
struct LocalFullReq { enabled: bool }
async fn local_full_handler(State(state): State<AppState>, Json(req): Json<LocalFullReq>) -> impl IntoResponse {
    state.workspace.set_full_access(req.enabled);
    state.ui.track("bridge", format!("FULL PC ACCESS {} via HTTP", if req.enabled { "enabled" } else { "disabled" }));
    info!("local_full set to {} via HTTP", req.enabled);
    Json(serde_json::json!({"ok": true, "local_full": req.enabled}))
}

/// Window control from a second launch (`{"action":"show"|"hide"}`). Loopback only.
async fn window_handler(State(state): State<AppState>, Json(req): Json<serde_json::Value>) -> impl IntoResponse {
    let action = req.get("action").and_then(|v| v.as_str()).unwrap_or("show");
    match action {
        "hide" => gui::hide_window(),
        _ => gui::show_window(),
    }
    state.ui.track("app", &format!("window {action} requested by another launch"));
    Json(serde_json::json!({ "ok": true, "action": action }))
}

async fn status_handler(State(state): State<AppState>) -> impl IntoResponse {    Json(serde_json::json!({
        "roblox_connected": state.roblox_editor_connected.load(Ordering::Relaxed),
        "roblox_bridge_connected": state.roblox_clients.read().await.len() > 0,
        "local_bridge_connected": state.local_clients.read().await.len() > 0,
        "local_ready": state.workspace.ready(),
        "local_root": state.workspace.root_display(),
        "local_full": state.workspace.full_access(),
        "roblox_queue": state.roblox_queue.lock().await.len(),
        "roblox_proc": state.roblox_proc.load(Ordering::Relaxed),
        "mcp_busy": state.mcp_in_flight.load(Ordering::Relaxed) > 0,
        "plugin_connected": state.plugin.connected().await,
    }))
}
async fn ws_handler(ws: axum::extract::ws::WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

fn helper_is_dead(error: &anyhow::Error) -> bool {
    let msg = format!("{error:#}");
    msg.contains("exited") || msg.contains("timed out") || msg.contains("stdin unavailable")
        || msg.contains("stdout unavailable") || msg.contains("spawn failed")
}

struct InFlight<'a>(&'a AtomicUsize);
impl<'a> InFlight<'a> {
    fn enter(flag: &'a AtomicUsize) -> Self {
        flag.fetch_add(1, Ordering::Relaxed);
        InFlight(flag)
    }
}
impl Drop for InFlight<'_> {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::Relaxed); }
}

async fn roblox_tools(state: &AppState) -> anyhow::Result<Vec<serde_json::Value>> {
    let _busy = InFlight::enter(&state.mcp_in_flight);
    let mut mcp = state.roblox_mcp.lock().await;
    match mcp.list_tools().await {
        Ok(tools) => { state.ui.set_roblox_tools(&tools); Ok(tools) },
        Err(error) => {
            if !helper_is_dead(&error) { return Err(error); }
            tracing::warn!("list_tools failed ({error:#}) — recycling helper once");
            state.ui.track("studio", "Studio MCP helper stopped responding — restarting it");
            mcp.reset().await;
            match mcp.list_tools().await {
                Ok(tools) => { state.ui.set_roblox_tools(&tools); Ok(tools) },
                Err(error2) => {
                    tracing::warn!("list_tools retry failed: {error2:#}");
                    if helper_is_dead(&error2) { mcp.reset().await; }
                    Err(error2)
                }
            }
        }
    }
}

/// MCP tool list plus the ORscript Studio plugin's commands (only while the
/// plugin is connected; Open Cloud commands only once a key is set).
async fn roblox_tools_with_plugin(state: &AppState) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut tools = roblox_tools(state).await?;
    tools.extend(plugin::tools(state.plugin.connected().await, state.plugin.key().await.is_some()));
    Ok(tools)
}

async fn roblox_tool(state: &AppState, name: &str, args: serde_json::Value) -> anyhow::Result<McpToolOutput> {
    // execute_luau fast path: the Studio plugin runs Edit-mode Luau without the
    // stdio helper's 20 s budget and studio_id dance; MCP remains the fallback.
    if name.rsplit('/').next().unwrap_or(name) == "execute_luau" {
        if let Some(res) = plugin::try_execute_luau(state, &args).await {
            return res;
        }
    }
    let _busy = InFlight::enter(&state.mcp_in_flight);
    let mut mcp = state.roblox_mcp.lock().await;
    match mcp.call_tool(name, args.clone()).await {
        Ok(result) => Ok(result),
        Err(error) => {
            if !helper_is_dead(&error) { return Err(error); }
            if format!("{error:#}").contains("timed out") {
                tracing::warn!("call_tool '{name}' timed out — resetting helper without replay to avoid a second long stall");
                mcp.reset().await;
                return Err(error);
            }
            tracing::warn!("call_tool '{name}' failed ({error:#}) — recycling helper once");
            state.ui.track("studio", "Studio MCP helper stopped responding — restarting it");
            mcp.reset().await;
            match mcp.call_tool(name, args).await {
                Ok(result) => {
                    info!("call_tool '{name}' recovered after helper recycle");
                    Ok(result)
                }
                Err(error2) => {
                    tracing::warn!("call_tool '{name}' retry failed: {error2:#}");
                    if helper_is_dead(&error2) { mcp.reset().await; }
                    Err(error2)
                }
            }
        }
    }
}

async fn handle_ws(socket: axum::extract::ws::WebSocket, state: AppState) {
    let (mut send, mut recv) = socket.split();
    let mut rx = state.result_tx.subscribe();
    let send_task = tokio::spawn(async move { while let Ok(res) = rx.recv().await { let txt = serde_json::to_string(&res).unwrap_or_default(); if send.send(axum::extract::ws::Message::Text(txt)).await.is_err() { break; } } });
    while let Some(Ok(msg)) = recv.next().await {
        if let axum::extract::ws::Message::Text(txt) = msg {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&txt) {
                if val.get("code").is_some() {
                    let engine = val.get("engine").and_then(|v| v.as_str()).unwrap_or("roblox").to_string();
                    let payload = Payload{ id: val.get("id").and_then(|v| v.as_str()).unwrap_or("p-1").to_string(), target: engine.clone(), code: val.get("code").and_then(|v| v.as_str()).unwrap_or("").to_string(), language: "luau".into(), meta: val.clone()};
                    state.roblox_queue.lock().await.push_back(payload);
                }
            }
        }
    }
    send_task.abort();
}

async fn run_legacy_ws(state: AppState, port: u16, engine: &str) -> anyhow::Result<()> {
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse()?;
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            // Previously swallowed: the extension then dialled a port nobody
            // listened on and the window still claimed the bridge was fine.
            let msg = format!("WebSocket port {port} ({engine}) could not be opened: {e}. Close the program holding it and restart ORscript.");
            tracing::error!("{msg}");
            state.ui.set_fatal(msg.clone());
            anyhow::bail!(msg);
        }
    };
    info!("legacy WS [{engine}] listening on ws://127.0.0.1:{port}");
    loop {
        let (stream, _) = listener.accept().await?;
        let state = state.clone();
        let eng = engine.to_string();
        tokio::spawn(async move {
            // Same origin policy as the HTTP routes: web pages get a 403 at
            // the handshake and never see the tool catalogue.
            let guard = |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
                let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
                if origin_allowed(origin) {
                    Ok(resp)
                } else {
                    tracing::warn!("refused WebSocket from web origin {:?} on port {port}", origin.unwrap_or(""));
                    let mut err = tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(Some("ORscript bridge: requests from web pages are not allowed".to_string()));
                    *err.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                    Err(err)
                }
            };
            if let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, guard).await { handle_legacy_ws(ws, state, eng).await; }
        });
    }
}

async fn handle_legacy_ws(ws_stream: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>, state: AppState, engine: String) {
    let client_key = format!("ext-{engine}");
    if engine == "local" {
        state.local_clients.write().await.insert(client_key.clone(), engine.clone());
    } else {
        state.roblox_clients.write().await.insert(client_key.clone(), engine.clone());
    }
    publish_clients(&state, &engine).await;
    state.ui.track("bridge", format!("extension connected on the {engine} channel"));
    info!("legacy WS [{engine}] client connected");
    let (mut write, mut read) = ws_stream.split();
    // Outbound channel so ping/status keep flowing while a tool runs on another task.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(txt) = out_rx.recv().await {
            if write.send(tokio_tungstenite::tungstenite::Message::Text(txt.into())).await.is_err() { break; }
        }
    });
    let send_json = |tx: &tokio::sync::mpsc::UnboundedSender<String>, v: serde_json::Value| {
        let _ = tx.send(v.to_string());
    };

    let intro = tokio::time::timeout(Duration::from_secs(8), async {
        if engine == "local" {
            let ready = state.workspace.ready();
            let tools = workspace::catalog();
            serde_json::json!({"type":"connected","id":0,"ok":ready,"mcp_alive":ready,"studio":ready,"tools":tools,"servers":[{"id":"local","name":"Local Filesystem","alive":ready,"tools":if ready { tools.len() } else { 0 }}],"workspace_root":state.workspace.root_display()})
        } else {
            match roblox_tools_with_plugin(&state).await {
                Ok(tools) => {
                    let studio = {
                        let mut mcp = state.roblox_mcp.lock().await;
                        mcp.probe_studio().await.is_ok()
                    };
                    set_editor(&state, studio);
                    serde_json::json!({"type":"connected","id":0,"ok":studio,"mcp_alive":true,"studio":studio,"tools":tools,"servers":[{"id":"roblox","name":"Roblox Studio MCP","alive":studio,"tools":if studio { tools.len() } else { 0 }}]})
                },
                Err(_) => serde_json::json!({"type":"connected","id":0,"ok":false,"mcp_alive":false,"studio":false,"tools":[],"servers":[{"id":"roblox","name":"Roblox Studio MCP","alive":false,"tools":0}]}),
            }
        }
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({"type":"connected","id":0,"ok":false,"mcp_alive":false,"studio":false,"tools":[],"servers":[]}));
    send_json(&out_tx, intro);
    let mut last_online: Option<bool> = None;
    while let Some(Ok(msg)) = read.next().await {
        if let tokio_tungstenite::tungstenite::Message::Text(txt) = msg {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&txt) {
                let typ = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let id = val.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                match typ {
                    "ping" => { send_json(&out_tx, serde_json::json!({"type":"pong","id":id})); },
                    "list_tools" => {
                        let response = if engine == "local" {
                            let ready = state.workspace.ready();
                            let tools = workspace::catalog();
                            serde_json::json!({"type":"tools","id":id,"ok":ready,"mcp_alive":ready,"studio":ready,"tools":tools,"servers":[{"id":"local","name":"Local Filesystem","alive":ready,"tools":if ready { tools.len() } else { 0 }}]})
                        } else {
                            match roblox_tools_with_plugin(&state).await {
                                Ok(tools) => {
                                    let studio = if state.mcp_in_flight.load(Ordering::Relaxed) > 1 {
                                        // Another tool is in flight (list_tools itself holds 1). Skip extra probe.
                                        state.roblox_editor_connected.load(Ordering::Relaxed)
                                    } else {
                                        let mut mcp = state.roblox_mcp.lock().await;
                                        mcp.probe_studio().await.is_ok()
                                    };
                                    set_editor(&state, studio);
                                    serde_json::json!({"type":"tools","id":id,"ok":studio,"mcp_alive":true,"studio":studio,"tools":tools,"servers":[{"id":"roblox","name":"Roblox Studio MCP","alive":studio,"tools":if studio { tools.len() } else { 0 }}]})
                                },
                                Err(error) => serde_json::json!({"type":"tools","id":id,"ok":false,"mcp_alive":false,"studio":false,"tools":[],"error":error.to_string()}),
                            }
                        };
                        send_json(&out_tx, response);
                    },
                    "studio_status" => {
                        let online = match engine.as_str() {
                            "local" => state.workspace.ready(),
                            "roblox" => {
                                if state.mcp_in_flight.load(Ordering::Relaxed) > 0 {
                                    // Cached probe: a 20s execute_luau owns the helper.
                                    // Never lock / never mark MCP dead mid-tool.
                                    state.roblox_editor_connected.load(Ordering::Relaxed)
                                        && state.roblox_proc.load(Ordering::Relaxed)
                                } else {
                                    let probed = {
                                        let mut mcp = state.roblox_mcp.lock().await;
                                        mcp.probe_studio().await.is_ok()
                                    };
                                    probed && state.roblox_proc.load(Ordering::Relaxed)
                                }
                            }
                            _ => false,
                        };
                        if engine == "roblox" {
                            set_editor(&state, online);
                        }
                        if last_online != Some(online) {
                            info!("studio_status [{engine}]: {}", if online { "CONNECTED" } else { "OFFLINE" });
                            last_online = Some(online);
                        }
                        send_json(&out_tx, serde_json::json!({"type":"studio_status","id":id,"studio":online,"studio_app":online,"studio_proc":online}));
                    },
                    "restart_mcp" => {
                        let alive = if engine == "roblox" {
                            {
                                let mut mcp = state.roblox_mcp.lock().await;
                                mcp.reset().await;
                            }
                            set_editor(&state, false);
                            match roblox_tools_with_plugin(&state).await {
                                Ok(tools) => {
                                    let studio = {
                                        let mut mcp = state.roblox_mcp.lock().await;
                                        mcp.probe_studio().await.is_ok()
                                    };
                                    set_editor(&state, studio);
                                    send_json(&out_tx, serde_json::json!({"type":"mcp_status","id":id,"ok":true,"alive":true,"studio":studio,"tools":tools}));
                                    true
                                }
                                Err(error) => {
                                    tracing::warn!("restart_mcp re-ensure failed: {error:#}");
                                    send_json(&out_tx, serde_json::json!({"type":"mcp_status","id":id,"ok":false,"alive":false,"error":error.to_string()}));
                                    false
                                }
                            }
                        } else {
                            send_json(&out_tx, serde_json::json!({"type":"mcp_status","id":id,"ok":true,"alive":true}));
                            true
                        };
                        let _ = alive;
                    },
                    "call_tool" => {
                        let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                        let args = val.get("arguments").cloned().unwrap_or(serde_json::Value::Null);
                        let state2 = state.clone();
                        let eng = engine.clone();
                        let tx = out_tx.clone();
                        tokio::spawn(async move {
                            let started = std::time::Instant::now();
                            let outcome: anyhow::Result<McpToolOutput> = match eng.as_str() {
                                "local" => workspace::dispatch(&state2.workspace, &name, args).await
                                    .map(|text| McpToolOutput { text, images: Vec::new() })
                                    .map_err(anyhow::Error::msg),
                                "roblox" => if plugin::is_plugin_tool(&name) { plugin::call(&state2, &name, args).await } else { roblox_tool(&state2, &name, args).await },
                                _ => Err(anyhow::anyhow!("unknown engine")),
                            };
                            match &outcome {
                                Ok(_) => state2.ui.track("tool", format!("{name} ({eng}) · {} ms", started.elapsed().as_millis())),
                                Err(e) => state2.ui.track("error", format!("{name} ({eng}) failed: {}", gui_truncate(&e.to_string(), 140))),
                            }
                            let response = match outcome {
                                Ok(output) => serde_json::json!({
                                    "type":"tool_result", "id":id, "ok":true,
                                    "text":output.text, "images":output.images
                                }),
                                Err(error) => {
                                    let detail = error.to_string();
                                    let lower = detail.to_lowercase();
                                    let error_code = if lower.contains("not found") || lower.contains("unknown command") { "COMMAND_NOT_FOUND" }
                                        else if lower.contains("required") || lower.contains("invalid") || lower.contains("missing") { "INVALID_ARGUMENT" }
                                        else if lower.contains("offline") || lower.contains("not connected") || lower.contains("connection") { "STUDIO_BRIDGE_OFFLINE" }
                                        else { "TOOL_EXECUTION_ERROR" };
                                    serde_json::json!({"type":"tool_result","id":id,"ok":false,"kind":"execution","errorCode":error_code,"error":detail})
                                },
                            };
                            let _ = tx.send(response.to_string());
                        });
                    },
                    "add_server" | "remove_server" => { send_json(&out_tx, serde_json::json!({"type":"error","id":id,"errorCode":"UNSUPPORTED_BRIDGE_OPERATION","error":"Custom MCP servers are not supported by the native bridge yet; use Roblox Studio's built-in MCP server directly."})); },
                    _ => { send_json(&out_tx, serde_json::json!({"type":"error","id":id,"errorCode":"UNKNOWN_BRIDGE_MESSAGE","error":"unknown bridge message type"})); }
                }
            }
        }
    }
    drop(out_tx);
    let _ = writer.await;
    if engine == "local" {
        state.local_clients.write().await.remove(&client_key);
    } else {
        state.roblox_clients.write().await.remove(&client_key);
    }
    publish_clients(&state, &engine).await;
    state.ui.track("bridge", format!("extension disconnected from the {engine} channel"));
    if engine == "roblox" {
        set_editor(&state, false);
    }
    info!("legacy WS [{engine}] client disconnected");
}

#[cfg(test)]
mod origin_tests {
    use super::origin_allowed;

    #[test]
    fn extension_and_local_callers_pass_web_pages_do_not() {
        assert!(origin_allowed(None), "Studio plugin / curl send no Origin");
        assert!(origin_allowed(Some("")));
        assert!(origin_allowed(Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop")));
        assert!(origin_allowed(Some("moz-extension://3f2a6e7e-1c6e-4b1a-9c0d-0123456789ab")));
        assert!(origin_allowed(Some("Chrome-Extension://ABC")));
        for bad in ["https://evil.example", "http://127.0.0.1:3000", "http://localhost:8080", "null", "file://", "chrome-extension://", "https://chatgpt.com"] {
            assert!(!origin_allowed(Some(bad)), "{bad} must be refused");
        }
    }
}
