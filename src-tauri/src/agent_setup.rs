//! Agent setup: one-click MCP registration for Claude Code, Cursor, and Codex,
//! and the Claude Code auto-open hook.
//!
//! Exposes six Tauri commands:
//!
//!   `detect_agent_clis`   - probe which AI coding tools are installed
//!   `connect_claude_code` - run `claude mcp add --scope user ashlr-md <path>`,
//!                           repointing a stale registration
//!   `connect_cursor`      - write/merge an entry in `~/.cursor/mcp.json`
//!   `connect_codex`       - run `codex mcp add ashlr-md -- <path>`, repointing
//!                           a stale registration
//!   `install_claude_hook` - merge a `PostToolUse` hook into
//!                           `~/.claude/settings.json` that opens Markdown
//!                           Claude writes or edits in Ashlr MD
//!   `mcp_command_string`  - return the exact shell command for copy/manual use
//!
//! All commands are synchronous (no async needed — process spawns are fast) and
//! return `Result<_, String>` to surface friendly errors in the UI.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Manager;

#[path = "appimage_sidecar.rs"]
mod appimage_sidecar;
#[path = "mcp_command.rs"]
mod mcp_command;
#[path = "path_search.rs"]
mod path_search;
#[path = "sidecar_path.rs"]
mod sidecar_path;

pub(crate) use sidecar_path::sidecar_file_name;

// ── Binary path resolution ────────────────────────────────────────────────────

/// Resolve the absolute path to the `mdopener-mcp` sidecar binary
/// (`mdopener-mcp.exe` on Windows). See [`resolve_sidecar_binary`].
fn resolve_mcp_binary_path(app: &tauri::AppHandle) -> Result<String, String> {
    resolve_sidecar_binary(app, "mdopener-mcp")
}

/// Resolve the absolute path to a bundled sidecar binary by name (e.g.
/// `mdopener-mcp`, `mdopen`), using the host's executable suffix so the
/// lookup matches the platform resource map. Search order is documented on
/// [`sidecar_path::resolve`].
///
/// From an AppImage the bundled binary is inside the per-launch
/// `/tmp/.mount_*` mount, so the path returned is a stable copy in the app's
/// local data dir, refreshed when the app changes (see [`appimage_sidecar`]).
/// It used to be the in-mount path, which broke once the app quit.
pub(crate) fn resolve_sidecar_binary(app: &tauri::AppHandle, bin: &str) -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Cannot determine app executable path: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or("App executable has no parent directory")?;
    let resource_dir = app.path().resource_dir().ok();
    let bundled = PathBuf::from(sidecar_path::resolve(
        bin,
        exe_dir,
        resource_dir.as_deref(),
    )?);

    let stable_dir = app.path().app_local_data_dir().ok().map(|d| d.join("bin"));
    let version = app.package_info().version.to_string();
    let len = fs::metadata(&bundled).map(|m| m.len()).unwrap_or(0);
    let stamp = appimage_sidecar::stamp_for(&version, len);
    let (recorded, dest_exists) = match (&stable_dir, bundled.file_name()) {
        (Some(dir), Some(name)) => {
            let (dest, stamp_path) = appimage_sidecar::stable_paths(dir, name);
            (appimage_sidecar::read_stamp(&stamp_path), dest.is_file())
        }
        _ => (None, false),
    };
    let appimage = std::env::var_os("APPIMAGE");
    let plan = appimage_sidecar::plan(
        std::env::consts::OS,
        appimage.as_deref(),
        &bundled,
        stable_dir.as_deref(),
        &stamp,
        recorded.as_deref(),
        dest_exists,
    );
    appimage_sidecar::apply(&bundled, plan)?
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("{bin} path contains non-UTF-8 characters"))
}

// ── Agent detection ───────────────────────────────────────────────────────────

/// Which AI coding tools are reachable on this machine.
///
/// Serialised to JSON and returned to the frontend so it can enable/disable
/// the one-click buttons appropriately.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClis {
    /// `claude` binary is on `$PATH` (Claude Code CLI).
    pub claude: bool,
    /// `codex` binary is on `$PATH` (OpenAI Codex CLI).
    pub codex: bool,
    /// `~/.cursor` directory exists (Cursor IDE is installed).
    pub cursor: bool,
}

/// Check which AI coding-agent CLIs / apps are present on this machine.
///
/// Searches `PATH` in-process for CLI tools (with `PATHEXT` on Windows, where
/// `which` does not exist) and checks directory existence for GUI apps
/// (Cursor). Never panics — any failure to probe is treated as "not present".
#[tauri::command]
pub fn detect_agent_clis() -> AgentClis {
    AgentClis {
        claude: path_search::find_on_path("claude").is_some(),
        codex: path_search::find_on_path("codex").is_some(),
        cursor: cursor_installed(),
    }
}

/// The program to spawn for an agent CLI: its resolved `PATH` entry, so a
/// Windows npm shim (`claude.cmd`, `codex.cmd`) that detection found is also
/// what runs. Falls back to the bare name, which reports "not found".
fn agent_cli_program(name: &str) -> PathBuf {
    path_search::find_on_path(name).unwrap_or_else(|| PathBuf::from(name))
}

/// Returns true if Cursor's config directory exists at `~/.cursor`.
///
/// Cursor on macOS writes its config here whether or not the app is in
/// /Applications, so this is the most reliable signal short of checking
/// /Applications directly.
fn cursor_installed() -> bool {
    dirs::home_dir()
        .map(|h| h.join(".cursor").exists())
        .unwrap_or(false)
}

// ── Claude Code and Codex: registration through the client's CLI ─────────────

