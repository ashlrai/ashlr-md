# Plain brackets in text export

These examples come from the `export_text` tests in
[`integration.rs`](../src-tauri/bins/mdopener-mcp/tests/integration.rs).
Each Markdown input ends with a newline; the expected `text` has no trailing
newline. Blank lines within an input are significant.

An ordinary bracketed phrase is prose, so its square brackets must survive
plain-text export. Previously, treating every `[text]` as a link removed them.
Actual Markdown links export their visible text without link syntax, while a
reference label becomes a link only when the document defines it.

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
