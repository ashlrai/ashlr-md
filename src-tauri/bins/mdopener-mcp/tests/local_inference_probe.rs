//! `local-inference-probe` (mirrors phantom #920/#921) against 127.0.0.1
//! port-0 test servers: reachable, timeout, remote never probed, invalid
//! config never probed, no auth header, redirect refused without contacting
//! the target, and a streamed 256 KiB body cap that aborts an endless reply.
use mdopener_mcp::local_inference_probe::{
    probe_config, CHUNK_BYTES, MAX_BODY_BYTES, PROBE_TIMEOUT,
};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn cfg(provider: &str, base: &str) -> Value {
    json!({ "localInference": { "provider": provider, "baseUrl": base } })
}

fn read_request(s: &mut std::net::TcpStream) -> String {
    let mut raw = Vec::new();
    let mut buf = [0u8; 2048];
    while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = s.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
    }
    String::from_utf8_lossy(&raw).into_owned()
}

/// One-shot server answering `reply`; returns (port, handle -> request text).
fn serve_once(reply: String) -> (u16, thread::JoinHandle<String>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let h = thread::spawn(move || {
        let (mut s, _) = l.accept().unwrap();
        let req = read_request(&mut s);
        let _ = s.write_all(reply.as_bytes());
        req
    });
    (port, h)
}

