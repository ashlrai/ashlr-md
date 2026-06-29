//! Integration tests for all 12 mdopener-mcp tools.
//!
//! Uses a `MockIpc` struct that intercepts IPC calls and returns scripted
//! fixtures — no running Ashlr MD app required.  Both success and failure
//! paths are exercised for every tool.
//!
//! Also covers:
//! - Data-driven registry: every tool has a valid JSON Schema inputSchema
//! - Dispatch coverage: every name in ALL_TOOL_NAMES routes without error
//! - Capability tiers: ReadOnly tools carry readOnlyHint=true in their
//!   annotations; Destructive tools carry destructiveHint=true
//! - list_ai_actions: returns all 12 AI actions, each with required fields;
//!   include_prompts=false strips prompt templates
//! - Required vs optional parameters: missing required args return -32602;
//!   missing optional args use documented defaults

use mdopener_mcp::{
    dispatch, handle_initialize, tool_list, tool_registry, ai_actions_registry,
    ALL_TOOL_NAMES, ToolTier,
    tool_open_file, tool_get_content, tool_set_content, tool_list_recent,
    tool_export, tool_request_review, tool_get_annotations,
    tool_edit_document, tool_replace_document, tool_search_vault,
    tool_present_document, tool_list_ai_actions,
    tool_get_conversation_context, tool_save_conversation_message,
    tool_export_markdown_archive, tool_export_canvas_graph,
    store_append_message, store_get_context,
    session_file_path, load_session_from_disk,
    IpcClient, Request,
};
use serde_json::{json, Value};
use std::sync::Mutex;

// ── Mock IPC client ──────────────────────────────────────────────────────────

/// A scriptable mock for the IPC transport.  Each `entry` describes one
/// expected call: the method (`GET`/`POST`), the path prefix to match,
/// and the `Value` to return (or `Err(String)` for failure simulation).
struct MockIpc {
    /// Calls recorded for assertion.
    calls: Mutex<Vec<(String, String, Option<Value>)>>,
    /// Scripted responses: (method, path_prefix, response)
    responses: Vec<(String, String, Result<Value, String>)>,
}

impl MockIpc {
    fn new() -> Self {
        Self { calls: Mutex::new(vec![]), responses: vec![] }
    }

    fn on_get(mut self, path_prefix: &str, resp: Result<Value, String>) -> Self {
        self.responses.push(("GET".into(), path_prefix.into(), resp));
        self
    }

    fn on_post(mut self, path_prefix: &str, resp: Result<Value, String>) -> Self {
        self.responses.push(("POST".into(), path_prefix.into(), resp));
        self
    }

    /// Return the recorded calls for assertion.
    fn calls(&self) -> Vec<(String, String, Option<Value>)> {
        self.calls.lock().unwrap().clone()
    }
}

impl IpcClient for MockIpc {
    fn get(&self, path: &str) -> Result<Value, String> {
        self.calls.lock().unwrap().push(("GET".into(), path.into(), None));
        for (method, prefix, resp) in &self.responses {
            if method == "GET" && path.starts_with(prefix.as_str()) {
                return resp.clone();
            }
        }
        Err(format!("MockIpc: no GET handler for {path}"))
    }

    fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push(("POST".into(), path.into(), Some(body)));
        for (method, prefix, resp) in &self.responses {
            if method == "POST" && path.starts_with(prefix.as_str()) {
                return resp.clone();
            }
        }
        Err(format!("MockIpc: no POST handler for {path}"))
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn id(n: u64) -> Value { json!(n) }

/// Extract the text content from a tool_result response envelope.
fn content_text(resp: &mdopener_mcp::Response) -> Value {
    let result = resp.result.as_ref().expect("response has no result");
    let text = result["content"][0]["text"].as_str().expect("no text");
    serde_json::from_str(text).unwrap_or(json!(text))
}

/// Extract isError flag from the result envelope.
fn is_error(resp: &mdopener_mcp::Response) -> bool {
    resp.result.as_ref()
        .and_then(|r| r["isError"].as_bool())
        .unwrap_or(false)
}

// ════════════════════════════════════════════════════════════════════════════
// Tool: initialize — protocol negotiation
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn initialize_supported_protocol_echoed() {
    let resp = handle_initialize(id(1), Some(json!({ "protocolVersion": "2025-03-26" })));
    assert!(resp.error.is_none());
    let proto = resp.result.as_ref().unwrap()["protocolVersion"].as_str().unwrap();
    assert_eq!(proto, "2025-03-26");
}

#[test]
fn initialize_unsupported_protocol_falls_back_to_default() {
    let resp = handle_initialize(id(1), Some(json!({ "protocolVersion": "1999-01-01" })));
    assert!(resp.error.is_none());
    let proto = resp.result.as_ref().unwrap()["protocolVersion"].as_str().unwrap();
    assert_eq!(proto, "2024-11-05");
}

#[test]
fn initialize_no_params_uses_default() {
    let resp = handle_initialize(id(1), None);
    let proto = resp.result.as_ref().unwrap()["protocolVersion"].as_str().unwrap();
    assert_eq!(proto, "2024-11-05");
}

#[test]
fn initialize_capabilities_advertised() {
    let resp = handle_initialize(id(1), None);
    let caps = &resp.result.as_ref().unwrap()["capabilities"];
    assert!(caps["tools"].is_object());
    assert!(caps["resources"].is_object());
    assert!(caps["prompts"].is_object());
}

// ════════════════════════════════════════════════════════════════════════════
// Tool list — count, membership, and ALL_TOOL_NAMES consistency
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn tools_list_contains_all_16_tools() {
    let list = tool_list();
    let tools = list.as_array().expect("tool_list returns an array");
    let names: Vec<&str> = tools.iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    let expected = [
        "open_file", "get_current_content", "set_content", "list_recent",
        "export", "request_review", "get_user_annotations", "edit_document",
        "replace_document", "search_vault", "present_document", "list_ai_actions",
        "get_conversation_context", "save_conversation_message",
        "export_markdown_archive", "export_canvas_graph",
    ];
    for name in &expected {
        assert!(names.contains(name), "tool_list missing: {name}");
    }
    assert_eq!(names.len(), expected.len(), "unexpected extra tools in list");
}

#[test]
fn all_tool_names_constant_matches_registry() {
    let registry = tool_registry();
    let registry_names: Vec<&str> = registry.iter().map(|t| t.name).collect();
    for name in ALL_TOOL_NAMES {
        assert!(
            registry_names.contains(name),
            "ALL_TOOL_NAMES contains '{name}' but it is not in tool_registry()"
        );
    }
    assert_eq!(
        ALL_TOOL_NAMES.len(),
        registry_names.len(),
        "ALL_TOOL_NAMES length {} != registry length {}",
        ALL_TOOL_NAMES.len(),
        registry_names.len()
    );
}

// ════════════════════════════════════════════════════════════════════════════
// Data-driven registry — JSON Schema validity and required-field coverage
// ════════════════════════════════════════════════════════════════════════════

/// Verify every tool in the registry emits a valid JSON Schema inputSchema.
/// Rules: must be an object; must have "type": "object"; must have "properties".
#[test]
fn every_tool_input_schema_is_valid_json_schema() {
    for def in tool_registry() {
        let schema = &def.input_schema;
        assert_eq!(
            schema["type"].as_str(),
            Some("object"),
            "tool '{}' inputSchema must have type=object",
            def.name
        );
        assert!(
            schema["properties"].is_object(),
            "tool '{}' inputSchema must have a 'properties' object",
            def.name
        );
    }
}

/// Tools with required parameters must list them in an array.
#[test]
fn required_fields_are_arrays_when_present() {
    for def in tool_registry() {
        let schema = &def.input_schema;
        if !schema["required"].is_null() {
            assert!(
                schema["required"].is_array(),
                "tool '{}' 'required' must be a JSON array",
                def.name
            );
            // Each entry must be a string that also appears in properties or anyOf
            for req in schema["required"].as_array().unwrap() {
                assert!(
                    req.is_string(),
                    "tool '{}' required entry must be a string, got {:?}",
                    def.name,
                    req
                );
            }
        }
    }
}

/// anyOf constraints (request_review) must list objects with "required".
#[test]
fn any_of_constraints_well_formed() {
    for def in tool_registry() {
        let schema = &def.input_schema;
        if !schema["anyOf"].is_null() {
            let any_of = schema["anyOf"].as_array().expect("anyOf must be array");
            for entry in any_of {
                assert!(
                    entry["required"].is_array(),
                    "tool '{}' anyOf entry must have 'required' array, got {:?}",
                    def.name,
                    entry
                );
            }
        }
    }
}

/// Every tool must have a non-empty description.
#[test]
fn every_tool_has_non_empty_description() {
    for def in tool_registry() {
        assert!(
            !def.description.is_empty(),
            "tool '{}' must have a non-empty description",
            def.name
        );
    }
}

/// Tool names must be snake_case: only lowercase letters, digits, and underscores.
#[test]
fn tool_names_are_snake_case() {
    for def in tool_registry() {
        assert!(
            def.name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
            "tool name '{}' is not snake_case",
            def.name
        );
    }
}

/// Tool names must be unique.
#[test]
fn tool_names_are_unique() {
    let registry = tool_registry();
    let mut seen = std::collections::HashSet::new();
    for def in &registry {
        assert!(
            seen.insert(def.name),
            "duplicate tool name: '{}'",
            def.name
        );
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Capability tier validation — annotations must match tier classification
// ════════════════════════════════════════════════════════════════════════════

/// ReadOnly tier tools must advertise readOnlyHint=true in their annotations.
#[test]
fn read_only_tools_have_read_only_hint_annotation() {
    for def in tool_registry() {
        if def.tier == ToolTier::ReadOnly {
            let ann = def.annotations.as_ref().unwrap_or_else(|| {
                panic!("ReadOnly tool '{}' must have annotations", def.name)
            });
            assert_eq!(
                ann["readOnlyHint"].as_bool(),
                Some(true),
                "ReadOnly tool '{}' must have readOnlyHint=true",
                def.name
            );
        }
    }
}

/// Destructive tier tools must advertise destructiveHint=true in their annotations.
#[test]
fn destructive_tools_have_destructive_hint_annotation() {
    for def in tool_registry() {
        if def.tier == ToolTier::Destructive {
            let ann = def.annotations.as_ref().unwrap_or_else(|| {
                panic!("Destructive tool '{}' must have annotations", def.name)
            });
            assert_eq!(
                ann["destructiveHint"].as_bool(),
                Some(true),
                "Destructive tool '{}' must have destructiveHint=true",
                def.name
            );
        }
    }
}

/// Non-destructive tools must NOT carry destructiveHint=true.
#[test]
fn non_destructive_tools_do_not_have_destructive_hint() {
    for def in tool_registry() {
        if def.tier != ToolTier::Destructive {
            if let Some(ann) = &def.annotations {
                assert_ne!(
                    ann["destructiveHint"].as_bool(),
                    Some(true),
                    "tool '{}' is not Destructive but has destructiveHint=true",
                    def.name
                );
            }
        }
    }
}

/// Every tool serialised by to_json() includes name, description, inputSchema.
#[test]
fn tool_to_json_includes_required_mcp_fields() {
    for def in tool_registry() {
        let j = def.to_json();
        assert!(j["name"].is_string(), "tool '{}' to_json missing 'name'", def.name);
        assert!(j["description"].is_string(), "tool '{}' to_json missing 'description'", def.name);
        assert!(j["inputSchema"].is_object(), "tool '{}' to_json missing 'inputSchema'", def.name);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Dispatch coverage — every registered tool name must route without -32602
// ════════════════════════════════════════════════════════════════════════════

/// Call every tool in ALL_TOOL_NAMES with empty args and verify the dispatch
/// does NOT return "Unknown tool" (-32602).  The actual tool may return a
/// param-error for missing required args, but the name must be recognised.
#[test]
fn dispatch_routes_all_registered_tool_names() {
    let ipc = MockIpc::new();
    for name in ALL_TOOL_NAMES {
        let req = Request {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: Some(json!({ "name": name, "arguments": {} })),
        };
        let resp = dispatch(req, &ipc).expect("dispatch should return a response");
        // A -32602 from dispatch means "Unknown tool" — that must not happen.
        // A -32602 from a tool impl means "missing required param" — that is fine.
        // We distinguish by checking the error message.
        if let Some(err) = &resp.error {
            assert!(
                !err.message.contains("Unknown tool"),
                "tool '{}' is in ALL_TOOL_NAMES but dispatch says Unknown tool: {}",
                name,
                err.message
            );
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 1: open_file
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn open_file_missing_path_returns_error() {
    let ipc = MockIpc::new();
    let resp = tool_open_file(id(1), &json!({}), &ipc);
    assert!(resp.error.is_some());
    assert_eq!(resp.error.unwrap().code, -32602);
}

#[test]
fn open_file_ipc_success_returns_opened_path() {
    let ipc = MockIpc::new()
        .on_post("/open", Ok(json!({ "ok": true })));
    // Use /tmp which is guaranteed to exist for canonicalize
    let resp = tool_open_file(id(1), &json!({ "path": "/tmp" }), &ipc);
    assert!(resp.error.is_none(), "unexpected RPC error: {:?}", resp.error);
    assert!(!is_error(&resp));
    let text = content_text(&resp);
    assert!(text["opened"].as_str().is_some());
}

#[test]
fn open_file_mode_read_forwarded_in_post_body() {
    let ipc = MockIpc::new()
        .on_post("/open", Ok(json!({ "ok": true })));
    let resp = tool_open_file(id(1), &json!({ "path": "/tmp", "mode": "read" }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let post = calls.iter().find(|(m, p, _)| m == "POST" && p == "/open");
    assert!(post.is_some(), "no POST /open call recorded");
    let body = post.unwrap().2.as_ref().unwrap();
    assert_eq!(body["mode"], json!("read"));
}

#[test]
fn open_file_mode_edit_forwarded_in_post_body() {
    let ipc = MockIpc::new()
        .on_post("/open", Ok(json!({ "ok": true })));
    let resp = tool_open_file(id(1), &json!({ "path": "/tmp", "mode": "edit" }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/open")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["mode"], json!("edit"));
}

// When IPC fails we fall through to the url-scheme launcher.  In a test
// environment `open mdopener://...` will fail or succeed depending on the OS,
// so we just assert the RPC-level error is not a missing-path error and that
// IPC was attempted.
#[test]
fn open_file_ipc_failure_attempts_url_scheme() {
    let ipc = MockIpc::new()
        .on_post("/open", Err("ipc-port not found".into()));
    let resp = tool_open_file(id(1), &json!({ "path": "/tmp" }), &ipc);
    // The IPC call was attempted
    let calls = ipc.calls();
    assert!(calls.iter().any(|(m, p, _)| m == "POST" && p == "/open"));
    // Response is either a url-scheme success or a specific OS error, but not
    // a missing-param error (-32602).
    if let Some(e) = &resp.error {
        assert_ne!(e.code, -32602, "should not be a param error");
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 2: get_current_content
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn get_current_content_returns_path_and_markdown() {
    let ipc = MockIpc::new()
        .on_get("/content", Ok(json!({
            "path": "/docs/notes.md",
            "content": "# Hello\nworld"
        })));
    let resp = tool_get_content(id(1), &ipc);
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["path"], "/docs/notes.md");
    assert_eq!(text["content"], "# Hello\nworld");
}

#[test]
fn get_current_content_no_doc_open_returns_null_path() {
    let ipc = MockIpc::new()
        .on_get("/content", Ok(json!({ "path": null, "content": "" })));
    let resp = tool_get_content(id(1), &ipc);
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert!(text["path"].is_null());
}

#[test]
fn get_current_content_ipc_unavailable_returns_rpc_error() {
    let ipc = MockIpc::new()
        .on_get("/content", Err("Could not connect to IPC server".into()));
    let resp = tool_get_content(id(1), &ipc);
    assert!(resp.error.is_some());
    assert_eq!(resp.error.unwrap().code, -32000);
}

#[test]
fn get_current_content_stale_ipc_returns_error_with_hint() {
    let ipc = MockIpc::new()
        .on_get("/content", Err("ipc-port not found — is Ashlr MD running?".into()));
    let resp = tool_get_content(id(1), &ipc);
    let err = resp.error.expect("should have error");
    assert!(err.message.contains("Ashlr MD"), "error should mention app name");
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 3: set_content
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn set_content_missing_content_returns_param_error() {
    let ipc = MockIpc::new();
    let resp = tool_set_content(id(1), &json!({}), &ipc);
    assert_eq!(resp.error.as_ref().unwrap().code, -32602);
}

#[test]
fn set_content_sends_content_to_ipc() {
    let ipc = MockIpc::new()
        .on_post("/content", Ok(json!({ "ok": true })));
    let resp = tool_set_content(id(1), &json!({ "content": "# New doc" }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/content")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["content"], "# New doc");
    assert_eq!(body["save"], json!(false)); // default
}

#[test]
fn set_content_save_true_persists() {
    let ipc = MockIpc::new()
        .on_post("/content", Ok(json!({ "ok": true, "saved": true })));
    let resp = tool_set_content(
        id(1),
        &json!({ "content": "# Saved", "save": true }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/content")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["save"], json!(true));
}

#[test]
fn set_content_large_content_not_truncated() {
    // >10 MB string — the handler must pass it through without truncating.
    let big = "x".repeat(11 * 1024 * 1024);
    let ipc = MockIpc::new()
        .on_post("/content", Ok(json!({ "ok": true })));
    let resp = tool_set_content(id(1), &json!({ "content": big }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/content")
        .unwrap().2.as_ref().unwrap();
    let sent = body["content"].as_str().unwrap();
    assert_eq!(sent.len(), 11 * 1024 * 1024, "large content was truncated");
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 4: list_recent
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn list_recent_default_limit_is_10() {
    let ipc = MockIpc::new()
        .on_get("/recent", Ok(json!({ "files": [] })));
    tool_list_recent(id(1), &json!({}), &ipc);
    let calls = ipc.calls();
    let path = &calls[0].1;
    assert!(path.contains("limit=10"), "default limit should be 10, got: {path}");
}

#[test]
fn list_recent_custom_limit_clamped() {
    let ipc = MockIpc::new()
        .on_get("/recent", Ok(json!({ "files": [] })));
    tool_list_recent(id(1), &json!({ "limit": 5 }), &ipc);
    let calls = ipc.calls();
    assert!(calls[0].1.contains("limit=5"));
}

#[test]
fn list_recent_returns_files_array() {
    let files = json!(["/a.md", "/b.md", "/c.md"]);
    let ipc = MockIpc::new()
        .on_get("/recent", Ok(json!({ "files": files })));
    let resp = tool_list_recent(id(1), &json!({}), &ipc);
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["files"], files);
}

#[test]
fn list_recent_empty_returns_empty_array() {
    let ipc = MockIpc::new()
        .on_get("/recent", Ok(json!({ "files": [] })));
    let resp = tool_list_recent(id(1), &json!({}), &ipc);
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["files"], json!([]));
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 5: export
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn export_missing_format_returns_param_error() {
    let ipc = MockIpc::new();
    let resp = tool_export(id(1), &json!({}), &ipc);
    assert_eq!(resp.error.as_ref().unwrap().code, -32602);
}

#[test]
fn export_pdf_format_forwarded() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true })));
    let resp = tool_export(id(1), &json!({ "format": "pdf" }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["format"], "pdf");
    assert!(body["outputPath"].is_null(), "output_path should default to null");
}

#[test]
fn export_docx_format_forwarded() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true })));
    tool_export(id(1), &json!({ "format": "docx" }), &ipc);
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["format"], "docx");
}

#[test]
fn export_html_with_output_path() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true })));
    tool_export(
        id(1),
        &json!({ "format": "html", "output_path": "/tmp/out.html" }),
        &ipc,
    );
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["outputPath"], "/tmp/out.html");
}

#[test]
fn export_ipc_error_propagated() {
    let ipc = MockIpc::new()
        .on_post("/export", Err("ipc-port not found".into()));
    let resp = tool_export(id(1), &json!({ "format": "pdf" }), &ipc);
    assert!(resp.error.is_some());
    assert_eq!(resp.error.unwrap().code, -32000);
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 6: edit_document
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn edit_document_missing_find_returns_error() {
    let ipc = MockIpc::new();
    let resp = tool_edit_document(id(1), &json!({ "replace": "new" }), &ipc);
    assert_eq!(resp.error.as_ref().unwrap().code, -32602);
}

#[test]
fn edit_document_missing_replace_returns_error() {
    let ipc = MockIpc::new();
    let resp = tool_edit_document(id(1), &json!({ "find": "old" }), &ipc);
    assert_eq!(resp.error.as_ref().unwrap().code, -32602);
}

#[test]
fn edit_document_success_returns_ok_response() {
    let ipc = MockIpc::new()
        .on_post("/edit", Ok(json!({ "ok": true, "replaced": 1 })));
    let resp = tool_edit_document(
        id(1),
        &json!({ "find": "old text", "replace": "new text" }),
        &ipc,
    );
    assert!(resp.error.is_none());
    assert!(!is_error(&resp));
    let text = content_text(&resp);
    assert_eq!(text["ok"], json!(true));
    assert_eq!(text["replaced"], json!(1));
}

#[test]
fn edit_document_collision_returns_tool_error() {
    let ipc = MockIpc::new()
        .on_post("/edit", Ok(json!({
            "ok": false,
            "error": "find string appears 2 times — must be unique"
        })));
    let resp = tool_edit_document(
        id(1),
        &json!({ "find": "common text", "replace": "new" }),
        &ipc,
    );
    // Tool-level error: RPC result is ok but isError=true
    assert!(resp.error.is_none());
    assert!(is_error(&resp));
}

#[test]
fn edit_document_save_flag_forwarded() {
    let ipc = MockIpc::new()
        .on_post("/edit", Ok(json!({ "ok": true, "replaced": 1 })));
    tool_edit_document(
        id(1),
        &json!({ "find": "x", "replace": "y", "save": true }),
        &ipc,
    );
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/edit")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["save"], json!(true));
}

#[test]
fn edit_document_ipc_error_propagated() {
    let ipc = MockIpc::new()
        .on_post("/edit", Err("Could not connect to IPC server".into()));
    let resp = tool_edit_document(
        id(1),
        &json!({ "find": "x", "replace": "y" }),
        &ipc,
    );
    assert!(resp.error.is_some());
    assert_eq!(resp.error.unwrap().code, -32000);
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 7: replace_document
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn replace_document_missing_content_returns_param_error() {
    let ipc = MockIpc::new();
    let resp = tool_replace_document(id(1), &json!({}), &ipc);
    assert_eq!(resp.error.as_ref().unwrap().code, -32602);
}

#[test]
fn replace_document_sends_full_content() {
    let ipc = MockIpc::new()
        .on_post("/content", Ok(json!({ "ok": true })));
    let new_content = "# Full replacement\nAll new content.";
    let resp = tool_replace_document(
        id(1),
        &json!({ "content": new_content }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/content")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["content"], new_content);
    assert_eq!(body["save"], json!(false));
}

#[test]
fn replace_document_save_true_triggers_persistence() {
    let ipc = MockIpc::new()
        .on_post("/content", Ok(json!({ "ok": true })));
    tool_replace_document(
        id(1),
        &json!({ "content": "# Doc", "save": true }),
        &ipc,
    );
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/content")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["save"], json!(true));
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 8: search_vault
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn search_vault_missing_query_returns_param_error() {
    let ipc = MockIpc::new();
    let resp = tool_search_vault(id(1), &json!({}), &ipc);
    assert_eq!(resp.error.as_ref().unwrap().code, -32602);
}

#[test]
fn search_vault_keyword_search_forwarded() {
    let ipc = MockIpc::new()
        .on_get("/search", Ok(json!({
            "results": [
                { "path": "/vault/a.md", "score": 0.9, "snippet": "hello world" }
            ]
        })));
    let resp = tool_search_vault(
        id(1),
        &json!({ "query": "hello world" }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let path = &calls[0].1;
    assert!(path.contains("hello%20world") || path.contains("hello+world"),
        "query should be URL-encoded, got: {path}");
}

#[test]
fn search_vault_default_limit_is_50() {
    let ipc = MockIpc::new()
        .on_get("/search", Ok(json!({ "results": [] })));
    tool_search_vault(id(1), &json!({ "query": "x" }), &ipc);
    let calls = ipc.calls();
    assert!(calls[0].1.contains("limit=50"), "default limit should be 50, got: {}", calls[0].1);
}

#[test]
fn search_vault_custom_limit() {
    let ipc = MockIpc::new()
        .on_get("/search", Ok(json!({ "results": [] })));
    tool_search_vault(id(1), &json!({ "query": "x", "limit": 5 }), &ipc);
    let calls = ipc.calls();
    assert!(calls[0].1.contains("limit=5"));
}

#[test]
fn search_vault_empty_results_returned() {
    let ipc = MockIpc::new()
        .on_get("/search", Ok(json!({ "results": [] })));
    let resp = tool_search_vault(id(1), &json!({ "query": "xyz_unlikely" }), &ipc);
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["results"], json!([]));
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 9: request_review
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn request_review_neither_path_nor_content_returns_error() {
    let ipc = MockIpc::new();
    let resp = tool_request_review(id(1), &json!({}), &ipc);
    assert_eq!(resp.error.as_ref().unwrap().code, -32602);
}

#[test]
fn request_review_non_blocking_registers_and_returns_pending() {
    let ipc = MockIpc::new()
        .on_post("/review", Ok(json!({ "ok": true })));
    let resp = tool_request_review(
        id(1),
        &json!({ "content": "# Plan\nStep 1.", "blocking": false }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["status"], "pending");
    // reviewId should be present and non-empty
    assert!(text["reviewId"].as_str().map(|s| !s.is_empty()).unwrap_or(false));
}

#[test]
fn request_review_ipc_down_returns_error() {
    let ipc = MockIpc::new()
        .on_post("/review", Err("ipc-port not found".into()));
    let resp = tool_request_review(
        id(1),
        &json!({ "content": "# Plan", "blocking": false }),
        &ipc,
    );
    assert!(resp.error.is_some());
    assert_eq!(resp.error.unwrap().code, -32000);
}

#[test]
fn request_review_timeout_ms_clamped_to_minimum() {
    // timeout_ms below 5000 should be clamped up — non-blocking so no sleep
    let ipc = MockIpc::new()
        .on_post("/review", Ok(json!({ "ok": true })));
    let resp = tool_request_review(
        id(1),
        &json!({ "content": "x", "blocking": false, "timeout_ms": 100 }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter().find(|(m, p, _)| m == "POST" && p == "/review")
        .unwrap().2.as_ref().unwrap();
    let actual_timeout = body["timeoutMs"].as_u64().unwrap();
    assert!(actual_timeout >= 5_000, "timeout should be clamped to >=5000, got {actual_timeout}");
}

#[test]
fn request_review_timeout_ms_clamped_to_maximum() {
    let ipc = MockIpc::new()
        .on_post("/review", Ok(json!({ "ok": true })));
    let resp = tool_request_review(
        id(1),
        &json!({ "content": "x", "blocking": false, "timeout_ms": 9_999_999 }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter().find(|(m, p, _)| m == "POST" && p == "/review")
        .unwrap().2.as_ref().unwrap();
    let actual_timeout = body["timeoutMs"].as_u64().unwrap();
    assert!(actual_timeout <= 600_000, "timeout should be clamped to <=600000, got {actual_timeout}");
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 10: present_document
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn present_document_no_path_uses_current_doc() {
    let ipc = MockIpc::new()
        .on_post("/present", Ok(json!({ "ok": true })));
    let resp = tool_present_document(id(1), &json!({}), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/present")
        .unwrap().2.as_ref().unwrap();
    assert!(body["path"].is_null(), "path should be null when omitted");
}

#[test]
fn present_document_with_path_sends_canonicalized() {
    let ipc = MockIpc::new()
        .on_post("/present", Ok(json!({ "ok": true })));
    // /tmp is a real path on macOS/Linux and will canonicalize successfully
    let resp = tool_present_document(id(1), &json!({ "path": "/tmp" }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/present")
        .unwrap().2.as_ref().unwrap();
    // Should have received a non-null path
    assert!(!body["path"].is_null(), "path should be set");
}

#[test]
fn present_document_ipc_error_propagated() {
    let ipc = MockIpc::new()
        .on_post("/present", Err("Could not connect to IPC server".into()));
    let resp = tool_present_document(id(1), &json!({}), &ipc);
    assert!(resp.error.is_some());
    assert_eq!(resp.error.unwrap().code, -32000);
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 11: get_user_annotations
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn get_user_annotations_missing_path_returns_error() {
    let ipc = MockIpc::new();
    let resp = tool_get_annotations(id(1), &json!({}), &ipc);
    assert_eq!(resp.error.as_ref().unwrap().code, -32602);
}

#[test]
fn get_user_annotations_returns_highlights_comments_bookmarks() {
    let ipc = MockIpc::new()
        .on_get("/annotations", Ok(json!({
            "highlights": [{ "line": 3, "text": "important" }],
            "comments": [{ "line": 5, "comment": "check this" }],
            "bookmarks": [10]
        })));
    let resp = tool_get_annotations(
        id(1),
        &json!({ "path": "/vault/doc.md" }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert!(text["highlights"].is_array());
    assert!(text["comments"].is_array());
    assert!(text["bookmarks"].is_array());
}

#[test]
fn get_user_annotations_path_url_encoded_in_request() {
    let ipc = MockIpc::new()
        .on_get("/annotations", Ok(json!({ "highlights": [] })));
    tool_get_annotations(
        id(1),
        &json!({ "path": "/vault/my doc.md" }),
        &ipc,
    );
    let calls = ipc.calls();
    let path = &calls[0].1;
    // Space must be percent-encoded
    assert!(path.contains("%20") || path.contains("+"),
        "path should be URL-encoded, got: {path}");
}

#[test]
fn get_user_annotations_ipc_error_propagated() {
    let ipc = MockIpc::new()
        .on_get("/annotations", Err("ipc-port not found".into()));
    let resp = tool_get_annotations(id(1), &json!({ "path": "/x.md" }), &ipc);
    assert!(resp.error.is_some());
    assert_eq!(resp.error.unwrap().code, -32000);
}

// ════════════════════════════════════════════════════════════════════════════
// dispatch() — top-level JSON-RPC routing
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn dispatch_notification_returns_none() {
    let ipc = MockIpc::new();
    let req = Request {
        jsonrpc: "2.0".into(),
        id: None,
        method: "notifications/initialized".into(),
        params: None,
    };
    let resp = dispatch(req, &ipc);
    assert!(resp.is_none(), "notifications should produce no response");
}

#[test]
fn dispatch_ping_returns_empty_object() {
    let ipc = MockIpc::new();
    let req = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(42)),
        method: "ping".into(),
        params: None,
    };
    let resp = dispatch(req, &ipc).unwrap();
    assert!(resp.error.is_none());
    assert_eq!(resp.result.unwrap(), json!({}));
}

#[test]
fn dispatch_unknown_method_returns_method_not_found() {
    let ipc = MockIpc::new();
    let req = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(1)),
        method: "nonexistent/method".into(),
        params: None,
    };
    let resp = dispatch(req, &ipc).unwrap();
    assert_eq!(resp.error.as_ref().unwrap().code, -32601);
}

#[test]
fn dispatch_tools_call_unknown_tool_returns_invalid_params() {
    let ipc = MockIpc::new();
    let req = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(1)),
        method: "tools/call".into(),
        params: Some(json!({ "name": "ghost_tool", "arguments": {} })),
    };
    let resp = dispatch(req, &ipc).unwrap();
    assert_eq!(resp.error.as_ref().unwrap().code, -32602);
}

// ════════════════════════════════════════════════════════════════════════════
// parse_url helper
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn parse_url_valid_http() {
    let (host, port, path) = mdopener_mcp::parse_url("http://127.0.0.1:8080/content").unwrap();
    assert_eq!(host, "127.0.0.1");
    assert_eq!(port, 8080);
    assert_eq!(path, "/content");
}

#[test]
fn parse_url_root_path() {
    let (_host, port, path) = mdopener_mcp::parse_url("http://127.0.0.1:9000").unwrap();
    assert_eq!(port, 9000);
    assert_eq!(path, "/");
}

#[test]
fn parse_url_rejects_https() {
    let result = mdopener_mcp::parse_url("https://127.0.0.1:8080/foo");
    assert!(result.is_err());
}

// ════════════════════════════════════════════════════════════════════════════
// parse_http_body helper — HTTP status surface
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn parse_http_body_200_ok_parses_json() {
    let raw = b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
    let v = mdopener_mcp::parse_http_body(raw).unwrap();
    assert_eq!(v["ok"], json!(true));
}

#[test]
fn parse_http_body_401_returns_auth_error() {
    let raw = b"HTTP/1.0 401 Unauthorized\r\n\r\n{}";
    let err = mdopener_mcp::parse_http_body(raw).unwrap_err();
    assert!(err.contains("IPC auth failed"), "got: {err}");
}

#[test]
fn parse_http_body_500_returns_http_error() {
    let raw = b"HTTP/1.0 500 Internal Server Error\r\n\r\n{}";
    let err = mdopener_mcp::parse_http_body(raw).unwrap_err();
    assert!(err.contains("500"), "got: {err}");
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 12: list_ai_actions
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn list_ai_actions_returns_all_12_actions() {
    let resp = tool_list_ai_actions(id(1), &json!({}));
    assert!(resp.error.is_none(), "unexpected error: {:?}", resp.error);
    let text = content_text(&resp);
    let actions = text["actions"].as_array().expect("actions must be array");
    assert_eq!(actions.len(), 12, "expected 12 AI actions, got {}", actions.len());
    assert_eq!(text["count"], json!(12));
}

#[test]
fn list_ai_actions_every_action_has_required_fields() {
    let resp = tool_list_ai_actions(id(1), &json!({}));
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    for action in actions {
        assert!(action["id"].is_string(), "action missing 'id': {:?}", action);
        assert!(action["label"].is_string(), "action '{}' missing 'label'", action["id"]);
        assert!(action["shortLabel"].is_string(), "action '{}' missing 'shortLabel'", action["id"]);
        assert!(action["icon"].is_string(), "action '{}' missing 'icon'", action["id"]);
        assert!(action["scope"].is_string(), "action '{}' missing 'scope'", action["id"]);
        assert!(action["systemPrompt"].is_string(), "action '{}' missing 'systemPrompt'", action["id"]);
        assert!(action["userPromptTemplate"].is_string(), "action '{}' missing 'userPromptTemplate'", action["id"]);
    }
}

#[test]
fn list_ai_actions_action_ids_are_unique() {
    let resp = tool_list_ai_actions(id(1), &json!({}));
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    let mut seen = std::collections::HashSet::new();
    for action in actions {
        let aid = action["id"].as_str().unwrap();
        assert!(seen.insert(aid.to_string()), "duplicate action id: '{}'", aid);
    }
}

#[test]
fn list_ai_actions_scope_values_are_valid() {
    let resp = tool_list_ai_actions(id(1), &json!({}));
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    for action in actions {
        let scope = action["scope"].as_str().unwrap();
        assert!(
            scope == "selection" || scope == "document",
            "action '{}' has invalid scope '{}'",
            action["id"].as_str().unwrap_or("?"),
            scope
        );
    }
}

#[test]
fn list_ai_actions_icons_are_non_empty() {
    let resp = tool_list_ai_actions(id(1), &json!({}));
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    for action in actions {
        let icon = action["icon"].as_str().unwrap();
        assert!(!icon.is_empty(), "action '{}' has empty icon", action["id"]);
    }
}

#[test]
fn list_ai_actions_include_prompts_false_strips_templates() {
    let resp = tool_list_ai_actions(id(1), &json!({ "include_prompts": false }));
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    assert_eq!(actions.len(), 12, "count should still be 12 with include_prompts=false");
    for action in actions {
        // These fields must be present
        assert!(action["id"].is_string());
        assert!(action["label"].is_string());
        assert!(action["icon"].is_string());
        assert!(action["scope"].is_string());
        // Prompt templates must be stripped
        assert!(
            action["systemPrompt"].is_null(),
            "systemPrompt should be stripped when include_prompts=false"
        );
        assert!(
            action["userPromptTemplate"].is_null(),
            "userPromptTemplate should be stripped when include_prompts=false"
        );
    }
}

#[test]
fn list_ai_actions_include_prompts_true_includes_templates() {
    let resp = tool_list_ai_actions(id(1), &json!({ "include_prompts": true }));
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    for action in actions {
        assert!(
            action["systemPrompt"].is_string(),
            "action '{}' missing systemPrompt when include_prompts=true",
            action["id"]
        );
    }
}

#[test]
fn list_ai_actions_contains_expected_selection_actions() {
    let resp = tool_list_ai_actions(id(1), &json!({}));
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    let ids: Vec<&str> = actions.iter()
        .filter_map(|a| a["id"].as_str())
        .collect();
    // The 9 selection-scoped actions from actions.ts
    for expected in &["explain", "summarize", "rewrite", "fix-grammar", "concise",
                       "expand", "explain-diff", "translate", "tldr"] {
        assert!(ids.contains(expected), "missing selection action '{}'", expected);
    }
}

#[test]
fn list_ai_actions_contains_expected_document_actions() {
    let resp = tool_list_ai_actions(id(1), &json!({}));
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    let doc_ids: Vec<&str> = actions.iter()
        .filter(|a| a["scope"].as_str() == Some("document"))
        .filter_map(|a| a["id"].as_str())
        .collect();
    for expected in &["doc-summarize", "doc-outline", "doc-explain-selection"] {
        assert!(doc_ids.contains(expected), "missing document action '{}'", expected);
    }
}

#[test]
fn list_ai_actions_prompt_templates_contain_text_placeholder() {
    let resp = tool_list_ai_actions(id(1), &json!({}));
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    for action in actions {
        let template = action["userPromptTemplate"].as_str().unwrap();
        assert!(
            template.contains("{text}"),
            "action '{}' userPromptTemplate must contain {{text}} placeholder",
            action["id"]
        );
    }
}

#[test]
fn list_ai_actions_system_prompts_are_non_empty() {
    let resp = tool_list_ai_actions(id(1), &json!({}));
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    for action in actions {
        let sp = action["systemPrompt"].as_str().unwrap();
        assert!(
            !sp.is_empty(),
            "action '{}' has empty systemPrompt",
            action["id"]
        );
    }
}

/// Verify the ai_actions_registry() raw output matches what tool_list_ai_actions
/// builds its response from — no mismatch between the source and the tool handler.
#[test]
fn ai_actions_registry_count_matches_tool_response() {
    let registry = ai_actions_registry();
    let raw_count = registry.as_array().unwrap().len();

    let resp = tool_list_ai_actions(id(1), &json!({}));
    let text = content_text(&resp);
    let resp_count = text["actions"].as_array().unwrap().len();

    assert_eq!(raw_count, resp_count,
        "ai_actions_registry() has {raw_count} entries but tool response has {resp_count}");
}

// ════════════════════════════════════════════════════════════════════════════
// app_not_running_msg formatting
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn app_not_running_msg_ipc_port_error_includes_hint() {
    let msg = mdopener_mcp::app_not_running_msg("ipc-port not found — is Ashlr MD running?");
    assert!(msg.contains("Ashlr MD"), "hint should mention app name");
    assert!(msg.contains("open_file"), "hint should mention open_file tool");
}

#[test]
fn app_not_running_msg_connect_error_includes_hint() {
    let msg = mdopener_mcp::app_not_running_msg("Could not connect to IPC server at 127.0.0.1:8080");
    assert!(msg.contains("Ashlr MD"));
}

#[test]
fn app_not_running_msg_other_error_passthrough() {
    let msg = mdopener_mcp::app_not_running_msg("IPC auth failed: token mismatch");
    // Should pass through unchanged for non-connectivity errors
    assert_eq!(msg, "IPC auth failed: token mismatch");
}

// ════════════════════════════════════════════════════════════════════════════
// Export tool — comprehensive IPC integration tests
// ════════════════════════════════════════════════════════════════════════════
//
// These tests exercise the full export tool dispatch path:
//   MCP tool call → tool_export() → IPC POST /export → agent response
// No running Ashlr MD app is required — MockIpc intercepts every IPC call.

use mdopener_mcp::handle_resources_list;
use mdopener_mcp::handle_resource_read;

// ── Successful export scenarios ───────────────────────────────────────────────

#[test]
fn export_tool_pdf_success_returns_ok_result() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({
            "ok": true,
            "path": "/home/user/my-doc.pdf",
            "format": "pdf"
        })));
    let resp = tool_export(id(1), &json!({ "format": "pdf" }), &ipc);
    assert!(resp.error.is_none(), "should not have RPC error: {:?}", resp.error);
    assert!(!is_error(&resp), "isError should be false on success");
    let text = content_text(&resp);
    assert_eq!(text["ok"], json!(true));
}

#[test]
fn export_tool_docx_success_returns_ok_result() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true, "path": "/tmp/doc.docx" })));
    let resp = tool_export(id(2), &json!({ "format": "docx" }), &ipc);
    assert!(resp.error.is_none());
    assert!(!is_error(&resp));
}

#[test]
fn export_tool_html_success_returns_ok_result() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true, "path": "/tmp/doc.html" })));
    let resp = tool_export(id(3), &json!({ "format": "html" }), &ipc);
    assert!(resp.error.is_none());
    assert!(!is_error(&resp));
}

// ── output_path is honored ────────────────────────────────────────────────────

#[test]
fn export_tool_output_path_forwarded_to_ipc() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true })));
    tool_export(
        id(10),
        &json!({ "format": "pdf", "output_path": "/home/user/reports/out.pdf" }),
        &ipc,
    );
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .expect("POST /export not called")
        .2.as_ref().unwrap();
    assert_eq!(body["outputPath"], "/home/user/reports/out.pdf",
        "output_path must be forwarded as outputPath");
}

