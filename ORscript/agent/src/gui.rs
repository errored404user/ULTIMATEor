//! The desktop status window was intentionally removed from ORscript.
//! This module keeps only the bridge state shared with the native headless agent.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const LOG_CAP: usize = 800;

pub struct UiShared {
    pub studio_running: AtomicBool,
    pub mcp_alive: Arc<AtomicBool>,
    pub workspace_ready: AtomicBool,
    pub full_access: std::sync::RwLock<Arc<AtomicBool>>,
    pub workspace_root: Mutex<String>,
    pub fatal: Mutex<Option<String>>,
    pub logs: Mutex<VecDeque<String>>,
}

impl UiShared {
    pub fn new(mcp_alive: Arc<AtomicBool>) -> Self { Self {
        studio_running: AtomicBool::new(false), mcp_alive,
        workspace_ready: AtomicBool::new(false),
        full_access: std::sync::RwLock::new(Arc::new(AtomicBool::new(false))),
        workspace_root: Mutex::new(String::new()), fatal: Mutex::new(None),
        logs: Mutex::new(VecDeque::with_capacity(LOG_CAP)),
    }}
    pub fn attach_workspace(&self, root: String, full_flag: Arc<AtomicBool>) {
        if let Ok(mut r) = self.workspace_root.lock() { *r = root; }
        self.workspace_ready.store(true, Ordering::Relaxed);
        let current = self.full_access.read().map(|f| f.load(Ordering::Relaxed)).unwrap_or(false);
        full_flag.store(current, Ordering::Relaxed);
        if let Ok(mut slot) = self.full_access.write() { *slot = full_flag; }
    }
    pub fn log(&self, chunk: &str) {
        let mut logs = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        for line in chunk.lines().map(str::trim_end).filter(|line| !line.is_empty()) {
            if logs.len() == LOG_CAP { logs.pop_front(); }
            logs.push_back(line.to_string());
        }
    }
    pub fn clear_logs(&self) { if let Ok(mut l) = self.logs.lock() { l.clear(); } }
    pub fn set_fatal(&self, msg: String) { let mut f = self.fatal.lock().unwrap_or_else(|e| e.into_inner()); if f.is_none() { *f = Some(msg); } }
}

/// No window is created. The native process remains a background bridge.
pub fn run_gui(_shared: Arc<UiShared>, _restart_tx: tokio::sync::mpsc::UnboundedSender<()>) -> anyhow::Result<()> {
    std::thread::park();
    Ok(())
}
