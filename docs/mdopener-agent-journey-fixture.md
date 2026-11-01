# The mdopener agent journey fixture

The [`agent_journey.rs` integration test](../src-tauri/bins/mdopener-mcp/tests/agent_journey.rs)
drives the real `mdopener-mcp` binary over stdio. Its `vault()` helper creates
a temporary directory with `tempfile::Builder::new().prefix("vault-").tempdir()`.
The random suffix makes each test's directory distinct; the `vault-` prefix
makes its final path component visible. A default `tempfile::tempdir()` has a
dot-prefixed name, which the disk-search path rejects as a hidden vault root.
The check concerns the resolved root's final component, not its ancestors.

The helper writes `plan.md` from the `PLAN` constant, a changed `plan v2.md`,
`secrets.txt` with a dummy value, and `.hidden.md`. The main journey keeps the
returned `TempDir` alive, canonicalizes its path, and starts the server there.
It later adds a `notes` directory and hidden and non-Markdown search fixtures.
Searches verify that the visible vault's Markdown is found while hidden files,
hidden directories and non-Markdown files are excluded; a direct search of
the hidden `.git` directory is refused.

The `TempDir` owns the directory and recursively removes it when dropped at
the end of the test, including the files created after setup. Cleanup on drop
is best effort and cannot run after an abrupt process termination. The
`vault_fixture_is_visible_and_removed_when_dropped` test checks the prefix,
representative files, and removal after an explicit drop. The main journey
also closes each server's stdin and waits for a successful exit before its
fixture goes out of scope.

The server uses a separate temporary home for conversation sessions; the
client sets `HOME` and `USERPROFILE` to it and removes `XDG_CONFIG_HOME`.
The home is also owned by a `TempDir` and cleaned up on drop. The separate
tilde-path test uses `home-` and `cwd-` temporary directories and searches the
visible `notes` directory under its temporary home. See the
[journey overview](agent-journey-temp-fixtures.md) for the rest of the test
and its isolated-home command.
