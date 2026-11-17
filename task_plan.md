# Task Plan: RQ-MDWINROOTN17DQ8

## Goal
Fix the recurring Windows native probe failure with portable coverage; leave changes uncommitted and bridge notes under 3,000 characters.

## Phases
- [x] Read instructions, workflow and recent fix snapshots.
- [x] Reproduce native/UIA ancestry mismatch; fix without weakening guards.
- [x] Run portable regressions, touched tests, typecheck and lint with isolated homes.
- [x] Review diff and write BRIDGE_NOTES.md with prior fixes, counts and net LOC.
- [ ] Confirm correlation with fresh hosted evidence and Windows qualification.

## Decisions
- No commits, pushes, tags, publishing or production installs.
- Preserve workflow, existing tests and security boundaries.
- Treat the code defect as proven and hosted attribution as unconfirmed.

## Errors Encountered
- Initial plan patch rejected duplicate paths; rewrote the files directly.
- Locus session expired; prescribed recovery denied by filesystem. User input pending.
- Expected red regression: ambiguous-dialog before native ancestry fix.
- Doc-link suite: 22 pass, 1 loopback EPERM failure; standalone scan passes.

## Status
Local candidate fix and verification complete. Hosted confirmation remains blocked by unavailable Locus access and lack of a Windows runner here.
