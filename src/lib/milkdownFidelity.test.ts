/**
 * Round-trip fidelity of the WYSIWYG editor, through the same pipeline the
 * app saves with (MarkdownEditor: front matter split off, a real Crepe
 * editor, keepSourceOnSave, CRLF restored, front matter joined back).
 *
 * The corpus (src/lib/__fixtures__/roundtrip/*.md) covers tables
 * (alignment, escaped pipes, an empty cell), footnotes, front matter, raw
 * HTML blocks and inline HTML, math, task lists, nested lists and their
 * markers, hard breaks, reference links and definitions, setext and ATX
 * headings, `*` and `_` emphasis, fences with info strings and tildes,
 * indented code, entities and escapes, trailing whitespace, a missing final
 * newline and CRLF. Each ends with the paragraph "Edit me here.".
 *
 * One typed character in that paragraph rewrote the whole file the
 * serializer's way; now only that paragraph is written, and the rest of the
 * file is byte for byte what was loaded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// KaTeX (Crepe's math) refuses to render in quirks mode, which happy-dom's
// document reports; it checks once, when it loads.
vi.hoisted(() => {
  Object.defineProperty(document, "compatMode", {
    value: "CSS1Compat",
    configurable: true,
  });
});

import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import {
  inLineBreaks,
  joinFrontmatter,
  splitFrontmatter,
  usesCrlf,
} from "./frontmatter";
import {
  alignBlocks,
  type BlockRange,
  blockStyle,
  codeBlockText,
  dropEmptyLineBreaks,
  keepSourceOnSave,
  keepSpellings,
  listSpread,
  type MdNode,
  type PmNode,
  restyled,
  sourceRanges,
  spliceEdited,
} from "./milkdownFidelity";

const fixtures = import.meta.glob<string>("./__fixtures__/roundtrip/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Fixtures for an edit inside a block: each has the word EDIT in every
 * block under test, and an X is typed after each one. Only those blocks
 * change, and each keeps the way its source spelled it.
 */
const editedFixtures = import.meta.glob<string>(
  "./__fixtures__/roundtrip/edited/*.md",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);

const editors: Crepe[] = [];

afterEach(async () => {
  for (const e of editors.splice(0)) await e.destroy();
  document.body.innerHTML = "";
});

interface Opened {
  crepe: Crepe;
  /** What the app would save now (null: no change was reported). */
  saved: () => string | null;
}

/** Open `raw` as MarkdownEditor does, recording what it would save. */
async function open(raw: string): Promise<Opened> {
  const { frontmatter, body } = splitFrontmatter(raw);
  const crlf = usesCrlf(raw);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const crepe = new Crepe({ root, defaultValue: body });
  let last: string | null = null;
  keepSourceOnSave(crepe, body, (written) => {
    last = joinFrontmatter(frontmatter, inLineBreaks(written, crlf));
  });
  await crepe.create();
  editors.push(crepe);
  return { crepe, saved: () => last };
}

/** Type `text` at `offset` characters into the first text containing `needle`. */
function typeInto(crepe: Crepe, needle: string, offset: number, text: string) {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    let pos = -1;
    view.state.doc.descendants((n, p) => {
      if (pos === -1 && n.isText && n.text?.includes(needle)) {
        pos = p + (n.text.indexOf(needle) + offset);
      }
    });
    if (pos === -1) throw new Error(`no text "${needle}"`);
    view.dispatch(view.state.tr.insertText(text, pos, pos));
  });
}

/** Type `text` right after the `nth` (from 0) occurrence of `needle` in the doc's text. */
function typeAfterNth(crepe: Crepe, needle: string, nth: number, text: string) {
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const found: number[] = [];
    view.state.doc.descendants((n, p) => {
      if (!n.isText || !n.text) return;
      let at = n.text.indexOf(needle);
      while (at !== -1) {
        found.push(p + at + needle.length);
        at = n.text.indexOf(needle, at + 1);
      }
    });
    const pos = found[nth];
    if (pos === undefined) throw new Error(`no ${nth}th "${needle}"`);
    view.dispatch(view.state.tr.insertText(text, pos, pos));
  });
}

