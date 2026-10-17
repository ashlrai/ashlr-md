//! Open a file through the running app's loopback IPC server (`POST /open`),
//! the same channel `mdopener-mcp` uses. This works where the `mdopener://`
//! URL scheme does not: on Linux the scheme is often unregistered (AppImage,
//! a dev build), or there is no `xdg-open`, yet the app is running.
//!
//! The app writes its port to `~/.mdopener/ipc-port` and a bearer token to
//! `~/.mdopener/ipc-token` on startup and removes them on exit.

use std::io::{Read as _, Write as _};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const IO_TIMEOUT: Duration = Duration::from_secs(3);

/// The user's home directory, as the app (via `dirs::home_dir`) sees it.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|h| !h.is_empty()))
        .map(PathBuf::from)
}

/// Ask the running app to open `abs_path`. `Err` says why it could not: the
/// app is not running or the token was refused (the caller then falls back to
/// the URL scheme), or the app refused the file.
pub fn open(home: &Path, abs_path: &str, mode: Option<&str>) -> Result<(), Failure> {
    send_open(home, abs_path, mode).map_err(Failure::Unreachable)?
}

/// Why [`open`] did not open the file.
#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    /// The app could not be reached or did not accept the token; the URL
    /// scheme may still reach (or start) it.
    Unreachable(String),
    /// The running app refused the request, with its reason. The URL scheme
    /// would reach the same app, so there is nothing to fall back to.
    Refused(String),
}

/// POST `/open`. The outer `Err` is an unreachable app; the inner result is
/// the app's answer.
fn send_open(
    home: &Path,
    abs_path: &str,
    mode: Option<&str>,
) -> Result<Result<(), Failure>, String> {
    let dir = home.join(".mdopener");
    let port: u16 = std::fs::read_to_string(dir.join("ipc-port"))
        .map_err(|_| "Ashlr MD is not running (no ~/.mdopener/ipc-port)".to_string())?
        .trim()
        .parse()
        .map_err(|e| format!("invalid ~/.mdopener/ipc-port: {e}"))?;
    let token = std::fs::read_to_string(dir.join("ipc-token"))
        .map_err(|_| "no ~/.mdopener/ipc-token".to_string())?
        .trim()
        .to_string();
    if token.is_empty() {
        return Err("~/.mdopener/ipc-token is empty".to_string());
    }

    let body = serde_json::json!({ "path": abs_path, "mode": mode }).to_string();
    let request = format!(
        "POST /open HTTP/1.0\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| format!("Ashlr MD is not reachable at {addr}: {e}"))?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok();
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok();
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("IPC write error: {e}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("IPC read error: {e}"))?;

    let text = String::from_utf8_lossy(&raw);
    let status = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| "IPC server sent no HTTP status".to_string())?;
    match status {
        200..=299 => Ok(Ok(())),
        401 => Err("IPC auth failed (stale ~/.mdopener/ipc-token)".to_string()),
        code @ 400..=499 => {
            // The app's error bodies are `{"error": "<reason>"}`.
            let reason = text
                .split_once("\r\n\r\n")
                .and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(body).ok())
                .and_then(|v| v["error"].as_str().map(str::to_string))
                .unwrap_or_else(|| format!("Ashlr MD refused the file (HTTP {code})"));
            Ok(Err(Failure::Refused(reason)))
        }
        code => Err(format!("IPC server returned HTTP {code}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("mdopen-ipc-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join(".mdopener")).unwrap();
            Scratch(dir)
        }

        fn write(&self, name: &str, content: &str) {
            std::fs::write(self.0.join(".mdopener").join(name), content).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A one-shot fake app: answers one request with `status`, and hands back
    /// what it received.
    fn fake_app(status: &str) -> (u16, std::thread::JoinHandle<String>) {
        fake_app_with(status, "{\"ok\":true}")
    }

    fn fake_app_with(status: &str, reply: &str) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let status = status.to_string();
        let reply = reply.to_string();
        let handle = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            // Read until the declared body has arrived.
            loop {
                let n = s.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                let t = String::from_utf8_lossy(&buf).to_string();
                if let Some((head, body)) = t.split_once("\r\n\r\n") {
                    let len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("Content-Length: "))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if body.len() >= len {
                        break;
                    }
                }
            }
            let _ = s.write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\n\r\n{reply}",
                    reply.len()
                )
                .as_bytes(),
            );
            String::from_utf8_lossy(&buf).into_owned()
        });
        (port, handle)
    }

    #[test]
    fn posts_open_with_the_token_to_the_running_app() {
        let s = Scratch::new("ok");
        let (port, app) = fake_app("200 OK");
        s.write("ipc-port", &format!("{port}\n"));
        s.write("ipc-token", "tok123\n");
        open(&s.0, "/notes/a b.md", Some("edit")).unwrap();
        let req = app.join().unwrap();
        assert!(req.starts_with("POST /open "), "{req}");
        assert!(req.contains("Authorization: Bearer tok123\r\n"), "{req}");
        let body: serde_json::Value =
            serde_json::from_str(req.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"path": "/notes/a b.md", "mode": "edit"})
        );
    }

    #[test]
    fn errors_when_the_app_is_absent_or_refuses() {
        let s = Scratch::new("err");
        let err = open(&s.0, "/a.md", None).unwrap_err();
        assert!(
            matches!(&err, Failure::Unreachable(m) if m.contains("not running")),
            "{err:?}"
        );

        let (port, app) = fake_app("401 Unauthorized");
        s.write("ipc-port", &port.to_string());
        s.write("ipc-token", "stale");
        let err = open(&s.0, "/a.md", None).unwrap_err();
        assert!(
            matches!(&err, Failure::Unreachable(m) if m.contains("auth")),
            "{err:?}"
        );
        app.join().unwrap();

        s.write("ipc-token", "");
        let err = open(&s.0, "/a.md", None).unwrap_err();
        assert!(
            matches!(&err, Failure::Unreachable(m) if m.contains("empty")),
            "{err:?}"
        );
    }

    #[test]
    fn a_refusal_from_the_running_app_carries_its_reason() {
        // The app is up and said no: retrying through the URL scheme would
        // reach the same app, so the caller must not treat this as "not
        // running", and the reason must reach the user.
        let s = Scratch::new("refused");
        let (port, app) = fake_app_with(
            "400 Bad Request",
            r#"{"error":"Cannot open '/a.md': the file does not exist."}"#,
        );
        s.write("ipc-port", &port.to_string());
        s.write("ipc-token", "tok");
        let err = open(&s.0, "/a.md", None).unwrap_err();
        app.join().unwrap();
        assert_eq!(
            err,
            Failure::Refused("Cannot open '/a.md': the file does not exist.".to_string())
        );
    }
}
