//! Reading documents from disk for an agent: only the file a path check saw.
//!
//! A check (`ipc::checked_agent_document`) resolves a path and judges the
//! canonical name, and the read opens the path again afterwards. A final or
//! intermediate component swapped for a symlink in between would be followed
//! (`notes.md` re-pointed at `~/.ssh/id_rsa`, or the folder above it at
//! another folder), so on Unix the read refuses a link in the last component
//! (`O_NOFOLLOW`) and any file whose device and inode differ from the ones the
//! check saw. Mirrors mdopener-mcp's `CheckedDocument`.

use std::io::Read as _;
use std::path::Path;

/// Largest document an agent read takes from disk: the 16 MiB the IPC server
/// accepts in one request, and what mdopener-mcp reads.
pub(crate) const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;

/// Which file a path named when it was checked: device and inode on Unix.
/// Elsewhere it carries nothing and every file matches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

impl FileIdentity {
    pub(crate) fn of(meta: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            FileIdentity {
                dev: meta.dev(),
                ino: meta.ino(),
            }
        }
        #[cfg(not(unix))]
        {
            let _ = meta;
            FileIdentity {}
        }
    }
}

/// Metadata of a canonical path as a check judges it: on Unix without
/// following a link (the canonical path names none, so one there now was put
/// in place since it was resolved), elsewhere as before.
pub(crate) fn checked_metadata(path: &Path) -> std::io::Result<std::fs::Metadata> {
    #[cfg(unix)]
    {
        std::fs::symlink_metadata(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::metadata(path)
    }
}

/// A canonical document path that passed an agent path check, with the
/// identity of the file it named then (`None` when it did not exist).
#[derive(Clone, Debug)]
pub(crate) struct CheckedDocument {
    pub(crate) path: String,
    pub(crate) identity: Option<FileIdentity>,
}

impl CheckedDocument {
    /// The document's text, refused unless it is the file the check saw, a
    /// regular file, and at most `max` bytes (before reading, and if it grows
    /// while read).
    pub(crate) fn read_capped(&self, max: u64) -> Result<String, String> {
        read_no_follow(Path::new(&self.path), self.identity, max)
    }
}

const SWAPPED_FOR_LINK: &str =
    "it is a symbolic link (it was replaced by one after it was checked)";
const CHANGED: &str = "it changed after it was checked (a link or another file took its place), \
                       so it was not read";

/// Open `path` for reading without blocking on a FIFO (`O_NONBLOCK`, which
/// does nothing to reads of a regular file) and, with `no_follow`, without
/// following a link in its last component (`O_NOFOLLOW`). Elsewhere a plain
/// open.
pub(crate) fn open_for_read(path: &Path, no_follow: bool) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut flags = libc::O_NONBLOCK;
        if no_follow {
            flags |= libc::O_NOFOLLOW;
        }
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(flags)
            .open(path)
            .map_err(|e| {
                // ELOOP on Linux and macOS, EMLINK on FreeBSD.
                let link = matches!(e.raw_os_error(), Some(libc::ELOOP) | Some(libc::EMLINK));
                if no_follow && link {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, SWAPPED_FOR_LINK)
                } else {
                    e
                }
            })
    }
    #[cfg(not(unix))]
    {
        let _ = no_follow;
        std::fs::File::open(path)
    }
}

fn too_large(len: u64, max: u64) -> String {
    format!(
        "it is {:.1} MiB, more than the {} MiB a document may be",
        len as f64 / (1024.0 * 1024.0),
        max / (1024 * 1024)
    )
}

/// Read the already opened `file` (whose metadata is `meta`) as UTF-8 text of
/// at most `max` bytes.
pub(crate) fn read_open_file(
    file: std::fs::File,
    meta: &std::fs::Metadata,
    max: u64,
) -> Result<String, String> {
    if !meta.is_file() {
        return Err("it is not a regular file".into());
    }
    if meta.len() > max {
        return Err(too_large(meta.len(), max));
    }
    let mut text = String::new();
    file.take(max + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() as u64 > max {
        return Err(too_large(text.len() as u64, max));
    }
    Ok(text)
}

fn read_no_follow(path: &Path, expected: Option<FileIdentity>, max: u64) -> Result<String, String> {
    let before = checked_metadata(path).map_err(|e| e.to_string())?;
    if before.file_type().is_symlink() {
        return Err(SWAPPED_FOR_LINK.into());
    }
    if !before.is_file() {
        return Err("it is not a regular file".into());
    }
    let seen = FileIdentity::of(&before);
    if expected.is_some_and(|e| e != seen) {
        return Err(CHANGED.into());
    }
    let file = open_for_read(path, true).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if meta.is_file() && FileIdentity::of(&meta) != seen {
        return Err(CHANGED.into());
    }
    read_open_file(file, &meta, max)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn checked(path: &Path) -> CheckedDocument {
        let canon = std::fs::canonicalize(path).unwrap();
        let identity = Some(FileIdentity::of(&checked_metadata(&canon).unwrap()));
        CheckedDocument {
            path: canon.to_string_lossy().into_owned(),
            identity,
        }
    }

    /// A final or intermediate component swapped for a link between the
    /// check and the read was followed to another file.
    #[test]
    fn refuses_a_link_swapped_in_after_the_check() {
        let dir = std::env::temp_dir().join(format!("mdopener-docread-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let secret = dir.join("id_rsa");
        std::fs::write(&secret, "BEGIN PRIVATE KEY").unwrap();

        let notes = dir.join("notes.md");
        std::fs::write(&notes, "# notes").unwrap();
        let doc = checked(&notes);
        assert_eq!(doc.read_capped(MAX_DOCUMENT_BYTES).unwrap(), "# notes");
        std::fs::remove_file(&notes).unwrap();
        std::os::unix::fs::symlink(&secret, &notes).unwrap();
        let err = doc.read_capped(MAX_DOCUMENT_BYTES).unwrap_err();
        assert!(err.contains("symbolic link"), "{err}");

        let real = dir.join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("plan.md"), "# plan").unwrap();
        let other = dir.join("other");
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join("plan.md"), "SECRET PLAN").unwrap();
        let doc = checked(&real.join("plan.md"));
        std::fs::rename(&real, dir.join("real-old")).unwrap();
        std::os::unix::fs::symlink(&other, &real).unwrap();
        let err = doc.read_capped(MAX_DOCUMENT_BYTES).unwrap_err();
        assert!(err.contains("changed after it was checked"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
