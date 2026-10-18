//! Library portion of the mdopener-mcp binary — exposed so integration tests
//! can drive the dispatch layer with a mock IPC client.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub mod launch;

// ── JSON-RPC types ────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
pub struct Request {
    #[allow(dead_code)]
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Serialize, Debug)]
pub struct Response {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Serialize, Debug)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
            }),
        }
    }
}

// ── IPC client trait ──────────────────────────────────────────────────────────

/// Abstraction over the loopback HTTP IPC transport.  The real implementation
/// reads `~/.mdopener/ipc-port` and `~/.mdopener/ipc-token`; the test
/// implementation points at a lightweight mock server spun up in the test.
pub trait IpcClient: Send + Sync {
    fn get(&self, path: &str) -> Result<Value, String>;
    fn post(&self, path: &str, body: Value) -> Result<Value, String>;
    /// [`IpcClient::post`] for a request the app answers only after slow
    /// work (a headless export), read with `read_timeout` instead of 5 s.
    fn post_within(
        &self,
        path: &str,
        body: Value,
        read_timeout: std::time::Duration,
    ) -> Result<Value, String> {
        let _ = read_timeout;
        self.post(path, body)
    }
}

// ── Real IPC client ───────────────────────────────────────────────────────────

pub struct RealIpcClient;

impl IpcClient for RealIpcClient {
    fn get(&self, path: &str) -> Result<Value, String> {
        ipc_get(path)
    }
    fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        ipc_post(path, body)
    }
    fn post_within(
        &self,
        path: &str,
        body: Value,
        read_timeout: std::time::Duration,
    ) -> Result<Value, String> {
        let port = read_ipc_port()?;
        let token = read_ipc_token()?;
        let url = format!("http://127.0.0.1:{port}{path}");
        http_post_within(&url, &body, &token, read_timeout)
    }
}

// ── Method dispatcher ─────────────────────────────────────────────────────────

pub fn dispatch(req: Request, ipc: &dyn IpcClient) -> Option<Response> {
    // JSON-RPC notifications (methods under "notifications/", carrying no id)
    // must NOT receive a response. Drop them silently. One sent with an `id`
    // is a request, and a request is always answered: dropping it left the
    // client waiting on that id forever. MCP notifications MUST NOT carry an
    // id, so it is an Invalid Request.
    if req.method.starts_with("notifications/") {
        return req.id.map(|id| {
            Response::err(
                id,
                -32600,
                format!(
                    "Invalid Request: `{}` is a notification and must not carry an `id`; \
                     send it without one (it gets no reply).",
                    req.method
                ),
            )
        });
    }

    let id = req.id.clone().unwrap_or(Value::Null);

    let response = match req.method.as_str() {
        "initialize" => handle_initialize(id, req.params),

        "ping" => Response::ok(id, json!({})),

        "tools/list" => Response::ok(id, json!({ "tools": tool_list() })),

        "tools/call" => {
            let params = req.params.unwrap_or(Value::Null);
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = params["arguments"].clone();
            handle_tool_call(id, &name, args, ipc)
        }

        "resources/list" => handle_resources_list(id, ipc),
        "resources/templates/list" => {
            Response::ok(id, json!({ "resourceTemplates": resource_templates() }))
        }
        "resources/read" => {
            let params = req.params.unwrap_or(Value::Null);
            let uri = params["uri"].as_str().unwrap_or("").to_string();
            handle_resource_read(id, &uri, ipc)
        }

        "prompts/list" => Response::ok(id, json!({ "prompts": prompts_list() })),
        "prompts/get" => {
            let params = req.params.unwrap_or(Value::Null);
            let name = params["name"].as_str().unwrap_or("").to_string();
            match prompt_arguments_problem(&name, &params["arguments"]) {
                Some(msg) => Response::err(id, -32602, msg),
                None => handle_prompt_get(id, &name, ipc),
            }
        }

        other => Response::err(id, -32601, format!("Method not found: {other}")),
    };
    Some(response)
}

/// The `-32600` reply for a message whose JSON-RPC envelope is not valid, or
/// `None` when it is (or when `message` is not an object, which the typed
/// [`Request`] parse refuses). A request used to be served whatever its
/// `jsonrpc` said, with an object, a fraction or `null` as its `id`, and with
/// a string or a number as its `params`. JSON-RPC 2.0 requires `"jsonrpc":
/// "2.0"` and structured `params`; MCP requires a string or integer `id`
/// (never `null`). An `id` that is not one is not echoed: the reply carries
/// `null`, as JSON-RPC says for an id that cannot be determined.
pub fn invalid_envelope(message: &Value) -> Option<Response> {
    let obj = message.as_object()?;
    let id = match obj.get("id") {
        None => Value::Null,
        Some(v @ Value::String(_)) => v.clone(),
        Some(v @ Value::Number(n)) if n.is_i64() || n.is_u64() => v.clone(),
        Some(other) => {
            return Some(Response::err(
                Value::Null,
                -32600,
                format!("Invalid Request: `id` must be a string or an integer, got {other}"),
            ))
        }
    };
    match obj.get("jsonrpc") {
        Some(Value::String(v)) if v == "2.0" => {}
        // A missing member is named by the typed parse.
        None => {}
        Some(other) => {
            return Some(Response::err(
                id,
                -32600,
                format!("Invalid Request: `jsonrpc` must be \"2.0\", got {other}"),
            ))
        }
    }
    match obj.get("params") {
        None | Some(Value::Null | Value::Object(_) | Value::Array(_)) => None,
        Some(other) => Some(Response::err(
            id,
            -32600,
            format!("Invalid Request: `params` must be an object, got {other}"),
        )),
    }
}

// ── initialize ────────────────────────────────────────────────────────────────

/// Protocol revisions this server understands. We echo the client's requested
/// version when it's one of these, else answer with the latest one we support
/// (the MCP lifecycle spec: the server "SHOULD" offer its latest version and
/// the client decides whether it can use it).
pub const SUPPORTED_PROTOCOLS: [&str; 3] = ["2024-11-05", "2025-03-26", "2025-06-18"];
pub const DEFAULT_PROTOCOL: &str = "2025-06-18";

/// The `instructions` of the `initialize` result: what the server is for, the
/// tools an agent reaches for first, and what to do when the app is not
/// running or not installed. Clients may add it to the model's context, so an
/// agent that has only `tools/list` is not left to guess which of 20 tools to
/// start with, or that only `open_file` starts the app.
pub const SERVER_INSTRUCTIONS: &str = "Ashlr MD is a Markdown viewer and editor on the \
user's desktop. These tools show Markdown documents to the human in its window, ask for \
their sign-off, and edit the open document. Start with: open_file to show a file (the only \
tool that starts the app), present_document for a full-screen reading view of a finished \
result, request_review to wait for the human to Approve, Request changes or Dismiss, \
get_current_content to read the open document, and edit_document for an exact, unique \
find and replace in it (prefer it to replace_document and set_content, which replace the \
whole document). The other tools that use the window need Ashlr MD running: when one says \
the app is not running, call open_file. If open_file says the app could not be launched, \
Ashlr MD is probably not installed: ask the user to install it from \
https://github.com/ashlrai/ashlr-md/releases. Without the app these still work on files on \
disk: export_text, export_metadata and diff_documents (pass `path`), search_vault (pass \
`vault`), get_user_annotations (task checkboxes only), edit_canvas, list_ai_actions, get_conversation_context and \
save_conversation_message.";

pub fn handle_initialize(id: Value, params: Option<Value>) -> Response {
    // Negotiate: honor the client's requested protocolVersion if we support it,
    // otherwise advertise our latest (per the MCP lifecycle spec).
    let requested = params.as_ref().and_then(|p| p["protocolVersion"].as_str());
    let protocol = match requested {
        Some(v) if SUPPORTED_PROTOCOLS.contains(&v) => v,
        _ => DEFAULT_PROTOCOL,
    };

    Response::ok(
        id,
        json!({
            "protocolVersion": protocol,
            "capabilities": {
                "tools": {},
                "resources": {},
                "prompts": {}
            },
            "serverInfo": {
                "name": "mdopener-mcp",
                "version": env!("CARGO_PKG_VERSION")
            },
            "instructions": SERVER_INSTRUCTIONS
        }),
    )
}

// ── Tool registry ─────────────────────────────────────────────────────────────

/// Capability tier for a tool — mirrors the trust/capability model used in the
/// MCP annotation hints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolTier {
    /// Read-only, idempotent query — no side effects.
    ReadOnly,
    /// Modifies app state but is not destructive (can be undone).
    Modifier,
    /// Destructive or blocking — requires explicit human intent.
    Destructive,
}

/// A single MCP tool definition, structured so the registry is data-driven and
/// each entry self-documents.  Serialised to JSON by `tool_list()`.
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema object describing the tool's parameters.
    pub input_schema: Value,
    /// Optional MCP annotation block (title, hints).
    pub annotations: Option<Value>,
    /// Capability tier — drives `readOnlyHint` / `destructiveHint` defaults and
    /// lets tests validate that every tool is correctly classified.
    pub tier: ToolTier,
}

impl ToolDef {
    /// Serialise this definition into the JSON shape expected by MCP clients.
    pub fn to_json(&self) -> Value {
        let mut obj = json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        });
        if let Some(ann) = &self.annotations {
            obj["annotations"] = ann.clone();
        }
        obj
    }
}

// ── In-process conversation store ─────────────────────────────────────────────
//
// A lightweight, append-only message log keyed by session ID.  The Rust layer
// owns the authoritative in-process store; the TypeScript layer mirrors it for
// UI display.  Sessions are isolated: appending to session A never touches B.
//
// Disk persistence: after every append, the session is serialised to
// `~/.mdopener/sessions/{sessionId}.json` so history survives an app restart.
// Reads on `get_conversation_context` load from disk when the in-process store
// is empty (cold start / process restart scenario).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// A single message in a conversation session.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConversationMessage {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// "agent" | "human" | "system"
    pub role: String,
    pub content: String,
    /// Document paths that were open / cited when this message was produced.
    #[serde(rename = "citedDocs")]
    pub cited_docs: Vec<String>,
    #[serde(rename = "timestampMs")]
    pub timestamp_ms: u64,
}

/// Per-session message log held in memory.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct SessionLog {
    pub messages: Vec<ConversationMessage>,
}

/// Global in-process store: sessionId → SessionLog.
fn conversation_store() -> &'static Mutex<HashMap<String, SessionLog>> {
    static STORE: OnceLock<Mutex<HashMap<String, SessionLog>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Maximum messages kept per session in the in-process store.
pub const MAX_MESSAGES_PER_SESSION: usize = 200;

static SESSIONS_DIR_OVERRIDE: OnceLock<std::path::PathBuf> = OnceLock::new();

/// The error when the home directory (which holds `~/.mdopener`) cannot be
/// found. It used to be "Cannot determine home directory" and nothing more;
/// it now names the setting to fix. [`app_unreachable`] matches its first
/// sentence.
#[cfg(not(windows))]
pub const NO_HOME_DIR: &str = "Cannot determine home directory. Set HOME to your home \
    folder in the environment of the agent that runs mdopener-mcp, then restart that agent.";
#[cfg(windows)]
pub const NO_HOME_DIR: &str = "Cannot determine home directory. Check that your Windows \
    user profile folder exists and that you are signed in to it, then restart the agent \
    that runs mdopener-mcp.";

/// `<home>/.mdopener/<name>`, or [`NO_HOME_DIR`] when there is no home.
#[doc(hidden)]
pub fn mdopener_file_in(
    home: Option<std::path::PathBuf>,
    name: &str,
) -> Result<std::path::PathBuf, String> {
    home.map(|h| h.join(".mdopener").join(name))
        .ok_or_else(|| NO_HOME_DIR.to_string())
}

/// Keep session files in `dir` instead of `~/.mdopener/sessions` for the rest
/// of this process. Tests use it to stay off the real home directory without
/// mutating `HOME` while other test threads read it. Returns `false` (and
/// changes nothing) when a directory was already set.
#[doc(hidden)]
pub fn set_sessions_dir(dir: std::path::PathBuf) -> bool {
    SESSIONS_DIR_OVERRIDE.set(dir).is_ok()
}

/// Return the directory where session JSON files are persisted.
pub fn sessions_dir() -> Option<std::path::PathBuf> {
    if let Some(dir) = SESSIONS_DIR_OVERRIDE.get() {
        return Some(dir.clone());
    }
    dirs::home_dir().map(|h| h.join(".mdopener").join("sessions"))
}

/// Path for a specific session's on-disk JSON file.
///
/// The mapping is injective: ASCII letters, digits, `-` and `_` are kept
/// (so ids that were already file-name safe keep their file), and every other
/// byte of the UTF-8 id is written as `%XX`. `%` itself is escaped, so `a.b`
/// (`a%2Eb.json`) and `a_b` (`a_b.json`) no longer share a file, and no id
/// can produce a separator, `..` or a dotfile.
pub fn session_file_path(session_id: &str) -> Option<std::path::PathBuf> {
    let safe = session_file_stem(session_id);
    sessions_dir().map(|d| d.join(format!("{safe}.json")))
}

/// The session file's name without `.json` (see [`session_file_path`]).
fn session_file_stem(session_id: &str) -> String {
    let mut safe = String::with_capacity(session_id.len());
    for b in session_id.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            safe.push(b as char);
        } else {
            safe.push_str(&format!("%{b:02X}"));
        }
    }
    safe
}

/// Longest session file stem the conversation tools accept. File systems
/// cap a name at 255 bytes, and the temp file a save writes first adds
/// `.json` and a `.<pid>-<seq>.tmp` suffix of up to 36 bytes to the stem.
pub const MAX_SESSION_FILE_STEM: usize = 200;

/// Largest session file the conversation tools read: the 16 MiB a document
/// may be ([`MAX_DOCUMENT_BYTES`]). A session file was read whole however
/// large it was (another process, or a hand edit, can make it any size), so
/// one `get_conversation_context` could pull gigabytes into memory. Appends
/// drop the oldest messages to keep the file under it (see
/// [`fit_session_log`]), so a log this server writes is always readable.
pub const MAX_SESSION_FILE_BYTES: u64 = MAX_DOCUMENT_BYTES;

/// Read a session file, refusing one larger than [`MAX_SESSION_FILE_BYTES`]
/// (before reading it, and if it grows while read) with a message that says
/// how large it is and what to do.
fn read_session_file(path: &std::path::Path) -> std::io::Result<String> {
    use std::io::Read as _;
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    let too_large = |len: u64| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "it is {:.1} MiB, more than the {} MiB a session file may be, so it was \
                 not read",
                len as f64 / (1024.0 * 1024.0),
                MAX_SESSION_FILE_BYTES / (1024 * 1024)
            ),
        )
    };
    if meta.len() > MAX_SESSION_FILE_BYTES {
        return Err(too_large(meta.len()));
    }
    let mut text = String::new();
    std::fs::File::open(path)?
        .take(MAX_SESSION_FILE_BYTES + 1)
        .read_to_string(&mut text)?;
    if text.len() as u64 > MAX_SESSION_FILE_BYTES {
        return Err(too_large(text.len() as u64));
    }
    Ok(text)
}

/// Drop the oldest messages of `log` until it serialises (as
/// [`persist_session`] writes it) within [`MAX_SESSION_FILE_BYTES`]. Returns
/// how many were dropped; an error when even the newest message alone is too
/// large.
fn fit_session_log(log: &mut SessionLog) -> Result<usize, String> {
    let mut dropped = 0;
    loop {
        let len = serde_json::to_string_pretty(log)
            .map_err(|e| format!("Serialisation error: {e}"))?
            .len() as u64;
        if len <= MAX_SESSION_FILE_BYTES {
            return Ok(dropped);
        }
        if log.messages.len() <= 1 {
            return Err(format!(
                "the message is too large: the session file would be {:.1} MiB, more \
                 than the {} MiB a session file may be",
                len as f64 / (1024.0 * 1024.0),
                MAX_SESSION_FILE_BYTES / (1024 * 1024)
            ));
        }
        // Drop about the share of messages that is over, at least one, and
        // never the newest.
        let n = log.messages.len() as u64;
        let excess = len - MAX_SESSION_FILE_BYTES;
        let cut =
            (excess.saturating_mul(n).div_ceil(len) as usize).clamp(1, log.messages.len() - 1);
        log.messages.drain(..cut);
        dropped += cut;
    }
}

/// The file name earlier builds used: every character other than an
/// alphanumeric, `-` or `_` became `_`, so `a.b` and `a_b` shared `a_b.json`.
/// Only read, as a fallback, so that history saved before the injective
/// mapping stays reachable.
fn legacy_session_file_path(session_id: &str) -> Option<std::path::PathBuf> {
    let safe: String = session_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    sessions_dir().map(|d| d.join(format!("{safe}.json")))
}

/// What to do about a session file that cannot be read or parsed.
const SESSION_FILE_NEXT_STEP: &str =
    "use a new `session_id`, or move the file aside and call again";

/// Load `session_id`'s log from disk, keeping only its own messages. On a
/// case-insensitive file system ids that differ only in case (`Plan`, `plan`)
/// still share a file; their messages are told apart by `session_id`.
/// Returns the log and whether the file also held another session's messages.
///
/// When the session has no file of its own yet, its messages are read from
/// the legacy file name (filtered the same way, since that file may be shared
/// with other ids). The next append writes them to the session's own file
/// and leaves the legacy file untouched.
///
/// `Ok(None)` when the session has no file; an error when its own file
/// exists but cannot be read or parsed (it is then never overwritten).
fn load_own_session(session_id: &str) -> Result<Option<(SessionLog, bool)>, String> {
    let own = |mut log: SessionLog| {
        let before = log.messages.len();
        log.messages.retain(|m| m.session_id == session_id);
        let foreign = log.messages.len() != before;
        (log, foreign)
    };
    let Some(path) = session_file_path(session_id) else {
        return Ok(None);
    };
    if path.exists() {
        // Each failure names the file and the way out: an unreadable or
        // unparseable file used to end at the OS or serde text.
        let text = read_session_file(&path).map_err(|e| {
            format!(
                "Cannot read {}: {e}; {SESSION_FILE_NEXT_STEP}",
                path.display()
            )
        })?;
        return parse_session_log(&text)
            .map(|log| Some(own(log)))
            .map_err(|e| {
                format!(
                    "{} is not a session file: {e}; {SESSION_FILE_NEXT_STEP}",
                    path.display()
                )
            });
    }
    let Some(legacy) = legacy_session_file_path(session_id) else {
        return Ok(None);
    };
    if legacy == path {
        return Ok(None);
    }
    let Some(log) = read_session_file(&legacy)
        .ok()
        .and_then(|text| parse_session_log(&text).ok())
    else {
        return Ok(None);
    };
    Ok(Some((own(log).0, false)))
}

/// Parse a session file: this server's `{"messages":[…]}`, or the bare
/// array of messages that earlier builds of the desktop app wrote to the same
/// directory (src-tauri/src/ipc.rs, which now writes this server's format).
pub fn parse_session_log(text: &str) -> Result<SessionLog, String> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum SessionFile {
        Log(SessionLog),
        Bare(Vec<ConversationMessage>),
    }
    match serde_json::from_str::<SessionFile>(text).map_err(|e| e.to_string())? {
        SessionFile::Log(log) => Ok(log),
        SessionFile::Bare(messages) => Ok(SessionLog { messages }),
    }
}

/// Hold the sessions directory's lock file (`.lock`) for a read-modify-write
/// of a session file. The desktop app takes the same lock when it persists a
/// session, so neither process writes a stale copy over the other's appends.
fn lock_sessions_dir() -> Result<std::fs::File, String> {
    let dir = sessions_dir().ok_or(NO_HOME_DIR)?;
    create_private_dir(&dir)?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(".lock"))
        .map_err(|e| format!("Cannot open the sessions lock: {e}"))?;
    lock.lock()
        .map_err(|e| format!("Cannot lock {}: {e}", dir.display()))?;
    Ok(lock)
}

/// Persist `log` to `~/.mdopener/sessions/{session_id}.json`, creating the
/// directory if it does not exist. The persisted log is what every reader
/// (another server process, this one after a restart) sees, so a failed
/// write is an error for the caller to report.
pub fn persist_session(session_id: &str, log: &SessionLog) -> Result<(), String> {
    let path = session_file_path(session_id).ok_or(NO_HOME_DIR)?;
    if let Some(dir) = path.parent() {
        create_private_dir(dir)?;
    }
    let json =
        serde_json::to_string_pretty(log).map_err(|e| format!("Serialisation error: {e}"))?;
    // Write a sibling temp file and rename it into place. Other server
    // processes re-read this file on every get and append, and an in-place
    // write lets them read a truncated log, fail to parse it, and write their
    // own copy back over every message they did not see.
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut tmp = path.clone().into_os_string();
    tmp.push(format!(".{}-{seq}.tmp", std::process::id()));
    let tmp = std::path::PathBuf::from(tmp);
    let written = write_private_file(&tmp, json.as_bytes())
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("Cannot write {}: {e}", path.display()));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Create the sessions directory if needed and make it owner-only (`0700`
/// on Unix). Session files hold the conversation (agent actions, human
/// verdicts, cited paths); they used to be created `0644` in a `0755`
/// directory, readable by every local user, unlike the `0600` IPC token and
/// `mdopen -` temp files. An existing directory (created by an earlier build
/// or by the app) is tightened too.
fn create_private_dir(dir: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Cannot make {} private: {e}", dir.display()))?;
    }
    Ok(())
}

/// Write `bytes` to a new file at `path`, readable by this user only (`0600`
/// on Unix) from the moment it is created.
fn write_private_file(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(path)?.write_all(bytes)
}

/// Load a session log from disk.  Returns `None` when the file does not exist
/// or cannot be parsed.
pub fn load_session_from_disk(session_id: &str) -> Option<SessionLog> {
    let path = session_file_path(session_id)?;
    let text = read_session_file(&path).ok()?;
    parse_session_log(&text).ok()
}

/// Append a message to the in-process store and persist to disk.
/// Returns the appended message, or an error string.
pub fn store_append_message(
    session_id: &str,
    role: &str,
    content: &str,
    cited_docs: Vec<String>,
) -> Result<ConversationMessage, String> {
    append_message(session_id, role, content, cited_docs).map(|(msg, _)| msg)
}

