//! Where a headless export may be written: the rule both the app's `/export`
//! IPC endpoint and the `export` MCP tool (which includes this file) apply to
//! an output path. The app writes there without asking, so only a file with
//! the format's own extension, not a dotfile, in an existing directory is
//! accepted. Std only, so the MCP server can share it as is.

use std::path::{Path, PathBuf};

/// File extensions an output path may carry for each headless export format.
/// pdf has none: it goes through the system print dialog.
pub fn export_extensions(format: &str) -> &'static [&'static str] {
    match format {
        "html" => &["html", "htm"],
        "docx" => &["docx"],
        "epub" => &["epub"],
        _ => &[],
    }
}

/// Check the absolute output path `abs` for `format` and return it with its
/// directory resolved (symlinks followed). `field` names the argument in the
/// error, as the caller spells it (`output_path`, `outputPath`).
pub fn checked_export_path(abs: &Path, format: &str, field: &str) -> Result<PathBuf, String> {
    if format == "pdf" {
        return Err(format!(
            "`{field}` is not supported for pdf: pdf export goes through the \
             system print dialog. Use html, docx or epub with `{field}`, or omit \
             `{field}` to print to PDF."
        ));
    }
    if !abs.is_absolute() {
        return Err(format!(
            "`{field}` '{}' must be an absolute path",
            abs.display()
        ));
    }
    let name = abs.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let allowed = export_extensions(format);
    if name.starts_with('.') || !allowed.contains(&ext.as_str()) {
        return Err(format!(
            "`{field}` '{}' must name a {format} file ({}), not a dotfile",
            abs.display(),
            allowed
                .iter()
                .map(|e| format!(".{e}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let dir = abs.parent().filter(|d| !d.as_os_str().is_empty());
    let dir = dir
        .and_then(|d| std::fs::canonicalize(d).ok())
        .filter(|d| d.is_dir())
        .ok_or_else(|| {
            format!(
                "`{field}` '{}': the directory does not exist; create it first",
                abs.display()
            )
        })?;
    let out = dir.join(name);
    if out.is_dir() {
        return Err(format!("`{field}` '{}' is a directory", out.display()));
    }
    Ok(out)
}