/** Wait for the listener's debounced markdownUpdated. */
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("WYSIWYG round trip: one edit elsewhere keeps the rest byte for byte", () => {
  for (const [file, raw] of Object.entries(fixtures)) {
    const name = file.split("/").pop();
    it(`${name}`, async () => {
      const ed = await open(raw);
      await settle();
      // Opening reports no change: nothing to save.
      expect(ed.saved()).toBeNull();
      typeInto(ed.crepe, "Edit me here.", "Edit me ".length, "X");
      await settle();
      expect(ed.saved()).toBe(raw.replace("Edit me here.", "Edit me Xhere."));
    });
  }
});

describe("WYSIWYG round trip: an edit inside a block keeps its spelling", () => {
  for (const [file, raw] of Object.entries(editedFixtures)) {
    const name = file.split("/").pop();
    it(`${name}`, async () => {
      const ed = await open(raw);
      await settle();
      // Opening changes nothing (a report of the text as it is, at most).
      expect(ed.saved() ?? raw).toBe(raw);
      // Type from the last EDIT back, so the earlier positions stay put.
      const count = raw.split("EDIT").length - 1;
      for (let i = count - 1; i >= 0; i--) typeAfterNth(ed.crepe, "EDIT", i, "X");
      await settle();
      expect(ed.saved()).toBe(raw.replaceAll("EDIT", "EDITX"));
    });
  }
});

describe("WYSIWYG round trip: an edit inside a block rewrites only that block", () => {
  it("a tight bullet list stays tight with its markers", async () => {
    const raw = "Intro.\n\n- one\n- two\n  - nested\n\nOutro.\n";
    const ed = await open(raw);
    typeInto(ed.crepe, "two", 3, "!");
    await settle();
    // `-` is written as Milkdown's `*` in the edited list, but tight: it
    // used to gain a blank line between every item.
    const saved = ed.saved() as string;
    expect(saved.startsWith("Intro.\n\n")).toBe(true);
    expect(saved.endsWith("\n\nOutro.\n")).toBe(true);
    expect(saved).toMatch(
      /^Intro\.\n\n[*-] one\n[*-] two!\n {2}[*-] nested\n\nOutro\.\n$/,
    );
  });

  it("an edited table keeps an empty cell empty", async () => {
    const raw = "| a | b |\n| - | - |\n| x |   |\n|   | y |\n";
    const ed = await open(raw);
    typeInto(ed.crepe, "x", 1, "!");
    await settle();
    const saved = ed.saved() as string;
    // It used to be written `| x! | <br /> |`.
    expect(saved).not.toContain("<br");
    expect(saved).toMatch(/\| x! +\| +\|/);
    expect(saved).toMatch(/\| +\| y +\|/);
  });

  it("keeps a link definition the edited paragraph used, and the untouched ones", async () => {
    const raw =
      "First [a][x] here.\n\n[x]: https://example.com/x\n\nSecond [b][y].\n\n[y]: https://example.com/y\n";
    const ed = await open(raw);
    typeInto(ed.crepe, "First", 0, "The ");
    await settle();
    const saved = ed.saved() as string;
    // The edited paragraph's link is written inline; its definition stays
    // (another reference may use it), and the rest is as it was.
    expect(saved).toContain("The First [a](https://example.com/x) here.");
    expect(saved).toContain("[x]: https://example.com/x");
    expect(saved.endsWith("\n\nSecond [b][y].\n\n[y]: https://example.com/y\n")).toBe(
      true,
    );
  });

  it("deleting a block keeps its neighbours' text", async () => {
    const raw = "Setext\n======\n\nDrop me.\n\n+ plus\n+ list\n";
    const ed = await open(raw);
    ed.crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const from = doc.child(0).nodeSize;
      const to = from + doc.child(1).nodeSize;
      view.dispatch(view.state.tr.delete(from, to));
    });
    await settle();
    expect(ed.saved()).toBe("Setext\n======\n\n+ plus\n+ list\n");
  });

  it("an edit before a last list, table or rule leaves that block as it was", async () => {
    // The editor adds an empty paragraph after such a block on the first
    // edit, which made the edit reach the end: the rule was written `***`.
    for (const last of ["- - -", "+ a\n+ b", "| a |\n|---|\n| b |"]) {
      const raw = `Para here.\n\n${last}\n`;
      const ed = await open(raw);
      typeInto(ed.crepe, "Para here.", 4, "X");
      await settle();
      expect(ed.saved()).toBe(raw.replace("Para here.", "ParaX here."));
    }
  });

  it("reads an inline <br> as HTML and a lone <br /> as an empty paragraph", async () => {
    const ed = await open("A<br>b\n\n<br />\n\nC\n");
    const kinds = ed.crepe.editor.action((ctx) => {
      const doc = ctx.get(editorViewCtx).state.doc;
      const out: string[] = [];
      doc.forEach((block) => {
        const inner: string[] = [];
        block.forEach((n) => {
          inner.push(n.type.name);
        });
        out.push(`${block.type.name}[${inner.join(",")}]`);
      });
      return out;
    });
    // The <br> in "A<br>b" was dropped: the paragraph read "Ab".
    expect(kinds).toEqual([
      "paragraph[text,html,text]",
      "paragraph[]",
      "paragraph[text]",
    ]);
  });

  it("undoing the only edit saves the file as it was", async () => {
    const raw = "Setext\n======\n\n* a\n* b\n\nEdit me here.\n";
    const ed = await open(raw);
    typeInto(ed.crepe, "Edit me here.", 0, "Z");
    await settle();
    expect(ed.saved()).not.toBe(raw);
    ed.crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let pos = -1;
      view.state.doc.descendants((n, p) => {
        if (n.isText && n.text?.startsWith("ZEdit")) pos = p;
      });
      view.dispatch(view.state.tr.delete(pos, pos + 1));
    });
    await settle();
    expect(ed.saved()).toBe(raw);
  });

  it("is what the serializer writes when the source cannot be mapped", async () => {
    const ed = await open("Plain.\n");
    const whole = ed.crepe.editor.action((ctx) =>
      ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc),
    );
    expect(whole).toBe("Plain.\n");
  });
});

