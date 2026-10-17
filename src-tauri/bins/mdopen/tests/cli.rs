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
    assert!(String::from_utf8(out.stdout).unwrap().contains("--version"));
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
