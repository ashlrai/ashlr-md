# Agent journey temporary fixtures

[`agent_journey.rs`](../src-tauri/bins/mdopener-mcp/tests/agent_journey.rs)
exercises the real `mdopener-mcp` binary over stdio without a running app. The
client sends JSON-RPC requests one at a time and checks their replies; it closes
stdin and requires the server to exit cleanly. Temporary directories stay alive
for the duration of each test and are removed when their `TempDir` handles are
dropped.

For the vault helper's creation and cleanup lifecycle, see
[The mdopener agent journey fixture](mdopener-agent-journey-fixture.md).

## Why the vault needs a visible name

The offline `search_vault` path resolves the supplied directory before checking
its final component. A directory whose name starts with `.` is rejected as a
hidden vault; the recursive walk also skips hidden directories beneath a vault.
This prevents a search from treating directories such as `.git` or `.obsidian`
as a vault of notes. A default `tempfile::tempdir()` uses a `.tmp...` name, so
using it as the vault root would make the search fail before it could examine
the fixture. `vault()` instead uses `tempfile::Builder` with the `vault-`
prefix. Keep that prefix non-dot, including when replacing the fixture helper.
The rule applies to the resolved vault directory's final component, not to
every ancestor in its path.

The journey checks both sides: searches of the visible vault find the expected
Markdown files, while a direct search of its `.git` directory returns an error.
Its walk also excludes the hidden Markdown file and hidden directory, as well as
non-Markdown files. A separate temporary home does not serve as the first test's
vault root, so it may use the default hidden temporary name.

## Fixture setup

- `vault()` creates `plan.md` from the `PLAN` constant, a modified `plan v2.md`,
  a non-Markdown file, and `.hidden.md`. `PLAN` includes front matter, links,
  tasks, a code block, an image reference, and Unicode. During the journey the
  test adds `notes/later.md` and hidden and non-Markdown search exclusions.
- The server starts with the canonical vault as its working directory. The
  client sets `HOME` and `USERPROFILE` to a separate temporary home and removes
  `XDG_CONFIG_HOME`, isolating session data under `.mdopener/sessions`. It
  checks disk export, metadata, diff, search, refusals, and conversation
  persistence across server processes.
- The tilde-path journey uses a visible `home-` directory containing `notes`
  with the plan, revision, and a canvas, plus a separate `cwd-` directory. This
  verifies that `~/notes` resolves against the server's home rather than its
  working directory. The searched vault's final component is `notes`.

Run the journey from the repository root with an isolated home while retaining
the installed Rust toolchain:

```sh
RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
HOME="$(mktemp -d)" RUSTUP_HOME="$RUSTUP_HOME" CARGO_HOME="$CARGO_HOME" \
  cargo test --manifest-path src-tauri/Cargo.toml -p mdopener-mcp --test agent_journey
```
