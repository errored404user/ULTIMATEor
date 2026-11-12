//! 2.11.0 Activity Center (Page::Activity) and Diagnostics Center
//! (Page::Diagnostics). Both read the runtime's existing state — the
//! activity feed, session counters, running jobs and the shared flags — and
//! never invent a status: a check is green only when the flag behind it is.

use super::*;

/// One running job the window knows about. `cancel` is `Some` only when a
/// real stop exists (today: the chat turn). Tool calls already handed to the
/// runtime run to completion (the engines enforce their own timeouts).
pub(super) struct Job { pub title: String, pub detail: String, pub started: Instant, pub cancellable: bool }

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ActFilter { All, Tools, Studio, Bridge, Chat, Pair, Errors }

impl ActFilter {
    fn keep(self, kind: &str) -> bool {
        match self {
            ActFilter::All => true,
            ActFilter::Tools => kind == "tool",
            ActFilter::Studio => kind == "studio",
            ActFilter::Bridge => kind == "bridge" || kind == "app",
            ActFilter::Chat => kind == "chat",
            ActFilter::Pair => kind == "pair",
            ActFilter::Errors => kind == "error",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CheckState { Ok, Warn, Bad, Info }

pub(super) struct Check { pub title: &'static str, pub state: CheckState, pub detail: String, pub fix: Option<(&'static str, Action)> }

impl App {
    pub(super) fn jobs(&self) -> Vec<Job> {
        let mut v = Vec::new();
        if let Some(turn) = &self.chat_turn {
            v.push(Job { title: "AI chat turn".into(), detail: if self.chat_status.is_empty() { "model is working".into() } else { self.chat_status.clone() }, started: turn.started, cancellable: true });
        }
        if let Some(run) = &self.term_run { v.push(Job { title: "Terminal command".into(), detail: format!("{} · runs to completion (engine timeout)", run.name), started: run.started, cancellable: false }); }
        if let Some(run) = &self.luau_run { v.push(Job { title: "Luau in Studio".into(), detail: format!("{} · Studio executes it; no cancel", run.name), started: run.started, cancellable: false }); }
        if let Some(run) = &self.snapshot_run { v.push(Job { title: "Studio viewport capture".into(), detail: run.name.clone(), started: run.started, cancellable: false }); }
        if self.workspace_rx.is_some() { v.push(Job { title: "Workspace switch".into(), detail: self.draft_workspace.clone(), started: self.page_opened, cancellable: false }); }
        if self.reference_rx.is_some() { v.push(Job { title: "Reference library switch".into(), detail: self.draft_reference.clone(), started: self.page_opened, cancellable: false }); }
        if self.picker_rx.is_some() { v.push(Job { title: "Folder picker".into(), detail: "waiting for the system dialog".into(), started: self.page_opened, cancellable: false }); }
        if self.chat_models_rx.is_some() { v.push(Job { title: "Model list".into(), detail: "asking the provider for /models".into(), started: self.page_opened, cancellable: false }); }
        v
    }

    pub(super) fn page_activity(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let s = self.shared.clone();
        // Toolbar: filter segments + search + clear.
        let mut clear_feed = false;
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = Vec2::new(8.0, 8.0);
            let mut f = self.activity_filter;
            if segmented(ui, t, &[(ActFilter::All, "All"), (ActFilter::Tools, "Tools"), (ActFilter::Studio, "Studio"), (ActFilter::Bridge, "Bridge"), (ActFilter::Chat, "Chat"), (ActFilter::Pair, "Pair"), (ActFilter::Errors, "Errors")], &mut f) { self.activity_filter = f; }
            ui.add(egui::TextEdit::singleline(&mut self.activity_query).hint_text("Search the feed…").desired_width(200.0));
            if !self.activity_query.is_empty() && icon_button(ui, t, Icon::Close, "Clear search", false).clicked() { self.activity_query.clear(); }
            if icon_button(ui, t, Icon::Trash, "Clear the activity feed", false).clicked() { clear_feed = true; }
        });
        if clear_feed { s.activity.lock().unwrap_or_else(|e| e.into_inner()).clear(); self.toast("Activity feed cleared", true); }
        ui.add_space(10.0);

        let wide = ui.available_width() >= 900.0;
        let jobs = self.jobs();
        let list: Vec<Activity> = s.activity.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect();
        let session = s.session.lock().unwrap_or_else(|e| e.into_inner());
        let mut tools: Vec<(String, ToolStat)> = session.tools.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        tools.sort_by(|a, b| (b.1.ok + b.1.fail).cmp(&(a.1.ok + a.1.fail)).then_with(|| a.0.cmp(&b.0)));
        let errors: Vec<(String, String)> = session.errors.iter().cloned().collect();
        let mut sources: Vec<(String, usize)> = session.sources.iter().map(|(k, v)| (k.clone(), *v)).collect();
        sources.sort_by(|a, b| b.1.cmp(&a.1));
        let luau_warnings = session.luau_warnings;
        let started = session.started.clone();
        drop(session);
        let ok_total: usize = tools.iter().map(|(_, x)| x.ok).sum();
        let fail_total: usize = tools.iter().map(|(_, x)| x.fail).sum();
        let ms_total: u128 = tools.iter().map(|(_, x)| x.total_ms).sum();
        let calls = ok_total + fail_total;
        let q = self.activity_query.trim().to_lowercase();
        let filter = self.activity_filter;
        let feed: Vec<&Activity> = list.iter().filter(|a| filter.keep(&a.kind) && (q.is_empty() || a.text.to_lowercase().contains(&q) || a.kind.contains(&q))).collect();
        let mut stop_chat = false;

        let draw_jobs = |ui: &mut egui::Ui, stop_chat: &mut bool| {
            card(ui, t, |ui| {
                card_title(ui, t, "Running now", |ui| { if !jobs.is_empty() { spinner(ui, t, 14.0); } });
                if jobs.is_empty() { empty_state(ui, t, "Nothing running", "Chat turns, terminal commands, Luau runs and captures show here while they run."); }
                for j in &jobs {
                    ui.horizontal(|ui| {
                        status_dot(ui, t.warn);
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 1.0;
                            ui.label(RichText::new(format!("{} · {}", j.title, human_duration(j.started.elapsed()))).strong().color(t.text));
                            ui.add(egui::Label::new(RichText::new(&j.detail).small().color(t.muted)).truncate());
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if j.cancellable { if danger(ui, t, "Stop").clicked() { *stop_chat = true; } }
                            else { ui.label(RichText::new("not cancellable").small().color(t.muted)); }
                        });
                    });
                    ui.add_space(4.0);
                }
            });
            ui.add_space(12.0);
        };
        let draw_session = |ui: &mut egui::Ui| {
            card(ui, t, |ui| {
                card_title(ui, t, "This session", |ui| { ui.label(RichText::new(format!("since {started}")).small().color(t.muted)); });
                ui.columns(3, |c| {
                    stat_tile(&mut c[0], t, &calls.to_string(), "tool calls", t.accent);
                    stat_tile(&mut c[1], t, &fail_total.to_string(), "failed", if fail_total > 0 { t.bad } else { t.muted });
                    stat_tile(&mut c[2], t, &if calls > 0 { format!("{} ms", ms_total / calls as u128) } else { "—".into() }, "avg per call", t.info);
                });
                ui.add_space(8.0);
                if !sources.is_empty() {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(RichText::new("Sources").small().strong().color(t.muted));
                        for (k, v) in &sources { tag(ui, &format!("{k} {v}"), t.info); }
                        if luau_warnings > 0 { tag(ui, &format!("luau warnings {luau_warnings}"), t.warn); }
                    });
                    ui.add_space(6.0);
                }
                if tools.is_empty() { ui.label(RichText::new("No tool has run yet. Names and counts only — never arguments or chat text.").small().color(t.muted)); }
                else {
                    egui::Grid::new("session-tools").num_columns(5).spacing([14.0, 3.0]).striped(true).show(ui, |ui| {
                        for (h, _) in [("tool", 0), ("ok", 0), ("fail", 0), ("avg", 0), ("max", 0)] { ui.label(RichText::new(h).small().strong().color(t.muted)); }
                        ui.end_row();
                        for (name, st) in tools.iter().take(40) {
                            let n = (st.ok + st.fail).max(1) as u128;
                            ui.horizontal(|ui| { ui.set_min_width(170.0); ui.add(egui::Label::new(RichText::new(name).monospace().small().color(t.text)).truncate()); });
                            ui.label(RichText::new(st.ok.to_string()).small().color(t.ok));
                            ui.label(RichText::new(st.fail.to_string()).small().color(if st.fail > 0 { t.bad } else { t.muted }));
                            ui.label(RichText::new(format!("{} ms", st.total_ms / n)).small().color(t.muted));
                            ui.label(RichText::new(format!("{} ms", st.max_ms)).small().color(t.muted));
                            ui.end_row();
                        }
                    });
                }
                if !errors.is_empty() {
                    ui.add_space(8.0);
                    ui.label(RichText::new(format!("Last errors ({})", errors.len())).small().strong().color(t.bad));
                    for (clock, text) in errors.iter().rev().take(10) {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(clock).monospace().small().color(t.muted));
                            ui.add(egui::Label::new(RichText::new(text).small().color(t.text)).wrap());
                        });
                    }
                }
            });
            ui.add_space(12.0);
        };
        let draw_feed = |ui: &mut egui::Ui| {
            card(ui, t, |ui| {
                card_title(ui, t, "Feed", |ui| { ui.label(RichText::new(format!("{} of {} · newest first · last {}", feed.len(), list.len(), ACTIVITY_CAP)).small().color(t.muted)); });
                if feed.is_empty() {
                    empty_state(ui, t, if list.is_empty() { "No activity yet" } else { "No line matches" }, if list.is_empty() { "Tool calls, Studio links, pair findings and workspace edits appear here." } else { "Change the filter or the search text." });
                }
                for a in feed.iter().take(200) {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(&a.at).monospace().small().color(t.muted));
                        let color = match a.kind.as_str() { "tool" => t.accent, "studio" => t.ok, "bridge" => t.info, "pair" => t.warn, "error" => t.bad, "chat" => t.accent2, _ => t.muted };
                        tag(ui, &a.kind, color);
                        ui.add(egui::Label::new(RichText::new(&a.text).small().color(t.text)).wrap());
                    });
                }
            });
        };

        egui::ScrollArea::vertical().id_salt("activity-scroll").auto_shrink([false, false]).show(ui, |ui| {
            ui.set_max_width(ui.available_width() - 8.0);
            if wide {
                ui.columns(2, |cols| {
                    draw_jobs(&mut cols[0], &mut stop_chat);
                    draw_session(&mut cols[0]);
                    draw_feed(&mut cols[1]);
                });
            } else {
                draw_jobs(ui, &mut stop_chat);
                draw_session(ui);
                draw_feed(ui);
            }
        });
        if stop_chat { self.chat_stop(); }
    }

    /// Live checks — computed every frame from the shared flags, no caching,
    /// so "Run again" is not needed and would be misleading.
    pub(super) fn diagnostics_checks(&self) -> Vec<Check> {
        let s = &self.shared;
        let mut v = Vec::new();
        let fatal = s.fatal.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let listening = s.bridge_listening.load(Ordering::Relaxed);
        v.push(match (&fatal, listening) {
            (Some(f), _) => Check { title: "Bridge", state: CheckState::Bad, detail: format!("failed to start: {f}"), fix: Some(("Copy diagnostics", Action::CopyDiagnostics)) },
            (None, false) => Check { title: "Bridge", state: CheckState::Warn, detail: "binding http 3000 · ws 17613 · ws 17615…".into(), fix: None },
            (None, true) => Check { title: "Bridge", state: CheckState::Ok, detail: format!("listening · up {}", human_duration(s.boot.elapsed())), fix: None },
        });
        let rc = s.roblox_clients.load(Ordering::Relaxed);
        let lc = s.local_clients.load(Ordering::Relaxed);
        v.push(if rc + lc > 0 { Check { title: "Browser extension", state: CheckState::Ok, detail: format!("{rc} roblox + {lc} local channel(s) connected"), fix: None } }
            else { Check { title: "Browser extension", state: CheckState::Warn, detail: "no channel connected — open a supported AI chat tab with the TotalScript extension".into(), fix: Some(("Open repository", Action::OpenRepo)) } });
        let studio = s.studio_running.load(Ordering::Relaxed);
        let linked = s.studio_connected.load(Ordering::Relaxed);
        let mcp = s.mcp_alive.load(Ordering::Relaxed);
        v.push(if studio { Check { title: "Roblox Studio process", state: CheckState::Ok, detail: "running".into(), fix: None } }
            else { Check { title: "Roblox Studio process", state: CheckState::Info, detail: "not running — start Studio and open a place".into(), fix: None } });
        v.push(if mcp { Check { title: "Studio MCP helper", state: CheckState::Ok, detail: format!("alive · {}", mcp_launcher_display()), fix: None } }
            else { Check { title: "Studio MCP helper", state: CheckState::Bad, detail: format!("not running · launcher: {}", mcp_launcher_display()), fix: Some(("Restart helper", Action::RestartMcp)) } });
        v.push(if linked { Check { title: "Studio place link", state: CheckState::Ok, detail: "MCP helper linked to an open place".into(), fix: None } }
            else if studio { Check { title: "Studio place link", state: CheckState::Warn, detail: "Studio is open but not linked — enable Studio as MCP server, then probe".into(), fix: Some(("Probe Studio", Action::ProbeStudio)) } }
            else { Check { title: "Studio place link", state: CheckState::Info, detail: "waiting for Studio".into(), fix: None } });
        let seen = s.plugin_seen.load(Ordering::Relaxed);
        v.push(if seen == 0 { Check { title: "Studio plugin", state: CheckState::Info, detail: "has not talked to the bridge this run (optional — needed for pair mode and plugin tools)".into(), fix: None } }
            else { let ago = s.boot.elapsed().as_secs().saturating_sub(seen as u64); Check { title: "Studio plugin", state: if ago < 30 { CheckState::Ok } else { CheckState::Warn }, detail: format!("last seen {} ago", human_duration(Duration::from_secs(ago))), fix: None } });
        let bb_seen = s.blockbench_seen.load(Ordering::Relaxed);
        let bb_ago = if bb_seen > 0 { s.boot.elapsed().as_secs().saturating_sub(bb_seen as u64) } else { 0 };
        v.push(match s.blockbench_status() {
            "connected" => Check { title: "Blockbench plugin", state: CheckState::Ok, detail: format!("verified live · last seen {} ago", human_duration(Duration::from_secs(bb_ago))), fix: None },
            "disconnected" => Check { title: "Blockbench plugin", state: CheckState::Warn, detail: "plugin explicitly paused or unloaded — load TotalScript-Blockbench.js in Blockbench: File → Plugins → Load Plugin from File".into(), fix: None },
            _ => Check { title: "Blockbench plugin", state: CheckState::Info, detail: if bb_seen == 0 { "unknown — no plugin heartbeat has been verified this run; load TotalScript-Blockbench.js in Blockbench, then check again".into() } else { format!("unknown — last heartbeat was {} ago; stale status is not treated as disconnected", human_duration(Duration::from_secs(bb_ago))) }, fix: None },
        });
        let root = s.root();
        let ready = s.workspace_ready.load(Ordering::Relaxed);
        let root_path = PathBuf::from(&root);
        v.push(if root.trim().is_empty() { Check { title: "Workspace folder", state: CheckState::Bad, detail: "not set".into(), fix: Some(("Choose", Action::Settings(SettingsCat::Workspace))) } }
            else if !root_path.is_dir() { Check { title: "Workspace folder", state: CheckState::Bad, detail: format!("missing: {root}"), fix: Some(("Fix", Action::Settings(SettingsCat::Workspace))) } }
            else if !ready { Check { title: "Workspace folder", state: CheckState::Warn, detail: format!("{root} · engine not ready yet"), fix: None } }
            else {
                let readonly = std::fs::metadata(&root_path).map(|m| m.permissions().readonly()).unwrap_or(false);
                Check { title: "Workspace folder", state: if readonly { CheckState::Warn } else { CheckState::Ok }, detail: format!("{}{}{}", short_path(&root, 60), if readonly { " · read-only" } else { "" }, if s.full_access() { " · FULL PC ACCESS on" } else { "" }), fix: None }
            });
        let rd = self.settings.reference_dir.trim();
        v.push(if rd.is_empty() { Check { title: "Reference library", state: CheckState::Info, detail: "off (optional)".into(), fix: None } }
            else if Path::new(rd).is_dir() { Check { title: "Reference library", state: CheckState::Ok, detail: short_path(rd, 60), fix: None } }
            else { Check { title: "Reference library", state: CheckState::Warn, detail: format!("folder missing: {rd}"), fix: Some(("Fix", Action::Settings(SettingsCat::Workspace))) } });
        let p = self.chat_provider();
        v.push(if self.chat_ready() { Check { title: "AI chat provider", state: CheckState::Ok, detail: format!("{} · {}", p.name, self.chat_model()), fix: None } }
            else { Check { title: "AI chat provider", state: CheckState::Info, detail: format!("{} not configured (key / model) — the extension path works without it", p.name), fix: Some(("Set up", Action::Settings(SettingsCat::Ai))) } });
        let sp = Settings::path();
        v.push(match std::fs::metadata(&sp) {
            Ok(m) if m.permissions().readonly() => Check { title: "Settings file", state: CheckState::Warn, detail: format!("{} is read-only — changes will not persist", sp.display()), fix: Some(("Open", Action::OpenSettingsFile)) },
            Ok(m) => Check { title: "Settings file", state: CheckState::Ok, detail: format!("{} · {}", sp.display(), human_size(m.len())), fix: None },
            Err(_) => Check { title: "Settings file", state: CheckState::Info, detail: format!("not written yet ({})", sp.display()), fix: None },
        });
        let lp = log_path();
        v.push(match std::fs::metadata(&lp) {
            Ok(m) if m.len() > 20 * 1024 * 1024 => Check { title: "Log file", state: CheckState::Warn, detail: format!("{} · {} — large; consider deleting it", lp.display(), human_size(m.len())), fix: Some(("Open", Action::OpenLog)) },
            Ok(m) => Check { title: "Log file", state: CheckState::Ok, detail: format!("{} · {}", lp.display(), human_size(m.len())), fix: None },
            Err(_) => Check { title: "Log file", state: CheckState::Info, detail: format!("no log yet ({})", lp.display()), fix: None },
        });
        let errs = s.session.lock().unwrap_or_else(|e| e.into_inner()).errors.len();
        v.push(if errs == 0 { Check { title: "Tool errors this session", state: CheckState::Ok, detail: "none".into(), fix: None } }
            else { Check { title: "Tool errors this session", state: CheckState::Warn, detail: format!("{errs} — see Activity › This session"), fix: Some(("Open Activity", Action::Go(Page::Activity))) } });
        v
    }

    pub(super) fn diagnostics_report(&self) -> String {
        let mut out = String::new();
        out.push_str("--- checks ---\n");
        for c in self.diagnostics_checks() {
            let st = match c.state { CheckState::Ok => "OK  ", CheckState::Warn => "WARN", CheckState::Bad => "BAD ", CheckState::Info => "INFO" };
            out.push_str(&format!("{st} {}: {}\n", c.title, c.detail));
        }
        out.push('\n');
        out.push_str(&self.diagnostics_text());
        out
    }

    pub(super) fn page_diagnostics(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let checks = self.diagnostics_checks();
        let n_ok = checks.iter().filter(|c| c.state == CheckState::Ok).count();
        let n_warn = checks.iter().filter(|c| c.state == CheckState::Warn).count();
        let n_bad = checks.iter().filter(|c| c.state == CheckState::Bad).count();
        let mut action: Option<Action> = None;
        let mut copy = false;
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = Vec2::new(8.0, 8.0);
            let (text, col) = if n_bad > 0 { (format!("{n_bad} problem(s)"), t.bad) } else if n_warn > 0 { (format!("{n_warn} warning(s)"), t.warn) } else { ("All checks pass".to_string(), t.ok) };
            status_chip(ui, t, &text.to_uppercase(), col, false);
            ui.label(RichText::new(format!("{n_ok} ok · {n_warn} warnings · {n_bad} problems · live, re-evaluated every frame")).small().color(t.muted));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if pill(ui, t, "Copy report", true).on_hover_text("Checks + diagnostics + last 40 log lines. No keys, no chat text.").clicked() { copy = true; }
                if ghost(ui, t, "Open log").clicked() { action = Some(Action::OpenLog); }
            });
        });
        ui.add_space(10.0);
        egui::ScrollArea::vertical().id_salt("diag-scroll").auto_shrink([false, false]).show(ui, |ui| {
            ui.set_max_width(ui.available_width() - 8.0);
            card(ui, t, |ui| {
                for (i, c) in checks.iter().enumerate() {
                    let col = match c.state { CheckState::Ok => t.ok, CheckState::Warn => t.warn, CheckState::Bad => t.bad, CheckState::Info => t.muted };
                    ui.horizontal(|ui| {
                        status_dot(ui, col);
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 1.0;
                            ui.label(RichText::new(c.title).strong().color(t.text));
                            ui.add(egui::Label::new(RichText::new(&c.detail).small().color(t.muted)).wrap());
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if let Some((label, a)) = c.fix { if pill(ui, t, label, c.state == CheckState::Bad).clicked() { action = Some(a); } }
                        });
                    });
                    if i + 1 < checks.len() {
                        ui.add_space(4.0);
                        let (line, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 1.0), Sense::hover());
                        ui.painter().rect_filled(line, Rounding::ZERO, t.border);
                        ui.add_space(4.0);
                    }
                }
            });
            ui.add_space(12.0);
            card(ui, t, |ui| {
                card_title(ui, t, "Environment", |_| {});
                let s = &self.shared;
                egui::Grid::new("diag-env").num_columns(2).spacing([16.0, 4.0]).min_row_height(22.0).show(ui, |ui| {
                    ui.label(RichText::new("Version").color(t.muted)); ui.label(format!("TotalScript Desktop {} · {} build", env!("CARGO_PKG_VERSION"), if cfg!(debug_assertions) { "debug" } else { "release" })); ui.end_row();
                    ui.label(RichText::new("System").color(t.muted)); ui.label(format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)); ui.end_row();
                    ui.label(RichText::new("Uptime").color(t.muted)); ui.label(human_duration(s.boot.elapsed())); ui.end_row();
                    ui.label(RichText::new("Ports").color(t.muted)); ui.label("http 127.0.0.1:3000 · ws 17613 roblox · ws 17615 local"); ui.end_row();
                    ui.label(RichText::new("Settings").color(t.muted)); ui.label(RichText::new(Settings::path().to_string_lossy().to_string()).monospace().small()); ui.end_row();
                    ui.label(RichText::new("Log").color(t.muted)); ui.label(RichText::new(log_path().to_string_lossy().to_string()).monospace().small()); ui.end_row();
                    ui.label(RichText::new("Tools").color(t.muted)); let tools = self.all_tools(); ui.label(format!("{} ({} Studio · {} local)", tools.len(), tools.iter().filter(|x| x.engine == "roblox").count(), self.local_tools.len())); ui.end_row();
                });
            });
        });
        if copy { let text = self.diagnostics_report(); ui.output_mut(|o| o.copied_text = text); self.toast("Diagnostics report copied to clipboard", true); }
        if let Some(a) = action { let ctx = ui.ctx().clone(); self.run_action(a, &ctx); }
    }
}

