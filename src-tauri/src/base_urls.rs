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

/// Why an `ANTHROPIC_BASE_URL` value was refused. Messages never echo the
/// value, so a key pasted into the variable by mistake is not printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseUrlRefusal {
    Malformed,
    Scheme,
    HttpNotLoopback,
    Userinfo,
    QueryOrFragment,
}

impl std::fmt::Display for BaseUrlRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let why = match self {
            Self::Malformed => "it is not a valid URL",
            Self::Scheme => "only https:// is allowed (http:// only for 127.0.0.1 and [::1])",
            Self::HttpNotLoopback => {
                "plain http:// is allowed only for 127.0.0.1 and [::1]; use https:// for any other host, including localhost"
            }
            Self::Userinfo => "a user name or password in the URL is not allowed",
            Self::QueryOrFragment => "a query (?) or fragment (#) is not allowed",
        };
        write!(
            f,
            "ANTHROPIC_BASE_URL refused: {why}. No request was sent. Unset it to use {DEFAULT_ANTHROPIC_BASE_URL}."
        )
    }
}

fn valid_port(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 5
        && p.bytes().all(|b| b.is_ascii_digit())
        && matches!(p.parse::<u32>(), Ok(1..=65535))
}

fn valid_dns_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn valid_ipv6_literal(h: &str) -> bool {
    h.len() > 2
        && h.starts_with('[')
        && h.ends_with(']')
        && h[1..h.len() - 1].parse::<std::net::Ipv6Addr>().is_ok()
}

