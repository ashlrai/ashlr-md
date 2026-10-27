# Incremental Markdown rendering

Run from the repository root with installed dependencies:

```sh
HOME=$(mktemp -d) bun run bench:render
```

The deterministic fixture has exactly 10,000 lines, 500 headings, paragraphs
with inline formatting, nested lists, 1,000 task checkboxes, 500 tables and
500 fenced text blocks. It makes no network requests. Each edit replaces prose
at a different location, undoing the preceding edit as well. These are actual
content changes, rather than repeated renders of an identical string.

Two tests measure separate stages:

- Incremental block parsing, sanitized HAST and React element construction.
  Also checks that no more than four chunks are reparsed per edit.
- The application's real `Renderer`, including document classification,
  context updates, React reconciliation, effects and DOM commit in happy-dom.
  Checks the heading count and edited text on every iteration.

The benchmark runs production React via `NODE_ENV=production` and `flushSync`
so development-only element validation and stack capture are not part of the
latency budget. DOM commit and synchronous effects are included.

Both report cold load separately, discard five warmup edits, and report median,
p95 and maximum over 30 measured edits. Both enforce p95 below 100 ms. The test
harness timeout includes cold load and all assertions; it is not the latency
budget. Run on an otherwise idle machine for useful latency comparisons.
Happy-dom measures DOM work but does not measure browser layout, paint, GPU,
Shiki's non-text language initialization or Mermaid rendering.

The optimization targets edits to already-open documents. Cold loads still
parse all blocks. A single enormous block must be reparsed as a unit. Raw HTML,
reference definitions and footnotes, frontmatter/horizontal-rule ambiguity,
math, CRLF, comments and standalone block ids conservatively use whole-document
processing to preserve existing semantics. These cases do not have the local
edit latency guarantee.

The renderer caches the latest document plus at most 16 small recent chunks
for undo (at most 4096 source characters each), using Lezer's incremental tree
fragments to find CommonMark/GFM block boundaries. Unchanged chunks reuse
sanitized trees and React elements. Plain word edits map existing boundaries
without rescanning the grammar, preserve React keys, and reuse document-kind
analysis when its structural inputs cannot change. Task handlers check the
committed source at click time instead of subscribing every checkbox to prose
edits. Structural edits retain the full incremental grammar path. Heading slugs are assigned in document
order, including duplicate-heading collisions, and source/task line attributes
are shifted after line insertions. Sanitization still runs after raw HTML
parsing and before KaTeX; the default react-markdown URL policy is retained.

Measured results and validation commands are recorded in `BRIDGE_NOTES.md` at
the repository root for inclusion in the eventual PR description.
