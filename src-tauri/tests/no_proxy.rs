//! Proxy environment variables never capture local model traffic. This is
//! its own test binary (own process), so the proxy variables set here cannot
//! leak into any other test.
use md_opener_lib::{anthropic_client_builder, local_client_builder};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn real_server() -> (u16, tokio::task::JoinHandle<String>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let h = tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let mut buf = vec![0u8; 8192];
        let n = s.read(&mut buf).await.unwrap();
        s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
            .await
            .unwrap();
        String::from_utf8_lossy(&buf[..n]).into_owned()
    });
    (port, h)
}

#[tokio::test]
async fn proxy_env_never_sees_local_requests() {
    // A proxy listener that must get zero connections.
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let pport = proxy.local_addr().unwrap().port();
    let proxy_url = format!("http://127.0.0.1:{pport}");
    for var in [
        "ALL_PROXY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "all_proxy",
        "http_proxy",
        "https_proxy",
    ] {
        std::env::set_var(var, &proxy_url);
    }
    for var in ["NO_PROXY", "no_proxy"] {
        std::env::remove_var(var);
    }

    let cases: Vec<(&str, reqwest::Client)> = vec![
        ("local", local_client_builder().build().unwrap()),
        (
            "anthropic loopback gateway",
            anthropic_client_builder("http://127.0.0.1:4000")
                .build()
                .unwrap(),
        ),
    ];
    for (label, client) in cases {
        for host in ["127.0.0.1", "localhost"] {
            let (port, server) = real_server().await;
            let resp = client
                .post(format!("http://{host}:{port}/v1/chat/completions"))
                .body("document-text-canary")
                .timeout(Duration::from_secs(3))
                .send()
                .await
                .unwrap_or_else(|e| panic!("{label} {host}: {e}"));
            assert!(resp.status().is_success(), "{label} {host}");
            let req = server.await.unwrap();
            assert!(
                req.starts_with("POST /v1/chat/completions "),
                "{label} {host}: {req}"
            );
        }
    }
    let hit = tokio::time::timeout(Duration::from_millis(300), proxy.accept()).await;
    assert!(hit.is_err(), "the proxy listener got a connection");
}
