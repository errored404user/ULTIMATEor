//! ORscript Desktop — the native workspace window.
//!
//! Pure Rust (eframe/egui 0.29) with a notification-area icon (tray-icon 0.19
//! on Windows). The window is a *view* over the bridge that `main.rs` runs on
//! the tokio runtime: it reads shared state (`UiShared`) and asks the runtime
//! to do things through `UiCommand`s. Closing the window hides it to the tray;
//! the bridge (HTTP 3000, WS 17613 / 17615, Studio MCP helper) keeps running
//! until "Quit" is chosen from the tray menu or Settings.

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{Receiver, Sender},
        Arc, Mutex, RwLock,
    },
    time::{Duration, Instant},
};

use eframe::egui;
use egui::{Align, Color32, FontFamily, FontId, Layout, Margin, RichText, Rounding, Sense, Stroke, TextStyle, Vec2};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const APP_NAME: &str = "ORscript";
pub const WINDOW_TITLE: &str = "ORscript";
pub const REPO: &str = "errored404user/ULTIMATEor";
const LOG_CAP: usize = 800;
const ACTIVITY_CAP: usize = 120;
const HISTORY_CAP: usize = 60;

// ───────────────────────────── shared state ─────────────────────────────

/// One tool the bridge can execute, as shown in the Tools page.
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
    pub boot: Instant,
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
            boot: Instant::now(),
        }
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
        let mut list = self.activity.lock().unwrap_or_else(|e| e.into_inner());
        if list.len() >= ACTIVITY_CAP { list.pop_back(); }
        list.push_front(Activity {
            at: chrono::Local::now().format("%H:%M:%S").to_string(),
            kind: kind.to_string(),
            text: text.into(),
        });
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

pub struct UpdateReply {
    pub ok: bool,
    pub current: String,
    pub latest: String,
    pub up_to_date: bool,
    pub message: String,
    pub url: String,
}

/// Requests from the window to the bridge runtime (handled in `main.rs`).
pub enum UiCommand {
    RestartMcp,
    ProbeStudio,
    KillStudio,
    SetFullAccess(bool),
    SetWorkspace { path: String, reply: Sender<Result<String, String>> },
    SetMcpCommand(String),
    RunTool { engine: String, name: String, args: serde_json::Value, reply: Sender<ToolReply> },
    RunCommand { command: String, reply: Sender<ToolReply> },
    CheckUpdates { reply: Sender<UpdateReply> },
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
    pub mcp_command: String,
    pub full_access: bool,
    pub compact: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "gold".into(),
            close_to_tray: true,
            start_hidden: false,
            launch_at_login: false,
            workspace_root: String::new(),
            mcp_command: String::new(),
            full_access: false,
            compact: false,
        }
    }
}

impl Settings {
    pub fn path() -> PathBuf {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("settings.json")))
            .unwrap_or_else(|| PathBuf::from("settings.json"))
    }

    pub fn load() -> Self {
        std::fs::read_to_string(Self::path())
            .ok()
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
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
}

impl Theme {
    fn by_id(id: &str) -> Theme {
        match id {
            "emerald" => Theme {
                bg: Color32::from_rgb(7, 14, 12),
                bg2: Color32::from_rgb(10, 20, 17),
                panel: Color32::from_rgb(13, 25, 21),
                panel2: Color32::from_rgb(18, 33, 28),
                border: Color32::from_rgb(30, 54, 46),
                border2: Color32::from_rgb(46, 84, 70),
                text: Color32::from_rgb(232, 245, 238),
                muted: Color32::from_rgb(134, 164, 150),
                accent: Color32::from_rgb(52, 211, 153),
                accent2: Color32::from_rgb(16, 185, 129),
                accent_ink: Color32::from_rgb(4, 24, 16),
                ok: Color32::from_rgb(74, 222, 128),
                warn: Color32::from_rgb(250, 204, 21),
                bad: Color32::from_rgb(248, 113, 113),
                info: Color32::from_rgb(96, 165, 250),
            },
            "graphite" => Theme {
                bg: Color32::from_rgb(12, 12, 14),
                bg2: Color32::from_rgb(16, 16, 19),
                panel: Color32::from_rgb(21, 21, 25),
                panel2: Color32::from_rgb(28, 28, 33),
                border: Color32::from_rgb(42, 42, 50),
                border2: Color32::from_rgb(62, 62, 72),
                text: Color32::from_rgb(240, 240, 244),
                muted: Color32::from_rgb(142, 142, 156),
                accent: Color32::from_rgb(226, 232, 240),
                accent2: Color32::from_rgb(148, 163, 184),
                accent_ink: Color32::from_rgb(12, 12, 14),
                ok: Color32::from_rgb(74, 222, 128),
                warn: Color32::from_rgb(250, 204, 21),
                bad: Color32::from_rgb(248, 113, 113),
                info: Color32::from_rgb(96, 165, 250),
            },
            _ => Theme {
                bg: Color32::from_rgb(11, 10, 8),
                bg2: Color32::from_rgb(16, 14, 10),
                panel: Color32::from_rgb(22, 19, 13),
                panel2: Color32::from_rgb(30, 26, 17),
                border: Color32::from_rgb(52, 44, 26),
                border2: Color32::from_rgb(86, 72, 38),
                text: Color32::from_rgb(247, 241, 226),
                muted: Color32::from_rgb(166, 152, 118),
                accent: Color32::from_rgb(244, 196, 48),
                accent2: Color32::from_rgb(214, 158, 22),
                accent_ink: Color32::from_rgb(28, 20, 4),
                ok: Color32::from_rgb(86, 222, 134),
                warn: Color32::from_rgb(250, 204, 21),
                bad: Color32::from_rgb(248, 113, 113),
                info: Color32::from_rgb(96, 165, 250),
            },
        }
    }

    fn apply(&self, ctx: &egui::Context, compact: bool) {
        let mut style = (*ctx.style()).clone();
        let base = if compact { 13.0 } else { 14.0 };
        style.text_styles = [
            (TextStyle::Heading, FontId::new(base + 8.0, FontFamily::Proportional)),
            (TextStyle::Body, FontId::new(base, FontFamily::Proportional)),
            (TextStyle::Button, FontId::new(base, FontFamily::Proportional)),
            (TextStyle::Small, FontId::new(base - 2.5, FontFamily::Proportional)),
            (TextStyle::Monospace, FontId::new(base - 1.0, FontFamily::Monospace)),
        ]
        .into();
        style.spacing.item_spacing = Vec2::new(10.0, 8.0);
        style.spacing.button_padding = Vec2::new(14.0, 7.0);
        style.spacing.interact_size = Vec2::new(40.0, 26.0);
        style.spacing.indent = 18.0;
        style.spacing.scroll.bar_width = 8.0;

        let mut v = egui::Visuals::dark();
        v.override_text_color = Some(self.text);
        v.panel_fill = self.bg;
        v.window_fill = self.panel;
        v.window_stroke = Stroke::new(1.0, self.border2);
        v.window_rounding = Rounding::same(14.0);
        v.menu_rounding = Rounding::same(10.0);
        v.extreme_bg_color = self.bg2;
        v.faint_bg_color = self.panel2;
        v.code_bg_color = self.bg2;
        v.hyperlink_color = self.accent;
        v.warn_fg_color = self.warn;
        v.error_fg_color = self.bad;
        v.selection.bg_fill = self.accent.linear_multiply(0.35);
        v.selection.stroke = Stroke::new(1.0, self.accent);

        v.widgets.noninteractive.bg_fill = self.panel;
        v.widgets.noninteractive.weak_bg_fill = self.panel;
        v.widgets.noninteractive.bg_stroke = Stroke::new(1.0, self.border);
        v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, self.text);
        v.widgets.noninteractive.rounding = Rounding::same(10.0);

        v.widgets.inactive.bg_fill = self.panel2;
        v.widgets.inactive.weak_bg_fill = self.panel2;
        v.widgets.inactive.bg_stroke = Stroke::new(1.0, self.border);
        v.widgets.inactive.fg_stroke = Stroke::new(1.0, self.text);
        v.widgets.inactive.rounding = Rounding::same(10.0);

        v.widgets.hovered.bg_fill = self.border;
        v.widgets.hovered.weak_bg_fill = self.border;
        v.widgets.hovered.bg_stroke = Stroke::new(1.0, self.border2);
        v.widgets.hovered.fg_stroke = Stroke::new(1.5, self.text);
        v.widgets.hovered.rounding = Rounding::same(10.0);

        v.widgets.active.bg_fill = self.border2;
        v.widgets.active.weak_bg_fill = self.border2;
        v.widgets.active.bg_stroke = Stroke::new(1.0, self.accent);
        v.widgets.active.fg_stroke = Stroke::new(1.5, self.text);
        v.widgets.active.rounding = Rounding::same(10.0);

        v.widgets.open.bg_fill = self.panel2;
        v.widgets.open.weak_bg_fill = self.panel2;
        v.widgets.open.bg_stroke = Stroke::new(1.0, self.accent);
        v.widgets.open.fg_stroke = Stroke::new(1.0, self.text);
        v.widgets.open.rounding = Rounding::same(10.0);

        style.visuals = v;
        ctx.set_style(style);
    }
}

// ───────────────────────────── pages ─────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Page { Home, Explorer, Tools, Servers, Terminal, Updates, Settings }

impl Page {
    const ALL: [Page; 7] = [Page::Home, Page::Explorer, Page::Tools, Page::Servers, Page::Terminal, Page::Updates, Page::Settings];

