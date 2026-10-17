//! Loopback HTTP IPC server — lets the MCP binary (and any other local agent)
//! talk to the running app without Tauri internals.
//!
//! On startup the server binds to 127.0.0.1:0 (OS-assigned port), writes the
//! chosen port to `~/.mdopener/ipc-port`, and removes that file on clean exit.
//!
//! ## Endpoints
//!
//! | Method | Path       | Body / query                          | Description                        |
//! |--------|------------|---------------------------------------|------------------------------------|
//! | GET    | /health    | —                                     | Liveness check                     |
//! | GET    | /content   | —                                     | Current document `{path, content}` |
//! | POST   | /content   | `{"content":"…","save":true|false}`   | Replace doc content                |
//! | POST   | /open      | `{"path":"…","mode":"read|edit"}`     | Open a file                        |
//! | GET    | /recent    | `?limit=N` (default 10)               | Recent-file list                   |
//! | POST   | /export    | `{"format":"pdf|docx|html","outputPath":"…|null"}` | Trigger export |
//! | GET    | /vault     | —                                     | Watched-folder files + recents     |
//! | GET    | /search    | `?q=…&limit=N`                        | Full-text search across the vault  |
//! | POST   | /edit      | `{"find":"…","replace":"…","save":bool}` | Exact find/replace on LIVE doc (round-trip) |
//! | POST   | /present   | `{"path":"…|null"}`                   | Open + distraction-free reading    |
//!
//! Auth: every endpoint except `/health` requires `Authorization: Bearer <token>`
//! (the per-session token in `~/.mdopener/ipc-token`).
//!
//! Content is kept in [`DocMirror`], a managed Tauri state struct that the
//! frontend syncs via `mcp_sync_state` on every document change (debounced
//! 200 ms). Mutations (`/content`, `/open`, `/export`) emit a Tauri event the
//! frontend picks up and applies.
//!
//! `/edit` is special: because the 200 ms debounce makes [`DocMirror`] stale
//! right after the user types, applying a find/replace against it could miss
//! live text or clobber just-typed edits. So `/edit` is a synchronous ROUND-TRIP
//! — it emits `mcp://edit`, parks the worker thread on a [`PendingEdits`] oneshot,
//! and the frontend applies the find/replace against its LIVE `documentStore`
//! content and reports the outcome back via the `mcp_edit_result` command.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

// ── Session persistence types ──────────────────────────────────────────────────

/// A single conversation message mirrored from the frontend for disk persistence.
#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionMessage {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub role: String,
    pub content: String,
    #[serde(rename = "citedDocs", default)]
    pub cited_docs: Vec<String>,
    #[serde(rename = "timestampMs")]
    pub timestamp_ms: u64,
}

/// In-memory session store managed by Tauri — keyed by session_id.
/// `mcp_persist_session` and `mcp_load_session` keep it in step with the
/// session files on disk, which are shared with mdopener-mcp.
#[derive(Default)]
pub struct SessionStore(pub Mutex<HashMap<String, Vec<SessionMessage>>>);

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Method, Request, Response, Server};

// ── Managed state ─────────────────────────────────────────────────────────────

/// Mirror of the frontend document state, synced by `mcp_sync_state`.
#[derive(Default, Clone, Serialize)]
pub struct DocMirrorInner {
    pub path: Option<String>,
    pub content: String,
}

#[derive(Default)]
pub struct DocMirror(pub Mutex<DocMirrorInner>);

/// Recent-file list mirrored from the frontend.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct RecentFileEntry {
    pub path: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "openedAt")]
    pub opened_at: u64,
}

#[derive(Default)]
pub struct RecentMirror(pub Mutex<Vec<RecentFileEntry>>);

/// One pending or completed human-review request (from the `request_review`
/// MCP tool). Keyed by reviewId in [`ReviewState`].
#[derive(Clone, Serialize)]
pub struct ReviewRecord {
    /// "pending" | "approved" | "changes_requested" | "dismissed".
    pub status: String,
    pub verdict: Option<String>,
    pub comments: Option<String>,
    pub path: Option<String>,
    pub created_at: u64,
}

#[derive(Default)]
pub struct ReviewState(pub Mutex<std::collections::HashMap<String, ReviewRecord>>);

/// One file in the user's "vault" (the watched folder), mirrored from the
/// frontend so the MCP `/vault` and `/search` endpoints can enumerate it.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct VaultFileEntry {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub dir: String,
}

#[derive(Default, Clone)]
pub struct VaultInner {
    pub watched_dir: Option<String>,
    pub files: Vec<VaultFileEntry>,
}

#[derive(Default)]
pub struct VaultMirror(pub Mutex<VaultInner>);

/// The outcome of a frontend-applied `/edit`, reported back by the
/// `mcp_edit_result` command and forwarded to the waiting IPC worker thread.
pub struct EditOutcome {
    /// True when the find/replace was applied (exactly one match).
    pub ok: bool,
    /// Number of replacements made (1 on success, 0 on failure).
    pub replaced: u32,
    /// Human-readable reason when `ok` is false (not found / not unique / no doc).
    pub error: Option<String>,
}

/// In-flight `/edit` round-trips, keyed by a per-request `editId`. The IPC worker
/// thread parks on the receiver half; the frontend answers via `mcp_edit_result`,
/// which sends the [`EditOutcome`] through the matching sender.
///
/// WHY a round-trip: the find/replace must run against the LIVE document the user
/// is editing, not the 200 ms-debounced [`DocMirror`]. Computing it on the
/// frontend (against `documentStore`'s current content) both (a) sees text the
/// user typed in the last debounce window and (b) derives the new content from
/// that live basis, so applying it can never clobber the user's just-typed edits.
#[derive(Default)]
pub struct PendingEdits(pub Mutex<HashMap<String, mpsc::Sender<EditOutcome>>>);

/// One candidate diff when `find` matches at multiple locations.
#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct StreamEditCandidate {
    #[serde(rename = "matchIndex")]
    pub match_index: u32,
    #[serde(rename = "startLine")]
    pub start_line: u32,
    pub diff: String,
    pub rank: u32,
}

/// The result of a `mcp://stream-edit` preview, forwarded from the frontend.
#[derive(Default)]
pub struct StreamEditPreviewOutcome {
    pub ok: bool,
    pub diff: String,
    pub candidates: Option<Vec<StreamEditCandidate>>,
    pub match_count: u32,
    pub error: Option<String>,
}

/// In-flight `/stream-edit` round-trips. Same parking pattern as `PendingEdits`.
#[derive(Default)]
pub struct PendingStreamEdits(pub Mutex<HashMap<String, mpsc::Sender<StreamEditPreviewOutcome>>>);

/// The result of a `mcp://stream-edit-apply`, forwarded from the frontend.
#[derive(Default)]
pub struct StreamEditApplyOutcome {
    pub ok: bool,
    pub replaced: u32,
    pub match_index: u32,
    pub error: Option<String>,
}

/// In-flight `/stream-edit-apply` round-trips.
#[derive(Default)]
pub struct PendingStreamEditsApply(pub Mutex<HashMap<String, mpsc::Sender<StreamEditApplyOutcome>>>);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Tauri commands (called by the frontend) ───────────────────────────────────

/// Called by the frontend (debounced) whenever path or content changes.
/// This keeps `DocMirror` in sync so IPC `/content` reads are always fresh.
#[tauri::command]
pub fn mcp_sync_state(
    path: Option<String>,
    content: String,
    recents: Vec<RecentFileEntry>,
    mirror: tauri::State<DocMirror>,
    recent_mirror: tauri::State<RecentMirror>,
) {
    *mirror.0.lock().unwrap() = DocMirrorInner { path, content };
    *recent_mirror.0.lock().unwrap() = recents;
}

/// Called by the frontend review panel when the human clicks Approve / Request-
/// changes / Dismiss. Records the verdict so the polling MCP binary returns it
/// to the agent.
#[tauri::command]
pub fn set_review_verdict(
    review_id: String,
    verdict: String,
    comments: Option<String>,
    state: tauri::State<ReviewState>,
) -> Result<(), String> {
    if !["approved", "changes_requested", "dismissed"].contains(&verdict.as_str()) {
        return Err(format!("Invalid verdict: {verdict}"));
    }
    let mut map = state.0.lock().unwrap();
    match map.get_mut(&review_id) {
        None => Err(format!("Review {review_id} not found")),
        Some(r) => {
            r.status = verdict.clone();
            r.verdict = Some(verdict);
            r.comments = comments;
            Ok(())
        }
    }
}

