# Release freshness

Run `bun run fresh:sync` after updating the release sources. Run
`bun run fresh:check` for a read-only drift check (exit 1 on drift or invalid
sources/markers). Run `bun run test:freshness` for isolated Node tests.
Node can also run `scripts/freshness/sync.mjs` and `check.mjs` directly.
No network calls, dependencies or credentials are needed.

`package.json`, `src-tauri/tauri.conf.json` and the first dated
`CHANGELOG.md` version section must agree on the source/build version. That version
continues to describe the app being built, not necessarily a public release.
Unreleased sections are skipped; source mismatches fail closed.

`published.json` is an explicit receipt for the independently verified public
release. Its version must match exactly one dated changelog entry. Only after
the release owner verifies the final tag and its published assets should this
receipt advance. A source bump or dated candidate is not publication evidence.
Sync does not query a registry, publish, change app metadata, or change history.

The generator scans README.md, CHANGELOG.md, `landing/index.html` and Markdown
files recursively under docs/ and samples/. The release badge, table, and
landing download link use the receipt, not the source version. The README
download links follow GitHub’s live latest release, while installer and sample
instructions use version-neutral placeholders so a source archive does not
carry a stale executable pin. Only marked block contents change. Historical
release notes and statements about previously tested versions stay handwritten.
Symlinks are not traversed. Paths resolve from the scripts, independent of cwd.

Supported marker names are `version-badge`, `install-snippet`, `version-table`,
`example-release-page` and `site-download`. Add a block on separate lines:

```html
<!-- fresh:begin version-badge -->
<!-- fresh:end -->
```

Templates live in `blocks()` in sync.mjs. Reuse a name wherever the same block
is needed. Unknown names, malformed markers and unbalanced/nested blocks fail
before any file is written. CRLF line endings are preserved. Check and sync use
the same rendering and validation code. No CI workflows are changed here;
existing CI can invoke `bun run fresh:check` when ready.