    fn title(self) -> &'static str {
        match self {
            Page::Home => "Home",
            Page::Explorer => "Explorer",
            Page::Tools => "Tools",
            Page::Servers => "MCP Servers",
            Page::Terminal => "Terminal",
            Page::Updates => "Updates",
            Page::Settings => "Settings",
        }
    }

    fn subtitle(self) -> &'static str {
        match self {
            Page::Home => "Bridge overview, Studio link and quick access",
            Page::Explorer => "Browse and edit the AgentScript workspace",
            Page::Tools => "Every tool the extension can call through this bridge — run any of them by hand",
            Page::Servers => "Roblox Studio MCP, the local filesystem engine and the extension channels",
            Page::Terminal => "Bridge console, workspace commands and Luau in Studio",
            Page::Updates => "Version, build and GitHub releases",
            Page::Settings => "Appearance, behaviour, workspace, Studio MCP and diagnostics",
        }
    }

    fn shortcut_key(self) -> egui::Key {
        match self {
            Page::Home => egui::Key::Num1,
            Page::Explorer => egui::Key::Num2,
            Page::Tools => egui::Key::Num3,
            Page::Servers => egui::Key::Num4,
            Page::Terminal => egui::Key::Num5,
            Page::Updates => egui::Key::Num6,
            Page::Settings => egui::Key::Num7,
        }
    }
}

// ───────────────────────────── app ─────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum ToolFilter { All, Roblox, Local }

#[derive(Clone, Copy, PartialEq, Eq)]
enum RunnerMode { Command, Luau }

struct ExplorerEntry { name: String, path: PathBuf, is_dir: bool, size: u64 }

struct ToolRun { receiver: Receiver<ToolReply>, started: Instant, name: String }

struct Snapshot { texture: egui::TextureHandle, size: [usize; 2], taken_at: String, source: String }

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
    toast: Option<(String, Instant, bool)>,
    // home
    snapshot: Option<Snapshot>,
    snapshot_run: Option<ToolRun>,
    // tools
    tool_query: String,
    tool_filter: ToolFilter,
    local_tools: Vec<ToolInfo>,
    selected_tool: Option<(String, String)>,
    run_args: String,
    run_output: String,
    run_job: Option<ToolRun>,
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
    // updates
    update: Option<UpdateReply>,
    update_rx: Option<Receiver<UpdateReply>>,
    // settings
    draft_workspace: String,
    draft_mcp: String,
    settings_note: String,
    picker_rx: Option<Receiver<Option<String>>>,
    workspace_rx: Option<Receiver<Result<String, String>>>,
    tray: Option<TrayState>,
}

impl App {
    fn new(
        cc: &eframe::CreationContext<'_>,
        shared: Arc<UiShared>,
        cmd_tx: UnboundedSender<UiCommand>,
        settings: Settings,
        start_hidden: bool,
        logo_rgba: Option<(Vec<u8>, u32, u32)>,
        tray: Option<TrayState>,
    ) -> Self {
        let theme = Theme::by_id(&settings.theme);
        theme.apply(&cc.egui_ctx, settings.compact);
        let logo = logo_rgba.as_ref().map(|(rgba, w, h)| {
            let image = egui::ColorImage::from_rgba_unmultiplied([*w as usize, *h as usize], rgba);
            cc.egui_ctx.load_texture("orscript-logo", image, egui::TextureOptions::LINEAR)
        });
        let local_tools: Vec<ToolInfo> = crate::workspace::catalog()
            .iter()
            .filter_map(|t| ToolInfo::from_mcp(t, "local"))
            .collect();
        let root = PathBuf::from(shared.root());
        let mut app = Self {
            draft_workspace: shared.root(),
            draft_mcp: settings.mcp_command.clone(),
            shared,
            cmd_tx,
            settings,
            theme,
            page: Page::Home,
            logo,
            first_frame: true,
            start_hidden,
            quit_now: false,
            toast: None,
            snapshot: None,
            snapshot_run: None,
            tool_query: String::new(),
            tool_filter: ToolFilter::All,
            local_tools,
            selected_tool: None,
            run_args: "{}".into(),
            run_output: String::new(),
            run_job: None,
            kill_armed: None,
            runner_mode: RunnerMode::Command,
            term_cmd: String::new(),
            term_history: Vec::new(),
            history_cursor: None,
            term_output: Vec::new(),
            term_run: None,
            luau_code: "-- Runs inside Roblox Studio through execute_luau (Edit DataModel)\nlocal workspace = game:GetService(\"Workspace\")\nprint(\"ORscript: \" .. #workspace:GetChildren() .. \" children in Workspace\")\n".into(),
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
            update: None,
            update_rx: None,
            settings_note: String::new(),
            picker_rx: None,
            workspace_rx: None,
            tray,
        };
        app.refresh_explorer();
        app
    }

    // ── helpers ──

