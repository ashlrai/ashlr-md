//! `OLLAMA_HOST` handling in the sidecar. The default stays 127.0.0.1:11434.
//! An override must be https://, or plain http:// only to 127.0.0.1 or [::1],
//! and redirects are refused.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::Duration;

use mdopener_mcp::{ollama_base_from, ollama_embed, parse_ollama_url, OllamaTarget};

/// Tests below set `OLLAMA_HOST` for the whole process.
static ENV: Mutex<()> = Mutex::new(());

fn with_ollama_host<T>(value: &str, f: impl FnOnce() -> T) -> T {
    let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let old = std::env::var("OLLAMA_HOST").ok();
    std::env::set_var("OLLAMA_HOST", value);
    let out = f();
    match old {
        Some(v) => std::env::set_var("OLLAMA_HOST", v),
        None => std::env::remove_var("OLLAMA_HOST"),
    }
    out
}

/// A one-shot local listener. The thread returns the first bytes it read
/// (or nothing if no client came within 3 s) after sending `answer`.
fn one_shot(answer: &'static [u8]) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    l.set_nonblocking(true).unwrap();
    let h = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut s = loop {
            match l.accept() {
                Ok((s, _)) => break s,
                Err(_) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Err(_) => return Vec::new(),
            }
        };
        s.set_nonblocking(false).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut buf = vec![0u8; 4096];
        let n = s.read(&mut buf).unwrap_or(0);
        buf.truncate(n);
        let _ = s.write_all(answer);
        buf
    });
    (port, h)
}

#[test]
fn default_is_unchanged() {
    for v in [None, Some(""), Some("  "), Some("/")] {
        assert_eq!(ollama_base_from(v).unwrap(), "http://127.0.0.1:11434");
    }
}

#[test]
fn https_and_loopback_http_are_accepted() {
    assert_eq!(
        ollama_base_from(Some("https://ollama.example.com/")).unwrap(),
        "https://ollama.example.com"
    );
    assert_eq!(
        ollama_base_from(Some("https://gpu-box:8443/ollama")).unwrap(),
        "https://gpu-box:8443/ollama"
    );
    assert_eq!(
        ollama_base_from(Some("http://127.0.0.1:11435")).unwrap(),
        "http://127.0.0.1:11435"
    );
    assert_eq!(
        ollama_base_from(Some("http://[::1]:11434")).unwrap(),
        "http://[::1]:11434"
    );
    assert_eq!(
        ollama_base_from(Some("127.0.0.1:9000")).unwrap(),
        "http://127.0.0.1:9000"
    );
    // Local shorthands keep working.
    assert_eq!(
        ollama_base_from(Some(":8080")).unwrap(),
        "http://127.0.0.1:8080"
    );
    assert_eq!(
        ollama_base_from(Some("0.0.0.0")).unwrap(),
        "http://127.0.0.1:11434"
    );
    assert_eq!(
        ollama_base_from(Some("http://0.0.0.0:11434")).unwrap(),
        "http://127.0.0.1:11434"
    );
    assert_eq!(
        ollama_base_from(Some("[::]:11434")).unwrap(),
        "http://[::1]:11434"
    );
}

#[test]
fn other_values_are_refused_without_echoing_them() {
    for v in [
        "gpu-box",
        "gpu-box:11435",
        "10.0.0.2:9000",
        "http://localhost:11434",
        "localhost",
        "http://ollama.example.com",
        "https://user:secret-value@ollama.example.com",
        "https://ollama.example.com/?k=secret-value",
        "https://ollama.example.com/#secret-value",
        "ftp://ollama.example.com",
        "https://bad host",
    ] {
        let err = ollama_base_from(Some(v)).expect_err(v);
        assert!(err.starts_with("OLLAMA_HOST refused: "), "{v}: {err}");
        assert!(err.contains("No request was sent"), "{v}: {err}");
        assert!(
            !err.contains("secret-value") && !err.contains("gpu-box"),
            "{v}: {err}"
        );
        assert!(!err.contains("example.com"), "{v}: {err}");
    }
}

#[test]
fn parse_ollama_url_handles_https_ports_and_ipv6() {
    assert_eq!(
        parse_ollama_url("https://ollama.example.com/api/embeddings").unwrap(),
        OllamaTarget {
            https: true,
            host: "ollama.example.com".into(),
            port: 443,
            path: "/api/embeddings".into()
        }
    );
    assert_eq!(
        parse_ollama_url("http://[::1]:11434").unwrap(),
        OllamaTarget {
            https: false,
            host: "[::1]".into(),
            port: 11434,
            path: "/".into()
        }
    );
}

#[test]
fn https_ollama_host_speaks_tls() {
    // A plain TCP listener: an https client must open with a TLS ClientHello
    // (record type 0x16), never a plain-text POST.
    let (port, h) = one_shot(b"");
    let r = with_ollama_host(&format!("https://127.0.0.1:{port}"), || {
        ollama_embed("hello")
    });
    let first = h.join().unwrap();
    assert!(r.is_err(), "no TLS server, so the call fails");
    assert_eq!(first.first(), Some(&0x16), "sidecar sent a TLS handshake");
    assert!(!String::from_utf8_lossy(&first).contains("POST"));
}

#[test]
fn loopback_http_ollama_still_works() {
    let (port, h) = one_shot(
        b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"embedding\":[0.5,0.25]}",
    );
    let r = with_ollama_host(&format!("http://127.0.0.1:{port}"), || {
        ollama_embed("hello")
    });
    let req = String::from_utf8_lossy(&h.join().unwrap()).to_string();
    assert_eq!(r.unwrap(), vec![0.5, 0.25]);
    assert!(
        req.starts_with("POST /api/embeddings HTTP/1.0\r\n"),
        "{req}"
    );
    assert!(
        !req.to_ascii_lowercase().contains("authorization:"),
        "{req}"
    );
}

#[test]
fn redirects_are_refused() {
    let (port, h) = one_shot(
        b"HTTP/1.0 307 Temporary Redirect\r\nLocation: https://elsewhere.example/api/embeddings\r\nContent-Type: application/json\r\n\r\n{\"embedding\":[1.0]}",
    );
    let r = with_ollama_host(&format!("http://127.0.0.1:{port}"), || {
        ollama_embed("hello")
    });
    h.join().unwrap();
    let err = r.expect_err("a 307 must not count as an answer");
    assert!(err.contains("redirect"), "{err}");
}

#[test]
fn refused_host_gets_no_connection() {
    // localhost by name is refused for plain http, so nothing reaches the
    // listener even though it is on this machine.
    let (port, h) = one_shot(b"HTTP/1.0 200 OK\r\n\r\n{\"embedding\":[1.0]}");
    let r = with_ollama_host(&format!("http://localhost:{port}"), || {
        ollama_embed("hello")
    });
    let got = h.join().unwrap();
    let err = r.expect_err("refused");
    assert!(err.starts_with("OLLAMA_HOST refused: "), "{err}");
    assert!(got.is_empty(), "no request was sent");
    assert!(!with_ollama_host(
        "http://localhost:1",
        mdopener_mcp::ollama_available
    ));
}
