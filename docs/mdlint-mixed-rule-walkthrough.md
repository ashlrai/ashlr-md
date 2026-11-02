# Mixed link and image fix walkthrough

This walks through one parameterized case in
[mdlint-autofix.test.ts](../src/lib/mdlint-autofix.test.ts): “fixes an invalid
link beside an image missing alt text”. It runs with `ruleInvalidLinkTarget`
and `ruleMissingAltText`, once with the link first and once with the image
first (`imageFirst` is `false` or `true`).

## Input (link first)

The document uses CRLF line endings, two trailing spaces, and a non-ASCII
character:

```md
Before café: [draft](?)![](images/chart.png?view=full#data)  after.
```

Two things are wrong:

- `[draft](?)` has no usable destination, so `invalid-link-target` reports it.
- `![](…)` has empty alt text, so `missing-alt-text` reports it.

Both violations carry a fix. The test asserts that exactly these two rule ids
are reported and that neither fix is `null`.

## Expected output

```md
Before café: [draft](TODO)![TODO: describe image](images/chart.png?view=full#data)  after.
```

- The link destination `?` becomes `TODO`; the link text `draft` is kept.
- The empty alt text becomes `TODO: describe image`; the image path, query
  (`?view=full`) and fragment (`#data`) are untouched.
- `café`, the two trailing spaces, and the final CRLF are unchanged. The fixes
  only touch their own ranges, so the adjacent link and image do not disturb
  each other.

## Image first

With `imageFirst: true` the order swaps (`![](…)[draft](?)`) and the same two
fixes apply. The expected output is the repaired image followed by the
repaired link.

## What the test checks

1. `lintDocument` reports `invalid-link-target` and `missing-alt-text`
   (sorted, since report order is not part of the contract).
2. Every violation has a non-null `fix`.
3. `applyAllFixes` returns exactly the expected text above.
4. Linting the result again returns `[]`, so one pass is enough.

`TODO` is a placeholder, not finished content. Replace it with the real
destination and a meaningful description. A clean lint does not mean either
is done. For a simpler example see
[mdlint-combined-fix-example.md](mdlint-combined-fix-example.md); for rule
scope and overlapping fixes see
[mdlint-autofix-guide.md](mdlint-autofix-guide.md).