/// [`store_append_message`] that also returns how many of the oldest
/// messages were dropped to keep the session file within
/// [`MAX_SESSION_FILE_BYTES`].
fn append_message(
    session_id: &str,
    role: &str,
    content: &str,
    cited_docs: Vec<String>,
) -> Result<(ConversationMessage, usize), String> {
    let role = role.trim();
    match role {
        "agent" | "human" | "system" => {}
        other => {
            return Err(format!(
                "`role` must be 'agent', 'human', or 'system', got '{other}'"
            ))
        }
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    // Millisecond timestamps repeat when an agent saves twice in quick
    // succession, so a per-process sequence number keeps ids unique.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // Each path once, in the order given: a path cited twice in one message
    // used to be stored and returned twice.
    let mut seen = std::collections::HashSet::new();
    let cited_docs: Vec<String> = cited_docs
        .into_iter()
        .filter(|d| seen.insert(d.clone()))
        .collect();
    let msg = ConversationMessage {
        id: format!("msg-{ts}-{:08x}-{seq}", std::process::id()),
        session_id: session_id.to_string(),
        role: role.to_string(),
        content: content.trim().to_string(),
        cited_docs,
        timestamp_ms: ts,
    };

    let mut store = conversation_store()
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    let _dir_lock = lock_sessions_dir().map_err(|e| format!("Message not saved: {e}"))?;
    // Continue the persisted log, re-read on every append: another server
    // process (a second agent, or this agent after a restart) or the app may
    // have appended since this process cached it, and writing the cached copy
    // back would drop those messages.
    let on_disk = load_own_session(session_id).map_err(|e| format!("Message not saved: {e}"))?;
    let fresh = match on_disk {
        Some((_, true)) => {
            let path = session_file_path(session_id)
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            return Err(format!(
                "Session file {path} also holds another session's messages (ids that \
                 differ only in case share a file on this file system); use a different \
                 `session_id`."
            ));
        }
        Some((disk, false)) => Some(disk),
        None => None,
    };
    let mut log = match fresh {
        Some(disk) => disk,
        None => store.get(session_id).cloned().unwrap_or_default(),
    };
    log.messages.push(msg.clone());

    // Bound the in-process store.
    if log.messages.len() > MAX_MESSAGES_PER_SESSION {
        let excess = log.messages.len() - MAX_MESSAGES_PER_SESSION;
        log.messages.drain(..excess);
    }
    // And bound the file, so every reader can read what was written.
    let dropped = fit_session_log(&mut log).map_err(|e| format!("Message not saved: {e}"))?;

    // Only a log that reached disk replaces the cached one, so a failed
    // write leaves no unsaved message behind.
    persist_session(session_id, &log)
        .map_err(|e| format!("Message not saved to the session file: {e}"))?;
    store.insert(session_id.to_string(), log);
    Ok((msg, dropped))
}

/// Retrieve the last `n` messages for `session_id`.
/// If the in-process store is empty for this session, attempt to load from disk
/// (handles cold-start / process-restart scenarios).
pub fn store_get_context(session_id: &str, n: usize) -> Result<Vec<ConversationMessage>, String> {
    let mut store = conversation_store().lock().map_err(|e| {
        format!(
            "the in-process conversation store is unusable after an earlier failure \
             ({e}); restart mdopener-mcp (reconnect it in your MCP client)"
        )
    })?;

    // The persisted log is authoritative (other processes append to it); the
    // in-process copy only answers when it cannot be read. With no copy, an
    // unreadable file (one past MAX_SESSION_FILE_BYTES, say) is an error: an
    // empty list would claim the session has no messages.
    match load_own_session(session_id) {
        Ok(Some((log, _))) => {
            store.insert(session_id.to_string(), log);
        }
        Ok(None) => {}
        Err(e) if !store.contains_key(session_id) => return Err(e),
        Err(_) => {}
    }

    let messages = store
        .get(session_id)
        .map(|log| {
            let msgs = &log.messages;
            let start = msgs.len().saturating_sub(n);
            msgs[start..].to_vec()
        })
        .unwrap_or_default();

    Ok(messages)
}

/// The canonical, data-driven tool registry.  Adding a new tool here
/// automatically includes it in `tools/list` responses and in the
/// `list_ai_actions` discovery tool — no other wiring needed.
///
/// Order is the `tools/list` order, which clients show and agents read top
/// down: the destructive tools (`ToolTier::Destructive`, which replace the
/// whole document) come last, after every read-only and targeted tool, so an
/// agent meets `edit_document` before `replace_document` and `set_content`.
pub fn tool_registry() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "open_file",
            description: "Open a Markdown file in Ashlr MD. Launches the app if it is not already running (through the mdopener:// URL scheme). Only Markdown documents (.md, .markdown, .mdown, .mkd, .mdx) that are not dotfiles can be opened, and a file that does not exist is refused. Returns { opened, response } once the running app's window has opened the file, or { opened, method: 'url-scheme' } when the URL scheme was handed to the OS to launch the app, with confirmed: false and a note when the launcher had not finished in time.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Path to the Markdown file to open (absolute, or relative to this server's working directory, not the app's). The result's `opened` is the absolute path."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["read", "edit"],
                        "description": "View to show the document in. Omit to keep the window's current view (a document already open in a tab keeps its own; an app this call launches starts in 'read')."
                    }
                },
                "required": ["path"]
            }),
            // Without annotations a client must assume the MCP defaults,
            // destructiveHint and openWorldHint true, for a tool that only
            // opens a local file in a view.
            annotations: Some(json!({
                "title": "Open File",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "get_current_content",
            description: "Return the path and full Markdown content of the document currently open in Ashlr MD, as { path, content }. `path` is null for an unsaved document. With no document open this is an error (isError: true, \"No document is open in Ashlr MD. Open one first (open_file).\"), as for mdopener://current (-32002 there, same message); export_text and export_metadata without `path` are errors too, but theirs says to pass `path` instead (\"No document is open in Ashlr MD; pass `path` to read a file.\"). The app reports an unsaved document that is still empty the same way, so an error here never hides content.",
            input_schema: json!({ "type": "object", "properties": {} }),
            annotations: Some(json!({
                "title": "Get Current Content",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })),
            tier: ToolTier::ReadOnly,
        },
        ToolDef {
            name: "list_recent",
            description: "Return the recently opened files, most recent first, as [{ path, fileName, openedAt }] (openedAt in milliseconds since the Unix epoch). Needs Ashlr MD running (the app keeps the list): this tool does not start it, so with the app closed it is an error, and open_file starts the app.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": LIST_RECENT_MAX,
                        "description": "Maximum number of entries to return, a whole number from 1 to 200 (a value outside that range is refused, not clamped). Defaults to 10. The app keeps at most 12 recent files."
                    }
                }
            }),
            annotations: Some(json!({
                "title": "List Recent Files",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })),
            tier: ToolTier::ReadOnly,
        },
        ToolDef {
            name: "export",
            description: "Export the currently open document (an error when none is open). With `output_path` (html, docx or epub) the app writes that file without a dialog and the call returns once it exists, with its size, or with the app's error as soon as the export fails; the document must be shown in Read view (from Edit or Source view the export is refused, saying to call open_file with its path and mode 'read' first). Without `output_path` the app opens its export dialog and the call returns at once. pdf always goes through the system print dialog, so it takes no `output_path`. Exports use the app's current theme. Returns { ok, format, path, bytes } once the file is written (`path` absolute, `bytes` its size), or { ok, format, dialog: true } when the dialog was opened. A file not written within 30 s is an error, and so is a second headless export sent while one is being written (retry once it finishes).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "format": {
                        "type": "string",
                        "enum": EXPORT_FORMATS,
                        "description": "Export format."
                    },
                    "output_path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Where to write the export (html, docx or epub only), with the format's extension (.html/.htm, .docx, .epub). Relative paths resolve against this server's working directory; the directory must exist."
                    }
                },
                "required": ["format"]
            }),
            annotations: Some(json!({
                "title": "Export Document",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "request_review",
            description: "Surface a Markdown document to the human for review in Ashlr MD and BLOCK until they Approve, Request changes or Dismiss, then return { verdict, reviewId, comments } (verdict approved, changes_requested, dismissed, timeout when the panel's `timeout_ms` window closes undecided, or superseded). One call blocks at most `wait_ms` (default 50000 ms, below the 60 s request timeout of common MCP clients): if the human has not decided by then it returns { status: 'pending', reviewId }, and calling again with that `review_id` keeps waiting on the same review. The panel shows one review at a time: a newer review replaces this one, which then ends at once with verdict `superseded` (request it again if it still needs sign-off). Use this for explicit human sign-off on agent-generated plans, diffs, or docs before proceeding. Needs Ashlr MD running: this tool does not start it, so with the app closed call open_file first.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "minLength": 1, "description": "Path to the Markdown file to review (absolute, or relative to this server's working directory)." },
                    "content": { "type": "string", "minLength": 1, "description": "Inline Markdown to review, if no file path is given; an empty or whitespace-only string is refused." },
                    "blocking": { "type": "boolean", "description": "If false, register the review and return { status: 'pending', reviewId } at once; call again with that review_id to wait for the verdict. With review_id, false returns the review's current state (verdict, or pending) at once instead of waiting. Defaults to true." },
                    "timeout_ms": { "type": "integer", "minimum": REVIEW_MIN_TIMEOUT_MS, "maximum": REVIEW_MAX_TIMEOUT_MS, "description": "How long the human has to decide (the review panel's window), in milliseconds. Default 300000 (5 min). Must be between 5000 and 600000; a value outside that range is refused, not clamped." },
                    "wait_ms": { "type": "integer", "minimum": REVIEW_MIN_WAIT_MS, "maximum": REVIEW_MAX_WAIT_MS, "description": "Max milliseconds this call blocks before returning { status: 'pending', reviewId }. Default 50000, below the 60 s request timeout of common MCP clients. Must be between 1000 and 600000; a value outside that range is refused, not clamped." },
                    "review_id": { "type": "string", "minLength": 1, "description": "Keep waiting on a review a previous call returned as pending, instead of registering a new one; an empty or blank id is refused. `path`, `content` and `timeout_ms` may be resent unchanged but cannot change the review: one that differs from what the review was requested with is refused. For a review this server did not register (it was restarted) they cannot be compared, and the result lists them as `ignored`." }
                },
                "anyOf": [{ "required": ["path"] }, { "required": ["content"] }, { "required": ["review_id"] }]
            }),
            annotations: Some(json!({
                "title": "Request Human Review",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "get_user_annotations",
            description: "Return the human's latest review verdict, comments, and task-checkbox states for a document, as { path, verdict, comments, late, tasks: [{ text, checked }], tasksNote?, appRunning?, appAuthFailed?, note? }. `verdict` and `comments` are null when no review of that file was requested; `late` is true for a verdict given after the review window closed. Tasks come from the live buffer when the file is the open document, else from the Markdown file on disk (none for other files); `tasksNote` says why the tasks of a file that could not be read are empty. Works without the app: when Ashlr MD is not running the tasks are read from the file on disk, `verdict` and `comments` are null (the app holds reviews only while it runs), and the result adds `appRunning: false` and a `note` saying so. When the app refuses this server's token (HTTP 401: a stale ~/.mdopener/ipc-token, or another instance on the port), the tasks are read from disk the same way and the result has `appAuthFailed: true` and a `note` saying how to fix it.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "minLength": 1, "description": "Path to the Markdown file (absolute, or relative to this server's working directory)." }
                },
                "required": ["path"]
            }),
            annotations: Some(json!({
                "title": "Get User Annotations",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })),
            tier: ToolTier::ReadOnly,
        },
        ToolDef {
            name: "edit_document",
            description: "Make a precise edit to the currently open document by replacing an EXACT substring. The `find` string must occur exactly once: include enough surrounding context to make it unique, or the edit is refused. Prefer this over replace_document for targeted changes. Returns { ok: true, replaced: 1 } once the window has applied the edit (and written it to disk, with `save: true`). Refused (isError, document unchanged) when no document is open (\"No document is open in Ashlr MD; open one first (open_file).\", as set_content says), when `find` is not found, when it is not unique (the error gives the match count), when `path` is not the open document, when the window does not answer within 4 s, or when two edits are already waiting on the app (retry in a moment); with `save: true`, a failed save, or a document with no file yet, is an error saying the edit was applied but not saved.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "find": { "type": "string", "minLength": 1, "description": "The exact text to replace, not empty. Must appear exactly once in the document." },
                    "replace": { "type": "string", "description": "The replacement text." },
                    "save": { "type": "boolean", "description": "Save to disk after editing. Defaults to false." },
                    "path": { "type": "string", "minLength": 1, "description": "Optional: assert this is the open document (errors if a different file is open); absolute, or relative to this server's working directory. An empty or blank (only whitespace) string is refused; omit it to skip the check." }
                },
                "required": ["find", "replace"]
            }),
            annotations: Some(json!({
                "title": "Edit Document",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "search_vault",
            description: "Semantic + full-text search across the user's vault (the watched folder) and recently opened files. Uses Ollama nomic-embed-text embeddings when available, otherwise grep. Needs the Ashlr MD app (it supplies the vault file list); when the app cannot be reached, pass `vault` to search the Markdown files under that directory on disk instead (mode 'grep-disk', or 'semantic', with `vault` and a `note` saying so), otherwise this is an error. Returns { results, mode, query?, note?, vault?, truncated?, depthCut? }; `query` (mode 'grep' only) is the query as the app searched it, `truncated: true` says the vault file list was cut short, so some files were not searched, and `depthCut: true` that the walk listing them skipped folders nested too deeply (the app enters folders at most 8 levels down, and the on-disk `vault` walk at most 16), rather than only stopping in a folder too large to read in full. `note` says in words when semantic search was tried but unavailable, so the results are keyword hits, when semantic results leave out documents whose embedding failed (saying how many), or when the app's own search refused or failed, quoting its reason. In mode 'semantic', 'grep-local' (the app's own search failed, so the vault files were grepped on disk) or 'grep-disk' results are [{ path, snippet, lineNumber, score }] sorted by score; in mode 'grep' (answered by the running app) they are [{ path, fileName, matches: [{ lineNo, snippet }] }]. Also readable as the MCP resource text://vault-search?q={query}.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1, "description": "Natural-language or keyword query (case-insensitive), not empty or only whitespace. Semantic similarity used when Ollama is available; grep fallback otherwise." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": SEARCH_MAX_RESULTS, "description": "Max number of results to return in every mode, a whole number from 1 to 200 (a value outside that range is refused, not clamped). Defaults to 50." },
                    "semantic": { "type": "boolean", "description": "Force semantic mode (true) or grep mode (false). Omit to auto-detect via Ollama availability." },
                    "vault": { "type": "string", "minLength": 1, "description": "Optional directory (absolute, or relative to the server's working directory) searched on disk when Ashlr MD is not running. Only Markdown files that are not dotfiles, outside hidden folders, node_modules and target, are read; a hidden folder as `vault` is refused. Ignored while the app is reachable." }
                },
                "required": ["query"]
            }),
            annotations: Some(json!({
                "title": "Search Vault",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })),
            tier: ToolTier::ReadOnly,
        },
        ToolDef {
            name: "present_document",
            description: "Open a document (if a path is given) and switch Ashlr MD into a distraction-free, full-screen reading presentation, ideal for showing the human a finished result. Returns { ok, path } once the window has presented it. A `path` must be a Markdown document that is not a dotfile, and one that does not exist is refused; without `path` the open document is presented, an error when none is open. Needs Ashlr MD running: this tool does not start it, so with the app closed call open_file first.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "minLength": 1, "description": "Optional path to the Markdown file to open before presenting (absolute, or relative to this server's working directory). Omit to present the current document." }
                }
            }),
            annotations: Some(json!({
                "title": "Present Document",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "list_ai_actions",
            description: "Return the AI transform actions available in Ashlr MD (explain, summarize, rewrite, etc.). Each entry includes the action id, label, icon, scope, and the system+user prompt templates it uses. Templates read the selection (or, for scope 'document', the whole document) as {text}; an action whose templates also take {arg} has an `argument` field saying what {arg} is (the target language for translate). Returns { actions: [{ id, label, shortLabel, icon, scope, systemPrompt, userPromptTemplate, argument? }], count }; with include_prompts false, each action leaves out systemPrompt and userPromptTemplate. Agents can call this to discover what AI operations the editor supports before composing a workflow. Tip: combine with search_vault (semantic search) to find relevant documents before applying an AI action.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "include_prompts": {
                        "type": "boolean",
                        "description": "Whether to include the full system/user prompt templates. Defaults to true."
                    }
                }
            }),
            annotations: Some(json!({
                "title": "List AI Actions",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })),
            tier: ToolTier::ReadOnly,
        },
        ToolDef {
            name: "get_conversation_context",
            description: "Return the last N messages of a session's conversation memory store (oldest first), plus the distinct document paths those messages cite (`recentDocs`, most recently cited first, each path once; within one message, in the order it lists them). Use this at the start of a multi-turn workflow to recover prior context (what edits were made, which docs were open, and what the human approved) before continuing. Returns { sessionId, messages: [{ id, sessionId, role, content, citedDocs, timestampMs }], count, recentDocs } (timestampMs in milliseconds since the Unix epoch); `messages` is empty when the session has no messages yet. A session file larger than 16 MiB is not read (an error saying how large it is).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "description": "The session identifier previously passed to save_conversation_message. Required."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_MESSAGES_PER_SESSION,
                        "description": "Maximum number of messages to return: the most recent N, in chronological order. A whole number from 1 to 200 (a value outside that range is refused, not clamped). Defaults to 20."
                    }
                },
                "required": ["session_id"]
            }),
            annotations: Some(json!({
                "title": "Get Conversation Context",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })),
            tier: ToolTier::ReadOnly,
        },
        ToolDef {
            name: "save_conversation_message",
            description: "Append an agent action or human verdict into the session's persistent memory store so future calls to get_conversation_context can retrieve it. Call this after every significant agent action (edit, export, review result) and after the human provides feedback. Messages survive app restarts via disk persistence at ~/.mdopener/sessions/{session_id}.json (the id encoded for a file name). The file is kept within 16 MiB: when a message would take it past that, the oldest messages are dropped and the result says how many (`dropped`, `note`). Returns { ok, messageId, sessionId, role, timestampMs, dropped?, note? }; a message that cannot be written to disk is not saved and is an error.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Session identifier. Use a stable ID per multi-turn workflow (e.g. the review ID, or a UUID the agent generates at the start of the session). At most 200 bytes once encoded for its file name (letters, digits, `-` and `_` count one byte, other bytes three)."
                    },
                    "role": {
                        "type": "string",
                        "enum": ["agent", "human", "system"],
                        "description": "'agent' for actions taken by the AI, 'human' for verdicts/comments from the user, 'system' for internal bookkeeping (e.g. document path at session start)."
                    },
                    "content": {
                        "type": "string",
                        "minLength": 1,
                        "description": "The message text, not empty or only whitespace. For agent messages describe the action taken. For human messages include their verdict and any comments."
                    },
                    "cited_docs": {
                        "type": "array",
                        "items": { "type": "string", "minLength": 1 },
                        "description": "Optional list of document paths that were open or referenced when this message was produced (absolute, or relative to this server's working directory, which is resolved to an absolute path when saved). An empty or blank path is refused; a path given twice is saved once."
                    }
                },
                "required": ["session_id", "role", "content"]
            }),
            annotations: Some(json!({
                "title": "Save Conversation Message",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "diff_documents",
            description: "Compare two Markdown documents and return a unified diff with line numbers. Agents use this to review what changed in a file between edits, between vault versions, or to inspect the delta before applying a patch. Returns { diff, hunks, added, removed, path_a, path_b }: `hunks` is the number of change hunks, `added` and `removed` the number of lines added and removed, `path_a` and `path_b` the absolute paths read, and `diff` an empty string (with all three counts 0) when the documents are identical. Only Markdown files (.md, .markdown, .mdown, .mkd, .mdx) that are not dotfiles are read.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path_a": { "type": "string", "minLength": 1, "description": "Path to the first (original) document (absolute, or relative to this server's working directory)." },
                    "path_b": { "type": "string", "minLength": 1, "description": "Path to the second (modified) document (absolute, or relative to this server's working directory)." },
                    "context_lines": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": DIFF_MAX_CONTEXT_LINES,
                        "description": "Number of unchanged context lines surrounding each change hunk, a whole number from 0 to 10000 (a value outside that range is refused, not clamped). Defaults to 3."
                    }
                },
                "required": ["path_a", "path_b"]
            }),
            annotations: Some(json!({
                "title": "Diff Documents",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })),
            tier: ToolTier::ReadOnly,
        },
        ToolDef {
            name: "edit_canvas",
            description: "Mutate a JSON Canvas (.canvas) file by applying one or more typed edit operations (move/resize nodes, edit text/link/group-label content, set node colour, add/delete nodes and edges, reorder edges) and write changes back to disk. The ops apply all or nothing: if any one fails, the file is left unchanged. Returns { ok, path, nodes_count, edges_count, node_ids, edge_ids, removed_edge_ids, ops_applied, saved, content }: the ids left in the canvas for follow-up ops, the edges delete_node removed with their node, `saved` whether the file was written, and `content` null once it was; with `save: false` nothing is written and `content` is the canvas JSON (a string) that would have been. Safe for remote/agent use: only operates on files ending in .canvas.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Path to the .canvas file to edit (absolute, or relative to this server's working directory)."
                    },
                    "ops": {
                        "type": "array",
                        "minItems": 1,
                        "description": "Ordered list of edit operations to apply atomically, at least one (an empty list is refused, and the file is not read or written). Each op takes only the fields its type uses (move_node: id, x, y; resize_node: id, width, height; and so on, as each field says); any other field is refused, so a move and a resize are two ops.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {
                                    "type": "string",
                                    "enum": [
                                        "move_node", "resize_node",
                                        "edit_text", "edit_link", "edit_group_label",
                                        "set_node_color",
                                        "add_node", "delete_node",
                                        "add_edge", "delete_edge",
                                        "edit_edge_label", "reorder_edges"
                                    ],
                                    "description": "Operation type."
                                },
                                "id": { "type": "string", "minLength": 1, "description": "Node or edge id (required for most ops); an empty or blank one is refused before the file is read." },
                                "x": { "type": "number", "description": "New x coordinate (move_node); a whole number is written as an integer." },
                                "y": { "type": "number", "description": "New y coordinate (move_node); a whole number is written as an integer." },
                                "width": { "type": "number", "description": "New width (resize_node); a whole number is written as an integer." },
                                "height": { "type": "number", "description": "New height (resize_node); a whole number is written as an integer." },
                                "text": { "type": "string", "description": "New text content (edit_text)." },
                                "url": { "type": "string", "description": "New URL (edit_link)." },
                                "label": { "type": "string", "description": "New group label (edit_group_label, required) or edge label (edit_edge_label; omit to clear)." },
                                "color": { "type": "string", "description": "Color preset '1' to '6' or hex '#RGB' / '#RRGGBB'; anything else is refused. Omit to clear (set_node_color)." },
                                "node": {
                                    "type": "object",
                                    "description": "Full node object to insert (add_node). Must include a non-empty string id, type ('text', 'file', 'link' or 'group'), and numbers x, y, width and height (width and height positive); a file node needs a string `file`, a link node a string `url`."
                                },
                                "edge": {
                                    "type": "object",
                                    "description": "Full edge object to insert (add_edge). Must include a non-empty string id, and non-empty fromNode and toNode naming existing nodes. Optional fromSide/toSide must be 'top', 'right', 'bottom' or 'left', fromEnd/toEnd 'none' or 'arrow', color a preset '1'-'6' or hex '#RGB' / '#RRGGBB', and label a string; anything else is refused."
                                },
                                "ids": {
                                    "type": "array",
                                    "items": { "type": "string", "minLength": 1 },
                                    "description": "Complete ordered list of all edge ids (reorder_edges); an empty or blank id is refused."
                                }
                            },
                            "required": ["type"]
                        }
                    },
                    "save": {
                        "type": "boolean",
                        "description": "Write the mutated canvas back to disk. Defaults to true; false is a dry run that writes nothing and returns the would-be canvas JSON as `content`."
                    }
                },
                "required": ["path", "ops"]
            }),
            annotations: Some(json!({
                "title": "Edit Canvas",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "stream_edit",
            description: "Preview a find/replace edit as a unified diff before committing. \
                When `preview` is true (default), returns a minimal unified diff with `preview_lines` \
                lines of context (default 5) so the agent can verify the change before applying. \
                When the find string matches multiple locations, ALL candidate diffs are returned ranked \
                by occurrence order (rank 1 = first match); the agent picks one and confirms it via \
                stream_edit_apply with its 0-based `match_index`. With preview=false the app applies the edit at once (unsaved; \
                the find string must match exactly once) and the result has applied: true, so do not \
                call stream_edit_apply afterwards. Prefer this over edit_document for large files or when the agent needs to \
                confirm correctness before committing. Returns { ok, editId, diff, candidates, matchCount, applied }: \
                `diff` is the diff of the first (or only) match, `candidates` is null for a single match and \
                otherwise [{ matchIndex, startLine, diff, rank }], and `matchCount` counts the occurrences. \
                Refused (isError, document unchanged) when no document is open \
                (\"No document is open in Ashlr MD; open one first (open_file).\", as edit_document says), \
                when `find` is not found, when `path` is not the open \
                document, with preview=false when `find` is not unique, when the window does not answer \
                within 4 s, or when two edits are already waiting on the app (retry in a moment).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "find": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Exact text to search for in the current document, not empty."
                    },
                    "replace": {
                        "type": "string",
                        "description": "Replacement text."
                    },
                    "preview": {
                        "type": "boolean",
                        "description": "When true (default), return a diff preview before applying. When false, apply immediately."
                    },
                    "preview_lines": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": STREAM_EDIT_MAX_PREVIEW_LINES,
                        "description": "Context lines on each side of the diff hunk, a whole number from 0 to 20 (a value outside that range is refused, not clamped). Defaults to 5."
                    },
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Optional: assert this is the currently open document path (errors if a different file is open); absolute, or relative to this server's working directory. An empty or blank (only whitespace) string is refused; omit it to skip the check."
                    }
                },
                "required": ["find", "replace"]
            }),
            annotations: Some(json!({
                "title": "Stream Edit (Preview + Apply)",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "stream_edit_apply",
            description: "Apply a previously previewed stream_edit. Send the same find/replace plus \
                a `match_index` (0-based, default 0) to select which occurrence to edit when the preview \
                returned multiple candidates. The edit is applied atomically against the live document. \
                Returns { ok: true, replaced: 1, matchIndex } once the window has applied it (and written \
                it to disk, with `save: true`). Refused (isError, document unchanged) when no document \
                is open (\"No document is open in Ashlr MD; open one first (open_file).\", as \
                edit_document says), when `find` is no longer in the live document, when `match_index` is past its last occurrence (the error \
                says how many there are), when `path` is not the open document, when the window does not \
                answer within 4 s, or when two edits are already waiting on the app (retry in a moment); \
                with `save: true`, a failed save, or a document with no file yet, is an error saying the \
                edit was applied but not saved.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "edit_id": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Optional: the editId of the stream_edit preview, for correlation only; an empty or blank one is refused. The app re-finds `find` in the live document and applies occurrence `match_index`."
                    },
                    "find": {
                        "type": "string",
                        "minLength": 1,
                        "description": "The exact find string from the preview request, not empty."
                    },
                    "replace": {
                        "type": "string",
                        "description": "The replacement text from the preview request."
                    },
                    "match_index": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": STREAM_EDIT_MAX_MATCH_INDEX,
                        "description": "0-based index of the candidate to apply, a whole number from 0 to 4294967295 (the app's 32-bit limit; a larger value is refused, not clamped). Defaults to 0 (first occurrence). An index past the document's last occurrence is refused by the app, saying how many there are."
                    },
                    "save": {
                        "type": "boolean",
                        "description": "Persist to disk after applying. Defaults to false."
                    },
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Optional path assertion: errors if a different file is open; absolute, or relative to this server's working directory. An empty or blank (only whitespace) string is refused; omit it to skip the check."
                    }
                },
                "required": ["find", "replace"]
            }),
            annotations: Some(json!({
                "title": "Apply Stream Edit",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "export_text",
            description: "Extract the plain text of a Markdown document. All Markdown syntax \
                (headings, bold/italic, links, images, blockquotes, horizontal rules, HTML tags) is \
                stripped while code block contents are preserved as-is. Strikethrough keeps its \
                text, table rows become tab-separated cells, and footnotes read [1]. Returns \
                { text, word_count, char_count, path? }: the extracted text, its word count, its length \
                in Unicode characters (`char_count`, not bytes: `caf\u{e9}` counts 4), and the absolute \
                path of the file read (absent for an unsaved open document). \
                Operates directly on disk; no running app \
                required. Accepts an optional path override; when omitted, reads the currently open \
                document via IPC (with nothing open, or the app not running, an error saying to pass `path`).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Path to the Markdown file (absolute, or relative to this server's working directory): .md, .markdown, .mdown, .mkd or .mdx; dotfiles and other files are refused. When omitted the currently open document is used."
                    }
                }
            }),
            annotations: Some(json!({
                "title": "Export Plain Text",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })),
            tier: ToolTier::ReadOnly,
        },
        ToolDef {
            name: "export_metadata",
            description: "Extract structural metadata from a Markdown document without the full \
                content: YAML front-matter (a subset parsed to an object: scalars, lists, lists of \
                mappings, nested mappings, `|` and `>` block scalars; an empty value is null), a \
                headings tree (level + text for \
                every ATX heading), all [[wikilinks]] found in the document, the count of embedded \
                images (`![…](…)` and `![[…]]` syntax), and the total word count, as \
                { frontmatter, headings: [{ level, text }], wikilinks, embedded_image_count, word_count, path? } \
                (`frontmatter` null without front-matter, `wikilinks` the distinct link targets sorted, \
                `path` absent for an unsaved open document). Operates directly \
                on disk; no running app required. Accepts an optional path override; when omitted, \
                reads the currently open document via IPC (with nothing open, or the app not running, an error saying to pass `path`).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Path to the Markdown file (absolute, or relative to this server's working directory): .md, .markdown, .mdown, .mkd or .mdx; dotfiles and other files are refused. When omitted the currently open document is used."
                    }
                }
            }),
            annotations: Some(json!({
                "title": "Export Metadata",
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })),
            tier: ToolTier::ReadOnly,
        },
        ToolDef {
            name: "replace_document",
            description: "Replace the ENTIRE content of the currently open document (the same operation as set_content). Use edit_document for targeted changes; use this only when rewriting the whole document. Returns { ok: true } once the window has applied the content (and written it to disk, with `save: true`). Refused (isError) when no document is open, when the window does not answer within 4 s, or when two edits are already waiting on the app (retry in a moment); with `save: true`, a failed save, or a document with no file yet, is an error saying the content was replaced but not saved.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "The new full Markdown content." },
                    "save": { "type": "boolean", "description": "Save to disk after replacing. Defaults to false." }
                },
                "required": ["content"]
            }),
            annotations: Some(json!({
                "title": "Replace Document",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Destructive,
        },
        ToolDef {
            name: "set_content",
            description: "Replace the ENTIRE content of the currently open document in Ashlr MD (the same operation as replace_document). Use edit_document for targeted changes. Returns { ok: true } once the window has applied the content (and written it to disk, with `save: true`). Refused (isError) when no document is open, when the window does not answer within 4 s, or when two edits are already waiting on the app (retry in a moment); with `save: true`, a failed save, or a document with no file yet, is an error saying the content was replaced but not saved.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The new Markdown content."
                    },
                    "save": {
                        "type": "boolean",
                        "description": "Whether to save the file to disk immediately. Defaults to false."
                    }
                },
                "required": ["content"]
            }),
            annotations: Some(json!({
                "title": "Set Content",
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Destructive,
        },
    ]
}

/// Canonical list of all tool names — used to verify dispatch coverage.
pub const ALL_TOOL_NAMES: &[&str] = &[
    "open_file",
    "get_current_content",
    "list_recent",
    "export",
    "request_review",
    "get_user_annotations",
    "edit_document",
    "search_vault",
    "present_document",
    "list_ai_actions",
    "get_conversation_context",
    "save_conversation_message",
    "diff_documents",
    "edit_canvas",
    "stream_edit",
    "stream_edit_apply",
    "export_text",
    "export_metadata",
    "replace_document",
    "set_content",
];

/// Tools that earlier builds advertised but the app never implemented: the
/// running app has no IPC route behind them (`/export/markdown-archive`,
/// `/export/canvas-graph`, `/export/batch`), so every call failed with an
/// opaque HTTP 404. They are no longer listed; a client that still calls one
/// by a cached name gets [`unavailable_tool_error`] instead of a 404.
pub const UNAVAILABLE_TOOLS: &[&str] = &[
    "export_markdown_archive",
    "export_canvas_graph",
    "batch_export_format",
];

/// The `isError` result returned for a name in [`UNAVAILABLE_TOOLS`]. It names
/// what does work today so the agent can recover without guessing.
pub fn unavailable_tool_error(id: Value, name: &str) -> Response {
    tool_error(
        id,
        format!(
            "`{name}` is not available: this version of Ashlr MD does not implement it. \
             Use `export` (pdf/docx/html/epub of the open document), `export_text`, or \
             `export_metadata` instead."
        ),
    )
}

/// Resource URI that earlier builds listed but the app never served.
pub const EXPORT_CURRENT_URI: &str = "export:current";

fn unavailable_resource_msg(uri: &str) -> String {
    format!(
        "Resource `{uri}` is not available: this version of Ashlr MD does not serve a live \
         HTML preview. Read `mdopener://current` for the Markdown, or call the `export` tool \
         with format `html` and an `output_path`."
    )
}

/// Build the `tools/list` response payload from the data-driven registry.
pub fn tool_list() -> Value {
    let tools: Vec<Value> = tool_registry().iter().map(|t| t.to_json()).collect();
    json!(tools)
}

// ── Tool dispatch ─────────────────────────────────────────────────────────────

pub fn handle_tool_call(id: Value, name: &str, args: Value, ipc: &dyn IpcClient) -> Response {
    if let Some(def) = tool_registry().iter().find(|t| t.name == name) {
        if let Err(msg) = check_tool_arguments(def, &args) {
            return Response::err(id, -32602, msg);
        }
    }
    match name {
        "open_file" => tool_open_file(id, &args, ipc),
        "get_current_content" => tool_get_content(id, ipc),
        "set_content" => tool_set_content(id, &args, ipc),
        "list_recent" => tool_list_recent(id, &args, ipc),
        "export" => tool_export(id, &args, ipc),
        "request_review" => tool_request_review(id, &args, ipc),
        "get_user_annotations" => tool_get_annotations(id, &args, ipc),
        "edit_document" => tool_edit_document(id, &args, ipc),
        "replace_document" => tool_replace_document(id, &args, ipc),
        "search_vault" => tool_search_vault(id, &args, ipc),
        "present_document" => tool_present_document(id, &args, ipc),
        "list_ai_actions" => tool_list_ai_actions(id, &args),
        "get_conversation_context" => tool_get_conversation_context(id, &args),
        "save_conversation_message" => tool_save_conversation_message(id, &args),
        n if UNAVAILABLE_TOOLS.contains(&n) => unavailable_tool_error(id, n),
        "diff_documents" => tool_diff_documents(id, &args),
        "edit_canvas" => tool_edit_canvas(id, &args),
        "stream_edit" => tool_stream_edit(id, &args, ipc),
        "stream_edit_apply" => tool_stream_edit_apply(id, &args, ipc),
        "export_text" => tool_export_text(id, &args, ipc),
        "export_metadata" => tool_export_metadata(id, &args, ipc),
        other => Response::err(id, -32602, unknown_tool_msg(other)),
    }
}

/// Arguments a tool used to take and now refuses with its own, more specific
/// message (checked in the tool), so the generic undeclared-argument check
/// lets them through.
const RETIRED_ARGUMENTS: &[(&str, &str)] = &[("export", "theme")];

