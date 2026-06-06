import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import { remarkHighlights } from "./remark-highlights";

function transform(md: string) {
  const processor = unified().use(remarkParse).use(remarkHighlights);
  return processor.runSync(processor.parse(md));
}

// biome-ignore lint/suspicious/noExplicitAny: test introspection of custom nodes
function collect(md: string, type: string): any[] {
  // biome-ignore lint/suspicious/noExplicitAny: test introspection
  const out: any[] = [];
  visit(transform(md), type, (n) => {
    out.push(n);
  });
  return out;
}

describe("remarkHighlights", () => {
  it("converts ==x== into a highlight node", () => {
    const nodes = collect("Some ==highlighted== text", "highlight");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].data.hName).toBe("mark");
    expect(nodes[0].data.hProperties.className).toContain("highlight");
    expect(nodes[0].children[0].value).toBe("highlighted");
  });

  it("preserves surrounding text", () => {
    const tree = transform("before ==mid== after");
    // biome-ignore lint/suspicious/noExplicitAny: test
    const texts: any[] = [];
    visit(tree, "text", (n) => texts.push(n));
    const values = texts.map((t) => t.value);
    expect(values).toContain("before ");
    expect(values).toContain(" after");
  });

  it("handles multiple highlights in one paragraph", () => {
    const nodes = collect("==a== and ==b== and ==c==", "highlight");
    expect(nodes).toHaveLength(3);
    expect(nodes[0].children[0].value).toBe("a");
    expect(nodes[1].children[0].value).toBe("b");
    expect(nodes[2].children[0].value).toBe("c");
  });

  it("does NOT transform == inside inline code", () => {
    // inlineCode content lives on node.value, never as text children — the
    // plugin never visits it. Confirm the inlineCode value is untouched.
    const inlineCodes: { value: string }[] = [];
    visit(
      transform("use `==literal==` syntax"),
      "inlineCode",
      (n: { value: string }) => {
        inlineCodes.push(n);
      },
    );
    expect(inlineCodes).toHaveLength(1);
    expect(inlineCodes[0].value).toBe("==literal==");
    // And no highlight nodes were produced.
    expect(collect("use `==literal==` syntax", "highlight")).toHaveLength(0);
  });

  it("does NOT transform empty ====", () => {
    const nodes = collect("nothing ====here", "highlight");
    expect(nodes).toHaveLength(0);
  });

  it("does NOT transform ==   == (whitespace only)", () => {
    const nodes = collect("==   ==", "highlight");
    expect(nodes).toHaveLength(0);
  });

  it("leaves ordinary prose untouched", () => {
    expect(collect("just some prose", "highlight")).toHaveLength(0);
  });
});