    fn toast(&mut self, text: impl Into<String>, ok: bool) {
        self.toast = Some((text.into(), Instant::now(), ok));
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
            self.explorer_note = format!("Cannot read {}", self.explorer_dir.display());
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
        // Tools page run
        let job = self.run_job.as_ref().map(|run| (run.receiver.try_recv(), run.name.clone()));
        if let Some((result, name)) = job {
            match result {
                Ok(reply) => {
                    let status = if reply.ok { "OK" } else { "ERROR" };
                    let extra = if reply.images.is_empty() { String::new() } else { format!(" · {} image(s) — shown on Home", reply.images.len()) };
                    self.run_output = format!("[{status} · {name} · {} ms{extra}]\n{}", reply.elapsed_ms, reply.text);
                    if reply.ok && !reply.images.is_empty() { self.store_snapshot(ctx, &reply.images, &name); }
                    self.run_job = None;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => { self.run_output = "[ERROR] runtime dropped the request".into(); self.run_job = None; }
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
        // Updates
        let upd = self.update_rx.as_ref().map(|rx| rx.try_recv());
        if let Some(result) = upd {
            match result {
                Ok(reply) => { self.update = Some(reply); self.update_rx = None; }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => {
                    self.update = Some(UpdateReply {
                        ok: false,
                        current: env!("CARGO_PKG_VERSION").into(),
                        latest: String::new(),
                        up_to_date: false,
                        message: "runtime dropped the request".into(),
                        url: format!("https://github.com/{REPO}/releases"),
                    });
                    self.update_rx = None;
                }
            }
        }
        // Folder picker
        let picked = self.picker_rx.as_ref().map(|rx| rx.try_recv());
        if let Some(result) = picked {
            match result {
                Ok(Some(path)) => { self.draft_workspace = path; self.picker_rx = None; }
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
    }

    fn handle_shortcuts(&mut self, ctx: &egui::Context) {
        let mut nav: Option<Page> = None;
        let mut restart = false;
        let mut refresh = false;
        let mut capture = false;
        ctx.input(|i| {
            if i.modifiers.command {
                for page in Page::ALL {
                    if i.key_pressed(page.shortcut_key()) { nav = Some(page); }
                }
                if i.key_pressed(egui::Key::R) { restart = true; }
                if i.modifiers.shift && i.key_pressed(egui::Key::S) { capture = true; }
            }
            if i.key_pressed(egui::Key::F5) { refresh = true; }
        });
        if let Some(page) = nav { self.page = page; }
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
        out.push_str(&format!("ORscript Desktop {}\n", env!("CARGO_PKG_VERSION")));
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
        out.push_str("\n--- last 40 log lines ---\n");
        let logs = s.logs.lock().unwrap_or_else(|e| e.into_inner());
        let skip = logs.len().saturating_sub(40);
        for line in logs.iter().skip(skip) { out.push_str(line); out.push('\n'); }
        out
    }

    fn handle_close(&mut self, ctx: &egui::Context) {
        if !ctx.input(|i| i.viewport().close_requested()) { return; }
        let quit = self.quit_now || self.shared.quit_requested.load(Ordering::Relaxed) || !self.settings.close_to_tray;
        #[cfg(not(windows))]
        let quit = true;
        if quit { return; }
        ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
        #[cfg(windows)]
        {
            if let Some(hwnd) = crate::agent_window() { crate::hide_agent_window(hwnd); }
            self.shared.track("app", "window hidden to the notification area — bridge keeps running");
        }
    }

    // ── chrome ──

    fn titlebar(&mut self, ctx: &egui::Context) {
        let t = self.theme;
        egui::TopBottomPanel::top("titlebar")
            .exact_height(40.0)
            .frame(egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0, t.border)).inner_margin(Margin::symmetric(12.0, 0.0)))
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
                    ui.label(RichText::new("ORscript").strong().color(t.text));
                    ui.label(RichText::new("Desktop").color(t.muted));
                    ui.add_space(8.0);
                    let online = self.shared.studio_connected.load(Ordering::Relaxed);
                    let (dot, text) = if online { (t.ok, "Studio linked") }
                        else if self.shared.studio_running.load(Ordering::Relaxed) { (t.warn, "Studio open · MCP not linked") }
                        else { (t.muted, "Studio closed") };
                    status_dot(ui, dot);
                    ui.label(RichText::new(text).small().color(t.muted));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 2.0;
                        if window_button(ui, WinGlyph::Close, t.bad, t).clicked() { ctx.send_viewport_cmd(egui::ViewportCommand::Close); }
                        if window_button(ui, WinGlyph::Maximize, t.text, t).clicked() {
                            let max = ctx.input(|i| i.viewport().maximized.unwrap_or(false));
                            ctx.send_viewport_cmd(egui::ViewportCommand::Maximized(!max));
                        }
                        if window_button(ui, WinGlyph::Minimize, t.text, t).clicked() { ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(true)); }
                        ui.add_space(8.0);
                        ui.label(RichText::new(format!("v{}", env!("CARGO_PKG_VERSION"))).small().color(t.muted));
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

    fn sidebar(&mut self, ctx: &egui::Context) {
        let t = self.theme;
        egui::SidePanel::left("sidebar")
            .exact_width(228.0)
            .resizable(false)
            .frame(egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0, t.border)).inner_margin(Margin::symmetric(12.0, 14.0)))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    self.logo_mark(ui, 38.0);
                    ui.vertical(|ui| {
                        ui.spacing_mut().item_spacing.y = 1.0;
                        ui.label(RichText::new("ORscript").size(17.0).strong().color(t.accent));
                        ui.label(RichText::new("Workspace bridge").small().color(t.muted));
                    });
                });
                ui.add_space(14.0);
                ui.label(RichText::new("WORKSPACE").small().strong().color(t.muted));
                ui.add_space(4.0);
                for (n, page) in Page::ALL.iter().enumerate() {
                    let page = *page;
                    if page == Page::Updates { ui.add_space(8.0); ui.label(RichText::new("SYSTEM").small().strong().color(t.muted)); ui.add_space(4.0); }
                    let selected = self.page == page;
                    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::click());
                    let resp = resp.on_hover_text(format!("{}  (Ctrl+{})", page.title(), n + 1));
                    if resp.hovered() { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
                    let fill = if selected { t.accent.linear_multiply(0.18) } else if resp.hovered() { t.panel2 } else { Color32::TRANSPARENT };
                    ui.painter().rect_filled(rect, Rounding::same(10.0), fill);
                    if selected {
                        let bar = egui::Rect::from_min_size(rect.min + Vec2::new(0.0, 8.0), Vec2::new(3.0, rect.height() - 16.0));
                        ui.painter().rect_filled(bar, Rounding::same(2.0), t.accent);
                    }
                    let icon_rect = egui::Rect::from_center_size(rect.left_center() + Vec2::new(22.0, 0.0), Vec2::splat(16.0));
                    let color = if selected { t.accent } else { t.muted };
                    nav_icon(ui.painter(), icon_rect, page, color);
                    ui.painter().text(
                        rect.left_center() + Vec2::new(42.0, 0.0),
                        egui::Align2::LEFT_CENTER,
                        page.title(),
                        FontId::new(14.0, FontFamily::Proportional),
                        if selected { t.text } else { t.muted },
                    );
                    if page == Page::Updates {
                        if let Some(u) = &self.update {
                            if u.ok && !u.up_to_date {
                                ui.painter().circle_filled(rect.right_center() - Vec2::new(14.0, 0.0), 4.0, t.accent);
                            }
                        }
                    }
                    if resp.clicked() { self.page = page; }
                    ui.add_space(2.0);
                }
                ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
                    let s = &self.shared;
                    let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(10.0));
                    frame.show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.label(RichText::new("BRIDGE").small().strong().color(t.muted));
                        row_status(ui, t, "HTTP 3000", s.fatal.lock().unwrap_or_else(|e| e.into_inner()).is_none());
                        row_status(ui, t, "WS 17613 roblox", s.roblox_clients.load(Ordering::Relaxed) > 0);
                        row_status(ui, t, "WS 17615 local", s.local_clients.load(Ordering::Relaxed) > 0);
                        row_status(ui, t, "Studio MCP helper", s.mcp_alive.load(Ordering::Relaxed));
                        ui.add_space(2.0);
                        ui.label(RichText::new(format!("up {}", human_duration(s.boot.elapsed()))).small().color(t.muted));
                    });
                });
            });
    }

    fn page_header(&self, ui: &mut egui::Ui) {
        let t = self.theme;
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 2.0;
            ui.label(RichText::new(self.page.title()).size(24.0).strong().color(t.text));
            ui.label(RichText::new(self.page.subtitle()).color(t.muted));
        });
        ui.add_space(12.0);
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

        if let Some(f) = fatal {
            let frame = egui::Frame::none().fill(t.bad.linear_multiply(0.15)).stroke(Stroke::new(1.0, t.bad)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(12.0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(RichText::new("Bridge failed to start").strong().color(t.bad));
                ui.label(RichText::new(f).color(t.text));
            });
            ui.add_space(10.0);
        }

        // Hero
        let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border2)).rounding(Rounding::same(16.0)).inner_margin(Margin::same(18.0));
        frame.show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                self.logo_mark(ui, 56.0);
                ui.add_space(6.0);
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 3.0;
                    ui.label(RichText::new("Native bridge for the ORscript extension").size(18.0).strong().color(t.text));
                    ui.label(RichText::new("Roblox Studio MCP and the AgentScript workspace, served to your browser AI on http://127.0.0.1:3000 · ws 17613 · ws 17615. Close the window and it keeps running in the notification area.").color(t.muted));
                });
            });
            ui.add_space(12.0);
            ui.horizontal_wrapped(|ui| {
                if pill(ui, t, "Restart Studio MCP", true).on_hover_text("Ctrl+R").clicked() { self.send(UiCommand::RestartMcp, "Restarting Studio MCP helper"); }
                if pill(ui, t, "Probe Studio", false).on_hover_text("F5").clicked() { self.send(UiCommand::ProbeStudio, "Probing Studio"); }
                let capturing = self.snapshot_run.is_some();
                if ui.add_enabled(!capturing, pill_widget(t, if capturing { "Capturing…" } else { "Capture Studio viewport" }, false)).on_hover_text("Ctrl+Shift+S").clicked() { self.capture_studio(); }
                if pill(ui, t, "Open workspace folder", false).clicked() { open_external(&s.root()); }
                if pill(ui, t, "Copy diagnostics", false).clicked() {
                    let text = self.diagnostics_text();
                    ui.output_mut(|o| o.copied_text = text);
                    self.toast("Diagnostics copied to clipboard", true);
                }
            });
        });
        ui.add_space(14.0);

        // Status cards
        let cards: [(&str, String, String, Color32); 4] = [
            ("Bridge",
                if s.fatal.lock().unwrap_or_else(|e| e.into_inner()).is_some() { "Error".into() } else { "Online".into() },
                format!("{} extension channel(s) · up {}", s.roblox_clients.load(Ordering::Relaxed) + s.local_clients.load(Ordering::Relaxed), human_duration(s.boot.elapsed())),
                if s.fatal.lock().unwrap_or_else(|e| e.into_inner()).is_some() { t.bad } else { t.ok }),
            ("Roblox Studio",
                if studio_link { "Connected".into() } else if studio_proc { "Open · not linked".into() } else { "Closed".into() },
                if studio_link { "MCP helper linked to a Studio place".into() } else if studio_proc { if mcp { "Enable Studio as MCP server, then probe".into() } else { "Helper not running — restart MCP".into() } } else { "Start Roblox Studio to link".into() },
                if studio_link { t.ok } else if studio_proc { t.warn } else { t.muted }),
            ("Tools", format!("{}", tools.len()), format!("{} Studio · {} local", tools.iter().filter(|x| x.engine == "roblox").count(), self.local_tools.len()), if tools.len() > self.local_tools.len() { t.ok } else { t.warn }),
            ("Workspace", if ws_ready { "Ready".into() } else { "Missing".into() }, short_path(&s.root(), 34) + if s.full_access() { " · FULL ACCESS" } else { "" }, if ws_ready { if s.full_access() { t.warn } else { t.ok } } else { t.bad }),
        ];
        ui.columns(4, |cols| {
            for (i, (title, value, sub, color)) in cards.iter().enumerate() {
                let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(14.0)).inner_margin(Margin::same(14.0));
                frame.show(&mut cols[i], |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        status_dot(ui, *color);
                        ui.label(RichText::new(*title).small().strong().color(t.muted));
                    });
                    ui.label(RichText::new(value).size(20.0).strong().color(t.text));
                    ui.label(RichText::new(sub).small().color(t.muted));
                });
            }
        });
        ui.add_space(14.0);

        egui::ScrollArea::vertical().id_salt("home-scroll").auto_shrink([false, false]).show(ui, |ui| {
            ui.columns(2, |cols| {
                // Left: Studio viewport + quick access
                {
                    let ui = &mut cols[0];
                    ui.label(RichText::new("Studio viewport").size(16.0).strong().color(t.text));
                    ui.add_space(6.0);
                    let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(10.0));
                    frame.show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        match &self.snapshot {
                            Some(snap) => {
                                let avail = ui.available_width();
                                let aspect = snap.size[1] as f32 / snap.size[0].max(1) as f32;
                                let size = Vec2::new(avail, (avail * aspect).min(420.0));
                                ui.add(egui::Image::from_texture(egui::load::SizedTexture::new(snap.texture.id(), size)).rounding(Rounding::same(8.0)));
                                ui.horizontal(|ui| {
                                    ui.label(RichText::new(format!("{}×{} · {} · via {}", snap.size[0], snap.size[1], snap.taken_at, snap.source)).small().color(t.muted));
                                });
                            }
                            None => {
                                ui.label(RichText::new("No snapshot yet. Capture the current Studio viewport through the same screen_capture tool the AI uses — handy to confirm what the agent is looking at.").color(t.muted));
                            }
                        }
                        ui.horizontal(|ui| {
                            let capturing = self.snapshot_run.is_some();
                            if ui.add_enabled(!capturing && studio_link, pill_widget(t, if capturing { "Capturing…" } else { "Capture" }, true)).clicked() { self.capture_studio(); }
                            if self.snapshot.is_some() && ui.button("Clear").clicked() { self.snapshot = None; }
                            if !studio_link { ui.label(RichText::new("Link Studio first").small().color(t.muted)); }
                        });
                    });
                    ui.add_space(12.0);
                    ui.label(RichText::new("Quick access").size(16.0).strong().color(t.text));
                    ui.add_space(6.0);
                    let items: [(&str, &str, Page); 6] = [
                        ("Explorer", "Edit files inside the AgentScript workspace", Page::Explorer),
                        ("Tools", "Browse and run every Studio and workspace tool", Page::Tools),
                        ("MCP Servers", "Restart the helper, probe or kill Studio, FULL access", Page::Servers),
                        ("Terminal", "Bridge console, shell commands, Luau in Studio", Page::Terminal),
                        ("Updates", "Version and GitHub releases", Page::Updates),
                        ("Settings", "Theme, tray behaviour, workspace, MCP launcher", Page::Settings),
                    ];
                    for (title, sub, page) in items {
                        let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::symmetric(12.0, 10.0));
                        let resp = frame.show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.horizontal(|ui| {
                                let (icon_rect, _) = ui.allocate_exact_size(Vec2::splat(18.0), Sense::hover());
                                nav_icon(ui.painter(), icon_rect, page, t.accent);
                                ui.vertical(|ui| {
                                    ui.spacing_mut().item_spacing.y = 1.0;
                                    ui.label(RichText::new(title).strong().color(t.text));
                                    ui.label(RichText::new(sub).small().color(t.muted));
                                });
                            });
                        }).response;
                        let resp = resp.interact(Sense::click());
                        if resp.hovered() { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
                        if resp.clicked() { self.page = page; }
                    }
                }
                // Right: recent activity
                {
                    let ui = &mut cols[1];
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Recent activity").size(16.0).strong().color(t.text));
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if ui.small_button("Clear").clicked() { s.activity.lock().unwrap_or_else(|e| e.into_inner()).clear(); }
                        });
                    });
                    ui.add_space(6.0);
                    let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(10.0));
                    frame.show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        let list = s.activity.lock().unwrap_or_else(|e| e.into_inner()).clone();
                        if list.is_empty() {
                            ui.label(RichText::new("No activity yet. Open the ORscript extension in your browser AI and press Start — tool calls, Studio links and workspace edits appear here.").color(t.muted));
                        }
                        for a in list.iter().take(80) {
                            ui.horizontal(|ui| {
                                ui.label(RichText::new(&a.at).monospace().small().color(t.muted));
                                let color = match a.kind.as_str() { "tool" => t.accent, "studio" => t.ok, "bridge" => t.info, "error" => t.bad, _ => t.muted };
                                tag(ui, &a.kind, color);
                                ui.add(egui::Label::new(RichText::new(&a.text).small().color(t.text)).wrap());
                            });
                        }
                    });
                }
            });
        });
    }

    fn page_explorer(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let root = self.workspace_root();
        ui.horizontal(|ui| {
            if pill(ui, t, "Root", false).clicked() { self.navigate(root.clone()); }
            let can_up = self.explorer_dir != root || self.shared.full_access();
            if ui.add_enabled(can_up, egui::Button::new("Up")).clicked() {
                if let Some(parent) = self.explorer_dir.parent().map(|p| p.to_path_buf()) { self.navigate(parent); }
            }
            if ui.button("Refresh").on_hover_text("F5").clicked() { self.refresh_explorer(); }
            if ui.button("Open in OS").clicked() { open_external(&self.explorer_dir.to_string_lossy()); }
            let jump = ui.add(egui::TextEdit::singleline(&mut self.explorer_jump).font(TextStyle::Monospace).desired_width(ui.available_width() - 60.0));
            if jump.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                let target = PathBuf::from(self.explorer_jump.trim());
                self.navigate(target);
            }
            if ui.button("Go").clicked() { let target = PathBuf::from(self.explorer_jump.trim()); self.navigate(target); }
        });
        ui.horizontal(|ui| {
            ui.add(egui::TextEdit::singleline(&mut self.new_name).hint_text("new name…").desired_width(220.0));
            let name = self.new_name.trim().to_string();
            let valid = !name.is_empty() && !name.contains(['/', '\\']);
            if ui.add_enabled(valid, egui::Button::new("New folder")).clicked() {
                let p = self.explorer_dir.join(&name);
                match std::fs::create_dir_all(&p) { Ok(()) => { self.new_name.clear(); self.refresh_explorer(); self.toast("Folder created", true); } Err(e) => self.toast(format!("{e}"), false) }
            }
            if ui.add_enabled(valid, egui::Button::new("New file")).clicked() {
                let p = self.explorer_dir.join(&name);
                if p.exists() { self.toast("Already exists", false); } else {
                    match std::fs::write(&p, b"") { Ok(()) => { self.new_name.clear(); self.refresh_explorer(); self.open_file(p); self.toast("File created", true); } Err(e) => self.toast(format!("{e}"), false) }
                }
            }
            ui.label(RichText::new(format!("{} item(s)", self.explorer_entries.len())).small().color(t.muted));
            if !self.explorer_note.is_empty() { ui.label(RichText::new(&self.explorer_note).color(t.warn)); }
        });
        ui.add_space(8.0);
        let avail = ui.available_height();
        ui.horizontal_top(|ui| {
            // file list
            let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(8.0));
            frame.show(ui, |ui| {
                ui.set_width(300.0);
                ui.set_min_height(avail - 20.0);
                egui::ScrollArea::vertical().id_salt("explorer-list").auto_shrink([false, false]).show(ui, |ui| {
                    let mut nav: Option<PathBuf> = None;
                    let mut open: Option<PathBuf> = None;
                    for e in &self.explorer_entries {
                        let selected = self.explorer_file.as_ref() == Some(&e.path);
                        let label = if e.is_dir { format!("[{}]", e.name) } else { format!("  {}", e.name) };
                        let resp = ui.selectable_label(selected, RichText::new(label).color(if e.is_dir { t.accent } else { t.text }));
                        let resp = if e.is_dir { resp } else { resp.on_hover_text(human_size(e.size)) };
                        if resp.clicked() { if e.is_dir { nav = Some(e.path.clone()); } else { open = Some(e.path.clone()); } }
                    }
                    if self.explorer_entries.is_empty() { ui.label(RichText::new("Empty folder").color(t.muted)); }
                    if let Some(p) = nav { self.navigate(p); }
                    if let Some(p) = open { self.open_file(p); }
                });
            });
            // editor
            let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(10.0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.set_min_height(avail - 20.0);
                match self.explorer_file.clone() {
                    None => {
                        ui.label(RichText::new("Select a file to preview and edit it. Files up to 2 MB open inline; everything else opens with the OS. Ctrl+S saves.").color(t.muted));
                    }
                    Some(path) => {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()).strong().color(t.text));
                            if self.explorer_dirty { tag(ui, "modified", t.warn); }
                            ui.label(RichText::new(format!("{} lines · {}", self.explorer_text.lines().count(), human_size(self.explorer_text.len() as u64))).small().color(t.muted));
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                let armed = self.delete_armed.map(|a| a.elapsed() < Duration::from_secs(3)).unwrap_or(false);
                                if ui.button(RichText::new(if armed { "Confirm delete" } else { "Delete" }).color(t.bad)).clicked() {
                                    if armed {
                                        match std::fs::remove_file(&path) { Ok(()) => { self.explorer_file = None; self.explorer_text.clear(); self.refresh_explorer(); self.toast("Deleted", true); } Err(e) => self.toast(format!("{e}"), false) }
                                        self.delete_armed = None;
                                    } else { self.delete_armed = Some(Instant::now()); }
                                }
                                if ui.button("Open in OS").clicked() { open_external(&path.to_string_lossy()); }
                                if ui.button("Copy path").clicked() { let p = path.to_string_lossy().to_string(); ui.output_mut(|o| o.copied_text = p); }
                                if ui.add_enabled(self.explorer_dirty, egui::Button::new("Save")).on_hover_text("Ctrl+S").clicked() { self.save_file(); }
                            });
                        });
                        egui::ScrollArea::vertical().id_salt("explorer-editor").auto_shrink([false, false]).show(ui, |ui| {
                            let resp = ui.add(
                                egui::TextEdit::multiline(&mut self.explorer_text)
                                    .code_editor()
                                    .font(TextStyle::Monospace)
                                    .desired_width(f32::INFINITY)
                                    .desired_rows(30),
                            );
                            if resp.changed() { self.explorer_dirty = true; }
                        });
                    }
                }
            });
        });
        if ui.input(|i| i.modifiers.command && i.key_pressed(egui::Key::S)) && self.explorer_dirty { self.save_file(); }
    }

    fn page_tools(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let tools = self.all_tools();
        let studio_tools = tools.iter().filter(|x| x.engine == "roblox").count();
        ui.horizontal(|ui| {
            ui.add(egui::TextEdit::singleline(&mut self.tool_query).hint_text("Search tools…").desired_width(280.0));
            for (f, label) in [(ToolFilter::All, "All"), (ToolFilter::Roblox, "Roblox Studio"), (ToolFilter::Local, "Local filesystem")] {
                if ui.selectable_label(self.tool_filter == f, label).clicked() { self.tool_filter = f; }
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if pill(ui, t, "Refresh Studio tools", false).clicked() { self.send(UiCommand::RestartMcp, "Refreshing Studio MCP tools"); }
                ui.label(RichText::new(format!("{} tools · {} Studio · {} local", tools.len(), studio_tools, self.local_tools.len())).color(t.muted));
            });
        });
        ui.add_space(8.0);
        if studio_tools == 0 {
            let frame = egui::Frame::none().fill(t.warn.linear_multiply(0.12)).stroke(Stroke::new(1.0, t.warn)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(10.0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(RichText::new("Studio tools appear once the MCP helper is linked: open Roblox Studio -> Assistant -> Manage MCP Servers -> Enable Studio as MCP server, then press Refresh Studio tools.").color(t.text));
            });
            ui.add_space(8.0);
        }
        let q = self.tool_query.trim().to_lowercase();
        let filtered: Vec<ToolInfo> = tools.iter().filter(|tool| {
            let engine_ok = match self.tool_filter { ToolFilter::All => true, ToolFilter::Roblox => tool.engine == "roblox", ToolFilter::Local => tool.engine == "local" };
            engine_ok && (q.is_empty() || tool.name.to_lowercase().contains(&q) || tool.description.to_lowercase().contains(&q))
        }).cloned().collect();

        let selected = self.selected_tool.clone();
        let panel_open = selected.is_some();
        let avail = ui.available_height();
        ui.horizontal_top(|ui| {
            let grid_width = if panel_open { (ui.available_width() - 400.0).max(320.0) } else { ui.available_width() };
            ui.allocate_ui_with_layout(Vec2::new(grid_width, avail), Layout::top_down(Align::Min), |ui| {
                let mut pick: Option<(String, String)> = None;
                egui::ScrollArea::vertical().id_salt("tools").auto_shrink([false, false]).show(ui, |ui| {
                    let width = ui.available_width();
                    let cols = if width > 1000.0 { 3 } else if width > 640.0 { 2 } else { 1 };
                    for row in filtered.chunks(cols) {
                        ui.columns(cols, |cs| {
                            for (i, tool) in row.iter().enumerate() {
                                let is_sel = selected.as_ref().map(|(e, n)| e == tool.engine && n == &tool.name).unwrap_or(false);
                                let frame = egui::Frame::none()
                                    .fill(if is_sel { t.panel2 } else { t.panel })
                                    .stroke(Stroke::new(1.0, if is_sel { t.accent } else { t.border }))
                                    .rounding(Rounding::same(12.0))
                                    .inner_margin(Margin::same(12.0));
                                let resp = frame.show(&mut cs[i], |ui| {
                                    ui.set_width(ui.available_width());
                                    ui.horizontal(|ui| {
                                        ui.label(RichText::new(&tool.name).monospace().strong().color(t.text));
                                        tag(ui, if tool.engine == "roblox" { "studio" } else { "local" }, if tool.engine == "roblox" { t.accent } else { t.info });
                                    });
                                    ui.label(RichText::new(truncate(&tool.description, 180)).small().color(t.muted));
                                    if !tool.params.is_empty() {
                                        ui.horizontal_wrapped(|ui| {
                                            for (p, req) in &tool.params {
                                                tag(ui, &format!("{p}{}", if *req { "*" } else { "" }), if *req { t.border2 } else { t.border });
                                            }
                                        });
                                    }
                                }).response.interact(Sense::click());
                                if resp.hovered() { cs[i].output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
                                if resp.clicked() { pick = Some((tool.engine.to_string(), tool.name.clone())); }
                            }
                        });
                    }
                    if filtered.is_empty() { ui.label(RichText::new("No tools match.").color(t.muted)); }
                });
                if let Some((engine, name)) = pick {
                    if self.selected_tool.as_ref() != Some(&(engine.clone(), name.clone())) {
                        self.run_args = default_args_for(&tools, &name);
                        self.run_output.clear();
                    }
                    self.selected_tool = Some((engine, name));
                }
            });
            if let Some((engine, name)) = selected {
                ui.add_space(10.0);
                let frame = egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0, t.border2)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(12.0));
                frame.show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.set_min_height(avail - 20.0);
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(&name).monospace().strong().color(t.accent));
                        tag(ui, if engine == "roblox" { "studio" } else { "local" }, if engine == "roblox" { t.accent } else { t.info });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if ui.small_button("Close").clicked() { self.selected_tool = None; }
                        });
                    });
                    if let Some(tool) = tools.iter().find(|x| x.name == name && x.engine == engine) {
                        ui.add(egui::Label::new(RichText::new(&tool.description).small().color(t.muted)).wrap());
                        if !tool.params.is_empty() {
                            ui.label(RichText::new(format!("Parameters: {}", tool.params.iter().map(|(p, r)| if *r { format!("{p}*") } else { p.clone() }).collect::<Vec<_>>().join(", "))).small().color(t.muted));
                        }
                    }
                    ui.add_space(4.0);
                    ui.label(RichText::new("Arguments (JSON)").small().strong().color(t.muted));
                    ui.add(egui::TextEdit::multiline(&mut self.run_args).code_editor().font(TextStyle::Monospace).desired_rows(6).desired_width(f32::INFINITY));
                    ui.horizontal(|ui| {
                        let running = self.run_job.is_some();
                        if ui.add_enabled(!running, pill_widget(t, if running { "Running…" } else { "Run tool" }, true)).clicked() {
                            let raw: &str = if self.run_args.trim().is_empty() { "{}" } else { self.run_args.as_str() };
                            match serde_json::from_str::<serde_json::Value>(raw) {
                                Ok(args) => {
                                    self.run_output.clear();
                                    self.run_job = self.start_tool(&engine, &name, args);
                                }
                                Err(e) => self.run_output = format!("[ERROR] arguments are not valid JSON: {e}"),
                            }
                        }
                        if ui.button("Reset args").clicked() { self.run_args = default_args_for(&tools, &name); }
                        if !self.run_output.is_empty() && ui.button("Copy output").clicked() {
                            let text = self.run_output.clone();
                            ui.output_mut(|o| o.copied_text = text);
                        }
                        if let Some(run) = &self.run_job { ui.label(RichText::new(format!("{:.1}s", run.started.elapsed().as_secs_f32())).color(t.muted)); }
                    });
                    ui.add_space(4.0);
                    ui.label(RichText::new("Output").small().strong().color(t.muted));
                    egui::ScrollArea::vertical().id_salt("tool-output").auto_shrink([false, false]).show(ui, |ui| {
                        if self.run_output.is_empty() {
                            ui.label(RichText::new(if self.run_job.is_some() { "Waiting for the bridge…" } else { "Tool output appears here." }).color(t.muted));
                        } else {
                            ui.add(egui::Label::new(RichText::new(&self.run_output).monospace().color(t.text)).wrap());
                        }
                    });
                });
            }
        });
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
            let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(14.0));
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
                        if ui.add_enabled(studio_proc, egui::Button::new(RichText::new(if armed { "Confirm: kill Studio" } else { "Kill Roblox Studio" }).color(t.bad))).clicked() {
                            if armed { self.kill_armed = None; self.send(UiCommand::KillStudio, "Killing Roblox Studio processes"); } else { self.kill_armed = Some(Instant::now()); }
                        }
                    });
                });
                egui::Grid::new("studio-grid").num_columns(2).spacing([16.0, 4.0]).show(ui, |ui| {
                    ui.label(RichText::new("Helper process").color(t.muted)); ui.label(if mcp { "running (stdio JSON-RPC)" } else { "not running" }); ui.end_row();
                    ui.label(RichText::new("Studio process").color(t.muted)); ui.label(if studio_proc { "RobloxStudio detected" } else { "not detected" }); ui.end_row();
                    ui.label(RichText::new("Place link").color(t.muted)); ui.label(if studio_link { "connected — get_studio_state answers" } else { "not linked" }); ui.end_row();
                    ui.label(RichText::new("Tools").color(t.muted)); ui.label(format!("{roblox_tools}")); ui.end_row();
                    ui.label(RichText::new("Launcher").color(t.muted)); ui.label(RichText::new(mcp_launcher_display()).monospace()); ui.end_row();
                });
                ui.horizontal_wrapped(|ui| {
                    if ui.small_button("Open launcher folder").clicked() {
                        if let Some(local) = std::env::var_os("LOCALAPPDATA") { open_external(&PathBuf::from(local).join("Roblox").to_string_lossy()); }
                    }
                    if ui.small_button("Change launcher…").clicked() { self.page = Page::Settings; }
                    if ui.small_button("Browse Studio tools").clicked() { self.tool_filter = ToolFilter::Roblox; self.page = Page::Tools; }
                });
                if !studio_link {
                    ui.add_space(4.0);
                    ui.label(RichText::new("To link: open a place in Roblox Studio -> Assistant -> Manage MCP Servers -> Enable Studio as MCP server, then press Probe.").small().color(t.muted));
                }
            });
            ui.add_space(8.0);

            // Local filesystem
            let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(14.0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                let ready = s.workspace_ready.load(Ordering::Relaxed);
                ui.horizontal(|ui| {
                    status_dot(ui, if ready { t.ok } else { t.bad });
                    ui.label(RichText::new("Local filesystem (AgentScript)").size(16.0).strong().color(t.text));
                    tag(ui, "local", t.info);
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if pill(ui, t, "Open folder", false).clicked() { open_external(&s.root()); }
                        if pill(ui, t, "Change workspace…", false).clicked() { self.page = Page::Settings; }
                        if pill(ui, t, "Explorer", false).clicked() { self.page = Page::Explorer; }
                    });
                });
                egui::Grid::new("local-grid").num_columns(2).spacing([16.0, 4.0]).show(ui, |ui| {
                    ui.label(RichText::new("Root").color(t.muted)); ui.label(RichText::new(s.root()).monospace()); ui.end_row();
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
            let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(14.0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(RichText::new("Extension channels").size(16.0).strong().color(t.text));
                ui.add_space(4.0);
                let rc = s.roblox_clients.load(Ordering::Relaxed);
                let lc = s.local_clients.load(Ordering::Relaxed);
                egui::Grid::new("channels-grid").num_columns(3).spacing([16.0, 4.0]).show(ui, |ui| {
                    ui.label(RichText::new("HTTP").color(t.muted)); ui.label(RichText::new("http://127.0.0.1:3000").monospace()); ui.label("status / connect / push / result / ws"); ui.end_row();
                    ui.label(RichText::new("WS roblox").color(t.muted)); ui.label(RichText::new("ws://127.0.0.1:17613").monospace()); ui.label(if rc > 0 { format!("{rc} connected") } else { "no extension connected".to_string() }); ui.end_row();
                    ui.label(RichText::new("WS local").color(t.muted)); ui.label(RichText::new("ws://127.0.0.1:17615").monospace()); ui.label(if lc > 0 { format!("{lc} connected") } else { "no extension connected".to_string() }); ui.end_row();
                });
                ui.horizontal_wrapped(|ui| {
                    if ui.small_button("Open status JSON").clicked() { open_external("http://127.0.0.1:3000/api/status"); }
                    if ui.small_button("Copy endpoints").clicked() {
                        ui.output_mut(|o| o.copied_text = "http://127.0.0.1:3000\nws://127.0.0.1:17613\nws://127.0.0.1:17615".to_string());
                        self.toast("Endpoints copied", true);
                    }
                });
                ui.label(RichText::new("Custom MCP servers are not proxied by the native bridge; the extension receives UNSUPPORTED_BRIDGE_OPERATION for add_server/remove_server and falls back gracefully.").small().color(t.muted));
            });
        });
    }

    fn page_terminal(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let avail = ui.available_height();
        let studio_link = self.shared.studio_connected.load(Ordering::Relaxed);
        ui.columns(2, |cols| {
            // console
            {
                let ui = &mut cols[0];
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Bridge console").strong().color(t.text));
                    for (lvl, label) in [(0u8, "all"), (1, "info+"), (2, "warn+"), (3, "error")] {
                        if ui.selectable_label(self.log_level == lvl, label).clicked() { self.log_level = lvl; }
                    }
                    ui.add(egui::TextEdit::singleline(&mut self.log_query).hint_text("filter…").desired_width(110.0));
                    if ui.small_button("Clear").clicked() { self.shared.clear_logs(); }
                    if ui.small_button("Copy").clicked() {
                        let text = self.shared.logs.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect::<Vec<_>>().join("\n");
                        ui.output_mut(|o| o.copied_text = text);
                    }
                    if ui.small_button("Log file").clicked() { open_external(&log_path().to_string_lossy()); }
                });
                let frame = egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(8.0));
                frame.show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.set_min_height(avail - 50.0);
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
            // runner
            {
                let ui = &mut cols[1];
                ui.horizontal(|ui| {
                    for (mode, label) in [(RunnerMode::Command, "Workspace command"), (RunnerMode::Luau, "Luau in Studio")] {
                        if ui.selectable_label(self.runner_mode == mode, RichText::new(label).strong()).clicked() { self.runner_mode = mode; }
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if ui.small_button("Clear output").clicked() { self.term_output.clear(); }
                        match self.runner_mode {
                            RunnerMode::Command => { ui.label(RichText::new(format!("cwd {}", short_path(&self.shared.root(), 36))).monospace().small().color(t.muted)); }
                            RunnerMode::Luau => { status_dot(ui, if studio_link { t.ok } else { t.muted }); ui.label(RichText::new(if studio_link { "Studio linked" } else { "Studio not linked" }).small().color(t.muted)); }
                        }
                    });
                });
                let frame = egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(8.0));
                frame.show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.set_min_height(avail - 50.0);
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
            let resp = ui.add(egui::TextEdit::singleline(&mut self.term_cmd).hint_text("dir, git status, npm test …").font(TextStyle::Monospace).desired_width(ui.available_width() - 70.0));
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
            if ui.add_enabled(self.term_run.is_none(), egui::Button::new("Run")).clicked() { submit = true; }
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
            ui.label(RichText::new("Runs through the local engine's run_command — Enter to run, Up/Down for history, 60 s default timeout, sandboxed unless FULL PC ACCESS.").small().color(t.muted));
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
            if ui.button("Copy").clicked() { let c = self.luau_code.clone(); ui.output_mut(|o| o.copied_text = c); }
            if let Some(job) = &self.luau_run { ui.label(RichText::new(format!("{:.1}s", job.started.elapsed().as_secs_f32())).small().color(t.muted)); }
            ui.label(RichText::new("execute_luau · Edit DataModel · print() output comes back below").small().color(t.muted));
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

    fn page_updates(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(14.0));
        frame.show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                self.logo_mark(ui, 44.0);
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 2.0;
                    ui.label(RichText::new(format!("ORscript Desktop {}", env!("CARGO_PKG_VERSION"))).size(18.0).strong().color(t.text));
                    ui.label(RichText::new(format!("Rust {} build · {} {} · bridge protocol compatible with or-core 1.18", if cfg!(debug_assertions) { "debug" } else { "release" }, std::env::consts::OS, std::env::consts::ARCH)).color(t.muted));
                });
            });
            ui.add_space(8.0);
            ui.horizontal_wrapped(|ui| {
                let checking = self.update_rx.is_some();
                if ui.add_enabled(!checking, pill_widget(t, if checking { "Checking…" } else { "Check GitHub releases" }, true)).clicked() {
                    let (tx, rx) = std::sync::mpsc::channel();
                    if self.cmd_tx.send(UiCommand::CheckUpdates { reply: tx }).is_ok() { self.update_rx = Some(rx); }
                }
                if pill(ui, t, "Open releases page", false).clicked() { open_external(&format!("https://github.com/{REPO}/releases")); }
                if pill(ui, t, "Open repository", false).clicked() { open_external(&format!("https://github.com/{REPO}")); }
            });
            if let Some(u) = &self.update {
                ui.add_space(8.0);
                let (color, headline) = if !u.ok { (t.warn, "Could not check".to_string()) } else if u.up_to_date { (t.ok, "You are up to date".to_string()) } else { (t.accent, format!("Update available: {}", u.latest)) };
                ui.horizontal(|ui| { status_dot(ui, color); ui.label(RichText::new(headline).strong().color(t.text)); });
                ui.label(RichText::new(&u.message).small().color(t.muted));
                if u.ok && !u.up_to_date && pill(ui, t, "Download", true).clicked() { open_external(&u.url); }
            }
        });
        ui.add_space(10.0);
        let frame = egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(14.0));
        frame.show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(RichText::new("Build from source").strong().color(t.text));
            ui.label(RichText::new("cd ORscript\\agent && cargo build --release   ->   target\\release\\or-core.exe").monospace().color(t.muted));
            ui.label(RichText::new("Copy the binary over ORscript\\bin\\or-core.exe (or run Build-ORscript-Desktop.cmd). The extension needs no change; it only talks to the ports.").small().color(t.muted));
            ui.add_space(6.0);
            ui.label(RichText::new("Keyboard").strong().color(t.text));
            ui.label(RichText::new("Ctrl+1…7 pages · Ctrl+R restart MCP helper · F5 probe Studio + refresh explorer · Ctrl+Shift+S capture Studio viewport · Ctrl+S save file · Ctrl+Enter run Luau").small().color(t.muted));
        });
    }

    fn page_settings(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let mut save = false;
        let mut retheme = false;
        egui::ScrollArea::vertical().id_salt("settings").auto_shrink([false, false]).show(ui, |ui| {
            settings_section(ui, t, "Appearance", |ui| {
                ui.horizontal(|ui| {
                    ui.label("Theme");
                    for (id, label) in [("gold", "ORscript Gold"), ("emerald", "Emerald"), ("graphite", "Graphite")] {
                        if ui.selectable_label(self.settings.theme == id, label).clicked() { self.settings.theme = id.into(); retheme = true; save = true; }
                    }
                });
                if ui.checkbox(&mut self.settings.compact, "Compact density").changed() { retheme = true; save = true; }
            });
            settings_section(ui, t, "Behaviour", |ui| {
                if ui.checkbox(&mut self.settings.close_to_tray, "Keep running in the notification area when the window is closed").changed() { save = true; }
                if ui.checkbox(&mut self.settings.start_hidden, "Start hidden in the notification area").changed() { save = true; }
                #[cfg(windows)]
                if ui.checkbox(&mut self.settings.launch_at_login, "Launch at Windows sign-in (hidden)").changed() {
                    match set_launch_at_login(self.settings.launch_at_login) {
                        Ok(()) => save = true,
                        Err(e) => { self.settings.launch_at_login = !self.settings.launch_at_login; self.settings_note = format!("Autostart failed: {e}"); }
                    }
                }
                #[cfg(not(windows))]
                ui.label(RichText::new("Launch at sign-in is available on Windows.").small().color(t.muted));
            });
            settings_section(ui, t, "Workspace", |ui| {
                ui.label(RichText::new(format!("Active root: {}", self.shared.root())).monospace().color(t.muted));
                ui.horizontal(|ui| {
                    ui.add(egui::TextEdit::singleline(&mut self.draft_workspace).hint_text("C:\\Users\\you\\ORWorkspace").desired_width(420.0).font(TextStyle::Monospace));
                    let picking = self.picker_rx.is_some();
                    if ui.add_enabled(!picking, egui::Button::new(if picking { "Choosing…" } else { "Browse…" })).clicked() {
                        self.picker_rx = Some(pick_folder(&self.draft_workspace));
                    }
                    let switching = self.workspace_rx.is_some();
                    let changed = self.draft_workspace.trim() != self.shared.root() && !self.draft_workspace.trim().is_empty();
                    if ui.add_enabled(changed && !switching, pill_widget(t, if switching { "Switching…" } else { "Apply" }, true)).clicked() {
                        let (tx, rx) = std::sync::mpsc::channel();
                        if self.cmd_tx.send(UiCommand::SetWorkspace { path: self.draft_workspace.trim().to_string(), reply: tx }).is_ok() { self.workspace_rx = Some(rx); }
                    }
                    if ui.button("Open").clicked() { open_external(&self.shared.root()); }
                });
                ui.label(RichText::new("Applies immediately to the AgentScript engine and the Explorer, and is remembered for the next start. --workspace and OR_WORKSPACE_ROOT still win when given.").small().color(t.muted));
                let mut full = self.shared.full_access();
                if ui.checkbox(&mut full, "FULL PC ACCESS (absolute paths, process_kill, cd anywhere) — applies immediately and on next start").changed() {
                    self.settings.full_access = full;
                    save = true;
                    let _ = self.cmd_tx.send(UiCommand::SetFullAccess(full));
                }
            });
            settings_section(ui, t, "Roblox Studio MCP", |ui| {
                ui.label(RichText::new(format!("Active launcher: {}", mcp_launcher_display())).monospace().color(t.muted));
                ui.horizontal(|ui| {
                    ui.add(egui::TextEdit::singleline(&mut self.draft_mcp).hint_text("empty = %LOCALAPPDATA%\\Roblox\\mcp.bat").desired_width(420.0).font(TextStyle::Monospace));
                    if pill(ui, t, "Apply & restart helper", true).clicked() {
                        self.settings.mcp_command = self.draft_mcp.trim().to_string();
                        save = true;
                        let cmd = self.settings.mcp_command.clone();
                        let _ = self.cmd_tx.send(UiCommand::SetMcpCommand(cmd));
                        self.send(UiCommand::RestartMcp, "Launcher updated — restarting Studio MCP helper");
                    }
                    if ui.button("Use default").clicked() { self.draft_mcp.clear(); }
                });
                ui.label(RichText::new("A custom launcher is any command that speaks MCP over stdio (for example a different mcp.bat or a wrapper script). OR_MCP_COMMAND in the environment still takes precedence at start.").small().color(t.muted));
            });
            settings_section(ui, t, "Diagnostics", |ui| {
                let s = &self.shared;
                egui::Grid::new("diag-grid").num_columns(2).spacing([16.0, 4.0]).show(ui, |ui| {
                    ui.label(RichText::new("Version").color(t.muted)); ui.label(format!("ORscript Desktop {} ({} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH)); ui.end_row();
                    ui.label(RichText::new("Uptime").color(t.muted)); ui.label(human_duration(s.boot.elapsed())); ui.end_row();
                    ui.label(RichText::new("Settings file").color(t.muted)); ui.label(RichText::new(Settings::path().to_string_lossy().to_string()).monospace()); ui.end_row();
                    ui.label(RichText::new("Log file").color(t.muted)); ui.label(RichText::new(log_path().to_string_lossy().to_string()).monospace()); ui.end_row();
                    ui.label(RichText::new("Ports").color(t.muted)); ui.label("http 3000 · ws 17613 roblox · ws 17615 local"); ui.end_row();
                });
                ui.horizontal_wrapped(|ui| {
                    if pill(ui, t, "Copy diagnostics", false).clicked() {
                        let text = self.diagnostics_text();
                        ui.output_mut(|o| o.copied_text = text);
                        self.toast("Diagnostics copied", true);
                    }
                    if ui.button("Open log file").clicked() { open_external(&log_path().to_string_lossy()); }
                    if ui.button("Open settings.json").clicked() { open_external(&Settings::path().to_string_lossy()); }
                    if ui.button("Reset settings").clicked() {
                        let keep_ws = self.settings.workspace_root.clone();
                        self.settings = Settings { workspace_root: keep_ws, ..Settings::default() };
                        self.draft_mcp.clear();
                        retheme = true; save = true;
                        self.settings_note = "Settings reset to defaults (workspace kept).".into();
                    }
                    if ui.button(RichText::new("Quit ORscript (stop bridge)").color(t.bad)).clicked() { self.quit_now = true; ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close); }
                });
            });
            if !self.settings_note.is_empty() {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(&self.settings_note).color(t.warn));
                    if ui.small_button("dismiss").clicked() { self.settings_note.clear(); }
                });
            }
        });
        if retheme { self.theme = Theme::by_id(&self.settings.theme); self.theme.apply(ui.ctx(), self.settings.compact); }
        if save {
            match self.settings.save() { Ok(()) => self.toast("Settings saved", true), Err(e) => self.toast(format!("Could not save settings: {e}"), false) }
        }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if self.first_frame {
            self.first_frame = false;
            #[cfg(windows)]
            if self.start_hidden {
                if let Some(hwnd) = crate::agent_window() { crate::hide_agent_window(hwnd); }
                self.shared.track("app", "started hidden in the notification area");
            }
            let _ = self.start_hidden;
        }
        self.poll_async(ctx);
        self.handle_shortcuts(ctx);
        self.handle_close(ctx);
        self.update_tray();

        self.titlebar(ctx);
        self.sidebar(ctx);
        let t = self.theme;
        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(t.bg).inner_margin(Margin::symmetric(22.0, 18.0)))
            .show(ctx, |ui| {
                self.page_header(ui);
                match self.page {
                    Page::Home => self.page_home(ui),
                    Page::Explorer => self.page_explorer(ui),
                    Page::Tools => self.page_tools(ui),
                    Page::Servers => self.page_servers(ui),
                    Page::Terminal => self.page_terminal(ui),
                    Page::Updates => self.page_updates(ui),
                    Page::Settings => self.page_settings(ui),
                }
            });

        // Toast
        if let Some((text, at, ok)) = self.toast.clone() {
            if at.elapsed() < Duration::from_secs(3) {
                egui::Area::new(egui::Id::new("toast"))
                    .anchor(egui::Align2::RIGHT_BOTTOM, Vec2::new(-20.0, -20.0))
                    .show(ctx, |ui| {
                        let color = if ok { t.ok } else { t.bad };
                        egui::Frame::none().fill(t.panel2).stroke(Stroke::new(1.0, color)).rounding(Rounding::same(10.0)).inner_margin(Margin::symmetric(14.0, 10.0)).show(ui, |ui| {
                            ui.horizontal(|ui| { status_dot(ui, color); ui.label(RichText::new(text).color(t.text)); });
                        });
                    });
            } else {
                self.toast = None;
            }
        }
        let busy = self.run_job.is_some() || self.term_run.is_some() || self.luau_run.is_some() || self.update_rx.is_some()
            || self.snapshot_run.is_some() || self.picker_rx.is_some() || self.workspace_rx.is_some();
        ctx.request_repaint_after(Duration::from_millis(if busy { 120 } else { 700 }));
    }
}

