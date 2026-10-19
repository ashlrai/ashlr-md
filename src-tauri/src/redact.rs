//! Strip secrets from text that came back from a model endpoint before it
//! reaches an error string, a log line or the UI.

/// The `Authorization: Basic` value reqwest sends for `user:pass` in a URL.
pub fn basic_credential(user: &str, pass: &str) -> String {
    base64(format!("{user}:{pass}").as_bytes())
}

fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for c in input.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Shortest run of a secret that counts as a leak.
const WINDOW: usize = 8;
/// Longest endpoint body quoted in an error.
const MAX_BODY_CHARS: usize = 300;

/// Replace every run of `WINDOW` or more characters of `text` that also
/// occurs inside one of `secrets` with "[redacted]".
pub fn redact(text: &str, secrets: &[String]) -> String {
    let windows: std::collections::HashSet<Vec<char>> = secrets
        .iter()
        .map(|s| s.chars().collect::<Vec<_>>())
        .filter(|c| c.len() >= WINDOW)
        .flat_map(|c| c.windows(WINDOW).map(<[char]>::to_vec).collect::<Vec<_>>())
        .collect();
    let chars: Vec<char> = text.chars().collect();
    if windows.is_empty() || chars.len() < WINDOW {
        return text.to_string();
    }
    let mut covered = vec![false; chars.len()];
    for i in 0..=chars.len() - WINDOW {
        if windows.contains(&chars[i..i + WINDOW]) {
            covered[i..i + WINDOW].iter_mut().for_each(|c| *c = true);
        }
    }
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if covered[i] {
            while i < chars.len() && covered[i] {
                i += 1;
            }
            out.push_str("[redacted]");
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// An endpoint's error body, redacted and cut to `MAX_BODY_CHARS`.
pub fn error_body(text: &str, secrets: &[String]) -> String {
    let head: String = text.chars().take(MAX_BODY_CHARS * 8).collect();
    redact(&head, secrets)
        .chars()
        .take(MAX_BODY_CHARS)
        .collect()
}

/// Secrets a base URL can carry: the user name and password, the Basic value
/// reqwest builds from them, and each path segment and query value (a proxy
/// token often rides in the path).
pub fn url_secrets(base: &str) -> Vec<String> {
    let Ok(url) = reqwest::Url::parse(base) else {
        return vec![base.to_string()];
    };
    let mut out = Vec::new();
    let user = urlencoding::decode(url.username())
        .map(|c| c.into_owned())
        .unwrap_or_default();
    let pass = url.password().map(|p| {
        urlencoding::decode(p)
            .map(|c| c.into_owned())
            .unwrap_or_default()
    });
    if let Some(pass) = &pass {
        out.push(basic_credential(&user, pass));
        out.push(pass.clone());
    }
    if !user.is_empty() {
        out.push(user);
    }
    out.extend(
        url.path_segments()
            .into_iter()
            .flatten()
            .map(str::to_string),
    );
    out.extend(url.query_pairs().map(|(_, v)| v.into_owned()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_and_partial_echoes_are_redacted() {
        let s = vec!["abcdEFGH1234ijklMNOP".to_string()];
        assert_eq!(
            redact("bad key abcdEFGH1234ijklMNOP!", &s),
            "bad key [redacted]!"
        );
        assert_eq!(redact("got ...1234ijklMN", &s), "got ...[redacted]");
        assert_eq!(redact("abcdEFG and MNOP", &s), "abcdEFG and MNOP");
    }

    #[test]
    fn short_secrets_are_ignored_and_bodies_are_bounded() {
        assert_eq!(redact("a b c", &["a".to_string()]), "a b c");
        assert_eq!(
            error_body(&"x".repeat(5_000), &[]).chars().count(),
            MAX_BODY_CHARS
        );
    }

    #[test]
    fn url_secrets_cover_credentials_path_and_query() {
        let s = url_secrets(
            "http://user:p%40ssword123@127.0.0.1:1/x/_phantom/tok123456789?k=val987654321",
        );
        assert!(s.contains(&"p@ssword123".to_string()));
        assert!(s.contains(&basic_credential("user", "p@ssword123")));
        assert!(s.contains(&"tok123456789".to_string()));
        assert!(s.contains(&"val987654321".to_string()));
    }

    #[test]
    fn basic_credential_matches_rfc_4648() {
        assert_eq!(
            basic_credential("Aladdin", "open sesame"),
            "QWxhZGRpbjpvcGVuIHNlc2FtZQ=="
        );
    }
}
