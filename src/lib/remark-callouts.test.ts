import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { remarkCallouts } from "./remark-callouts";

// Trees are built by hand so the test depends only on the plugin and mdast types.
const text = (value: string) => ({ type: "text" as const, value });
const para = (...children: unknown[]) => ({ type: "paragraph" as const, children });
const quote = (...children: unknown[]) => ({ type: "blockquote" as const, children });
const root = (...children: unknown[]) =>
  ({ type: "root" as const, children }) as unknown as Root;

function run(tree: Root): Root {
  remarkCallouts()(tree);
  return tree;
}
const bq = (tree: Root) =>
  tree.children[0] as unknown as {
    children: Array<{
      type: string;
      children?: Array<{ type: string; value?: string }>;
    }>;
    data?: { hName?: string; hProperties?: Record<string, unknown> };
  };

describe("remarkCallouts: bracket markers", () => {
  it.each([
    "NOTE",
    "TIP",
    "WARNING",
    "IMPORTANT",
    "CAUTION",
  ])("[!%s] becomes a callout div", (kind) => {
    const tree = run(root(quote(para(text(`[!${kind}]\n`), text("body")))));
    const n = bq(tree);
    expect(n.data?.hName).toBe("div");
    expect(n.data?.hProperties?.className).toEqual([
      "callout",
      `callout-${kind.toLowerCase()}`,
    ]);
    expect(n.data?.hProperties?.["data-callout"]).toBe(kind.toLowerCase());
  });

  it("matches the marker case-insensitively", () => {
    const n = bq(run(root(quote(para(text("[!tip] hello"))))));
    expect(n.data?.hProperties?.["data-callout"]).toBe("tip");
    expect(n.children[0].children?.[0].value).toBe("hello");
  });

  it("keeps the rest of the first text node after the marker", () => {
    const n = bq(run(root(quote(para(text("[!NOTE] Read this"))))));
    expect(n.children[0].children?.[0].value).toBe("Read this");
  });

  it("drops the marker-only text node and, when that empties the paragraph, the paragraph", () => {
    const only = bq(run(root(quote(para(text("[!WARNING]"))))));
    expect(only.children).toHaveLength(0);
    expect(only.data?.hProperties?.["data-callout"]).toBe("warning");

    const withMore = bq(
      run(root(quote(para(text("[!WARNING]")), para(text("second paragraph"))))),
    );
    expect(withMore.children).toHaveLength(1);
    expect(withMore.children[0].children?.[0].value).toBe("second paragraph");
  });

  it("does not match an unknown marker", () => {
    const n = bq(run(root(quote(para(text("[!DANGER] x"))))));
    expect(n.data).toBeUndefined();
    expect(n.children[0].children?.[0].value).toBe("[!DANGER] x");
  });
});

describe("remarkCallouts: legacy bold labels", () => {
  it("turns **Note:** into a note callout and strips the label", () => {
    const strong = { type: "strong", children: [text("Note")] };
    const n = bq(run(root(quote(para(strong, text(": remember this"))))));
    expect(n.data?.hProperties?.["data-callout"]).toBe("note");
    expect(n.children[0].children?.[0].value).toBe("remember this");
  });

  it("ignores a bold label that is not a callout word", () => {
    const strong = { type: "strong", children: [text("Summary")] };
    const n = bq(run(root(quote(para(strong, text(": x"))))));
    expect(n.data).toBeUndefined();
  });
});

describe("remarkCallouts: pass-through", () => {
  it("leaves an ordinary blockquote untouched", () => {
    const n = bq(run(root(quote(para(text("just a quote"))))));
    expect(n.data).toBeUndefined();
    expect(n.children[0].children?.[0].value).toBe("just a quote");
  });

  it("tolerates empty blockquotes, empty paragraphs and a non-paragraph first child", () => {
    expect(() => run(root(quote()))).not.toThrow();
    expect(() => run(root(quote(para())))).not.toThrow();
    const code = { type: "code", value: "[!NOTE]" };
    const n = bq(run(root(quote(code))));
    expect(n.data).toBeUndefined();
  });

  it("only the marker at the start of the first paragraph counts", () => {
    const n = bq(run(root(quote(para(text("intro")), para(text("[!NOTE] later"))))));
    expect(n.data).toBeUndefined();
  });

  it("annotates nested blockquotes independently", () => {
    const inner = quote(para(text("[!TIP] inner")));
    const tree = run(root(quote(para(text("plain")), inner)));
    expect(bq(tree).data).toBeUndefined();
    const nested = bq(tree).children[1] as unknown as {
      data?: { hProperties?: Record<string, unknown> };
    };
    expect(nested.data?.hProperties?.["data-callout"]).toBe("tip");
  });
});