// ───────────────────────────── widgets ─────────────────────────────

fn status_dot(ui: &mut egui::Ui, color: Color32) {
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(10.0), Sense::hover());
    ui.painter().circle_filled(rect.center(), 4.0, color);
    ui.painter().circle_stroke(rect.center(), 5.5, Stroke::new(1.0, color.linear_multiply(0.35)));
}

fn tag(ui: &mut egui::Ui, text: &str, color: Color32) {
    let frame = egui::Frame::none().fill(color.linear_multiply(0.18)).stroke(Stroke::new(1.0, color.linear_multiply(0.6))).rounding(Rounding::same(999.0)).inner_margin(Margin::symmetric(7.0, 2.0));
    frame.show(ui, |ui| { ui.label(RichText::new(text).small().color(color)); });
}

fn pill_widget(t: Theme, text: &str, primary: bool) -> egui::Button<'static> {
    if primary {
        egui::Button::new(RichText::new(text).strong().color(t.accent_ink)).fill(t.accent).stroke(Stroke::new(1.0, t.accent2)).rounding(Rounding::same(999.0))
    } else {
        egui::Button::new(RichText::new(text).color(t.text)).fill(t.panel2).stroke(Stroke::new(1.0, t.border2)).rounding(Rounding::same(999.0))
    }
}

