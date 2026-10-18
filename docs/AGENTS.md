# Using Ashlr MD with AI Coding Agents

Ashlr MD ships an **MCP server** (`mdopener-mcp`) that lets AI coding agents
open, read, edit, search, export, and **request human review of** the document
that is live in your Ashlr MD window, without leaving their coding environment.

It also ships **`mdopen`**, a tiny CLI companion for opening any `.md` file from
a terminal or agent script, and for wiring up an **auto-open hook** that pops
Markdown into Ashlr MD the moment your agent writes it.

> **Tip:** To watch everything an agent produces, open the **Agent Activity
> drawer** (`⌘B` on macOS, `Ctrl+B` on Windows/Linux) and point it at the folder
> your agent writes to. New Markdown files appear live as they're created; click
> any one to open it instantly. It's the recommended way to keep an eye on an
> agent's `.md` output without polling the filesystem yourself.

---

## What the integration is

There are two cooperating pieces:

1. **`mdopener-mcp`**: a [Model Context Protocol](https://modelcontextprotocol.io/)
   server speaking JSON-RPC 2.0 over stdio. Agents (Claude Code, Codex, Cursor,
   anything MCP-capable) launch it as a child process and call its **tools**,
   read its **resources**, and use its **prompts**. It talks to the running
   Ashlr MD app over a token-authenticated loopback HTTP channel (see
   [Security](#security)).
2. **`mdopen`**: a CLI for opening files (`mdopen file.md`), reading stdin
   (`cat x.md | mdopen -`), and running as a Claude Code **PostToolUse hook**
   (`mdopen --hook`) so freshly written Markdown auto-opens for review.

The MCP server understands the MCP lifecycle (`initialize` →
`notifications/initialized` → `tools/list` / `tools/call`, plus `ping`,
`resources/*`, and `prompts/*`) and negotiates one of three protocol revisions:
**`2024-11-05`**, **`2025-03-26`**, or **`2025-06-18`** (default). It echoes the
client's requested `protocolVersion` when it's one of these, and otherwise
advertises the latest, `2025-06-18`. A JSON-RPC batch (an array of messages,
which `2025-03-26` clients may send) gets one array reply; a message without
an `id` is a notification and gets no reply. A `notifications/*` method
sent *with* an `id` is answered `-32600`, so the client is not left waiting.
A message whose `jsonrpc` is not `"2.0"`, whose `params` is not an object, or
whose `id` is not a string or an integer (MCP never allows `null`) is answered
`-32600` Invalid Request.

The `initialize` result carries `instructions`, which clients may give the
model: the tools to start with (`open_file`, `present_document`,
`request_review`, `get_current_content`, `edit_document`), that only
`open_file` starts the app, what to do when Ashlr MD is not installed (ask the
user to install it from the releases page), and the tools that work on files
on disk without the app.

---

## Quick start: one-click setup (in-app)

Open **Ashlr MD → Preferences → AI agents (MCP)** and click:

- **Connect to Claude Code**: runs `claude mcp add` for you, no terminal needed.
- **Connect to Cursor**: writes/merges `~/.cursor/mcp.json` automatically.
- **Connect to Codex**: runs `codex mcp add` for you.
- **Install auto-open hook**: adds a Claude Code `PostToolUse` hook so written
  `.md` files open in Ashlr MD automatically (see [Auto-open hook](#auto-open-hook)).

The in-app buttons are only enabled for tools detected on your machine
(`claude` / `codex` on `$PATH`, or a `~/.cursor` directory for Cursor). For any
other agent, copy the command with the **Copy** button and paste it in a terminal.

When Claude Code or Codex already has an `ashlr-md` server, the Connect button
asks it (`mcp get`) which program it runs. A registration for a program that no
longer exists (the app was moved or reinstalled) is removed and added again for
this app; one that runs another program that still exists is kept, and the
message names it and the command that removes it.

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
the current directory. The command is idempotent: re-running it when the server
already exists is treated as success.

### Manual

```bash
# macOS
claude mcp add --scope user ashlr-md "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp"

# Windows (PowerShell): verify path; shown here for a typical per-user install
claude mcp add --scope user ashlr-md "$env:LOCALAPPDATA\Ashlr MD\mdopener-mcp.exe"

# Linux (.deb install default; AppImage: use the resource dir inside the mount)
claude mcp add --scope user ashlr-md "/usr/lib/Ashlr MD/mdopener-mcp"
```

After running it, **restart Claude Code** (quit and start a new session) once.

To get the exact command (with the real binary path) for your machine, use the
**Copy** button in **Preferences → AI agents (MCP)**; it produces precisely:

```bash
claude mcp add --scope user ashlr-md <resolved-mdopener-mcp-path>
```

### Verify

```bash
claude mcp list
# macOS:   ashlr-md  /Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp
# Windows: ashlr-md  C:\Users\<you>\AppData\Local\Ashlr MD\mdopener-mcp.exe
# Linux:   ashlr-md  "/usr/lib/Ashlr MD/mdopener-mcp"
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
codex mcp add ashlr-md -- <mcp-binary>
```

This writes an `[mcp_servers.ashlr-md]` table to `~/.codex/config.toml`. Codex
consumes MCP **tools** (not resources/prompts), exactly what `ashlr-md` exposes
for agent control.

### Manual: `codex mcp add`

```bash
# macOS
codex mcp add ashlr-md -- "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp"

# Windows (adjust to your install dir)
codex mcp add ashlr-md -- "C:\Users\<you>\AppData\Local\Ashlr MD\mdopener-mcp.exe"

# Linux (.deb)
codex mcp add ashlr-md -- "/usr/lib/Ashlr MD/mdopener-mcp"
```

### Manual: `config.toml`

If you prefer editing config directly, the `codex mcp add` command above writes
the equivalent of this to **`~/.codex/config.toml`** (global) or a project-level
**`.codex/config.toml`**:

```toml
[mcp_servers.ashlr-md]
# macOS:
command = "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp"
# Windows (adjust to your install dir):
# command = "C:\\Users\\<you>\\AppData\\Local\\Ashlr MD\\mdopener-mcp.exe"
# Linux (.deb):
# command = "/usr/lib/Ashlr MD/mdopener-mcp"
args = []
```

Codex picks up the new server on its next invocation (no restart needed).

---

## Cursor

### One-click (recommended)

Open **Preferences → AI agents (MCP)** and click **Connect to Cursor**. Ashlr MD
writes/merges the entry in `~/.cursor/mcp.json` for you, leaving any other
servers untouched. A file it cannot merge (not valid JSON, for example with a
comment or a trailing comma, or whose `mcpServers` is not an object) is left
as it is and the button says why; fix it, or add the entry by hand as below.

### Manual

Edit (or create) **`~/.cursor/mcp.json`** (macOS/Linux) or
`%USERPROFILE%\.cursor\mcp.json` (Windows), the file **Connect to Cursor** writes:

```json
{
  "mcpServers": {
    "ashlr-md": {
      "command": "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp",
      "args": []
    }
  }
}
```

On **Windows**, replace `command` with the path to `mdopener-mcp.exe` in your
install directory (e.g. `C:\Users\<you>\AppData\Local\Ashlr MD\mdopener-mcp.exe`).
On **Linux**, use `"/usr/lib/Ashlr MD/mdopener-mcp"` (`.deb`) or the binary inside
the AppImage resource directory; verify the exact path after install.

If the file already has other servers, merge only the `"ashlr-md"` key into the
existing `"mcpServers"` object; don't replace the whole file.

After saving, go to **Cursor Settings → MCP** and click **Reload** (or restart
Cursor). You should then see `ashlr-md` listed with a green status indicator.

---

## MCP tool reference

The `mdopener-mcp` server exposes **20** tools over stdio JSON-RPC 2.0.
Every tool returns its payload inside the standard MCP `content` envelope
(`{ "content": [{ "type": "text", "text": "…" }], "isError": false }`); the
"Returns" column below describes the JSON carried inside that text.

| Tool | Parameters | Returns | Notes |
|---|---|---|---|
| `open_file` | `path: string`, `mode?: "read"\|"edit"` | `{ opened, response }` or `{ opened, method: "url-scheme", confirmed?, note? }` | Opens a file in the Ashlr MD window. `response` is the running app's reply; `method: "url-scheme"` means the app was not reachable and the `mdopener://` URL was handed to the OS launcher, with `confirmed: false` and a `note` when the launcher had not finished within 10 s. **The only tool that launches the app** if it isn't running (falls back to the `mdopener://` URL scheme). Without `mode` the window keeps its current view (a file already open in a tab keeps its own, and an app this call launches starts in `read`); pass `read` before an `export`, which needs Read view. Only Markdown documents that are not dotfiles can be opened (see [Security](#security)); another file is refused with "Refusing to open `path` '<absolute path>': only Markdown documents (…) that are not dotfiles can be opened." (`present_document` and `request_review` say "present" and "review"). A file that does not exist is refused (by the running app, or before launching it). A running app answers once its window has opened the file, so a file the window could not open (for example, one it cannot read) is a tool error with the reason. A running app that answers with a server error or not in time is a tool error too, never retried through the URL scheme (which could open the file twice). |
| `get_current_content` | none | `{ path, content }` | Path + full Markdown source of the open document. `path` is `null` for an unsaved document. With no document open the result is `isError: true` ("No document is open in Ashlr MD. Open one first (open_file)."), as `mdopener://current` (`-32002`) reports it. `export_text` and `export_metadata` without `path` are `isError: true` too, but say to pass `path` instead ("No document is open in Ashlr MD; pass `path` to read a file."). The app reports an unsaved document that is still empty the same way, so the error never hides content. |
| `set_content` | `content: string`, `save?: boolean` | `{ ok: true }` | Replace the **entire** content of the open document, the same operation as `replace_document`, and like it listed with `destructiveHint: true`. `save` defaults to `false`. The call returns `{ ok: true }` once the window has applied the content (and saved it, with `save: true`). With no document open it returns `isError: true` ("No document is open in Ashlr MD; open one first (open_file).") and nothing is applied. A save that fails, or a document with no file yet, returns `isError: true` saying the content was replaced but not saved (the buffer keeps the new content), and a window that does not answer within 4 s returns `isError: true` with the reason. Like `edit_document`, at most two edits wait on the app at once; another returns a "busy, retry" error. |
| `list_recent` | `limit?: integer` | `[ { path, fileName, openedAt }, … ]` | Recently opened files, most recent first (`openedAt` is milliseconds since the Unix epoch). `limit` defaults to `10`; a value that is not a whole number from 1 to 200 is refused (`-32602`). |
| `export` | `format: "pdf"\|"docx"\|"html"\|"epub"`, `output_path?: string` | `{ ok, format, path, bytes }` or `{ ok, format, dialog: true }` | Export the open document (`isError` when none is open). With `output_path` (html, docx or epub, with that extension, in an existing directory) the app writes the file without a dialog and the call returns once the window reports it written and it is on disk. An export that fails in the window (for example, the document is not in Read view) returns `isError` at once with the window's reason; one the window has not finished within 30 s returns `isError` saying so. The app writes one headless export at a time, in a slot of its own, so a slow export never makes edits, opens, presents or reviews wait; a second headless export sent while one is being written returns `isError` at once saying so (retry once the first finishes). The document must be in Read view. Without `output_path` the app opens its export dialog. pdf goes through the system print dialog and takes no `output_path`. Exports use the app's current theme; a `theme` argument is refused (`-32602`). |
| `request_review` | `path?: string`, `content?: string`, `blocking?: boolean`, `timeout_ms?: integer`, `wait_ms?: integer`, `review_id?: string` | `{ verdict, reviewId, comments }` or `{ status: "pending", reviewId }` | **BLOCKING human sign-off.** See [Human review loop](#human-review-loop). One of `path`, `content` or `review_id` is required; an empty or whitespace-only `content` is refused with `-32602` (it used to register a review of no text). `verdict` is `approved`, `changes_requested`, `dismissed`, `timeout` or `superseded` (a newer review replaced it in the panel). Needs the app running: it does not start it, so call `open_file` first when the app is closed. |
| `get_user_annotations` | `path: string` | `{ path, verdict, comments, late, tasks, tasksNote? }` | The human's latest review verdict + comments for that file (`verdict` and `comments` are `null` when no review of it was requested), plus its GFM task-checkbox states: from the live buffer when it is the open document, else from the Markdown file on disk (none for other files). A file on disk larger than 16 MiB (or not UTF-8 text) is not read: `tasks` is empty and `tasksNote` says why. Read-only. |
| `edit_document` | `find: string`, `replace: string`, `save?: boolean`, `path?: string` | `{ ok: true, replaced: 1 }` | **Exact, unique find/replace** on the open document. See below. A `find` that is not found or not unique, or a `path` that is not the open document, returns `isError: true` with the reason and leaves the document unchanged; so does a window that does not answer within 4 s, and, as for `set_content`, at most two edits wait on the app at once. With `save: true`, a save that fails (or a document with no file yet) returns `isError: true` saying the edit was applied but not saved; `stream_edit_apply` does the same. |
| `replace_document` | `content: string`, `save?: boolean` | `{ ok: true }` | Replace the **entire** content of the open document, the same operation as `set_content`. Prefer `edit_document` for targeted changes. Refuses with no document open and reports a failed apply or save as `set_content` does. |
| `search_vault` | `query: string`, `limit?: integer`, `semantic?: boolean`, `vault?: string` | `{ results, mode, query?, note?, vault?, truncated?, depthCut? }` | Search across the vault (watched folder) + recents. `query` comes with mode `grep` only: the query as the app's own search read it. The app lists the watched folder's 200 most recently changed Markdown files (the app sends that cap with its vault list, and the `note` quotes the app's number); when the folder has more, the result has `truncated: true` and a `note` saying only those were searched (the Activity drawer says so too). The app keeps the newest files of the whole folder while it walks it, but reads at most 50,000 directory entries and enters folders at most 8 levels down; past the entry budget the walk stops, and below that depth a folder is skipped. Either way the list is the newest of the files it reached, and `truncated: true` comes with a `note` saying newer files elsewhere in the folder may have been missed. When the depth limit is what cut the walk, the result also has `depthCut: true` and the `note` says the folder is too deeply nested (with only the entry budget, there is no `depthCut` and the `note` says the folder is too large); the app's `/vault` reply carries the same `scanCut` (either limit) and `depthCut` (the depth limit) flags. An older app that sends no `depthCut` gets the note naming both limits. Semantic (Ollama `nomic-embed-text` embeddings) when Ollama is reachable on `127.0.0.1:11434`, otherwise case-insensitive grep; `semantic` forces one or the other. `mode` is `semantic`, `grep` (the app's own search), or `grep-local` (the app's search failed, so the vault files were grepped on disk). When semantic search was tried but unavailable (for example `semantic: true` with Ollama down), or the app's search refused or failed, `note` says so in words and quotes the reason. When only some documents fail to embed, the semantic results leave them out and `note` says how many; if the app refused and the on-disk grep cannot run either, the refusal is the error. `limit` defaults to `50` and is a whole number from 1 to 200 in every mode; a value outside that range is refused with `-32602`, by the tool and by `text://vault-search?…&limit=`, as for `list_recent` (a value above 200 used to be read as 200). Needs the app (it supplies the vault file list). When the app cannot be reached (no `~/.mdopener/ipc-port`, or nothing listening; not when it refuses), `vault` names a directory (absolute, or relative to the server's working directory) whose Markdown files are searched on disk instead: `mode` is `grep-disk` (or `semantic`), `vault` is the directory searched, and `note` says the app was unreachable and the disk was searched. The walk reads only Markdown files that are not dotfiles, skips hidden folders, `node_modules` and `target`, does not follow directory symlinks, and stops at 5000 files (the `note` says so). It enters folders at most 16 levels below `vault`; a deeper folder is not searched, and the result then has `truncated: true`, `depthCut: true` and a `note` saying so (deeper folders used to be skipped in silence). Without `vault`, an unreachable app is `isError: true`, and the message names `vault`. A `vault` that is not a directory, or is itself a hidden folder (`.git`, `.obsidian`), is `isError: true`. |
| `present_document` | `path?: string` | `{ ok, path }` | Open a file (if `path` given) and switch the app into distraction-free, full-screen reading presentation, ideal for showing a finished result. Without `path` it presents the open document, and is an error when none is open. A `path` that does not exist is refused before the app is asked, so the error says so even when the app is not running. It answers once the window has opened and presented the document, and a failure there is a tool error with the reason. Needs the app running: it does not start it, so call `open_file` first when the app is closed. |
| `list_ai_actions` | `include_prompts?: boolean` | `{ actions, count }` | The editor's AI transform actions (explain, summarize, rewrite, …) with id, label, shortLabel, icon, scope, and (by default) their prompt templates (`systemPrompt`, `userPromptTemplate`); `include_prompts: false` leaves the templates out. Templates read the text as `{text}`; `translate` and `explain-diff` also take `{arg}`, and carry an `argument` field saying what it is (the target language, or the on-disk version). No app needed. |
| `get_conversation_context` | `session_id: string`, `limit?: integer` | `{ sessionId, messages, count, recentDocs }` | Each message is `{ id, sessionId, role, content, citedDocs, timestampMs }` (`timestampMs` in milliseconds since the Unix epoch). The last N messages (default `20`, a whole number from `1` to `200`; a value outside that range is refused with `-32602`, as for `list_recent`, where one above `200` used to be clamped) of a session's memory store, oldest first. `recentDocs` lists the paths those messages cite, most recently cited first and each once (it used to be in random order). An empty or blank path that an earlier build stored is left out of `recentDocs` and of each message's own `citedDocs`. A path an earlier build stored twice in one message is listed once in that message's `citedDocs`. Empty when the session has none. A session file larger than 16 MiB is not read: the result is `isError: true` saying how large it is (it used to be read whole, and an unreadable file answered as an empty session). A `session_id` too long for its file name is refused with `-32602` (see `save_conversation_message`). |
| `save_conversation_message` | `session_id: string`, `role: "agent"\|"human"\|"system"`, `content: string`, `cited_docs?: string[]` | `{ ok, messageId, sessionId, role, timestampMs, dropped?, note? }` | Append to a session's memory store, persisted at `~/.mdopener/sessions/<session_id>.json`. ASCII letters, digits, `-` and `_` are kept in the file name and every other byte is written as `%XX`, so distinct ids never share a file (`a.b` is `a%2Eb.json`, `a_b` is `a_b.json`). That file name (without `.json`) may be at most 200 bytes, so an id of up to 200 letters, digits, `-` and `_` always fits (other bytes count three each); a longer id is refused with `-32602` instead of failing when the file is written. The sessions directory is owner-only (`0700`, tightened if an earlier build left it open) and each session file is `0600`, on Unix. Where a case-insensitive file system still folds two ids together, reads skip the other id's messages and appends are refused. History saved by earlier builds under the old name (every other character replaced by `_`) is still read, keeping only that id's messages, and the next append moves it to the new file. The Ashlr MD window persists its side of a session into the same file, in the same format (each message's `citedDocs` once per path, in the order first given, as this tool stores them), and both hold `~/.mdopener/sessions/.lock` while they update a file, so neither overwrites the other's messages. A file that cannot be parsed, or is larger than 16 MiB, is left as it is and the append is refused. A session file is kept within 16 MiB: when a message would take it past that, the oldest messages are dropped and the result says how many (`dropped`, with a `note`). A message that cannot be written to disk is not saved and returns `isError: true`. An empty or blank (whitespace-only) path in `cited_docs` is refused with `-32602` (it used to be stored and come back in `recentDocs`). Each `cited_docs` path is stored absolute: a relative one is resolved against the server's working directory when saved (it used to be stored as given), and an absolute one is kept as given. A path given twice (or a relative path and its absolute form) is stored once, in the order first given (it used to be stored and returned twice). |
| `diff_documents` | `path_a: string`, `path_b: string`, `context_lines?: integer` | `{ diff, hunks, added, removed, path_a, path_b }` | Unified diff of two Markdown files on disk (non-Markdown files and dotfiles are refused). `hunks` counts the change hunks and `added` / `removed` the lines added and removed; `path_a` / `path_b` are the absolute paths read, and identical files give an empty `diff` and three zero counts. `context_lines` defaults to `3` and is a whole number from `0` to `10000`; a larger value is refused with `-32602` (it used to be read as `10000`). Lines are compared with their line endings, so files that differ only in CRLF vs LF or in the final newline are not reported as identical: a `\r` stays visible in the diff, and a last line without a newline is followed by `\ No newline at end of file`, as in `diff -u`. |
| `edit_canvas` | `path: string`, `ops: object[]`, `save?: boolean` | `{ ok, path, nodes_count, edges_count, node_ids, edge_ids, removed_edge_ids, ops_applied, saved, content }` | Apply typed edit ops (move/resize/edit/colour/add/delete nodes and edges, reorder edges) to a `.canvas` file, all or nothing. `ops` must hold at least one op: an empty list is refused with `-32602` (`` `ops` must not be empty ``) before the file is read, so it is never written (the schema declares `minItems: 1`). `node_ids` / `edge_ids` are the ids left afterwards (for follow-up ops), `removed_edge_ids` the edges `delete_node` removed with their node, and `content` the new canvas JSON (a string) when `save` is `false`, which writes nothing, and `null` when the file was written. `save` defaults to `true`. Top-level keys other than `nodes` and `edges`, and unknown keys on nodes and edges, are written back unchanged; a canvas whose `nodes` or `edges` is not an array of objects is refused with `isError: true` and left untouched. Op fields are checked like arguments, before the file is read: a field of the wrong type, a field no op takes, an op without `type`, or a field shorter than its declared `minLength` (an op's empty `id` or `ids` element) is refused with `-32602` naming the op and field (`` `ops[1].x` must be a number ``, `` `ops[0].id` must be at least 1 character long ``). So is a field that another op takes but this op does not use (`width` on a `move_node`, which used to be ignored while the call reported success): the error names the ops that use it, and a move and a resize are two ops. An empty or whitespace-only id (an op's `id`, an element of `reorder_edges`' `ids`, `add_node`'s `node.id`, or `add_edge`'s `edge.id`, `edge.fromNode` or `edge.toNode`) is refused with `-32602` before the file is read (`` op[0] move_node: `id` must not be empty ``; it used to come back as "node `` not found"). `move_node` and `resize_node` write a whole-number `x`, `y`, `width` or `height` as a JSON integer, as JSON Canvas expects (`5` or `5.0` is written `5`; it used to be written `5.0`), and a fractional one as given. `add_node` refuses (`-32602`) a node the app would not show: it needs a non-empty string `id`, a `type` of `text`, `file`, `link` or `group`, numbers `x`, `y`, `width` and `height` (size positive), a string `file` for a file node and `url` for a link node. `add_edge` likewise refuses (`-32602`) an edge whose `fromSide`/`toSide` is not `top`, `right`, `bottom` or `left`, whose `fromEnd`/`toEnd` is not `none` or `arrow`, or whose `label` is not a string (these used to be written as given). A colour (`set_node_color`'s `color`, `add_node`'s `node.color`, `add_edge`'s `edge.color`) must be what JSON Canvas allows, a preset `"1"`..`"6"` or a hex `#rgb` / `#rrggbb`; anything else (`"red"`, `"7"`) is refused with `-32602`. |
| `stream_edit` | `find: string`, `replace: string`, `preview?: boolean`, `preview_lines?: integer`, `path?: string` | `{ ok, editId, diff, candidates, matchCount, applied }` | Preview a find/replace on the open document as a unified diff (every candidate when `find` matches more than once). `diff` is the diff of the first (or only) match, `candidates` is `null` for a single match and otherwise `[{ matchIndex, startLine, diff, rank }]` in document order (rank 1 first), and `matchCount` counts the occurrences. A `find` that is not found (or, with `preview: false`, not unique) or a `path` that is not the open document returns `isError: true` with the reason, and the document is unchanged; so does a window that does not answer within 4 s. `preview` defaults to `true`; `false` applies immediately (unsaved, `find` must match once) and the result has `applied: true`, so do not call `stream_edit_apply` after it (a preview has `applied: false`). `preview_lines` defaults to `5` and is a whole number from `0` to `20`; a larger value is refused with `-32602` (it used to be read as `20`). A `path` must name the open document (compared after resolving symlinks, as `edit_document` does). Like `edit_document`, at most two edits wait on the app at once; another returns a "busy, retry" error. |
| `stream_edit_apply` | `edit_id?: string`, `find: string`, `replace: string`, `match_index?: integer`, `save?: boolean`, `path?: string` | `{ ok: true, replaced: 1, matchIndex }` | Apply a previewed `stream_edit`, choosing the occurrence with `match_index` (0-based, default `0`); `matchIndex` in the result is the occurrence applied. A `find` no longer in the live document, a `match_index` past its last occurrence ("matchIndex 3 out of bounds: document has 2 occurrence(s)."), or a `path` that is not the open document returns `isError: true` with the reason and leaves the document unchanged, as `edit_document` does, as do a window that does not answer within 4 s and a third edit while two wait on the app. `match_index` is a whole number from `0` to `4294967295`, the app's 32-bit limit, which the schema declares as its `maximum`; a larger value is refused with `-32602` (`` `match_index` must be at most 4294967295, got … ``; it used to be refused only as "too large", with no bound in the schema). The app re-finds `find` in the live document; `edit_id` is for correlation only, and an empty or whitespace-only one is refused with `-32602` (it used to be accepted). |
| `export_text` | `path?: string` | `{ text, word_count, char_count, path? }` | Plain text of a Markdown file with the syntax stripped (code blocks kept): `~~struck~~` text keeps its words, table rows become tab-separated cells, also in a blockquote or list item (the `|---|` row is dropped, `\|` reads `|`; as in GFM and the app's own rendering, an unescaped `|` inside `` `code` `` still splits a cell), and footnotes read `[1]` at the reference and `[1] text` at the definition. `char_count` is the text's length in Unicode characters, not bytes. Reads `path` (Markdown only, no dotfiles) from disk, or the open document via the app when omitted (an error when nothing is open). |
| `export_metadata` | `path?: string` | `{ frontmatter, headings, wikilinks, embedded_image_count, word_count, path? }` | Structural metadata of a Markdown file: `headings` is `[{ level, text }]` for every ATX heading, `wikilinks` the distinct `[[link]]` targets sorted, and `path` the absolute path read (absent for an unsaved open document, as in `export_text`). Reads `path` (Markdown only, no dotfiles) from disk, or the open document via the app when omitted (an error when nothing is open). `frontmatter` is `null` when a leading `---` is never closed by `---` or `...` (that line is a thematic break, and `export_text` keeps the text after it). The supported YAML subset is described under [Front matter in `export_metadata`](#front-matter-in-export_metadata). A leading UTF-8 byte order mark (as Notepad saves) is ignored by both `export_text` and `export_metadata`, so it does not hide the front-matter. |

When a tool fails while running (the app is not running, a file cannot be read
or written, the app rejects the operation), the call still succeeds at the
JSON-RPC level and returns `isError: true` with the reason as text, as the MCP
spec asks, so the agent sees the message and can act on it. JSON-RPC errors
are reserved for protocol problems: an unknown tool or invalid arguments
(`-32602`).

Arguments are checked against the tool's `inputSchema` before it runs. An
argument the schema does not declare (a typo such as `pth`), a value of the
wrong JSON type (`"limit": "5"`, `"include_prompts": "no"`, a number inside
`cited_docs`) or `arguments` that is not an object is refused with `-32602`
naming the argument; an undeclared one also lists the arguments the tool
takes and the closest match. Every integer argument declares a `minimum` in
its schema (`0`, or `1` for the `limit` of `search_vault`, `list_recent` and
`get_conversation_context`, and for `request_review` the `5000` of
`timeout_ms` and the `1000` of `wait_ms`), and a value
below it (`"limit": -5`, `"match_index": -1`) is refused the same way instead
of falling back to the default. An integer above its declared `maximum`
(the `limit` of `search_vault`, `list_recent` and `get_conversation_context` declares `200`, `diff_documents`' `context_lines` `10000`, `stream_edit`'s `preview_lines` `20`, `stream_edit_apply`'s `match_index` `4294967295`, and `request_review`'s
`timeout_ms` and `wait_ms` `600000`) is refused the same way. A string outside the property's `enum`
(`"mode": "view"`, `"role": "bot"`, an `edit_canvas` op `type` of
`"move"`) is refused the same way, and the message lists the allowed values
(`` `mode` must be one of `read`, `edit`, got a string ("view") ``). A string
shorter than the property's `minLength` is refused the same way. Every
required string a tool cannot use when empty declares `1`: `search_vault`'s
`query`, `edit_document`'s and `stream_edit`'s and `stream_edit_apply`'s
`find`, `get_user_annotations`'s and `edit_canvas`'s `path`, and the
`session_id` of both conversation tools and `save_conversation_message`'s
`content`. So does every path a tool reads or opens (`open_file`'s,
`present_document`'s, `export_text`'s, `export_metadata`'s and
`request_review`'s `path`, `diff_documents`' `path_a` and `path_b`),
`request_review`'s inline `content` and `search_vault`'s `vault`, and
the optional `path` of `edit_document`, `stream_edit` and
`stream_edit_apply`, `stream_edit_apply`'s `edit_id` and `export`'s
`output_path` (omitting them is still allowed): an empty one, or one of only
whitespace, is refused with `-32602`
(`` `path` must not be empty ``), where it used to reach the file checks and
come back as "only Markdown documents can be read", "No such file or
directory", "not the open document" or "cannot make an empty path
absolute". `search_vault` also refuses a `query` that is
only whitespace with `-32602`, before it asks the app (it used to report that
the app was not running). So a string such as `"1"`, a negative or a
fractional `match_index` is refused rather than read as `0`, and `"save":
"true"` rather than read as `false`. A whole number written as a float
(`2.0`) is an integer, as in JSON Schema. `null` counts as not given. A
`required` argument that is missing (or `null`) is refused the same way
(`` `ops` is required ``) before the tool reads anything, and `request_review`
without any of `path`, `content` or `review_id` is refused naming all three.
A test drives every tool's advertised schema through this check, so the
schema's `required` list, property types and `enum` values are what is enforced. An unknown tool
name gets the closest tool name, if any, and a pointer to `tools/list`. A
blank `session_id` is refused like a missing one. `prompts/get` with an
unknown or missing `name` and `resources/read` with an unknown or missing
`uri` answer `-32602` the same way: the closest prompt or URI, if any, and
the prompt names or a pointer to `resources/list`.

### `edit_document`: exact, unique find/replace

`edit_document` replaces an **exact substring** of the currently open document.
The `find` string must occur **exactly once**:

- **0 matches** → the edit is refused: *"`find` string not found in the current document."*
- **2+ matches** → the edit is refused: *"`find` string is not unique (N matches): include more surrounding context to disambiguate."*
- **empty `find`** → refused by the MCP server itself with `-32602` (*"`find` must not be empty"*), whether or not the app is running.

So include enough surrounding context to make `find` unique. These soft failures
come back as a **tool error** (`isError: true`) with the reason, not an opaque
transport failure, so the agent can retry with more context.

Pass `path` to assert which file is open: if a *different* document is currently
open, the edit is refused rather than silently applied to the wrong file. Pass
`save: true` to persist to disk immediately (default `false`: edits stay in the
live buffer until saved).

### `request_review`: blocking human sign-off

See the dedicated [Human review loop](#human-review-loop) section.

### Front matter in `export_metadata`

`frontmatter` reads a small subset of YAML, not full YAML:

- **Scalars**: `true` / `false` become booleans, integers and decimals become
  numbers, `~`, `null` and an empty value (`key:` with nothing after it and
  nothing under it) become `null`, and anything else is a string with
  surrounding `"` or `'` removed (`key: ""` is the empty string).
- **Lists**: a flow list (`tags: [a, "b, c"]`) or `- item` lines under an
  empty `key:` become arrays. An item written as `- name: x` starts an object,
  and the lines aligned with `name` add keys to it, so
  `- name: Ann` / `  role: lead` is `{"name": "Ann", "role": "lead"}`. An item
  in quotes, or whose colons are not followed by a space (`- http://x`), stays
  a string.
- **Nesting**: indented `name: value` lines under an empty `owner:` become an
  object (`{"owner": {"name": "value"}}`), at any depth. Their values are read
  the same way, so `links: [a, b]` or `- item` lines under `roles:` are
  arrays, and an empty one is `null`.
- **Block scalars**: `key: |` keeps the indented lines under it as written,
  and `key: >` folds them: a line break between two lines becomes a space, a
  blank line becomes a line break, and lines indented further keep their
  breaks. Both end with one line break; `|-` / `>-` drop it and `|+` / `>+`
  keep every trailing blank line. An explicit indentation digit (`|2`) is
  honoured. Lines inside a block scalar are text, so `# ...` there is kept.
- A key's colon must be followed by a space or end the line, so `time: 10:30`
  is the string `"10:30"`.
- **Not parsed**: anchors and aliases (`&a`, `*a`), tags (`!!str`), flow
  mappings (`{a: 1}` stays a string), and multi-line plain or quoted scalars
  (their continuation lines are skipped). Comment lines (`# ...`) outside
  block scalars are skipped.

---

## Resources reference

The server implements `resources/list`, `resources/templates/list` and
`resources/read`. `resources/templates/list` offers one template,
`text://vault-search?q={query}` (`mimeType: application/json`), the search
below; it needs no app.

- **`mdopener://current`**: the document currently open in Ashlr MD
  (`mimeType: text/markdown`). Reading it returns the live content; an open
  document that is empty is `""`. With no document open it is `-32002`
  ("No document is open"), as for the prompts, and `-32000` when the app is
  not running.
- **`text://vault-search?q=<query>`**: the same search as `search_vault`, as a
  resource (`mimeType: application/json`; optional `&limit=`, `&vault=` and
  `&semantic=false` or `true` to force grep or semantic search, like
  `search_vault`'s `semantic`; any other value, a `limit` that is not a
  whole number from 1 to 200, a parameter with no value, or any other
  parameter (a misspelt `lmit=5`) is `-32602`, naming the closest one; so
  is a parameter given twice (`q=a&q=b` used to search for `b` alone) and a
  malformed escape (`q=%ZZ` used to search for the literal `%ZZ`; write a
  literal `%` as `%25`, a `+` as `%2B`)).
  Returns `{ results, mode, query, note?, vault?, truncated?, depthCut? }`,
  with the same `note`, `truncated` and `depthCut` as `search_vault` when it
  fell back or did not search every file; an error when the app is not
  running and no `vault` is given.
- **`mdopener://recent-documents`**: recently opened files that still exist,
  each with `path`, `title`, `mtimeMs`, and a 200-character `preview`
  (`mimeType: application/json`), as `{ documents, count, skipped }`.
  Recents that cannot be listed are left out and counted in `skipped` by
  reason: `missing` (no longer on disk), `notDocument` (a dotfile, not
  Markdown, or not a regular file), `tooLarge` (past 16 MiB) and
  `unreadable` (any other read failure, such as text that is not UTF-8).
  An app with no recents gives an empty list;
  an app that cannot be reached is `-32000`, as for `mdopener://current` (it
  used to be an empty list too).
- **`file://<path>` (vault files)**: every file the app lists in the
  **vault** (watched folder) is listed as an individually readable resource.
  Recently opened files are not listed as `file://` entries (read
  `mdopener://recent-documents` for them), but a recent's `file://<path>` is
  still readable through `resources/read`. When the app cannot be asked for them (it is not
  running, or it refused), the list has none, and the result carries
  `_meta: { "mdopener/vaultFilesUnlisted": "<reason>" }` (also logged on
  stderr) so a client can tell that from a vault with no files; a listing
  that worked has no such key. When the app's vault list is cut short (the
  watched folder has more Markdown files than the app lists, or is too large
  or too deeply nested to scan in full, as `search_vault`'s `truncated`
  says), the result carries `_meta: { "mdopener/vaultFilesTruncated":
  "<reason>" }`, naming the app's cap, so the `file://` entries are not
  read as the whole vault.

`resources/read` is **scoped**: a `file://` URI is only readable if it is one of
the paths the app currently advertises in the vault or recents. Any other path
is rejected (`-32002`, saying to open it with `open_file` first), so the resource channel can't be used as an
arbitrary-filesystem read primitive. When the app cannot be reached it lists
no path, and the read is `-32000` saying the app is not running, as for
`mdopener://current` (it used to be `-32002` "not in vault"). Percent-encoded URIs
(`file:///notes/My%20Notes.md`) and `file://localhost/...` are accepted; the
check runs on the decoded path, so encoding cannot reach a file outside the
vault. A malformed escape (`%ZZ`, a lone `%`; write a literal `%` as `%25`) or
escapes that do not decode to UTF-8 (`%FF`) are refused with `-32602` naming
the problem, unless the URI is an advertised path exactly as written. An advertised path is then read only if it is a Markdown document that
is not a dotfile, checked after resolving symlinks (like the tools that read a
path from disk), so a vault `notes.md` that links to `~/.ssh/id_rsa` or `.env`
is refused (`-32002`). `mdopener://recent-documents` skips such a recent
instead of previewing its target.

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
followed by the current document content. With no document open it is
`-32002` ("No document is open"), and `-32000` when the app is not running,
the same errors `mdopener://current` gives. No prompt takes arguments:
`arguments` may be left out, `null` or `{}`, and any argument given (such
as a `path`, which used to be dropped while the prompt ran on the open
document) is refused with `-32602`; open the document you mean with
`open_file` first. Each prompt's `prompts/list` description says so too.

---

## Human review loop

`request_review` is the heart of the agent-with-a-human-in-the-loop workflow. It
lets an agent stop and get **explicit human sign-off** on a plan, diff, or doc
before proceeding.

### Flow

1. **Agent calls `request_review`** with either a file `path` or inline
   `content`. The MCP server registers the review with the app (a unique
   `reviewId` is generated) and, if a `path` was given, opens that file in read
   mode. The app shows its **review panel**. If the app cannot open the file,
   no review is registered and the call returns `isError: true` with the
   app's reason.
2. **The call BLOCKS** (when `blocking` is `true`, the default). Under the hood
   the MCP binary polls the app every ~1.5s for a verdict, for at most
   `wait_ms` (default 50 s, below the 60 s request timeout of common MCP
   clients). If the human has not decided by then it returns
   `{ "status": "pending", "reviewId": "…" }`; call `request_review` again with
   `review_id` to keep waiting on the same review.
3. **The human acts in the app**, clicking **Approve**, **Request changes**, or
   **Dismiss**, optionally leaving comments.
4. **The agent receives the verdict** as the tool result:
   `{ "verdict": "approved" | "changes_requested" | "dismissed", "reviewId": "…", "comments": "…" }`.
   `dismissed` means the human closed the panel. If the panel's countdown runs
   out with no decision, the verdict is `timeout`. A `timeout` never replaces
   a verdict already given. If the human still decides after the window has
   closed (an agent may already have been told `timeout`), that verdict is
   recorded with `"late": true` and a `message` saying so, in the
   `request_review` result of a resumed call and in `get_user_annotations`.
5. **One review at a time.** The panel shows a single review. When another
   `request_review` (from this agent or another) reaches the panel before the
   human has decided, the review it replaces ends at once with
   `{ "verdict": "superseded", "reviewId": "…", "supersededBy": "…", "message": "…" }`
   (also when resumed with `review_id`, and in `get_user_annotations`), rather
   than waiting out its window and reporting `timeout`. Call `request_review`
   again if it still needs sign-off. Reviews are not queued: a queued review's
   window would run out while it is hidden, and the human sees the newest
   request, which is usually the one that matters. A verdict the human was
   already submitting as the panel switched is still recorded, marked `late`.

### Parameters

- `path` *or* `content`: **one is required.** `path` opens that file for review;
  `content` reviews inline Markdown, which the review panel shows as text
  (it used to show only "inline content", so the human never saw what they
  were approving).
- `blocking` (default `true`): if `false`, the review is registered and the call
  returns immediately with `{ "reviewId": "…", "status": "pending", "message": "…" }`.
  Call `request_review` with that `review_id` to wait for the verdict. A
  resumed call with `blocking: false` does not wait: it reads the review once
  and returns its verdict, `{ "status": "pending", … }`, or `timeout` once its
  window has closed, ignoring `wait_ms`. A
  review of a `path` can also be read later via `get_user_annotations`; one
  of inline `content` has no path, so only `review_id` finds it.
- `timeout_ms` (default `300000` = 5 min, must be **5 000 to 600 000**): how long
  the human has to decide (the review panel's window). A value outside that
  range (or not a whole number) is refused with an invalid-params error naming
  the range, and no review is registered; the app's `/review` refuses the same
  values with a 400. When the window closes
  during a call (the first one, or one resumed with `review_id`) with no
  decision, the tool returns `{ "verdict": "timeout", … }`, so resuming a
  review never waits past its window.
- `wait_ms` (default `50000`, must be **1 000 to 600 000**): the most one call
  blocks. Raise it only if your client allows longer tool calls. A value
  outside that range (or not a whole number) is refused with an
  invalid-params error naming the range, and no review is registered; it
  used to be clamped in silence. To return without waiting, pass
  `blocking: false`.
- `review_id`: resume waiting on a review an earlier call returned as pending
  (no new review is registered). An empty or blank `review_id` is refused with
  `-32602`; it used to be read as absent, so the call registered a new review
  that replaced the pending one. A resumed call cannot change the review, so
  `path`, `content` and `timeout_ms` may be resent unchanged (or left out), and
  one that differs from what the review was requested with is refused with an
  invalid-params error naming it, and nothing is waited on. Refusing, rather
  than going ahead and noting it, is deliberate: an agent that changed its
  `content` and kept the old `review_id` would otherwise read the human's
  verdict on the old text as a verdict on the new one. The server remembers
  the last 256 reviews it registered; for a review it did not register (it was
  restarted, or another server registered it) nothing can be compared, so the
  call goes ahead and the result lists those arguments as `ignored`, with a
  `note`. Once its `timeout_ms` window has closed with
  no verdict, the call returns `{ "verdict": "timeout", … }`.
  The app keeps a review for 30 minutes after its `timeout_ms` window closes,
  so resume within that time; later the call returns `verdict: "timeout"`
  (the record is gone). The newest review of each file is kept longer, for
  `get_user_annotations`, and the app holds at most 256 reviews, dropping the
  oldest decided ones first.

### Reading the result later

`get_user_annotations(path)` returns the **latest** verdict and comments recorded
for a file (with `late: true` when that verdict came after its review window
closed), plus the current state of its GFM task checkboxes
(`- [ ]` / `- [x]`, including `*`/`+` bullets). Use it after a non-blocking
`request_review`, or to re-check whether the human has ticked off task items.

### Tips for agents

- Use `request_review` for **gates**: "Here's the plan / the diff / the final
  doc. Approve before I continue."
- Pair it with `present_document` when you want the human to read a polished
  result full-screen, then call `request_review` for the sign-off.
- On `changes_requested`, read the returned `comments`, apply fixes with
  `edit_document`, and request review again.

---

## Auto-open hook

`mdopen --hook` is a Claude Code **PostToolUse hook**: whenever Claude writes or
edits a Markdown file, the file auto-opens in Ashlr MD for review. The hook is
silent and exits `0`, so it never disrupts Claude's tool flow: it reads
the PostToolUse JSON from stdin, extracts the written file path, and opens it in
read mode: through the running app's loopback IPC channel, or via the
`mdopener://` scheme when the app is not running. It reads at most 64 MiB of
stdin; a longer payload opens nothing (still silently, exit `0`). It acts only
on a `PostToolUse` payload from `Write`, `Edit` or `MultiEdit`: a payload whose
`hook_event_name` is another event (a hook wired as `PreToolUse` would open the
file before the tool changed it) or whose `tool_name` is another tool (`Read`
carries a `file_path` too) opens nothing, so a broad hand-written matcher does
not open every Markdown file the agent reads. A payload whose `tool_response`
reports the tool failed (`success: false`, `is_error: true`, a non-empty
`error`, or a `<tool_use_error>` string) opens nothing either, since a failed
`Edit` leaves the file unchanged. A payload without those fields is judged by
its `tool_input.file_path` alone. The hook command takes no arguments besides
`--hook`: `mdopen --hook notes.md` is a usage error (exit `1`, naming the
extra argument on stderr, which Claude Code reports without blocking the
tool call), since the payload arrives on stdin.

### One-click install

**Preferences → AI agents (MCP) → Install auto-open hook**. Ashlr MD merges this
into **`~/.claude/settings.json`** (idempotently: it won't add a duplicate).
If the hook it installed earlier runs an `mdopen` that no longer exists (the app
was moved, for example from Downloads to Applications), clicking it again points
the hook at this copy of the app; a hook running another `mdopen` that exists is
left alone:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "'<mdopen>' --hook",
            "if": "Write(*.md)|Edit(*.md)"
          }
        ]
      }
    ]
  }
}
```

The `matcher` fires on the `Edit` and `Write` tools; the `if` guard narrows it to
`*.md` files. The `mdopen` path is single-quoted so the space in "Ashlr MD" does
not split it; re-running the installer repairs an unquoted entry that earlier
versions wrote for the same path. After installing, **restart Claude Code** to
pick it up. The quoting targets the POSIX shell Claude Code runs hooks with; it
has not been verified on an installed Windows build.

> If `~/.claude/settings.json` already has a non-object `hooks` value or a
> non-array `hooks.PostToolUse`, the installer **bails with an error** rather than
> clobbering your settings; fix the shape manually and retry.

---

## The `mdopen` CLI

`mdopen` opens any Markdown file in Ashlr MD from a terminal, CI script, or agent
tool call.
When the app is running, `mdopen` hands it the file over the token-authenticated
loopback IPC channel, so it works even where the `mdopener://` scheme is not
registered (an AppImage or dev build on Linux). Otherwise it opens the
`mdopener://` URL, which launches the app. It exits `1` when neither works;
for `mdopen -` the temp file holding stdin is then removed. The message names
the file, what the running-app route and the `mdopener://` route each hit,
and ends with the next step (start Ashlr MD, then run `mdopen` again). It also
exits `1`, before contacting the app, for a file that is not a Markdown document
(`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`) or is a dotfile, checked after
symlinks are resolved; and when the running app refuses the file, it exits `1`
with the app's reason on stderr without trying the URL scheme. It also exits
`1` without trying the URL scheme when the running app was reached but
failed: it answered with a server error, the connection broke, or it did not
answer within 6 s. The app may still open the file then, so for `mdopen -`
the temp file is kept. `mdopen -` also
exits `1`, opening nothing, when stdin is empty or only whitespace, or longer
than the 16 MiB a document may be (it stops reading there and writes no temp
file). Run with a
terminal on stdin (nothing piped), it prints how to finish typing (Ctrl+D) to
stderr. Run with no arguments at all, it prints its help to stderr and exits
`1`; `mdopen --help` prints it to stdout and exits `0`. An empty or blank
path (`mdopen "$FILE"` with an empty variable) is a usage error saying the
path is empty, and a directory is refused as a directory (exit `1` for
both). An argument that is
not valid UTF-8 is a usage error (exit `1`, naming it on stderr): Ashlr MD
takes paths as UTF-8 text, and such an argument used to crash `mdopen` with
exit `101`, `--hook` included.

### Install

In Ashlr MD: **Preferences → Command-line tool → Install mdopen** (all platforms).

Or via the build-from-source installer (macOS/Linux):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-md/main/scripts/install.sh)
```

On **Windows**, the app installer places `mdopen.exe` alongside the app, and
**Install mdopen** copies it to `%USERPROFILE%\.local\bin\mdopen.exe`. Neither
folder is on `PATH` by default, so add one of them to your user `PATH` yourself.

### Usage

```bash
mdopen README.md                # open a file (read mode, default)
mdopen --edit PLAN.md           # open directly in edit mode (-e also works)
mdopen --read NOTES.md          # force read mode (-r also works; with --edit it is a usage error)
cat notes.md | mdopen -         # pipe stdin → temp file → open in app
mdopen -- -draft.md             # `--` ends flags, for file names starting with `-`
mdopen -- -                     # after `--`, `-` is a file named `-`, not stdin
mdopen --hook                   # Claude Code PostToolUse hook mode (reads JSON on stdin)
mdopen --help                   # print usage; wins over every other flag, --hook included
mdopen --version               # print the version (-V also works)
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

Since any web page or program can launch these links, a link opens only an
existing Markdown document that is not a dotfile (checked after resolving
symlinks, as for `open_file`); anything else is ignored. The `path` is
percent-decoded once. `mode` is `read` or `edit` and switches the document
to that view once it is open, also when the link starts the app (so does
`mdopen --edit` with the app closed); a link with any other `mode` is
ignored, as `open_file` refuses one. `mode` used to be dropped, so the file
opened in whatever view it was. Other parameters are ignored, by open and
export links alike, and of a parameter given twice the first counts.

`mdopener://export?path=<path>&format=pdf|docx|html|epub` opens the file and,
once it has loaded (also when the link starts the app), the export dialog
with that format selected (`format` defaults to `pdf`). The export request
used to be sent with the open, so a link that started the app only opened
the file. An export link always switches the file to Read view, which
exporting needs: `mode` may be left out or be `read`, and a link with
`mode=edit` (or any value an open link refuses) is ignored. It used to
ignore `mode` and export from whatever view the file was in, which fails in
Edit view. A link with any other `format` (`PDF`, `md`) is ignored, as the
`export` tool refuses one; it used to open the dialog with no format
selected.

---

## How it works: the IPC model

The MCP binary communicates with the running Ashlr MD app over a **loopback HTTP
server** bound to `127.0.0.1` on an OS-assigned port. On startup the app writes
its port to `~/.mdopener/ipc-port` and a per-session token to
`~/.mdopener/ipc-token`; the MCP binary reads both to locate and authenticate to
the app, and the app removes them on clean exit.

If the app is not running, most tools return a clear error; `open_file` is the
exception and will cold-start the app via the `mdopener://` URL scheme. The
frontend keeps the app's document, recents, and vault state mirrored to the IPC
layer (via `mcp_sync_state` / `mcp_sync_vault`) so reads are always fresh without
re-walking the disk.

---

## Security

The integration is **local-only and token-authenticated**:

- The IPC server binds to **`127.0.0.1`** (loopback) on an ephemeral port, so
  nothing is exposed beyond your machine.
- On startup the app generates a **32-byte CSPRNG token** (64 hex chars) and
  writes it to `~/.mdopener/ipc-token`. On Unix the file is created **owner-only
  (`0600`)** in a single syscall so the token is never momentarily world-readable.
- **Every endpoint except `/health`** (a data-free liveness probe) requires
  `Authorization: Bearer <token>`. The token is compared in **constant time** to
  avoid leaking a timing signal, and a mismatch returns `401`.
- The MCP `resources/read` channel is **scoped to advertised vault/recents
  files** (it cannot be used to read arbitrary paths off disk) and, like
  the tools below, it reads only Markdown non-dotfiles after resolving
  symlinks.
- Conversation memory under `~/.mdopener/sessions` is **owner-only**: the
  server keeps the directory `0700` and writes each session file `0600`.
- Searches (`search_vault`, `text://vault-search` and the app's `/search`)
  read only the vault files and recents that are Markdown documents and not
  dotfiles, checked after resolving symlinks, so a recent `.env` or a
  `notes.md` link to a key is never searched.
- The tools that read a path straight from disk (`diff_documents`,
  `export_text` / `export_metadata` with `path`, `search_vault` with `vault`
  when the app is unreachable, and the task list of
  `get_user_annotations` for a file that is not the open document) only read Markdown files
  (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`) that are not dotfiles. The
  check runs after symlinks are resolved, so a `notes.md` link to `.env` is
  refused with `isError: true`. The read then takes only the file the check
  saw: on Unix a link put in the file's place afterwards is not followed
  (`O_NOFOLLOW`), and a file with another device and inode (its folder
  swapped for a link, say) is refused. The app's `/search` and
  `/annotations` read the same way. The tools that ask the app to open a path
  (`open_file`, `present_document`, `request_review` with `path`) make the
  same check, since the app would then show the file and
  `get_current_content` would return it; the app's `/open`, `/present` and
  `/review` endpoints refuse such a path too (HTTP 400, and the reason
  reaches the agent). `edit_canvas` likewise re-checks `.canvas`
  after resolving symlinks, and saves by renaming a new temp file over the
  canvas (keeping its permissions), so a canvas swapped for a symlink after
  the check is replaced, never written through.
- `export` with `output_path` writes that file without a dialog and replaces
  an existing file of that name. It only accepts a non-dotfile path with the
  format's own extension (`.html`/`.htm`, `.docx`, `.epub`) in an existing
  directory, so it cannot overwrite Markdown or other file types. The app's
  `/export` endpoint applies the same rule to `outputPath` (which must also be
  absolute) and refuses anything else with HTTP 400, whoever calls it.
- Every disk read (those tools, `edit_canvas`, `file://` resources, the
  recent-documents resource and the local grep fallback) opens regular files
  only, so a FIFO or device named `x.md` is refused (or skipped) instead of
  blocking the server. Each also refuses (or, for search and the
  recent-documents resource, skips) a file larger than 16 MiB, the most the
  app accepts in one request, instead of reading it whole into memory and
  into the reply. Session files are read up to 16 MiB too. The app reads
  the same way when the human opens a document or searches from the
  window: regular files only, opened without blocking, at most 16 MiB (the
  document `/content` returns was read that way).
- An answer from the app's IPC server (or from Ollama) is read up to 64 MiB,
  headers included; a longer one is refused ("more than 64 MiB") instead of
  being read into memory for as long as the peer keeps sending.
- The token and port files are **removed on clean app exit**, so a stale process
  can't authenticate against a new session.

---

## Dev / build-from-source

```bash
# Full install (macOS: builds and installs the app, sidecars, and CLI;
# elsewhere: CLI + MCP only, get the app from Releases):
bash <(curl -fsSL https://raw.githubusercontent.com/ashlrai/ashlr-md/main/scripts/install.sh)

# Or from a checkout:
bash scripts/install.sh

# CLI + MCP only (no Tauri app build):
SKIP_APP_BUILD=1 bash scripts/install.sh
```

The install script requires **Rust** (rustup), **Bun** and **git**. It is a
bash script for macOS and Linux. On macOS the full install also needs Xcode
(see the script header). On Linux it builds and installs only `mdopen` and
`mdopener-mcp` (a C toolchain such as `build-essential` is enough) and says so;
install the app itself from a `.deb`, `.rpm` or `.AppImage` release.

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
- Run `cargo build --release --manifest-path src-tauri/Cargo.toml -p mdopener-mcp`
  from the repo root and register the `src-tauri/target/release/mdopener-mcp`
  path manually.

**Tools return "Ashlr MD does not appear to be running"**
The app must be open for everything except `open_file`. Launch Ashlr MD (or call
`open_file`, which cold-starts it), then retry. The message also says that an
app that is not installed comes from
[the releases page](https://github.com/ashlrai/ashlr-md/releases).

**"IPC auth failed: token mismatch or missing ~/.mdopener/ipc-token"**
The app is starting up or wrote a stale/empty token. Make sure Ashlr MD has
finished launching; if it persists, fully quit and relaunch the app so it
regenerates `~/.mdopener/ipc-port` and `~/.mdopener/ipc-token`.

**Claude Code shows "ashlr-md: failed to start"**
Run `claude mcp list` to see the registered path, then verify the binary exists
at that path and is executable (`chmod +x`). Running
`<path> --version` prints `mdopener-mcp <version>` and exits, so it is a quick
check that the path is right (`--help` prints usage). Any other argument is
ignored, so an old client config that passes one still starts the server, but
it is named on stderr (`ignoring unknown argument ...`); look there in the
client's MCP log for a typo such as `--verison`. That holds for an argument
that is not valid UTF-8 too (it used to stop the server with a panic). Run from a terminal, it says
on stderr that it is waiting for JSON-RPC on stdin; stdout carries only
protocol messages.

**Cursor MCP panel shows the server as offline**
Restart Cursor. If the issue persists, open `~/.cursor/mcp.json` and confirm the
`command` path points to the binary.

**Auto-open hook didn't install**
If `~/.claude/settings.json` has a malformed `hooks` / `hooks.PostToolUse` shape,
the installer bails rather than overwrite it; fix the JSON manually and retry.

**`mdopen` command not found after installing**
On macOS/Linux, make sure `/usr/local/bin` (or `~/.local/bin`) is on your `$PATH`:
```bash
echo $PATH          # check
mdopen --help       # verify
```
On Windows, add the folder holding `mdopen.exe` (`%USERPROFILE%\.local\bin`
after **Install mdopen**, or the app's install folder) to your user `PATH`, then
restart your terminal. The in-app installer does not change `PATH`.
