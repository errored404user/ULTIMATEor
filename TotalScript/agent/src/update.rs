//! 2.17.0 — auto-updater.
//!
//! Releases are GitHub Releases of `errored404user/ULTIMATEor`, published by
//! `.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed:
//!   * `latest.json`                — version, tag, notes url, assets with sha256
//!   * `TotalScript-extension.tar`  — the unpacked extension folder (plain ustar,
//!                                    `TotalScript/…`, with the fresh binaries in bin/)
//!   * `TotalScript.zip`            — the same for humans
//!   * `total-core-windows-x64.exe`, `total-core-macos-arm64` — this app
//!   * `SHA256SUMS.txt`
//!
//! What this module does, and only when asked (Settings → Updates, or the
//! extension's Update button → `POST /api/update/apply`):
//!   1. `check()`   GET latest.json (cached 6 h, the daily task calls it once a day).
//!   2. extension   download the tar → sha256 == latest.json → unpack into a temp
//!                  stage → manifest.json version == release → copy every file
//!                  over the extension folder (never `agent/target`, never the
//!                  running binary; overwritten files are backed up under the temp
//!                  dir) → receipt `.totalscript-updated.json`.
//!   3. app         download the binary for this OS/arch → sha256 → write
//!                  `total-core.new` next to the running exe → rename exe → `.old`,
//!                  new → exe → spawn a delayed relaunch → the caller exits.
//! The Studio plugin needs nothing: the new binary embeds the new plugin and
//! `plugin::install()` rewrites it on the next start.
//!
//! No new crates: sha256 is implemented below (FIPS 180-4, tested against the
//! standard vectors), the tar reader handles ustar (what GNU tar writes with
//! `--format=ustar`; the release workflow fails on names it cannot store).
//! Integrity = sha256 from latest.json over GitHub TLS — it catches truncated
//! or swapped downloads, it is not a signature.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const RELEASES_URL: &str = "https://github.com/errored404user/ULTIMATEor/releases";
pub const LATEST_JSON_URL: &str = "https://github.com/errored404user/ULTIMATEor/releases/latest/download/latest.json";
pub const EXTENSION_ASSET: &str = "TotalScript-extension.tar";
pub const CHECK_TTL: Duration = Duration::from_secs(6 * 3600);
pub const DAILY: Duration = Duration::from_secs(24 * 3600);
const MAX_ASSET_BYTES: u64 = 400 * 1024 * 1024;
const TAR_ROOT: &str = "TotalScript";
/// Directories inside the extension folder the updater never writes or
/// deletes: the Rust build tree (the running binary may live there) and anything
/// the user keeps next to the extension.
const SKIP_PREFIXES: &[&str] = &["agent/target/", ".git/", "node_modules/", "ui/snapshots/"];

/// Asset this build would install over itself (None = no prebuilt binary for
/// this platform; rebuild from source).
pub fn app_asset_name() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) { Some("total-core-windows-x64.exe") }
    else if cfg!(all(target_os = "macos", target_arch = "aarch64")) { Some("total-core-macos-arm64") }
    else if cfg!(all(target_os = "macos", target_arch = "x86_64")) { Some("total-core-macos-x64") }
    else { None }
}

// ───────────────────────── latest.json ─────────────────────────

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Asset {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Latest {
    pub version: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub notes_url: String,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

impl Latest {
    /// Parse + normalise. Err when there is no usable version.
    pub fn parse(text: &str) -> Result<Latest, String> {
        let mut l: Latest = serde_json::from_str(text).map_err(|e| format!("latest.json unreadable: {e}"))?;
        l.version = l.version.trim().trim_start_matches('v').to_string();
        if parse_version(&l.version).is_none() { return Err(format!("latest.json has no version (got {:?})", l.version)); }
        if l.tag.trim().is_empty() { l.tag = format!("v{}", l.version); }
        if l.notes_url.trim().is_empty() || !l.notes_url.starts_with("https://github.com/") { l.notes_url = format!("{RELEASES_URL}/tag/{}", l.tag); }
        for a in &mut l.assets {
            a.sha256 = a.sha256.trim().to_ascii_lowercase();
            if a.sha256.len() != 64 || !a.sha256.bytes().all(|b| b.is_ascii_hexdigit()) { a.sha256.clear(); }
            if !(a.url.starts_with("https://github.com/") || a.url.starts_with("https://objects.githubusercontent.com/")) { a.url.clear(); }
            if a.url.is_empty() { a.url = format!("{RELEASES_URL}/download/{}/{}", l.tag, a.name); }
        }
        Ok(l)
    }
    pub fn asset(&self, name: &str) -> Option<&Asset> { self.assets.iter().find(|a| a.name == name) }
}

/// "v2.18.0" / "2.18.0" / "2.18.0-beta" → (2, 18, 0).
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let core: String = v.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let mut it = core.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c = it.next()?.parse().ok()?;
    Some((a, b, c))
}

/// true when `latest` is strictly newer than `current` (unparsable = false).
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

// ───────────────────────── sha256 (FIPS 180-4) ─────────────────────────

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// Streaming SHA-256 so a 40 MB download never needs a second copy.
pub struct Sha256 { h: [u32; 8], buf: Vec<u8>, len: u64 }

impl Default for Sha256 { fn default() -> Self { Self::new() } }

impl Sha256 {
    pub fn new() -> Self {
        Self { h: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], buf: Vec::with_capacity(128), len: 0 }
    }
    pub fn update(&mut self, data: &[u8]) {
        self.len = self.len.wrapping_add(data.len() as u64);
        self.buf.extend_from_slice(data);
        let full = self.buf.len() / 64 * 64;
        let mut i = 0;
        while i < full { Self::block(&mut self.h, &self.buf[i..i + 64]); i += 64; }
        self.buf.drain(..full);
    }
    pub fn finish(mut self) -> [u8; 32] {
        let bits = self.len.wrapping_mul(8);
        let mut tail = std::mem::take(&mut self.buf);
        tail.push(0x80);
        while tail.len() % 64 != 56 { tail.push(0); }
        tail.extend_from_slice(&bits.to_be_bytes());
        for chunk in tail.chunks(64) { Self::block(&mut self.h, chunk); }
        let mut out = [0u8; 32];
        for (i, w) in self.h.iter().enumerate() { out[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes()); }
        out
    }
    pub fn finish_hex(self) -> String { hex(&self.finish()) }
    fn block(h: &mut [u32; 8], chunk: &[u8]) {
        let mut w = [0u32; 64];
        for i in 0..16 { w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]); }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = *h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g; g = f; f = e; e = d.wrapping_add(t1); d = c; c = b; b = a; a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a); h[1] = h[1].wrapping_add(b); h[2] = h[2].wrapping_add(c); h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e); h[5] = h[5].wrapping_add(f); h[6] = h[6].wrapping_add(g); h[7] = h[7].wrapping_add(hh);
    }
}