/// What one run of a client CLI printed, and whether it succeeded.
#[derive(Debug, Clone, Default)]
struct CliOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl CliOutput {
    /// stdout and stderr, trimmed, joined by a newline (empty ones left out).
    fn detail(&self) -> String {
        [self.stdout.trim(), self.stderr.trim()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// [`Self::detail`], or the exit code when the run printed nothing.
    fn failure(&self, what: &str) -> String {
        let detail = self.detail();
        if detail.is_empty() {
            format!("{what} exited with code {}.", self.code.unwrap_or(-1))
        } else {
            detail
        }
    }
}

/// Runs a client CLI with the given arguments. Injected so the registration
/// logic is tested without a real `claude` or `codex`.
type CliRunner<'a> = &'a dyn Fn(&[&str]) -> std::io::Result<CliOutput>;

/// How to register the `ashlr-md` server with one client's CLI.
struct AgentCli {
    /// The client's name in messages.
    label: &'static str,
    /// The program run, as shown in messages.
    program: &'static str,
    /// Said when the program is not installed.
    not_found: &'static str,
    /// `mcp add` up to the server path, which is appended.
    add: &'static [&'static str],
    /// Ways to ask which command the registered server runs, tried in order.
    get: &'static [&'static [&'static str]],
    /// Removes the registration `add` makes.
    remove: &'static [&'static str],
    /// Said after a registration that took effect.
    restart: &'static str,
    /// Whether a successful `add` that printed something shows that output
    /// instead of the generic message.
    show_add_output: bool,
}

const CLAUDE_CLI: AgentCli = AgentCli {
    label: "Claude Code",
    program: "claude",
    not_found: "Claude Code CLI not found. Install it from https://claude.ai/download \
                then try again.",
    add: &["mcp", "add", "--scope", "user", "ashlr-md"],
    get: &[&["mcp", "get", "ashlr-md"]],
    remove: &["mcp", "remove", "--scope", "user", "ashlr-md"],
    restart: "Start a new Claude Code session to pick it up.",
    show_add_output: true,
};

const CODEX_CLI: AgentCli = AgentCli {
    label: "Codex",
    program: "codex",
    not_found: "Codex CLI not found. Install it (e.g. `npm i -g @openai/codex`) then try again.",
    add: &["mcp", "add", "ashlr-md", "--"],
    get: &[
        &["mcp", "get", "ashlr-md", "--json"],
        &["mcp", "get", "ashlr-md"],
    ],
    remove: &["mcp", "remove", "ashlr-md"],
    restart: "Restart Codex to pick it up.",
    show_add_output: false,
};

/// Runs `program` (resolved on `PATH`, see [`agent_cli_program`]).
fn run_agent_cli(program: &str, args: &[&str]) -> std::io::Result<CliOutput> {
    let output = Command::new(agent_cli_program(program))
        .args(args)
        .output()?;
    Ok(CliOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// The command a client says its `ashlr-md` server runs, read from the output
/// of its `mcp get`: JSON with `transport.command` (or `command`), as
/// `codex mcp get --json` prints, or a `Command: <path>` line, as
/// `claude mcp get` and `codex mcp get` print.
fn registered_command(stdout: &str) -> Option<String> {
    if let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) {
        return v["transport"]["command"]
            .as_str()
            .or(v["command"].as_str())
            .map(str::to_string)
            .filter(|c| !c.is_empty());
    }
    stdout.lines().find_map(|line| {
        let line = line.trim();
        let (key, value) = line.split_once(':')?;
        let value = value.trim();
        (key.trim().eq_ignore_ascii_case("command") && !value.is_empty()).then(|| value.to_string())
    })
}

/// Whether the program a client registered, `registered`, is this app's
/// `mcp_path`. The same string is; otherwise, when `exists` says both are on
/// disk, they are when their canonical paths match (a registration that
/// reaches the binary through a symlink, such as `/tmp` against
/// `/private/tmp`). With `case_insensitive` (macOS, whose volumes usually
/// ignore case) two existing paths that differ only in case match too.
fn same_program(
    registered: &str,
    mcp_path: &str,
    exists: &dyn Fn(&str) -> bool,
    case_insensitive: bool,
) -> bool {
    if registered == mcp_path {
        return true;
    }
    if !(exists(registered) && exists(mcp_path)) {
        return false;
    }
    let canonical = |p: &str| {
        fs::canonicalize(p)
            .map(|c| c.to_string_lossy().into_owned())
            .unwrap_or_else(|_| p.to_string())
    };
    let (a, b) = (canonical(registered), canonical(mcp_path));
    a == b || (case_insensitive && a.to_lowercase() == b.to_lowercase())
}

/// [`same_program`] as this platform compares paths: ignoring case on macOS
/// only.
const PATHS_IGNORE_CASE: bool = cfg!(target_os = "macos");

/// Register `mcp_path` as the `ashlr-md` server with `cli`, running it through
/// `run`; `exists` says whether a registered program is still on disk, and
/// `ignore_case` whether paths that differ only in case name the same file
/// (see [`same_program`]).
///
/// When the client says `ashlr-md` is already registered, the command it runs
/// is checked. It used to be reported as success whatever it ran, so after
/// the app was moved (say from Downloads to Applications) the button said
/// "already registered" while the client failed to start the server. Now a
/// registration that runs a program which no longer exists is removed and
/// added again for `mcp_path`; one that runs some other program that does
/// exist is the user's choice and is kept, and the message says so; and when
/// the client does not say what it runs, the message says how to re-add it.
/// A registration that reaches this app's binary by another path (a symlink,
/// or on macOS a difference in case) is this app's, not another program: it
/// used to be kept as "another program" with advice to remove it.
fn connect_agent_cli(
    cli: &AgentCli,
    mcp_path: &str,
    run: CliRunner,
    exists: &dyn Fn(&str) -> bool,
    ignore_case: bool,
) -> Result<String, String> {
    let spawn_error = |e: std::io::Error| {
        if e.kind() == std::io::ErrorKind::NotFound {
            cli.not_found.to_string()
        } else {
            format!("Failed to run {} CLI: {e}", cli.program)
        }
    };
    let label = cli.label;
    let add_args = [cli.add, &[mcp_path]].concat();
    let add_cmd = format!("{} mcp add", cli.program);
    let remove_cmd = format!("{} {}", cli.program, cli.remove.join(" "));

    let added = run(&add_args).map_err(spawn_error)?;
    if added.success {
        let out = added.stdout.trim();
        return Ok(if cli.show_add_output && !out.is_empty() {
            format!("{out}\n{}", cli.restart)
        } else {
            format!(
                "Ashlr MD registered as an MCP server in {label}.\n{}",
                cli.restart
            )
        });
    }
    if !added.detail().to_lowercase().contains("already") {
        return Err(added.failure(&add_cmd));
    }

    let registered = cli.get.iter().find_map(|args| {
        run(args)
            .ok()
            .filter(|o| o.success)
            .and_then(|o| registered_command(&o.stdout))
    });
    match registered {
        Some(current) if current == mcp_path => Ok(format!(
            "ashlr-md is already registered in {label}, running {mcp_path}. Restart \
             {label} if you haven't already."
        )),
        Some(current) if same_program(&current, mcp_path, exists, ignore_case) => Ok(format!(
            "ashlr-md is already registered in {label}, running {current}, which is this \
             app's {mcp_path}. Restart {label} if you haven't already."
        )),
        Some(old) if !exists(&old) => {
            let removed = run(cli.remove).map_err(spawn_error)?;
            if !removed.success {
                return Err(format!(
                    "ashlr-md is registered in {label} with {old}, which no longer exists, \
                     and `{remove_cmd}` failed: {}\nRun it, then connect again.",
                    removed.failure(&remove_cmd)
                ));
            }
            let again = run(&add_args).map_err(spawn_error)?;
            if !again.success {
                return Err(format!(
                    "ashlr-md was registered in {label} with {old}, which no longer exists. \
                     That registration was removed, but adding {mcp_path} failed: {}\n\
                     Connect again to register it.",
                    again.failure(&add_cmd)
                ));
            }
            Ok(format!(
                "ashlr-md was registered in {label} with {old}, which no longer exists (the \
                 app was moved or reinstalled). It now runs {mcp_path}.\n{}",
                cli.restart
            ))
        }
        Some(other) => Ok(format!(
            "ashlr-md is already registered in {label}, but it runs {other}, not this \
             app's {mcp_path}. It was left as it is. To use this app's, run \
             `{remove_cmd}` and connect again."
        )),
        None => Ok(format!(
            "ashlr-md is already registered in {label}, but {label} did not say which \
             program it runs. If Ashlr MD has moved since it was registered, run \
             `{remove_cmd}` and connect again."
        )),
    }
}

// ── Claude Code ───────────────────────────────────────────────────────────────

/// Register Ashlr MD as an MCP server in Claude Code (user scope).
///
/// Runs: `claude mcp add --scope user ashlr-md <mcp-binary-path>`
///
/// The `--scope user` flag registers it in the user scope (`~/.claude.json`) so
/// the server is available across all projects, not just the current directory.
/// When it is already registered, the path it runs is checked and a stale one
/// repointed: see [`connect_agent_cli`].
#[tauri::command]
pub fn connect_claude_code(app: tauri::AppHandle) -> Result<String, String> {
    let mcp_path = resolve_mcp_binary_path(&app)?;
    connect_agent_cli(
        &CLAUDE_CLI,
        &mcp_path,
        &|args| run_agent_cli(CLAUDE_CLI.program, args),
        &|p| std::path::Path::new(p).is_file(),
        PATHS_IGNORE_CASE,
    )
}

// ── Client config files ───────────────────────────────────────────────────────

/// The text of a client's config file, `None` when there is none yet.
///
/// A file that cannot be read used to be reported as "Cannot read <path>:
/// <error>" and nothing more; the message now says it was left unchanged
/// and what to check.
fn read_config(path: &std::path::Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(|e| {
        format!(
            "Cannot read {}: {e}. It was not changed. Check that it is a text file you \
             can read, then try again.",
            path.display()
        )
    })
}

/// Write a client's config file, with a next step when that fails.
fn write_config(path: &std::path::Path, text: &str) -> Result<(), String> {
    fs::write(path, text).map_err(|e| {
        format!(
            "Cannot write {}: {e}. Check that you can write to it and to its folder, \
             then try again.",
            path.display()
        )
    })
}

/// The error when the home directory (which holds `~/.cursor` and
/// `~/.claude`) cannot be found. It used to be "Cannot determine home
/// directory" and nothing more; it now names the setting to fix.
#[cfg(not(windows))]
const NO_HOME_DIR: &str = "Cannot determine home directory. Set HOME to your home folder \
    in the environment Ashlr MD starts from, then restart Ashlr MD and try again.";
#[cfg(windows)]
const NO_HOME_DIR: &str = "Cannot determine home directory. Check that your Windows user \
    profile folder exists and that you are signed in to it, then restart Ashlr MD and try \
    again.";

/// `<home>/<dir>/<file>`, or [`NO_HOME_DIR`] when there is no home.
fn home_file(home: Option<PathBuf>, dir: &str, file: &str) -> Result<PathBuf, String> {
    home.map(|h| h.join(dir).join(file))
        .ok_or_else(|| NO_HOME_DIR.to_string())
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// Cursor's global MCP configuration file.
///
/// As of Cursor 0.43+ (early 2025) the authoritative location is
/// `~/.cursor/mcp.json`. A project-level override at `.cursor/mcp.json` is
/// also supported by Cursor, but we write to the global file so the server is
/// available in every project.
fn cursor_mcp_json_path() -> Result<PathBuf, String> {
    home_file(dirs::home_dir(), ".cursor", "mcp.json")
}

/// Merge an `ashlr-md` MCP server entry into `~/.cursor/mcp.json`.
///
/// The file format Cursor expects is:
/// ```json
/// {
///   "mcpServers": {
///     "ashlr-md": {
///       "command": "/path/to/mdopener-mcp",
///       "args": []
///     }
///   }
/// }
/// ```
///
/// This command:
///   - Creates the file (and `~/.cursor/` directory) if they don't exist.
///   - Merges the `ashlr-md` entry into any existing `mcpServers` object,
///     leaving all other servers untouched.
///   - Overwrites an existing `ashlr-md` entry with the current binary path
///     (keeps it up to date when the app is reinstalled).
#[tauri::command]
pub fn connect_cursor(app: tauri::AppHandle) -> Result<String, String> {
    let mcp_path = resolve_mcp_binary_path(&app)?;
    let config_path = cursor_mcp_json_path()?;

    // Ensure ~/.cursor/ exists.
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }

    // Read the existing config (if any) and merge our entry into it.
    let existing = read_config(&config_path)?;
    let serialised = merge_cursor_config(existing.as_deref(), &mcp_path)
        .map_err(|why| format!("{} {why}", config_path.display()))?;

    write_config(&config_path, &serialised)?;

    Ok(format!(
        "ashlr-md added to {}.\n\
         Restart Cursor (or reload the MCP servers in Settings → MCP) to pick it up.",
        config_path.display()
    ))
}

/// The text of `~/.cursor/mcp.json` with an `ashlr-md` entry for `mcp_path`
/// merged into `existing` (the file's current text, `None` when there is
/// none): other servers and keys are kept, and an earlier `ashlr-md` entry is
/// overwritten with the current path. Pretty-printed, as Cursor shows this
/// file in its UI.
///
/// A file that is not valid JSON, not a JSON object, or has a `mcpServers`
/// that is not an object is refused (the message is appended to the path).
/// It used to be replaced by `{}`, which deleted every other MCP server the
/// user had configured, and a top-level array or string panicked the command.
fn merge_cursor_config(existing: Option<&str>, mcp_path: &str) -> Result<String, String> {
    let mut root: Value = match existing.map(str::trim) {
        None | Some("") => json!({}),
        Some(raw) => serde_json::from_str(raw).map_err(|e| {
            format!(
                "is not valid JSON ({e}), so it was not changed. Fix it (comments and \
                 trailing commas cannot be merged) or add the ashlr-md entry by hand, \
                 then retry."
            )
        })?,
    };
    if root.is_null() {
        root = json!({});
    }
    let Some(obj) = root.as_object_mut() else {
        return Err(
            "is not a JSON object, so it was not changed. Fix it manually and retry.".to_string(),
        );
    };
    let servers = obj.entry("mcpServers").or_insert_with(|| json!({}));
    if servers.is_null() {
        *servers = json!({});
    }
    let Some(servers) = servers.as_object_mut() else {
        return Err(
            "has a `mcpServers` value that is not an object, so it was not changed. \
                    Fix it manually and retry."
                .to_string(),
        );
    };
    servers.insert(
        "ashlr-md".to_string(),
        json!({ "command": mcp_path, "args": [] }),
    );
    serde_json::to_string_pretty(&root).map_err(|e| format!("JSON serialisation error: {e}"))
}

// ── Codex ─────────────────────────────────────────────────────────────────────

/// Register Ashlr MD as an MCP server in OpenAI Codex (global config).
///
/// Runs: `codex mcp add ashlr-md -- <mcp-binary-path>`, which
/// writes an `[mcp_servers.ashlr-md]` table to `~/.codex/config.toml`. Codex
/// consumes MCP *tools* (not resources/prompts) — exactly what ashlr-md exposes
/// for agent control. An existing registration is checked as for Claude Code
/// (see [`connect_agent_cli`]).
#[tauri::command]
pub fn connect_codex(app: tauri::AppHandle) -> Result<String, String> {
    let mcp_path = resolve_mcp_binary_path(&app)?;
    connect_agent_cli(
        &CODEX_CLI,
        &mcp_path,
        &|args| run_agent_cli(CODEX_CLI.program, args),
        &|p| std::path::Path::new(p).is_file(),
        PATHS_IGNORE_CASE,
    )
}

// ── Claude Code auto-open hook ──────────────────────────────────────────────────

/// Install a Claude Code `PostToolUse` hook so that whenever Claude writes or
/// edits a Markdown file, it auto-opens in Ashlr MD for review.
///
/// Merges into `~/.claude/settings.json` (verified schema):
/// ```json
/// { "hooks": { "PostToolUse": [ { "matcher": "Edit|Write",
///   "hooks": [ { "type": "command", "command": "'<mdopen>' --hook",
///                "if": "Write(*.md)|Edit(*.md)" } ] } ] } }
/// ```
/// The `mdopen` path is POSIX single-quoted (see [`mcp_command::hook_command`]).
/// Idempotent: re-running won't add a duplicate hook, an entry an earlier
/// version wrote unquoted for the same path is repaired in place, and our
/// entry for an `mdopen` that no longer exists is pointed at this app's.
#[tauri::command]
pub fn install_claude_hook(app: tauri::AppHandle) -> Result<String, String> {
    let mdopen = resolve_sidecar_binary(&app, "mdopen")?;

    let settings_path = home_file(dirs::home_dir(), ".claude", "settings.json")?;
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }

    let mut root: Value = match read_config(&settings_path)? {
        Some(raw) => serde_json::from_str(&raw).map_err(|e| {
            format!(
                "{} is not valid JSON ({e}). Fix it and retry.",
                settings_path.display()
            )
        })?,
        None => json!({}),
    };

    let outcome = merge_hook(&mut root, &mdopen)
        .map_err(|shape| format!("{} {shape}", settings_path.display()))?;
    if outcome == HookMerge::AlreadyInstalled {
        return Ok("Auto-open hook is already installed in Claude Code.".to_string());
    }

    let serialised = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("JSON serialisation error: {e}"))?;
    write_config(&settings_path, &serialised)?;

