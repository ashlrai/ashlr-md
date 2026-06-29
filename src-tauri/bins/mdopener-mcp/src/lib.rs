//! Library portion of the mdopener-mcp binary — exposed so integration tests
//! can drive the dispatch layer with a mock IPC client.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
        Self { jsonrpc: "2.0", id, result: Some(result), error: None }
    }

    pub fn err(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcError { code, message: message.into() }),
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
/// version when it's one of these, else fall back to our baseline.
pub const SUPPORTED_PROTOCOLS: [&str; 3] = ["2024-11-05", "2025-03-26", "2025-06-18"];
pub const DEFAULT_PROTOCOL: &str = "2024-11-05";

pub fn handle_initialize(id: Value, params: Option<Value>) -> Response {
    // Negotiate: honor the client's requested protocolVersion if we support it,
    // otherwise advertise our baseline (per the MCP lifecycle spec).
    let requested = params
        .as_ref()
        .and_then(|p| p["protocolVersion"].as_str());
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
                "version": "0.1.0"
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

/// Return the directory where session JSON files are persisted.
pub fn sessions_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".mdopener").join("sessions"))
}

/// Path for a specific session's on-disk JSON file.
pub fn session_file_path(session_id: &str) -> Option<std::path::PathBuf> {
    // Sanitise the session ID: keep only alphanumeric, '-', and '_'.
    let safe: String = session_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    sessions_dir().map(|d| d.join(format!("{safe}.json")))
}

/// Persist `log` to `~/.mdopener/sessions/{session_id}.json`.
/// Creates the directory if it does not exist.  Errors are silently ignored
/// (persistence is best-effort; the in-process store is always authoritative).
pub fn persist_session(session_id: &str, log: &SessionLog) {
    let Some(path) = session_file_path(session_id) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(log) {
        let _ = std::fs::write(&path, json);
    }
}

/// Load a session log from disk.  Returns `None` when the file does not exist
/// or cannot be parsed.
pub fn load_session_from_disk(session_id: &str) -> Option<SessionLog> {
    let path = session_file_path(session_id)?;
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
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
        other => return Err(format!("`role` must be 'agent', 'human', or 'system', got '{other}'")),
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let msg = ConversationMessage {
        id: format!("msg-{ts}-{:08x}", std::process::id()),
        session_id: session_id.to_string(),
        role: role.to_string(),
        content: content.trim().to_string(),
        cited_docs,
        timestamp_ms: ts,
    };

    let mut store = conversation_store().lock().map_err(|e| format!("Lock error: {e}"))?;
    let log = store.entry(session_id.to_string()).or_default();
    log.messages.push(msg.clone());

    // Bound the in-process store.
    if log.messages.len() > MAX_MESSAGES_PER_SESSION {
        let excess = log.messages.len() - MAX_MESSAGES_PER_SESSION;
        log.messages.drain(..excess);
    }

    persist_session(session_id, log);
    Ok(msg)
}

