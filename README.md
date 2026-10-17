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

## 30-second start

1. Download v0.4.0 for your OS from [Releases](https://github.com/ashlrai/ashlr-md/releases/latest): `.dmg` (Apple Silicon), `.msi`/`-setup.exe` (Windows), `.deb`/`.rpm`/`.AppImage` (Linux).
2. Double-click any `.md` file, or run `mdopen notes.md`.
3. Ask the built-in on-device AI about it. No account, no API key.

## Connect your agent (MCP)

Easiest: **Preferences → AI agents (MCP) → Connect to Claude Code / Cursor**. By hand, with the bundled `mdopener-mcp`:

```bash
# Claude Code (macOS path shown; Linux: "/usr/lib/Ashlr MD/mdopener-mcp")
claude mcp add --scope user ashlr-md "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp"
# Codex
codex mcp add ashlr-md -- "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp"
```

Cursor (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "ashlr-md": { "command": "/Applications/Ashlr MD.app/Contents/Resources/mdopener-mcp" } } }
```

Windows path: `%LOCALAPPDATA%\Ashlr MD\mdopener-mcp.exe`. More in [docs/AGENTS.md](./docs/AGENTS.md).
The Settings copy command targets a Unix shell on macOS/Linux and PowerShell on
Windows; its quoting is not intended for Windows Command Prompt (`cmd.exe`).


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
- **Tabs** — open several documents at once; the tab bar appears only when more
  than one is open, so the single-file view stays clean. `⌘⇧]` / `⌘⇧[` to switch,
  `⌘W` to close.
- **Find & search** — find-in-document (`⌘F`) in both rendered and source views,
  find-and-replace in source (`⌘⌥F`), and full-text **search across your recent &
  watched files** (`⌘⇧F`).
- **Split view & Zen mode** — edit with a live preview side-by-side (`⌘\`, synced
  scrolling), or go distraction-free with **Zen mode** (`⌘⇧Z`, `Esc` to exit).
- **Obsidian-compatible** — reads your vault natively: `[[wikilinks]]` (with
  `#heading` / `#^block` anchors and `|aliases`) that resolve vault-wide and open,
  `![[embeds]]` and partial transclusion, sized `![[image.png|300]]` embeds,
  `==highlights==`, hidden `%%comments%%`, and KaTeX math. Read-only **JSON
  Canvas** (`.canvas`) viewing with pan/zoom, plus an **Open in Obsidian** command
  to hand a note back. Never writes to your `.obsidian/` config. Details:
  [**docs/OBSIDIAN.md**](./docs/OBSIDIAN.md).
- **Reading polish** — word count & reading time, footnote hover previews,
  a path breadcrumb, and copy-link-to-heading on hover.
- **Secure by default** — malicious Markdown is sanitized (no script/HTML
  injection), API keys live in the OS keychain (never plaintext), and a strict
  CSP is enforced. See [SECURITY.md](./SECURITY.md).
- **Agent-native review loop** — `mdopen file.md`, the `mdopener://` URL scheme,
  and an **MCP server** so Claude Code / Codex / Cursor can open, read, edit, and
  export the live doc; the **activity drawer (⌘B)** surfaces new agent `.md` files
  the instant they land and **"Explain changes"** narrates each on-disk edit.
  One-click MCP setup in Settings. Full guide: [**docs/AGENTS.md**](./docs/AGENTS.md).
- **Phantom's Markdown opener** — [Phantom](https://github.com/ashlrai/phantom) opens
  `.md` files in Ashlr MD out of the box. See [**docs/PHANTOM.md**](./docs/PHANTOM.md).
- **Obsidian integration** — the [Open in Ashlr MD](./integrations/obsidian/)
  plugin sends any vault note to Ashlr MD with one click (ribbon, command, and
  right-click) via the `mdopener://` scheme.
- **VS Code integration** — the [Open in Ashlr MD](./integrations/vscode/)
  extension opens the active `.md` file in Ashlr MD from an editor title-bar
  button (or the command palette) via the `mdopener://` scheme, with a `mdopen`
  CLI fallback.
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
| Find in document | `⌘F` |
| Find & replace (source) | `⌘⌥F` |
| Search across files | `⌘⇧F` |
| Split preview | `⌘\` |
| Zen mode | `⌘⇧Z` |
| Next / Previous tab | `⌘⇧]` / `⌘⇧[` |
| Close tab | `⌘W` |
| Agent activity drawer | `⌘B` |
| Outline | `⌘⇧O` |
| Settings | `⌘,` |

## One-click agent setup

Open **Preferences → AI agents (MCP)** and click **Connect to Claude Code** or
**Connect to Cursor** — no terminal required. For Codex, copy the command from the
same panel. The **Agent Activity drawer (⌘B)** is the recommended way to watch an
agent's output folder and open new `.md` files the moment they appear. Full guide
+ config snippets: [**docs/AGENTS.md**](./docs/AGENTS.md).

## Download & install

Downloads are on the [GitHub Releases page](https://github.com/ashlrai/ashlr-md/releases).
Full, per-OS instructions live in [**docs/INSTALL.md**](./docs/INSTALL.md).

| Platform | Download (latest release) |
|---|---|
| macOS (Apple Silicon only) | `.dmg` (drag to `/Applications`) |
| Windows (x64) | `.msi` or NSIS `-setup.exe` installer |
| Linux (x86_64) | `.deb` · `.rpm` · `.AppImage` |

Auto-update is built in on every platform. Intel Macs aren't covered by the
current release; build from source (below).

> **Note:** Release builds aren't code-signed yet. On macOS the app isn't
> notarized, so right-click the app and choose **Open** the first time. On
> Windows you may see a SmartScreen warning ("More info → Run anyway"). There
> are no Homebrew, winget or AUR packages yet; use the release downloads. See
> [docs/RELEASING.md](./docs/RELEASING.md).

There's also a one-shot installer that builds from source, installs the `mdopen`
CLI, and wires up Claude Code:

```bash
bash scripts/install.sh
```

The full macOS source installer builds the Swift sidecars declared in the app's
bundle configuration. It needs Xcode 26 / Swift 6.2+ with the macOS 26 SDK for
`mdopener-afm`; a missing sidecar stops packaging with its build instructions.
For the Rust CLI and MCP server only, use `SKIP_APP_BUILD=1 bash scripts/install.sh`;
on Linux that is all the script installs (get the app from the release packages).

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

Source-only MCP setup checks (Python 3, Rust, and Bash; no installer or agent
CLI execution): `python3 scripts/test-mcp-setup.py`.

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

## Part of the Ashlr ecosystem

Ashlr MD is one of the open-source tools from [Ashlr.AI](https://ashlr.ai). Its
siblings: [Phantom](https://github.com/ashlrai/phantom),
[Phantom Secrets](https://github.com/ashlrai/phantom-secrets),
[Lexicon](https://github.com/ashlrai/lexicon),
[Locus](https://github.com/ashlrai/locus) and
[Ashlr Stack](https://github.com/ashlrai/ashlr-stack).

## Contributing

Contributions welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md). The
short version: local-first, no GPL in the bundle, and verify in the real app.

## License

[MIT](./LICENSE) © Ashlr MD contributors
