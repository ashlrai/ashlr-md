# Living documentation

`doclive` keeps the agent-facing docs honest against the code they describe,
and regenerates marked regions of index and readme files. Run from the repo
root; no network, dependencies or credentials.

```bash
bun run doclive:check   # read-only: claims + generated-block drift (exit 1 on drift)
bun run doclive:sync    # rewrite doclive:begin/end blocks, then report claim problems
bun run test:doclive    # hermetic node:test suite
```

## Drift detection

Every claim maps to the Markdown section that contains it, so a stale guide is
reported as `file:line § Section › Subsection`, not as a bare line number.

**Declared claims** live in the doc they protect, one HTML comment per line,
outside fenced code:

```md
<!-- doclive: exists docs/EXAMPLES.md -->
<!-- doclive: symbol src/mcp/handlers/edit.ts#NO_DOCUMENT_OPEN -->
<!-- doclive: contains src/lib/commands.ts /shortcut: "/ -->
<!-- doclive: seq src-tauri/bins/mdopener-mcp/src/lib.rs /name: "([a-z_]+)",/ vs /^\d+\. `([a-z_]+)`/ -->
<!-- doclive: set <path> [#symbol] /<code-regex>/ vs /<doc-regex>/ -->
```

- `exists <path>` — the repo-root-relative path exists.
- `symbol <path>#<name>` — `name` is defined in the file (keyword-anchored for
  code, heading slug for Markdown, key for JSON/TOML/YAML).
- `contains <path> /<regex>/` — the file content matches the regex.
- `seq` / `set <path> [#symbol] /<code-regex>/ vs /<doc-regex>/` — the items
  each regex captures must be equal in order (`seq`) or as a multiset (`set`).
  The code regex runs on the whole file; `#symbol` additionally asserts the
  symbol exists. The doc regex runs on the enclosing section's text with
  `doclive:` comments stripped. Capture group 1 is the item, else the whole
  match. Flags default to `gm`; `g` is always added.

**Inferred claims** need no marker: every repo-shaped path in inline code or
fenced blocks of the watched docs (`WATCHED` in `doclive.mjs`) must exist.
A token counts as repo-shaped when its first segment is a real top-level
directory or a `.`/`..` relative path, so foreign paths (`sessions/`,
`squashfs-root/…`, other repos' trees) never mint claims. Resolution tries the
fence's `cd` target (shell fences only), the document's directory, and the
repo root. Bare filenames without a `/` are not checked — too ambiguous.

## Regeneration

Marked blocks are rewritten from their sources, like the `fresh:` blocks in
`scripts/freshness/`:

```md
<!-- doclive:begin docs-index -->
…generated lines…
<!-- doclive:end -->
```

Unknown names, malformed markers, unbalanced or nested blocks fail before any
file is written. Blocks required exactly once: `docs-index` in
`docs/README.md`, `mcp-events` in `docs/AGENTS.md`.

| Block | Source | Content |
|---|---|---|
| `docs-index` | `docs/**/*.md` | `- [title](path)` inventory, title from each file's first heading |
| `mcp-events` | `src/mcp/bridge.ts` + `src/mcp/handlers/` | the frontend MCP event table in wiring order |

`check` fails when a block's content differs from its render or a marker is
malformed; `sync` rewrites the blocks. Add a block on separate lines and a
render case in `renderBlock()` when a new derivable region appears.
