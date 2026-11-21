# Image alt-text rule boundaries

> **Not in the app yet.** The **Fix** and **Fix all** suggestions toast this
> page describes is not mounted in Ashlr MD as of 0.7.5. The rules and fixes
> live in `src/lib/mdlint.ts`, and the examples here are what its tests assert.
> See [where the linter shows up today](./LINTER.md#where-it-shows-up-today).

The [`missing-alt-text` rule](../src/lib/mdlint.ts) reports a **warning** when
an inline image-shaped match has an empty alt field (`![](chart.png)`) or one
containing only whitespace (`![  ](chart.png)`). Tabs and other JavaScript
whitespace count as whitespace. The rule is enabled by default in Settings →
Linter rules. It does not assess whether nonempty alt text is descriptive or
whether the image source exists.

The warning covers the matched image and names its source, for example
`Image is missing alt text: chart.png?view=full#data`. Linting leaves the
document unchanged. **Fix** replaces the empty alt field of one image, and
**Fix all** of every flagged image, with the literal placeholder
`TODO: describe image`, retaining the matched source and surrounding text:

<!-- example: before -->
```md
See ![](chart.png?view=full#data) and ![  ](map.png "Map").
```

<!-- example: after -->
```md
See ![TODO: describe image](chart.png?view=full#data) and ![TODO: describe image](map.png "Map").
```

The [example test](../src/lib/mdlint-image-rule-boundaries.test.ts) checks the
warnings, their ranges and messages, and both fixes against these snippets.

## Matching limits

The rule uses a pattern, not a full Markdown parser. It matches `![alt](source)`
with at least one character in the source, and stops the match at the first
`)`. It does not validate the source: even a whitespace-only source can match.
Consequently:

| Input | `missing-alt-text` result |
| --- | --- |
| `![](image.png)` or `![ ](image.png)` | Warning |
| `![]( )` | Warning |
| `![]()` or `![  ]()` | No match: source is empty |
| `![description](image.png)` | No warning: alt is nonempty |
| `![][image]` or `![ ]` | No match: reference or shortcut syntax |

The first closing parenthesis also ends the source used by the fix. For
example, `![](plot(1).png)` is fixed to
`![TODO: describe image](plot(1).png)`: the remaining `.png)` is outside
the match. Escaped or nested delimiters are not parsed as Markdown structure,
so do not rely on this rule to recognize every valid image.

Front matter, fenced and indented code, HTML blocks, inline code, and inline
math are masked before matching.

The separate `invalid-link-target` rule can report an image destination,
including the empty source in `![]()`. Fixing that destination to `![](TODO)`
exposes an alt warning on the next lint pass, so re-lint after Fix all and
review both the source and the alt text. See
[overlapping fixes](mdlint-autofix-guide.md#when-both-warnings-overlap).

## Reviewing the placeholder

The fix does not inspect the image or generate a description. The placeholder
is nonempty, so the warning disappears even though the image still needs
review:

<!-- example: review-before -->
```md
Revenue trend: ![](images/revenue.png?view=full#chart)
```

<!-- example: generated -->
```md
Revenue trend: ![TODO: describe image](images/revenue.png?view=full#chart)
```

<!-- example: reviewed -->
```md
Revenue trend: ![Revenue rose from $1 million in January to $2 million in June](images/revenue.png?view=full#chart)
```

The reviewed example assumes the reviewer has verified that the chart shows
this trend. The source, including its query and fragment, stays the same.

- [ ] Search for `TODO: describe image` after applying fixes. Check each match
  in context, including any that existed before the fix. Search for `TODO`
  destinations too; they need separate review.
- [ ] Open the actual image in the intended publishing context and read the
  surrounding text. Check that the source loads and points to the intended
  image. If the image or its purpose is unavailable, leave the placeholder for
  someone who can verify it; do not guess.
- [ ] Replace the placeholder with concise, accurate text conveying the image's
  purpose in this context. For a linked image or button, describe its action or
  destination. For a chart, give the relevant takeaway; put detailed data in
  nearby text or a table. Avoid repeating adjacent prose unnecessarily.
- [ ] Decide whether the image is purely decorative. Empty alt text can be
  appropriate in that case, although this rule will warn again. Handle the
  warning through the document's accessibility workflow instead of adding
  misleading filler text.
- [ ] Review the rendered document and remaining placeholders. A clean lint
  result does not establish that alt text is useful, the source works, or all
  images have been checked.

For purpose-based alt text and the other generated placeholders, see
[resolving generated placeholders](mdlint-placeholder-resolution.md#image-description).
