# Placeholder follow-up after Markdown lint fixes

The linter's **Fix** and **Fix all** actions write placeholders where only an
author can supply the intended content. Two forms are generated: `TODO` as a
link or image destination (the `invalid-link-target` fix) and
`TODO: describe image` as image alt text (the `missing-alt-text` fix). Each is
a marker, not a correction: the warning clears because the placeholder is
nonempty, and a reader must replace exactly the placeholder text. Search the
document for `TODO` after fixing and review each match in context; some matches
may be unrelated author notes.

## Replace a TODO destination

`invalid-link-target` replaces an empty or whitespace-only destination, `#`, or
`?` with `TODO`. The fix keeps the label between the brackets and the
surrounding text, so replace only the `TODO` inside the parentheses with the
intended path, URL, or anchor. For example:

<!-- example: link before -->
```md
See the [release notes]().
```

After the fix:

<!-- example: link placeholder -->
```md
See the [release notes](TODO).
```

After replacing `TODO` with the destination:

<!-- example: link replaced -->
```md
See the [release notes](./release-notes.md).
```

Open the destination where the document will be used and check that it reaches
the intended page or section. An image source can hold the same placeholder:
`![](TODO)` needs its `TODO` replaced with the image file, and an image that
also lacks alt text gains `TODO: describe image` on a later fix pass. See
[resolving generated placeholders](mdlint-placeholder-resolution.md) for that
two-pass case.

## Replace a TODO alt text

`missing-alt-text` inserts `TODO: describe image` when an inline image's alt
text is empty or whitespace-only and its source is nonempty. Replace only the
text between `![` and `]` with a concise description of what the image
contributes in context; the source inside the parentheses stays. For example:

<!-- example: image before -->
```md
![](images/architecture.png)
```

After the fix:

<!-- example: image placeholder -->
```md
![TODO: describe image](images/architecture.png)
```

After replacing the placeholder with the description:

<!-- example: image replaced -->
```md
![Diagram of the sync engine's three layers](images/architecture.png)
```

The description should convey the information the reader needs, not the fact
that an image exists. For help choosing it, see the
[accessibility guide](mdlint-placeholder-accessibility.md); for the wider
review pass over every generated placeholder, see the
[placeholder review guide](mdlint-placeholder-review.md).
