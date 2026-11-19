//! 2.11.0 command palette (Ctrl+K / Ctrl+P). Fuzzy search over every page,
//! settings category and action the window can perform; Up/Down/Enter/Esc;
//! the last eight commands are remembered in settings. Destructive commands
//! (kill Studio, quit, forget keys, clear logs) need Enter twice — the row
//! turns red and says so after the first press.

use super::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Action {
    Go(Page),
    Settings(SettingsCat),
    RestartMcp,
    ProbeStudio,
    Capture,
    CopyDiagnostics,
    CopyReport,
    OpenWorkspace,
    OpenLog,
    OpenSettingsFile,
    OpenRepo,
    ToggleChat,
    NewChat,
    ToggleRail,
    ToggleMotion,
    ToggleCompact,
    ToggleBackdrop,
    Palette(usize),
    Notices,
    ClearNotices,
    ClearActivity,
    KillStudio,
    ForgetKeys,
    ExportSettings,
    Quit,
}

#[derive(Clone, Debug)]
pub(super) struct Cmd { pub title: String, pub group: &'static str, pub keys: &'static str, pub action: Action, pub destructive: bool }

#[derive(Default)]
pub(super) struct PaletteState {
    pub open: bool,
    pub query: String,
    pub selected: usize,
    /// Index (into the shown list) of a destructive command waiting for the second Enter.
    pub armed: Option<usize>,
    pub just_opened: bool,
}

/// Subsequence match with word-start and prefix bonuses. `None` = no match.
pub(super) fn fuzzy_score(query: &str, text: &str) -> Option<i32> {
    let q: Vec<char> = query.to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    if q.is_empty() { return Some(0); }
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let mut score = 0i32;
    let mut qi = 0usize;
    let mut last: Option<usize> = None;
    for (i, ch) in t.iter().enumerate() {
        if qi < q.len() && *ch == q[qi] {
            score += 2;
            if i == 0 || !t[i - 1].is_alphanumeric() { score += 6; }
            if let Some(l) = last { if l + 1 == i { score += 4; } }
            if i == qi { score += 1; }
            last = Some(i);
            qi += 1;
        }
    }
    if qi == q.len() { Some(score - (t.len() as i32 / 8)) } else { None }
}

const RECENT_CAP: usize = 8;

impl App {
    pub(super) fn palette_commands(&self) -> Vec<Cmd> {
        let mut v: Vec<Cmd> = Vec::new();
        let mut add = |title: &str, group: &'static str, keys: &'static str, action: Action, destructive: bool| {
            v.push(Cmd { title: title.to_string(), group, keys, action, destructive });
        };
        for p in Page::ALL { add(&format!("Go to {}", p.title()), "Pages", p.shortcut_label(), Action::Go(p), false); }
        for c in SettingsCat::ALL { add(&format!("Settings › {}", c.title()), "Settings", "", Action::Settings(c), false); }
        add("Restart Studio MCP helper", "Studio", "Ctrl+R", Action::RestartMcp, false);
        add("Probe Studio", "Studio", "F5", Action::ProbeStudio, false);
        add("Capture Studio viewport", "Studio", "Ctrl+Shift+S", Action::Capture, false);
        add("Kill Roblox Studio process", "Studio", "", Action::KillStudio, true);
        add("Toggle AI chat panel", "Chat", "Ctrl+J", Action::ToggleChat, false);
        add("New chat (clear the conversation)", "Chat", "", Action::NewChat, true);
        add("Copy diagnostics", "Support", "", Action::CopyDiagnostics, false);
        add("Copy session report", "Support", "", Action::CopyReport, false);
        add("Open workspace folder", "Workspace", "", Action::OpenWorkspace, false);
        add("Open log file", "Support", "", Action::OpenLog, false);
        add("Open settings.json", "Support", "", Action::OpenSettingsFile, false);
        add("Export settings (no API keys)", "Settings", "", Action::ExportSettings, false);
        add("Open GitHub repository", "Support", "", Action::OpenRepo, false);
        add(if self.settings.sidebar_rail { "Sidebar: expand" } else { "Sidebar: icon rail" }, "View", "", Action::ToggleRail, false);
        add(if self.settings.motion { "Motion: off" } else { "Motion: on" }, "View", "", Action::ToggleMotion, false);
        add(if self.settings.compact { "Density: comfortable" } else { "Density: compact" }, "View", "", Action::ToggleCompact, false);
        add(if self.settings.backdrop { "Backdrop: off" } else { "Backdrop: on" }, "View", "", Action::ToggleBackdrop, false);
        for (i, pal) in PALETTES.iter().enumerate() { add(&format!("Theme: {}", pal.name), "Theme", "", Action::Palette(i), false); }
        add("Notifications", "View", "Ctrl+Shift+N", Action::Notices, false);
        add("Clear notifications", "View", "", Action::ClearNotices, true);
        add("Clear activity feed", "View", "", Action::ClearActivity, true);
        add("Forget all API keys", "Privacy", "", Action::ForgetKeys, true);
        add("Quit TotalScript (stop the bridge)", "App", "", Action::Quit, true);
        v
    }

