# Visible fixture parent directory

The [`agent_journey.rs` integration tests](../src-tauri/bins/mdopener-mcp/tests/agent_journey.rs)
keep their Markdown fixture files inside a temporary directory that is both
their parent and the `vault` the offline `search_vault` is asked to read.
`tempfile::tempdir()` would give that parent a `.tmpXXXX` name: a
dot-prefixed, hidden directory. `disk_vault_dir` canonicalizes the supplied
vault and refuses it when the final path component starts with `.`, because
the recursive walk skips hidden folders (`.git`, `.obsidian`) below a vault,
so a hidden vault root would be skipped by its own rule. A hidden temporary
parent would therefore fail every disk-backed call before the journey reached
the fixture files, which is why `vault()` builds the directory with
`tempfile::Builder::new().prefix("vault-")`: the visible `vault-` name keeps
the parent searchable while the random suffix keeps concurrent tests
distinct. Only the resolved root's final component must be visible; its
ancestors are not checked. The `default_tempdir_is_not_a_searchable_vault_root`
test shows both sides: a default `.tmp…` directory is refused as a hidden
folder while the `vault-` directory resolves to its canonical path.

Inside the visible parent the fixture still exercises hidden entries —
`.hidden.md`, and the `.git` directory the journey adds — which the walk
skips without refusing the vault itself. The tilde-path test keeps the same
rule: `~/notes` resolves to a visible `notes` component under the temporary
`home-` directory.

Cleanup is the `tempfile::TempDir` the helper returns: it owns the parent
directory, and dropping it removes the directory and its contents
recursively, including files added after setup. Removal is best effort —
errors are ignored and it cannot run after abrupt process termination — so
the fixture lives exactly as long as its `TempDir` handle. The
`vault_fixture_is_visible_and_removed_when_dropped` test drops the handle
explicitly and asserts the path no longer exists; the server's temporary HOME
is a second `TempDir` cleaned up the same way.

See [The mdopener agent journey fixture](mdopener-agent-journey-fixture.md)
for the fixture's contents, [Visible vault fixture setup](mdopener-visible-fixture-setup.md)
for the refusal rule, and the [journey overview](agent-journey-temp-fixtures.md)
for the isolated-home test command.
