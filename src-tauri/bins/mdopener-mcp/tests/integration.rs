//! Integration tests for every mdopener-mcp tool (`ALL_TOOL_NAMES`).
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
    ai_actions_registry, dispatch, handle_initialize, launch::Launch, load_session_from_disk,
    session_file_path, store_append_message, store_get_context, tool_edit_document, tool_export,
    tool_export_with, tool_get_annotations, tool_get_content, tool_get_conversation_context,
    tool_list, tool_list_ai_actions, tool_list_recent, tool_open_file, tool_open_file_with,
    tool_present_document, tool_registry, tool_replace_document, tool_request_review,
    tool_save_conversation_message, tool_search_vault, tool_set_content, tool_stream_edit,
    tool_stream_edit_apply, IpcClient, Request, ToolTier, ALL_TOOL_NAMES, UNAVAILABLE_TOOLS,
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
        Self {
            calls: Mutex::new(vec![]),
            responses: vec![],
        }
    }

    fn on_get(mut self, path_prefix: &str, resp: Result<Value, String>) -> Self {
        self.responses
            .push(("GET".into(), path_prefix.into(), resp));
        self
    }

    fn on_post(mut self, path_prefix: &str, resp: Result<Value, String>) -> Self {
        self.responses
            .push(("POST".into(), path_prefix.into(), resp));
        self
    }

    /// Return the recorded calls for assertion.
    fn calls(&self) -> Vec<(String, String, Option<Value>)> {
        self.calls.lock().unwrap().clone()
    }
}

impl IpcClient for MockIpc {
    fn get(&self, path: &str) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push(("GET".into(), path.into(), None));
        for (method, prefix, resp) in &self.responses {
            if method == "GET" && path.starts_with(prefix.as_str()) {
                return resp.clone();
            }
        }
        Err(format!("MockIpc: no GET handler for {path}"))
    }

    fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push(("POST".into(), path.into(), Some(body)));
        for (method, prefix, resp) in &self.responses {
            if method == "POST" && path.starts_with(prefix.as_str()) {
                return resp.clone();
            }
        }
        Err(format!("MockIpc: no POST handler for {path}"))
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn id(n: u64) -> Value {
    json!(n)
}

/// Extract the text content from a tool_result response envelope.
fn content_text(resp: &mdopener_mcp::Response) -> Value {
    let result = resp.result.as_ref().expect("response has no result");
    let text = result["content"][0]["text"].as_str().expect("no text");
    serde_json::from_str(text).unwrap_or(json!(text))
}

/// Assert the response is a tool execution error (a successful JSON-RPC
/// result with `isError: true`, per the MCP spec) and return its text.
fn tool_error_text(resp: &mdopener_mcp::Response) -> String {
    assert!(
        resp.error.is_none(),
        "tool failure must not be a JSON-RPC error: {:?}",
        resp.error
    );
    assert!(is_error(resp), "tool failure must set isError");
    resp.result.as_ref().unwrap()["content"][0]["text"]
        .as_str()
        .expect("isError result must carry text")
        .to_string()
}

/// Extract isError flag from the result envelope.
fn is_error(resp: &mdopener_mcp::Response) -> bool {
    resp.result
        .as_ref()
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
    let proto = resp.result.as_ref().unwrap()["protocolVersion"]
        .as_str()
        .unwrap();
    assert_eq!(proto, "2025-03-26");
}

#[test]
fn initialize_unsupported_protocol_falls_back_to_latest_supported() {
    // Spec: answer with another supported version, SHOULD be the latest.
    for requested in ["1999-01-01", "2025-11-25"] {
        let resp = handle_initialize(id(1), Some(json!({ "protocolVersion": requested })));
        assert!(resp.error.is_none());
        let proto = resp.result.as_ref().unwrap()["protocolVersion"]
            .as_str()
            .unwrap();
        assert_eq!(proto, "2025-06-18", "requested {requested}");
    }
}

#[test]
fn initialize_echoes_every_version_current_clients_send() {
    // Claude Code and other current clients send one of these.
    for requested in ["2025-06-18", "2025-03-26", "2024-11-05"] {
        let resp = handle_initialize(id(1), Some(json!({ "protocolVersion": requested })));
        let proto = resp.result.as_ref().unwrap()["protocolVersion"]
            .as_str()
            .unwrap();
        assert_eq!(proto, requested);
    }
}

