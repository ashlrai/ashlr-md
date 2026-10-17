//! `mdopen` — open a Markdown file in Ashlr MD from any terminal or agent.
//!
//! Usage:
//!   mdopen <file.md>          open a file (read mode)
//!   mdopen --edit <file.md>   open in edit mode
//!   mdopen -                  read from stdin, write to a temp file, then open
//!   mdopen -- <file.md>       `--` ends flags, for names starting with `-`
//!   mdopen --help             print this help text
//!   mdopen --version          print the version
//!
//! The tool resolves the path to an absolute path. When Ashlr MD is running
//! it asks the app to open it over the loopback IPC channel (`POST /open`, see
//! [`ipc`]), which needs no URL-scheme registration. Otherwise it percent-
//! encodes the path and invokes the OS-appropriate command to open the
//! `mdopener://open?path=…` URL, which cold-starts the app.
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

mod ipc;
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
    if is_hook(&args) {
        run_hook();
        process::exit(0);
    }

    let (mode, target) = match parse_args(&args) {
        Ok(Cli::Help) => {
            // Asked-for help is the command's output: stdout, exit 0.
            print!("{HELP}");
            process::exit(0);
        }
        Ok(Cli::Version) => {
            println!("{}", version_line());
            process::exit(0);
        }
        Ok(Cli::Usage) => {
            // No file to open is bad usage: a script that ran `mdopen` with an
            // empty variable must not read the help as a successful open.
            eprint!("{HELP}");
            process::exit(1);
        }
        Ok(Cli::Open { mode, target }) => (mode, target),
        Err(msg) => {
            eprintln!("mdopen: {msg}");
            eprintln!("Run `mdopen --help` for usage.");
            process::exit(1);
        }
    };

    // Handle stdin mode: `-` reads from stdin and writes to a temp file.
    let from_stdin = target == "-";
    let resolved: PathBuf = if from_stdin {
        read_stdin_to_temp()
    } else {
        match resolve_file(&target) {
            Ok(p) => p,
            Err(msg) => {
                eprintln!("mdopen: {msg}");
                process::exit(1);
            }
        }
    };

    match open_in_app(&resolved.to_string_lossy(), mode, CLI_DEADLINE, true) {
        Ok(Opened::Confirmed) => {}
        Ok(Opened::Unconfirmed(note)) => eprintln!("mdopen: {note}"),
        Err(msg) => {
            // Nothing will ever read the piped content: do not leave it behind
            // in the temp dir.
            if from_stdin {
                let _ = std::fs::remove_file(&resolved);
            }
            eprintln!("mdopen: {msg}");
            process::exit(1);
        }
    }
}

/// The arguments before a `--` end-of-flags marker (all of them if none).
fn flag_args(args: &[String]) -> &[String] {
    let end = args.iter().position(|a| a == "--").unwrap_or(args.len());
    &args[..end]
}

/// Whether the command line asks for `--hook` mode.
fn is_hook(args: &[String]) -> bool {
    flag_args(args).iter().any(|a| a == "--hook")
}

/// What the command line asks for (everything except `--hook`).
#[derive(Debug, PartialEq, Eq)]
enum Cli {
    Help,
    /// No arguments at all: the help, as a usage error.
    Usage,
    Version,
    Open {
        mode: Option<&'static str>,
        target: String,
    },
}

/// Parse the non-hook command line. `Err` carries a one-line usage error.
fn parse_args(args: &[String]) -> Result<Cli, String> {
    if args.is_empty() {
        return Ok(Cli::Usage);
    }
    if flag_args(args).iter().any(|a| a == "--help" || a == "-h") {
        return Ok(Cli::Help);
    }
    if flag_args(args)
        .iter()
        .any(|a| a == "--version" || a == "-V")
    {
        return Ok(Cli::Version);
    }
    let mut mode = None;
    let mut positional: Vec<&str> = Vec::new();
    let mut flags_done = false;
    for arg in args {
        if flags_done {
            positional.push(arg);
            continue;
        }
        match arg.as_str() {
            // `--` ends flags, so `mdopen -- -notes.md` opens `-notes.md`.
            "--" => flags_done = true,
            "--edit" | "-e" => mode = Some("edit"),
            "--read" | "-r" => mode = Some("read"),
            flag if flag.starts_with('-') && flag != "-" => {
                return Err(format!("unknown flag: {flag}"));
            }
            other => positional.push(other),
        }
    }
    match positional.as_slice() {
        [] => Err("no file specified".to_string()),
        [one] => Ok(Cli::Open {
            mode,
            target: (*one).to_string(),
        }),
        // Opening only the first and silently dropping the rest would hide a
        // typo or a missing file from the caller.
        many => Err(format!(
            "expected one file, got {}; run mdopen once per file",
            many.len()
        )),
    }
}