    Ok(match outcome {
        HookMerge::Repaired => format!(
            "Auto-open hook repaired in {}: its mdopen path is now quoted, so the \
             space in \"Ashlr MD\" no longer breaks it. Restart Claude Code to pick it up.",
            settings_path.display()
        ),
        HookMerge::Moved(old) => format!(
            "Auto-open hook updated in {}: it ran {old}, which no longer exists (the app \
             was moved or reinstalled), and now runs {mdopen}. Restart Claude Code to pick \
             it up.",
            settings_path.display()
        ),
        _ => format!(
            "Auto-open hook installed in {}.\n\
             Claude Code will now open Markdown files in Ashlr MD as it writes them. \
             Restart Claude Code to pick it up.",
            settings_path.display()
        ),
    })
}

/// What [`merge_hook`] did to the settings document.
#[derive(Debug, PartialEq, Eq)]
enum HookMerge {
    Installed,
    /// Our earlier unquoted `<mdopen> --hook` entry was rewritten in place.
    Repaired,
    /// Our quoted entry ran an `mdopen` that no longer exists (the path it
    /// ran is carried); it now runs this app's.
    Moved(String),
    AlreadyInstalled,
}

/// Merge the auto-open hook for `mdopen` into a parsed `settings.json`.
///
/// Unexpected `hooks` / `hooks.PostToolUse` shapes are an error (the message
/// is appended to the settings path) rather than silently overwritten.
fn merge_hook(root: &mut Value, mdopen: &str) -> Result<HookMerge, &'static str> {
    merge_hook_with(
        root,
        mdopen,
        &|p| std::path::Path::new(p).is_file(),
        PATHS_IGNORE_CASE,
    )
}

