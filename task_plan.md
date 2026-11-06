# Task Plan

## Goal
Integrate 8 to 16 related backlog PRs with unique product behavior on current upstream, leaving uncommitted code and exact source evidence.

## Phases
- [x] Fetch and inspect conventions and current PR ownership/state.
- [x] Select and compare a related batch, preserving exact source mappings.
- [x] Integrate behavior and meaningful tests serially.
- [x] Run focused tests, typecheck and lint; write BRIDGE_NOTES.md and next batch.

## Status
Complete: 8 verified sources mapped, 7 suites preserved, missing nearest-link behavior integrated; 2,934 affected tests pass, corrected full/focused typechecks and lint pass. Changes uncommitted on 851ac5d515afff29d5f9b77f24c76270a15ca517.

## Errors Encountered
- gh configuration access denied and Python trust store missing issuer: used system curl and git fetch with normal verification.
- Initial new regression formatting: fixed with Biome.
- Suite extraction omitted clearLintHistory import: restored import, then reran affected suites.
- Full typecheck begun before the import fix cached two missing-name errors; final focused typecheck passes; full check restarted on corrected files.
