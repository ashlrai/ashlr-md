//! Default Markdown app handler — check and set Ashlr MD as the system-wide
//! default application for `.md` (and related Markdown) files.
//!
//! # Per-OS strategy
//!
//! ## macOS
//! Uses the `mdopener-setdefault` Swift helper binary which calls
//! `NSWorkspace.setDefaultApplication(at:toOpenContentType:completionHandler:)`.
//! See the binary-protocol section below for the JSON-line wire format.
//!
//! ## Linux
//! Uses `xdg-mime` (from `xdg-utils`) to query and set the default handler for
//! `text/markdown` (and the unofficial `text/x-markdown` alias).  No root
//! privileges are required — `xdg-mime` writes into `~/.config/mimeapps.list`.
//!
//! ASSUMPTION: the Tauri-generated `.desktop` file is named
//! `app.mdopener.desktop.desktop` (Tauri 2 appends `.desktop` to the bundle
//! identifier `app.mdopener.desktop`).  **Integrator: verify this against the
//! actual file in `/usr/share/applications/` after `tauri build` on Linux and
//! update `LINUX_DESKTOP_FILE` if it differs.**
//!
//! ## Windows
//! Win10+ blocks fully-programmatic default-app changes (the shell's UserChoice
//! key is hash-protected).  We take a best-effort two-step approach:
//!   1. Register a ProgID (`AshlrMD.MarkdownFile`) and a `.md` association
//!      under `HKCU\Software\Classes` so the app appears as a candidate.
//!   2. Open the "Default apps" Settings page (`ms-settings:defaultapps`) so
//!      the user can confirm the choice with a single click.
//!
//! `is_default_md_handler` reads
//!   `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice`
//! → `ProgId` and compares it against `WINDOWS_PROG_ID`.
//!
//! # macOS binary protocol
//!
//! ```text
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
//! When running under `cargo tauri dev` the app is *not* bundled — on macOS
//! `bundle_url()` returns `Err`, so `is_default_md_handler` returns `false`
//! and `set_default_md_handler` returns a friendly error.  This is intentional.

// ---------------------------------------------------------------------------
// Imports — platform-gated to avoid unused-import warnings on other targets.
// ---------------------------------------------------------------------------

use serde::Serialize;
use tauri::AppHandle;

// `Manager` is only needed for `app.path()` in the macOS helper-binary lookup.
#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "linux")]
use std::process::Command;

#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;

// ---------------------------------------------------------------------------
// OS-specific constants
// ---------------------------------------------------------------------------

/// Linux: the `.desktop` filename Tauri generates for this app.
///
/// Tauri 2 names the desktop file `<identifier>.desktop` where the identifier
/// comes from `tauri.conf.json` → `identifier`.  With identifier
/// `app.mdopener.desktop`, Tauri appends another `.desktop` suffix, producing
/// `app.mdopener.desktop.desktop`.
///
/// **Integrator: verify against `/usr/share/applications/` after `tauri build`
/// on Linux and update this constant if the actual name differs.**
#[cfg(target_os = "linux")]
const LINUX_DESKTOP_FILE: &str = "app.mdopener.desktop.desktop";

/// Windows: the ProgID registered under `HKCU\Software\Classes`.
#[cfg(target_os = "windows")]
const WINDOWS_PROG_ID: &str = "AshlrMD.MarkdownFile";

// ---------------------------------------------------------------------------
// macOS — Binary discovery + bundle URL
// ---------------------------------------------------------------------------

/// Find the `mdopener-setdefault` binary.  macOS only.
///
/// Search order:
///   1. Tauri resource directory (production `.app` bundle).
///   2. `target/release/` relative to the running binary (dev, after
///      running `build.sh` inside `bins/mdopener-setdefault/`).
///   3. Same directory as the running binary (alternative dev layout).
#[cfg(target_os = "macos")]
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
            // exe is at target/debug/md-opener → parent of parent is target/
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

/// Return the `file://` URL for the running `.app` bundle.  macOS only.
///
/// In a production bundle the exe lives at
/// `Ashlr MD.app/Contents/MacOS/md-opener`, so three `.parent()` calls walk
/// up to the `.app` directory.
///
/// Returns `Err` when running unbundled under `cargo tauri dev`.
#[cfg(target_os = "macos")]
fn bundle_url() -> Result<String, String> {
    let exe =
        std::env::current_exe().map_err(|e| format!("Could not determine executable path: {e}"))?;

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

    Err("App is not running from a .app bundle. \
         Default-handler operations require a built/installed app, not `tauri dev`."
        .to_string())
}

