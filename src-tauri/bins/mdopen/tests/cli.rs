//! Process-level checks of the `mdopen` binary's informational flags.

use std::process::Command;

/// The app version the sidecar ships with.
fn app_version() -> String {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../../../tauri.conf.json")).unwrap();
    conf["version"].as_str().unwrap().to_string()
}

#[test]
fn version_prints_the_app_version_and_exits_0() {
    for flag in ["--version", "-V"] {
        let out = Command::new(env!("CARGO_BIN_EXE_mdopen"))
            .arg(flag)
            .output()
            .unwrap();
        assert!(out.status.success(), "{flag}: {out:?}");
        let stdout = String::from_utf8(out.stdout).unwrap();
        assert_eq!(stdout.trim(), format!("mdopen {}", app_version()), "{flag}");
        assert_eq!(
            env!("CARGO_PKG_VERSION"),
            app_version(),
            "crate version drifted from the app"
        );
    }
}

#[test]
fn help_exits_0() {
    let out = Command::new(env!("CARGO_BIN_EXE_mdopen"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(out.status.success());
    let help = String::from_utf8(out.stdout).unwrap();
    assert!(help.contains("--version"));
    // No em or en dash in user-facing text.
    assert!(
        !help.contains('\u{2014}') && !help.contains('\u{2013}'),
        "{help}"
    );
}

/// `--hook` used to win over `--help`: `mdopen --hook --help` read stdin as
/// a hook payload and printed nothing. The help wins, on stdout, exit 0.
#[test]
fn help_wins_over_hook() {
    for argv in [["--hook", "--help"], ["--help", "--hook"]] {
        let out = Command::new(env!("CARGO_BIN_EXE_mdopen"))
            .args(argv)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success(), "{argv:?}: {out:?}");
        let help = String::from_utf8(out.stdout).unwrap();
        assert!(help.contains("USAGE:"), "{argv:?}: {help}");
    }
}

/// `--help` and `--version` printed with `print!`, which panics when stdout
/// cannot be written: exit 101 and a backtrace for `mdopen --help | head -1`
/// once the reader had closed, or for a full disk. A closed reader now exits
/// 0 in silence, and a failed write says so on stderr with exit 1.
#[cfg(target_os = "linux")]
#[test]
fn help_and_version_to_an_unwritable_stdout_do_not_panic() {
    for flag in ["--help", "--version"] {
        let full = std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/full")
            .unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_mdopen"))
            .arg(flag)
            .stdout(full)
            .stderr(std::process::Stdio::piped())
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(1), "{flag}: {stderr}");
        assert!(
            stderr.starts_with("mdopen: cannot write to stdout:"),
            "{flag}: {stderr}"
        );
        assert!(!stderr.contains("panicked"), "{flag}: {stderr}");

        let (reader, writer) = std::io::pipe().unwrap();
        drop(reader);
        let out = Command::new(env!("CARGO_BIN_EXE_mdopen"))
            .arg(flag)
            .stdout(writer)
            .stderr(std::process::Stdio::piped())
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(0), "{flag}: {out:?}");
        assert!(out.stderr.is_empty(), "{flag}: {out:?}");
    }
}

/// With no arguments there is nothing to open: the help goes to stderr and
/// the exit is 1, so a script that passed an empty variable sees a failure.
#[test]
fn no_arguments_is_a_usage_error() {
    let out = Command::new(env!("CARGO_BIN_EXE_mdopen")).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert!(out.stdout.is_empty(), "{out:?}");
    assert!(String::from_utf8(out.stderr).unwrap().contains("USAGE:"));
}

/// A fresh scratch directory, removed on drop.
struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("mdopen-cli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
    fn sub(&self, name: &str) -> std::path::PathBuf {
        let p = self.0.join(name);
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `mdopen` with an isolated HOME and TMPDIR, and a PATH holding no URL
/// launcher (a headless box), so no real app or launcher is ever reached.
#[cfg(unix)]
fn headless(s: &Scratch) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_mdopen"));
    c.env("HOME", s.sub("home"))
        .env("USERPROFILE", s.sub("home"))
        .env("TMPDIR", s.sub("tmp"))
        .env("PATH", s.sub("bin"));
    c
}

/// When nothing can open the piped content, the temp file holding it is
/// removed instead of being left in the temp dir.
#[cfg(unix)]
#[test]
fn stdin_temp_file_is_removed_when_the_open_fails() {
    use std::io::Write as _;
    let s = Scratch::new("stdin-fail");
    let mut child = headless(&s)
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"# private\n")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let left: Vec<_> = std::fs::read_dir(s.0.join("tmp")).unwrap().collect();
    assert!(left.is_empty(), "temp files left behind: {left:?}");
}