/// Check `tools/call` arguments against the tool's declared `inputSchema`
/// before the tool runs. Each tool reads only the arguments it declares and
/// falls back to a default when one has the wrong JSON type, so before this
/// check a misspelled argument (`pth`, `include_prompt`) or a mistyped one
/// (`"limit": "5"`, `"include_prompts": "no"`) was silently ignored and the
/// call succeeded with defaults the agent never asked for.
///
/// Refused, with `-32602` and the argument named:
/// - `arguments` that is not an object (absent or `null` means no arguments);
/// - an argument the schema does not declare (the message lists those it does);
/// - an argument whose JSON type differs from the declared `type`, or an array
///   element whose type differs from the declared `items.type`;
/// - an integer below the declared `minimum` (a negative `limit` used to fall
///   back to the default, since the tools read it with `as_u64`);
/// - a number above the declared `maximum` (`list_recent`'s `limit`);
/// - an array with fewer elements than its declared `minItems`
///   (`edit_canvas`'s `ops`), as "`ops` must not be empty";
/// - a value outside the declared `enum`, at the top level or in a field of an
///   array element (`ops[0].type`), with the allowed values listed.
///
/// - a `required` argument that is missing, as "`name` is required" (the first
///   missing one in the schema's `required` order), and a call that gives none
///   of the alternatives of the schema's `anyOf` of `required` lists. A tool
///   used to check its own required arguments only once it reached them, so
///   `edit_canvas` without `ops` read the canvas file first, and the schema's
///   `required` list and the tool's checks could drift apart.
///
/// A `null` value counts as "not given", as the tools already treat it.
pub fn check_tool_arguments(def: &ToolDef, args: &Value) -> Result<(), String> {
    let tool = def.name;
    let no_args = serde_json::Map::new();
    let given = match args {
        Value::Null => &no_args,
        Value::Object(map) => map,
        other => {
            return Err(format!(
                "`arguments` for `{tool}` must be an object, got {}",
                json_type_phrase(other)
            ))
        }
    };
    let empty = serde_json::Map::new();
    let declared = def.input_schema["properties"].as_object().unwrap_or(&empty);
    for (key, value) in given {
        let Some(prop) = declared.get(key) else {
            if RETIRED_ARGUMENTS.contains(&(tool, key.as_str())) {
                continue;
            }
            let mut names: Vec<&str> = declared.keys().map(String::as_str).collect();
            names.sort_unstable();
            let takes = if names.is_empty() {
                "it takes no arguments".to_string()
            } else {
                format!(
                    "it takes {}",
                    names
                        .iter()
                        .map(|n| format!("`{n}`"))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            let hint = unknown_name_hint(key, value, declared, &names);
            return Err(format!(
                "Unknown argument `{key}` for `{tool}`: {takes}.{hint}"
            ));
        };
        if value.is_null() {
            continue;
        }
        if let Some(want) = prop["type"].as_str() {
            if !json_type_matches(want, value) {
                return Err(format!(
                    "`{key}` must be {}, got {}",
                    type_phrase(want),
                    json_type_phrase(value)
                ));
            }
        }
        if let Some(msg) = enum_problem(key, prop, value) {
            return Err(msg);
        }
        if let (Some(min), Some(n)) = (prop["minimum"].as_i64(), value.as_f64()) {
            if n < min as f64 {
                return Err(format!("`{key}` must be at least {min}, got {value}"));
            }
        }
        if let (Some(max), Some(n)) = (prop["maximum"].as_i64(), value.as_f64()) {
            if n > max as f64 {
                return Err(format!("`{key}` must be at most {max}, got {value}"));
            }
        }
        // JSON Schema counts characters (code points), not bytes.
        if let (Some(min), Some(text)) = (prop["minLength"].as_u64(), value.as_str()) {
            if (text.chars().count() as u64) < min {
                return Err(format!(
                    "`{key}` must be at least {min} character{} long, got {value}",
                    if min == 1 { "" } else { "s" }
                ));
            }
        }
        if let (Some(min), Some(items)) = (prop["minItems"].as_u64(), value.as_array()) {
            if (items.len() as u64) < min {
                return Err(if min == 1 {
                    format!("`{key}` must not be empty")
                } else {
                    format!(
                        "`{key}` must have at least {min} items, got {}",
                        items.len()
                    )
                });
            }
        }
        if let (Some(want), Some(items)) = (prop["items"]["type"].as_str(), value.as_array()) {
            if let Some((i, bad)) = items
                .iter()
                .enumerate()
                .find(|(_, v)| !json_type_matches(want, v))
            {
                return Err(format!(
                    "`{key}[{i}]` must be {}, got {}",
                    type_phrase(want),
                    json_type_phrase(bad)
                ));
            }
        }
        if let (Some(min), Some(items)) = (prop["items"]["minLength"].as_u64(), value.as_array()) {
            if let Some((i, bad)) = items
                .iter()
                .enumerate()
                .find(|(_, v)| v.as_str().is_some_and(|t| (t.chars().count() as u64) < min))
            {
                return Err(format!(
                    "`{key}[{i}]` must be at least {min} character{} long, got {bad}",
                    if min == 1 { "" } else { "s" }
                ));
            }
        }
        if let (Some(fields), Some(items)) =
            (prop["items"]["properties"].as_object(), value.as_array())
        {
            for (i, item) in items.iter().enumerate() {
                check_item_fields(&format!("{key}[{i}]"), &prop["items"], fields, item)?;
            }
        }
    }
    let present = |name: &str| given.get(name).is_some_and(|v| !v.is_null());
    let required_names = |schema: &Value| -> Vec<String> {
        schema["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    };
    if let Some(missing) = required_names(&def.input_schema)
        .into_iter()
        .find(|n| !present(n))
    {
        return Err(format!("`{missing}` is required"));
    }
    if let Some(alternatives) = def.input_schema["anyOf"].as_array() {
        let lists: Vec<Vec<String>> = alternatives.iter().map(required_names).collect();
        if !lists.is_empty() && !lists.iter().any(|l| l.iter().all(|n| present(n))) {
            let names: Vec<String> = lists
                .iter()
                .map(|l| {
                    l.iter()
                        .map(|n| format!("`{n}`"))
                        .collect::<Vec<_>>()
                        .join(" and ")
                })
                .collect();
            let shown = match names.split_last() {
                Some((last, rest)) if !rest.is_empty() => {
                    format!("{} or {last}", rest.join(", "))
                }
                _ => names.join(""),
            };
            return Err(format!("`{tool}` needs one of {shown}"));
        }
    }
    Ok(())
}

/// Check one element of an array argument whose `items` schema declares
/// `properties` (an `edit_canvas` op): a field it does not declare, a field of
/// the wrong JSON type (or an array field with an element of the wrong type),
/// and a missing `required` field are refused, named as `` `ops[2].x` `` so
/// the agent knows which element and field. A declared `minLength` (on the
/// field or on its array elements), `minimum` and `maximum` are checked as at
/// the top level. A field the tool reads with
/// `as_f64`/`as_str` used to be reported as missing when mistyped (`"x": "5"`
/// gave "`x` required"), or written to the canvas as given (`"color": 3`).
/// `null` counts as not given, as at the top level.
fn check_item_fields(
    at: &str,
    schema: &Value,
    fields: &serde_json::Map<String, Value>,
    item: &Value,
) -> Result<(), String> {
    let Some(given) = item.as_object() else {
        return Ok(());
    };
    for (k, v) in given {
        let Some(field) = fields.get(k) else {
            let mut names: Vec<&str> = fields.keys().map(String::as_str).collect();
            names.sort_unstable();
            let hint = unknown_name_hint(k, v, fields, &names);
            return Err(format!(
                "Unknown field `{k}` in `{at}`: it takes {}.{hint}",
                names
                    .iter()
                    .map(|n| format!("`{n}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        };
        if v.is_null() {
            continue;
        }
        if let Some(want) = field["type"].as_str() {
            if !json_type_matches(want, v) {
                return Err(format!(
                    "`{at}.{k}` must be {}, got {}",
                    type_phrase(want),
                    json_type_phrase(v)
                ));
            }
        }
        if let Some(msg) = enum_problem(&format!("{at}.{k}"), field, v) {
            return Err(msg);
        }
        // The bounds the top level checks, so a declared `minLength` on an
        // op's `id` is enforced here too and not only by the tool.
        if let (Some(min), Some(n)) = (field["minimum"].as_i64(), v.as_f64()) {
            if n < min as f64 {
                return Err(format!("`{at}.{k}` must be at least {min}, got {v}"));
            }
        }
        if let (Some(max), Some(n)) = (field["maximum"].as_i64(), v.as_f64()) {
            if n > max as f64 {
                return Err(format!("`{at}.{k}` must be at most {max}, got {v}"));
            }
        }
        if let (Some(min), Some(text)) = (field["minLength"].as_u64(), v.as_str()) {
            if (text.chars().count() as u64) < min {
                return Err(format!(
                    "`{at}.{k}` must be at least {min} character{} long, got {v}",
                    if min == 1 { "" } else { "s" }
                ));
            }
        }
        if let (Some(want), Some(elems)) = (field["items"]["type"].as_str(), v.as_array()) {
            if let Some((j, bad)) = elems
                .iter()
                .enumerate()
                .find(|(_, e)| !json_type_matches(want, e))
            {
                return Err(format!(
                    "`{at}.{k}[{j}]` must be {}, got {}",
                    type_phrase(want),
                    json_type_phrase(bad)
                ));
            }
        }
        if let (Some(min), Some(elems)) = (field["items"]["minLength"].as_u64(), v.as_array()) {
            if let Some((j, bad)) = elems
                .iter()
                .enumerate()
                .find(|(_, e)| e.as_str().is_some_and(|t| (t.chars().count() as u64) < min))
            {
                return Err(format!(
                    "`{at}.{k}[{j}]` must be at least {min} character{} long, got {bad}",
                    if min == 1 { "" } else { "s" }
                ));
            }
        }
    }
    for req in schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if given.get(req).is_none_or(Value::is_null) {
            return Err(format!("`{at}.{req}` is required"));
        }
    }
    Ok(())
}

/// A value outside the property's declared `enum`, as "`at` must be one of
/// `a`, `b`, got ...". It is the only check of `save_conversation_message`'s
/// `role` at the tool level. Where a tool function is public and called
/// directly the tool keeps its own check: `open_file`'s `mode` goes into a
/// launch URL, `export`'s `format` was exported as HTML by older apps, and
/// `store_append_message` guards `role` for its own callers. `edit_canvas`
/// keeps an unknown-op arm to close its `match`.
fn enum_problem(at: &str, prop: &Value, value: &Value) -> Option<String> {
    let allowed = prop["enum"].as_array()?;
    if allowed.contains(value) {
        return None;
    }
    let names = allowed
        .iter()
        .map(|a| match a {
            Value::String(s) => format!("`{s}`"),
            other => format!("`{other}`"),
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "`{at}` must be one of {names}, got {}",
        json_type_phrase(value)
    ))
}

fn json_type_matches(want: &str, value: &Value) -> bool {
    match want {
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        // As in JSON Schema, a number with no fractional part (`2.0`) is an
        // integer, up to 2^53 where a float still holds every whole number.
        "integer" => {
            value.is_i64()
                || value.is_u64()
                || value
                    .as_f64()
                    .is_some_and(|f| f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_992.0)
        }
        "number" => value.is_number(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn type_phrase(want: &str) -> String {
    match want {
        "integer" | "array" | "object" => format!("an {want}"),
        other => format!("a {other}"),
    }
}

fn json_type_phrase(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => format!("a boolean ({b})"),
        Value::Number(n) => format!("a number ({n})"),
        Value::String(s) => format!("a string ({s:?})"),
        Value::Array(_) => "an array".to_string(),
        Value::Object(_) => "an object".to_string(),
    }
}

/// The candidate closest to `name`: equal ignoring case, `-`/`_` and spaces,
/// or within an edit distance of 2. `None` when nothing is that close.
/// The " Did you mean `x`?" for an undeclared argument or op field `key`
/// given `value`, or "" when nothing fits. A declared field whose `enum`
/// lists `value` wins over a near spelling: `{"op": "move_node"}` was
/// answered "Did you mean `id`?" (one edit from `op`), when the agent had
/// named the op's `type` by another word.
fn unknown_name_hint(
    key: &str,
    value: &Value,
    declared: &serde_json::Map<String, Value>,
    names: &[&str],
) -> String {
    let by_value = value.as_str().and_then(|v| {
        names.iter().copied().find(|n| {
            declared[*n]["enum"]
                .as_array()
                .is_some_and(|e| e.iter().any(|x| x.as_str() == Some(v)))
        })
    });
    by_value
        .or_else(|| closest_name(key, names))
        .map(|n| format!(" Did you mean `{n}`?"))
        .unwrap_or_default()
}

fn closest_name<'a>(name: &str, candidates: &[&'a str]) -> Option<&'a str> {
    let norm = |s: &str| -> String {
        s.chars()
            .filter(|c| !matches!(c, '_' | '-' | ' '))
            .flat_map(char::to_lowercase)
            .collect()
    };
    let wanted = norm(name);
    if wanted.is_empty() {
        return None;
    }
    candidates
        .iter()
        .map(|c| (edit_distance(&wanted, &norm(c)), *c))
        .filter(|(d, _)| *d <= 2)
        .min_by_key(|(d, _)| *d)
        .map(|(_, c)| c)
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != *cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// The `-32602` message for a `tools/call` name that is not a tool: it names
/// the closest real tool when there is one, and says where the list is.
pub fn unknown_tool_msg(name: &str) -> String {
    let names: Vec<&str> = ALL_TOOL_NAMES.to_vec();
    let shown = if name.is_empty() {
        "Unknown tool: `name` is missing or blank.".to_string()
    } else {
        format!("Unknown tool: {name}.")
    };
    let hint = closest_name(name, &names)
        .map(|n| format!(" Did you mean `{n}`?"))
        .unwrap_or_default();
    format!(
        "{shown}{hint} Call tools/list for the {} tools this server provides.",
        names.len()
    )
}

// ── Tools ─────────────────────────────────────────────────────────────────────

pub fn tool_open_file(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    tool_open_file_with(id, args, ipc, &|url| {
        launch::launch_url(url, URL_LAUNCH_DEADLINE, false)
    })
}

/// How long `open_file` waits for the OS URL launcher when the app is not
/// running. Bounded so a launcher that blocks (e.g. `xdg-open` falling back to
/// a terminal browser) never wedges the MCP session.
pub const URL_LAUNCH_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// [`tool_open_file`] with the URL launcher injected, so tests never start a
/// real launcher or GUI.
pub fn tool_open_file_with(
    id: Value,
    args: &Value,
    ipc: &dyn IpcClient,
    launcher: &dyn Fn(&str) -> launch::Launch,
) -> Response {
    let raw_path = match non_blank_str(args, "path") {
        Ok(Some(p)) => p.to_string(),
        Ok(None) => return Response::err(id, -32602, "`path` is required"),
        Err(e) => return Response::err(id, -32602, e),
    };

    let mode = match args["mode"].as_str() {
        None => None,
        Some(m @ ("read" | "edit")) => Some(m),
        Some(other) => {
            return Response::err(
                id,
                -32602,
                format!("`mode` must be \"read\" or \"edit\", got {other:?}"),
            )
        }
    };

    // The path is made absolute against this server's working directory: the
    // app resolves paths against its own, unrelated cwd. A missing file is
    // left for the app to refuse ("does not exist") when it is running, and
    // refused here before the URL-scheme fallback when it is not.
    let abs = match openable_document_path(&raw_path) {
        Ok(abs) => abs,
        Err(e) => return tool_error(id, e),
    };

    // Try IPC first (app already running).
    let ipc_error = match ipc.post("/open", json!({ "path": abs, "mode": mode })) {
        // The app answers once its window has opened the document, so a
        // failure there is the agent's to see, with the window's reason.
        Ok(resp) if resp["ok"].as_bool() == Some(false) => {
            return tool_error(id, window_refusal(&resp, "open", &abs))
        }
        Ok(resp) => return tool_result(id, json!({ "opened": abs, "response": resp })),
        // The app answered but refused this server's token (HTTP 401). The
        // URL scheme would reach the same app, and a launch that failed used
        // to report it as "not running", so say why and what fixes it.
        Err(e) if app_auth_failed(&e) => return tool_error(id, APP_AUTH_FAILED_MSG.to_string()),
        // The app is running and refused the request: say why, and do not
        // retry it through the URL scheme.
        Err(e) if app_refused(&e) => return tool_error(id, e),
        // The app was reached but failed or did not answer in time. It may
        // still open the file, so a URL-scheme retry could report a false
        // success or open it twice.
        Err(e) if app_reached_but_failed(&e) => {
            return tool_error(
                id,
                // It used to stop at the IPC error, leaving the agent to
                // guess whether to retry (which may open the file twice).
                format!(
                    "Ashlr MD is running but did not confirm opening {abs}: {}. It may \
                     still open it: call get_current_content to see which document is \
                     open before calling open_file again, since a retry may open it twice.",
                    e.trim_end_matches('.')
                ),
            );
        }
        Err(e) => e,
    };

    // The app is not reachable, so nothing else will refuse a missing file:
    // the launcher would exit 0 and the open would be reported though the
    // window cannot open it.
    if !std::path::Path::new(&abs).is_file() {
        return tool_error(id, format!("Cannot open '{abs}': the file does not exist."));
    }

    // Fall back: launch / bring to front via the URL scheme, using the host
    // OS launcher (`open` on macOS, `xdg-open`/`gio open` on Linux, `start` on
    // Windows). Its stdout never reaches ours, which is the protocol channel.
    let encoded = urlencoding::encode(&abs);
    let mut url = format!("mdopener://open?path={encoded}");
    if let Some(m) = mode {
        url.push_str(&format!("&mode={m}"));
    }

    let outcome = launcher(&url);
    match &outcome {
        launch::Launch::Opened { .. } => {
            tool_result(id, json!({ "opened": abs, "method": "url-scheme" }))
        }
        launch::Launch::Pending { .. } => tool_result(
            id,
            json!({
                "opened": abs,
                "method": "url-scheme",
                "confirmed": false,
                "note": outcome.describe(),
            }),
        ),
        _ => tool_error(
            id,
            format!(
                "Could not open {abs} in Ashlr MD: the app is not running ({ipc_error}) and {}. \
                 Ask the user to start Ashlr MD (or install it from \
                 https://github.com/ashlrai/ashlr-md/releases), then call open_file again.",
                outcome.describe()
            ),
        ),
    }
}

/// The reason in an app reply of `ok: false` to `/open` or `/present`.
fn window_refusal(resp: &Value, doing: &str, what: &str) -> String {
    match resp["error"].as_str() {
        Some(e) => e.to_string(),
        None => format!("The app could not {doing} {what}."),
    }
}

/// `get_current_content`: the app's `{ path, content }`, or a tool error. With
/// no document open the app answers `{ "path": null, "content": "" }`, which
/// this tool used to return as a success, so an agent could not tell "nothing
/// open" from an empty document. It is an error now, the one
/// `mdopener://current` and `export_text` give; an empty unsaved document
/// reads the same at the IPC and is reported the same way.
pub fn tool_get_content(id: Value, ipc: &dyn IpcClient) -> Response {
    match ipc.get("/content") {
        Ok(v) if v["path"].is_null() && v["content"].as_str().is_none_or(str::is_empty) => {
            tool_error(id, NO_DOCUMENT_OPEN.to_string())
        }
        Ok(v) => tool_result(id, v),
        Err(e) => tool_error(id, app_not_running_msg(&e)),
    }
}

/// The error `get_current_content` and `mdopener://current` give when no
/// document is open in the app.
const NO_DOCUMENT_OPEN: &str = "No document is open in Ashlr MD. Open one first (open_file).";

pub fn tool_set_content(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let content = match args["content"].as_str() {
        Some(c) => c.to_string(),
        None => return Response::err(id, -32602, "`content` is required"),
    };
    let save = args["save"].as_bool().unwrap_or(false);
    post_content(id, &content, save, ipc)
}

/// POST `/content` for `set_content` and `replace_document`. The app answers
/// once the window has replaced the document, and saved it when `save` is
/// set, so a refusal (`ok: false`) is the agent's to see as a tool error.
fn post_content(id: Value, content: &str, save: bool, ipc: &dyn IpcClient) -> Response {
    match ipc.post("/content", json!({ "content": content, "save": save })) {
        Ok(v) if v["ok"].as_bool() == Some(false) => {
            let msg = v["error"]
                .as_str()
                .unwrap_or("The app could not replace the document content.");
            tool_error(id, msg.to_string())
        }
        Ok(v) => tool_result(id, v),
        Err(e) => tool_error(id, app_not_running_msg(&e)),
    }
}

/// Largest `limit` `list_recent` accepts: the cap `search_vault` and
/// `get_conversation_context` hold their `limit` to. The app keeps far fewer
/// recents (12), so no list is ever cut by this cap.
pub const LIST_RECENT_MAX: u64 = 200;

pub fn tool_list_recent(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    // A `limit` that is not a whole number from 1 to LIST_RECENT_MAX used to
    // become the default (2.5) or reach the app unchecked (0, 10^15), which
    // answered with an empty list or every recent. Omitted keeps the default.
    let limit = match &args["limit"] {
        Value::Null => 10,
        v => match whole_number_value(v).filter(|n| (1..=LIST_RECENT_MAX).contains(n)) {
            Some(n) => n,
            None => {
                return Response::err(
                    id,
                    -32602,
                    format!(
                        "`limit` must be a whole number from 1 to {LIST_RECENT_MAX}, got {v}; \
                         omit it for the default of 10"
                    ),
                )
            }
        },
    };
    match ipc.get(&format!("/recent?limit={limit}")) {
        Ok(v) => tool_result(id, v),
        Err(e) => tool_error(id, app_not_running_msg(&e)),
    }
}

/// Formats the app's export handler implements; anything else would silently
/// fall through to HTML there, so it is refused here before reaching the app.
pub const EXPORT_FORMATS: [&str; 4] = ["pdf", "docx", "html", "epub"];

/// How long `export` waits for the app to write `output_path`.
pub const EXPORT_WRITE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

/// How much longer than the write deadline a headless `/export` request is
/// read for, so the app's own answer (it waits up to 30 s for its window)
/// arrives before this server gives up on it.
pub const EXPORT_REPLY_MARGIN: std::time::Duration = std::time::Duration::from_secs(5);

pub fn tool_export(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    tool_export_with(id, args, ipc, EXPORT_WRITE_DEADLINE)
}

/// Resolve a caller path the way the agent means it: against this server's
/// working directory (the agent's), following symlinks when the path exists.
/// The app resolves relative paths against its own, unrelated working
/// directory and compares paths against its canonical open-document path, so
/// forwarding the raw string misses for `plan.md`, `./plan.md`, or `/tmp/x`
/// vs `/private/tmp/x` on macOS.
/// [`agent_path`] for a document the app is asked to open (`open_file`,
/// `present_document`, `request_review` with a path), refused unless it is a
/// Markdown document that is not a dotfile, checked like the tools that read
/// a path from disk ([`checked_document_path`]). The app shows what it opens
/// and `get_current_content` returns it, so opening `~/.ssh/id_rsa` would
/// otherwise read it. The app makes the same check. A refusal says
/// "Refusing to open", the call's own verb; [`presentable_document_path`]
/// and [`reviewable_document_path`] say "present" and "review".
pub fn openable_document_path(raw: &str) -> Result<String, String> {
    checked_document_for(&agent_path(raw), "path", Use::Open).map(|c| c.path)
}

/// [`openable_document_path`] for `present_document`, refusing in its words.
pub fn presentable_document_path(raw: &str) -> Result<String, String> {
    checked_document_for(&agent_path(raw), "path", Use::Present).map(|c| c.path)
}

/// [`openable_document_path`] for `request_review`, refusing in its words.
pub fn reviewable_document_path(raw: &str) -> Result<String, String> {
    checked_document_for(&agent_path(raw), "path", Use::Review).map(|c| c.path)
}

/// True when an IPC error is the running app refusing the request (an HTTP
/// 4xx other than 401), as opposed to the app being unreachable.
fn app_refused(err: &str) -> bool {
    err.strip_prefix("IPC server returned HTTP 4")
        .is_some_and(|rest| !rest.starts_with("01"))
}

/// True when an IPC error happened after the request reached the app: a 5xx,
/// a dropped connection, no answer within the read timeout, or a reply that is
/// not JSON. Unlike an unreachable app, retrying elsewhere is not safe.
fn app_reached_but_failed(err: &str) -> bool {
    [
        "IPC server returned HTTP 5",
        "IPC write error",
        "IPC read error",
        "IPC JSON parse error",
    ]
    .iter()
    .any(|p| err.starts_with(p))
}

/// "Cannot read {what}'{path}': ..." for a failed document read, saying "the
/// file does not exist" for a missing file, as `open_file` does. The raw OS
/// text ("No such file or directory (os error 2)") read like a fault and,
/// with the relative path the agent passed, did not say where it looked.
fn cannot_read(what: &str, path: &str, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("Cannot read {what}'{path}': the file does not exist.")
    } else {
        format!("Cannot read {what}'{path}': {e}")
    }
}

pub fn agent_path(raw: &str) -> String {
    std::fs::canonicalize(raw)
        .or_else(|_| std::path::absolute(raw))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

// The `output_path` rule is shared with the app's `/export`, which applies it
// again to whatever reaches it.
#[path = "../../../src/export_path.rs"]
mod export_path;

/// Validate and resolve `output_path` for `format`. The app writes there
/// without asking, so only a file with the format's own extension, not a
/// dotfile, in an existing directory is accepted. Errors are argument errors.
pub fn export_output_path(raw: &str, format: &str) -> Result<std::path::PathBuf, String> {
    let abs = std::path::absolute(raw).map_err(|e| format!("`output_path` '{raw}': {e}"))?;
    export_path::checked_export_path(&abs, format, "output_path")
}

/// What identifies one version of a file on disk: size and modification time
/// (the app writes a temp file and renames it over the target).
fn file_fingerprint(p: &std::path::Path) -> Option<(u64, Option<std::time::SystemTime>)> {
    let m = std::fs::metadata(p).ok()?;
    m.is_file().then(|| (m.len(), m.modified().ok()))
}

/// [`tool_export`] with the write deadline injected, so tests do not wait 30s.
pub fn tool_export_with(
    id: Value,
    args: &Value,
    ipc: &dyn IpcClient,
    write_deadline: std::time::Duration,
) -> Response {
    // check_tool_arguments refuses a `format` outside the schema enum first,
    // but this is public and called directly, and older apps exported any
    // unknown format as HTML and said ok: keep refusing it here too.
    let format = match args["format"].as_str() {
        Some(f) if EXPORT_FORMATS.contains(&f) => f.to_string(),
        Some(other) => {
            return Response::err(
                id,
                -32602,
                format!(
                    "`format` must be one of {}, got '{other}'",
                    EXPORT_FORMATS.join("/")
                ),
            )
        }
        None => return Response::err(id, -32602, "`format` is required"),
    };

    // The app renders exports in its current theme and takes no other, so a
    // `theme` (offered by earlier versions of this tool) is refused rather
    // than silently ignored.
    if !args["theme"].is_null() {
        return Response::err(
            id,
            -32602,
            "`theme` is not supported: exports use the app's current theme (switch it in the app).",
        );
    }

    // An empty `output_path` used to come back as "cannot make an empty path
    // absolute"; it is refused in the words the other tools use.
    let output_path = match non_blank_str(args, "output_path") {
        Err(e) => return Response::err(id, -32602, e),
        Ok(None) => None,
        Ok(Some(raw)) => match export_output_path(raw, &format) {
            Ok(p) => Some(p),
            Err(e) => return Response::err(id, -32602, e),
        },
    };
    let before = output_path.as_deref().and_then(file_fingerprint);

    let body = json!({
        "format": format,
        "outputPath": output_path.as_ref().map(|p| p.to_string_lossy()),
    });
    // A headless export is answered once the window has written the file, or
    // with its reason for not writing it, which can take up to the deadline.
    let sent = match output_path {
        Some(_) => ipc.post_within("/export", body, write_deadline + EXPORT_REPLY_MARGIN),
        None => ipc.post("/export", body),
    };
    match sent {
        // The app could not hand the export to its window, or the window
        // reported that the export failed: say why at once.
        Ok(resp) if resp["ok"].as_bool() == Some(false) => {
            return tool_error(id, window_refusal(&resp, "export", "the document"));
        }
        Ok(_) => {}
        Err(e) => return tool_error(id, app_not_running_msg(&e)),
    }

    let Some(out) = output_path else {
        // No destination: the app shows its export dialog to the human.
        return tool_result(id, json!({ "ok": true, "format": format, "dialog": true }));
    };

    // The app answers once the window reports the file written (an older app
    // answers before it renders), so the export only counts as done once a
    // new version of the file exists.
    let deadline = std::time::Instant::now() + write_deadline;
    loop {
        if let Some(now) = file_fingerprint(&out) {
            if Some(now) != before {
                return tool_result(
                    id,
                    json!({
                        "ok": true,
                        "format": format,
                        "path": out.to_string_lossy(),
                        "bytes": now.0,
                    }),
                );
            }
        }
        if std::time::Instant::now() >= deadline {
            return tool_error(
                id,
                format!(
                    "Ashlr MD accepted the {format} export but did not write {} within {}s. \
                     Headless export renders the Read view: call open_file with the document's \
                     path and mode 'read', check the app for an error message, then retry.",
                    out.display(),
                    write_deadline.as_secs()
                ),
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

// ── Human-review loop ─────────────────────────────────────────────────────────

/// Longest a single `request_review` call blocks by default. MCP clients
/// built on the official SDKs time a request out after 60 s, so a call that
/// blocked for the whole review window (default 5 min) failed client-side
/// and the verdict was lost. Past this the call returns `status: "pending"`
/// and the agent calls again with `review_id` to keep waiting.
pub const DEFAULT_REVIEW_WAIT_MS: u64 = 50_000;

/// The shortest and longest `wait_ms` a `request_review` call accepts.
pub const REVIEW_MIN_WAIT_MS: u64 = 1_000;
pub const REVIEW_MAX_WAIT_MS: u64 = 600_000;

/// `wait_ms` for `request_review`: [`DEFAULT_REVIEW_WAIT_MS`] when absent,
/// else a whole number of milliseconds from [`REVIEW_MIN_WAIT_MS`] to
/// [`REVIEW_MAX_WAIT_MS`]. It used to be clamped to that range in silence
/// while the schema declared `minimum: 0`, so `wait_ms: 0` (meant as "do not
/// block") blocked for a second, and a value past the range waited less
/// than asked. Anything else is refused, as `timeout_ms` is.
fn review_wait_arg(v: &Value) -> Result<u64, String> {
    if v.is_null() {
        return Ok(DEFAULT_REVIEW_WAIT_MS);
    }
    match whole_number_value(v) {
        Some(t) if (REVIEW_MIN_WAIT_MS..=REVIEW_MAX_WAIT_MS).contains(&t) => Ok(t),
        _ => Err(format!(
            "`wait_ms` must be a whole number of milliseconds between \
             {REVIEW_MIN_WAIT_MS} and {REVIEW_MAX_WAIT_MS}, got {v}; pass `blocking: false` \
             to return without waiting"
        )),
    }
}

/// Extra time a resumed `request_review` polls after its window has closed,
/// so the app's final verdict (the panel records `dismissed` at expiry) or a
/// last-second decision is still picked up before reporting `timeout`.
pub const REVIEW_RESUME_GRACE_MS: u64 = 2_000;

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// When the review window of `review_id` closes (unix ms), for ids this
/// server minted (`rev_<nanos>_<pid>_<window end>`); `None` for any other id.
pub fn review_window_end_ms(review_id: &str) -> Option<u64> {
    let parts: Vec<&str> = review_id.strip_prefix("rev_")?.split('_').collect();
    match parts.as_slice() {
        [_, _, end] => end.parse().ok(),
        _ => None,
    }
}

/// Register a review with the app (or resume one by `review_id`), then POLL
/// for the human's verdict (each poll is a fresh request well within the 5s
/// TCP timeout). Returns the verdict, `pending` when this call's wait ended
/// first, or `timeout` when the review window closed with no decision.
pub fn tool_request_review(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    tool_request_review_with(id, args, ipc, std::time::Duration::from_millis(1_500))
}

/// The shortest and longest `request_review` windows (the app refuses the
/// same range for `/review`'s `timeoutMs`).
pub const REVIEW_MIN_TIMEOUT_MS: u64 = 5_000;
pub const REVIEW_MAX_TIMEOUT_MS: u64 = 600_000;

/// `timeout_ms` for `request_review`: the default 5 minutes when absent, else
/// a whole number of milliseconds within the accepted range. Anything else is
/// refused rather than clamped or defaulted, so the agent never waits on a
/// window it did not ask for.
fn review_timeout_arg(v: &Value) -> Result<u64, String> {
    if v.is_null() {
        return Ok(300_000);
    }
    match whole_number_value(v) {
        Some(t) if (REVIEW_MIN_TIMEOUT_MS..=REVIEW_MAX_TIMEOUT_MS).contains(&t) => Ok(t),
        _ => Err(format!(
            "`timeout_ms` must be a whole number of milliseconds between \
             {REVIEW_MIN_TIMEOUT_MS} and {REVIEW_MAX_TIMEOUT_MS}, got {v}"
        )),
    }
}

/// What a review was registered with, kept by this server so a resumed call
/// (`review_id`) that also sends `path`, `content` or `timeout_ms` can be
/// checked against it. The content is kept as a hash, not the text.
#[derive(Clone, PartialEq, Debug)]
struct RegisteredReview {
    path: Option<String>,
    content: Option<u64>,
    timeout_ms: u64,
}

/// Most registered reviews remembered for that check (the oldest go first).
const MAX_REMEMBERED_REVIEWS: usize = 256;

fn registered_reviews() -> &'static Mutex<Vec<(String, RegisteredReview)>> {
    static REVIEWS: OnceLock<Mutex<Vec<(String, RegisteredReview)>>> = OnceLock::new();
    REVIEWS.get_or_init(|| Mutex::new(Vec::new()))
}

fn content_hash(content: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut h);
    h.finish()
}

fn remember_review(review_id: &str, review: RegisteredReview) {
    let mut reviews = registered_reviews()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    reviews.push((review_id.to_string(), review));
    let excess = reviews.len().saturating_sub(MAX_REMEMBERED_REVIEWS);
    reviews.drain(..excess);
}

fn remembered_review(review_id: &str) -> Option<RegisteredReview> {
    registered_reviews()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|(id, _)| id == review_id)
        .map(|(_, r)| r.clone())
}

/// For a resumed `request_review` (one with `review_id`), the review-defining
/// arguments it also sent. Resuming never re-registers, so they cannot change
/// the review. Resending the arguments of the first call is fine, so for a
/// review this server registered each one given is compared with what it was
/// registered with, and one that differs is refused (`Err`, a `-32602`
/// message naming it): an agent that changed `content` and sent the old
/// `review_id` would otherwise read the human's verdict on the old text as a
/// verdict on the new. For a review this server did not register (it was
/// restarted, or another server registered it) nothing can be compared, so the
/// call goes ahead and `Ok` lists the arguments that went unchecked, which the
/// result reports as `ignored`.
fn resumed_review_arguments(
    review_id: &str,
    args: &Value,
    timeout_ms: u64,
) -> Result<Vec<&'static str>, String> {
    let given: Vec<&'static str> = ["path", "content", "timeout_ms"]
        .into_iter()
        .filter(|k| !args[*k].is_null())
        .collect();
    if given.is_empty() {
        return Ok(given);
    }
    let Some(original) = remembered_review(review_id) else {
        return Ok(given);
    };
    let differs = |what: &str| {
        Err(format!(
            "`{what}` differs from what review `{review_id}` was requested with. A call with \
             `review_id` keeps waiting on that review as it was requested and cannot change it; \
             resend the same `path`, `content` and `timeout_ms` or leave them out, or call \
             request_review without `review_id` to request a new review."
        ))
    };
    if let Some(p) = args["path"].as_str() {
        if original.path.as_deref() != Some(agent_path(p).as_str()) {
            return differs("path");
        }
    }
    if let Some(c) = args["content"].as_str() {
        if original.content != Some(content_hash(c)) {
            return differs("content");
        }
    }
    if !args["timeout_ms"].is_null() && original.timeout_ms != timeout_ms {
        return differs("timeout_ms");
    }
    Ok(Vec::new())
}

/// [`tool_request_review`] with the poll interval injected for tests.
pub fn tool_request_review_with(
    id: Value,
    args: &Value,
    ipc: &dyn IpcClient,
    poll: std::time::Duration,
) -> Response {
    if let Err(e) = non_blank_str(args, "path") {
        return Response::err(id, -32602, e);
    }
    // An empty `content` (with no path) used to register a review of no
    // text at all, which the human could only approve or reject blind.
    // Only whitespace is no text to review either, as for
    // `save_conversation_message`'s `content`.
    if args["content"]
        .as_str()
        .is_some_and(|c| c.trim().is_empty())
    {
        return Response::err(id, -32602, "`content` must not be empty");
    }
    // An empty or blank `review_id` used to be read as absent, so a call
    // that meant to resume (`{ "review_id": "", "content": ... }`) registered
    // a new review, which replaced and so ended the pending one the agent
    // meant to wait on.
    let resume = match args["review_id"].as_str() {
        Some(r) if r.trim().is_empty() => {
            return Response::err(
                id,
                -32602,
                "`review_id` must not be empty or blank: pass the `reviewId` a pending call \
                 returned, or leave `review_id` out to request a new review",
            )
        }
        r => r.map(str::to_string),
    };
    let timeout_ms = match review_timeout_arg(&args["timeout_ms"]) {
        Ok(t) => t,
        Err(e) => return Response::err(id, -32602, e),
    };
    let wait_ms = match review_wait_arg(&args["wait_ms"]) {
        Ok(w) => w,
        Err(e) => return Response::err(id, -32602, e),
    };
    // A resumed review opens nothing, so its `path` is only compared.
    let ignored = match &resume {
        Some(r) => match resumed_review_arguments(r, args, timeout_ms) {
            Ok(ignored) => ignored,
            Err(e) => return Response::err(id, -32602, e),
        },
        None => Vec::new(),
    };
    let path = match args["path"]
        .as_str()
        .filter(|_| resume.is_none())
        .map(reviewable_document_path)
        .transpose()
    {
        Ok(p) => p,
        Err(e) => return tool_error(id, e),
    };
    let content = args["content"].as_str().map(str::to_string);
    let blocking = args["blocking"].as_bool().unwrap_or(true);

    let resumed = resume.is_some();
    let respond = |id: Value, mut out: Value| -> Response {
        if !ignored.is_empty() {
            out["ignored"] = json!(ignored);
            out["note"] = json!(format!(
                "{} not checked: this server did not register review `{}` (it was restarted, \
                 or another server registered it), so a resumed call cannot compare them with \
                 the review's and they did not change it.",
                ignored
                    .iter()
                    .map(|k| format!("`{k}`"))
                    .collect::<Vec<_>>()
                    .join(", "),
                out["reviewId"].as_str().unwrap_or("")
            ));
        }
        tool_result(id, out)
    };
    let review_id = match resume {
        Some(r) => r,
        None => {
            if path.is_none() && content.is_none() {
                return Response::err(
                    id,
                    -32602,
                    "Either `path` or `content` is required (or `review_id` to keep waiting)",
                );
            }
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as u64;
            // The id carries when the review window closes (unix ms), so a
            // resumed call can still end with `timeout` instead of waiting
            // forever on a record the app never resolves (an app that went
            // away, or one older than the `superseded` verdict).
            let window_end_ms = unix_ms() + timeout_ms;
            let review_id = format!("rev_{nanos}_{:08x}_{window_end_ms}", std::process::id());
            let post_body = json!({
                "reviewId": review_id,
                "path": path,
                "content": content,
                "timeoutMs": timeout_ms,
            });
            match ipc.post("/review", post_body) {
                // The app opens `path` before it registers the review, and
                // answers `ok: false` with the window's reason when it could
                // not, so there is no review to wait on.
                Ok(resp) if resp["ok"].as_bool() == Some(false) => {
                    let what = path.as_deref().unwrap_or("the document");
                    return tool_error(id, window_refusal(&resp, "open", what));
                }
                Ok(_) => {}
                Err(e) => return tool_error(id, app_not_running_msg_for(&e, path.as_deref())),
            }
            remember_review(
                &review_id,
                RegisteredReview {
                    path: path.clone(),
                    content: content.as_deref().map(content_hash),
                    timeout_ms,
                },
            );
            if !blocking {
                return tool_result(
                    id,
                    json!({
                        "reviewId": review_id,
                        "status": "pending",
                        "message": "Review registered. Call request_review with this review_id to wait for the verdict."
                    }),
                );
            }
            review_id
        }
    };

    // What is left of the review window: the whole of it for a fresh review;
    // for a resumed one, what its id says (plus a grace period, so a verdict
    // the app recorded as the window closed is still read). A resumed id
    // without a window end (an older server's) leaves it unknown.
    let window_left = if resumed {
        review_window_end_ms(&review_id)
            .map(|end| end.saturating_sub(unix_ms()) + REVIEW_RESUME_GRACE_MS)
    } else {
        Some(timeout_ms)
    };
    // A review whose window closes within this call reports `timeout` when it
    // does. Otherwise the call ends after `wait_ms` with `pending`.
    let window_ends = window_left.is_some_and(|w| w <= wait_ms);
    let this_call = match window_left {
        Some(w) if window_ends => w,
        _ => wait_ms,
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(this_call);
    let endpoint = format!("/review/result?id={}", urlencoding::encode(&review_id));
    let undecided = |id: Value, window_closed: bool| -> Response {
        if window_closed {
            return respond(
                id,
                json!({
                    "verdict": "timeout",
                    "reviewId": review_id,
                    "message": "No verdict received within the timeout period."
                }),
            );
        }
        respond(
            id,
            json!({
                "status": "pending",
                "reviewId": review_id,
                "message": "No verdict yet. Call request_review again with this review_id to keep waiting."
            }),
        )
    };
    // A resumed call with `blocking: false` reads the review's state once and
    // returns it: it used to wait up to `wait_ms` like a blocking one.
    let check_once = resumed && !blocking;
    loop {
        if !check_once {
            let now = std::time::Instant::now();
            if now >= deadline {
                return undecided(id, window_ends);
            }
            std::thread::sleep(poll.min(deadline - now));
        }
        match ipc.get(&endpoint) {
            // The review is registered: the reply has to carry its id, or an
            // agent whose app answered late, or was briefly unreachable, can
            // neither keep waiting nor tell this from a review never made.
            // A refused token is fixed only by restarting the app, which
            // drops the review, so it says to request a new one.
            Err(e) if app_auth_failed(&e) => {
                return tool_error(
                    id,
                    format!(
                        "Lost contact with Ashlr MD while waiting on review `{review_id}`. \
                         {APP_AUTH_FAILED_MSG} Restarting the app ends this review, so call \
                         request_review again without review_id to request a new one."
                    ),
                )
            }
            Err(e) => {
                return tool_error(
                    id,
                    format!(
                        "Lost contact with Ashlr MD while waiting on review `{review_id}`: {e}. \
                         If the app is still open, call request_review with review_id \
                         `{review_id}` to keep waiting; if it was closed, the review is gone, \
                         so request a new one."
                    ),
                )
            }
            Ok(resp) => match resp["status"].as_str().unwrap_or("") {
                "pending" if check_once => {
                    let closed = review_window_end_ms(&review_id)
                        .is_some_and(|end| unix_ms() >= end + REVIEW_RESUME_GRACE_MS);
                    return undecided(id, closed);
                }
                "pending" => continue,
                "timeout" => {
                    return respond(
                        id,
                        json!({
                            "verdict": "timeout",
                            "reviewId": review_id,
                            "message": "The review window closed with no verdict."
                        }),
                    )
                }
                // A newer review took the panel before the human decided, so
                // no verdict will come for this one.
                "superseded" => {
                    return respond(
                        id,
                        json!({
                            "verdict": "superseded",
                            "reviewId": review_id,
                            "supersededBy": resp["supersededBy"],
                            "message": "A newer review replaced this one in the review panel before the human decided. Call request_review again if this still needs sign-off."
                        }),
                    )
                }
                "not_found" => {
                    return respond(
                        id,
                        json!({
                            "verdict": "timeout",
                            "reviewId": review_id,
                            "message": "Review record lost (the app restarted, or the review expired 30 min after its window closed)."
                        }),
                    )
                }
                _ => return respond(id, decided_review(&resp, &review_id)),
            },
        }
    }
}

/// The `request_review` result for a decided review. A verdict the human
/// gave after the window closed is marked `late: true` with a note, since an
/// earlier call may already have reported `timeout` for this review.
fn decided_review(resp: &Value, review_id: &str) -> Value {
    let mut out = json!({
        "verdict": resp["verdict"],
        "reviewId": review_id,
        "comments": resp["comments"],
    });
    if resp["late"].as_bool() == Some(true) {
        out["late"] = json!(true);
        out["message"] = json!(
            "The human gave this verdict after the review window closed; \
             an earlier call may have reported `timeout` for this review."
        );
    }
    out
}

pub fn tool_get_annotations(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    // An empty `path` is refused here: the app refuses it too, but with the
    // app closed the agent was told to start the app instead.
    let path = match non_blank_str(args, "path") {
        Ok(Some(p)) => p,
        Ok(None) => return Response::err(id, -32602, "`path` is required"),
        Err(e) => return Response::err(id, -32602, e),
    };
    // request_review stores the canonical path, so look it up the same way.
    let path = agent_path(path);
    let encoded = urlencoding::encode(&path);
    match ipc.get(&format!("/annotations?path={encoded}")) {
        Ok(v) => tool_result(id, v),
        // The app is not running: the tasks are still in the file on disk.
        // This used to be an error telling the agent to start the app,
        // although the description said tasks fall back to the file.
        Err(e) if app_unreachable(&e) => tool_result(id, disk_annotations(&path)),
        // Something answered on the app's port but refused the token in
        // ~/.mdopener/ipc-token. That was the bare "IPC auth failed" error,
        // with no tasks and no next step; the tasks are on disk all the same.
        Err(e) if app_auth_failed(&e) => {
            let mut body = disk_annotations(&path);
            if let Some(o) = body.as_object_mut() {
                o.remove("appRunning");
                o.insert("appAuthFailed".into(), json!(true));
                o.insert("note".into(), json!(ANNOTATIONS_APP_AUTH_FAILED_NOTE));
            }
            tool_result(id, body)
        }
        Err(e) => tool_error(id, app_not_running_msg(&e)),
    }
}

// The task-checkbox parser is shared with the app's `/annotations`.
#[path = "../../../src/task_list.rs"]
mod task_list;

/// The `note` of a `get_user_annotations` result read from disk.
pub const ANNOTATIONS_APP_NOT_RUNNING_NOTE: &str = "Ashlr MD is not running, so this was \
read from the file on disk. `verdict` and `comments` are null because the app keeps reviews \
in memory only while it runs: a review given before it quit cannot be read, so null here \
does not mean that no review was given. To ask for one, call request_review (open_file \
starts the app). `tasks` are the checkboxes saved in the file.";

/// Why the app answered HTTP 401, shared by [`APP_AUTH_FAILED_MSG`] and
/// [`ANNOTATIONS_APP_AUTH_FAILED_NOTE`] so the two say it the same way.
macro_rules! app_auth_failed_cause {
    () => {
        "Ashlr MD answered on the port in ~/.mdopener/ipc-port but refused the token in \
         ~/.mdopener/ipc-token (HTTP 401): the token file is stale, or the port belongs to \
         another Ashlr MD instance."
    };
}
/// The `note` of a `get_user_annotations` result read from disk because the
/// app answered HTTP 401 (`appAuthFailed: true`).
pub const ANNOTATIONS_APP_AUTH_FAILED_NOTE: &str = concat!(
    app_auth_failed_cause!(),
    " So this was read from the \
file on disk, and `verdict` and `comments` are null because the review, if there is one, is \
held by the app this server could not read: null here does not mean that no review was \
given. To fix it, ask the user to quit every Ashlr MD window fully and start the app again, \
which writes a new ipc-port and ipc-token, then call get_user_annotations again. `tasks` \
are the checkboxes saved in the file."
);

/// The error of every app tool (other than `get_user_annotations`, which
/// reads the disk instead) when the app answered HTTP 401. It used to be the
/// bare "IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token",
/// which named neither the cause nor a next step.
pub const APP_AUTH_FAILED_MSG: &str = concat!(
    app_auth_failed_cause!(),
    " Ask the user to quit every Ashlr MD window fully and start the app again, which \
     writes a new ipc-port and ipc-token, then retry this call."
);

/// True when the app's port answered HTTP 401: the token this server read
/// from `~/.mdopener/ipc-token` is not the one the listener expects.
fn app_auth_failed(err: &str) -> bool {
    err.starts_with("IPC auth failed")
}

/// What `get_user_annotations` can say about `path` with the app closed: no
/// review (the app held them), and the task checkboxes of the Markdown file
/// on disk, read with the same checks as the other disk tools. A file that
/// cannot be read has no tasks and a `tasksNote` saying why.
fn disk_annotations(path: &str) -> Value {
    // The raw OS text ("No such file or directory (os error 2)") read like a
    // fault: it is worded as the other disk tools word it.
    let read = checked_document(path, "path").and_then(|doc| {
        doc.read().map_err(|e| {
            format!(
                "{} Its tasks were not read.",
                cannot_read("", &doc.path, &e)
            )
        })
    });
    let mut body = json!({
        "path": path,
        "verdict": null,
        "comments": null,
        "late": false,
        "appRunning": false,
        "note": ANNOTATIONS_APP_NOT_RUNNING_NOTE,
    });
    match read {
        Ok(text) => body["tasks"] = json!(task_list::parse_tasks(&text)),
        Err(e) => {
            body["tasks"] = json!([]);
            body["tasksNote"] = json!(e);
        }
    }
    body
}

// ── Document edit / search / present tools ───────────────────────────────────

pub fn tool_edit_document(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    // An empty `find` is refused here, as `stream_edit` does: the app refuses
    // it too, but with the app closed the agent was told to start the app
    // instead of being told what is wrong with its call.
    let find = match args["find"].as_str() {
        Some(f) if !f.is_empty() => f.to_string(),
        Some(_) => return Response::err(id, -32602, "`find` must not be empty"),
        None => return Response::err(id, -32602, "`find` is required"),
    };
    let replace = match args["replace"].as_str() {
        Some(r) => r.to_string(),
        None => return Response::err(id, -32602, "`replace` is required"),
    };
    let save = args["save"].as_bool().unwrap_or(false);
    // An empty `path` used to reach the app, which answered that "" is not
    // the open document; it is refused here like an empty `find`.
    let path = match non_blank_str(args, "path") {
        Ok(p) => p,
        Err(e) => return Response::err(id, -32602, e),
    };

    let path = path.map(agent_path);
    let mut body = json!({ "find": find, "replace": replace, "save": save });
    if let Some(p) = &path {
        body["path"] = json!(p);
    }

    match ipc.post("/edit", body) {
        Ok(v) => {
            if v["ok"].as_bool() == Some(false) {
                let msg = v["error"].as_str().unwrap_or("Edit could not be applied.");
                return tool_error(id, msg.to_string());
            }
            tool_result(id, v)
        }
        Err(e) => tool_error(id, app_not_running_msg_for(&e, path.as_deref())),
    }
}

pub fn tool_replace_document(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let content = match args["content"].as_str() {
        Some(c) => c.to_string(),
        None => return Response::err(id, -32602, "`content` is required"),
    };
    let save = args["save"].as_bool().unwrap_or(false);
    post_content(id, &content, save, ipc)
}

pub fn tool_search_vault(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    // An empty query is refused by the schema's `minLength`; a whitespace-only
    // one is refused here, before Ollama or the app is asked. Both used to
    // reach the app, so with it closed the agent was told to start it rather
    // than that the query was empty.
    let query = match args["query"].as_str() {
        Some(q) if q.trim().is_empty() => {
            return Response::err(
                id,
                -32602,
                "`query` must not be empty or only whitespace: pass the words to search for",
            )
        }
        Some(q) => q.to_string(),
        None => return Response::err(id, -32602, "`query` is required"),
    };
    // A `limit` above SEARCH_MAX_RESULTS used to be clamped in silence while
    // `list_recent` and `get_conversation_context` refused one; it is now
    // refused the same way. Omitted keeps the default.
    let limit = match &args["limit"] {
        Value::Null => 50,
        v => match whole_number_value(v).filter(|n| (1..=SEARCH_MAX_RESULTS).contains(n)) {
            Some(n) => n,
            None => {
                return Response::err(
                    id,
                    -32602,
                    format!(
                        "`limit` must be a whole number from 1 to {SEARCH_MAX_RESULTS}, got {v}; \
                         omit it for the default of 50"
                    ),
                )
            }
        },
    };
    let vault = match non_blank_str(args, "vault") {
        Ok(v) => v,
        Err(e) => return Response::err(id, -32602, e),
    };
    let vault = match vault.map(disk_vault_dir).transpose() {
        Ok(v) => v,
        Err(e) => return tool_error(id, e),
    };

    // Determine search mode: explicit override or auto-detect via Ollama.
    let use_semantic = match args["semantic"].as_bool() {
        Some(b) => b,
        None => ollama_available(),
    };

    match search_vault_in(
        &query,
        limit,
        use_semantic,
        vault.as_deref(),
        ipc,
        &ollama_embed,
    ) {
        Ok(v) => tool_result(id, v),
        Err(e) => tool_error(id, e),
    }
}

/// Most results `search_vault` (and `text://vault-search`) returns, in every
/// mode: the cap the app's own `/search` applies.
pub const SEARCH_MAX_RESULTS: u64 = 200;

/// The search behind both `search_vault` and the `text://vault-search`
/// resource: `{ results, mode, note? }`, or the error the agent should see.
///
/// Semantic search (when `use_semantic`) falls back to the app's own search,
/// and that to grepping the vault files on disk; each fallback is said in
/// `note`, so keyword hits are never read as meaning matches and the app's
/// refusal is never papered over.
pub fn search_vault(
    query: &str,
    limit: u64,
    use_semantic: bool,
    ipc: &dyn IpcClient,
) -> Result<Value, String> {
    search_vault_with(query, limit, use_semantic, ipc, &ollama_embed)
}

/// [`search_vault`] with the embedder injected, so tests never need Ollama.
pub fn search_vault_with(
    query: &str,
    limit: u64,
    use_semantic: bool,
    ipc: &dyn IpcClient,
    embed: Embedder,
) -> Result<Value, String> {
    search_vault_in(query, limit, use_semantic, None, ipc, embed)
}

/// [`search_vault_with`] that, when the app cannot be reached (not when it
/// refuses), searches the Markdown files under `vault` on disk instead: a
/// directory already checked by [`disk_vault_dir`]. Results from disk carry
/// mode `grep-disk` (or `semantic`), the `vault` searched, and a `note`.
pub fn search_vault_in(
    query: &str,
    limit: u64,
    use_semantic: bool,
    vault: Option<&std::path::Path>,
    ipc: &dyn IpcClient,
    embed: Embedder,
) -> Result<Value, String> {
    // The app's own search returns at most SEARCH_MAX_RESULTS; the other
    // modes are held to the same, so a limit means the same in every mode
    // (an on-disk vault of 5000 files could otherwise return 5000 results).
    // The tool and the resource refuse a limit outside that range; this
    // clamp only holds direct callers of this function to it.
    let limit = limit.clamp(1, SEARCH_MAX_RESULTS);
    // The vault file list: from the app, or from `vault` on disk when the app
    // is unreachable. Fetched once, and only when needed.
    let mut listed: Option<Result<VaultFiles, String>> = None;
    let mut files = || {
        listed
            .get_or_insert_with(|| vault_files(ipc, vault))
            .clone()
    };
    // Why semantic search was tried but not used, said in words so an agent
    // that asked for it does not read keyword hits as meaning matches.
    let mut semantic_note = None;
    if use_semantic {
        // Attempt semantic search via Ollama embeddings.
        match files().and_then(|f| semantic_hits(query, limit, &f.paths, embed).map(|h| (f, h))) {
            Ok((f, hits)) => {
                let mut v = json!({ "results": hits.results, "mode": "semantic" });
                let note = [f.disk_note(), hits.skipped_note()]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" ");
                if !note.is_empty() {
                    v["note"] = json!(note);
                }
                if let Some(dir) = &f.disk_vault {
                    v["vault"] = json!(dir);
                }
                f.mark_cut(&mut v);
                return Ok(v);
            }
            Err(e) => {
                // Embedding failed — fall through to grep, and say so.
                semantic_note = Some(format!(
                    "Semantic search was unavailable ({e}), so these are keyword (grep) \
                     results instead. Start Ollama with the nomic-embed-text model for \
                     semantic search."
                ));
            }
        }
    }

    // Grep fallback: ask the app's IPC layer (which does its own grep), or
    // grep the vault files on disk if that route fails.
    let encoded = urlencoding::encode(query);
    match ipc.get(&format!("/search?q={encoded}&limit={limit}")) {
        Ok(mut v) => {
            v["mode"] = json!("grep");
            // Keep the app's own note (it says when the vault list was cut
            // short, and `truncated` stays set): the fallback note goes first.
            let app_note = v["note"].as_str().map(str::to_string);
            let note = [semantic_note, app_note]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            if !note.is_empty() {
                v["note"] = json!(note);
            }
            Ok(v)
        }
        Err(ipc_err) => {
            // The app's search failed: grep the vault files on disk. The file
            // list comes from the app too, or from `vault` when the app is
            // unreachable. Keep the app's reason: a refusal is the agent's to
            // see, not something an on-disk grep should paper over.
            let refused = app_refused(&ipc_err);
            match files() {
                Ok(f) if f.disk_vault.is_some() => {
                    let results = grep_paths(query, limit, &f.paths);
                    let note = [semantic_note, f.disk_note()]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" ");
                    let mut v = json!({
                        "results": results,
                        "mode": "grep-disk",
                        "vault": f.disk_vault,
                        "note": note
                    });
                    f.mark_cut(&mut v);
                    Ok(v)
                }
                Ok(f) => {
                    let results = grep_paths(query, limit, &f.paths);
                    let verb = if refused { "refused" } else { "failed" };
                    let search_note = format!(
                        "Ashlr MD's own search {verb} ({ipc_err}), so these results \
                         come from grepping the vault files on disk."
                    );
                    let note = [semantic_note, Some(search_note), f.disk_note()]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" ");
                    let mut v = json!({
                        "results": results,
                        "mode": "grep-local",
                        "note": note
                    });
                    f.mark_cut(&mut v);
                    Ok(v)
                }
                Err(_) if refused => Err(ipc_err),
                Err(e) if app_unreachable(&e) => Err(format!(
                    "{} To search without the app, pass `vault`: the directory of \
                     Markdown files to grep on disk.",
                    app_not_running_msg(&e)
                )),
                Err(e) => Err(app_not_running_msg(&e)),
            }
        }
    }
}

/// True when an IPC error means no app could be reached at all (no port or
/// token file, or nothing listening), as opposed to the app refusing or
/// failing a request.
fn app_unreachable(err: &str) -> bool {
    err.contains("ipc-port not found")
        || err.contains("ipc-token not found")
        || err.contains("Cannot determine home directory")
        || err.starts_with("Could not connect to IPC server")
}

/// Most Markdown files a `vault` walk collects, and how deep it goes (the
/// vault itself is level 0; a folder deeper than this is not entered, and
/// the result says so with `depthCut`).
pub const DISK_VAULT_MAX_FILES: usize = 5_000;
pub const DISK_VAULT_MAX_DEPTH: usize = 16;

/// Resolve a `vault` argument (relative to the server's working directory)
/// to the canonical directory to search on disk; anything that is not an
/// existing directory is refused, and so is a hidden (dot) folder, which the
/// walk would skip below a vault. Only the documents [`disk_vault_files`]
/// finds under it are read. Errors are for `isError`.
pub fn disk_vault_dir(raw: &str) -> Result<std::path::PathBuf, String> {
    // A missing folder used to come back as the raw OS text ("No such file
    // or directory (os error 2)"), which read like a fault and gave no next
    // step.
    let dir = std::fs::canonicalize(raw).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "`vault` '{}' does not exist: name an existing folder of Markdown files to \
                 search, or start Ashlr MD to search its vault.",
                agent_path(raw)
            )
        } else {
            format!("`vault` '{}': {e}", agent_path(raw))
        }
    })?;
    if !dir.is_dir() {
        return Err(format!(
            "`vault` '{}' is not a directory: name the folder of Markdown files to search.",
            dir.display()
        ));
    }
    // The walk skips hidden folders below a vault, so a hidden vault itself
    // (`.git`, `.obsidian`) is refused rather than read.
    if dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
    {
        return Err(format!(
            "`vault` '{}' is a hidden folder, and hidden folders are not searched: name \
             the folder of Markdown notes that contains it instead.",
            dir.display()
        ));
    }
    Ok(dir)
}

/// What [`disk_vault_scan`] found under a `vault` directory.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiskVaultScan {
    /// The canonical paths of the documents found, sorted.
    pub paths: Vec<String>,
    /// [`DISK_VAULT_MAX_FILES`] stopped the walk.
    pub file_cap: bool,
    /// A folder more than [`DISK_VAULT_MAX_DEPTH`] levels below the vault was
    /// not entered (the walk went on). Such folders used to be skipped
    /// without a word.
    pub depth_cut: bool,
}

/// [`disk_vault_scan`]'s paths, and whether [`DISK_VAULT_MAX_FILES`] cut the
/// walk short.
pub fn disk_vault_files(dir: &std::path::Path) -> (Vec<String>, bool) {
    let scan = disk_vault_scan(dir);
    (scan.paths, scan.file_cap)
}

/// The Markdown documents under `dir` that a path-taking tool could read
/// ([`checked_document_path`]), sorted, without entering hidden directories,
/// `node_modules` or `target`, or following directory symlinks, and whether
/// the file cap or the depth limit cut the walk.
pub fn disk_vault_scan(dir: &std::path::Path) -> DiskVaultScan {
    fn walk(
        dir: &std::path::Path,
        depth: usize,
        out: &mut Vec<String>,
        depth_cut: &mut bool,
    ) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                let skip = name == "node_modules" || name == "target";
                if skip {
                    continue;
                }
                if depth >= DISK_VAULT_MAX_DEPTH {
                    *depth_cut = true;
                    continue;
                }
                if walk(&path, depth + 1, out, depth_cut) {
                    return true;
                }
            } else if let Ok(p) = checked_document_path(&path.to_string_lossy(), "vault") {
                if std::path::Path::new(&p).is_file() && !out.contains(&p) {
                    if out.len() == DISK_VAULT_MAX_FILES {
                        return true;
                    }
                    out.push(p);
                }
            }
        }
        false
    }
    let mut out = Vec::new();
    let mut depth_cut = false;
    let file_cap = walk(dir, 0, &mut out, &mut depth_cut);
    DiskVaultScan {
        paths: out,
        file_cap,
        depth_cut,
    }
}

