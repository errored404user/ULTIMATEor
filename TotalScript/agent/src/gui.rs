//! TotalScript Desktop — the native workspace window.
//!
//! Pure Rust (eframe/egui 0.29) with a notification-area icon (tray-icon 0.19
//! on Windows). The window is a *view* over the bridge that `main.rs` runs on
//! the tokio runtime: it reads shared state (`UiShared`) and asks the runtime
//! to do things through `UiCommand`s. Closing the window hides it to the tray;
//! the bridge (HTTP 3000, WS 17613 / 17615, Studio MCP helper) keeps running
//! until "Quit" is chosen from the tray menu or Settings.

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{Receiver, Sender},
        Arc, Mutex, OnceLock, RwLock,
    },
    time::{Duration, Instant},
};

use eframe::egui;
use egui::{Align, Color32, FontFamily, FontId, Layout, Margin, Pos2, RichText, Rounding, Sense, Stroke, TextStyle, Vec2};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;

// 2.11.0 sub-modules (TOTAL CORE rebuild): widget kit, notification center,
// command palette, Activity / Diagnostics centers and the Settings infrastructure.
mod kit;
mod notify;
mod palette;
mod center;
mod prefs;
use kit::*;
use notify::*;
use palette::*;
use center::*;
use prefs::*;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const APP_NAME: &str = "TotalScript";
/// Exact top-level window title. `main.rs` enumerates windows by this title
/// (and owning pid), so keep it distinctive — a bare "TotalScript" also matched
/// Explorer windows opened on the TotalScript folder.
pub const WINDOW_TITLE: &str = "TotalScript Desktop";
pub const REPO: &str = "errored404user/ULTIMATEor";
/// 1.74.0 — Donation game passes (name, Robux, roblox.com URL). Shown on Home
/// and in Settings → Donate; every button just opens the pass page.
pub const DONATION_PASSES: [(&str, u32, &str); 4] = [
    ("SmallDono", 10, "https://www.roblox.com/game-pass/1941336506/SmallDono"),
    ("NormalDono", 25, "https://www.roblox.com/game-pass/1941228530/NormalDono"),
    ("BigDono", 100, "https://www.roblox.com/game-pass/1940736510/BigDono"),
    ("HUGEDONO", 500, "https://www.roblox.com/game-pass/1941672495/HUGEDONO"),
];
const LOG_CAP: usize = 800;

/// egui context of the running window, so the tray thread / HTTP "show"
/// request can raise or hide the window on every platform.
static UI_CTX: OnceLock<egui::Context> = OnceLock::new();
/// True while the window is hidden to the tray. `App::update` then skips all
/// layout work and repaints every 2 s only (background CPU ≈ 0 instead of a
/// full UI frame every 700 ms for an invisible window).
static WINDOW_HIDDEN: AtomicBool = AtomicBool::new(false);
pub fn window_hidden() -> bool { WINDOW_HIDDEN.load(Ordering::Relaxed) }

/// Bring the window back (tray click, second launch, `/api/window`).
pub fn show_window() {
    WINDOW_HIDDEN.store(false, Ordering::Relaxed);
    if let Some(ctx) = UI_CTX.get() { ctx.request_repaint(); }
    #[cfg(windows)]
    if let Some(hwnd) = crate::agent_window() {
        crate::show_agent_window(hwnd);
        return;
    }
    if let Some(ctx) = UI_CTX.get() {
        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
        ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(false));
        ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
        ctx.request_repaint();
    }
}

/// Hide the window while the bridge keeps running.
pub fn hide_window() {
    WINDOW_HIDDEN.store(true, Ordering::Relaxed);
    #[cfg(windows)]
    if let Some(hwnd) = crate::agent_window() {
        crate::hide_agent_window(hwnd);
        return;
    }
    if let Some(ctx) = UI_CTX.get() {
        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(false));
        ctx.request_repaint();
    }
}

/// Ask the window to close for real (quit path). Falls back to a hard exit
/// when no window exists (headless or window creation failed).
pub fn request_quit(shared: &UiShared) {
    let quit = &shared.quit_requested;
    quit.store(true, Ordering::Release);
    // Hard fallback: a hidden winit window may never deliver the close event
    // (no frames are produced while invisible, and WM_CLOSE can be swallowed
    // when the viewport is mid-recreation). Quit must ALWAYS end the process,
    // otherwise the tray icon's "Quit" leaves an unreachable bridge behind.
    let _ = std::thread::Builder::new().name("totalscript-quit-fallback".into()).spawn(|| {
        std::thread::sleep(Duration::from_millis(4000));
        std::process::exit(0);
    });
    #[cfg(windows)]
    if let Some(hwnd) = crate::agent_window() {
        crate::show_agent_window(hwnd);
        crate::close_agent_window(hwnd);
        return;
    }
    match UI_CTX.get() {
        Some(ctx) => {
            ctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            ctx.request_repaint();
        }
        None => std::process::exit(0),
    }
}

/// Where settings.json and logs/ live.
/// Windows: next to the executable (portable, unchanged from total-core 1.18).
/// macOS: ~/Library/Application Support/TotalScript.
pub fn data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::current_exe().ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        let support = PathBuf::from(home).join("Library").join("Application Support");
        let new_dir = support.join("TotalScript");
        let legacy = support.join("ORscript");
        // Settings carry over from the ORscript-era app: keep using the old
        // folder when it exists and the new one has not been created yet.
        if !new_dir.exists() && legacy.exists() { legacy } else { new_dir }
    }
}

/// True when this build has a notification-area icon to come back from.
pub const HAS_TRAY: bool = cfg!(has_tray);
pub const OS_LABEL: &str = if cfg!(windows) { "Windows" } else { "macOS" };
const ACTIVITY_CAP: usize = 120;
const HISTORY_CAP: usize = 60;

// ───────────────────────────── shared state ─────────────────────────────

/// One tool the bridge can execute (Home / MCP Servers counts and the Studio tool catalogue).
#[derive(Clone, Debug)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub engine: &'static str,
    pub params: Vec<(String, bool)>,
}

impl ToolInfo {
    /// Build from an MCP `tools/list` entry (`{name, description, inputSchema}`).
    pub fn from_mcp(value: &serde_json::Value, engine: &'static str) -> Option<Self> {
        let name = value.get("name")?.as_str()?.to_string();
        let description = value.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let mut params = Vec::new();
        if let Some(schema) = value.get("inputSchema") {
            let required: Vec<String> = schema
                .get("required")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            if let Some(props) = schema.get("properties").and_then(|v| v.as_object()) {
                let mut keys: Vec<&String> = props.keys().collect();
                keys.sort();
                for key in keys {
                    params.push((key.clone(), required.iter().any(|r| r == key)));
                }
            }
        }
        Some(Self { name, description, engine, params })
    }
}

#[derive(Clone, Debug)]
pub struct Activity {
    pub at: String,
    pub kind: String,
    pub text: String,
}

/// Per-tool counters for the session report (name + engine → ok/fail/time).
#[derive(Default, Clone, Debug)]
pub struct ToolStat { pub ok: usize, pub fail: usize, pub total_ms: u128, pub max_ms: u128 }

/// 2.7: everything "Copy session report" prints. Fed by `track()` from the
/// same one-line activity texts the Home list shows, so there is exactly one
/// place that knows a tool ran — and it never stores arguments, results,
/// chat text or keys, only names, counts and timings.
#[derive(Default, Debug)]
pub struct SessionStats {
    pub started: String,
    pub tools: HashMap<String, ToolStat>,
    /// Where calls came from: chat · toolkit · terminal · extension.
    pub sources: HashMap<String, usize>,
    /// (clock, text) of the last errors, newest last.
    pub errors: VecDeque<(String, String)>,
    pub luau_warnings: usize,
}

const SESSION_ERRORS_CAP: usize = 30;

/// State shared between the tokio runtime (producer) and the window (consumer).
pub struct UiShared {
    pub studio_running: AtomicBool,
    pub mcp_alive: Arc<AtomicBool>,
    pub workspace_ready: AtomicBool,
    pub full_access: RwLock<Arc<AtomicBool>>,
    pub workspace_root: Mutex<String>,
    pub fatal: Mutex<Option<String>>,
    pub logs: Mutex<VecDeque<String>>,
    pub studio_connected: AtomicBool,
    pub roblox_clients: AtomicUsize,
    pub local_clients: AtomicUsize,
    pub roblox_tools: Mutex<Vec<ToolInfo>>,
    pub activity: Mutex<VecDeque<Activity>>,
    pub quit_requested: AtomicBool,
    /// HTTP 3000 + WS 17613 / 17615 are bound and accepting connections.
    pub bridge_listening: AtomicBool,
    /// Monotonic count of `track()` calls so the window can toast new events.
    pub activity_seq: AtomicUsize,
    pub boot: Instant,
    pub session: Mutex<SessionStats>,
    /// 2.8.0 pair mode mirror: switch, kept event count, findings per script.
    pub pair_enabled: AtomicBool,
    pub pair_events: AtomicUsize,
    pub pair_findings: Mutex<Vec<(String, usize)>>,
    pub pair_seq: AtomicUsize,
    /// Seconds since boot when the Studio plugin last talked to the bridge (0 = never).
    pub plugin_seen: AtomicUsize,
}

impl UiShared {
    pub fn new(mcp_alive: Arc<AtomicBool>) -> Self {
        Self {
            studio_running: AtomicBool::new(false),
            mcp_alive,
            workspace_ready: AtomicBool::new(false),
            full_access: RwLock::new(Arc::new(AtomicBool::new(false))),
            workspace_root: Mutex::new(String::new()),
            fatal: Mutex::new(None),
            logs: Mutex::new(VecDeque::with_capacity(LOG_CAP)),
            studio_connected: AtomicBool::new(false),
            roblox_clients: AtomicUsize::new(0),
            local_clients: AtomicUsize::new(0),
            roblox_tools: Mutex::new(Vec::new()),
            activity: Mutex::new(VecDeque::with_capacity(ACTIVITY_CAP)),
            quit_requested: AtomicBool::new(false),
            bridge_listening: AtomicBool::new(false),
            activity_seq: AtomicUsize::new(0),
            boot: Instant::now(),
            session: Mutex::new(SessionStats { started: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(), ..SessionStats::default() }),
            pair_enabled: AtomicBool::new(false),
            pair_events: AtomicUsize::new(0),
            pair_findings: Mutex::new(Vec::new()),
            pair_seq: AtomicUsize::new(0),
            plugin_seen: AtomicUsize::new(0),
        }
    }

    /// Called by every plugin HTTP handler; the plugin polls every ~20 s.
    pub fn plugin_touch(&self) {
        self.plugin_seen.store(self.boot.elapsed().as_secs() as usize + 1, Ordering::Relaxed);
    }

    /// The TotalScript Studio plugin talked to the bridge within the last 45 s.
    pub fn plugin_connected(&self) -> bool {
        let seen = self.plugin_seen.load(Ordering::Relaxed);
        seen > 0 && self.boot.elapsed().as_secs() as usize + 1 - seen < 45
    }

    /// Mirror of `plugin::Hub::pair_summary` for the window (no async there).
    pub fn set_pair(&self, enabled: bool, events: usize, findings: Vec<(String, usize)>) {
        self.pair_enabled.store(enabled, Ordering::Relaxed);
        self.pair_events.store(events, Ordering::Relaxed);
        *self.pair_findings.lock().unwrap_or_else(|e| e.into_inner()) = findings;
        self.pair_seq.fetch_add(1, Ordering::Relaxed);
    }

    pub fn attach_workspace(&self, root: String, full_flag: Arc<AtomicBool>) {
        self.workspace_ready.store(Path::new(&root).is_dir(), Ordering::Relaxed);
        *self.workspace_root.lock().unwrap_or_else(|e| e.into_inner()) = root;
        *self.full_access.write().unwrap_or_else(|e| e.into_inner()) = full_flag;
    }

    pub fn log(&self, text: &str) {
        let mut logs = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        for line in text.lines() {
            let line = line.trim_end();
            if line.is_empty() { continue; }
            if logs.len() >= LOG_CAP { logs.pop_front(); }
            logs.push_back(line.to_string());
        }
    }

    pub fn clear_logs(&self) {
        self.logs.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    pub fn set_fatal(&self, message: String) {
        self.log(&format!("FATAL {message}"));
        *self.fatal.lock().unwrap_or_else(|e| e.into_inner()) = Some(message);
    }

    pub fn full_access(&self) -> bool {
        self.full_access.read().unwrap_or_else(|e| e.into_inner()).load(Ordering::Relaxed)
    }

    pub fn root(&self) -> String {
        self.workspace_root.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Record a "Recent activity" entry (tool calls, connections, Studio state).
    pub fn track(&self, kind: &str, text: impl Into<String>) {
        let text = text.into();
        let at = chrono::Local::now().format("%H:%M:%S").to_string();
        self.record_session(kind, &text, &at);
        let mut list = self.activity.lock().unwrap_or_else(|e| e.into_inner());
        if list.len() >= ACTIVITY_CAP { list.pop_back(); }
        list.push_front(Activity { at, kind: kind.to_string(), text });
        self.activity_seq.fetch_add(1, Ordering::Relaxed);
    }

    /// Fold one activity line into the session counters. Tool lines look like
    /// `name (engine) · 123 ms · chat` (source optional = extension), errors
    /// like `name (engine) failed: …`; anything else is kept only as text.
    fn record_session(&self, kind: &str, text: &str, at: &str) {
        let mut st = self.session.lock().unwrap_or_else(|e| e.into_inner());
        match kind {
            "tool" => {
                let mut parts = text.split(" · ");
                let label = parts.next().unwrap_or(text).trim().to_string();
                let ms: u128 = parts.next().and_then(|p| p.trim().strip_suffix(" ms")).and_then(|n| n.trim().parse().ok()).unwrap_or(0);
                let source = parts.next().map(|p| p.trim().to_string()).unwrap_or_else(|| "extension".to_string());
                let e = st.tools.entry(label).or_default();
                e.ok += 1; e.total_ms += ms; if ms > e.max_ms { e.max_ms = ms; }
                *st.sources.entry(source).or_default() += 1;
            }
            "error" => {
                if let Some((label, _)) = text.split_once(" failed: ") {
                    st.tools.entry(label.trim().to_string()).or_default().fail += 1;
                }
                if st.errors.len() >= SESSION_ERRORS_CAP { st.errors.pop_front(); }
                st.errors.push_back((at.to_string(), text.to_string()));
            }
            "chat" if text.starts_with("luau_check:") => {
                let n: usize = text.split_whitespace().nth(1).and_then(|n| n.parse().ok()).unwrap_or(1);
                st.luau_warnings += n;
            }
            _ => {}
        }
    }

    /// Plain-text session report: counts, timings and the last errors —
    /// no tool arguments, no results, no chat text, no keys.
    pub fn session_report_text(&self) -> String {
        let st = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = String::new();
        out.push_str(&format!("TotalScript Desktop {} — session report\n", env!("CARGO_PKG_VERSION")));
        out.push_str(&format!("started: {} · uptime: {}\n", st.started, human_duration(self.boot.elapsed())));
        let calls: usize = st.tools.values().map(|t| t.ok + t.fail).sum();
        let ok: usize = st.tools.values().map(|t| t.ok).sum();
        let fails: usize = st.tools.values().map(|t| t.fail).sum();
        let total_ms: u128 = st.tools.values().map(|t| t.total_ms).sum();
        out.push_str(&format!("tool calls: {calls} ({ok} ok, {fails} failed) · tool time: {} · deprecated-API warnings: {}\n", human_duration(Duration::from_millis(total_ms.min(u64::MAX as u128) as u64)), st.luau_warnings));
        if !st.sources.is_empty() {
            let mut src: Vec<(&String, &usize)> = st.sources.iter().collect();
            src.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
            out.push_str(&format!("sources: {}\n", src.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(" · ")));
        }
        if calls == 0 {
            out.push_str("\nno tool has run yet in this session.\n");
        } else {
            out.push_str("\ntool                                      calls   ok  fail   avg ms   max ms\n");
            let mut rows: Vec<(&String, &ToolStat)> = st.tools.iter().collect();
            rows.sort_by(|a, b| (b.1.ok + b.1.fail).cmp(&(a.1.ok + a.1.fail)).then_with(|| a.0.cmp(b.0)));
            for (name, t) in rows.iter().take(30) {
                let n = t.ok + t.fail;
                let avg = if t.ok > 0 { t.total_ms / t.ok as u128 } else { 0 };
                out.push_str(&format!("{:<40} {:>6} {:>4} {:>5} {:>8} {:>8}\n", crate::gui_truncate(name, 40), n, t.ok, t.fail, avg, t.max_ms));
            }
            if rows.len() > 30 { out.push_str(&format!("… {} more tools\n", rows.len() - 30)); }
        }
        if !st.errors.is_empty() {
            out.push_str(&format!("\nlast {} error(s):\n", st.errors.len().min(10)));
            let skip = st.errors.len().saturating_sub(10);
            for (at, text) in st.errors.iter().skip(skip) { out.push_str(&format!("  {at}  {text}\n")); }
        }
        out
    }

    pub fn set_roblox_tools(&self, tools: &[serde_json::Value]) {
        let list: Vec<ToolInfo> = tools.iter().filter_map(|t| ToolInfo::from_mcp(t, "roblox")).collect();
        *self.roblox_tools.lock().unwrap_or_else(|e| e.into_inner()) = list;
    }

    pub fn set_clients(&self, engine: &str, count: usize) {
        if engine == "local" {
            self.local_clients.store(count, Ordering::Relaxed);
        } else {
            self.roblox_clients.store(count, Ordering::Relaxed);
        }
    }
}

// ───────────────────────────── commands ─────────────────────────────

pub struct ToolReply {
    pub ok: bool,
    pub text: String,
    /// `(mime type, base64 payload)` for every image block the tool returned.
    pub images: Vec<(String, String)>,
    pub elapsed_ms: u128,
}

/// Requests from the window to the bridge runtime (handled in `main.rs`).
pub enum UiCommand {
    RestartMcp,
    ProbeStudio,
    KillStudio,
    SetFullAccess(bool),
    SetWorkspace { path: String, reply: Sender<Result<String, String>> },
    /// Point reference_search at a notes folder (empty = off). Reply = shown path or None.
    SetReferenceDir { path: String, reply: Sender<Result<Option<String>, String>> },
    SetMcpCommand(String),
    /// 2.8.0 pair mode on / off (persisted; forwarded to the Studio plugin).
    SetPair(bool),
    RunTool { engine: String, name: String, args: serde_json::Value, reply: Sender<ToolReply> },
    RunCommand { command: String, reply: Sender<ToolReply> },
    /// One AI chat turn (side panel). Events stream back until `Finished`.
    ChatTurn { request: crate::chat::TurnRequest, events: Sender<crate::chat::ChatEvent>, cancel: Arc<AtomicBool> },
    /// `GET {base_url}/models` for the chat model picker.
    ChatModels { base_url: String, api_key: String, reply: Sender<Result<Vec<String>, String>> },
}

// ───────────────────────────── settings ─────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: String,
    pub close_to_tray: bool,
    pub start_hidden: bool,
    pub launch_at_login: bool,
    pub workspace_root: String,
    /// 2.7: optional folder of Markdown notes for reference_search (empty = off).
    pub reference_dir: String,
    pub mcp_command: String,
    pub full_access: bool,
    pub compact: bool,
    /// Last window size in logical points (0 = default). Restored on launch.
    pub window_width: f32,
    pub window_height: f32,
    /// Show the setup checklist on Home even when everything is green.
    pub show_checklist: bool,
    // ── AI chat side panel (1.37) ──
    /// Provider preset id (see `chat::PROVIDERS`).
    pub chat_provider: String,
    /// Base URL for the `custom` preset.
    pub chat_custom_url: String,
    /// API keys per provider id. Stored in settings.json on this PC only.
    pub chat_keys: HashMap<String, String>,
    /// Last chosen model per provider id.
    pub chat_models: HashMap<String, String>,
    /// Give the model the bridge's tools (Studio + plugin + workspace).
    pub chat_tools: bool,
    /// Forward screenshots returned by tools to the model (vision models).
    pub chat_send_images: bool,
    /// Max model round-trips per user message.
    pub chat_max_steps: u32,
    pub chat_temperature: f32,
    /// Extra standing instructions appended to the system prompt.
    pub chat_instructions: String,
    pub chat_panel_open: bool,
    pub chat_panel_width: f32,
    // ── look & feel (2.6.0) ──
    /// Custom accent as "#rrggbb"; empty = the palette's own accent.
    pub accent: String,
    /// Corner style: 0 = sharp, 1 = soft (default), 2 = round.
    pub corners: u8,
    /// UI zoom: 0.9 … 1.25 (1.0 = default).
    pub ui_scale: f32,
    /// Hover / page / pulse animations.
    pub motion: bool,
    /// Faint geometric backdrop behind every page.
    pub backdrop: bool,
    /// Accent glow around primary buttons and the active nav item.
    pub glow: bool,
    /// Sidebar as a narrow icon rail (also automatic on narrow windows).
    pub sidebar_rail: bool,
    /// Second line under every sidebar title.
    pub sidebar_blurbs: bool,
    /// 2.8.0 pair mode: the Studio plugin reports what you do by hand and the
    /// chat model sees it (restored on the next start).
    pub pair_mode: bool,
    // ── 2.11.0 TOTAL CORE ──
    /// Dashboard cards on Home.
    pub home_quick: bool,
    pub home_stats: bool,
    pub home_recent: bool,
    pub home_viewport: bool,
    /// Command palette: last eight command titles, newest first.
    pub recent_commands: Vec<String>,
    /// Workspace Manager: folders applied before, newest first (max 8), and starred ones.
    pub recent_workspaces: Vec<String>,
    pub favorite_workspaces: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "aqua".into(),
            close_to_tray: true,
            start_hidden: false,
            launch_at_login: false,
            workspace_root: String::new(),
            reference_dir: String::new(),
            mcp_command: String::new(),
            full_access: false,
            compact: false,
            window_width: 0.0,
            window_height: 0.0,
            show_checklist: true,
            chat_provider: "codecraft".into(),
            chat_custom_url: String::new(),
            chat_keys: HashMap::new(),
            chat_models: HashMap::new(),
            chat_tools: true,
            chat_send_images: true,
            chat_max_steps: 16,
            chat_temperature: 0.3,
            chat_instructions: String::new(),
            chat_panel_open: false,
            chat_panel_width: 400.0,
            accent: String::new(),
            corners: 1,
            ui_scale: 1.0,
            motion: true,
            backdrop: true,
            glow: true,
            pair_mode: false,
            sidebar_rail: false,
            sidebar_blurbs: true,
            home_quick: true,
            home_stats: true,
            home_recent: true,
            home_viewport: true,
            recent_commands: Vec::new(),
            recent_workspaces: Vec::new(),
            favorite_workspaces: Vec::new(),
        }
    }
}

impl Settings {
    pub fn path() -> PathBuf {
        data_dir().join("settings.json")
    }

    pub fn load() -> Self {
        std::fs::read_to_string(Self::path())
            .ok()
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let _ = std::fs::create_dir_all(data_dir());
        std::fs::write(Self::path(), text).map_err(|e| e.to_string())
    }
}

// ───────────────────────────── theme ─────────────────────────────

#[derive(Clone, Copy)]
struct Theme {
    bg: Color32,
    bg2: Color32,
    panel: Color32,
    panel2: Color32,
    border: Color32,
    border2: Color32,
    text: Color32,
    muted: Color32,
    accent: Color32,
    accent2: Color32,
    accent_ink: Color32,
    ok: Color32,
    warn: Color32,
    bad: Color32,
    info: Color32,
    /// Light palettes invert the surface ladder (panels get darker, not lighter).
    light: bool,
    /// Corner radii (2.10.0 design tokens): buttons / inputs, cards, chips.
    /// Set from Settings → Corners so every surface follows the same choice.
    r_btn: f32,
    r_card: f32,
    r_chip: f32,
}

/// One entry of the Appearance palette grid. Surfaces (panel, border…) are
/// derived from `bg` tinted towards `accent`, so every palette stays coherent
/// and a new one is a single line here.
struct Palette {
    id: &'static str,
    name: &'static str,
    blurb: &'static str,
    light: bool,
    bg: [u8; 3],
    text: [u8; 3],
    muted: [u8; 3],
    accent: [u8; 3],
    accent2: [u8; 3],
    accent_ink: [u8; 3],
}

const PALETTES: &[Palette] = &[
    // Aqua — the default since 1.71.0 (matches the extension's Aqua skin).
    Palette { id: "aqua", name: "TotalScript Aqua", blurb: "Deep teal, cyan accent — the default", light: false, bg: [3, 22, 28], text: [230, 255, 251], muted: [127, 200, 192], accent: [34, 211, 238], accent2: [20, 184, 166], accent_ink: [3, 32, 36] },
    Palette { id: "gold", name: "Gold", blurb: "Warm black with amber highlights", light: false, bg: [9, 9, 11], text: [244, 244, 245], muted: [161, 161, 170], accent: [245, 158, 11], accent2: [251, 191, 36], accent_ink: [20, 14, 2] },
    Palette { id: "emerald", name: "Emerald", blurb: "Forest green, mint accent", light: false, bg: [7, 14, 12], text: [236, 253, 245], muted: [134, 180, 160], accent: [52, 211, 153], accent2: [16, 185, 129], accent_ink: [2, 24, 16] },
    Palette { id: "graphite", name: "Graphite", blurb: "Neutral slate, no colour cast", light: false, bg: [12, 13, 16], text: [241, 245, 249], muted: [148, 163, 184], accent: [226, 232, 240], accent2: [148, 163, 184], accent_ink: [15, 18, 24] },
    Palette { id: "midnight", name: "Midnight", blurb: "Navy night sky with sky-blue accent", light: false, bg: [8, 13, 30], text: [232, 238, 255], muted: [141, 156, 196], accent: [96, 165, 250], accent2: [129, 140, 248], accent_ink: [6, 14, 36] },
    Palette { id: "nord", name: "Nord", blurb: "Arctic blue-grey, frost accent", light: false, bg: [36, 41, 51], text: [236, 239, 244], muted: [160, 170, 190], accent: [136, 192, 208], accent2: [129, 161, 193], accent_ink: [24, 30, 40] },
    Palette { id: "violet", name: "Violet", blurb: "Plum dark with lavender glow", light: false, bg: [19, 12, 32], text: [243, 236, 255], muted: [170, 152, 200], accent: [167, 139, 250], accent2: [192, 132, 252], accent_ink: [22, 10, 44] },
    Palette { id: "rose", name: "Rosé", blurb: "Charcoal with pink-rose accent", light: false, bg: [26, 12, 18], text: [255, 240, 246], muted: [200, 150, 170], accent: [251, 113, 133], accent2: [244, 114, 182], accent_ink: [40, 8, 18] },
    Palette { id: "crimson", name: "Crimson", blurb: "Near-black with red accents", light: false, bg: [16, 8, 10], text: [250, 240, 240], muted: [170, 140, 145], accent: [239, 68, 68], accent2: [251, 113, 133], accent_ink: [36, 6, 8] },
    Palette { id: "sunset", name: "Sunset", blurb: "Dusk purple with coral accent", light: false, bg: [24, 12, 28], text: [255, 244, 238], muted: [196, 160, 170], accent: [251, 146, 60], accent2: [244, 114, 182], accent_ink: [40, 14, 6] },
    Palette { id: "ocean", name: "Ocean", blurb: "Deep blue water, aquamarine accent", light: false, bg: [4, 18, 36], text: [230, 244, 255], muted: [130, 170, 200], accent: [45, 212, 191], accent2: [56, 189, 248], accent_ink: [2, 30, 34] },
    Palette { id: "mocha", name: "Mocha", blurb: "Espresso brown, caramel accent", light: false, bg: [22, 16, 13], text: [250, 243, 236], muted: [180, 160, 145], accent: [217, 160, 102], accent2: [232, 190, 140], accent_ink: [34, 20, 8] },
    Palette { id: "forest", name: "Forest", blurb: "Moss and lime for a calmer screen", light: false, bg: [10, 18, 10], text: [240, 250, 236], muted: [150, 180, 140], accent: [163, 230, 53], accent2: [74, 222, 128], accent_ink: [12, 30, 4] },
    Palette { id: "paper", name: "Paper", blurb: "Light — warm white with ink text", light: true, bg: [247, 245, 240], text: [28, 25, 23], muted: [110, 104, 96], accent: [14, 116, 144], accent2: [8, 145, 178], accent_ink: [255, 255, 255] },
    Palette { id: "snow", name: "Snow", blurb: "Light — cool white with blue accent", light: true, bg: [244, 247, 251], text: [15, 23, 42], muted: [100, 116, 139], accent: [37, 99, 235], accent2: [79, 70, 229], accent_ink: [255, 255, 255] },
    Palette { id: "sage", name: "Sage", blurb: "Light — soft green tint, emerald accent", light: true, bg: [242, 247, 243], text: [20, 36, 28], muted: [96, 122, 108], accent: [5, 150, 105], accent2: [13, 148, 136], accent_ink: [255, 255, 255] },
];

fn rgb(c: [u8; 3]) -> Color32 { Color32::from_rgb(c[0], c[1], c[2]) }

/// Linear blend `a → b` by `k` (0..1), per channel.
fn mix(a: Color32, b: Color32, k: f32) -> Color32 {
    let k = k.clamp(0.0, 1.0);
    let ch = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * k).round().clamp(0.0, 255.0) as u8;
    Color32::from_rgb(ch(a.r(), b.r()), ch(a.g(), b.g()), ch(a.b(), b.b()))
}

/// `color` at `alpha` (0..255) — for glows, backdrops and hover washes.
fn alpha(c: Color32, a: u8) -> Color32 { Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a) }

/// Relative brightness 0..1 (sRGB weights) — picks readable ink for a custom accent.
fn luma(c: Color32) -> f32 { (0.2126 * c.r() as f32 + 0.7152 * c.g() as f32 + 0.0722 * c.b() as f32) / 255.0 }

/// "#rrggbb" / "rrggbb" → colour; anything else → None (= palette default).
fn parse_hex(text: &str) -> Option<Color32> {
    let h = text.trim().trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) { return None; }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some(Color32::from_rgb((v >> 16) as u8, (v >> 8) as u8, v as u8))
}

fn to_hex(c: Color32) -> String { format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b()) }

/// Corner radius for the chosen corner style (0 sharp / 1 soft / 2 round).
fn corner(settings_corners: u8, soft: f32) -> f32 {
    match settings_corners { 0 => (soft * 0.35).round(), 2 => (soft * 1.5).round(), _ => soft }
}

// ───────────────────────────── fonts ─────────────────────────────
//
// 2.10.0: the window ships its own text faces instead of egui's defaults.
// egui's Ubuntu-Light has no "→" (U+2192) — the glyph this UI uses in 60+
// labels — so every arrow rendered as the "◻" replacement box, and a Light
// weight at 14 px reads thin on Windows. Inter (SIL OFL, subset to Latin +
// Latin Extended + Greek + Cyrillic + punctuation + arrows + symbols, see
// assets/fonts/) covers Turkish (ç ğ ı İ ö ş ü) and the arrows; Medium and
// SemiBold give buttons and headings real weight instead of a colour change.
// Hack stays the monospace face; Inter sits behind it as the first fallback.

