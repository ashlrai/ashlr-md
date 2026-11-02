//! Offline flagship coverage with HOME in a temp dir and a fake OpenAI-compatible
//! server on a 127.0.0.1 port-0 listener (plain std TCP, no Ollama required).
//! Doctor and setup argument checks run the real binary. Setup collection and
//! rendering inject default-server findings of chosen reachability instead of
//! probing fixed ports, so no test depends on services on 11434 or 8000; the
//! configured fake server still gets a real probe.
//!
//! - `doctor` reports `offline [ok] verified` when `localInference.offline`
//!   is on and the loopback server answers, `unverified` when it does not,
//!   and `not enabled` when offline is off. `--json` adds the `offline` check
//!   to the `ashlr.doctor` v1 envelope without changing the first check.
//! - `setup --local` finds the configured server, prints the exact pull and
//!   config commands, and downloads nothing and writes nothing: the server
//!   sees only the probe's GET of the model list (no key), HOME is byte for
//!   byte unchanged, and no model is fetched.

use mdopener_mcp::{local_inference_probe::ProbeResult, offline};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// A fake OpenAI-compatible server: answers `GET /v1/models` with one model,
/// anything else with 404, and records every request's head (request line
/// and headers). Stopped by the flag; `stop()` joins it and returns the log.
struct FakeServer {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl FakeServer {
    fn start() -> Self {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        l.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (req2, stop2) = (requests.clone(), stop.clone());
        let handle = thread::spawn(move || {
            while !stop2.load(Ordering::SeqCst) {
                let Ok((mut s, _)) = l.accept() else {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                };
                s.set_nonblocking(false).unwrap();
                s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut raw = Vec::new();
                let mut buf = [0u8; 2048];
                while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    match s.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => raw.extend_from_slice(&buf[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&raw).into_owned();
                let body = if head.starts_with("GET /v1/models ") {
                    Some(r#"{"object":"list","data":[{"id":"qwen3.8:27b","object":"model"}]}"#)
                } else {
                    None
                };
                let reply = match body {
                    Some(b) => format!(
                        "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{b}",
                        b.len()
                    ),
                    None => "HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_string(),
                };
                let _ = s.write_all(reply.as_bytes());
                req2.lock().unwrap().push(head);
            }
        });
        FakeServer {
            port,
            requests,
            stop,
            handle: Some(handle),
        }
    }

    fn stop(mut self) -> Vec<String> {
        self.stop.store(true, Ordering::SeqCst);
        self.handle.take().unwrap().join().unwrap();
        self.requests.lock().unwrap().clone()
    }
}

/// A HOME whose `~/.ashlr/config.json` points `openai-compat` at the port.
fn home_with(port: u16, offline: Option<bool>) -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".ashlr")).unwrap();
    let offline = offline
        .map(|b| format!(r#","offline":{b}"#))
        .unwrap_or_default();
    std::fs::write(
        home.path().join(".ashlr").join("config.json"),
        format!(
            r#"{{"localInference":{{"provider":"openai-compat","baseUrl":"http://127.0.0.1:{port}/v1"{offline}}}}}"#
        ),
    )
    .unwrap();
    home
}

fn run(home: &Path, args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .args(args)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home)
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// Inject findings rather than let a developer's Ollama/oMLX decide the
/// report. The order and URLs still come from the production default list.
fn default_servers(reachable: &[&str]) -> Vec<offline::ServerFinding> {
    offline::DEFAULT_SERVERS
        .iter()
        .map(|d| {
            let reachable = reachable.contains(&d.provider);
            offline::ServerFinding {
                provider: d.provider.into(),
                base_url: d.base_url.into(),
                probe: ProbeResult {
                    status: if reachable {
                        "reachable"
                    } else {
                        "unreachable"
                    },
                    provider: Some(d.provider.into()),
                    loopback: true,
                    reachable,
                    http_status: reachable.then_some(200),
                    model_count: usize::from(reachable),
                    reason: (!reachable).then(|| "connect-failed".into()),
                    bytes_read: 0,
                },
            }
        })
        .collect()
}

/// Exercise collection and rendering with deterministic default findings.
/// Only the configured ephemeral server is probed; fixed ports are never used.
fn setup_local(home: &Path, reachable: &[&str], json_output: bool) -> String {
    let root = std::fs::read(home.join(".ashlr/config.json"))
        .ok()
        .map(|bytes| serde_json::from_slice::<Value>(&bytes).unwrap());
    let report = offline::collect_with_servers(
        root.as_ref(),
        Duration::from_secs(3),
        default_servers(reachable),
    );
    if json_output {
        offline::render_json(&report)
    } else {
        offline::render_text(&report)
    }
}

/// Every file under `root` with its bytes, sorted.
fn snapshot(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push((p.display().to_string(), std::fs::read(&p).unwrap()));
            }
        }
    }
    out.sort();
    out
}

