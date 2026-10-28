//! End-to-end stdio handshake against the real `mdopener-mcp` binary, the way
//! an MCP client such as Claude Code drives it: initialize, the initialized
//! notification, tools/list, a tools/call that needs no running app, and a
//! tools/call that fails because the app is not running (an `isError` result).
//! HOME points at an empty temp dir so no real `~/.mdopener` is read.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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
             Launch it first, or use open_file which can start it automatically. If it \
             is not installed, ask the user to install it from \
             https://github.com/ashlrai/ashlr-md/releases."
        );
    }
}

/// `--version` / `--help` answer and exit 0 instead of serving stdio (stdin is
/// left open, so a server that ignored the flag would hang the test).
#[test]
fn version_and_help_flags_exit_without_serving() {
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

#[test]
fn ashlr_handshake_prints_one_json_line_without_reading_stdin() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .args(["--ashlr-handshake", "--json"])
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert_eq!(stdout.trim().lines().count(), 1);
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(v["kind"], "ashlr.handshake");
    assert_eq!(v["schema_version"], 1);
    assert_eq!(v["command"], "mdopener-mcp");
    assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
}

#[path = "../../../src/review_store.rs"]
#[allow(dead_code)]
mod review_store;

/// Call `get_user_annotations` for `file` against the real binary with the
/// app not running (empty HOME except what the test planted).
fn annotations(home: &std::path::Path, file: &str) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .env("HOME", home)
        .env("USERPROFILE", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    {
        let stdin = child.stdin.as_mut().unwrap();
        for r in [
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "test", "version": "test"}}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
                "name":"get_user_annotations","arguments":{"path": file}}}),
        ] {
            writeln!(stdin, "{r}").unwrap();
        }
    }
    drop(child.stdin.take());
    let out: Vec<Value> = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .map(|l| serde_json::from_str(&l.unwrap()).unwrap())
        .collect();
    assert!(child.wait().unwrap().success());
    let call = out.iter().find(|r| r["id"] == 2).unwrap();
    assert_ne!(call["result"]["isError"], true, "{call}");
    serde_json::from_str(call["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

/// With the app closed, the review it saved in ~/.mdopener/reviews/ is
/// reported, and once the file changes it reads `stale`, so an approval of
/// an earlier version is never presented as current.
#[test]
fn get_user_annotations_reports_the_saved_review_when_the_app_is_closed() {
    let home = tempfile::tempdir().unwrap();
    let docs = tempfile::tempdir().unwrap();
    let file = docs.path().join("plan.md");
    std::fs::write(&file, "# Plan\n- [x] write it\n").unwrap();
    let path = std::fs::canonicalize(&file).unwrap();
    let path = path.to_str().unwrap();

    // No saved review: verdict null, not stale.
    let v = annotations(home.path(), path);
    assert!(v["verdict"].is_null(), "{v}");
    assert_eq!(v["appRunning"], false);
    assert!(v.get("stale").is_none(), "{v}");

    let dir = home.path().join(".mdopener").join("reviews");
    let saved = review_store::SavedReview::new(
        path,
        "r1",
        "approved",
        Some("looks good".into()),
        true,
        None,
        1_000,
        2_000,
    );
    assert!(review_store::save(&dir, &saved).unwrap());

    let v = annotations(home.path(), path);
    assert_eq!(v["verdict"], "approved", "{v}");
    assert_eq!(v["comments"], "looks good");
    assert_eq!(v["late"], true);
    assert_eq!(v["reviewId"], "r1");
    assert_eq!(v["reviewedAt"], 2_000);
    assert_eq!(v["appRunning"], false);
    assert_eq!(v["stale"], false, "{v}");
    assert_eq!(v["tasks"][0]["checked"], true);

    std::fs::write(&file, "# Plan\n- [x] write it\n- [ ] new step\n").unwrap();
    let v = annotations(home.path(), path);
    assert_eq!(v["verdict"], "approved");
    assert_eq!(v["stale"], true, "{v}");
    assert_eq!(v["appRunning"], false);
    let note = v["note"].as_str().unwrap();
    assert!(
        note.contains("earlier") && note.contains("request_review"),
        "{note}"
    );

    // A corrupt record is ignored, not trusted.
    std::fs::write(review_store::review_file(&dir, path), "{oops").unwrap();
    let v = annotations(home.path(), path);
    assert!(v["verdict"].is_null(), "{v}");
}

/// How long a test gives the server to exit once its stdin has ended.
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);

/// Assert `child` exits cleanly within [`EXIT_TIMEOUT`]; `why` names what
/// should have ended it. A server that kept running after its stdin ended
/// would linger as an orphan, so the wait is bounded and the failure loud.
fn wait_for_clean_exit(child: &mut std::process::Child, why: &str) {
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "{why}: exit status {status}");
            return;
        }
        if start.elapsed() > EXIT_TIMEOUT {
            let _ = child.kill();
            panic!("{why}: still running after {EXIT_TIMEOUT:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A client that exits cleanly closes the server's stdin; the server must
/// then exit rather than linger.
#[test]
fn server_exits_when_stdin_is_closed() {
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    assert!(
        child.try_wait().unwrap().is_none(),
        "server exited before stdin was closed"
    );
    drop(child.stdin.take());
    wait_for_clean_exit(&mut child, "stdin closed");
}

/// Parent death reaches a stdio server as stdin EOF: the write end of its
/// stdin pipe is closed when the parent process dies, however the parent
/// died. Here that write end is held by a second copy of the binary standing
/// in for the MCP client (its own stdin is kept open so it goes on serving),
/// and killing it must end the server instead of leaving an orphan behind.
#[test]
fn server_exits_when_the_process_holding_its_stdin_dies() {
    let home = tempfile::tempdir().unwrap();
    let (reader, writer) = std::io::pipe().unwrap();
    let mut server = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(reader)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    // Stand-in for the client: a live process that holds the write end of
    // the server's stdin as its own stdout, which it never writes.
    let mut parent = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::piped())
        .stdout(writer)
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let parent_stdin = parent.stdin.take().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        server.try_wait().unwrap().is_none(),
        "server exited while its parent lived"
    );
    parent.kill().unwrap();
    parent.wait().unwrap();
    drop(parent_stdin);
    wait_for_clean_exit(&mut server, "parent process died");
}

