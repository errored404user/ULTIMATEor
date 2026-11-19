//! Live, token-paired bridge for the ordinary Figma Design plugin.
//!
//! The plugin runs inside Figma (not Dev Mode and not Figma Desktop MCP), then
//! long-polls this existing port-3000 server for explicitly curated canvas
//! operations. A short-lived pairing code is exchanged once for a random
//! session token. Every request from Figma's `Origin: null` plugin context is
//! accepted only on these scoped routes and only with the session token.

use std::{
    collections::{HashMap, VecDeque},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};

use axum::{
    extract::{Query, State},
    http::{header::ORIGIN, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex, Notify};

use crate::{AppState, McpToolOutput};

#[cfg(test)]
const PLUGIN_SOURCE: &str = include_str!("../../plugin/figma/TotalScript-Figma.js");
pub const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
const STALE_AFTER: Duration = Duration::from_secs(45);
const POLL_WAIT: Duration = Duration::from_secs(20);
const MAX_PENDING_JOBS: usize = 64;
const MAX_ARGUMENT_BYTES: usize = 512 * 1024;
const MAX_RESULT_BYTES: usize = 7 * 1024 * 1024;
const FIGMA_TOKEN_HEADER: &str = "x-totalscript-figma-token";
const TOOL_NAMES: &[&str] = &[
    "figma_plugin_status",
    "figma_plugin_document",
    "figma_plugin_selection",
    "figma_plugin_find",
    "figma_plugin_page",
    "figma_plugin_create_frame",
    "figma_plugin_create_shape",
    "figma_plugin_create_text",
    "figma_plugin_update_node",
    "figma_plugin_set_text",
    "figma_plugin_reparent",
    "figma_plugin_duplicate",
    "figma_plugin_group",
    "figma_plugin_delete",
    "figma_plugin_export",
    "figma_plugin_component",
];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PluginInfo {
    pub client_id: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct JobResult {
    pub id: String,
    pub client_id: String,
    pub ok: bool,
    pub result: Value,
    pub error: Option<String>,
    pub code: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug)]
struct PendingJob {
    job: Job,
    client_id: String,
}

#[derive(Clone, Debug)]
struct Session {
    info: PluginInfo,
    token: String,
    last_seen: Instant,
}

#[derive(Clone, Debug)]
struct PairingCode {
    token: String,
    expires_at: Instant,
    expires_epoch_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkStatus {
    pub state: &'static str,
    pub connected: bool,
    pub verified: bool,
    pub error: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClientState {
    Unauthorized,
    Stale,
}

#[derive(Debug)]
pub enum HelloError {
    Unauthorized,
    Entropy(getrandom::Error),
}

impl std::fmt::Display for HelloError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized => write!(f, "invalid or expired Figma pairing/session token"),
            Self::Entropy(e) => write!(f, "could not create a secure Figma session token: {e}"),
        }
    }
}

pub struct Hub {
    session: Mutex<Option<Session>>,
    pairing: Mutex<Option<PairingCode>>,
    explicitly_disconnected: AtomicBool,
    expected_clients: Mutex<HashMap<String, String>>,
    queue: Mutex<VecDeque<PendingJob>>,
    wake: Notify,
    results: broadcast::Sender<JobResult>,
    seq: AtomicU64,
}

impl Default for Hub {
    fn default() -> Self { Self::new() }
}

