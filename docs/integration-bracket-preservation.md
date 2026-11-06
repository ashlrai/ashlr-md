# Bracket preservation in text export

`export_text` converts Markdown to plain text. A regression stripped the
brackets from ordinary `[text]` even when it was not a link, changing prose
such as `[sic]`, `[TODO]`, and numeric citations. The integration cases in
[`integration.rs`](../src-tauri/bins/mdopener-mcp/tests/integration.rs) cover
preservation alongside actual links and other Markdown syntax.

Each pair below is a tested Markdown input and the expected `text` output.
The input ends with a newline; the output does not. Blank lines inside a pair
are significant. These examples are also checked through the export tool by
the integration suite.

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
