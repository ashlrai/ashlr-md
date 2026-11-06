# Bracket-loss regression in `export_text`

## What broke

`export_text` (mdopener-mcp) turned prose such as `[sic]`, `[TODO]` and `[1]`
into `sic`, `TODO` and `1`. Any `[text]` with no `(url)` after it was treated as
a reference link and lost its brackets, although the rendered page shows them.
A related case read `[ ]` as a link with the text ` `, so `[ ] not a task` and a
bare `- [ ]` also lost theirs. Both are recorded in [CHANGELOG.md](../CHANGELOG.md)
under "`export_text` keeps brackets that are not reference links" and
"`export_text` keeps brackets that are not task checkboxes".

## Expected behavior

A shortcut, collapsed or full reference (`[text]`, `[text][]`, `[text][ref]`,
and `![alt]` images) loses its brackets only when the document defines its
label (`[ref]: /url`, in any container), as CommonMark and the renderer read it.
Everything else keeps them. Only a real task checkbox is dropped.

| Input | Exported text |
| --- | --- |
| `He said [sic] and [TODO]` | `He said [sic] and [TODO]` |
| `See [Docs] now` + `[docs]: https://e.x` | `See Docs now` |
| `[ ] not a task` | `[ ] not a task` |
| `- [ ] task` | `task` |

## Regression tests

The tests live in
[`src-tauri/bins/mdopener-mcp/tests/integration.rs`](../src-tauri/bins/mdopener-mcp/tests/integration.rs):

- `export_text_keeps_brackets_unless_a_reference_is_defined` is the primary
  case for the original loss: undefined labels keep their brackets, defined ones
  lose them, across containers, split definitions and non-definitions.
- `export_text_keeps_brackets_that_are_not_task_checkboxes` covers `[ ]`, `[x]`
  and `- [ ]` in prose.
- `export_text_keeps_bracketed_todo_in_surrounding_prose` and
  `export_text_keeps_bracketed_prose_beside_inline_links` cover brackets next to
  other text and links.

See also the [history](mdopener-bracket-regression-history.md) and the
[preservation guide](integration-bracket-preservation.md).
