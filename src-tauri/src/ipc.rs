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
//! | POST   | /content   | `{"content":"…","save":true|false}`   | Replace doc content (round-trip)   |
//! | POST   | /open      | `{"path":"…","mode":"read|edit"}`     | Open a file (round-trip)           |
//! | GET    | /recent    | `?limit=N` (default 10)               | Recent-file list                   |
//! | POST   | /export    | `{"format":"pdf|docx|html","outputPath":"…|null"}` | Trigger export |
//! | GET    | /vault     | —                                     | Watched-folder files + recents     |
//! | GET    | /search    | `?q=…&limit=N`                        | Full-text search across the vault  |
//! | POST   | /edit      | `{"find":"…","replace":"…","save":bool}` | Exact find/replace on LIVE doc (round-trip) |
//! | POST   | /present   | `{"path":"…|null"}`                   | Open + distraction-free reading (round-trip) |
//!
//! Auth: every endpoint except `/health` requires `Authorization: Bearer <token>`
//! (the per-session token in `~/.mdopener/ipc-token`).
//!
//! Content is kept in [`DocMirror`], a managed Tauri state struct that the
//! frontend syncs via `mcp_sync_state` on every document change (debounced
//! 200 ms). Mutations emit a Tauri event the frontend picks up and applies;
//! `/content`, `/open` and `/present` wait for the window's outcome like `/edit`.
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
    /// The review panel's window: the human has this long to decide.
    pub timeout_ms: u64,
}

/// How long a review is kept after its window closes, so an agent that got
/// `pending` back can still resume it by `review_id` and read the verdict.
const REVIEW_RETENTION_MS: u64 = 30 * 60 * 1000;

/// Most reviews kept at once, however recent.
const MAX_REVIEWS: usize = 256;

