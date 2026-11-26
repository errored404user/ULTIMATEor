// SPDX-License-Identifier: GPL-3.0-or-later
//! TotalScript 4.0.0 Studio Suite overlay window inside TotalScript Desktop:
//!   1. Playtest Bot & Visual Regression
//!   2. Time-Machine Snapshots, Git & Rojo Sync
//!   3. Parallel Multi-Agent "Studio Squad"
//!   4. Visual Node / Game-Flow Architect & Live Telemetry Heatmap
//!   5. AI Asset Vault & Cross-Project Kitbash Library

use super::*;
use crate::v4_engine::{self, VaultAsset};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum V4Tab {
    Playtest,
    Sync,
    Squad,
    Architect,
    Vault,
}

impl V4Tab {
    const ALL: [V4Tab; 5] = [
        V4Tab::Playtest,
        V4Tab::Sync,
        V4Tab::Squad,
        V4Tab::Architect,
        V4Tab::Vault,
    ];
    fn label(self) -> &'static str {
        match self {
            V4Tab::Playtest => "Playtest Bot",
            V4Tab::Sync => "Git & Rojo Sync",
            V4Tab::Squad => "Studio Squad",
            V4Tab::Architect => "Architect Graph",
            V4Tab::Vault => "Asset Vault",
        }
    }
}

pub(super) struct V4SuiteState {
    pub open: bool,
    pub tab: V4Tab,
    pub snap_label: String,
    pub selected_snap: String,
    pub diff_preview: String,
    pub rojo_name: String,
    pub squad_goal: String,
    pub vault_query: String,
    pub vault_kind: String,
    pub new_asset_name: String,
    pub new_asset_kind: String,
    pub new_asset_summary: String,
    pub new_asset_payload: String,
    pub status_msg: String,
    // Cached disk sync status (avoid walking filesystem at 60 FPS inside egui render)
    cached_ws: String,
    sync_cache_at: Option<Instant>,
    cached_rojo: Option<v4_engine::RojoStatusInfo>,
    cached_snaps: Vec<v4_engine::SnapshotMeta>,
}

impl Default for V4SuiteState {
    fn default() -> Self {
        Self {
            open: false,
            tab: V4Tab::Playtest,
            snap_label: String::new(),
            selected_snap: String::new(),
            diff_preview: String::new(),
            rojo_name: "TotalScriptPlace".into(),
            squad_goal: String::new(),
            vault_query: String::new(),
            vault_kind: "all".into(),
            new_asset_name: String::new(),
            new_asset_kind: "luau".into(),
            new_asset_summary: String::new(),
            new_asset_payload: String::new(),
            status_msg: String::new(),
            cached_ws: String::new(),
            sync_cache_at: None,
            cached_rojo: None,
            cached_snaps: Vec::new(),
        }
    }
}

impl V4SuiteState {
    fn invalidate_sync_cache(&mut self) {
        self.sync_cache_at = None;
    }
    fn refresh_sync_if_stale(&mut self, ws: &str) {
        let stale = self.cached_ws != ws
            || self.sync_cache_at.map(|t| t.elapsed() >= Duration::from_secs(3)).unwrap_or(true);
        if stale {
            let root = PathBuf::from(ws);
            self.cached_ws = ws.to_string();
            self.cached_rojo = Some(v4_engine::rojo_status(&root));
            self.cached_snaps = v4_engine::list_snapshots(&root);
            self.sync_cache_at = Some(Instant::now());
        }
    }
}