const FONT_MEDIUM: &str = "inter-medium";
const FONT_SEMIBOLD: &str = "inter-semibold";
fn family_medium() -> FontFamily { FontFamily::Name(FONT_MEDIUM.into()) }
fn family_semibold() -> FontFamily { FontFamily::Name(FONT_SEMIBOLD.into()) }
/// Medium-weight proportional text at `size` (labels on buttons, row titles).
fn font_medium(size: f32) -> FontId { FontId::new(size, family_medium()) }
/// SemiBold proportional text at `size` (headings, numbers that must pop).
fn font_semibold(size: f32) -> FontId { FontId::new(size, family_semibold()) }

fn install_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    fonts.font_data.insert("Inter".into(), egui::FontData::from_static(include_bytes!("../assets/fonts/Inter-Regular.ttf")));
    fonts.font_data.insert("InterMedium".into(), egui::FontData::from_static(include_bytes!("../assets/fonts/Inter-Medium.ttf")));
    fonts.font_data.insert("InterSemiBold".into(), egui::FontData::from_static(include_bytes!("../assets/fonts/Inter-SemiBold.ttf")));
    // Proportional: Inter first, egui's own faces (Ubuntu-Light, Noto Emoji,
    // the emoji icon font) stay behind it as fallbacks for anything exotic.
    let prop = fonts.families.entry(FontFamily::Proportional).or_default();
    prop.insert(0, "Inter".into());
    let fallbacks = prop.clone();
    let mut medium = vec!["InterMedium".to_string()]; medium.extend(fallbacks.iter().cloned());
    let mut semibold = vec!["InterSemiBold".to_string()]; semibold.extend(fallbacks.iter().cloned());
    fonts.families.insert(family_medium(), medium);
    fonts.families.insert(family_semibold(), semibold);
    // Monospace: Hack first (code, paths, logs), Inter as the first fallback
    // so a Turkish or symbol character in a path never becomes a box.
    let mono = fonts.families.entry(FontFamily::Monospace).or_default();
    mono.insert(1.min(mono.len()), "Inter".into());
    ctx.set_fonts(fonts);
}

impl Theme {
    fn palette(id: &str) -> &'static Palette {
        PALETTES.iter().find(|p| p.id == id).unwrap_or(&PALETTES[0])
    }

    fn by_id(id: &str) -> Theme { Theme::build(Theme::palette(id), None) }

    /// Palette + the user's Settings (custom accent).
    fn from_settings(settings: &Settings) -> Theme {
        let mut t = Theme::build(Theme::palette(&settings.theme), parse_hex(&settings.accent));
        t.r_btn = corner(settings.corners, 8.0);
        t.r_card = corner(settings.corners, 12.0);
        t.r_chip = corner(settings.corners, 6.0);
        t
    }

    fn build(p: &Palette, accent_override: Option<Color32>) -> Theme {
        let bg = rgb(p.bg);
        let text = rgb(p.text);
        let (accent, accent2, accent_ink) = match accent_override {
            // A custom accent: the companion tone leans towards white, the ink
            // flips with the accent's brightness so button text stays readable.
            Some(a) => (a, mix(a, Color32::WHITE, 0.22), if luma(a) > 0.55 { mix(a, Color32::BLACK, 0.85) } else { Color32::WHITE }),
            None => (rgb(p.accent), rgb(p.accent2), rgb(p.accent_ink)),
        };
        if p.light {
            let ink = text;
            Theme {
                bg,
                bg2: mix(bg, ink, 0.035),
                panel: mix(bg, Color32::WHITE, 0.6),
                panel2: mix(bg, ink, 0.05),
                border: mix(bg, ink, 0.14),
                border2: mix(bg, ink, 0.28),
                text,
                muted: rgb(p.muted),
                accent,
                accent2,
                accent_ink,
                ok: Color32::from_rgb(22, 163, 74),
                warn: Color32::from_rgb(180, 120, 0),
                bad: Color32::from_rgb(220, 38, 38),
                info: Color32::from_rgb(2, 132, 199),
                light: true,
                r_btn: 8.0,
                r_card: 12.0,
                r_chip: 6.0,
            }
        } else {
            Theme {
                bg,
                bg2: mix(bg, accent, 0.035),
                panel: mix(bg, accent, 0.08),
                panel2: mix(bg, accent, 0.14),
                border: mix(bg, accent, 0.30),
                border2: mix(bg, accent, 0.50),
                text,
                muted: rgb(p.muted),
                accent,
                accent2,
                accent_ink,
                ok: Color32::from_rgb(86, 222, 134),
                warn: Color32::from_rgb(250, 204, 21),
                bad: Color32::from_rgb(248, 113, 113),
                info: Color32::from_rgb(125, 211, 252),
                light: false,
                r_btn: 8.0,
                r_card: 12.0,
                r_chip: 6.0,
            }
        }
    }

    fn apply(&self, ctx: &egui::Context, settings: &Settings) {
        let compact = settings.compact;
        let r = self.r_btn;
        ctx.set_zoom_factor(settings.ui_scale.clamp(0.8, 1.5));
        let mut style = (*ctx.style()).clone();
        let base = if compact { 13.0 } else { 14.0 };
        style.text_styles = [
            (TextStyle::Heading, font_semibold(base + 8.0)),
            (TextStyle::Body, FontId::new(base, FontFamily::Proportional)),
            (TextStyle::Button, font_medium(base)),
            (TextStyle::Small, FontId::new(base - 2.0, FontFamily::Proportional)),
            (TextStyle::Monospace, FontId::new(base - 1.0, FontFamily::Monospace)),
        ]
        .into();
        style.spacing.item_spacing = Vec2::new(10.0, 8.0);
        style.spacing.button_padding = Vec2::new(14.0, 8.0);
        style.spacing.interact_size = Vec2::new(40.0, 32.0);
        style.spacing.indent = 18.0;
        style.spacing.scroll.bar_width = 8.0;

        let mut v = if self.light { egui::Visuals::light() } else { egui::Visuals::dark() };
        v.override_text_color = Some(self.text);
        v.panel_fill = self.bg;
        v.window_fill = self.panel;
        v.window_stroke = Stroke::new(1.0_f32, self.border2);
        v.window_rounding = Rounding::same(self.r_card);
        v.menu_rounding = Rounding::same(r);
        v.extreme_bg_color = self.bg2;
        v.faint_bg_color = self.panel2;
        v.code_bg_color = self.bg2;
        v.hyperlink_color = self.accent;
        v.warn_fg_color = self.warn;
        v.error_fg_color = self.bad;
        v.selection.bg_fill = self.accent.linear_multiply(0.35);
        v.selection.stroke = Stroke::new(1.0_f32, self.accent);

        v.widgets.noninteractive.bg_fill = self.panel;
        v.widgets.noninteractive.weak_bg_fill = self.panel;
        v.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, self.border);
        v.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, self.text);
        v.widgets.noninteractive.rounding = Rounding::same(r);

        v.widgets.inactive.bg_fill = self.panel2;
        v.widgets.inactive.weak_bg_fill = self.panel2;
        v.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, self.border);
        v.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, self.text);
        v.widgets.inactive.rounding = Rounding::same(r);

        v.widgets.hovered.bg_fill = self.border;
        v.widgets.hovered.weak_bg_fill = self.border;
        v.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, self.border2);
        v.widgets.hovered.fg_stroke = Stroke::new(1.5_f32, self.text);
        v.widgets.hovered.rounding = Rounding::same(r);

        v.widgets.active.bg_fill = self.border2;
        v.widgets.active.weak_bg_fill = self.border2;
        v.widgets.active.bg_stroke = Stroke::new(1.0_f32, self.accent);
        v.widgets.active.fg_stroke = Stroke::new(1.5_f32, self.text);
        v.widgets.active.rounding = Rounding::same(r);

        v.widgets.open.bg_fill = self.panel2;
        v.widgets.open.weak_bg_fill = self.panel2;
        v.widgets.open.bg_stroke = Stroke::new(1.0_f32, self.accent);
        v.widgets.open.fg_stroke = Stroke::new(1.0_f32, self.text);
        v.widgets.open.rounding = Rounding::same(r);

        style.visuals = v;
        ctx.set_style(style);
    }
}

// ───────────────────────────── pages ─────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Page { Home, Chat, Explorer, Servers, Terminal, Activity, Diagnostics, Help, Settings }

impl Page {
    const ALL: [Page; 9] = [Page::Home, Page::Chat, Page::Explorer, Page::Servers, Page::Terminal, Page::Activity, Page::Diagnostics, Page::Help, Page::Settings];

    fn title(self) -> &'static str {
        match self {
            Page::Home => "Home",
            Page::Chat => "AI Chat",
            Page::Explorer => "Explorer",
            Page::Servers => "MCP Servers",
            Page::Terminal => "Terminal",
            Page::Activity => "Activity",
            Page::Diagnostics => "Diagnostics",
            Page::Help => "Help",
            Page::Settings => "Settings",
        }
    }

    /// Two or three words under the sidebar title (the reference look:
    /// "Overview / At a glance", "Settings / Make it yours").
    fn blurb(self) -> &'static str {
        match self {
            Page::Home => "At a glance",
            Page::Chat => "Your model, in Studio",
            Page::Explorer => "Workspace files",
            Page::Servers => "MCP & channels",
            Page::Terminal => "Console & Luau",
            Page::Activity => "Jobs, feed & session",
            Page::Diagnostics => "Checks & fixes",
            Page::Help => "Setup & how-to",
            Page::Settings => "Make it yours",
        }
    }

    fn subtitle(self) -> &'static str {
        match self {
            Page::Home => "Bridge overview, Studio link and quick access",
            Page::Chat => "Chat with any model on your own API key — it builds and fixes things in Studio through this bridge",
            Page::Explorer => "Browse and edit the AgentScript workspace",
            Page::Servers => "Roblox Studio MCP, the local filesystem engine and the extension channels",
            Page::Terminal => "Bridge console, workspace commands and Luau in Studio",
            Page::Activity => "What is running now, the event feed with filters, and this session's tool statistics",
            Page::Diagnostics => "Live checks of the bridge, Studio, workspace and files — with a fix button on each problem",
            Page::Help => "What every page, button and shortcut does — and how to get Studio linked (F1)",
            Page::Settings => "Ten categories, one search box, export / import — every change applies instantly",
        }
    }

    fn shortcut_key(self) -> egui::Key {
        match self {
            Page::Home => egui::Key::Num1,
            Page::Chat => egui::Key::Num2,
            Page::Explorer => egui::Key::Num3,
            Page::Servers => egui::Key::Num4,
            Page::Terminal => egui::Key::Num5,
            Page::Help => egui::Key::Num6,
            Page::Settings => egui::Key::Num7,
            Page::Activity => egui::Key::Num8,
            Page::Diagnostics => egui::Key::Num9,
        }
    }

    /// "Ctrl+n" for tooltips — derived from `shortcut_key`, not from the
    /// sidebar order (2.11.0 put Activity / Diagnostics before Help).
    fn shortcut_label(self) -> &'static str {
        match self {
            Page::Home => "Ctrl+1",
            Page::Chat => "Ctrl+2",
            Page::Explorer => "Ctrl+3",
            Page::Servers => "Ctrl+4",
            Page::Terminal => "Ctrl+5",
            Page::Help => "Ctrl+6",
            Page::Settings => "Ctrl+7",
            Page::Activity => "Ctrl+8",
            Page::Diagnostics => "Ctrl+9",
        }
    }
}

// ───────────────────────────── app ─────────────────────────────


#[derive(Clone, Copy, PartialEq, Eq)]
enum RunnerMode { Command, Luau }

struct ExplorerEntry { name: String, path: PathBuf, is_dir: bool, size: u64 }

struct ToolRun { receiver: Receiver<ToolReply>, started: Instant, name: String }

struct Snapshot { texture: egui::TextureHandle, size: [usize; 2], taken_at: String, source: String }

// ── AI chat side panel state ──

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChatRole { User, Assistant, Note }

struct ChatToolCard {
    id: String,
    name: String,
    args: String,
    result: String,
    ok: Option<bool>,
    elapsed_ms: u128,
    images: Vec<(egui::TextureHandle, [usize; 2])>,
    open: bool,
}

struct ChatMsg {
    role: ChatRole,
    text: String,
    /// Reasoning / thinking stream (shown collapsed, never sent back).
    thinking: String,
    tools: Vec<ChatToolCard>,
    at: String,
}

struct ChatTurn {
    receiver: Receiver<crate::chat::ChatEvent>,
    cancel: Arc<AtomicBool>,
    started: Instant,
}

/// A guarded tool call (shell / process / delete / download / open) waiting
/// for the user's Allow / Deny in the chat composer. The turn is paused until
/// `reply` is answered; dropping it (Stop, New chat) counts as Deny.
struct PendingApproval {
    name: String,
    args: String,
    reply: Option<tokio::sync::oneshot::Sender<bool>>,
    since: Instant,
}

pub struct App {
    shared: Arc<UiShared>,
    cmd_tx: UnboundedSender<UiCommand>,
    settings: Settings,
    theme: Theme,
    page: Page,
    logo: Option<egui::TextureHandle>,
    first_frame: bool,
    start_hidden: bool,
    quit_now: bool,
    /// 2.11.0 notification center (replaces the single toast).
    notices: NoticeCenter,
    /// 2.11.0 command palette (Ctrl+K).
    palette: PaletteState,
    // 2.11.0 settings page
    settings_cat: SettingsCat,
    settings_query: String,
    reset_armed: Option<Instant>,
    import_path: String,
    // 2.11.0 activity center
    activity_filter: ActFilter,
    activity_query: String,
    seen_activity: usize,
    last_size_save: Instant,
    /// When the current page was opened — drives the slide/fade-in.
    page_opened: Instant,
    // home
    snapshot: Option<Snapshot>,
    snapshot_run: Option<ToolRun>,
    help_query: String,
    /// MCP Servers → Tool catalogue search box.
    catalog_query: String,
    local_tools: Vec<ToolInfo>,
    // servers
    kill_armed: Option<Instant>,
    // terminal
    runner_mode: RunnerMode,
    term_cmd: String,
    term_history: Vec<String>,
    history_cursor: Option<usize>,
    term_output: Vec<(bool, String)>,
    term_run: Option<ToolRun>,
    luau_code: String,
    luau_run: Option<ToolRun>,
    log_level: u8,
    log_query: String,
    // explorer
    explorer_dir: PathBuf,
    explorer_entries: Vec<ExplorerEntry>,
    explorer_file: Option<PathBuf>,
    explorer_text: String,
    explorer_dirty: bool,
    explorer_note: String,
    explorer_jump: String,
    new_name: String,
    delete_armed: Option<Instant>,
    // settings
    draft_workspace: String,
    draft_mcp: String,
    settings_note: String,
    /// Appearance → palette search box.
    palette_query: String,
    /// 2.9.1 easter eggs opened from the palette search box.
    egg: crate::easter::EggState,
    picker_rx: Option<Receiver<Option<String>>>,
    /// Which text field the running folder picker fills.
    picker_for_reference: bool,
    workspace_rx: Option<Receiver<Result<String, String>>>,
    draft_reference: String,
    reference_rx: Option<Receiver<Result<Option<String>, String>>>,
    tray: Option<TrayState>,
    /// Handle the tray worker can use to raise this window again (Windows:
    /// HWND; elsewhere a marker that the egui context is registered).
    native_hwnd: Option<isize>,
    /// Window size changed since the last settings save.
    size_dirty: bool,
    // AI chat side panel
    chat_items: Vec<ChatMsg>,
    /// OpenAI-format history (without the system prompt) sent with every turn.
    chat_history: Vec<serde_json::Value>,
    chat_input: String,
    chat_turn: Option<ChatTurn>,
    chat_status: String,
    chat_model_list: Vec<String>,
    chat_models_rx: Option<Receiver<Result<Vec<String>, String>>>,
    chat_models_note: String,
    chat_setup_open: bool,
    chat_key_visible: bool,
    chat_tokens: (u64, u64),
    chat_last_turn_ms: u128,
    chat_pending_focus: bool,
    chat_approval: Option<PendingApproval>,
}

/// See `App::native_hwnd`.
fn native_window_handle() -> Option<isize> {
    #[cfg(windows)]
    { crate::agent_window() }
    #[cfg(not(windows))]
    { UI_CTX.get().map(|_| 1) }
}

impl App {
    fn new(
        egui_ctx: &egui::Context,
        shared: Arc<UiShared>,
        cmd_tx: UnboundedSender<UiCommand>,
        settings: Settings,
        start_hidden: bool,
        logo_rgba: Option<(Vec<u8>, u32, u32)>,
        tray: Option<TrayState>,
    ) -> Self {
        let theme = Theme::from_settings(&settings);
        install_fonts(egui_ctx);
        theme.apply(egui_ctx, &settings);
        let _ = UI_CTX.set(egui_ctx.clone());
        let logo = logo_rgba.as_ref().map(|(rgba, w, h)| {
            let image = egui::ColorImage::from_rgba_unmultiplied([*w as usize, *h as usize], rgba);
            egui_ctx.load_texture("totalscript-logo", image, egui::TextureOptions::LINEAR)
        });
        let local_tools: Vec<ToolInfo> = crate::workspace::catalog()
            .iter()
            .filter_map(|t| ToolInfo::from_mcp(t, "local"))
            .collect();
        let root = PathBuf::from(shared.root());
        let seen_activity = shared.activity_seq.load(Ordering::Relaxed);
        let mut app = Self {
            draft_workspace: shared.root(),
            draft_mcp: settings.mcp_command.clone(),
            draft_reference: settings.reference_dir.clone(),
            shared,
            cmd_tx,
            settings,
            theme,
            page: Page::Home,
            logo,
            first_frame: true,
            start_hidden,
            quit_now: false,
            notices: NoticeCenter::default(),
            palette: PaletteState::default(),
            settings_cat: SettingsCat::General,
            settings_query: String::new(),
            reset_armed: None,
            import_path: String::new(),
            activity_filter: ActFilter::All,
            activity_query: String::new(),
            seen_activity,
            last_size_save: Instant::now(),
            page_opened: Instant::now(),
            snapshot: None,
            snapshot_run: None,
            help_query: String::new(),
            catalog_query: String::new(),
            local_tools,
            kill_armed: None,
            runner_mode: RunnerMode::Command,
            term_cmd: String::new(),
            term_history: Vec::new(),
            history_cursor: None,
            term_output: Vec::new(),
            term_run: None,
            luau_code: "-- Runs inside Roblox Studio through execute_luau (Edit DataModel)\nlocal workspace = game:GetService(\"Workspace\")\nprint(\"TotalScript: \" .. #workspace:GetChildren() .. \" children in Workspace\")\n".into(),
            luau_run: None,
            log_level: 0,
            log_query: String::new(),
            explorer_dir: root,
            explorer_entries: Vec::new(),
            explorer_file: None,
            explorer_text: String::new(),
            explorer_dirty: false,
            explorer_note: String::new(),
            explorer_jump: String::new(),
            new_name: String::new(),
            delete_armed: None,
            settings_note: String::new(),
            palette_query: String::new(),
            egg: crate::easter::EggState::default(),
            picker_rx: None,
            picker_for_reference: false,
            workspace_rx: None,
            reference_rx: None,
            tray,
            native_hwnd: None,
            size_dirty: false,
            chat_items: Vec::new(),
            chat_history: Vec::new(),
            chat_input: String::new(),
            chat_turn: None,
            chat_status: String::new(),
            chat_model_list: Vec::new(),
            chat_models_rx: None,
            chat_models_note: String::new(),
            chat_setup_open: false,
            chat_key_visible: false,
            chat_tokens: (0, 0),
            chat_last_turn_ms: 0,
            chat_pending_focus: false,
            chat_approval: None,
        };
        // Open the chat panel straight into setup when nothing is configured yet.
        app.chat_setup_open = !app.chat_ready();
        if let Some(m) = app.settings.chat_models.get(&app.settings.chat_provider) { if !m.is_empty() { app.chat_model_list = vec![m.clone()]; } }
        app.refresh_explorer();
        app
    }

    // ── helpers ──

    /// Action result → notification center (+ a short toast). Kept under the
    /// old name so every call site stays one line.
    fn toast(&mut self, text: impl Into<String>, ok: bool) {
        self.notify(if ok { NoticeKind::Ok } else { NoticeKind::Err }, text, "app");
    }

    fn send(&mut self, cmd: UiCommand, note: &str) {
        if self.cmd_tx.send(cmd).is_ok() {
            if !note.is_empty() { self.toast(note.to_string(), true); }
        } else {
            self.toast("Bridge runtime is not reachable", false);
        }
    }

    /// Fire a tool call and return the receiver for the reply (None if the runtime is gone).
    fn start_tool(&mut self, engine: &str, name: &str, args: serde_json::Value) -> Option<ToolRun> {
        let (tx, rx) = std::sync::mpsc::channel();
        let cmd = UiCommand::RunTool { engine: engine.to_string(), name: name.to_string(), args, reply: tx };
        if self.cmd_tx.send(cmd).is_ok() {
            Some(ToolRun { receiver: rx, started: Instant::now(), name: name.to_string() })
        } else {
            self.toast("Bridge runtime is not reachable", false);
            None
        }
    }

    fn all_tools(&self) -> Vec<ToolInfo> {
        let mut list = self.shared.roblox_tools.lock().unwrap_or_else(|e| e.into_inner()).clone();
        list.extend(self.local_tools.iter().cloned());
        list
    }

    fn workspace_root(&self) -> PathBuf { PathBuf::from(self.shared.root()) }

    fn inside_root(&self, path: &Path) -> bool {
        if self.shared.full_access() { return true; }
        path.starts_with(self.workspace_root())
    }

    fn refresh_explorer(&mut self) {
        self.explorer_entries.clear();
        let Ok(read) = std::fs::read_dir(&self.explorer_dir) else {
            let shown = self.explorer_dir.display().to_string();
            self.explorer_note = if shown.trim().is_empty() {
                "No workspace folder yet — pick one in Settings → Workspace".to_string()
            } else if !self.explorer_dir.exists() {
                format!("Folder does not exist: {shown}")
            } else {
                format!("Cannot read {shown} (permission?)")
            };
            return;
        };
        let mut entries: Vec<ExplorerEntry> = read
            .filter_map(|e| e.ok())
            .map(|e| {
                let meta = e.metadata().ok();
                let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                ExplorerEntry { name: e.file_name().to_string_lossy().to_string(), path: e.path(), is_dir, size }
            })
            .collect();
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        self.explorer_entries = entries;
        self.explorer_jump = self.explorer_dir.to_string_lossy().to_string();
    }

    fn navigate(&mut self, dir: PathBuf) {
        if !dir.is_dir() { self.explorer_note = format!("{} is not a folder", dir.display()); return; }
        if !self.inside_root(&dir) { self.explorer_note = "Outside the workspace — enable FULL PC ACCESS to browse anywhere".into(); return; }
        self.explorer_dir = dir;
        self.explorer_note.clear();
        self.refresh_explorer();
    }

    fn open_file(&mut self, path: PathBuf) {
        match std::fs::read(&path) {
            Ok(bytes) => {
                if bytes.len() > 2 * 1024 * 1024 {
                    self.explorer_note = "File is larger than 2 MB — open it with the OS instead.".into();
                    return;
                }
                if bytes.iter().take(4096).any(|b| *b == 0) {
                    self.explorer_note = "Binary file — preview is not available.".into();
                    return;
                }
                self.explorer_text = String::from_utf8_lossy(&bytes).to_string();
                self.explorer_file = Some(path);
                self.explorer_dirty = false;
                self.explorer_note.clear();
            }
            Err(e) => self.explorer_note = format!("Read failed: {e}"),
        }
    }

    fn save_file(&mut self) {
        let Some(path) = self.explorer_file.clone() else { return; };
        match std::fs::write(&path, self.explorer_text.as_bytes()) {
            Ok(()) => {
                self.explorer_dirty = false;
                self.shared.track("explorer", format!("saved {}", path.display()));
                self.toast("Saved", true);
            }
            Err(e) => self.toast(format!("Save failed: {e}"), false),
        }
    }

    fn capture_studio(&mut self) {
        if self.snapshot_run.is_some() { return; }
        self.snapshot_run = self.start_tool("roblox", "screen_capture", serde_json::json!({}));
        if self.snapshot_run.is_some() { self.toast("Capturing the Studio viewport", true); }
    }

