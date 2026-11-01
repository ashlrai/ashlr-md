//! Watches the currently open file for external changes.
//!
//! We watch the file's PARENT directory (not the file inode) and filter by
//! path, because many editors save atomically by writing a temp file and
//! renaming it — which changes the inode and would be missed by a direct
//! file watch. On a relevant event we emit `file-changed`; the frontend then
//! re-reads the file and decides whether to reload or flag a conflict.
//!
//! A rename of the file within its folder is followed where the platform
//! reports both names (Linux, and Windows as a "from" then a "to" event):
//! `file-renamed` names the old and the new path, and the window takes the
//! new one. Elsewhere (macOS reports each name alone) and for a move out of
//! the folder, the file reads as gone, as a deletion does.

use notify::event::{ModifyKind, RenameMode};
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
    start_watch(&state.0, Path::new(&path), move |seen| match seen {
        Seen::Changed => {
            let _ = app_for_cb.emit("file-changed", reported.clone());
        }
        Seen::Renamed(to) => {
            let _ = app_for_cb.emit(
                "file-renamed",
                FileRenamed {
                    from: reported.clone(),
                    to: to.to_string_lossy().into_owned(),
                },
            );
        }
    })
}

/// The `file-renamed` event's payload: the path the window opened, and the
/// file's new path.
#[derive(Clone, serde::Serialize)]
struct FileRenamed {
    from: String,
    to: String,
}

/// What a watch event says about the watched file.
#[derive(Debug, PartialEq, Eq)]
enum Seen {
    /// Changed, created or removed: read it again.
    Changed,
    /// Renamed to this path.
    Renamed(PathBuf),
}

/// What `event` says about the file at `targets` (see [`watch_plan`]), as
/// [`Seen`], or nothing. A rename is one only for a path in `follow` and
/// where the platform names both paths: in one event, or as a "from" event
/// for the file (kept in `renamed_from`) and the "to" event next.
fn classify(
    event: &notify::Event,
    targets: &[PathBuf],
    follow: &[PathBuf],
    renamed_from: &mut bool,
) -> Option<Seen> {
    let from_pending = std::mem::take(renamed_from);
    match event.kind {
        EventKind::Modify(ModifyKind::Name(RenameMode::Both))
            if event.paths.len() == 2
                && follow.contains(&event.paths[0])
                && !targets.contains(&event.paths[1]) =>
        {
            return Some(Seen::Renamed(event.paths[1].clone()));
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) if from_pending => {
            if let [to] = event.paths.as_slice() {
                if !targets.contains(to) {
                    return Some(Seen::Renamed(to.clone()));
                }
            }
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            *renamed_from = event.paths.iter().any(|p| follow.contains(p));
        }
        _ => {}
    }
    let relevant = matches!(
        event.kind,
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
    );
    (relevant && event.paths.iter().any(|p| targets.contains(p))).then_some(Seen::Changed)
}

