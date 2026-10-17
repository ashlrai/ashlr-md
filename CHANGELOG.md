# Changelog

All notable changes to Ashlr MD are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [0.4.1] — Unreleased

### Added
- **Copy as rich text.** A new command (⌘⇧C / palette: "Copy as rich text")
  copies the current document to the clipboard as formatted rich text. The
  clipboard entry carries both `text/html` (the rendered document) and
  `text/plain` (the Markdown source), so pasting into Gmail, Slack, Word, or
  Notion keeps headings, bold, lists, links, code, and tables, while pasting
  into a plain editor yields the raw Markdown. Falls back to a plain-text copy
  where the rich clipboard API is unavailable.
- **Structured summary for agent review documents.** When an AI agent writes a
  code-review or findings report — a list of findings each tagged with a
  severity (Critical / High / Medium / Low / Blocker / Major / Minor / Nit /
  Info), often with `Confidence:` lines and `path/to/file.ext:123` references —
  the read view now shows a scannable summary card at the top: color-coded
  severity counts, the total finding count, average confidence, and quick links
  that scroll to each finding. Detection is conservative (it requires at least
  two severity-tagged findings in structural positions, so ordinary prose that
  merely uses the word "critical" is never affected) and the body Markdown
  renders exactly as before beneath the card.
- **Paste images straight into a document.** Pasting an image from the clipboard
  while editing saves it into an `assets/` folder next to the file and inserts a
  relative `![](assets/…)` embed at the cursor. Works in both the source and
  WYSIWYG editors; the write is confined to the document's own folder. Save the
  document first (an unsaved doc has nowhere to put the image).
- **Accessibility pass.** Real focus-trapping with focus-restore for the
  Preferences and Export dialogs; closed side docks are now `inert` (their
  controls leave the tab order and screen-reader tree instead of being reachable
  while off-screen); clearer focus outlines across all themes; higher-contrast
  muted text (notably in Sepia); and motion is calmed under
  `prefers-reduced-motion`.

### Fixed
- **A semantic fallback keeps the app's search note.** When semantic search
  was unavailable and `search_vault` fell back to the app's own search, its
  "semantic search was unavailable" note replaced the app's note, so a
  `truncated: true` result no longer said that only the newest files were
  searched. Both notes are now kept.
- **A slow export no longer turns other agent requests away.** A headless
  export waits up to 30 s for the window, in one of the two slots edits,
  opens, presents and reviews also wait in, so two exports in flight made the
  app refuse all of those as busy until they finished. Headless exports now
  have one slot of their own; a second one sent meanwhile is refused at once,
  saying another export is being written.
- **"The 200 newest files" are the folder's true newest.** Listing the watched
  folder stopped collecting at 2000 files and only then sorted by date, so in a
  bigger folder the Activity drawer and `search_vault` saw the newest of
  whichever 2000 the file system returned first. The walk now keeps the newest
  files as it goes, reads at most 50,000 directory entries, and when it stops
  there the drawer, `/search` and `search_vault` say the list is the newest of
  the files scanned.
- **The vault-cut notice states the app's own cap.** The 200-file limit lived
  in the frontend (`MAX_FILES`) but the "only its 200 most recently changed
  files were searched" notices in `/search` and `search_vault` hard-coded it.
  The frontend now sends its cap with every vault sync, `/vault` reports it as
  `limit`, and both notices quote that number (an older app that does not send
  it gets a notice with no number).
- **A badly encoded `file://` resource URI says so.** `resources/read` with
  `%ZZ`, a lone `%` or `%FF` (not UTF-8) in the path answered "Resource not
  in vault", as if the file were the problem. It is now `-32602` naming the
  bad escape.
- **A vault list cut at 200 files says so.** The app lists the watched
  folder's 200 most recently changed Markdown files, and `search_vault`
  searched only those without a word, so "no hits" read as "not in the
  folder". `search_vault` now returns `truncated: true` with a note, and the
  Activity drawer says it shows only the newest 200.
- **A non-blocking `request_review` resume returns at once.** A call with
  `review_id` and `blocking: false` still waited up to `wait_ms` (50 s by
  default) like a blocking one. It now reads the review once and returns its
  verdict, `pending`, or `timeout` once the window has closed.
