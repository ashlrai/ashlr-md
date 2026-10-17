//! Agent setup — one-click MCP registration for Claude Code, Cursor, and Codex.
//!
//! Exposes four Tauri commands:
//!
//!   `detect_agent_clis`   — probe which AI coding tools are installed
//!   `connect_claude_code` — run `claude mcp add ashlr-md <path>` automatically
//!   `connect_cursor`      — write/merge an entry in `~/.cursor/mcp.json`
//!   `mcp_command_string`  — return the exact shell command for copy/manual use
//!
//! All commands are synchronous (no async needed — process spawns are fast) and
//! return `Result<_, String>` to surface friendly errors in the UI.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Manager;

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
pub(crate) fn resolve_sidecar_binary(app: &tauri::AppHandle, bin: &str) -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Cannot determine app executable path: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or("App executable has no parent directory")?;
    let resource_dir = app.path().resource_dir().ok();
    sidecar_path::resolve(bin, exe_dir, resource_dir.as_deref())
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

// ── Claude Code ───────────────────────────────────────────────────────────────

/// Register Ashlr MD as an MCP server in Claude Code (user scope).
///
/// Runs: `claude mcp add --scope user ashlr-md <mcp-binary-path>`
///
/// The `--scope user` flag registers it in the user scope (`~/.claude.json`) so
/// the server is available across all projects, not just the current directory.
/// The command is idempotent in recent Claude Code versions — re-running it
/// when the server is already registered is safe (it may print a warning that
/// we capture and surface as a success message).
#[tauri::command]
pub fn connect_claude_code(app: tauri::AppHandle) -> Result<String, String> {
    let mcp_path = resolve_mcp_binary_path(&app)?;

    let output = Command::new(agent_cli_program("claude"))
        .args(["mcp", "add", "--scope", "user", "ashlr-md", &mcp_path])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Claude Code CLI not found. Install it from https://claude.ai/download \
                 then try again."
                    .to_string()
            } else {
                format!("Failed to run claude CLI: {e}")
            }
        })?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = if stdout.trim().is_empty() {
            "Ashlr MD registered as an MCP server in Claude Code.\n\
                 Start a new Claude Code session to pick it up."
                .to_string()
        } else {
            format!(
                "{}\nRestart Claude Code to pick up the new server.",
                stdout.trim()
            )
        };
        Ok(msg)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = [stdout.trim(), stderr.trim()]
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");

        // Treat "already exists" variants as success.
        let detail_lc = detail.to_lowercase();
        if detail_lc.contains("already") || detail_lc.contains("exists") {
            return Ok("ashlr-md is already registered in Claude Code. \
                 Restart Claude Code if you haven't already."
                .to_string());
        }

        Err(if detail.is_empty() {
            format!(
                "claude mcp add exited with code {}.",
                output.status.code().unwrap_or(-1)
            )
        } else {
            detail
        })
    }
}

// ── Cursor ────────────────────────────────────────────────────────────────────

/// Cursor's global MCP configuration file.
///
/// As of Cursor 0.43+ (early 2025) the authoritative location is
/// `~/.cursor/mcp.json`. A project-level override at `.cursor/mcp.json` is
/// also supported by Cursor, but we write to the global file so the server is
/// available in every project.
fn cursor_mcp_json_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".cursor").join("mcp.json"))
        .ok_or_else(|| "Cannot determine home directory".to_string())
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

    // Read existing config or start fresh.
    let mut root: Value = if config_path.exists() {
        let raw = fs::read_to_string(&config_path)
            .map_err(|e| format!("Cannot read {}: {e}", config_path.display()))?;
        serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };

    // Ensure the "mcpServers" key exists and is an object.
    if !root.get("mcpServers").map(|v| v.is_object()).unwrap_or(false) {
        root["mcpServers"] = json!({});
    }

    // Merge our entry (overwrites any previous ashlr-md entry).
    root["mcpServers"]["ashlr-md"] = json!({
        "command": mcp_path,
        "args": []
    });

    // Write back with pretty-printing (Cursor displays this file in its UI).
    let serialised = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("JSON serialisation error: {e}"))?;

    fs::write(&config_path, serialised)
        .map_err(|e| format!("Cannot write {}: {e}", config_path.display()))?;

    Ok(format!(
        "ashlr-md added to {}.\n\
         Restart Cursor (or reload the MCP servers in Settings → MCP) to pick it up.",
        config_path.display()
    ))
}

