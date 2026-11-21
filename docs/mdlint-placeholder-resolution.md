# Resolving Markdown lint placeholders

> **Not in the app yet.** The **Fix** and **Fix all** suggestions toast this
> page describes is not mounted in Ashlr MD as of 0.7.5. The rules and fixes
> live in `src/lib/mdlint.ts`, and the examples here are what its tests assert.
> See [where the linter shows up today](./LINTER.md#where-it-shows-up-today).

**Fix** and **Fix all** can insert placeholders when the linter cannot know the
intended destination, image description, or document metadata. This guide lists
every placeholder, shows the exact text each fix inserts, and how to replace it.
The examples are **illustrative**: use the actual destination, image, and
metadata for your document. Search for `TODO` after fixing and review each
match in context; some matches may be unrelated author notes. A cleared warning
does not prove that a destination works or that alt text is meaningful.

## Placeholder inventory

The built-in link and image rules in [mdlint.ts](../src/lib/mdlint.ts) report
warnings. Linting alone does not change the document. **Fix** or **Fix all**
can insert these literal placeholders, which need an author's review:

| Rule | Trigger | Placeholder inserted by the fix |
| --- | --- | --- |
| `invalid-link-target` | An inline `[label](destination)` has an empty or whitespace-only destination, or the destination is exactly `#` or `?`. The same pattern also matches the link-shaped part of an inline image. | `TODO` replaces the destination. |
| `missing-alt-text` | An inline `![alt](source)` has empty or whitespace-only alt text and at least one character in the source parentheses. | `TODO: describe image` replaces the alt text. |
| `frontmatter-required` | A nonempty document does not begin with a frontmatter block: a `---` line closed by a later `---` or `...` line. | A block with an empty `title:` and `tags: []` is prepended. |

The link and image rules are enabled by default; `frontmatter-required` is off
until you turn it on in Settings → Linter rules. For example:

<!-- example: inventory before -->
```md
Read [draft]() and [section](#).
See ![  ](chart.png).
```

<!-- example: inventory after -->
```md
Read [draft](TODO) and [section](TODO).
See ![TODO: describe image](chart.png).
```

The comparisons for `#` and `?` are exact: ` # ` and ` ? ` are not flagged.
An empty image source, as in `![]()`, does not trigger `missing-alt-text`, but
its empty destination triggers `invalid-link-target`. A whitespace-only image
source has at least one character and can trigger both rules.

## Link destination

The `invalid-link-target` fix replaces an empty or whitespace-only destination,
`#`, or `?` with `TODO`, leaving the label and surrounding text intact. Find the
intended page, file, or section and replace `TODO` inside the parentheses. For
example, if the intended page is `installation.md` beside the current document:

<!-- example: link before -->
```md
Read the [installation guide]().
```

After the fix:

<!-- example: link placeholder -->
```md
Read the [installation guide](TODO).
```

After resolving it:

<!-- example: link resolved -->
```md
Read the [installation guide](./installation.md).
```

The rule does not check whether a nonempty destination exists, so open the link
where the document will be used and verify that the path, URL, or anchor reaches
the intended content. The same destination placeholder can appear in an image
source. Check relative paths and anchors as well as external URLs. If there is
no appropriate destination, revise the sentence or remove the link; if it is
unknown, leave the placeholder for an author who knows. Do not guess.

## Image description

For an image with empty or whitespace-only alt text and a nonempty source,
`missing-alt-text` keeps the source and inserts `TODO: describe image`. Look at
the image and replace the text between `![` and `]` with a concise description
of what it contributes in context. For example, if a chart shows this trend:

<!-- example: image before -->
```md
![](images/sales.png)
```

After the fix:

<!-- example: image placeholder -->
```md
![TODO: describe image](images/sales.png)
```

After resolving it:

<!-- example: image resolved -->
```md
![Sales doubled from January to June](images/sales.png)
```

The rule does not inspect the image or judge nonempty alt text, so the
placeholder clears the warning while telling a screen reader user nothing.
Someone who can see the image and knows its purpose should write the
replacement. Verify that the image loads, then choose text for its purpose:

- **Informative image:** describe the information or takeaway the reader needs,
  not the fact that an image exists. For a complex chart, put the key takeaway
  in the alt text and the detailed data in nearby prose or a table, and check
  the numbers against the image.
- **Functional image:** if the image is the only content of a link or control,
  describe the action or destination, such as `Search`, not its appearance.
- **Decorative image:** if it adds no information or function, empty alt text
  such as `![](ornament.png)` may be right so assistive technology skips it.
  This rule will warn again; handle that warning in your accessibility workflow
  rather than adding misleading filler.

The same image can need different text in different contexts. Avoid repeating
adjacent text, and do not assume a filename describes the image. A clean lint
result is not an accessibility review.

## Images with both placeholders

An image may need both a destination and a description. For `![]()`, the first
Fix all pass produces `![](TODO)`; after linting again, a second pass produces
`![TODO: describe image](TODO)`.

An image such as `![](?)` triggers both rules at once. In one **Fix all** pass
the wider image fix wins; lint again and fix the remaining destination warning:

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

Resolve both parts separately.

## Frontmatter fields

The `frontmatter-required` fix prepends a block with an empty `title:` and
`tags: []`. Fill in a title that identifies the document and add relevant tags
if your workflow uses them; an empty list is appropriate when there are none.
For example:

<!-- example: frontmatter before -->
```md
# Garden notes
```

After the fix:

<!-- example: frontmatter placeholder -->
```md
---
title:
tags: []
---

# Garden notes
```

After resolving it:

<!-- example: frontmatter resolved -->
```md
---
title: Garden notes
tags: [garden, planning]
---

# Garden notes
```

## Scope

The link and image rules use simple inline patterns rather than a full Markdown
parser; reference-style links and images are not checked. Front matter, fenced
and indented code, HTML blocks, inline code and inline math are masked from
these checks. See [link rule boundaries](mdlint-link-rule-boundaries.md) and
[image rule boundaries](mdlint-image-rule-boundaries.md) for matching limits,
and the [autofix guide](mdlint-autofix-guide.md) for overlapping fixes.
