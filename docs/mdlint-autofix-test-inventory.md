# mdlint autofix test inventory

Scope: `src/lib/mdlint-autofix.test.ts` alone: 161 `it`/`it.each` call sites
(242 test cases once `it.each` tables expand) in eight `describe` blocks.
Test names below are quoted verbatim; `%j` and `%s` are `it.each` placeholders
that expand to one case per table row. For what the fixes do, see the
[autofix guide](mdlint-autofix-guide.md).

The file exercises three autofix-bearing rules (`invalid-link-target`,
`missing-alt-text`, `no-trailing-spaces`), one detect-only rule
(`orphaned-heading`), the fix engine (`applyFix`, `applyAllFixes`), the
LinterToast "Fix all" path (`fixAllViolations`, lint history), and the
`settingsStore` linter configuration.

## Cases grouped by behavior

### Detection and reporting (no document change)

Linting flags violations and reports ranges without mutating the document.

- `orphaned-heading`: "flags a heading immediately followed by another
  heading", "flags multiple consecutive orphaned headings", "reports correct
  line number for the orphaned heading"; "does not flag the last heading if it
  has no successor".
- `invalid-link-target`: "flags a link with an empty href", "flags a link with
  a whitespace-only href", "flags a link with a lone # href", "flags a link
  with a lone ? href", "reports correct character range for the invalid link",
  "identifies the invalid link in the original input without changing its
  label", "reports invalid destination %j without applying its fix during
  linting".
- `missing-alt-text`: "flags an image with no alt text", "flags an image with
  whitespace-only alt text", "reports whitespace-only alt text without
  changing the document during linting", "does not flag images with non-empty
  alt text".

### Single-fix application and placeholder content

`applyFix`/`applyAllFixes` rewrite the destination or alt and nothing else.

- Links get a `TODO` destination: "autofix replaces invalid href with TODO
  placeholder", "autofixes a link on the final line without adding a trailing
  newline".
- Images get `TODO: describe image` alt text: "autofix inserts a TODO
  placeholder".
- No fix is offered where none applies: "has no autofix (user must add
  content or remove heading)" (orphaned-heading), "leaves a valid link
  unchanged and proposes no href fix during linting", "leaves a descriptive
  image unchanged and proposes no alt-text fix when linting".

### Preservation of surrounding content

Fixes leave neighboring Markdown, prose, line endings, and sources intact.

- Valid neighbors stay unchanged: "preserves a valid link and surrounding
  text while fixing links on both sides", "preserves a descriptive image with
  a relative source and its surrounding prose", "preserves a reference link
  and its definition while fixing neighboring links with %j line endings",
  "preserves a bracketed year in prose while fixing links on either side",
  "fixes a live invalid link while preserving a valid link and a matching code
  example".
- Labels and sources kept exactly: "preserves the full multiword label when
  fixing destination %j", "preserves punctuation in the link label when fixing
  destination %j", "autofixes missing alt text while preserving a relative
  image source exactly", "preserves the complete query string when fixing an
  empty image alt", "preserves an absolute image source and title when fixing
  whitespace-only alt text", "preserves an image destination and title %s
  across autofix passes".
- Line endings and document edges: "preserves surrounding text and CRLF line
  endings when fixing a later link", "preserves surrounding blank lines and
  the final newline when fixing a link", "preserves the document ending when
  fixing final destination %j", "preserves multiline surrounding prose and its
  original line endings".
- Unicode: "preserves a Unicode image source and surrounding prose when fixing
  empty alt text", "keeps each normalization form when empty-alt sources
  differ only by composition", "autofixes Unicode whitespace-only alt text
  without changing a Unicode source or CRLF".

### Multiple violations in one pass

Repeated and adjacent violations are each fixed independently.

- "autofixes two invalid links on one line without changing surrounding text",
  "autofixes adjacent invalid links without changing surrounding text", "fixes
  different invalid destinations with the same label independently", "fixes
  every invalid destination among repeated labels across paragraphs",
  "autofixes multiple images on one line without changing sources or prose",
  "gives each of several invalid images the placeholder while retaining its
  own source", "fixes each adjacent empty-alt image when their sources are
  identical".
- Order independence: "preserves intervening prose when fixing multiple links
  in either violation order", "fixes only the invalid destination %j
  regardless of link order", "fixes alt text %j next to a described image in
  either order".

### Idempotence (a second pass is a no-op)

- "is idempotent when autofixing a broken link", "is idempotent for an invalid
  link with all built-in rules enabled", "is idempotent when fixing multiple
  invalid destinations across lines", "is idempotent with default rules when
  an unfixed warning remains", "keeps the result unchanged on a second autofix
  pass for href %j", "keeps multiple empty-alt image fixes unchanged on a
  second default-rule pass", "keeps interleaved link and image fixes unchanged
  on a second pass with newline %j".

### Cross-rule application and excluded regions

- Batched fixes across rules: "applies fixes for two different rules in one
  applyAllFixes pass", "fixes trailing spaces and missing alt text in the same
  document", "fixes all four default-enabled rule violations in one pass",
  "sequential rule passes produce the same result as applyAllFixes".
