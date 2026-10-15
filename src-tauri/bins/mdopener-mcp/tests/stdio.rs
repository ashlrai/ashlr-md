//! End-to-end stdio handshake against the real `mdopener-mcp` binary, the way
//! an MCP client such as Claude Code drives it: initialize, the initialized
//! notification, tools/list, and a tools/call that needs no running app.
//! HOME points at an empty temp dir so no real `~/.mdopener` is read.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

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
        // The notification gets no reply: 4 responses for 4 requests with ids.
        assert_eq!(out.len(), 4, "{protocol}: {out:?}");
        assert_eq!(out[0]["id"], 1);
        assert_eq!(out[0]["result"]["protocolVersion"], protocol);
        assert_eq!(out[0]["result"]["serverInfo"]["name"], "mdopener-mcp");
        assert_eq!(out[1]["id"], 2);
        let tools = out[1]["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "open_file"));
        assert_eq!(out[2]["id"], 3);
        assert_eq!(out[2]["result"]["isError"], false, "{:?}", out[2]);
        assert_eq!(out[3], json!({"jsonrpc":"2.0","id":4,"result":{}}));
    }
}
