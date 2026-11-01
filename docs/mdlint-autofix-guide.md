# Markdown link and image autofixes

The linter reports warnings for certain inline Markdown links and images. In the linter suggestions,
use **Fix** for one warning or **Fix all** for the available fixes. The two rules below are enabled
by default and can be managed in Settings → Linter rules. Linting itself does not change the document.

Replace each `TODO` destination with the intended URL or path, and replace `TODO: describe image`
with appropriate alternative text. These placeholders silence the warning but do not verify the
destination or describe the image.
See [editing generated placeholders](mdlint-placeholder-editing.md) for replacement examples,
and the [placeholder review guide](mdlint-placeholder-review.md) for a workflow
and examples of replacing them with reviewed content, or the
[placeholder examples](mdlint-placeholder-examples.md) for the immediate fixes.
For focused before-and-after examples, see
[surrounding text in autofixes](mdlint-autofix-surrounding-text.md).

## Invalid link targets

`invalid-link-target` flags an inline `[label](destination)` when the
destination is empty, contains only whitespace, or is exactly `#` or `?`.
The fix replaces the destination with `TODO` and keeps the label and
surrounding text.

Input:

<!-- example: links input -->
```md
Read [draft]() and [notes](   ).
See [section](#) and [search](?).
Keep [guide](./guide.md#setup).
```

After Fix all:

<!-- example: links output -->
```md
Read [draft](TODO) and [notes](TODO).
See [section](TODO) and [search](TODO).
Keep [guide](./guide.md#setup).
```

This is a syntactic check, not a link checker: other destinations, including
`#setup`, are not tested for existence or reachability. The rule also matches
the link-shaped portion of an image, so it can flag an image destination such
as `![chart](?)`.

## Missing image alt text

`missing-alt-text` flags inline images with empty or whitespace-only alt text
when there is at least one character between the source parentheses. The fix
replaces the alt text and preserves the source, including a query, fragment or
title. A nonempty alt is not checked for quality.

Input:

<!-- example: images input -->
```md
See ![](chart.png?view=full#data) and ![  ](map.png "Map").
Keep ![A diagram](diagram.png).
```

After Fix all:

<!-- example: images output -->
```md
See ![TODO: describe image](chart.png?view=full#data) and ![TODO: describe image](map.png "Map").
Keep ![A diagram](diagram.png).
```

An image with an empty source, such as `![]()`, is not matched by the alt
rule, although its destination is flagged by `invalid-link-target`. Neither
rule determines whether an image is decorative or its source exists.

## When both warnings overlap

An image with empty alt text and a destination of `?` or `#` triggers both
rules. In a single Fix all pass, the wider image fix takes precedence over the
overlapping destination fix. After the linter runs again, fix the remaining
destination warning in a second pass.

Input:

<!-- example: overlap input -->
```md
![](?)
```

After the first Fix all:

<!-- example: overlap first -->
```md
![TODO: describe image](?)
```

After the second Fix all:

<!-- example: overlap second -->
```md
![TODO: describe image](TODO)
```

## Scope

These rules use simple patterns for inline Markdown syntax, not a complete
Markdown parser. They do not check reference-style links or images. Front matter,
fenced and indented code, HTML blocks, inline code and inline math are masked
from these checks. `wikilink-targets-exist` is a separate rule and cannot
automatically create a missing file.

## Bare URLs

The separate `no-bare-urls` rule flags matching `http://` and `https://` URLs
in prose and offers a fix that uses the URL as both label and destination:

<!-- example: urls input -->
```md
Visit https://example.com/guide
```

<!-- example: urls output -->
```md
Visit [https://example.com/guide](https://example.com/guide)
```

This rule uses a URL pattern rather than checking reachability; review the
result, especially around punctuation. It is surfaced as an editor diagnostic,
not among the four rules in the linter suggestions toast. It uses the same
masked regions described above.