    pub(super) fn open_palette(&mut self) {
        self.palette.open = true;
        self.palette.just_opened = true;
        self.palette.query.clear();
        self.palette.selected = 0;
        self.palette.armed = None;
        self.notices.open = false;
    }

    fn remember_command(&mut self, title: &str) {
        self.settings.recent_commands.retain(|c| c != title);
        self.settings.recent_commands.insert(0, title.to_string());
        self.settings.recent_commands.truncate(RECENT_CAP);
        let _ = self.settings.save();
    }

    /// Execute one palette action. Everything here calls the same code paths
    /// the buttons use — the palette is a second way in, not a second implementation.
    pub(super) fn run_action(&mut self, a: Action, ctx: &egui::Context) {
        match a {
            Action::Go(p) => self.go(p),
            Action::Settings(c) => { self.settings_cat = c; self.settings_query.clear(); self.go(Page::Settings); }
            Action::RestartMcp => self.send(UiCommand::RestartMcp, "Restarting Studio MCP helper"),
            Action::ProbeStudio => self.send(UiCommand::ProbeStudio, "Probing Studio"),
            Action::Capture => self.capture_studio(),
            Action::CopyDiagnostics => { let text = self.diagnostics_text(); ctx.output_mut(|o| o.copied_text = text); self.toast("Diagnostics copied to clipboard", true); }
            Action::CopyReport => { let text = self.shared.session_report_text(); ctx.output_mut(|o| o.copied_text = text); self.toast("Session report copied to clipboard", true); }
            Action::OpenWorkspace => open_external(&self.shared.root()),
            Action::OpenLog => open_external(&log_path().to_string_lossy()),
            Action::OpenSettingsFile => open_external(&Settings::path().to_string_lossy()),
            Action::OpenRepo => open_external(&format!("https://github.com/{REPO}")),
            Action::ToggleChat => self.toggle_chat(),
            Action::NewChat => { self.chat_new(); self.toast("New chat", true); }
            Action::ToggleRail => { self.settings.sidebar_rail = !self.settings.sidebar_rail; let _ = self.settings.save(); }
            Action::ToggleMotion => { self.settings.motion = !self.settings.motion; let _ = self.settings.save(); }
            Action::ToggleCompact => { self.settings.compact = !self.settings.compact; self.retheme(ctx); let _ = self.settings.save(); }
            Action::ToggleBackdrop => { self.settings.backdrop = !self.settings.backdrop; let _ = self.settings.save(); }
            Action::Palette(i) => { if let Some(p) = PALETTES.get(i) { self.settings.theme = p.id.into(); self.retheme(ctx); let _ = self.settings.save(); self.toast(format!("Theme: {}", p.name), true); } }
            Action::Notices => self.toggle_notices(),
            Action::ClearNotices => self.notices.clear(),
            Action::ClearActivity => { self.shared.activity.lock().unwrap_or_else(|e| e.into_inner()).clear(); self.toast("Activity feed cleared", true); }
            Action::KillStudio => self.send(UiCommand::KillStudio, "Killing Roblox Studio"),
            Action::ForgetKeys => { self.settings.chat_keys.clear(); let _ = self.settings.save(); self.toast("API keys removed from settings.json", true); }
            Action::ExportSettings => self.export_settings(ctx),
            Action::Quit => { self.quit_now = true; request_quit(&self.shared); }
        }
    }

