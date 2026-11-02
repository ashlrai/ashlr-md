# Bracket regression: inputs and outputs

The `export_text_keeps_brackets_unless_a_reference_is_defined` regression in
[`integration.rs`](../src-tauri/bins/mdopener-mcp/tests/integration.rs) checks
these exact Markdown inputs and expected plain-text outputs using
`strip_markdown`. Each pair is `[input, output]`; JSON escapes such as `\n`
represent actual newlines. No trailing newline is implied.

Ordinary bracketed prose, such as `[sic]` and `[TODO]`, preserves its square
brackets. Inline formatting inside the brackets is still removed. A real link
or a reference with a matching definition exports its visible text without link
syntax; the definition itself is omitted. Undefined references remain literal.
The examples also distinguish valid definitions from lookalikes in paragraphs,
code, and footnotes.

````json
[
  ["He said [sic] and [TODO]", "He said [sic] and [TODO]"],
  ["[**bold**] note", "[bold] note"],
  ["[a][b] and [c][]", "[a][b] and [c][]"],
  ["![alt] here", "![alt] here"],
  ["[outer [inner](u)]", "[outer inner]"],
  ["See [Docs] now\n\n[docs]: https://e.x", "See Docs now"],
  ["[Foo  Bar] x\n\n[foo bar]: /u", "Foo  Bar x"],
  ["[a][] x\n\n[a]: /u", "a x"],
  ["[text][ref]\n\n[ref]: /u \"T\"", "text"],
  ["[t][r]\n\n[r]: <> (title)", "t"],
  ["![logo][img]\n\n[img]: /l.png", "logo"],
  ["[a][b] x\n\n[a]: /u", "[a][b] x"],
  ["[q] x\n\n> [q]: /u", "q x"],
  ["[a] [b]\n\n[a]: /u\n[b]: /v", "a b"],
  ["[a]\n\n[a]:\n/u", "a"],
  ["[a]\n\npara\n[a]: /u", "[a]\n\npara\n[a]: /u"],
  ["[a]\n\n[a]: /u \"t\" junk", "[a]\n\n[a]: /u \"t\" junk"],
  ["[a]\n\n```\n[a]: /u\n```", "[a]\n\n[a]: /u"],
  ["[n]\n\n[^n]: note", "[n]\n\n[n] note"]
]
````

For examples exercised through the export tool, see the
[bracket preservation guide](integration-bracket-preservation.md).