#[allow(dead_code)]
pub fn sha256_hex(data: &[u8]) -> String { let mut s = Sha256::new(); s.update(data); s.finish_hex() }
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

/// `SHA256SUMS.txt` lines (`<hex>  <name>` or `<hex> *<name>`) → name → hex.
#[allow(dead_code)]
pub fn parse_sha256sums(text: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let mut it = line.splitn(2, char::is_whitespace);
        let (Some(hash), Some(rest)) = (it.next(), it.next()) else { continue };
        let name = rest.trim().trim_start_matches('*').trim();
        if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) && !name.is_empty() {
            m.insert(name.to_string(), hash.to_ascii_lowercase());
        }
    }
    m
}

// ───────────────────────── ustar reader ─────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct TarEntry { pub path: String, pub data: Vec<u8>, pub mode: u32 }

fn octal(field: &[u8]) -> u64 {
    let s: String = field.iter().take_while(|b| **b != 0 && **b != b' ').map(|b| *b as char).collect();
    u64::from_str_radix(s.trim(), 8).unwrap_or(0)
}
fn cstr(field: &[u8]) -> String {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).to_string()
}

/// Read every regular file of a ustar / GNU (short-name) archive. Directories,
/// symlinks and anything else are skipped; GNU long-name records ('L') are
/// honoured; an entry whose name escapes (`..`, absolute, drive) is an error,
/// so a hostile archive can never write outside the stage.
pub fn read_tar(bytes: &[u8]) -> Result<Vec<TarEntry>, String> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    let mut long_name: Option<String> = None;
    while pos + 512 <= bytes.len() {
        let hdr = &bytes[pos..pos + 512];
        if hdr.iter().all(|b| *b == 0) { break; } // end-of-archive zero block(s)
        let size = octal(&hdr[124..136]) as usize;
        let typeflag = hdr[156];
        let name = {
            let n = cstr(&hdr[0..100]);
            let magic = &hdr[257..262];
            let prefix = if magic == b"ustar" { cstr(&hdr[345..500]) } else { String::new() };
            if prefix.is_empty() { n } else { format!("{prefix}/{n}") }
        };
        let data_start = pos + 512;
        let data_end = data_start.checked_add(size).ok_or("tar: size overflow")?;
        if data_end > bytes.len() { return Err(format!("tar: entry {name:?} is truncated")); }
        let data = &bytes[data_start..data_end];
        match typeflag {
            b'L' => { long_name = Some(cstr(data)); }
            b'0' | 0 => {
                let path = long_name.take().unwrap_or(name);
                let path = path.replace('\\', "/");
                safe_relative(&path)?;
                out.push(TarEntry { path, data: data.to_vec(), mode: octal(&hdr[100..108]) as u32 });
            }
            _ => { long_name = None; } // dirs ('5'), links, pax headers ('x'/'g'): skipped
        }
        pos = data_end + ((512 - (size % 512)) % 512);
    }
    Ok(out)
}

/// A path that may be joined under a trusted root: relative, no `..`, no drive,
/// no empty / `.` only.
pub fn safe_relative(p: &str) -> Result<(), String> {
    let path = Path::new(p);
    if p.is_empty() || p.starts_with('/') || p.contains(':') { return Err(format!("tar: refusing path {p:?}")); }
    let mut parts = 0;
    for c in path.components() {
        match c {
            Component::Normal(_) => parts += 1,
            Component::CurDir => {}
            _ => return Err(format!("tar: refusing path {p:?}")),
        }
    }
    if parts == 0 { return Err(format!("tar: refusing path {p:?}")); }
    Ok(())
}

// ───────────────────────── extension folder ─────────────────────────

