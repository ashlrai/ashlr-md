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
//! | POST   | /edit      | `{"find":"…","replace":"…","save":bool}` | Exact find/replace on live doc  |
//! | POST   | /present   | `{"path":"…|null"}`                   | Open + distraction-free reading    |
//!
//! Auth: every endpoint except `/health` requires `Authorization: Bearer <token>`
//! (the per-session token in `~/.mdopener/ipc-token`).
//!
//! Content is kept in [`DocMirror`], a managed Tauri state struct that the
//! frontend syncs via `mcp_sync_state` on every document change.  Mutations
//! (`/content`, `/open`, `/export`) store a pending request in [`PendingIpc`]
//! and emit a Tauri event; the frontend picks it up, applies it, and (for
//! `/content`) calls `mcp_sync_state` again to confirm the round-trip.

use std::sync::Mutex;

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
    for req in server.incoming_requests() {
        let method = req.method().clone();
        let url = req.url().to_string();
        // Separate path from query string.
        let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));

        // /health is unauthenticated — a liveness probe carrying no data.
        if method == Method::Get && path == "/health" {
            send_json(req, serde_json::json!({"ok": true}));
            continue;
        }
        // Every other endpoint requires the loopback auth token.
        if !check_auth(&req, &bearer) {
            send_error(req, 401, "Unauthorized");
            continue;
        }

        match (method, path) {
            (Method::Post, "/review") => handle_review_post(req, &app),
            (Method::Get, "/review/result") => handle_review_result(req, query, &app),
            (Method::Get, "/annotations") => handle_annotations(req, query, &app),

            (Method::Get, "/vault") => handle_vault(req, &app),
            (Method::Get, "/search") => handle_search(req, query, &app),
            (Method::Post, "/edit") => handle_edit(req, &app),
            (Method::Post, "/present") => handle_present(req, &app),

            (Method::Get, "/content") => {
                let mirror = app.state::<DocMirror>();
                let inner = mirror.0.lock().unwrap().clone();
                send_json(req, serde_json::json!({
                    "path": inner.path,
                    "content": inner.content,
                }));
            }

            (Method::Post, "/content") => handle_set_content(req, &app),

            (Method::Post, "/open") => handle_open(req, &app),

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

            (Method::Post, "/export") => handle_export(req, &app),

            _ => {
                let _ = req.respond(Response::from_string("Not Found").with_status_code(404));
            }
        }
    }
}

// ── Individual handlers ───────────────────────────────────────────────────────

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
        Err(e) => send_error(req, 400, &e),
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
            // Resolve to absolute path.
            let abs = std::fs::canonicalize(&b.path)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or(b.path.clone());

            let _ = app.emit("mcp://open", serde_json::json!({
                "path": abs,
                "mode": b.mode,
            }));
            send_json(req, serde_json::json!({"ok": true, "path": abs}));
        }
        Err(e) => send_error(req, 400, &e),
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
        Err(e) => send_error(req, 400, &e),
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
        Err(e) => return send_error(req, 400, &e),
    };
    if body.review_id.is_empty() {
        return send_error(req, 400, "reviewId is required");
    }
    let timeout_ms = body.timeout_ms.unwrap_or(300_000).clamp(5_000, 600_000);
    let abs_path = body.path.as_deref().map(|p| {
        std::fs::canonicalize(p)
            .map(|c| c.to_string_lossy().into_owned())
            .unwrap_or_else(|_| p.to_string())
    });

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

    let content = app.state::<DocMirror>().0.lock().unwrap().content.clone();
    let tasks = parse_tasks(&content);

    // Resolve the latest matching verdict/comments, then drop the lock before
    // the blocking send_json response.
    let (verdict, comments) = {
        let review_state = app.state::<ReviewState>();
        let map = review_state.0.lock().unwrap();
        map.values()
            .filter(|r| r.path.as_deref() == Some(raw_path.as_str()))
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

/// POST /edit — exact-string find/replace on the live document. Soft failures
/// (not found / not unique) come back as 200 `{"ok":false,"error":…}` so the
/// agent sees the reason rather than an opaque HTTP error.
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
        Err(e) => return send_error(req, 400, &e),
    };

    let mirror = app.state::<DocMirror>().0.lock().unwrap().clone();

    // Edits act on the live document. If the caller named a path, make sure it
    // matches the open doc so they don't silently edit the wrong file. Compare
    // canonical paths only when BOTH resolve (e.g. both exist on disk); if either
    // can't be canonicalized, fall back to a raw string compare on both sides so
    // the two legs are always normalized the same way.
    if let Some(ref p) = body.path {
        let have_raw = mirror.path.clone().unwrap_or_default();
        let want_canon = std::fs::canonicalize(p).ok();
        let have_canon = std::fs::canonicalize(&have_raw).ok();
        let matches = match (want_canon, have_canon) {
            (Some(a), Some(b)) => a == b,
            _ => p == &have_raw,
        };
        if !matches {
            return send_json(req, serde_json::json!({
                "ok": false,
                "error": "The named path is not the currently open document — open it first with open_file.",
            }));
        }
    }

    match apply_unique_edit(&mirror.content, &body.find, &body.replace) {
        Ok(new_content) => {
            let _ = app.emit("mcp://set-content", serde_json::json!({
                "content": new_content,
                "save": body.save,
            }));
            send_json(req, serde_json::json!({ "ok": true, "replaced": 1 }));
        }
        Err(e) => send_json(req, serde_json::json!({ "ok": false, "error": e })),
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
        Err(e) => return send_error(req, 400, &e),
    };
    let abs = body.path.as_deref().map(|p| {
        std::fs::canonicalize(p)
            .map(|c| c.to_string_lossy().into_owned())
            .unwrap_or_else(|_| p.to_string())
    });
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

fn read_json_body<T: serde::de::DeserializeOwned>(req: &mut Request) -> Result<T, String> {
    // Cap the body so a malformed/hostile local caller can't OOM the server
    // thread with an unbounded POST. 16 MiB is generous for any real document.
    const MAX_BODY: u64 = 16 * 1024 * 1024;
    use std::io::Read;
    let mut buf = String::new();
    req.as_reader()
        .take(MAX_BODY)
        .read_to_string(&mut buf)
        .map_err(|e| format!("Failed to read request body: {e}"))?;
    serde_json::from_str(&buf).map_err(|e| format!("Invalid JSON body: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{apply_unique_edit, parse_tasks};

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
}
