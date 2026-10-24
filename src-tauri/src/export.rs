//! Export helper: write arbitrary bytes to disk atomically.
//!
//! Used by the DOCX export path (html-to-docx returns a binary Blob/ArrayBuffer
//! that cannot go through the text-oriented `write_markdown_file`).  The HTML
//! and PDF paths do not need this command.
//!
//! The atomic write strategy mirrors `document.rs`: write to a sibling temp
//! file first, then rename.  A rename on the same filesystem is atomic on
//! POSIX and near-atomic on Windows, so a crash mid-write never leaves a
//! truncated or corrupt file at the destination path.

use std::path::Path;

/// Write `data` bytes to `path` atomically via a temp-file rename.
///
/// Invoked from the frontend as:
/// ```ts
/// await invoke("write_file_bytes", { path, data: Array.from(uint8Array) });
/// ```
/// `data` is a `Vec<u8>` — Tauri's JSON deserialiser accepts a JSON array of
/// integers `[0..255]` for that type, which is what `Array.from(Uint8Array)`
/// produces.
#[tauri::command]
pub fn write_file_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    write_export_file(&path, &data)
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
    use super::write_export_file;

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