/// The files a vault search reads, and where the list came from.
#[derive(Clone)]
struct VaultFiles {
    paths: Vec<String>,
    /// Set when the app was unreachable and `vault` was walked on disk.
    disk_vault: Option<String>,
    /// Why the app was not asked, quoted in the note.
    app_error: String,
    truncated: bool,
    /// The app's own cap on its vault list, as `/vault` reports it (the
    /// frontend's `MAX_FILES`). `None` from an older app that does not say.
    app_limit: Option<u64>,
    /// The app's walk of the watched folder did not read all of it (entry
    /// budget, or folders too deep), so its list is the newest of the files
    /// reached.
    app_scan_cut: bool,
    /// The walk that listed the files skipped folders below its depth limit
    /// (the app's 8 levels, or [`DISK_VAULT_MAX_DEPTH`] on disk). From the
    /// app, `Some(false)` with `app_scan_cut` is the entry budget alone, and
    /// `None` an older app that does not say which.
    depth_cut: Option<bool>,
    /// The on-disk walk stopped at [`DISK_VAULT_MAX_FILES`].
    disk_file_cap: bool,
}

impl VaultFiles {
    /// Says the results come from the disk, not the app, when they do, and
    /// that the list was cut short when it was.
    fn disk_note(&self) -> Option<String> {
        let Some(dir) = self.disk_vault.as_deref() else {
            return self.truncated.then(|| {
                let n = self.app_limit.map(|n| format!("{n} ")).unwrap_or_default();
                match (self.app_scan_cut, self.depth_cut) {
                    (true, Some(true)) => {
                        return format!(
                            "The watched folder is too deeply nested for Ashlr MD to scan \
                             in full (it enters folders at most 8 levels down, and reads at \
                             most 50,000 entries), so only the {n}most recently changed of \
                             the files it scanned (and the recent documents) were searched; \
                             files in deeper folders were not searched."
                        );
                    }
                    (true, Some(false)) => {
                        return format!(
                            "The watched folder is too large for Ashlr MD to scan in full \
                             (it reads at most 50,000 entries), so only the {n}most recently \
                             changed of the files it scanned (and the recent documents) were \
                             searched; newer files elsewhere in the folder may have been \
                             missed."
                        );
                    }
                    (true, None) => {
                        return format!(
                            "The watched folder is too large or too deeply nested for Ashlr \
                             MD to scan in full (it reads at most 50,000 entries, and folders \
                             at most 8 levels down), so only the {n}most recently changed of \
                             the files it scanned (and the recent documents) were searched; \
                             files elsewhere in the folder may have been missed."
                        );
                    }
                    (false, _) => {}
                }
                format!(
                    "The watched folder has more Markdown files than Ashlr MD lists, so \
                     only its {n}most recently changed files (and the recent documents) were \
                     searched."
                )
            });
        };
        let mut note = format!(
            "Ashlr MD could not be reached ({}), so these results come from searching \
             the {} Markdown files under {dir} on disk.",
            self.app_error,
            self.paths.len()
        );
        if self.disk_file_cap {
            note.push_str(&format!(
                " Only the first {DISK_VAULT_MAX_FILES} files were searched."
            ));
        }
        if self.depth_cut() {
            note.push_str(&format!(
                " Folders more than {DISK_VAULT_MAX_DEPTH} levels below it were not \
                 searched."
            ));
        }
        Some(note)
    }

    /// Mark `result` as cut short when the file list was: `truncated`, and
    /// `depthCut` when the depth limit is what cut the walk.
    fn mark_cut(&self, result: &mut Value) {
        if self.truncated {
            result["truncated"] = json!(true);
        }
        if self.depth_cut() {
            result["depthCut"] = json!(true);
        }
    }

    /// The walk that listed the files skipped folders below its depth limit.
    fn depth_cut(&self) -> bool {
        self.depth_cut == Some(true)
    }
}

/// The vault file list from the app, or from walking `vault` on disk when the
/// app cannot be reached. A refusal or other failure is still an error.
fn vault_files(ipc: &dyn IpcClient, vault: Option<&std::path::Path>) -> Result<VaultFiles, String> {
    match (vault_listing(ipc), vault) {
        (Ok(listing), _) => Ok(VaultFiles {
            paths: listing.paths,
            disk_vault: None,
            app_error: String::new(),
            truncated: listing.truncated || listing.scan_cut,
            app_limit: listing.limit,
            app_scan_cut: listing.scan_cut,
            depth_cut: listing.depth_cut,
            disk_file_cap: false,
        }),
        (Err(e), Some(dir)) if app_unreachable(&e) => {
            let scan = disk_vault_scan(dir);
            Ok(VaultFiles {
                paths: scan.paths,
                disk_vault: Some(dir.to_string_lossy().into_owned()),
                app_error: e,
                truncated: scan.file_cap || scan.depth_cut,
                app_limit: None,
                app_scan_cut: false,
                depth_cut: Some(scan.depth_cut),
                disk_file_cap: scan.file_cap,
            })
        }
        (Err(e), _) => Err(e),
    }
}

pub fn tool_present_document(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let path = match non_blank_str(args, "path") {
        Ok(p) => p,
        Err(e) => return Response::err(id, -32602, e),
    };
    let path = match path.map(presentable_document_path).transpose() {
        Ok(p) => p,
        Err(e) => return tool_error(id, e),
    };
    // A missing file can never be presented. It was sent to the app first, so
    // with the app closed the agent heard only "not running", and learned the
    // path was wrong after starting it.
    if let Some(abs) = path.as_deref() {
        if !std::path::Path::new(abs).is_file() {
            return tool_error(
                id,
                format!("Cannot present '{abs}': the file does not exist."),
            );
        }
    }
    match ipc.post("/present", json!({ "path": path })) {
        Ok(v) if v["ok"].as_bool() == Some(false) => {
            let what = path.as_deref().unwrap_or("the open document");
            tool_error(id, window_refusal(&v, "present", what))
        }
        Ok(v) => tool_result(id, v),
        Err(e) => tool_error(id, app_not_running_msg_for(&e, path.as_deref())),
    }
}

// ── get_conversation_context tool ────────────────────────────────────────────

/// The `session_id` of the conversation tools. A blank or whitespace-only id
/// is refused like a missing one: it used to be accepted and stored as
/// `%20%20%20.json`, a session no agent means to address.
///
/// An id whose file name would be longer than [`MAX_SESSION_FILE_STEM`] is
/// refused too: it used to fail only when saving, with the OS error "File
/// name too long", while reading it answered an empty session.
fn session_id_arg(args: &Value) -> Result<String, String> {
    match args["session_id"].as_str() {
        Some(s) if s.trim().is_empty() => Err("`session_id` must not be blank".to_string()),
        Some(s) if session_file_stem(s).len() > MAX_SESSION_FILE_STEM => Err(format!(
            "`session_id` is too long ({} bytes): it must fit a {MAX_SESSION_FILE_STEM}-byte \
             file name, where ASCII letters, digits, `-` and `_` count one byte each and \
             every other byte counts three.",
            s.len()
        )),
        Some(s) => Ok(s.to_string()),
        None => Err("`session_id` is required".to_string()),
    }
}

/// Return the last N messages from the session's persistent memory store.
/// If the in-process store is empty (cold start / restart), loads from disk.
/// Returns an empty array gracefully when the session has no messages yet.
pub fn tool_get_conversation_context(id: Value, args: &Value) -> Response {
    let session_id = match session_id_arg(args) {
        Ok(s) => s,
        Err(msg) => return Response::err(id, -32602, msg),
    };

    // A `limit` above MAX_MESSAGES_PER_SESSION used to be clamped in silence
    // while `list_recent` refused one; both now refuse a value outside 1 to
    // 200 (a session keeps at most 200 messages). Omitted keeps the default.
    let max = MAX_MESSAGES_PER_SESSION as u64;
    let limit = match &args["limit"] {
        Value::Null => 20,
        v => match whole_number_value(v).filter(|n| (1..=max).contains(n)) {
            Some(n) => n as usize,
            None => {
                return Response::err(
                    id,
                    -32602,
                    format!(
                        "`limit` must be a whole number from 1 to {max}, got {v}; \
                         omit it for the default of 20"
                    ),
                )
            }
        },
    };

    match store_get_context(&session_id, limit) {
        Ok(messages) => {
            // Newest first, each path once: agents read `recentDocs[0]` as
            // the most recently cited document. This used to go through a
            // HashSet, so the order changed from one call to the next.
            // An empty (or blank) path, which earlier builds stored, is left
            // out: as the latest citation it came back as `recentDocs[0]`.
            let mut seen = std::collections::HashSet::new();
            let cited_docs: Vec<String> = messages
                .iter()
                .rev()
                .flat_map(|m| m.cited_docs.iter())
                .filter(|d| !d.trim().is_empty())
                .filter(|d| seen.insert(d.as_str()))
                .cloned()
                .collect();

            tool_result(
                id,
                json!({
                    "sessionId": session_id,
                    "messages": messages.iter().map(|m| json!({
                        "id": m.id,
                        "sessionId": m.session_id,
                        "role": m.role,
                        "content": m.content,
                        // Filtered as `recentDocs` is: a blank path from an
                        // older session file named no document here either,
                        // and a path an older build stored twice is listed
                        // once.
                        "citedDocs": cited_once(&m.cited_docs),
                        "timestampMs": m.timestamp_ms,
                    })).collect::<Vec<_>>(),
                    "count": messages.len(),
                    "recentDocs": cited_docs,
                }),
            )
        }
        // "Failed to read conversation context: {e}" named neither the
        // session nor, for a lock error, what to do.
        Err(e) => tool_error(
            id,
            format!("Cannot get the conversation context of session `{session_id}`: {e}"),
        ),
    }
}

/// A message's cited paths for `get_conversation_context`: blank ones left
/// out, each path once, in the order stored.
fn cited_once(docs: &[String]) -> Vec<&str> {
    let mut seen = std::collections::HashSet::new();
    docs.iter()
        .map(String::as_str)
        .filter(|d| !d.trim().is_empty())
        .filter(|d| seen.insert(*d))
        .collect()
}

// ── save_conversation_message tool ───────────────────────────────────────────