impl App {
    pub(super) fn draw_v4_suite(&mut self, ctx: &egui::Context) {
        if !self.v4_suite.open {
            return;
        }
        let t = self.theme;
        let mut keep_open = self.v4_suite.open;
        let win_size = ctx.screen_rect().size();
        let w = (win_size.x - 80.0).clamp(620.0, 960.0);
        let h = (win_size.y - 90.0).clamp(440.0, 660.0);

        egui::Window::new("TotalScript 4.0 Studio Suite")
            .id(egui::Id::new("ts-v4-suite"))
            .open(&mut keep_open)
            .collapsible(false)
            .resizable(true)
            .default_size([w, h])
            .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
            .frame(
                egui::Frame::none()
                    .fill(t.bg)
                    .stroke(Stroke::new(1.0_f32, t.accent.gamma_multiply(0.5)))
                    .rounding(Rounding::same(t.r_card))
                    .inner_margin(Margin::same(16.0)),
            )
            .show(ctx, |ui| {
                // Header + Tab strip
                ui.horizontal_wrapped(|ui| {
                    for tab in V4Tab::ALL {
                        let on = self.v4_suite.tab == tab;
                        if pill(ui, t, tab.label(), on).clicked() {
                            self.v4_suite.tab = tab;
                            self.v4_suite.status_msg.clear();
                        }
                    }
                });
                if !self.v4_suite.status_msg.is_empty() {
                    ui.add_space(6.0);
                    ui.label(RichText::new(&self.v4_suite.status_msg).small().color(t.accent));
                }
                ui.add_space(8.0);
                ui.separator();
                ui.add_space(8.0);

                egui::ScrollArea::vertical().id_salt("v4-suite-body").show(ui, |ui| {
                    match self.v4_suite.tab {
                        V4Tab::Playtest => self.v4_tab_playtest(ui),
                        V4Tab::Sync => self.v4_tab_sync(ui),
                        V4Tab::Squad => self.v4_tab_squad(ui),
                        V4Tab::Architect => self.v4_tab_architect(ui),
                        V4Tab::Vault => self.v4_tab_vault(ui),
                    }
                });
            });

        self.v4_suite.open = keep_open;
    }