// ---------------------------------------------------------------------------
// Windows — registry helpers  (compiled only on Windows)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod win_reg_helpers {
    //! Thin wrappers around `winreg` for reading/writing HKCU registry keys.

    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    /// Open (or create) a key under HKCU with write access and return it.
    pub fn open_or_create(path: &str) -> Result<RegKey, String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _disp) = hkcu
            .create_subkey(path)
            .map_err(|e| format!("registry create_subkey({path}): {e}"))?;
        Ok(key)
    }

    /// Read a `REG_SZ` value from a HKCU key path.
    /// Returns `None` when the key or value does not exist (not an error).
    pub fn read_sz(key_path: &str, value_name: &str) -> Option<String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu.open_subkey_with_flags(key_path, KEY_READ).ok()?;
        key.get_value::<String, _>(value_name).ok()
    }

    /// Write a `REG_SZ` value; creates the key if it does not exist.
    pub fn write_sz(key_path: &str, value_name: &str, data: &str) -> Result<(), String> {
        let key = open_or_create(key_path)?;
        key.set_value(value_name, &data.to_string())
            .map_err(|e| format!("registry set_value({key_path}\\{value_name}): {e}"))
    }
}

// ---------------------------------------------------------------------------
// Default-handler status — tri-state detection
// ---------------------------------------------------------------------------

/// Tri-state default-handler status returned to the frontend.
///
/// Crucially distinguishes "we could not determine the status" (`Unknown`) from
/// "the app is definitely not the default" (`NotDefault`).  The UI must only
/// prompt the user to set the default when the state is `NotDefault` — showing
/// the prompt on `Unknown` is exactly the bug this struct fixes (the prompt
/// would appear even when the app already is the default but detection failed).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DefaultHandlerStatus {
    /// `"default"` | `"not-default"` | `"unknown"`.
    pub state: String,
    /// Machine-readable reason, e.g. `"ok"`, `"helper-missing"`,
    /// `"dev-unbundled"`, `"unsupported-os-version"`, `"xdg-missing"`,
    /// `"no-user-choice"`, `"parse-failed"`, `"ipc-error"`.
    pub reason: String,
    /// Whether `set_default_md_handler` can plausibly succeed in this
    /// environment.  `false` when the helper is missing or the OS is too old —
    /// the UI should then offer "Show me how" instead of a one-click button.
    pub can_set: bool,
}

impl DefaultHandlerStatus {
    fn is_default() -> Self {
        Self {
            state: "default".to_string(),
            reason: "ok".to_string(),
            can_set: true,
        }
    }

    fn not_default(reason: &str, can_set: bool) -> Self {
        Self {
            state: "not-default".to_string(),
            reason: reason.to_string(),
            can_set,
        }
    }

    fn unknown(reason: &str) -> Self {
        Self {
            state: "unknown".to_string(),
            reason: reason.to_string(),
            can_set: false,
        }
    }
}

/// Tri-state check of whether Ashlr MD is the default `.md` handler.
///
/// Never returns `Err` — every failure shape is mapped to an `Unknown` status
/// with a descriptive `reason` so the frontend can decide what to render.
#[tauri::command]
pub fn default_handler_status(app: AppHandle) -> DefaultHandlerStatus {
    status_impl(app)
}

/// Legacy boolean command, retained for back-compat.  `true` only when the
/// status is definitively `Default`.
#[tauri::command]
pub fn is_default_md_handler(app: AppHandle) -> bool {
    status_impl(app).state == "default"
}

// --- macOS implementation ---

#[cfg(target_os = "macos")]
fn status_impl(app: AppHandle) -> DefaultHandlerStatus {
    let Ok(url) = bundle_url() else {
        // Running unbundled under `tauri dev` — we genuinely cannot tell.
        return DefaultHandlerStatus::unknown("dev-unbundled");
    };

    let Some(bin) = find_helper_binary(&app) else {
        // Helper sidecar absent from the bundle — cannot check or set.
        return DefaultHandlerStatus::unknown("helper-missing");
    };

    let output = match Command::new(&bin).args(["check", &url]).output() {
        Ok(o) => o,
        Err(_) => return DefaultHandlerStatus::unknown("helper-exec-failed"),
    };

    // Parse {"isDefault":true|false} from stdout.
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(b) = v.get("isDefault").and_then(|x| x.as_bool()) {
                return if b {
                    DefaultHandlerStatus::is_default()
                } else {
                    DefaultHandlerStatus::not_default("ok", true)
                };
            }
        }
    }

    // Helper ran but produced no parseable verdict.
    DefaultHandlerStatus::unknown("parse-failed")
}

// --- Linux implementation ---

