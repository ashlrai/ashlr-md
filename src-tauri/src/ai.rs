//! AI provider bridge — Tauri commands that proxy LLM requests via reqwest.
//!
//! All HTTP calls live here (not in the webview) to avoid CORS restrictions
//! and to keep API keys out of the browser context.
//!
//! Supported providers:
//!   - "ollama"     — local Ollama server at http://localhost:11434
//!   - "anthropic"  — Anthropic Messages API (SSE streaming)
//!
//! `OLLAMA_HOST` and `ANTHROPIC_BASE_URL` override those hosts (see
//! `base_urls.rs`), so a LiteLLM gateway or Phantom proxy can sit in front.
//!
//! Event protocol (JS listens on these channels):
//!   "ai://delta"  { requestId: String, delta: String }   — token chunk
//!   "ai://done"   { requestId: String }                  — stream complete
//!   "ai://error"  { requestId: String, error: String }   — hard error

use futures_util::StreamExt;
use crate::redact;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::base_urls;

// ---------------------------------------------------------------------------
// Shared message type (mirrors TypeScript AIMessage)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Msg {
    pub role: String,
    pub content: String,
}

// ---------------------------------------------------------------------------
// Tauri event payload structs
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct DeltaPayload {
    #[serde(rename = "requestId")]
    request_id: String,
    delta: String,
}

#[derive(Clone, Serialize)]
struct DonePayload {
    #[serde(rename = "requestId")]
    request_id: String,
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    #[serde(rename = "requestId")]
    request_id: String,
    error: String,
}

// ---------------------------------------------------------------------------
// Ollama response types (NDJSON streaming)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

#[derive(Deserialize)]
struct OllamaModel {
    name: String,
}

#[derive(Deserialize)]
struct OllamaChatChunk {
    message: Option<OllamaChatMessage>,
    done: Option<bool>,
}

#[derive(Deserialize)]
struct OllamaChatMessage {
    content: String,
}

// ---------------------------------------------------------------------------
// Anthropic response types (SSE)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AnthropicContentDelta {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicStreamEvent {
    #[serde(rename = "type")]
    kind: String,
    delta: Option<AnthropicContentDelta>,
}

// ---------------------------------------------------------------------------
// Ollama preferred model order
// ---------------------------------------------------------------------------

const OLLAMA_PREFERRED: &[&str] = &["llama3.2", "llama3.1", "qwen2.5", "mistral", "phi3"];

/// Probe Ollama (localhost:11434 unless `OLLAMA_HOST` is set).  Returns the
/// best available model name
/// (by OLLAMA_PREFERRED order, then first installed), or None.
#[tauri::command]
pub async fn ai_detect_ollama() -> Result<Option<String>, String> {
    detect_ollama_at(&base_urls::ollama_base_url()).await
}

/// [`ai_detect_ollama`] against an explicit Ollama base URL.
async fn detect_ollama_at(base: &str) -> Result<Option<String>, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(format!("{base}/api/tags"))
        .send()
        .await
        .map_err(|_| "Ollama not reachable".to_string())?;

    if !resp.status().is_success() {
        return Ok(None);
    }

    let body: OllamaTagsResponse = resp.json().await.map_err(|e| e.without_url().to_string())?;
    if body.models.is_empty() {
        return Ok(None);
    }

    // Normalise model names (strip ":latest" suffix for comparison).
    let names: Vec<String> = body
        .models
        .iter()
        .map(|m| m.name.split(':').next().unwrap_or(&m.name).to_string())
        .collect();

    // Pick by preference order first.
    for preferred in OLLAMA_PREFERRED {
        if let Some(full) = body.models.iter().find(|m| {
            let base = m.name.split(':').next().unwrap_or(&m.name);
            base.starts_with(preferred)
        }) {
            return Ok(Some(full.name.clone()));
        }
    }

    // Fall back to first available.
    drop(names); // silence unused warning
    Ok(Some(body.models[0].name.clone()))
}

