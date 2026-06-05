# Contributing to Ashlr MD

Thanks for your interest! Ashlr MD aims to be the instant, beautiful, AI-native
home for Markdown — local-first and open source. See [`docs/VISION.md`](./docs/VISION.md)
for the north star and the quality bar every change should clear.

## Prerequisites

- [Rust](https://rustup.rs) (stable)
- [Bun](https://bun.sh)
- Xcode Command Line Tools (macOS)

## Develop

```bash
bun install
bun run tauri dev        # hot-reloading desktop app
```

Open a file while developing by passing it as an argument:

```bash
bun run tauri dev -- /path/to/file.md
```

## Quality gates (all must pass)

```bash
bun run typecheck        # tsc --noEmit
bunx biome check src     # lint + format
bun run test             # Vitest unit tests
cargo check --workspace --manifest-path src-tauri/Cargo.toml
cargo clippy --workspace --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --workspace   --manifest-path src-tauri/Cargo.toml   # Rust unit tests
bunx vite build          # production frontend build
bun audit                # known-vuln JS deps (advisory)
cargo audit              # known-vuln Rust deps (advisory; cargo install cargo-audit)
```

Run `bunx biome check --write src` to auto-fix formatting and imports.

## Principles

- **Local-first.** Nothing leaves the device without explicit user action.
- **No GPL** in the bundled dependency tree (keeps the MIT promise intact).
- **Verify in the real app**, not just in theory — a feature is done when it
  works end-to-end and looks great in all three themes (Paper / Sepia / Midnight).
- Match the surrounding code style; comment the non-obvious.

## Architecture

- `src/` — React + TypeScript frontend (Zustand stores, react-markdown renderer,
  Milkdown/CodeMirror editors, AI sidebar, export).
- `src-tauri/src/` — Rust core (file I/O, watcher, deep links, AI proxy, IPC server).
- `src-tauri/bins/` — the `mdopen` CLI and `mdopener-mcp` MCP server.

## License

By contributing you agree your contributions are licensed under the [MIT License](./LICENSE).
