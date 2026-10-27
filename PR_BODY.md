# Add sourced Markdown workflow guides and static SEO checks

The site had one entry page and no sitemap. Add three guides for reviewing
agent-written Markdown, reading vault notes and exporting documents, with local
docs and install hubs. Each claim block links to repository evidence, and each
page links back into the site. No comparison page or competitor performance
claims are added. Remove unsupported comparisons and qualify local versus cloud
AI behavior on the homepage.

Remove blocking third-party fonts, delayed content reveals, the full-screen SVG
noise filter, blurred decorative layers and automatic theme cycling. Keep manual
theme controls, make content visible without JavaScript and under reduced motion,
and correct contrast in the agent section. There are no in-page raster images to
resize; `og.png` is social metadata. CLS is checked rather than assumed.

Add a sitemap with absolute self-canonicals, git-derived `lastmod` values and a
robots.txt discovery link. The static host still serves `landing/` directly.

## Validation

`bun run typecheck`, `bun run lint`, the application build and the static-site
build pass. Lint retains 18 existing warnings and 53 infos; the app build retains
externalized-module and chunk-size warnings. Eight SEO tests and the final 47
documentation tests pass. Browser assertions pass for all six routes at 320,
390 and 1440 px with JavaScript off and reduced motion, plus manual theme control
(19 checks).

The initial full suite had 3032 passes and five failures. One failure was the
shortcut test matching an exact opening tag; it now accepts attributes and still
asserts the exact shortcut set. Four editor tests timed out under host load.
Focused retries passed 56/57, then the remaining case passed alone with its
unchanged 5000 ms timeout. Across the full run and retries, all 3037 distinct tests
have passing results. No tests, assertions or timeouts were weakened.

## Local Lighthouse before and after

Baseline: `68b89c964cc5253eb041cc15990bb5f597ba41b0`. Lighthouse 13.5.0,
Chrome 156, default simulated mobile settings, fresh browser profiles and
`--disable-storage-reset`. Both pairs ran after the build and test retries
finished. The second pair used the Lighthouse Node API so the temporary runner
could terminate its own Chrome process after saving the report.

| Metric | CLI before | CLI after | Repeat before | Repeat after |
| --- | ---: | ---: | ---: | ---: |
| Performance | 69 | 76 | 59 | 64 |
| FCP | 3.70 s | 2.40 s | 3.69 s | 2.38 s |
| LCP | 3.70 s | 2.40 s | 3.69 s | 2.38 s |
| Speed Index | 3.70 s | 2.87 s | 3.86 s | 4.19 s |
| TBT | 464 ms | 750 ms | 998 ms | 3,434 ms |
| CLS | 0 | 0 | 0 | 0 |

LCP improved in both pairs; CLS remained zero. The updated homepage made only one
network request, with no external fonts or render-blocking font stylesheet.
Scores and TBT vary substantially, and TBT regressed in both pairs; both runs report a
slow-host warning. These local lab results do not establish field CWV or INP.
Settings, raw metric values, warnings and audit details are preserved in
`seo-evidence/lighthouse.json`; reproduction commands are in `landing/README.md`.


## Publishing handoff

This is a prepared PR body, not a published PR. The task's final instruction
requires all changes to remain uncommitted and prohibits commit, push and publish.
No `publish.sh` exists in this checkout. No hosting or release configuration,
`.github/**`, CODEOWNERS, protected code paths or credentials were changed.
Deployment must follow the existing merge-to-main path.

After the authorized publisher commits the content, run `bun run build:landing`
and include the regenerated sitemap in a following commit before opening the PR.
New uncommitted files currently use their tracked evidence's provisional git date.
See `landing/README.md` for the stable two-step sitemap workflow.