fn pill(ui: &mut egui::Ui, t: Theme, text: &str, primary: bool) -> egui::Response {
    let resp = ui.add(pill_widget(t, text, primary));
    if resp.hovered() { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
    resp
}

#[derive(Clone, Copy)]
enum WinGlyph { Minimize, Maximize, Close }

fn window_button(ui: &mut egui::Ui, glyph: WinGlyph, color: Color32, t: Theme) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(34.0, 26.0), Sense::click());
    if resp.hovered() {
        ui.painter().rect_filled(rect, Rounding::same(6.0), t.panel2);
        ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand);
    }
    let c = rect.center();
    let stroke = Stroke::new(1.4, if resp.hovered() { color } else { t.muted });
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

fn settings_section(ui: &mut egui::Ui, t: Theme, title: &str, add: impl FnOnce(&mut egui::Ui)) {
    let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0, t.border)).rounding(Rounding::same(12.0)).inner_margin(Margin::same(14.0));
    frame.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.label(RichText::new(title).size(16.0).strong().color(t.text));
        ui.add_space(6.0);
        add(ui);
    });
    ui.add_space(10.0);
}

/// Simple vector icons for the navigation (no emoji fonts needed).
fn nav_icon(p: &egui::Painter, r: egui::Rect, page: Page, c: Color32) {
    let s = Stroke::new(1.6, c);
    let (l, top, w, h) = (r.left(), r.top(), r.width(), r.height());
    let pt = |x: f32, y: f32| egui::pos2(l + x * w, top + y * h);
    match page {
        Page::Home => {
            p.line_segment([pt(0.1, 0.5), pt(0.5, 0.12)], s);
            p.line_segment([pt(0.5, 0.12), pt(0.9, 0.5)], s);
            p.rect_stroke(egui::Rect::from_min_max(pt(0.22, 0.48), pt(0.78, 0.92)), Rounding::same(1.5), s);
        }
        Page::Explorer => {
            p.rect_stroke(egui::Rect::from_min_max(pt(0.08, 0.25), pt(0.92, 0.88)), Rounding::same(2.0), s);
            p.line_segment([pt(0.08, 0.25), pt(0.4, 0.12)], s);
            p.line_segment([pt(0.4, 0.12), pt(0.5, 0.25)], s);
        }
        Page::Tools => {
            p.line_segment([pt(0.2, 0.8), pt(0.7, 0.3)], Stroke::new(2.4, c));
            p.circle_stroke(pt(0.72, 0.28), w * 0.2, s);
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
        Page::Updates => {
            p.circle_stroke(pt(0.5, 0.5), w * 0.38, s);
            p.line_segment([pt(0.5, 0.72), pt(0.5, 0.3)], s);
            p.line_segment([pt(0.5, 0.3), pt(0.34, 0.46)], s);
            p.line_segment([pt(0.5, 0.3), pt(0.66, 0.46)], s);
        }
        Page::Settings => {
            p.circle_stroke(pt(0.5, 0.5), w * 0.36, Stroke::new(2.2, c));
            p.circle_stroke(pt(0.5, 0.5), w * 0.13, s);
        }
    }
}

// ───────────────────────────── utilities ─────────────────────────────

fn default_args_for(tools: &[ToolInfo], name: &str) -> String {
    let Some(tool) = tools.iter().find(|t| t.name == name) else { return "{}".into(); };
    if tool.params.is_empty() { return "{}".into(); }
    let mut map = serde_json::Map::new();
    for (p, req) in &tool.params {
        if *req { map.insert(p.clone(), serde_json::Value::String(String::new())); }
    }
    if name == "execute_luau" {
        map.insert("code".into(), serde_json::Value::String("print(\"hello from ORscript\")".into()));
        map.insert("datamodel_type".into(), serde_json::Value::String("Edit".into()));
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(map)).unwrap_or_else(|_| "{}".into())
}

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
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("logs").join("agent.log")))
        .unwrap_or_else(|| PathBuf::from("logs/agent.log"))
}

