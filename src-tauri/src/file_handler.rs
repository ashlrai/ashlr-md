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

    {
        let state = app.state::<PendingFiles>();
        let mut buf = state.0.lock().unwrap();
        buf.extend(paths.clone());
    }

    // Emit for the already-running case. Harmless if no listener is attached yet
    // — the buffered copy in PendingFiles is the fallback for cold launches.
    let _ = app.emit("file-opened", paths);
}

/// Buffer file paths passed as CLI arguments at launch (covers `mdopen file.md`
/// and non-macOS platforms where files arrive as argv rather than RunEvent).
pub fn buffer_cli_args(app: &AppHandle) {
    let args: Vec<String> = std::env::args()
        .skip(1)
        .filter_map(|a| cli_arg_to_path(&a))
        .collect();

    if args.is_empty() {
        return;
    }

    let state = app.state::<PendingFiles>();
    let mut buf = state.0.lock().unwrap();
    buf.extend(args);
}

/// The file a launch argument names, as an absolute path. Accepts a plain path
/// or a `file://` URI: the Linux desktop entry launches the app with `%u`, so
/// file managers pass `file:///…` URIs. Flags, `mdopener://` deep links (the
/// deep-link plugin handles those) and paths that do not resolve yield `None`.
pub fn cli_arg_to_path(arg: &str) -> Option<String> {
    if arg.starts_with('-') {
        return None;
    }
    let path = if arg.starts_with("file://") {
        tauri::Url::parse(arg).ok()?.to_file_path().ok()?
    } else {
        std::path::PathBuf::from(arg)
    };
    std::fs::canonicalize(path)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Drain and return any buffered file paths. The frontend calls this once on
/// mount to pick up files that were opened before the webview was ready.
#[tauri::command]
pub fn take_pending_files(state: tauri::State<PendingFiles>) -> Vec<String> {
    let mut buf = state.0.lock().unwrap();
    std::mem::take(&mut *buf)
}

#[cfg(test)]
mod tests {
    use super::cli_arg_to_path;

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
        assert_eq!(cli_arg_to_path(&uri), Some(canonical));

        assert_eq!(cli_arg_to_path("--flag"), None);
        assert_eq!(cli_arg_to_path("mdopener://open?path=%2Fx.md"), None);
        assert_eq!(cli_arg_to_path("file:///no/such/file.md"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