- **`edit_canvas` refuses colours JSON Canvas does not allow.**
  `set_node_color` and `add_node` wrote any string as a node colour, so
  `"red"` or `"7"` was saved and the node showed without its colour. Only a
  preset `"1"`..`"6"` or a hex `#rgb` / `#rrggbb` is accepted now; anything
  else is `-32602` and the file is left as it was.
- **MCP arguments outside a schema `enum` are refused up front.** The
  argument check enforced types, `minimum` and `required` but not `enum`, so
  each tool checked its own enumerated arguments in its own words, and an
  `edit_canvas` op `type` such as `"move"` was only refused once the canvas
  file had been read. A value outside a property's `enum` (top level or an
  op field) is now `-32602` before the tool runs, listing the allowed values,
  and the test that walks `tools/list` probes every `enum`.
- **Session files the app writes are private too.** The window persisted a
  conversation session with a `0644` file in a `0755` directory, undoing the
  `0700`/`0600` that `save_conversation_message` sets. The app now makes the
  directory owner-only and writes each session file `0600`.
- **Recent files that are gone leave the list.** A recent whose file was
  deleted or moved stayed in the Recent list and in what `list_recent` gives
  agents for good, and opening it only failed. Recents are checked on launch,
  and one that fails to open because the file is not there is dropped.
- **The watched-folder list (and what `search_vault` searches) follows the
  folder.** Switching folders kept the old folder's files until the new
  listing arrived, kept them for good when it failed, and a slow listing of
  the old folder could land after the switch. The listing also asked for the
  backend's default 100 files while the list holds 200, so half of a large
  folder was never searched. Each folder now starts empty, a stale listing is
  discarded, and up to 200 files are listed.
- **The canvas view says when it cannot show part of a canvas.** Malformed
  nodes and edges, edges to a missing node, and a `nodes` or `edges` that is
  not a list were left out without a word, so a canvas written badly by an
  agent or another tool looked complete. A notice now says what is missing.
- **MCP tool schemas describe the arguments as they work.** Path arguments
  of `request_review`, `get_user_annotations`, `present_document`,
  `diff_documents`, `edit_canvas`, `export_text` and `export_metadata` said
  "Absolute path" though relative paths resolve against the server's working
  directory, and `stream_edit` / `stream_edit_apply` named the app-internal
  `mcp_stream_edit_preview` and the options `previewLines` / `matchIndex`
  instead of `preview_lines` / `match_index`.
- **`request_review` with `review_id` no longer ignores a changed review.**
  `path`, `content` and `timeout_ms` were silently ignored on a resumed call,
  so an agent that edited its plan and resent it with the old id got the
  verdict on the old text. Resending the same values still works; a value
  that differs is now refused (`-32602`) naming it. For a review the server
  did not register (after a restart) the result lists them as `ignored`.
- **`edit_canvas` checks every op field's type, and `add_node` refuses nodes
  the app drops.** A mistyped field was misreported (`"x": "5"` gave
  "`x` required") or written as given (`"color": 3`), a misspelled field
  (`colour`) was ignored, and `add_node` checked only `node.id`, so a node
  without `x` or with an unknown `type` was saved, reported as added, and
  never appeared. All are now `-32602` naming the op index and field.
- **Required MCP arguments are checked before a tool runs.** Each tool
  checked its own required arguments only when it reached them, so
  `edit_canvas` without `ops` read and parsed the canvas file first and a
  missing file hid the real mistake. The argument check now enforces every
  tool's schema `required` list (and `request_review`'s one-of), and a test
  probes every advertised schema with a missing required argument and a
  wrong-typed one, so the schema and what is enforced cannot drift apart.
- **`diff_documents` no longer calls different files identical.** Lines were
  compared without their endings, so a CRLF file against its LF copy, or a
  file against the same text without a final newline, returned `hunks: 0`
  and an empty diff. Line endings now count: a `\r` stays visible in the
  diff and a missing final newline is marked `\ No newline at end of file`,
  as `diff -u` does.
- **Conversation memory is private to its user.** `save_conversation_message`
  created `~/.mdopener/sessions` as `0755` and each session file as `0644`,
  so any local user could read an agent's actions and the human's verdicts.
  The directory is now `0700` (an existing one is tightened on the next save)
  and session files are `0600`, like the IPC token.
