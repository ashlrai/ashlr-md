import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { expect, it } from "vitest";
import { rehypeSourceLines } from "../lib/rehype-source-lines";
import { rehypeTaskLines } from "../lib/rehype-task-lines";
import { remarkBlockIds } from "../lib/remark-block-ids";
import { remarkCallouts } from "../lib/remark-callouts";
import { remarkComments } from "../lib/remark-comments";
import { remarkHighlights } from "../lib/remark-highlights";
import { remarkWikilinks } from "../lib/remark-wikilinks";
import { SANITIZE_SCHEMA } from "../lib/sanitizeSchema";
import { IncrementalMarkdown } from "./incremental";

// Independent migration oracle: preserve the pre-incremental Renderer's plugin
// ordering. Do not derive this from pipeline.ts, or both paths could regress
// together while the comparison still passed.
function originalRenderer(source: string) {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [
          remarkFrontmatter,
          remarkGfm,
          remarkComments,
          remarkHighlights,
          remarkWikilinks,
          remarkMath,
          remarkCallouts,
          remarkBlockIds,
        ],
        rehypePlugins: [
          rehypeRaw,
          [rehypeSanitize, SANITIZE_SCHEMA],
          rehypeTaskLines,
          rehypeSourceLines,
          rehypeKatex,
          rehypeSlug,
        ],
      },
      source,
    ),
  );
}

it("matches the original ReactMarkdown pipeline across edits, fallbacks, undo and document replacement", () => {
  const initial = "# Duplicate\n\nLong prose **bold**.\n\n".repeat(100);
  const cases: [string, string][] = [
    ["initial chunked document", initial],
    ["heading collision", `${initial}# Duplicate\n`],
    ["task source lines", `${initial}- [ ] Task\n`],
    ["blocked link", `${initial}[x](javascript:alert%281%29)\n`],
    [
      "raw HTML sanitation",
      initial +
        '<h2 id="fixed">Named</h2>\n<script>alert(1)</script>\n<img src="x" onerror="bad()">',
    ],
    ["footnote fallback", `${initial}[^note]: Footnote\n\ntext[^note]`],
    [
      "callout and Obsidian text",
      `${initial}> [!WARNING]\n> Callout [[Note]] ==highlight==\n`,
    ],
    ["math fallback", `${initial}$x+1$\n`],
    ["comment fallback", `${initial}%% hidden %%\n`],
    ["block identifier", `${initial}paragraph ^blockid\n`],
    ["local prose edit", initial.replace("Long prose", "Different prose")],
    ["undo", initial],
    ["empty replacement", ""],
  ];
  const cache = new IncrementalMarkdown();
  for (const [name, source] of cases) {
    const expected = originalRenderer(source);
    const actual = renderToStaticMarkup(
      createElement(Fragment, null, cache.render(source)),
    );
    expect(actual, name).toBe(expected);
    if (name === "initial chunked document") {
      expect(actual.match(/<h1 /g)).toHaveLength(100);
      expect(cache.stats.parsedChunks).toBeGreaterThan(1);
    }
    if (name === "raw HTML sanitation") {
      expect(actual).not.toContain("<script");
      expect(actual).not.toContain("onerror");
    }
  }
});
