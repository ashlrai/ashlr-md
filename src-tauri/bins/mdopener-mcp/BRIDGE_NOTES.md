# BRIDGE_NOTES — RQ-MD2104A110318Q8

## Summary
Added `export_text_keeps_brackets_and_unicode_in_more_scripts_and_marks` to
`src-tauri/bins/mdopener-mcp/tests/integration.rs`. It covers bracketed prose in
scripts/marks not yet tested (Cyrillic, Greek, Devanagari, Thai, ZWJ/ZWNJ, bidi
marks, variation selectors, keycap/flag/astral letters) across paragraph, heading,
quote, list, table, adjacent links, reference links, wiki-link/footnote and nested
brackets. Each case asserts `tool_export_text` text, `strip_markdown`, and `char_count`.
No product code changed; no tests skipped or deleted (existing tests untouched).

## Commands
- `cargo test` (temp HOME, real RUSTUP_HOME/CARGO_HOME)
- `cargo clippy --tests`

## Results
- integration: 556 passed, 0 failed (incl. new test). Other suites all pass.
- `doctor_reports_unverified_when_offline_is_on_but_nothing_answers` failed once in the
  full parallel run (different test file, untouched) and passed on rerun in isolation: flaky.
- clippy: clean.

## Net LOC
+48 / -0 (tests/integration.rs only), plus this file.
