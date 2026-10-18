//! Cross-file full-text search.
//!
//! Greps a caller-supplied list of files (recent documents + the watched
//! folder) for a query string, in Rust, so the webview never has to read every
//! file into memory. Case-insensitive substring match; returns per-file line
//! matches with a trimmed snippet around each hit.

use crate::doc_read::{read_document_following, CheckedDocument, MAX_DOCUMENT_BYTES};
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

/// A listed file the search could not read, with the reason ("it is not
/// UTF-8 text (byte 5 is not valid UTF-8, on line 2). ..."), so `/search`
/// can tell an agent it was not searched instead of dropping it in silence.
#[derive(Serialize, Debug, PartialEq)]
pub struct UnreadFile {
    pub path: String,
    pub reason: String,
}

/// Per-file match cap so one huge file can't dominate the result list.
const MAX_MATCHES_PER_FILE: usize = 8;
/// Characters of context to keep on each side of a match in the snippet.
const SNIPPET_RADIUS: usize = 48;

/// Search `paths` for `query` (case-insensitive). Missing/unreadable files are
/// skipped, and so are files that are not regular files or are larger than
/// 16 MiB ([`MAX_DOCUMENT_BYTES`]): a FIFO in the list blocked the search
/// forever, and a huge file was read whole into memory. `limit` caps the
/// number of files returned (default 200).
#[tauri::command]
pub fn search_files(
    paths: Vec<String>,
    query: String,
    limit: Option<usize>,
) -> Vec<FileSearchResult> {
    search_with(
        paths,
        query,
        limit,
        |p| p.as_str(),
        |p| read_document_following(Path::new(p), MAX_DOCUMENT_BYTES),
    )
    .0
}

/// [`search_files`] for an agent (`/search`): each document is read only if
/// it is still the file its path check saw, so a link swapped in after the
/// check is not followed (see [`crate::doc_read`]). Also returns the
/// documents it could not read (not UTF-8, over 16 MiB, refused), each with
/// the reason: they used to be dropped in silence, so a word in one came back
/// as no hits.
pub(crate) fn search_checked(
    docs: Vec<CheckedDocument>,
    query: String,
    limit: Option<usize>,
) -> (Vec<FileSearchResult>, Vec<UnreadFile>) {
    search_with(
        docs,
        query,
        limit,
        |d| d.path.as_str(),
        |d| d.read_capped(MAX_DOCUMENT_BYTES),
    )
}

/// The search itself: `read` gives an item's text, or why it could not be
/// read. An item that no longer exists (moved or deleted since it was
/// listed) is skipped in silence; any other unread item is returned with its
/// reason.
fn search_with<T>(
    items: Vec<T>,
    query: String,
    limit: Option<usize>,
    path_of: impl Fn(&T) -> &str,
    read: impl Fn(&T) -> Result<String, String>,
) -> (Vec<FileSearchResult>, Vec<UnreadFile>) {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let cap = limit.unwrap_or(200);
    let mut results = Vec::new();
    let mut unread = Vec::new();

    for item in items {
        if results.len() >= cap {
            break;
        }
        let content = match read(&item) {
            Ok(content) => content,
            Err(reason) => {
                let path = path_of(&item);
                if std::fs::symlink_metadata(path).is_ok() {
                    unread.push(UnreadFile {
                        path: path.to_string(),
                        reason,
                    });
                }
                continue;
            }
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
            let path = path_of(&item).to_string();
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

    (results, unread)
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

    /// The search panel read every listed file whole: a FIFO in the list
    /// blocked the search forever, and a huge file went into memory. Both
    /// are now skipped.
    #[test]
    fn skips_a_fifo_and_a_file_over_16_mib() {
        let dir = std::env::temp_dir().join(format!("mdopener-search-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big.md");
        let mut f = std::fs::File::create(&big).unwrap();
        f.write_all(b"needle\n").unwrap();
        f.set_len(MAX_DOCUMENT_BYTES + 1).unwrap();
        let small = dir.join("small.md");
        std::fs::write(&small, "needle").unwrap();
        let mut paths = vec![big.to_string_lossy().into_owned()];
        #[cfg(unix)]
        {
            let fifo = dir.join("pipe.md");
            let ok = std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success();
            assert!(ok, "mkfifo failed");
            paths.push(fifo.to_string_lossy().into_owned());
        }
        paths.push(small.to_string_lossy().into_owned());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(search_files(paths, "needle".into(), None));
        });
        let res = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the search blocked on a FIFO");
        let found: Vec<_> = res.iter().map(|r| r.file_name.as_str()).collect();
        assert_eq!(found, vec!["small.md"]);
        let _ = std::fs::remove_dir_all(&dir);
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