/// Retrieve the last `n` messages for `session_id`.
/// If the in-process store is empty for this session, attempt to load from disk
/// (handles cold-start / process-restart scenarios).
pub fn store_get_context(session_id: &str, n: usize) -> Result<Vec<ConversationMessage>, String> {
    let mut store = conversation_store().lock().map_err(|e| format!("Lock error: {e}"))?;

    // Cold-start: load from disk if not in memory.
    if !store.contains_key(session_id) {
        if let Some(log) = load_session_from_disk(session_id) {
            store.insert(session_id.to_string(), log);
        }
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
            description: "Trigger an export of the currently open document. For HTML exports a theme override (paper/sepia/midnight) can be supplied; otherwise the app's current theme is used.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "format": {
                        "type": "string",
                        "enum": ["pdf", "docx", "html"],
                        "description": "Export format."
                    },
                    "output_path": {
                        "type": "string",
                        "description": "Optional absolute path for the output file."
                    },
                    "theme": {
                        "type": "string",
                        "enum": ["paper", "sepia", "midnight"],
                        "description": "Optional theme override for HTML exports (paper/sepia/midnight). When omitted the app's current theme is used. Ignored for PDF and DOCX."
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
                    "timeout_ms": { "type": "integer", "description": "Max milliseconds to wait for a verdict. Default 300000 (5 min), max 600000." }
                },
                "anyOf": [{ "required": ["path"] }, { "required": ["content"] }]
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
            description: "Semantic + full-text search across the user's vault (the watched folder) and recently opened files. Uses Ollama nomic-embed-text embeddings when available, with automatic grep fallback for offline use. Returns scored results sorted by relevance: [{ path, snippet, lineNumber, score }]. Accessible as MCP resource text://vault-search?q={query}.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language or keyword query (case-insensitive). Semantic similarity used when Ollama is available; grep fallback otherwise." },
                    "limit": { "type": "integer", "description": "Max number of results to return. Defaults to 50." },
                    "semantic": { "type": "boolean", "description": "Force semantic mode (true) or grep mode (false). Omit to auto-detect via Ollama availability." }
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
            description: "Return the last N messages from the current session's conversation memory store, plus any recently cited document paths. Use this at the start of a multi-turn workflow to recover prior context — what edits were made, which docs were open, and what the human approved — before continuing. Returns an empty list gracefully when no session has been started.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "The session identifier returned by save_conversation_message. Required when retrieving context for a specific past session; omit to use the most-recently-written session."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of messages to return (most recent first). Defaults to 20, max 200."
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
            name: "export_markdown_archive",
            description: "Export the source Markdown file, its YAML front-matter, and all embedded assets (images, Mermaid diagrams rendered as .svg) as a tar.gz archive. The archive is useful for agents that need to re-import or redistribute the document with all its resources intact. Triggers the export on the currently open document; optionally accepts an explicit vault path. Returns the absolute path of the written archive.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "output_path": {
                        "type": "string",
                        "description": "Absolute path for the output .tar.gz archive. When omitted the app shows a save-file dialog."
                    },
                    "include_assets": {
                        "type": "boolean",
                        "description": "Whether to bundle embedded image assets and Mermaid SVG files. Defaults to true."
                    }
                }
            }),
            annotations: Some(json!({
                "title": "Export Markdown Archive",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "export_canvas_graph",
            description: "Export the current vault's file graph and per-document metadata (title, tags, word count, wikilinks) as a JSON Canvas (.canvas) file compatible with Obsidian and other canvas tools. The canvas positions each document as a card, with edges representing wikilink connections. Useful for visual browsing and re-import into graph-based note tools. Returns the absolute path of the written .canvas file.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "output_path": {
                        "type": "string",
                        "description": "Absolute path for the output .canvas file. When omitted the app shows a save-file dialog."
                    },
                    "include_isolated": {
                        "type": "boolean",
                        "description": "Whether to include documents that have no wikilink connections. Defaults to true."
                    }
                }
            }),
            annotations: Some(json!({
                "title": "Export Canvas Graph",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "batch_export_format",
            description: "Export multiple documents to a target format in one call, writing all outputs to a shared directory. Accepts an array of { path, format, output_dir? } entries; each is exported concurrently and results include per-file ok/error status and the written output path. Useful for agents exporting an entire multi-file plan as PDFs or HTML pages in one round-trip.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "exports": {
                        "type": "array",
                        "description": "List of export requests.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string", "description": "Absolute path to the Markdown file to export." },
                                "format": {
                                    "type": "string",
                                    "enum": ["pdf", "docx", "html"],
                                    "description": "Output format."
                                },
                                "output_dir": {
                                    "type": "string",
                                    "description": "Optional output directory. Defaults to the same directory as the source file."
                                }
                            },
                            "required": ["path", "format"]
                        }
                    }
                },
                "required": ["exports"]
            }),
            annotations: Some(json!({
                "title": "Batch Export Format",
                "readOnlyHint": false,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false
            })),
            tier: ToolTier::Modifier,
        },
        ToolDef {
            name: "diff_documents",
            description: "Compare two Markdown documents and return a unified diff with line numbers. Agents use this to review what changed in a file between edits, between vault versions, or to inspect the delta before applying a patch. Returns { diff, hunks, added, removed, path_a, path_b }.",
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
    "export_markdown_archive",
    "export_canvas_graph",
    "batch_export_format",
    "diff_documents",
];

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
        "export_markdown_archive" => tool_export_markdown_archive(id, &args, ipc),
        "export_canvas_graph" => tool_export_canvas_graph(id, &args, ipc),
        "batch_export_format" => tool_batch_export_format(id, &args, ipc),
        "diff_documents" => tool_diff_documents(id, &args),
        other => Response::err(id, -32602, format!("Unknown tool: {other}")),
    }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

