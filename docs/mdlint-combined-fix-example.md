# Fix a link and image together

This example uses the LF line-ending case of “preserves a bracketed word at the
end of a paragraph and its final newline” in
[mdlint-autofix.test.ts](../src/lib/mdlint-autofix.test.ts). Both blocks end
with a newline.

Input:

<!-- example: input -->
```md
Read [draft]() and see ![](chart.png) for details [note]
```

Expected after applying all available fixes:

<!-- example: output -->
```md
Read [draft](TODO) and see ![TODO: describe image](chart.png) for details [note]
```

The `invalid-link-target` fix replaces the empty destination with `TODO`, and
`missing-alt-text` inserts `TODO: describe image`. The image source, bracketed
word, surrounding text, and final newline remain unchanged. The test verifies
that another lint and fix pass leaves the result unchanged.

Replace the placeholders with the intended URL or path and appropriate alt text;
the absence of warnings does not mean either placeholder is finished content.
See the [autofix guide](mdlint-autofix-guide.md) for rule scope and overlapping
fixes.