/// Called by the frontend (debounced) when the watched folder or its file list
/// changes. Keeps [`VaultMirror`] fresh so the `/vault` and `/search` endpoints
/// can enumerate the user's notes without re-walking the disk per request.
#[tauri::command]
pub fn mcp_sync_vault(
    watched_dir: Option<String>,
    files: Vec<VaultFileEntry>,
    vault: tauri::State<VaultMirror>,
) {
    *vault.0.lock().unwrap() = VaultInner { watched_dir, files };
}

/// Called by the frontend after it applies an `mcp://edit` against the LIVE
/// document. Forwards the outcome to the IPC worker thread parked in
/// `handle_edit`. Removing the sender from [`PendingEdits`] here means a stray or
/// duplicate reply for an already-resolved (or timed-out) edit is silently
/// ignored rather than panicking on a dropped receiver.
#[tauri::command]
pub fn mcp_edit_result(
    edit_id: String,
    ok: bool,
    replaced: u32,
    error: Option<String>,
    pending: tauri::State<PendingEdits>,
) {
    let tx = pending.0.lock().unwrap().remove(&edit_id);
    if let Some(tx) = tx {
        // The receiver may already be gone if handle_edit timed out; ignore.
        let _ = tx.send(EditOutcome { ok, replaced, error });
    }
}

/// Called by the frontend after computing a `mcp://stream-edit` diff preview.
/// Forwards the outcome to the IPC worker thread parked in `handle_stream_edit`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command args map 1:1 to the frontend IPC payload.
pub fn mcp_stream_edit_preview(
    edit_id: String,
    ok: bool,
    diff: String,
    candidates: Option<Vec<StreamEditCandidate>>,
    match_count: u32,
    #[allow(unused_variables)]
    preview_lines: u32,
    error: Option<String>,
    pending: tauri::State<PendingStreamEdits>,
) {
    let tx = pending.0.lock().unwrap().remove(&edit_id);
    if let Some(tx) = tx {
        let _ = tx.send(StreamEditPreviewOutcome { ok, diff, candidates, match_count, error });
    }
}

/// Called by the frontend after atomically applying a `mcp://stream-edit-apply`.
/// Forwards the outcome to the IPC worker thread parked in `handle_stream_edit_apply`.
#[tauri::command]
pub fn mcp_stream_edit_apply_result(
    edit_id: String,
    ok: bool,
    replaced: u32,
    match_index: u32,
    error: Option<String>,
    pending: tauri::State<PendingStreamEditsApply>,
) {
    let tx = pending.0.lock().unwrap().remove(&edit_id);
    if let Some(tx) = tx {
        let _ = tx.send(StreamEditApplyOutcome { ok, replaced, match_index, error });
    }
}

// ── Session persistence commands ──────────────────────────────────────────────

/// Return the directory where session JSON files live, creating it if needed.
fn sessions_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".mdopener").join("sessions"))
}

/// The file name mdopener-mcp gives `session_id` (`session_file_path` in
/// bins/mdopener-mcp/src/lib.rs): ASCII letters, digits, `-` and `_` are kept
/// and every other byte is written as `%XX`, so distinct ids never share a
/// file (`a.b` is `a%2Eb.json`, `a_b` is `a_b.json`). Both processes read and
/// write the same files, so the two mappings must stay identical.
fn session_file_name(session_id: &str) -> String {
    let mut safe = String::with_capacity(session_id.len() + 5);
    for b in session_id.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            safe.push(b as char);
        } else {
            safe.push_str(&format!("%{b:02X}"));
        }
    }
    safe.push_str(".json");
    safe
}

/// The name earlier builds of both the app and mdopener-mcp used: every
/// character other than an alphanumeric, `-` or `_` became `_`, so `a.b` and
/// `a_b` shared `a_b.json`. Only read, as a fallback for older history.
fn legacy_session_file_name(session_id: &str) -> String {
    let safe: String = session_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("{safe}.json")
}

/// A session file: mdopener-mcp's `{"messages":[…]}`, or the bare array
/// earlier app builds wrote.
#[derive(Deserialize)]
#[serde(untagged)]
enum SessionFile {
    Log { messages: Vec<SessionMessage> },
    Bare(Vec<SessionMessage>),
}

#[derive(Serialize)]
struct SessionFileOut<'a> {
    messages: &'a [SessionMessage],
}

/// Messages per session kept on disk; matches mdopener-mcp's
/// `MAX_MESSAGES_PER_SESSION`.
const MAX_SESSION_MESSAGES: usize = 200;

fn parse_session_file(path: &std::path::Path) -> Result<Vec<SessionMessage>, String> {
    if !std::fs::metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false)
    {
        return Err(format!("{} is not a regular file", path.display()));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    match serde_json::from_str::<SessionFile>(&text) {
        Ok(SessionFile::Log { messages } | SessionFile::Bare(messages)) => Ok(messages),
        Err(e) => Err(format!("{} is not a session file: {e}", path.display())),
    }
}

/// `session_id`'s messages on disk, and whether its file also holds another
/// session's messages (ids that differ only in case share a file on a
/// case-insensitive file system). With no file of its own yet, the legacy
/// file is read instead, keeping only this id's messages.
fn load_own_session(
    dir: &std::path::Path,
    session_id: &str,
) -> Result<(Vec<SessionMessage>, bool), String> {
    let own = |mut messages: Vec<SessionMessage>| {
        let before = messages.len();
        messages.retain(|m| m.session_id == session_id);
        let foreign = messages.len() != before;
        (messages, foreign)
    };
    let name = session_file_name(session_id);
    let path = dir.join(&name);
    if path.exists() {
        return parse_session_file(&path).map(own);
    }
    let legacy = legacy_session_file_name(session_id);
    if legacy != name {
        if let Ok(messages) = parse_session_file(&dir.join(legacy)) {
            return Ok((own(messages).0, false));
        }
    }
    Ok((vec![], false))
}

/// Hold the sessions directory's lock file while reading and rewriting a
/// session, so the app and mdopener-mcp (which takes the same lock) never
/// write back a stale copy over each other's appends.
fn lock_sessions_dir(dir: &std::path::Path) -> Result<std::fs::File, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create sessions dir: {e}"))?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(".lock"))
        .map_err(|e| format!("Cannot open the sessions lock: {e}"))?;
    lock.lock()
        .map_err(|e| format!("Cannot lock the sessions dir: {e}"))?;
    Ok(lock)
}

/// Merge `messages` into `session_id`'s file in `dir` and return the merged
/// log. Messages already on disk (some saved by mdopener-mcp, which the
/// window never sees) are kept; new ones are added by id, in timestamp order,
/// keeping the newest [`MAX_SESSION_MESSAGES`]. A file that cannot be parsed
/// or that holds another id's messages is left untouched and is an error.
fn write_session_file(
    dir: &std::path::Path,
    session_id: &str,
    messages: &[SessionMessage],
) -> Result<Vec<SessionMessage>, String> {
    let _lock = lock_sessions_dir(dir)?;
    let (mut merged, foreign) = load_own_session(dir, session_id)?;
    let name = session_file_name(session_id);
    if foreign {
        return Err(format!(
            "Session file {} also holds another session's messages; not overwriting it.",
            dir.join(&name).display()
        ));
    }
    let mut seen: std::collections::HashSet<String> = merged.iter().map(|m| m.id.clone()).collect();
    for m in messages {
        if m.session_id == session_id && seen.insert(m.id.clone()) {
            merged.push(m.clone());
        }
    }
    merged.sort_by_key(|m| m.timestamp_ms);
    if merged.len() > MAX_SESSION_MESSAGES {
        let excess = merged.len() - MAX_SESSION_MESSAGES;
        merged.drain(..excess);
    }

    let json = serde_json::to_string_pretty(&SessionFileOut { messages: &merged })
        .map_err(|e| format!("JSON serialisation failed: {e}"))?;
    // Write a temp file and rename it over the target, so a reader never sees
    // a torn file.
    let target = dir.join(&name);
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, &json).map_err(|e| format!("Write failed: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Rename failed: {e}")
    })?;
    Ok(merged)
}