/// The `mdopen` path a hook `command` runs, when it is the form we write,
/// `'<path>' --hook` with the path POSIX single-quoted and its file named
/// `mdopen` (or `mdopen.exe`). `None` for any other command.
fn our_hook_path(command: &str) -> Option<String> {
    let quoted = command.strip_suffix(" --hook")?;
    let inner = quoted.strip_prefix('\'')?.strip_suffix('\'')?;
    // Inside the quotes, a `'` only ever appears as the `'\''` escape.
    if inner.replace("'\\''", "").contains('\'') {
        return None;
    }
    let path = inner.replace("'\\''", "'");
    let name = path.rsplit(['/', '\\']).next()?;
    matches!(name, "mdopen" | "mdopen.exe").then_some(path)
}

/// [`merge_hook`] with the file-existence check and `ignore_case` (see
/// [`same_program`]) injected for tests.
///
/// An entry we wrote for an `mdopen` that no longer exists (the app was moved,
/// e.g. from Downloads to Applications, or reinstalled elsewhere) is pointed
/// at `mdopen`. It used to count as installed, so the button said "already
/// installed" while the hook failed on every write. An entry running some
/// other `mdopen` that does exist (say one the CLI installer put on `PATH`)
/// is kept.
///
/// An entry whose `mdopen` is this app's by another path (a symlink, or on
/// macOS a difference in case) is the current one, checked with
/// [`same_program`]. It used to be matched by exact string only, so a
/// dangling entry beside it was repointed and the hook then ran twice.
fn merge_hook_with(
    root: &mut Value,
    mdopen: &str,
    exists: &dyn Fn(&str) -> bool,
    ignore_case: bool,
) -> Result<HookMerge, &'static str> {
    let command = mcp_command::hook_command(mdopen);
    let legacy = mcp_command::legacy_hook_command(mdopen);

    if root.is_null() {
        *root = json!({});
    }
    if !root.is_object() {
        return Err("is not a JSON object. Fix it manually and retry.");
    }
    // Don't clobber a user's settings if these keys exist with an unexpected
    // shape — bail and let them fix it rather than silently overwrite real data.
    if root.get("hooks").is_some_and(|v| !v.is_object()) {
        return Err("has a non-object `hooks` value. Fix it manually and retry.");
    }
    if !root.get("hooks").map(|v| v.is_object()).unwrap_or(false) {
        root["hooks"] = json!({});
    }
    if root["hooks"]
        .get("PostToolUse")
        .is_some_and(|v| !v.is_array())
    {
        return Err("has a non-array `hooks.PostToolUse` value. Fix it manually and retry.");
    }
    if !root["hooks"]
        .get("PostToolUse")
        .map(|v| v.is_array())
        .unwrap_or(false)
    {
        root["hooks"]["PostToolUse"] = json!([]);
    }
    let arr = root["hooks"]["PostToolUse"].as_array_mut().unwrap();

    // Earlier versions wrote this exact path unquoted, which splits at the
    // space in "Ashlr MD". Quote it in place; other commands stay untouched.
    let mut repaired = false;
    for entry in arr.iter_mut() {
        let Some(hooks) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
            continue;
        };
        for hook in hooks.iter_mut().filter(|h| h.is_object()) {
            if hook.get("command").and_then(Value::as_str) == Some(legacy.as_str()) {
                hook["command"] = json!(command);
                repaired = true;
            }
        }
    }
    if repaired {
        return Ok(HookMerge::Repaired);
    }

    // When the current command is already there, a dangling copy is left for
    // the user: repointing it would run the hook twice on every write.
    let is_current = |c: &str| {
        c == command
            || our_hook_path(c).is_some_and(|p| same_program(&p, mdopen, exists, ignore_case))
    };
    let has_current = arr.iter().any(|entry| {
        entry["hooks"].as_array().is_some_and(|hs| {
            hs.iter()
                .any(|h| h["command"].as_str().is_some_and(is_current))
        })
    });
    let mut moved = None;
    for entry in arr.iter_mut().filter(|_| !has_current) {
        let Some(hooks) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
            continue;
        };
        for hook in hooks.iter_mut().filter(|h| h.is_object()) {
            let Some(old) = hook
                .get("command")
                .and_then(Value::as_str)
                .filter(|c| *c != command)
                .and_then(our_hook_path)
            else {
                continue;
            };
            if !exists(&old) {
                hook["command"] = json!(command);
                moved.get_or_insert(old);
            }
        }
    }
    if let Some(old) = moved {
        return Ok(HookMerge::Moved(old));
    }

    // Idempotency: skip if any existing hook already runs our `mdopen --hook`.
    let already = arr.iter().any(|entry| {
        entry["hooks"]
            .as_array()
            .map(|hs| {
                hs.iter().any(|h| {
                    h["command"]
                        .as_str()
                        .map(|c| c.contains("mdopen") && c.contains("--hook"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    });
    if already {
        return Ok(HookMerge::AlreadyInstalled);
    }

    arr.push(json!({
        "matcher": "Edit|Write",
        "hooks": [{
            "type": "command",
            "command": command,
            "if": "Write(*.md)|Edit(*.md)"
        }]
    }));
    Ok(HookMerge::Installed)
}

// ── Copy-button helper ────────────────────────────────────────────────────────

/// Return the command a user can paste into a Unix shell, or PowerShell on
/// Windows, to register Ashlr MD with Claude Code — used by Settings' Copy button.
///
/// Falls back to the host platform's typical install path, shown as a
/// placeholder, if the binary cannot be resolved (e.g. a dev build without the
/// sidecar); see [`sidecar_path::unresolved_mcp_placeholder`].
#[tauri::command]
pub fn mcp_command_string(app: tauri::AppHandle) -> String {
    let path = resolve_mcp_binary_path(&app)
        .unwrap_or_else(|_| sidecar_path::unresolved_mcp_placeholder());
    mcp_command::mcp_command(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MDOPEN: &str = "/Applications/Ashlr MD.app/Contents/Resources/mdopen";

    /// Without a home directory Connect to Cursor and Auto-open agent Markdown
    /// said "Cannot determine home directory" and nothing more.
    #[test]
    fn no_home_directory_error_names_a_next_step() {
        let err = home_file(None, ".cursor", "mcp.json").unwrap_err();
        assert!(
            err.starts_with("Cannot determine home directory. "),
            "{err}"
        );
        #[cfg(not(windows))]
        assert!(err.contains("Set HOME to your home folder"), "{err}");
        #[cfg(windows)]
        assert!(err.contains("Windows user profile folder"), "{err}");
        assert!(err.contains("restart Ashlr MD and try"), "{err}");
        assert_eq!(
            home_file(Some(PathBuf::from("/h")), ".claude", "settings.json").unwrap(),
            PathBuf::from("/h").join(".claude").join("settings.json")
        );
    }

    fn commands(root: &Value) -> Vec<String> {
        root["hooks"]["PostToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|e| e["hooks"].as_array().unwrap().clone())
            .map(|h| h["command"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn fresh_settings_get_one_quoted_hook() {
        let mut root = json!({});
        assert_eq!(merge_hook(&mut root, MDOPEN), Ok(HookMerge::Installed));
        assert_eq!(
            commands(&root),
            ["'/Applications/Ashlr MD.app/Contents/Resources/mdopen' --hook"]
        );
        let entry = &root["hooks"]["PostToolUse"][0];
        assert_eq!(entry["matcher"], "Edit|Write");
        assert_eq!(entry["hooks"][0]["if"], "Write(*.md)|Edit(*.md)");
        // Re-running is a no-op.
        let before = root.clone();
        assert_eq!(
            merge_hook(&mut root, MDOPEN),
            Ok(HookMerge::AlreadyInstalled)
        );
        assert_eq!(root, before);
    }

    #[test]
    fn legacy_unquoted_entry_is_repaired_in_place_and_others_kept() {
        let mut root = json!({
            "model": "keep-me",
            "hooks": { "PostToolUse": [
                { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo hi" }] },
                { "matcher": "Edit|Write", "hooks": [{
                    "type": "command",
                    "command": format!("{MDOPEN} --hook"),
                    "if": "Write(*.md)|Edit(*.md)"
                }] }
            ] }
        });
        assert_eq!(merge_hook(&mut root, MDOPEN), Ok(HookMerge::Repaired));
        assert_eq!(
            commands(&root),
            ["echo hi".to_string(), format!("'{MDOPEN}' --hook"),]
        );
        assert_eq!(root["model"], "keep-me");
        assert_eq!(
            merge_hook(&mut root, MDOPEN),
            Ok(HookMerge::AlreadyInstalled)
        );
    }

    const MCP: &str = "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp";

    #[test]
    fn cursor_config_keeps_other_servers_and_updates_ours() {
        let existing = r#"{ "theme": "dark", "mcpServers": {
            "other": { "command": "/bin/other", "args": ["-x"] },
            "ashlr-md": { "command": "/old/path/mdopener-mcp", "args": [] } } }"#;
        let out: Value =
            serde_json::from_str(&merge_cursor_config(Some(existing), MCP).unwrap()).unwrap();
        assert_eq!(out["theme"], "dark");
        assert_eq!(out["mcpServers"]["other"]["command"], "/bin/other");
        assert_eq!(out["mcpServers"]["ashlr-md"]["command"], MCP);
        for fresh in [None, Some(""), Some("  \n"), Some("null"), Some("{}")] {
            let out: Value =
                serde_json::from_str(&merge_cursor_config(fresh, MCP).unwrap()).unwrap();
            assert_eq!(
                out,
                json!({ "mcpServers": { "ashlr-md": { "command": MCP, "args": [] } } })
            );
        }
    }

    #[test]
    fn cursor_config_that_cannot_be_merged_is_refused_not_replaced() {
        // A comment or trailing comma used to make the whole file `{}` plus
        // our entry, deleting the user's other servers; a top-level array
        // or string panicked on `root["mcpServers"]`.
        let with_comment =
            "{\n  // mine\n  \"mcpServers\": { \"other\": { \"command\": \"x\" } }\n}";
        let err = merge_cursor_config(Some(with_comment), MCP).unwrap_err();
        assert!(
            err.contains("not valid JSON") && err.contains("not changed"),
            "{err}"
        );
        for bad in [
            r#"[1, 2]"#,
            r#""text""#,
            r#"{ "mcpServers": [] }"#,
            r#"{ "mcpServers": "x" }"#,
        ] {
            let err = merge_cursor_config(Some(bad), MCP).unwrap_err();
            assert!(err.contains("not changed"), "{bad}: {err}");
        }
    }

    #[test]
    fn hook_for_an_mdopen_that_is_gone_is_pointed_at_this_app() {
        let old = "/Users/me/Downloads/Ashlr MD.app/Contents/Resources/mdopen";
        let other = "/usr/local/bin/mdopen";
        let mut root = json!({ "hooks": { "PostToolUse": [
            { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo hi" }] },
            { "matcher": "Edit|Write", "hooks": [{
                "type": "command",
                "command": mcp_command::hook_command(old),
                "if": "Write(*.md)|Edit(*.md)"
            }] }
        ] } });
        let gone = |p: &str| p != old;
        assert_eq!(
            merge_hook_with(&mut root, MDOPEN, &gone, false),
            Ok(HookMerge::Moved(old.to_string()))
        );
        assert_eq!(
            commands(&root),
            ["echo hi".to_string(), mcp_command::hook_command(MDOPEN)]
        );
        assert_eq!(
            merge_hook_with(&mut root, MDOPEN, &gone, false),
            Ok(HookMerge::AlreadyInstalled)
        );

        // A dangling entry next to the current one is not duplicated.
        let mut root = json!({ "hooks": { "PostToolUse": [{ "matcher": "Edit|Write",
            "hooks": [
                { "type": "command", "command": mcp_command::hook_command(old) },
                { "type": "command", "command": mcp_command::hook_command(MDOPEN) }
            ] }] } });
        let before = root.clone();
        assert_eq!(
            merge_hook_with(&mut root, MDOPEN, &gone, false),
            Ok(HookMerge::AlreadyInstalled)
        );
        assert_eq!(root, before);

        // Another mdopen that still exists is the user's choice: kept.
        let mut root = json!({ "hooks": { "PostToolUse": [{ "matcher": "Edit|Write",
            "hooks": [{ "type": "command", "command": mcp_command::hook_command(other) }] }] } });
        let before = root.clone();
        assert_eq!(
            merge_hook_with(&mut root, MDOPEN, &|_| true, false),
            Ok(HookMerge::AlreadyInstalled)
        );
        assert_eq!(root, before);
    }

    /// A current entry that reaches this app's `mdopen` by another path used
    /// to be missed, so a dangling entry beside it was repointed and the hook
    /// ran twice on every write.
    #[cfg(unix)]
    #[test]
    fn hook_reached_through_a_symlink_or_case_is_the_current_one() {
        let dir = std::env::temp_dir().join(format!("ashlr-md-hook-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("real")).unwrap();
        let real = dir.join("real/mdopen");
        fs::write(&real, "").unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();
        let real_s = real.to_str().unwrap().to_string();
        let linked = dir.join("link/mdopen").to_str().unwrap().to_string();
        let old = "/Users/me/Downloads/Ashlr MD.app/Contents/Resources/mdopen";
        let is_file = |p: &str| std::path::Path::new(p).is_file();
        let with = |current: &str| {
            json!({ "hooks": { "PostToolUse": [{ "matcher": "Edit|Write",
                "hooks": [
                    { "type": "command", "command": mcp_command::hook_command(old) },
                    { "type": "command", "command": mcp_command::hook_command(current) }
                ] }] } })
        };

        let mut root = with(&linked);
        let before = root.clone();
        assert_eq!(
            merge_hook_with(&mut root, &real_s, &is_file, false),
            Ok(HookMerge::AlreadyInstalled)
        );
        assert_eq!(root, before);
        fs::remove_dir_all(&dir).unwrap();

        // A difference in case is the same file only where case is ignored.
        // Keep these synthetic paths off disk: an installed app on a
        // case-insensitive volume would canonicalize both spellings alike,
        // even when this test asks for a case-sensitive comparison.
        let current = dir.join("Applications/Ashlr MD.app/Contents/Resources/mdopen");
        let upper = dir.join("Applications/ASHLR MD.app/Contents/Resources/mdopen");
        let current = current.to_str().unwrap();
        let upper = upper.to_str().unwrap();
        let exists = |p: &str| p != old;
        let mut root = with(upper);
        let before = root.clone();
        assert_eq!(
            merge_hook_with(&mut root, current, &exists, true),
            Ok(HookMerge::AlreadyInstalled)
        );
        assert_eq!(root, before);
        let mut root = with(upper);
        assert_eq!(
            merge_hook_with(&mut root, current, &exists, false),
            Ok(HookMerge::Moved(old.to_string()))
        );
    }

    #[test]
    fn only_our_quoted_mdopen_form_is_read_as_our_hook() {
        assert_eq!(
            our_hook_path("'/tmp/O'\\''Brien/mdopen' --hook").as_deref(),
            Some("/tmp/O'Brien/mdopen")
        );
        assert_eq!(
            our_hook_path("'C:\\Ashlr MD\\mdopen.exe' --hook").as_deref(),
            Some("C:\\Ashlr MD\\mdopen.exe")
        );
        for not_ours in [
            "/usr/bin/mdopen --hook",
            "'/usr/bin/mdopen' --hook && rm -rf x",
            "'/usr/bin/mdopen-wrapper' --hook",
            "'/a'b/mdopen' --hook",
            "echo mdopen --hook",
        ] {
            assert_eq!(our_hook_path(not_ours), None, "{not_ours}");
        }
    }

    /// A scripted client CLI: answers each argument list from `script` (a
    /// missing one fails), and records every call.
    struct FakeCli {
        script: Vec<(String, CliOutput)>,
        calls: std::cell::RefCell<Vec<String>>,
    }

    fn ok(stdout: &str) -> CliOutput {
        CliOutput {
            success: true,
            code: Some(0),
            stdout: stdout.to_string(),
            stderr: String::new(),
        }
    }

    fn fail(stderr: &str) -> CliOutput {
        CliOutput {
            success: false,
            code: Some(1),
            stdout: String::new(),
            stderr: stderr.to_string(),
        }
    }

    impl FakeCli {
        fn new(script: &[(&str, CliOutput)]) -> Self {
            Self {
                script: script
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.clone()))
                    .collect(),
                calls: Default::default(),
            }
        }

        fn run(&self, args: &[&str]) -> std::io::Result<CliOutput> {
            let key = args.join(" ");
            self.calls.borrow_mut().push(key.clone());
            Ok(self
                .script
                .iter()
                .rev()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| fail("unknown command")))
        }

        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    const OLD_MCP: &str = "/Users/me/Downloads/Ashlr MD.app/Contents/Resources/mdopener-mcp";
    const CLAUDE_EXISTS: &str = "MCP server ashlr-md already exists in user config";

    fn claude_get(command: &str) -> String {
        format!(
            "ashlr-md:\n  Scope: User config (available in all your projects)\n  \
             Status: x Failed to connect\n  Type: stdio\n  Command: {command}\n  Args: \n"
        )
    }

    #[test]
    fn stale_claude_registration_is_removed_and_added_again() {
        let add = format!("mcp add --scope user ashlr-md {MCP}");
        // `add` answers "already exists" until the stale entry is removed.
        let cli = FakeCli::new(&[
            (&add, fail(CLAUDE_EXISTS)),
            ("mcp get ashlr-md", ok(&claude_get(OLD_MCP))),
            ("mcp remove --scope user ashlr-md", ok("Removed")),
        ]);
        let removed_then_added = |args: &[&str]| {
            let removed = cli
                .calls()
                .contains(&"mcp remove --scope user ashlr-md".to_string());
            if removed && args.join(" ") == add {
                cli.calls.borrow_mut().push(add.clone());
                return Ok(ok(""));
            }
            cli.run(args)
        };
        let msg = connect_agent_cli(
            &CLAUDE_CLI,
            MCP,
            &removed_then_added,
            &|p| p != OLD_MCP,
            false,
        )
        .unwrap();
        assert_eq!(
            cli.calls(),
            [
                add.clone(),
                "mcp get ashlr-md".to_string(),
                "mcp remove --scope user ashlr-md".to_string(),
                add.clone(),
            ]
        );
        assert!(
            msg.contains(OLD_MCP) && msg.contains("no longer exists"),
            "{msg}"
        );
        assert!(msg.contains(&format!("now runs {MCP}")), "{msg}");
    }

    #[test]
    fn current_claude_registration_is_reported_with_its_path_and_kept() {
        let add = format!("mcp add --scope user ashlr-md {MCP}");
        let cli = FakeCli::new(&[
            (&add, fail(CLAUDE_EXISTS)),
            ("mcp get ashlr-md", ok(&claude_get(MCP))),
        ]);
        let msg = connect_agent_cli(&CLAUDE_CLI, MCP, &|a| cli.run(a), &|_| true, false).unwrap();
        assert!(
            msg.contains("already registered") && msg.contains(MCP),
            "{msg}"
        );
        assert_eq!(cli.calls(), [add, "mcp get ashlr-md".to_string()]);
    }

    #[test]
    fn another_existing_registration_is_kept_and_named() {
        let other = "/usr/local/bin/mdopener-mcp";
        let add = format!("mcp add --scope user ashlr-md {MCP}");
        let cli = FakeCli::new(&[
            (&add, fail(CLAUDE_EXISTS)),
            ("mcp get ashlr-md", ok(&claude_get(other))),
        ]);
        let msg = connect_agent_cli(&CLAUDE_CLI, MCP, &|a| cli.run(a), &|_| true, false).unwrap();
        assert!(
            msg.contains(other) && msg.contains("left as it is"),
            "{msg}"
        );
        assert!(
            msg.contains("claude mcp remove --scope user ashlr-md"),
            "{msg}"
        );
        assert!(!cli.calls().iter().any(|c| c.contains("remove")));
    }

    /// A registration that reaches this app's binary through a symlink used
    /// to count as another program: kept, with advice to remove it.
    #[cfg(unix)]
    #[test]
    fn a_registration_through_a_symlink_is_this_apps() {
        let dir = std::env::temp_dir().join(format!("ashlr-md-symlink-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("real")).unwrap();
        let real = dir.join("real/mdopener-mcp");
        fs::write(&real, "").unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();
        let other = dir.join("real/other-mcp");
        fs::write(&other, "").unwrap();
        let real_s = real.to_str().unwrap().to_string();
        let linked = dir.join("link/mdopener-mcp").to_str().unwrap().to_string();
        let is_file = |p: &str| std::path::Path::new(p).is_file();

        let add = format!("mcp add --scope user ashlr-md {real_s}");
        let cli = FakeCli::new(&[
            (&add, fail(CLAUDE_EXISTS)),
            ("mcp get ashlr-md", ok(&claude_get(&linked))),
        ]);
        let msg =
            connect_agent_cli(&CLAUDE_CLI, &real_s, &|a| cli.run(a), &is_file, false).unwrap();
        assert!(
            msg.contains(&format!("running {linked}, which is this app's {real_s}")),
            "{msg}"
        );
        assert!(!msg.contains("left as it is"), "{msg}");
        assert!(!cli.calls().iter().any(|c| c.contains("remove")));

        // Another file in the same folder is still another program.
        let other_s = other.to_str().unwrap();
        let cli = FakeCli::new(&[
            (&add, fail(CLAUDE_EXISTS)),
            ("mcp get ashlr-md", ok(&claude_get(other_s))),
        ]);
        let msg =
            connect_agent_cli(&CLAUDE_CLI, &real_s, &|a| cli.run(a), &is_file, false).unwrap();
        assert!(msg.contains("left as it is"), "{msg}");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// On macOS a path that differs only in case names the same file; on
    /// other platforms it is another program.
    #[test]
    fn a_registration_differing_only_in_case_is_this_apps_where_case_is_ignored() {
        // Do not canonicalize a real installation on the host filesystem.
        let dir = std::env::temp_dir().join(format!("ashlr-md-case-{}", std::process::id()));
        let mcp = dir.join("Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp");
        let upper = dir.join("Applications/ASHLR MD.app/Contents/Resources/mdopener-mcp");
        let mcp = mcp.to_str().unwrap();
        let upper = upper.to_str().unwrap();
        let add = format!("mcp add --scope user ashlr-md {mcp}");
        let script = [
            (add.as_str(), fail(CLAUDE_EXISTS)),
            ("mcp get ashlr-md", ok(&claude_get(upper))),
        ];
        let cli = FakeCli::new(&script);
        let msg = connect_agent_cli(&CLAUDE_CLI, mcp, &|a| cli.run(a), &|_| true, true).unwrap();
        assert!(msg.contains("which is this app's"), "{msg}");
        assert!(!cli.calls().iter().any(|c| c.contains("remove")));

        let cli = FakeCli::new(&script);
        let msg = connect_agent_cli(&CLAUDE_CLI, mcp, &|a| cli.run(a), &|_| true, false).unwrap();
        assert!(msg.contains("left as it is"), "{msg}");

        // A registered path that is gone is stale, whatever its case.
        let cli = FakeCli::new(&script);
        let gone = |p: &str| p != upper;
        let msg = connect_agent_cli(&CLAUDE_CLI, mcp, &|a| cli.run(a), &gone, true).unwrap_err();
        assert!(msg.contains("no longer exists"), "{msg}");

        assert_eq!(PATHS_IGNORE_CASE, cfg!(target_os = "macos"));
    }

    #[test]
    fn unreadable_registration_says_how_to_re_add() {
        let add = format!("mcp add --scope user ashlr-md {MCP}");
        let cli = FakeCli::new(&[(&add, fail(CLAUDE_EXISTS))]);
        let msg = connect_agent_cli(&CLAUDE_CLI, MCP, &|a| cli.run(a), &|_| true, false).unwrap();
        assert!(
            msg.contains("did not say which program")
                && msg.contains("claude mcp remove --scope user ashlr-md"),
            "{msg}"
        );
    }

    #[test]
    fn stale_codex_registration_is_read_from_json_and_repointed() {
        let add = format!("mcp add ashlr-md -- {MCP}");
        let get = json!({
            "name": "ashlr-md",
            "enabled": true,
            "transport": { "type": "stdio", "command": OLD_MCP, "args": [] }
        })
        .to_string();
        let cli = FakeCli::new(&[
            (&add, fail("Error: MCP server 'ashlr-md' already exists")),
            ("mcp get ashlr-md --json", ok(&get)),
            ("mcp remove ashlr-md", ok("")),
        ]);
        let then_ok = |args: &[&str]| {
            if args.join(" ") == add && cli.calls().iter().any(|c| c == "mcp remove ashlr-md") {
                cli.calls.borrow_mut().push(add.clone());
                return Ok(ok(""));
            }
            cli.run(args)
        };
        let msg = connect_agent_cli(&CODEX_CLI, MCP, &then_ok, &|_| false, false).unwrap();
        assert!(msg.contains(&format!("now runs {MCP}")), "{msg}");
        assert_eq!(cli.calls().last(), Some(&add));

        // Without `--json` (an older Codex), the text form is read instead.
        assert_eq!(
            registered_command("ashlr-md\n  enabled: true\n  command: /a b/mcp\n  args: -\n")
                .as_deref(),
            Some("/a b/mcp")
        );
    }

    #[test]
    fn a_failed_add_that_is_not_already_registered_is_an_error() {
        // "does not exist" used to read as "already exists" (it contains
        // "exists"), and was reported as success.
        let add = format!("mcp add --scope user ashlr-md {MCP}");
        let cli = FakeCli::new(&[(&add, fail("Error: path does not exist"))]);
        let err =
            connect_agent_cli(&CLAUDE_CLI, MCP, &|a| cli.run(a), &|_| true, false).unwrap_err();
        assert_eq!(err, "Error: path does not exist");
        let missing =
            |_: &[&str]| -> std::io::Result<CliOutput> { Err(std::io::ErrorKind::NotFound.into()) };
        let err = connect_agent_cli(&CODEX_CLI, MCP, &missing, &|_| true, false).unwrap_err();
        assert!(err.starts_with("Codex CLI not found"), "{err}");
    }

    /// The module header listed four of the six commands; every
    /// `#[tauri::command]` here is now named there.
    #[test]
    fn module_header_names_every_command() {
        let src = include_str!("agent_setup.rs");
        let header: String = src
            .lines()
            .take_while(|l| l.starts_with("//!"))
            .collect::<Vec<_>>()
            .join("\n");
        let lines: Vec<&str> = src.lines().collect();
        let mut commands = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if line.trim() == "#[tauri::command]" {
                let name = lines[i + 1]
                    .trim()
                    .strip_prefix("pub fn ")
                    .and_then(|r| r.split('(').next())
                    .unwrap();
                commands.push(name);
            }
        }
        assert_eq!(commands.len(), 6, "{commands:?}");
        for name in &commands {
            assert!(
                header.contains(&format!("`{name}`")),
                "header omits `{name}`"
            );
        }
        let count = ["", "one", "two", "three", "four", "five", "six", "seven"][commands.len()];
        assert!(
            header.contains(&format!("Exposes {count} Tauri commands")),
            "{header}"
        );
    }

    /// An unreadable or unwritable config file used to be reported with the
    /// OS error alone, and no next step.
    #[test]
    fn unreadable_or_unwritable_config_says_what_to_check() {
        let dir = std::env::temp_dir().join(format!("ashlr-md-config-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_config(&dir.join("missing.json")), Ok(None));

        // A folder where the file should be cannot be read or written.
        let not_a_file = dir.join("mcp.json");
        fs::create_dir_all(&not_a_file).unwrap();
        let err = read_config(&not_a_file).unwrap_err();
        assert!(err.starts_with("Cannot read "), "{err}");
        assert!(
            err.contains("It was not changed.") && err.ends_with("then try again."),
            "{err}"
        );
        let err = write_config(&not_a_file, "{}").unwrap_err();
        assert!(err.starts_with("Cannot write "), "{err}");
        assert!(err.ends_with("then try again."), "{err}");

        let file = dir.join("settings.json");
        write_config(&file, "{}").unwrap();
        assert_eq!(read_config(&file), Ok(Some("{}".to_string())));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unexpected_shapes_are_refused_not_overwritten() {
        for mut root in [
            json!([]),
            json!({ "hooks": [] }),
            json!({ "hooks": { "PostToolUse": {} } }),
        ] {
            let before = root.clone();
            assert!(merge_hook(&mut root, MDOPEN).is_err(), "{before}");
            assert_eq!(root, before);
        }
        let mut null = Value::Null;
        assert_eq!(merge_hook(&mut null, MDOPEN), Ok(HookMerge::Installed));
    }
}
