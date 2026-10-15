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
//!   Linux   — `xdg-open <url>`, else `gio open <url>`
//!   Windows — `rundll32 url.dll,FileProtocolHandler <url>`
//!
//! This binary is intentionally tiny: std only + urlencoding.  It is bundled
//! as a Tauri sidecar and also installed to /usr/local/bin (macOS/Linux) or
//! %LOCALAPPDATA%\Programs\mdopen (Windows) by the in-app "Install CLI tool"
//! command.

use std::path::PathBuf;
use std::process;
use std::time::Duration;

mod launch;

/// How long the CLI waits for the OS launcher before reporting "not confirmed".
const CLI_DEADLINE: Duration = Duration::from_secs(10);
/// The hook runs inside the agent's turn, so it waits less.
const HOOK_DEADLINE: Duration = Duration::from_secs(5);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Hook mode: read the Claude Code PostToolUse JSON from stdin and open the
    // written Markdown file in Ashlr MD. ALWAYS exits 0 so it never blocks the
    // agent, whatever the payload looks like.
    if args.iter().any(|a| a == "--hook") {
        run_hook();
        process::exit(0);
    }

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

/// Claude Code `--hook` mode: parse the PostToolUse JSON from stdin and open the
/// written Markdown file. Silent + always succeeds; the hook must never disrupt
/// the agent. The `if: "Write(*.md)|Edit(*.md)"` rule should already gate this
/// to Markdown, but we re-check the extension defensively.
fn run_hook() {
    use std::io::Read;
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    let v: serde_json::Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(_) => return,
    };
    let path = v["tool_input"]["file_path"].as_str().unwrap_or("");
    if path.is_empty() {
        return;
    }
    let lower = path.to_ascii_lowercase();
    let is_md = [".md", ".markdown", ".mdown", ".mkd", ".mdx"]
        .iter()
        .any(|e| lower.ends_with(e));
    if !is_md {
        return;
    }
    // file_path is normally absolute, but don't assume — resolve when we can.
    let abs = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string());
    let encoded = urlencoding::encode(&abs);
    // Silent either way: no stderr, never a non-zero exit (a headless box has
    // no launcher, which must not surface as a hook error in the agent).
    let _ = launch::launch_url(
        &format!("mdopener://open?path={encoded}&mode=read"),
        HOOK_DEADLINE,
        false,
    );
}

/// Hand the URL to the OS launcher (see [`launch`]) and exit non-zero when it
/// definitely did not open: the launcher failed or none exists (headless).
///
/// - macOS   → `open <url>`
/// - Linux   → `xdg-open <url>`, else `gio open <url>`
/// - Windows → `rundll32 url.dll,FileProtocolHandler <url>`
fn launch_url(url: &str) {
    let outcome = launch::launch_url(url, CLI_DEADLINE, true);
    match &outcome {
        launch::Launch::Opened { .. } => {}
        launch::Launch::Pending { .. } => eprintln!("mdopen: {}", outcome.describe()),
        _ => {
            eprintln!("mdopen: {}", outcome.describe());
            process::exit(1);
        }
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

EXIT STATUS:
    0  the URL was handed to the OS launcher (if the launcher is still
       running after 10s, a note is printed and the open is not confirmed)
    1  bad usage, unresolvable path, launcher failed, or no launcher
       (no desktop session); a message on stderr says which
    --hook always exits 0 and prints nothing
"
    );
}
