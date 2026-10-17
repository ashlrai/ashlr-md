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

use std::path::{Path, PathBuf};
use std::process;
use std::time::Duration;

mod ipc;
mod launch;

/// How long the CLI waits for the OS launcher before reporting "not confirmed".
const CLI_DEADLINE: Duration = Duration::from_secs(10);
/// The hook runs inside the agent's turn, so it waits less.
const HOOK_DEADLINE: Duration = Duration::from_secs(5);

fn main() {
    // `std::env::args` panics on an argument that is not valid UTF-8 (exit
    // 101 and a backtrace, even under `--hook`), so the arguments are read
    // as OS strings and judged here.
    let (args, not_utf8) = utf8_args(std::env::args_os().skip(1));

    // Asked-for help wins over every other flag, `--hook` included, so
    // `mdopen --hook --help` prints the help instead of waiting on stdin.
    if wants_help(&args) {
        print!("{HELP}");
        process::exit(0);
    }

    // Hook mode: read the Claude Code PostToolUse JSON from stdin and open the
    // written Markdown file in Ashlr MD. ALWAYS exits 0 so it never blocks the
    // agent, whatever the payload looks like.
    if is_hook(&args) {
        run_hook();
        process::exit(0);
    }

    if let Some(arg) = not_utf8 {
        eprintln!("mdopen: {}", not_utf8_message(&arg));
        process::exit(1);
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
    let from_stdin = target == Target::Stdin;
    let resolved: PathBuf = match target {
        Target::Stdin => read_stdin_to_temp(),
        Target::File(path) => match resolve_file(&path) {
            Ok(p) => p,
            Err(msg) => {
                eprintln!("mdopen: {msg}");
                process::exit(1);
            }
        },
    };

    match open_in_app(&resolved.to_string_lossy(), mode, CLI_DEADLINE, true) {
        Ok(Opened::Confirmed) => {}
        Ok(Opened::Unconfirmed(note)) => eprintln!("mdopen: {note}"),
        Err(NotOpened { msg, maybe_later }) => {
            // Nothing will ever read the piped content: do not leave it behind
            // in the temp dir. Unless the app may still open it (it was
            // reached but did not answer in time), when removing it would
            // turn a slow open into a failed one.
            if from_stdin && !maybe_later {
                let _ = std::fs::remove_file(&resolved);
            }
            eprintln!("mdopen: {msg}");
            process::exit(1);
        }
    }
}

/// The arguments as strings (an argument that is not valid UTF-8 replaced
/// lossily, so flags around it still parse), and the first such argument
/// lossily, if any.
fn utf8_args(os_args: impl Iterator<Item = std::ffi::OsString>) -> (Vec<String>, Option<String>) {
    let mut not_utf8 = None;
    let args = os_args
        .map(|a| match a.into_string() {
            Ok(s) => s,
            Err(a) => {
                let lossy = a.to_string_lossy().into_owned();
                not_utf8.get_or_insert_with(|| lossy.clone());
                lossy
            }
        })
        .collect();
    (args, not_utf8)
}

/// The usage error for an argument that is not valid UTF-8 (shown lossily).
/// Ashlr MD takes paths as UTF-8 text, over IPC and in the `mdopener://`
/// URL, so such a path could only ever name some other file.
fn not_utf8_message(lossy: &str) -> String {
    format!(
        "the argument {lossy:?} is not valid UTF-8, so it cannot be opened: \
         Ashlr MD opens paths that are valid UTF-8. Rename the file and run mdopen again."
    )
}

/// The arguments before a `--` end-of-flags marker (all of them if none).
fn flag_args(args: &[String]) -> &[String] {
    let end = args.iter().position(|a| a == "--").unwrap_or(args.len());
    &args[..end]
}

/// Whether the command line asks for the help (`--help` or `-h` before any
/// `--`). It wins over every other flag, `--hook` included.
fn wants_help(args: &[String]) -> bool {
    flag_args(args).iter().any(|a| a == "--help" || a == "-h")
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
        target: Target,
    },
}