/// `mdopen <version>`, the crate version (kept in step with the app's).
fn version_line() -> String {
    format!("mdopen {}", env!("CARGO_PKG_VERSION"))
}

/// Resolve `target` to an absolute path of an existing regular file that is a
/// Markdown document and not a dotfile (checked after resolving symlinks),
/// the only files the app opens.
fn resolve_file(target: &str) -> Result<PathBuf, String> {
    let p = std::fs::canonicalize(target)
        .map_err(|e| format!("cannot resolve path {target:?}: {e}"))?;
    if !p.is_file() {
        return Err(format!("{target:?} is not a file"));
    }
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let markdown = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MD_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    if !markdown || name.starts_with('.') {
        return Err(format!(
            "{target:?} is not a Markdown document: Ashlr MD opens .{} files that are not dotfiles",
            MD_EXTENSIONS.join(", .")
        ));
    }
    Ok(p)
}

/// Extensions the app opens (mirrors `MD_EXTENSIONS` in src-tauri/src/document.rs).
const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];

/// Read stdin into a temp `.md` file and return its path.
fn read_stdin_to_temp() -> PathBuf {
    use std::io::{IsTerminal as _, Read as _};

    // Typed input: say how to finish, rather than waiting for EOF in silence.
    if let Some(hint) = stdin_hint(std::io::stdin().is_terminal()) {
        eprintln!("mdopen: {hint}");
    }
    let mut content = Vec::new();
    std::io::stdin()
        .read_to_end(&mut content)
        .unwrap_or_else(|e| {
            eprintln!("mdopen: failed to read stdin: {e}");
            process::exit(1);
        });
    if let Err(msg) = check_stdin_content(&content) {
        eprintln!("mdopen: {msg}");
        process::exit(1);
    }

    write_new_temp(&std::env::temp_dir(), &content).unwrap_or_else(|e| {
        eprintln!("mdopen: failed to write temp file: {e}");
        process::exit(1);
    })
}

/// The stderr hint for `mdopen -` when stdin is a terminal (nothing is piped),
/// or `None` when it is a pipe or file.
fn stdin_hint(stdin_is_terminal: bool) -> Option<&'static str> {
    if !stdin_is_terminal {
        return None;
    }
    Some(if cfg!(windows) {
        "reading Markdown from the terminal; type it, then press Ctrl+Z and Enter \
         to open it (Ctrl+C cancels). To open a file, pipe it: `type notes.md | mdopen -`."
    } else {
        "reading Markdown from the terminal; type it, then press Ctrl+D to open it \
         (Ctrl+C cancels). To open a file, pipe it: `cat notes.md | mdopen -`."
    })
}

/// Refuse piped content with nothing to show, so `mdopen -` never opens an
/// empty temp document (e.g. `mdopen - < /dev/null`, or a failed producer).
fn check_stdin_content(content: &[u8]) -> Result<(), String> {
    if content.iter().all(u8::is_ascii_whitespace) {
        return Err("stdin was empty, so there is nothing to open. \
                    Pipe Markdown in, e.g. `cat notes.md | mdopen -`."
            .into());
    }
    Ok(())
}

/// Write `content` to a new `mdopen-stdin-*.md` file in `dir`. The file is
/// created exclusively (never following or reusing an existing path, which in
/// a shared temp dir could be someone else's symlink), so the name gets a
/// counter suffix until it is free.
fn write_new_temp(dir: &std::path::Path, content: &[u8]) -> std::io::Result<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let stem = format!("mdopen-stdin-{}-{nanos:x}", std::process::id());
    write_exclusive(dir, &stem, content)
}

