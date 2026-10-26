//! The pure `localInference` gate (phantom #917 rules): config parsing and
//! base-URL validation with closed refusal codes. No network. Shared by the
//! app (`local_inference.rs`) and the `mdopener-mcp` sidecar (via `#[path]`),
//! so both apply exactly the same rules to `~/.ashlr/config.json`.

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
    let parsed = url::Url::parse(url).map_err(|_| R::BaseUrlInvalid)?;
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
    pub offline: bool,
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
    let offline = match obj.get("offline") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("localInference.offline: must be a boolean".into()),
    };
    // Offline wins over allowRemote: only loopback is ever allowed.
    let allow_remote = allow_remote && !offline;
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
        offline,
    }))
}

pub fn config_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".ashlr").join("config.json"))
}

pub fn read_config_value() -> Option<Value> {
    let text = std::fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

/// The `localInference` block from `~/.ashlr/config.json`.
pub fn load() -> Result<Option<LocalInferenceConfig>, String> {
    let root = read_config_value();
    parse_local_inference(root.as_ref().and_then(|r| r.get("localInference")))
}

/// `localInference.offline` from the parsed config root. Fails closed: any
/// non-boolean value present counts as offline, so a typo never turns the
/// guarantee off. Absent means false (no change for existing users).
pub fn offline_from(root: Option<&Value>) -> bool {
    match root.and_then(|r| r.get("localInference")?.get("offline")) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => true,
    }
}

/// `localInference.allowRemote`, forced false when offline.
pub fn effective_allow_remote(root: Option<&Value>) -> bool {
    !offline_from(root)
        && root
            .and_then(|r| r.get("localInference")?.get("allowRemote")?.as_bool())
            .unwrap_or(false)
}

/// Offline mode from `~/.ashlr/config.json`.
pub fn offline() -> bool {
    offline_from(read_config_value().as_ref())
}

/// The refusal for any cloud call in offline mode. Value-free.
pub const OFFLINE_REFUSAL: &str = "Offline mode (localInference.offline in ~/.ashlr/config.json): cloud AI is disabled. No request was sent.";

/// When `offline` is set, `base` must already be an exact loopback URL
/// (`127.0.0.1`, `[::1]`, or `localhost`). Lookalikes are refused. Nothing
/// in the environment is consulted, so no variable can widen the set.
/// When `offline` is false this is a no-op: callers keep today's checks.
pub fn ensure_offline_loopback(offline: bool, base: &str) -> Result<(), String> {
    if !offline {
        return Ok(());
    }
    validate_local_base_url(base, false)
        .map(|_| ())
        .map_err(|why| {
            format!(
                "Offline mode (localInference.offline): host refused ({why}). No request was sent."
            )
        })
}
