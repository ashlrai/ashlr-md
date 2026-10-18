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
//! | GET    | /recent    | `?limit=N` (default 10, 1 to 200)     | Recent-file list                   |
//! | POST   | /export    | `{"format":"pdf|docx|html|epub","outputPath":"…|null"}` | Trigger export (`outputPath`: absolute, the format's extension, no dotfile, existing dir) |
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
//! `/content`, `/open`, `/present` and `/export` with an `outputPath` wait for
//! the window's outcome like `/edit`.
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
use std::sync::{Mutex, MutexGuard, PoisonError};
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

/// Lock a mutex, recovering it if a thread panicked while holding it. Every
/// value behind these locks (mirrors of the window's state, maps of pending
/// round-trips and reviews) is valid after any single insert or remove, so
/// one panicked request must not turn every later request touching the same
/// state into a panic too (a dropped connection, with no reason given).
trait LockRecover<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockRecover<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

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
    /// "pending" | "approved" | "changes_requested" | "dismissed" |
    /// "timeout" | "superseded" (a newer review took the panel first).
    pub status: String,
    pub verdict: Option<String>,
    pub comments: Option<String>,
    pub path: Option<String>,
    pub created_at: u64,
    /// The review panel's window: the human has this long to decide.
    pub timeout_ms: u64,
    /// The human's verdict was recorded after the window closed, when an
    /// agent may already have been told `timeout`.
    pub late: bool,
    /// The panel was told to show this review (`mcp://review` delivered).
    pub shown: bool,
    /// The review that replaced this one in the panel, when `superseded`.
    pub superseded_by: Option<String>,
}

/// Mark `superseded` every open review the panel was showing other than
/// `newest`, which the panel shows from now on, and mark `newest` shown. The
/// panel holds one review at a time, so a displaced review can never get a
/// verdict; resolving it now tells its agent at once instead of after its
/// window. A review still opening its file (not yet shown) is left alone:
/// when it is shown it supersedes `newest` in turn.
fn supersede_shown(map: &mut HashMap<String, ReviewRecord>, newest: &str, now: u64) {
    for (id, r) in map.iter_mut() {
        let open = r.status == "pending" && now < r.created_at.saturating_add(r.timeout_ms);
        if id != newest && r.shown && open {
            r.status = "superseded".into();
            r.verdict = Some("superseded".into());
            r.superseded_by = Some(newest.to_string());
        }
    }
    if let Some(r) = map.get_mut(newest) {
        r.shown = true;
    }
}

/// Held while `/review` tells the panel to show a review and records which
/// review that displaced, so two reviews shown at once cannot each mark the
/// other superseded.
static REVIEW_PANEL: Mutex<()> = Mutex::new(());

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
    /// The watched folder has more Markdown files than the frontend lists
    /// (its `limit` newest), so `files` is not all of them.
    pub truncated: bool,
    /// How many files the frontend lists at most (its `MAX_FILES`), sent with
    /// every sync so notices state the real number. `None` from an older
    /// frontend that does not send it.
    pub limit: Option<usize>,
    /// The folder was too large or too deep for the frontend's walk to read
    /// in full, so
    /// `files` are the newest of the files it reached, not the folder's newest.
    pub scan_cut: bool,
    /// Of those, a folder below the walk's depth limit was skipped (`scan_cut`
    /// is set too); `scan_cut` alone means the entry budget stopped it.
    pub depth_cut: bool,
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
    *mirror.0.lock_recover() = DocMirrorInner { path, content };
    *recent_mirror.0.lock_recover() = recents;
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
    let mut map = state.0.lock_recover();
    match map.get_mut(&review_id) {
        None => Err(format!("Review {review_id} not found")),
        Some(r) => {
            record_verdict(r, verdict, comments, now_ms());
            Ok(())
        }
    }
}

/// Record `verdict` on `r` at `now`. A `timeout` never replaces a decision
/// already recorded. A decision made once the window has closed (or after
/// `timeout` was recorded) is kept, since it is what the human decided, but
/// marked `late`: an agent may already have been told `timeout`, and on
/// re-reading must see why the outcome changed.
fn record_verdict(r: &mut ReviewRecord, verdict: String, comments: Option<String>, now: u64) {
    if verdict == "timeout" {
        if r.status == "pending" {
            r.status = verdict.clone();
            r.verdict = Some(verdict);
            r.comments = comments;
        }
        return;
    }
    r.late = matches!(r.status.as_str(), "timeout" | "superseded")
        || now >= r.created_at.saturating_add(r.timeout_ms);
    r.status = verdict.clone();
    r.verdict = Some(verdict);
    r.comments = comments;
}

/// Called by the frontend (debounced) when the watched folder or its file list
/// changes. Keeps [`VaultMirror`] fresh so the `/vault` and `/search` endpoints
/// can enumerate the user's notes without re-walking the disk per request.
#[tauri::command]
pub fn mcp_sync_vault(
    watched_dir: Option<String>,
    files: Vec<VaultFileEntry>,
    truncated: Option<bool>,
    limit: Option<usize>,
    scan_cut: Option<bool>,
    depth_cut: Option<bool>,
    vault: tauri::State<VaultMirror>,
) {
    *vault.0.lock_recover() = VaultInner {
        watched_dir,
        files,
        truncated: truncated.unwrap_or(false),
        limit,
        scan_cut: scan_cut.unwrap_or(false) || depth_cut.unwrap_or(false),
        depth_cut: depth_cut.unwrap_or(false),
    };
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
    let tx = pending.0.lock_recover().remove(&edit_id);
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
    let tx = pending.0.lock_recover().remove(&edit_id);
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
    let tx = pending.0.lock_recover().remove(&edit_id);
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

/// Largest session file the app reads: mdopener-mcp's `MAX_SESSION_FILE_BYTES`
/// (16 MiB). A session file was read whole however large it was (another
/// process, or a hand edit, can make it any size). Writes drop the oldest
/// messages to stay under it, so a file the app writes stays readable.
const MAX_SESSION_FILE_BYTES: u64 = 16 * 1024 * 1024;

fn parse_session_file(path: &std::path::Path) -> Result<Vec<SessionMessage>, String> {
    use std::io::Read as _;
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file());
    let Some(meta) = meta else {
        return Err(format!("{} is not a regular file", path.display()));
    };
    let too_large = |len: u64| {
        format!(
            "Session file {} is {:.1} MiB, more than the {} MiB a session file may be, so \
             it was not read; move it aside to start the session afresh.",
            path.display(),
            len as f64 / (1024.0 * 1024.0),
            MAX_SESSION_FILE_BYTES / (1024 * 1024)
        )
    };
    if meta.len() > MAX_SESSION_FILE_BYTES {
        return Err(too_large(meta.len()));
    }
    let mut text = String::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(MAX_SESSION_FILE_BYTES + 1).read_to_string(&mut text))
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    // It grew while it was read.
    if text.len() as u64 > MAX_SESSION_FILE_BYTES {
        return Err(too_large(text.len() as u64));
    }
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
    // Owner-only, as mdopener-mcp makes it (`create_private_dir`): session
    // files hold the agent's actions and the human's verdicts. The window
    // created the directory `0755` and its files `0644`, so persisting a
    // session from the app undid the server's `0700`/`0600`.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Cannot make the sessions dir private: {e}"))?;
    }
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
            merged.push(cited_once(m));
        }
    }
    merged.sort_by_key(|m| m.timestamp_ms);
    if merged.len() > MAX_SESSION_MESSAGES {
        let excess = merged.len() - MAX_SESSION_MESSAGES;
        merged.drain(..excess);
    }

    let json = fit_session_json(&mut merged)?;
    // Write a temp file and rename it over the target, so a reader never sees
    // a torn file.
    let target = dir.join(&name);
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    write_private_new(&tmp, json.as_bytes()).map_err(|e| format!("Write failed: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Rename failed: {e}")
    })?;
    Ok(merged)
}

