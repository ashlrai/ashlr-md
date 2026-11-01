# Visible vault fixture setup

The [`agent_journey.rs` integration tests](../src-tauri/bins/mdopener-mcp/tests/agent_journey.rs)
exercise the real MCP server without the app. Its disk-backed `search_vault`
resolves the supplied vault directory and rejects it if the final component of
the canonical path starts with `.`. The search walk also skips hidden folders
and dotfiles within the vault. This keeps directories such as `.git` out of
the notes search; it does not require every ancestor of the vault to be visible.

`tempfile::tempdir()` normally creates a `.tmp…` directory, so using it as the
vault root would cause a hidden-folder error before the journey could search
its Markdown. The `vault()` helper instead creates a uniquely named directory
with `tempfile::Builder::new().prefix("vault-").tempdir()`, then writes the
plan, its revision, a non-Markdown file, and a hidden Markdown file into it.
The journey adds further search fixtures and checks both the visible results
and the hidden-directory refusal. A separate temporary home isolates session
data and is not the vault root.

The returned `TempDir` owns the vault: keep it alive while the server uses the
path. Dropping it recursively removes the directory and its contents, including
files added later. This cleanup is best effort and cannot run after abrupt
process termination. The fixture lifecycle test checks removal after an explicit
drop, and the default-directory test checks why the visible prefix matters.
See the [journey overview](agent-journey-temp-fixtures.md) for the isolated-home
test command and the other fixtures.
