# Notes: RQ-MDWINROOTN17DQ8

- Base: 82b85672 (#1931). Read workflow and local fix snapshots #1921, #1922, #1923, #1924, #1925, #1927, #1928, #1929, #1931.
- Saved #1931 evidence cites run 44036511886/job 133880570666: disabled Tauri Window and two enabled modal #32770 entries; failure was ambiguous-dialog, before filename entry. That evidence does not contain native ancestry.
- Locus exec/run/enter reject the expired session; prescribed leave --force fails with Operation not permitted. Requested session recovery or read-only connector authorization; no answer yet. Fresh hosted evidence is unavailable.
- Reproduced a concrete selector defect: distinct HWNDs sharing a native root are rejected when UIA exposes them as siblings. Existing direct-child filtering can also collapse independent popups when UIA reparents them.
- Fix uses native parent ancestry only to another enabled exact-PID candidate, never owner ancestry. Zero-handle provider fallback, independent-dialog rejection, bounded traversal, deadlines, token isolation and integrity checks remain. New diagnostics expose fixed ancestry labels only.
- API contract: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getancestor
- Provider tree contract: https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-tree-overview
- Before fix: new sibling-layout regression fails with ambiguous-dialog. After fix: PowerShell suite passes, including seven new cases. Updated suite also rejects HEAD for incorrectly accepting independent native roots.
- Final tests: Windows Python 63 passed, 3 existing Windows-only skips; shared Python 26 passed; native DOM/no-dash Vitest 14 passed; PowerShell suite passed. Typecheck passed; lint passed with 13 existing warnings.
- Doc-link suite: 22 passed, 1 failed because loopback requests return EPERM (reconfirmed). Standalone scan: 342 links, 0 broken. No test was weakened, removed, or newly skipped.
- Tests used a temporary HOME and canonical TMPDIR. No Rust code changed or cargo tests run.
- Hosted Windows qualification and correlation to the recurring failure remain outstanding; this is a tested candidate correction, not a verified hosted recovery.
