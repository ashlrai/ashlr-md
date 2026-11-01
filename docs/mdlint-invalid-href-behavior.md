# Invalid link destination behavior

The `invalid-link-target` rule reports a warning for an inline Markdown
`[label](destination)` when the destination is:

- empty, as in `[draft]()`;
- entirely whitespace, including spaces, tabs, or line breaks;
- exactly `#`; or
- exactly `?`.

The comparison with `#` and `?` is literal: `[section]( # )` and
`[search]( ? )` are not flagged. Neither are other nonempty destinations,
such as `#setup`, `?page=2`, or `./guide.md`. This rule does not check
whether a destination is a valid URL, exists, or can be reached.

Linting does not edit the document. **Fix** or **Fix all** replaces only the
flagged destination with the literal placeholder `TODO`, preserving the label
and surrounding text. Replace every placeholder with the intended URL or
path; `TODO` silences this warning but is not a verified destination.

Before:

<!-- example: before -->
```md
Read [draft]() and [notes](   ).
See [section](#), [search](?), and [setup](#setup).
```

After Fix all:

<!-- example: after -->
```md
Read [draft](TODO) and [notes](TODO).
See [section](TODO), [search](TODO), and [setup](#setup).
```

The rule uses a simple inline-link pattern, not a full Markdown parser. It
also matches the link-shaped part of an image: `![chart](?)` becomes
`![chart](TODO)`. Reference-style links are not checked. Front matter, fenced
and indented code, HTML blocks, inline code, and inline math are masked from
this rule. For overlapping image warnings and their fixes, see the
[autofix guide](mdlint-autofix-guide.md#when-both-warnings-overlap).
