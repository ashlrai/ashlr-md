# Bracket preservation in text export

`export_text` converts Markdown to plain text. As the 0.6.0 entry in the
[changelog](../CHANGELOG.md) records, it once treated every `[text]` without
an inline `(url)` as a link and removed its brackets: prose such as `[sic]`,
`[TODO]`, and `[1]` came out as `sic`, `TODO`, and `1`, although the page
displayed the brackets. Only the plain-text export changed; the Markdown
source was never rewritten.

An ordinary bracketed phrase is prose, so its brackets now survive export.
An actual Markdown link exports its visible text without link syntax, and a
reference label becomes a link only when the document defines it. The
definition itself is omitted from the output.

Each pair below is a tested Markdown input and the expected `text` output.
The input ends with a newline; the output does not. Blank lines inside a pair
are significant. `export_text_matches_documented_bracket_preservation_examples`
in [`integration.rs`](../src-tauri/bins/mdopener-mcp/tests/integration.rs)
runs every pair through the `export_text` tool. Four of them also have their
own regression test: `export_text_keeps_bracketed_todo_in_surrounding_prose`,
`export_text_keeps_bracketed_sic_in_surrounding_prose`,
`export_text_keeps_numeric_citations_in_surrounding_prose` and
`export_text_keeps_bracketed_prose_in_list_items`.
`export_text_keeps_brackets_unless_a_reference_is_defined` checks the
Markdown-to-text function directly. For the full story, see
[the bracket-loss regression](mdopener-bracket-history.md); for a compact
list, see the [bracketed prose example table](bracketed-prose-example-table.md).

## Prose, punctuation, and repeated phrases

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

## Paragraphs and containers

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

## Links, references, and escapes

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
