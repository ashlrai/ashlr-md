//! Document file I/O: reading and (atomically) writing Markdown files.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct MarkdownFile {
    pub path: String,
    pub file_name: String,
    pub content: String,
    /// Size in bytes — the frontend uses this to decide whether to default
    /// a very large document into the lighter source-only view.
    pub size: u64,
}

/// Read a Markdown file from disk and return its content plus light metadata.
#[tauri::command]
pub fn read_markdown_file(path: String) -> Result<MarkdownFile, String> {
    let p = Path::new(&path);
    let content = std::fs::read_to_string(p).map_err(|e| format!("Could not read {path}: {e}"))?;
    let size = content.len() as u64;
    let file_name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled.md".to_string());
    Ok(MarkdownFile {
        path,
        file_name,
        content,
        size,
    })
}

/// Write a Markdown file atomically: write to a sibling temp file, then rename.
/// Renaming on the same filesystem is atomic, so a crash mid-write never leaves
/// a half-written document on disk.
#[tauri::command]
pub fn write_markdown_file(path: String, content: String) -> Result<(), String> {
    let tmp = format!("{path}.mdopener.tmp");
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("Could not write {path}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        // Best-effort cleanup of the temp file if the rename failed.
        let _ = std::fs::remove_file(&tmp);
        format!("Could not save {path}: {e}")
    })?;
    Ok(())
}

/// Return the subset of `paths` that still exist as files on disk.
/// Used by session restore to skip documents that were moved/deleted.
#[tauri::command]
pub fn filter_existing(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| Path::new(p).is_file())
        .collect()
}

// ---------------------------------------------------------------------------
// Wikilink resolution ([[target]] / ![[target]])
// ---------------------------------------------------------------------------

const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];
/// Cap the vault scan depth so basename resolution stays fast on big trees.
const WIKILINK_MAX_DEPTH: usize = 6;

/// Resolve an Obsidian-style wikilink `target` to an absolute file path,
/// relative to `base_dir` (the directory of the document containing the link).
///
/// Resolution order (mirrors Obsidian): exact relative path → relative path
/// with an appended Markdown extension → basename match anywhere under the
/// vault root. Returns `None` for a broken link.
#[tauri::command]
pub fn resolve_wikilink(base_dir: String, target: String) -> Option<String> {
    // Drop any "#heading" / "#^block" fragment — we resolve the file only.
    let target = target.split('#').next().unwrap_or(&target).trim();
    if target.is_empty() {
        return None;
    }
    let base = Path::new(&base_dir);

    // 1. Exact relative path (possibly with subdirs / an explicit extension).
    let direct = base.join(target);
    if direct.is_file() {
        return canonical_string(&direct);
    }
    // 2. Relative path with a Markdown extension appended.
    if Path::new(target).extension().is_none() {
        for ext in MD_EXTENSIONS {
            let cand = base.join(format!("{target}.{ext}"));
            if cand.is_file() {
                return canonical_string(&cand);
            }
        }
    }
    // 3. Basename match across the vault (depth-capped).
    let wanted_stem = Path::new(target)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(target)
        .to_ascii_lowercase();
    find_by_stem(base, &wanted_stem, 0)
}

fn canonical_string(p: &Path) -> Option<String> {
    p.canonicalize()
        .ok()
        .map(|c| c.to_string_lossy().into_owned())
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Depth-first search for a Markdown file whose stem equals `wanted_stem`
/// (case-insensitive). Skips hidden dirs and common heavy build folders.
fn find_by_stem(dir: &Path, wanted_stem: &str, depth: usize) -> Option<String> {
    if depth > WIKILINK_MAX_DEPTH {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    continue;
                }
            }
            subdirs.push(path);
            continue;
        }
        if !is_markdown(&path) {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        if stem.as_deref() == Some(wanted_stem) {
            return canonical_string(&path);
        }
    }
    for sub in subdirs {
        if let Some(found) = find_by_stem(&sub, wanted_stem, depth + 1) {
            return Some(found);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_tree() -> std::path::PathBuf {
        // Unique dir per call so the (parallel) tests don't race on a shared path.
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut root = std::env::temp_dir();
        root.push(format!(
            "mdopener-wikilink-test-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let mut a = std::fs::File::create(root.join("Alpha.md")).unwrap();
        a.write_all(b"# Alpha").unwrap();
        let mut b = std::fs::File::create(root.join("notes").join("Beta.md")).unwrap();
        b.write_all(b"# Beta").unwrap();
        root
    }

    #[test]
    fn resolves_relative_without_extension() {
        let root = make_tree();
        let got = resolve_wikilink(root.to_string_lossy().into_owned(), "Alpha".into());
        assert!(got.is_some());
        assert!(got.unwrap().ends_with("Alpha.md"));
    }

    #[test]
    fn resolves_by_basename_in_subdir() {
        let root = make_tree();
        let got = resolve_wikilink(root.to_string_lossy().into_owned(), "Beta".into());
        assert!(got.unwrap().ends_with("Beta.md"));
    }

    #[test]
    fn strips_heading_fragment() {
        let root = make_tree();
        let got = resolve_wikilink(root.to_string_lossy().into_owned(), "Alpha#Intro".into());
        assert!(got.is_some());
    }

    #[test]
    fn returns_none_for_missing_target() {
        let root = make_tree();
        assert!(resolve_wikilink(root.to_string_lossy().into_owned(), "Nope".into()).is_none());
    }
}
