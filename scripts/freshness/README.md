# Release freshness

Run `bun run fresh:sync` after updating the release sources. Run
`bun run fresh:check` for a read-only drift check (exit 1 on drift or invalid
sources/markers). Run `bun run test:freshness` for isolated Node tests.
Node can also run `scripts/freshness/sync.mjs` and `check.mjs` directly.
No network calls, dependencies or credentials are needed.

The source of truth is `package.json` version, `src-tauri/tauri.conf.json`
version and the first dated `## [version]` section in `CHANGELOG.md`.
All three must agree. Unreleased sections are skipped. Resolve source
mismatches explicitly; sync never changes release manifests or history.

The generator scans README.md, CHANGELOG.md and Markdown files recursively
under docs/ and samples/. Only marked block contents change. Historical
release notes and statements about previously tested versions stay handwritten.
Symlinks are not traversed. Paths resolve from the scripts, independent of cwd.

Supported marker names are `version-badge`, `install-snippet`, `version-table`
and `example-version-pin`. Add a block on separate lines:

```html
<!-- fresh:begin version-badge -->
<!-- fresh:end -->
```

Templates live in `blocks()` in sync.mjs. Reuse a name wherever the same block
is needed. Unknown names, malformed markers and unbalanced/nested blocks fail
before any file is written. CRLF line endings are preserved. Check and sync use
the same rendering and validation code. No CI workflows are changed here;
existing CI can invoke `bun run fresh:check` when ready.
