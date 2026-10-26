//! `localInference`: a local OpenAI-compatible model server (Ollama, oMLX,
//! LiteLLM, ...) behind a loopback-only gate. Mirrors phantom #917
//! (`src/core/run/local-inference.ts`): same config block, field names and
//! closed refusal codes, read from the same file, `~/.ashlr/config.json`:
//!
//! ```json
//! "localInference": {
//!   "provider": "ollama" | "omlx" | "openai-compat",
//!   "baseUrl": "http://127.0.0.1:11434/v1",   // optional for ollama/omlx
//!   "models": { "coder": "qwen3.8:27b" },     // optional; default qwen3.8:27b
//!   "allowRemote": false,                     // default
//!   "offline": false                          // default
//! }
//! ```
//!
//! Rules:
//! - Loopback only by default: `127.0.0.1`, `[::1]` and `localhost`, written
//!   exactly that way (`127.0.0.2`, `2130706433`, `localhost.evil.com` and
//!   trailing dots are refused).
//! - A non-loopback URL needs `allowRemote: true` in the config file AND
//!   https. The environment can never widen this.
//! - `offline: true` wins over `allowRemote` and over every environment
//!   variable. Chat, embeddings, search and the sidecar stay on loopback.
//!   The Anthropic builder refuses before a client exists.
//! - No key is ever sent to a `localInference` endpoint: no Authorization or
//!   x-api-key header, no Anthropic key, no `phm_` placeholder, no OAuth token.
//! - Abliterated or uncensored models (matched by name) are refused; there is
//!   no default that names one.
//! - `OLLAMA_HOST` goes through the same gate (behavior change: a remote
//!   Ollama now needs `allowRemote: true` and https).
//!
//! Refusals are closed codes and never echo the URL.

use serde::Serialize;
use serde_json::Value;

pub use crate::local_inference_gate::*;

/// `allowRemote` from the config file only (false when absent or invalid,
/// and always false in offline mode).
fn allow_remote_from_config() -> bool {
    effective_allow_remote(read_config_value().as_ref())
}

/// `http(s)://0.0.0.0` and `http(s)://[::]` (often set so `ollama serve`
/// listens everywhere) connect to this machine; name loopback instead.
fn bind_all_to_loopback(url: &str) -> String {
    for (from, to) in [("0.0.0.0", "127.0.0.1"), ("[::]", "[::1]")] {
        for scheme in ["http://", "https://"] {
            if let Some(rest) = url.strip_prefix(&format!("{scheme}{from}")) {
                if rest.is_empty() || rest.starts_with([':', '/']) {
                    return format!("{scheme}{to}{rest}");
                }
            }
        }
    }
    url.to_string()
}

/// `OLLAMA_HOST` (raw) through the loopback gate. Unset means the default
/// `http://localhost:11434`. A remote host needs `allow_remote` and https.
pub fn ollama_base_url_gated_from(raw: Option<&str>, allow_remote: bool) -> Result<String, String> {
    let url = bind_all_to_loopback(&crate::base_urls::ollama_base_url_from(raw));
    validate_local_base_url(&url, allow_remote)
        .map(|u| u.base_url)
        .map_err(|why| {
            format!("OLLAMA_HOST refused ({why}): a non-loopback Ollama needs localInference.allowRemote true in ~/.ashlr/config.json and https. No request was sent.")
        })
}

/// [`ollama_base_url_gated_from`] for the real environment and config file.
pub fn ollama_base_url() -> Result<String, String> {
    ollama_base_url_gated_from(
        std::env::var("OLLAMA_HOST").ok().as_deref(),
        allow_remote_from_config(),
    )
}

/// Value-free status for the frontend (no URL).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInferenceStatus {
    pub offline: bool,
    pub provider: String,
    pub model: String,
    pub loopback: bool,
}

/// Status of a valid `localInference` block, or `None` when it is absent or
/// invalid (an invalid block never routes anywhere).
#[tauri::command]
pub fn ai_local_inference_status() -> Option<LocalInferenceStatus> {
    load().ok().flatten().map(|c| LocalInferenceStatus {
        offline: c.offline,
        provider: c.provider,
        model: c.model,
        loopback: c.loopback,
    })
}

fn pinned_builder() -> reqwest::ClientBuilder {
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(
            "localhost",
            &[
                SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                SocketAddr::from((Ipv6Addr::LOCALHOST, 0)),
            ],
        )
}

