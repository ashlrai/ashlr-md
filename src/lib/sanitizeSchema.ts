/**
 * sanitizeSchema.ts — HTML-sanitization allowlist for untrusted Markdown.
 *
 * Used by the read-view Renderer (and any other surface that renders a `.md`
 * file's raw HTML). It runs AFTER `rehype-raw` so embedded `<script>`,
 * `onerror=`, and `javascript:` URLs from a malicious file are stripped, but
 * BEFORE `rehype-katex` so KaTeX's trusted, heavily-styled output is injected
 * post-sanitize and never mangled.
 *
 * Extensions over the GitHub-derived `defaultSchema`:
 *   - `className` on any element (callout cards, KaTeX `.math` placeholders).
 *   - `input[type=checkbox]` for interactive GFM task lists.
 *   - `mark` for Obsidian `==highlights==`.
 *   - wikilink `data-*` props on `<a>`/`<span>` and embed prop on `<div>`,
 *     and the `wikilink` class on `<a>`.
 */

import { defaultSchema } from "rehype-sanitize";

export const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "input", "mark"],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className"],
    input: ["type", "checked", "disabled", "className"],
    // An element's own `className` rule replaces the `*` one: GitHub's
    // allows only `data-footnote-backref` on a link, so the `wikilink` class
    // remark-wikilinks sets was stripped, the Renderer never saw a wikilink,
    // and `[[note]]` rendered as a link with no destination.
    a: [
      ...(defaultSchema.attributes?.a ?? []).filter(
        (d) => !(Array.isArray(d) && d[0] === "className"),
      ),
      ["className", "data-footnote-backref", "wikilink"] as [string, ...string[]],
      "dataWikitarget",
      "dataWikialias",
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      "dataWikitarget",
      "dataWikialias",
    ],
    div: [...(defaultSchema.attributes?.div ?? []), "dataEmbedTarget", "dataEmbedSize"],
  },
};
