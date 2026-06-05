//! `mdopen` — open a Markdown file in Ashlr MD from any terminal or agent.
//!
//! Usage:
//!   mdopen <file.md>          open a file (read mode)
//!   mdopen --edit <file.md>   open in edit mode
//!   mdopen -                  read from stdin, write to a temp file, then open
//!   mdopen --help             print this help text
//!
//! The tool resolves the path to an absolute path, percent-encodes it, and
//! invokes the OS-appropriate command to open the `mdopener://open?path=…` URL,
//! which either brings the running Ashlr MD window to the front or cold-starts
//! the app.
//!
//! OS-specific URL launcher:
//!   macOS   — `open <url>`
//!   Linux   — `xdg-open <url>`
//!   Windows — `cmd /C start "" <url>`
//!
//! This binary is intentionally tiny: std only + urlencoding.  It is bundled
//! as a Tauri sidecar and also installed to /usr/local/bin (macOS/Linux) or
//! %LOCALAPPDATA%\Programs\mdopen (Windows) by the in-app "Install CLI tool"
//! command.

use std::path::PathBuf;
use std::process;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        process::exit(0);
    }

    // Parse flags.
    let mut mode: Option<&str> = None;
    let mut positional: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--edit" | "-e" => mode = Some("edit"),
            "--read" | "-r" => mode = Some("read"),
            flag if flag.starts_with('-') && flag != "-" => {
                eprintln!("mdopen: unknown flag: {flag}");
                eprintln!("Run `mdopen --help` for usage.");
                process::exit(1);
            }
            other => positional.push(other),
        }
        i += 1;
    }

    if positional.is_empty() {
        eprintln!("mdopen: no file specified");
        print_help();
        process::exit(1);
    }

    let target = positional[0];

    // Handle stdin mode: `-` reads from stdin and writes to a temp file.
    let resolved: PathBuf = if target == "-" {
        read_stdin_to_temp()
    } else {
        // Resolve to absolute path.
        match std::fs::canonicalize(target) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("mdopen: cannot resolve path {target:?}: {e}");
                process::exit(1);
            }
        }
    };

    open_in_app(&resolved.to_string_lossy(), mode);
}

/// Read stdin into a temp `.md` file and return its path.
fn read_stdin_to_temp() -> PathBuf {
    use std::io::Read as _;

    let mut content = String::new();
    std::io::stdin()
        .read_to_string(&mut content)
        .unwrap_or_else(|e| {
            eprintln!("mdopen: failed to read stdin: {e}");
            process::exit(1);
        });

    // Write to a temp file in the system temp directory.
    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join(format!("mdopen-stdin-{}.md", std::process::id()));

    std::fs::write(&tmp_path, content.as_bytes()).unwrap_or_else(|e| {
        eprintln!("mdopen: failed to write temp file: {e}");
        process::exit(1);
    });

    tmp_path
}

/// Build the `mdopener://open?…` URL and hand it off to the OS launcher.
fn open_in_app(abs_path: &str, mode: Option<&str>) {
    let encoded = urlencoding::encode(abs_path);
    let mut url = format!("mdopener://open?path={encoded}");
    if let Some(m) = mode {
        url.push_str(&format!("&mode={m}"));
    }

    launch_url(&url);
}

/// Invoke the platform-appropriate command to open a URL / custom scheme.
///
/// - macOS   → `open <url>`          (built-in, routes registered URL schemes)
/// - Linux   → `xdg-open <url>`      (xdg-utils; handles registered MIME/scheme)
/// - Windows → `cmd /C start "" <url>` (the empty title "" is required when
///   the first argument begins with a quote or special character)
fn launch_url(url: &str) {
    #[cfg(target_os = "macos")]
    let (prog, args): (&str, &[&str]) = ("open", &[url]);

    #[cfg(target_os = "linux")]
    let (prog, args): (&str, &[&str]) = ("xdg-open", &[url]);

    // On Windows `start` is a cmd built-in, not a standalone executable, so we
    // must shell out through cmd.  The empty `""` is the window title — required
    // when the URL string itself starts with `"` or contains spaces after percent-
    // encoding (start interprets the first quoted arg as the window title).
    #[cfg(target_os = "windows")]
    let (prog, args): (&str, &[&str]) = ("cmd", &["/C", "start", "", url]);

    let status = process::Command::new(prog)
        .args(args)
        .status()
        .unwrap_or_else(|e| {
            eprintln!("mdopen: failed to run `{prog}`: {e}");
            process::exit(1);
        });

    if !status.success() {
        eprintln!(
            "mdopen: `{prog}` exited with status {}",
            status.code().unwrap_or(-1)
        );
        process::exit(1);
    }
}

fn print_help() {
    eprintln!(
        "mdopen — open Markdown files in Ashlr MD

USAGE:
    mdopen [FLAGS] <file.md>
    mdopen -                   read from stdin

FLAGS:
    --edit, -e                 open in edit mode
    --read, -r                 open in read mode (default)
    --help, -h                 print this help

EXAMPLES:
    mdopen README.md
    mdopen --edit notes/todo.md
    echo '# Hello' | mdopen -

The tool resolves the file path to absolute, then opens:
    mdopener://open?path=<encoded-path>
which forwards to the running Ashlr MD app (or launches it).
"
    );
}