/// Read `session_id`'s messages from `dir` (empty when it has none).
fn read_session_file(
    dir: &std::path::Path,
    session_id: &str,
) -> Result<Vec<SessionMessage>, String> {
    load_own_session(dir, session_id).map(|(messages, _)| messages)
}

/// Called by the frontend to persist a session's message log to
/// `~/.mdopener/sessions/`, in the file and format mdopener-mcp uses for the
/// same session (see [`session_file_name`]). Messages the MCP server saved
/// are kept (see [`write_session_file`]), and the write is atomic.
#[tauri::command]
pub fn mcp_persist_session(
    session_id: String,
    messages: Vec<SessionMessage>,
    store: tauri::State<SessionStore>,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("`session_id` must not be empty".into());
    }

    let Some(dir) = sessions_dir() else {
        store
            .0
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?
            .insert(session_id, messages);
        return Ok(());
    };
    let merged = write_session_file(&dir, &session_id, &messages)?;
    store
        .0
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?
        .insert(session_id, merged);
    Ok(())
}

/// Called by the frontend on startup to restore a prior session's messages.
/// The file on disk is authoritative (mdopener-mcp appends to it); the
/// in-memory copy answers only when there is no file to read.
#[tauri::command]
pub fn mcp_load_session(
    session_id: String,
    store: tauri::State<SessionStore>,
) -> Result<Vec<SessionMessage>, String> {
    if session_id.trim().is_empty() {
        return Err("`session_id` must not be empty".into());
    }

    let from_disk = match sessions_dir() {
        Some(dir) => Some(read_session_file(&dir, &session_id)?),
        None => None,
    };
    let mut guard = store.0.lock().map_err(|e| format!("Lock error: {e}"))?;
    match from_disk {
        Some(messages) if !messages.is_empty() => {
            guard.insert(session_id, messages.clone());
            Ok(messages)
        }
        _ => Ok(guard.get(&session_id).cloned().unwrap_or_default()),
    }
}

// ── IPC port file helpers ─────────────────────────────────────────────────────

fn ipc_port_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".mdopener").join("ipc-port"))
}

fn ipc_token_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".mdopener").join("ipc-token"))
}

/// 32 bytes of OS CSPRNG randomness as 64 lowercase hex chars.
fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("Token generation failed: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Write `bytes` to `path`, owner-only. On Unix the file is created with mode
/// 0600 in a single syscall (no world-readable TOCTOU window between write and
/// chmod). Both the IPC token and port live under the user's home dir; keeping
/// them 0600 means no *other* user can read them (a same-user process is trusted
/// by the threat model — see SECURITY.md).
fn write_private(path: &std::path::Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let _ = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .and_then(|mut f| f.write_all(bytes));
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::write(path, bytes);
    }
}

fn write_port(port: u16) {
    if let Some(path) = ipc_port_path() {
        write_private(&path, port.to_string().as_bytes());
    }
}

fn write_token(token: &str) {
    if let Some(path) = ipc_token_path() {
        write_private(&path, token.as_bytes());
    }
}

pub fn remove_port_file() {
    if let Some(path) = ipc_port_path() {
        let _ = std::fs::remove_file(path);
    }
    if let Some(path) = ipc_token_path() {
        let _ = std::fs::remove_file(path);
    }
}

// ── Server startup ────────────────────────────────────────────────────────────

/// Start the IPC HTTP server on a background thread.  Returns the bound port.
/// Call this once from `.setup()`.
pub fn start(app: AppHandle) -> Result<u16, String> {
    // Bind to any free loopback port.
    let server =
        Server::http("127.0.0.1:0").map_err(|e| format!("IPC server bind failed: {e}"))?;

    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("could not get IPC server port")?;

    let token = generate_token()?;
    // Write the token first, then the port — the port file is the MCP binary's
    // "app is ready" signal, so it must not appear before the token exists.
    write_token(&token);
    write_port(port);
    let bearer = std::sync::Arc::new(format!("Bearer {token}"));

    std::thread::Builder::new()
        .name("mdopener-ipc".into())
        .spawn(move || run_server(server, app, bearer))
        .map_err(|e| format!("IPC thread spawn failed: {e}"))?;

    Ok(port)
}

// ── Request dispatch ──────────────────────────────────────────────────────────

/// Constant-time byte comparison so a token mismatch leaks no timing signal.
/// Returns false on length mismatch (after a full-length compare of the longer
/// input against itself to keep timing independent of where they diverge).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// True if the request carries the correct `Authorization: Bearer <token>`.
fn check_auth(req: &Request, bearer: &str) -> bool {
    req.headers().iter().any(|h| {
        h.field.equiv("Authorization") && ct_eq(h.value.as_str().as_bytes(), bearer.as_bytes())
    })
}