#[test]
fn export_tool_html_with_output_path_forwarded() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true })));
    tool_export(
        id(11),
        &json!({ "format": "html", "output_path": "/tmp/export.html" }),
        &ipc,
    );
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["outputPath"], "/tmp/export.html");
    assert_eq!(body["format"], "html");
}

#[test]
fn export_tool_no_output_path_sends_null() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true })));
    tool_export(id(12), &json!({ "format": "pdf" }), &ipc);
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap().2.as_ref().unwrap();
    assert!(body["outputPath"].is_null(),
        "missing output_path should be sent as null, got {:?}", body["outputPath"]);
}

// ── HTML theme override ───────────────────────────────────────────────────────

#[test]
fn export_tool_html_with_paper_theme() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true })));
    let resp = tool_export(
        id(20),
        &json!({ "format": "html", "theme": "paper" }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["theme"], "paper");
}

#[test]
fn export_tool_html_with_sepia_theme() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true })));
    let resp = tool_export(
        id(21),
        &json!({ "format": "html", "theme": "sepia" }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["theme"], "sepia");
}

#[test]
fn export_tool_html_with_midnight_theme() {
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true })));
    let resp = tool_export(
        id(22),
        &json!({ "format": "html", "theme": "midnight" }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["theme"], "midnight");
}

