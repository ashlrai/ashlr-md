//! Hand an `mdopener://` URL to the OS URL launcher without hanging or
//! writing to our stdout.
//!
//! Callers (a terminal, a Claude Code hook, Phantom) need an honest answer:
//! "the launcher accepted the URL", "the launcher failed", "no launcher exists"
//! (a headless Linux box), or "the launcher is still running after the
//! deadline". A launcher is never waited on forever: on Linux `xdg-open` can
//! fall back to a terminal browser or block until the opened app exits.
//!
//! This module is mirrored in `mdopener-mcp/src/launch.rs`; keep them in sync.

use std::io::ErrorKind;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Result of trying to launch a URL.
#[derive(Debug, PartialEq, Eq)]
pub enum Launch {
    /// A launcher ran and exited 0.
    Opened { launcher: String },
    /// A launcher is still running at the deadline. It was left running; the
    /// open is not confirmed.
    Pending { launcher: String },
    /// A launcher ran and exited non-zero (e.g. no handler registered for the
    /// `mdopener://` scheme, or no display).
    Failed { launcher: String, code: Option<i32> },
    /// None of the platform's launchers exist on this machine.
    NoLauncher { tried: Vec<String> },
}

impl Launch {
    /// One-line, human-readable description.
    pub fn describe(&self) -> String {
        match self {
            Launch::Opened { launcher } => format!("opened via `{launcher}`"),
            Launch::Pending { launcher } => {
                format!("`{launcher}` is still running; the open is not confirmed")
            }
            Launch::Failed { launcher, code } => format!(
                "`{launcher}` exited with status {} (is Ashlr MD installed and a desktop session available?)",
                code.map_or_else(|| "signal".to_string(), |c| c.to_string())
            ),
            Launch::NoLauncher { tried } => format!(
                "no URL launcher found (tried {}); a desktop session is required to open Ashlr MD",
                tried.join(", ")
            ),
        }
    }
}

/// The launcher commands to try, in order, for the host OS.
pub fn launchers(url: &str) -> Vec<(String, Vec<String>)> {
    let url = url.to_string();
    if cfg!(target_os = "macos") {
        vec![("open".into(), vec![url])]
    } else if cfg!(windows) {
        // `start` is a cmd built-in; "" is the window title it requires.
        vec![(
            "cmd".into(),
            vec!["/C".into(), "start".into(), String::new(), url],
        )]
    } else {
        vec![
            ("xdg-open".into(), vec![url.clone()]),
            ("gio".into(), vec!["open".into(), url]),
        ]
    }
}

/// Launch `url` with the host's launchers, waiting at most `deadline` for the
/// one that starts. The launcher never inherits our stdin or stdout (stdout is
/// a protocol channel for hooks and MCP); its stderr is inherited only when
/// `inherit_stderr` is set.
pub fn launch_url(url: &str, deadline: Duration, inherit_stderr: bool) -> Launch {
    run_first(&launchers(url), deadline, inherit_stderr)
}

/// Run the first launcher that exists. A launcher missing from `PATH` moves on
/// to the next one; any other spawn error counts as a failure of that one.
pub fn run_first(
    candidates: &[(String, Vec<String>)],
    deadline: Duration,
    inherit_stderr: bool,
) -> Launch {
    let mut tried = Vec::new();
    for (prog, args) in candidates {
        let spawned = Command::new(prog)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(if inherit_stderr {
                Stdio::inherit()
            } else {
                Stdio::null()
            })
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                tried.push(display_name(prog));
                continue;
            }
            Err(_) => {
                return Launch::Failed {
                    launcher: display_name(prog),
                    code: None,
                }
            }
        };
        let launcher = display_name(prog);
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Launch::Opened { launcher },
                Ok(Some(status)) => {
                    return Launch::Failed {
                        launcher,
                        code: status.code(),
                    }
                }
                Ok(None) if start.elapsed() >= deadline => return Launch::Pending { launcher },
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(_) => {
                    return Launch::Failed {
                        launcher,
                        code: None,
                    }
                }
            }
        }
    }
    Launch::NoLauncher { tried }
}

