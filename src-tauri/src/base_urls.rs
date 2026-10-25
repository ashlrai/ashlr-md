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

// The app reads `OLLAMA_HOST` through the loopback gate in
// `local_inference::ollama_base_url`.

/// Opt-in switch: `ASHLR_MD_ANTHROPIC_KEY_FROM_ENV=1` makes the app read the
/// Anthropic key from `ANTHROPIC_API_KEY` instead of the key saved in
/// Settings. Off (Settings only) unless the value is exactly `1`.
pub const ANTHROPIC_KEY_FROM_ENV_VAR: &str = "ASHLR_MD_ANTHROPIC_KEY_FROM_ENV";

/// What kind of value `ANTHROPIC_API_KEY` holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvKeyKind {
    /// A `phm_` session placeholder from `phantom exec`.
    Placeholder,
    /// Anything else (a real key).
    Plain,
}

/// The Anthropic key read from the environment. `Debug` never prints it.
#[derive(Clone, PartialEq, Eq)]
pub struct EnvKey {
    pub value: String,
    pub kind: EnvKeyKind,
}

impl std::fmt::Debug for EnvKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnvKey")
            .field("value", &"<redacted>")
            .field("kind", &self.kind)
            .finish()
    }
}

/// Why the environment key cannot be used. Messages never echo a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvKeyRefusal {
    Unset,
    Malformed,
    Reference,
    PlaceholderNeedsProxy,
    BaseUrl(BaseUrlRefusal),
}

impl std::fmt::Display for EnvKeyRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unset => write!(
                f,
                "{ANTHROPIC_KEY_FROM_ENV_VAR}=1 but ANTHROPIC_API_KEY is not set. No request was sent."
            ),
            Self::Malformed => write!(
                f,
                "ANTHROPIC_API_KEY holds spaces or characters that cannot go in a request header. No request was sent."
            ),
            Self::Reference => write!(
                f,
                "ANTHROPIC_API_KEY is a phm: reference, which Ashlr MD does not resolve. Start the app under `phantom exec` so it holds a phm_ placeholder. No request was sent."
            ),
            Self::PlaceholderNeedsProxy => write!(
                f,
                "ANTHROPIC_API_KEY is a phm_ placeholder, but ANTHROPIC_BASE_URL does not point at this session's Phantom proxy (http://127.0.0.1 or http://[::1] on PHANTOM_PROXY_PORT). No request was sent."
            ),
            Self::BaseUrl(r) => r.fmt(f),
        }
    }
}

/// Host and port of a URL that already passed [`anthropic_base_url_checked_from`].
fn checked_host_port(url: &str) -> (String, Option<u16>) {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = &rest[..rest.find('/').unwrap_or(rest.len())];
    if let Some(close) = authority.find(']') {
        let port = authority[close + 1..]
            .strip_prefix(':')
            .and_then(|p| p.parse().ok());
        (authority[..=close].to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_ascii_lowercase(), p.parse().ok()),
            None => (authority.to_ascii_lowercase(), None),
        }
    }
}

/// Pick the Anthropic key from the environment, given the raw values of
/// `ASHLR_MD_ANTHROPIC_KEY_FROM_ENV`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
/// and `PHANTOM_PROXY_PORT`.
///
/// `None` means the opt-in is off: use the Settings key, as always. When it is
/// on, the environment key is the only one used (there is no silent fallback
/// to Settings):
/// - an unset or blank key, a `phm:` reference, or a value with whitespace or
///   control characters is refused;
/// - `ANTHROPIC_BASE_URL` must pass the usual rules;
/// - a `phm_` placeholder additionally needs `ANTHROPIC_BASE_URL` set to the
///   loopback literal `127.0.0.1` or `[::1]` with a port, and that port must be
///   `PHANTOM_PROXY_PORT` when it is set, so a placeholder never goes to the
///   real provider.
pub fn anthropic_env_key_from(
    opt_in: Option<&str>,
    key: Option<&str>,
    base_url: Option<&str>,
    proxy_port: Option<&str>,
) -> Option<Result<EnvKey, EnvKeyRefusal>> {
    if opt_in.map(str::trim) != Some("1") {
        return None;
    }
    Some((|| {
        let value = key.map(str::trim).unwrap_or("");
        if value.is_empty() {
            return Err(EnvKeyRefusal::Unset);
        }
        if !value.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
            return Err(EnvKeyRefusal::Malformed);
        }
        if value.starts_with("phm:") {
            return Err(EnvKeyRefusal::Reference);
        }
        let base = anthropic_base_url_checked_from(base_url).map_err(EnvKeyRefusal::BaseUrl)?;
        let kind = if value.starts_with("phm_") {
            EnvKeyKind::Placeholder
        } else {
            EnvKeyKind::Plain
        };
        if kind == EnvKeyKind::Placeholder {
            if clean(base_url).is_none() {
                return Err(EnvKeyRefusal::PlaceholderNeedsProxy);
            }
            let (host, port) = checked_host_port(&base);
            let loopback = host == "127.0.0.1" || host == "[::1]";
            let want = proxy_port.and_then(|p| p.trim().parse::<u16>().ok());
            let port_ok = match (port, want) {
                (Some(p), Some(w)) => p == w,
                (Some(_), None) => true,
                (None, _) => false,
            };
            if !loopback || !port_ok {
                return Err(EnvKeyRefusal::PlaceholderNeedsProxy);
            }
        }
        Ok(EnvKey {
            value: value.to_string(),
            kind,
        })
    })())
}