/// Append an agent action or human verdict to the session's persistent store.
/// Persists to disk at `~/.mdopener/sessions/{sessionId}.json` after every
/// append so messages survive process restarts.
pub fn tool_save_conversation_message(id: Value, args: &Value) -> Response {
    let session_id = match session_id_arg(args) {
        Ok(s) => s,
        Err(msg) => return Response::err(id, -32602, msg),
    };

    // A `role` outside the schema enum is refused by check_tool_arguments
    // before this runs; store_append_message checks it again for its other
    // callers.
    let role = match args["role"].as_str() {
        Some(r) => r,
        None => return Response::err(id, -32602, "`role` is required"),
    };

    let content = match args["content"].as_str() {
        Some(c) if !c.trim().is_empty() => c.to_string(),
        Some(_) => return Response::err(id, -32602, "`content` must not be empty"),
        None => return Response::err(id, -32602, "`content` is required"),
    };

    // An empty path used to be stored and come back in `recentDocs`, where
    // agents read the first entry as the most recently cited document.
    let cited = args["cited_docs"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    // A blank one (only whitespace) too: it named no document, and resolved
    // against the working directory it became a path to a file named "  ".
    if let Some(i) = cited
        .iter()
        .position(|v| v.as_str().is_some_and(|d| d.trim().is_empty()))
    {
        return Response::err(id, -32602, format!("`cited_docs[{i}]` must not be empty"));
    }
    // Stored as absolute paths, as the schema says: a relative one used to be
    // stored as given, and read back later it named nothing an agent (or
    // the window, which records absolute paths) could match. It is resolved
    // against this server's working directory, as every other path argument
    // is; an absolute one is kept exactly as given.
    let mut cited_docs: Vec<String> = Vec::with_capacity(cited.len());
    for (i, raw) in cited
        .iter()
        .enumerate()
        .filter_map(|(i, v)| v.as_str().map(|s| (i, s)))
    {
        match std::path::absolute(raw) {
            Ok(p) => cited_docs.push(p.to_string_lossy().into_owned()),
            Err(e) => {
                return Response::err(
                    id,
                    -32602,
                    format!("`cited_docs[{i}]` {raw:?} cannot be made absolute: {e}"),
                )
            }
        }
    }

    match append_message(&session_id, role, &content, cited_docs) {
        Ok((msg, dropped)) => {
            let mut body = json!({
                "ok": true,
                "messageId": msg.id,
                "sessionId": msg.session_id,
                "role": msg.role,
                "timestampMs": msg.timestamp_ms,
            });
            if dropped > 0 {
                body["dropped"] = json!(dropped);
                body["note"] = json!(format!(
                    "The session file may be at most {} MiB, so its {dropped} oldest \
                     message(s) were dropped to make room for this one.",
                    MAX_SESSION_FILE_BYTES / (1024 * 1024)
                ));
            }
            tool_result(id, body)
        }
        // The arguments were valid (checked above); this is a failure to
        // store the message, e.g. the session file could not be written.
        Err(e) => tool_error(id, e),
    }
}

// ── list_ai_actions tool ──────────────────────────────────────────────────────

/// Static metadata for the AI transform actions defined in src/ai/actions.ts.
/// Kept in sync manually; `ai_actions_registry_matches_actions_ts` in the
/// integration tests checks the ids, labels and icons against the TypeScript
/// source. `argument` (on the actions whose templates use `{arg}`) says what
/// that placeholder is, which the templates alone did not.  Agents call `list_ai_actions` to discover what
/// transforms are available before composing a workflow.
pub fn ai_actions_registry() -> Value {
    json!([
        {
            "id": "explain",
            "label": "Explain",
            "shortLabel": "Explain",
            "icon": "💡",
            "scope": "selection",
            "systemPrompt": "You are a clear, concise technical explainer. Explain the provided text in plain language. Be thorough but avoid padding. Use markdown where helpful.",
            "userPromptTemplate": "Explain the following:\n\n{text}"
        },
        {
            "id": "summarize",
            "label": "Summarize",
            "shortLabel": "Summarize",
            "icon": "📝",
            "scope": "selection",
            "systemPrompt": "You are an expert at summarizing text. Produce a concise bullet-point summary capturing the key points. Use markdown bullet points.",
            "userPromptTemplate": "Summarize the following:\n\n{text}"
        },
        {
            "id": "rewrite",
            "label": "Rewrite (clearer)",
            "shortLabel": "Rewrite",
            "icon": "✏️",
            "scope": "selection",
            "systemPrompt": "You are an expert editor. Rewrite the provided text to be clearer and more concise while preserving the original meaning and voice. Output only the rewritten text, with no commentary and no preamble.",
            "userPromptTemplate": "Rewrite the following text to be clearer and more concise:\n\n{text}"
        },
        {
            "id": "fix-grammar",
            "label": "Fix grammar",
            "shortLabel": "Fix",
            "icon": "✓",
            "scope": "selection",
            "systemPrompt": "You are a meticulous copy editor. Correct spelling, grammar, punctuation, and obvious typos in the provided text. Preserve the original meaning, tone, wording, and any Markdown formatting. Output only the corrected text, with no commentary and no preamble.",
            "userPromptTemplate": "Fix the grammar and spelling in the following text:\n\n{text}"
        },
        {
            "id": "concise",
            "label": "Make concise",
            "shortLabel": "Concise",
            "icon": "✂️",
            "scope": "selection",
            "systemPrompt": "You are an expert editor who tightens prose. Make the provided text more concise: remove redundancy and filler while preserving the meaning, key facts, voice, and any Markdown formatting. Output only the rewritten text, with no commentary and no preamble.",
            "userPromptTemplate": "Make the following text more concise:\n\n{text}"
        },
        {
            "id": "expand",
            "label": "Expand",
            "shortLabel": "Expand",
            "icon": "➕",
            "scope": "selection",
            "systemPrompt": "You are an expert writer. Expand the provided text with helpful detail, clarification, and supporting points while keeping the original meaning, voice, and any Markdown formatting. Do not invent facts. Output only the expanded text, with no commentary and no preamble.",
            "userPromptTemplate": "Expand the following text with more detail:\n\n{text}"
        },
        {
            "id": "explain-diff",
            "label": "Explain changes",
            "shortLabel": "Explain changes",
            "icon": "🔀",
            "scope": "selection",
            "systemPrompt": "You are a precise technical reviewer. The user has a document open with unsaved edits, and the same file changed on disk underneath them. You will be given both versions. Explain, in clear bullet points, what changed on disk relative to their in-editor version, focusing on substantive content differences, not whitespace. Be concise and use Markdown.",
            "userPromptTemplate": "MY CURRENT VERSION (in the editor):\n\n```\n{text}\n```\n\nVERSION ON DISK (changed underneath me):\n\n```\n{arg}\n```\n\nExplain what changed on disk compared to my current version.",
            "argument": "{arg} is the version of the document on disk; {text} is the version in the editor. The app passes an empty string when there is none."
        },
        {
            "id": "translate",
            "label": "Translate",
            "shortLabel": "Translate",
            "icon": "🌐",
            "scope": "selection",
            "systemPrompt": "You are a professional translator. Translate the provided text into {arg}. Output only the translation, with no commentary and no preamble.",
            "userPromptTemplate": "Translate the following into {arg}:\n\n{text}",
            "argument": "{arg} is the language to translate into, by name (e.g. French). The app uses Spanish when none is given."
        },
        {
            "id": "tldr",
            "label": "TL;DR",
            "shortLabel": "TL;DR",
            "icon": "⚡",
            "scope": "selection",
            "systemPrompt": "You are an expert at distilling information. Produce a single punchy TL;DR sentence (max 2 sentences) that captures the essential point of the text.",
            "userPromptTemplate": "Write a TL;DR for the following:\n\n{text}"
        },
        {
            "id": "doc-summarize",
            "label": "Summarize doc",
            "shortLabel": "Summarize doc",
            "icon": "📝",
            "scope": "document",
            "systemPrompt": "You are an expert at summarizing Markdown documents. Produce a concise bullet-point summary of the key points. Use markdown bullet points. Be helpful and thorough.",
            "userPromptTemplate": "Summarize this document:\n\n{text}"
        },
        {
            "id": "doc-outline",
            "label": "Outline",
            "shortLabel": "Outline",
            "icon": "📋",
            "scope": "document",
            "systemPrompt": "You are an expert document analyst. Produce a structured outline of the document as a nested markdown list reflecting the heading hierarchy. Include one brief sentence per section describing its content.",
            "userPromptTemplate": "Generate an outline for this document:\n\n{text}"
        },
        {
            "id": "doc-explain-selection",
            "label": "Explain selection",
            "shortLabel": "Explain selection",
            "icon": "💡",
            "scope": "document",
            "systemPrompt": "You are a clear, concise technical explainer grounded in the document context. The user will provide selected text. Explain it in plain language, referencing the surrounding document for context as needed.",
            "userPromptTemplate": "The document context:\n\n{text}"
        }
    ])
}

pub fn tool_list_ai_actions(id: Value, args: &Value) -> Response {
    let include_prompts = args["include_prompts"].as_bool().unwrap_or(true);

    let actions = ai_actions_registry();
    let filtered: Vec<Value> = actions
        .as_array()
        .unwrap()
        .iter()
        .map(|action| {
            if include_prompts {
                action.clone()
            } else {
                // Strip prompt templates: return only discovery metadata,
                // which includes what an action's extra argument is.
                let mut meta = json!({
                    "id": action["id"],
                    "label": action["label"],
                    "shortLabel": action["shortLabel"],
                    "icon": action["icon"],
                    "scope": action["scope"]
                });
                if !action["argument"].is_null() {
                    meta["argument"] = action["argument"].clone();
                }
                meta
            }
        })
        .collect();

    tool_result(
        id,
        json!({
            "actions": filtered,
            "count": filtered.len()
        }),
    )
}

// ── Resources ─────────────────────────────────────────────────────────────────

pub fn handle_resources_list(id: Value, ipc: &dyn IpcClient) -> Response {
    let mut resources = vec![json!({
        "uri": "mdopener://current",
        "name": "Current document",
        "description": "The document currently open in Ashlr MD. An error (-32002) when no document is open, -32000 when the app is not running.",
        "mimeType": "text/markdown"
    })];

    // Advertise the semantic-search resource template so MCP clients can
    // discover it and construct queries like text://vault-search?q=my+topic.
    resources.push(json!({
        "uri": "text://vault-search",
        "name": "Vault semantic search",
        "description": ([
            "Semantic + full-text search across your vault. Read as text://vault-search?q={query}, adding &vault={directory} to search that folder on disk when the app is not running, and &semantic=false (or true) to force grep (or semantic) search. Uses Ollama nomic-embed-text embeddings with grep fallback, like the search_vault tool. Returns JSON: ",
            VAULT_SEARCH_RESOURCE_FIELDS,
            ", shaped as search_vault's reply; `note` says in words when semantic search or the app's own search was unavailable, `vault` is the folder searched on disk, and `truncated` (with `depthCut` when folders were too deeply nested) says some vault files were not searched."
        ].concat()),
        "mimeType": "application/json"
    }));

    // Advertise the recent-documents resource — agents can read
    // mdopener://recent-documents to get a scoped list of recently opened files
    // with path, title, mtime, and a 200-char preview snippet.
    resources.push(json!({
        "uri": "mdopener://recent-documents",
        "name": "Recently opened documents",
        "description": "Scoped list of recently opened files with path, title, modified time (ms since epoch), and a 200-char preview snippet of each file's content. Returns { documents: [{ path, title, mtimeMs, preview }], count, skipped: { missing, notDocument, tooLarge, unreadable } } (`title` is the first `# ` heading, else the file name without its extension; `preview` is the first 200 characters, front matter included): recents that could not be listed are left out and counted by reason in `skipped`. An empty list when the app has no recents; an error (-32000) when the app is not running. Read-only.",
        "mimeType": "application/json"
    }));

    // The vault's `file://` entries come from the app. When it cannot be
    // asked they are missing, and that used to be silent, so a client read
    // the list as a vault with no files. The result's `_meta` (which the MCP
    // `ListResourcesResult` schema allows) now says why, and stderr logs it.
    let mut meta = None;
    match ipc.get("/vault") {
        Ok(v) => {
            if let Some(files) = v["files"].as_array() {
                for f in files {
                    if let Some(p) = f["path"].as_str() {
                        resources.push(json!({
                            "uri": format!("file://{p}"),
                            "name": f["name"].as_str().unwrap_or(p),
                            "mimeType": "text/markdown"
                        }));
                    }
                }
            }
            // The app lists only the newest files of a large watched folder
            // (and of the part of it its walk reached). `search_vault` says
            // so with `truncated`; this listing used to say nothing, so the
            // entries read as the whole vault.
            if let Some(why) = vault_files_cut_note(&v) {
                meta = Some(json!({ VAULT_FILES_TRUNCATED_META: why }));
            }
        }
        Err(e) => {
            let why = format!(
                "The vault's file:// resources are not listed: {}",
                app_not_running_msg(&e)
            );
            eprintln!("mdopener-mcp: resources/list: {why}");
            meta = Some(json!({ VAULT_FILES_UNLISTED_META: why }));
        }
    }

    let mut result = json!({ "resources": resources });
    if let Some(meta) = meta {
        result["_meta"] = meta;
    }
    Response::ok(id, result)
}

/// The fields a `text://vault-search` read returns, as its `resources/list`
/// and `resources/templates/list` descriptions state them (`?` marks one that
/// is present only sometimes). The descriptions used to list only
/// `{ results, mode, query, note? }`, leaving out `vault`, `truncated` and
/// `depthCut`, which the result carries when it searched a folder on disk or
/// did not search every file.
/// The fields a `search_vault` tool result can carry, as its description
/// states them. `query` is the app's own echo, so only mode `grep` has it; the
/// `text://vault-search` resource adds it in every mode.
pub const SEARCH_VAULT_TOOL_FIELDS: &str =
    "{ results, mode, query?, note?, vault?, truncated?, depthCut? }";

pub const VAULT_SEARCH_RESOURCE_FIELDS: &str =
    "{ results, mode, query, note?, vault?, truncated?, depthCut? }";

/// The `resources/templates/list` entries: `text://vault-search`, which is
/// read with a query (`?q=…`) and so is a URI template, not a fixed resource.
/// The method used to be unknown (`-32601`), so a client that discovers
/// parameterised resources through it never saw the search, and the bare
/// URI `resources/list` shows cannot be read without a query.
pub fn resource_templates() -> Value {
    json!([{
        "uriTemplate": "text://vault-search?q={query}",
        "name": "Vault semantic search",
        "description": ([
            "Semantic + full-text search across your vault, as the search_vault tool. Replace {query} with the percent-encoded query; add &limit=N (1 to 200, default 50), &semantic=true|false to force semantic or grep search, and &vault={directory} to search that folder on disk when the app is not running. Returns JSON: ",
            VAULT_SEARCH_RESOURCE_FIELDS,
            ", as resources/list describes."
        ].concat()),
        "mimeType": "application/json"
    }])
}

/// The `_meta` key a `resources/list` result carries when the app's vault
/// list is cut short, so the `file://` entries are not all of the watched
/// folder's Markdown files, with the reason in words.
pub const VAULT_FILES_TRUNCATED_META: &str = "mdopener/vaultFilesTruncated";

/// Why the app's `/vault` reply `v` is not every Markdown file of the watched
/// folder, or `None` when it is: the folder has more files than the app lists
/// (`truncated`), or its walk stopped early (`scanCut`, `depthCut`).
fn vault_files_cut_note(v: &Value) -> Option<String> {
    let truncated = v["truncated"].as_bool() == Some(true);
    let depth_cut = v["depthCut"].as_bool() == Some(true);
    let scan_cut = v["scanCut"].as_bool() == Some(true) || depth_cut;
    if !(truncated || scan_cut) {
        return None;
    }
    let n = v["limit"]
        .as_u64()
        .map(|n| format!("{n} "))
        .unwrap_or_default();
    let why = if depth_cut {
        "the watched folder is too deeply nested for Ashlr MD to scan in full (it enters \
         folders at most 8 levels down, and reads at most 50,000 entries)"
    } else if scan_cut {
        "the watched folder is too large for Ashlr MD to scan in full (it reads at most \
         50,000 entries)"
    } else {
        "the watched folder has more Markdown files than Ashlr MD lists"
    };
    Some(format!(
        "The vault's file:// resources are cut short: {why}, so only the {n}most recently \
         changed of the files it scanned are listed. Call search_vault to search the \
         folder."
    ))
}

/// The `_meta` key a `resources/list` result carries when the vault's
/// `file://` entries could not be listed (the app was unreachable or
/// refused), with the reason in words.
pub const VAULT_FILES_UNLISTED_META: &str = "mdopener/vaultFilesUnlisted";

/// The live document's text for `mdopener://current` and the prompts, or the
/// JSON-RPC error: `-32002` when no document is open (the app answers
/// `{ "path": null, "content": "" }`) or the app's answer has no `content`,
/// `-32000` when the app cannot be reached. An open document that is empty
/// is `""`. The resource used to answer `""` with no document open, so an
/// agent could not tell "nothing open" from "an empty document", while the
/// prompts already refused it.
fn current_document(ipc: &dyn IpcClient) -> Result<String, (i32, String)> {
    let v = ipc
        .get("/content")
        .map_err(|e| (-32000, app_not_running_msg(&e)))?;
    let no_document = v["path"].is_null();
    match v["content"].as_str() {
        Some(c) if !(c.is_empty() && no_document) => Ok(c.to_string()),
        _ if no_document => Err((-32002, NO_DOCUMENT_OPEN.to_string())),
        _ => Err((
            -32002,
            "Ashlr MD did not return the current document's content.".to_string(),
        )),
    }
}

/// The query parameters `text://vault-search` takes.
const VAULT_SEARCH_PARAMS: &[&str] = &["q", "limit", "semantic", "vault"];

pub fn handle_resource_read(id: Value, uri: &str, ipc: &dyn IpcClient) -> Response {
    if uri == "mdopener://current" {
        return match current_document(ipc) {
            Ok(text) => Response::ok(
                id,
                json!({
                    "contents": [{ "uri": uri, "mimeType": "text/markdown", "text": text }]
                }),
            ),
            Err((code, msg)) => Response::err(id, code, msg),
        };
    }

    // export:current was advertised by earlier builds as a live HTML preview
    // served from `/export/preview`, but the app has no such route. It is no
    // longer listed; reading it fails fast instead of surfacing an HTTP 404.
    if uri == EXPORT_CURRENT_URI {
        return Response::err(id, -32002, unavailable_resource_msg(uri));
    }

    // text://vault-search?q={query} — on-demand semantic/grep search resource.
    // Agents can read this URI to perform a search without calling the tool.
    // Only the URI itself or its `?query`: `text://vault-searchx` is some
    // other (unknown) resource, not this one.
    let vault_search_query = uri
        .strip_prefix("text://vault-search")
        .filter(|rest| rest.is_empty() || rest.starts_with('?'));
    if let Some(rest) = vault_search_query {
        // Parse query string: ?q=... (&limit=... optional)
        let qs = rest.strip_prefix('?').unwrap_or("");
        let mut query = String::new();
        let mut limit: u64 = 50;
        let mut vault = None;
        // `semantic=true|false` forces a mode, as `search_vault`'s `semantic`
        // argument does; absent, Ollama is auto-detected.
        let mut semantic = None;
        // Query-string encoding: `+` is a space (the listed example is
        // `?q=my+topic`), and `%2B` a literal plus.
        let lossy = |val: &str| {
            let val = val.replace('+', " ");
            urlencoding::decode(&val)
                .map(|s| s.into_owned())
                .unwrap_or(val)
        };
        // A malformed escape (`%ZZ`, a lone `%`) used to be searched for
        // literally, and a repeated parameter (`q=a&q=b`) kept only its
        // last value, so the search ran on something the agent never sent.
        let mut seen: Vec<&str> = Vec::new();
        for part in qs.split('&').filter(|p| !p.is_empty()) {
            let name = part.split('=').next().unwrap_or(part);
            if VAULT_SEARCH_PARAMS.contains(&name) && part.contains('=') {
                if seen.contains(&name) {
                    return Response::err(
                        id,
                        -32602,
                        format!(
                            "text://vault-search: `{name}` is given more than once; pass it once."
                        ),
                    );
                }
                seen.push(name);
                let val = &part[name.len() + 1..];
                if let Err(e) = percent_decode_path(&val.replace('+', " ")) {
                    return Response::err(
                        id,
                        -32602,
                        format!("text://vault-search: `{name}` is not valid URI encoding: {e}"),
                    );
                }
            }
        }
        let decode = lossy;
        for part in qs.split('&') {
            if let Some(val) = part.strip_prefix("q=") {
                query = decode(val);
            } else if let Some(val) = part.strip_prefix("vault=") {
                match disk_vault_dir(&decode(val)) {
                    Ok(dir) => vault = Some(dir),
                    Err(e) => return Response::err(id, -32602, e),
                }
            } else if let Some(val) = part.strip_prefix("semantic=") {
                semantic = match decode(val).as_str() {
                    "true" | "1" => Some(true),
                    "false" | "0" => Some(false),
                    other => {
                        return Response::err(
                            id,
                            -32602,
                            format!(
                                "text://vault-search: `semantic` must be true or false, got \
                                 {other:?}. Omit it to use semantic search when Ollama is available."
                            ),
                        )
                    }
                };
            } else if let Some(val) = part.strip_prefix("limit=") {
                limit = match val.parse() {
                    Ok(l) if (1..=SEARCH_MAX_RESULTS).contains(&l) => l,
                    _ => {
                        return Response::err(
                            id,
                            -32602,
                            format!(
                                "text://vault-search: `limit` must be a whole number from 1 \
                                 to {SEARCH_MAX_RESULTS}, got {:?}. Omit it for the default \
                                 of 50.",
                                decode(val)
                            ),
                        )
                    }
                };
            } else if !part.is_empty() {
                // A misspelt parameter (`lmit=5`) used to be dropped, so the
                // search ran with the default; tool arguments are refused the
                // same way.
                let name = part.split('=').next().unwrap_or(part);
                if VAULT_SEARCH_PARAMS.contains(&name) {
                    return Response::err(
                        id,
                        -32602,
                        format!("text://vault-search: `{name}` needs a value, as `{name}=…`."),
                    );
                }
                let hint = closest_name(name, VAULT_SEARCH_PARAMS)
                    .map(|n| format!(" Did you mean `{n}`?"))
                    .unwrap_or_default();
                return Response::err(
                    id,
                    -32602,
                    format!(
                        "text://vault-search: unknown query parameter `{name}`: it takes `q`, \
                         `limit`, `semantic` and `vault`.{hint}"
                    ),
                );
            }
        }
        if query.trim().is_empty() {
            return Response::err(
                id,
                -32602,
                "text://vault-search requires a query that is not only whitespace: \
                 text://vault-search?q=your+query",
            );
        }

        // The same search as `search_vault`, notes included. Without `vault`
        // every path needs the app (it supplies the vault file list), so
        // failing to reach it is an error rather than an empty result set.
        let semantic = semantic.unwrap_or_else(ollama_available);
        let found = search_vault_in(
            &query,
            limit,
            semantic,
            vault.as_deref(),
            ipc,
            &ollama_embed,
        );
        let mut payload = match found {
            Ok(v) => v,
            Err(e) => return Response::err(id, -32000, e),
        };
        payload["query"] = json!(query);
        return Response::ok(
            id,
            json!({
                "contents": [{
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": payload.to_string()
                }]
            }),
        );
    }

    // mdopener://recent-documents — scoped list of recently opened files.
    // Returns an array of { path, title, mtimeMs, preview } objects, pruned to
    // files that still exist on disk.  Preview is the first 200 chars of content.
    if uri == "mdopener://recent-documents" {
        return handle_recent_documents_resource(id, ipc);
    }

    if let Some(raw) = uri.strip_prefix("file://") {
        // `file://localhost/a` names the same file as `file:///a`.
        let raw = match raw.strip_prefix("localhost/") {
            Some(_) => &raw["localhost".len()..],
            None => raw,
        };
        // resources/list advertises `file://<path>` unencoded, but clients
        // percent-encode URIs (`My%20Notes.md`). The decoded path is what
        // must be advertised: the scope check runs after decoding, so
        // encoding cannot name a file outside the vault.
        // The vault listing is fetched once. When the app cannot be reached
        // nothing is advertised, and that used to be answered "not in vault",
        // as if the file were the problem.
        let listing = ipc.get("/vault");
        let advertised = |p: &str| listing.as_ref().is_ok_and(|v| lists_path(v, p));
        let p = if advertised(raw) {
            raw.to_string()
        } else {
            // A malformed escape (`%ZZ`, a lone `%`) or one that decodes to
            // invalid UTF-8 (`%FF`) used to be answered "not in vault", as if
            // the file were the problem.
            match percent_decode_path(raw) {
                Err(e) => {
                    return Response::err(id, -32602, format!("Invalid `file://` URI {uri}: {e}"))
                }
                Ok(d) if d != raw && advertised(&d) => d,
                Ok(_) => {
                    return match &listing {
                        Err(e) => Response::err(
                            id,
                            -32000,
                            format!(
                                "{} `file://` resources are the vault and recent files the app \
                                 lists, so none can be read without it.",
                                app_not_running_msg(e)
                            ),
                        ),
                        Ok(_) => Response::err(
                            id,
                            -32002,
                            format!(
                                "Resource not in vault: {uri}. Only the vault and recent files \
                                 resources/list names are served; open it with open_file first \
                                 to make it a recent file."
                            ),
                        ),
                    }
                }
            }
        };
        // Advertised is not enough: a vault `notes.md` that is a symlink to
        // `~/.ssh/id_rsa` or `.env` used to be served. Like the tools that
        // read a path from disk, only a Markdown non-dotfile is read, checked
        // after resolving symlinks.
        // Read the checked (canonical) path: reading `p` again would follow
        // a link re-pointed after the check.
        let checked = match checked_document(&p, "uri") {
            Ok(c) => c,
            Err(e) => return Response::err(id, -32002, e),
        };
        return match checked.read() {
            Ok(text) => Response::ok(
                id,
                json!({
                    "contents": [{ "uri": uri, "mimeType": "text/markdown", "text": text }]
                }),
            ),
            Err(e) => Response::err(id, -32002, format!("Cannot read {p}: {e}")),
        };
    }
    Response::err(id, -32602, unknown_resource_msg(uri))
}

/// Percent-decode the path of a `file://` URI, refusing a `%` that is not
/// followed by two hex digits and escapes that do not decode to UTF-8 (which
/// `urlencoding::decode` would pass through or reject without saying where).
fn percent_decode_path(raw: &str) -> Result<String, String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok());
            match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(b) => {
                    out.push(b);
                    i += 3;
                    continue;
                }
                None => {
                    let shown: String = raw[i..].chars().take(3).collect();
                    return Err(format!(
                        "`{shown}` is not a percent-encoded byte (`%` must be followed by two \
                         hex digits; write a literal `%` as `%25`)."
                    ));
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).map_err(|_| "its percent-encoded bytes are not valid UTF-8.".to_string())
}

/// Resource URIs `resources/read` serves besides advertised `file://` paths.
const FIXED_RESOURCE_URIS: &[&str] = &[
    "mdopener://current",
    "mdopener://recent-documents",
    "text://vault-search",
];

/// The `-32602` message for a URI `resources/read` does not serve: the
/// closest served URI when there is one, and where the list is.
pub fn unknown_resource_msg(uri: &str) -> String {
    let shown = if uri.trim().is_empty() {
        "Unknown resource: `uri` is missing or blank.".to_string()
    } else {
        format!("Unknown resource URI: {uri}.")
    };
    let hint = closest_name(uri, FIXED_RESOURCE_URIS)
        .map(|u| format!(" Did you mean `{u}`?"))
        .unwrap_or_default();
    format!("{shown}{hint} Call resources/list for the resources this server provides.")
}

/// True if `path` is one of the files the app currently advertises as part of
/// the vault or recents (queried live). Used to scope `resources/read`.
pub fn is_advertised_path(path: &str, ipc: &dyn IpcClient) -> bool {
    ipc.get("/vault").is_ok_and(|v| lists_path(&v, path))
}

/// True if the app's `/vault` reply `v` lists `path` among its files or
/// recents.
fn lists_path(v: &Value, path: &str) -> bool {
    let in_files = v["files"]
        .as_array()
        .map(|a| a.iter().any(|f| f["path"].as_str() == Some(path)))
        .unwrap_or(false);
    let in_recents = v["recents"]
        .as_array()
        .map(|a| a.iter().any(|r| r.as_str() == Some(path)))
        .unwrap_or(false);
    in_files || in_recents
}

// ── Prompts ───────────────────────────────────────────────────────────────────

/// What every prompt's `prompts/list` description says after its own line:
/// no prompt takes arguments, and each needs an open document (as
/// docs/AGENTS.md says). Agents used to learn both from an error.
pub const PROMPT_USAGE_NOTE: &str = "Takes no arguments: it works on the document open in Ashlr MD, so open the one you mean with open_file first. With no document open it fails with -32002 (\"No document is open\"), and with -32000 when the app is not running.";

pub fn prompts_list() -> Value {
    let described = |what: &str| format!("{what} {PROMPT_USAGE_NOTE}");
    json!([
        { "name": "summarize", "description": described("Summarize the current document into key points.") },
        { "name": "review_plan", "description": described("Review the current document as a plan and flag risks, gaps, and unclear steps.") },
        { "name": "improve_writing", "description": described("Tighten the prose of the current document without changing its meaning.") }
    ])
}

/// The prompts `prompts/get` serves, in `prompts/list` order.
pub const PROMPT_NAMES: &[&str] = &["summarize", "review_plan", "improve_writing"];

/// The `-32602` message for a `prompts/get` name that is not a prompt: the
/// closest prompt when there is one, and every prompt name (there are few).
pub fn unknown_prompt_msg(name: &str) -> String {
    let shown = if name.trim().is_empty() {
        "Unknown prompt: `name` is missing or blank.".to_string()
    } else {
        format!("Unknown prompt: {name}.")
    };
    let hint = closest_name(name, PROMPT_NAMES)
        .map(|n| format!(" Did you mean `{n}`?"))
        .unwrap_or_default();
    let all = PROMPT_NAMES
        .iter()
        .map(|n| format!("`{n}`"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{shown}{hint} The prompts are {all} (see prompts/list).")
}

/// Why `prompts/get`'s `arguments` cannot be used, or `None`. No prompt
/// declares an argument, so any given one used to be dropped in silence while
/// the prompt ran on the open document. Omitted, `null` or `{}` is fine. An
/// unknown prompt name is left to [`handle_prompt_get`], which names it first.
pub fn prompt_arguments_problem(name: &str, arguments: &Value) -> Option<String> {
    if !PROMPT_NAMES.contains(&name) {
        return None;
    }
    match arguments {
        Value::Null => None,
        Value::Object(m) if m.is_empty() => None,
        Value::Object(m) => {
            let mut keys: Vec<&str> = m.keys().map(String::as_str).collect();
            keys.sort_unstable();
            let given = keys
                .iter()
                .map(|k| format!("`{k}`"))
                .collect::<Vec<_>>()
                .join(", ");
            Some(format!(
                "Prompt `{name}` takes no arguments, got {given}. It works on the document \
                 open in Ashlr MD: open the one you mean with open_file first, then get the \
                 prompt without `arguments`."
            ))
        }
        other => Some(format!(
            "`arguments` for prompt `{name}` must be an object, got {}",
            json_type_phrase(other)
        )),
    }
}

pub fn handle_prompt_get(id: Value, name: &str, ipc: &dyn IpcClient) -> Response {
    let instruction = match name {
        "summarize" => {
            "Summarize the following Markdown document into a short bulleted list of its key points:"
        }
        "review_plan" => {
            "Review the following Markdown document as an implementation plan. Identify risks, missing steps, and anything ambiguous:"
        }
        "improve_writing" => {
            "Improve the writing of the following Markdown document. Tighten prose and fix grammar without changing its meaning or structure:"
        }
        other => return Response::err(id, -32602, unknown_prompt_msg(other)),
    };
    // Without the live document the prompt would ask the model to work on an
    // empty string, so a missing app or document is an error, not "".
    let content = match current_document(ipc) {
        Ok(c) => c,
        Err((code, msg)) => return Response::err(id, code, msg),
    };
    let text = format!("{instruction}\n\n---\n\n{content}");

    Response::ok(
        id,
        json!({
            "description": format!("Apply the '{name}' prompt to the current Ashlr MD document"),
            "messages": [{ "role": "user", "content": { "type": "text", "text": text } }]
        }),
    )
}

// ── Semantic search engine ────────────────────────────────────────────────────

/// A single search result returned by semantic or grep search.
#[derive(Serialize, Debug, Clone)]
pub struct SearchResult {
    pub path: String,
    pub snippet: String,
    #[serde(rename = "lineNumber")]
    pub line_number: usize,
    pub score: f64,
}

impl SearchResult {
    pub fn to_json(&self) -> Value {
        json!({
            "path": self.path,
            "snippet": self.snippet,
            "lineNumber": self.line_number,
            "score": self.score
        })
    }
}

/// Probe whether Ollama is reachable on the default port (11434).
/// Returns true only if a TCP connection succeeds within 200 ms.
pub fn ollama_available() -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    TcpStream::connect_timeout(
        &"127.0.0.1:11434".parse().unwrap(),
        Duration::from_millis(200),
    )
    .is_ok()
}

/// Fetch an embedding vector for `text` from the Ollama REST API using
/// the `nomic-embed-text` model.  Returns `Err` when Ollama is unavailable
/// or the response cannot be parsed.
pub fn ollama_embed(text: &str) -> Result<Vec<f64>, String> {
    let body = json!({ "model": "nomic-embed-text", "prompt": text });
    match http_post("http://127.0.0.1:11434/api/embeddings", &body, "") {
        Ok(v) => {
            let emb = v["embedding"]
                .as_array()
                .ok_or("Ollama response missing 'embedding' field")?;
            let vec: Vec<f64> = emb.iter().filter_map(|x| x.as_f64()).collect();
            if vec.is_empty() {
                Err("Ollama returned an empty embedding vector".to_string())
            } else {
                Ok(vec)
            }
        }
        Err(e) => Err(format!("Ollama embed request failed: {e}")),
    }
}

/// Cosine similarity between two equal-length vectors.  Returns 0.0 if
/// either is empty or they have different lengths.
pub fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f64 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let mag_a: f64 = a.iter().map(|x| x * x).sum::<f64>().sqrt();
    let mag_b: f64 = b.iter().map(|x| x * x).sum::<f64>().sqrt();
    if mag_a == 0.0 || mag_b == 0.0 {
        0.0
    } else {
        dot / (mag_a * mag_b)
    }
}

/// Canonicalize a path string, returning the input unchanged on failure.
pub fn canonicalize_path(raw: &str) -> String {
    std::fs::canonicalize(raw)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

/// Read a file as UTF-8 text, refusing anything that is not a regular file
/// (after following symlinks). Opening a FIFO for reading blocks until a
/// writer appears, and a device or socket is never a document, so every disk
/// read goes through here rather than `std::fs::read_to_string`. The file is
/// opened non-blocking and judged by the opened handle, so a FIFO put in its
/// place after the check cannot block the read either.
pub fn read_regular_file(path: impl AsRef<std::path::Path>) -> std::io::Result<String> {
    use std::io::Read as _;
    let path = path.as_ref();
    if !std::fs::metadata(path)?.is_file() {
        return Err(not_regular());
    }
    let mut file = open_for_read(path, false)?;
    if !file.metadata()?.is_file() {
        return Err(not_regular());
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

fn not_regular() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a regular file")
}

/// Open `path` for reading without blocking on a FIFO (Unix `O_NONBLOCK`,
/// which has no effect on reads of a regular file) and, with `no_follow`,
/// without following a symlink in its last component (`O_NOFOLLOW`: such a
/// link is refused with "it is a symbolic link"). Elsewhere a plain open.
fn open_for_read(path: &std::path::Path, no_follow: bool) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut flags = libc::O_NONBLOCK;
        if no_follow {
            flags |= libc::O_NOFOLLOW;
        }
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(flags)
            .open(path)
            .map_err(|e| {
                // ELOOP on Linux and macOS, EMLINK on FreeBSD.
                let link = matches!(e.raw_os_error(), Some(libc::ELOOP) | Some(libc::EMLINK));
                if no_follow && link {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "it is a symbolic link (it was replaced by one after it was checked)",
                    )
                } else {
                    e
                }
            })
    }
    #[cfg(not(unix))]
    {
        let _ = no_follow;
        std::fs::File::open(path)
    }
}

/// Which file a path named when it was checked: its device and inode on
/// Unix, compared with those of the file a read then opens. Elsewhere it
/// carries nothing and every file matches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileIdentity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

impl FileIdentity {
    pub fn of(meta: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            FileIdentity {
                dev: meta.dev(),
                ino: meta.ino(),
            }
        }
        #[cfg(not(unix))]
        {
            let _ = meta;
            FileIdentity {}
        }
    }
}

/// A document path that passed [`checked_document`], with the identity of
/// the file it named then (`None` when it did not exist). Read it with
/// [`CheckedDocument::read`], never by reopening `path` some other way.
#[derive(Clone, Debug)]
pub struct CheckedDocument {
    /// The canonical path.
    pub path: String,
    identity: Option<FileIdentity>,
}

impl CheckedDocument {
    /// [`read_document_file`], refusing the file unless it is the one that
    /// was checked.
    pub fn read(&self) -> std::io::Result<String> {
        read_document_at(std::path::Path::new(&self.path), self.identity)
    }
}

/// Largest document (Markdown or canvas file) a tool or resource reads from
/// disk: the 16 MiB the app accepts in one IPC request, so nothing larger
/// could be opened or sent to it anyway. Without it a multi-gigabyte `.md`
/// was read whole into memory and returned whole to the agent.
pub const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;

/// [`read_regular_file`] for a document, refusing one larger than
/// [`MAX_DOCUMENT_BYTES`] (before reading it, and if it grows while read).
/// `path` is a canonical path (every caller resolves it first), so on Unix a
/// symlink in its last component is refused rather than followed, and the
/// file opened must be the one `lstat` saw just before: a component swapped
/// for a link in between is not followed to another file.
pub fn read_document_file(path: impl AsRef<std::path::Path>) -> std::io::Result<String> {
    read_document_at(path.as_ref(), None)
}

/// [`read_document_file`], also requiring the opened file to be `expected`
/// (the file a check saw) when given. The check and the read each resolve
/// the path, so between them a final or intermediate component swapped for
/// a symlink would otherwise be followed: `notes.md` re-pointed at
/// `~/.ssh/id_rsa`, or the folder above it at another folder.
fn read_document_at(
    path: &std::path::Path,
    expected: Option<FileIdentity>,
) -> std::io::Result<String> {
    use std::io::Read as _;
    let changed = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "it changed after it was checked (a link or another file took its place), \
             so it was not read",
        )
    };
    #[cfg(unix)]
    let before = std::fs::symlink_metadata(path)?;
    #[cfg(not(unix))]
    let before = std::fs::metadata(path)?;
    if before.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "it is a symbolic link (it was replaced by one after it was checked)",
        ));
    }
    if !before.is_file() {
        return Err(not_regular());
    }
    let seen = FileIdentity::of(&before);
    if expected.is_some_and(|e| e != seen) {
        return Err(changed());
    }
    let file = open_for_read(path, true)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(not_regular());
    }
    if FileIdentity::of(&meta) != seen {
        return Err(changed());
    }
    let too_large = |len: u64| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "it is {:.1} MiB, more than the {} MiB a document may be",
                len as f64 / (1024.0 * 1024.0),
                MAX_DOCUMENT_BYTES / (1024 * 1024)
            ),
        )
    };
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err(too_large(meta.len()));
    }
    let mut text = String::new();
    file.take(MAX_DOCUMENT_BYTES + 1)
        .read_to_string(&mut text)?;
    if text.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(too_large(text.len() as u64));
    }
    Ok(text)
}

/// Markdown extensions a path-taking read tool may open. Mirrors the app's
/// `MD_EXTENSIONS` (src-tauri/src/document.rs).
pub const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];

/// Resolve a caller-supplied path for a tool that reads a document straight
/// from disk (no app involved), refusing anything that is not a Markdown
/// document. The check runs on the canonical path, so a `notes.md` symlink to
/// `.env` is refused too. Dotfiles (`.env.md`, `.secrets.md`) are refused even
/// with a Markdown extension, and so is anything that exists but is not a
/// regular file (a FIFO named `x.md` would block the read forever). Returns
/// the canonical path, or a message for an `isError` result. A caller that
/// then reads the file uses [`checked_document`] instead, which also says
/// which file was checked.
pub fn checked_document_path(raw: &str, arg: &str) -> Result<String, String> {
    checked_document(raw, arg).map(|c| c.path)
}

/// [`checked_document_path`], keeping the identity of the file checked so
/// that [`CheckedDocument::read`] reads that file and no other.
pub fn checked_document(raw: &str, arg: &str) -> Result<CheckedDocument, String> {
    checked_document_for(raw, arg, Use::Read)
}

/// What a tool does with a checked document, for the words of a refusal:
/// a tool that asks the app to open a file says it refuses to open it, not
/// to read it.
#[derive(Clone, Copy)]
enum Use {
    Read,
    Open,
    Present,
    Review,
}

impl Use {
    /// The verb and its past participle: "read"/"read", "open"/"opened".
    fn words(self) -> (&'static str, &'static str) {
        match self {
            Use::Read => ("read", "read"),
            Use::Open => ("open", "opened"),
            Use::Present => ("present", "presented"),
            Use::Review => ("review", "reviewed"),
        }
    }
}

