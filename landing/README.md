# Ashlr MD landing page

The website at [md.ashlr.ai](https://md.ashlr.ai/). It is a self-contained,
dependency-free page (`index.html`) with no build step. Editorial "paper"
aesthetic: Fraunces display + Hanken Grotesk body + JetBrains Mono, warm
neutrals with a sharp blue accent, a live theme-cycling app mockup, and
scroll-reveal animations.

## What is in this folder

| File | Purpose |
|---|---|
| `index.html` | The whole page: markup, styles and script |
| `og.png` | The social preview image (`og:image` and `twitter:image`) |
| `llms.txt`, `llms-full.txt` | The agent index and the one-file manual, served at the site root |
| `robots.txt`, `sitemap.xml` | Crawler rules and the sitemap (the page plus both llms files) |
| `vercel.json` | Static hosting config: no framework, no build, and a skip when nothing in `landing/` changed |

## Keep it in step with the repository

Tests and scripts pin parts of the page, so an edit that drifts from the app
fails a check:

- **Download link.** The button inside `fresh:begin site-download` is generated
  from the verified public receipt by `node scripts/freshness/sync.mjs` from the
  repository root; see
  [`scripts/freshness/README.md`](../scripts/freshness/README.md). Do not edit
  it by hand, and do not point it at an unreleased source version.
  `src/docFacts.test.ts` checks that it goes to GitHub Releases.
- **Shortcut grid.** `src/docFacts.test.ts` checks that the `#shortcuts` grid
  lists exactly the shortcuts registered in `src/lib/commands.ts` (plus ⌘I),
  with modifiers written as ⌥⇧⌘.
- **Punctuation.** `src/noDashes.test.ts`, part of `bun run test:unit`, rejects
  em and en dashes in the page, as characters or entities.
- **Ecosystem section.** `#ecosystem` mirrors "Part of Ashlr" in the
  repository [README](../README.md#part-of-ashlr); change both together.
- **llms copies.** `llms.txt` and `llms-full.txt` here must match the copies at
  the repository root. After editing either root file, run
  `cp llms.txt llms-full.txt landing/` and
  `node --test scripts/llms-txt.test.mjs`.
- **Sitemap dates.** No script updates `sitemap.xml`. When you change
  `index.html`, `llms.txt` or `llms-full.txt`, set that entry's `<lastmod>`
  to the date of the change.

## Preview locally

```bash
open index.html          # just open it in a browser
# or serve it:
python3 -m http.server 8899   # then visit http://localhost:8899
```

## Deploy

The folder is static; host it anywhere:

- **Vercel:** `vercel deploy` from this `landing/` folder (or set the project
  root to `landing/`). `vercel.json` already sets the static output; its
  `ignoreCommand` skips a deployment when the commit leaves `landing/` unchanged.
- **GitHub Pages / Netlify / Cloudflare Pages:** point at this folder.

## Notes

- Fonts load from Google Fonts; for a fully offline page, self-host them.