- **An over-long `session_id` is refused up front.** An id whose file name
  passed the file system's 255-byte limit was accepted, then saving failed
  with `File name too long (os error 36)` while reading the same id answered
  an empty session. Both conversation tools now return `-32602` when the
  encoded file name would exceed 200 bytes.
- **MCP resources do not follow a Markdown symlink out of the vault.**
  `resources/read` checked only that a `file://` path was advertised, so a
  vault `notes.md` linking to `~/.ssh/id_rsa` or `.env` was served, and the
  `mdopener://recent-documents` preview showed its first 200 characters. Both
  now apply the check the disk-reading tools use (Markdown, not a dotfile,
  after resolving symlinks): the read is refused and the recent is skipped.
- **`export_metadata` and `export_text` see front-matter after a byte order
  mark.** A file saved with a UTF-8 BOM (Notepad does this) came back with
  `frontmatter: null`, and `export_text` kept the raw `---` block in its text
  and word count. A leading BOM is now ignored.
- **Negative MCP integer arguments are refused.** The schemas declared no
  minimum and the tools read integers as unsigned, so `list_recent` with
  `"limit": -5` listed the default 10, `request_review` with
  `"timeout_ms": -1` gave the human 5 minutes, and `stream_edit_apply` with
  `"match_index": -1` applied the first occurrence. Every integer argument now
  declares a `minimum` (`0`; `1` for `get_conversation_context`'s `limit`,
  where `0` was silently raised to `1`) and a value below it returns `-32602`
  naming the argument and the minimum.
- **An unknown MCP prompt or resource says what to ask for instead.**
  `prompts/get` answered `Unknown prompt: Summarize` and `resources/read`
  with no `uri` answered `Unknown resource URI: ` with nothing after it. Both
  now name the closest prompt or URI (`summarize`, `mdopener://current`), say
  when the name or URI is missing, and list the prompts or point to
  `resources/list`.
- **`mdopener-mcp` names an argument it ignores.** Unknown command-line
  arguments are still ignored so older client configs keep working, but a
  line on stderr now names them, so a typo such as `--verison` no longer
  starts the server without a word. Stdout stays JSON-RPC only.
- **`mdopen` says what to do when it cannot open a file.** With the app not
  running and no launcher able to start it, the error was
  `no URL launcher found (...) (Ashlr MD is not running (no ...))`. It now
  names the file, what the running-app and `mdopener://` routes each hit, and
  ends with "Start Ashlr MD, then run mdopen again." The exit code is still 1.
- **MCP tools refuse arguments they do not declare or cannot use.** Every tool
  read only the arguments it knew and defaulted any of the wrong type, so a
  typo (`export_metadata` with `pth`, `list_ai_actions` with
  `include_prompt`) or a mistyped value (`"include_prompts": "no"`,
  `"limit": "5"`, a number in `cited_docs`) was silently ignored and the call
  succeeded with defaults the agent never asked for. `tools/call` now checks
  `arguments` against the tool's `inputSchema` first and returns `-32602`
  naming the argument, the arguments the tool takes and the closest match.
  `arguments` that is not an object is refused the same way; `null` still
  means not given, and `export` keeps its own `theme` message.
- **An unknown MCP tool name says what to call instead.** `Unknown tool:
  Open_File` gave no next step; it now suggests the closest tool
  (`open_file`) and points to `tools/list`. A blank `name` says so.
- **Blank `session_id` is refused.** `save_conversation_message` accepted
  `"   "` and stored it as `~/.mdopener/sessions/%20%20%20.json`; both
  conversation tools now return `-32602` for a whitespace-only id.
- **`mdopen --edit --read` is a usage error.** It opened in whichever mode
  came last and dropped the other flag without a word; it now exits 1 and
  says the flags conflict.
- **MCP `export` with `output_path` writes that file.** The app ignored
  `output_path`: it opened its save dialog (or the print dialog) while the tool
  had already returned `{ "ok": true }`, so an agent believed a file existed that
  was never written. Now html, docx and epub exports go straight to
  `output_path` with no dialog, and the tool returns `{ ok, format, path, bytes }`
  only once the new file is on disk, or `isError` after 30 seconds (the document
  must be in Read view). `output_path` must carry the format's extension, not be
  a dotfile, and sit in an existing directory; a relative path resolves against
  the server's working directory. pdf, which only prints through the system
  dialog, refuses `output_path` with -32602.
