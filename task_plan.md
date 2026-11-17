# Task Plan: Windows native Open dialog CI

## Goal
Find and fix the Windows native probe failure, verify it, and leave changes uncommitted with bridge notes.

## Phases
- [x] Read repository instructions and inspect probe entry points.
- [x] Read failed-run diagnostics and check for overlapping PRs.
- [x] Add a focused regression test and the smallest correct fix.
- [x] Run touched tests, typecheck, lint, and write BRIDGE_NOTES.md.

## Decisions Made
- Follow the final user rule: do not commit, push, or publish.
- Keep workflow and security controls unchanged.

## Errors Encountered
- New native-handle alias regression fails on the original helper as expected.
- Shared Linux harness: 3 failures and 3 errors from noncanonical macOS TMPDIR; resolved by rerunning with a canonical test-owned temp directory (26 passed).
- Added self-alias ambiguity guard regression to ensure native identity cannot make a window count as its own child. It fails before the guard fix, as expected.

## Status
Local fix, regression coverage, and BRIDGE_NOTES.md complete. Typecheck, lint, Windows Python harness, shared Python harness (canonical TMPDIR), native DOM, and no-dash tests pass. Changes remain uncommitted. Hosted Windows qualification and confirmation of the observed pair's HWND identity remain outstanding.