/// The requests the server saw: only GETs of the model list, with no key.
fn assert_only_model_list_gets(requests: &[String]) {
    assert!(!requests.is_empty(), "the server was never probed");
    for r in requests {
        assert!(r.starts_with("GET /v1/models HTTP/1.0\r\n"), "{r}");
        let lower = r.to_ascii_lowercase();
        for banned in ["authorization", "x-api-key", "bearer", "cookie", "phm_"] {
            assert!(!lower.contains(banned), "{banned} in {r}");
        }
    }
}

/// The `ashlr.doctor` v1 shape the vendored contract requires, for a document
/// with the `offline` check added.
fn assert_doctor_envelope(d: &Value) {
    assert_eq!(d["kind"], "ashlr.doctor");
    assert_eq!(d["schema_version"], 1);
    assert_eq!(d["tool"], "ashlr-md");
    assert!(["ok", "warn", "fail"].contains(&d["status"].as_str().unwrap()));
    assert!(d["native_status"].is_string());
    let checks = d["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 2, "{d}");
    for c in checks {
        let id = c["id"].as_str().unwrap();
        assert!(
            id.split('-').all(|p| !p.is_empty()
                && p.chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())),
            "{id}"
        );
        assert!(["ok", "warn", "fail", "info"].contains(&c["status"].as_str().unwrap()));
        assert!(c["summary"].is_string());
    }
    assert_eq!(checks[0]["id"], "local-inference");
    assert_eq!(checks[1]["id"], "offline");
}

#[test]
fn doctor_reports_offline_verified_when_the_loopback_server_answers() {
    let server = FakeServer::start();
    let home = home_with(server.port, Some(true));

    let (code, text, err) = run(home.path(), &["doctor"]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        text,
        "doctor: local-inference [ok] openai-compat: reachable, 1 model(s)\n\
         doctor: offline [ok] verified: openai-compat answered on loopback and no remote endpoint is used; cloud AI is disabled\n"
    );

    let (code, json, _) = run(home.path(), &["doctor", "--json"]);
    assert_eq!(code, 0);
    let d: Value = serde_json::from_str(&json).unwrap();
    assert_doctor_envelope(&d);
    assert_eq!(d["status"], "ok");
    assert_eq!(d["native_status"], "reachable");
    assert_eq!(d["checks"][0]["status"], "ok");
    assert_eq!(d["checks"][0]["native_status"], "reachable");
    assert_eq!(d["checks"][0]["probe"]["loopback"], true);
    assert_eq!(d["checks"][0]["probe"]["modelCount"], 1);
    assert_eq!(d["checks"][1]["status"], "ok");
    assert_eq!(d["checks"][1]["native_status"], "verified");
    assert!(d["checks"][1]["summary"]
        .as_str()
        .unwrap()
        .starts_with("verified: openai-compat answered on loopback"));

    // Value-free: no port, no URL and no model id in either output.
    for out in [&text, &json] {
        assert!(!out.contains(&format!(":{}", server.port)), "{out}");
        assert!(!out.contains("127.0.0.1"), "{out}");
        assert!(!out.contains("qwen"), "{out}");
    }
    let requests = server.stop();
    assert_eq!(requests.len(), 2, "one probe per doctor run: {requests:?}");
    assert_only_model_list_gets(&requests);
}