/// Create `<dir>/<stem>-<n>.md` with `create_new` for the first free `n`.
fn write_exclusive(dir: &std::path::Path, stem: &str, content: &[u8]) -> std::io::Result<PathBuf> {
    use std::io::Write as _;

    let mut last_err = None;
    for n in 0..100u32 {
        let path = dir.join(format!("{stem}-{n}.md"));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        // Piped content may be private; keep it readable by this user only.
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        match opts.open(&path) {
            Ok(mut f) => {
                f.write_all(content)?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last_err = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("no free temp file name")))
}

/// How an open reached the app.
#[derive(Debug, PartialEq, Eq)]
enum Opened {
    /// The running app accepted it over IPC, or the URL launcher exited 0.
    Confirmed,
    /// The URL launcher is still running at the deadline (carries a note).
    Unconfirmed(String),
}

/// Open `abs_path` in Ashlr MD: through the running app's IPC server first,
/// else by handing an `mdopener://open?…` URL to the OS launcher (see
/// [`launch`]), which can also cold-start the app. `Err` means it definitely
/// did not open.
fn open_in_app(
    abs_path: &str,
    mode: Option<&str>,
    deadline: Duration,
    inherit_stderr: bool,
) -> Result<Opened, String> {
    let ipc_error = match ipc::home_dir() {
        Some(home) => match ipc::open(&home, abs_path, mode) {
            Ok(()) => return Ok(Opened::Confirmed),
            // The running app said no; the URL scheme would only reach it again.
            Err(ipc::Failure::Refused(reason)) => return Err(reason),
            Err(ipc::Failure::Unreachable(e)) => e,
        },
        None => "no home directory".to_string(),
    };

    let encoded = urlencoding::encode(abs_path);
    let mut url = format!("mdopener://open?path={encoded}");
    if let Some(m) = mode {
        url.push_str(&format!("&mode={m}"));
    }
    let outcome = launch::launch_url(&url, deadline, inherit_stderr);
    match &outcome {
        launch::Launch::Opened { .. } => Ok(Opened::Confirmed),
        launch::Launch::Pending { .. } => Ok(Opened::Unconfirmed(outcome.describe())),
        _ => Err(format!("{} ({ipc_error})", outcome.describe())),
    }
}

/// Claude Code `--hook` mode: parse the PostToolUse JSON from stdin and open the
/// written Markdown file. Silent + always succeeds; the hook must never disrupt
/// the agent. The `if: "Write(*.md)|Edit(*.md)"` rule should already gate this
/// to Markdown, but we re-check the extension defensively.
fn run_hook() {
    use std::io::{IsTerminal as _, Read};
    // Claude Code always pipes the payload. A terminal on stdin means a person
    // ran `--hook` by hand, and reading it would wait for EOF in silence.
    if let Some(hint) = hook_terminal_hint(std::io::stdin().is_terminal()) {
        eprintln!("mdopen: {hint}");
        return;
    }
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    let Some(abs) = hook_target(&input) else {
        return;
    };
    // Silent either way: no stderr, never a non-zero exit (a headless box has
    // no launcher, which must not surface as a hook error in the agent).
    let _ = open_in_app(&abs.to_string_lossy(), Some("read"), HOOK_DEADLINE, false);
}

/// The stderr hint for `mdopen --hook` run with a terminal on stdin (no
/// payload piped in), or `None` when stdin is a pipe or file, as it is under
/// Claude Code.
fn hook_terminal_hint(stdin_is_terminal: bool) -> Option<&'static str> {
    stdin_is_terminal.then_some(
        "--hook reads a Claude Code PostToolUse JSON payload on stdin and nothing was \
         piped in, so there is nothing to open. To open a file, run `mdopen <file.md>`.",
    )
}

/// The Markdown file a PostToolUse payload wrote, as an absolute path, or
/// `None` when there is nothing to open: unparseable JSON, no `file_path`, not
/// Markdown, or no such file (e.g. the write failed).
///
/// `file_path` is normally absolute. A relative one is resolved against the
/// payload's `cwd` (the session's working directory), not this process's,
/// and the app is never handed a relative path it cannot resolve.
fn hook_target(input: &str) -> Option<PathBuf> {
    let v: serde_json::Value = serde_json::from_str(input).ok()?;
    let path = v["tool_input"]["file_path"].as_str().unwrap_or("");
    if path.is_empty() {
        return None;
    }
    let lower = path.to_ascii_lowercase();
    let is_md = [".md", ".markdown", ".mdown", ".mkd", ".mdx"]
        .iter()
        .any(|e| lower.ends_with(e));
    if !is_md {
        return None;
    }
    let mut p = PathBuf::from(path);
    if p.is_relative() {
        if let Some(cwd) = v["cwd"].as_str().filter(|c| !c.is_empty()) {
            p = PathBuf::from(cwd).join(p);
        }
    }
    let abs = std::fs::canonicalize(&p).ok()?;
    abs.is_file().then_some(abs)
}

const HELP: &str = "mdopen — open Markdown files in Ashlr MD

USAGE:
    mdopen [FLAGS] <file.md>
    mdopen -                   read from stdin
    mdopen [FLAGS] -- <file>   `--` ends flags (e.g. mdopen -- -notes.md)

