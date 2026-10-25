//! Decided reviews saved to `~/.mdopener/reviews/`, one file per reviewed
//! document, so `get_user_annotations` (mdopener-mcp, which includes this
//! file) can still report the human's last verdict when the app has quit or
//! refuses the server's token. The app writes a file when a review of a file
//! path is decided or superseded; reviews of inline content have no path and
//! are not saved.
//!
//! Each file is owner-only (`0600` in a `0700` folder on Unix), at most
//! [`MAX_REVIEW_FILE_BYTES`], and replaced atomically (temp file, rename). A
//! file that is larger, does not parse, has another schema or names another
//! path is ignored, never trusted. The newest review of a document wins: an
//! older review (by `createdAt`, then `decidedAt`) never replaces a newer
//! one, so a review superseded after a newer one was decided cannot
//! overwrite it. `contentHash` is the reviewed file's hash when the verdict
//! was given; a reader compares it with the file now and reports `stale`
//! when they differ or either is unknown, so an approval of an earlier
//! version is never presented as current. The hash is FNV-1a 64, which
//! detects edits; it is not a security check.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Largest review file read or written (comments included).
pub const MAX_REVIEW_FILE_BYTES: u64 = 256 * 1024;

/// Largest document hashed for `contentHash`; a larger one has no hash and
/// any saved verdict for it reads as stale.
pub const MAX_HASHED_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;

const SCHEMA: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedReview {
    pub schema: u32,
    pub path: String,
    pub review_id: String,
    /// approved | changes_requested | dismissed | timeout | superseded
    pub verdict: String,
    pub comments: Option<String>,
    pub late: bool,
    pub superseded_by: Option<String>,
    pub created_at: u64,
    pub decided_at: u64,
    pub content_hash: Option<String>,
}

impl SavedReview {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        path: &str,
        review_id: &str,
        verdict: &str,
        comments: Option<String>,
        late: bool,
        superseded_by: Option<String>,
        created_at: u64,
        decided_at: u64,
    ) -> Self {
        SavedReview {
            schema: SCHEMA,
            path: path.to_string(),
            review_id: review_id.to_string(),
            verdict: verdict.to_string(),
            comments,
            late,
            superseded_by,
            created_at,
            decided_at,
            content_hash: hash_file(Path::new(path)),
        }
    }

    fn newer_than(&self, other: &SavedReview) -> bool {
        (self.created_at, self.decided_at) >= (other.created_at, other.decided_at)
    }
}

/// `~/.mdopener/reviews`, or None without a home directory.
pub fn reviews_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".mdopener").join("reviews"))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// The FNV-1a 64 hash of the file's bytes as 16 hex digits, or None when it
/// cannot be read or is over [`MAX_HASHED_DOCUMENT_BYTES`].
pub fn hash_file(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_HASHED_DOCUMENT_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:016x}", fnv1a(&bytes)))
}

/// The file in `dir` that holds `path`'s review.
pub fn review_file(dir: &Path, path: &str) -> PathBuf {
    dir.join(format!("{:016x}.json", fnv1a(path.as_bytes())))
}

/// The saved review of `path` in `dir`, or None when there is none or the
/// file is oversized, corrupt, of another schema, or for another path.
pub fn load(dir: &Path, path: &str) -> Option<SavedReview> {
    let file = review_file(dir, path);
    let meta = std::fs::symlink_metadata(&file).ok()?;
    if !meta.is_file() || meta.len() > MAX_REVIEW_FILE_BYTES {
        return None;
    }
    let raw = std::fs::read(&file).ok()?;
    if raw.len() as u64 > MAX_REVIEW_FILE_BYTES {
        return None;
    }
    let saved: SavedReview = serde_json::from_slice(&raw).ok()?;
    (saved.schema == SCHEMA && saved.path == path).then_some(saved)
}

/// Save `review` in `dir` unless a newer review of the same path is already
/// saved. Returns whether it was written.
pub fn save(dir: &Path, review: &SavedReview) -> std::io::Result<bool> {
    if let Some(existing) = load(dir, &review.path) {
        if !review.newer_than(&existing) {
            return Ok(false);
        }
    }
    let bytes = serde_json::to_vec_pretty(review).map_err(std::io::Error::other)?;
    if bytes.len() as u64 > MAX_REVIEW_FILE_BYTES {
        return Err(std::io::Error::other(format!(
            "review is {} bytes, more than the {MAX_REVIEW_FILE_BYTES} a review file may be",
            bytes.len()
        )));
    }
    create_private_dir(dir)?;
    let file = review_file(dir, &review.path);
    let tmp = file.with_extension(format!("json.{}.tmp", std::process::id()));
    write_private(&tmp, &bytes)?;
    std::fs::rename(&tmp, &file).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(true)
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(path)?.write_all(bytes)
}

