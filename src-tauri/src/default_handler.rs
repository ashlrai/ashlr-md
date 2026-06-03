//! Default Markdown app handler — check and set Ashlr MD as the system-wide
//! default application for `.md` (and related Markdown) files.
//!
//! # Approach: Swift helper binary (`mdopener-setdefault`)
//!
//! We use a Swift helper binary rather than the `objc2` crates because:
//!   - The required API (`NSWorkspace.setDefaultApplication(at:toOpenContentType:)`)
//!     lives in AppKit and takes an `async completionHandler:` closure that
//!     drives through a CFRunLoop — mapping that to Rust with objc2 would require
//!     careful raw-pointer bridging and runtime loop management that is fragile
//!     across SDK generations.
//!   - This project already has a proven Swift-sidecar pattern (`mdopener-afm`)
//!     so the toolchain, build script shape, and binary-discovery logic are
//!     well-established. The helper is tiny (< 100 LOC) and has zero external deps.
//!   - The helper is short-lived (one invocation per check/set), so there is no
//!     IPC complexity.
//!
//! # Binary protocol
//!
//! The helper accepts two commands, each printing one JSON line to stdout and
//! exiting 0 on success, 1 on hard failure:
//!
//! ```
//! mdopener-setdefault check <file://…bundle.app>
//!   → {"isDefault":true|false}
//!
//! mdopener-setdefault set <file://…bundle.app>
//!   → {"ok":true}                       (success)
//!   → {"ok":true,"warnings":["…"]}      (partial success; primary ext was set)
//!   → {"ok":false,"error":"…"}          (graceful failure, e.g. macOS < 12)
//! ```
//!
//! # Dev-mode note
//!
//! When running under `cargo tauri dev` the app is *not* bundled — it runs from
//! `target/debug/md-opener` with no `.app` wrapper.  In that case
//! `bundle_url()` returns an error and both `is_default_md_handler` returns
//! `false` and `set_default_md_handler` returns a friendly error string.
//! This is intentional and expected.

use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

/// Find the `mdopener-setdefault` binary.
///
/// Search order:
///   1. Tauri resource directory (production `.app` bundle).
///   2. `target/release/` relative to the running binary (dev: after running
///      `build.sh` inside `bins/mdopener-setdefault/`).
///   3. Same directory as the running binary (alternative dev layout).
fn find_helper_binary(app: &AppHandle) -> Option<PathBuf> {
    const BIN: &str = "mdopener-setdefault";

    // 1. Production bundle resources.
    if let Ok(res_dir) = app.path().resource_dir() {
        let c = res_dir.join(BIN);
        if c.exists() {
            return Some(c);
        }
    }

    // 2. target/release/ (after running build.sh in dev).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(target_dir) = exe.parent().and_then(|p| p.parent()) {
            // exe is at target/debug/md-opener → sibling is target/release/
            let c = target_dir.join("release").join(BIN);
            if c.exists() {
                return Some(c);
            }
        }
        // 3. Same dir as executable (tauri release mode puts sidecars here).
        if let Some(dir) = exe.parent() {
            let c = dir.join(BIN);
            if c.exists() {
                return Some(c);
            }
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Bundle URL resolution
// ---------------------------------------------------------------------------

/// Return the `file://` URL string for the running app's `.app` bundle.
///
/// In a production bundle the executable lives at
/// `Ashlr MD.app/Contents/MacOS/md-opener`, so three `.parent()` calls walk up
/// to the `.app` directory.
///
/// In `tauri dev` mode the executable is `target/debug/md-opener` — there is no
/// `.app` wrapper — so this function returns an `Err`.
fn bundle_url() -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Could not determine executable path: {e}"))?;

    // Production: exe → MacOS/ → Contents/ → Foo.app/
    if let Some(macos_dir) = exe.parent() {
        if let Some(contents_dir) = macos_dir.parent() {
            if let Some(app_dir) = contents_dir.parent() {
                // Confirm it looks like a .app bundle.
                if app_dir
                    .extension()
                    .map(|e| e.eq_ignore_ascii_case("app"))
                    .unwrap_or(false)
                {
                    let url = format!("file://{}", app_dir.display());
                    return Ok(url);
                }
            }
        }
    }

    Err(
        "App is not running from a .app bundle. \
         Default-handler operations require a built/installed app, not `tauri dev`."
            .to_string(),
    )
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Returns `true` when Ashlr MD is already the default app for `.md` files.
///
/// Returns `false` (not an error) in all failure cases so the frontend can
/// always render a meaningful UI regardless of environment.
#[tauri::command]
pub fn is_default_md_handler(app: AppHandle) -> bool {
    let Ok(url) = bundle_url() else {
        // Not bundled (dev mode) — report not-default silently.
        return false;
    };

    let Some(bin) = find_helper_binary(&app) else {
        // Helper not built yet — treat as not-default; no panic.
        return false;
    };

    let output = match Command::new(&bin).args(["check", &url]).output() {
        Ok(o) => o,
        Err(_) => return false,
    };

    // Parse {"isDefault":true|false} from stdout.
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(b) = v.get("isDefault").and_then(|x| x.as_bool()) {
                return b;
            }
        }
    }

    false
}

/// Registers Ashlr MD as the default application for Markdown files
/// (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`).
///
/// Uses the `mdopener-setdefault` Swift helper which calls
/// `NSWorkspace.setDefaultApplication(at:toOpenContentType:completionHandler:)`.
///
/// # Errors
///
/// Returns a human-readable `Err` string when:
///   - The app is running unbundled (`tauri dev`).
///   - The helper binary hasn't been built yet.
///   - The helper exits with a non-zero code.
///   - macOS 12 is not available (the helper degrades gracefully in that case
///     and we surface the error message from its JSON output).
#[tauri::command]
pub fn set_default_md_handler(app: AppHandle) -> Result<(), String> {
    let url = bundle_url()?;

    let bin = find_helper_binary(&app).ok_or_else(|| {
        "mdopener-setdefault binary not found. \
         Run: src-tauri/bins/mdopener-setdefault/build.sh"
            .to_string()
    })?;

    let output = Command::new(&bin)
        .args(["set", &url])
        .output()
        .map_err(|e| format!("Failed to run mdopener-setdefault: {e}"))?;

    // Parse the JSON response for graceful-failure messages.
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            // Graceful failure: helper exited 0 but reported ok:false.
            if v.get("ok").and_then(|x| x.as_bool()) == Some(false) {
                let msg = v
                    .get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("Could not set default app")
                    .to_string();
                return Err(msg);
            }
        }
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "mdopener-setdefault exited with status {}. {}",
            output.status,
            stderr.trim()
        ));
    }

    Ok(())
}

/// Opens the most useful system UI for manually setting a default app.
///
/// Falls back gracefully when the Tauri opener fails.  This command is
/// intentionally infallible from the frontend's perspective.
#[tauri::command]
pub fn open_default_apps_help(app: AppHandle) -> Result<(), String> {
    // On macOS the canonical UI is Finder "Get Info" on any .md file, or the
    // "Open With" sheet.  We open a System Settings deep-link that shows the
    // default app preferences; this works on macOS 13+.
    //
    // We try two URLs in order: the modern System Settings deep-link, then
    // a generic Finder fallback.
    let deep_link = "x-apple.systempreferences:com.apple.preference.general";

    // Use Tauri's opener plugin to open the URL.
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(deep_link, None::<&str>)
        .map_err(|e| {
            format!(
                "Could not open System Settings ({e}). \
                 To set Ashlr MD as default: right-click any .md file in Finder → \
                 Get Info → Open With → select Ashlr MD → Change All."
            )
        })
}