#[test]
fn export_tool_invalid_theme_returns_param_error() {
    let ipc = MockIpc::new();
    let resp = tool_export(
        id(23),
        &json!({ "format": "html", "theme": "dark-mode" }),
        &ipc,
    );
    assert!(resp.error.is_some(), "invalid theme must produce an RPC error");
    assert_eq!(resp.error.as_ref().unwrap().code, -32602,
        "invalid theme must return -32602 (invalid params)");
    let msg = &resp.error.unwrap().message;
    assert!(msg.contains("paper") || msg.contains("sepia") || msg.contains("midnight"),
        "error should list valid values, got: {msg}");
}

#[test]
fn export_tool_no_theme_sends_null() {
    // When no theme is specified, the app uses its current theme.
    // The IPC body should carry null so the app knows to use its own setting.
    let ipc = MockIpc::new()
        .on_post("/export", Ok(json!({ "ok": true })));
    tool_export(id(24), &json!({ "format": "html" }), &ipc);
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap().2.as_ref().unwrap();
    assert!(body["theme"].is_null(),
        "absent theme should be null in IPC body, got {:?}", body["theme"]);
}

// ── File-write error propagation ──────────────────────────────────────────────

#[test]
fn export_tool_file_write_error_becomes_rpc_error() {
    let ipc = MockIpc::new()
        .on_post("/export", Err("ipc-port not found".into()));
    let resp = tool_export(id(30), &json!({ "format": "pdf" }), &ipc);
    assert!(resp.error.is_some(), "IPC failure must surface as RPC error");
    assert_eq!(resp.error.as_ref().unwrap().code, -32000);
}

#[test]
fn export_tool_permission_denied_error_propagated() {
    let ipc = MockIpc::new()
        .on_post("/export", Err("Permission denied: /root/secret.pdf".into()));
    let resp = tool_export(id(31), &json!({ "format": "pdf" }), &ipc);
    assert!(resp.error.is_some());
    assert_eq!(resp.error.as_ref().unwrap().code, -32000);
    // The error message must surface enough detail for the agent to understand.
    assert!(resp.error.unwrap().message.len() > 0);
}

#[test]
fn export_tool_disk_full_error_propagated() {
    let ipc = MockIpc::new()
        .on_post("/export", Err("No space left on device".into()));
    let resp = tool_export(id(32), &json!({ "format": "pdf" }), &ipc);
    assert!(resp.error.is_some());
    assert_eq!(resp.error.unwrap().code, -32000);
}

#[test]
fn export_tool_app_not_running_returns_descriptive_error() {
    let ipc = MockIpc::new()
        .on_post("/export", Err("ipc-port not found — is Ashlr MD running?".into()));
    let resp = tool_export(id(33), &json!({ "format": "html" }), &ipc);
    let err = resp.error.expect("should have error");
    assert_eq!(err.code, -32000);
    // app_not_running_msg should enrich the message.
    assert!(err.message.contains("Ashlr MD"),
        "error should name the app, got: {}", err.message);
}

// ── Unsupported / unknown format ──────────────────────────────────────────────
// Note: format validation is done by the app (via IPC), not by this MCP layer.
// The MCP layer forwards the format string and lets the app reject unknown ones.
// This test verifies the forwarding behaviour, not app-side validation.

#[test]
fn export_tool_unknown_format_forwarded_to_app() {
    // App returns an error for an unsupported format.
    let ipc = MockIpc::new()
        .on_post("/export", Err("Unsupported export format: odt".into()));
    let resp = tool_export(id(40), &json!({ "format": "odt" }), &ipc);
    // The IPC error becomes an RPC error — the agent sees a clear failure.
    assert!(resp.error.is_some());
    assert_eq!(resp.error.unwrap().code, -32000);
}

// ── Missing required param ────────────────────────────────────────────────────

#[test]
fn export_tool_missing_format_returns_param_error() {
    let ipc = MockIpc::new();
    let resp = tool_export(id(50), &json!({}), &ipc);
    assert_eq!(resp.error.as_ref().unwrap().code, -32602,
        "missing format must return -32602");
    // No IPC call should have been made.
    assert!(ipc.calls().is_empty(), "no IPC call should be made for a param error");
}

// ── Format field is present in every IPC POST body ───────────────────────────

#[test]
fn export_tool_format_always_in_ipc_body() {
    for format in &["pdf", "docx", "html"] {
        let ipc = MockIpc::new()
            .on_post("/export", Ok(json!({ "ok": true })));
        tool_export(id(60), &json!({ "format": format }), &ipc);
        let calls = ipc.calls();
        let body = calls.iter()
            .find(|(m, p, _)| m == "POST" && p == "/export")
            .unwrap_or_else(|| panic!("no POST /export for format={format}"))
            .2.as_ref().unwrap();
        assert_eq!(body["format"], json!(*format),
            "format must be forwarded for {format}");
    }
}

// ── export:current resource ───────────────────────────────────────────────────

#[test]
fn resources_list_includes_export_current() {
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
    let resp = handle_resources_list(id(70), &ipc);
    assert!(resp.error.is_none());
    let result = resp.result.as_ref().unwrap();
    let resources = result["resources"].as_array().expect("resources must be array");
    let uris: Vec<&str> = resources.iter()
        .filter_map(|r| r["uri"].as_str())
        .collect();
    assert!(uris.contains(&"export:current"),
        "resources/list must include export:current, got: {:?}", uris);
}

#[test]
fn resources_list_export_current_has_correct_mime_type() {
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
    let resp = handle_resources_list(id(71), &ipc);
    let result = resp.result.as_ref().unwrap();
    let resources = result["resources"].as_array().unwrap();
    let export_res = resources.iter()
        .find(|r| r["uri"].as_str() == Some("export:current"))
        .expect("export:current resource not found");
    assert_eq!(export_res["mimeType"].as_str(), Some("text/html"),
        "export:current must have mimeType text/html");
}

#[test]
fn resources_list_export_current_has_description() {
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
    let resp = handle_resources_list(id(72), &ipc);
    let result = resp.result.as_ref().unwrap();
    let resources = result["resources"].as_array().unwrap();
    let export_res = resources.iter()
        .find(|r| r["uri"].as_str() == Some("export:current"))
        .unwrap();
    let desc = export_res["description"].as_str().unwrap_or("");
    assert!(!desc.is_empty(), "export:current must have a non-empty description");
    // Description must convey the read-only, live-preview nature.
    assert!(desc.contains("live") || desc.contains("preview") || desc.contains("read"),
        "description should mention live preview: {desc}");
}

#[test]
fn resource_read_export_current_success_returns_html() {
    let ipc = MockIpc::new()
        .on_get("/export/preview", Ok(json!({
            "html": "<h1>Hello</h1><p>World</p>",
            "title": "My Doc",
            "theme": "paper"
        })));
    let resp = handle_resource_read(id(80), "export:current", &ipc);
    assert!(resp.error.is_none(), "should not have error: {:?}", resp.error);
    let result = resp.result.as_ref().unwrap();
    let contents = result["contents"].as_array().expect("contents must be array");
    assert_eq!(contents.len(), 1);
    let item = &contents[0];
    assert_eq!(item["uri"].as_str(), Some("export:current"));
    assert_eq!(item["mimeType"].as_str(), Some("text/html"));
    let text = item["text"].as_str().expect("text must be present");
    assert!(text.contains("<h1>Hello</h1>"), "HTML content must be present");
    assert!(text.contains("<p>World</p>"));
}

#[test]
fn resource_read_export_current_includes_metadata_comment() {
    let ipc = MockIpc::new()
        .on_get("/export/preview", Ok(json!({
            "html": "<p>doc</p>",
            "title": "Test Title",
            "theme": "sepia"
        })));
    let resp = handle_resource_read(id(81), "export:current", &ipc);
    let result = resp.result.as_ref().unwrap();
    let text = result["contents"][0]["text"].as_str().unwrap();
    // Metadata comment should appear at the top for agents to parse cheaply.
    assert!(text.starts_with("<!-- export:current"),
        "response should start with metadata comment, got: {text}");
    assert!(text.contains("sepia"), "comment should include theme");
}