fn ok_reply(body: &str) -> String {
    format!(
        "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

#[test]
fn reachable_openai_compat_counts_models_and_sends_no_key() {
    let (port, h) = serve_once(ok_reply(
        r#"{"data":[{"id":"qwen3.8:27b"},{"id":"secret-model-name"}]}"#,
    ));
    let p = probe_config(
        Some(&cfg(
            "openai-compat",
            &format!("http://127.0.0.1:{port}/v1"),
        )),
        PROBE_TIMEOUT,
    );
    let req = h.join().unwrap();
    assert_eq!(p.status, "reachable");
    assert!(p.reachable && p.loopback);
    assert_eq!(p.http_status, Some(200));
    assert_eq!(p.model_count, 2);
    assert!(req.starts_with("GET /v1/models HTTP/1.0\r\n"), "{req}");
    let lower = req.to_ascii_lowercase();
    for banned in ["authorization", "x-api-key", "bearer", "phm_", "cookie"] {
        assert!(!lower.contains(banned), "{banned} in {req}");
    }
    // Value-free: no model ids, URL or port in the output.
    let out = serde_json::to_string(&p).unwrap();
    assert!(
        !out.contains("secret-model-name")
            && !out.contains("qwen")
            && !out.contains(&port.to_string()),
        "{out}"
    );
}

#[test]
fn ollama_uses_api_tags() {
    let (port, h) = serve_once(ok_reply(r#"{"models":[{"name":"qwen3.8:27b"}]}"#));
    let p = probe_config(
        Some(&cfg("ollama", &format!("http://127.0.0.1:{port}/v1"))),
        PROBE_TIMEOUT,
    );
    assert!(h.join().unwrap().starts_with("GET /api/tags HTTP/1.0\r\n"));
    assert_eq!((p.status, p.model_count), ("reachable", 1));
}

#[test]
fn silent_server_times_out_as_unreachable() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let h = thread::spawn(move || {
        let (s, _) = l.accept().unwrap();
        thread::sleep(Duration::from_millis(1500));
        drop(s);
    });
    let t = std::time::Instant::now();
    let p = probe_config(
        Some(&cfg("omlx", &format!("http://127.0.0.1:{port}/v1"))),
        Duration::from_millis(400),
    );
    assert!(
        t.elapsed() < Duration::from_millis(1400),
        "{:?}",
        t.elapsed()
    );
    assert_eq!(p.status, "unreachable");
    assert_eq!(p.reason.as_deref(), Some("timeout"));
    h.join().unwrap();
}

#[test]
fn closed_port_is_unreachable() {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let p = probe_config(
        Some(&cfg("omlx", &format!("http://127.0.0.1:{port}/v1"))),
        PROBE_TIMEOUT,
    );
    assert_eq!(p.status, "unreachable");
}

#[test]
fn remote_is_never_probed_even_with_allow_remote() {
    let c = json!({ "localInference": { "provider": "openai-compat", "baseUrl": "https://gpu.example.com/v1", "allowRemote": true } });
    let p = probe_config(Some(&c), PROBE_TIMEOUT);
    assert_eq!(p.status, "remote-not-probed");
    assert!(!p.reachable && !p.loopback && p.http_status.is_none());
    assert!(!serde_json::to_string(&p)
        .unwrap()
        .contains("gpu.example.com"));
}

#[test]
fn gate_refusals_are_config_invalid_and_not_probed() {
    for base in [
        "http://gpu.example.com/v1",
        "http://127.0.0.2:1/v1",
        "http://localhost.evil.com/v1",
    ] {
        let p = probe_config(Some(&cfg("openai-compat", base)), PROBE_TIMEOUT);
        assert_eq!(p.status, "config-invalid", "{base}");
        assert_eq!(
            p.reason.as_deref(),
            Some("localInference.baseUrl: remote-not-allowed")
        );
    }
    let p = probe_config(
        Some(
            &json!({ "localInference": { "provider": "ollama", "models": { "coder": "x-abliterated" } } }),
        ),
        PROBE_TIMEOUT,
    );
    assert_eq!(p.status, "config-invalid");
    assert_eq!(probe_config(None, PROBE_TIMEOUT).status, "not-configured");
    assert_eq!(
        probe_config(Some(&json!({})), PROBE_TIMEOUT).status,
        "not-configured"
    );
}

#[test]
fn redirect_is_refused_and_target_never_contacted() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let tport = target.local_addr().unwrap().port();
    target.set_nonblocking(true).unwrap();
    let (port, h) = serve_once(format!(
        "HTTP/1.0 302 Found\r\nLocation: http://127.0.0.1:{tport}/v1/models\r\nContent-Length: 0\r\n\r\n"
    ));
    let p = probe_config(
        Some(&cfg(
            "openai-compat",
            &format!("http://127.0.0.1:{port}/v1"),
        )),
        PROBE_TIMEOUT,
    );
    h.join().unwrap();
    assert_eq!(p.status, "bad-response");
    assert_eq!(p.http_status, Some(302));
    assert_eq!(p.reason.as_deref(), Some("redirect-refused"));
    thread::sleep(Duration::from_millis(100));
    assert!(target.accept().is_err(), "redirect target was contacted");
}

#[test]
fn endless_body_is_aborted_at_the_cap_not_buffered() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let sent = Arc::new(AtomicUsize::new(0));
    let sent2 = sent.clone();
    let h = thread::spawn(move || {
        let (mut s, _) = l.accept().unwrap();
        read_request(&mut s);
        let _ =
            s.write_all(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"data\":[");
        let chunk = vec![b' '; 64 * 1024];
        // Up to 300 MiB; stops as soon as the probe drops the connection.
        while sent2.load(Ordering::SeqCst) < 300 * 1024 * 1024 {
            if s.write_all(&chunk).is_err() {
                break;
            }
            sent2.fetch_add(chunk.len(), Ordering::SeqCst);
        }
    });
    let p = probe_config(
        Some(&cfg(
            "openai-compat",
            &format!("http://127.0.0.1:{port}/v1"),
        )),
        PROBE_TIMEOUT,
    );
    h.join().unwrap();
    assert_eq!(p.status, "bad-response");
    assert_eq!(p.reason.as_deref(), Some("body-too-large"));
    assert!(
        p.bytes_read <= MAX_BODY_BYTES + CHUNK_BYTES + 1024,
        "read {} bytes",
        p.bytes_read
    );
    assert!(
        sent.load(Ordering::SeqCst) < 300 * 1024 * 1024,
        "server wrote the whole body"
    );
}

#[test]
fn declared_oversized_body_is_refused_before_reading() {
    let (port, h) = serve_once(format!(
        "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{{",
        MAX_BODY_BYTES + 1
    ));
    let p = probe_config(
        Some(&cfg(
            "openai-compat",
            &format!("http://127.0.0.1:{port}/v1"),
        )),
        PROBE_TIMEOUT,
    );
    h.join().unwrap();
    assert_eq!(
        (p.status, p.reason.as_deref()),
        ("bad-response", Some("body-too-large"))
    );
}

#[test]
fn error_status_and_html_are_bad_response_without_body_text() {
    let (port, h) =
        serve_once("HTTP/1.0 401 Unauthorized\r\nContent-Length: 13\r\n\r\nsecret-detail".into());
    let p = probe_config(
        Some(&cfg(
            "openai-compat",
            &format!("http://127.0.0.1:{port}/v1"),
        )),
        PROBE_TIMEOUT,
    );
    h.join().unwrap();
    assert_eq!((p.status, p.http_status), ("bad-response", Some(401)));
    assert!(!serde_json::to_string(&p).unwrap().contains("secret-detail"));
    let (port, h) = serve_once(ok_reply("<html>"));
    let p = probe_config(
        Some(&cfg(
            "openai-compat",
            &format!("http://127.0.0.1:{port}/v1"),
        )),
        PROBE_TIMEOUT,
    );
    h.join().unwrap();
    assert_eq!(p.status, "bad-response");
}
