# Changelog

All notable changes to Ashlr MD are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [0.4.1] — Unreleased

### Fixed
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
