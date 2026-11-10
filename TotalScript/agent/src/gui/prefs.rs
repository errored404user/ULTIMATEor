//! 2.11.0 Settings infrastructure: categories, search, per-category reset,
//! export / import (never with API keys), the Workspace Manager and the
//! sections that did not exist before (Integrations, Performance, Privacy,
//! Shortcuts, Advanced). The older section bodies stay in `page_settings`
//! and are gated by `settings_visible`.

use super::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum SettingsCat { General, Appearance, Workspace, Ai, Integrations, Performance, Privacy, Shortcuts, Advanced, About }

impl SettingsCat {
    pub const ALL: [SettingsCat; 10] = [
        SettingsCat::General, SettingsCat::Appearance, SettingsCat::Workspace, SettingsCat::Ai, SettingsCat::Integrations,
        SettingsCat::Performance, SettingsCat::Privacy, SettingsCat::Shortcuts, SettingsCat::Advanced, SettingsCat::About,
    ];
    pub fn title(self) -> &'static str {
        match self {
            SettingsCat::General => "General", SettingsCat::Appearance => "Appearance", SettingsCat::Workspace => "Workspace",
            SettingsCat::Ai => "AI chat", SettingsCat::Integrations => "Integrations", SettingsCat::Performance => "Performance",
            SettingsCat::Privacy => "Privacy", SettingsCat::Shortcuts => "Shortcuts", SettingsCat::Advanced => "Advanced", SettingsCat::About => "About",
        }
    }
    pub fn blurb(self) -> &'static str {
        match self {
            SettingsCat::General => "Startup, tray, dashboard", SettingsCat::Appearance => "Theme, accent, density", SettingsCat::Workspace => "Folders & reference library",
            SettingsCat::Ai => "Provider, key, model", SettingsCat::Integrations => "Studio MCP, plugin, extension", SettingsCat::Performance => "Motion, effects, logs",
            SettingsCat::Privacy => "What is stored where", SettingsCat::Shortcuts => "Every key the window handles", SettingsCat::Advanced => "Paths, reset, import / export", SettingsCat::About => "Version, donate, repository",
        }
    }
    pub fn icon(self) -> Icon {
        match self {
            SettingsCat::General => Icon::Gear, SettingsCat::Appearance => Icon::Palette, SettingsCat::Workspace => Icon::Folder, SettingsCat::Ai => Icon::Play,
            SettingsCat::Integrations => Icon::Pulse, SettingsCat::Performance => Icon::Refresh, SettingsCat::Privacy => Icon::Warn, SettingsCat::Shortcuts => Icon::Terminal,
            SettingsCat::Advanced => Icon::List, SettingsCat::About => Icon::Info,
        }
    }
}

/// Settings as written by Export: the same struct minus anything secret.
fn export_copy(s: &Settings) -> Settings {
    let mut c = s.clone();
    c.chat_keys.clear();
    c
}

impl App {
    /// A section is shown when it belongs to the current category (no search)
    /// or when the search text matches its title / keywords (any category).
    pub(super) fn settings_visible(&self, cat: SettingsCat, title: &str, keywords: &str) -> bool {
        let q = self.settings_query.trim().to_lowercase();
        if q.is_empty() { return self.settings_cat == cat; }
        let hay = format!("{} {} {}", cat.title(), title, keywords).to_lowercase();
        q.split_whitespace().all(|w| hay.contains(w))
    }

