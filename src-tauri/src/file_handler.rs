//! How files reach the app.
//!
//! On macOS, double-clicking a `.md` file (or "Open With", or dragging onto the
//! dock icon) delivers a `RunEvent::Opened` to the running process. On first
//! launch the webview may not be ready yet, so opened paths are buffered in
//! [`PendingFiles`]; the frontend drains the buffer via [`take_pending_files`]
//! once it has mounted, and also listens for the live `file-opened` event for
//! files opened while the app is already running.

use crate::PendingFiles;
use tauri::{AppHandle, Manager};

// Emitter and Url are only needed by the macOS-only handle_opened path.
#[cfg(target_os = "macos")]
use tauri::{Emitter, Url};

/// Convert opened URLs into absolute file paths, buffer them, and notify the
/// frontend. Called from the `RunEvent::Opened` arm of the run loop.
///
/// macOS only — other platforms receive files as CLI args (see
/// [`buffer_cli_args`]) and deep links via the deep-link plugin.
#[cfg(target_os = "macos")]
pub fn handle_opened(app: &AppHandle, urls: Vec<Url>) {
    let paths: Vec<String> = urls
        .iter()
        .filter_map(|u| u.to_file_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    if paths.is_empty() {
        return;
    }

    app.state::<PendingFiles>().queue(paths.clone());

    // Emit for the already-running case. Harmless if no listener is attached yet
    // — the buffered copy in PendingFiles is the fallback for cold launches.
    let _ = app.emit("file-opened", paths);
}

/// Buffer file paths passed as CLI arguments at launch (covers `mdopen file.md`
/// and non-macOS platforms where files arrive as argv rather than RunEvent).
pub fn buffer_cli_args(app: &AppHandle) {
    let args = launch_paths(std::env::args_os().skip(1));

    if args.is_empty() {
        return;
    }

    app.state::<PendingFiles>().queue(args);
}

/// The files the launch arguments name. They are read as OS strings because
/// `std::env::args` panics on an argument that is not valid UTF-8, which
/// stopped the app before its window opened. The app takes paths as UTF-8
/// text, so such an argument could only name some other file: it is skipped
/// and named (lossily) on stderr, and the other arguments still open.
fn launch_paths(args: impl IntoIterator<Item = std::ffi::OsString>) -> Vec<String> {
    args.into_iter()
        .filter_map(|a| match a.into_string() {
            Ok(arg) => cli_arg_to_path(&arg),
            Err(a) => {
                eprintln!("[file_handler] ignoring launch argument {a:?}: not valid UTF-8");
                None
            }
        })
        .collect()
}

/// A second launch while the app is already running (Linux/Windows; wired via
/// tauri-plugin-single-instance). The new process exits, and its argv + cwd
/// land here: open the files it named in this instance and bring the window
/// forward. `mdopener://` URLs in that argv are forwarded to the deep-link
/// plugin's `on_open_url` by the single-instance plugin itself.
pub fn handle_second_instance(app: &AppHandle, argv: &[String], cwd: &str) {
    let cwd = std::path::Path::new(cwd);
    let paths: Vec<String> = argv
        .iter()
        .skip(1)
        .filter_map(|a| cli_arg_to_path_in(a, cwd))
        .collect();

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }

    if paths.is_empty() {
        return;
    }
    app.state::<PendingFiles>().queue(paths.clone());
    let _ = tauri::Emitter::emit(app, "file-opened", paths);
}

/// The file a launch argument names, as an absolute path. Accepts a plain path
/// or a `file://` URI: the Linux desktop entry launches the app with `%u`, so
/// file managers pass `file:///…` URIs. Flags, `mdopener://` deep links (the
/// deep-link plugin handles those) and paths that do not resolve yield `None`.
pub fn cli_arg_to_path(arg: &str) -> Option<String> {
    cli_arg_to_path_in(arg, std::path::Path::new(""))
}

/// [`cli_arg_to_path`], resolving a relative path against `cwd` (the launching
/// process's working directory, which differs from ours for a second instance).
fn cli_arg_to_path_in(arg: &str, cwd: &std::path::Path) -> Option<String> {
    if arg.starts_with('-') {
        return None;
    }
    let path = if arg.starts_with("file://") {
        tauri::Url::parse(arg).ok()?.to_file_path().ok()?
    } else {
        cwd.join(arg)
    };
    std::fs::canonicalize(path)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Drain and return any buffered file paths. The frontend calls this once on
/// mount to pick up files that were opened before the webview was ready;
/// after that nothing more is buffered (see [`PendingFiles`]).
#[tauri::command]
pub fn take_pending_files(state: tauri::State<PendingFiles>) -> Vec<String> {
    state.take()
}

#[cfg(test)]
mod tests {
    use super::{cli_arg_to_path, cli_arg_to_path_in, launch_paths};

    #[test]
    fn launch_args_accept_paths_and_file_uris() {
        let dir = std::env::temp_dir().join(format!("md-cli-args-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a file é.md");
        std::fs::write(&file, "# hi").unwrap();
        let canonical = std::fs::canonicalize(&file)
            .unwrap()
            .to_string_lossy()
            .into_owned();

        assert_eq!(cli_arg_to_path(file.to_str().unwrap()), Some(canonical.clone()));
        let uri = tauri::Url::from_file_path(&file).unwrap().to_string();
        assert!(uri.contains("a%20file%20%C3%A9.md"), "{uri}");
        assert_eq!(cli_arg_to_path(&uri), Some(canonical.clone()));

        assert_eq!(cli_arg_to_path("--flag"), None);
        assert_eq!(cli_arg_to_path("mdopener://open?path=%2Fx.md"), None);
        assert_eq!(cli_arg_to_path("file:///no/such/file.md"), None);
        // A second instance's relative path resolves against ITS cwd.
        assert_eq!(cli_arg_to_path_in("a file é.md", &dir), Some(canonical));
        assert_eq!(cli_arg_to_path_in("mdopener://open?path=x", &dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A launch argument that is not valid UTF-8 used to panic the app at
    /// startup. It is skipped, and the valid paths beside it still open.
    #[cfg(unix)]
    #[test]
    fn a_launch_argument_that_is_not_utf8_is_skipped_not_a_panic() {
        use std::os::unix::ffi::OsStringExt;
        let dir = std::env::temp_dir().join(format!("md-cli-utf8-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("ok.md");
        std::fs::write(&file, "# hi").unwrap();
        let canonical = std::fs::canonicalize(&file)
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let bad = std::ffi::OsString::from_vec(b"bad\xff.md".to_vec());
        let paths = launch_paths([bad, file.clone().into_os_string(), "--flag".into()]);
        assert_eq!(paths, vec![canonical]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
