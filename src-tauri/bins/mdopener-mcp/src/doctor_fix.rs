//! `mdopener-mcp doctor --fix [--apply] [--json]`: repairs for Ashlr MD's own
//! state folder, `~/.mdopener`, with the semantics of `locus doctor --fix`
//! (docs/doctor-fix.md there): a preview by default that writes nothing,
//! `--apply` to make the changes, backups before any content changes, exit 1
//! only when an applied fix was skipped, `--json` for one
//! `{ mode, plan, outcome }` object, and `--apply` without `--fix` refused.
//! `stack doctor --fix` runs it because the handshake lists `doctor-fix`.
//!
//! Repairs (local, deterministic, reversible):
//! - owner-only permissions: `~/.mdopener`, `sessions/` and `reviews/` to
//!   `0700`, and session files, saved review files and `ipc-port` to `0600`
//!   when group or other may read them. Builds before the session files were
//!   created `0600` left them `0644`, and opening an existing file with a
//!   mode never changes it. The previous mode is reported so it can be put
//!   back; no content is written.
//! - a saved review in `reviews/` that is oversized, does not parse, has
//!   another schema, or sits under another file's name: it is ignored when
//!   read, so it is moved aside (copied to `<file>.bak-<UTC stamp>`, 0600,
//!   compared byte for byte, then removed).
//!
//! Manual items (report only):
//! - `ipc-token` readable by others: it is the app's secret, so this tool
//!   never opens, moves or changes it; the item names the command.
//! - symlinks and other non-regular entries, which are never followed.
//! - MCP client registration and sidecar paths: covered by the app's agent
//!   setup (Preferences > AI agents), not repaired here.
//!
//! Unix only: on other platforms the plan is empty with one manual note.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlannedFix {
    /// Remove group and other permission bits.
    TightenMode {
        file: PathBuf,
        current_mode: String,
        target_mode: String,
    },
    /// Back up, then remove, a file Ashlr MD ignores when it reads it.
    MoveAside { file: PathBuf, reason: String },
}