impl Hub {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel::<JobResult>(128);
        Self {
            session: Mutex::new(None),
            pairing: Mutex::new(None),
            explicitly_disconnected: AtomicBool::new(false),
            expected_clients: Mutex::new(HashMap::new()),
            queue: Mutex::new(VecDeque::new()),
            wake: Notify::new(),
            results: tx,
            seq: AtomicU64::new(1),
        }
    }

    pub async fn status(&self) -> LinkStatus {
        match self.session.lock().await.as_ref() {
            Some(session) if session.last_seen.elapsed() < STALE_AFTER => LinkStatus {
                state: "connected", connected: true, verified: true, error: None,
            },
            Some(_) => LinkStatus {
                state: "unknown", connected: false, verified: false,
                error: Some("Figma plugin heartbeat is stale; connection state is unknown"),
            },
            None if self.explicitly_disconnected.load(Ordering::Relaxed) => LinkStatus {
                state: "disconnected", connected: false, verified: true, error: None,
            },
            None => LinkStatus {
                state: "unknown", connected: false, verified: false,
                error: Some("Figma Design plugin has not paired in this TotalScript session"),
            },
        }
    }

    pub async fn connected(&self) -> bool { self.status().await.connected }

    pub async fn issue_pairing(&self) -> Result<(String, i64), getrandom::Error> {
        let token = random_token()?;
        let expires_epoch_ms = chrono::Utc::now().timestamp_millis() + PAIRING_TTL.as_millis() as i64;
        *self.pairing.lock().await = Some(PairingCode {
            token: token.clone(),
            expires_at: Instant::now() + PAIRING_TTL,
            expires_epoch_ms,
        });
        Ok((token, expires_epoch_ms))
    }

    pub async fn pairing_expiry(&self) -> Option<i64> {
        let mut pairing = self.pairing.lock().await;
        if pairing.as_ref().is_some_and(|code| code.expires_at <= Instant::now()) {
            *pairing = None;
        }
        pairing.as_ref().map(|code| code.expires_epoch_ms)
    }

    /// Pair once with a short-lived code, or re-announce with the same saved
    /// session token after Figma reconnects. The returned value is the
    /// long-lived (in-memory) session token, never the one-time pairing code.
    pub async fn hello(&self, presented_token: &str, info: PluginInfo) -> Result<String, HelloError> {
        if !valid_client_id(&info.client_id) || !valid_token(presented_token) {
            return Err(HelloError::Unauthorized);
        }
        {
            let mut session = self.session.lock().await;
            if let Some(current) = session.as_mut() {
                if current.info.client_id == info.client_id && token_eq(presented_token, &current.token) {
                    current.info = info;
                    current.last_seen = Instant::now();
                    self.explicitly_disconnected.store(false, Ordering::Relaxed);
                    return Ok(current.token.clone());
                }
            }
        }

        let mut pairing = self.pairing.lock().await;
        let matches = pairing.as_ref().is_some_and(|code| {
            code.expires_at > Instant::now() && token_eq(presented_token, &code.token)
        });
        if !matches {
            if pairing.as_ref().is_some_and(|code| code.expires_at <= Instant::now()) {
                *pairing = None;
            }
            return Err(HelloError::Unauthorized);
        }
        *pairing = None; // pairing codes are single-use
        drop(pairing);

        let session_token = random_token().map_err(HelloError::Entropy)?;
        {
            let mut session = self.session.lock().await;
            *session = Some(Session { info, token: session_token.clone(), last_seen: Instant::now() });
        }
        self.explicitly_disconnected.store(false, Ordering::Relaxed);
        self.retire_jobs("Figma plugin session was replaced").await;
        Ok(session_token)
    }

    pub async fn authorized(&self, token: &str, client_id: &str) -> bool {
        if !valid_token(token) || !valid_client_id(client_id) { return false; }
        self.session.lock().await.as_ref().is_some_and(|session| {
            session.info.client_id == client_id && token_eq(token, &session.token)
        })
    }

    async fn take_job_for(&self, client_id: &str, token: &str) -> Result<Option<Job>, ClientState> {
        // Keep the active session locked through queue removal so a newly paired
        // Figma window cannot inherit another window's queued operation.
        let mut session = self.session.lock().await;
        let Some(current) = session.as_mut() else { return Err(ClientState::Unauthorized) };
        if current.info.client_id != client_id || !token_eq(token, &current.token) {
            return Err(ClientState::Unauthorized);
        }
        if current.last_seen.elapsed() >= STALE_AFTER { return Err(ClientState::Stale) }
        current.last_seen = Instant::now();
        let mut queue = self.queue.lock().await;
        let Some(index) = queue.iter().position(|pending| pending.client_id == client_id) else { return Ok(None) };
        Ok(queue.remove(index).map(|pending| pending.job))
    }

    async fn touch(&self, client_id: &str, token: &str) -> bool {
        let mut session = self.session.lock().await;
        if let Some(current) = session.as_mut() {
            if current.info.client_id == client_id && token_eq(token, &current.token) {
                current.last_seen = Instant::now();
                return true;
            }
        }
        false
    }

    async fn accept_result(&self, result: &JobResult, token: &str) -> bool {
        let Some(client_id) = self.expected_clients.lock().await.get(&result.id).cloned() else { return false };
        if result.client_id != client_id { return false; }
        let mut session = self.session.lock().await;
        match session.as_mut() {
            Some(current) if current.info.client_id == client_id
                && current.last_seen.elapsed() < STALE_AFTER
                && token_eq(token, &current.token) =>
            {
                current.last_seen = Instant::now();
                self.expected_clients.lock().await.remove(&result.id);
                true
            }
            _ => false,
        }
    }

    async fn disconnect(&self, client_id: &str, token: &str) -> bool {
        if !self.authorized(token, client_id).await { return false; }
        let mut session = self.session.lock().await;
        if matches!(session.as_ref(), Some(current) if current.info.client_id == client_id && token_eq(token, &current.token)) {
            *session = None;
            self.explicitly_disconnected.store(true, Ordering::Relaxed);
            drop(session);
            *self.pairing.lock().await = None;
            self.retire_jobs("Figma plugin disconnected").await;
            true
        } else {
            false
        }
    }

    pub async fn revoke(&self) {
        *self.session.lock().await = None;
        *self.pairing.lock().await = None;
        self.explicitly_disconnected.store(true, Ordering::Relaxed);
        self.retire_jobs("Figma plugin pairing was revoked").await;
    }

    async fn retire_jobs(&self, reason: &str) {
        self.queue.lock().await.clear();
        let pending: Vec<(String, String)> = self.expected_clients.lock().await.drain().collect();
        for (id, client_id) in pending {
            let _ = self.results.send(JobResult {
                id, client_id, ok: false, result: Value::Null,
                error: Some(reason.to_string()), code: Some("FIGMA_PLUGIN_DISCONNECTED".into()), elapsed_ms: 0,
            });
        }
        self.wake.notify_waiters();
    }

    pub async fn queued(&self) -> usize { self.queue.lock().await.len() }

    /// Queue a single, named Figma operation and wait for its result. Ambiguous
    /// timeouts are not replayed: the edit may already have landed in Figma.
    pub async fn run(&self, name: &str, args: Value, timeout: Duration) -> anyhow::Result<JobResult> {
        if !is_tool(name) || name == "figma_plugin_status" {
            anyhow::bail!("ERROR FIGMA_PLUGIN_TOOL_INVALID: unsupported Figma Design operation '{name}'");
        }
        if !args.is_object() { anyhow::bail!("ERROR INVALID_ARGUMENT: Figma plugin arguments must be a JSON object"); }
        let arg_bytes = serde_json::to_vec(&args)?;
        if arg_bytes.len() > MAX_ARGUMENT_BYTES {
            anyhow::bail!("ERROR INVALID_ARGUMENT: Figma plugin arguments exceed the 512 KiB safety limit");
        }
        let client_id = {
            let session = self.session.lock().await;
            session.as_ref().filter(|s| s.last_seen.elapsed() < STALE_AFTER).map(|s| s.info.client_id.clone())
        };
        let Some(client_id) = client_id else {
            anyhow::bail!("ERROR FIGMA_PLUGIN_STATUS_UNKNOWN: Figma plugin is not verified live; check the Figma plugin connection before retrying");
        };
        if self.queue.lock().await.len() >= MAX_PENDING_JOBS {
            anyhow::bail!("ERROR FIGMA_PLUGIN_BUSY: too many Figma plugin operations are already queued");
        }
        let id = format!("figma-job-{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let mut rx = self.results.subscribe();
        self.expected_clients.lock().await.insert(id.clone(), client_id.clone());
        self.queue.lock().await.push_back(PendingJob {
            job: Job { id: id.clone(), name: name.to_string(), args },
            client_id: client_id.clone(),
        });
        self.wake.notify_one();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Ok(result)) if result.id == id => return Ok(result),
                Ok(Ok(_)) => continue,
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(_)) => anyhow::bail!("Figma plugin result channel closed"),
                Err(_) => {
                    self.expected_clients.lock().await.remove(&id);
                    let still_queued = {
                        let mut queue = self.queue.lock().await;
                        let before = queue.len();
                        queue.retain(|pending| pending.job.id != id);
                        before != queue.len()
                    };
                    if !still_queued {
                        anyhow::bail!("Figma plugin picked up '{name}' but did not reply within {} s; the canvas operation may already have completed. Inspect Figma before retrying.", timeout.as_secs());
                    }
                    anyhow::bail!("Figma plugin did not pick up '{name}' within {} s. Keep the TotalScript Figma plugin open and retry only after checking the canvas.", timeout.as_secs());
                }
            }
        }
    }
}

