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
        assert_eq!(
            out[0]["result"]["serverInfo"]["version"],
            app_version(),
            "{protocol}"
        );
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
        // Said once: the reason in parentheses used to ask "Is Ashlr MD
        // running?" again inside "does not appear to be running".
        let text = out[4]["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(
            text,
            "Ashlr MD does not appear to be running (~/.mdopener/ipc-port not found). \
             Launch it first, or use open_file which can start it automatically."
        );
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

/// `--help` and `--version` printed with `print!`, which panics when stdout
/// cannot be written: exit 101 and a backtrace for `mdopener-mcp --help |
/// head -c1` once the reader had closed, or for a full disk. A closed reader
/// now exits 0 in silence, and a failed write says so on stderr with exit 1.
#[cfg(target_os = "linux")]
#[test]
fn help_and_version_to_an_unwritable_stdout_do_not_panic() {
    for flag in ["--help", "-h", "--version", "-V"] {
        let full = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/full")
            .unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
            .arg(flag)
            .stdin(Stdio::null())
            .stdout(full)
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(1), "{flag}: {stderr}");
        assert!(
            stderr.starts_with("mdopener-mcp: cannot write to stdout:"),
            "{flag}: {stderr}"
        );
        assert_eq!(stderr.lines().count(), 1, "{flag}: {stderr}");

        let (reader, writer) = std::io::pipe().unwrap();
        drop(reader);
        let out = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
            .arg(flag)
            .stdin(Stdio::null())
            .stdout(writer)
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(0), "{flag}: {out:?}");
        assert!(out.stderr.is_empty(), "{flag}: {out:?}");
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

/// A `notifications/*` method sent with an `id` is a request, so it is
/// answered (-32600 with that id) instead of dropped like a notification:
/// before, the client waited on that id forever. Without an id it stays
/// silent, alone and inside a batch.
#[test]
fn notification_method_with_an_id_is_answered() {
    let out = raw_session(&[
        r#"{"jsonrpc":"2.0","id":1,"method":"notifications/initialized"}"#,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        r#"[{"jsonrpc":"2.0","id":"c","method":"notifications/cancelled","params":{"requestId":1}},{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}]"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#,
    ]);
    assert_eq!(out.len(), 3, "{out:?}");
    assert_eq!(out[0]["id"], 1);
    assert_eq!(out[0]["error"]["code"], -32600, "{:?}", out[0]);
    let msg = out[0]["error"]["message"].as_str().unwrap();
    assert!(msg.contains("notifications/initialized"), "{msg}");
    let batch = out[1].as_array().expect("batch reply is an array");
    assert_eq!(batch.len(), 1, "{batch:?}");
    assert_eq!(batch[0]["id"], "c");
    assert_eq!(batch[0]["error"]["code"], -32600);
    assert_eq!(out[2], json!({"jsonrpc":"2.0","id":2,"result":{}}));
}

/// The JSON-RPC envelope is checked before a request is served: `jsonrpc`
/// must be "2.0", `params` structured, and (MCP) the `id` a string or an
/// integer, never `null`. Each of these used to be answered as a valid ping.
/// An id that is not valid is not echoed back.
#[test]
fn invalid_envelopes_are_refused_with_32600() {
    let out = raw_session(&[
        r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#,
        r#"{"jsonrpc":2,"id":2,"method":"ping"}"#,
        r#"{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}"#,
        r#"{"jsonrpc":"2.0","id":1.5,"method":"ping"}"#,
        r#"{"jsonrpc":"2.0","id":true,"method":"ping"}"#,
        r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#,
        r#"{"jsonrpc":"2.0","id":3,"method":"ping","params":"x"}"#,
        r#"[{"jsonrpc":"2.0","id":[4],"method":"ping"},{"jsonrpc":"2.0","id":5,"method":"ping"}]"#,
        r#"{"jsonrpc":"2.0","id":"s","method":"ping","params":{}}"#,
        r#"{"jsonrpc":"2.0","id":-6,"method":"ping","params":null}"#,
    ]);
    assert_eq!(out.len(), 10, "{out:?}");
    let expect_ids = [
        json!(1),
        json!(2),
        Value::Null,
        Value::Null,
        Value::Null,
        Value::Null,
        json!(3),
    ];
    for (reply, id) in out.iter().zip(expect_ids) {
        assert_eq!(reply["error"]["code"], -32600, "{reply:?}");
        assert_eq!(reply["id"], id, "{reply:?}");
        assert!(reply.get("result").is_none(), "{reply:?}");
    }
    assert!(out[0]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("jsonrpc"));
    assert!(out[2]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("`id`"));
    assert!(out[6]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("params"));
    let batch = out[7].as_array().expect("batch reply is an array");
    assert_eq!(batch[0]["error"]["code"], -32600);
    assert_eq!(batch[0]["id"], Value::Null);
    assert_eq!(batch[1], json!({"jsonrpc":"2.0","id":5,"result":{}}));
    assert_eq!(out[8], json!({"jsonrpc":"2.0","id":"s","result":{}}));
    assert_eq!(out[9], json!({"jsonrpc":"2.0","id":-6,"result":{}}));
}

