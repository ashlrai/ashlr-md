//! Document file I/O: reading and (atomically) writing Markdown files.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct MarkdownFile {
    pub path: String,
    pub file_name: String,
    pub content: String,
    /// Size in bytes — the frontend uses this to decide whether to default
    /// a very large document into the lighter source-only view.
    pub size: u64,
    /// What the read saw ([`content_version`]): the frontend hands it back to
    /// [`write_markdown_file`] so a save never overwrites a change it has
    /// not seen.
    pub version: String,
    /// `path` with every symbolic link resolved (and `.`/`..` gone), so the
    /// frontend can tell that two paths name one file and switch to its tab
    /// rather than open it twice. `path` stays as named: relative links and
    /// the vault are judged from where the document was opened.
    pub canonical_path: String,
    /// The filesystem holding the file ignores case (`Notes.md` and
    /// `notes.md` are one file), so two canonical paths that differ only in
    /// case name one file.
    pub case_insensitive: bool,
    /// The filesystem ignores Unicode normalization (macOS: `é` composed and
    /// decomposed are one name).
    pub normalization_insensitive: bool,
}

/// Whether the filesystem holding `canonical` (an existing, canonical path)
/// ignores case: the same path with one ASCII letter's case flipped, in the
/// last component that has one, names the same file. Windows always does.
/// A component with no ASCII letter anywhere on the path cannot be probed and
/// counts as case-sensitive, so two tabs stay two.
fn ignores_case(canonical: &Path) -> bool {
    if cfg!(windows) {
        return true;
    }
    let Ok(meta) = std::fs::metadata(canonical) else {
        return false;
    };
    let comps: Vec<_> = canonical.components().collect();
    for i in (0..comps.len()).rev() {
        let std::path::Component::Normal(name) = comps[i] else {
            continue;
        };
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(pos) = name.find(|c: char| c.is_ascii_alphabetic()) else {
            continue;
        };
        let mut flipped = name.to_string();
        // An ASCII letter is one byte, so flipping it keeps the string valid.
        let c = flipped.as_bytes()[pos] as char;
        let other = if c.is_ascii_lowercase() {
            c.to_ascii_uppercase()
        } else {
            c.to_ascii_lowercase()
        };
        flipped.replace_range(pos..pos + 1, &other.to_string());
        let mut alt = std::path::PathBuf::new();
        for c in &comps[..i] {
            alt.push(c.as_os_str());
        }
        alt.push(&flipped);
        for c in &comps[i + 1..] {
            alt.push(c.as_os_str());
        }
        return std::fs::metadata(&alt).is_ok_and(|m| {
            crate::doc_read::FileIdentity::of(&m) == crate::doc_read::FileIdentity::of(&meta)
                && cfg!(unix)
        });
    }
    false
}

/// Marks a save refused because the file on disk is not the one the window
/// last read: another app changed it. The frontend reads the file again and
/// offers the change (`src/store/documentStore.ts`).
pub const SAVE_CONFLICT_TAG: &str = "[save-conflict]";
/// Marks a save refused because the file was deleted or moved since it was
/// read. The frontend asks before recreating it.
pub const SAVE_MISSING_TAG: &str = "[save-missing]";

/// A short fingerprint of a document's text: its length and a 64-bit hash.
/// Only compared within one run of the app (the frontend gets it from a read
/// and hands it back to a save), so `DefaultHasher`, which is fixed for one
/// build, is enough. Modification times are not part of it: a touch, or a
/// sync client that rewrites the same bytes, is not a change to offer.
pub(crate) fn content_version(content: &str) -> String {
    use std::hash::{Hash as _, Hasher as _};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut h);
    format!("{}:{:016x}", content.len(), h.finish())
}

/// Refuse to save over `target` unless it still holds what the read that
/// produced `expected` saw. A file that is gone is refused too (the frontend
/// asks before recreating it). There is a window between this check and the
/// rename in [`write_atomic`] in which another writer still wins; it is the
/// length of one read, where it used to be the whole time the tab was open.
fn check_unchanged(target: &Path, expected: &str, shown: &str) -> Result<(), String> {
    match std::fs::metadata(target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "Could not save {shown}: it was deleted or moved since it was opened \
                 {SAVE_MISSING_TAG}"
            ));
        }
        _ => {}
    }
    let now = crate::doc_read::read_document_following(target, crate::doc_read::MAX_DOCUMENT_BYTES)
        .map_err(|e| format!("Could not save {shown}: could not check the file on disk ({e})"))?;
    if content_version(&now) != expected {
        return Err(format!(
            "Could not save {shown}: it changed on disk since it was last read, so it was \
             not overwritten {SAVE_CONFLICT_TAG}"
        ));
    }
    Ok(())
}

/// Read a Markdown file from disk and return its content plus light metadata.
/// Only a regular file of at most 16 MiB is read
/// ([`crate::doc_read::MAX_DOCUMENT_BYTES`]): a FIFO named `x.md` blocked the
/// thread running the command forever, and a multi-gigabyte file (or a link
/// to `/dev/zero`) was read whole into memory and sent to the webview.
#[tauri::command]
pub fn read_markdown_file(path: String) -> Result<MarkdownFile, String> {
    let p = Path::new(&path);
    let content = crate::doc_read::read_document_following(p, crate::doc_read::MAX_DOCUMENT_BYTES)
        .map_err(|e| format!("Could not read {path}: {e}"))?;
    let size = content.len() as u64;
    let file_name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled.md".to_string());
    let version = content_version(&content);
    let canonical = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let case_insensitive = ignores_case(&canonical);
    Ok(MarkdownFile {
        path,
        file_name,
        content,
        size,
        version,
        canonical_path: canonical.to_string_lossy().into_owned(),
        case_insensitive,
        normalization_insensitive: cfg!(target_os = "macos"),
    })
}

/// Write a Markdown file atomically: write to a sibling temp file, then rename.
/// Renaming on the same filesystem is atomic, so a crash mid-write never leaves
/// a half-written document on disk.
///
/// A document that is a symbolic link is saved into the file it points to,
/// which the window read through it ([`read_markdown_file`] follows links):
/// the rename used to replace the link with a regular file, so a note kept
/// elsewhere (a dotfiles repository, a synced folder) and linked into a vault
/// kept its old text there, and the link was gone. The guards judge the file
/// the link points to.
///
/// With `expected` (the `version` of the read the window's text is based
/// on), the save is refused when the file on disk changed since
/// ([`SAVE_CONFLICT_TAG`]) or is gone ([`SAVE_MISSING_TAG`]): it used to be
/// overwritten, so a change another app made while the tab was open was lost
/// without a word. Without it (a Save As the dialog asked about) the file is
/// written whatever is there. With `recreate` (the user confirmed writing a
/// file that was gone again) it is written only if nothing is there
/// ([`refuse_existing`]). Returns the version of what was written, the
/// baseline for the next save.
#[tauri::command]
pub fn write_markdown_file(
    path: String,
    content: String,
    expected: Option<String>,
    recreate: Option<bool>,
) -> Result<String, String> {
    let target =
        link_target(Path::new(&path)).map_err(|e| format!("Could not save {path}: {e}"))?;
    if let Some(expected) = expected.as_deref() {
        check_unchanged(&target, expected, &path)?;
    }
    if recreate == Some(true) {
        refuse_existing(&target, &path)?;
    }
    let version = content_version(&content);
    write_document(&target.to_string_lossy(), content)
        .map_err(|e| e.replace(&*target.to_string_lossy(), &path))?;
    Ok(version)
}

/// Refuse to recreate `target` when something is there again. A file that
/// can be read is a change on disk ([`SAVE_CONFLICT_TAG`]: the frontend
/// offers its text); one that cannot (not UTF-8, too large, not a regular
/// file, no permission) is refused with the reason. A confirmed recreate
/// used to write whatever was there, so a file that had come back in a form
/// the app cannot read was replaced by the tab's text without a word.
fn refuse_existing(target: &Path, shown: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!(
            "Could not save {shown}: could not check whether a file is there again ({e}), so \
             nothing was written"
        )),
        Ok(_) => match crate::doc_read::read_document_following(
            target,
            crate::doc_read::MAX_DOCUMENT_BYTES,
        ) {
            Ok(_) => Err(format!(
                "Could not save {shown}: a file is there again, so it was not overwritten \
                 {SAVE_CONFLICT_TAG}"
            )),
            Err(e) => Err(format!(
                "Could not save {shown}: a file is there again but cannot be read ({e}), so it \
                 was not overwritten. Use Save As to keep this text elsewhere."
            )),
        },
    }
}

