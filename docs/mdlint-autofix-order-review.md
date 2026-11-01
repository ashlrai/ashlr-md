# Mixed autofix cases: order review

These examples record the inputs and exact outputs asserted in
[mdlint-autofix.test.ts](../src/lib/mdlint-autofix.test.ts). They describe the listed test cases, not a
general ordering guarantee. Code blocks include a final newline.

## Image and link on adjacent lines

In “preserves image and link order across adjacent lines”, the link rule is listed first, but the reported
violations are `missing-alt-text` then `invalid-link-target`. `applyAllFixes` produces the following result,
and a second pass has no remaining violations. The test covers both LF and CRLF line endings; the blocks below
use LF.

Input:

<!-- example: adjacent input -->
```md
![](diagram.png)
[docs]()
```

After one pass:

<!-- example: adjacent output -->
```md
![TODO: describe image](diagram.png)
[docs](TODO)
```

## Overlapping image and link fixes

In “applies the image fix over the link fix nested inside it”, both violations have fixes. For the `?`
destination, `applyAllFixes` produces the first output below; re-linting reports `invalid-link-target`, and a
second pass produces the second output. The same test also covers `#` and a space-tab-space destination,
retaining the original destination on the first pass and replacing it with `TODO` on the second.

Input:

<!-- example: overlap input -->
```md
![](?) is a diagram.

Closing prose with [a link](./report.md) stays.
```

After one pass:

<!-- example: overlap first -->
```md
![TODO: describe image](?) is a diagram.

Closing prose with [a link](./report.md) stays.
```

After re-linting and a second pass:

<!-- example: overlap second -->
```md
![TODO: describe image](TODO) is a diagram.

Closing prose with [a link](./report.md) stays.
```

## Mixed fixes with a remaining warning

In “keeps an empty-alt image fix unchanged on a second pass with a remaining warning”, `applyAllFixes`
produces the output below. Re-linting reports only `orphaned-heading`, which has no fix in this case; a second
pass leaves the output unchanged.

Input:

<!-- example: warning input -->
```md
# First

## Second

See ![](chart.png) and [draft]().
```

After one pass:

<!-- example: warning output -->
```md
# First

## Second

See ![TODO: describe image](chart.png) and [draft](TODO).
```

## Fix all and offsets

In “Fix all applies every fix without corrupting later offsets”, `fixAllViolations` produces the output below
and records `missing-alt-text` then `invalid-link-target` in the fix history. This is the asserted history
order for this example.

Input:

<!-- example: fix-all input -->
```md
See ![](a.png) and [link]().
```

After Fix all:

<!-- example: fix-all output -->
```md
See ![TODO: describe image](a.png) and [link](TODO).
```