fn random_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)?;
    let mut token = String::with_capacity(64);
    for byte in bytes { use std::fmt::Write as _; let _ = write!(&mut token, "{byte:02x}"); }
    Ok(token)
}

fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn token_eq(left: &str, right: &str) -> bool {
    if left.len() != 64 || right.len() != 64 { return false; }
    left.bytes().zip(right.bytes()).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

fn valid_client_id(value: &str) -> bool {
    (8..=80).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

fn token_from(headers: &HeaderMap) -> Option<&str> {
    headers.get(FIGMA_TOKEN_HEADER).and_then(|value| value.to_str().ok())
}

fn origin_from(headers: &HeaderMap) -> Option<&str> {
    headers.get(ORIGIN).and_then(|value| value.to_str().ok()).map(str::trim)
}

fn extension_origin(origin: Option<&str>) -> bool {
    let Some(origin) = origin else { return false };
    let lower = origin.to_ascii_lowercase();
    ["chrome-extension://", "moz-extension://", "safari-web-extension://", "ms-browser-extension://"]
        .iter()
        .any(|prefix| lower.starts_with(prefix) && lower.len() > prefix.len())
}

fn pairing_request_allowed(origin: Option<&str>) -> bool {
    extension_origin(origin)
}

fn error_response(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "ok": false, "error": message.into() })))
}