/// The one HTTP client builder for every local model and embedding call
/// (security: flagship-threats HIGH #1, MEDIUM #2):
/// - redirects are never followed, so a loopback listener answering 307/308
///   cannot re-send a prompt, document text or key to another host;
/// - `localhost` is pinned to 127.0.0.1 and ::1 (no DNS, so a hosts-file or
///   resolver remap cannot send it off the machine). IP literals never use
///   DNS, and remote hosts only pass the gate with `allowRemote` and https;
/// - no proxy: reqwest otherwise honors HTTP_PROXY, HTTPS_PROXY, ALL_PROXY
///   and the system proxy with no loopback bypass, which would hand local
///   prompts and documents to the proxy.
///
/// This builder does not see the URL. Production calls go through
/// [`local_client_builder_gated`], which applies the offline host gate first.
pub fn client_builder() -> reqwest::ClientBuilder {
    pinned_builder().no_proxy()
}

/// [`client_builder`] after the offline gate. A non-loopback `base` is
/// refused when `offline` is set, before a client exists. `offline == false`
/// is today's builder, with no extra refusal.
pub fn local_client_builder_gated(
    offline: bool,
    base: &str,
) -> Result<reqwest::ClientBuilder, String> {
    ensure_offline_loopback(offline, base)?;
    Ok(client_builder())
}

/// [`local_client_builder_gated`] for the config file's offline flag.
pub fn local_client_for(base: &str) -> Result<reqwest::Client, String> {
    local_client_builder_gated(offline(), base)?
        .build()
        .map_err(|e| format!("HTTP client setup failed: {e}"))
}

/// The Anthropic client builder: no redirects (the key goes only to the
/// validated host) and `localhost` pinned, like [`client_builder`]. It keeps
/// the environment and system proxy so corporate proxies still work for the
/// real API, except when `base` is a loopback gateway (for example LiteLLM on
/// 127.0.0.1), where a proxy would only take the request off the machine.
///
/// In offline mode this is unreachable. It returns [`OFFLINE_REFUSAL`] and
/// builds nothing, including for a loopback gateway, and does not fall back
/// to another host. No environment variable can turn that off.
pub fn anthropic_client_builder(base: &str) -> Result<reqwest::ClientBuilder, String> {
    anthropic_client_builder_gated(offline(), base)
}

/// [`anthropic_client_builder`] with the offline flag explicit, so tests do
/// not read `~/.ashlr/config.json`.
pub fn anthropic_client_builder_gated(
    offline: bool,
    base: &str,
) -> Result<reqwest::ClientBuilder, String> {
    if offline {
        return Err(OFFLINE_REFUSAL.to_string());
    }
    Ok(anthropic_client_builder_inner(base))
}

fn anthropic_client_builder_inner(base: &str) -> reqwest::ClientBuilder {
    let loopback = url::Url::parse(base)
        .ok()
        .and_then(|u| u.host_str().map(is_loopback_host))
        .unwrap_or(false);
    if loopback {
        pinned_builder().no_proxy()
    } else {
        pinned_builder()
    }
}

/// [`client_builder`] with no other settings.
pub fn client() -> Result<reqwest::Client, String> {
    client_builder()
        .build()
        .map_err(|e| format!("HTTP client setup failed: {e}"))
}

/// True in offline mode (`localInference.offline`). The frontend uses it to
/// skip every cloud provider; the Rust side refuses them regardless.
#[tauri::command]
pub fn ai_offline_mode() -> bool {
    offline()
}

/// One parsed line of an OpenAI chat-completions SSE stream.
#[derive(Debug, PartialEq, Eq)]
pub enum SseLine {
    Delta(String),
    Done,
    Skip,
}

pub fn parse_sse_line(line: &str) -> SseLine {
    let Some(data) = line.strip_prefix("data:").map(str::trim) else {
        return SseLine::Skip;
    };
    if data == "[DONE]" {
        return SseLine::Done;
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return SseLine::Skip;
    };
    match v
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        Some(s) if !s.is_empty() => SseLine::Delta(s.to_string()),
        _ => SseLine::Skip,
    }
}

/// POST `{base}/chat/completions` with NO key header of any kind.
/// In offline mode a non-loopback `base` is refused before the request.
pub async fn send_chat(
    client: &reqwest::Client,
    base: &str,
    body: &impl Serialize,
) -> Result<reqwest::Response, String> {
    send_chat_gated(offline(), client, base, body).await
}