- **MCP path arguments resolve like the agent means them.**
  `get_user_annotations`, `edit_document`, `stream_edit` and `stream_edit_apply`
  sent `path` as typed, so a relative, `./`-style or symlinked path (including
  `/tmp` on macOS) never matched the canonical path the app stores:
  `get_user_annotations` returned no verdict for a file `request_review` had
  just recorded, and the edit tools refused the open document as "not the
  currently open document". They now resolve `path` against the server's
  working directory and follow symlinks first, as `open_file` and
  `request_review` already did.
- **MCP read tools no longer read arbitrary files.** `diff_documents`,
  `export_text` and `export_metadata` read their `path` straight from disk with
  no app running, so an agent could read `~/.env` or any other file through
  them. They now accept only Markdown documents (`.md`, `.markdown`, `.mdown`,
  `.mkd`, `.mdx`) that are not dotfiles, checked after resolving symlinks, and
  return an `isError` result otherwise. `edit_canvas` likewise refuses a
  `.canvas` symlink that resolves to a non-canvas file.
- **`--version` on the CLIs.** `mdopener-mcp --version` printed nothing and
  blocked serving stdio; `mdopen --version` failed with "unknown flag". Both now
  print the version and exit 0 (`mdopener-mcp --help` too).
- **Packaging templates name the real release assets.** The Homebrew cask,
  AUR PKGBUILD, winget manifest and docs/RELEASING.md used `Ashlr.MD_…` and
  `ashlr-md_…_amd64.deb`, which 404; Tauri publishes `Ashlr_MD_…`. The PKGBUILD
  and `.desktop` entry now use the installed binary `md-opener` (and icon), and
  the cask points at `Contents/Resources/mdopen`.
- **MCP `export` refuses formats the app cannot write.** Before, any `format`
  (`"xyz"`, `"PDF"`, `"md"`) was forwarded, the app wrote HTML to `output_path`
  and reported ok. The tool now accepts `pdf`, `docx`, `html` and `epub` (the
  app already exported EPUB; the schema did not list it) and returns -32602
  for anything else.
- **MCP `search_vault` says when the app is down.** With Ashlr MD closed it
  returned `{ "mode": "grep-local", "results": [] }`, which reads as "no
  matches": the local grep fallback gets its file list from the app. It now
  returns `isError: true` with the "not running" message, as the other tools
  do; the `text://vault-search` resource returns an error the same way.
- **`mdopen -- -notes.md`** opens `-notes.md`: `--` now ends flags.
- **`docs/AGENTS.md` matches the server:** 20 tools (all listed), default
  protocol `2025-06-18`, the `text://vault-search` and
  `mdopener://recent-documents` resources, and a valid Codex TOML example. A
  test keeps the tool count and default protocol in sync.
- **`mdopener-mcp` reports the app version.** `serverInfo.version` said
  `0.1.0`; it now comes from the crate version, and the `mdopener-mcp` and
  `mdopen` sidecars are versioned with the app (0.4.0). A stdio test keeps
  it equal to `tauri.conf.json`.
- **Windows: Settings looks up the bundled MCP server by its real name.** The
  sidecar lookup behind Settings' connect actions and manual copy command
  searched for `mdopener-mcp` without the `.exe` suffix, so a Windows install
  reported it as not found even though the bundle declares `mdopener-mcp.exe`.
  The lookup now uses the platform's executable suffix, and when nothing is
  found the copy command shows that platform's typical install path instead of
  the macOS one. Not yet verified on an installed Windows build.
- **Settings finds Claude Code and Codex on Windows.** Agent CLI detection
  shelled out to `which`, which stock Windows lacks, so the Connect buttons
  stayed disabled there. It now searches `PATH` in-process (with `PATHEXT` on
  Windows, so npm's `claude.cmd`/`codex.cmd` and the native `claude.exe` are
  found), and the Connect actions run the same resolved file. Not yet verified
  on an installed Windows build.
