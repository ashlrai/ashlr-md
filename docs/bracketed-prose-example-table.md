# Bracketed prose: integration examples

These fixtures come from [`integration.rs`](../src-tauri/bins/mdopener-mcp/tests/integration.rs). Each row maps the exact input to the expected plain-text output for the named test and operation. The table includes the bracket-specific export, reference, checkbox, escape, and heading cases; the separate [bracket preservation guide](integration-bracket-preservation.md) presents selected examples.

Inputs and outputs are JSON strings: `\n` is a newline, `\t` is a tab, and `\\` is a literal backslash. This preserves trailing and blank lines. `export_text (trimmed)` matches the heading test’s trimmed text result. Reference definitions are part of the input and do not appear in the output.

| Integration test | Operation | Markdown input | Expected text |
| --- | --- | --- | --- |
| `heading_with_bracketed_phrase_preserves_literal_brackets` | `export_text (trimmed)` | ` "# Plan [Phase One]\n\n## Read [the guide](guide.md)\n" ` | ` "Plan [Phase One]\n\nRead the guide" ` |
| `export_text_keeps_brackets_that_are_not_task_checkboxes` | `strip_markdown` | ` "[ ] not a task" ` | ` "[ ] not a task" ` |
| `export_text_keeps_brackets_that_are_not_task_checkboxes` | `strip_markdown` | ` "> [x] quoted prose" ` | ` "[x] quoted prose" ` |
| `export_text_keeps_brackets_that_are_not_task_checkboxes` | `strip_markdown` | ` "- [ ]" ` | ` "[ ]" ` |
| `export_text_keeps_brackets_that_are_not_task_checkboxes` | `strip_markdown` | ` "- [ ] task" ` | ` "task" ` |
| `export_text_keeps_brackets_that_are_not_task_checkboxes` | `strip_inline_markdown` | ` "[ ] not a task" ` | ` "[ ] not a task" ` |
| `export_text_keeps_brackets_that_are_not_task_checkboxes` | `strip_inline_markdown` | ` "see [x] and [X]" ` | ` "see [x] and [X]" ` |
| `export_text_keeps_brackets_that_are_not_task_checkboxes` | `strip_inline_markdown` | ` "[x](https://e.x) link" ` | ` "x link" ` |
| `export_text_keeps_brackets_that_are_not_task_checkboxes` | `strip_inline_markdown` | ` "[label] ref" ` | ` "[label] ref" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "He said [sic] and [TODO]" ` | ` "He said [sic] and [TODO]" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[**bold**] note" ` | ` "[bold] note" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[a][b] and [c][]" ` | ` "[a][b] and [c][]" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "![alt] here" ` | ` "![alt] here" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[outer [inner](u)]" ` | ` "[outer inner]" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "See [Docs] now\n\n[docs]: https://e.x" ` | ` "See Docs now" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[Foo  Bar] x\n\n[foo bar]: /u" ` | ` "Foo  Bar x" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[a][] x\n\n[a]: /u" ` | ` "a x" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[text][ref]\n\n[ref]: /u \"T\"" ` | ` "text" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[t][r]\n\n[r]: <> (title)" ` | ` "t" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "![logo][img]\n\n[img]: /l.png" ` | ` "logo" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[a][b] x\n\n[a]: /u" ` | ` "[a][b] x" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[q] x\n\n> [q]: /u" ` | ` "q x" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[a] [b]\n\n[a]: /u\n[b]: /v" ` | ` "a b" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[a]\n\n[a]:\n/u" ` | ` "a" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[a]\n\npara\n[a]: /u" ` | ` "[a]\n\npara\n[a]: /u" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[a]\n\n[a]: /u \"t\" junk" ` | ` "[a]\n\n[a]: /u \"t\" junk" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ```` "[a]\n\n```\n[a]: /u\n```" ```` | ` "[a]\n\n[a]: /u" ` |
| `export_text_keeps_brackets_unless_a_reference_is_defined` | `strip_markdown` | ` "[n]\n\n[^n]: note" ` | ` "[n]\n\n[n] note" ` |
| `export_text_keeps_bracketed_todo_in_surrounding_prose` | `export_text` | ` "Please review [TODO] before the next release.\n" ` | ` "Please review [TODO] before the next release." ` |
| `export_text_keeps_literal_brackets_in_blockquote_prose` | `export_text` | ` "> See note [1] and the [guide](/guide).\n" ` | ` "See note [1] and the guide." ` |
| `export_text_keeps_repeated_prose_brackets_in_order` | `export_text` | ` "First [TODO], then [sic], and again [TODO].\n" ` | ` "First [TODO], then [sic], and again [TODO]." ` |
| `export_text_keeps_repeated_prose_brackets_in_order` | `export_text` | ` "[one] [two] [one]; see [the guide](/guide), then [**two**] and [one].\n" ` | ` "[one] [two] [one]; see the guide, then [two] and [one]." ` |
| `export_text_keeps_escaped_opening_and_closing_brackets` | `export_text` | ` "Keep \\[literal\\] beside [a link](/guide).\n" ` | ` "Keep [literal] beside a link." ` |
| `export_text_keeps_escaped_opening_and_closing_brackets` | `export_text` | ` "Keep \\[label\\] and read [label].\n\n[label]: /guide\n" ` | ` "Keep [label] and read label." ` |
| `export_text_keeps_escaped_opening_and_closing_brackets` | `export_text` | ` "An opening \\[ and a closing \\] bracket.\n" ` | ` "An opening [ and a closing ] bracket." ` |
| `export_text_keeps_escaped_opening_and_closing_brackets` | `export_text` | ` "Literal \\[label\\](/guide); real [label](/guide).\n" ` | ` "Literal [label](/guide); real label." ` |
| `export_text_keeps_bracketed_abbreviation_in_surrounding_prose` | `export_text` | ` "Use a common format [e.g.] Markdown for the document.\n" ` | ` "Use a common format [e.g.] Markdown for the document." ` |
| `export_text_keeps_numeric_citations_in_surrounding_prose` | `export_text` | ` "Studies [1] and [23] support the finding; see [42] for details.\n\n[42]: https://example.com\n" ` | ` "Studies [1] and [23] support the finding; see 42 for details." ` |
| `export_text_keeps_digits_in_bracketed_prose` | `export_text` | ` "Use [version 2] after [v1.2], and retain [007].\n" ` | ` "Use [version 2] after [v1.2], and retain [007]." ` |
| `export_text_keeps_digits_in_bracketed_prose` | `export_text` | ` "Compare [item 10] with [item 2]; see [release 3](/releases/3).\n" ` | ` "Compare [item 10] with [item 2]; see release 3." ` |
| `export_text_keeps_digits_in_bracketed_prose` | `export_text` | ` "Keep [step 1] and follow [step 2].\n\n[step 2]: /guide\n" ` | ` "Keep [step 1] and follow step 2." ` |
| `export_text_keeps_multiple_undefined_numbered_references` | `export_text` | ` "Evidence [1], [23][24], and [1] supports the claim; see [42].\n" ` | ` "Evidence [1], [23][24], and [1] supports the claim; see [42]." ` |
| `export_text_keeps_bracketed_prose_at_the_end_of_a_paragraph` | `export_text` | ` "The quotation was accurate [sic]\n" ` | ` "The quotation was accurate [sic]" ` |
| `export_text_keeps_bracketed_prose_at_the_end_of_a_paragraph` | `export_text` | ` "The finding was confirmed [1].\n" ` | ` "The finding was confirmed [1]." ` |
| `export_text_keeps_bracketed_prose_at_the_end_of_a_paragraph` | `export_text` | ` "The quotation was\naccurate [sic]\n\nAnother paragraph.\n" ` | ` "The quotation was\naccurate [sic]\n\nAnother paragraph." ` |
| `export_text_keeps_bracketed_prose_at_the_start_and_end_of_a_paragraph` | `export_text` | ` "[Draft] the finding was confirmed [1].\n" ` | ` "[Draft] the finding was confirmed [1]." ` |
| `export_text_keeps_bracketed_prose_at_the_start_and_end_of_a_paragraph` | `export_text` | ` "[sic] is the annotation added to the quotation.\n" ` | ` "[sic] is the annotation added to the quotation." ` |
| `export_text_keeps_bracketed_prose_at_the_start_and_end_of_a_paragraph` | `export_text` | ` "[needs review]\n" ` | ` "[needs review]" ` |
| `export_text_keeps_bracketed_prose_at_the_start_and_end_of_a_paragraph` | `export_text` | ` "The quotation was accurate [sic]\n\n[TODO] recheck the source.\n" ` | ` "The quotation was accurate [sic]\n\n[TODO] recheck the source." ` |
| `export_text_keeps_bracketed_prose_at_the_start_and_end_of_a_paragraph` | `export_text` | ` "[one] wraps a paragraph\nspanning two lines [two]\n\n[three] opens the next.\n" ` | ` "[one] wraps a paragraph\nspanning two lines [two]\n\n[three] opens the next." ` |
| `export_text_keeps_bracketed_prose_at_the_start_and_end_of_a_paragraph` | `export_text` | ` "[sic] see [the guide](/guide) for details [TODO].\n" ` | ` "[sic] see the guide for details [TODO]." ` |
| `export_text_keeps_bracketed_prose_at_the_start_and_end_of_a_paragraph` | `export_text` | ` "[sic] recheck [the guide] now.\n\n[the guide]: /guide\n" ` | ` "[sic] recheck the guide now." ` |
| `export_text_keeps_bracketed_sic_in_surrounding_prose` | `export_text` | ` "The report says the result was 'definately [sic] confirmed' by [the authors](https://example.com).\n" ` | ` "The report says the result was 'definately [sic] confirmed' by the authors." ` |
| `export_text_keeps_bracketed_prose_in_list_items` | `export_text` | ` "- The quote says 'definately [sic]' in [the report](/report).\n" ` | ` "The quote says 'definately [sic]' in the report." ` |
| `export_text_keeps_bracketed_prose_in_list_items` | `export_text` | ` "1. [sic] begins the note.\n2. End with [TODO].\n" ` | ` "[sic] begins the note.\nEnd with [TODO]." ` |
| `export_text_keeps_bracketed_prose_in_list_items` | `export_text` | ` "- [x] Check the quote [sic].\n- [ ] Follow up [TODO].\n" ` | ` "Check the quote [sic].\nFollow up [TODO]." ` |
| `export_text_keeps_bracketed_phrases_adjacent_to_punctuation` | `export_text` | ` "The note ([needs review]), then continues.\n" ` | ` "The note ([needs review]), then continues." ` |
| `export_text_keeps_bracketed_phrases_adjacent_to_punctuation` | `export_text` | ` "She wrote: '[exact wording]'; he agreed!\n" ` | ` "She wrote: '[exact wording]'; he agreed!" ` |
| `export_text_keeps_bracketed_phrases_adjacent_to_punctuation` | `export_text` | ` "Status:[**needs review**]?! See [the guide](/guide), then [sic]; done.\n" ` | ` "Status:[needs review]?! See the guide, then [sic]; done." ` |
| `export_text_keeps_punctuation_immediately_after_prose_brackets` | `export_text` | ` "Compare [sic],next; [TODO]:now; [1]!really; [x]?yes; [note].End.\n" ` | ` "Compare [sic],next; [TODO]:now; [1]!really; [x]?yes; [note].End." ` |
| `export_text_keeps_adjacent_bracketed_phrases_in_order` | `export_text` | ` "The notes say [first phrase][second phrase] here.\n" ` | ` "The notes say [first phrase][second phrase] here." ` |
| `export_text_keeps_adjacent_bracketed_phrases_in_order` | `export_text` | ` "Review [TODO][sic] before [the release](/release).\n" ` | ` "Review [TODO][sic] before the release." ` |
| `export_text_keeps_adjacent_bracketed_phrases_in_order` | `export_text` | ` "Keep [first][second] together.\n\n[first]: /guide\n" ` | ` "Keep [first][second] together." ` |
| `export_text_keeps_adjacent_bracketed_phrases_in_order` | `export_text` | ` "Read [**first**][second *phrase*] together.\n" ` | ` "Read [first][second phrase] together." ` |
| `export_text_keeps_adjacent_bracketed_phrases_in_order` | `export_text` | ` "Keep [first][second] and follow [the guide][ref].\n\n[ref]: /guide\n" ` | ` "Keep [first][second] and follow the guide." ` |