fn mcp_launcher_display() -> String {
    std::env::var("OR_MCP_COMMAND")
        .ok()
        .or_else(|| std::env::var("ROBLOXSCRIPT_MCP_COMMAND").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "%LOCALAPPDATA%\\Roblox\\mcp.bat (Studio built-in)".to_string())
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
                "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose the ORscript workspace folder'; $d.ShowNewFolderButton = $true; if (Test-Path -LiteralPath '{}') {{ $d.SelectedPath = '{}' }}; if ($d.ShowDialog() -eq 'OK') {{ Write-Output $d.SelectedPath }}",
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
        #[cfg(not(windows))]
        {
            let _ = tx.send(if initial.trim().is_empty() { None } else { Some(initial) });
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
    #[cfg(all(unix, not(target_os = "macos")))]
    { let _ = std::process::Command::new("xdg-open").arg(target).spawn(); }
}

#[cfg(windows)]
fn set_launch_at_login(enable: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let output = if enable {
        std::process::Command::new("reg")
            .args(["add", key, "/v", "ORscript", "/t", "REG_SZ", "/d", &format!("\"{}\" --hidden", exe.display()), "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    } else {
        std::process::Command::new("reg")
            .args(["delete", key, "/v", "ORscript", "/f"])
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

/// Decode the bundled PNG logo into RGBA (window icon, tray icon, in-app logo).
fn load_logo() -> Option<(Vec<u8>, u32, u32)> {
    const PNG: &[u8] = include_bytes!("../../assets/icon.png");
    let icon = eframe::icon_data::from_png_bytes(PNG).ok()?;
    Some((icon.rgba, icon.width, icon.height))
}

/// Nearest-neighbour downscale for the notification-area icon.
#[cfg(windows)]
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

// ───────────────────────────── tray (Windows) ─────────────────────────────

#[cfg(windows)]
pub struct TrayState {
    icon: tray_icon::TrayIcon,
    _menu: tray_icon::menu::Menu,
    last_tooltip: String,
}

#[cfg(windows)]
fn build_tray(
    logo: Option<&(Vec<u8>, u32, u32)>,
    shared: Arc<UiShared>,
    cmd_tx: UnboundedSender<UiCommand>,
) -> anyhow::Result<TrayState> {
    use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let menu = Menu::new();
    let open = MenuItem::new("Open ORscript", true, None);
    let folder = MenuItem::new("Open workspace folder", true, None);
    let restart = MenuItem::new("Restart Studio MCP helper", true, None);
    let probe = MenuItem::new("Probe Studio", true, None);
    let kill = MenuItem::new("Kill Roblox Studio", true, None);
    let quit = MenuItem::new("Quit ORscript (stop bridge)", true, None);
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
        .with_tooltip("ORscript — bridge running")
        .with_menu_on_left_click(false);
    if let Some((rgba, w, h)) = logo {
        let small = downscale_rgba(rgba, *w, *h, 32);
        if let Ok(icon) = tray_icon::Icon::from_rgba(small, 32, 32) {
            builder = builder.with_icon(icon);
        }
    }
    let icon = builder.build()?;

    let ids = (open.id().clone(), folder.id().clone(), restart.id().clone(), probe.id().clone(), kill.id().clone(), quit.id().clone());
    let shared_menu = shared.clone();
    let tx_menu = cmd_tx.clone();
    std::thread::Builder::new().name("tray-menu".into()).spawn(move || {
        let receiver = MenuEvent::receiver();
        while let Ok(event) = receiver.recv() {
            if event.id == ids.0 {
                if let Some(hwnd) = crate::agent_window() { crate::show_agent_window(hwnd); }
            } else if event.id == ids.1 {
                open_external(&shared_menu.root());
            } else if event.id == ids.2 {
                let _ = tx_menu.send(UiCommand::RestartMcp);
            } else if event.id == ids.3 {
                let _ = tx_menu.send(UiCommand::ProbeStudio);
            } else if event.id == ids.4 {
                let _ = tx_menu.send(UiCommand::KillStudio);
            } else if event.id == ids.5 {
                shared_menu.quit_requested.store(true, Ordering::Relaxed);
                match crate::agent_window() {
                    Some(hwnd) => crate::close_agent_window(hwnd),
                    None => std::process::exit(0),
                }
            }
        }
    })?;
    std::thread::Builder::new().name("tray-click".into()).spawn(move || {
        let receiver = TrayIconEvent::receiver();
        while let Ok(event) = receiver.recv() {
            let show = match event {
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => true,
                TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => true,
                _ => false,
            };
            if show {
                if let Some(hwnd) = crate::agent_window() { crate::show_agent_window(hwnd); }
            }
        }
    })?;

    Ok(TrayState { icon, _menu: menu, last_tooltip: String::new() })
}

#[cfg(not(windows))]
pub struct TrayState;

#[cfg(not(windows))]
impl App {
    fn update_tray(&mut self) {}
}

#[cfg(windows)]
impl App {
    fn update_tray(&mut self) {
        let Some(tray) = self.tray.as_mut() else { return; };
        let s = &self.shared;
        let studio = if s.studio_connected.load(Ordering::Relaxed) { "Studio linked" }
            else if s.studio_running.load(Ordering::Relaxed) { "Studio open, MCP not linked" }
            else { "Studio closed" };
        let tooltip = format!("ORscript {} — {} · ext {}", env!("CARGO_PKG_VERSION"), studio, s.roblox_clients.load(Ordering::Relaxed) + s.local_clients.load(Ordering::Relaxed));
        if tooltip != tray.last_tooltip {
            let _ = tray.icon.set_tooltip(Some(tooltip.clone()));
            tray.last_tooltip = tooltip;
        }
    }
}

// ───────────────────────────── entry point ─────────────────────────────

/// Run the window on the calling (main) thread. Returns when the user quits.
pub fn run_gui(shared: Arc<UiShared>, cmd_tx: UnboundedSender<UiCommand>, settings: Settings, start_hidden: bool) -> anyhow::Result<()> {
    let logo = load_logo();
    let mut viewport = egui::ViewportBuilder::default()
        .with_title(WINDOW_TITLE)
        .with_app_id("orscript-desktop")
        .with_inner_size([1280.0, 820.0])
        .with_min_inner_size([960.0, 620.0])
        .with_decorations(false)
        .with_resizable(true)
        .with_visible(!start_hidden);
    if let Some((rgba, w, h)) = &logo {
        viewport = viewport.with_icon(egui::IconData { rgba: rgba.clone(), width: *w, height: *h });
    }
    let options = eframe::NativeOptions { viewport, centered: true, persist_window: false, ..Default::default() };

    #[cfg(windows)]
    let tray: Option<TrayState> = match build_tray(logo.as_ref(), shared.clone(), cmd_tx.clone()) {
        Ok(t) => Some(t),
        Err(e) => { shared.log(&format!("WARN tray icon unavailable: {e:#}")); None }
    };
    #[cfg(not(windows))]
    let tray: Option<TrayState> = None;

    shared.track("app", format!("ORscript Desktop {} window opened", env!("CARGO_PKG_VERSION")));
    let app_shared = shared.clone();
    eframe::run_native(
        APP_NAME,
        options,
        Box::new(move |cc| {
            Ok(Box::new(App::new(
                cc,
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