impl PlannedFix {
    pub fn describe(&self) -> String {
        match self {
            PlannedFix::TightenMode {
                file,
                current_mode,
                target_mode,
            } => format!(
                "make owner-only ({current_mode} to {target_mode}): {}",
                file.display()
            ),
            PlannedFix::MoveAside { file, reason } => {
                format!(
                    "move aside a saved review that {reason}: {}",
                    file.display()
                )
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReportOnly {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<PathBuf>,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct FixPlan {
    pub fixes: Vec<PlannedFix>,
    pub report_only: Vec<ReportOnly>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppliedFix {
    pub fix: PlannedFix,
    pub applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FixOutcome {
    pub results: Vec<AppliedFix>,
}

impl FixOutcome {
    pub fn all_applied(&self) -> bool {
        self.results.iter().all(|r| r.applied)
    }
}

/// Why the saved review at `file` (in `dir`) would be ignored, or None when
/// it is a record the reader accepts.
fn bad_review(dir: &Path, file: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(file).ok()?;
    if meta.len() > crate::review_store::MAX_REVIEW_FILE_BYTES {
        return Some(format!(
            "is larger than {} bytes",
            crate::review_store::MAX_REVIEW_FILE_BYTES
        ));
    }
    let bytes = match std::fs::read(file) {
        Ok(b) => b,
        Err(e) => return Some(format!("cannot be read ({e})")),
    };
    let saved: crate::review_store::SavedReview = match serde_json::from_slice(&bytes) {
        Ok(s) => s,
        Err(_) => return Some("does not parse".into()),
    };
    if saved.schema != 1 {
        return Some(format!("has schema {}", saved.schema));
    }
    if crate::review_store::review_file(dir, &saved.path) != file {
        return Some("is stored under another file's name".into());
    }
    None
}

#[cfg(unix)]
fn mode_of(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt as _;
    meta.permissions().mode() & 0o777
}

/// Plan the repairs under `root` (`~/.mdopener`). Reads only; writes nothing.
pub fn plan_fixes(root: &Path) -> FixPlan {
    let mut plan = FixPlan::default();
    #[cfg(not(unix))]
    {
        let _ = root;
        plan.report_only.push(ReportOnly {
            code: "permissions_not_checked".into(),
            file: None,
            message: "owner-only permissions are checked on macOS and Linux only".into(),
        });
        plan
    }
    #[cfg(unix)]
    {
        let Ok(meta) = std::fs::symlink_metadata(root) else {
            return plan; // Nothing installed yet: nothing to repair.
        };
        if !meta.is_dir() {
            plan.report_only.push(ReportOnly {
                code: "state_dir_not_a_directory".into(),
                file: Some(root.to_path_buf()),
                message: "~/.mdopener is not a directory (or is a symlink); not changed".into(),
            });
            return plan;
        }
        let tighten = |plan: &mut FixPlan, path: &Path, want: u32| {
            let Ok(m) = std::fs::symlink_metadata(path) else {
                return;
            };
            if m.file_type().is_symlink() || !(m.is_dir() || m.is_file()) {
                plan.report_only.push(ReportOnly {
                    code: "not_a_regular_entry".into(),
                    file: Some(path.to_path_buf()),
                    message: "a symlink or special file; never followed or changed".into(),
                });
                return;
            }
            let mode = mode_of(&m);
            if mode & 0o077 != 0 {
                plan.fixes.push(PlannedFix::TightenMode {
                    file: path.to_path_buf(),
                    current_mode: format!("{mode:04o}"),
                    target_mode: format!("{want:04o}"),
                });
            }
        };
        tighten(&mut plan, root, 0o700);
        tighten(&mut plan, &root.join("ipc-port"), 0o600);
        if let Ok(m) = std::fs::symlink_metadata(root.join("ipc-token")) {
            if m.is_file() && mode_of(&m) & 0o077 != 0 {
                plan.report_only.push(ReportOnly {
                    code: "ipc_token_not_private".into(),
                    file: Some(root.join("ipc-token")),
                    message: format!(
                        "ipc-token is mode {:04o}: other users may read the app's token. It is a secret, so doctor --fix never touches it; run: chmod 600 ~/.mdopener/ipc-token",
                        mode_of(&m)
                    ),
                });
            }
        }
        for sub in ["sessions", "reviews"] {
            let dir = root.join(sub);
            let Ok(m) = std::fs::symlink_metadata(&dir) else {
                continue;
            };
            if !m.is_dir() {
                tighten(&mut plan, &dir, 0o700);
                continue;
            }
            tighten(&mut plan, &dir, 0o700);
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut files: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "json"))
                .collect();
            files.sort();
            for file in files {
                let is_file = std::fs::symlink_metadata(&file).is_ok_and(|m| m.is_file());
                if sub == "reviews" && is_file {
                    if let Some(reason) = bad_review(&dir, &file) {
                        plan.fixes.push(PlannedFix::MoveAside { file, reason });
                        continue;
                    }
                }
                tighten(&mut plan, &file, 0o600);
            }
        }
        plan
    }
}

fn stamp(now: std::time::SystemTime) -> String {
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Civil date from days since the epoch (Howard Hinnant's algorithm).
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Copy `file` to a new `<file>.bak-<stamp>` (never over an existing file, 0600).
fn backup(file: &Path, now: std::time::SystemTime) -> std::io::Result<PathBuf> {
    use std::io::Write as _;
    let bytes = std::fs::read(file)?;
    let base = format!("{}.bak-{}", file.display(), stamp(now));
    for n in 0..100 {
        let target = PathBuf::from(if n == 0 {
            base.clone()
        } else {
            format!("{base}-{n}")
        });
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        match opts.open(&target) {
            Ok(mut f) => {
                f.write_all(&bytes)?;
                return Ok(target);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("no free backup name"))
}

/// Make each planned fix after checking it still applies to the file as it
/// is now; one that no longer does is skipped, never forced.
pub fn apply_fixes(root: &Path, plan: &FixPlan, now: std::time::SystemTime) -> FixOutcome {
    let current = plan_fixes(root);
    let mut results = Vec::new();
    for fix in &plan.fixes {
        let mut r = AppliedFix {
            fix: fix.clone(),
            applied: false,
            backup: None,
            previous_mode: None,
            message: None,
        };
        let still = current.fixes.iter().any(|f| match (f, fix) {
            (PlannedFix::TightenMode { file: a, .. }, PlannedFix::TightenMode { file: b, .. }) => {
                a == b
            }
            (PlannedFix::MoveAside { file: a, .. }, PlannedFix::MoveAside { file: b, .. }) => {
                a == b
            }
            _ => false,
        });
        if !still {
            r.message = Some("skipped: the file changed since the plan".into());
            results.push(r);
            continue;
        }
        match fix {
            #[cfg(unix)]
            PlannedFix::TightenMode {
                file, target_mode, ..
            } => {
                use std::os::unix::fs::PermissionsExt as _;
                let want = u32::from_str_radix(target_mode, 8).unwrap_or(0o600);
                let before = std::fs::symlink_metadata(file).map(|m| mode_of(&m));
                match before.and_then(|b| {
                    std::fs::set_permissions(file, std::fs::Permissions::from_mode(want)).map(|_| b)
                }) {
                    Ok(b) => {
                        r.applied = true;
                        r.previous_mode = Some(format!("{b:04o}"));
                    }
                    Err(e) => r.message = Some(format!("skipped: {e}")),
                }
            }
            #[cfg(not(unix))]
            PlannedFix::TightenMode { .. } => {
                r.message = Some("skipped: not supported on this platform".into());
            }
            PlannedFix::MoveAside { file, .. } => match backup(file, now) {
                Ok(saved) => {
                    let same = std::fs::read(file).ok() == std::fs::read(&saved).ok();
                    r.backup = Some(saved);
                    if !same {
                        r.message = Some("skipped: the file changed while it was backed up".into());
                    } else if let Err(e) = std::fs::remove_file(file) {
                        r.message = Some(format!("skipped: {e}"));
                    } else {
                        r.applied = true;
                    }
                }
                Err(e) => r.message = Some(format!("skipped: backup failed ({e}); not changed")),
            },
        }
        results.push(r);
    }
    FixOutcome { results }
}

/// The `--apply` refusal: it only means something with `--fix`.
pub const APPLY_WITHOUT_FIX: &str = "mdopener-mcp doctor: --apply needs --fix (doctor --fix previews, doctor --fix --apply repairs)";

/// Adds the shared `ashlr.doctor` v1 wrapper (ashlr-stack
/// docs/ashlr-handshake.md, "Doctor JSON") to `doctor --fix --json`.
/// Additive: `mode`, `plan` and `outcome` stay, and the exit code does not
/// change. Mapping: a fix skipped or refused on apply is fail; planned fixes
/// (dry run) or report-only findings are warn; nothing to do is ok.
fn add_doctor_envelope(
    v: &mut serde_json::Value,
    apply: bool,
    plan: &FixPlan,
    outcome: Option<&FixOutcome>,
) {
    let mut checks = Vec::new();
    match outcome {
        Some(o) => {
            for r in &o.results {
                checks.push(serde_json::json!({
                    "id": "fix",
                    "status": if r.applied { "ok" } else { "fail" },
                    "summary": r.fix.describe(),
                }));
            }
        }
        None => {
            for f in &plan.fixes {
                checks.push(serde_json::json!({
                    "id": "fix",
                    "status": "warn",
                    "summary": f.describe(),
                }));
            }
        }
    }
    for r in &plan.report_only {
        let id: String = r
            .code
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        checks.push(serde_json::json!({
            "id": id.trim_matches('-'),
            "status": "warn",
            "summary": r.message,
        }));
    }
    let status = if checks.iter().any(|c| c["status"] == "fail") {
        "fail"
    } else if checks.iter().any(|c| c["status"] == "warn") {
        "warn"
    } else {
        "ok"
    };
    if let Some(obj) = v.as_object_mut() {
        obj.insert("kind".into(), "ashlr.doctor".into());
        obj.insert("schema_version".into(), 1.into());
        obj.insert("tool".into(), "ashlr-md".into());
        obj.insert("status".into(), status.into());
        obj.insert(
            "native_status".into(),
            (if apply { "apply" } else { "dry_run" }).into(),
        );
        obj.insert("checks".into(), checks.into());
    }
}

/// Run `mdopener-mcp doctor <args>` and return (stdout text, exit code).
/// `args` are the arguments after `doctor`.
pub fn run(args: &[String], root: Option<&Path>) -> (String, String, i32) {
    let mut fix = false;
    let mut apply = false;
    let mut json = false;
    for a in args {
        match a.as_str() {
            "--fix" => fix = true,
            "--apply" => apply = true,
            "--json" => json = true,
            "--help" | "-h" => return (DOCTOR_HELP.to_string(), String::new(), 0),
            other => {
                return (
                    String::new(),
                    format!("mdopener-mcp doctor: unknown argument `{other}`\n{DOCTOR_HELP}"),
                    2,
                )
            }
        }
    }
    if apply && !fix {
        return (String::new(), format!("{APPLY_WITHOUT_FIX}\n"), 2);
    }
    if !fix {
        return (DOCTOR_HELP.to_string(), String::new(), 0);
    }
    let Some(root) = root else {
        return (
            String::new(),
            "mdopener-mcp doctor: no home directory; set HOME\n".into(),
            1,
        );
    };
    let plan = plan_fixes(root);
    let outcome = (apply && !plan.fixes.is_empty())
        .then(|| apply_fixes(root, &plan, std::time::SystemTime::now()));
    let failed = outcome.as_ref().is_some_and(|o| !o.all_applied());
    let code = i32::from(failed);
    if json {
        let mut v = serde_json::json!({
            "mode": if apply { "apply" } else { "dry_run" },
            "plan": plan,
            "outcome": outcome,
        });
        add_doctor_envelope(&mut v, apply, &plan, outcome.as_ref());
        return (
            format!("{}\n", serde_json::to_string_pretty(&v).unwrap_or_default()),
            String::new(),
            code,
        );
    }
    let mut out = String::new();
    if plan.fixes.is_empty() {
        out.push_str("doctor --fix: nothing to repair\n");
    } else if let Some(o) = &outcome {
        out.push_str("doctor --fix --apply:\n");
        for r in &o.results {
            let mark = if r.applied { "fixed  " } else { "skipped" };
            out.push_str(&format!("  {mark} {}\n", r.fix.describe()));
            if let Some(b) = &r.backup {
                out.push_str(&format!("          backup: {}\n", b.display()));
            }
            if let Some(m) = &r.previous_mode {
                out.push_str(&format!("          was mode {m}\n"));
            }
            if let Some(m) = &r.message {
                out.push_str(&format!("          {m}\n"));
            }
        }
    } else {
        out.push_str("doctor --fix (dry run, nothing written):\n");
        for f in &plan.fixes {
            out.push_str(&format!("  would fix  {}\n", f.describe()));
        }
        out.push_str("Run `mdopener-mcp doctor --fix --apply` to make these changes (a file's contents are backed up before it is moved).\n");
    }
    for r in &plan.report_only {
        out.push_str(&format!("  manual     {}\n", r.message));
    }
    (out, String::new(), code)
}

pub const DOCTOR_HELP: &str = "USAGE:
    mdopener-mcp doctor --fix [--json]          preview repairs to ~/.mdopener (writes nothing)
    mdopener-mcp doctor --fix --apply [--json]  make them (backups first; exit 1 if one was skipped)

Repairs: owner-only permissions on ~/.mdopener, its sessions and reviews and
their files, and ipc-port; saved reviews that are corrupt or oversized are
moved aside. ipc-token is never touched (reported if others can read it).
";