// ───────────────────────── HTTP handlers ─────────────────────────

pub async fn pairing_handler(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    // Only the TotalScript extension UI may mint pairing codes. In particular,
    // Origin: null is not sufficient to create or replace a credential.
    if !pairing_request_allowed(origin_from(&headers)) {
        return error_response(StatusCode::FORBIDDEN, "Figma pairing codes can only be created from TotalScript Settings → Connections");
    }
    match state.figma_plugin.issue_pairing().await {
        Ok((pairing_token, expires_at)) => (StatusCode::OK, Json(json!({
            "ok": true,
            "pairing_token": pairing_token,
            "expires_at": expires_at,
            "expires_in": PAIRING_TTL.as_secs(),
            "single_use": true,
        }))),
        Err(error) => {
            tracing::error!("could not generate secure Figma pairing token: {error}");
            error_response(StatusCode::INTERNAL_SERVER_ERROR, "TotalScript could not generate a secure Figma pairing code")
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct HelloRequest {
    pub client_id: String,
    pub version: String,
}
impl Default for HelloRequest {
    fn default() -> Self { Self { client_id: String::new(), version: String::new() } }
}

pub async fn hello_handler(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<HelloRequest>) -> impl IntoResponse {
    let Some(token) = token_from(&headers) else {
        return error_response(StatusCode::UNAUTHORIZED, "Figma pairing/session token is required");
    };
    let info = PluginInfo {
        client_id: req.client_id,
        version: req.version.chars().take(40).collect(),
    };
    match state.figma_plugin.hello(token, info).await {
        Ok(session_token) => {
            state.ui.track("figma", "Figma Design plugin paired with the local TotalScript bridge");
            let link = state.figma_plugin.status().await;
            (StatusCode::OK, Json(json!({
                "ok": true,
                "session_token": session_token,
                "connected": link.connected,
                "status": link.state,
                "verified": link.verified,
                "tools": tools(link.connected).len(),
            })))
        }
        Err(HelloError::Unauthorized) => error_response(StatusCode::UNAUTHORIZED, "Invalid or expired Figma pairing/session token. Generate a fresh pairing code in TotalScript Settings."),
        Err(HelloError::Entropy(error)) => {
            tracing::error!("could not create Figma plugin session token: {error}");
            error_response(StatusCode::INTERNAL_SERVER_ERROR, "TotalScript could not create a secure Figma session")
        }
    }
}

pub async fn poll_handler(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> impl IntoResponse {
    let client_id = query.get("client_id").map(String::as_str).unwrap_or("");
    let Some(token) = token_from(&headers) else {
        return error_response(StatusCode::UNAUTHORIZED, "Figma session token is required");
    };
    if !state.figma_plugin.authorized(token, client_id).await {
        return error_response(StatusCode::UNAUTHORIZED, "Figma session is no longer paired; reconnect from the Figma plugin");
    }
    let deadline = tokio::time::Instant::now() + POLL_WAIT;
    loop {
        match state.figma_plugin.take_job_for(client_id, token).await {
            Ok(Some(job)) => {
                state.ui.track("figma", format!("Figma plugin accepted {}", job.name));
                return (StatusCode::OK, Json(json!({ "ok": true, "job": job })));
            }
            Ok(None) => {}
            Err(ClientState::Unauthorized) => return error_response(StatusCode::UNAUTHORIZED, "Figma session is no longer paired"),
            Err(ClientState::Stale) => return error_response(StatusCode::CONFLICT, "Figma plugin heartbeat is stale; reconnect it before retrying"),
        }
        if tokio::time::timeout_at(deadline, state.figma_plugin.wake.notified()).await.is_err() {
            if !state.figma_plugin.touch(client_id, token).await {
                return error_response(StatusCode::UNAUTHORIZED, "Figma session is no longer paired");
            }
            return (StatusCode::OK, Json(json!({ "ok": true, "job": Value::Null })));
        }
    }
}

pub async fn result_handler(State(state): State<AppState>, headers: HeaderMap, Json(result): Json<JobResult>) -> impl IntoResponse {
    let Some(token) = token_from(&headers) else {
        return error_response(StatusCode::UNAUTHORIZED, "Figma session token is required");
    };
    if !state.figma_plugin.authorized(token, &result.client_id).await {
        return error_response(StatusCode::UNAUTHORIZED, "Figma session is no longer paired");
    }
    let size = match serde_json::to_vec(&result.result) {
        Ok(bytes) => bytes.len(),
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "Invalid Figma plugin result JSON"),
    };
    if size > MAX_RESULT_BYTES {
        return error_response(StatusCode::PAYLOAD_TOO_LARGE, "Figma plugin result exceeded the 7 MiB safety limit");
    }
    if !state.figma_plugin.accept_result(&result, token).await {
        return error_response(StatusCode::CONFLICT, "Unknown or expired Figma plugin job result");
    }
    let _ = state.figma_plugin.results.send(result);
    (StatusCode::OK, Json(json!({ "ok": true })))
}

pub async fn goodbye_handler(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<Value>) -> impl IntoResponse {
    let client_id = req.get("client_id").and_then(Value::as_str).unwrap_or("");
    let Some(token) = token_from(&headers) else {
        return error_response(StatusCode::UNAUTHORIZED, "Figma session token is required");
    };
    let disconnected = state.figma_plugin.disconnect(client_id, token).await;
    if disconnected {
        state.ui.track("figma", "Figma Design plugin disconnected from TotalScript");
    }
    (if disconnected { StatusCode::OK } else { StatusCode::UNAUTHORIZED }, Json(json!({ "ok": disconnected, "disconnected": disconnected })))
}

pub async fn revoke_handler(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if !pairing_request_allowed(origin_from(&headers)) {
        return error_response(StatusCode::FORBIDDEN, "Figma pairing can only be revoked from TotalScript Settings → Connections");
    }
    state.figma_plugin.revoke().await;
    state.ui.track("figma", "Figma plugin pairing revoked from TotalScript");
    let mut status = status_json(&state).await;
    if let Some(object) = status.as_object_mut() {
        object.insert("ok".into(), Value::Bool(true));
        object.insert("revoked".into(), Value::Bool(true));
    }
    (StatusCode::OK, Json(status))
}

pub async fn status_handler(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> impl IntoResponse {
    if origin_from(&headers) == Some("null") {
        let client_id = query.get("client_id").map(String::as_str).unwrap_or("");
        let Some(token) = token_from(&headers) else {
            return error_response(StatusCode::UNAUTHORIZED, "Figma session token is required for plugin-origin status requests");
        };
        if !state.figma_plugin.authorized(token, client_id).await {
            return error_response(StatusCode::UNAUTHORIZED, "Figma session is no longer paired");
        }
    }
    (StatusCode::OK, Json(status_json(&state).await))
}

pub async fn status_json(state: &AppState) -> Value {
    let status = state.figma_plugin.status().await;
    let checked_at = chrono::Utc::now().timestamp_millis();
    let pairing_expires_at = state.figma_plugin.pairing_expiry().await;
    json!({
        "ok": status.connected,
        "connected": status.connected,
        "verified": status.verified,
        "status": status.state,
        "status_error": status.error,
        "checked_at": checked_at,
        "tools": tools(status.connected).len(),
        "pairing_pending": pairing_expires_at.is_some(),
        "pairing_expires_at": pairing_expires_at,
        "queue": state.figma_plugin.queued().await,
    })
}

pub fn is_tool(name: &str) -> bool {
    let bare = name.rsplit('/').next().unwrap_or(name);
    TOOL_NAMES.contains(&bare)
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "server": "figma_plugin",
        "inputSchema": { "type": "object", "properties": properties, "required": required },
    })
}

pub fn tools(connected: bool) -> Vec<Value> {
    let mut catalog = vec![tool(
        "figma_plugin_status",
        "Figma Design plugin: report the verified local plugin link. No Dev Mode, Figma API key, Roblox Studio, or Figma Desktop MCP server is required.",
        json!({}),
        &[],
    )];
    if !connected { return catalog; }
    catalog.extend([
        tool("figma_plugin_document", "Inspect the open Figma Design file, current page, page names, and top-level layer counts.", json!({"include_pages": {"type": "boolean"}}), &[]),
        tool("figma_plugin_selection", "Read the current canvas selection and node geometry/style summaries. Use before editing to identify exact node IDs.", json!({"limit": {"type": "integer", "minimum": 1, "maximum": 50}}), &[]),
        tool("figma_plugin_find", "Find layers by case-insensitive name text and optional node type on the current page. Returns node IDs for later edits.", json!({"query": {"type": "string"}, "type": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}}), &["query"]),
        tool("figma_plugin_page", "List, create, rename, or activate a page in the open Figma file. action = list | create | rename | activate; use page_id or exact name for rename/activate.", json!({"action": {"type": "string", "enum": ["list", "create", "rename", "activate"]}, "name": {"type": "string"}, "page_id": {"type": "string"}}), &["action"]),
        tool("figma_plugin_create_frame", "Create a frame on the current page or inside a frame. Coordinates are relative to the parent; width/height are 1–10000 px. Optional fill is #RRGGBB.", json!({"name": {"type": "string"}, "width": {"type": "number"}, "height": {"type": "number"}, "x": {"type": "number"}, "y": {"type": "number"}, "fill": {"type": "string"}, "parent_id": {"type": "string"}, "clip_content": {"type": "boolean"}}), &["width", "height"]),
        tool("figma_plugin_create_shape", "Create a rectangle, ellipse, line, polygon, or star on the current page/inside a frame. Optional fill/stroke use #RRGGBB.", json!({"shape": {"type": "string", "enum": ["rectangle", "ellipse", "line", "polygon", "star"]}, "name": {"type": "string"}, "width": {"type": "number"}, "height": {"type": "number"}, "x": {"type": "number"}, "y": {"type": "number"}, "rotation": {"type": "number"}, "fill": {"type": "string"}, "stroke": {"type": "string"}, "stroke_width": {"type": "number"}, "point_count": {"type": "integer"}, "parent_id": {"type": "string"}}), &["shape"]),
        tool("figma_plugin_create_text", "Create a text layer after loading its requested font. Set font_family/style explicitly when a particular font is required; default is Inter Regular.", json!({"text": {"type": "string"}, "name": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "font_family": {"type": "string"}, "font_style": {"type": "string"}, "font_size": {"type": "number"}, "color": {"type": "string"}, "auto_resize": {"type": "string", "enum": ["HEIGHT", "WIDTH_AND_HEIGHT", "NONE"]}, "text_align": {"type": "string", "enum": ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]}, "parent_id": {"type": "string"}}), &["text"]),
        tool("figma_plugin_update_node", "Update a node by current-page node_id: name, position, size, rotation, opacity, visible/locked, solid fill/stroke, stroke width, or corner radius. Changes only supplied fields.", json!({"node_id": {"type": "string"}, "name": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "width": {"type": "number"}, "height": {"type": "number"}, "rotation": {"type": "number"}, "opacity": {"type": "number"}, "visible": {"type": "boolean"}, "locked": {"type": "boolean"}, "fill": {"type": "string"}, "stroke": {"type": "string"}, "stroke_width": {"type": "number"}, "corner_radius": {"type": "number"}}), &["node_id"]),
        tool("figma_plugin_set_text", "Replace the characters in an existing TEXT node. If the text has mixed fonts, pass font_family/style; fonts are loaded before writing.", json!({"node_id": {"type": "string"}, "text": {"type": "string"}, "font_family": {"type": "string"}, "font_style": {"type": "string"}, "font_size": {"type": "number"}, "color": {"type": "string"}}), &["node_id", "text"]),
        tool("figma_plugin_reparent", "Move a node under another frame/group or to the current page; refuses cycles and root-page edits. x/y, when supplied, are relative to the new parent.", json!({"node_id": {"type": "string"}, "parent_id": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}}), &["node_id"]),
        tool("figma_plugin_duplicate", "Duplicate up to 50 current-page nodes with an optional x/y offset. Returns the new node IDs.", json!({"node_ids": {"type": "array", "items": {"type": "string"}}, "dx": {"type": "number"}, "dy": {"type": "number"}}), &["node_ids"]),
        tool("figma_plugin_group", "Group 2–50 nodes that share the same parent on the current page. Returns the new group ID.", json!({"node_ids": {"type": "array", "items": {"type": "string"}}, "name": {"type": "string"}}), &["node_ids"]),
        tool("figma_plugin_delete", "Delete 1–50 current-page nodes by ID. Cannot delete the page/root; inspect the selection or find results first.", json!({"node_ids": {"type": "array", "items": {"type": "string"}}}), &["node_ids"]),
        tool("figma_plugin_export", "Export up to 3 nodes (defaults to selection) as PNG, JPG, or SVG and attach the resulting image(s) to the tool response. Scale = 1–4.", json!({"node_ids": {"type": "array", "items": {"type": "string"}}, "format": {"type": "string", "enum": ["PNG", "JPG", "SVG"]}, "scale": {"type": "number", "minimum": 1, "maximum": 4}}), &[]),
        tool("figma_plugin_component", "List components/component sets on the current page or create a component from one existing node. action = list | create; create needs node_id.", json!({"action": {"type": "string", "enum": ["list", "create"]}, "node_id": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}}), &["action"]),
    ]);
    catalog
}