/// Bound [`ReviewState`]: drop reviews more than [`REVIEW_RETENTION_MS`] past
/// their window, except the newest review of each file (the verdict
/// `get_user_annotations` reports), then cap the count at [`MAX_REVIEWS`],
/// dropping the oldest decided or expired reviews before any open one.
fn prune_reviews(map: &mut HashMap<String, ReviewRecord>, now: u64) {
    let window_end = |r: &ReviewRecord| r.created_at.saturating_add(r.timeout_ms);
    let mut newest_per_path: HashMap<String, (u64, String)> = HashMap::new();
    for (id, r) in map.iter() {
        if let Some(p) = &r.path {
            let e = newest_per_path
                .entry(p.clone())
                .or_insert((r.created_at, id.clone()));
            if r.created_at > e.0 {
                *e = (r.created_at, id.clone());
            }
        }
    }
    map.retain(|id, r| {
        now < window_end(r).saturating_add(REVIEW_RETENTION_MS)
            || r.path.as_ref().is_some_and(|p| {
                newest_per_path
                    .get(p)
                    .is_some_and(|(_, newest)| newest == id)
            })
    });
    if map.len() <= MAX_REVIEWS {
        return;
    }
    // Open reviews (pending, window not closed) sort last, then oldest first.
    let mut order: Vec<(bool, u64, String)> = map
        .iter()
        .map(|(id, r)| {
            (
                r.status == "pending" && now < window_end(r),
                r.created_at,
                id.clone(),
            )
        })
        .collect();
    order.sort();
    let excess = map.len() - MAX_REVIEWS;
    for (_, _, id) in order.into_iter().take(excess) {
        map.remove(&id);
    }
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

/// The verdicts the review panel may record. `timeout` is the panel's own
/// countdown running out with no decision; `dismissed` is the human closing it.
const REVIEW_VERDICTS: &[&str] = &["approved", "changes_requested", "dismissed", "timeout"];

/// Called by the frontend review panel when the human clicks Approve / Request-
/// changes / Dismiss, or when its countdown runs out. Records the verdict so
/// the polling MCP binary returns it to the agent.
#[tauri::command]
pub fn set_review_verdict(
    review_id: String,
    verdict: String,
    comments: Option<String>,
    state: tauri::State<ReviewState>,
) -> Result<(), String> {
    if !REVIEW_VERDICTS.contains(&verdict.as_str()) {
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
/// document, or an `mcp://set-content`. Forwards the outcome to the IPC worker
/// thread parked in `handle_edit` or [`window_round_trip`] (`/content`, `/open`,
/// `/present`). Removing the sender from [`PendingEdits`] here means a stray or
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
                let limit = match limit_param(query, 10) {
                    Ok(l) => l,
                    Err(e) => return send_error(req, 400, &e),
                };

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

/// POST /content — replace the open document (and save it when asked).
///
/// A round-trip like `/edit`: the window applies the content and reports back
/// through `mcp_edit_result` (the same [`PendingEdits`] map, so the same
/// [`MAX_INFLIGHT_EDITS`] cap and [`EDIT_ROUNDTRIP_TIMEOUT`]), and the reply
/// says whether the content was applied and, with `save`, written to disk.
fn handle_set_content(mut req: Request, app: &AppHandle) {
    #[derive(Deserialize)]
    struct Body {
        content: String,
        #[serde(default)]
        save: bool,
    }

    let b = match read_json_body::<Body>(&mut req) {
        Ok(b) => b,
        Err((code, e)) => return send_error(req, code, &e),
    };
    let payload = serde_json::json!({ "content": b.content, "save": b.save });
    let reply = match window_round_trip(app, "content", "mcp://set-content", payload) {
        Some(outcome) => set_content_reply(outcome),
        None => editor_busy(),
    };
    send_json(req, reply);
}

/// Ask the window to act on `event` and park this worker until it reports
/// back through `mcp_edit_result`, keyed by the `editId` added to `payload`,
/// or until [`EDIT_ROUNDTRIP_TIMEOUT`]. `None` when [`MAX_INFLIGHT_EDITS`]
/// round-trips are already parked, so the caller answers [`editor_busy`].
fn window_round_trip(
    app: &AppHandle,
    prefix: &str,
    event: &str,
    mut payload: serde_json::Value,
) -> Option<Result<EditOutcome, mpsc::RecvTimeoutError>> {
    let _inflight = InflightEdit::acquire()?;
    let edit_id = format!("{prefix}_{}", EDIT_SEQ.fetch_add(1, Ordering::Relaxed));
    payload["editId"] = serde_json::Value::String(edit_id.clone());
    let (tx, rx) = mpsc::channel::<EditOutcome>();
    let pending = app.state::<PendingEdits>();
    pending.0.lock().unwrap().insert(edit_id.clone(), tx);
    if let Err(e) = app.emit(event, payload) {
        pending.0.lock().unwrap().remove(&edit_id);
        return Some(Ok(EditOutcome {
            ok: false,
            replaced: 0,
            error: Some(window_unreachable_msg(&e)),
        }));
    }
    let outcome = rx.recv_timeout(EDIT_ROUNDTRIP_TIMEOUT);
    if outcome.is_err() {
        pending.0.lock().unwrap().remove(&edit_id);
    }
    Some(outcome)
}

/// The `/content` reply for what the window reported (or did not report).
fn set_content_reply(outcome: Result<EditOutcome, mpsc::RecvTimeoutError>) -> serde_json::Value {
    match outcome {
        Ok(o) if o.ok => serde_json::json!({ "ok": true }),
        Ok(o) => serde_json::json!({
            "ok": false,
            "error": o.error.unwrap_or_else(|| "The app could not replace the document content.".into()),
        }),
        Err(_) => serde_json::json!({
            "ok": false,
            "error": "Timed out waiting for the app to replace the document content — is the window responsive?",
        }),
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
            if let Some(e) = open_mode_refusal(b.mode.as_deref()) {
                return send_error(req, 400, &e);
            }
            let abs = match checked_agent_path(&b.path) {
                Ok(abs) => abs,
                Err(e) => return send_error(req, 400, &e),
            };

            let payload = serde_json::json!({ "path": abs, "mode": b.mode });
            let reply = match window_round_trip(app, "open", "mcp://open", payload) {
                Some(outcome) => window_open_reply(outcome, &abs, "open"),
                None => window_busy("open", &abs),
            };
            send_json(req, reply);
        }
        Err((code, e)) => send_error(req, code, &e),
    }
}

/// Why `/open` refuses `mode`, if it does. The window switches only to
/// `read` or `edit` and ignores anything else, so a misspelt mode would be
/// answered `ok` with the document left in whatever view it was.
fn open_mode_refusal(mode: Option<&str>) -> Option<String> {
    match mode {
        None | Some("read" | "edit") => None,
        Some(other) => Some(format!(
            "Unknown mode '{other}': use \"read\" or \"edit\", or omit it to keep the current view."
        )),
    }
}

/// The `/open` or `/present` reply for what the window reported (or did not
/// report) after it was asked to `doing` the document at `path`.
fn window_open_reply(
    outcome: Result<EditOutcome, mpsc::RecvTimeoutError>,
    path: &str,
    doing: &str,
) -> serde_json::Value {
    match outcome {
        Ok(o) if o.ok => serde_json::json!({ "ok": true, "path": path }),
        Ok(o) => serde_json::json!({
            "ok": false,
            "path": path,
            "error": o
                .error
                .unwrap_or_else(|| format!("The app could not {doing} {path}.")),
        }),
        Err(_) => serde_json::json!({
            "ok": false,
            "path": path,
            "error": format!(
                "Timed out waiting for the app to {doing} {path} — is the window responsive?"
            ),
        }),
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
            let open = app.state::<DocMirror>().0.lock().unwrap().path.clone();
            if let Some(e) = export_refusal(&b.format, open.as_deref()) {
                return send_error(req, 400, &e);
            }
            let emitted = app.emit("mcp://export", serde_json::json!({
                "format": b.format,
                "outputPath": b.output_path,
            }));
            send_json(req, emitted_reply(emitted, serde_json::json!({"ok": true})));
        }
        Err((code, e)) => send_error(req, code, &e),
    }
}

/// Why `/export` cannot run, if it cannot. The window exports only the open
/// document (with none it toasts and does nothing) and treats a format it
/// does not know as html, so both are refused here rather than answered `ok`.
fn export_refusal(format: &str, open: Option<&str>) -> Option<String> {
    if !["pdf", "docx", "html", "epub"].contains(&format) {
        return Some(format!(
            "Unknown export format '{format}': use pdf, docx, html or epub."
        ));
    }
    open.is_none()
        .then(|| "No document is open; open one before exporting.".to_string())
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
        let now = now_ms();
        prune_reviews(&mut map, now);
        map.insert(
            body.review_id.clone(),
            ReviewRecord {
                status: "pending".into(),
                verdict: None,
                comments: None,
                path: abs_path.clone(),
                created_at: now,
                timeout_ms,
            },
        );
    }

    // If a file was given, open it the way `/open` does and wait for the
    // window's answer, so a file it cannot open reaches the agent with the
    // reason instead of a review panel for a document that never loaded.
    if let Some(ref p) = abs_path {
        let payload = serde_json::json!({ "path": p, "mode": "read" });
        let outcome = window_round_trip(app, "review_open", "mcp://open", payload);
        if let Some(refusal) = review_open_refusal(outcome, p) {
            let state = app.state::<ReviewState>();
            state.0.lock().unwrap().remove(&body.review_id);
            return send_json(req, refusal);
        }
    }
    // Tell the frontend a review is pending so it shows the review panel.
    // When the window cannot be told, no panel will ever show, so the review
    // is dropped and refused rather than left for the agent to wait on.
    let emitted = app.emit(
        "mcp://review",
        serde_json::json!({
            "reviewId": body.review_id,
            "path": abs_path,
            "content": body.content,
            "timeoutMs": timeout_ms,
        }),
    );
    let reply = emitted_reply(
        emitted,
        serde_json::json!({ "ok": true, "reviewId": body.review_id }),
    );
    if reply["ok"] != true {
        app.state::<ReviewState>()
            .0
            .lock()
            .unwrap()
            .remove(&body.review_id);
    }
    send_json(req, reply);
}

