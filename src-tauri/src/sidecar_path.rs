//! Sidecar path lookup only; this module never launches a sidecar.
//!
//! The platform bundle overlays declare each sidecar under its on-disk file
//! name: `mdopener-mcp` on macOS/Linux, `mdopener-mcp.exe` on Windows
//! (`tauri.windows.conf.json`). Lookups must use that same file name.

use std::path::{Path, PathBuf};

/// On-disk file name of a sidecar for the host OS (`.exe` on Windows).
pub(crate) fn sidecar_file_name(bin: &str) -> String {
    file_name_for(bin, std::env::consts::EXE_SUFFIX)
}

fn file_name_for(bin: &str, exe_suffix: &str) -> String {
    format!("{bin}{exe_suffix}")
}

/// Resolve the absolute path to a bundled sidecar binary by name (e.g.
/// `mdopener-mcp`, `mdopen`), adding the host's executable suffix.
///
/// Search order:
///   1. Next to the running executable (Windows installs, where the `"./"`
///      resource target lands beside the app binary, and dev builds).
///   2. The Tauri resource directory (`Contents/Resources` in the macOS app,
///      `/usr/lib/Ashlr MD` for the Linux `.deb`).
///   3. `target/release/` in an ancestor of the executable (local
///      `cargo build --release` without `tauri build`).
pub(crate) fn resolve(
    bin: &str,
    exe_dir: &Path,
    resource_dir: Option<&Path>,
) -> Result<String, String> {
    resolve_file(&sidecar_file_name(bin), exe_dir, resource_dir)
}

