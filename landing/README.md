# Ashlr MD landing page

A self-contained, dependency-free marketing page (`index.html`). Editorial
"paper" aesthetic: Fraunces display + Hanken Grotesk body + JetBrains Mono,
warm neutrals with a sharp blue accent, a live theme-cycling app mockup, and
scroll-reveal animations. No build step at deploy time.

## Editing

`index.html` is generated: edit `index.template.html`, then run:

```bash
node landing/freshness.mjs        # or: bun run gen:site
```

The generator fills `{{PLACEHOLDER}}` slots with facts read from the repo's
sources of truth: the version (package.json + tauri.conf.json + the CHANGELOG
entry), the MCP tool count and names (`tool_registry()` in
`src-tauri/bins/mdopener-mcp/src/lib.rs`), the agent connect commands
(`agent_setup.rs`), the bundled sidecar path, the shortcut grid
(`src/lib/commands.ts` + `EDITOR_SHORTCUTS`), the themes (`THEMES` in
`settingsStore.ts`), the export formats (`EXPORT_FORMATS`), the CLI name, the
deep-link scheme, and the on-device AI macOS floor.

Check freshness without writing:

```bash
bun run check:site                # fails when index.html is stale
```

`src/siteFreshness.test.ts` runs the same check under `bun run test`, and
`src-tauri/bins/mdopener-mcp/tests/site_freshness.rs` covers it under
`cargo test` for registry-side changes.

## Preview locally

```bash
open index.html          # just open it in a browser
# or serve it:
python3 -m http.server 8899   # then visit http://localhost:8899
```

## Deploy

It's a single static file; host it anywhere:

- **Vercel:** `vercel deploy` from this `landing/` folder (or set the project
  root to `landing/`). No framework, no config needed. `.vercelignore` keeps
  the template and generator out of the deployment.
- **GitHub Pages / Netlify / Cloudflare Pages:** point at this folder.

## Notes

- Fonts load from Google Fonts; for a fully offline page, self-host them.