fn run_server(server: Server, app: AppHandle, bearer: std::sync::Arc<String>) {
    // Serve on a small worker pool. A single thread would let one slow/blocked
    // response write (e.g. a large `/content` read to a slow client) stall every
    // other request — including the MCP review poll — behind it. tiny_http's
    // `Server` is `Sync`, so several threads can `recv()` from it concurrently.
    const WORKERS: usize = 4;
    let server = std::sync::Arc::new(server);
    let mut handles = Vec::with_capacity(WORKERS);
    for _ in 0..WORKERS {
        let server = server.clone();
        let app = app.clone();
        let bearer = bearer.clone();
        handles.push(std::thread::spawn(move || {
            while let Ok(req) = server.recv() {
                handle_request(req, &app, &bearer);
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
}

fn handle_request(req: Request, app: &AppHandle, bearer: &str) {
    let method = req.method().clone();
    let url = req.url().to_string();
    // Separate path from query string.
    let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));

    // /health is unauthenticated — a liveness probe carrying no data.
    if method == Method::Get && path == "/health" {
        send_json(req, serde_json::json!({"ok": true}));
        return;
    }
    // Every other endpoint requires the loopback auth token.
    if !check_auth(&req, bearer) {
        send_error(req, 401, "Unauthorized");
        return;
    }

    match (method, path) {
            (Method::Post, "/review") => handle_review_post(req, app),
            (Method::Get, "/review/result") => handle_review_result(req, query, app),
            (Method::Get, "/annotations") => handle_annotations(req, query, app),

            (Method::Get, "/vault") => handle_vault(req, app),
            (Method::Get, "/search") => handle_search(req, query, app),
            (Method::Post, "/edit") => handle_edit(req, app),
            (Method::Post, "/stream-edit") => handle_stream_edit(req, app),
            (Method::Post, "/stream-edit-apply") => handle_stream_edit_apply(req, app),
            (Method::Post, "/present") => handle_present(req, app),

            (Method::Get, "/content") => {
                let mirror = app.state::<DocMirror>();
                let inner = mirror.0.lock().unwrap().clone();
                send_json(req, serde_json::json!({
                    "path": inner.path,
                    "content": inner.content,
                }));
            }

            (Method::Post, "/content") => handle_set_content(req, app),

            (Method::Post, "/open") => handle_open(req, app),

            (Method::Get, "/recent") => {
                let limit: usize = query
                    .split('&')
                    .find_map(|kv| kv.strip_prefix("limit=").and_then(|v| v.parse().ok()))
                    .unwrap_or(10);

                let mirror = app.state::<RecentMirror>();
                let recents: Vec<_> =
                    mirror.0.lock().unwrap().iter().take(limit).cloned().collect();
                send_json(req, serde_json::json!(recents));
            }

            (Method::Post, "/export") => handle_export(req, app),

            _ => {
                let _ = req.respond(Response::from_string("Not Found").with_status_code(404));
            }
        }
}

// ── Individual handlers ───────────────────────────────────────────────────────

/// Resolve a path an agent asked the app to open (`/open`, `/present`, or
/// `/review` with a path), refusing anything but a Markdown document. Without
/// this an agent could open `~/.ssh/id_rsa` and read it back through
/// `/content`, `/recent` or the recents-backed MCP resources, though the
/// MCP tools that read a path from disk accept Markdown only. The check runs
/// on the canonical path, so a `notes.md` symlink to a secret is refused;
/// dotfiles and anything that exists but is not a regular file are refused
/// too, and so is a path that does not exist: the window cannot open it, and
/// the endpoint would otherwise answer `ok` for an open that never happens.
/// Returns the canonical path.
fn checked_agent_path(raw: &str) -> Result<String, String> {
    let abs = std::fs::canonicalize(raw)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string());
    let p = std::path::Path::new(&abs);
    let markdown = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| crate::document::MD_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    let hidden = p
        .file_name()
        .and_then(|n| n.to_str())
        .is_none_or(|n| n.starts_with('.'));
    let not_a_file = std::fs::metadata(p).is_ok_and(|m| !m.is_file());
    if !markdown || hidden || not_a_file {
        return Err(format!(
            "Refusing to open '{abs}': agents can open only Markdown documents (.md, \
             .markdown, .mdown, .mkd, .mdx) that are not dotfiles."
        ));
    }
    if !p.exists() {
        return Err(format!("Cannot open '{abs}': the file does not exist."));
    }
    Ok(abs)
}

fn handle_set_content(mut req: Request, app: &AppHandle) {
    #[derive(Deserialize)]
    struct Body {
        content: String,
        #[serde(default)]
        save: bool,
    }

    let body = read_json_body::<Body>(&mut req);
    match body {
        Ok(b) => {
            let _ = app.emit("mcp://set-content", serde_json::json!({
                "content": b.content,
                "save": b.save,
            }));
            send_json(req, serde_json::json!({"ok": true}));
        }
        Err((code, e)) => send_error(req, code, &e),
    }
}

fn handle_open(mut req: Request, app: &AppHandle) {
    #[derive(Deserialize)]
    struct Body {
        path: String,
        #[serde(default)]
        mode: Option<String>,
    }

    let body = read_json_body::<Body>(&mut req);
    match body {
        Ok(b) => {
            let abs = match checked_agent_path(&b.path) {
                Ok(abs) => abs,
                Err(e) => return send_error(req, 400, &e),
            };

            let _ = app.emit("mcp://open", serde_json::json!({
                "path": abs,
                "mode": b.mode,
            }));
            send_json(req, serde_json::json!({"ok": true, "path": abs}));
        }
        Err((code, e)) => send_error(req, code, &e),
    }
}

fn handle_export(mut req: Request, app: &AppHandle) {
    #[derive(Deserialize)]
    struct Body {
        format: String,
        #[serde(rename = "outputPath")]
        output_path: Option<String>,
    }

    let body = read_json_body::<Body>(&mut req);
    match body {
        Ok(b) => {
            let _ = app.emit("mcp://export", serde_json::json!({
                "format": b.format,
                "outputPath": b.output_path,
            }));
            send_json(req, serde_json::json!({"ok": true}));
        }
        Err((code, e)) => send_error(req, code, &e),
    }
}

// ── Review handlers ───────────────────────────────────────────────────────────

fn handle_review_post(mut req: Request, app: &AppHandle) {
    #[derive(Deserialize)]
    struct Body {
        #[serde(rename = "reviewId")]
        review_id: String,
        path: Option<String>,
        content: Option<String>,
        #[serde(rename = "timeoutMs", default)]
        timeout_ms: Option<u64>,
    }
    let body = match read_json_body::<Body>(&mut req) {
        Ok(b) => b,
        Err((code, e)) => return send_error(req, code, &e),
    };
    if body.review_id.is_empty() {
        return send_error(req, 400, "reviewId is required");
    }
    let timeout_ms = body.timeout_ms.unwrap_or(300_000).clamp(5_000, 600_000);
    let abs_path = match body.path.as_deref().map(checked_agent_path).transpose() {
        Ok(p) => p,
        Err(e) => return send_error(req, 400, &e),
    };

    {
        let state = app.state::<ReviewState>();
        let mut map = state.0.lock().unwrap();
        if map.contains_key(&body.review_id) {
            return send_error(req, 409, "reviewId already exists");
        }
        map.insert(
            body.review_id.clone(),
            ReviewRecord {
                status: "pending".into(),
                verdict: None,
                comments: None,
                path: abs_path.clone(),
                created_at: now_ms(),
            },
        );
    }

    // If a file was given, open it (reuses the existing open machinery).
    if let Some(ref p) = abs_path {
        let _ = app.emit("mcp://open", serde_json::json!({ "path": p, "mode": "read" }));
    }
    // Tell the frontend a review is pending so it shows the review panel.
    let _ = app.emit(
        "mcp://review",
        serde_json::json!({
            "reviewId": body.review_id,
            "path": abs_path,
            "content": body.content,
            "timeoutMs": timeout_ms,
        }),
    );
    send_json(req, serde_json::json!({ "ok": true, "reviewId": body.review_id }));
}

fn handle_review_result(req: Request, query: &str, app: &AppHandle) {
    let id = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("id="))
        .unwrap_or("");
    if id.is_empty() {
        return send_error(req, 400, "id query param required");
    }
    // Clone the record out before responding so the mutex isn't held across the
    // blocking socket write in send_json (which would stall set_review_verdict
    // and every other ReviewState reader against a slow client).
    let record = {
        let state = app.state::<ReviewState>();
        let map = state.0.lock().unwrap();
        map.get(id)
            .map(|r| (r.status.clone(), r.verdict.clone(), r.comments.clone()))
    };
    match record {
        None => send_json(req, serde_json::json!({ "status": "not_found" })),
        Some((status, verdict, comments)) => send_json(req, serde_json::json!({
            "status": status,
            "verdict": verdict,
            "comments": comments,
        })),
    }
}

/// Parse GFM task-list checkboxes (`- [ ]` / `- [x]`, also `*`/`+` bullets).
/// True when `a` and `b` name the same file: canonical paths when both
/// resolve, else the raw strings.
fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// The GFM task checkboxes of the file `requested`: from the live buffer when
/// it is the open document, else read from disk when it is a Markdown file
/// (not a dotfile, checked after resolving symlinks), else none. Never the
/// open document's tasks for some other path.
fn annotation_tasks(
    requested: &str,
    open_path: Option<&str>,
    open_content: &str,
) -> Vec<serde_json::Value> {
    if open_path.is_some_and(|o| same_path(requested, o)) {
        return parse_tasks(open_content);
    }
    let Ok(canon) = std::fs::canonicalize(requested) else {
        return vec![];
    };
    let markdown = canon.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        ["md", "markdown", "mdown", "mkd", "mdx"].contains(&e.to_ascii_lowercase().as_str())
    });
    let hidden = canon
        .file_name()
        .and_then(|n| n.to_str())
        .is_none_or(|n| n.starts_with('.'));
    if !markdown || hidden || !canon.is_file() {
        return vec![];
    }
    std::fs::read_to_string(&canon)
        .map(|c| parse_tasks(&c))
        .unwrap_or_default()
}

fn parse_tasks(content: &str) -> Vec<serde_json::Value> {
    content
        .lines()
        .filter_map(|line| {
            let t = line.trim_start();
            let rest = t
                .strip_prefix("- ")
                .or_else(|| t.strip_prefix("* "))
                .or_else(|| t.strip_prefix("+ "))?
                .trim_start();
            let checked = if rest.starts_with("[ ]") {
                false
            } else if rest.starts_with("[x]") || rest.starts_with("[X]") {
                true
            } else {
                return None;
            };
            let text = rest[3..].trim().to_string();
            Some(serde_json::json!({ "text": text, "checked": checked }))
        })
        .collect()
}

fn handle_annotations(req: Request, query: &str, app: &AppHandle) {
    let raw_path = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("path="))
        .map(|v| urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default())
        .unwrap_or_default();

    let (open_path, open_content) = {
        let mirror = app.state::<DocMirror>();
        let inner = mirror.0.lock().unwrap();
        (inner.path.clone(), inner.content.clone())
    };
    let tasks = annotation_tasks(&raw_path, open_path.as_deref(), &open_content);

    // Resolve the latest matching verdict/comments, then drop the lock before
    // the blocking send_json response. Reviews store the canonical path, so a
    // relative or symlinked `path` still finds them.
    let (verdict, comments) = {
        let review_state = app.state::<ReviewState>();
        let map = review_state.0.lock().unwrap();
        map.values()
            .filter(|r| r.path.as_deref().is_some_and(|p| same_path(p, &raw_path)))
            .max_by_key(|r| r.created_at)
            .map(|r| (r.verdict.clone(), r.comments.clone()))
            .unwrap_or((None, None))
    };

    send_json(req, serde_json::json!({
        "path": raw_path,
        "verdict": verdict,
        "comments": comments,
        "tasks": tasks,
    }));
}