    fn store_snapshot(&mut self, ctx: &egui::Context, images: &[(String, String)], source: &str) -> bool {
        let Some((mime, data)) = images.first() else { return false; };
        match decode_image(data) {
            Ok((rgba, w, h)) => {
                let image = egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba);
                let texture = ctx.load_texture("studio-snapshot", image, egui::TextureOptions::LINEAR);
                self.snapshot = Some(Snapshot {
                    texture,
                    size: [w as usize, h as usize],
                    taken_at: chrono::Local::now().format("%H:%M:%S").to_string(),
                    source: source.to_string(),
                });
                true
            }
            Err(e) => {
                self.toast(format!("Image ({mime}) could not be decoded: {e}"), false);
                false
            }
        }
    }

    fn poll_async(&mut self, ctx: &egui::Context) {
        self.chat_poll(ctx);
        // Event toasts: surface bridge / Studio / error events the runtime
        // recorded since the last frame, so the user does not have to watch
        // the activity feed to know the extension connected or a helper died.
        let seq = self.shared.activity_seq.load(Ordering::Relaxed);
        if seq > self.seen_activity {
            let fresh = (seq - self.seen_activity).min(3);
            let items: Vec<Activity> = self.shared.activity.lock().unwrap_or_else(|e| e.into_inner()).iter().take(fresh).cloned().collect();
            self.seen_activity = seq;
            for a in items.into_iter().rev() {
                match a.kind.as_str() {
                    "bridge" => self.notify(NoticeKind::Info, a.text.clone(), "bridge"),
                    "studio" => self.notify(NoticeKind::Ok, a.text.clone(), "studio"),
                    // pair mode: only findings and the on/off lines deserve a notice; "clean" edits stay in the feed
                    "pair" if !a.text.contains(" clean") => self.notify(if a.text.contains("finding(s)") { NoticeKind::Warn } else { NoticeKind::Info }, a.text.clone(), "pair"),
                    "error" => self.notify(NoticeKind::Err, a.text.clone(), "error"),
                    _ => {}
                }
            }
        }
        // Studio snapshot
        let snap = self.snapshot_run.as_ref().map(|run| run.receiver.try_recv());
        if let Some(result) = snap {
            match result {
                Ok(reply) => {
                    self.snapshot_run = None;
                    if reply.ok {
                        if !self.store_snapshot(ctx, &reply.images, "screen_capture") {
                            if reply.images.is_empty() { self.toast("Studio returned no image — is a place open?", false); }
                        } else {
                            self.toast("Studio viewport captured", true);
                        }
                    } else {
                        self.toast(format!("Capture failed: {}", truncate(&reply.text, 120)), false);
                    }
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => { self.snapshot_run = None; self.toast("Runtime dropped the capture request", false); }
            }
        }
        // Terminal: command
        let term = self.term_run.as_ref().map(|run| run.receiver.try_recv());
        if let Some(result) = term {
            match result {
                Ok(reply) => { self.term_output.push((reply.ok, reply.text)); self.term_run = None; }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => { self.term_output.push((false, "runtime dropped the request".into())); self.term_run = None; }
            }
        }
        // Terminal: Luau
        let luau = self.luau_run.as_ref().map(|run| (run.receiver.try_recv(), run.started.elapsed().as_millis()));
        if let Some((result, _)) = luau {
            match result {
                Ok(reply) => {
                    let head = if reply.ok { format!("[Studio · {} ms]", reply.elapsed_ms) } else { format!("[Studio · ERROR · {} ms]", reply.elapsed_ms) };
                    self.term_output.push((reply.ok, format!("{head}\n{}", if reply.text.trim().is_empty() { "(no output)".to_string() } else { reply.text })));
                    if reply.ok && !reply.images.is_empty() { self.store_snapshot(ctx, &reply.images, "execute_luau"); }
                    self.luau_run = None;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => { self.term_output.push((false, "runtime dropped the Luau request".into())); self.luau_run = None; }
            }
        }
        // Folder picker
        let picked = self.picker_rx.as_ref().map(|rx| rx.try_recv());
        if let Some(result) = picked {
            match result {
                Ok(Some(path)) => { if self.picker_for_reference { self.draft_reference = path; } else { self.draft_workspace = path; } self.picker_rx = None; }
                Ok(None) => { self.picker_rx = None; }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => { self.picker_rx = None; }
            }
        }
        // Workspace switch
        let ws = self.workspace_rx.as_ref().map(|rx| rx.try_recv());
        if let Some(result) = ws {
            match result {
                Ok(Ok(shown)) => {
                    self.workspace_rx = None;
                    self.settings.workspace_root = shown.clone();
                    self.remember_workspace(&shown);
                    let _ = self.settings.save();
                    self.draft_workspace = shown.clone();
                    self.explorer_file = None;
                    self.explorer_text.clear();
                    self.explorer_dirty = false;
                    self.explorer_dir = PathBuf::from(&shown);
                    self.refresh_explorer();
                    self.settings_note = format!("Workspace is now {shown}");
                    self.toast("Workspace switched", true);
                }
                Ok(Err(e)) => { self.workspace_rx = None; self.settings_note = format!("Workspace switch failed: {e}"); self.toast("Workspace switch failed", false); }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => { self.workspace_rx = None; }
            }
        }
        // Reference library switch
        let rf = self.reference_rx.as_ref().map(|rx| rx.try_recv());
        if let Some(result) = rf {
            match result {
                Ok(Ok(shown)) => {
                    self.reference_rx = None;
                    self.settings.reference_dir = shown.clone().unwrap_or_default();
                    let _ = self.settings.save();
                    self.draft_reference = self.settings.reference_dir.clone();
                    match shown {
                        Some(p) => { self.settings_note = format!("Reference library is now {p}"); self.toast("Reference library set", true); }
                        None => { self.settings_note = "Reference library turned off".into(); self.toast("Reference library off", true); }
                    }
                }
                Ok(Err(e)) => { self.reference_rx = None; self.settings_note = format!("Reference library not set: {e}"); self.toast("Reference library not set", false); }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => { self.reference_rx = None; }
            }
        }
    }

    fn handle_shortcuts(&mut self, ctx: &egui::Context) {
        let mut nav: Option<Page> = None;
        let mut restart = false;
        let mut refresh = false;
        let mut capture = false;
        let mut escape = false;
        let mut chat = false;
        let mut palette = false;
        let mut notices = false;
        ctx.input(|i| {
            if i.modifiers.command {
                for page in Page::ALL {
                    if i.key_pressed(page.shortcut_key()) { nav = Some(page); }
                }
                if i.key_pressed(egui::Key::R) { restart = true; }
                if i.key_pressed(egui::Key::J) { chat = true; }
                if i.key_pressed(egui::Key::K) || i.key_pressed(egui::Key::P) { palette = true; }
                if i.key_pressed(egui::Key::Comma) { nav = Some(Page::Settings); }
                if i.modifiers.shift && i.key_pressed(egui::Key::S) { capture = true; }
                if i.modifiers.shift && i.key_pressed(egui::Key::N) { notices = true; }
            }
            if i.key_pressed(egui::Key::F5) { refresh = true; }
            if i.key_pressed(egui::Key::F1) { nav = Some(Page::Help); }
            if i.key_pressed(egui::Key::Escape) { escape = true; }
        });
        if palette { if self.palette.open { self.palette.open = false; } else { self.open_palette(); } }
        if notices { self.toggle_notices(); }
        // While the palette is open it owns the keyboard (its own Esc / Enter / arrows).
        if self.palette.open { return; }
        if escape {
            if self.notices.open { self.notices.open = false; return; }
            match self.page {
                Page::Explorer => { self.explorer_note.clear(); self.delete_armed = None; }
                Page::Servers => { self.kill_armed = None; self.catalog_query.clear(); }
                Page::Help => { self.help_query.clear(); }
                Page::Settings => { self.settings_query.clear(); self.reset_armed = None; }
                Page::Activity => { self.activity_query.clear(); }
                _ => {}
            }
            self.notices.mark_all_read();
        }
        if let Some(page) = nav { self.go(page); }
        if chat { self.toggle_chat(); }
        if restart { self.send(UiCommand::RestartMcp, "Restarting Studio MCP helper"); }
        if capture { self.capture_studio(); }
        if refresh {
            self.refresh_explorer();
            self.send(UiCommand::ProbeStudio, "");
        }
    }

    fn diagnostics_text(&self) -> String {
        let s = &self.shared;
        let tools = self.all_tools();
        let mut out = String::new();
        out.push_str(&format!("TotalScript Desktop {}\n", env!("CARGO_PKG_VERSION")));
        out.push_str(&format!("os: {} {}\n", std::env::consts::OS, std::env::consts::ARCH));
        out.push_str(&format!("uptime: {}\n", human_duration(s.boot.elapsed())));
        out.push_str(&format!("studio process: {}\n", s.studio_running.load(Ordering::Relaxed)));
        out.push_str(&format!("studio connected: {}\n", s.studio_connected.load(Ordering::Relaxed)));
        out.push_str(&format!("mcp helper alive: {}\n", s.mcp_alive.load(Ordering::Relaxed)));
        out.push_str(&format!("mcp launcher: {}\n", mcp_launcher_display()));
        out.push_str(&format!("extension clients: roblox={} local={}\n", s.roblox_clients.load(Ordering::Relaxed), s.local_clients.load(Ordering::Relaxed)));
        out.push_str(&format!("workspace: {} (ready={}, full access={})\n", s.root(), s.workspace_ready.load(Ordering::Relaxed), s.full_access()));
        out.push_str(&format!("tools: {} ({} roblox, {} local)\n", tools.len(), tools.iter().filter(|t| t.engine == "roblox").count(), self.local_tools.len()));
        out.push_str(&format!("settings: {}\n", Settings::path().display()));
        out.push_str("ports: http 127.0.0.1:3000 · ws 17613 (roblox) · ws 17615 (local)\n");
        if let Some(fatal) = s.fatal.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            out.push_str(&format!("FATAL: {fatal}\n"));
        }
        out.push_str("\n--- session ---\n");
        out.push_str(&s.session_report_text());
        out.push_str("\n--- last 40 log lines ---\n");
        let logs = s.logs.lock().unwrap_or_else(|e| e.into_inner());
        let skip = logs.len().saturating_sub(40);
        for line in logs.iter().skip(skip) { out.push_str(line); out.push('\n'); }
        out
    }

    fn handle_close(&mut self, ctx: &egui::Context) {
        if !ctx.input(|i| i.viewport().close_requested()) { return; }
        if self.explorer_dirty { self.save_file(); }
        let _ = self.settings.save();
        // Hiding is only safe when there is a way back: a working tray icon AND
        // a native handle (Windows) / live egui context the tray worker can
        // raise. Without both, "close to tray" produced an invisible process
        // the user could neither reopen nor quit — so Close quits instead.
        self.native_hwnd = native_window_handle();
        let can_background = self.tray.is_some() && self.native_hwnd.is_some();
        let quit = self.quit_now || self.shared.quit_requested.load(Ordering::Acquire) || !self.settings.close_to_tray || !can_background;
        if quit {
            if !can_background && self.settings.close_to_tray && !self.quit_now {
                self.shared.track("app", "Close will quit instead of hiding an unreachable background app (no tray icon / window handle)");
            }
            return;
        }
        ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
        hide_window();
        self.shared.track("app", if HAS_TRAY {
            "window hidden to the notification area — bridge keeps running"
        } else {
            "window hidden — bridge keeps running; launch total-core again to bring it back"
        });
    }

    // ── chrome ──

    fn titlebar(&mut self, ctx: &egui::Context) {
        let t = self.theme;
        egui::TopBottomPanel::top("titlebar")
            .exact_height(40.0)
            .frame(egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border)).inner_margin(Margin::symmetric(12.0, 0.0)))
            .show(ctx, |ui| {
                let rect = ui.max_rect();
                let drag = ui.interact(rect, egui::Id::new("titlebar-drag"), Sense::click_and_drag());
                if drag.drag_started_by(egui::PointerButton::Primary) { ctx.send_viewport_cmd(egui::ViewportCommand::StartDrag); }
                if drag.double_clicked() {
                    let max = ctx.input(|i| i.viewport().maximized.unwrap_or(false));
                    ctx.send_viewport_cmd(egui::ViewportCommand::Maximized(!max));
                }
                ui.allocate_ui_with_layout(rect.size(), Layout::left_to_right(Align::Center), |ui| {
                    self.logo_mark(ui, 20.0);
                    ui.add_space(4.0);
                    ui.label(RichText::new("TotalScript").strong().color(t.text));
                    ui.label(RichText::new("Desktop").color(t.muted));
                    ui.add_space(8.0);
                    let online = self.shared.studio_connected.load(Ordering::Relaxed);
                    let (dot, text) = if online { (t.ok, "STUDIO LINKED") }
                        else if self.shared.studio_running.load(Ordering::Relaxed) { (t.warn, "STUDIO OPEN · MCP NOT LINKED") }
                        else { (t.muted, "STUDIO CLOSED") };
                    status_chip(ui, t, text, dot, online && self.settings.motion);
                    let up = self.shared.bridge_listening.load(Ordering::Relaxed) && self.shared.fatal.lock().unwrap_or_else(|e| e.into_inner()).is_none();
                    if !up { status_chip(ui, t, "BRIDGE OFFLINE", t.bad, false).on_hover_text("The local bridge is not listening yet — the extension cannot connect"); }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 2.0;
                        if window_button(ui, WinGlyph::Close, t.bad, t).clicked() { ctx.send_viewport_cmd(egui::ViewportCommand::Close); }
                        if window_button(ui, WinGlyph::Maximize, t.text, t).clicked() {
                            let max = ctx.input(|i| i.viewport().maximized.unwrap_or(false));
                            ctx.send_viewport_cmd(egui::ViewportCommand::Maximized(!max));
                        }
                        if window_button(ui, WinGlyph::Minimize, t.text, t).clicked() { ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(true)); }
                        ui.add_space(8.0);
                        // Explicit Quit: Close only hides to the tray, so the
                        // window itself must offer a way to stop the bridge.
                        if pill(ui, t, "Quit", false).on_hover_text("Stop the bridge and exit (Close only hides the window)").clicked() {
                            self.quit_now = true;
                            request_quit(&self.shared);
                        }
                        ui.add_space(6.0);
                        ui.label(RichText::new(format!("v{}", env!("CARGO_PKG_VERSION"))).small().color(t.muted));
                        ui.add_space(8.0);
                        let chat_open = self.settings.chat_panel_open;
                        if pill(ui, t, "AI Chat", chat_open).on_hover_text("Chat with a model that drives Studio through the bridge (Ctrl+J)").clicked() {
                            self.toggle_chat();
                        }
                        if self.chat_turn.is_some() { status_dot(ui, t.warn); }
                        ui.add_space(6.0);
                        self.bell_button(ui);
                        if icon_button(ui, t, Icon::Search, "Command palette (Ctrl+K)", self.palette.open).clicked() { if self.palette.open { self.palette.open = false; } else { self.open_palette(); } }
                    });
                });
            });
    }

    fn logo_mark(&self, ui: &mut egui::Ui, size: f32) {
        let t = self.theme;
        if let Some(tex) = &self.logo {
            let sized = egui::load::SizedTexture::new(tex.id(), Vec2::splat(size));
            ui.add(egui::Image::from_texture(sized).rounding(Rounding::same(size * 0.25)));
        } else {
            let (rect, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
            ui.painter().rect_filled(rect, Rounding::same(size * 0.25), t.accent);
            ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, "R", FontId::new(size * 0.7, FontFamily::Proportional), t.accent_ink);
        }
    }

    /// Switch page (records the moment for the slide-in animation).
    fn go(&mut self, page: Page) {
        if self.page != page { self.page = page; self.page_opened = Instant::now(); }
    }

    /// Hover/selection animation progress 0..1 for `id` (instant when motion is off).
    fn anim(&self, ctx: &egui::Context, id: egui::Id, on: bool, secs: f32) -> f32 {
        ctx.animate_bool_with_time(id, on, if self.settings.motion { secs } else { 0.0 })
    }

    fn sidebar(&mut self, ctx: &egui::Context) {
        let t = self.theme;
        let rail = self.settings.sidebar_rail || ctx.screen_rect().width() < 1040.0;
        let blurbs = self.settings.sidebar_blurbs && !rail;
        let width = if rail { 72.0 } else { 236.0 };
        let row_h = if rail { 44.0 } else if blurbs { 44.0 } else { 36.0 };
        let rr = corner(self.settings.corners, 12.0);
        egui::SidePanel::left("sidebar")
            .exact_width(width)
            .resizable(false)
            .frame(egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border)).inner_margin(Margin::symmetric(if rail { 10.0 } else { 12.0 }, 14.0)))
            .show(ctx, |ui| {
                if rail {
                    ui.vertical_centered(|ui| { self.logo_mark(ui, 36.0); });
                    ui.add_space(14.0);
                } else {
                    ui.horizontal(|ui| {
                        self.logo_mark(ui, 38.0);
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 1.0;
                            ui.label(RichText::new("TotalScript").size(17.0).strong().color(t.accent));
                            ui.label(RichText::new("Workspace bridge").small().color(t.muted));
                        });
                    });
                    ui.add_space(16.0);
                    section_label(ui, t, "YOUR WORKSPACE");
                    ui.add_space(6.0);
                }
                let mut nav: Option<Page> = None;
                // Nine pages do not always fit above the bridge card (short
                // windows, two-line items): the list scrolls instead of
                // running under the card. Reserve the compact card's height.
                let reserve = if rail { 92.0 } else { 124.0 };  // measured: rail block ≈ 84 px, compact card ≈ 108 px, + spacing
                egui::ScrollArea::vertical().id_salt("nav-scroll").max_height((ui.available_height() - reserve).max(120.0)).auto_shrink([false, true])
                    .scroll_bar_visibility(egui::scroll_area::ScrollBarVisibility::AlwaysHidden).show(ui, |ui| {
                for page in Page::ALL.iter() {
                    let page = *page;
                    if page == Page::Activity {
                        if rail {
                            ui.add_space(6.0);
                            let (line, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 1.0), Sense::hover());
                            ui.painter().rect_filled(line, Rounding::ZERO, t.border);
                            ui.add_space(6.0);
                        } else { ui.add_space(10.0); section_label(ui, t, "SYSTEM"); ui.add_space(6.0); }
                    }
                    let selected = self.page == page;
                    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), row_h), Sense::click());
                    let resp = resp.on_hover_text(format!("{}  ({})\n{}", page.title(), page.shortcut_label(), page.blurb()));
                    if resp.hovered() { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
                    let hover = self.anim(ctx, resp.id.with("hover"), resp.hovered() && !selected, 0.12);
                    let sel = self.anim(ctx, resp.id.with("sel"), selected, 0.18);
                    let painter = ui.painter();
                    if sel > 0.0 {
                        // Filled card with an accent outline — the "current page" look.
                        let fill = mix(t.panel, t.accent, if t.light { 0.10 } else { 0.08 });
                        painter.rect_filled(rect, Rounding::same(rr), alpha(fill, (255.0 * sel) as u8));
                        painter.rect_stroke(rect, Rounding::same(rr), Stroke::new(1.0_f32, alpha(t.accent, (170.0 * sel) as u8)));
                        if self.settings.glow { painter.rect_stroke(rect.expand(2.0), Rounding::same(rr + 2.0), Stroke::new(1.0_f32, alpha(t.accent, (34.0 * sel) as u8))); }
                    }
                    if hover > 0.0 {
                        painter.rect_filled(rect, Rounding::same(rr), alpha(t.panel, (255.0 * hover) as u8));
                        painter.rect_stroke(rect, Rounding::same(rr), Stroke::new(1.0_f32, alpha(t.border, (255.0 * hover) as u8)));
                    }
                    // Icon chip (slides 2 px right on hover)
                    let cx = if rail { rect.center().x } else { rect.left() + 24.0 + 2.0 * hover };
                    let chip = egui::Rect::from_center_size(Pos2::new(cx, rect.center().y), Vec2::splat(30.0));
                    let chip_fill = if selected { alpha(t.accent, 46) } else { alpha(t.border, if t.light { 90 } else { 140 }) };
                    painter.rect_filled(chip, Rounding::same(corner(self.settings.corners, 9.0)), chip_fill);
                    let icon_rect = egui::Rect::from_center_size(chip.center(), Vec2::splat(15.0));
                    let icon_col = mix(t.muted, t.accent, sel.max(hover * 0.5));
                    nav_icon(painter, icon_rect, page, icon_col);
                    if !rail {
                        let title_col = mix(mix(t.text, t.muted, 0.35), t.text, sel.max(hover));
                        if blurbs {
                            painter.text(rect.left_center() + Vec2::new(48.0, -8.0), egui::Align2::LEFT_CENTER, page.title(), FontId::new(14.0, FontFamily::Proportional), title_col);
                            painter.text(rect.left_center() + Vec2::new(48.0, 9.0), egui::Align2::LEFT_CENTER, page.blurb(), FontId::new(11.0, FontFamily::Proportional), mix(t.muted, t.accent, 0.4 * sel));
                        } else {
                            painter.text(rect.left_center() + Vec2::new(48.0, 0.0), egui::Align2::LEFT_CENTER, page.title(), FontId::new(14.0, FontFamily::Proportional), title_col);
                        }
                    }
                    if page == Page::Chat && self.chat_turn.is_some() {
                        let k = pulse(ctx, self.settings.motion);
                        painter.circle_filled(rect.right_top() + Vec2::new(-10.0, 10.0), 3.0 + k, t.warn);
                    } else if selected && !rail {
                        painter.circle_filled(rect.right_center() - Vec2::new(16.0, 0.0), 2.5, t.accent);
                    }
                    if resp.clicked() { nav = Some(page); }
                    ui.add_space(2.0);
                }
                });
                if let Some(page) = nav { self.go(page); }
                ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
                    let s = &self.shared;
                    let up = s.bridge_listening.load(Ordering::Relaxed) && s.fatal.lock().unwrap_or_else(|e| e.into_inner()).is_none();
                    if rail {
                        // Icon rail: a single status square with a tooltip and the rail toggle.
                        ui.vertical_centered(|ui| {
                            if ui.add(egui::Button::new(RichText::new(if self.settings.sidebar_rail { "»" } else { "«" }).size(14.0)).frame(false)).on_hover_text(if self.settings.sidebar_rail { "Expand the sidebar" } else { "Window too narrow — the sidebar expands above 1040 px" }).clicked() && self.settings.sidebar_rail {
                                self.settings.sidebar_rail = false; let _ = self.settings.save();
                            }
                            ui.add_space(4.0);
                            let (r, resp) = ui.allocate_exact_size(Vec2::splat(30.0), Sense::hover());
                            let c = if up { t.ok } else { t.bad };
                            ui.painter().rect_filled(r, Rounding::same(8.0), alpha(c, 30));
                            ui.painter().rect_stroke(r, Rounding::same(8.0), Stroke::new(1.0_f32, alpha(c, 150)));
                            ui.painter().rect_filled(egui::Rect::from_center_size(r.center(), Vec2::splat(8.0)), Rounding::same(2.0), c);
                            resp.on_hover_text(format!("Bridge {}\nHTTP 3000 · WS 17613 roblox · WS 17615 local\nup {}", if up { "ONLINE" } else { "OFFLINE" }, human_duration(s.boot.elapsed())));
                        });
                        return;
                    }
                    // Short windows: keep only the ONLINE/OFFLINE line.
                    let roomy = ui.available_height() > 240.0;
                    let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, if up { alpha(t.ok, 110) } else { t.border })).rounding(Rounding::same(t.r_card + 2.0)).inner_margin(Margin::same(12.0));
                    frame.show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.horizontal(|ui| {
                            section_label(ui, t, "BRIDGE");
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                let c = if up { t.ok } else { t.bad };
                                ui.label(RichText::new(if up { "ONLINE" } else { "OFFLINE" }).size(10.5).strong().color(c));
                                let (d, _) = ui.allocate_exact_size(Vec2::splat(8.0), Sense::hover());
                                let k = if up { pulse(ctx, self.settings.motion) } else { 0.0 };
                                ui.painter().circle_filled(d.center(), 3.0 + k * 0.8, c);
                                if up && self.settings.motion { ui.painter().circle_stroke(d.center(), 4.5 + k * 2.5, Stroke::new(1.0_f32, alpha(c, (90.0 * (1.0 - k)) as u8))); }
                            });
                        });
                        if roomy {
                            ui.add_space(4.0);
                            row_status(ui, t, "HTTP 3000", up);
                            row_status(ui, t, "WS 17613 roblox", s.roblox_clients.load(Ordering::Relaxed) > 0);
                            row_status(ui, t, "WS 17615 local", s.local_clients.load(Ordering::Relaxed) > 0);
                            row_status(ui, t, "Studio MCP helper", s.mcp_alive.load(Ordering::Relaxed));
                        }
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(format!("up {}  ·  v{}", human_duration(s.boot.elapsed()), env!("CARGO_PKG_VERSION"))).small().color(t.muted));
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if ui.add(egui::Button::new(RichText::new("«").size(13.0).color(t.muted)).frame(false)).on_hover_text("Collapse to an icon rail").clicked() {
                                    self.settings.sidebar_rail = true; let _ = self.settings.save();
                                }
                            });
                        });
                    });
                });
            });
    }

    fn page_header(&self, ui: &mut egui::Ui) {
        let t = self.theme;
        let s = &self.shared;
        // Slide/fade the whole page in for 220 ms after a page switch.
        if self.settings.motion {
            let k = (self.page_opened.elapsed().as_secs_f32() / 0.22).min(1.0);
            let e = 1.0 - (1.0 - k) * (1.0 - k);
            if k < 1.0 { ui.add_space(10.0 * (1.0 - e)); ui.set_opacity(0.15 + 0.85 * e); ui.ctx().request_repaint(); }
        }
        // Status chips live in the title bar and the sidebar card; the page
        // header is just the title, so nothing fights the backdrop on the right.
        let _ = s;
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 3.0;
            // Breadcrumb: "— SETTINGS / AQUA"
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                let (bar, _) = ui.allocate_exact_size(Vec2::new(14.0, 2.0), Sense::hover());
                ui.painter().rect_filled(bar, Rounding::same(1.0), t.accent);
                let crumb = format!("{} / {}", self.page.title().to_uppercase(), Theme::palette(&self.settings.theme).name.to_uppercase());
                ui.label(RichText::new(crumb).size(10.5).strong().color(t.accent));
            });
            ui.label(RichText::new(self.page.title()).size(26.0).strong().color(t.text));
            ui.add(egui::Label::new(RichText::new(self.page.subtitle()).color(t.muted)).truncate());
        });
        ui.add_space(14.0);
    }

    // ── pages ──

    fn page_home(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let s = self.shared.clone();
        let studio_proc = s.studio_running.load(Ordering::Relaxed);
        let studio_link = s.studio_connected.load(Ordering::Relaxed);
        let mcp = s.mcp_alive.load(Ordering::Relaxed);
        let ws_ready = s.workspace_ready.load(Ordering::Relaxed);
        let tools = self.all_tools();
        let fatal = s.fatal.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let listening = s.bridge_listening.load(Ordering::Relaxed);
        let channels = s.roblox_clients.load(Ordering::Relaxed) + s.local_clients.load(Ordering::Relaxed);
        let jobs = self.jobs();
        let mut action: Option<Action> = None;
        let mut switch_ws: Option<String> = None;

        egui::ScrollArea::vertical().id_salt("home-scroll").auto_shrink([false, false]).show(ui, |ui| {
        // Leave room for the floating scrollbar so cards never sit under it.
        ui.set_max_width(ui.available_width() - 8.0);
        if let Some(f) = fatal.clone() {
            let frame = egui::Frame::none().fill(t.bad.linear_multiply(0.15)).stroke(Stroke::new(1.0_f32, t.bad)).rounding(Rounding::same(t.r_card)).inner_margin(Margin::same(12.0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(RichText::new("Bridge failed to start").strong().color(t.bad));
                ui.label(RichText::new(f).color(t.text));
            });
            ui.add_space(10.0);
        }

        // Hero — welcome strip: who you are talking to, where, and the three
        // things people press most.
        let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border2)).rounding(Rounding::same(t.r_card + 4.0)).inner_margin(Margin::same(18.0));
        frame.show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                self.logo_mark(ui, 52.0);
                ui.add_space(6.0);
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 3.0;
                    let hour = chrono::Local::now().format("%H").to_string().parse::<u32>().unwrap_or(12);
                    let greet = if hour < 6 { "Working late" } else if hour < 12 { "Good morning" } else if hour < 18 { "Good afternoon" } else { "Good evening" };
                    ui.label(RichText::new(format!("{greet} — TotalScript Desktop {}", env!("CARGO_PKG_VERSION"))).size(18.0).strong().color(t.text));
                    let root = s.root();
                    let line = format!("{} · {} · {}",
                        if root.is_empty() { "no workspace yet".to_string() } else { short_path(&root, 48) },
                        if studio_link { "Studio linked" } else if studio_proc { "Studio open, not linked" } else { "Studio closed" },
                        if channels > 0 { format!("{channels} extension channel(s)") } else { "extension not connected".to_string() });
                    ui.add(egui::Label::new(RichText::new(line).color(t.muted)).truncate());
                });
            });
            ui.add_space(12.0);
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing = Vec2::new(8.0, 8.0);
                if pill(ui, t, "Open AI Chat", true).on_hover_text("Ctrl+2").clicked() { action = Some(Action::Go(Page::Chat)); }
                if pill(ui, t, "Restart Studio MCP", false).on_hover_text("Ctrl+R").clicked() { action = Some(Action::RestartMcp); }
                if pill(ui, t, "Probe Studio", false).on_hover_text("F5").clicked() { action = Some(Action::ProbeStudio); }
                let capturing = self.snapshot_run.is_some();
                if busy_button(ui, t, "Capture viewport", "Capturing…", capturing, Btn::Secondary).on_hover_text("Ctrl+Shift+S").clicked() { action = Some(Action::Capture); }
                if ghost(ui, t, "Command palette").on_hover_text("Ctrl+K").clicked() { self.palette.just_opened = true; self.palette.open = true; self.palette.query.clear(); self.palette.selected = 0; }
            });
        });
        ui.add_space(14.0);

        // Status cards
        let cards: [(&str, String, String, Color32, Option<Action>); 4] = [
            ("Bridge",
                if fatal.is_some() { "Error".into() } else if !listening { "Starting…".into() } else if channels > 0 { "Online".into() } else { "Listening".into() },
                if fatal.is_some() { "see the message above".into() }
                else if !listening { "binding http 3000 · ws 17613 · ws 17615".into() }
                else if channels > 0 { format!("{channels} extension channel(s) · up {}", human_duration(s.boot.elapsed())) }
                else { "waiting for the extension — open a supported AI chat tab".into() },
                if fatal.is_some() { t.bad } else if !listening { t.warn } else if channels > 0 { t.ok } else { t.info },
                Some(Action::Go(Page::Diagnostics))),
            ("Roblox Studio",
                if studio_link { "Connected".into() } else if studio_proc { "Open · not linked".into() } else { "Closed".into() },
                if studio_link { "MCP helper linked to a Studio place".into() } else if studio_proc { if mcp { "Enable Studio as MCP server, then probe".into() } else { "Helper not running — restart MCP".into() } } else { "Start Studio and open a place".into() },
                if studio_link { t.ok } else if studio_proc { t.warn } else { t.muted },
                Some(Action::Go(Page::Servers))),
            ("Tools", format!("{}", tools.len()), format!("{} Studio · {} local", tools.iter().filter(|x| x.engine == "roblox").count(), self.local_tools.len()), if tools.len() > self.local_tools.len() { t.ok } else { t.warn }, Some(Action::Go(Page::Servers))),
            ("Workspace", if ws_ready { "Ready".into() } else { "Missing".into() }, short_path(&s.root(), 34) + if s.full_access() { " · FULL ACCESS" } else { "" }, if ws_ready { if s.full_access() { t.warn } else { t.ok } } else { t.bad }, Some(Action::Settings(SettingsCat::Workspace))),
        ];
        let ncols = if ui.available_width() < 900.0 { 2 } else { 4 };
        ui.columns(ncols, |cols| {
            for (i, (title, value, sub, color, act)) in cards.iter().enumerate() {
                let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card + 2.0)).inner_margin(Margin::same(14.0));
                let resp = frame.show(&mut cols[i % ncols], |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        status_dot(ui, *color);
                        ui.label(RichText::new(*title).small().strong().color(t.muted));
                    });
                    ui.label(RichText::new(value).size(20.0).strong().color(t.text));
                    ui.add(egui::Label::new(RichText::new(sub).small().color(t.muted)).truncate());
                }).response.interact(Sense::click());
                if resp.hovered() { cols[i % ncols].output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
                if resp.clicked() { action = *act; }
            }
        });
        ui.add_space(14.0);

        // Setup checklist — the "what do I do next" card. Hidden once every
        // step is green unless the user keeps it on in Settings.
        {
            let ext_ok = channels > 0;
            let all_ok = fatal.is_none() && listening && ext_ok && studio_proc && studio_link && ws_ready;
            if !all_ok || self.settings.show_checklist {
                let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, if all_ok { t.ok.linear_multiply(0.5) } else { t.border2 })).rounding(Rounding::same(t.r_card + 2.0)).inner_margin(Margin::same(14.0));
                frame.show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(if all_ok { "Everything is connected" } else { "Setup checklist" }).size(16.0).strong().color(t.text));
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if all_ok && ghost(ui, t, "Hide").clicked() { self.settings.show_checklist = false; let _ = self.settings.save(); }
                        });
                    });
                    ui.add_space(4.0);
                    let step = |ui: &mut egui::Ui, done: bool, title: &str, hint: &str| {
                        ui.horizontal_top(|ui| {
                            let (rect, _) = ui.allocate_exact_size(Vec2::splat(18.0), Sense::hover());
                            if done {
                                ui.painter().circle_filled(rect.center(), 8.0, t.ok);
                                ui.painter().line_segment([rect.center() + Vec2::new(-4.0, 0.0), rect.center() + Vec2::new(-1.0, 3.0)], Stroke::new(2.0_f32, t.accent_ink));
                                ui.painter().line_segment([rect.center() + Vec2::new(-1.0, 3.0), rect.center() + Vec2::new(4.5, -3.5)], Stroke::new(2.0_f32, t.accent_ink));
                            } else {
                                ui.painter().circle_stroke(rect.center(), 8.0, Stroke::new(1.6_f32, t.warn));
                            }
                            ui.vertical(|ui| {
                                ui.spacing_mut().item_spacing.y = 1.0;
                                ui.label(RichText::new(title).strong().color(if done { t.text } else { t.warn }));
                                if !done { ui.add(egui::Label::new(RichText::new(hint).small().color(t.muted)).wrap()); }
                            });
                        });
                    };
                    step(ui, fatal.is_none() && listening, "Bridge running", "starting the local ports…");
                    step(ui, ext_ok, "Browser extension connected", "open a supported AI chat (ChatGPT, Claude, Gemini, DeepSeek…) in a browser with the TotalScript extension — it connects by itself within a few seconds");
                    step(ui, studio_proc, "Roblox Studio is open", "start Roblox Studio and open a place");
                    step(ui, studio_link, "Studio MCP enabled and linked", "in Studio: Assistant → … → Manage MCP Servers → Enable Studio as MCP server, then press Probe Studio");
                    step(ui, ws_ready, "Workspace folder ready", "pick a folder in Settings → Workspace (used by the AgentScript file tools)");
                    if !all_ok {
                        ui.add_space(6.0);
                        ui.horizontal_wrapped(|ui| {
                            if !studio_link && studio_proc && pill(ui, t, if mcp { "Probe Studio" } else { "Start MCP helper" }, true).clicked() {
                                action = Some(if mcp { Action::ProbeStudio } else { Action::RestartMcp });
                            }
                            if !ws_ready && pill(ui, t, "Open Settings", false).clicked() { action = Some(Action::Settings(SettingsCat::Workspace)); }
                            if !ext_ok && pill(ui, t, "Install / open the extension", false).clicked() { action = Some(Action::OpenRepo); }
                            if ghost(ui, t, "Run diagnostics").clicked() { action = Some(Action::Go(Page::Diagnostics)); }
                        });
                    }
                });
                ui.add_space(14.0);
            }
        }

        // Quick actions grid
        if self.settings.home_quick {
            ui.label(RichText::new("Quick actions").size(16.0).strong().color(t.text));
            ui.add_space(6.0);
            let items: [(&str, &str, Icon, Action); 8] = [
                ("Explorer", "Edit files in the workspace", Icon::Folder, Action::Go(Page::Explorer)),
                ("Terminal", "Console, shell commands, Luau in Studio", Icon::Terminal, Action::Go(Page::Terminal)),
                ("Activity", "Running jobs, feed and session stats", Icon::List, Action::Go(Page::Activity)),
                ("Diagnostics", "Live checks with fix buttons", Icon::Pulse, Action::Go(Page::Diagnostics)),
                ("Copy diagnostics", "For a bug report — no keys, no chat text", Icon::Copy, Action::CopyDiagnostics),
                ("Copy session report", "Which tools ran, how often, how fast", Icon::Copy, Action::CopyReport),
                ("Open workspace folder", "In the system file manager", Icon::Folder, Action::OpenWorkspace),
                ("Settings", "Theme, folders, provider, shortcuts", Icon::Gear, Action::Go(Page::Settings)),
            ];
            let w = grid_width(ui.available_width(), 220.0, 10.0);
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing = Vec2::new(10.0, 10.0);
                for (title, sub, icon, act) in items {
                    let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, 58.0), Sense::click());
                    let hover = resp.hovered();
                    let p = ui.painter();
                    p.rect_filled(rect, Rounding::same(t.r_card), if hover { t.panel2 } else { t.panel });
                    p.rect_stroke(rect, Rounding::same(t.r_card), Stroke::new(1.0_f32, if hover { alpha(t.accent, 150) } else { t.border }));
                    let chip = egui::Rect::from_center_size(Pos2::new(rect.left() + 26.0, rect.center().y), Vec2::splat(30.0));
                    p.rect_filled(chip, Rounding::same(t.r_btn), alpha(t.accent, 40));
                    paint_icon(p, egui::Rect::from_center_size(chip.center(), Vec2::splat(15.0)), icon, t.accent);
                    let tx = rect.left() + 50.0;
                    paint_text_fit(p, Pos2::new(tx, rect.center().y - 8.0), egui::Align2::LEFT_CENTER, title, font_medium(13.5), t.text, rect.right() - tx - 10.0);
                    paint_text_fit(p, Pos2::new(tx, rect.center().y + 9.0), egui::Align2::LEFT_CENTER, sub, FontId::new(11.0, FontFamily::Proportional), t.muted, rect.right() - tx - 10.0);
                    if hover { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
                    if resp.clicked() { action = Some(act); }
                }
            });
            ui.add_space(14.0);
        }

        let two = ui.available_width() >= 820.0;
        let mut left = |ui: &mut egui::Ui, action: &mut Option<Action>| {
            // Session statistics
            if self.settings.home_stats {
                let session = s.session.lock().unwrap_or_else(|e| e.into_inner());
                let ok: usize = session.tools.values().map(|x| x.ok).sum();
                let fail: usize = session.tools.values().map(|x| x.fail).sum();
                let ms: u128 = session.tools.values().map(|x| x.total_ms).sum();
                let errs = session.errors.len();
                drop(session);
                let calls = ok + fail;
                card(ui, t, |ui| {
                    card_title(ui, t, "This session", |ui| { if ghost(ui, t, "Details").clicked() { *action = Some(Action::Go(Page::Activity)); } });
                    ui.columns(4, |c| {
                        stat_tile(&mut c[0], t, &calls.to_string(), "tool calls", t.accent);
                        stat_tile(&mut c[1], t, &if calls > 0 { format!("{} ms", ms / calls as u128) } else { "—".into() }, "avg latency", t.info);
                        stat_tile(&mut c[2], t, &errs.to_string(), "errors", if errs > 0 { t.bad } else { t.muted });
                        stat_tile(&mut c[3], t, &human_duration(s.boot.elapsed()), "uptime", t.ok);
                    });
                    if !jobs.is_empty() {
                        ui.add_space(6.0);
                        ui.horizontal(|ui| { spinner(ui, t, 14.0); ui.label(RichText::new(format!("{} job(s) running — {}", jobs.len(), jobs.iter().map(|j| j.title.as_str()).collect::<Vec<_>>().join(", "))).small().color(t.muted)); });
                    }
                });
                ui.add_space(12.0);
            }
            // Studio viewport
            if self.settings.home_viewport {
                card(ui, t, |ui| {
                    card_title(ui, t, "Studio viewport", |ui| {
                        if self.snapshot.is_some() && ghost(ui, t, "Clear").clicked() { self.snapshot = None; }
                        let capturing = self.snapshot_run.is_some();
                        if ui.add_enabled(!capturing && studio_link, pill_widget(t, if capturing { "Capturing…" } else { "Capture" }, true)).clicked() { *action = Some(Action::Capture); }
                    });
                    match &self.snapshot {
                        Some(snap) => {
                            let avail = ui.available_width();
                            let aspect = snap.size[1] as f32 / snap.size[0].max(1) as f32;
                            let size = Vec2::new(avail, (avail * aspect).min(360.0));
                            ui.add(egui::Image::from_texture(egui::load::SizedTexture::new(snap.texture.id(), size)).rounding(Rounding::same(8.0)));
                            ui.label(RichText::new(format!("{}×{} · {} · via {}", snap.size[0], snap.size[1], snap.taken_at, snap.source)).small().color(t.muted));
                        }
                        None => {
                            ui.label(RichText::new(if studio_link { "No snapshot yet. Capture runs the same screen_capture tool the AI uses." } else { "Link Studio first — then Capture shows what the agent sees." }).small().color(t.muted));
                        }
                    }
                });
                ui.add_space(12.0);
            }
        };
        let right = |ui: &mut egui::Ui, action: &mut Option<Action>, switch_ws: &mut Option<String>, recent_ws: &[String], favs: &[String]| {
            if !self.settings.home_recent { return; }
            card(ui, t, |ui| {
                card_title(ui, t, "Recent activity", |ui| { if ghost(ui, t, "Open Activity").clicked() { *action = Some(Action::Go(Page::Activity)); } });
                let list: Vec<Activity> = s.activity.lock().unwrap_or_else(|e| e.into_inner()).iter().take(10).cloned().collect();
                if list.is_empty() {
                    ui.label(RichText::new("No activity yet. Open the TotalScript extension in your browser AI and press Start — tool calls, Studio links and workspace edits appear here.").small().color(t.muted));
                }
                for a in &list {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(&a.at).monospace().small().color(t.muted));
                        let color = match a.kind.as_str() { "tool" => t.accent, "studio" => t.ok, "bridge" => t.info, "pair" => t.warn, "error" => t.bad, _ => t.muted };
                        tag(ui, &a.kind, color);
                        ui.add(egui::Label::new(RichText::new(&a.text).small().color(t.text)).truncate());
                    });
                }
            });
            ui.add_space(12.0);
            let current = s.root();
            let mut rows: Vec<&String> = favs.iter().collect();
            for p in recent_ws { if !favs.contains(p) { rows.push(p); } }
            rows.retain(|p| **p != current);
            if !rows.is_empty() {
                card(ui, t, |ui| {
                    card_title(ui, t, "Switch workspace", |ui| { if ghost(ui, t, "Manage").clicked() { *action = Some(Action::Settings(SettingsCat::Workspace)); } });
                    let switching = self.workspace_rx.is_some();
                    for p in rows.iter().take(5) {
                        ui.horizontal(|ui| {
                            let (r, _) = ui.allocate_exact_size(Vec2::splat(14.0), Sense::hover());
                            let starred = favs.contains(*p);
                            paint_icon(ui.painter(), r, if starred { Icon::StarFilled } else { Icon::Folder }, if starred { t.warn } else { t.muted });
                            ui.add(egui::Label::new(RichText::new(short_path(p, 44)).monospace().small().color(t.text)).truncate());
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if ui.add_enabled(!switching && Path::new(p.as_str()).is_dir(), button_widget(t, "Switch", Btn::Ghost)).clicked() { *switch_ws = Some((*p).clone()); }
                            });
                        });
                    }
                });
                ui.add_space(12.0);
            }
        };
        let recent_ws = self.settings.recent_workspaces.clone();
        let favs = self.settings.favorite_workspaces.clone();
        if two {
            ui.columns(2, |cols| {
                left(&mut cols[0], &mut action);
                right(&mut cols[1], &mut action, &mut switch_ws, &recent_ws, &favs);
            });
        } else {
            left(ui, &mut action);
            right(ui, &mut action, &mut switch_ws, &recent_ws, &favs);
        }

        // Donate — compact, at the bottom.
        card(ui, t, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("Donate").strong().color(t.text));
                ui.add(egui::Label::new(RichText::new("free tool — a Robux game pass says thanks:").small().color(t.muted)).truncate());
            });
            donation_row(ui, t);
        });
        });
        if let Some(p) = switch_ws { self.draft_workspace = p.clone(); let (tx, rx) = std::sync::mpsc::channel(); if self.cmd_tx.send(UiCommand::SetWorkspace { path: p, reply: tx }).is_ok() { self.workspace_rx = Some(rx); } }
        if let Some(a) = action { let ctx = ui.ctx().clone(); self.run_action(a, &ctx); }
    }

    fn page_explorer(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let root = self.workspace_root();
        // ── toolbar: breadcrumbs + actions ──
        ui.horizontal(|ui| {
            // Breadcrumbs: Root › a › b (each segment clickable).
            let rel: Vec<PathBuf> = {
                let mut parts = Vec::new();
                let mut cur = self.explorer_dir.clone();
                loop {
                    parts.push(cur.clone());
                    if cur == root || !cur.starts_with(&root) { break; }
                    match cur.parent() { Some(p) => cur = p.to_path_buf(), None => break }
                }
                parts.reverse();
                parts
            };
            let mut go: Option<PathBuf> = None;
            for (i, seg) in rel.iter().enumerate() {
                let last = i + 1 == rel.len();
                let label = if i == 0 && seg == &root {
                    "Workspace".to_string()
                } else {
                    seg.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| seg.to_string_lossy().to_string())
                };
                let text = RichText::new(label).strong().color(if last { t.text } else { t.accent });
                if ui.add(egui::Label::new(text).sense(Sense::click())).clicked() && !last { go = Some(seg.clone()); }
                if !last { ui.label(RichText::new("›").color(t.muted)); }
            }
            if let Some(p) = go { self.navigate(p); }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if pill(ui, t, "Show in folder", false).clicked() { open_external(&self.explorer_dir.to_string_lossy()); }
                if pill(ui, t, "Refresh", false).on_hover_text("F5").clicked() { self.refresh_explorer(); }
                let can_up = (self.explorer_dir != root && self.explorer_dir.starts_with(&root)) || self.shared.full_access();
                if ui.add_enabled(can_up, button_widget(t, "Up", Btn::Secondary)).clicked() {
                    if let Some(parent) = self.explorer_dir.parent().map(|p| p.to_path_buf()) { self.navigate(parent); }
                }
                if self.explorer_dir != root && pill(ui, t, "Workspace root", false).clicked() { self.navigate(root.clone()); }
            });
        });
        ui.add_space(6.0);
        // Second row, laid out from the right so the path box takes whatever
        // width is left instead of pushing the buttons off the page.
        ui.horizontal(|ui| {
            let name = self.new_name.trim().to_string();
            let valid = !name.is_empty() && !name.contains(['/', '\\']);
            let mut jump_now = false;
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if ui.add_enabled(valid, button_widget(t, "New file", Btn::Secondary)).clicked() {
                    let p = self.explorer_dir.join(&name);
                    if p.exists() { self.toast("Already exists", false); } else {
                        match std::fs::write(&p, b"") { Ok(()) => { self.new_name.clear(); self.refresh_explorer(); self.open_file(p); self.toast("File created", true); } Err(e) => self.toast(format!("{e}"), false) }
                    }
                }
                if ui.add_enabled(valid, button_widget(t, "New folder", Btn::Secondary)).clicked() {
                    let p = self.explorer_dir.join(&name);
                    match std::fs::create_dir_all(&p) { Ok(()) => { self.new_name.clear(); self.refresh_explorer(); self.toast("Folder created", true); } Err(e) => self.toast(format!("{e}"), false) }
                }
                ui.add(egui::TextEdit::singleline(&mut self.new_name).hint_text("new name…").desired_width(150.0));
                ui.separator();
                if pill(ui, t, "Go", false).clicked() { jump_now = true; }
                let w = (ui.available_width() - 4.0).max(120.0);
                let jump = ui.add(egui::TextEdit::singleline(&mut self.explorer_jump).font(TextStyle::Monospace).hint_text("folder path…").desired_width(w));
                if jump.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) { jump_now = true; }
            });
            if jump_now {
                let target = PathBuf::from(self.explorer_jump.trim());
                self.navigate(target);
            }
        });
        if !self.explorer_note.is_empty() {
            ui.horizontal(|ui| {
                ui.add(egui::Label::new(RichText::new(&self.explorer_note).color(t.warn)).truncate());
                if ghost(ui, t, "Dismiss").clicked() { self.explorer_note.clear(); }
            });
        }
        ui.add_space(8.0);

        // ── split: file list | editor ──
        let panel_frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card)).inner_margin(Margin::same(8.0));
        egui::SidePanel::left("explorer-tree")
            .frame(panel_frame)
            .resizable(true)
            .default_width(320.0)
            .width_range(240.0..=600.0)
            .show_inside(ui, |ui| {
                let dirs = self.explorer_entries.iter().filter(|e| e.is_dir).count();
                let files = self.explorer_entries.len() - dirs;
                ui.horizontal(|ui| {
                    ui.label(RichText::new(short_path(&self.explorer_dir.to_string_lossy(), 34)).monospace().small().color(t.muted))
                        .on_hover_text(self.explorer_dir.to_string_lossy().to_string());
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(RichText::new(format!("{dirs} folders · {files} files")).small().color(t.muted));
                    });
                });
                ui.separator();
                egui::ScrollArea::vertical().id_salt("explorer-list").auto_shrink([false, false]).show(ui, |ui| {
                    let mut nav: Option<PathBuf> = None;
                    let mut open: Option<PathBuf> = None;
                    if self.explorer_dir != root || self.shared.full_access() {
                        if let Some(parent) = self.explorer_dir.parent().map(|p| p.to_path_buf()) {
                            let resp = list_row(ui, t, false, 26.0, |p, r| {
                                p.text(r.left_center() + Vec2::new(30.0, 0.0), egui::Align2::LEFT_CENTER, "..", FontId::monospace(13.0), t.muted);
                            });
                            if resp.clicked() { nav = Some(parent); }
                        }
                    }
                    for e in &self.explorer_entries {
                        let selected = self.explorer_file.as_ref() == Some(&e.path);
                        let name = e.name.clone();
                        let is_dir = e.is_dir;
                        let size = e.size;
                        let resp = list_row(ui, t, selected, 26.0, |p, r| {
                            let icon = egui::Rect::from_center_size(r.left_center() + Vec2::new(16.0, 0.0), Vec2::new(14.0, 12.0));
                            if is_dir {
                                p.rect_filled(icon, Rounding::same(2.0), t.accent.linear_multiply(0.9));
                                p.rect_filled(egui::Rect::from_min_size(icon.min, Vec2::new(6.0, 3.0)), Rounding::same(1.0), t.accent);
                            } else {
                                p.rect_stroke(icon.shrink2(Vec2::new(2.0, 0.0)), Rounding::same(2.0), Stroke::new(1.2_f32, t.muted));
                                p.line_segment([icon.left_center() + Vec2::new(4.0, 0.0), icon.right_center() - Vec2::new(4.0, 0.0)], Stroke::new(1.0_f32, t.muted));
                            }
                            let size_text = if is_dir { String::new() } else { human_size(size) };
                            let size_w = if is_dir { 0.0 } else { 62.0 };
                            paint_text_fit(p, r.left_center() + Vec2::new(30.0, 0.0), egui::Align2::LEFT_CENTER, &name, FontId::monospace(13.0), if selected && !is_dir { t.accent } else { t.text }, r.width() - 36.0 - size_w);
                            if !is_dir {
                                p.text(r.right_center() - Vec2::new(6.0, 0.0), egui::Align2::RIGHT_CENTER, size_text, FontId::proportional(11.0), t.muted);
                            }
                        });
                        let resp = resp.on_hover_text(e.path.to_string_lossy().to_string());
                        if resp.clicked() { if is_dir { nav = Some(e.path.clone()); } else { open = Some(e.path.clone()); } }
                    }
                    if self.explorer_entries.is_empty() {
                        ui.add_space(12.0);
                        ui.vertical_centered(|ui| { ui.label(RichText::new("Empty folder").color(t.muted)); });
                    }
                    if let Some(p) = nav { self.navigate(p); }
                    if let Some(p) = open { self.open_file(p); }
                });
            });

        let editor_frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card)).inner_margin(Margin::same(10.0));
        egui::CentralPanel::default()
            .frame(egui::Frame::none().inner_margin(Margin { left: 10.0, right: 0.0, top: 0.0, bottom: 0.0 }))
            .show_inside(ui, |ui| {
                editor_frame.show(ui, |ui| {
                    ui.set_min_size(ui.available_size());
                    match self.explorer_file.clone() {
                        None => {
                            ui.add_space(24.0);
                            ui.vertical_centered(|ui| {
                                ui.label(RichText::new("No file open").size(16.0).strong().color(t.text));
                                ui.add(egui::Label::new(RichText::new("Pick a file on the left to preview and edit it. Text files up to 2 MB open inline; Ctrl+S saves.").color(t.muted)).wrap());
                            });
                        }
                        Some(path) => {
                            ui.horizontal(|ui| {
                                ui.label(RichText::new(path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()).strong().color(t.text));
                                if self.explorer_dirty { tag(ui, "modified", t.warn); }
                                ui.label(RichText::new(format!("{} lines · {}", self.explorer_text.lines().count(), human_size(self.explorer_text.len() as u64))).small().color(t.muted));
                                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                    let armed = self.delete_armed.map(|a| a.elapsed() < Duration::from_secs(3)).unwrap_or(false);
                                    if danger(ui, t, if armed { "Confirm delete" } else { "Delete" }).clicked() {
                                        if armed {
                                            match std::fs::remove_file(&path) { Ok(()) => { self.explorer_file = None; self.explorer_text.clear(); self.refresh_explorer(); self.toast("Deleted", true); } Err(e) => self.toast(format!("{e}"), false) }
                                            self.delete_armed = None;
                                        } else { self.delete_armed = Some(Instant::now()); }
                                    }
                                    if pill(ui, t, "Show in folder", false).clicked() { open_external(&path.to_string_lossy()); }
                                    if pill(ui, t, "Copy path", false).clicked() { let p = path.to_string_lossy().to_string(); ui.output_mut(|o| o.copied_text = p); }
                                    if ui.add_enabled(self.explorer_dirty, pill_widget(t, "Save", true)).on_hover_text("Ctrl+S").clicked() { self.save_file(); }
                                });
                            });
                            ui.add_space(4.0);
                            let width = ui.available_width();
                            egui::ScrollArea::both().id_salt("explorer-editor").auto_shrink([false, false]).show(ui, |ui| {
                                let resp = ui.add(
                                    egui::TextEdit::multiline(&mut self.explorer_text)
                                        .code_editor()
                                        .font(TextStyle::Monospace)
                                        .desired_width(width - 4.0)
                                        .desired_rows(40),
                                );
                                if resp.changed() { self.explorer_dirty = true; }
                            });
                        }
                    }
                });
            });
        if ui.input(|i| i.modifiers.command && i.key_pressed(egui::Key::S)) && self.explorer_dirty { self.save_file(); }
    }

    fn page_servers(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let s = self.shared.clone();
        let roblox_tools = s.roblox_tools.lock().unwrap_or_else(|e| e.into_inner()).len();
        let studio_proc = s.studio_running.load(Ordering::Relaxed);
        let studio_link = s.studio_connected.load(Ordering::Relaxed);
        let mcp = s.mcp_alive.load(Ordering::Relaxed);

        egui::ScrollArea::vertical().id_salt("servers").auto_shrink([false, false]).show(ui, |ui| {
            // Roblox Studio MCP
            let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card)).inner_margin(Margin::same(14.0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    status_dot(ui, if studio_link { t.ok } else if mcp { t.warn } else { t.bad });
                    ui.label(RichText::new("Roblox Studio MCP").size(16.0).strong().color(t.text));
                    tag(ui, "roblox", t.accent);
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if pill(ui, t, "Restart helper", true).clicked() { self.send(UiCommand::RestartMcp, "Restarting Studio MCP helper"); }
                        if pill(ui, t, "Probe", false).clicked() { self.send(UiCommand::ProbeStudio, "Probing Studio"); }
                        let armed = self.kill_armed.map(|a| a.elapsed() < Duration::from_secs(3)).unwrap_or(false);
                        if ui.add_enabled(studio_proc, button_widget(t, if armed { "Confirm: kill Studio" } else { "Kill Roblox Studio" }, Btn::Danger)).on_hover_text("Ends every RobloxStudio process (press twice within 3 s)").clicked() {
                            if armed { self.kill_armed = None; self.send(UiCommand::KillStudio, "Killing Roblox Studio processes"); } else { self.kill_armed = Some(Instant::now()); }
                        }
                    });
                });
                egui::Grid::new("studio-grid").num_columns(2).spacing([16.0, 4.0]).min_row_height(22.0).show(ui, |ui| {
                    ui.label(RichText::new("Helper process").color(t.muted)); ui.label(if mcp { "running (stdio JSON-RPC)" } else { "not running" }); ui.end_row();
                    ui.label(RichText::new("Studio process").color(t.muted)); ui.label(if studio_proc { "RobloxStudio detected" } else { "not detected" }); ui.end_row();
                    ui.label(RichText::new("Place link").color(t.muted)); ui.label(if studio_link { "connected — get_studio_state answers" } else { "not linked" }); ui.end_row();
                    ui.label(RichText::new("Tools").color(t.muted)); ui.label(format!("{roblox_tools}")); ui.end_row();
                    ui.label(RichText::new("Launcher").color(t.muted)); ui.label(RichText::new(mcp_launcher_display()).monospace()); ui.end_row();
                });
                ui.horizontal_wrapped(|ui| {
                    if ghost(ui, t, "Open launcher folder").clicked() {
                        if let Some(dir) = crate::mcp_launcher_folder() { open_external(&dir.to_string_lossy()); }
                    }
                    if ghost(ui, t, "Change launcher…").clicked() { self.go(Page::Settings); }
                });
                if !studio_link {
                    ui.add_space(4.0);
                    ui.label(RichText::new("To link: open a place in Roblox Studio -> Assistant -> Manage MCP Servers -> Enable Studio as MCP server, then press Probe.").small().color(t.muted));
                }
            });
            ui.add_space(8.0);

            // Local filesystem
            let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card)).inner_margin(Margin::same(14.0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                let ready = s.workspace_ready.load(Ordering::Relaxed);
                ui.horizontal(|ui| {
                    status_dot(ui, if ready { t.ok } else { t.bad });
                    ui.label(RichText::new("Local filesystem (AgentScript)").size(16.0).strong().color(t.text));
                    tag(ui, "local", t.info);
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if pill(ui, t, "Open folder", false).clicked() { open_external(&s.root()); }
                        if pill(ui, t, "Change workspace…", false).clicked() { self.go(Page::Settings); }
                        if pill(ui, t, "Explorer", false).clicked() { self.go(Page::Explorer); }
                    });
                });
                egui::Grid::new("local-grid").num_columns(2).spacing([16.0, 4.0]).min_row_height(22.0).show(ui, |ui| {
                    ui.label(RichText::new("Root").color(t.muted)); let root = s.root(); if root.trim().is_empty() { ui.label(RichText::new("not set — Change workspace…").color(t.warn)); } else { ui.add(egui::Label::new(RichText::new(root).monospace()).truncate()); } ui.end_row();
                    ui.label(RichText::new("State").color(t.muted)); ui.label(if ready { "ready" } else { "folder missing" }); ui.end_row();
                    ui.label(RichText::new("Tools").color(t.muted)); ui.label(format!("{} (workspace_info, read/write/edit_file, grep, run_command, …)", self.local_tools.len())); ui.end_row();
                });
                let mut full = s.full_access();
                if ui.checkbox(&mut full, "FULL PC ACCESS — absolute paths anywhere, process_kill, cd outside the workspace").changed() {
                    self.settings.full_access = full;
                    let _ = self.settings.save();
                    self.send(UiCommand::SetFullAccess(full), if full { "FULL PC ACCESS enabled" } else { "FULL PC ACCESS disabled" });
                }
                if full { ui.label(RichText::new("The AI can now read, write and run anything your user account can. Turn it off when you are done.").small().color(t.warn)); }
            });
            ui.add_space(8.0);

            // Extension channels
            let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card)).inner_margin(Margin::same(14.0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(RichText::new("Extension channels").size(16.0).strong().color(t.text));
                ui.add_space(4.0);
                let rc = s.roblox_clients.load(Ordering::Relaxed);
                let lc = s.local_clients.load(Ordering::Relaxed);
                egui::Grid::new("channels-grid").num_columns(3).spacing([16.0, 4.0]).min_row_height(22.0).show(ui, |ui| {
                    ui.label(RichText::new("HTTP").color(t.muted)); ui.label(RichText::new("http://127.0.0.1:3000").monospace()); ui.label("status / connect / push / result / ws"); ui.end_row();
                    ui.label(RichText::new("WS roblox").color(t.muted)); ui.label(RichText::new("ws://127.0.0.1:17613").monospace()); ui.label(if rc > 0 { format!("{rc} connected") } else { "no extension connected".to_string() }); ui.end_row();
                    ui.label(RichText::new("WS local").color(t.muted)); ui.label(RichText::new("ws://127.0.0.1:17615").monospace()); ui.label(if lc > 0 { format!("{lc} connected") } else { "no extension connected".to_string() }); ui.end_row();
                });
                ui.horizontal_wrapped(|ui| {
                    if ghost(ui, t, "Open status JSON").clicked() { open_external("http://127.0.0.1:3000/api/status"); }
                    if ghost(ui, t, "Copy endpoints").clicked() {
                        ui.output_mut(|o| o.copied_text = "http://127.0.0.1:3000\nws://127.0.0.1:17613\nws://127.0.0.1:17615".to_string());
                        self.toast("Endpoints copied", true);
                    }
                });
                ui.label(RichText::new("Custom MCP servers are not proxied by the native bridge; the extension receives UNSUPPORTED_BRIDGE_OPERATION for add_server/remove_server and falls back gracefully.").small().color(t.muted));
            });
            ui.add_space(8.0);

            // Tool catalogue (read-only) — what the AI can call through this bridge.
            let tools = self.all_tools();
            let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card)).inner_margin(Margin::same(14.0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    status_dot(ui, if tools.len() > self.local_tools.len() { t.ok } else { t.warn });
                    ui.label(RichText::new("Tool catalogue").size(16.0).strong().color(t.text));
                    ui.label(RichText::new(format!("{} Studio · {} workspace", tools.len() - self.local_tools.len(), self.local_tools.len())).small().color(t.muted));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if !self.catalog_query.is_empty() && ghost(ui, t, "Clear").clicked() { self.catalog_query.clear(); }
                        ui.add(egui::TextEdit::singleline(&mut self.catalog_query).hint_text("Search tools…").desired_width(220.0));
                    });
                });
                let q = self.catalog_query.trim().to_lowercase();
                let shown: Vec<&ToolInfo> = tools.iter().filter(|x| q.is_empty() || x.name.to_lowercase().contains(&q) || x.description.to_lowercase().contains(&q) || x.params.iter().any(|(p, _)| p.to_lowercase().contains(&q))).collect();
                if shown.is_empty() {
                    ui.label(RichText::new(if tools.is_empty() { "No tools reported yet. Roblox Studio → Assistant → … → Manage MCP Servers → Enable Studio as MCP server, then start the helper." } else { "Nothing matches." }).small().color(t.muted));
                } else {
                    ui.label(RichText::new("Called by the extension and the AI chat; Studio tools appear once the helper runs.").small().color(t.muted));
                    ui.add_space(4.0);
                    egui::ScrollArea::vertical().id_salt("tool-catalogue").max_height(260.0).auto_shrink([false, true]).show(ui, |ui| {
                        for tool in shown { tool_row(ui, t, tool, false).on_hover_text(if tool.params.is_empty() { "no parameters".to_string() } else { tool.params.iter().map(|(p, req)| if *req { format!("{p}*") } else { p.clone() }).collect::<Vec<_>>().join(", ") }); }
                    });
                }
            });
        });
    }

    fn page_terminal(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let avail = ui.available_height();
        let studio_link = self.shared.studio_connected.load(Ordering::Relaxed);
        let half = (ui.available_width() * 0.5).round();
        let max_left = (ui.available_width() - 320.0).max(320.0);
        egui::SidePanel::left("terminal-console")
            .frame(egui::Frame::none())
            .resizable(true)
            .default_width(half)
            .width_range(320.0..=max_left)
            .show_inside(ui, |ui| {
            // console
            {
                // Two short rows that fit the narrowest pane (320 px): title +
                // filter, then the level switch + actions. One long row used to
                // overflow, which made egui grow the pane every frame.
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Bridge console").strong().color(t.text));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        let w = (ui.available_width() - 6.0).clamp(60.0, 240.0);
                        ui.add(egui::TextEdit::singleline(&mut self.log_query).hint_text("filter…").desired_width(w));
                    });
                });
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 4.0;
                    for (lvl, label) in [(0u8, "all"), (1, "info+"), (2, "warn+"), (3, "error")] {
                        if ui.selectable_label(self.log_level == lvl, label).clicked() { self.log_level = lvl; }
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if ghost(ui, t, "Log file").on_hover_text("Open the log file").clicked() { open_external(&log_path().to_string_lossy()); }
                        if ghost(ui, t, "Copy").on_hover_text("Copy every line").clicked() {
                            let text = self.shared.logs.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect::<Vec<_>>().join("\n");
                            ui.output_mut(|o| o.copied_text = text);
                        }
                        if ghost(ui, t, "Clear").clicked() { self.shared.clear_logs(); }
                    });
                });
                let frame = egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card)).inner_margin(Margin::same(8.0));
                frame.show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.set_min_height(avail - 84.0);
                    let logs = self.shared.logs.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    let q = self.log_query.trim().to_lowercase();
                    egui::ScrollArea::vertical().id_salt("console").auto_shrink([false, false]).stick_to_bottom(true).show(ui, |ui| {
                        for line in logs.iter() {
                            let level = log_level_of(line);
                            if level < self.log_level { continue; }
                            if !q.is_empty() && !line.to_lowercase().contains(&q) { continue; }
                            let color = match level { 3 => t.bad, 2 => t.warn, 1 => t.text, _ => t.muted };
                            ui.add(egui::Label::new(RichText::new(line).monospace().small().color(color)).wrap());
                        }
                    });
                });
            }
        });
        egui::CentralPanel::default()
            .frame(egui::Frame::none().inner_margin(Margin { left: 10.0, right: 0.0, top: 0.0, bottom: 0.0 }))
            .show_inside(ui, |ui| {
            // runner
            {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 4.0;
                    for (mode, label) in [(RunnerMode::Command, "Command"), (RunnerMode::Luau, "Luau in Studio")] {
                        if ui.selectable_label(self.runner_mode == mode, RichText::new(label).strong()).on_hover_text(match mode { RunnerMode::Command => "Shell command in the workspace (run_command)", RunnerMode::Luau => "Run Luau in the open Studio place (execute_luau)" }).clicked() { self.runner_mode = mode; }
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if ghost(ui, t, "Clear").on_hover_text("Clear the output below").clicked() { self.term_output.clear(); }
                    });
                });
                ui.horizontal(|ui| {
                    match self.runner_mode {
                        RunnerMode::Command => {
                            let root = self.shared.root();
                            let shown = if root.trim().is_empty() { "cwd — no workspace folder (Settings → Workspace)".to_string() } else { format!("cwd {root}") };
                            ui.add(egui::Label::new(RichText::new(shown).monospace().small().color(t.muted)).truncate()).on_hover_text(root);
                        }
                        RunnerMode::Luau => { status_dot(ui, if studio_link { t.ok } else { t.muted }); ui.label(RichText::new(if studio_link { "Studio linked" } else { "Studio not linked" }).small().color(t.muted)); }
                    }
                });
                let frame = egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card)).inner_margin(Margin::same(8.0));
                frame.show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.set_min_height(avail - 84.0);
                    match self.runner_mode {
                        RunnerMode::Command => self.command_runner(ui),
                        RunnerMode::Luau => self.luau_runner(ui, studio_link),
                    }
                    egui::ScrollArea::vertical().id_salt("term-out").auto_shrink([false, false]).stick_to_bottom(true).show(ui, |ui| {
                        let mut refill: Option<String> = None;
                        for (ok, text) in &self.term_output {
                            if let Some(cmd) = text.strip_prefix("> ") {
                                let resp = ui.add(egui::Label::new(RichText::new(text).monospace().small().strong().color(t.accent)).sense(Sense::click()));
                                if resp.on_hover_text("Click to reuse this command").clicked() { refill = Some(cmd.to_string()); }
                            } else {
                                ui.add(egui::Label::new(RichText::new(text).monospace().small().color(if *ok { t.text } else { t.bad })).wrap());
                            }
                        }
                        if let Some(cmd) = refill { self.term_cmd = cmd; self.runner_mode = RunnerMode::Command; }
                    });
                });
            }
        });
    }

    fn command_runner(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let mut submit = false;
        ui.horizontal(|ui| {
            ui.label(RichText::new(">").strong().color(t.accent));
            let resp = ui.add(egui::TextEdit::singleline(&mut self.term_cmd).hint_text("dir, git status, npm test…").font(TextStyle::Monospace).desired_width((ui.available_width() - 78.0).max(80.0)));
            if resp.has_focus() {
                let (up, down) = ui.input(|i| (i.key_pressed(egui::Key::ArrowUp), i.key_pressed(egui::Key::ArrowDown)));
                if up && !self.term_history.is_empty() {
                    let idx = match self.history_cursor { Some(0) => 0, Some(i) => i - 1, None => self.term_history.len() - 1 };
                    self.history_cursor = Some(idx);
                    self.term_cmd = self.term_history[idx].clone();
                } else if down {
                    match self.history_cursor {
                        Some(i) if i + 1 < self.term_history.len() => { self.history_cursor = Some(i + 1); self.term_cmd = self.term_history[i + 1].clone(); }
                        Some(_) => { self.history_cursor = None; self.term_cmd.clear(); }
                        None => {}
                    }
                }
            }
            if resp.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) { submit = true; resp.request_focus(); }
            if ui.add_enabled(self.term_run.is_none(), button_widget(t, "Run", Btn::Primary)).clicked() { submit = true; }
        });
        if submit && self.term_run.is_none() && !self.term_cmd.trim().is_empty() {
            let command = self.term_cmd.trim().to_string();
            let (tx, rx) = std::sync::mpsc::channel();
            if self.cmd_tx.send(UiCommand::RunCommand { command: command.clone(), reply: tx }).is_ok() {
                self.term_output.push((true, format!("> {command}")));
                if self.term_history.last() != Some(&command) {
                    self.term_history.push(command.clone());
                    if self.term_history.len() > HISTORY_CAP { self.term_history.remove(0); }
                }
                self.history_cursor = None;
                self.term_run = Some(ToolRun { receiver: rx, started: Instant::now(), name: command });
                self.term_cmd.clear();
            } else { self.toast("Bridge runtime is not reachable", false); }
        }
        ui.horizontal(|ui| {
            if let Some(run) = &self.term_run { ui.label(RichText::new(format!("running {:.1}s", run.started.elapsed().as_secs_f32())).small().color(t.muted)); }
            ui.add(egui::Label::new(RichText::new("Enter runs · Up/Down history · 60 s timeout · sandboxed unless FULL PC ACCESS").small().color(t.muted)).truncate())
                .on_hover_text("Runs through the local engine's run_command tool — the same one the AI uses.");
        });
    }

    fn luau_runner(&mut self, ui: &mut egui::Ui, studio_link: bool) {
        let t = self.theme;
        ui.add(egui::TextEdit::multiline(&mut self.luau_code).code_editor().font(TextStyle::Monospace).desired_rows(8).desired_width(f32::INFINITY));
        let mut run = false;
        ui.horizontal(|ui| {
            let running = self.luau_run.is_some();
            if ui.add_enabled(!running && studio_link, pill_widget(t, if running { "Running in Studio…" } else { "Run in Studio" }, true)).on_hover_text("Ctrl+Enter").clicked() { run = true; }
            if ui.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Enter)) && !running && studio_link { run = true; }
            if ghost(ui, t, "Copy").clicked() { let c = self.luau_code.clone(); ui.output_mut(|o| o.copied_text = c); }
            if let Some(job) = &self.luau_run { ui.label(RichText::new(format!("{} · {:.1}s", job.name, job.started.elapsed().as_secs_f32())).small().color(t.muted)); }
            ui.add(egui::Label::new(RichText::new("execute_luau · Edit DataModel · print() output below").small().color(t.muted)).truncate());
        });
        if run && !self.luau_code.trim().is_empty() {
            let code = self.luau_code.clone();
            self.luau_run = self.start_tool("roblox", "execute_luau", serde_json::json!({ "code": code, "datamodel_type": "Edit" }));
            if self.luau_run.is_some() {
                let first = self.luau_code.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
                self.term_output.push((true, format!("[Studio] {}", truncate(&first, 100))));
            }
        }
    }

    fn page_help(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let mut goto: Option<Page> = None;
        ui.horizontal(|ui| {
            ui.label(RichText::new("Search").color(t.muted));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(RichText::new(format!("{} topics · F1 opens this page from anywhere", HELP_TOPICS.len())).small().color(t.muted));
                if !self.help_query.is_empty() && ghost(ui, t, "Clear").on_hover_text("Esc").clicked() { self.help_query.clear(); }
                let w = (ui.available_width() - 8.0).clamp(120.0, 460.0);
                ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                    ui.add(egui::TextEdit::singleline(&mut self.help_query).hint_text("page, button, shortcut or problem — e.g. Luau, API key, tray…").desired_width(w));
                });
            });
        });
        ui.add_space(8.0);
        let q = self.help_query.trim().to_lowercase();
        let shown: Vec<&HelpTopic> = HELP_TOPICS
            .iter()
            .filter(|h| q.is_empty() || h.title.to_lowercase().contains(&q) || h.summary.to_lowercase().contains(&q) || h.steps.iter().any(|st| st.to_lowercase().contains(&q)))
            .collect();
        egui::ScrollArea::vertical().id_salt("help").auto_shrink([false, false]).show(ui, |ui| {
            if shown.is_empty() {
                ui.label(RichText::new(format!("Nothing matches \"{}\". Try a page name (Explorer, Terminal), a feature (Luau, API key, tray, workspace) or a symptom (not linked, offline).", q)).color(t.muted));
            }
            for h in shown {
                settings_section(ui, t, h.title, |ui| {
                    ui.label(RichText::new(h.summary).color(t.text));
                    ui.add_space(4.0);
                    for st in h.steps {
                        ui.horizontal_wrapped(|ui| {
                            ui.spacing_mut().item_spacing.x = 6.0;
                            ui.label(RichText::new("•").color(t.accent));
                            ui.label(RichText::new(*st).color(t.muted));
                        });
                    }
                    if let Some(p) = h.page {
                        ui.add_space(6.0);
                        if pill(ui, t, &format!("Open {}", p.title()), false).on_hover_text(p.shortcut_label()).clicked() { goto = Some(p); }
                    }
                });
            }
        });
        if let Some(p) = goto { self.go(p); }
    }

    fn page_settings(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let mut save = false;
        let mut retheme = false;
        // ── toolbar: search + export + category reset ──
        ui.horizontal(|ui| {
            let (r, _) = ui.allocate_exact_size(Vec2::splat(16.0), Sense::hover());
            paint_icon(ui.painter(), r, Icon::Search, t.muted);
            ui.add(egui::TextEdit::singleline(&mut self.settings_query).hint_text("Search settings…").desired_width(260.0));
            if !self.settings_query.is_empty() && icon_button(ui, t, Icon::Close, "Clear search (Esc)", false).clicked() { self.settings_query.clear(); }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let cat = self.settings_cat;
                if ghost(ui, t, &format!("Reset {}", cat.title())).on_hover_text("Defaults for this category only").clicked() {
                    let note = self.reset_settings_category(cat);
                    self.settings_note = note.to_string();
                    retheme = true; save = true;
                }
                if ghost(ui, t, "Export").on_hover_text("settings.export.json — API keys stripped").clicked() { let ctx = ui.ctx().clone(); self.export_settings(&ctx); }
                if ghost(ui, t, "Diagnostics").clicked() { self.go(Page::Diagnostics); }
            });
        });
        ui.add_space(10.0);
        let searching = !self.settings_query.trim().is_empty();
        let narrow = ui.available_width() < 760.0;
        // ── category rail ──
        let mut pick: Option<SettingsCat> = None;
        if narrow {
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing = Vec2::new(6.0, 6.0);
                for c in SettingsCat::ALL {
                    if ui.add(pill_widget(t, c.title(), !searching && self.settings_cat == c)).clicked() { pick = Some(c); }
                }
            });
            ui.add_space(8.0);
        } else {
            egui::SidePanel::left("settings-rail").resizable(false).exact_width(196.0).frame(egui::Frame::none().inner_margin(Margin { left: 0.0, right: 12.0, top: 0.0, bottom: 0.0 })).show_inside(ui, |ui| {
                for c in SettingsCat::ALL {
                    let on = !searching && self.settings_cat == c;
                    let resp = list_row(ui, t, on, 42.0, |p, rect| {
                        let icon = egui::Rect::from_center_size(Pos2::new(rect.left() + 20.0, rect.center().y), Vec2::splat(15.0));
                        paint_icon(p, icon, c.icon(), if on { t.accent } else { t.muted });
                        p.text(rect.left_center() + Vec2::new(38.0, -8.0), egui::Align2::LEFT_CENTER, c.title(), font_medium(13.5), t.text);
                        paint_text_fit(p, rect.left_center() + Vec2::new(38.0, 8.0), egui::Align2::LEFT_CENTER, c.blurb(), FontId::new(10.5, FontFamily::Proportional), t.muted, rect.width() - 44.0);
                    });
                    if resp.clicked() { pick = Some(c); }
                    ui.add_space(2.0);
                }
            });
        }
        if let Some(c) = pick { self.settings_cat = c; self.settings_query.clear(); }
        egui::CentralPanel::default().frame(egui::Frame::none()).show_inside(ui, |ui| {
        egui::ScrollArea::vertical().id_salt("settings").auto_shrink([false, false]).show(ui, |ui| {
            ui.set_max_width(ui.available_width() - 8.0);
            if searching {
                ui.label(RichText::new(format!("Sections matching \"{}\" — from every category", self.settings_query.trim())).small().color(t.muted));
                ui.add_space(8.0);
            } else {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(self.settings_cat.title()).size(20.0).strong().color(t.text));
                    ui.label(RichText::new(self.settings_cat.blurb()).color(t.muted));
                });
                ui.add_space(10.0);
            }
            let before = ui.cursor().top();
            if self.settings_visible(SettingsCat::General, "Behaviour", "tray notification area start hidden autostart launch sign-in background close") {
            section_card(ui, t, "01", "Behaviour", "Tray, autostart and what Home shows.", |ui| {
                if ui.checkbox(&mut self.settings.close_to_tray, if HAS_TRAY { "Keep running in the notification area when the window is closed" } else { "Keep running in the background when the window is closed (run total-core again to reopen it)" }).changed() { save = true; }
                if ui.checkbox(&mut self.settings.start_hidden, if HAS_TRAY { "Start hidden in the notification area" } else { "Start hidden (background bridge only)" }).changed() { save = true; }
                if ui.checkbox(&mut self.settings.launch_at_login, &format!("Launch at {OS_LABEL} sign-in (hidden)")).changed() {
                    match set_launch_at_login(self.settings.launch_at_login) {
                        Ok(()) => save = true,
                        Err(e) => { self.settings.launch_at_login = !self.settings.launch_at_login; self.settings_note = format!("Autostart failed: {e}"); }
                    }
                }
            });
            }
            if self.settings_visible(SettingsCat::General, "Dashboard", "home cards quick actions session statistics recent activity viewport checklist") {
                section_card(ui, t, "02", "Dashboard", "What the Home page shows.", |ui| { if self.dashboard_prefs(ui) { save = true; } });
            }
            if self.settings_visible(SettingsCat::Appearance, "Your layout", "density compact comfortable corners sharp soft round size scale zoom sidebar rail blurbs") {
            section_card(ui, t, "03", "Your layout", "Density, sidebar, corners and size — every change applies instantly.", |ui| {
                let motion = self.settings.motion;
                let corners = self.settings.corners;
                ui.label(RichText::new("Density").strong().color(t.text));
                ui.add_space(4.0);
                let card_w = grid_width(ui.available_width(), 232.0, 12.0);
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = Vec2::new(12.0, 12.0);
                    for (compact, name, blurb) in [(false, "Comfortable", "Roomier cards and 14 px text"), (true, "Compact", "Tighter spacing for small screens")] {
                        if layout_card(ui, t, name, blurb, compact, self.settings.compact == compact, card_w, motion, corners).clicked() && self.settings.compact != compact {
                            self.settings.compact = compact; retheme = true; save = true;
                        }
                    }
                });
                ui.add_space(12.0);
                ui.label(RichText::new("Corners").strong().color(t.text));
                ui.add_space(4.0);
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = Vec2::new(10.0, 10.0);
                    for (id, name, blurb) in [(0u8, "Sharp", "3–4 px radii"), (1u8, "Soft", "8 px buttons, 12 px cards"), (2u8, "Round", "12–18 px radii")] {
                        if choice_card(ui, t, name, blurb, self.settings.corners == id, 150.0, motion, id).clicked() && self.settings.corners != id {
                            self.settings.corners = id; retheme = true; save = true;
                        }
                    }
                });
                ui.add_space(12.0);
                ui.horizontal_wrapped(|ui| {
                    ui.label(RichText::new("Size").strong().color(t.text));
                    ui.add_space(6.0);
                    for (scale, label) in [(0.9_f32, "90 %"), (1.0, "100 %"), (1.1, "110 %"), (1.25, "125 %")] {
                        let on = (self.settings.ui_scale - scale).abs() < 0.01;
                        if ui.add(pill_widget(t, label, on)).clicked() && !on { self.settings.ui_scale = scale; retheme = true; save = true; }
                    }
                    ui.label(RichText::new("scales text, buttons and spacing together").small().color(t.muted));
                });
                ui.add_space(12.0);
                ui.label(RichText::new("Sidebar").strong().color(t.text));
                if ui.checkbox(&mut self.settings.sidebar_rail, "Icon rail — narrow sidebar with tooltips (also automatic under 1040 px)").changed() { save = true; }
                if ui.checkbox(&mut self.settings.sidebar_blurbs, "Two-line items — a short description under every page name").changed() { save = true; }
            });
            }
            if self.settings_visible(SettingsCat::Appearance, "Theme & accent", "palette theme dark light accent colour color hex") {
            section_card(ui, t, "04", "Appearance", "Palette, accent colour and effects. Light and dark palettes share the same layout.", |ui| {
                ui.horizontal(|ui| {
                    ui.add(egui::TextEdit::singleline(&mut self.palette_query).hint_text("Search palettes…").desired_width(260.0));
                    if !self.palette_query.is_empty() && ghost(ui, t, "Clear").clicked() { self.palette_query.clear(); }
                    self.egg.observe(&self.palette_query);
                    ui.label(RichText::new(format!("{} palettes · current: {}", PALETTES.len(), Theme::palette(&self.settings.theme).name)).small().color(t.muted));
                });
                ui.add_space(6.0);
                let q = self.palette_query.trim().to_lowercase();
                let mut shown = 0usize;
                let motion = self.settings.motion;
                let card_w = grid_width(ui.available_width(), 228.0, 10.0);
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = Vec2::new(10.0, 10.0);
                    for pal in PALETTES {
                        if !q.is_empty() && !pal.name.to_lowercase().contains(&q) && !pal.blurb.to_lowercase().contains(&q) && !pal.id.contains(&q) { continue; }
                        shown += 1;
                        if palette_card(ui, t, pal, self.settings.theme == pal.id, card_w, motion).clicked() && self.settings.theme != pal.id {
                            self.settings.theme = pal.id.into(); retheme = true; save = true;
                        }
                    }
                });
                if shown == 0 { ui.label(RichText::new(format!("No palette matches \"{}\".", self.palette_query.trim())).color(t.muted)); }
                ui.add_space(14.0);
                ui.label(RichText::new("Accent colour").strong().color(t.text));
                ui.add_space(4.0);
                ui.horizontal_wrapped(|ui| {
                    let palette_accent = rgb(Theme::palette(&self.settings.theme).accent);
                    let mut c = parse_hex(&self.settings.accent).unwrap_or(palette_accent);
                    if ui.color_edit_button_srgba(&mut c).changed() { self.settings.accent = to_hex(c); retheme = true; save = true; }
                    let mut hex = if self.settings.accent.is_empty() { to_hex(palette_accent) } else { self.settings.accent.clone() };
                    if ui.add(egui::TextEdit::singleline(&mut hex).desired_width(90.0).font(TextStyle::Monospace)).changed() {
                        if let Some(parsed) = parse_hex(&hex) { self.settings.accent = to_hex(parsed); retheme = true; save = true; }
                    }
                    for (name, swatch) in [("Cyan", "#22d3ee"), ("Lime", "#a3e635"), ("Amber", "#f59e0b"), ("Coral", "#fb7185"), ("Violet", "#a78bfa"), ("Sky", "#60a5fa")] {
                        let col = parse_hex(swatch).unwrap_or(palette_accent);
                        let (r, resp) = ui.allocate_exact_size(Vec2::splat(22.0), Sense::click());
                        let on = self.settings.accent.eq_ignore_ascii_case(swatch);
                        ui.painter().circle_filled(r.center(), 9.0, col);
                        if on { ui.painter().circle_stroke(r.center(), 11.0, Stroke::new(2.0_f32, t.text)); }
                        if resp.hovered() { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
                        if resp.on_hover_text(name).clicked() { self.settings.accent = swatch.to_string(); retheme = true; save = true; }
                    }
                    if !self.settings.accent.is_empty() && ui.add(pill_widget(t, "Use palette accent", false)).clicked() { self.settings.accent.clear(); retheme = true; save = true; }
                });
                ui.label(RichText::new("Buttons, links, the active page and every highlight follow the accent; button text flips to dark or light by itself.").small().color(t.muted));
                ui.label(RichText::new("Motion, backdrop and glow live in Settings › Performance.").small().color(t.muted));
            });
            }
            if self.settings_visible(SettingsCat::Workspace, "Workspace", "folder root full pc access reference library vault lihfolk notes workspaces recent favourite favorite switch") {
            section_card(ui, t, "05", "Workspace", "The folder the AgentScript file tools and the Explorer work in.", |ui| {
                ui.label(RichText::new(format!("Active root: {}", self.shared.root())).monospace().color(t.muted));
                ui.horizontal(|ui| {
                    ui.add(egui::TextEdit::singleline(&mut self.draft_workspace).hint_text(if cfg!(windows) { "C:\\Users\\you\\TotalWorkspace" } else { "~/TotalWorkspace" }).desired_width(420.0).font(TextStyle::Monospace));
                    let picking = self.picker_rx.is_some();
                    if ui.add_enabled(!picking, button_widget(t, if picking { "Choosing…" } else { "Browse…" }, Btn::Secondary)).clicked() {
                        self.picker_for_reference = false;
                        self.picker_rx = Some(pick_folder(&self.draft_workspace));
                    }
                    let switching = self.workspace_rx.is_some();
                    let changed = self.draft_workspace.trim() != self.shared.root() && !self.draft_workspace.trim().is_empty();
                    if ui.add_enabled(changed && !switching, pill_widget(t, if switching { "Switching…" } else { "Apply" }, true)).clicked() {
                        let (tx, rx) = std::sync::mpsc::channel();
                        if self.cmd_tx.send(UiCommand::SetWorkspace { path: self.draft_workspace.trim().to_string(), reply: tx }).is_ok() { self.workspace_rx = Some(rx); }
                    }
                    if pill(ui, t, "Open", false).clicked() { open_external(&self.shared.root()); }
                });
                ui.label(RichText::new("Applies immediately to the AgentScript engine and the Explorer, and is remembered for the next start. --workspace and TOTAL_WORKSPACE_ROOT still win when given.").small().color(t.muted));
                let mut full = self.shared.full_access();
                if ui.checkbox(&mut full, "FULL PC ACCESS (absolute paths, process_kill, cd anywhere) — applies immediately and on next start").changed() {
                    self.settings.full_access = full;
                    save = true;
                    let _ = self.cmd_tx.send(UiCommand::SetFullAccess(full));
                }
                ui.add_space(8.0);
                ui.label(RichText::new("Reference library (optional)").strong().color(t.text));
                ui.label(RichText::new(if self.settings.reference_dir.trim().is_empty() { "Off — the AI answers limits and API questions from memory only.".to_string() } else { format!("Active: {}", self.settings.reference_dir) }).monospace().color(t.muted));
                ui.horizontal(|ui| {
                    ui.add(egui::TextEdit::singleline(&mut self.draft_reference).hint_text(if cfg!(windows) { "C:\\Users\\you\\LihFolk Vault V2" } else { "~/LihFolk Vault V2" }).desired_width(420.0).font(TextStyle::Monospace));
                    let picking = self.picker_rx.is_some();
                    if ui.add_enabled(!picking, button_widget(t, if picking { "Choosing…" } else { "Browse…" }, Btn::Secondary)).clicked() {
                        self.picker_for_reference = true;
                        self.picker_rx = Some(pick_folder(&self.draft_reference));
                    }
                    let switching = self.reference_rx.is_some();
                    let changed = self.draft_reference.trim() != self.settings.reference_dir.trim();
                    if ui.add_enabled(changed && !switching, pill_widget(t, if switching { "Applying…" } else { "Apply" }, true)).clicked() {
                        let (tx, rx) = std::sync::mpsc::channel();
                        if self.cmd_tx.send(UiCommand::SetReferenceDir { path: self.draft_reference.trim().to_string(), reply: tx }).is_ok() { self.reference_rx = Some(rx); }
                    }
                    if ui.add_enabled(!self.settings.reference_dir.trim().is_empty() && !switching, button_widget(t, "Turn off", Btn::Secondary)).clicked() {
                        let (tx, rx) = std::sync::mpsc::channel();
                        if self.cmd_tx.send(UiCommand::SetReferenceDir { path: String::new(), reply: tx }).is_ok() { self.reference_rx = Some(rx); }
                    }
                });
                ui.label(RichText::new("A folder of Markdown notes the AI can search with reference_search before stating limits, defaults or 2025-26 API changes (one call, three note summaries). Works with LihFolk Vault V2 (github.com/lihfolk-cy/v2-vault, notes CC BY 4.0 — download it yourself; nothing is bundled), a creator-docs clone or your own notes. Nothing leaves your PC except the snippets the AI reads.").small().color(t.muted));
                ui.add_space(12.0);
                self.workspace_manager(ui);
            });
            }
            if self.settings_visible(SettingsCat::Ai, "AI chat (side panel)", "provider api key model codecraft openai openrouter deepseek gemini ollama temperature steps tools images forget keys") {
            section_card(ui, t, "06", "AI chat (side panel)", "Provider, key and model for the built-in chat.", |ui| {
                ui.label(RichText::new("Bring your own API key: CodeCraft, OpenAI, OpenRouter, Groq, DeepSeek, Gemini, xAI, Mistral, Together, a local Ollama / LM Studio or any OpenAI-compatible endpoint. The model you pick receives the bridge's Studio, plugin and workspace tools and works in Studio for you.").small().color(t.muted));
                ui.horizontal(|ui| {
                    if pill(ui, t, if self.settings.chat_panel_open { "Hide chat panel" } else { "Open chat panel" }, true).clicked() { self.toggle_chat(); }
                    if pill(ui, t, "Open chat setup", false).clicked() { self.settings.chat_panel_open = true; self.chat_setup_open = true; save = true; }
                    let n = self.settings.chat_keys.values().filter(|k| !k.trim().is_empty()).count();
                    if ui.add_enabled(n > 0, button_widget(t, &format!("Forget all API keys ({n})"), Btn::Danger)).clicked() {
                        self.settings.chat_keys.clear();
                        save = true;
                        self.settings_note = "API keys removed from settings.json".into();
                    }
                });
                ui.label(RichText::new(format!("Keys and the chosen model are stored in plain text in {} — only on this PC. Ctrl+J toggles the panel.", Settings::path().display())).small().color(t.muted));
                ui.add_space(10.0);
                ui.label(RichText::new("Conversation").strong().color(t.text));
                if toggle(ui, t, &mut self.settings.chat_tools, "Give the model the bridge tools (Studio, plugin, workspace)") { save = true; }
                if toggle(ui, t, &mut self.settings.chat_send_images, "Forward screenshots returned by tools to the model (vision models)") { save = true; }
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Max steps per message").color(t.muted));
                    if ui.add(egui::DragValue::new(&mut self.settings.chat_max_steps).range(1..=64)).changed() { save = true; }
                    ui.add_space(12.0);
                    ui.label(RichText::new("Temperature").color(t.muted));
                    if ui.add(egui::Slider::new(&mut self.settings.chat_temperature, 0.0..=1.5).fixed_decimals(1)).changed() { save = true; }
                });
            });
            }
            if self.settings_visible(SettingsCat::Integrations, "Roblox Studio MCP", "launcher mcp.bat stdio helper restart command") {
            section_card(ui, t, "07", "Roblox Studio MCP", "How this bridge reaches Studio.", |ui| {
                ui.label(RichText::new(format!("Active launcher: {}", mcp_launcher_display())).monospace().color(t.muted));
                ui.horizontal(|ui| {
                    ui.add(egui::TextEdit::singleline(&mut self.draft_mcp).hint_text(format!("empty = {}", crate::default_mcp_launcher_hint())).desired_width(420.0).font(TextStyle::Monospace));
                    if pill(ui, t, "Apply & restart helper", true).clicked() {
                        self.settings.mcp_command = self.draft_mcp.trim().to_string();
                        save = true;
                        let cmd = self.settings.mcp_command.clone();
                        let _ = self.cmd_tx.send(UiCommand::SetMcpCommand(cmd));
                        self.send(UiCommand::RestartMcp, "Launcher updated — restarting Studio MCP helper");
                    }
                    if pill(ui, t, "Use default", false).clicked() { self.draft_mcp.clear(); }
                });
                ui.label(RichText::new("A custom launcher is any command that speaks MCP over stdio (for example a different mcp.bat or a wrapper script). TOTAL_MCP_COMMAND in the environment still takes precedence at start.").small().color(t.muted));
            });
            }
            if self.settings_visible(SettingsCat::Integrations, "Integrations", "extension studio plugin pair mode provider status connected") {
                section_card(ui, t, "08", "Integrations", "Everything the bridge talks to, with its live state.", |ui| { self.integrations_section(ui); });
            }
            if self.settings_visible(SettingsCat::Performance, "Performance", "motion backdrop glow effects fps repaint gpu memory console activity notifications clear") {
                section_card(ui, t, "09", "Performance", "Effects and what the window keeps in memory.", |ui| { if self.performance_section(ui) { save = true; } });
            }
            if self.settings_visible(SettingsCat::Privacy, "Privacy", "stored keys plain text log network 127.0.0.1 upload telemetry forget diagnostics") {
                section_card(ui, t, "10", "Privacy", "What this app stores, where, and what it never sends.", |ui| { if self.privacy_section(ui) { save = true; } });
            }
            if self.settings_visible(SettingsCat::Shortcuts, "Shortcuts", "keyboard keys hotkey ctrl palette esc f1 f5") {
                section_card(ui, t, "11", "Keyboard shortcuts", "Every key the window handles.", |ui| { self.shortcuts_section(ui); });
            }
            if self.settings_visible(SettingsCat::Advanced, "Advanced", "paths export import reset defaults quit settings.json log data folder") {
                section_card(ui, t, "12", "Advanced", "Paths, export / import and reset.", |ui| { let (s2, r2) = self.advanced_section(ui); if s2 { save = true; } if r2 { retheme = true; } });
            }
            if self.settings_visible(SettingsCat::About, "Donate", "donate robux game pass thanks support") {
            section_card(ui, t, "13", "Donate", "Free tool — a Robux game pass says thanks.", |ui| {
                ui.label(RichText::new("TotalScript is free. If it saves you time, a Robux game-pass donation keeps it going — each button opens the pass on roblox.com.").color(t.muted));
                ui.add_space(6.0);
                donation_row(ui, t);
            });
            }
            if self.settings_visible(SettingsCat::About, "About", "version build repository github rebuild cargo keyboard") {
            section_card(ui, t, "14", "About", "Version, repository and rebuild notes.", |ui| {
            ui.horizontal(|ui| {
                self.logo_mark(ui, 40.0);
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 2.0;
                    ui.label(RichText::new(format!("TotalScript Desktop {}", env!("CARGO_PKG_VERSION"))).size(16.0).strong().color(t.text));
                    ui.label(RichText::new(format!("Rust {} build · {} {} · bridge protocol compatible with total-core 1.18", if cfg!(debug_assertions) { "debug" } else { "release" }, std::env::consts::OS, std::env::consts::ARCH)).small().color(t.muted));
                });
            });
            ui.add_space(6.0);
            ui.label(RichText::new("Rebuild: cd TotalScript\\agent && cargo build --release  ->  target\\release\\total-core.exe").monospace().small().color(t.muted));
            ui.label(RichText::new("Keyboard: Ctrl+K command palette · Ctrl+1…9 pages · F1 help · Ctrl+J chat panel · Ctrl+R restart MCP helper · F5 probe Studio + refresh · Ctrl+Shift+S capture Studio viewport · Ctrl+Shift+N notifications · Ctrl+S save file · Ctrl+Enter run Luau — full list in Settings › Shortcuts").small().color(t.muted));
            ui.horizontal_wrapped(|ui| {
                if pill(ui, t, "Open repository", false).clicked() { open_external(&format!("https://github.com/{REPO}")); }
                if pill(ui, t, "Check for updates", false).on_hover_text("Opens the GitHub releases page — this app has no built-in updater; compare the version there with the one above").clicked() { open_external(&format!("https://github.com/{REPO}/releases")); }
            });
            ui.label(RichText::new("No automatic update check: nothing is downloaded or phoned home. Rebuild from source or take the next release zip.").small().color(t.muted));
        });
            }
            if searching && (ui.cursor().top() - before).abs() < 1.0 {
                empty_state(ui, t, "No setting matches", "Try another word — categories, titles and keywords are searched.");
            }
            if !self.settings_note.is_empty() {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(&self.settings_note).color(t.warn));
                    if ghost(ui, t, "Dismiss").clicked() { self.settings_note.clear(); }
                });
            }
        });
        });
        if retheme { self.theme = Theme::from_settings(&self.settings); self.theme.apply(ui.ctx(), &self.settings); }
        if save {
            match self.settings.save() { Ok(()) => self.toast("Settings saved", true), Err(e) => self.toast(format!("Could not save settings: {e}"), false) }
        }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) { self.frame(ctx); }
}