/// The `name` of a manifest.json, if the folder is an unpacked TotalScript.
pub fn manifest_version(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
    if !name.to_ascii_lowercase().contains("totalscript") { return None; }
    v.get("version").and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// Where the unpacked extension lives: the configured folder first, else the
/// tree this binary was started from (`TotalScript/bin/total-core` and
/// `TotalScript/agent/target/release/total-core` both resolve), else None.
/// Returns (folder, how) with how ∈ {"configured", "exe-tree"}.
pub fn detect_extension_dir(exe: &Path, configured: Option<&Path>) -> Option<(PathBuf, &'static str)> {
    if let Some(c) = configured {
        if manifest_version(c).is_some() { return Some((c.to_path_buf(), "configured")); }
    }
    let mut dir = exe.parent();
    for _ in 0..5 {
        let d = dir?;
        if manifest_version(d).is_some() { return Some((d.to_path_buf(), "exe-tree")); }
        dir = d.parent();
    }
    None
}

fn skipped(rel: &str) -> bool { SKIP_PREFIXES.iter().any(|p| rel.starts_with(p)) }

#[derive(Clone, Debug, Default, Serialize)]
pub struct ApplyReport { pub written: usize, pub skipped: usize, pub failed: Vec<String>, pub backup: String }

/// Copy `entries` (paths like `TotalScript/src/x.js`) over `ext_dir`. Files
/// under SKIP_PREFIXES and the running binary are left alone; every file that
/// is overwritten is copied to `backup` first. Writes go to `<file>.tsnew`
/// then rename, so a crash mid-way leaves either the old or the new file.
pub fn apply_entries(entries: &[TarEntry], ext_dir: &Path, backup: &Path, running_exe: Option<&Path>) -> ApplyReport {
    let mut rep = ApplyReport { backup: backup.display().to_string(), ..Default::default() };
    let running = running_exe.and_then(|p| std::fs::canonicalize(p).ok());
    for e in entries {
        let rel = match e.path.strip_prefix(format!("{TAR_ROOT}/").as_str()) { Some(r) => r, None => { rep.skipped += 1; continue; } };
        if rel.is_empty() || skipped(rel) { rep.skipped += 1; continue; }
        if safe_relative(rel).is_err() { rep.failed.push(format!("{rel}: unsafe path")); continue; }
        let dest = ext_dir.join(rel);
        if let (Some(r), Ok(d)) = (&running, std::fs::canonicalize(&dest)) {
            if &d == r { rep.skipped += 1; continue; } // the app component replaces this one
        }
        if let Some(parent) = dest.parent() { if let Err(err) = std::fs::create_dir_all(parent) { rep.failed.push(format!("{rel}: mkdir {err}")); continue; } }
        if dest.is_file() {
            if std::fs::read(&dest).map(|old| old == e.data).unwrap_or(false) { rep.skipped += 1; continue; } // identical
            let b = backup.join(rel);
            if let Some(bp) = b.parent() { let _ = std::fs::create_dir_all(bp); }
            let _ = std::fs::copy(&dest, &b);
        }
        let tmp = dest.with_extension(match dest.extension().and_then(|x| x.to_str()) { Some(x) => format!("{x}.tsnew"), None => "tsnew".to_string() });
        if let Err(err) = std::fs::write(&tmp, &e.data) { rep.failed.push(format!("{rel}: write {err}")); continue; }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if e.mode & 0o111 != 0 { let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)); }
        }
        let moved = std::fs::rename(&tmp, &dest).or_else(|_| { let _ = std::fs::remove_file(&dest); std::fs::rename(&tmp, &dest) });
        match moved {
            Ok(()) => rep.written += 1,
            Err(err) => { let _ = std::fs::remove_file(&tmp); rep.failed.push(format!("{rel}: replace {err}")); }
        }
    }
    rep
}

// ───────────────────────── job state ─────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase { Idle, Downloading, Verifying, Staging, Applying, Restarting, Done, Failed }

#[derive(Clone, Debug, Serialize)]
pub struct Job {
    pub phase: Phase,
    pub component: String,
    pub version: String,
    pub message: String,
    pub error: Option<String>,
    pub received: u64,
    pub total: u64,
    pub started: u64,
    pub finished: Vec<String>,
    pub pending: Vec<String>,
}
impl Default for Job {
    fn default() -> Self { Job { phase: Phase::Idle, component: String::new(), version: String::new(), message: String::new(), error: None, received: 0, total: 0, started: 0, finished: Vec::new(), pending: Vec::new() } }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct CheckInfo { pub at: u64, pub latest: Option<Latest>, pub error: Option<String>, pub announced: String }

fn now_secs() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

pub struct Hub {
    check: Mutex<CheckInfo>,
    job: Mutex<Job>,
    configured_dir: Mutex<Option<PathBuf>>,
    daily: AtomicBool,
    busy: AtomicBool,
}

impl Default for Hub { fn default() -> Self { Self::new() } }

impl Hub {
    pub fn new() -> Self {
        Hub { check: Mutex::new(CheckInfo::default()), job: Mutex::new(Job::default()), configured_dir: Mutex::new(None), daily: AtomicBool::new(true), busy: AtomicBool::new(false) }
    }
    pub fn set_daily(&self, on: bool) { self.daily.store(on, Ordering::Relaxed); }
    pub fn daily(&self) -> bool { self.daily.load(Ordering::Relaxed) }
    pub fn set_configured_dir(&self, p: Option<PathBuf>) { *self.configured_dir.lock().unwrap_or_else(|e| e.into_inner()) = p; }
    pub fn configured_dir(&self) -> Option<PathBuf> { self.configured_dir.lock().unwrap_or_else(|e| e.into_inner()).clone() }
    pub fn check_info(&self) -> CheckInfo { self.check.lock().unwrap_or_else(|e| e.into_inner()).clone() }
    pub fn job(&self) -> Job { self.job.lock().unwrap_or_else(|e| e.into_inner()).clone() }
    pub fn is_busy(&self) -> bool { self.busy.load(Ordering::Relaxed) }
    /// A version newer than this build that has not been announced yet
    /// (the caller writes one notification and we remember it).
    pub fn take_unannounced(&self) -> Option<String> {
        let mut c = self.check.lock().unwrap_or_else(|e| e.into_inner());
        let v = c.latest.as_ref().map(|l| l.version.clone())?;
        if !is_newer(&v, env!("CARGO_PKG_VERSION")) || c.announced == v { return None; }
        c.announced = v.clone();
        Some(v)
    }
    pub fn needs_daily_check(&self) -> bool {
        let c = self.check_info();
        c.at == 0 || now_secs().saturating_sub(c.at) >= DAILY.as_secs()
    }
    pub fn extension_dir(&self) -> Option<(PathBuf, &'static str)> {
        let exe = std::env::current_exe().unwrap_or_default();
        detect_extension_dir(&exe, self.configured_dir().as_deref())
    }
    fn set_job(&self, f: impl FnOnce(&mut Job)) { let mut j = self.job.lock().unwrap_or_else(|e| e.into_inner()); f(&mut j); }

