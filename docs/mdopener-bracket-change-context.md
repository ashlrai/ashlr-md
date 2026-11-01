# Why text export preserves prose brackets

The [0.4.1 changelog](../CHANGELOG.md) reports that `export_text` removed
square brackets from ordinary prose when `[text]` had no inline `(url)`.
For example, `[sic]`, `[TODO]`, and `[1]` came out as `sic`, `TODO`, and
`1`, although the page displayed the brackets. The reported change concerns
the plain-text export, not a rewrite of the Markdown source.

The regression test
[`export_text_keeps_brackets_unless_a_reference_is_defined`](../src-tauri/bins/mdopener-mcp/tests/integration.rs)
checks the Markdown-to-text function directly. It expects brackets around
undefined labels to survive, while a defined reference exports its visible
text without the link syntax. The integration tests also exercise the
`export_text` tool itself. For example, these inputs and outputs are checked
through the tool; each input ends with a newline and each output does not.

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
Studies [1] and [23] support the finding; see [42] for details.

[42]: https://example.com
```
Output:
```text
Studies [1] and [23] support the finding; see 42 for details.
```

Here `[1]` and `[23]` have no definitions, whereas `[42]` has one. The
definition is omitted from the text export. This distinction explains why
preserving prose brackets does not mean retaining the syntax of a resolved
reference link. For more tested cases, see the
[bracket preservation guide](integration-bracket-preservation.md).
