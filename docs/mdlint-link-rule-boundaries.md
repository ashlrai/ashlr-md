# Invalid link target rule boundaries

The `invalid-link-target` rule is enabled by default and emits a warning for
each matched inline link whose destination is:

- empty (`[draft]()`);
- entirely whitespace, including spaces, tabs, or line breaks;
- exactly `#`; or
- exactly `?`.

The last two comparisons do not trim the destination. For example, ` # ` and
` ? ` are not flagged; neither are `#setup`, `?page=2`, or `TODO`. A nonempty
destination passing this rule is not necessarily valid, safe, present, or
reachable: the rule does not validate URLs or resolve paths.

Linting only reports warnings. **Fix** or **Fix all** replaces the destination
of each selected warning with the literal `TODO`, preserving its label and
surrounding text. Replace the placeholder with the intended destination.

<!-- example: before -->
```md
Read [draft]() and [notes](   ).
See [section](#), [search](?), and ![chart](?).
Keep [padded]( # ), [anchor](#setup), and [query](?page=2).
```

<!-- example: after -->
```md
Read [draft](TODO) and [notes](TODO).
See [section](TODO), [search](TODO), and ![chart](TODO).
Keep [padded]( # ), [anchor](#setup), and [query](?page=2).
```

## What is checked

The rule uses a simple pattern for `[label](destination)`, not a full Markdown
parser: the label ends at the first `]` and the destination at the first `)`.
It also matches the link-shaped portion of an image, as above. Reference-style
links and bare URLs are outside this rule. Front matter, fenced and indented
code, HTML blocks, inline code, and inline math are masked before matching;
matches that cross masked content are ignored.

When an image also triggers `missing-alt-text`, Fix all may require a second
pass. See the [autofix guide](mdlint-autofix-guide.md#when-both-warnings-overlap).