/// `path`, or when it is a symbolic link the file it points to (resolved
/// through every link), which must exist: a link to nothing is refused rather
/// than replaced.
fn link_target(path: &Path) -> std::io::Result<std::path::PathBuf> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::canonicalize(path).map_err(|e| {
            std::io::Error::new(
                e.kind(),
                format!("it is a symbolic link to a file that cannot be found ({e})"),
            )
        }),
        _ => Ok(path.to_path_buf()),
    }
}

/// [`write_markdown_file`] at `path` as named, without following a link in
/// it: a link there is replaced. For callers that resolved and judged the
/// path themselves ([`apply_file_patch`]), so a link put in its place since
/// cannot send the write elsewhere.
fn write_document(path: &str, content: String) -> Result<(), String> {
    refuse_protected_write(path)?;
    write_atomic(Path::new(path), content.as_bytes())
        .map_err(|e| format!("Could not save {path}: {e}"))
}

/// The folders no app write may land in, checked before every save and
/// export: an Obsidian config folder (`.obsidian/`, also through a symlinked
/// folder) is Obsidian's, and a stray write there can corrupt the vault's
/// settings or plugins. Exports (`write_file_bytes`) used to skip it, so a
/// DOCX or EPUB saved as `.obsidian/app.json` replaced the vault's settings.
pub(crate) fn refuse_protected_write(path: &str) -> Result<(), String> {
    if path_targets_obsidian_dir(path) {
        return Err("Refusing to write inside an Obsidian .obsidian/ config folder.".into());
    }
    Ok(())
}

/// Write `bytes` to `path` atomically: into a new sibling temp file, then
/// renamed over `path` (atomic on one filesystem, so a crash never leaves a
/// half-written file). Every app write goes through here.
///
/// The temp file is created new (`O_EXCL`) under a random name, never opened
/// if something is already there. It used to be the fixed `<path>.mdopener.tmp`
/// written with `std::fs::write`, which follows a symlink: a vault (a cloned
/// repository, a shared folder) that ships `notes.md.mdopener.tmp ->
/// ~/.bashrc` had the next save of `notes.md` written into `~/.bashrc`.
///
/// The new file takes the permissions of the file it replaces, set before any
/// byte is written: a fresh temp file gets the default mode (`0644` under the
/// usual umask), so saving a private `0600` note used to leave it readable by
/// every user on the machine.
///
/// A file with no write permission is refused, not replaced: the rename needs
/// only the folder to be writable, so saving a read-only (`0444`) note, or
/// exporting over a read-only file, used to replace it with a new read-only
/// file holding the new text, as if it had been writable.
///
/// On Unix the folder is synced after the rename, so the new name is on disk
/// too: a crash right after a save could otherwise come back with the old
/// file (or none, for a new one). The owner and group are carried over where
/// the process may set them (best effort: only root can give a file away).
///
/// Not preserved, because the file is a new one: other hard links to the old
/// file keep the old text (the saved name is no longer one of them), and
/// extended attributes, ACLs, macOS Finder tags and the creation time stay
/// with the old file.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let old = std::fs::metadata(path).ok().filter(|m| m.is_file());
    let keep = old.as_ref().map(|m| m.permissions());
    if keep.as_ref().is_some_and(std::fs::Permissions::readonly) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "it is read-only (make it writable to save it)",
        ));
    }
    let (tmp, mut file) = create_temp_sibling(path)?;
    #[cfg(unix)]
    if let Some(m) = &old {
        use std::os::unix::fs::MetadataExt as _;
        // Best effort: fails (and is ignored) unless the process may set them.
        let _ = std::os::unix::fs::fchown(&file, Some(m.uid()), Some(m.gid()));
    }
    let written = keep
        .map_or(Ok(()), |p| file.set_permissions(p))
        .and_then(|()| file.write_all(bytes))
        .and_then(|()| file.sync_all())
        .and_then(|()| {
            drop(file);
            std::fs::rename(&tmp, path)
        });
    if written.is_err() {
        // Best-effort cleanup of the temp file if the write or rename failed.
        let _ = std::fs::remove_file(&tmp);
        return written;
    }
    sync_parent_dir(path);
    Ok(())
}

/// Sync the folder holding `path`, so a rename into it survives a crash.
/// Best effort: the file is already saved, and some filesystems refuse to
/// sync a folder. A no-op off Unix, where a folder cannot be opened this way.
pub(crate) fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    {
        let parent = match path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p,
            _ => Path::new("."),
        };
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Create a new, empty `<path>.<random>.mdopener.tmp` next to `path` (the
/// Activity drawer ignores that suffix). `create_new` refuses an existing
/// name, a symlink included, so another name is tried.
pub(crate) fn create_temp_sibling(
    path: &Path,
) -> std::io::Result<(std::path::PathBuf, std::fs::File)> {
    for _ in 0..16 {
        let mut nonce = [0u8; 8];
        getrandom::getrandom(&mut nonce).map_err(|e| std::io::Error::other(e.to_string()))?;
        let hex: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let mut name = path.as_os_str().to_owned();
        name.push(format!(".{hex}.mdopener.tmp"));
        let tmp = std::path::PathBuf::from(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(file) => return Ok((tmp, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not create a temporary file next to it",
    ))
}

/// Return the subset of `paths` that still exist as files on disk.
/// Used by session restore to skip documents that were moved/deleted.
#[tauri::command]
pub fn filter_existing(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| Path::new(p).is_file())
        .collect()
}

// ---------------------------------------------------------------------------
// Vault detection + wikilink resolution ([[target]] / ![[target]])
// ---------------------------------------------------------------------------

pub(crate) const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];
/// Cap the vault scan depth so resolution stays fast on big trees.
const WIKILINK_MAX_DEPTH: usize = 12;
/// Stop collecting candidates once we have this many — a safety valve on huge vaults.
const MAX_CANDIDATES: usize = 4096;

/// True if any path component is `.obsidian` (the vault's config folder).
fn is_in_obsidian_dir(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == ".obsidian")
}

/// True if writing to `path` would land inside an Obsidian `.obsidian/` folder.
/// Checks the path lexically first (covers new files and the common case), then
/// the *canonicalized parent* so a symlinked config dir (e.g. `cfg → .obsidian`)
/// can't slip past a purely textual check.
fn path_targets_obsidian_dir(path: &str) -> bool {
    let p = Path::new(path);
    if is_in_obsidian_dir(p) {
        return true;
    }
    if let Some(parent) = p.parent() {
        if let Ok(canon) = parent.canonicalize() {
            return is_in_obsidian_dir(&canon);
        }
    }
    false
}

/// Walk up from `start` (a file or directory) looking for an Obsidian vault
/// marker (`.obsidian/`). Returns the vault root directory, or `None` if none
/// is found before the filesystem root.
#[tauri::command]
pub fn detect_vault_root(start: String) -> Option<String> {
    let p = Path::new(&start);
    // Start at the containing directory when `start` is a file.
    let mut dir: &Path = if p.is_dir() { p } else { p.parent()? };
    loop {
        if dir.join(".obsidian").is_dir() {
            return canonical_string(dir);
        }
        dir = dir.parent()?;
    }
}

/// Resolve an Obsidian-style wikilink `target` to an absolute file path.
///
/// `base_dir` is the directory of the document containing the link; `vault_root`
/// (when known) scopes the vault-wide name search and enables vault-relative
/// path links. Resolution order mirrors Obsidian:
///   1. exact relative path from the current file's directory,
///   2. vault-relative path (from the vault root),
///   3. relative path + an appended Markdown extension (current dir, then root),
///   4. vault-wide name match, preferring the file closest to the current doc.
///
/// A target carrying an explicit extension (e.g. an image embed
/// `![[diagram.png]]`) is matched by full file name; otherwise by stem against
/// Markdown files. Returns `None` for a broken link.
///
/// Only a file a note may link to is returned ([`linkable`]): a Markdown
/// note, an image, a canvas or a PDF, inside the vault when there is one,
/// reached through no hidden folder or file, and never by an absolute
/// target. Any existing file used to be returned, so a note (from a cloned
/// repository or a shared vault) holding `![[../../.ssh/config]]` or
/// `![[/etc/hosts]]` showed that file inline in the read view, with no
/// click, and put it into exports and the clipboard; a click on
/// `[[../../.aws/credentials]]` opened it in a tab, where agents read it.
#[tauri::command]
pub fn resolve_wikilink(
    base_dir: String,
    target: String,
    vault_root: Option<String>,
) -> Option<String> {
    // Drop any "#heading" / "#^block" fragment — we resolve the file only.
    let target = target.split('#').next().unwrap_or(&target).trim();
    if target.is_empty() || is_absolute_target(target) {
        return None;
    }
    let base = Path::new(&base_dir);
    let root = vault_root.as_deref().map(Path::new);
    let found = resolve_wikilink_in(base, target, root)?;
    linkable(Path::new(&found), base, root).then_some(found)
}