    pub(super) fn retheme(&mut self, ctx: &egui::Context) {
        self.theme = Theme::from_settings(&self.settings);
        self.theme.apply(ctx, &self.settings);
    }

    pub(super) fn draw_palette(&mut self, ctx: &egui::Context) {
        if !self.palette.open { return; }
        let t = self.theme;
        // Keys first, so Enter / arrows work regardless of the text field.
        let (up, down, enter, esc) = ctx.input(|i| (
            i.key_pressed(egui::Key::ArrowUp), i.key_pressed(egui::Key::ArrowDown),
            i.key_pressed(egui::Key::Enter), i.key_pressed(egui::Key::Escape)));
        if esc { self.palette.open = false; return; }

        // Build the shown list: recent first when the query is empty.
        let all = self.palette_commands();
        let q = self.palette.query.trim().to_string();
        let mut shown: Vec<(Cmd, bool)> = Vec::new();
        if q.is_empty() {
            for title in &self.settings.recent_commands {
                if let Some(c) = all.iter().find(|c| &c.title == title) { shown.push((c.clone(), true)); }
            }
            for c in &all { if !shown.iter().any(|(s, _)| s.title == c.title) { shown.push((c.clone(), false)); } }
        } else {
            let mut scored: Vec<(i32, Cmd)> = all.iter().filter_map(|c| fuzzy_score(&q, &format!("{} {}", c.group, c.title)).map(|s| (s, c.clone()))).collect();
            scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.title.cmp(&b.1.title)));
            shown = scored.into_iter().map(|(_, c)| (c, false)).collect();
        }
        let max_rows = 12usize;
        shown.truncate(max_rows);
        if shown.is_empty() { self.palette.selected = 0; } else if self.palette.selected >= shown.len() { self.palette.selected = shown.len() - 1; }
        if down && !shown.is_empty() { self.palette.selected = (self.palette.selected + 1) % shown.len(); self.palette.armed = None; }
        if up && !shown.is_empty() { self.palette.selected = (self.palette.selected + shown.len() - 1) % shown.len(); self.palette.armed = None; }

        let mut run: Option<Cmd> = None;
        let mut click: Option<usize> = None;
        let mut close = false;
        let screen = ctx.screen_rect();
        // Dim the window behind the palette.
        ctx.layer_painter(egui::LayerId::new(egui::Order::Foreground, egui::Id::new("palette-dim"))).rect_filled(screen, Rounding::ZERO, alpha(Color32::BLACK, if t.light { 60 } else { 110 }));
        let width = (screen.width() - 80.0).clamp(320.0, 620.0);
        let selected = self.palette.selected;
        let armed = self.palette.armed;
        let just_opened = self.palette.just_opened;
        let mut query_changed = false;
        let resp = egui::Area::new(egui::Id::new("palette"))
            .order(egui::Order::Foreground)
            .anchor(egui::Align2::CENTER_TOP, Vec2::new(0.0, (screen.height() * 0.12).max(48.0)))
            .show(ctx, |ui| {
                let frame = egui::Frame::none().fill(t.panel).stroke(Stroke::new(1.0_f32, alpha(t.accent, 150))).rounding(Rounding::same(t.r_card + 4.0)).inner_margin(Margin::same(10.0))
                    .shadow(egui::epaint::Shadow { offset: Vec2::new(0.0, 10.0), blur: 30.0, spread: 0.0, color: alpha(Color32::BLACK, if t.light { 60 } else { 160 }) });
                frame.show(ui, |ui| {
                    ui.set_width(width);
                    ui.horizontal(|ui| {
                        let (r, _) = ui.allocate_exact_size(Vec2::splat(18.0), Sense::hover());
                        paint_icon(ui.painter(), r, Icon::Search, t.muted);
                        let edit = ui.add(egui::TextEdit::singleline(&mut self.palette.query).hint_text("Type a command, page or setting…").desired_width(ui.available_width() - 70.0).font(FontId::new(15.0, FontFamily::Proportional)).frame(false));
                        if edit.changed() { query_changed = true; }
                        if just_opened || !edit.has_focus() { edit.request_focus(); }
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| { key_chip(ui, t, "Esc"); });
                    });
                    ui.add_space(6.0);
                    let (line, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 1.0), Sense::hover());
                    ui.painter().rect_filled(line, Rounding::ZERO, t.border);
                    ui.add_space(6.0);
                    if shown.is_empty() {
                        ui.label(RichText::new(format!("No command matches \"{}\".", q)).color(t.muted));
                        return;
                    }
                    for (i, (c, recent)) in shown.iter().enumerate() {
                        let on = i == selected;
                        let is_armed = armed == Some(i);
                        let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::click());
                        let p = ui.painter();
                        if is_armed { p.rect_filled(rect, Rounding::same(t.r_btn), alpha(t.bad, 40)); p.rect_stroke(rect, Rounding::same(t.r_btn), Stroke::new(1.0_f32, t.bad)); }
                        else if on { p.rect_filled(rect, Rounding::same(t.r_btn), alpha(t.accent, 38)); p.rect_stroke(rect, Rounding::same(t.r_btn), Stroke::new(1.0_f32, alpha(t.accent, 140))); }
                        else if resp.hovered() { p.rect_filled(rect, Rounding::same(t.r_btn), t.panel2); }
                        let group_col = if c.destructive { t.bad } else { t.accent };
                        let gx = rect.left() + 10.0;
                        p.text(Pos2::new(gx, rect.center().y), egui::Align2::LEFT_CENTER, c.group.to_uppercase(), FontId::new(10.0, FontFamily::Proportional), group_col);
                        let title = if is_armed { format!("{} — press Enter again to confirm", c.title) } else if *recent { format!("{}  · recent", c.title) } else { c.title.clone() };
                        let tx = gx + 76.0;
                        let max_w = rect.right() - tx - 90.0;
                        paint_text_fit(p, Pos2::new(tx, rect.center().y), egui::Align2::LEFT_CENTER, &title, FontId::new(14.0, FontFamily::Proportional), if is_armed { t.bad } else { t.text }, max_w);
                        if !c.keys.is_empty() {
                            p.text(Pos2::new(rect.right() - 10.0, rect.center().y), egui::Align2::RIGHT_CENTER, c.keys, FontId::new(11.0, FontFamily::Monospace), t.muted);
                        } else if on {
                            p.text(Pos2::new(rect.right() - 10.0, rect.center().y), egui::Align2::RIGHT_CENTER, "↵", FontId::new(12.0, FontFamily::Proportional), t.muted);
                        }
                        if resp.hovered() { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
                        if resp.clicked() { click = Some(i); }
                    }
                    ui.add_space(4.0);
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("↑↓ move · Enter run · destructive commands ask for Enter twice").small().color(t.muted));
                    });
                });
            }).response;
        self.palette.just_opened = false;
        if query_changed { self.palette.selected = 0; self.palette.armed = None; }
        // Click outside closes.
        if ctx.input(|i| i.pointer.any_pressed()) {
            if let Some(pos) = ctx.input(|i| i.pointer.interact_pos()) { if !resp.rect.contains(pos) { close = true; } }
        }
        // Enter on the selected row, or a click on any row.
        let pick = if enter && !shown.is_empty() { Some(selected) } else { click };
        if let Some(i) = pick {
            if let Some((c, _)) = shown.get(i) {
                if c.destructive && self.palette.armed != Some(i) {
                    self.palette.armed = Some(i);
                    self.palette.selected = i;
                } else {
                    run = Some(c.clone());
                }
            }
        }
        if let Some(c) = run {
            self.remember_command(&c.title);
            self.palette.open = false;
            self.run_action(c.action, ctx);
        } else if close {
            self.palette.open = false;
        }
    }
}
