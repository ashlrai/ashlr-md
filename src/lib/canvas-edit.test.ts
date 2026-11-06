import { describe, expect, it } from "vitest";
import { type CanvasEdit, editCanvas } from "./canvas-edit";

const node = {
  id: "a",
  type: "text",
  x: 0,
  y: 2,
  width: 100,
  height: 80,
  text: "old",
  custom: { nested: [1, null, "x"] },
};
const document = {
  nodes: [
    node,
    { ...node, id: "b" },
    { id: "future", type: "unknown", custom: true },
    null,
  ],
  edges: [{ id: "edge", plugin: [1, 2] }],
  metadata: { plugin: "keep" },
};
const source = JSON.stringify(document);

describe("lossless canvas editing", () => {
  it.each([
    [
      { type: "move_node", id: "a", x: -20.5, y: 30 },
      { x: -20.5, y: 30 },
    ],
    [
      { type: "resize_node", id: "a", width: 200, height: 120.5 },
      { width: 200, height: 120.5 },
    ],
    [{ type: "edit_text", id: "a", text: "\n# New 🪐\n" }, { text: "\n# New 🪐\n" }],
  ] satisfies [
    CanvasEdit,
    object,
  ][])("changes only target fields for %j", (edit, patch) => {
    expect(JSON.parse(editCanvas(source, edit))).toEqual({
      ...document,
      nodes: [{ ...node, ...patch }, ...document.nodes.slice(1)],
    });
    expect(JSON.parse(source)).toEqual(document);
  });
  it("round trips unknown fields through successive edits and accepts empty text", () => {
    const moved = editCanvas(source, { type: "move_node", id: "a", x: 5, y: 6 });
    const restored = editCanvas(moved, { type: "move_node", id: "a", x: 0, y: 2 });
    expect(JSON.parse(restored)).toEqual(document);
    expect(
      JSON.parse(editCanvas(source, { type: "edit_text", id: "a", text: "" })).nodes[0]
        .text,
    ).toBe("");
  });
  it("keeps the source bytes for no-op edits", () => {
    expect(editCanvas(source, { type: "move_node", id: "a", x: 0, y: 2 })).toBe(source);
  });
  it.each([
    { type: "move_node", id: "a", x: Number.NaN, y: 2 },
    { type: "move_node", id: "a", x: 1, y: Number.POSITIVE_INFINITY },
    { type: "resize_node", id: "a", width: 0, height: 1 },
    { type: "resize_node", id: "a", width: 1, height: -1 },
    { type: "resize_node", id: "a", width: 1, height: Number.NaN },
    { type: "edit_text", id: "missing", text: "x" },
    { type: "edit_text", id: "future", text: "x" },
  ] satisfies CanvasEdit[])("rejects unsafe edit %j", (edit) => {
    expect(() => editCanvas(source, edit)).toThrow();
  });
  it.each([
    "{",
    "null",
    "[]",
    '{"nodes":{}}',
    JSON.stringify({ nodes: [node, node] }),
    JSON.stringify({ nodes: [{ ...node, type: "link", url: "https://example.com" }] }),
  ])("rejects invalid or ambiguous target in %s", (input) => {
    expect(() =>
      editCanvas(input, { type: "edit_text", id: "a", text: "new" }),
    ).toThrow();
  });
});
