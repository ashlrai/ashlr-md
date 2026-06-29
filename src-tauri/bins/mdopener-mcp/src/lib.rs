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
            description: "Trigger an export of the currently open document.",
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
            description: "Full-text search across the user's vault (the watched folder) and recently opened files. Returns matching files with line numbers and snippets.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text to search for (case-insensitive)." },
                    "limit": { "type": "integer", "description": "Max number of files to return. Defaults to 50." }
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
            description: "Return the AI transform actions available in Ashlr MD (explain, summarize, rewrite, etc.). Each entry includes the action id, label, icon, and the system+user prompt templates it uses. Agents can call this to discover what AI operations the editor supports before composing a workflow.",
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
    let output_path = args["output_path"].as_str().map(str::to_string);

    match ipc.post(
        "/export",
        json!({ "format": format, "outputPath": output_path }),
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
    let encoded = urlencoding::encode(&query);
    match ipc.get(&format!("/search?q={encoded}&limit={limit}")) {
        Ok(v) => tool_result(id, v),
        Err(e) => Response::err(id, -32000, app_not_running_msg(&e)),
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
    let mut resources = vec![json!({
        "uri": "mdopener://current",
        "name": "Current document",
        "description": "The document currently open in Ashlr MD.",
        "mimeType": "text/markdown"
    })];

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
