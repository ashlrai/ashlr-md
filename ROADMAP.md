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

- Instant, beautiful rendering (GFM · Shiki · Mermaid · KaTeX)
- WYSIWYG + lossless source editing, atomic save, external-change aware
- Export to PDF / DOCX / HTML (offline, no Pandoc)
- **Free, private, on-device AI** (Apple Foundation Models → Ollama → BYO key)
- Agent hand-off: `mdopen` CLI · `mdopener://` scheme · **MCP server**
- Smart agent output: callouts, interactive checkboxes, plan/diff/multi-file detection
- Three themes, Settings, custom icon, CI + signed-release pipeline, landing site

## Next

**Distribution & reach**
- [ ] Notarized DMG + Homebrew cask (needs an Apple Developer cert → see [`docs/RELEASING.md`](./docs/RELEASING.md))
- [ ] Windows & Linux builds (Tauri makes this largely free)
- [ ] Auto-update channel (plumbing is in; needs the first signed release)

**Make agent output come alive (the differentiator)**
- [ ] Run buttons for more than shell (with sandboxing); inline results
- [ ] Live diff review UI for ` ```diff ` blocks (apply / copy hunks)
- [ ] Multi-file output → tabbed file viewer; "save all to disk"
- [ ] Plan progress tracking that syncs checkboxes ↔ the agent's task list
- [ ] Recognize and pretty-render common agent doc schemas (plans, reviews, specs)

**Deeper agent integration**
- [ ] MCP: multi-document & project awareness, export-to-path, "render this string"
- [ ] Let agents register doc "kinds" + custom renderers (an extension API)
- [ ] A tiny URL/inline-preview mode so an agent can show a doc without a file

**AI**
- [ ] Inline selection rewrite actions; per-document chat memory
- [ ] Local embeddings for "ask across my recent docs" (fully on-device)
- [ ] Premium hosted tier (the sustainability model) — strictly opt-in, zero-retention

**Polish**
- [ ] Outline / table-of-contents sidebar; find-in-document
- [ ] Image paste → saved relative to the file; drag-drop ordering
- [ ] More export themes; "copy as rich text" for email/Slack
- [ ] Accessibility pass (full keyboard nav, screen-reader labels)

## How to shape it

Open an issue or discussion — especially if you're a **non-technical** person
drowning in agent-generated `.md`, or you build agents and want a better
hand-off surface. Real use cases steer this roadmap more than anything.

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).
