# The bracket-loss regression in mdopener-mcp

## What broke

Until the fix recorded under 0.6.0 (Fixed) in the [changelog](../CHANGELOG.md),
`export_text` lost square brackets from ordinary prose: `[sic]`, `[TODO]`, and
`[1]` became `sic`, `TODO`, and `1`, even though the page displayed the
brackets. The inline Markdown reader treated any `[text]` without an inline
destination as link text. This changed the plain-text export, not the source
document.

A related bug read `[ ]` as a link with the text ` `, so `[ ] not a task` in
prose and a bare `- [ ]` with no task text also lost their brackets. The
changelog records both fixes, under "`export_text` keeps brackets that are not
reference links" and "`export_text` keeps brackets that are not task
checkboxes".

## Expected behavior

The fix keeps literal brackets unless the syntax is a link. Inline links such
as `[guide](/guide)` export their text. Shortcut (`[label]`), collapsed
(`[label][]`), and full (`[text][label]`) reference links lose their link
brackets when the document defines the label (`[label]: /url`, in any
container), as CommonMark and the renderer read it. Undefined references stay
literal; reference definitions themselves do not appear in the export. The
same distinction applies to reference images such as `![alt]`. The changelog
records that the behavior was checked against the renderer.

A recognized task checkbox is omitted, while a bracketed phrase in the task
text remains. Every other `[ ]` keeps its brackets.

## Regression tests

The tests live in
[`src-tauri/bins/mdopener-mcp/tests/integration.rs`](../src-tauri/bins/mdopener-mcp/tests/integration.rs):

- `export_text_keeps_brackets_unless_a_reference_is_defined` is the primary
  case for the original loss: undefined labels keep their brackets, defined
  ones lose them, across inline formatting, images, containers, split
  definitions and non-definitions.
- `export_text_keeps_brackets_that_are_not_task_checkboxes` covers `[ ]`, `[x]`
  and `- [ ]` in prose.
- `export_text_keeps_bracketed_sic_in_surrounding_prose` exercises the actual
  export tool with prose beside an inline link.
- `export_text_keeps_bracketed_todo_in_surrounding_prose` and
  `export_text_keeps_bracketed_prose_beside_inline_links` cover brackets next
  to other text and links.

## Examples

Most of these examples reproduce cases from those tests, and the integration
suite runs every one of them through `export_text`. Each input ends with a
newline; the exported text has no trailing newline.

Input:
```markdown
He said [sic] and [TODO]
```
Output:
```text
He said [sic] and [TODO]
```

Input:
```markdown
See [Docs] now

[docs]: https://e.x
```
Output:
```text
See Docs now
```

Input:
```markdown
Review [TODO] and note [1]; see [guide].

[guide]: /guide
```
Output:
```text
Review [TODO] and note [1]; see guide.
```

Input:
```markdown
The report says the result was 'definately [sic] confirmed' by [the authors](https://example.com).
```
Output:
```text
The report says the result was 'definately [sic] confirmed' by the authors.
```

Input:
```markdown
[ ] not a task
```
Output:
```text
[ ] not a task
```

Input:
```markdown
- [ ] task
```
Output:
```text
task
```

Input:
```markdown
- [ ]
```
Output:
```text
[ ]
```

For more cases, see the [input and output pairs](mdopener-bracket-input-output.md),
the [bracket preservation guide](integration-bracket-preservation.md) and the
[fixture table](bracketed-prose-example-table.md).