// ── Vault / search / edit / present handlers ──────────────────────────────────

/// GET /vault — enumerate the user's notes: the watched folder's files (mirrored
/// from the frontend) unioned with recent-file paths.
fn handle_vault(req: Request, app: &AppHandle) {
    let vault = app.state::<VaultMirror>().0.lock().unwrap().clone();
    let recents: Vec<String> = app
        .state::<RecentMirror>()
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|r| r.path.clone())
        .collect();
    send_json(req, serde_json::json!({
        "watchedDir": vault.watched_dir,
        "files": vault.files,
        "recents": recents,
    }));
}

/// GET /search?q=…&limit=N — full-text search across the vault + recents.
fn handle_search(req: Request, query: &str, app: &AppHandle) {
    let q = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("q="))
        .map(|v| urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default())
        .unwrap_or_default();
    let limit: usize = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("limit=").and_then(|v| v.parse::<usize>().ok()))
        .unwrap_or(50)
        .clamp(1, 200);

    if q.trim().is_empty() {
        return send_json(req, serde_json::json!({ "query": q, "results": [] }));
    }

    // Candidate set = vault files ∪ recents, deduped, locks dropped before search.
    let mut paths: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    {
        let vault_state = app.state::<VaultMirror>();
        let vault = vault_state.0.lock().unwrap();
        for f in vault.files.iter() {
            if seen.insert(f.path.clone()) {
                paths.push(f.path.clone());
            }
        }
    }
    {
        let recent_state = app.state::<RecentMirror>();
        let recents = recent_state.0.lock().unwrap();
        for r in recents.iter() {
            if seen.insert(r.path.clone()) {
                paths.push(r.path.clone());
            }
        }
    }

    let results = crate::search::search_files(paths, q.clone(), Some(limit));
    send_json(req, serde_json::json!({ "query": q, "results": results }));
}

/// Apply a single exact find→replace, requiring the `find` string to appear
/// EXACTLY once. Returns the new content, or a human-readable error explaining
/// why the edit could not be applied unambiguously.
///
/// NOTE: the production `/edit` path now applies this on the FRONTEND (against the
/// live document — see `applyUniqueEdit` in `src/mcp/applyEdit.ts`, which mirrors
/// this exact 0/1/>1-match contract). This reference implementation is retained
/// as the canonical spec and is exercised by the unit tests below to lock the
/// contract the TS port must uphold.
#[cfg_attr(not(test), allow(dead_code))]
fn apply_unique_edit(content: &str, find: &str, replace: &str) -> Result<String, String> {
    if find.is_empty() {
        return Err("`find` must not be empty.".into());
    }
    match content.matches(find).count() {
        0 => Err("`find` string not found in the current document.".into()),
        1 => Ok(content.replacen(find, replace, 1)),
        n => Err(format!(
            "`find` string is not unique ({n} matches) — include more surrounding context to disambiguate."
        )),
    }
}

/// How long the IPC worker thread parks waiting for the frontend to apply an
/// edit and report back via `mcp_edit_result`. Generous: the frontend work
/// (find/replace, `setContent`, and an optional save) is sub-millisecond, but the
/// app may be briefly busy. A timeout still bounds the worker so a wedged or
/// missing frontend can't pin it forever — the 3 other workers stay free anyway.
///
/// It must stay below mdopener-mcp's 5 s IPC read timeout (`tcp_roundtrip`),
/// or the client hangs up first and the agent never sees this server's reply.
const EDIT_ROUNDTRIP_TIMEOUT: Duration = Duration::from_secs(4);

/// Process-monotonic sequence for unique edit ids. The [`PendingEdits`] map is
/// per-process, so a plain counter is collision-free — unlike a millisecond
/// timestamp, which two back-to-back edits in the same clock ms can share (which
/// would overwrite one sender and make both round-trips spuriously time out).
static EDIT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Cap on edit round-trips parked on worker threads at once. With `WORKERS = 4`,
/// holding this to 2 guarantees at least one worker stays free for `/content`,
/// `/review/result` and `/health` even when a review poll is also parked.
const MAX_INFLIGHT_EDITS: usize = 2;
static INFLIGHT_EDITS: AtomicUsize = AtomicUsize::new(0);

/// RAII admission guard: lets at most [`MAX_INFLIGHT_EDITS`] edit round-trips run
/// concurrently and releases the slot on every return path (success, soft-fail,
/// timeout) via `Drop`.
struct InflightEdit;
impl InflightEdit {
    fn acquire() -> Option<Self> {
        if INFLIGHT_EDITS.fetch_add(1, Ordering::AcqRel) >= MAX_INFLIGHT_EDITS {
            INFLIGHT_EDITS.fetch_sub(1, Ordering::AcqRel);
            None
        } else {
            Some(InflightEdit)
        }
    }
}
impl Drop for InflightEdit {
    fn drop(&mut self) {
        INFLIGHT_EDITS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// True when `want` (a path an agent named) is the open document `have_raw`.
/// Canonical paths are compared when both resolve; otherwise the raw strings,
/// so both sides are always normalized the same way.
fn names_open_document(want: &str, have_raw: &str) -> bool {
    match (std::fs::canonicalize(want), std::fs::canonicalize(have_raw)) {
        (Ok(a), Ok(b)) => a == b,
        _ => want == have_raw,
    }
}

/// The open document's path as the frontend knows it, when `want` names it.
fn open_document_named(app: &AppHandle, want: &str) -> Option<String> {
    let have_raw = app
        .state::<DocMirror>()
        .0
        .lock()
        .unwrap()
        .path
        .clone()
        .unwrap_or_default();
    names_open_document(want, &have_raw).then_some(have_raw)
}

fn not_the_open_document() -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "error": "The named path is not the currently open document — open it first with open_file.",
    })
}

fn editor_busy() -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "error": "The editor is busy applying another edit — retry in a moment.",
    })
}