/// `mdopen -` with nothing on stdin refuses instead of opening an empty temp
/// document, and leaves no temp file behind.
#[cfg(unix)]
#[test]
fn empty_stdin_is_refused() {
    for input in [&b""[..], &b" \n\t\n"[..]] {
        use std::io::Write as _;
        let s = Scratch::new("stdin-empty");
        let mut child = headless(&s)
            .arg("-")
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let out = child.wait_with_output().unwrap();
        assert_eq!(out.status.code(), Some(1), "{out:?}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains("stdin was empty"), "stderr: {err}");
        let left: Vec<_> = std::fs::read_dir(s.0.join("tmp")).unwrap().collect();
        assert!(left.is_empty(), "temp files left behind: {left:?}");
    }
}

/// `mdopen -- -` read stdin like `mdopen -`. After `--`, `-` is a file
/// named `-`: here one that is not a Markdown document, so it is refused by
/// name, and stdin is never read.
#[cfg(unix)]
#[test]
fn a_dash_after_double_dash_is_a_file_not_stdin() {
    let s = Scratch::new("dash-file");
    let cwd = s.sub("cwd");
    std::fs::write(cwd.join("-"), "# a file named dash\n").unwrap();
    let out = headless(&s)
        .current_dir(&cwd)
        .args(["--", "-"])
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("is not a Markdown document"), "stderr: {err}");
    assert!(!err.contains("stdin"), "stderr: {err}");
}

/// `mdopen -` reads at most the 16 MiB a document may be: past it, it exits 1
/// saying so before writing a temp file or trying to open anything. Stdin was
/// read whole before, however much was piped in.
#[cfg(unix)]
#[test]
fn stdin_over_the_document_limit_is_refused() {
    use std::io::Write as _;
    let s = Scratch::new("stdin-cap");
    let mut child = headless(&s)
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        // One byte past 16 MiB; mdopen may stop reading (closing the pipe)
        // as soon as it has seen enough.
        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..16 {
            if stdin.write_all(&chunk).is_err() {
                return;
            }
        }
        let _ = stdin.write_all(b"x");
    });
    let out = child.wait_with_output().unwrap();
    writer.join().unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("more than the 16 MiB"), "stderr: {err}");
    assert!(err.contains("nothing was opened"), "stderr: {err}");
    let left: Vec<_> = std::fs::read_dir(s.0.join("tmp")).unwrap().collect();
    assert!(left.is_empty(), "temp files left behind: {left:?}");
}

/// With the app running (port + token files present) the file is opened over
/// its IPC server, with no URL launcher needed: the common Linux case where
/// `mdopener://` is not registered.
#[cfg(unix)]
#[test]
fn opens_through_the_running_app_without_a_url_launcher() {
    use std::io::{Read as _, Write as _};
    let s = Scratch::new("ipc");
    let file = s.0.join("plan.md");
    std::fs::write(&file, "# plan\n").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dot = s.sub("home").join(".mdopener");
    std::fs::create_dir_all(&dot).unwrap();
    std::fs::write(
        dot.join("ipc-port"),
        listener.local_addr().unwrap().port().to_string(),
    )
    .unwrap();
    std::fs::write(dot.join("ipc-token"), "secret-token").unwrap();
    let app = std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        sock.set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut buf = [0u8; 8192];
        let mut req = Vec::new();
        while !String::from_utf8_lossy(&req).contains("}") {
            let n = sock.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            req.extend_from_slice(&buf[..n]);
        }
        sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}")
            .unwrap();
        String::from_utf8(req).unwrap()
    });
    let out = headless(&s).args(["--edit"]).arg(&file).output().unwrap();
    assert!(out.status.success(), "{out:?}");
    let req = app.join().unwrap();
    assert!(req.starts_with("POST /open "), "{req}");
    assert!(req.contains("Bearer secret-token"), "{req}");
    let canon = std::fs::canonicalize(&file).unwrap();
    let body: serde_json::Value =
        serde_json::from_str(req.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["path"], canon.to_str().unwrap());
    assert_eq!(body["mode"], "edit");
}

/// A running app that refuses the token (HTTP 401) sends the open to the
/// URL scheme. When that launch succeeded, the stale token went unreported,
/// so every later open took the slower route in silence. It is now a warning
/// on stderr naming the fix; the open still exits 0.
#[cfg(target_os = "linux")]
#[test]
fn a_refused_token_is_reported_even_when_the_url_scheme_opens_the_file() {
    use std::io::{Read as _, Write as _};
    use std::os::unix::fs::PermissionsExt as _;
    let s = Scratch::new("stale-token");
    let file = s.0.join("plan.md");
    std::fs::write(&file, "# plan\n").unwrap();
    // A URL launcher that takes the URL and exits 0.
    let launcher = s.sub("bin").join("xdg-open");
    std::fs::write(&launcher, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dot = s.sub("home").join(".mdopener");
    std::fs::create_dir_all(&dot).unwrap();
    std::fs::write(
        dot.join("ipc-port"),
        listener.local_addr().unwrap().port().to_string(),
    )
    .unwrap();
    std::fs::write(dot.join("ipc-token"), "stale-token").unwrap();
    let app = std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        sock.set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut buf = [0u8; 8192];
        let mut req = Vec::new();
        while !String::from_utf8_lossy(&req).contains("}") {
            let n = sock.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            req.extend_from_slice(&buf[..n]);
        }
        sock.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}")
            .unwrap();
    });
    // `/bin/sh` for the launcher script, nothing else on PATH.
    let path = format!("{}:/bin:/usr/bin", s.sub("bin").display());
    let out = headless(&s).env("PATH", path).arg(&file).output().unwrap();
    app.join().unwrap();
    assert!(out.status.success(), "{out:?}");
    let err = String::from_utf8(out.stderr).unwrap();
    assert_eq!(
        err,
        "mdopen: IPC auth failed: Ashlr MD refused the token in ~/.mdopener/ipc-token \
         (HTTP 401), which is stale or belongs to another Ashlr MD instance; quit every \
         Ashlr MD window and start it again, which writes a new token. The file was opened \
         through the mdopener:// URL instead.\n"
    );
}

