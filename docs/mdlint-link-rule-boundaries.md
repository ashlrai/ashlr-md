# Invalid link targets: rule boundaries and review

> **Not in the app yet.** The **Fix** and **Fix all** suggestions toast this
> page describes is not mounted in Ashlr MD as of 0.7.5. The rules and fixes
> live in `src/lib/mdlint.ts`, and the examples here are what its tests assert.
> See [where the linter shows up today](./LINTER.md#where-it-shows-up-today).

The `invalid-link-target` rule is enabled by default and emits a warning for
each matched inline link whose destination is:

- empty (`[draft]()`);
- entirely whitespace, including spaces, tabs, or line breaks;
- exactly `#`; or
- exactly `?`.

The last two comparisons do not trim the destination. For example, ` # ` and
` ? ` are not flagged; neither are `#setup`, `?page=2`, `./guide.md`, or
`TODO`. A nonempty destination passing this rule is not necessarily valid,
safe, present, or reachable: the rule does not validate URLs or resolve paths.

Linting only reports warnings. **Fix** or **Fix all** replaces the destination
of each selected warning with the literal `TODO`, preserving its label and
surrounding text. The fix cannot infer where the author meant to link, so
replace every placeholder with the intended destination; `TODO` silences this
warning but is not a verified destination.

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

## Reviewer checklist

- [ ] Search the document for `TODO` after fixing and inspect each match in
  context. Some may be author notes or image descriptions, not link targets.
- [ ] Establish the intended page, file, or section from the surrounding text
  or the author. If it is unclear, leave the placeholder for the author or
  revise the sentence; do not guess a destination.
- [ ] Replace only `TODO` inside the parentheses with the intended destination.
  Keep the label and surrounding text unless they also need correction. For an
  image, check its source and its alt text separately.
- [ ] For a relative path, resolve it from the document's location and check
  that the file exists in the published context. For an anchor, confirm the
  target heading or element exists and the fragment works in that renderer.
- [ ] For an external URL, check the scheme and domain, then open it in the
  intended environment and confirm it reaches the right content. Do not put
  credentials or private access tokens in the destination.
- [ ] Preview and follow the finished link where the document will be used;
  confirm the label describes the destination and the reader can access it.
  Re-run the linter and review any remaining warnings, but do not treat a clean
  lint result as proof that the destination exists, is safe, or is reachable.

For example, the intended target of this link is the "What is checked" section
above:

<!-- example: review-before -->
```md
Read [what the rule checks](#).
```

After applying the fix:

<!-- example: review-placeholder -->
```md
Read [what the rule checks](TODO).
```

After confirming the section exists:

<!-- example: review-resolved -->
```md
Read [what the rule checks](#what-is-checked).
```

For image placeholders and overlapping fixes, see
[resolving placeholders](mdlint-placeholder-resolution.md).
