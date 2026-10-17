//! Ashlr MD MCP server — stdio JSON-RPC 2.0 bridge for coding agents.
//!
//! Implements the [Model Context Protocol](https://modelcontextprotocol.io/)
//! over stdin/stdout so tools like Claude Code can drive Ashlr MD as a tool.
//!
//! ## IPC
//! The running Ashlr MD app starts a loopback HTTP server and writes its port
//! to `~/.mdopener/ipc-port`.  This binary reads that file to find the app.
//! If the file is absent, tools that need the app return an error. `open_file`
//! can launch the app via the `mdopener://` URL scheme. `diff_documents`,
//! `edit_canvas`, `list_ai_actions`, the two conversation tools, and
//! `export_text` / `export_metadata` given a `path` work without the app.
//!
//! ## Protocol subset implemented
//!   initialize      → capability handshake
//!   notifications/* → no reply (as does any request without an `id`)
//!   batches         → one array reply (2025-03-26 requires accepting them)
//!   ping            → {"result":{}}
//!   tools/list, tools/call
//!   resources/list, resources/read
//!   prompts/list, prompts/get   (summarize, review_plan, improve_writing)
//!
//! ## Tools
//! The authoritative catalog is `tool_registry()` in `lib.rs` (20 tools):
//! open_file, get_current_content, set_content, list_recent, export,
//! request_review, get_user_annotations, edit_document, replace_document,
//! search_vault, present_document, list_ai_actions, get_conversation_context,
//! save_conversation_message, diff_documents, edit_canvas, stream_edit,
//! stream_edit_apply, export_text, export_metadata.
//!
//! `export_markdown_archive`, `export_canvas_graph` and `batch_export_format`
//! are no longer listed: the app never implemented them. Calling one returns
//! an `isError` result saying so (`UNAVAILABLE_TOOLS` in `lib.rs`).
//!
//! ## Resources
//!   mdopener://current, text://vault-search?q=…, mdopener://recent-documents,
//!   and file://<path> for each vault file. `export:current` is not served;
//!   reading it returns a -32002 error.

use std::io::{self, BufRead, Write as _};

use mdopener_mcp::{dispatch, IpcClient, RealIpcClient, Request, Response};
use serde_json::Value;

const HELP: &str = "mdopener-mcp — MCP server for Ashlr MD (stdio JSON-RPC 2.0)

USAGE:
    mdopener-mcp               serve MCP on stdin/stdout (launched by an MCP client)
    mdopener-mcp --version     print the version
    mdopener-mcp --help        print this help

Register it with your MCP client; see docs/AGENTS.md.
";

fn main() {
    // Informational flags answer and exit instead of blocking on stdin.
    // Any other arguments are ignored, as before.
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--version" | "-V" => {
                println!("mdopener-mcp {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--help" | "-h" => {
                print!("{HELP}");
                return;
            }
            _ => {}
        }
    }

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let ipc = RealIpcClient;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if l.trim().is_empty() => continue,
            Ok(l) => l,
            Err(_) => break,
        };

        // Notifications (and batches made only of notifications) get no reply.
        if let Some(mut out) = handle_line(&line, &ipc) {
            out.push('\n');
            let _ = stdout.write_all(out.as_bytes());
            let _ = stdout.flush();
        }
    }
}

/// Answer one stdin line: a JSON-RPC request, a notification, or (protocol
/// 2025-03-26, which servers MUST accept) a batch array of them. Returns the
/// serialized reply, or `None` when nothing must be sent back.
fn handle_line(line: &str, ipc: &dyn IpcClient) -> Option<String> {
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            return Some(to_line(&Response::err(
                Value::Null,
                -32700,
                format!("Parse error: {e}"),
            )))
        }
    };
    match value {
        Value::Array(items) if items.is_empty() => Some(to_line(&Response::err(
            Value::Null,
            -32600,
            "Invalid Request: empty batch",
        ))),
        Value::Array(items) => {
            let replies: Vec<Response> = items
                .into_iter()
                .filter_map(|m| handle_message(m, ipc))
                .collect();
            (!replies.is_empty()).then(|| serde_json::to_string(&replies).unwrap_or_default())
        }
        single => handle_message(single, ipc).map(|r| to_line(&r)),
    }
}

/// Answer one JSON-RPC message. A well-formed message without an `id` is a
/// notification and gets no reply; a malformed one gets `-32600` carrying its
/// `id` when it has one, so the client waiting on that id is not left hanging.
fn handle_message(message: Value, ipc: &dyn IpcClient) -> Option<Response> {
    let id = message.get("id").cloned();
    match serde_json::from_value::<Request>(message) {
        Ok(req) => {
            let is_notification = id.is_none();
            let response = dispatch(req, ipc);
            if is_notification {
                None
            } else {
                response
            }
        }
        Err(e) => Some(Response::err(
            id.unwrap_or(Value::Null),
            -32600,
            format!("Invalid Request: {e}"),
        )),
    }
}

fn to_line(response: &Response) -> String {
    serde_json::to_string(response).unwrap_or_default()
}