/// `mdopen --hook` run by hand with a terminal on stdin read it to EOF, so it
/// waited in silence until Ctrl+D. It now prints a hint and exits 0 at once.
/// Needs util-linux `script` for a pseudo-terminal; skipped without it.
#[cfg(target_os = "linux")]
#[test]
fn hook_with_a_terminal_on_stdin_exits_with_a_hint() {
    use std::io::Read as _;
    let s = Scratch::new("hook-tty");
    let cmd = format!("'{}' --hook", env!("CARGO_BIN_EXE_mdopen"));
    // `script` runs the command on a pty; its own stdin stays open (piped,
    // never written), so the hook would wait forever if it read the terminal.
    let Ok(mut child) = Command::new("script")
        .args(["-qec", &cmd, "/dev/null"])
        .env("HOME", s.sub("home"))
        .env("USERPROFILE", s.sub("home"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        eprintln!("skipped: no `script` to provide a terminal");
        return;
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("mdopen --hook waited on the terminal instead of exiting");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    assert!(status.success(), "{status:?}");
    let mut out = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    assert!(out.contains("nothing was piped in"), "{out:?}");
}

/// When the app is not running and no launcher can start it, the error names
/// the file, what each route hit, and what to do next. Before, it read
/// `no URL launcher found (...) (Ashlr MD is not running (no ...))`, with no
/// next step.
#[cfg(unix)]
#[test]
fn failed_open_names_the_file_both_routes_and_the_next_step() {
    let s = Scratch::new("open-fail");
    let file = s.0.join("plan.md");
    std::fs::write(&file, "# plan\n").unwrap();
    let out = headless(&s).arg(&file).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let err = String::from_utf8(out.stderr).unwrap();
    let canon = std::fs::canonicalize(&file).unwrap();
    assert!(
        err.contains(&format!("could not open {} in Ashlr MD", canon.display())),
        "{err}"
    );
    assert!(
        err.contains("The running app: Ashlr MD is not running"),
        "{err}"
    );
    assert!(
        err.contains("The mdopener:// URL: no URL launcher found"),
        "{err}"
    );
    assert!(
        err.trim_end().ends_with(
            "Start Ashlr MD (or install it from \
             https://github.com/ashlrai/ashlr-md/releases), then run mdopen again."
        ),
        "{err}"
    );
}

/// An argument that is not valid UTF-8 used to panic in `std::env::args`
/// (exit 101 and a backtrace), `--hook` included. It is now a usage error,
/// with `--hook` too, which takes no other arguments.
#[cfg(unix)]
#[test]
fn an_argument_that_is_not_utf8_is_a_usage_error_not_a_panic() {
    use std::os::unix::ffi::OsStrExt as _;
    let s = Scratch::new("not-utf8");
    let bad = std::ffi::OsStr::from_bytes(b"\xffnotes.md");

    let out = headless(&s).arg(bad).output().unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("is not valid UTF-8"), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");

    let out = headless(&s)
        .args([std::ffi::OsStr::new("--hook"), bad])
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("--hook takes no other arguments"),
        "{stderr}"
    );
    assert!(!stderr.contains("panicked"), "{stderr}");
}

/// `mdopen --hook extra.md` ignored the argument and ran the hook as usual.
/// It is now refused on stderr with exit 1 before stdin is read, and
/// `mdopen --hook` alone still exits 0 in silence.
#[cfg(unix)]
#[test]
fn hook_with_an_extra_argument_is_refused() {
    use std::io::Write as _;
    let s = Scratch::new("hook-extra");
    let file = s.0.join("extra.md");
    std::fs::write(&file, "# extra\n").unwrap();
    let out = headless(&s)
        .args(["--hook", "extra.md"])
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert!(out.stdout.is_empty(), "{out:?}");
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(
        stderr.starts_with("mdopen: --hook takes no other arguments, got \"extra.md\":"),
        "{stderr}"
    );

    let mut child = headless(&s)
        .arg("--hook")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let payload = serde_json::json!({
        "hook_event_name": "PostToolUse",
        "tool_name": "Write",
        "tool_input": { "file_path": file },
        "tool_response": { "success": true }
    });
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert!(out.stdout.is_empty() && out.stderr.is_empty(), "{out:?}");
}
