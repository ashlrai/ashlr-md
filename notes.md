# Notes: Windows native Open dialog CI

- Failed run: https://github.com/ashlrai/ashlr-md/actions/runs/44036511886
- Worktree HEAD: 00565c11, immediately after failing revision 2feb3849.
- Native picker helper already polls dialog discovery, filename controls, and confirm button.
- Existing PowerShell regression harness executes discovery and selection from the real helper source with synthetic windows.
- Changes must remain uncommitted. BRIDGE_NOTES.md is the requested handoff.
- Retrieved complete job 133880570666 logs through the GitHub connector. Failure is `dialog (ambiguous-dialog)`; the observation is a disabled Tauri Window plus two enabled, modal #32770 entries. Filename and confirmation were never reached.
- Prior PR 1929 explicitly inferred a filename/confirmation race without retrieving the log; that inference does not explain this failure.
- Current open PRs do not cover the native probe. Remote main matches local HEAD 00565c11.
- RuntimeId-only discovery does not collapse separate provider entries that refer to one HWND. A new actual-source PowerShell regression fails on the original implementation (`native dialog aliases not collapsed`).
- Fix uses nonzero native window handles for identity, with RuntimeId fallback for handle-less elements. The nested-dialog filter uses the same identity function. Foreign ownership and independent-dialog rejection remain mandatory.
- The failed run's sanitized observation omits handles, so aliasing is an inference. Native Windows qualification remains required; local PowerShell only proves language and selection behavior.
- Microsoft NativeWindowHandle reference: https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.automationelementinformation.nativewindowhandle
- Dependencies installed with `bun install --frozen-lockfile`; portable PowerShell 7.6.9 is available under /private/tmp for the standalone regression. An additional official archive was downloaded and SHA256 verified without system installation.
- Final coverage includes both enumeration orders across desktop, owned-child, and cross-level layouts (six cases), foreign ownership, independent native windows, self-alias ambiguity, and nested aliases with fresh RuntimeIds. Existing zero-handle RuntimeId, cap, modality, and traversal cases remain.
- Verification: PowerShell suite passes; Windows Python harness 62 passed / 0 failed / 3 existing Windows-only skips; shared Python harness 26 passed after canonicalizing TMPDIR; Vitest native DOM and no-dash suites 14 passed; typecheck passes; lint passes with 13 existing warnings.
- Initial shared Python run had 3 failures and 3 errors from macOS temporary-directory symlinks; only test environment paths were corrected, with no production path-check changes.
