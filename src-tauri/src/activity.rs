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
const MAX_FILES: usize = 2000; // internal cap; result is trimmed to `limit`

/// Recursively scan `path` for Markdown files (same extensions + skip rules),
/// returning up to `limit` (default 100) sorted by mtime descending (newest
/// first).
#[tauri::command]
pub fn list_markdown_files(
    path: String,
    limit: Option<usize>,
) -> Result<Vec<MdFileInfo>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    let cap = limit.unwrap_or(100);
    let mut files: Vec<MdFileInfo> = Vec::new();

    collect_markdown_files(&root, 0, &mut files);

    // Sort newest first.
    files.sort_by_key(|f| std::cmp::Reverse(f.mtime_ms));
    files.truncate(cap);

    Ok(files)
}

/// Recursive walking helper.  Stops at MAX_DEPTH and MAX_FILES to stay fast
/// on large repos.
fn collect_markdown_files(dir: &Path, depth: usize, out: &mut Vec<MdFileInfo>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            break;
        }

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
            collect_markdown_files(&path, depth + 1, out);
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

            out.push(MdFileInfo {
                path: path.to_string_lossy().into_owned(),
                name,
                dir: dir_str,
                mtime_ms,
                size: meta.len(),
            });
        }
    }
}
