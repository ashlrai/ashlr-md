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
    // Never write inside an Obsidian config folder — that dir is Obsidian's and
    // a stray write there can corrupt vault settings/plugins.
    if path_targets_obsidian_dir(&path) {
        return Err("Refusing to write inside an Obsidian .obsidian/ config folder.".into());
    }
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
// Vault detection + wikilink resolution ([[target]] / ![[target]])
// ---------------------------------------------------------------------------

const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];
/// Cap the vault scan depth so resolution stays fast on big trees.
const WIKILINK_MAX_DEPTH: usize = 12;
/// Stop collecting candidates once we have this many — a safety valve on huge vaults.
const MAX_CANDIDATES: usize = 4096;

/// True if any path component is `.obsidian` (the vault's config folder).
fn is_in_obsidian_dir(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == ".obsidian")
}

/// True if writing to `path` would land inside an Obsidian `.obsidian/` folder.
/// Checks the path lexically first (covers new files and the common case), then
/// the *canonicalized parent* so a symlinked config dir (e.g. `cfg → .obsidian`)
/// can't slip past a purely textual check.
fn path_targets_obsidian_dir(path: &str) -> bool {
    let p = Path::new(path);
    if is_in_obsidian_dir(p) {
        return true;
    }
    if let Some(parent) = p.parent() {
        if let Ok(canon) = parent.canonicalize() {
            return is_in_obsidian_dir(&canon);
        }
    }
    false
}

/// Walk up from `start` (a file or directory) looking for an Obsidian vault
/// marker (`.obsidian/`). Returns the vault root directory, or `None` if none
/// is found before the filesystem root.
#[tauri::command]
pub fn detect_vault_root(start: String) -> Option<String> {
    let p = Path::new(&start);
    // Start at the containing directory when `start` is a file.
    let mut dir: &Path = if p.is_dir() { p } else { p.parent()? };
    loop {
        if dir.join(".obsidian").is_dir() {
            return canonical_string(dir);
        }
        match dir.parent() {
            Some(parent) => dir = parent,
            None => return None,
        }
    }
}

/// Resolve an Obsidian-style wikilink `target` to an absolute file path.
///
/// `base_dir` is the directory of the document containing the link; `vault_root`
/// (when known) scopes the vault-wide name search and enables vault-relative
/// path links. Resolution order mirrors Obsidian:
///   1. exact relative path from the current file's directory,
///   2. vault-relative path (from the vault root),
///   3. relative path + an appended Markdown extension (current dir, then root),
///   4. vault-wide name match, preferring the file closest to the current doc.
///
/// A target carrying an explicit extension (e.g. an image embed
/// `![[diagram.png]]`) is matched by full file name; otherwise by stem against
/// Markdown files. Returns `None` for a broken link.
#[tauri::command]
pub fn resolve_wikilink(
    base_dir: String,
    target: String,
    vault_root: Option<String>,
) -> Option<String> {
    // Drop any "#heading" / "#^block" fragment — we resolve the file only.
    let target = target.split('#').next().unwrap_or(&target).trim();
    if target.is_empty() {
        return None;
    }
    let base = Path::new(&base_dir);
    let root = vault_root.as_deref().map(Path::new);

    // 1. Exact relative path from the current file's directory.
    let direct = base.join(target);
    if direct.is_file() {
        return canonical_string(&direct);
    }
    // 2. Vault-relative path (Obsidian allows `[[folder/note]]` from the root).
    if let Some(r) = root {
        let from_root = r.join(target);
        if from_root.is_file() {
            return canonical_string(&from_root);
        }
    }
    // 3. Relative path + a Markdown extension (current dir, then vault root).
    if Path::new(target).extension().is_none() {
        for ext in MD_EXTENSIONS {
            let cand = base.join(format!("{target}.{ext}"));
            if cand.is_file() {
                return canonical_string(&cand);
            }
            if let Some(r) = root {
                let cand = r.join(format!("{target}.{ext}"));
                if cand.is_file() {
                    return canonical_string(&cand);
                }
            }
        }
    }
    // 4. Vault-wide name match: collect every candidate, then pick the closest.
    let scan_root = root.unwrap_or(base);
    let has_ext = Path::new(target).extension().is_some();
    let wanted = if has_ext {
        Path::new(target).file_name()
    } else {
        Path::new(target).file_stem()
    }
    .and_then(|s| s.to_str())
    .unwrap_or(target)
    .to_ascii_lowercase();

    let mut matches = Vec::new();
    collect_matches(scan_root, &wanted, has_ext, 0, &mut matches);
    pick_closest(matches, base, target)
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

/// Recursively collect files matching `wanted` (full file name when `full_name`,
/// else Markdown-file stem), case-insensitively. Skips hidden dirs + build dirs.
fn collect_matches(
    dir: &Path,
    wanted: &str,
    full_name: bool,
    depth: usize,
    out: &mut Vec<std::path::PathBuf>,
) {
    if depth > WIKILINK_MAX_DEPTH || out.len() >= MAX_CANDIDATES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
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
        let hit = if full_name {
            path.file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .as_deref()
                == Some(wanted)
        } else {
            is_markdown(&path)
                && path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_ascii_lowercase())
                    .as_deref()
                    == Some(wanted)
        };
        if hit {
            out.push(path);
        }
    }
    for sub in subdirs {
        if out.len() >= MAX_CANDIDATES {
            break;
        }
        collect_matches(&sub, wanted, full_name, depth + 1, out);
    }
}