impl App {
    /// One UI frame. Separate from `eframe::App::update` so the headless
    /// snapshot test (`gui::snapshot`) can drive the same code.
    fn frame(&mut self, ctx: &egui::Context) {
        if self.first_frame {
            self.first_frame = false;
            if self.start_hidden {
                hide_window();
                self.shared.track("app", "started hidden — bridge running in the background");
            }
        }
        self.poll_async(ctx);
        self.handle_close(ctx);
        self.update_tray();
        if window_hidden() {
            // Nothing to draw. Keep the runtime pollers alive at a slow tick so
            // a quit/show request or a finished job is still picked up.
            ctx.request_repaint_after(Duration::from_secs(2));
            return;
        }
        self.handle_shortcuts(ctx);
        // Remember the window size (saved with the other settings on close / quit).
        if let Some(rect) = ctx.input(|i| i.viewport().inner_rect) {
            if rect.width() >= 600.0 && rect.height() >= 400.0
                && (rect.width() != self.settings.window_width || rect.height() != self.settings.window_height) {
                self.settings.window_width = rect.width();
                self.settings.window_height = rect.height();
                self.size_dirty = true;
            }
        }
        if self.size_dirty && self.last_size_save.elapsed() > Duration::from_secs(30) {
            self.last_size_save = Instant::now();
            self.size_dirty = false;
            let _ = self.settings.save();
        }

        self.titlebar(ctx);
        self.status_bar(ctx);
        self.sidebar(ctx);
        if self.page != Page::Chat { self.chat_panel(ctx); }
        let t = self.theme;
        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(t.bg).inner_margin(Margin::symmetric(24.0, 18.0)))
            .show(ctx, |ui| {
                if self.settings.backdrop { paint_backdrop(ui.painter(), ui.max_rect().expand2(Vec2::new(24.0, 18.0)), t, if self.settings.motion { ctx.input(|i| i.time) as f32 } else { 0.0 }); }
                self.page_header(ui);
                match self.page {
                    Page::Home => self.page_home(ui),
                    Page::Chat => self.page_chat(ui),
                    Page::Explorer => self.page_explorer(ui),
                    Page::Servers => self.page_servers(ui),
                    Page::Terminal => self.page_terminal(ui),
                    Page::Activity => self.page_activity(ui),
                    Page::Diagnostics => self.page_diagnostics(ui),
                    Page::Help => self.page_help(ui),
                    Page::Settings => self.page_settings(ui),
                }
            });

