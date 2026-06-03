# Roadmap

> **Mission:** be the best open-source home for Markdown in the agentic era —
> the instant, beautiful, AI-native app where the documents AI agents produce are
> a joy to read, edit, share, and act on. See [`docs/VISION.md`](./docs/VISION.md)
> for the north star.

## The goal loop

We build in tight loops, and we don't move on until a loop closes:

```
PLAN  → BUILD → RUN (in the real app) → VERIFY → HARDEN → GATE → REFLECT  ↻
```

A change is "done" only when it works end-to-end in the running app, is beautiful
in all three themes, degrades gracefully, passes every quality gate, and never
leaks data off-device without explicit consent. Quality over scope, every time.

## Shipped (v0.1)

- **Cross-platform** — macOS, Windows, and Linux (Tauri 2)
- Instant, beautiful rendering (GFM · Shiki · Mermaid · KaTeX · callouts)
- WYSIWYG + lossless source + Read views, atomic save, external-change detection with conflict banner
- Export to PDF / DOCX / HTML (offline, no Pandoc)
- **Free, private, on-device AI** (Apple Foundation Models on macOS 26+ → Ollama on Windows/Linux → BYO key → optional hosted)
- **AI superpowers**: selection actions, **inline AI rewrite (⌘I)**, "Explain changes" on disk-change, chat-with-document
- **⌘K command palette** — fuzzy access to every action + recent files
- **Agent Activity drawer (⌘B)** — watch an agent's output folder, open new docs live
- **Outline navigation (⌘⇧O)** — auto table-of-contents with scrollspy
- Agent hand-off: `mdopen` CLI · `mdopener://` scheme · **MCP server** (one-click setup)
- Smart agent output: callouts, interactive checkboxes, plan/diff/multi-file detection with badges
- Three themes, Settings, custom icon, CI + signed-release pipeline, landing site

## Next

**Distribution & reach**
- [ ] Notarized macOS DMG + Homebrew cask (needs an Apple Developer cert → see [`docs/RELEASING.md`](./docs/RELEASING.md))
- [ ] Windows MSI/NSIS installer (code-signing optional; SmartScreen warning until signed)
- [ ] Linux .deb + .AppImage (unsigned)
- [x] Windows & Linux builds (Tauri 2 cross-platform — macOS, Windows, Linux all supported)
- [ ] Auto-update channel (plumbing is in; needs the first signed release)

**Make agent output come alive (the differentiator)**
- [ ] Run buttons for more than shell (with sandboxing); inline results
- [ ] Live diff review UI for ` ```diff ` blocks (apply / copy hunks)
- [ ] Multi-file output → tabbed file viewer; "save all to disk"
- [ ] Plan progress tracking that syncs checkboxes ↔ the agent's task list
- [ ] Recognize and pretty-render common agent doc schemas (plans, reviews, specs)

**Integrations**
- [x] Obsidian plugin — "Open in Ashlr MD" (ribbon, commands, file-menu, editor-menu, settings)
- [ ] VS Code extension — open the active `.md` in Ashlr MD from the editor toolbar
- [ ] Alfred / Raycast workflows for `mdopener://` quick-open

**Deeper agent integration**
- [x] One-click MCP setup for Claude Code, Cursor, and Codex — see [`docs/AGENTS.md`](./docs/AGENTS.md)
- [ ] MCP: multi-document & project awareness, export-to-path, "render this string"
- [ ] Let agents register doc "kinds" + custom renderers (an extension API)
- [ ] A tiny URL/inline-preview mode so an agent can show a doc without a file

**AI**
- [x] Inline selection rewrite actions (⌘I: Rewrite / Fix grammar / Make concise / Expand)
- [ ] Per-document chat memory
- [ ] Local embeddings for "ask across my recent docs" (fully on-device)
- [ ] Premium hosted tier (the sustainability model) — strictly opt-in, zero-retention

**Polish**
- [x] Outline / table-of-contents sidebar (⌘⇧O, with scrollspy)
- [x] Command palette (⌘K)
- [x] Agent Activity drawer (⌘B)
- [ ] Find-in-document
- [ ] Image paste → saved relative to the file; drag-drop ordering
- [ ] More export themes; "copy as rich text" for email/Slack
- [ ] Accessibility pass (full keyboard nav, screen-reader labels)

## How to shape it

Open an issue or discussion — especially if you're a **non-technical** person
drowning in agent-generated `.md`, or you build agents and want a better
hand-off surface. Real use cases steer this roadmap more than anything.

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).