/// `m` with each cited path once, in the order first given, as mdopener-mcp
/// saves a message: a path the window cited twice used to be written twice.
fn cited_once(m: &SessionMessage) -> SessionMessage {
    let mut seen = std::collections::HashSet::new();
    SessionMessage {
        cited_docs: m
            .cited_docs
            .iter()
            .filter(|d| seen.insert(d.as_str()))
            .cloned()
            .collect(),
        ..m.clone()
    }
}

/// Serialise `merged` as a session file, dropping its oldest messages until
/// it fits in [`MAX_SESSION_FILE_BYTES`] (as mdopener-mcp does), so the file
/// written is one [`parse_session_file`] will read back. An error when even
/// the newest message alone is too large.
fn fit_session_json(merged: &mut Vec<SessionMessage>) -> Result<String, String> {
    loop {
        let json = serde_json::to_string_pretty(&SessionFileOut { messages: merged })
            .map_err(|e| format!("JSON serialisation failed: {e}"))?;
        let len = json.len() as u64;
        if len <= MAX_SESSION_FILE_BYTES {
            return Ok(json);
        }
        if merged.len() <= 1 {
            return Err(format!(
                "The message is too large: the session file would be {:.1} MiB, more than \
                 the {} MiB a session file may be.",
                len as f64 / (1024.0 * 1024.0),
                MAX_SESSION_FILE_BYTES / (1024 * 1024)
            ));
        }
        // Drop about the share that is over, at least one, never the newest.
        let n = merged.len() as u64;
        let excess = len - MAX_SESSION_FILE_BYTES;
        let cut = (excess.saturating_mul(n).div_ceil(len) as usize).clamp(1, merged.len() - 1);
        merged.drain(..cut);
    }
}

/// Write `bytes` to `path`, readable by this user only (`0600` on Unix) from
/// the moment it is created, and report a failure (unlike [`write_private`]).
fn write_private_new(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(path)?.write_all(bytes)
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
            .insert(session_id, messages.iter().map(cited_once).collect());
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
                let inner = mirror.0.lock_recover().clone();
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
                    mirror.0.lock_recover().iter().take(limit).cloned().collect();
                send_json(req, serde_json::json!(recents));
            }

            (Method::Post, "/export") => handle_export(req, app),

            (method, path) => send_not_found(req, &method, path),
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
pub(crate) fn checked_agent_path(raw: &str) -> Result<String, String> {
    checked_agent_document(raw).map(|d| d.path)
}

/// [`checked_agent_path`], keeping the identity of the file checked so a read
/// ([`crate::doc_read::CheckedDocument::read_capped`]) takes that file and no
/// other: a final or intermediate component swapped for a link after the
/// check is not followed.
pub(crate) fn checked_agent_document(
    raw: &str,
) -> Result<crate::doc_read::CheckedDocument, String> {
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
    let meta = crate::doc_read::checked_metadata(p).ok();
    let not_a_file = meta.as_ref().is_some_and(|m| !m.is_file());
    if !markdown || hidden || not_a_file {
        return Err(format!(
            "Refusing to open '{abs}': agents can open only Markdown documents (.md, \
             .markdown, .mdown, .mkd, .mdx) that are not dotfiles."
        ));
    }
    let Some(meta) = meta else {
        return Err(format!("Cannot open '{abs}': the file does not exist."));
    };
    Ok(crate::doc_read::CheckedDocument {
        path: abs,
        identity: Some(crate::doc_read::FileIdentity::of(&meta)),
    })
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
    payload: serde_json::Value,
) -> Option<Result<EditOutcome, mpsc::RecvTimeoutError>> {
    window_round_trip_within(app, prefix, event, payload, EDIT_ROUNDTRIP_TIMEOUT, &EDIT_SLOTS)
}

/// [`window_round_trip`] waiting up to `timeout` for the window's answer, in
/// a slot of `slots`. `None` when that budget is full.
fn window_round_trip_within(
    app: &AppHandle,
    prefix: &str,
    event: &str,
    mut payload: serde_json::Value,
    timeout: Duration,
    slots: &'static SlotBudget,
) -> Option<Result<EditOutcome, mpsc::RecvTimeoutError>> {
    let _inflight = InflightEdit::acquire_in(slots)?;
    let edit_id = format!("{prefix}_{}", EDIT_SEQ.fetch_add(1, Ordering::Relaxed));
    payload["editId"] = serde_json::Value::String(edit_id.clone());
    let (tx, rx) = mpsc::channel::<EditOutcome>();
    let pending = app.state::<PendingEdits>();
    pending.0.lock_recover().insert(edit_id.clone(), tx);
    if let Err(e) = app.emit(event, payload) {
        pending.0.lock_recover().remove(&edit_id);
        return Some(Ok(EditOutcome {
            ok: false,
            replaced: 0,
            error: Some(window_unreachable_msg(&e)),
        }));
    }
    let outcome = rx.recv_timeout(timeout);
    if outcome.is_err() {
        pending.0.lock_recover().remove(&edit_id);
    }
    Some(outcome)
}

/// The error for a window round-trip that got no answer within
/// [`EDIT_ROUNDTRIP_TIMEOUT`], naming the next step. These used to end on a
/// question ("Is a document open?"), and none said that a change the window
/// had not confirmed may still land: retrying such an edit blindly can apply
/// it twice, so `may_apply` says to read the document first.
fn window_timed_out(doing: &str, may_apply: bool) -> String {
    let secs = EDIT_ROUNDTRIP_TIMEOUT.as_secs();
    let next = if may_apply {
        "The window may still apply it, so call get_current_content to see whether it did \
         before retrying."
    } else {
        "Retry once the Ashlr MD window is responding again."
    };
    format!(
        "Timed out waiting for the app to {doing}: the window did not answer within {secs} s. \
         {next}"
    )
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
            "error": window_timed_out("replace the document content", true),
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
            "error": window_timed_out(&format!("{doing} {path}"), false),
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
            let open = app.state::<DocMirror>().0.lock_recover().path.clone();
            if let Some(e) = export_refusal(&b.format, open.as_deref()) {
                return send_error(req, 400, &e);
            }
            // The window writes `outputPath` without asking, so the app holds
            // it to the same rule the MCP tool does, whoever is calling.
            let checked = b
                .output_path
                .as_deref()
                .map(|p| app_export_path(p, &b.format));
            let output_path = match checked.transpose() {
                Ok(p) => p.map(|p| p.to_string_lossy().into_owned()),
                Err(e) => return send_error(req, 400, &e),
            };
            let payload = serde_json::json!({
                "format": b.format,
                "outputPath": output_path,
            });
            // A headless export waits for the window to report it written
            // (or why not) through `mcp_edit_result`; one for the dialog
            // returns once the window is told. It can wait up to 30 s, so it
            // waits in its own slot ([`EXPORT_SLOTS`]): a slow export never
            // takes the slots edits, opens and reviews answer in.
            let reply = match output_path {
                Some(out) => match window_round_trip_within(
                    app,
                    "export",
                    "mcp://export",
                    payload,
                    EXPORT_ROUNDTRIP_TIMEOUT,
                    &EXPORT_SLOTS,
                ) {
                    Some(outcome) => export_reply(outcome, &out),
                    None => export_busy(&out),
                },
                None => emitted_reply(
                    app.emit("mcp://export", payload),
                    serde_json::json!({"ok": true}),
                ),
            };
            send_json(req, reply);
        }
        Err((code, e)) => send_error(req, code, &e),
    }
}

/// How long a headless `/export` waits for the window to write the file.
/// mdopener-mcp reads this reply with a longer timeout than its usual 5 s
/// (`EXPORT_WRITE_DEADLINE` plus a margin), so the reason reaches the agent.
const EXPORT_ROUNDTRIP_TIMEOUT: Duration = Duration::from_secs(30);

