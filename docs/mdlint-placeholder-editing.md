# Editing generated lint placeholders

The linter's **Fix** and **Fix all** actions can insert content for you to
complete. The examples below are **illustrative**: use the actual destination,
image, and metadata for your document. A cleared warning does not establish that
a link works or that a description is accurate.

## Link or image destination

`invalid-link-target` replaces an empty or whitespace-only destination, `#`, or
`?` with `TODO`, leaving the label and surrounding text intact. Find the intended
page, file, section, or image and replace `TODO` inside the parentheses. For
example, if the intended page is `setup.md`:

<!-- example: link before -->
```md
Read [setup]().
```

<!-- example: link placeholder -->
```md
Read [setup](TODO).
```

<!-- example: link edited -->
```md
Read [setup](./setup.md).
```

Open the destination in the context where the document will be used; check
relative paths and anchors as well as URLs. If the intended target is unknown,
leave it for the author to resolve instead of guessing. An image source can
receive the same `TODO` destination and needs the same review.

## Image description

`missing-alt-text` replaces empty or whitespace-only alt text with
`TODO: describe image` when the image source is nonempty. Look at the image and
replace the text between `![` and `]` with a concise description of what it
contributes in context. For example, if the image shows this trend:

<!-- example: image before -->
```md
![](images/sales.png)
```

<!-- example: image placeholder -->
```md
![TODO: describe image](images/sales.png)
```

<!-- example: image edited -->
```md
![Sales doubled from January to June](images/sales.png)
```

Check that the image loads and that the description conveys the relevant
information. Put detailed data for a complex image in nearby text or a table.
For a decorative image, empty alt text may be appropriate, though this rule will
flag it; handle that warning in your accessibility workflow.

An image can need both edits. For `![]()`, Fix all first produces `![](TODO)`;
after linting again, a second pass produces `![TODO: describe image](TODO)`.
Replace both the destination and the description independently. Search for
`TODO` after fixing and review every match, including any unrelated author notes.

## Frontmatter fields

The `frontmatter-required` fix prepends a block with an empty `title:` and
`tags: []`. Fill in a title that identifies the document and add relevant tags
if your workflow uses them; an empty list is appropriate when there are none.
For example:

<!-- example: frontmatter before -->
```md
# Garden notes
```

<!-- example: frontmatter placeholder -->
```md
---
title:
tags: []
---

# Garden notes
```

<!-- example: frontmatter edited -->
```md
---
title: Garden notes
tags: [garden, planning]
---

# Garden notes
```

See the [autofix guide](mdlint-autofix-guide.md) for rule scope and overlapping
fixes, and the [placeholder review guide](mdlint-placeholder-review.md) for a
review workflow.