fn checked_document_for(raw: &str, arg: &str, why: Use) -> Result<CheckedDocument, String> {
    let (verb, done) = why.words();
    let abs = canonicalize_path(raw);
    let p = std::path::Path::new(&abs);
    let hidden = p
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(true);
    let markdown = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    // A directory used to be refused as "only Markdown documents ... can be
    // opened", which did not say what was wrong with it or what to pass.
    if p.is_dir() {
        return Err(format!(
            "Refusing to {verb} `{arg}` '{abs}': it is a directory, not a file. \
             Pass a Markdown file in it."
        ));
    }
    if hidden || !markdown {
        return Err(format!(
            "Refusing to {verb} `{arg}` '{abs}': only Markdown documents ({}) that are not \
             dotfiles can be {done}.",
            MD_EXTENSIONS
                .iter()
                .map(|e| format!(".{e}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    // The canonical path names no link, so on Unix it is judged without
    // following one: a link here now was put in place since it was resolved.
    #[cfg(unix)]
    let meta = std::fs::symlink_metadata(p);
    #[cfg(not(unix))]
    let meta = std::fs::metadata(p);
    // A missing file falls through so the caller reports "No such file".
    let identity = match meta {
        Ok(meta) if meta.is_file() => Some(FileIdentity::of(&meta)),
        Ok(_) => {
            return Err(format!(
                "Refusing to {verb} `{arg}` '{abs}': it is not a regular file."
            ))
        }
        Err(_) => None,
    };
    Ok(CheckedDocument {
        path: abs,
        identity,
    })
}

/// Collect candidate file paths from the vault and recents advertised by the
/// app.  The list comes from the app over IPC, so this errors when the app is
/// not running (an empty list would read as "no matches").
pub fn vault_file_paths(ipc: &dyn IpcClient) -> Result<Vec<String>, String> {
    vault_listing(ipc).map(|l| l.paths)
}

/// [`vault_file_paths`], and whether the app said its vault list is cut
/// short (the watched folder has more files than it lists).
/// The app's `/vault` reply: the listed files and recents, whether the list
/// was cut short, the cap it was cut at, and whether the app's walk of the
/// folder stopped early.
struct VaultListing {
    paths: Vec<String>,
    truncated: bool,
    limit: Option<u64>,
    scan_cut: bool,
    /// The walk skipped folders below its depth limit; `None` from an older
    /// app that does not tell the two limits apart.
    depth_cut: Option<bool>,
}

fn vault_listing(ipc: &dyn IpcClient) -> Result<VaultListing, String> {
    let v = ipc.get("/vault")?;
    let truncated = v["truncated"].as_bool() == Some(true);
    let limit = v["limit"].as_u64();
    let depth_cut = v["depthCut"].as_bool();
    let scan_cut = v["scanCut"].as_bool() == Some(true) || depth_cut == Some(true);
    let mut paths = Vec::new();
    if let Some(files) = v["files"].as_array() {
        for f in files {
            if let Some(p) = f["path"].as_str() {
                paths.push(canonicalize_path(p));
            }
        }
    }
    if let Some(recents) = v["recents"].as_array() {
        for r in recents {
            if let Some(p) = r.as_str() {
                let cp = canonicalize_path(p);
                if !paths.contains(&cp) {
                    paths.push(cp);
                }
            }
        }
    }
    Ok(VaultListing {
        paths,
        truncated,
        limit,
        scan_cut,
        depth_cut,
    })
}

/// Turns text into an embedding vector: [`ollama_embed`] in the server.
pub type Embedder<'a> = &'a dyn Fn(&str) -> Result<Vec<f64>, String>;

/// Perform semantic search: embed the query and each candidate document,
/// rank by cosine similarity, return top-`limit` results sorted by score.
///
/// Errors if Ollama is not reachable or embedding the query fails.
pub fn semantic_search_vault(
    query: &str,
    limit: u64,
    ipc: &dyn IpcClient,
) -> Result<Vec<Value>, String> {
    semantic_search_vault_with(query, limit, ipc, &ollama_embed)
}

/// [`semantic_search_vault`] with the embedder injected. A document whose
/// embedding fails is skipped, but when every embedding fails this is an
/// error: an empty result would read as "nothing in the vault is related",
/// when nothing was compared at all.
pub fn semantic_search_vault_with(
    query: &str,
    limit: u64,
    ipc: &dyn IpcClient,
    embed: Embedder,
) -> Result<Vec<Value>, String> {
    semantic_hits(query, limit, &vault_file_paths(ipc)?, embed).map(|hits| hits.results)
}

/// What [`semantic_hits`] found, and how many documents it had to leave out
/// because their embedding failed.
struct SemanticHits {
    results: Vec<Value>,
    /// Documents read but not ranked: embedding them failed.
    skipped: usize,
    /// Documents that were embedded and ranked.
    compared: usize,
    /// The last embedding error, quoted in the note.
    skip_error: Option<String>,
}

impl SemanticHits {
    /// Says how many documents the results leave out, so an agent does not
    /// read their absence as "unrelated to the query".
    fn skipped_note(&self) -> Option<String> {
        let e = self.skip_error.as_deref()?;
        let n = self.skipped;
        let total = n + self.compared;
        let docs = if n == 1 {
            "document was"
        } else {
            "documents were"
        };
        Some(format!(
            "{n} of {total} {docs} left out of these semantic results because \
             embedding failed ({e})."
        ))
    }
}

fn semantic_hits(
    query: &str,
    limit: u64,
    paths: &[String],
    embed: Embedder,
) -> Result<SemanticHits, String> {
    let query_vec = embed(query)?;
    let mut scored: Vec<SearchResult> = Vec::new();
    let mut embed_error = None;
    let mut skipped = 0;

    for path in paths {
        let Some(content) = searchable_document(path) else {
            continue;
        };
        // Truncate to first 8 KB to stay within typical embedding context limits.
        let truncated: String = content.chars().take(8192).collect();
        let doc_vec = match embed(&truncated) {
            Ok(v) => v,
            Err(e) => {
                embed_error = Some(e);
                skipped += 1;
                continue;
            }
        };
        let score = cosine_similarity(&query_vec, &doc_vec);
        let (line_number, snippet) = best_snippet_for_query(&content, query);
        scored.push(SearchResult {
            path: path.clone(),
            snippet,
            line_number,
            score,
        });
    }

    if let (true, Some(e)) = (scored.is_empty(), &embed_error) {
        return Err(format!("embedding every document failed: {e}"));
    }

    let compared = scored.len();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(limit as usize);
    Ok(SemanticHits {
        results: scored.iter().map(|r| r.to_json()).collect(),
        skipped,
        compared,
        skip_error: embed_error,
    })
}

/// Grep the vault files directly on disk (used when the app's own `/search`
/// fails).  The file list still comes from the app, so this errors when the
/// app is not running.
/// The text of a vault or recent file a search may read, or `None` when it
/// is not a Markdown document that is not a dotfile (judged after resolving
/// symlinks, and read from the resolved path) or cannot be read. Recents are
/// whatever the human opened, and the grep and semantic searches used to read
/// every one, returning lines of a dropped `.env` or of a `notes.md` link to
/// `~/.ssh/id_rsa` that every other read refuses.
fn searchable_document(path: &str) -> Option<String> {
    checked_document(path, "path").ok()?.read().ok()
}

pub fn grep_vault(query: &str, limit: u64, ipc: &dyn IpcClient) -> Result<Vec<Value>, String> {
    Ok(grep_paths(query, limit, &vault_file_paths(ipc)?))
}

/// Grep `paths` on disk for `query` (case-insensitive), best match ratio first.
fn grep_paths(query: &str, limit: u64, paths: &[String]) -> Vec<Value> {
    let lower_query = query.to_lowercase();
    let mut results: Vec<SearchResult> = Vec::new();

    for path in paths {
        let Some(content) = searchable_document(path) else {
            continue;
        };
        let mut match_count = 0usize;
        let mut first_line = 0usize;
        let mut first_snippet = String::new();
        for (idx, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&lower_query) {
                match_count += 1;
                if first_snippet.is_empty() {
                    first_line = idx + 1;
                    first_snippet = line.chars().take(200).collect();
                }
            }
        }
        if match_count > 0 {
            let total_lines = content.lines().count().max(1);
            let score = (match_count as f64 / total_lines as f64).min(1.0);
            results.push(SearchResult {
                path: path.clone(),
                snippet: first_snippet,
                line_number: first_line,
                score,
            });
        }
    }

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(limit as usize);
    results.iter().map(|r| r.to_json()).collect()
}

/// Find the line in `content` most relevant to `query` (case-insensitive
/// substring match first; falls back to first non-empty line).
/// Returns `(1-based line number, snippet text)`.
pub fn best_snippet_for_query(content: &str, query: &str) -> (usize, String) {
    let lower = query.to_lowercase();
    for (idx, line) in content.lines().enumerate() {
        if line.to_lowercase().contains(&lower) {
            return (idx + 1, line.chars().take(200).collect());
        }
    }
    for (idx, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return (idx + 1, trimmed.chars().take(200).collect());
        }
    }
    (1, String::new())
}

// ── IPC helpers ───────────────────────────────────────────────────────────────

/// Read the port written by the running app.
pub fn read_ipc_port() -> Result<u16, String> {
    let path = mdopener_file_in(dirs::home_dir(), "ipc-port")?;

    let content =
        std::fs::read_to_string(&path).map_err(|_| "~/.mdopener/ipc-port not found".to_string())?;

    content
        .trim()
        .parse::<u16>()
        .map_err(|e| format!("Invalid port in ipc-port file: {e}"))
}

/// The error when `~/.mdopener/ipc-token` exists but holds no token: the
/// app writes it while launching. It used to ask "Has Ashlr MD finished
/// starting?" and stop there; like [`app_not_running_msg`] it now names the
/// next step.
pub const IPC_TOKEN_EMPTY: &str = "~/.mdopener/ipc-token is empty, so Ashlr MD has not \
    finished starting. Retry once it has finished launching, or restart Ashlr MD if the \
    token stays empty.";

/// Read the per-session auth token written by the running app.
pub fn read_ipc_token() -> Result<String, String> {
    let path = mdopener_file_in(dirs::home_dir(), "ipc-token")?;
    std::fs::read_to_string(&path)
        .map_err(|_| "~/.mdopener/ipc-token not found".to_string())
        .and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                Err(IPC_TOKEN_EMPTY.to_string())
            } else {
                Ok(t)
            }
        })
}

/// Make a GET request to the IPC server and return the parsed JSON body.
pub fn ipc_get(path: &str) -> Result<Value, String> {
    let port = read_ipc_port()?;
    let token = read_ipc_token()?;
    let url = format!("http://127.0.0.1:{port}{path}");
    http_get(&url, &token)
}

/// Make a POST request with a JSON body and return the parsed JSON response.
pub fn ipc_post(path: &str, body: Value) -> Result<Value, String> {
    let port = read_ipc_port()?;
    let token = read_ipc_token()?;
    let url = format!("http://127.0.0.1:{port}{path}");
    http_post(&url, &body, &token)
}

// Minimal HTTP client using only std (no reqwest/ureq to keep the binary tiny).
pub fn http_get(url: &str, token: &str) -> Result<Value, String> {
    let (host, port, path) = parse_url(url)?;
    let request = format!(
        "GET {path} HTTP/1.0\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    let response_body = tcp_roundtrip(&host, port, request.as_bytes())?;
    parse_http_body(&response_body)
}

pub fn http_post(url: &str, body: &Value, token: &str) -> Result<Value, String> {
    http_post_within(url, body, token, IPC_READ_TIMEOUT)
}

/// How long an IPC request waits for the app's answer by default.
pub const IPC_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// [`http_post`] waiting up to `read_timeout` for the answer.
pub fn http_post_within(
    url: &str,
    body: &Value,
    token: &str,
    read_timeout: std::time::Duration,
) -> Result<Value, String> {
    let (host, port, path) = parse_url(url)?;
    let body_str = body.to_string();
    let request = format!(
        "POST {path} HTTP/1.0\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body_str}",
        body_str.len()
    );
    let response_body = tcp_roundtrip_within(&host, port, request.as_bytes(), read_timeout)?;
    parse_http_body(&response_body)
}

pub fn parse_url(url: &str) -> Result<(String, u16, String), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or("Only http:// supported")?;
    let (authority, path) = rest
        .split_once('/')
        .map(|(a, p)| (a, format!("/{p}")))
        .unwrap_or((rest, "/".to_string()));
    let (host, port_str) = authority.split_once(':').ok_or("Expected host:port")?;
    let port = port_str
        .parse::<u16>()
        .map_err(|e| format!("Invalid port: {e}"))?;
    Ok((host.to_string(), port, path))
}

pub fn tcp_roundtrip(host: &str, port: u16, request: &[u8]) -> Result<Vec<u8>, String> {
    tcp_roundtrip_within(host, port, request, IPC_READ_TIMEOUT)
}

/// [`tcp_roundtrip`] waiting up to `read_timeout` for the answer.
pub fn tcp_roundtrip_within(
    host: &str,
    port: u16,
    request: &[u8],
    read_timeout: std::time::Duration,
) -> Result<Vec<u8>, String> {
    use std::io::{Read as _, Write as _};
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = format!("{host}:{port}");
    let mut stream = TcpStream::connect(&addr)
        .map_err(|e| format!("Could not connect to IPC server at {addr}: {e}"))?;
    stream.set_read_timeout(Some(read_timeout)).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    stream
        .write_all(request)
        .map_err(|e| format!("IPC write error: {e}"))?;

    let mut buf = Vec::new();
    // Bounded: the read timeout applies to each read, not the whole answer,
    // so a peer that keeps sending (whatever listens on the port, e.g. a
    // stray server on Ollama's) was read into memory without end.
    (&mut stream)
        .take(MAX_HTTP_RESPONSE_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| {
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) {
                format!(
                    "IPC read error: Ashlr MD did not answer within {} s",
                    read_timeout.as_secs()
                )
            } else {
                format!("IPC read error: {e}")
            }
        })?;
    if buf.len() as u64 > MAX_HTTP_RESPONSE_BYTES {
        return Err(format!(
            "IPC read error: the answer from {addr} is more than {} MiB, so it was not read",
            MAX_HTTP_RESPONSE_BYTES / (1024 * 1024)
        ));
    }
    Ok(buf)
}

/// Largest HTTP answer (headers and body) the server reads from the app or
/// Ollama: room for a 16 MiB document ([`MAX_DOCUMENT_BYTES`]) JSON-escaped
/// several times over, far above any real answer.
pub const MAX_HTTP_RESPONSE_BYTES: u64 = 4 * MAX_DOCUMENT_BYTES;

pub fn parse_http_body(raw: &[u8]) -> Result<Value, String> {
    let sep = b"\r\n\r\n";
    let body_start = raw
        .windows(sep.len())
        .position(|w| w == sep)
        .map(|p| p + sep.len())
        .unwrap_or(0);

    if let Ok(head) = std::str::from_utf8(&raw[..body_start]) {
        if let Some(code) = head
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse::<u16>().ok())
        {
            if code == 401 {
                return Err(
                    "IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token".to_string(),
                );
            }
            if code >= 400 {
                // The app's error responses are `{"error": "<reason>"}`.
                let reason = serde_json::from_slice::<Value>(&raw[body_start..])
                    .ok()
                    .and_then(|v| v["error"].as_str().map(str::to_string));
                return Err(match reason {
                    Some(r) => format!("IPC server returned HTTP {code}: {r}"),
                    None => format!("IPC server returned HTTP {code}"),
                });
            }
        }
    }

    let body = &raw[body_start..];
    serde_json::from_slice(body).map_err(|e| format!("IPC JSON parse error: {e}"))
}

// ── Response helpers ──────────────────────────────────────────────────────────

/// An integer argument's value, `None` when absent or null. A whole number
/// written as a float (`2.0`) is that number. [`check_tool_arguments`] has
/// already refused any other type, a fraction and a negative, so `None` here
/// only ever means "not given".
pub fn whole_number(args: &Value, name: &str) -> Option<u64> {
    whole_number_value(&args[name])
}

/// `args[name]` as a string, `None` when absent (or not a string, which the
/// schema check refuses first). An empty or blank (only whitespace) string
/// is refused with the message the other tools use, "`name` must not be
/// empty": as a path it used to reach the file checks, which answered with
/// misleading errors such as "only Markdown documents can be read" or "No
/// such file or directory". Only for paths, ids and names, where whitespace
/// alone names nothing; never for document or replacement text.
fn non_blank_str<'a>(args: &'a Value, name: &str) -> Result<Option<&'a str>, String> {
    match args[name].as_str() {
        Some(s) if s.trim().is_empty() => Err(format!("`{name}` must not be empty")),
        s => Ok(s),
    }
}

fn whole_number_value(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| {
        v.as_f64()
            .filter(|f| *f >= 0.0 && f.fract() == 0.0 && *f <= u64::MAX as f64)
            .map(|f| f as u64)
    })
}

/// Wrap a value in the MCP `content` envelope.
pub fn tool_result(id: Value, value: Value) -> Response {
    Response::ok(
        id,
        json!({
            "content": [{ "type": "text", "text": value.to_string() }],
            "isError": false
        }),
    )
}

/// A tool execution error: the app is unreachable, a file cannot be read or
/// written, or the operation was rejected. Per the MCP spec these come back as
/// a successful `tools/call` result with `isError: true` so the agent sees the
/// message and can act on it. JSON-RPC errors are reserved for protocol
/// problems: an unknown tool or invalid arguments (`-32602`).
pub fn tool_error(id: Value, message: String) -> Response {
    Response::ok(
        id,
        json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true
        }),
    )
}

/// Say once that the app is not running, with the low-level reason in
/// parentheses. The reasons are bare facts (`~/.mdopener/ipc-port not
/// found`): they used to ask "Is Ashlr MD running?" themselves, so the
/// message said it twice.
pub fn app_not_running_msg(err: &str) -> String {
    not_running_msg(err, None)
}

/// [`app_not_running_msg`] for a tool that was given `path`: the next step
/// is the `open_file` call with that path, written out so the agent can copy
/// it. The generic "use open_file which can start it" left the agent to work
/// out the arguments.
pub fn app_not_running_msg_for(err: &str, path: Option<&str>) -> String {
    not_running_msg(err, path)
}

fn not_running_msg(err: &str, path: Option<&str>) -> String {
    // The app refused this server's token: say why and what fixes it.
    if app_auth_failed(err) {
        return APP_AUTH_FAILED_MSG.to_string();
    }
    // The running app refused the request: its reason (which may quote a
    // path containing "connect" or "not found") is the agent's to see as is.
    if app_refused(err) {
        return err.to_string();
    }
    if err.contains("ipc-port") || err.contains("not found") || err.contains("connect") {
        let next = match path {
            Some(p) => format!(
                "Call open_file with {}, which starts it with this document, then call \
                 this tool again.",
                json!({ "path": p })
            ),
            None => {
                "Launch it first, or use open_file which can start it automatically.".to_string()
            }
        };
        format!(
            "Ashlr MD does not appear to be running ({err}). {next} If it \
             is not installed, ask the user to install it from \
             https://github.com/ashlrai/ashlr-md/releases."
        )
    } else {
        err.to_string()
    }
}

// ── list_recent_documents resource handler ────────────────────────────────────

/// Build the `mdopener://recent-documents` resource response.
///
/// Queries the app's `/vault` IPC endpoint for `recents` (a string array of
/// paths), reads each file from disk, and returns a JSON array of:
///
/// ```json
/// { "path": "...", "title": "...", "mtimeMs": 1234567890, "preview": "..." }
/// ```
///
/// `title` is derived from the first `# Heading` line if present, otherwise
/// the file's base name without extension.  `preview` is the first 200 chars
/// of raw content (including front-matter).  Recents that cannot be listed
/// are left out, and `skipped` counts them by reason: `missing` (no longer
/// on disk), `notDocument` (not a Markdown non-dotfile regular file),
/// `tooLarge` (past [`MAX_DOCUMENT_BYTES`]) and `unreadable` (any other read
/// failure, such as text that is not UTF-8). They used to be dropped without
/// a count, so a short list could not be told from a short recents list.
pub fn handle_recent_documents_resource(id: Value, ipc: &dyn IpcClient) -> Response {
    // Fetch the recent paths from the app. An app that cannot be reached (or
    // refuses) is an error, as for `mdopener://current`: it used to answer an
    // empty list, the same as an app with no recents, so the agent was told
    // there were none when it could not know.
    let recent_paths: Vec<String> = match ipc.get("/vault") {
        Ok(v) => v["recents"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        Err(e) => return Response::err(id, -32000, app_not_running_msg(&e)),
    };

    let mut documents: Vec<Value> = Vec::new();
    let (mut missing, mut not_document, mut too_large, mut unreadable) = (0u64, 0u64, 0u64, 0u64);
    for path in &recent_paths {
        // Skip a recent that is (or now links to) something other than a
        // Markdown non-dotfile, as `file://` reads do: its preview would
        // otherwise show the first 200 characters of the link's target.
        let Ok(doc) = checked_document(path, "path") else {
            not_document += 1;
            continue;
        };
        // Skip paths that no longer exist on disk. The checked file is read,
        // so a link put in its place after the check is not followed.
        let content = match doc.read() {
            Ok(c) => c,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    missing += 1;
                } else if std::fs::metadata(&doc.path).is_ok_and(|m| m.len() > MAX_DOCUMENT_BYTES) {
                    too_large += 1;
                } else {
                    unreadable += 1;
                }
                continue;
            }
        };

        // mtime in milliseconds since the Unix epoch.
        let mtime_ms: u64 = std::fs::metadata(&doc.path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // Derive title: first `# ...` heading line, else stem of the file name.
        let title = content
            .lines()
            .find(|l| l.starts_with("# "))
            .map(|l| l.trim_start_matches("# ").trim().to_string())
            .unwrap_or_else(|| {
                std::path::Path::new(path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone())
            });

        // Preview: first 200 chars of raw content.
        let preview: String = content.chars().take(200).collect();

        documents.push(json!({
            "path": path,
            "title": title,
            "mtimeMs": mtime_ms,
            "preview": preview,
        }));
    }

    let payload = json!({
        "documents": documents,
        "count": documents.len(),
        "skipped": {
            "missing": missing,
            "notDocument": not_document,
            "tooLarge": too_large,
            "unreadable": unreadable,
        },
    });
    Response::ok(
        id,
        json!({
            "contents": [{
                "uri": "mdopener://recent-documents",
                "mimeType": "application/json",
                "text": payload.to_string()
            }]
        }),
    )
}

// ── diff_documents tool ───────────────────────────────────────────────────────

/// Most unchanged lines of context `diff_documents` shows around a change.
pub const DIFF_MAX_CONTEXT_LINES: u64 = 10_000;

/// Compare two Markdown files and return a unified diff with line numbers.
///
/// Reads both files from disk directly (no IPC needed — read-only).  Produces
/// a unified diff in the standard `---`/`+++` format with `context_lines`
/// unchanged lines of context surrounding each hunk (default 3).
///
/// Returns `{ diff, hunks, added, removed, path_a, path_b }` where:
/// - `diff`    — the full unified diff string
/// - `hunks`   — number of change hunks
/// - `added`   — total lines added
/// - `removed` — total lines removed
/// - `path_a` / `path_b` — the resolved absolute paths
pub fn tool_diff_documents(id: Value, args: &Value) -> Response {
    let raw_a = match non_blank_str(args, "path_a") {
        Ok(Some(p)) => p.to_string(),
        Ok(None) => return Response::err(id, -32602, "`path_a` is required"),
        Err(e) => return Response::err(id, -32602, e),
    };
    let raw_b = match non_blank_str(args, "path_b") {
        Ok(Some(p)) => p.to_string(),
        Ok(None) => return Response::err(id, -32602, "`path_b` is required"),
        Err(e) => return Response::err(id, -32602, e),
    };
    // Clamped: a huge value would overflow the hunk arithmetic.
    // A `context_lines` above DIFF_MAX_CONTEXT_LINES used to be read as that
    // many in silence; it is refused like the other limits. Omitted is 3.
    let context_lines = match &args["context_lines"] {
        Value::Null => 3,
        v => match whole_number_value(v).filter(|n| *n <= DIFF_MAX_CONTEXT_LINES) {
            Some(n) => n as usize,
            None => {
                return Response::err(
                    id,
                    -32602,
                    format!(
                        "`context_lines` must be a whole number from 0 to \
                         {DIFF_MAX_CONTEXT_LINES}, got {v}; omit it for the default of 3"
                    ),
                )
            }
        },
    };

    let doc_a = match checked_document(&agent_path(&raw_a), "path_a") {
        Ok(p) => p,
        Err(e) => return tool_error(id, e),
    };
    let doc_b = match checked_document(&agent_path(&raw_b), "path_b") {
        Ok(p) => p,
        Err(e) => return tool_error(id, e),
    };
    let (path_a, path_b) = (doc_a.path.clone(), doc_b.path.clone());

    let content_a = match doc_a.read() {
        Ok(c) => c,
        Err(e) => return tool_error(id, cannot_read("path_a ", &path_a, &e)),
    };
    let content_b = match doc_b.read() {
        Ok(c) => c,
        Err(e) => return tool_error(id, cannot_read("path_b ", &path_b, &e)),
    };

    let (diff, hunks, added, removed) =
        compute_unified_diff(&path_a, &path_b, &content_a, &content_b, context_lines);

    tool_result(
        id,
        json!({
            "diff": diff,
            "hunks": hunks,
            "added": added,
            "removed": removed,
            "path_a": path_a,
            "path_b": path_b,
        }),
    )
}

/// Compute a unified diff between two text blobs.
///
/// Returns `(diff_text, hunk_count, lines_added, lines_removed)`.
///
/// This is a pure Rust implementation of the classic Myers diff algorithm
/// (patience-style line-by-line LCS), producing standard unified-diff output
/// (`--- a`, `+++ b`, `@@ -L,N +L,N @@` headers, `+`/`-`/` ` lines).
/// No external crates are required — keeps the binary dependency footprint zero.
pub fn compute_unified_diff(
    label_a: &str,
    label_b: &str,
    text_a: &str,
    text_b: &str,
    context: usize,
) -> (String, usize, usize, usize) {
    // Lines keep their terminators, so files that differ only in line
    // endings (CRLF vs LF) or in the final newline are not reported as
    // identical, as they were with `str::lines`.
    let lines_a: Vec<&str> = text_a.split_inclusive('\n').collect();
    let lines_b: Vec<&str> = text_b.split_inclusive('\n').collect();

    // Build the edit script via LCS (longest common subsequence).
    let lcs = lcs_diff(&lines_a, &lines_b);

    // Convert edit script into (kind, text) lines.
    // kind: ' ' = context, '+' = added, '-' = removed
    #[derive(Clone)]
    struct EditLine {
        kind: char,
        text: String,
    }

    let mut edits: Vec<EditLine> = Vec::new();
    let mut ia = 0usize;
    let mut ib = 0usize;

    for op in &lcs {
        match op {
            DiffOp::Equal(na, nb) => {
                edits.push(EditLine {
                    kind: ' ',
                    text: lines_a[*na].to_string(),
                });
                ia = na + 1;
                ib = nb + 1;
            }
            DiffOp::Delete(na) => {
                edits.push(EditLine {
                    kind: '-',
                    text: lines_a[*na].to_string(),
                });
                ia = na + 1;
            }
            DiffOp::Insert(nb) => {
                edits.push(EditLine {
                    kind: '+',
                    text: lines_b[*nb].to_string(),
                });
                ib = nb + 1;
            }
        }
    }
    // Drain remaining lines from A (deletions) and B (insertions).
    while ia < lines_a.len() {
        edits.push(EditLine {
            kind: '-',
            text: lines_a[ia].to_string(),
        });
        ia += 1;
    }
    while ib < lines_b.len() {
        edits.push(EditLine {
            kind: '+',
            text: lines_b[ib].to_string(),
        });
        ib += 1;
    }

    // Group into hunks: runs of changes + context_lines of context on each side.
    let mut hunk_ranges: Vec<(usize, usize)> = Vec::new(); // (start_idx, end_idx) in edits[]
    let n = edits.len();
    let mut i = 0;
    while i < n {
        if edits[i].kind == ' ' {
            i += 1;
            continue;
        }
        // A run of changes [i, run_end), widened by `context` lines each side.
        let mut run_end = i;
        while run_end < n && edits[run_end].kind != ' ' {
            run_end += 1;
        }
        let start = i.saturating_sub(context);
        let end = run_end.saturating_add(context).min(n);
        // Merge with the previous hunk when their context windows touch.
        match hunk_ranges.last_mut() {
            Some(last) if start <= last.1 => last.1 = end,
            _ => hunk_ranges.push((start, end)),
        }
        i = run_end;
    }

    let mut diff_lines: Vec<String> = Vec::new();
    let mut total_added = 0usize;
    let mut total_removed = 0usize;

    if !hunk_ranges.is_empty() {
        diff_lines.push(format!("--- {label_a}"));
        diff_lines.push(format!("+++ {label_b}"));
    }

    for (start, end) in &hunk_ranges {
        let slice = &edits[*start..*end];

        // Compute @@ header: line ranges in A and B. A side with no lines in
        // the hunk (a pure insertion or deletion without context) names the
        // line it follows, as unified diff requires: lines of that side
        // before the hunk.
        let count_a = slice.iter().filter(|e| e.kind != '+').count();
        let count_b = slice.iter().filter(|e| e.kind != '-').count();
        let before_a = edits[..*start].iter().filter(|e| e.kind != '+').count();
        let before_b = edits[..*start].iter().filter(|e| e.kind != '-').count();
        let first_a = if count_a == 0 { before_a } else { before_a + 1 };
        let first_b = if count_b == 0 { before_b } else { before_b + 1 };
        diff_lines.push(format!(
            "@@ -{},{} +{},{} @@",
            first_a, count_a, first_b, count_b
        ));

        for e in slice {
            // The `\n` is the joiner; a `\r` stays visible, and a last line
            // without a newline is marked the way `diff -u` marks it.
            match e.text.strip_suffix('\n') {
                Some(text) => diff_lines.push(format!("{}{}", e.kind, text)),
                None => {
                    diff_lines.push(format!("{}{}", e.kind, e.text));
                    diff_lines.push("\\ No newline at end of file".to_string());
                }
            }
            if e.kind == '+' {
                total_added += 1;
            }
            if e.kind == '-' {
                total_removed += 1;
            }
        }
    }

    let diff_text = diff_lines.join("\n");
    (diff_text, hunk_ranges.len(), total_added, total_removed)
}

// ── Minimal LCS diff engine ───────────────────────────────────────────────────

/// Operations in an edit script produced by `lcs_diff`.
pub enum DiffOp {
    Equal(usize, usize), // index in A, index in B
    Delete(usize),       // index in A
    Insert(usize),       // index in B
}

/// Largest LCS table (cells) `lcs_diff` will allocate: 16M cells, 128 MiB.
/// Past this, the changed middle is reported as a whole-block replacement
/// instead of a minimal diff, so two large, very different files cannot make
/// the MCP server allocate gigabytes and abort (which kills the agent's
/// session with it).
pub const MAX_LCS_CELLS: usize = 16 * 1024 * 1024;

/// Compute an edit script between two slices. Returns the ops in document
/// order.
///
/// The common prefix and suffix are matched directly, so the quadratic LCS
/// table only covers the changed middle (typical edits stay tiny even in long
/// documents). If that middle would still need more than [`MAX_LCS_CELLS`],
/// it is emitted as "delete all of A's middle, insert all of B's": a correct
/// but non-minimal diff.
pub fn lcs_diff<T: PartialEq>(a: &[T], b: &[T]) -> Vec<DiffOp> {
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let (a_mid, b_mid) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);

    let mut ops: Vec<DiffOp> = (0..prefix).map(|i| DiffOp::Equal(i, i)).collect();
    let fits = (a_mid.len() + 1)
        .checked_mul(b_mid.len() + 1)
        .is_some_and(|cells| cells <= MAX_LCS_CELLS);
    if fits {
        ops.extend(lcs_table_diff(a_mid, b_mid).into_iter().map(|op| match op {
            DiffOp::Equal(i, j) => DiffOp::Equal(i + prefix, j + prefix),
            DiffOp::Delete(i) => DiffOp::Delete(i + prefix),
            DiffOp::Insert(j) => DiffOp::Insert(j + prefix),
        }));
    } else {
        ops.extend((0..a_mid.len()).map(|i| DiffOp::Delete(i + prefix)));
        ops.extend((0..b_mid.len()).map(|j| DiffOp::Insert(j + prefix)));
    }
    let (a_tail, b_tail) = (a.len() - suffix, b.len() - suffix);
    ops.extend((0..suffix).map(|k| DiffOp::Equal(a_tail + k, b_tail + k)));
    ops
}

/// The classic O(m·n) LCS table and back-track. Callers bound the size.
fn lcs_table_diff<T: PartialEq>(a: &[T], b: &[T]) -> Vec<DiffOp> {
    let m = a.len();
    let n = b.len();

    if m == 0 {
        return (0..n).map(DiffOp::Insert).collect();
    }
    if n == 0 {
        return (0..m).map(DiffOp::Delete).collect();
    }

    // dp[i][j] = length of LCS of a[..i] and b[..j]
    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = if a[i - 1] == b[j - 1] {
                dp[i - 1][j - 1] + 1
            } else {
                dp[i - 1][j].max(dp[i][j - 1])
            };
        }
    }

    // Back-track to build edit script.
    let mut ops: Vec<DiffOp> = Vec::new();
    let mut i = m;
    let mut j = n;
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && a[i - 1] == b[j - 1] {
            ops.push(DiffOp::Equal(i - 1, j - 1));
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            ops.push(DiffOp::Insert(j - 1));
            j -= 1;
        } else {
            ops.push(DiffOp::Delete(i - 1));
            i -= 1;
        }
    }
    ops.reverse();
    ops
}

// ── req_str! macro ────────────────────────────────────────────────────────────

/// Extract a non-empty `&str` from a JSON Value, or return a -32602 error.
/// Usage: `req_str!($id, $val, "error message with {}", ctx_var)`
macro_rules! req_str {
    ($id:expr, $val:expr, $fmt:literal $(, $arg:expr)*) => {
        match $val.as_str() {
            Some(s) if !s.is_empty() => s,
            _ => return Response::err($id.clone(), -32602, format!($fmt $(, $arg)*)),
        }
    };
}

// ── edit_canvas tool ──────────────────────────────────────────────────────────

/// A coordinate or size for a canvas node: a whole number is written as a
/// JSON integer (JSON Canvas positions and sizes are integers; `json!(5.0)`
/// wrote `5.0`), anything else as the number given.
fn canvas_number(v: f64) -> Value {
    const LIMIT: f64 = 9_007_199_254_740_992.0; // 2^53, exact in an f64
    if v.fract() == 0.0 && v.abs() <= LIMIT {
        json!(v as i64)
    } else {
        json!(v)
    }
}

