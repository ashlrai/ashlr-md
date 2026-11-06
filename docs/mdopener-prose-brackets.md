# Brackets in prose exported by mdopener

`export_text` returns readable text from Markdown. As recorded in the
[changelog](../CHANGELOG.md), it once removed brackets from any `[text]`
without an inline destination: prose such as `[sic]`, `[TODO]`, and `[1]`
lost punctuation that remained visible on the page. The source Markdown was
not changed.

Plain bracketed text now keeps its brackets. An actual inline link exports its
visible text, and a reference link does so when the document defines the
applicable label. The definition itself is omitted from the output. These
examples are existing cases from the
[`mdopener-mcp` integration tests](../src-tauri/bins/mdopener-mcp/tests/integration.rs).
Each input ends with a newline; the exported `text` has no trailing newline.

## A reminder in prose

From `export_text_keeps_bracketed_todo_in_surrounding_prose`:

Input:
```markdown
Please review [TODO] before the next release.
```
Output:
```text
Please review [TODO] before the next release.
```

## Prose beside an inline link

From `export_text_keeps_bracketed_sic_in_surrounding_prose`, `[sic]` remains
literal while the inline link becomes its visible text:

Input:
```markdown
The report says the result was 'definately [sic] confirmed' by [the authors](https://example.com).
```
Output:
```text
The report says the result was 'definately [sic] confirmed' by the authors.
```
