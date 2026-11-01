# Markdown lint fix output reference

Linting reports warnings without changing the document. **Fix** applies one
available fix; **Fix all** applies available fixes in a pass. Both placeholders
below need an author's review even though they clear their respective warnings.

## Invalid destination

[`invalid-link-target`](../src/lib/mdlint.ts#L576) flags an inline link whose
destination is empty, whitespace-only, exactly `#`, or exactly `?`. Its fix
replaces the destination with the literal `TODO`, keeping the label and
surrounding text:

<!-- example: link input -->
```md
Read [setup]() and [search](?).
```

<!-- example: link output -->
```md
Read [setup](TODO) and [search](TODO).
```

Replace `TODO` with the intended path or URL. The rule does not check whether
a nonempty destination exists. It can also match an image's destination.

## Empty image alt text

[`missing-alt-text`](../src/lib/mdlint.ts#L615) flags an inline image with
empty or whitespace-only alt text when its source has at least one character.
Its fix inserts the literal `TODO: describe image` and preserves the source:

<!-- example: image input -->
```md
See ![  ](chart.png?view=full#data).
```

<!-- example: image output -->
```md
See ![TODO: describe image](chart.png?view=full#data).
```

Replace the placeholder with meaningful alt text for the image in context.
The rule does not judge the quality of nonempty alt text.

## Overlapping fixes

For an image with empty alt text and a destination of `?`, both rules warn.
In one Fix all pass, the wider image fix takes precedence; after linting again,
a second pass fixes the destination (see [`applyAllFixes`](../src/lib/mdlint.ts#L719)).

<!-- example: overlap input -->
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

These rules use patterns for inline Markdown, not a full Markdown parser. For
scope and other edge cases, see the [autofix guide](mdlint-autofix-guide.md).