/// Pick the best match: prefer a path that ends with the full `target` (so a
/// vault-relative `[[folder/note]]` beats a bare name collision), then the file
/// sharing the longest path prefix with `base` (proximity), then the shortest
/// path. Fully deterministic on ties.
fn pick_closest(mut matches: Vec<std::path::PathBuf>, base: &Path, target: &str) -> Option<String> {
    if matches.is_empty() {
        return None;
    }
    let target_norm = target.replace('\\', "/").to_ascii_lowercase();
    let base_comps = lower_components(base);
    matches.sort_by_cached_key(|p| {
        let s = p.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
        let suffix_rank = if s.ends_with(&target_norm) { 0 } else { 1 };
        // Proximity = shared leading *path components* with the current doc's
        // dir (component-wise, so multibyte path segments can't misalign).
        let comps = lower_components(p);
        let shared = base_comps
            .iter()
            .zip(comps.iter())
            .take_while(|(x, y)| x == y)
            .count();
        (suffix_rank, std::cmp::Reverse(shared), s.len(), s)
    });
    canonical_string(&matches[0])
}

/// Lowercased path components, for case-insensitive component comparison.
fn lower_components(p: &Path) -> Vec<String> {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect()
}

/// Read a local image and return it as a `data:` URL. Used by `![[image.png]]`
/// embeds so we never have to expose a broad `asset://` filesystem scope to the
/// webview — images flow through the same Rust trust boundary as every other read.
#[tauri::command]
pub fn read_image_data_url(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let mime = match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        _ => return Err("Unsupported image type for embed".into()),
    };
    // Cap so a hostile/huge file can't balloon webview memory.
    const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
    let meta = std::fs::metadata(p).map_err(|e| format!("Cannot stat {path}: {e}"))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("Image too large to embed (>25 MiB).".into());
    }
    let bytes = std::fs::read(p).map_err(|e| format!("Cannot read {path}: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// Minimal standard-alphabet base64 encoder (no external crate).
fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Open the given file in Obsidian via the `obsidian://open?path=…` URI scheme.
#[tauri::command]
pub fn open_in_obsidian(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let abs = std::fs::canonicalize(&path)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or(path);
    let encoded = urlencoding::encode(&abs);
    let url = format!("obsidian://open?path={encoded}");
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Could not open in Obsidian (is it installed?): {e}"))
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

    fn s(p: &std::path::Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn resolves_relative_without_extension() {
        let root = make_tree();
        let got = resolve_wikilink(s(&root), "Alpha".into(), None);
        assert!(got.is_some());
        assert!(got.unwrap().ends_with("Alpha.md"));
    }

    #[test]
    fn resolves_by_basename_in_subdir() {
        let root = make_tree();
        let got = resolve_wikilink(s(&root), "Beta".into(), None);
        assert!(got.unwrap().ends_with("Beta.md"));
    }

    #[test]
    fn strips_heading_fragment() {
        let root = make_tree();
        let got = resolve_wikilink(s(&root), "Alpha#Intro".into(), None);
        assert!(got.is_some());
    }

    #[test]
    fn returns_none_for_missing_target() {
        let root = make_tree();
        assert!(resolve_wikilink(s(&root), "Nope".into(), None).is_none());
    }

    #[test]
    fn detects_vault_root_walking_up() {
        let root = make_tree();
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        // From a nested file, detection should walk up to the vault root.
        let from = root.join("notes").join("Beta.md");
        let detected = detect_vault_root(s(&from)).unwrap();
        assert_eq!(
            std::fs::canonicalize(&detected).unwrap(),
            std::fs::canonicalize(&root).unwrap()
        );
        // No vault marker above the system temp dir → None for a bare path.
        assert!(detect_vault_root("/".into()).is_none());
    }

    #[test]
    fn vault_wide_resolution_prefers_closest_to_base() {
        let root = make_tree();
        // Two same-named notes in different folders; the link sits next to one.
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("a").join("Dup.md"), b"# A").unwrap();
        std::fs::write(root.join("b").join("Dup.md"), b"# B").unwrap();
        let base = root.join("a");
        let got = resolve_wikilink(s(&base), "Dup".into(), Some(s(&root))).unwrap();
        // Closest-to-base wins: the one in `a/`.
        assert!(got.replace('\\', "/").contains("/a/Dup.md"));
    }

    #[test]
    fn resolves_image_embed_by_full_name() {
        let root = make_tree();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets").join("diagram.png"), b"\x89PNG").unwrap();
        let got = resolve_wikilink(s(&root), "diagram.png".into(), Some(s(&root))).unwrap();
        assert!(got.ends_with("diagram.png"));
    }

    #[test]
    fn base64_matches_known_vectors() {
        // RFC 4648 test vectors.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn write_guard_rejects_obsidian_dir() {
        let root = make_tree();
        let cfg = root.join(".obsidian");
        std::fs::create_dir_all(&cfg).unwrap();
        let target = cfg.join("app.json");
        let err = write_markdown_file(s(&target), "{}".into()).unwrap_err();
        assert!(err.contains(".obsidian"), "got: {err}");
        assert!(!target.exists(), "must not have written the file");
    }

    #[cfg(unix)]
    #[test]
    fn write_guard_rejects_symlinked_obsidian_dir() {
        // `cfg` is a symlink to `.obsidian`; a lexical-only check would miss it.
        let root = make_tree();
        let cfg = root.join(".obsidian");
        std::fs::create_dir_all(&cfg).unwrap();
        let link = root.join("cfg");
        std::os::unix::fs::symlink(&cfg, &link).unwrap();
        let target = link.join("app.json");
        let err = write_markdown_file(s(&target), "{}".into()).unwrap_err();
        assert!(err.contains(".obsidian"), "got: {err}");
    }
}