/// Apply a list of typed edit operations to a `.canvas` file and optionally
/// write the mutated JSON back to disk.
///
/// The canvas is parsed in full, all ops applied sequentially (aborting on the
/// first error), then re-serialised.  The original file is only overwritten
/// when every op succeeds AND `save` is `true` (default).
pub fn tool_edit_canvas(id: Value, args: &Value) -> Response {
    // ── Validate path ────────────────────────────────────────────────────────
    let raw_path = match non_blank_str(args, "path") {
        Ok(Some(p)) => p,
        Ok(None) => return Response::err(id, -32602, "`path` is required"),
        Err(e) => return Response::err(id, -32602, e),
    };
    if !raw_path.ends_with(".canvas") {
        return Response::err(id, -32602, "`path` must point to a .canvas file");
    }
    let path = std::fs::canonicalize(raw_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw_path.to_string());
    // Re-check after resolving symlinks: `x.canvas -> ~/.env` must not be read
    // or overwritten.
    if !path.ends_with(".canvas") {
        return tool_error(
            id,
            format!("Refusing {path}: `path` must resolve to a .canvas file"),
        );
    }

    // Checked before the file is read: an empty list is an argument error
    // whether or not the canvas exists, and it never reaches the save.
    let ops = match args["ops"].as_array() {
        Some(a) => a.clone(),
        None => return Response::err(id, -32602, "`ops` must be an array"),
    };
    if ops.is_empty() {
        return Response::err(id, -32602, "`ops` must not be empty");
    }
    // A field the op does not use (`width` on a move_node) used to be
    // ignored, so the call reported success for a change it never made.
    // Checked before the file is read, as the empty list is.
    for (i, op) in ops.iter().enumerate() {
        if let Some(msg) = canvas_op_field_problem(op) {
            return Response::err(id, -32602, format!("op[{i}] {msg}"));
        }
        // An empty id names no node or edge: it used to be looked up in the
        // file and come back as "node `` not found".
        if let Some(msg) = canvas_op_empty_id(op) {
            return Response::err(id, -32602, format!("op[{i}] {msg}"));
        }
    }

    // ── Read file ────────────────────────────────────────────────────────────
    let raw_content = match read_document_file(&path) {
        Ok(c) => c,
        // "Failed to read missing.canvas: No such file or directory (os
        // error 2)" named neither where it looked nor that the tool only
        // edits an existing canvas.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return tool_error(
                id,
                format!(
                    "{} edit_canvas edits an existing .canvas file and does not create \
                     one: pass the path of a canvas that exists.",
                    cannot_read("", &agent_path(&path), &e)
                ),
            )
        }
        Err(e) => return tool_error(id, cannot_read("", &agent_path(&path), &e)),
    };

    // ── Parse ────────────────────────────────────────────────────────────────
    let parsed = match parse_canvas_json(&raw_content) {
        Ok(c) => c,
        // "Canvas parse error: Invalid JSON: ..." named neither the file nor
        // whether it had been touched.
        Err(e) => {
            return tool_error(
                id,
                format!(
                    "Canvas parse error in '{}': {e}. The file was left unchanged: \
                     edit_canvas does not overwrite a canvas it cannot parse. Fix the file \
                     (a JSON object whose `nodes` and `edges` are arrays of objects), then \
                     call edit_canvas again.",
                    agent_path(&path)
                ),
            )
        }
    };

    let mut nodes: Vec<serde_json::Map<String, Value>> = parsed.nodes;
    let mut edges: Vec<serde_json::Map<String, Value>> = parsed.edges;
    let mut output = parsed.rest;

    // ── Apply ops ────────────────────────────────────────────────────────────

    let mut ops_applied: Vec<String> = Vec::new();
    // Edges `delete_node` removed along with their node, reported back.
    let mut removed_edge_ids: Vec<Value> = Vec::new();

    for (i, op) in ops.iter().enumerate() {
        let op_type = match op["type"].as_str() {
            Some(t) => t,
            None => return Response::err(id, -32602, format!("op[{i}]: missing `type`")),
        };

        match op_type {
            "move_node" => {
                let node_id = match op["id"].as_str() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] move_node: `id` required"),
                        )
                    }
                };
                let x = match op["x"].as_f64() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] move_node: `x` required"),
                        )
                    }
                };
                let y = match op["y"].as_f64() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] move_node: `y` required"),
                        )
                    }
                };
                let node = match find_node_mut(&mut nodes, node_id) {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!(
                                "op[{i}] move_node: node `{node_id}` not found. {}",
                                canvas_known_ids(&nodes, "node")
                            ),
                        )
                    }
                };
                node.insert("x".into(), canvas_number(x));
                node.insert("y".into(), canvas_number(y));
            }
            "resize_node" => {
                let node_id = match op["id"].as_str() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] resize_node: `id` required"),
                        )
                    }
                };
                let w = match op["width"].as_f64() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] resize_node: `width` required"),
                        )
                    }
                };
                let h = match op["height"].as_f64() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] resize_node: `height` required"),
                        )
                    }
                };
                if w <= 0.0 || h <= 0.0 {
                    return Response::err(
                        id,
                        -32602,
                        format!("op[{i}] resize_node: width and height must be positive"),
                    );
                }
                let node = match find_node_mut(&mut nodes, node_id) {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!(
                                "op[{i}] resize_node: node `{node_id}` not found. {}",
                                canvas_known_ids(&nodes, "node")
                            ),
                        )
                    }
                };
                node.insert("width".into(), canvas_number(w));
                node.insert("height".into(), canvas_number(h));
            }
            "edit_text" => {
                let node_id = match op["id"].as_str() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] edit_text: `id` required"),
                        )
                    }
                };
                let text = match op["text"].as_str() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] edit_text: `text` required"),
                        )
                    }
                };
                let node = match find_node_mut(&mut nodes, node_id) {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!(
                                "op[{i}] edit_text: node `{node_id}` not found. {}",
                                canvas_known_ids(&nodes, "node")
                            ),
                        )
                    }
                };
                if node.get("type").and_then(Value::as_str) != Some("text") {
                    return Response::err(
                        id,
                        -32602,
                        format!("op[{i}] edit_text: node `{node_id}` is not a text node"),
                    );
                }
                node.insert("text".into(), json!(text));
            }
            "edit_link" => {
                let node_id = match op["id"].as_str() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] edit_link: `id` required"),
                        )
                    }
                };
                let url = match op["url"].as_str() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] edit_link: `url` required"),
                        )
                    }
                };
                let node = match find_node_mut(&mut nodes, node_id) {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!(
                                "op[{i}] edit_link: node `{node_id}` not found. {}",
                                canvas_known_ids(&nodes, "node")
                            ),
                        )
                    }
                };
                if node.get("type").and_then(Value::as_str) != Some("link") {
                    return Response::err(
                        id,
                        -32602,
                        format!("op[{i}] edit_link: node `{node_id}` is not a link node"),
                    );
                }
                node.insert("url".into(), json!(url));
            }
            "edit_group_label" => {
                let node_id = match op["id"].as_str() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] edit_group_label: `id` required"),
                        )
                    }
                };
                let label = match op["label"].as_str() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] edit_group_label: `label` required"),
                        )
                    }
                };
                let node = match find_node_mut(&mut nodes, node_id) {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!(
                                "op[{i}] edit_group_label: node `{node_id}` not found. {}",
                                canvas_known_ids(&nodes, "node")
                            ),
                        )
                    }
                };
                if node.get("type").and_then(Value::as_str) != Some("group") {
                    return Response::err(
                        id,
                        -32602,
                        format!("op[{i}] edit_group_label: node `{node_id}` is not a group node"),
                    );
                }
                node.insert("label".into(), json!(label));
            }
            "set_node_color" => {
                let node_id = match op["id"].as_str() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] set_node_color: `id` required"),
                        )
                    }
                };
                let node = match find_node_mut(&mut nodes, node_id) {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!(
                                "op[{i}] set_node_color: node `{node_id}` not found. {}",
                                canvas_known_ids(&nodes, "node")
                            ),
                        )
                    }
                };
                match op.get("color") {
                    Some(Value::Null) | None => {
                        node.remove("color");
                    }
                    Some(v) => {
                        if let Some(c) = v.as_str().filter(|c| !is_canvas_color(c)) {
                            return Response::err(
                                id,
                                -32602,
                                format!(
                                    "op[{i}] set_node_color: {}",
                                    canvas_color_problem("color", c)
                                ),
                            );
                        }
                        node.insert("color".into(), v.clone());
                    }
                }
            }
            "add_node" => {
                let new_node = match op["node"].as_object() {
                    Some(n) => n,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] add_node: `node` object required"),
                        )
                    }
                };
                if let Some(problem) = canvas_node_problem(new_node) {
                    return Response::err(id, -32602, format!("op[{i}] add_node: {problem}"));
                }
                let new_id = match new_node.get("id").and_then(Value::as_str) {
                    Some(s) => s,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] add_node: node.id required"),
                        )
                    }
                };
                if nodes
                    .iter()
                    .any(|n| n.get("id").and_then(Value::as_str) == Some(new_id))
                {
                    return Response::err(
                        id,
                        -32602,
                        format!("op[{i}] add_node: id `{new_id}` already exists"),
                    );
                }
                nodes.push(new_node.clone());
            }
            "delete_node" => {
                let node_id = req_str!(id, op["id"], "op[{}] delete_node: `id` required", i);
                let before = nodes.len();
                nodes.retain(|n| n.get("id").and_then(Value::as_str) != Some(node_id));
                if nodes.len() == before {
                    return Response::err(
                        id,
                        -32602,
                        format!(
                            "op[{i}] delete_node: node `{node_id}` not found. {}",
                            canvas_known_ids(&nodes, "node")
                        ),
                    );
                }
                edges.retain(|e| {
                    let keep = e.get("fromNode").and_then(Value::as_str) != Some(node_id)
                        && e.get("toNode").and_then(Value::as_str) != Some(node_id);
                    if !keep {
                        removed_edge_ids.push(e.get("id").cloned().unwrap_or(Value::Null));
                    }
                    keep
                });
            }
            "add_edge" => {
                let new_edge = match op["edge"].as_object() {
                    Some(e) => e,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] add_edge: `edge` object required"),
                        )
                    }
                };
                let new_id = match new_edge.get("id").and_then(Value::as_str) {
                    Some("") => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] add_edge: edge.id must not be empty"),
                        )
                    }
                    Some(s) => s,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] add_edge: edge.id required"),
                        )
                    }
                };
                if edges
                    .iter()
                    .any(|e| e.get("id").and_then(Value::as_str) == Some(new_id))
                {
                    return Response::err(
                        id,
                        -32602,
                        format!("op[{i}] add_edge: id `{new_id}` already exists"),
                    );
                }
                let from = match new_edge.get("fromNode").and_then(Value::as_str) {
                    Some(s) => s,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] add_edge: edge.fromNode required"),
                        )
                    }
                };
                let to = match new_edge.get("toNode").and_then(Value::as_str) {
                    Some(s) => s,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] add_edge: edge.toNode required"),
                        )
                    }
                };
                if !nodes
                    .iter()
                    .any(|n| n.get("id").and_then(Value::as_str) == Some(from))
                {
                    return Response::err(
                        id,
                        -32602,
                        format!(
                            "op[{i}] add_edge: fromNode `{from}` not found. {}",
                            canvas_known_ids(&nodes, "node")
                        ),
                    );
                }
                if !nodes
                    .iter()
                    .any(|n| n.get("id").and_then(Value::as_str) == Some(to))
                {
                    return Response::err(
                        id,
                        -32602,
                        format!(
                            "op[{i}] add_edge: toNode `{to}` not found. {}",
                            canvas_known_ids(&nodes, "node")
                        ),
                    );
                }
                if let Some(msg) = canvas_edge_problem(new_edge) {
                    return Response::err(id, -32602, format!("op[{i}] add_edge: {msg}"));
                }
                edges.push(new_edge.clone());
            }
            "delete_edge" => {
                let edge_id = match op["id"].as_str() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] delete_edge: `id` required"),
                        )
                    }
                };
                let before = edges.len();
                edges.retain(|e| e.get("id").and_then(Value::as_str) != Some(edge_id));
                if edges.len() == before {
                    return Response::err(
                        id,
                        -32602,
                        format!(
                            "op[{i}] delete_edge: edge `{edge_id}` not found. {}",
                            canvas_known_ids(&edges, "edge")
                        ),
                    );
                }
            }
            "edit_edge_label" => {
                let edge_id = match op["id"].as_str() {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] edit_edge_label: `id` required"),
                        )
                    }
                };
                let edge = match find_edge_mut(&mut edges, edge_id) {
                    Some(v) => v,
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!(
                                "op[{i}] edit_edge_label: edge `{edge_id}` not found. {}",
                                canvas_known_ids(&edges, "edge")
                            ),
                        )
                    }
                };
                match op.get("label") {
                    Some(Value::Null) | None => {
                        edge.remove("label");
                    }
                    Some(v) => {
                        edge.insert("label".into(), v.clone());
                    }
                }
            }
            "reorder_edges" => {
                let new_ids = match op["ids"].as_array() {
                    Some(a) => a.clone(),
                    None => {
                        return Response::err(
                            id,
                            -32602,
                            format!("op[{i}] reorder_edges: `ids` array required"),
                        )
                    }
                };
                if new_ids.len() != edges.len() {
                    return Response::err(
                        id,
                        -32602,
                        format!(
                            "op[{i}] reorder_edges: expected {} ids, got {}. {}",
                            edges.len(),
                            new_ids.len(),
                            canvas_known_ids(&edges, "edge")
                        ),
                    );
                }
                let edge_map: std::collections::HashMap<String, serde_json::Map<String, Value>> =
                    edges
                        .iter()
                        .filter_map(|e| {
                            e.get("id")
                                .and_then(Value::as_str)
                                .map(|eid| (eid.to_string(), e.clone()))
                        })
                        .collect();
                let mut reordered = Vec::with_capacity(edges.len());
                for v in &new_ids {
                    let eid = match v.as_str() {
                        Some(s) => s,
                        None => {
                            return Response::err(
                                id,
                                -32602,
                                format!("op[{i}] reorder_edges: id must be a string"),
                            )
                        }
                    };
                    match edge_map.get(eid) {
                        Some(e) => reordered.push(e.clone()),
                        None => {
                            return Response::err(
                                id,
                                -32602,
                                format!(
                                    "op[{i}] reorder_edges: unknown edge id `{eid}`. {}",
                                    canvas_known_ids(&edges, "edge")
                                ),
                            )
                        }
                    }
                }
                edges = reordered;
            }
            other => {
                return Response::err(
                    id,
                    -32602,
                    format!("op[{i}]: unknown operation type `{other}`"),
                );
            }
        }
        ops_applied.push(op_type.to_string());
    }

    // ── Serialise ────────────────────────────────────────────────────────────
    let ids = |items: &[serde_json::Map<String, Value>]| -> Vec<Value> {
        items
            .iter()
            .map(|m| m.get("id").cloned().unwrap_or(Value::Null))
            .collect()
    };
    let (node_ids, edge_ids) = (ids(&nodes), ids(&edges));
    output.insert("nodes".into(), json!(nodes));
    output.insert("edges".into(), json!(edges));
    let serialised = match serde_json::to_string_pretty(&output) {
        Ok(s) => s,
        Err(e) => return tool_error(id, format!("Serialisation error: {e}")),
    };

    // ── Write to disk ────────────────────────────────────────────────────────
    let save = args["save"].as_bool().unwrap_or(true);
    if save {
        if let Err(e) = replace_file(std::path::Path::new(&path), serialised.as_bytes()) {
            return tool_error(id, format!("Failed to write {path}: {e}"));
        }
    }

    tool_result(
        id,
        json!({
            "ok": true,
            "path": path,
            "nodes_count": nodes.len(),
            "edges_count": edges.len(),
            "node_ids": node_ids,
            "edge_ids": edge_ids,
            "removed_edge_ids": removed_edge_ids,
            "ops_applied": ops_applied,
            "saved": save,
            "content": if save { Value::Null } else { json!(serialised) },
        }),
    )
}

/// Replace the file at `path` with `bytes`: written into a new sibling temp
/// file (created with `create_new`, so never through an existing name or
/// symlink) that takes the old file's permissions, then renamed over `path`.
/// The rename replaces whatever is at `path` and never follows it, so a
/// `.canvas` swapped for a symlink to `~/.bashrc` after `edit_canvas` checked
/// and read it is replaced, not written through: the write used to be
/// `std::fs::write`, which follows the link.
pub fn replace_file(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let keep = std::fs::metadata(path)
        .ok()
        .filter(|m| m.is_file())
        .map(|m| m.permissions());
    let mut attempt = 0;
    let (tmp, mut file) = loop {
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let mut name = path.as_os_str().to_owned();
        name.push(format!(
            ".{}-{seq}-{nanos:x}.mdopener.tmp",
            std::process::id()
        ));
        let tmp = std::path::PathBuf::from(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(f) => break (tmp, f),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt < 16 => {
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    };
    let written = keep
        .map_or(Ok(()), |p| file.set_permissions(p))
        .and_then(|()| file.write_all(bytes))
        .and_then(|()| file.sync_all())
        .and_then(|()| {
            drop(file);
            std::fs::rename(&tmp, path)
        });
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

// ── Canvas JSON helpers ───────────────────────────────────────────────────────

struct RawCanvas {
    nodes: Vec<serde_json::Map<String, Value>>,
    edges: Vec<serde_json::Map<String, Value>>,
    /// Every other top-level key, written back unchanged on save.
    rest: serde_json::Map<String, Value>,
}

fn parse_canvas_json(raw: &str) -> Result<RawCanvas, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("Invalid JSON: {e}"))?;
    let Value::Object(mut rest) = v else {
        return Err("Canvas must be a JSON object".into());
    };
    let nodes = take_canvas_items(&mut rest, "nodes")?;
    let edges = take_canvas_items(&mut rest, "edges")?;
    Ok(RawCanvas { nodes, edges, rest })
}

/// Remove `key` (`nodes` or `edges`) from the canvas object as a list of
/// objects. A missing key is an empty list; anything that is not an array of
/// objects is an error, since saving would otherwise drop it.
fn take_canvas_items(
    obj: &mut serde_json::Map<String, Value>,
    key: &str,
) -> Result<Vec<serde_json::Map<String, Value>>, String> {
    let items = match obj.remove(key) {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(format!("`{key}` must be an array")),
    };
    items
        .into_iter()
        .enumerate()
        .map(|(i, item)| match item {
            Value::Object(m) => Ok(m),
            other => Err(format!("{key}[{i}] must be an object, got {other}")),
        })
        .collect()
}

/// Why `node` is not a node the app can show, or `None` when it is. The app's
/// canvas parser (`parseNode` in src/lib/canvas.ts) drops, without a word, a
/// node with an empty or non-string `id`, a `type` other than text, file,
/// link or group, a non-number `x`/`y`/`width`/`height`, a file node without a
/// string `file` or a link node without a string `url`. `add_node` used to
/// write such a node and report success, and it then never appeared.
fn canvas_node_problem(node: &serde_json::Map<String, Value>) -> Option<String> {
    match node.get("id") {
        Some(Value::String(s)) if !s.is_empty() => {}
        Some(Value::String(_)) => return Some("node.id must not be empty".into()),
        None | Some(Value::Null) => return Some("node.id required".into()),
        Some(other) => {
            return Some(format!(
                "node.id must be a string, got {}",
                json_type_phrase(other)
            ))
        }
    }
    let kind = match node.get("type") {
        Some(Value::String(t)) => t.as_str(),
        None | Some(Value::Null) => return Some("node.type required".into()),
        Some(other) => {
            return Some(format!(
                "node.type must be a string, got {}",
                json_type_phrase(other)
            ))
        }
    };
    if !matches!(kind, "text" | "file" | "link" | "group") {
        return Some(format!(
            "node.type must be 'text', 'file', 'link' or 'group', got {kind:?}"
        ));
    }
    for field in ["x", "y", "width", "height"] {
        match node.get(field) {
            Some(v) if v.is_number() => {}
            None | Some(Value::Null) => return Some(format!("node.{field} required")),
            Some(other) => {
                return Some(format!(
                    "node.{field} must be a number, got {}",
                    json_type_phrase(other)
                ))
            }
        }
    }
    for field in ["width", "height"] {
        if node[field].as_f64().is_some_and(|n| n <= 0.0) {
            return Some("node width and height must be positive".into());
        }
    }
    let needs = match kind {
        "file" => Some("file"),
        "link" => Some("url"),
        _ => None,
    };
    if let Some(field) = needs {
        if !node.get(field).is_some_and(Value::is_string) {
            return Some(format!("a {kind} node needs a string node.{field}"));
        }
    }
    for field in ["text", "label", "color", "subpath", "background"] {
        if let Some(v) = node.get(field).filter(|v| !v.is_null() && !v.is_string()) {
            return Some(format!(
                "node.{field} must be a string, got {}",
                json_type_phrase(v)
            ));
        }
    }
    if let Some(c) = node
        .get("color")
        .and_then(Value::as_str)
        .filter(|c| !is_canvas_color(c))
    {
        return Some(canvas_color_problem("node.color", c));
    }
    None
}

/// Why an `add_edge` edge would not be drawn as written, or `None`: a
/// `fromSide`/`toSide` other than top, right, bottom or left, a
/// `fromEnd`/`toEnd` other than none or arrow, a colour JSON Canvas does not
/// allow, or a `label` that is not a string. They were written as given and
/// reported as success, and the app then drew the edge some other way.
fn canvas_edge_problem(edge: &serde_json::Map<String, Value>) -> Option<String> {
    for (field, allowed) in [
        ("fromSide", &["top", "right", "bottom", "left"][..]),
        ("toSide", &["top", "right", "bottom", "left"][..]),
        ("fromEnd", &["none", "arrow"][..]),
        ("toEnd", &["none", "arrow"][..]),
    ] {
        match edge.get(field) {
            None | Some(Value::Null) => {}
            Some(Value::String(v)) if allowed.contains(&v.as_str()) => {}
            Some(other) => {
                let list = allowed
                    .iter()
                    .map(|a| format!("'{a}'"))
                    .collect::<Vec<_>>()
                    .join(", ");
                return Some(format!("edge.{field} must be one of {list}, got {other}"));
            }
        }
    }
    if let Some(v) = edge.get("label").filter(|v| !v.is_null() && !v.is_string()) {
        return Some(format!(
            "edge.label must be a string, got {}",
            json_type_phrase(v)
        ));
    }
    match edge.get("color") {
        None | Some(Value::Null) => None,
        Some(Value::String(c)) if is_canvas_color(c) => None,
        Some(Value::String(c)) => Some(canvas_color_problem("edge.color", c)),
        Some(other) => Some(format!(
            "edge.color must be a string, got {}",
            json_type_phrase(other)
        )),
    }
}

/// The fields each `edit_canvas` op reads, besides `type`.
const CANVAS_OP_FIELDS: &[(&str, &[&str])] = &[
    ("move_node", &["id", "x", "y"]),
    ("resize_node", &["id", "width", "height"]),
    ("edit_text", &["id", "text"]),
    ("edit_link", &["id", "url"]),
    ("edit_group_label", &["id", "label"]),
    ("set_node_color", &["id", "color"]),
    ("add_node", &["node"]),
    ("delete_node", &["id"]),
    ("add_edge", &["edge"]),
    ("delete_edge", &["id"]),
    ("edit_edge_label", &["id", "label"]),
    ("reorder_edges", &["ids"]),
];

/// The first field of `op` that its op type does not use (a `null` one is
/// taken as left out), as "`move_node`: `width` is not used ...", naming the
/// ops that do use it. `None` for an op whose type is missing or unknown;
/// those are refused where the ops are applied.
fn canvas_op_field_problem(op: &Value) -> Option<String> {
    let kind = op["type"].as_str()?;
    let takes = CANVAS_OP_FIELDS.iter().find(|(k, _)| *k == kind)?.1;
    let (field, _) = op
        .as_object()?
        .iter()
        .find(|(k, v)| k.as_str() != "type" && !v.is_null() && !takes.contains(&k.as_str()))?;
    let users: Vec<String> = CANVAS_OP_FIELDS
        .iter()
        .filter(|(_, fs)| fs.contains(&field.as_str()))
        .map(|(k, _)| format!("`{k}`"))
        .collect();
    let hint = if users.is_empty() {
        String::new()
    } else {
        format!(" (it is for {})", users.join(", "))
    };
    let list = takes
        .iter()
        .map(|f| format!("`{f}`"))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "{kind}: `{field}` is not used by {kind}, which takes {list}{hint}. Send one op per change."
    ))
}

/// The first id-like field of `op` that is an empty string, as
/// "move_node: `id` must not be empty": the op's `id`, an element of
/// `reorder_edges`' `ids`, `add_node`'s `node.id`, and `add_edge`'s
/// `edge.id`, `edge.fromNode` and `edge.toNode`. Only whitespace counts as
/// empty. A field of another type is refused by the type checks.
fn canvas_op_empty_id(op: &Value) -> Option<String> {
    let kind = op["type"].as_str().unwrap_or("op");
    let empty = |v: &Value| v.as_str().is_some_and(|s| s.trim().is_empty());
    if empty(&op["id"]) {
        return Some(format!("{kind}: `id` must not be empty"));
    }
    if let Some(j) = op["ids"]
        .as_array()
        .and_then(|ids| ids.iter().position(empty))
    {
        return Some(format!("{kind}: `ids[{j}]` must not be empty"));
    }
    if empty(&op["node"]["id"]) {
        return Some(format!("{kind}: node.id must not be empty"));
    }
    for field in ["id", "fromNode", "toNode"] {
        if empty(&op["edge"][field]) {
            return Some(format!("{kind}: edge.{field} must not be empty"));
        }
    }
    None
}

/// A colour JSON Canvas allows: a preset `"1"`..`"6"` or a hex `#rgb` /
/// `#rrggbb`. Anything else (`"red"`, `"7"`, `"#abcd"`) was written as given
/// and the app then showed the node with no colour or a broken one.
fn is_canvas_color(c: &str) -> bool {
    if matches!(c, "1" | "2" | "3" | "4" | "5" | "6") {
        return true;
    }
    c.strip_prefix('#').is_some_and(|hex| {
        matches!(hex.len(), 3 | 6) && hex.chars().all(|ch| ch.is_ascii_hexdigit())
    })
}

fn canvas_color_problem(field: &str, c: &str) -> String {
    format!("{field} must be a preset \"1\"..\"6\" or a hex colour #rgb or #rrggbb, got {c:?}")
}

/// The next step a canvas "not found" error gives: the ids that exist at that
/// op (after the ops before it), so an agent can correct a typo or a stale id
/// without reading the file, and that nothing was written. The error used to
/// name only the missing id.
fn canvas_known_ids(items: &[serde_json::Map<String, Value>], kind: &str) -> String {
    const SHOWN: usize = 20;
    let ids: Vec<String> = items
        .iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .map(|s| format!("`{s}`"))
        .collect();
    let listed = match ids.len() {
        0 => format!("The canvas has no {kind}s at this op"),
        n if n > SHOWN => format!(
            "The canvas's {kind} ids at this op are {} and {} more",
            ids[..SHOWN].join(", "),
            n - SHOWN
        ),
        _ => format!("The canvas's {kind} ids at this op are {}", ids.join(", ")),
    };
    format!("{listed}. No op was applied and the file was left unchanged.")
}

fn find_node_mut<'a>(
    nodes: &'a mut [serde_json::Map<String, Value>],
    id: &str,
) -> Option<&'a mut serde_json::Map<String, Value>> {
    nodes
        .iter_mut()
        .find(|n| n.get("id").and_then(Value::as_str) == Some(id))
}

fn find_edge_mut<'a>(
    edges: &'a mut [serde_json::Map<String, Value>],
    id: &str,
) -> Option<&'a mut serde_json::Map<String, Value>> {
    edges
        .iter_mut()
        .find(|e| e.get("id").and_then(Value::as_str) == Some(id))
}

// (All error paths in tool_edit_canvas use explicit `return Response::err` —
//  no additional helper traits are needed.)

// ── stream_edit tool ──────────────────────────────────────────────────────────

/// `StreamEditPayload` mirrors the TypeScript `StreamEditPayload` interface.
///
/// The Rust layer validates the input and forwards the request to the frontend
/// via the IPC `/stream-edit` endpoint.  The frontend computes the diff against
/// the LIVE document (never the stale 200 ms-debounced mirror) and streams back
/// the result via `mcp_stream_edit_preview`.
#[derive(Serialize, Deserialize, Debug)]
pub struct StreamEditPayload {
    /// Opaque caller-assigned correlation id echoed in all replies.
    pub find: String,
    pub replace: String,
    #[serde(default = "default_preview")]
    pub preview: bool,
    #[serde(default = "default_preview_lines")]
    pub preview_lines: u32,
    pub path: Option<String>,
}

/// Most context lines `stream_edit` shows on each side of a diff hunk.
pub const STREAM_EDIT_MAX_PREVIEW_LINES: u64 = 20;

/// Largest `match_index` `stream_edit_apply` takes: the app reads it as a
/// 32-bit unsigned integer, so a larger one cannot name an occurrence.
pub const STREAM_EDIT_MAX_MATCH_INDEX: u64 = u32::MAX as u64;

fn default_preview() -> bool {
    true
}
fn default_preview_lines() -> u32 {
    5
}

/// The `path` the stream-edit tools assert. The frontend compares it to the
/// open document's path as a plain string, and a document opened by drag and
/// drop, a file dialog or the file tree keeps the path it was opened by (not
/// its canonical form). So when `raw` names the open document, send the app's
/// own spelling of it; otherwise send [`agent_path`] (which the app then
/// reports as a mismatch, as it should).
pub fn stream_edit_path(raw: &str, ipc: &dyn IpcClient) -> String {
    let want = agent_path(raw);
    let open = ipc
        .get("/content")
        .ok()
        .and_then(|v| v["path"].as_str().map(str::to_string));
    match open {
        Some(open) if open == want || agent_path(&open) == want => open,
        _ => want,
    }
}

/// Preview a find/replace edit as a unified diff before committing.
///
/// Forwards to the frontend via POST `/stream-edit`.  The frontend calls
/// `computeStreamEditDiff` against the LIVE document and emits
/// `mcp_stream_edit_preview` back to the waiting IPC thread.
///
/// Returns the preview result including:
///  - `diff`       — unified diff string for the first/only match
///  - `candidates` — ranked list of diffs when find matches multiple times
///  - `matchCount` — total occurrences of find in the document
///  - `editId`     — the app's id for this preview
///  - `applied`    — true only when `preview` was false (the edit is applied)
///  - `ok`         — true; a refusal (find not found, path mismatch) is a tool error
pub fn tool_stream_edit(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let find = match args["find"].as_str() {
        Some(f) if !f.is_empty() => f.to_string(),
        Some(_) => return Response::err(id, -32602, "`find` must not be empty"),
        None => return Response::err(id, -32602, "`find` is required"),
    };
    let replace = match args["replace"].as_str() {
        Some(r) => r.to_string(),
        None => return Response::err(id, -32602, "`replace` is required"),
    };
    let preview = args["preview"].as_bool().unwrap_or(true);
    // A `preview_lines` above STREAM_EDIT_MAX_PREVIEW_LINES used to be read
    // as that many in silence; it is refused like the other limits.
    let preview_lines = match &args["preview_lines"] {
        Value::Null => 5,
        v => match whole_number_value(v).filter(|n| *n <= STREAM_EDIT_MAX_PREVIEW_LINES) {
            Some(n) => n as u32,
            None => {
                return Response::err(
                    id,
                    -32602,
                    format!(
                        "`preview_lines` must be a whole number from 0 to \
                         {STREAM_EDIT_MAX_PREVIEW_LINES}, got {v}; omit it for the default of 5"
                    ),
                )
            }
        },
    };
    let path = match non_blank_str(args, "path") {
        Ok(p) => p.map(|p| stream_edit_path(p, ipc)),
        Err(e) => return Response::err(id, -32602, e),
    };

    let body = json!({
        "find": find,
        "replace": replace,
        "preview": preview,
        "previewLines": preview_lines,
        "path": path,
    });

    match ipc.post("/stream-edit", body) {
        Ok(mut v) => {
            if v["ok"].as_bool() == Some(false) {
                let msg = v["error"].as_str().unwrap_or("stream-edit preview failed.");
                return tool_error(id, msg.to_string());
            }
            // Without a preview the app has already applied the edit (unsaved);
            // calling stream_edit_apply on top would apply it a second time.
            v["applied"] = json!(!preview);
            tool_result(id, v)
        }
        Err(e) => tool_error(id, app_not_running_msg_for(&e, path.as_deref())),
    }
}

/// Apply a previously previewed stream edit.
///
/// The agent sends this after reviewing the diff returned by `stream_edit`.
/// `match_index` selects which candidate to apply when there are multiple matches.
pub fn tool_stream_edit_apply(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    // Only correlates with a preview: the app re-finds `find` in the live
    // document, so the apply does not depend on it. An empty one named no
    // preview and used to be accepted; it is refused as an empty `path` is.
    // Only whitespace names no preview either.
    let edit_id = match args["edit_id"].as_str() {
        Some(e) if e.trim().is_empty() => {
            return Response::err(id, -32602, "`edit_id` must not be empty")
        }
        e => e.unwrap_or("").to_string(),
    };
    let find = match args["find"].as_str() {
        Some(f) if !f.is_empty() => f.to_string(),
        Some(_) => return Response::err(id, -32602, "`find` must not be empty"),
        None => return Response::err(id, -32602, "`find` is required"),
    };
    let replace = match args["replace"].as_str() {
        Some(r) => r.to_string(),
        None => return Response::err(id, -32602, "`replace` is required"),
    };
    // The app reads `matchIndex` as a u32, so the schema's maximum is that
    // limit; a direct call past it is refused with the schema's message.
    let match_index = match whole_number(args, "match_index").unwrap_or(0) {
        m if m <= STREAM_EDIT_MAX_MATCH_INDEX => m as u32,
        m => {
            return Response::err(
                id,
                -32602,
                format!("`match_index` must be at most {STREAM_EDIT_MAX_MATCH_INDEX}, got {m}"),
            )
        }
    };
    let save = args["save"].as_bool().unwrap_or(false);
    let path = match non_blank_str(args, "path") {
        Ok(p) => p.map(|p| stream_edit_path(p, ipc)),
        Err(e) => return Response::err(id, -32602, e),
    };

    let body = json!({
        "editId": edit_id,
        "find": find,
        "replace": replace,
        "matchIndex": match_index,
        "save": save,
        "path": path,
    });

    match ipc.post("/stream-edit-apply", body) {
        Ok(v) => {
            if v["ok"].as_bool() == Some(false) {
                let msg = v["error"].as_str().unwrap_or("stream-edit-apply failed.");
                return tool_error(id, msg.to_string());
            }
            tool_result(id, v)
        }
        Err(e) => tool_error(id, app_not_running_msg_for(&e, path.as_deref())),
    }
}

