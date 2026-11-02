# The bracket-loss regression in mdopener-mcp

In the [0.4.1 unreleased changelog](../CHANGELOG.md),
`export_text` lost square brackets from ordinary prose: `[sic]`, `[TODO]`, and
`[1]` became `sic`, `TODO`, and `1`, even though the page displayed the
brackets. The inline Markdown reader treated any `[text]` without an inline
destination as link text. This changed the plain-text export, not the source
document.

The fix keeps literal brackets unless the syntax is a link. Inline links such
as `[guide](/guide)` export their text. Shortcut (`[label]`), collapsed
(`[label][]`), and full (`[text][label]`) reference links lose their link
brackets when the applicable label has a definition. Undefined references stay
literal; reference definitions themselves do not appear in the export. The
same distinction applies to reference images. The changelog records that the
behavior was checked against the renderer.

The related checkbox bug also removed brackets from `[ ]` in prose and from
`- [ ]` with no task text. A recognized task checkbox is omitted, while a
bracketed phrase in the task text remains. The
[`export_text_keeps_brackets_that_are_not_task_checkboxes` fixture](../src-tauri/bins/mdopener-mcp/tests/integration.rs)
checks both cases.

## Regression fixtures

The
[`export_text_keeps_brackets_unless_a_reference_is_defined` fixture](../src-tauri/bins/mdopener-mcp/tests/integration.rs)
checks literal prose, inline formatting, defined and undefined references,
images, and definitions in containers. The
`export_text_keeps_bracketed_sic_in_surrounding_prose` fixture exercises the
actual export tool with prose beside an inline link. These examples reproduce
cases from those fixtures and the checkbox fixture. Each input ends with a
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
The report says the result was 'definately [sic] confirmed' by [the authors](https://example.com).
```
Output:
```text
The report says the result was 'definately [sic] confirmed' by the authors.
```

Input:
```markdown
- [ ]
```
Output:
```text
[ ]
```

The integration suite also runs these documented examples through
`export_text`. For more cases, see the [bracket preservation guide](integration-bracket-preservation.md)
and the [fixture table](bracketed-prose-example-table.md).
