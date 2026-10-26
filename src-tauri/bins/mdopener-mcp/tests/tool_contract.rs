//! Offline ecosystem contract consumed by Phantom without a running app.
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

const SNAPSHOT: &str = include_str!("contract/mcp-tools.v1.json");

fn snapshot() -> Value {
    serde_json::from_str(SNAPSHOT).expect("valid tool contract fixture")
}

#[test]
fn registry_matches_reviewed_contract() {
    assert_eq!(
        mdopener_mcp::tool_contract(),
        snapshot(),
        "MCP tool contract changed. Review compatibility with Phantom before regenerating the fixture."
    );
    let contract = snapshot();
    let tools = contract["tools"].as_array().unwrap();
    assert!(!tools.is_empty());
    let mut previous = "";
    for tool in tools {
        let name = tool["name"].as_str().unwrap();
        assert!(name > previous, "tool names must be unique and sorted");
        previous = name;
        assert_eq!(tool.as_object().unwrap().len(), 2);
        assert_eq!(tool["inputSchema"]["type"], "object");
        assert!(tool["inputSchema"]["properties"].is_object());
    }
}

#[test]
fn offline_export_is_deterministic_and_matches_snapshot() {
    let home = tempfile::tempdir().unwrap();
    for _ in 0..2 {
        let output = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
            .arg("--export-tool-schema")
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), SNAPSHOT);
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    }
}

#[test]
fn stdio_tool_list_matches_snapshot() {
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        "{}",
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["id"], 1);
    assert!(response.get("error").is_none());
    let mut tools: Vec<Value> = response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| json!({"name": tool["name"], "inputSchema": tool["inputSchema"]}))
        .collect();
    tools.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    assert_eq!(json!({"tools": tools}), snapshot());
}