- **The auto-open hook no longer breaks on the space in "Ashlr MD".** The hook
  command wrote the `mdopen` path unquoted, so Claude Code's shell split
  `/Applications/Ashlr MD.app/...` into two words and the hook never ran. The
  path is now single-quoted, and re-running **Auto-open agent Markdown**
  repairs an unquoted entry an earlier version wrote for the same path. The
  Windows hook assumes Claude Code runs hooks through a POSIX shell (Git Bash);
  that is unverified.
- **Install mdopen on Windows looks for `mdopen.exe`.** It searched for a bare
  `mdopen` and wrote a suffixless copy. It now uses the same lookup as agent
  setup, copies `mdopen.exe` into `%USERPROFILE%\.local\bin`, and no longer
  tries `/usr/local/bin` there. That folder is not on `PATH` by default; the
  docs now say so instead of claiming the installer edits `PATH`.
- **Agent edits apply to the live document, not a stale snapshot.** An MCP
  `edit_document`/`replace_document` that arrived within ~200 ms of you typing
  used to run against a debounced mirror — it could miss just-typed text or
  clobber it. The find/replace now runs against the live document, and
  concurrent edit requests are bounded so they can't stall the agent connection.
- **Agent IPC no longer stalls under concurrent requests.** The loopback server
  now handles requests on a small worker pool, so a slow/large response (e.g. a
  big `/content` read) can't block the agent's review polling behind it. The MCP
  binary also bounds its socket *write* with a timeout, so a wedged server can't
  hang the agent's tool call.
- **Canvas:** arrowheads no longer break when two `.canvas` files are open at
  once (each canvas now uses a unique SVG marker id), and `file` nodes that point
  at a section (`note#Heading` / `#^block`) now embed just that section instead of
  the whole document.
- **Review loop:** an expiring review countdown can no longer dismiss a *newer*
  review that replaced it — dismissal is now scoped to the review it targets.
- **No more silent data loss.** Closing a tab with unsaved edits (⌘W, the ×, or
  the Close command) now asks for confirmation instead of discarding your work.
- **AI chat renders lists correctly.** Responses that mix prose and bullet lists
  no longer get the prose swallowed into the list; and an aborted/empty assistant
  turn is no longer sent back to the model (which providers like Anthropic reject).
- **Export works from any view.** Exporting (HTML/PDF/Word) from Edit or Source
  view now switches to Read first and waits for it to render, instead of silently
  failing; failures surface as a toast.
- **Find-in-document** opened from the editor no longer occasionally shows "0/0"
  on large docs — it waits for the read view to mount rather than a fixed delay.
- **Settings → Content width** stepper added (the setting existed but had no UI).
- Next/Previous-tab commands are hidden when only one tab is open; the MCP
  `export` request reports back when no document is open instead of no-op'ing.

### Internal
- Removed two unused dependencies and dead plugin exports; broken wikilinks now
  re-resolve shortly after the missing note is created instead of staying broken
  for the session.
- Split the 1,091-line `SettingsPanel.tsx` into per-section components (one file
  per preferences section, plus a shared icon set) — no behavior change, the
  panel is now a thin composition shell.

## [0.4.0] — 2026-06-06

### Agent integration & human review
- **One-click connect for your coding agent** — wire Ashlr MD into **Claude
  Code**, **Cursor**, or **Codex** from **Preferences → AI agents (MCP)** without
  touching a terminal. Each button runs the right setup (`claude mcp add`,
  merges `~/.cursor/mcp.json`, or `codex mcp add`) and is enabled only for the
  tools actually detected on your machine; for anything else, copy the exact
  command.
- **Auto-open everything your agent writes** — install the Claude Code
  `PostToolUse` hook (`mdopen --hook`) and every Markdown file Claude writes or
  edits pops into Ashlr MD for review. The hook is silent and always succeeds,
  so it never disrupts your agent's tool flow.
- **Stop-and-ask human review loop** — a new **blocking** `request_review` MCP
  tool lets an agent surface a plan, diff, or finished doc and **wait for your
  sign-off**. You **Approve**, **Request changes**, or **Dismiss** (with
  comments) in the in-app review panel, and the verdict flows straight back to
  the agent so it knows whether to proceed. Pairs naturally with
  `present_document` for a full-screen read before you decide.