- Fenced code left alone: "fixes identical links outside a %s fence while
  preserving the example", "preserves link and image examples inside a %s
  fence", "preserves link and image examples in an unclosed %s fence",
  "preserves examples after a shorter marker inside a %s fence".
- Nested constructs: "applies the image fix over the link fix nested inside it
  for destination %j, preserving the prose", "fixes an invalid link next to a
  valid image in either order (destination %j)".

### Fix all in the UI path (LinterToast history)

`fixAllViolations` applies every fix and records history entries.

- Recording: "Fix all repairs an invalid link and preserves a valid link",
  "LintHistoryEntry shape has expected fields", "getLintHistory returns an
  empty array initially", "clearLintHistory empties the log", "getLintHistory
  returns a readonly array".
- No history on no-ops or second passes: "Fix all leaves an empty document
  empty and records no history", "does not change text or record another fix
  on a second pass for an empty image alt", "does not change text or record
  another fix on a second pass for an invalid href".
- Offset safety: "Fix all applies every fix without corrupting later offsets".

### Linter configuration and registry invariants

- `settingsStore`: "starts with all rules enabled (empty disabledRules)",
  "toggleLinterRule disables an enabled rule", "toggleLinterRule re-enables a
  disabled rule", "toggleLinterRule can disable multiple rules independently",
  "setLinterConfig replaces the full config", "disabledRules from linterConfig
  are respected by lintDocument".
- `LINTER_DEFAULT_ENABLED_RULES`: "contains exactly the four required default
  rules", "all default rule IDs map to actual BUILTIN_RULES entries",
  "BUILTIN_RULES contains the three new rule IDs".

### Document edge cases

- Empty and whitespace-only documents: "lintDocument on an empty string
  produces no violations for new rules", "lints and autofixes an empty
  document to no findings and unchanged content", "lintDocument on
  whitespace-only doc produces no new-rule violations".
- Clean documents unchanged: "preserves a clean document through two autofix
  passes", "leaves clean Markdown unchanged with final newline %j", "preserves
  a valid CRLF document byte for byte with ending %j", "applyAllFixes on a doc
  with no fixable violations returns original".
- Rule overlap guards: "missing-alt-text does not flag a markdown link (only
  images)", "invalid-link-target does not flag image tags".
- Combined run: "all four default rules can run together on a messy document",
  "trailing-space fix handles multi-line doc correctly".

## What this file does not cover

- The other built-in rules (`frontmatter-required`, `max-heading-depth`,
  `no-bare-urls`, `wikilink-targets-exist`, `no-empty-headings`, `single-h1`,
  `no-consecutive-blank-lines`) have dedicated `describe("rule:<id>")` blocks
  in `src/lib/mdlint.test.ts`, not here.
- The file header comment mentions linterConfig "persist", but no case here
  exercises persisted storage (localStorage merge or migration); the six
  settingsStore cases cover in-memory state only.
- LinterToast rendering: the history helpers are tested directly, not through
  a mounted component.
- The sibling files below are outside this inventory's scope.

## Sibling autofix test files (not inventoried)

Focused satellites of this suite in `src/lib/`, grouped by theme. Each file's
`describe` titles match its scenario; notable ones are quoted.

- Document edges and endings: `mdlint-autofix-document-edges.test.ts`,
  `mdlint-autofix-empty-document.test.ts`, `mdlint-autofix-empty.test.ts`,
  `mdlint-autofix-final-newline.test.ts` ("invalid link autofix and final
  newlines", "batched autofixes and final newlines"),
  `mdlint-autofix-multiline.test.ts`, `mdlint-autofix-paragraphs.test.ts`
- Line endings and ordering: `mdlint-autofix-crlf.test.ts`,
  `mdlint-autofix-line-preservation.test.ts`, `mdlint-autofix-order.test.ts`
- Link scenarios: `mdlint-autofix-cases.test.ts` ("invalid link autofix
  regression cases", "Fix all at EOF", "additional autofix regression cases"),
  `mdlint-autofix-link-label.test.ts`,
  `mdlint-autofix-link-label-unicode.test.ts`,
  `mdlint-autofix-link-neighbor.test.ts`,
  `mdlint-autofix-link-whitespace.test.ts`,
  `mdlint-autofix-two-links.test.ts`
- Image scenarios: `mdlint-autofix-image-extension.test.ts`,
  `mdlint-autofix-image-query.test.ts`, `mdlint-autofix-image-source.test.ts`,
  `mdlint-autofix-mixed-images.test.ts`, `mdlint-autofix-two-images.test.ts`
- Prose context: `mdlint-autofix-bracket-prose.test.ts`,
  `mdlint-autofix-indented-text.test.ts`, `mdlint-autofix-inline-code.test.ts`,
  `mdlint-autofix-list-item.test.ts`, `mdlint-autofix-mixed-prose.test.ts`,
  `mdlint-autofix-repeated-text.test.ts`, `mdlint-autofix-unicode.test.ts`
- Miscellany: `mdlint-autofix-code-fence.test.ts`,
  `mdlint-autofix-idempotence.test.ts`, `mdlint-autofix-no-match.test.ts`,
  `mdlint-autofix-placeholder.test.ts`, `mdlint-autofix-valid-neighbor.test.ts`