/// The headless `/export` reply for what the window reported (or did not
/// report) after it was asked to write `path`.
fn export_reply(
    outcome: Result<EditOutcome, mpsc::RecvTimeoutError>,
    path: &str,
) -> serde_json::Value {
    match outcome {
        Ok(o) if o.ok => serde_json::json!({ "ok": true, "path": path }),
        Ok(o) => serde_json::json!({
            "ok": false,
            "path": path,
            "error": o
                .error
                .unwrap_or_else(|| format!("The app could not export {path}.")),
        }),
        Err(_) => serde_json::json!({
            "ok": false,
            "path": path,
            "error": format!(
                "The app did not finish exporting {path} within {}s; it may still write it. \
                 Headless export renders the Read view: check the app for an error message.",
                EXPORT_ROUNDTRIP_TIMEOUT.as_secs()
            ),
        }),
    }
}

/// `/export`'s `outputPath`, checked by the rule the `export` MCP tool applies
/// ([`crate::export_path`]): an absolute path (the app's working directory is
/// unrelated to the caller's) to a file with the format's extension, not a
/// dotfile, in an existing directory.
fn app_export_path(raw: &str, format: &str) -> Result<std::path::PathBuf, String> {
    crate::export_path::checked_export_path(std::path::Path::new(raw), format, "outputPath")
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
    let timeout_ms = match review_timeout(body.timeout_ms) {
        Ok(t) => t,
        Err(e) => return send_error(req, 400, &e),
    };
    let abs_path = match body.path.as_deref().map(checked_agent_path).transpose() {
        Ok(p) => p,
        Err(e) => return send_error(req, 400, &e),
    };

    {
        let state = app.state::<ReviewState>();
        let mut map = state.0.lock_recover();
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
                late: false,
                shown: false,
                superseded_by: None,
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
            state.0.lock_recover().remove(&body.review_id);
            return send_json(req, refusal);
        }
    }
    // Tell the frontend a review is pending so it shows the review panel.
    // When the window cannot be told, no panel will ever show, so the review
    // is dropped and refused rather than left for the agent to wait on. Once
    // it is told, the review the panel showed before is superseded.
    let _panel = REVIEW_PANEL.lock_recover();
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
    {
        let state = app.state::<ReviewState>();
        let mut map = state.0.lock_recover();
        if reply["ok"] == true {
            supersede_shown(&mut map, &body.review_id, now_ms());
        } else {
            map.remove(&body.review_id);
        }
    }
    drop(_panel);
    send_json(req, reply);
}

/// The review window when `timeoutMs` is not given: 5 minutes.
const REVIEW_DEFAULT_TIMEOUT_MS: u64 = 300_000;
/// The shortest and longest review windows accepted (mirrored by the
/// `request_review` MCP tool, which refuses the same values).
const REVIEW_MIN_TIMEOUT_MS: u64 = 5_000;
const REVIEW_MAX_TIMEOUT_MS: u64 = 600_000;

/// The review window for a `/review` request's `timeoutMs`. A value outside
/// the accepted range is refused rather than clamped, so the caller never
/// waits on a window it did not ask for.
fn review_timeout(requested: Option<u64>) -> Result<u64, String> {
    match requested {
        None => Ok(REVIEW_DEFAULT_TIMEOUT_MS),
        Some(t) if (REVIEW_MIN_TIMEOUT_MS..=REVIEW_MAX_TIMEOUT_MS).contains(&t) => Ok(t),
        Some(t) => Err(format!(
            "timeoutMs must be between {REVIEW_MIN_TIMEOUT_MS} and {REVIEW_MAX_TIMEOUT_MS} ms, got {t}."
        )),
    }
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
/// absent. A value that does not decode to UTF-8 is an error (a 400), not
/// read as absent or empty: `/search` used to answer it with no results.
fn query_param(query: &str, key: &str) -> Result<Option<String>, String> {
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix(key)?.strip_prefix('='))
        .map(|v| {
            urlencoding::decode(v)
                .map(|v| v.into_owned())
                .map_err(|_| format!("the {key} query param is not percent-encoded UTF-8: '{v}'"))
        })
        .transpose()
}

/// The most a `limit` query param asks for (see [`limit_param`]).
const MAX_LIMIT: usize = 200;

/// The `limit` query param, or `default` when it is absent, clamped to 1 to
/// [`MAX_LIMIT`] for every route that takes one (`/search`, `/recent`). A
/// value that is not a whole number is refused rather than read as the
/// default, so a caller's `limit=ten` does not quietly get a different count.
/// `/recent` used to take any whole number as it came, so `limit=0` from
/// another local client answered an empty list, while `/search` clamped.
fn limit_param(query: &str, default: usize) -> Result<usize, String> {
    match query_param(query, "limit")? {
        None => Ok(default),
        Some(v) => match v.parse::<usize>() {
            Ok(n) => Ok(n.clamp(1, MAX_LIMIT)),
            // Digits too large for a usize are a huge limit, not a malformed one.
            Err(_) if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) => Ok(MAX_LIMIT),
            Err(_) => Err(format!(
                "limit must be a whole number, got '{v}'; omit it for the default of {default}."
            )),
        },
    }
}

/// The status `/review/result` reports: the recorded one, except that a review
/// still pending once its window has closed is `timeout`, so a review whose
/// panel never reported back (the window closed or reloaded) still ends.
fn review_status(r: &ReviewRecord, now: u64) -> &str {
    if r.status == "pending" && now >= r.created_at.saturating_add(r.timeout_ms) {
        "timeout"
    } else {
        &r.status
    }
}