fn display_name(prog: &str) -> String {
    Path::new(prog)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| prog.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    /// Writing a script while another test thread forks can make exec fail
    /// with ETXTBSY; tests that write and run scripts take this lock.
    static EXEC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct Scratch(
        PathBuf,
        #[allow(dead_code)] std::sync::MutexGuard<'static, ()>,
    );

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("mdopen-launch-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let guard = EXEC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            Scratch(dir, guard)
        }

        /// A fake launcher script; the real OS launchers are never run here.
        fn script(&self, name: &str, body: &str) -> String {
            let path = self.0.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn one(prog: String) -> Vec<(String, Vec<String>)> {
        vec![(prog, vec!["mdopener://open?path=%2Fx.md".into()])]
    }

    #[test]
    fn success_is_opened() {
        let s = Scratch::new("ok");
        let r = run_first(
            &one(s.script("xdg-open", "exit 0")),
            Duration::from_secs(5),
            false,
        );
        assert_eq!(
            r,
            Launch::Opened {
                launcher: "xdg-open".into()
            }
        );
    }

    #[test]
    fn nonzero_exit_is_failed_with_code() {
        let s = Scratch::new("fail");
        let r = run_first(
            &one(s.script("xdg-open", "exit 4")),
            Duration::from_secs(5),
            false,
        );
        assert_eq!(
            r,
            Launch::Failed {
                launcher: "xdg-open".into(),
                code: Some(4)
            }
        );
        assert!(r.describe().contains("status 4"));
    }

    #[test]
    fn hanging_launcher_returns_pending_at_the_deadline() {
        let s = Scratch::new("hang");
        let start = Instant::now();
        let r = run_first(
            &one(s.script("xdg-open", "sleep 30")),
            Duration::from_millis(300),
            false,
        );
        assert_eq!(
            r,
            Launch::Pending {
                launcher: "xdg-open".into()
            }
        );
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "must not wait for the launcher"
        );
    }

    #[test]
    fn missing_launcher_falls_through_to_the_next() {
        let s = Scratch::new("fallback");
        let missing = s.0.join("no-such-xdg-open").to_string_lossy().into_owned();
        let gio = s.script("gio", "[ \"$1\" = open ] || exit 9");
        let candidates = vec![
            (missing, vec!["u".into()]),
            (gio, vec!["open".into(), "u".into()]),
        ];
        assert_eq!(
            run_first(&candidates, Duration::from_secs(5), false),
            Launch::Opened {
                launcher: "gio".into()
            }
        );
    }

    #[test]
    fn no_launcher_at_all_is_reported() {
        let s = Scratch::new("none");
        let a = s.0.join("xdg-open").to_string_lossy().into_owned();
        let b = s.0.join("gio").to_string_lossy().into_owned();
        let r = run_first(&[(a, vec![]), (b, vec![])], Duration::from_secs(1), false);
        assert_eq!(
            r,
            Launch::NoLauncher {
                tried: vec!["xdg-open".into(), "gio".into()]
            }
        );
        assert!(r.describe().contains("desktop session"));
    }

    #[test]
    fn launcher_cannot_read_our_stdin() {
        // A launcher that reads stdin must see EOF immediately, not block.
        let s = Scratch::new("stdin");
        let r = run_first(
            &one(s.script("xdg-open", "cat >/dev/null; exit 0")),
            Duration::from_secs(5),
            false,
        );
        assert_eq!(
            r,
            Launch::Opened {
                launcher: "xdg-open".into()
            }
        );
    }

    #[test]
    fn linux_launchers_are_xdg_open_then_gio() {
        if cfg!(target_os = "linux") {
            let l = launchers("mdopener://x");
            assert_eq!(l[0].0, "xdg-open");
            assert_eq!(
                l[1],
                (
                    "gio".to_string(),
                    vec!["open".to_string(), "mdopener://x".to_string()]
                )
            );
        }
    }
}