/// What to open: stdin (a `-` before any `--`), or a file path. After `--`,
/// `-` is a file named `-`, so `mdopen -- -` opens that file.
#[derive(Debug, PartialEq, Eq)]
enum Target {
    Stdin,
    File(String),
}

/// Parse the non-hook command line. `Err` carries a one-line usage error.
fn parse_args(args: &[String]) -> Result<Cli, String> {
    if args.is_empty() {
        return Ok(Cli::Usage);
    }
    if wants_help(args) {
        return Ok(Cli::Help);
    }
    if flag_args(args)
        .iter()
        .any(|a| a == "--version" || a == "-V")
    {
        return Ok(Cli::Version);
    }
    let mut mode = None;
    // Each positional with whether it came after `--`.
    let mut positional: Vec<(&str, bool)> = Vec::new();
    let mut flags_done = false;
    for arg in args {
        if flags_done {
            positional.push((arg, true));
            continue;
        }
        match arg.as_str() {
            // `--` ends flags, so `mdopen -- -notes.md` opens `-notes.md`.
            "--" => flags_done = true,
            "--edit" | "-e" => mode = set_mode(mode, "edit")?,
            "--read" | "-r" => mode = set_mode(mode, "read")?,
            flag if flag.starts_with('-') && flag != "-" => {
                return Err(format!("unknown flag: {flag}"));
            }
            other => positional.push((other, false)),
        }
    }
    match positional.as_slice() {
        [] => Err("no file specified".to_string()),
        // `mdopen "$FILE"` with an empty variable used to come back as
        // `cannot resolve path "": No such file or directory`.
        [(one, _)] if one.trim().is_empty() => {
            Err("the file path is empty; pass the Markdown file to open".to_string())
        }
        [("-", false)] => Ok(Cli::Open {
            mode,
            target: Target::Stdin,
        }),
        [(one, _)] => Ok(Cli::Open {
            mode,
            target: Target::File((*one).to_string()),
        }),
        // Opening only the first and silently dropping the rest would hide a
        // typo or a missing file from the caller.
        many => Err(format!(
            "expected one file, got {}; run mdopen once per file",
            many.len()
        )),
    }
}

/// Record a `--edit`/`--read` flag. Both on one command line used to open
/// in whichever came last, silently dropping the other; now that is a usage
/// error. Repeating the same flag is harmless.
fn set_mode(
    current: Option<&'static str>,
    wanted: &'static str,
) -> Result<Option<&'static str>, String> {
    match current {
        Some(m) if m != wanted => Err("--edit and --read conflict; pass one of them".to_string()),
        _ => Ok(Some(wanted)),
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
    let p = std::fs::canonicalize(target).map_err(|e| missing_or_unresolved(target, &e))?;
    if p.is_dir() {
        return Err(format!(
            "{target:?} is a directory, not a file; pass a Markdown file in it"
        ));
    }
    if !p.is_file() {
        return Err(format!("{target:?} is not a file"));
    }
    if !is_markdown_document_name(&p) {
        // `notes.md` linking to `.env` used to be called "not a Markdown
        // document" by its own, Markdown, name; the error names the target.
        let what = if is_markdown_document_name(Path::new(target)) {
            format!("{target:?} links to {}, which", p.display())
        } else {
            format!("{target:?}")
        };
        return Err(format!(
            "{what} is not a Markdown document: Ashlr MD opens .{} files that are not dotfiles",
            MD_EXTENSIONS.join(", .")
        ));
    }
    Ok(p)
}

/// The error for a `target` that does not resolve. A missing file used to read
/// `cannot resolve path "nope.md": No such file or directory (os error 2)`,
/// which did not say where mdopen looked; it now says the file does not exist
/// and names the absolute path. Other failures keep the OS reason.
fn missing_or_unresolved(target: &str, e: &std::io::Error) -> String {
    if e.kind() != std::io::ErrorKind::NotFound {
        return format!("cannot resolve path {target:?}: {e}");
    }
    match std::path::absolute(target) {
        Ok(abs) if abs.as_os_str() != target => {
            format!("{target:?} does not exist (looked for {})", abs.display())
        }
        _ => format!("{target:?} does not exist"),
    }
}

