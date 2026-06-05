import { toHtml } from "hast-util-to-html";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { SANITIZE_SCHEMA } from "./sanitizeSchema";

/** Render markdown through the same raw→sanitize pipeline the Renderer uses. */
async function render(md: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, SANITIZE_SCHEMA);
  const hast = await processor.run(processor.parse(md));
  return toHtml(hast as Parameters<typeof toHtml>[0]);
}

describe("SANITIZE_SCHEMA", () => {
  it("strips <script> tags from raw HTML", async () => {
    const out = await render("hello\n\n<script>alert(1)</script>\n");
    expect(out).not.toContain("<script");
    expect(out).toContain("hello");
  });

  it("strips inline event handlers like onerror", async () => {
    const out = await render('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
  });

  it("strips javascript: URLs from links", async () => {
    const out = await render("[click](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
  });

  it("strips <iframe> embeds", async () => {
    const out = await render('<iframe src="https://evil.example"></iframe>');
    expect(out).not.toContain("<iframe");
  });

  it("preserves GFM task-list checkboxes", async () => {
    const out = await render("- [x] done\n- [ ] todo\n");
    expect(out).toContain("<input");
    expect(out).toContain('type="checkbox"');
  });

  it("preserves safe formatting and links", async () => {
    const out = await render("**bold** and [link](https://example.com)");
    expect(out).toContain("<strong>");
    expect(out).toContain('href="https://example.com"');
  });
});
