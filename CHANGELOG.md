# Changelog

All notable changes to Ashlr MD are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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

[0.2.0]: https://github.com/ashlrai/ashlr-md/releases/tag/v0.2.0
[0.1.0]: https://github.com/ashlrai/ashlr-md/releases/tag/v0.1.0