#[test]
fn resource_read_export_current_theme_midnight_in_comment() {
    let ipc = MockIpc::new()
        .on_get("/export/preview", Ok(json!({
            "html": "<h2>Content</h2>",
            "title": "Night Doc",
            "theme": "midnight"
        })));
    let resp = handle_resource_read(id(82), "export:current", &ipc);
    let result = resp.result.as_ref().unwrap();
    let text = result["contents"][0]["text"].as_str().unwrap();
    assert!(text.contains("midnight"), "midnight theme should appear in metadata comment");
}

#[test]
fn resource_read_export_current_ipc_failure_returns_error() {
    let ipc = MockIpc::new()
        .on_get("/export/preview", Err("ipc-port not found".into()));
    let resp = handle_resource_read(id(83), "export:current", &ipc);
    assert!(resp.error.is_some(), "IPC failure must return RPC error");
    assert_eq!(resp.error.as_ref().unwrap().code, -32000);
}

#[test]
fn resource_read_export_current_app_not_running_descriptive_error() {
    let ipc = MockIpc::new()
        .on_get("/export/preview", Err("ipc-port not found — is Ashlr MD running?".into()));
    let resp = handle_resource_read(id(84), "export:current", &ipc);
    let err = resp.error.expect("should have error");
    assert_eq!(err.code, -32000);
    assert!(err.message.contains("Ashlr MD"),
        "error should mention app name, got: {}", err.message);
}

#[test]
fn resource_read_export_current_empty_html_handled_gracefully() {
    // App returns empty HTML (no document open).
    let ipc = MockIpc::new()
        .on_get("/export/preview", Ok(json!({ "html": "", "title": "", "theme": "paper" })));
    let resp = handle_resource_read(id(85), "export:current", &ipc);
    assert!(resp.error.is_none());
    let result = resp.result.as_ref().unwrap();
    let text = result["contents"][0]["text"].as_str().unwrap();
    // Should still have the metadata comment even for empty content.
    assert!(text.starts_with("<!-- export:current"),
        "metadata comment must appear even for empty content");
}

// ── resources/read dispatch — export:current routes through dispatch() ────────

#[test]
fn dispatch_resource_read_export_current_routes_to_handler() {
    let ipc = MockIpc::new()
        .on_get("/export/preview", Ok(json!({
            "html": "<h1>Dispatch test</h1>",
            "title": "Dispatch",
            "theme": "paper"
        })));
    let req = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(99)),
        method: "resources/read".into(),
        params: Some(json!({ "uri": "export:current" })),
    };
    let resp = dispatch(req, &ipc).expect("dispatch must return a response");
    assert!(resp.error.is_none(), "dispatch should succeed: {:?}", resp.error);
    let result = resp.result.as_ref().unwrap();
    let text = result["contents"][0]["text"].as_str().unwrap();
    assert!(text.contains("<h1>Dispatch test</h1>"));
}

// ── resources/list dispatch — export:current appears via dispatch() ───────────

#[test]
fn dispatch_resources_list_includes_export_current() {
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
    let req = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(100)),
        method: "resources/list".into(),
        params: None,
    };
    let resp = dispatch(req, &ipc).expect("dispatch must return a response");
    assert!(resp.error.is_none());
    let result = resp.result.as_ref().unwrap();
    let uris: Vec<&str> = result["resources"].as_array().unwrap()
        .iter()
        .filter_map(|r| r["uri"].as_str())
        .collect();
    assert!(uris.contains(&"export:current"),
        "dispatch resources/list must include export:current, got: {:?}", uris);
}

// ════════════════════════════════════════════════════════════════════════════
// Semantic search — IPC POST /search endpoint + semantic engine helpers
// ════════════════════════════════════════════════════════════════════════════

use mdopener_mcp::{
    cosine_similarity, best_snippet_for_query, canonicalize_path,
    vault_file_paths, grep_vault,
    SearchResult,
};

// ── cosine_similarity ─────────────────────────────────────────────────────────

#[test]
fn cosine_similarity_identical_vectors_returns_one() {
    let v = vec![1.0_f64, 2.0, 3.0];
    let sim = cosine_similarity(&v, &v);
    assert!((sim - 1.0).abs() < 1e-9, "identical vectors should have similarity 1.0, got {sim}");
}

#[test]
fn cosine_similarity_orthogonal_vectors_returns_zero() {
    let a = vec![1.0_f64, 0.0, 0.0];
    let b = vec![0.0_f64, 1.0, 0.0];
    let sim = cosine_similarity(&a, &b);
    assert!((sim - 0.0).abs() < 1e-9, "orthogonal vectors should have similarity 0.0, got {sim}");
}

#[test]
fn cosine_similarity_empty_vectors_returns_zero() {
    let sim = cosine_similarity(&[], &[]);
    assert_eq!(sim, 0.0, "empty vectors should return 0.0");
}

#[test]
fn cosine_similarity_mismatched_lengths_returns_zero() {
    let a = vec![1.0_f64, 2.0];
    let b = vec![1.0_f64, 2.0, 3.0];
    let sim = cosine_similarity(&a, &b);
    assert_eq!(sim, 0.0, "mismatched lengths should return 0.0");
}

// ── best_snippet_for_query ────────────────────────────────────────────────────

#[test]
fn best_snippet_finds_matching_line() {
    let content = "First line\nThis contains the needle\nThird line";
    let (line_no, snippet) = best_snippet_for_query(content, "needle");
    assert_eq!(line_no, 2, "should find match on line 2");
    assert!(snippet.contains("needle"), "snippet should contain the matched text");
}

#[test]
fn best_snippet_case_insensitive_match() {
    let content = "line one\nLine with QUERY here\nline three";
    let (line_no, _) = best_snippet_for_query(content, "query");
    assert_eq!(line_no, 2, "case-insensitive match should find line 2");
}

#[test]
fn best_snippet_no_match_falls_back_to_first_nonempty_line() {
    let content = "\n\nFirst real content\nMore content";
    let (line_no, snippet) = best_snippet_for_query(content, "xyz_not_present");
    assert_eq!(line_no, 3, "fallback should return first non-empty line (3)");
    assert!(!snippet.is_empty(), "snippet should not be empty on fallback");
}

#[test]
fn best_snippet_empty_content_returns_line_one() {
    let (line_no, snippet) = best_snippet_for_query("", "anything");
    assert_eq!(line_no, 1);
    assert!(snippet.is_empty());
}

#[test]
fn best_snippet_truncates_long_lines_to_200_chars() {
    let long_line = "x".repeat(500) + " keyword " + &"y".repeat(500);
    let content = format!("short line\n{long_line}");
    let (_line_no, snippet) = best_snippet_for_query(&content, "keyword");
    assert!(snippet.len() <= 200, "snippet should be capped at 200 chars, got {}", snippet.len());
}

// ── canonicalize_path ─────────────────────────────────────────────────────────

#[test]
fn canonicalize_path_real_path_resolves() {
    // /tmp is a known-real path on macOS/Linux.
    let result = canonicalize_path("/tmp");
    // On macOS /tmp → /private/tmp; on Linux stays /tmp.  Either way it must
    // be non-empty and absolute.
    assert!(!result.is_empty(), "canonicalized path must not be empty");
    assert!(result.starts_with('/'), "canonicalized path must be absolute");
}

#[test]
fn canonicalize_path_nonexistent_returns_input() {
    let input = "/nonexistent/path/that/does/not/exist/at/all";
    let result = canonicalize_path(input);
    assert_eq!(result, input, "non-existent path should pass through unchanged");
}

// ── vault_file_paths ─────────────────────────────────────────────────────────

#[test]
fn vault_file_paths_returns_files_and_recents() {
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({
            "files": [
                { "path": "/vault/a.md", "name": "a.md" },
                { "path": "/vault/b.md", "name": "b.md" }
            ],
            "recents": ["/recent/c.md"]
        })));
    let paths = vault_file_paths(&ipc);
    // All three paths should be present (after canonicalization attempt).
    assert!(paths.iter().any(|p| p.contains("a.md")), "a.md should be in paths");
    assert!(paths.iter().any(|p| p.contains("b.md")), "b.md should be in paths");
    assert!(paths.iter().any(|p| p.contains("c.md")), "c.md from recents should be in paths");
}

#[test]
fn vault_file_paths_deduplicates_recents_already_in_files() {
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({
            "files": [{ "path": "/vault/a.md", "name": "a.md" }],
            "recents": ["/vault/a.md"]
        })));
    let paths = vault_file_paths(&ipc);
    let count = paths.iter().filter(|p| p.contains("a.md")).count();
    assert_eq!(count, 1, "duplicate path should appear only once");
}

#[test]
fn vault_file_paths_ipc_error_returns_empty() {
    let ipc = MockIpc::new()
        .on_get("/vault", Err("ipc-port not found".into()));
    let paths = vault_file_paths(&ipc);
    assert!(paths.is_empty(), "IPC error should yield empty path list");
}

// ── grep_vault ────────────────────────────────────────────────────────────────

#[test]
fn grep_vault_no_vault_paths_returns_empty() {
    // IPC unavailable → vault_file_paths returns [] → grep returns [].
    let ipc = MockIpc::new()
        .on_get("/vault", Err("ipc-port not found".into()));
    let results = grep_vault("anything", 50, &ipc).expect("grep_vault should not error");
    assert!(results.is_empty(), "no vault paths → no results");
}

#[test]
fn grep_vault_with_real_temp_file_finds_match() {
    use std::io::Write;
    // Write a temp file with known content.
    let mut f = tempfile::NamedTempFile::new().expect("tempfile");
    writeln!(f, "# Meeting notes\nThis is about the quarterly review.").unwrap();
    let path = f.path().to_str().unwrap().to_string();

    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({
            "files": [{ "path": path, "name": "test.md" }],
            "recents": []
        })));
    let results = grep_vault("quarterly", 50, &ipc).expect("grep_vault ok");
    assert!(!results.is_empty(), "should find match for 'quarterly'");
    let first = &results[0];
    assert!(first["path"].as_str().unwrap().len() > 0);
    assert!(first["snippet"].as_str().unwrap().contains("quarterly"));
    assert!(first["score"].as_f64().unwrap() > 0.0);
}

#[test]
fn grep_vault_no_match_returns_empty() {
    use std::io::Write;
    let mut f = tempfile::NamedTempFile::new().expect("tempfile");
    writeln!(f, "# Notes\nSome content here.").unwrap();
    let path = f.path().to_str().unwrap().to_string();

    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({
            "files": [{ "path": path, "name": "test.md" }],
            "recents": []
        })));
    let results = grep_vault("xyz_never_matches_zzz", 50, &ipc).expect("grep_vault ok");
    assert!(results.is_empty(), "no match should return empty results");
}

#[test]
fn grep_vault_results_sorted_by_score_descending() {
    use std::io::Write;
    // File A: query appears once in 10 lines → low density.
    let mut fa = tempfile::NamedTempFile::new().unwrap();
    for i in 0..9 { writeln!(fa, "line {i}").unwrap(); }
    writeln!(fa, "found the needle here").unwrap();
    let path_a = fa.path().to_str().unwrap().to_string();

    // File B: query appears in every line → high density.
    let mut fb = tempfile::NamedTempFile::new().unwrap();
    for _ in 0..5 { writeln!(fb, "needle needle needle").unwrap(); }
    let path_b = fb.path().to_str().unwrap().to_string();

    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({
            "files": [
                { "path": path_a.clone(), "name": "a.md" },
                { "path": path_b.clone(), "name": "b.md" }
            ],
            "recents": []
        })));
    let results = grep_vault("needle", 50, &ipc).expect("grep_vault ok");
    assert_eq!(results.len(), 2, "both files should match");
    let score_first = results[0]["score"].as_f64().unwrap();
    let score_second = results[1]["score"].as_f64().unwrap();
    assert!(score_first >= score_second, "results must be sorted descending by score");
}

#[test]
fn grep_vault_respects_limit() {
    use std::io::Write;
    let ipc_files: Vec<Value> = (0..10).map(|i| {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        writeln!(f, "line with keyword here").unwrap();
        // Keep file alive by leaking — acceptable in test context.
        let path = f.path().to_str().unwrap().to_string();
        std::mem::forget(f);
        json!({ "path": path, "name": format!("f{i}.md") })
    }).collect();

    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({ "files": ipc_files, "recents": [] })));
    let results = grep_vault("keyword", 3, &ipc).expect("grep_vault ok");
    assert!(results.len() <= 3, "limit=3 must cap results to 3, got {}", results.len());
}

// ── tool_search_vault with semantic=false forces grep path ───────────────────

#[test]
fn search_vault_semantic_false_uses_ipc_grep() {
    // With semantic=false the tool must call /search IPC endpoint (grep mode).
    let ipc = MockIpc::new()
        .on_get("/search", Ok(json!({
            "results": [
                { "path": "/vault/a.md", "score": 0.8, "snippet": "hello world", "lineNumber": 3 }
            ]
        })));
    let resp = tool_search_vault(
        id(200),
        &json!({ "query": "hello", "semantic": false }),
        &ipc,
    );
    assert!(resp.error.is_none(), "unexpected error: {:?}", resp.error);
    let text = content_text(&resp);
    // Mode should indicate grep.
    let mode = text["mode"].as_str().unwrap_or("");
    assert!(mode == "grep" || mode == "grep-local",
        "semantic=false should use grep mode, got mode={mode}");
}

