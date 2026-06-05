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

// ── IPC port file helpers ─────────────────────────────────────────────────────

fn ipc_port_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".mdopener").join("ipc-port"))
}

fn write_port(port: u16) {
    if let Some(path) = ipc_port_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, port.to_string());
    }
}

pub fn remove_port_file() {
    if let Some(path) = ipc_port_path() {
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

    write_port(port);

    std::thread::Builder::new()
        .name("mdopener-ipc".into())
        .spawn(move || run_server(server, app))
        .map_err(|e| format!("IPC thread spawn failed: {e}"))?;

    Ok(port)
}

// ── Request dispatch ──────────────────────────────────────────────────────────

fn run_server(server: Server, app: AppHandle) {
    for req in server.incoming_requests() {
        let method = req.method().clone();
        let url = req.url().to_string();
        // Separate path from query string.
        let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));

        match (method, path) {
            (Method::Get, "/health") => send_json(req, serde_json::json!({"ok": true})),

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
    let mut buf = String::new();
    req.as_reader()
        .read_to_string(&mut buf)
        .map_err(|e| format!("Failed to read request body: {e}"))?;
    serde_json::from_str(&buf).map_err(|e| format!("Invalid JSON body: {e}"))
}
