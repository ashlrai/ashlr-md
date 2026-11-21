# Mixed autofix cases: order review

> **Not in the app yet.** The **Fix** and **Fix all** suggestions toast this
> page describes is not mounted in Ashlr MD as of 0.7.5. The rules and fixes
> live in `src/lib/mdlint.ts`, and the examples here are what its tests assert.
> See [where the linter shows up today](./LINTER.md#where-it-shows-up-today).

These examples record the inputs and exact outputs asserted in
[mdlint-autofix.test.ts](../src/lib/mdlint-autofix.test.ts). They describe the listed test cases, not a
general ordering guarantee. A violation order, the order in which edits are applied, and the order in fix
history are separate observations; none of them is a contract for rule priority, reporting order, or fix
application order. Code blocks include a final newline.

The first sections show exact inputs and outputs. [Other tested cases](#other-tested-cases) lists further
mixed-rule tests without examples, and [Open questions](#open-questions) records what the tests leave
undecided.

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
order for this example; it does not by itself establish the order in which the edits run.

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

## Other tested cases

These mixed-rule cases in the same file have no example above. Each entry names the test exactly.

- <!-- case: keeps interleaved link and image fixes unchanged on a second pass with newline %j -->
  `keeps interleaved link and image fixes unchanged on a second pass with newline %j`:
  two links and two images are reported in their document order and repaired
  in one batch, with no findings on re-linting, for LF and CRLF.
- <!-- case: fixes trailing spaces and missing alt text in the same document -->
  `fixes trailing spaces and missing alt text in the same document`: a batch
  removes trailing spaces from one line and inserts image alt text on another.
  The test does not assert an ordering of the reported violations or edits.
- <!-- case: sequential rule passes produce the same result as applyAllFixes -->
  `sequential rule passes produce the same result as applyAllFixes`: despite
  the name, the assertions establish only that a batch and an image-then-link
  sequence each leave no violations for that input. They do not compare the
  resulting strings, or test the reverse sequence.
- <!-- case: does not change text or record another fix on a second pass for an invalid href -->
  `does not change text or record another fix on a second pass for an invalid href`:
  Fix all records link then trailing-space fixes, leaves an orphaned-heading
  warning, and adds no history on a second pass.

## Open questions

The assertions above do not answer these questions. They are prompts for a
proposed contract, not claims that a particular outcome is correct. Other test
files may cover narrower variants; for example,
[mdlint-autofix-order.test.ts](../src/lib/mdlint-autofix-order.test.ts)
checks both rule and violation orders for specific non-overlapping image and
link inputs.

1. For overlapping fixes, should the same edit win if the supplied violations
   or rule list are reversed? What should happen for equal ranges, partial
   overlaps, or three competing fixes?
2. Should batched fixes always match re-linted sequential passes in both rule
   orders, including when one fix exposes or changes another violation? If
   not, which result should callers expect?
3. When violations start at the same position, what should determine their
   report order and their priority for application? Should that depend on rule
   registration order or range length?
4. Should Fix all history describe every offered fix, only edits actually
   applied, or something else when fixes overlap? What should its order be
   when input violations are reordered?
5. Should callers repeat lint and fix automatically until no more fixes apply,
   and if so how should they detect cycles or decide when to stop while
   retaining unfixable warnings?