    /// Everything the extension / window shows (GET /api/update/status).
    pub fn snapshot(&self) -> serde_json::Value {
        let c = self.check_info();
        let ext = self.extension_dir();
        serde_json::json!({
            "ok": true,
            "app_version": env!("CARGO_PKG_VERSION"),
            "platform_asset": app_asset_name(),
            "daily": self.daily(),
            "check": { "at": c.at, "latest": c.latest, "error": c.error,
                       "newer": c.latest.as_ref().map(|l| is_newer(&l.version, env!("CARGO_PKG_VERSION"))).unwrap_or(false) },
            "extension": { "path": ext.as_ref().map(|(p, _)| p.display().to_string()), "detected": ext.as_ref().map(|(_, how)| *how),
                           "manifest_version": ext.as_ref().and_then(|(p, _)| manifest_version(p)) },
            "job": self.job(),
        })
    }

    fn client() -> anyhow::Result<reqwest::Client> {
        Ok(reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(600))
            .user_agent(concat!("TotalScript total-core/", env!("CARGO_PKG_VERSION"), " (+https://github.com/errored404user/ULTIMATEor)"))
            .build()?)
    }

    /// GET latest.json (cached CHECK_TTL unless `force`). Errors are recorded
    /// AND returned; the previous `latest` is kept on error.
    pub async fn check(&self, force: bool) -> Result<Latest, String> {
        {
            let c = self.check_info();
            if !force && c.at != 0 && now_secs().saturating_sub(c.at) < CHECK_TTL.as_secs() {
                if let Some(l) = c.latest { return Ok(l); }
            }
        }
        let res: Result<Latest, String> = async {
            let client = Self::client().map_err(|e| e.to_string())?;
            let r = client.get(LATEST_JSON_URL).header("Accept", "application/json").send().await.map_err(|e| format!("GitHub unreachable: {e}"))?;
            if r.status().as_u16() == 404 { return Err("no release published yet (latest.json missing)".to_string()); }
            if !r.status().is_success() { return Err(format!("GitHub answered {}", r.status())); }
            let text = r.text().await.map_err(|e| e.to_string())?;
            Latest::parse(&text)
        }.await;
        let mut c = self.check.lock().unwrap_or_else(|e| e.into_inner());
        c.at = now_secs();
        match &res {
            Ok(l) => { c.latest = Some(l.clone()); c.error = None; }
            Err(e) => { c.error = Some(e.clone()); }
        }
        res
    }