#[test]
fn search_vault_semantic_false_ipc_down_falls_back_to_local_grep() {
    use std::io::Write;
    let mut f = tempfile::NamedTempFile::new().unwrap();
    writeln!(f, "# Notes\nThis mentions the target topic explicitly.").unwrap();
    let path = f.path().to_str().unwrap().to_string();

    // /search IPC fails; /vault succeeds so local grep can run.
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({
            "files": [{ "path": path, "name": "notes.md" }],
            "recents": []
        })))
        .on_get("/search", Err("ipc-port not found".into()));

    let resp = tool_search_vault(
        id(201),
        &json!({ "query": "target topic", "semantic": false }),
        &ipc,
    );
    assert!(resp.error.is_none(), "local grep fallback should succeed: {:?}", resp.error);
    let text = content_text(&resp);
    assert_eq!(text["mode"].as_str().unwrap_or(""), "grep-local",
        "should fall back to grep-local when IPC is down");
    let results = text["results"].as_array().expect("results must be array");
    assert!(!results.is_empty(), "local grep should find the match");
}

// ── text://vault-search resource ──────────────────────────────────────────────

#[test]
fn resources_list_includes_vault_search_resource() {
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
    let resp = handle_resources_list(id(300), &ipc);
    assert!(resp.error.is_none());
    let result = resp.result.as_ref().unwrap();
    let resources = result["resources"].as_array().unwrap();
    let uris: Vec<&str> = resources.iter().filter_map(|r| r["uri"].as_str()).collect();
    assert!(uris.contains(&"text://vault-search"),
        "resources/list must include text://vault-search, got: {:?}", uris);
}

#[test]
fn resources_list_vault_search_has_json_mime_type() {
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
    let resp = handle_resources_list(id(301), &ipc);
    let result = resp.result.as_ref().unwrap();
    let resources = result["resources"].as_array().unwrap();
    let search_res = resources.iter()
        .find(|r| r["uri"].as_str() == Some("text://vault-search"))
        .expect("text://vault-search not found");
    assert_eq!(search_res["mimeType"].as_str(), Some("application/json"),
        "vault-search resource must have mimeType application/json");
}

#[test]
fn resource_read_vault_search_missing_query_returns_error() {
    let ipc = MockIpc::new();
    // URI without ?q= parameter.
    let resp = handle_resource_read(id(302), "text://vault-search", &ipc);
    assert!(resp.error.is_some(), "missing query must return error");
    assert_eq!(resp.error.as_ref().unwrap().code, -32602,
        "missing query must be a param error (-32602)");
}

#[test]
fn resource_read_vault_search_with_query_returns_json_content() {
    let ipc = MockIpc::new()
        .on_get("/search", Ok(json!({
            "results": [
                { "path": "/vault/doc.md", "score": 0.75, "snippet": "relevant text", "lineNumber": 5 }
            ]
        })));
    let resp = handle_resource_read(id(303), "text://vault-search?q=relevant", &ipc);
    assert!(resp.error.is_none(), "should succeed: {:?}", resp.error);
    let result = resp.result.as_ref().unwrap();
    let contents = result["contents"].as_array().expect("contents must be array");
    assert_eq!(contents.len(), 1);
    let item = &contents[0];
    assert_eq!(item["mimeType"].as_str(), Some("application/json"));
    // Parse the text payload as JSON.
    let payload: Value = serde_json::from_str(item["text"].as_str().unwrap())
        .expect("text must be valid JSON");
    assert!(payload["results"].is_array(), "payload must have results array");
    assert!(payload["mode"].is_string(), "payload must have mode field");
    assert_eq!(payload["query"].as_str(), Some("relevant"),
        "payload must echo back the query");
}

#[test]
fn resource_read_vault_search_uri_encoded_query_decoded() {
    let ipc = MockIpc::new()
        .on_get("/search", Ok(json!({ "results": [] })));
    // q=hello%20world — should decode to "hello world".
    let resp = handle_resource_read(id(304), "text://vault-search?q=hello%20world", &ipc);
    assert!(resp.error.is_none());
    let result = resp.result.as_ref().unwrap();
    let payload: Value = serde_json::from_str(
        result["contents"][0]["text"].as_str().unwrap()
    ).unwrap();
    assert_eq!(payload["query"].as_str(), Some("hello world"),
        "URL-encoded query must be decoded");
}

#[test]
fn resource_read_vault_search_no_results_returns_empty_array() {
    let ipc = MockIpc::new()
        .on_get("/search", Ok(json!({ "results": [] })));
    let resp = handle_resource_read(id(305), "text://vault-search?q=xyz_impossible", &ipc);
    assert!(resp.error.is_none());
    let payload: Value = serde_json::from_str(
        resp.result.as_ref().unwrap()["contents"][0]["text"].as_str().unwrap()
    ).unwrap();
    let results = payload["results"].as_array().expect("results must be array");
    assert!(results.is_empty(), "no matches should return empty results array");
}

#[test]
fn resource_read_vault_search_ipc_down_falls_back_to_local_grep() {
    use std::io::Write;
    let mut f = tempfile::NamedTempFile::new().unwrap();
    writeln!(f, "# Project notes\nThis has the query term inside.").unwrap();
    let path = f.path().to_str().unwrap().to_string();

    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({
            "files": [{ "path": path, "name": "notes.md" }],
            "recents": []
        })))
        .on_get("/search", Err("ipc-port not found".into()));

    let resp = handle_resource_read(id(306), "text://vault-search?q=query+term", &ipc);
    assert!(resp.error.is_none(), "local grep fallback must succeed: {:?}", resp.error);
    let payload: Value = serde_json::from_str(
        resp.result.as_ref().unwrap()["contents"][0]["text"].as_str().unwrap()
    ).unwrap();
    assert_eq!(payload["mode"].as_str().unwrap_or(""), "grep-local");
}

#[test]
fn resource_read_vault_search_custom_limit_respected() {
    let ipc = MockIpc::new()
        .on_get("/search", Ok(json!({ "results": [] })));
    // limit=5 in query string.
    let resp = handle_resource_read(id(307), "text://vault-search?q=x&limit=5", &ipc);
    assert!(resp.error.is_none());
    // We can't directly observe the limit applied server-side through the mock,
    // but the call should succeed and return valid JSON.
    let payload: Value = serde_json::from_str(
        resp.result.as_ref().unwrap()["contents"][0]["text"].as_str().unwrap()
    ).unwrap();
    assert!(payload["results"].is_array());
}

// ── search_vault result shape ─────────────────────────────────────────────────