    /// Reset one category to defaults. Workspace folders are never reset
    /// from here (that is a destructive change to what the engine edits).
    pub(super) fn reset_settings_category(&mut self, cat: SettingsCat) -> &'static str {
        let d = Settings::default();
        let s = &mut self.settings;
        match cat {
            SettingsCat::General => { s.close_to_tray = d.close_to_tray; s.start_hidden = d.start_hidden; s.show_checklist = d.show_checklist; s.home_stats = d.home_stats; s.home_quick = d.home_quick; s.home_recent = d.home_recent; s.home_viewport = d.home_viewport; "General reset" }
            SettingsCat::Appearance => { s.theme = d.theme; s.accent = d.accent; s.corners = d.corners; s.ui_scale = d.ui_scale; s.compact = d.compact; s.sidebar_rail = d.sidebar_rail; s.sidebar_blurbs = d.sidebar_blurbs; s.glow = d.glow; "Appearance reset" }
            SettingsCat::Workspace => { "Workspace folders are not reset from here — use the Apply buttons" }
            SettingsCat::Ai => { s.chat_tools = d.chat_tools; s.chat_send_images = d.chat_send_images; s.chat_max_steps = d.chat_max_steps; s.chat_temperature = d.chat_temperature; s.chat_instructions = d.chat_instructions; s.chat_panel_width = d.chat_panel_width; "AI chat preferences reset (keys and models kept)" }
            SettingsCat::Integrations => { s.mcp_command = d.mcp_command; self.draft_mcp.clear(); let cmd = self.settings.mcp_command.clone(); let _ = self.cmd_tx.send(UiCommand::SetMcpCommand(cmd)); "MCP launcher reset to default (restart the helper to apply)" }
            SettingsCat::Performance => { s.motion = d.motion; s.backdrop = d.backdrop; s.glow = d.glow; "Performance reset" }
            SettingsCat::Privacy => { "Nothing to reset here" }
            SettingsCat::Shortcuts => { "Shortcuts are fixed in this version" }
            SettingsCat::Advanced => { s.recent_commands.clear(); "Recent commands cleared" }
            SettingsCat::About => { "Nothing to reset here" }
        }
    }

    pub(super) fn export_path() -> PathBuf { data_dir().join("settings.export.json") }

    /// Write `settings.export.json` next to settings.json and copy the same
    /// text to the clipboard. API keys are stripped.
    pub(super) fn export_settings(&mut self, ctx: &egui::Context) {
        let copy = export_copy(&self.settings);
        match serde_json::to_string_pretty(&copy) {
            Ok(text) => {
                let _ = std::fs::create_dir_all(data_dir());
                let path = Self::export_path();
                match std::fs::write(&path, &text) {
                    Ok(()) => { ctx.output_mut(|o| o.copied_text = text); self.settings_note = format!("Exported to {} (and copied) — API keys are not included", path.display()); self.toast("Settings exported", true); }
                    Err(e) => { self.settings_note = format!("Export failed: {e}"); self.toast("Export failed", false); }
                }
            }
            Err(e) => { self.settings_note = format!("Export failed: {e}"); }
        }
    }

    /// Read a settings JSON file, validate the values that can break the
    /// window, apply everything except workspace folders and keys.
    pub(super) fn import_settings(&mut self, path: &str, ctx: &egui::Context) {
        let path = path.trim();
        if path.is_empty() { self.settings_note = "Import: enter the path of a settings JSON file".into(); return; }
        let text = match std::fs::read_to_string(path) { Ok(t) => t, Err(e) => { self.settings_note = format!("Import failed: {e}"); return; } };
        let mut incoming: Settings = match serde_json::from_str(&text) { Ok(s) => s, Err(e) => { self.settings_note = format!("Import failed: not a settings file ({e})"); return; } };
        let mut fixes = Vec::new();
        if !(0.8..=1.5).contains(&incoming.ui_scale) { incoming.ui_scale = 1.0; fixes.push("ui_scale"); }
        if incoming.corners > 2 { incoming.corners = 1; fixes.push("corners"); }
        if !PALETTES.iter().any(|p| p.id == incoming.theme) { incoming.theme = "aqua".into(); fixes.push("theme"); }
        if !incoming.accent.is_empty() && parse_hex(&incoming.accent).is_none() { incoming.accent.clear(); fixes.push("accent"); }
        if incoming.chat_max_steps == 0 || incoming.chat_max_steps > 64 { incoming.chat_max_steps = 16; fixes.push("chat_max_steps"); }
        if !(0.0..=1.5).contains(&incoming.chat_temperature) { incoming.chat_temperature = 0.3; fixes.push("chat_temperature"); }
        if incoming.chat_panel_width < 280.0 || incoming.chat_panel_width > 900.0 { incoming.chat_panel_width = 400.0; fixes.push("chat_panel_width"); }
        // Keep what must not change silently: folders, keys, window size, launcher.
        incoming.workspace_root = self.settings.workspace_root.clone();
        incoming.reference_dir = self.settings.reference_dir.clone();
        incoming.chat_keys = self.settings.chat_keys.clone();
        incoming.window_width = self.settings.window_width;
        incoming.window_height = self.settings.window_height;
        incoming.mcp_command = self.settings.mcp_command.clone();
        incoming.full_access = self.settings.full_access;
        incoming.launch_at_login = self.settings.launch_at_login;
        self.settings = incoming;
        self.retheme(ctx);
        match self.settings.save() {
            Ok(()) => { self.settings_note = if fixes.is_empty() { "Settings imported (folders, keys, launcher and autostart kept as they were)".into() } else { format!("Settings imported; out-of-range values reset: {}", fixes.join(", ")) }; self.toast("Settings imported", true); }
            Err(e) => { self.settings_note = format!("Imported but could not save: {e}"); }
        }
    }

    pub(super) fn remember_workspace(&mut self, path: &str) {
        let p = path.trim().to_string();
        if p.is_empty() { return; }
        self.settings.recent_workspaces.retain(|x| x != &p);
        self.settings.recent_workspaces.insert(0, p);
        self.settings.recent_workspaces.truncate(8);
    }

    fn switch_workspace(&mut self, path: &str) {
        if self.workspace_rx.is_some() { return; }
        let (tx, rx) = std::sync::mpsc::channel();
        self.draft_workspace = path.to_string();
        if self.cmd_tx.send(UiCommand::SetWorkspace { path: path.to_string(), reply: tx }).is_ok() { self.workspace_rx = Some(rx); }
    }

    /// Workspace Manager: current, favourites, recents — switch, star, remove, open.
    pub(super) fn workspace_manager(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let current = self.shared.root();
        let switching = self.workspace_rx.is_some();
        let mut switch: Option<String> = None;
        let mut star: Option<String> = None;
        let mut forget: Option<String> = None;
        let mut open: Option<String> = None;
        let favs = self.settings.favorite_workspaces.clone();
        let mut rows: Vec<(String, bool)> = favs.iter().map(|p| (p.clone(), true)).collect();
        for p in &self.settings.recent_workspaces { if !favs.contains(p) { rows.push((p.clone(), false)); } }
        if !current.is_empty() && !rows.iter().any(|(p, _)| *p == current) { rows.insert(0, (current.clone(), favs.contains(&current))); }
        ui.label(RichText::new("Workspaces").strong().color(t.text));
        ui.label(RichText::new("Every folder you applied is remembered here; star the ones you switch to often. Switching re-points the AgentScript engine and the Explorer immediately.").small().color(t.muted));
        ui.add_space(4.0);
        if rows.is_empty() { ui.label(RichText::new("No workspaces yet — apply a folder above.").small().color(t.muted)); }
        for (path, fav) in rows {
            let is_current = path == current;
            let exists = Path::new(&path).is_dir();
            let frame = egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, if is_current { alpha(t.accent, 150) } else { t.border })).rounding(Rounding::same(t.r_card)).inner_margin(Margin::symmetric(10.0, 6.0));
            frame.show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    if icon_button(ui, t, if fav { Icon::StarFilled } else { Icon::Star }, if fav { "Remove from favourites" } else { "Add to favourites" }, fav).clicked() { star = Some(path.clone()); }
                    ui.vertical(|ui| {
                        ui.spacing_mut().item_spacing.y = 0.0;
                        ui.add(egui::Label::new(RichText::new(short_path(&path, 70)).monospace().color(if exists { t.text } else { t.muted })).truncate());
                        ui.label(RichText::new(if is_current { "current" } else if !exists { "folder missing" } else if fav { "favourite" } else { "recent" }).small().color(if is_current { t.accent } else if !exists { t.warn } else { t.muted }));
                    });
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if !is_current && icon_button(ui, t, Icon::Close, "Forget this entry", false).clicked() { forget = Some(path.clone()); }
                        if icon_button(ui, t, Icon::Folder, "Open in the file manager", false).clicked() { open = Some(path.clone()); }
                        if !is_current && ui.add_enabled(exists && !switching, pill_widget(t, if switching { "Switching…" } else { "Switch" }, false)).clicked() { switch = Some(path.clone()); }
                    });
                });
            });
            ui.add_space(4.0);
        }
        if let Some(p) = star {
            if let Some(i) = self.settings.favorite_workspaces.iter().position(|x| *x == p) { self.settings.favorite_workspaces.remove(i); } else { self.settings.favorite_workspaces.insert(0, p); }
            let _ = self.settings.save();
        }
        if let Some(p) = forget { self.settings.recent_workspaces.retain(|x| *x != p); self.settings.favorite_workspaces.retain(|x| *x != p); let _ = self.settings.save(); }
        if let Some(p) = open { open_external(&p); }
        if let Some(p) = switch { self.switch_workspace(&p); }
    }

    /// General › Dashboard: which cards Home shows.
    pub(super) fn dashboard_prefs(&mut self, ui: &mut egui::Ui) -> bool {
        let t = self.theme;
        let mut save = false;
        ui.label(RichText::new("Dashboard").strong().color(t.text));
        ui.label(RichText::new("Choose what Home shows. The status row and the setup checklist always stay.").small().color(t.muted));
        ui.add_space(4.0);
        if toggle(ui, t, &mut self.settings.home_quick, "Quick actions grid") { save = true; }
        if toggle(ui, t, &mut self.settings.home_stats, "Session statistics") { save = true; }
        if toggle(ui, t, &mut self.settings.home_recent, "Recent activity and recent workspaces") { save = true; }
        if toggle(ui, t, &mut self.settings.home_viewport, "Studio viewport card") { save = true; }
        if toggle(ui, t, &mut self.settings.show_checklist, "Keep the setup checklist visible when everything is green") { save = true; }
        save
    }

    /// Integrations: a status grid for everything the bridge talks to.
    pub(super) fn integrations_section(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let s = self.shared.clone();
        let rows: Vec<(&str, bool, String, Option<Action>)> = vec![
            ("Browser extension", s.roblox_clients.load(Ordering::Relaxed) + s.local_clients.load(Ordering::Relaxed) > 0, format!("{} roblox · {} local channel(s) · ws 17613 / 17615", s.roblox_clients.load(Ordering::Relaxed), s.local_clients.load(Ordering::Relaxed)), Some(Action::OpenRepo)),
            ("Studio MCP helper", s.mcp_alive.load(Ordering::Relaxed), mcp_launcher_display(), Some(Action::RestartMcp)),
            ("Studio place link", s.studio_connected.load(Ordering::Relaxed), if s.studio_connected.load(Ordering::Relaxed) { "linked".into() } else if s.studio_running.load(Ordering::Relaxed) { "Studio open, not linked — enable Studio as MCP server, then probe".into() } else { "Studio not running".into() }, Some(Action::ProbeStudio)),
            ("Studio plugin (TotalScript.lua)", s.plugin_seen.load(Ordering::Relaxed) > 0, if s.plugin_seen.load(Ordering::Relaxed) > 0 { format!("last seen {} ago", human_duration(Duration::from_secs(s.boot.elapsed().as_secs().saturating_sub(s.plugin_seen.load(Ordering::Relaxed) as u64)))) } else { "not seen this run — install plugin/TotalScript.lua in Studio for pair mode and plugin tools".into() }, None),
            ("Blockbench plugin (TotalScript-Blockbench.js)", s.blockbench_connected(), if s.blockbench_seen.load(Ordering::Relaxed) > 0 { format!("last seen {} ago", human_duration(Duration::from_secs(s.boot.elapsed().as_secs().saturating_sub(s.blockbench_seen.load(Ordering::Relaxed) as u64)))) } else { "not connected - load the plugin once in Blockbench (File → Plugins → Load Plugin from File)".into() }, None),
            ("Pair mode", s.pair_enabled.load(Ordering::Relaxed), format!("{} event(s) kept this run", s.pair_events.load(Ordering::Relaxed)), None),
            ("AI chat provider", self.chat_ready(), format!("{} · {}", self.chat_provider().name, if self.chat_model().is_empty() { "no model".to_string() } else { self.chat_model() }), Some(Action::Settings(SettingsCat::Ai))),
        ];
        let mut action: Option<Action> = None;
        for (name, on, detail, fix) in rows {
            ui.horizontal(|ui| {
                status_dot(ui, if on { t.ok } else { t.muted });
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 1.0;
                    ui.label(RichText::new(name).strong().color(t.text));
                    ui.add(egui::Label::new(RichText::new(detail).small().color(t.muted)).wrap());
                });
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if let Some(a) = fix {
                        let label = match a { Action::RestartMcp => "Restart", Action::ProbeStudio => "Probe", Action::OpenRepo => "Get extension", _ => "Set up" };
                        if ghost(ui, t, label).clicked() { action = Some(a); }
                    }
                });
            });
            ui.add_space(6.0);
        }
        ui.label(RichText::new("Everything above is read from the live bridge state — there is no \"connected\" that is not.").small().color(t.muted));
        if let Some(a) = action { let ctx = ui.ctx().clone(); self.run_action(a, &ctx); }
    }

    pub(super) fn privacy_section(&mut self, ui: &mut egui::Ui) -> bool {
        let t = self.theme;
        let mut save = false;
        let keys = self.settings.chat_keys.values().filter(|k| !k.trim().is_empty()).count();
        let lines = [
            ("Stored on this PC", format!("{} — theme, folders, launcher, chat provider / model and API keys in plain text. Nothing is uploaded by this app.", Settings::path().display())),
            ("Log file", format!("{} — bridge events, tool names and timings. No chat text, no arguments, no keys.", log_path().display())),
            ("Activity & session report", "Tool names, counts and durations for the current run only (lost on quit).".to_string()),
            ("Notifications", format!("In memory, this run only, last {} entries.", NOTICE_CAP)),
            ("Network", "Listens on 127.0.0.1 only (http 3000, ws 17613 / 17615). The chat panel talks to the provider you configured and to nothing else.".to_string()),
        ];
        for (k, v) in lines {
            ui.label(RichText::new(k).strong().color(t.text));
            ui.add(egui::Label::new(RichText::new(v).small().color(t.muted)).wrap());
            ui.add_space(4.0);
        }
        ui.add_space(4.0);
        ui.horizontal_wrapped(|ui| {
            if ui.add_enabled(keys > 0, button_widget(t, &format!("Forget all API keys ({keys})"), Btn::Danger)).clicked() { self.settings.chat_keys.clear(); save = true; self.settings_note = "API keys removed from settings.json".into(); }
            if ghost(ui, t, "Copy diagnostics (no keys)").clicked() { let text = self.diagnostics_text(); ui.output_mut(|o| o.copied_text = text); self.toast("Diagnostics copied", true); }
            if ghost(ui, t, "Open settings.json").clicked() { open_external(&Settings::path().to_string_lossy()); }
        });
        save
    }

    pub(super) fn shortcuts_section(&self, ui: &mut egui::Ui) {
        let t = self.theme;
        egui::Grid::new("shortcuts-grid").num_columns(2).spacing([18.0, 6.0]).show(ui, |ui| {
            for (keys, what) in SHORTCUTS {
                key_chip(ui, t, keys);
                ui.add(egui::Label::new(RichText::new(*what).color(t.text)).wrap());
                ui.end_row();
            }
        });
        ui.add_space(6.0);
        ui.label(RichText::new("Shortcuts are fixed in this version (no rebinding yet). Text fields keep normal typing; Ctrl+K works everywhere.").small().color(t.muted));
    }

    pub(super) fn performance_section(&mut self, ui: &mut egui::Ui) -> bool {
        let t = self.theme;
        let mut save = false;
        ui.label(RichText::new("Effects").strong().color(t.text));
        ui.label(RichText::new("The window repaints at ~12 fps while the backdrop drifts, otherwise ~1.5 fps when idle. Turning these off lowers GPU use on laptops.").small().color(t.muted));
        if toggle(ui, t, &mut self.settings.motion, "Motion — hover and page transitions, breathing status dots") { save = true; }
        if toggle(ui, t, &mut self.settings.backdrop, "Backdrop — the glow, lines and rings behind every page") { save = true; }
        if toggle(ui, t, &mut self.settings.glow, "Glow — accent halo around the active page and primary buttons") { save = true; }
        ui.add_space(8.0);
        ui.label(RichText::new("Memory").strong().color(t.text));
        let logs = self.shared.logs.lock().unwrap_or_else(|e| e.into_inner()).len();
        let acts = self.shared.activity.lock().unwrap_or_else(|e| e.into_inner()).len();
        kv(ui, t, "Console lines kept", &format!("{logs} / {LOG_CAP}"));
        kv(ui, t, "Activity lines kept", &format!("{acts} / {ACTIVITY_CAP}"));
        kv(ui, t, "Notifications kept", &format!("{} / {}", self.notices.items.len(), NOTICE_CAP));
        kv(ui, t, "Chat messages in memory", &self.chat_items.len().to_string());
        ui.horizontal_wrapped(|ui| {
            if ghost(ui, t, "Clear console").clicked() { self.shared.logs.lock().unwrap_or_else(|e| e.into_inner()).clear(); self.toast("Console cleared", true); }
            if ghost(ui, t, "Clear activity").clicked() { self.shared.activity.lock().unwrap_or_else(|e| e.into_inner()).clear(); self.toast("Activity cleared", true); }
            if ghost(ui, t, "Clear notifications").clicked() { self.notices.clear(); }
            if self.snapshot.is_some() && ghost(ui, t, "Drop Studio snapshot").clicked() { self.snapshot = None; }
        });
        save
    }

    /// 2.17.0 Updates: what the last check found, the running job, the
    /// daily switch and the extension folder. Returns true when settings changed.
    pub(super) fn updates_section(&mut self, ui: &mut egui::Ui) -> bool {
        use crate::update::{self, Phase};
        let t = self.theme;
        let mut save = false;
        let hub = self.shared.update.clone();
        let info = hub.check_info();
        let job = hub.job();
        let current = env!("CARGO_PKG_VERSION");
        let latest = info.latest.as_ref();
        let newer = latest.map(|l| update::is_newer(&l.version, current)).unwrap_or(false);
        let running = matches!(job.phase, Phase::Downloading | Phase::Verifying | Phase::Staging | Phase::Applying | Phase::Restarting);
        kv(ui, t, "This app", current);
        kv(ui, t, "Latest release", &match latest { Some(l) => format!("{}{}", l.version, if newer { "  (new)" } else if l.version == current { "  (you are up to date)" } else { "" }), None => "not checked yet".into() });
        kv(ui, t, "Last check", &if info.at == 0 { "never".to_string() } else { let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0).saturating_sub(info.at); if secs < 90 { "just now".into() } else if secs < 5400 { format!("{} min ago", secs / 60) } else if secs < 172_800 { format!("{} h ago", secs / 3600) } else { format!("{} days ago", secs / 86_400) } });
        if let Some(e) = info.error.as_deref() { ui.label(RichText::new(format!("Last check failed: {e}")).small().color(t.warn)); }
        let ext = hub.extension_dir();
        kv(ui, t, "Extension folder", &match &ext { Some((p, how)) => format!("{} ({how}{})", p.display(), update::manifest_version(p).map(|v| format!(", v{v}")).unwrap_or_default()), None => "not found - type it below (the folder you loaded unpacked in chrome://extensions)".into() });
        kv(ui, t, "Studio plugin", "comes with the app - rewritten in Studio's Plugins folder on the next start");
        kv(ui, t, "Blockbench plugin", "comes with the app - TotalScript-Blockbench.js next to the executable; load it once in Blockbench (File → Plugins → Load Plugin from File)");
        ui.add_space(6.0);
        match job.phase {
            Phase::Idle => {}
            Phase::Done => { ui.label(RichText::new(format!("Updated to {} - extension: press Reload in the TotalScript popup (or chrome://extensions → reload).", job.version)).small().color(t.ok)); }
            Phase::Failed => { ui.label(RichText::new(format!("Update failed: {}", job.error.clone().unwrap_or_default())).small().color(t.warn)); }
            _ => {
                let pct = if job.total > 0 { Some((job.received as f32 / job.total as f32).clamp(0.0, 1.0)) } else { None };
                ui.label(RichText::new(format!("{} ({})…", job.message, job.component)).small().color(t.text));
                match pct { Some(p) => { ui.add(egui::ProgressBar::new(p).desired_width(360.0).show_percentage()); } None => { ui.add(egui::ProgressBar::new(0.0).desired_width(360.0).animate(true)); } }
                ui.ctx().request_repaint_after(Duration::from_millis(250));
            }
        }
        ui.horizontal_wrapped(|ui| {
            if busy_button(ui, t, "Check now", "Checking…", running, Btn::Secondary).clicked() { let _ = self.cmd_tx.send(UiCommand::UpdateCheck { force: true }); self.toast("Checking GitHub Releases…", true); }
            if newer {
                let v = latest.map(|l| l.version.clone()).unwrap_or_default();
                if busy_button(ui, t, &format!("Update to {v} (app + extension)"), "Updating…", running, Btn::Primary).on_hover_text("Downloads the release from GitHub, verifies sha256, writes the extension files, swaps this binary and relaunches. Nothing happens until you click.").clicked() {
                    let _ = self.cmd_tx.send(UiCommand::UpdateApply { components: vec!["extension".into(), "app".into()] });
                    self.toast(format!("Updating to {v}…"), true);
                }
                if ghost(ui, t, "Only the extension files").on_hover_text("Writes the new extension into the folder above and leaves this app alone").clicked() { let _ = self.cmd_tx.send(UiCommand::UpdateApply { components: vec!["extension".into()] }); }
                if ghost(ui, t, "What's new").clicked() { open_external(latest.map(|l| l.notes_url.as_str()).unwrap_or(update::RELEASES_URL)); }
            } else if ghost(ui, t, "Releases page").clicked() { open_external(update::RELEASES_URL); }
        });
        ui.add_space(6.0);
        if toggle(ui, t, &mut self.settings.update_check_daily, "Check for updates daily - one small latest.json request to GitHub; never installs by itself") { hub.set_daily(self.settings.update_check_daily); save = true; }
        ui.horizontal(|ui| {
            ui.label(RichText::new("Extension folder").color(t.muted));
            if self.update_folder_input.is_empty() { if let Some(d) = hub.configured_dir() { self.update_folder_input = d.display().to_string(); } }
            ui.add(egui::TextEdit::singleline(&mut self.update_folder_input).hint_text("leave empty to detect from where total-core runs").desired_width(360.0).font(TextStyle::Monospace));
            if pill(ui, t, "Apply", false).clicked() {
                let p = self.update_folder_input.trim().to_string();
                if p.is_empty() { hub.set_configured_dir(None); self.settings.update_extension_dir.clear(); save = true; self.toast("Folder cleared - auto-detection is back on", true); }
                else if update::manifest_version(std::path::Path::new(&p)).is_some() { hub.set_configured_dir(Some(std::path::PathBuf::from(&p))); self.settings.update_extension_dir = p; save = true; self.toast("Extension folder saved", true); }
                else { self.toast("That folder has no TotalScript manifest.json", false); }
            }
        });
        ui.label(RichText::new("Integrity: every file is checked against the sha256 in the release's latest.json. Overwritten extension files are kept in a backup folder under the system temp dir (see the log).").small().color(t.muted));
        save
    }

    /// Advanced: paths, import / export, reset.
    pub(super) fn advanced_section(&mut self, ui: &mut egui::Ui) -> (bool, bool) {
        let t = self.theme;
        let (mut save, mut retheme) = (false, false);
        let ctx = ui.ctx().clone();
        egui::Grid::new("adv-grid").num_columns(2).spacing([16.0, 4.0]).min_row_height(22.0).show(ui, |ui| {
            ui.label(RichText::new("Settings file").color(t.muted)); ui.label(RichText::new(Settings::path().to_string_lossy().to_string()).monospace().small()); ui.end_row();
            ui.label(RichText::new("Export file").color(t.muted)); ui.label(RichText::new(Self::export_path().to_string_lossy().to_string()).monospace().small()); ui.end_row();
            ui.label(RichText::new("Log file").color(t.muted)); ui.label(RichText::new(log_path().to_string_lossy().to_string()).monospace().small()); ui.end_row();
            ui.label(RichText::new("Data folder").color(t.muted)); ui.label(RichText::new(data_dir().to_string_lossy().to_string()).monospace().small()); ui.end_row();
        });
        ui.add_space(8.0);
        ui.label(RichText::new("Export / import").strong().color(t.text));
        ui.label(RichText::new("Export writes settings.export.json (API keys stripped) and copies it. Import reads any settings JSON, checks ranges and keeps your folders, keys, launcher and autostart untouched.").small().color(t.muted));
        ui.horizontal(|ui| {
            if pill(ui, t, "Export", false).clicked() { self.export_settings(&ctx); }
            ui.add(egui::TextEdit::singleline(&mut self.import_path).hint_text(Self::export_path().to_string_lossy().to_string()).desired_width(360.0).font(TextStyle::Monospace));
            let has = !self.import_path.trim().is_empty();
            if ui.add_enabled(has, pill_widget(t, "Import", true)).clicked() { let p = self.import_path.clone(); self.import_settings(&p, &ctx); }
            if !has && ghost(ui, t, "Use export path").clicked() { self.import_path = Self::export_path().to_string_lossy().to_string(); }
        });
        ui.add_space(8.0);
        ui.label(RichText::new("Reset").strong().color(t.text));
        ui.horizontal_wrapped(|ui| {
            let armed = self.reset_armed.map(|a| a.elapsed() < Duration::from_secs(4)).unwrap_or(false);
            if !armed { self.reset_armed = None; }
            if ui.add(button_widget(t, if armed { "Click again to reset everything" } else { "Reset all settings…" }, if armed { Btn::Danger } else { Btn::Secondary })).clicked() {
                if armed {
                    let keep_ws = self.settings.workspace_root.clone();
                    let keep_ref = self.settings.reference_dir.clone();
                    let keep_recent = self.settings.recent_workspaces.clone();
                    let keep_fav = self.settings.favorite_workspaces.clone();
                    self.settings = Settings { workspace_root: keep_ws, reference_dir: keep_ref, recent_workspaces: keep_recent, favorite_workspaces: keep_fav, ..Settings::default() };
                    self.draft_mcp.clear();
                    self.reset_armed = None;
                    retheme = true; save = true;
                    self.settings_note = "All settings reset to defaults (workspace folders kept, API keys removed).".into();
                } else {
                    self.reset_armed = Some(Instant::now());
                }
            }
            if armed && ghost(ui, t, "Cancel").clicked() { self.reset_armed = None; }
            if ghost(ui, t, "Open log file").clicked() { open_external(&log_path().to_string_lossy()); }
            if ghost(ui, t, "Open settings.json").clicked() { open_external(&Settings::path().to_string_lossy()); }
            if danger(ui, t, "Quit TotalScript (stop bridge)").clicked() { self.quit_now = true; request_quit(&self.shared); }
        });
        ui.label(RichText::new("Reset all asks twice and removes API keys; workspace folders and the workspace list stay. Every category card also has its own Reset.").small().color(t.muted));
        (save, retheme)
    }
}
