//! Export helpers: write arbitrary bytes to disk atomically, and atomic
//! multi-file batch write for the `mcp://atomic-edits` tool.
//!
//! Used by the DOCX export path (html-to-docx returns a binary Blob/ArrayBuffer
//! that cannot go through the text-oriented `write_markdown_file`).  The HTML
//! and PDF paths do not need this command.
//!
//! The atomic write strategy mirrors `document.rs`: write to a sibling temp
//! file first, then rename.  A rename on the same filesystem is atomic on
//! POSIX and near-atomic on Windows, so a crash mid-write never leaves a
//! truncated or corrupt file at the destination path.

use serde::{Deserialize, Serialize};
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

// ── Atomic multi-file batch write ─────────────────────────────────────────────

/// One file entry in an `apply_atomic_batch` request.
///
/// The frontend pre-computes the new content for each file (applying OT
/// operations or find/replace in JS) and sends the final text here.  Rust
/// writes all entries atomically: all temp files are written first, then all
/// renames happen.  If any rename fails the already-renamed files are rolled
/// back by overwriting them with their pre-edit content.
#[derive(Deserialize)]
pub struct AtomicBatchEntry {
    pub path: String,
    pub content: String,
}

/// Per-file result returned by `apply_atomic_batch`.
#[derive(Serialize)]
pub struct AtomicBatchResult {
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Write multiple files atomically as a single batch.
///
/// Strategy:
///  1. Read every file's current content (for rollback).
///  2. Write each new content to a sibling `.mdopener.tmp` file.
///  3. Rename all temp files to their final paths.
///  4. If any rename fails, roll back all previously-renamed files by
///     overwriting them with their saved original content.
///
/// Invoked from the frontend as:
/// ```ts
/// await invoke("apply_atomic_batch", { entries: [{ path, content }, …] });
/// ```
#[tauri::command]
pub fn apply_atomic_batch(
    entries: Vec<AtomicBatchEntry>,
) -> Result<Vec<AtomicBatchResult>, String> {
    if entries.is_empty() {
        return Ok(vec![]);
    }

    // ── Step 1: read originals for rollback ───────────────────────────────────
    let mut originals: Vec<Option<String>> = Vec::with_capacity(entries.len());
    for entry in &entries {
        let orig = std::fs::read_to_string(&entry.path).ok();
        originals.push(orig);
    }

    // ── Step 2: write all temp files ──────────────────────────────────────────
    let mut tmp_paths: Vec<String> = Vec::with_capacity(entries.len());
    for entry in &entries {
        let tmp = format!("{}.mdopener.tmp", entry.path);
        if let Err(e) = std::fs::write(&tmp, entry.content.as_bytes()) {
            // Clean up any temp files already written.
            for tp in &tmp_paths {
                let _ = std::fs::remove_file(tp);
            }
            return Err(format!(
                "Could not write temp file for {}: {e}",
                entry.path
            ));
        }
        tmp_paths.push(tmp);
    }

    // ── Step 3: rename all temp files to final paths ──────────────────────────
    let mut renamed: Vec<usize> = Vec::with_capacity(entries.len());
    let mut results: Vec<AtomicBatchResult> = entries
        .iter()
        .map(|e| AtomicBatchResult {
            path: e.path.clone(),
            ok: false,
            error: None,
        })
        .collect();

    for (i, (entry, tmp)) in entries.iter().zip(tmp_paths.iter()).enumerate() {
        match std::fs::rename(tmp, Path::new(&entry.path)) {
            Ok(()) => {
                results[i].ok = true;
                renamed.push(i);
            }
            Err(e) => {
                // Clean up remaining temp files.
                for j in (i + 1)..tmp_paths.len() {
                    let _ = std::fs::remove_file(&tmp_paths[j]);
                }
                // Roll back already-renamed files.
                for &j in renamed.iter().rev() {
                    if let Some(Some(orig)) = originals.get(j) {
                        let _ = std::fs::write(&entries[j].path, orig.as_bytes());
                    }
                }
                results[i].error = Some(format!("Could not rename temp file for {}: {e}", entry.path));
                // Also remove the failing temp file (best-effort).
                let _ = std::fs::remove_file(tmp);
                // Mark remaining entries as not attempted.
                for j in (i + 1)..results.len() {
                    results[j].ok = false;
                    results[j].error = Some("Not attempted — earlier file in batch failed".into());
                }
                return Ok(results);
            }
        }
    }

    Ok(results)
}
