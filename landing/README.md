# Ashlr MD landing page

The public site at https://md.ashlr.ai/ is a self-contained static page. It
requires no build step. Keep deployment on the existing merge-to-main path;
no deployment configuration changes are needed for these static files.

## Preview locally

From this directory, run `python3 -m http.server 8899` and open
http://localhost:8899/. Fonts load from Google Fonts. Content and discovery
files remain readable without JavaScript.

## Agent discovery

From the repository root:

```sh
bun install --frozen-lockfile
bun run discovery:generate
bun run discovery:check
HOME=$(mktemp -d) bun run test:discovery
```

Commit the generated files with source changes. Generation is deterministic
and requires no network access. The existing `bun run test` command also runs
the discovery tests, including a drift check, before the app tests. Tests use
Python 3's standard XML parser for strict sitemap validation.

- `llms.txt`: index generated from README and all `docs/*.md` headings. Each
  document has one canonical GitHub URL, with section links using GitHub slugs.
- `llms-full.txt`: combined source documents with relative Markdown links
  resolved against their canonical source URLs.
- `capabilities.json`: versioned manifest describing the desktop app's local
  interfaces, platform support, documentation, and limitations.
- `sitemap.xml`: canonical HTML pages on this site only. GitHub docs and text
  discovery files are not separate HTML pages on this origin.
- `robots.txt`: allows crawling and advertises the sitemap.
- `index.html`: generated SoftwareApplication JSON-LD between discovery
  markers. Version comes from `package.json`; licensing and platform support
  reflect LICENSE and README. The free offer applies to the app, not optional
  cloud AI services.

When adding HTML pages, give each exactly one canonical URL and one h1, retain
semantic heading order, add metadata, and extend the sitemap generator. The
page tests recursively check all HTML files. Do not edit generated discovery
content by hand; update its source or `scripts/generate-discovery.mjs`.