#[test]
fn doctor_reports_unverified_when_offline_is_on_but_nothing_answers() {
    // A loopback port with nothing listening.
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let home = home_with(port, Some(true));
    let (code, text, _) = run(home.path(), &["doctor"]);
    assert_eq!(code, 0, "a warning never fails doctor");
    assert!(
        text.starts_with(
            "doctor: local-inference [warn] openai-compat: unreachable (connect-failed)"
        ),
        "{text}"
    );
    assert!(
        text.contains("doctor: offline [warn] unverified: openai-compat did not answer on loopback; cloud AI is disabled"),
        "{text}"
    );
    assert!(text.contains("mdopener-mcp setup --local"), "{text}");
    let (code, json, _) = run(home.path(), &["doctor", "--json"]);
    assert_eq!(code, 0);
    let d: Value = serde_json::from_str(&json).unwrap();
    assert_doctor_envelope(&d);
    assert_eq!(d["status"], "warn");
    assert_eq!(d["native_status"], "unreachable");
    assert_eq!(d["checks"][1]["native_status"], "unverified");
    assert_eq!(d["checks"][1]["status"], "warn");

    // Offline on, but the block is invalid (a remote base URL): the gate
    // refuses it, nothing is contacted, and offline is unverified.
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".ashlr")).unwrap();
    std::fs::write(
        home.path().join(".ashlr").join("config.json"),
        r#"{"localInference":{"provider":"openai-compat","baseUrl":"https://gpu.example.com/v1","allowRemote":true,"offline":true}}"#,
    )
    .unwrap();
    let (code, json, _) = run(home.path(), &["doctor", "--json"]);
    assert_eq!(code, 0);
    let d: Value = serde_json::from_str(&json).unwrap();
    assert_doctor_envelope(&d);
    assert_eq!(d["native_status"], "config-invalid");
    assert_eq!(d["status"], "fail");
    assert_eq!(d["checks"][1]["native_status"], "unverified");
    assert!(!json.contains("gpu.example.com"), "{json}");
}

#[test]
fn doctor_reports_offline_not_enabled_when_the_flag_is_off() {
    let server = FakeServer::start();
    for offline in [None, Some(false)] {
        let home = home_with(server.port, offline);
        let (code, text, _) = run(home.path(), &["doctor"]);
        assert_eq!(code, 0);
        assert!(
            text.starts_with("doctor: local-inference [ok] openai-compat: reachable, 1 model(s)\n"),
            "{text}"
        );
        assert!(
            text.contains("doctor: offline [info] not enabled: cloud AI stays available; set \"offline\": true"),
            "{text}"
        );
        let (_, json, _) = run(home.path(), &["doctor", "--json"]);
        let d: Value = serde_json::from_str(&json).unwrap();
        assert_doctor_envelope(&d);
        assert_eq!(d["status"], "ok", "info never raises the status");
        assert_eq!(d["checks"][1]["status"], "info");
        assert_eq!(d["checks"][1]["native_status"], "not-enabled");
    }
    // A fresh HOME: not configured, offline not enabled, exit 0.
    let fresh = tempfile::tempdir().unwrap();
    let (code, text, _) = run(fresh.path(), &["doctor"]);
    assert_eq!(code, 0);
    assert_eq!(
        text,
        "doctor: local-inference [ok] not configured (no localInference in ~/.ashlr/config.json)\n\
         doctor: offline [info] not enabled: cloud AI stays available; set \"offline\": true on localInference in ~/.ashlr/config.json to allow loopback only\n"
    );
    assert_only_model_list_gets(&server.stop());
}

