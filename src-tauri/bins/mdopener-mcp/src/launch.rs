//! Hand an `mdopener://` URL to the OS URL launcher without hanging or
//! writing to our stdout.
//!
//! Callers (a terminal, a Claude Code hook, Phantom) need an honest answer:
//! "the launcher accepted the URL", "the launcher failed", "no launcher exists"
//! (a headless Linux box), or "the launcher is still running after the
//! deadline". A launcher is never waited on forever: on Linux `xdg-open` can
//! fall back to a terminal browser or block until the opened app exits.
//!
//! This module is mirrored from `mdopen/src/launch.rs`; keep them in sync.

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
    /// A launcher was ended by a signal (Unix), its number in `signal`. It
    /// used to be reported as having "exited with status signal".
    Killed {
        launcher: String,
        signal: Option<i32>,
    },
    /// A launcher exists but could not be started (not executable, say).
    /// It used to be reported as one that "exited with status signal".
    Unstartable { launcher: String, error: String },
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
            // It used to end in a question ("is Ashlr MD installed ...?")
            // that left the reader to guess; it now states the likely causes.
            Launch::Failed {
                launcher,
                code: Some(c),
            } => format!(
                "`{launcher}` exited with status {c}: Ashlr MD may not be installed (nothing \
                 handles mdopener:// URLs), or there is no desktop session"
            ),
            Launch::Failed {
                launcher,
                code: None,
            } => format!(
                "`{launcher}` failed, and its exit status could not be read: Ashlr MD may not \
                 be installed (nothing handles mdopener:// URLs), or there is no desktop session"
            ),
            Launch::Killed {
                launcher,
                signal: Some(n),
            } => match signal_name(*n) {
                Some(name) => format!("`{launcher}` was killed by signal {n} ({name})"),
                None => format!("`{launcher}` was killed by signal {n}"),
            },
            Launch::Killed {
                launcher,
                signal: None,
            } => format!("`{launcher}` was killed by a signal"),
            Launch::Unstartable { launcher, error } => {
                format!("`{launcher}` could not be started: {error}")
            }
            Launch::NoLauncher { tried } => format!(
                "no URL launcher found (tried {}); a desktop session is required to open Ashlr MD",
                tried.join(", ")
            ),
        }
    }
}

/// The name of a common Unix signal, for [`Launch::describe`].
fn signal_name(n: i32) -> Option<&'static str> {
    Some(match n {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => return None,
    })
}

/// The signal that ended a process, on Unix.
fn exit_signal(status: std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        status.signal()
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

/// The launcher commands to try, in order, for the host OS.
pub fn launchers(url: &str) -> Vec<(String, Vec<String>)> {
    launchers_for(std::env::consts::OS, url)
}

/// The launcher commands to try for `os` (a `std::env::consts::OS` value).
/// Pure, so every platform's argv is testable on any host.
pub fn launchers_for(os: &str, url: &str) -> Vec<(String, Vec<String>)> {
    let url = url.to_string();
    match os {
        "macos" => vec![("open".into(), vec![url])],
        // Never go through `cmd /C start`: cmd treats the `&` between query
        // parameters as a command separator, so `...?path=x&mode=read` would
        // run `mode=read` as a second command. `rundll32` is spawned directly
        // (CreateProcess, no shell) and hands the URL to the registered
        // scheme handler. The URL is percent-encoded, so it has no spaces or
        // quotes for Rust's argument quoting to alter.
        "windows" => vec![(
            "rundll32".into(),
            vec!["url.dll,FileProtocolHandler".into(), url],
        )],
        _ => vec![
            ("xdg-open".into(), vec![url.clone()]),
            ("gio".into(), vec!["open".into(), url]),
        ],
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
            Err(e) => {
                return Launch::Unstartable {
                    launcher: display_name(prog),
                    error: e.to_string(),
                }
            }
        };
        let launcher = display_name(prog);
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Launch::Opened { launcher },
                Ok(Some(status)) => {
                    return match status.code() {
                        Some(code) => Launch::Failed {
                            launcher,
                            code: Some(code),
                        },
                        None => Launch::Killed {
                            launcher,
                            signal: exit_signal(status),
                        },
                    }
                }
                Ok(None) if start.elapsed() >= deadline => {
                    // Reap it in the background so a long-lived caller
                    // (mdopener-mcp) does not accumulate zombies.
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                    return Launch::Pending { launcher };
                }
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
            let dir = std::env::temp_dir()
                .join(format!("mdopener-mcp-launch-{name}-{}", std::process::id()));
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
        let why = r.describe();
        assert!(why.contains("status 4"), "{why}");
        assert!(why.contains("may not be installed"), "{why}");
        assert!(!why.contains('?'), "{why}");
    }

    #[test]
    fn a_launcher_killed_by_a_signal_says_which() {
        let s = Scratch::new("killed");
        let r = run_first(
            &one(s.script("xdg-open", "kill -9 $$")),
            Duration::from_secs(5),
            false,
        );
        assert_eq!(
            r,
            Launch::Killed {
                launcher: "xdg-open".into(),
                signal: Some(9)
            }
        );
        let why = r.describe();
        assert_eq!(why, "`xdg-open` was killed by signal 9 (SIGKILL)");
        let r = run_first(
            &one(s.script("xdg-open", "kill -TERM $$")),
            Duration::from_secs(5),
            false,
        );
        assert_eq!(r.describe(), "`xdg-open` was killed by signal 15 (SIGTERM)");
        let other = Launch::Killed {
            launcher: "gio".into(),
            signal: Some(40),
        };
        assert_eq!(other.describe(), "`gio` was killed by signal 40");
        let unknown = Launch::Failed {
            launcher: "gio".into(),
            code: None,
        };
        assert!(
            !unknown.describe().contains("signal"),
            "{}",
            unknown.describe()
        );
    }

    #[test]
    fn a_launcher_that_cannot_be_started_says_so() {
        let s = Scratch::new("unstartable");
        let prog = s.script("xdg-open", "exit 0");
        std::fs::set_permissions(&prog, std::fs::Permissions::from_mode(0o644)).unwrap();
        let r = run_first(&one(prog), Duration::from_secs(5), false);
        let why = r.describe();
        assert!(
            matches!(&r, Launch::Unstartable { launcher, .. } if launcher == "xdg-open"),
            "{r:?}"
        );
        assert!(
            why.starts_with("`xdg-open` could not be started: "),
            "{why}"
        );
        assert!(!why.contains("status"), "{why}");
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
    fn windows_launcher_bypasses_cmd_and_keeps_the_whole_url() {
        let url = "mdopener://open?path=%2Fx.md&mode=read";
        let l = launchers_for("windows", url);
        assert_eq!(
            l,
            vec![(
                "rundll32".to_string(),
                vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()]
            )]
        );
        assert!(l.iter().all(|(prog, _)| prog != "cmd"));
    }

    #[test]
    fn macos_launcher_is_open() {
        assert_eq!(
            launchers_for("macos", "mdopener://x"),
            vec![("open".to_string(), vec!["mdopener://x".to_string()])]
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