fn secs_for(name: &str) -> u64 {
    match name {
        "figma_plugin_export" => 90,
        "figma_plugin_find" | "figma_plugin_component" => 60,
        _ => 45,
    }
}

pub fn render(result: JobResult, name: &str) -> anyhow::Result<McpToolOutput> {
    if !result.ok {
        anyhow::bail!("{}", result.error.unwrap_or_else(|| format!("{name} failed in the Figma plugin")));
    }
    let text = result.result.get("text").and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string_pretty(&result.result).unwrap_or_else(|_| result.result.to_string()));
    let images = result.result.get("images").and_then(Value::as_array).map(|rows| {
        rows.iter()
            .filter(|image| image.get("data").and_then(Value::as_str).is_some_and(|data| !data.is_empty()))
            .map(|image| json!({
                "mimeType": image.get("mimeType").and_then(Value::as_str).unwrap_or("image/png"),
                "data": image.get("data"),
            }))
            .collect()
    }).unwrap_or_default();
    Ok(McpToolOutput { text, images })
}

pub async fn call(state: &AppState, name: &str, args: Value) -> anyhow::Result<McpToolOutput> {
    let bare = name.rsplit('/').next().unwrap_or(name);
    if !is_tool(bare) { anyhow::bail!("ERROR FIGMA_PLUGIN_TOOL_INVALID: unsupported Figma plugin tool '{bare}'"); }
    if bare == "figma_plugin_status" {
        let status = status_json(state).await;
        return Ok(McpToolOutput { text: serde_json::to_string_pretty(&status)?, images: Vec::new() });
    }
    let link = state.figma_plugin.status().await;
    if !link.connected {
        if link.state == "disconnected" {
            anyhow::bail!("ERROR FIGMA_PLUGIN_OFFLINE: Figma plugin was disconnected. Reconnect from TotalScript Settings → Connections → Figma plugin; no operation was sent.");
        }
        anyhow::bail!("ERROR FIGMA_PLUGIN_STATUS_UNKNOWN: {}. Pair or check the Figma plugin before retrying; no operation was sent.", link.error.unwrap_or("Figma plugin status is unverified"));
    }
    let result = state.figma_plugin.run(bare, args, Duration::from_secs(secs_for(bare))).await?;
    render(result, bare)
}

