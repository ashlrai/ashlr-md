# Ashlr MD site

A static, dependency-free site served directly from `landing/`. The homepage
uses system fonts, a CSS app mockup and manual theme controls. Three practical
use-case guides link to the local documentation and installation hubs. No
comparison page is included.

## Preview and validate

From the repository root:

```sh
python3 -m http.server 8899 --bind 127.0.0.1 --directory landing
HOME=$(mktemp -d) bun run build:landing
HOME=$(mktemp -d) bun run test:landing
```

`build:landing` refreshes `sitemap.xml` and validates the static artifact in place.
There is no bundler or runtime dependency for the site. Keep the existing
merge-to-main deployment path and hosting configuration unchanged.

## Content contracts

- Each factual block uses `data-claim` and contains a visible `a[data-source]`
  pointing to supporting repository docs or code. Check the source actually
  supports the prose; the automated test verifies presence and path existence,
  not semantic truth. New guide sections must also use `data-claim`.
- Keep each guide useful on its own: concrete steps, prerequisites and limits.
  Link to `/docs/`, `/install/`, and relevant sibling guides.
- Every HTML page needs a unique title, description, one H1, and an absolute
  self-canonical matching its sitemap URL. Use directory URLs with trailing `/`.
- Use system fonts. Content is visible without JavaScript or animation. Give
  any future content images explicit intrinsic width and height. The existing
  `og.png` is social metadata, not a downloaded in-page image.
- Do not add unsupported competitor claims or numeric performance promises.

## Sitemap handoff

`python3 -B scripts/landing_seo.py` discovers all HTML pages. It derives each
`lastmod` from the latest git commit touching the page, its linked stylesheet,
or its cited repository evidence. It never uses build time or filesystem mtime.

For an uncommitted new page, the tracked sources supply a provisional date.
After the content is committed by the authorized publishing workflow, regenerate
the sitemap and include that refresh in a following commit. The sitemap-only
commit does not change any page dependency, so another regeneration is stable.
Repeat this refresh after later content, source or style changes. The normal
static deployment serves the checked-in sitemap without requiring build config
changes. `robots.txt` advertises the absolute sitemap URL for Search Console.

## Reproduce the mobile performance audit

With the preview server running and Chrome installed:

```sh
bunx lighthouse@13.5.0 http://127.0.0.1:8899/ \
  --chrome-flags='--headless --no-sandbox' --disable-storage-reset \
  --only-categories=performance,accessibility,seo \
  --output=json --output-path=/tmp/ashlr-md-lighthouse.json --quiet
```

Use the same Chrome, Lighthouse version and mobile settings for both revisions.
Lighthouse launches a fresh temporary Chrome profile for each run; storage reset
is disabled to avoid a cache-clearing timeout on this host.
Local Lighthouse is lab evidence, not field Core Web Vitals or an INP measurement.
