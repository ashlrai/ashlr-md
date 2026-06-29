//! Ashlr MD MCP server — stdio JSON-RPC 2.0 bridge for coding agents.
//!
//! Implements the [Model Context Protocol](https://modelcontextprotocol.io/)
//! over stdin/stdout so tools like Claude Code can drive Ashlr MD as a tool.
//!
//! ## IPC
//! The running Ashlr MD app starts a loopback HTTP server and writes its port
//! to `~/.mdopener/ipc-port`.  This binary reads that file to find the app.
//! If the file is absent, most tools return an error; `open_file` is the
//! exception — it can launch the app via the `mdopener://` URL scheme.
//!
//! ## Protocol subset implemented
//!   initialize      → capability handshake
//!   notifications/initialized → ack (no-op)
//!   tools/list      → list available tools
//!   tools/call      → invoke a tool
//!   ping            → {"result":{}}
//!
//! ## Tools
//!   open_file(path, mode?)          open a file in the app
//!   get_current_content()           get current doc path + markdown
//!   set_content(content, save?)     replace current doc content
//!   list_recent(limit?)             recent file list
//!   export(format, output_path?)    trigger an export
//!   request_review(...)             block until human approves/rejects
//!   get_user_annotations(path)      highlights, comments, bookmarks
//!   edit_document(find, replace)    precise substring edit
//!   replace_document(content)       full document replacement
//!   search_vault(query, limit?)     full-text vault search
//!   present_document(path?)         zen/presentation mode

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
