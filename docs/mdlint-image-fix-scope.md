# Image alt-text fix scope

The [`missing-alt-text` rule](../src/lib/mdlint.ts) reports a warning for an
inline image whose alt text is empty or only whitespace, provided there is at
least one character between the source parentheses. The warning covers the
matched image. Linting alone does not change the document.

For example, the rule reports `Image is missing alt text: chart.png?view=full`
for the image below. **Fix** replaces its empty alt text with the literal
placeholder `TODO: describe image`, preserving the matched source and the
surrounding text:

<!-- example: before -->
```md
See ![](chart.png?view=full) for the results.
```

<!-- example: after -->
```md
See ![TODO: describe image](chart.png?view=full) for the results.
```

The [example test](../src/lib/mdlint-image-fix-scope.test.ts) checks the
warning, its range, and the actual fix against these snippets. Replace the
placeholder with alt text appropriate to the image and its context. The
placeholder is nonempty, so it clears this warning without confirming that
the description is useful. The rule also warns on intentionally empty alt
text for decorative images; see the [review guide](mdlint-placeholder-review.md).

The rule uses a pattern rather than a complete Markdown parser. It does not
match an empty source (`![]()`) or reference-style images, and it stops at the
first closing parenthesis. It does not validate the source or the quality of
nonempty alt text. Front matter, fenced and indented code, HTML blocks, inline
code, and inline math are masked. Another rule can flag an invalid destination;
see [overlapping fixes](mdlint-autofix-guide.md#when-both-warnings-overlap)
and the [image rule boundaries](mdlint-image-rule-boundaries.md) for details.
