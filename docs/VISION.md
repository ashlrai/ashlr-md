# Ashlr MD — North Star & Goal Loop

## The goal (end state)

> **The instant, beautiful, AI-native home for every Markdown file — so good that a non-technical person never thinks about "Markdown" again, and an AI agent can drive it like a tool.**

When Ashlr MD is finished, this is true:

1. **Instant.** Double-click any `.md` and it's on screen in well under a second, rendered beautifully. It is the obvious default `.md` handler on every platform.
2. **Beautiful by default.** Agent output (`PLAN.md`, `README.md`, research dumps) looks like a polished document with zero configuration — gorgeous themes, perfect code, diagrams, math, tables.
3. **Effortless to edit.** Non-technical people edit in a Typora-style WYSIWYG and never see raw syntax. Power users get a lossless source mode. Saving is instant and safe.
4. **Free, private AI built in.** Summarize / explain / rewrite / translate runs **locally and free** by default — Apple on-device models on macOS 26+ (Apple Silicon), Ollama on Windows & Linux — with cloud as an optional upgrade. Nothing leaves the device unless the user explicitly opts in.
5. **Agent-native.** Claude Code / Codex / Cursor can open a file (`mdopen file.md` / `mdopener://…`) and *drive* the app over MCP (open, read, edit, export) — with one-click setup. An **Agent Activity drawer** watches the folder your agent writes to so new docs surface live, and a **⌘K command palette** makes every action keyboard-first. The app is a first-class citizen in an agentic workflow.
6. **Shareable in one click.** Export to PDF / DOCX / HTML that looks great, with no Pandoc, no Terminal, no account.
7. **Trustworthy & open.** MIT, local-first, no telemetry by default, no GPL bundled. A great open-source project the world can rely on; a premium hosted-AI tier funds it.

## Who it's for

The growing population of people — many non-technical — who use AI coding agents and are buried in Markdown they didn't ask for and can't comfortably read, edit, or share.

## Experience pillars (the feel)

- **Calm & native.** Feels right on every OS — macOS, Windows, and Linux. No Electron bloat, no jank, no chrome you don't need.
- **Zero-config.** It's right the first time. Defaults are excellent.
- **Honest about data.** A glanceable privacy badge; local-first is the default, not a setting you must find.
- **Respects the file.** Editing never silently corrupts exotic Markdown; lossless source mode is always one click away.

## Definition of excellent (the bar every feature clears)

A feature is "done" only when:

- It **works end-to-end in the real running app** (verified, not assumed — screenshot or live check).
- It is **beautiful in all three themes** (Paper / Sepia / Midnight) and in light + dark.
- It **degrades gracefully** (no provider? large file? malformed input? offline? — all handled).
- It is **fast** (no perceptible lag on a typical agent doc; large files don't freeze the UI).
- Quality gates are green: `tsc` typecheck, Biome lint, `cargo check` (no warnings), production build.
- It **does not leak data** off-device without explicit user action.
- The code reads like the surrounding code and the non-obvious bits are commented.

## The goal loop

Each increment runs the same loop. We do not move on until the loop closes.

```
1. PLAN     — smallest valuable slice toward the end state; name the user-visible win.
2. BUILD    — implement it, reusing existing patterns; no half-measures.
3. RUN      — launch the real app and use the feature (open a real agent .md).
4. VERIFY   — screenshot / live-check against the Definition of Excellent above.
5. HARDEN   — edge cases, errors, all themes, perf, graceful degradation.
6. GATE     — typecheck + lint + cargo check + build all green.
7. REFLECT  — update this doc / README status; note caveats; pick the next slice.
   ↻ repeat
```

**Stop conditions for the loop:** a slice is abandoned only if it would violate a pillar (e.g. requires shipping data off-device by default, or bundling GPL). Otherwise it gets finished.

## Milestone map → end state

| # | Milestone | "Done" means |
|---|---|---|
| M0 | Scaffold | App builds and runs; CI-ready. ✅ |
| M1 | Instant viewer + default handler | Double-click → beautiful render; 3 themes; GFM/code/math/mermaid/footnotes. ✅ |
| M2 | Editor + save | WYSIWYG (Milkdown) + lossless source mode + Read view; safe atomic save; external-change aware; recents; outline (⌘⇧O) with scrollspy. ✅ |
| M3 | Export | One-click PDF / DOCX / HTML that looks great, fully offline, no Pandoc. ✅ |
| M4 | Local-first AI | Tiered provider (Apple on-device, macOS only → Ollama → BYO key → hosted); selection actions, inline rewrite (⌘I), "Explain changes" + chat; privacy badge; free by default. ✅ |
| M5 | Agent hand-off + MCP | `mdopen` CLI + `mdopener://` scheme + MCP server agents can drive; one-click setup; ⌘K command palette; Agent Activity drawer (⌘B). ✅ |
| M6 | Smart rendering + distribution | Interactive checkboxes, code Copy/Run, callouts, plan/diff/multi-file detection; cross-platform builds (macOS DMG + Homebrew cask; Windows MSI/NSIS + winget; Linux .deb/.AppImage + AUR); auto-update. |

## Non-goals (so we stay sharp)

- Not a knowledge base / vault / wiki (that's Obsidian). One file at a time, done perfectly.
- Not a heavy writing suite (that's iA Writer / Ulysses).
- Not a cloud document platform (that's Notion). Local-first, always.
- No account required to use the core product. Ever.
