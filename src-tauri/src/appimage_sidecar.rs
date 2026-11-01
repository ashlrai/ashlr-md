//! Stable copies of the sidecars for an AppImage.
//!
//! An AppImage mounts itself at a new `/tmp/.mount_*` directory on every
//! launch and unmounts when it quits, so the bundled `mdopener-mcp` and
//! `mdopen` (Tauri's resource dir, inside that mount) are gone once the app
//! closes. When running as an AppImage on Linux (the AppImage runtime sets
//! `$APPIMAGE`), the agent setup buttons register a copy kept in the app's
//! local data dir instead, rewritten whenever the app's version or the
//! bundled binary's size differs from what the copy was made from.
//!
//! The copies do not go in `~/.local/bin`, where **Install mdopen** links
//! `mdopen`: that link points at the copy, and a copy in the same place would
//! be the link itself.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

/// Where a sidecar the agent setup registers comes from.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SidecarPlan {
    /// Register the bundled binary where it is (not an AppImage).
    InPlace,
    /// Register `dest`, a copy outside the AppImage's mount. `copy` says
    /// whether it must be (re)written from the bundled binary first, after
    /// which `stamp` is written to `stamp_path`.
    Stable {
        dest: PathBuf,
        stamp_path: PathBuf,
        stamp: String,
        copy: bool,
    },
}

/// The stamp recorded beside a copy: the app version and the bundled
/// binary's size, so an AppImage update (or a rebuild at the same version)
/// refreshes it.
pub(crate) fn stamp_for(version: &str, bundled_len: u64) -> String {
    format!("{version} {bundled_len}")
}

/// Decide how to register the bundled sidecar at `bundled`.
///
/// `os` is `std::env::consts::OS` and `appimage` the value of `$APPIMAGE`;
/// only a non-empty `$APPIMAGE` on Linux uses a copy. `stable_dir` is where
/// copies live (`None` when the data dir is unknown, which keeps the bundled
/// path). `stamp` is [`stamp_for`] the running app, `recorded` the stamp read
/// beside an existing copy, and `dest_exists` whether that copy is on disk.
pub(crate) fn plan(
    os: &str,
    appimage: Option<&OsStr>,
    bundled: &Path,
    stable_dir: Option<&Path>,
    stamp: &str,
    recorded: Option<&str>,
    dest_exists: bool,
) -> SidecarPlan {
    let in_appimage = os == "linux" && appimage.is_some_and(|a| !a.is_empty());
    let (Some(dir), Some(name)) = (stable_dir.filter(|_| in_appimage), bundled.file_name()) else {
        return SidecarPlan::InPlace;
    };
    if bundled.parent() == Some(dir) {
        return SidecarPlan::InPlace;
    }
    let (dest, stamp_path) = stable_paths(dir, name);
    SidecarPlan::Stable {
        stamp_path,
        copy: !dest_exists || recorded.map(str::trim) != Some(stamp),
        stamp: stamp.to_string(),
        dest,
    }
}

/// The copy of the sidecar file `name` in `dir`, and the stamp beside it.
pub(crate) fn stable_paths(dir: &Path, name: &OsStr) -> (PathBuf, PathBuf) {
    let mut stamp_name = name.to_os_string();
    stamp_name.push(".version");
    (dir.join(name), dir.join(stamp_name))
}

/// Carry out `plan` for `bundled` and return the path to register.
///
/// The copy is written beside its destination and renamed over it, so an
/// `mdopener-mcp` an agent is running from the old copy keeps working (on
/// Linux a running executable cannot be written in place).
pub(crate) fn apply(bundled: &Path, plan: SidecarPlan) -> Result<PathBuf, String> {
    let SidecarPlan::Stable {
        dest,
        stamp_path,
        stamp,
        copy,
    } = plan
    else {
        return Ok(bundled.to_path_buf());
    };
    if copy {
        copy_out(bundled, &dest, &stamp_path, &stamp).map_err(|e| {
            format!(
                "Could not copy {} out of the AppImage to {}: {e}. Free up space or fix \
                 that folder's permissions and try again, or follow the AppImage steps \
                 in docs/AGENTS.md.",
                bundled.display(),
                dest.display()
            )
        })?;
    }
    Ok(dest)
}

