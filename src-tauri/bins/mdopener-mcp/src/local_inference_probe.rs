//! Local inference reachability for `mdopener-mcp doctor` and the
//! `local-inference-probe` handshake capability. Mirrors phantom #920
//! (`local-inference-probe.ts`) and #921 (streamed body cap).
//!
//! - The `localInference` block in `~/.ashlr/config.json` goes through the
//!   same gate as the app (`src/local_inference_gate.rs`, from #179). An
//!   invalid block is `config-invalid` and is never probed.
//! - Loopback only, even when `allowRemote` is set: a remote endpoint is
//!   `remote-not-probed` and never contacted.
//! - One `GET {baseUrl}/models` (omlx, openai-compat) or `GET /api/tags`
//!   (ollama), HTTP/1.0, no Authorization or any key header, 3 s overall
//!   deadline, redirects refused (never followed).
//! - The body is read in chunks and the connection is dropped as soon as it
//!   passes 256 KiB; it is never buffered whole and then checked.
//! - Output is value-free: status, provider, loopback, reachable, httpStatus,
//!   modelCount. No URL, header, error text, body or model id.

use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

#[allow(dead_code)]
#[path = "../../../src/local_inference_gate.rs"]
mod gate;

pub const CAPABILITY: &str = "local-inference-probe";
pub const CONFIG_CHECK_ID: &str = "local-inference-config";
pub const MAX_BODY_BYTES: usize = 256 * 1024;
pub const CHUNK_BYTES: usize = 16 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    /// not-configured | config-invalid | remote-not-probed | reachable |
    /// unreachable | bad-response
    pub status: &'static str,
    pub provider: Option<String>,
    pub loopback: bool,
    pub reachable: bool,
    pub http_status: Option<u16>,
    pub model_count: usize,
    /// A closed, value-free reason code.
    pub reason: Option<String>,
    /// Bytes read from the socket (tests check the cap with this).
    #[serde(skip)]
    pub bytes_read: usize,
}

fn base(status: &'static str, provider: Option<&str>, loopback: bool) -> ProbeResult {
    ProbeResult {
        status,
        provider: provider.map(str::to_string),
        loopback,
        reachable: false,
        http_status: None,
        model_count: 0,
        reason: None,
        bytes_read: 0,
    }
}

/// Handshake health for the config only (no network), as in #920:
/// `absent` when there is no file or no block, `missing` when the block is
/// invalid, `ok` when it passes the gate.
pub fn config_check_status(root: Option<&Value>) -> &'static str {
    let Some(root) = root else { return "absent" };
    match gate::parse_local_inference(root.get("localInference")) {
        Ok(Some(_)) => "ok",
        Ok(None) => "absent",
        Err(_) => "missing",
    }
}

/// [`config_check_status`] for the real `~/.ashlr/config.json`. A file that
/// exists but is not JSON counts as `missing`.
pub fn config_check() -> &'static str {
    let Some(path) = gate::config_path() else {
        return "absent";
    };
    if !path.exists() {
        return "absent";
    }
    match gate::read_config_value() {
        Some(v) => config_check_status(Some(&v)),
        None => "missing",
    }
}

fn probe_path(provider: &str, base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if provider == "ollama" {
        let root = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
        format!("{root}/api/tags")
    } else {
        format!("{trimmed}/models")
    }
}

/// Probe the `localInference` block in `root` (the parsed config file).
pub fn probe_config(root: Option<&Value>, timeout: Duration) -> ProbeResult {
    let block = root.and_then(|r| r.get("localInference"));
    let cfg = match gate::parse_local_inference(block) {
        Ok(None) => return base("not-configured", None, false),
        Ok(Some(c)) => c,
        Err(problem) => {
            let mut r = base("config-invalid", None, false);
            r.reason = Some(problem);
            return r;
        }
    };
    if !cfg.loopback {
        return base("remote-not-probed", Some(&cfg.provider), false);
    }
    let url = probe_path(&cfg.provider, &cfg.base_url);
    let mut r = base("unreachable", Some(&cfg.provider), true);
    get_capped(&url, &cfg.provider, timeout, &mut r);
    r
}

/// Probe the real config file.
pub fn probe() -> ProbeResult {
    probe_config(gate::read_config_value().as_ref(), PROBE_TIMEOUT)
}

fn remaining(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
}

fn get_capped(url: &str, provider: &str, timeout: Duration, r: &mut ProbeResult) {
    let deadline = Instant::now() + timeout;
    let Ok(u) = url::Url::parse(url) else {
        r.reason = Some("base-url-invalid".into());
        return;
    };
    let Some(host) = u.host_str().map(str::to_string) else {
        r.reason = Some("base-url-invalid".into());
        return;
    };
    let port = u.port_or_known_default().unwrap_or(80);
    let bare = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    // The gate already allowed only 127.0.0.1, [::1] and localhost; still
    // connect only to loopback addresses.
    let addrs: Vec<_> = match (bare.as_str(), port).to_socket_addrs() {
        Ok(a) => a.filter(|a| a.ip().is_loopback()).collect(),
        Err(_) => Vec::new(),
    };
    let mut tcp = None;
    for addr in addrs {
        let Some(left) = remaining(deadline) else {
            break;
        };
        if let Ok(s) = TcpStream::connect_timeout(&addr, left) {
            tcp = Some(s);
            break;
        }
    }
    let Some(tcp) = tcp else {
        r.reason = Some(
            if remaining(deadline).is_none() {
                "timeout"
            } else {
                "connect-failed"
            }
            .into(),
        );
        return;
    };
    let host_header = match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.clone(),
    };
    let request = format!(
        "GET {} HTTP/1.0\r\nHost: {host_header}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        u.path()
    );
    let raw_tcp = tcp.try_clone().ok();
    if u.scheme() == "https" {
        let Ok(connector) = native_tls::TlsConnector::new() else {
            r.reason = Some("tls-failed".into());
            return;
        };
        tcp.set_read_timeout(remaining(deadline)).ok();
        tcp.set_write_timeout(remaining(deadline)).ok();
        match connector.connect(&bare, tcp) {
            Ok(tls) => exchange(tls, raw_tcp, &request, provider, deadline, r),
            Err(_) => r.reason = Some("tls-failed".into()),
        }
    } else {
        exchange(tcp, raw_tcp, &request, provider, deadline, r);
    }
}

