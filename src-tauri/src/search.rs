//! Cross-file full-text search.
//!
//! Greps a caller-supplied list of files (recent documents + the watched
//! folder) for a query string, in Rust, so the webview never has to read every
//! file into memory. Case-insensitive substring match; returns per-file line
//! matches with a trimmed snippet around each hit.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// 1-based line number of the match.
    pub line_no: usize,
    /// Trimmed snippet of the matching line, elided with … when long.
    pub snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub path: String,
    pub file_name: String,
    pub matches: Vec<SearchMatch>,
}

/// Per-file match cap so one huge file can't dominate the result list.
const MAX_MATCHES_PER_FILE: usize = 8;
/// Characters of context to keep on each side of a match in the snippet.
const SNIPPET_RADIUS: usize = 48;

/// Search `paths` for `query` (case-insensitive). Missing/unreadable files are
/// skipped. `limit` caps the number of files returned (default 200).
#[tauri::command]
pub fn search_files(
    paths: Vec<String>,
    query: String,
    limit: Option<usize>,
) -> Vec<FileSearchResult> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let cap = limit.unwrap_or(200);
    let mut results = Vec::new();

    for path in paths {
        if results.len() >= cap {
            break;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue; // moved/deleted/binary — skip silently
        };

        let mut matches = Vec::new();
        for (i, line) in content.lines().enumerate() {
            if matches.len() >= MAX_MATCHES_PER_FILE {
                break;
            }
            if line.to_lowercase().contains(&needle) {
                matches.push(SearchMatch {
                    line_no: i + 1,
                    snippet: make_snippet(line, &needle),
                });
            }
        }

        if !matches.is_empty() {
            let file_name = Path::new(&path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(path.as_str())
                .to_string();
            results.push(FileSearchResult {
                path,
                file_name,
                matches,
            });
        }
    }

    results
}

/// Build a snippet of `line` centered on the first case-insensitive occurrence
/// of `needle_lower`, with ellipses when content is trimmed off either end.
fn make_snippet(line: &str, needle_lower: &str) -> String {
    let trimmed = line.trim_start();
    let lower = trimmed.to_lowercase();
    let byte_pos = lower.find(needle_lower).unwrap_or(0);
    let char_pos = lower[..byte_pos].chars().count();

    let chars: Vec<char> = trimmed.chars().collect();
    let start = char_pos.saturating_sub(SNIPPET_RADIUS);
    let end = (char_pos + needle_lower.chars().count() + SNIPPET_RADIUS).min(chars.len());

    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.extend(&chars[start..end]);
    if end < chars.len() {
        snippet.push('…');
    }
    snippet
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_md(name: &str, body: &str) -> String {
        let mut p = std::env::temp_dir();
        p.push(format!("mdopener-search-test-{name}.md"));
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn empty_query_returns_nothing() {
        let path = temp_md("empty", "hello world");
        assert!(search_files(vec![path], "  ".into(), None).is_empty());
    }

    #[test]
    fn finds_case_insensitive_matches_with_line_numbers() {
        let path = temp_md("hit", "alpha\nBeta Gamma\ndelta");
        let res = search_files(vec![path], "beta".into(), None);
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].matches.len(), 1);
        assert_eq!(res[0].matches[0].line_no, 2);
        assert!(res[0].matches[0].snippet.contains("Beta"));
    }

    #[test]
    fn skips_missing_files() {
        let res = search_files(vec!["/no/such/file.md".into()], "x".into(), None);
        assert!(res.is_empty());
    }

    #[test]
    fn snippet_elides_long_lines() {
        let long = format!("{}NEEDLE{}", "a".repeat(100), "b".repeat(100));
        let path = temp_md("long", &long);
        let res = search_files(vec![path], "needle".into(), None);
        assert!(res[0].matches[0].snippet.starts_with('…'));
        assert!(res[0].matches[0].snippet.ends_with('…'));
    }
}