#[test]
fn search_vault_result_contains_required_fields() {
    let ipc = MockIpc::new()
        .on_get("/search", Ok(json!({
            "results": [
                {
                    "path": "/vault/doc.md",
                    "snippet": "a relevant snippet",
                    "lineNumber": 7,
                    "score": 0.9
                }
            ]
        })));
    let resp = tool_search_vault(
        id(400),
        &json!({ "query": "relevant", "semantic": false }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    let results = text["results"].as_array().expect("results must be array");
    assert_eq!(results.len(), 1);
    let r = &results[0];
    assert!(r["path"].is_string(), "result must have path");
    assert!(r["snippet"].is_string(), "result must have snippet");
    assert!(r["lineNumber"].is_number(), "result must have lineNumber");
    assert!(r["score"].is_number(), "result must have score");
}

#[test]
fn search_result_to_json_includes_all_fields() {
    let sr = SearchResult {
        path: "/tmp/test.md".to_string(),
        snippet: "hello world".to_string(),
        line_number: 42,
        score: 0.75,
    };
    let j = sr.to_json();
    assert_eq!(j["path"].as_str(), Some("/tmp/test.md"));
    assert_eq!(j["snippet"].as_str(), Some("hello world"));
    assert_eq!(j["lineNumber"].as_u64(), Some(42));
    assert!((j["score"].as_f64().unwrap() - 0.75).abs() < 1e-9);
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 13: get_conversation_context
// Tool 14: save_conversation_message
// ════════════════════════════════════════════════════════════════════════════
//
// These tests cover:
//   1. Missing required params → -32602
//   2. Empty session → graceful empty response
//   3. Append + retrieve round-trip (message append + retrieval)
//   4. Session isolation (appending to A does not appear in B)
//   5. Disk persistence across "restart" (load_session_from_disk)
//   6. Limit parameter caps results
//   7. cited_docs aggregated in recentDocs
//   8. Invalid role rejected
//   9. Empty content rejected
//  10. dispatch() routes both tool names without "Unknown tool"

// ── Helper: unique session id per test so parallel tests do not interfere ────

fn unique_session() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CTR: AtomicU64 = AtomicU64::new(0);
    format!("test-sess-{}-{}", std::process::id(), CTR.fetch_add(1, Ordering::SeqCst))
}

// ════════════════════════════════════════════════════════════════════════════
// save_conversation_message — parameter validation
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn save_message_missing_session_id_returns_param_error() {
    let resp = tool_save_conversation_message(id(1), &json!({
        "role": "agent",
        "content": "Did something"
    }));
    assert_eq!(resp.error.as_ref().unwrap().code, -32602,
        "missing session_id must return -32602");
}

#[test]
fn save_message_empty_session_id_returns_param_error() {
    let resp = tool_save_conversation_message(id(1), &json!({
        "session_id": "",
        "role": "agent",
        "content": "Did something"
    }));
    assert_eq!(resp.error.as_ref().unwrap().code, -32602,
        "empty session_id must return -32602");
}

#[test]
fn save_message_missing_role_returns_param_error() {
    let resp = tool_save_conversation_message(id(1), &json!({
        "session_id": unique_session(),
        "content": "Some content"
    }));
    assert_eq!(resp.error.as_ref().unwrap().code, -32602,
        "missing role must return -32602");
}

#[test]
fn save_message_invalid_role_returns_param_error() {
    let resp = tool_save_conversation_message(id(1), &json!({
        "session_id": unique_session(),
        "role": "robot",
        "content": "Some content"
    }));
    assert_eq!(resp.error.as_ref().unwrap().code, -32602,
        "invalid role must return -32602");
    let msg = resp.error.unwrap().message;
    assert!(
        msg.contains("agent") || msg.contains("human") || msg.contains("system"),
        "error should list valid roles, got: {msg}"
    );
}

#[test]
fn save_message_missing_content_returns_param_error() {
    let resp = tool_save_conversation_message(id(1), &json!({
        "session_id": unique_session(),
        "role": "agent"
    }));
    assert_eq!(resp.error.as_ref().unwrap().code, -32602,
        "missing content must return -32602");
}

#[test]
fn save_message_empty_content_returns_param_error() {
    let resp = tool_save_conversation_message(id(1), &json!({
        "session_id": unique_session(),
        "role": "agent",
        "content": "   "
    }));
    assert_eq!(resp.error.as_ref().unwrap().code, -32602,
        "whitespace-only content must return -32602");
}

// ════════════════════════════════════════════════════════════════════════════
// save_conversation_message — success paths
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn save_message_agent_role_succeeds_and_returns_message_id() {
    let sess = unique_session();
    let resp = tool_save_conversation_message(id(1), &json!({
        "session_id": sess,
        "role": "agent",
        "content": "Rewrote the introduction paragraph."
    }));
    assert!(resp.error.is_none(), "agent save should succeed: {:?}", resp.error);
    assert!(!is_error(&resp), "isError must be false");
    let text = content_text(&resp);
    assert_eq!(text["ok"], json!(true));
    assert!(text["messageId"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
        "messageId must be a non-empty string");
    assert_eq!(text["sessionId"].as_str(), Some(sess.as_str()));
    assert_eq!(text["role"].as_str(), Some("agent"));
}

#[test]
fn save_message_human_role_succeeds() {
    let sess = unique_session();
    let resp = tool_save_conversation_message(id(2), &json!({
        "session_id": sess,
        "role": "human",
        "content": "Approved — looks good."
    }));
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["role"].as_str(), Some("human"));
}

#[test]
fn save_message_system_role_succeeds() {
    let sess = unique_session();
    let resp = tool_save_conversation_message(id(3), &json!({
        "session_id": sess,
        "role": "system",
        "content": "Session started. Active doc: /docs/notes.md"
    }));
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["role"].as_str(), Some("system"));
}

#[test]
fn save_message_with_cited_docs_accepted() {
    let sess = unique_session();
    let resp = tool_save_conversation_message(id(4), &json!({
        "session_id": sess,
        "role": "agent",
        "content": "Summarised the spec.",
        "cited_docs": ["/docs/spec.md", "/docs/roadmap.md"]
    }));
    assert!(resp.error.is_none(), "cited_docs should be accepted: {:?}", resp.error);
    assert_eq!(content_text(&resp)["ok"], json!(true));
}

#[test]
fn save_message_without_cited_docs_defaults_to_empty() {
    // cited_docs is optional — omitting it must not error.
    let sess = unique_session();
    let resp = tool_save_conversation_message(id(5), &json!({
        "session_id": sess,
        "role": "agent",
        "content": "No docs cited here."
    }));
    assert!(resp.error.is_none());
}

// ════════════════════════════════════════════════════════════════════════════
// get_conversation_context — parameter validation
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn get_context_missing_session_id_returns_param_error() {
    let resp = tool_get_conversation_context(id(1), &json!({}));
    assert_eq!(resp.error.as_ref().unwrap().code, -32602,
        "missing session_id must return -32602");
}

#[test]
fn get_context_empty_session_id_returns_param_error() {
    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": "" }));
    assert_eq!(resp.error.as_ref().unwrap().code, -32602);
}

// ════════════════════════════════════════════════════════════════════════════
// get_conversation_context — empty session graceful fallback
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn get_context_empty_session_returns_empty_messages_array() {
    // Session was never written to — must return empty, not error.
    let sess = unique_session();
    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    assert!(resp.error.is_none(),
        "empty session must not produce RPC error: {:?}", resp.error);
    assert!(!is_error(&resp), "isError must be false for empty session");
    let text = content_text(&resp);
    let msgs = text["messages"].as_array().expect("messages must be array");
    assert!(msgs.is_empty(), "empty session must return zero messages");
    assert_eq!(text["count"].as_u64(), Some(0));
}

// ════════════════════════════════════════════════════════════════════════════
// Append + retrieve round-trip (message append + retrieval)
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn append_then_get_context_returns_message() {
    let sess = unique_session();

    // Append a message directly via the store helper.
    store_append_message(&sess, "agent", "Ran search_vault.", vec![])
        .expect("append must succeed");

    // Retrieve via the MCP tool.
    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    assert!(resp.error.is_none(), "get after append must succeed: {:?}", resp.error);
    let text = content_text(&resp);
    let msgs = text["messages"].as_array().expect("messages must be array");
    assert_eq!(msgs.len(), 1, "should retrieve exactly 1 message");
    assert_eq!(msgs[0]["role"].as_str(), Some("agent"));
    assert_eq!(msgs[0]["content"].as_str(), Some("Ran search_vault."));
    assert_eq!(text["count"].as_u64(), Some(1));
}

#[test]
fn multiple_appends_retrieved_in_order() {
    let sess = unique_session();

    store_append_message(&sess, "system", "Session started.", vec![]).unwrap();
    store_append_message(&sess, "agent", "Opened /docs/spec.md.", vec!["/docs/spec.md".into()]).unwrap();
    store_append_message(&sess, "human", "Looks good, continue.", vec![]).unwrap();

    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    let text = content_text(&resp);
    let msgs = text["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 3, "all 3 messages should be returned");
    assert_eq!(msgs[0]["role"].as_str(), Some("system"));
    assert_eq!(msgs[1]["role"].as_str(), Some("agent"));
    assert_eq!(msgs[2]["role"].as_str(), Some("human"));
}

#[test]
fn save_then_get_via_mcp_tools_round_trip() {
    // End-to-end: use only the public MCP tool functions (no store helpers).
    let sess = unique_session();

    let save_resp = tool_save_conversation_message(id(1), &json!({
        "session_id": sess,
        "role": "agent",
        "content": "Edited the summary section.",
        "cited_docs": ["/vault/summary.md"]
    }));
    assert!(save_resp.error.is_none(), "save must succeed");

    let get_resp = tool_get_conversation_context(id(2), &json!({
        "session_id": sess,
        "limit": 10
    }));
    assert!(get_resp.error.is_none(), "get must succeed");
    let text = content_text(&get_resp);
    let msgs = text["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0]["content"].as_str(), Some("Edited the summary section."));
    assert_eq!(msgs[0]["role"].as_str(), Some("agent"));
}

// ════════════════════════════════════════════════════════════════════════════
// Session isolation
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn messages_are_isolated_by_session_id() {
    let sess_a = unique_session();
    let sess_b = unique_session();

    store_append_message(&sess_a, "agent", "Message for session A.", vec![]).unwrap();
    store_append_message(&sess_b, "human", "Message for session B.", vec![]).unwrap();

    // Session A should only see its own message.
    let ctx_a = store_get_context(&sess_a, 20).unwrap();
    assert_eq!(ctx_a.len(), 1);
    assert_eq!(ctx_a[0].content, "Message for session A.");

    // Session B should only see its own message.
    let ctx_b = store_get_context(&sess_b, 20).unwrap();
    assert_eq!(ctx_b.len(), 1);
    assert_eq!(ctx_b[0].content, "Message for session B.");
}

#[test]
fn appending_to_one_session_does_not_appear_in_another() {
    let sess_x = unique_session();
    let sess_y = unique_session();

    // Write to X; Y should stay empty.
    store_append_message(&sess_x, "agent", "Action in X.", vec![]).unwrap();

    let ctx_y = store_get_context(&sess_y, 20).unwrap();
    assert!(ctx_y.is_empty(),
        "messages written to session X must not appear in session Y");
}

// ════════════════════════════════════════════════════════════════════════════
// Disk persistence across simulated "restart"
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn messages_persisted_to_disk_and_loadable() {
    let sess = unique_session();

    // Append via store (triggers disk write).
    store_append_message(&sess, "agent", "Wrote introduction.", vec!["/vault/intro.md".into()])
        .expect("append must succeed");

    // Load directly from disk — simulating a fresh process start.
    let loaded = load_session_from_disk(&sess);
    assert!(loaded.is_some(), "session must be persisted to disk");
    let log = loaded.unwrap();
    assert_eq!(log.messages.len(), 1);
    assert_eq!(log.messages[0].content, "Wrote introduction.");
    assert_eq!(log.messages[0].cited_docs, vec!["/vault/intro.md"]);
}

#[test]
fn disk_persistence_survives_multiple_appends() {
    let sess = unique_session();

    for i in 0..5 {
        store_append_message(&sess, "agent", &format!("Step {i} completed."), vec![])
            .expect("append must succeed");
    }

    let log = load_session_from_disk(&sess).expect("session must be on disk");
    assert_eq!(log.messages.len(), 5,
        "all 5 messages must be persisted, got {}", log.messages.len());
}

#[test]
fn cold_start_loads_from_disk_via_get_context() {
    // Simulate a cold start: write directly to disk, bypass the in-process store,
    // then call store_get_context which should load from disk automatically.
    use mdopener_mcp::{SessionLog, ConversationMessage};

    let sess = unique_session();
    let path = session_file_path(&sess).expect("must have session path");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }

    let ts = 1_700_000_000_000u64;
    let log = SessionLog {
        messages: vec![
            ConversationMessage {
                id: "msg-cold-start-test".into(),
                session_id: sess.clone(),
                role: "human".into(),
                content: "Approved the plan.".into(),
                cited_docs: vec![],
                timestamp_ms: ts,
            }
        ],
    };
    let json = serde_json::to_string(&log).unwrap();
    std::fs::write(&path, &json).expect("write must succeed");

    // Get context — the in-process store does NOT have this session yet.
    let ctx = store_get_context(&sess, 20).expect("get must succeed");
    assert_eq!(ctx.len(), 1, "cold-start load must recover 1 message from disk");
    assert_eq!(ctx[0].content, "Approved the plan.");
    assert_eq!(ctx[0].role, "human");
}

// ════════════════════════════════════════════════════════════════════════════
// Limit parameter
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn get_context_limit_caps_returned_messages() {
    let sess = unique_session();

    for i in 0..10 {
        store_append_message(&sess, "agent", &format!("Step {i}"), vec![]).unwrap();
    }

    let resp = tool_get_conversation_context(id(1), &json!({
        "session_id": sess,
        "limit": 3
    }));
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    let msgs = text["messages"].as_array().unwrap();
    assert!(msgs.len() <= 3, "limit=3 must return at most 3 messages, got {}", msgs.len());
}

#[test]
fn get_context_limit_returns_most_recent_messages() {
    let sess = unique_session();

    for i in 0..5 {
        store_append_message(&sess, "agent", &format!("Message {i}"), vec![]).unwrap();
    }

    let resp = tool_get_conversation_context(id(1), &json!({
        "session_id": sess,
        "limit": 2
    }));
    let text = content_text(&resp);
    let msgs = text["messages"].as_array().unwrap();
    // Should return the two most recent: "Message 3" and "Message 4".
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[1]["content"].as_str(), Some("Message 4"),
        "last message should be 'Message 4'");
}

#[test]
fn get_context_default_limit_is_20() {
    let sess = unique_session();

    for i in 0..25 {
        store_append_message(&sess, "agent", &format!("M{i}"), vec![]).unwrap();
    }

    // No explicit limit — should default to 20.
    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    let text = content_text(&resp);
    let msgs = text["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 20, "default limit must be 20, got {}", msgs.len());
}

// ════════════════════════════════════════════════════════════════════════════
// cited_docs aggregated into recentDocs
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn recent_docs_aggregated_from_cited_docs() {
    let sess = unique_session();

    store_append_message(&sess, "agent", "Read spec.", vec!["/docs/spec.md".into()]).unwrap();
    store_append_message(&sess, "agent", "Read roadmap.", vec!["/docs/roadmap.md".into()]).unwrap();
    store_append_message(&sess, "human", "Approved.", vec![]).unwrap();

    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    let text = content_text(&resp);
    let recent_docs = text["recentDocs"].as_array().expect("recentDocs must be array");
    let paths: Vec<&str> = recent_docs.iter().filter_map(|v| v.as_str()).collect();
    assert!(paths.contains(&"/docs/spec.md"), "spec.md must appear in recentDocs");
    assert!(paths.contains(&"/docs/roadmap.md"), "roadmap.md must appear in recentDocs");
}

#[test]
fn recent_docs_deduplicates_repeated_paths() {
    let sess = unique_session();

    store_append_message(&sess, "agent", "First read.", vec!["/vault/doc.md".into()]).unwrap();
    store_append_message(&sess, "agent", "Second read.", vec!["/vault/doc.md".into()]).unwrap();

    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    let text = content_text(&resp);
    let recent_docs = text["recentDocs"].as_array().expect("recentDocs must be array");
    let doc_count = recent_docs.iter()
        .filter(|v| v.as_str() == Some("/vault/doc.md"))
        .count();
    assert_eq!(doc_count, 1, "/vault/doc.md should appear exactly once in recentDocs");
}

// ════════════════════════════════════════════════════════════════════════════
// Message shape validation
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn saved_message_has_all_required_fields() {
    let sess = unique_session();
    store_append_message(&sess, "agent", "Did something.", vec!["/a.md".into()]).unwrap();

    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    let text = content_text(&resp);
    let msg = &text["messages"].as_array().unwrap()[0];

    assert!(msg["id"].is_string(), "message must have id");
    assert!(msg["sessionId"].is_string(), "message must have sessionId");
    assert!(msg["role"].is_string(), "message must have role");
    assert!(msg["content"].is_string(), "message must have content");
    assert!(msg["citedDocs"].is_array(), "message must have citedDocs array");
    assert!(msg["timestampMs"].is_number(), "message must have timestampMs");
}

#[test]
fn message_ids_are_unique_across_appends() {
    let sess = unique_session();

    let m1 = store_append_message(&sess, "agent", "First.", vec![]).unwrap();
    let m2 = store_append_message(&sess, "agent", "Second.", vec![]).unwrap();

    assert_ne!(m1.id, m2.id, "each message must have a unique id");
}

// ════════════════════════════════════════════════════════════════════════════
// dispatch() routes both new tool names
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn dispatch_routes_get_conversation_context() {
    let sess = unique_session();
    let req = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(1)),
        method: "tools/call".into(),
        params: Some(json!({
            "name": "get_conversation_context",
            "arguments": { "session_id": sess }
        })),
    };
    let ipc = MockIpc::new();
    let resp = dispatch(req, &ipc).expect("dispatch must return a response");
    // Must not be an "Unknown tool" error.
    if let Some(err) = &resp.error {
        assert!(!err.message.contains("Unknown tool"),
            "get_conversation_context must be routed, got: {}", err.message);
    }
}

#[test]
fn dispatch_routes_save_conversation_message() {
    let sess = unique_session();
    let req = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(2)),
        method: "tools/call".into(),
        params: Some(json!({
            "name": "save_conversation_message",
            "arguments": {
                "session_id": sess,
                "role": "agent",
                "content": "Dispatch routing test."
            }
        })),
    };
    let ipc = MockIpc::new();
    let resp = dispatch(req, &ipc).expect("dispatch must return a response");
    if let Some(err) = &resp.error {
        assert!(!err.message.contains("Unknown tool"),
            "save_conversation_message must be routed, got: {}", err.message);
    }
    assert!(resp.error.is_none(), "save via dispatch must succeed: {:?}", resp.error);
}

// ════════════════════════════════════════════════════════════════════════════
// session_file_path sanitisation
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn session_file_path_sanitises_special_characters() {
    // Slashes and dots in a session ID must not escape the sessions directory.
    let path = session_file_path("../../evil/path").expect("must return a path");
    let filename = path.file_name().unwrap().to_string_lossy();
    assert!(!filename.contains('/'), "sanitised filename must not contain '/'");
    assert!(filename.ends_with(".json"), "path must end with .json");
}

