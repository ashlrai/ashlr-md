# Windows native QA findings

Run: https://github.com/ashlrai/ashlr-md/actions/runs/41410805380

Evidence and validation results will be recorded here.

- Run 41410805380, job 125163185669: UIA observation was one disabled `Tauri Window`, `reason=not-found`, `stage=wait`; filename/confirmation were never reached.
- Cleanup succeeded, including one retry after WinError 5 for readonly Start Menu folders and Desktop. Existing tests exercise the complete readonly chain and reject reparse/escape cases.
- Microsoft documents popup reparenting: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-serversideprovider#assigning-a-new-parent
- Fix: discover one child-window level under exact-PID desktop windows, capped at eight windows total. Existing dialog/control selection and bounded process lifetime stay intact.
- Existing open PRs were inspected through the GitHub connector; none covers the native Windows harness.
- Requested handoff directory cannot be read or created: filesystem reports Operation not permitted for /Users/masonwyatt/.ashlr-runs. The earlier RQ-CI-ECO-MD-NATIVE-QA patch cannot be verified from this environment.
- gh fallback cannot read its config (Operation not permitted); GitHub read-only evidence was obtained through the connected tool instead.
- Dependencies installed with frozen lockfile and temporary HOME. Typecheck passed. Lint passed with 13 existing warnings. Native DOM oracle tests: 3 passed. Python Windows harness: 58 passed, 3 existing platform skips, 0 failed.
- PowerShell 7.6.9 was downloaded from the official PowerShell release into /tmp only. The actual-source discovery/selection suite passes. A disposable mutation restoring desktop-only discovery is rejected with `owned child dialog missed`, confirming regression sensitivity.
- Shared Linux harness: initial run had 3 failures and 3 errors because macOS temporary paths contained a symlink; rerun with canonical TMPDIR inside temporary HOME passed all 26 tests. Runtime path validation was not changed.
- Documentation tests: 22 passed, 1 failed due to loopback EPERM. Standalone repository scan: 340 links, 0 broken. No link-checker code changed.
- Separate scheduling patch applies and preserves the entire jobs section byte-for-byte; main push, published release, manual dispatch and cancellation are verified. The real workflow is unmodified in the worktree.