FLAGS:
    --edit, -e                 open in edit mode
    --read, -r                 open in read mode (default)
    --hook                     Claude Code PostToolUse hook (reads JSON on stdin)
    --help, -h                 print this help
    --version, -V              print the version

EXAMPLES:
    mdopen README.md
    mdopen --edit notes/todo.md
    echo '# Hello' | mdopen -

The tool resolves the file path to absolute and asks the running Ashlr MD
app to open it (over its loopback IPC channel). If the app is not running it
opens mdopener://open?path=<encoded-path>, which launches it.

EXIT STATUS:
    0  the running app accepted the file, or the URL was handed to the OS
       launcher (if the launcher is still running after 10s, a note is
       printed and the open is not confirmed)
    1  bad usage, unresolvable path, not a file or not a Markdown document
       (.md, .markdown, .mdown, .mkd, .mdx; no dotfiles), or the app is not running
       and the launcher failed or is missing (no desktop session); a message
       on stderr says which. A `-` temp file is removed in that case. With
       no arguments at all, this help is printed on stderr.
    --hook always exits 0 and prints nothing (run with a terminal on stdin,
       it prints a hint on stderr instead of waiting for a payload)
";

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    /// A fresh scratch directory under the system temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("mdopen-main-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }

        fn file(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            std::fs::write(&p, "# hi\n").unwrap();
            p
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn version_flag_is_version_and_matches_the_crate() {
        assert_eq!(parse_args(&args(&["--version"])), Ok(Cli::Version));
        assert_eq!(parse_args(&args(&["-V"])), Ok(Cli::Version));
        // After `--` it is a file name, not a flag.
        assert!(matches!(
            parse_args(&args(&["--", "--version"])),
            Ok(Cli::Open { .. })
        ));
        assert_eq!(
            version_line(),
            format!("mdopen {}", env!("CARGO_PKG_VERSION"))
        );
        assert!(HELP.contains("--version"));
    }

    #[test]
    fn help_and_no_args_are_help() {
        assert_eq!(parse_args(&[]), Ok(Cli::Usage));
        assert_eq!(parse_args(&args(&["--help"])), Ok(Cli::Help));
        assert_eq!(parse_args(&args(&["x.md", "-h"])), Ok(Cli::Help));
        assert!(HELP.contains("--hook"));
    }

    #[test]
    fn one_file_with_mode() {
        assert_eq!(
            parse_args(&args(&["-e", "a b é.md"])),
            Ok(Cli::Open {
                mode: Some("edit"),
                target: "a b é.md".into()
            })
        );
        assert_eq!(
            parse_args(&args(&["-"])),
            Ok(Cli::Open {
                mode: None,
                target: "-".into()
            })
        );
    }

    #[test]
    fn usage_errors() {
        assert!(parse_args(&args(&["--edit"]))
            .unwrap_err()
            .contains("no file"));
        assert!(parse_args(&args(&["--bogus", "a.md"]))
            .unwrap_err()
            .contains("unknown flag: --bogus"));
        // A second file is an error, not silently dropped.
        assert!(parse_args(&args(&["a.md", "b.md"]))
            .unwrap_err()
            .contains("expected one file, got 2"));
    }

    #[test]
    fn double_dash_ends_flags() {
        assert_eq!(
            parse_args(&args(&["--", "-notes.md"])),
            Ok(Cli::Open {
                mode: None,
                target: "-notes.md".into()
            })
        );
        // Flags before `--` still apply; nothing after it is a flag.
        assert_eq!(
            parse_args(&args(&["-e", "--", "--help"])),
            Ok(Cli::Open {
                mode: Some("edit"),
                target: "--help".into()
            })
        );
        assert!(parse_args(&args(&["--"])).unwrap_err().contains("no file"));
        assert!(parse_args(&args(&["--", "a.md", "-b.md"]))
            .unwrap_err()
            .contains("expected one file, got 2"));
        assert!(!is_hook(&args(&["--", "--hook"])));
        assert!(is_hook(&args(&["--hook"])));
    }

    #[test]
    fn resolve_file_rejects_directories_and_missing_paths() {
        let s = Scratch::new("resolve");
        let f = s.file("a file é.md");
        assert_eq!(
            resolve_file(f.to_str().unwrap()).unwrap(),
            std::fs::canonicalize(&f).unwrap()
        );
        assert!(resolve_file(s.0.to_str().unwrap())
            .unwrap_err()
            .contains("is not a file"));
        assert!(resolve_file(s.0.join("nope.md").to_str().unwrap())
            .unwrap_err()
            .contains("cannot resolve path"));
    }

    #[test]
    fn resolve_file_refuses_what_the_app_will_not_open() {
        // The app opens only Markdown documents that are not dotfiles; handing
        // it anything else used to exit 0 with nothing opened.
        let s = Scratch::new("markdown-only");
        for name in ["notes.txt", "Makefile", ".env.md"] {
            let f = s.file(name);
            let err = resolve_file(f.to_str().unwrap()).unwrap_err();
            assert!(err.contains("not a Markdown document"), "{name}: {err}");
        }
        assert!(resolve_file(s.file("Plan.MD").to_str().unwrap()).is_ok());
        #[cfg(unix)]
        {
            let secret = s.file("secret.txt");
            let link = s.0.join("link.md");
            std::os::unix::fs::symlink(&secret, &link).unwrap();
            let err = resolve_file(link.to_str().unwrap()).unwrap_err();
            assert!(err.contains("not a Markdown document"), "{err}");
        }
    }

    #[test]
    fn hook_mode_with_a_terminal_on_stdin_gets_a_hint() {
        let hint = hook_terminal_hint(true).expect("a terminal needs a hint");
        assert!(hint.contains("mdopen <file.md>"), "{hint}");
        assert_eq!(hook_terminal_hint(false), None);
    }

    #[test]
    fn a_terminal_on_stdin_gets_a_hint_and_a_pipe_does_not() {
        let hint = stdin_hint(true).expect("a terminal on stdin needs a hint");
        assert!(hint.contains("Ctrl+"), "hint: {hint}");
        assert!(hint.contains("mdopen -"), "hint: {hint}");
        assert_eq!(stdin_hint(false), None);
    }

    #[test]
    fn stdin_temp_files_are_new_and_never_reuse_a_path() {
        let s = Scratch::new("temp");
        let a = write_new_temp(&s.0, b"# one").unwrap();
        let b = write_new_temp(&s.0, b"# two").unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read(&a).unwrap(), b"# one");
        assert_eq!(std::fs::read(&b).unwrap(), b"# two");
        assert!(a.file_name().unwrap().to_str().unwrap().ends_with(".md"));
    }

    #[cfg(unix)]
    #[test]
    fn stdin_temp_never_writes_through_a_planted_symlink() {
        let s = Scratch::new("symlink");
        let victim = s.file("victim.md");
        let planted = s.0.join("mdopen-stdin-x-0.md");
        std::os::unix::fs::symlink(&victim, &planted).unwrap();
        let written = write_exclusive(&s.0, "mdopen-stdin-x", b"payload").unwrap();
        assert_eq!(written, s.0.join("mdopen-stdin-x-1.md"));
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "# hi\n");
        assert_eq!(std::fs::read(&written).unwrap(), b"payload");
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&written).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "temp file must be private, mode {mode:o}");
    }

    fn payload(cwd: &Path, file_path: &str) -> String {
        serde_json::json!({
            "session_id": "s",
            "hook_event_name": "PostToolUse",
            "cwd": cwd,
            "tool_name": "Write",
            "tool_input": { "file_path": file_path, "content": "# hi" },
            "tool_response": { "success": true }
        })
        .to_string()
    }

    #[test]
    fn hook_target_opens_absolute_markdown() {
        let s = Scratch::new("hook-abs");
        let f = s.file("a file é.md");
        assert_eq!(
            hook_target(&payload(Path::new("/"), f.to_str().unwrap())),
            Some(std::fs::canonicalize(&f).unwrap())
        );
    }

    #[test]
    fn hook_target_resolves_relative_paths_against_payload_cwd() {
        let s = Scratch::new("hook-rel");
        let f = s.file("PLAN.md");
        assert_eq!(
            hook_target(&payload(&s.0, "PLAN.md")),
            Some(std::fs::canonicalize(&f).unwrap())
        );
    }

    #[test]
    fn hook_target_ignores_non_markdown_missing_and_malformed() {
        let s = Scratch::new("hook-skip");
        let txt = s.0.join("a.txt");
        std::fs::write(&txt, "x").unwrap();
        assert_eq!(hook_target(&payload(&s.0, txt.to_str().unwrap())), None);
        assert_eq!(hook_target(&payload(&s.0, "missing.md")), None);
        assert_eq!(hook_target(&payload(&s.0, "")), None);
        assert_eq!(hook_target("not json"), None);
        assert_eq!(hook_target(""), None);
        assert_eq!(hook_target("[1,2]"), None);
        assert_eq!(hook_target(r#"{"tool_input":{"file_path":7}}"#), None);
    }
}
