//! Informational commands answer before stdin and never touch the user's home.
use serde_json::{json, Value};
use std::process::{Command, Stdio};

fn run(args: &[&str]) -> String {
    let home = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .args(args)
        .env_clear()
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {:?}", output.stderr);
    assert!(output.stderr.is_empty(), "{args:?}: {:?}", output.stderr);
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    String::from_utf8(output.stdout).unwrap()
}

fn report(flag: &str, kind: &str) -> Value {
    let output = run(&[flag, "--json"]);
    assert_eq!(output, run(&["--json", flag]), "flag order: {flag}");
    assert_eq!(output.lines().count(), 1, "one JSON line: {flag}");
    let value: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(value["kind"], kind);
    assert_eq!(value["schema_version"], 1);
    assert_eq!(value["tool"], "ashlr-md");
    value
}

#[test]
fn version_json_and_human_output() {
    let version = env!("CARGO_PKG_VERSION");
    let expected = json!({
        "kind": "ashlr.version", "schema_version": 1,
        "tool": "ashlr-md", "version": version
    });
    for flag in ["--version", "-V"] {
        assert_eq!(report(flag, "ashlr.version"), expected);
        assert_eq!(run(&[flag]), format!("mdopener-mcp {version}\n"));
    }
}

#[test]
fn help_json_preserves_the_human_help() {
    let help = run(&["--help"]);
    assert!(help.starts_with("mdopener-mcp: MCP server for Ashlr MD"));
    for flag in ["--help", "-h"] {
        assert_eq!(run(&[flag]), help);
        assert_eq!(
            report(flag, "ashlr.help"),
            json!({"kind":"ashlr.help", "schema_version":1, "tool":"ashlr-md", "help":help})
        );
    }
}

#[test]
fn schema_json_preserves_the_existing_tool_contract() {
    let snapshot = include_str!("contract/mcp-tools.v1.json");
    assert_eq!(run(&["--export-tool-schema"]), snapshot);
    let mut expected: Value = serde_json::from_str(snapshot).unwrap();
    expected["kind"] = "ashlr.tool-schema".into();
    expected["schema_version"] = 1.into();
    expected["tool"] = "ashlr-md".into();
    assert_eq!(
        report("--export-tool-schema", "ashlr.tool-schema"),
        expected
    );
}

#[test]
fn existing_doctor_and_handshake_json_stay_versioned() {
    for (args, kind) in [
        (vec!["doctor", "--json"], "ashlr.doctor"),
        (vec!["doctor", "--fix", "--json"], "ashlr.doctor"),
        (vec!["--ashlr-handshake", "--json"], "ashlr.handshake"),
    ] {
        let output = run(&args);
        let value: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["kind"], kind);
    }
}
