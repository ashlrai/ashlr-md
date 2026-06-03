<div align="center">

<img src="./src-tauri/icons/128x128@2x.png" width="84" height="84" alt="Ashlr MD" />

# Ashlr MD

### Markdown, finally beautiful.

**An open-source, AI-native Markdown app for macOS, Windows, and Linux.** Double-click any `.md` and
it's instantly beautiful — read it, edit it, export it, and understand it with
free, private, **on-device AI** built in.

*Think Preview.app, but Markdown-aware, editable, and AI-native — and cross-platform.*

[![CI](https://github.com/ashlrai/ashlr-md/actions/workflows/ci.yml/badge.svg)](https://github.com/ashlrai/ashlr-md/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-0969da.svg)](./LICENSE)
[![Platform: macOS · Windows · Linux](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-1a1a17.svg)](#)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db.svg)](https://tauri.app)

[**Website**](https://md.ashlr.ai) ·
[Download](https://github.com/ashlrai/ashlr-md/releases) ·
[Contributing](./CONTRIBUTING.md) ·
[Roadmap](./ROADMAP.md) ·
[Vision](./docs/VISION.md)

<img src="./docs/og.png" width="820" alt="Ashlr MD — a beautiful Markdown plan with callouts and checkboxes, plus an on-device AI assistant" />

</div>

---

## Why

Your AI agents write Markdown all day — `README.md`, `PLAN.md`, research dumps.
On most systems those open as a wall of raw syntax (TextEdit, Notepad) or a blank
page (Preview). No app owns the simple job of making them *look right* instantly,
especially for non-technical people. Ashlr MD does exactly that, on every platform.

## Features

- **Instant, beautiful rendering** — GFM, Shiki-highlighted code, Mermaid
  diagrams, KaTeX math, GitHub-style callouts, tables, footnotes.
- **Edit without the syntax** — Typora-style WYSIWYG (Milkdown) + a lossless
  source mode (CodeMirror) + a clean Read view. Atomic save; external-change
  detection with a conflict banner.
- **Export anywhere** — one-click **PDF / DOCX / HTML**, fully offline, no Pandoc.
- **⌘K command palette** — fuzzy, keyboard-first access to every action and your
  recent files.
- **Free, private, on-device AI** — summarize / explain / rewrite / translate.
  On **macOS 26+ (Apple Silicon)**: zero-install via **Apple Foundation Models**
  (macOS only). On **Windows & Linux** (and as a fallback on Mac): local
  **Ollama** → your own cloud key → optional hosted. Nothing leaves your device
  unless you opt in.
- **AI superpowers** — select text to Explain / Summarize / Rewrite / Translate;
  **inline AI rewrite in the editor (⌘I)** with Rewrite / Fix grammar / Make
  concise / Expand; **"Explain changes"** when a file changes on disk; and
  chat-with-document.
- **Agent activity drawer (⌘B)** — watch the folder your AI agent writes to and
  new Markdown files appear live; click to open instantly. The answer to "buried
  in agent `.md` files."
- **Outline navigation (⌘⇧O)** — an auto table-of-contents with scrollspy for
  long docs.
- **Agent-native** — `mdopen file.md`, the `mdopener://` URL scheme, and an **MCP
  server** so Claude Code / Codex / Cursor can open, read, edit, and export the
  live doc. One-click MCP setup in Settings.
- **Obsidian integration** — the [Open in Ashlr MD](./integrations/obsidian/)
  plugin sends any vault note to Ashlr MD with one click (ribbon, command, and
  right-click) via the `mdopener://` scheme.
- **Smart agent output** — callouts, interactive checkboxes that save back to the
  file, and automatic plan / diff / multi-file detection with badges.
- **Three themes** — Paper, Sepia, Midnight (light + dark) — switch live.
- **Native & instant** — built on [Tauri 2](https://tauri.app); a tiny native binary
  on every OS, no Electron bloat. MIT, local-first, no telemetry.


## Platform support

| Capability | macOS | Windows | Linux |
|---|---|---|---|
| Core (render · edit · export · themes) | ✅ | ✅ | ✅ |
| Default `.md` handler | ✅ one-click (Launch Services) | ✅ registers association (opens Settings to confirm) | ✅ via `xdg-mime` |
| Free local AI (zero-install) | ✅ Apple Foundation Models (macOS 26+, Apple Silicon) | Ollama (install separately) | Ollama (install separately) |
| `mdopen` CLI & `mdopener://` deep link | ✅ | ✅ | ✅ |
| MCP server | ✅ | ✅ | ✅ |
| Command palette · activity drawer · inline AI · outline | ✅ | ✅ | ✅ |

## Keyboard shortcuts

Shown with ⌘ on macOS — use **Ctrl** on Windows & Linux.

| Action | Shortcut |
|---|---|
| Command palette | `⌘K` |
| AI assistant | `⌘L` |
| Inline AI rewrite (in editor) | `⌘I` |
| Cycle theme | `⌘⇧L` |
| Open file | `⌘O` |
| Save | `⌘S` |
| Export | `⌘E` |
| Read / Edit / Source view | `⌘1` / `⌘2` / `⌘3` |
| Agent activity drawer | `⌘B` |
| Outline | `⌘⇧O` |
| Settings | `⌘,` |

## Use it with an AI agent

```bash
# Open a file from any terminal or agent:
mdopen notes.md
open "mdopener://open?path=$PWD/notes.md"

# Let Claude Code drive the app (open / read / edit / export the current doc):
claude mcp add --scope user ashlr-md /path/to/mdopener-mcp
```

## One-click agent setup

Open **Preferences → AI agents (MCP)** and click **Connect to Claude Code** or
**Connect to Cursor** — no terminal required. For Codex, copy the command from the
same panel. The **Agent Activity drawer (⌘B)** is the recommended way to watch an
agent's output folder and open new `.md` files the moment they appear. Full guide
+ config snippets: [**docs/AGENTS.md**](./docs/AGENTS.md).

## Download & install

Downloads are on the [GitHub Releases page](https://github.com/ashlrai/ashlr-md/releases).
Full, per-OS instructions live in [**docs/INSTALL.md**](./docs/INSTALL.md).

| Platform | Artifact | Package manager |
|---|---|---|
| macOS | `.dmg` (drag to `/Applications`) | `brew install --cask ashlr-md` |
| Windows | `.msi` / NSIS `.exe` installer | `winget install ashlrai.AshlrMD` |
| Linux | `.deb` (Debian/Ubuntu) · `.AppImage` (universal) | AUR: `yay -S ashlr-md` |

Auto-update is built in on every platform.

> **Note:** Windows code-signing is not yet set up — you may see a SmartScreen
> warning; click "More info → Run anyway". macOS builds are notarized. Linux
> AppImages ship unsigned. Homebrew / winget / AUR availability tracks the
> first signed release — see [docs/RELEASING.md](./docs/RELEASING.md).

There's also a one-shot installer that builds from source, installs the `mdopen`
CLI, and wires up Claude Code:

```bash
bash scripts/install.sh
```

## Develop

Prerequisites: [Rust](https://rustup.rs) and [Bun](https://bun.sh).
On macOS, also install Xcode Command Line Tools (`xcode-select --install`).
On Windows, install the [MSVC build tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
On Linux, install `build-essential` (Debian/Ubuntu) or equivalent, plus the
[Tauri Linux dependencies](https://tauri.app/start/prerequisites/#linux).

```bash
bun install
bun run tauri dev        # hot-reloading desktop app
bun run tauri dev -- file.md   # open a file on launch
```

Quality gates (all green in CI):

```bash
bun run typecheck        # tsc --noEmit
bunx biome check src     # lint + format
bun run test             # Vitest unit tests
cargo check --workspace --manifest-path src-tauri/Cargo.toml
```

The on-device AI sidecar (optional, macOS 26+) builds separately:

```bash
cd src-tauri/bins/mdopener-afm && ./build.sh
```

## Architecture

| Layer | What |
|---|---|
| `src/` | React 19 + TS frontend — renderer (remark/rehype + Shiki/Mermaid/KaTeX), Milkdown & CodeMirror editors, AI sidebar, export, Zustand stores |
| `src-tauri/src/` | Rust core — file I/O, watcher, deep links, AI proxy (reqwest), loopback IPC, on-device AI bridge |
| `src-tauri/bins/` | `mdopen` CLI · `mdopener-mcp` MCP server · `mdopener-afm` Swift on-device AI sidecar |
| `landing/` | The marketing site (static, deploy-anywhere) |

See [`docs/VISION.md`](./docs/VISION.md) for the north star and
[`docs/RELEASING.md`](./docs/RELEASING.md) for the release process.

## Contributing

Contributions welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md). The
short version: local-first, no GPL in the bundle, and verify in the real app.

## License

[MIT](./LICENSE) © Ashlr MD contributors
