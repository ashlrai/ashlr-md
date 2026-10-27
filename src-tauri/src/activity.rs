//! Agent activity watcher — watches a project directory recursively and streams
//! newly-created / modified / removed Markdown files to the frontend as
//! `activity://file` events. Designed for surfaces like PLAN.md / research.md written by AI
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
    /// `"created"`, `"modified"` or `"removed"` (deleted, or renamed or moved
    /// away; `mtimeMs` and `size` are then 0). A rename inside the folder is
    /// a `"removed"` for the old path and a `"modified"` for the new one.
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

/// How long a removed path must stay gone before its removal is sent. An
/// editor that saves by renaming the old file away and writing a new one
/// (vim's default) removes the path for a moment; that is not a deletion.
const REMOVE_SETTLE: Duration = Duration::from_millis(250);

/// Most notes sent for one folder made or moved in: as many as the Activity
/// list keeps (`MAX_FILES` in src/store/activityStore.ts).
const FOLDER_ADDED_LIMIT: usize = 200;

type EmitFn = std::sync::Arc<dyn Fn(ActivityFilePayload) + Send + Sync>;

/// Turns watcher events into `activity://file` payloads. Removals used to be
/// dropped (only creates and modifies were sent), so a note deleted, renamed
/// or moved elsewhere stayed in the Activity list and in the wikilink cache.
struct EventRouter {
    debounce: std::sync::Arc<Mutex<HashMap<String, Instant>>>,
    /// Paths seen removed, each with the time it is checked again: sent then
    /// if it is still gone. Non-empty means a flush thread is running.
    removals: Mutex<Vec<(PathBuf, Instant)>>,
    emit: EmitFn,
    settle: Duration,
}

impl EventRouter {
    fn new(
        debounce: std::sync::Arc<Mutex<HashMap<String, Instant>>>,
        emit: EmitFn,
        settle: Duration,
    ) -> Self {
        EventRouter {
            debounce,
            removals: Mutex::new(Vec::new()),
            emit,
            settle,
        }
    }

    fn handle(self: &std::sync::Arc<Self>, event: &notify::Event) {
        use notify::event::{ModifyKind, RemoveKind};
        for path in &event.paths {
            if should_skip_path(path) {
                continue;
            }
            if !is_markdown(path) {
                // A folder deleted, or renamed or moved away, sends no event
                // for the notes inside it on every platform: its own removal
                // is sent (after the same settle check), and the listing
                // drops the notes under it. Only a file's removal is known
                // not to be a folder's; the others may be either.
                match event.kind {
                    EventKind::Remove(RemoveKind::File) => {}
                    EventKind::Remove(_) => self.gone(path),
                    EventKind::Modify(ModifyKind::Name(_)) if !path.exists() => self.gone(path),
                    // Nor does a folder made or moved in for the notes it
                    // already holds: they are sent as a note's would be.
                    EventKind::Create(_) => self.folder_added(path, "created"),
                    EventKind::Modify(ModifyKind::Name(_)) => self.folder_added(path, "modified"),
                    _ => {}
                }
                continue;
            }
            match event.kind {
                EventKind::Create(_) => self.present(path, "created"),
                // A rename reports the old path (now gone) and the new one,
                // together or as separate events depending on the platform.
                EventKind::Modify(ModifyKind::Name(_)) => {
                    if path.exists() {
                        self.present(path, "modified");
                    } else {
                        self.gone(path);
                    }
                }
                EventKind::Modify(_) => self.present(path, "modified"),
                EventKind::Remove(_) => self.gone(path),
                _ => {}
            }
        }
    }

    fn present(&self, path: &Path, kind: &'static str) {
        // Skip if file no longer exists (transient create+remove).
        if !path.exists() {
            return;
        }
        let path_str = path.to_string_lossy().into_owned();
        // Debounce: suppress if we emitted this path within DEBOUNCE window.
        {
            let mut map = self.debounce.lock().unwrap();
            let now = Instant::now();
            if let Some(&last) = map.get(&path_str) {
                if now.duration_since(last) < DEBOUNCE {
                    return;
                }
            }
            map.insert(path_str.clone(), now);
        }
        let (mtime_ms, size) = stat_file(path);
        (self.emit)(payload_for(path, path_str, kind, mtime_ms, size));
    }

