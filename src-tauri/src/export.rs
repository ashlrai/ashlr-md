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
    write_export_file(&path, data)
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
pub(crate) fn write_export_file(path: &str, data: &[u8]) -> Result<(), String> {
    crate::document::refuse_protected_write(path)?;
    crate::document::write_atomic(Path::new(path), data)
        .map_err(|e| format!("Could not save {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{export_path_header, write_export_file};

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
}