    fn v4_tab_playtest(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let (latest, runs, baselines) = {
            let pt = self.shared.v4.playtest.read().unwrap_or_else(|e| e.into_inner());
            (pt.history.first().cloned(), pt.history.len(), pt.baselines.len())
        };
        ui.label(RichText::new("Autonomous Playtest Bot & Visual Regression Engine").strong().size(15.0).color(t.text));
        ui.label(RichText::new("Runs scripted UI button sweeps, RemoteEvent exploit fuzzing, world smoke checks & visual baseline diffing inside Studio.").small().color(t.muted));
        ui.add_space(10.0);

        ui.horizontal_wrapped(|ui| {
            status_chip(ui, t, &format!("{runs} QA RUNS"), t.accent, false);
            status_chip(ui, t, &format!("{baselines} VISUAL BASELINES"), t.ok, false);
            if let Some(ref rep) = latest {
                let col = if rep.score >= 85 { t.ok } else if rep.score >= 60 { t.warn } else { t.bad };
                status_chip(ui, t, &format!("SCORE {}/100", rep.score), col, false);
                status_chip(ui, t, &format!("{:.0} FPS", rep.avg_fps), if rep.avg_fps >= 50.0 { t.ok } else { t.warn }, false);
            }
        });
        ui.add_space(10.0);

        if let Some(rep) = latest {
            egui::Frame::none()
                .fill(t.bg2)
                .stroke(Stroke::new(1.0_f32, t.border))
                .rounding(Rounding::same(t.r_card))
                .inner_margin(Margin::same(12.0))
                .show(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(RichText::new(format!("Latest Run ({})", rep.timestamp)).strong().color(t.text));
                        ui.label(RichText::new(format!("{} passed · {} failed · {} UI buttons · {} remotes fuzzed", rep.passed, rep.failed, rep.ui_buttons_tested, rep.remotes_fuzzed)).small().color(t.muted));
                    });
                    if let Some(d) = rep.visual_diff_pct {
                        ui.label(RichText::new(format!("Visual Regression Delta: {:.1}% vs baseline", d)).small().color(if d > 8.0 { t.warn } else { t.ok }));
                    }
                    ui.add_space(6.0);
                    for c in rep.checks.iter().take(12) {
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(if c.passed { "✓" } else { "✗" }).strong().color(if c.passed { t.ok } else { t.bad }));
                            ui.label(RichText::new(format!("[{}] {}", c.category, c.name)).strong().color(t.text));
                            ui.label(RichText::new(&c.detail).small().color(t.muted));
                        });
                    }
                    if !rep.fix_prompt.is_empty() {
                        ui.add_space(8.0);
                        if pill(ui, t, "Copy Autonomous Fix Brief", true).clicked() {
                            ui.ctx().copy_text(rep.fix_prompt.clone());
                            self.v4_suite.status_msg = "Copied Playtest Bot fix brief to clipboard — paste into AI chat.".into();
                        }
                    }
                });
        } else {
            ui.label(RichText::new("No Playtest Bot runs recorded yet. Launch the bot from the Extension 4.0 Hub (Playtest Bot tab) or POST /api/v4/playtest/report.").color(t.muted));
        }
    }

    fn v4_tab_sync(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let ws = self.shared.workspace_root.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let root = PathBuf::from(&ws);
        ui.label(RichText::new("Live Two-Way Git & Rojo / Time-Machine Sync Studio").strong().size(15.0).color(t.text));
        ui.label(RichText::new(format!("Active workspace: {}", if ws.is_empty() { "(not configured)" } else { &ws })).small().color(t.muted));
        ui.add_space(8.0);

        self.v4_suite.refresh_sync_if_stale(&ws);
        let rojo = self.v4_suite.cached_rojo.clone().unwrap_or(v4_engine::RojoStatusInfo {
            has_project_json: false,
            project_name: String::new(),
            src_scripts: 0,
            multi_place_count: 1,
        });
        let snaps = self.v4_suite.cached_snaps.clone();

        ui.horizontal_wrapped(|ui| {
            status_chip(ui, t, if rojo.has_project_json { "ROJO LINKED" } else { "NO ROJO FILE" }, if rojo.has_project_json { t.ok } else { t.muted }, false);
            status_chip(ui, t, &format!("{} SNAPSHOTS", snaps.len()), t.accent, false);
            status_chip(ui, t, &format!("{} LUAU FILES", rojo.src_scripts), t.text, false);
            if pill(ui, t, "Refresh", false).clicked() {
                self.v4_suite.invalidate_sync_cache();
            }
        });
        ui.add_space(10.0);

        // Snapshot + Rojo Controls
        ui.horizontal_wrapped(|ui| {
            ui.add(egui::TextEdit::singleline(&mut self.v4_suite.snap_label).hint_text("Snapshot label (e.g. Before Boss AI)…").desired_width(240.0));
            if pill(ui, t, "Create Snapshot", true).clicked() {
                match v4_engine::create_snapshot(&root, &self.v4_suite.snap_label) {
                    Ok(m) => {
                        self.v4_suite.snap_label.clear();
                        self.v4_suite.invalidate_sync_cache();
                        self.v4_suite.status_msg = format!("Saved Time-Machine snapshot '{}' ({} files).", m.label, m.file_count);
                    }
                    Err(e) => self.v4_suite.status_msg = format!("Snapshot error: {e}"),
                }
            }
            ui.add_space(8.0);
            ui.add(egui::TextEdit::singleline(&mut self.v4_suite.rojo_name).hint_text("Rojo Project Name").desired_width(160.0));
            if pill(ui, t, "Export Rojo Project", false).clicked() {
                match v4_engine::export_rojo_project(&root, &self.v4_suite.rojo_name, &[]) {
                    Ok(_) => {
                        self.v4_suite.invalidate_sync_cache();
                        self.v4_suite.status_msg = "Exported default.project.json + src/{server,client,shared} layout.".into();
                    }
                    Err(e) => self.v4_suite.status_msg = format!("Rojo export error: {e}"),
                }
            }
        });
        ui.add_space(10.0);

        if snaps.is_empty() {
            ui.label(RichText::new("No snapshots yet. Click 'Create Snapshot' before major AI refactors for 1-click diff & selective rollback.").color(t.muted));
        } else {
            for snap in snaps.iter().take(8) {
                egui::Frame::none()
                    .fill(t.bg2)
                    .stroke(Stroke::new(1.0_f32, t.border))
                    .rounding(Rounding::same(t.r_btn))
                    .inner_margin(Margin::same(10.0))
                    .show(ui, |ui| {
                        ui.horizontal_wrapped(|ui| {
                            ui.label(RichText::new(&snap.label).strong().color(t.text));
                            ui.label(RichText::new(format!("{} · {} files", snap.created_at, snap.file_count)).small().color(t.muted));
                            if pill(ui, t, "Diff", false).clicked() {
                                self.v4_suite.selected_snap = snap.id.clone();
                                match v4_engine::diff_snapshot(&root, &snap.id) {
                                    Ok(entries) => {
                                        if entries.is_empty() {
                                            self.v4_suite.diff_preview = "Workspace matches this snapshot (0 changes).".into();
                                        } else {
                                            self.v4_suite.diff_preview = entries.iter().take(6).map(|e| format!("=== [{}] {} ===\n{}", e.status.to_uppercase(), e.path, e.diff)).collect::<Vec<_>>().join("\n\n");
                                        }
                                    }
                                    Err(e) => self.v4_suite.diff_preview = format!("Diff failed: {e}"),
                                }
                            }
                            if pill(ui, t, "Restore All", false).clicked() {
                                match v4_engine::rollback_snapshot(&root, &snap.id, None) {
                                    Ok(n) => {
                                        self.v4_suite.invalidate_sync_cache();
                                        self.v4_suite.status_msg = format!("Restored {} file(s) from '{}'.", n, snap.label);
                                    }
                                    Err(e) => self.v4_suite.status_msg = format!("Rollback error: {e}"),
                                }
                            }
                        });
                    });
                ui.add_space(4.0);
            }
        }
        if !self.v4_suite.diff_preview.is_empty() {
            ui.add_space(8.0);
            ui.label(RichText::new(format!("Unified Diff ({})", self.v4_suite.selected_snap)).strong().color(t.accent));
            egui::Frame::none().fill(t.bg2).stroke(Stroke::new(1.0_f32, t.border)).rounding(Rounding::same(t.r_btn)).inner_margin(Margin::same(8.0)).show(ui, |ui| {
                ui.label(RichText::new(&self.v4_suite.diff_preview).monospace().small().color(t.text));
            });
        }
    }

    fn v4_tab_squad(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        ui.label(RichText::new("True Parallel Multi-Agent \"Studio Squad\"").strong().size(15.0).color(t.text));
        ui.label(RichText::new("Decompose complex Roblox + Blender + Animation builds across specialized concurrent roles with a shared Mission Board.").small().color(t.muted));
        ui.add_space(10.0);

        ui.horizontal_wrapped(|ui| {
            ui.add(egui::TextEdit::singleline(&mut self.v4_suite.squad_goal).hint_text("e.g. Build a medieval RPG lobby with Blender sword, shop & 3-hit combo…").desired_width(480.0));
            if pill(ui, t, "Launch Squad", true).clicked() && !self.v4_suite.squad_goal.trim().is_empty() {
                let mission = v4_engine::SquadMission::launch(&self.v4_suite.squad_goal, &[]);
                let n = mission.workers.len();
                *self.shared.v4.squad.write().unwrap_or_else(|e| e.into_inner()) = mission;
                self.v4_suite.status_msg = format!("Launched Studio Squad with {n} parallel specialists.");
            }
            if pill(ui, t, "Stop Squad", false).clicked() {
                let mut sq = self.shared.v4.squad.write().unwrap_or_else(|e| e.into_inner());
                sq.active = false;
                self.v4_suite.status_msg = "Studio Squad paused.".into();
            }
        });
        ui.add_space(10.0);

        let mission = self.shared.v4.squad.read().unwrap_or_else(|e| e.into_inner()).clone();
        if mission.workers.is_empty() {
            ui.label(RichText::new("No active squad mission. Enter a build goal above to auto-assign Blender 3D, Luau Engineer, UI/VFX, Rig Animator & QA Playtest specialists.").color(t.muted));
            return;
        }

        ui.horizontal_wrapped(|ui| {
            status_chip(ui, t, if mission.active { "SQUAD ACTIVE" } else { "SQUAD COMPLETE" }, if mission.active { t.accent } else { t.ok }, mission.active && self.settings.motion);
            status_chip(ui, t, &format!("{}% OVERALL", mission.overall_progress()), t.text, false);
            ui.label(RichText::new(&mission.goal).strong().color(t.text));
        });
        ui.add_space(8.0);

        for w in &mission.workers {
            egui::Frame::none()
                .fill(t.bg2)
                .stroke(Stroke::new(1.0_f32, t.border))
                .rounding(Rounding::same(t.r_card))
                .inner_margin(Margin::same(10.0))
                .show(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        let col = match w.status.as_str() {
                            "done" => t.ok,
                            "running" => t.accent,
                            "blocked" => t.bad,
                            _ => t.muted,
                        };
                        status_chip(ui, t, &w.status.to_uppercase(), col, false);
                        ui.label(RichText::new(&w.title).strong().color(t.text));
                        ui.label(RichText::new(format!("({} mode · {}%)", w.work_mode, w.progress)).small().color(t.muted));
                    });
                    ui.label(RichText::new(&w.task).small().color(t.text));
                    ui.label(RichText::new(&w.last_note).small().color(t.muted));
                });
            ui.add_space(6.0);
        }
    }

    fn v4_tab_architect(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        let graph = self.shared.v4.architect.read().unwrap_or_else(|e| e.into_inner()).clone();
        ui.label(RichText::new("Visual Node / Game-Flow Architect & Live Telemetry Heatmap").strong().size(15.0).color(t.text));
        ui.label(RichText::new("Live topology of Scripts, RemoteEvents, DataStores, UI Screens & Workspace hotspots. Red = security/error risk, Amber = layout/perf warning.").small().color(t.muted));
        ui.add_space(8.0);

        ui.horizontal_wrapped(|ui| {
            status_chip(ui, t, &format!("{} NODES", graph.nodes.len()), t.accent, false);
            status_chip(ui, t, &format!("{} EDGES", graph.edges.len()), t.text, false);
            status_chip(ui, t, &format!("{} RED RISKS", graph.red_count), if graph.red_count > 0 { t.bad } else { t.ok }, false);
            status_chip(ui, t, &format!("{} AMBER", graph.amber_count), if graph.amber_count > 0 { t.warn } else { t.muted }, false);
            if !graph.hotspots.is_empty() && pill(ui, t, "Copy Optimize Hotspots Prompt", true).clicked() {
                let items: Vec<String> = graph.hotspots.iter().map(|h| format!("- {} ({}, heat {}/100): {}", h.path, h.kind, h.heat, h.issue)).collect();
                ui.ctx().copy_text(format!("[TotalScript 4.0 Architect & Heatmap Optimization]\nFix and optimize these top Studio hotspots:\n{}\nVerify with script_check, perf_audit & playtest.", items.join("\n")));
                self.v4_suite.status_msg = "Copied Hotspot Optimization prompt to clipboard.".into();
            }
        });
        ui.add_space(10.0);

        // Interactive 2D Node Graph Canvas (dynamically sized to prevent node overlap)
        let mut col_totals = [0usize; 4];
        for n in graph.nodes.iter().take(24) {
            let col = match n.kind.as_str() {
                "ui" => 0,
                "remote" => 1,
                "script" | "localscript" | "module" => 2,
                _ => 3,
            };
            col_totals[col] += 1;
        }
        let max_col = col_totals.into_iter().max().unwrap_or(1).max(1);
        let canvas_w = ui.available_width().max(520.0);
        let canvas_h = (max_col as f32 * 52.0 + 48.0).max(240.0);
        let (rect, _) = ui.allocate_exact_size(Vec2::new(canvas_w, canvas_h), Sense::hover());
        let p = ui.painter_at(rect);
        p.rect_filled(rect, Rounding::same(t.r_card), t.bg2);
        p.rect_stroke(rect, Rounding::same(t.r_card), Stroke::new(1.0_f32, t.border));

        // Lay out nodes in columns by kind: ui -> remote -> script/module -> datastore/model
        let mut pos_map: std::collections::HashMap<String, Pos2> = std::collections::HashMap::new();
        let mut col_counts = [0usize; 4];
        for n in graph.nodes.iter().take(24) {
            let col = match n.kind.as_str() {
                "ui" => 0,
                "remote" => 1,
                "script" | "localscript" | "module" => 2,
                _ => 3,
            };
            let idx = col_counts[col];
            col_counts[col] += 1;
            let x = rect.left() + 86.0 + (col as f32) * ((canvas_w - 172.0) / 3.0);
            let y = rect.top() + 36.0 + (idx as f32) * 52.0;
            pos_map.insert(n.id.clone(), Pos2::new(x, y));
        }

        // Draw edges
        for e in &graph.edges {
            if let (Some(&a), Some(&b)) = (pos_map.get(&e.from), pos_map.get(&e.to)) {
                p.line_segment([a, b], Stroke::new(1.5_f32, t.accent.gamma_multiply(0.45)));
            }
        }
        // Draw nodes
        for n in graph.nodes.iter().take(20) {
            if let Some(&center) = pos_map.get(&n.id) {
                let border_col = match n.risk.as_str() {
                    "red" => t.bad,
                    "amber" => t.warn,
                    _ => t.ok,
                };
                let nrect = egui::Rect::from_center_size(center, Vec2::new(136.0, 36.0));
                p.rect_filled(nrect, Rounding::same(8.0), t.bg);
                p.rect_stroke(nrect, Rounding::same(8.0), Stroke::new(1.5_f32, border_col));
                let short: String = n.label.chars().take(16).collect();
                p.text(
                    Pos2::new(nrect.left() + 8.0, nrect.top() + 11.0),
                    egui::Align2::LEFT_CENTER,
                    short,
                    FontId::proportional(11.5),
                    t.text,
                );
                p.text(
                    Pos2::new(nrect.left() + 8.0, nrect.bottom() - 9.0),
                    egui::Align2::LEFT_CENTER,
                    format!("{} · heat {}", n.kind, n.heat),
                    FontId::monospace(9.5),
                    t.muted,
                );
            }
        }
    }

    fn v4_tab_vault(&mut self, ui: &mut egui::Ui) {
        let t = self.theme;
        ui.label(RichText::new("AI Asset Vault & Cross-Project Kitbash Library").strong().size(15.0).color(t.text));
        ui.label(RichText::new("Verified Luau systems, Blender PBR assets, UI kits, VFX presets & R15 combos ready for 1-click drop-in across any place.").small().color(t.muted));
        ui.add_space(8.0);

        ui.horizontal_wrapped(|ui| {
            ui.add(egui::TextEdit::singleline(&mut self.v4_suite.vault_query).hint_text("Search vault assets, tags, systems…").desired_width(240.0));
            for k in ["all", "luau", "blender", "ui", "vfx", "animation", "blockbench"] {
                let on = self.v4_suite.vault_kind == k;
                if pill(ui, t, &k.to_uppercase(), on).clicked() {
                    self.v4_suite.vault_kind = k.into();
                }
            }
        });
        ui.add_space(8.0);

        let items = self.shared.v4.vault.read().unwrap_or_else(|e| e.into_inner()).list(&self.v4_suite.vault_query, &self.v4_suite.vault_kind);
        for a in &items {
            egui::Frame::none()
                .fill(t.bg2)
                .stroke(Stroke::new(1.0_f32, t.border))
                .rounding(Rounding::same(t.r_card))
                .inner_margin(Margin::same(10.0))
                .show(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        status_chip(ui, t, &a.kind.to_uppercase(), t.accent, false);
                        status_chip(ui, t, &a.grade, t.ok, false);
                        if a.triangles > 0 {
                            status_chip(ui, t, &format!("{} TRIS", a.triangles), t.muted, false);
                        }
                        ui.label(RichText::new(&a.name).strong().color(t.text));
                        if pill(ui, t, "Copy Drop-In Spec", true).clicked() {
                            ui.ctx().copy_text(format!("[TotalScript Vault Asset: {} ({})]\n{}", a.name, a.kind, a.payload));
                            self.v4_suite.status_msg = format!("Copied '{}' drop-in prompt to clipboard.", a.name);
                        }
                    });
                    ui.label(RichText::new(&a.summary).small().color(t.muted));
                });
            ui.add_space(5.0);
        }

        ui.add_space(10.0);
        ui.separator();
        ui.add_space(6.0);
        ui.label(RichText::new("Save New Asset to Vault").strong().color(t.text));
        ui.horizontal_wrapped(|ui| {
            ui.add(egui::TextEdit::singleline(&mut self.v4_suite.new_asset_name).hint_text("Asset name").desired_width(180.0));
            ui.add(egui::TextEdit::singleline(&mut self.v4_suite.new_asset_kind).hint_text("luau|blender|ui|vfx|animation|blockbench").desired_width(140.0));
            ui.add(egui::TextEdit::singleline(&mut self.v4_suite.new_asset_summary).hint_text("Short description").desired_width(240.0));
        });
        ui.add_space(4.0);
        ui.horizontal_wrapped(|ui| {
            ui.add(egui::TextEdit::singleline(&mut self.v4_suite.new_asset_payload).hint_text("Verified prompt, Luau code, or Blender/Blockbench recipe…").desired_width(480.0));
            if pill(ui, t, "Save to Vault", true).clicked() && !self.v4_suite.new_asset_name.trim().is_empty() {
                let saved = self.shared.v4.vault.write().unwrap_or_else(|e| e.into_inner()).save(VaultAsset {
                    id: String::new(),
                    name: self.v4_suite.new_asset_name.trim().to_string(),
                    kind: if self.v4_suite.new_asset_kind.trim().is_empty() { "luau".into() } else { self.v4_suite.new_asset_kind.trim().to_lowercase() },
                    summary: self.v4_suite.new_asset_summary.trim().to_string(),
                    tags: vec!["custom".into()],
                    grade: "Verified".into(),
                    triangles: 0,
                    payload: self.v4_suite.new_asset_payload.trim().to_string(),
                    created_at: String::new(),
                    builtin: false,
                });
                self.v4_suite.new_asset_name.clear();
                self.v4_suite.new_asset_summary.clear();
                self.v4_suite.new_asset_payload.clear();
                self.v4_suite.status_msg = format!("Saved '{}' to local Asset Vault.", saved.name);
            }
        });
    }
}
