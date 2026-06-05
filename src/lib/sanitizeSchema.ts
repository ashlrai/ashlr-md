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
 *   - wikilink `data-*` props on `<a>`/`<span>` and embed prop on `<div>`.
 */

import { defaultSchema } from "rehype-sanitize";

export const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "input"],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className"],
    input: ["type", "checked", "disabled", "className"],
    a: [...(defaultSchema.attributes?.a ?? []), "dataWikitarget", "dataWikialias"],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      "dataWikitarget",
      "dataWikialias",
    ],
    div: [...(defaultSchema.attributes?.div ?? []), "dataEmbedTarget"],
  },
};