fn resolve_file(
    file_name: &str,
    exe_dir: &Path,
    resource_dir: Option<&Path>,
) -> Result<String, String> {
    let mut candidates: Vec<PathBuf> = vec![exe_dir.join(file_name)];

    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join(file_name));
    }

    let mut dir = exe_dir.to_path_buf();
    for _ in 0..8 {
        let candidate = dir.join("target").join("release").join(file_name);
        if candidate.exists() {
            candidates.push(candidate);
            break;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }

    for candidate in &candidates {
        if candidate.exists() {
            return candidate
                .to_str()
                .map(|s| s.to_owned())
                .ok_or_else(|| format!("{file_name} path contains non-UTF-8 characters"));
        }
    }

    Err(format!(
        "{file_name} binary not found. Searched:\n{}",
        candidates
            .iter()
            .map(|p| format!("  • {}", p.display()))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

/// Typical install path shown in the manual copy command when the MCP binary
/// cannot be resolved. It is a placeholder for the host OS, not a found file:
/// the macOS app bundle, the Windows per-user (NSIS) install directory, or
/// the Linux `.deb` layout. MSI, AppImage, and custom installs differ.
pub(crate) fn unresolved_mcp_placeholder() -> String {
    placeholder_for(
        std::env::consts::OS,
        std::env::var("LOCALAPPDATA").ok().as_deref(),
    )
}

fn placeholder_for(os: &str, local_app_data: Option<&str>) -> String {
    match os {
        "macos" => "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp".to_string(),
        "windows" => {
            let base = local_app_data
                .map(|dir| dir.trim_end_matches('\\'))
                .filter(|dir| !dir.is_empty())
                .unwrap_or("C:\\Users\\<you>\\AppData\\Local");
            format!(
                "{base}\\Ashlr MD\\{}",
                file_name_for("mdopener-mcp", ".exe")
            )
        }
        _ => "/usr/lib/Ashlr MD/mdopener-mcp".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Empty scratch directory with synthetic, non-executable fixture files.
    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("md-sidecar-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Fixture(dir)
        }

        fn file(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "synthetic fixture; never executable").unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn windows_file_name_adds_exe_and_unix_name_is_unchanged() {
        assert_eq!(file_name_for("mdopener-mcp", ".exe"), "mdopener-mcp.exe");
        assert_eq!(file_name_for("mdopen", ".exe"), "mdopen.exe");
        assert_eq!(file_name_for("mdopener-mcp", ""), "mdopener-mcp");
    }

    #[test]
    fn host_file_name_uses_host_exe_suffix() {
        assert_eq!(
            sidecar_file_name("mdopener-mcp"),
            format!("mdopener-mcp{}", std::env::consts::EXE_SUFFIX)
        );
    }

    #[test]
    fn windows_install_layout_resolves_exe_beside_app() {
        // Windows installs put "./" resources in the install root with the app.
        let fx = Fixture::new("win-install");
        let install = fx.0.join("Ashlr MD");
        let mcp = fx.file("Ashlr MD/mdopener-mcp.exe");
        fx.file("Ashlr MD/md-opener.exe");

        let exe_name = file_name_for("mdopener-mcp", ".exe");
        assert_eq!(
            resolve_file(&exe_name, &install, Some(&install)).unwrap(),
            mcp.to_str().unwrap()
        );

        // The suffixless name the resolver used before never matches there.
        let err = resolve_file("mdopener-mcp", &install, Some(&install)).unwrap_err();
        assert!(err.starts_with("mdopener-mcp binary not found."), "{err}");
    }

    #[test]
    fn resource_dir_is_searched_when_not_beside_executable() {
        let fx = Fixture::new("resources");
        let exe_dir = fx.0.join("Ashlr MD.app/Contents/MacOS");
        fs::create_dir_all(&exe_dir).unwrap();
        let resources = fx.0.join("Ashlr MD.app/Contents/Resources");
        let mcp = fx.file("Ashlr MD.app/Contents/Resources/mdopener-mcp");

        assert_eq!(
            resolve_file("mdopener-mcp", &exe_dir, Some(&resources)).unwrap(),
            mcp.to_str().unwrap()
        );
    }

    #[test]
    fn executable_dir_wins_over_resource_dir() {
        let fx = Fixture::new("order");
        let beside = fx.file("app/mdopener-mcp.exe");
        fx.file("res/mdopener-mcp.exe");

        let found = resolve_file(
            "mdopener-mcp.exe",
            &fx.0.join("app"),
            Some(&fx.0.join("res")),
        )
        .unwrap();
        assert_eq!(found, beside.to_str().unwrap());
    }

    #[test]
    fn local_release_build_is_found_from_a_debug_executable() {
        let fx = Fixture::new("dev");
        let exe_dir = fx.0.join("src-tauri/target/debug");
        fs::create_dir_all(&exe_dir).unwrap();
        let release = fx.file("src-tauri/target/release/mdopener-mcp.exe");

        assert_eq!(
            resolve_file("mdopener-mcp.exe", &exe_dir, None).unwrap(),
            release.to_str().unwrap()
        );
    }

    #[test]
    fn missing_binary_lists_suffixed_candidates() {
        let fx = Fixture::new("missing");
        let err = resolve_file(
            "mdopener-mcp.exe",
            &fx.0.join("app"),
            Some(&fx.0.join("res")),
        )
        .unwrap_err();
        assert!(
            err.starts_with("mdopener-mcp.exe binary not found. Searched:\n"),
            "{err}"
        );
        assert!(
            err.contains(
                &fx.0
                    .join("app")
                    .join("mdopener-mcp.exe")
                    .display()
                    .to_string()
            ),
            "{err}"
        );
        assert!(
            err.contains(
                &fx.0
                    .join("res")
                    .join("mdopener-mcp.exe")
                    .display()
                    .to_string()
            ),
            "{err}"
        );
    }

    #[test]
    fn lookup_names_match_each_declared_platform_resource_map() {
        let overlays = [
            (include_str!("../tauri.windows.conf.json"), ".exe"),
            (include_str!("../tauri.macos.conf.json"), ""),
            (include_str!("../tauri.linux.conf.json"), ""),
        ];
        for (config, suffix) in overlays {
            for bin in ["mdopen", "mdopener-mcp"] {
                let entry = format!("\"target/release/{}\": \"./\"", file_name_for(bin, suffix));
                assert!(config.contains(&entry), "missing {entry}");
            }
        }
        let windows = include_str!("../tauri.windows.conf.json");
        assert!(!windows.contains("\"target/release/mdopener-mcp\":"));
        assert!(!windows.contains("\"target/release/mdopen\":"));
    }

    #[test]
    fn unresolved_placeholder_matches_the_host_platform() {
        assert_eq!(
            placeholder_for("macos", None),
            "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp"
        );
        assert_eq!(
            placeholder_for("windows", Some("C:\\Users\\O'Brien\\AppData\\Local\\")),
            "C:\\Users\\O'Brien\\AppData\\Local\\Ashlr MD\\mdopener-mcp.exe"
        );
        assert_eq!(
            placeholder_for("windows", None),
            "C:\\Users\\<you>\\AppData\\Local\\Ashlr MD\\mdopener-mcp.exe"
        );
        assert_eq!(
            placeholder_for("linux", None),
            "/usr/lib/Ashlr MD/mdopener-mcp"
        );
    }
}