/// Whether `saved` describes the file as it is now: false (stale) when the
/// file changed, or when either hash is unknown.
// Read by mdopener-mcp; the app only writes.
#[allow(dead_code)]
pub fn is_current(saved: &SavedReview) -> bool {
    match (&saved.content_hash, hash_file(Path::new(&saved.path))) {
        (Some(then), Some(now)) => *then == now,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch folder removed on drop (no tempfile dependency, so the
    /// mdopener-mcp include and the app build the same way).
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static N: AtomicU32 = AtomicU32::new(0);
            let p = std::env::temp_dir().join(format!(
                "mdopener-reviews-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn doc(dir: &Path, text: &str) -> String {
        let p = dir.join("plan.md");
        std::fs::write(&p, text).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn rec(path: &str, id: &str, verdict: &str, created: u64, decided: u64) -> SavedReview {
        SavedReview::new(
            path,
            id,
            verdict,
            Some("ok".into()),
            false,
            None,
            created,
            decided,
        )
    }

    #[test]
    fn save_then_load_round_trips_flags() {
        let home = Scratch::new();
        let dir = home.path().join("reviews");
        let p = doc(home.path(), "# Plan\n");
        let mut r = SavedReview::new(
            &p,
            "r1",
            "superseded",
            None,
            true,
            Some("r2".into()),
            10,
            20,
        );
        r.comments = Some("see r2".into());
        assert!(save(&dir, &r).unwrap());
        let back = load(&dir, &p).unwrap();
        assert_eq!(back, r);
        assert!(back.late);
        assert_eq!(back.superseded_by.as_deref(), Some("r2"));
        assert!(is_current(&back));
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let home = Scratch::new();
        let dir = home.path().join("reviews");
        let p = doc(home.path(), "x");
        save(&dir, &rec(&p, "r1", "approved", 1, 2)).unwrap();
        let mode = |q: &Path| std::fs::metadata(q).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&review_file(&dir, &p)), 0o600);
    }

    #[test]
    fn newest_review_wins() {
        let home = Scratch::new();
        let dir = home.path().join("reviews");
        let p = doc(home.path(), "x");
        assert!(save(&dir, &rec(&p, "new", "approved", 100, 150)).unwrap());
        // An older review superseded later must not replace the newer verdict.
        assert!(!save(&dir, &rec(&p, "old", "superseded", 50, 200)).unwrap());
        assert_eq!(load(&dir, &p).unwrap().review_id, "new");
        assert!(save(&dir, &rec(&p, "newer", "changes_requested", 300, 310)).unwrap());
        assert_eq!(load(&dir, &p).unwrap().verdict, "changes_requested");
    }

    #[test]
    fn corrupt_oversized_or_foreign_files_are_ignored() {
        let home = Scratch::new();
        let dir = home.path().join("reviews");
        std::fs::create_dir_all(&dir).unwrap();
        let p = doc(home.path(), "x");
        let f = review_file(&dir, &p);
        std::fs::write(&f, "{ not json").unwrap();
        assert!(load(&dir, &p).is_none());
        let mut other = rec("/elsewhere.md", "r", "approved", 1, 2);
        other.content_hash = None;
        std::fs::write(&f, serde_json::to_vec(&other).unwrap()).unwrap();
        assert!(
            load(&dir, &p).is_none(),
            "a file naming another path is not trusted"
        );
        let mut big = serde_json::to_vec(&rec(&p, "r", "approved", 1, 2)).unwrap();
        big.extend(std::iter::repeat_n(b' ', MAX_REVIEW_FILE_BYTES as usize));
        std::fs::write(&f, big).unwrap();
        assert!(load(&dir, &p).is_none());
        // A corrupt file does not block a new save.
        std::fs::write(&f, "garbage").unwrap();
        assert!(save(&dir, &rec(&p, "r2", "approved", 5, 6)).unwrap());
        assert_eq!(load(&dir, &p).unwrap().review_id, "r2");
    }

    #[test]
    fn oversized_review_is_refused() {
        let home = Scratch::new();
        let dir = home.path().join("reviews");
        let p = doc(home.path(), "x");
        let mut r = rec(&p, "r", "approved", 1, 2);
        r.comments = Some("c".repeat(MAX_REVIEW_FILE_BYTES as usize));
        assert!(save(&dir, &r).is_err());
        assert!(load(&dir, &p).is_none());
    }

    #[test]
    fn an_edited_or_unreadable_file_is_stale() {
        let home = Scratch::new();
        let p = doc(home.path(), "v1");
        let r = rec(&p, "r", "approved", 1, 2);
        assert!(is_current(&r));
        std::fs::write(&p, "v2").unwrap();
        assert!(!is_current(&r));
        std::fs::remove_file(&p).unwrap();
        assert!(!is_current(&r));
        let mut unknown = r.clone();
        unknown.content_hash = None;
        assert!(!is_current(&unknown));
    }
}