### MCP server expansion
- **A real MCP server, not just a launcher** — `mdopener-mcp` now negotiates the
  protocol version (`2024-11-05` / `2025-03-26` / `2025-06-18`), and exposes
  **resources** (`resources/list` + `resources/read`, scoped to your vault and
  recents so it can't read arbitrary files), **prompts** (`summarize`,
  `review_plan`, `improve_writing`, each embedding the live document), and a
  full **tool** set.
- **New tools for agent-driven editing** — `edit_document` (exact, unique
  find/replace that refuses ambiguous or missing matches), `replace_document`
  (whole-document swap), `search_vault` (full-text search across your watched
  folder + recents), and `present_document` (open + switch to distraction-free
  full-screen reading).
- **Token-authenticated loopback IPC** — the server talks to the app over a
  `127.0.0.1` HTTP channel guarded by a per-session 32-byte token; every
  endpoint but a data-free health probe requires it, compared in constant time.

### Obsidian compatibility
- **Reads your Obsidian vault natively** — point Ashlr MD at any note and its
  wikilinks, embeds, highlights, comments, and `.canvas` files render the way
  Obsidian's Reading View shows them. No plugins, no export step.
- **Vault-aware link resolution** — Ashlr MD auto-detects your vault root by
  walking up to the nearest `.obsidian/` folder (or use a **Settings → Vault**
  override), then resolves `[[wikilinks]]` **vault-wide** instead of only
  relative to the current file — fixing links that previously broke when notes
  lived in other folders. When several notes share a name, it picks the
  **closest** match deterministically, so a link always resolves the same way.
- **Full wikilink & transclusion grammar** — `[[note#heading]]` and
  `[[#^block]]` anchors, partial transclusion of a single heading section
  (`![[note#heading]]`) or block (`![[note#^block]]`), and image embeds with
  sizing (`![[image.png|300]]`, `![[image.png|300x200]]`). Embedded images are
  read through the Rust core into an inline `data:` URL (so the webview never
  needs broad filesystem access), capped at 25 MiB each.
- **Highlights & comments** — `==highlights==` render as `<mark>`, and inline
  `%%comments%%` are hidden in the reading view, matching Obsidian. Markers
  inside code are left as literal text.
- **Round-trip & ask-your-vault** — **Open in Obsidian** hands the current note
  back to Obsidian on that exact file (`obsidian://`), and library chat can be
  grounded across your whole vault with source citations.
- **A respectful guest** — saving is **refused** if it would land inside an
  `.obsidian/` config folder; the guard checks the path textually *and* resolves
  symlinks, so your settings, themes, and plugins are never touched.

### Canvas
- **Read-only JSON Canvas viewer** — open `.canvas` files and **pan** (drag),
  **zoom** (scroll), and **Fit** to frame the board. `text`, `file` (Markdown
  card or inline image), `link`, and `group` nodes all render, with edges drawn
  as labelled, arrowed connectors using Obsidian's color presets. Read-only:
  positions and the canvas file are never written back.

### Security & docs
- **Rewritten agent guide and new Obsidian guide** — `docs/AGENTS.md` documents
  every tool, resource, prompt, the review loop, the auto-open hook, and the IPC
  trust model; `docs/OBSIDIAN.md` covers the full compatibility surface and its
  limits.
- **Documented trust model + cross-stack hardening** — the local-only,
  token-authenticated IPC design is spelled out, the `resources/read` channel is
  scoped to advertised files, and a cross-stack security audit's fixes ship in
  this release.

## [0.3.0] — 2026-06-05

### Default-app & reliability
- **The "Make default" banner now tells the truth.** Tri-state detection means
  the prompt appears **only** when Ashlr MD is definitively *not* your default
  `.md` app — never on an unknown/failed check. It re-checks on window focus so
  it self-heals after you change the setting, with **Snooze (14 days)**, **Don't
  ask again**, and a **"Show me how"** fallback. (Root cause fixed: the macOS
  set-default helper had silently stopped shipping on newer SDKs.)
- **Continue where you left off** — open tabs and the active document reopen on
  relaunch (missing files skipped, stale sessions cleared).

### Security
- **API keys now live in your OS keychain** (macOS Keychain · Windows Credential
  Manager · Linux Secret Service) instead of plaintext, migrated automatically
  and only after a confirmed write.
