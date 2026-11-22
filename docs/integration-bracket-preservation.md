# Bracket preservation in text export

## What broke

`export_text` converts Markdown to plain text. Until the fix recorded under
0.6.0 (Fixed) in the [changelog](../CHANGELOG.md), it treated every `[text]`
without an inline `(url)` as link text and removed its brackets: prose such
as `[sic]`, `[TODO]`, and `[1]` came out as `sic`, `TODO`, and `1`, although
the page displayed the brackets. Only the plain-text export changed; the
Markdown source was never rewritten.

A related bug read `[ ]` as a link with the text ` `, so `[ ] not a task` in
prose and a bare `- [ ]` with no task text also lost their brackets. The
changelog records both fixes, under "`export_text` keeps brackets that are not
reference links" and "`export_text` keeps brackets that are not task
checkboxes".

## Expected behavior

An ordinary bracketed phrase is prose, so its brackets survive export. Inline
links such as `[guide](/guide)` export their visible text without link
syntax. Shortcut (`[label]`), collapsed (`[label][]`), and full
(`[text][label]`) reference links lose their link brackets only when the
document defines the label (`[label]: /url`, in any container), as CommonMark
and the renderer read it. Undefined references stay literal, and reference
definitions themselves do not appear in the export. The same distinction
applies to reference images such as `![alt]`. The changelog records that the
behavior was checked against the renderer.

A recognized task checkbox is omitted, while a bracketed phrase in the task
text remains. Every other `[ ]` keeps its brackets.

## Regression tests

The tests live in
[`src-tauri/bins/mdopener-mcp/tests/integration.rs`](../src-tauri/bins/mdopener-mcp/tests/integration.rs):

- `export_text_keeps_brackets_unless_a_reference_is_defined` is the primary
  case for the original loss. It checks the Markdown-to-text function
  directly: undefined labels keep their brackets, defined ones lose them,
  across inline formatting, images, containers, split definitions and
  non-definitions.
- `export_text_keeps_brackets_that_are_not_task_checkboxes` covers `[ ]`, `[x]`
  and `- [ ]` in prose.
- `export_text_keeps_bracketed_sic_in_surrounding_prose` exercises the actual
  export tool with prose beside an inline link.
- `export_text_keeps_bracketed_todo_in_surrounding_prose`,
  `export_text_keeps_numeric_citations_in_surrounding_prose`,
  `export_text_keeps_bracketed_prose_in_list_items` and
  `export_text_keeps_bracketed_prose_beside_inline_links` cover brackets next
  to other text, in lists and beside links.

## Examples

Each pair below is a tested Markdown input and the expected `text` output.
The input ends with a newline; the output does not. Blank lines inside a pair
are significant. `export_text_matches_documented_bracket_preservation_examples`
runs every pair through the `export_text` tool. For more cases, see the
[input and output pairs](mdopener-bracket-input-output.md) and the compact
[bracketed prose example table](bracketed-prose-example-table.md).

### Prose, punctuation, and repeated phrases

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
Please review [TODO] before the next release.
```
Output:
```text
Please review [TODO] before the next release.
```

Input:
```markdown
Use a common format [e.g.] Markdown for the document.
```
Output:
```text
Use a common format [e.g.] Markdown for the document.
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
Compare [sic],next; [TODO]:now; [1]!really; [x]?yes; [note].End.
```
Output:
```text
Compare [sic],next; [TODO]:now; [1]!really; [x]?yes; [note].End.
```

Input:
```markdown
[one] [two] [one]; see [the guide](/guide), then [**two**] and [one].
```
Output:
```text
[one] [two] [one]; see the guide, then [two] and [one].
```

Adjacent undefined labels remain in order, even when the first label has a
definition and the second does not:

Input:
```markdown
Keep [first][second] together.

[first]: /guide
```
Output:
```text
Keep [first][second] together.
```

An annotation and a citation written back to back, with no space between
the brackets, keep both fragments in order, as the page shows them:

Input:
```markdown
He said definately [sic][1] in the margin.
```
Output:
```text
He said definately [sic][1] in the margin.
```

### Paragraphs and containers

Input:
```markdown
[one] wraps a paragraph
spanning two lines [two]

[three] opens the next.
```
Output:
```text
[one] wraps a paragraph
spanning two lines [two]

[three] opens the next.
```

Input:
```markdown
> See note [1] and the [guide](/guide).
```
Output:
```text
See note [1] and the guide.
```

### Task checkboxes

A task checkbox is removed, while bracketed prose in the same list stays:

Input:
```markdown
- [x] Check the quote [sic].
- [ ] Follow up [TODO].
```
Output:
```text
Check the quote [sic].
Follow up [TODO].
```

Input:
```markdown
- [ ] task
```
Output:
```text
task
```

A `[ ]` that is not a checkbox, in prose or in a list item with no task text,
keeps its brackets:

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
- [ ]
```
Output:
```text
[ ]
```

### Links, references, and escapes

A defined reference resolves to its label; undefined citations retain their
brackets. The reference definition itself is omitted from plain text.

Input:
```markdown
Studies [1] and [23] support the finding; see [42] for details.

[42]: https://example.com
```
Output:
```text
Studies [1] and [23] support the finding; see 42 for details.
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

Labels match without regard to case:

Input:
```markdown
See [Docs] now

[docs]: https://e.x
```
Output:
```text
See Docs now
```

Escaped brackets remain literal even when the same label defines a reference:

Input:
```markdown
Keep \[label\] and read [label].

[label]: /guide
```
Output:
```text
Keep [label] and read label.
```

Input:
```markdown
Literal \[label\](/guide); real [label](/guide).
```
Output:
```text
Literal [label](/guide); real label.
```
