//! Export helper: write arbitrary bytes to disk atomically.
//!
//! Used by the DOCX and EPUB export paths, whose libraries return binary
//! files that cannot go through the text-oriented `write_markdown_file`.
//! The PDF path does not need this command.
//!
//! The atomic write strategy mirrors `document.rs`: write to a sibling temp
//! file first, then rename.  A rename on the same filesystem is atomic on
//! POSIX and near-atomic on Windows, so a crash mid-write never leaves a
//! truncated or corrupt file at the destination path.

use std::path::Path;

/// The request header naming the file [`write_file_bytes`] writes,
/// percent-encoded UTF-8 (`encodeURIComponent`): a header value is ASCII.
pub const EXPORT_PATH_HEADER: &str = "x-export-path";

/// The request header that makes [`write_file_bytes`] refuse a file that is
/// already there (`1`), atomically: a headless export without `overwrite`.
pub const EXPORT_NEW_HEADER: &str = "x-export-new";

/// Write the request's raw body to the file named by its
/// [`EXPORT_PATH_HEADER`] header, atomically via a temp-file rename.
///
/// Invoked from the frontend as:
/// ```ts
/// await invoke("write_file_bytes", bytes, {
///   headers: { "x-export-path": encodeURIComponent(path) },
/// });
/// ```
/// The bytes cross the IPC as they are. They used to be a JSON array of
/// numbers (`{ path, data: Array.from(bytes) }`), about 3.6 bytes of JSON
/// for each byte of the file, built and parsed on both sides: a 32 MiB EPUB
/// sent 114 MiB of JSON, and the conversion alone took over two seconds.
#[tauri::command]
pub fn write_file_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = export_path_header(
        request
            .headers()
            .get(EXPORT_PATH_HEADER)
            .map(|v| v.as_bytes()),
    )?;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("write_file_bytes takes the file's bytes as a raw request body".into());
    };
    let new_only = request
        .headers()
        .get(EXPORT_NEW_HEADER)
        .is_some_and(|v| v.as_bytes() == b"1");
    if new_only {
        write_new_export_file(&path, data)
    } else {
        write_export_file(&path, data)
    }
}

/// The path in an [`EXPORT_PATH_HEADER`] value, which must be there, decode
/// as percent-encoded UTF-8 and not be empty.
fn export_path_header(raw: Option<&[u8]>) -> Result<String, String> {
    let raw =
        raw.ok_or_else(|| format!("write_file_bytes needs the {EXPORT_PATH_HEADER} header"))?;
    let text = std::str::from_utf8(raw)
        .ok()
        .and_then(|t| urlencoding::decode(t).ok())
        .ok_or_else(|| format!("the {EXPORT_PATH_HEADER} header is not percent-encoded UTF-8"))?;
    if text.is_empty() {
        return Err(format!("the {EXPORT_PATH_HEADER} header is empty"));
    }
    Ok(text.into_owned())
}

/// [`write_file_bytes`] without the IPC: the guards Markdown saves apply
/// ([`crate::document::refuse_protected_write`]), then the same writer: a
/// new temp file under a random name (never a planted
/// `<path>.mdopener.tmp` symlink), then a rename.
///
/// A symbolic link at `path` is refused, as the headless export's
/// `outputPath` is ([`crate::export_path::checked_export_path`]). An HTML
/// export chosen in the dialog went through `write_markdown_file`, which
/// saves a linked document into the file the link points to, so a
/// `report.html` linked to `~/.bashrc` had the export written over the shell
/// profile; a DOCX or EPUB replaced the link with a file. A link put there
/// after this check is replaced by the rename, never followed.
pub(crate) fn write_export_file(path: &str, data: &[u8]) -> Result<(), String> {
    crate::document::refuse_protected_write(path)?;
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!(
            "Could not save {path}: it is a symbolic link (export to the file it points to, or to another name)"
        ));
    }
    crate::document::write_atomic(Path::new(path), data)
        .map_err(|e| format!("Could not save {path}: {e}"))
}

/// [`write_export_file`] for a file that must not be there yet: the export
/// is written to a temp file and published with a hard link, which fails
/// when anything (a file, a symbolic link) is at `path`, so nothing there is
/// ever replaced, even one created after the caller checked. The check and
/// the write used to be separate steps: `export` without `overwrite` looked
/// for the file, then the app wrote over whatever had appeared since. Where
/// hard links are not supported (FAT, some network shares) the file is
/// created with `create_new` (O_EXCL) instead, which is as safe against
/// replacing a file but not against a crash mid-write.
pub(crate) fn write_new_export_file(path: &str, data: &[u8]) -> Result<(), String> {
    crate::document::refuse_protected_write(path)?;
    write_new(Path::new(path), data).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("Could not save {path}: a file is already there, and this export does not replace one")
        } else {
            format!("Could not save {path}: {e}")
        }
    })
}

fn write_new(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let (tmp, mut file) = crate::document::create_temp_sibling(path)?;
    let written = file.write_all(data).and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let linked = std::fs::hard_link(&tmp, path);
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => {
            crate::document::sync_parent_dir(path);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(e),
        // No hard links here: create the file only if it is not there.
        Err(_) if std::fs::symlink_metadata(path).is_err() => {
            let mut out = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?;
            let done = out.write_all(data).and_then(|()| out.sync_all());
            if done.is_err() {
                drop(out);
                let _ = std::fs::remove_file(path);
            }
            done
        }
        Err(_) => Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists)),
    }
}

