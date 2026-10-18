//! Install the `mdopen` CLI helper into a standard system PATH location.
//!
//! On macOS/Linux the command tries `/usr/local/bin` first (writable on
//! developer machines), and falls back to `~/.local/bin` (always writable, XDG
//! convention), creating a symlink to the bundled sidecar. On Windows it copies
//! `mdopen.exe` into `~/.local/bin`, which the user must add to `PATH`.
//!
//! The **Install mdopen** button in Preferences (Command-line tool section,
//! `src/components/settings/sections/CliSection.tsx`) calls it:
//! ```ts
//! import { invoke } from "@tauri-apps/api/core";
//! const path = await invoke<string>("install_cli");
//! ```

use std::path::{Path, PathBuf};

use crate::agent_setup::{resolve_sidecar_binary, sidecar_file_name};

/// Attempt to install the `mdopen` sidecar as a CLI tool on `$PATH`.
///
/// Returns the absolute path where the binary was linked/copied on success.
#[tauri::command]
pub fn install_cli(app: tauri::AppHandle) -> Result<String, String> {
    // Same lookup as Settings' agent setup, so Windows finds `mdopen.exe`.
    let sidecar_path = PathBuf::from(resolve_sidecar_binary(&app, "mdopen")?);
    let file_name = sidecar_file_name("mdopen");

    for &dir_str in install_dirs(cfg!(windows)) {
        let dir = expand_tilde(dir_str);
        match try_install(&sidecar_path, &dir, &file_name) {
            Ok(dest) => return Ok(dest.to_string_lossy().into_owned()),
            Err(_) => continue,
        }
    }

    Err(if cfg!(windows) {
        "Could not install mdopen: ~/.local/bin is not writable.".to_string()
    } else {
        "Could not install mdopen: neither /usr/local/bin nor ~/.local/bin is writable. \
         Try: sudo cp \"$(path to sidecar)\" /usr/local/bin/mdopen"
            .to_string()
    })
}

/// Candidate install directories, in preference order. `/usr/local/bin` is a
/// Unix location; on Windows it would resolve to `\usr\local\bin` on the
/// current drive, so only the per-user `~/.local/bin` is tried there. Neither
/// is on a stock Windows `PATH`.
fn install_dirs(windows: bool) -> &'static [&'static str] {
    if windows {
        &["~/.local/bin"]
    } else {
        &["/usr/local/bin", "~/.local/bin"]
    }
}

/// Attempt to create a symlink (preferred) or copy the binary into `dir` as
/// `file_name` (`mdopen`, or `mdopen.exe` on Windows).
fn try_install(src: &Path, dir: &Path, file_name: &str) -> Result<PathBuf, std::io::Error> {
    std::fs::create_dir_all(dir)?;

    let dest = dir.join(file_name);

    // Remove a stale symlink or binary first (idempotent).
    if dest.exists() || dest.symlink_metadata().is_ok() {
        std::fs::remove_file(&dest)?;
    }

    // Prefer symlinks: the sidecar is updated in-place when the app updates.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, &dest)?;
    }
    #[cfg(not(unix))]
    {
        std::fs::copy(src, &dest)?;
    }

    Ok(dest)
}

/// Expand a leading `~` to the user's home directory.
fn expand_tilde(s: &str) -> PathBuf {
    if let Some(rest) = s.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn windows_skips_the_unix_system_dir() {
        assert_eq!(install_dirs(true), ["~/.local/bin"]);
        assert_eq!(install_dirs(false), ["/usr/local/bin", "~/.local/bin"]);
    }

    #[test]
    fn install_uses_the_given_file_name_and_replaces_a_stale_entry() {
        let root = std::env::temp_dir().join(format!("md-cli-install-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let src = root.join("app/mdopen.exe");
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        fs::write(&src, "synthetic fixture; never executed").unwrap();
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("mdopen.exe"), "stale").unwrap();

        let dest = try_install(&src, &bin, "mdopen.exe").unwrap();
        assert_eq!(dest, bin.join("mdopen.exe"));
        assert_eq!(
            fs::read_to_string(&dest).unwrap(),
            "synthetic fixture; never executed"
        );
        assert!(!bin.join("mdopen").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