describe("sourceRanges / spliceEdited", () => {
  /** A stand-in top-level ProseMirror node, equal by label. */
  const pm = (labels: string[]): PmNode => ({
    childCount: labels.length,
    child: (i: number) =>
      ({
        childCount: 0,
        child: () => {
          throw new Error("leaf");
        },
        eq: (o: PmNode) => (o as unknown as { label: string }).label === labels[i],
        type: { name: "paragraph" },
        content: { size: 0 },
        label: labels[i],
      }) as unknown as PmNode,
    eq: () => false,
    type: { name: "doc" },
    content: { size: 0 },
  });
  const md = (ranges: [string, number, number][]) => ({
    type: "root",
    children: ranges.map(([type, start, end]) => ({
      type,
      position: { start: { offset: start }, end: { offset: end } },
    })),
  });

  it("maps blocks one to one, setting definitions aside", () => {
    const tree = md([
      ["paragraph", 0, 3],
      ["definition", 5, 9],
      ["paragraph", 11, 14],
    ]);
    expect(sourceRanges(tree, 2)).toMatchObject({
      blocks: [
        { start: 0, end: 3 },
        { start: 11, end: 14 },
      ],
      definitions: [{ start: 5, end: 9 }],
    });
    // A last empty paragraph the editor adds maps to the end.
    expect(sourceRanges(tree, 3)?.blocks.at(-1)).toEqual({ start: 14, end: 14 });
    expect(sourceRanges(tree, 5)).toBeNull();
    expect(sourceRanges({ type: "root", children: [] }, 0)).toBeNull();
  });

  it("rewrites only the changed run, keeping head, tail and gaps", () => {
    const original = "\nAAA\n\n\nBBB\n\nCCC";
    const blocks: BlockRange[] = [
      { start: 1, end: 4 },
      { start: 7, end: 10 },
      { start: 12, end: 15 },
    ];
    const out = spliceEdited({
      original,
      map: { blocks, definitions: [] },
      initial: pm(["A", "B", "C"]),
      current: pm(["A", "B2", "C"]),
      serializeRange: (from, to) => {
        expect([from, to]).toEqual([1, 2]);
        return "bbb\n";
      },
    });
    expect(out).toBe("\nAAA\n\n\nbbb\n\nCCC");
    // Nothing changed: the original, untouched.
    expect(
      spliceEdited({
        original,
        map: { blocks, definitions: [] },
        initial: pm(["A", "B", "C"]),
        current: pm(["A", "B", "C"]),
        serializeRange: () => "never",
      }),
    ).toBe(original);
  });

  it("lines blocks up by kind when the counts differ", () => {
    // remark: paragraph, html, paragraph; the editor: paragraph, table, html
    // block, paragraph (a node of its own in between).
    expect(
      alignBlocks(
        ["paragraph", "html", "paragraph"],
        ["paragraph", "table", "paragraph", "paragraph"],
      ),
    ).toEqual([0, -1, 1, 2]);
    expect(alignBlocks(["list", "code"], ["bullet_list", "code_block"])).toEqual([
      0, 1,
    ]);
    expect(
      alignBlocks(["heading", "orphan", "paragraph"], ["heading", "paragraph"]),
    ).toEqual([0, 2]);
    const tree = md([
      ["heading", 0, 3],
      ["thing", 5, 9],
      ["paragraph", 11, 14],
    ]);
    // It used to be null: the whole file was then written by the serializer.
    expect(
      sourceRanges(tree, 5, ["heading", "table", "table", "table", "paragraph"]),
    ).toMatchObject({
      blocks: [{ start: 0, end: 3 }, null, null, null, { start: 11, end: 14 }],
      orphans: [{ start: 5, end: 9 }],
    });
    expect(sourceRanges(tree, 5)).toBeNull();
    // One node more, but not the editor's last paragraph: matched by kind,
    // not taken as one to one plus that paragraph.
    expect(
      sourceRanges(tree, 4, ["heading", "table", "thing", "paragraph"]),
    ).toMatchObject({
      blocks: [
        { start: 0, end: 3 },
        null,
        { start: 5, end: 9 },
        { start: 11, end: 14 },
      ],
    });
  });

  it("rewrites only the region around a node with no block of its own", () => {
    // Blocks A, (B: no range), C, D, E; the edit is in D.
    const original = "AAA\n\nbbb\n\nCCC\n\nDDD\n\nEEE\n";
    const blocks = [
      { start: 0, end: 3 },
      null,
      { start: 10, end: 13 },
      { start: 15, end: 18 },
      { start: 20, end: 23 },
    ];
    const run = (current: string[]) => {
      const calls: [number, number][] = [];
      const out = spliceEdited({
        original,
        map: { blocks, definitions: [], orphans: [{ start: 5, end: 8 }] },
        initial: pm(["A", "B", "C", "D", "E"]),
        current: pm(current),
        serializeRange: (from, to) => {
          calls.push([from, to]);
          return current.slice(from, to).join("\n\n");
        },
      });
      return { out, calls };
    };
    // Away from it: only D is written.
    expect(run(["A", "B", "C", "D2", "E"])).toEqual({
      out: "AAA\n\nbbb\n\nCCC\n\nD2\n\nEEE\n",
      calls: [[3, 4]],
    });
    // Next to it: the region from A's end to D's start is written, with B,
    // and A, D and E are kept as they were.
    expect(run(["A", "B", "C2", "D", "E"])).toEqual({
      out: "AAA\n\nB\n\nC2\n\nDDD\n\nEEE\n",
      calls: [[1, 3]],
    });
  });

  it("reads a block's style from its source", () => {
    const list = (src: string, ordered: boolean) => {
      const items: MdNode[] = [];
      let at = 0;
      for (const line of src.split("\n")) {
        items.push({
          type: "listItem",
          position: { start: { offset: at }, end: { offset: at + line.length } },
        });
        at += line.length + 1;
      }
      return {
        type: "list",
        ordered,
        position: { start: { offset: 0 }, end: { offset: src.length } },
        children: items,
      };
    };
    const style = (src: string, ordered = false) => blockStyle(src, list(src, ordered));
    expect(style("- a\n- b")).toMatchObject({ bullet: "-" });
    expect(style("+ a\n+ b")).toMatchObject({ bullet: "+" });
    expect(style("1. a\n1. b", true)).toEqual({
      bulletOrdered: ".",
      incrementListMarker: false,
    });
    expect(style("1) a\n2) b", true)).toEqual({ bulletOrdered: ")" });
    expect(style("7. only", true)).toEqual({ bulletOrdered: "." });
    expect(blockStyle("Para.", { type: "paragraph" })).toEqual({});
    const heading = (src: string, depth: number) =>
      blockStyle(src, {
        type: "heading",
        depth,
        position: { start: { offset: 0 }, end: { offset: src.length } },
      });
    expect(heading("Title\n=====", 1)).toEqual({ setext: true });
    expect(heading("Title\n---", 2)).toEqual({ setext: true });
    expect(heading("# Title", 1)).toEqual({});
    expect(heading("### Three", 3)).toEqual({});
    expect(heading("## Two ##", 2)).toEqual({ closeAtx: true });
    const setext = {
      type: "heading",
      depth: 1,
      position: { start: { offset: 0 }, end: { offset: 9 } },
    };
    expect(restyled("Title X\n=======\n", "Title\n===", setext)).toBe("Title X\n===\n");
    expect(restyled("# Title X\n", "Title\n===", setext)).toBe("# Title X\n");
  });

  it("keeps trailing-space breaks where the block used them", () => {
    const tree = () => ({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "a" }, { type: "break" }],
        },
        { type: "heading", children: [{ type: "break" }] },
      ],
    });
    const spaced = tree();
    keepSpellings(spaced, "a   \nb");
    expect(spaced.children[0].children[1]).toEqual({ type: "html", value: "   \n" });
    // A heading holds one line: left to the serializer.
    expect(spaced.children[1].children[0]).toEqual({ type: "break" });
    for (const source of ["a\\\nb", "a  \nb\\\nc", "plain"]) {
      const t = tree();
      keepSpellings(t, source);
      expect(t).toEqual(tree());
    }
  });

  it("writes characters as the references the block wrote them as", () => {
    const para = (value: string) => ({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value }] }],
    });
    const spelled = (value: string, source: string) => {
      const t = para(value);
      keepSpellings(t, source);
      return t.children[0].children;
    };
    expect(spelled("a\u00a0b X", "a&nbsp;b")).toEqual([
      { type: "text", value: "a" },
      { type: "html", value: "&nbsp;" },
      { type: "text", value: "b X" },
    ]);
    // One of each spelling, in order, while the count is the same.
    expect(spelled("© ©", "&copy; &#169;")).toEqual([
      { type: "html", value: "&copy;" },
      { type: "text", value: " " },
      { type: "html", value: "&#169;" },
    ]);
    expect(spelled("& &", "& &amp;")).toEqual([
      { type: "text", value: "& " },
      { type: "html", value: "&amp;" },
    ]);
    // A count that changed, with two ways: as itself.
    expect(spelled("& & &", "& &amp;")).toEqual([{ type: "text", value: "& & &" }]);
    // One way: that one, for every occurrence.
    expect(spelled("<x> <", "&lt;x&gt;")).toEqual([
      { type: "html", value: "&lt;" },
      { type: "text", value: "x" },
      { type: "html", value: "&gt;" },
      { type: "text", value: " " },
      { type: "html", value: "&lt;" },
    ]);
    expect(spelled("plain", "&bogus; plain")).toEqual([
      { type: "text", value: "plain" },
    ]);
  });

  it("drops only a <br /> that is all its paragraph or cell holds", () => {
    const br = { type: "html", value: "<br />" };
    const tree = {
      type: "root",
      children: [
        { type: "paragraph", children: [{ ...br }] },
        { type: "paragraph", children: [{ type: "text", value: "a" }, { ...br }] },
        { type: "tableCell", children: [{ type: "html", value: "<br>" }] },
      ],
    };
    dropEmptyLineBreaks(tree);
    expect(tree.children.map((c) => c.children.length)).toEqual([0, 2, 0]);
  });

  it("writes an edited code block with its own fence and info string", () => {
    const code = (src: string, lang: string | null) => ({
      type: "code",
      lang,
      position: { start: { offset: 0 }, end: { offset: src.length } },
    });
    const src = '~~~ts title="a.ts"\nold\n~~~~';
    expect(codeBlockText(src, code(src, "ts"), "ts", "new\nline")).toBe(
      '~~~ts title="a.ts"\nnew\nline\n~~~~',
    );
    // A new language replaces the first word only.
    expect(codeBlockText(src, code(src, "ts"), "js", "x")).toBe(
      '~~~js title="a.ts"\nx\n~~~~',
    );
    // Code that would close the fence, or an unclosed fence: the serializer's.
    expect(codeBlockText(src, code(src, "ts"), "ts", "a\n~~~~~\nb")).toBeNull();
    const open = "```\nnever closed";
    expect(codeBlockText(open, code(open, null), "", "x")).toBeNull();
  });

  it("reads Milkdown's string spread as remark's boolean", () => {
    expect(listSpread("true")).toBe(true);
    expect(listSpread(true)).toBe(true);
    expect(listSpread("false")).toBe(false);
    expect(listSpread(undefined)).toBe(false);
  });
});
