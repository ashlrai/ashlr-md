# Using Ashlr MD with AI Coding Agents

Ashlr MD ships an **MCP server** (`mdopener-mcp`) that lets AI coding agents
open, read, edit, and export the document that is live in your Ashlr MD window
— without leaving their coding environment.

It also ships **`mdopen`**, a tiny CLI companion for opening any `.md` file
from a terminal or agent script.

---

## Quick start: one-click setup (in-app)

Open **Ashlr MD → Preferences → AI agents (MCP)** and click:

- **Connect to Claude Code** — runs `claude mcp add` for you, no terminal needed.
- **Connect to Cursor** — writes/merges `~/.cursor/mcp.json` automatically.

For Codex (and any other agent), copy the command with the **Copy** button and
paste it in a terminal.

---

## Claude Code

### One-click (recommended)

Open **Preferences → AI agents (MCP)** and click **Connect to Claude Code**.
Ashlr MD runs the following for you:

```bash
claude mcp add --scope user ashlr-md /Applications/Ashlr\ MD.app/Contents/MacOS/mdopener-mcp
```

The `--scope user` flag registers the server globally (all projects), not just
the current directory.

### Manual

```bash
claude mcp add --scope user ashlr-md "/Applications/Ashlr MD.app/Contents/MacOS/mdopener-mcp"
```

After running either, **restart Claude Code** (or run `claude restart`) once.

### Verify

```bash
claude mcp list
# should show: ashlr-md  /Applications/Ashlr MD.app/Contents/MacOS/mdopener-mcp
```

### Using the tools in Claude Code

Once the server is registered, Claude Code can call the tools automatically
when you're working on a Markdown file. You can also prompt it explicitly:

```
Open my plan.md in Ashlr MD and show me its current content.
```

```
Set the content of the currently open document to: # Hello\n\nWorld
```

---

## Cursor

### One-click (recommended)

Open **Preferences → AI agents (MCP)** and click **Connect to Cursor**.
Ashlr MD writes/merges the entry in `~/.cursor/mcp.json` for you.

### Manual

Edit (or create) **`~/.cursor/mcp.json`**:

```json
{
  "mcpServers": {
    "ashlr-md": {
      "command": "/Applications/Ashlr MD.app/Contents/MacOS/mdopener-mcp",
      "args": []
    }
  }
}
```

If the file already has other servers, merge only the `"ashlr-md"` key into the
existing `"mcpServers"` object — don't replace the whole file.

After saving, go to **Cursor Settings → MCP** and click **Reload** (or restart
Cursor).

### Verify

In Cursor's MCP settings panel you should see `ashlr-md` listed as a connected
server with a green status indicator.

---

## Codex (OpenAI Codex CLI)

Codex reads MCP server definitions from **`~/.codex/config.toml`** (global) or
a project-level **`.codex/config.toml`**.

Add the following block:

```toml
# ~/.codex/config.toml

[[mcp_servers]]
name    = "ashlr-md"
command = "/Applications/Ashlr MD.app/Contents/MacOS/mdopener-mcp"
args    = []
```

To generate the exact path for your machine, copy it from **Preferences → AI
agents (MCP) → Copy** in Ashlr MD.

After editing the config, Codex picks up the new server automatically on its
next invocation (no restart needed).

---

## The `mdopen` CLI

`mdopen` opens any Markdown file in Ashlr MD from a terminal, CI script, or
agent tool call.

### Install

In Ashlr MD: **Preferences → Command-line tool → Install mdopen**

Or via the build-from-source installer:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-md/main/scripts/install.sh)
```

### Usage

```bash
mdopen README.md                # open a file (read + edit)
mdopen --edit PLAN.md           # open directly in edit mode
cat notes.md | mdopen -         # pipe stdin → temp file → open in app
mdopen --help
```

### From an agent

Claude Code (and other agents with shell access) can call `mdopen` directly:

```python
# In a Python agent tool
import subprocess
subprocess.run(["mdopen", "/path/to/output.md"], check=True)
```

---

## The `mdopener://` URL scheme

Any app (browser, terminal, script) can open a file in Ashlr MD via the custom
URL scheme:

```
mdopener://open?path=/absolute/path/to/file.md
mdopener://open?path=/path/to/file.md&mode=edit
```

From the terminal:

```bash
open "mdopener://open?path=$(pwd)/README.md"
```

From JavaScript / Electron:

```js
shell.openExternal(`mdopener://open?path=${encodeURIComponent(filePath)}`);
```

---

## MCP tool reference

The `mdopener-mcp` server exposes these tools over stdio JSON-RPC 2.0:

| Tool | Parameters | Description |
|---|---|---|
| `open_file` | `path: string`, `mode?: "read"\|"edit"` | Open a file in the Ashlr MD window. Launches the app if not running. |
| `get_current_content` | — | Return the path and full Markdown source of the currently open document. |
| `set_content` | `content: string`, `save?: boolean` | Replace the content of the currently open document. Pass `save: true` to write to disk immediately. |
| `list_recent` | `limit?: number` | Return a list of recently opened file paths (default limit: 20). |
| `export` | `format: "pdf"\|"docx"\|"html"`, `output_path?: string` | Trigger an export of the current document. If `output_path` is omitted the app prompts for a save location. |

### IPC model

The MCP binary communicates with the running Ashlr MD app over a loopback HTTP
server. The app writes its port to `~/.mdopener/ipc-port` on startup; the MCP
binary reads that file to locate the app. If the app is not running, most tools
return a clear error — `open_file` is the exception and will cold-start the app
via the `mdopener://` URL scheme.

---

## Dev / build-from-source

```bash
# Full install (builds the app, sidecars, and CLI):
bash <(curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-md/main/scripts/install.sh)

# Or from a checkout:
bash scripts/install.sh

# CLI + MCP only (no Tauri app build):
SKIP_APP_BUILD=1 bash scripts/install.sh
```

The install script requires **Rust** (rustup), **Bun**, and Xcode Command Line
Tools on macOS. See the script header for full prerequisites.

In a dev build the MCP binary lives at:

```
src-tauri/target/release/mdopener-mcp
```

Register it with Claude Code:

```bash
claude mcp add --scope user ashlr-md \
  "$(pwd)/src-tauri/target/release/mdopener-mcp"
```

---

## Troubleshooting

**"binary not found" after connecting**
The MCP binary must exist before the agent can launch it. Either:
- Install the full app from a release DMG or `scripts/install.sh`, or
- Run `cargo build --release -p mdopener-mcp` and register the
  `target/release/mdopener-mcp` path manually.

**Claude Code shows "ashlr-md: failed to start"**
Run `claude mcp list` to see the registered path, then verify the binary exists
at that path and is executable (`chmod +x`).

**Cursor MCP panel shows the server as offline**
Restart Cursor. If the issue persists, open `~/.cursor/mcp.json` and confirm
the `command` path points to the binary.

**`mdopen` command not found after installing**
Make sure `/usr/local/bin` (or `~/.local/bin`) is on your `$PATH`:
```bash
echo $PATH          # check
mdopen --help       # verify
```
