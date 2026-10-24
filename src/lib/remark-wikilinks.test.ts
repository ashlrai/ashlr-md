import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import { remarkWikilinks } from "./remark-wikilinks";

function transform(md: string) {
  const processor = unified().use(remarkParse).use(remarkWikilinks);
  return processor.runSync(processor.parse(md));
}

function collect(md: string, type: string) {
  // biome-ignore lint/suspicious/noExplicitAny: test introspection of custom nodes
  const out: any[] = [];
  visit(transform(md), type, (n) => {
    out.push(n);
  });
  return out;
}

describe("remarkWikilinks", () => {
  it("turns [[Note]] into a wikilink node", () => {
    const links = collect("See [[Note]] here", "wikilink");
    expect(links).toHaveLength(1);
    expect(links[0].data.hProperties.dataWikitarget).toBe("Note");
    expect(links[0].data.hProperties.className).toContain("wikilink");
  });

  it("supports [[target|alias]]", () => {
    const [link] = collect("[[page|Display]]", "wikilink");
    expect(link.data.hProperties.dataWikitarget).toBe("page");
    expect(link.data.hProperties.dataWikialias).toBe("Display");
  });

  it("carries a heading fragment in the target", () => {
    const [link] = collect("[[Doc#Section]]", "wikilink");
    expect(link.data.hProperties.dataWikitarget).toBe("Doc#Section");
  });

  it("turns ![[Embed]] into a wikiembed node", () => {
    const embeds = collect("![[Embed]]", "wikiembed");
    expect(embeds).toHaveLength(1);
    expect(embeds[0].data.hProperties.dataEmbedTarget).toBe("Embed");
  });

  it("leaves ordinary text untouched", () => {
    expect(collect("just some prose", "wikilink")).toHaveLength(0);
  });

  it("does NOT rewrite [[...]] inside a markdown link label", () => {
    // The text node lives under a `link` node — rewriting it would corrupt the
    // link AST, so it must be left alone.
    expect(collect("[see [[here]]](https://example.com)", "wikilink")).toHaveLength(0);
  });

  it("does NOT rewrite [[...]] inside inline code", () => {
    expect(collect("use `[[literal]]` syntax", "wikilink")).toHaveLength(0);
  });

  it("handles multiple links in one paragraph", () => {
    expect(collect("[[a]] and [[b]] and [[c]]", "wikilink")).toHaveLength(3);
  });

  it("links [[#Heading]] and [[#^block]] to this document", () => {
    const links = collect("See [[#Setup]], [[#^b1]] and [[#Setup|there]].", "wikilink");
    expect(links.map((l) => l.data.hProperties.dataWikitarget)).toEqual([
      "#Setup",
      "#^b1",
      "#Setup",
    ]);
    // Shown as the heading, as Obsidian does, or as the alias.
    expect(links.map((l) => l.data.hProperties.dataWikialias)).toEqual([
      "Setup",
      "^b1",
      "there",
    ]);
  });

  it("leaves [[]], [[|x]] and ![[#Heading]] as text", () => {
    for (const md of ["a [[]] b", "a [[|x]] b", "a ![[#Setup]] b"]) {
      expect(collect(md, "wikilink"), md).toHaveLength(0);
      expect(collect(md, "wikiembed"), md).toHaveLength(0);
    }
    const [link] = collect("[[]] then [[Real]]", "wikilink");
    expect(link.data.hProperties.dataWikitarget).toBe("Real");
  });

  it("ends a wikilink or an embed on its own line, as Obsidian does", () => {
    const md = "See [[open\nmore [[Real]] and ![[pic\nnext]]";
    const links = collect(md, "wikilink");
    expect(links.map((l) => l.data.hProperties.dataWikitarget)).toEqual(["Real"]);
    expect(collect(md, "wikiembed")).toHaveLength(0);
  });
});
