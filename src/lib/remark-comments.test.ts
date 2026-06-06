import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import { remarkComments } from "./remark-comments";

function transform(md: string) {
  const processor = unified().use(remarkParse).use(remarkComments);
  return processor.runSync(processor.parse(md));
}

function collectText(md: string): string {
  const parts: string[] = [];
  visit(transform(md), "text", (n: { value: string }) => {
    parts.push(n.value);
  });
  return parts.join("");
}

describe("remarkComments", () => {
  it("removes %%comment%% entirely", () => {
    const result = collectText("hello %%secret%% world");
    expect(result).not.toContain("secret");
    expect(result).not.toContain("%%");
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });

  it("preserves text before and after a comment", () => {
    const result = collectText("before %%removed%% after");
    expect(result).toContain("before ");
    expect(result).toContain(" after");
  });

  it("removes multiple comments in one paragraph", () => {
    const result = collectText("a %%one%% b %%two%% c");
    expect(result).not.toContain("one");
    expect(result).not.toContain("two");
    expect(result).not.toContain("%%");
    expect(result).toContain("a ");
    expect(result).toContain(" b ");
    expect(result).toContain(" c");
  });

  it("does NOT strip %% inside inline code", () => {
    // inlineCode content lives on node.value, not as text children — confirm
    // the inlineCode node's value is untouched by the plugin.
    const inlineCodes: { value: string }[] = [];
    visit(transform("use `%%literal%%` here"), "inlineCode", (n: { value: string }) => {
      inlineCodes.push(n);
    });
    expect(inlineCodes).toHaveLength(1);
    expect(inlineCodes[0].value).toBe("%%literal%%");
  });

  it("removes a comment that is the entire text node", () => {
    // A paragraph containing only a comment should produce no visible text.
    const result = collectText("%%entirely hidden%%");
    expect(result.trim()).toBe("");
  });

  it("leaves ordinary prose untouched", () => {
    const result = collectText("just some prose");
    expect(result).toBe("just some prose");
  });
});
