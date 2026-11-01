# Empty image alt text in Markdown lint

The `missing-alt-text` rule warns about an inline image when the text between
`![` and `]` is empty or consists only of whitespace, and there is at least one
character between the source parentheses. It is enabled by default in Settings
→ Linter rules. Linting reports the warning without changing the document.

Use **Fix** or **Fix all** to replace the empty alt text with the literal
placeholder `TODO: describe image`. The image source and surrounding text are
preserved. For example:

<!-- example: before -->
```md
See ![](chart.png?view=full#data) and ![  ](map.png "Map").
```

<!-- example: after -->
```md
See ![TODO: describe image](chart.png?view=full#data) and ![TODO: describe image](map.png "Map").
```

Replace each placeholder with a description of what the image contributes in
context. The placeholder clears the warning, but the rule does not judge whether
nonempty alt text is useful or whether the image source exists. Empty alt text
can be appropriate for a decorative image, although this rule will still flag
it; see the [placeholder review guide](mdlint-placeholder-review.md) for how to
review that case.

The rule uses a pattern for inline images, rather than a complete Markdown
parser. An empty source such as `![]()` does not match this rule; the separate
`invalid-link-target` rule can flag the destination. Reference-style images are
not checked. Front matter, fenced and indented code, HTML blocks, inline code,
and inline math are excluded. For overlapping warnings and Fix all behavior,
see the [autofix guide](mdlint-autofix-guide.md).
For matching examples and delimiter limits, see the
[image rule boundaries](mdlint-image-rule-boundaries.md).