        self.chat_setup_window(ctx);
        self.draw_notice_center(ctx);
        self.draw_palette(ctx);
        { let t = self.theme; self.egg.show(ctx, t.text, t.muted, t.accent); }

        self.draw_toasts(ctx);
        let busy = self.term_run.is_some() || self.luau_run.is_some()
            || self.snapshot_run.is_some() || self.picker_rx.is_some() || self.workspace_rx.is_some()
            || self.chat_turn.is_some() || self.chat_models_rx.is_some();
        // Idle cadence: busy jobs tick fast; with motion on and the window
        // focused the backdrop drifts at ~12 fps; otherwise a slow heartbeat.
        let focused = ctx.input(|i| i.focused);
        ctx.request_repaint_after(Duration::from_millis(if busy { 120 } else if self.settings.motion && self.settings.backdrop && focused { 80 } else { 700 }));
    }
}

#[cfg(test)]
mod snapshot;

// ───────────────────────────── AI chat side panel ─────────────────────────────

impl App {
    fn chat_provider(&self) -> &'static crate::chat::Provider { crate::chat::provider(&self.settings.chat_provider) }

    fn chat_base_url(&self) -> String {
        let p = self.chat_provider();
        if p.id == "custom" { crate::chat::normalize_base(&self.settings.chat_custom_url) } else { p.base_url.to_string() }
    }

