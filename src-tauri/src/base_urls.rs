//! Base URLs for model providers, overridable from the environment.
//!
//! `ANTHROPIC_BASE_URL` and `OLLAMA_HOST` let a gateway (a LiteLLM proxy, a
//! Phantom proxy, or a remote Ollama box) sit in front of the providers.
//! When a variable is unset or blank the defaults are exactly the URLs the
//! app always called. Values are read at call time, not cached.
//!
//! Shared with the mdopener-mcp sidecar through `#[path]`, so it must only
//! use `std`.

/// Anthropic API root (the app appends `/v1/messages`).
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
/// Local Ollama server.
pub const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434";
/// Port Ollama listens on when `OLLAMA_HOST` names a host without one.
const OLLAMA_DEFAULT_PORT: &str = "11434";

/// Trim whitespace and trailing slashes. `None` when nothing is left.
fn clean(raw: Option<&str>) -> Option<String> {
    let v = raw?.trim().trim_end_matches('/').trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// `ANTHROPIC_BASE_URL` value, used as given (trailing slashes trimmed).
pub fn anthropic_base_url_from(raw: Option<&str>) -> String {
    clean(raw).unwrap_or_else(|| DEFAULT_ANTHROPIC_BASE_URL.to_string())
}

/// `OLLAMA_HOST` normalized to a base URL, or `None` when unset or blank.
///
/// Accepts the forms Ollama itself accepts: `host`, `host:port`, `:port`
/// (localhost) and a full `http://` or `https://` URL. A missing scheme
/// becomes `http://` and a missing port becomes 11434.
pub fn ollama_override(raw: Option<&str>) -> Option<String> {
    let v = clean(raw)?;
    let lower = v.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(v);
    }
    let v = if v.starts_with(':') {
        format!("localhost{v}")
    } else {
        v
    };
    let (authority, path) = match v.find('/') {
        Some(i) => (&v[..i], &v[i..]),
        None => (v.as_str(), ""),
    };
    let has_port = match authority.rfind(']') {
        // Bracketed IPv6 literal: a port follows the closing bracket.
        Some(i) => authority[i + 1..].starts_with(':'),
        None => authority.contains(':'),
    };
    if has_port {
        Some(format!("http://{authority}{path}"))
    } else {
        Some(format!("http://{authority}:{OLLAMA_DEFAULT_PORT}{path}"))
    }
}

/// `OLLAMA_HOST` value as a base URL, falling back to the local default.
pub fn ollama_base_url_from(raw: Option<&str>) -> String {
    ollama_override(raw).unwrap_or_else(|| DEFAULT_OLLAMA_BASE_URL.to_string())
}

/// Anthropic base URL from the `ANTHROPIC_BASE_URL` environment variable.
pub fn anthropic_base_url() -> String {
    anthropic_base_url_from(std::env::var("ANTHROPIC_BASE_URL").ok().as_deref())
}

/// Ollama base URL from the `OLLAMA_HOST` environment variable.
pub fn ollama_base_url() -> String {
    ollama_base_url_from(std::env::var("OLLAMA_HOST").ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_unchanged() {
        assert_eq!(DEFAULT_ANTHROPIC_BASE_URL, "https://api.anthropic.com");
        assert_eq!(DEFAULT_OLLAMA_BASE_URL, "http://localhost:11434");
        for v in [None, Some(""), Some("   "), Some("/"), Some(" // ")] {
            assert_eq!(anthropic_base_url_from(v), DEFAULT_ANTHROPIC_BASE_URL);
            assert_eq!(ollama_base_url_from(v), DEFAULT_OLLAMA_BASE_URL);
            assert_eq!(ollama_override(v), None);
        }
    }

    #[test]
    fn anthropic_override_used_as_given() {
        assert_eq!(
            anthropic_base_url_from(Some("http://127.0.0.1:4000")),
            "http://127.0.0.1:4000"
        );
        assert_eq!(
            anthropic_base_url_from(Some(" https://gw.example/anthropic/// ")),
            "https://gw.example/anthropic"
        );
    }

    #[test]
    fn ollama_host_port_gets_http() {
        assert_eq!(
            ollama_base_url_from(Some("192.168.1.5:9999")),
            "http://192.168.1.5:9999"
        );
        assert_eq!(
            ollama_base_url_from(Some("gpu-box:11435/")),
            "http://gpu-box:11435"
        );
    }

    #[test]
    fn ollama_missing_port_and_leading_colon() {
        assert_eq!(
            ollama_base_url_from(Some("gpu-box")),
            "http://gpu-box:11434"
        );
        assert_eq!(ollama_base_url_from(Some(":8080")), "http://localhost:8080");
        assert_eq!(
            ollama_base_url_from(Some("[::1]:11434")),
            "http://[::1]:11434"
        );
        assert_eq!(ollama_base_url_from(Some("[::1]")), "http://[::1]:11434");
        assert_eq!(
            ollama_base_url_from(Some("gpu-box/ollama")),
            "http://gpu-box:11434/ollama"
        );
    }

    #[test]
    fn ollama_full_url_kept() {
        assert_eq!(
            ollama_base_url_from(Some("https://ollama.example.com/")),
            "https://ollama.example.com"
        );
        assert_eq!(ollama_base_url_from(Some("HTTP://h:1")), "HTTP://h:1");
    }
}
