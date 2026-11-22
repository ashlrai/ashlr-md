# Copy-paste examples

Every command is meant to be pasted as written. Run the blocks below from the repository root, in bash, unless a heading says otherwise.

The install script is for macOS and Linux. It needs Rust, Bun, git, and curl. `SKIP_APP_BUILD=1` builds `mdopen` and `mdopener-mcp` and skips the desktop app.

## Install from a checkout

```bash
SKIP_APP_BUILD=1 bash scripts/install.sh
```

The script links `mdopen` and `mdopener-mcp` into `/usr/local/bin`, or into `~/.local/bin` when that directory is not writable. If the second directory is not on `PATH` yet:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Install without a checkout

```bash
SKIP_APP_BUILD=1 bash <(curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-md/main/scripts/install.sh)
```

Run this way, the script is not inside a checkout, so it clones into `~/ashlr-md` (set `CLONE_DIR` to change that), or fast-forwards that clone when it is already there. Your current directory does not matter. When `claude` is on `PATH`, the script registers the MCP server for you.

## JSON commands

These exit without waiting for MCP input. `doctor` and `setup --local` do not download a model and do not write config.

```bash
mdopener-mcp --version --json
mdopener-mcp doctor --json
mdopener-mcp doctor --fix --json
mdopener-mcp setup --local --json
mdopener-mcp --ashlr-handshake --json
mdopener-mcp --export-tool-schema
```

What you get back:

| Command | Output |
|---|---|
| `doctor --json` | one JSON object, `"kind": "ashlr.doctor"` |
| `doctor --fix --json` | one JSON object, `"kind": "ashlr.doctor"`, with `mode`, `plan`, and `outcome`. This is a dry run and writes nothing |
| `doctor --fix --apply --json` | the same shape, and it makes the repairs |
| `setup --local --json` | one JSON object, `"kind": "ashlr.setup-local"`, `downloads` false, `writes` false |
| `--ashlr-handshake --json` | one JSON object, `"kind": "ashlr.handshake"` |
| `--export-tool-schema` | tool names and input schemas as JSON, sorted by name |
| `--version --json`, `--help --json`, `--export-tool-schema --json` | one JSON object, `"kind"` of `"ashlr.version"`, `"ashlr.help"`, or `"ashlr.tool-schema"`, with `schema_version: 1` and `tool: "ashlr-md"` |

To resume a pending review, pass the returned `reviewId` as the `review_id` input to `request_review`; see [the review loop](./AGENTS.md#human-review-loop).

`doctor` and `setup --local` exit 0 whatever they find, so read the JSON, not the exit code. Their fields: [local-ai.md](./local-ai.md#json-output). `mdopener-mcp doctor --apply` without `--fix` is refused and exits 2. Repair rules and the full `doctor --fix --json` shape: [doctor-fix.md](./doctor-fix.md). Handshake fields: [ashlr-handshake.md](./ashlr-handshake.md).

## Open a file

```bash
mdopen samples/agent-plan.md
mdopen --edit samples/agent-plan.md
echo '# Hello' | mdopen -
mdopen --version
mdopen --help
```

`mdopen -` reads Markdown from stdin (up to 16 MiB) and opens it from a temp file. Empty or whitespace-only stdin and input over that limit exit 1 without opening anything. Files must exist and have a `.md`, `.markdown`, `.mdown`, `.mkd` or `.mdx` extension, with no leading dot in the filename; this is checked after resolving symlinks.

`mdopen` exits 0 when the running app accepts the file, or when the OS launcher accepts the `mdopener://` URL to start the installed app. If the launcher is still running after 10 seconds, it also exits 0, but stderr says the open is not confirmed. Exit 0 alone does not prove that a window appeared.

It exits 1 on bad usage, an invalid file, or a failed or missing launcher. If the running app refuses the file, returns a server error, breaks the connection or does not answer within 6 seconds, it exits 1 without trying the URL scheme; the app may still open the file after a timeout. Read stderr for the reason and next step. The desktop app has to be installed for the window to appear. The CLI and MCP server from `SKIP_APP_BUILD=1` are enough for the JSON commands above.

## Claude Code

The install script runs this when `claude` is already on `PATH`. Run it yourself to register again:

```bash
claude mcp add --scope user ashlr-md "$(command -v mdopener-mcp)"
```

Restart Claude Code, then:

```bash
claude mcp list
```

To have every Markdown file Claude writes or edits open in Ashlr MD, use Preferences, AI agents (MCP), Auto-open agent Markdown. It adds an `mdopen --hook` entry to `~/.claude/settings.json`. The JSON it writes and the rules for what opens: [the auto-open hook](./AGENTS.md#auto-open-hook).

## Codex

```bash
codex mcp add ashlr-md -- "$(command -v mdopener-mcp)"
```

Codex reads the new server on its next run.

## Cursor

```bash
python3 scripts/connect-cursor.py
```

The script merges an `ashlr-md` entry into `~/.cursor/mcp.json`. It uses the `mdopener-mcp` that is on `PATH`. It writes nothing when the file is not JSON, when `mcpServers` is not an object, or when `ashlr-md` already points at a different program that still exists. Reload MCP in Cursor Settings after it prints the file path.

## Windows, after the release installer

The bash install script is not the Windows path. After the NSIS installer, in PowerShell:

```powershell
claude mcp add --scope user ashlr-md "$env:LOCALAPPDATA\Ashlr MD\mdopener-mcp.exe"
codex mcp add ashlr-md -- "$env:LOCALAPPDATA\Ashlr MD\mdopener-mcp.exe"
```

`mdopen.exe` is next to the app and is not on `PATH` until you use Preferences, Command-line tool, Install mdopen. Full steps: [INSTALL.md](./INSTALL.md).

## Tool arguments an agent sends

These are the arguments, not shell commands. `open_file` is the tool that starts the app. Call it before tools that need a live window.

`open_file`:

```json
{"path": "samples/agent-plan.md", "mode": "read"}
```

`edit_document` (the `find` text must occur once):

```json
{"find": "## Phase 1: Core", "replace": "## Phase 1: Foundation", "path": "samples/agent-plan.md", "save": false}
```

`request_review`:

```json
{"path": "samples/agent-plan.md", "blocking": true}
```

With `output_path`, `export` writes the file without a dialog and needs Read view, so call `open_file` with `"mode": "read"` first. Without `output_path` it opens the app's export dialog. PDF always uses the system print dialog and takes no `output_path`. An existing file is replaced only with `"overwrite": true`.

```json
{"format": "html", "output_path": "/tmp/agent-plan.html", "overwrite": false}
```

The full tool list, in server order, with every limit, is [AGENTS.md](./AGENTS.md). `mdopener-mcp --export-tool-schema` prints the same tools and input schemas as JSON, sorted by name rather than in server order.

## Prompts you can paste to an agent

```text
Open samples/agent-plan.md in Ashlr MD with open_file, then show get_current_content.
```

```text
Call edit_document on the open document. find must match once. Then request_review and wait for my verdict.
```