// ---------------------------------------------------------------------------
// Main generation command
// ---------------------------------------------------------------------------

/// Stream a chat completion.  Results are delivered via Tauri events rather
/// than the return value so the frontend can start rendering immediately.
///
/// The command returns Ok(()) as soon as the stream task is spawned — the
/// actual data arrives via "ai://delta" / "ai://done" / "ai://error" events.
#[tauri::command]
pub async fn ai_generate(
    app: AppHandle,
    provider: String,
    model: String,
    api_key: Option<String>,
    messages: Vec<Msg>,
    request_id: String,
) -> Result<(), String> {
    // Spawn onto the async runtime so the command returns immediately.
    tauri::async_runtime::spawn(async move {
        let result = match provider.as_str() {
            "ollama" => stream_ollama(app.clone(), model, messages, request_id.clone()).await,
            "anthropic" => match anthropic_key(api_key) {
                Ok(key) => {
                    stream_anthropic(app.clone(), model, key, messages, request_id.clone()).await
                }
                Err(e) => Err(e),
            },
            other => Err(format!("Unknown provider: {other}")),
        };

        if let Err(e) = result {
            let _ = app.emit(
                "ai://error",
                ErrorPayload {
                    request_id,
                    error: e,
                },
            );
        }
    });

    Ok(())
}

/// POST a chat request to Ollama at `base` and return the response once it
/// has a success status. An error never carries `base`'s credentials.
async fn send_ollama_chat(
    client: &Client,
    base: &str,
    body: &impl Serialize,
) -> Result<reqwest::Response, String> {
    let resp = client
        .post(format!("{base}/api/chat"))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {}", e.without_url()))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let body = redact::error_body(&text, &redact::url_secrets(base));
        return Err(format!("Ollama error {status}: {body}"));
    }
    Ok(resp)
}

/// POST a messages request to Anthropic at `base` with `api_key` and return
/// the response once it has a success status. An error never carries the key.
async fn send_anthropic(
    client: &Client,
    base: &str,
    api_key: &str,
    body: &impl Serialize,
) -> Result<reqwest::Response, String> {
    let resp = client
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {}", e.without_url()))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let mut secrets = redact::url_secrets(base);
        secrets.push(api_key.to_string());
        let body = redact::error_body(&text, &secrets);
        return Err(format!("Anthropic error {status}: {body}"));
    }
    Ok(resp)
}

/// Remove the first complete line from a streamed response's bytes and
/// return it decoded and trimmed, or `None` until a newline has arrived.
///
/// The bytes are decoded a whole line at a time: a network chunk can end in
/// the middle of a multi-byte character (an em dash, a curly quote, CJK or an
/// emoji), and decoding each chunk on its own turned both halves into U+FFFD,
/// so the answer (and any text it replaced in the document) showed `�`. A
/// `\n` byte never occurs inside a multi-byte UTF-8 character.
fn take_line(buf: &mut Vec<u8>) -> Option<String> {
    let nl = buf.iter().position(|&b| b == b'\n')?;
    let rest = buf.split_off(nl + 1);
    let line = std::mem::replace(buf, rest);
    Some(String::from_utf8_lossy(&line).trim().to_string())
}

// ---------------------------------------------------------------------------
// Ollama streaming
// ---------------------------------------------------------------------------

