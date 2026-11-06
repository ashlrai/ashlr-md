# Reviewing generated link destinations

The `invalid-link-target` rule warns on an empty or whitespace-only inline
destination, or one that is exactly `#` or `?`. **Fix** and **Fix all** replace
that destination with `TODO`; they cannot infer where the author meant to link.
The same fix can affect an image source. See the
[rule boundaries](mdlint-link-rule-boundaries.md) for matching limitations.

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

For example, this document's intended target is the “What is checked” section
of the neighboring rule-boundaries guide:

<!-- example: before -->
```md
Read [what the rule checks](#).
```

After applying the fix:

<!-- example: placeholder -->
```md
Read [what the rule checks](TODO).
```

After verifying the relative file and section:

<!-- example: resolved -->
```md
Read [what the rule checks](./mdlint-link-rule-boundaries.md#what-is-checked).
```

The linter also accepts `TODO` as a destination, so the warning disappears
before this review is complete. For image placeholders and overlapping fixes,
see [resolving placeholders](mdlint-placeholder-resolution.md).
