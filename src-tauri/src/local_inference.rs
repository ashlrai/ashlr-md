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
//!   "allowRemote": false                      // default
//! }
//! ```
//!
//! Rules:
//! - Loopback only by default: `127.0.0.1`, `[::1]` and `localhost`, written
//!   exactly that way (`127.0.0.2`, `2130706433`, `localhost.evil.com` and
//!   trailing dots are refused).
//! - A non-loopback URL needs `allowRemote: true` in the config file AND
//!   https. The environment can never widen this.
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

/// Default model, per phantom docs/LOCAL-INFERENCE.md.
pub const DEFAULT_LOCAL_MODEL: &str = "qwen3.8:27b";

pub const LOCAL_INFERENCE_PROVIDERS: [&str; 3] = ["ollama", "omlx", "openai-compat"];

const MAX_URL_LENGTH: usize = 2048;
const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "[::1]", "localhost"];

/// Closed refusal codes, same strings as phantom #917.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalUrlRefusal {
    BaseUrlInvalid,
    SchemeNotAllowed,
    UserinfoNotAllowed,
    QueryNotAllowed,
    FragmentNotAllowed,
    HostNotCanonical,
    PortInvalid,
    PathNotAllowed,
    RemoteNotAllowed,
    RemoteRequiresHttps,
}

impl LocalUrlRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::BaseUrlInvalid => "base-url-invalid",
            Self::SchemeNotAllowed => "scheme-not-allowed",
            Self::UserinfoNotAllowed => "userinfo-not-allowed",
            Self::QueryNotAllowed => "query-not-allowed",
            Self::FragmentNotAllowed => "fragment-not-allowed",
            Self::HostNotCanonical => "host-not-canonical",
            Self::PortInvalid => "port-invalid",
            Self::PathNotAllowed => "path-not-allowed",
            Self::RemoteNotAllowed => "remote-not-allowed",
            Self::RemoteRequiresHttps => "remote-requires-https",
        }
    }
}

impl std::fmt::Display for LocalUrlRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalUrl {
    pub base_url: String,
    pub loopback: bool,
}

pub fn is_loopback_host(host: &str) -> bool {
    LOOPBACK_HOSTS.contains(&host.to_ascii_lowercase().as_str())
}

fn split_authority(authority: &str) -> Option<(&str, Option<&str>)> {
    if authority.starts_with('[') {
        let end = authority.find(']')?;
        let (host, tail) = authority.split_at(end + 1);
        if tail.is_empty() {
            return Some((host, None));
        }
        return tail.strip_prefix(':').map(|p| (host, Some(p)));
    }
    match authority.rfind(':') {
        None => Some((authority, None)),
        Some(i) => Some((&authority[..i], Some(&authority[i + 1..]))),
    }
}

fn safe_path(p: &str) -> bool {
    p.is_empty()
        || (p.starts_with('/')
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || "/._~-".contains(c)))
}

/// Validate a base URL. Loopback passes; anything else needs
/// `allow_remote` and https.
pub fn validate_local_base_url(raw: &str, allow_remote: bool) -> Result<LocalUrl, LocalUrlRefusal> {
    use LocalUrlRefusal as R;
    let url = raw.trim();
    if url.is_empty() || url.len() > MAX_URL_LENGTH {
        return Err(R::BaseUrlInvalid);
    }
    if !url.bytes().all(|b| (0x21..=0x7e).contains(&b)) || url.contains('\\') {
        return Err(R::BaseUrlInvalid);
    }
    let Some(colon) = url.find(':') else {
        return Err(R::BaseUrlInvalid);
    };
    let scheme = &url[..colon];
    if scheme.is_empty()
        || !scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    {
        return Err(R::BaseUrlInvalid);
    }
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return Err(R::SchemeNotAllowed);
    }
    let Some(after) = url[colon + 1..].strip_prefix("//") else {
        return Err(R::BaseUrlInvalid);
    };
    if url.contains('#') {
        return Err(R::FragmentNotAllowed);
    }
    if url.contains('?') {
        return Err(R::QueryNotAllowed);
    }
    let (authority, path) = match after.find('/') {
        Some(i) => (&after[..i], &after[i..]),
        None => (after, ""),
    };
    if authority.contains('@') {
        return Err(R::UserinfoNotAllowed);
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| R::BaseUrlInvalid)?;
    let Some((host_raw, port_raw)) = split_authority(authority) else {
        return Err(R::HostNotCanonical);
    };
    let host = host_raw.to_ascii_lowercase();
    // Url rewrites 0x7f.1, 2130706433 and percent-encoding; the raw text must
    // already be canonical so "loopback" means what was written.
    if host.is_empty() || parsed.host_str() != Some(host.as_str()) || host.ends_with('.') {
        return Err(R::HostNotCanonical);
    }
    if let Some(p) = port_raw {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return Err(R::PortInvalid);
        }
        match p.parse::<u32>() {
            Ok(n) if (1..=65535).contains(&n) => {}
            _ => return Err(R::PortInvalid),
        }
    }
    if !safe_path(path) {
        return Err(R::PathNotAllowed);
    }
    let trimmed = path.trim_end_matches('/');
    if !trimmed.is_empty()
        && trimmed[1..]
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(R::PathNotAllowed);
    }
    if parsed.path().trim_end_matches('/') != trimmed {
        return Err(R::PathNotAllowed);
    }
    let loopback = is_loopback_host(&host);
    if !loopback {
        if !allow_remote {
            return Err(R::RemoteNotAllowed);
        }
        if scheme != "https" {
            return Err(R::RemoteRequiresHttps);
        }
    }
    let origin = parsed.origin().ascii_serialization();
    Ok(LocalUrl {
        base_url: format!("{origin}{trimmed}"),
        loopback,
    })
}

