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

#[test]
fn review_and_present_say_they_need_the_app_running() {
    // Both show the human something, so an agent may call one first; neither
    // starts the app, and their descriptions used to leave that unsaid.
    for name in ["present_document", "request_review"] {
        let def = tool_registry()
            .into_iter()
            .find(|t| t.name == name)
            .unwrap();
        assert!(
            def.description
                .contains("Needs Ashlr MD running: this tool does not start it, so with the app closed call open_file first."),
            "{name}: {}",
            def.description
        );
    }
}

#[test]
fn initialize_instructions_name_the_first_tools_and_a_missing_app() {
    // No `instructions` used to be sent, so an agent saw 20 tools and no word
    // on which to start with, that only open_file starts the app, or what to
    // do when Ashlr MD is not installed.
    let resp = handle_initialize(id(1), None);
    let text = resp.result.as_ref().unwrap()["instructions"]
        .as_str()
        .expect("initialize sends instructions");
    assert_eq!(text, mdopener_mcp::SERVER_INSTRUCTIONS);
    for tool in [
        "open_file",
        "present_document",
        "request_review",
        "get_current_content",
        "edit_document",
    ] {
        assert!(text.contains(tool), "instructions must name {tool}: {text}");
    }
    assert!(text.contains("the only tool that starts the app"), "{text}");
    assert!(text.contains("not installed"), "{text}");
    assert!(
        text.contains("https://github.com/ashlrai/ashlr-md/releases"),
        "{text}"
    );
    // Every snake_case word that looks like a tool is a real one.
    let names: Vec<&str> = tool_registry().iter().map(|t| t.name).collect();
    for word in text.split(|c: char| !(c.is_ascii_lowercase() || c == '_')) {
        if word.contains('_') {
            assert!(
                names.contains(&word),
                "instructions name unknown tool {word}"
            );
        }
    }
    assert!(
        !text.contains('\u{2014}') && !text.contains('\u{2013}'),
        "{text}"
    );
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

/// `tools/list` is read top down, and `set_content` (which replaces the whole
/// document) used to be listed third, ahead of `edit_document`. Every
/// destructive tool now comes after every other tool, and `ALL_TOOL_NAMES`
/// follows the registry order.
#[test]
fn destructive_tools_are_listed_last() {
    let registry = tool_registry();
    let first_destructive = registry
        .iter()
        .position(|t| t.tier == ToolTier::Destructive)
        .expect("the registry has destructive tools");
    for t in &registry[first_destructive..] {
        assert_eq!(
            t.tier,
            ToolTier::Destructive,
            "{} is listed after a destructive tool; list it before them",
            t.name
        );
    }
    let names: Vec<&str> = registry.iter().map(|t| t.name).collect();
    assert_eq!(
        ALL_TOOL_NAMES,
        names.as_slice(),
        "ALL_TOOL_NAMES is not in registry order"
    );
    let pos = |n: &str| names.iter().position(|&x| x == n).unwrap();
    assert!(pos("edit_document") < pos("set_content"));
    assert!(pos("edit_document") < pos("replace_document"));
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

/// Every tool states all four hints. MCP clients must assume a missing
/// `destructiveHint` / `openWorldHint` is `true`, so a tool listed without
/// annotations (`open_file` was) reads as destructive and open-world.
#[test]
fn every_tool_states_all_four_annotation_hints() {
    for def in tool_registry() {
        let ann = def
            .annotations
            .as_ref()
            .unwrap_or_else(|| panic!("tool '{}' has no annotations", def.name));
        for hint in [
            "readOnlyHint",
            "destructiveHint",
            "idempotentHint",
            "openWorldHint",
        ] {
            assert!(
                ann[hint].is_boolean(),
                "tool '{}' does not state {hint}",
                def.name
            );
        }
        assert!(ann["title"].is_string(), "tool '{}' has no title", def.name);
        assert_eq!(
            ann["destructiveHint"].as_bool(),
            Some(def.tier == ToolTier::Destructive),
            "tool '{}': destructiveHint disagrees with its tier",
            def.name
        );
    }
}

/// `set_content` and `replace_document` both post the whole new text to the
/// app's `/content`, so they overwrite the open document alike.
/// `set_content` used to be listed as `destructiveHint: false` (a Modifier),
/// so a client that confirms destructive tools let it replace a document
/// unasked, while `replace_document` was asked about.
#[test]
fn set_content_is_as_destructive_as_replace_document() {
    let reg = tool_registry();
    let def = |name: &str| reg.iter().find(|d| d.name == name).unwrap();
    let (set, replace) = (def("set_content"), def("replace_document"));
    assert_eq!(set.tier, ToolTier::Destructive);
    let mut a = set.annotations.clone().unwrap();
    let mut b = replace.annotations.clone().unwrap();
    a.as_object_mut().unwrap().remove("title");
    b.as_object_mut().unwrap().remove("title");
    assert_eq!(a, b);
    assert!(set.description.contains("ENTIRE"), "{}", set.description);

    // The same request reaches the app either way.
    let args = json!({ "content": "# new", "save": true });
    let ipc = MockIpc::new().on_post("/content", Ok(json!({ "ok": true })));
    mdopener_mcp::tool_set_content(id(1), &args, &ipc);
    mdopener_mcp::tool_replace_document(id(1), &args, &ipc);
    let calls = ipc.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert_eq!(calls[0], calls[1]);
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

/// An HTTP 401 (a stale ~/.mdopener/ipc-token, or another instance on the
/// port) was not read as a refusal, so open_file fell through to the URL
/// scheme, and a launch that failed said "the app is not running (IPC auth
/// failed...)" though an app had answered. It is now the shared message, and
/// nothing is launched.
#[test]
fn open_file_on_a_refused_token_says_how_to_fix_it_and_does_not_launch() {
    let (_dir, notes) = existing_notes();
    let auth = mdopener_mcp::parse_http_body(b"HTTP/1.0 401 Unauthorized\r\n\r\n{}").unwrap_err();
    let ipc = MockIpc::new().on_post("/open", Err(auth));
    let resp = tool_open_file_with(id(1), &json!({ "path": notes }), &ipc, &|url: &str| {
        panic!("must not fall back to the URL scheme: {url}")
    });
    let err = tool_error_text(&resp);
    assert_eq!(err, mdopener_mcp::APP_AUTH_FAILED_MSG);
    assert!(!err.contains("not running"), "{err}");
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
        // What to do next: check before retrying, which may open it twice.
        assert!(
            text.contains("call get_current_content to see which document is open"),
            "{text}"
        );
        assert!(text.ends_with("a retry may open it twice."), "{text}");
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

/// A directory was refused as "only Markdown documents ... can be opened",
/// which did not say what was wrong or what to pass instead.
#[test]
fn path_handing_tools_refuse_a_directory_as_a_directory() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["notes", "archive.md"] {
        let sub = dir.path().join(name);
        std::fs::create_dir(&sub).unwrap();
        let path = sub.to_string_lossy().into_owned();
        let ipc = MockIpc::new();
        let open = tool_open_file_with(id(1), &json!({ "path": path }), &ipc, &|url| {
            panic!("must not launch: {url}")
        });
        let present = tool_present_document(id(2), &json!({ "path": path }), &ipc);
        let review = tool_request_review(id(3), &json!({ "path": path, "blocking": false }), &ipc);
        for (resp, verb) in [(open, "open"), (present, "present"), (review, "review")] {
            let err = tool_error_text(&resp);
            assert!(
                err.starts_with(&format!("Refusing to {verb} `path` '")),
                "{err}"
            );
            assert!(err.contains("it is a directory, not a file"), "{err}");
            assert!(err.ends_with("Pass a Markdown file in it."), "{err}");
            assert!(!err.contains("only Markdown documents"), "{err}");
        }
        assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
    }
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
    // It used to end on a question, with no next step for the agent.
    assert!(err.contains("may not be installed"), "{err}");
    assert!(
        err.contains("github.com/ashlrai/ashlr-md/releases"),
        "{err}"
    );
    assert!(err.contains("call open_file again"), "{err}");
    assert!(!err.contains('?'), "{err}");
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

/// open_file's description said only that it opens a Markdown file and
/// launches the app, not which files it refuses or what it returns, so an
/// agent learned the dotfile rule, the missing-file refusal and the two
/// result shapes by calling it. Each named shape is the one the tool returns.
#[test]
fn open_file_description_names_its_refusals_and_results() {
    let def = tool_registry()
        .into_iter()
        .find(|d| d.name == "open_file")
        .unwrap();
    let d = def.description;
    for want in [
        ".md, .markdown, .mdown, .mkd, .mdx",
        "not dotfiles",
        "does not exist is refused",
        "{ opened, response }",
        "{ opened, method: 'url-scheme' }",
        "confirmed: false",
    ] {
        assert!(d.contains(want), "missing {want:?}: {d}");
    }
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("plan.md");
    std::fs::write(&doc, "# Plan\n").unwrap();
    let path = doc.to_string_lossy().into_owned();
    let ipc = MockIpc::new().on_post("/open", Ok(json!({ "ok": true })));
    let resp = tool_open_file_with(id(1), &json!({ "path": path }), &ipc, &|_| {
        panic!("must not launch")
    });
    let v = content_text(&resp);
    assert!(v["opened"].is_string() && v["response"].is_object(), "{v}");
    let ipc = MockIpc::new().on_post("/open", Err("ipc-port not found".into()));
    let resp = tool_open_file_with(id(1), &json!({ "path": path }), &ipc, &|_| Launch::Opened {
        launcher: "xdg-open".into(),
    });
    let v = content_text(&resp);
    assert!(v["opened"].is_string(), "{v}");
    assert_eq!(v["method"], "url-scheme", "{v}");
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

/// With no document open the app answers `{ path: null, content: "" }`. The
/// tool used to return that as a success, the same as an empty document; it
/// is an error now, as `mdopener://current` and `export_text` report it.
#[test]
fn get_current_content_no_doc_open_is_a_tool_error() {
    for body in [
        json!({ "path": null, "content": "" }),
        json!({ "path": null }),
        json!({}),
    ] {
        let ipc = MockIpc::new().on_get("/content", Ok(body.clone()));
        let resp = tool_get_content(id(1), &ipc);
        let err = tool_error_text(&resp);
        assert!(
            err.contains("No document is open in Ashlr MD"),
            "{body}: {err}"
        );
        assert!(err.contains("open_file"), "{err}");
    }
}

/// A saved document that is empty is still a success.
#[test]
fn get_current_content_empty_saved_document_is_a_success() {
    let ipc = MockIpc::new().on_get(
        "/content",
        Ok(json!({ "path": "/docs/empty.md", "content": "" })),
    );
    let resp = tool_get_content(id(1), &ipc);
    assert!(resp.error.is_none());
    assert_ne!(resp.result.as_ref().unwrap()["isError"], true);
    let text = content_text(&resp);
    assert_eq!(text["path"], "/docs/empty.md");
    assert_eq!(text["content"], "");
}

/// The app opens only files, so `path: null` is no document whatever
/// `content` holds, as the edit tools treat it. These reads refused it only
/// with empty content, so a path-less buffer with text read as a document.
/// Each now gives its own "no document open" error, with its text unchanged.
#[test]
fn reads_refuse_a_null_path_whatever_the_content() {
    let ipc = || {
        MockIpc::new().on_get(
            "/content",
            Ok(json!({ "path": null, "content": "# Draft\n" })),
        )
    };
    let err = tool_error_text(&tool_get_content(id(1), &ipc()));
    assert_eq!(
        err,
        "No document is open in Ashlr MD. Open one first (open_file)."
    );
    let resp = handle_resource_read(id(1), "mdopener://current", &ipc());
    let e = resp.error.expect("mdopener://current is an error");
    assert_eq!(e.code, -32002);
    assert_eq!(
        e.message,
        "No document is open in Ashlr MD. Open one first (open_file)."
    );
    let e = handle_prompt_get(id(1), "summarize", &ipc()).error.unwrap();
    assert_eq!(e.code, -32002);
    assert_eq!(
        e.message,
        "No document is open in Ashlr MD. Open one first (open_file)."
    );
    for tool in ["export_text", "export_metadata"] {
        let resp = call(tool, json!({}), &ipc());
        assert_eq!(
            tool_error_text(&resp),
            "No document is open in Ashlr MD; pass `path` to read a file.",
            "{tool}"
        );
    }
}

/// The description says what a null `path` means and that no open document
/// is an error, as `mdopener://current` reports it (`export_text` says so
/// with its own message, which
/// `get_current_content_description_quotes_each_nothing_open_message` pins).
#[test]
fn get_current_content_description_says_what_null_path_and_no_document_mean() {
    let reg = tool_registry();
    let def = reg
        .iter()
        .find(|d| d.name == "get_current_content")
        .unwrap();
    let d = def.description;
    // It used to say "`path` is null for an unsaved document"; the app opens
    // only files, so null is its welcome screen.
    assert!(
        d.contains(
            "the app opens only files, so it answers `path: null` only when no document is open"
        ),
        "{d}"
    );
    assert!(d.contains("With no document open this is an error"), "{d}");
    assert!(d.contains("isError: true"), "{d}");
    assert!(d.contains("as for mdopener://current"), "{d}");
    assert!(!d.contains("not an error"), "{d}");
}

#[test]
fn get_current_content_ipc_unavailable_returns_tool_error() {
    let ipc = MockIpc::new().on_get("/content", Err("Could not connect to IPC server".into()));
    let resp = tool_get_content(id(1), &ipc);
    tool_error_text(&resp);
}

#[test]
fn get_current_content_stale_ipc_returns_error_with_hint() {
    let ipc = MockIpc::new().on_get("/content", Err("~/.mdopener/ipc-port not found".into()));
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

/// The app reads at most 16 MiB of a request body: past that it answers 413
/// and closes the connection, so the agent saw "IPC write error: Connection
/// reset by peer", which reads as an app that crashed, with no next step.
/// Every tool that sends text to the app now refuses such a request first,
/// measured as sent (JSON-escaped), and says what to do instead.
#[test]
fn a_request_larger_than_the_app_reads_is_refused_before_it_is_sent() {
    let big = "x".repeat(17 * 1024 * 1024);
    // Under 16 MiB as text, but each newline is two bytes once escaped.
    let escaped = "\n".repeat(9 * 1024 * 1024);
    let ok = Ok(json!({ "ok": true }));
    for (tool, args, next) in [
        (
            "set_content",
            json!({ "content": big }),
            "Change part of it with edit_document",
        ),
        (
            "set_content",
            json!({ "content": escaped }),
            "Change part of it with edit_document",
        ),
        (
            "replace_document",
            json!({ "content": big }),
            "Change part of it with edit_document",
        ),
        (
            "edit_document",
            json!({ "find": "a", "replace": big }),
            "Split the change into smaller edits",
        ),
        (
            "stream_edit",
            json!({ "find": big, "replace": "b" }),
            "Split the change into smaller edits",
        ),
        (
            "stream_edit_apply",
            json!({ "find": "a", "replace": big }),
            "Split the change into smaller edits",
        ),
        (
            "request_review",
            json!({ "content": big, "blocking": false }),
            "pass its `path` instead",
        ),
    ] {
        let ipc = MockIpc::new()
            .on_post("/", ok.clone())
            .on_get("/", Ok(json!({ "path": null, "content": "" })));
        let resp = dispatch(
            dispatch_req("tools/call", json!({ "name": tool, "arguments": args })),
            &ipc,
        )
        .unwrap();
        let err = resp
            .error
            .unwrap_or_else(|| panic!("{tool}: {:?}", resp.result));
        assert_eq!(err.code, -32602, "{tool}: {}", err.message);
        assert!(
            err.message.contains(
                "more than the 16 MiB Ashlr MD accepts in one request, so nothing was sent."
            ),
            "{tool}: {}",
            err.message
        );
        assert!(err.message.contains(next), "{tool}: {}", err.message);
        assert!(
            ipc.calls().iter().all(|(m, _, _)| m != "POST"),
            "{tool}: nothing is sent: {:?}",
            ipc.calls()
                .iter()
                .map(|(m, p, _)| (m, p))
                .collect::<Vec<_>>()
        );
    }
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

/// A `limit` that is not a whole number from 1 to 200 used to become the
/// default (2.5) or reach the app unchecked (0, a huge value). It is refused,
/// before the app is asked, both by the tool and by the schema check.
#[test]
fn list_recent_refuses_a_limit_out_of_range_or_not_whole() {
    for bad in [
        json!(0),
        json!(2.5),
        json!(201),
        json!(1_000_000_000_000u64),
        json!(-1),
    ] {
        let ipc = MockIpc::new().on_get("/recent", Ok(json!([])));
        let resp = tool_list_recent(id(1), &json!({ "limit": bad }), &ipc);
        let err = resp
            .error
            .as_ref()
            .unwrap_or_else(|| panic!("{bad} was accepted"));
        assert_eq!(err.code, -32602);
        assert!(
            err.message
                .contains("`limit` must be a whole number from 1 to 200"),
            "{}",
            err.message
        );
        assert!(ipc.calls().is_empty(), "{bad} reached the app");

        let msg = param_error(&call_tool("list_recent", json!({ "limit": bad })));
        assert!(msg.contains("`limit`"), "{msg}");
    }
    let msg = param_error(&call_tool("list_recent", json!({ "limit": 0 })));
    assert_eq!(msg, "`limit` must be at least 1, got 0");
    let msg = param_error(&call_tool("list_recent", json!({ "limit": 500 })));
    assert_eq!(msg, "`limit` must be at most 200, got 500");

    // The bounds themselves, `2.0` as a whole number, and `null` (the default).
    for (limit, want) in [
        (json!(1), "limit=1"),
        (json!(200), "limit=200"),
        (json!(3.0), "limit=3"),
        (json!(null), "limit=10"),
    ] {
        let ipc = MockIpc::new().on_get("/recent", Ok(json!([])));
        let resp = tool_list_recent(id(1), &json!({ "limit": limit }), &ipc);
        assert!(resp.error.is_none(), "{limit}: {:?}", resp.error);
        assert!(
            ipc.calls()[0].1.ends_with(want),
            "{limit}: {:?}",
            ipc.calls()
        );
    }
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
fn edit_document_empty_find_is_refused_without_the_app() {
    // The app is closed: an empty `find` must still be named as the problem,
    // not answered with "start the app".
    let ipc = MockIpc::new().on_post("/edit", Err("Could not connect to IPC server".into()));
    let resp = tool_edit_document(id(1), &json!({ "find": "", "replace": "x" }), &ipc);
    let err = resp
        .error
        .as_ref()
        .expect("an empty find must be a param error");
    assert_eq!(err.code, -32602);
    assert_eq!(err.message, "`find` must not be empty");
    assert!(ipc.calls().is_empty(), "nothing is sent to the app");
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
    let dir = tempfile::tempdir().unwrap();
    let notes = dir.path().join("notes.md");
    std::fs::write(&notes, "# Notes\n").unwrap();
    let ipc = MockIpc::new().on_post("/present", Ok(json!({ "ok": true })));
    let resp = tool_present_document(id(1), &json!({ "path": notes }), &ipc);
    assert!(resp.error.is_none());
    assert!(!is_error(&resp), "{resp:?}");
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

/// A missing file was sent to the app, so with the app closed the agent was
/// told only that it is not running. It is refused before the app is asked,
/// with the absolute path, whether the app is running or not.
#[test]
fn present_document_refuses_a_missing_file_without_asking_the_app() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("gone.md");
    for ipc in [
        MockIpc::new().on_post("/present", Ok(json!({ "ok": true }))),
        MockIpc::new().on_post("/present", Err("ipc-port not found".into())),
    ] {
        let resp = tool_present_document(id(1), &json!({ "path": missing }), &ipc);
        let err = tool_error_text(&resp);
        assert!(
            err.contains(&format!(
                "Cannot present '{}': the file does not exist.",
                missing.display()
            )),
            "{err}"
        );
        assert!(ipc.calls().is_empty(), "the app must not be asked");
    }
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
fn get_user_annotations_empty_path_is_refused_without_the_app() {
    let ipc = MockIpc::new().on_get("/annotations", Err("ipc-port not found".into()));
    let resp = tool_get_annotations(id(1), &json!({ "path": "" }), &ipc);
    let err = resp.error.as_ref().expect("an empty path is a param error");
    assert_eq!(err.code, -32602);
    assert_eq!(err.message, "`path` must not be empty");
    assert!(ipc.calls().is_empty(), "nothing is sent to the app");
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
    // An app that was reached but failed is still an error: its answer may
    // hold a verdict the disk does not, so nothing is made up in its place.
    let ipc = MockIpc::new().on_get(
        "/annotations",
        Err("IPC server returned HTTP 500: boom".into()),
    );
    let resp = tool_get_annotations(id(1), &json!({ "path": "/x.md" }), &ipc);
    let text = tool_error_text(&resp);
    assert!(text.contains("boom"), "{text}");
}

/// With the app closed, the tasks still come from the file on disk, as the
/// description says; it used to be an error telling the agent to start the
/// app. The result says the app is not running and what null means then.
#[test]
fn get_user_annotations_reads_tasks_from_disk_when_the_app_is_not_running() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("plan.md");
    std::fs::write(
        &file,
        "# Plan\n- [x] write it\n- [ ] test it\n* [X] ship it\n",
    )
    .unwrap();
    for err in [
        "ipc-port not found",
        "Could not connect to IPC server: refused",
    ] {
        let ipc = MockIpc::new().on_get("/annotations", Err(err.into()));
        let resp = tool_get_annotations(id(1), &json!({ "path": file.to_str().unwrap() }), &ipc);
        assert!(!is_error(&resp), "{err}: {:?}", resp.result);
        let v = content_text(&resp);
        assert_eq!(
            v["tasks"],
            json!([
                { "text": "write it", "checked": true },
                { "text": "test it", "checked": false },
                { "text": "ship it", "checked": true }
            ]),
            "{v}"
        );
        assert!(v["verdict"].is_null() && v["comments"].is_null(), "{v}");
        assert_eq!(v["late"], false);
        assert_eq!(v["appRunning"], false);
        assert!(v.get("tasksNote").is_none(), "{v}");
        assert_eq!(v["note"], mdopener_mcp::ANNOTATIONS_APP_NOT_RUNNING_NOTE);
        let note = v["note"].as_str().unwrap();
        assert!(note.contains("not running"), "{note}");
        assert!(note.contains("request_review"), "{note}");
        let canonical = std::fs::canonicalize(&file).unwrap();
        assert_eq!(v["path"], canonical.to_str().unwrap());
    }
}

/// An app that answers HTTP 401 (a stale ~/.mdopener/ipc-token, or another
/// instance on the port) was the bare "IPC auth failed" error: no tasks and no
/// next step. The tasks now come from disk, and the note names the token and
/// how to fix it.
#[test]
fn get_user_annotations_reads_tasks_from_disk_when_the_app_refuses_the_token() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("plan.md");
    std::fs::write(&file, "- [x] write it\n- [ ] test it\n").unwrap();
    let raw = b"HTTP/1.0 401 Unauthorized\r\n\r\n{}";
    let err = mdopener_mcp::parse_http_body(raw).unwrap_err();
    let ipc = MockIpc::new().on_get("/annotations", Err(err));
    let resp = tool_get_annotations(id(1), &json!({ "path": file.to_str().unwrap() }), &ipc);
    assert!(!is_error(&resp), "{:?}", resp.result);
    let v = content_text(&resp);
    assert_eq!(
        v["tasks"],
        json!([
            { "text": "write it", "checked": true },
            { "text": "test it", "checked": false }
        ]),
        "{v}"
    );
    assert!(v["verdict"].is_null() && v["comments"].is_null(), "{v}");
    assert_eq!(v["appAuthFailed"], true, "{v}");
    assert!(v.get("appRunning").is_none(), "the app may be running: {v}");
    assert_eq!(v["note"], mdopener_mcp::ANNOTATIONS_APP_AUTH_FAILED_NOTE);
    let note = v["note"].as_str().unwrap();
    for part in ["ipc-token", "401", "quit", "get_user_annotations again"] {
        assert!(note.contains(part), "{part}: {note}");
    }
}

/// With a 401 the file that cannot be read still says why.
#[test]
fn get_user_annotations_with_a_refused_token_says_why_a_file_was_not_read() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("gone.md");
    let ipc = MockIpc::new().on_get(
        "/annotations",
        Err("IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token".into()),
    );
    let resp = tool_get_annotations(id(1), &json!({ "path": missing.to_str().unwrap() }), &ipc);
    let v = content_text(&resp);
    assert_eq!(v["tasks"], json!([]), "{v}");
    assert_eq!(v["appAuthFailed"], true);
    assert!(
        v["tasksNote"]
            .as_str()
            .unwrap_or_default()
            .contains("were not read"),
        "{v}"
    );
}

/// A file the disk read cannot take (missing, not Markdown) has no tasks, and
/// `tasksNote` says why rather than an empty list reading as "no tasks".
#[test]
fn get_user_annotations_without_the_app_says_why_a_file_was_not_read() {
    let dir = tempfile::tempdir().unwrap();
    let env = dir.path().join("secrets.txt");
    std::fs::write(&env, "- [ ] not a task list").unwrap();
    let missing = dir.path().join("gone.md");
    for (p, why) in [(env, "only Markdown"), (missing, "were not read")] {
        let ipc = MockIpc::new().on_get("/annotations", Err("ipc-port not found".into()));
        let resp = tool_get_annotations(id(1), &json!({ "path": p.to_str().unwrap() }), &ipc);
        assert!(!is_error(&resp), "{:?}", resp.result);
        let v = content_text(&resp);
        assert_eq!(v["tasks"], json!([]), "{v}");
        assert_eq!(v["appRunning"], false);
        let note = v["tasksNote"].as_str().unwrap_or_default();
        assert!(note.contains(why), "{p:?}: {note}");
    }
}

/// `tasksNote` for a missing file quoted the raw OS error ("No such file or
/// directory (os error 2)"); it now says what the other disk tools say.
#[test]
fn get_user_annotations_tasks_note_says_the_file_does_not_exist() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("gone.md");
    let abs = mdopener_mcp::agent_path(missing.to_str().unwrap());
    for err in [
        "~/.mdopener/ipc-port not found",
        "IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token",
    ] {
        let ipc = MockIpc::new().on_get("/annotations", Err(err.into()));
        let resp = tool_get_annotations(id(1), &json!({ "path": missing.to_str().unwrap() }), &ipc);
        let v = content_text(&resp);
        assert_eq!(
            v["tasksNote"],
            format!("Cannot read '{abs}': the file does not exist. Its tasks were not read."),
            "{err}: {v}"
        );
        assert!(
            !v["tasksNote"].as_str().unwrap().contains("os error"),
            "{v}"
        );
    }
}

/// The description and the initialize instructions say it works without the
/// app, and how.
#[test]
fn get_user_annotations_is_described_as_working_without_the_app() {
    let def = tool_registry()
        .into_iter()
        .find(|t| t.name == "get_user_annotations")
        .unwrap();
    assert!(
        def.description.contains("appRunning: false"),
        "{}",
        def.description
    );
    assert!(mdopener_mcp::SERVER_INSTRUCTIONS.contains("get_user_annotations"));
}

/// The instructions said the tools that work without the app all work "on
/// files on disk" (list_ai_actions reads none) and to pass `path` to
/// diff_documents, which takes `path_a` and `path_b`. Every tool the
/// sentence names now answers with no app to reach, given the argument it
/// says to pass.
#[test]
fn instructions_name_the_tools_that_work_without_the_app() {
    let text = mdopener_mcp::SERVER_INSTRUCTIONS;
    assert!(!text.contains("diff_documents (pass `path`)"), "{text}");
    assert!(!text.contains("files on disk"), "{text}");
    let tail = text
        .split("Without the app these still work: ")
        .nth(1)
        .expect("instructions list the tools that work without the app");
    let listed: Vec<&str> = tail
        .split(|c: char| !(c.is_ascii_lowercase() || c == '_'))
        .filter(|w| w.contains('_'))
        .collect();
    // Not a dot-named folder: search_vault does not search hidden ones.
    let dir = tempfile::Builder::new().prefix("notes").tempdir().unwrap();
    let md = dir.path().join("a.md");
    std::fs::write(&md, "# A\n\n- [ ] task\n").unwrap();
    let canvas = dir.path().join("b.canvas");
    std::fs::write(&canvas, r#"{"nodes":[],"edges":[]}"#).unwrap();
    let sess = unique_session();
    let node =
        json!({ "id": "n", "type": "text", "text": "t", "x": 0, "y": 0, "width": 9, "height": 9 });
    let mut checked = Vec::new();
    for tool in listed {
        let args = match tool {
            "export_text" | "export_metadata" | "get_user_annotations" => json!({ "path": md }),
            "diff_documents" => json!({ "path_a": md, "path_b": md }),
            "edit_canvas" => {
                json!({ "path": canvas, "ops": [{ "type": "add_node", "node": node }], "save": false })
            }
            "search_vault" => json!({ "query": "task", "vault": dir.path(), "semantic": false }),
            "list_ai_actions" => json!({}),
            "get_conversation_context" => json!({ "session_id": sess }),
            "save_conversation_message" => {
                json!({ "session_id": sess, "role": "agent", "content": "hi" })
            }
            other => panic!("instructions say {other} works without the app; add it here"),
        };
        // Every request to the app fails as it does with the app closed.
        let down = "Could not connect to IPC server at 127.0.0.1:1: Connection refused";
        let ipc = MockIpc::new()
            .on_get("/", Err(down.into()))
            .on_post("/", Err(down.into()));
        let resp = call(tool, args, &ipc);
        assert!(resp.error.is_none(), "{tool}: {:?}", resp.error);
        assert!(!is_error(&resp), "{tool}: {resp:?}");
        checked.push(tool);
    }
    assert_eq!(checked.len(), 9, "{checked:?}");
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

/// doc-explain-selection has scope "document", and the app's AI sidebar
/// sends it the document (its first 8,000 characters), never a selection.
/// Its label said "Explain selection" and its prompt that the user would
/// provide selected text. The scope stays (list_ai_actions' description and
/// the scope filter above read it); the label and prompts now say document,
/// as src/ai/actions.ts does.
#[test]
fn doc_explain_selection_describes_the_document_it_is_sent() {
    let text = content_text(&tool_list_ai_actions(id(1), &json!({})));
    let action = text["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == "doc-explain-selection")
        .unwrap()
        .clone();
    assert_eq!(action["scope"], "document");
    assert_eq!(action["label"], "Explain doc");
    assert_eq!(action["shortLabel"], "Explain doc");
    for field in ["label", "shortLabel", "systemPrompt", "userPromptTemplate"] {
        let v = action[field].as_str().unwrap().to_lowercase();
        assert!(!v.contains("select"), "{field}: {v}");
    }
    assert!(action["systemPrompt"]
        .as_str()
        .unwrap()
        .contains("The user will provide a Markdown document."));
    assert_eq!(
        action["userPromptTemplate"],
        "Explain this document:\n\n{text}"
    );
    let d = tool_registry()
        .into_iter()
        .find(|d| d.name == "list_ai_actions")
        .unwrap()
        .description;
    assert!(
        d.contains("for scope 'document', the document, of which the app sends at most the first 8,000 characters"),
        "{d}"
    );
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
/// `{arg}` used to appear in two actions' templates with nothing saying what
/// it is, so an agent could not fill it in (translate's target language).
#[test]
fn list_ai_actions_says_what_arg_is_wherever_a_template_uses_it() {
    for include_prompts in [true, false] {
        let resp = tool_list_ai_actions(id(1), &json!({ "include_prompts": include_prompts }));
        let text = content_text(&resp);
        for (listed, full) in text["actions"]
            .as_array()
            .unwrap()
            .iter()
            .zip(ai_actions_registry().as_array().unwrap())
        {
            let uses_arg = ["systemPrompt", "userPromptTemplate"]
                .iter()
                .any(|k| full[k].as_str().unwrap().contains("{arg}"));
            let argument = listed["argument"].as_str();
            if uses_arg {
                let a = argument.unwrap_or_else(|| {
                    panic!("action {} uses {{arg}} but has no `argument`", full["id"])
                });
                assert!(a.contains("{arg}"), "{}: {a}", full["id"]);
            } else {
                assert!(argument.is_none(), "{} has no {{arg}}", full["id"]);
            }
        }
    }
    let resp = tool_list_ai_actions(id(1), &json!({}));
    let actions = content_text(&resp)["actions"].clone();
    let translate = actions
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == "translate")
        .unwrap()
        .clone();
    assert!(
        translate["argument"].as_str().unwrap().contains("Spanish"),
        "{translate}"
    );
}

/// The registry claims to mirror src/ai/actions.ts; check the ids, labels,
/// short labels and icons there, in order, so the two cannot drift apart.
#[test]
fn ai_actions_registry_matches_actions_ts() {
    let ts = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src/ai/actions.ts"),
    )
    .unwrap();
    let quoted = |line: &str, key: &str| -> Option<String> {
        let rest = line.trim().strip_prefix(key)?.strip_prefix(": \"")?;
        Some(rest[..rest.find('"')?].to_string())
    };
    let mut from_ts: Vec<(String, String, String, String)> = Vec::new();
    let lines: Vec<&str> = ts.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let Some(id) = quoted(line, "id") else {
            continue;
        };
        let field = |key: &str| {
            lines[i + 1..(i + 4).min(lines.len())]
                .iter()
                .find_map(|l| quoted(l, key))
        };
        let label = field("label").unwrap();
        // Document actions have no shortLabel; the registry uses the label.
        let short = field("shortLabel").unwrap_or_else(|| label.clone());
        from_ts.push((id, label, short, field("icon").unwrap()));
    }
    let registry: Vec<(String, String, String, String)> = ai_actions_registry()
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            let s = |k: &str| a[k].as_str().unwrap().to_string();
            (s("id"), s("label"), s("shortLabel"), s("icon"))
        })
        .collect();
    assert_eq!(registry, from_ts);
}

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
    let msg = mdopener_mcp::app_not_running_msg("~/.mdopener/ipc-port not found");
    assert_eq!(
        msg,
        "Ashlr MD does not appear to be running (~/.mdopener/ipc-port not found). \
         Launch it first, or use open_file which can start it automatically. If it \
         is not installed, ask the user to install it from \
         https://github.com/ashlrai/ashlr-md/releases."
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
    let msg = mdopener_mcp::app_not_running_msg("IPC server returned HTTP 500");
    // Should pass through unchanged for non-connectivity errors
    assert_eq!(msg, "IPC server returned HTTP 500");
}

/// An HTTP 401 (a stale ~/.mdopener/ipc-token, or another instance on the
/// port) came back from every app tool but get_user_annotations as the bare
/// "IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token", with
/// no cause and no next step. It is now one message that says both, in the
/// words of get_user_annotations' `appAuthFailed` note.
#[test]
fn every_app_tool_explains_a_refused_token_and_how_to_fix_it() {
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("plan.md");
    std::fs::write(&doc, "# Plan\n").unwrap();
    let doc = doc.to_str().unwrap();
    let out = dir.path().join("plan.html");
    let out = out.to_str().unwrap();
    let auth = mdopener_mcp::parse_http_body(b"HTTP/1.0 401 Unauthorized\r\n\r\n{}").unwrap_err();
    let ipc = MockIpc::new()
        .on_get("/", Err(auth.clone()))
        .on_post("/", Err(auth));
    let calls: Vec<(&str, mdopener_mcp::Response)> = vec![
        ("get_current_content", tool_get_content(id(1), &ipc)),
        (
            "set_content",
            tool_set_content(id(1), &json!({ "content": "x" }), &ipc),
        ),
        ("list_recent", tool_list_recent(id(1), &json!({}), &ipc)),
        (
            "export",
            tool_export_with(
                id(1),
                &json!({ "format": "html", "output_path": out }),
                &ipc,
                std::time::Duration::from_millis(10),
            ),
        ),
        (
            "request_review",
            tool_request_review(id(1), &json!({ "path": doc, "blocking": false }), &ipc),
        ),
        (
            "edit_document",
            tool_edit_document(id(1), &json!({ "find": "a", "replace": "b" }), &ipc),
        ),
        (
            "replace_document",
            tool_replace_document(id(1), &json!({ "content": "x" }), &ipc),
        ),
        (
            "search_vault",
            tool_search_vault(id(1), &json!({ "query": "plan", "semantic": false }), &ipc),
        ),
        (
            "present_document",
            tool_present_document(id(1), &json!({ "path": doc }), &ipc),
        ),
        (
            "stream_edit",
            tool_stream_edit(id(1), &json!({ "find": "a", "replace": "b" }), &ipc),
        ),
        (
            "stream_edit_apply",
            tool_stream_edit_apply(
                id(1),
                &json!({ "edit_id": "e1", "find": "a", "replace": "b" }),
                &ipc,
            ),
        ),
        (
            "export_text",
            mdopener_mcp::tool_export_text(id(1), &json!({}), &ipc),
        ),
    ];
    for (tool, resp) in calls {
        let err = tool_error_text(&resp);
        // search_vault can search `vault` on disk after a 401, as it can
        // when the app is unreachable, so it names `vault` after the shared
        // message (it used to be the bare message, which named no way on).
        let want = if tool == "search_vault" {
            format!(
                "{} {}",
                mdopener_mcp::APP_AUTH_FAILED_MSG,
                mdopener_mcp::SEARCH_WITHOUT_APP_HINT
            )
        } else {
            mdopener_mcp::APP_AUTH_FAILED_MSG.to_string()
        };
        assert_eq!(err, want, "{tool}");
    }
    let msg = mdopener_mcp::APP_AUTH_FAILED_MSG;
    for part in [
        "HTTP 401",
        "~/.mdopener/ipc-token",
        "stale",
        "another Ashlr MD instance",
        "quit every Ashlr MD window",
        "start the app again",
        "retry",
    ] {
        assert!(msg.contains(part), "{part}: {msg}");
    }
    // The same cause as get_user_annotations' note, word for word.
    let cause = msg.split(" Ask the user").next().unwrap();
    assert!(
        mdopener_mcp::ANNOTATIONS_APP_AUTH_FAILED_NOTE.starts_with(cause),
        "{cause}"
    );
}

/// With the app closed, a tool given `path` was told to "use open_file which
/// can start it", leaving the agent to work out the call. It now names the
/// `open_file` call with that exact path, ready to copy.
#[test]
fn app_tools_given_a_path_name_the_open_file_call_when_the_app_is_closed() {
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("plan.md");
    std::fs::write(&doc, "# Plan\n").unwrap();
    let canonical = std::fs::canonicalize(&doc).unwrap();
    let canonical = canonical.to_str().unwrap();
    let doc = doc.to_str().unwrap();
    let down = "~/.mdopener/ipc-port not found";
    let ipc = MockIpc::new()
        .on_get("/", Err(down.into()))
        .on_post("/", Err(down.into()));
    let next = format!(
        "Call open_file with {}, which starts it with this document, then call this tool again.",
        json!({ "path": canonical })
    );
    let calls: Vec<(&str, mdopener_mcp::Response)> = vec![
        (
            "request_review",
            tool_request_review(id(1), &json!({ "path": doc, "blocking": false }), &ipc),
        ),
        (
            "present_document",
            tool_present_document(id(1), &json!({ "path": doc }), &ipc),
        ),
        (
            "edit_document",
            tool_edit_document(
                id(1),
                &json!({ "find": "a", "replace": "b", "path": doc }),
                &ipc,
            ),
        ),
        (
            "stream_edit",
            tool_stream_edit(
                id(1),
                &json!({ "find": "a", "replace": "b", "path": doc }),
                &ipc,
            ),
        ),
    ];
    for (tool, resp) in calls {
        let err = tool_error_text(&resp);
        assert_eq!(
            err,
            format!(
                "Ashlr MD does not appear to be running ({down}). {next} If it is not \
                 installed, ask the user to install it from \
                 https://github.com/ashlrai/ashlr-md/releases."
            ),
            "{tool}"
        );
    }
    // Without `path` there is no document to name: the generic step stays.
    let resp = tool_present_document(id(1), &json!({}), &ipc);
    let err = tool_error_text(&resp);
    assert!(err.contains("use open_file which can start it"), "{err}");
    assert!(!err.contains("\"path\""), "{err}");
}

/// With the app closed, stream_edit_apply said to call open_file and then
/// call it again, but the editId of a preview made before the app started
/// no longer exists, and the document may have changed. It now says to run
/// stream_edit again for a fresh preview, with or without `path`.
#[test]
fn stream_edit_apply_with_the_app_closed_asks_for_a_fresh_preview() {
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("plan.md");
    std::fs::write(&doc, "# Plan\n").unwrap();
    let canonical = std::fs::canonicalize(&doc).unwrap();
    let canonical = canonical.to_str().unwrap();
    let down = "~/.mdopener/ipc-port not found";
    let ipc = MockIpc::new().on_post("/", Err(down.into()));
    let args = json!({ "edit_id": "e1", "find": "a", "replace": "b", "path": doc });
    let err = tool_error_text(&tool_stream_edit_apply(id(1), &args, &ipc));
    assert_eq!(
        err,
        format!(
            "Ashlr MD does not appear to be running ({down}). Call open_file with {}, which \
             starts it with this document, then call stream_edit again for a fresh preview \
             before stream_edit_apply: the editId of a preview from before the app started no \
             longer exists, and the document may have changed since. If it is not installed, \
             ask the user to install it from https://github.com/ashlrai/ashlr-md/releases.",
            json!({ "path": canonical })
        )
    );
    let args = json!({ "edit_id": "e1", "find": "a", "replace": "b" });
    let err = tool_error_text(&tool_stream_edit_apply(id(1), &args, &ipc));
    assert!(err.contains("use open_file which can start it"), "{err}");
    assert!(
        err.contains("call stream_edit again for a fresh preview"),
        "{err}"
    );
    assert!(!err.contains("call this tool again"), "{err}");
    // A refused token is still the shared message.
    let auth = mdopener_mcp::parse_http_body(b"HTTP/1.0 401 Unauthorized\r\n\r\n{}").unwrap_err();
    let ipc = MockIpc::new().on_post("/", Err(auth));
    let err = tool_error_text(&tool_stream_edit_apply(id(1), &args, &ipc));
    assert_eq!(err, mdopener_mcp::APP_AUTH_FAILED_MSG);
}

/// A path with a quote or backslash is written as JSON, so the call still
/// parses when copied.
#[test]
fn app_not_running_msg_for_writes_the_path_as_json() {
    let msg = mdopener_mcp::app_not_running_msg_for(
        "~/.mdopener/ipc-port not found",
        Some(r#"/tmp/a "b"\c.md"#),
    );
    assert!(
        msg.contains(r#"open_file with {"path":"/tmp/a \"b\"\\c.md"}"#),
        "{msg}"
    );
    // A refusal and a 401 read the same with or without a path.
    assert_eq!(
        mdopener_mcp::app_not_running_msg_for("IPC auth failed: x", Some("/a.md")),
        mdopener_mcp::APP_AUTH_FAILED_MSG
    );
    assert_eq!(
        mdopener_mcp::app_not_running_msg_for("IPC server returned HTTP 404: gone", Some("/a.md")),
        "IPC server returned HTTP 404: gone"
    );
}

/// list_recent needs the app (it keeps the list), and its description did
/// not say so.
#[test]
fn list_recent_is_described_as_needing_the_app() {
    let def = tool_registry()
        .into_iter()
        .find(|t| t.name == "list_recent")
        .unwrap();
    assert!(
        def.description.contains("Needs Ashlr MD running"),
        "{}",
        def.description
    );
    assert!(def.description.contains("open_file"), "{}", def.description);
}

/// A 401 while waiting on a review says what to do, and that restarting the
/// app ends the review, instead of "Lost contact ...: IPC auth failed".
#[test]
fn request_review_that_hits_a_refused_token_says_to_restart_and_request_again() {
    use mdopener_mcp::tool_request_review_with;
    use std::time::Duration;
    let ipc = MockIpc::new()
        .on_post("/review", Ok(json!({ "ok": true })))
        .on_get(
            "/review/result",
            Err("IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token".into()),
        );
    let resp = tool_request_review_with(
        id(1),
        &json!({ "content": "plan", "wait_ms": 1000 }),
        &ipc,
        Duration::from_millis(10),
    );
    let err = tool_error_text(&resp);
    assert!(err.contains(mdopener_mcp::APP_AUTH_FAILED_MSG), "{err}");
    assert!(err.contains("request a new one"), "{err}");
    assert!(!err.contains("IPC auth failed"), "{err}");
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
    let ipc = MockIpc::new().on_post("/export", Err("~/.mdopener/ipc-port not found".into()));
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

/// `text://vault-search` takes a query, so it is a resource template; the
/// templates method used to be unknown (`-32601`).
#[test]
fn resources_templates_list_offers_the_vault_search_template() {
    let no_app = MockIpc::new();
    let resp = dispatch(dispatch_req("resources/templates/list", json!({})), &no_app).unwrap();
    assert!(resp.error.is_none(), "{:?}", resp.error);
    assert!(no_app.calls().is_empty(), "listing templates needs no app");
    let templates = resp.result.as_ref().unwrap()["resourceTemplates"]
        .as_array()
        .expect("resourceTemplates array")
        .clone();
    assert_eq!(templates.len(), 1, "{templates:?}");
    let t = &templates[0];
    assert_eq!(t["uriTemplate"], "text://vault-search?q={query}");
    assert_eq!(t["mimeType"], "application/json");
    assert!(t["name"].as_str().is_some_and(|n| !n.is_empty()));
    // The template, filled in, is a URI resources/read serves.
    let ipc = MockIpc::new()
        .on_get("/search", Ok(json!({ "query": "plan", "results": [] })))
        .on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
    let uri = t["uriTemplate"]
        .as_str()
        .unwrap()
        .replace("{query}", "plan")
        + "&semantic=false";
    let read = dispatch(dispatch_req("resources/read", json!({ "uri": uri })), &ipc).unwrap();
    assert!(read.error.is_none(), "{:?}", read.error);
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
    let mut f = tempfile::Builder::new()
        .prefix("note")
        .suffix(".md")
        .tempfile()
        .expect("tempfile");
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
    let mut f = tempfile::Builder::new()
        .prefix("note")
        .suffix(".md")
        .tempfile()
        .expect("tempfile");
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
    let mut fa = tempfile::Builder::new()
        .prefix("note")
        .suffix(".md")
        .tempfile()
        .unwrap();
    for i in 0..9 {
        writeln!(fa, "line {i}").unwrap();
    }
    writeln!(fa, "found the needle here").unwrap();
    let path_a = fa.path().to_str().unwrap().to_string();

    // File B: query appears in every line → high density.
    let mut fb = tempfile::Builder::new()
        .prefix("note")
        .suffix(".md")
        .tempfile()
        .unwrap();
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

/// Recents hold whatever the human opened. The grep and semantic searches
/// read every one, so a dropped `.env` or a `notes.md` link to a key had its
/// matching lines returned, though every other read refuses such files.
#[test]
fn vault_searches_read_only_markdown_documents() {
    use mdopener_mcp::semantic_search_vault_with;
    let dir = tempfile::tempdir().unwrap();
    let md = dir.path().join("notes.md");
    std::fs::write(&md, "TOKEN in notes\n").unwrap();
    let env = dir.path().join(".env");
    std::fs::write(&env, "TOKEN=secret\n").unwrap();
    let key = dir.path().join("id_rsa");
    std::fs::write(&key, "TOKEN key\n").unwrap();
    let hidden = dir.path().join(".hidden.md");
    std::fs::write(&hidden, "TOKEN hidden\n").unwrap();
    let mut recents = vec![env, key.clone(), hidden];
    #[cfg(unix)]
    {
        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink(&key, &link).unwrap();
        recents.push(link);
    }
    let ipc = MockIpc::new().on_get(
        "/vault",
        Ok(json!({
            "files": [{ "path": md.to_str().unwrap() }],
            "recents": recents.iter().map(|p| p.to_str().unwrap()).collect::<Vec<_>>(),
        })),
    );
    let canon = std::fs::canonicalize(&md).unwrap();
    let only_notes = |results: &[Value]| {
        let paths: Vec<&str> = results.iter().filter_map(|r| r["path"].as_str()).collect();
        assert_eq!(paths, vec![canon.to_str().unwrap()], "{results:?}");
    };
    only_notes(&grep_vault("TOKEN", 50, &ipc).unwrap());
    let embed = |_: &str| Ok(vec![1.0, 0.0]);
    only_notes(&semantic_search_vault_with("TOKEN", 50, &ipc, &embed).unwrap());
}

#[test]
fn grep_vault_respects_limit() {
    use std::io::Write;
    let ipc_files: Vec<Value> = (0..10)
        .map(|i| {
            let mut f = tempfile::Builder::new()
                .prefix("note")
                .suffix(".md")
                .tempfile()
                .unwrap();
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
    let mut f = tempfile::Builder::new()
        .prefix("note")
        .suffix(".md")
        .tempfile()
        .unwrap();
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
    let mut f = tempfile::Builder::new()
        .prefix("note")
        .suffix(".md")
        .tempfile()
        .unwrap();
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

/// Semantic search that fell back to the app's own search replaced the app's
/// `note` with its own, so `truncated: true` came with no word that only the
/// newest files were searched.
#[test]
fn a_semantic_fallback_keeps_the_apps_truncation_note() {
    let app_note = "The watched folder has more Markdown files than Ashlr MD lists, so only \
                    its 200 most recently changed files (and the recent documents) were searched.";
    let ipc = MockIpc::new()
        .on_get(
            "/vault",
            Ok(json!({ "files": [], "recents": [], "truncated": true, "limit": 200 })),
        )
        .on_get(
            "/search",
            Ok(json!({ "query": "q", "results": [], "truncated": true, "note": app_note })),
        );
    let embed = |_: &str| Err("Ollama is not running".to_string());
    let v = mdopener_mcp::search_vault_in("q", 5, true, None, &ipc, &embed).unwrap();
    assert_eq!(v["mode"], "grep", "{v}");
    assert_eq!(v["truncated"], true, "{v}");
    let note = v["note"].as_str().unwrap();
    assert!(
        note.starts_with("Semantic search was unavailable"),
        "{note}"
    );
    assert!(note.ends_with(app_note), "{note}");
}

/// The app lists at most `limit` files of the watched folder (its synced
/// MAX_FILES); search_vault said nothing when the folder had more, so "no
/// hits" read as "not in the folder". The number in the note is the app's,
/// not one hard-coded in the server.
#[test]
fn search_vault_says_when_the_apps_vault_list_is_truncated() {
    use std::io::Write;
    let mut f = tempfile::Builder::new()
        .prefix("note")
        .suffix(".md")
        .tempfile()
        .unwrap();
    writeln!(f, "# Notes\nThe target topic is here.").unwrap();
    let path = f.path().to_str().unwrap().to_string();
    let vault =
        json!({ "files": [{ "path": path }], "recents": [], "truncated": true, "limit": 150 });
    // The app's own search failed: grep the listed files locally.
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(vault.clone()))
        .on_get("/search", Err("IPC server returned HTTP 500: boom".into()));
    let text = content_text(&tool_search_vault(
        id(1),
        &json!({ "query": "target topic", "semantic": false }),
        &ipc,
    ));
    assert_eq!(text["mode"], "grep-local", "{text}");
    assert_eq!(text["truncated"], true, "{text}");
    assert!(
        text["note"]
            .as_str()
            .unwrap()
            .contains("its 150 most recently changed"),
        "{text}"
    );
    // Semantic search over the listed files says so too.
    let ipc = MockIpc::new().on_get("/vault", Ok(vault));
    let embed = |_: &str| Ok(vec![1.0, 0.0]);
    let v = mdopener_mcp::search_vault_in("target topic", 5, true, None, &ipc, &embed).unwrap();
    assert_eq!(v["mode"], "semantic", "{v}");
    assert_eq!(v["truncated"], true, "{v}");
    assert!(
        v["note"]
            .as_str()
            .unwrap()
            .contains("its 150 most recently changed"),
        "{v}"
    );
    // An older app that does not send its cap: no number is claimed.
    let ipc = MockIpc::new()
        .on_get(
            "/vault",
            Ok(json!({ "files": [{ "path": path }], "recents": [], "truncated": true })),
        )
        .on_get("/search", Err("IPC server returned HTTP 500: boom".into()));
    let text = content_text(&tool_search_vault(
        id(3),
        &json!({ "query": "target topic", "semantic": false }),
        &ipc,
    ));
    let note = text["note"].as_str().unwrap();
    assert!(note.contains("its most recently changed files"), "{text}");
    assert!(!note.contains("200"), "{text}");
    // A folder too large for the app to walk in full: the listed files are the
    // newest of those reached, not necessarily the folder's newest.
    let ipc = MockIpc::new()
        .on_get(
            "/vault",
            Ok(json!({
                "files": [{ "path": path }], "recents": [],
                "truncated": false, "limit": 200, "scanCut": true
            })),
        )
        .on_get("/search", Err("IPC server returned HTTP 500: boom".into()));
    let text = content_text(&tool_search_vault(
        id(4),
        &json!({ "query": "target topic", "semantic": false }),
        &ipc,
    ));
    assert_eq!(text["truncated"], true, "{text}");
    let note = text["note"].as_str().unwrap();
    assert!(
        note.contains("too deeply nested for Ashlr MD to scan in full"),
        "{text}"
    );
    assert!(
        note.contains("the 200 most recently changed of the files it scanned"),
        "{text}"
    );
    // An older app does not say which limit cut the walk: no `depthCut`.
    assert!(text.get("depthCut").is_none(), "{text}");
    // An app that says which: the entry budget alone, or the depth limit.
    for (depth_cut, want) in [
        (false, "too large for Ashlr MD to scan in full"),
        (true, "too deeply nested for Ashlr MD to scan in full"),
    ] {
        let ipc = MockIpc::new()
            .on_get(
                "/vault",
                Ok(json!({
                    "files": [{ "path": path }], "recents": [],
                    "truncated": false, "limit": 200, "scanCut": true,
                    "depthCut": depth_cut
                })),
            )
            .on_get("/search", Err("IPC server returned HTTP 500: boom".into()));
        let text = content_text(&tool_search_vault(
            id(5),
            &json!({ "query": "target topic", "semantic": false }),
            &ipc,
        ));
        assert_eq!(text["truncated"], true, "{text}");
        let note = text["note"].as_str().unwrap();
        assert!(note.contains(want), "{text}");
        assert!(!note.contains("too large or too deeply"), "{text}");
        if depth_cut {
            assert_eq!(text["depthCut"], true, "{text}");
            assert!(note.contains("at most 8 levels down"), "{text}");
        } else {
            assert!(text.get("depthCut").is_none(), "{text}");
        }
    }
    // A complete list says nothing.
    let ipc = MockIpc::new()
        .on_get(
            "/vault",
            Ok(json!({ "files": [{ "path": path }], "recents": [] })),
        )
        .on_get("/search", Err("IPC server returned HTTP 500: boom".into()));
    let text = content_text(&tool_search_vault(
        id(2),
        &json!({ "query": "target topic", "semantic": false }),
        &ipc,
    ));
    assert!(text.get("truncated").is_none(), "{text}");
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

/// A `limit` meant something different in each mode: the app's search
/// returned at most 200 and turned 0 into 1, while the on-disk greps and
/// semantic search returned as many as asked, up to every file in the vault.
///
/// A `limit` above 200 was then clamped in silence, while `list_recent` and
/// `get_conversation_context` refused one; the tool and the resource now
/// refuse it the same way.
#[test]
fn search_vault_limit_is_the_same_in_every_mode() {
    let dir = tempfile::Builder::new().prefix("vault-").tempdir().unwrap();
    for i in 0..205 {
        std::fs::write(dir.path().join(format!("n{i}.md")), "the target topic\n").unwrap();
    }
    let vault = dir.path().to_str().unwrap();
    let down = "Could not connect to IPC server at 127.0.0.1:1: refused";
    let ipc = MockIpc::new()
        .on_get("/vault", Err(down.into()))
        .on_get("/search", Err(down.into()));
    let args = json!({ "query": "target", "semantic": false, "vault": vault, "limit": 200 });
    let v = content_text(&tool_search_vault(id(1), &args, &ipc));
    assert_eq!(v["mode"], "grep-disk", "{v}");
    assert_eq!(v["results"].as_array().unwrap().len(), 200, "grep-disk");
    let embed = |_: &str| Ok(vec![1.0, 0.0]);
    let v = mdopener_mcp::search_vault_in("target", 1000, true, Some(dir.path()), &ipc, &embed)
        .unwrap();
    assert_eq!(v["mode"], "semantic", "{v}");
    assert_eq!(v["results"].as_array().unwrap().len(), 200, "semantic");
    // The app is asked for no more than it returns.
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    tool_search_vault(
        id(2),
        &json!({ "query": "t", "semantic": false, "limit": 200 }),
        &ipc,
    );
    let asked: Vec<String> = ipc.calls().into_iter().map(|c| c.1).collect();
    assert_eq!(asked, ["/search?q=t&limit=200"], "{asked:?}");
    // Above 200 is refused, by the schema check, by the tool called directly
    // and by the resource, before anything is searched.
    let msg = param_error(&call_tool(
        "search_vault",
        json!({ "query": "t", "limit": 201 }),
    ));
    assert_eq!(msg, "`limit` must be at most 200, got 201");
    let ipc = MockIpc::new();
    for bad in [json!(201), json!(1000), json!(0), json!(2.5)] {
        let resp = tool_search_vault(id(4), &json!({ "query": "t", "limit": bad }), &ipc);
        assert_eq!(
            param_error(&resp),
            format!(
                "`limit` must be a whole number from 1 to 200, got {bad}; \
                 omit it for the default of 50"
            )
        );
    }
    let resp = mdopener_mcp::handle_resource_read(id(5), "text://vault-search?q=t&limit=201", &ipc);
    let err = resp.error.as_ref().expect("refused");
    assert_eq!(err.code, -32602);
    assert!(err.message.contains("from 1 to 200"), "{}", err.message);
    assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
    // 0 is refused before the search, by the tool and by the resource.
    let msg = refused_before_the_tool("search_vault", json!({ "query": "t", "limit": 0 }));
    assert!(msg.starts_with("`limit` must be at least 1"), "{msg}");
    let resp = mdopener_mcp::handle_resource_read(
        id(3),
        "text://vault-search?q=t&limit=0",
        &MockIpc::new(),
    );
    assert_eq!(
        resp.error.as_ref().map(|e| e.code),
        Some(-32602),
        "{:?}",
        resp.error
    );
}

/// A vault file the search could not read (not UTF-8, larger than 16 MiB)
/// was dropped in silence, so `search_vault` answered "no hits" for words
/// that were in it. Every on-disk mode (grep-disk, grep-local, semantic) now
/// says how many files were not searched, names the first few and says why.
#[test]
fn search_vault_says_which_vault_files_it_could_not_read() {
    let dir = tempfile::Builder::new().prefix("vault-").tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "the target topic\n").unwrap();
    // Latin-1 "café target": byte 4 is not UTF-8.
    std::fs::write(dir.path().join("latin.md"), b"caf\xe9 target\n").unwrap();
    let big = std::fs::File::create(dir.path().join("big.md")).unwrap();
    big.set_len(mdopener_mcp::MAX_DOCUMENT_BYTES + 1).unwrap();
    for name in ["w1.md", "w2.md", "w3.md"] {
        std::fs::write(dir.path().join(name), [0xFF, 0xFE, b't', 0]).unwrap();
    }
    let vault = dir.path().to_str().unwrap();
    let canon = std::fs::canonicalize(dir.path()).unwrap();
    let latin = canon.join("latin.md").to_string_lossy().into_owned();
    let big = canon.join("big.md").to_string_lossy().into_owned();

    let check = |v: &Value, mode: &str| {
        assert_eq!(v["mode"], mode, "{v}");
        assert_eq!(v["results"].as_array().unwrap().len(), 1, "{v}");
        let note = v["note"].as_str().unwrap();
        assert!(
            note.contains("5 files were not searched because they could not be read: "),
            "{note}"
        );
        assert!(
            note.contains(&format!(
                "{big} (16.0 MiB, more than the 16 MiB a document may be)"
            )),
            "{note}"
        );
        assert!(
            note.contains(&format!(
                "{latin} (not UTF-8 text (byte 4 is not valid UTF-8, on line 1))"
            )),
            "{note}"
        );
        assert!(note.contains("(UTF-16 text, not UTF-8)"), "{note}");
        assert!(note.contains("; and 2 more."), "{note}");
        assert!(
            note.ends_with("Convert a file that is not UTF-8 to UTF-8 to make it searchable."),
            "{note}"
        );
    };

    // grep-disk: the app is down and `vault` is walked.
    let down = "Could not connect to IPC server at 127.0.0.1:1: refused";
    let ipc = MockIpc::new()
        .on_get("/vault", Err(down.into()))
        .on_get("/search", Err(down.into()));
    let args = json!({ "query": "target", "semantic": false, "vault": vault });
    check(
        &content_text(&tool_search_vault(id(1), &args, &ipc)),
        "grep-disk",
    );

    // grep-local: the app lists the files but its own search failed.
    let files: Vec<Value> = mdopener_mcp::disk_vault_scan(dir.path())
        .paths
        .into_iter()
        .map(|p| json!({ "path": p }))
        .collect();
    let ipc = MockIpc::new()
        .on_get("/vault", Ok(json!({ "files": files, "recents": [] })))
        .on_get("/search", Err("IPC server returned HTTP 500: boom".into()));
    let args = json!({ "query": "target", "semantic": false });
    check(
        &content_text(&tool_search_vault(id(2), &args, &ipc)),
        "grep-local",
    );

    // semantic: over the same files.
    let embed = |_: &str| Ok(vec![1.0, 0.0]);
    let v = mdopener_mcp::search_vault_in("target", 5, true, None, &ipc, &embed).unwrap();
    check(&v, "semantic");

    // A single unreadable file that is not a UTF-8 problem gets no advice.
    let one = tempfile::Builder::new().prefix("vault-").tempdir().unwrap();
    std::fs::File::create(one.path().join("big.md"))
        .unwrap()
        .set_len(mdopener_mcp::MAX_DOCUMENT_BYTES + 1)
        .unwrap();
    let ipc = MockIpc::new()
        .on_get("/vault", Err(down.into()))
        .on_get("/search", Err(down.into()));
    let args = json!({ "query": "target", "semantic": false, "vault": one.path() });
    let v = content_text(&tool_search_vault(id(3), &args, &ipc));
    let note = v["note"].as_str().unwrap();
    assert!(
        note.ends_with(" (16.0 MiB, more than the 16 MiB a document may be)."),
        "{note}"
    );
    assert!(
        note.contains("1 file was not searched because it could not be read: "),
        "{note}"
    );
}

/// The app's own search (mode `grep`) dropped a file it could not read in
/// silence too. The app now lists them in `/search` (`unread`, with
/// `unreadCount` for all), and `search_vault` says so in the same words as
/// the on-disk modes. An older app without the fields gives no note.
#[test]
fn search_vault_grep_says_which_files_the_app_could_not_read() {
    let not_utf8 = "it is not UTF-8 text (byte 4 is not valid UTF-8, on line 1). Ashlr MD \
                    reads documents as UTF-8: convert the file to UTF-8, then try again.";
    let reply = json!({
        "query": "target",
        "results": [{ "path": "/v/a.md", "fileName": "a.md", "matches": [] }],
        "note": "The vault list was cut short.",
        "unread": [
            { "path": "/v/latin.md", "reason": not_utf8 },
            { "path": "/v/big.md", "reason": "it is 16.0 MiB, more than the 16 MiB a document may be" },
            { "path": "/v/swap.md", "reason": "it changed after it was checked (a link or another file took its place), so it was not read" },
            { "path": "/v/w1.md", "reason": "it is UTF-16 text, not UTF-8. Ashlr MD reads documents as UTF-8." },
        ],
        "unreadCount": 25,
    });
    let ipc = MockIpc::new().on_get("/search", Ok(reply));
    let args = json!({ "query": "target", "semantic": false });
    let v = content_text(&tool_search_vault(id(1), &args, &ipc));
    assert_eq!(v["mode"], "grep", "{v}");
    assert_eq!(v["results"].as_array().unwrap().len(), 1, "{v}");
    assert!(
        v.get("unread").is_none() && v.get("unreadCount").is_none(),
        "{v}"
    );
    let note = v["note"].as_str().unwrap();
    assert_eq!(
        note,
        "The vault list was cut short. 25 files were not searched because they could not \
         be read: /v/latin.md (not UTF-8 text (byte 4 is not valid UTF-8, on line 1)); \
         /v/big.md (16.0 MiB, more than the 16 MiB a document may be); /v/swap.md \
         (it changed after it was checked (a link or another file took its place), so it \
         was not read); and 22 more. Convert a file that is not UTF-8 to UTF-8 to make it \
         searchable."
    );

    // An app that predates `unread` (or read every file): no note added.
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "query": "target", "results": [] })));
    let v = content_text(&tool_search_vault(id(2), &args, &ipc));
    assert_eq!(v["mode"], "grep", "{v}");
    assert!(v.get("note").is_none(), "{v}");
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

/// A `search_vault` that fell back to the disk after an HTTP 401 quoted the
/// raw "IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token" in
/// its `note`, with no next step; it now gives the cause and the fix of the
/// shared refused-token message. With `vault`, a 401 searches it on disk, as
/// an unreachable app does (the app holds the vault list it would not give).
#[test]
fn search_vault_on_a_refused_token_says_why_and_how_to_fix_it() {
    let auth = mdopener_mcp::parse_http_body(b"HTTP/1.0 401 Unauthorized\r\n\r\n{}").unwrap_err();
    let cause = mdopener_mcp::APP_AUTH_FAILED_MSG
        .split(" Ask the user")
        .next()
        .unwrap();
    let says_the_fix = |note: &str| {
        assert!(note.contains(cause), "{note}");
        assert!(note.contains("quit every Ashlr MD window"), "{note}");
        assert!(note.contains("start the app again"), "{note}");
        assert!(!note.contains("IPC auth failed"), "{note}");
        assert!(!note.contains("could not be reached"), "{note}");
    };

    // The app listed the vault but refused the search.
    let dir = tempfile::Builder::new().prefix("vault-").tempdir().unwrap();
    let doc = dir.path().join("a.md");
    std::fs::write(&doc, "the target topic\n").unwrap();
    let ipc = MockIpc::new()
        .on_get(
            "/vault",
            Ok(json!({ "files": [{ "path": doc.to_str().unwrap() }], "recents": [] })),
        )
        .on_get("/search", Err(auth.clone()));
    let v = content_text(&tool_search_vault(
        id(1),
        &json!({ "query": "target", "semantic": false }),
        &ipc,
    ));
    assert_eq!(v["mode"], "grep-local", "{v}");
    assert_eq!(v["results"].as_array().unwrap().len(), 1, "{v}");
    says_the_fix(v["note"].as_str().unwrap());

    // The app refused everything, and `vault` names a folder on disk.
    let ipc = MockIpc::new()
        .on_get("/", Err(auth.clone()))
        .on_post("/", Err(auth));
    let args = json!({ "query": "target", "semantic": false, "vault": dir.path() });
    let v = content_text(&tool_search_vault(id(2), &args, &ipc));
    assert_eq!(v["mode"], "grep-disk", "{v}");
    assert_eq!(v["results"].as_array().unwrap().len(), 1, "{v}");
    let note = v["note"].as_str().unwrap();
    says_the_fix(note);
    assert!(note.contains("on disk"), "{note}");

    // Without `vault`, the error names it, as for an unreachable app: the
    // bare refused-token message gave no way to search before a restart.
    let args = json!({ "query": "target", "semantic": false });
    let err = tool_error_text(&tool_search_vault(id(3), &args, &ipc));
    assert_eq!(
        err,
        format!(
            "{} To search without the app, pass `vault`: the directory of Markdown files \
             to grep on disk.",
            mdopener_mcp::APP_AUTH_FAILED_MSG
        )
    );
}

/// The on-disk `vault` walk does not enter folders more than 16 levels down.
/// It used to skip them silently, so a search presented the rest as the whole
/// vault; it now says so with `depthCut` (and `truncated`) and a note.
#[test]
fn search_vault_on_disk_says_when_folders_were_too_deep() {
    use mdopener_mcp::DISK_VAULT_MAX_DEPTH;
    let dir = tempfile::Builder::new().prefix("vault-").tempdir().unwrap();
    let mut deepest = dir.path().to_path_buf();
    for level in 1..=DISK_VAULT_MAX_DEPTH {
        deepest = deepest.join(format!("l{level}"));
    }
    std::fs::create_dir_all(&deepest).unwrap();
    std::fs::write(deepest.join("read.md"), "the target topic\n").unwrap();
    let vault = dir.path().to_str().unwrap();
    let args = json!({ "query": "target", "semantic": false, "vault": vault });
    let down = "Could not connect to IPC server at 127.0.0.1:1: refused";
    let ipc = || {
        MockIpc::new()
            .on_get("/vault", Err(down.into()))
            .on_get("/search", Err(down.into()))
    };

    // Level 16 is still read, and nothing was cut.
    let v = content_text(&tool_search_vault(id(1), &args, &ipc()));
    assert_eq!(v["mode"], "grep-disk", "{v}");
    assert_eq!(v["results"].as_array().unwrap().len(), 1, "{v}");
    assert!(v.get("depthCut").is_none(), "{v}");
    assert!(v.get("truncated").is_none(), "{v}");

    // A folder below it is not entered, and the result says so.
    let below = deepest.join("too-deep");
    std::fs::create_dir(&below).unwrap();
    std::fs::write(below.join("missed.md"), "the target topic\n").unwrap();
    let scan = mdopener_mcp::disk_vault_scan(dir.path());
    assert!(scan.depth_cut && !scan.file_cap, "{scan:?}");
    let v = content_text(&tool_search_vault(id(2), &args, &ipc()));
    assert_eq!(
        v["results"].as_array().unwrap().len(),
        1,
        "unchanged limit: {v}"
    );
    assert_eq!(v["depthCut"], true, "{v}");
    assert_eq!(v["truncated"], true, "{v}");
    let note = v["note"].as_str().unwrap();
    assert!(
        note.contains("Folders more than 16 levels below it were not searched"),
        "{note}"
    );
    assert!(!note.contains("Only the first"), "not the file cap: {note}");
    // Semantic search over the same files says so too.
    let embed = |_: &str| Ok(vec![1.0, 0.0]);
    let v =
        mdopener_mcp::search_vault_in("target", 5, true, Some(dir.path()), &ipc(), &embed).unwrap();
    assert_eq!(v["mode"], "semantic", "{v}");
    assert_eq!(v["depthCut"], true, "{v}");
}

/// A `vault` that does not exist was refused with the raw OS text
/// ("No such file or directory (os error 2)") and no next step.
#[test]
fn search_vault_names_a_missing_vault_folder_and_the_next_step() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("nope");
    let err = mdopener_mcp::disk_vault_dir(missing.to_str().unwrap())
        .expect_err("a missing vault is refused");
    assert_eq!(
        err,
        format!(
            "`vault` '{}' does not exist: name an existing folder of Markdown files to \
             search, or start Ashlr MD to search its vault.",
            missing.display()
        )
    );
    assert!(!err.contains("os error"), "{err}");
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
    let mut f = tempfile::Builder::new()
        .prefix("note")
        .suffix(".md")
        .tempfile()
        .unwrap();
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

/// The resources/list entry for text://vault-search named `vault` and
/// `semantic` but not `limit`, which a read takes and the template names.
/// Each parameter a read takes is now named in both, and docs/AGENTS.md says
/// a read needs the app unless `vault` is given.
#[test]
fn vault_search_listing_and_template_name_every_parameter() {
    let listed = handle_resources_list(id(1), &MockIpc::new());
    let entry = listed.result.as_ref().unwrap()["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["uri"] == "text://vault-search")
        .cloned()
        .unwrap();
    let template = mdopener_mcp::resource_templates()[0].clone();
    for (place, text) in [
        ("resources/list", entry["description"].as_str().unwrap()),
        (
            "resources/templates/list",
            template["description"].as_str().unwrap(),
        ),
    ] {
        for param in ["&limit=", "&vault=", "&semantic="] {
            assert!(text.contains(param), "{place} must name {param}: {text}");
        }
        assert!(text.contains("1 to 200, default 50"), "{place}: {text}");
    }
    let docs = include_str!("../../../../docs/AGENTS.md");
    assert!(
        docs.contains("reading it needs the app unless `&vault=` is\ngiven"),
        "docs/AGENTS.md must say a read needs the app without vault"
    );
}

/// The recent-documents `title` was the first line starting with `# `,
/// even one inside YAML front matter or a fenced code block, so a front
/// matter comment or a shell comment named the document. Those lines are
/// now skipped.
#[test]
fn document_title_skips_front_matter_and_fenced_code() {
    use mdopener_mcp::document_title;
    let cases = [
        ("# Plan\n", Some("Plan")),
        (
            "---\n# a yaml comment\ntitle: x\n---\n# Real\n",
            Some("Real"),
        ),
        ("---\n# only front matter\n...\nbody\n", None),
        ("```sh\n# install\n```\n# Real\n", Some("Real")),
        ("~~~\n# not\n~~~\n# Real\n", Some("Real")),
        // A shorter or other-character fence does not close the block.
        ("````\n```\n# not\n````\n# Real\n", Some("Real")),
        ("```\n~~~\n# not\n```\n# Real\n", Some("Real")),
        ("   ```\n# not\n   ```\n# Real\n", Some("Real")),
        // A fence left open runs to the end.
        ("```\n# not\n", None),
        // Four spaces is indented code, not a fence, and `` `a` `` is text.
        ("    ```\n# Real\n", Some("Real")),
        ("``a`` b\n# Real\n", Some("Real")),
        // An unclosed `---` is a thematic break, not front matter.
        ("---\n# Real\n", Some("Real")),
        ("## Two\n#tag\n", None),
    ];
    for (doc, want) in cases {
        assert_eq!(document_title(doc).as_deref(), want, "{doc:?}");
    }
}

/// `mdopener://recent-documents` takes its `title` with [`document_title`]:
/// a front matter comment and a fenced shell comment are not the title.
#[test]
fn recent_documents_title_skips_front_matter_and_fenced_code() {
    use mdopener_mcp::handle_resource_read;
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let fm = root.join("fm.md");
    std::fs::write(&fm, "---\n# generated\ntags: [a]\n---\n# Front Title\n").unwrap();
    let code = root.join("setup-notes.md");
    std::fs::write(&code, "Intro.\n\n```sh\n# install it\n```\n").unwrap();
    let paths = [fm, code].map(|p| p.to_string_lossy().into_owned());
    let ipc = MockIpc::new().on_get("/vault", Ok(json!({ "files": [], "recents": paths })));
    let resp = handle_resource_read(id(1), "mdopener://recent-documents", &ipc);
    let result = resp.result.unwrap();
    let v: Value = serde_json::from_str(result["contents"][0]["text"].as_str().unwrap()).unwrap();
    let titles: Vec<&str> = v["documents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["Front Title", "setup-notes"]);
}

/// The vault-search resources/list entry said `note` reports only an
/// unavailable semantic search or app search, but it also reports documents
/// whose embedding failed, vault files that could not be read, and a search
/// of the `vault` folder on disk. The entry now names each.
#[test]
fn vault_search_entry_names_every_note() {
    let listed = handle_resources_list(id(1), &MockIpc::new());
    let resources = listed.result.unwrap()["resources"].clone();
    let entry = resources
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["uri"] == "text://vault-search")
        .unwrap()
        .clone();
    let d = entry["description"].as_str().unwrap();
    for part in [
        "semantic search was tried but unavailable",
        "documents whose embedding failed (saying how many)",
        "vault files could not be read and so were not searched",
        "the `vault` folder was searched on disk",
        "the app's own search refused or failed",
    ] {
        assert!(d.contains(part), "{part:?} missing: {d}");
    }
    assert!(
        !d.contains("when semantic search or the app's own search was unavailable"),
        "{d}"
    );
}

/// `mdopener://current` and `mdopener://recent-documents` are -32000 with
/// the refused-token message when the app answers HTTP 401, not only when it
/// is not running, but their resources/list entries and docs/AGENTS.md said
/// -32000 meant only that the app is not running. They now say both.
#[test]
fn resource_entries_say_minus_32000_also_means_a_refused_token() {
    use mdopener_mcp::handle_resource_read;
    let denied = MockIpc::new()
        .on_get(
            "/content",
            Err("IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token".into()),
        )
        .on_get(
            "/vault",
            Err("IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token".into()),
        );
    let listed = handle_resources_list(id(1), &MockIpc::new());
    let resources = listed.result.unwrap()["resources"].clone();
    for uri in ["mdopener://current", "mdopener://recent-documents"] {
        let err = handle_resource_read(id(2), uri, &denied).error.unwrap();
        assert_eq!(err.code, -32000, "{uri}");
        assert_eq!(err.message, mdopener_mcp::APP_AUTH_FAILED_MSG, "{uri}");
        let entry = resources
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["uri"] == uri)
            .unwrap();
        let d = entry["description"].as_str().unwrap();
        assert!(
            d.contains(
                "-32000) when the app is not running or refuses this server's token (HTTP 401"
            ) || d.contains(
                "-32000 when the app is not running or refuses this server's token (HTTP 401"
            ),
            "{uri}: {d}"
        );
    }
    let docs = include_str!("../../../../docs/AGENTS.md");
    assert!(
        docs.contains("and also when the app answers HTTP 401 (it refuses this server's token),\n  with the refused-token message"),
        "docs/AGENTS.md must say -32000 also means a refused token"
    );
}

/// When `/vault` failed, resources/list dropped the vault's `file://`
/// entries without a word, so a client read it as a vault with no files.
/// The result is still a valid `ListResourcesResult`, with the reason in
/// `_meta`; a listing that worked has no such key.
#[test]
fn resources_list_says_when_the_vault_files_could_not_be_listed() {
    use mdopener_mcp::VAULT_FILES_UNLISTED_META;
    let down = "Could not connect to IPC server at 127.0.0.1:1: refused";
    let ipc = MockIpc::new().on_get("/vault", Err(down.into()));
    let resp = handle_resources_list(id(303), &ipc);
    assert!(resp.error.is_none(), "{:?}", resp.error);
    let result = resp.result.as_ref().unwrap();
    let resources = result["resources"].as_array().unwrap();
    assert!(resources.iter().all(|r| r["uri"].is_string()), "{result}");
    assert!(
        !resources
            .iter()
            .any(|r| r["uri"].as_str().unwrap().starts_with("file://")),
        "{result}"
    );
    let why = result["_meta"][VAULT_FILES_UNLISTED_META]
        .as_str()
        .unwrap_or_else(|| panic!("no _meta marker: {result}"));
    assert!(why.contains("file:// resources are not listed"), "{why}");
    assert!(why.contains(down), "{why}");
    assert!(why.contains("does not appear to be running"), "{why}");

    // A refusal is quoted as is.
    let refused = "IPC server returned HTTP 403: vault is disabled";
    let ipc = MockIpc::new().on_get("/vault", Err(refused.into()));
    let result = handle_resources_list(id(304), &ipc).result.unwrap();
    let why = result["_meta"][VAULT_FILES_UNLISTED_META].as_str().unwrap();
    assert!(why.contains(refused), "{why}");

    let ipc = MockIpc::new().on_get(
        "/vault",
        Ok(json!({ "files": [{ "path": "/v/a.md", "name": "a.md" }], "recents": [] })),
    );
    let result = handle_resources_list(id(305), &ipc).result.unwrap();
    assert!(result.get("_meta").is_none(), "{result}");
    assert!(result["resources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["uri"] == "file:///v/a.md"));
}

/// The app lists only the newest files of a large watched folder;
/// resources/list said nothing, so its `file://` entries read as the whole
/// vault. It now says so in `_meta`, naming the cap the app sent.
#[test]
fn resources_list_says_when_the_vault_files_are_cut_short() {
    use mdopener_mcp::{VAULT_FILES_TRUNCATED_META, VAULT_FILES_UNLISTED_META};
    let listed = |extra: Value| {
        let mut v = json!({ "files": [{ "path": "/v/a.md", "name": "a.md" }], "recents": [] });
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        let ipc = MockIpc::new().on_get("/vault", Ok(v));
        handle_resources_list(id(306), &ipc).result.unwrap()
    };

    let result = listed(json!({ "truncated": true, "limit": 200 }));
    let why = result["_meta"][VAULT_FILES_TRUNCATED_META]
        .as_str()
        .unwrap_or_else(|| panic!("no _meta marker: {result}"));
    assert!(
        why.contains("more Markdown files than Ashlr MD lists"),
        "{why}"
    );
    assert!(why.contains("only the 200 most recently changed"), "{why}");
    assert!(
        result["_meta"].get(VAULT_FILES_UNLISTED_META).is_none(),
        "{result}"
    );
    assert!(result["resources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["uri"] == "file:///v/a.md"));

    let result = listed(json!({ "truncated": true, "scanCut": true, "depthCut": true }));
    let why = result["_meta"][VAULT_FILES_TRUNCATED_META]
        .as_str()
        .unwrap();
    assert!(why.contains("too deeply nested"), "{why}");
    assert!(
        why.contains("only the most recently changed"),
        "no cap claimed: {why}"
    );

    let result = listed(json!({ "scanCut": true }));
    let why = result["_meta"][VAULT_FILES_TRUNCATED_META]
        .as_str()
        .unwrap();
    assert!(why.contains("too large"), "{why}");

    let result = listed(json!({ "truncated": false, "scanCut": false, "depthCut": false }));
    assert!(result.get("_meta").is_none(), "{result}");
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
    // `1` and `0` were taken as true and false, although the descriptions,
    // docs/AGENTS.md and the error say only `true` or `false`, and the
    // tool's boolean `semantic` refuses a number.
    for v in ["1", "0"] {
        let uri = format!("text://vault-search?q=x&semantic={v}");
        let ipc = mock();
        let resp = handle_resource_read(id(313), &uri, &ipc);
        let err = resp.error.expect("semantic takes only true or false");
        assert_eq!(err.code, -32602);
        assert!(
            err.message.contains("`semantic` must be true or false"),
            "{}",
            err.message
        );
        assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
    }
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

/// `limit` was the one value read without percent-decoding, so `limit=%35`
/// was refused as not a whole number from 1 to 200, got "5".
#[test]
fn resource_read_vault_search_decodes_an_encoded_limit() {
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    let resp = handle_resource_read(
        id(316),
        "text://vault-search?q=x&limit=%35&semantic=false",
        &ipc,
    );
    assert!(resp.error.is_none(), "{:?}", resp.error);
    let calls = ipc.calls();
    assert!(
        calls.iter().any(|(_, path, _)| path.ends_with("&limit=5")),
        "{calls:?}"
    );
    let resp = handle_resource_read(id(317), "text://vault-search?q=x&limit=%32%30%31", &ipc);
    let err = resp.error.expect("201 is past the cap");
    assert_eq!(err.code, -32602);
    assert!(err.message.contains("got \"201\""), "{}", err.message);
}

/// A misspelt query parameter (`lmit=5`) was dropped, so the search ran with
/// the default, and `text://vault-searchx` was read as this resource.
#[test]
fn resource_read_vault_search_refuses_unknown_parameters() {
    let ipc = MockIpc::new().on_get("/search", Ok(json!({ "results": [] })));
    let resp = handle_resource_read(id(316), "text://vault-search?q=x&lmit=5", &ipc);
    let err = resp.error.expect("an unknown parameter is an error");
    assert_eq!(err.code, -32602);
    assert!(
        err.message.contains("unknown query parameter `lmit`"),
        "{}",
        err.message
    );
    assert!(
        err.message.contains("Did you mean `limit`?"),
        "{}",
        err.message
    );
    assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
    let resp = handle_resource_read(id(319), "text://vault-search?q=x&limit", &ipc);
    let err = resp.error.expect("a parameter with no value is an error");
    assert!(
        err.message.contains("`limit` needs a value"),
        "{}",
        err.message
    );
    // An empty part (`&&`, a trailing `&`) is not a parameter.
    let ok = handle_resource_read(id(317), "text://vault-search?q=x&&limit=3&", &ipc);
    assert!(ok.error.is_none(), "{:?}", ok.error);
    // Another URI that merely starts with this one is not this resource.
    let resp = handle_resource_read(id(318), "text://vault-searches?q=x", &MockIpc::new());
    let err = resp.error.expect("an unknown resource is an error");
    assert!(
        err.message.starts_with("Unknown resource URI"),
        "{}",
        err.message
    );
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

/// The role is checked once, by the schema enum in check_tool_arguments,
/// before anything is stored; the tool no longer words its own refusal.
#[test]
fn save_message_invalid_role_returns_param_error() {
    let session = unique_session();
    let msg = refused_before_the_tool(
        "save_conversation_message",
        json!({ "session_id": session, "role": "robot", "content": "Some content" }),
    );
    assert_eq!(
        msg, "`role` must be one of `agent`, `human`, `system`, got a string (\"robot\")",
        "error should list valid roles"
    );
    assert!(
        !session_file_path(&session).unwrap().exists(),
        "nothing is stored for a refused role"
    );
    // store_append_message, called directly, still refuses it.
    let err = store_append_message(&session, "robot", "x", vec![]).unwrap_err();
    assert!(err.contains("`role` must be"), "{err}");
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

#[test]
fn recent_docs_are_newest_first_and_stable() {
    let sess = unique_session();
    // Enough distinct paths that a HashSet order would almost never match.
    for i in 0..12 {
        store_append_message(&sess, "agent", "Read.", vec![format!("/v/{i}.md")]).unwrap();
    }
    // Citing 3.md again makes it the most recent one.
    store_append_message(
        &sess,
        "agent",
        "Again.",
        vec!["/v/3.md".into(), "/v/new.md".into()],
    )
    .unwrap();

    let mut expected = vec!["/v/3.md".to_string(), "/v/new.md".to_string()];
    expected.extend(
        (0..12)
            .rev()
            .filter(|i| *i != 3)
            .map(|i| format!("/v/{i}.md")),
    );
    for _ in 0..3 {
        let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
        assert_eq!(content_text(&resp)["recentDocs"], json!(expected));
    }
}

/// Session files written before `save_conversation_message` refused an empty
/// `cited_docs` path still hold such entries (and the window writes the same
/// file). `recentDocs` leaves empty and blank paths out, so the latest real
/// citation stays first.
#[test]
fn recent_docs_skip_empty_paths_from_old_sessions() {
    let sess = unique_session();
    store_append_message(&sess, "agent", "Read.", vec!["/v/a.md".into()]).unwrap();
    store_append_message(
        &sess,
        "agent",
        "Old build.",
        vec!["".into(), "/v/b.md".into(), "  ".into()],
    )
    .unwrap();
    store_append_message(&sess, "agent", "Old build.", vec!["".into()]).unwrap();
    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    assert_eq!(
        content_text(&resp)["recentDocs"],
        json!(["/v/b.md", "/v/a.md"])
    );
}

/// Each message's own `citedDocs` leaves out the same empty and blank paths:
/// round 27 filtered only `recentDocs`, so the message list still showed them.
#[test]
fn message_cited_docs_skip_empty_paths_from_old_sessions() {
    let sess = unique_session();
    store_append_message(
        &sess,
        "agent",
        "Old build.",
        vec!["".into(), "/v/b.md".into(), "  ".into()],
    )
    .unwrap();
    store_append_message(&sess, "agent", "Old build.", vec!["".into()]).unwrap();
    let resp = tool_get_conversation_context(id(1), &json!({ "session_id": sess }));
    let text = content_text(&resp);
    let msgs = text["messages"].as_array().unwrap();
    assert_eq!(msgs[0]["citedDocs"], json!(["/v/b.md"]));
    assert_eq!(msgs[1]["citedDocs"], json!([]));
}

/// A path cited twice in one message was stored and returned twice. Saving
/// keeps each path once, in the order given; a relative path and its
/// absolute form are the same path.
#[test]
fn duplicate_cited_docs_are_saved_once_in_order() {
    let sess = unique_session();
    let abs = std::env::current_dir()
        .unwrap()
        .join("notes/plan.md")
        .to_string_lossy()
        .into_owned();
    let ok = tool_save_conversation_message(
        json!(1),
        &json!({ "session_id": sess, "role": "agent", "content": "did x",
            "cited_docs": ["/v/b.md", "/v/a.md", "/v/b.md", "notes/plan.md", abs] }),
    );
    assert!(!is_error(&ok), "{ok:?}");
    let saved = load_session_from_disk(&sess).unwrap();
    assert_eq!(saved.messages[0].cited_docs, ["/v/b.md", "/v/a.md", &abs]);
    let ctx = content_text(&tool_get_conversation_context(
        json!(1),
        &json!({ "session_id": sess }),
    ));
    assert_eq!(
        ctx["messages"][0]["citedDocs"],
        json!(["/v/b.md", "/v/a.md", abs])
    );
}

/// A session file an older build wrote with a path twice in one message
/// lists it once in that message's `citedDocs`.
#[test]
fn duplicate_cited_docs_from_old_sessions_are_returned_once() {
    use mdopener_mcp::{ConversationMessage, SessionLog};
    let sess = unique_session();
    let path = session_file_path(&sess).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).ok();
    let old = SessionLog {
        messages: vec![ConversationMessage {
            id: "msg-old".into(),
            session_id: sess.clone(),
            role: "agent".into(),
            content: "Old build.".into(),
            cited_docs: vec!["/v/b.md".into(), "/v/a.md".into(), "/v/b.md".into()],
            timestamp_ms: 1_700_000_000_000,
        }],
    };
    std::fs::write(&path, serde_json::to_string(&old).unwrap()).unwrap();
    let ctx = content_text(&tool_get_conversation_context(
        json!(1),
        &json!({ "session_id": sess }),
    ));
    assert_eq!(
        ctx["messages"][0]["citedDocs"],
        json!(["/v/b.md", "/v/a.md"])
    );
    assert_eq!(ctx["recentDocs"], json!(["/v/b.md", "/v/a.md"]));
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

/// `char_count` said only "character counts", leaving an agent to guess
/// bytes or characters. The description says Unicode characters, and the
/// count of a non-ASCII document is its chars, not its bytes.
#[test]
fn export_text_char_count_is_unicode_characters_not_bytes() {
    let d = tool_registry()
        .into_iter()
        .find(|d| d.name == "export_text")
        .unwrap()
        .description;
    assert!(d.contains("in Unicode characters"), "{d}");
    assert!(d.contains("not bytes"), "{d}");
    let result = run_export_text_on("Caf\u{e9} \u{1F600}\n");
    let text = result["text"].as_str().unwrap();
    assert!(text.len() > text.chars().count(), "{text:?}");
    assert_eq!(
        result["char_count"].as_u64().unwrap() as usize,
        text.chars().count(),
        "{result}"
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

/// With the app closed and no `path`, the error said only to launch the
/// app, although both tools read a file on disk without it. It now names
/// `path`; an app that answers with an error is left as it was.
#[test]
fn export_text_and_metadata_without_the_app_say_to_pass_path() {
    for err in [
        "~/.mdopener/ipc-port not found",
        "Could not connect to IPC server at 127.0.0.1:9: refused",
    ] {
        let ipc = MockIpc::new().on_get("/content", Err(err.into()));
        for resp in [
            tool_export_text(json!(1), &json!({}), &ipc),
            tool_export_metadata(json!(2), &json!({}), &ipc),
        ] {
            let text = tool_error_text(&resp);
            assert!(text.contains("does not appear to be running"), "{text}");
            assert!(text.ends_with(mdopener_mcp::NO_APP_PASS_PATH), "{text}");
        }
    }
    let ipc = MockIpc::new().on_get("/content", Err("IPC server returned HTTP 500: boom".into()));
    let text = tool_error_text(&tool_export_text(json!(1), &json!({}), &ipc));
    assert!(!text.contains("pass `path`"), "{text}");
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

/// A missing file given by a relative path was reported as "Cannot read
/// 'nope.md': No such file or directory (os error 2)": the raw OS text and the
/// relative spelling, which did not say where the server looked. It is now
/// the absolute path and "the file does not exist", as `open_file` says.
#[test]
fn reading_a_missing_relative_path_names_the_absolute_path_and_says_it_does_not_exist() {
    let name = format!("ashlr-md-missing-{}.md", std::process::id());
    let abs = std::env::current_dir().unwrap().join(&name);
    assert!(!abs.exists());
    let abs = abs.to_string_lossy().into_owned();
    let ipc = MockIpc::new();
    let args = json!({ "path": name });
    let other = std::env::temp_dir().join(format!("ashlr-md-present-{}.md", std::process::id()));
    std::fs::write(&other, "# x\n").unwrap();
    let errors = [
        tool_error_text(&tool_export_text(json!(1), &args, &ipc)),
        tool_error_text(&tool_export_metadata(json!(2), &args, &ipc)),
        tool_error_text(&call(
            "diff_documents",
            json!({ "path_a": name, "path_b": other.to_string_lossy() }),
            &ipc,
        )),
    ];
    std::fs::remove_file(&other).unwrap();
    for err in errors {
        assert!(
            err.contains(&format!("'{abs}': the file does not exist.")),
            "{err}"
        );
        assert!(!err.contains("os error"), "{err}");
    }
}

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

// ── text://vault-search: the documented fields are the real ones ─────────────

/// The field names of a documented shape such as `{ a, b?, c? }`, each with
/// whether it is optional.
fn documented_fields(shape: &str) -> Vec<(String, bool)> {
    shape
        .trim_matches(|c| c == '{' || c == '}' || c == ' ')
        .split(',')
        .map(|f| {
            let f = f.trim();
            match f.strip_suffix('?') {
                Some(name) => (name.to_string(), true),
                None => (f.to_string(), false),
            }
        })
        .collect()
}

fn vault_search_payload(uri: &str, ipc: &MockIpc) -> Value {
    let resp = handle_resource_read(id(1), uri, ipc);
    assert!(resp.error.is_none(), "{uri}: {:?}", resp.error);
    let text = resp.result.unwrap()["contents"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    serde_json::from_str(&text).unwrap()
}

/// The `text://vault-search` descriptions used to say `{ results, mode,
/// query, note? }` while a read also returned `vault`, `truncated` and
/// `depthCut`. Every documented place now states the same field list, and
/// reads that exercise each optional field return only documented fields.
#[test]
fn vault_search_resource_documents_every_field_it_returns() {
    use mdopener_mcp::{resource_templates, DISK_VAULT_MAX_DEPTH, VAULT_SEARCH_RESOURCE_FIELDS};
    let shape = VAULT_SEARCH_RESOURCE_FIELDS;
    let listed = handle_resources_list(id(1), &MockIpc::new());
    let entry = listed.result.as_ref().unwrap()["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["uri"] == "text://vault-search")
        .cloned()
        .unwrap();
    let template = &resource_templates()[0];
    for (place, text) in [
        ("resources/list", entry["description"].as_str().unwrap()),
        (
            "resources/templates/list",
            template["description"].as_str().unwrap(),
        ),
        ("docs/AGENTS.md", include_str!("../../../../docs/AGENTS.md")),
    ] {
        assert!(text.contains(shape), "{place} must state {shape}");
    }
    let fields = documented_fields(shape);

    // The app answers, with a vault list cut short by depth.
    let app = MockIpc::new().on_get(
        "/search",
        Ok(json!({
            "query": "x",
            "results": [],
            "truncated": true,
            "depthCut": true,
            "note": "Some files were not searched."
        })),
    );
    let from_app = vault_search_payload("text://vault-search?q=x&semantic=false", &app);

    // The app is down: an on-disk vault with a folder too deep to enter.
    let dir = tempfile::Builder::new().prefix("vault-").tempdir().unwrap();
    let mut deep = dir.path().to_path_buf();
    for level in 0..=DISK_VAULT_MAX_DEPTH {
        deep = deep.join(format!("l{level}"));
    }
    std::fs::create_dir_all(&deep).unwrap();
    std::fs::write(dir.path().join("a.md"), "x marks it\n").unwrap();
    std::fs::write(deep.join("b.md"), "x marks it\n").unwrap();
    let down = "Could not connect to IPC server at 127.0.0.1:1: refused";
    let gone = MockIpc::new()
        .on_get("/vault", Err(down.into()))
        .on_get("/search", Err(down.into()));
    let vault = urlencoding::encode(dir.path().to_str().unwrap()).into_owned();
    let from_disk = vault_search_payload(
        &format!("text://vault-search?q=x&semantic=false&vault={vault}"),
        &gone,
    );

    let mut seen = std::collections::HashSet::new();
    for payload in [&from_app, &from_disk] {
        let obj = payload.as_object().unwrap();
        for key in obj.keys() {
            assert!(
                fields.iter().any(|(name, _)| name == key),
                "`{key}` is returned but not documented in {shape}: {payload}"
            );
            seen.insert(key.clone());
        }
        for (name, optional) in &fields {
            assert!(
                *optional || obj.contains_key(name),
                "`{name}` missing: {payload}"
            );
        }
    }
    for (name, _) in &fields {
        assert!(
            seen.contains(name),
            "`{name}` is documented but never returned"
        );
    }
}

/// The `search_vault` description said `{ results, mode, note?, ... }` while
/// a reply the app answered (mode `grep`) also carried the app's `query`. The
/// description and docs/AGENTS.md now state the same field list, and replies
/// in every mode return only documented fields.
#[test]
fn search_vault_tool_documents_every_field_it_returns() {
    use mdopener_mcp::{DISK_VAULT_MAX_DEPTH, SEARCH_VAULT_TOOL_FIELDS};
    let shape = SEARCH_VAULT_TOOL_FIELDS;
    let def = tool_registry()
        .into_iter()
        .find(|t| t.name == "search_vault")
        .unwrap();
    for (place, text) in [
        ("tools/list", def.description),
        ("docs/AGENTS.md", include_str!("../../../../docs/AGENTS.md")),
    ] {
        assert!(text.contains(shape), "{place} must state {shape}");
    }
    let fields = documented_fields(shape);

    // Mode `grep`: the app answers, with a vault list cut short by depth.
    let app = MockIpc::new().on_get(
        "/search",
        Ok(json!({
            "query": "x",
            "results": [],
            "truncated": true,
            "depthCut": true,
            "note": "Some files were not searched."
        })),
    );
    let grep = content_text(&tool_search_vault(
        id(1),
        &json!({ "query": "x", "semantic": false }),
        &app,
    ));
    assert_eq!(grep["mode"], "grep", "{grep}");

    // Mode `grep-disk`: the app is down; an on-disk vault too deep to walk.
    let dir = tempfile::Builder::new().prefix("vault-").tempdir().unwrap();
    let mut deep = dir.path().to_path_buf();
    for level in 0..=DISK_VAULT_MAX_DEPTH {
        deep = deep.join(format!("l{level}"));
    }
    std::fs::create_dir_all(&deep).unwrap();
    let doc = dir.path().join("a.md");
    std::fs::write(&doc, "x marks it\n").unwrap();
    std::fs::write(deep.join("b.md"), "x marks it\n").unwrap();
    let down = "Could not connect to IPC server at 127.0.0.1:1: refused";
    let gone = MockIpc::new()
        .on_get("/vault", Err(down.into()))
        .on_get("/search", Err(down.into()));
    let vault = dir.path().to_str().unwrap();
    let disk = content_text(&tool_search_vault(
        id(2),
        &json!({ "query": "x", "semantic": false, "vault": vault }),
        &gone,
    ));
    assert_eq!(disk["mode"], "grep-disk", "{disk}");

    // Mode `grep-local`: the app lists the vault but its search fails.
    let listed = json!({ "files": [{ "path": doc }], "recents": [], "truncated": true });
    let local_ipc = MockIpc::new()
        .on_get("/vault", Ok(listed.clone()))
        .on_get("/search", Err("IPC server returned HTTP 500: boom".into()));
    let local = content_text(&tool_search_vault(
        id(3),
        &json!({ "query": "x", "semantic": false }),
        &local_ipc,
    ));
    assert_eq!(local["mode"], "grep-local", "{local}");

    // Mode `semantic`, through the search the tool runs, embedder injected.
    let embed = |_: &str| Ok(vec![1.0, 0.0]);
    let sem_ipc = MockIpc::new().on_get("/vault", Ok(listed));
    let semantic = mdopener_mcp::search_vault_in("x", 5, true, None, &sem_ipc, &embed).unwrap();
    assert_eq!(semantic["mode"], "semantic", "{semantic}");

    let mut seen = std::collections::HashSet::new();
    for payload in [&grep, &disk, &local, &semantic] {
        let obj = payload.as_object().unwrap();
        for key in obj.keys() {
            assert!(
                fields.iter().any(|(name, _)| name == key),
                "`{key}` is returned but not documented in {shape}: {payload}"
            );
            seen.insert(key.clone());
        }
        for (name, optional) in &fields {
            assert!(
                *optional || obj.contains_key(name),
                "`{name}` missing: {payload}"
            );
        }
    }
    for (name, _) in &fields {
        assert!(
            seen.contains(name),
            "`{name}` is documented but never returned"
        );
    }
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
            // The read tools keep their own words.
            let err = tool_error_text(&resp);
            assert!(
                err.starts_with("Refusing to read `path` '"),
                "{tool}: {err}"
            );
            assert!(err.ends_with("can be read."), "{tool}: {err}");
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

/// `edit_canvas` with `ops: []` checked the list only after it had read the
/// canvas, so a missing file answered "Failed to read" instead of naming the
/// empty list, and the schema let an empty list through. The schema now
/// declares `minItems: 1`, the argument check refuses it, and the tool
/// refuses it before the file is read; the file is never written.
#[test]
fn edit_canvas_refuses_empty_ops_before_reading_or_writing() {
    let def = tool_registry()
        .into_iter()
        .find(|t| t.name == "edit_canvas")
        .unwrap();
    assert_eq!(def.input_schema["properties"]["ops"]["minItems"], 1);
    let dir = tempfile::tempdir().unwrap();
    let board = dir.path().join("board.canvas");
    let original = "{ \"nodes\": [], \"edges\": [] }";
    std::fs::write(&board, original).unwrap();
    let before = std::fs::metadata(&board).unwrap().modified().unwrap();
    let args = json!({ "path": board.to_string_lossy(), "ops": [], "save": true });
    assert_eq!(
        param_error(&call_tool("edit_canvas", args.clone())),
        "`ops` must not be empty"
    );
    assert_eq!(
        param_error(&mdopener_mcp::tool_edit_canvas(id(1), &args)),
        "`ops` must not be empty"
    );
    assert_eq!(std::fs::read_to_string(&board).unwrap(), original);
    assert_eq!(
        std::fs::metadata(&board).unwrap().modified().unwrap(),
        before
    );
    // A missing canvas with no ops is the argument error, not a read error.
    let missing = dir.path().join("missing.canvas");
    let resp = mdopener_mcp::tool_edit_canvas(
        id(2),
        &json!({ "path": missing.to_string_lossy(), "ops": [] }),
    );
    assert_eq!(param_error(&resp), "`ops` must not be empty");
}

/// A missing canvas answered "Failed to read missing.canvas: No such file or
/// directory (os error 2)", with the relative path as given and no next
/// step. It now names the absolute path and says the canvas must exist.
#[test]
fn edit_canvas_on_a_missing_file_names_it_and_the_next_step() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.canvas");
    let resp = mdopener_mcp::tool_edit_canvas(
        id(1),
        &json!({
            "path": missing.to_string_lossy(),
            "ops": [{ "type": "delete_node", "id": "n1" }]
        }),
    );
    let err = tool_error_text(&resp);
    assert_eq!(
        err,
        format!(
            "Cannot read '{}': the file does not exist. edit_canvas edits an existing \
             .canvas file and does not create one: pass the path of a canvas that exists.",
            missing.display()
        )
    );
    assert!(!missing.exists());
}

/// `edit_canvas` took only an exact lowercase `.canvas`, so `Board.CANVAS`
/// was refused while Markdown extensions match in any case, and the refusal
/// did not say which path it judged. Any case is a canvas now, and the
/// `-32602` names the path.
#[test]
fn edit_canvas_takes_canvas_in_any_case_and_names_a_refused_path() {
    let dir = tempfile::tempdir().unwrap();
    let board = dir.path().join("Board.CANVAS");
    std::fs::write(&board, "{\"nodes\":[{\"id\":\"a\",\"type\":\"text\",\"text\":\"x\",\"x\":0,\"y\":0,\"width\":10,\"height\":10}],\"edges\":[]}").unwrap();
    let resp = call(
        "edit_canvas",
        json!({
            "path": board.to_string_lossy(),
            "ops": [{ "type": "move_node", "id": "a", "x": 5, "y": 6 }],
        }),
        &MockIpc::new(),
    );
    let v = content_text(&resp);
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["saved"], true, "{v}");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&board).unwrap()).unwrap();
    assert_eq!(saved["nodes"][0]["x"], 5, "{saved}");

    let notes = dir.path().join("notes.md");
    let resp = call(
        "edit_canvas",
        json!({ "path": notes.to_string_lossy(), "ops": [{ "type": "delete_node", "id": "a" }] }),
        &MockIpc::new(),
    );
    let err = resp.error.expect("a .md path was taken as a canvas");
    assert_eq!(err.code, -32602);
    assert_eq!(
        err.message,
        format!(
            "`path` must point to a .canvas file, got `{}`",
            notes.display()
        )
    );
}

/// The `vault` walk skips directory symlinks but follows a file symlink: a
/// Markdown link is searched under the path it resolves to, even outside
/// the vault, as long as that is a Markdown file that is not a dotfile.
#[cfg(unix)]
#[test]
fn the_disk_vault_walk_follows_file_symlinks_but_not_directory_symlinks() {
    let outside = tempfile::Builder::new().prefix("out-").tempdir().unwrap();
    std::fs::write(outside.path().join("plan.md"), "x").unwrap();
    std::fs::write(outside.path().join(".env.md"), "x").unwrap();
    std::fs::create_dir(outside.path().join("sub")).unwrap();
    std::fs::write(outside.path().join("sub").join("deep.md"), "x").unwrap();
    let vault = tempfile::Builder::new().prefix("vault-").tempdir().unwrap();
    let link = |to: &str, name: &str| {
        std::os::unix::fs::symlink(outside.path().join(to), vault.path().join(name)).unwrap()
    };
    link("plan.md", "linked.md");
    link(".env.md", "secret.md");
    link("sub", "folder");
    let scan = mdopener_mcp::disk_vault_scan(vault.path());
    let plan = std::fs::canonicalize(outside.path().join("plan.md")).unwrap();
    assert_eq!(scan.paths, vec![plan.to_string_lossy().into_owned()]);
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
        json!({ "path": link.to_string_lossy(), "ops": [{ "type": "delete_node", "id": "n" }] }),
        &MockIpc::new(),
    );
    let text = tool_error_text(&resp);
    assert!(text.contains(".canvas"), "{text}");
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "{\"nodes\":[],\"edges\":[]}"
    );
}

/// `edit_canvas` saved with `std::fs::write`, which follows a symlink: a
/// `.canvas` swapped for a link to `~/.bashrc` after it was checked and read
/// had the canvas JSON written into `~/.bashrc`. The save replaces the file
/// instead (shown here with the link already in place, as after the swap),
/// keeping its permissions, and a real save still works.
#[cfg(unix)]
#[test]
fn canvas_saves_replace_the_file_and_never_write_through_a_link() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("bashrc");
    std::fs::write(&outside, "keep me").unwrap();
    let swapped = dir.path().join("board.canvas");
    std::os::unix::fs::symlink(&outside, &swapped).unwrap();
    mdopener_mcp::replace_file(&swapped, b"{}").unwrap();
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep me");
    assert!(!std::fs::symlink_metadata(&swapped)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_to_string(&swapped).unwrap(), "{}");

    let board = dir.path().join("plan.canvas");
    std::fs::write(&board, "{\"nodes\":[{\"id\":\"a\",\"type\":\"text\",\"text\":\"x\",\"x\":0,\"y\":0,\"width\":10,\"height\":10}],\"edges\":[]}").unwrap();
    std::fs::set_permissions(&board, std::fs::Permissions::from_mode(0o600)).unwrap();
    let resp = call(
        "edit_canvas",
        json!({
            "path": board.to_string_lossy(),
            "ops": [{ "type": "move_node", "id": "a", "x": 5, "y": 6 }],
        }),
        &MockIpc::new(),
    );
    assert!(!is_error(&resp), "{resp:?}");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&board).unwrap()).unwrap();
    assert_eq!(saved["nodes"][0]["x"], json!(5));
    let mode = std::fs::metadata(&board).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "{mode:o}");
    let left: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(left.is_empty(), "{left:?}");
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

/// `stream_edit` read a `preview_lines` above 20 as 20 in silence, and its
/// schema declared no maximum. The schema now declares 20 and the tool
/// refuses a larger value before the app is asked, like the other limits.
#[test]
fn stream_edit_refuses_preview_lines_above_20() {
    let def = tool_registry()
        .into_iter()
        .find(|t| t.name == "stream_edit")
        .unwrap();
    assert_eq!(
        def.input_schema["properties"]["preview_lines"]["maximum"],
        20
    );
    let msg = param_error(&call_tool(
        "stream_edit",
        json!({ "find": "a", "replace": "b", "preview_lines": 21 }),
    ));
    assert_eq!(msg, "`preview_lines` must be at most 20, got 21");
    let ipc = MockIpc::new().on_post("/stream-edit", Ok(json!({ "ok": true })));
    for bad in [json!(21), json!(u64::MAX), json!(2.5)] {
        let resp = tool_stream_edit(
            id(1),
            &json!({ "find": "a", "replace": "b", "preview_lines": bad }),
            &ipc,
        );
        assert_eq!(
            param_error(&resp),
            format!(
                "`preview_lines` must be a whole number from 0 to 20, got {bad}; \
                 omit it for the default of 5"
            )
        );
    }
    assert!(ipc.calls().is_empty(), "the app was asked");
    // 20 itself still passes, and an omitted one is the default of 5.
    for (args, want) in [
        (
            json!({ "find": "a", "replace": "b", "preview_lines": 20 }),
            20,
        ),
        (json!({ "find": "a", "replace": "b" }), 5),
    ] {
        let ipc = MockIpc::new().on_post("/stream-edit", Ok(json!({ "ok": true })));
        assert!(!is_error(&tool_stream_edit(id(1), &args, &ipc)));
        let body = ipc.calls()[0].2.clone().unwrap();
        assert_eq!(body["previewLines"], want);
    }
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

/// An empty `edit_id` names no preview: it is refused with -32602, through
/// tools/call (the schema's minLength) and when the handler is called
/// directly, and the app is not asked to apply anything.
#[test]
fn stream_edit_apply_refuses_an_empty_edit_id() {
    let ipc = MockIpc::new().on_post("/stream-edit-apply", Ok(json!({ "ok": true })));
    let args = json!({ "edit_id": "", "find": "a", "replace": "b" });
    let msg = param_error(&call("stream_edit_apply", args.clone(), &ipc));
    assert!(msg.contains("`edit_id`"), "{msg}");
    let msg = param_error(&tool_stream_edit_apply(id(1), &args, &ipc));
    assert_eq!(msg, "`edit_id` must not be empty");
    assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
    let schema = tool_registry()
        .into_iter()
        .find(|t| t.name == "stream_edit_apply")
        .unwrap()
        .to_json()["inputSchema"]["properties"]["edit_id"]["minLength"]
        .clone();
    assert_eq!(schema, json!(1));
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

/// The stream-edit tools fetched the app's `/content`, the whole document,
/// only to compare its path with `path`. They now ask `/content/path`, which
/// answers the path alone, so a large document's content is not fetched. An
/// app from before that route (HTTP 404) is still asked `/content`.
#[cfg(unix)]
#[test]
fn stream_edit_path_check_does_not_fetch_the_documents_content() {
    use mdopener_mcp::stream_edit_path;
    let dir = tempfile::tempdir().unwrap();
    let doc = std::fs::canonicalize(dir.path()).unwrap().join("plan.md");
    std::fs::write(&doc, "# Plan\n").unwrap();
    let doc = doc.to_string_lossy().into_owned();
    let large = "x".repeat(8 * 1024 * 1024);
    let ipc = MockIpc::new()
        .on_get("/content/path", Ok(json!({ "path": doc })))
        .on_get("/content", Ok(json!({ "path": doc, "content": large })))
        .on_post("/stream-edit", Ok(json!({ "ok": true })));
    tool_stream_edit(
        id(1),
        &json!({ "find": "a", "replace": "b", "path": doc }),
        &ipc,
    );
    tool_stream_edit_apply(
        id(2),
        &json!({ "edit_id": "e", "find": "a", "replace": "b", "path": doc }),
        &ipc,
    );
    let calls = ipc.calls();
    let gets: Vec<&str> = calls
        .iter()
        .filter(|(m, _, _)| m == "GET")
        .map(|(_, p, _)| p.as_str())
        .collect();
    assert_eq!(gets, ["/content/path", "/content/path"], "{gets:?}");
    for (_, p, body) in calls.iter().filter(|(m, _, _)| m == "POST") {
        assert_eq!(body.as_ref().unwrap()["path"], json!(doc), "{p}");
    }

    // An older app answers 404 for the route: `/content` gives the path.
    let opened_as = format!("{}/./plan.md", doc.rsplit_once('/').unwrap().0);
    let older = MockIpc::new()
        .on_get(
            "/content/path",
            Err("IPC server returned HTTP 404: No such endpoint: GET /content/path".into()),
        )
        .on_get("/content", Ok(json!({ "path": opened_as, "content": "" })));
    assert_eq!(stream_edit_path(&doc, &older), opened_as);
    // With the app closed the path is sent resolved, as before.
    assert_eq!(stream_edit_path(&doc, &MockIpc::new()), doc);
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

/// export_metadata's headings took a front matter `# comment` as a heading,
/// and any line starting with ``` or ~~~ flipped "in code", so a `~~~` line
/// or a shorter fence ended a block early and its `# comment` lines became
/// headings. Headings now use document_title's rule: front matter is
/// skipped, a fence closes only on the same character at least as long, and
/// an open fence runs to the end.
#[test]
fn export_metadata_headings_skip_front_matter_and_use_the_fence_rule() {
    use mdopener_mcp::extract_headings;
    let texts = |doc: &str| -> Vec<String> {
        extract_headings(doc)
            .iter()
            .map(|h| h["text"].as_str().unwrap().to_string())
            .collect()
    };
    let cases: [(&str, &[&str]); 8] = [
        ("---\n# generated\ntitle: x\n---\n# Real\n", &["Real"]),
        ("---\n# generated\n...\n## Real\n", &["Real"]),
        // An unclosed `---` is a thematic break, not front matter.
        ("---\n# Real\n", &["Real"]),
        ("```sh\n~~~\n# not\n```\n# Real\n", &["Real"]),
        ("````\n```\n# not\n````\n# Real\n", &["Real"]),
        ("~~~~\n~~~\n# not\n~~~~\n# Real\n", &["Real"]),
        // A fence left open runs to the end.
        ("# Real\n```\n# not\n", &["Real"]),
        // A closing fence has nothing after it.
        ("```\n``` sh\n# not\n```\n# Real\n", &["Real"]),
    ];
    for (doc, want) in cases {
        assert_eq!(texts(doc), want, "{doc:?}");
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plan.md");
    std::fs::write(
        &path,
        "---\n# generated\n---\n# Plan\n```\n~~~\n# step\n```\n",
    )
    .unwrap();
    let resp = tool_export_metadata(
        id(1),
        &json!({ "path": path.to_string_lossy() }),
        &MockIpc::new(),
    );
    let text = resp.result.unwrap()["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["headings"], json!([{ "level": 1, "text": "Plan" }]));
    let tools = mdopener_mcp::tool_list();
    let tool = tools
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "export_metadata")
        .unwrap();
    let d = tool["description"].as_str().unwrap();
    assert!(
        d.contains("every ATX heading outside front matter and fenced code"),
        "{d}"
    );
    let docs = include_str!("../../../../docs/AGENTS.md");
    assert!(docs.contains(
        "for every ATX heading outside a leading YAML front matter block and fenced code"
    ));
}

/// extract_wikilinks flipped "in code" on any line starting with ``` or
/// ~~~, so a `~~~` line inside a backtick block made the code after it
/// links and the text after the block not, and a ``` line in a front matter
/// block scalar hid the whole body. It now uses the shared fence rule, and
/// reads front matter as links (Obsidian properties) without fences.
#[test]
fn export_metadata_wikilinks_use_the_fence_rule_and_keep_front_matter() {
    use mdopener_mcp::extract_wikilinks;
    let cases: [(&str, &[&str]); 7] = [
        ("```\n~~~\n[[InCode]]\n```\n[[Real]]\n", &["Real"]),
        ("````\n```\n[[InCode]]\n````\n[[Real]]\n", &["Real"]),
        ("```\n``` sh\n[[InCode]]\n```\n[[Real]]\n", &["Real"]),
        ("[[Real]]\n~~~\n[[InCode]]\n", &["Real"]),
        (
            "---\nrelated: \"[[Plan]]\"\n---\n[[Body]]\n",
            &["Body", "Plan"],
        ),
        ("---\nnote: |\n  ```\n---\n[[Body]]\n", &["Body"]),
        ("    ```\n[[Real]]\n", &["Real"]),
    ];
    for (doc, want) in cases {
        assert_eq!(extract_wikilinks(doc), want, "{doc:?}");
    }
    let tools = mdopener_mcp::tool_list();
    let tool = tools
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "export_metadata")
        .unwrap();
    let d = tool["description"].as_str().unwrap();
    assert!(
        d.contains("all [[wikilinks]] outside fenced code (front matter properties included)"),
        "{d}"
    );
    let docs = include_str!("../../../../docs/AGENTS.md");
    assert!(docs.contains("targets sorted, outside fenced code by the same fence rule"));
}

/// The other line scanners of the server flipped "in code" on any line
/// starting with ``` or ~~~ too: export_text, export_metadata's image count
/// and get_user_annotations' tasks. They now use the shared fence rule; the
/// image count and the tasks skip front matter as well.
#[test]
fn export_text_images_and_tasks_use_the_fence_rule() {
    use mdopener_mcp::{count_embedded_images, strip_markdown};
    // A `~~~` line does not end a backtick block: the code keeps its marks.
    assert_eq!(
        strip_markdown("```\n~~~\n# keep **this**\n```\nafter **b**\n"),
        "~~~\n# keep **this**\nafter b"
    );
    // Four spaces is not a fence.
    assert_eq!(strip_markdown("    ```\n**b**\n"), "```\nb");
    let images = [
        ("````\n```\n![a](x.png)\n````\n![b](y.png)\n![[c.png]]\n", 2),
        ("---\ncover: \"![](c.png)\"\n---\n![b](y.png)\n", 1),
        ("![b](y.png)\n~~~\n![a](x.png)\n", 1),
    ];
    for (doc, want) in images {
        assert_eq!(count_embedded_images(doc), want, "{doc:?}");
    }
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("plan.md");
    std::fs::write(
        &file,
        "---\nchecklist: |\n  - [ ] yaml\n---\n```md\n~~~\n- [ ] sample\n```\n- [x] real\n",
    )
    .unwrap();
    let ipc = MockIpc::new().on_get("/annotations", Err("ipc-port not found".into()));
    let resp = tool_get_annotations(id(1), &json!({ "path": file.to_str().unwrap() }), &ipc);
    let v = content_text(&resp);
    assert_eq!(
        v["tasks"],
        json!([{ "text": "real", "checked": true }]),
        "{v}"
    );
    let docs = include_str!("../../../../docs/AGENTS.md");
    for said in [
        "(a `- [ ]` line in fenced code or front matter is not a task;",
        "(code blocks kept as written, by the fence rule of `export_metadata`;",
        "images outside fenced code and front matter",
    ] {
        assert!(docs.contains(said), "docs/AGENTS.md must say {said}");
    }
}

/// `extract_headings` trimmed the whole line, so a `# comment` indented four
/// spaces (indented code) was a heading, while `document_title` took only
/// `# ` at column 0, so `  # Title` and `#\tTitle` were not titles. Both
/// now read a heading by one CommonMark rule: at most three spaces, 1 to 6
/// `#`s, then a space, a tab or the end of the line, closing `#`s dropped.
#[test]
fn title_and_headings_share_the_atx_heading_rule() {
    use mdopener_mcp::{document_title, extract_headings};
    let headings = |doc: &str| -> Vec<(u64, String)> {
        extract_headings(doc)
            .iter()
            .map(|h| {
                let text = h["text"].as_str().unwrap().to_string();
                (h["level"].as_u64().unwrap(), text)
            })
            .collect()
    };
    // A document, its headings as (level, text), and its title.
    type Case<'a> = (&'a str, &'a [(u64, &'a str)], Option<&'a str>);
    let cases: [Case; 11] = [
        ("    # not\n# Real\n", &[(1, "Real")], Some("Real")),
        ("\t# not\n# Real\n", &[(1, "Real")], Some("Real")),
        ("   # Three\n", &[(1, "Three")], Some("Three")),
        ("  # Title\n", &[(1, "Title")], Some("Title")),
        ("#\tTitle\n", &[(1, "Title")], Some("Title")),
        ("# Title #\n", &[(1, "Title")], Some("Title")),
        ("# Learn C#\n", &[(1, "Learn C#")], Some("Learn C#")),
        // An empty heading is not listed and is not a title.
        ("#\n# Real\n", &[(1, "Real")], Some("Real")),
        ("# ##\n## Two\n", &[(2, "Two")], None),
        ("####### seven\n#tag\n", &[], None),
        (
            "## Two\n   ### Three ###\n",
            &[(2, "Two"), (3, "Three")],
            None,
        ),
    ];
    for (doc, want, title) in cases {
        let want: Vec<(u64, String)> = want.iter().map(|&(l, t)| (l, t.to_string())).collect();
        assert_eq!(headings(doc), want, "{doc:?}");
        assert_eq!(document_title(doc).as_deref(), title, "{doc:?}");
    }
    let docs = include_str!("../../../../docs/AGENTS.md");
    assert!(docs.contains("so `  # Title` and `#<tab>Title` were not titles"));
    assert!(docs.contains("so a `# comment` indented four spaces is indented code"));
}

/// `strip_markdown` trimmed a line before it took its `#`s off, so a
/// `# comment` indented four spaces lost its `#` and the rest of the
/// indented code was read as Markdown. A heading now follows the ATX rule
/// of the headings, and indented code that opens after a blank line or a
/// heading is kept as code without its indent. After a list item an
/// indented line is the item's continuation and is still read as text.
#[test]
fn export_text_keeps_indented_code_and_reads_headings_by_the_atx_rule() {
    let cases = [
        // Indented code after a blank line or a heading is code.
        (
            "Run this:\n\n    # install\n    make **all**\n\nDone",
            "Run this:\n\n# install\nmake **all**\n\nDone",
        ),
        ("# Setup\n    # step\n", "Setup\n# step"),
        ("\t# tabbed\n", "# tabbed"),
        // Blank lines inside an indented block keep it open.
        ("    # a\n\n    # b\n", "# a\n\n# b"),
        // An indented line in a paragraph continues it.
        ("Para\n    # lazy", "Para\n# lazy"),
        // An indented line after a list item is its continuation, not code.
        ("- item\n\n    **more**\n", "item\n\nmore"),
        ("1. step\n    *more*\n", "step\nmore"),
        // The list ends at a paragraph at column 0 after a blank line.
        ("- item\n\nPara\n\n    *code*\n", "item\n\nPara\n\n*code*"),
        // Headings by the ATX rule.
        ("   ### Three ###\n", "Three"),
        ("#\tTabbed\n", "Tabbed"),
        ("#tag and C#\n", "#tag and C#"),
    ];
    for (doc, want) in cases {
        assert_eq!(strip_markdown(doc), want, "{doc:?}");
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.md");
    std::fs::write(&path, "# Notes\n\n    # keep\n").unwrap();
    let resp = tool_export_text(
        id(1),
        &json!({ "path": path.to_string_lossy() }),
        &MockIpc::new(),
    );
    let text = resp.result.unwrap()["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["text"], "Notes\n\n# keep");
    let docs = include_str!("../../../../docs/AGENTS.md");
    assert!(docs.contains("indented code is kept as code without its indent"));
}

/// `find_double_close` looked for `]]` across newlines, so an unclosed `[[`
/// took the text up to a `]]` lines later as its target and hid the links
/// in between, and an unclosed `![[` counted as an image. A wikilink or an
/// embed is now one line, as Obsidian reads it.
#[test]
fn a_wikilink_or_an_embed_is_one_line() {
    use mdopener_mcp::{count_embedded_images, extract_wikilinks};
    let doc = "See [[open\nmore text\n[[Real]] and [[Other|alias]]\n";
    assert_eq!(extract_wikilinks(doc), ["Other", "Real"]);
    let doc = "![[broken\ntext\n[[Note]]\n";
    assert_eq!(extract_wikilinks(doc), ["Note"]);
    assert_eq!(count_embedded_images(doc), 0);
    assert_eq!(count_embedded_images("![[a.png]]\n![[b\n![[c.png]]\n"), 2);
    // A `]` ending one line and a `]` starting the next do not close it.
    assert!(extract_wikilinks("[[a]\n]] x\n").is_empty());
    let docs = include_str!("../../../../docs/AGENTS.md");
    assert!(docs.contains("a link is one line, as in Obsidian"));
}

/// `strip_inline_markdown` read a `[text]` link before a wikilink, so
/// `export_text` turned `[[Real]]` into `[Real]` and `[[Plan|the plan]]`
/// into `[Plan|the plan]`, and read an image before an embed, so
/// `![[a.png]]` left `[a.png]`. A wikilink now reads its target, or its
/// alias when it has one, and an embed reads nothing.
#[test]
fn export_text_reads_a_wikilink_as_its_target_or_alias() {
    let cases = [
        ("See [[Real]] now", "See Real now"),
        ("See [[Plan|the plan]].", "See the plan."),
        ("Embed ![[a.png]] here", "Embed  here"),
        ("A [link](x) and [[Note]]", "A link and Note"),
        // In a table the alias pipe is escaped, as Obsidian writes it.
        ("| [[A]] | [[B\\|b]] |\n|---|---|\n| 1 | 2 |", "A\tb\n1\t2"),
    ];
    for (doc, want) in cases {
        assert_eq!(strip_markdown(doc), want, "{doc:?}");
    }
    let docs = include_str!("../../../../docs/AGENTS.md");
    assert!(docs.contains("a wikilink reads its target, or its alias"));
}

/// `strip_markdown` took a heading's `#`s off before the blockquote
/// leaders, while the line still started with `>`, so `> # Quote` kept its
/// `#`. The leaders now go first, then the ATX rule of the headings.
#[test]
fn export_text_strips_a_heading_inside_a_blockquote() {
    let cases = [
        ("> # Quote", "Quote"),
        ("> > ## Deep ##\n> body", "Deep\nbody"),
        (">### Tight", "Tight"),
        // Four spaces after the leader is indented code, not a heading.
        (">     # code", "# code"),
        // `#tag` is text in a quote too.
        ("> #tag here", "#tag here"),
        ("> plain **bold**", "plain bold"),
    ];
    for (doc, want) in cases {
        assert_eq!(strip_markdown(doc), want, "{doc:?}");
    }
    let docs = include_str!("../../../../docs/AGENTS.md");
    assert!(docs.contains("so `> # Quote` reads `Quote`"));
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
/// the whole MCP session down). The tool now refuses one above 10000, which
/// it used to read as 10000 in silence; the diff itself still takes any.
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
    let (_, hunks, _, _) = compute_unified_diff("a", "b", "x\ny\n", "x\nz\n", usize::MAX);
    assert_eq!(hunks, 1);
    let resp = mdopener_mcp::tool_diff_documents(
        id(1),
        &json!({ "path_a": a, "path_b": b, "context_lines": 10_000 }),
    );
    assert!(!is_error(&resp), "{resp:?}");
    assert_eq!(content_text(&resp)["hunks"], 1);
    for bad in [json!(u64::MAX), json!(10_001), json!(2.5)] {
        let resp = mdopener_mcp::tool_diff_documents(
            id(1),
            &json!({ "path_a": a, "path_b": b, "context_lines": bad }),
        );
        assert_eq!(
            param_error(&resp),
            format!(
                "`context_lines` must be a whole number from 0 to 10000, got {bad}; \
                 omit it for the default of 3"
            )
        );
    }
    let msg = param_error(&call_tool(
        "diff_documents",
        json!({ "path_a": a, "path_b": b, "context_lines": 10_001 }),
    ));
    assert_eq!(msg, "`context_lines` must be at most 10000, got 10001");
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

/// An empty `review_id` used to be read as absent: with `content` the call
/// registered a new review, which superseded the pending one the agent meant
/// to resume. It is refused before the app is asked, by the tool and by the
/// schema check.
#[test]
fn request_review_refuses_an_empty_or_blank_review_id() {
    use mdopener_mcp::tool_request_review_with;
    for bad in ["", "   "] {
        let ipc = MockIpc::new()
            .on_post("/review", Ok(json!({ "ok": true })))
            .on_get("/review/result", Ok(json!({ "status": "pending" })));
        let resp = tool_request_review_with(
            id(1),
            &json!({ "review_id": bad, "content": "plan", "blocking": false }),
            &ipc,
            std::time::Duration::from_millis(10),
        );
        let msg = param_error(&resp);
        assert!(
            msg.contains("`review_id` must not be empty or blank"),
            "{msg}"
        );
        assert!(
            ipc.calls().is_empty(),
            "{bad:?} reached the app: {:?}",
            ipc.calls()
        );
    }
    let msg = param_error(&call_tool(
        "request_review",
        json!({ "review_id": "", "content": "plan" }),
    ));
    assert_eq!(
        msg,
        "`review_id` must be at least 1 character long, got \"\""
    );
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

/// The app going quiet while a review was being waited on came back as
/// "App unreachable during review: ..." with no review id and no next step,
/// so the agent could neither resume nor tell it from a review never made.
#[test]
fn request_review_that_loses_the_app_names_the_review_and_how_to_resume() {
    use mdopener_mcp::tool_request_review_with;
    use std::time::Duration;
    let ipc = MockIpc::new()
        .on_post("/review", Ok(json!({ "ok": true })))
        .on_get(
            "/review/result",
            Err("Could not connect to IPC server at 127.0.0.1:1: Connection refused".into()),
        );
    let resp = tool_request_review_with(
        id(1),
        &json!({ "content": "plan", "wait_ms": 1000 }),
        &ipc,
        Duration::from_millis(10),
    );
    let err = tool_error_text(&resp);
    let review_id = ipc
        .calls()
        .iter()
        .find_map(|(m, _, body)| (m == "POST").then(|| body.clone()).flatten())
        .and_then(|b| b["reviewId"].as_str().map(str::to_string))
        .expect("the review was registered");
    assert!(
        err.starts_with(&format!(
            "Lost contact with Ashlr MD while waiting on review `{review_id}`: Could not connect"
        )),
        "{err}"
    );
    assert!(
        err.contains(&format!("call request_review with review_id `{review_id}`")),
        "{err}"
    );
    assert!(err.ends_with("request a new one."), "{err}");
}

/// A resumed call with `blocking: false` used to wait up to `wait_ms` like a
/// blocking one; it now reads the review's state once and returns it.
#[test]
fn resumed_non_blocking_review_returns_its_state_at_once() {
    use mdopener_mcp::tool_request_review_with;
    use std::time::{Duration, Instant};
    let ipc = MockIpc::new().on_post("/review", Ok(json!({ "ok": true })));
    let v = content_text(&tool_request_review_with(
        id(1),
        &json!({ "content": "plan", "blocking": false }),
        &ipc,
        Duration::ZERO,
    ));
    let review_id = v["reviewId"].as_str().unwrap().to_string();
    // A poll interval far longer than the test may take: a call that waits
    // at all would sleep through it.
    let poll = Duration::from_secs(30);
    let pending = MockIpc::new().on_get("/review/result", Ok(json!({ "status": "pending" })));
    let started = Instant::now();
    let resp = tool_request_review_with(
        id(2),
        &json!({ "review_id": review_id, "blocking": false, "wait_ms": 50_000 }),
        &pending,
        poll,
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    let v = content_text(&resp);
    assert_eq!(v["status"], "pending", "{v}");
    assert_eq!(v["reviewId"], review_id.as_str());
    assert_eq!(pending.calls().len(), 1, "one look at the review");

    let done = MockIpc::new().on_get(
        "/review/result",
        Ok(json!({ "status": "done", "verdict": "approved", "comments": "ok" })),
    );
    let resp = tool_request_review_with(
        id(3),
        &json!({ "review_id": review_id, "blocking": false }),
        &done,
        poll,
    );
    assert_eq!(content_text(&resp)["verdict"], "approved");

    // A review whose window has closed reports timeout, still at once.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let started = Instant::now();
    let resp = tool_request_review_with(
        id(4),
        &json!({ "review_id": format!("rev_1_00000001_{}", now - 60_000), "blocking": false }),
        &pending,
        poll,
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(content_text(&resp)["verdict"], "timeout");
}

/// A resumed call (`review_id`) cannot change the review, so it used to
/// ignore `path`, `content` and `timeout_ms` without a word: an agent that
/// edited its plan and resent it with the old id got the verdict on the old
/// text. Resending the first call's arguments still works; a value that
/// differs is refused, naming it, and nothing is polled.
#[test]
fn request_review_resumed_with_different_arguments_is_refused() {
    use mdopener_mcp::tool_request_review_with;
    use std::time::Duration;
    let dir = tempfile::tempdir().unwrap();
    let plan = dir.path().join("plan.md");
    let other = dir.path().join("other.md");
    std::fs::write(&plan, "# Plan\n").unwrap();
    std::fs::write(&other, "# Other\n").unwrap();
    let register = |args: Value| {
        let ipc = MockIpc::new().on_post("/review", Ok(json!({ "ok": true })));
        let mut a = args;
        a["blocking"] = json!(false);
        let v = content_text(&tool_request_review_with(id(1), &a, &ipc, Duration::ZERO));
        v["reviewId"].as_str().unwrap().to_string()
    };
    let resume = |args: Value| {
        let ipc = MockIpc::new().on_get(
            "/review/result",
            Ok(json!({ "status": "done", "verdict": "approved", "comments": "" })),
        );
        let resp = tool_request_review_with(id(2), &args, &ipc, Duration::from_millis(1));
        (resp, ipc.calls().len())
    };

    let by_content = register(json!({ "content": "v1", "timeout_ms": 60_000 }));
    let by_path = register(json!({ "path": plan }));

    // The same arguments again, or none, resume the review.
    for args in [
        json!({ "review_id": by_content, "content": "v1", "timeout_ms": 60_000, "blocking": false }),
        json!({ "review_id": by_content }),
        json!({ "review_id": by_path, "path": plan, "timeout_ms": 300_000 }),
    ] {
        let (resp, _) = resume(args.clone());
        let v = content_text(&resp);
        assert_eq!(v["verdict"], "approved", "{args}: {v}");
        assert!(v.get("ignored").is_none(), "{v}");
    }
    // A relative spelling of the same file is the same path.
    let cwd = std::env::current_dir().unwrap();
    if let Ok(rel) = plan.strip_prefix(&cwd) {
        let (resp, _) = resume(json!({ "review_id": by_path, "path": rel }));
        assert_eq!(content_text(&resp)["verdict"], "approved");
    }

    for (args, field) in [
        (
            json!({ "review_id": by_content, "content": "v2" }),
            "content",
        ),
        (
            json!({ "review_id": by_content, "timeout_ms": 90_000 }),
            "timeout_ms",
        ),
        (json!({ "review_id": by_content, "path": plan }), "path"),
        (json!({ "review_id": by_path, "path": other }), "path"),
        (
            json!({ "review_id": by_path, "content": "# Plan\n" }),
            "content",
        ),
    ] {
        let (resp, polls) = resume(args.clone());
        let msg = param_error(&resp);
        assert!(
            msg.starts_with(&format!("`{field}` differs from what review `")),
            "{args}: {msg}"
        );
        assert!(msg.contains("without `review_id`"), "{msg}");
        assert_eq!(polls, 0, "a refused resume does not poll");
    }
}

/// A review this server did not register (it was restarted, or another
/// server registered it) cannot be compared: resending the arguments still
/// resumes it, and the result says they were not checked.
#[test]
fn request_review_resumed_from_another_server_reports_ignored_arguments() {
    use mdopener_mcp::tool_request_review_with;
    use std::time::Duration;
    let ipc = MockIpc::new().on_get(
        "/review/result",
        Ok(json!({ "status": "done", "verdict": "approved", "comments": "" })),
    );
    let foreign = format!("rev_1_00000001_{}", u64::MAX / 2);
    let resp = tool_request_review_with(
        id(1),
        &json!({ "review_id": foreign, "content": "plan", "timeout_ms": 60_000 }),
        &ipc,
        Duration::from_millis(1),
    );
    let v = content_text(&resp);
    assert_eq!(v["verdict"], "approved", "{v}");
    assert_eq!(v["ignored"], json!(["content", "timeout_ms"]), "{v}");
    assert!(v["note"].as_str().unwrap().contains("not checked"), "{v}");
    // A path that is not even a document is only compared, never opened.
    let resp = tool_request_review_with(
        id(1),
        &json!({ "review_id": foreign, "path": "/nonexistent/x.md" }),
        &ipc,
        Duration::from_millis(1),
    );
    assert_eq!(content_text(&resp)["ignored"], json!(["path"]));
    // Without them there is nothing to report.
    let resp = tool_request_review_with(
        id(1),
        &json!({ "review_id": foreign }),
        &ipc,
        Duration::from_millis(1),
    );
    assert!(content_text(&resp).get("ignored").is_none());
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
    // Nothing unsaved lingers, and the unreadable "file" is not passed off
    // as an empty session either.
    let err = store_get_context(&sid, 20).unwrap_err();
    assert!(err.contains("Cannot read"), "{err}");
    std::fs::remove_dir(&path).unwrap();
}

/// An unparseable session file answered "Failed to read conversation
/// context: ... is not a session file: ...", with no session named and no
/// next step. It now names the session, the file, and what to do.
#[test]
fn get_conversation_context_on_a_corrupt_session_file_names_it_and_the_next_step() {
    let sid = unique_session();
    let path = session_file_path(&sid).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{ not json").unwrap();
    let err = tool_error_text(&tool_get_conversation_context(
        id(1),
        &json!({ "session_id": sid }),
    ));
    assert!(
        err.starts_with(&format!(
            "Cannot get the conversation context of session `{sid}`: {} is not a session file: ",
            path.display()
        )),
        "{err}"
    );
    assert!(
        err.ends_with("; use a new `session_id`, or move the file aside and call again"),
        "{err}"
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    std::fs::remove_file(&path).unwrap();
}

/// A session file was read whole however large it was. Past 16 MiB it is
/// now not read at all: getting the context is an error saying how large it
/// is (not an empty session), and saving refuses without touching the file.
#[test]
fn a_session_file_past_the_cap_is_not_read() {
    use mdopener_mcp::MAX_SESSION_FILE_BYTES;
    let sid = unique_session();
    let path = session_file_path(&sid).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::File::create(&path)
        .unwrap()
        .set_len(MAX_SESSION_FILE_BYTES + 1)
        .unwrap();
    let err = tool_error_text(&tool_get_conversation_context(
        id(1),
        &json!({ "session_id": sid }),
    ));
    assert!(
        err.contains("more than the 16 MiB a session file may be"),
        "{err}"
    );
    assert!(err.contains("new `session_id`"), "{err}");
    let err = tool_error_text(&tool_save_conversation_message(
        id(2),
        &json!({ "session_id": sid, "role": "agent", "content": "x" }),
    ));
    assert!(err.contains("not saved") && err.contains("16 MiB"), "{err}");
    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        MAX_SESSION_FILE_BYTES + 1
    );
    std::fs::remove_file(&path).unwrap();
}

/// Appends keep the session file within the cap, dropping the oldest
/// messages and saying how many, so a log this server writes stays readable.
#[test]
fn saving_past_the_session_cap_drops_the_oldest_and_says_so() {
    use mdopener_mcp::{persist_session, ConversationMessage, SessionLog, MAX_SESSION_FILE_BYTES};
    let sid = unique_session();
    let old = ConversationMessage {
        id: "msg-old".into(),
        session_id: sid.clone(),
        role: "agent".into(),
        content: "o".repeat(MAX_SESSION_FILE_BYTES as usize - 512 * 1024),
        cited_docs: vec![],
        timestamp_ms: 1,
    };
    persist_session(
        &sid,
        &SessionLog {
            messages: vec![old],
        },
    )
    .unwrap();
    let resp = tool_save_conversation_message(
        id(1),
        &json!({ "session_id": sid, "role": "agent", "content": "n".repeat(1024 * 1024) }),
    );
    let body = content_text(&resp);
    assert_eq!(body["ok"], true, "{body}");
    assert_eq!(body["dropped"], 1, "{body}");
    let note = body["note"].as_str().unwrap();
    assert!(note.contains("1 oldest message(s) were dropped"), "{note}");
    let path = session_file_path(&sid).unwrap();
    assert!(std::fs::metadata(&path).unwrap().len() <= MAX_SESSION_FILE_BYTES);
    let ctx = store_get_context(&sid, 20).unwrap();
    assert_eq!(ctx.len(), 1);
    assert!(ctx[0].content.starts_with('n'));
    // A save that fits drops nothing and says nothing about it.
    let body = content_text(&tool_save_conversation_message(
        id(2),
        &json!({ "session_id": sid, "role": "human", "content": "ok" }),
    ));
    assert!(
        body.get("dropped").is_none() && body.get("note").is_none(),
        "{body}"
    );
    std::fs::remove_file(&path).unwrap();
}

// ── edit_canvas writes whole coordinates as integers ─────────────────────────

/// JSON Canvas positions and sizes are integers, but move_node and
/// resize_node wrote `"x": 5.0`. A whole value is now written as an integer
/// (also when given as `5.0`); a fractional one is kept as given.
#[test]
fn edit_canvas_writes_whole_coordinates_as_integers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board.canvas");
    let canvas = json!({
        "nodes": [{ "id": "a", "type": "text", "text": "hi", "x": 0, "y": 0,
                    "width": 10, "height": 10 }],
        "edges": []
    });
    std::fs::write(&path, canvas.to_string()).unwrap();
    let resp = mdopener_mcp::tool_edit_canvas(
        id(1),
        &json!({ "path": path, "ops": [
            { "type": "move_node", "id": "a", "x": 5, "y": -3.0 },
            { "type": "resize_node", "id": "a", "width": 200.0, "height": 50.5 }
        ] }),
    );
    assert!(!is_error(&resp), "{resp:?}");
    let text = std::fs::read_to_string(&path).unwrap();
    let saved: Value = serde_json::from_str(&text).unwrap();
    let node = &saved["nodes"][0];
    assert!(node["x"].is_i64() && node["x"] == 5, "{text}");
    assert!(node["y"].is_i64() && node["y"] == -3, "{text}");
    assert!(node["width"].is_i64() && node["width"] == 200, "{text}");
    assert_eq!(node["height"].as_f64(), Some(50.5), "{text}");
    assert!(!text.contains("5.0") && !text.contains("200.0"), "{text}");
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
    // An op named under another key (`op`, `action`) points at `type`, the
    // field whose values it holds, not at `id`, one edit from `op`.
    for key in ["op", "action", "kind"] {
        let msg = refused_before_the_tool(
            "edit_canvas",
            json!({ "path": path, "ops": [{ key: "move_node", "id": "a", "x": 1, "y": 2 }] }),
        );
        assert!(
            msg.starts_with(&format!("Unknown field `{key}` in `ops[0]`: it takes ")),
            "{msg}"
        );
        assert!(msg.ends_with("Did you mean `type`?"), "{key}: {msg}");
    }
    // Not a value of any enum: the near spelling still wins, or no hint.
    let msg = refused_before_the_tool(
        "edit_canvas",
        json!({ "path": path, "ops": [{ "type": "move_node", "id": "a", "op": "nope" }] }),
    );
    assert!(msg.ends_with("Did you mean `id`?"), "{msg}");
    // The same at the top level: `export` with the format under `kind`.
    let msg = refused_before_the_tool("export", json!({ "kind": "html" }));
    assert!(msg.ends_with("Did you mean `format`?"), "{msg}");
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

/// `set_node_color` (and `add_node`'s `node.color`) wrote any string, so
/// `"red"` or `"7"` was saved and the app showed the node without its colour.
#[test]
fn edit_canvas_refuses_a_colour_json_canvas_does_not_allow() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board.canvas");
    let raw = r#"{"nodes":[{"id":"a","type":"text","text":"a","x":0,"y":0,"width":9,"height":9}],"edges":[]}"#;
    std::fs::write(&path, raw).unwrap();
    for bad in [
        "red", "0", "7", "12", "", "#abcd", "#ggg", "#12345", "abc", "# abc",
    ] {
        let resp = mdopener_mcp::tool_edit_canvas(
            id(1),
            &json!({ "path": path, "ops": [{ "type": "set_node_color", "id": "a", "color": bad }] }),
        );
        let msg = param_error(&resp);
        assert!(
            msg.starts_with("op[0] set_node_color: color must be a preset"),
            "{bad}: {msg}"
        );
        let node = json!({ "id": "n", "type": "text", "text": "t", "x": 0, "y": 0, "width": 9, "height": 9, "color": bad });
        let resp = mdopener_mcp::tool_edit_canvas(
            id(1),
            &json!({ "path": path, "ops": [{ "type": "add_node", "node": node }] }),
        );
        let msg = param_error(&resp);
        assert!(
            msg.starts_with("op[0] add_node: node.color must be a preset"),
            "{bad}: {msg}"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            raw,
            "file untouched"
        );
    }
    for good in ["1", "6", "#abc", "#A1b2C3"] {
        let resp = mdopener_mcp::tool_edit_canvas(
            id(1),
            &json!({ "path": path, "ops": [{ "type": "set_node_color", "id": "a", "color": good }], "save": false }),
        );
        assert!(!is_error(&resp), "{good}: {resp:?}");
    }
}

/// edit_canvas's description said "set node colour" and its refusal "a hex
/// colour", while the op is `set_node_color` and the schema's field
/// `color` says "Color preset". Both now spell it "color".
#[test]
fn edit_canvas_spells_color_as_its_schema_does() {
    let def = tool_registry()
        .into_iter()
        .find(|d| d.name == "edit_canvas")
        .unwrap();
    let schema = def.input_schema.to_string();
    assert!(!def.description.contains("colour"), "{}", def.description);
    assert!(!schema.contains("colour"), "{schema}");
    assert!(
        def.description.contains("set node color"),
        "{}",
        def.description
    );
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board.canvas");
    let raw = r#"{"nodes":[{"id":"a","type":"text","text":"a","x":0,"y":0,"width":9,"height":9}],"edges":[]}"#;
    std::fs::write(&path, raw).unwrap();
    let resp = mdopener_mcp::tool_edit_canvas(
        id(1),
        &json!({ "path": path, "ops": [{ "type": "set_node_color", "id": "a", "color": "red" }] }),
    );
    let msg = param_error(&resp);
    assert!(msg.contains("a hex color #rgb or #rrggbb"), "{msg}");
    assert!(!msg.contains("colour"), "{msg}");
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

/// An unparseable canvas answered "Canvas parse error: Invalid JSON: ...",
/// naming neither the file nor whether it had been touched. It now names the
/// absolute path, says the file was left unchanged, and what to fix.
#[test]
fn edit_canvas_on_invalid_json_names_the_file_and_the_next_step() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("broken.canvas");
    std::fs::write(&path, "{ not json").unwrap();
    let resp = mdopener_mcp::tool_edit_canvas(
        id(1),
        &json!({ "path": path, "ops": [{ "type": "delete_node", "id": "n1" }] }),
    );
    let err = tool_error_text(&resp);
    let abs = std::fs::canonicalize(&path).unwrap();
    assert!(
        err.starts_with(&format!(
            "Canvas parse error in '{}': Invalid JSON: ",
            abs.display()
        )),
        "{err}"
    );
    assert!(
        err.ends_with(
            "The file was left unchanged: edit_canvas does not overwrite a canvas it \
             cannot parse. Fix the file (a JSON object whose `nodes` and `edges` are \
             arrays of objects), then call edit_canvas again."
        ),
        "{err}"
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
}

/// The edit_canvas description listed `saved` and `content` without saying
/// what they hold, and called each op atomic when the whole call is: an
/// agent could not tell that `save: false` is a dry run whose result is in
/// `content`, or that `content` is null once the file is written.
#[test]
fn edit_canvas_description_says_what_saved_and_content_hold() {
    let def = tool_registry()
        .into_iter()
        .find(|d| d.name == "edit_canvas")
        .unwrap();
    assert!(
        def.description.contains(
            "`saved` whether the file was written, and `content` null once it was; with \
             `save: false` nothing is written and `content` is the canvas JSON (a string) \
             that would have been."
        ),
        "{}",
        def.description
    );
    assert!(def.description.contains("The ops apply all or nothing"));
    let save = def.input_schema["properties"]["save"]["description"]
        .as_str()
        .unwrap();
    assert!(
        save.contains("false is a dry run that writes nothing"),
        "{save}"
    );

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board.canvas");
    let raw = r#"{"nodes":[{"id":"a","type":"text","text":"x","x":0,"y":0,"width":10,"height":10}],"edges":[]}"#;
    std::fs::write(&path, raw).unwrap();
    let op = json!([{ "type": "move_node", "id": "a", "x": 5, "y": 6 }]);
    let dry = content_text(&mdopener_mcp::tool_edit_canvas(
        id(1),
        &json!({ "path": path, "ops": op, "save": false }),
    ));
    assert_eq!(dry["saved"], false);
    let would_be: Value = serde_json::from_str(dry["content"].as_str().unwrap()).unwrap();
    assert_eq!(would_be["nodes"][0]["x"], 5);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
    let saved = content_text(&mdopener_mcp::tool_edit_canvas(
        id(2),
        &json!({ "path": path, "ops": op }),
    ));
    assert_eq!(saved["saved"], true);
    assert_eq!(saved["content"], Value::Null);
    assert_ne!(std::fs::read_to_string(&path).unwrap(), raw);
}

/// diff_documents listed `hunks`, `added` and `removed` without saying they
/// are counts (of hunks, and of lines), or what identical documents return.
#[test]
fn diff_documents_description_says_what_its_counts_are() {
    let def = tool_registry()
        .into_iter()
        .find(|d| d.name == "diff_documents")
        .unwrap();
    assert!(
        def.description.contains(
            "`hunks` is the number of change hunks, `added` and `removed` the number of \
             lines added and removed, `path_a` and `path_b` the absolute paths read, and \
             `diff` an empty string (with all three counts 0) when the documents are identical."
        ),
        "{}",
        def.description
    );
    let dir = tempfile::tempdir().unwrap();
    let (a, b, c) = (
        dir.path().join("a.md"),
        dir.path().join("b.md"),
        dir.path().join("c.md"),
    );
    std::fs::write(&a, "one\ntwo\nthree\n").unwrap();
    std::fs::write(&b, "one\ntwo\nthree\n").unwrap();
    std::fs::write(&c, "one\n2\nthree\nfour\n").unwrap();
    let ipc = MockIpc::new();
    let same = content_text(&call(
        "diff_documents",
        json!({ "path_a": a, "path_b": b }),
        &ipc,
    ));
    assert_eq!(same["diff"], "");
    assert_eq!(
        (
            same["hunks"].as_u64(),
            same["added"].as_u64(),
            same["removed"].as_u64()
        ),
        (Some(0), Some(0), Some(0))
    );
    let changed = content_text(&call(
        "diff_documents",
        json!({ "path_a": a, "path_b": c, "context_lines": 0 }),
        &ipc,
    ));
    assert_eq!(changed["added"], 2, "{changed}");
    assert_eq!(changed["removed"], 1, "{changed}");
    assert_eq!(changed["hunks"], 2, "{changed}");
    assert_eq!(
        changed["path_a"],
        std::fs::canonicalize(&a)
            .unwrap()
            .to_string_lossy()
            .as_ref()
    );
}

/// open_file's `path` said "Absolute or relative path" without saying
/// relative to what, while the server resolves it against its own working
/// directory and the app has another. Every path argument now says which.
#[test]
fn every_path_argument_says_what_a_relative_path_resolves_against() {
    let mut missing = Vec::new();
    for def in tool_registry() {
        let Some(props) = def.input_schema["properties"].as_object() else {
            continue;
        };
        for (name, prop) in props {
            if !(name == "path"
                || name.starts_with("path_")
                || name == "vault"
                || name.ends_with("_path"))
            {
                continue;
            }
            let desc = prop["description"].as_str().unwrap_or("");
            if !desc.contains("server's working directory") {
                missing.push(format!("{}.{name}: {desc}", def.name));
            }
        }
    }
    assert!(missing.is_empty(), "{}", missing.join("\n"));
}

/// Every path argument expands a leading `~` (expand_home), but the path
/// descriptions said only "absolute, or relative to this server's working
/// directory", and `output_path` said only how a relative path resolves.
/// Each one, `cited_docs` included, names all three forms in one wording.
#[test]
fn every_path_description_names_all_accepted_forms() {
    const FORMS: &str =
        "absolute, `~/...` for the home directory, or relative to this server's working directory";
    let mut checked = Vec::new();
    let mut missing = Vec::new();
    for def in tool_registry() {
        let Some(props) = def.input_schema["properties"].as_object() else {
            continue;
        };
        for (name, prop) in props {
            if !(name == "path"
                || name.starts_with("path_")
                || name == "vault"
                || name.ends_with("_path")
                || name == "cited_docs")
            {
                continue;
            }
            checked.push(format!("{}.{name}", def.name));
            let desc = prop["description"].as_str().unwrap_or("");
            if !desc.contains(FORMS) {
                missing.push(format!("{}.{name}: {desc}", def.name));
            }
        }
    }
    for want in [
        "open_file.path",
        "export.output_path",
        "search_vault.vault",
        "save_conversation_message.cited_docs",
        "diff_documents.path_a",
        "stream_edit.path",
        "stream_edit_apply.path",
    ] {
        assert!(
            checked.iter().any(|c| c == want),
            "{want} not checked: {checked:?}"
        );
    }
    assert!(missing.is_empty(), "{}", missing.join("\n"));
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

// ── file:// resource URIs are percent-encoded in resources/list ──────────────

/// resources/list gave `file://` and the path as is, so a path with a space
/// (or `%`, `#`, `?`, or a character that is not ASCII) was not a valid URI.
/// The path is now percent-encoded as RFC 3986 and RFC 8089 require.
#[test]
fn file_uri_percent_encodes_the_path() {
    use mdopener_mcp::file_uri;
    let cases = [
        ("/v/a.md", "file:///v/a.md"),
        ("/v/My Notes.md", "file:///v/My%20Notes.md"),
        ("/v/100% #1?.md", "file:///v/100%25%20%231%3F.md"),
        ("/v/caf\u{e9}.md", "file:///v/caf%C3%A9.md"),
        (
            "/v/a-b_c~d(1)+x@y:z,w;q=r!$&'*.md",
            "file:///v/a-b_c~d(1)+x@y:z,w;q=r!$&'*.md",
        ),
        (
            "/v/[x]{y}`z^|\"<>.md",
            "file:///v/%5Bx%5D%7By%7D%60z%5E%7C%22%3C%3E.md",
        ),
        ("C:\\notes\\a b.md", "file:///C:/notes/a%20b.md"),
        ("\\\\srv\\share\\a.md", "file:////srv/share/a.md"),
    ];
    for (path, want) in cases {
        assert_eq!(file_uri(path), want, "{path}");
    }
}

/// A vault file whose path has a space and a `%` is listed by its encoded
/// URI, and resources/read takes both that URI and the unencoded form
/// resources/list used to give, so existing clients keep working.
#[test]
fn listed_file_uris_are_encoded_and_both_forms_read() {
    use mdopener_mcp::handle_resource_read;
    let dir = tempfile::tempdir().unwrap();
    let dir = std::fs::canonicalize(dir.path()).unwrap();
    let doc = dir.join("My Notes 100%.md");
    std::fs::write(&doc, "# Notes\n").unwrap();
    let doc = doc.to_string_lossy().into_owned();
    let vault = json!({ "files": [{ "path": doc, "name": "My Notes 100%.md" }], "recents": [] });
    let ipc = MockIpc::new().on_get("/vault", Ok(vault));
    let listed = handle_resources_list(id(1), &ipc).result.unwrap();
    let uris: Vec<String> = listed["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["uri"].as_str())
        .filter(|u| u.starts_with("file://"))
        .map(str::to_string)
        .collect();
    let encoded = format!("file://{}", doc.replace('%', "%25").replace(' ', "%20"));
    assert_eq!(uris, std::slice::from_ref(&encoded));
    assert!(!encoded.contains(' '), "{encoded}");
    for uri in [encoded, format!("file://{doc}")] {
        let resp = handle_resource_read(id(2), &uri, &ipc);
        assert!(resp.error.is_none(), "{uri}: {:?}", resp.error);
        assert_eq!(
            resp.result.unwrap()["contents"][0]["text"],
            "# Notes\n",
            "{uri}"
        );
    }
}

/// A Windows path is listed as `file:///C:/...`; reading that URI names the
/// advertised `C:\...` path (it is then checked on disk like any other), not
/// "not in vault". A path the app does not list is still refused.
#[test]
fn an_encoded_windows_file_uri_names_the_advertised_path() {
    use mdopener_mcp::{file_uri, handle_resource_read};
    let win = "C:\\notes\\My Notes.md";
    let share = "\\\\srv\\share\\a.md";
    let vault = json!({ "files": [{ "path": win, "name": "My Notes.md" }], "recents": [share] });
    let ipc = MockIpc::new().on_get("/vault", Ok(vault));
    let uri = file_uri(win);
    assert_eq!(uri, "file:///C:/notes/My%20Notes.md");
    for uri in [uri, format!("file://{win}"), file_uri(share)] {
        let err = handle_resource_read(id(1), &uri, &ipc).error.unwrap();
        assert!(
            !err.message.starts_with("Resource not in vault"),
            "{uri}: {}",
            err.message
        );
    }
    let err = handle_resource_read(id(2), "file:///C:/notes/other.md", &ipc)
        .error
        .unwrap();
    assert!(
        err.message.starts_with("Resource not in vault"),
        "{}",
        err.message
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

/// A `file://` read while the app cannot be reached was answered "Resource
/// not in vault" (-32002), as if the file were the problem; it is now the
/// -32000 "not running" error `mdopener://current` gives, with a next step.
#[test]
fn file_resource_read_with_app_down_says_the_app_is_not_running() {
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("a.md");
    std::fs::write(&doc, "# A\n").unwrap();
    let uri = format!("file://{}", doc.display());
    let err = handle_resource_read(id(1), &uri, &app_down_ipc())
        .error
        .expect("must be an error");
    assert_eq!(err.code, -32000, "{}", err.message);
    assert!(
        err.message.contains("not appear to be running"),
        "{}",
        err.message
    );
    assert!(!err.message.contains("not in vault"), "{}", err.message);
    // With the app up, a file it does not list is still -32002, now with
    // a next step.
    let ipc = MockIpc::new().on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
    let err = handle_resource_read(id(2), &uri, &ipc).error.unwrap();
    assert_eq!(err.code, -32002);
    assert!(err.message.contains("open_file"), "{}", err.message);
}

/// A malformed escape in a `file://` URI (`%ZZ`, a lone `%`, `%FF` that is
/// not UTF-8) was answered "Resource not in vault", as if the file were the
/// problem; it is now -32602 naming the bad escape.
#[test]
fn file_resource_uris_with_invalid_percent_encoding_are_refused_clearly() {
    let dir = tempfile::tempdir().unwrap();
    let dir = std::fs::canonicalize(dir.path()).unwrap();
    let doc = dir.join("100% done.md");
    std::fs::write(&doc, "# Done\n").unwrap();
    let doc = doc.to_string_lossy().into_owned();
    let vault = json!({ "files": [{ "path": doc, "name": "100% done.md" }], "recents": [] });
    let ipc = MockIpc::new().on_get("/vault", Ok(vault));
    let d = dir.to_string_lossy().into_owned();
    for (uri, bad) in [
        (format!("file://{d}/a%ZZ.md"), "`%ZZ`"),
        (format!("file://{d}/a%2.md"), "`%2.`"),
        (format!("file://{d}/a%"), "`%`"),
        (format!("file://{d}/a%FF.md"), "UTF-8"),
    ] {
        let msg = param_error(&handle_resource_read(id(1), &uri, &ipc));
        assert!(msg.starts_with("Invalid `file://` URI"), "{uri}: {msg}");
        assert!(msg.contains(bad), "{uri}: {msg}");
    }
    // The advertised (unencoded) path is still served as written, `%` and all,
    // and so is its correct encoding.
    for uri in [
        format!("file://{doc}"),
        format!("file://{}", doc.replace('%', "%25").replace(' ', "%20")),
    ] {
        let resp = handle_resource_read(id(2), &uri, &ipc);
        assert!(resp.error.is_none(), "{uri}: {:?}", resp.error);
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
        // Each says what it refuses to do: the call is an open, a present
        // or a review, not a read.
        for (resp, verb, done) in [
            (open, "open", "opened"),
            (present, "present", "presented"),
            (review, "review", "reviewed"),
        ] {
            let err = tool_error_text(&resp);
            assert!(err.contains("Markdown"), "{path}: {err}");
            assert!(
                err.starts_with(&format!("Refusing to {verb} `path` '")),
                "{path}: {err}"
            );
            assert!(err.ends_with(&format!("can be {done}.")), "{path}: {err}");
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
            if let Some(first) = prop["enum"].as_array().and_then(|e| e.first()) {
                args.insert(k.clone(), first.clone());
                continue;
            }
            let v = match prop["type"].as_str() {
                Some("string") => json!("x"),
                Some("boolean") => json!(true),
                // At least the declared minimum (`request_review`'s
                // `timeout_ms` starts at 5000).
                Some("integer") => json!(prop["minimum"].as_i64().unwrap_or(1).max(1)),
                Some("number") => json!(1.5),
                Some("array") => sample_array(prop),
                Some("object") => json!({}),
                _ => json!("x"),
            };
            args.insert(k.clone(), v);
        }
        let r = mdopener_mcp::check_tool_arguments(&def, &Value::Object(args));
        assert!(r.is_ok(), "{}: {:?}", def.name, r);
    }
}

/// An array `prop` accepts: empty, or as many elements as its `minItems`
/// asks for (`edit_canvas`'s `ops`), each with its required fields filled.
fn sample_array(prop: &Value) -> Value {
    let n = prop["minItems"].as_u64().unwrap_or(0) as usize;
    let items = &prop["items"];
    let item = match items["type"].as_str() {
        Some("object") => {
            let mut obj = serde_json::Map::new();
            for req in items["required"].as_array().into_iter().flatten() {
                let req = req.as_str().unwrap();
                obj.insert(req.to_string(), sample_of(&items["properties"][req]).0);
            }
            Value::Object(obj)
        }
        _ => sample_of(items).0,
    };
    Value::Array(vec![item; n])
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
        Some("array") => (sample_array(prop), json!({})),
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
            // A value of the right type outside the declared `enum` is
            // refused too, and the message lists the allowed values.
            if let Some(allowed) = prop["enum"].as_array() {
                let mut args = valid.clone();
                args.insert(k.clone(), json!("not-an-allowed-value"));
                let msg = refused_before_the_tool(name, Value::Object(args));
                assert!(
                    msg.starts_with(&format!("`{k}` must be one of ")),
                    "{name}.{k}: {msg}"
                );
                for a in allowed {
                    assert!(msg.contains(a.as_str().unwrap()), "{name}.{k}: {msg}");
                }
            }
            // A string shorter than its declared `minLength` is refused,
            // and one exactly that long is not.
            if let Some(min) = prop["minLength"].as_u64() {
                let mut args = valid.clone();
                args.insert(k.clone(), json!("x".repeat(min as usize - 1)));
                let msg = refused_before_the_tool(name, Value::Object(args));
                assert!(
                    msg.starts_with(&format!("`{k}` must be at least {min} character")),
                    "{name}.{k}: {msg}"
                );
                let mut args = valid.clone();
                args.insert(k.clone(), json!("é".repeat(min as usize)));
                let r = mdopener_mcp::check_tool_arguments(&def, &Value::Object(args));
                assert!(r.is_ok(), "{name}.{k}: {min} characters refused: {r:?}");
            }
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
                    if let Some(allowed) = fprop["enum"].as_array() {
                        let mut bad = item.clone();
                        bad.insert(f.clone(), json!("not-an-allowed-value"));
                        let mut args = valid.clone();
                        args.insert(k.clone(), json!([bad]));
                        let msg = refused_before_the_tool(name, Value::Object(args));
                        let want = format!("`{k}[0].{f}` must be one of ");
                        assert!(msg.starts_with(&want), "{name}.{k}.{f}: {msg}");
                        for a in allowed {
                            assert!(msg.contains(a.as_str().unwrap()), "{name}.{k}.{f}: {msg}");
                        }
                    }
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

/// `rel` spelled relative to this test's working directory (the tools resolve
/// relative paths against the server's).
fn relative_to_cwd(abs: &std::path::Path) -> std::path::PathBuf {
    let cwd = std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap();
    let abs = std::fs::canonicalize(abs).unwrap();
    let up = cwd.components().count() - 1;
    let mut rel = std::path::PathBuf::new();
    for _ in 0..up {
        rel.push("..");
    }
    rel.join(abs.strip_prefix("/").unwrap())
}

/// `text` without its `{ ... }` spans: the result shapes a description
/// names (`{ ok: true, replaced: 1, matchIndex }`), whose camelCase fields
/// are what the app returns, not options an agent passes.
fn outside_result_shapes(text: &str) -> String {
    let mut depth = 0usize;
    text.chars()
        .filter(|&c| match c {
            '{' => {
                depth += 1;
                false
            }
            '}' => {
                depth = depth.saturating_sub(1);
                false
            }
            _ => depth == 0,
        })
        .collect()
}

/// The schemas said "Absolute path" for arguments that take relative paths
/// too, and `stream_edit` named the app-internal `mcp_stream_edit_preview`
/// and camelCase options (`previewLines`, `matchIndex`) agents cannot pass.
/// A result field of that name inside a named result shape is allowed.
#[test]
fn tool_descriptions_match_the_arguments_and_path_rules() {
    assert_eq!(
        outside_result_shapes("Returns { ok, matchIndex } or [{ a }], a matchIndex"),
        "Returns  or [], a matchIndex"
    );
    for def in tool_registry() {
        let mut texts = vec![(
            "description".to_string(),
            outside_result_shapes(def.description),
        )];
        for (k, prop) in def.input_schema["properties"].as_object().unwrap() {
            texts.push((k.clone(), prop["description"].as_str().unwrap_or("").into()));
        }
        for (k, text) in texts {
            for stale in [
                "Absolute path",
                "mcp_stream_edit_preview",
                "previewLines",
                "matchIndex",
            ] {
                assert!(
                    !text.contains(stale),
                    "{}.{k} says {stale:?}: {text}",
                    def.name
                );
            }
        }
    }
    // And relative paths do work for those tools.
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.md");
    let b = dir.path().join("b.md");
    let board = dir.path().join("board.canvas");
    std::fs::write(&a, "x\n").unwrap();
    std::fs::write(&b, "y\n").unwrap();
    std::fs::write(&board, r#"{"nodes":[],"edges":[]}"#).unwrap();
    let (ra, rb, rboard) = (
        relative_to_cwd(&a),
        relative_to_cwd(&b),
        relative_to_cwd(&board),
    );
    assert!(ra.is_relative());
    let resp = mdopener_mcp::tool_diff_documents(id(1), &json!({ "path_a": ra, "path_b": rb }));
    assert_eq!(content_text(&resp)["hunks"], 1, "{resp:?}");
    let resp = mdopener_mcp::tool_export_text(id(1), &json!({ "path": ra }), &MockIpc::new());
    assert_eq!(
        content_text(&resp)["text"].as_str().map(str::trim),
        Some("x")
    );
    let resp = mdopener_mcp::tool_export_metadata(id(1), &json!({ "path": rb }), &MockIpc::new());
    assert_eq!(content_text(&resp)["word_count"], 1, "{resp:?}");
    let resp = mdopener_mcp::tool_edit_canvas(
        id(1),
        &json!({ "path": rboard, "save": false, "ops": [{ "type": "add_node", "node":
            { "id": "n", "type": "text", "text": "t", "x": 0, "y": 0, "width": 9, "height": 9 } }] }),
    );
    assert!(!is_error(&resp), "{resp:?}");
    let canon_a = std::fs::canonicalize(&a).unwrap();
    let ipc = MockIpc::new().on_post("/present", Ok(json!({ "ok": true })));
    let _ = tool_present_document(id(1), &json!({ "path": ra }), &ipc);
    assert_eq!(ipc.calls()[0].2.as_ref().unwrap()["path"], json!(canon_a));
    let ipc = MockIpc::new().on_get("/annotations", Ok(json!({ "tasks": [] })));
    let _ = tool_get_annotations(id(1), &json!({ "path": ra }), &ipc);
    let want = urlencoding::encode(canon_a.to_str().unwrap()).into_owned();
    assert_eq!(ipc.calls()[0].1, format!("/annotations?path={want}"));
}

/// request_review's description said it blocks "until they Approve or
/// Request changes", but one call waits at most `wait_ms` and then returns
/// pending; an agent that read only the description took that for a failure.
#[test]
fn request_review_description_says_a_call_can_return_pending() {
    let def = tool_registry()
        .into_iter()
        .find(|d| d.name == "request_review")
        .unwrap();
    let d = def.description;
    for want in [
        "{ verdict, reviewId, comments }",
        "at most `wait_ms`",
        "{ status: 'pending', reviewId }",
        "`review_id`",
        "dismissed",
        "timeout",
        "superseded",
    ] {
        assert!(d.contains(want), "missing {want:?}: {d}");
    }
    // The default it names is the one the tool uses.
    assert!(
        d.contains(&format!(
            "default {} ms",
            mdopener_mcp::DEFAULT_REVIEW_WAIT_MS
        )),
        "{d}"
    );
}

/// list_recent, get_user_annotations and present_document described what
/// they do but not what they return, so an agent learned the field names
/// (and that `verdict` is null with no review) by calling them.
#[test]
fn tool_descriptions_name_their_result_shapes() {
    let desc = |name: &str| {
        tool_registry()
            .into_iter()
            .find(|d| d.name == name)
            .unwrap()
            .description
    };
    for (tool, wants) in [
        (
            "list_recent",
            &["[{ path, fileName, openedAt }]", "most recent first"][..],
        ),
        (
            "get_user_annotations",
            &[
                "{ path, verdict, comments, late, tasks: [{ text, checked }], tasksNote?, appRunning?, appAuthFailed?, note? }",
                "null when no review",
            ][..],
        ),
        (
            "present_document",
            &["{ ok, path }", "not a dotfile", "does not exist is refused"][..],
        ),
    ] {
        let d = desc(tool);
        for want in wants {
            assert!(d.contains(want), "{tool} missing {want:?}: {d}");
        }
    }
}

/// set_content, replace_document, edit_document and stream_edit_apply said
/// what they change but not what comes back or when they are refused, so an
/// agent learned `{ ok: true }`, `replaced` and `matchIndex`, and that a
/// failed save leaves the change applied, by calling them. Each named shape
/// is the reply the app's IPC sends (`set_content_reply`, `handle_edit`,
/// `handle_stream_edit_apply`), passed through unchanged, and a refusal is a
/// tool error carrying the app's reason.
#[test]
fn edit_tool_descriptions_name_their_results_and_refusals() {
    let desc = |name: &str| {
        tool_registry()
            .into_iter()
            .find(|d| d.name == name)
            .unwrap()
            .description
    };
    let busy = "two edits are already waiting on the app";
    let cases = [
        (
            "set_content",
            &["{ ok: true }", "no document is open", "4 s", busy, "replaced but not saved"][..],
            "/content",
            json!({ "content": "# New\n" }),
            json!({ "ok": true }),
            "No document is open in Ashlr MD; open one first (open_file).",
        ),
        (
            "replace_document",
            &["{ ok: true }", "no document is open", "4 s", busy, "replaced but not saved"][..],
            "/content",
            json!({ "content": "# New\n", "save": true }),
            json!({ "ok": true }),
            "Content replaced in the open document but not saved: the write failed",
        ),
        (
            "edit_document",
            &[
                "{ ok: true, replaced: 1 }",
                "not found",
                "not unique (the error gives the match count)",
                "not the open document",
                busy,
                "applied but not saved",
            ][..],
            "/edit",
            json!({ "find": "a", "replace": "b" }),
            json!({ "ok": true, "replaced": 1 }),
            "`find` string is not unique (2 matches): include more surrounding context to disambiguate.",
        ),
        (
            "stream_edit_apply",
            &[
                "{ ok: true, replaced: 1, matchIndex }",
                "no longer in the live document",
                "past its last occurrence",
                "not the open document",
                busy,
                "applied but not saved",
            ][..],
            "/stream-edit-apply",
            json!({ "find": "a", "replace": "b", "match_index": 1 }),
            json!({ "ok": true, "replaced": 1, "matchIndex": 1 }),
            "matchIndex 3 out of bounds: document has 2 occurrence(s).",
        ),
    ];
    for (tool, wants, route, args, reply, refusal) in cases {
        let d = desc(tool);
        for want in wants {
            assert!(d.contains(want), "{tool} missing {want:?}: {d}");
        }
        let ipc = MockIpc::new().on_post(route, Ok(reply.clone()));
        let resp = call(tool, args.clone(), &ipc);
        assert!(!is_error(&resp), "{tool}: {resp:?}");
        assert_eq!(content_text(&resp), reply, "{tool}");
        let ipc = MockIpc::new().on_post(route, Ok(json!({ "ok": false, "error": refusal })));
        let resp = call(tool, args, &ipc);
        assert_eq!(tool_error_text(&resp), refusal, "{tool}");
    }
}

/// set_content and replace_document promised that "a document with no file
/// yet" would come back "replaced but not saved". The window refuses any
/// document without a file as "No document is open" before it applies
/// anything (the app opens only files: with none, it shows its welcome
/// screen), so that result never came. The descriptions now say what does.
#[test]
fn whole_document_tools_do_not_promise_an_unsaved_document() {
    for tool in ["set_content", "replace_document"] {
        let d = tool_registry()
            .into_iter()
            .find(|d| d.name == tool)
            .unwrap()
            .description;
        assert!(!d.contains("no file yet"), "{tool}: {d}");
        for want in [
            "No document is open in Ashlr MD; open one first (open_file).",
            "every document it shows has one",
            "a failed save is an error saying the content was replaced but not saved",
        ] {
            assert!(d.contains(want), "{tool} missing {want:?}: {d}");
        }
    }
}

/// edit_document and stream_edit_apply promised, as set_content did, that
/// "a document with no file yet" would come back "applied but not saved".
/// The app opens only files, and the window refuses any state with no file
/// as "No document is open" before it applies anything. stream_edit said
/// "unsaved" for an edit not written to disk.
#[test]
fn find_replace_tools_do_not_promise_an_unsaved_document() {
    let desc = |tool: &str| {
        tool_registry()
            .into_iter()
            .find(|d| d.name == tool)
            .unwrap()
            .description
    };
    for tool in ["edit_document", "stream_edit_apply"] {
        let d = desc(tool);
        assert!(!d.contains("no file yet"), "{tool}: {d}");
        for want in [
            "No document is open in Ashlr MD; open one first (open_file).",
            "every document it shows has one",
            "a failed save is an error saying the edit was applied but not saved",
        ] {
            assert!(d.contains(want), "{tool} missing {want:?}: {d}");
        }
    }
    let d = desc("stream_edit");
    assert!(!d.contains("unsaved"), "{d}");
    assert!(d.contains("not written to disk"), "{d}");
}

/// get_current_content said "`path` is null for an unsaved document", and
/// export_text and export_metadata that `path` is "absent for an unsaved
/// open document". The app opens only files, so it has no unsaved document:
/// it answers `path: null` only on its welcome screen, which is an error.
#[test]
fn reading_tools_say_what_a_null_path_means() {
    let desc = |tool: &str| {
        tool_registry()
            .into_iter()
            .find(|d| d.name == tool)
            .unwrap()
            .description
    };
    for tool in ["get_current_content", "export_text", "export_metadata"] {
        let d = desc(tool);
        assert!(!d.contains("unsaved"), "{tool}: {d}");
    }
    // What they say instead is pinned by
    // get_current_content_description_says_what_null_path_and_no_document_mean
    // and export_text_and_metadata_descriptions_name_their_fields.
}

/// stream_edit's description said it returns diffs but not the fields, and
/// docs/AGENTS.md said "the app's diff preview". The named shape is the
/// reply the app's `/stream-edit` sends, with the tool's own `applied`.
#[test]
fn stream_edit_description_names_its_result_and_refusals() {
    let d = tool_registry()
        .into_iter()
        .find(|d| d.name == "stream_edit")
        .unwrap()
        .description;
    for want in [
        "{ ok, editId, diff, candidates, matchCount, applied }",
        "[{ matchIndex, startLine, diff, rank }]",
        "null for a single match",
        "`find` is not found",
        "not the open",
        "not unique",
        "two edits are already waiting on the app",
    ] {
        assert!(d.contains(want), "missing {want:?}: {d}");
    }
    let candidate =
        |i: u32| json!({ "matchIndex": i, "startLine": i + 1, "diff": "@@", "rank": i + 1 });
    let reply = json!({
        "ok": true,
        "editId": "stream_1",
        "diff": "@@",
        "candidates": [candidate(0), candidate(1)],
        "matchCount": 2,
    });
    let ipc = MockIpc::new().on_post("/stream-edit", Ok(reply.clone()));
    let v = content_text(&call(
        "stream_edit",
        json!({ "find": "a", "replace": "b" }),
        &ipc,
    ));
    let mut want = reply;
    want["applied"] = json!(false);
    assert_eq!(v, want);
    let refusal = "`find` string not found in the document.";
    let ipc = MockIpc::new().on_post("/stream-edit", Ok(json!({ "ok": false, "error": refusal })));
    let resp = call("stream_edit", json!({ "find": "a", "replace": "b" }), &ipc);
    assert_eq!(tool_error_text(&resp), refusal);
}

/// stream_edit's description said "Prefer this over edit_document for large
/// files", but neither tool sends the document: both post only `find` and
/// `replace`, and stream_edit with `path` even fetches the whole document
/// to compare paths. The advice now gives the real reason, the preview.
#[test]
fn stream_edit_is_not_preferred_for_large_files() {
    let d = tool_registry()
        .into_iter()
        .find(|d| d.name == "stream_edit")
        .unwrap()
        .description;
    assert!(!d.contains("for large files or"), "{d}");
    assert!(
        d.contains("only to see the change before committing it (edit_document applies at once)"),
        "{d}"
    );
    assert!(d.contains("not for large files"), "{d}");
    let big = "x".repeat(1 << 20);
    let doc = json!({ "path": "/notes/big.md", "content": big });
    let reply =
        json!({ "ok": true, "editId": "s", "diff": "@@", "candidates": null, "matchCount": 1 });
    // Without `path`, each tool posts `find` and `replace` and reads nothing.
    for tool in ["edit_document", "stream_edit"] {
        let ipc = MockIpc::new()
            .on_get("/content", Ok(doc.clone()))
            .on_post("/edit", Ok(json!({ "ok": true, "replaced": 1 })))
            .on_post("/stream-edit", Ok(reply.clone()));
        let resp = call(tool, json!({ "find": "x", "replace": "y" }), &ipc);
        assert!(!is_error(&resp), "{tool}: {resp:?}");
        let calls = ipc.calls();
        assert_eq!(calls.len(), 1, "{tool}: {calls:?}");
        let body = calls[0].2.as_ref().unwrap().to_string();
        assert!(body.len() < 200, "{tool} sent {} bytes", body.len());
    }
    // With `path`, stream_edit asks the app for the open path alone (it
    // used to fetch the whole document); edit_document sends the path for
    // the app to check.
    let ipc = MockIpc::new()
        .on_get("/content", Ok(doc.clone()))
        .on_post("/edit", Ok(json!({ "ok": true, "replaced": 1 })));
    call(
        "edit_document",
        json!({ "find": "x", "replace": "y", "path": "/notes/big.md" }),
        &ipc,
    );
    assert!(
        ipc.calls().iter().all(|c| c.0 == "POST"),
        "edit_document with path reads nothing"
    );
    let ipc = MockIpc::new()
        .on_get("/content", Ok(doc))
        .on_post("/stream-edit", Ok(reply));
    call(
        "stream_edit",
        json!({ "find": "x", "replace": "y", "path": "/notes/big.md" }),
        &ipc,
    );
    let gets: Vec<String> = ipc
        .calls()
        .into_iter()
        .filter(|c| c.0 == "GET")
        .map(|c| c.1)
        .collect();
    assert_eq!(
        gets,
        ["/content/path"],
        "stream_edit with path reads only the path"
    );
    assert!(d.contains("not its content"), "{d}");
}

/// A refusal from the window carries its `matchCount`, which the app's
/// `/stream-edit` reply used to drop and the tool did not pass on. It sits
/// beside `content` and `isError`, so the error text and shape are as they
/// were; an app that sends no count adds no field.
#[test]
fn stream_edit_refusal_carries_the_match_count() {
    let d = tool_registry()
        .into_iter()
        .find(|d| d.name == "stream_edit")
        .unwrap()
        .description;
    assert!(
        d.contains("also has `matchCount` beside `content` and `isError`"),
        "{d}"
    );
    let refusal =
        "`find` string is not unique (3 matches): include more surrounding context to disambiguate.";
    let ipc = MockIpc::new().on_post(
        "/stream-edit",
        Ok(json!({ "ok": false, "error": refusal, "matchCount": 3 })),
    );
    let resp = call(
        "stream_edit",
        json!({ "find": "a", "replace": "b", "preview": false }),
        &ipc,
    );
    assert_eq!(tool_error_text(&resp), refusal);
    let r = resp.result.as_ref().unwrap();
    assert_eq!(r["matchCount"], 3, "{r}");
    assert_eq!(r["content"], json!([{ "type": "text", "text": refusal }]));
    assert_eq!(r["isError"], true);
    let ipc = MockIpc::new().on_post("/stream-edit", Ok(json!({ "ok": false, "error": refusal })));
    let resp = call("stream_edit", json!({ "find": "a", "replace": "b" }), &ipc);
    let r = resp.result.as_ref().unwrap();
    assert_eq!(
        r,
        &json!({ "content": [{ "type": "text", "text": refusal }], "isError": true })
    );
}

/// A stream_edit refusal that did not search (no document open, a `path`
/// that is not the open document, an exception in the window) used to carry
/// a made-up `matchCount: 0`, and the description said so. Now the app sends
/// no count for them and the tool adds no field, while a real search that
/// found nothing keeps its `0`.
#[test]
fn stream_edit_refusal_without_a_search_has_no_match_count() {
    let d = tool_registry()
        .into_iter()
        .find(|d| d.name == "stream_edit")
        .unwrap()
        .description;
    assert!(!d.contains("or when it did not search"), "{d}");
    assert!(d.contains("did not search, and have none"), "{d}");
    let missing = "`find` string not found in the document.";
    let ipc = MockIpc::new().on_post(
        "/stream-edit",
        Ok(json!({ "ok": false, "error": missing, "matchCount": 0 })),
    );
    let resp = call("stream_edit", json!({ "find": "a", "replace": "b" }), &ipc);
    assert_eq!(resp.result.as_ref().unwrap()["matchCount"], 0);
    let none = "No document is open in Ashlr MD; open one first (open_file).";
    for reply in [
        json!({ "ok": false, "error": none }),
        json!({ "ok": false, "error": none, "matchCount": null }),
    ] {
        let ipc = MockIpc::new().on_post("/stream-edit", Ok(reply));
        let resp = call("stream_edit", json!({ "find": "a", "replace": "b" }), &ipc);
        let r = resp.result.as_ref().unwrap();
        assert!(r.get("matchCount").is_none(), "{r}");
        assert_eq!(tool_error_text(&resp), none);
    }
}

/// The edit descriptions listed "the window does not answer within 4 s"
/// among the refusals that leave the document unchanged, but the app's
/// timeout error says the window may still apply the edit (or content) and
/// to check with get_current_content. Each says that now; a stream_edit
/// preview applies nothing, so its timeout stays a refusal.
#[test]
fn edit_descriptions_say_a_late_window_may_still_apply() {
    for tool in [
        "set_content",
        "replace_document",
        "edit_document",
        "stream_edit",
        "stream_edit_apply",
    ] {
        let d = tool_registry()
            .into_iter()
            .find(|d| d.name == tool)
            .unwrap()
            .description;
        assert!(
            d.contains("does not answer within 4 s is an error too, but it may still apply"),
            "{tool}: {d}"
        );
        assert!(
            d.contains("call get_current_content to see whether it did before retrying"),
            "{tool}: {d}"
        );
        assert!(
            !d.contains("when the window does not answer within 4 s"),
            "{tool}: {d}"
        );
    }
}

/// A stream_edit_apply refusal from the window's search carries its
/// `matchCount` beside `content` and `isError`, which the tool did not pass
/// on; a refusal without one (it did not search, or an older app) adds no
/// field, so the result is as it was.
#[test]
fn stream_edit_apply_refusal_carries_the_match_count_when_sent() {
    let d = tool_registry()
        .into_iter()
        .find(|d| d.name == "stream_edit_apply")
        .unwrap()
        .description;
    assert!(
        d.contains("also has `matchCount` beside `content` and `isError`"),
        "{d}"
    );
    assert!(
        d.contains("The other refusals did not search, and have none."),
        "{d}"
    );
    let refusal = "matchIndex 5 out of bounds: document has 2 occurrence(s). Use a match_index \
                   from 0 to 1, or call stream_edit again to see the candidates.";
    let ipc = MockIpc::new().on_post(
        "/stream-edit-apply",
        Ok(json!({ "ok": false, "error": refusal, "matchCount": 2 })),
    );
    let args = json!({ "find": "a", "replace": "b", "match_index": 5 });
    let resp = call("stream_edit_apply", args.clone(), &ipc);
    let r = resp.result.as_ref().unwrap();
    assert_eq!(
        r,
        &json!({ "content": [{ "type": "text", "text": refusal }], "isError": true, "matchCount": 2 })
    );
    let ipc = MockIpc::new().on_post(
        "/stream-edit-apply",
        Ok(json!({ "ok": false, "error": refusal })),
    );
    let resp = call("stream_edit_apply", args, &ipc);
    let r = resp.result.as_ref().unwrap();
    assert_eq!(
        r,
        &json!({ "content": [{ "type": "text", "text": refusal }], "isError": true })
    );
}

/// export's description said when the call returns but not what it
/// returns, though docs/AGENTS.md gave both shapes. The named shapes are the
/// tool's own results, for a written file and for the dialog.
#[test]
fn export_description_names_its_results() {
    let d = tool_registry()
        .into_iter()
        .find(|d| d.name == "export")
        .unwrap()
        .description;
    for want in [
        "{ ok, format, path, bytes }",
        "{ ok, format, dialog: true }",
        "30 s",
        "second headless export",
    ] {
        assert!(d.contains(want), "missing {want:?}: {d}");
    }
    let ipc = MockIpc::new().on_post("/export", Ok(json!({ "ok": true })));
    let v = content_text(&tool_export(id(1), &json!({ "format": "docx" }), &ipc));
    assert_eq!(v, json!({ "ok": true, "format": "docx", "dialog": true }));
    let dir = tempfile::tempdir().unwrap();
    let out = std::fs::canonicalize(dir.path()).unwrap().join("plan.html");
    let resp = tool_export_with(
        id(1),
        &json!({ "format": "html", "output_path": out.to_string_lossy() }),
        &exporting_app(true),
        SHORT,
    );
    let v = content_text(&resp);
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["bytes", "format", "ok", "path"], "{v}");
}

/// export_text and export_metadata listed what they extract but not the
/// field names, so an agent learned `word_count` and `embedded_image_count`
/// by calling them. Each named field is one the tool returns, and no other.
#[test]
fn export_text_and_metadata_descriptions_name_their_fields() {
    let desc = |name: &str| {
        tool_registry()
            .into_iter()
            .find(|d| d.name == name)
            .unwrap()
            .description
    };
    let dir = tempfile::tempdir().unwrap();
    let doc = dir.path().join("plan.md");
    std::fs::write(&doc, "---\ntitle: T\n---\n# Plan\n\nSee [[B]] and [[A]].\n").unwrap();
    let args = json!({ "path": doc.to_string_lossy() });
    for (tool, shape, keys) in [
        (
            "export_text",
            "{ text, word_count, char_count, path }",
            &["char_count", "path", "text", "word_count"][..],
        ),
        (
            "export_metadata",
            "{ frontmatter, headings: [{ level, text }], wikilinks, embedded_image_count, word_count, path }",
            &["embedded_image_count", "frontmatter", "headings", "path", "wikilinks", "word_count"][..],
        ),
    ] {
        let d = desc(tool);
        assert!(d.contains(shape), "{tool} missing {shape:?}: {d}");
        assert!(d.contains("with `path` omitted, the open document's file"), "{tool}: {d}");
        let v = content_text(&call(tool, args.clone(), &MockIpc::new()));
        let mut got: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        got.sort_unstable();
        assert_eq!(got, keys, "{tool}: {v}");
        if tool == "export_metadata" {
            assert_eq!(v["headings"], json!([{ "level": 1, "text": "Plan" }]));
            assert_eq!(v["wikilinks"], json!(["A", "B"]));
        }
    }
    // Without `path`, the result names the open document's file.
    for tool in ["export_text", "export_metadata"] {
        let ipc = MockIpc::new().on_get(
            "/content",
            Ok(json!({ "path": "/docs/draft.md", "content": "# Draft\n" })),
        );
        let v = content_text(&call(tool, json!({}), &ipc));
        assert_eq!(v["path"], "/docs/draft.md", "{tool}: {v}");
    }
}

/// get_conversation_context and save_conversation_message said what they
/// recover or store but not what they return, so an agent learned
/// `messageId`, `timestampMs` and each message's fields by calling them.
/// The named fields are exactly the ones the tools return.
#[test]
fn conversation_tool_descriptions_name_their_results() {
    let session = unique_session();
    let desc = |name: &str| {
        tool_registry()
            .into_iter()
            .find(|d| d.name == name)
            .unwrap()
            .description
    };
    let keys = |v: &Value| {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort_unstable();
        k
    };
    let d = desc("save_conversation_message");
    assert!(
        d.contains("{ ok, messageId, sessionId, role, timestampMs, dropped?, note? }"),
        "{d}"
    );
    let ipc = MockIpc::new();
    let saved = content_text(&call(
        "save_conversation_message",
        json!({ "session_id": session, "role": "agent", "content": "did it" }),
        &ipc,
    ));
    assert_eq!(
        keys(&saved),
        ["messageId", "ok", "role", "sessionId", "timestampMs"]
    );
    let d = desc("get_conversation_context");
    assert!(
        d.contains(
            "{ sessionId, messages: [{ id, sessionId, role, content, citedDocs, timestampMs }], count, recentDocs }"
        ),
        "{d}"
    );
    let got = content_text(&call(
        "get_conversation_context",
        json!({ "session_id": session }),
        &ipc,
    ));
    assert_eq!(keys(&got), ["count", "messages", "recentDocs", "sessionId"]);
    assert_eq!(
        keys(&got["messages"][0]),
        [
            "citedDocs",
            "content",
            "id",
            "role",
            "sessionId",
            "timestampMs"
        ]
    );
}

/// list_ai_actions' description said each entry has "the action id, label,
/// icon, scope, and the system+user prompt templates" but not the result's
/// shape or the field names, so an agent learned `shortLabel`,
/// `systemPrompt` and `userPromptTemplate` by calling it. The named fields
/// are exactly the ones the actions carry.
#[test]
fn list_ai_actions_description_names_its_result() {
    let d = tool_registry()
        .into_iter()
        .find(|d| d.name == "list_ai_actions")
        .unwrap()
        .description;
    assert!(
        d.contains(
            "{ actions: [{ id, label, shortLabel, icon, scope, systemPrompt, userPromptTemplate, argument? }], count }"
        ),
        "{d}"
    );
    let keys_of = |include: bool| {
        let resp = tool_list_ai_actions(id(1), &json!({ "include_prompts": include }));
        let body = content_text(&resp);
        let mut top: Vec<String> = body.as_object().unwrap().keys().cloned().collect();
        top.sort_unstable();
        assert_eq!(top, ["actions", "count"]);
        let mut all = std::collections::BTreeSet::new();
        for a in body["actions"].as_array().unwrap() {
            all.extend(a.as_object().unwrap().keys().cloned());
        }
        all.into_iter().collect::<Vec<_>>()
    };
    assert_eq!(
        keys_of(true),
        [
            "argument",
            "icon",
            "id",
            "label",
            "scope",
            "shortLabel",
            "systemPrompt",
            "userPromptTemplate"
        ]
    );
    assert_eq!(
        keys_of(false),
        ["argument", "icon", "id", "label", "scope", "shortLabel"]
    );
}

/// get_current_content's description said its nothing-open error matched
/// export_text's, but export_text (and export_metadata) say to pass `path`,
/// which get_current_content does not take. The description now quotes
/// each message, and the messages are the ones the tools give.
#[test]
fn get_current_content_description_quotes_each_nothing_open_message() {
    let d = tool_registry()
        .into_iter()
        .find(|d| d.name == "get_current_content")
        .unwrap()
        .description;
    let none_open =
        || MockIpc::new().on_get("/content", Ok(json!({ "path": null, "content": "" })));
    let own = tool_error_text(&call("get_current_content", json!({}), &none_open()));
    assert_eq!(
        own,
        "No document is open in Ashlr MD. Open one first (open_file)."
    );
    assert!(d.contains(&format!("\"{own}\"")), "{d}");
    for tool in ["export_text", "export_metadata"] {
        let msg = tool_error_text(&call(tool, json!({}), &none_open()));
        assert_eq!(
            msg, "No document is open in Ashlr MD; pass `path` to read a file.",
            "{tool}"
        );
        assert!(d.contains(&format!("\"{msg}\"")), "{d}");
        assert!(d.contains(tool), "{d}");
    }
    let resp = handle_resource_read(id(1), "mdopener://current", &none_open());
    assert_eq!(resp.error.as_ref().unwrap().message, own);
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

/// `edit_document.find` and `get_user_annotations.path` were refused when
/// empty by the tools but declared no `minLength`, so a client validating
/// against the schema sent them anyway. Every required string a tool refuses
/// when empty now declares `minLength: 1`, and the rest are listed here as
/// strings an empty value is meaningful for (or that are refused in their own
/// words by the tool).
///
/// An empty path (`open_file`, `present_document`, `diff_documents`,
/// `export_text`, `export_metadata`, `request_review`) or `search_vault.vault`
/// reached the file checks and came back as "only Markdown documents can be
/// read" or "No such file or directory". Those declare `minLength: 1` too,
/// and the tools refuse an empty value themselves with "must not be empty".
/// So does `request_review.content`, which used to register a review of no
/// text when no path was given.
///
/// The optional `path` of `edit_document`, `stream_edit` and
/// `stream_edit_apply` reached the app when empty and came back as "not the
/// open document", and `export.output_path` as "cannot make an empty path
/// absolute". They are refused the same way (omitting them stays allowed),
/// and every `path` or `*_path` string argument must be on the list.
#[test]
fn required_strings_refused_when_empty_declare_min_length() {
    let must = [
        ("get_user_annotations", "path"),
        ("edit_document", "find"),
        ("search_vault", "query"),
        ("stream_edit", "find"),
        ("stream_edit_apply", "find"),
        ("edit_canvas", "path"),
        ("get_conversation_context", "session_id"),
        ("save_conversation_message", "session_id"),
        ("save_conversation_message", "content"),
        ("open_file", "path"),
        ("present_document", "path"),
        ("diff_documents", "path_a"),
        ("diff_documents", "path_b"),
        ("export_text", "path"),
        ("export_metadata", "path"),
        ("request_review", "path"),
        ("request_review", "content"),
        ("search_vault", "vault"),
        ("edit_document", "path"),
        ("stream_edit", "path"),
        ("stream_edit_apply", "path"),
        ("export", "output_path"),
    ];
    // Empty is a real value: replacing with nothing, an empty document.
    // A path or format is checked by the tool (or the enum) in its own words.
    let may_be_empty = [
        ("set_content", "content"),
        ("export", "format"),
        ("edit_document", "replace"),
        ("replace_document", "content"),
        ("save_conversation_message", "role"),
        ("stream_edit", "replace"),
        ("stream_edit_apply", "replace"),
    ];
    let mut found = 0;
    for def in tool_registry() {
        let props = def.input_schema["properties"].as_object().unwrap();
        let required: Vec<&str> = def.input_schema["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        for (k, prop) in props {
            let pair = (def.name, k.as_str());
            if must.contains(&pair) {
                found += 1;
                assert_eq!(prop["minLength"], 1, "{}.{k} needs minLength 1", def.name);
                let mut args = serde_json::Map::new();
                for r in &required {
                    args.insert(r.to_string(), json!("x"));
                }
                if def.name == "edit_canvas" {
                    args.insert("ops".into(), json!([{ "type": "delete_node", "id": "n" }]));
                }
                if def.name == "save_conversation_message" {
                    args.insert("role".into(), json!("agent"));
                }
                if def.name == "export" {
                    args.insert("format".into(), json!("html"));
                }
                args.insert(k.clone(), json!(""));
                let msg = param_error(&call_tool(def.name, Value::Object(args)));
                assert_eq!(
                    msg,
                    format!("`{k}` must be at least 1 character long, got \"\""),
                    "{}.{k}",
                    def.name
                );
            } else if prop["type"] == "string" && (k == "path" || k.ends_with("_path")) {
                panic!(
                    "{}.{k} is a path: refuse it when empty and list it",
                    def.name
                );
            } else if prop["type"] == "string" && required.contains(&k.as_str()) {
                assert!(
                    may_be_empty.contains(&pair),
                    "{}.{k} is a required string: declare minLength or list it",
                    def.name
                );
            }
        }
    }
    assert_eq!(
        found,
        must.len(),
        "a listed argument is missing from the registry"
    );

    // Called directly, past the schema check, the tools refuse an empty
    // path themselves rather than reporting a file error.
    let ipc = MockIpc::new();
    let direct: [(&str, mdopener_mcp::Response); 13] = [
        ("path", tool_open_file(id(1), &json!({ "path": "" }), &ipc)),
        (
            "path",
            tool_present_document(id(1), &json!({ "path": "" }), &ipc),
        ),
        (
            "path_a",
            mdopener_mcp::tool_diff_documents(id(1), &json!({ "path_a": "", "path_b": "b.md" })),
        ),
        (
            "path_b",
            mdopener_mcp::tool_diff_documents(id(1), &json!({ "path_a": "a.md", "path_b": "" })),
        ),
        (
            "path",
            mdopener_mcp::tool_export_text(id(1), &json!({ "path": "" }), &ipc),
        ),
        (
            "path",
            mdopener_mcp::tool_export_metadata(id(1), &json!({ "path": "" }), &ipc),
        ),
        (
            "path",
            mdopener_mcp::tool_request_review(
                id(1),
                &json!({ "path": "", "blocking": false }),
                &ipc,
            ),
        ),
        (
            "content",
            mdopener_mcp::tool_request_review(
                id(1),
                &json!({ "content": "", "blocking": false }),
                &ipc,
            ),
        ),
        (
            "vault",
            mdopener_mcp::tool_search_vault(id(1), &json!({ "query": "x", "vault": "" }), &ipc),
        ),
        (
            "path",
            mdopener_mcp::tool_edit_document(
                id(1),
                &json!({ "find": "a", "replace": "b", "path": "" }),
                &ipc,
            ),
        ),
        (
            "path",
            mdopener_mcp::tool_stream_edit(
                id(1),
                &json!({ "find": "a", "replace": "b", "path": "" }),
                &ipc,
            ),
        ),
        (
            "path",
            mdopener_mcp::tool_stream_edit_apply(
                id(1),
                &json!({ "find": "a", "replace": "b", "path": "" }),
                &ipc,
            ),
        ),
        (
            "output_path",
            mdopener_mcp::tool_export(id(1), &json!({ "format": "html", "output_path": "" }), &ipc),
        ),
    ];
    for (k, resp) in direct {
        assert_eq!(
            param_error(&resp),
            format!("`{k}` must not be empty"),
            "{resp:?}"
        );
    }
    assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
}

/// A path, id or name of only whitespace names nothing, as an empty one
/// does. It passed the `minLength: 1` check and the tools' empty checks, and
/// reached the file checks ("only Markdown documents can be read", "node
/// `` not found") or the app. It is refused with `-32602` saying the field
/// must not be empty, before anything is read or sent; whitespace in text
/// arguments (`find`, `replace`) is still content.
#[test]
fn blank_path_arguments_are_refused_like_empty_ones() {
    for blank in [" ", "  \t\n"] {
        let calls: [(&str, &str, Value); 15] = [
            ("open_file", "path", json!({ "path": blank })),
            ("present_document", "path", json!({ "path": blank })),
            (
                "diff_documents",
                "path_a",
                json!({ "path_a": blank, "path_b": "b.md" }),
            ),
            (
                "diff_documents",
                "path_b",
                json!({ "path_a": "a.md", "path_b": blank }),
            ),
            ("export_text", "path", json!({ "path": blank })),
            ("export_metadata", "path", json!({ "path": blank })),
            (
                "request_review",
                "path",
                json!({ "path": blank, "blocking": false }),
            ),
            (
                "search_vault",
                "vault",
                json!({ "query": "x", "vault": blank }),
            ),
            (
                "edit_document",
                "path",
                json!({ "find": "a", "replace": "b", "path": blank }),
            ),
            (
                "stream_edit",
                "path",
                json!({ "find": "a", "replace": "b", "path": blank }),
            ),
            (
                "stream_edit_apply",
                "path",
                json!({ "find": "a", "replace": "b", "path": blank }),
            ),
            (
                "export",
                "output_path",
                json!({ "format": "html", "output_path": blank }),
            ),
            ("get_user_annotations", "path", json!({ "path": blank })),
            (
                "edit_canvas",
                "path",
                json!({ "path": blank, "ops": [{ "type": "delete_node", "id": "n" }] }),
            ),
            (
                "request_review",
                "content",
                json!({ "content": blank, "blocking": false }),
            ),
        ];
        for (tool, field, args) in calls {
            assert_eq!(
                param_error(&call_tool(tool, args)),
                format!("`{field}` must not be empty"),
                "{tool}.{field} = {blank:?}"
            );
        }
    }
    // Whitespace is still valid text to find and to write.
    let ipc = MockIpc::new();
    let resp =
        mdopener_mcp::tool_edit_document(id(1), &json!({ "find": " ", "replace": " " }), &ipc);
    assert!(
        resp.error.as_ref().is_none_or(|e| e.code != -32602),
        "{resp:?}"
    );
}

/// An empty path in `cited_docs` used to be stored, and came back in
/// `recentDocs` (as its first entry when it was the latest citation). It is
/// refused by the schema check and by the tool, and nothing is saved.
#[test]
fn empty_cited_doc_is_refused() {
    use_temp_sessions_dir();
    let sess = format!("empty-cited-{}", unique_session());
    let args = json!({ "session_id": sess, "role": "agent", "content": "did x",
        "cited_docs": ["/a.md", ""] });
    let msg = param_error(&call_tool("save_conversation_message", args.clone()));
    assert_eq!(
        msg,
        "`cited_docs[1]` must be at least 1 character long, got \"\""
    );
    let resp = tool_save_conversation_message(json!(1), &args);
    assert_eq!(param_error(&resp), "`cited_docs[1]` must not be empty");
    let ctx = content_text(&tool_get_conversation_context(
        json!(1),
        &json!({ "session_id": sess }),
    ));
    assert_eq!(ctx["count"], 0, "{ctx}");
    // A list of real paths is still saved.
    let ok = tool_save_conversation_message(
        json!(1),
        &json!({ "session_id": sess, "role": "agent", "content": "did x",
            "cited_docs": ["/a.md"] }),
    );
    assert!(!is_error(&ok), "{ok:?}");
    // A blank path names no document either, and is refused the same way.
    let resp = tool_save_conversation_message(
        json!(1),
        &json!({ "session_id": sess, "role": "agent", "content": "did y",
            "cited_docs": ["/a.md", "  "] }),
    );
    assert_eq!(param_error(&resp), "`cited_docs[1]` must not be empty");
    let ctx = content_text(&tool_get_conversation_context(
        json!(1),
        &json!({ "session_id": sess }),
    ));
    assert_eq!(ctx["count"], 1, "{ctx}");
}

/// `cited_docs` is described as absolute paths, but a relative one was
/// stored as given and came back in `recentDocs` naming nothing an agent
/// could match against the open document. It is now resolved against the
/// server's working directory when saved; an absolute path is kept as given.
#[test]
fn relative_cited_docs_are_stored_absolute() {
    let sess = unique_session();
    let ok = tool_save_conversation_message(
        json!(1),
        &json!({ "session_id": sess, "role": "agent", "content": "did x",
            "cited_docs": ["notes/plan.md", "/abs/spec.md"] }),
    );
    assert!(!is_error(&ok), "{ok:?}");
    let cwd = std::env::current_dir().unwrap();
    let want = cwd.join("notes/plan.md").to_string_lossy().into_owned();
    let ctx = content_text(&tool_get_conversation_context(
        json!(1),
        &json!({ "session_id": sess }),
    ));
    assert_eq!(
        ctx["messages"][0]["citedDocs"],
        json!([want, "/abs/spec.md"])
    );
    assert_eq!(ctx["recentDocs"], json!([want, "/abs/spec.md"]));
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
            "`limit` must be at least 1, got -5",
        ),
        (
            "search_vault",
            json!({ "query": "q", "limit": -1 }),
            "`limit` must be at least 1, got -1",
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
            "`timeout_ms` must be at least 5000, got -1",
        ),
        (
            "request_review",
            json!({ "content": "x", "wait_ms": -1000 }),
            "`wait_ms` must be at least 1000, got -1000",
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
    // The minimum itself and the 32-bit maximum still pass.
    let def = tool_registry()
        .into_iter()
        .find(|t| t.name == "stream_edit_apply")
        .unwrap();
    for n in [json!(0), json!(u32::MAX)] {
        let args = json!({ "find": "a", "replace": "b", "match_index": n });
        assert!(mdopener_mcp::check_tool_arguments(&def, &args).is_ok());
    }
}

/// `stream_edit_apply`'s schema declared no `maximum` for `match_index`, so
/// a client checking it let 2^32 through and the tool answered only
/// "`match_index` is too large". The schema now declares the app's 32-bit
/// limit, the description says it, and both refusals give the bound.
#[test]
fn stream_edit_apply_match_index_declares_its_32_bit_maximum() {
    let def = tool_registry()
        .into_iter()
        .find(|t| t.name == "stream_edit_apply")
        .unwrap();
    let prop = &def.input_schema["properties"]["match_index"];
    assert_eq!(prop["maximum"], json!(u32::MAX));
    assert_eq!(
        mdopener_mcp::STREAM_EDIT_MAX_MATCH_INDEX,
        u64::from(u32::MAX)
    );
    let d = prop["description"].as_str().unwrap();
    assert!(d.contains("0 to 4294967295"), "{d}");
    let over = u64::from(u32::MAX) + 1;
    let want = format!("`match_index` must be at most 4294967295, got {over}");
    for n in [json!(over), json!(u64::MAX)] {
        let args = json!({ "find": "a", "replace": "b", "match_index": n });
        let ipc = MockIpc::new();
        let msg = param_error(&call("stream_edit_apply", args.clone(), &ipc));
        assert!(
            msg.starts_with("`match_index` must be at most 4294967295"),
            "{msg}"
        );
        assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
        // Called directly (past the schema check), the tool says the same.
        let ipc = MockIpc::new();
        let direct = mdopener_mcp::tool_stream_edit_apply(id(1), &args, &ipc);
        let msg = param_error(&direct);
        if n == json!(over) {
            assert_eq!(msg, want);
        }
        assert!(
            msg.starts_with("`match_index` must be at most 4294967295"),
            "{msg}"
        );
        assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
    }
    // The maximum itself reaches the app as that index.
    let ipc = MockIpc::new().on_post("/stream-edit-apply", Ok(json!({ "ok": true })));
    let resp = call(
        "stream_edit_apply",
        json!({ "find": "a", "replace": "b", "match_index": u32::MAX }),
        &ipc,
    );
    assert!(!is_error(&resp), "{resp:?}");
    let calls = ipc.calls();
    let (_, _, body) = calls
        .iter()
        .find(|(_, p, _)| p == "/stream-edit-apply")
        .unwrap();
    assert_eq!(body.as_ref().unwrap()["matchIndex"], json!(u32::MAX));
}

/// `request_review` refused an empty inline `content` but registered a
/// review of whitespace only, which the human could only approve or reject
/// blind. Blank content is refused the same way, before the app is asked.
#[test]
fn request_review_refuses_whitespace_only_content() {
    for blank in ["   ", "\n\t\n"] {
        let ipc = MockIpc::new();
        let resp = mdopener_mcp::tool_request_review(
            id(1),
            &json!({ "content": blank, "blocking": false }),
            &ipc,
        );
        assert_eq!(param_error(&resp), "`content` must not be empty");
        assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
    }
}

/// `request_review` clamped `wait_ms` to 1000 to 600000 in silence while its
/// schema said `minimum: 0`, so `wait_ms: 0` still blocked for a second. The
/// schema now declares the range the tool takes, for `timeout_ms` too, and
/// the tool refuses a value outside it before registering a review.
#[test]
fn request_review_wait_ms_outside_its_range_is_refused() {
    let def = tool_registry()
        .into_iter()
        .find(|t| t.name == "request_review")
        .unwrap();
    let props = &def.input_schema["properties"];
    assert_eq!(props["wait_ms"]["minimum"], 1000);
    assert_eq!(props["wait_ms"]["maximum"], 600_000);
    assert_eq!(props["timeout_ms"]["minimum"], 5000);
    assert_eq!(props["timeout_ms"]["maximum"], 600_000);
    assert!(param_error(&call_tool(
        "request_review",
        json!({ "content": "x", "wait_ms": 0 })
    ))
    .contains("`wait_ms` must be at least 1000, got 0"));
    assert!(param_error(&call_tool(
        "request_review",
        json!({ "content": "x", "wait_ms": 600_001 })
    ))
    .contains("`wait_ms` must be at most 600000, got 600001"));
    for bad in [json!(0), json!(999), json!(600_001), json!(1500.5)] {
        let ipc = MockIpc::new();
        let resp = tool_request_review(id(1), &json!({ "content": "x", "wait_ms": bad }), &ipc);
        let msg = param_error(&resp);
        assert!(
            msg.starts_with(
                "`wait_ms` must be a whole number of milliseconds between 1000 and 600000"
            ),
            "{bad}: {msg}"
        );
        assert!(ipc.calls().is_empty(), "{bad}: no review registered");
    }
    for ok in [json!(1000), json!(600_000)] {
        let args = json!({ "content": "x", "wait_ms": ok });
        assert!(
            mdopener_mcp::check_tool_arguments(&def, &args).is_ok(),
            "{ok}"
        );
    }
}

/// `get_conversation_context` clamped a `limit` above 200 in silence while
/// `list_recent` refused one. Both now refuse a value outside 1 to 200, in
/// the schema (`maximum`) and in the tool itself.
#[test]
fn conversation_limit_outside_1_to_200_is_refused_like_list_recent() {
    use_temp_sessions_dir();
    let def = tool_registry()
        .into_iter()
        .find(|t| t.name == "get_conversation_context")
        .unwrap();
    assert_eq!(def.input_schema["properties"]["limit"]["maximum"], 200);
    let msg = param_error(&call_tool(
        "get_conversation_context",
        json!({ "session_id": "s", "limit": 201 }),
    ));
    assert_eq!(msg, "`limit` must be at most 200, got 201");
    let session = unique_session();
    for bad in [json!(0), json!(201), json!(1_000_000), json!(2.5)] {
        let resp =
            tool_get_conversation_context(id(1), &json!({ "session_id": session, "limit": bad }));
        assert_eq!(
            param_error(&resp),
            format!("`limit` must be a whole number from 1 to 200, got {bad}; omit it for the default of 20"),
        );
    }
    for ok in [json!(1), json!(200), json!(20.0)] {
        let resp =
            tool_get_conversation_context(id(1), &json!({ "session_id": session, "limit": ok }));
        assert!(!is_error(&resp) && resp.error.is_none(), "{ok}: {resp:?}");
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

/// prompts/list described each prompt's task but not that it takes no
/// arguments or that it needs an open document, so an agent learned both
/// from an error (docs/AGENTS.md said so). Each description now says it,
/// with the codes prompts/get gives.
#[test]
fn prompts_list_says_prompts_take_no_arguments_and_need_an_open_document() {
    let prompts = mdopener_mcp::prompts_list();
    let prompts = prompts.as_array().unwrap();
    assert_eq!(prompts.len(), mdopener_mcp::PROMPT_NAMES.len());
    for p in prompts {
        let d = p["description"].as_str().unwrap();
        assert!(d.contains("Takes no arguments"), "{d}");
        assert!(d.contains("open_file first"), "{d}");
        assert!(
            d.contains("With no document open it fails with -32002"),
            "{d}"
        );
        assert!(
            d.contains(
                "-32000 when the app is not running or refuses this server's token (HTTP 401"
            ),
            "{d}"
        );
    }
    let none_open = MockIpc::new().on_get("/content", Ok(json!({ "path": null, "content": "" })));
    let no_app = MockIpc::new();
    for name in mdopener_mcp::PROMPT_NAMES {
        let resp = dispatch(
            dispatch_req("prompts/get", json!({ "name": name })),
            &none_open,
        )
        .unwrap();
        let err = resp.error.as_ref().unwrap();
        assert_eq!(err.code, -32002, "{name}");
        assert!(
            err.message.starts_with("No document is open"),
            "{}",
            err.message
        );
        let resp = dispatch(
            dispatch_req("prompts/get", json!({ "name": name })),
            &no_app,
        )
        .unwrap();
        assert_eq!(resp.error.as_ref().unwrap().code, -32000, "{name}");
    }
}

/// The prompts said -32000 means only that the app is not running. It is
/// also the code, with the refused-token message, when the app answers HTTP
/// 401, as the mdopener://current entry says. prompts/list and
/// docs/AGENTS.md now say both.
#[test]
fn prompts_say_minus_32000_also_means_a_refused_token() {
    let denied = MockIpc::new().on_get(
        "/content",
        Err("IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token".into()),
    );
    for name in mdopener_mcp::PROMPT_NAMES {
        let resp = dispatch(
            dispatch_req("prompts/get", json!({ "name": name })),
            &denied,
        )
        .unwrap();
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32000, "{name}");
        assert_eq!(err.message, mdopener_mcp::APP_AUTH_FAILED_MSG, "{name}");
    }
    assert!(mdopener_mcp::PROMPT_USAGE_NOTE.contains(
        "-32000 when the app is not running or refuses this server's token (HTTP 401, with a message saying how to fix it)"
    ));
    let docs = include_str!("../../../../docs/AGENTS.md");
    assert!(
        docs.contains("`-32000` when the app is not running\nor answers HTTP 401 (it refuses this server's token"),
        "docs/AGENTS.md must say a prompt's -32000 also means a refused token"
    );
}

/// mdopener://current, the recents and the prompts answer -32000 with the
/// app's reason for any HTTP error other than 401, which the listing, the
/// prompt note and docs/AGENTS.md did not say. A 500 whose reason held "not
/// found" also read as a closed app.
#[test]
fn current_document_other_http_errors_are_minus_32000_with_the_apps_reason() {
    for reason in [
        "IPC server returned HTTP 500: template not found",
        "IPC server returned HTTP 404: no such route",
    ] {
        let failing = MockIpc::new()
            .on_get("/content", Err(reason.into()))
            .on_get("/vault", Err(reason.into()));
        for uri in ["mdopener://current", "mdopener://recent-documents"] {
            let err = handle_resource_read(id(1), uri, &failing).error.unwrap();
            assert_eq!(err.code, -32000, "{uri}");
            assert_eq!(err.message, reason, "{uri}");
        }
        let resp = dispatch(
            dispatch_req("prompts/get", json!({ "name": "summarize" })),
            &failing,
        )
        .unwrap();
        let err = resp.error.unwrap();
        assert_eq!((err.code, err.message.as_str()), (-32000, reason));
    }
    let listed = handle_resources_list(id(1), &MockIpc::new());
    let resources = listed.result.unwrap()["resources"].clone();
    for uri in ["mdopener://current", "mdopener://recent-documents"] {
        let entry = resources
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["uri"] == uri)
            .unwrap();
        let d = entry["description"].as_str().unwrap();
        assert!(
            d.contains("-32000 with the app's reason when it answers any other HTTP error"),
            "{uri}: {d}"
        );
    }
    assert!(mdopener_mcp::PROMPT_USAGE_NOTE
        .contains("Any other HTTP error from the app is -32000 too, with the app's reason."));
    let docs = include_str!("../../../../docs/AGENTS.md");
    assert!(
        docs.contains("Any other HTTP error the app answers (a\n  404 or a 500) is `-32000` too"),
        "docs/AGENTS.md must say mdopener://current's other HTTP errors"
    );
    assert!(
        docs.contains("any other\nHTTP error the app answers is `-32000` too"),
        "docs/AGENTS.md must say the prompts' other HTTP errors"
    );
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

/// The resource channel checked the canonical target of an advertised path,
/// then read the advertised path again, re-resolving its symlink. A
/// `notes.md` link re-pointed from a Markdown file to `id_rsa` between the
/// check and the read was served. The read now uses the checked path.
#[cfg(unix)]
#[test]
fn resource_reads_use_the_checked_path_not_the_link_again() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let dir = std::fs::canonicalize(dir.path()).unwrap();
    let secret = dir.join("id_rsa");
    std::fs::write(&secret, "PRIVATE KEY\n").unwrap();
    let real = dir.join("real.md");
    std::fs::write(&real, "# Real\n").unwrap();
    let link = dir.join("notes.md");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let link_s = link.to_string_lossy().into_owned();
    let vault = json!({ "files": [{ "path": link_s, "name": "notes.md" }], "recents": [link_s] });
    let ipc = MockIpc::new().on_get("/vault", Ok(vault));

    let stop = Arc::new(AtomicBool::new(false));
    let swapper = {
        let (stop, dir, link, real, secret) = (
            stop.clone(),
            dir.clone(),
            link.clone(),
            real.clone(),
            secret.clone(),
        );
        std::thread::spawn(move || {
            let tmp = dir.join("swap.tmp");
            let mut flip = false;
            while !stop.load(Ordering::Relaxed) {
                let _ = std::fs::remove_file(&tmp);
                let target = if flip { &secret } else { &real };
                std::os::unix::fs::symlink(target, &tmp).unwrap();
                std::fs::rename(&tmp, &link).unwrap();
                flip = !flip;
            }
        })
    };
    let mut leaked = 0;
    let uri = format!("file://{link_s}");
    for i in 0..20_000u64 {
        let resp = handle_resource_read(id(i), &uri, &ipc);
        if let Some(r) = &resp.result {
            if r.to_string().contains("PRIVATE KEY") {
                leaked += 1;
            }
        }
        if i % 10 == 0 {
            let resp = mdopener_mcp::handle_recent_documents_resource(id(i), &ipc);
            if resp
                .result
                .as_ref()
                .unwrap()
                .to_string()
                .contains("PRIVATE KEY")
            {
                leaked += 1;
            }
        }
    }
    stop.store(true, Ordering::Relaxed);
    swapper.join().unwrap();
    assert_eq!(leaked, 0, "the secret behind a re-pointed link was served");
}

// Hostile front matter must not abort the server: a panic or a stack overflow
// in export_metadata kills the stdio process and every later request.
#[test]
fn frontmatter_non_ascii_whitespace_in_a_block_scalar_does_not_panic() {
    use mdopener_mcp::extract_frontmatter;
    // A no-break space after an explicit indentation indicator.
    let nbsp = "---\nk: |1\n\u{a0}x\nnext: 1\n---\n";
    assert_eq!(extract_frontmatter(nbsp)["next"], json!(1));
    // Ideographic spaces deeper than the block's ASCII indentation.
    let ideo = "---\nk: |\n    a\n\u{3000}\u{3000}b\nnext: 2\n---\n";
    assert_eq!(extract_frontmatter(ideo)["k"], json!("a\n"));
}

#[test]
fn frontmatter_empty_sequence_items_are_siblings_and_do_not_overflow() {
    use mdopener_mcp::extract_frontmatter;
    let doc = "---\ntags:\n-\n- a\n-\n---\n";
    assert_eq!(
        extract_frontmatter(doc),
        json!({ "tags": [null, "a", null] })
    );

    // Thousands of empty items used to recurse once per line and abort.
    let many = format!("---\nk:\n{}next: 1\n---\n", "-\n".repeat(200_000));
    let v = extract_frontmatter(&many);
    assert_eq!(v["k"].as_array().map(Vec::len), Some(200_000));
    assert_eq!(v["next"], json!(1));
}

#[test]
fn frontmatter_nesting_deeper_than_the_cap_is_null() {
    use mdopener_mcp::{extract_frontmatter, FRONTMATTER_MAX_DEPTH};
    let levels = 8_000;
    let mut doc = String::from("---\n");
    for i in 0..levels {
        doc.push_str(&format!("{}k{i}:\n", " ".repeat(i)));
    }
    doc.push_str("after: 1\n---\n");
    let v = extract_frontmatter(&doc);
    assert_eq!(v["after"], json!(1));
    let mut cur = &v;
    for i in 0..FRONTMATTER_MAX_DEPTH {
        cur = &cur[format!("k{i}")];
        assert!(cur.is_object() || cur.is_null(), "level {i}: {cur}");
    }
}

/// Tools that read a document from disk read it whole and returned it whole:
/// a multi-gigabyte `.md` went into memory and into the agent's reply. Past
/// the 16 MiB the app accepts in one request, they now refuse it.
#[test]
fn document_reads_refuse_a_file_larger_than_16_mib() {
    use mdopener_mcp::{read_document_file, MAX_DOCUMENT_BYTES};
    let dir = tempfile::Builder::new().prefix("big-").tempdir().unwrap();
    let big = dir.path().join("big.md");
    std::fs::File::create(&big)
        .unwrap()
        .set_len(MAX_DOCUMENT_BYTES + 1)
        .unwrap();
    let small = dir.path().join("small.md");
    std::fs::write(&small, "# small\n").unwrap();
    let big_canvas = dir.path().join("big.canvas");
    std::fs::File::create(&big_canvas)
        .unwrap()
        .set_len(MAX_DOCUMENT_BYTES + 1)
        .unwrap();

    let err = read_document_file(&big).unwrap_err();
    assert!(err.to_string().contains("more than the 16 MiB"), "{err}");
    let msg = tool_error_text(&call_tool("export_text", json!({ "path": big })));
    assert!(
        msg.contains("more than the 16 MiB a document may be"),
        "{msg}"
    );
    let msg = tool_error_text(&call_tool(
        "diff_documents",
        json!({ "path_a": small, "path_b": big }),
    ));
    assert!(msg.contains("more than the 16 MiB"), "{msg}");
    let msg = tool_error_text(&call_tool(
        "edit_canvas",
        json!({ "path": big_canvas, "ops": [{ "type": "delete_node", "id": "a" }] }),
    ));
    assert!(msg.contains("more than the 16 MiB"), "{msg}");

    // Exactly the cap is still read.
    let at_cap = dir.path().join("at-cap.md");
    std::fs::File::create(&at_cap)
        .unwrap()
        .set_len(MAX_DOCUMENT_BYTES)
        .unwrap();
    assert_eq!(
        read_document_file(&at_cap).unwrap().len() as u64,
        MAX_DOCUMENT_BYTES
    );
}

/// A document that is not UTF-8 (a Latin-1 or UTF-16 file, as some Windows
/// editors save) was refused with the bare "stream did not contain valid
/// UTF-8", which named neither where the problem was nor what to do, and
/// `get_user_annotations`' `tasksNote` ran it on into "Its tasks were not
/// read." with no full stop. The reason now says where and how to convert it.
#[test]
fn a_document_that_is_not_utf8_is_refused_with_where_and_what_to_do() {
    let dir = tempfile::Builder::new().prefix("enc-").tempdir().unwrap();
    let latin = dir.path().join("latin.md");
    std::fs::write(&latin, b"# Menu\n\ncaf\xe9 au lait\n").unwrap();
    let utf16 = dir.path().join("utf16.md");
    std::fs::write(&utf16, b"\xff\xfe#\x00 \x00H\x00i\x00").unwrap();
    let ok = dir.path().join("ok.md");
    std::fs::write(&ok, "# ok\n").unwrap();
    let canvas = dir.path().join("board.canvas");
    std::fs::write(&canvas, b"{\"nodes\": [], \"edges\": [], \"t\": \"\xe9\"}").unwrap();

    let convert = "Ashlr MD reads documents as UTF-8: convert the file to UTF-8";
    for (tool, args) in [
        ("export_text", json!({ "path": latin })),
        ("export_metadata", json!({ "path": latin })),
        ("diff_documents", json!({ "path_a": ok, "path_b": latin })),
    ] {
        let msg = tool_error_text(&call_tool(tool, args));
        assert!(
            msg.contains("it is not UTF-8 text (byte 12 is not valid UTF-8, on line 3)"),
            "{tool}: {msg}"
        );
        assert!(msg.contains(convert), "{tool}: {msg}");
        assert!(!msg.contains("stream did not contain"), "{tool}: {msg}");
    }
    let msg = tool_error_text(&call_tool("export_text", json!({ "path": utf16 })));
    assert!(msg.contains("it is UTF-16 text, not UTF-8"), "{msg}");
    assert!(msg.contains(convert), "{msg}");
    let msg = tool_error_text(&call_tool(
        "edit_canvas",
        json!({ "path": canvas, "ops": [{ "type": "delete_node", "id": "a" }] }),
    ));
    assert!(
        msg.contains("it is not UTF-8 text (byte 34 is not valid UTF-8, on line 1)"),
        "{msg}"
    );

    // Read from disk with the app closed: the note is two sentences.
    let ipc = MockIpc::new().on_get(
        "/annotations",
        Err("~/.mdopener/ipc-port not found".to_string()),
    );
    let out = content_text(&tool_get_annotations(
        id(1),
        &json!({ "path": latin }),
        &ipc,
    ));
    assert_eq!(out["tasks"], json!([]), "{out}");
    let note = out["tasksNote"].as_str().unwrap();
    assert!(note.contains(convert), "{note}");
    assert!(
        note.ends_with("then try again. Its tasks were not read."),
        "{note}"
    );
}

/// A tool checked a path (`checked_document_path` resolves it and judges the
/// canonical name) and then opened it again to read it, so a final or an
/// intermediate component swapped for a symlink in between was followed:
/// `notes.md` re-pointed at a secret, or the folder above it at another
/// folder. The read now refuses a link in the last component (`O_NOFOLLOW`)
/// and any file that is not the one the check saw (device and inode).
#[cfg(unix)]
#[test]
fn checked_document_reads_refuse_a_link_swapped_in_after_the_check() {
    use mdopener_mcp::{checked_document, read_document_file};
    let dir = tempfile::Builder::new().prefix("swap-").tempdir().unwrap();
    let secret = dir.path().join("id_rsa");
    std::fs::write(&secret, "BEGIN PRIVATE KEY").unwrap();

    // The file itself, swapped for a link to the secret.
    let notes = dir.path().join("notes.md");
    std::fs::write(&notes, "# notes\n").unwrap();
    let doc = checked_document(&notes.to_string_lossy(), "path").unwrap();
    assert_eq!(doc.read().unwrap(), "# notes\n");
    std::fs::remove_file(&notes).unwrap();
    std::os::unix::fs::symlink(&secret, &notes).unwrap();
    let err = doc.read().unwrap_err().to_string();
    assert!(err.contains("symbolic link"), "{err}");
    let err = read_document_file(&doc.path).unwrap_err().to_string();
    assert!(err.contains("symbolic link"), "{err}");

    // The folder above it, swapped for a link to a folder holding another
    // `plan.md`.
    let real = dir.path().join("real");
    std::fs::create_dir(&real).unwrap();
    std::fs::write(real.join("plan.md"), "# plan\n").unwrap();
    let other = dir.path().join("other");
    std::fs::create_dir(&other).unwrap();
    std::fs::write(other.join("plan.md"), "SECRET PLAN").unwrap();
    let doc = checked_document(&real.join("plan.md").to_string_lossy(), "path").unwrap();
    std::fs::rename(&real, dir.path().join("real-old")).unwrap();
    std::os::unix::fs::symlink(&other, &real).unwrap();
    let err = doc.read().unwrap_err().to_string();
    assert!(err.contains("changed after it was checked"), "{err}");

    // A FIFO put in its place after the check is refused, not waited on.
    let pipe = dir.path().join("pipe.md");
    std::fs::write(&pipe, "# pipe\n").unwrap();
    let doc = checked_document(&pipe.to_string_lossy(), "path").unwrap();
    std::fs::remove_file(&pipe).unwrap();
    let status = std::process::Command::new("mkfifo")
        .arg(&pipe)
        .status()
        .unwrap();
    assert!(status.success(), "mkfifo failed");
    let err = doc.read().unwrap_err().to_string();
    assert!(err.contains("not a regular file"), "{err}");
}

/// `search_vault` with an empty or whitespace-only query reached the app, so
/// with the app closed the agent was told "app not running" instead of that
/// its query was empty. Both are now `-32602` before any IPC: an empty one by
/// the schema's `minLength`, a blank one by the tool. The resource refuses a
/// blank `q` the same way.
#[test]
fn search_vault_refuses_an_empty_or_blank_query_before_the_app() {
    let schema = tool_registry()
        .into_iter()
        .find(|t| t.name == "search_vault")
        .unwrap()
        .input_schema;
    assert_eq!(schema["properties"]["query"]["minLength"], 1);
    let msg = refused_before_the_tool("search_vault", json!({ "query": "" }));
    assert!(
        msg.starts_with("`query` must be at least 1 character"),
        "{msg}"
    );
    for blank in [" ", "  \t\n "] {
        let msg = refused_before_the_tool(
            "search_vault",
            json!({ "query": blank, "vault": "/nonexistent" }),
        );
        assert!(msg.contains("only whitespace"), "{blank:?}: {msg}");
    }
    let ipc = MockIpc::new();
    for uri in ["text://vault-search?q=", "text://vault-search?q=+%20+"] {
        let resp = mdopener_mcp::handle_resource_read(id(1), uri, &ipc);
        let err = resp.error.expect(uri);
        assert_eq!(err.code, -32602, "{uri}");
        assert!(
            err.message.contains("requires a query"),
            "{uri}: {}",
            err.message
        );
    }
    assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
}

/// `mdopener://current` answered `""` when no document was open, so an agent
/// could not tell "nothing open" from an empty document; the prompts already
/// refused it. Both now refuse it the same way (-32002), an open empty
/// document is still `""`, and an unreachable app is -32000.
#[test]
fn current_resource_with_no_document_open_is_an_error_like_the_prompts() {
    let none_open =
        || MockIpc::new().on_get("/content", Ok(json!({ "path": null, "content": "" })));
    let resp = handle_resource_read(id(1), "mdopener://current", &none_open());
    let err = resp.error.expect("no document open must be an error");
    assert_eq!(err.code, -32002);
    assert!(
        err.message.contains("No document is open"),
        "{}",
        err.message
    );
    let prompt = mdopener_mcp::handle_prompt_get(id(2), "summarize", &none_open());
    let perr = prompt.error.expect("prompt with no document");
    assert_eq!((perr.code, perr.message), (err.code, err.message));

    let no_content = MockIpc::new().on_get("/content", Ok(json!({ "path": "/a.md" })));
    let err = handle_resource_read(id(3), "mdopener://current", &no_content)
        .error
        .expect("an answer without content must be an error");
    assert_eq!(err.code, -32002, "{}", err.message);

    let empty_doc =
        MockIpc::new().on_get("/content", Ok(json!({ "path": "/a.md", "content": "" })));
    let resp = handle_resource_read(id(4), "mdopener://current", &empty_doc);
    assert!(resp.error.is_none(), "{:?}", resp.error);
    assert_eq!(resp.result.unwrap()["contents"][0]["text"], "");

    let resp = handle_resource_read(id(5), "mdopener://current", &MockIpc::new());
    assert_eq!(resp.error.expect("app unreachable").code, -32000);
}

/// `mdopener://recent-documents` answered an empty list when the app could
/// not be reached, the same as an app with no recents. It is now -32000 like
/// `mdopener://current`; an app with no recents is still an empty list.
#[test]
fn recent_documents_without_the_app_is_an_error_not_an_empty_list() {
    let ipc = MockIpc::new().on_get("/vault", Err("~/.mdopener/ipc-port not found".into()));
    let resp = handle_resource_read(id(1), "mdopener://recent-documents", &ipc);
    let err = resp.error.expect("an unreachable app must be an error");
    assert_eq!(err.code, -32000);
    assert!(
        err.message.contains("does not appear to be running"),
        "{}",
        err.message
    );

    let ipc = MockIpc::new().on_get("/vault", Ok(json!({ "files": [], "recents": [] })));
    let resp = handle_resource_read(id(2), "mdopener://recent-documents", &ipc);
    assert!(resp.error.is_none(), "{:?}", resp.error);
    let text = resp.result.unwrap()["contents"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    let body: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(body["count"], 0);
}

/// `mdopener://recent-documents` left out oversized, dotfile and missing
/// recents without counting them, so a short list could not be told from a
/// short recents list. `skipped` now counts each reason.
#[test]
fn recent_documents_counts_the_recents_it_skips() {
    use mdopener_mcp::MAX_DOCUMENT_BYTES;
    let dir = tempfile::tempdir().unwrap();
    let dir = std::fs::canonicalize(dir.path()).unwrap();
    let path = |name: &str| dir.join(name).to_string_lossy().into_owned();
    std::fs::write(dir.join("ok.md"), "# Fine\n").unwrap();
    std::fs::write(dir.join(".secret.md"), "# Hidden\n").unwrap();
    std::fs::write(dir.join("notes.txt"), "plain\n").unwrap();
    std::fs::File::create(dir.join("huge.md"))
        .unwrap()
        .set_len(MAX_DOCUMENT_BYTES + 1)
        .unwrap();
    std::fs::write(dir.join("latin1.md"), [0x23u8, 0x20, 0xe9, 0xff]).unwrap();
    let recents = json!([
        path("ok.md"),
        path(".secret.md"),
        path("notes.txt"),
        path("huge.md"),
        path("gone.md"),
        path("latin1.md"),
    ]);
    let ipc = MockIpc::new().on_get("/vault", Ok(json!({ "files": [], "recents": recents })));
    let resp = handle_resource_read(id(1), "mdopener://recent-documents", &ipc);
    assert!(resp.error.is_none(), "{:?}", resp.error);
    let text = resp.result.unwrap()["contents"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    let body: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(body["count"], 1, "{body}");
    assert_eq!(
        body["skipped"],
        json!({ "missing": 1, "notDocument": 2, "tooLarge": 1, "unreadable": 1 }),
        "{body}"
    );

    // Nothing skipped: every count is zero.
    let ipc = MockIpc::new().on_get(
        "/vault",
        Ok(json!({ "files": [], "recents": [path("ok.md")] })),
    );
    let resp = handle_resource_read(id(2), "mdopener://recent-documents", &ipc);
    let text = resp.result.unwrap()["contents"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    let body: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        body["skipped"],
        json!({ "missing": 0, "notDocument": 0, "tooLarge": 0, "unreadable": 0 })
    );
}

/// The `mdopener://recent-documents` description gave `{ documents, count,
/// skipped }` but not what each document holds, so an agent learned
/// `mtimeMs` and `preview` by reading it. The named fields are exactly the
/// ones each document has.
#[test]
fn recent_documents_description_names_each_documents_fields() {
    let dir = tempfile::tempdir().unwrap();
    let dir = std::fs::canonicalize(dir.path()).unwrap();
    std::fs::write(dir.join("ok.md"), "# Fine\nbody\n").unwrap();
    let recents = json!([dir.join("ok.md").to_string_lossy()]);
    let ipc = MockIpc::new().on_get("/vault", Ok(json!({ "files": [], "recents": recents })));
    let listed = handle_resources_list(id(1), &ipc);
    let resources = listed.result.as_ref().unwrap()["resources"]
        .as_array()
        .unwrap()
        .clone();
    let desc = resources
        .iter()
        .find(|r| r["uri"] == "mdopener://recent-documents")
        .unwrap()["description"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        desc.contains("{ documents: [{ path, title, mtimeMs, preview }], count, skipped:"),
        "{desc}"
    );
    let resp = handle_resource_read(id(2), "mdopener://recent-documents", &ipc);
    let text = resp.result.unwrap()["contents"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    let body: Value = serde_json::from_str(&text).unwrap();
    let mut keys: Vec<String> = body["documents"][0]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["mtimeMs", "path", "preview", "title"]);
    assert_eq!(body["documents"][0]["title"], "Fine");
}

/// An HTTP answer was read to its end however long it was (the read timeout
/// is per read), so a peer that kept sending grew the server's memory
/// without bound. Past MAX_HTTP_RESPONSE_BYTES it is now refused.
#[test]
fn an_http_answer_past_the_cap_is_refused() {
    use mdopener_mcp::MAX_HTTP_RESPONSE_BYTES;
    use std::io::{Read as _, Write as _};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut conn, _) = listener.accept().unwrap();
        let mut req = [0u8; 1024];
        let _ = conn.read(&mut req);
        let _ = conn.write_all(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n\"");
        let chunk = vec![b'x'; 1024 * 1024];
        // A little past the cap, then stop, so a client without one returns.
        for _ in 0..=(MAX_HTTP_RESPONSE_BYTES / chunk.len() as u64) {
            if conn.write_all(&chunk).is_err() {
                return;
            }
        }
        let _ = conn.write_all(b"\"");
    });
    let err = match mdopener_mcp::http_get(&format!("http://127.0.0.1:{port}/content"), "t") {
        Ok(v) => panic!("an answer of {} bytes was read whole", v.to_string().len()),
        Err(e) => e,
    };
    assert!(
        err.contains("more than 64 MiB"),
        "{}",
        &err[..err.len().min(200)]
    );
    server.join().unwrap();
}

/// A field an `edit_canvas` op does not use (`width` on a move_node) was
/// ignored and the call reported success for a resize it never made. It is
/// refused with -32602 naming the op that uses it, and the file is untouched.
#[test]
fn edit_canvas_refuses_fields_the_op_does_not_use() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.canvas");
    let original = r#"{"nodes":[{"id":"n1","type":"text","text":"hi","x":0,"y":0,"width":10,"height":10}],"edges":[]}"#;
    std::fs::write(&path, original).unwrap();
    let p = path.to_string_lossy().into_owned();
    let msg = param_error(&call_tool(
        "edit_canvas",
        json!({ "path": p, "ops": [
            { "type": "move_node", "id": "n1", "x": 5, "y": 6 },
            { "type": "move_node", "id": "n1", "x": 5, "y": 6, "width": 99 }
        ] }),
    ));
    assert!(
        msg.starts_with("op[1] move_node: `width` is not used"),
        "{msg}"
    );
    assert!(msg.contains("`resize_node`"), "{msg}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    // Refused before the file is read, as an empty `ops` is.
    let missing = dir
        .path()
        .join("missing.canvas")
        .to_string_lossy()
        .into_owned();
    let msg = param_error(&call_tool(
        "edit_canvas",
        json!({ "path": missing, "ops": [{ "type": "delete_node", "id": "n1", "text": "x" }] }),
    ));
    assert!(msg.contains("`text` is not used by delete_node"), "{msg}");
    // A null field is taken as left out, and the op's own fields still work.
    let resp = call_tool(
        "edit_canvas",
        json!({ "path": p, "save": false, "ops": [
            { "type": "resize_node", "id": "n1", "width": 5, "height": 5, "x": null }
        ] }),
    );
    assert!(resp.error.is_none(), "{:?}", resp.error);
}

/// `add_edge` wrote a `fromSide` of "nowhere", a `toEnd` of "dot" or a
/// colour of "red" as given and reported success; JSON Canvas allows only
/// top/right/bottom/left, none/arrow and its colours. Each is now -32602 and
/// the canvas is left unchanged; the allowed values are still written.
#[test]
fn edit_canvas_add_edge_refuses_values_json_canvas_does_not_allow() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.canvas");
    let original = r#"{"nodes":[{"id":"a","type":"text","text":"a","x":0,"y":0,"width":10,"height":10},{"id":"b","type":"text","text":"b","x":20,"y":0,"width":10,"height":10}],"edges":[]}"#;
    std::fs::write(&path, original).unwrap();
    let p = path.to_string_lossy().into_owned();
    for (extra, field) in [
        (json!({ "fromSide": "nowhere" }), "edge.fromSide"),
        (json!({ "toSide": 3 }), "edge.toSide"),
        (json!({ "fromEnd": "dot" }), "edge.fromEnd"),
        (json!({ "toEnd": "Arrow" }), "edge.toEnd"),
        (json!({ "color": "red" }), "edge.color"),
        (json!({ "label": 7 }), "edge.label"),
    ] {
        let mut edge = json!({ "id": "e1", "fromNode": "a", "toNode": "b" });
        edge.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let msg = param_error(&call_tool(
            "edit_canvas",
            json!({ "path": p, "ops": [{ "type": "add_edge", "edge": edge }] }),
        ));
        assert!(msg.contains(field), "{field}: {msg}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }
    let resp = call_tool(
        "edit_canvas",
        json!({ "path": p, "save": false, "ops": [{ "type": "add_edge", "edge": {
            "id": "e1", "fromNode": "a", "toNode": "b", "fromSide": "right",
            "toSide": "left", "fromEnd": "none", "toEnd": "arrow", "color": "#abc",
            "label": "x"
        } }] }),
    );
    assert!(resp.error.is_none(), "{:?}", resp.error);
}

/// `text://vault-search?q=a&q=b` searched for `b` alone, and `q=%ZZ` searched
/// for the literal text `%ZZ`: the search ran on something the agent never
/// meant. Both are now -32602, before anything is searched.
#[test]
fn vault_search_resource_refuses_repeated_and_malformed_parameters() {
    let ipc = app_down_ipc();
    for (uri, want) in [
        ("text://vault-search?q=a&q=b", "`q` is given more than once"),
        (
            "text://vault-search?q=a&limit=5&limit=6",
            "`limit` is given more than once",
        ),
        ("text://vault-search?q=%ZZ", "`q` is not valid URI encoding"),
        ("text://vault-search?q=a%", "`q` is not valid URI encoding"),
        (
            "text://vault-search?q=a&vault=%FF",
            "`vault` is not valid URI encoding",
        ),
    ] {
        let msg = param_error(&handle_resource_read(id(1), uri, &ipc));
        assert!(msg.contains(want), "{uri}: {msg}");
    }
    // Correct encodings still read as before: `+` and `%20` are spaces,
    // `%2B` a plus, `%25` a percent sign.
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    std::fs::create_dir(&vault).unwrap();
    std::fs::write(vault.join("a.md"), "c+d 100%\n").unwrap();
    let d = vault.to_string_lossy().into_owned();
    let uri = format!("text://vault-search?q=c%2Bd+100%25&semantic=false&vault={d}");
    let resp = handle_resource_read(id(2), &uri, &ipc);
    let text: Value = serde_json::from_str(
        resp.result.as_ref().unwrap()["contents"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(text["query"], "c+d 100%");
    assert_eq!(text["results"].as_array().unwrap().len(), 1, "{text}");
}

/// No prompt declares an argument, but `prompts/get` with
/// `arguments: { "path": "plan.md" }` dropped it and ran the prompt on
/// whatever document was open. A given argument is now -32602 before the app
/// is asked; omitted, `null` or `{}` still works.
#[test]
fn prompts_get_refuses_arguments_no_prompt_declares() {
    for p in mdopener_mcp::prompts_list().as_array().unwrap() {
        assert!(p.get("arguments").is_none(), "{p}");
    }
    let doc = MockIpc::new().on_get(
        "/content",
        Ok(json!({ "path": "/v/a.md", "content": "# A" })),
    );
    let get = |params: Value| dispatch(dispatch_req("prompts/get", params), &doc).unwrap();
    let msg = param_error(&get(
        json!({ "name": "summarize", "arguments": { "path": "plan.md" } }),
    ));
    assert!(msg.contains("takes no arguments, got `path`"), "{msg}");
    let msg = param_error(&get(json!({ "name": "summarize", "arguments": ["x"] })));
    assert!(msg.contains("must be an object"), "{msg}");
    for ok in [
        json!({ "name": "summarize" }),
        json!({ "name": "summarize", "arguments": null }),
        json!({ "name": "summarize", "arguments": {} }),
    ] {
        let resp = get(ok.clone());
        assert!(resp.error.is_none(), "{ok}: {:?}", resp.error);
    }
    // An unknown prompt is still named first.
    let msg = param_error(&get(
        json!({ "name": "sumarize", "arguments": { "x": "1" } }),
    ));
    assert!(msg.contains("Unknown prompt"), "{msg}");
}

// ── No em or en dashes in what agents read ───────────────────────────────────

/// The product rule is no em-dashes in user-facing strings. Every listing an
/// agent reads (tools, schemas, prompts, resources, AI action prompts) and
/// every prompt's text is scanned for U+2014 and U+2013. The not-running
/// error the real IPC client gives is checked against the binary in
/// `tests/stdio.rs`.
#[test]
fn agent_facing_text_has_no_em_or_en_dashes() {
    fn dashes(place: &str, v: &Value) -> Vec<String> {
        let text = v.to_string();
        if text.contains('\u{2014}') || text.contains('\u{2013}') {
            vec![format!("{place}: {text}")]
        } else {
            vec![]
        }
    }
    let ipc = MockIpc::new().on_get(
        "/content",
        Ok(json!({ "path": "/p.md", "content": "# Plan" })),
    );
    let mut found = Vec::new();
    for method in [
        "tools/list",
        "prompts/list",
        "resources/list",
        "resources/templates/list",
    ] {
        let resp = dispatch(dispatch_req(method, json!({})), &ipc).unwrap();
        let result = resp.result.unwrap_or_else(|| panic!("{method} failed"));
        found.extend(dashes(method, &result));
    }
    for name in mdopener_mcp::PROMPT_NAMES {
        let resp = dispatch(dispatch_req("prompts/get", json!({ "name": name })), &ipc).unwrap();
        let result = resp
            .result
            .unwrap_or_else(|| panic!("prompts/get {name} failed"));
        found.extend(dashes(&format!("prompts/get {name}"), &result));
    }
    let actions = tool_list_ai_actions(id(1), &json!({}));
    found.extend(dashes("list_ai_actions", &content_text(&actions)));
    found.extend(dashes(
        "app_not_running_msg",
        &json!(mdopener_mcp::app_not_running_msg("ipc-port not found")),
    ));
    assert!(found.is_empty(), "dashes found:\n{}", found.join("\n"));
}

// ── edit_canvas refuses empty ids before reading ─────────────────────────────

/// An op with `id: ""` (or an empty `ids` element, `node.id`, `edge.id`,
/// `edge.fromNode` or `edge.toNode`) used to reach the file and come back as
/// "node `` not found". It is now -32602 saying the field must not be empty,
/// before the file is read: the canvas here does not exist.
#[test]
fn edit_canvas_refuses_empty_ids_before_reading_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.canvas");
    let node = json!({ "id": "", "type": "text", "text": "t", "x": 0, "y": 0,
                       "width": 1, "height": 1 });
    let cases = [
        (
            json!({ "type": "move_node", "id": "", "x": 1, "y": 2 }),
            "op[0] move_node: `id` must not be empty",
        ),
        (
            json!({ "type": "delete_edge", "id": "" }),
            "op[0] delete_edge: `id` must not be empty",
        ),
        (
            json!({ "type": "reorder_edges", "ids": ["e1", ""] }),
            "op[0] reorder_edges: `ids[1]` must not be empty",
        ),
        (
            json!({ "type": "add_node", "node": node }),
            "op[0] add_node: node.id must not be empty",
        ),
        (
            json!({ "type": "add_edge", "edge": { "id": "e", "fromNode": "", "toNode": "b" } }),
            "op[0] add_edge: edge.fromNode must not be empty",
        ),
        (
            json!({ "type": "add_edge", "edge": { "id": "e", "fromNode": "a", "toNode": "" } }),
            "op[0] add_edge: edge.toNode must not be empty",
        ),
    ];
    // Through tools/call, the op's `id` and the `ids` elements are refused
    // first by the schema's nested `minLength`, naming the op's field.
    let schema_says = [
        Some("`ops[0].id` must be at least 1 character long, got \"\""),
        Some("`ops[0].id` must be at least 1 character long, got \"\""),
        Some("`ops[0].ids[1]` must be at least 1 character long, got \"\""),
        None,
        None,
        None,
    ];
    for ((op, want), schema) in cases.into_iter().zip(schema_says) {
        let args = json!({ "path": path, "ops": [op] });
        let direct = mdopener_mcp::tool_edit_canvas(id(1), &args);
        assert_eq!(param_error(&direct), want);
        let via_call = call("edit_canvas", args, &MockIpc::new());
        assert_eq!(param_error(&via_call), schema.unwrap_or(want));
    }
    assert!(!path.exists());
}

// ── blank ids are refused like empty ones ────────────────────────────────────

/// A whitespace-only `edit_id` names no preview either: it passes the
/// schema's minLength, so the handler refuses it with the empty message, and
/// the app is not asked to apply anything.
#[test]
fn stream_edit_apply_refuses_a_blank_edit_id() {
    let ipc = MockIpc::new().on_post("/stream-edit-apply", Ok(json!({ "ok": true })));
    for blank in [" ", "\t\n"] {
        let args = json!({ "edit_id": blank, "find": "a", "replace": "b" });
        let msg = param_error(&call("stream_edit_apply", args.clone(), &ipc));
        assert_eq!(msg, "`edit_id` must not be empty");
        let msg = param_error(&tool_stream_edit_apply(id(1), &args, &ipc));
        assert_eq!(msg, "`edit_id` must not be empty");
    }
    assert!(ipc.calls().is_empty(), "{:?}", ipc.calls());
}

/// A whitespace-only op `id`, `ids` element, `node.id`, `edge.id`,
/// `edge.fromNode` or `edge.toNode` is refused as an empty one is, before
/// the file is read: the canvas here does not exist.
#[test]
fn edit_canvas_refuses_blank_ids_before_reading_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.canvas");
    let node = json!({ "id": "  ", "type": "text", "text": "t", "x": 0, "y": 0,
                       "width": 1, "height": 1 });
    let cases = [
        (
            json!({ "type": "move_node", "id": " ", "x": 1, "y": 2 }),
            "op[0] move_node: `id` must not be empty",
        ),
        (
            json!({ "type": "delete_edge", "id": "\t" }),
            "op[0] delete_edge: `id` must not be empty",
        ),
        (
            json!({ "type": "reorder_edges", "ids": ["e1", " "] }),
            "op[0] reorder_edges: `ids[1]` must not be empty",
        ),
        (
            json!({ "type": "add_node", "node": node }),
            "op[0] add_node: node.id must not be empty",
        ),
        (
            json!({ "type": "add_edge", "edge": { "id": " ", "fromNode": "a", "toNode": "b" } }),
            "op[0] add_edge: edge.id must not be empty",
        ),
        (
            json!({ "type": "add_edge", "edge": { "id": "e", "fromNode": "\n", "toNode": "b" } }),
            "op[0] add_edge: edge.fromNode must not be empty",
        ),
        (
            json!({ "type": "add_edge", "edge": { "id": "e", "fromNode": "a", "toNode": " " } }),
            "op[0] add_edge: edge.toNode must not be empty",
        ),
    ];
    for (op, want) in cases {
        let args = json!({ "path": path, "ops": [op] });
        let direct = mdopener_mcp::tool_edit_canvas(id(1), &args);
        assert_eq!(param_error(&direct), want);
        let via_call = call("edit_canvas", args, &MockIpc::new());
        assert_eq!(param_error(&via_call), want);
    }
    assert!(!path.exists());
}

// ── nested fields of array items honour their declared bounds ────────────────

/// `check_tool_arguments` enforced `minLength`, `minimum` and `maximum` on
/// top-level arguments only: inside an array item (an `edit_canvas` op) they
/// were declared but not checked. They are now checked there too, named as
/// `ops[1].id`, with the same wording as at the top level.
#[test]
fn nested_item_fields_honour_min_length_and_bounds() {
    let def = mdopener_mcp::ToolDef {
        name: "probe",
        description: "probe",
        input_schema: json!({
            "type": "object",
            "properties": {
                "ops": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "minLength": 2 },
                            "n": { "type": "integer", "minimum": 1, "maximum": 3 },
                            "ids": { "type": "array", "items": { "type": "string", "minLength": 1 } }
                        }
                    }
                }
            }
        }),
        annotations: None,
        tier: ToolTier::ReadOnly,
    };
    let check = |op: Value| {
        mdopener_mcp::check_tool_arguments(&def, &json!({ "ops": [{ "id": "ok" }, op] }))
    };
    assert_eq!(check(json!({ "id": "ab", "n": 2, "ids": ["x"] })), Ok(()));
    assert_eq!(
        check(json!({ "id": "a" })),
        Err("`ops[1].id` must be at least 2 characters long, got \"a\"".to_string())
    );
    assert_eq!(
        check(json!({ "n": 0 })),
        Err("`ops[1].n` must be at least 1, got 0".to_string())
    );
    assert_eq!(
        check(json!({ "n": 4 })),
        Err("`ops[1].n` must be at most 3, got 4".to_string())
    );
    assert_eq!(
        check(json!({ "ids": ["x", ""] })),
        Err("`ops[1].ids[1]` must be at least 1 character long, got \"\"".to_string())
    );

    // The real edit_canvas schema: an empty op id or ids element is refused
    // by tools/call before the handler, and the file is never read.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.canvas");
    let args = json!({ "path": path, "ops": [
        { "type": "move_node", "id": "a", "x": 1, "y": 1 },
        { "type": "reorder_edges", "ids": [""] }
    ] });
    let canvas = tool_registry()
        .into_iter()
        .find(|t| t.name == "edit_canvas")
        .unwrap();
    assert_eq!(
        mdopener_mcp::check_tool_arguments(&canvas, &args),
        Err("`ops[1].ids[0]` must be at least 1 character long, got \"\"".to_string())
    );
    assert!(!path.exists());
}

// ── No home directory ─────────────────────────────────────────────────────────
// Without a home directory the server said "Cannot determine home directory"
// and nothing more. The error now names the setting to fix and keeps its
// first sentence, which app_unreachable matches.

#[test]
fn no_home_directory_error_names_a_next_step() {
    let err = mdopener_mcp::mdopener_file_in(None, "ipc-port").unwrap_err();
    assert!(
        err.starts_with("Cannot determine home directory. "),
        "{err}"
    );
    #[cfg(not(windows))]
    assert!(err.contains("Set HOME to your home folder"), "{err}");
    #[cfg(windows)]
    assert!(err.contains("Windows user profile folder"), "{err}");
    assert!(err.contains("restart"), "{err}");
    // Not taken for "the app is not running": the reason reaches the agent as is.
    assert_eq!(mdopener_mcp::app_not_running_msg(&err), err);

    let home = std::path::PathBuf::from("/h");
    assert_eq!(
        mdopener_mcp::mdopener_file_in(Some(home.clone()), "ipc-token").unwrap(),
        home.join(".mdopener").join("ipc-token")
    );
}

// ── edit_canvas names the ids that exist when one is not found ───────────────

/// A mistyped or stale node or edge id came back as "node `n2` not found",
/// naming neither the ids the canvas has nor whether anything was written, so
/// the agent had to read the file to retry. The error now lists the ids that
/// exist at that op (after the ops before it) and says the file is unchanged.
#[test]
fn edit_canvas_not_found_lists_the_ids_that_exist() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("board.canvas");
    let canvas = json!({
        "nodes": [
            { "id": "n1", "type": "text", "text": "a", "x": 0, "y": 0, "width": 1, "height": 1 },
            { "id": "n3", "type": "text", "text": "b", "x": 0, "y": 0, "width": 1, "height": 1 }
        ],
        "edges": [ { "id": "e1", "fromNode": "n1", "toNode": "n3" } ]
    })
    .to_string();
    std::fs::write(&path, &canvas).unwrap();
    let unchanged = "No op was applied and the file was left unchanged.";
    let cases = [
        (
            json!([{ "type": "move_node", "id": "n2", "x": 1, "y": 2 }]),
            "op[0] move_node: node `n2` not found. The canvas's node ids at this op are `n1`, `n3`.",
        ),
        (
            json!([{ "type": "delete_edge", "id": "e2" }]),
            "op[0] delete_edge: edge `e2` not found. The canvas's edge ids at this op are `e1`.",
        ),
        (
            json!([{ "type": "add_edge", "edge": { "id": "e2", "fromNode": "n1", "toNode": "nx" } }]),
            "op[0] add_edge: toNode `nx` not found. The canvas's node ids at this op are `n1`, `n3`.",
        ),
        (
            json!([{ "type": "reorder_edges", "ids": ["e9"] }]),
            "op[0] reorder_edges: unknown edge id `e9`. The canvas's edge ids at this op are `e1`.",
        ),
        // The ids are those left by the ops before it: n1 was deleted with
        // its edge in op[0].
        (
            json!([
                { "type": "delete_node", "id": "n1" },
                { "type": "edit_edge_label", "id": "e1", "label": "x" }
            ]),
            "op[1] edit_edge_label: edge `e1` not found. The canvas has no edges at this op.",
        ),
    ];
    for (ops, want) in cases {
        let args = json!({ "path": path, "ops": ops });
        let msg = param_error(&mdopener_mcp::tool_edit_canvas(id(1), &args));
        assert_eq!(msg, format!("{want} {unchanged}"));
        assert_eq!(
            param_error(&call("edit_canvas", args, &MockIpc::new())),
            msg
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), canvas);
    }
}

/// A canvas with many nodes lists the first 20 ids and counts the rest.
#[test]
fn edit_canvas_not_found_caps_the_id_list() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.canvas");
    let nodes: Vec<Value> = (0..25)
        .map(|n| {
            json!({ "id": format!("n{n}"), "type": "text", "text": "t",
                          "x": 0, "y": 0, "width": 1, "height": 1 })
        })
        .collect();
    std::fs::write(&path, json!({ "nodes": nodes, "edges": [] }).to_string()).unwrap();
    let args = json!({ "path": path, "ops": [{ "type": "delete_node", "id": "zz" }] });
    let msg = param_error(&mdopener_mcp::tool_edit_canvas(id(1), &args));
    assert!(msg.contains("`n0`, `n1`"), "{msg}");
    assert!(msg.contains("`n19` and 5 more."), "{msg}");
    assert!(!msg.contains("`n20`"), "{msg}");
}

/// present_document and the server instructions promised a "full-screen"
/// presentation, but the window only enters Zen mode (Read view with the
/// title bar, tabs, status bar and side panels hidden) and keeps its size.
/// They say what it does now.
#[test]
fn present_document_says_zen_mode_not_full_screen() {
    let d = tool_registry()
        .into_iter()
        .find(|d| d.name == "present_document")
        .unwrap()
        .description;
    assert!(!d.contains("full-screen"), "{d}");
    assert!(d.contains("Read view in Zen mode"), "{d}");
    assert!(
        d.contains("the window keeps its size, and Escape leaves it"),
        "{d}"
    );
    assert!(
        !mdopener_mcp::SERVER_INSTRUCTIONS.contains("full-screen"),
        "{}",
        mdopener_mcp::SERVER_INSTRUCTIONS
    );
}

/// export_text and export_metadata said they operate on disk and return the
/// path of "the file read", but without `path` they read the app's copy of
/// the open document (GET /content), edits not yet saved included. Both say so,
/// and the result's text comes from the app, not the file.
#[test]
fn export_text_without_path_says_it_reads_the_window_not_the_file() {
    for tool in ["export_text", "export_metadata"] {
        let d = tool_registry()
            .into_iter()
            .find(|d| d.name == tool)
            .unwrap()
            .description;
        assert!(!d.contains("the file read"), "{tool}: {d}");
        assert!(!d.contains("Operates directly"), "{tool}: {d}");
        assert!(
            d.contains(
                "as the window holds it (edits not yet saved included, not the file on disk)"
            ),
            "{tool}: {d}"
        );
    }
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("doc.md");
    std::fs::write(&file, "on disk\n").unwrap();
    let path = file.to_string_lossy().to_string();
    let ipc = MockIpc::new().on_get(
        "/content",
        Ok(json!({ "path": path, "content": "unsaved words\n" })),
    );
    let resp = call("export_text", json!({}), &ipc);
    let r = content_text(&resp);
    assert_eq!(r["text"].as_str().unwrap().trim(), "unsaved words", "{r}");
    assert_eq!(r["path"], json!(path));
}
