//! Agent activity watcher — watches a project directory recursively and streams
//! newly-created / modified Markdown files to the frontend as `activity://file`
//! events. Designed for surfaces like PLAN.md / research.md written by AI
//! coding agents (Claude Code, Cursor, etc.).
//!
//! # Debouncing
//! Editors and agents emit many rapid Modify events (buffer flushes, atomic
//! rename create+remove pairs). We keep a small in-memory map of
//! `path → last_emitted_instant` and suppress duplicate events within 400 ms.
//!
//! # Skip rules
//! Hidden files/dirs (dotfiles), `node_modules`, `.git`, and any file whose
//! name ends with `.mdopener.tmp` are silently ignored.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Markdown extension allow-list
// ---------------------------------------------------------------------------

const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Skip rules
// ---------------------------------------------------------------------------

/// Returns true if this path component should cause the walk/event to be
/// skipped entirely (hidden dir/file, node_modules, .git, temp files).
fn should_skip_path(path: &Path) -> bool {
    for component in path.components() {
        if let std::path::Component::Normal(name) = component {
            let s = name.to_string_lossy();
            // Hidden files / dirs (dotfiles)
            if s.starts_with('.') {
                return true;
            }
            // Known noisy directories
            if s == "node_modules" {
                return true;
            }
        }
    }
    // Atomic-write temp files produced by write_markdown_file in document.rs
    if let Some(name) = path.file_name() {
        let s = name.to_string_lossy();
        if s.ends_with(".mdopener.tmp") {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

/// Payload emitted on the `activity://file` event.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActivityFilePayload {
    /// `"created"` or `"modified"`
    pub kind: &'static str,
    /// Absolute path to the file.
    pub path: String,
    /// File name only (e.g. `PLAN.md`).
    pub name: String,
    /// Absolute path of the containing directory.
    pub dir: String,
    /// Last-modified time in milliseconds since Unix epoch.
    pub mtime_ms: u64,
    /// File size in bytes.
    pub size: u64,
}

/// Returned by `list_markdown_files`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdFileInfo {
    pub path: String,
    pub name: String,
    pub dir: String,
    pub mtime_ms: u64,
    pub size: u64,
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct ActivityWatcher {
    /// Currently watched root directory.
    pub dir: Mutex<Option<String>>,
    /// The active notify watcher (dropped = watch stops).
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    /// Debounce map: absolute path → last instant we emitted an event for it.
    pub last_seen: Mutex<HashMap<String, Instant>>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEBOUNCE: Duration = Duration::from_millis(400);

/// Read mtime (ms since epoch) and size from a path. Returns (0, 0) on error
/// so callers can fall back gracefully.
fn stat_file(path: &Path) -> (u64, u64) {
    match std::fs::metadata(path) {
        Ok(m) => {
            let mtime_ms = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let size = m.len();
            (mtime_ms, size)
        }
        Err(_) => (0, 0),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Start watching `path` recursively for Markdown file creates and modifies.
/// Replaces any previously active directory watch.
///
/// Emits **`activity://file`** for each qualifying event with payload
/// `{ kind, path, name, dir, mtimeMs, size }`.
#[tauri::command]
pub fn watch_directory(
    app: AppHandle,
    path: String,
    state: tauri::State<ActivityWatcher>,
) -> Result<(), String> {
    let watch_root = PathBuf::from(&path);
    if !watch_root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    // Clone app + state refs for the callback closure.
    let app_cb = app.clone();
    // We borrow last_seen via the state in the closure by passing in an Arc.
    // Because the state lifetime is tied to the Tauri app (which outlives any
    // individual command), we can safely clone the Arc-like State handle.
    // However, tauri::State is not Send. We work around this by moving the
    // debounce map into an Arc<Mutex<_>> that both the closure and the command
    // can reach.
    let debounce_map: std::sync::Arc<Mutex<HashMap<String, Instant>>> =
        std::sync::Arc::new(Mutex::new(HashMap::new()));
    let debounce_map_cb = debounce_map.clone();

    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };

        let kind_str: &'static str = match event.kind {
            EventKind::Create(_) => "created",
            EventKind::Modify(_) => "modified",
            _ => return,
        };

        for path_buf in &event.paths {
            // Apply skip rules.
            if should_skip_path(path_buf) {
                continue;
            }
            if !is_markdown(path_buf) {
                continue;
            }
            // Skip if file no longer exists (transient create+remove).
            if !path_buf.exists() {
                continue;
            }

            let path_str = path_buf.to_string_lossy().into_owned();

            // Debounce: suppress if we emitted this path within DEBOUNCE window.
            {
                let mut map = debounce_map_cb.lock().unwrap();
                let now = Instant::now();
                if let Some(&last) = map.get(&path_str) {
                    if now.duration_since(last) < DEBOUNCE {
                        continue;
                    }
                }
                map.insert(path_str.clone(), now);
            }

            let (mtime_ms, size) = stat_file(path_buf);

            let name = path_buf
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();

            let dir = path_buf
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();

            let payload = ActivityFilePayload {
                kind: kind_str,
                path: path_str,
                name,
                dir,
                mtime_ms,
                size,
            };

            let _ = app_cb.emit("activity://file", payload);
        }
    })
    .map_err(|e| e.to_string())?;

    // Activate the watch before storing (must be mut).
    let mut watcher = watcher;
    watcher
        .watch(&watch_root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // Store — dropping the old watcher (if any) stops the previous watch.
    *state.dir.lock().unwrap() = Some(path);
    *state.watcher.lock().unwrap() = Some(watcher);
    // Replace the debounce map with the new one (old Arc will be dropped when
    // the old watcher callback exits naturally).
    *state.last_seen.lock().unwrap() = HashMap::new();

    Ok(())
}

/// Stop watching the current directory and clear all state.
#[tauri::command]
pub fn unwatch_directory(state: tauri::State<ActivityWatcher>) {
    *state.watcher.lock().unwrap() = None;
    *state.dir.lock().unwrap() = None;
    state.last_seen.lock().unwrap().clear();
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

const MAX_DEPTH: usize = 8;
/// Most directory entries one scan reads (each costs a `stat`), so a huge tree
/// stays fast. Past it the walk stops and the scan says it was cut short.
const MAX_SCAN_ENTRIES: usize = 50_000;

/// Returned by `scan_markdown_files`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdFileScan {
    /// The newest files found, newest first, at most the `limit` asked for.
    pub files: Vec<MdFileInfo>,
    /// The walk stopped at [`MAX_SCAN_ENTRIES`] before it read the whole
    /// tree, so `files` are the newest of the files it reached, not
    /// necessarily the folder's newest.
    pub scan_cut: bool,
}

/// Recursively scan `path` for Markdown files (same extensions + skip rules),
/// returning up to `limit` (default 100) sorted by mtime descending (newest
/// first).
#[tauri::command]
pub fn list_markdown_files(path: String, limit: Option<usize>) -> Result<Vec<MdFileInfo>, String> {
    scan_markdown_files(path, limit).map(|scan| scan.files)
}

/// [`list_markdown_files`] that also says whether the walk was cut short.
#[tauri::command]
pub fn scan_markdown_files(path: String, limit: Option<usize>) -> Result<MdFileScan, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    Ok(scan_newest(&root, limit.unwrap_or(100), MAX_SCAN_ENTRIES))
}

/// A listed file ordered by recency: newer is greater, and of two files with
/// the same mtime the one whose path sorts first is greater, so the order is
/// total and the kept set does not depend on the walk order.
struct ByRecency(MdFileInfo);

impl ByRecency {
    fn key(&self) -> (u64, std::cmp::Reverse<&str>) {
        (self.0.mtime_ms, std::cmp::Reverse(self.0.path.as_str()))
    }
}

impl PartialEq for ByRecency {
    fn eq(&self, other: &Self) -> bool {
        self.key() == other.key()
    }
}
impl Eq for ByRecency {}
impl PartialOrd for ByRecency {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for ByRecency {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.key().cmp(&other.key())
    }
}

/// Walk `root` keeping only the `limit` newest Markdown files seen so far (a
/// min-heap of at most `limit`), so every file reached competes, not just the
/// first few thousand. Reads at most `max_entries` directory entries.
fn scan_newest(root: &Path, limit: usize, max_entries: usize) -> MdFileScan {
    let mut walk = Walk {
        newest: std::collections::BinaryHeap::with_capacity(limit.saturating_add(1)),
        limit,
        entries_left: max_entries,
        cut: false,
    };
    walk.dir(root, 0);
    // Ascending in `Reverse` order is newest first.
    let files = walk
        .newest
        .into_sorted_vec()
        .into_iter()
        .map(|std::cmp::Reverse(f)| f.0)
        .collect();
    MdFileScan {
        files,
        scan_cut: walk.cut,
    }
}

struct Walk {
    newest: std::collections::BinaryHeap<std::cmp::Reverse<ByRecency>>,
    limit: usize,
    entries_left: usize,
    cut: bool,
}

impl Walk {
    fn keep(&mut self, file: MdFileInfo) {
        if self.limit == 0 {
            return;
        }
        let file = std::cmp::Reverse(ByRecency(file));
        if self.newest.len() < self.limit {
            self.newest.push(file);
        } else if self.newest.peek().is_some_and(|oldest| file < *oldest) {
            // Newer than the oldest kept (Reverse flips the order).
            self.newest.pop();
            self.newest.push(file);
        }
    }

    /// Recursive walking helper. Stops at MAX_DEPTH, and at the entry budget
    /// (setting `cut`) to stay fast on large repos.
    fn dir(&mut self, dir: &Path, depth: usize) {
        if depth > MAX_DEPTH || self.cut {
            return;
        }

        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            if self.entries_left == 0 {
                self.cut = true;
                return;
            }
            self.entries_left -= 1;

            let path = entry.path();

            // Apply skip rules based on this path segment.
            if let Some(name) = path.file_name() {
                let s = name.to_string_lossy();
                if s.starts_with('.') || s == "node_modules" {
                    continue;
                }
                if s.ends_with(".mdopener.tmp") {
                    continue;
                }
            }

            let Ok(meta) = entry.metadata() else { continue };

            if meta.is_dir() {
                self.dir(&path, depth + 1);
                if self.cut {
                    return;
                }
            } else if meta.is_file() && is_markdown(&path) {
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);

                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();

                let dir_str = path
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();

                self.keep(MdFileInfo {
                    path: path.to_string_lossy().into_owned(),
                    name,
                    dir: dir_str,
                    mtime_ms,
                    size: meta.len(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{list_markdown_files, scan_newest};
    use std::path::{Path, PathBuf};
    use std::time::{Duration, UNIX_EPOCH};

    /// A fresh directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "mdopener-activity-{tag}-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_md(dir: &Path, name: &str, mtime_secs: u64) {
        let p = dir.join(name);
        std::fs::write(&p, "# x\n").unwrap();
        let f = std::fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(UNIX_EPOCH + Duration::from_secs(mtime_secs))
            .unwrap();
    }

    /// The walk used to stop collecting at 2000 files and only then sort by
    /// date, so in a bigger folder the "200 newest" were the newest of
    /// whichever 2000 the directory listing happened to return first.
    #[test]
    fn a_folder_of_more_than_2000_files_lists_its_true_newest() {
        let tmp = TempDir::new("big");
        // Created newest first, so a walk in creation order or its reverse,
        // or in hash order, would all reach some of the newest ones late.
        for i in (0..2300u64).rev() {
            write_md(&tmp.0, &format!("n{i:05}.md"), 1_000_000 + i);
        }
        let files = list_markdown_files(tmp.0.to_string_lossy().into_owned(), Some(200)).unwrap();
        assert_eq!(files.len(), 200);
        let want: Vec<String> = (2100..2300u64)
            .rev()
            .map(|i| format!("n{i:05}.md"))
            .collect();
        let got: Vec<String> = files.into_iter().map(|f| f.name).collect();
        assert_eq!(got, want);
    }

    /// Past the entry budget the walk stops and says so, instead of passing
    /// off the newest of the files it reached as the folder's newest.
    #[test]
    fn a_walk_cut_by_the_entry_budget_says_so() {
        let tmp = TempDir::new("cut");
        let sub = tmp.0.join("notes");
        std::fs::create_dir(&sub).unwrap();
        for i in 0..10u64 {
            write_md(&sub, &format!("f{i}.md"), 1_000 + i);
        }
        let whole = scan_newest(&tmp.0, 5, 100);
        assert!(!whole.scan_cut);
        let names: Vec<&str> = whole.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["f9.md", "f8.md", "f7.md", "f6.md", "f5.md"]);
        let cut = scan_newest(&tmp.0, 5, 4);
        assert!(cut.scan_cut);
        assert!(cut.files.len() <= 3, "only 3 of the 4 entries are files");
        // Exactly the budget is not a cut: every entry was read.
        assert!(!scan_newest(&tmp.0, 5, 11).scan_cut);
    }

    #[test]
    fn a_zero_limit_lists_nothing() {
        let tmp = TempDir::new("zero");
        write_md(&tmp.0, "a.md", 5);
        assert!(scan_newest(&tmp.0, 0, 100).files.is_empty());
    }
}