/// Watch `path` into `slot`, calling `changed` with what each event for it
/// says ([`classify`]). The
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
    F: Fn(Seen) + Send + 'static,
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
    // A document that is a symbolic link is followed only when the link is
    // renamed: a renamed real file leaves the link pointing at nothing.
    let is_link = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
    let follow = if is_link {
        vec![path.to_path_buf()]
    } else {
        targets.clone()
    };
    let mut renamed_from = false;
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if let Some(seen) = classify(&event, &targets, &follow, &mut renamed_from) {
            changed(seen);
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
    use super::{classify, start_watch, watch_plan, Seen};
    use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
    use notify::{Event, EventKind};
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn rename(mode: RenameMode, paths: &[&str]) -> Event {
        let mut e = Event::new(EventKind::Modify(ModifyKind::Name(mode)));
        for p in paths {
            e = e.add_path(PathBuf::from(p));
        }
        e
    }

    #[test]
    fn paired_renames_preserve_change_fallback_and_check_path_count() {
        let targets = vec![PathBuf::from("/d/a.md")];
        for (paths, expected) in [
            (vec![], None),
            (vec!["/d/a.md"], Some(Seen::Changed)),
            // An atomic save replaces the watched path; it does not rename it.
            (vec!["/d/tmp.md", "/d/a.md"], Some(Seen::Changed)),
            (vec!["/d/a.md", "/d/a.md"], Some(Seen::Changed)),
            (vec!["/d/a.md", "/d/b.md", "/d/c.md"], Some(Seen::Changed)),
            (vec!["/d/x.md", "/d/y.md"], None),
        ] {
            let mut pending = true;
            assert_eq!(
                classify(
                    &rename(RenameMode::Both, &paths),
                    &targets,
                    &targets,
                    &mut pending,
                ),
                expected,
                "paths: {paths:?}"
            );
            assert!(!pending, "a paired rename consumes a pending from event");
        }
    }

    /// A rename in the folder was read as the file being gone: the tab was
    /// marked missing, and following the file meant opening it again.
    #[test]
    fn a_rename_is_followed_where_both_names_are_reported() {
        let targets = vec![PathBuf::from("/d/a.md")];
        let mut from = false;
        // Linux: one event with both names.
        let both = rename(RenameMode::Both, &["/d/a.md", "/d/b.md"]);
        assert_eq!(
            classify(&both, &targets, &targets, &mut from),
            Some(Seen::Renamed(PathBuf::from("/d/b.md")))
        );
        // Windows: "from", then "to". The "from" reads as a change (gone).
        let first = rename(RenameMode::From, &["/d/a.md"]);
        assert_eq!(
            classify(&first, &targets, &targets, &mut from),
            Some(Seen::Changed)
        );
        let to = rename(RenameMode::To, &["/d/c.md"]);
        assert_eq!(
            classify(&to, &targets, &targets, &mut from),
            Some(Seen::Renamed(PathBuf::from("/d/c.md")))
        );
        // A "to" with no "from" of this file before it is someone else's.
        assert_eq!(classify(&to, &targets, &targets, &mut from), None);
        // macOS names each path alone: the file reads as gone.
        let any = rename(RenameMode::Any, &["/d/a.md"]);
        assert_eq!(
            classify(&any, &targets, &targets, &mut from),
            Some(Seen::Changed)
        );
        // Another file renamed, created or removed in the folder: nothing.
        let other = rename(RenameMode::Both, &["/d/x.md", "/d/y.md"]);
        assert_eq!(classify(&other, &targets, &targets, &mut from), None);
        let created = Event::new(EventKind::Create(CreateKind::File)).add_path("/d/z.md".into());
        assert_eq!(classify(&created, &targets, &targets, &mut from), None);
        let removed = Event::new(EventKind::Remove(RemoveKind::File)).add_path("/d/a.md".into());
        assert_eq!(
            classify(&removed, &targets, &targets, &mut from),
            Some(Seen::Changed)
        );
        // A path not to follow (a link's real file) is a change, not a rename.
        let real = vec![PathBuf::from("/d/a.md"), PathBuf::from("/r/a.md")];
        let moved = rename(RenameMode::Both, &["/r/a.md", "/r/b.md"]);
        assert_eq!(
            classify(&moved, &real, &real[..1], &mut from),
            Some(Seen::Changed)
        );
    }

    /// The real watcher, on this platform: a rename in the folder is
    /// reported as one where the platform names both paths.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_renamed_file_is_reported_with_its_new_path() {
        let root = std::env::temp_dir().join(format!("md-watch-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let a = root.join("a.md");
        let b = root.join("b.md");
        std::fs::write(&a, "x").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = Mutex::new(tx);
        let slot = Mutex::new(None);
        start_watch(&slot, &a, move |seen| {
            let _ = tx.lock().unwrap().send(seen);
        })
        .unwrap();
        std::fs::rename(&a, &b).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut renamed = None;
        while renamed.is_none() && std::time::Instant::now() < deadline {
            if let Ok(Seen::Renamed(to)) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                renamed = Some(to);
            }
        }
        *slot.lock().unwrap() = None;
        assert_eq!(renamed, Some(b));
        let _ = std::fs::remove_dir_all(&root);
    }

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
        start_watch(&slot, &first, |_| {}).unwrap();
        assert!(slot.lock().unwrap().is_some());

        let gone = root.join("no such folder").join("b.md");
        let err = start_watch(&slot, &gone, |_| {}).unwrap_err();
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
