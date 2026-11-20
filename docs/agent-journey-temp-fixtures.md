# Agent journey temporary fixtures

[`agent_journey.rs`](../src-tauri/bins/mdopener-mcp/tests/agent_journey.rs)
drives the real `mdopener-mcp` binary over stdio, with no app running. Its
client sends one JSON-RPC request at a time and requires each reply to carry
that request's id and stdout to hold only JSON-RPC. At the end it closes stdin
and requires a clean exit with no further output. Every directory the tests
use is a `tempfile::TempDir` that lives for the whole test and is removed when
dropped.

## The tests

| Test | What it checks |
| --- | --- |
| `vault_fixture_is_visible_and_removed_when_dropped` | The `vault()` directory's name starts with `vault-`, it holds `plan.md` and `.hidden.md`, and it is gone after an explicit `drop` |
| `default_tempdir_is_not_a_searchable_vault_root` | `disk_vault_dir` refuses a default `tempfile::tempdir()` as a hidden folder and resolves a `vault()` directory to its canonical path |
| `reading_adjacent_bracketed_prose_preserves_both_markers` | `export_text` keeps `[sic][1]` as written |
| `an_agent_works_a_vault_from_disk_without_the_app` | The main journey, described [below](#what-the-main-journey-covers) |
| `a_path_under_the_home_directory_can_be_written_with_a_tilde` | `~/notes/...` paths resolve against the server's home directory, not its working directory |

## Why the vault needs a visible name

`disk_vault_dir` in
[`lib.rs`](../src-tauri/bins/mdopener-mcp/src/lib.rs) canonicalizes the
`vault` argument of `search_vault` and refuses it with a "hidden folder" error
when the final path component starts with `.`. The disk search walk skips
dotfiles, hidden directories, `node_modules` and `target` below a vault, so a
hidden vault root such as `.git` or `.obsidian` would be skipped by its own
rule. Only the final component is checked, not its ancestors.

`tempfile::tempdir()` names its directory `.tmpXXXX`, so as a vault root it
would fail every disk search before the journey reached the fixture files.
`vault()` uses `tempfile::Builder::new().prefix("vault-").tempdir()` instead:
the visible prefix keeps the root searchable, and the random suffix keeps
concurrent tests apart. Keep the prefix free of a leading dot if you replace
the helper. The temporary home is never used as a vault root, so it keeps the
default hidden name.

## Fixture setup

- `vault()` writes `plan.md` from the `PLAN` constant (front matter with a
  nested key, a link, bracketed prose, wikilinks, an image, tasks, a code block, a heading with closing hashes, and non-ASCII text), a
  `plan v2.md` revision with a new date and one task checked, `secrets.txt`
  with a dummy token, and `.hidden.md`.
- The main journey canonicalizes the vault and starts the server with it as
  the working directory. The client sets `HOME` and `USERPROFILE` to a
  separate temporary home and removes `XDG_CONFIG_HOME`, so session files land
  in `<home>/.mdopener/sessions` and no real `~/.mdopener` is read or written.
- Before searching, the journey adds `notes/later.md`, `.git/changelog.md`,
  `changelog.txt` and `.changelog.md`. A search with `vault` set to `.` or to
  the absolute vault path returns `mode: "grep-disk"` and exactly `plan.md`,
  `plan v2.md` and `notes/later.md`: the dotfiles, the hidden directory and the
  non-Markdown file are skipped.
- The tilde test uses a `home-` temporary home holding `notes/plan.md`,
  `notes/plan v2.md` and `notes/board.canvas`, and a separate `cwd-` working
  directory with no `~` folder in it. `~/notes` must therefore resolve against
  the home, and the searched vault's final component is the visible `notes`.

## What the main journey covers

In order:

1. `initialize` (protocol `2025-06-18`) and `tools/list`.
2. `export_text` with a path relative to the working directory, and
   `export_metadata` on `plan.md`.
3. `diff_documents` between `plan.md` and `plan v2.md`.
4. Refusals: `secrets.txt`, `.hidden.md` and `missing.md` fail in both export
   tools without leaking the dummy token, and `search_vault` with no app and no
   `vault` is an error that names Ashlr MD and the `vault` argument.
5. Disk search as described above, a `limit` of 1, and the
   `text://vault-search` resource. A file (`plan.md`), a missing directory and
   the hidden `.git` directory are each refused as `vault`.
6. `save_conversation_message` and `get_conversation_context`, including an
   invalid-params error for an unknown role, then a second server process with
   the same home that reads the session back.

## Cleanup

Dropping a `TempDir` removes its directory recursively, including files added
after setup. Removal is best effort: errors are ignored, and nothing runs if
the process is killed. Keep the handle alive while the server uses the path.
The main journey calls `finish()` on each server before its fixtures go out of
scope.

## Run the tests

Run them from the repository root with an isolated home while keeping the
installed Rust toolchain:

```sh
RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
HOME="$(mktemp -d)" RUSTUP_HOME="$RUSTUP_HOME" CARGO_HOME="$CARGO_HOME" \
  cargo test --manifest-path src-tauri/Cargo.toml -p mdopener-mcp --test agent_journey
```