    /// Sends the notes in a folder made or moved into the watched one, at most
    /// [`FOLDER_ADDED_LIMIT`] of the newest, oldest first (the list places
    /// each by its time). They were listed only by the next full scan.
    fn folder_added(&self, path: &Path, kind: &'static str) {
        // A link to a folder is not followed (nor are links inside it: the
        // walk reads entries without following them), so no note from
        // outside the watched folder is listed or indexed.
        if !std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
            return;
        }
        let scan = scan_newest(path, FOLDER_ADDED_LIMIT, MAX_SCAN_ENTRIES);
        for file in scan.files.iter().rev() {
            self.present(Path::new(&file.path), kind);
        }
    }

    fn gone(self: &std::sync::Arc<Self>, path: &Path) {
        let due = Instant::now() + self.settle;
        let mut pending = self.removals.lock().unwrap();
        let schedule = pending.is_empty();
        // Each path gets its own full settle period, counted from its latest
        // removal, however late it is queued behind another.
        match pending.iter_mut().find(|(p, _)| p == path) {
            Some(entry) => entry.1 = due,
            None => pending.push((path.to_path_buf(), due)),
        }
        drop(pending);
        if schedule {
            let router = self.clone();
            std::thread::spawn(move || {
                std::thread::sleep(router.settle);
                while let Some(wait) = router.flush_removals() {
                    std::thread::sleep(wait);
                }
            });
        }
    }

    /// Sends the removals whose settle period has passed. Returns how long to
    /// wait for the next one, or `None` once the queue is empty; that is seen
    /// under the same lock [`EventRouter::gone`] checks before it starts a
    /// flush thread, so a later removal always gets one.
    fn flush_removals(&self) -> Option<Duration> {
        let now = Instant::now();
        let (paths, wait) = {
            let mut pending = self.removals.lock().unwrap();
            let (due, waiting): (Vec<_>, Vec<_>) =
                pending.drain(..).partition(|(_, at)| *at <= now);
            *pending = waiting;
            let wait = pending.iter().map(|(_, at)| *at - now).min();
            (due, wait)
        };
        for (path, _) in paths {
            if path.exists() {
                continue;
            }
            let path_str = path.to_string_lossy().into_owned();
            // A file made again at this path is new, not a repeat to suppress.
            self.debounce.lock().unwrap().remove(&path_str);
            (self.emit)(payload_for(&path, path_str, "removed", 0, 0));
        }
        wait
    }
}

fn payload_for(
    path: &Path,
    path_str: String,
    kind: &'static str,
    mtime_ms: u64,
    size: u64,
) -> ActivityFilePayload {
    ActivityFilePayload {
        kind,
        path: path_str,
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        dir: path
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        mtime_ms,
        size,
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Start watching `path` recursively for Markdown file creates, modifies,
/// removals and renames. Replaces any previously active directory watch.
///
/// Emits **`activity://file`** for each qualifying event with payload
/// `{ kind, path, name, dir, mtimeMs, size }` (see [`ActivityFilePayload`]).
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

    // We borrow last_seen via the state in the closure by passing in an Arc.
    // Because the state lifetime is tied to the Tauri app (which outlives any
    // individual command), we can safely clone the Arc-like State handle.
    // However, tauri::State is not Send. We work around this by moving the
    // debounce map into an Arc<Mutex<_>> that both the closure and the command
    // can reach.
    let debounce_map: std::sync::Arc<Mutex<HashMap<String, Instant>>> =
        std::sync::Arc::new(Mutex::new(HashMap::new()));
    let debounce_map_cb = debounce_map.clone();

    let emit_app = app;
    let router = std::sync::Arc::new(EventRouter::new(
        debounce_map_cb,
        std::sync::Arc::new(move |payload: ActivityFilePayload| {
            let _ = emit_app.emit("activity://file", payload);
        }),
        REMOVE_SETTLE,
    ));
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        router.handle(&event);
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

/// Deepest folder level the scan enters (the folder itself is level 0). A
/// folder below it is not read, and the scan says it was cut short.
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
    /// The walk did not read the whole tree: it stopped at
    /// [`MAX_SCAN_ENTRIES`], or skipped a folder more than [`MAX_DEPTH`]
    /// levels down. So `files` are the newest of the files it reached, not
    /// necessarily the folder's newest. Deep folders used to be skipped
    /// without a word. Kept meaning "either limit" for older consumers.
    pub scan_cut: bool,
    /// A folder more than [`MAX_DEPTH`] levels down was skipped (`scan_cut`
    /// is then set too). `scan_cut` without `depth_cut` means the entry
    /// budget alone cut the walk; with it, the depth limit did (and the
    /// entry budget may have as well).
    pub depth_cut: bool,
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
        too_deep: false,
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
        scan_cut: walk.cut || walk.too_deep,
        depth_cut: walk.too_deep,
    }
}