pub fn tool_open_file(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let raw_path = match args["path"].as_str() {
        Some(p) => p.to_string(),
        None => return Response::err(id, -32602, "`path` is required"),
    };

    let abs = std::fs::canonicalize(&raw_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(raw_path.clone());

    let mode = args["mode"].as_str();

    // Try IPC first (app already running).
    match ipc.post("/open", json!({ "path": abs, "mode": mode })) {
        Ok(resp) => return tool_result(id, json!({ "opened": abs, "response": resp })),
        Err(_) => {
            // Fall back: launch / bring to front via URL scheme.
        }
    }

    let encoded = urlencoding::encode(&abs);
    let mut url = format!("mdopener://open?path={encoded}");
    if let Some(m) = mode {
        url.push_str(&format!("&mode={m}"));
    }

    match std::process::Command::new("open").arg(&url).status() {
        Ok(s) if s.success() => {
            tool_result(id, json!({ "opened": abs, "method": "url-scheme" }))
        }
        Ok(s) => Response::err(
            id,
            -32000,
            format!("`open` exited with status {}", s.code().unwrap_or(-1)),
        ),
        Err(e) => Response::err(id, -32000, format!("Failed to run `open`: {e}")),
    }
}

pub fn tool_get_content(id: Value, ipc: &dyn IpcClient) -> Response {
    match ipc.get("/content") {
        Ok(v) => tool_result(id, v),
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
    }
}

pub fn tool_set_content(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let content = match args["content"].as_str() {
        Some(c) => c.to_string(),
        None => return Response::err(id, -32602, "`content` is required"),
    };
    let save = args["save"].as_bool().unwrap_or(false);

    match ipc.post("/content", json!({ "content": content, "save": save })) {
        Ok(v) => tool_result(id, v),
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
    }
}

pub fn tool_list_recent(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let limit = args["limit"].as_u64().unwrap_or(10);
    match ipc.get(&format!("/recent?limit={limit}")) {
        Ok(v) => tool_result(id, v),
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
    }
}

pub fn tool_export(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let format = match args["format"].as_str() {
        Some(f) => f.to_string(),
        None => return Response::err(id, -32602, "`format` is required"),
    };

    // Validate theme when provided — only valid for html format.
    let theme = args["theme"].as_str().map(str::to_string);
    if let Some(ref t) = theme {
        match t.as_str() {
            "paper" | "sepia" | "midnight" => {}
            other => {
                return Response::err(
                    id,
                    -32602,
                    format!("`theme` must be one of paper/sepia/midnight, got '{other}'"),
                )
            }
        }
    }

    let output_path = args["output_path"].as_str().map(str::to_string);

    match ipc.post(
        "/export",
        json!({ "format": format, "outputPath": output_path, "theme": theme }),
    ) {
        Ok(v) => tool_result(id, v),
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
    }
}

// ── Human-review loop ─────────────────────────────────────────────────────────

/// Register a review with the app, then POLL for the human's verdict in a loop
/// (each poll is a fresh request well within the 5s TCP timeout). Returns the
/// verdict to the agent, or a timeout if no decision arrives in time.
pub fn tool_request_review(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let path = args["path"].as_str().map(|p| {
        std::fs::canonicalize(p)
            .map(|c| c.to_string_lossy().into_owned())
            .unwrap_or_else(|_| p.to_string())
    });
    let content = args["content"].as_str().map(str::to_string);
    let blocking = args["blocking"].as_bool().unwrap_or(true);
    let timeout_ms = args["timeout_ms"].as_u64().unwrap_or(300_000).clamp(5_000, 600_000);

    if path.is_none() && content.is_none() {
        return Response::err(id, -32602, "Either `path` or `content` is required");
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let review_id = format!("rev_{nanos}_{:08x}", std::process::id());

    let post_body = json!({
        "reviewId": review_id,
        "path": path,
        "content": content,
        "timeoutMs": timeout_ms,
    });
    if let Err(e) = ipc.post("/review", post_body) {
        return Response::err(id, -32000, app_not_running_msg(&e));
    }

    if !blocking {
        return tool_result(id, json!({ "reviewId": review_id, "status": "pending" }));
    }

    let poll = std::time::Duration::from_millis(1_500);
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    let endpoint = format!("/review/result?id={review_id}");
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            return tool_result(id, json!({
                "verdict": "timeout",
                "reviewId": review_id,
                "message": "No verdict received within the timeout period."
            }));
        }
        std::thread::sleep(poll.min(deadline - now));
        match ipc.get(&endpoint) {
            Err(e) => return Response::err(id, -32000, format!("App unreachable during review: {e}")),
            Ok(resp) => match resp["status"].as_str().unwrap_or("") {
                "pending" => continue,
                "not_found" => return tool_result(id, json!({
                    "verdict": "timeout",
                    "reviewId": review_id,
                    "message": "Review record lost (app may have restarted)."
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
    let encoded = urlencoding::encode(path);
    match ipc.get(&format!("/annotations?path={encoded}")) {
        Ok(v) => tool_result(id, v),
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
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
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
    }
}

pub fn tool_replace_document(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let content = match args["content"].as_str() {
        Some(c) => c.to_string(),
        None => return Response::err(id, -32602, "`content` is required"),
    };
    let save = args["save"].as_bool().unwrap_or(false);
    match ipc.post("/content", json!({ "content": content, "save": save })) {
        Ok(v) => tool_result(id, v),
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
    }
}

pub fn tool_search_vault(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let query = match args["query"].as_str() {
        Some(q) => q.to_string(),
        None => return Response::err(id, -32602, "`query` is required"),
    };
    let limit = args["limit"].as_u64().unwrap_or(50);

    // Determine search mode: explicit override or auto-detect via Ollama.
    let use_semantic = match args["semantic"].as_bool() {
        Some(b) => b,
        None => ollama_available(),
    };

    if use_semantic {
        // Attempt semantic search via Ollama embeddings.
        match semantic_search_vault(&query, limit, ipc) {
            Ok(results) => {
                return tool_result(id, json!({
                    "results": results,
                    "mode": "semantic"
                }));
            }
            Err(_) => {
                // Embedding failed — fall through to grep.
            }
        }
    }

    // Grep fallback: ask the app's IPC layer (which does its own grep), or
    // perform a local grep if the app is not running.
    let encoded = urlencoding::encode(&query);
    match ipc.get(&format!("/search?q={encoded}&limit={limit}")) {
        Ok(mut v) => {
            v["mode"] = json!("grep");
            tool_result(id, v)
        }
        Err(_ipc_err) => {
            // App not running — perform local grep across vault files.
            match grep_vault(&query, limit, ipc) {
                Ok(results) => tool_result(id, json!({
                    "results": results,
                    "mode": "grep-local"
                })),
                Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
            }
        }
    }
}

pub fn tool_present_document(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let path = args["path"].as_str().map(|p| {
        std::fs::canonicalize(p)
            .map(|c| c.to_string_lossy().into_owned())
            .unwrap_or_else(|_| p.to_string())
    });
    match ipc.post("/present", json!({ "path": path })) {
        Ok(v) => tool_result(id, v),
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
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

            tool_result(id, json!({
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
            }))
        }
        Err(e) => Response::err(id, -32000, format!("Failed to read conversation context: {e}")),
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

    let content = match args["content"].as_str() {
        Some(c) if !c.trim().is_empty() => c.to_string(),
        Some(_) => return Response::err(id, -32602, "`content` must not be empty"),
        None => return Response::err(id, -32602, "`content` is required"),
    };

    let cited_docs: Vec<String> = args["cited_docs"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    match store_append_message(&session_id, role, &content, cited_docs) {
        Ok(msg) => tool_result(id, json!({
            "ok": true,
            "messageId": msg.id,
            "sessionId": msg.session_id,
            "role": msg.role,
            "timestampMs": msg.timestamp_ms,
        })),
        Err(e) => Response::err(id, -32602, e),
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

    tool_result(id, json!({
        "actions": filtered,
        "count": filtered.len()
    }))
}

// ── Resources ─────────────────────────────────────────────────────────────────

pub fn handle_resources_list(id: Value, ipc: &dyn IpcClient) -> Response {
    let mut resources = vec![
        json!({
            "uri": "mdopener://current",
            "name": "Current document",
            "description": "The document currently open in Ashlr MD.",
            "mimeType": "text/markdown"
        }),
        json!({
            "uri": "export:current",
            "name": "Live HTML export",
            "description": "Read-only live HTML export of the current document. Auto-updates when the document is edited. Agents can poll this to preview rendered output without writing any files.",
            "mimeType": "text/html"
        }),
    ];

    // Advertise the semantic-search resource template so MCP clients can
    // discover it and construct queries like text://vault-search?q=my+topic.
    resources.push(json!({
        "uri": "text://vault-search",
        "name": "Vault semantic search",
        "description": "Semantic + full-text search across your vault. Read as text://vault-search?q={query}. Uses Ollama nomic-embed-text embeddings with grep fallback. Returns JSON: { results: [{ path, snippet, lineNumber, score }], mode }.",
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
                Response::ok(id, json!({
                    "contents": [{ "uri": uri, "mimeType": "text/markdown", "text": text }]
                }))
            }
            Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
        };
    }

    // export:current — live HTML export of the current document.
    // The app renders the document to HTML and returns it via /export/preview.
    // This endpoint is read-only and returns the latest rendered state each time
    // it is polled, so agents always see up-to-date output without file I/O.
    if uri == "export:current" {
        return match ipc.get("/export/preview") {
            Ok(v) => {
                let html = v["html"].as_str().unwrap_or("").to_string();
                let title = v["title"].as_str().unwrap_or("").to_string();
                let theme = v["theme"].as_str().unwrap_or("paper").to_string();
                // Include metadata as a comment so agents can inspect it without
                // parsing the full HTML document.
                let annotated = format!(
                    "<!-- export:current title={title:?} theme={theme:?} -->\n{html}"
                );
                Response::ok(id, json!({
                    "contents": [{
                        "uri": uri,
                        "mimeType": "text/html",
                        "text": annotated
                    }]
                }))
            }
            Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
        };
    }

    // text://vault-search?q={query} — on-demand semantic/grep search resource.
    // Agents can read this URI to perform a search without calling the tool.
    if let Some(rest) = uri.strip_prefix("text://vault-search") {
        // Parse query string: ?q=... (&limit=... optional)
        let qs = rest.strip_prefix('?').unwrap_or("");
        let mut query = String::new();
        let mut limit: u64 = 50;
        for part in qs.split('&') {
            if let Some(val) = part.strip_prefix("q=") {
                query = urlencoding::decode(val)
                    .map(|s| s.into_owned())
                    .unwrap_or_else(|_| val.replace('+', " "));
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

        // Try semantic search, fall back to grep.
        let (results, mode) = if ollama_available() {
            match semantic_search_vault(&query, limit, ipc) {
                Ok(r) => (r, "semantic"),
                Err(_) => {
                    let r = grep_vault(&query, limit, ipc).unwrap_or_default();
                    (r, "grep-local")
                }
            }
        } else {
            // Try IPC grep first.
            let encoded = urlencoding::encode(&query);
            match ipc.get(&format!("/search?q={encoded}&limit={limit}")) {
                Ok(v) => {
                    let results = v["results"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    (results, "grep")
                }
                Err(_) => {
                    let r = grep_vault(&query, limit, ipc).unwrap_or_default();
                    (r, "grep-local")
                }
            }
        };

        let payload = json!({ "results": results, "mode": mode, "query": query });
        return Response::ok(id, json!({
            "contents": [{
                "uri": uri,
                "mimeType": "application/json",
                "text": payload.to_string()
            }]
        }));
    }

    // mdopener://recent-documents — scoped list of recently opened files.
    // Returns an array of { path, title, mtimeMs, preview } objects, pruned to
    // files that still exist on disk.  Preview is the first 200 chars of content.
    if uri == "mdopener://recent-documents" {
        return handle_recent_documents_resource(id, ipc);
    }

    if let Some(p) = uri.strip_prefix("file://") {
        if !is_advertised_path(p, ipc) {
            return Response::err(id, -32002, format!("Resource not in vault: {uri}"));
        }
        return match std::fs::read_to_string(p) {
            Ok(text) => Response::ok(id, json!({
                "contents": [{ "uri": uri, "mimeType": "text/markdown", "text": text }]
            })),
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
    let content = ipc
        .get("/content")
        .ok()
        .and_then(|v| v["content"].as_str().map(str::to_string))
        .unwrap_or_default();
    let text = format!("{instruction}\n\n---\n\n{content}");

    Response::ok(id, json!({
        "description": format!("Apply the '{name}' prompt to the current Ashlr MD document"),
        "messages": [{ "role": "user", "content": { "type": "text", "text": text } }]
    }))
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
    if mag_a == 0.0 || mag_b == 0.0 { 0.0 } else { dot / (mag_a * mag_b) }
}

/// Canonicalize a path string, returning the input unchanged on failure.
pub fn canonicalize_path(raw: &str) -> String {
    std::fs::canonicalize(raw)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

/// Collect candidate file paths from the vault and recents advertised by the
/// app.  Falls back to an empty list if the app is not running.
pub fn vault_file_paths(ipc: &dyn IpcClient) -> Vec<String> {
    let mut paths = Vec::new();
    if let Ok(v) = ipc.get("/vault") {
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
    }
    paths
}

/// Perform semantic search: embed the query and each candidate document,
/// rank by cosine similarity, return top-`limit` results sorted by score.
///
/// Errors if Ollama is not reachable or embedding the query fails.
pub fn semantic_search_vault(
    query: &str,
    limit: u64,
    ipc: &dyn IpcClient,
) -> Result<Vec<Value>, String> {
    let query_vec = ollama_embed(query)?;
    let paths = vault_file_paths(ipc);
    let mut scored: Vec<SearchResult> = Vec::new();

    for path in &paths {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // Truncate to first 8 KB to stay within typical embedding context limits.
        let truncated: String = content.chars().take(8192).collect();
        let doc_vec = match ollama_embed(&truncated) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let score = cosine_similarity(&query_vec, &doc_vec);
        let (line_number, snippet) = best_snippet_for_query(&content, query);
        scored.push(SearchResult { path: path.clone(), snippet, line_number, score });
    }

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit as usize);
    Ok(scored.iter().map(|r| r.to_json()).collect())
}

/// Perform a local grep search across vault files when the app IPC is
/// unavailable.  Reads files directly from disk.
pub fn grep_vault(
    query: &str,
    limit: u64,
    ipc: &dyn IpcClient,
) -> Result<Vec<Value>, String> {
    let paths = vault_file_paths(ipc);
    if paths.is_empty() {
        return Ok(vec![]);
    }
    let lower_query = query.to_lowercase();
    let mut results: Vec<SearchResult> = Vec::new();

    for path in &paths {
        let content = match std::fs::read_to_string(path) {
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

    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(limit as usize);
    Ok(results.iter().map(|r| r.to_json()).collect())
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
    let (host, port_str) = authority
        .split_once(':')
        .ok_or("Expected host:port")?;
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
                return Err(format!("IPC server returned HTTP {code}"));
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

/// A tool-level error (the call reached the app but the operation was rejected).
pub fn tool_error(id: Value, message: String) -> Response {
    Response::ok(
        id,
        json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true
        }),
    )
}

// ── export_markdown_archive tool ─────────────────────────────────────────────

/// Trigger a Markdown + assets archive export via the app IPC.
/// Posts `{ outputPath, includeAssets }` to `/export/markdown-archive`.
/// The app packs the current document's .md source, its YAML front-matter,
/// and any embedded images / Mermaid SVGs into a tar.gz at `outputPath`.
pub fn tool_export_markdown_archive(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let output_path = args["output_path"].as_str().map(str::to_string);
    let include_assets = args["include_assets"].as_bool().unwrap_or(true);

    match ipc.post(
        "/export/markdown-archive",
        json!({
            "outputPath": output_path,
            "includeAssets": include_assets
        }),
    ) {
        Ok(v) => tool_result(id, v),
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
    }
}

// ── export_canvas_graph tool ──────────────────────────────────────────────────

/// Trigger a JSON Canvas (.canvas) export of the vault file graph via the app IPC.
/// Posts `{ outputPath, includeIsolated }` to `/export/canvas-graph`.
/// The app builds a canvas with one card per document and edges for wikilinks,
/// writing the result to `outputPath` (or opening a save dialog if omitted).
pub fn tool_export_canvas_graph(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let output_path = args["output_path"].as_str().map(str::to_string);
    let include_isolated = args["include_isolated"].as_bool().unwrap_or(true);

    match ipc.post(
        "/export/canvas-graph",
        json!({
            "outputPath": output_path,
            "includeIsolated": include_isolated
        }),
    ) {
        Ok(v) => tool_result(id, v),
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
    }
}

pub fn app_not_running_msg(err: &str) -> String {
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
        let content = match std::fs::read_to_string(path) {
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
    Response::ok(id, json!({
        "contents": [{
            "uri": "mdopener://recent-documents",
            "mimeType": "application/json",
            "text": payload.to_string()
        }]
    }))
}

// ── batch_export_format tool ──────────────────────────────────────────────────

/// Export an array of documents to their requested formats via the app IPC.
///
/// Each entry in `exports` is forwarded to the app as a separate `/export`
/// POST, keyed by `{ path, format, outputDir }`.  The app handles the actual
/// rendering; we collect per-file results and return them all in one response.
///
/// The IPC call used is `mcp_batch_export` — the frontend bridge listens for
/// this and fans out to the per-format export functions, then replies with an
/// array of `{ path, format, ok, outputPath, error }` results.
pub fn tool_batch_export_format(id: Value, args: &Value, ipc: &dyn IpcClient) -> Response {
    let exports = match args["exports"].as_array() {
        Some(arr) if !arr.is_empty() => arr.clone(),
        Some(_) => return Response::err(id, -32602, "`exports` array must not be empty"),
        None => return Response::err(id, -32602, "`exports` is required"),
    };

    // Validate each entry has required fields before sending to the app.
    for (i, entry) in exports.iter().enumerate() {
        if entry["path"].as_str().is_none() {
            return Response::err(
                id,
                -32602,
                format!("exports[{i}].path is required"),
            );
        }
        match entry["format"].as_str() {
            Some("pdf") | Some("docx") | Some("html") => {}
            Some(other) => {
                return Response::err(
                    id,
                    -32602,
                    format!("exports[{i}].format must be pdf/docx/html, got '{other}'"),
                )
            }
            None => {
                return Response::err(
                    id,
                    -32602,
                    format!("exports[{i}].format is required"),
                )
            }
        }
    }

    match ipc.post("/export/batch", json!({ "exports": exports })) {
        Ok(v) => tool_result(id, v),
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
    }
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
    let context_lines = args["context_lines"].as_u64().unwrap_or(3) as usize;

    let path_a = canonicalize_path(&raw_a);
    let path_b = canonicalize_path(&raw_b);

    let content_a = match std::fs::read_to_string(&path_a) {
        Ok(c) => c,
        Err(e) => return Response::err(id, -32002, format!("Cannot read path_a '{path_a}': {e}")),
    };
    let content_b = match std::fs::read_to_string(&path_b) {
        Ok(c) => c,
        Err(e) => return Response::err(id, -32002, format!("Cannot read path_b '{path_b}': {e}")),
    };

    let (diff, hunks, added, removed) =
        compute_unified_diff(&path_a, &path_b, &content_a, &content_b, context_lines);

    tool_result(id, json!({
        "diff": diff,
        "hunks": hunks,
        "added": added,
        "removed": removed,
        "path_a": path_a,
        "path_b": path_b,
    }))
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

    // Convert edit script into (kind, line_a, line_b, text) tuples.
    // kind: ' ' = context, '+' = added, '-' = removed
    #[derive(Clone)]
    struct EditLine {
        kind: char,
        line_a: usize, // 1-based, 0 when not from A
        line_b: usize, // 1-based, 0 when not from B
        text: String,
    }

    let mut edits: Vec<EditLine> = Vec::new();
    let mut ia = 0usize;
    let mut ib = 0usize;

    for op in &lcs {
        match op {
            DiffOp::Equal(na, nb) => {
                edits.push(EditLine { kind: ' ', line_a: ia + 1, line_b: ib + 1, text: lines_a[*na].to_string() });
                ia = na + 1;
                ib = nb + 1;
            }
            DiffOp::Delete(na) => {
                edits.push(EditLine { kind: '-', line_a: ia + 1, line_b: 0, text: lines_a[*na].to_string() });
                ia = na + 1;
            }
            DiffOp::Insert(nb) => {
                edits.push(EditLine { kind: '+', line_a: 0, line_b: ib + 1, text: lines_b[*nb].to_string() });
                ib = nb + 1;
            }
        }
    }
    // Drain remaining lines from A (deletions) and B (insertions).
    while ia < lines_a.len() {
        edits.push(EditLine { kind: '-', line_a: ia + 1, line_b: 0, text: lines_a[ia].to_string() });
        ia += 1;
    }
    while ib < lines_b.len() {
        edits.push(EditLine { kind: '+', line_a: 0, line_b: ib + 1, text: lines_b[ib].to_string() });
        ib += 1;
    }

    // Group into hunks: runs of changes + context_lines of context on each side.
    let mut hunk_ranges: Vec<(usize, usize)> = Vec::new(); // (start_idx, end_idx) in edits[]
    let n = edits.len();
    let mut i = 0;
    while i < n {
        if edits[i].kind != ' ' {
            // Found a change — extend hunk window by context_lines each side.
            let start = i.saturating_sub(context);
            let mut end = i;
            while end < n && (edits[end].kind != ' ' || end < i + context) {
                end += 1;
            }
            end = end.min(n);
            // Merge with previous hunk if overlapping.
            if let Some(last) = hunk_ranges.last_mut() {
                if start <= last.1 {
                    last.1 = end;
                    i = end;
                    continue;
                }
            }
            hunk_ranges.push((start, end));
            i = end;
        } else {
            i += 1;
        }
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

        // Compute @@ header: line ranges in A and B.
        let (first_a, first_b) = slice.iter().fold((0usize, 0usize), |acc, e| {
            (
                if acc.0 == 0 && e.line_a > 0 { e.line_a } else { acc.0 },
                if acc.1 == 0 && e.line_b > 0 { e.line_b } else { acc.1 },
            )
        });
        let count_a = slice.iter().filter(|e| e.kind != '+').count();
        let count_b = slice.iter().filter(|e| e.kind != '-').count();
        diff_lines.push(format!(
            "@@ -{},{} +{},{} @@",
            first_a, count_a, first_b, count_b
        ));

        for e in slice {
            diff_lines.push(format!("{}{}", e.kind, e.text));
            if e.kind == '+' { total_added += 1; }
            if e.kind == '-' { total_removed += 1; }
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

/// Compute an edit script between two slices using a simple O(ND) LCS
/// approach.  Returns the ops in document order.
///
/// This is not the fastest possible implementation but it is correct, has no
/// external dependencies, and is fast enough for typical Markdown documents
/// (hundreds to low thousands of lines).
pub fn lcs_diff<T: PartialEq>(a: &[T], b: &[T]) -> Vec<DiffOp> {
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