fn handle_review_result(req: Request, query: &str, app: &AppHandle) {
    let id = match query_param(query, "id") {
        Ok(id) => id.unwrap_or_default(),
        Err(e) => return send_error(req, 400, &e),
    };
    let id = id.as_str();
    if id.is_empty() {
        return send_error(req, 400, "id query param required");
    }
    // Clone the record out before responding so the mutex isn't held across the
    // blocking socket write in send_json (which would stall set_review_verdict
    // and every other ReviewState reader against a slow client).
    let record = {
        let state = app.state::<ReviewState>();
        let map = state.0.lock_recover();
        let now = now_ms();
        map.get(id).map(|r| {
            (
                review_status(r, now).to_string(),
                r.verdict.clone(),
                r.comments.clone(),
                r.late,
                r.superseded_by.clone(),
            )
        })
    };
    match record {
        None => send_json(req, serde_json::json!({ "status": "not_found" })),
        Some((status, verdict, comments, late, superseded_by)) => send_json(req, serde_json::json!({
            "status": status,
            "verdict": verdict,
            "comments": comments,
            "late": late,
            "supersededBy": superseded_by,
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

/// Largest file `/annotations` reads its task list from: the 16 MiB a
/// document may be (the IPC body cap, and what mdopener-mcp reads from disk).
/// The file used to be read whole however large it was.
const MAX_ANNOTATION_FILE_BYTES: u64 = crate::doc_read::MAX_DOCUMENT_BYTES;

use crate::task_list::parse_tasks;

/// The GFM task checkboxes of the file `requested`: from the live buffer when
/// it is the open document, else read from disk when it is a Markdown file
/// (not a dotfile, checked after resolving symlinks), else none. Never the
/// open document's tasks for some other path. The second value says why a
/// Markdown file's tasks could not be read (larger than
/// [`MAX_ANNOTATION_FILE_BYTES`], or not readable as UTF-8 text), so an empty
/// list is not taken for a file with no tasks.
fn annotation_tasks(
    requested: &str,
    open_path: Option<&str>,
    open_content: &str,
) -> (Vec<serde_json::Value>, Option<String>) {
    if open_path.is_some_and(|o| same_path(requested, o)) {
        return (parse_tasks(open_content), None);
    }
    // The same check as `/open` (Markdown, not a dotfile, after resolving
    // links), and the read takes the file it saw: a link swapped in after
    // the check is not followed.
    let Ok(doc) = checked_agent_document(requested) else {
        return (vec![], None);
    };
    match doc.read_capped(MAX_ANNOTATION_FILE_BYTES) {
        Ok(c) => (parse_tasks(&c), None),
        Err(e) => (
            vec![],
            Some(format!("The tasks of {} were not read: {e}.", doc.path)),
        ),
    }
}

/// The `path` `/annotations` reports on. Without one there is no file to
/// read tasks from or match reviews against, and the reply used to be an
/// empty result for the path "", which reads as "no tasks, no verdict".
fn annotations_path(query: &str) -> Result<String, String> {
    query_param(query, "path")?
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
        let inner = mirror.0.lock_recover();
        (inner.path.clone(), inner.content.clone())
    };
    let (tasks, tasks_note) = annotation_tasks(&raw_path, open_path.as_deref(), &open_content);

    // Resolve the latest matching verdict/comments, then drop the lock before
    // the blocking send_json response. Reviews store the canonical path, so a
    // relative or symlinked `path` still finds them.
    let (verdict, comments, late) = {
        let review_state = app.state::<ReviewState>();
        let map = review_state.0.lock_recover();
        map.values()
            .filter(|r| r.path.as_deref().is_some_and(|p| same_path(p, &raw_path)))
            .max_by_key(|r| r.created_at)
            .map(|r| (r.verdict.clone(), r.comments.clone(), r.late))
            .unwrap_or((None, None, false))
    };

    let mut body = serde_json::json!({
        "path": raw_path,
        "verdict": verdict,
        "comments": comments,
        "late": late,
        "tasks": tasks,
    });
    if let Some(note) = tasks_note {
        body["tasksNote"] = serde_json::json!(note);
    }
    send_json(req, body);
}

// ── Vault / search / edit / present handlers ──────────────────────────────────

/// GET /vault — enumerate the user's notes: the watched folder's files (mirrored
/// from the frontend) unioned with recent-file paths.
fn handle_vault(req: Request, app: &AppHandle) {
    let vault = app.state::<VaultMirror>().0.lock_recover().clone();
    let recents: Vec<String> = app
        .state::<RecentMirror>()
        .0
        .lock_recover()
        .iter()
        .map(|r| r.path.clone())
        .collect();
    send_json(req, serde_json::json!({
        "watchedDir": vault.watched_dir,
        "files": vault.files,
        "truncated": vault.truncated,
        "limit": vault.limit,
        "scanCut": vault.scan_cut,
        "depthCut": vault.depth_cut,
        "recents": recents,
    }));
}

/// GET /search?q=…&limit=N — full-text search across the vault + recents.
fn handle_search(req: Request, query: &str, app: &AppHandle) {
    let q = match query_param(query, "q") {
        Ok(q) => q.unwrap_or_default(),
        Err(e) => return send_error(req, 400, &e),
    };
    let limit = match limit_param(query, 50) {
        Ok(l) => l,
        Err(e) => return send_error(req, 400, &e),
    };

    if q.trim().is_empty() {
        return send_json(req, serde_json::json!({ "query": q, "results": [] }));
    }

    // Candidate set = vault files ∪ recents, locks dropped before search.
    let mut listed: Vec<String> = Vec::new();
    let (truncated, vault_limit, scan_cut, depth_cut);
    {
        let vault_state = app.state::<VaultMirror>();
        let vault = vault_state.0.lock_recover();
        truncated = vault.truncated;
        vault_limit = vault.limit;
        scan_cut = vault.scan_cut;
        depth_cut = vault.depth_cut;
        listed.extend(vault.files.iter().map(|f| f.path.clone()));
    }
    {
        let recent_state = app.state::<RecentMirror>();
        let recents = recent_state.0.lock_recover();
        listed.extend(recents.iter().map(|r| r.path.clone()));
    }
    let paths = searchable_documents(listed);

    let results = crate::search::search_checked(paths, q.clone(), Some(limit));
    send_json(req, search_body(&q, results, truncated, vault_limit, scan_cut, depth_cut));
}

/// The files `/search` may read for an agent, deduped: only Markdown
/// documents that are not dotfiles, judged after resolving symlinks (as
/// [`checked_agent_path`] does for `/open`). Recents hold whatever the human
/// opened (a dropped `.env`, a `notes.md` later re-pointed at `~/.ssh/id_rsa`),
/// and searching them used to hand the agent their matching lines, though
/// every other agent read refuses such files. Returns the checked documents,
/// read by [`crate::search::search_checked`] so that a link put in place
/// after this check is not followed when the file is read.
fn searchable_documents(listed: Vec<String>) -> Vec<crate::doc_read::CheckedDocument> {
    let mut seen = std::collections::HashSet::new();
    listed
        .iter()
        .filter_map(|p| checked_agent_document(p).ok())
        .filter(|d| seen.insert(d.path.clone()))
        .collect()
}

/// The `/search` reply. When the vault list is cut short it says so, since
/// the files left out were not searched. `depthCut` says the walk skipped
/// folders below its depth limit, so a consumer can tell that from the entry
/// budget (`scanCut` alone).
fn search_body(
    q: &str,
    results: impl Serialize,
    vault_truncated: bool,
    vault_limit: Option<usize>,
    scan_cut: bool,
    depth_cut: bool,
) -> serde_json::Value {
    let mut body = serde_json::json!({ "query": q, "results": results });
    if vault_truncated || scan_cut || depth_cut {
        body["truncated"] = serde_json::json!(true);
        body["note"] =
            serde_json::json!(vault_truncated_note(vault_limit, scan_cut || depth_cut, depth_cut));
    }
    if depth_cut {
        body["depthCut"] = serde_json::json!(true);
    }
    body
}

/// Said by `/search` when the watched folder has more Markdown files than the
/// app lists. `limit` is the frontend's own cap, synced with the file list, so
/// the number stated is the one in force; without it no number is claimed.
/// When the folder was too large or too deep to walk in full (`scan_cut`), the
/// files searched are the newest of those the walk reached, and it says that,
/// naming the depth limit when it was that one (`depth_cut`).
fn vault_truncated_note(limit: Option<usize>, scan_cut: bool, depth_cut: bool) -> String {
    let n = limit.map(|n| format!("{n} ")).unwrap_or_default();
    if depth_cut {
        return format!(
            "The watched folder is too deeply nested for Ashlr MD to scan in full (it \
             enters folders at most 8 levels down, and reads at most 50,000 entries), so \
             only the {n}most recently changed of the files it scanned (and the recent \
             documents) were searched; files in deeper folders were not searched."
        );
    }
    if scan_cut {
        return format!(
            "The watched folder is too large for Ashlr MD to scan in full (it reads at \
             most 50,000 entries), so only the {n}most recently changed of the files it \
             scanned (and the recent documents) were searched; newer files elsewhere in \
             the folder may have been missed."
        );
    }
    format!(
        "The watched folder has more Markdown files than Ashlr MD lists, so only \
         its {n}most recently changed files (and the recent documents) were searched."
    )
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
            "`find` string is not unique ({n} matches). Include more surrounding context to disambiguate."
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

/// Cap on edit round-trips (`/edit`, `/content`, `/open`, `/present`, the
/// review's open, `/stream-edit`) parked on worker threads at once.
const MAX_INFLIGHT_EDITS: usize = 2;
/// Cap on headless `/export` round-trips parked at once, in a budget of their
/// own: one waits up to [`EXPORT_ROUNDTRIP_TIMEOUT`] (30 s, against 4 s for an
/// edit), so sharing the edit slots let two slow exports refuse every other
/// window request for that long. With `WORKERS = 4`, 2 edits plus 1 export
/// still leave a worker free for `/health`, `/review/result` and the reads.
const MAX_INFLIGHT_EXPORTS: usize = 1;

/// A number of round-trip slots and how many are taken.
struct SlotBudget {
    inflight: AtomicUsize,
    cap: usize,
}
impl SlotBudget {
    const fn new(cap: usize) -> Self {
        SlotBudget {
            inflight: AtomicUsize::new(0),
            cap,
        }
    }
}
static EDIT_SLOTS: SlotBudget = SlotBudget::new(MAX_INFLIGHT_EDITS);
static EXPORT_SLOTS: SlotBudget = SlotBudget::new(MAX_INFLIGHT_EXPORTS);

/// RAII admission guard: lets at most a budget's `cap` round-trips run
/// concurrently and releases the slot on every return path (success, soft-fail,
/// timeout) via `Drop`.
struct InflightEdit(&'static SlotBudget);
impl InflightEdit {
    /// A slot of [`EDIT_SLOTS`].
    fn acquire() -> Option<Self> {
        Self::acquire_in(&EDIT_SLOTS)
    }

    fn acquire_in(slots: &'static SlotBudget) -> Option<Self> {
        if slots.inflight.fetch_add(1, Ordering::AcqRel) >= slots.cap {
            slots.inflight.fetch_sub(1, Ordering::AcqRel);
            None
        } else {
            Some(InflightEdit(slots))
        }
    }
}
impl Drop for InflightEdit {
    fn drop(&mut self) {
        self.0.inflight.fetch_sub(1, Ordering::AcqRel);
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
        .lock_recover()
        .path
        .clone()
        .unwrap_or_default();
    names_open_document(want, &have_raw).then_some(have_raw)
}

fn not_the_open_document() -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "error": "The named path is not the currently open document. Open it first with open_file.",
    })
}

fn editor_busy() -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "error": "The editor is busy applying another edit. Retry in a moment.",
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
             {path}. Retry in a moment."
        ),
    })
}

