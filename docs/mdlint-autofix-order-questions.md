# Mixed-rule autofix: ordering questions

This note inventories selected mixed-rule cases in
[mdlint-autofix.test.ts](../src/lib/mdlint-autofix.test.ts). The observations
are limited to the inputs and assertions in that file; they are not a general
contract for rule priority, reporting order, or fix application order. A
violation order, the order in which edits are applied, and the order in fix
history are separate observations. For exact before-and-after examples, see
[the order review](mdlint-autofix-order-review.md).

## Cases already tested

- <!-- case: preserves image and link order across adjacent lines with %j -->
  `preserves image and link order across adjacent lines with %j`: with the link
  rule listed first and the image on the preceding line, the reported IDs are
  image then link. Both fixes appear in the output for LF and CRLF; re-linting
  finds nothing and a second pass changes nothing.
- <!-- case: keeps interleaved link and image fixes unchanged on a second pass with newline %j -->
  `keeps interleaved link and image fixes unchanged on a second pass with newline %j`:
  two links and two images are reported in their document order and repaired
  in one batch, with no findings on re-linting, for LF and CRLF.
- <!-- case: fixes trailing spaces and missing alt text in the same document -->
  `fixes trailing spaces and missing alt text in the same document`: a batch
  removes trailing spaces from one line and inserts image alt text on another.
  The test does not assert an ordering of the reported violations or edits.
- <!-- case: keeps an empty-alt image fix unchanged on a second pass with a remaining warning -->
  `keeps an empty-alt image fix unchanged on a second pass with a remaining warning`:
  image and link fixes are present after one batch; only the unfixable
  orphaned-heading warning remains, and another pass leaves the text unchanged.
- <!-- case: applies the image fix over the link fix nested inside it for destination %j, preserving the prose -->
  `applies the image fix over the link fix nested inside it for destination %j, preserving the prose`:
  for `?`, `#`, and space-tab-space image destinations, the first batch fixes
  the alt but retains the destination. Re-linting finds the invalid target;
  a second batch changes it to `TODO` and leaves no violations.
- <!-- case: sequential rule passes produce the same result as applyAllFixes -->
  `sequential rule passes produce the same result as applyAllFixes`: despite
  the name, the assertions establish only that a batch and an image-then-link
  sequence each leave no violations for that input. They do not compare the
  resulting strings, or test the reverse sequence.
- <!-- case: Fix all applies every fix without corrupting later offsets -->
  `Fix all applies every fix without corrupting later offsets`: an image fix
  before a link fix produces both expected replacements; history records
  image then link. This does not by itself establish the order of edit execution.
- <!-- case: does not change text or record another fix on a second pass for an invalid href -->
  `does not change text or record another fix on a second pass for an invalid href`:
  Fix all records link then trailing-space fixes, leaves an orphaned-heading
  warning, and adds no history on a second pass.

## Questions for future tests or design decisions

These questions are not answered by the assertions above. They are prompts
for a proposed contract, not claims that a particular outcome is correct.
Other test files may cover narrower variants; for example,
[mdlint-autofix-order.test.ts](../src/lib/mdlint-autofix-order.test.ts)
checks both rule and violation orders for specific non-overlapping image/link
inputs.

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
