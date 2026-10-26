import type { Root } from "hast";
import { urlAttributes } from "html-url-attributes";
import { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { rehypeSourceLines } from "../lib/rehype-source-lines";
import { rehypeTaskLines } from "../lib/rehype-task-lines";
import { remarkBlockIds } from "../lib/remark-block-ids";
import { remarkCallouts } from "../lib/remark-callouts";
import { remarkComments } from "../lib/remark-comments";
import { remarkHighlights } from "../lib/remark-highlights";
import { remarkWikilinks } from "../lib/remark-wikilinks";
import { SANITIZE_SCHEMA } from "../lib/sanitizeSchema";

// Same order as the read view: untrusted HTML must be sanitized BEFORE KaTeX.
// Slugs are assigned across all chunks later so duplicate headings stay unique.
const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter)
  .use(remarkGfm)
  .use(remarkComments)
  .use(remarkHighlights)
  .use(remarkWikilinks)
  .use(remarkMath)
  .use(remarkCallouts)
  .use(remarkBlockIds)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, SANITIZE_SCHEMA)
  .use(rehypeTaskLines)
  .use(rehypeSourceLines)
  .use(rehypeKatex);

export function parseMarkdown(source: string): Root {
  const tree = processor.runSync(processor.parse(source), { value: source });
  // Preserve react-markdown's default URL policy in addition to the sanitizer.
  visit(tree, "element", (node) => {
    for (const [key, tags] of Object.entries(urlAttributes)) {
      if (
        Object.hasOwn(node.properties, key) &&
        (tags === null || tags.includes(node.tagName))
      ) {
        node.properties[key] = defaultUrlTransform(String(node.properties[key] || ""));
      }
    }
  });
  return tree;
}
