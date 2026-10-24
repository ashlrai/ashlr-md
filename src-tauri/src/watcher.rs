//! Watches the currently open file for external changes.
//!
//! We watch the file's PARENT directory (not the file inode) and filter by
//! path, because many editors save atomically by writing a temp file and
//! renaming it — which changes the inode and would be missed by a direct
//! file watch. On a relevant event we emit `file-changed`; the frontend then
//! re-reads the file and decides whether to reload or flag a conflict.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct FileWatcher(pub Mutex<Option<RecommendedWatcher>>);

/// Begin watching `path`, replacing any previous watch.
///
/// A document that is a symbolic link is watched where it points too: an
/// edit to the real file (in another folder) made no event in the link's
/// folder, so the window kept showing the old text and its next save wrote
/// over the edit. Events are matched against both paths, and the file is
/// still reported by the path the window opened.
#[tauri::command]
pub fn watch_file(
    app: AppHandle,
    path: String,
    state: tauri::State<FileWatcher>,
) -> Result<(), String> {
    let app_for_cb = app.clone();
    let reported = path.clone();
    start_watch(&state.0, Path::new(&path), move || {
        let _ = app_for_cb.emit("file-changed", reported.clone());
    })
}

/// Watch `path` into `slot`, calling `changed` on each event for it. The
/// watch held before is dropped first, whether or not this one starts: a
/// failure used to leave it running, so the window went on hearing about
/// the file it showed before (or about nothing it showed) while nothing
/// watched the file it shows now, and nobody was told. The error says so.
fn start_watch<F>(
    slot: &Mutex<Option<RecommendedWatcher>>,
    path: &Path,
    changed: F,
) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    let mut held = slot.lock().unwrap_or_else(|e| e.into_inner());
    *held = None;
    let not_watched = |e: String| {
        format!(
            "Changes made to {} outside Ashlr MD will not be noticed: {e}",
            path.display()
        )
    };
    let (dirs, targets) = watch_plan(path).map_err(not_watched)?;
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        ) && event.paths.iter().any(|p| targets.contains(p))
        {
            changed();
        }
    })
    .map_err(|e| not_watched(e.to_string()))?;

    for dir in &dirs {
        watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|e| not_watched(e.to_string()))?;
    }

    *held = Some(watcher);
    Ok(())
}

/// The folders to watch for `path` and the paths whose events count: its
/// own folder and path, and when it resolves elsewhere (a symbolic link, or a
/// folder on the way that is one, as `/tmp` is on macOS, whose events name
/// the real path) the real file's folder and path too.
fn watch_plan(path: &Path) -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    let parent = path
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "file has no parent directory".to_string())?;
    let mut dirs = vec![parent];
    let mut targets = vec![path.to_path_buf()];
    if let Ok(real) = std::fs::canonicalize(path) {
        if real != path {
            if let Some(real_parent) = real.parent() {
                if !dirs.iter().any(|d| d == real_parent) {
                    dirs.push(real_parent.to_path_buf());
                }
            }
            targets.push(real);
        }
    }
    Ok((dirs, targets))
}

/// Stop watching (e.g. when the document is closed).
#[tauri::command]
pub fn unwatch_file(state: tauri::State<FileWatcher>) {
    *state.0.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::{start_watch, watch_plan};
    use std::sync::Mutex;

    /// A watch that cannot start drops the one held before and says why:
    /// the old one stayed, watching the file the window showed before.
    #[test]
    fn a_watch_that_fails_drops_the_one_before() {
        let root = std::env::temp_dir().join(format!("md-watch-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let first = root.join("a.md");
        std::fs::write(&first, "a").unwrap();
        let slot = Mutex::new(None);
        start_watch(&slot, &first, || {}).unwrap();
        assert!(slot.lock().unwrap().is_some());

        let gone = root.join("no such folder").join("b.md");
        let err = start_watch(&slot, &gone, || {}).unwrap_err();
        assert!(err.contains("will not be noticed"), "{err}");
        assert!(err.contains("b.md"), "{err}");
        assert!(slot.lock().unwrap().is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_document_is_watched_where_it_points_too() {
        let root = std::env::temp_dir().join(format!("md-watch-plan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let real_dir = root.join("real dir é");
        std::fs::create_dir_all(&real_dir).unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let real_dir = root.join("real dir é");
        let real = real_dir.join("notes.md");
        std::fs::write(&real, "x").unwrap();
        let link = root.join("notes.md");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let (dirs, targets) = watch_plan(&link).unwrap();
        assert_eq!(dirs, vec![root.clone(), real_dir.clone()]);
        assert_eq!(targets, vec![link.clone(), real.clone()]);

        // A plain file is watched in its own folder only.
        let (dirs, targets) = watch_plan(&real).unwrap();
        assert_eq!(dirs, vec![real_dir.clone()]);
        assert_eq!(targets, vec![real.clone()]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
