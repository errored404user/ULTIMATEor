// SPDX-License-Identifier: GPL-3.0-or-later
//! TotalScript 4.0.0 Core Platform Engine:
//!   1. PlaytestEngine  — Autonomous Playtest Bot reports & Visual Regression baselines
//!   2. SyncEngine      — Time-Machine Snapshots, Unified Diff, Selective Rollback, Rojo & Git
//!   3. SquadEngine     — True Parallel Multi-Agent "Studio Squad" mission board
//!   4. ArchitectEngine — Live DataModel Dependency Graph & 3D Performance Heatmap store
//!   5. VaultEngine     — Persistent Local AI Asset Vault & Cross-Project Kitbash Library

use axum::{extract::{Query, State}, response::IntoResponse, Json};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::RwLock,
};

use crate::{gui, AppState};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn now_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn short_id(prefix: &str) -> String {
    let ts = Utc::now().timestamp_millis();
    let mut rand = [0u8; 3];
    let _ = getrandom::getrandom(&mut rand);
    format!("{prefix}-{ts:x}-{:02x}{:02x}{:02x}", rand[0], rand[1], rand[2])
}

fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. AUTONOMOUS PLAYTEST BOT & VISUAL REGRESSION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlaytestCheck {
    pub name: String,
    pub category: String, // ui | remote_fuzz | world | perf | visual
    pub passed: bool,
    #[serde(default)]
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlaytestReport {
    pub id: String,
    pub timestamp: String,
    pub score: u8,
    pub passed: usize,
    pub failed: usize,
    pub ui_buttons_tested: usize,
    pub remotes_fuzzed: usize,
    pub prompts_checked: usize,
    pub avg_fps: f32,
    pub visual_diff_pct: Option<f32>,
    #[serde(default)]
    pub checks: Vec<PlaytestCheck>,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub fix_prompt: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VisualBaseline {
    pub name: String,
    pub hash: String,
    pub width: u32,
    pub height: u32,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PlaytestState {
    pub history: Vec<PlaytestReport>,
    pub baselines: HashMap<String, VisualBaseline>,
}

impl PlaytestState {
    pub fn record(&mut self, mut rep: PlaytestReport) -> PlaytestReport {
        if rep.id.is_empty() {
            rep.id = short_id("pt");
        }
        if rep.timestamp.is_empty() {
            rep.timestamp = now_iso();
        }
        rep.score = rep.score.min(100);
        rep.checks.truncate(64);
        rep.errors.truncate(40);
        if rep.fix_prompt.is_empty() && (rep.failed > 0 || !rep.errors.is_empty() || (rep.avg_fps > 0.0 && rep.avg_fps < 50.0)) {
            rep.fix_prompt = build_playtest_fix_prompt(&rep);
        }
        self.history.insert(0, rep.clone());
        self.history.truncate(24);
        rep
    }

    pub fn set_baseline(&mut self, name: String, data_b64_or_hash: &str, width: u32, height: u32) -> VisualBaseline {
        let hash = fnv1a_hex(data_b64_or_hash.as_bytes());
        let b = VisualBaseline {
            name: name.clone(),
            hash,
            width,
            height,
            updated_at: now_iso(),
        };
        self.baselines.insert(name, b.clone());
        b
    }
}

pub fn build_playtest_fix_prompt(rep: &PlaytestReport) -> String {
    let mut lines = vec![format!(
        "[TotalScript 4.0 Autonomous Playtest Bot — Score {}/100 | Passed {} | Failed {} | Avg FPS {:.1}]",
        rep.score, rep.passed, rep.failed, rep.avg_fps
    )];
    let failed_checks: Vec<String> = rep
        .checks
        .iter()
        .filter(|c| !c.passed)
        .take(8)
        .map(|c| format!("- [{}] {}: {}", c.category, c.name, c.detail))
        .collect();
    if !failed_checks.is_empty() {
        lines.push("Failed QA Checks:".into());
        lines.extend(failed_checks);
    }
    if !rep.errors.is_empty() {
        lines.push("Runtime Errors Captured:".into());
        for e in rep.errors.iter().take(6) {
            lines.push(format!("- {e}"));
        }
    }
    if let Some(d) = rep.visual_diff_pct {
        if d > 8.0 {
            lines.push(format!("Visual Regression: {:.1}% frame delta vs baseline — verify layout/camera/lighting.", d));
        }
    }
    lines.push("Fix every root cause above in Studio, verify with script_check + total_screenshot, and re-run the Playtest Bot until score >= 90 and 0 runtime errors.".into());
    lines.join("\n")
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. LIVE TWO-WAY GIT & ROJO / TIME-MACHINE SYNC STUDIO
// ═══════════════════════════════════════════════════════════════════════════

pub const SNAPSHOT_DIR: &str = ".totalscript-snapshots";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SnapshotMeta {
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub hashes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiffEntry {
    pub path: String,
    pub status: String, // added | modified | removed
    pub diff: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GitStatusInfo {
    pub is_repo: bool,
    pub branch: String,
    pub changed_files: Vec<String>,
    pub recent_commits: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RojoStatusInfo {
    pub has_project_json: bool,
    pub project_name: String,
    pub src_scripts: usize,
    pub multi_place_count: usize,
}

fn should_skip_sync_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | ".totalscript-backups" | ".totalscript-snapshots" | "dist" | "build" | ".next"
    )
}

fn collect_workspace_files(root: &Path, rel: &Path, out: &mut Vec<(String, PathBuf)>, cap: usize) {
    if out.len() >= cap {
        return;
    }
    let dir = if rel.as_os_str().is_empty() { root.to_path_buf() } else { root.join(rel) };
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if out.len() >= cap {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_sync_dir(&name) {
            continue;
        }
        let next_rel = if rel.as_os_str().is_empty() { PathBuf::from(&name) } else { rel.join(&name) };
        let path = entry.path();
        if path.is_dir() {
            collect_workspace_files(root, &next_rel, out, cap);
        } else if path.is_file() {
            if let Ok(meta) = entry.metadata() {
                if meta.len() <= 512 * 1024 {
                    out.push((next_rel.to_string_lossy().replace('\\', "/"), path));
                }
            }
        }
    }
}

pub fn create_snapshot(root: &Path, label: &str) -> Result<SnapshotMeta, String> {
    if !root.exists() {
        return Err("Workspace folder does not exist".into());
    }
    let id = short_id("snap");
    let snap_root = root.join(SNAPSHOT_DIR).join(&id);
    let files_dir = snap_root.join("files");
    std::fs::create_dir_all(&files_dir).map_err(|e| format!("create snapshot dir: {e}"))?;

    let mut files = Vec::new();
    collect_workspace_files(root, Path::new(""), &mut files, 400);
    let mut hashes = BTreeMap::new();
    let mut total_bytes = 0u64;

    for (rel, abs) in &files {
        if let Ok(bytes) = std::fs::read(abs) {
            total_bytes += bytes.len() as u64;
            hashes.insert(rel.clone(), fnv1a_hex(&bytes));
            let dst = files_dir.join(rel);
            if let Some(p) = dst.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let _ = std::fs::write(&dst, &bytes);
        }
    }

    let meta = SnapshotMeta {
        id: id.clone(),
        label: if label.trim().is_empty() { "Manual Snapshot".into() } else { label.trim().to_string() },
        created_at: now_iso(),
        file_count: hashes.len(),
        total_bytes,
        hashes,
    };
    let meta_json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(snap_root.join("meta.json"), meta_json).map_err(|e| format!("write meta: {e}"))?;
    // Prune oldest snapshots beyond 30 so disk usage stays bounded.
    let all_snaps = list_snapshots(root);
    if all_snaps.len() > 30 {
        for old in all_snaps.iter().skip(30) {
            let _ = std::fs::remove_dir_all(root.join(SNAPSHOT_DIR).join(&old.id));
        }
    }
    Ok(meta)
}

fn validate_snapshot_id(snapshot_id: &str) -> Result<(), String> {
    if snapshot_id.is_empty()
        || snapshot_id.len() > 64
        || snapshot_id.contains("..")
        || !snapshot_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid snapshot id".into());
    }
    Ok(())
}

pub fn list_snapshots(root: &Path) -> Vec<SnapshotMeta> {
    let dir = root.join(SNAPSHOT_DIR);
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut snaps = Vec::new();
    for entry in rd.flatten() {
        let meta_path = entry.path().join("meta.json");
        if let Ok(txt) = std::fs::read_to_string(meta_path) {
            if let Ok(meta) = serde_json::from_str::<SnapshotMeta>(&txt) {
                snaps.push(meta);
            }
        }
    }
    snaps.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    snaps.truncate(30);
    snaps
}

pub fn compute_unified_diff(old_txt: &str, new_txt: &str, max_lines: usize) -> String {
    let a: Vec<&str> = old_txt.lines().collect();
    let b: Vec<&str> = new_txt.lines().collect();
    let mut out = Vec::new();
    let n = a.len().max(b.len());
    for i in 0..n {
        if out.len() >= max_lines {
            out.push("… (diff truncated)".into());
            break;
        }
        match (a.get(i), b.get(i)) {
            (Some(la), Some(lb)) if la == lb => {}
            (Some(la), Some(lb)) => {
                out.push(format!("-{:>4} | {la}", i + 1));
                out.push(format!("+{:>4} | {lb}", i + 1));
            }
            (Some(la), None) => out.push(format!("-{:>4} | {la}", i + 1)),
            (None, Some(lb)) => out.push(format!("+{:>4} | {lb}", i + 1)),
            (None, None) => {}
        }
    }
    out.join("\n")
}

pub fn diff_snapshot(root: &Path, snapshot_id: &str) -> Result<Vec<DiffEntry>, String> {
    validate_snapshot_id(snapshot_id)?;
    let snap_root = root.join(SNAPSHOT_DIR).join(snapshot_id);
    let meta_txt = std::fs::read_to_string(snap_root.join("meta.json"))
        .map_err(|_| format!("Snapshot '{snapshot_id}' not found"))?;
    let meta: SnapshotMeta = serde_json::from_str(&meta_txt).map_err(|e| e.to_string())?;
    let files_dir = snap_root.join("files");

    let mut cur_files = Vec::new();
    collect_workspace_files(root, Path::new(""), &mut cur_files, 400);
    let mut cur_map: BTreeMap<String, PathBuf> = BTreeMap::new();
    for (rel, abs) in cur_files {
        cur_map.insert(rel, abs);
    }

    let mut diffs = Vec::new();
    for (rel, old_hash) in &meta.hashes {
        match cur_map.get(rel) {
            None => diffs.push(DiffEntry {
                path: rel.clone(),
                status: "removed".into(),
                diff: format!("(file removed since snapshot {})", meta.id),
            }),
            Some(abs) => {
                if let Ok(bytes) = std::fs::read(abs) {
                    if fnv1a_hex(&bytes) != *old_hash {
                        let old_txt = std::fs::read_to_string(files_dir.join(rel)).unwrap_or_default();
                        let new_txt = String::from_utf8_lossy(&bytes);
                        diffs.push(DiffEntry {
                            path: rel.clone(),
                            status: "modified".into(),
                            diff: compute_unified_diff(&old_txt, &new_txt, 60),
                        });
                    }
                }
            }
        }
    }
    for rel in cur_map.keys() {
        if !meta.hashes.contains_key(rel) {
            diffs.push(DiffEntry {
                path: rel.clone(),
                status: "added".into(),
                diff: format!("(new file added after snapshot {})", meta.id),
            });
        }
    }
    Ok(diffs)
}

pub fn rollback_snapshot(root: &Path, snapshot_id: &str, only_path: Option<&str>) -> Result<usize, String> {
    validate_snapshot_id(snapshot_id)?;
    let snap_root = root.join(SNAPSHOT_DIR).join(snapshot_id);
    let meta_txt = std::fs::read_to_string(snap_root.join("meta.json"))
        .map_err(|_| format!("Snapshot '{snapshot_id}' not found"))?;
    let meta: SnapshotMeta = serde_json::from_str(&meta_txt).map_err(|e| e.to_string())?;
    let files_dir = snap_root.join("files");

    let mut restored = 0usize;
    let targets: Vec<String> = match only_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => {
            let norm = p.replace('\\', "/");
            if norm.contains("..") || norm.starts_with('/') || norm.contains(':') {
                return Err("Unsafe rollback path".into());
            }
            if !meta.hashes.contains_key(&norm) {
                return Err(format!("Path '{norm}' was not in snapshot '{snapshot_id}'"));
            }
            vec![norm]
        }
        None => meta.hashes.keys().cloned().collect(),
    };

    for rel in targets {
        if rel.contains("..") || rel.starts_with('/') || rel.contains(':') {
            continue;
        }
        let src = files_dir.join(&rel);
        let dst = root.join(&rel);
        if let Ok(bytes) = std::fs::read(&src) {
            if let Some(p) = dst.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            std::fs::write(&dst, bytes).map_err(|e| format!("restore {rel}: {e}"))?;
            restored += 1;
        }
    }
    Ok(restored)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RojoScriptItem {
    pub service: String, // ServerScriptService | ReplicatedStorage | StarterPlayerScripts | StarterCharacterScripts | StarterGui
    pub name: String,
    pub class_name: String, // Script | LocalScript | ModuleScript
    pub source: String,
}

pub fn export_rojo_project(root: &Path, project_name: &str, scripts: &[RojoScriptItem]) -> Result<serde_json::Value, String> {
    if !root.exists() {
        return Err("Workspace folder does not exist".into());
    }
    let pname = if project_name.trim().is_empty() { "TotalScriptPlace" } else { project_name.trim() };
    let server_dir = root.join("src/server");
    let client_dir = root.join("src/client");
    let shared_dir = root.join("src/shared");
    for d in [&server_dir, &client_dir, &shared_dir] {
        std::fs::create_dir_all(d).map_err(|e| format!("mkdir {}: {e}", d.display()))?;
    }

    let mut written = Vec::new();
    for s in scripts {
        let safe_name: String = s.name.chars().map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
        if safe_name.is_empty() {
            continue;
        }
        let ext = match s.class_name.as_str() {
            "Script" => ".server.luau",
            "LocalScript" => ".client.luau",
            _ => ".luau",
        };
        let folder = match s.service.as_str() {
            "ServerScriptService" | "ServerStorage" => &server_dir,
            "StarterPlayerScripts" | "StarterCharacterScripts" | "StarterGui" => &client_dir,
            _ => &shared_dir,
        };
        let file = folder.join(format!("{safe_name}{ext}"));
        std::fs::write(&file, &s.source).map_err(|e| format!("write {}: {e}", file.display()))?;
        written.push(file.strip_prefix(root).unwrap_or(&file).to_string_lossy().replace('\\', "/"));
    }

    let proj = serde_json::json!({
        "name": pname,
        "tree": {
            "$className": "DataModel",
            "ReplicatedStorage": {
                "Shared": { "$path": "src/shared" }
            },
            "ServerScriptService": {
                "Server": { "$path": "src/server" }
            },
            "StarterPlayer": {
                "StarterPlayerScripts": {
                    "Client": { "$path": "src/client" }
                }
            }
        }
    });
    let proj_path = root.join("default.project.json");
    std::fs::write(&proj_path, serde_json::to_string_pretty(&proj).unwrap_or_default())
        .map_err(|e| format!("write default.project.json: {e}"))?;

    Ok(serde_json::json!({
        "ok": true,
        "project_file": "default.project.json",
        "project_name": pname,
        "scripts_written": written.len(),
        "files": written,
    }))
}

pub fn rojo_status(root: &Path) -> RojoStatusInfo {
    let proj_path = root.join("default.project.json");
    let has_project_json = proj_path.is_file();
    let project_name = if has_project_json {
        std::fs::read_to_string(&proj_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| "default.project.json".into())
    } else {
        String::new()
    };
    let mut src_files = Vec::new();
    if root.join("src").is_dir() {
        collect_workspace_files(root, Path::new("src"), &mut src_files, 300);
    }
    let src_scripts = src_files
        .iter()
        .filter(|(p, _)| p.ends_with(".lua") || p.ends_with(".luau"))
        .count();
    let multi_place_count = std::fs::read_to_string(root.join("places.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_array().map(|a| a.len()).or_else(|| v.get("places").and_then(|p| p.as_array()).map(|a| a.len())))
        .unwrap_or(1);
    RojoStatusInfo {
        has_project_json,
        project_name,
        src_scripts,
        multi_place_count,
    }
}

async fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args).current_dir(root);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().await.map_err(|e| format!("git spawn failed: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub async fn git_status(root: &Path) -> GitStatusInfo {
    let Ok(st) = run_git(root, &["status", "--porcelain=v1", "-b"]).await else {
        return GitStatusInfo {
            is_repo: false,
            branch: String::new(),
            changed_files: Vec::new(),
            recent_commits: Vec::new(),
        };
    };
    let mut branch = String::from("main");
    let mut changed_files = Vec::new();
    for (i, line) in st.lines().enumerate() {
        if i == 0 && line.starts_with("## ") {
            branch = line.trim_start_matches("## ").split("...").next().unwrap_or("main").to_string();
        } else if !line.trim().is_empty() {
            changed_files.push(line.to_string());
        }
    }
    let recent_commits = run_git(root, &["log", "-n", "6", "--oneline"])
        .await
        .map(|s| s.lines().map(|l| l.to_string()).collect())
        .unwrap_or_default();
    GitStatusInfo {
        is_repo: true,
        branch,
        changed_files,
        recent_commits,
    }
}

pub async fn git_commit(root: &Path, message: &str) -> Result<String, String> {
    let msg = if message.trim().is_empty() {
        "TotalScript 4.0 checkpoint"
    } else {
        message.trim()
    };
    run_git(root, &["add", "-A"]).await?;
    run_git(root, &["commit", "-m", msg]).await
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. TRUE PARALLEL MULTI-AGENT "STUDIO SQUAD"
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SquadWorker {
    pub id: String,
    pub role: String,
    pub title: String,
    pub work_mode: String,
    pub task: String,
    pub status: String, // queued | running | done | blocked
    pub progress: u8,
    pub last_note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SquadMission {
    pub id: String,
    pub goal: String,
    pub active: bool,
    pub started_at: String,
    pub workers: Vec<SquadWorker>,
    pub feed: Vec<String>,
}

impl Default for SquadMission {
    fn default() -> Self {
        Self {
            id: String::new(),
            goal: String::new(),
            active: false,
            started_at: String::new(),
            workers: Vec::new(),
            feed: Vec::new(),
        }
    }
}

impl SquadMission {
    pub fn launch(goal: &str, requested_roles: &[String]) -> Self {
        let lower = goal.to_lowercase();
        let mut roles: Vec<&str> = if requested_roles.is_empty() {
            let mut auto = vec!["luau", "ui_vfx"];
            if lower.contains("blender") || lower.contains("sword") || lower.contains("weapon") || lower.contains("model") || lower.contains("tavern") || lower.contains("map") || lower.contains("mesh") {
                auto.insert(0, "blender");
            }
            if lower.contains("anim") || lower.contains("combo") || lower.contains("rig") || lower.contains("cutscene") || lower.contains("combat") || lower.contains("walk") {
                auto.push("animator");
            }
            auto.push("qa_bot");
            auto
        } else {
            requested_roles.iter().map(|s| s.as_str()).collect()
        };
        if roles.is_empty() {
            roles = vec!["luau", "ui_vfx", "qa_bot"];
        }

        let workers: Vec<SquadWorker> = roles
            .into_iter()
            .map(|r| match r {
                "blender" => SquadWorker {
                    id: "blender".into(),
                    role: "blender".into(),
                    title: "Blender 3D Specialist".into(),
                    work_mode: "blender".into(),
                    task: format!("Model, validate, inspect & bake 3D hero assets for: {goal}"),
                    status: "running".into(),
                    progress: 15,
                    last_note: "Planning PBR asset spec & triangle budget".into(),
                },
                "animator" => SquadWorker {
                    id: "animator".into(),
                    role: "animator".into(),
                    title: "Rig Animator".into(),
                    work_mode: "animate".into(),
                    task: format!("Author R15/R6 clips, easing, markers & AnimPlayer hooks for: {goal}"),
                    status: "running".into(),
                    progress: 15,
                    last_note: "Inspecting target rig joints & Motor6D hierarchy".into(),
                },
                "ui_vfx" => SquadWorker {
                    id: "ui_vfx".into(),
                    role: "ui_vfx".into(),
                    title: "UI & VFX Artist".into(),
                    work_mode: "creation".into(),
                    task: format!("Build responsive Scale HUD, Future lighting & layered VFX for: {goal}"),
                    status: "running".into(),
                    progress: 20,
                    last_note: "Preparing design tokens & lighting mood stack".into(),
                },
                "qa_bot" => SquadWorker {
                    id: "qa_bot".into(),
                    role: "qa_bot".into(),
                    title: "QA Playtest Verifier".into(),
                    work_mode: "creation".into(),
                    task: format!("Run Autonomous Playtest Bot, bench_run & quality_audit for: {goal}"),
                    status: "queued".into(),
                    progress: 0,
                    last_note: "Waiting for build & script deliverables to settle".into(),
                },
                _ => SquadWorker {
                    id: "luau".into(),
                    role: "luau".into(),
                    title: "Luau Systems Engineer".into(),
                    work_mode: "creation".into(),
                    task: format!("Write server-authoritative Luau, DataStore & validated remotes for: {goal}"),
                    status: "running".into(),
                    progress: 20,
                    last_note: "Scaffolding services, remotes & strict modules".into(),
                },
            })
            .collect();

        let id = short_id("squad");
        let n = workers.len();
        Self {
            id,
            goal: goal.trim().to_string(),
            active: true,
            started_at: now_iso(),
            workers,
            feed: vec![format!("[{}] Squad launched with {} parallel specialists", now_iso(), n)],
        }
    }

    pub fn overall_progress(&self) -> u8 {
        if self.workers.is_empty() {
            return 0;
        }
        let sum: u32 = self.workers.iter().map(|w| w.progress as u32).sum();
        (sum / self.workers.len() as u32).min(100) as u8
    }

    pub fn update_worker(&mut self, worker_id: &str, status: Option<&str>, progress: Option<u8>, note: Option<&str>) -> bool {
        let Some(w) = self.workers.iter_mut().find(|w| w.id == worker_id || w.role == worker_id) else {
            return false;
        };
        if let Some(s) = status {
            w.status = s.to_string();
        }
        if let Some(p) = progress {
            w.progress = p.min(100);
        }
        if let Some(n) = note {
            w.last_note = n.to_string();
            self.feed.insert(0, format!("[{}] {}: {}", now_iso(), w.title, n));
            self.feed.truncate(40);
        }
        if self.workers.iter().all(|x| x.status == "done") {
            self.active = false;
        }
        true
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. VISUAL NODE / GAME-FLOW ARCHITECT & LIVE TELEMETRY HEATMAP
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArchNode {
    pub id: String,
    pub label: String,
    pub kind: String, // script | localscript | module | remote | ui | datastore | model
    pub path: String,
    pub risk: String, // green | amber | red
    #[serde(default)]
    pub heat: u8, // 0..100 performance heat score
    #[serde(default)]
    pub issue: String,
    #[serde(default)]
    pub metrics: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArchEdge {
    pub from: String,
    pub to: String,
    pub kind: String, // require | remote | datastore | ui
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArchGraph {
    pub scanned_at: String,
    pub nodes: Vec<ArchNode>,
    pub edges: Vec<ArchEdge>,
    pub red_count: usize,
    pub amber_count: usize,
    pub hotspots: Vec<ArchNode>,
}

impl Default for ArchGraph {
    fn default() -> Self {
        // Starter sample graph until the user runs a live Studio scan
        let nodes = vec![
            ArchNode { id: "sss_econ".into(), label: "EconomyServer".into(), kind: "script".into(), path: "ServerScriptService.EconomyServer".into(), risk: "green".into(), heat: 18, issue: String::new(), metrics: "142 lines · strict".into() },
            ArchNode { id: "rem_buy".into(), label: "BuyItem".into(), kind: "remote".into(), path: "ReplicatedStorage.Remotes.BuyItem".into(), risk: "green".into(), heat: 12, issue: String::new(), metrics: "Validated + rate-limited".into() },
            ArchNode { id: "ds_prof".into(), label: "PlayerProfiles".into(), kind: "datastore".into(), path: "DataStoreService.PlayerProfiles".into(), risk: "green".into(), heat: 10, issue: String::new(), metrics: "pcall + BindToClose".into() },
            ArchNode { id: "ui_shop".into(), label: "ShopGui".into(), kind: "ui".into(), path: "StarterGui.ShopGui".into(), risk: "green".into(), heat: 14, issue: String::new(), metrics: "Responsive Scale".into() },
        ];
        let edges = vec![
            ArchEdge { from: "ui_shop".into(), to: "rem_buy".into(), kind: "remote".into() },
            ArchEdge { from: "rem_buy".into(), to: "sss_econ".into(), kind: "remote".into() },
            ArchEdge { from: "sss_econ".into(), to: "ds_prof".into(), kind: "datastore".into() },
        ];
        Self {
            scanned_at: String::new(),
            nodes,
            edges,
            red_count: 0,
            amber_count: 0,
            hotspots: Vec::new(),
        }
    }
}

impl ArchGraph {
    pub fn recompute_stats(&mut self) {
        self.nodes.truncate(100);
        self.edges.truncate(300);
        self.red_count = self.nodes.iter().filter(|n| n.risk == "red").count();
        self.amber_count = self.nodes.iter().filter(|n| n.risk == "amber").count();
        let mut hot: Vec<ArchNode> = self.nodes.iter().filter(|n| n.heat >= 45 || n.risk == "red").cloned().collect();
        hot.sort_by(|a, b| b.heat.cmp(&a.heat));
        hot.truncate(8);
        self.hotspots = hot;
        if self.scanned_at.is_empty() {
            self.scanned_at = now_iso();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. AI ASSET VAULT & CROSS-PROJECT KITBASH LIBRARY
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VaultAsset {
    pub id: String,
    pub name: String,
    pub kind: String, // luau | blender | blockbench | ui | vfx | animation | model
    pub summary: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub grade: String, // A+ | A | B | Verified
    #[serde(default)]
    pub triangles: u32,
    pub payload: String,
    pub created_at: String,
    #[serde(default)]
    pub builtin: bool,
}

fn starter_vault_assets() -> Vec<VaultAsset> {
    let ts = "2026-01-01T00:00:00Z".to_string();
    vec![
        VaultAsset {
            id: "vault-datastore-profile".into(),
            name: "Session-Safe DataStore Profile".into(),
            kind: "luau".into(),
            summary: "Retry-hardened player profile manager with pcall, PlayerRemoving & BindToClose flush.".into(),
            tags: vec!["datastore".into(), "server".into(), "economy".into()],
            grade: "A+".into(),
            triangles: 0,
            payload: "Install a session-safe DataStore ProfileService-style ModuleScript in ServerScriptService.PlayerData with pcall exponential backoff, PlayerAdded load, PlayerRemoving save, game:BindToClose flush, and leaderstats sync. Verify with script_check + bench_run {suite:\"robustness\"}.".into(),
            created_at: ts.clone(),
            builtin: true,
        },
        VaultAsset {
            id: "vault-remote-router".into(),
            name: "Rate-Limited Remote Router".into(),
            kind: "luau".into(),
            summary: "Exploit-hardened RemoteEvent dispatcher with per-UserId token bucket & strict schema guards.".into(),
            tags: vec!["security".into(), "remotes".into(), "anti-exploit".into()],
            grade: "A+".into(),
            triangles: 0,
            payload: "Create ReplicatedStorage.Remotes and ServerScriptService.RemoteRouter with per-player rate limiting (cleaned up on PlayerRemoving), strict typeof/finite/range validation on every payload, and zero client trust. Verify with bench_run {suite:\"security\"}.".into(),
            created_at: ts.clone(),
            builtin: true,
        },
        VaultAsset {
            id: "vault-obsidian-hud".into(),
            name: "Obsidian Glass Responsive HUD".into(),
            kind: "ui".into(),
            summary: "Dark glass HUD + Shop + Quest tracker using strict Scale layout, design tokens & hover tweens.".into(),
            tags: vec!["hud".into(), "ui".into(), "mobile-safe".into()],
            grade: "A+".into(),
            triangles: 0,
            payload: "Build StarterGui.ObsidianHUD using design_tokens_set (dark obsidian surface #0D1320, electric aqua accent #22D3EE): Health/XP bar, Coins badge, Quest tracker, and toggleable Shop modal with strict Scale sizing (no Offset-only breakage). Verify with ui_audit + total_screenshot.".into(),
            created_at: ts.clone(),
            builtin: true,
        },
        VaultAsset {
            id: "vault-hero-longsword".into(),
            name: "Stylized Hero Longsword (PBR)".into(),
            kind: "blender".into(),
            summary: "1.2 m game-ready fantasy longsword with fuller, bronze guard, wrapped grip & baked 2K PBR maps.".into(),
            tags: vec!["weapon".into(), "sword".into(), "pbr".into()],
            grade: "Verified".into(),
            triangles: 1840,
            payload: "In Blender, plan and build a 1.2 m stylized fantasy longsword (steel blade with fuller, beveled bronze crossguard, leather-wrapped grip, faceted gem pommel) under 2000 triangles, validate + inspect iso/front/closeup, bake PBR maps, send to Studio & run mesh_import_verify.".into(),
            created_at: ts.clone(),
            builtin: true,
        },
        VaultAsset {
            id: "vault-dungeon-kit".into(),
            name: "4m Modular Stone Dungeon Kit".into(),
            kind: "blender".into(),
            summary: "Grid-snapped 4m×3m wall, doorway, window, pillar, arch & stairs sharing one stone/iron material set.".into(),
            tags: vec!["modular".into(), "environment".into(), "dungeon".into()],
            grade: "Verified".into(),
            triangles: 6400,
            payload: "In Blender, create a 4 m × 3 m modular stone dungeon kit (wall, doorway, window, corner pillar, archway, stairs) with origin at floor-center, shared stylized stone/iron materials, validate each piece, inspect an assembled bay, send to Studio & verify with mesh_import_verify.".into(),
            created_at: ts.clone(),
            builtin: true,
        },
        VaultAsset {
            id: "vault-3hit-combo".into(),
            name: "3-Hit R15 Melee Sword Combo".into(),
            kind: "animation".into(),
            summary: "Light slash, reverse slash & overhead finisher with anticipation, Hit markers & AnimPlayer chain.".into(),
            tags: vec!["combat".into(), "r15".into(), "combo".into()],
            grade: "Verified".into(),
            triangles: 0,
            payload: "Inspect the active R15 rig, author a 3-hit sword combo (Slash1, Slash2, OverheadFinisher) with anticipation/impact/follow-through, Hit markers on contact frames, animation_preview + animation_validate each clip, install AnimPlayer and wire combo chaining with stop-on-interrupt.".into(),
            created_at: ts.clone(),
            builtin: true,
        },
        VaultAsset {
            id: "vault-arcane-fireball".into(),
            name: "Arcane Fireball 5-Layer VFX".into(),
            kind: "vfx".into(),
            summary: "Core plasma emitter, outer ember trail, shockwave ring, flickering PointLight & impact SFX.".into(),
            tags: vec!["vfx".into(), "magic".into(), "particles".into()],
            grade: "A".into(),
            triangles: 0,
            payload: "Create a 5-layer Arcane Fireball VFX (core glow, ember sparks, magic circle ring, flickering PointLight, whoosh/impact SFX) with proper Size/Transparency NumberSequences, triggerable on cast, and capture mid-burst via total_screenshot.".into(),
            created_at: ts.clone(),
            builtin: true,
        },
        VaultAsset {
            id: "vault-bb-crate-barrel".into(),
            name: "Low-Poly Crate & Barrel (16u)".into(),
            kind: "blockbench".into(),
            summary: "16-unit stylized wooden crate & iron-banded barrel with clean pivots, flat textures & OBJ export.".into(),
            tags: vec!["low-poly".into(), "props".into(), "blockbench".into()],
            grade: "Verified".into(),
            triangles: 148,
            payload: "In Blockbench, build a 16-unit wooden crate and 12×16 iron-banded barrel with inset bevel detail, clean pivoted groups, cohesive 4-color wood/iron flat textures, inspect with bb_screenshot, and bb_export {format:\"obj\"} with Studio Import 3D steps.".into(),
            created_at: ts,
            builtin: true,
        },
    ]
}

pub struct VaultStore {
    path: PathBuf,
    assets: Vec<VaultAsset>,
}

impl VaultStore {
    pub fn load(base_dir: PathBuf) -> Self {
        let dir = base_dir.join("vault");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("index.json");
        let mut assets: Vec<VaultAsset> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        if assets.is_empty() {
            assets = starter_vault_assets();
            let _ = std::fs::write(&path, serde_json::to_string_pretty(&assets).unwrap_or_default());
        }
        Self { path, assets }
    }

    fn persist(&self) {
        if let Some(p) = self.path.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let _ = std::fs::write(&self.path, serde_json::to_string_pretty(&self.assets).unwrap_or_default());
    }

    pub fn list(&self, q: &str, kind: &str) -> Vec<VaultAsset> {
        let ql = q.trim().to_lowercase();
        let kl = kind.trim().to_lowercase();
        self.assets
            .iter()
            .filter(|a| {
                (kl.is_empty() || kl == "all" || a.kind.to_lowercase() == kl)
                    && (ql.is_empty()
                        || a.name.to_lowercase().contains(&ql)
                        || a.summary.to_lowercase().contains(&ql)
                        || a.tags.iter().any(|t| t.to_lowercase().contains(&ql)))
            })
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<VaultAsset> {
        self.assets.iter().find(|a| a.id == id).cloned()
    }

    pub fn save(&mut self, mut asset: VaultAsset) -> VaultAsset {
        if asset.id.trim().is_empty() {
            asset.id = short_id("vault");
        }
        if asset.created_at.is_empty() {
            asset.created_at = now_iso();
        }
        if asset.grade.is_empty() {
            asset.grade = "Verified".into();
        }
        if let Some(existing) = self.assets.iter_mut().find(|a| a.id == asset.id) {
            *existing = asset.clone();
        } else {
            self.assets.insert(0, asset.clone());
        }
        self.persist();
        asset
    }

    pub fn delete(&mut self, id: &str) -> bool {
        let before = self.assets.len();
        self.assets.retain(|a| a.id != id);
        if self.assets.len() != before {
            self.persist();
            true
        } else {
            false
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED V4 HUB (mounted on AppState & accessible from GUI + HTTP API)
// ═══════════════════════════════════════════════════════════════════════════

pub struct V4Hub {
    pub playtest: RwLock<PlaytestState>,
    pub squad: RwLock<SquadMission>,
    pub architect: RwLock<ArchGraph>,
    pub vault: RwLock<VaultStore>,
}

impl V4Hub {
    pub fn new() -> Self {
        let base = gui::data_dir();
        Self {
            playtest: RwLock::new(PlaytestState::default()),
            squad: RwLock::new(SquadMission::default()),
            architect: RwLock::new(ArchGraph::default()),
            vault: RwLock::new(VaultStore::load(base)),
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// AXUM HTTP HANDLERS (/api/v4/*)
// ═══════════════════════════════════════════════════════════════════════════

pub async fn overview_handler(State(state): State<AppState>) -> impl IntoResponse {
    let (pt_runs, pt_latest, pt_baselines) = {
        let pt = state.v4.playtest.read().unwrap_or_else(|e| e.into_inner());
        (pt.history.len(), pt.history.first().cloned(), pt.baselines.len())
    };
    let (sq_active, sq_goal, sq_prog, sq_workers, sq_feed) = {
        let sq = state.v4.squad.read().unwrap_or_else(|e| e.into_inner());
        (sq.active, sq.goal.clone(), sq.overall_progress(), sq.workers.clone(), sq.feed.clone())
    };
    let (ag_nodes, ag_edges, ag_red, ag_amber, ag_hot, ag_at) = {
        let ag = state.v4.architect.read().unwrap_or_else(|e| e.into_inner());
        (ag.nodes.len(), ag.edges.len(), ag.red_count, ag.amber_count, ag.hotspots.len(), ag.scanned_at.clone())
    };
    let vt_count = state.v4.vault.read().unwrap_or_else(|e| e.into_inner()).assets.len();
    let ws_root = PathBuf::from(state.workspace.root_display());
    let snaps = list_snapshots(&ws_root);
    let rojo = rojo_status(&ws_root);
    let git = git_status(&ws_root).await;
    Json(serde_json::json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "playtest": {
            "runs": pt_runs,
            "latest": pt_latest,
            "baselines": pt_baselines,
        },
        "sync": {
            "snapshots": snaps.len(),
            "latest_snapshot": snaps.first(),
            "rojo": rojo,
            "git": git,
        },
        "squad": {
            "active": sq_active,
            "goal": sq_goal,
            "progress": sq_prog,
            "workers": sq_workers,
            "feed": sq_feed,
        },
        "architect": {
            "nodes": ag_nodes,
            "edges": ag_edges,
            "red": ag_red,
            "amber": ag_amber,
            "hotspots": ag_hot,
            "scanned_at": ag_at,
        },
        "vault": {
            "count": vt_count,
        }
    }))
}

pub async fn playtest_status_handler(State(state): State<AppState>) -> impl IntoResponse {
    let pt = state.v4.playtest.read().unwrap_or_else(|e| e.into_inner());
    Json(serde_json::json!({
        "ok": true,
        "latest": pt.history.first(),
        "history": pt.history,
        "baselines": pt.baselines.values().cloned().collect::<Vec<_>>(),
    }))
}

pub async fn playtest_report_handler(State(state): State<AppState>, Json(rep): Json<PlaytestReport>) -> impl IntoResponse {
    let saved = state.v4.playtest.write().unwrap_or_else(|e| e.into_inner()).record(rep);
    state.ui.track("playtest-bot", &format!("score {}/100 ({} pass, {} fail)", saved.score, saved.passed, saved.failed));
    Json(serde_json::json!({ "ok": true, "report": saved }))
}

#[derive(Deserialize)]
pub struct BaselineReq {
    pub name: String,
    pub data: String,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
}

pub async fn playtest_baseline_handler(State(state): State<AppState>, Json(req): Json<BaselineReq>) -> impl IntoResponse {
    let b = state.v4.playtest.write().unwrap_or_else(|e| e.into_inner()).set_baseline(req.name, &req.data, req.width, req.height);
    Json(serde_json::json!({ "ok": true, "baseline": b }))
}

pub async fn sync_status_handler(State(state): State<AppState>) -> impl IntoResponse {
    let root = PathBuf::from(state.workspace.root_display());
    let snaps = list_snapshots(&root);
    let rojo = rojo_status(&root);
    let git = git_status(&root).await;
    Json(serde_json::json!({ "ok": true, "workspace": state.workspace.root_display(), "snapshots": snaps, "rojo": rojo, "git": git }))
}

#[derive(Deserialize)]
pub struct SnapReq {
    #[serde(default)]
    pub label: String,
}

pub async fn sync_snapshot_handler(State(state): State<AppState>, Json(req): Json<SnapReq>) -> impl IntoResponse {
    let root = PathBuf::from(state.workspace.root_display());
    match create_snapshot(&root, &req.label) {
        Ok(meta) => {
            state.ui.track("sync", &format!("snapshot {} ({} files)", meta.label, meta.file_count));
            Json(serde_json::json!({ "ok": true, "snapshot": meta }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize)]
pub struct DiffReq {
    pub snapshot_id: String,
}

pub async fn sync_diff_handler(State(state): State<AppState>, Json(req): Json<DiffReq>) -> impl IntoResponse {
    let root = PathBuf::from(state.workspace.root_display());
    match diff_snapshot(&root, &req.snapshot_id) {
        Ok(entries) => Json(serde_json::json!({ "ok": true, "entries": entries })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize)]
pub struct RollbackReq {
    pub snapshot_id: String,
    #[serde(default)]
    pub path: Option<String>,
}

pub async fn sync_rollback_handler(State(state): State<AppState>, Json(req): Json<RollbackReq>) -> impl IntoResponse {
    let root = PathBuf::from(state.workspace.root_display());
    match rollback_snapshot(&root, &req.snapshot_id, req.path.as_deref()) {
        Ok(n) => {
            state.ui.track("sync", &format!("rolled back {} file(s) from {}", n, req.snapshot_id));
            Json(serde_json::json!({ "ok": true, "restored": n }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize)]
pub struct RojoExportReq {
    #[serde(default)]
    pub project_name: String,
    #[serde(default)]
    pub scripts: Vec<RojoScriptItem>,
}

pub async fn sync_rojo_export_handler(State(state): State<AppState>, Json(req): Json<RojoExportReq>) -> impl IntoResponse {
    let root = PathBuf::from(state.workspace.root_display());
    match export_rojo_project(&root, &req.project_name, &req.scripts) {
        Ok(val) => {
            state.ui.track("rojo", &format!("exported default.project.json ({} scripts)", req.scripts.len()));
            Json(val)
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Deserialize)]
pub struct GitCommitReq {
    #[serde(default)]
    pub message: String,
}

pub async fn sync_git_commit_handler(State(state): State<AppState>, Json(req): Json<GitCommitReq>) -> impl IntoResponse {
    let root = PathBuf::from(state.workspace.root_display());
    match git_commit(&root, &req.message).await {
        Ok(out) => {
            state.ui.track("git", &format!("commit: {}", req.message.chars().take(48).collect::<String>()));
            Json(serde_json::json!({ "ok": true, "output": out }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

pub async fn squad_status_handler(State(state): State<AppState>) -> impl IntoResponse {
    let sq = state.v4.squad.read().unwrap_or_else(|e| e.into_inner());
    Json(serde_json::json!({
        "ok": true,
        "mission": &*sq,
        "progress": sq.overall_progress(),
    }))
}

#[derive(Deserialize)]
pub struct SquadLaunchReq {
    pub goal: String,
    #[serde(default)]
    pub roles: Vec<String>,
}

pub async fn squad_launch_handler(State(state): State<AppState>, Json(req): Json<SquadLaunchReq>) -> impl IntoResponse {
    let mission = SquadMission::launch(&req.goal, &req.roles);
    let n = mission.workers.len();
    *state.v4.squad.write().unwrap_or_else(|e| e.into_inner()) = mission.clone();
    state.ui.track("squad", &format!("launched {} workers for '{}'", n, req.goal.chars().take(40).collect::<String>()));
    Json(serde_json::json!({ "ok": true, "mission": mission, "progress": mission.overall_progress() }))
}

#[derive(Deserialize)]
pub struct SquadUpdateReq {
    pub worker_id: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub progress: Option<u8>,
    #[serde(default)]
    pub note: Option<String>,
}

pub async fn squad_update_handler(State(state): State<AppState>, Json(req): Json<SquadUpdateReq>) -> impl IntoResponse {
    let mut sq = state.v4.squad.write().unwrap_or_else(|e| e.into_inner());
    let ok = sq.update_worker(&req.worker_id, req.status.as_deref(), req.progress, req.note.as_deref());
    Json(serde_json::json!({ "ok": ok, "mission": &*sq, "progress": sq.overall_progress() }))
}

pub async fn squad_stop_handler(State(state): State<AppState>) -> impl IntoResponse {
    let mut sq = state.v4.squad.write().unwrap_or_else(|e| e.into_inner());
    sq.active = false;
    for w in &mut sq.workers {
        if w.status == "running" || w.status == "queued" {
            w.status = "blocked".into();
            w.last_note = "Stopped by user".into();
        }
    }
    sq.feed.insert(0, format!("[{}] Squad stopped by user", now_iso()));
    Json(serde_json::json!({ "ok": true, "mission": &*sq }))
}

pub async fn architect_get_handler(State(state): State<AppState>) -> impl IntoResponse {
    let ag = state.v4.architect.read().unwrap_or_else(|e| e.into_inner());
    Json(serde_json::json!({ "ok": true, "graph": &*ag }))
}

pub async fn architect_post_handler(State(state): State<AppState>, Json(mut graph): Json<ArchGraph>) -> impl IntoResponse {
    graph.recompute_stats();
    let summary = format!("{} nodes ({} red, {} amber)", graph.nodes.len(), graph.red_count, graph.amber_count);
    *state.v4.architect.write().unwrap_or_else(|e| e.into_inner()) = graph.clone();
    state.ui.track("architect", &summary);
    Json(serde_json::json!({ "ok": true, "graph": graph }))
}

pub async fn vault_list_handler(State(state): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let query = q.get("q").map(String::as_str).unwrap_or("");
    let kind = q.get("kind").map(String::as_str).unwrap_or("");
    let items = state.v4.vault.read().unwrap_or_else(|e| e.into_inner()).list(query, kind);
    Json(serde_json::json!({ "ok": true, "assets": items }))
}

pub async fn vault_get_handler(State(state): State<AppState>, Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    let id = q.get("id").map(String::as_str).unwrap_or("");
    match state.v4.vault.read().unwrap_or_else(|e| e.into_inner()).get(id) {
        Some(a) => Json(serde_json::json!({ "ok": true, "asset": a })),
        None => Json(serde_json::json!({ "ok": false, "error": "Asset not found" })),
    }
}

pub async fn vault_save_handler(State(state): State<AppState>, Json(asset): Json<VaultAsset>) -> impl IntoResponse {
    let saved = state.v4.vault.write().unwrap_or_else(|e| e.into_inner()).save(asset);
    state.ui.track("vault", &format!("saved '{}' ({})", saved.name, saved.kind));
    Json(serde_json::json!({ "ok": true, "asset": saved }))
}

#[derive(Deserialize)]
pub struct VaultDeleteReq {
    pub id: String,
}

pub async fn vault_delete_handler(State(state): State<AppState>, Json(req): Json<VaultDeleteReq>) -> impl IntoResponse {
    let ok = state.v4.vault.write().unwrap_or_else(|e| e.into_inner()).delete(&req.id);
    Json(serde_json::json!({ "ok": ok }))
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIT TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("totalscript-v4-test-{tag}-{}", short_id("t")));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    #[test]
    fn playtest_bot_records_and_builds_fix_prompt() {
        let mut st = PlaytestState::default();
        let b = st.set_baseline("spawn_view".into(), "frame_a_bytes", 1280, 720);
        assert!(!b.hash.is_empty());
        let saved = st.record(PlaytestReport {
            id: String::new(),
            timestamp: String::new(),
            score: 62,
            passed: 5,
            failed: 2,
            ui_buttons_tested: 6,
            remotes_fuzzed: 4,
            prompts_checked: 2,
            avg_fps: 41.2,
            visual_diff_pct: Some(14.5),
            checks: vec![PlaytestCheck {
                name: "BuyItem fuzz".into(),
                category: "remote_fuzz".into(),
                passed: false,
                detail: "Accepted negative amount -999999".into(),
            }],
            errors: vec!["ServerScriptService.Shop:42: attempt to index nil".into()],
            fix_prompt: String::new(),
        });
        assert_eq!(st.history.len(), 1);
        assert!(saved.fix_prompt.contains("BuyItem fuzz"));
        assert!(saved.fix_prompt.contains("14.5%"));
        assert!(saved.fix_prompt.contains("ServerScriptService.Shop:42"));
    }

    #[test]
    fn sync_snapshot_diff_selective_rollback_and_rojo_export() {
        let root = temp_dir("sync");
        std::fs::write(root.join("a.luau"), "local x = 1\nreturn x\n").unwrap();
        std::fs::write(root.join("b.luau"), "local y = 2\n").unwrap();

        let snap = create_snapshot(&root, "Before Shop").unwrap();
        assert_eq!(snap.file_count, 2);

        // Mutate a.luau and add c.luau
        std::fs::write(root.join("a.luau"), "local x = 999\nreturn x\n").unwrap();
        std::fs::write(root.join("c.luau"), "local z = 3\n").unwrap();

        let diffs = diff_snapshot(&root, &snap.id).unwrap();
        assert!(diffs.iter().any(|d| d.path == "a.luau" && d.status == "modified" && d.diff.contains("999")));
        assert!(diffs.iter().any(|d| d.path == "c.luau" && d.status == "added"));

        // Selective rollback of a.luau only (leaves c.luau intact)
        let restored = rollback_snapshot(&root, &snap.id, Some("a.luau")).unwrap();
        assert_eq!(restored, 1);
        assert_eq!(std::fs::read_to_string(root.join("a.luau")).unwrap(), "local x = 1\nreturn x\n");
        assert!(root.join("c.luau").exists());

        // Rojo export
        let r = export_rojo_project(&root, "MyRPG", &[
            RojoScriptItem { service: "ServerScriptService".into(), name: "Combat".into(), class_name: "Script".into(), source: "--!strict\nprint('ok')".into() },
            RojoScriptItem { service: "ReplicatedStorage".into(), name: "Config".into(), class_name: "ModuleScript".into(), source: "return {}".into() },
        ]).unwrap();
        assert_eq!(r["scripts_written"], 2);
        let rs = rojo_status(&root);
        assert!(rs.has_project_json);
        assert_eq!(rs.project_name, "MyRPG");
        assert_eq!(rs.src_scripts, 2);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn studio_squad_auto_decomposes_and_tracks_progress() {
        let mut sq = SquadMission::launch("Build a medieval RPG lobby with a custom Blender sword and 3-hit combat animation", &[]);
        assert!(sq.active);
        assert!(sq.workers.iter().any(|w| w.role == "blender"));
        assert!(sq.workers.iter().any(|w| w.role == "animator"));
        assert!(sq.workers.iter().any(|w| w.role == "luau"));
        assert!(sq.workers.iter().any(|w| w.role == "qa_bot"));

        for id in sq.workers.iter().map(|w| w.id.clone()).collect::<Vec<_>>() {
            assert!(sq.update_worker(&id, Some("done"), Some(100), Some("Verified")));
        }
        assert_eq!(sq.overall_progress(), 100);
        assert!(!sq.active);
    }

    #[test]
    fn vault_seeds_starters_and_persists_crud() {
        let dir = temp_dir("vault");
        let mut store = VaultStore::load(dir.clone());
        assert!(store.list("", "").len() >= 8);
        assert!(!store.list("sword", "blender").is_empty());

        let saved = store.save(VaultAsset {
            id: String::new(),
            name: "Custom Boss AI".into(),
            kind: "luau".into(),
            summary: "State-machine boss controller".into(),
            tags: vec!["ai".into(), "boss".into()],
            grade: "A+".into(),
            triangles: 0,
            payload: "Boss script spec".into(),
            created_at: String::new(),
            builtin: false,
        });
        assert!(store.get(&saved.id).is_some());

        // Reload from disk to verify persistence
        let reloaded = VaultStore::load(dir.clone());
        assert!(reloaded.get(&saved.id).is_some());
        assert!(store.delete(&saved.id));
        assert!(store.get(&saved.id).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