/// Whether the (resolved) path's file name is one the app opens: a Markdown
/// extension and not a dotfile.
fn is_markdown_document_name(p: &Path) -> bool {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let markdown = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MD_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    markdown && !name.starts_with('.')
}

/// Extensions the app opens (mirrors `MD_EXTENSIONS` in src-tauri/src/document.rs).
const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx"];

/// Read stdin into a temp `.md` file and return its path.
fn read_stdin_to_temp() -> PathBuf {
    use std::io::IsTerminal as _;

    // Typed input: say how to finish, rather than waiting for EOF in silence.
    if let Some(hint) = stdin_hint(std::io::stdin().is_terminal()) {
        eprintln!("mdopen: {hint}");
    }
    let content = read_capped(std::io::stdin().lock(), MAX_STDIN_BYTES).unwrap_or_else(|msg| {
        eprintln!("mdopen: {msg}");
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

/// Most bytes `mdopen -` reads from stdin: the 16 MiB document limit the app
/// accepts in one IPC request and the MCP server reads from disk
/// (`MAX_DOCUMENT_BYTES` in mdopener-mcp). Stdin used to be read whole, so
/// `mdopen - < /dev/zero` grew without bound and a huge pipe went to disk in full.
const MAX_STDIN_BYTES: u64 = 16 * 1024 * 1024;

/// Read `input` to its end, refusing it as soon as it is longer than `cap`
/// bytes (at most `cap + 1` bytes are ever held). `Err` is the message for
/// stderr.
fn read_capped(input: impl std::io::Read, cap: u64) -> Result<Vec<u8>, String> {
    use std::io::Read as _;
    let mut content = Vec::new();
    input
        .take(cap + 1)
        .read_to_end(&mut content)
        .map_err(|e| format!("failed to read stdin: {e}"))?;
    if content.len() as u64 > cap {
        return Err(format!(
            "stdin is more than the {} MiB a document may be, so nothing was opened. \
             Save it to a file and split it, or open a smaller part.",
            cap / (1024 * 1024)
        ));
    }
    Ok(content)
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

/// Why [`open_in_app`] did not confirm an open.
#[derive(Debug, PartialEq, Eq)]
struct NotOpened {
    msg: String,
    /// The app was reached and may still open the file.
    maybe_later: bool,
}

impl NotOpened {
    fn no(msg: String) -> Self {
        NotOpened {
            msg,
            maybe_later: false,
        }
    }
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
) -> Result<Opened, NotOpened> {
    let ipc_error = match ipc::home_dir() {
        Some(home) => match ipc::open(&home, abs_path, mode) {
            Ok(()) => return Ok(Opened::Confirmed),
            // The running app said no; the URL scheme would only reach it again.
            Err(ipc::Failure::Refused(reason)) => return Err(NotOpened::no(reason)),
            // Reached but failed or slow: it may still open the file, so a
            // URL-scheme retry could report a false success or open it twice.
            Err(ipc::Failure::Failed(reason)) => {
                return Err(NotOpened {
                    msg: reason,
                    maybe_later: true,
                })
            }
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
        // Both routes failed: say what each one hit, then what to do. Before,
        // this was `<launcher error> (<ipc error>)` with no next step.
        _ => Err(NotOpened::no(format!(
            "could not open {abs_path} in Ashlr MD. The running app: {ipc_error}. \
             The mdopener:// URL: {}. Start Ashlr MD, then run mdopen again.",
            outcome.describe()
        ))),
    }
}

/// Claude Code `--hook` mode: parse the PostToolUse JSON from stdin and open the
/// written Markdown file. Silent + always succeeds; the hook must never disrupt
/// the agent. The `if: "Write(*.md)|Edit(*.md)"` rule should already gate this
/// to Markdown, but we re-check the extension defensively.
fn run_hook() {
    use std::io::IsTerminal as _;
    // Claude Code always pipes the payload. A terminal on stdin means a person
    // ran `--hook` by hand, and reading it would wait for EOF in silence.
    if let Some(hint) = hook_terminal_hint(std::io::stdin().is_terminal()) {
        eprintln!("mdopen: {hint}");
        return;
    }
    let Some(input) = hook_payload(std::io::stdin().lock(), MAX_HOOK_PAYLOAD_BYTES) else {
        return;
    };
    let Some(abs) = hook_target(&input) else {
        return;
    };
    // Silent either way: no stderr, never a non-zero exit (a headless box has
    // no launcher, which must not surface as a hook error in the agent).
    let _ = open_in_app(&abs.to_string_lossy(), Some("read"), HOOK_DEADLINE, false);
}

/// Most bytes `--hook` reads from stdin. A PostToolUse payload carries the
/// written file's content (as JSON, so escaped, and possibly twice, in
/// `tool_input` and `tool_response`), so this leaves room for a 16 MiB
/// document several times over. Stdin used to be read to its end however
/// long it was.
const MAX_HOOK_PAYLOAD_BYTES: u64 = 4 * MAX_STDIN_BYTES;

/// The hook payload read from `input`, or `None` (open nothing, silently)
/// when it cannot be read as UTF-8 or is longer than `cap` bytes; at most
/// `cap + 1` bytes are ever held.
fn hook_payload(input: impl std::io::Read, cap: u64) -> Option<String> {
    String::from_utf8(read_capped(input, cap).ok()?).ok()
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
    // Judged again after resolving symlinks, as the app does: a written
    // `.notes.md`, or a `notes.md` linking to a dotfile or a non-Markdown
    // file, used to be handed to the app, which refuses it.
    let abs = std::fs::canonicalize(&p).ok()?;
    (abs.is_file() && is_markdown_document_name(&abs)).then_some(abs)
}

const HELP: &str = "mdopen: open Markdown files in Ashlr MD

USAGE:
    mdopen [FLAGS] <file.md>
    mdopen -                   read from stdin
    mdopen [FLAGS] -- <file>   `--` ends flags (e.g. mdopen -- -notes.md;
                               mdopen -- - opens a file named -)

FLAGS:
    --edit, -e                 open in edit mode
    --read, -r                 open in read mode (default; not with --edit)
    --hook                     Claude Code PostToolUse hook (reads JSON on stdin)
    --help, -h                 print this help (wins over every other flag)
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
    1  bad usage (including --edit with --read or an empty path), unresolvable
       path, a directory, not a file or not a Markdown document
       (.md, .markdown, .mdown, .mkd, .mdx; no dotfiles), an argument that is
       not valid UTF-8, `-` with empty stdin or
       more than 16 MiB of it, or the app is not running
       and the launcher failed or is missing (no desktop session); a message
       on stderr says which. A `-` temp file is removed in that case. Also
       1 when the running app answered with a server error or did not
       answer within 6s: the open is not retried through the URL scheme
       (the app may still open the file, so a `-` temp file is kept).
       With no arguments at all, this help is printed on stderr.
    --hook always exits 0 and prints nothing (run with a terminal on stdin,
       it prints a hint on stderr instead of waiting for a payload)
";

#[cfg(test)]
mod tests {
    use super::*;

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

    /// `--hook` read stdin to its end however long it was. Past the cap it
    /// stops reading and opens nothing (still silently, exit 0).
    #[test]
    fn hook_payload_is_read_up_to_its_cap() {
        let payload = r#"{"tool_input":{"file_path":"/x.md"}}"#;
        assert_eq!(
            hook_payload(payload.as_bytes(), 1024).as_deref(),
            Some(payload)
        );
        assert_eq!(
            hook_payload(payload.as_bytes(), payload.len() as u64).as_deref(),
            Some(payload)
        );
        // A payload past the cap is not read (an endless producer is cut
        // off there).
        let long = format!("{payload}{}", " ".repeat(1024));
        assert_eq!(hook_payload(long.as_bytes(), 1024), None);
        assert_eq!(
            hook_payload(std::io::Read::take(std::io::repeat(b' '), 1 << 20), 1024),
            None
        );
        assert_eq!(hook_payload(&b"\xff\xfe"[..], 1024), None, "not UTF-8");
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
                target: Target::File("a b é.md".into())
            })
        );
        assert_eq!(
            parse_args(&args(&["-"])),
            Ok(Cli::Open {
                mode: None,
                target: Target::Stdin
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
    fn edit_and_read_together_are_a_usage_error() {
        for pair in [
            ["-e", "-r"],
            ["--edit", "--read"],
            ["--read", "--edit"],
            ["-r", "-e"],
        ] {
            let err = parse_args(&args(&[pair[0], pair[1], "a.md"])).unwrap_err();
            assert!(
                err.contains("--edit and --read conflict"),
                "{pair:?}: {err}"
            );
        }
        // Repeating the same mode is not a conflict.
        assert_eq!(
            parse_args(&args(&["-e", "--edit", "a.md"])),
            Ok(Cli::Open {
                mode: Some("edit"),
                target: Target::File("a.md".into())
            })
        );
        // After `--`, `-r` is a file name, not a second mode.
        assert!(parse_args(&args(&["-e", "--", "-r"])).is_ok());
    }

    #[test]
    fn double_dash_ends_flags() {
        assert_eq!(
            parse_args(&args(&["--", "-notes.md"])),
            Ok(Cli::Open {
                mode: None,
                target: Target::File("-notes.md".into())
            })
        );
        // Flags before `--` still apply; nothing after it is a flag.
        assert_eq!(
            parse_args(&args(&["-e", "--", "--help"])),
            Ok(Cli::Open {
                mode: Some("edit"),
                target: Target::File("--help".into())
            })
        );
        assert!(parse_args(&args(&["--"])).unwrap_err().contains("no file"));
        assert!(parse_args(&args(&["--", "a.md", "-b.md"]))
            .unwrap_err()
            .contains("expected one file, got 2"));
        assert!(!is_hook(&args(&["--", "--hook"])));
        assert!(is_hook(&args(&["--hook"])));
    }

    /// `mdopen -- -` read stdin: after `--`, `-` is a file named `-`, while
    /// a `-` before any `--` still reads stdin.
    #[test]
    fn a_dash_after_double_dash_is_a_file_named_dash() {
        assert_eq!(
            parse_args(&args(&["--", "-"])),
            Ok(Cli::Open {
                mode: None,
                target: Target::File("-".into())
            })
        );
        assert_eq!(
            parse_args(&args(&["-e", "--", "-"])),
            Ok(Cli::Open {
                mode: Some("edit"),
                target: Target::File("-".into())
            })
        );
        assert_eq!(
            parse_args(&args(&["-e", "-"])),
            Ok(Cli::Open {
                mode: Some("edit"),
                target: Target::Stdin
            })
        );
        assert!(parse_args(&args(&["-", "--", "-"]))
            .unwrap_err()
            .contains("expected one file, got 2"));
    }

    /// `--hook` used to win over `--help`, so `mdopen --hook --help` waited
    /// on stdin in silence. The help wins, before or after `--hook`, but a
    /// `--help` after `--` is a file name.
    #[test]
    fn help_wins_over_hook() {
        for argv in [
            &["--hook", "--help"][..],
            &["--help", "--hook"],
            &["--hook", "-h"],
        ] {
            assert!(wants_help(&args(argv)), "{argv:?}");
        }
        assert!(!wants_help(&args(&["--hook"])));
        assert!(!wants_help(&args(&["--hook", "--", "--help"])));
    }

    /// `mdopen "$FILE"` with an empty or blank variable is a usage error
    /// that says the path is empty, not a file system error about "".
    #[test]
    fn an_empty_or_blank_path_is_a_usage_error() {
        for argv in [&[""][..], &["  "], &["--edit", ""], &["--", " \t"]] {
            assert_eq!(
                parse_args(&args(argv)).unwrap_err(),
                "the file path is empty; pass the Markdown file to open",
                "{argv:?}"
            );
        }
        // A name with spaces around it is still a name.
        assert!(matches!(
            parse_args(&args(&[" a.md"])),
            Ok(Cli::Open { .. })
        ));
    }

    #[test]
    fn resolve_file_rejects_directories_and_missing_paths() {
        let s = Scratch::new("resolve");
        let f = s.file("a file é.md");
        assert_eq!(
            resolve_file(f.to_str().unwrap()).unwrap(),
            std::fs::canonicalize(&f).unwrap()
        );
        assert_eq!(
            resolve_file(s.0.to_str().unwrap()).unwrap_err(),
            format!(
                "{:?} is a directory, not a file; pass a Markdown file in it",
                s.0.to_str().unwrap()
            )
        );
        // A directory named like a document is still a directory.
        let dir_md = s.0.join("folder.md");
        std::fs::create_dir_all(&dir_md).unwrap();
        assert!(resolve_file(dir_md.to_str().unwrap())
            .unwrap_err()
            .contains("is a directory"));
        let missing = s.0.join("nope.md");
        let err = resolve_file(missing.to_str().unwrap()).unwrap_err();
        assert!(err.ends_with("does not exist"), "{err}");
        assert!(!err.contains("os error"), "{err}");
    }

    #[test]
    fn a_missing_relative_path_names_where_mdopen_looked() {
        let name = format!("mdopen-missing-{}.md", std::process::id());
        let abs = std::env::current_dir().unwrap().join(&name);
        assert!(!abs.exists());
        let err = resolve_file(&name).unwrap_err();
        assert_eq!(
            err,
            format!("{name:?} does not exist (looked for {})", abs.display())
        );
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
            // The error names the file the link points at, not only the
            // link's own Markdown name.
            let target = std::fs::canonicalize(&secret).unwrap();
            assert!(
                err.contains(&format!("links to {}, which is not", target.display())),
                "{err}"
            );
        }
        // A name that is itself not a document does not claim a link.
        let err = resolve_file(s.file("notes.txt").to_str().unwrap()).unwrap_err();
        assert!(!err.contains("links to"), "{err}");
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
    fn stdin_past_the_document_limit_is_refused() {
        // `mdopen -` read stdin whole, however much was piped in.
        assert_eq!(MAX_STDIN_BYTES, 16 * 1024 * 1024);
        let at_cap = vec![b'#'; 64];
        assert_eq!(read_capped(&at_cap[..], 64).unwrap(), at_cap);
        let err = read_capped(&[b'x'; 65][..], 64).unwrap_err();
        assert!(err.contains("nothing was opened"), "{err}");
        // The real limit, against an endless stream: refused, not read forever.
        let err = read_capped(std::io::repeat(b'x'), MAX_STDIN_BYTES).unwrap_err();
        assert!(err.contains("more than the 16 MiB"), "{err}");
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

    #[test]
    fn hook_target_skips_dotfiles_after_resolving_links() {
        let s = Scratch::new("hook-dot");
        let dot = s.file(".notes.md");
        assert_eq!(hook_target(&payload(&s.0, dot.to_str().unwrap())), None);
        assert_eq!(hook_target(&payload(&s.0, ".notes.md")), None);
        #[cfg(unix)]
        {
            let env = s.0.join(".env");
            std::fs::write(&env, "KEY=x").unwrap();
            let txt = s.0.join("secrets.txt");
            std::fs::write(&txt, "x").unwrap();
            for (link, target) in [("to-env.md", &env), ("to-txt.md", &txt)] {
                std::os::unix::fs::symlink(target, s.0.join(link)).unwrap();
                assert_eq!(hook_target(&payload(&s.0, link)), None, "{link}");
            }
            // A link to a Markdown document still opens it.
            let real = s.file("real.md");
            std::os::unix::fs::symlink(&real, s.0.join("alias.md")).unwrap();
            assert_eq!(
                hook_target(&payload(&s.0, "alias.md")),
                Some(std::fs::canonicalize(&real).unwrap())
            );
        }
    }
}
