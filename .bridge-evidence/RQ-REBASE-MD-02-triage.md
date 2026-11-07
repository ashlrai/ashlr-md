# RQ-REBASE-MD-02 triage

All 8 PRs touch only docs/mdlint-autofix-fixture-index.md and src/lib/mdlint-autofix-fixture-index.test.ts, making Markdown-looking fixture names literal (backtick spans) and teaching the index test to normalize them.
Main already has this via #1561 (fenced `"name"` entries; sections() strips complete fences). Test passes on main (6/6).

- PR 1553 SUPERSEDED — same fix already on main (#1561); alternate in-line-backtick variants would only churn the docs.
- PR 1551 SUPERSEDED — same fix already on main (#1561); alternate in-line-backtick variants would only churn the docs.
- PR 1552 SUPERSEDED — same fix already on main (#1561); alternate in-line-backtick variants would only churn the docs.
- PR 1550 SUPERSEDED — same fix already on main (#1561); alternate in-line-backtick variants would only churn the docs.
- PR 1549 SUPERSEDED — same fix already on main (#1561); alternate in-line-backtick variants would only churn the docs.
- PR 1548 SUPERSEDED — same fix already on main (#1561); alternate in-line-backtick variants would only churn the docs.
- PR 1546 SUPERSEDED — same fix already on main (#1561); alternate in-line-backtick variants would only churn the docs.
- PR 1545 SUPERSEDED — same fix already on main (#1561); alternate in-line-backtick variants would only churn the docs.

Note: 'gh' was unusable in the sandbox (config unreadable), so PR content was read via git fetch refs/pull/N/head, not gh pr view/diff.