    async fn download(&self, client: &reqwest::Client, asset: &Asset) -> Result<Vec<u8>, String> {
        use futures::StreamExt;
        let r = client.get(&asset.url).send().await.map_err(|e| format!("download {}: {e}", asset.name))?;
        if !r.status().is_success() { return Err(format!("download {}: GitHub answered {}", asset.name, r.status())); }
        let total = r.content_length().unwrap_or(asset.size);
        if total > MAX_ASSET_BYTES { return Err(format!("{} is {total} bytes - refusing (limit {MAX_ASSET_BYTES})", asset.name)); }
        self.set_job(|j| { j.phase = Phase::Downloading; j.total = total; j.received = 0; j.message = format!("Downloading {}", asset.name); });
        let mut buf: Vec<u8> = Vec::with_capacity(total.min(MAX_ASSET_BYTES) as usize);
        let mut hasher = Sha256::new();
        let mut stream = r.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download {}: {e}", asset.name))?;
            hasher.update(&chunk);
            buf.extend_from_slice(&chunk);
            if buf.len() as u64 > MAX_ASSET_BYTES { return Err(format!("{} exceeded {MAX_ASSET_BYTES} bytes", asset.name)); }
            let n = buf.len() as u64;
            self.set_job(|j| j.received = n);
        }
        self.set_job(|j| { j.phase = Phase::Verifying; j.message = format!("Verifying {}", asset.name); });
        if asset.sha256.is_empty() { return Err(format!("{}: latest.json carries no sha256 - refusing to install an unverified file", asset.name)); }
        let got = hasher.finish_hex();
        if got != asset.sha256 { return Err(format!("{}: sha256 mismatch (expected {}, got {got})", asset.name, asset.sha256)); }
        Ok(buf)
    }

    /// Download + stage + copy the extension. Returns the apply report.
    async fn apply_extension(&self, client: &reqwest::Client, latest: &Latest) -> Result<ApplyReport, String> {
        let (ext_dir, how) = self.extension_dir().ok_or_else(|| "extension folder unknown - set it in Settings → Updates (the folder you loaded unpacked in chrome://extensions)".to_string())?;
        let asset = latest.asset(EXTENSION_ASSET).ok_or_else(|| format!("release {} has no {EXTENSION_ASSET}", latest.version))?.clone();
        let bytes = self.download(client, &asset).await?;
        self.set_job(|j| { j.phase = Phase::Staging; j.message = "Unpacking".into(); });
        let entries = read_tar(&bytes)?;
        drop(bytes);
        let manifest = entries.iter().find(|e| e.path == format!("{TAR_ROOT}/manifest.json")).ok_or("archive has no TotalScript/manifest.json")?;
        let mv: serde_json::Value = serde_json::from_slice(&manifest.data).map_err(|e| format!("archive manifest.json unreadable: {e}"))?;
        let archive_version = mv.get("version").and_then(|v| v.as_str()).unwrap_or("");
        if archive_version != latest.version { return Err(format!("archive is {archive_version:?} but the release says {} - refusing", latest.version)); }
        let from = manifest_version(&ext_dir).unwrap_or_default();
        let backup = std::env::temp_dir().join(format!("totalscript-backup-{}-{}", if from.is_empty() { "unknown" } else { from.as_str() }, now_secs()));
        self.set_job(|j| { j.phase = Phase::Applying; j.message = format!("Writing {} files into {} ({how})", entries.len(), ext_dir.display()); });
        let exe = std::env::current_exe().ok();
        let rep = {
            let entries = entries;
            let ext_dir = ext_dir.clone();
            let backup = backup.clone();
            tokio::task::spawn_blocking(move || apply_entries(&entries, &ext_dir, &backup, exe.as_deref())).await.map_err(|e| e.to_string())?
        };
        let receipt = serde_json::json!({ "from": from, "to": latest.version, "at": now_secs(), "written": rep.written, "skipped": rep.skipped, "failed": rep.failed, "backup": rep.backup });
        let _ = std::fs::write(ext_dir.join(".totalscript-updated.json"), serde_json::to_string_pretty(&receipt).unwrap_or_default());
        if !rep.failed.is_empty() {
            return Err(format!("{} of {} files could not be replaced ({}); the rest were written - retry, or unzip {}/download/{}/TotalScript.zip over the folder. Backup of overwritten files: {}",
                rep.failed.len(), rep.failed.len() + rep.written + rep.skipped, rep.failed.iter().take(3).cloned().collect::<Vec<_>>().join("; "), RELEASES_URL, latest.tag, rep.backup));
        }
        Ok(rep)
    }

    /// Download the binary for this platform and swap it in. Returns the path
    /// of the new binary (the caller relaunches + exits).
    async fn apply_app(&self, client: &reqwest::Client, latest: &Latest) -> Result<PathBuf, String> {
        let name = app_asset_name().ok_or_else(|| format!("no prebuilt total-core for {}-{} - rebuild from source (cd agent && cargo build --release)", std::env::consts::OS, std::env::consts::ARCH))?;
        let asset = latest.asset(name).ok_or_else(|| format!("release {} has no {name}", latest.version))?.clone();
        let bytes = self.download(client, &asset).await?;
        if bytes.len() < 1024 * 1024 { return Err(format!("{name} is only {} bytes - not a build", bytes.len())); }
        let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
        self.set_job(|j| { j.phase = Phase::Applying; j.message = format!("Replacing {}", exe.display()); });
        tokio::task::spawn_blocking(move || swap_binary(&exe, &bytes)).await.map_err(|e| e.to_string())?
    }

    /// Run the whole job. `components` ⊆ {"extension", "app"}; extension first
    /// so the new files are in place before this process goes away. `restart`
    /// is called (after the delayed relauncher was spawned) when the app
    /// component succeeded; it must exit the process.
    pub async fn apply(self: Arc<Self>, components: Vec<String>, want_version: Option<String>, log: Arc<dyn Fn(&str) + Send + Sync>, restart: Arc<dyn Fn() + Send + Sync>) -> Result<(), String> {
        if self.busy.swap(true, Ordering::SeqCst) { return Err("an update is already running".into()); }
        let result = self.clone().apply_inner(components, want_version, log.clone(), restart).await;
        self.busy.store(false, Ordering::SeqCst);
        if let Err(e) = &result {
            (*log)(&format!("update failed: {e}"));
            self.set_job(|j| { j.phase = Phase::Failed; j.error = Some(e.clone()); j.message = "Failed".into(); });
        }
        result
    }

    async fn apply_inner(self: Arc<Self>, components: Vec<String>, want_version: Option<String>, log: Arc<dyn Fn(&str) + Send + Sync>, restart: Arc<dyn Fn() + Send + Sync>) -> Result<(), String> {
        let mut comps: Vec<String> = components.into_iter().filter(|c| c == "extension" || c == "app").collect();
        comps.sort_by_key(|c| if c == "extension" { 0 } else { 1 });
        comps.dedup();
        if comps.is_empty() { return Err("nothing to update (components: extension, app)".into()); }
        let latest = self.check(true).await?;
        if let Some(w) = want_version.as_deref().map(|w| w.trim_start_matches('v')).filter(|w| !w.is_empty()) {
            if w != latest.version { return Err(format!("the latest release is {} now, not {w} - check again", latest.version)); }
        }
        if !is_newer(&latest.version, env!("CARGO_PKG_VERSION")) && comps.iter().any(|c| c == "app") {
            // Re-installing the same app version is pointless; the extension may still lag behind.
            comps.retain(|c| c != "app");
            if comps.is_empty() { return Err(format!("this app already is {}", env!("CARGO_PKG_VERSION"))); }
        }
        self.set_job(|j| { *j = Job::default(); j.version = latest.version.clone(); j.started = now_secs(); j.pending = comps.clone(); j.phase = Phase::Downloading; });
        let client = Self::client().map_err(|e| e.to_string())?;
        (*log)(&format!("update to {} started: {}", latest.version, comps.join(" + ")));
        let mut new_bin: Option<PathBuf> = None;
        for c in comps.clone() {
            self.set_job(|j| { j.component = c.clone(); j.pending.retain(|p| p != &c); });
            if c == "extension" {
                let rep = self.apply_extension(&client, &latest).await?;
                (*log)(&format!("extension files updated to {}: {} written, {} unchanged/skipped, backup {}", latest.version, rep.written, rep.skipped, rep.backup));
            } else {
                new_bin = Some(self.apply_app(&client, &latest).await?);
                (*log)(&format!("desktop app replaced with {} - relaunching", latest.version));
            }
            self.set_job(|j| j.finished.push(c.clone()));
        }
        self.set_job(|j| { j.phase = if new_bin.is_some() { Phase::Restarting } else { Phase::Done }; j.message = if new_bin.is_some() { "Relaunching the desktop app".into() } else { "Done".into() }; j.component.clear(); });
        if let Some(bin) = new_bin {
            spawn_relaunch(&bin, &latest.version)?;
            // Give the HTTP response / window a moment to show "restarting".
            tokio::time::sleep(Duration::from_millis(700)).await;
            (*restart)();
        }
        Ok(())
    }
}

