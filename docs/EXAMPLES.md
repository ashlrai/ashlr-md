# Copy-paste examples

Every command is meant to be pasted as written. Run the blocks below from the repository root, in bash, unless a heading says otherwise.

The install script is for macOS and Linux. It needs Rust, Bun, and git. `SKIP_APP_BUILD=1` builds `mdopen` and `mdopener-mcp` and skips the desktop app.

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

That clones into `~/ashlr-md` when you are not already in a checkout. When `claude` is on `PATH`, the script registers the MCP server for you.

## JSON commands

These exit without waiting for MCP input. `doctor` and `setup --local` do not download a model and do not write config.

```bash
mdopener-mcp --version
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
| `doctor --fix --json` | one JSON object with `mode`, `plan`, and `outcome`. This is a dry run and writes nothing |
| `doctor --fix --apply --json` | the same shape, and it makes the repairs |
| `setup --local --json` | one JSON object, `"kind": "ashlr.setup-local"`, `downloads` false, `writes` false |
| `--ashlr-handshake --json` | one JSON object, `"kind": "ashlr.handshake"` |
| `--export-tool-schema` | tool names and input schemas as JSON |

To resume a pending review, pass the returned `reviewId` as the `review_id` input to `request_review`; see [the review loop](./AGENTS.md#human-review-loop).

`mdopener-mcp doctor --apply` without `--fix` is refused and exits 2. Repair rules: [doctor-fix.md](./doctor-fix.md). Handshake fields: [ashlr-handshake.md](./ashlr-handshake.md).

## Open a file

```bash
mdopen samples/agent-plan.md
mdopen --edit samples/agent-plan.md
mdopen --version
mdopen --help
```

`mdopen` exits 0 when a viewer accepted the file. The desktop app has to be installed for the window to appear. The CLI and MCP server from `SKIP_APP_BUILD=1` are enough for the JSON commands above.

## Claude Code

The install script runs this when `claude` is already on `PATH`. Run it yourself to register again:

```bash
claude mcp add --scope user ashlr-md "$(command -v mdopener-mcp)"
```

Restart Claude Code, then:

```bash
claude mcp list
```

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

`export` needs Read view. `open_file` with `"mode": "read"` first. PDF uses the system dialog and takes no `output_path`.

```json
{"format": "html", "output_path": "/tmp/agent-plan.html", "overwrite": false}
```

The full tool list, in server order, with every limit, is [AGENTS.md](./AGENTS.md). `mdopener-mcp --export-tool-schema` prints the same list as JSON.

## Prompts you can paste to an agent

```text
Open samples/agent-plan.md in Ashlr MD with open_file, then show get_current_content.
```

```text
Call edit_document on the open document. find must match once. Then request_review and wait for my verdict.
```