    fn chat_key(&self) -> String {
        self.settings.chat_keys.get(&self.settings.chat_provider).cloned().unwrap_or_default().trim().to_string()
    }

    fn chat_model(&self) -> String {
        self.settings.chat_models.get(&self.settings.chat_provider).cloned().unwrap_or_default().trim().to_string()
    }

    fn set_chat_model(&mut self, model: &str) {
        let pid = self.settings.chat_provider.clone();
        self.settings.chat_models.insert(pid, model.trim().to_string());
    }

    /// Base URL + key (when the preset needs one) + model are all set.
    fn chat_ready(&self) -> bool {
        let p = self.chat_provider();
        !self.chat_base_url().is_empty() && (!p.needs_key || !self.chat_key().is_empty()) && !self.chat_model().is_empty()
    }

    fn toggle_chat(&mut self) {
        self.settings.chat_panel_open = !self.settings.chat_panel_open;
        if self.settings.chat_panel_open { self.chat_pending_focus = true; }
        let _ = self.settings.save();
    }

    fn chat_refresh_models(&mut self) {
        if self.chat_models_rx.is_some() { return; }
        let base = self.chat_base_url();
        if base.is_empty() { self.chat_models_note = "Enter a base URL first".into(); return; }
        let (tx, rx) = std::sync::mpsc::channel();
        if self.cmd_tx.send(UiCommand::ChatModels { base_url: base, api_key: self.chat_key(), reply: tx }).is_ok() {
            self.chat_models_rx = Some(rx);
            self.chat_models_note = "Loading models…".into();
        } else {
            self.toast("Bridge runtime is not reachable", false);
        }
    }

    fn chat_push(&mut self, role: ChatRole, text: impl Into<String>) {
        self.chat_items.push(ChatMsg { role, text: text.into(), thinking: String::new(), tools: Vec::new(), at: chrono::Local::now().format("%H:%M").to_string() });
    }

    fn chat_send(&mut self) {
        if self.chat_turn.is_some() { return; }
        let text = self.chat_input.trim().to_string();
        if text.is_empty() { return; }
        if !self.chat_ready() {
            self.chat_setup_open = true;
            self.toast("Finish the chat setup first (provider, API key, model)", false);
            return;
        }
        self.chat_input.clear();
        self.chat_setup_open = false;
        self.chat_push(ChatRole::User, text.clone());
        self.chat_history.push(serde_json::json!({"role": "user", "content": text}));
        let request = crate::chat::TurnRequest {
            base_url: self.chat_base_url(),
            api_key: self.chat_key(),
            model: self.chat_model(),
            messages: self.chat_history.clone(),
            tools: self.settings.chat_tools,
            max_steps: self.settings.chat_max_steps.max(1) as usize,
            temperature: self.settings.chat_temperature,
            send_images: self.settings.chat_send_images,
            instructions: self.settings.chat_instructions.clone(),
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        if self.cmd_tx.send(UiCommand::ChatTurn { request, events: tx, cancel: cancel.clone() }).is_ok() {
            self.chat_turn = Some(ChatTurn { receiver: rx, cancel, started: Instant::now() });
            self.chat_status = "starting…".into();
        } else {
            self.toast("Bridge runtime is not reachable", false);
        }
        self.chat_pending_focus = true;
    }

    fn chat_stop(&mut self) {
        // A pending Allow / Deny is answered "deny" so the turn can unwind.
        self.chat_answer_approval(false);
        if let Some(turn) = &self.chat_turn {
            turn.cancel.store(true, Ordering::Relaxed);
            self.chat_status = "stopping after the current step…".into();
        }
    }

    fn chat_new(&mut self) {
        self.chat_answer_approval(false);
        if let Some(turn) = &self.chat_turn { turn.cancel.store(true, Ordering::Relaxed); }
        self.chat_turn = None;
        self.chat_items.clear();
        self.chat_history.clear();
        self.chat_tokens = (0, 0);
        self.chat_status.clear();
        self.chat_pending_focus = true;
    }

    fn chat_export(&mut self) {
        if self.chat_items.is_empty() { self.toast("Nothing to export yet", false); return; }
        let mut md = format!("# TotalScript chat — {} · {}\n\n", self.chat_provider().name, self.chat_model());
        for m in &self.chat_items {
            match m.role {
                ChatRole::User => md.push_str(&format!("## You ({})\n\n{}\n\n", m.at, m.text)),
                ChatRole::Assistant => {
                    md.push_str(&format!("## Assistant ({})\n\n", m.at));
                    for c in &m.tools {
                        md.push_str(&format!("<details><summary>tool {} · {} · {} ms</summary>\n\n```json\n{}\n```\n\n```\n{}\n```\n</details>\n\n",
                            c.name, match c.ok { Some(true) => "ok", Some(false) => "error", None => "pending" }, c.elapsed_ms, c.args, truncate(&c.result, 6000)));
                    }
                    md.push_str(&m.text);
                    md.push_str("\n\n");
                }
                ChatRole::Note => md.push_str(&format!("> {}\n\n", m.text)),
            }
        }
        let name = format!("totalscript-chat-{}.md", chrono::Local::now().format("%Y%m%d-%H%M%S"));
        let path = self.workspace_root().join(&name);
        match std::fs::write(&path, md) {
            Ok(()) => { let p = path.to_string_lossy().to_string(); self.toast(format!("Saved {}", short_path(&p, 60)), true); }
            Err(e) => self.toast(format!("Export failed: {e}"), false),
        }
    }

    fn chat_last_assistant(&mut self) -> &mut ChatMsg {
        let needs_new = !matches!(self.chat_items.last(), Some(m) if m.role == ChatRole::Assistant);
        if needs_new { self.chat_push(ChatRole::Assistant, ""); }
        self.chat_items.last_mut().expect("assistant message")
    }

    /// Drain chat events / model list replies (called from `poll_async`).
    fn chat_poll(&mut self, ctx: &egui::Context) {
        // Model list
        let models = self.chat_models_rx.as_ref().map(|rx| rx.try_recv());
        if let Some(result) = models {
            match result {
                Ok(Ok(list)) => {
                    self.chat_models_note = format!("{} models", list.len());
                    let current = self.chat_model();
                    if current.is_empty() || !list.iter().any(|m| *m == current) {
                        if let Some(first) = pick_default_model(&list) { self.set_chat_model(&first); }
                    }
                    self.chat_model_list = list;
                    self.chat_models_rx = None;
                    let _ = self.settings.save();
                }
                Ok(Err(e)) => { self.chat_models_note = e; self.chat_models_rx = None; }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => { self.chat_models_note = "runtime dropped the request".into(); self.chat_models_rx = None; }
            }
        }
        // Turn events — drain everything that arrived since the last frame.
        let mut finished = false;
        loop {
            let Some(turn) = &self.chat_turn else { break };
            let event = match turn.receiver.try_recv() {
                Ok(ev) => ev,
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(_) => {
                    self.chat_push(ChatRole::Note, "The runtime dropped this turn.");
                    finished = true;
                    break;
                }
            };
            use crate::chat::ChatEvent as E;
            match event {
                E::Status(s) => self.chat_status = s,
                E::AssistantStart => {
                    let fresh = !matches!(self.chat_items.last(), Some(m) if m.role == ChatRole::Assistant && m.text.is_empty() && m.tools.is_empty() && m.thinking.is_empty());
                    if fresh { self.chat_push(ChatRole::Assistant, ""); }
                }
                E::Delta(text) => { self.chat_last_assistant().text.push_str(&text); }
                E::Thinking(text) => { self.chat_last_assistant().thinking.push_str(&text); }
                E::ToolStart { id, name, args } => {
                    let args = match args { serde_json::Value::String(s) => s, other => serde_json::to_string_pretty(&other).unwrap_or_default() };
                    self.chat_last_assistant().tools.push(ChatToolCard { id, name, args, result: String::new(), ok: None, elapsed_ms: 0, images: Vec::new(), open: false });
                }
                E::Approval { name, args, reply } => {
                    let args = serde_json::to_string_pretty(&args).unwrap_or_default();
                    self.chat_status = format!("waiting for Allow / Deny · {name}");
                    self.chat_approval = Some(PendingApproval { name, args, reply: Some(reply), since: Instant::now() });
                    show_window();
                }
                E::ToolDone { id, name, ok, text, images, elapsed_ms } => {
                    let mut textures = Vec::new();
                    for (n, (_mime, data)) in images.iter().enumerate().take(2) {
                        if let Ok((rgba, w, h)) = decode_image(data) {
                            let image = egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba);
                            let tex = ctx.load_texture(format!("chat-img-{id}-{n}"), image, egui::TextureOptions::LINEAR);
                            textures.push((tex, [w as usize, h as usize]));
                        }
                    }
                    if ok && !images.is_empty() { self.store_snapshot(ctx, &images, &name); }
                    let msg = self.chat_last_assistant();
                    let pos = msg.tools.iter().rposition(|c| c.id == id);
                    match pos {
                        Some(i) => {
                            let card = &mut msg.tools[i];
                            card.ok = Some(ok);
                            card.result = text;
                            card.elapsed_ms = elapsed_ms;
                            card.images = textures;
                            card.open = !ok;
                        }
                        None => msg.tools.push(ChatToolCard { id, name, args: String::new(), result: text, ok: Some(ok), elapsed_ms, images: textures, open: !ok }),
                    }
                }
                E::Finished { appended, prompt_tokens, completion_tokens, steps, error } => {
                    self.chat_history.extend(appended);
                    self.chat_tokens.0 += prompt_tokens;
                    self.chat_tokens.1 += completion_tokens;
                    if let Some(turn) = &self.chat_turn { self.chat_last_turn_ms = turn.started.elapsed().as_millis(); }
                    // Drop a trailing empty assistant bubble (e.g. error before any text).
                    if matches!(self.chat_items.last(), Some(m) if m.role == ChatRole::Assistant && m.text.trim().is_empty() && m.tools.is_empty() && m.thinking.trim().is_empty()) { self.chat_items.pop(); }
                    match error {
                        Some(e) if e == "stopped" => { self.chat_push(ChatRole::Note, "Stopped."); self.chat_status = "stopped".into(); }
                        Some(e) => { self.chat_push(ChatRole::Note, e.clone()); self.chat_status = format!("error · {}", truncate(&e, 80)); }
                        None => { self.chat_status = format!("done · {steps} step(s) · {:.1} s", self.chat_last_turn_ms as f64 / 1000.0); }
                    }
                    finished = true;
                    break;
                }
            }
        }
        if finished { self.chat_turn = None; self.chat_approval = None; self.chat_pending_focus = true; }
    }

    /// Answer the pending Allow / Deny (no-op when nothing is waiting).
    fn chat_answer_approval(&mut self, allow: bool) {
        if let Some(mut p) = self.chat_approval.take() {
            if let Some(tx) = p.reply.take() { let _ = tx.send(allow); }
            self.chat_status = if allow { format!("running {}", p.name) } else { format!("{} denied", p.name) };
        }
    }

    /// The Allow / Deny box shown above the composer while a guarded tool waits.
    fn chat_approval_box(&mut self, ui: &mut egui::Ui) {
        let Some(p) = &self.chat_approval else { return };
        let t = self.theme;
        let name = p.name.clone();
        let args = p.args.clone();
        let waited = p.since.elapsed().as_secs();
        let left = crate::chat::APPROVAL_TIMEOUT.as_secs().saturating_sub(waited);
        let mut answer: Option<bool> = None;
        egui::Frame::none()
            .fill(t.panel2)
            .stroke(Stroke::new(1.0_f32, t.warn))
            .rounding(Rounding::same(8.0))
            .inner_margin(Margin::symmetric(10.0, 8.0))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    status_dot(ui, t.warn);
                    ui.label(RichText::new(format!("The model wants to run {name}")).strong());
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(RichText::new(format!("auto-deny in {left} s")).small().color(t.muted));
                    });
                });
                ui.label(RichText::new("This runs a program, kills a process, deletes, downloads or opens something on your PC. Nothing happens until you answer.").small().color(t.muted));
                let shown = truncate(&args, 600);
                egui::ScrollArea::vertical().max_height(120.0).show(ui, |ui| {
                    ui.add(egui::Label::new(RichText::new(shown).monospace().small()).wrap());
                });
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    if pill(ui, t, "Allow once", true).clicked() { answer = Some(true); }
                    if pill(ui, t, "Deny", false).clicked() { answer = Some(false); }
                    ui.label(RichText::new("Esc = Deny").small().color(t.muted));
                });
            });
        if ui.input(|i| i.key_pressed(egui::Key::Escape)) { answer = Some(false); }
        if let Some(a) = answer { self.chat_answer_approval(a); }
        ui.add_space(6.0);
    }

    fn chat_panel(&mut self, ctx: &egui::Context) {
        if !self.settings.chat_panel_open { return; }
        let t = self.theme;
        let width = self.settings.chat_panel_width.clamp(320.0, 760.0);
        let inner = egui::SidePanel::right("chat-panel")
            .default_width(width)
            .width_range(320.0..=760.0)
            .resizable(true)
            .frame(egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border)))
            .show(ctx, |ui| {
                egui::TopBottomPanel::top("chat-head")
                    .frame(egui::Frame::none().fill(t.bg2).inner_margin(Margin::symmetric(12.0, 10.0)))
                    .show_inside(ui, |ui| self.chat_header(ui, false));
                egui::TopBottomPanel::bottom("chat-composer")
                    .frame(egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border)).inner_margin(Margin::symmetric(12.0, 10.0)))
                    .show_inside(ui, |ui| self.chat_composer(ui, ctx));
                egui::CentralPanel::default()
                    .frame(egui::Frame::none().fill(t.bg).inner_margin(Margin::symmetric(12.0, 8.0)))
                    .show_inside(ui, |ui| self.chat_transcript(ui));
            });
        let w = inner.response.rect.width();
        if w >= 320.0 && (w - self.settings.chat_panel_width).abs() > 1.0 {
            self.settings.chat_panel_width = w;
            self.size_dirty = true;
        }
    }

    /// Full-page chat (sidebar → AI Chat). Same widgets as the side panel,
    /// laid out in a centred column; the side panel is hidden while this
    /// page is shown so the two never draw the same widget ids at once.
    #[allow(deprecated)] // allocate_ui_at_rect: still the plain way to place a fixed-width column in egui 0.29
    fn page_chat(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let ctx = ui.ctx().clone();
        let column = ui.available_width().min(1040.0);
        // A centred column of fixed width: compute the rect by hand so the
        // widgets inside keep a normal left-aligned, top-down layout.
        let column_rect = |ui: &egui::Ui| {
            let r = ui.available_rect_before_wrap();
            let half = column / 2.0;
            egui::Rect::from_min_max(egui::pos2(r.center().x - half, r.top()), egui::pos2(r.center().x + half, r.bottom()))
        };
        egui::TopBottomPanel::bottom("chat-page-composer")
            .frame(egui::Frame::none().fill(t.bg).inner_margin(Margin::symmetric(0.0, 8.0)))
            .show_inside(ui, |ui| {
                let rect = column_rect(ui);
                ui.allocate_ui_at_rect(rect, |ui| {
                    egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card + 2.0)).inner_margin(Margin::symmetric(12.0, 10.0)).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        self.chat_composer(ui, &ctx);
                    });
                });
            });
        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(t.bg))
            .show_inside(ui, |ui| {
                let rect = column_rect(ui);
                ui.allocate_ui_at_rect(rect, |ui| {
                    ui.set_min_height(rect.height());
                    egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card + 2.0)).inner_margin(Margin::symmetric(12.0, 8.0)).show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        self.chat_header(ui, true);
                    });
                    ui.add_space(8.0);
                    self.chat_transcript(ui);
                });
            });
    }

    /// Provider / key / model setup as a floating window, so it never squeezes
    /// the transcript out of view (the old inline card did exactly that).
    fn chat_setup_window(&mut self, ctx: &egui::Context) {
        if !self.chat_setup_open { return; }
        if !(self.settings.chat_panel_open || self.page == Page::Chat) { return; }
        let mut open = true;
        let max_h = (ctx.screen_rect().height() - 120.0).max(240.0);
        egui::Window::new("AI chat setup")
            .id(egui::Id::new("chat-setup-window"))
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
            .default_width(540.0)
            .max_height(max_h)
            .vscroll(true)
            .show(ctx, |ui| {
                ui.set_width(520.0);
                self.chat_setup(ui);
            });
        if !open {
            self.chat_setup_open = false;
            let _ = self.settings.save();
            self.chat_pending_focus = true;
        }
    }

    fn chat_header(&mut self, ui: &mut egui::Ui, in_page: bool) {
        let t = self.theme;
        let busy = self.chat_turn.is_some();
        // Row 1: title + provider/model (truncated to the room left), close
        // button on the right. Row 2: the actions, wrapping when the panel is
        // narrow instead of running over the title.
        ui.horizontal(|ui| {
            if !in_page { ui.label(RichText::new("AI Chat").size(16.0).strong().color(t.text)); }
            let model = self.chat_model();
            let sub = if model.is_empty() { format!("{} · no model", self.chat_provider().name) } else { format!("{} · {}", self.chat_provider().name, model) };
            let mut close = false;
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if !in_page && window_button(ui, WinGlyph::Close, t.text, t).on_hover_text("Hide the chat panel (Ctrl+J)").clicked() { close = true; }
                ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                    ui.add(egui::Label::new(RichText::new(&sub).small().color(t.muted)).truncate()).on_hover_text(sub.clone());
                });
            });
            if close { self.toggle_chat(); }
        });
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            ui.with_layout(Layout::right_to_left(Align::Center).with_main_wrap(true), |ui| {
                if in_page {
                    if pill(ui, t, "Side panel", false).on_hover_text("Keep chatting in a side panel while you use the other pages (Ctrl+J)").clicked() {
                        self.settings.chat_panel_open = true;
                        let _ = self.settings.save();
                        self.go(Page::Home);
                        self.chat_pending_focus = true;
                    }
                }
                if pill(ui, t, "Setup", self.chat_setup_open).on_hover_text("Provider, API key, model, tools").clicked() {
                    self.chat_setup_open = !self.chat_setup_open;
                    if !self.chat_setup_open { let _ = self.settings.save(); }
                }
                if pill(ui, t, "New", false).on_hover_text("Start a fresh conversation").clicked() { self.chat_new(); }
                let pair_on = self.shared.pair_enabled.load(Ordering::Relaxed);
                if pill(ui, t, "Pair", pair_on).on_hover_text(if pair_on { "Pair mode is on: the Studio plugin reports what you do by hand (selection, script edits, new instances, property changes) and the model sees it each turn. Click to stop." } else { "Pair mode: build by hand in Studio while the model watches, checks your edited scripts and comments only on concrete findings. Needs the TotalScript Studio plugin." }).clicked() {
                    self.settings.pair_mode = !pair_on;
                    let _ = self.settings.save();
                    self.shared.set_pair(!pair_on, 0, Vec::new());
                    let _ = self.cmd_tx.send(UiCommand::SetPair(!pair_on));
                }
                if ui.add_enabled(!self.chat_items.is_empty(), button_widget(t, "Export", Btn::Ghost)).on_hover_text("Save the transcript as Markdown in the workspace").clicked() { self.chat_export(); }
            });
        });
        self.chat_pair_line(ui);
        ui.horizontal(|ui| {
            let (dot, text) = if busy { (t.warn, if self.chat_status.is_empty() { "working…".to_string() } else { self.chat_status.clone() }) }
                else if !self.chat_ready() { (t.muted, "not configured — open Setup".to_string()) }
                else if self.chat_status.is_empty() { (t.ok, if self.settings.chat_tools { "ready · tools on".to_string() } else { "ready · tools off".to_string() }) }
                else { (t.ok, self.chat_status.clone()) };
            status_dot(ui, dot);
            ui.label(RichText::new(truncate(&text, 70)).small().color(t.muted));
            if self.chat_tokens.0 + self.chat_tokens.1 > 0 {
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.label(RichText::new(format!("{} in · {} out", self.chat_tokens.0, self.chat_tokens.1)).small().color(t.muted)).on_hover_text("Tokens used in this conversation (as reported by the provider)");
                });
            }
        });
    }

    /// 2.8.0: one line under the chat header while pair mode is on — what the
    /// plugin reported so far and a button that hands the findings to the model.
    fn chat_pair_line(&mut self, ui: &mut egui::Ui) {
        if !self.shared.pair_enabled.load(Ordering::Relaxed) { return; }
        let t = self.theme;
        let events = self.shared.pair_events.load(Ordering::Relaxed);
        let findings: Vec<(String, usize)> = self.shared.pair_findings.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let total: usize = findings.iter().map(|(_, n)| n).sum();
        let studio = self.shared.plugin_connected();
        ui.horizontal(|ui| {
            status_dot(ui, if !studio { t.muted } else if total > 0 { t.warn } else { t.ok });
            let text = if !studio { "Pair · waiting for the Studio plugin".to_string() }
                else if events == 0 { "Pair · watching Studio · nothing yet".to_string() }
                else { format!("Pair · watching · {events} event{} · {total} finding{}", if events == 1 { "" } else { "s" }, if total == 1 { "" } else { "s" }) };
            let hover = if findings.is_empty() { "Script edits are checked for deprecated APIs and references to children that do not exist.".to_string() }
                else { findings.iter().map(|(p, n)| format!("{p}: {n}")).collect::<Vec<_>>().join("\n") };
            ui.label(RichText::new(text).small().color(t.muted)).on_hover_text(hover);
            if total > 0 && self.chat_turn.is_none() {
                if ui.add(button_widget(t, "Ask AI to review", Btn::Secondary)).on_hover_text("Sends the open findings to the model and asks for fixes with a short explanation each").clicked() {
                    let paths: Vec<String> = findings.iter().filter(|(_, n)| *n > 0).map(|(p, _)| p.clone()).collect();
                    self.chat_input = format!("Pair mode found issues in {}. Review the findings and fix them (explain each change briefly, keep the rest of my code as it is).", paths.join(", "));
                    self.chat_send();
                }
            }
        });
    }

    fn chat_setup(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border2)).rounding(Rounding::same(t.r_card)).inner_margin(Margin::same(12.0));
        frame.show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(RichText::new("PROVIDER").small().strong().color(t.muted));
            let current = self.settings.chat_provider.clone();
            let mut switched: Option<&'static str> = None;
            egui::ComboBox::from_id_salt("chat-provider")
                .width(ui.available_width() - 8.0)
                .selected_text(self.chat_provider().name)
                .show_ui(ui, |ui| {
                    for p in crate::chat::PROVIDERS {
                        if ui.selectable_label(current == p.id, p.name).clicked() && current != p.id { switched = Some(p.id); }
                    }
                });
            if let Some(id) = switched {
                self.settings.chat_provider = id.to_string();
                self.chat_model_list = self.settings.chat_models.get(id).filter(|m| !m.is_empty()).map(|m| vec![m.clone()]).unwrap_or_default();
                self.chat_models_note.clear();
                self.chat_models_rx = None;
            }
            let p = self.chat_provider();
            ui.add_space(6.0);
            ui.label(RichText::new("BASE URL").small().strong().color(t.muted));
            if p.id == "custom" {
                ui.add(egui::TextEdit::singleline(&mut self.settings.chat_custom_url).hint_text("https://host/v1").desired_width(f32::INFINITY).font(TextStyle::Monospace));
            } else {
                ui.label(RichText::new(p.base_url).monospace().small().color(t.muted));
            }
            ui.add_space(6.0);
            ui.label(RichText::new(if p.needs_key { "API KEY" } else { "API KEY (optional)" }).small().strong().color(t.muted));
            let visible = self.chat_key_visible;
            ui.horizontal(|ui| {
                let key = self.settings.chat_keys.entry(p.id.to_string()).or_default();
                ui.add(egui::TextEdit::singleline(key).password(!visible).hint_text("paste your key").desired_width(ui.available_width() - 60.0).font(TextStyle::Monospace));
                if ui.selectable_label(visible, "show").clicked() { self.chat_key_visible = !visible; }
            });
            ui.label(RichText::new(p.key_hint).small().color(t.muted));
            ui.add_space(6.0);
            ui.label(RichText::new("MODEL").small().strong().color(t.muted));
            ui.horizontal(|ui| {
                let current_model = self.chat_model();
                let mut picked: Option<String> = None;
                let list = self.chat_model_list.clone();
                egui::ComboBox::from_id_salt("chat-model")
                    .width(ui.available_width() - 90.0)
                    .selected_text(if current_model.is_empty() { "choose a model…".to_string() } else { truncate(&current_model, 40) })
                    .show_ui(ui, |ui| {
                        if list.is_empty() { ui.label(RichText::new("press Refresh to load the model list").small().color(t.muted)); }
                        for m in &list {
                            if ui.selectable_label(*m == current_model, m).clicked() { picked = Some(m.clone()); }
                        }
                    });
                if let Some(m) = picked { self.set_chat_model(&m); let _ = self.settings.save(); }
                let loading = self.chat_models_rx.is_some();
                if ui.add_enabled(!loading, pill_widget(t, if loading { "…" } else { "Refresh" }, false)).on_hover_text("GET /models with this key").clicked() { self.chat_refresh_models(); }
            });
            ui.horizontal(|ui| {
                let mut manual = self.chat_model();
                ui.label(RichText::new("or type an id").small().color(t.muted));
                if ui.add(egui::TextEdit::singleline(&mut manual).desired_width(f32::INFINITY).font(TextStyle::Monospace).hint_text("gpt-4.1-mini, claude-sonnet-4, llama-3.3-70b…")).changed() {
                    self.set_chat_model(&manual);
                }
            });
            if !self.chat_models_note.is_empty() { ui.label(RichText::new(&self.chat_models_note).small().color(if self.chat_models_note.ends_with("models") { t.ok } else { t.warn })); }
            ui.add_space(6.0);
            ui.label(RichText::new("AGENT").small().strong().color(t.muted));
            ui.checkbox(&mut self.settings.chat_tools, "Give the model the Studio + workspace tools (function calling)");
            ui.checkbox(&mut self.settings.chat_send_images, "Forward screenshots from tools to the model (vision models)");
            ui.horizontal(|ui| {
                ui.label("Max steps per message");
                ui.add(egui::DragValue::new(&mut self.settings.chat_max_steps).range(1..=64));
                ui.add_space(12.0);
                ui.label("Temperature");
                ui.add(egui::Slider::new(&mut self.settings.chat_temperature, 0.0..=1.5).fixed_decimals(1));
            });
            ui.label(RichText::new("Standing instructions (appended to the system prompt)").small().color(t.muted));
            ui.add(egui::TextEdit::multiline(&mut self.settings.chat_instructions).desired_rows(2).desired_width(f32::INFINITY).hint_text("e.g. Always use typed Luau and put server code in ServerScriptService."));
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                if pill(ui, t, "Done", true).clicked() {
                    let _ = self.settings.save();
                    if self.chat_ready() { self.chat_setup_open = false; self.chat_pending_focus = true; self.toast("Chat settings saved", true); }
                    else { self.toast("Still missing: a model (press Refresh) or the API key", false); }
                }
                ui.label(RichText::new(format!("Keys are stored only in {}", short_path(&Settings::path().to_string_lossy(), 46))).small().color(t.muted));
            });
        });
        ui.add_space(8.0);
    }

    fn chat_transcript(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let busy = self.chat_turn.is_some();
        if self.chat_items.is_empty() {
            ui.add_space(12.0);
            ui.label(RichText::new("Talk to your Studio.").size(20.0).strong().color(t.text));
            if !self.chat_ready() {
                ui.add_space(4.0);
                if pill(ui, t, "Open setup — provider, API key, model", true).clicked() { self.chat_setup_open = true; }
            }
            ui.label(RichText::new("The model you pick gets execute_luau, screen_capture, the plugin commands and the workspace files as tools — it builds, inspects and fixes things in Studio for you, step by step.").color(t.muted));
            ui.add_space(10.0);
            let suggestions = [
                "What is open in Studio right now? List Workspace and ServerScriptService.",
                "Build a spawn lobby: baseplate, 4 coloured pads, a welcome billboard, and a leaderstats script with Coins.",
                "Take a screenshot of the viewport and critique the lighting, then fix it.",
                "Write a typed DataStore module with session locking and autosave, save it to ServerScriptService.",
            ];
            for s in suggestions {
                if ui.add(egui::Button::new(RichText::new(s).small().color(t.text)).fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(10.0)).wrap()).clicked() {
                    self.chat_input = s.to_string();
                    self.chat_pending_focus = true;
                }
            }
            return;
        }
        egui::ScrollArea::vertical().id_salt("chat-scroll").auto_shrink([false, false]).stick_to_bottom(true).show(ui, |ui| {
            // keep a gutter for the floating scrollbar
            ui.set_max_width(ui.available_width() - 8.0);
            let avail = ui.available_width();
            let last = self.chat_items.len().saturating_sub(1);
            let mut fill_input: Option<String> = None;
            for (idx, msg) in self.chat_items.iter_mut().enumerate() {
                match msg.role {
                    ChatRole::User => {
                        // Right-aligned bubble; text inside stays left-aligned.
                        ui.with_layout(Layout::top_down(Align::Max), |ui| {
                            egui::Frame::none().fill(t.accent.linear_multiply(0.16)).stroke(Stroke::new(1.0_f32, t.accent.linear_multiply(0.45))).rounding(Rounding::same(t.r_card + 2.0)).inner_margin(Margin::symmetric(14.0, 10.0)).show(ui, |ui| {
                                ui.set_max_width(avail * 0.8);
                                ui.with_layout(Layout::top_down(Align::Min), |ui| {
                                    ui.add(egui::Label::new(RichText::new(&msg.text).size(15.0).color(t.text)).wrap());
                                });
                            });
                            ui.horizontal(|ui| {
                                if ui.add(egui::Button::new(RichText::new("edit").small()).frame(false)).on_hover_text("Copy this message back into the composer").clicked() { fill_input = Some(msg.text.clone()); }
                                ui.label(RichText::new(&msg.at).small().color(t.muted));
                            });
                        });
                    }
                    ChatRole::Assistant => {
                        egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card + 2.0)).inner_margin(Margin::symmetric(14.0, 12.0)).show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.spacing_mut().item_spacing.y = 6.0;
                            ui.horizontal(|ui| {
                                status_dot(ui, if idx == last && busy { t.warn } else { t.accent });
                                ui.label(RichText::new("TOTALSCRIPT").small().strong().color(t.accent));
                                if !msg.tools.is_empty() { ui.label(RichText::new(format!("{} tool call(s)", msg.tools.len())).small().color(t.muted)); }
                            });
                            if !msg.thinking.trim().is_empty() {
                                let n = msg.thinking.chars().count();
                                egui::CollapsingHeader::new(RichText::new(format!("thinking · {n} chars")).small().color(t.muted))
                                    .id_salt(("chat-thinking", idx))
                                    .default_open(false)
                                    .show(ui, |ui| {
                                        ui.add(egui::Label::new(RichText::new(truncate(&msg.thinking, 12_000)).small().italics().color(t.muted)).wrap());
                                    });
                            }
                            for card in msg.tools.iter_mut() { chat_tool_card(ui, t, card); }
                            if !msg.text.is_empty() {
                                chat_rich_text(ui, t, &msg.text);
                            } else if idx == last && busy {
                                ui.label(RichText::new(if msg.tools.is_empty() && msg.thinking.is_empty() { "waiting for the model…" } else if msg.tools.is_empty() { "thinking…" } else { "working…" }).italics().color(t.muted));
                            }
                            if idx == last && busy && !msg.text.is_empty() {
                                ui.label(RichText::new("…").color(t.accent));
                            }
                        });
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(&msg.at).small().color(t.muted));
                            if !msg.text.is_empty() && ui.add(egui::Button::new(RichText::new("copy").small()).frame(false)).clicked() {
                                let text = msg.text.clone();
                                ui.output_mut(|o| o.copied_text = text);
                            }
                        });
                    }
                    ChatRole::Note => {
                        ui.vertical_centered(|ui| {
                            ui.add(egui::Label::new(RichText::new(&msg.text).small().italics().color(t.warn)).wrap());
                        });
                    }
                }
                ui.add_space(8.0);
            }
            if let Some(text) = fill_input { self.chat_input = text; self.chat_pending_focus = true; }
        });
    }

    fn chat_composer(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        let t = self.theme;
        let busy = self.chat_turn.is_some();
        if busy { self.chat_approval_box(ui); } else if self.chat_approval.is_some() { self.chat_approval = None; }
        let id = egui::Id::new("chat-composer-edit");
        let focused = ctx.memory(|m| m.has_focus(id));
        let mut send = false;
        if focused && !busy {
            let plain = ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Enter));
            let ctrl = ui.input_mut(|i| i.consume_key(egui::Modifiers::COMMAND, egui::Key::Enter));
            if plain || ctrl { send = true; }
        }
        let edit = egui::TextEdit::multiline(&mut self.chat_input)
            .id(id)
            .desired_rows(3)
            .desired_width(f32::INFINITY)
            .hint_text(if busy { "the model is working — Stop to interrupt" } else { "Ask for anything in Studio… (Enter sends, Shift+Enter = new line)" });
        let resp = ui.add(edit);
        if self.chat_pending_focus && !busy { resp.request_focus(); self.chat_pending_focus = false; }
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            let studio = self.shared.studio_connected.load(Ordering::Relaxed);
            status_dot(ui, if studio { t.ok } else { t.muted });
            ui.label(RichText::new(if studio { "Studio linked" } else { "Studio offline" }).small().color(t.muted));
            if !self.settings.chat_tools { ui.label(RichText::new("· tools off").small().color(t.warn)); }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if busy {
                    if pill(ui, t, "Stop", false).clicked() { self.chat_stop(); }
                    ui.label(RichText::new(format!("{:.0} s", self.chat_turn.as_ref().map(|c| c.started.elapsed().as_secs_f32()).unwrap_or(0.0))).small().color(t.muted));
                } else {
                    let can = !self.chat_input.trim().is_empty();
                    if ui.add_enabled(can, pill_widget(t, "Send", true)).clicked() { send = true; }
                    if ui.add(button_widget(t, "Capture", Btn::Ghost)).on_hover_text("Ask the model to screenshot Studio and describe what it sees").clicked() {
                        self.chat_input = "Take a screenshot of the Studio viewport and tell me what you see.".into();
                        send = true;
                    }
                }
            });
        });
        if send { self.chat_send(); }
    }
}

