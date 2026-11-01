# Markdown lint placeholder inventory

The built-in link and image rules in [mdlint.ts](../src/lib/mdlint.ts) report
warnings. Linting alone does not change the document. **Fix** or **Fix all**
can insert these literal placeholders, which need an author's review:

| Rule | Trigger | Placeholder inserted by the fix |
| --- | --- | --- |
| `invalid-link-target` | An inline `[label](destination)` has an empty or whitespace-only destination, or the destination is exactly `#` or `?`. The same pattern also matches the link-shaped part of an inline image. | `TODO` replaces the destination. |
| `missing-alt-text` | An inline `![alt](source)` has empty or whitespace-only alt text and at least one character in the source parentheses. | `TODO: describe image` replaces the alt text. |

Both rules are enabled by default. For example:

<!-- example: before -->
```md
Read [draft]() and [section](#).
See ![  ](chart.png).
```

<!-- example: after -->
```md
Read [draft](TODO) and [section](TODO).
See ![TODO: describe image](chart.png).
```

Replace `TODO` with the intended URL or path, and replace `TODO: describe image`
with alternative text suited to the image's purpose. The placeholders clear
their respective warnings; the rules do not verify that a destination exists
or that nonempty alt text is useful. Empty alt text for a decorative image is
also flagged; see the [placeholder review guide](mdlint-placeholder-review.md).

The comparisons for `#` and `?` are exact: ` # ` and ` ? ` are not flagged.
An empty image source, as in `![]()`, does not trigger `missing-alt-text`, but
its empty destination triggers `invalid-link-target`. A whitespace-only image
source has at least one character and can trigger both rules.

## Overlapping fixes

An image such as `![](?)` triggers both rules. In one **Fix all** pass the
wider image fix wins; lint again and fix the remaining destination warning:

<!-- example: overlap before -->
```md
![](?)
```

<!-- example: overlap first -->
```md
![TODO: describe image](?)
```

<!-- example: overlap second -->
```md
![TODO: describe image](TODO)
```

The rules use simple inline patterns rather than a full Markdown parser;
reference-style links and images are not checked. Front matter, fenced and
indented code, HTML blocks, inline code and inline math are masked from these
checks. See [link rule boundaries](mdlint-link-rule-boundaries.md) and
[image rule boundaries](mdlint-image-rule-boundaries.md) for matching limits.