/// An unknown command-line argument is still ignored (old client configs may
/// pass one) but named in one stderr line, and stdout stays JSON-RPC only.
/// Before, a typo such as `--verison` started the server without a word.
#[test]
fn unknown_argument_is_named_on_stderr_and_the_server_still_serves() {
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .args(["--verison", "--stdio"])
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.as_mut().unwrap(),
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":"ping"})
    )
    .unwrap();
    drop(child.stdin.take());
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{out:?}");
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert_eq!(stdout, "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n");
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert_eq!(stderr.lines().count(), 1, "one line: {stderr:?}");
    assert!(
        stderr.contains("ignoring unknown arguments `--verison`, `--stdio`"),
        "stderr: {stderr:?}"
    );
    assert!(stderr.contains("--help"), "stderr: {stderr:?}");
}

fn has_dash(s: &str) -> bool {
    s.contains('\u{2014}') || s.contains('\u{2013}')
}

/// The not-running error (no `ipc-port`, then an empty `ipc-token`) and the
/// `--help` text carry no em or en dash: the product rule is none in
/// user-facing strings.
#[test]
fn not_running_errors_and_help_have_no_em_or_en_dashes() {
    let call = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"get_current_content","arguments":{}}});
    for token_file in [false, true] {
        let home = tempfile::tempdir().unwrap();
        if token_file {
            let dir = home.path().join(".mdopener");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("ipc-port"), "9").unwrap();
            std::fs::write(dir.join("ipc-token"), "").unwrap();
        }
        let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        writeln!(child.stdin.as_mut().unwrap(), "{call}").unwrap();
        drop(child.stdin.take());
        let out = child.wait_with_output().unwrap();
        let reply: Value = serde_json::from_slice(&out.stdout).unwrap();
        let text = reply["result"]["content"][0]["text"].as_str().unwrap();
        let expect = if token_file { "ipc-token" } else { "ipc-port" };
        assert!(text.contains(expect), "{text}");
        assert!(!has_dash(text), "{text}");
    }
    let help = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .arg("--help")
        .output()
        .unwrap();
    let help = String::from_utf8(help.stdout).unwrap();
    assert!(help.starts_with("mdopener-mcp"), "{help}");
    assert!(!has_dash(&help), "{help}");
}

/// An empty `ipc-token` asked "Has Ashlr MD finished starting?" and gave no
/// next step. The tool error says to retry once the app has launched, or
/// to restart it, as the not-running error says to launch it.
#[test]
fn empty_ipc_token_error_names_the_next_step() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join(".mdopener");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("ipc-port"), "9").unwrap();
    std::fs::write(dir.join("ipc-token"), "\n").unwrap();
    let call = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"get_current_content","arguments":{}}});
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    writeln!(child.stdin.as_mut().unwrap(), "{call}").unwrap();
    drop(child.stdin.take());
    let out = child.wait_with_output().unwrap();
    let reply: Value = serde_json::from_slice(&out.stdout).unwrap();
    let text = reply["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("ipc-token is empty"), "{text}");
    assert!(
        text.contains("Retry once it has finished launching"),
        "{text}"
    );
    assert!(text.contains("restart Ashlr MD"), "{text}");
    assert!(!text.contains('?'), "{text}");
}

/// An argument that is not valid UTF-8 used to panic in `std::env::args`
/// before the server read a request (exit 101). It is ignored and named on
/// stderr like any unknown argument, and the server answers.
#[cfg(unix)]
#[test]
fn an_argument_that_is_not_utf8_is_ignored_not_a_panic() {
    use std::os::unix::ffi::OsStrExt as _;
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .arg(std::ffi::OsStr::from_bytes(b"--x\xff"))
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.as_mut().unwrap(),
        "{}",
        json!({"jsonrpc":"2.0","id":1,"method":"ping"})
    )
    .unwrap();
    drop(child.stdin.take());
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{out:?}");
    let reply: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(reply["id"], 1, "{reply}");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("ignoring unknown argument `--x\u{FFFD}`"),
        "{stderr}"
    );
    assert!(!stderr.contains("panicked"), "{stderr}");
}