/// The headless `/export` reply when another export is still being written:
/// it can take up to [`EXPORT_ROUNDTRIP_TIMEOUT`], so the agent is told to
/// retry once that one finishes, not "in a moment".
fn export_busy(path: &str) -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "path": path,
        "error": format!(
            "Another headless export is still being written, so the app did not export \
             {path}. Retry once it finishes (it takes at most {}s).",
            EXPORT_ROUNDTRIP_TIMEOUT.as_secs()
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
        pending.0.lock_recover().insert(edit_id.clone(), tx);
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
            .lock_recover()
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
            app.state::<PendingEdits>().0.lock_recover().remove(&edit_id);
            send_json(req, serde_json::json!({
                "ok": false,
                "error": window_timed_out("apply the edit", true),
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
        pending.0.lock_recover().insert(edit_id.clone(), tx);
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
            .lock_recover()
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
            app.state::<PendingStreamEdits>().0.lock_recover().remove(&edit_id);
            send_json(req, serde_json::json!({
                "ok": false,
                "error": window_timed_out(
                    if body.preview { "preview the edit" } else { "apply the edit" },
                    !body.preview,
                ),
            }));
        }
    }
}

/// POST /stream-edit-apply — atomically apply a previously previewed stream edit.
///
/// Emits `mcp://stream-edit-apply` with find/replace/matchIndex. The frontend
/// keeps the previews it made, so it checks `originalEditId` against them
/// (refusing an unknown or stale one), then calls `applyEditAtOccurrence` and
/// reports back via `mcp_stream_edit_apply_result`.
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
        pending.0.lock_recover().insert(apply_id.clone(), tx);
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
            .lock_recover()
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
            app.state::<PendingStreamEditsApply>().0.lock_recover().remove(&apply_id);
            send_json(req, serde_json::json!({
                "ok": false,
                "error": window_timed_out("apply the edit", true),
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
    let open = app.state::<DocMirror>().0.lock_recover().path.clone();
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

/// The reply for a route the server does not have: a 404 with the JSON
/// `{"error": ...}` body every other error has. It used to be the plain text
/// `Not Found`, which clients parsing the error body could not read.
///
/// A route the server has under another method (`GET /open`) is a 405 with
/// an `Allow` header naming the methods it takes: it used to be the same
/// 404 "No such endpoint" as a path that does not exist, so a caller that
/// used the wrong method was told the endpoint was missing.
fn send_not_found(req: Request, method: &Method, path: &str) {
    let allowed: Vec<&str> = ROUTES
        .iter()
        .filter(|(_, p)| *p == path)
        .map(|(m, _)| *m)
        .collect();
    if allowed.is_empty() {
        return send_error(req, 404, &format!("No such endpoint: {method} {path}"));
    }
    let allow = allowed.join(", ");
    let body = serde_json::json!({
        "error": format!("{path} does not take {method}: use {}.", allowed.join(" or "))
    })
    .to_string();
    let resp = Response::from_string(body)
        .with_status_code(405)
        .with_header(
            tiny_http::Header::from_bytes(b"Content-Type", b"application/json").unwrap(),
        )
        .with_header(tiny_http::Header::from_bytes(b"Allow", allow.as_bytes()).unwrap());
    let _ = req.respond(resp);
}

/// Every route [`handle_request`] serves, as (method, path), for the 405
/// answer to a known path under another method.
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/health"),
    ("POST", "/review"),
    ("GET", "/review/result"),
    ("GET", "/annotations"),
    ("GET", "/vault"),
    ("GET", "/search"),
    ("POST", "/edit"),
    ("POST", "/stream-edit"),
    ("POST", "/stream-edit-apply"),
    ("POST", "/present"),
    ("GET", "/content"),
    ("POST", "/content"),
    ("POST", "/open"),
    ("GET", "/recent"),
    ("POST", "/export"),
];

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
        annotation_tasks, app_export_path, apply_unique_edit, parse_tasks, review_timeout,
        same_path, search_body, searchable_documents, InflightEdit, EDIT_SLOTS, EXPORT_SLOTS, MAX_INFLIGHT_EDITS,
    };
    use std::sync::atomic::Ordering;

    /// `/search` said nothing when the vault list was cut short, so an agent
    /// read "no hits" as "not in the folder". The number it states is the
    /// frontend's synced cap, not one hard-coded here.
    #[test]
    fn search_body_says_when_the_vault_list_is_truncated() {
        let full = search_body("q", Vec::<String>::new(), false, Some(150), false, false);
        assert!(full.get("truncated").is_none(), "{full}");
        let cut = search_body("q", Vec::<String>::new(), true, Some(150), false, false);
        assert_eq!(cut["truncated"], true);
        let note = cut["note"].as_str().unwrap();
        assert!(note.contains("its 150 most recently changed files"), "{cut}");
        // An older frontend that sends no cap: no number is claimed.
        let cut = search_body("q", Vec::<String>::new(), true, None, false, false);
        let note = cut["note"].as_str().unwrap();
        assert!(note.contains("its most recently changed files"), "{cut}");
        assert!(!note.contains("200"), "{cut}");
    }

    /// A folder too large to walk in full lists the newest of the files the
    /// walk reached, which need not be the folder's newest: `/search` says so.
    #[test]
    fn search_body_says_when_the_vault_walk_was_cut() {
        let cut = search_body("q", Vec::<String>::new(), false, Some(200), true, false);
        assert_eq!(cut["truncated"], true, "{cut}");
        assert!(cut.get("depthCut").is_none(), "the entry budget, not depth: {cut}");
        let note = cut["note"].as_str().unwrap();
        assert!(note.contains("too large for Ashlr MD to scan in full"), "{cut}");
        assert!(!note.contains("deeply nested"), "{cut}");
        assert!(note.contains("the 200 most recently changed of the files it scanned"), "{cut}");
    }

    /// The depth limit used to share `scanCut` (and its note) with the entry
    /// budget, so a consumer could not tell which one cut the walk.
    #[test]
    fn search_body_says_when_the_depth_limit_cut_the_walk() {
        let cut = search_body("q", Vec::<String>::new(), false, Some(200), true, true);
        assert_eq!(cut["truncated"], true, "{cut}");
        assert_eq!(cut["depthCut"], true, "{cut}");
        let note = cut["note"].as_str().unwrap();
        assert!(note.contains("too deeply nested for Ashlr MD to scan in full"), "{cut}");
        assert!(note.contains("at most 8 levels down"), "{cut}");
    }

    #[test]
    fn a_poisoned_lock_is_recovered_not_a_panic() {
        use super::LockRecover;
        use std::sync::{Arc, Mutex};
        let m = Arc::new(Mutex::new(vec![1]));
        let m2 = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let mut g = m2.lock().unwrap();
            g.push(2);
            panic!("a request handler panicked holding the lock");
        })
        .join();
        assert!(m.is_poisoned());
        // The state is still usable, and later requests see it.
        m.lock_recover().push(3);
        assert_eq!(*m.lock_recover(), vec![1, 2, 3]);
    }

    #[test]
    fn export_output_path_is_checked_by_the_app_too() {
        let dir = std::env::temp_dir().join(format!("mdopener-ipc-export-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub.html")).unwrap();
        let p = |rel: &str| dir.join(rel).to_string_lossy().into_owned();

        let ok = app_export_path(&p("out.HTML"), "html").unwrap();
        assert_eq!(ok, std::fs::canonicalize(&dir).unwrap().join("out.HTML"));
        assert!(app_export_path(&p("book.epub"), "epub").is_ok());

        let cases = [
            (p("out.pdf"), "pdf", "not supported for pdf"),
            (p(".bashrc"), "html", "must name a html file"),
            (p(".x.html"), "html", "not a dotfile"),
            (p("notes.md"), "html", "must name a html file"),
            (p("out.html"), "docx", "must name a docx file"),
            (p("missing/out.html"), "html", "directory does not exist"),
            (p("sub.html"), "html", "is a directory"),
            ("out.html".to_string(), "html", "must be an absolute path"),
        ];
        for (raw, format, want) in cases {
            let err = app_export_path(&raw, format).unwrap_err();
            assert!(err.contains(want), "{format} {raw}: {err}");
            assert!(err.contains("`outputPath`"), "{err}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn review_timeout_outside_the_range_is_refused_not_clamped() {
        assert_eq!(review_timeout(None), Ok(300_000));
        assert_eq!(review_timeout(Some(5_000)), Ok(5_000));
        assert_eq!(review_timeout(Some(600_000)), Ok(600_000));
        for bad in [0, 4_999, 600_001, u64::MAX] {
            let err = review_timeout(Some(bad)).unwrap_err();
            assert!(err.contains("between 5000 and 600000 ms"), "{bad}: {err}");
            assert!(err.contains(&bad.to_string()), "{err}");
        }
    }

    /// A second headless export is refused at once, saying another export
    /// is being written and how long that can take, not "in a moment".
    #[test]
    fn a_busy_export_says_another_export_holds_the_slot() {
        let r = super::export_busy("/tmp/out.pdf");
        assert_eq!(r["ok"], false);
        assert_eq!(r["path"], "/tmp/out.pdf");
        let e = r["error"].as_str().unwrap();
        assert!(e.contains("Another headless export is still being written"), "{e}");
        assert!(e.contains("at most 30s"), "{e}");
    }

    #[test]
    fn inflight_edit_guard_caps_concurrency() {
        // Headless exports wait up to 30 s in their own budget: with every
        // export slot taken, edits (and opens, presents, reviews) still get
        // all of theirs. They shared one budget, so two slow exports refused
        // every other window request until they finished.
        let mut exports: Vec<InflightEdit> = Vec::new();
        while let Some(g) = InflightEdit::acquire_in(&EXPORT_SLOTS) {
            exports.push(g);
            assert!(exports.len() <= 8, "the export budget is bounded");
        }
        assert!(!exports.is_empty(), "an export gets a slot");
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
            EDIT_SLOTS.inflight.load(Ordering::Acquire),
            0,
            "every slot is released once guards drop"
        );
        drop(exports);
        assert_eq!(EXPORT_SLOTS.inflight.load(Ordering::Acquire), 0);
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
            let (t, note) = annotation_tasks(p, Some(open_s), live);
            assert_eq!(note, None);
            assert_eq!(t.len(), 1);
            assert_eq!(t[0]["text"], "live task", "{p}");
        }
        assert!(same_path(&via_dots, open_s));

        // Another Markdown file: its own tasks from disk, not the open doc's.
        let (t, note) = annotation_tasks(other.to_str().unwrap(), Some(open_s), live);
        assert_eq!(note, None);
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
            assert_eq!(
                annotation_tasks(p.to_str().unwrap(), Some(open_s), live),
                (vec![], None),
                "{p:?}"
            );
        }
    }

    /// `/annotations` read a file that is not the open document whole,
    /// however large it was. Past 16 MiB it is not read, and the reply says
    /// why its task list is empty instead of passing it off as no tasks.
    #[test]
    fn annotation_tasks_skip_a_file_past_the_document_cap() {
        let dir = std::env::temp_dir().join(format!("ipc-annot-huge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let huge = dir.join("huge.md");
        let f = std::fs::File::create(&huge).unwrap();
        f.set_len(super::MAX_ANNOTATION_FILE_BYTES + 1).unwrap();
        drop(f);
        let (tasks, note) = annotation_tasks(huge.to_str().unwrap(), None, "");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(tasks.is_empty());
        let note = note.expect("a note saying why the tasks were not read");
        assert!(note.contains("more than the 16 MiB"), "{note}");
    }

    // ── Session files shared with mdopener-mcp ───────────────────────────────

    use super::{
        fit_session_json, parse_session_file, read_session_file, session_file_name,
        write_session_file, SessionMessage, MAX_SESSION_FILE_BYTES,
    };

    // ── Paths an agent may open, present or send for review ─────────────────

    use super::checked_agent_path;

    use super::export_refusal;

    /// A headless export reports what the window did, so a failed write
    /// reaches the agent with its reason instead of only a toast.
    #[test]
    fn a_headless_export_reports_what_the_window_did() {
        use super::{export_reply, EditOutcome};
        use std::sync::mpsc::RecvTimeoutError;
        let done = EditOutcome {
            ok: true,
            replaced: 1,
            error: None,
        };
        assert_eq!(
            export_reply(Ok(done), "/out/a.html"),
            serde_json::json!({ "ok": true, "path": "/out/a.html" })
        );
        let failed = EditOutcome {
            ok: false,
            replaced: 0,
            error: Some("Switch to Read view to export.".into()),
        };
        let v = export_reply(Ok(failed), "/out/a.html");
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "Switch to Read view to export.");
        let v = export_reply(Err(RecvTimeoutError::Timeout), "/out/a.html");
        assert_eq!(v["ok"], false);
        let e = v["error"].as_str().unwrap();
        assert!(e.contains("within 30s") && e.contains("/out/a.html"), "{e}");
    }

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

    /// A window that never answers gets an error naming the next step, not
    /// a question, and an unconfirmed change says to check before retrying.
    #[test]
    fn window_timeouts_name_the_next_step() {
        use super::{set_content_reply, window_open_reply, window_timed_out};
        use std::sync::mpsc::RecvTimeoutError;
        let edit = window_timed_out("apply the edit", true);
        assert_eq!(
            edit,
            "Timed out waiting for the app to apply the edit: the window did not answer \
             within 4 s. The window may still apply it, so call get_current_content to see \
             whether it did before retrying."
        );
        let open = window_timed_out("open /d/a.md", false);
        assert!(
            open.ends_with("Retry once the Ashlr MD window is responding again."),
            "{open}"
        );
        for e in [edit, open] {
            assert!(!e.contains('?'), "{e}");
            assert!(e.starts_with("Timed out"), "{e}");
        }
        let reply = set_content_reply(Err(RecvTimeoutError::Timeout));
        let e = reply["error"].as_str().unwrap();
        assert!(e.contains("get_current_content"), "{e}");
        let reply = window_open_reply(Err(RecvTimeoutError::Timeout), "/d/a.md", "present");
        let e = reply["error"].as_str().unwrap();
        assert!(e.contains("present /d/a.md: the window did not answer"), "{e}");
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
    /// `/recent` took `limit=0` (an empty list) and any huge value as they
    /// came, while `/search` clamped to 1 to 200. Both now clamp the same way.
    #[test]
    fn a_limit_is_clamped_to_1_through_200_for_every_route() {
        use super::limit_param;
        assert_eq!(limit_param("limit=0", 10), Ok(1));
        assert_eq!(limit_param("limit=1", 10), Ok(1));
        assert_eq!(limit_param("limit=200", 10), Ok(200));
        assert_eq!(limit_param("limit=201", 10), Ok(200));
        assert_eq!(limit_param("limit=1000000", 10), Ok(200));
        assert_eq!(limit_param("limit=99999999999999999999999", 10), Ok(200));
    }

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
        for query in ["", "path=", "x=1"] {
            let err = annotations_path(query).unwrap_err();
            assert!(err.contains("path query param required"), "{query}: {err}");
        }
        // An undecodable path says so, rather than that none was given.
        let err = annotations_path("path=%FF").unwrap_err();
        assert!(err.contains("not percent-encoded UTF-8"), "{err}");
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

    use super::{prune_reviews, record_verdict, ReviewRecord, MAX_REVIEWS, REVIEW_RETENTION_MS};
    use std::collections::HashMap;

    fn review(status: &str, path: Option<&str>, created_at: u64, timeout_ms: u64) -> ReviewRecord {
        ReviewRecord {
            status: status.into(),
            verdict: (status != "pending").then(|| status.to_string()),
            comments: None,
            path: path.map(str::to_string),
            created_at,
            timeout_ms,
            late: false,
            shown: status == "pending",
            superseded_by: None,
        }
    }

    #[test]
    fn a_review_the_panel_replaces_is_superseded_at_once() {
        use super::{review_status, supersede_shown};
        let t0 = 1_000_000;
        let mut map = HashMap::new();
        map.insert(
            "old".to_string(),
            review("pending", Some("/a.md"), t0, 300_000),
        );
        // Still opening its file, so not in the panel yet.
        let mut opening = review("pending", Some("/b.md"), t0 + 1, 300_000);
        opening.shown = false;
        map.insert("opening".to_string(), opening);
        map.insert(
            "done".to_string(),
            review("approved", Some("/c.md"), t0, 300_000),
        );
        let mut new = review("pending", Some("/d.md"), t0 + 2, 300_000);
        new.shown = false;
        map.insert("new".to_string(), new);

        supersede_shown(&mut map, "new", t0 + 10);

        let old = &map["old"];
        assert_eq!(review_status(old, t0 + 10), "superseded");
        assert_eq!(old.verdict.as_deref(), Some("superseded"));
        assert_eq!(old.superseded_by.as_deref(), Some("new"));
        assert!(map["new"].shown);
        assert_eq!(map["new"].status, "pending");
        assert_eq!(map["opening"].status, "pending", "not shown, not displaced");
        assert_eq!(
            map["done"].status, "approved",
            "a decision is never replaced"
        );

        // The review that finishes opening later takes the panel in turn.
        supersede_shown(&mut map, "opening", t0 + 20);
        assert_eq!(map["new"].status, "superseded");
        assert_eq!(map["new"].superseded_by.as_deref(), Some("opening"));
        assert_eq!(map["opening"].status, "pending");
    }

    #[test]
    fn a_verdict_on_a_superseded_review_is_kept_but_late() {
        // A click in flight as the panel switched: the human did decide, but
        // the agent may already have been told `superseded`.
        let mut r = review("pending", None, 1_000, 5_000);
        r.status = "superseded".into();
        record_verdict(&mut r, "timeout".into(), None, 2_000);
        assert_eq!(r.status, "superseded", "a timeout does not replace it");
        record_verdict(&mut r, "approved".into(), None, 2_000);
        assert_eq!(r.status, "approved");
        assert!(r.late);
    }

    #[test]
    fn a_verdict_inside_the_window_is_not_late() {
        let mut r = review("pending", None, 1_000, 5_000);
        record_verdict(&mut r, "approved".into(), Some("ok".into()), 5_999);
        assert_eq!(r.status, "approved");
        assert_eq!(r.comments.as_deref(), Some("ok"));
        assert!(!r.late);
    }

    #[test]
    fn a_verdict_after_the_window_closed_is_kept_but_marked_late() {
        // Past the window, still pending: the agent was (or will be) told
        // `timeout`, so the human's verdict is marked late.
        let mut r = review("pending", None, 1_000, 5_000);
        record_verdict(&mut r, "changes_requested".into(), None, 6_000);
        assert_eq!(r.status, "changes_requested");
        assert!(r.late);

        // After the panel recorded `timeout`, even if the clock says the
        // window is still open (the window and the panel keep separate time).
        let mut r = review("timeout", None, 1_000, 5_000);
        record_verdict(&mut r, "approved".into(), None, 2_000);
        assert_eq!(r.verdict.as_deref(), Some("approved"));
        assert!(r.late);
    }

    #[test]
    fn a_timeout_never_replaces_a_recorded_decision() {
        let mut r = review("pending", None, 1_000, 5_000);
        record_verdict(&mut r, "approved".into(), Some("lgtm".into()), 2_000);
        record_verdict(&mut r, "timeout".into(), None, 7_000);
        assert_eq!(r.status, "approved");
        assert_eq!(r.comments.as_deref(), Some("lgtm"));
        assert!(!r.late);

        let mut r = review("pending", None, 1_000, 5_000);
        record_verdict(&mut r, "timeout".into(), None, 6_000);
        assert_eq!(r.status, "timeout");
        assert!(!r.late);
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
        assert_eq!(query_param("id=rev_1", "id"), Ok(Some("rev_1".into())));
        assert_eq!(
            query_param("x=1&id=my%20review%26co", "id"),
            Ok(Some("my review&co".into()))
        );
        assert_eq!(query_param("idx=1", "id"), Ok(None));
        assert_eq!(query_param("", "id"), Ok(None));
        assert_eq!(query_param("q=", "q"), Ok(Some(String::new())));
    }

    /// A query param that does not decode to UTF-8 is refused (`/search`
    /// answered it with no results, which reads as "nothing matches").
    #[test]
    fn an_undecodable_query_param_is_an_error_not_empty() {
        use super::{annotations_path, limit_param, query_param};
        let err = query_param("q=%FF%FE&limit=5", "q").unwrap_err();
        assert!(
            err.contains("q query param is not percent-encoded UTF-8"),
            "{err}"
        );
        assert!(err.contains("%FF%FE"), "{err}");
        // Other params of the same query still read.
        assert_eq!(query_param("q=%FF&limit=5", "limit"), Ok(Some("5".into())));
        assert!(limit_param("limit=%C3", 50)
            .unwrap_err()
            .contains("limit query param"));
        assert!(annotations_path("path=%80.md")
            .unwrap_err()
            .contains("path query param"));
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

    /// `/search` read every recent, so a dropped `.env` or a `notes.md` link
    /// to a key had its matching lines returned to the agent.
    #[test]
    fn search_reads_only_markdown_documents() {
        let d = Scratch::new("search-scope");
        let md = d.0.join("notes.md");
        std::fs::write(&md, "TOKEN in notes").unwrap();
        let env = d.0.join(".env");
        std::fs::write(&env, "TOKEN=secret").unwrap();
        let txt = d.0.join("id_rsa");
        std::fs::write(&txt, "TOKEN key").unwrap();
        let hidden = d.0.join(".hidden.md");
        std::fs::write(&hidden, "TOKEN hidden").unwrap();
        let mut listed = vec![md.clone(), env, txt.clone(), hidden, md.clone()];
        #[cfg(unix)]
        {
            let link = d.0.join("link.md");
            std::os::unix::fs::symlink(&txt, &link).unwrap();
            listed.push(link);
        }
        let listed = listed
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let canon = std::fs::canonicalize(&md).unwrap();
        let docs: Vec<String> = searchable_documents(listed)
            .into_iter()
            .map(|d| d.path)
            .collect();
        assert_eq!(docs, vec![canon.to_string_lossy().into_owned()]);
    }

    /// `/search` and `/annotations` checked a path and then opened it again,
    /// so `notes.md` swapped for a link to a secret after the check had the
    /// secret's lines returned. The search reads the file the check saw.
    #[cfg(unix)]
    #[test]
    fn search_refuses_a_document_swapped_for_a_link_after_the_check() {
        let d = Scratch::new("search-swap");
        let md = d.0.join("notes.md");
        std::fs::write(&md, "TOKEN in notes").unwrap();
        let key = d.0.join("id_rsa");
        std::fs::write(&key, "TOKEN private key").unwrap();
        let docs = searchable_documents(vec![md.to_string_lossy().into_owned()]);
        assert_eq!(docs.len(), 1);
        std::fs::remove_file(&md).unwrap();
        std::os::unix::fs::symlink(&key, &md).unwrap();
        let hits = crate::search::search_checked(docs, "token".into(), None);
        assert!(hits.is_empty(), "the secret was searched");
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

    /// An unknown route answered the plain text `Not Found`, unlike every
    /// other error, which is a JSON `{"error": ...}` body.
    #[test]
    fn an_unknown_route_is_a_json_404() {
        use std::io::{Read as _, Write as _};
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let client = std::thread::spawn(move || {
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(b"GET /nope?x=1 HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
                .unwrap();
            let mut raw = String::new();
            s.read_to_string(&mut raw).unwrap();
            raw
        });
        let req = server.recv().unwrap();
        let method = req.method().clone();
        super::send_not_found(req, &method, "/nope");
        let raw = client.join().unwrap();
        let (head, body) = raw.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("HTTP/1.0 404") || head.starts_with("HTTP/1.1 404"), "{head}");
        assert!(
            head.to_ascii_lowercase().contains("content-type: application/json"),
            "{head}"
        );
        let v: serde_json::Value = serde_json::from_str(body).expect("a JSON body");
        assert_eq!(v["error"], "No such endpoint: GET /nope", "{v}");
    }

    /// Send `request` to a one-shot server, answer it with `send_not_found`,
    /// and return the raw HTTP reply.
    fn not_found_reply(request: &'static [u8], path: &str) -> String {
        use std::io::{Read as _, Write as _};
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let client = std::thread::spawn(move || {
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(request).unwrap();
            let mut raw = String::new();
            s.read_to_string(&mut raw).unwrap();
            raw
        });
        let req = server.recv().unwrap();
        let method = req.method().clone();
        super::send_not_found(req, &method, path);
        client.join().unwrap()
    }

    /// A route the server has, asked for with the wrong method, was the same
    /// 404 "No such endpoint" as a path that does not exist.
    #[test]
    fn a_known_route_under_the_wrong_method_is_a_json_405() {
        let raw = not_found_reply(b"GET /open HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n", "/open");
        let (head, body) = raw.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("HTTP/1.0 405") || head.starts_with("HTTP/1.1 405"), "{head}");
        assert!(head.to_ascii_lowercase().contains("allow: post"), "{head}");
        let v: serde_json::Value = serde_json::from_str(body).expect("a JSON body");
        assert_eq!(v["error"], "/open does not take GET: use POST.", "{v}");

        // A path served under two methods names both.
        let raw = not_found_reply(
            b"DELETE /content HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n",
            "/content",
        );
        let (head, _) = raw.split_once("\r\n\r\n").unwrap();
        assert!(head.contains(" 405"), "{head}");
        assert!(head.to_ascii_lowercase().contains("allow: get, post"), "{head}");
    }

    /// `ROUTES` lists exactly the routes `handle_request` matches, so the 405
    /// answer cannot drift from the router.
    #[test]
    fn routes_match_the_router() {
        let src = include_str!("ipc.rs");
        let router = &src[src.find("fn handle_request(").unwrap()..];
        let router = &router[..router.find("\n}\n").unwrap()];
        let mut found = vec![("GET".to_string(), "/health".to_string())];
        for line in router.lines() {
            let t = line.trim_start();
            let Some(rest) = t.strip_prefix("(Method::") else { continue };
            let Some((method, rest)) = rest.split_once(", \"") else { continue };
            let Some((path, _)) = rest.split_once('"') else { continue };
            found.push((method.to_ascii_uppercase(), path.to_string()));
        }
        found.sort();
        let mut listed: Vec<(String, String)> = super::ROUTES
            .iter()
            .map(|(m, p)| (m.to_string(), p.to_string()))
            .collect();
        listed.sort();
        assert_eq!(listed, found);
    }

    /// The app read a session file whole however large it was. Past 16 MiB
    /// it is now refused before reading, saying how large it is, and a
    /// write over it is refused rather than replacing it.
    #[test]
    fn a_session_file_past_the_cap_is_not_read() {
        let d = Scratch::new("huge");
        let path = d.0.join(session_file_name("s1"));
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_SESSION_FILE_BYTES + 1)
            .unwrap();
        let err = parse_session_file(&path).err().expect("refused");
        assert!(err.contains("more than the 16 MiB"), "{err}");
        let err = read_session_file(&d.0, "s1").err().expect("refused");
        assert!(err.contains("more than the 16 MiB"), "{err}");
        let err = write_session_file(&d.0, "s1", &[msg("m1", "s1", 1)]).err().expect("refused");
        assert!(err.contains("more than the 16 MiB"), "{err}");
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            MAX_SESSION_FILE_BYTES + 1,
            "left untouched"
        );
    }

    /// A log too large for the cap drops its oldest messages when written,
    /// so the file the app writes is one it can read back.
    #[test]
    fn a_session_written_past_the_cap_keeps_its_newest_messages() {
        let d = Scratch::new("fit");
        let big = |id: &str, ts: u64| SessionMessage {
            content: "x".repeat(6 * 1024 * 1024),
            ..msg(id, "s1", ts)
        };
        let kept = write_session_file(&d.0, "s1", &[big("a", 1), big("b", 2), big("c", 3)])
            .unwrap();
        assert_eq!(ids(&kept), ["b", "c"]);
        let path = d.0.join(session_file_name("s1"));
        assert!(std::fs::metadata(&path).unwrap().len() <= MAX_SESSION_FILE_BYTES);
        assert_eq!(ids(&read_session_file(&d.0, "s1").unwrap()), ["b", "c"]);
        let err = fit_session_json(&mut vec![SessionMessage {
            content: "x".repeat(17 * 1024 * 1024),
            ..msg("z", "s1", 9)
        }])
        .unwrap_err();
        assert!(err.contains("too large"), "{err}");
    }

    /// Persisting from the window used to leave the session file `0644` in a
    /// `0755` directory (mdopener-mcp makes them `0700`/`0600`), so any local
    /// user could read the conversation once the app had saved it.
    #[cfg(unix)]
    #[test]
    fn persisted_session_files_are_private() {
        use std::os::unix::fs::PermissionsExt as _;
        let d = Scratch::new("private");
        std::fs::set_permissions(&d.0, std::fs::Permissions::from_mode(0o755)).unwrap();
        write_session_file(&d.0, "s1", &[msg("m1", "s1", 1)]).unwrap();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&d.0), 0o700, "sessions dir");
        assert_eq!(mode(&d.0.join("s1.json")), 0o600, "session file");
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

    /// The window's session writer kept a path cited twice in one message
    /// twice, while mdopener-mcp saves it once. It is now saved once, in the
    /// order first given.
    #[test]
    fn a_path_cited_twice_in_one_message_is_saved_once() {
        let d = Scratch::new("cited");
        let cited = |id: &str, ts: u64, docs: &[&str]| SessionMessage {
            cited_docs: docs.iter().map(|s| s.to_string()).collect(),
            ..msg(id, "s1", ts)
        };
        let docs = ["/b.md", "/a.md", "/b.md", "/a.md", "/c.md"];
        let kept = write_session_file(&d.0, "s1", &[cited("m1", 1, &docs)]).unwrap();
        assert_eq!(kept[0].cited_docs, ["/b.md", "/a.md", "/c.md"]);
        let read = read_session_file(&d.0, "s1").unwrap();
        assert_eq!(read[0].cited_docs, ["/b.md", "/a.md", "/c.md"]);
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
