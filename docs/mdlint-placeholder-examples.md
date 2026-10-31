# Markdown lint placeholder examples

The linter's **Fix** and **Fix all** actions insert placeholders for content
that needs an author's attention. These examples show the immediate autofix;
replace the placeholders before sharing the document.

## Broken link destination

`invalid-link-target` flags an empty destination (as well as whitespace-only
destinations, `#`, and `?`). It keeps the label and replaces the destination
with `TODO`.

Before:

<!-- example: link before -->
```md
Read the [setup instructions]().
```

After autofix:

<!-- example: link after -->
```md
Read the [setup instructions](TODO).
```

Replace `TODO` with the intended path or URL and check that it opens the right
page. The rule does not check whether a nonempty destination exists.

## Empty image alt text

`missing-alt-text` flags an inline image with empty or whitespace-only alt text
when its source is nonempty. It keeps the source and inserts a placeholder.

Before:

<!-- example: image before -->
```md
![  ](images/flow.png)
```

After autofix:

<!-- example: image after -->
```md
![TODO: describe image](images/flow.png)
```

Replace the placeholder with alt text that describes what the image contributes
in context. The rule does not assess the quality of nonempty alt text.

For a review workflow and guidance on decorative images, see the
[placeholder review guide](mdlint-placeholder-review.md). For rule scope and
overlapping image fixes, see the [autofix guide](mdlint-autofix-guide.md).
