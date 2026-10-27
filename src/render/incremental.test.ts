import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { createElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import rehypeSlug from "rehype-slug";
import { describe, expect, it } from "vitest";
import { IncrementalMarkdown } from "./incremental";
import { parseMarkdown } from "./pipeline";

function html(renderer: IncrementalMarkdown, source: string) {
  return renderToStaticMarkup(createElement(Fragment, null, renderer.render(source)));
}
const baseline = new Map<string, string>();
function full(source: string) {
  const cached = baseline.get(source);
  if (cached !== undefined) return cached;
  const tree = parseMarkdown(source);
  rehypeSlug()(tree);
  const output = renderToStaticMarkup(toJsxRuntime(tree, { Fragment, jsx, jsxs }));
  baseline.set(source, output);
  return output;
}
const section = (n: number) =>
  `## Repeated heading\n\nParagraph ${n} with **strong**, ==highlight==, [[Note]] and [a link](https://example.com).\n\n- [ ] task ${n}\n- nested\n  - item\n\n> [!NOTE]\n> A callout.\n\n| A | B |\n| - | - |\n| x | y |\n\n`;
const document = Array.from({ length: 100 }, (_, n) => section(n)).join("");

describe("incremental Markdown rendering", () => {
  it("matches whole-document output for GFM, Obsidian syntax and duplicate headings", () => {
    const renderer = new IncrementalMarkdown();
    expect(html(renderer, document)).toBe(full(document));
    expect(renderer.stats.parsedChunks).toBeGreaterThan(1);
  });

  it("reuses parsed chunks and React elements on a local edit", () => {
    const renderer = new IncrementalMarkdown();
    const before = renderer.render(document);
    const changed = document.replace("Paragraph 50", "Rewritten 50");
    const after = renderer.render(changed);
    expect(renderer.stats.parsedChunks).toBe(1);
    expect(renderer.stats.reusedChunks).toBeGreaterThan(5);
    expect(after[0]).toBe(before[0]);
    expect(html(renderer, changed)).toBe(full(changed));
    expect(renderer.render(changed)).toBe(after);
  });

  it("updates global heading collisions and line numbers after insertions and deletions", () => {
    const renderer = new IncrementalMarkdown();
    html(renderer, document);
    for (const source of [
      `# Repeated heading\n\n${document}`,
      document.replace("Paragraph 20", "extra\n\nParagraph 20"),
      document.replace(section(30), ""),
      document.replace("## Repeated heading", "## Changed heading"),
      document,
    ]) {
      expect(html(renderer, source)).toBe(full(source));
    }
  });

  it("never splits nested lists, quotes, tables, indented or fenced code", () => {
    const renderer = new IncrementalMarkdown();
    const long = "line\n\n".repeat(800);
    const source = `${document}\n\n\`\`\`md\n${long}\`\`\`\n\n${document}\n\n${"    indented\n".repeat(300)}`;
    expect(html(renderer, source)).toBe(full(source));
    expect(html(renderer, source.replace("line", "changed"))).toBe(
      full(source.replace("line", "changed")),
    );
  });

  it("maps word edits across chunks before reparsing structural edits", () => {
    const renderer = new IncrementalMarkdown();
    const original = Array.from({ length: 20 }, (_, n) => section(n)).join("");
    const edits = [
      original,
      original.replace("Paragraph 0", "Expanded paragraph 0"),
      original.replace("Paragraph 19", "Last paragraph 19"),
      original.replace("Paragraph 10", "P 10"),
      original.replace("Paragraph 10", "Paragraph 10 appended"),
      original.replace("Paragraph 10", "## A new heading\n\nParagraph 10"),
      original.replace("Paragraph 5", "Paragraph\n\nSplit 5"),
      original,
    ];
    for (const source of edits) expect(html(renderer, source)).toBe(full(source));
  });

  it("keeps nodes passed to previously rendered components immutable", () => {
    const renderer = new IncrementalMarkdown({
      p: ({ node, children }) =>
        createElement(
          "p",
          {
            "data-probe": node?.properties.dataSourceLine,
          },
          children,
        ),
    });
    const source = Array.from({ length: 20 }, (_, n) => section(n)).join("");
    const output = renderer.render(source);
    const committed = renderToStaticMarkup(createElement(Fragment, null, output));
    renderer.render(`# New heading\n\n${source}`);
    expect(renderToStaticMarkup(createElement(Fragment, null, output))).toBe(committed);
  });

  it.each([
    "[ref]: https://example.com\n\n[link][ref]",
    "[multi\nline]: https://example.com\n\n[link][multi line]",
    "[^note]: A footnote\n\nText[^note]",
    "<div>\n\nHTML across blocks\n\n</div>",
    "%% hidden\n\nacross blocks %%",
    "$$\nx + y\n\n+ z\n$$",
    "---\ntitle: YAML\n---\n\nHello",
    "^previous-block",
    "line\r\nnext",
  ])("keeps document-wide syntax correct: %s", (suffix) => {
    const renderer = new IncrementalMarkdown();
    const source = suffix.startsWith("---")
      ? `${suffix}\n\n${document}`
      : `${document}\n${suffix}`;
    expect(html(renderer, source)).toBe(full(source));
    expect(renderer.stats.wholeDocument).toBe(true);
    expect(html(renderer, document)).toBe(full(document));
  });

  it("sanitizes hostile HTML, URLs and forged line metadata through the fallback", () => {
    const renderer = new IncrementalMarkdown();
    const output = html(
      renderer,
      `${document}\n<script>alert(1)</script>\n<img src="x" onerror="evil()" data-source-line="999">\n\n[bad](javascript:alert%281%29)`,
    );
    expect(output).not.toContain("<script");
    expect(output).not.toContain("onerror");
    expect(output).not.toContain("javascript:");
    expect(output).not.toMatch(/<img[^>]*data-source-line="999"/);
    expect(output).toMatch(/<img[^>]*data-source-line="1503"/);
  });

  it("handles empty content, repeated chunks, and switching documents without stale output", () => {
    const renderer = new IncrementalMarkdown();
    for (const source of [
      "",
      document,
      "",
      section(1).repeat(100),
      "# Other",
      document,
    ]) {
      expect(html(renderer, source)).toBe(full(source));
    }
  });
});
