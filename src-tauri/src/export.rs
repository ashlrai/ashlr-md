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
    let tmp = format!("{path}.mdopener.tmp");
    std::fs::write(&tmp, &data)
        .map_err(|e| format!("Could not write temporary file for {path}: {e}"))?;
    std::fs::rename(&tmp, Path::new(&path)).map_err(|e| {
        // Best-effort cleanup of the temp file if the rename fails.
        let _ = std::fs::remove_file(&tmp);
        format!("Could not save {path}: {e}")
    })?;
    Ok(())
}