async fn stream_ollama(
    app: AppHandle,
    model: String,
    messages: Vec<Msg>,
    request_id: String,
) -> Result<(), String> {
    let client = Client::new();

    #[derive(Serialize)]
    struct OllamaChatRequest {
        model: String,
        messages: Vec<Msg>,
        stream: bool,
    }

    let body = OllamaChatRequest {
        model,
        messages,
        stream: true,
    };

    let resp = send_ollama_chat(&client, &base_urls::ollama_base_url(), &body).await?;

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream read error: {}", e.without_url()))?;
        buf.extend_from_slice(&chunk);

        // NDJSON — process complete lines.
        while let Some(line) = take_line(&mut buf) {
            if line.is_empty() {
                continue;
            }
            if let Ok(chunk_obj) = serde_json::from_str::<OllamaChatChunk>(&line) {
                if let Some(msg) = chunk_obj.message {
                    if !msg.content.is_empty() {
                        let _ = app.emit(
                            "ai://delta",
                            DeltaPayload {
                                request_id: request_id.clone(),
                                delta: msg.content,
                            },
                        );
                    }
                }
                if chunk_obj.done == Some(true) {
                    let _ = app.emit(
                        "ai://done",
                        DonePayload {
                            request_id: request_id.clone(),
                        },
                    );
                    return Ok(());
                }
            }
        }
    }

    // Stream ended without an explicit done marker — emit done anyway.
    let _ = app.emit("ai://done", DonePayload { request_id });
    Ok(())
}

// ---------------------------------------------------------------------------
// Anthropic SSE streaming
// ---------------------------------------------------------------------------

/// Default model constant — easy to update when Anthropic releases new versions.
// The Anthropic model is chosen on the frontend and passed in per request.
/// API version header required by Anthropic.
/// The key for an Anthropic request: the Settings key the frontend passed,
/// unless `ASHLR_MD_ANTHROPIC_KEY_FROM_ENV=1`, in which case only
/// `ANTHROPIC_API_KEY` is used (see [`base_urls::anthropic_env_key_from`]).
/// The environment value stays in this process: it is never sent to the
/// frontend, written to Settings or the keychain, logged, or put in an error.
fn anthropic_key(settings_key: Option<String>) -> Result<String, String> {
    match base_urls::anthropic_env_key() {
        None => Ok(settings_key.unwrap_or_default()),
        Some(Ok(k)) => Ok(k.value),
        Some(Err(why)) => Err(why.to_string()),
    }
}

/// Value-free status of the environment-key opt-in, for the sidebar and
/// Settings. Never carries the key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicEnvKeyStatus {
    /// `ASHLR_MD_ANTHROPIC_KEY_FROM_ENV=1`: the Settings key is not used.
    enabled: bool,
    /// The environment key passes the rules.
    usable: bool,
    /// The key is a `phm_` placeholder.
    placeholder: bool,
    /// Why it cannot be used, when it cannot.
    problem: Option<String>,
}

#[tauri::command]
pub fn anthropic_env_key_status() -> AnthropicEnvKeyStatus {
    match base_urls::anthropic_env_key() {
        None => AnthropicEnvKeyStatus {
            enabled: false,
            usable: false,
            placeholder: false,
            problem: None,
        },
        Some(Ok(k)) => AnthropicEnvKeyStatus {
            enabled: true,
            usable: true,
            placeholder: k.kind == base_urls::EnvKeyKind::Placeholder,
            problem: None,
        },
        Some(Err(why)) => AnthropicEnvKeyStatus {
            enabled: true,
            usable: false,
            placeholder: false,
            problem: Some(why.to_string()),
        },
    }
}

const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Max tokens for responses.
const ANTHROPIC_MAX_TOKENS: u32 = 4096;