#[test]
fn initialize_no_params_uses_default() {
    let resp = handle_initialize(id(1), None);
    let proto = resp.result.as_ref().unwrap()["protocolVersion"]
        .as_str()
        .unwrap();
    assert_eq!(proto, mdopener_mcp::DEFAULT_PROTOCOL);
    assert_eq!(proto, *mdopener_mcp::SUPPORTED_PROTOCOLS.last().unwrap());
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
    let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    let expected = [
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
    for name in &expected {
        assert!(names.contains(name), "tool_list missing: {name}");
    }
    assert_eq!(
        names.len(),
        expected.len(),
        "unexpected extra tools in list"
    );
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
            def.name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
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
        assert!(seen.insert(def.name), "duplicate tool name: '{}'", def.name);
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
            let ann = def
                .annotations
                .as_ref()
                .unwrap_or_else(|| panic!("ReadOnly tool '{}' must have annotations", def.name));
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
            let ann = def
                .annotations
                .as_ref()
                .unwrap_or_else(|| panic!("Destructive tool '{}' must have annotations", def.name));
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
        assert!(
            j["name"].is_string(),
            "tool '{}' to_json missing 'name'",
            def.name
        );
        assert!(
            j["description"].is_string(),
            "tool '{}' to_json missing 'description'",
            def.name
        );
        assert!(
            j["inputSchema"].is_object(),
            "tool '{}' to_json missing 'inputSchema'",
            def.name
        );
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
    let ipc = MockIpc::new().on_post("/open", Ok(json!({ "ok": true })));
    // Use /tmp which is guaranteed to exist for canonicalize
    let resp = tool_open_file(id(1), &json!({ "path": "/tmp/mdopener-notes.md" }), &ipc);
    assert!(
        resp.error.is_none(),
        "unexpected RPC error: {:?}",
        resp.error
    );
    assert!(!is_error(&resp));
    let text = content_text(&resp);
    assert!(text["opened"].as_str().is_some());
}

/// The app answers `/open` once its window has tried to open the document;
/// a failure there reaches the agent as a tool error with the window's
/// reason, and is not retried through the URL scheme.
#[test]
fn open_file_reports_the_windows_failure() {
    let ipc = MockIpc::new().on_post(
        "/open",
        Ok(json!({
            "ok": false,
            "path": "/tmp/mdopener-notes.md",
            "error": "Could not read /tmp/mdopener-notes.md: Permission denied",
        })),
    );
    let resp = tool_open_file_with(
        id(1),
        &json!({ "path": "/tmp/mdopener-notes.md" }),
        &ipc,
        &|url: &str| panic!("must not fall back to the URL scheme: {url}"),
    );
    let text = tool_error_text(&resp);
    assert!(text.contains("Permission denied"), "{text}");
}

#[test]
fn open_file_mode_read_forwarded_in_post_body() {
    let ipc = MockIpc::new().on_post("/open", Ok(json!({ "ok": true })));
    let resp = tool_open_file(
        id(1),
        &json!({ "path": "/tmp/mdopener-notes.md", "mode": "read" }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let post = calls.iter().find(|(m, p, _)| m == "POST" && p == "/open");
    assert!(post.is_some(), "no POST /open call recorded");
    let body = post.unwrap().2.as_ref().unwrap();
    assert_eq!(body["mode"], json!("read"));
}

#[test]
fn open_file_mode_edit_forwarded_in_post_body() {
    let ipc = MockIpc::new().on_post("/open", Ok(json!({ "ok": true })));
    let resp = tool_open_file(
        id(1),
        &json!({ "path": "/tmp/mdopener-notes.md", "mode": "edit" }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/open")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert_eq!(body["mode"], json!("edit"));
}

/// Without `mode` the app keeps the window's current view, so the tool sends
/// none and its schema says so (it used to promise a `read` default).
#[test]
fn open_file_without_mode_keeps_the_current_view() {
    let ipc = MockIpc::new().on_post("/open", Ok(json!({ "ok": true })));
    let resp = tool_open_file(id(1), &json!({ "path": "/tmp/mdopener-notes.md" }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let (_, _, body) = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/open")
        .unwrap();
    assert_eq!(body.as_ref().unwrap()["mode"], Value::Null);
    let open_file = tool_registry()
        .into_iter()
        .find(|d| d.name == "open_file")
        .unwrap();
    let desc = open_file.input_schema["properties"]["mode"]["description"]
        .as_str()
        .unwrap();
    assert!(desc.contains("current view"), "{desc}");
    assert!(!desc.contains("Defaults to 'read'"), "{desc}");
}

/// A Markdown file that exists, for the URL-scheme fallback tests: with the
/// app unreachable, `open_file` refuses a missing file before launching.
fn existing_notes() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let notes = dir.path().join("notes.md");
    std::fs::write(&notes, "# Notes\n").unwrap();
    (dir, notes.to_string_lossy().into_owned())
}

// When IPC fails we fall through to the url-scheme launcher. The launcher is
// injected so no test ever starts a real OS launcher or GUI.
#[test]
fn open_file_ipc_failure_launches_url_scheme() {
    let (_dir, notes) = existing_notes();
    let ipc = MockIpc::new().on_post("/open", Err("ipc-port not found".into()));
    let seen = Mutex::new(Vec::<String>::new());
    let resp = tool_open_file_with(
        id(1),
        &json!({ "path": notes, "mode": "edit" }),
        &ipc,
        &|url| {
            seen.lock().unwrap().push(url.to_string());
            Launch::Opened {
                launcher: "xdg-open".into(),
            }
        },
    );
    assert!(ipc
        .calls()
        .iter()
        .any(|(m, p, _)| m == "POST" && p == "/open"));
    assert!(resp.error.is_none(), "{:?}", resp.error);
    let text = resp.result.as_ref().unwrap()["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(text.contains("url-scheme"), "{text}");
    let urls = seen.lock().unwrap();
    assert_eq!(urls.len(), 1);
    assert!(urls[0].starts_with("mdopener://open?path="), "{}", urls[0]);
    assert!(urls[0].ends_with("&mode=edit"), "{}", urls[0]);
}

#[test]
fn open_file_does_not_retry_through_the_url_scheme_when_the_app_was_reached() {
    // A 5xx or no answer in time comes from a running app that may still open
    // the file: falling back would report success wrongly or open it twice.
    let (_dir, notes) = existing_notes();
    for err in [
        "IPC server returned HTTP 500: lock poisoned",
        "IPC read error: Ashlr MD did not answer within 5 s",
    ] {
        let ipc = MockIpc::new().on_post("/open", Err(err.into()));
        let resp = tool_open_file_with(id(1), &json!({ "path": notes }), &ipc, &|url: &str| {
            panic!("must not fall back to the URL scheme: {url}")
        });
        let text = tool_error_text(&resp);
        assert!(text.contains("did not confirm opening"), "{text}");
        assert!(text.contains(err), "{text}");
    }
}

#[test]
fn open_file_headless_reports_no_launcher_honestly() {
    let (_dir, notes) = existing_notes();
    let ipc = MockIpc::new().on_post("/open", Err("ipc-port not found".into()));
    let resp = tool_open_file_with(id(1), &json!({ "path": notes }), &ipc, &|_| {
        Launch::NoLauncher {
            tried: vec!["xdg-open".into(), "gio".into()],
        }
    });
    let err = tool_error_text(&resp);
    assert!(err.contains("not running"), "{}", err);
    assert!(err.contains("xdg-open, gio"), "{}", err);
    assert!(err.contains("desktop session"), "{}", err);
}

#[test]
fn open_file_launcher_failure_is_an_error() {
    let (_dir, notes) = existing_notes();
    let ipc = MockIpc::new().on_post("/open", Err("ipc-port not found".into()));
    let resp = tool_open_file_with(id(1), &json!({ "path": notes }), &ipc, &|_| {
        Launch::Failed {
            launcher: "xdg-open".into(),
            code: Some(4),
        }
    });
    let err = tool_error_text(&resp);
    assert!(err.contains("status 4"), "{}", err);
}

#[test]
fn open_file_pending_launcher_is_unconfirmed_success() {
    let (_dir, notes) = existing_notes();
    let ipc = MockIpc::new().on_post("/open", Err("ipc-port not found".into()));
    let resp = tool_open_file_with(id(1), &json!({ "path": notes }), &ipc, &|_| {
        Launch::Pending {
            launcher: "xdg-open".into(),
        }
    });
    assert!(resp.error.is_none());
    let text = resp.result.as_ref().unwrap()["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        text.contains("\"confirmed\":false") || text.contains("\"confirmed\": false"),
        "{text}"
    );
}

// With the app unreachable nothing else refuses a missing file: the launcher
// would exit 0 and the tool would report an open the window cannot do.
#[test]
fn open_file_without_the_app_refuses_a_missing_file_before_launching() {
    let ipc = MockIpc::new().on_post("/open", Err("ipc-port not found".into()));
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("not-written-yet.md");
    let launched = Mutex::new(0);
    let resp = tool_open_file_with(
        id(1),
        &json!({ "path": missing.to_string_lossy() }),
        &ipc,
        &|_| {
            *launched.lock().unwrap() += 1;
            Launch::Opened {
                launcher: "xdg-open".into(),
            }
        },
    );
    let err = tool_error_text(&resp);
    assert!(err.contains("does not exist"), "{err}");
    assert_eq!(*launched.lock().unwrap(), 0, "launched the URL scheme");
}

#[test]
fn open_file_rejects_unknown_mode_before_any_launch() {
    let ipc = MockIpc::new();
    let resp = tool_open_file_with(
        id(1),
        &json!({ "path": "/tmp/mdopener-notes.md", "mode": "edit&path=/etc/passwd" }),
        &ipc,
        &|_| panic!("must not launch"),
    );
    assert_eq!(resp.error.unwrap().code, -32602);
    assert!(ipc.calls().is_empty());
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 2: get_current_content
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn get_current_content_returns_path_and_markdown() {
    let ipc = MockIpc::new().on_get(
        "/content",
        Ok(json!({
            "path": "/docs/notes.md",
            "content": "# Hello\nworld"
        })),
    );
    let resp = tool_get_content(id(1), &ipc);
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["path"], "/docs/notes.md");
    assert_eq!(text["content"], "# Hello\nworld");
}

#[test]
fn get_current_content_no_doc_open_returns_null_path() {
    let ipc = MockIpc::new().on_get("/content", Ok(json!({ "path": null, "content": "" })));
    let resp = tool_get_content(id(1), &ipc);
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert!(text["path"].is_null());
}

#[test]
fn get_current_content_ipc_unavailable_returns_tool_error() {
    let ipc = MockIpc::new().on_get("/content", Err("Could not connect to IPC server".into()));
    let resp = tool_get_content(id(1), &ipc);
    tool_error_text(&resp);
}

#[test]
fn get_current_content_stale_ipc_returns_error_with_hint() {
    let ipc = MockIpc::new().on_get(
        "/content",
        Err("ipc-port not found — is Ashlr MD running?".into()),
    );
    let resp = tool_get_content(id(1), &ipc);
    let err = tool_error_text(&resp);
    assert!(err.contains("Ashlr MD"), "error should mention app name");
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
    let ipc = MockIpc::new().on_post("/content", Ok(json!({ "ok": true })));
    let resp = tool_set_content(id(1), &json!({ "content": "# New doc" }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/content")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert_eq!(body["content"], "# New doc");
    assert_eq!(body["save"], json!(false)); // default
}

#[test]
fn set_content_save_true_persists() {
    let ipc = MockIpc::new().on_post("/content", Ok(json!({ "ok": true, "saved": true })));
    let resp = tool_set_content(id(1), &json!({ "content": "# Saved", "save": true }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/content")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert_eq!(body["save"], json!(true));
}

#[test]
fn set_content_large_content_not_truncated() {
    // >10 MB string — the handler must pass it through without truncating.
    let big = "x".repeat(11 * 1024 * 1024);
    let ipc = MockIpc::new().on_post("/content", Ok(json!({ "ok": true })));
    let resp = tool_set_content(id(1), &json!({ "content": big }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/content")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    let sent = body["content"].as_str().unwrap();
    assert_eq!(sent.len(), 11 * 1024 * 1024, "large content was truncated");
}

/// The app answers `/content` once the window has replaced the document (and
/// saved it when asked). A refusal must reach the agent as a tool error, not
/// as a success carrying `ok: false`.
#[test]
fn set_content_reports_a_failed_apply_or_save() {
    let ipc = MockIpc::new().on_post(
        "/content",
        Ok(json!({ "ok": false, "error": "Content replaced in the open document but not saved: Permission denied" })),
    );
    let resp = tool_set_content(id(1), &json!({ "content": "# X", "save": true }), &ipc);
    let err = tool_error_text(&resp);
    assert!(err.contains("not saved"), "{err}");
    assert!(err.contains("Permission denied"), "{err}");

    let resp = tool_replace_document(id(2), &json!({ "content": "# X", "save": true }), &ipc);
    let err = tool_error_text(&resp);
    assert!(err.contains("Permission denied"), "{err}");
}

#[test]
fn set_content_without_a_reason_still_fails() {
    let ipc = MockIpc::new().on_post("/content", Ok(json!({ "ok": false })));
    let resp = tool_set_content(id(1), &json!({ "content": "# X" }), &ipc);
    assert!(!tool_error_text(&resp).is_empty());
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 4: list_recent
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn list_recent_default_limit_is_10() {
    let ipc = MockIpc::new().on_get("/recent", Ok(json!({ "files": [] })));
    tool_list_recent(id(1), &json!({}), &ipc);
    let calls = ipc.calls();
    let path = &calls[0].1;
    assert!(
        path.contains("limit=10"),
        "default limit should be 10, got: {path}"
    );
}

#[test]
fn list_recent_custom_limit_clamped() {
    let ipc = MockIpc::new().on_get("/recent", Ok(json!({ "files": [] })));
    tool_list_recent(id(1), &json!({ "limit": 5 }), &ipc);
    let calls = ipc.calls();
    assert!(calls[0].1.contains("limit=5"));
}

#[test]
fn list_recent_returns_files_array() {
    let files = json!(["/a.md", "/b.md", "/c.md"]);
    let ipc = MockIpc::new().on_get("/recent", Ok(json!({ "files": files })));
    let resp = tool_list_recent(id(1), &json!({}), &ipc);
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["files"], files);
}

#[test]
fn list_recent_empty_returns_empty_array() {
    let ipc = MockIpc::new().on_get("/recent", Ok(json!({ "files": [] })));
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
    let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
    let resp = tool_export(id(1), &json!({ "format": "pdf" }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert_eq!(body["format"], "pdf");
    assert!(
        body["outputPath"].is_null(),
        "output_path should default to null"
    );
}

#[test]
fn export_docx_format_forwarded() {
    let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
    tool_export(id(1), &json!({ "format": "docx" }), &ipc);
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert_eq!(body["format"], "docx");
}

#[test]
fn export_html_with_output_path() {
    let dir = tempfile::tempdir().unwrap();
    let out = std::fs::canonicalize(dir.path()).unwrap().join("out.html");
    let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
    tool_export_with(
        id(1),
        &json!({ "format": "html", "output_path": out.to_string_lossy() }),
        &ipc,
        std::time::Duration::from_millis(50),
    );
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert_eq!(body["outputPath"], json!(out.to_string_lossy()));
}

#[test]
fn export_ipc_error_propagated() {
    let ipc = MockIpc::new().on_post("/export", Err("ipc-port not found".into()));
    let resp = tool_export(id(1), &json!({ "format": "pdf" }), &ipc);
    tool_error_text(&resp);
}

/// The app answers `{ "ok": false, "error" }` when it could not hand the
/// export to its window; the tool read any reply as accepted and reported
/// the export dialog as shown.
#[test]
fn export_reports_the_apps_ok_false_reply() {
    let reason = "The app could not reach its window: window closed";
    let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": false, "error": reason })));
    let msg = tool_error_text(&tool_export(id(1), &json!({ "format": "pdf" }), &ipc));
    assert!(msg.contains(reason), "{msg}");
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
    let ipc = MockIpc::new().on_post("/edit", Ok(json!({ "ok": true, "replaced": 1 })));
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
    let ipc = MockIpc::new().on_post(
        "/edit",
        Ok(json!({
            "ok": false,
            "error": "find string appears 2 times — must be unique"
        })),
    );
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
    let ipc = MockIpc::new().on_post("/edit", Ok(json!({ "ok": true, "replaced": 1 })));
    tool_edit_document(
        id(1),
        &json!({ "find": "x", "replace": "y", "save": true }),
        &ipc,
    );
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/edit")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert_eq!(body["save"], json!(true));
}

#[test]
fn edit_document_ipc_error_propagated() {
    let ipc = MockIpc::new().on_post("/edit", Err("Could not connect to IPC server".into()));
    let resp = tool_edit_document(id(1), &json!({ "find": "x", "replace": "y" }), &ipc);
    tool_error_text(&resp);
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
    let ipc = MockIpc::new().on_post("/content", Ok(json!({ "ok": true })));
    let new_content = "# Full replacement\nAll new content.";
    let resp = tool_replace_document(id(1), &json!({ "content": new_content }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/content")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert_eq!(body["content"], new_content);
    assert_eq!(body["save"], json!(false));
}

#[test]
fn replace_document_save_true_triggers_persistence() {
    let ipc = MockIpc::new().on_post("/content", Ok(json!({ "ok": true })));
    tool_replace_document(id(1), &json!({ "content": "# Doc", "save": true }), &ipc);
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/content")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
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
    let ipc = MockIpc::new().on_get(
        "/search",
        Ok(json!({
            "results": [
                { "path": "/vault/a.md", "score": 0.9, "snippet": "hello world" }
            ]
        })),
    );
    let resp = tool_search_vault(id(1), &json!({ "query": "hello world" }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let path = &calls[0].1;
    assert!(
        path.contains("hello%20world") || path.contains("hello+world"),
        "query should be URL-encoded, got: {path}"
    );
}

#[test]
fn search_vault_default_limit_is_50() {
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    tool_search_vault(id(1), &json!({ "query": "x" }), &ipc);
    let calls = ipc.calls();
    assert!(
        calls[0].1.contains("limit=50"),
        "default limit should be 50, got: {}",
        calls[0].1
    );
}

#[test]
fn search_vault_custom_limit() {
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    tool_search_vault(id(1), &json!({ "query": "x", "limit": 5 }), &ipc);
    let calls = ipc.calls();
    assert!(calls[0].1.contains("limit=5"));
}

#[test]
fn search_vault_empty_results_returned() {
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
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
    let ipc = MockIpc::new().on_post("/review", Ok(json!({ "ok": true })));
    let resp = tool_request_review(
        id(1),
        &json!({ "content": "# Plan\nStep 1.", "blocking": false }),
        &ipc,
    );
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["status"], "pending");
    // reviewId should be present and non-empty
    assert!(text["reviewId"]
        .as_str()
        .map(|s| !s.is_empty())
        .unwrap_or(false));
    // It says how to get the verdict: get_user_annotations cannot find a
    // review of inline content, which has no path.
    assert!(
        text["message"].as_str().unwrap().contains("review_id"),
        "{text}"
    );
}

/// A review whose file the window could not open is refused with the
/// window's reason, blocking or not, instead of waiting on a review the
/// human never sees.
#[test]
fn request_review_reports_a_file_the_app_could_not_open() {
    let dir = tempfile::tempdir().unwrap();
    let plan = dir.path().join("plan.md");
    std::fs::write(&plan, "# Plan").unwrap();
    for blocking in [false, true] {
        let ipc = MockIpc::new().on_post(
            "/review",
            Ok(json!({ "ok": false, "error": "Could not read plan.md: Permission denied" })),
        );
        let resp = tool_request_review(
            id(1),
            &json!({ "path": plan.to_str().unwrap(), "blocking": blocking }),
            &ipc,
        );
        let text = tool_error_text(&resp);
        assert!(text.contains("Permission denied"), "{text}");
        let calls = ipc.calls();
        let polled = calls.iter().any(|(_, p, _)| p.starts_with("/review/"));
        assert!(!polled, "no poll for a review that was never registered");
    }
}

#[test]
fn request_review_ipc_down_returns_error() {
    let ipc = MockIpc::new().on_post("/review", Err("ipc-port not found".into()));
    let resp = tool_request_review(
        id(1),
        &json!({ "content": "# Plan", "blocking": false }),
        &ipc,
    );
    tool_error_text(&resp);
}

#[test]
fn request_review_timeout_ms_out_of_range_is_refused_not_clamped() {
    // Clamping silently gave the agent a window it did not ask for.
    for bad in [
        json!(100),
        json!(4_999),
        json!(600_001),
        json!(-1),
        json!(1.5),
        json!("60000"),
    ] {
        let ipc = MockIpc::new().on_post("/review", Ok(json!({ "ok": true })));
        let resp = tool_request_review(
            id(1),
            &json!({ "content": "x", "blocking": false, "timeout_ms": bad }),
            &ipc,
        );
        let err = resp.error.expect("out-of-range timeout_ms must be refused");
        assert_eq!(err.code, -32602);
        assert!(
            err.message.contains("between 5000 and 600000"),
            "{bad}: {}",
            err.message
        );
        assert!(
            !ipc.calls()
                .iter()
                .any(|(m, p, _)| m == "POST" && p == "/review"),
            "no review may be registered for {bad}"
        );
    }
}

#[test]
fn request_review_timeout_ms_at_the_bounds_is_passed_through() {
    for ok in [5_000u64, 600_000] {
        let ipc = MockIpc::new().on_post("/review", Ok(json!({ "ok": true })));
        let resp = tool_request_review(
            id(1),
            &json!({ "content": "x", "blocking": false, "timeout_ms": ok }),
            &ipc,
        );
        assert!(resp.error.is_none(), "{:?}", resp.error);
        let calls = ipc.calls();
        let body = calls
            .iter()
            .find(|(m, p, _)| m == "POST" && p == "/review")
            .unwrap()
            .2
            .as_ref()
            .unwrap();
        assert_eq!(body["timeoutMs"], json!(ok));
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Tool 10: present_document
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn present_document_no_path_uses_current_doc() {
    let ipc = MockIpc::new().on_post("/present", Ok(json!({ "ok": true })));
    let resp = tool_present_document(id(1), &json!({}), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/present")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert!(body["path"].is_null(), "path should be null when omitted");
}

#[test]
fn present_document_with_path_sends_canonicalized() {
    let ipc = MockIpc::new().on_post("/present", Ok(json!({ "ok": true })));
    let resp = tool_present_document(id(1), &json!({ "path": "/tmp/mdopener-notes.md" }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/present")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    // Should have received a non-null path
    assert!(!body["path"].is_null(), "path should be set");
}

#[test]
fn present_document_reports_the_windows_failure() {
    let ipc = MockIpc::new().on_post(
        "/present",
        Ok(json!({ "ok": false, "error": "Could not read /tmp/x.md: No such file" })),
    );
    let text = tool_error_text(&tool_present_document(id(1), &json!({}), &ipc));
    assert!(text.contains("No such file"), "{text}");

    let ipc = MockIpc::new().on_post("/present", Ok(json!({ "ok": false })));
    let text = tool_error_text(&tool_present_document(id(1), &json!({}), &ipc));
    assert!(
        text.contains("could not present the open document"),
        "{text}"
    );
}

#[test]
fn present_document_ipc_error_propagated() {
    let ipc = MockIpc::new().on_post("/present", Err("Could not connect to IPC server".into()));
    let resp = tool_present_document(id(1), &json!({}), &ipc);
    tool_error_text(&resp);
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
    let ipc = MockIpc::new().on_get(
        "/annotations",
        Ok(json!({
            "highlights": [{ "line": 3, "text": "important" }],
            "comments": [{ "line": 5, "comment": "check this" }],
            "bookmarks": [10]
        })),
    );
    let resp = tool_get_annotations(id(1), &json!({ "path": "/vault/doc.md" }), &ipc);
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert!(text["highlights"].is_array());
    assert!(text["comments"].is_array());
    assert!(text["bookmarks"].is_array());
}

#[test]
fn get_user_annotations_path_url_encoded_in_request() {
    let ipc = MockIpc::new().on_get("/annotations", Ok(json!({ "highlights": [] })));
    tool_get_annotations(id(1), &json!({ "path": "/vault/my doc.md" }), &ipc);
    let calls = ipc.calls();
    let path = &calls[0].1;
    // Space must be percent-encoded
    assert!(
        path.contains("%20") || path.contains("+"),
        "path should be URL-encoded, got: {path}"
    );
}

#[test]
fn get_user_annotations_ipc_error_propagated() {
    let ipc = MockIpc::new().on_get("/annotations", Err("ipc-port not found".into()));
    let resp = tool_get_annotations(id(1), &json!({ "path": "/x.md" }), &ipc);
    tool_error_text(&resp);
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

fn call(name: &str, arguments: Value, ipc: &MockIpc) -> mdopener_mcp::Response {
    let req = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(7)),
        method: "tools/call".into(),
        params: Some(json!({ "name": name, "arguments": arguments })),
    };
    dispatch(req, ipc).unwrap()
}

#[test]
fn dispatch_tools_call_failing_tool_returns_is_error_result() {
    // App not reachable: an execution failure, not a protocol error.
    let ipc = MockIpc::new().on_get("/content", Err("ipc-port not found".into()));
    let resp = call("get_current_content", json!({}), &ipc);
    assert_eq!(resp.id, json!(7));
    let text = tool_error_text(&resp);
    assert!(text.contains("Ashlr MD"), "{text}");

    // A path that does not exist: also an execution failure the agent can fix.
    let missing = "/definitely/not/here/ashlr-md-missing.md";
    let resp = call(
        "diff_documents",
        json!({ "path_a": missing, "path_b": missing }),
        &ipc,
    );
    let text = tool_error_text(&resp);
    assert!(text.contains(missing), "{text}");
}

#[test]
fn dispatch_tools_call_missing_required_arg_stays_invalid_params() {
    let ipc = MockIpc::new();
    let resp = call("open_file", json!({}), &ipc);
    assert!(resp.result.is_none());
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
    assert_eq!(
        actions.len(),
        12,
        "expected 12 AI actions, got {}",
        actions.len()
    );
    assert_eq!(text["count"], json!(12));
}

#[test]
fn list_ai_actions_every_action_has_required_fields() {
    let resp = tool_list_ai_actions(id(1), &json!({}));
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    for action in actions {
        assert!(
            action["id"].is_string(),
            "action missing 'id': {:?}",
            action
        );
        assert!(
            action["label"].is_string(),
            "action '{}' missing 'label'",
            action["id"]
        );
        assert!(
            action["shortLabel"].is_string(),
            "action '{}' missing 'shortLabel'",
            action["id"]
        );
        assert!(
            action["icon"].is_string(),
            "action '{}' missing 'icon'",
            action["id"]
        );
        assert!(
            action["scope"].is_string(),
            "action '{}' missing 'scope'",
            action["id"]
        );
        assert!(
            action["systemPrompt"].is_string(),
            "action '{}' missing 'systemPrompt'",
            action["id"]
        );
        assert!(
            action["userPromptTemplate"].is_string(),
            "action '{}' missing 'userPromptTemplate'",
            action["id"]
        );
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
        assert!(
            seen.insert(aid.to_string()),
            "duplicate action id: '{}'",
            aid
        );
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
    assert_eq!(
        actions.len(),
        12,
        "count should still be 12 with include_prompts=false"
    );
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
    let ids: Vec<&str> = actions.iter().filter_map(|a| a["id"].as_str()).collect();
    // The 9 selection-scoped actions from actions.ts
    for expected in &[
        "explain",
        "summarize",
        "rewrite",
        "fix-grammar",
        "concise",
        "expand",
        "explain-diff",
        "translate",
        "tldr",
    ] {
        assert!(
            ids.contains(expected),
            "missing selection action '{}'",
            expected
        );
    }
}

#[test]
fn list_ai_actions_contains_expected_document_actions() {
    let resp = tool_list_ai_actions(id(1), &json!({}));
    let text = content_text(&resp);
    let actions = text["actions"].as_array().unwrap();
    let doc_ids: Vec<&str> = actions
        .iter()
        .filter(|a| a["scope"].as_str() == Some("document"))
        .filter_map(|a| a["id"].as_str())
        .collect();
    for expected in &["doc-summarize", "doc-outline", "doc-explain-selection"] {
        assert!(
            doc_ids.contains(expected),
            "missing document action '{}'",
            expected
        );
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

    assert_eq!(
        raw_count, resp_count,
        "ai_actions_registry() has {raw_count} entries but tool response has {resp_count}"
    );
}

// ════════════════════════════════════════════════════════════════════════════
// app_not_running_msg formatting
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn app_not_running_msg_ipc_port_error_includes_hint() {
    let msg = mdopener_mcp::app_not_running_msg("ipc-port not found — is Ashlr MD running?");
    assert!(msg.contains("Ashlr MD"), "hint should mention app name");
    assert!(
        msg.contains("open_file"),
        "hint should mention open_file tool"
    );
}

#[test]
fn app_not_running_msg_connect_error_includes_hint() {
    let msg =
        mdopener_mcp::app_not_running_msg("Could not connect to IPC server at 127.0.0.1:8080");
    assert!(msg.contains("Ashlr MD"));
}

#[test]
fn app_not_running_msg_other_error_passthrough() {
    let msg = mdopener_mcp::app_not_running_msg("IPC auth failed: token mismatch");
    // Should pass through unchanged for non-connectivity errors
    assert_eq!(msg, "IPC auth failed: token mismatch");
}

#[test]
fn app_not_running_msg_keeps_the_apps_refusal() {
    // The running app refused the request; its reason names a file whose path
    // happens to contain "connect" / "not found". That is not an app-down error.
    for refusal in [
        "IPC server returned HTTP 400: Cannot open '/notes/connections.md': the file does not exist.",
        "IPC server returned HTTP 400: Cannot open '/notes/not found.md': the file does not exist.",
    ] {
        assert_eq!(mdopener_mcp::app_not_running_msg(refusal), refusal);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Export tool — comprehensive IPC integration tests
// ════════════════════════════════════════════════════════════════════════════
//
// These tests exercise the full export tool dispatch path:
//   MCP tool call → tool_export() → IPC POST /export → agent response
// No running Ashlr MD app is required — MockIpc intercepts every IPC call.

use mdopener_mcp::handle_resource_read;
use mdopener_mcp::handle_resources_list;

// ── Successful export scenarios ───────────────────────────────────────────────

#[test]
fn export_tool_pdf_success_returns_ok_result() {
    let ipc = MockIpc::new().on_post(
        "/export",
        Ok(json!({
            "ok": true,
            "path": "/home/user/my-doc.pdf",
            "format": "pdf"
        })),
    );
    let resp = tool_export(id(1), &json!({ "format": "pdf" }), &ipc);
    assert!(
        resp.error.is_none(),
        "should not have RPC error: {:?}",
        resp.error
    );
    assert!(!is_error(&resp), "isError should be false on success");
    let text = content_text(&resp);
    assert_eq!(text["ok"], json!(true));
}

#[test]
fn export_tool_docx_success_returns_ok_result() {
    let ipc = MockIpc::new().on_post(
        "/export",
        Ok(json!({ "ok": true, "path": "/tmp/doc.docx" })),
    );
    let resp = tool_export(id(2), &json!({ "format": "docx" }), &ipc);
    assert!(resp.error.is_none());
    assert!(!is_error(&resp));
}

#[test]
fn export_tool_html_success_returns_ok_result() {
    let ipc = MockIpc::new().on_post(
        "/export",
        Ok(json!({ "ok": true, "path": "/tmp/doc.html" })),
    );
    let resp = tool_export(id(3), &json!({ "format": "html" }), &ipc);
    assert!(resp.error.is_none());
    assert!(!is_error(&resp));
}

// ── output_path is honored ────────────────────────────────────────────────────

#[test]
fn export_tool_output_path_forwarded_to_ipc() {
    let dir = tempfile::tempdir().unwrap();
    let out = std::fs::canonicalize(dir.path()).unwrap().join("out.docx");
    let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
    tool_export_with(
        id(10),
        &json!({ "format": "docx", "output_path": out.to_string_lossy() }),
        &ipc,
        std::time::Duration::from_millis(50),
    );
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .expect("POST /export not called")
        .2
        .as_ref()
        .unwrap();
    assert_eq!(
        body["outputPath"],
        json!(out.to_string_lossy()),
        "output_path must be forwarded as outputPath"
    );
}

#[test]
fn export_tool_html_with_output_path_forwarded() {
    let dir = tempfile::tempdir().unwrap();
    let out = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("export.html");
    let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
    tool_export_with(
        id(11),
        &json!({ "format": "html", "output_path": out.to_string_lossy() }),
        &ipc,
        std::time::Duration::from_millis(50),
    );
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert_eq!(body["outputPath"], json!(out.to_string_lossy()));
    assert_eq!(body["format"], "html");
}

#[test]
fn export_tool_no_output_path_sends_null() {
    let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
    tool_export(id(12), &json!({ "format": "pdf" }), &ipc);
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert!(
        body["outputPath"].is_null(),
        "missing output_path should be sent as null, got {:?}",
        body["outputPath"]
    );
}

// ── No theme argument ─────────────────────────────────────────────────────────

/// The app exports in its current theme and has no way to take another, so
/// the tool must not offer a `theme` it would silently ignore.
#[test]
fn export_tool_offers_no_theme() {
    let def = tool_registry()
        .into_iter()
        .find(|d| d.name == "export")
        .unwrap();
    assert!(def.input_schema["properties"]["theme"].is_null());
    assert!(!def.description.contains("theme`"), "{}", def.description);

    let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
    let resp = tool_export(id(20), &json!({ "format": "html" }), &ipc);
    assert!(resp.error.is_none());
    let calls = ipc.calls();
    let body = calls
        .iter()
        .find(|(m, p, _)| m == "POST" && p == "/export")
        .unwrap()
        .2
        .as_ref()
        .unwrap();
    assert!(body.get("theme").is_none(), "{body}");
}

/// A `theme` from a caller written against the old schema is refused rather
/// than ignored, so it never believes a sepia or midnight export happened.
#[test]
fn export_tool_refuses_a_theme() {
    let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
    let resp = tool_export(id(23), &json!({ "format": "html", "theme": "sepia" }), &ipc);
    let err = resp.error.expect("a theme must be refused");
    assert_eq!(err.code, -32602);
    assert!(err.message.contains("current theme"), "{}", err.message);
    assert!(ipc.calls().is_empty(), "nothing is sent to the app");
}

// ── File-write error propagation ──────────────────────────────────────────────

#[test]
fn export_tool_file_write_error_becomes_tool_error() {
    let ipc = MockIpc::new().on_post("/export", Err("ipc-port not found".into()));
    let resp = tool_export(id(30), &json!({ "format": "pdf" }), &ipc);
    tool_error_text(&resp);
}

#[test]
fn export_tool_permission_denied_error_propagated() {
    let ipc = MockIpc::new().on_post("/export", Err("Permission denied: /root/secret.pdf".into()));
    let resp = tool_export(id(31), &json!({ "format": "pdf" }), &ipc);
    // The error message must surface enough detail for the agent to understand.
    assert!(!tool_error_text(&resp).is_empty());
}

#[test]
fn export_tool_disk_full_error_propagated() {
    let ipc = MockIpc::new().on_post("/export", Err("No space left on device".into()));
    let resp = tool_export(id(32), &json!({ "format": "pdf" }), &ipc);
    tool_error_text(&resp);
}

#[test]
fn export_tool_app_not_running_returns_descriptive_error() {
    let ipc = MockIpc::new().on_post(
        "/export",
        Err("ipc-port not found — is Ashlr MD running?".into()),
    );
    let resp = tool_export(id(33), &json!({ "format": "html" }), &ipc);
    let err = tool_error_text(&resp);
    // app_not_running_msg should enrich the message.
    assert!(
        err.contains("Ashlr MD"),
        "error should name the app, got: {}",
        err
    );
}

// ── Unsupported / unknown format ──────────────────────────────────────────────
// The app's export handler does not reject unknown formats: it falls through
// to an HTML export and reports ok. So this layer validates the format and
// refuses anything else before a request reaches the app.

// ── Missing required param ────────────────────────────────────────────────────

#[test]
fn export_tool_missing_format_returns_param_error() {
    let ipc = MockIpc::new();
    let resp = tool_export(id(50), &json!({}), &ipc);
    assert_eq!(
        resp.error.as_ref().unwrap().code,
        -32602,
        "missing format must return -32602"
    );
    // No IPC call should have been made.
    assert!(
        ipc.calls().is_empty(),
        "no IPC call should be made for a param error"
    );
}

#[test]
fn export_tool_rejects_unknown_format_without_ipc() {
    // The app's handler turns any unknown format into an HTML export and
    // reports ok, so the server must refuse it before the request is sent.
    for format in &["xyz", "PDF", "md"] {
        let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
        let resp = tool_export(
            id(51),
            &json!({ "format": format, "output_path": "/tmp/o.pdf" }),
            &ipc,
        );
        let err = resp
            .error
            .as_ref()
            .unwrap_or_else(|| panic!("{format} must be refused"));
        assert_eq!(err.code, -32602, "{format}");
        assert!(
            err.message.contains("pdf/docx/html/epub"),
            "{format}: {}",
            err.message
        );
        assert!(
            ipc.calls().is_empty(),
            "{format}: no IPC call should be made"
        );
    }
}

// ── Format field is present in every IPC POST body ───────────────────────────

#[test]
fn export_tool_format_always_in_ipc_body() {
    for format in &["pdf", "docx", "html", "epub"] {
        let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
        tool_export(id(60), &json!({ "format": format }), &ipc);
        let calls = ipc.calls();
        let body = calls
            .iter()
            .find(|(m, p, _)| m == "POST" && p == "/export")
            .unwrap_or_else(|| panic!("no POST /export for format={format}"))
            .2
            .as_ref()
            .unwrap();
        assert_eq!(
            body["format"],
            json!(*format),
            "format must be forwarded for {format}"
        );
    }
}

// ── export:current resource (not served by the app) ──────────────────────────
//
// The app has no `/export/preview` IPC route, so the resource is not listed
// and reading it fails fast with a clear error instead of an HTTP 404.

fn dispatch_req(method: &str, params: Value) -> Request {
    Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(99)),
        method: method.into(),
        params: Some(params),
    }
}

#[test]
fn resources_list_omits_export_current() {
    let ipc = MockIpc::new();
    let resp = dispatch(dispatch_req("resources/list", json!({})), &ipc).unwrap();
    let uris: Vec<&str> = resp.result.as_ref().unwrap()["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["uri"].as_str())
        .collect();
    assert!(
        !uris.contains(&"export:current"),
        "export:current must not be listed: {uris:?}"
    );
    assert!(uris.contains(&"mdopener://current"));
}

#[test]
fn resource_read_export_current_fails_fast_without_ipc() {
    let ipc = MockIpc::new().on_get("/export/preview", Ok(json!({ "html": "<h1>stale</h1>" })));
    let resp = dispatch(
        dispatch_req("resources/read", json!({ "uri": "export:current" })),
        &ipc,
    )
    .unwrap();
    let err = resp.error.expect("export:current must return an error");
    assert_eq!(err.code, -32002);
    assert!(
        err.message.contains("not available"),
        "got: {}",
        err.message
    );
    assert!(
        err.message.contains("mdopener://current"),
        "must name an alternative: {}",
        err.message
    );
    assert!(!err.message.contains("404"));
    assert!(
        ipc.calls().is_empty(),
        "must not call the IPC server: {:?}",
        ipc.calls()
    );
}

// ════════════════════════════════════════════════════════════════════════════
// Semantic search — IPC POST /search endpoint + semantic engine helpers
// ════════════════════════════════════════════════════════════════════════════

use mdopener_mcp::{
    best_snippet_for_query, canonicalize_path, cosine_similarity, grep_vault, vault_file_paths,
    SearchResult,
};

// ── cosine_similarity ─────────────────────────────────────────────────────────

#[test]
fn cosine_similarity_identical_vectors_returns_one() {
    let v = vec![1.0_f64, 2.0, 3.0];
    let sim = cosine_similarity(&v, &v);
    assert!(
        (sim - 1.0).abs() < 1e-9,
        "identical vectors should have similarity 1.0, got {sim}"
    );
}

#[test]
fn cosine_similarity_orthogonal_vectors_returns_zero() {
    let a = vec![1.0_f64, 0.0, 0.0];
    let b = vec![0.0_f64, 1.0, 0.0];
    let sim = cosine_similarity(&a, &b);
    assert!(
        (sim - 0.0).abs() < 1e-9,
        "orthogonal vectors should have similarity 0.0, got {sim}"
    );
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
    assert!(
        snippet.contains("needle"),
        "snippet should contain the matched text"
    );
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
    assert_eq!(
        line_no, 3,
        "fallback should return first non-empty line (3)"
    );
    assert!(
        !snippet.is_empty(),
        "snippet should not be empty on fallback"
    );
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
    assert!(
        snippet.len() <= 200,
        "snippet should be capped at 200 chars, got {}",
        snippet.len()
    );
}

// ── canonicalize_path ─────────────────────────────────────────────────────────

#[test]
fn canonicalize_path_real_path_resolves() {
    // /tmp is a known-real path on macOS/Linux.
    let result = canonicalize_path("/tmp");
    // On macOS /tmp → /private/tmp; on Linux stays /tmp.  Either way it must
    // be non-empty and absolute.
    assert!(!result.is_empty(), "canonicalized path must not be empty");
    assert!(
        result.starts_with('/'),
        "canonicalized path must be absolute"
    );
}

#[test]
fn canonicalize_path_nonexistent_returns_input() {
    let input = "/nonexistent/path/that/does/not/exist/at/all";
    let result = canonicalize_path(input);
    assert_eq!(
        result, input,
        "non-existent path should pass through unchanged"
    );
}

// ── vault_file_paths ─────────────────────────────────────────────────────────

#[test]
fn vault_file_paths_returns_files_and_recents() {
    let ipc = MockIpc::new().on_get(
        "/vault",
        Ok(json!({
            "files": [
                { "path": "/vault/a.md", "name": "a.md" },
                { "path": "/vault/b.md", "name": "b.md" }
            ],
            "recents": ["/recent/c.md"]
        })),
    );
    let paths = vault_file_paths(&ipc).expect("vault list");
    // All three paths should be present (after canonicalization attempt).
    assert!(
        paths.iter().any(|p| p.contains("a.md")),
        "a.md should be in paths"
    );
    assert!(
        paths.iter().any(|p| p.contains("b.md")),
        "b.md should be in paths"
    );
    assert!(
        paths.iter().any(|p| p.contains("c.md")),
        "c.md from recents should be in paths"
    );
}

#[test]
fn vault_file_paths_deduplicates_recents_already_in_files() {
    let ipc = MockIpc::new().on_get(
        "/vault",
        Ok(json!({
            "files": [{ "path": "/vault/a.md", "name": "a.md" }],
            "recents": ["/vault/a.md"]
        })),
    );
    let paths = vault_file_paths(&ipc).expect("vault list");
    let count = paths.iter().filter(|p| p.contains("a.md")).count();
    assert_eq!(count, 1, "duplicate path should appear only once");
}

#[test]
fn vault_file_paths_ipc_error_is_an_error() {
    // An empty list would make an app that is down look like "no matches".
    let ipc = MockIpc::new().on_get("/vault", Err("ipc-port not found".into()));
    let err = vault_file_paths(&ipc).expect_err("IPC error must propagate");
    assert!(err.contains("ipc-port not found"), "{err}");
}

// ── grep_vault ────────────────────────────────────────────────────────────────

#[test]
fn grep_vault_without_vault_list_is_an_error() {
    // IPC unavailable → no vault file list → error, not an empty result set.
    let ipc = MockIpc::new().on_get("/vault", Err("ipc-port not found".into()));
    assert!(grep_vault("anything", 50, &ipc).is_err());
}

#[test]
fn grep_vault_empty_vault_returns_empty() {
    let ipc = MockIpc::new().on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
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

    let ipc = MockIpc::new().on_get(
        "/vault",
        Ok(json!({
            "files": [{ "path": path, "name": "test.md" }],
            "recents": []
        })),
    );
    let results = grep_vault("quarterly", 50, &ipc).expect("grep_vault ok");
    assert!(!results.is_empty(), "should find match for 'quarterly'");
    let first = &results[0];
    assert!(!first["path"].as_str().unwrap().is_empty());
    assert!(first["snippet"].as_str().unwrap().contains("quarterly"));
    assert!(first["score"].as_f64().unwrap() > 0.0);
}

#[test]
fn grep_vault_no_match_returns_empty() {
    use std::io::Write;
    let mut f = tempfile::NamedTempFile::new().expect("tempfile");
    writeln!(f, "# Notes\nSome content here.").unwrap();
    let path = f.path().to_str().unwrap().to_string();

    let ipc = MockIpc::new().on_get(
        "/vault",
        Ok(json!({
            "files": [{ "path": path, "name": "test.md" }],
            "recents": []
        })),
    );
    let results = grep_vault("xyz_never_matches_zzz", 50, &ipc).expect("grep_vault ok");
    assert!(results.is_empty(), "no match should return empty results");
}

#[test]
fn grep_vault_results_sorted_by_score_descending() {
    use std::io::Write;
    // File A: query appears once in 10 lines → low density.
    let mut fa = tempfile::NamedTempFile::new().unwrap();
    for i in 0..9 {
        writeln!(fa, "line {i}").unwrap();
    }
    writeln!(fa, "found the needle here").unwrap();
    let path_a = fa.path().to_str().unwrap().to_string();

    // File B: query appears in every line → high density.
    let mut fb = tempfile::NamedTempFile::new().unwrap();
    for _ in 0..5 {
        writeln!(fb, "needle needle needle").unwrap();
    }
    let path_b = fb.path().to_str().unwrap().to_string();

    let ipc = MockIpc::new().on_get(
        "/vault",
        Ok(json!({
            "files": [
                { "path": path_a.clone(), "name": "a.md" },
                { "path": path_b.clone(), "name": "b.md" }
            ],
            "recents": []
        })),
    );
    let results = grep_vault("needle", 50, &ipc).expect("grep_vault ok");
    assert_eq!(results.len(), 2, "both files should match");
    let score_first = results[0]["score"].as_f64().unwrap();
    let score_second = results[1]["score"].as_f64().unwrap();
    assert!(
        score_first >= score_second,
        "results must be sorted descending by score"
    );
}

#[test]
fn grep_vault_respects_limit() {
    use std::io::Write;
    let ipc_files: Vec<Value> = (0..10)
        .map(|i| {
            let mut f = tempfile::NamedTempFile::new().unwrap();
            writeln!(f, "line with keyword here").unwrap();
            // Keep file alive by leaking — acceptable in test context.
            let path = f.path().to_str().unwrap().to_string();
            std::mem::forget(f);
            json!({ "path": path, "name": format!("f{i}.md") })
        })
        .collect();

    let ipc = MockIpc::new().on_get("/vault", Ok(json!({ "files": ipc_files, "recents": [] })));
    let results = grep_vault("keyword", 3, &ipc).expect("grep_vault ok");
    assert!(
        results.len() <= 3,
        "limit=3 must cap results to 3, got {}",
        results.len()
    );
}

// ── tool_search_vault with semantic=false forces grep path ───────────────────

#[test]
fn search_vault_semantic_false_uses_ipc_grep() {
    // With semantic=false the tool must call /search IPC endpoint (grep mode).
    let ipc = MockIpc::new().on_get(
        "/search",
        Ok(json!({
            "results": [
                { "path": "/vault/a.md", "score": 0.8, "snippet": "hello world", "lineNumber": 3 }
            ]
        })),
    );
    let resp = tool_search_vault(
        id(200),
        &json!({ "query": "hello", "semantic": false }),
        &ipc,
    );
    assert!(resp.error.is_none(), "unexpected error: {:?}", resp.error);
    let text = content_text(&resp);
    // Mode should indicate grep.
    let mode = text["mode"].as_str().unwrap_or("");
    assert!(
        mode == "grep" || mode == "grep-local",
        "semantic=false should use grep mode, got mode={mode}"
    );
}

#[test]
fn search_vault_semantic_false_ipc_down_falls_back_to_local_grep() {
    use std::io::Write;
    let mut f = tempfile::NamedTempFile::new().unwrap();
    writeln!(f, "# Notes\nThis mentions the target topic explicitly.").unwrap();
    let path = f.path().to_str().unwrap().to_string();

    // /search IPC fails; /vault succeeds so local grep can run.
    let ipc = MockIpc::new()
        .on_get(
            "/vault",
            Ok(json!({
                "files": [{ "path": path, "name": "notes.md" }],
                "recents": []
            })),
        )
        .on_get("/search", Err("ipc-port not found".into()));

    let resp = tool_search_vault(
        id(201),
        &json!({ "query": "target topic", "semantic": false }),
        &ipc,
    );
    assert!(
        resp.error.is_none(),
        "local grep fallback should succeed: {:?}",
        resp.error
    );
    let text = content_text(&resp);
    assert_eq!(
        text["mode"].as_str().unwrap_or(""),
        "grep-local",
        "should fall back to grep-local when IPC is down"
    );
    let results = text["results"].as_array().expect("results must be array");
    assert!(!results.is_empty(), "local grep should find the match");
}

#[test]
fn search_vault_semantic_true_with_ollama_down_says_it_fell_back() {
    // Only meaningful when nothing listens on Ollama's port.
    if mdopener_mcp::ollama_available() {
        return;
    }
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({ "files": [], "recents": [] })))
        .on_get(
            "/search",
            Ok(json!({
                "results": [
                    { "path": "/vault/a.md", "score": 0.8, "snippet": "hello", "lineNumber": 1 }
                ]
            })),
        );
    let resp = tool_search_vault(
        id(202),
        &json!({ "query": "hello", "semantic": true }),
        &ipc,
    );
    assert!(resp.error.is_none(), "unexpected error: {:?}", resp.error);
    let text = content_text(&resp);
    assert_eq!(text["mode"].as_str(), Some("grep"));
    let note = text["note"]
        .as_str()
        .expect("a fallback must be explained in words");
    assert!(
        note.contains("Semantic search was unavailable"),
        "note: {note}"
    );
    assert!(note.contains("keyword"), "note: {note}");
}

#[test]
fn search_vault_semantic_false_has_no_fallback_note() {
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    let resp = tool_search_vault(
        id(203),
        &json!({ "query": "hello", "semantic": false }),
        &ipc,
    );
    let text = content_text(&resp);
    assert!(text.get("note").is_none(), "no fallback happened: {text}");
}

#[test]
fn search_vault_surfaces_the_apps_refusal_alongside_local_grep() {
    use std::io::Write;
    let mut f = tempfile::NamedTempFile::new().unwrap();
    writeln!(f, "# Notes\nThe target topic is here.").unwrap();
    let path = f.path().to_str().unwrap().to_string();
    let reason = "IPC server returned HTTP 403: search is disabled";
    let ipc = MockIpc::new()
        .on_get(
            "/vault",
            Ok(json!({ "files": [{ "path": path }], "recents": [] })),
        )
        .on_get("/search", Err(reason.into()));
    let resp = tool_search_vault(
        id(204),
        &json!({ "query": "target topic", "semantic": false }),
        &ipc,
    );
    assert!(resp.error.is_none(), "unexpected error: {:?}", resp.error);
    let text = content_text(&resp);
    assert_eq!(text["mode"].as_str(), Some("grep-local"));
    let note = text["note"]
        .as_str()
        .expect("the app's refusal must be surfaced");
    assert!(note.contains("refused"), "note: {note}");
    assert!(note.contains("search is disabled"), "note: {note}");
}

#[test]
fn search_vault_reports_the_apps_refusal_when_local_grep_cannot_run() {
    let reason = "IPC server returned HTTP 403: search is disabled";
    let ipc = MockIpc::new()
        .on_get(
            "/vault",
            Err("IPC server returned HTTP 403: vault is disabled".into()),
        )
        .on_get("/search", Err(reason.into()));
    let resp = tool_search_vault(id(205), &json!({ "query": "x", "semantic": false }), &ipc);
    let result = resp.result.as_ref().expect("tool error result");
    assert_eq!(result["isError"], json!(true));
    let msg = result["content"][0]["text"].as_str().unwrap_or("");
    assert!(msg.contains("search is disabled"), "got: {msg}");
}

/// `vault` is searched on disk only when the app cannot be reached: a refusal
/// stays the error, and an unreachable app falls back with a note.
#[test]
fn search_vault_greps_the_named_vault_only_when_the_app_is_unreachable() {
    // Not `tempdir()`: its `.tmpXXXX` folder is hidden, and a hidden vault is refused.
    let dir = tempfile::Builder::new().prefix("vault-").tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "the target topic\n").unwrap();
    let vault = dir.path().to_str().unwrap();
    let args = json!({ "query": "target", "semantic": false, "vault": vault });

    let refused = "IPC server returned HTTP 403: vault is disabled";
    let ipc = MockIpc::new()
        .on_get("/vault", Err(refused.into()))
        .on_get("/search", Err(refused.into()));
    let msg = tool_error_text(&tool_search_vault(id(1), &args, &ipc));
    assert!(msg.contains("vault is disabled"), "{msg}");

    let down = "Could not connect to IPC server at 127.0.0.1:1: refused";
    let ipc = MockIpc::new()
        .on_get("/vault", Err(down.into()))
        .on_get("/search", Err(down.into()));
    let v = content_text(&tool_search_vault(id(2), &args, &ipc));
    assert_eq!(v["mode"], "grep-disk", "{v}");
    assert_eq!(v["results"].as_array().unwrap().len(), 1, "{v}");
    let note = v["note"].as_str().unwrap();
    assert!(note.contains(down) && note.contains("on disk"), "{note}");

    // A `vault` that is not a directory is an error result, app or not.
    let bad = json!({ "query": "target", "vault": dir.path().join("a.md") });
    let msg = tool_error_text(&tool_search_vault(id(3), &bad, &ipc));
    assert!(msg.contains("not a directory"), "{msg}");
}

/// A `vault` that is itself a hidden folder (`.git`, `.obsidian`) was walked,
/// though the walk skips hidden folders below a vault: its own notes were
/// read and grepped. It is now refused, as the hidden subfolders are skipped.
#[test]
fn search_vault_refuses_a_hidden_vault_folder() {
    let dir = tempfile::Builder::new().prefix("vault-").tempdir().unwrap();
    let hidden = dir.path().join(".git");
    std::fs::create_dir(&hidden).unwrap();
    std::fs::write(hidden.join("notes.md"), "the target topic\n").unwrap();
    std::fs::create_dir(dir.path().join("notes")).unwrap();

    let err = mdopener_mcp::disk_vault_dir(hidden.to_str().unwrap())
        .expect_err("a hidden vault folder is refused");
    assert!(err.contains("`vault`") && err.contains("hidden"), "{err}");
    // Reached through a relative path or `..`, it is still the hidden folder.
    let dotted = dir.path().join("notes/../.git");
    assert!(mdopener_mcp::disk_vault_dir(dotted.to_str().unwrap()).is_err());
    // Its non-hidden sibling is fine.
    assert!(mdopener_mcp::disk_vault_dir(dir.path().join("notes").to_str().unwrap()).is_ok());

    let down = "Could not connect to IPC server at 127.0.0.1:1: refused";
    let ipc = MockIpc::new()
        .on_get("/vault", Err(down.into()))
        .on_get("/search", Err(down.into()));
    let args = json!({ "query": "target", "semantic": false, "vault": hidden });
    let msg = tool_error_text(&tool_search_vault(id(1), &args, &ipc));
    assert!(msg.contains("hidden"), "{msg}");
}

/// When every document's embedding fails, semantic search compared nothing,
/// so it falls back to grep with a note instead of returning no results.
#[test]
fn search_vault_falls_back_when_every_embedding_fails() {
    use mdopener_mcp::{search_vault_with, semantic_search_vault_with};
    use std::io::Write;
    let mut f = tempfile::NamedTempFile::new().unwrap();
    writeln!(f, "# Notes\nThe target topic is here.").unwrap();
    let path = f.path().to_str().unwrap().to_string();
    let ipc = MockIpc::new()
        .on_get(
            "/vault",
            Ok(json!({ "files": [{ "path": path }], "recents": [] })),
        )
        .on_get(
            "/search",
            Ok(json!({ "results": [{ "path": path, "matches": [] }] })),
        );
    // The query embeds; every document is too much for the model.
    let embed = |text: &str| {
        if text == "target topic" {
            Ok(vec![1.0, 0.0])
        } else {
            Err("Ollama embed request failed: HTTP 500".to_string())
        }
    };

    let err = semantic_search_vault_with("target topic", 50, &ipc, &embed).unwrap_err();
    assert!(err.contains("HTTP 500"), "{err}");

    let v = search_vault_with("target topic", 50, true, &ipc, &embed).unwrap();
    assert_eq!(v["mode"], "grep");
    let note = v["note"].as_str().expect("the fallback is said");
    assert!(note.contains("Semantic search was unavailable"), "{note}");
    assert!(note.contains("embedding every document failed"), "{note}");

    // One document that embeds is a semantic answer, as before.
    let embed_all = |_: &str| Ok(vec![1.0, 0.0]);
    let v = search_vault_with("target topic", 50, true, &ipc, &embed_all).unwrap();
    assert_eq!(v["mode"], "semantic");
    assert_eq!(v["results"].as_array().unwrap().len(), 1);
}

/// When only some documents fail to embed, the semantic results leave them
/// out, and the note says how many, so their absence is not read as
/// "unrelated to the query".
#[test]
fn search_vault_notes_documents_whose_embedding_failed() {
    use mdopener_mcp::search_vault_with;
    let dir = tempfile::tempdir().unwrap();
    let mut files = Vec::new();
    for (name, body) in [
        ("a.md", "# A\nthe target topic"),
        ("big1.md", "# Big one\nTOO BIG"),
        ("big2.md", "# Big two\nTOO BIG"),
    ] {
        let p = dir.path().join(name);
        std::fs::write(&p, body).unwrap();
        files.push(json!({ "path": p.to_str().unwrap() }));
    }
    let ipc = MockIpc::new().on_get("/vault", Ok(json!({ "files": files, "recents": [] })));
    let embed = |text: &str| {
        if text.contains("TOO BIG") {
            Err("Ollama embed request failed: HTTP 500".to_string())
        } else {
            Ok(vec![1.0, 0.0])
        }
    };
    let v = search_vault_with("target topic", 50, true, &ipc, &embed).unwrap();
    assert_eq!(v["mode"], "semantic");
    assert_eq!(v["results"].as_array().unwrap().len(), 1);
    let note = v["note"].as_str().expect("the skipped documents are said");
    assert!(note.contains("2 of 3 documents"), "{note}");
    assert!(note.contains("HTTP 500"), "{note}");

    // With every document embedded there is nothing to note.
    let embed_all = |_: &str| Ok(vec![1.0, 0.0]);
    let v = search_vault_with("target topic", 50, true, &ipc, &embed_all).unwrap();
    assert_eq!(v["results"].as_array().unwrap().len(), 3);
    assert!(v.get("note").is_none(), "{v}");
}

// ── text://vault-search resource ──────────────────────────────────────────────

#[test]
fn resources_list_includes_vault_search_resource() {
    let ipc = MockIpc::new().on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
    let resp = handle_resources_list(id(300), &ipc);
    assert!(resp.error.is_none());
    let result = resp.result.as_ref().unwrap();
    let resources = result["resources"].as_array().unwrap();
    let uris: Vec<&str> = resources.iter().filter_map(|r| r["uri"].as_str()).collect();
    assert!(
        uris.contains(&"text://vault-search"),
        "resources/list must include text://vault-search, got: {:?}",
        uris
    );
}

#[test]
fn resources_list_vault_search_has_json_mime_type() {
    let ipc = MockIpc::new().on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
    let resp = handle_resources_list(id(301), &ipc);
    let result = resp.result.as_ref().unwrap();
    let resources = result["resources"].as_array().unwrap();
    let search_res = resources
        .iter()
        .find(|r| r["uri"].as_str() == Some("text://vault-search"))
        .expect("text://vault-search not found");
    assert_eq!(
        search_res["mimeType"].as_str(),
        Some("application/json"),
        "vault-search resource must have mimeType application/json"
    );
}

#[test]
fn resource_read_vault_search_missing_query_returns_error() {
    let ipc = MockIpc::new();
    // URI without ?q= parameter.
    let resp = handle_resource_read(id(302), "text://vault-search", &ipc);
    assert!(resp.error.is_some(), "missing query must return error");
    assert_eq!(
        resp.error.as_ref().unwrap().code,
        -32602,
        "missing query must be a param error (-32602)"
    );
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
    let contents = result["contents"]
        .as_array()
        .expect("contents must be array");
    assert_eq!(contents.len(), 1);
    let item = &contents[0];
    assert_eq!(item["mimeType"].as_str(), Some("application/json"));
    // Parse the text payload as JSON.
    let payload: Value =
        serde_json::from_str(item["text"].as_str().unwrap()).expect("text must be valid JSON");
    assert!(
        payload["results"].is_array(),
        "payload must have results array"
    );
    assert!(payload["mode"].is_string(), "payload must have mode field");
    assert_eq!(
        payload["query"].as_str(),
        Some("relevant"),
        "payload must echo back the query"
    );
}

#[test]
fn resource_read_vault_search_uri_encoded_query_decoded() {
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    // q=hello%20world — should decode to "hello world".
    let resp = handle_resource_read(id(304), "text://vault-search?q=hello%20world", &ipc);
    assert!(resp.error.is_none());
    let result = resp.result.as_ref().unwrap();
    let payload: Value =
        serde_json::from_str(result["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload["query"].as_str(),
        Some("hello world"),
        "URL-encoded query must be decoded"
    );
}

#[test]
fn resource_read_vault_search_no_results_returns_empty_array() {
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    let resp = handle_resource_read(id(305), "text://vault-search?q=xyz_impossible", &ipc);
    assert!(resp.error.is_none());
    let payload: Value = serde_json::from_str(
        resp.result.as_ref().unwrap()["contents"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let results = payload["results"]
        .as_array()
        .expect("results must be array");
    assert!(
        results.is_empty(),
        "no matches should return empty results array"
    );
}

#[test]
fn resource_read_vault_search_ipc_down_falls_back_to_local_grep() {
    use std::io::Write;
    let mut f = tempfile::NamedTempFile::new().unwrap();
    writeln!(f, "# Project notes\nThis has the query term inside.").unwrap();
    let path = f.path().to_str().unwrap().to_string();

    let ipc = MockIpc::new()
        .on_get(
            "/vault",
            Ok(json!({
                "files": [{ "path": path, "name": "notes.md" }],
                "recents": []
            })),
        )
        .on_get("/search", Err("ipc-port not found".into()));

    let resp = handle_resource_read(id(306), "text://vault-search?q=query+term", &ipc);
    assert!(
        resp.error.is_none(),
        "local grep fallback must succeed: {:?}",
        resp.error
    );
    let payload: Value = serde_json::from_str(
        resp.result.as_ref().unwrap()["contents"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["mode"].as_str().unwrap_or(""), "grep-local");
}

/// `semantic=` on the resource was ignored: it always auto-detected Ollama,
/// so an agent could not force grep (or semantic) the way `search_vault`'s
/// `semantic` argument does, and a typo was silently dropped.
#[test]
fn resource_read_vault_search_honours_semantic_option() {
    let payload_of = |resp: &mdopener_mcp::Response| -> Value {
        serde_json::from_str(
            resp.result.as_ref().unwrap()["contents"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    };
    let mock = || {
        MockIpc::new()
            .on_get("/vault", Ok(json!({ "files": [], "recents": [] })))
            .on_get("/search", Ok(json!({ "results": [] })))
    };

    // semantic=false never asks for the vault list (the embedding path's
    // first step) and answers with the app's grep, without a note.
    let ipc = mock();
    let resp = handle_resource_read(id(310), "text://vault-search?q=x&semantic=false", &ipc);
    assert!(resp.error.is_none(), "{:?}", resp.error);
    let payload = payload_of(&resp);
    assert_eq!(payload["mode"], "grep", "{payload}");
    assert!(payload.get("note").is_none(), "{payload}");
    assert!(
        ipc.calls()
            .iter()
            .all(|(_, path, _)| !path.starts_with("/vault")),
        "semantic=false tried embeddings: {:?}",
        ipc.calls()
    );

    // semantic=true tries embeddings even when auto-detection would not,
    // and says so when it fell back.
    if !mdopener_mcp::ollama_available() {
        let ipc = mock();
        let resp = handle_resource_read(id(311), "text://vault-search?q=x&semantic=true", &ipc);
        let payload = payload_of(&resp);
        assert_eq!(payload["mode"], "grep", "{payload}");
        assert!(
            payload["note"]
                .as_str()
                .unwrap_or("")
                .contains("Semantic search was unavailable"),
            "{payload}"
        );
    }

    let resp = handle_resource_read(id(312), "text://vault-search?q=x&semantic=maybe", &mock());
    let err = resp.error.expect("an invalid semantic value is an error");
    assert_eq!(err.code, -32602);
    assert!(err.message.contains("semantic"), "{}", err.message);
}

/// `limit=ten` on the resource was read as the default of 50.
#[test]
fn resource_read_vault_search_rejects_a_non_numeric_limit() {
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    let resp = handle_resource_read(id(314), "text://vault-search?q=x&limit=ten", &ipc);
    let err = resp.error.expect("a non-numeric limit is an error");
    assert_eq!(err.code, -32602);
    assert!(
        err.message.contains("`limit` must be a whole number"),
        "{}",
        err.message
    );
    assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
    let ok = handle_resource_read(id(315), "text://vault-search?q=x&limit=3", &ipc);
    assert!(ok.error.is_none(), "{:?}", ok.error);
}

/// `search_vault` with `semantic: "false"` (a string) silently auto-detected
/// instead of forcing grep.
#[test]
fn search_vault_rejects_a_non_boolean_semantic() {
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    let resp = call(
        "search_vault",
        json!({ "query": "x", "semantic": "false" }),
        &ipc,
    );
    let err = resp
        .error
        .expect("a string semantic is an invalid argument");
    assert_eq!(err.code, -32602);
    assert!(
        err.message.contains("`semantic` must be a boolean"),
        "{}",
        err.message
    );
    assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
}

/// The resource falls back the way `search_vault` does and says so: a grep
/// of the files on disk carries the app's own reason for not searching.
#[test]
fn resource_read_vault_search_says_when_it_fell_back() {
    use std::io::Write;
    // Only meaningful when nothing listens on Ollama's port.
    if mdopener_mcp::ollama_available() {
        return;
    }
    let mut f = tempfile::NamedTempFile::new().unwrap();
    writeln!(f, "# Project notes\nThis has the query term inside.").unwrap();
    let path = f.path().to_str().unwrap().to_string();
    for (reason, verb) in [
        (
            "IPC server returned HTTP 403: search is disabled",
            "refused",
        ),
        ("IPC read error: connection reset", "failed"),
    ] {
        let ipc = MockIpc::new()
            .on_get(
                "/vault",
                Ok(json!({ "files": [{ "path": path }], "recents": [] })),
            )
            .on_get("/search", Err(reason.into()));
        let resp = handle_resource_read(id(1), "text://vault-search?q=query+term", &ipc);
        assert!(resp.error.is_none(), "{:?}", resp.error);
        let payload: Value = serde_json::from_str(
            resp.result.as_ref().unwrap()["contents"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["mode"], "grep-local");
        assert_eq!(payload["query"], "query term");
        let note = payload["note"].as_str().expect("the fallback is said");
        assert!(note.contains(verb), "{note}");
        assert!(note.contains(reason), "{note}");
    }
}

/// A refusal from the app is the resource's error too, not "is it running?".
#[test]
fn resource_read_vault_search_reports_the_apps_refusal() {
    if mdopener_mcp::ollama_available() {
        return;
    }
    let ipc = MockIpc::new()
        .on_get(
            "/vault",
            Err("IPC server returned HTTP 403: vault is disabled".into()),
        )
        .on_get(
            "/search",
            Err("IPC server returned HTTP 403: search is disabled".into()),
        );
    let resp = handle_resource_read(id(1), "text://vault-search?q=x", &ipc);
    let err = resp.error.expect("a refusal is an error");
    assert!(
        err.message.contains("search is disabled"),
        "{}",
        err.message
    );
}

#[test]
fn resource_read_vault_search_custom_limit_respected() {
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    // limit=5 in query string.
    let resp = handle_resource_read(id(307), "text://vault-search?q=x&limit=5", &ipc);
    assert!(resp.error.is_none());
    // We can't directly observe the limit applied server-side through the mock,
    // but the call should succeed and return valid JSON.
    let payload: Value = serde_json::from_str(
        resp.result.as_ref().unwrap()["contents"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert!(payload["results"].is_array());
}

// ── search_vault result shape ─────────────────────────────────────────────────

#[test]
fn search_vault_result_contains_required_fields() {
    let ipc = MockIpc::new().on_get(
        "/search",
        Ok(json!({
            "results": [
                {
                    "path": "/vault/doc.md",
                    "snippet": "a relevant snippet",
                    "lineNumber": 7,
                    "score": 0.9
                }
            ]
        })),
    );
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

/// Session files go to a temp directory, never the real `~/.mdopener`.
/// Every test that touches a session gets its id from `unique_session`, which
/// sets this up first.
fn use_temp_sessions_dir() {
    static DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap().keep().join("sessions");
        assert!(mdopener_mcp::set_sessions_dir(dir.clone()));
        dir
    });
}

fn unique_session() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use_temp_sessions_dir();
    static CTR: AtomicU64 = AtomicU64::new(0);
    format!(
        "test-sess-{}-{}",
        std::process::id(),
        CTR.fetch_add(1, Ordering::SeqCst)
    )
}

// ════════════════════════════════════════════════════════════════════════════
// save_conversation_message — parameter validation
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn save_message_missing_session_id_returns_param_error() {
    let resp = tool_save_conversation_message(
        id(1),
        &json!({
            "role": "agent",
            "content": "Did something"
        }),
    );
    assert_eq!(
        resp.error.as_ref().unwrap().code,
        -32602,
        "missing session_id must return -32602"
    );
}

#[test]
fn save_message_empty_session_id_returns_param_error() {
    let resp = tool_save_conversation_message(
        id(1),
        &json!({
            "session_id": "",
            "role": "agent",
            "content": "Did something"
        }),
    );
    assert_eq!(
        resp.error.as_ref().unwrap().code,
        -32602,
        "empty session_id must return -32602"
    );
}

#[test]
fn save_message_missing_role_returns_param_error() {
    let resp = tool_save_conversation_message(
        id(1),
        &json!({
            "session_id": unique_session(),
            "content": "Some content"
        }),
    );
    assert_eq!(
        resp.error.as_ref().unwrap().code,
        -32602,
        "missing role must return -32602"
    );
}

#[test]
fn save_message_invalid_role_returns_param_error() {
    let resp = tool_save_conversation_message(
        id(1),
        &json!({
            "session_id": unique_session(),
            "role": "robot",
            "content": "Some content"
        }),
    );
    assert_eq!(
        resp.error.as_ref().unwrap().code,
        -32602,
        "invalid role must return -32602"
    );
    let msg = resp.error.unwrap().message;
    assert!(
        msg.contains("agent") || msg.contains("human") || msg.contains("system"),
        "error should list valid roles, got: {msg}"
    );
}

#[test]
fn save_message_missing_content_returns_param_error() {
    let resp = tool_save_conversation_message(
        id(1),
        &json!({
            "session_id": unique_session(),
            "role": "agent"
        }),
    );
    assert_eq!(
        resp.error.as_ref().unwrap().code,
        -32602,
        "missing content must return -32602"
    );
}

#[test]
fn save_message_empty_content_returns_param_error() {
    let resp = tool_save_conversation_message(
        id(1),
        &json!({
            "session_id": unique_session(),
            "role": "agent",
            "content": "   "
        }),
    );
    assert_eq!(
        resp.error.as_ref().unwrap().code,
        -32602,
        "whitespace-only content must return -32602"
    );
}

// ════════════════════════════════════════════════════════════════════════════
// save_conversation_message — success paths
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn save_message_agent_role_succeeds_and_returns_message_id() {
    let sess = unique_session();
    let resp = tool_save_conversation_message(
        id(1),
        &json!({
            "session_id": sess,
            "role": "agent",
            "content": "Rewrote the introduction paragraph."
        }),
    );
    assert!(
        resp.error.is_none(),
        "agent save should succeed: {:?}",
        resp.error
    );
    assert!(!is_error(&resp), "isError must be false");
    let text = content_text(&resp);
    assert_eq!(text["ok"], json!(true));
    assert!(
        text["messageId"]
            .as_str()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        "messageId must be a non-empty string"
    );
    assert_eq!(text["sessionId"].as_str(), Some(sess.as_str()));
    assert_eq!(text["role"].as_str(), Some("agent"));
}

#[test]
fn save_message_human_role_succeeds() {
    let sess = unique_session();
    let resp = tool_save_conversation_message(
        id(2),
        &json!({
            "session_id": sess,
            "role": "human",
            "content": "Approved — looks good."
        }),
    );
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["role"].as_str(), Some("human"));
}

#[test]
fn save_message_system_role_succeeds() {
    let sess = unique_session();
    let resp = tool_save_conversation_message(
        id(3),
        &json!({
            "session_id": sess,
            "role": "system",
            "content": "Session started. Active doc: /docs/notes.md"
        }),
    );
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    assert_eq!(text["role"].as_str(), Some("system"));
}

#[test]
fn save_message_with_cited_docs_accepted() {
    let sess = unique_session();
    let resp = tool_save_conversation_message(
        id(4),
        &json!({
            "session_id": sess,
            "role": "agent",
            "content": "Summarised the spec.",
            "cited_docs": ["/docs/spec.md", "/docs/roadmap.md"]
        }),
    );
    assert!(
        resp.error.is_none(),
        "cited_docs should be accepted: {:?}",
        resp.error
    );
    assert_eq!(content_text(&resp)["ok"], json!(true));
}

#[test]
fn save_message_without_cited_docs_defaults_to_empty() {
    // cited_docs is optional — omitting it must not error.
    let sess = unique_session();
    let resp = tool_save_conversation_message(
        id(5),
        &json!({
            "session_id": sess,
            "role": "agent",
            "content": "No docs cited here."
        }),
    );
    assert!(resp.error.is_none());
}

// ════════════════════════════════════════════════════════════════════════════
// get_conversation_context — parameter validation
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn get_context_missing_session_id_returns_param_error() {
    let resp = tool_get_conversation_context(id(1), &json!({}));
    assert_eq!(
        resp.error.as_ref().unwrap().code,
        -32602,
        "missing session_id must return -32602"
    );
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
    assert!(
        resp.error.is_none(),
        "empty session must not produce RPC error: {:?}",
        resp.error
    );
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
    store_append_message(&sess, "agent", "Ran search_vault.", vec![]).expect("append must succeed");

    // Retrieve via the MCP tool.
    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    assert!(
        resp.error.is_none(),
        "get after append must succeed: {:?}",
        resp.error
    );
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
    store_append_message(
        &sess,
        "agent",
        "Opened /docs/spec.md.",
        vec!["/docs/spec.md".into()],
    )
    .unwrap();
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

    let save_resp = tool_save_conversation_message(
        id(1),
        &json!({
            "session_id": sess,
            "role": "agent",
            "content": "Edited the summary section.",
            "cited_docs": ["/vault/summary.md"]
        }),
    );
    assert!(save_resp.error.is_none(), "save must succeed");

    let get_resp = tool_get_conversation_context(
        id(2),
        &json!({
            "session_id": sess,
            "limit": 10
        }),
    );
    assert!(get_resp.error.is_none(), "get must succeed");
    let text = content_text(&get_resp);
    let msgs = text["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(
        msgs[0]["content"].as_str(),
        Some("Edited the summary section.")
    );
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
    assert!(
        ctx_y.is_empty(),
        "messages written to session X must not appear in session Y"
    );
}

// ════════════════════════════════════════════════════════════════════════════
// Disk persistence across simulated "restart"
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn messages_persisted_to_disk_and_loadable() {
    let sess = unique_session();
    let home_sessions = dirs::home_dir().map(|h| h.join(".mdopener").join("sessions"));
    let dir = mdopener_mcp::sessions_dir();
    assert_ne!(dir, home_sessions, "tests must not use ~/.mdopener");

    // Append via store (triggers disk write).
    store_append_message(
        &sess,
        "agent",
        "Wrote introduction.",
        vec!["/vault/intro.md".into()],
    )
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
    assert_eq!(
        log.messages.len(),
        5,
        "all 5 messages must be persisted, got {}",
        log.messages.len()
    );
}

#[test]
fn cold_start_loads_from_disk_via_get_context() {
    // Simulate a cold start: write directly to disk, bypass the in-process store,
    // then call store_get_context which should load from disk automatically.
    use mdopener_mcp::{ConversationMessage, SessionLog};

    let sess = unique_session();
    let path = session_file_path(&sess).expect("must have session path");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }

    let ts = 1_700_000_000_000u64;
    let log = SessionLog {
        messages: vec![ConversationMessage {
            id: "msg-cold-start-test".into(),
            session_id: sess.clone(),
            role: "human".into(),
            content: "Approved the plan.".into(),
            cited_docs: vec![],
            timestamp_ms: ts,
        }],
    };
    let json = serde_json::to_string(&log).unwrap();
    std::fs::write(&path, &json).expect("write must succeed");

    // Get context — the in-process store does NOT have this session yet.
    let ctx = store_get_context(&sess, 20).expect("get must succeed");
    assert_eq!(
        ctx.len(),
        1,
        "cold-start load must recover 1 message from disk"
    );
    assert_eq!(ctx[0].content, "Approved the plan.");
    assert_eq!(ctx[0].role, "human");
}

#[test]
fn cold_start_append_continues_the_persisted_log() {
    // A restarted server (empty in-process store) must append to the session
    // on disk, not overwrite it with just the new message.
    use mdopener_mcp::{ConversationMessage, SessionLog};

    let sess = unique_session();
    let path = session_file_path(&sess).expect("must have session path");
    std::fs::create_dir_all(path.parent().unwrap()).ok();
    let earlier = SessionLog {
        messages: vec![ConversationMessage {
            id: "msg-from-an-earlier-process".into(),
            session_id: sess.clone(),
            role: "agent".into(),
            content: "Drafted the plan.".into(),
            cited_docs: vec![],
            timestamp_ms: 1_700_000_000_000,
        }],
    };
    std::fs::write(&path, serde_json::to_string(&earlier).unwrap()).unwrap();

    store_append_message(&sess, "human", "Approved.", vec![]).unwrap();

    let log = load_session_from_disk(&sess).expect("session must be on disk");
    let contents: Vec<&str> = log.messages.iter().map(|m| m.content.as_str()).collect();
    assert_eq!(contents, ["Drafted the plan.", "Approved."]);
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

    let resp = tool_get_conversation_context(
        id(1),
        &json!({
            "session_id": sess,
            "limit": 3
        }),
    );
    assert!(resp.error.is_none());
    let text = content_text(&resp);
    let msgs = text["messages"].as_array().unwrap();
    assert!(
        msgs.len() <= 3,
        "limit=3 must return at most 3 messages, got {}",
        msgs.len()
    );
}

#[test]
fn get_context_limit_returns_most_recent_messages() {
    let sess = unique_session();

    for i in 0..5 {
        store_append_message(&sess, "agent", &format!("Message {i}"), vec![]).unwrap();
    }

    let resp = tool_get_conversation_context(
        id(1),
        &json!({
            "session_id": sess,
            "limit": 2
        }),
    );
    let text = content_text(&resp);
    let msgs = text["messages"].as_array().unwrap();
    // Should return the two most recent: "Message 3" and "Message 4".
    assert_eq!(msgs.len(), 2);
    assert_eq!(
        msgs[1]["content"].as_str(),
        Some("Message 4"),
        "last message should be 'Message 4'"
    );
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
    assert_eq!(
        msgs.len(),
        20,
        "default limit must be 20, got {}",
        msgs.len()
    );
}

// ════════════════════════════════════════════════════════════════════════════
// cited_docs aggregated into recentDocs
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn recent_docs_aggregated_from_cited_docs() {
    let sess = unique_session();

    store_append_message(&sess, "agent", "Read spec.", vec!["/docs/spec.md".into()]).unwrap();
    store_append_message(
        &sess,
        "agent",
        "Read roadmap.",
        vec!["/docs/roadmap.md".into()],
    )
    .unwrap();
    store_append_message(&sess, "human", "Approved.", vec![]).unwrap();

    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    let text = content_text(&resp);
    let recent_docs = text["recentDocs"]
        .as_array()
        .expect("recentDocs must be array");
    let paths: Vec<&str> = recent_docs.iter().filter_map(|v| v.as_str()).collect();
    assert!(
        paths.contains(&"/docs/spec.md"),
        "spec.md must appear in recentDocs"
    );
    assert!(
        paths.contains(&"/docs/roadmap.md"),
        "roadmap.md must appear in recentDocs"
    );
}

#[test]
fn recent_docs_deduplicates_repeated_paths() {
    let sess = unique_session();

    store_append_message(&sess, "agent", "First read.", vec!["/vault/doc.md".into()]).unwrap();
    store_append_message(&sess, "agent", "Second read.", vec!["/vault/doc.md".into()]).unwrap();

    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    let text = content_text(&resp);
    let recent_docs = text["recentDocs"]
        .as_array()
        .expect("recentDocs must be array");
    let doc_count = recent_docs
        .iter()
        .filter(|v| v.as_str() == Some("/vault/doc.md"))
        .count();
    assert_eq!(
        doc_count, 1,
        "/vault/doc.md should appear exactly once in recentDocs"
    );
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
    assert!(
        msg["citedDocs"].is_array(),
        "message must have citedDocs array"
    );
    assert!(
        msg["timestampMs"].is_number(),
        "message must have timestampMs"
    );
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
        assert!(
            !err.message.contains("Unknown tool"),
            "get_conversation_context must be routed, got: {}",
            err.message
        );
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
        assert!(
            !err.message.contains("Unknown tool"),
            "save_conversation_message must be routed, got: {}",
            err.message
        );
    }
    assert!(
        resp.error.is_none(),
        "save via dispatch must succeed: {:?}",
        resp.error
    );
}

// ════════════════════════════════════════════════════════════════════════════
// session_file_path sanitisation
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn session_file_path_sanitises_special_characters() {
    // Slashes and dots in a session ID must not escape the sessions directory.
    let path = session_file_path("../../evil/path").expect("must return a path");
    let filename = path.file_name().unwrap().to_string_lossy();
    assert!(
        !filename.contains('/'),
        "sanitised filename must not contain '/'"
    );
    assert!(filename.ends_with(".json"), "path must end with .json");
}

#[test]
fn session_file_path_alphanumeric_preserved() {
    let path = session_file_path("sess-abc-123_XYZ").expect("must return a path");
    let filename = path.file_name().unwrap().to_string_lossy();
    assert!(
        filename.contains("sess-abc-123_XYZ"),
        "alphanumeric/dash/underscore chars must be preserved in filename"
    );
}

// ════════════════════════════════════════════════════════════════════════════
// Unavailable tools: export_markdown_archive, export_canvas_graph,
// batch_export_format. The app has no IPC route behind them.
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn unavailable_tools_are_not_listed() {
    let names: Vec<&str> = tool_registry().iter().map(|t| t.name).collect();
    for name in UNAVAILABLE_TOOLS {
        assert!(
            !names.contains(name),
            "{name} must not be in tool_registry()"
        );
        assert!(
            !ALL_TOOL_NAMES.contains(name),
            "{name} must not be in ALL_TOOL_NAMES"
        );
    }
    assert_eq!(UNAVAILABLE_TOOLS.len(), 3);
}

#[test]
fn unavailable_tools_fail_fast_with_clear_error_and_no_ipc_call() {
    let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
    for name in UNAVAILABLE_TOOLS {
        let args = json!({
            "output_path": "/tmp/out",
            "exports": [{ "path": "/tmp/a.md", "format": "pdf" }]
        });
        let resp = dispatch(
            dispatch_req("tools/call", json!({ "name": name, "arguments": args })),
            &ipc,
        )
        .unwrap();
        assert!(
            resp.error.is_none(),
            "{name}: must be an isError result, not a JSON-RPC error"
        );
        let result = resp.result.as_ref().unwrap();
        assert_eq!(result["isError"], json!(true), "{name}: isError");
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains(name),
            "{name}: message must name the tool: {text}"
        );
        assert!(text.contains("not available"), "{name}: {text}");
        assert!(
            text.contains("`export`"),
            "{name}: must point at export: {text}"
        );
        assert!(!text.contains("404"), "{name}: {text}");
    }
    assert!(
        ipc.calls().is_empty(),
        "no IPC call expected: {:?}",
        ipc.calls()
    );
}

#[test]
fn truly_unknown_tool_still_reports_unknown() {
    let ipc = MockIpc::new();
    let resp = dispatch(
        dispatch_req(
            "tools/call",
            json!({ "name": "export_everything", "arguments": {} }),
        ),
        &ipc,
    )
    .unwrap();
    let err = resp.error.expect("unknown tool is a JSON-RPC error");
    assert!(err.message.contains("Unknown tool"));
}

// ════════════════════════════════════════════════════════════════════════════
// Tool: export_text — plaintext extraction + word/char counts
// ════════════════════════════════════════════════════════════════════════════

use mdopener_mcp::{count_words, strip_markdown, tool_export_metadata, tool_export_text};

/// Helper: write a temp file, run the tool, return the parsed result JSON.
fn run_export_text_on(markdown: &str) -> Value {
    let dir = std::env::temp_dir();
    let path = dir.join(format!(
        "test_export_text_{}.md",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::write(&path, markdown).unwrap();
    let ipc = MockIpc::new();
    let args = json!({ "path": path.to_string_lossy() });
    let resp = tool_export_text(json!(1), &args, &ipc);
    assert!(
        resp.error.is_none(),
        "unexpected RPC error: {:?}",
        resp.error
    );
    content_text(&resp)
}

fn run_export_metadata_on(markdown: &str) -> Value {
    let dir = std::env::temp_dir();
    let path = dir.join(format!(
        "test_export_meta_{}.md",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::write(&path, markdown).unwrap();
    let ipc = MockIpc::new();
    let args = json!({ "path": path.to_string_lossy() });
    let resp = tool_export_metadata(json!(1), &args, &ipc);
    assert!(
        resp.error.is_none(),
        "unexpected RPC error: {:?}",
        resp.error
    );
    content_text(&resp)
}

#[test]
fn export_text_strips_headings_and_emphasis() {
    let md = "# Hello World\n\nThis is **bold** and _italic_ text.\n";
    let result = run_export_text_on(md);
    let text = result["text"].as_str().unwrap();
    assert!(!text.contains('#'), "heading # should be stripped");
    assert!(!text.contains("**"), "bold markers should be stripped");
    assert!(!text.contains('_'), "italic markers should be stripped");
    assert!(text.contains("Hello World"), "heading text preserved");
    assert!(text.contains("bold"), "bold content preserved");
    assert!(text.contains("italic"), "italic content preserved");
}

#[test]
fn export_text_preserves_code_block_content() {
    let md = "# Title\n\n```python\nprint('hello')\nx = 1 + 2\n```\n\nAfter code.\n";
    let result = run_export_text_on(md);
    let text = result["text"].as_str().unwrap();
    assert!(
        text.contains("print('hello')"),
        "code content should be preserved"
    );
    assert!(
        text.contains("x = 1 + 2"),
        "code content should be preserved"
    );
    assert!(
        !text.contains("```"),
        "code fence markers should be stripped"
    );
    assert!(
        text.contains("After code"),
        "text after code block preserved"
    );
}

#[test]
fn export_text_word_and_char_counts_are_correct() {
    // Strip a simple document and verify counts match the extracted text.
    let md = "# Title\n\nHello world foo bar.\n";
    let result = run_export_text_on(md);
    let text = result["text"].as_str().unwrap();
    let reported_words = result["word_count"].as_u64().unwrap() as usize;
    let reported_chars = result["char_count"].as_u64().unwrap() as usize;
    assert_eq!(
        reported_words,
        count_words(text),
        "word_count must match count_words(text)"
    );
    assert_eq!(
        reported_chars,
        text.chars().count(),
        "char_count must match text.chars().count()"
    );
    // "Title Hello world foo bar" = 5 words
    assert_eq!(
        reported_words, 5,
        "expected 5 words after stripping heading marker"
    );
}

#[test]
fn export_text_strips_frontmatter() {
    let md = "---\ntitle: My Doc\nauthor: Test\n---\n\nActual content here.\n";
    let result = run_export_text_on(md);
    let text = result["text"].as_str().unwrap();
    assert!(
        !text.contains("title:"),
        "frontmatter key should be stripped"
    );
    assert!(
        !text.contains("author:"),
        "frontmatter key should be stripped"
    );
    assert!(
        text.contains("Actual content here"),
        "body content must be preserved"
    );
}

#[test]
fn export_text_ipc_fallback_when_no_path() {
    let ipc = MockIpc::new().on_get(
        "/content",
        Ok(json!({ "content": "# Title\n\nHello.", "path": "/tmp/test.md" })),
    );
    let resp = tool_export_text(json!(42), &json!({}), &ipc);
    assert!(resp.error.is_none());
    let result = content_text(&resp);
    let text = result["text"].as_str().unwrap();
    assert!(text.contains("Title"), "heading text extracted");
    assert!(text.contains("Hello"), "body text extracted");
    assert_eq!(
        result["path"].as_str(),
        Some("/tmp/test.md"),
        "path echoed from IPC"
    );
}

#[test]
fn export_text_missing_path_and_no_ipc_returns_error() {
    // MockIpc with no handler — simulates app not running.
    let ipc = MockIpc::new();
    let resp = tool_export_text(json!(1), &json!({}), &ipc);
    // Should return an RPC-level error (app not running).
    assert!(
        resp.error.is_some() || is_error(&resp),
        "should return error when path omitted and IPC fails"
    );
}

#[test]
fn export_text_and_metadata_with_nothing_open_are_errors() {
    // No path and no document open: there is nothing to extract, so an empty
    // text / zero word count would read as an empty document.
    let ipc = MockIpc::new().on_get("/content", Ok(json!({ "path": null, "content": "" })));
    for resp in [
        tool_export_text(json!(1), &json!({}), &ipc),
        tool_export_metadata(json!(2), &json!({}), &ipc),
    ] {
        let text = tool_error_text(&resp);
        assert!(text.contains("No document is open"), "{text}");
        assert!(text.contains("`path`"), "{text}");
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Tool: export_metadata — frontmatter, headings, wikilinks, images, word count
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn export_metadata_parses_frontmatter_and_headings() {
    let md = concat!(
        "---\ntitle: Test Doc\ntags: notes\n---\n\n",
        "# Introduction\n\nSome text.\n\n",
        "## Details\n\nMore text.\n"
    );
    let result = run_export_metadata_on(md);
    // Frontmatter
    let fm = &result["frontmatter"];
    assert!(fm.is_object(), "frontmatter should be an object");
    assert_eq!(fm["title"].as_str(), Some("Test Doc"));
    assert_eq!(fm["tags"].as_str(), Some("notes"));
    // Headings
    let headings = result["headings"].as_array().unwrap();
    assert_eq!(headings.len(), 2, "two headings expected");
    assert_eq!(headings[0]["level"].as_u64(), Some(1));
    assert_eq!(headings[0]["text"].as_str(), Some("Introduction"));
    assert_eq!(headings[1]["level"].as_u64(), Some(2));
    assert_eq!(headings[1]["text"].as_str(), Some("Details"));
}

#[test]
fn export_metadata_extracts_wikilinks_and_image_count() {
    let md = concat!(
        "# Doc\n\n",
        "See [[PageA]] and [[PageB|alias]] for details.\n\n",
        "![alt text](image.png)\n\n",
        "![[embedded.png]]\n"
    );
    let result = run_export_metadata_on(md);
    let wikilinks = result["wikilinks"].as_array().unwrap();
    let wl_strs: Vec<&str> = wikilinks.iter().filter_map(|v| v.as_str()).collect();
    assert!(wl_strs.contains(&"PageA"), "PageA should be in wikilinks");
    assert!(
        wl_strs.contains(&"PageB"),
        "PageB (before |) should be in wikilinks"
    );
    let img_count = result["embedded_image_count"].as_u64().unwrap();
    assert_eq!(img_count, 2, "two embedded images expected");
}

#[test]
fn export_metadata_word_count_matches_plain_text() {
    let md = "# Title\n\nHello **world** how are you.\n";
    let result = run_export_metadata_on(md);
    let reported = result["word_count"].as_u64().unwrap() as usize;
    let plain = strip_markdown(md);
    let expected = count_words(&plain);
    assert_eq!(
        reported, expected,
        "export_metadata word_count must match strip_markdown word count"
    );
}

#[test]
fn export_metadata_no_frontmatter_returns_null() {
    let md = "# Just a heading\n\nNo front matter here.\n";
    let result = run_export_metadata_on(md);
    assert!(
        result["frontmatter"].is_null(),
        "frontmatter should be null when absent"
    );
}

#[test]
fn export_metadata_ipc_fallback_when_no_path() {
    let md = "---\ntitle: IPC Doc\n---\n\n# Heading\n\nBody text.\n";
    let ipc = MockIpc::new().on_get(
        "/content",
        Ok(json!({ "content": md, "path": "/tmp/ipc.md" })),
    );
    let resp = tool_export_metadata(json!(1), &json!({}), &ipc);
    assert!(resp.error.is_none());
    let result = content_text(&resp);
    let fm = &result["frontmatter"];
    assert_eq!(fm["title"].as_str(), Some("IPC Doc"));
    let headings = result["headings"].as_array().unwrap();
    assert_eq!(headings.len(), 1);
    assert_eq!(headings[0]["text"].as_str(), Some("Heading"));
}

// ── Registry checks for the two new tools ────────────────────────────────────

#[test]
fn export_text_is_readonly_tier() {
    let reg = tool_registry();
    let def = reg
        .iter()
        .find(|d| d.name == "export_text")
        .expect("export_text must be in registry");
    assert_eq!(
        def.tier,
        mdopener_mcp::ToolTier::ReadOnly,
        "export_text must be ReadOnly tier"
    );
    let ann = def
        .annotations
        .as_ref()
        .expect("export_text must have annotations");
    assert_eq!(ann["readOnlyHint"].as_bool(), Some(true));
    assert_ne!(ann["destructiveHint"].as_bool(), Some(true));
}

#[test]
fn export_metadata_is_readonly_tier() {
    let reg = tool_registry();
    let def = reg
        .iter()
        .find(|d| d.name == "export_metadata")
        .expect("export_metadata must be in registry");
    assert_eq!(
        def.tier,
        mdopener_mcp::ToolTier::ReadOnly,
        "export_metadata must be ReadOnly tier"
    );
    let ann = def
        .annotations
        .as_ref()
        .expect("export_metadata must have annotations");
    assert_eq!(ann["readOnlyHint"].as_bool(), Some(true));
    assert_ne!(ann["destructiveHint"].as_bool(), Some(true));
}

// ── diff_documents engine: bounded memory ────────────────────────────────────

use mdopener_mcp::{compute_unified_diff, handle_prompt_get, lcs_diff, DiffOp, MAX_LCS_CELLS};

/// Apply an edit script to A and check it reproduces B, and that every line of
/// A and B is accounted for exactly once.
fn assert_script_rebuilds(a: &[&str], b: &[&str]) {
    let ops = lcs_diff(a, b);
    let mut rebuilt = Vec::new();
    let (mut seen_a, mut seen_b) = (0usize, 0usize);
    for op in &ops {
        match op {
            DiffOp::Equal(i, j) => {
                assert_eq!(a[*i], b[*j]);
                assert_eq!((*i, *j), (seen_a, seen_b));
                rebuilt.push(b[*j]);
                seen_a += 1;
                seen_b += 1;
            }
            DiffOp::Delete(i) => {
                assert_eq!(*i, seen_a);
                seen_a += 1;
            }
            DiffOp::Insert(j) => {
                assert_eq!(*j, seen_b);
                rebuilt.push(b[*j]);
                seen_b += 1;
            }
        }
    }
    assert_eq!((seen_a, seen_b), (a.len(), b.len()));
    assert_eq!(rebuilt, b);
}

#[test]
fn lcs_diff_edit_scripts_rebuild_b() {
    assert_script_rebuilds(&[], &[]);
    assert_script_rebuilds(&["a"], &[]);
    assert_script_rebuilds(&[], &["a"]);
    assert_script_rebuilds(&["a", "b", "c"], &["a", "b", "c"]);
    assert_script_rebuilds(&["a", "b", "c", "d"], &["a", "x", "c", "d"]);
    assert_script_rebuilds(&["a", "b", "a", "b"], &["b", "a", "b", "a"]);
    assert_script_rebuilds(&["x", "a", "b"], &["a", "b", "y"]);
}

#[test]
fn small_edit_in_long_document_is_a_minimal_hunk() {
    let a: Vec<String> = (0..5000).map(|i| format!("line {i}")).collect();
    let mut b = a.clone();
    b[2500] = "changed".into();
    let (diff, hunks, added, removed) =
        compute_unified_diff("a", "b", &a.join("\n"), &b.join("\n"), 3);
    assert_eq!((hunks, added, removed), (1, 1, 1));
    assert!(diff.contains("@@ -2498,7 +2498,7 @@"), "{diff}");
    assert!(diff.contains("-line 2500\n+changed"));
}

#[test]
fn huge_dissimilar_documents_diff_without_a_quadratic_table() {
    // 6000 x 6000 lines would need a 36M-cell table (288 MiB); past the cap
    // the middle is reported as a block replacement instead.
    let n = 6000;
    assert!((n + 1) * (n + 1) > MAX_LCS_CELLS);
    let a: Vec<String> = (0..n).map(|i| format!("a {i}")).collect();
    let mut b: Vec<String> = (0..n).map(|i| format!("b {i}")).collect();
    b[0] = a[0].clone(); // common prefix and suffix are still kept as context
    b[n - 1] = a[n - 1].clone();
    let start = std::time::Instant::now();
    let a_refs: Vec<&str> = a.iter().map(String::as_str).collect();
    let b_refs: Vec<&str> = b.iter().map(String::as_str).collect();
    assert_script_rebuilds(&a_refs, &b_refs);
    let (_, hunks, added, removed) =
        compute_unified_diff("a", "b", &a.join("\n"), &b.join("\n"), 3);
    assert_eq!((hunks, added, removed), (1, n - 2, n - 2));
    assert!(start.elapsed() < std::time::Duration::from_secs(20));
}

// ── prompts/get needs the live document ──────────────────────────────────────

#[test]
fn prompt_get_embeds_the_live_document() {
    let ipc = MockIpc::new().on_get(
        "/content",
        Ok(json!({ "path": "/p.md", "content": "# Plan\n- step" })),
    );
    let resp = handle_prompt_get(id(1), "review_plan", &ipc);
    let text = resp.result.unwrap()["messages"][0]["content"]["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(text.ends_with("# Plan\n- step"), "{text}");
}

#[test]
fn prompt_get_without_the_app_is_an_error_not_an_empty_document() {
    let ipc = MockIpc::new().on_get("/content", Err("~/.mdopener/ipc-port not found".into()));
    let resp = handle_prompt_get(id(1), "summarize", &ipc);
    assert!(resp.result.is_none());
    let err = resp.error.unwrap();
    assert_eq!(err.code, -32000);
    assert!(
        err.message.contains("does not appear to be running"),
        "{}",
        err.message
    );
}

#[test]
fn prompt_get_with_no_open_document_is_an_error() {
    for empty in [
        json!({ "path": null, "content": null }),
        json!({ "path": null, "content": "" }),
    ] {
        let ipc = MockIpc::new().on_get("/content", Ok(empty));
        let resp = handle_prompt_get(id(1), "summarize", &ipc);
        assert!(resp.error.unwrap().message.contains("No document is open"));
    }
}

// ── open_file hands the app absolute paths ───────────────────────────────────

#[test]
fn open_file_makes_a_not_yet_existing_relative_path_absolute() {
    let ipc = MockIpc::new().on_post("/open", Ok(json!({ "ok": true })));
    let resp = tool_open_file(id(1), &json!({ "path": "drafts/new-plan.md" }), &ipc);
    assert!(resp.error.is_none());
    let expected = std::env::current_dir().unwrap().join("drafts/new-plan.md");
    let calls = ipc.calls();
    assert_eq!(
        calls[0].2.as_ref().unwrap()["path"],
        json!(expected.to_string_lossy())
    );
}

#[test]
fn hunks_carry_full_trailing_context_and_merge_when_close() {
    let a = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20";
    // Two changes 2 lines apart merge into one hunk; a far one stays separate.
    let b = a
        .replace("\n5\n", "\nfive\n")
        .replace("\n8\n", "\neight\n")
        .replace("\n18\n", "\neighteen\n");
    let (diff, hunks, added, removed) = compute_unified_diff("a", "b", a, &b, 3);
    assert_eq!((hunks, added, removed), (2, 3, 3), "{diff}");
    assert!(diff.contains("@@ -2,10 +2,10 @@"), "{diff}");
    assert!(diff.contains(" 9\n 10\n 11\n@@ -15,6 +15,6 @@"), "{diff}");
    // `a` has no final newline, which the last context line says, as in
    // `diff -u`.
    assert!(
        diff.ends_with("+eighteen\n 19\n 20\n\\ No newline at end of file"),
        "{diff}"
    );
}

// ── search_vault / text://vault-search when the app is down ─────────────────

/// Every IPC route fails the way it does when the app is not running.
fn app_down_ipc() -> MockIpc {
    MockIpc::new()
        .on_get("/", Err("ipc-port not found".into()))
        .on_post("/", Err("ipc-port not found".into()))
}

#[test]
fn search_vault_app_down_is_tool_error_not_empty_results() {
    for semantic in [json!(false), json!(true), Value::Null] {
        let mut args = json!({ "query": "anything" });
        if !semantic.is_null() {
            args["semantic"] = semantic.clone();
        }
        let resp = tool_search_vault(id(1), &args, &app_down_ipc());
        let text = tool_error_text(&resp);
        assert!(
            text.contains("does not appear to be running"),
            "semantic={semantic}: {text}"
        );
    }
}

#[test]
fn resource_read_vault_search_app_down_is_error() {
    let resp = handle_resource_read(id(1), "text://vault-search?q=anything", &app_down_ipc());
    let err = resp
        .error
        .as_ref()
        .expect("app down must be an error, not empty results");
    assert_eq!(err.code, -32000);
    assert!(
        err.message.contains("does not appear to be running"),
        "{}",
        err.message
    );
}

// ── docs/AGENTS.md matches the server ─────────────────────────────────────────

#[test]
fn agents_doc_states_the_real_tool_count_and_default_protocol() {
    let doc = include_str!("../../../../docs/AGENTS.md");
    let tools = tool_registry();
    let count = format!("exposes **{}** tools", tools.len());
    assert!(doc.contains(&count), "docs/AGENTS.md must say {count:?}");
    for t in &tools {
        let row = format!("| `{}` |", t.name);
        assert!(
            doc.contains(&row),
            "docs/AGENTS.md tool table is missing {row:?}"
        );
    }
    let default = format!("**`{}`** (default)", mdopener_mcp::DEFAULT_PROTOCOL);
    assert!(
        doc.contains(&default),
        "docs/AGENTS.md must say {default:?}"
    );
}

// ── Disk-reading tools refuse non-Markdown files (no app needed) ─────────────

/// A temp dir holding a secret `.env`, a non-Markdown `hostname`, a Markdown
/// `notes.md`, and (on Unix) a `link.md` symlink pointing at `.env`.
fn secret_fixture() -> (tempfile::TempDir, String, String, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let env = dir.path().join(".env");
    std::fs::write(&env, "OPENAI_API_KEY=sk-secret-value\n").unwrap();
    let host = dir.path().join("hostname");
    std::fs::write(&host, "box\n").unwrap();
    let notes = dir.path().join("notes.md");
    std::fs::write(&notes, "# Notes\n\nHello world.\n").unwrap();
    let link = dir.path().join("link.md");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&env, &link).unwrap();
    #[cfg(not(unix))]
    std::fs::write(&link, "OPENAI_API_KEY=sk-secret-value\n").unwrap();
    let s = |p: std::path::PathBuf| p.to_string_lossy().into_owned();
    (dir, s(env), s(host), s(notes), s(link))
}

fn assert_refused(resp: &mdopener_mcp::Response, label: &str) {
    let text = tool_error_text(resp);
    assert!(
        !text.contains("sk-secret-value"),
        "{label}: leaked secret: {text}"
    );
    assert!(
        text.contains("Markdown"),
        "{label}: unclear message: {text}"
    );
}

#[test]
fn read_tools_refuse_dotfiles_and_non_markdown_paths() {
    let (_dir, env, host, notes, link) = secret_fixture();
    let ipc = MockIpc::new();
    for (a, b) in [(&env, &host), (&notes, &env), (&host, &notes)] {
        let resp = call("diff_documents", json!({ "path_a": a, "path_b": b }), &ipc);
        assert_refused(&resp, &format!("diff_documents {a} {b}"));
    }
    for bad in [&env, &host] {
        for tool in ["export_text", "export_metadata"] {
            let resp = call(tool, json!({ "path": bad }), &ipc);
            assert_refused(&resp, &format!("{tool} {bad}"));
        }
    }
    #[cfg(unix)]
    {
        let resp = call(
            "diff_documents",
            json!({ "path_a": link, "path_b": notes }),
            &ipc,
        );
        assert_refused(&resp, "diff_documents via .md symlink");
        for tool in ["export_text", "export_metadata"] {
            let resp = call(tool, json!({ "path": link }), &ipc);
            assert_refused(&resp, &format!("{tool} via .md symlink"));
        }
    }
    let _ = link;
}

#[test]
fn read_tools_still_read_markdown_paths() {
    let (_dir, _env, _host, notes, _link) = secret_fixture();
    let ipc = MockIpc::new();
    let resp = call(
        "diff_documents",
        json!({ "path_a": notes, "path_b": notes }),
        &ipc,
    );
    assert!(!is_error(&resp), "{:?}", resp.result);
    let resp = call("export_text", json!({ "path": notes }), &ipc);
    assert!(!is_error(&resp));
    assert!(content_text(&resp)["text"]
        .as_str()
        .unwrap()
        .contains("Hello world."));
    let resp = call("export_metadata", json!({ "path": notes }), &ipc);
    assert!(!is_error(&resp));
    assert_eq!(content_text(&resp)["word_count"], json!(3));
}

#[cfg(unix)]
#[test]
fn edit_canvas_refuses_a_canvas_symlink_to_a_non_canvas_file() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join(".env");
    std::fs::write(&target, "{\"nodes\":[],\"edges\":[]}").unwrap();
    let link = dir.path().join("board.canvas");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let resp = call(
        "edit_canvas",
        json!({ "path": link.to_string_lossy(), "ops": [] }),
        &MockIpc::new(),
    );
    let text = tool_error_text(&resp);
    assert!(text.contains(".canvas"), "{text}");
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "{\"nodes\":[],\"edges\":[]}"
    );
}

// ════════════════════════════════════════════════════════════════════════════
// export output_path is written by the app and confirmed on disk
// ════════════════════════════════════════════════════════════════════════════

/// Stands in for the app: on `POST /export` it writes `outputPath` (as the
/// frontend does through `write_markdown_file`), when `write` is true.
struct ExportingApp {
    write: bool,
    posts: Mutex<Vec<Value>>,
}

impl IpcClient for ExportingApp {
    fn get(&self, path: &str) -> Result<Value, String> {
        Err(format!("unexpected GET {path}"))
    }
    fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        assert_eq!(path, "/export");
        if self.write {
            if let Some(out) = body["outputPath"].as_str() {
                std::fs::write(out, "<!doctype html><p>hi</p>").unwrap();
            }
        }
        self.posts.lock().unwrap().push(body);
        Ok(json!({ "ok": true }))
    }
}

fn exporting_app(write: bool) -> ExportingApp {
    ExportingApp {
        write,
        posts: Mutex::new(vec![]),
    }
}

const SHORT: std::time::Duration = std::time::Duration::from_millis(300);

#[test]
fn export_output_path_returns_once_the_file_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let out = std::fs::canonicalize(dir.path()).unwrap().join("plan.html");
    let app = exporting_app(true);
    let resp = tool_export_with(
        id(1),
        &json!({ "format": "html", "output_path": out.to_string_lossy() }),
        &app,
        SHORT,
    );
    assert!(!is_error(&resp), "{resp:?}");
    let v = content_text(&resp);
    assert_eq!(v["path"], json!(out.to_string_lossy()));
    assert_eq!(v["bytes"], json!(24));
}

#[test]
fn export_output_path_errors_when_the_app_never_writes_it() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("plan.html");
    // A stale export from earlier must not count as this one.
    std::fs::write(&out, "old").unwrap();
    let resp = tool_export_with(
        id(1),
        &json!({ "format": "html", "output_path": out.to_string_lossy() }),
        &exporting_app(false),
        SHORT,
    );
    let text = tool_error_text(&resp);
    assert!(
        text.contains("did not write") && text.contains("Read view"),
        "{text}"
    );
}

/// Stands in for an app whose window reports the headless export failed:
/// it answers `/export` with the window's reason, read with a longer timeout.
struct FailingExportApp {
    read_timeout: Mutex<Option<std::time::Duration>>,
}

impl IpcClient for FailingExportApp {
    fn get(&self, path: &str) -> Result<Value, String> {
        Err(format!("unexpected GET {path}"))
    }
    fn post(&self, path: &str, _body: Value) -> Result<Value, String> {
        Err(format!(
            "a headless export must wait longer than 5 s for {path}"
        ))
    }
    fn post_within(
        &self,
        path: &str,
        _body: Value,
        read_timeout: std::time::Duration,
    ) -> Result<Value, String> {
        assert_eq!(path, "/export");
        *self.read_timeout.lock().unwrap() = Some(read_timeout);
        Ok(json!({
            "ok": false,
            "path": "/out/plan.html",
            "error": "Export failed in the app: Switch to Read view before exporting."
        }))
    }
}

#[test]
fn export_output_path_returns_the_windows_error_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("plan.html");
    let app = FailingExportApp {
        read_timeout: Mutex::new(None),
    };
    let deadline = std::time::Duration::from_secs(30);
    let started = std::time::Instant::now();
    let resp = tool_export_with(
        id(1),
        &json!({ "format": "html", "output_path": out.to_string_lossy() }),
        &app,
        deadline,
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    let text = tool_error_text(&resp);
    assert!(text.contains("Switch to Read view"), "{text}");
    let waited = app.read_timeout.lock().unwrap().expect("post_within used");
    assert!(
        waited > deadline,
        "the app's answer must outlast its own wait"
    );
}

#[test]
fn export_output_path_resolves_a_symlinked_directory() {
    let dir = tempfile::tempdir().unwrap();
    let real = std::fs::canonicalize(dir.path()).unwrap().join("real");
    std::fs::create_dir(&real).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, dir.path().join("link")).unwrap();
    #[cfg(not(unix))]
    return;
    let app = exporting_app(true);
    let resp = tool_export_with(
        id(1),
        &json!({ "format": "epub", "output_path": dir.path().join("link/book.epub").to_string_lossy() }),
        &app,
        SHORT,
    );
    assert!(!is_error(&resp), "{resp:?}");
    let posted = app.posts.lock().unwrap()[0]["outputPath"].clone();
    assert_eq!(posted, json!(real.join("book.epub").to_string_lossy()));
}

#[test]
fn export_output_path_rejects_unsafe_or_unsupported_targets_without_ipc() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let cases = [
        ("pdf", d.join("out.pdf"), "print dialog"),
        ("html", d.join(".bashrc"), "must name a html file"),
        ("html", d.join("notes.md"), "must name a html file"),
        ("docx", d.join("out.html"), "must name a docx file"),
        (
            "html",
            d.join("missing/out.html"),
            "directory does not exist",
        ),
    ];
    for (format, path, want) in cases {
        let app = exporting_app(true);
        let resp = tool_export_with(
            id(1),
            &json!({ "format": format, "output_path": path.to_string_lossy() }),
            &app,
            SHORT,
        );
        let err = resp
            .error
            .as_ref()
            .unwrap_or_else(|| panic!("{format} {path:?}: {resp:?}"));
        assert_eq!(err.code, -32602);
        assert!(
            err.message.contains(want),
            "{format} {path:?}: {}",
            err.message
        );
        assert!(
            app.posts.lock().unwrap().is_empty(),
            "must not reach the app"
        );
    }
}

#[test]
fn export_without_output_path_still_opens_the_dialog() {
    let app = exporting_app(false);
    let resp = tool_export_with(id(1), &json!({ "format": "pdf" }), &app, SHORT);
    assert!(!is_error(&resp));
    assert_eq!(content_text(&resp)["dialog"], json!(true));
}

// ════════════════════════════════════════════════════════════════════════════
// Paths sent to the app are resolved the way the agent means them
// ════════════════════════════════════════════════════════════════════════════

/// `<tmp>/link/plan.md` where `link -> real`: the app holds the canonical
/// `<tmp>/real/plan.md`, and request_review / open_file send that form.
fn symlinked_plan() -> (tempfile::TempDir, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let real = std::fs::canonicalize(dir.path()).unwrap().join("real");
    std::fs::create_dir(&real).unwrap();
    std::fs::write(real.join("plan.md"), "# Plan\n").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, dir.path().join("link")).unwrap();
    let via_link = dir
        .path()
        .join("link/./plan.md")
        .to_string_lossy()
        .into_owned();
    let canonical = real.join("plan.md").to_string_lossy().into_owned();
    (dir, via_link, canonical)
}

#[cfg(unix)]
#[test]
fn get_user_annotations_looks_up_the_canonical_path() {
    let (_dir, via_link, canonical) = symlinked_plan();
    let ipc = MockIpc::new().on_get("/annotations", Ok(json!({ "verdict": null })));
    tool_get_annotations(id(1), &json!({ "path": via_link }), &ipc);
    let (_, path, _) = ipc.calls().remove(0);
    assert_eq!(
        path,
        format!("/annotations?path={}", urlencoding::encode(&canonical))
    );
}

#[cfg(unix)]
#[test]
fn edit_tools_assert_the_canonical_path() {
    let (_dir, via_link, canonical) = symlinked_plan();
    let ipc = MockIpc::new()
        .on_post("/edit", Ok(json!({ "ok": true })))
        .on_post("/stream-edit", Ok(json!({ "ok": true })));
    tool_edit_document(
        id(1),
        &json!({ "find": "a", "replace": "b", "path": via_link }),
        &ipc,
    );
    tool_stream_edit(
        id(2),
        &json!({ "find": "a", "replace": "b", "path": via_link }),
        &ipc,
    );
    tool_stream_edit_apply(
        id(3),
        &json!({ "edit_id": "e", "find": "a", "replace": "b", "path": via_link }),
        &ipc,
    );
    // No open document is reported here, so the canonical path is sent.
    let posts: Vec<_> = ipc
        .calls()
        .into_iter()
        .filter(|(m, _, _)| m == "POST")
        .collect();
    assert_eq!(posts.len(), 3);
    for (_, p, body) in posts {
        assert_eq!(body.unwrap()["path"], json!(canonical), "{p}");
    }
}

/// `preview: false` applies the edit at once; the result must say so, or an
/// agent that then calls stream_edit_apply edits the document twice.
#[test]
fn stream_edit_reports_whether_it_applied_the_edit() {
    let reply = json!({ "ok": true, "editId": "sedit_1", "diff": "", "matchCount": 1 });
    let ipc = MockIpc::new().on_post("/stream-edit", Ok(reply));
    let previewed = content_text(&tool_stream_edit(
        id(1),
        &json!({ "find": "a", "replace": "b" }),
        &ipc,
    ));
    assert_eq!(previewed["applied"], false, "{previewed}");
    let applied = content_text(&tool_stream_edit(
        id(2),
        &json!({ "find": "a", "replace": "b", "preview": false }),
        &ipc,
    ));
    assert_eq!(applied["applied"], true, "{applied}");
}

/// The app re-finds `find` in the live document, so `edit_id` only
/// correlates with a preview; applying without one is allowed.
#[test]
fn stream_edit_apply_does_not_need_an_edit_id() {
    let ipc = MockIpc::new().on_post(
        "/stream-edit-apply",
        Ok(json!({ "ok": true, "replaced": 1, "matchIndex": 1 })),
    );
    let resp = tool_stream_edit_apply(
        id(1),
        &json!({ "find": "a", "replace": "b", "match_index": 1 }),
        &ipc,
    );
    assert!(resp.error.is_none(), "{:?}", resp.error);
    assert_eq!(content_text(&resp)["replaced"], 1);
    let required = tool_registry()
        .into_iter()
        .find(|t| t.name == "stream_edit_apply")
        .unwrap()
        .to_json()["inputSchema"]["required"]
        .clone();
    assert_eq!(required, json!(["find", "replace"]));
}

/// The frontend checks a stream edit's `path` against the open document's
/// path as a string, and a document opened by drag and drop, a dialog or the
/// file tree keeps the (symlinked) path it was opened by. Naming that file,
/// by that path or any other, must assert the app's own spelling, not the
/// canonical one the app would reject as "not the currently open document".
#[cfg(unix)]
#[test]
fn stream_edit_tools_assert_the_open_documents_own_path() {
    use mdopener_mcp::stream_edit_path;
    let (dir, via_link, canonical) = symlinked_plan();
    let opened_as = dir
        .path()
        .join("link/plan.md")
        .to_string_lossy()
        .into_owned();
    let ipc = MockIpc::new()
        .on_get(
            "/content",
            Ok(json!({ "path": opened_as, "content": "# Plan\n" })),
        )
        .on_post("/stream-edit", Ok(json!({ "ok": true })));
    for raw in [&opened_as, &via_link, &canonical] {
        assert_eq!(stream_edit_path(raw, &ipc), opened_as, "{raw}");
    }
    tool_stream_edit(
        id(1),
        &json!({ "find": "a", "replace": "b", "path": canonical }),
        &ipc,
    );
    tool_stream_edit_apply(
        id(2),
        &json!({ "edit_id": "e", "find": "a", "replace": "b", "path": via_link }),
        &ipc,
    );
    let posts: Vec<_> = ipc
        .calls()
        .into_iter()
        .filter(|(m, _, _)| m == "POST")
        .collect();
    assert_eq!(posts.len(), 2);
    for (_, p, body) in posts {
        assert_eq!(body.unwrap()["path"], json!(opened_as), "{p}");
    }

    // Another file is still sent resolved, so the app reports the mismatch.
    let other = std::fs::canonicalize(dir.path()).unwrap().join("other.md");
    std::fs::write(&other, "x").unwrap();
    let other = other.to_string_lossy().into_owned();
    assert_eq!(stream_edit_path(&other, &ipc), other);
}

// ── Agent-workflow regressions ────────────────────────────────────────────────

/// `text://vault-search?q=my+topic` (the form resources/list documents) must
/// search for "my topic", not the literal "my+topic"; `%2B` is a real plus.
#[test]
fn vault_search_resource_decodes_plus_as_space() {
    use mdopener_mcp::handle_resource_read;
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    for (uri, want) in [
        ("text://vault-search?q=my+topic", "my topic"),
        ("text://vault-search?q=c%2B%2B+notes", "c++ notes"),
    ] {
        let resp = handle_resource_read(id(1), uri, &ipc);
        let payload: Value = serde_json::from_str(
            resp.result.as_ref().unwrap()["contents"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["query"], want, "{uri}");
    }
    assert!(ipc
        .calls()
        .iter()
        .any(|(_, p, _)| p.starts_with("/search?q=my%20topic")));
}

/// Plain text keeps comparisons, intraword underscores and spaced
/// asterisks; tags and emphasis markers still go, autolinks keep the URL.
#[test]
fn export_text_keeps_literal_angle_brackets_underscores_and_asterisks() {
    use mdopener_mcp::strip_markdown;
    assert_eq!(
        strip_markdown("if a < b and c > d then **stop**"),
        "if a < b and c > d then stop"
    );
    assert_eq!(
        strip_markdown("set MAX_RETRY_COUNT in my_config"),
        "set MAX_RETRY_COUNT in my_config"
    );
    assert_eq!(
        strip_markdown("2 * 3 = 6, _emphasis_ and *it*"),
        "2 * 3 = 6, emphasis and it"
    );
    assert_eq!(strip_markdown("a <span>b</span> <!-- c --> d"), "a b  d");
    assert_eq!(
        strip_markdown("see <https://example.com/x>"),
        "see https://example.com/x"
    );
}

/// A table inside a blockquote or a list item was not detected (its
/// delimiter row starts with `>` or a list marker), so its rows came back
/// with their pipes and the `|---|` row kept.
#[test]
fn export_text_reads_tables_in_blockquotes_and_lists() {
    use mdopener_mcp::strip_markdown;
    assert_eq!(
        strip_markdown(
            "> Note\n>\n> | Name | Role |\n> |------|------|\n> | Zoë | **Lead** |\n\nAfter"
        ),
        "Note\n\nName\tRole\nZoë\tLead\n\nAfter"
    );
    assert_eq!(
        strip_markdown("> > | a | b |\n> > |---|---|\n> > | 1 | 2 |"),
        "a\tb\n1\t2",
        "nested blockquote"
    );
    assert_eq!(
        strip_markdown("- Item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n- Next"),
        "Item\n\na\tb\n1\t2\nNext",
        "table indented under a list item"
    );
    assert_eq!(
        strip_markdown("1. | a | b |\n   |---|---|\n   | 1 | 2 |"),
        "a\tb\n1\t2",
        "table starting on the list marker line"
    );
    assert_eq!(
        strip_markdown("> - | a | b |\n>   |---|---|\n>   | 1 | 2 |"),
        "a\tb\n1\t2",
        "list inside a blockquote"
    );
    assert_eq!(
        strip_markdown("> a | b\n\nc"),
        "a | b\n\nc",
        "a quoted line with a pipe and no delimiter row stays text"
    );
}

/// Strikethrough keeps its text without the tildes, table rows become
/// tab-separated cells with the delimiter row gone, and footnotes read as
/// `[1]` at the reference and `[1] text` at the definition.
#[test]
fn export_text_cleans_strikethrough_tables_and_footnotes() {
    use mdopener_mcp::strip_markdown;
    assert_eq!(
        strip_markdown("Ship ~~Friday~~ Monday, ~5 min, a ~~ b, ~/x"),
        "Ship Friday Monday, ~5 min, a ~~ b, ~/x"
    );
    let table = "Intro\n\n| Name | **Role** |\n|:-----|-------:|\n| Zoë | Lead \\| QA |\n| [Al](http://a.b) | `dev` |\n\nAfter | not a table\n";
    assert_eq!(
        strip_markdown(table),
        "Intro\n\nName\tRole\nZoë\tLead | QA\nAl\tdev\n\nAfter | not a table"
    );
    assert_eq!(
        strip_markdown("a | b\n--- | ---\nc | d"),
        "a\tb\nc\td",
        "a table without outer pipes"
    );
    assert_eq!(
        strip_markdown("Claim.[^1] More[^note].\n\n[^1]: The **source**.\n[^note]: Second."),
        "Claim.[1] More[note].\n\n[1] The source.\n[note] Second."
    );
    // Code keeps everything as written.
    assert_eq!(
        strip_markdown("```\n| a | b |\n|---|---|\n~~x~~ [^1]\n```"),
        "| a | b |\n|---|---|\n~~x~~ [^1]"
    );
}

/// `#tag` lines (Obsidian tags) and shebangs are not headings.
#[test]
fn export_metadata_headings_need_a_space_after_the_hashes() {
    use mdopener_mcp::extract_headings;
    let h = extract_headings("# Title\n#project #todo\n##\tTabbed\n#!/bin/sh\n####### seven\n");
    assert_eq!(
        h,
        vec![
            json!({"level": 1, "text": "Title"}),
            json!({"level": 2, "text": "Tabbed"})
        ]
    );
}

/// An ATX heading's closing `#`s are not part of its text (CommonMark), but
/// a `#` that ends a word (`C#`) is.
#[test]
fn heading_closing_hashes_are_not_heading_text() {
    use mdopener_mcp::{extract_headings, strip_markdown};
    let h = extract_headings("# Title #\n## Steps ###  \n### Learn C#\n## Only ##\n");
    let texts: Vec<&str> = h.iter().map(|h| h["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["Title", "Steps", "Learn C#", "Only"]);
    assert_eq!(strip_markdown("# Title #\n\nBody").trim(), "Title\n\nBody");
    assert_eq!(strip_markdown("## Learn C#").trim(), "Learn C#");
}

/// With zero context, an insertion's `-` range names the line it follows
/// (and a deletion's `+` range likewise), so `patch` applies it in place,
/// not at the top of the file.
#[test]
fn diff_zero_context_hunks_name_the_preceding_line() {
    use mdopener_mcp::compute_unified_diff;
    let (d, hunks, _, _) = compute_unified_diff("a", "b", "1\n2\n3\n", "1\n2\nnew\n3\n", 0);
    assert_eq!(hunks, 1);
    assert!(d.contains("@@ -2,0 +3,1 @@"), "{d}");
    let (d, _, _, _) = compute_unified_diff("a", "b", "1\n2\n3\n", "1\n3\n", 0);
    assert!(d.contains("@@ -2,1 +1,0 @@"), "{d}");
    // With context the headers are unchanged.
    let (d, _, _, _) = compute_unified_diff("a", "b", "1\n2\n3\n", "1\n2\nnew\n3\n", 1);
    assert!(d.contains("@@ -2,2 +2,3 @@"), "{d}");
}

/// A huge `context_lines` must not overflow (a debug build panicked and took
/// the whole MCP session down).
#[test]
fn diff_documents_huge_context_does_not_overflow() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.md");
    let b = dir.path().join("b.md");
    std::fs::File::create(&a)
        .unwrap()
        .write_all(b"x\ny\n")
        .unwrap();
    std::fs::File::create(&b)
        .unwrap()
        .write_all(b"x\nz\n")
        .unwrap();
    let resp = mdopener_mcp::tool_diff_documents(
        id(1),
        &json!({ "path_a": a, "path_b": b, "context_lines": u64::MAX }),
    );
    assert!(!is_error(&resp));
    assert_eq!(content_text(&resp)["hunks"], 1);
}

/// Two server processes (two agents) appending to one session must not drop
/// each other's messages: the cached copy is never written back over newer
/// disk state, and reads see what the other process appended.
#[test]
fn conversation_store_keeps_messages_appended_by_another_process() {
    use mdopener_mcp::persist_session;
    let sess = format!("cross-process-{}", unique_session());
    store_append_message(&sess, "agent", "from this process", vec![]).unwrap();
    // The "other process" appends straight to the persisted log.
    let mut log = load_session_from_disk(&sess).unwrap();
    let mut other = log.messages[0].clone();
    other.id = "msg-other".into();
    other.content = "from another process".into();
    log.messages.push(other);
    persist_session(&sess, &log).unwrap();

    let ctx = store_get_context(&sess, 20).unwrap();
    assert_eq!(ctx.len(), 2, "reads must see the other process's message");
    store_append_message(&sess, "agent", "again from this process", vec![]).unwrap();
    let on_disk: Vec<String> = load_session_from_disk(&sess)
        .unwrap()
        .messages
        .into_iter()
        .map(|m| m.content)
        .collect();
    assert_eq!(
        on_disk,
        [
            "from this process",
            "from another process",
            "again from this process"
        ]
    );
    if let Some(p) = session_file_path(&sess) {
        let _ = std::fs::remove_file(p);
    }
}

/// get_user_annotations sends an absolute path: the app resolves relative
/// ones against its own, unrelated working directory.
#[test]
fn get_user_annotations_sends_an_absolute_path() {
    let ipc = MockIpc::new().on_get("/annotations", Ok(json!({ "tasks": [] })));
    let _ = tool_get_annotations(id(1), &json!({ "path": "notes/plan.md" }), &ipc);
    let calls = ipc.calls();
    let cwd = std::env::current_dir().unwrap();
    let want = urlencoding::encode(cwd.join("notes/plan.md").to_str().unwrap()).into_owned();
    assert_eq!(calls[0].1, format!("/annotations?path={want}"));
}

/// A blocking review returns `pending` with its id once `wait_ms` passes,
/// instead of blocking past the MCP client's request timeout, and the agent
/// resumes it with `review_id` (no second registration).
#[test]
fn request_review_returns_pending_before_client_timeouts_and_resumes() {
    use mdopener_mcp::{tool_request_review_with, DEFAULT_REVIEW_WAIT_MS};
    use std::time::Duration;
    const { assert!(DEFAULT_REVIEW_WAIT_MS < 60_000) };
    let ipc = MockIpc::new()
        .on_post("/review", Ok(json!({ "ok": true })))
        .on_get("/review/result", Ok(json!({ "status": "pending" })));
    let resp = tool_request_review_with(
        id(1),
        &json!({ "content": "plan", "wait_ms": 1000 }),
        &ipc,
        Duration::from_millis(50),
    );
    let v = content_text(&resp);
    assert_eq!(v["status"], "pending", "{v}");
    let review_id = v["reviewId"].as_str().unwrap().to_string();

    let done = MockIpc::new().on_get(
        "/review/result",
        Ok(json!({ "status": "done", "verdict": "approved", "comments": "ok" })),
    );
    let resp = tool_request_review_with(
        id(2),
        &json!({ "review_id": review_id }),
        &done,
        Duration::from_millis(10),
    );
    let v = content_text(&resp);
    assert_eq!(v["verdict"], "approved", "{v}");
    assert_eq!(v["reviewId"], review_id.as_str());
    assert!(
        done.calls().iter().all(|(m, _, _)| m == "GET"),
        "resume must not re-register"
    );
}

/// A resumed review stops at the end of its window: the app keeps a review
/// replaced in its panel by a newer one as `pending` forever, so resuming it
/// by `review_id` must end with `timeout` once the window the id records has
/// closed, instead of returning `pending` (and inviting another resume) on
/// every call.
#[test]
fn resumed_review_times_out_when_its_window_has_closed() {
    use mdopener_mcp::{review_window_end_ms, tool_request_review_with};
    use std::time::Duration;
    let ipc = MockIpc::new()
        .on_post("/review", Ok(json!({ "ok": true })))
        .on_get("/review/result", Ok(json!({ "status": "pending" })));
    let resp = tool_request_review_with(
        id(1),
        &json!({ "content": "plan", "timeout_ms": 5_000, "wait_ms": 1_000 }),
        &ipc,
        Duration::from_millis(50),
    );
    let v = content_text(&resp);
    assert_eq!(v["status"], "pending", "{v}");
    let review_id = v["reviewId"].as_str().unwrap().to_string();
    let end = review_window_end_ms(&review_id).expect("minted ids carry their window end");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    assert!(
        end > now && end <= now + 5_000,
        "window end {end} vs now {now}"
    );

    // A review whose window closed long ago (same id shape) times out on the
    // resume instead of reporting pending for the full wait.
    let expired = format!("rev_1_00000001_{}", now - 60_000);
    let started = std::time::Instant::now();
    let resp = tool_request_review_with(
        id(2),
        &json!({ "review_id": expired, "wait_ms": 50_000 }),
        &ipc,
        Duration::from_millis(50),
    );
    let v = content_text(&resp);
    assert_eq!(v["verdict"], "timeout", "{v}");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );

    // A verdict the app recorded at the window's close is still read.
    let dismissed = MockIpc::new().on_get(
        "/review/result",
        Ok(json!({ "status": "dismissed", "verdict": "dismissed", "comments": null })),
    );
    let resp = tool_request_review_with(
        id(3),
        &json!({ "review_id": format!("rev_1_00000001_{}", now - 60_000) }),
        &dismissed,
        Duration::from_millis(50),
    );
    assert_eq!(content_text(&resp)["verdict"], "dismissed");

    // Ids without a window end (an older server's) keep the wait_ms behaviour.
    assert_eq!(review_window_end_ms("rev_123_0000abcd"), None);
    assert_eq!(review_window_end_ms("custom"), None);
    let resp = tool_request_review_with(
        id(4),
        &json!({ "review_id": "rev_123_0000abcd", "wait_ms": 1_000 }),
        &ipc,
        Duration::from_millis(50),
    );
    assert_eq!(content_text(&resp)["status"], "pending");
}

/// The session log is replaced by a rename, never rewritten in place: another
/// server process re-reads it on every get and append, and a torn read there
/// (truncated JSON) made that process write its own copy back over the log.
#[cfg(unix)]
#[test]
fn persist_session_replaces_the_log_atomically() {
    use mdopener_mcp::persist_session;
    let sess = unique_session();
    store_append_message(&sess, "agent", "first", vec![]).unwrap();
    let path = session_file_path(&sess).unwrap();
    // A reader holding the old file (here, a hard link to it) keeps a whole,
    // parseable log while the next version is written.
    let reader = path.with_extension("reader");
    std::fs::hard_link(&path, &reader).unwrap();
    let before = std::fs::read_to_string(&reader).unwrap();

    let mut log = load_session_from_disk(&sess).unwrap();
    let mut next = log.messages[0].clone();
    next.id = "msg-next".into();
    next.content = "second".into();
    log.messages.push(next);
    persist_session(&sess, &log).unwrap();

    assert_eq!(
        std::fs::read_to_string(&reader).unwrap(),
        before,
        "written in place"
    );
    assert_eq!(load_session_from_disk(&sess).unwrap().messages.len(), 2);
    let dir = path.parent().unwrap();
    let stem = path.file_name().unwrap().to_str().unwrap().to_string();
    let leftovers: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(&stem) && n.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    let _ = std::fs::remove_file(&reader);
    let _ = std::fs::remove_file(&path);
}

/// A resumed review whose window closed with no verdict reports `timeout`,
/// not a null verdict.
#[test]
fn request_review_resumed_after_its_window_reports_timeout() {
    use mdopener_mcp::tool_request_review_with;
    let ipc = MockIpc::new().on_get(
        "/review/result",
        Ok(json!({ "status": "timeout", "verdict": null, "comments": null })),
    );
    let resp = tool_request_review_with(
        id(1),
        &json!({ "review_id": "rev_1" }),
        &ipc,
        std::time::Duration::from_millis(10),
    );
    let v = content_text(&resp);
    assert_eq!(v["verdict"], "timeout", "{v}");
    assert_eq!(v["reviewId"], "rev_1");
}

/// A verdict the human gave after the window closed is reported, but marked
/// `late` with a note: an earlier call may already have said `timeout`.
#[test]
fn request_review_marks_a_late_verdict() {
    use mdopener_mcp::tool_request_review_with;
    let late = MockIpc::new().on_get(
        "/review/result",
        Ok(json!({ "status": "approved", "verdict": "approved", "comments": "ok", "late": true })),
    );
    let resp = tool_request_review_with(
        id(1),
        &json!({ "review_id": "rev_1" }),
        &late,
        std::time::Duration::from_millis(10),
    );
    let v = content_text(&resp);
    assert_eq!(v["verdict"], "approved", "{v}");
    assert_eq!(v["late"], true, "{v}");
    assert!(
        v["message"]
            .as_str()
            .unwrap()
            .contains("after the review window closed"),
        "{v}"
    );

    let on_time = MockIpc::new().on_get(
        "/review/result",
        Ok(json!({ "status": "approved", "verdict": "approved", "comments": null, "late": false })),
    );
    let resp = tool_request_review_with(
        id(2),
        &json!({ "review_id": "rev_2" }),
        &on_time,
        std::time::Duration::from_millis(10),
    );
    let v = content_text(&resp);
    assert_eq!(v["verdict"], "approved", "{v}");
    assert!(v.get("late").is_none(), "{v}");
}

/// A review a newer one replaced in the panel ends at once as `superseded`
/// (naming its replacement), instead of waiting out its window as a timeout.
#[test]
fn request_review_reports_a_superseded_review_at_once() {
    use mdopener_mcp::tool_request_review_with;
    let ipc = MockIpc::new()
        .on_post("/review", Ok(json!({ "ok": true })))
        .on_get(
            "/review/result",
            Ok(json!({
                "status": "superseded",
                "verdict": "superseded",
                "comments": null,
                "late": false,
                "supersededBy": "rev_newer"
            })),
        );
    let started = std::time::Instant::now();
    let resp = tool_request_review_with(
        id(1),
        &json!({ "content": "# Plan", "timeout_ms": 600_000 }),
        &ipc,
        std::time::Duration::from_millis(10),
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert!(!is_error(&resp), "{resp:?}");
    let v = content_text(&resp);
    assert_eq!(v["verdict"], "superseded", "{v}");
    assert_eq!(v["supersededBy"], "rev_newer", "{v}");
    assert!(
        v["message"]
            .as_str()
            .unwrap()
            .contains("request_review again"),
        "{v}"
    );
}

// ── Disk reads only open regular files ────────────────────────────────────────

/// Run `f` on a worker thread and fail (instead of hanging the suite) when it
/// does not return within a few seconds.
#[cfg(unix)]
fn within_seconds<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .unwrap_or_else(|_| panic!("{what} hung instead of refusing a non-regular file"))
}

/// A FIFO named like a document (`x.md`, `x.canvas`) must be refused, not
/// opened: opening a FIFO for reading blocks until a writer appears, which
/// hung the whole MCP session.
#[cfg(unix)]
#[test]
fn disk_reading_tools_refuse_a_fifo_instead_of_hanging() {
    let dir = tempfile::tempdir().unwrap();
    let dir = std::fs::canonicalize(dir.keep()).unwrap();
    let fifo_md = dir.join("x.md");
    let fifo_canvas = dir.join("x.canvas");
    let real = dir.join("real.md");
    std::fs::write(&real, "# Real\n").unwrap();
    for p in [&fifo_md, &fifo_canvas] {
        let status = std::process::Command::new("mkfifo")
            .arg(p)
            .status()
            .unwrap();
        assert!(status.success(), "mkfifo failed");
    }
    let md = fifo_md.to_string_lossy().into_owned();
    let canvas = fifo_canvas.to_string_lossy().into_owned();
    let real = real.to_string_lossy().into_owned();

    let (m, r) = (md.clone(), real.clone());
    let resp = within_seconds("diff_documents", move || {
        mdopener_mcp::tool_diff_documents(id(1), &json!({ "path_a": r, "path_b": m }))
    });
    assert!(tool_error_text(&resp).contains("regular file"), "{resp:?}");

    let m = md.clone();
    let resp = within_seconds("export_text", move || {
        mdopener_mcp::tool_export_text(id(2), &json!({ "path": m }), &MockIpc::new())
    });
    assert!(tool_error_text(&resp).contains("regular file"), "{resp:?}");

    let m = md.clone();
    let resp = within_seconds("export_metadata", move || {
        mdopener_mcp::tool_export_metadata(id(3), &json!({ "path": m }), &MockIpc::new())
    });
    assert!(tool_error_text(&resp).contains("regular file"), "{resp:?}");

    let c = canvas.clone();
    let resp = within_seconds("edit_canvas", move || {
        mdopener_mcp::tool_edit_canvas(
            id(4),
            &json!({ "path": c, "ops": [{ "type": "delete_node", "id": "n" }] }),
        )
    });
    assert!(tool_error_text(&resp).contains("regular file"), "{resp:?}");

    // The vault/recents paths come from the app, so a FIFO there must not
    // hang resources/read, the recent-documents resource or the local grep.
    let vault = json!({ "files": [{ "path": md, "name": "x.md" }], "recents": [md] });
    let (v, m) = (vault.clone(), md.clone());
    let resp = within_seconds("resources/read file://", move || {
        let ipc = MockIpc::new().on_get("/vault", Ok(v));
        handle_resource_read(id(5), &format!("file://{m}"), &ipc)
    });
    let err = resp.error.expect("reading a FIFO resource must fail");
    assert!(err.message.contains("regular file"), "{}", err.message);

    let v = vault.clone();
    let resp = within_seconds("mdopener://recent-documents", move || {
        let ipc = MockIpc::new().on_get("/vault", Ok(v));
        handle_resource_read(id(6), "mdopener://recent-documents", &ipc)
    });
    assert!(resp.error.is_none(), "{:?}", resp.error);

    let v = vault.clone();
    let found = within_seconds("grep_vault", move || {
        let ipc = MockIpc::new().on_get("/vault", Ok(v));
        mdopener_mcp::grep_vault("anything", 10, &ipc)
    });
    assert_eq!(found.unwrap(), Vec::<Value>::new());
    let _ = std::fs::remove_dir_all(&dir);
}

// ── Session ids map to distinct files ─────────────────────────────────────────

/// `a.b` and `a_b` used to sanitize to the same `a_b.json`, so two sessions
/// shared (and overwrote) one memory store.
#[test]
fn session_ids_that_used_to_sanitize_alike_get_separate_files() {
    let base = unique_session();
    let ids = [
        format!("{base}.x"),
        format!("{base}_x"),
        format!("{base}/x"),
        format!("{base}%2Ex"),
        format!("{base}é"),
    ];
    let mut paths = std::collections::HashSet::new();
    for sid in &ids {
        let path = session_file_path(sid).unwrap();
        assert!(paths.insert(path.clone()), "{sid} shares {path:?}");
        let dir = mdopener_mcp::sessions_dir();
        assert_eq!(path.parent(), dir.as_deref(), "{sid}");
        let resp = tool_save_conversation_message(
            id(1),
            &json!({ "session_id": sid, "role": "agent", "content": format!("only in {sid}") }),
        );
        assert!(!is_error(&resp), "{resp:?}");
    }
    for sid in &ids {
        let ctx = store_get_context(sid, 20).unwrap();
        let contents: Vec<_> = ctx.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(contents, [format!("only in {sid}")], "{sid}");
        let _ = std::fs::remove_file(session_file_path(sid).unwrap());
    }
    // Ids that were already file-name safe keep their file.
    let plain = session_file_path(&base).unwrap();
    let want = format!("{base}.json");
    assert_eq!(plain.file_name().unwrap().to_str(), Some(want.as_str()));
}

/// Where the file system still folds two ids onto one file (case-insensitive
/// volumes: `Plan` and `plan`), reads never return the other session's
/// messages and appends refuse rather than mix the two logs.
#[test]
fn session_file_holding_another_ids_messages_is_not_shared() {
    use mdopener_mcp::{persist_session, ConversationMessage, SessionLog};
    let sid = unique_session();
    let other = ConversationMessage {
        id: "msg-other".into(),
        session_id: format!("{sid}-other"),
        role: "agent".into(),
        content: "belongs to another session".into(),
        cited_docs: vec![],
        timestamp_ms: 1,
    };
    let messages = vec![other];
    persist_session(&sid, &SessionLog { messages }).unwrap();
    assert!(store_get_context(&sid, 20).unwrap().is_empty());
    let resp = tool_save_conversation_message(
        id(1),
        &json!({ "session_id": sid, "role": "agent", "content": "mine" }),
    );
    let err = tool_error_text(&resp);
    assert!(err.contains("another session"), "{err}");
    let on_disk = load_session_from_disk(&sid).unwrap();
    assert_eq!(on_disk.messages.len(), 1);
    assert_eq!(on_disk.messages[0].content, "belongs to another session");
    let _ = std::fs::remove_file(session_file_path(&sid).unwrap());
}

/// A message that could not be written to the session file is not saved:
/// the tool must say so (isError) rather than report `ok: true`, and the
/// unsaved message must not linger in the in-process store either.
#[test]
fn save_message_reports_a_failed_session_write() {
    let sid = unique_session();
    let path = session_file_path(&sid).unwrap();
    // A directory where the session file belongs makes the write fail.
    std::fs::create_dir_all(&path).unwrap();
    let resp = tool_save_conversation_message(
        id(1),
        &json!({ "session_id": sid, "role": "agent", "content": "lost" }),
    );
    let err = tool_error_text(&resp);
    assert!(err.contains("not saved"), "{err}");
    assert!(store_get_context(&sid, 20).unwrap().is_empty());
    std::fs::remove_dir(&path).unwrap();
}

// ── edit_canvas keeps what it does not edit ───────────────────────────────────

/// Saving used to rewrite the file as `{ nodes, edges }` only, dropping any
/// other top-level key (format extensions, plugin metadata).
#[test]
fn edit_canvas_preserves_unknown_top_level_keys() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board.canvas");
    let canvas = json!({
        "nodes": [{ "id": "a", "type": "text", "text": "hi", "x": 0, "y": 0,
                    "width": 10, "height": 10, "pluginData": { "k": 1 } }],
        "edges": [],
        "version": "1.0-1.0",
        "metadata": { "frontmatter": { "tags": ["x"] } }
    });
    std::fs::write(&path, canvas.to_string()).unwrap();
    let resp = mdopener_mcp::tool_edit_canvas(
        id(1),
        &json!({ "path": path, "ops": [{ "type": "move_node", "id": "a", "x": 5, "y": 6 }] }),
    );
    assert!(!is_error(&resp), "{resp:?}");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved["version"], canvas["version"]);
    assert_eq!(saved["metadata"], canvas["metadata"]);
    assert_eq!(saved["nodes"][0]["x"].as_f64(), Some(5.0));
    assert_eq!(saved["nodes"][0]["pluginData"], json!({ "k": 1 }));
}

/// The reply names the ids left in the canvas, so a follow-up op can target
/// them, and the edges `delete_node` removed with its node, which used to go
/// unreported.
#[test]
fn edit_canvas_reports_the_ids_left_and_the_edges_delete_node_removed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board.canvas");
    let node = |id: &str| json!({ "id": id, "type": "text", "text": id, "x": 0, "y": 0, "width": 9, "height": 9 });
    let canvas = json!({
        "nodes": [node("a"), node("b"), node("c")],
        "edges": [
            { "id": "ab", "fromNode": "a", "toNode": "b" },
            { "id": "bc", "fromNode": "b", "toNode": "c" },
            { "id": "ca", "fromNode": "c", "toNode": "a" }
        ]
    });
    std::fs::write(&path, canvas.to_string()).unwrap();
    let resp = mdopener_mcp::tool_edit_canvas(
        id(1),
        &json!({ "path": path, "ops": [
            { "type": "delete_node", "id": "b" },
            { "type": "add_node", "node": node("d") }
        ] }),
    );
    assert!(!is_error(&resp), "{resp:?}");
    let v = content_text(&resp);
    assert_eq!(v["node_ids"], json!(["a", "c", "d"]), "{v}");
    assert_eq!(v["edge_ids"], json!(["ca"]), "{v}");
    assert_eq!(v["removed_edge_ids"], json!(["ab", "bc"]), "{v}");
}

/// Every `edit_canvas` op field is type-checked before the canvas is read, and
/// the refusal names the op index and the field. `"x": "5"` used to be
/// reported as "`x` required", and `"color": 3` or `"label": {}` was written
/// into the canvas as given (where the app's parser then ignored it).
#[test]
fn edit_canvas_op_fields_of_the_wrong_type_name_the_op_and_field() {
    let path = "/nonexistent/board.canvas";
    let mv = json!({ "type": "move_node", "id": "a", "x": 1, "y": 2 });
    let cases = [
        (
            json!([mv, { "type": "move_node", "id": "a", "x": "5", "y": 2 }]),
            "`ops[1].x` must be a number, got a string (\"5\")",
        ),
        (
            json!([{ "type": 5 }]),
            "`ops[0].type` must be a string, got a number (5)",
        ),
        (
            json!([{ "type": "move_node", "id": 7, "x": 1, "y": 2 }]),
            "`ops[0].id` must be a string, got a number (7)",
        ),
        (
            json!([{ "type": "set_node_color", "id": "a", "color": 3 }]),
            "`ops[0].color` must be a string, got a number (3)",
        ),
        (
            json!([{ "type": "edit_edge_label", "id": "e", "label": {} }]),
            "`ops[0].label` must be a string, got an object",
        ),
        (
            json!([{ "type": "resize_node", "id": "a", "width": true, "height": 1 }]),
            "`ops[0].width` must be a number, got a boolean (true)",
        ),
        (
            json!([{ "type": "reorder_edges", "ids": ["e", 2] }]),
            "`ops[0].ids[1]` must be a string, got a number (2)",
        ),
        (
            json!([{ "type": "add_node", "node": "n" }]),
            "`ops[0].node` must be an object, got a string (\"n\")",
        ),
        (
            json!([{ "type": "add_edge", "edge": [] }]),
            "`ops[0].edge` must be an object, got an array",
        ),
        (json!([mv, { "id": "a" }]), "`ops[1].type` is required"),
        (json!([5]), "`ops[0]` must be an object, got a number (5)"),
    ];
    for (ops, want) in cases {
        let msg = refused_before_the_tool("edit_canvas", json!({ "path": path, "ops": ops }));
        assert_eq!(msg, want);
    }
    // A field no op takes is named, with the closest one.
    let msg = refused_before_the_tool(
        "edit_canvas",
        json!({ "path": path, "ops": [{ "type": "set_node_color", "id": "a", "colour": "1" }] }),
    );
    assert!(
        msg.starts_with("Unknown field `colour` in `ops[0]`: it takes "),
        "{msg}"
    );
    assert!(msg.ends_with("Did you mean `color`?"), "{msg}");
    // null still means "not given": set_node_color without a colour clears it.
    let def = tool_registry()
        .into_iter()
        .find(|t| t.name == "edit_canvas")
        .unwrap();
    let args =
        json!({ "path": path, "ops": [{ "type": "set_node_color", "id": "a", "color": null }] });
    assert!(mdopener_mcp::check_tool_arguments(&def, &args).is_ok());
}

/// `add_node` used to check only `node.id`, so a node the app's canvas parser
/// drops (no `x`, an unknown `type`, a link without `url`) was written and
/// reported as added, and then never appeared in the app.
#[test]
fn edit_canvas_add_node_refuses_a_node_the_app_would_drop() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board.canvas");
    let raw = r#"{"nodes":[{"id":"a","type":"text","text":"a","x":0,"y":0,"width":9,"height":9}],"edges":[]}"#;
    std::fs::write(&path, raw).unwrap();
    let full =
        json!({ "id": "n", "type": "text", "text": "t", "x": 0, "y": 0, "width": 9, "height": 9 });
    let with = |k: &str, v: Value| {
        let mut n = full.clone();
        n[k] = v;
        n
    };
    let without = |k: &str| {
        let mut n = full.clone();
        n.as_object_mut().unwrap().remove(k);
        n
    };
    let cases = [
        (without("x"), "op[0] add_node: node.x required"),
        (
            with("y", json!("1")),
            "op[0] add_node: node.y must be a number, got a string (\"1\")",
        ),
        (without("type"), "op[0] add_node: node.type required"),
        (
            with("type", json!("card")),
            "op[0] add_node: node.type must be 'text', 'file', 'link' or 'group', got \"card\"",
        ),
        (
            with("id", json!("")),
            "op[0] add_node: node.id must not be empty",
        ),
        (
            with("id", json!(3)),
            "op[0] add_node: node.id must be a string, got a number (3)",
        ),
        (
            with("width", json!(0)),
            "op[0] add_node: node width and height must be positive",
        ),
        (
            with("type", json!("link")),
            "op[0] add_node: a link node needs a string node.url",
        ),
        (
            with("type", json!("file")),
            "op[0] add_node: a file node needs a string node.file",
        ),
        (
            with("color", json!(2)),
            "op[0] add_node: node.color must be a string, got a number (2)",
        ),
    ];
    for (node, want) in cases {
        let resp = mdopener_mcp::tool_edit_canvas(
            id(1),
            &json!({ "path": path, "ops": [{ "type": "add_node", "node": node }] }),
        );
        assert_eq!(resp.error.as_ref().map(|e| e.message.as_str()), Some(want));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            raw,
            "file untouched"
        );
    }
    let resp = mdopener_mcp::tool_edit_canvas(
        id(1),
        &json!({ "path": path, "ops": [{ "type": "add_edge", "edge": { "id": "", "fromNode": "a", "toNode": "a" } }] }),
    );
    assert_eq!(
        resp.error.as_ref().map(|e| e.message.as_str()),
        Some("op[0] add_edge: edge.id must not be empty")
    );
    // A complete node of every kind is still added.
    let ops = json!([
        { "type": "add_node", "node": full },
        { "type": "add_node", "node": { "id": "f", "type": "file", "file": "a.md", "x": 1, "y": 1, "width": 5, "height": 5 } },
        { "type": "add_node", "node": { "id": "l", "type": "link", "url": "https://x", "x": 1, "y": 1, "width": 5, "height": 5 } },
        { "type": "add_node", "node": { "id": "g", "type": "group", "x": 1.5, "y": -1, "width": 5, "height": 5 } }
    ]);
    let resp = mdopener_mcp::tool_edit_canvas(id(1), &json!({ "path": path, "ops": ops }));
    assert!(!is_error(&resp), "{resp:?}");
    assert_eq!(
        content_text(&resp)["node_ids"],
        json!(["a", "n", "f", "l", "g"])
    );
}

/// A node or edge that is not a JSON object used to vanish silently on save;
/// now the edit is refused and the file is left as it was.
#[test]
fn edit_canvas_refuses_non_object_nodes_instead_of_dropping_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board.canvas");
    for raw in [
        r#"{"nodes":[{"id":"a","x":0,"y":0},"stray"],"edges":[]}"#,
        r#"{"nodes":[{"id":"a","x":0,"y":0}],"edges":[42]}"#,
        r#"{"nodes":{"id":"a"},"edges":[]}"#,
    ] {
        std::fs::write(&path, raw).unwrap();
        let resp = mdopener_mcp::tool_edit_canvas(
            id(1),
            &json!({ "path": path, "ops": [{ "type": "move_node", "id": "a", "x": 5, "y": 6 }] }),
        );
        let err = tool_error_text(&resp);
        assert!(err.contains("Canvas parse error"), "{raw}: {err}");
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, raw, "file must be untouched");
    }
}

// ── An unclosed leading `---` is not front-matter ─────────────────────────────

/// A document that opens with `---` (a thematic break) and never closes it
/// used to be swallowed whole as front-matter: empty plain text, zero words,
/// and every `key: value`-looking line reported as metadata.
#[test]
fn unclosed_leading_fence_is_not_frontmatter() {
    use mdopener_mcp::{extract_frontmatter, strip_markdown};
    let doc = "---\nNote: this is body text.\n\nSecond paragraph here.\n";
    let text = strip_markdown(doc);
    assert!(text.contains("Note: this is body text."), "{text:?}");
    assert!(text.contains("Second paragraph here."), "{text:?}");
    assert_eq!(extract_frontmatter(doc), Value::Null);

    // Closed front-matter is still stripped and parsed.
    let closed = "---\ntitle: Plan\n---\nBody\n";
    assert_eq!(strip_markdown(closed).trim(), "Body");
    assert_eq!(extract_frontmatter(closed), json!({ "title": "Plan" }));
    let dots = "---\ntitle: Plan\n...\nBody\n";
    assert_eq!(strip_markdown(dots).trim(), "Body");
    assert_eq!(extract_frontmatter(dots), json!({ "title": "Plan" }));
}

/// Lists are the most common front-matter (tags, aliases). A flow list was
/// returned as the string "[a, b]", a block list as "" (its `- item` lines
/// dropped), and a nested mapping's indented keys leaked to the top level.
#[test]
fn frontmatter_lists_are_arrays_and_nested_keys_stay_nested() {
    use mdopener_mcp::extract_frontmatter;
    let doc = "---\n\
               title: \"Q4: plan\"\n\
               tags: [launch, \"q4, late\", 3]\n\
               aliases:\n  - Plan\n  - 'Launch'\n\
               authors:\n- Zoë\n\
               owner:\n  name: Sam\n  team: core\n\
               draft: true\n\
               ---\nBody\n";
    assert_eq!(
        extract_frontmatter(doc),
        json!({
            "title": "Q4: plan",
            "tags": ["launch", "q4, late", 3],
            "aliases": ["Plan", "Launch"],
            "authors": ["Zoë"],
            "owner": { "name": "Sam", "team": "core" },
            "draft": true,
        })
    );
    assert_eq!(
        extract_frontmatter("---\ntags: []\n---\n"),
        json!({ "tags": [] })
    );
}

/// Nesting becomes an object (its values parsed like top-level ones, lists
/// included, and a level deeper too), and a bare `key:` with nothing under it
/// is null rather than "".
#[test]
fn frontmatter_parses_nesting_and_empty_values_are_null() {
    use mdopener_mcp::extract_frontmatter;
    let doc = "---\n\
               summary:\n\
               author:\n    name: Zoë\n    links: [a, b]\n    roles:\n      - lead\n      - qa\n    \
               address:\n      city: Oslo\n    email:\n\
               quoted: \"\"\n\
               tilde: ~\n\
               last:\n\
               ---\n";
    assert_eq!(
        extract_frontmatter(doc),
        json!({
            "summary": null,
            "author": {
                "name": "Zoë",
                "links": ["a", "b"],
                "roles": ["lead", "qa"],
                "address": { "city": "Oslo" },
                "email": null,
            },
            "quoted": "",
            "tilde": null,
            "last": null,
        })
    );
}

/// Lists of mappings were read as strings (`"name: Ann"`), block scalars
/// (`|`, `>`) as the literal indicator with their lines dropped, and a
/// second nesting level as null.
#[test]
fn frontmatter_reads_lists_of_mappings_block_scalars_and_deep_nesting() {
    use mdopener_mcp::extract_frontmatter;
    let doc = "---\n\
               authors:\n\
               \x20 - name: Ann\n\
               \x20   role: lead\n\
               \x20   links:\n\
               \x20     - a\n\
               \x20 - name: Bo\n\
               \x20 - plain\n\
               \x20 - \"q: quoted\"\n\
               \x20 - http://example.com\n\
               steps:\n\
               - id: 1\n\
               \x20 done: true\n\
               literal: |\n\
               \x20 line one\n\
               \x20   indented\n\
               \n\
               \x20 # not a comment\n\
               folded: >\n\
               \x20 one\n\
               \x20 two\n\
               \n\
               \x20 three\n\
               \x20   kept\n\
               \x20 four\n\
               strip: |-\n\
               \x20 a\n\
               \x20 b\n\
               keep: >+\n\
               \x20 a\n\
               \n\
               empty: |\n\
               deep:\n\
               \x20 a:\n\
               \x20   b:\n\
               \x20     c: 3\n\
               \x20     note: >-\n\
               \x20       x\n\
               \x20       y\n\
               \x20   d: [1, 2]\n\
               time: 10:30\n\
               ---\nBody\n";
    assert_eq!(
        extract_frontmatter(doc),
        json!({
            "authors": [
                { "name": "Ann", "role": "lead", "links": ["a"] },
                { "name": "Bo" },
                "plain",
                "q: quoted",
                "http://example.com",
            ],
            "steps": [{ "id": 1, "done": true }],
            "literal": "line one\n  indented\n\n# not a comment\n",
            "folded": "one two\nthree\n  kept\nfour\n",
            "strip": "a\nb",
            "keep": "a\n\n",
            "empty": "",
            "deep": { "a": { "b": { "c": 3, "note": "x y" }, "d": [1, 2] } },
            "time": "10:30",
        })
    );
}

// ── file:// resource URIs are percent-decoded ─────────────────────────────────

/// Clients percent-encode file URIs (`file:///a/My%20Notes.md`); the server
/// compared the encoded text with the advertised path and answered "not in
/// vault". Decoding happens before the advertised-path check, so encoding
/// cannot reach a file outside the vault.
#[test]
fn file_resource_uris_are_percent_decoded_before_the_vault_check() {
    let dir = tempfile::tempdir().unwrap();
    let dir = std::fs::canonicalize(dir.path()).unwrap();
    let doc = dir.join("My Notes.md");
    let secret = dir.join("secret.md");
    std::fs::write(&doc, "# Notes\n").unwrap();
    std::fs::write(&secret, "# Secret\n").unwrap();
    let doc = doc.to_string_lossy().into_owned();
    let vault = json!({ "files": [{ "path": doc, "name": "My Notes.md" }], "recents": [] });
    let ipc = MockIpc::new().on_get("/vault", Ok(vault));

    let encoded = format!("file://{}", doc.replace(' ', "%20"));
    let resp = handle_resource_read(id(1), &encoded, &ipc);
    assert!(resp.error.is_none(), "{:?}", resp.error);
    let contents = &resp.result.as_ref().unwrap()["contents"][0];
    assert_eq!(contents["text"], "# Notes\n");
    assert_eq!(contents["uri"], encoded.as_str());

    // `file://localhost/...` is the same file.
    let resp = handle_resource_read(id(2), &format!("file://localhost{doc}"), &ipc);
    assert!(resp.error.is_none(), "{:?}", resp.error);

    // The unencoded form resources/list advertises still works.
    let resp = handle_resource_read(id(2), &format!("file://{doc}"), &ipc);
    assert!(resp.error.is_none(), "{:?}", resp.error);

    // Encoding does not get around the scope check.
    let dir_s = dir.to_string_lossy().into_owned();
    let leaf = dir.file_name().unwrap().to_string_lossy().into_owned();
    for uri in [
        format!("file://{}", secret.to_string_lossy().replace('s', "%73")),
        format!("file://{}/My%20Notes.md%2F..%2Fsecret.md", dir_s),
        format!("file://{dir_s}/%2E%2E/{leaf}/secret.md"),
    ] {
        let resp = handle_resource_read(id(3), &uri, &ipc);
        let err = resp.error.expect("must be refused");
        let msg = err.message;
        assert!(msg.contains("not in vault"), "{uri}: {msg}");
    }
}

/// History saved by earlier builds under the old sanitized name stays
/// readable: `proj.1` used to live in `proj_1.json` (shared with `proj_1`).
/// Reads fall back to that file, keeping only `proj.1`'s own messages, and
/// the next append writes them, plus the new message, to the new file.
#[test]
fn legacy_sanitized_session_file_is_still_read() {
    use mdopener_mcp::{ConversationMessage, SessionLog};
    let base = unique_session();
    let dotted = format!("{base}.1");
    let underscored = format!("{base}_1");
    let msg = |sid: &str, content: &str| ConversationMessage {
        id: format!("msg-{content}"),
        session_id: sid.to_string(),
        role: "agent".into(),
        content: content.into(),
        cited_docs: vec![],
        timestamp_ms: 1,
    };
    let legacy = session_file_path(&underscored).unwrap();
    let messages = vec![
        msg(&dotted, "old dotted"),
        msg(&underscored, "old underscored"),
    ];
    let legacy_json = serde_json::to_string(&SessionLog { messages }).unwrap();
    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    std::fs::write(&legacy, &legacy_json).unwrap();

    let contents = |sid: &str| -> Vec<String> {
        let ctx = store_get_context(sid, 20).unwrap();
        ctx.into_iter().map(|m| m.content).collect()
    };
    assert_eq!(contents(&dotted), ["old dotted"]);
    assert_eq!(contents(&underscored), ["old underscored"]);

    store_append_message(&dotted, "agent", "new dotted", vec![]).unwrap();
    let new_file = session_file_path(&dotted).unwrap();
    assert_ne!(new_file, legacy);
    let on_disk: Vec<String> = load_session_from_disk(&dotted)
        .unwrap()
        .messages
        .into_iter()
        .map(|m| m.content)
        .collect();
    assert_eq!(on_disk, ["old dotted", "new dotted"]);
    assert_eq!(contents(&dotted), ["old dotted", "new dotted"]);
    // The legacy file is left as it was for the id that still owns it.
    assert_eq!(std::fs::read_to_string(&legacy).unwrap(), legacy_json);
    assert_eq!(contents(&underscored), ["old underscored"]);
}

/// The desktop app persists the same sessions into the same directory.
/// Earlier app builds wrote a bare JSON array instead of `{"messages":[…]}`;
/// that history is read, and an append keeps it instead of overwriting the
/// file with only the new message.
#[test]
fn session_file_written_by_the_app_is_read_and_kept() {
    let sid = unique_session();
    let path = session_file_path(&sid).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let app_json = serde_json::json!([{
        "id": "msg-from-app",
        "sessionId": sid,
        "role": "human",
        "content": "typed in the window",
        "citedDocs": [],
        "timestampMs": 1u64,
    }]);
    std::fs::write(&path, app_json.to_string()).unwrap();

    let contents = || -> Vec<String> {
        store_get_context(&sid, 20)
            .unwrap()
            .into_iter()
            .map(|m| m.content)
            .collect()
    };
    assert_eq!(contents(), ["typed in the window"]);

    store_append_message(&sid, "agent", "saved by the agent", vec![]).unwrap();
    assert_eq!(contents(), ["typed in the window", "saved by the agent"]);
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(on_disk["messages"].as_array().unwrap().len(), 2);
    // The write went through a temp file renamed into place; none is left.
    let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

/// A session file this server cannot parse (torn, or not a session log) is
/// an error for the append, not a reason to overwrite it with one message.
#[test]
fn unparsable_session_file_is_not_overwritten() {
    let sid = unique_session();
    let path = session_file_path(&sid).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{ torn").unwrap();
    assert!(store_append_message(&sid, "agent", "x", vec![]).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ torn");
}

/// The app answers a refused request with `{"error": …}`; that reason must
/// reach the agent instead of a bare status code.
#[test]
fn parse_http_body_400_carries_the_apps_reason() {
    let raw = b"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{\"error\":\"Refusing to open '/x/id_rsa'\"}";
    let err = mdopener_mcp::parse_http_body(raw).unwrap_err();
    assert!(err.contains("400"), "{err}");
    assert!(err.contains("Refusing to open '/x/id_rsa'"), "{err}");
}

/// open_file, present_document and request_review hand a path to the app,
/// which opens it; get_current_content then returns whatever it read. The
/// tools that read a path from disk accept Markdown only, so these refuse a
/// non-Markdown file or a dotfile before the app (or the URL-scheme
/// launcher) ever sees it.
#[test]
fn path_handing_tools_refuse_non_markdown_files() {
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("id_rsa");
    std::fs::write(&secret, "PRIVATE KEY").unwrap();
    let dotfile = dir.path().join(".env.md");
    std::fs::write(&dotfile, "TOKEN=1").unwrap();
    let mut refused = vec![
        secret.to_string_lossy().into_owned(),
        dotfile.to_string_lossy().into_owned(),
        dir.path().to_string_lossy().into_owned(),
    ];
    #[cfg(unix)]
    {
        let link = dir.path().join("notes.md");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        refused.push(link.to_string_lossy().into_owned());
    }
    for path in &refused {
        let ipc = MockIpc::new()
            .on_post("/open", Ok(json!({ "ok": true })))
            .on_post("/present", Ok(json!({ "ok": true })))
            .on_post("/review", Ok(json!({ "ok": true })));
        let open = tool_open_file_with(id(1), &json!({ "path": path }), &ipc, &|_| {
            panic!("must not launch")
        });
        let present = tool_present_document(id(2), &json!({ "path": path }), &ipc);
        let review = tool_request_review(id(3), &json!({ "path": path, "blocking": false }), &ipc);
        for resp in [open, present, review] {
            let err = tool_error_text(&resp);
            assert!(err.contains("Markdown"), "{path}: {err}");
        }
        assert!(ipc.calls().is_empty(), "{path}: {:?}", ipc.calls());
    }
}

/// When the running app refuses `/open`, open_file reports the reason and
/// does not retry through the URL scheme (which would bypass the refusal).
#[test]
fn open_file_does_not_relaunch_a_path_the_app_refused() {
    let ipc = MockIpc::new().on_post(
        "/open",
        Err("IPC server returned HTTP 400: Refusing to open '/tmp/mdopener-notes.md'".into()),
    );
    let resp = tool_open_file_with(
        id(1),
        &json!({ "path": "/tmp/mdopener-notes.md" }),
        &ipc,
        &|_| panic!("must not launch"),
    );
    assert!(tool_error_text(&resp).contains("Refusing to open"));
}

// ════════════════════════════════════════════════════════════════════════════
// Argument types: a value of the wrong type is refused, never defaulted
// ════════════════════════════════════════════════════════════════════════════

/// A whole-number argument given as a string, a negative or a fraction is
/// an invalid-params error that never reaches the app: `match_index: "1"`
/// used to be read as absent and apply the first occurrence.
#[test]
fn a_whole_number_argument_of_the_wrong_type_is_refused() {
    let cases = [
        (
            "stream_edit_apply",
            json!({ "find": "a", "replace": "b", "match_index": "1" }),
            "match_index",
        ),
        (
            "stream_edit_apply",
            json!({ "find": "a", "replace": "b", "match_index": -1 }),
            "match_index",
        ),
        (
            "stream_edit",
            json!({ "find": "a", "replace": "b", "preview_lines": 2.5 }),
            "preview_lines",
        ),
        ("list_recent", json!({ "limit": "ten" }), "limit"),
        (
            "search_vault",
            json!({ "query": "q", "limit": -5 }),
            "limit",
        ),
        (
            "get_conversation_context",
            json!({ "session_id": "s", "limit": "all" }),
            "limit",
        ),
        (
            "diff_documents",
            json!({ "path_a": "/a.md", "path_b": "/b.md", "context_lines": "3" }),
            "context_lines",
        ),
        (
            "request_review",
            json!({ "content": "# x", "wait_ms": "50000" }),
            "wait_ms",
        ),
    ];
    for (tool, args, name) in cases {
        let ipc = MockIpc::new();
        let resp = call(tool, args.clone(), &ipc);
        let err = resp
            .error
            .as_ref()
            .unwrap_or_else(|| panic!("{tool} {args}: {resp:?}"));
        assert_eq!(err.code, -32602, "{tool} {args}");
        assert!(err.message.contains(name), "{tool}: {}", err.message);
        assert!(ipc.calls().is_empty(), "{tool} must not reach the app");
    }
}

/// A whole number written as a float (`2.0`) is still that number.
#[test]
fn a_whole_number_argument_written_as_a_float_is_accepted() {
    let ipc = MockIpc::new().on_post("/stream-edit-apply", Ok(json!({ "ok": true })));
    let resp = call(
        "stream_edit_apply",
        json!({ "find": "a", "replace": "b", "match_index": 2.0 }),
        &ipc,
    );
    assert!(!is_error(&resp), "{resp:?}");
    let calls = ipc.calls();
    let (_, _, body) = calls
        .iter()
        .find(|(_, p, _)| p == "/stream-edit-apply")
        .unwrap();
    assert_eq!(body.as_ref().unwrap()["matchIndex"], json!(2));
}

/// A boolean argument given as a string or number is an invalid-params error
/// that never reaches the app: `save: "true"` used to be read as absent, so
/// the edit was applied but quietly left unsaved.
#[test]
fn a_boolean_argument_of_the_wrong_type_is_refused() {
    let cases = [
        (
            "edit_document",
            json!({ "find": "a", "replace": "b", "save": "true" }),
            "save",
        ),
        ("set_content", json!({ "content": "x", "save": 1 }), "save"),
        (
            "replace_document",
            json!({ "content": "x", "save": "yes" }),
            "save",
        ),
        (
            "stream_edit",
            json!({ "find": "a", "replace": "b", "preview": "false" }),
            "preview",
        ),
        (
            "stream_edit_apply",
            json!({ "find": "a", "replace": "b", "save": "true" }),
            "save",
        ),
        (
            "request_review",
            json!({ "content": "# x", "blocking": "false" }),
            "blocking",
        ),
        (
            "list_ai_actions",
            json!({ "include_prompts": "no" }),
            "include_prompts",
        ),
    ];
    for (tool, args, name) in cases {
        let ipc = MockIpc::new();
        let resp = call(tool, args.clone(), &ipc);
        let err = resp
            .error
            .as_ref()
            .unwrap_or_else(|| panic!("{tool} {args}: {resp:?}"));
        assert_eq!(err.code, -32602, "{tool} {args}");
        assert!(err.message.contains(name), "{tool}: {}", err.message);
        assert!(ipc.calls().is_empty(), "{tool} must not reach the app");
    }
}

// ════════════════════════════════════════════════════════════════════════════
// tools/call argument checking against the declared inputSchema
// ════════════════════════════════════════════════════════════════════════════

fn call_tool(name: &str, arguments: Value) -> mdopener_mcp::Response {
    let ipc = MockIpc::new();
    dispatch(
        dispatch_req(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        ),
        &ipc,
    )
    .unwrap()
}

fn param_error(resp: &mdopener_mcp::Response) -> String {
    let err = resp
        .error
        .as_ref()
        .unwrap_or_else(|| panic!("expected a -32602 error, got {:?}", resp.result));
    assert_eq!(err.code, -32602, "{}", err.message);
    err.message.clone()
}

#[test]
fn undeclared_argument_is_refused_with_the_declared_ones() {
    // `pth` used to be ignored: export_metadata then read the open document
    // (or failed with "not running") instead of the path the agent meant.
    let msg = param_error(&call_tool("export_metadata", json!({ "pth": "a.md" })));
    assert!(
        msg.contains("Unknown argument `pth` for `export_metadata`"),
        "{msg}"
    );
    assert!(msg.contains("it takes `path`"), "{msg}");
    assert!(msg.contains("Did you mean `path`?"), "{msg}");

    // A typo of a boolean flag used to return the full prompts anyway.
    let msg = param_error(&call_tool(
        "list_ai_actions",
        json!({ "include_prompt": false }),
    ));
    assert!(msg.contains("Did you mean `include_prompts`?"), "{msg}");

    // A tool with no parameters says so.
    let msg = param_error(&call_tool("get_current_content", json!({ "x": 1 })));
    assert!(msg.contains("it takes no arguments"), "{msg}");
}

#[test]
fn mistyped_argument_is_refused_instead_of_defaulted() {
    // `"no"` used to fall back to the default (true) and return prompts.
    let msg = param_error(&call_tool(
        "list_ai_actions",
        json!({ "include_prompts": "no" }),
    ));
    assert_eq!(
        msg,
        "`include_prompts` must be a boolean, got a string (\"no\")"
    );

    let msg = param_error(&call_tool(
        "get_conversation_context",
        json!({ "session_id": "s", "limit": "5" }),
    ));
    assert!(msg.contains("`limit` must be an integer"), "{msg}");

    let msg = param_error(&call_tool("list_recent", json!({ "limit": 2.5 })));
    assert!(
        msg.contains("`limit` must be an integer, got a number (2.5)"),
        "{msg}"
    );

    // Array elements are checked against `items.type`: a number in
    // `cited_docs` used to be dropped without a word.
    let msg = param_error(&call_tool(
        "save_conversation_message",
        json!({ "session_id": "s", "role": "agent", "content": "x", "cited_docs": ["a.md", 7] }),
    ));
    assert!(msg.contains("`cited_docs[1]` must be a string"), "{msg}");

    let msg = param_error(&call_tool("diff_documents", json!("a.md")));
    assert!(
        msg.contains("`arguments` for `diff_documents` must be an object"),
        "{msg}"
    );
}

#[test]
fn well_formed_arguments_still_reach_the_tool() {
    // null means "not given", and `theme` keeps the export tool's own message.
    let resp = call_tool("list_ai_actions", json!({ "include_prompts": null }));
    assert!(resp.error.is_none(), "{:?}", resp.error);
    let msg = param_error(&call_tool(
        "export",
        json!({ "format": "html", "theme": "dark" }),
    ));
    assert!(msg.contains("`theme` is not supported"), "{msg}");
    // No `arguments` at all is still the tool's own "required" error.
    let ipc = MockIpc::new();
    let resp = dispatch(
        dispatch_req("tools/call", json!({ "name": "diff_documents" })),
        &ipc,
    )
    .unwrap();
    assert_eq!(param_error(&resp), "`path_a` is required");
}

#[test]
fn every_declared_argument_passes_the_check() {
    // Build arguments of the declared type for every property of every tool:
    // none may be refused as undeclared or mistyped.
    for def in tool_registry() {
        let mut args = serde_json::Map::new();
        for (k, prop) in def.input_schema["properties"].as_object().unwrap() {
            let v = match prop["type"].as_str() {
                Some("string") => json!("x"),
                Some("boolean") => json!(true),
                Some("integer") => json!(1),
                Some("number") => json!(1.5),
                Some("array") => json!([]),
                Some("object") => json!({}),
                _ => json!("x"),
            };
            args.insert(k.clone(), v);
        }
        let r = mdopener_mcp::check_tool_arguments(&def, &Value::Object(args));
        assert!(r.is_ok(), "{}: {:?}", def.name, r);
    }
}

/// A value of the JSON type `prop` declares (its first `enum` value when it has
/// one), and a value of some other type.
fn sample_of(prop: &Value) -> (Value, Value) {
    if let Some(first) = prop["enum"].as_array().and_then(|e| e.first()) {
        return (first.clone(), json!(7));
    }
    match prop["type"].as_str() {
        Some("string") => (json!("x"), json!(5)),
        Some("boolean") => (json!(true), json!("yes")),
        Some("integer") => (json!(prop["minimum"].as_i64().unwrap_or(0)), json!("1")),
        Some("number") => (json!(1.5), json!("1.5")),
        Some("array") => (json!([]), json!({})),
        Some("object") => (json!({}), json!([])),
        other => panic!("property without a type: {other:?} in {prop}"),
    }
}

/// Call `name` through `tools/call` with an IPC that fails every request, and
/// return the `-32602` message. Asserts the refusal came before the tool did
/// anything (no IPC call), i.e. from the argument check.
fn refused_before_the_tool(name: &str, args: Value) -> String {
    let ipc = MockIpc::new();
    let resp = dispatch(
        dispatch_req("tools/call", json!({ "name": name, "arguments": args })),
        &ipc,
    )
    .unwrap();
    assert!(
        ipc.calls().is_empty(),
        "{name}: reached the app before refusing {args}: {:?}",
        ipc.calls()
    );
    param_error(&resp)
}

#[test]
fn every_tool_schema_matches_what_the_argument_check_enforces() {
    // Drive the advertised schemas (tools/list), not the registry, so what an
    // agent reads is what is enforced: every `required` argument left out,
    // every `anyOf` alternative left out, and every property (and array
    // element) given the wrong JSON type is refused with -32602 naming it,
    // before the tool runs.
    let ipc = MockIpc::new();
    let resp = dispatch(dispatch_req("tools/list", json!({})), &ipc).unwrap();
    let tools = resp.result.unwrap()["tools"].as_array().unwrap().clone();
    assert_eq!(tools.len(), ALL_TOOL_NAMES.len());
    for tool in &tools {
        let name = tool["name"].as_str().unwrap();
        let schema = &tool["inputSchema"];
        let props = schema["properties"].as_object().unwrap();
        let mut valid = serde_json::Map::new();
        for (k, prop) in props {
            valid.insert(k.clone(), sample_of(prop).0);
        }
        let def = tool_registry()
            .into_iter()
            .find(|t| t.name == name)
            .unwrap();
        let ok = mdopener_mcp::check_tool_arguments(&def, &Value::Object(valid.clone()));
        assert!(ok.is_ok(), "{name}: well-typed arguments refused: {ok:?}");

        for req in schema["required"].as_array().into_iter().flatten() {
            let req = req.as_str().unwrap();
            assert!(
                props.contains_key(req),
                "{name}: `{req}` required, undeclared"
            );
            for absent in [None, Some(Value::Null)] {
                let mut args = valid.clone();
                match absent {
                    None => args.remove(req),
                    Some(v) => args.insert(req.to_string(), v),
                };
                let msg = refused_before_the_tool(name, Value::Object(args));
                assert_eq!(msg, format!("`{req}` is required"), "{name}");
            }
        }
        if let Some(alternatives) = schema["anyOf"].as_array() {
            let mut args = valid.clone();
            for alt in alternatives {
                for req in alt["required"].as_array().unwrap() {
                    args.remove(req.as_str().unwrap());
                }
            }
            let msg = refused_before_the_tool(name, Value::Object(args));
            assert!(msg.starts_with(&format!("`{name}` needs one of")), "{msg}");
            // Any one alternative is enough.
            for alt in alternatives {
                let mut one = serde_json::Map::new();
                for req in alt["required"].as_array().unwrap() {
                    let req = req.as_str().unwrap();
                    one.insert(req.to_string(), valid[req].clone());
                }
                let r = mdopener_mcp::check_tool_arguments(&def, &Value::Object(one));
                assert!(r.is_ok(), "{name}: {alt} not enough: {r:?}");
            }
        }

        for (k, prop) in props {
            let mut args = valid.clone();
            args.insert(k.clone(), sample_of(prop).1);
            let msg = refused_before_the_tool(name, Value::Object(args));
            assert!(
                msg.starts_with(&format!("`{k}` must be ")),
                "{name}.{k}: {msg}"
            );
            if let Some(items) = prop.get("items") {
                let mut args = valid.clone();
                args.insert(k.clone(), json!([sample_of(items).1]));
                let msg = refused_before_the_tool(name, Value::Object(args));
                assert!(msg.starts_with(&format!("`{k}[0]")), "{name}.{k}: {msg}");
            }
            // Fields of an array of objects (edit_canvas ops) are probed the
            // same way, named `ops[0].field`.
            if let Some(fields) = prop["items"]["properties"].as_object() {
                let mut item = serde_json::Map::new();
                for (f, fprop) in fields {
                    item.insert(f.clone(), sample_of(fprop).0);
                }
                for (f, fprop) in fields {
                    let mut bad = item.clone();
                    bad.insert(f.clone(), sample_of(fprop).1);
                    let mut args = valid.clone();
                    args.insert(k.clone(), json!([bad]));
                    let msg = refused_before_the_tool(name, Value::Object(args));
                    let want = format!("`{k}[0].{f}` must be ");
                    assert!(msg.starts_with(&want), "{name}.{k}.{f}: {msg}");
                }
                for req in prop["items"]["required"].as_array().into_iter().flatten() {
                    let req = req.as_str().unwrap();
                    let mut missing = item.clone();
                    missing.remove(req);
                    let mut args = valid.clone();
                    args.insert(k.clone(), json!([missing]));
                    let msg = refused_before_the_tool(name, Value::Object(args));
                    assert_eq!(msg, format!("`{k}[0].{req}` is required"), "{name}");
                }
            }
        }
    }
}

#[test]
fn optional_string_of_the_wrong_type_is_not_read_as_absent() {
    // `path: 5` must not fall back to "the open document".
    for (tool, args) in [
        (
            "edit_document",
            json!({ "find": "a", "replace": "b", "path": 5 }),
        ),
        ("present_document", json!({ "path": 5 })),
        ("export_text", json!({ "path": false })),
        (
            "stream_edit",
            json!({ "find": "a", "replace": "b", "path": ["a.md"] }),
        ),
    ] {
        let msg = refused_before_the_tool(tool, args);
        assert!(
            msg.starts_with("`path` must be a string, got "),
            "{tool}: {msg}"
        );
    }
}

#[test]
fn edit_canvas_without_ops_is_refused_before_reading_the_file() {
    // It used to read (and parse) the canvas first, so a missing file hid the
    // missing `ops`.
    let msg = refused_before_the_tool("edit_canvas", json!({ "path": "/nonexistent/x.canvas" }));
    assert_eq!(msg, "`ops` is required");
    let msg = refused_before_the_tool("request_review", json!({ "blocking": false }));
    assert_eq!(
        msg,
        "`request_review` needs one of `path`, `content` or `review_id`"
    );
}

#[test]
fn unknown_tool_names_the_closest_tool_and_tools_list() {
    let msg = param_error(&call_tool("Open_File", json!({})));
    assert!(msg.starts_with("Unknown tool: Open_File."), "{msg}");
    assert!(msg.contains("Did you mean `open_file`?"), "{msg}");
    assert!(msg.contains("Call tools/list"), "{msg}");

    let msg = param_error(&call_tool("", json!({})));
    assert!(msg.contains("`name` is missing or blank"), "{msg}");
    assert!(!msg.contains("Did you mean"), "{msg}");
}

#[test]
fn blank_session_id_is_refused() {
    use_temp_sessions_dir();
    let resp = tool_save_conversation_message(
        json!(1),
        &json!({ "session_id": "   ", "role": "agent", "content": "did x" }),
    );
    assert_eq!(param_error(&resp), "`session_id` must not be blank");
    assert!(
        !session_file_path("   ").unwrap().exists(),
        "no session file for a blank id"
    );
    let resp = tool_get_conversation_context(json!(1), &json!({ "session_id": "\t" }));
    assert_eq!(param_error(&resp), "`session_id` must not be blank");
}

#[test]
fn integer_below_its_minimum_is_refused() {
    // Each of these used to fall back to the default (`as_u64` of a negative
    // is None): `limit: -5` listed 10 recents, `timeout_ms: -1` gave the
    // human 5 minutes, `match_index: -1` applied the first occurrence.
    let cases = [
        (
            "list_recent",
            json!({ "limit": -5 }),
            "`limit` must be at least 0, got -5",
        ),
        (
            "search_vault",
            json!({ "query": "q", "limit": -1 }),
            "`limit` must be at least 0, got -1",
        ),
        (
            "get_conversation_context",
            json!({ "session_id": "s", "limit": 0 }),
            "`limit` must be at least 1, got 0",
        ),
        (
            "diff_documents",
            json!({ "path_a": "a.md", "path_b": "b.md", "context_lines": -3 }),
            "`context_lines` must be at least 0, got -3",
        ),
        (
            "request_review",
            json!({ "content": "x", "timeout_ms": -1 }),
            "`timeout_ms` must be at least 0, got -1",
        ),
        (
            "request_review",
            json!({ "content": "x", "wait_ms": -1000 }),
            "`wait_ms` must be at least 0, got -1000",
        ),
        (
            "stream_edit",
            json!({ "find": "a", "replace": "b", "preview_lines": -2 }),
            "`preview_lines` must be at least 0, got -2",
        ),
        (
            "stream_edit_apply",
            json!({ "find": "a", "replace": "b", "match_index": -1 }),
            "`match_index` must be at least 0, got -1",
        ),
    ];
    for (tool, args, want) in cases {
        assert_eq!(param_error(&call_tool(tool, args)), want, "{tool}");
    }
    // Every integer argument declares a minimum, so none is left unchecked.
    for def in tool_registry() {
        for (k, prop) in def.input_schema["properties"].as_object().unwrap() {
            if prop["type"] == "integer" {
                assert!(prop["minimum"].is_i64(), "{}.{k} has no minimum", def.name);
            }
        }
    }
    // The minimum itself and values past i64 still pass.
    let def = tool_registry()
        .into_iter()
        .find(|t| t.name == "stream_edit_apply")
        .unwrap();
    for n in [json!(0), json!(u64::MAX)] {
        let args = json!({ "find": "a", "replace": "b", "match_index": n });
        assert!(mdopener_mcp::check_tool_arguments(&def, &args).is_ok());
    }
}

fn prompt_get(params: Value) -> mdopener_mcp::Response {
    let ipc = MockIpc::new();
    dispatch(dispatch_req("prompts/get", params), &ipc).unwrap()
}

#[test]
fn unknown_prompt_names_the_closest_prompt_and_the_prompts() {
    // `Unknown prompt: Summarize` gave no next step.
    let msg = param_error(&prompt_get(json!({ "name": "Summarize" })));
    assert!(msg.starts_with("Unknown prompt: Summarize."), "{msg}");
    assert!(msg.contains("Did you mean `summarize`?"), "{msg}");
    assert!(
        msg.contains("The prompts are `summarize`, `review_plan`, `improve_writing`"),
        "{msg}"
    );

    let msg = param_error(&prompt_get(json!({})));
    assert!(msg.contains("`name` is missing or blank"), "{msg}");
    assert!(!msg.contains("Did you mean"), "{msg}");

    // Every prompt prompts/list serves is named in the message.
    let msg = param_error(&prompt_get(json!({ "name": "nope" })));
    for p in mdopener_mcp::prompts_list().as_array().unwrap() {
        let name = p["name"].as_str().unwrap();
        assert!(msg.contains(&format!("`{name}`")), "{name}: {msg}");
    }
}

#[test]
fn unknown_resource_uri_names_the_closest_uri_and_resources_list() {
    let ipc = MockIpc::new();
    let read = |params: Value| dispatch(dispatch_req("resources/read", params), &ipc).unwrap();

    let msg = param_error(&read(json!({ "uri": "mdopener://Current" })));
    assert!(
        msg.starts_with("Unknown resource URI: mdopener://Current."),
        "{msg}"
    );
    assert!(msg.contains("Did you mean `mdopener://current`?"), "{msg}");
    assert!(msg.contains("Call resources/list"), "{msg}");

    // A missing uri used to read `Unknown resource URI: ` with nothing after.
    let msg = param_error(&read(json!({})));
    assert!(msg.contains("`uri` is missing or blank"), "{msg}");
}

// ── Round 9: semantics with real files ───────────────────────────────────────

/// `diff_documents` compared lines without their terminators, so two files
/// that differ only in line endings (CRLF vs LF) or in the final newline
/// came back as `hunks: 0` with an empty diff, as if identical.
#[test]
fn diff_documents_reports_line_ending_and_final_newline_changes() {
    let dir = tempfile::tempdir().unwrap();
    let lf = dir.path().join("lf.md");
    let crlf = dir.path().join("crlf.md");
    let no_newline = dir.path().join("no-newline.md");
    std::fs::write(&lf, "a\nb\n").unwrap();
    std::fs::write(&crlf, "a\r\nb\r\n").unwrap();
    std::fs::write(&no_newline, "a\nb").unwrap();
    let diff = |a: &std::path::Path, b: &std::path::Path| {
        let resp = mdopener_mcp::tool_diff_documents(id(1), &json!({ "path_a": a, "path_b": b }));
        assert!(!is_error(&resp), "{resp:?}");
        content_text(&resp)
    };

    let r = diff(&lf, &crlf);
    assert_eq!(r["hunks"], 1, "{r}");
    assert_eq!(
        (r["added"].as_u64(), r["removed"].as_u64()),
        (Some(2), Some(2))
    );
    let d = r["diff"].as_str().unwrap();
    assert!(d.contains("\n-a\n") && d.contains("\n+a\r\n"), "{d:?}");

    let r = diff(&lf, &no_newline);
    assert_eq!(r["hunks"], 1, "{r}");
    let d = r["diff"].as_str().unwrap();
    assert!(d.ends_with("-b\n+b\n\\ No newline at end of file"), "{d:?}");

    // Identical files still diff to nothing.
    let r = diff(&lf, &lf);
    assert_eq!(r["hunks"], 0);
    assert_eq!(r["diff"], "");
}

/// Session files hold the conversation, but were created `0644` in a `0755`
/// directory, readable by every local user (the IPC token is `0600`).
#[cfg(unix)]
#[test]
fn session_files_are_readable_by_the_owner_only() {
    use std::os::unix::fs::PermissionsExt as _;
    let sid = unique_session();
    let path = session_file_path(&sid).unwrap();
    let dir = path.parent().unwrap().to_path_buf();
    // A directory left world-readable by an earlier build is tightened.
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    store_append_message(&sid, "human", "approved, ship it", vec![]).unwrap();
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&dir), 0o700, "sessions dir");
    assert_eq!(mode(&path), 0o600, "session file");
}

/// A session id too long for a file name used to pass validation: saving
/// then failed with "File name too long (os error 36)" while reading the
/// same id answered an empty session. Both now refuse it as invalid params.
#[test]
fn over_long_session_id_is_refused_up_front() {
    use_temp_sessions_dir();
    let long = "x.".repeat(120); // 240 bytes, a 600-byte file name
    for resp in [
        tool_save_conversation_message(
            id(1),
            &json!({ "session_id": long, "role": "agent", "content": "hi" }),
        ),
        tool_get_conversation_context(id(2), &json!({ "session_id": long })),
    ] {
        let msg = param_error(&resp);
        assert!(
            msg.contains("`session_id` is too long (240 bytes)"),
            "{msg}"
        );
    }
    // The longest accepted id still saves and reads back.
    let ok = "y".repeat(mdopener_mcp::MAX_SESSION_FILE_STEM);
    let resp = tool_save_conversation_message(
        id(3),
        &json!({ "session_id": ok, "role": "agent", "content": "fits" }),
    );
    assert!(!is_error(&resp), "{resp:?}");
    let resp = tool_get_conversation_context(id(4), &json!({ "session_id": ok }));
    assert_eq!(content_text(&resp)["count"], 1);
    let too_long = "y".repeat(mdopener_mcp::MAX_SESSION_FILE_STEM + 1);
    param_error(&tool_get_conversation_context(
        id(5),
        &json!({ "session_id": too_long }),
    ));
}

/// The resource channel checked only that a path was advertised, then
/// followed symlinks: a vault `notes.md` linking to a key or `.env` was
/// served by `resources/read`, and its first 200 characters appeared in the
/// recent-documents preview.
#[cfg(unix)]
#[test]
fn resources_do_not_follow_a_markdown_symlink_to_another_file() {
    let dir = tempfile::tempdir().unwrap();
    let dir = std::fs::canonicalize(dir.path()).unwrap();
    let secret = dir.join("id_rsa");
    std::fs::write(&secret, "PRIVATE KEY\n").unwrap();
    let link = dir.join("notes.md");
    std::os::unix::fs::symlink(&secret, &link).unwrap();
    let real = dir.join("real.md");
    std::fs::write(&real, "# Real\n").unwrap();
    let link_s = link.to_string_lossy().into_owned();
    let real_s = real.to_string_lossy().into_owned();
    let vault = json!({
        "files": [{ "path": link_s, "name": "notes.md" }],
        "recents": [link_s, real_s],
    });
    let ipc = MockIpc::new().on_get("/vault", Ok(vault));

    let resp = handle_resource_read(id(1), &format!("file://{link_s}"), &ipc);
    let err = resp
        .error
        .expect("a symlink to a non-Markdown file must be refused");
    assert_eq!(err.code, -32002);
    assert!(
        err.message.contains("only Markdown documents"),
        "{}",
        err.message
    );

    let resp = mdopener_mcp::handle_recent_documents_resource(id(2), &ipc);
    let text = resp.result.as_ref().unwrap()["contents"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!text.contains("PRIVATE KEY"), "{text}");
    let payload: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(payload["count"], 1, "{payload}");
    assert_eq!(payload["documents"][0]["path"], real_s.as_str());

    // A real Markdown vault file is still served.
    let resp = handle_resource_read(id(3), &format!("file://{real_s}"), &ipc);
    assert!(resp.error.is_none(), "{:?}", resp.error);
}

/// A UTF-8 byte order mark (Notepad saves one) hid the front-matter:
/// `export_metadata` answered `frontmatter: null` and `export_text` kept the
/// raw `---` block in its text and word count.
#[test]
fn export_tools_read_front_matter_after_a_byte_order_mark() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bom.md");
    std::fs::write(
        &path,
        "\u{FEFF}---\ntitle: Plan\ntags: [a, b]\n---\n# Heading\n\nThree words here.\n",
    )
    .unwrap();
    let ipc = MockIpc::new();

    let resp = mdopener_mcp::tool_export_metadata(id(1), &json!({ "path": path }), &ipc);
    let meta = content_text(&resp);
    assert_eq!(meta["frontmatter"]["title"], "Plan", "{meta}");
    assert_eq!(meta["frontmatter"]["tags"], json!(["a", "b"]), "{meta}");
    assert_eq!(meta["word_count"], 4, "{meta}");

    let resp = mdopener_mcp::tool_export_text(id(2), &json!({ "path": path }), &ipc);
    let text = content_text(&resp);
    assert_eq!(text["text"], "Heading\n\nThree words here.", "{text}");

    // The open document over IPC gets the same treatment.
    let ipc = MockIpc::new().on_get(
        "/content",
        Ok(json!({ "path": "/x/plan.md", "content": "\u{FEFF}---\ntitle: Live\n---\nBody\n" })),
    );
    let resp = mdopener_mcp::tool_export_metadata(id(3), &json!({}), &ipc);
    assert_eq!(content_text(&resp)["frontmatter"]["title"], "Live");

    // Nested front matter after a BOM goes through the recursive parser.
    std::fs::write(
        &path,
        "\u{FEFF}---\nowner:\n  name: Ann\n  roles:\n    - lead\n---\nBody\n",
    )
    .unwrap();
    let resp = mdopener_mcp::tool_export_metadata(id(4), &json!({ "path": path }), &ipc);
    assert_eq!(
        content_text(&resp)["frontmatter"],
        json!({ "owner": { "name": "Ann", "roles": ["lead"] } })
    );
}