fn pick_default_model(list: &[String]) -> Option<String> {
    let prefs = ["gpt-4.1", "gpt-4o", "claude-sonnet", "claude-3-5-sonnet", "gemini-2.5-pro", "gemini-2.5-flash", "deepseek-chat", "grok-4", "grok-3", "llama-3.3-70b", "qwen2.5", "mistral-large"];
    for p in prefs {
        if let Some(m) = list.iter().find(|m| m.to_lowercase().contains(p)) { return Some(m.clone()); }
    }
    list.first().cloned()
}

fn chat_tool_card(ui: &mut egui::Ui, t: Theme, card: &mut ChatToolCard) {
    let (dot, state) = match card.ok { None => (t.warn, "running"), Some(true) => (t.ok, "ok"), Some(false) => (t.bad, "error") };
    egui::Frame::none().fill(t.panel2).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(8.0)).inner_margin(Margin::symmetric(8.0, 6.0)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            status_dot(ui, dot);
            ui.label(RichText::new(&card.name).monospace().small().strong().color(t.text));
            let meta = if card.ok.is_none() { state.to_string() } else { format!("{state} · {} ms", card.elapsed_ms) };
            ui.label(RichText::new(meta).small().color(t.muted));
            if !card.images.is_empty() { ui.label(RichText::new(format!("{} image(s)", card.images.len())).small().color(t.info)); }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if ui.add(egui::Button::new(RichText::new(if card.open { "hide" } else { "details" }).small()).frame(false)).clicked() { card.open = !card.open; }
            });
        });
        if card.open {
            if !card.args.trim().is_empty() {
                ui.label(RichText::new("arguments").small().color(t.muted));
                ui.add(egui::Label::new(RichText::new(truncate(&card.args, 2000)).monospace().small().color(t.text)).wrap());
            }
            if !card.result.trim().is_empty() {
                ui.label(RichText::new("result").small().color(t.muted));
                egui::ScrollArea::vertical().id_salt(("chat-tool-result", &card.id)).max_height(220.0).auto_shrink([false, true]).show(ui, |ui| {
                    ui.add(egui::Label::new(RichText::new(truncate(&card.result, 8000)).monospace().small().color(if card.ok == Some(false) { t.bad } else { t.text })).wrap());
                });
                ui.horizontal(|ui| {
                    if ui.add(button_widget(t, "copy result", Btn::Ghost)).clicked() { let r = card.result.clone(); ui.output_mut(|o| o.copied_text = r); }
                });
            }
            for (tex, size) in &card.images {
                let w = ui.available_width().min(560.0);
                let h = if size[0] > 0 { w * size[1] as f32 / size[0] as f32 } else { w * 0.56 };
                ui.add(egui::Image::from_texture(egui::load::SizedTexture::new(tex.id(), Vec2::new(w, h))).rounding(Rounding::same(6.0)));
            }
        }
    });
    ui.add_space(4.0);
}

/// Minimal Markdown: ``` fenced blocks become monospace cards with a copy
/// button, everything else is wrapped text.
fn chat_rich_text(ui: &mut egui::Ui, t: Theme, text: &str) {
    for (i, seg) in text.split("```").enumerate() {
        if i % 2 == 1 {
            let (lang, body) = match seg.split_once('\n') {
                Some((first, rest)) if first.trim().len() <= 16 && !first.trim().contains(' ') => (first.trim().to_string(), rest.to_string()),
                _ => (String::new(), seg.to_string()),
            };
            let body = body.trim_end_matches('\n').to_string();
            egui::Frame::none().fill(t.bg).stroke(Stroke::new(1.0_f32, t.border2)).rounding(Rounding::same(8.0)).inner_margin(Margin::symmetric(10.0, 8.0)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    ui.label(RichText::new(if lang.is_empty() { "code" } else { lang.as_str() }).small().color(t.muted));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if ui.add(egui::Button::new(RichText::new("copy").small()).frame(false)).clicked() { let b = body.clone(); ui.output_mut(|o| o.copied_text = b); }
                    });
                });
                ui.add(egui::Label::new(RichText::new(&body).monospace().small().color(t.text)).wrap());
            });
            ui.add_space(4.0);
        } else {
            let plain = seg.trim_matches('\n');
            if plain.is_empty() { continue; }
            ui.add(egui::Label::new(RichText::new(plain).size(15.0).color(t.text)).wrap());
        }
    }
}

// ───────────────────────────── widgets ─────────────────────────────

fn status_dot(ui: &mut egui::Ui, color: Color32) {
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(10.0), Sense::hover());
    ui.painter().circle_filled(rect.center(), 4.0, color);
    ui.painter().circle_stroke(rect.center(), 5.5, Stroke::new(1.0_f32, color.linear_multiply(0.35)));
}

fn tag(ui: &mut egui::Ui, text: &str, color: Color32) {
    let frame = egui::Frame::none().fill(color.linear_multiply(0.18)).stroke(Stroke::new(1.0_f32, color.linear_multiply(0.6))).rounding(Rounding::same(6.0)).inner_margin(Margin::symmetric(7.0, 2.0));
    frame.show(ui, |ui| { ui.label(RichText::new(text).small().color(color)); });
}

/// One line of text that never overflows `max_w`: laid out as a galley with an
/// ellipsis at the cut, so it is exact for any font (the old character-count
/// estimate left long file and tool names running under the size column).
fn paint_text_fit(p: &egui::Painter, pos: egui::Pos2, align: egui::Align2, text: &str, font: FontId, color: Color32, max_w: f32) {
    let mut job = egui::text::LayoutJob::simple_singleline(text.to_string(), font, color);
    job.wrap = egui::text::TextWrapping::truncate_at_width(max_w.max(12.0));
    let galley = p.layout_job(job);
    let rect = align.anchor_size(pos, galley.size());
    p.galley(rect.min, galley, color);
}

/// Clickable list row with hover/selection background; the closure paints the content.
fn list_row(ui: &mut egui::Ui, t: Theme, selected: bool, height: f32, paint: impl FnOnce(&egui::Painter, egui::Rect)) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), height), Sense::click());
    let fill = if selected { t.accent.linear_multiply(0.16) } else if resp.hovered() { t.panel2 } else { Color32::TRANSPARENT };
    ui.painter().rect_filled(rect, Rounding::same(8.0), fill);
    if selected {
        let bar = egui::Rect::from_min_size(rect.min + Vec2::new(0.0, 6.0), Vec2::new(3.0, rect.height() - 12.0));
        ui.painter().rect_filled(bar, Rounding::same(2.0), t.accent);
    }
    if resp.hovered() { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
    paint(ui.painter(), rect);
    resp
}

/// Two-line tool row: name + engine dot, then a one-line description.
fn tool_row(ui: &mut egui::Ui, t: Theme, tool: &ToolInfo, selected: bool) -> egui::Response {
    let name = tool.name.clone();
    let desc = tool.description.replace('\n', " ");
    let params = tool.params.len();
    let engine_color = if tool.engine == "roblox" { t.accent } else { t.info };
    list_row(ui, t, selected, 44.0, |p, r| {
        p.circle_filled(r.left_center() + Vec2::new(14.0, 0.0), 3.5, engine_color);
        let max_w = r.width() - 40.0;
        paint_text_fit(p, r.left_top() + Vec2::new(28.0, 7.0), egui::Align2::LEFT_TOP, &name, FontId::monospace(13.0), if selected { t.accent } else { t.text }, max_w);
        let line = if desc.trim().is_empty() { format!("{params} parameter(s)") } else { desc.clone() };
        paint_text_fit(p, r.left_bottom() + Vec2::new(28.0, -7.0), egui::Align2::LEFT_BOTTOM, line.trim(), FontId::proportional(11.5), t.muted, max_w);
    })
}

/// 0..1 breathing value (1.6 s period). Keeps the UI repainting while on.
fn pulse(ctx: &egui::Context, on: bool) -> f32 {
    if !on { return 0.0; }
    let time = ctx.input(|i| i.time) as f32;
    ctx.request_repaint_after(Duration::from_millis(40));
    0.5 + 0.5 * (time * std::f32::consts::TAU / 1.6).sin()
}

/// Button family (2.10.0). One height (32 px, 28 px for ghost), one radius
/// (`Theme::r_btn`, follows Settings → Corners), one hover/pressed language:
/// * Primary   — filled accent, for the one action a card is about.
/// * Secondary — raised surface with a border, the default.
/// * Ghost     — transparent until hovered; inline / toolbar actions.
/// * Danger    — red text on a faint red surface; destructive actions.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Btn { Primary, Secondary, Ghost, Danger }

fn button_widget(t: Theme, text: &str, kind: Btn) -> egui::Button<'static> {
    let b = match kind {
        Btn::Primary => egui::Button::new(RichText::new(text).strong().color(t.accent_ink)).fill(t.accent).stroke(Stroke::new(1.0_f32, t.accent2)),
        Btn::Secondary => egui::Button::new(RichText::new(text).color(t.text)).fill(t.panel2).stroke(Stroke::new(1.0_f32, t.border2)),
        Btn::Ghost => egui::Button::new(RichText::new(text).small().color(t.text)).fill(Color32::TRANSPARENT).stroke(Stroke::new(1.0_f32, alpha(t.border2, 110))),
        Btn::Danger => egui::Button::new(RichText::new(text).strong().color(t.bad)).fill(alpha(t.bad, if t.light { 18 } else { 28 })).stroke(Stroke::new(1.0_f32, alpha(t.bad, 140))),
    };
    let h = if kind == Btn::Ghost { 28.0 } else { 32.0 };
    // A button label never wraps: in a wrapping row the whole button moves to
    // the next line instead (the donation pills used to break mid-word).
    b.wrap_mode(egui::TextWrapMode::Extend).rounding(Rounding::same(t.r_btn)).min_size(Vec2::new(0.0, h))
}

/// Pointer cursor + a soft outline that fades in on hover (and a wider accent
/// glow for primary buttons). Painted under the button, so the label never
/// moves or changes colour.
fn button(ui: &mut egui::Ui, t: Theme, text: &str, kind: Btn) -> egui::Response {
    let resp = ui.add(button_widget(t, text, kind));
    if resp.hovered() && resp.enabled() { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
    let k = ui.ctx().animate_bool_with_time(resp.id.with("glow"), resp.hovered() && resp.enabled(), 0.15);
    if k > 0.0 {
        let c = match kind { Btn::Primary => t.accent, Btn::Danger => t.bad, _ => t.border2 };
        let r = Rounding::same(t.r_btn + 2.0);
        ui.painter().rect_stroke(resp.rect.expand(2.0), r, Stroke::new(2.0_f32, alpha(c, (70.0 * k) as u8)));
        if kind == Btn::Primary { ui.painter().rect_stroke(resp.rect.expand(5.0), Rounding::same(t.r_btn + 5.0), Stroke::new(3.0_f32, alpha(c, (28.0 * k) as u8))); }
    }
    if resp.has_focus() {
        ui.painter().rect_stroke(resp.rect.expand(1.5), Rounding::same(t.r_btn + 1.5), Stroke::new(1.5_f32, t.accent));
    }
    resp
}

fn pill_widget(t: Theme, text: &str, primary: bool) -> egui::Button<'static> {
    button_widget(t, text, if primary { Btn::Primary } else { Btn::Secondary })
}

/// Primary (filled) or secondary (outlined) button — see `button`.
fn pill(ui: &mut egui::Ui, t: Theme, text: &str, primary: bool) -> egui::Response {
    button(ui, t, text, if primary { Btn::Primary } else { Btn::Secondary })
}

/// Quiet inline action (toolbar "Clear", "Copy", "Dismiss").
fn ghost(ui: &mut egui::Ui, t: Theme, text: &str) -> egui::Response { button(ui, t, text, Btn::Ghost) }

/// Destructive action (delete, kill, quit).
fn danger(ui: &mut egui::Ui, t: Theme, text: &str) -> egui::Response { button(ui, t, text, Btn::Danger) }

#[derive(Clone, Copy)]
enum WinGlyph { Minimize, Maximize, Close }

fn window_button(ui: &mut egui::Ui, glyph: WinGlyph, color: Color32, t: Theme) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(34.0, 26.0), Sense::click());
    if resp.hovered() {
        ui.painter().rect_filled(rect, Rounding::same(6.0), t.panel2);
        ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand);
    }
    let c = rect.center();
    let stroke = Stroke::new(1.4_f32, if resp.hovered() { color } else { t.muted });
    let r = 4.5;
    match glyph {
        WinGlyph::Minimize => { ui.painter().line_segment([egui::pos2(c.x - r, c.y), egui::pos2(c.x + r, c.y)], stroke); }
        WinGlyph::Maximize => { ui.painter().rect_stroke(egui::Rect::from_center_size(c, Vec2::splat(r * 2.0)), Rounding::same(1.5), stroke); }
        WinGlyph::Close => {
            ui.painter().line_segment([egui::pos2(c.x - r, c.y - r), egui::pos2(c.x + r, c.y + r)], stroke);
            ui.painter().line_segment([egui::pos2(c.x - r, c.y + r), egui::pos2(c.x + r, c.y - r)], stroke);
        }
    }
    resp
}

fn row_status(ui: &mut egui::Ui, t: Theme, label: &str, on: bool) {
    ui.horizontal(|ui| {
        status_dot(ui, if on { t.ok } else { t.muted });
        ui.label(RichText::new(label).small().color(if on { t.text } else { t.muted }));
    });
}

/// Donation buttons: "SmallDono · R$ 10" … each opens its game pass in the browser.
fn donation_row(ui: &mut egui::Ui, t: Theme) {
    ui.horizontal_wrapped(|ui| {
        for (name, robux, url) in DONATION_PASSES {
            if pill(ui, t, &format!("{name} · R$ {robux}"), false).on_hover_text(url).clicked() { open_external(url); }
        }
    });
}

fn settings_section(ui: &mut egui::Ui, t: Theme, title: &str, add: impl FnOnce(&mut egui::Ui)) {
    let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card + 2.0)).inner_margin(Margin::same(16.0));
    frame.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.label(RichText::new(title).size(16.0).strong().color(t.text));
        ui.add_space(6.0);
        add(ui);
    });
    ui.add_space(12.0);
}

/// Numbered section card — "04  Your layout" with a muted subtitle and a
/// hairline under the heading (the Settings look from the reference).
fn section_card(ui: &mut egui::Ui, t: Theme, index: &str, title: &str, subtitle: &str, add: impl FnOnce(&mut egui::Ui)) {
    let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_card + 4.0)).inner_margin(Margin::same(18.0));
    frame.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            ui.label(RichText::new(index).size(13.0).strong().monospace().color(t.accent));
            ui.label(RichText::new(title).size(18.0).strong().color(t.text));
        });
        if !subtitle.is_empty() { ui.label(RichText::new(subtitle).color(t.muted)); }
        ui.add_space(8.0);
        let (line, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 1.0), Sense::hover());
        ui.painter().rect_filled(line, Rounding::ZERO, t.border);
        ui.add_space(12.0);
        add(ui);
    });
    ui.add_space(14.0);
}

/// Card width so that as many `min_w` cards as fit share the row exactly.
fn grid_width(avail: f32, min_w: f32, gap: f32) -> f32 {
    let cols = ((avail + gap) / (min_w + gap)).floor().max(1.0);
    ((avail - gap * (cols - 1.0)) / cols).floor().max(min_w.min(avail))
}

/// Shared picker-card chrome: fill, animated border, hover lift. Returns hover 0..1.
fn card_chrome(ui: &mut egui::Ui, t: Theme, rect: egui::Rect, resp: &egui::Response, selected: bool, rounding: f32, motion: bool) -> f32 {
    if resp.hovered() { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
    let hover = ui.ctx().animate_bool_with_time(resp.id.with("h"), resp.hovered(), if motion { 0.12 } else { 0.0 });
    let p = ui.painter();
    if hover > 0.0 { p.rect_filled(rect.translate(Vec2::new(0.0, 3.0)), Rounding::same(rounding), alpha(Color32::BLACK, (if t.light { 18.0 } else { 60.0 } * hover) as u8)); }
    p.rect_filled(rect, Rounding::same(rounding), if selected { mix(t.panel2, t.accent, 0.06) } else { mix(t.bg2, t.panel2, hover) });
    let border = if selected { t.accent } else { mix(t.border, t.border2, hover) };
    p.rect_stroke(rect, Rounding::same(rounding), Stroke::new(if selected { 1.5_f32 } else { 1.0_f32 }, border));
    hover
}

/// Small option card (corner style and friends): name + blurb + check box.
fn choice_card(ui: &mut egui::Ui, t: Theme, name: &str, blurb: &str, selected: bool, width: f32, motion: bool, preview_corners: u8) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 62.0), Sense::click());
    card_chrome(ui, t, rect, &resp, selected, corner(preview_corners, 12.0), motion);
    let p = ui.painter();
    // preview: a tiny button with the corner style it stands for
    let demo = egui::Rect::from_min_size(rect.min + Vec2::new(12.0, 14.0), Vec2::new(34.0, 34.0));
    p.rect_filled(demo, Rounding::same(corner(preview_corners, 9.0)), alpha(t.accent, 60));
    p.rect_stroke(demo, Rounding::same(corner(preview_corners, 9.0)), Stroke::new(1.0_f32, t.accent));
    p.text(rect.min + Vec2::new(56.0, 22.0), egui::Align2::LEFT_CENTER, name, FontId::new(13.5, FontFamily::Proportional), t.text);
    p.text(rect.min + Vec2::new(56.0, 40.0), egui::Align2::LEFT_CENTER, blurb, FontId::new(10.5, FontFamily::Proportional), t.muted);
    check_box(p, rect.right_top() + Vec2::new(-20.0, 22.0), selected, t);
    resp
}

/// Density picker card with a tiny painted window preview.
fn layout_card(ui: &mut egui::Ui, t: Theme, name: &str, blurb: &str, compact: bool, selected: bool, width: f32, motion: bool, corners: u8) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 118.0), Sense::click());
    card_chrome(ui, t, rect, &resp, selected, corner(corners, 14.0), motion);
    let p = ui.painter();
    // mini window preview
    let prev = egui::Rect::from_min_size(rect.min + Vec2::new(14.0, 14.0), Vec2::new(rect.width() - 28.0, 58.0));
    p.rect_filled(prev, Rounding::same(6.0), t.bg);
    p.rect_stroke(prev, Rounding::same(6.0), Stroke::new(1.0_f32, t.border));
    let side = egui::Rect::from_min_size(prev.min, Vec2::new(prev.width() * 0.28, prev.height()));
    p.rect_filled(side, Rounding { nw: 6.0, sw: 6.0, ne: 0.0, se: 0.0 }, t.panel);
    let rows = if compact { 5 } else { 3 };
    let gap = (prev.height() - 12.0) / rows as f32;
    for i in 0..rows {
        let y = prev.top() + 6.0 + i as f32 * gap;
        let h = if compact { 4.0 } else { 7.0 };
        p.rect_filled(egui::Rect::from_min_size(Pos2::new(side.left() + 5.0, y), Vec2::new(side.width() - 10.0, h)), Rounding::same(2.0), if i == 0 { t.accent } else { t.border2 });
        p.rect_filled(egui::Rect::from_min_size(Pos2::new(side.right() + 8.0, y), Vec2::new(prev.width() * 0.5, h)), Rounding::same(2.0), t.panel2);
    }
    p.text(rect.min + Vec2::new(14.0, 84.0), egui::Align2::LEFT_CENTER, name, FontId::new(14.0, FontFamily::Proportional), t.text);
    p.text(rect.min + Vec2::new(14.0, 101.0), egui::Align2::LEFT_CENTER, blurb, FontId::new(11.0, FontFamily::Proportional), t.muted);
    check_box(p, rect.right_top() + Vec2::new(-26.0, 84.0), selected, t);
    resp
}

/// Palette card: swatch thumbnail, name, blurb and a check box.
fn palette_card(ui: &mut egui::Ui, t: Theme, pal: &Palette, selected: bool, width: f32, motion: bool) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 70.0), Sense::click());
    card_chrome(ui, t, rect, &resp, selected, 12.0, motion);
    let p = ui.painter();
    // thumbnail: the palette's own bg / panel / accent
    let th = egui::Rect::from_min_size(rect.min + Vec2::new(10.0, 10.0), Vec2::new(50.0, 50.0));
    let pt = Theme::by_id(pal.id);
    p.rect_filled(th, Rounding::same(9.0), pt.bg);
    p.rect_stroke(th, Rounding::same(9.0), Stroke::new(1.0_f32, pt.border2));
    p.rect_filled(egui::Rect::from_min_size(th.min + Vec2::new(7.0, 7.0), Vec2::new(14.0, 36.0)), Rounding::same(3.0), pt.panel2);
    p.rect_filled(egui::Rect::from_min_size(th.min + Vec2::new(25.0, 7.0), Vec2::new(18.0, 5.0)), Rounding::same(2.0), pt.accent);
    p.rect_filled(egui::Rect::from_min_size(th.min + Vec2::new(25.0, 16.0), Vec2::new(18.0, 4.0)), Rounding::same(2.0), pt.border2);
    p.rect_filled(egui::Rect::from_min_size(th.min + Vec2::new(25.0, 24.0), Vec2::new(12.0, 4.0)), Rounding::same(2.0), pt.border2);
    p.circle_filled(th.min + Vec2::new(29.0, 39.0), 3.0, pt.accent2);
    p.circle_filled(th.min + Vec2::new(38.0, 39.0), 3.0, pt.ok);
    let name_col = if selected { t.text } else { mix(t.text, t.muted, 0.2) };
    p.text(rect.min + Vec2::new(70.0, 24.0), egui::Align2::LEFT_CENTER, pal.name, FontId::new(13.5, FontFamily::Proportional), name_col);
    let blurb_font = FontId::new(10.5, FontFamily::Proportional);
    let galley = p.layout(pal.blurb.to_string(), blurb_font, t.muted, (width - 110.0).max(60.0));
    p.galley(rect.min + Vec2::new(70.0, 34.0), galley, t.muted);
    check_box(p, rect.right_top() + Vec2::new(-22.0, 24.0), selected, t);
    resp
}

/// 16 px check box glyph used by the picker cards.
fn check_box(p: &egui::Painter, center: Pos2, on: bool, t: Theme) {
    let r = egui::Rect::from_center_size(center, Vec2::splat(16.0));
    if on {
        p.rect_filled(r, Rounding::same(4.0), t.accent);
        p.line_segment([center + Vec2::new(-4.0, 0.0), center + Vec2::new(-1.0, 3.0)], Stroke::new(2.0_f32, t.accent_ink));
        p.line_segment([center + Vec2::new(-1.0, 3.0), center + Vec2::new(4.5, -3.5)], Stroke::new(2.0_f32, t.accent_ink));
    } else {
        p.rect_stroke(r, Rounding::same(4.0), Stroke::new(1.2_f32, t.border2));
    }
}

/// Small uppercase outlined chip with a square status dot — "■ BRIDGE ONLINE".
fn status_chip(ui: &mut egui::Ui, t: Theme, text: &str, color: Color32, live: bool) -> egui::Response {
    let font = FontId::new(10.5, FontFamily::Proportional);
    let galley = ui.painter().layout_no_wrap(text.to_string(), font.clone(), color);
    let size = Vec2::new(galley.size().x + 30.0, 26.0);
    let (rect, resp) = ui.allocate_exact_size(size, Sense::hover());
    let k = if live { pulse(ui.ctx(), true) } else { 0.0 };
    let painter = ui.painter();
    painter.rect_filled(rect, Rounding::same(t.r_chip), alpha(color, if t.light { 18 } else { 26 }));
    painter.rect_stroke(rect, Rounding::same(t.r_chip), Stroke::new(1.0_f32, alpha(color, 150)));
    let dot = egui::Rect::from_center_size(rect.left_center() + Vec2::new(12.0, 0.0), Vec2::splat(6.0));
    painter.rect_filled(dot, Rounding::same(1.5), color);
    if live { painter.rect_stroke(dot.expand(1.5 + 3.0 * k), Rounding::same(3.0), Stroke::new(1.0_f32, alpha(color, (120.0 * (1.0 - k)) as u8))); }
    painter.text(rect.left_center() + Vec2::new(21.0, 0.0), egui::Align2::LEFT_CENTER, text, font, color);
    resp
}

/// Sidebar / card section label: accent dash + spaced uppercase caption.
fn section_label(ui: &mut egui::Ui, t: Theme, text: &str) {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        let (bar, _) = ui.allocate_exact_size(Vec2::new(10.0, 2.0), Sense::hover());
        ui.painter().rect_filled(bar, Rounding::same(1.0), t.accent);
        ui.label(RichText::new(text).size(10.5).strong().color(t.muted));
    });
}

/// Faint geometric backdrop behind every page (soft accent glow in the top
/// right, a few thin diagonal lines and dots). Painted below the content, so
/// it never competes with it; alpha stays low on light palettes too.
fn paint_backdrop(painter: &egui::Painter, rect: egui::Rect, t: Theme, time: f32) {
    let a = if t.light { 10 } else { 16 };
    let tr = rect.right_top();
    // Glows breathe very slowly (40 s) and the dots drift — `time` is 0 with motion off.
    let breathe = 0.5 + 0.5 * (time * std::f32::consts::TAU / 40.0).sin();
    painter.circle_filled(tr + Vec2::new(-80.0, 40.0), 190.0 + 16.0 * breathe, alpha(t.accent, a / 2));
    painter.circle_filled(tr + Vec2::new(-80.0, 40.0), 110.0, alpha(t.accent, a));
    painter.circle_filled(rect.left_bottom() + Vec2::new(120.0, -60.0), 140.0 + 12.0 * (1.0 - breathe), alpha(t.accent2, a / 2));
    let line = Stroke::new(1.0_f32, alpha(t.border2, if t.light { 60 } else { 90 }));
    for i in 0..5 {
        let x = tr.x - 60.0 - i as f32 * 42.0;
        painter.line_segment([Pos2::new(x, rect.top()), Pos2::new(x - 180.0, rect.top() + 180.0)], line);
    }
    let dots = alpha(t.accent, if t.light { 50 } else { 70 });
    for i in 0..6 {
        let phase = i as f32 * 1.7;
        let drift = Vec2::new((time * 0.21 + phase).sin() * 9.0, (time * 0.17 + phase * 0.6).cos() * 7.0);
        let p = Pos2::new(tr.x - 40.0 - i as f32 * 61.0, rect.top() + 24.0 + ((i * 37) % 90) as f32) + drift;
        painter.circle_filled(p, 1.6 + 0.6 * ((time * 0.5 + phase).sin() * 0.5 + 0.5), dots);
    }
    let ring = tr + Vec2::new(-150.0, 120.0);
    painter.circle_stroke(ring, 52.0 + 3.0 * breathe, Stroke::new(1.0_f32, alpha(t.accent, a + 10)));
    painter.circle_stroke(ring, 36.0 - 2.0 * breathe, Stroke::new(1.0_f32, alpha(t.accent, a + 4)));
    // Sweep: a tiny bright dot travelling the outer ring every 12 s.
    if time > 0.0 {
        let ang = time * std::f32::consts::TAU / 12.0;
        painter.circle_filled(ring + Vec2::new(ang.cos(), ang.sin()) * (52.0 + 3.0 * breathe), 2.2, alpha(t.accent, 120));
    }
}