/// Write `bytes` as `<exe>.new`, then exe → `<exe>.old`, new → exe. On any
/// failure the original is put back. Returns the final path.
pub fn swap_binary(exe: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = exe.parent().ok_or("binary has no parent folder")?;
    let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("total-core");
    let ext = exe.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let new_path = dir.join(format!("{stem}.new{ext}"));
    let old_path = dir.join(format!("{stem}.old{ext}"));
    std::fs::write(&new_path, bytes).map_err(|e| format!("write {}: {e}", new_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&new_path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(&old_path); // a leftover from the previous update (may fail if still running - then rename below fails and we report)
    std::fs::rename(exe, &old_path).map_err(|e| { let _ = std::fs::remove_file(&new_path); format!("could not move the running binary aside ({e}) - is another total-core running from the same file?") })?;
    if let Err(e) = std::fs::rename(&new_path, exe) {
        let _ = std::fs::rename(&old_path, exe);
        let _ = std::fs::remove_file(&new_path);
        return Err(format!("could not put the new binary in place ({e}); the old one was restored"));
    }
    Ok(exe.to_path_buf())
}

/// Start `bin` again after a short delay from a detached helper so the new
/// instance finds port 3000 free and no window to raise.
pub fn spawn_relaunch(bin: &Path, version: &str) -> Result<(), String> {
    let path = bin.display().to_string();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = format!("ping -n 3 127.0.0.1 >nul & start \"\" \"{}\" --updated-from {}", path, env!("CARGO_PKG_VERSION"));
        std::process::Command::new("cmd").args(["/C", &script]).creation_flags(CREATE_NO_WINDOW).spawn().map_err(|e| format!("relaunch helper: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        let script = format!("sleep 2; exec \"{}\" --updated-from {} >/dev/null 2>&1", path.replace('"', "\\\""), env!("CARGO_PKG_VERSION"));
        std::process::Command::new("sh").args(["-c", &script]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().map_err(|e| format!("relaunch helper: {e}"))?;
    }
    let _ = version;
    Ok(())
}

/// Called at boot: drop the `.old` binary a previous self-update left behind.
pub fn cleanup_after_restart() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let stem = exe.file_stem()?.to_str()?;
    let ext = exe.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let old = dir.join(format!("{stem}.old{ext}"));
    if old.is_file() && std::fs::remove_file(&old).is_ok() { Some(old) } else { None }
}

// ───────────────────────── tests ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_the_fips_vectors() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
        // streaming in odd chunk sizes gives the same digest
        let data: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let whole = sha256_hex(&data);
        let mut s = Sha256::new();
        for chunk in data.chunks(777) { s.update(chunk); }
        assert_eq!(s.finish_hex(), whole);
        let million = vec![b'a'; 1_000_000];
        assert_eq!(sha256_hex(&million), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    }

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(parse_version("v2.18.0"), Some((2, 18, 0)));
        assert_eq!(parse_version("2.18.0-beta.1"), Some((2, 18, 0)));
        assert_eq!(parse_version("nope"), None);
        assert!(is_newer("2.18.0", "2.16.1"));
        assert!(is_newer("2.100.0", "2.99.9"));
        assert!(!is_newer("2.16.1", "2.16.1"));
        assert!(!is_newer("2.16.0", "2.16.1"));
        assert!(!is_newer("garbage", "2.16.1"));
    }

    #[test]
    fn latest_json_parses_and_normalises() {
        let l = Latest::parse(r#"{"version":"v2.18.0","assets":[{"name":"TotalScript-extension.tar","size":10,"sha256":"ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789","url":"https://github.com/errored404user/ULTIMATEor/releases/download/v2.18.0/TotalScript-extension.tar"},{"name":"evil","sha256":"short","url":"https://example.com/x"}]}"#).unwrap();
        assert_eq!(l.version, "2.18.0");
        assert_eq!(l.tag, "v2.18.0");
        assert_eq!(l.notes_url, "https://github.com/errored404user/ULTIMATEor/releases/tag/v2.18.0");
        let a = l.asset(EXTENSION_ASSET).unwrap();
        assert_eq!(a.sha256, "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
        let evil = l.asset("evil").unwrap();
        assert!(evil.sha256.is_empty(), "bad hash dropped");
        assert_eq!(evil.url, "https://github.com/errored404user/ULTIMATEor/releases/download/v2.18.0/evil", "foreign url replaced by the release url");
        assert!(Latest::parse("{}").is_err());
        assert!(Latest::parse("not json").is_err());
    }

    #[test]
    fn sha256sums_lines() {
        let m = parse_sha256sums("# c\nabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789  TotalScript.zip\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef *total-core-windows-x64.exe\nbad line\n");
        assert_eq!(m.len(), 2);
        assert_eq!(m["TotalScript.zip"], "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
        assert_eq!(m["total-core-windows-x64.exe"], "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    }

    // A minimal ustar writer for the tests (the workflow uses GNU tar --format=ustar).
    fn tar_entry(name: &str, data: &[u8], typeflag: u8) -> Vec<u8> {
        let mut h = vec![0u8; 512];
        let (prefix, base) = if name.len() > 100 { let cut = name[..name.len().min(155)].rfind('/').unwrap(); (&name[..cut], &name[cut + 1..]) } else { ("", name) };
        h[..base.len()].copy_from_slice(base.as_bytes());
        h[100..108].copy_from_slice(b"0000755\0");
        h[108..116].copy_from_slice(b"0000000\0");
        h[116..124].copy_from_slice(b"0000000\0");
        h[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
        h[136..148].copy_from_slice(b"00000000000\0");
        h[156] = typeflag;
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        h[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
        for b in &mut h[148..156] { *b = b' '; }
        let sum: u32 = h.iter().map(|b| *b as u32).sum();
        h[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        let mut out = h;
        out.extend_from_slice(data);
        while out.len() % 512 != 0 { out.push(0); }
        out
    }
    fn tar(entries: &[(&str, &[u8], u8)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (n, d, t) in entries { out.extend(tar_entry(n, d, *t)); }
        out.extend(vec![0u8; 1024]);
        out
    }

    #[test]
    fn tar_reader_handles_ustar_prefix_dirs_and_longnames() {
        let long = format!("TotalScript/{}/file.js", "d".repeat(120));
        let bytes = tar(&[
            ("TotalScript/", &b""[..], b'5'),
            ("TotalScript/manifest.json", &br#"{"name":"TotalScript","version":"2.18.0"}"#[..], b'0'),
            (&long, &b"long"[..], b'0'),
            ("TotalScript/src/a.js", &b"console.log(1)"[..], 0),
        ]);
        let entries = read_tar(&bytes).unwrap();
        assert_eq!(entries.len(), 3, "directories skipped");
        assert_eq!(entries[0].path, "TotalScript/manifest.json");
        assert_eq!(entries[1].path, long, "ustar prefix joined back");
        assert_eq!(entries[1].data, b"long");
        assert_eq!(entries[2].data, b"console.log(1)");
        // GNU long name record
        let mut gnu = tar_entry("././@LongLink", &b"TotalScript/very/long/name.txt\0"[..], b'L');
        gnu.extend(tar_entry("TotalScript/very/long/name.tx", &b"x"[..], b'0'));
        gnu.extend(vec![0u8; 1024]);
        let e = read_tar(&gnu).unwrap();
        assert_eq!(e[0].path, "TotalScript/very/long/name.txt");
    }

    #[test]
    fn tar_reader_refuses_escapes_and_truncation() {
        assert!(read_tar(&tar(&[("../evil", &b"x"[..], b'0')])).is_err());
        assert!(read_tar(&tar(&[("/abs", &b"x"[..], b'0')])).is_err());
        assert!(read_tar(&tar(&[("TotalScript/../../x", &b"x"[..], b'0')])).is_err());
        assert!(read_tar(&tar(&[("C:/win", &b"x"[..], b'0')])).is_err());
        let mut t = tar(&[("TotalScript/a", &b"hello"[..], b'0')]);
        t.truncate(514);
        assert!(read_tar(&t).is_err());
        assert!(safe_relative("src/../x").is_err());
        assert!(safe_relative("src/./x").is_ok());
    }

    #[test]
    fn extension_dir_is_found_from_the_exe_tree_or_the_configured_folder() {
        let root = std::env::temp_dir().join(format!("ts-upd-detect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let ext = root.join("TotalScript");
        std::fs::create_dir_all(ext.join("agent/target/release")).unwrap();
        std::fs::create_dir_all(ext.join("bin")).unwrap();
        std::fs::write(ext.join("manifest.json"), r#"{"name":"TotalScript","version":"2.16.1"}"#).unwrap();
        let from_bin = detect_extension_dir(&ext.join("bin/total-core.exe"), None).unwrap();
        assert_eq!(from_bin.0, ext); assert_eq!(from_bin.1, "exe-tree");
        let from_target = detect_extension_dir(&ext.join("agent/target/release/total-core"), None).unwrap();
        assert_eq!(from_target.0, ext);
        assert!(detect_extension_dir(Path::new("/nowhere/total-core"), None).is_none());
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("manifest.json"), r#"{"name":"Something else","version":"1.0.0"}"#).unwrap();
        assert!(detect_extension_dir(Path::new("/nowhere/total-core"), Some(&other)).is_none(), "a foreign manifest is not accepted");
        let cfg = detect_extension_dir(Path::new("/nowhere/total-core"), Some(&ext)).unwrap();
        assert_eq!(cfg.1, "configured");
        assert_eq!(manifest_version(&ext).as_deref(), Some("2.16.1"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_entries_writes_backs_up_and_skips_the_build_tree() {
        let root = std::env::temp_dir().join(format!("ts-upd-apply-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let ext = root.join("TotalScript");
        std::fs::create_dir_all(ext.join("src")).unwrap();
        std::fs::create_dir_all(ext.join("agent/target/release")).unwrap();
        std::fs::write(ext.join("manifest.json"), b"old").unwrap();
        std::fs::write(ext.join("src/keep.js"), b"same").unwrap();
        std::fs::write(ext.join("agent/target/release/total-core"), b"RUNNING").unwrap();
        let entries = vec![
            TarEntry { path: "TotalScript/manifest.json".into(), data: b"new".to_vec(), mode: 0o644 },
            TarEntry { path: "TotalScript/src/keep.js".into(), data: b"same".to_vec(), mode: 0o644 },
            TarEntry { path: "TotalScript/src/added/deep.js".into(), data: b"added".to_vec(), mode: 0o644 },
            TarEntry { path: "TotalScript/agent/target/release/total-core".into(), data: b"NEW".to_vec(), mode: 0o755 },
            TarEntry { path: "TotalScript/.git/config".into(), data: b"x".to_vec(), mode: 0o644 },
            TarEntry { path: "README.md".into(), data: b"outside root".to_vec(), mode: 0o644 },
        ];
        let backup = root.join("backup");
        let rep = apply_entries(&entries, &ext, &backup, None);
        assert_eq!(rep.failed, Vec::<String>::new());
        assert_eq!(rep.written, 2, "manifest + added");
        assert_eq!(rep.skipped, 4, "identical keep.js, agent/target, .git, outside-root");
        assert_eq!(std::fs::read(ext.join("manifest.json")).unwrap(), b"new");
        assert_eq!(std::fs::read(ext.join("src/added/deep.js")).unwrap(), b"added");
        assert_eq!(std::fs::read(ext.join("agent/target/release/total-core")).unwrap(), b"RUNNING", "build tree untouched");
        assert!(!ext.join(".git").exists());
        assert!(!root.join("README.md").exists());
        assert_eq!(std::fs::read(backup.join("manifest.json")).unwrap(), b"old", "overwritten file backed up");
        assert!(!ext.join("manifest.json.tsnew").exists(), "temp file renamed away");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_entries_never_touches_the_running_binary() {
        let root = std::env::temp_dir().join(format!("ts-upd-exe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let ext = root.join("TotalScript");
        std::fs::create_dir_all(ext.join("bin")).unwrap();
        std::fs::write(ext.join("bin/total-core.exe"), b"RUNNING").unwrap();
        let entries = vec![TarEntry { path: "TotalScript/bin/total-core.exe".into(), data: b"NEW".to_vec(), mode: 0o755 }];
        let rep = apply_entries(&entries, &ext, &root.join("b"), Some(&ext.join("bin/total-core.exe")));
        assert_eq!(rep.written, 0);
        assert_eq!(rep.skipped, 1);
        assert_eq!(std::fs::read(ext.join("bin/total-core.exe")).unwrap(), b"RUNNING");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn swap_binary_renames_and_restores_on_failure() {
        let root = std::env::temp_dir().join(format!("ts-upd-swap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let exe = root.join("total-core.exe");
        std::fs::write(&exe, b"OLD").unwrap();
        let out = swap_binary(&exe, b"NEW-BINARY").unwrap();
        assert_eq!(out, exe);
        assert_eq!(std::fs::read(&exe).unwrap(), b"NEW-BINARY");
        assert_eq!(std::fs::read(root.join("total-core.old.exe")).unwrap(), b"OLD");
        assert!(!root.join("total-core.new.exe").exists());
        // a missing exe (nothing to move aside) is reported, the .new file removed
        let gone = root.join("missing");
        let err = swap_binary(&gone, b"X").unwrap_err();
        assert!(err.contains("running binary aside"), "{err}");
        assert!(!root.join("missing.new").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn hub_snapshot_and_job_defaults() {
        let hub = Hub::new();
        assert!(hub.daily());
        assert!(hub.needs_daily_check());
        let snap = hub.snapshot();
        assert_eq!(snap["ok"], true);
        assert_eq!(snap["app_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(snap["job"]["phase"], "idle");
        assert!(hub.take_unannounced().is_none());
        {
            let mut c = hub.check.lock().unwrap();
            c.at = now_secs();
            c.latest = Some(Latest { version: "99.0.0".into(), ..Default::default() });
        }
        assert!(!hub.needs_daily_check());
        assert_eq!(hub.take_unannounced().as_deref(), Some("99.0.0"));
        assert!(hub.take_unannounced().is_none(), "announced once");
        assert_eq!(hub.snapshot()["check"]["newer"], true);
    }
}
