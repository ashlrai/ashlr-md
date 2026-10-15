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
//!   notifications/* → no reply
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

use mdopener_mcp::{dispatch, Request, RealIpcClient};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let ipc = RealIpcClient;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if l.trim().is_empty() => continue,
            Ok(l) => l,
            Err(_) => break,
        };

        let response = match serde_json::from_str::<Request>(&line) {
            Ok(req) => dispatch(req, &ipc),
            Err(e) => Some(mdopener_mcp::Response::err(
                serde_json::Value::Null,
                -32700,
                format!("Parse error: {e}"),
            )),
        };

        // Notifications (dispatch returned None) get no reply.
        if let Some(response) = response {
            let mut out = serde_json::to_string(&response).unwrap_or_default();
            out.push('\n');
            let _ = stdout.write_all(out.as_bytes());
            let _ = stdout.flush();
        }
    }
}
