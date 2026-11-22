# mdopener-mcp doctor --fix

`mdopener-mcp doctor --fix` previews repairs to Ashlr MD's state folder, `~/.mdopener`, and
writes nothing. `mdopener-mcp doctor --fix --apply` makes them. Add `--json` for one
`"kind": "ashlr.doctor"` object that also carries `mode`, `plan` and `outcome`
([JSON output](#json-output)). Same semantics as `locus doctor --fix`; `stack doctor --fix`
runs it because the handshake (`mdopener-mcp --ashlr-handshake`) lists `doctor-fix`.

```bash
mdopener-mcp doctor --fix            # dry run: "would fix" lines and manual items
mdopener-mcp doctor --fix --apply    # make the repairs
mdopener-mcp doctor --fix --json     # { "kind": "ashlr.doctor", "mode": "dry_run", "plan": {...}, "outcome": null, ... }
mdopener-mcp doctor --help           # usage for --fix and --apply
```

Exit codes: 0 when there is nothing to repair, after a preview, or when every fix applied;
1 when an applied fix was skipped (for example the file changed between plan and apply), or
when no home directory is found (set `HOME`).
`--apply` without `--fix`, or an unknown argument, is refused with exit 2 and nothing written;
an unknown argument also prints the usage on stderr.

## Repairs (macOS and Linux)

| Finding | `--apply` does |
| --- | --- |
| `~/.mdopener`, `sessions/` or `reviews/` with any group or other permission bit | `chmod 700` (the previous mode is reported) |
| a session file, saved review or `ipc-port` with any group or other permission bit | `chmod 600` (contents untouched) |
| a saved review that is oversized, does not parse, has another schema, or is stored under another file's name (the reader ignores it) | copies it to `<file>.bak-<UTC stamp>` (new file, 0600; `-1`, `-2` and so on are appended if that name is taken), compares the copy byte for byte, then removes the original |

Older builds created session files `0644`, and reopening an existing file never changes its
mode, so those stayed readable by other users. Each fix is checked again against the folder as
it is now before it is made; one that no longer applies is skipped.

Only `.json` files in `sessions/` and `reviews/` are checked. When `~/.mdopener` does not
exist there is nothing to repair. When it is not a directory, or is a symlink, the plan is one
manual item and nothing inside is checked.

## Manual items (report only)

Each item carries a `code`:

| `code` | Finding |
| --- | --- |
| `ipc_token_not_private` | `ipc-token` has any group or other permission bit |
| `not_a_regular_entry` | a symlink or special file where a folder or file was expected |
| `state_dir_not_a_directory` | `~/.mdopener` is not a directory, or is a symlink |
| `permissions_not_checked` | Windows, where permissions are not checked |

- `ipc-token` open to group or others: it is the app's secret, so this tool never opens, moves or
  changes it. The item names the command: `chmod 600 ~/.mdopener/ipc-token`.
- Symlinks and special files: never followed or changed.
- MCP client registration and sidecar paths: repaired by the app's agent setup
  (Preferences > AI agents), not here.

On Windows the plan is empty with one manual note (permissions are not checked).

## JSON output

`--json` prints one object. The native fields:

- `mode`: `"dry_run"` or `"apply"`.
- `plan`: `fixes` (`{ kind: "tighten_mode", file, current_mode, target_mode }` or
  `{ kind: "move_aside", file, reason }`) and `report_only` (`{ code, file?, message }`).
- `outcome`: `null` for a preview or when there is nothing to apply, else `{ results: [{ fix, applied, backup?, previous_mode?, message? }] }`.

The same object carries the shared `ashlr.doctor` v1 envelope that `mdopener-mcp doctor --json`
uses, so one parser reads both:

| Field | Value |
| --- | --- |
| `kind` | `"ashlr.doctor"` |
| `schema_version` | `1` |
| `tool` | `"ashlr-md"` |
| `native_status` | `"dry_run"` or `"apply"`, the same as `mode` |
| `checks` | one `{ id, status, summary }` per fix and per manual item |
| `status` | `"fail"` if any check failed, else `"warn"` if any warned, else `"ok"` |

In a preview each planned fix is a `warn` check with `id: "fix"`. After `--apply` each fix is
`ok` when it applied and `fail` when it was skipped. Manual items are always `warn`; their `id`
is the item's `code` in lowercase with other characters turned into dashes (for example
`ipc-token-not-private`). Nothing to repair
gives an empty `checks` list and `status: "ok"`. The envelope is additive: the native fields and
the exit code do not change.
