//! `mdopener-mcp doctor --fix [--apply] [--json]` against the real binary,
//! HOME in a temp dir: preview writes nothing, apply repairs (a moved review
//! is backed up byte for byte), a second run has nothing to fix, refusals,
//! and the handshake's `doctor-fix` capability names flags that exist.
#![cfg(unix)]

use serde_json::Value;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

fn run(home: &Path, args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .args(args)
        .env("HOME", home)
        .output()
        .unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn mode(p: &Path) -> u32 {
    std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777
}

fn chmod(p: &Path, m: u32) {
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
}

/// A tree an older build left: loose modes, one corrupt saved review, and a
/// loose ipc-token that must never be touched.
fn broken_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".mdopener");
    std::fs::create_dir_all(root.join("sessions")).unwrap();
    std::fs::create_dir_all(root.join("reviews")).unwrap();
    std::fs::write(root.join("sessions").join("s1.json"), "{\"messages\":[]}").unwrap();
    std::fs::write(root.join("reviews").join("0123456789abcdef.json"), "{ oops").unwrap();
    std::fs::write(root.join("ipc-port"), "4242").unwrap();
    std::fs::write(root.join("ipc-token"), "not-a-real-token").unwrap();
    for p in [root.clone(), root.join("sessions"), root.join("reviews")] {
        chmod(&p, 0o755);
    }
    for p in [
        root.join("sessions").join("s1.json"),
        root.join("ipc-port"),
        root.join("ipc-token"),
    ] {
        chmod(&p, 0o644);
    }
    home
}

fn snapshot(root: &Path) -> Vec<(String, u32, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        out.push((d.display().to_string(), mode(&d), Vec::new()));
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push((
                    p.display().to_string(),
                    mode(&p),
                    std::fs::read(&p).unwrap(),
                ));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn preview_writes_nothing() {
    let home = broken_home();
    let root = home.path().join(".mdopener");
    let before = snapshot(&root);
    let (code, out, _) = run(home.path(), &["doctor", "--fix", "--json"]);
    assert_eq!(code, 0, "{out}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["mode"], "dry_run");
    assert!(v["outcome"].is_null());
    let kinds: Vec<&str> = v["plan"]["fixes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds.iter().filter(|k| **k == "tighten_mode").count(),
        5,
        "{out}"
    );
    assert_eq!(
        kinds.iter().filter(|k| **k == "move_aside").count(),
        1,
        "{out}"
    );
    let manual = v["plan"]["report_only"].as_array().unwrap();
    assert!(
        manual.iter().any(|r| r["code"] == "ipc_token_not_private"),
        "{out}"
    );
    assert!(!out.contains("not-a-real-token"));
    assert_eq!(snapshot(&root), before);
    // Text preview too.
    let (code, out, _) = run(home.path(), &["doctor", "--fix"]);
    assert_eq!(code, 0);
    assert!(out.contains("would fix") && out.contains("manual"), "{out}");
    assert_eq!(snapshot(&root), before);
}

#[test]
fn apply_repairs_backs_up_and_a_second_run_has_nothing_to_fix() {
    let home = broken_home();
    let root = home.path().join(".mdopener");
    let review = root.join("reviews").join("0123456789abcdef.json");
    let (code, out, _) = run(home.path(), &["doctor", "--fix", "--apply", "--json"]);
    assert_eq!(code, 0, "{out}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["mode"], "apply");
    let results = v["outcome"]["results"].as_array().unwrap();
    assert!(results.iter().all(|r| r["applied"] == true), "{out}");
    let moved = results
        .iter()
        .find(|r| r["fix"]["kind"] == "move_aside")
        .unwrap();
    let backup = Path::new(moved["backup"].as_str().unwrap());
    assert_eq!(std::fs::read(backup).unwrap(), b"{ oops");
    assert_eq!(mode(backup), 0o600);
    assert!(!review.exists());
    assert!(results
        .iter()
        .filter(|r| r["fix"]["kind"] == "tighten_mode")
        .all(|r| r["previous_mode"].is_string()));

    assert_eq!(mode(&root), 0o700);
    assert_eq!(mode(&root.join("sessions")), 0o700);
    assert_eq!(mode(&root.join("reviews")), 0o700);
    assert_eq!(mode(&root.join("sessions").join("s1.json")), 0o600);
    assert_eq!(mode(&root.join("ipc-port")), 0o600);
    // The secret is never touched: same mode, same bytes.
    assert_eq!(mode(&root.join("ipc-token")), 0o644);
    assert_eq!(
        std::fs::read(root.join("ipc-token")).unwrap(),
        b"not-a-real-token"
    );
    // Contents of repaired files are unchanged.
    assert_eq!(std::fs::read(root.join("ipc-port")).unwrap(), b"4242");

    let (code, out, _) = run(home.path(), &["doctor", "--fix", "--apply"]);
    assert_eq!(code, 0);
    assert!(out.contains("nothing to repair"), "{out}");
    assert!(
        out.contains("chmod 600"),
        "the token stays a manual item: {out}"
    );
}

#[test]
fn a_valid_saved_review_is_kept() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".mdopener");
    let reviews = root.join("reviews");
    std::fs::create_dir_all(&reviews).unwrap();
    chmod(&root, 0o700);
    chmod(&reviews, 0o700);
    let doc = home.path().join("plan.md");
    std::fs::write(&doc, "# Plan\n").unwrap();
    let path = doc.to_str().unwrap();
    let mut hasher: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.as_bytes() {
        hasher ^= u64::from(*b);
        hasher = hasher.wrapping_mul(0x0100_0000_01b3);
    }
    let file = reviews.join(format!("{hasher:016x}.json"));
    let rec = serde_json::json!({
        "schema": 1, "path": path, "reviewId": "r", "verdict": "approved",
        "comments": null, "late": false, "supersededBy": null,
        "createdAt": 1, "decidedAt": 2, "contentHash": null
    });
    std::fs::write(&file, rec.to_string()).unwrap();
    chmod(&file, 0o600);
    let (code, out, _) = run(home.path(), &["doctor", "--fix", "--apply"]);
    assert_eq!(code, 0);
    assert!(out.contains("nothing to repair"), "{out}");
    assert!(file.exists());
}

#[test]
fn refusals_and_no_state_dir() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = run(home.path(), &["doctor", "--apply"]);
    assert_eq!(code, 2);
    assert!(out.is_empty());
    assert!(err.contains("--apply needs --fix"), "{err}");
    let (code, _, err) = run(home.path(), &["doctor", "--fix", "--bogus"]);
    assert_eq!(code, 2);
    assert!(err.contains("unknown argument"), "{err}");
    // No ~/.mdopener yet: nothing to repair, nothing created.
    let (code, out, _) = run(home.path(), &["doctor", "--fix", "--apply"]);
    assert_eq!(code, 0);
    assert!(out.contains("nothing to repair"));
    assert!(!home.path().join(".mdopener").exists());
}

