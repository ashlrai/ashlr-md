# Ashlr MD — landing page

A self-contained, dependency-free marketing page (`index.html`). Editorial
"paper" aesthetic: Fraunces display + Hanken Grotesk body + JetBrains Mono,
warm neutrals with a sharp blue accent, a live theme-cycling app mockup, and
scroll-reveal animations. No build step.

## Preview locally

```bash
open index.html          # just open it in a browser
# or serve it:
python3 -m http.server 8899   # then visit http://localhost:8899
```

## Deploy

It's a single static file — host it anywhere:

- **Vercel:** `vercel deploy` from this `landing/` folder (or set the project
  root to `landing/`). No framework, no config needed.
- **GitHub Pages / Netlify / Cloudflare Pages:** point at this folder.

## Notes

- Replace the placeholder repo URL `github.com/ashlrai/ashlr-md` and the
  download link (`/releases`) once the repo + first release exist.
- Fonts load from Google Fonts; for a fully offline page, self-host them.
