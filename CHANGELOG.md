# Changelog

All notable changes to Ashlr MD are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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

[0.3.0]: https://github.com/ashlrai/ashlr-md/releases/tag/v0.3.0
[0.2.0]: https://github.com/ashlrai/ashlr-md/releases/tag/v0.2.0
[0.1.0]: https://github.com/ashlrai/ashlr-md/releases/tag/v0.1.0
