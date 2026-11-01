# Reviewing image alt text for accessibility

The `missing-alt-text` rule warns when an inline Markdown image has empty or
whitespace-only alt text and a nonempty source. **Fix** and **Fix all** insert
the literal placeholder `TODO: describe image`; linting alone changes nothing.

<!-- example: before -->
```md
![](images/revenue.png)
```

After the fix:

<!-- example: placeholder -->
```md
![TODO: describe image](images/revenue.png)
```

The warning disappears because the alt text is now nonempty. That does not make
the image accessible: the placeholder tells a screen reader user nothing about
the image's purpose. The rule does not inspect the image, understand its context,
or judge the quality of nonempty alt text. A person who can assess the image and
its purpose must review it; if the meaning is unknown, leave the TODO for someone
who can determine it rather than inventing a description.

## Choose text for the image's purpose

Search for `TODO: describe image` after fixing and review each match in its
surrounding document. Open the image and check that its source loads. Replace
only the text between `![` and `]` with a concise alternative that conveys what
the reader needs in that context:

- **Informative image:** describe its relevant information or takeaway. For a
  complex chart, include the key takeaway and provide the detailed data in
  nearby prose or a table. Verify the numbers against the image.
- **Functional image:** if the image is the only content of a link or control,
  describe the action or destination, such as `Search`, instead of its appearance.
- **Decorative image:** if it adds no information or function, empty alt text
  (`![](ornament.png)`) may be appropriate so assistive technology can ignore it.
  This rule will warn again; handle the warning in the document's accessibility
  workflow instead of inserting meaningless text just to silence it.

If the example chart shows this trend, an appropriate replacement could be:

<!-- example: reviewed -->
```md
![Revenue rose from $1 million in January to $2 million in June](images/revenue.png)
```

The same image can need different alternatives in different contexts. Avoid
repeating adjacent text unnecessarily, and do not assume a filename describes the
image. A clean lint result is not an accessibility review.

The rule uses a pattern for inline images, not a complete Markdown parser. It
does not match an empty source like `![]()` or reference-style images, and it
excludes front matter, code, HTML blocks and inline math. See the
[autofix guide](mdlint-autofix-guide.md) for scope and overlapping destination
fixes, and the [placeholder review guide](mdlint-placeholder-review.md) for
reviewing generated link destinations.
