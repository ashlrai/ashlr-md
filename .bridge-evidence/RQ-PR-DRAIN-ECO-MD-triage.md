# RQ-PR-DRAIN-ECO-MD dispositions

Compared against main `ddb3729b0d7bae0b621ec121a40f5c21b996f42b` (2026-11-09).
Lane sandbox denies `~/.config/gh` and `~/.ashlr-runs`, so `gh`, fork pushes and
`publish.sh` were unavailable inside the job; the drain is carried in this
job's own publish diff instead of per-PR head updates + `gh pr merge` enqueues.

## Carried into this drain commit (superseded by this PR once merged)

All sixteen are additive `src/lib/mdlint-autofix.test.ts` blocks; applied,
deduped, and verified green (3173 tests pass). Each becomes a no-op diff vs
main after this PR lands and can be closed as superseded.

- #1622 RQ-MD480A110309Q8 — autofix preserves a described image with an absolute URL.
- #1620 RQ-MD459A110308Q8 — invalid link immediately followed by a valid link.
- #1618 RQ-MD517A110311Q8 — invalid link in a nested blockquote.
- #1617 RQ-MD2802A110321Q8 — parametrize invalid-href forms beside a valid link.
- #1616 RQ-MD1500A110316Q8 — whitespace-only href becomes TODO.
- #1614 RQ-MD496A110309Q8 — described/undescribed images sharing a destination.
- #1613 RQ-MD479A110309Q8 — valid absolute links untouched; empty href beside one.
- #1610 RQ-MD389A110305Q8 — undescribed image on the second line.
- #1608 RQ-MD394A110305Q8 — invalid destinations across paragraphs, default rules.
- #1607 RQ-MD395A110305Q8 — two undescribed images on one line.
- #1604 RQ-MD386A110305Q8 — Unicode link text under invalid-link autofix.
- #1603 RQ-MD392A110305Q8 — [TODO] prose around ``, `#`, `?` hrefs.
- #1601 RQ-MD387A110305Q8 — Unicode image paths and titled sources.
- #1600 RQ-MD385A110305Q8 — bracketed prose annotations under default rules.
- #1599 RQ-MD377A110304Q8 — undescribed image at the start of a paragraph.
- #1598 RQ-MD364A110303Q8 — two undescribed images, same/different lines.
- #1596 RQ-UPKEEP-DOCS-ashlr-md-20261109 — CHANGELOG bullets describing work
  already on main (wiki.json, llms.txt Windows entry, README badge, retry fix,
  dead-export tidy, new tests); rebased wording onto the current 0.7.5 section.

## Index bookkeeping (also in this commit)

`docs/mdlint-autofix-fixture-index.md`: added the four `it.each` names the
fixture-index test requires — two pre-existing omissions on main
(`replaces a whitespace-only description in a blockquote…`,
`fixes the documented example's empty and whitespace-only descriptions…`)
plus the two added here — and bumped `Link fixtures` 290→292,
`Image fixtures` 113→115. `src/lib/mdlint-autofix-fixture-index.test.ts`
now passes; it failed on main before this change.

## Deferred — .github edits cannot go through publish.sh (shared limit)

- #1577 RQ-SWE-MD-DRIFT-1: every non-`.github` part is already on main
  (CONTRIBUTING freshness line, freshness.test.mjs check-read-only assertion,
  README wording). Remaining piece: ci.yml "Generated release documentation
  freshness" step — needs a Security pass / handoff.
- #1569 RQ-MAINREGRESSIONQ8: non-`.github` parts already on main (fixture-index
  backtick normalization + doc updates + check-doc-links regression test).
  Remaining pieces must land together: ci.yml "Check documentation links" step
  and the gate.test.mjs assertion that requires it — needs a Security pass.

## Release v0.7.5 (run 42565988813)

- Signature: `bun tauri build` exit 1 on windows-latest, macos-15-intel and
  ubuntu-22.04; macos-15 (arm64) passed. Ubuntu and Intel-mac uploaded bundle
  artifacts before failing (late-phase); Windows produced no `bundle/` output.
- Leading cause: non-deterministic toolchain — `oven-sh/setup-bun` floated
  `bun-version: latest` (resolving to 1.4.x while 1.3.14 is the verified line).
  Fixed on main by #1623 (`717f77d8`) in both ci.yml and release.yml, plus a
  regression test asserting exact pins.
- v0.7.4 (run 42341508791) failed earlier, differently: the exact-SHA full-CI
  evidence gate timed out before CI finished.
- Retry (sanctioned path, needs authed gh): `gh workflow run release.yml
  -R ashlrai/ashlr-md -f version=0.7.5`. A dispatch runs the workflow file
  from the dispatch ref (main — which has the pin fix) and only checks out
  tag v0.7.5 (`0bc9ce68`) for sources, so the retry carries the fix.
- Also removed in this commit: `scripts/release-signature-check/target/` —
  5.1 MB of committed arm64 build artifacts (.o/.rlib/Mach-O binary) —
  and `target/` added to `.gitignore` so it cannot recur.

## Verification on the combined tree (temp HOME)

- `bun run typecheck`: clean.
- `bunx biome check src`: exit 0, 13 pre-existing warnings (baseline on main).
- `vitest run src/lib/mdlint-autofix.test.ts`: 3173 pass, 0 fail.
- `vitest run src/lib/mdlint-autofix-fixture-index.test.ts`: 6 pass (1 was failing on main).
- `bun run check:doc-links`: 340 links, 0 broken; `check-doc-links.test.mjs` 23 pass.
- `node --test scripts/ci/{gate,assembly-workflow,release-gate}.test.mjs`: 30 pass.
- `llms-txt`, `package-scripts`, `check:version`, `check:crypto`, `fresh:check`,
  `doclive:check`, `check-docs.py`, `check:workflow-bash`: all pass.

## Not done (sandbox limits)

- Per-PR head pushes and `gh pr merge` enqueues: no gh/push auth in the lane
  sandbox (`~/.config/gh`, `~/.ashlr-runs`, keychain all denied). After this PR
  merges, close the carried PRs with "Superseded by this drain PR" and hand the
  two `.github` diffs to Security.