/// Validate an `ANTHROPIC_BASE_URL` value (trailing slashes trimmed).
///
/// Unset or blank means the default. Otherwise the value must be `https://`
/// to any valid host, or plain `http://` to the loopback literals `127.0.0.1`
/// or `[::1]` only (the name `localhost` is refused for http). Userinfo, a
/// query, a fragment, other schemes and malformed URLs are refused. This
/// tightens #131, which used any value as given.
pub fn anthropic_base_url_checked_from(raw: Option<&str>) -> Result<String, BaseUrlRefusal> {
    let Some(v) = clean(raw) else {
        return Ok(DEFAULT_ANTHROPIC_BASE_URL.to_string());
    };
    if v.len() > 2048 || !v.bytes().all(|b| (0x21..=0x7e).contains(&b)) || v.contains('\\') {
        return Err(BaseUrlRefusal::Malformed);
    }
    let Some(colon) = v.find("://") else {
        return Err(if v.contains(':') && !v.contains('/') {
            BaseUrlRefusal::Malformed
        } else if v.contains(':') {
            BaseUrlRefusal::Scheme
        } else {
            BaseUrlRefusal::Malformed
        });
    };
    let scheme = v[..colon].to_ascii_lowercase();
    let https = match scheme.as_str() {
        "https" => true,
        "http" => false,
        s if !s.is_empty()
            && s.as_bytes()[0].is_ascii_alphabetic()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-')) =>
        {
            return Err(BaseUrlRefusal::Scheme)
        }
        _ => return Err(BaseUrlRefusal::Malformed),
    };
    let rest = &v[colon + 3..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if authority.contains('@') {
        return Err(BaseUrlRefusal::Userinfo);
    }
    if tail.contains(['?', '#']) {
        return Err(BaseUrlRefusal::QueryOrFragment);
    }
    let (host, port) = if authority.starts_with('[') {
        let close = authority.find(']').ok_or(BaseUrlRefusal::Malformed)?;
        let after = &authority[close + 1..];
        let port = match after.strip_prefix(':') {
            Some(p) => Some(p),
            None if after.is_empty() => None,
            None => return Err(BaseUrlRefusal::Malformed),
        };
        let host = &authority[..=close];
        if !valid_ipv6_literal(host) {
            return Err(BaseUrlRefusal::Malformed);
        }
        (host, port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    if let Some(p) = port {
        if !valid_port(p) {
            return Err(BaseUrlRefusal::Malformed);
        }
    }
    if !host.starts_with('[') && !valid_dns_host(host) {
        return Err(BaseUrlRefusal::Malformed);
    }
    let path_ok = tail
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-' | b'/'))
        && !tail.contains("//")
        && !tail.split('/').any(|seg| seg == "." || seg == "..");
    if !path_ok {
        return Err(BaseUrlRefusal::Malformed);
    }
    if !https {
        let h = host.to_ascii_lowercase();
        if h != "127.0.0.1" && h != "[::1]" {
            return Err(BaseUrlRefusal::HttpNotLoopback);
        }
    }
    Ok(v)
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

/// Anthropic base URL from `ANTHROPIC_BASE_URL`, validated. Call this at
/// request time, before the API key is attached to any request.
pub fn anthropic_base_url_checked() -> Result<String, BaseUrlRefusal> {
    anthropic_base_url_checked_from(std::env::var("ANTHROPIC_BASE_URL").ok().as_deref())
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
            assert_eq!(
                anthropic_base_url_checked_from(v).as_deref(),
                Ok(DEFAULT_ANTHROPIC_BASE_URL)
            );
            assert_eq!(ollama_base_url_from(v), DEFAULT_OLLAMA_BASE_URL);
            assert_eq!(ollama_override(v), None);
        }
    }

    fn ok(v: &str) -> String {
        anthropic_base_url_checked_from(Some(v)).unwrap_or_else(|e| panic!("{v}: {e}"))
    }

    fn refused(v: &str) -> BaseUrlRefusal {
        anthropic_base_url_checked_from(Some(v)).expect_err(v)
    }

    #[test]
    fn anthropic_allowed_values() {
        assert_eq!(ok("http://127.0.0.1:4000"), "http://127.0.0.1:4000");
        assert_eq!(ok("http://127.0.0.1"), "http://127.0.0.1");
        assert_eq!(
            ok("http://[::1]:4000/anthropic"),
            "http://[::1]:4000/anthropic"
        );
        assert_eq!(
            ok(" https://gw.example/anthropic/// "),
            "https://gw.example/anthropic"
        );
        assert_eq!(ok("https://api.anthropic.com"), "https://api.anthropic.com");
        assert_eq!(
            ok("https://gw.example.com:8443/v1-proxy"),
            "https://gw.example.com:8443/v1-proxy"
        );
        assert_eq!(ok("HTTPS://GW.Example.com"), "HTTPS://GW.Example.com");
        assert_eq!(ok("https://localhost:4000"), "https://localhost:4000");
        assert_eq!(ok("https://10.0.0.5"), "https://10.0.0.5");
        assert_eq!(ok("https://[2001:db8::1]:443"), "https://[2001:db8::1]:443");
    }

    #[test]
    fn anthropic_http_only_for_loopback_literals() {
        for v in [
            "http://localhost:4000",
            "http://LOCALHOST",
            "http://gw.localhost:4000",
            "http://gw.example.com",
            "http://10.0.0.5:4000",
            "http://127.0.0.2:4000",
            "http://[::2]:4000",
            "http://0.0.0.0:4000",
        ] {
            assert_eq!(refused(v), BaseUrlRefusal::HttpNotLoopback, "{v}");
        }
    }

    #[test]
    fn anthropic_other_schemes_refused() {
        for v in [
            "ftp://gw.example.com",
            "ws://127.0.0.1:4000",
            "file:///etc/passwd",
            "javascript://x",
        ] {
            assert_eq!(refused(v), BaseUrlRefusal::Scheme, "{v}");
        }
    }

    #[test]
    fn anthropic_userinfo_refused() {
        for v in [
            "https://user:pass@gw.example.com",
            "https://sk-ant-123@gw.example.com",
            "http://u@127.0.0.1:4000",
        ] {
            assert_eq!(refused(v), BaseUrlRefusal::Userinfo, "{v}");
        }
    }

    #[test]
    fn anthropic_query_and_fragment_refused() {
        for v in [
            "https://gw.example.com/?key=x",
            "https://gw.example.com#f",
            "http://127.0.0.1:4000/a?b",
        ] {
            assert_eq!(refused(v), BaseUrlRefusal::QueryOrFragment, "{v}");
        }
    }

    #[test]
    fn anthropic_malformed_refused() {
        for v in [
            "gw.example.com",
            "127.0.0.1:4000",
            "https://",
            "https:///v1",
            "://gw.example.com",
            "https://gw .example.com",
            "https://gw..example.com",
            "https://gw.example.com:0",
            "https://gw.example.com:99999",
            "https://gw.example.com:80a",
            "https://[::1",
            "https://[nothex]",
            "https://gw.example.com/a/../b",
            "https://gw.example.com/a//b",
            "https://gw.example.com/a%2fb",
            "https:\\\\gw.example.com",
            "https://gw_example.com",
        ] {
            assert_eq!(refused(v), BaseUrlRefusal::Malformed, "{v}");
        }
    }

    #[test]
    fn anthropic_refusal_message_never_echoes_the_value() {
        let v = "https://sk-ant-secret-123@gw.example.com/?k=sk-ant-secret-123";
        let msg = refused(v).to_string();
        assert!(!msg.contains("sk-ant"), "{msg}");
        assert!(!msg.contains("gw.example.com"), "{msg}");
        assert!(msg.contains("ANTHROPIC_BASE_URL refused"));
        assert!(msg.contains("No request was sent"));
        assert!(BaseUrlRefusal::HttpNotLoopback
            .to_string()
            .contains("127.0.0.1 and [::1]"));
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