/// Abliterated or uncensored weights (refusals removed). Matched by name.
pub fn is_abliterated_model(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.contains("abliterat") || m.contains("uncensored")
}

fn provider_default_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "ollama" => Some("http://127.0.0.1:11434/v1"),
        "omlx" => Some("http://127.0.0.1:8000/v1"),
        _ => None,
    }
}

/// A validated `localInference` block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalInferenceConfig {
    pub provider: String,
    pub base_url: String,
    pub loopback: bool,
    pub model: String,
    pub allow_remote: bool,
}

/// Parse a raw `localInference` value. `Ok(None)` means off. Problems are
/// value-free (no URL or model text).
pub fn parse_local_inference(
    value: Option<&Value>,
) -> Result<Option<LocalInferenceConfig>, String> {
    let Some(v) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let Some(obj) = v.as_object() else {
        return Err("localInference: must be an object".into());
    };
    let Some(provider) = obj
        .get("provider")
        .and_then(Value::as_str)
        .filter(|p| LOCAL_INFERENCE_PROVIDERS.contains(p))
    else {
        return Err(format!(
            "localInference.provider: must be one of {}",
            LOCAL_INFERENCE_PROVIDERS.join(", ")
        ));
    };
    let allow_remote = match obj.get("allowRemote") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("localInference.allowRemote: must be a boolean".into()),
    };
    let raw_url = match obj.get("baseUrl") {
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Err("localInference.baseUrl: base-url-invalid".into()),
        None => match provider_default_base_url(provider) {
            Some(d) => d.to_string(),
            None => {
                return Err("localInference.baseUrl: required for provider openai-compat".into())
            }
        },
    };
    let url = validate_local_base_url(&raw_url, allow_remote)
        .map_err(|why| format!("localInference.baseUrl: {why}"))?;
    let model = match obj.get("models").and_then(|m| m.get("coder")) {
        None => DEFAULT_LOCAL_MODEL.to_string(),
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        Some(_) => return Err("localInference.models.coder: must be a non-empty string".into()),
    };
    if is_abliterated_model(&model) {
        return Err("localInference.models.coder: abliterated models are not allowed".into());
    }
    Ok(Some(LocalInferenceConfig {
        provider: provider.to_string(),
        base_url: url.base_url,
        loopback: url.loopback,
        model,
        allow_remote,
    }))
}

fn config_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".ashlr").join("config.json"))
}

fn read_config_value() -> Option<Value> {
    let text = std::fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

/// The `localInference` block from `~/.ashlr/config.json`.
pub fn load() -> Result<Option<LocalInferenceConfig>, String> {
    let root = read_config_value();
    parse_local_inference(root.as_ref().and_then(|r| r.get("localInference")))
}

/// `allowRemote` from the config file only (false when absent or invalid).
fn allow_remote_from_config() -> bool {
    read_config_value()
        .and_then(|r| r.get("localInference")?.get("allowRemote")?.as_bool())
        .unwrap_or(false)
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
    pub provider: String,
    pub model: String,
    pub loopback: bool,
}

/// Status of a valid `localInference` block, or `None` when it is absent or
/// invalid (an invalid block never routes anywhere).
#[tauri::command]
pub fn ai_local_inference_status() -> Option<LocalInferenceStatus> {
    load().ok().flatten().map(|c| LocalInferenceStatus {
        provider: c.provider,
        model: c.model,
        loopback: c.loopback,
    })
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
pub async fn send_chat(
    client: &reqwest::Client,
    base: &str,
    body: &impl Serialize,
) -> Result<reqwest::Response, String> {
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
        let client = reqwest::Client::new();
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
}
