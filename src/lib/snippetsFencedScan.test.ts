import { describe, expect, it, vi } from "vitest";
import * as outline from "./outline";
import { isInsideFencedCode } from "./snippets";

vi.mock("./outline", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./outline")>();
  return { ...mod, markdownLines: vi.fn(mod.markdownLines) };
});

/** The full-document read isInsideFencedCode used to make. */
function readAll(doc: string, pos: number): boolean {
  for (const l of vi.mocked(outline.markdownLines)(doc)) {
    if (pos > l.start + l.text.length) continue;
    return l.kind === "code" || (l.kind === "fence" && pos > l.start);
  }
  return false;
}

describe("isInsideFencedCode reads up to the cursor's line", () => {
  it("reads no line after the cursor's", () => {
    // The completion source asks on every keystroke; the whole document
    // used to be read each time.
    const doc = `# Notes\n\n\`\`\`js\nlet a = 1;\n\`\`\`\n\n${"More text.\n".repeat(5000)}`;
    const mock = vi.mocked(outline.markdownLines);
    mock.mockClear();
    const pos = doc.indexOf("let a") + 3;
    expect(isInsideFencedCode(doc, pos)).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe(doc.slice(0, doc.indexOf("\n", pos)));
  });

  it("answers as a full read does", () => {
    const pieces = [
      "---",
      "...",
      "```",
      "````",
      "~~~",
      "$$",
      "a",
      "",
      "> ```",
      "- ```",
      "    x",
      "<div>",
      "x: 1",
      "---\r",
    ];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 400; k++) {
      const doc = Array.from(
        { length: 1 + rnd(8) },
        () => pieces[rnd(pieces.length)],
      ).join("\n");
      for (let p = 0; p <= doc.length; p++) {
        expect([doc, p, isInsideFencedCode(doc, p)]).toEqual([doc, p, readAll(doc, p)]);
      }
    }
  });

  it("is in front matter, not code, before the front matter closes", () => {
    const doc = "---\nx: |\n  ```\n  y\n---\nbody\n";
    expect(isInsideFencedCode(doc, doc.indexOf("y"))).toBe(false);
    // With no closing line it is no front matter, and the fence is one.
    const open = "---\nx: |\n  ```\n  y\n";
    expect(isInsideFencedCode(open, open.indexOf("y"))).toBe(true);
  });
});