// ───────────────────────── tests ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn info(id: &str) -> PluginInfo { PluginInfo { client_id: id.to_string(), version: "1.0.0".into() } }
    fn token(byte: char) -> String { std::iter::repeat(byte).take(64).collect() }

    #[test]
    fn pairing_and_revocation_are_not_available_to_null_or_web_origins() {
        for origin in [
            "chrome-extension://totalscript-id",
            "moz-extension://totalscript-id",
            "safari-web-extension://totalscript-id",
            "ms-browser-extension://totalscript-id",
        ] {
            assert!(pairing_request_allowed(Some(origin)), "extension origin {origin}");
        }
        for origin in [None, Some("null"), Some("https://example.com"), Some("file://") ] {
            assert!(!pairing_request_allowed(origin), "pair/revoke must refuse origin {origin:?}");
        }
    }

    #[tokio::test]
    async fn pairing_is_single_use_and_sessions_are_bound_to_the_client() {
        let hub = Hub::new();
        assert_eq!(hub.status().await.state, "unknown");
        let (pairing, expiry) = hub.issue_pairing().await.unwrap();
        assert_eq!(pairing.len(), 64);
        assert!(expiry > chrono::Utc::now().timestamp_millis());
        assert!(hub.hello(&token('0'), info("figma-test-client")).await.is_err());
        let session = hub.hello(&pairing, info("figma-test-client")).await.unwrap();
        assert_ne!(session, pairing);
        assert!(hub.authorized(&session, "figma-test-client").await);
        assert!(!hub.authorized(&session, "figma-other-client").await);
        assert_eq!(hub.status().await.state, "connected");
        assert!(hub.hello(&pairing, info("figma-test-client")).await.is_err(), "the pairing code cannot be replayed");
        assert_eq!(hub.hello(&session, info("figma-test-client")).await.unwrap(), session, "a saved session can re-announce after a plugin restart");
        assert!(hub.disconnect("figma-test-client", &session).await);
        assert_eq!(hub.status().await.state, "disconnected");
        assert!(!hub.authorized(&session, "figma-test-client").await);
    }

    #[tokio::test]
    async fn a_new_pairing_code_rotates_the_session_without_exposing_the_old_secret() {
        let hub = Hub::new();
        let (first, _) = hub.issue_pairing().await.unwrap();
        let old_session = hub.hello(&first, info("figma-first-client")).await.unwrap();
        let (second, _) = hub.issue_pairing().await.unwrap();
        let new_session = hub.hello(&second, info("figma-second-client")).await.unwrap();
        assert_ne!(old_session, new_session);
        assert!(!hub.authorized(&old_session, "figma-first-client").await);
        assert!(hub.authorized(&new_session, "figma-second-client").await);
        assert_eq!(hub.status().await.state, "connected");
        hub.revoke().await;
        assert_eq!(hub.status().await.state, "disconnected");
    }

    #[tokio::test]
    async fn queued_results_are_bound_to_the_paired_client_and_not_replayed() {
        let hub = Arc::new(Hub::new());
        let (pairing, _) = hub.issue_pairing().await.unwrap();
        let session = hub.hello(&pairing, info("figma-test-client")).await.unwrap();
        let worker_hub = hub.clone();
        let worker_token = session.clone();
        let worker = tokio::spawn(async move {
            loop {
                if let Some(job) = worker_hub.take_job_for("figma-test-client", &worker_token).await.unwrap() {
                    assert_eq!(job.name, "figma_plugin_create_frame");
                    let good = JobResult { id: job.id.clone(), client_id: "figma-test-client".into(), ok: true, result: json!({"text":"created"}), ..JobResult::default() };
                    assert!(worker_hub.accept_result(&good, &worker_token).await);
                    let replay = good.clone();
                    let _ = worker_hub.results.send(good);
                    assert!(!worker_hub.accept_result(&replay, &worker_token).await);
                    break;
                }
                tokio::task::yield_now().await;
            }
        });
        let result = hub.run("figma_plugin_create_frame", json!({"width": 320, "height": 180}), Duration::from_secs(2)).await.unwrap();
        worker.await.unwrap();
        assert!(result.ok);
        assert_eq!(result.result["text"], "created");
    }

    #[test]
    fn catalogue_and_plugin_source_are_in_sync() {
        let offline = tools(false);
        let online = tools(true);
        assert_eq!(offline.len(), 1);
        assert_eq!(online.len(), TOOL_NAMES.len());
        assert!(online.iter().all(|entry| entry["server"] == "figma_plugin"));
        for name in TOOL_NAMES {
            assert!(online.iter().any(|entry| entry["name"] == *name), "catalogue missing {name}");
            if *name != "figma_plugin_status" {
                assert!(PLUGIN_SOURCE.contains(&format!("case \"{name}\"")), "Figma plugin lacks dispatch case {name}");
            }
        }
        assert!(!is_tool("figma_get_file"), "Desktop MCP tool names stay separate");
        assert!(is_tool("figma_plugin/figma_plugin_status"));
        assert!(!is_tool("figma_plugin_eval"), "arbitrary/eval commands are not exposed");
        assert!(!PLUGIN_SOURCE.contains("new Function") && !PLUGIN_SOURCE.contains("eval("));
    }

    #[test]
    fn image_results_are_bounded_to_valid_non_empty_attachments() {
        let result = JobResult {
            id: "job-1".into(), client_id: "figma-test-client".into(), ok: true,
            result: json!({"text":"frame exported", "images":[{"mimeType":"image/png","data":"AAAA"},{"mimeType":"image/png","data":""}]}),
            ..JobResult::default()
        };
        let output = render(result, "figma_plugin_export").unwrap();
        assert_eq!(output.text, "frame exported");
        assert_eq!(output.images.len(), 1);
        let failed = JobResult { ok: false, error: Some("ERROR INVALID_ARGUMENT: bad node".into()), ..JobResult::default() };
        assert!(render(failed, "figma_plugin_export").unwrap_err().to_string().starts_with("ERROR INVALID_ARGUMENT"));
    }
}
