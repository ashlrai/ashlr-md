# Contributing to Ashlr MD

Thanks for your interest! Ashlr MD aims to be the instant, beautiful, AI-native
home for Markdown: local-first and open source. See [`docs/VISION.md`](./docs/VISION.md)
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

Open a file while developing by passing it after a second `--` (arguments
after the first go to `cargo run`, which refuses a file name):

```bash
bun run tauri dev -- -- /path/to/file.md
```

### Check the frontend without the desktop shell

On a machine with no Rust toolchain or display (for example a Linux CI box), these run the web part only. The suite is 224 test files and 4146 tests as of Nov 2, 2026 (a full run takes several minutes on a laptop, and the heavy editor DOM tests can hit the 5 s timeout when the machine is busy). `bun run tauri dev` needs the Tauri system libraries.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

## Quality gates (all must pass)

```bash
bun run typecheck        # tsc --noEmit
bunx biome check src     # lint + format
bun run test             # Vitest unit tests
bun run check:crypto     # classical-only crypto policy
bun run check:doc-links  # relative links in the repo's Markdown resolve
bun run check:workflow-bash  # bash -n every bash/sh run block in .github/workflows
python3 scripts/check-docs.py  # docs/AGENTS.md matches tool_registry() and the CLI HELP
node --test scripts/check-readme-parity.test.mjs && node scripts/check-readme-parity.mjs
cargo check --workspace --manifest-path src-tauri/Cargo.toml
cargo clippy --workspace --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --workspace   --manifest-path src-tauri/Cargo.toml   # Rust unit tests
bunx vite build          # production frontend build
bun audit                # known-vuln JS deps (advisory)
cargo audit              # known-vuln Rust deps (advisory; cargo install cargo-audit)
```

Run `bunx biome check --write src` to auto-fix formatting and imports.

`scripts/ci-local.sh [base-ref]` runs the gates your change needs (JS, Rust or
both) before you push. On a pull request, `Check (Linux)` is the one required
check: it runs typecheck, Biome, the crypto policy and a diff secret scan. The
full Linux and macOS suites run after merge on `main` and daily, so run the
suites above for anything beyond a docs change.

## Resolving merge conflicts

Some files churn on every PR and are resolved mechanically, never by hand:

- `CHANGELOG.md` (any depth) is union-merged via `.gitattributes`
  (`merge=union`): both sides' entries survive. Note GitHub's server-side
  merge ignores custom drivers; the attribute helps local `git merge` /
  `git rebase` runs.
- `CLAUDE.md` and `README.md` take main's version and re-apply the PR's
  own hunks; a hunk whose preimage is gone keeps main's version.
- `bun.lock` and `src-tauri/Cargo.lock` are never hand-merged: take main's
  version, then re-run `bun install` / `cargo metadata`. The manifest
  (`package.json` / `Cargo.toml`) must come out byte-identical and
  resolved sources must stay on `registry.npmjs.org` / `crates.io`.

When a `git rebase main` (or `git merge`) stops on conflicts:

```bash
bun run resolve-conflicts        # or: node scripts/resolve-conflicts.mjs
```

Each conflicted path is resolved by the rules above and staged; anything
else is reported and left for a human. Re-run after finishing those, then
`git rebase --continue`. `--dry-run` previews without touching files.
`bun run test:conflicts` runs the fixture-rebase test suite.

## Principles

- **Local-first.** Nothing leaves the device without explicit user action.
- **No GPL** in the bundled dependency tree (keeps the MIT promise intact).
- **Verify in the real app**, not just in theory; a feature is done when it
  works end-to-end and looks great in all three themes (Paper / Sepia / Midnight).
- Match the surrounding code style; comment the non-obvious.

## Architecture

- `src/`: React + TypeScript frontend (Zustand stores, react-markdown renderer,
  Milkdown/CodeMirror editors, AI sidebar, export).
- `src-tauri/src/`: Rust core (file I/O, watcher, deep links, AI proxy, IPC server).
- `src-tauri/bins/`: the `mdopen` CLI and `mdopener-mcp` MCP server.

## License

By contributing you agree your contributions are licensed under the [MIT License](./LICENSE).