#[cfg(target_os = "linux")]
fn status_impl(_app: AppHandle) -> DefaultHandlerStatus {
    // `xdg-mime query default text/markdown` prints the .desktop filename
    // (or an empty string when no handler is registered).
    match Command::new("xdg-mime")
        .args(["query", "default", "text/markdown"])
        .output()
    {
        Ok(out) => {
            if !out.status.success() {
                return DefaultHandlerStatus::unknown("xdg-query-failed");
            }
            let current = String::from_utf8_lossy(&out.stdout);
            if current.trim().eq_ignore_ascii_case(LINUX_DESKTOP_FILE) {
                DefaultHandlerStatus::is_default()
            } else {
                DefaultHandlerStatus::not_default("ok", true)
            }
        }
        // xdg-utils not installed — we cannot determine or set the default.
        Err(_) => DefaultHandlerStatus::unknown("xdg-missing"),
    }
}

// --- Windows implementation ---

#[cfg(target_os = "windows")]
fn status_impl(_app: AppHandle) -> DefaultHandlerStatus {
    // Win10+ stores the user's explicit choice in:
    //   HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice
    //   value: ProgId  (REG_SZ)
    //
    // This key only exists after the user has made a manual selection via the
    // Settings UI; if absent, the system default applies (= not us).  Either
    // way we *can* attempt a set, so `can_set` stays true.
    let prog_id = win_reg_helpers::read_sz(
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice",
        "ProgId",
    );

    match prog_id {
        Some(id) if id.eq_ignore_ascii_case(WINDOWS_PROG_ID) => DefaultHandlerStatus::is_default(),
        Some(_) => DefaultHandlerStatus::not_default("other-app", true),
        None => DefaultHandlerStatus::not_default("no-user-choice", true),
    }
}

// ---------------------------------------------------------------------------
// Tauri command — set_default_md_handler
// ---------------------------------------------------------------------------

/// Registers Ashlr MD as the default application for Markdown files
/// (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`).
///
/// See module-level doc for the per-OS strategy.
///
/// # Errors
///
/// Returns a human-readable `Err` string when the operation fails hard.
/// On Windows the call always returns `Ok` because the registry write is
/// best-effort and the Settings page is opened for the user to confirm.
#[tauri::command]
pub fn set_default_md_handler(app: AppHandle) -> Result<(), String> {
    set_default_impl(app)
}

// --- macOS implementation ---

