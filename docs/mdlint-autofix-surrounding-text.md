# Surrounding text in Markdown autofixes

The linter's link and image fixes preserve the prose around the Markdown being
fixed. These examples mirror cases in `src/lib/mdlint-autofix.test.ts`. Use
**Fix** on a suggestion, or **Fix all** to apply available fixes.

## Link destination

`invalid-link-target` replaces an invalid destination with `TODO`, keeping the
link label and the text before and after it.

Before:

<!-- example: link before -->
```md
Before [link](#) after.
```

After:

<!-- example: link after -->
```md
Before [link](TODO) after.
```

Replace `TODO` with the intended URL or path.

## Image alternative text

`missing-alt-text` replaces empty alternative text with a placeholder, keeping
the image source and the text before and after it.

Before:

<!-- example: image before -->
```md
Before ![](img.png) after.
```

After:

<!-- example: image after -->
```md
Before ![TODO: describe image](img.png) after.
```

Replace the placeholder with suitable alternative text. Neither placeholder
is a finished destination or description. For rule scope and more examples,
see the [autofix guide](mdlint-autofix-guide.md).