/// [`send_chat`] with the offline flag explicit.
pub async fn send_chat_gated(
    offline: bool,
    client: &reqwest::Client,
    base: &str,
    body: &impl Serialize,
) -> Result<reqwest::Response, String> {
    ensure_offline_loopback(offline, base)?;
    let resp = client
        .post(format!("{base}/chat/completions"))
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Local model request failed: {}", e.without_url()))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let body = crate::redact::error_body(&text, &crate::redact::url_secrets(base));
        return Err(format!("Local model error {status}: {body}"));
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok(u: &str) -> LocalUrl {
        validate_local_base_url(u, false).unwrap_or_else(|e| panic!("{u}: {e}"))
    }
    fn refused(u: &str, remote: bool) -> &'static str {
        validate_local_base_url(u, remote).expect_err(u).code()
    }

    #[test]
    fn loopback_hosts_pass() {
        assert_eq!(
            ok("http://127.0.0.1:11434/v1").base_url,
            "http://127.0.0.1:11434/v1"
        );
        assert_eq!(ok("http://[::1]:8000/v1/").base_url, "http://[::1]:8000/v1");
        assert_eq!(
            ok("http://localhost:4000").base_url,
            "http://localhost:4000"
        );
        assert!(ok("https://localhost/v1").loopback);
    }

    #[test]
    fn lookalikes_are_refused() {
        assert_eq!(
            refused("http://localhost.evil.com/v1", false),
            "remote-not-allowed"
        );
        assert_eq!(refused("http://127.0.0.2/v1", false), "remote-not-allowed");
        assert_eq!(refused("http://0.0.0.0:11434", false), "remote-not-allowed");
        assert_eq!(refused("http://2130706433/", false), "host-not-canonical");
        assert_eq!(refused("http://0x7f.1/", false), "host-not-canonical");
        assert_eq!(refused("http://localhost./v1", false), "host-not-canonical");
        assert_eq!(refused("http://LOCALHOST%2e/", false), "host-not-canonical");
    }

    #[test]
    fn remote_needs_allow_remote_and_https() {
        assert_eq!(
            refused("https://gpu.example.com/v1", false),
            "remote-not-allowed"
        );
        assert_eq!(
            refused("http://gpu.example.com/v1", true),
            "remote-requires-https"
        );
        let u = validate_local_base_url("https://gpu.example.com/v1", true).unwrap();
        assert!(!u.loopback);
    }

    #[test]
    fn closed_codes_for_bad_shapes() {
        assert_eq!(refused("ftp://127.0.0.1/", false), "scheme-not-allowed");
        assert_eq!(
            refused("http://u:p@127.0.0.1/", false),
            "userinfo-not-allowed"
        );
        assert_eq!(
            refused("http://127.0.0.1/v1?x=1", false),
            "query-not-allowed"
        );
        assert_eq!(
            refused("http://127.0.0.1/v1#f", false),
            "fragment-not-allowed"
        );
        // Out-of-range ports fail URL parsing first, as in #917 (new URL throws).
        assert_eq!(
            refused("http://127.0.0.1:99999/", false),
            "base-url-invalid"
        );
        assert_eq!(refused("http://127.0.0.1:0x50/", false), "base-url-invalid");
        assert_eq!(refused("http://127.0.0.1:/", false), "port-invalid");
        assert_eq!(
            refused("http://127.0.0.1/a/../b", false),
            "path-not-allowed"
        );
        assert_eq!(refused("http://127.0.0.1/a%20b", false), "path-not-allowed");
        assert_eq!(refused("", false), "base-url-invalid");
        assert_eq!(refused("127.0.0.1:11434", false), "base-url-invalid");
        assert_eq!(refused("http:\\\\127.0.0.1", false), "base-url-invalid");
    }

    #[test]
    fn config_defaults_and_refusals() {
        let c = parse_local_inference(Some(&json!({"provider": "ollama"})))
            .unwrap()
            .unwrap();
        assert_eq!(c.base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(c.model, DEFAULT_LOCAL_MODEL);
        assert!(!c.allow_remote);
        let c = parse_local_inference(Some(&json!({"provider": "omlx"})))
            .unwrap()
            .unwrap();
        assert_eq!(c.base_url, "http://127.0.0.1:8000/v1");
        assert_eq!(parse_local_inference(None).unwrap(), None);
        assert!(parse_local_inference(Some(&json!({"provider": "openai-compat"}))).is_err());
        assert!(parse_local_inference(Some(&json!({"provider": "x"}))).is_err());
        let e = parse_local_inference(Some(
            &json!({"provider": "openai-compat", "baseUrl": "https://secret-host.example/v1"}),
        ))
        .unwrap_err();
        assert_eq!(e, "localInference.baseUrl: remote-not-allowed");
        assert!(!e.contains("secret-host"));
        assert!(
            parse_local_inference(Some(&json!({"provider": "ollama", "allowRemote": "yes"})))
                .is_err()
        );
        let e = parse_local_inference(Some(
            &json!({"provider": "ollama", "models": {"coder": "qwen3-abliterated:32b"}}),
        ))
        .unwrap_err();
        assert!(e.contains("abliterated"));
        assert!(!is_abliterated_model(DEFAULT_LOCAL_MODEL));
    }

    #[test]
    fn ollama_host_is_gated() {
        assert_eq!(
            ollama_base_url_gated_from(None, false).unwrap(),
            "http://localhost:11434"
        );
        assert_eq!(
            ollama_base_url_gated_from(Some("0.0.0.0"), false).unwrap(),
            "http://127.0.0.1:11434"
        );
        assert_eq!(
            ollama_base_url_gated_from(Some("127.0.0.1:9999"), false).unwrap(),
            "http://127.0.0.1:9999"
        );
        let e = ollama_base_url_gated_from(Some("gpu-box"), false).unwrap_err();
        assert!(e.contains("remote-not-allowed") && !e.contains("gpu-box"));
        let e = ollama_base_url_gated_from(Some("gpu-box"), true).unwrap_err();
        assert!(e.contains("remote-requires-https"));
        assert_eq!(
            ollama_base_url_gated_from(Some("https://ollama.example.com"), true).unwrap(),
            "https://ollama.example.com"
        );
    }

    #[test]
    fn sse_lines() {
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#),
            SseLine::Delta("hi".into())
        );
        assert_eq!(parse_sse_line("data: [DONE]"), SseLine::Done);
        assert_eq!(parse_sse_line(": keep-alive"), SseLine::Skip);
    }

    /// Hermetic loopback stub: the request reaches `{base}/chat/completions`
    /// and carries no key header.
    #[tokio::test]
    async fn loopback_request_carries_no_key() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                raw.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&raw).to_string();
                if let Some(h) = text.find("\r\n\r\n") {
                    let len = text[..h]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if raw.len() >= h + 4 + len || n == 0 {
                        break;
                    }
                }
            }
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
            let resp = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            sock.write_all(resp.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&raw).to_string()
        });
        let base = validate_local_base_url(&format!("http://127.0.0.1:{port}/v1"), false).unwrap();
        let client = client().unwrap();
        let body = json!({"model": DEFAULT_LOCAL_MODEL, "messages": [], "stream": true});
        let resp = send_chat(&client, &base.base_url, &body).await.unwrap();
        let text = resp.text().await.unwrap();
        let req = server.await.unwrap();
        assert!(req.starts_with("POST /v1/chat/completions "), "{req}");
        let lower = req.to_ascii_lowercase();
        assert!(!lower.contains("authorization:"), "{req}");
        assert!(!lower.contains("x-api-key:"), "{req}");
        assert!(!lower.contains("bearer") && !req.contains("phm_"), "{req}");
        assert!(text
            .lines()
            .any(|l| parse_sse_line(l) == SseLine::Delta("ok".into())));
    }

    /// Accept one connection on `l` (if any arrives within `wait`), answer
    /// `reply`, and return the request text.
    async fn answer_once(l: tokio::net::TcpListener, reply: String) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut sock, _) = l.accept().await.unwrap();
        let mut raw = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = sock.read(&mut buf).await.unwrap_or(0);
            raw.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&raw).to_string();
            let done = text.find("\r\n\r\n").is_some_and(|h| {
                let len = text[..h]
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                raw.len() >= h + 4 + len
            });
            if done || n == 0 {
                break;
            }
        }
        sock.write_all(reply.as_bytes()).await.unwrap();
        String::from_utf8_lossy(&raw).to_string()
    }

    /// A second listener that must never be contacted.
    async fn untouched_target() -> (u16, tokio::task::JoinHandle<bool>) {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_millis(300), l.accept())
                .await
                .is_ok()
        });
        (port, h)
    }

    /// 307 and 308 keep the method and body; the shared client must not
    /// follow either, so the prompt never reaches the redirect target.
    #[tokio::test]
    async fn chat_redirects_with_body_are_not_followed() {
        for code in [307u16, 308] {
            let (tport, target) = untouched_target().await;
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = l.local_addr().unwrap().port();
            let reply = format!(
                "HTTP/1.1 {code} Redirect\r\nLocation: http://127.0.0.1:{tport}/v1/chat/completions\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            );
            let server = tokio::spawn(answer_once(l, reply));
            let body = json!({"model": DEFAULT_LOCAL_MODEL, "messages": [{"role": "user", "content": "document-text-canary"}]});
            let err = send_chat(
                &client().unwrap(),
                &format!("http://127.0.0.1:{port}/v1"),
                &body,
            )
            .await
            .unwrap_err();
            assert!(err.contains(&code.to_string()), "{err}");
            assert!(server.await.unwrap().contains("document-text-canary"));
            assert!(
                !target.await.unwrap(),
                "{code}: redirect target was contacted"
            );
        }
    }

    /// Same for the Ollama embeddings path (embed.rs uses the shared client).
    #[tokio::test]
    async fn embed_redirect_is_not_followed() {
        let (tport, target) = untouched_target().await;
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let reply = format!(
            "HTTP/1.1 308 Permanent Redirect\r\nLocation: http://127.0.0.1:{tport}/api/embed\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        );
        let server = tokio::spawn(answer_once(l, reply));
        let r = crate::embed::fetch_embeddings_at(
            &client().unwrap(),
            &format!("http://127.0.0.1:{port}"),
            "nomic-embed-text",
            &["document-text-canary".to_string()],
        )
        .await;
        assert!(r.is_err());
        server.await.unwrap();
        assert!(!target.await.unwrap(), "redirect target was contacted");
    }

    /// `localhost` never goes to the resolver: with a resolver that sends
    /// every name off-box (192.0.2.1, TEST-NET-1), a request to
    /// http://localhost:<port> still reaches the loopback server, and the
    /// resolver is never asked.
    #[tokio::test]
    async fn localhost_is_pinned_even_if_dns_says_otherwise() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        struct OffBox(Arc<AtomicUsize>);
        impl reqwest::dns::Resolve for OffBox {
            fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    let addrs: reqwest::dns::Addrs = Box::new(
                        vec![std::net::SocketAddr::from(([192, 0, 2, 1], 80))].into_iter(),
                    );
                    Ok(addrs)
                })
            }
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let server = tokio::spawn(answer_once(
            l,
            "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}".into(),
        ));
        let c = client_builder()
            .dns_resolver(Arc::new(OffBox(calls.clone())))
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        let resp = c
            .get(format!("http://localhost:{port}/v1/models"))
            .send()
            .await
            .unwrap();
        assert!(resp.status().is_success());
        server.await.unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "localhost went to the resolver"
        );
    }

    #[test]
    fn offline_forces_loopback_only_and_fails_closed() {
        let root = json!({ "localInference": { "provider": "openai-compat", "baseUrl": "https://gpu.example.com/v1", "allowRemote": true, "offline": true } });
        assert!(offline_from(Some(&root)));
        assert!(!effective_allow_remote(Some(&root)));
        let e = parse_local_inference(root.get("localInference")).unwrap_err();
        assert_eq!(e, "localInference.baseUrl: remote-not-allowed");
        // Same block without offline: allowed (existing behavior unchanged).
        let mut on = root.clone();
        on["localInference"]["offline"] = json!(false);
        assert!(parse_local_inference(on.get("localInference"))
            .unwrap()
            .is_some());
        assert!(effective_allow_remote(Some(&on)));
        // Loopback still works offline.
        let lo = json!({ "provider": "ollama", "offline": true });
        let c = parse_local_inference(Some(&lo)).unwrap().unwrap();
        assert!(c.offline && c.loopback);
        // Default off; a non-boolean value counts as offline (fail closed).
        assert!(!offline_from(None));
        assert!(!offline_from(Some(
            &json!({ "localInference": { "provider": "ollama" } })
        )));
        assert!(offline_from(Some(
            &json!({ "localInference": { "offline": "yes" } })
        )));
        // OLLAMA_HOST: a remote https host is refused offline even with allowRemote.
        let e = ollama_base_url_gated_from(
            Some("https://ollama.example.com"),
            effective_allow_remote(Some(&root)),
        )
        .unwrap_err();
        assert!(
            e.contains("remote-not-allowed") && !e.contains("example.com"),
            "{e}"
        );
        // The host gate itself: absent/false is a no-op; true allows only
        // the three loopback spellings. No environment variable is read.
        assert!(ensure_offline_loopback(false, "https://gpu.example.com/v1").is_ok());
        assert!(ensure_offline_loopback(true, "http://127.0.0.1:11434/v1").is_ok());
        assert!(ensure_offline_loopback(true, "http://[::1]:11434/v1").is_ok());
        assert!(ensure_offline_loopback(true, "http://localhost:11434").is_ok());
        for bad in [
            "https://gpu.example.com/v1",
            "http://127.0.0.2:9/v1",
            "http://localhost.evil.com/v1",
            "http://2130706433/",
        ] {
            let e = ensure_offline_loopback(true, bad).unwrap_err();
            assert!(
                !e.contains("example.com") && !e.contains("2130706433"),
                "{e}"
            );
            assert!(
                e.contains("remote-not-allowed") || e.contains("host-not-canonical"),
                "{bad}: {e}"
            );
        }
        assert_eq!(
            anthropic_client_builder_gated(true, "https://api.anthropic.com").unwrap_err(),
            OFFLINE_REFUSAL
        );
        assert!(anthropic_client_builder_gated(false, "https://api.anthropic.com").is_ok());
        assert!(local_client_builder_gated(true, "http://127.0.0.2:9/v1").is_err());
        assert!(local_client_builder_gated(false, "http://127.0.0.1:9/v1").is_ok());
    }

    async fn lookalike_canary() -> (u16, tokio::task::JoinHandle<bool>) {
        let l = tokio::net::TcpListener::bind("127.0.0.2:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_millis(300), l.accept())
                .await
                .is_ok()
        });
        (port, h)
    }

    /// Canary: offline chat never opens a connection to a non-loopback host.
    /// 127.0.0.2 is a loopback-range lookalike and must stay silent.
    #[tokio::test]
    async fn offline_chat_never_contacts_lookalike() {
        let (port, canary) = lookalike_canary().await;
        let body = json!({"model": DEFAULT_LOCAL_MODEL, "messages": [{"role": "user", "content": "document-text-canary"}]});
        let err = send_chat_gated(
            true,
            &client().unwrap(),
            &format!("http://127.0.0.2:{port}/v1"),
            &body,
        )
        .await
        .unwrap_err();
        assert!(err.contains("remote-not-allowed"), "{err}");
        assert!(!err.contains("127.0.0.2"), "{err}");
        assert!(
            !canary.await.unwrap(),
            "offline chat contacted the lookalike"
        );
    }

    /// Canary: offline embeddings never open a connection to a non-loopback host.
    #[tokio::test]
    async fn offline_embeddings_never_contact_lookalike() {
        let (port, canary) = lookalike_canary().await;
        let err = crate::embed::fetch_embeddings_at_gated(
            true,
            &client().unwrap(),
            &format!("http://127.0.0.2:{port}"),
            "nomic-embed-text",
            &["document-text-canary".to_string()],
        )
        .await
        .unwrap_err();
        assert!(err.contains("remote-not-allowed"), "{err}");
        assert!(!err.contains("127.0.0.2"), "{err}");
        assert!(
            !canary.await.unwrap(),
            "offline embeddings contacted the lookalike"
        );
    }

    /// `offline: false` keeps today's loopback chat and embedding calls.
    #[tokio::test]
    async fn offline_false_keeps_todays_loopback_chat_and_embeddings() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let server = tokio::spawn(answer_once(
            l,
            "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}".into(),
        ));
        let resp = send_chat_gated(
            false,
            &client().unwrap(),
            &format!("http://127.0.0.1:{port}/v1"),
            &json!({"model": DEFAULT_LOCAL_MODEL, "messages": []}),
        )
        .await
        .unwrap();
        assert!(resp.status().is_success());
        assert!(server.await.unwrap().contains("POST /v1/chat/completions "));

        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let body = r#"{"embeddings":[[0.5]]}"#;
        let reply = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let server = tokio::spawn(answer_once(l, reply));
        let vecs = crate::embed::fetch_embeddings_at_gated(
            false,
            &client().unwrap(),
            &format!("http://127.0.0.1:{port}"),
            "nomic-embed-text",
            &["hello".to_string()],
        )
        .await
        .unwrap();
        assert_eq!(vecs, vec![vec![0.5]]);
        assert!(server.await.unwrap().contains("POST /api/embed "));
    }
}