#[cfg(test)]
mod tests {
    use super::{export_path_header, write_export_file, write_new_export_file};

    /// The path travels percent-encoded, so any file name survives a
    /// header; a missing, malformed or empty one is refused.
    #[test]
    fn the_path_header_is_percent_decoded() {
        let encoded = b"%2Ftmp%2FR%C3%A9sum%C3%A9%20%F0%9F%93%9D.docx";
        assert_eq!(
            export_path_header(Some(encoded)).unwrap(),
            "/tmp/R\u{e9}sum\u{e9} \u{1f4dd}.docx"
        );
        assert!(export_path_header(None).is_err());
        assert!(export_path_header(Some(b"")).is_err());
        assert!(export_path_header(Some(b"%FF")).is_err());
    }

    fn temp_root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "mdopener-export-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// An export to a symbolic link was written into the file it points to
    /// (HTML, through `write_markdown_file`) or replaced the link (DOCX,
    /// EPUB); the headless path refused it. It is refused, and both the link
    /// and its target stay as they were.
    #[cfg(unix)]
    #[test]
    fn an_export_to_a_symbolic_link_is_refused() {
        let root = temp_root("link");
        let target = root.join("profile");
        std::fs::write(&target, "export PATH=x").unwrap();
        let link = root.join("report.html");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let dangling = root.join("gone.docx");
        std::os::unix::fs::symlink(root.join("missing"), &dangling).unwrap();

        for l in [&link, &dangling] {
            let err = write_export_file(&l.to_string_lossy(), b"<html>").unwrap_err();
            assert!(err.contains("symbolic link"), "{err}");
            assert!(std::fs::symlink_metadata(l)
                .unwrap()
                .file_type()
                .is_symlink());
        }
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "export PATH=x");
        assert!(!root.join("missing").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An export into an Obsidian config folder replaced the vault's
    /// settings: the Markdown save refused it, `write_file_bytes` did not.
    #[test]
    fn an_export_is_refused_inside_an_obsidian_config_folder() {
        let root = temp_root("obsidian");
        let cfg = root.join(".obsidian");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join("app.json"), "{}").unwrap();
        let err = write_export_file(&cfg.join("app.json").to_string_lossy(), b"PK").unwrap_err();
        assert!(err.contains(".obsidian"), "{err}");
        assert_eq!(std::fs::read(cfg.join("app.json")).unwrap(), b"{}");

        // Through a folder that links to it, too.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&cfg, root.join("cfg")).unwrap();
            let err =
                write_export_file(&root.join("cfg/out.docx").to_string_lossy(), b"PK").unwrap_err();
            assert!(err.contains(".obsidian"), "{err}");
            assert!(!cfg.join("out.docx").exists());
        }

        // Anywhere else the export is written.
        let out = root.join("out.docx");
        write_export_file(&out.to_string_lossy(), b"PK").unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"PK");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Without `overwrite`, a headless export checked for the file and the
    /// app then wrote over whatever had appeared since. The new-file write
    /// never replaces anything: a file, a symbolic link (dangling or not).
    #[test]
    fn a_new_file_export_never_replaces_what_is_there() {
        let root = temp_root("new");
        let out = root.join("out.html");
        write_new_export_file(&out.to_string_lossy(), b"first").unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"first");
        let err = write_new_export_file(&out.to_string_lossy(), b"second").unwrap_err();
        assert!(err.contains("already there"), "{err}");
        assert_eq!(std::fs::read(&out).unwrap(), b"first");
        #[cfg(unix)]
        {
            let target = root.join("profile");
            std::fs::write(&target, "keep").unwrap();
            for (name, to) in [("link.html", target.clone()), ("dangling.html", root.join("none"))] {
                let link = root.join(name);
                std::os::unix::fs::symlink(&to, &link).unwrap();
                assert!(write_new_export_file(&link.to_string_lossy(), b"x").is_err());
                assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
            }
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
            assert!(!root.join("none").exists());
        }
        // No temp file is left behind.
        let left: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".mdopener.tmp"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Two exports racing for one new name: exactly one writes it.
    #[test]
    fn racing_new_file_exports_write_once() {
        let root = temp_root("race");
        let out = root.join("race.docx");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let out = out.clone();
                std::thread::spawn(move || {
                    write_new_export_file(&out.to_string_lossy(), format!("w{i}").as_bytes())
                        .is_ok()
                })
            })
            .collect();
        let wins = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|ok| *ok)
            .count();
        assert_eq!(wins, 1);
        assert!(std::fs::read_to_string(&out).unwrap().starts_with('w'));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The guards of every export apply to a new-file export too.
    #[test]
    fn a_new_file_export_is_refused_inside_an_obsidian_config_folder() {
        let root = temp_root("new-obsidian");
        let cfg = root.join(".obsidian");
        std::fs::create_dir_all(&cfg).unwrap();
        let err = write_new_export_file(&cfg.join("x.html").to_string_lossy(), b"x").unwrap_err();
        assert!(err.contains(".obsidian"), "{err}");
        assert!(!cfg.join("x.html").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