/// [`anthropic_env_key_from`] on the process environment. Read at call time.
pub fn anthropic_env_key() -> Option<Result<EnvKey, EnvKeyRefusal>> {
    let get = |k: &str| std::env::var(k).ok();
    anthropic_env_key_from(
        get(ANTHROPIC_KEY_FROM_ENV_VAR).as_deref(),
        get("ANTHROPIC_API_KEY").as_deref(),
        get("ANTHROPIC_BASE_URL").as_deref(),
        get("PHANTOM_PROXY_PORT").as_deref(),
    )
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

    // ---- ANTHROPIC_API_KEY from the environment (opt-in) ----

    const PROXY: &str = "http://127.0.0.1:41000/anthropic/_phantom/tok123";

    fn env_key(
        opt: Option<&str>,
        key: Option<&str>,
        base: Option<&str>,
        port: Option<&str>,
    ) -> Option<Result<EnvKey, EnvKeyRefusal>> {
        anthropic_env_key_from(opt, key, base, port)
    }

    #[test]
    fn env_key_is_off_unless_opted_in() {
        for opt in [
            None,
            Some(""),
            Some("0"),
            Some("true"),
            Some("yes"),
            Some("11"),
        ] {
            assert_eq!(
                env_key(opt, Some("sk-ant-real"), None, None),
                None,
                "{opt:?}"
            );
        }
        assert!(env_key(Some(" 1 "), Some("sk-ant-real"), None, None).is_some());
    }

    #[test]
    fn env_key_plain_key_uses_the_checked_base() {
        let k = env_key(Some("1"), Some(" sk-ant-real "), None, None)
            .unwrap()
            .unwrap();
        assert_eq!(k.value, "sk-ant-real");
        assert_eq!(k.kind, EnvKeyKind::Plain);
        assert_eq!(
            env_key(
                Some("1"),
                Some("sk-ant-real"),
                Some("http://gw.example.com"),
                None
            ),
            Some(Err(EnvKeyRefusal::BaseUrl(BaseUrlRefusal::HttpNotLoopback)))
        );
    }

    #[test]
    fn env_key_placeholder_needs_the_session_proxy() {
        let k = env_key(Some("1"), Some("phm_abc123"), Some(PROXY), Some("41000"))
            .unwrap()
            .unwrap();
        assert_eq!(k.kind, EnvKeyKind::Placeholder);
        assert_eq!(k.value, "phm_abc123");
        // No PHANTOM_PROXY_PORT: any loopback port is accepted.
        assert!(env_key(Some("1"), Some("phm_abc123"), Some(PROXY), None)
            .unwrap()
            .is_ok());
        assert!(env_key(
            Some("1"),
            Some("phm_abc123"),
            Some("http://[::1]:41000/x"),
            Some("41000")
        )
        .unwrap()
        .is_ok());
        for (base, port) in [
            (None, Some("41000")),                     // default api.anthropic.com
            (Some("https://api.anthropic.com"), None), // the real provider
            (Some("https://gw.example.com:41000"), Some("41000")),
            (Some(PROXY), Some("41001")), // another session
            (Some("http://127.0.0.1/anthropic"), None), // no port
        ] {
            assert_eq!(
                env_key(Some("1"), Some("phm_abc123"), base, port),
                Some(Err(EnvKeyRefusal::PlaceholderNeedsProxy)),
                "{base:?} {port:?}"
            );
        }
        // A refused base URL is reported as such, before the placeholder rule.
        assert_eq!(
            env_key(
                Some("1"),
                Some("phm_abc123"),
                Some("http://localhost:41000"),
                None
            ),
            Some(Err(EnvKeyRefusal::BaseUrl(BaseUrlRefusal::HttpNotLoopback)))
        );
    }

    #[test]
    fn env_key_refusals_never_echo_values() {
        let cases = [
            (Some(""), EnvKeyRefusal::Unset),
            (None, EnvKeyRefusal::Unset),
            (Some("phm:ANTHROPIC_SECRETVALUE"), EnvKeyRefusal::Reference),
            (Some("sk-ant SECRETVALUE"), EnvKeyRefusal::Malformed),
            (Some("sk-ant-SECRETVALUE\r\nX: y"), EnvKeyRefusal::Malformed),
        ];
        for (key, want) in cases {
            let got = env_key(Some("1"), key, None, None).unwrap().unwrap_err();
            assert_eq!(got, want);
            let msg = got.to_string();
            assert!(msg.contains("No request was sent"), "{msg}");
            assert!(!msg.contains("SECRETVALUE"), "{msg}");
        }
        let msg = env_key(Some("1"), Some("phm_SECRETVALUE"), None, None)
            .unwrap()
            .unwrap_err()
            .to_string();
        assert!(!msg.contains("SECRETVALUE"), "{msg}");
        let dbg = format!(
            "{:?}",
            env_key(Some("1"), Some("sk-ant-SECRETVALUE"), None, None).unwrap()
        );
        assert!(!dbg.contains("SECRETVALUE"), "{dbg}");
    }
}
