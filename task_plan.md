# Windows native QA repair

## Goal
Fix the Windows native dialog and owned-cleanup failures, validate the changes, and leave an uncommitted bridge handoff plus a separate workflow trigger patch.

## Phases
- [x] Establish scope and honor the final no-publish instruction.
- [x] Inspect the failed run and reproduce its failure paths with synthetic provider fixtures.
- [x] Fix app or harness code with regression coverage.
- [x] Run typecheck, lint, and touched tests with temporary HOME.
- [x] Write workflow patch and BRIDGE_NOTES.md with counts and net LOC.

## Decisions
- Leave changes uncommitted; do not publish or merge because the final task rule forbids it.

## Errors
- Requested external handoff path is denied by the filesystem. Preserve the patch in the worktree as a fallback.
- Local gh configuration is unreadable; used GitHub connector for run logs and open PR inspection.
- Expanded PowerShell regression initially accessed Count on an empty pipeline under StrictMode; corrected to an explicit array.
- Documentation checker suite has one existing loopback EPERM failure (22 passed, 1 failed); repository relative-link scan passed.
- Shared Linux harness initially failed 6 cases with noncanonical macOS temporary paths; canonical TMPDIR resolved this without changing code or security checks (26 passed).

## Status
Local implementation and handoff complete. No commits, pushes, PRs, queue merges or workflow dispatches were made. Actual hosted Windows qualification remains unverified on this macOS host. Requested external patch location is blocked by filesystem permissions; the patch is retained under the worktree's handoff directory.
