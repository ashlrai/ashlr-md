/**
 * milkdownPasteImage.test.ts — a pasted image becomes an image node in a real
 * Crepe editor and is saved as `![](…)`, not as escaped text.
 */

import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { afterEach, describe, expect, it } from "vitest";
import { insertImageMarkdown } from "./milkdownPasteImage";

const editors: Crepe[] = [];

async function crepeWith(body: string): Promise<Crepe> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const crepe = new Crepe({ root, defaultValue: body });
  await crepe.create();
  editors.push(crepe);
  return crepe;
}

/** Paste `markdown` at `pos`; returns the result, the Markdown and node types. */
function pasteAt(crepe: Crepe, pos: number, markdown: string) {
  return crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)),
    );
    const inserted = insertImageMarkdown(view, ctx.get(parserCtx), markdown);
    const types: string[] = [];
    view.state.doc.descendants((n) => {
      types.push(n.type.name);
    });
    return { inserted, saved: ctx.get(serializerCtx)(view.state.doc), types };
  });
}

afterEach(async () => {
  for (const e of editors.splice(0)) await e.destroy();
  document.body.innerHTML = "";
});

describe("insertImageMarkdown", () => {
  it("inserts an image node mid-paragraph, saved as Markdown image syntax", async () => {
    const crepe = await crepeWith("Hello world");
    const r = pasteAt(crepe, 6, "![](assets/image-1.png)");
    expect(r.inserted).toBe(true);
    expect(r.types).toContain("image");
    expect(r.saved).toBe("Hello![](assets/image-1.png) world\n");
  });

  it("keeps a destination with spaces in angle brackets", async () => {
    const crepe = await crepeWith("");
    const r = pasteAt(crepe, 1, "![](</Users/me/My Notes/assets/a.png>)");
    expect(r.saved).toBe("![](</Users/me/My Notes/assets/a.png>)\n");
  });

  it("changes nothing when the Markdown holds no image", async () => {
    const crepe = await crepeWith("Hello");
    const r = pasteAt(crepe, 1, "just text");
    expect(r.inserted).toBe(false);
    expect(r.saved).toBe("Hello\n");
  });

  it("is needed: insertText leaves the reference as escaped text", async () => {
    const crepe = await crepeWith("Hello");
    const saved = crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText("![](assets/a.png)", 6, 6));
      return ctx.get(serializerCtx)(view.state.doc);
    });
    expect(saved).not.toContain("![](assets/a.png)");
  });
});