// ── export_text tool ──────────────────────────────────────────────────────────

/// Strip Markdown syntax from `content` and return the plain text.
///
/// Rules:
/// - YAML front-matter fences (`---` … `---` / `---` … `...`) at the top are
///   removed entirely. A leading `---` that is never closed is not
///   front-matter and the document is kept.
/// - Fenced code blocks (``` or ~~~) — the fence lines are stripped but the
///   code content is preserved as-is.
/// - ATX headings: leading `#` characters and a space are removed.
/// - Setext heading underlines (`===` / `---` only lines) are removed.
/// - Inline bold/italic: `***`, `**`, `__`, `*`, `_` markers are removed.
/// - Inline code spans (`` `…` ``, ` ``…`` `) — backticks stripped, content kept.
/// - Images `![alt](url)` and `![[wikilink]]` → alt text only (or empty).
/// - Links `[text](url)` and `[text][ref]` → link text only.
/// - Blockquote `>` leaders are removed.
/// - Ordered and unordered list markers (`- `, `* `, `+ `, `1. `) are removed.
/// - Task-list checkboxes (`[ ]` / `[x]`) are removed.
/// - HTML tags are stripped.
/// - Horizontal rules (`---`, `***`, `___` on their own line) are removed.
/// - Blank lines are collapsed to a single blank line between paragraphs.
pub fn strip_markdown(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    // Remove YAML front-matter at the very start (only when it is closed).
    let skip = frontmatter_lines(content).map_or(0, |fm| fm.len() + 2);
    let lines: Vec<&str> = content.lines().skip(skip).collect();

    let mut in_code_block = false;
    let mut in_table = false;

    for (idx, &line) in lines.iter().enumerate() {
        // Detect fenced code blocks (``` or ~~~).
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_block = !in_code_block;
            in_table = false;
            // Drop the fence line itself; preserve the code inside.
            continue;
        }
        if in_code_block {
            out.push_str(line);
            out.push('\n');
            continue;
        }

        // GFM tables: a header row followed by a delimiter row starts one,
        // and it runs until a blank line or a line without a pipe. Rows
        // become tab-separated cells; the delimiter row is dropped. A table
        // may sit in a blockquote or a list item, so rows are read without
        // their `>` leaders and list marker.
        let row = table_row_text(line);
        if in_table && !row.contains('|') {
            in_table = false;
        }
        if !in_table && row.contains('|') {
            in_table = lines
                .get(idx + 1)
                .is_some_and(|next| is_table_delimiter(table_row_text(next)));
        }
        if in_table {
            if !is_table_delimiter(row) {
                let cells: Vec<String> = table_cells(row)
                    .iter()
                    .map(|c| strip_inline_markdown(c).trim().to_string())
                    .collect();
                out.push_str(&cells.join("\t"));
                out.push('\n');
            }
            continue;
        }

        // Setext heading underlines (lines that are only `=` or `-`).
        if !trimmed.is_empty()
            && (trimmed.chars().all(|c| c == '=') || trimmed.chars().all(|c| c == '-'))
        {
            continue;
        }

        // Horizontal rules (`---`, `***`, `___` optionally with spaces).
        {
            let no_space: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
            if no_space.len() >= 3
                && (no_space.chars().all(|c| c == '-')
                    || no_space.chars().all(|c| c == '*')
                    || no_space.chars().all(|c| c == '_'))
            {
                continue;
            }
        }

        // Strip ATX heading markers.
        let line = {
            let stripped = trimmed.trim_start_matches('#');
            if stripped.len() < trimmed.len() && stripped.starts_with(' ') {
                without_closing_hashes(stripped.trim_start())
            } else {
                line
            }
        };

        // Strip blockquote leaders.
        let line = {
            let mut s = line;
            while let Some(rest) = s.trim_start().strip_prefix('>') {
                s = rest.trim_start_matches(' ');
            }
            s
        };

        // A footnote definition `[^1]: text` reads `[1] text`.
        if let Some((label, rest)) = line
            .strip_prefix("[^")
            .and_then(|r| r.split_once("]:"))
            .filter(|(label, _)| !label.is_empty() && !label.contains(char::is_whitespace))
        {
            out.push_str(&format!(
                "[{label}] {}",
                strip_inline_markdown(rest.trim_start())
            ));
            out.push('\n');
            continue;
        }

        // Strip list markers (unordered and ordered).
        let line = {
            let s = line.trim_start();
            // Unordered: `- `, `* `, `+ `
            let s = if let Some(r) = s
                .strip_prefix("- ")
                .or_else(|| s.strip_prefix("* "))
                .or_else(|| s.strip_prefix("+ "))
            {
                r
            } else {
                s
            };
            // Ordered: `N. ` (1–3 digit number)
            let s = if s.len() > 2 {
                let dot_pos = s.find(". ");
                if let Some(pos) = dot_pos {
                    if pos <= 3 && s[..pos].chars().all(|c| c.is_ascii_digit()) {
                        &s[pos + 2..]
                    } else {
                        s
                    }
                } else {
                    s
                }
            } else {
                s
            };
            // Task-list checkboxes `[ ] ` / `[x] `
            let s = s
                .strip_prefix("[ ] ")
                .or_else(|| s.strip_prefix("[x] "))
                .or_else(|| s.strip_prefix("[X] "))
                .unwrap_or(s);
            s
        };

        // Now process inline Markdown on the remaining text.
        let plain = strip_inline_markdown(line);
        out.push_str(&plain);
        out.push('\n');
    }

    // Collapse runs of more than one blank line into a single blank line.
    let mut collapsed = String::with_capacity(out.len());
    let mut blank_run = 0usize;
    for line in out.lines() {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run <= 1 {
                collapsed.push('\n');
            }
        } else {
            blank_run = 0;
            collapsed.push_str(line);
            collapsed.push('\n');
        }
    }
    collapsed.trim_end().to_string()
}

/// A line's text as a table row: without leading `>` blockquote leaders and
/// one list marker (`- `, `* `, `+ `, `1. `, `1) `), trimmed.
fn table_row_text(line: &str) -> &str {
    let mut s = line.trim();
    while let Some(rest) = s.strip_prefix('>') {
        s = rest.trim_start();
    }
    if let Some(rest) = s
        .strip_prefix("- ")
        .or_else(|| s.strip_prefix("* "))
        .or_else(|| s.strip_prefix("+ "))
    {
        return rest.trim_start();
    }
    let digits = s.len() - s.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if (1..=9).contains(&digits) {
        if let Some(rest) = s[digits..]
            .strip_prefix(". ")
            .or_else(|| s[digits..].strip_prefix(") "))
        {
            return rest.trim_start();
        }
    }
    s
}

/// True for a GFM table delimiter row such as `|:---|---:|` or `--- | ---`.
fn is_table_delimiter(line: &str) -> bool {
    let t = line.trim();
    t.contains('|')
        && t.contains('-')
        && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
}

/// The cells of a table row, outer pipes dropped and `\|` read as a pipe.
fn table_cells(row: &str) -> Vec<String> {
    let row = row.strip_prefix('|').unwrap_or(row);
    let row = match row.strip_suffix('|') {
        Some(r) if !r.ends_with('\\') => r,
        _ => row,
    };
    let mut cells = vec![String::new()];
    let mut chars = row.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                chars.next();
                cells.last_mut().unwrap().push('|');
            }
            '|' => cells.push(String::new()),
            c => cells.last_mut().unwrap().push(c),
        }
    }
    cells
}

/// Strip inline Markdown from a single (already block-processed) line.
///
/// Handles: images, links, wikilinks, footnote references, bold/italic,
/// strikethrough, inline code, HTML tags.
pub fn strip_inline_markdown(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    let mut i = 0;

    while i < n {
        // Inline image: ![alt](url) or ![alt][ref] → alt text only
        if chars[i] == '!' && i + 1 < n && chars[i + 1] == '[' {
            if let Some((alt, end)) = parse_bracket_content(&chars, i + 1) {
                // skip the trailing (url) or [ref] if present
                let after = skip_link_tail(&chars, end);
                out.push_str(&alt);
                i = after;
                continue;
            }
        }
        // Obsidian embedded image ![[…]] → empty (no useful text)
        if chars[i] == '!' && i + 2 < n && chars[i + 1] == '[' && chars[i + 2] == '[' {
            if let Some(close) = find_double_close(&chars, i + 3) {
                i = close + 2;
                continue;
            }
        }
        // Footnote reference [^1] → [1]
        if chars[i] == '[' && chars.get(i + 1) == Some(&'^') {
            let label_len = chars[i + 2..]
                .iter()
                .take_while(|&&c| c != ']' && !c.is_whitespace())
                .count();
            if label_len > 0 && chars.get(i + 2 + label_len) == Some(&']') {
                out.push('[');
                out.extend(&chars[i + 2..i + 2 + label_len]);
                out.push(']');
                i += label_len + 3;
                continue;
            }
        }
        // Link: [text](url) or [text][ref] → text only
        if chars[i] == '[' {
            if let Some((text, end)) = parse_bracket_content(&chars, i) {
                let after = skip_link_tail(&chars, end);
                out.push_str(&text);
                i = after;
                continue;
            }
        }
        // Wikilink [[…]] → inner text (before any |)
        if chars[i] == '[' && i + 1 < n && chars[i + 1] == '[' {
            if let Some(close) = find_double_close(&chars, i + 2) {
                let inner: String = chars[i + 2..close].iter().collect();
                let label = inner
                    .split('|')
                    .next()
                    .map(str::to_string)
                    .unwrap_or_else(|| inner.clone());
                out.push_str(&label);
                i = close + 2;
                continue;
            }
        }
        // Inline code: `` `…` `` or ` ``…`` ` — strip backticks, keep content.
        if chars[i] == '`' {
            let tick_count = chars[i..].iter().take_while(|&&c| c == '`').count();
            let start = i + tick_count;
            // Find matching closing run of same length.
            let rest = &chars[start..];
            let close_rel = rest
                .windows(tick_count)
                .enumerate()
                .find(|(_, w)| w.iter().all(|&c| c == '`'))
                .map(|(pos, _)| pos);
            if let Some(rel) = close_rel {
                let code: String = chars[start..start + rel].iter().collect();
                out.push_str(&code);
                i = start + rel + tick_count;
                continue;
            }
        }
        // HTML tags and autolinks: `<tag …>`, `</tag>`, `<!-- … -->` are
        // dropped, `<https://…>` keeps its URL. A `<` not followed by a tag
        // name (`a < b`) is text.
        if chars[i] == '<' {
            let starts_tag = chars
                .get(i + 1)
                .is_some_and(|&c| c.is_ascii_alphabetic() || c == '/' || c == '!');
            if starts_tag {
                if let Some(close) = chars[i..].iter().position(|&c| c == '>') {
                    let inner: String = chars[i + 1..i + close].iter().collect();
                    if inner.contains("://") || inner.starts_with("mailto:") {
                        out.push_str(&inner);
                    }
                    i += close + 1;
                    continue;
                }
            }
        }
        // Bold/italic markers: ***, **, __, *, _ — remove markers, but keep
        // a run that cannot be emphasis: one between spaces (`2 * 3`) or an
        // underscore inside a word (`snake_case`).
        if chars[i] == '*' || chars[i] == '_' {
            let marker = chars[i];
            let run = chars[i..].iter().take_while(|&&c| c == marker).count();
            let before = i.checked_sub(1).map(|j| chars[j]);
            let after = chars.get(i + run).copied();
            let space = |c: Option<char>| c.is_none_or(char::is_whitespace);
            let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
            let literal =
                (space(before) && space(after)) || (marker == '_' && word(before) && word(after));
            if literal {
                out.extend(&chars[i..i + run]);
            }
            i += run;
            continue;
        }
        // Strikethrough `~~text~~` keeps its text; a lone `~` (`~5 min`,
        // `~/x`) or a spaced `~~` is text.
        if chars[i] == '~' {
            let run = chars[i..].iter().take_while(|&&c| c == '~').count();
            let before = i.checked_sub(1).map(|j| chars[j]);
            let after = chars.get(i + run).copied();
            let space = |c: Option<char>| c.is_none_or(char::is_whitespace);
            if run != 2 || (space(before) && space(after)) {
                out.extend(&chars[i..i + run]);
            }
            i += run;
            continue;
        }
        // Default: copy character.
        out.push(chars[i]);
        i += 1;
    }

    out
}

// Helper: parse `[…]` bracket content starting at `start` (which must be `[`).
// Returns `(inner_text, index_after_closing_bracket)` or `None`.
fn parse_bracket_content(chars: &[char], start: usize) -> Option<(String, usize)> {
    if chars.get(start) != Some(&'[') {
        return None;
    }
    let mut depth = 0usize;
    let mut i = start;
    let mut inner = String::new();
    while i < chars.len() {
        match chars[i] {
            '[' => {
                depth += 1;
                if depth > 1 {
                    inner.push('[');
                }
            }
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some((inner, i + 1));
                }
                inner.push(']');
            }
            c => inner.push(c),
        }
        i += 1;
    }
    None
}

// Helper: skip the `(url)` or `[ref]` tail after a link/image `]`.
fn skip_link_tail(chars: &[char], start: usize) -> usize {
    let opener = chars.get(start);
    let (open, close) = match opener {
        Some(&'(') => ('(', ')'),
        Some(&'[') => ('[', ']'),
        _ => return start,
    };
    let mut depth = 0usize;
    let mut i = start;
    while i < chars.len() {
        if chars[i] == open {
            depth += 1;
        } else if chars[i] == close {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
        i += 1;
    }
    start
}

// Helper: find `]]` starting from `start`, returns index of first `]`.
fn find_double_close(chars: &[char], start: usize) -> Option<usize> {
    (start..chars.len().saturating_sub(1)).find(|&i| chars[i] == ']' && chars[i + 1] == ']')
}

/// Count words (whitespace-separated tokens) in plain text.
pub fn count_words(text: &str) -> usize {
    text.split_whitespace().count()
}

/// MCP tool: extract plain text from a Markdown document.
///
/// When `args["path"]` is provided, reads that file directly from disk.
/// When omitted, fetches the current document's content via IPC.
///
/// Returns `{ text, word_count, char_count, path? }`.
/// The Markdown `export_text` and `export_metadata` work on, with its path:
/// the file `path` names (read from disk), else the document open in the app.
/// With neither a path nor an open document there is nothing to read, which
/// is an error rather than an empty document.
fn source_document(args: &Value, ipc: &dyn IpcClient) -> Result<(String, Option<String>), String> {
    if let Some(raw) = args["path"].as_str() {
        let doc = checked_document(&agent_path(raw), "path")?;
        let abs = doc.path.clone();
        return match doc.read() {
            Ok(c) => Ok((without_bom(c), Some(abs))),
            Err(e) => Err(cannot_read("", &abs, &e)),
        };
    }
    // With the app closed the error said only to launch it, although these
    // tools read any Markdown file on disk without it.
    let v = ipc.get("/content").map_err(|e| {
        if app_unreachable(&e) {
            format!("{} {NO_APP_PASS_PATH}", app_not_running_msg(&e))
        } else {
            app_not_running_msg(&e)
        }
    })?;
    let content = without_bom(v["content"].as_str().unwrap_or("").to_string());
    let path = v["path"].as_str().map(str::to_string);
    if path.is_none() && content.is_empty() {
        return Err(NO_DOCUMENT_TO_READ.to_string());
    }
    Ok((content, path))
}

/// The error `export_text` and `export_metadata` give without `path` when no
/// document is open. Unlike [`NO_DOCUMENT_OPEN`] it names `path`, which these
/// tools take; `get_current_content`'s description quotes both.
const NO_DOCUMENT_TO_READ: &str = "No document is open in Ashlr MD; pass `path` to read a file.";

/// What `export_text` and `export_metadata` add, without `path`, to the
/// error for an app that cannot be reached: they need the app only to read
/// the open document.
pub const NO_APP_PASS_PATH: &str = "To read a file without the app, pass `path`: the \
Markdown file to read from disk.";

/// `content` without a leading UTF-8 byte order mark. Editors on Windows
/// (Notepad among them) save one; it hid a document's front-matter from
/// `export_metadata` (`frontmatter: null`) and left the raw front-matter in
/// `export_text`'s text and word count.
fn without_bom(content: String) -> String {
    match content.strip_prefix('\u{FEFF}') {
        Some(rest) => rest.to_string(),
        None => content,
    }
}

pub fn tool_export_text(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    if let Err(e) = non_blank_str(args, "path") {
        return Response::err(id, -32602, e);
    }
    let (markdown, path_used) = match source_document(args, ipc) {
        Ok(doc) => doc,
        Err(e) => return tool_error(id, e),
    };

    let text = strip_markdown(&markdown);
    let word_count = count_words(&text);
    let char_count = text.chars().count();

    let mut result = json!({
        "text": text,
        "word_count": word_count,
        "char_count": char_count,
    });
    if let Some(p) = path_used {
        result["path"] = json!(p);
    }
    tool_result(id, result)
}

// ── export_metadata tool ──────────────────────────────────────────────────────

/// The lines between a leading `---` and the closing `---` or `...`, or
/// `None` when the document does not open with front-matter. A leading `---`
/// that is never closed is a thematic break, not front-matter, so the rest
/// of the document is not swallowed.
fn frontmatter_lines(content: &str) -> Option<Vec<&str>> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut fm_lines = Vec::new();
    for line in lines {
        let t = line.trim();
        if t == "---" || t == "..." {
            return Some(fm_lines);
        }
        fm_lines.push(line);
    }
    None
}

/// Extract YAML front-matter from the start of a Markdown document.
///
/// Returns a `serde_json::Value::Object` with the parsed key/value pairs, or
/// `Value::Null` when no front-matter is present or it holds no `key: value`
/// lines. A subset of YAML is read (documented in docs/AGENTS.md): scalars
/// become strings, bools, numbers or null (`~`, `null`, or nothing after the
/// colon), lists (`tags: [a, b]`, or `- item` lines under `tags:`) become
/// arrays whose `- key: value` items are objects, indented `key: value` lines
/// under an empty `key:` become nested objects at any depth, and block scalars
/// (`|`, `>`, with `-` / `+` chomping) become strings.
pub fn extract_frontmatter(content: &str) -> Value {
    let Some(fm_lines) = frontmatter_lines(content) else {
        return Value::Null;
    };
    let mut parser = FrontMatter {
        lines: fm_lines,
        pos: 0,
        depth: 0,
    };
    let mut map = serde_json::Map::new();
    parser.mapping(0, &mut map);
    if map.is_empty() {
        Value::Null
    } else {
        Value::Object(map)
    }
}

/// A line-by-line reader of the front-matter YAML subset, driven by
/// indentation.
struct FrontMatter<'a> {
    lines: Vec<&'a str>,
    pos: usize,
    /// How many nested mappings and sequences enclose the current line.
    depth: usize,
}

/// Deepest nesting of mappings and sequences read; a value nested deeper is
/// null. Every level is a recursive call, so without a bound a hostile
/// document (thousands of `-` lines) overflows the stack and aborts the
/// server.
pub const FRONTMATTER_MAX_DEPTH: usize = 64;

/// A line's indentation: its leading ASCII spaces and tabs, in bytes. YAML
/// indents with spaces only, and counting other Unicode whitespace (a no-break
/// space, an ideographic space) would put a slice inside a multi-byte char.
fn line_indent(line: &str) -> usize {
    line.bytes()
        .take_while(|b| matches!(b, b' ' | b'\t'))
        .count()
}

/// The text of a `- item` line after its dash, or `None` for other lines.
fn sequence_item(t: &str) -> Option<&str> {
    t.strip_prefix("- ").or((t == "-").then_some(""))
}

impl<'a> FrontMatter<'a> {
    /// The next line holding YAML (not blank, not a `#` comment), as its
    /// indentation and trimmed text, without consuming it. Skipped lines are
    /// consumed.
    fn peek(&mut self) -> Option<(usize, &'a str)> {
        while let Some(line) = self.lines.get(self.pos) {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                self.pos += 1;
                continue;
            }
            return Some((line_indent(line), t));
        }
        None
    }

    /// Read `key: value` lines at exactly `indent` into `map`, stopping at
    /// the first line indented less. Deeper lines that no key opened (the
    /// continuation of a plain multi-line scalar) and stray `- item` lines
    /// are skipped.
    fn mapping(&mut self, indent: usize, map: &mut serde_json::Map<String, Value>) {
        while let Some((ind, t)) = self.peek() {
            if ind < indent {
                break;
            }
            self.pos += 1;
            if ind > indent || sequence_item(t).is_some() {
                continue;
            }
            if let Some((key, val_str)) = frontmatter_key_value(t) {
                let value = self.value_after_key(indent, val_str);
                map.insert(key, value);
            }
        }
    }

    /// The value of a key at `indent` whose text after the colon is
    /// `val_str`: a block scalar, a nested block (when empty), or an inline
    /// value.
    fn value_after_key(&mut self, indent: usize, val_str: &str) -> Value {
        if let Some(header) = block_scalar_header(val_str) {
            return self.block_scalar(indent, header);
        }
        if !val_str.is_empty() {
            return frontmatter_value(val_str);
        }
        if self.depth >= FRONTMATTER_MAX_DEPTH {
            self.skip_deeper(indent);
            return Value::Null;
        }
        self.depth += 1;
        let value = self.nested_block(indent);
        self.depth -= 1;
        value
    }

    /// Consume every following line indented deeper than `indent`, and any
    /// `- item` line at `indent` (a list may sit at its key's indentation).
    fn skip_deeper(&mut self, indent: usize) {
        while let Some((ind, t)) = self.peek() {
            if ind < indent || (ind == indent && sequence_item(t).is_none()) {
                break;
            }
            self.pos += 1;
        }
    }

    /// The block under an empty `key:` at `indent`: a list, a mapping, or
    /// null when nothing is nested under it.
    fn nested_block(&mut self, indent: usize) -> Value {
        match self.peek() {
            // A list may sit at its key's own indentation.
            Some((ind, t)) if ind >= indent && sequence_item(t).is_some() => self.sequence(ind),
            Some((ind, _)) if ind > indent => {
                let mut nested = serde_json::Map::new();
                self.mapping(ind, &mut nested);
                if nested.is_empty() {
                    Value::Null
                } else {
                    Value::Object(nested)
                }
            }
            _ => Value::Null,
        }
    }

    /// Read `- item` lines at exactly `indent` into an array. An item that is
    /// a `key: value` pair starts an object whose further keys are the lines
    /// aligned with it.
    fn sequence(&mut self, indent: usize) -> Value {
        let mut items = Vec::new();
        while let Some((ind, t)) = self.peek() {
            let Some(item) = sequence_item(t).filter(|_| ind == indent) else {
                break;
            };
            self.pos += 1;
            let item_text = item.trim_start();
            // The column of the item's text: its object's keys align there.
            let item_indent = ind + (t.len() - item_text.len());
            let item_text = item_text.trim_end();
            let value = if item_text.is_empty() {
                // An empty `-` item holds what is indented under it; the next
                // `-` at its own indentation is a sibling item, not its value.
                match self.peek() {
                    Some((next, _)) if next > ind => self.value_after_key(ind, ""),
                    _ => Value::Null,
                }
            } else if let Some(header) = block_scalar_header(item_text) {
                self.block_scalar(ind, header)
            } else if let Some((key, val_str)) = mapping_item(item_text) {
                let mut obj = serde_json::Map::new();
                let first = self.value_after_key(item_indent, val_str);
                obj.insert(key, first);
                self.mapping(item_indent, &mut obj);
                Value::Object(obj)
            } else {
                frontmatter_value(item_text)
            };
            items.push(value);
        }
        Value::Array(items)
    }

    /// Read the lines of a block scalar whose key sits at `indent`: every
    /// following line indented deeper, plus blank lines among them, joined
    /// as written (`|`) or folded (`>`), then chomped.
    fn block_scalar(&mut self, indent: usize, header: BlockScalar) -> Value {
        let mut body: Vec<&str> = Vec::new();
        let mut content_indent = header.indent.map(|i| indent + i);
        while let Some(line) = self.lines.get(self.pos) {
            if line.trim().is_empty() {
                body.push("");
                self.pos += 1;
                continue;
            }
            let ind = line_indent(line);
            let ci = *content_indent.get_or_insert(ind);
            if ind <= indent || ind < ci {
                break;
            }
            body.push(&line[ci..]);
            self.pos += 1;
        }
        let trailing = body.iter().rev().take_while(|l| l.is_empty()).count();
        body.truncate(body.len() - trailing);
        let mut text = if header.folded {
            fold_lines(&body)
        } else {
            body.join("\n")
        };
        if !body.is_empty() {
            match header.chomp {
                Chomp::Strip => {}
                Chomp::Clip => text.push('\n'),
                Chomp::Keep => text.push_str(&"\n".repeat(trailing + 1)),
            }
        } else if header.chomp == Chomp::Keep {
            text.push_str(&"\n".repeat(trailing));
        }
        Value::String(text)
    }
}

/// How a block scalar treats its final line breaks.
#[derive(Clone, Copy, PartialEq)]
enum Chomp {
    /// `-`: no final line break.
    Strip,
    /// The default: one final line break.
    Clip,
    /// `+`: every trailing line break.
    Keep,
}

/// A block scalar's header (`|`, `>-`, `|+2`, optionally followed by a
/// comment).
#[derive(Clone, Copy)]
struct BlockScalar {
    folded: bool,
    chomp: Chomp,
    /// An explicit indentation indicator, relative to the key.
    indent: Option<usize>,
}

/// Parse `val_str` as a block scalar header, or `None` when it is not one.
fn block_scalar_header(val_str: &str) -> Option<BlockScalar> {
    let head = val_str.split(" #").next()?.trim_end();
    let mut chars = head.chars();
    let folded = match chars.next()? {
        '|' => false,
        '>' => true,
        _ => return None,
    };
    let mut header = BlockScalar {
        folded,
        chomp: Chomp::Clip,
        indent: None,
    };
    for c in chars {
        match c {
            '-' if header.chomp == Chomp::Clip => header.chomp = Chomp::Strip,
            '+' if header.chomp == Chomp::Clip => header.chomp = Chomp::Keep,
            '1'..='9' if header.indent.is_none() => {
                header.indent = c.to_digit(10).map(|d| d as usize)
            }
            _ => return None,
        }
    }
    Some(header)
}

/// Fold a `>` block scalar's lines: a line break between two ordinary lines
/// becomes a space, each blank line a line break, and lines indented more
/// than the block keep their breaks.
fn fold_lines(lines: &[&str]) -> String {
    let mut out = String::new();
    let mut blanks = 0;
    let mut prev_more: Option<bool> = None;
    for line in lines {
        if line.is_empty() {
            blanks += 1;
            continue;
        }
        let more = line.starts_with([' ', '\t']);
        match prev_more {
            None => out.push_str(&"\n".repeat(blanks)),
            Some(false) if !more && blanks == 0 => out.push(' '),
            Some(false) if !more => out.push_str(&"\n".repeat(blanks)),
            Some(_) => out.push_str(&"\n".repeat(blanks + 1)),
        }
        out.push_str(line);
        prev_more = Some(more);
        blanks = 0;
    }
    out
}

/// A `- key: value` item's key and value, or `None` when the item is a
/// scalar (a quoted string, a flow list, or text whose colons are not
/// followed by a space, like a URL).
fn mapping_item(item: &str) -> Option<(String, &str)> {
    if item.starts_with(['"', '\'', '[', '{']) {
        return None;
    }
    frontmatter_key_value(item)
}

/// Split a `key: value` line into its key and its trimmed value text.
/// The colon must be followed by a space or end the line, so `10:30` and
/// `http://x` are not keys.
fn frontmatter_key_value(line: &str) -> Option<(String, &str)> {
    let colon = line
        .match_indices(':')
        .map(|(i, _)| i)
        .find(|&i| line[i + 1..].is_empty() || line[i + 1..].starts_with([' ', '\t']))?;
    let key = line[..colon].trim();
    (!key.is_empty()).then(|| (key.to_string(), line[colon + 1..].trim()))
}

/// The value after a key's colon: null when there is none, an array for a
/// flow list (`[a, b]`), else a scalar.
fn frontmatter_value(val_str: &str) -> Value {
    if val_str.is_empty() {
        return Value::Null;
    }
    match val_str.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        Some(items) => Value::Array(
            split_flow_items(items)
                .into_iter()
                .map(frontmatter_scalar)
                .collect(),
        ),
        None => frontmatter_scalar(val_str),
    }
}

/// One front-matter scalar: null, a bool, an integer, a float, else a string
/// with any surrounding quotes removed.
fn frontmatter_scalar(val_str: &str) -> Value {
    if matches!(val_str, "~" | "null" | "Null" | "NULL") {
        Value::Null
    } else if val_str == "true" {
        json!(true)
    } else if val_str == "false" {
        json!(false)
    } else if let Ok(n) = val_str.parse::<i64>() {
        json!(n)
    } else if let Ok(f) = val_str.parse::<f64>() {
        json!(f)
    } else {
        json!(val_str.trim_matches('"').trim_matches('\''))
    }
}

/// The items of a flow sequence's inside (`a, "b, c", d`), split on commas
/// outside quotes, trimmed, empty ones dropped.
fn split_flow_items(inner: &str) -> Vec<&str> {
    let mut items = Vec::new();
    let mut quote = None;
    let mut start = 0;
    for (i, c) in inner.char_indices() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), _) if c == q => quote = None,
            (None, ',') => {
                items.push(inner[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    items.push(inner[start..].trim());
    items.retain(|s| !s.is_empty());
    items
}

/// An ATX heading's text without its optional closing sequence: `Title ##`
/// is `Title`, while `C#` and `#hashtag` keep their `#`.
fn without_closing_hashes(text: &str) -> &str {
    let text = text.trim_end();
    let body = text.trim_end_matches('#');
    if body.len() == text.len() {
        text
    } else if body.is_empty() {
        ""
    } else if body.ends_with([' ', '\t']) {
        body.trim_end()
    } else {
        text
    }
}

/// Extract ATX headings (lines starting with 1–6 `#` characters) into a tree.
///
/// Returns a JSON array of `{ level: N, text: "…" }` objects in document order.
pub fn extract_headings(content: &str) -> Vec<Value> {
    let mut headings = Vec::new();
    let mut in_code_block = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block {
            continue;
        }
        if trimmed.starts_with('#') {
            let level = trimmed.chars().take_while(|&c| c == '#').count();
            let rest = &trimmed[level..];
            // ATX headings need whitespace after the `#`s: `#tag` and
            // `#!/bin/sh` are text, not headings.
            if level <= 6 && rest.starts_with([' ', '\t']) {
                let after = without_closing_hashes(rest.trim());
                if !after.is_empty() {
                    headings.push(json!({ "level": level, "text": after }));
                }
            }
        }
    }
    headings
}

/// Extract all `[[wikilinks]]` from the content (not inside code blocks).
///
/// Returns a deduplicated, sorted list of link targets (the part before `|`).
pub fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut links = std::collections::HashSet::new();
    let mut in_code_block = false;
    let chars: Vec<char> = content.chars().collect();
    let n = chars.len();
    let mut i = 0;
    while i < n {
        // Toggle code-block state on fence lines.
        if i == 0 || chars[i - 1] == '\n' {
            let rest: String = chars[i..].iter().take_while(|&&c| c != '\n').collect();
            let t = rest.trim();
            if t.starts_with("```") || t.starts_with("~~~") {
                in_code_block = !in_code_block;
            }
        }
        if !in_code_block && chars[i] == '[' && i + 1 < n && chars[i + 1] == '[' {
            if let Some(close) = find_double_close(&chars, i + 2) {
                let inner: String = chars[i + 2..close].iter().collect();
                let target = inner.split('|').next().unwrap_or(&inner).trim().to_string();
                // Exclude embedded image wikilinks (preceded by `!`).
                if (i == 0 || chars[i - 1] != '!') && !target.is_empty() {
                    links.insert(target);
                }
                i = close + 2;
                continue;
            }
        }
        i += 1;
    }
    let mut sorted: Vec<String> = links.into_iter().collect();
    sorted.sort();
    sorted
}

/// Count embedded images: `![…](…)` and `![[…]]` syntax (not in code blocks).
pub fn count_embedded_images(content: &str) -> usize {
    let mut count = 0usize;
    let mut in_code_block = false;
    let chars: Vec<char> = content.chars().collect();
    let n = chars.len();
    let mut i = 0;
    while i < n {
        // Detect code fences at line start.
        if i == 0 || chars[i - 1] == '\n' {
            let rest: String = chars[i..].iter().take_while(|&&c| c != '\n').collect();
            let t = rest.trim();
            if t.starts_with("```") || t.starts_with("~~~") {
                in_code_block = !in_code_block;
            }
        }
        if !in_code_block && chars[i] == '!' {
            // Standard image: ![alt](url)
            if i + 1 < n && chars[i + 1] == '[' {
                // Check it's not a wikilink embed ![[…]]
                if i + 2 < n && chars[i + 2] == '[' {
                    // Embedded wikilink image ![[…]]
                    if let Some(close) = find_double_close(&chars, i + 3) {
                        count += 1;
                        i = close + 2;
                        continue;
                    }
                } else if let Some((_, end)) = parse_bracket_content(&chars, i + 1) {
                    // Check for trailing (url) to confirm it's an image not just `![`
                    if chars.get(end) == Some(&'(') {
                        count += 1;
                        let after = skip_link_tail(&chars, end);
                        i = after;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    count
}

/// MCP tool: extract structural metadata from a Markdown document.
///
/// When `args["path"]` is provided, reads that file directly from disk.
/// When omitted, fetches the current document's content via IPC.
///
/// Returns:
/// ```json
/// {
///   "frontmatter": { … } | null,
///   "headings": [{ "level": N, "text": "…" }, …],
///   "wikilinks": ["Target", …],
///   "embedded_image_count": N,
///   "word_count": N,
///   "path": "…"            // only when a path can be determined
/// }
/// ```
pub fn tool_export_metadata(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    if let Err(e) = non_blank_str(args, "path") {
        return Response::err(id, -32602, e);
    }
    let (markdown, path_used) = match source_document(args, ipc) {
        Ok(doc) => doc,
        Err(e) => return tool_error(id, e),
    };

    let frontmatter = extract_frontmatter(&markdown);
    let headings = extract_headings(&markdown);
    let wikilinks = extract_wikilinks(&markdown);
    let embedded_image_count = count_embedded_images(&markdown);
    let plain = strip_markdown(&markdown);
    let word_count = count_words(&plain);

    let mut result = json!({
        "frontmatter": frontmatter,
        "headings": headings,
        "wikilinks": wikilinks,
        "embedded_image_count": embedded_image_count,
        "word_count": word_count,
    });
    if let Some(p) = path_used {
        result["path"] = json!(p);
    }
    tool_result(id, result)
}