/// The `/review` reply when the window did not open the document under
/// review (`None` once it did): the window's own reason, a timeout, or that
/// the app is busy with other round-trips.
fn review_open_refusal(
    outcome: Option<Result<EditOutcome, mpsc::RecvTimeoutError>>,
    path: &str,
) -> Option<serde_json::Value> {
    let reply = match outcome {
        Some(outcome) => window_open_reply(outcome, path, "open"),
        None => window_busy("open", path),
    };
    (reply["ok"] != true).then_some(reply)
}

/// The percent-decoded value of `key` in a query string, or `None` when it is
/// absent or does not decode to UTF-8.
fn query_param(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix(key)?.strip_prefix('='))
        .and_then(|v| urlencoding::decode(v).ok())
        .map(|v| v.into_owned())
}

/// The `limit` query param, or `default` when it is absent. A value that is
/// not a whole number is refused rather than read as the default, so a
/// caller's `limit=ten` does not quietly get a different count.
fn limit_param(query: &str, default: usize) -> Result<usize, String> {
    match query_param(query, "limit") {
        None => Ok(default),
        Some(v) => v.parse().map_err(|_| {
            format!(
                "limit must be a whole number, got '{v}'; omit it for the default of {default}."
            )
        }),
    }
}

/// The status `/review/result` reports: the recorded one, except that a review
/// still pending once its window has closed is `timeout`. The panel only
/// expires the review it is showing, so one a newer review displaced would
/// otherwise stay `pending` and a resuming agent would wait on it forever.
fn review_status(r: &ReviewRecord, now: u64) -> &str {
    if r.status == "pending" && now >= r.created_at.saturating_add(r.timeout_ms) {
        "timeout"
    } else {
        &r.status
    }
}