fn copy_out(bundled: &Path, dest: &Path, stamp_path: &Path, stamp: &str) -> std::io::Result<()> {
    let dir = dest.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    // Exclusive creation prevents a stale file or symlink from being followed.
    // Each concurrent copy owns its temporary file and only cleans up that file.
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_COPY: AtomicU64 = AtomicU64::new(0);
    let (tmp, mut output) = loop {
        let mut name = dest.file_name().unwrap_or_default().to_os_string();
        name.push(format!(
            ".tmp-{}-{}",
            std::process::id(),
            NEXT_COPY.fetch_add(1, Ordering::Relaxed)
        ));
        let path = dir.join(name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => break (path, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    };
    let result = (|| {
        let mut input = fs::File::open(bundled)?;
        std::io::copy(&mut input, &mut output)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            output.set_permissions(fs::Permissions::from_mode(0o700))?;
        }
        fs::rename(&tmp, dest)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    fs::write(stamp_path, stamp)
}

/// The stamp recorded beside a copy, if any.
pub(crate) fn read_stamp(stamp_path: &Path) -> Option<String> {
    fs::read_to_string(stamp_path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLED: &str = "/tmp/.mount_AshlrXYZ/usr/lib/Ashlr MD/mdopener-mcp";
    const STABLE: &str = "/home/me/.local/share/app.mdopener.desktop/bin";

    fn appimage() -> Option<&'static OsStr> {
        Some(OsStr::new("/home/me/AshlrMD.AppImage"))
    }

    fn stable(copy: bool) -> SidecarPlan {
        SidecarPlan::Stable {
            dest: Path::new(STABLE).join("mdopener-mcp"),
            stamp_path: Path::new(STABLE).join("mdopener-mcp.version"),
            stamp: "0.4.1 123".to_string(),
            copy,
        }
    }

    #[test]
    fn without_appimage_the_bundled_path_is_registered() {
        let p = |os, env| {
            plan(
                os,
                env,
                Path::new(BUNDLED),
                Some(Path::new(STABLE)),
                "0.4.1 123",
                None,
                false,
            )
        };
        assert_eq!(p("linux", None), SidecarPlan::InPlace);
        assert_eq!(p("linux", Some(OsStr::new(""))), SidecarPlan::InPlace);
        assert_eq!(p("macos", appimage()), SidecarPlan::InPlace);
        assert_eq!(p("windows", appimage()), SidecarPlan::InPlace);
    }

    #[test]
    fn appimage_registers_a_copy_outside_the_mount() {
        let p = |recorded, exists| {
            plan(
                "linux",
                appimage(),
                Path::new(BUNDLED),
                Some(Path::new(STABLE)),
                "0.4.1 123",
                recorded,
                exists,
            )
        };
        // First connect: no copy yet.
        assert_eq!(p(None, false), stable(true));
        // Up to date: registered without copying again.
        assert_eq!(p(Some("0.4.1 123\n"), true), stable(false));
        // The AppImage was updated, or rebuilt at the same version.
        assert_eq!(p(Some("0.4.0 123"), true), stable(true));
        assert_eq!(p(Some("0.4.1 999"), true), stable(true));
        // A stamp without its copy (deleted by hand).
        assert_eq!(p(Some("0.4.1 123"), false), stable(true));
        // No data dir: nothing better than the bundled path.
        assert_eq!(
            plan(
                "linux",
                appimage(),
                Path::new(BUNDLED),
                None,
                "0.4.1 123",
                None,
                false
            ),
            SidecarPlan::InPlace
        );
    }

    #[test]
    fn apply_copies_then_reuses_and_refreshes_the_copy() {
        let root = std::env::temp_dir().join(format!("md-appimage-copy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let bundled = root.join("mount/usr/lib/Ashlr MD/mdopen");
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, "synthetic v1; never executed").unwrap();
        let dir = root.join("data/bin");
        let env = appimage();

        let run = |version: &str| {
            let dest = dir.join("mdopen");
            let stamp_path = dir.join("mdopen.version");
            let len = fs::metadata(&bundled).unwrap().len();
            let p = plan(
                "linux",
                env,
                &bundled,
                Some(&dir),
                &stamp_for(version, len),
                read_stamp(&stamp_path).as_deref(),
                dest.exists(),
            );
            apply(&bundled, p).unwrap()
        };

        let dest = run("0.4.1");
        assert_eq!(dest, dir.join("mdopen"));
        assert_eq!(
            fs::read_to_string(&dest).unwrap(),
            "synthetic v1; never executed"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&dest).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }

        // Same version and size: the copy is left alone.
        fs::write(&dest, "edited by hand").unwrap();
        run("0.4.1");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "edited by hand");

        // A new version refreshes it.
        fs::write(&bundled, "synthetic v2; never executed").unwrap();
        run("0.4.2");
        assert_eq!(
            fs::read_to_string(&dest).unwrap(),
            "synthetic v2; never executed"
        );
        assert_eq!(
            fs::read_to_string(dir.join("mdopen.version")).unwrap(),
            "0.4.2 28"
        );
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn copy_does_not_follow_existing_temporary_symlinks() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("md-appimage-links-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let bundled = root.join("bundled");
        let victim = root.join("victim");
        fs::write(&bundled, "new sidecar").unwrap();
        fs::write(&victim, "untouched").unwrap();
        for n in 0..64 {
            symlink(
                &victim,
                root.join(format!("mdopen.tmp-{}-{n}", std::process::id())),
            )
            .unwrap();
        }
        copy_out(&bundled, &root.join("mdopen"), &root.join("stamp"), "v1").unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "untouched");
        assert_eq!(
            fs::read_to_string(root.join("mdopen")).unwrap(),
            "new sidecar"
        );
        for n in 0..64 {
            assert!(root
                .join(format!("mdopen.tmp-{}-{n}", std::process::id()))
                .is_symlink());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_copy_names_the_folder_and_a_next_step() {
        let root = std::env::temp_dir().join(format!("md-appimage-fail-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let missing = root.join("mount/mdopener-mcp");
        let err = apply(
            &missing,
            SidecarPlan::Stable {
                dest: root.join("bin/mdopener-mcp"),
                stamp_path: root.join("bin/mdopener-mcp.version"),
                stamp: "0.4.1 1".to_string(),
                copy: true,
            },
        )
        .unwrap_err();
        assert!(err.contains("out of the AppImage"), "{err}");
        assert!(err.contains("docs/AGENTS.md"), "{err}");
        assert_eq!(fs::read_dir(root.join("bin")).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&root);
    }
}
