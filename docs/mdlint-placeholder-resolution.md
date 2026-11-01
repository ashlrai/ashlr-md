# Resolving Markdown lint placeholders

**Fix** and **Fix all** can insert placeholders when the linter cannot know the
intended destination or image description. Search for `TODO` after fixing and
review each match in context; some matches may be unrelated author notes. A
cleared warning does not prove that a destination works or that alt text is
meaningful.

## Link destination

The `invalid-link-target` fix replaces an empty or whitespace-only destination,
`#`, or `?` with `TODO`. Find the intended page, file, or section and replace
`TODO` inside the parentheses, keeping the link label. For example, if the
intended page is `installation.md` beside the current document:

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

Open the link where the document will be used and verify that the path, URL, or
anchor reaches the intended content. The same destination placeholder can appear
in an image source. If the destination is unknown, leave it for an author to
resolve or revise the sentence; do not guess.

## Image description

For an image with empty or whitespace-only alt text and a nonempty source,
`missing-alt-text` inserts `TODO: describe image`. Look at the image and replace
the text between `![` and `]` with a concise description of what it contributes
in context. For example, if a chart shows this trend:

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

Verify that the image loads and that the description matches it. Put detailed
data for a complex chart in nearby text or a table. A purely decorative image may
appropriately have empty alt text, though this rule flags it; handle that warning
in your accessibility workflow rather than adding misleading filler.

An image may need both a destination and a description. For `![]()`, the first
Fix all pass produces `![](TODO)`; after linting again, a second pass produces
`![TODO: describe image](TODO)`. Resolve both parts separately. See the
[autofix guide](mdlint-autofix-guide.md) for rule scope and overlapping fixes.