- **Hardened rendering** — HTML is sanitized before math runs, Mermaid SVG is
  purified, and a strict Content-Security-Policy is enforced; script, `onerror`,
  `javascript:`, and `<iframe>` injection are stripped (with regression tests).

### Reading & editing
- **Find & replace** — `⌘F` to find (edit + read views), `⌘⌥F` to replace.
- **Search across files** — `⌘⇧F` cross-file full-text search.
- **Split view (`⌘\`)** — editor + live preview with synced scroll.
- **Zen mode (`⌘⇧Z`)** — distraction-free writing.
- **Wikilinks & embeds** — `[[link]]` and `![[embed]]` resolve across your vault.
- Reading polish: word count (excludes frontmatter/code), footnote hover
  previews, breadcrumbs, copy-link-on-heading.

### Retention & AI
- **Agent Activity Digest — "while you were away"** — on launch, the on-device AI
  summarizes what changed in your watched folder since your last visit, one click
  to review. Fully local by default (Apple Foundation Models / Ollama).
- **Local AI memory — "it knows my stuff"** — a user-owned set of facts /
  preferences / projects feeds your AI chat and quick actions; view, add, or
  forget anything from the **AI memory** panel in Settings. Never leaves the device.
- **Chat with your whole library** — a **This doc / My library** toggle grounds
  answers in your recent and watched Markdown, **with source citations**.
- **Semantic search (opt-in, on-device)** — with a local embedding model
  (`ollama pull nomic-embed-text`), library chat and Related notes use semantic
  retrieval; without one, they fall back to keyword search. Nothing is sent off
  the machine.
- **Related notes** — one-click chips surface documents related to what you're
  reading.
- **Activation & notifications** — one-click "watch this folder" on recognized
  agent docs, live plan task-progress in the status bar, and native notifications
  that fire **only on real agent activity** — never on a timer.

### Deliberately avoided
- No streaks, no scheduled "come back" pings, no engagement-bait.

## [0.2.0] — 2026-06-03

### Added
- **Cross-platform support** — Ashlr MD now builds and runs on **macOS, Windows,
  and Linux** (Tauri 2). Per-OS default-`.md`-handler (Launch Services on macOS,
  `xdg-mime` on Linux, registry + Settings on Windows) and a cross-platform
  `mdopen` CLI.
- **⌘K command palette** — fuzzy, keyboard-first access to every action and your
  recent files, backed by a central command/keymap registry.
- **Agent Activity drawer (⌘B)** — watch the folder your AI agent writes to and
  new Markdown files appear live; click to open instantly.
- **Outline navigation (⌘⇧O)** — an auto table-of-contents with scrollspy.
- **Multiple documents in tabs** — open many docs at once (`⌘⇧]` / `⌘⇧[` / `⌘W`);
  the tab bar appears only when more than one is open.
- **Inline AI superpowers** — rewrite the selection in place in the editor (⌘I)
  with Rewrite / Fix grammar / Make concise / Expand, plus "Explain changes"
  when a file changes on disk.
- **Toast notifications** — clear feedback on save, export, and new agent files.
- **Packaging** — Homebrew cask, winget manifests, and Linux `.desktop` / AUR
  scaffolding; per-OS install guide (`docs/INSTALL.md`).

### Changed
- AI assistant moved to **⌘L** (⌘K is now the command palette).
- Apple Foundation Models on-device AI is correctly scoped to macOS; Ollama is
  the free local tier on Windows/Linux.
- Unified visual language (shadows, motion, focus rings) across every surface in
  all three themes.

## [0.1.0] — 2026-06-02

Initial release: instant beautiful rendering (GFM, code, Mermaid, math,
callouts), WYSIWYG + source editing, PDF/DOCX/HTML export, local-first tiered
AI, agent hand-off (`mdopen` CLI · `mdopener://` · MCP server), the macOS `.md`
default handler, and smart agent-output rendering.

[0.4.0]: https://github.com/ashlrai/ashlr-md/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ashlrai/ashlr-md/releases/tag/v0.3.0
[0.2.0]: https://github.com/ashlrai/ashlr-md/releases/tag/v0.2.0
[0.1.0]: https://github.com/ashlrai/ashlr-md/releases/tag/v0.1.0