async fn stream_anthropic(
    app: AppHandle,
    model: String,
    api_key: String,
    messages: Vec<Msg>,
    request_id: String,
) -> Result<(), String> {
    // Validate the endpoint before anything else: a refused ANTHROPIC_BASE_URL
    // returns here, before a client exists, so the key is never sent.
    let base = base_urls::anthropic_base_url_checked().map_err(|e| e.to_string())?;
    // No redirects: the key goes only to the validated host, never to a
    // redirect target (x-api-key is not stripped on cross-host redirects).
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Anthropic client setup failed: {e}"))?;

    // Separate system messages from user/assistant turns (Anthropic API requirement).
    let system_content: String = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");

    let chat_messages: Vec<&Msg> = messages.iter().filter(|m| m.role != "system").collect();

    #[derive(Serialize)]
    struct AnthropicRequest<'a> {
        model: String,
        max_tokens: u32,
        system: String,
        messages: Vec<&'a Msg>,
        stream: bool,
    }

    let body = AnthropicRequest {
        model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system: system_content,
        messages: chat_messages,
        stream: true,
    };

    let resp = send_anthropic(&client, &base, &api_key, &body).await?;

    // Anthropic streams SSE.  Lines look like:
    //   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream read error: {}", e.without_url()))?;
        buf.extend_from_slice(&chunk);

        // Process complete SSE lines.
        while let Some(line) = take_line(&mut buf) {
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    let _ = app.emit(
                        "ai://done",
                        DonePayload {
                            request_id: request_id.clone(),
                        },
                    );
                    return Ok(());
                }
                if let Ok(event) = serde_json::from_str::<AnthropicStreamEvent>(data) {
                    match event.kind.as_str() {
                        "content_block_delta" => {
                            if let Some(delta) = event.delta {
                                if delta.kind == "text_delta" {
                                    if let Some(text) = delta.text {
                                        if !text.is_empty() {
                                            let _ = app.emit(
                                                "ai://delta",
                                                DeltaPayload {
                                                    request_id: request_id.clone(),
                                                    delta: text,
                                                },
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        "message_stop" => {
                            let _ = app.emit(
                                "ai://done",
                                DonePayload {
                                    request_id: request_id.clone(),
                                },
                            );
                            return Ok(());
                        }
                        "error" => {
                            return Err(format!("Anthropic stream error: {data}"));
                        }
                        _ => {} // ping, message_start, content_block_start, etc.
                    }
                }
            }
        }
    }

    // Stream ended — emit done.
    let _ = app.emit("ai://done", DonePayload { request_id });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::take_line;

    /// A chunk boundary inside a character used to turn it into two U+FFFD.
    #[test]
    fn a_character_split_across_chunks_is_decoded_whole() {
        let event = "data: {\"text\":\"caf\u{e9} \u{2014} \u{1f600}\"}\n";
        let bytes = event.as_bytes();
        for cut in 1..bytes.len() {
            let mut buf = Vec::new();
            buf.extend_from_slice(&bytes[..cut]);
            let mut lines = Vec::new();
            while let Some(l) = take_line(&mut buf) {
                lines.push(l);
            }
            buf.extend_from_slice(&bytes[cut..]);
            while let Some(l) = take_line(&mut buf) {
                lines.push(l);
            }
            assert_eq!(lines, vec![event.trim().to_string()], "cut at {cut}");
            assert!(buf.is_empty());
        }
    }

    #[test]
    fn lines_wait_for_their_newline() {
        let mut buf = b"a\r\n\nb".to_vec();
        assert_eq!(take_line(&mut buf).as_deref(), Some("a"));
        assert_eq!(take_line(&mut buf).as_deref(), Some(""));
        assert_eq!(take_line(&mut buf), None);
        assert_eq!(buf, b"b");
    }
}

/// No key, proxy token or URL credential reaches an error string (and so the
/// `ai://error` event the UI shows), whatever the endpoint answers.
#[cfg(test)]
mod redaction_tests {
    use super::{detect_ollama_at, send_anthropic, send_ollama_chat};
    use crate::test_stub::{closed, leaked_windows, serve, Mode};
    use reqwest::Client;

    const KEY: &str = "sk-ant-CANARYq7X2w9Z4k3M8vB";
    const PROXY_TOKEN: &str = "ptokCANARYh8J3k6L1z4X7cVb";
    const OLLAMA_USER: &str = "ollauser";
    const OLLAMA_PASS: &str = "pwCANARYn1M5q9W3e7R2tYu";

    fn body() -> serde_json::Value {
        serde_json::json!({ "model": "m", "messages": [] })
    }

    fn roots() -> Vec<(&'static str, String)> {
        vec![
            ("401 echoing the request", serve(Mode::Echo401)),
            ("302 redirect", serve(Mode::Redirect)),
            ("closed port", closed()),
        ]
    }

    fn secrets() -> Vec<String> {
        vec![
            KEY.to_string(),
            PROXY_TOKEN.to_string(),
            OLLAMA_PASS.to_string(),
            crate::redact::basic_credential(OLLAMA_USER, OLLAMA_PASS),
        ]
    }

    const NAMES: [&str; 4] = ["api key", "proxy token", "URL password", "Basic credential"];

    /// Each leak as "<case>: <secret> (<n> windows)"; empty when clean.
    fn leaks(label: &str, err: &str) -> Vec<String> {
        secrets()
            .iter()
            .zip(NAMES)
            .filter_map(|(s, name)| {
                let n = leaked_windows(err, s).len();
                (n > 0).then(|| format!("{label}: {name} ({n} windows)"))
            })
            .collect()
    }

    #[tokio::test]
    async fn anthropic_errors_never_carry_the_key_or_proxy_token() {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let mut reached = false;
        let mut found = Vec::new();
        for (label, root) in roots() {
            let base = format!("{root}/x/_phantom/{PROXY_TOKEN}");
            let err = send_anthropic(&client, &base, KEY, &body()).await.expect_err(label);
            if label.starts_with("401") {
                assert!(err.contains("401"), "{label}: did not reach the stub");
                reached = true;
            }
            found.extend(leaks(label, &err));
        }
        assert!(reached);
        assert!(found.is_empty(), "{found:#?}");
    }

    #[tokio::test]
    async fn ollama_errors_never_carry_url_credentials_or_tokens() {
        let client = Client::new();
        let mut reached = false;
        let mut found = Vec::new();
        for (label, root) in roots() {
            let with_creds = root.replace("http://", &format!("http://{OLLAMA_USER}:{OLLAMA_PASS}@"));
            let base = format!("{with_creds}/x/_phantom/{PROXY_TOKEN}");
            let err = send_ollama_chat(&client, &base, &body()).await.expect_err(label);
            if label.starts_with("401") {
                assert!(err.contains("401"), "{label}: did not reach the stub");
                reached = true;
            }
            found.extend(leaks(label, &err));
        }
        assert!(reached);
        assert!(found.is_empty(), "{found:#?}");
    }

    #[tokio::test]
    async fn ollama_detection_errors_never_carry_url_credentials_or_tokens() {
        let mut found = Vec::new();
        let mut cases = roots();
        cases.push(("200 with a bad body", serve(Mode::EchoBadJson)));
        for (label, root) in cases {
            let with_creds = root.replace("http://", &format!("http://{OLLAMA_USER}:{OLLAMA_PASS}@"));
            let base = format!("{with_creds}/x/_phantom/{PROXY_TOKEN}");
            match detect_ollama_at(&base).await {
                Err(err) => found.extend(leaks(label, &err)),
                // A refused or non-2xx probe means "no Ollama", not an error.
                Ok(v) => assert!(v.is_none() && !label.starts_with("200"), "{label}: expected a decode error"),
            }
        }
        assert!(found.is_empty(), "{found:#?}");
    }

    #[tokio::test]
    async fn embedding_errors_never_carry_url_credentials_or_tokens() {
        let client = Client::new();
        let mut cases = roots();
        cases.push(("200 with a bad body", serve(Mode::EchoBadJson)));
        let mut found = Vec::new();
        for (label, root) in cases {
            let with_creds = root.replace("http://", &format!("http://{OLLAMA_USER}:{OLLAMA_PASS}@"));
            let base = format!("{with_creds}/x/_phantom/{PROXY_TOKEN}");
            let err = crate::embed::fetch_embeddings_at(&client, &base, "m", &["hello".to_string()])
                .await
                .expect_err(label);
            found.extend(leaks(label, &err));
        }
        assert!(found.is_empty(), "{found:#?}");
    }
}