fn handle_review_result(req: Request, query: &str, app: &AppHandle) {
    let id = query_param(query, "id").unwrap_or_default();
    let id = id.as_str();
    if id.is_empty() {
        return send_error(req, 400, "id query param required");
    }
    // Clone the record out before responding so the mutex isn't held across the
    // blocking socket write in send_json (which would stall set_review_verdict
    // and every other ReviewState reader against a slow client).
    let record = {
        let state = app.state::<ReviewState>();
        let map = state.0.lock().unwrap();
        let now = now_ms();
        map.get(id).map(|r| {
            (
                review_status(r, now).to_string(),
                r.verdict.clone(),
                r.comments.clone(),
            )
        })
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

/// The `path` `/annotations` reports on. Without one there is no file to
/// read tasks from or match reviews against, and the reply used to be an
/// empty result for the path "", which reads as "no tasks, no verdict".
fn annotations_path(query: &str) -> Result<String, String> {
    query_param(query, "path")
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            "path query param required: /annotations?path=<percent-encoded path of the document>"
                .to_string()
        })
}

fn handle_annotations(req: Request, query: &str, app: &AppHandle) {
    let raw_path = match annotations_path(query) {
        Ok(p) => p,
        Err(e) => return send_error(req, 400, &e),
    };

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
    let limit = match limit_param(query, 50) {
        Ok(l) => l.clamp(1, 200),
        Err(e) => return send_error(req, 400, &e),
    };

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

/// Why a request did not reach the window: the app's event could not be
/// delivered, so nothing will act on it or report back.
fn window_unreachable_msg(e: &dyn std::fmt::Display) -> String {
    format!("The app could not reach its window: {e}")
}

/// The `{ "ok": false }` reply for an event that could not be delivered, or
/// `None` once it was. The window never hears of an undelivered request, so
/// answering `ok` (or waiting out the round-trip timeout and guessing why)
/// would tell the agent something that is not happening.
fn emit_failure<E: std::fmt::Display>(emitted: Result<(), E>) -> Option<serde_json::Value> {
    emitted
        .err()
        .map(|e| serde_json::json!({ "ok": false, "error": window_unreachable_msg(&e) }))
}

/// `ok` when the event was delivered, else the [`emit_failure`] reply.
fn emitted_reply<E: std::fmt::Display>(
    emitted: Result<(), E>,
    ok: serde_json::Value,
) -> serde_json::Value {
    emit_failure(emitted).unwrap_or(ok)
}

/// The `/open`, `/present` or `/review` reply when [`MAX_INFLIGHT_EDITS`]
/// round-trips are already parked: worded for what was refused (`doing` the
/// document at `path`), not as an edit.
fn window_busy(doing: &str, path: &str) -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "path": path,
        "error": format!(
            "The app is busy finishing other agent requests, so it did not {doing} \
             {path} — retry in a moment."
        ),
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
    let emitted = app.emit("mcp://edit", serde_json::json!({
        "editId": edit_id,
        "find": body.find,
        "replace": body.replace,
        "save": body.save,
    }));
    // Nothing will report back when the window was never told: say so now
    // instead of timing out with a guess.
    if let Some(reply) = emit_failure(emitted) {
        app.state::<PendingEdits>()
            .0
            .lock()
            .unwrap()
            .remove(&edit_id);
        return send_json(req, reply);
    }

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

    let emitted = app.emit(
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
    if let Some(reply) = emit_failure(emitted) {
        app.state::<PendingStreamEdits>()
            .0
            .lock()
            .unwrap()
            .remove(&edit_id);
        return send_json(req, reply);
    }

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

    let emitted = app.emit(
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
    if let Some(reply) = emit_failure(emitted) {
        app.state::<PendingStreamEditsApply>()
            .0
            .lock()
            .unwrap()
            .remove(&apply_id);
        return send_json(req, reply);
    }

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
/// distraction-free reading presentation. A round-trip like `/open`: emits
/// `mcp://present` and answers with what the window reported.
fn handle_present(mut req: Request, app: &AppHandle) {
    #[derive(Deserialize)]
    struct Body {
        path: Option<String>,
    }
    let body = match read_json_body::<Body>(&mut req) {
        Ok(b) => b,
        Err((code, e)) => return send_error(req, code, &e),
    };
    let open = app.state::<DocMirror>().0.lock().unwrap().path.clone();
    let path = match present_target(body.path.as_deref(), open.as_deref()) {
        Ok(p) => p,
        Err(e) => return send_error(req, 400, &e),
    };
    // The frontend opens `path` only when one was asked for, else presents
    // the open document.
    let requested = body.path.is_some().then_some(&path);
    let payload = serde_json::json!({ "path": requested });
    let reply = match window_round_trip(app, "present", "mcp://present", payload) {
        Some(outcome) => window_open_reply(outcome, &path, "present"),
        None => window_busy("present", &path),
    };
    send_json(req, reply);
}

/// The document `/present` shows: the requested one (checked like `/open`),
/// else the open document. With neither, the window has nothing to present
/// and would ignore the request, so it is an error.
fn present_target(requested: Option<&str>, open: Option<&str>) -> Result<String, String> {
    match (requested, open) {
        (Some(p), _) => checked_agent_path(p),
        (None, Some(o)) => Ok(o.to_string()),
        (None, None) => Err("No document is open; pass `path` to present a document.".to_string()),
    }
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

    use super::export_refusal;

    #[test]
    fn export_needs_an_open_document_and_a_known_format() {
        assert_eq!(export_refusal("html", Some("/notes/a.md")), None);
        assert_eq!(export_refusal("pdf", Some("/notes/a.md")), None);
        // The window would only toast "Open a document" and export nothing.
        let err = export_refusal("docx", None).unwrap();
        assert!(err.contains("No document is open"), "{err}");
        // The frontend treats anything it does not know as html.
        let err = export_refusal("rtf", Some("/notes/a.md")).unwrap();
        assert!(err.contains("rtf"), "{err}");
    }

    use super::present_target;

    #[test]
    fn present_without_a_path_needs_an_open_document() {
        let d = Scratch::new("present");
        let md = d.0.join("talk.md");
        std::fs::write(&md, "# Talk").unwrap();
        let md_s = md.to_str().unwrap();
        let canon = std::fs::canonicalize(&md).unwrap();
        assert_eq!(
            present_target(Some(md_s), None).unwrap(),
            canon.to_str().unwrap()
        );
        assert_eq!(
            present_target(None, Some("/open/doc.md")).unwrap(),
            "/open/doc.md"
        );
        // Nothing to present: the window would do nothing, so say so.
        let err = present_target(None, None).unwrap_err();
        assert!(err.contains("No document is open"), "{err}");
    }

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

    /// `/content` answers with what the window did: ok once it replaced the
    /// document (and saved it when asked), else the window's reason, and a
    /// window that never answers is a failure rather than a silent success.
    #[test]
    fn set_content_reports_what_the_window_did() {
        use super::{set_content_reply, EditOutcome};
        use std::sync::mpsc::RecvTimeoutError;
        let ok = EditOutcome {
            ok: true,
            replaced: 1,
            error: None,
        };
        assert_eq!(set_content_reply(Ok(ok)), serde_json::json!({ "ok": true }));

        let refused = EditOutcome {
            ok: false,
            replaced: 0,
            error: Some("Content replaced in the open document but not saved: denied".into()),
        };
        let v = set_content_reply(Ok(refused));
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("not saved"));

        let v = set_content_reply(Ok(EditOutcome {
            ok: false,
            replaced: 0,
            error: None,
        }));
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().is_some_and(|e| !e.is_empty()));

        for gone in [RecvTimeoutError::Timeout, RecvTimeoutError::Disconnected] {
            let v = set_content_reply(Err(gone));
            assert_eq!(v["ok"], false);
            assert!(v["error"].as_str().unwrap().contains("Timed out"));
        }
    }

    /// `/open` and `/present` answer with what the window did, so an open
    /// that failed in the window reaches the agent with its reason.
    #[test]
    fn open_and_present_report_what_the_window_did() {
        use super::{window_open_reply, EditOutcome};
        use std::sync::mpsc::RecvTimeoutError;
        let ok = EditOutcome {
            ok: true,
            replaced: 1,
            error: None,
        };
        assert_eq!(
            window_open_reply(Ok(ok), "/d/a.md", "open"),
            serde_json::json!({ "ok": true, "path": "/d/a.md" })
        );

        let failed = EditOutcome {
            ok: false,
            replaced: 0,
            error: Some("Could not read /d/a.md: Permission denied".into()),
        };
        let v = window_open_reply(Ok(failed), "/d/a.md", "open");
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "Could not read /d/a.md: Permission denied");

        let silent = EditOutcome {
            ok: false,
            replaced: 0,
            error: None,
        };
        let v = window_open_reply(Ok(silent), "/d/a.md", "present");
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("could not present"));

        for gone in [RecvTimeoutError::Timeout, RecvTimeoutError::Disconnected] {
            let v = window_open_reply(Err(gone), "/d/a.md", "open");
            assert_eq!(v["ok"], false);
            assert!(v["error"].as_str().unwrap().contains("Timed out"));
        }
    }

    /// `/review` with a path opens it like `/open` and refuses the review,
    /// with the window's reason, when the document did not open.
    #[test]
    fn review_reports_a_document_the_window_could_not_open() {
        use super::{review_open_refusal, EditOutcome};
        use std::sync::mpsc::RecvTimeoutError;
        let opened = EditOutcome {
            ok: true,
            replaced: 1,
            error: None,
        };
        assert_eq!(review_open_refusal(Some(Ok(opened)), "/d/a.md"), None);

        let failed = EditOutcome {
            ok: false,
            replaced: 0,
            error: Some("Could not read /d/a.md: Permission denied".into()),
        };
        let v = review_open_refusal(Some(Ok(failed)), "/d/a.md").unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "Could not read /d/a.md: Permission denied");

        let v = review_open_refusal(Some(Err(RecvTimeoutError::Timeout)), "/d/a.md").unwrap();
        assert!(v["error"].as_str().unwrap().contains("Timed out"));

        let v = review_open_refusal(None, "/d/a.md").unwrap();
        assert_eq!(v["ok"], false);
        let e = v["error"].as_str().unwrap();
        assert!(e.contains("did not open /d/a.md"), "{e}");
    }

    /// At the in-flight cap, `/open` and `/present` say what they did not
    /// do, rather than that the editor is busy applying an edit.
    #[test]
    fn a_limit_that_is_not_a_number_is_refused() {
        use super::limit_param;
        assert_eq!(limit_param("", 10), Ok(10));
        assert_eq!(limit_param("q=x", 50), Ok(50));
        assert_eq!(limit_param("q=x&limit=7", 50), Ok(7));
        for bad in ["limit=ten", "limit=", "limit=-1", "limit=2.5"] {
            let err = limit_param(bad, 10).unwrap_err();
            assert!(err.contains("limit must be a whole number"), "{bad}: {err}");
        }
    }

    #[test]
    fn annotations_need_a_path() {
        use super::annotations_path;
        assert_eq!(
            annotations_path("path=%2Fnotes%2Fa%20b.md").unwrap(),
            "/notes/a b.md"
        );
        assert_eq!(annotations_path("x=1&path=/a.md").unwrap(), "/a.md");
        for query in ["", "path=", "x=1", "path=%FF"] {
            let err = annotations_path(query).unwrap_err();
            assert!(err.contains("path query param required"), "{query}: {err}");
        }
    }

    #[test]
    fn open_refuses_a_mode_the_window_ignores() {
        use super::open_mode_refusal;
        assert_eq!(open_mode_refusal(None), None);
        assert_eq!(open_mode_refusal(Some("read")), None);
        assert_eq!(open_mode_refusal(Some("edit")), None);
        let err = open_mode_refusal(Some("Edit")).unwrap();
        assert!(
            err.contains("'Edit'") && err.contains("\"read\" or \"edit\""),
            "{err}"
        );
        assert!(open_mode_refusal(Some("")).is_some());
    }

    #[test]
    fn an_undelivered_window_event_is_refused_not_answered_ok() {
        use super::{emit_failure, emitted_reply};
        let ok = serde_json::json!({ "ok": true, "reviewId": "r1" });
        assert_eq!(emitted_reply(Ok::<(), String>(()), ok.clone()), ok);
        let v = emitted_reply(Err("window closed"), ok);
        assert_eq!(v["ok"], false);
        assert_eq!(
            v["error"],
            "The app could not reach its window: window closed"
        );
        assert_eq!(emit_failure(Ok::<(), String>(())), None);
        assert!(emit_failure(Err("gone")).is_some());
    }

    #[test]
    fn a_busy_open_or_present_names_what_was_refused() {
        use super::window_busy;
        for doing in ["open", "present"] {
            let v = window_busy(doing, "/d/a.md");
            assert_eq!(v["ok"], false);
            let e = v["error"].as_str().unwrap();
            assert!(e.contains(&format!("did not {doing} /d/a.md")), "{e}");
            assert!(!e.contains("edit"), "{e}");
        }
    }

    // ── Review retention ─────────────────────────────────────────────────────

    use super::{prune_reviews, ReviewRecord, MAX_REVIEWS, REVIEW_RETENTION_MS};
    use std::collections::HashMap;

    fn review(status: &str, path: Option<&str>, created_at: u64, timeout_ms: u64) -> ReviewRecord {
        ReviewRecord {
            status: status.into(),
            verdict: (status != "pending").then(|| status.to_string()),
            comments: None,
            path: path.map(str::to_string),
            created_at,
            timeout_ms,
        }
    }

    #[test]
    fn the_panel_can_record_a_timeout_verdict() {
        // The countdown running out is not the human dismissing the review.
        assert!(super::REVIEW_VERDICTS.contains(&"timeout"));
        assert!(super::REVIEW_VERDICTS.contains(&"dismissed"));
        // A recorded timeout reads back as timeout, which the MCP tool reports.
        let r = review("timeout", None, 1_000, 5_000);
        assert_eq!(super::review_status(&r, 2_000), "timeout");
    }

    #[test]
    fn a_pending_review_past_its_window_reads_as_timeout() {
        use super::review_status;
        let t0 = 1_000_000;
        let r = review("pending", Some("/a.md"), t0, 5_000);
        assert_eq!(review_status(&r, t0 + 4_999), "pending");
        // Nobody decided before the window closed (e.g. a newer review took
        // the panel): an agent resuming it must not be told to keep waiting.
        assert_eq!(review_status(&r, t0 + 5_000), "timeout");
        let decided = review("approved", Some("/a.md"), t0, 5_000);
        assert_eq!(review_status(&decided, t0 + 60_000), "approved");
    }

    #[test]
    fn reviews_are_kept_while_an_agent_can_still_resume_them() {
        let mut map = HashMap::new();
        let t0 = 1_000_000;
        // Pending, its 10 min window still open.
        map.insert("open".to_string(), review("pending", None, t0, 600_000));
        // Decided, its window closed but within the retention period.
        map.insert("recent".to_string(), review("approved", None, t0, 5_000));
        prune_reviews(&mut map, t0 + 600_000 - 1);
        assert!(map.contains_key("open"));
        assert!(map.contains_key("recent"));
    }

    #[test]
    fn reviews_past_their_retention_are_dropped() {
        let mut map = HashMap::new();
        let t0 = 1_000_000;
        map.insert("old".to_string(), review("approved", None, t0, 5_000));
        map.insert("stale".to_string(), review("pending", None, t0, 5_000));
        map.insert(
            "fresh".to_string(),
            review("pending", None, t0 + 3_600_000, 300_000),
        );
        prune_reviews(&mut map, t0 + 5_000 + REVIEW_RETENTION_MS);
        assert!(!map.contains_key("old"));
        assert!(!map.contains_key("stale"));
        assert!(map.contains_key("fresh"));
    }

    #[test]
    fn the_latest_review_of_a_file_outlives_retention_for_get_user_annotations() {
        let mut map = HashMap::new();
        let t0 = 1_000_000;
        map.insert(
            "a1".to_string(),
            review("changes_requested", Some("/a.md"), t0, 5_000),
        );
        map.insert(
            "a2".to_string(),
            review("approved", Some("/a.md"), t0 + 1, 5_000),
        );
        prune_reviews(&mut map, t0 + 10 * REVIEW_RETENTION_MS);
        assert!(!map.contains_key("a1"));
        assert!(map.contains_key("a2"));
    }

    #[test]
    fn the_review_count_is_capped_dropping_decided_reviews_first() {
        let mut map = HashMap::new();
        let t0 = 1_000_000;
        map.insert("pending".to_string(), review("pending", None, t0, 600_000));
        for i in 0..(MAX_REVIEWS as u64 + 10) {
            map.insert(
                format!("d{i}"),
                review("approved", Some(&format!("/f{i}.md")), t0 + 1 + i, 600_000),
            );
        }
        prune_reviews(&mut map, t0 + 2);
        assert!(map.len() <= MAX_REVIEWS);
        assert!(
            map.contains_key("pending"),
            "an open review is never the one dropped"
        );
        assert!(
            !map.contains_key("d0"),
            "the oldest decided review goes first"
        );
        assert!(map.contains_key(&format!("d{}", MAX_REVIEWS as u64 + 9)));
    }

    /// mdopener-mcp percent-encodes the review id it polls with, so a resumed
    /// `review_id` with a space or `&` must be decoded to find its review.
    #[test]
    fn query_params_are_percent_decoded() {
        use super::query_param;
        assert_eq!(query_param("id=rev_1", "id").as_deref(), Some("rev_1"));
        assert_eq!(
            query_param("x=1&id=my%20review%26co", "id").as_deref(),
            Some("my review&co")
        );
        assert_eq!(query_param("idx=1", "id"), None);
        assert_eq!(query_param("", "id"), None);
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