/// Simple vector icons for the navigation (no emoji fonts needed).
fn nav_icon(p: &egui::Painter, r: egui::Rect, page: Page, c: Color32) {
    let s = Stroke::new(1.6_f32, c);
    let (l, top, w, h) = (r.left(), r.top(), r.width(), r.height());
    let pt = |x: f32, y: f32| egui::pos2(l + x * w, top + y * h);
    match page {
        Page::Home => {
            p.line_segment([pt(0.1, 0.5), pt(0.5, 0.12)], s);
            p.line_segment([pt(0.5, 0.12), pt(0.9, 0.5)], s);
            p.rect_stroke(egui::Rect::from_min_max(pt(0.22, 0.48), pt(0.78, 0.92)), Rounding::same(1.5), s);
        }
        Page::Chat => {
            // speech bubble with a tail and three dots
            p.rect_stroke(egui::Rect::from_min_max(pt(0.08, 0.14), pt(0.92, 0.7)), Rounding::same(4.0), s);
            p.line_segment([pt(0.3, 0.7), pt(0.22, 0.92)], s);
            p.line_segment([pt(0.22, 0.92), pt(0.48, 0.7)], s);
            for x in [0.32, 0.5, 0.68] { p.circle_filled(pt(x, 0.42), 1.3, c); }
        }
        Page::Explorer => {
            p.rect_stroke(egui::Rect::from_min_max(pt(0.08, 0.25), pt(0.92, 0.88)), Rounding::same(2.0), s);
            p.line_segment([pt(0.08, 0.25), pt(0.4, 0.12)], s);
            p.line_segment([pt(0.4, 0.12), pt(0.5, 0.25)], s);
        }
        Page::Servers => {
            p.rect_stroke(egui::Rect::from_min_max(pt(0.1, 0.12), pt(0.9, 0.45)), Rounding::same(2.0), s);
            p.rect_stroke(egui::Rect::from_min_max(pt(0.1, 0.55), pt(0.9, 0.88)), Rounding::same(2.0), s);
            p.circle_filled(pt(0.25, 0.28), 1.6, c);
            p.circle_filled(pt(0.25, 0.71), 1.6, c);
        }
        Page::Terminal => {
            p.rect_stroke(egui::Rect::from_min_max(pt(0.08, 0.15), pt(0.92, 0.85)), Rounding::same(2.0), s);
            p.line_segment([pt(0.25, 0.4), pt(0.42, 0.52)], s);
            p.line_segment([pt(0.42, 0.52), pt(0.25, 0.64)], s);
            p.line_segment([pt(0.5, 0.66), pt(0.75, 0.66)], s);
        }
        Page::Activity => {
            for y in [0.24, 0.5, 0.76] {
                p.circle_filled(pt(0.16, y), 1.6, c);
                p.line_segment([pt(0.32, y), pt(0.9, y)], s);
            }
        }
        Page::Diagnostics => {
            p.add(egui::Shape::line(vec![pt(0.06, 0.55), pt(0.3, 0.55), pt(0.4, 0.22), pt(0.54, 0.84), pt(0.64, 0.55), pt(0.94, 0.55)], s));
        }
        Page::Help => {
            // circle with a question mark
            p.circle_stroke(pt(0.5, 0.5), w * 0.42, s);
            p.text(pt(0.5, 0.53), egui::Align2::CENTER_CENTER, "?", FontId::new(h * 0.66, FontFamily::Proportional), c);
        }
        Page::Settings => {
            p.circle_stroke(pt(0.5, 0.5), w * 0.36, Stroke::new(2.2_f32, c));
            p.circle_stroke(pt(0.5, 0.5), w * 0.13, s);
        }
    }
}


// ───────────────────────────── help ─────────────────────────────

/// One entry of the in-app Help page (Page::Help, F1). Plain text only — no
/// markdown — so it renders the same in every theme and can be searched.
struct HelpTopic { title: &'static str, page: Option<Page>, summary: &'static str, steps: &'static [&'static str] }

const HELP_TOPICS: &[HelpTopic] = &[
    HelpTopic {
        title: "Start here: what this app is",
        page: Some(Page::Home),
        summary: "TotalScript Desktop is the bridge between the TotalScript browser extension (the AI site you chat on) and your PC: Roblox Studio through the Studio MCP helper, and a local project folder (the AgentScript workspace). The AI never touches your PC directly — every action goes through this app, on localhost only (HTTP 127.0.0.1:3000, extension channels 17613 / 17615).",
        steps: &[
            "1. Leave this app running. Closing the window keeps the bridge alive in the background (Settings → Behaviour decides whether it hides to the notification area).",
            "2. Open Roblox Studio → Assistant → … → Manage MCP Servers → turn on 'Studio as MCP server'.",
            "3. Open a place (File → New → Baseplate is enough).",
            "4. In the browser, press ▶ Start Agent on the TotalScript bar. Home ticks each of these steps off live.",
            "Then just describe what you want in the chat ('build a lobby', 'fix the error in Output'). The AI reads the place first, builds, playtests and screenshots to verify.",
        ],
    },
    HelpTopic {
        title: "Home",
        page: Some(Page::Home),
        summary: "The status board: bridge, extension connection, Studio MCP helper, Studio process and place link, each with a green / grey dot and a one-line hint about what is missing.",
        steps: &[
            "Setup checklist: the four start-up steps with live ticks. a 'Hide' button appears once everything is green; Settings → Behaviour → 'Always show the setup checklist' brings it back.",
            "Restart Studio MCP (Ctrl+R) restarts the helper that talks to Studio; Probe Studio (F5) re-checks the place link.",
            "Capture Studio viewport (Ctrl+Shift+S) grabs a screenshot through the helper and shows it here — the same picture the AI sees when it verifies its work.",
            "Copy diagnostics copies a plain-text report (versions, ports, helper state, tool count) you can paste into a bug report. It contains no keys and no chat text.",
            "Copy session report copies what ran since the app started: every tool with calls / ok / failed / average and slowest time, where the calls came from (chat, toolkit, terminal, extension), deprecated-API warnings and the last errors. Names and numbers only — no arguments, results or chat text.",
            "Quick access cards jump to the other pages.",
        ],
    },
    HelpTopic {
        title: "AI Chat",
        page: Some(Page::Chat),
        summary: "Chat with a model on your own API key, without a browser tab. The model drives Studio and the workspace through the same tools the extension uses, and every tool call shows up as a card with its arguments, result and elapsed time.",
        steps: &[
            "Set a provider and key in Settings → AI chat (side panel): CodeCraft, OpenAI, OpenRouter, Groq, DeepSeek, Gemini, xAI, Mistral, Together, a local Ollama / LM Studio or any OpenAI-compatible endpoint.",
            "Keys and the chosen model are stored in plain text in the settings file on this PC only; they are never sent anywhere except the provider you picked.",
            "Ctrl+J toggles the chat as a side panel so it stays open while you use Explorer, MCP Servers or Terminal.",
            "Roblox tools need the Studio MCP helper and a linked place; workspace tools work as soon as the bridge is up.",
            "Tool cards expand to show the full JSON result and any screenshot the tool returned. 'copy' on a message copies its text.",
            "Pair (header pill): pair mode. You build by hand in Studio; the TotalScript plugin reports your selection, script edits (after a two-second typing pause), new or removed instances and property changes to the app. Each edited script is checked for deprecated APIs and WaitForChild / FindFirstChild names that do not exist, and the model sees the new events plus open findings at the start of every turn — it is told to comment only on concrete findings and never to redo your work. 'Ask AI to review' sends the findings as a message. Changes made by TotalScript itself are filtered out. Off by default; the switch is remembered.",
        ],
    },
    HelpTopic {
        title: "Explorer",
        page: Some(Page::Explorer),
        summary: "A file browser for the AgentScript workspace — the folder the AI is allowed to read and write when it works outside Studio.",
        steps: &[
            "Click a folder to enter it, a file to open it. Text files up to 2 MB open inline; Ctrl+S saves. Binary files have no preview.",
            "The path box jumps to any folder inside the workspace; 'new name…' creates a file or folder.",
            "Delete is armed on the first click and performed on the second, within three seconds. Esc disarms.",
            "F5 refreshes the listing after the AI or another program changed files.",
            "Change the workspace folder in Settings → Workspace. --workspace on the command line and TOTAL_WORKSPACE_ROOT in the environment still win when given.",
        ],
    },
    HelpTopic {
        title: "MCP Servers",
        page: Some(Page::Servers),
        summary: "The three things this bridge talks to: the Roblox Studio MCP helper (stdio JSON-RPC), the local filesystem engine (AgentScript) and the extension channels.",
        steps: &[
            "Studio card: helper process, Studio process, place link, tool count and the launcher command. Restart helper (Ctrl+R) and Probe (F5) are here too.",
            "Kill Roblox Studio ends every RobloxStudio process — it is a two-click confirm, use it only when Studio is stuck.",
            "Launcher: by default the helper is Roblox's own Studio MCP launcher (mcp.bat under %LOCALAPPDATA%\\Roblox on Windows); 'Change launcher…' in Settings → Roblox Studio MCP accepts any command that speaks MCP over stdio. TOTAL_MCP_COMMAND in the environment takes precedence at start.",
            "FULL PC ACCESS: when off (default) the workspace engine stays inside the workspace folder. When on, absolute paths, process_kill and cd anywhere are allowed — applies immediately and on the next start. Leave it off while learning.",
            "Extension channels: the HTTP endpoint and the two WebSocket channels (17613 roblox, 17615 local) with how many extension tabs are connected; Open status JSON and Copy endpoints are for debugging.",
        ],
    },
    HelpTopic {
        title: "Terminal",
        page: Some(Page::Terminal),
        summary: "The bridge console plus two runners: shell commands inside the workspace and Luau inside Roblox Studio.",
        steps: &[
            "Console: every bridge event (extension connected, helper started, tool calls, errors) in order. Use it to see what the AI actually did.",
            "Workspace command: runs a shell command with the workspace as the current directory, under the same access rules as the AI (Sandbox unless FULL PC ACCESS is on).",
            "Luau in Studio: runs the code in the linked place through the helper and prints the result — Ctrl+Enter runs. It needs a linked place; the dot next to the mode tells you.",
        ],
    },
    HelpTopic {
        title: "Settings",
        page: Some(Page::Settings),
        summary: "Everything that is remembered between starts. Each change saves on its own; nothing is sent anywhere.",
        steps: &[
            "Your layout: Comfortable or Compact density cards, Sharp / Soft / Round corners, UI size 90–125 %, icon-rail and two-line sidebar switches. Appearance: 16 palettes (TotalScript Aqua by default, Gold, Emerald, Graphite, Midnight, Nord, Violet, Rosé, Crimson, Sunset, Ocean, Mocha, Forest, and the light Paper, Snow and Sage) with a search box, a custom accent colour (picker, hex or six quick swatches) and Motion / Backdrop / Glow effect switches; every change applies instantly.",
            "Behaviour: keep running in the notification area when the window is closed, start hidden, always show the checklist, launch at sign-in (hidden).",
            "Workspace: the folder the AI may use outside Studio, and the FULL PC ACCESS switch.",
            "Reference library (optional, same card): a folder of Markdown notes — for example LihFolk Vault V2 (notes CC BY 4.0, download it yourself) or your own — that the AI searches with reference_search before stating a limit, default or API change. Off until you set it; nothing is bundled.",
            "Roblox Studio MCP: the launcher command for the helper.",
            "AI chat (side panel): provider, API key, model and base URL for the in-app chat.",
            "Donate: Robux game passes, if TotalScript saves you time. About: version, rebuild command, keyboard list, repository link. Diagnostics: live status grid and 'Copy diagnostics'.",
        ],
    },
    HelpTopic {
        title: "Studio will not link — fix it in order",
        page: Some(Page::Servers),
        summary: "Work from the top down; each line is one red / grey hint on Home or MCP Servers and what clears it.",
        steps: &[
            "'Start Roblox Studio to link' — Studio is not running. Start it and open a place.",
            "'Helper not running' — press Restart Studio MCP (Ctrl+R). If it dies again, check the launcher in Settings → Roblox Studio MCP (Roblox installs mcp.bat with Studio; the field's placeholder shows the expected path) and read the console on the Terminal page for the error.",
            "'Enable Studio as MCP server, then probe' — in Studio: Assistant → … → Manage MCP Servers → turn on 'Studio as MCP server'. Then Probe (F5). Accept Studio's permission prompt if it shows one.",
            "'not linked' with Studio running and the switch on — make sure a place is open (not just the Studio start page), then Probe again.",
            "Extension says 'Agent app offline' — this app is not running, or another copy is holding port 3000. Only one bridge can run at a time; the app raises the existing window instead of starting twice.",
            "Still stuck: Copy diagnostics on Home and share it together with the last console lines.",
        ],
    },
    HelpTopic {
        title: "Access, safety and what stays on this PC",
        page: Some(Page::Settings),
        summary: "The bridge is local only; the model you chat with gets tool results, not your files, unless a tool returns them.",
        steps: &[
            "Listens on 127.0.0.1 only — other machines cannot reach the bridge.",
            "Sandbox (default): the workspace engine is confined to the workspace folder; Studio tools act on the open place only.",
            "FULL PC ACCESS (MCP Servers / Settings → Workspace) removes the folder limit and enables process control. The extension's Access switch (Sandbox only / Full PC) is the same state: Full PC there turns this on; Sandbox only refuses PC commands before they reach the bridge.",
            "API keys for the in-app chat live in the settings file in plain text — treat that file like a password.",
            "Diagnostics never include keys or chat text. Nothing in this app phones home.",
        ],
    },
    HelpTopic {
        title: "Blender, Studio plugin and the browser extension",
        page: None,
        summary: "This app is one of three parts. The browser extension (TotalScript bar on the AI site) owns work modes, skills, Blender and the Studio plugin link; the Studio plugin (plugin/TotalScript.lua) handles animation, GUI and screenshot work inside Studio; this app is the bridge and the local engine.",
        steps: &[
            "Blender connects through the extension, not this app: press Start MCP Server in Blender (N panel → MCP for Blender), then Settings → MCP servers → Connect Blender on the TotalScript bar. The Blender work mode makes the AI plan, build, validate, render and send assets to Studio from there.",
            "Work modes (Totality, Blender, Animator), skills, templates, prompt enhancer, Paint and Video are in the extension's Settings and bar — this app does not change them.",
            "The Studio plugin: this app copies plugin/TotalScript.lua into Studio's local Plugins folder; restart Studio once, open Plugins → TotalScript and click Allow on the HTTP prompt. The plugin then long-polls this bridge for jobs.",
        ],
    },
    HelpTopic {
        title: "Activity: what is running, the feed and session numbers",
        page: Some(Page::Activity),
        summary: "One page for everything that happened this run. Nothing here is stored on disk; quitting clears it.",
        steps: &[
            "Running now — the chat turn (Stop is real: it cancels after the current step), terminal commands, Luau runs and captures. Tool calls already handed to an engine run to completion, so they show 'not cancellable' instead of a fake Stop.",
            "Feed — the same lines Home shows, with filters (Tools, Studio, Bridge, Chat, Pair, Errors) and a search box. Newest first, last 120 kept.",
            "This session — per-tool ok / fail / average / max milliseconds, call sources, Luau warnings and the last errors. Copy session report on Home prints the same numbers as text.",
            "The status bar's 'N running' link and the Details button on Home's session card both land here.",
        ],
    },
    HelpTopic {
        title: "Diagnostics: live checks with a fix on each problem",
        page: Some(Page::Diagnostics),
        summary: "Every row is read from the bridge state each frame — there is no cached 'all good'. Red rows carry the button that fixes them where one exists.",
        steps: &[
            "Checks: bridge ports, extension channels, Studio process, MCP helper, place link, Studio plugin, workspace folder (exists / writable), reference library, chat provider, settings and log files, tool errors this session.",
            "Fix buttons reuse the normal actions: Restart helper, Probe Studio, open the right Settings category, open a file.",
            "Copy report — the check list plus the diagnostics text and the last 40 console lines. No API keys, no chat text.",
            "The Bridge card on Home and the status bar's bridge item open this page.",
        ],
    },
    HelpTopic {
        title: "Notifications and the command palette",
        page: None,
        summary: "Two things that work on every page: the bell (top right, Ctrl+Shift+N) collects every event and action result; Ctrl+K opens a palette with every page, setting category and action.",
        steps: &[
            "A new notice pops up bottom-right for about three seconds and stays in the bell list (last 100, this run only) until you dismiss or clear it. The badge counts unread.",
            "Palette: start typing — matching is fuzzy, so 'resmcp' finds Restart Studio MCP helper. Recent commands are listed first when the box is empty.",
            "Destructive commands (kill Studio, quit, forget keys, clear feeds) turn red after the first Enter and run on the second; Esc or typing cancels.",
            "Settings has its own search box (top of the page) that looks across every category at once.",
        ],
    },
    HelpTopic {
        title: "Keyboard shortcuts",
        page: None,
        summary: "All shortcuts work on every page.",
        steps: &[
            "Ctrl+K (or Ctrl+P) — command palette: type any page, setting or action; Up / Down, Enter; destructive commands ask for Enter twice.",
            "Ctrl+1 … Ctrl+9 — Home, AI Chat, Explorer, MCP Servers, Terminal, Help, Settings, Activity, Diagnostics.   Ctrl+, — Settings.",
            "F1 — this Help page.   Ctrl+J — AI chat side panel.   Ctrl+Shift+N — notification center.",
            "Ctrl+R — restart the Studio MCP helper.   F5 — probe Studio and refresh the Explorer.",
            "Ctrl+Shift+S — capture the Studio viewport.   Ctrl+S — save the open file.   Ctrl+Enter — run Luau in the Terminal.",
            "Esc — close the palette or notifications; otherwise clear the current selection / search / armed delete.",
        ],
    },
    HelpTopic {
        title: "Updating and rebuilding",
        page: Some(Page::Settings),
        summary: "The app is built from source with cargo; the version in Settings → About must match the extension's version for the bridge protocol to be in sync.",
        steps: &[
            "Rebuild: cd TotalScript\\agent && cargo build --release  →  target\\release\\total-core.exe. Copy the exe over bin\\total-core.exe (close the running app first).",
            "Settings → About → Open repository opens the GitHub project with the changelog and the latest zip.",
            "If the extension warns about a version mismatch, rebuild the app from the same zip you installed the extension from.",
        ],
    },
];

// ───────────────────────────── utilities ─────────────────────────────

fn log_level_of(line: &str) -> u8 {
    if line.contains("ERROR") || line.starts_with("FATAL") { 3 }
    else if line.contains(" WARN") { 2 }
    else if line.contains(" INFO") { 1 }
    else { 0 }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max { return text.to_string(); }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{cut}…")
}

fn short_path(path: &str, max: usize) -> String {
    let n = path.chars().count();
    if n <= max { return path.to_string(); }
    let tail: String = path.chars().skip(n - (max.saturating_sub(1))).collect();
    format!("…{tail}")
}

pub fn human_size(bytes: u64) -> String {
    let b = bytes as f64;
    if b < 1024.0 { format!("{bytes} B") }
    else if b < 1024.0 * 1024.0 { format!("{:.1} KB", b / 1024.0) }
    else if b < 1024.0 * 1024.0 * 1024.0 { format!("{:.1} MB", b / 1024.0 / 1024.0) }
    else { format!("{:.2} GB", b / 1024.0 / 1024.0 / 1024.0) }
}

pub fn human_duration(d: Duration) -> String {
    let s = d.as_secs();
    if s < 60 { format!("{s}s") }
    else if s < 3600 { format!("{}m {}s", s / 60, s % 60) }
    else if s < 86_400 { format!("{}h {}m", s / 3600, (s % 3600) / 60) }
    else { format!("{}d {}h", s / 86_400, (s % 86_400) / 3600) }
}

fn log_path() -> PathBuf {
    data_dir().join("logs").join("agent.log")
}

fn mcp_launcher_display() -> String {
    std::env::var("TOTAL_MCP_COMMAND")
        .ok()
        .or_else(|| std::env::var("ROBLOXSCRIPT_MCP_COMMAND").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("{} (Studio built-in)", crate::default_mcp_launcher_hint()))
}

/// Decode a base64 PNG/JPEG payload into RGBA8.
fn decode_image(b64: &str) -> Result<(Vec<u8>, u32, u32), String> {
    use base64::Engine;
    let cleaned: String = b64.trim().split(',').last().unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD.decode(cleaned.as_bytes()).map_err(|e| format!("base64: {e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("decode: {e}"))?.to_rgba8();
    let (w, h) = img.dimensions();
    Ok((img.into_raw(), w, h))
}

/// Native folder picker (Windows: Explorer dialog through PowerShell; else the
/// typed path is returned unchanged). Runs on a helper thread; result arrives
/// through the returned receiver.
fn pick_folder(initial: &str) -> Receiver<Option<String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let initial = initial.to_string();
    std::thread::spawn(move || {
        #[cfg(windows)]
        {
            let script = format!(
                "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose the TotalScript workspace folder'; $d.ShowNewFolderButton = $true; if (Test-Path -LiteralPath '{}') {{ $d.SelectedPath = '{}' }}; if ($d.ShowDialog() -eq 'OK') {{ Write-Output $d.SelectedPath }}",
                initial.replace('\'', "''"), initial.replace('\'', "''")
            );
            let out = std::process::Command::new("powershell")
                .args(["-NoProfile", "-STA", "-Command", &script])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            let picked = out.ok().and_then(|o| {
                let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if text.is_empty() { None } else { Some(text) }
            });
            let _ = tx.send(picked);
        }
        #[cfg(target_os = "macos")]
        {
            let default = if std::path::Path::new(&initial).is_dir() {
                format!(" default location POSIX file \"{}\"", initial.replace('\\', "\\\\").replace('"', "\\\""))
            } else { String::new() };
            let script = format!("POSIX path of (choose folder with prompt \"Choose the TotalScript workspace folder\"{default})");
            let out = std::process::Command::new("osascript").args(["-e", &script]).output();
            let picked = out.ok().and_then(|o| {
                let text = String::from_utf8_lossy(&o.stdout).trim().trim_end_matches('/').to_string();
                if text.is_empty() { None } else { Some(text) }
            });
            let _ = tx.send(picked);
        }
    });
    rx
}

/// Open a file, folder or URL with the OS default handler.
pub fn open_external(target: &str) {
    if target.trim().is_empty() { return; }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", target])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    { let _ = std::process::Command::new("open").arg(target).spawn(); }
}

#[cfg(windows)]
fn set_launch_at_login(enable: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let output = if enable {
        std::process::Command::new("reg")
            .args(["add", key, "/v", "TotalScript", "/t", "REG_SZ", "/d", &format!("\"{}\" --hidden", exe.display()), "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    } else {
        std::process::Command::new("reg")
            .args(["delete", key, "/v", "TotalScript", "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    };
    match output {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
            // Deleting a missing value is not an error for our purposes.
            if !enable && msg.to_lowercase().contains("unable to find") { Ok(()) } else { Err(if msg.is_empty() { "reg.exe failed".into() } else { msg }) }
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(target_os = "macos")]
fn set_launch_at_login(enable: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let dir = PathBuf::from(home).join("Library").join("LaunchAgents");
    let plist = dir.join("com.totalscript.desktop.plist");
    if enable {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let body = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.totalscript.desktop</string>
  <key>ProgramArguments</key><array><string>{}</string><string>--hidden</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
"#, exe.display());
        std::fs::write(&plist, body).map_err(|e| e.to_string())?;
        let _ = std::process::Command::new("launchctl").args(["load", "-w", &plist.to_string_lossy()]).output();
        Ok(())
    } else {
        let _ = std::process::Command::new("launchctl").args(["unload", "-w", &plist.to_string_lossy()]).output();
        match std::fs::remove_file(&plist) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Decode the bundled PNG logo into RGBA (window icon, tray icon, in-app logo).
fn load_logo() -> Option<(Vec<u8>, u32, u32)> {
    const PNG: &[u8] = include_bytes!("../../assets/icon.png");
    let icon = eframe::icon_data::from_png_bytes(PNG).ok()?;
    Some((icon.rgba, icon.width, icon.height))
}

/// Nearest-neighbour downscale for the notification-area icon.
#[cfg(has_tray)]
fn downscale_rgba(rgba: &[u8], w: u32, h: u32, size: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let sx = (x as u64 * w as u64 / size as u64) as usize;
            let sy = (y as u64 * h as u64 / size as u64) as usize;
            let i = (sy * w as usize + sx) * 4;
            out.extend_from_slice(&rgba[i..i + 4]);
        }
    }
    out
}

// ───────────────────────────── tray ─────────────────────────────
// Windows + macOS: tray-icon on the main thread.

#[cfg(has_tray)]
pub struct TrayState {
    icon: Option<tray_icon::TrayIcon>,
    _menu: Option<tray_icon::menu::Menu>,
    last_tooltip: String,
}

#[cfg(has_tray)]
fn build_tray(
    logo: Option<&(Vec<u8>, u32, u32)>,
    shared: Arc<UiShared>,
    cmd_tx: UnboundedSender<UiCommand>,
) -> anyhow::Result<TrayState> {
    let (icon, menu) = tray_menu_and_icon(logo, shared, cmd_tx)?;
    Ok(TrayState { icon: Some(icon), _menu: Some(menu), last_tooltip: String::new() })
}

#[cfg(has_tray)]
fn tray_menu_and_icon(
    logo: Option<&(Vec<u8>, u32, u32)>,
    shared: Arc<UiShared>,
    cmd_tx: UnboundedSender<UiCommand>,
) -> anyhow::Result<(tray_icon::TrayIcon, tray_icon::menu::Menu)> {
    use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let menu = Menu::new();
    let open = MenuItem::new("Open TotalScript", true, None);
    let folder = MenuItem::new("Open workspace folder", true, None);
    let restart = MenuItem::new("Restart Studio MCP helper", true, None);
    let probe = MenuItem::new("Probe Studio", true, None);
    let kill = MenuItem::new("Kill Roblox Studio", true, None);
    let quit = MenuItem::new("Quit TotalScript (stop bridge)", true, None);
    menu.append(&open)?;
    menu.append(&folder)?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&restart)?;
    menu.append(&probe)?;
    menu.append(&kill)?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&quit)?;

    let mut builder = TrayIconBuilder::new()
        .with_menu(Box::new(menu.clone()))
        .with_tooltip("TotalScript Desktop — bridge running")
        .with_menu_on_left_click(false);
    if let Some((rgba, w, h)) = logo {
        let small = downscale_rgba(rgba, *w, *h, 32);
        if let Ok(icon) = tray_icon::Icon::from_rgba(small, 32, 32) {
            builder = builder.with_icon(icon);
        }
    }
    let icon = builder.build()?;

    let ids = (open.id().clone(), folder.id().clone(), restart.id().clone(), probe.id().clone(), kill.id().clone(), quit.id().clone());
    // One dedicated worker drains BOTH tray channels. It must not live in
    // App::update: eframe produces no frames while the window is hidden, so a
    // tray click polled from update() would never be seen — the window could
    // not be brought back and "Quit" did nothing (the original total-core bug).
    // Left-click raises the window (menu is right-click only); act on the
    // button-DOWN edge because the UP edge is lost when the raised window
    // takes focus mid-click.
    std::thread::Builder::new().name("totalscript-tray".to_string()).spawn(move || {
        loop {
            let mut idle = true;
            while let Ok(event) = MenuEvent::receiver().try_recv() {
                idle = false;
                if event.id == ids.0 {
                    show_window();
                } else if event.id == ids.1 {
                    open_external(&shared.root());
                } else if event.id == ids.2 {
                    let _ = cmd_tx.send(UiCommand::RestartMcp);
                } else if event.id == ids.3 {
                    let _ = cmd_tx.send(UiCommand::ProbeStudio);
                } else if event.id == ids.4 {
                    let _ = cmd_tx.send(UiCommand::KillStudio);
                } else if event.id == ids.5 {
                    request_quit(&shared);
                }
            }
            while let Ok(event) = TrayIconEvent::receiver().try_recv() {
                idle = false;
                let show = matches!(event,
                    TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Down, .. }
                    | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. });
                if show { show_window(); }
            }
            std::thread::sleep(Duration::from_millis(if idle { 60 } else { 10 }));
        }
    })?;

    Ok((icon, menu))
}

#[cfg(not(has_tray))]
pub struct TrayState;

#[cfg(not(has_tray))]
impl App {
    fn update_tray(&mut self) {}
}

#[cfg(has_tray)]
impl App {
    fn update_tray(&mut self) {
        let Some(tray) = self.tray.as_mut() else { return; };
        let Some(icon) = tray.icon.as_ref() else { return; };
        let s = &self.shared;
        let studio = if s.studio_connected.load(Ordering::Relaxed) { "Studio linked" }
            else if s.studio_running.load(Ordering::Relaxed) { "Studio open, MCP not linked" }
            else { "Studio closed" };
        let ext = s.roblox_clients.load(Ordering::Relaxed) + s.local_clients.load(Ordering::Relaxed);
        let bridge = if s.fatal.lock().unwrap_or_else(|e| e.into_inner()).is_some() { "bridge ERROR" } else if !s.bridge_listening.load(Ordering::Relaxed) { "bridge starting" } else if ext > 0 { "extension connected" } else { "waiting for extension" };
        let tooltip = format!("TotalScript Desktop {}\n{} · {}", env!("CARGO_PKG_VERSION"), bridge, studio);
        if tooltip != tray.last_tooltip {
            let _ = icon.set_tooltip(Some(tooltip.clone()));
            tray.last_tooltip = tooltip;
        }
    }
}

// ───────────────────────────── entry point ─────────────────────────────

/// Run the window on the calling (main) thread. Returns when the user quits.
pub fn run_gui(shared: Arc<UiShared>, cmd_tx: UnboundedSender<UiCommand>, settings: Settings, start_hidden: bool) -> anyhow::Result<()> {
    let logo = load_logo();
    let size = if settings.window_width >= 960.0 && settings.window_height >= 620.0 {
        [settings.window_width, settings.window_height]
    } else {
        [1280.0, 820.0]
    };
    let mut viewport = egui::ViewportBuilder::default()
        .with_title(WINDOW_TITLE)
        .with_app_id("totalscript-desktop")
        .with_inner_size(size)
        .with_min_inner_size([960.0, 620.0])
        .with_decorations(false)
        .with_resizable(true)
        .with_visible(!start_hidden);
    if let Some((rgba, w, h)) = &logo {
        viewport = viewport.with_icon(egui::IconData { rgba: rgba.clone(), width: *w, height: *h });
    }
    let options = eframe::NativeOptions { viewport, centered: true, persist_window: false, ..Default::default() };

    shared.track("app", format!("TotalScript Desktop {} window opened", env!("CARGO_PKG_VERSION")));
    let app_shared = shared.clone();
    eframe::run_native(
        APP_NAME,
        options,
        Box::new(move |_cc| {
            // The notification-area icon is created HERE, on the event-loop
            // thread after winit started pumping messages. Created before
            // run_native, the icon's hidden message window had no running loop
            // yet on Windows (clicks were never delivered) and macOS refuses a
            // status item before NSApplication is running.
            #[cfg(has_tray)]
            let make_tray = || -> Option<TrayState> {
                match build_tray(logo.as_ref(), app_shared.clone(), cmd_tx.clone()) {
                    Ok(t) => Some(t),
                    Err(e) => { app_shared.log(&format!("WARN tray icon unavailable: {e:#}")); None }
                }
            };
            #[cfg(not(has_tray))]
            let make_tray = || -> Option<TrayState> { None };
            let tray = make_tray();
            Ok(Box::new(App::new(
                &_cc.egui_ctx,
                app_shared,
                cmd_tx,
                settings,
                start_hidden,
                logo,
                tray,
            )))
        }),
    )
    .map_err(|e| anyhow::anyhow!("{e}"))
}
