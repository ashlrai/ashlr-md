<!--
Thanks for contributing to Ashlr MD! Agents and people follow the same path:
https://github.com/ashlrai/ashlr-md/blob/main/CONTRIBUTING.md#contribute-with-an-agent
-->

## What & why

Briefly: what does this change and why? One concern per pull request.

## Checklist

- [ ] `scripts/ci-local.sh` passes (from a fork clone: `scripts/ci-local.sh upstream/main`)
- [ ] No secrets committed (both diff secret scans fail closed)
- [ ] UI change: verified in the real app (`bun run tauri dev`) in all three themes (Paper / Sepia / Midnight)
- [ ] Docs change: `bun run check:doc-links` and `bun run doclive:check` pass; after editing `docs/AGENTS.md`, `python3 scripts/check-docs.py` passes
- [ ] No GPL added to the bundled dependency tree
- [ ] Nothing leaves the device without explicit user action

## Notes

Anything reviewers should know (screenshots welcome).

<!--
What happens next: `Check (Linux)` is the one required check. Once it is green,
GitHub auto-merge and the merge queue land the change. On a fork pull request a
maintainer or fleet agent arms auto-merge for you.
-->
