//! A one-shot local HTTP stub for tests that check what reaches an error.
//!
//! Each accepted connection gets one canned answer. `Echo401` quotes the
//! request line and every request header back in a 401 body, as a gateway
//! that names the rejected credential would. `Redirect` answers 302.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;

#[derive(Clone, Copy)]
pub enum Mode {
    Echo401,
    Redirect,
    /// 200 with a body that is not the expected JSON, quoting the request.
    EchoBadJson,
}

/// Start a stub on 127.0.0.1 and return its `http://127.0.0.1:<port>` root.
pub fn serve(mode: Mode) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = Vec::new();
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let t = line.trim_end().to_string();
                if t.is_empty() {
                    break;
                }
                if let Some(v) = t.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
                head.push(t);
            }
            let mut body = vec![0u8; len];
            let _ = reader.read_exact(&mut body);
            let echo = head.join("; ").replace('"', "'");
            let reply = match mode {
                Mode::Echo401 => {
                    let b = format!("{{\"error\":{{\"message\":\"rejected: {echo}\"}}}}");
                    format!(
                        "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}",
                        b.len()
                    )
                }
                Mode::Redirect => "HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:9/elsewhere\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string(),
                Mode::EchoBadJson => {
                    let b = format!("not json: {echo}");
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}",
                        b.len()
                    )
                }
            };
            let _ = stream.write_all(reply.as_bytes());
            let _ = stream.flush();
        }
    });
    format!("http://127.0.0.1:{port}")
}

/// A `http://127.0.0.1:<port>` root with nothing listening.
pub fn closed() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("http://127.0.0.1:{port}")
}

/// Every 8-character window of `secret` that occurs in `text`.
pub fn leaked_windows(text: &str, secret: &str) -> Vec<String> {
    let chars: Vec<char> = secret.chars().collect();
    let mut out = Vec::new();
    for i in 0..chars.len().saturating_sub(7) {
        let w: String = chars[i..i + 8].iter().collect();
        if text.contains(&w) {
            out.push(w);
        }
    }
    out
}
