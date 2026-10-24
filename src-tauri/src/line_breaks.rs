//! Lines as CommonMark and the editor (CodeMirror) read them: `\r\n`, a
//! lone `\r` and `\n` each end a line. `str::lines` splits only at `\n`, so
//! an old Mac file (lone `\r` breaks) was one line to search and diff while
//! the editor showed many.
//!
//! Shared with the mdopener-mcp sidecar through `#[path]`, so it must only
//! use `std`.

/// The lines of `s`, each with the line break that ends it (none on a last
/// line without one), like `str::split_inclusive('\n')` with `\r` and
/// `\r\n` breaks too. Empty for an empty `s`.
pub fn split_lines_inclusive(s: &str) -> impl Iterator<Item = &str> {
    let mut rest = s;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let bytes = rest.as_bytes();
        let end = match bytes.iter().position(|&b| b == b'\n' || b == b'\r') {
            Some(i) if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') => i + 2,
            Some(i) => i + 1,
            None => rest.len(),
        };
        let (line, tail) = rest.split_at(end);
        rest = tail;
        Some(line)
    })
}

/// The lines of `s` without their line breaks, like `str::lines` (a final
/// break does not start an empty line) with `\r` breaks too.
pub fn lines(s: &str) -> impl Iterator<Item = &str> {
    split_lines_inclusive(s).map(|line| {
        let line = line.strip_suffix('\n').unwrap_or(line);
        line.strip_suffix('\r').unwrap_or(line)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_of_cr_lf_and_crlf_is_one_break() {
        let s = "a\rb\r\nc\nd\r\r\ne";
        let inclusive: Vec<_> = split_lines_inclusive(s).collect();
        assert_eq!(inclusive, ["a\r", "b\r\n", "c\n", "d\r", "\r\n", "e"]);
        let plain: Vec<_> = lines(s).collect();
        assert_eq!(plain, ["a", "b", "c", "d", "", "e"]);
    }

    #[test]
    fn matches_str_lines_without_lone_cr() {
        for s in [
            "",
            "\n",
            "a",
            "a\n",
            "a\n\n",
            "a\r\nb\r\n",
            "\r\n\r\n",
            "é\nü",
        ] {
            assert_eq!(
                lines(s).collect::<Vec<_>>(),
                s.lines().collect::<Vec<_>>(),
                "{s:?}"
            );
            assert_eq!(
                split_lines_inclusive(s).collect::<Vec<_>>(),
                s.split_inclusive('\n').collect::<Vec<_>>(),
                "{s:?}"
            );
        }
    }
}