/// A single stdin line past the server's limit (4 * MAX_DOCUMENT_BYTES) is
/// dropped as it is read rather than buffered whole, answered with a -32600
/// error, and the session goes on. `serve_bounded` covers the reader; this
/// drives the real binary end to end.
#[test]
fn an_oversized_message_is_refused_and_the_session_goes_on() {
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
        let mut stdin = child.stdin.take().unwrap();
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"pad\":\"")
            .unwrap();
        let chunk = [b'a'; 1 << 20];
        for _ in 0..70 {
            stdin.write_all(&chunk).unwrap();
        }
        stdin.write_all(b"\"}\n").unwrap();
        writeln!(stdin, "{}", json!({"jsonrpc":"2.0","id":2,"method":"ping"})).unwrap();
    }
    wait_for_clean_exit(&mut child, "oversized message then stdin closed");
    let mut text = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take().unwrap(), &mut text).unwrap();
    let lines: Vec<Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).expect("stdout must be JSON-RPC only"))
        .collect();
    assert_eq!(lines.len(), 2, "{text}");
    assert_eq!(lines[0]["id"], Value::Null, "{:?}", lines[0]);
    assert_eq!(lines[0]["error"]["code"], -32600, "{:?}", lines[0]);
    let msg = lines[0]["error"]["message"].as_str().unwrap();
    assert!(msg.contains("longer than"), "{msg}");
    assert_eq!(lines[1], json!({"jsonrpc":"2.0","id":2,"result":{}}));
}

/// `ipc-port` and `ipc-token` under `~/.mdopener` are read once for every
/// request to the app. A FIFO used to block that read (and the request)
/// forever, and a file of any size was read whole; both are now refused, so
/// the tool reports the app as not running.
#[cfg(unix)]
#[test]
fn an_ipc_state_file_that_is_a_fifo_or_oversized_is_refused_not_read() {
    let call = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"get_current_content","arguments":{}}});
    for fifo in [true, false] {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".mdopener");
        std::fs::create_dir_all(&dir).unwrap();
        let port = dir.join("ipc-port");
        if fifo {
            let status = Command::new("mkfifo").arg(&port).status().unwrap();
            assert!(status.success(), "mkfifo failed");
        } else {
            // Past the 8 KiB the file may be: the app writes at most a
            // five-digit port.
            std::fs::write(&port, "9".repeat(16 * 1024)).unwrap();
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
        wait_for_clean_exit(&mut child, "ipc-port is a fifo or oversized");
        let mut text = String::new();
        std::io::Read::read_to_string(&mut child.stdout.take().unwrap(), &mut text).unwrap();
        let reply: Value = serde_json::from_str(text.trim()).unwrap();
        let text = reply["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("ipc-port not found"), "fifo={fifo}: {text}");
    }
}
