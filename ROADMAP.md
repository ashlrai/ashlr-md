# Roadmap

> **Mission:** be the best open-source home for Markdown in the agentic era:
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

## Shipped (v0.4)

**Distribution & reach**
- **Auto-update channel is live**: v0.4.0 published with a working `latest.json`; the in-app updater pulls signed releases.
- **Windows MSI/NSIS + Linux `.deb`/`.AppImage`**: cross-platform installers ship in v0.4.0 (unsigned for now).
- **Apple Silicon macOS build**: ships in v0.4.0 (ad-hoc / unsigned; signing + notarization still pending, see [Next](#next)).

**Make agent output come alive (the differentiator)**
- **Recognize & pretty-render agent docs**: callouts, interactive checkboxes, plan/diff/multi-file detection with badges; plan task-progress syncs to the status bar.

**Deeper agent integration**
- **One-click connect for your coding agent**: wire Ashlr MD into Claude Code, Cursor, or Codex from **Preferences → AI agents (MCP)**, no terminal. See [`docs/AGENTS.md`](./docs/AGENTS.md).
- **Auto-open hook**: a Claude Code `PostToolUse` hook (`mdopen --hook`) pops every Markdown file your agent writes into Ashlr MD for review.
- **A real MCP server**: protocol-negotiating `mdopener-mcp` with **resources** (vault + recents, scoped), **prompts** (`summarize` / `review_plan` / `improve_writing`), and 20 tools including `search_vault`, `present_document`, `edit_document`, `replace_document`, and `export`. Multi-document & project awareness across your vault.
- **Stop-and-ask human review loop**: the blocking `request_review` tool surfaces a plan/diff/doc and waits for your in-app **Approve / Request changes / Dismiss** verdict, which flows straight back to the agent.
- **"Render this string" / inline preview**: `present_document` and `set_content` let an agent show a doc in a distraction-free view without writing a file first.

**Obsidian**
- **Reads your vault natively**: wikilinks, embeds, transclusion, highlights, comments, and math render the way Obsidian's Reading View shows them; no plugins, no export.
- **Vault-aware link resolution**: auto-detects the vault root (`.obsidian/` or a Settings override) and resolves `[[wikilinks]]` vault-wide with deterministic closest-match.
- **JSON Canvas viewer and editor**: open `.canvas`, pan/zoom/Fit; drag nodes to move and edit text with guarded write back. Unknown fields are preserved.
- **Round-trip**: **Open in Obsidian** + the companion **Open in Ashlr MD** plugin (ribbon, commands, file/editor menus, settings).
- **A respectful guest**: saving is refused inside any `.obsidian/` config folder (textual + symlink-resolved guard).

**AI**
- **Find & replace**: `⌘F` to find (edit + read views), `⌘⌥F` to replace; `⌘⇧F` cross-file search.
- **Per-document chat memory + library RAG**: a user-owned AI memory store, and a **This doc / My library** toggle that grounds answers across your recent/watched Markdown with source citations.
- **Local embeddings, on-device**: semantic "ask across my recent docs" via a local Ollama embedding model, with keyword fallback. Nothing leaves the machine.

## Shipped (v0.1)

- **Cross-platform**: macOS, Windows, and Linux (Tauri 2)
- Instant, beautiful rendering (GFM · Shiki · Mermaid · KaTeX · callouts)
- WYSIWYG + lossless source + Read views, atomic save, external-change detection with conflict banner
- Export to PDF / DOCX / HTML (offline, no Pandoc)
- **Free, private, on-device AI** (Apple Foundation Models on macOS 26+ → Ollama on Windows/Linux → BYO key → optional hosted)
- **AI superpowers**: selection actions, **inline AI rewrite (⌘I)**, "Explain changes" on disk-change, chat-with-document
- **⌘K command palette**: fuzzy access to every action + recent files
- **Agent Activity drawer (⌘B)**: watch an agent's output folder, open new docs live
- **Outline navigation (⌘⇧O)**: auto table-of-contents with scrollspy
- **Multiple documents in tabs**: open many docs at once; tab bar appears only with 2+ open (`⌘⇧]` / `⌘⇧[` / `⌘W`)
- Agent hand-off: `mdopen` CLI · `mdopener://` scheme · **MCP server** (one-click setup)
- Smart agent output: callouts, interactive checkboxes, plan/diff/multi-file detection with badges
- Three themes, Settings, custom icon, CI + signed-release pipeline, landing site

## Next

**Distribution & reach**
- [ ] Signed & notarized macOS DMG (needs an Apple Developer cert: the 6 `APPLE_*` secrets, see [`docs/RELEASING.md`](./docs/RELEASING.md))
- [ ] Intel (x86_64) macOS build (pending a GitHub runner)
- [ ] Publish to Homebrew cask, winget, and AUR

**Make agent output come alive (the differentiator)**
- [x] Live diff-review UI for ` ```diff ` blocks (apply / copy hunks): shipped in `src/components/viewer/DiffBlock.tsx` (per-hunk Copy hunk, Copy all, Apply, Reject)
- [ ] Recognize & pretty-render more agent doc schemas (plans, reviews, specs) with bespoke renderers
- [ ] Run buttons for more than shell (with sandboxing); inline results
- [ ] Let agents register doc "kinds" + custom renderers (an extension API)

**Integrations**
- [ ] VS Code extension: open the active `.md` in Ashlr MD from the editor toolbar
- [ ] Alfred / Raycast workflows for `mdopener://` quick-open

**Obsidian**
- [x] JSON Canvas editing (move/edit text nodes, write back; preserve unknown fields)

**AI**
- [ ] Premium hosted tier (the sustainability model), strictly opt-in, zero-retention

**Polish**
- [x] Image paste → saved relative to the file: shipped in `src/lib/pasteImage.ts`, used by `SourceEditor.tsx` and `MarkdownEditor.tsx`
- [ ] Image drag-drop ordering
- [x] "Copy as rich text" for email/Slack: shipped in `src/lib/copyRichText.ts` (`⌘⇧C`)
- [ ] More export themes
- [ ] Accessibility pass (full keyboard nav, screen-reader labels)

## How to shape it

Open an issue or discussion, especially if you're a **non-technical** person
drowning in agent-generated `.md`, or you build agents and want a better
hand-off surface. Real use cases steer this roadmap more than anything.

Contributions welcome: see [CONTRIBUTING.md](./CONTRIBUTING.md).
