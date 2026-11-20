# Plain brackets in text export

`export_text` returns readable text from Markdown. As the 0.6.0 entry in the
[changelog](../CHANGELOG.md) records, it once treated every `[text]` without
an inline `(url)` as a link and removed its brackets: prose such as `[sic]`,
`[TODO]`, and `[1]` came out as `sic`, `TODO`, and `1`, although the page
displayed the brackets. The change concerns the plain-text export only; the
Markdown source was never rewritten.

An ordinary bracketed phrase is prose, so its square brackets now survive
plain-text export. Actual Markdown links export their visible text without
link syntax, and a reference label becomes a link only when the document
defines it. The definition itself is omitted from the output.

The regression test
`export_text_keeps_brackets_unless_a_reference_is_defined` checks the
Markdown-to-text function directly. The examples below exercise the
`export_text` tool itself; each comes from a test in
[`integration.rs`](../src-tauri/bins/mdopener-mcp/tests/integration.rs).
Each Markdown input ends with a newline; the expected `text` has no trailing
newline. Blank lines within an input are significant.

## Prose

From `export_text_keeps_bracketed_todo_in_surrounding_prose`:

Input:
```markdown
Please review [TODO] before the next release.
```
Output:
```text
Please review [TODO] before the next release.
```

From `export_text_keeps_bracketed_sic_in_surrounding_prose`, literal `[sic]`
stays bracketed while the inline link is reduced to its visible text:

Input:
```markdown
The report says the result was 'definately [sic] confirmed' by [the authors](https://example.com).
```
Output:
```text
The report says the result was 'definately [sic] confirmed' by the authors.
```

## Defined and undefined references

In `export_text_keeps_numeric_citations_in_surrounding_prose`, `[1]` and
`[23]` are ordinary text because they have no definitions. `[42]` is a
reference link, and its definition is omitted from the exported text:

Input:
```markdown
Studies [1] and [23] support the finding; see [42] for details.

[42]: https://example.com
```
Output:
```text
Studies [1] and [23] support the finding; see 42 for details.
```

So preserving prose brackets does not mean keeping the syntax of a resolved
reference link.

## Task items

In `export_text_keeps_bracketed_prose_in_list_items`, recognized task
checkboxes and list markers are removed, but bracketed prose is preserved:

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

For more tested cases, see the
[bracket preservation guide](integration-bracket-preservation.md) and the
[bracketed prose example table](bracketed-prose-example-table.md).
