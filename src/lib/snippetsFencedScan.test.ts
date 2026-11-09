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

  it("detects a cursor inside a tilde-fenced block", () => {
    const doc = "Before\n~~~js\nconst value = 1;\n~~~\nAfter\n";
    const pos = doc.indexOf("value") + 2;

    expect(isInsideFencedCode(doc, pos)).toBe(true);
    expect(isInsideFencedCode(doc, pos)).toBe(readAll(doc, pos));
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

  it("keeps adjacent fenced blocks distinct", () => {
    // Two blocks with no blank line between them: the first closing fence
    // must end the first block, and the next opening fence start another.
    const doc = "```js\nalpha\n```\n```py\nbeta\n```\nafter\n";
    const at = (s: string, off = 0) => doc.indexOf(s) + off;
    const inside = (p: number) => isInsideFencedCode(doc, p);

    // Contents of each block are code.
    expect(inside(at("alpha", 2))).toBe(true);
    expect(inside(at("beta", 2))).toBe(true);
    // Each fence line is code only after its first character.
    const close1 = at("```\n```py");
    const open2 = close1 + 4;
    expect(inside(close1)).toBe(false);
    expect(inside(close1 + 1)).toBe(true);
    expect(inside(open2)).toBe(false);
    expect(inside(open2 + 1)).toBe(true);
    // The first block's close does not swallow the second block's info
    // string as plain text, and text after the second block is prose.
    expect(inside(at("py"))).toBe(true);
    expect(inside(at("after", 2))).toBe(false);
    expect(inside(doc.length)).toBe(false);

    // Boundaries: each block yields its own code line; none merge across the boundary.
    const lines = outline.markdownLines(doc).filter((l) => l.kind === "code");
    expect(lines.map((l) => l.text)).toEqual(["alpha", "beta"]);
    for (let p = 0; p <= doc.length; p++) expect(inside(p)).toBe(readAll(doc, p));
  });

  it("keeps adjacent blocks distinct with mixed fence styles", () => {
    // A longer or different fence inside never closes the neighbour.
    const doc = "````\n```\ninner\n```\n````\n~~~\ntilde\n~~~\nprose\n";
    const inside = (s: string, off = 0) =>
      isInsideFencedCode(doc, doc.indexOf(s) + off);
    expect(inside("inner", 2)).toBe(true);
    expect(inside("tilde", 2)).toBe(true);
    expect(inside("prose", 2)).toBe(false);
    for (let p = 0; p <= doc.length; p++) {
      expect(isInsideFencedCode(doc, p)).toBe(readAll(doc, p));
    }
  });
});