#[cfg(target_os = "macos")]
fn set_default_impl(app: AppHandle) -> Result<(), String> {
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

// --- Linux implementation ---

#[cfg(target_os = "linux")]
fn set_default_impl(_app: AppHandle) -> Result<(), String> {
    // Register our .desktop file for both the canonical MIME type and the
    // common unofficial alias.  `xdg-mime` writes to ~/.config/mimeapps.list
    // — no root privileges required.
    for mime in &["text/markdown", "text/x-markdown"] {
        let status = Command::new("xdg-mime")
            .args(["default", LINUX_DESKTOP_FILE, mime])
            .status()
            .map_err(|e| {
                format!(
                    "Failed to run `xdg-mime default {LINUX_DESKTOP_FILE} {mime}`: {e}. \
                     Ensure `xdg-utils` is installed \
                     (apt install xdg-utils / dnf install xdg-utils)."
                )
            })?;

        if !status.success() {
            return Err(format!(
                "`xdg-mime default {LINUX_DESKTOP_FILE} {mime}` exited with status {}.",
                status.code().unwrap_or(-1)
            ));
        }
    }

    Ok(())
}

// --- Windows implementation ---

#[cfg(target_os = "windows")]
fn set_default_impl(app: AppHandle) -> Result<(), String> {
    // Step 1 — Register our ProgID and the .md association under
    // HKCU\Software\Classes.  Best-effort: Win10+ UserChoice will still
    // override us in the shell, but this makes the app appear as a candidate
    // in "Choose another app" dialogs and for programmatic file-open calls.
    register_windows_prog_id()?;

    // Step 2 — Open the "Default apps" Settings page so the user can confirm
    // with a single click.  Done after the registry write so we appear in the list.
    open_windows_default_apps_page(&app);

    Ok(())
}

/// Write the ProgID entries and `.md` → ProgID pointer under `HKCU\Software\Classes`.
#[cfg(target_os = "windows")]
fn register_windows_prog_id() -> Result<(), String> {
    let exe =
        std::env::current_exe().map_err(|e| format!("Could not determine executable path: {e}"))?;
    let exe_str = exe
        .to_str()
        .ok_or("Executable path contains non-UTF-8 characters")?;

    // HKCU\Software\Classes\AshlrMD.MarkdownFile  (default) = "Ashlr MD Markdown File"
    win_reg_helpers::write_sz(
        &format!(r"Software\Classes\{WINDOWS_PROG_ID}"),
        "",
        "Ashlr MD Markdown File",
    )?;

    // Default icon: first icon resource in the exe.
    win_reg_helpers::write_sz(
        &format!(r"Software\Classes\{WINDOWS_PROG_ID}\DefaultIcon"),
        "",
        &format!("{exe_str},0"),
    )?;

    // Open verb — routes through the deep-link scheme so the running instance
    // receives the file path rather than spawning a second process.
    // %1 is substituted by the shell with the target file path.
    win_reg_helpers::write_sz(
        &format!(r"Software\Classes\{WINDOWS_PROG_ID}\shell\open\command"),
        "",
        &format!(r#"cmd /C start "" "mdopener://open?path=%1""#),
    )?;

    // Point .md at our ProgID.  The shell prefers UserChoice when present, but
    // this acts as a fallback and populates the "Choose another app" list.
    win_reg_helpers::write_sz(r"Software\Classes\.md", "", WINDOWS_PROG_ID)?;

    Ok(())
}

/// Open `ms-settings:defaultapps` (Windows 10+ Settings deep-link).
/// Best-effort — logs to stderr on failure but never panics or propagates Err.
#[cfg(target_os = "windows")]
fn open_windows_default_apps_page(app: &AppHandle) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app
        .opener()
        .open_url("ms-settings:defaultapps", None::<&str>)
    {
        eprintln!("[default_handler] Could not open ms-settings:defaultapps: {e}");
    }
}

// ---------------------------------------------------------------------------
// Tauri command — open_default_apps_help
// ---------------------------------------------------------------------------

/// Opens the most useful system UI for manually confirming a default-app choice.
///
/// Intentionally infallible from the frontend's perspective — on failure it
/// returns a human-readable instruction string as `Err` so the UI can surface
/// it as a help message.
#[tauri::command]
pub fn open_default_apps_help(app: AppHandle) -> Result<(), String> {
    open_default_apps_help_impl(app)
}

// --- macOS implementation ---

#[cfg(target_os = "macos")]
fn open_default_apps_help_impl(app: AppHandle) -> Result<(), String> {
    // macOS 13+ System Settings deep-link.
    let deep_link = "x-apple.systempreferences:com.apple.preference.general";
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(deep_link, None::<&str>).map_err(|e| {
        format!(
            "Could not open System Settings ({e}). \
                 To set Ashlr MD as default: right-click any .md file in Finder → \
                 Get Info → Open With → select Ashlr MD → Change All."
        )
    })
}

// --- Linux implementation ---

#[cfg(target_os = "linux")]
fn open_default_apps_help_impl(_app: AppHandle) -> Result<(), String> {
    // There is no single universal "Default apps" panel on Linux.  The
    // xdg-mime commands issued by set_default_md_handler are the canonical
    // method.  Return an instructional message for the UI to display.
    Err(format!(
        "To set Ashlr MD as the default Markdown viewer on Linux, run:\n\
         \n  xdg-mime default {LINUX_DESKTOP_FILE} text/markdown\
         \n  xdg-mime default {LINUX_DESKTOP_FILE} text/x-markdown\
         \n\nOr use your desktop environment's \"Default Applications\" panel \
         (GNOME Settings → Default Applications, \
         KDE System Settings → Applications → File Associations)."
    ))
}

// --- Windows implementation ---

#[cfg(target_os = "windows")]
fn open_default_apps_help_impl(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("ms-settings:defaultapps", None::<&str>)
        .map_err(|e| {
            format!(
                "Could not open Default apps settings ({e}). \
                 To set Ashlr MD manually: Settings → Apps → Default apps → \
                 search for \".md\" → choose Ashlr MD."
            )
        })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::DefaultHandlerStatus;

    #[test]
    fn default_status_serializes_camel_case() {
        let s = DefaultHandlerStatus::is_default();
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"state\":\"default\""));
        assert!(json.contains("\"canSet\":true"));
        assert!(json.contains("\"reason\":\"ok\""));
    }

    #[test]
    fn not_default_carries_reason_and_can_set() {
        let s = DefaultHandlerStatus::not_default("no-user-choice", true);
        assert_eq!(s.state, "not-default");
        assert_eq!(s.reason, "no-user-choice");
        assert!(s.can_set);
    }

    #[test]
    fn unknown_is_never_settable() {
        let s = DefaultHandlerStatus::unknown("helper-missing");
        assert_eq!(s.state, "unknown");
        assert!(!s.can_set);
        // The UI keys off `state == "not-default"` to show the prompt, so
        // `unknown` must never be mistaken for a definitive not-default.
        assert_ne!(s.state, "not-default");
    }
}