/// POST /edit — exact-string find/replace on the LIVE document.
///
/// The find/replace is applied on the FRONTEND, against `documentStore`'s current
/// content (never the 200 ms-debounced [`DocMirror`]). This both finds text the
/// user typed within the last debounce window and derives the new content from
/// that live basis, so the result can't clobber the user's just-typed edits.
///
/// Mechanics: register a oneshot in [`PendingEdits`], emit `mcp://edit`, then park
/// this worker thread on the receiver. The frontend's `mcp_edit_result` command
/// fulfils it with the match outcome, which we relay to the HTTP caller.
///
/// Soft failures (not found / not unique / no document open) come back as 200
/// `{"ok":false,"error":…}` so the agent sees the reason rather than an opaque
/// HTTP error — identical to the prior contract.
fn handle_edit(mut req: Request, app: &AppHandle) {
    #[derive(Deserialize)]
    struct Body {
        find: String,
        replace: String,
        #[serde(default)]
        save: bool,
        path: Option<String>,
    }
    let body = match read_json_body::<Body>(&mut req) {
        Ok(b) => b,
        Err((code, e)) => return send_error(req, code, &e),
    };

    // Guard the cheap, server-knowable failures up front so we don't bother the
    // frontend (or burn a round-trip) on them. An empty `find` is always invalid;
    // this also matches `apply_unique_edit`'s contract exactly.
    if body.find.is_empty() {
        return send_json(req, serde_json::json!({
            "ok": false,
            "error": "`find` must not be empty.",
        }));
    }

    // If the caller named a path, make sure it matches the open doc so they don't
    // silently edit the wrong file. The open path only changes on open/tab-switch
    // (not mid-keystroke), so the mirrored path isn't subject to the typing race
    // that the *content* is — checking it here is safe. Compare canonical paths
    // only when BOTH resolve; otherwise fall back to a raw string compare on both
    // sides so the two legs are always normalized the same way.
    if let Some(ref p) = body.path {
        if open_document_named(app, p).is_none() {
            return send_json(req, not_the_open_document());
        }
    }

    // Bound concurrent edit round-trips so they can't park every worker thread
    // and starve the fast endpoints (/content, /review/result, /health). Excess
    // edits soft-fail immediately so the agent can retry, rather than the whole
    // IPC server appearing wedged. The guard releases its slot on every path.
    let _inflight = match InflightEdit::acquire() {
        Some(g) => g,
        None => return send_json(req, editor_busy()),
    };

    // Register a oneshot keyed by a unique editId, then ask the frontend to apply
    // the edit against its live content.
    let edit_id = format!("edit_{}", EDIT_SEQ.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = mpsc::channel::<EditOutcome>();
    {
        let pending = app.state::<PendingEdits>();
        pending.0.lock().unwrap().insert(edit_id.clone(), tx);
    }
    let _ = app.emit("mcp://edit", serde_json::json!({
        "editId": edit_id,
        "find": body.find,
        "replace": body.replace,
        "save": body.save,
    }));

    // Park until the frontend reports back, or give up after the timeout. On
    // timeout (or a closed channel) drop the pending entry so a late reply is a
    // no-op rather than leaking the sender.
    match rx.recv_timeout(EDIT_ROUNDTRIP_TIMEOUT) {
        Ok(outcome) if outcome.ok => {
            send_json(req, serde_json::json!({ "ok": true, "replaced": outcome.replaced }));
        }
        Ok(outcome) => {
            let msg = outcome
                .error
                .unwrap_or_else(|| "Edit could not be applied.".into());
            send_json(req, serde_json::json!({ "ok": false, "error": msg }));
        }
        Err(_) => {
            app.state::<PendingEdits>().0.lock().unwrap().remove(&edit_id);
            send_json(req, serde_json::json!({
                "ok": false,
                "error": "Timed out waiting for the app to apply the edit — is a document open and the window responsive?",
            }));
        }
    }
}

/// POST /stream-edit — preview a find/replace as a unified diff before committing.
///
/// Emits `mcp://stream-edit` to the frontend, which computes the diff against the
/// LIVE document and calls back via `mcp_stream_edit_preview`. Same round-trip
/// parking pattern as `/edit`.
fn handle_stream_edit(mut req: Request, app: &AppHandle) {
    #[derive(Deserialize)]
    struct Body {
        find: String,
        replace: String,
        #[serde(default = "default_true")]
        preview: bool,
        #[serde(rename = "previewLines", default = "default_preview_lines")]
        preview_lines: u32,
        path: Option<String>,
    }
    fn default_true() -> bool { true }
    fn default_preview_lines() -> u32 { 5 }

    let body = match read_json_body::<Body>(&mut req) {
        Ok(b) => b,
        Err((code, e)) => return send_error(req, code, &e),
    };

    if body.find.is_empty() {
        return send_json(req, serde_json::json!({
            "ok": false,
            "error": "`find` must not be empty.",
        }));
    }
    // Same canonical path check as `/edit`. The frontend re-checks against
    // the path it knows (in case the tab changes meanwhile), so it is sent
    // that path rather than the agent's spelling of it.
    let path = match body.path.as_deref().map(|p| open_document_named(app, p)) {
        None => None,
        Some(Some(have)) => Some(have),
        Some(None) => return send_json(req, not_the_open_document()),
    };
    // Parks a worker like `/edit`, so it shares the same admission cap.
    let _inflight = match InflightEdit::acquire() {
        Some(g) => g,
        None => return send_json(req, editor_busy()),
    };

    let edit_id = format!("sedit_{}", EDIT_SEQ.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = mpsc::channel::<StreamEditPreviewOutcome>();
    {
        let pending = app.state::<PendingStreamEdits>();
        pending.0.lock().unwrap().insert(edit_id.clone(), tx);
    }

    let _ = app.emit(
        "mcp://stream-edit",
        serde_json::json!({
            "editId": edit_id,
            "find": body.find,
            "replace": body.replace,
            "preview": body.preview,
            "previewLines": body.preview_lines,
            "path": path,
        }),
    );

    match rx.recv_timeout(EDIT_ROUNDTRIP_TIMEOUT) {
        Ok(outcome) if outcome.ok => {
            send_json(req, serde_json::json!({
                "ok": true,
                "editId": edit_id,
                "diff": outcome.diff,
                "candidates": outcome.candidates,
                "matchCount": outcome.match_count,
            }));
        }
        Ok(outcome) => {
            let msg = outcome.error.unwrap_or_else(|| "stream-edit preview failed.".into());
            send_json(req, serde_json::json!({ "ok": false, "error": msg }));
        }
        Err(_) => {
            app.state::<PendingStreamEdits>().0.lock().unwrap().remove(&edit_id);
            send_json(req, serde_json::json!({
                "ok": false,
                "error": "Timed out waiting for stream-edit preview — is a document open?",
            }));
        }
    }
}

/// POST /stream-edit-apply — atomically apply a previously previewed stream edit.
///
/// Emits `mcp://stream-edit-apply` with find/replace/matchIndex. The frontend
/// calls `applyEditAtOccurrence` and reports back via `mcp_stream_edit_apply_result`.
fn handle_stream_edit_apply(mut req: Request, app: &AppHandle) {
    #[derive(Deserialize)]
    struct Body {
        #[serde(rename = "editId")]
        edit_id: String,
        find: String,
        replace: String,
        #[serde(rename = "matchIndex", default)]
        match_index: u32,
        #[serde(default)]
        save: bool,
        path: Option<String>,
    }

    let body = match read_json_body::<Body>(&mut req) {
        Ok(b) => b,
        Err((code, e)) => return send_error(req, code, &e),
    };

    if body.find.is_empty() {
        return send_json(req, serde_json::json!({
            "ok": false,
            "error": "`find` must not be empty.",
        }));
    }
    let path = match body.path.as_deref().map(|p| open_document_named(app, p)) {
        None => None,
        Some(Some(have)) => Some(have),
        Some(None) => return send_json(req, not_the_open_document()),
    };
    let _inflight = match InflightEdit::acquire() {
        Some(g) => g,
        None => return send_json(req, editor_busy()),
    };

    let apply_id = format!("sapply_{}", EDIT_SEQ.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = mpsc::channel::<StreamEditApplyOutcome>();
    {
        let pending = app.state::<PendingStreamEditsApply>();
        pending.0.lock().unwrap().insert(apply_id.clone(), tx);
    }

    let _ = app.emit(
        "mcp://stream-edit-apply",
        serde_json::json!({
            "editId": apply_id,
            "find": body.find,
            "replace": body.replace,
            "matchIndex": body.match_index,
            "save": body.save,
            "path": path,
            "originalEditId": body.edit_id,
        }),
    );

    match rx.recv_timeout(EDIT_ROUNDTRIP_TIMEOUT) {
        Ok(outcome) if outcome.ok => {
            send_json(req, serde_json::json!({
                "ok": true,
                "replaced": outcome.replaced,
                "matchIndex": outcome.match_index,
            }));
        }
        Ok(outcome) => {
            let msg = outcome.error.unwrap_or_else(|| "stream-edit-apply failed.".into());
            send_json(req, serde_json::json!({ "ok": false, "error": msg }));
        }
        Err(_) => {
            app.state::<PendingStreamEditsApply>().0.lock().unwrap().remove(&apply_id);
            send_json(req, serde_json::json!({
                "ok": false,
                "error": "Timed out waiting for stream-edit-apply — is a document open?",
            }));
        }
    }
}

/// POST /present — open a document (if a path is given) and put the app into a
/// distraction-free reading presentation. Emits `mcp://present`.
fn handle_present(mut req: Request, app: &AppHandle) {
    #[derive(Deserialize)]
    struct Body {
        path: Option<String>,
    }
    let body = match read_json_body::<Body>(&mut req) {
        Ok(b) => b,
        Err((code, e)) => return send_error(req, code, &e),
    };
    let abs = match body.path.as_deref().map(checked_agent_path).transpose() {
        Ok(p) => p,
        Err(e) => return send_error(req, 400, &e),
    };
    let _ = app.emit("mcp://present", serde_json::json!({ "path": abs }));
    send_json(req, serde_json::json!({ "ok": true, "path": abs }));
}

// ── HTTP response helpers ─────────────────────────────────────────────────────

fn send_json(req: Request, value: serde_json::Value) {
    let body = value.to_string();
    let resp = Response::from_string(body)
        .with_status_code(200)
        .with_header(
            tiny_http::Header::from_bytes(b"Content-Type", b"application/json").unwrap(),
        );
    let _ = req.respond(resp);
}

fn send_error(req: Request, code: u16, msg: &str) {
    let body = serde_json::json!({"error": msg}).to_string();
    let resp = Response::from_string(body)
        .with_status_code(code)
        .with_header(
            tiny_http::Header::from_bytes(b"Content-Type", b"application/json").unwrap(),
        );
    let _ = req.respond(resp);
}

/// Read and parse a JSON request body; an error carries the HTTP status.
fn read_json_body<T: serde::de::DeserializeOwned>(req: &mut Request) -> Result<T, (u16, String)> {
    // Cap the body so a malformed/hostile local caller can't OOM the server
    // thread with an unbounded POST. 16 MiB is generous for any real document.
    const MAX_BODY: u64 = 16 * 1024 * 1024;
    read_json_from(req.as_reader(), MAX_BODY)
}

/// Parse at most `max` bytes of JSON from `body`. A longer body is refused
/// with 413 rather than cut at the cap, which used to surface as a puzzling
/// "Invalid JSON body: EOF while parsing" for a large but valid document.
fn read_json_from<T: serde::de::DeserializeOwned>(
    body: impl std::io::Read,
    max: u64,
) -> Result<T, (u16, String)> {
    use std::io::Read;
    let mut buf = String::new();
    body.take(max + 1)
        .read_to_string(&mut buf)
        .map_err(|e| (400, format!("Failed to read request body: {e}")))?;
    if buf.len() as u64 > max {
        return Err((413, format!("Request body is larger than {max} bytes.")));
    }
    serde_json::from_str(&buf).map_err(|e| (400, format!("Invalid JSON body: {e}")))
}

#[cfg(test)]
mod tests {
    use super::{
        annotation_tasks, apply_unique_edit, parse_tasks, same_path, InflightEdit, INFLIGHT_EDITS,
        MAX_INFLIGHT_EDITS,
    };
    use std::sync::atomic::Ordering;

    #[test]
    fn inflight_edit_guard_caps_concurrency() {
        // Admits up to the cap, refuses beyond it, and frees a slot on Drop so a
        // burst of /edit requests can never park every worker thread.
        let mut guards: Vec<InflightEdit> = Vec::new();
        for _ in 0..MAX_INFLIGHT_EDITS {
            let g = InflightEdit::acquire();
            assert!(g.is_some(), "should admit up to the cap");
            guards.push(g.unwrap());
        }
        assert!(
            InflightEdit::acquire().is_none(),
            "should refuse a round-trip beyond the cap"
        );
        // Freeing one slot makes room for exactly one more.
        guards.pop();
        let extra = InflightEdit::acquire();
        assert!(extra.is_some(), "a freed slot is reusable");
        drop(extra);
        drop(guards);
        assert_eq!(
            INFLIGHT_EDITS.load(Ordering::Acquire),
            0,
            "every slot is released once guards drop"
        );
    }

    #[test]
    fn edit_replaces_a_unique_match() {
        let doc = "# Title\n\nHello world.\n";
        assert_eq!(
            apply_unique_edit(doc, "Hello world.", "Hello there.").unwrap(),
            "# Title\n\nHello there.\n"
        );
    }

    #[test]
    fn edit_errors_when_find_is_missing() {
        let err = apply_unique_edit("abc", "xyz", "q").unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[test]
    fn edit_errors_when_find_is_not_unique() {
        // "the" appears twice — must refuse rather than guess.
        let err = apply_unique_edit("the cat sat on the mat", "the", "a").unwrap_err();
        assert!(err.contains("not unique"), "got: {err}");
        assert!(err.contains('2'), "should report the match count: {err}");
    }

    #[test]
    fn edit_rejects_empty_find() {
        assert!(apply_unique_edit("anything", "", "x").is_err());
    }

    #[test]
    fn edit_replaces_only_the_first_when_unique() {
        // A multi-line unique anchor replaced cleanly.
        let doc = "line one\nUNIQUE ANCHOR\nline three";
        assert_eq!(
            apply_unique_edit(doc, "UNIQUE ANCHOR", "replaced").unwrap(),
            "line one\nreplaced\nline three"
        );
    }

    /// Helper: extract (text, checked) pairs for terse assertions.
    fn pairs(content: &str) -> Vec<(String, bool)> {
        parse_tasks(content)
            .into_iter()
            .map(|v| {
                (
                    v["text"].as_str().unwrap().to_string(),
                    v["checked"].as_bool().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn parses_unchecked_and_checked() {
        let md = "- [ ] todo one\n- [x] done two\n";
        assert_eq!(
            pairs(md),
            vec![
                ("todo one".to_string(), false),
                ("done two".to_string(), true),
            ]
        );
    }

    #[test]
    fn accepts_all_bullet_markers_and_uppercase_x() {
        let md = "- [ ] dash\n* [X] star\n+ [x] plus\n";
        assert_eq!(
            pairs(md),
            vec![
                ("dash".to_string(), false),
                ("star".to_string(), true),
                ("plus".to_string(), true),
            ]
        );
    }

    #[test]
    fn ignores_non_task_lines() {
        // Plain bullets, prose, and headings are not tasks.
        let md = "# Heading\n- a normal bullet\nsome prose\n- [ ] real task\n";
        assert_eq!(pairs(md), vec![("real task".to_string(), false)]);
    }

    #[test]
    fn handles_indented_tasks_and_empty_text() {
        let md = "  - [ ] indented\n- [x]\n";
        assert_eq!(
            pairs(md),
            vec![
                ("indented".to_string(), false),
                (String::new(), true),
            ]
        );
    }

    #[test]
    fn empty_input_yields_no_tasks() {
        assert!(parse_tasks("").is_empty());
    }

    #[test]
    fn annotation_tasks_belong_to_the_requested_file() {
        struct Dir(std::path::PathBuf);
        impl Dir {
            fn path(&self) -> &std::path::Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = Dir(std::env::temp_dir().join(format!("ipc-annot-{}", std::process::id())));
        let _ = std::fs::remove_dir_all(dir.path());
        std::fs::create_dir_all(dir.path()).unwrap();
        let other = dir.path().join("other.md");
        std::fs::write(&other, "- [x] on disk\n").unwrap();
        let open = dir.path().join("open.md");
        std::fs::write(&open, "- [ ] stale\n").unwrap();
        let open_s = open.to_str().unwrap();
        let live = "- [ ] live task\n";

        // The open document: its live buffer, also via a non-canonical path.
        let via_dots = format!("{}/./open.md", dir.path().display());
        for p in [open_s, via_dots.as_str()] {
            let t = annotation_tasks(p, Some(open_s), live);
            assert_eq!(t.len(), 1);
            assert_eq!(t[0]["text"], "live task", "{p}");
        }
        assert!(same_path(&via_dots, open_s));

        // Another Markdown file: its own tasks from disk, not the open doc's.
        let t = annotation_tasks(other.to_str().unwrap(), Some(open_s), live);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0]["text"], "on disk");
        assert_eq!(t[0]["checked"], true);

        // Missing, non-Markdown, and dotfile paths: no tasks.
        let txt = dir.path().join("x.txt");
        std::fs::write(&txt, "- [ ] not md\n").unwrap();
        let dot = dir.path().join(".hidden.md");
        std::fs::write(&dot, "- [ ] hidden\n").unwrap();
        for p in [
            txt.as_path(),
            dot.as_path(),
            dir.path().join("nope.md").as_path(),
        ] {
            assert!(
                annotation_tasks(p.to_str().unwrap(), Some(open_s), live).is_empty(),
                "{p:?}"
            );
        }
    }

    // ── Session files shared with mdopener-mcp ───────────────────────────────

    use super::{read_session_file, write_session_file, SessionMessage};

    // ── Paths an agent may open, present or send for review ─────────────────

    use super::checked_agent_path;

    // ── Request bodies ───────────────────────────────────────────────────────

    use super::read_json_from;

    #[test]
    fn a_body_over_the_cap_is_too_large_not_invalid_json() {
        #[derive(serde::Deserialize, Debug)]
        struct B {
            #[allow(dead_code)]
            content: String,
        }
        let ok = br#"{"content":"hi"}"#;
        assert!(read_json_from::<B>(&ok[..], 64).is_ok());
        let big = format!(r#"{{"content":"{}"}}"#, "x".repeat(100));
        let (code, msg) = read_json_from::<B>(big.as_bytes(), 64).unwrap_err();
        assert_eq!(code, 413, "{msg}");
        let (code, _) = read_json_from::<B>(&b"{ nope"[..], 64).unwrap_err();
        assert_eq!(code, 400);
    }

    // ── Edit round-trips ─────────────────────────────────────────────────────

    use super::{names_open_document, EDIT_ROUNDTRIP_TIMEOUT};

    /// mdopener-mcp gives up reading an IPC reply after 5 s (`tcp_roundtrip`).
    /// A round-trip that waits as long answers after the client has gone, so
    /// the agent sees "IPC read error" instead of the app's own reason.
    #[test]
    fn edit_round_trips_answer_before_the_mcp_client_gives_up() {
        assert!(EDIT_ROUNDTRIP_TIMEOUT < std::time::Duration::from_secs(5));
    }

    #[test]
    fn a_named_path_is_compared_with_the_open_document_canonically() {
        let d = Scratch::new("names-open");
        let open = d.0.join("open.md");
        std::fs::write(&open, "x").unwrap();
        let open_s = open.to_str().unwrap();
        let via_dots = format!("{}/./open.md", d.0.display());
        let canon = std::fs::canonicalize(&open).unwrap();
        for want in [open_s, via_dots.as_str(), canon.to_str().unwrap()] {
            assert!(names_open_document(want, open_s), "{want}");
            assert!(names_open_document(open_s, &via_dots), "{want}");
        }
        let other = d.0.join("other.md");
        std::fs::write(&other, "y").unwrap();
        assert!(!names_open_document(other.to_str().unwrap(), open_s));
        assert!(!names_open_document(open_s, ""));
        // Unsaved buffers have no path to resolve; only an exact match counts.
        assert!(names_open_document("Untitled", "Untitled"));
    }

    #[test]
    fn agents_can_open_only_markdown_documents() {
        let d = Scratch::new("agent-paths");
        let md = d.0.join("notes.md");
        std::fs::write(&md, "# hi").unwrap();
        let canon = std::fs::canonicalize(&md).unwrap();
        assert_eq!(
            checked_agent_path(md.to_str().unwrap()).unwrap(),
            canon.to_str().unwrap()
        );
        let upper = d.0.join("README.MD");
        std::fs::write(&upper, "x").unwrap();
        assert!(checked_agent_path(upper.to_str().unwrap()).is_ok());

        let secret = d.0.join("id_rsa");
        std::fs::write(&secret, "PRIVATE KEY").unwrap();
        let env = d.0.join(".env.md");
        std::fs::write(&env, "TOKEN=1").unwrap();
        let dir_md = d.0.join("folder.md");
        std::fs::create_dir_all(&dir_md).unwrap();
        let mut refused = vec![secret.clone(), env, dir_md, d.0.join("x.txt")];
        #[cfg(unix)]
        {
            // A Markdown-named link to a secret is judged by its target.
            let link = d.0.join("innocent.md");
            std::os::unix::fs::symlink(&secret, &link).unwrap();
            refused.push(link);
        }
        for p in refused {
            let err = checked_agent_path(p.to_str().unwrap()).unwrap_err();
            assert!(err.contains("Markdown"), "{p:?}: {err}");
        }

        // The window cannot open a file that is not there (it would report
        // the open as done and show nothing).
        let missing = d.0.join("missing.md");
        let err = checked_agent_path(missing.to_str().unwrap()).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }

    /// A scratch directory removed on drop (the app crate has no tempfile).
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = N.fetch_add(1, Ordering::Relaxed);
            let p =
                std::env::temp_dir().join(format!("ipc-sessions-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn msg(id: &str, session: &str, ts: u64) -> SessionMessage {
        SessionMessage {
            id: id.into(),
            session_id: session.into(),
            role: "agent".into(),
            content: format!("{id} content"),
            cited_docs: vec![],
            timestamp_ms: ts,
        }
    }

    fn ids(msgs: &[SessionMessage]) -> Vec<&str> {
        msgs.iter().map(|m| m.id.as_str()).collect()
    }

    /// What mdopener-mcp writes for one message (its `SessionLog`).
    fn mcp_file(messages: &[SessionMessage]) -> String {
        serde_json::to_string_pretty(&serde_json::json!({ "messages": messages })).unwrap()
    }

    #[test]
    fn session_ids_that_used_to_collide_get_their_own_files() {
        let d = Scratch::new("collide");
        write_session_file(&d.0, "a.b", &[msg("m1", "a.b", 1)]).unwrap();
        write_session_file(&d.0, "a_b", &[msg("m2", "a_b", 2)]).unwrap();
        assert_eq!(ids(&read_session_file(&d.0, "a.b").unwrap()), ["m1"]);
        assert_eq!(ids(&read_session_file(&d.0, "a_b").unwrap()), ["m2"]);
        // The same names mdopener-mcp uses (`session_file_path`).
        assert!(d.0.join("a%2Eb.json").is_file());
        assert!(d.0.join("a_b.json").is_file());
    }

    #[test]
    fn reads_the_session_file_mdopener_mcp_wrote() {
        let d = Scratch::new("read-mcp");
        std::fs::write(d.0.join("a%2Eb.json"), mcp_file(&[msg("m1", "a.b", 1)])).unwrap();
        assert_eq!(ids(&read_session_file(&d.0, "a.b").unwrap()), ["m1"]);
    }

    #[test]
    fn writes_the_format_mdopener_mcp_reads() {
        let d = Scratch::new("write-mcp");
        write_session_file(&d.0, "s1", &[msg("m1", "s1", 1)]).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(d.0.join("s1.json")).unwrap()).unwrap();
        assert_eq!(v["messages"][0]["id"], "m1");
        assert_eq!(v["messages"][0]["sessionId"], "s1");
    }

    #[test]
    fn persisting_keeps_messages_the_mcp_server_appended() {
        let d = Scratch::new("merge");
        // The agent saved m1 through mdopener-mcp; the window only knows m2.
        std::fs::write(d.0.join("s1.json"), mcp_file(&[msg("m1", "s1", 1)])).unwrap();
        let written = write_session_file(&d.0, "s1", &[msg("m2", "s1", 2)]).unwrap();
        assert_eq!(ids(&written), ["m1", "m2"]);
        assert_eq!(ids(&read_session_file(&d.0, "s1").unwrap()), ["m1", "m2"]);
        // Re-persisting the same messages adds no duplicates.
        let again = write_session_file(&d.0, "s1", &[msg("m1", "s1", 1), msg("m2", "s1", 2)]);
        assert_eq!(ids(&again.unwrap()), ["m1", "m2"]);
    }

    #[test]
    fn history_under_the_legacy_name_is_read_without_other_ids() {
        let d = Scratch::new("legacy");
        // Earlier builds (app: a bare array) wrote both ids to `a_b.json`.
        let legacy = serde_json::to_string(&[msg("m1", "a.b", 1), msg("m2", "a_b", 2)]).unwrap();
        std::fs::write(d.0.join("a_b.json"), legacy).unwrap();
        assert_eq!(ids(&read_session_file(&d.0, "a.b").unwrap()), ["m1"]);
        assert_eq!(ids(&read_session_file(&d.0, "a_b").unwrap()), ["m2"]);
        // The next write moves `a.b` to its own file; the legacy file stays.
        write_session_file(&d.0, "a.b", &[msg("m3", "a.b", 3)]).unwrap();
        assert_eq!(ids(&read_session_file(&d.0, "a.b").unwrap()), ["m1", "m3"]);
        assert_eq!(ids(&read_session_file(&d.0, "a_b").unwrap()), ["m2"]);
    }

    #[test]
    fn a_file_shared_with_another_id_or_unreadable_is_not_overwritten() {
        let d = Scratch::new("refuse");
        // A case-insensitive file system folds `Plan` and `plan` together.
        let shared = mcp_file(&[msg("m1", "plan", 1)]);
        std::fs::write(d.0.join("Plan.json"), &shared).unwrap();
        assert!(read_session_file(&d.0, "Plan").unwrap().is_empty());
        assert!(write_session_file(&d.0, "Plan", &[msg("m2", "Plan", 2)]).is_err());
        assert_eq!(
            std::fs::read_to_string(d.0.join("Plan.json")).unwrap(),
            shared
        );

        std::fs::write(d.0.join("s1.json"), "{ torn").unwrap();
        assert!(write_session_file(&d.0, "s1", &[msg("m2", "s1", 2)]).is_err());
        assert_eq!(
            std::fs::read_to_string(d.0.join("s1.json")).unwrap(),
            "{ torn"
        );
    }
}