struct Walk {
    newest: std::collections::BinaryHeap<std::cmp::Reverse<ByRecency>>,
    limit: usize,
    entries_left: usize,
    cut: bool,
    /// A folder below [`MAX_DEPTH`] was skipped (the walk goes on).
    too_deep: bool,
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

    /// Recursive walking helper. Skips folders below MAX_DEPTH (setting
    /// `too_deep`), and stops at the entry budget (setting `cut`) to stay
    /// fast on large repos.
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
                if depth + 1 > MAX_DEPTH {
                    self.too_deep = true;
                    continue;
                }
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
    use super::{list_markdown_files, scan_newest, ActivityFilePayload, EventRouter};
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

    /// An [`EventRouter`] that records what it would emit, settling removals
    /// after 30 ms.
    fn recording_router() -> (
        std::sync::Arc<EventRouter>,
        std::sync::Arc<std::sync::Mutex<Vec<ActivityFilePayload>>>,
    ) {
        router_settling_after(Duration::from_millis(30))
    }

    fn router_settling_after(
        settle: Duration,
    ) -> (
        std::sync::Arc<EventRouter>,
        std::sync::Arc<std::sync::Mutex<Vec<ActivityFilePayload>>>,
    ) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        let router = std::sync::Arc::new(EventRouter::new(
            Default::default(),
            std::sync::Arc::new(move |p| sink.lock().unwrap().push(p)),
            settle,
        ));
        (router, seen)
    }

    fn kinds(seen: &std::sync::Mutex<Vec<ActivityFilePayload>>) -> Vec<(String, String)> {
        seen.lock()
            .unwrap()
            .iter()
            .map(|p| (p.kind.to_string(), p.name.clone()))
            .collect()
    }

    /// Wait (up to 2 s) until `n` payloads were emitted.
    fn wait_for(seen: &std::sync::Mutex<Vec<ActivityFilePayload>>, n: usize) {
        for _ in 0..200 {
            if seen.lock().unwrap().len() >= n {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_deleted_note_is_sent_as_removed() {
        use notify::event::{EventKind, RemoveKind};
        let dir = TempDir::new("removed");
        let gone = dir.0.join("gone.md");
        let (router, seen) = recording_router();
        router.handle(
            &notify::Event::new(EventKind::Remove(RemoveKind::File)).add_path(gone.clone()),
        );
        wait_for(&seen, 1);
        let sent = seen.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].kind, "removed");
        assert_eq!(sent[0].path, gone.to_string_lossy());
        assert_eq!(sent[0].name, "gone.md");
        assert_eq!(sent[0].dir, dir.0.to_string_lossy());
        assert_eq!((sent[0].mtime_ms, sent[0].size), (0, 0));
    }

    #[test]
    fn a_rename_inside_the_folder_removes_the_old_path_and_lists_the_new() {
        use notify::event::{EventKind, ModifyKind, RenameMode};
        let dir = TempDir::new("renamed");
        let new = dir.0.join("new.md");
        std::fs::write(&new, "# x\n").unwrap();
        let (router, seen) = recording_router();
        router.handle(
            &notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(dir.0.join("old.md"))
                .add_path(new),
        );
        wait_for(&seen, 2);
        assert_eq!(
            kinds(&seen),
            vec![
                ("modified".to_string(), "new.md".to_string()),
                ("removed".to_string(), "old.md".to_string()),
            ]
        );
    }

    #[test]
    fn a_note_renamed_away_and_back_by_a_save_is_not_removed() {
        use notify::event::{EventKind, ModifyKind, RenameMode};
        let dir = TempDir::new("resaved");
        let note = dir.0.join("note.md");
        let (router, seen) = recording_router();
        // The editor renamed the note away, then writes it again at once.
        router.handle(
            &notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
                .add_path(note.clone()),
        );
        std::fs::write(&note, "# x\n").unwrap();
        std::thread::sleep(Duration::from_millis(120));
        assert!(kinds(&seen).is_empty(), "{:?}", kinds(&seen));
    }

    #[test]
    fn a_removal_queued_behind_another_gets_its_own_settle_period() {
        use notify::event::{EventKind, RemoveKind};
        let dir = TempDir::new("late");
        let first = dir.0.join("first.md");
        let late = dir.0.join("late.md");
        let (router, seen) = router_settling_after(Duration::from_millis(300));
        let remove = |p: &Path| {
            router.handle(
                &notify::Event::new(EventKind::Remove(RemoveKind::File)).add_path(p.to_path_buf()),
            )
        };
        remove(&first);
        std::thread::sleep(Duration::from_millis(200));
        // Removed late in the first one's window, then written again after
        // that window closed but well inside its own.
        remove(&late);
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(&late, "# x\n").unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(
            kinds(&seen),
            vec![("removed".to_string(), "first.md".to_string())]
        );
    }

    #[test]
    fn removals_skip_what_creates_skip() {
        use notify::event::{EventKind, RemoveKind};
        let dir = TempDir::new("skipped");
        let (router, seen) = recording_router();
        for name in ["pic.png", ".hidden.md", "x.md.mdopener.tmp"] {
            router.handle(
                &notify::Event::new(EventKind::Remove(RemoveKind::File)).add_path(dir.0.join(name)),
            );
        }
        std::thread::sleep(Duration::from_millis(120));
        assert!(kinds(&seen).is_empty(), "{:?}", kinds(&seen));
    }

    #[test]
    fn a_folder_deleted_or_moved_away_is_sent_as_removed() {
        use notify::event::{EventKind, ModifyKind, RemoveKind, RenameMode};
        let dir = TempDir::new("folder");
        let (router, seen) = recording_router();
        router.handle(
            &notify::Event::new(EventKind::Remove(RemoveKind::Folder))
                .add_path(dir.0.join("deleted")),
        );
        router.handle(
            &notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
                .add_path(dir.0.join("moved.d")),
        );
        // A folder renamed inside the watched one: the new name is there.
        let kept = dir.0.join("kept");
        std::fs::create_dir(&kept).unwrap();
        router.handle(
            &notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To))).add_path(kept),
        );
        wait_for(&seen, 2);
        std::thread::sleep(Duration::from_millis(60));
        let mut sent = kinds(&seen);
        sent.sort();
        assert_eq!(
            sent,
            vec![
                ("removed".to_string(), "deleted".to_string()),
                ("removed".to_string(), "moved.d".to_string()),
            ]
        );
    }

    #[test]
    fn the_notes_of_a_folder_moved_or_made_in_are_sent() {
        use notify::event::{CreateKind, EventKind, ModifyKind, RenameMode};
        let dir = TempDir::new("added");
        let moved = dir.0.join("moved");
        std::fs::create_dir_all(moved.join("sub")).unwrap();
        write_md(&moved, "old.md", 1_000);
        write_md(&moved.join("sub"), "new.md", 2_000);
        std::fs::write(moved.join("pic.png"), "x").unwrap();
        let made = dir.0.join("made");
        std::fs::create_dir(&made).unwrap();
        write_md(&made, "made.md", 3_000);
        let (router, seen) = recording_router();
        router.handle(
            &notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
                .add_path(moved),
        );
        router.handle(&notify::Event::new(EventKind::Create(CreateKind::Folder)).add_path(made));
        // Oldest first, so the newest is on top of the list.
        assert_eq!(
            kinds(&seen),
            vec![
                ("modified".to_string(), "old.md".to_string()),
                ("modified".to_string(), "new.md".to_string()),
                ("created".to_string(), "made.md".to_string()),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_folder_made_in_sends_nothing() {
        use notify::event::{CreateKind, EventKind};
        let dir = TempDir::new("linked");
        let outside = dir.0.join("outside");
        std::fs::create_dir(&outside).unwrap();
        write_md(&outside, "secret.md", 1_000);
        let watched = dir.0.join("watched");
        std::fs::create_dir(&watched).unwrap();
        let link = watched.join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let (router, seen) = recording_router();
        router.handle(&notify::Event::new(EventKind::Create(CreateKind::Folder)).add_path(link));
        assert!(kinds(&seen).is_empty());
    }

    #[test]
    fn a_note_made_again_after_its_removal_is_sent_again() {
        use notify::event::{CreateKind, EventKind, RemoveKind};
        let dir = TempDir::new("again");
        let note = dir.0.join("note.md");
        std::fs::write(&note, "# x\n").unwrap();
        let (router, seen) = recording_router();
        router.handle(
            &notify::Event::new(EventKind::Create(CreateKind::File)).add_path(note.clone()),
        );
        std::fs::remove_file(&note).unwrap();
        router.handle(
            &notify::Event::new(EventKind::Remove(RemoveKind::File)).add_path(note.clone()),
        );
        wait_for(&seen, 2);
        std::fs::write(&note, "# y\n").unwrap();
        router.handle(&notify::Event::new(EventKind::Create(CreateKind::File)).add_path(note));
        assert_eq!(
            kinds(&seen),
            vec![
                ("created".to_string(), "note.md".to_string()),
                ("removed".to_string(), "note.md".to_string()),
                ("created".to_string(), "note.md".to_string()),
            ]
        );
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
        assert!(!cut.depth_cut, "the entry budget is not the depth limit");
        assert!(cut.files.len() <= 3, "only 3 of the 4 entries are files");
        // Exactly the budget is not a cut: every entry was read.
        assert!(!scan_newest(&tmp.0, 5, 11).scan_cut);
    }

    /// Folders more than MAX_DEPTH levels down are not read, as before, but
    /// the scan now says it was cut short instead of skipping them silently.
    #[test]
    fn a_folder_below_the_depth_limit_is_reported_as_a_cut() {
        let tmp = TempDir::new("deep");
        let mut dir = tmp.0.clone();
        for level in 1..=super::MAX_DEPTH {
            dir = dir.join(format!("l{level}"));
        }
        std::fs::create_dir_all(&dir).unwrap();
        write_md(&dir, "deepest-read.md", 10);
        let whole = scan_newest(&tmp.0, 5, 1000);
        assert!(!whole.scan_cut, "level {} is still read", super::MAX_DEPTH);
        assert_eq!(whole.files.len(), 1);
        let below = dir.join("too-deep");
        std::fs::create_dir(&below).unwrap();
        write_md(&below, "missed.md", 20);
        let cut = scan_newest(&tmp.0, 5, 1000);
        assert!(cut.scan_cut, "a skipped folder must be reported");
        assert!(cut.depth_cut, "and reported as a depth cut");
        let names: Vec<&str> = cut.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["deepest-read.md"], "the depth limit is unchanged");
        // Hidden folders and node_modules are skipped by rule, not depth.
        std::fs::remove_dir_all(&below).unwrap();
        std::fs::create_dir(dir.join(".git")).unwrap();
        std::fs::create_dir(dir.join("node_modules")).unwrap();
        let skipped = scan_newest(&tmp.0, 5, 1000);
        assert!(!skipped.scan_cut && !skipped.depth_cut);
    }

    #[test]
    fn a_zero_limit_lists_nothing() {
        let tmp = TempDir::new("zero");
        write_md(&tmp.0, "a.md", 5);
        assert!(scan_newest(&tmp.0, 0, 100).files.is_empty());
    }
}
