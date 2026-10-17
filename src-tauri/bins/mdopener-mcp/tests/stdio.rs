//! End-to-end stdio handshake against the real `mdopener-mcp` binary, the way
//! an MCP client such as Claude Code drives it: initialize, the initialized
//! notification, tools/list, a tools/call that needs no running app, and a
//! tools/call that fails because the app is not running (an `isError` result).
//! HOME points at an empty temp dir so no real `~/.mdopener` is read.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

/// The app version the sidecar ships with, so serverInfo cannot drift from it.
fn app_version() -> String {
    let conf: Value = serde_json::from_str(include_str!("../../../tauri.conf.json")).unwrap();
    conf["version"].as_str().unwrap().to_string()
}

fn session(protocol: &str) -> Vec<Value> {
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let requests = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion": protocol,
            "capabilities": {"roots": {}},
            "clientInfo": {"name": "claude-code", "version": "test"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
            "name":"list_ai_actions","arguments":{"include_prompts": false}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"ping"}),
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{
            "name":"get_current_content","arguments":{}}}),
    ];
    {
        let stdin = child.stdin.as_mut().unwrap();
        for r in &requests {
            writeln!(stdin, "{r}").unwrap();
        }
    }
    drop(child.stdin.take());
    let lines: Vec<Value> = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .map(|l| serde_json::from_str(&l.unwrap()).expect("stdout must be JSON-RPC only"))
        .collect();
    assert!(child.wait().unwrap().success());
    lines
}

#[test]
fn handshake_with_current_client_protocol_versions() {
    for protocol in ["2025-06-18", "2025-03-26"] {
        let out = session(protocol);
        // The notification gets no reply: 5 responses for 5 requests with ids.
        assert_eq!(out.len(), 5, "{protocol}: {out:?}");
        assert_eq!(out[0]["id"], 1);
        assert_eq!(out[0]["result"]["protocolVersion"], protocol);
        assert_eq!(out[0]["result"]["serverInfo"]["name"], "mdopener-mcp");
        assert_eq!(out[0]["result"]["serverInfo"]["version"], app_version(), "{protocol}");
        assert_eq!(out[1]["id"], 2);
        let tools = out[1]["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "open_file"));
        assert_eq!(out[2]["id"], 3);
        assert_eq!(out[2]["result"]["isError"], false, "{:?}", out[2]);
        assert_eq!(out[3], json!({"jsonrpc":"2.0","id":4,"result":{}}));
        // No app is running under the empty HOME: the failure is a tool
        // result with isError, not a JSON-RPC error.
        assert_eq!(out[4]["id"], 5);
        assert!(out[4].get("error").is_none(), "{:?}", out[4]);
        assert_eq!(out[4]["result"]["isError"], true, "{:?}", out[4]);
        let text = out[4]["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Ashlr MD"), "{text}");
    }
}

/// `--version` / `--help` answer and exit 0 instead of serving stdio (stdin is
/// left open, so a server that ignored the flag would hang the test).
#[test]
fn version_and_help_flags_exit_without_serving() {
    use std::time::{Duration, Instant};
    for (flag, expect) in [
        ("--version", format!("mdopener-mcp {}", app_version())),
        ("-V", format!("mdopener-mcp {}", app_version())),
        ("--help", "--version".to_string()),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
            .arg(flag)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        let status = loop {
            if let Some(s) = child.try_wait().unwrap() {
                break s;
            }
            if start.elapsed() > Duration::from_secs(10) {
                let _ = child.kill();
                panic!("{flag}: still serving stdio after 10s");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(status.success(), "{flag}");
        let mut out = String::new();
        std::io::Read::read_to_string(&mut child.stdout.take().unwrap(), &mut out).unwrap();
        assert!(out.contains(&expect), "{flag}: {out:?}");
    }
}

/// Feed raw lines to the binary and return each stdout line parsed as JSON.
fn raw_session(lines: &[&str]) -> Vec<Value> {
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    {
        let stdin = child.stdin.as_mut().unwrap();
        for l in lines {
            writeln!(stdin, "{l}").unwrap();
        }
    }
    drop(child.stdin.take());
    let out: Vec<Value> = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .map(|l| serde_json::from_str(&l.unwrap()).expect("stdout must be JSON-RPC only"))
        .collect();
    assert!(child.wait().unwrap().success());
    out
}

/// A malformed request that still carries an `id` must be answered with that
/// id (-32600), or a client waiting on it hangs. A request without an `id` is
/// a notification and gets no reply. Batches (MUST be accepted under
/// 2025-03-26) get one array reply with the non-notification responses.
#[test]
fn envelope_errors_keep_the_id_notifications_are_silent_and_batches_work() {
    let out = raw_session(&[
        r#"{"jsonrpc":"2.0","id":7}"#,
        r#"{"jsonrpc":"2.0","method":"ping"}"#,
        r#"[{"jsonrpc":"2.0","id":8,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":9,"method":"nope"}]"#,
        r#"[]"#,
        r#"{not json"#,
        r#"{"jsonrpc":"2.0","id":10,"method":"ping"}"#,
    ]);
    assert_eq!(out.len(), 5, "{out:?}");
    assert_eq!(out[0]["id"], 7);
    assert_eq!(out[0]["error"]["code"], -32600);
    let batch = out[1].as_array().expect("batch reply is an array");
    assert_eq!(batch.len(), 2, "{batch:?}");
    assert_eq!(batch[0], json!({"jsonrpc":"2.0","id":8,"result":{}}));
    assert_eq!(batch[1]["id"], 9);
    assert_eq!(batch[1]["error"]["code"], -32601);
    assert_eq!(out[2]["error"]["code"], -32600);
    assert_eq!(out[2]["id"], Value::Null);
    assert_eq!(out[3]["error"]["code"], -32700);
    assert_eq!(out[4], json!({"jsonrpc":"2.0","id":10,"result":{}}));
}
