//! Integration tests for all 11 mdopener-mcp tools.
//!
//! Uses a `MockIpc` struct that intercepts IPC calls and returns scripted
//! fixtures — no running Ashlr MD app required.  Both success and failure
//! paths are exercised for every tool.

use mdopener_mcp::{
    dispatch, handle_initialize, tool_list,
    tool_open_file, tool_get_content, tool_set_content, tool_list_recent,
    tool_export, tool_request_review, tool_get_annotations,
    tool_edit_document, tool_replace_document, tool_search_vault,
    tool_present_document,
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
// Tool list
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn tools_list_contains_all_11_tools() {
    let list = tool_list();
    let tools = list.as_array().expect("tool_list returns an array");
    let names: Vec<&str> = tools.iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    let expected = [
        "open_file", "get_current_content", "set_content", "list_recent",
        "export", "request_review", "get_user_annotations", "edit_document",
        "replace_document", "search_vault", "present_document",
    ];
    for name in &expected {
        assert!(names.contains(name), "tool_list missing: {name}");
    }
    assert_eq!(names.len(), expected.len(), "unexpected extra tools in list");
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
