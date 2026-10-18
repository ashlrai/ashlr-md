//! Optional Phantom integration for the Anthropic API key.
//!
//! A key field value of the form `phm:NAME` is a reference, not a key. When the
//! `phantom` CLI is on PATH it is resolved with `phantom reveal --yes NAME`
//! (the call Locus makes). When phantom is missing, slow, or returns nothing,
//! resolution fails with a message that names no secret and the literal
//! reference is never sent to a provider. Plain keys pass through with no
//! process spawned. Resolved values are never logged.
//!
//! Gateway base URLs (`ANTHROPIC_BASE_URL`, `OLLAMA_HOST`) live in
//! `base_urls.rs`; a Phantom proxy or LiteLLM gateway is just a value there.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const PREFIX: &str = "phm:";
const TIMEOUT: Duration = Duration::from_secs(5);

/// True for `phm:NAME` where NAME is 1..=128 of `[A-Za-z0-9_.-]`.
pub fn is_phm_ref(raw: &str) -> bool {
    match raw.trim().strip_prefix(PREFIX) {
        Some(n) => {
            !n.is_empty()
                && n.len() <= 128
                && n.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        }
        None => false,
    }
}

/// Run `phantom reveal --yes NAME`; stdout trimmed, `None` on any failure.
fn reveal(name: &str) -> Option<String> {
    let mut child = Command::new("phantom")
        .args(["reveal", "--yes", name])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let text = reader.join().ok()?;
    let v = text.trim();
    if status.success() && !v.is_empty() {
        Some(v.to_string())
    } else {
        None
    }
}

/// Resolve with an injectable runner. Plain values are trimmed and returned.
pub fn resolve_with(raw: &str, run: impl Fn(&str) -> Option<String>) -> Result<String, String> {
    let v = raw.trim();
    if !v.starts_with(PREFIX) {
        return Ok(v.to_string());
    }
    if !is_phm_ref(v) {
        return Err("The phm: reference is malformed. Use phm:NAME.".to_string());
    }
    run(&v[PREFIX.len()..]).ok_or_else(|| {
        "Could not resolve the phm: reference. Is the phantom CLI installed and the secret present?"
            .to_string()
    })
}

/// Resolve a key field value using the real phantom CLI. Blocking.
pub fn resolve(raw: &str) -> Result<String, String> {
    resolve_with(raw, reveal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_refs() {
        assert!(is_phm_ref("phm:ANTHROPIC_API_KEY"));
        assert!(is_phm_ref(" phm:a.b-c "));
        for v in ["", "phm:", "phm:a b", "phm:a;b", "sk-ant-x", "PHM:X"] {
            assert!(!is_phm_ref(v), "{v}");
        }
    }

    #[test]
    fn plain_keys_pass_through_without_running_phantom() {
        let r = resolve_with("  sk-test  ", |_| panic!("must not run"));
        assert_eq!(r.unwrap(), "sk-test");
        assert_eq!(resolve_with("", |_| panic!("must not run")).unwrap(), "");
    }

    #[test]
    fn ref_resolves_through_runner() {
        let r = resolve_with("phm:MY_KEY", |n| {
            assert_eq!(n, "MY_KEY");
            Some("value".into())
        });
        assert_eq!(r.unwrap(), "value");
    }

    #[test]
    fn failure_is_an_error_and_never_the_literal_ref() {
        let e = resolve_with("phm:MY_KEY", |_| None).unwrap_err();
        assert!(e.contains("phantom CLI"));
        assert!(!e.contains("MY_KEY"));
    }

    #[test]
    fn malformed_ref_never_reaches_runner() {
        assert!(resolve_with("phm:a b", |_| panic!("must not run")).is_err());
    }

    #[test]
    fn real_runner_without_phantom_is_none() {
        // A name that cannot exist; if phantom is absent or the secret is
        // missing, both give None.
        assert_eq!(reveal("ASHLR_MD_TEST_NO_SUCH_SECRET_XYZ"), None);
    }
}
