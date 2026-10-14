//! `PATH` lookup for agent CLIs; this module never launches what it finds.
//!
//! Replaces shelling out to `which`, which stock Windows does not provide.
//! Windows resolves a bare command name through `PATHEXT` (`claude.exe` from
//! the native installer, `claude.cmd` / `codex.cmd` from npm), so the lookup
//! tries each listed extension; Unix needs a file with an execute bit.

use std::path::{Path, PathBuf};

/// `PATHEXT` default when the variable is unset (the documented Windows value
/// for executable script and binary types).
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// Absolute path of the first `name` on the host `PATH`, the way the host
/// shell would resolve the bare command, or `None` if absent.
pub(crate) fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions = if cfg!(windows) {
        windows_extensions(std::env::var("PATHEXT").ok().as_deref())
    } else {
        vec![String::new()]
    };
    find_in(name, std::env::split_paths(&path), &extensions, is_runnable)
}

/// Extensions to try on Windows, in `PATHEXT` order, lowercased (Windows file
/// names are case-insensitive). A bare, extensionless file is never a match
/// there: Windows cannot launch one.
fn windows_extensions(pathext: Option<&str>) -> Vec<String> {
    let listed = pathext
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(DEFAULT_PATHEXT);
    listed
        .split(';')
        .map(str::trim)
        .filter(|ext| ext.starts_with('.') && ext.len() > 1)
        .map(str::to_ascii_lowercase)
        .collect()
}

/// Directory-major search: every extension in one directory is tried before
/// the next directory, matching how Windows and POSIX shells order `PATH`.
/// Empty entries are skipped rather than read as the current directory.
fn find_in(
    name: &str,
    dirs: impl IntoIterator<Item = PathBuf>,
    extensions: &[String],
    runnable: fn(&Path) -> bool,
) -> Option<PathBuf> {
    if name.is_empty() || Path::new(name).components().count() != 1 {
        return None;
    }
    dirs.into_iter()
        .filter(|dir| !dir.as_os_str().is_empty() && dir.is_absolute())
        .flat_map(|dir| {
            extensions
                .iter()
                .map(move |ext| dir.join(format!("{name}{ext}")))
        })
        .find(|candidate| runnable(candidate))
}

#[cfg(unix)]
fn is_runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_runnable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Empty scratch directory with synthetic, never-executed fixture files.
    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("md-path-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Fixture(dir)
        }

        fn file(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "synthetic fixture; never executed").unwrap();
            path
        }

        fn dir(&self, relative: &str) -> PathBuf {
            self.0.join(relative)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn exists(path: &Path) -> bool {
        path.is_file()
    }

    fn exts(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pathext_defaults_and_ignores_malformed_entries() {
        assert_eq!(
            windows_extensions(None),
            exts(&[".com", ".exe", ".bat", ".cmd"])
        );
        assert_eq!(windows_extensions(Some("  ")), windows_extensions(None));
        assert_eq!(
            windows_extensions(Some(".EXE;;CMD; .Cmd ;.")),
            exts(&[".exe", ".cmd"])
        );
    }

    #[test]
    fn windows_npm_shim_is_found_by_pathext() {
        // npm installs `claude.cmd` / `codex.cmd`; there is no bare `claude`.
        let fx = Fixture::new("npm-shim");
        let shim = fx.file("npm/codex.cmd");
        fx.file("npm/codex"); // npm's POSIX shim, unlaunchable on Windows
        let found = find_in("codex", [fx.dir("npm")], &windows_extensions(None), exists);
        assert_eq!(found, Some(shim));
    }

    #[test]
    fn windows_native_exe_beats_a_later_directory_and_earlier_dir_wins() {
        let fx = Fixture::new("order");
        let native = fx.file("first/claude.exe");
        fx.file("second/claude.cmd");
        let windows = windows_extensions(None);
        assert_eq!(
            find_in(
                "claude",
                [fx.dir("first"), fx.dir("second")],
                &windows,
                exists
            ),
            Some(native)
        );
        // Within one directory, PATHEXT order decides.
        let both = fx.file("both/claude.cmd");
        fx.file("both/claude.exe");
        assert_eq!(
            find_in(
                "claude",
                [fx.dir("both")],
                &windows_extensions(Some(".CMD;.EXE")),
                exists
            ),
            Some(both)
        );
    }

    #[test]
    fn missing_tool_empty_and_relative_entries_return_none() {
        let fx = Fixture::new("missing");
        fx.file("cwd/claude");
        let unix = exts(&[""]);
        assert_eq!(find_in("claude", [fx.dir("empty")], &unix, exists), None);
        assert_eq!(
            find_in(
                "claude",
                [PathBuf::new(), PathBuf::from("cwd")],
                &unix,
                exists
            ),
            None
        );
    }

    #[test]
    fn names_with_separators_are_not_searched() {
        let fx = Fixture::new("names");
        fx.file("bin/claude");
        let unix = exts(&[""]);
        assert_eq!(find_in("", [fx.dir("bin")], &unix, exists), None);
        assert_eq!(
            find_in("../bin/claude", [fx.dir("bin")], &unix, exists),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_requires_an_execute_bit() {
        use std::os::unix::fs::PermissionsExt;
        let fx = Fixture::new("unix");
        let plain = fx.file("a/claude");
        let runnable = fx.file("b/claude");
        fs::set_permissions(&plain, fs::Permissions::from_mode(0o644)).unwrap();
        fs::set_permissions(&runnable, fs::Permissions::from_mode(0o755)).unwrap();
        // Permission bits only; the fixture is never executed.
        assert_eq!(
            find_in(
                "claude",
                [fx.dir("a"), fx.dir("b")],
                &exts(&[""]),
                is_runnable
            ),
            Some(runnable)
        );
        assert!(!is_runnable(&fx.dir("a")));
    }
}