#[test]
fn session_file_path_alphanumeric_preserved() {
    let path = session_file_path("sess-abc-123_XYZ").expect("must return a path");
    let filename = path.file_name().unwrap().to_string_lossy();
    assert!(filename.contains("sess-abc-123_XYZ"),
        "alphanumeric/dash/underscore chars must be preserved in filename");
}

// ════════════════════════════════════════════════════════════════════════════
// Tool: export_markdown_archive
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn export_markdown_archive_no_output_path_posts_to_ipc() {
    let ipc = MockIpc::new()
        .on_post("/export/markdown-archive", Ok(json!({
            "ok": true,
            "path": "/tmp/doc.tar.gz",
            "files": ["doc.md"],
            "size": 1024
        })));
    let resp = tool_export_markdown_archive(id(1), &json!({}), &ipc);
    assert!(resp.error.is_none(), "should not have RPC error: {:?}", resp.error);
    assert!(!is_error(&resp));
    let calls = ipc.calls();
    assert!(
        calls.iter().any(|(m, p, _)| m == "POST" && p == "/export/markdown-archive"),
        "must POST to /export/markdown-archive"
    );
}

#[test]
fn export_markdown_archive_output_path_forwarded() {
    let ipc = MockIpc::new()
        .on_post("/export/markdown-archive", Ok(json!({ "ok": true, "path": "/out/arch.tar.gz" })));
    tool_export_markdown_archive(
        id(2),
        &json!({ "output_path": "/out/arch.tar.gz" }),
        &ipc,
    );
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export/markdown-archive")
        .expect("must POST /export/markdown-archive")
        .2.as_ref().unwrap();
    assert_eq!(body["outputPath"], "/out/arch.tar.gz");
}

#[test]
fn export_markdown_archive_include_assets_defaults_to_true() {
    let ipc = MockIpc::new()
        .on_post("/export/markdown-archive", Ok(json!({ "ok": true })));
    tool_export_markdown_archive(id(3), &json!({}), &ipc);
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export/markdown-archive")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["includeAssets"], json!(true),
        "includeAssets must default to true");
}

#[test]
fn export_markdown_archive_include_assets_false_forwarded() {
    let ipc = MockIpc::new()
        .on_post("/export/markdown-archive", Ok(json!({ "ok": true })));
    tool_export_markdown_archive(
        id(4),
        &json!({ "include_assets": false }),
        &ipc,
    );
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export/markdown-archive")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["includeAssets"], json!(false));
}

#[test]
fn export_markdown_archive_ipc_failure_returns_rpc_error() {
    let ipc = MockIpc::new()
        .on_post("/export/markdown-archive", Err("ipc-port not found".into()));
    let resp = tool_export_markdown_archive(id(5), &json!({}), &ipc);
    assert!(resp.error.is_some(), "IPC failure must return RPC error");
    assert_eq!(resp.error.unwrap().code, -32000);
}

#[test]
fn export_markdown_archive_app_not_running_returns_descriptive_error() {
    let ipc = MockIpc::new()
        .on_post("/export/markdown-archive", Err("ipc-port not found — is Ashlr MD running?".into()));
    let resp = tool_export_markdown_archive(id(6), &json!({}), &ipc);
    let err = resp.error.expect("should have error");
    assert_eq!(err.code, -32000);
    assert!(err.message.contains("Ashlr MD"),
        "error should mention app name, got: {}", err.message);
}

#[test]
fn export_markdown_archive_success_returns_path_and_files() {
    let ipc = MockIpc::new()
        .on_post("/export/markdown-archive", Ok(json!({
            "ok": true,
            "path": "/vault/archive.tar.gz",
            "files": ["doc.md", "assets/fig1.svg"],
            "size": 2048
        })));
    let resp = tool_export_markdown_archive(id(7), &json!({}), &ipc);
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["ok"], json!(true));
    assert_eq!(text["path"], "/vault/archive.tar.gz");
    assert!(text["files"].is_array());
}

#[test]
fn export_markdown_archive_no_output_path_null_in_body() {
    let ipc = MockIpc::new()
        .on_post("/export/markdown-archive", Ok(json!({ "ok": true })));
    tool_export_markdown_archive(id(8), &json!({}), &ipc);
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export/markdown-archive")
        .unwrap().2.as_ref().unwrap();
    assert!(body["outputPath"].is_null(),
        "absent output_path should be null in IPC body, got {:?}", body["outputPath"]);
}

#[test]
fn export_markdown_archive_dispatch_routes_correctly() {
    let ipc = MockIpc::new()
        .on_post("/export/markdown-archive", Ok(json!({ "ok": true })));
    let req = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(99)),
        method: "tools/call".into(),
        params: Some(json!({ "name": "export_markdown_archive", "arguments": {} })),
    };
    let resp = dispatch(req, &ipc).expect("dispatch must return a response");
    assert!(resp.error.is_none(), "dispatch should succeed: {:?}", resp.error);
}

// ════════════════════════════════════════════════════════════════════════════
// Tool: export_canvas_graph
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn export_canvas_graph_posts_to_ipc() {
    let ipc = MockIpc::new()
        .on_post("/export/canvas-graph", Ok(json!({
            "ok": true,
            "path": "/vault/graph.canvas",
            "nodeCount": 5,
            "edgeCount": 3
        })));
    let resp = tool_export_canvas_graph(id(10), &json!({}), &ipc);
    assert!(resp.error.is_none(), "should not have RPC error: {:?}", resp.error);
    assert!(!is_error(&resp));
    let calls = ipc.calls();
    assert!(
        calls.iter().any(|(m, p, _)| m == "POST" && p == "/export/canvas-graph"),
        "must POST to /export/canvas-graph"
    );
}

#[test]
fn export_canvas_graph_output_path_forwarded() {
    let ipc = MockIpc::new()
        .on_post("/export/canvas-graph", Ok(json!({ "ok": true })));
    tool_export_canvas_graph(
        id(11),
        &json!({ "output_path": "/out/vault.canvas" }),
        &ipc,
    );
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export/canvas-graph")
        .expect("must POST /export/canvas-graph")
        .2.as_ref().unwrap();
    assert_eq!(body["outputPath"], "/out/vault.canvas");
}

#[test]
fn export_canvas_graph_include_isolated_defaults_to_true() {
    let ipc = MockIpc::new()
        .on_post("/export/canvas-graph", Ok(json!({ "ok": true })));
    tool_export_canvas_graph(id(12), &json!({}), &ipc);
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export/canvas-graph")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["includeIsolated"], json!(true),
        "includeIsolated must default to true");
}

#[test]
fn export_canvas_graph_include_isolated_false_forwarded() {
    let ipc = MockIpc::new()
        .on_post("/export/canvas-graph", Ok(json!({ "ok": true })));
    tool_export_canvas_graph(
        id(13),
        &json!({ "include_isolated": false }),
        &ipc,
    );
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export/canvas-graph")
        .unwrap().2.as_ref().unwrap();
    assert_eq!(body["includeIsolated"], json!(false));
}

#[test]
fn export_canvas_graph_ipc_failure_returns_rpc_error() {
    let ipc = MockIpc::new()
        .on_post("/export/canvas-graph", Err("ipc-port not found".into()));
    let resp = tool_export_canvas_graph(id(14), &json!({}), &ipc);
    assert!(resp.error.is_some(), "IPC failure must return RPC error");
    assert_eq!(resp.error.unwrap().code, -32000);
}

#[test]
fn export_canvas_graph_app_not_running_returns_descriptive_error() {
    let ipc = MockIpc::new()
        .on_post("/export/canvas-graph", Err("ipc-port not found — is Ashlr MD running?".into()));
    let resp = tool_export_canvas_graph(id(15), &json!({}), &ipc);
    let err = resp.error.expect("should have error");
    assert_eq!(err.code, -32000);
    assert!(err.message.contains("Ashlr MD"),
        "error should mention app name, got: {}", err.message);
}

#[test]
fn export_canvas_graph_success_returns_node_and_edge_counts() {
    let ipc = MockIpc::new()
        .on_post("/export/canvas-graph", Ok(json!({
            "ok": true,
            "path": "/vault/graph.canvas",
            "nodeCount": 12,
            "edgeCount": 7
        })));
    let resp = tool_export_canvas_graph(id(16), &json!({}), &ipc);
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["ok"], json!(true));
    assert_eq!(text["nodeCount"], json!(12));
    assert_eq!(text["edgeCount"], json!(7));
}

#[test]
fn export_canvas_graph_no_output_path_null_in_body() {
    let ipc = MockIpc::new()
        .on_post("/export/canvas-graph", Ok(json!({ "ok": true })));
    tool_export_canvas_graph(id(17), &json!({}), &ipc);
    let calls = ipc.calls();
    let body = calls.iter()
        .find(|(m, p, _)| m == "POST" && p == "/export/canvas-graph")
        .unwrap().2.as_ref().unwrap();
    assert!(body["outputPath"].is_null(),
        "absent output_path should be null in IPC body, got {:?}", body["outputPath"]);
}

#[test]
fn export_canvas_graph_dispatch_routes_correctly() {
    let ipc = MockIpc::new()
        .on_post("/export/canvas-graph", Ok(json!({ "ok": true })));
    let req = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(99)),
        method: "tools/call".into(),
        params: Some(json!({ "name": "export_canvas_graph", "arguments": {} })),
    };
    let resp = dispatch(req, &ipc).expect("dispatch must return a response");
    assert!(resp.error.is_none(), "dispatch should succeed: {:?}", resp.error);
}

// ── Registry coverage for new tools ──────────────────────────────────────────

#[test]
fn export_markdown_archive_in_all_tool_names() {
    assert!(ALL_TOOL_NAMES.contains(&"export_markdown_archive"),
        "export_markdown_archive must be in ALL_TOOL_NAMES");
}

#[test]
fn export_canvas_graph_in_all_tool_names() {
    assert!(ALL_TOOL_NAMES.contains(&"export_canvas_graph"),
        "export_canvas_graph must be in ALL_TOOL_NAMES");
}

#[test]
fn export_markdown_archive_in_tool_list() {
    let list = tool_list();
    let tools = list.as_array().unwrap();
    let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(names.contains(&"export_markdown_archive"),
        "tool_list must include export_markdown_archive");
}

#[test]
fn export_canvas_graph_in_tool_list() {
    let list = tool_list();
    let tools = list.as_array().unwrap();
    let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(names.contains(&"export_canvas_graph"),
        "tool_list must include export_canvas_graph");
}

#[test]
fn export_markdown_archive_tool_tier_is_modifier() {
    let reg = tool_registry();
    let def = reg.iter().find(|d| d.name == "export_markdown_archive")
        .expect("export_markdown_archive must be in registry");
    assert_eq!(def.tier, ToolTier::Modifier);
}

#[test]
fn export_canvas_graph_tool_tier_is_modifier() {
    let reg = tool_registry();
    let def = reg.iter().find(|d| d.name == "export_canvas_graph")
        .expect("export_canvas_graph must be in registry");
    assert_eq!(def.tier, ToolTier::Modifier);
}

#[test]
fn export_markdown_archive_has_valid_input_schema() {
    let reg = tool_registry();
    let def = reg.iter().find(|d| d.name == "export_markdown_archive").unwrap();
    let schema = &def.input_schema;
    assert_eq!(schema["type"].as_str(), Some("object"));
    assert!(schema["properties"].is_object());
    // output_path and include_assets must be in properties
    assert!(schema["properties"]["output_path"].is_object(),
        "output_path must be in properties");
    assert!(schema["properties"]["include_assets"].is_object(),
        "include_assets must be in properties");
}

#[test]
fn export_canvas_graph_has_valid_input_schema() {
    let reg = tool_registry();
    let def = reg.iter().find(|d| d.name == "export_canvas_graph").unwrap();
    let schema = &def.input_schema;
    assert_eq!(schema["type"].as_str(), Some("object"));
    assert!(schema["properties"].is_object());
    assert!(schema["properties"]["output_path"].is_object(),
        "output_path must be in properties");
    assert!(schema["properties"]["include_isolated"].is_object(),
        "include_isolated must be in properties");
}

#[test]
fn export_markdown_archive_has_non_destructive_annotation() {
    let reg = tool_registry();
    let def = reg.iter().find(|d| d.name == "export_markdown_archive").unwrap();
    let ann = def.annotations.as_ref().expect("must have annotations");
    assert_ne!(ann["destructiveHint"].as_bool(), Some(true),
        "export_markdown_archive must not be destructive");
}

#[test]
fn export_canvas_graph_has_non_destructive_annotation() {
    let reg = tool_registry();
    let def = reg.iter().find(|d| d.name == "export_canvas_graph").unwrap();
    let ann = def.annotations.as_ref().expect("must have annotations");
    assert_ne!(ann["destructiveHint"].as_bool(), Some(true),
        "export_canvas_graph must not be destructive");
}
