# Prose bracket regression history

The [0.4.1 unreleased changelog](../CHANGELOG.md), under
“`export_text` keeps brackets that are not reference links,” reports a loss of
punctuation in mdopener-mcp's plain-text export. Previously, `[text]` without
an inline `(url)` lost its square brackets: `[sic]`, `[TODO]`, and `[1]` came
out as `sic`, `TODO`, and `1`, although the page displayed the brackets.

The fix preserves brackets around ordinary prose. A reference link still
exports its visible text without link syntax when its label is defined in the
document; the definition itself is omitted. The changelog reports that this
behavior was checked against the renderer. For example, this input ends with a
newline, while the exported text has no trailing newline:

Input:
```markdown
Review [TODO] and note [1]; see [guide].

[guide]: /guide
```
Output:
```text
Review [TODO] and note [1]; see guide.
```

The [integration tests](../src-tauri/bins/mdopener-mcp/tests/integration.rs)
exercise the export and its distinction between literal brackets and defined
references. The [bracket preservation guide](integration-bracket-preservation.md)
has more examples, including task checkboxes and inline links.
