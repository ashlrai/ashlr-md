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
//! `export_text` / `export_metadata` given a `path` work without the app, and
//! `search_vault` given a `vault` directory greps it on disk when the app is
//! unreachable.
//!
//! ## Protocol subset implemented
//!   initialize      → capability handshake
//!   notifications/* → no reply (as does any request without an `id`)
//!   batches         → one array reply (2025-03-26 requires accepting them)
//!   ping            → {"result":{}}
//!   tools/list, tools/call
//!   resources/list, resources/templates/list, resources/read
//!   prompts/list, prompts/get   (summarize, review_plan, improve_writing)
//!
//! ## Tools
//! The authoritative catalog is `tool_registry()` in `lib.rs` (20 tools):
//! open_file, get_current_content, list_recent, export, request_review,
//! get_user_annotations, edit_document, search_vault, present_document,
//! list_ai_actions, get_conversation_context, save_conversation_message,
//! diff_documents, edit_canvas, stream_edit, stream_edit_apply, export_text,
//! export_metadata, and last the two destructive ones, replace_document and
//! set_content.
//!
//! `export_markdown_archive`, `export_canvas_graph` and `batch_export_format`
//! are no longer listed: the app never implemented them. Calling one returns
//! an `isError` result saying so (`UNAVAILABLE_TOOLS` in `lib.rs`).
//!
//! ## Resources
//!   mdopener://current, text://vault-search?q=…, mdopener://recent-documents,
//!   and file://<path> for each vault file. `export:current` is not served;
//!   reading it returns a -32002 error.

use std::io::{self, BufRead, IsTerminal as _, Write};

use mdopener_mcp::{dispatch, invalid_envelope, IpcClient, RealIpcClient, Request, Response};
use serde_json::Value;

const HELP: &str = "mdopener-mcp: MCP server for Ashlr MD (stdio JSON-RPC 2.0)

USAGE:
    mdopener-mcp               serve MCP on stdin/stdout (launched by an MCP client)
    mdopener-mcp --version     print the version
    mdopener-mcp --help        print this help

Other arguments are ignored with a warning on stderr.

Register it with your MCP client by its full path, for example:
    claude mcp add --scope user ashlr-md /path/to/mdopener-mcp
or click Connect in Ashlr MD under Preferences > AI agents (MCP). Guide:
https://github.com/ashlrai/ashlr-md/blob/main/docs/AGENTS.md
";

/// Where the agent guide is published: an installed `mdopener-mcp` has no
/// `docs/` folder next to it, so `docs/AGENTS.md` alone named nothing.
const AGENTS_GUIDE: &str = "https://github.com/ashlrai/ashlr-md/blob/main/docs/AGENTS.md";

fn main() {
    // Informational flags answer and exit instead of blocking on stdin.
    // Any other argument is still ignored, so an old client config that
    // passes one keeps working, but it is named on stderr (stdout carries
    // only JSON-RPC) so a mistyped `--verison` does not pass unnoticed.
    // Read as OS strings: `std::env::args` panics on an argument that is not
    // valid UTF-8, which stopped the server before it served anything. Such
    // an argument is ignored and named (lossily) like any other.
    let mut ignored = Vec::new();
    for arg in std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
    {
        match arg.as_str() {
            "--version" | "-V" => {
                std::process::exit(print_stdout(&format!(
                    "mdopener-mcp {}\n",
                    env!("CARGO_PKG_VERSION")
                )));
            }
            "--help" | "-h" => std::process::exit(print_stdout(HELP)),
            _ => ignored.push(arg),
        }
    }
    // stdout is the protocol channel: everything said to a human is stderr.
    for note in startup_notes(&ignored, io::stdin().is_terminal()) {
        eprintln!("{note}");
    }

    serve(io::stdin().lock(), io::stdout().lock(), &RealIpcClient);
}

/// Write `text` to stdout and return the exit status. `print!` panicked
/// when stdout could not be written (exit 101 and a backtrace): a reader
/// that closed early (`mdopener-mcp --help | head -c1`) is not an error, so
/// that exits 0 in silence, and any other failure (a full disk) is reported
/// on stderr with exit 1.
fn print_stdout(text: &str) -> i32 {
    let mut out = io::stdout().lock();
    match out.write_all(text.as_bytes()).and_then(|()| out.flush()) {
        Ok(()) => 0,
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => 0,
        Err(e) => {
            eprintln!("mdopener-mcp: cannot write to stdout: {e}");
            1
        }
    }
}

