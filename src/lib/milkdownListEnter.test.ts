import { type Node, Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { describe, expect, it } from "vitest";
import { listEnterTransaction } from "./milkdownListEnter";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    code_block: { group: "block", content: "text*", code: true },
    hardbreak: { group: "inline", inline: true, leafText: () => "\n" },
    text: { group: "inline" },
  },
});
const p = (...c: (string | Node)[]) =>
  schema.nodes.paragraph.create(
    null,
    c.map((x) => (typeof x === "string" ? schema.text(x) : x)),
  );
const br = () => schema.nodes.hardbreak.create();

/** A state of `blocks` with the cursor at the end of block `at`'s text. */
function stateAt(blocks: Node[], at: number): EditorState {
  const doc = schema.node("doc", null, blocks);
  let pos = 0;
  for (let i = 0; i <= at; i++) pos += doc.child(i).nodeSize;
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos - 1) });
}

describe("listEnterTransaction", () => {
  it("clears an empty item's marker, leaving a blank line, not a newline in the text", () => {
    const state = stateAt([p("intro"), p("- ")], 1);
    const tr = listEnterTransaction(state);
    expect(tr).not.toBeNull();
    const doc = tr?.doc;
    expect(doc?.childCount).toBe(2);
    expect(doc?.child(0).textContent).toBe("intro");
    expect(doc?.child(1).type.name).toBe("paragraph");
    expect(doc?.child(1).textContent).toBe("");
    expect(doc?.textContent.includes("\n")).toBe(false);
  });

  it("clears only the marker after a line break in the paragraph", () => {
    const state = stateAt([p("a", br(), "1. ")], 0);
    const doc = listEnterTransaction(state)?.doc;
    expect(doc?.childCount).toBe(1);
    expect(doc?.child(0).childCount).toBe(2);
    expect(doc?.child(0).firstChild?.text).toBe("a");
    expect(doc?.child(0).lastChild?.type.name).toBe("hardbreak");
  });

  it("continues a non-empty item", () => {
    const state = stateAt([p("- a")], 0);
    expect(listEnterTransaction(state)?.doc.textContent).toBe("- a\n- ");
  });

  it("does nothing in a code block or on a line that is no item", () => {
    expect(
      listEnterTransaction(
        stateAt([schema.nodes.code_block.create(null, schema.text("- "))], 0),
      ),
    ).toBeNull();
    expect(listEnterTransaction(stateAt([p("text")], 0))).toBeNull();
  });
});