impl App {
    /// 26 px status bar under the pages: bridge · Studio · workspace on the
    /// left; running jobs, unread notices, palette hint and version on the right.
    pub(super) fn status_bar(&mut self, ctx: &egui::Context) {
        let t = self.theme;
        let s = self.shared.clone();
        let up = s.bridge_listening.load(Ordering::Relaxed) && s.fatal.lock().unwrap_or_else(|e| e.into_inner()).is_none();
        let linked = s.studio_connected.load(Ordering::Relaxed);
        let studio = s.studio_running.load(Ordering::Relaxed);
        let jobs = self.jobs().len();
        let unread = self.notices.unread();
        let mut goto: Option<Page> = None;
        let mut open_palette = false;
        let mut open_notices = false;
        egui::TopBottomPanel::bottom("statusbar")
            .exact_height(26.0)
            .frame(egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border)).inner_margin(Margin::symmetric(12.0, 0.0)))
            .show(ctx, |ui| {
                ui.allocate_ui_with_layout(ui.max_rect().size(), Layout::left_to_right(Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    let item = |ui: &mut egui::Ui, color: Color32, text: &str, tip: &str| -> egui::Response {
                        let resp = ui.horizontal(|ui| {
                            status_dot(ui, color);
                            ui.label(RichText::new(text).small().color(t.muted));
                        }).response;
                        let resp = resp.interact(Sense::click()).on_hover_text(tip);
                        if resp.hovered() { ui.output_mut(|o| o.cursor_icon = egui::CursorIcon::PointingHand); }
                        resp
                    };
                    if item(ui, if up { t.ok } else { t.bad }, if up { "Bridge online" } else { "Bridge offline" }, "http 3000 · ws 17613 · ws 17615 — click for Diagnostics").clicked() { goto = Some(Page::Diagnostics); }
                    ui.label(RichText::new("·").small().color(t.border2));
                    if item(ui, if linked { t.ok } else if studio { t.warn } else { t.muted }, if linked { "Studio linked" } else if studio { "Studio open, not linked" } else { "Studio closed" }, "Click for MCP Servers").clicked() { goto = Some(Page::Servers); }
                    ui.label(RichText::new("·").small().color(t.border2));
                    let root = s.root();
                    let ws = if root.is_empty() { "no workspace".to_string() } else { short_path(&root, 40) };
                    if item(ui, if s.workspace_ready.load(Ordering::Relaxed) { t.ok } else { t.warn }, &ws, &format!("{}\nClick for Settings › Workspace", if root.is_empty() { "No workspace folder yet" } else { root.as_str() })).clicked() { goto = Some(Page::Settings); self.settings_cat = SettingsCat::Workspace; }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 8.0;
                        ui.label(RichText::new(format!("v{}", env!("CARGO_PKG_VERSION"))).small().color(t.muted));
                        let pal = ui.add(egui::Label::new(RichText::new("Ctrl+K").small().monospace().color(t.muted)).sense(Sense::click())).on_hover_text("Command palette");
                        if pal.clicked() { open_palette = true; }
                        if unread > 0 {
                            let n = ui.add(egui::Label::new(RichText::new(format!("{unread} unread")).small().color(t.warn)).sense(Sense::click())).on_hover_text("Open notifications");
                            if n.clicked() { open_notices = true; }
                        }
                        if jobs > 0 {
                            let j = ui.add(egui::Label::new(RichText::new(format!("{jobs} running")).small().color(t.accent)).sense(Sense::click())).on_hover_text("Open Activity");
                            if j.clicked() { goto = Some(Page::Activity); }
                            spinner(ui, t, 12.0);
                        }
                    });
                });
            });
        if let Some(p) = goto { self.go(p); }
        if open_palette { self.open_palette(); }
        if open_notices { self.toggle_notices(); }
    }
}
