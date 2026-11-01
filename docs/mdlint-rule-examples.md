# Markdown lint rule examples

These examples show the warnings and autofixes for two rules enabled by default
in Settings → Linter rules. Use **Fix** on an individual suggestion or **Fix all**
to apply available fixes.

## Invalid link target

`invalid-link-target` warns when an inline link destination is empty,
whitespace-only, `#`, or `?`. The fix preserves the label and replaces the
destination with `TODO`.

Before:

<!-- example: link before -->
```md
Read the [installation guide](?).
```

After autofix:

<!-- example: link after -->
```md
Read the [installation guide](TODO).
```

Replace `TODO` with the intended URL or path. The rule does not check whether a destination exists or can be reached.

## Missing image alt text

`missing-alt-text` warns when an inline image has empty or whitespace-only alt
text and a nonempty source. The fix preserves the source and inserts a
placeholder description.

Before:

<!-- example: image before -->
```md
![](architecture.png)
```

After autofix:

<!-- example: image after -->
```md
![TODO: describe image](architecture.png)
```

Replace the placeholder with meaningful alternative text. The rule does not
judge the quality of a nonempty description.

For more examples, excluded Markdown regions, and images that trigger both
rules, see the [autofix guide](mdlint-autofix-guide.md).
For the exact destination comparisons, see
[invalid link destination behavior](mdlint-invalid-href-behavior.md).