fn exchange<S: Read + Write>(
    mut s: S,
    raw_tcp: Option<TcpStream>,
    request: &str,
    provider: &str,
    deadline: Instant,
    r: &mut ProbeResult,
) {
    let set_timeout = |d: Option<Duration>| {
        if let Some(t) = &raw_tcp {
            t.set_read_timeout(d).ok();
            t.set_write_timeout(d).ok();
        }
    };
    let drop_conn = || {
        if let Some(t) = &raw_tcp {
            t.shutdown(Shutdown::Both).ok();
        }
    };
    set_timeout(remaining(deadline));
    if s.write_all(request.as_bytes()).is_err() {
        r.reason = Some("connect-failed".into());
        return;
    }
    s.flush().ok();

    let mut head: Vec<u8> = Vec::new();
    let mut body: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; CHUNK_BYTES];
    let mut header_end: Option<usize> = None;
    let mut content_length: Option<usize> = None;
    loop {
        let Some(left) = remaining(deadline) else {
            drop_conn();
            r.reason = Some("timeout".into());
            return;
        };
        set_timeout(Some(left));
        let n = match s.read(&mut chunk) {
            Ok(n) => n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                drop_conn();
                r.reason = Some("timeout".into());
                return;
            }
            Err(_) if header_end.is_some() => 0,
            Err(_) => {
                r.reason = Some("read-failed".into());
                return;
            }
        };
        r.bytes_read += n;
        if header_end.is_none() {
            head.extend_from_slice(&chunk[..n]);
            if let Some(p) = head.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = Some(p + 4);
                body = head.split_off(p + 4);
                let text = String::from_utf8_lossy(&head).to_string();
                let code = text
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|c| c.parse::<u16>().ok());
                let Some(code) = code else {
                    drop_conn();
                    r.status = "bad-response";
                    r.reachable = true;
                    r.reason = Some("no-http-status".into());
                    return;
                };
                r.reachable = true;
                r.http_status = Some(code);
                if (300..400).contains(&code) {
                    drop_conn();
                    r.status = "bad-response";
                    r.reason = Some("redirect-refused".into());
                    return;
                }
                if !(200..300).contains(&code) {
                    drop_conn();
                    r.status = "bad-response";
                    r.reason = Some("http-status".into());
                    return;
                }
                content_length = text.lines().find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.trim()
                        .eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().ok())
                        .flatten()
                });
                if content_length.is_some_and(|len| len > MAX_BODY_BYTES) {
                    drop_conn();
                    r.status = "bad-response";
                    r.reason = Some("body-too-large".into());
                    return;
                }
            } else if head.len() > MAX_HEADER_BYTES || n == 0 {
                drop_conn();
                r.status = "bad-response";
                r.reachable = n > 0 || !head.is_empty();
                r.reason = Some("no-http-status".into());
                return;
            }
        } else {
            body.extend_from_slice(&chunk[..n]);
        }
        if body.len() > MAX_BODY_BYTES {
            drop_conn();
            r.status = "bad-response";
            r.reason = Some("body-too-large".into());
            return;
        }
        if header_end.is_some() && (n == 0 || content_length.is_some_and(|l| body.len() >= l)) {
            break;
        }
    }
    let parsed: Option<Value> = serde_json::from_slice(&body).ok();
    let list = parsed.as_ref().and_then(|v| {
        if provider == "ollama" {
            v.get("models")
        } else {
            v.get("data")
        }
        .and_then(Value::as_array)
    });
    match list {
        Some(models) => {
            r.status = "reachable";
            r.model_count = models.len();
        }
        None => {
            r.status = "bad-response";
            r.reason = Some("no-model-list".into());
        }
    }
}

/// `mdopener-mcp doctor [--json]` (without `--fix`): the local inference
/// check. Exit code 0: a warning never fails doctor.
pub fn doctor(json: bool) -> (String, i32) {
    let p = probe();
    let level = match p.status {
        "not-configured" | "reachable" => "ok",
        _ => "warn",
    };
    if json {
        let v = serde_json::json!({
            "checks": [{ "id": "local-inference", "status": level, "probe": p }]
        });
        return (
            format!("{}\n", serde_json::to_string_pretty(&v).unwrap_or_default()),
            0,
        );
    }
    let provider = p.provider.clone().unwrap_or_default();
    let detail = match p.status {
        "not-configured" => {
            "not configured (no localInference in ~/.ashlr/config.json)".to_string()
        }
        "reachable" => format!("{provider}: reachable, {} model(s)", p.model_count),
        "remote-not-probed" => format!("{provider}: remote endpoint, not probed (loopback only)"),
        "config-invalid" => format!("config invalid: {}", p.reason.clone().unwrap_or_default()),
        "unreachable" => format!(
            "{provider}: unreachable ({}); start the server, for example `ollama serve`",
            p.reason.clone().unwrap_or_default()
        ),
        _ => format!(
            "{provider}: bad response ({}{})",
            p.reason.clone().unwrap_or_default(),
            p.http_status
                .map(|c| format!(", HTTP {c}"))
                .unwrap_or_default()
        ),
    };
    (format!("doctor: local-inference [{level}] {detail}\n"), 0)
}
