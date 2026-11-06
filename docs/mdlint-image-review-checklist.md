# Review checklist for generated image alt text

The `missing-alt-text` rule warns about an inline image with empty or
whitespace-only alt text and a nonempty source. **Fix** or **Fix all** inserts
the literal placeholder `TODO: describe image`; it does not inspect the image or
generate a description. The placeholder is nonempty, so the warning disappears
even though the image still needs review.

<!-- example: before -->
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

The final example assumes the reviewer has verified that the chart shows this
trend. The source, including its query and fragment, stays the same.

## Checklist

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

The rule uses a pattern for inline images, not a complete Markdown parser. It
does not check reference-style images or images in masked regions such as code,
front matter, HTML blocks, or inline math. An empty source (`![]()`) is not
matched by this rule; `invalid-link-target` can flag it separately. Fixing the
destination can expose an alt warning on a later lint pass. An image can also
have both warnings at once, so re-lint after Fix all and review both the source
and alt text. See [image rule boundaries](mdlint-image-rule-boundaries.md) and
[overlapping fixes](mdlint-autofix-guide.md#when-both-warnings-overlap).