#[test]
fn handshake_doctor_fix_names_flags_that_exist() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, _) = run(home.path(), &["--ashlr-handshake", "--json"]);
    assert_eq!(code, 0);
    let v: Value = serde_json::from_str(out.trim()).unwrap();
    let caps: Vec<&str> = v["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap())
        .collect();
    assert!(caps.contains(&"doctor-fix"), "{caps:?}");
    let (code, help, _) = run(home.path(), &["doctor", "--help"]);
    assert_eq!(code, 0);
    assert!(help.contains("--fix") && help.contains("--apply") && help.contains("--json"));
    let (_, main_help, _) = run(home.path(), &["--help"]);
    assert!(main_help.contains("doctor --fix"), "{main_help}");
}

#[test]
fn a_fix_made_stale_between_plan_and_apply_is_skipped() {
    let home = broken_home();
    let root = home.path().join(".mdopener");
    let plan = mdopener_mcp::doctor_fix::plan_fixes(&root);
    // Fixed by hand after the preview.
    chmod(&root.join("ipc-port"), 0o600);
    std::fs::remove_file(root.join("reviews").join("0123456789abcdef.json")).unwrap();
    let out = mdopener_mcp::doctor_fix::apply_fixes(&root, &plan, std::time::SystemTime::now());
    assert!(!out.all_applied());
    let skipped: Vec<_> = out.results.iter().filter(|r| !r.applied).collect();
    assert_eq!(skipped.len(), 2, "{:?}", out.results);
    assert!(skipped.iter().all(|r| r.backup.is_none()));
}
