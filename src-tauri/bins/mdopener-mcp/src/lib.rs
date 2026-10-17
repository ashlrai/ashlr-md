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
}

// ── Method dispatcher ─────────────────────────────────────────────────────────

pub fn dispatch(req: Request, ipc: &dyn IpcClient) -> Option<Response> {
    // JSON-RPC notifications (methods under "notifications/", carrying no id)
    // must NOT receive a response. Drop them silently.
    if req.method.starts_with("notifications/") {
        return None;
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
        "resources/read" => {
            let params = req.params.unwrap_or(Value::Null);
            let uri = params["uri"].as_str().unwrap_or("").to_string();
            handle_resource_read(id, &uri, ipc)
        }

        "prompts/list" => Response::ok(id, json!({ "prompts": prompts_list() })),
        "prompts/get" => {
            let params = req.params.unwrap_or(Value::Null);
            let name = params["name"].as_str().unwrap_or("").to_string();
            handle_prompt_get(id, &name, ipc)
        }

        other => Response::err(id, -32601, format!("Method not found: {other}")),
    };
    Some(response)
}

// ── initialize ────────────────────────────────────────────────────────────────

/// Protocol revisions this server understands. We echo the client's requested
/// version when it's one of these, else answer with the latest one we support
/// (the MCP lifecycle spec: the server "SHOULD" offer its latest version and
/// the client decides whether it can use it).
pub const SUPPORTED_PROTOCOLS: [&str; 3] = ["2024-11-05", "2025-03-26", "2025-06-18"];
pub const DEFAULT_PROTOCOL: &str = "2025-06-18";

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
            }
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
    let mut safe = String::with_capacity(session_id.len());
    for b in session_id.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            safe.push(b as char);
        } else {
            safe.push_str(&format!("%{b:02X}"));
        }
    }
    sessions_dir().map(|d| d.join(format!("{safe}.json")))
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
        let text =
            read_regular_file(&path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        return parse_session_log(&text)
            .map(|log| Some(own(log)))
            .map_err(|e| format!("{} is not a session file: {e}", path.display()));
    }
    let Some(legacy) = legacy_session_file_path(session_id) else {
        return Ok(None);
    };
    if legacy == path {
        return Ok(None);
    }
    let Some(log) = read_regular_file(&legacy)
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
    let dir = sessions_dir().ok_or("Cannot determine home directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
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
    let path = session_file_path(session_id).ok_or("Cannot determine home directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
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
    let written = std::fs::write(&tmp, json)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("Cannot write {}: {e}", path.display()));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Load a session log from disk.  Returns `None` when the file does not exist
/// or cannot be parsed.
pub fn load_session_from_disk(session_id: &str) -> Option<SessionLog> {
    let path = session_file_path(session_id)?;
    let text = read_regular_file(&path).ok()?;
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
    let msg = ConversationMessage {
        id: format!("msg-{ts}-{:08x}-{seq}", std::process::id()),
        session_id: session_id.to_string(),
        role: role.to_string(),
        content: content.trim().to_string(),
        cited_docs,
        timestamp_ms: ts,
    };

    let mut store = conversation_store().lock().map_err(|e| format!("Lock error: {e}"))?;
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

    // Only a log that reached disk replaces the cached one, so a failed
    // write leaves no unsaved message behind.
    persist_session(session_id, &log)
        .map_err(|e| format!("Message not saved to the session file: {e}"))?;
    store.insert(session_id.to_string(), log);
    Ok(msg)
}

/// Retrieve the last `n` messages for `session_id`.
/// If the in-process store is empty for this session, attempt to load from disk
/// (handles cold-start / process-restart scenarios).
pub fn store_get_context(session_id: &str, n: usize) -> Result<Vec<ConversationMessage>, String> {
    let mut store = conversation_store()
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;

    // The persisted log is authoritative (other processes append to it); the
    // in-process copy only answers when it cannot be read.
    if let Ok(Some((log, _))) = load_own_session(session_id) {
        store.insert(session_id.to_string(), log);
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
pub fn tool_registry() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "open_file",
            description: "Open a Markdown file in Ashlr MD. Launches the app if it is not already running.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute or relative path to the Markdown file to open."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["read", "edit"],
                        "description": "Initial view mode. Defaults to 'read'."
                    }
                },
                "required": ["path"]
            }),
            annotations: None,
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "get_current_content",
            description: "Return the path and full Markdown content of the document currently open in Ashlr MD.",
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
            name: "set_content",
            description: "Replace the content of the currently open document in Ashlr MD.",
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
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "list_recent",
            description: "Return the list of recently opened files.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of entries to return. Defaults to 10."
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
            description: "Export the currently open document (an error when none is open). With `output_path` (html, docx or epub) the app writes that file without a dialog and the call returns once it exists, with its size; the document must be shown in Read view. Without `output_path` the app opens its export dialog and the call returns at once. pdf always goes through the system print dialog, so it takes no `output_path`. Exports use the app's current theme.",
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
            description: "Surface a Markdown document to the human for review in Ashlr MD and BLOCK until they Approve or Request changes, then return their verdict and comments. Use this for explicit human sign-off on agent-generated plans, diffs, or docs before proceeding.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the Markdown file to review." },
                    "content": { "type": "string", "description": "Inline Markdown to review, if no file path is given." },
                    "blocking": { "type": "boolean", "description": "If false, register the review and return immediately. Defaults to true." },
                    "timeout_ms": { "type": "integer", "description": "How long the human has to decide (the review panel's window), in milliseconds. Default 300000 (5 min), min 5000, max 600000." },
                    "wait_ms": { "type": "integer", "description": "Max milliseconds this call blocks before returning { status: 'pending', reviewId }. Default 50000, below the 60 s request timeout of common MCP clients." },
                    "review_id": { "type": "string", "description": "Keep waiting on a review a previous call returned as pending, instead of registering a new one." }
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
            description: "Return the human's current review verdict, comments, and task-checkbox states for a document.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the Markdown file." }
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
            description: "Make a precise edit to the currently open document by replacing an EXACT substring. The `find` string must occur exactly once — include enough surrounding context to make it unique, or the edit is refused. Prefer this over replace_document for targeted changes.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "find": { "type": "string", "description": "The exact text to replace. Must appear exactly once in the document." },
                    "replace": { "type": "string", "description": "The replacement text." },
                    "save": { "type": "boolean", "description": "Save to disk after editing. Defaults to false." },
                    "path": { "type": "string", "description": "Optional: assert this is the open document (errors if a different file is open)." }
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
            name: "replace_document",
            description: "Replace the ENTIRE content of the currently open document. Use edit_document for targeted changes; use this only when rewriting the whole document.",
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
            name: "search_vault",
            description: "Semantic + full-text search across the user's vault (the watched folder) and recently opened files. Uses Ollama nomic-embed-text embeddings when available, otherwise grep. Needs the Ashlr MD app (it supplies the vault file list); when the app cannot be reached, pass `vault` to search the Markdown files under that directory on disk instead (mode 'grep-disk', or 'semantic', with `vault` and a `note` saying so), otherwise this is an error. Returns { results, mode, note? }; `note` says in words when semantic search was tried but unavailable, so the results are keyword hits, when semantic results leave out documents whose embedding failed (saying how many), or when the app's own search refused or failed, quoting its reason. In mode 'semantic', 'grep-local' (the app's own search failed, so the vault files were grepped on disk) or 'grep-disk' results are [{ path, snippet, lineNumber, score }] sorted by score; in mode 'grep' (answered by the running app) they are [{ path, fileName, matches: [{ lineNo, snippet }] }]. Also readable as the MCP resource text://vault-search?q={query}.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language or keyword query (case-insensitive). Semantic similarity used when Ollama is available; grep fallback otherwise." },
                    "limit": { "type": "integer", "description": "Max number of results to return. Defaults to 50." },
                    "semantic": { "type": "boolean", "description": "Force semantic mode (true) or grep mode (false). Omit to auto-detect via Ollama availability." },
                    "vault": { "type": "string", "description": "Optional directory (absolute, or relative to the server's working directory) searched on disk when Ashlr MD is not running. Only Markdown files that are not dotfiles, outside hidden folders, node_modules and target, are read. Ignored while the app is reachable." }
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
            description: "Open a document (if a path is given) and switch Ashlr MD into a distraction-free, full-screen reading presentation — ideal for showing the human a finished result.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Optional absolute path to open before presenting. Omit to present the current document." }
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
            description: "Return the AI transform actions available in Ashlr MD (explain, summarize, rewrite, etc.). Each entry includes the action id, label, icon, and the system+user prompt templates it uses. Agents can call this to discover what AI operations the editor supports before composing a workflow. Tip: combine with search_vault (semantic search) to find relevant documents before applying an AI action.",
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
            description: "Return the last N messages of a session's conversation memory store (oldest first), plus the distinct document paths those messages cite. Use this at the start of a multi-turn workflow to recover prior context — what edits were made, which docs were open, and what the human approved — before continuing. Returns an empty list when the session has no messages yet.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "The session identifier previously passed to save_conversation_message. Required."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of messages to return: the most recent N, in chronological order. Defaults to 20, max 200."
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
            description: "Append an agent action or human verdict into the session's persistent memory store so future calls to get_conversation_context can retrieve it. Call this after every significant agent action (edit, export, review result) and after the human provides feedback. Messages survive app restarts via disk persistence at ~/.mdopener/sessions/{sessionId}.json.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Session identifier. Use a stable ID per multi-turn workflow (e.g. the review ID, or a UUID the agent generates at the start of the session)."
                    },
                    "role": {
                        "type": "string",
                        "enum": ["agent", "human", "system"],
                        "description": "'agent' for actions taken by the AI, 'human' for verdicts/comments from the user, 'system' for internal bookkeeping (e.g. document path at session start)."
                    },
                    "content": {
                        "type": "string",
                        "description": "The message text. For agent messages describe the action taken. For human messages include their verdict and any comments."
                    },
                    "cited_docs": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional list of absolute document paths that were open or referenced when this message was produced."
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
            description: "Compare two Markdown documents and return a unified diff with line numbers. Agents use this to review what changed in a file between edits, between vault versions, or to inspect the delta before applying a patch. Returns { diff, hunks, added, removed, path_a, path_b }. Only Markdown files (.md, .markdown, .mdown, .mkd, .mdx) that are not dotfiles are read.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path_a": { "type": "string", "description": "Absolute path to the first (original) document." },
                    "path_b": { "type": "string", "description": "Absolute path to the second (modified) document." },
                    "context_lines": {
                        "type": "integer",
                        "description": "Number of unchanged context lines surrounding each change hunk. Defaults to 3."
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
            description: "Mutate a JSON Canvas (.canvas) file by applying one or more typed edit operations — move/resize nodes, edit text/link/group-label content, set node colour, add/delete nodes and edges, reorder edges, and write changes back to disk. Each operation is atomic: if any step fails the file is left unchanged. Returns { ok, path, nodes_count, edges_count, ops_applied }. Safe for remote/agent use — only operates on files ending in .canvas.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the .canvas file to edit."
                    },
                    "ops": {
                        "type": "array",
                        "description": "Ordered list of edit operations to apply atomically.",
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
                                "id": { "type": "string", "description": "Node or edge id (required for most ops)." },
                                "x": { "type": "number", "description": "New x coordinate (move_node)." },
                                "y": { "type": "number", "description": "New y coordinate (move_node)." },
                                "width": { "type": "number", "description": "New width (resize_node)." },
                                "height": { "type": "number", "description": "New height (resize_node)." },
                                "text": { "type": "string", "description": "New text content (edit_text)." },
                                "url": { "type": "string", "description": "New URL (edit_link)." },
                                "label": { "type": "string", "description": "New label (edit_group_label) or edge label (edit_edge_label). Omit to clear." },
                                "color": { "type": "string", "description": "Color preset '1'–'6' or hex '#RRGGBB'. Omit to clear (set_node_color)." },
                                "node": {
                                    "type": "object",
                                    "description": "Full node object to insert (add_node). Must include id, type, x, y, width, height."
                                },
                                "edge": {
                                    "type": "object",
                                    "description": "Full edge object to insert (add_edge). Must include id, fromNode, toNode."
                                },
                                "ids": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": "Complete ordered list of all edge ids (reorder_edges)."
                                }
                            },
                            "required": ["type"]
                        }
                    },
                    "save": {
                        "type": "boolean",
                        "description": "Write the mutated canvas back to disk. Defaults to true."
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
                When `preview` is true (default), returns a minimal unified diff (±previewLines context) \
                via mcp_stream_edit_preview so the agent can verify the change before applying. \
                When the find string matches multiple locations, ALL candidate diffs are returned ranked \
                by occurrence order (rank 1 = first match) — the agent selects a matchIndex and confirms \
                via stream_edit_apply. With preview=false the app applies the edit at once (unsaved; \
                the find string must match exactly once) and the result has applied: true, so do not \
                call stream_edit_apply afterwards. Prefer this over edit_document for large files or when the agent needs to \
                confirm correctness before committing.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "find": {
                        "type": "string",
                        "description": "Exact text to search for in the current document."
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
                        "description": "Context lines on each side of the diff hunk. Defaults to 5."
                    },
                    "path": {
                        "type": "string",
                        "description": "Optional: assert this is the currently open document path (errors if a different file is open)."
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
                a matchIndex (0-based, default 0) to select which occurrence to edit when the preview \
                returned multiple candidates. The edit is applied atomically against the live document.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "edit_id": {
                        "type": "string",
                        "description": "Optional: the editId of the stream_edit preview, for correlation only. The app re-finds `find` in the live document and applies occurrence `match_index`."
                    },
                    "find": {
                        "type": "string",
                        "description": "The exact find string from the preview request."
                    },
                    "replace": {
                        "type": "string",
                        "description": "The replacement text from the preview request."
                    },
                    "match_index": {
                        "type": "integer",
                        "description": "0-based index of the candidate to apply. Defaults to 0 (first occurrence)."
                    },
                    "save": {
                        "type": "boolean",
                        "description": "Persist to disk after applying. Defaults to false."
                    },
                    "path": {
                        "type": "string",
                        "description": "Optional path assertion — errors if a different file is open."
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
            description: "Extract the plain text of a Markdown document — all Markdown syntax \
                (headings, bold/italic, links, images, blockquotes, horizontal rules, HTML tags) is \
                stripped while code block contents are preserved as-is. Returns the extracted text \
                together with word and character counts. Operates directly on disk; no running app \
                required. Accepts an optional path override; when omitted, reads the currently open \
                document via IPC (an error when nothing is open).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the Markdown file (.md, .markdown, .mdown, .mkd, .mdx; dotfiles and other files are refused). When omitted the currently open document is used."
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
                content: YAML front-matter (parsed to an object), a headings tree (level + text for \
                every ATX heading), all [[wikilinks]] found in the document, the count of embedded \
                images (`![…](…)` and `![[…]]` syntax), and the total word count. Operates directly \
                on disk; no running app required. Accepts an optional path override; when omitted, \
                reads the currently open document via IPC (an error when nothing is open).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the Markdown file (.md, .markdown, .mdown, .mkd, .mdx; dotfiles and other files are refused). When omitted the currently open document is used."
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
    ]
}

/// Canonical list of all tool names — used to verify dispatch coverage.
pub const ALL_TOOL_NAMES: &[&str] = &[
    "open_file",
    "get_current_content",
    "set_content",
    "list_recent",
    "export",
    "request_review",
    "get_user_annotations",
    "edit_document",
    "replace_document",
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
        other => Response::err(id, -32602, format!("Unknown tool: {other}")),
    }
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
    let raw_path = match args["path"].as_str() {
        Some(p) => p.to_string(),
        None => return Response::err(id, -32602, "`path` is required"),
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
        // The app is running and refused the request: say why, and do not
        // retry it through the URL scheme.
        Err(e) if app_refused(&e) => return tool_error(id, e),
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
                "Could not open {abs} in Ashlr MD: the app is not running ({ipc_error}) and {}.",
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

pub fn tool_get_content(id: Value, ipc: &dyn IpcClient) -> Response {
    match ipc.get("/content") {
        Ok(v) => tool_result(id, v),
        Err(e) => tool_error(id, app_not_running_msg(&e)),
    }
}

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

pub fn tool_list_recent(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let limit = args["limit"].as_u64().unwrap_or(10);
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
/// otherwise read it. The app makes the same check.
pub fn openable_document_path(raw: &str) -> Result<String, String> {
    checked_document_path(&agent_path(raw), "path")
}

/// True when an IPC error is the running app refusing the request (an HTTP
/// 4xx other than 401), as opposed to the app being unreachable.
fn app_refused(err: &str) -> bool {
    err.strip_prefix("IPC server returned HTTP 4")
        .is_some_and(|rest| !rest.starts_with("01"))
}

pub fn agent_path(raw: &str) -> String {
    std::fs::canonicalize(raw)
        .or_else(|_| std::path::absolute(raw))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

/// File extensions `output_path` may carry for each headless export format.
fn export_extensions(format: &str) -> &'static [&'static str] {
    match format {
        "html" => &["html", "htm"],
        "docx" => &["docx"],
        "epub" => &["epub"],
        _ => &[],
    }
}

/// Validate and resolve `output_path` for `format`. The app writes there
/// without asking, so only a file with the format's own extension, not a
/// dotfile, in an existing directory is accepted. Errors are argument errors.
pub fn export_output_path(raw: &str, format: &str) -> Result<std::path::PathBuf, String> {
    if format == "pdf" {
        return Err(
            "`output_path` is not supported for pdf: pdf export goes through the \
                    system print dialog. Use html, docx or epub with `output_path`, or omit \
                    `output_path` to print to PDF."
                .to_string(),
        );
    }
    let abs = std::path::absolute(raw).map_err(|e| format!("`output_path` '{raw}': {e}"))?;
    let name = abs.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let allowed = export_extensions(format);
    if name.starts_with('.') || !allowed.contains(&ext.as_str()) {
        return Err(format!(
            "`output_path` '{}' must name a {format} file ({}), not a dotfile",
            abs.display(),
            allowed
                .iter()
                .map(|e| format!(".{e}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let dir = abs.parent().filter(|d| !d.as_os_str().is_empty());
    let dir = dir
        .and_then(|d| std::fs::canonicalize(d).ok())
        .filter(|d| d.is_dir())
        .ok_or_else(|| {
            format!(
                "`output_path` '{}': the directory does not exist; create it first",
                abs.display()
            )
        })?;
    let out = dir.join(name);
    if out.is_dir() {
        return Err(format!("`output_path` '{}' is a directory", out.display()));
    }
    Ok(out)
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

    let output_path = match args["output_path"].as_str() {
        None => None,
        Some(raw) => match export_output_path(raw, &format) {
            Ok(p) => Some(p),
            Err(e) => return Response::err(id, -32602, e),
        },
    };
    let before = output_path.as_deref().and_then(file_fingerprint);

    if let Err(e) = ipc.post(
        "/export",
        json!({
            "format": format,
            "outputPath": output_path.as_ref().map(|p| p.to_string_lossy()),
        }),
    ) {
        return tool_error(id, app_not_running_msg(&e));
    }

    let Some(out) = output_path else {
        // No destination: the app shows its export dialog to the human.
        return tool_result(id, json!({ "ok": true, "format": format, "dialog": true }));
    };

    // The app accepts the request before it renders, and reports nothing back,
    // so the export only counts as done once a new version of the file exists.
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
                     Headless export renders the Read view: open the document, switch it to \
                     Read view, check the app for an error message, then retry.",
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

/// [`tool_request_review`] with the poll interval injected for tests.
pub fn tool_request_review_with(
    id: Value,
    args: &Value,
    ipc: &dyn IpcClient,
    poll: std::time::Duration,
) -> Response {
    let resume = args["review_id"]
        .as_str()
        .filter(|r| !r.is_empty())
        .map(str::to_string);
    let path = match args["path"]
        .as_str()
        .map(openable_document_path)
        .transpose()
    {
        Ok(p) => p,
        Err(e) => return tool_error(id, e),
    };
    let content = args["content"].as_str().map(str::to_string);
    let blocking = args["blocking"].as_bool().unwrap_or(true);
    let timeout_ms = args["timeout_ms"]
        .as_u64()
        .unwrap_or(300_000)
        .clamp(5_000, 600_000);
    let wait_ms = args["wait_ms"]
        .as_u64()
        .unwrap_or(DEFAULT_REVIEW_WAIT_MS)
        .clamp(1_000, 600_000);

    let resumed = resume.is_some();
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
            // forever on a record the app never resolves (a review replaced
            // in the panel by a newer one keeps `pending` in the app).
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
                Err(e) => return tool_error(id, app_not_running_msg(&e)),
            }
            if !blocking {
                return tool_result(id, json!({ "reviewId": review_id, "status": "pending" }));
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
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            if window_ends {
                return tool_result(
                    id,
                    json!({
                        "verdict": "timeout",
                        "reviewId": review_id,
                        "message": "No verdict received within the timeout period."
                    }),
                );
            }
            return tool_result(
                id,
                json!({
                    "status": "pending",
                    "reviewId": review_id,
                    "message": "No verdict yet. Call request_review again with this review_id to keep waiting."
                }),
            );
        }
        std::thread::sleep(poll.min(deadline - now));
        match ipc.get(&endpoint) {
            Err(e) => return tool_error(id, format!("App unreachable during review: {e}")),
            Ok(resp) => match resp["status"].as_str().unwrap_or("") {
                "pending" => continue,
                "timeout" => return tool_result(id, json!({
                    "verdict": "timeout",
                    "reviewId": review_id,
                    "message": "The review window closed with no verdict."
                })),
                "not_found" => return tool_result(id, json!({
                    "verdict": "timeout",
                    "reviewId": review_id,
                    "message": "Review record lost (the app restarted, or the review expired 30 min after its window closed)."
                })),
                _ => return tool_result(id, json!({
                    "verdict": resp["verdict"],
                    "reviewId": review_id,
                    "comments": resp["comments"],
                })),
            },
        }
    }
}

pub fn tool_get_annotations(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let path = match args["path"].as_str() {
        Some(p) => p,
        None => return Response::err(id, -32602, "`path` is required"),
    };
    // request_review stores the canonical path, so look it up the same way.
    let path = agent_path(path);
    let encoded = urlencoding::encode(&path);
    match ipc.get(&format!("/annotations?path={encoded}")) {
        Ok(v) => tool_result(id, v),
        Err(e) => tool_error(id, app_not_running_msg(&e)),
    }
}

// ── Document edit / search / present tools ───────────────────────────────────

pub fn tool_edit_document(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let find = match args["find"].as_str() {
        Some(f) => f.to_string(),
        None => return Response::err(id, -32602, "`find` is required"),
    };
    let replace = match args["replace"].as_str() {
        Some(r) => r.to_string(),
        None => return Response::err(id, -32602, "`replace` is required"),
    };
    let save = args["save"].as_bool().unwrap_or(false);

    let mut body = json!({ "find": find, "replace": replace, "save": save });
    if let Some(p) = args["path"].as_str() {
        body["path"] = json!(agent_path(p));
    }

    match ipc.post("/edit", body) {
        Ok(v) => {
            if v["ok"].as_bool() == Some(false) {
                let msg = v["error"].as_str().unwrap_or("Edit could not be applied.");
                return tool_error(id, msg.to_string());
            }
            tool_result(id, v)
        }
        Err(e) => tool_error(id, app_not_running_msg(&e)),
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
    let query = match args["query"].as_str() {
        Some(q) => q.to_string(),
        None => return Response::err(id, -32602, "`query` is required"),
    };
    let limit = args["limit"].as_u64().unwrap_or(50);
    let vault = match args["vault"].as_str().map(disk_vault_dir).transpose() {
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
            if let Some(note) = semantic_note {
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
                    Ok(json!({
                        "results": results,
                        "mode": "grep-disk",
                        "vault": f.disk_vault,
                        "note": note
                    }))
                }
                Ok(f) => {
                    let results = grep_paths(query, limit, &f.paths);
                    let verb = if refused { "refused" } else { "failed" };
                    let search_note = format!(
                        "Ashlr MD's own search {verb} ({ipc_err}), so these results \
                         come from grepping the vault files on disk."
                    );
                    let note = match semantic_note {
                        Some(n) => format!("{n} {search_note}"),
                        None => search_note,
                    };
                    Ok(json!({
                        "results": results,
                        "mode": "grep-local",
                        "note": note
                    }))
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

/// Most Markdown files a `vault` walk collects, and how deep it goes.
pub const DISK_VAULT_MAX_FILES: usize = 5_000;
const DISK_VAULT_MAX_DEPTH: usize = 16;

/// Resolve a `vault` argument (relative to the server's working directory)
/// to the canonical directory to search on disk; anything that is not an
/// existing directory is refused. Only the documents [`disk_vault_files`]
/// finds under it are read. Errors are for `isError`.
pub fn disk_vault_dir(raw: &str) -> Result<std::path::PathBuf, String> {
    let dir =
        std::fs::canonicalize(raw).map_err(|e| format!("`vault` '{}': {e}", agent_path(raw)))?;
    if !dir.is_dir() {
        return Err(format!(
            "`vault` '{}' is not a directory: name the folder of Markdown files to search.",
            dir.display()
        ));
    }
    Ok(dir)
}

/// The Markdown documents under `dir` that a path-taking tool could read
/// ([`checked_document_path`]), sorted, without entering hidden directories,
/// `node_modules` or `target`, or following directory symlinks. Returns the
/// canonical paths and whether [`DISK_VAULT_MAX_FILES`] cut the walk short.
pub fn disk_vault_files(dir: &std::path::Path) -> (Vec<String>, bool) {
    fn walk(dir: &std::path::Path, depth: usize, out: &mut Vec<String>) -> bool {
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
                if !skip && depth < DISK_VAULT_MAX_DEPTH && walk(&path, depth + 1, out) {
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
    let truncated = walk(dir, 0, &mut out);
    (out, truncated)
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
}

impl VaultFiles {
    /// Says the results come from the disk, not the app, when they do.
    fn disk_note(&self) -> Option<String> {
        let dir = self.disk_vault.as_deref()?;
        let mut note = format!(
            "Ashlr MD could not be reached ({}), so these results come from searching \
             the {} Markdown files under {dir} on disk.",
            self.app_error,
            self.paths.len()
        );
        if self.truncated {
            note.push_str(&format!(
                " Only the first {DISK_VAULT_MAX_FILES} files were searched."
            ));
        }
        Some(note)
    }
}

/// The vault file list from the app, or from walking `vault` on disk when the
/// app cannot be reached. A refusal or other failure is still an error.
fn vault_files(ipc: &dyn IpcClient, vault: Option<&std::path::Path>) -> Result<VaultFiles, String> {
    match (vault_file_paths(ipc), vault) {
        (Ok(paths), _) => Ok(VaultFiles {
            paths,
            disk_vault: None,
            app_error: String::new(),
            truncated: false,
        }),
        (Err(e), Some(dir)) if app_unreachable(&e) => {
            let (paths, truncated) = disk_vault_files(dir);
            Ok(VaultFiles {
                paths,
                disk_vault: Some(dir.to_string_lossy().into_owned()),
                app_error: e,
                truncated,
            })
        }
        (Err(e), _) => Err(e),
    }
}

pub fn tool_present_document(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let path = match args["path"]
        .as_str()
        .map(openable_document_path)
        .transpose()
    {
        Ok(p) => p,
        Err(e) => return tool_error(id, e),
    };
    match ipc.post("/present", json!({ "path": path })) {
        Ok(v) if v["ok"].as_bool() == Some(false) => {
            let what = path.as_deref().unwrap_or("the open document");
            tool_error(id, window_refusal(&v, "present", what))
        }
        Ok(v) => tool_result(id, v),
        Err(e) => tool_error(id, app_not_running_msg(&e)),
    }
}

// ── get_conversation_context tool ────────────────────────────────────────────

/// Return the last N messages from the session's persistent memory store.
/// If the in-process store is empty (cold start / restart), loads from disk.
/// Returns an empty array gracefully when the session has no messages yet.
pub fn tool_get_conversation_context(id: Value, args: &Value) -> Response {
    let session_id = match args["session_id"].as_str() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Response::err(id, -32602, "`session_id` is required"),
    };

    let limit = args["limit"]
        .as_u64()
        .unwrap_or(20)
        .clamp(1, MAX_MESSAGES_PER_SESSION as u64) as usize;

    match store_get_context(&session_id, limit) {
        Ok(messages) => {
            let cited_docs: Vec<String> = messages
                .iter()
                .flat_map(|m| m.cited_docs.iter().cloned())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
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
                        "citedDocs": m.cited_docs,
                        "timestampMs": m.timestamp_ms,
                    })).collect::<Vec<_>>(),
                    "count": messages.len(),
                    "recentDocs": cited_docs,
                }),
            )
        }
        Err(e) => tool_error(id, format!("Failed to read conversation context: {e}")),
    }
}

// ── save_conversation_message tool ───────────────────────────────────────────

/// Append an agent action or human verdict to the session's persistent store.
/// Persists to disk at `~/.mdopener/sessions/{sessionId}.json` after every
/// append so messages survive process restarts.
pub fn tool_save_conversation_message(id: Value, args: &Value) -> Response {
    let session_id = match args["session_id"].as_str() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Response::err(id, -32602, "`session_id` is required"),
    };

    let role = match args["role"].as_str() {
        Some(r) => r,
        None => return Response::err(id, -32602, "`role` is required"),
    };
    if !matches!(role.trim(), "agent" | "human" | "system") {
        let got = role.trim();
        let msg = format!("`role` must be 'agent', 'human', or 'system', got '{got}'");
        return Response::err(id, -32602, msg);
    }

    let content = match args["content"].as_str() {
        Some(c) if !c.trim().is_empty() => c.to_string(),
        Some(_) => return Response::err(id, -32602, "`content` must not be empty"),
        None => return Response::err(id, -32602, "`content` is required"),
    };

    let cited_docs: Vec<String> = args["cited_docs"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    match store_append_message(&session_id, role, &content, cited_docs) {
        Ok(msg) => tool_result(
            id,
            json!({
                "ok": true,
                "messageId": msg.id,
                "sessionId": msg.session_id,
                "role": msg.role,
                "timestampMs": msg.timestamp_ms,
            }),
        ),
        // The arguments were valid (checked above); this is a failure to
        // store the message, e.g. the session file could not be written.
        Err(e) => tool_error(id, e),
    }
}

// ── list_ai_actions tool ──────────────────────────────────────────────────────

/// Static metadata for the AI transform actions defined in src/ai/actions.ts.
/// Kept in sync manually; the integration test verifies the list matches the
/// TypeScript source.  Agents call `list_ai_actions` to discover what
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
            "systemPrompt": "You are an expert editor. Rewrite the provided text to be clearer and more concise while preserving the original meaning and voice. Output only the rewritten text — no commentary, no preamble.",
            "userPromptTemplate": "Rewrite the following text to be clearer and more concise:\n\n{text}"
        },
        {
            "id": "fix-grammar",
            "label": "Fix grammar",
            "shortLabel": "Fix",
            "icon": "✓",
            "scope": "selection",
            "systemPrompt": "You are a meticulous copy editor. Correct spelling, grammar, punctuation, and obvious typos in the provided text. Preserve the original meaning, tone, wording, and any Markdown formatting. Output only the corrected text — no commentary, no preamble.",
            "userPromptTemplate": "Fix the grammar and spelling in the following text:\n\n{text}"
        },
        {
            "id": "concise",
            "label": "Make concise",
            "shortLabel": "Concise",
            "icon": "✂️",
            "scope": "selection",
            "systemPrompt": "You are an expert editor who tightens prose. Make the provided text more concise — remove redundancy and filler while preserving the meaning, key facts, voice, and any Markdown formatting. Output only the rewritten text — no commentary, no preamble.",
            "userPromptTemplate": "Make the following text more concise:\n\n{text}"
        },
        {
            "id": "expand",
            "label": "Expand",
            "shortLabel": "Expand",
            "icon": "➕",
            "scope": "selection",
            "systemPrompt": "You are an expert writer. Expand the provided text with helpful detail, clarification, and supporting points while keeping the original meaning, voice, and any Markdown formatting. Do not invent facts. Output only the expanded text — no commentary, no preamble.",
            "userPromptTemplate": "Expand the following text with more detail:\n\n{text}"
        },
        {
            "id": "explain-diff",
            "label": "Explain changes",
            "shortLabel": "Explain changes",
            "icon": "🔀",
            "scope": "selection",
            "systemPrompt": "You are a precise technical reviewer. The user has a document open with unsaved edits, and the same file changed on disk underneath them. You will be given both versions. Explain, in clear bullet points, what changed on disk relative to their in-editor version — focus on substantive content differences, not whitespace. Be concise and use Markdown.",
            "userPromptTemplate": "MY CURRENT VERSION (in the editor):\n\n```\n{text}\n```\n\nVERSION ON DISK (changed underneath me):\n\n```\n{arg}\n```\n\nExplain what changed on disk compared to my current version."
        },
        {
            "id": "translate",
            "label": "Translate",
            "shortLabel": "Translate",
            "icon": "🌐",
            "scope": "selection",
            "systemPrompt": "You are a professional translator. Translate the provided text into {arg}. Output only the translation — no commentary, no preamble.",
            "userPromptTemplate": "Translate the following into {arg}:\n\n{text}"
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
                // Strip prompt templates — return only discovery metadata.
                json!({
                    "id": action["id"],
                    "label": action["label"],
                    "shortLabel": action["shortLabel"],
                    "icon": action["icon"],
                    "scope": action["scope"]
                })
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
        "description": "The document currently open in Ashlr MD.",
        "mimeType": "text/markdown"
    })];

    // Advertise the semantic-search resource template so MCP clients can
    // discover it and construct queries like text://vault-search?q=my+topic.
    resources.push(json!({
        "uri": "text://vault-search",
        "name": "Vault semantic search",
        "description": "Semantic + full-text search across your vault. Read as text://vault-search?q={query}, adding &vault={directory} to search that folder on disk when the app is not running. Uses Ollama nomic-embed-text embeddings with grep fallback, like the search_vault tool. Returns JSON: { results, mode, query, note? }, shaped as search_vault's reply; `note` says in words when semantic search or the app's own search was unavailable.",
        "mimeType": "application/json"
    }));

    // Advertise the recent-documents resource — agents can read
    // mdopener://recent-documents to get a scoped list of recently opened files
    // with path, title, mtime, and a 200-char preview snippet.
    resources.push(json!({
        "uri": "mdopener://recent-documents",
        "name": "Recently opened documents",
        "description": "Scoped list of recently opened files with path, title, modified time (ms since epoch), and a 200-char preview snippet of each file's content. Returns an empty list when the vault is empty or the app has no recents. Read-only.",
        "mimeType": "application/json"
    }));

    if let Ok(v) = ipc.get("/vault") {
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
    }

    Response::ok(id, json!({ "resources": resources }))
}

pub fn handle_resource_read(id: Value, uri: &str, ipc: &dyn IpcClient) -> Response {
    if uri == "mdopener://current" {
        return match ipc.get("/content") {
            Ok(v) => {
                let text = v["content"].as_str().unwrap_or("").to_string();
                Response::ok(
                    id,
                    json!({
                        "contents": [{ "uri": uri, "mimeType": "text/markdown", "text": text }]
                    }),
                )
            }
            Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
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
    if let Some(rest) = uri.strip_prefix("text://vault-search") {
        // Parse query string: ?q=... (&limit=... optional)
        let qs = rest.strip_prefix('?').unwrap_or("");
        let mut query = String::new();
        let mut limit: u64 = 50;
        let mut vault = None;
        // Query-string encoding: `+` is a space (the listed example is
        // `?q=my+topic`), and `%2B` a literal plus.
        let decode = |val: &str| {
            let val = val.replace('+', " ");
            urlencoding::decode(&val)
                .map(|s| s.into_owned())
                .unwrap_or(val)
        };
        for part in qs.split('&') {
            if let Some(val) = part.strip_prefix("q=") {
                query = decode(val);
            } else if let Some(val) = part.strip_prefix("vault=") {
                match disk_vault_dir(&decode(val)) {
                    Ok(dir) => vault = Some(dir),
                    Err(e) => return Response::err(id, -32602, e),
                }
            } else if let Some(val) = part.strip_prefix("limit=") {
                limit = val.parse().unwrap_or(50);
            }
        }
        if query.is_empty() {
            return Response::err(
                id,
                -32602,
                "text://vault-search requires a query: text://vault-search?q=your+query",
            );
        }

        // The same search as `search_vault`, notes included. Without `vault`
        // every path needs the app (it supplies the vault file list), so
        // failing to reach it is an error rather than an empty result set.
        let semantic = ollama_available();
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
        let decoded = urlencoding::decode(raw).ok().map(|d| d.into_owned());
        let advertised = |p: &str| is_advertised_path(p, ipc);
        let p = if advertised(raw) {
            raw.to_string()
        } else {
            match decoded {
                Some(d) if d != raw && advertised(&d) => d,
                _ => return Response::err(id, -32002, format!("Resource not in vault: {uri}")),
            }
        };
        return match read_regular_file(&p) {
            Ok(text) => Response::ok(
                id,
                json!({
                    "contents": [{ "uri": uri, "mimeType": "text/markdown", "text": text }]
                }),
            ),
            Err(e) => Response::err(id, -32002, format!("Cannot read {p}: {e}")),
        };
    }
    Response::err(id, -32602, format!("Unknown resource URI: {uri}"))
}

/// True if `path` is one of the files the app currently advertises as part of
/// the vault or recents (queried live). Used to scope `resources/read`.
pub fn is_advertised_path(path: &str, ipc: &dyn IpcClient) -> bool {
    let Ok(v) = ipc.get("/vault") else {
        return false;
    };
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

pub fn prompts_list() -> Value {
    json!([
        { "name": "summarize", "description": "Summarize the current document into key points." },
        { "name": "review_plan", "description": "Review the current document as a plan and flag risks, gaps, and unclear steps." },
        { "name": "improve_writing", "description": "Tighten the prose of the current document without changing its meaning." }
    ])
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
            "Improve the writing of the following Markdown document — tighten prose and fix grammar without changing its meaning or structure:"
        }
        other => return Response::err(id, -32602, format!("Unknown prompt: {other}")),
    };
    // Without the live document the prompt would ask the model to work on an
    // empty string, so a missing app or document is an error, not "".
    let content = match ipc.get("/content") {
        // The app answers `{ "path": null, "content": "" }` when nothing is open.
        Ok(v) => match v["content"].as_str() {
            Some(c) if !(c.is_empty() && v["path"].is_null()) => c.to_string(),
            _ => {
                return Response::err(
                    id,
                    -32002,
                    "No document is open in Ashlr MD. Open one first (open_file).",
                )
            }
        },
        Err(e) => return Response::err(id, -32000, app_not_running_msg(&e)),
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
/// read goes through here rather than `std::fs::read_to_string`.
pub fn read_regular_file(path: impl AsRef<std::path::Path>) -> std::io::Result<String> {
    let path = path.as_ref();
    if !std::fs::metadata(path)?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    std::fs::read_to_string(path)
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
/// the canonical path, or a message for an `isError` result.
pub fn checked_document_path(raw: &str, arg: &str) -> Result<String, String> {
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
    if hidden || !markdown {
        return Err(format!(
            "Refusing to read `{arg}` '{abs}': only Markdown documents ({}) that are not \
             dotfiles can be read by this tool.",
            MD_EXTENSIONS
                .iter()
                .map(|e| format!(".{e}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    // A missing file falls through so the caller reports "No such file".
    if let Ok(meta) = std::fs::metadata(p) {
        if !meta.is_file() {
            return Err(format!(
                "Refusing to read `{arg}` '{abs}': it is not a regular file."
            ));
        }
    }
    Ok(abs)
}

/// Collect candidate file paths from the vault and recents advertised by the
/// app.  The list comes from the app over IPC, so this errors when the app is
/// not running (an empty list would read as "no matches").
pub fn vault_file_paths(ipc: &dyn IpcClient) -> Result<Vec<String>, String> {
    let v = ipc.get("/vault")?;
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
    Ok(paths)
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
        let docs = if n == 1 { "document was" } else { "documents were" };
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
        let content = match read_regular_file(path) {
            Ok(c) => c,
            Err(_) => continue,
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
pub fn grep_vault(query: &str, limit: u64, ipc: &dyn IpcClient) -> Result<Vec<Value>, String> {
    Ok(grep_paths(query, limit, &vault_file_paths(ipc)?))
}

/// Grep `paths` on disk for `query` (case-insensitive), best match ratio first.
fn grep_paths(query: &str, limit: u64, paths: &[String]) -> Vec<Value> {
    let lower_query = query.to_lowercase();
    let mut results: Vec<SearchResult> = Vec::new();

    for path in paths {
        let content = match read_regular_file(path) {
            Ok(c) => c,
            Err(_) => continue,
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
    let path = dirs::home_dir()
        .map(|h| h.join(".mdopener").join("ipc-port"))
        .ok_or("Cannot determine home directory")?;

    let content = std::fs::read_to_string(&path)
        .map_err(|_| "~/.mdopener/ipc-port not found — is Ashlr MD running?".to_string())?;

    content
        .trim()
        .parse::<u16>()
        .map_err(|e| format!("Invalid port in ipc-port file: {e}"))
}

/// Read the per-session auth token written by the running app.
pub fn read_ipc_token() -> Result<String, String> {
    let path = dirs::home_dir()
        .map(|h| h.join(".mdopener").join("ipc-token"))
        .ok_or("Cannot determine home directory")?;
    std::fs::read_to_string(&path)
        .map_err(|_| "~/.mdopener/ipc-token not found — is Ashlr MD running?".to_string())
        .and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                Err("~/.mdopener/ipc-token is empty — is Ashlr MD finished starting?".to_string())
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
    let (host, port, path) = parse_url(url)?;
    let body_str = body.to_string();
    let request = format!(
        "POST {path} HTTP/1.0\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body_str}",
        body_str.len()
    );
    let response_body = tcp_roundtrip(&host, port, request.as_bytes())?;
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
    use std::io::{Read as _, Write as _};
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = format!("{host}:{port}");
    let mut stream = TcpStream::connect(&addr)
        .map_err(|e| format!("Could not connect to IPC server at {addr}: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    stream
        .write_all(request)
        .map_err(|e| format!("IPC write error: {e}"))?;

    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|e| format!("IPC read error: {e}"))?;
    Ok(buf)
}

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

pub fn app_not_running_msg(err: &str) -> String {
    // The running app refused the request: its reason (which may quote a
    // path containing "connect" or "not found") is the agent's to see as is.
    if app_refused(err) {
        return err.to_string();
    }
    if err.contains("ipc-port") || err.contains("not found") || err.contains("connect") {
        format!(
            "Ashlr MD does not appear to be running ({}). \
             Launch it first, or use open_file which can start it automatically.",
            err
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
/// of raw content (including front-matter).  Files that no longer exist on
/// disk are silently omitted so the list stays consistent.
pub fn handle_recent_documents_resource(id: Value, ipc: &dyn IpcClient) -> Response {
    // Fetch the recent paths from the app.  When the app is not running, fall
    // back gracefully to an empty list rather than returning an error — the
    // resource contract says "empty list when vault is empty".
    let recent_paths: Vec<String> = match ipc.get("/vault") {
        Ok(v) => v["recents"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => vec![],
    };

    let mut documents: Vec<Value> = Vec::new();
    for path in &recent_paths {
        // Skip paths that no longer exist on disk.
        let content = match read_regular_file(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // mtime in milliseconds since the Unix epoch.
        let mtime_ms: u64 = std::fs::metadata(path)
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

    let payload = json!({ "documents": documents, "count": documents.len() });
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
    let raw_a = match args["path_a"].as_str() {
        Some(p) => p.to_string(),
        None => return Response::err(id, -32602, "`path_a` is required"),
    };
    let raw_b = match args["path_b"].as_str() {
        Some(p) => p.to_string(),
        None => return Response::err(id, -32602, "`path_b` is required"),
    };
    // Clamped: a huge value would overflow the hunk arithmetic.
    let context_lines = args["context_lines"].as_u64().unwrap_or(3).min(10_000) as usize;

    let path_a = match checked_document_path(&raw_a, "path_a") {
        Ok(p) => p,
        Err(e) => return tool_error(id, e),
    };
    let path_b = match checked_document_path(&raw_b, "path_b") {
        Ok(p) => p,
        Err(e) => return tool_error(id, e),
    };

    let content_a = match read_regular_file(&path_a) {
        Ok(c) => c,
        Err(e) => return tool_error(id, format!("Cannot read path_a '{path_a}': {e}")),
    };
    let content_b = match read_regular_file(&path_b) {
        Ok(c) => c,
        Err(e) => return tool_error(id, format!("Cannot read path_b '{path_b}': {e}")),
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
    let lines_a: Vec<&str> = text_a.lines().collect();
    let lines_b: Vec<&str> = text_b.lines().collect();

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
        let end = (run_end + context).min(n);
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
            diff_lines.push(format!("{}{}", e.kind, e.text));
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

/// Apply a list of typed edit operations to a `.canvas` file and optionally
/// write the mutated JSON back to disk.
///
/// The canvas is parsed in full, all ops applied sequentially (aborting on the
/// first error), then re-serialised.  The original file is only overwritten
/// when every op succeeds AND `save` is `true` (default).
pub fn tool_edit_canvas(id: Value, args: &Value) -> Response {
    // ── Validate path ────────────────────────────────────────────────────────
    let raw_path = match args["path"].as_str() {
        Some(p) if !p.is_empty() => p,
        _ => return Response::err(id, -32602, "`path` is required"),
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

    // ── Read file ────────────────────────────────────────────────────────────
    let raw_content = match read_regular_file(&path) {
        Ok(c) => c,
        Err(e) => return tool_error(id, format!("Failed to read {path}: {e}")),
    };

    // ── Parse ────────────────────────────────────────────────────────────────
    let parsed = match parse_canvas_json(&raw_content) {
        Ok(c) => c,
        Err(e) => return tool_error(id, format!("Canvas parse error: {e}")),
    };

    let mut nodes: Vec<serde_json::Map<String, Value>> = parsed.nodes;
    let mut edges: Vec<serde_json::Map<String, Value>> = parsed.edges;
    let mut output = parsed.rest;

    // ── Apply ops ────────────────────────────────────────────────────────────
    let ops = match args["ops"].as_array() {
        Some(a) => a.clone(),
        None => return Response::err(id, -32602, "`ops` must be an array"),
    };
    if ops.is_empty() {
        return Response::err(id, -32602, "`ops` must not be empty");
    }

    let mut ops_applied: Vec<String> = Vec::new();

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
                            format!("op[{i}] move_node: node `{node_id}` not found"),
                        )
                    }
                };
                node.insert("x".into(), json!(x));
                node.insert("y".into(), json!(y));
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
                            format!("op[{i}] resize_node: node `{node_id}` not found"),
                        )
                    }
                };
                node.insert("width".into(), json!(w));
                node.insert("height".into(), json!(h));
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
                            format!("op[{i}] edit_text: node `{node_id}` not found"),
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
                            format!("op[{i}] edit_link: node `{node_id}` not found"),
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
                            format!("op[{i}] edit_group_label: node `{node_id}` not found"),
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
                            format!("op[{i}] set_node_color: node `{node_id}` not found"),
                        )
                    }
                };
                match op.get("color") {
                    Some(Value::Null) | None => {
                        node.remove("color");
                    }
                    Some(v) => {
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
                        format!("op[{i}] delete_node: node `{node_id}` not found"),
                    );
                }
                edges.retain(|e| {
                    e.get("fromNode").and_then(Value::as_str) != Some(node_id)
                        && e.get("toNode").and_then(Value::as_str) != Some(node_id)
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
                        format!("op[{i}] add_edge: fromNode `{from}` not found"),
                    );
                }
                if !nodes
                    .iter()
                    .any(|n| n.get("id").and_then(Value::as_str) == Some(to))
                {
                    return Response::err(
                        id,
                        -32602,
                        format!("op[{i}] add_edge: toNode `{to}` not found"),
                    );
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
                        format!("op[{i}] delete_edge: edge `{edge_id}` not found"),
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
                            format!("op[{i}] edit_edge_label: edge `{edge_id}` not found"),
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
                            "op[{i}] reorder_edges: expected {} ids, got {}",
                            edges.len(),
                            new_ids.len()
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
                                format!("op[{i}] reorder_edges: unknown edge id `{eid}`"),
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
    output.insert("nodes".into(), json!(nodes));
    output.insert("edges".into(), json!(edges));
    let serialised = match serde_json::to_string_pretty(&output) {
        Ok(s) => s,
        Err(e) => return tool_error(id, format!("Serialisation error: {e}")),
    };

    // ── Write to disk ────────────────────────────────────────────────────────
    let save = args["save"].as_bool().unwrap_or(true);
    if save {
        if let Err(e) = std::fs::write(&path, &serialised) {
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
            "ops_applied": ops_applied,
            "saved": save,
            "content": if save { Value::Null } else { json!(serialised) },
        }),
    )
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
///  - `match_count`— total occurrences of find in the document
///  - `ok`         — false when find is empty or not found
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
    let preview_lines = args["preview_lines"].as_u64().unwrap_or(5).clamp(0, 20) as u32;
    let path = args["path"].as_str().map(|p| stream_edit_path(p, ipc));

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
        Err(e) => tool_error(id, app_not_running_msg(&e)),
    }
}

/// Apply a previously previewed stream edit.
///
/// The agent sends this after reviewing the diff returned by `stream_edit`.
/// `match_index` selects which candidate to apply when there are multiple matches.
pub fn tool_stream_edit_apply(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    // Only correlates with a preview: the app re-finds `find` in the live
    // document, so the apply does not depend on it.
    let edit_id = args["edit_id"].as_str().unwrap_or("").to_string();
    let find = match args["find"].as_str() {
        Some(f) if !f.is_empty() => f.to_string(),
        Some(_) => return Response::err(id, -32602, "`find` must not be empty"),
        None => return Response::err(id, -32602, "`find` is required"),
    };
    let replace = match args["replace"].as_str() {
        Some(r) => r.to_string(),
        None => return Response::err(id, -32602, "`replace` is required"),
    };
    let match_index = args["match_index"].as_u64().unwrap_or(0) as u32;
    let save = args["save"].as_bool().unwrap_or(false);
    let path = args["path"].as_str().map(|p| stream_edit_path(p, ipc));

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
        Err(e) => tool_error(id, app_not_running_msg(&e)),
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
    let lines = content.lines().skip(skip);

    let mut in_code_block = false;

    for line in lines {
        // Detect fenced code blocks (``` or ~~~).
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_block = !in_code_block;
            // Drop the fence line itself; preserve the code inside.
            continue;
        }
        if in_code_block {
            out.push_str(line);
            out.push('\n');
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

/// Strip inline Markdown from a single (already block-processed) line.
///
/// Handles: images, links, wikilinks, bold/italic, inline code, HTML tags.
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
        let abs = checked_document_path(raw, "path")?;
        return match read_regular_file(&abs) {
            Ok(c) => Ok((c, Some(abs))),
            Err(e) => Err(format!("Cannot read '{abs}': {e}")),
        };
    }
    let v = ipc.get("/content").map_err(|e| app_not_running_msg(&e))?;
    let content = v["content"].as_str().unwrap_or("").to_string();
    let path = v["path"].as_str().map(str::to_string);
    if path.is_none() && content.is_empty() {
        return Err("No document is open in Ashlr MD; pass `path` to read a file.".to_string());
    }
    Ok((content, path))
}

pub fn tool_export_text(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
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
/// Returns a `serde_json::Value::Object` with the parsed top-level key/value
/// pairs, or `Value::Null` when no front-matter is present or it holds no
/// `key: value` lines. Scalars become strings, bools or numbers, and lists of
/// scalars (`tags: [a, b]`, or `- item` lines under `tags:`) become arrays.
/// A nested mapping is not parsed: its key keeps an empty string, and its
/// indented lines are never read as top-level keys.
pub fn extract_frontmatter(content: &str) -> Value {
    let Some(fm_lines) = frontmatter_lines(content) else {
        return Value::Null;
    };
    let mut map = serde_json::Map::new();
    // The key whose value was left empty, which `- item` lines then fill.
    let mut list_key: Option<String> = None;
    for line in &fm_lines {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some(item) = t.strip_prefix("- ").or((t == "-").then_some("")) {
            if let Some(entry) = list_key.as_ref().and_then(|k| map.get_mut(k)) {
                if *entry == json!("") {
                    *entry = json!([]);
                }
                if let Some(items) = entry.as_array_mut() {
                    items.push(frontmatter_scalar(item.trim()));
                }
            }
            continue;
        }
        if line.starts_with([' ', '\t']) {
            // Part of a nested value: not a top-level key.
            continue;
        }
        list_key = None;
        let Some(colon) = line.find(':') else {
            continue;
        };
        let key = line[..colon].trim().to_string();
        if key.is_empty() {
            continue;
        }
        let val_str = line[colon + 1..].trim();
        let val = match val_str.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
            Some(items) => Value::Array(
                split_flow_items(items)
                    .into_iter()
                    .map(frontmatter_scalar)
                    .collect(),
            ),
            None => frontmatter_scalar(val_str),
        };
        if val_str.is_empty() {
            list_key = Some(key.clone());
        }
        map.insert(key, val);
    }
    if map.is_empty() {
        Value::Null
    } else {
        Value::Object(map)
    }
}

/// One front-matter scalar: a bool, an integer, a float, else a string with
/// any surrounding quotes removed.
fn frontmatter_scalar(val_str: &str) -> Value {
    if val_str == "true" {
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
