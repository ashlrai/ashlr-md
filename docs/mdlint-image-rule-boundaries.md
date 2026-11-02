# Image alt-text rule boundaries

The `missing-alt-text` rule reports a **warning** when an inline image-shaped
match has an empty alt field (`![](chart.png)`) or one containing only
whitespace (`![  ](chart.png)`). Tabs and other JavaScript whitespace count
as whitespace. The rule is enabled by default in Settings → Linter rules.
It does not assess whether nonempty alt text is descriptive or whether the
image source exists.

Linting leaves the document unchanged. **Fix** and **Fix all** replace the
empty alt field with the literal placeholder `TODO: describe image`, retaining
the matched source and surrounding text:

<!-- example: before -->
```md
See ![](chart.png?view=full#data) and ![  ](map.png "Map").
```

<!-- example: after -->
```md
See ![TODO: describe image](chart.png?view=full#data) and ![TODO: describe image](map.png "Map").
```

Replace each placeholder with an appropriate description. The placeholder is
nonempty, so it clears this warning even before it has been reviewed. Empty
alt text can be intentional for a decorative image, but this rule still warns;
see the [placeholder review guide](mdlint-placeholder-review.md).

## Matching limits

The rule uses a pattern, not a full Markdown parser. It matches `![alt](source)`
with at least one character in the source, and stops the match at the first
`)`. It does not validate the source: even a whitespace-only source can match.
Consequently:

| Input | `missing-alt-text` result |
| --- | --- |
| `![](image.png)` or `![ ](image.png)` | Warning |
| `![]( )` | Warning |
| `![]()` | No match: source is empty |
| `![description](image.png)` | No warning: alt is nonempty |
| `![][image]` or `![ ]` | No match: reference or shortcut syntax |

The first closing parenthesis also ends the source used by the fix. For
example, `![](plot(1).png)` is fixed to
`![TODO: describe image](plot(1).png)`: the remaining `.png)` is outside
the match. Escaped or nested delimiters are not parsed as Markdown structure,
so do not rely on this rule to recognize every valid image.

Front matter, fenced and indented code, HTML blocks, inline code, and inline
math are masked before matching. The separate `invalid-link-target` rule can
also report an image destination, including the empty source in `![]()`.
When image and destination fixes overlap, Fix all may need a second lint pass;
see [overlapping fixes](mdlint-autofix-guide.md#when-both-warnings-overlap).