#[test]
fn setup_report_finds_the_configured_server_and_downloads_nothing() {
    let server = FakeServer::start();
    let home = home_with(server.port, Some(false));
    let before = snapshot(home.path());

    let t = Instant::now();
    // Both defaults answer: the configured provider must still win.
    let text = setup_local(home.path(), &["ollama", "omlx"], false);
    assert!(
        text.starts_with(
            "setup --local: local model servers on loopback (downloads nothing, writes nothing)\n"
        ),
        "{text}"
    );
    // The default-server results are exact, independent of local services.
    for (provider, url) in [
        ("ollama", "http://127.0.0.1:11434/v1"),
        ("omlx", "http://127.0.0.1:8000/v1"),
    ] {
        let line = text
            .lines()
            .find(|l| l.trim_start().starts_with(provider) && l.contains(url))
            .unwrap_or_else(|| panic!("no {provider} line in {text}"));
        assert!(line.ends_with("reachable, 1 model(s)"), "{line}");
    }
    assert!(
        text.contains("config   ~/.ashlr/config.json       openai-compat: reachable, 1 model(s); offline: off\n"),
        "{text}"
    );
    assert!(text.contains("next:\n"), "{text}");
    assert!(
        text.contains("download `qwen3.8:27b` with your server's own tool"),
        "the configured (default) model is named in the pull step: {text}"
    );
    assert!(
        text.contains("Add to the existing localInference block in ~/.ashlr/config.json so cloud AI is refused (setup writes nothing):\n       \"offline\": true\n"),
        "{text}"
    );
    assert!(text.contains("       mdopener-mcp doctor\n"), "{text}");
    // Value-free: the configured server's port never appears.
    assert!(!text.contains(&format!(":{}", server.port)), "{text}");
    // Only the configured server is probed, with a bounded timeout.
    assert!(t.elapsed() < Duration::from_secs(12), "{:?}", t.elapsed());

    let json = setup_local(home.path(), &["ollama", "omlx"], true);
    let v: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["kind"], "ashlr.setup-local");
    assert_eq!(v["schema_version"], 1);
    assert_eq!(v["tool"], "ashlr-md");
    assert_eq!(v["downloads"], false);
    assert_eq!(v["writes"], false);
    let servers = v["servers"].as_array().unwrap();
    assert_eq!(servers.len(), 2);
    assert_eq!(servers[0]["provider"], "ollama");
    assert_eq!(servers[1]["provider"], "omlx");
    for s in servers {
        assert_eq!(s["probe"]["status"], "reachable");
        assert_eq!(s["probe"]["modelCount"], 1);
    }
    assert_eq!(v["config"]["status"], "ok");
    assert_eq!(v["config"]["offline"], false);
    assert_eq!(v["config"]["provider"], "openai-compat");
    assert_eq!(v["config"]["probe"]["status"], "reachable");
    assert_eq!(v["config"]["probe"]["modelCount"], 1);
    assert_eq!(v["recommended"]["provider"], "openai-compat");
    assert_eq!(v["recommended"]["model"], "qwen3.8:27b");
    assert_eq!(v["recommended"]["reachable"], true);
    assert!(v["recommended"]["pullCommand"].is_null());
    assert_eq!(v["config_snippet"], serde_json::json!({ "offline": true }));
    assert_eq!(v["next"].as_array().unwrap().len(), 3);
    assert!(!json.contains(&format!(":{}", server.port)), "{json}");

    // Nothing written anywhere under HOME, and the server saw only the
    // probe's GET of the model list: no pull, no key, nothing else.
    assert_eq!(snapshot(home.path()), before, "setup wrote into HOME");
    let requests = server.stop();
    assert_eq!(requests.len(), 2, "one probe per report: {requests:?}");
    assert_only_model_list_gets(&requests);
}

#[test]
fn setup_report_on_a_fresh_machine_prints_the_ollama_pull_and_block() {
    let home = tempfile::tempdir().unwrap();
    let text = setup_local(home.path(), &[], false);
    // Neither default answers: the report says so exactly, whatever the host runs.
    for (provider, url) in [
        ("ollama", "http://127.0.0.1:11434/v1"),
        ("omlx", "http://127.0.0.1:8000/v1"),
    ] {
        assert!(
            text.contains(&format!(
                "{provider:<8} {url:<26} not running (connect-failed)\n"
            )),
            "{text}"
        );
    }
    assert!(
        text.contains("config   ~/.ashlr/config.json       no localInference block\n"),
        "{text}"
    );
    // The next steps name the exact commands: the Ollama pull, the block to
    // add, the check.
    assert!(text.contains("next:\n  1. "), "{text}");
    assert!(text.contains("  2. Add to ~/.ashlr/config.json (setup writes nothing):\n       \"localInference\": { \"provider\": \"ollama\", \"offline\": true }\n"), "{text}");
    assert!(
        text.contains(
            "  3. Check it (expect `doctor: offline [ok] verified`):\n       mdopener-mcp doctor\n"
        ),
        "{text}"
    );
    let json = setup_local(home.path(), &[], true);
    let v: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["config"]["status"], "absent");
    let servers = v["servers"].as_array().unwrap();
    assert_eq!(servers.len(), 2);
    for s in servers {
        assert_eq!(s["probe"]["status"], "unreachable");
        assert_eq!(s["probe"]["reason"], "connect-failed");
    }
    assert_eq!(v["recommended"]["provider"], "ollama");
    assert_eq!(v["recommended"]["reachable"], false);
    assert_eq!(v["recommended"]["pullCommand"], "ollama pull qwen3.8:27b");
    assert!(
        text.contains("\n       ollama pull qwen3.8:27b\n"),
        "{text}"
    );
    assert!(text.contains("setup never starts it"), "{text}");
    assert_eq!(v["config_snippet"]["localInference"]["offline"], true);
    assert!(
        std::fs::read_dir(home.path()).unwrap().next().is_none(),
        "setup created something in a fresh HOME"
    );
}