/// Whether a wikilink target names an absolute path (`/etc/hosts`,
/// `C:\x`, `\\server\share`), which joining to a folder would follow
/// out of it. Obsidian reads targets relative to the vault.
fn is_absolute_target(target: &str) -> bool {
    let b = target.as_bytes();
    target.starts_with(['/', '\\'])
        || Path::new(target).is_absolute()
        || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

/// The extensions a link from a note may resolve to: notes, images, canvases,
/// PDFs and plain-text attachments ([`TEXT_EXTENSIONS`]). Anything else
/// (`config`, `id_rsa`, `.env`, `.json`) is no attachment a note shows, and
/// was a way to read any text file.
const LINKABLE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "canvas", "pdf",
];

/// Plain-text attachments a note may link to and embed (`[[notes.txt]]`,
/// `![[data.csv]]`): kinds of file written to be read, not configuration or
/// keys. They were refused with the rest, so a vault's `.txt` notes were
/// broken links. The vault confinement and the hidden-component rule of
/// [`linkable`] apply to them as to notes.
const TEXT_EXTENSIONS: &[&str] = &["txt", "text", "csv", "tsv"];

/// Whether `found` (a canonical path a wikilink resolved to) is one a note
/// may show or open: a linkable type ([`MD_EXTENSIONS`],
/// [`LINKABLE_EXTENSIONS`]), inside the vault root when there is one, and
/// with no hidden component (`.ssh`, `.git`, `.env.md`) past the folder it
/// shares with the note's own folder (or the vault): the vault-wide search
/// already skipped hidden folders, but a relative target did not.
fn linkable(found: &Path, base: &Path, root: Option<&Path>) -> bool {
    let ext_ok = found
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| {
            MD_EXTENSIONS.contains(&e.as_str())
                || LINKABLE_EXTENSIONS.contains(&e.as_str())
                || TEXT_EXTENSIONS.contains(&e.as_str())
        });
    if !ext_ok {
        return false;
    }
    let scope = match root {
        Some(r) => match r.canonicalize() {
            Ok(r) if found.starts_with(&r) => r,
            _ => return false,
        },
        None => base.canonicalize().unwrap_or_else(|_| base.to_path_buf()),
    };
    // The components the link travels into, past what it shares with scope.
    let shared = scope
        .components()
        .zip(found.components())
        .take_while(|(a, b)| a == b)
        .count();
    !found.components().skip(shared).any(|c| match c {
        std::path::Component::Normal(name) => name.to_string_lossy().starts_with('.'),
        _ => false,
    })
}

/// [`resolve_wikilink`] without the [`linkable`] check.
fn resolve_wikilink_in(base: &Path, target: &str, root: Option<&Path>) -> Option<String> {
    // 1. Exact relative path from the current file's directory.
    let direct = base.join(target);
    if direct.is_file() {
        return canonical_string(&direct);
    }
    // 2. Vault-relative path (Obsidian allows `[[folder/note]]` from the root).
    if let Some(r) = root {
        let from_root = r.join(target);
        if from_root.is_file() {
            return canonical_string(&from_root);
        }
    }
    // A note's name may hold a dot (`v1.2 plan`, `2024.01.05`): only an
    // extension a link may resolve to makes the target a file name. Any dot
    // used to, so `[[v1.2 plan]]` was looked up as a file named `v1.2 plan`
    // and never found `v1.2 plan.md`.
    let has_ext = Path::new(target)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| {
            MD_EXTENSIONS.contains(&e.as_str())
                || LINKABLE_EXTENSIONS.contains(&e.as_str())
                || TEXT_EXTENSIONS.contains(&e.as_str())
        });
    // 3. Relative path + a Markdown extension (current dir, then vault root).
    if !has_ext {
        for ext in MD_EXTENSIONS {
            let cand = base.join(format!("{target}.{ext}"));
            if cand.is_file() {
                return canonical_string(&cand);
            }
            if let Some(r) = root {
                let cand = r.join(format!("{target}.{ext}"));
                if cand.is_file() {
                    return canonical_string(&cand);
                }
            }
        }
    }
    // 4. Vault-wide name match: collect every candidate, then pick the closest.
    let scan_root = root.unwrap_or(base);
    let wanted = Path::new(target)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(target)
        .to_ascii_lowercase();

    let mut matches = Vec::new();
    collect_matches(scan_root, &wanted, has_ext, 0, &mut matches);
    pick_closest(matches, base, target)
}

fn canonical_string(p: &Path) -> Option<String> {
    p.canonicalize()
        .ok()
        .map(|c| c.to_string_lossy().into_owned())
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Recursively collect files matching `wanted` (full file name when `full_name`,
/// else Markdown-file stem), case-insensitively. Skips hidden dirs + build dirs.
fn collect_matches(
    dir: &Path,
    wanted: &str,
    full_name: bool,
    depth: usize,
    out: &mut Vec<std::path::PathBuf>,
) {
    if depth > WIKILINK_MAX_DEPTH || out.len() >= MAX_CANDIDATES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    continue;
                }
            }
            subdirs.push(path);
            continue;
        }
        let hit = if full_name {
            path.file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .as_deref()
                == Some(wanted)
        } else {
            is_markdown(&path)
                && path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_ascii_lowercase())
                    .as_deref()
                    == Some(wanted)
        };
        if hit {
            out.push(path);
        }
    }
    for sub in subdirs {
        if out.len() >= MAX_CANDIDATES {
            break;
        }
        collect_matches(&sub, wanted, full_name, depth + 1, out);
    }
}

/// Pick the best match: prefer a path that ends with the full `target` (so a
/// vault-relative `[[folder/note]]` beats a bare name collision), then the file
/// sharing the longest path prefix with `base` (proximity), then the shortest
/// path. Fully deterministic on ties.
fn pick_closest(mut matches: Vec<std::path::PathBuf>, base: &Path, target: &str) -> Option<String> {
    if matches.is_empty() {
        return None;
    }
    let target_norm = target.replace('\\', "/").to_ascii_lowercase();
    let base_comps = lower_components(base);
    matches.sort_by_cached_key(|p| {
        let s = p.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
        let suffix_rank = if s.ends_with(&target_norm) { 0 } else { 1 };
        // Proximity = shared leading *path components* with the current doc's
        // dir (component-wise, so multibyte path segments can't misalign).
        let comps = lower_components(p);
        let shared = base_comps
            .iter()
            .zip(comps.iter())
            .take_while(|(x, y)| x == y)
            .count();
        (suffix_rank, std::cmp::Reverse(shared), s.len(), s)
    });
    canonical_string(&matches[0])
}

/// Lowercased path components, for case-insensitive component comparison.
fn lower_components(p: &Path) -> Vec<String> {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect()
}

/// Read a local image and return it as a `data:` URL. Used by `![[image.png]]`
/// embeds so we never have to expose a broad `asset://` filesystem scope to the
/// webview — images flow through the same Rust trust boundary as every other read.
#[tauri::command]
pub fn read_image_data_url(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let mime = match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        _ => return Err("Unsupported image type for embed".into()),
    };
    // Cap so a hostile/huge file can't balloon webview memory.
    const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
    // Regular files only, opened without blocking: a FIFO named `x.png`
    // hung the read, and an `x.png` link to `/dev/zero` (which reports a
    // length of 0, so passed the size check) was read until memory ran out.
    // A file that grows past the cap while read is refused too.
    let bytes = crate::doc_read::read_bytes_following(p, MAX_IMAGE_BYTES)
        .map_err(|e| format!("Cannot read {path}: {e}"))?
        .ok_or("Image too large to embed (>25 MiB).")?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// Minimal standard-alphabet base64 encoder (no external crate).
fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Apply a single exact find→replace to a file named by a `` ```diff `` block,
/// resolved RELATIVE TO `base_dir` (the directory of the document being viewed).
///
/// SECURITY: `target` comes from an untrusted document's diff header (the agent
/// authored it), so the resolved file is CONFINED to `base_dir`'s subtree. An
/// absolute target (`/etc/hosts`) or a `../` escape is rejected — a malicious
/// `.md` cannot turn "Apply hunk" into an arbitrary-file write primitive. Uses
/// the same unique-match semantics as `/edit` (0 → error, >1 → ambiguous), and
/// writes atomically via `write_document` (which also guards `.obsidian/`).
///
/// Returns the resolved absolute path on success so the UI can show what changed.
#[tauri::command]
pub fn apply_file_patch(
    base_dir: String,
    target: String,
    find: String,
    replace: String,
) -> Result<String, String> {
    if find.is_empty() {
        return Err("`find` must not be empty.".into());
    }
    let base = std::fs::canonicalize(&base_dir)
        .map_err(|e| format!("Cannot resolve the document's folder: {e}"))?;

    // Resolve the target relative to the doc's dir. `Path::join` lets an absolute
    // `target` replace `base` — which the confinement check below then rejects.
    let joined = base.join(&target);
    let parent = joined
        .parent()
        .ok_or("The patch target has no parent directory.")?;
    let canon_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Cannot resolve the patch target's folder: {e}"))?;

    // Confinement: the (symlink-resolved) target dir must stay under base_dir.
    if !canon_parent.starts_with(&base) {
        return Err(
            "Refusing to patch a file outside the document's own folder (the diff names a path that escapes it)."
                .into(),
        );
    }

    let file_name = joined
        .file_name()
        .ok_or("The patch target has no file name.")?;
    let resolved = canon_parent.join(file_name);
    // The file itself is judged after resolving symlinks too: a `notes.md`
    // link to `~/.ssh/id_rsa` was read through and its patched text written
    // into the folder (the rename replaced the link), where agents read it.
    let resolved = match std::fs::canonicalize(&resolved) {
        Ok(real) if !real.starts_with(&base) => return Err(LINKED_OUT_OF_FOLDER.into()),
        Ok(real) => real,
        Err(_) => resolved,
    };
    // Hidden files and folders (`.git/config`, `.env`, `.github/…`) are never
    // patched: a diff an agent wrote could otherwise set `core.fsmonitor` in
    // `.git/config`, which git runs as a command.
    let hidden = resolved
        .strip_prefix(&base)
        .map(|rel| {
            rel.components()
                .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        })
        .unwrap_or(true);
    if hidden {
        return Err(
            "Refusing to patch a hidden file or a file in a hidden folder (such as .git/ or .env)."
                .into(),
        );
    }
    let resolved_str = resolved.to_string_lossy().into_owned();

    if path_targets_obsidian_dir(&resolved_str) {
        return Err("Refusing to patch inside an Obsidian .obsidian/ config folder.".into());
    }

    // A regular file of at most 16 MiB, opened without blocking: a FIFO
    // named by the diff hung the command, and any size was read whole.
    let content =
        crate::doc_read::read_document_following(&resolved, crate::doc_read::MAX_DOCUMENT_BYTES)
            .map_err(|e| format!("Could not read {resolved_str}: {e}"))?;
    let new_content = match content.matches(find.as_str()).count() {
        0 => return Err("Patch context not found in the target file.".into()),
        1 => content.replacen(find.as_str(), replace.as_str(), 1),
        n => return Err(format!(
            "Patch context is not unique ({n} matches). Include more surrounding context to disambiguate."
        )),
    };
    write_document(&resolved_str, new_content)?;
    Ok(resolved_str)
}

/// Why [`apply_file_patch`] refuses a target that is a link out of the folder.
const LINKED_OUT_OF_FOLDER: &str =
    "Refusing to patch a file outside the document's own folder (it is a link that points out of it).";

/// Image extensions accepted for a pasted-image save (lower-cased, no dot).
const PASTE_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];
/// Cap a pasted image's size — mirrors `read_image_data_url`'s embed cap so a
/// hostile/huge clipboard payload can't fill the disk or balloon memory.
const MAX_PASTE_IMAGE_BYTES: usize = 25 * 1024 * 1024;

/// Save a pasted clipboard image next to the open document and return the
/// Markdown-relative path to insert (e.g. `assets/pasted-1.png`).
///
/// `doc_path` is the absolute path of the currently-open document; the image is
/// written into an `assets/` subdirectory of that document's folder (created on
/// demand). `bytes` is the raw image payload and `ext` its extension (no dot).
///
/// SECURITY: the write is CONFINED to the document's own directory subtree using
/// the same canonicalize-then-`starts_with` check as `apply_file_patch`. The
/// generated filename is a fixed `pasted-<n>.<ext>` (no caller-supplied name), so
/// `ext` is the only untrusted component and it is checked against an allowlist;
/// even so we re-resolve the final path and reject anything that escapes the doc
/// dir. Size is capped to match `read_image_data_url`.
#[tauri::command]
pub fn save_pasted_image(doc_path: String, bytes: Vec<u8>, ext: String) -> Result<String, String> {
    // The document's directory is the confinement root.
    let doc = Path::new(&doc_path);
    let base = doc
        .parent()
        .ok_or("The open document has no parent directory.")?;
    let (_, name) =
        write_pasted_image_under(base, "the document's own folder", "assets", &bytes, &ext)?;
    // Return the path RELATIVE to the document for insertion (forward slashes so
    // the Markdown is portable across platforms).
    Ok(format!("assets/{name}"))
}

/// Save a pasted clipboard image into `<Downloads>/mdopener-paste/` and return
/// its absolute path. This backs the opt-in "downloads" paste target, which
/// works for an unsaved document too.
///
/// SECURITY: same confinement as [`save_pasted_image`], rooted at the user's
/// Downloads folder: the filename is generated, `ext` is allowlisted, and the
/// resolved target must stay under the canonical Downloads directory.
#[tauri::command]
pub fn save_pasted_image_to_downloads(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    let downloads = dirs::download_dir().ok_or("Could not find your Downloads folder.")?;
    let (target, _) = write_pasted_image_under(
        &downloads,
        "the Downloads folder",
        "mdopener-paste",
        &bytes,
        &ext,
    )?;
    Ok(target.to_string_lossy().into_owned())
}

/// Write `bytes` as `<base>/<subdir>/pasted-<n>.<ext>` and return the written
/// path plus its file name. The write is CONFINED to `base` using the same
/// canonicalize-then-`starts_with` check as `apply_file_patch`; a symlinked
/// `subdir` that points elsewhere is refused. `root_label` names `base` in
/// error messages.
fn write_pasted_image_under(
    base: &Path,
    root_label: &str,
    subdir: &str,
    bytes: &[u8],
    ext: &str,
) -> Result<(std::path::PathBuf, String), String> {
    if bytes.is_empty() {
        return Err("Pasted image is empty.".into());
    }
    if bytes.len() > MAX_PASTE_IMAGE_BYTES {
        return Err("Pasted image is too large (>25 MiB).".into());
    }

    // Validate the extension against the allowlist (case-insensitive).
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if !PASTE_IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(format!(
            "Unsupported image type '{ext}'. Allowed: {}.",
            PASTE_IMAGE_EXTS.join(", ")
        ));
    }

    // Canonicalize the root first so the `starts_with` checks below compare
    // symlink-resolved paths.
    let base =
        std::fs::canonicalize(base).map_err(|e| format!("Cannot resolve {root_label}: {e}"))?;

    // Ensure the subdir exists, then re-resolve it and confirm it stays under
    // base (a symlinked subdir can't redirect the write elsewhere).
    let sub_dir = base.join(subdir);
    std::fs::create_dir_all(&sub_dir)
        .map_err(|e| format!("Could not create the {subdir} folder: {e}"))?;
    let canon_sub = std::fs::canonicalize(&sub_dir)
        .map_err(|e| format!("Cannot resolve the {subdir} folder: {e}"))?;
    if !canon_sub.starts_with(&base) {
        return Err(format!("Refusing to write outside {root_label}."));
    }

    // Pick a non-colliding `pasted-<n>.<ext>` filename.
    let mut n: u32 = 1;
    let (target, name) = loop {
        let name = format!("pasted-{n}.{ext}");
        let candidate = canon_sub.join(&name);
        if !candidate.exists() {
            break (candidate, name);
        }
        n += 1;
        if n > 100_000 {
            return Err(format!("Could not find a free filename in {subdir}/."));
        }
    };

    // Final confinement re-check on the resolved parent, mirroring apply_file_patch.
    let parent = target
        .parent()
        .ok_or("The image target has no parent directory.")?;
    let canon_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Cannot resolve the image target's folder: {e}"))?;
    if !canon_parent.starts_with(&base) {
        return Err(format!("Refusing to write outside {root_label}."));
    }

    // Atomic write: temp sibling then rename, matching write_markdown_file.
    write_atomic(&target, bytes).map_err(|e| format!("Could not save the image: {e}"))?;
    Ok((target, name))
}

/// Open the given file in Obsidian via the `obsidian://open?path=…` URI scheme.
#[tauri::command]
pub fn open_in_obsidian(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let abs = std::fs::canonicalize(&path)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or(path);
    let encoded = urlencoding::encode(&abs);
    let url = format!("obsidian://open?path={encoded}");
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Could not open in Obsidian (is it installed?): {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Image embeds checked the size from `stat` and then read the file
    /// whole: an `x.png` link to `/dev/zero` (length 0) was read until memory
    /// ran out, and a FIFO hung the read. "Apply hunk" read its target the
    /// same way. Both now read regular files only, without blocking.
    #[cfg(unix)]
    #[test]
    fn image_embeds_and_patches_refuse_devices_and_fifos() {
        let root = make_tree();
        let zero = root.join("zero.png");
        std::os::unix::fs::symlink("/dev/zero", &zero).unwrap();
        let fifo = root.join("pipe.png");
        let fifo_md = root.join("pipe.md");
        for f in [&fifo, &fifo_md] {
            let ok = std::process::Command::new("mkfifo")
                .arg(f)
                .status()
                .unwrap()
                .success();
            assert!(ok, "mkfifo failed");
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let (z, f, base) = (
            zero.to_string_lossy().into_owned(),
            fifo.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
        );
        std::thread::spawn(move || {
            let _ = tx.send((
                read_image_data_url(z).err(),
                read_image_data_url(f).err(),
                apply_file_patch(base, "pipe.md".into(), "a".into(), "b".into()).err(),
            ));
        });
        let (zero_err, fifo_err, patch_err) = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("a read blocked on a device or FIFO");
        for err in [zero_err, fifo_err, patch_err] {
            let err = err.expect("a device or FIFO was read");
            assert!(err.contains("not a regular file"), "{err}");
        }
        // A real image is still embedded.
        let png = root.join("ok.png");
        std::fs::write(&png, b"\x89PNG").unwrap();
        let url = read_image_data_url(png.to_string_lossy().into_owned()).unwrap();
        assert_eq!(url, "data:image/png;base64,iVBORw==");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `read_markdown_file` read whatever the path named, whole: a FIFO
    /// named `x.md` blocked it forever, and a file of any size went into
    /// memory. It now reads regular files of at most 16 MiB only.
    #[test]
    fn read_markdown_file_refuses_a_fifo_and_a_file_over_16_mib() {
        let root = make_tree();
        let big = root.join("big.md");
        std::fs::File::create(&big)
            .unwrap()
            .set_len(crate::doc_read::MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        let err = read_markdown_file(big.to_string_lossy().into_owned())
            .err()
            .expect("an oversized file was read");
        assert!(err.contains("more than the 16 MiB"), "{err}");
        let at_cap = root.join("at-cap.md");
        std::fs::File::create(&at_cap)
            .unwrap()
            .set_len(crate::doc_read::MAX_DOCUMENT_BYTES)
            .unwrap();
        let file = read_markdown_file(at_cap.to_string_lossy().into_owned()).unwrap();
        assert_eq!(file.size, crate::doc_read::MAX_DOCUMENT_BYTES);
        // A missing file still says "(os error 2)", which the frontend
        // relies on to drop a recent that is gone.
        let err = read_markdown_file(root.join("gone.md").to_string_lossy().into_owned())
            .err()
            .unwrap();
        assert!(err.contains("(os error 2)"), "{err}");

        #[cfg(unix)]
        {
            let fifo = root.join("pipe.md");
            let ok = std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success();
            assert!(ok, "mkfifo failed");
            let (tx, rx) = std::sync::mpsc::channel();
            let path = fifo.to_string_lossy().into_owned();
            std::thread::spawn(move || {
                let _ = tx.send(read_markdown_file(path).err());
            });
            let err = rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("reading a FIFO blocked")
                .expect("a FIFO was read");
            assert!(err.contains("not a regular file"), "{err}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A Latin-1 or UTF-16 file was refused with the bare "stream did not
    /// contain valid UTF-8" (opening it, presenting it, reviewing it, and a
    /// patch of it). The reason now says where the first invalid byte is (or
    /// that the file is UTF-16) and to convert the file, as mdopener-mcp does.
    #[test]
    fn a_document_that_is_not_utf8_says_where_and_what_to_do() {
        let root = make_tree();
        let latin = root.join("latin.md");
        std::fs::write(&latin, b"# Notes\ncaf\xe9\n").unwrap();
        let err = read_markdown_file(s(&latin))
            .err()
            .expect("Latin-1 was read");
        assert_eq!(
            err,
            format!(
                "Could not read {}: it is not UTF-8 text (byte 12 is not valid UTF-8, on \
                 line 2). Ashlr MD reads documents as UTF-8: convert the file to UTF-8 (for \
                 example `iconv -f WINDOWS-1252 -t UTF-8`, or save it as UTF-8 in its \
                 editor), then try again.",
                s(&latin)
            )
        );
        let utf16 = root.join("utf16.md");
        std::fs::write(&utf16, [0xFF, 0xFE, b'#', 0, b' ', 0, b'x', 0]).unwrap();
        let err = read_markdown_file(s(&utf16))
            .err()
            .expect("UTF-16 was read");
        assert!(err.contains(": it is UTF-16 text, not UTF-8. "), "{err}");
        assert!(err.contains("convert the file to UTF-8"), "{err}");
        let err =
            apply_file_patch(s(&root), "latin.md".into(), "caf".into(), "x".into()).unwrap_err();
        assert!(
            err.contains("(byte 12 is not valid UTF-8, on line 2)"),
            "{err}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    fn make_tree() -> std::path::PathBuf {
        // Unique dir per call so the (parallel) tests don't race on a shared path.
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut root = std::env::temp_dir();
        root.push(format!("mdopener-wikilink-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let mut a = std::fs::File::create(root.join("Alpha.md")).unwrap();
        a.write_all(b"# Alpha").unwrap();
        let mut b = std::fs::File::create(root.join("notes").join("Beta.md")).unwrap();
        b.write_all(b"# Beta").unwrap();
        root
    }

    fn s(p: &std::path::Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn resolves_relative_without_extension() {
        let root = make_tree();
        let got = resolve_wikilink(s(&root), "Alpha".into(), None);
        assert!(got.is_some());
        assert!(got.unwrap().ends_with("Alpha.md"));
    }

    #[test]
    fn resolves_by_basename_in_subdir() {
        let root = make_tree();
        let got = resolve_wikilink(s(&root), "Beta".into(), None);
        assert!(got.unwrap().ends_with("Beta.md"));
    }

    #[test]
    fn strips_heading_fragment() {
        let root = make_tree();
        let got = resolve_wikilink(s(&root), "Alpha#Intro".into(), None);
        assert!(got.is_some());
    }

    #[test]
    fn returns_none_for_missing_target() {
        let root = make_tree();
        assert!(resolve_wikilink(s(&root), "Nope".into(), None).is_none());
    }

    #[test]
    fn detects_vault_root_walking_up() {
        let root = make_tree();
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        // From a nested file, detection should walk up to the vault root.
        let from = root.join("notes").join("Beta.md");
        let detected = detect_vault_root(s(&from)).unwrap();
        assert_eq!(
            std::fs::canonicalize(&detected).unwrap(),
            std::fs::canonicalize(&root).unwrap()
        );
        // No vault marker above the system temp dir → None for a bare path.
        assert!(detect_vault_root("/".into()).is_none());
    }

    #[test]
    fn vault_wide_resolution_prefers_closest_to_base() {
        let root = make_tree();
        // Two same-named notes in different folders; the link sits next to one.
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("a").join("Dup.md"), b"# A").unwrap();
        std::fs::write(root.join("b").join("Dup.md"), b"# B").unwrap();
        let base = root.join("a");
        let got = resolve_wikilink(s(&base), "Dup".into(), Some(s(&root))).unwrap();
        // Closest-to-base wins: the one in `a/`.
        assert!(got.replace('\\', "/").contains("/a/Dup.md"));
    }

    #[test]
    fn resolves_image_embed_by_full_name() {
        let root = make_tree();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets").join("diagram.png"), b"\x89PNG").unwrap();
        let got = resolve_wikilink(s(&root), "diagram.png".into(), Some(s(&root))).unwrap();
        assert!(got.ends_with("diagram.png"));
    }

    #[test]
    fn base64_matches_known_vectors() {
        // RFC 4648 test vectors.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    /// The temp file was the fixed `<path>.mdopener.tmp`, written through
    /// whatever was there: a planted symlink sent the save elsewhere.
    #[cfg(unix)]
    #[test]
    fn saves_never_write_through_a_planted_temp_symlink() {
        let root = make_tree();
        let outside = root.join("bashrc");
        std::fs::write(&outside, "keep me").unwrap();
        let doc = root.join("notes.md");
        std::fs::write(&doc, "old").unwrap();
        let planted = root.join("notes.md.mdopener.tmp");
        std::os::unix::fs::symlink(&outside, &planted).unwrap();

        write_markdown_file(s(&doc), "new".into(), None, None).unwrap();
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "new");
        assert!(!std::fs::symlink_metadata(&doc)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep me");

        let out = root.join("out.docx");
        std::os::unix::fs::symlink(&outside, root.join("out.docx.mdopener.tmp")).unwrap();
        crate::export::write_export_file(&s(&out), b"PK").unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"PK");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep me");

        // No temp file is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name().to_string_lossy().ends_with(".mdopener.tmp")
                    && !e.file_type().unwrap().is_symlink()
            })
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    /// A save replaced the file with a new one in the default mode, so a
    /// private `0600` note became world-readable.
    #[cfg(unix)]
    #[test]
    fn saves_keep_the_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = make_tree();
        let doc = root.join("private.md");
        std::fs::write(&doc, "old").unwrap();
        std::fs::set_permissions(&doc, std::fs::Permissions::from_mode(0o600)).unwrap();
        write_markdown_file(s(&doc), "new".into(), None, None).unwrap();
        let mode = std::fs::metadata(&doc).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "new");

        let out = root.join("private.docx");
        std::fs::write(&out, "old").unwrap();
        std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o640)).unwrap();
        crate::export::write_export_file(&s(&out), b"PK").unwrap();
        let mode = std::fs::metadata(&out).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640, "{mode:o}");
    }

    /// A save of a document that is a symlink replaced the link with a
    /// regular file, so the file it points to kept the old text.
    #[cfg(unix)]
    #[test]
    fn saving_a_symlinked_document_writes_the_file_it_points_to() {
        use std::os::unix::fs::PermissionsExt;
        let root = make_tree();
        let real_dir = root.join("dotfiles");
        std::fs::create_dir_all(&real_dir).unwrap();
        let real = real_dir.join("notes.md");
        std::fs::write(&real, "old").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = root.join("notes.md");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // A link to a link is followed to the end.
        let link2 = root.join("again.md");
        std::os::unix::fs::symlink(&link, &link2).unwrap();

        write_markdown_file(s(&link2), "new".into(), None, None).unwrap();
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "new");
        for l in [&link, &link2] {
            assert!(std::fs::symlink_metadata(l)
                .unwrap()
                .file_type()
                .is_symlink());
        }
        let mode = std::fs::metadata(&real).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
        // The temp file was made beside the real file, and none is left.
        for dir in [&root, &real_dir] {
            let left = std::fs::read_dir(dir)
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".mdopener.tmp"))
                .count();
            assert_eq!(left, 0);
        }

        // A link to nothing is refused, not replaced.
        let dangling = root.join("gone.md");
        std::os::unix::fs::symlink(root.join("missing.md"), &dangling).unwrap();
        let err = write_markdown_file(s(&dangling), "x".into(), None, None).unwrap_err();
        assert!(err.contains("symbolic link"), "{err}");
        assert!(err.contains("gone.md"), "{err}");
        assert!(std::fs::symlink_metadata(&dangling)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!root.join("missing.md").exists());

        // The guards judge the file a link points to.
        let cfg = root.join(".obsidian");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join("app.json"), "{}").unwrap();
        let sneaky = root.join("settings.md");
        std::os::unix::fs::symlink(cfg.join("app.json"), &sneaky).unwrap();
        let err = write_markdown_file(s(&sneaky), "x".into(), None, None).unwrap_err();
        assert!(err.contains(".obsidian"), "{err}");
        assert_eq!(std::fs::read_to_string(cfg.join("app.json")).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A confirmed recreate wrote over whatever was there: a file that had
    /// come back, readable or not (here not UTF-8), was replaced.
    #[test]
    fn a_recreate_never_writes_over_a_file_that_is_there_again() {
        let root = std::env::temp_dir().join(format!("md-recreate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let doc = root.join("n.md");

        let unreadable = [0xffu8, 0xfe, 0x00, 0x41];
        std::fs::write(&doc, unreadable).unwrap();
        let err = write_markdown_file(s(&doc), "tab".into(), None, Some(true)).unwrap_err();
        assert!(err.contains("cannot be read"), "{err}");
        assert!(!err.contains(SAVE_CONFLICT_TAG), "{err}");
        assert_eq!(std::fs::read(&doc).unwrap(), unreadable);

        std::fs::write(&doc, "back").unwrap();
        let err = write_markdown_file(s(&doc), "tab".into(), None, Some(true)).unwrap_err();
        assert!(err.contains(SAVE_CONFLICT_TAG), "{err}");
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "back");

        // Still gone: written.
        std::fs::remove_file(&doc).unwrap();
        write_markdown_file(s(&doc), "tab".into(), None, Some(true)).unwrap();
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "tab");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A read-only file was replaced by the rename, which needs only the
    /// folder to be writable.
    #[test]
    fn saves_refuse_a_read_only_file() {
        let root = make_tree();
        let doc = root.join("locked.md");
        std::fs::write(&doc, "old").unwrap();
        let mut perms = std::fs::metadata(&doc).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&doc, perms).unwrap();
        let err = write_markdown_file(s(&doc), "new".into(), None, None).unwrap_err();
        assert!(err.contains("read-only"), "{err}");
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "old");
        let err = crate::export::write_export_file(&s(&doc), b"PK").unwrap_err();
        assert!(err.contains("read-only"), "{err}");
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "old");
        // No temp file is left.
        let left = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".mdopener.tmp"))
            .count();
        assert_eq!(left, 0);
        let mut perms = std::fs::metadata(&doc).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&doc, perms).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_guard_rejects_obsidian_dir() {
        let root = make_tree();
        let cfg = root.join(".obsidian");
        std::fs::create_dir_all(&cfg).unwrap();
        let target = cfg.join("app.json");
        let err = write_markdown_file(s(&target), "{}".into(), None, None).unwrap_err();
        assert!(err.contains(".obsidian"), "got: {err}");
        assert!(!target.exists(), "must not have written the file");
    }

    #[test]
    fn apply_file_patch_within_doc_dir_succeeds() {
        let root = make_tree();
        std::fs::write(root.join("notes").join("doc.md"), "hello world").unwrap();
        // base_dir = notes/, target a sibling file relative to it.
        let base = root.join("notes");
        apply_file_patch(s(&base), "doc.md".into(), "world".into(), "there".into()).unwrap();
        let got = std::fs::read_to_string(root.join("notes").join("doc.md")).unwrap();
        assert_eq!(got, "hello there");
    }

    #[test]
    fn apply_file_patch_rejects_escape_outside_doc_dir() {
        let root = make_tree();
        std::fs::write(root.join("secret.md"), "TOPSECRET").unwrap();
        let base = root.join("notes");
        // `../secret.md` escapes the doc's folder → must be refused, file untouched.
        let err = apply_file_patch(
            s(&base),
            "../secret.md".into(),
            "TOPSECRET".into(),
            "x".into(),
        )
        .unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
        assert_eq!(
            std::fs::read_to_string(root.join("secret.md")).unwrap(),
            "TOPSECRET"
        );
    }

    /// A diff an agent wrote could patch `.git/config` (git runs
    /// `core.fsmonitor` as a command) or `.env` next to the document, and a
    /// `link.md` to a file outside the folder was read through and its
    /// patched text written into the folder.
    #[test]
    fn apply_file_patch_rejects_hidden_and_linked_targets() {
        let root = make_tree();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("config"), "[core]\n").unwrap();
        std::fs::write(root.join(".env"), "TOKEN=1").unwrap();
        for (target, find) in [
            (".git/config", "[core]"),
            (".env", "TOKEN"),
            ("./.env", "TOKEN"),
        ] {
            let err =
                apply_file_patch(s(&root), target.into(), find.into(), "x".into()).unwrap_err();
            assert!(err.contains("hidden"), "{target}: {err}");
        }
        assert_eq!(
            std::fs::read_to_string(root.join(".git").join("config")).unwrap(),
            "[core]\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(".env")).unwrap(),
            "TOKEN=1"
        );

        #[cfg(unix)]
        {
            let outside = make_tree();
            let key = outside.join("id_rsa");
            std::fs::write(&key, "BEGIN KEY").unwrap();
            let link = root.join("link.md");
            std::os::unix::fs::symlink(&key, &link).unwrap();
            let err = apply_file_patch(s(&root), "link.md".into(), "BEGIN".into(), "x".into())
                .unwrap_err();
            assert!(err.contains("outside"), "{err}");
            assert!(std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(std::fs::read_to_string(&key).unwrap(), "BEGIN KEY");
            let _ = std::fs::remove_dir_all(&outside);
        }

        // An ordinary file in the folder is still patched.
        let ok = apply_file_patch(s(&root), "Alpha.md".into(), "Alpha".into(), "A".into());
        assert!(ok.is_ok(), "{ok:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_file_patch_rejects_absolute_target() {
        let root = make_tree();
        let base = root.join("notes");
        // An absolute target outside base is rejected (can't resolve / not confined).
        let err = apply_file_patch(
            s(&base),
            "/etc/hosts".into(),
            "127.0.0.1".into(),
            "x".into(),
        )
        .unwrap_err();
        // Either "outside" (if /etc resolves) or a resolve error — never a write.
        assert!(!err.is_empty());
    }

    #[test]
    fn save_pasted_image_writes_into_assets_and_returns_relative_path() {
        let root = make_tree();
        let doc = root.join("notes").join("doc.md");
        std::fs::write(&doc, "# Doc").unwrap();
        let rel = save_pasted_image(s(&doc), b"\x89PNG\r\n".to_vec(), "png".into()).unwrap();
        assert_eq!(rel, "assets/pasted-1.png");
        // The bytes landed under notes/assets/, confined to the doc's folder.
        let written = root.join("notes").join("assets").join("pasted-1.png");
        assert_eq!(std::fs::read(&written).unwrap(), b"\x89PNG\r\n");
    }

    #[test]
    fn save_pasted_image_increments_to_avoid_collisions() {
        let root = make_tree();
        let doc = root.join("doc.md");
        std::fs::write(&doc, "# Doc").unwrap();
        let first = save_pasted_image(s(&doc), b"a".to_vec(), "png".into()).unwrap();
        let second = save_pasted_image(s(&doc), b"b".to_vec(), "png".into()).unwrap();
        assert_eq!(first, "assets/pasted-1.png");
        assert_eq!(second, "assets/pasted-2.png");
    }

    #[test]
    fn save_pasted_image_normalizes_extension() {
        let root = make_tree();
        let doc = root.join("doc.md");
        std::fs::write(&doc, "# Doc").unwrap();
        // Leading dot + mixed case + whitespace are all normalized.
        let rel = save_pasted_image(s(&doc), b"x".to_vec(), " .JPG ".into()).unwrap();
        assert_eq!(rel, "assets/pasted-1.jpg");
    }

    #[test]
    fn save_pasted_image_rejects_disallowed_extension() {
        let root = make_tree();
        let doc = root.join("doc.md");
        std::fs::write(&doc, "# Doc").unwrap();
        // An executable extension is not on the allowlist → refused, nothing written.
        let err = save_pasted_image(s(&doc), b"MZ".to_vec(), "exe".into()).unwrap_err();
        assert!(err.contains("Unsupported"), "got: {err}");
        assert!(!root.join("assets").exists());
    }

    #[test]
    fn save_pasted_image_rejects_path_traversal_in_extension() {
        let root = make_tree();
        let doc = root.join("doc.md");
        std::fs::write(&doc, "# Doc").unwrap();
        // A `../`-style extension can never match the allowlist, so the only
        // untrusted input can't escape the assets/ subtree.
        let err = save_pasted_image(s(&doc), b"x".to_vec(), "../../etc/passwd".into()).unwrap_err();
        assert!(err.contains("Unsupported"), "got: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn save_pasted_image_rejects_symlinked_assets_escape() {
        // If `assets` is a symlink pointing OUTSIDE the doc's folder, the write
        // must be refused — confinement compares symlink-resolved paths.
        let root = make_tree();
        let docdir = root.join("notes");
        let doc = docdir.join("doc.md");
        std::fs::write(&doc, "# Doc").unwrap();
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, docdir.join("assets")).unwrap();
        let err = save_pasted_image(s(&doc), b"x".to_vec(), "png".into()).unwrap_err();
        assert!(err.contains("outside"), "got: {err}");
    }

    #[test]
    fn save_pasted_image_rejects_oversize_payload() {
        let root = make_tree();
        let doc = root.join("doc.md");
        std::fs::write(&doc, "# Doc").unwrap();
        let huge = vec![0u8; MAX_PASTE_IMAGE_BYTES + 1];
        let err = save_pasted_image(s(&doc), huge, "png".into()).unwrap_err();
        assert!(err.contains("too large"), "got: {err}");
    }

    #[test]
    fn pasted_image_under_downloads_root_lands_in_mdopener_paste() {
        // Exercise the downloads target's writer against a temp "Downloads" so
        // the test never touches the real home directory.
        let root = make_tree();
        let (path, name) =
            write_pasted_image_under(&root, "Downloads", "mdopener-paste", b"\x89PNG", "png")
                .unwrap();
        assert_eq!(name, "pasted-1.png");
        let canon_root = std::fs::canonicalize(&root).unwrap();
        assert_eq!(path, canon_root.join("mdopener-paste").join("pasted-1.png"));
        assert!(path.is_absolute());
        assert_eq!(std::fs::read(&path).unwrap(), b"\x89PNG");
    }

    #[test]
    fn pasted_image_under_downloads_root_refuses_traversal_in_extension() {
        let root = make_tree();
        let err = write_pasted_image_under(&root, "Downloads", "mdopener-paste", b"x", "../../x")
            .unwrap_err();
        assert!(err.contains("Unsupported"), "got: {err}");
        assert!(!root.join("mdopener-paste").exists());
    }

    #[cfg(unix)]
    #[test]
    fn pasted_image_under_downloads_root_refuses_symlinked_subdir_escape() {
        let root = make_tree();
        let downloads = root.join("Downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, downloads.join("mdopener-paste")).unwrap();
        let err = write_pasted_image_under(&downloads, "Downloads", "mdopener-paste", b"x", "png")
            .unwrap_err();
        assert!(err.contains("outside Downloads"), "got: {err}");
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn write_guard_rejects_symlinked_obsidian_dir() {
        // `cfg` is a symlink to `.obsidian`; a lexical-only check would miss it.
        let root = make_tree();
        let cfg = root.join(".obsidian");
        std::fs::create_dir_all(&cfg).unwrap();
        let link = root.join("cfg");
        std::os::unix::fs::symlink(&cfg, &link).unwrap();
        let target = link.join("app.json");
        let err = write_markdown_file(s(&target), "{}".into(), None, None).unwrap_err();
        assert!(err.contains(".obsidian"), "got: {err}");
    }

    /// A save overwrote whatever was on disk: a change another app made while
    /// the tab was open was lost. With the version of the read it is based
    /// on, a save over a changed file is refused, a touch (same text) is not
    /// a change, and a file that is gone is not silently recreated.
    #[test]
    fn a_save_refuses_to_overwrite_a_change_it_has_not_seen() {
        let root = make_tree();
        let doc = root.join("notes.md");
        std::fs::write(&doc, "v0").unwrap();
        let read = read_markdown_file(s(&doc)).unwrap();

        // Unchanged (and only touched): saved, and the new version returned.
        std::fs::write(&doc, "v0").unwrap();
        let v1 =
            write_markdown_file(s(&doc), "v1".into(), Some(read.version.clone()), None).unwrap();
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "v1");
        assert_eq!(v1, read_markdown_file(s(&doc)).unwrap().version);

        // Another app writes; a save based on the old read is refused.
        std::fs::write(&doc, "theirs").unwrap();
        let err = write_markdown_file(s(&doc), "mine".into(), Some(v1.clone()), None).unwrap_err();
        assert!(err.contains(SAVE_CONFLICT_TAG), "{err}");
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "theirs");

        // Gone: refused, not recreated, until the caller drops the check.
        std::fs::remove_file(&doc).unwrap();
        let err = write_markdown_file(s(&doc), "mine".into(), Some(v1), None).unwrap_err();
        assert!(err.contains(SAVE_MISSING_TAG), "{err}");
        assert!(!doc.exists());
        write_markdown_file(s(&doc), "mine".into(), None, None).unwrap();
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "mine");
    }

    /// The new file keeps the old one's mode; nothing else is left behind.
    #[cfg(unix)]
    #[test]
    fn a_save_keeps_the_mode_and_leaves_no_temp_file() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = make_tree();
        let doc = root.join("private.md");
        std::fs::write(&doc, "old").unwrap();
        std::fs::set_permissions(&doc, std::fs::Permissions::from_mode(0o600)).unwrap();
        write_atomic(&doc, b"new").unwrap();
        let mode = std::fs::metadata(&doc).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".mdopener.tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    /// Opening one file by two paths (a symbolic link, `..`) opened it in two
    /// tabs, whose saves overwrote each other. The read names the file it
    /// read, links resolved, and whether its filesystem ignores case.
    #[cfg(unix)]
    #[test]
    fn a_read_names_the_canonical_file_and_its_case_rule() {
        let root = make_tree();
        let doc = root.join("Notes.md");
        std::fs::write(&doc, "x").unwrap();
        let link = root.join("link.md");
        std::os::unix::fs::symlink(&doc, &link).unwrap();
        let canon = s(&std::fs::canonicalize(&doc).unwrap());
        let direct = read_markdown_file(s(&doc)).unwrap();
        let via_link = read_markdown_file(s(&link)).unwrap();
        let via_dots = read_markdown_file(s(&root.join("notes/../Notes.md"))).unwrap();
        assert_eq!(direct.canonical_path, canon);
        assert_eq!(via_link.canonical_path, canon);
        assert_eq!(via_dots.canonical_path, canon);
        // `path` stays as named, for links and the vault.
        assert_eq!(via_link.path, s(&link));
        // The probe agrees with the filesystem the test runs on.
        let other_case = root.join("notes.md");
        let folds = std::fs::metadata(&other_case).is_ok();
        assert_eq!(direct.case_insensitive, folds);
        // A sibling that differs only in case is another file, not a fold.
        if !folds {
            std::fs::write(&other_case, "y").unwrap();
            assert!(!read_markdown_file(s(&doc)).unwrap().case_insensitive);
        }
    }

    /// A wikilink resolved to any existing file: `![[../../.ssh/config]]`
    /// in a note showed that file inline, and `[[/etc/hosts]]` opened it.
    /// Only notes, images, canvases and PDFs resolve, inside the vault when
    /// there is one, through no hidden folder, and never by absolute path.
    #[test]
    fn wikilinks_resolve_only_to_files_a_note_may_link_to() {
        let root = make_tree();
        let vault = root.join("vault");
        std::fs::create_dir_all(vault.join("sub")).unwrap();
        std::fs::create_dir_all(root.join(".ssh")).unwrap();
        std::fs::write(root.join(".ssh").join("config"), "Host *").unwrap();
        std::fs::write(root.join(".ssh").join("notes.md"), "# hidden").unwrap();
        std::fs::write(root.join("secret.md"), "# outside the vault").unwrap();
        std::fs::write(root.join("plain.json"), "{}").unwrap();
        std::fs::write(vault.join("sub").join("Note.md"), "# n").unwrap();
        std::fs::write(vault.join("pic.png"), "png").unwrap();
        let base = s(&vault.join("sub"));
        let vr = Some(s(&vault));

        // In the vault: a note and an image still resolve.
        assert!(resolve_wikilink(base.clone(), "Note".into(), vr.clone()).is_some());
        assert!(resolve_wikilink(base.clone(), "../pic.png".into(), vr.clone()).is_some());
        // Out of the vault, by `..` or an absolute path: refused.
        assert!(resolve_wikilink(base.clone(), "../../secret".into(), vr.clone()).is_none());
        let abs = s(&root.join("secret.md"));
        assert!(resolve_wikilink(base.clone(), abs.clone(), vr.clone()).is_none());
        assert!(resolve_wikilink(base.clone(), abs, None).is_none());
        // With no vault: a hidden folder, or a file that is no note, is refused.
        let nb = s(&root.join("notes"));
        assert!(resolve_wikilink(nb.clone(), "../.ssh/config".into(), None).is_none());
        assert!(resolve_wikilink(nb.clone(), "../.ssh/notes".into(), None).is_none());
        assert!(resolve_wikilink(nb.clone(), "../plain.json".into(), None).is_none());
        assert!(resolve_wikilink(nb.clone(), "../secret".into(), None).is_some());
        assert!(resolve_wikilink(nb, "../Alpha".into(), None).is_some());
    }

    /// A note whose name holds a dot (`v1.2 plan`, `2024.01.05`) was looked
    /// up as a file of that full name, since any dot counted as an
    /// extension, so `[[v1.2 plan]]` was a broken link to `v1.2 plan.md`.
    #[test]
    fn wikilinks_to_a_note_with_a_dot_in_its_name_resolve() {
        let root = make_tree();
        let vault = root.join("vault");
        std::fs::create_dir_all(vault.join("daily")).unwrap();
        std::fs::write(vault.join("v1.2 plan.md"), "# plan").unwrap();
        std::fs::write(vault.join("daily").join("2024.01.05.md"), "# day").unwrap();
        std::fs::write(vault.join("pic.png"), "png").unwrap();
        let base = s(&vault);
        let vr = Some(s(&vault));
        let at = |p: std::path::PathBuf| canonical_string(&p);

        // Next to the note, and by name anywhere in the vault.
        assert_eq!(
            resolve_wikilink(base.clone(), "v1.2 plan".into(), vr.clone()),
            at(vault.join("v1.2 plan.md"))
        );
        assert_eq!(
            resolve_wikilink(base.clone(), "2024.01.05#Morning".into(), vr.clone()),
            at(vault.join("daily").join("2024.01.05.md"))
        );
        assert_eq!(
            resolve_wikilink(base.clone(), "daily/2024.01.05".into(), vr.clone()),
            at(vault.join("daily").join("2024.01.05.md"))
        );
        // A real extension still names the file itself.
        assert_eq!(
            resolve_wikilink(base.clone(), "v1.2 plan.md".into(), vr.clone()),
            at(vault.join("v1.2 plan.md"))
        );
        assert_eq!(
            resolve_wikilink(base.clone(), "pic.png".into(), vr.clone()),
            at(vault.join("pic.png"))
        );
        assert!(resolve_wikilink(base, "v1.3 plan".into(), vr).is_none());
    }

    /// A wikilink to a plain-text attachment (`[[notes.txt]]`) was refused
    /// with `config` and `.json`, so it showed as a broken link. Text types
    /// resolve now, still only inside the vault and through no hidden folder.
    #[test]
    fn wikilinks_resolve_plain_text_attachments_in_the_vault() {
        let root = make_tree();
        let vault = root.join("vault");
        std::fs::create_dir_all(vault.join("files")).unwrap();
        std::fs::create_dir_all(vault.join(".git")).unwrap();
        std::fs::write(vault.join("files").join("notes.txt"), "plain").unwrap();
        std::fs::write(vault.join("files").join("Data.CSV"), "a,b").unwrap();
        std::fs::write(vault.join("files").join("table.tsv"), "a\tb").unwrap();
        std::fs::write(vault.join("files").join("app.json"), "{}").unwrap();
        std::fs::write(vault.join(".git").join("log.txt"), "hidden").unwrap();
        std::fs::write(root.join("outside.txt"), "outside").unwrap();
        let base = s(&vault);
        let vr = Some(s(&vault));

        let txt = resolve_wikilink(base.clone(), "files/notes.txt".into(), vr.clone());
        assert_eq!(
            txt,
            canonical_string(&vault.join("files").join("notes.txt"))
        );
        // By name, anywhere in the vault, and in any case.
        assert!(resolve_wikilink(base.clone(), "notes.txt".into(), vr.clone()).is_some());
        assert!(resolve_wikilink(base.clone(), "Data.CSV".into(), vr.clone()).is_some());
        assert!(resolve_wikilink(base.clone(), "table.tsv".into(), vr.clone()).is_some());
        // Not a text type, a hidden folder, or out of the vault: refused.
        assert!(resolve_wikilink(base.clone(), "files/app.json".into(), vr.clone()).is_none());
        assert!(resolve_wikilink(base.clone(), ".git/log.txt".into(), vr.clone()).is_none());
        assert!(resolve_wikilink(base, "../outside.txt".into(), vr).is_none());
    }
}