/// Answer each newline-delimited JSON-RPC message read from `input` on
/// `output`, until `input` ends or cannot be read.
///
/// A line that is not UTF-8 is answered with a `-32700` parse error and the
/// session goes on. It used to be read with `BufRead::lines`, whose
/// `InvalidData` error ended the loop, so one stray byte from a client shut
/// the server down without a word and every later request went unanswered.
fn serve(mut input: impl BufRead, mut output: impl Write, ipc: &dyn IpcClient) {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match input.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let reply = match std::str::from_utf8(&buf) {
            Ok(line) if line.trim().is_empty() => continue,
            Ok(line) => handle_line(line, ipc),
            Err(e) => Some(to_line(&Response::err(
                Value::Null,
                -32700,
                format!("Parse error: the message is not valid UTF-8 ({e})"),
            ))),
        };
        // Notifications (and batches made only of notifications) get no reply.
        if let Some(mut out) = reply {
            out.push('\n');
            let _ = output.write_all(out.as_bytes());
            let _ = output.flush();
        }
    }
}

/// What to tell a human on stderr before serving: a one-line warning naming
/// ignored arguments, and, when stdin is a terminal (someone ran the binary by
/// hand), a hint that it is an MCP stdio server waiting for JSON-RPC.
fn startup_notes(ignored: &[String], stdin_is_terminal: bool) -> Vec<String> {
    let mut notes = Vec::new();
    if !ignored.is_empty() {
        notes.push(format!(
            "mdopener-mcp: ignoring unknown argument{} {}; serving MCP on stdin/stdout (see --help)",
            if ignored.len() == 1 { "" } else { "s" },
            ignored
                .iter()
                .map(|a| format!("`{a}`"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if stdin_is_terminal {
        notes.push(format!(
            "mdopener-mcp: this is an MCP stdio server: it reads JSON-RPC requests on stdin. \
             Register it with your MCP client (see {AGENTS_GUIDE}), or run --help. Ctrl-D exits."
        ));
    }
    notes
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
    if let Some(invalid) = invalid_envelope(&message) {
        return Some(invalid);
    }
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

#[cfg(test)]
mod tests {
    use super::{serve, startup_notes, AGENTS_GUIDE, HELP};
    use mdopener_mcp::IpcClient;
    use serde_json::Value;

    /// An app that is never running: these tests only need the protocol.
    struct NoApp;
    impl IpcClient for NoApp {
        fn get(&self, _: &str) -> Result<Value, String> {
            Err("~/.mdopener/ipc-port not found".to_string())
        }
        fn post(&self, _: &str, _: Value) -> Result<Value, String> {
            Err("~/.mdopener/ipc-port not found".to_string())
        }
    }

    fn replies(input: &[u8]) -> Vec<Value> {
        let mut out = Vec::new();
        serve(input, &mut out, &NoApp);
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn a_line_that_is_not_utf8_gets_a_parse_error_and_the_session_goes_on() {
        let mut input = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n".to_vec();
        input.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"p\xffing\"}\n");
        input.extend_from_slice(b"\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}");
        let got = replies(&input);
        assert_eq!(got.len(), 3, "{got:?}");
        assert_eq!(got[0]["id"], 1);
        assert_eq!(got[0]["result"], serde_json::json!({}));
        assert_eq!(got[1]["id"], Value::Null);
        assert_eq!(got[1]["error"]["code"], -32700);
        let msg = got[1]["error"]["message"].as_str().unwrap();
        assert!(msg.contains("not valid UTF-8"), "{msg}");
        // The request after the bad line is still answered (it has no
        // trailing newline: the last line of a closed stdin).
        assert_eq!(got[2]["id"], 3);
        assert_eq!(got[2]["result"], serde_json::json!({}));
    }

    #[test]
    fn crlf_lines_and_notifications_are_handled_as_before() {
        let input = b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\r\n\
                      {\"jsonrpc\":\"2.0\",\"id\":\"a\",\"method\":\"ping\"}\r\n";
        let got = replies(input);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0]["id"], "a");
    }

    #[test]
    fn startup_notes_warn_once_and_hint_only_on_a_terminal() {
        assert!(startup_notes(&[], false).is_empty());
        let args = ["--verison".to_string(), "x".to_string()];
        let notes = startup_notes(&args, false);
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(
            notes[0].contains("ignoring unknown arguments `--verison`, `x`"),
            "{notes:?}"
        );
        let notes = startup_notes(&[], true);
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].contains("MCP stdio server"), "{notes:?}");
        assert_eq!(startup_notes(&args, true).len(), 2);
    }

    /// `--help` and the terminal hint said "see docs/AGENTS.md", a path an
    /// installed server has nowhere near it. Both name the published guide,
    /// and `--help` shows a registration command.
    #[test]
    fn help_and_hint_point_at_the_published_guide() {
        assert!(HELP.contains(AGENTS_GUIDE), "{HELP}");
        assert!(
            HELP.contains("claude mcp add --scope user ashlr-md "),
            "{HELP}"
        );
        assert!(HELP.contains("Preferences > AI agents (MCP)"), "{HELP}");
        for text in [HELP.to_string(), startup_notes(&[], true).join("\n")] {
            assert!(!text.contains("see docs/AGENTS.md"), "{text}");
        }
        assert!(startup_notes(&[], true)[0].contains(AGENTS_GUIDE));
    }
}
