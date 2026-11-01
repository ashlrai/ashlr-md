//! A disconnected MCP host closes its pipe; the server must not linger.

use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn exits_within_five_seconds_when_host_closes_stdin() {
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdopener-mcp"))
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn the built MCP server");

    let deadline = Instant::now() + Duration::from_secs(5);
    drop(child.stdin.take().expect("piped stdin"));
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                assert!(
                    status.success(),
                    "MCP server exited unsuccessfully: {status}"
                );
                return;
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            result => {
                // Reap a stuck server before failing so regressions leave no orphan.
                let _ = child.kill();
                let _ = child.wait();
                panic!("MCP server did not exit within 5s of stdin EOF: {result:?}");
            }
        }
    }
}
