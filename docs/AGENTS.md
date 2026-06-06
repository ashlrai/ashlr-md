# Using Ashlr MD with AI Coding Agents

Ashlr MD ships an **MCP server** (`mdopener-mcp`) that lets AI coding agents
open, read, edit, search, export, and **request human review of** the document
that is live in your Ashlr MD window — without leaving their coding environment.

It also ships **`mdopen`**, a tiny CLI companion for opening any `.md` file from
a terminal or agent script, and for wiring up an **auto-open hook** that pops
Markdown into Ashlr MD the moment your agent writes it.

> **Tip:** To watch everything an agent produces, open the **Agent Activity
> drawer** (`⌘B` on macOS, `Ctrl+B` on Windows/Linux) and point it at the folder
> your agent writes to. New Markdown files appear live as they're created — click
> any one to open it instantly. It's the recommended way to keep an eye on an
> agent's `.md` output without polling the filesystem yourself.

---

## What the integration is

There are two cooperating pieces:

1. **`mdopener-mcp`** — a [Model Context Protocol](https://modelcontextprotocol.io/)
   server speaking JSON-RPC 2.0 over stdio. Agents (Claude Code, Codex, Cursor,
   anything MCP-capable) launch it as a child process and call its **tools**,
   read its **resources**, and use its **prompts**. It talks to the running
   Ashlr MD app over a token-authenticated loopback HTTP channel (see
   [Security](#security)).
2. **`mdopen`** — a CLI for opening files (`mdopen file.md`), reading stdin
   (`cat x.md | mdopen -`), and running as a Claude Code **PostToolUse hook**
   (`mdopen --hook`) so freshly written Markdown auto-opens for review.

The MCP server understands the MCP lifecycle (`initialize` →
`notifications/initialized` → `tools/list` / `tools/call`, plus `ping`,
`resources/*`, and `prompts/*`) and negotiates one of three protocol revisions:
**`2024-11-05`** (baseline/default), **`2025-03-26`**, or **`2025-06-18`**. It
echoes the client's requested `protocolVersion` when it's one of these, and
otherwise advertises the baseline.

---

## Quick start: one-click setup (in-app)

Open **Ashlr MD → Preferences → AI agents (MCP)** and click:

- **Connect to Claude Code** — runs `claude mcp add` for you, no terminal needed.
- **Connect to Cursor** — writes/merges `~/.cursor/mcp.json` automatically.
- **Connect to Codex** — runs `codex mcp add` for you.
- **Install auto-open hook** — adds a Claude Code `PostToolUse` hook so written
  `.md` files open in Ashlr MD automatically (see [Auto-open hook](#auto-open-hook)).

The in-app buttons are only enabled for tools detected on your machine
(`claude` / `codex` on `$PATH`, or a `~/.cursor` directory for Cursor). For any
other agent, copy the command with the **Copy** button and paste it in a terminal.

---

## Claude Code

### One-click (recommended)

Open **Preferences → AI agents (MCP)** and click **Connect to Claude Code**.
Ashlr MD runs the following for you (with `<mcp-binary>` resolved to the bundled
`mdopener-mcp` path):

```bash
claude mcp add --scope user ashlr-md <mcp-binary>
```

The `--scope user` flag registers the server globally (all projects), not just
the current directory. The command is idempotent — re-running it when the server
already exists is treated as success.

### Manual

```bash
# macOS
claude mcp add --scope user ashlr-md "/Applications/Ashlr MD.app/Contents/MacOS/mdopener-mcp"

# Windows — verify path; shown here for a typical per-user install
claude mcp add --scope user ashlr-md "%LOCALAPPDATA%\Ashlr MD\mdopener-mcp.exe"

# Linux (.deb install default; AppImage: use the resource dir inside the mount)
claude mcp add --scope user ashlr-md /usr/lib/ashlr-md/mdopener-mcp
```

After running either, **restart Claude Code** (or run `claude restart`) once.

To get the exact command (with the real binary path) for your machine, use the
**Copy** button in **Preferences → AI agents (MCP)** — it produces precisely:

```bash
claude mcp add --scope user ashlr-md <resolved-mdopener-mcp-path>
```

### Verify

```bash
claude mcp list
# macOS:   ashlr-md  /Applications/Ashlr MD.app/Contents/MacOS/mdopener-mcp
# Windows: ashlr-md  C:\Users\<you>\AppData\Local\Ashlr MD\mdopener-mcp.exe
# Linux:   ashlr-md  /usr/lib/ashlr-md/mdopener-mcp
```

### Using the tools in Claude Code

Once the server is registered, Claude Code can call the tools automatically when
you're working on a Markdown file. You can also prompt it explicitly:

```
Open my plan.md in Ashlr MD and show me its current content.
```

```
Edit the open document: change the heading "## Goals" to "## Objectives", then ask me to review it.
```

---

## Codex (OpenAI Codex CLI)

### One-click (recommended)

Open **Preferences → AI agents (MCP)** and click **Connect to Codex**. Ashlr MD
runs the following for you:

```bash
codex mcp add --transport stdio ashlr-md -- <mcp-binary>
```

This writes an `[mcp_servers.ashlr-md]` table to `~/.codex/config.toml`. Codex
consumes MCP **tools** (not resources/prompts) — exactly what `ashlr-md` exposes
for agent control.

### Manual — `codex mcp add`

```bash
# macOS
codex mcp add --transport stdio ashlr-md -- "/Applications/Ashlr MD.app/Contents/MacOS/mdopener-mcp"

# Windows (adjust to your install dir)
codex mcp add --transport stdio ashlr-md -- "C:\Users\<you>\AppData\Local\Ashlr MD\mdopener-mcp.exe"

# Linux (.deb)
codex mcp add --transport stdio ashlr-md -- /usr/lib/ashlr-md/mdopener-mcp
```

### Manual — `config.toml`

If you prefer editing config directly, the `codex mcp add` command above writes
the equivalent of this to **`~/.codex/config.toml`** (global) or a project-level
**`.codex/config.toml`**:

```toml
[mcp_servers.ashlr-md]
# macOS:
command = "/Applications/Ashlr MD.app/Contents/MacOS/mdopener-mcp"
# Windows (adjust to your install dir):
# command = "C:\\Users\\<you>\\AppData\\Local\\Ashlr MD\\mdopener-mcp.exe"
# Linux (.deb):
# command = "/usr/lib/ashlr-md/mdopener-mcp"
args = []
```

Codex picks up the new server on its next invocation (no restart needed).

---

## Cursor

### One-click (recommended)

Open **Preferences → AI agents (MCP)** and click **Connect to Cursor**. Ashlr MD
writes/merges the entry in `~/.cursor/mcp.json` for you, leaving any other
servers untouched.

### Manual

Edit (or create) **`~/.cursor/mcp.json`** (macOS/Linux) or
`%APPDATA%\Cursor\mcp.json` (Windows):

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

On **Windows**, replace `command` with the path to `mdopener-mcp.exe` in your
install directory (e.g. `C:\Users\<you>\AppData\Local\Ashlr MD\mdopener-mcp.exe`).
On **Linux**, use `/usr/lib/ashlr-md/mdopener-mcp` (`.deb`) or the binary inside
the AppImage resource directory — verify the exact path after install.

If the file already has other servers, merge only the `"ashlr-md"` key into the
existing `"mcpServers"` object — don't replace the whole file.

After saving, go to **Cursor Settings → MCP** and click **Reload** (or restart
Cursor). You should then see `ashlr-md` listed with a green status indicator.

---

## MCP tool reference

The `mdopener-mcp` server exposes **eleven** tools over stdio JSON-RPC 2.0.
Every tool returns its payload inside the standard MCP `content` envelope
(`{ "content": [{ "type": "text", "text": "…" }], "isError": false }`); the
"Returns" column below describes the JSON carried inside that text.

| Tool | Parameters | Returns | Notes |
|---|---|---|---|
| `open_file` | `path: string`, `mode?: "read"\|"edit"` | `{ opened, … }` | Opens a file in the Ashlr MD window. **The only tool that launches the app** if it isn't running (falls back to the `mdopener://` URL scheme). `mode` defaults to `read`. |
| `get_current_content` | — | `{ path, content }` | Path + full Markdown source of the open document. |
| `set_content` | `content: string`, `save?: boolean` | `{ ok }` | Replace the open document's content. `save` defaults to `false`. |
| `list_recent` | `limit?: integer` | `[ { path, fileName, openedAt }, … ]` | Recently opened files. `limit` defaults to `10`. |
| `export` | `format: "pdf"\|"docx"\|"html"`, `output_path?: string` | `{ ok }` | Trigger an export of the open document. Omitting `output_path` lets the app prompt for a location. |
| `request_review` | `path?: string`, `content?: string`, `blocking?: boolean`, `timeout_ms?: integer` | `{ verdict, reviewId, comments }` | **BLOCKING human sign-off.** See [Human review loop](#human-review-loop). One of `path` or `content` is required. |
| `get_user_annotations` | `path: string` | `{ path, verdict, comments, tasks }` | The human's latest review verdict + comments for that file, plus GFM task-checkbox states parsed from the live document. Read-only. |
| `edit_document` | `find: string`, `replace: string`, `save?: boolean`, `path?: string` | `{ ok, replaced }` | **Exact, unique find/replace** on the open document. See below. |
| `replace_document` | `content: string`, `save?: boolean` | `{ ok }` | Replace the **entire** content of the open document. Prefer `edit_document` for targeted changes. |
| `search_vault` | `query: string`, `limit?: integer` | `{ query, results }` | Case-insensitive full-text search across the vault (watched folder) + recents. `limit` defaults to `50` (clamped 1–200). Results carry file paths, line numbers, and snippets. |
| `present_document` | `path?: string` | `{ ok, path }` | Open a file (if `path` given) and switch the app into distraction-free, full-screen reading presentation — ideal for showing a finished result. |

### `edit_document` — exact, unique find/replace

`edit_document` replaces an **exact substring** of the currently open document.
The `find` string must occur **exactly once**:

- **0 matches** → the edit is refused: *"`find` string not found in the current document."*
- **2+ matches** → the edit is refused: *"`find` string is not unique (N matches) — include more surrounding context to disambiguate."*
- **empty `find`** → refused.

So include enough surrounding context to make `find` unique. These soft failures
come back as a **tool error** (`isError: true`) with the reason, not an opaque
transport failure, so the agent can retry with more context.

Pass `path` to assert which file is open: if a *different* document is currently
open, the edit is refused rather than silently applied to the wrong file. Pass
`save: true` to persist to disk immediately (default `false` — edits stay in the
live buffer until saved).

### `request_review` — blocking human sign-off

See the dedicated [Human review loop](#human-review-loop) section.

---

## Resources reference

The server implements `resources/list` and `resources/read`.

- **`mdopener://current`** — the document currently open in Ashlr MD
  (`mimeType: text/markdown`). Reading it returns the live content.
- **`file://<path>` (vault files)** — every file the app advertises as part of
  the **vault** (watched folder) plus **recents** is listed as an individually
  readable resource.

`resources/read` is **scoped**: a `file://` URI is only readable if it is one of
the paths the app currently advertises in the vault or recents. Any other path
is rejected (`-32002`), so the resource channel can't be used as an
arbitrary-filesystem read primitive.

---

## Prompts reference

The server implements `prompts/list` and `prompts/get`. Each prompt embeds the
**live document** so the returned message is self-contained:

| Prompt | What it asks the model to do |
|---|---|
| `summarize` | Summarize the current document into a short bulleted list of key points. |
| `review_plan` | Review the current document as an implementation plan; flag risks, missing steps, and anything ambiguous. |
| `improve_writing` | Tighten the prose and fix grammar of the current document without changing its meaning or structure. |

`prompts/get` returns a single `user` message whose text is the instruction
followed by the current document content.

---

## Human review loop

`request_review` is the heart of the agent-with-a-human-in-the-loop workflow. It
lets an agent stop and get **explicit human sign-off** on a plan, diff, or doc
before proceeding.

### Flow

1. **Agent calls `request_review`** with either a file `path` or inline
   `content`. The MCP server registers the review with the app (a unique
   `reviewId` is generated) and, if a `path` was given, opens that file in read
   mode. The app shows its **review panel**.
2. **The call BLOCKS** (when `blocking` is `true`, the default). Under the hood
   the MCP binary polls the app every ~1.5s for a verdict, up to `timeout_ms`.
3. **The human acts in the app** — clicking **Approve**, **Request changes**, or
   **Dismiss** — optionally leaving comments.
4. **The agent receives the verdict** as the tool result:
   `{ "verdict": "approved" | "changes_requested" | "dismissed", "reviewId": "…", "comments": "…" }`.

### Parameters

- `path` *or* `content` — **one is required.** `path` opens that file for review;
  `content` reviews inline Markdown.
- `blocking` (default `true`) — if `false`, the review is registered and the call
  returns immediately with `{ "reviewId": "…", "status": "pending" }`. The agent
  can later check the outcome via `get_user_annotations`.
- `timeout_ms` (default `300000` = 5 min, clamped to **5 000–600 000**) — how long
  to wait for a verdict. On expiry the tool returns `{ "verdict": "timeout", … }`
  rather than hanging forever.

### Reading the result later

`get_user_annotations(path)` returns the **latest** verdict and comments recorded
for a file, plus the current state of its GFM task checkboxes
(`- [ ]` / `- [x]`, including `*`/`+` bullets). Use it after a non-blocking
`request_review`, or to re-check whether the human has ticked off task items.

### Tips for agents

- Use `request_review` for **gates**: "Here's the plan / the diff / the final
  doc — approve before I continue."
- Pair it with `present_document` when you want the human to read a polished
  result full-screen, then call `request_review` for the sign-off.
- On `changes_requested`, read the returned `comments`, apply fixes with
  `edit_document`, and request review again.

---

## Auto-open hook

`mdopen --hook` is a Claude Code **PostToolUse hook**: whenever Claude writes or
edits a Markdown file, the file auto-opens in Ashlr MD for review. The hook is
silent and always succeeds, so it never disrupts Claude's tool flow — it reads
the PostToolUse JSON from stdin, extracts the written file path, and opens it in
read mode via the `mdopener://` scheme.

### One-click install

**Preferences → AI agents (MCP) → Install auto-open hook**. Ashlr MD merges this
into **`~/.claude/settings.json`** (idempotently — it won't add a duplicate):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "<mdopen> --hook",
            "if": "Write(*.md)|Edit(*.md)"
          }
        ]
      }
    ]
  }
}
```

The `matcher` fires on the `Edit` and `Write` tools; the `if` guard narrows it to
`*.md` files. After installing, **restart Claude Code** to pick it up.

> If `~/.claude/settings.json` already has a non-object `hooks` value or a
> non-array `hooks.PostToolUse`, the installer **bails with an error** rather than
> clobbering your settings — fix the shape manually and retry.

---

## The `mdopen` CLI

`mdopen` opens any Markdown file in Ashlr MD from a terminal, CI script, or agent
tool call.

### Install

In Ashlr MD: **Preferences → Command-line tool → Install mdopen** (all platforms).

Or via the build-from-source installer (macOS/Linux):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-md/main/scripts/install.sh)
```

On **Windows**, the installer places `mdopen.exe` alongside the app. The in-app
prompt handles adding it to your `PATH` via the system environment variable dialog.

### Usage

```bash
mdopen README.md                # open a file (read mode, default)
mdopen --edit PLAN.md           # open directly in edit mode (-e also works)
mdopen --read NOTES.md          # force read mode (-r also works)
cat notes.md | mdopen -         # pipe stdin → temp file → open in app
mdopen --hook                   # Claude Code PostToolUse hook mode (reads JSON on stdin)
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
# macOS
open "mdopener://open?path=$(pwd)/README.md"

# Windows (PowerShell)
Start-Process "mdopener://open?path=$PWD\README.md"

# Linux
xdg-open "mdopener://open?path=$(pwd)/README.md"
```

From JavaScript / Electron:

```js
shell.openExternal(`mdopener://open?path=${encodeURIComponent(filePath)}`);
```

---

## How it works: the IPC model

The MCP binary communicates with the running Ashlr MD app over a **loopback HTTP
server** bound to `127.0.0.1` on an OS-assigned port. On startup the app writes
its port to `~/.mdopener/ipc-port` and a per-session token to
`~/.mdopener/ipc-token`; the MCP binary reads both to locate and authenticate to
the app, and the app removes them on clean exit.

If the app is not running, most tools return a clear error — `open_file` is the
exception and will cold-start the app via the `mdopener://` URL scheme. The
frontend keeps the app's document, recents, and vault state mirrored to the IPC
layer (via `mcp_sync_state` / `mcp_sync_vault`) so reads are always fresh without
re-walking the disk.

---

## Security

The integration is **local-only and token-authenticated**:

- The IPC server binds to **`127.0.0.1`** (loopback) on an ephemeral port —
  nothing is exposed beyond your machine.
- On startup the app generates a **32-byte CSPRNG token** (64 hex chars) and
  writes it to `~/.mdopener/ipc-token`. On Unix the file is created **owner-only
  (`0600`)** in a single syscall so the token is never momentarily world-readable.
- **Every endpoint except `/health`** (a data-free liveness probe) requires
  `Authorization: Bearer <token>`. The token is compared in **constant time** to
  avoid leaking a timing signal, and a mismatch returns `401`.
- The MCP `resources/read` channel is **scoped to advertised vault/recents
  files** — it cannot be used to read arbitrary paths off disk.
- The token and port files are **removed on clean app exit**, so a stale process
  can't authenticate against a new session.

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

The install script requires **Rust** (rustup) and **Bun**.
On macOS, also Xcode Command Line Tools; on Windows, MSVC build tools; on Linux,
`build-essential` and the [Tauri Linux dependencies](https://tauri.app/start/prerequisites/#linux).
See the script header for full prerequisites.

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

**Tools return "Ashlr MD does not appear to be running"**
The app must be open for everything except `open_file`. Launch Ashlr MD (or call
`open_file`, which cold-starts it), then retry.

**"IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token"**
The app is starting up or wrote a stale/empty token. Make sure Ashlr MD has
finished launching; if it persists, fully quit and relaunch the app so it
regenerates `~/.mdopener/ipc-port` and `~/.mdopener/ipc-token`.

**Claude Code shows "ashlr-md: failed to start"**
Run `claude mcp list` to see the registered path, then verify the binary exists
at that path and is executable (`chmod +x`).

**Cursor MCP panel shows the server as offline**
Restart Cursor. If the issue persists, open `~/.cursor/mcp.json` and confirm the
`command` path points to the binary.

**Auto-open hook didn't install**
If `~/.claude/settings.json` has a malformed `hooks` / `hooks.PostToolUse` shape,
the installer bails rather than overwrite it — fix the JSON manually and retry.

**`mdopen` command not found after installing**
On macOS/Linux, make sure `/usr/local/bin` (or `~/.local/bin`) is on your `$PATH`:
```bash
echo $PATH          # check
mdopen --help       # verify
```
On Windows, confirm `mdopen.exe`'s directory is in your user or system `PATH`
(the in-app installer handles this; restart your terminal after installing).
