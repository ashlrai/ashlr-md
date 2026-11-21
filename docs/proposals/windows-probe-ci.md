# Proposal: stop the Windows original-artifact probe from re-running on every merge

Status: not needed, kept as a record. No file under `.github/` was changed.

## Outcome

The loop this proposal describes stopped without the diff below. #1956
(2026-11-18) changed only `scripts/native-qa-windows.py` and its test: the
Prepare step now reads the stable version from the
`releases/latest/download/latest.json` updater feed instead of the
unauthenticated `api.github.com` `/releases/latest` call that returned 403.
Every run of the workflow since then has passed, including step 12, which now
qualifies the real Open-file scenario and reports the original CLI startup
failure as a warning. The workflow still runs on every push to `main`. See
[Current result](../WINDOWS-NATIVE-QA.md#current-result).

The rest of this page is the proposal as written while the job was failing.

## Problem

`.github/workflows/native-qa-windows.yml` ("Original MD 0.5 Windows install and
native probe") runs on every push to `main`, and none of its last 12 runs
passed. Each red run
makes the main guardian queue a FIXUP-CI job, each merged FIXUP-CI is itself a
push to `main`, and that push starts the next red run.

## Evidence

Step outcomes come from the public jobs API
(`/repos/ashlrai/ashlr-md/actions/runs/<id>/jobs`). The job log could not be
read for this proposal (see the gap below).

| Run | When (UTC) | Event | Head | First failing step |
|---|---|---|---|---|
| 41399770492 to 41410805380 (7 runs) | Nov 2, 06:25 to 08:07 | `workflow_dispatch` | various | all failed; 41410805380 at step 12, Install probe (143 s) |
| 43978554187 | Nov 16, 23:21 | `push` | 6fe1886c (#1920) | 5, PowerShell dialog-selection regression |
| 43980125026 | Nov 16, 23:32 | `push` | 029e134a | 11, Prepare and verify original artifacts |
| 43983931987 | Nov 16, 23:59 | `push` | 61aba80d | 11, Prepare |
| 43987780966 | Nov 17, 00:27 | `push` | 1a7527c1 (#1923) | 11, Prepare |
| 43991582185 | Nov 17, 00:55 | `push` | 877fe944 (#1924) | 12, Install probe (105 s) |

- The workflow was manual-only until #1920. The patch kept in
  `handoff/RQ-FIX-md-WIN-NATIVE-QA/ashlr-md.patch` shows the `push` and
  `release` triggers being added to a workflow whose header read "Specifically
  approved manual original-artifact Windows QA".
- Step 12 was already failing on Nov 2. `docs/WINDOWS-NATIVE-QA.md` records it
  as an open qualification: the original 0.5.0 app did not show its startup
  fixture, and the real Open-file scenario did not find the native dialog. Its
  last line on the subject is "A hosted Windows rerun is still needed".
- The probe installs a hash-pinned 0.5.0 installer (`INSTALLER_HASH`,
  `EXE_HASH` in `scripts/native-qa-windows.py`). A merge that does not touch
  the harness cannot change its result.

## Proposed diff

```diff
--- a/.github/workflows/native-qa-windows.yml
+++ b/.github/workflows/native-qa-windows.yml
@@ -3,6 +3,14 @@
 on:
   push:
     branches: [main]
+    # The probed 0.5.0 artifact is hash-pinned, so only a harness change can
+    # change the result. Other merges would repeat the previous verdict.
+    paths:
+      - .github/workflows/native-qa-windows.yml
+      - scripts/native-qa.py
+      - scripts/native-qa-windows.py
+      - scripts/native-qa-open-dialog.ps1
+      - scripts/test-native-qa-open-dialog.ps1
+      - scripts/test-native-qa-windows.py
+      - scripts/release-provenance.py
+      - scripts/release-signature-check/**
   release:
     types: [published]
   workflow_dispatch:
```

No permission, secret, trigger type or action pin changes. `release` and
`workflow_dispatch` stay as they are.

## What this does and does not fix

- It stops unrelated merges from producing a new red run, which is what feeds
  the guardian loop.
- It does not make the job green. A harness change will still run the probe,
  and step 12 will still fail until the Open-file scenario is qualified on a
  hosted runner or the 0.5.0 CLI startup result is accepted as a known failure
  of that frozen artifact. That decision is not made here.
- The alternative is to return to `workflow_dispatch` and `release` only, the
  state before #1920. It removes the loop completely, at the cost of no
  automatic run when the harness changes.
- Separately, the guardian (in phantom, outside this repository) could decline
  to queue FIXUP-CI for a workflow that has no green run to regress from.

## Gap

The failing lines of step 12 in run 43991582185 are unknown. `gh` could not read
its configuration in the sandbox this was written in, and the logs API answers
403 without credentials. The repo-code change shipped with this proposal makes
the harness print its failure reason as an annotation, which the next run will
expose without log access.