// ── Codex ─────────────────────────────────────────────────────────────────────

/// Register Ashlr MD as an MCP server in OpenAI Codex (global config).
///
/// Runs: `codex mcp add ashlr-md -- <mcp-binary-path>`, which
/// writes an `[mcp_servers.ashlr-md]` table to `~/.codex/config.toml`. Codex
/// consumes MCP *tools* (not resources/prompts) — exactly what ashlr-md exposes
/// for agent control.
#[tauri::command]
pub fn connect_codex(app: tauri::AppHandle) -> Result<String, String> {
    let mcp_path = resolve_mcp_binary_path(&app)?;

    let output = Command::new(agent_cli_program("codex"))
        .args(["mcp", "add", "ashlr-md", "--", &mcp_path])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Codex CLI not found. Install it (e.g. `npm i -g @openai/codex`) then try again."
                    .to_string()
            } else {
                format!("Failed to run codex CLI: {e}")
            }
        })?;

    if output.status.success() {
        Ok("Ashlr MD registered as an MCP server in Codex.\nRestart Codex to pick it up."
            .to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = [stdout.trim(), stderr.trim()]
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        let lc = detail.to_lowercase();
        if lc.contains("already") || lc.contains("exists") {
            return Ok("ashlr-md is already registered in Codex.".to_string());
        }
        Err(if detail.is_empty() {
            format!(
                "codex mcp add exited with code {}.",
                output.status.code().unwrap_or(-1)
            )
        } else {
            detail
        })
    }
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
/// Idempotent: re-running won't add a duplicate hook, and an entry an earlier
/// version wrote unquoted for the same path is repaired in place.
#[tauri::command]
pub fn install_claude_hook(app: tauri::AppHandle) -> Result<String, String> {
    let mdopen = resolve_sidecar_binary(&app, "mdopen")?;

    let settings_path = dirs::home_dir()
        .map(|h| h.join(".claude").join("settings.json"))
        .ok_or("Cannot determine home directory")?;
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }

    let mut root: Value = if settings_path.exists() {
        let raw = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Cannot read {}: {e}", settings_path.display()))?;
        serde_json::from_str(&raw).map_err(|e| {
            format!("{} is not valid JSON ({e}). Fix it and retry.", settings_path.display())
        })?
    } else {
        json!({})
    };

    let outcome = merge_hook(&mut root, &mdopen)
        .map_err(|shape| format!("{} {shape}", settings_path.display()))?;
    if outcome == HookMerge::AlreadyInstalled {
        return Ok("Auto-open hook is already installed in Claude Code.".to_string());
    }

    let serialised = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("JSON serialisation error: {e}"))?;
    fs::write(&settings_path, serialised)
        .map_err(|e| format!("Cannot write {}: {e}", settings_path.display()))?;

    Ok(match outcome {
        HookMerge::Repaired => format!(
            "Auto-open hook repaired in {}: its mdopen path is now quoted, so the \
             space in \"Ashlr MD\" no longer breaks it. Restart Claude Code to pick it up.",
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
    AlreadyInstalled,
}

/// Merge the auto-open hook for `mdopen` into a parsed `settings.json`.
///
/// Unexpected `hooks` / `hooks.PostToolUse` shapes are an error (the message
/// is appended to the settings path) rather than silently overwritten.
fn merge_hook(root: &mut Value, mdopen: &str) -> Result<HookMerge, &'static str> {
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