#[test]
fn setup_report_selects_the_first_reachable_default_server() {
    for (reachable, expected) in [
        (vec!["omlx"], "omlx"),
        (vec!["ollama"], "ollama"),
        (vec!["ollama", "omlx"], "ollama"),
    ] {
        let report = offline::build(
            default_servers(&reachable),
            offline::ConfigFinding {
                status: "absent",
                offline: false,
                provider: None,
                probe: None,
            },
            "qwen3.8:27b".into(),
        );
        let text = offline::render_text(&report);
        let v: Value = serde_json::from_str(&offline::render_json(&report)).unwrap();
        assert_eq!(v["recommended"]["provider"], expected, "{reachable:?}");
        assert_eq!(v["recommended"]["reachable"], true);
        assert_eq!(
            v["config_snippet"],
            serde_json::json!({"localInference": {"provider": expected, "offline": true}})
        );
        assert!(
            text.contains(&format!("\"provider\": \"{expected}\", \"offline\": true")),
            "{text}"
        );
        if expected == "ollama" {
            assert_eq!(v["recommended"]["pullCommand"], "ollama pull qwen3.8:27b");
            assert!(
                text.contains("\n       ollama pull qwen3.8:27b\n"),
                "{text}"
            );
        } else {
            assert!(v["recommended"]["pullCommand"].is_null());
            assert!(text.contains("oMLX has no pull command"), "{text}");
            assert!(!text.contains("ollama pull"), "{text}");
        }
    }
}

#[test]
fn setup_report_reuses_injected_default_for_a_matching_config() {
    for (reachable, status) in [
        (&[] as &[&str], "unreachable"),
        (&["ollama"][..], "reachable"),
    ] {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".ashlr")).unwrap();
        std::fs::write(
            home.path().join(".ashlr/config.json"),
            r#"{"localInference":{"provider":"ollama","offline":true}}"#,
        )
        .unwrap();
        let before = snapshot(home.path());
        let output = setup_local(home.path(), reachable, true);
        let report: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(report["config"]["probe"], report["servers"][0]["probe"]);
        assert_eq!(report["config"]["probe"]["status"], status);
        assert_eq!(report["config"]["offline"], true);
        assert_eq!(report["recommended"]["reachable"], status == "reachable");
        assert_eq!(snapshot(home.path()), before);
    }
}

#[test]
fn setup_without_local_prints_usage_and_unknown_arguments_exit_2() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = run(home.path(), &["setup"]);
    assert_eq!(code, 0);
    assert!(
        out.starts_with("USAGE:\n    mdopener-mcp setup --local [--json]"),
        "{out}"
    );
    assert!(err.is_empty());
    let (code, out, err) = run(home.path(), &["setup", "--help"]);
    assert_eq!(code, 0);
    assert!(
        out.contains("downloads nothing and writes nothing"),
        "{out}"
    );
    assert!(err.is_empty());
    let (code, out, err) = run(home.path(), &["setup", "--local", "--apply"]);
    assert_eq!(code, 2);
    assert!(out.is_empty(), "{out}");
    assert!(
        err.starts_with("mdopener-mcp setup: unknown argument `--apply`\n"),
        "{err}"
    );
    // `--help` names the new command.
    let (code, out, _) = run(home.path(), &["--help"]);
    assert_eq!(code, 0);
    assert!(out.contains("mdopener-mcp setup --local [--json]"), "{out}");
    assert!(out.contains("downloads and writes nothing"), "{out}");
}
