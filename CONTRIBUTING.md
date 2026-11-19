# Contributing to Ashlr MD

Thanks for your interest! Ashlr MD aims to be the instant, beautiful, AI-native
home for Markdown: local-first and open source. See [`docs/VISION.md`](./docs/VISION.md)
for the north star and the quality bar every change should clear.

## Who contributes

Ashlr MD is part of Ashlr: Phantom and its ecosystem form a fully autonomous,
code-first, agent-native software factory, run by agents with the human as a
passive board member, chasing open source RSI (recursive self improvement).
See [Part of Ashlr](./README.md#part-of-ashlr) for how this repository fits.

Most changes here come from agents. Phantom (`phm improve`) and other coding
agents open pull requests, merge them once the required checks pass, and fix
`main` forward. Their rules are in [`AGENTS.md`](./AGENTS.md). People follow
the same path: a pull request that passes the
[quality gates](#quality-gates-all-must-pass) below.

## Contribute with an agent

The path is the same whether you type the change yourself, drive a coding
agent, or are a fleet agent. Point your agent at [`AGENTS.md`](./AGENTS.md)
and [`llms.txt`](./llms.txt) first: they index the docs, the `mdopen --json`
CLI and the MCP tool contract.

1. Fork `ashlrai/ashlr-md`, clone your fork, add the upstream remote and
   branch from `main`:

   ```bash
   git clone https://github.com/<your-user>/ashlr-md.git
   cd ashlr-md
   git remote add upstream https://github.com/ashlrai/ashlr-md.git
   git fetch upstream
   git switch -c my-change upstream/main
   bun install
   ```

2. Make one change per pull request and keep the diff small. Never commit
   secrets: both diff secret scans fail closed.
3. Run the gates your change needs before pushing:

   ```bash
   scripts/ci-local.sh upstream/main
   ```

   It classifies the diff with `scripts/ci/select.mjs`, which maps changed
   paths to the JS and Rust gates. It always runs typecheck, Biome, the crypto policy, version sync, doc links
   and the conflict and selector tests; it adds Vitest on changed files when
   the frontend changed, and `cargo clippy` plus `cargo test` on the affected
   crates when Rust changed. The default base is `origin/main`, which in a
   fork clone is your fork, so pass `upstream/main`.

   For a docs-only change, `bun run check:doc-links` and `bun run doclive:check`
   cover links and doc claims. After editing `docs/AGENTS.md`, also run
   `python3 scripts/check-docs.py`.

   `ci-local.sh` does not run the two diff secret scans, and both block the
   required check. Run the secret-shape scan the way CI does; it prints only a
   count, never the matched value, and exits non-zero on a hit:

   ```bash
   git diff --no-color --no-ext-diff "$(git merge-base upstream/main HEAD)" \
     | perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures
   ```

   With [Gitleaks](https://github.com/gitleaks/gitleaks) installed (CI pins
   8.30.0 and ignores any repository Gitleaks config), scan your commits:
   `gitleaks git . --log-opts="upstream/main..HEAD" --redact`.

4. Push the branch to your fork and open a pull request against `main`.
   Fill in the template.
5. `Check (Linux)` is the one required check (see
   [what it runs](#quality-gates-all-must-pass)). Once it is green the pull
   request merges through GitHub auto-merge (`gh pr merge --auto`) and the
   merge queue. GitHub lets only accounts with write access arm auto-merge, so
   on a fork pull request a maintainer or fleet agent arms it for you. Paths
   listed in [`.github/CODEOWNERS`](./.github/CODEOWNERS) (CI workflows,
   the secret-shape fixtures and the Rust files that make network or loopback
   requests) have a named owner, so expect a review there.
6. After merge the full Linux and macOS suites run on `main`. If `main` goes
   red, it is fixed forward with a new pull request, never by force-pushing.

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

On a machine with no Rust toolchain or display (for example a Linux CI box), these run the web part only. A full run takes several minutes on a laptop, and the heavy editor DOM tests can hit the timeout when the machine is busy; a handful of CLI tests build `mdopen` and `mdopener-mcp` with cargo first. `bun run tauri dev` needs the Tauri system libraries.

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
bun run test             # llms.txt node test, then the full Vitest suite
bun run test:unit        # fast lane CI runs first: punctuation, CLI build setup, mdlint
bun run check:crypto     # classical-only crypto policy
bun run check:doc-links  # relative links in the repo's Markdown resolve
node --test scripts/package-scripts.test.mjs  # npm scripts point at files that exist
node --test scripts/ci/gate.test.mjs scripts/ci/release-gate.test.mjs scripts/ci/assembly-workflow.test.mjs  # CI and release gate regressions
python3 scripts/test-apt-dependency-plan.py && python3 scripts/test-apt-https-sources.py && python3 scripts/test-prefetch-tauri-bundler-tools.py  # dependency plan parser regressions
python3 scripts/test-mcp-setup.py && python3 scripts/test-connect-cursor.py  # MCP setup and Cursor connect helpers
bun run test:select      # tests for scripts/ci/select.mjs, the diff classifier ci-local.sh uses (fails open to every gate)
bun run test:dispatch    # allowlist validation of workflow_dispatch inputs
bun run test:freshness && bun run fresh:check  # generated release blocks (`bun run fresh:sync` rewrites them)
bun run test:doclive && bun run doclive:check  # doc claims vs code + generated docs blocks (`bun run doclive:sync` rewrites them)
bun run check:version    # package.json, tauri.conf.json and Cargo.toml versions agree
bun run check:workflow-bash  # bash -n every bash/sh run block in .github/workflows
python3 scripts/check-docs.py  # docs/AGENTS.md matches tool_registry() and the CLI HELP
node --test scripts/check-readme-parity.test.mjs && node scripts/check-readme-parity.mjs
cargo check --workspace --manifest-path src-tauri/Cargo.toml
cargo clippy --workspace --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --workspace   --manifest-path src-tauri/Cargo.toml   # Rust unit tests
bunx vite build          # production frontend build
HOME=$(mktemp -d) bun run bench:render  # render benchmark (see bench/README.md); not part of CI
bun audit                # known-vuln JS deps (advisory)
cargo audit              # known-vuln Rust deps (advisory; cargo install cargo-audit)
```

Run `bunx biome check --write src` to auto-fix formatting and imports.

After adding, renaming or removing a test in `src/lib/mdlint-autofix.test.ts`,
run `bun run docs:fixtures` to regenerate
[docs/mdlint-autofix-fixture-index.md](./docs/mdlint-autofix-fixture-index.md).
The index is a lookup aid, so no test fails while it lags the test file.

`scripts/ci-local.sh [base-ref]` runs the gates your change needs (JS, Rust or
both) before you push. On a pull request, `Check (Linux)` is the one required
check. It passes only when these jobs in `.github/workflows/ci.yml` succeed:

- the fast job: typecheck, Biome, the CI gate regression tests, the dependency
  plan parser tests, `bun run test:unit`, npm script paths, doc links, version
  sync, workflow run-block syntax and the crypto policy (`bun audit` runs too,
  but does not block);
- two diff secret scans: Gitleaks and the secret-shape scan.

The same check runs again in the merge queue. The full Linux and macOS suites
run after merge on `main` and daily, so run the suites above for anything
beyond a docs change.

## DeepWiki documentation

[`.devin/wiki.json`](./.devin/wiki.json) steers DeepWiki generation with
repository-wide notes and an explicit list of pages. DeepWiki generates only
the listed pages, so update their titles and purposes when major areas of the
codebase change; keep parent titles in sync when renaming pages. Both
`repo_notes` and a nonempty `pages` array are required. See the
[DeepWiki configuration guide](https://docs.devin.ai/work-with-devin/deepwiki)
for the format and limits.

The config does not itself trigger indexing or refresh. Follow DeepWiki's
service instructions to index the repository and regenerate the wiki after
changes. Generated documentation is a navigation aid; source code and the
maintained guides remain authoritative.

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
- `src-tauri/bins/`: the `mdopen` CLI, the `mdopener-mcp` MCP server, and the macOS Swift sidecars (`mdopener-afm` on-device AI, `mdopener-setdefault` default-handler helper).

## License

By contributing you agree your contributions are licensed under the [MIT License](./LICENSE).
