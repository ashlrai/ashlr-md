import { describe, expect, it } from "vitest";
import type { CanvasNode, CanvasNodeBase } from "./canvas";
import {
  CANVAS_PRESET_COLORS,
  applyCanvasOp,
  buildCanvasEditor,
  canvasBounds,
  canvasEditorToCanvas,
  fitTransform,
  nodeAnchor,
  parseCanvas,
  redoCanvasOp,
  resolveCanvasColor,
  serializeCanvas,
  undoCanvasOp,
} from "./canvas";

// ---------------------------------------------------------------------------
// parseCanvas
// ---------------------------------------------------------------------------

describe("parseCanvas", () => {
  it("parses a valid canvas with all node types and edges", () => {
    const input = JSON.stringify({
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "hello" },
        {
          id: "b",
          type: "file",
          x: 200,
          y: 0,
          width: 100,
          height: 50,
          file: "note.md",
        },
        {
          id: "c",
          type: "link",
          x: 400,
          y: 0,
          width: 100,
          height: 50,
          url: "https://example.com",
        },
        {
          id: "d",
          type: "group",
          x: 0,
          y: 100,
          width: 300,
          height: 200,
          label: "G",
          background: "bg.png",
          backgroundStyle: "cover",
        },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          fromSide: "right",
          toSide: "left",
          fromEnd: "none",
          toEnd: "arrow",
          color: "1",
          label: "edge",
        },
      ],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes).toHaveLength(4);
    expect(result.canvas.edges).toHaveLength(1);

    const text = result.canvas.nodes[0];
    expect(text.type).toBe("text");
    if (text.type === "text") expect(text.text).toBe("hello");

    const file = result.canvas.nodes[1];
    expect(file.type).toBe("file");
    if (file.type === "file") expect(file.file).toBe("note.md");

    const link = result.canvas.nodes[2];
    expect(link.type).toBe("link");
    if (link.type === "link") expect(link.url).toBe("https://example.com");

    const group = result.canvas.nodes[3];
    expect(group.type).toBe("group");
    if (group.type === "group") {
      expect(group.label).toBe("G");
      expect(group.backgroundStyle).toBe("cover");
    }

    const edge = result.canvas.edges[0];
    expect(edge.fromSide).toBe("right");
    expect(edge.toSide).toBe("left");
    expect(edge.fromEnd).toBe("none");
    expect(edge.toEnd).toBe("arrow");
    expect(edge.color).toBe("1");
    expect(edge.label).toBe("edge");
  });

  it("returns ok:false for invalid JSON", () => {
    const result = parseCanvas("{not json}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid JSON/);
  });

  it("returns ok:false for JSON array at top level", () => {
    const result = parseCanvas("[]");
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for JSON primitive at top level", () => {
    expect(parseCanvas("null").ok).toBe(false);
    expect(parseCanvas('"string"').ok).toBe(false);
    expect(parseCanvas("42").ok).toBe(false);
  });

  it("coerces missing nodes/edges to empty arrays", () => {
    const result = parseCanvas("{}");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes).toEqual([]);
    expect(result.canvas.edges).toEqual([]);
  });

  it("coerces non-array nodes/edges to empty arrays", () => {
    const result = parseCanvas(JSON.stringify({ nodes: "bad", edges: 42 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes).toEqual([]);
    expect(result.canvas.edges).toEqual([]);
  });

  it("drops nodes missing required id", () => {
    const input = JSON.stringify({
      nodes: [
        { type: "text", x: 0, y: 0, width: 100, height: 50, text: "no id" },
        { id: "ok", type: "text", x: 0, y: 0, width: 100, height: 50, text: "good" },
      ],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes).toHaveLength(1);
    expect(result.canvas.nodes[0].id).toBe("ok");
  });

  it("drops nodes with non-finite geometry", () => {
    const input = JSON.stringify({
      nodes: [
        {
          id: "inf",
          type: "text",
          x: Infinity,
          y: 0,
          width: 100,
          height: 50,
          text: "",
        },
        { id: "nan", type: "text", x: 0, y: NaN, width: 100, height: 50, text: "" },
        { id: "str", type: "text", x: "0", y: 0, width: 100, height: 50, text: "" },
        { id: "ok", type: "text", x: 0, y: 0, width: 100, height: 50, text: "good" },
      ],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes).toHaveLength(1);
  });

  it("drops nodes with unknown type but keeps valid ones", () => {
    const input = JSON.stringify({
      nodes: [
        { id: "x", type: "video", x: 0, y: 0, width: 100, height: 50 },
        { id: "ok", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
      ],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes).toHaveLength(1);
  });

  it("drops file node missing file field", () => {
    const input = JSON.stringify({
      nodes: [{ id: "f", type: "file", x: 0, y: 0, width: 100, height: 50 }],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes).toHaveLength(0);
  });

  it("drops link node missing url field", () => {
    const input = JSON.stringify({
      nodes: [{ id: "l", type: "link", x: 0, y: 0, width: 100, height: 50 }],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes).toHaveLength(0);
  });

  it("parses file node with optional subpath", () => {
    const input = JSON.stringify({
      nodes: [
        {
          id: "f",
          type: "file",
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          file: "doc.md",
          subpath: "#heading",
        },
      ],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.canvas.nodes[0];
    if (node.type === "file") expect(node.subpath).toBe("#heading");
  });

  it("drops edges missing required fields", () => {
    const input = JSON.stringify({
      edges: [
        { id: "e1", fromNode: "a" }, // missing toNode
        { id: "e2", toNode: "b" }, // missing fromNode
        { fromNode: "a", toNode: "b" }, // missing id
        { id: "e4", fromNode: "a", toNode: "b" }, // valid
      ],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.edges).toHaveLength(1);
    expect(result.canvas.edges[0].id).toBe("e4");
  });

  it("drops individual malformed items in mixed arrays without failing the whole canvas", () => {
    const input = JSON.stringify({
      nodes: [
        null,
        42,
        "string",
        { id: "ok", type: "text", x: 0, y: 0, width: 100, height: 50, text: "kept" },
      ],
      edges: [null, { id: "bad" }, { id: "ok", fromNode: "a", toNode: "b" }],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes).toHaveLength(1);
    expect(result.canvas.edges).toHaveLength(1);
  });

  it("ignores invalid side/end values on edges (omits them)", () => {
    const input = JSON.stringify({
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          fromSide: "diagonal",
          toEnd: "double",
        },
      ],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edge = result.canvas.edges[0];
    expect(edge.fromSide).toBeUndefined();
    expect(edge.toEnd).toBeUndefined();
  });

  it("preserves color on nodes and passes it through", () => {
    const input = JSON.stringify({
      nodes: [
        {
          id: "a",
          type: "text",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          text: "",
          color: "3",
        },
        {
          id: "b",
          type: "text",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          text: "",
          color: "#ff00ff",
        },
      ],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes[0].color).toBe("3");
    expect(result.canvas.nodes[1].color).toBe("#ff00ff");
  });
});

// ---------------------------------------------------------------------------
// canvasBounds
// ---------------------------------------------------------------------------

describe("canvasBounds", () => {
  it("returns zero box for empty array", () => {
    const b = canvasBounds([]);
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 });
  });

  it("returns exact box for a single node", () => {
    const node: CanvasNode = {
      id: "a",
      type: "text",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      text: "",
    };
    const b = canvasBounds([node]);
    expect(b).toEqual({
      minX: 10,
      minY: 20,
      maxX: 110,
      maxY: 70,
      width: 100,
      height: 50,
    });
  });

  it("spans all nodes correctly", () => {
    const nodes: CanvasNode[] = [
      { id: "a", type: "text", x: -50, y: -30, width: 20, height: 20, text: "" },
      { id: "b", type: "text", x: 100, y: 80, width: 60, height: 40, text: "" },
    ];
    const b = canvasBounds(nodes);
    expect(b.minX).toBe(-50);
    expect(b.minY).toBe(-30);
    expect(b.maxX).toBe(160); // 100 + 60
    expect(b.maxY).toBe(120); // 80 + 40
    expect(b.width).toBe(210);
    expect(b.height).toBe(150);
  });

  it("handles nodes with zero size", () => {
    const node: CanvasNode = {
      id: "a",
      type: "text",
      x: 5,
      y: 5,
      width: 0,
      height: 0,
      text: "",
    };
    const b = canvasBounds([node]);
    expect(b).toEqual({ minX: 5, minY: 5, maxX: 5, maxY: 5, width: 0, height: 0 });
  });
});

// ---------------------------------------------------------------------------
// fitTransform
// ---------------------------------------------------------------------------

describe("fitTransform", () => {
  it("fits content into viewport with padding", () => {
    const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 200, width: 400, height: 200 };
    const t = fitTransform(bounds, 800, 600, 20);
    // availW=760, availH=560; scale = min(760/400, 560/200) = min(1.9, 2.8) = 1.9 → clamped to 2? no, 1.9 < 2
    expect(t.scale).toBeCloseTo(1.9);
    // scaledW = 400*1.9 = 760, scaledH = 200*1.9 = 380
    // offsetX = (800 - 760)/2 - 0 = 20
    // offsetY = (600 - 380)/2 - 0 = 110
    expect(t.offsetX).toBeCloseTo(20);
    expect(t.offsetY).toBeCloseTo(110);
  });

  it("clamps scale to maxScale=2", () => {
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 };
    const t = fitTransform(bounds, 2000, 2000, 0);
    expect(t.scale).toBe(2);
  });

  it("clamps scale to minScale=0.05", () => {
    const bounds = {
      minX: 0,
      minY: 0,
      maxX: 100000,
      maxY: 100000,
      width: 100000,
      height: 100000,
    };
    const t = fitTransform(bounds, 500, 500, 0);
    expect(t.scale).toBe(0.05);
  });

  it("centers content in viewport", () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100 };
    const t = fitTransform(bounds, 400, 400, 0);
    // scale = min(400/100, 400/100) = 4 → clamped to 2
    expect(t.scale).toBe(2);
    // scaledW=200, scaledH=200; offsetX=(400-200)/2=100; offsetY=(400-200)/2=100
    expect(t.offsetX).toBeCloseTo(100);
    expect(t.offsetY).toBeCloseTo(100);
  });

  it("handles offset bounds (non-zero minX/minY)", () => {
    const bounds = {
      minX: 200,
      minY: 100,
      maxX: 300,
      maxY: 200,
      width: 100,
      height: 100,
    };
    const t = fitTransform(bounds, 400, 400, 0);
    expect(t.scale).toBe(2);
    // scaledW=200; offsetX = (400-200)/2 - 200*2 = 100 - 400 = -300
    expect(t.offsetX).toBeCloseTo(-300);
    expect(t.offsetY).toBeCloseTo(-100);
  });

  it("handles zero-size bounds without throwing", () => {
    const bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    const t = fitTransform(bounds, 800, 600, 20);
    expect(t.scale).toBe(1); // default for zero bounds
    expect(typeof t.offsetX).toBe("number");
    expect(typeof t.offsetY).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// nodeAnchor
// ---------------------------------------------------------------------------

describe("nodeAnchor", () => {
  const node: CanvasNodeBase = { id: "n", x: 100, y: 100, width: 200, height: 100 };
  // center = (200, 150)

  it("returns top anchor for explicit top side", () => {
    const a = nodeAnchor(node, "top", { x: 0, y: 0 });
    expect(a).toEqual({ x: 200, y: 100 });
  });

  it("returns bottom anchor for explicit bottom side", () => {
    const a = nodeAnchor(node, "bottom", { x: 0, y: 0 });
    expect(a).toEqual({ x: 200, y: 200 });
  });

  it("returns left anchor for explicit left side", () => {
    const a = nodeAnchor(node, "left", { x: 0, y: 0 });
    expect(a).toEqual({ x: 100, y: 150 });
  });

  it("returns right anchor for explicit right side", () => {
    const a = nodeAnchor(node, "right", { x: 0, y: 0 });
    expect(a).toEqual({ x: 300, y: 150 });
  });

  it("auto-picks right when toward is to the right", () => {
    const a = nodeAnchor(node, undefined, { x: 500, y: 150 }); // dx=300, dy=0
    expect(a).toEqual({ x: 300, y: 150 });
  });

  it("auto-picks left when toward is to the left", () => {
    const a = nodeAnchor(node, undefined, { x: -100, y: 150 }); // dx=-300, dy=0
    expect(a).toEqual({ x: 100, y: 150 });
  });

  it("auto-picks bottom when toward is below", () => {
    const a = nodeAnchor(node, undefined, { x: 200, y: 400 }); // dx=0, dy=250
    expect(a).toEqual({ x: 200, y: 200 });
  });

  it("auto-picks top when toward is above", () => {
    const a = nodeAnchor(node, undefined, { x: 200, y: 0 }); // dx=0, dy=-150
    expect(a).toEqual({ x: 200, y: 100 });
  });

  it("prefers horizontal when |dx| > |dy|", () => {
    // dx=200 dominates dy=50
    const a = nodeAnchor(node, undefined, { x: 400, y: 200 });
    expect(a.x).toBe(300); // right side
    expect(a.y).toBe(150);
  });

  it("prefers vertical when |dy| > |dx|", () => {
    // dy=200 dominates dx=50
    const a = nodeAnchor(node, undefined, { x: 250, y: 350 });
    expect(a.x).toBe(200); // bottom side
    expect(a.y).toBe(200);
  });

  it("tie-breaks to horizontal when |dx| === |dy|", () => {
    // dx=100, dy=100 — horizontal wins (>=)
    const a = nodeAnchor(node, undefined, { x: 300, y: 250 });
    expect(a.x).toBe(300); // right
    expect(a.y).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// resolveCanvasColor / CANVAS_PRESET_COLORS
// ---------------------------------------------------------------------------

describe("resolveCanvasColor", () => {
  it("resolves preset '1' to red", () => {
    expect(resolveCanvasColor("1")).toBe("#e93147");
  });

  it("resolves preset '2' to orange", () => {
    expect(resolveCanvasColor("2")).toBe("#ec7500");
  });

  it("resolves preset '3' to yellow", () => {
    expect(resolveCanvasColor("3")).toBe("#e0ac00");
  });

  it("resolves preset '4' to green", () => {
    expect(resolveCanvasColor("4")).toBe("#08b94e");
  });

  it("resolves preset '5' to cyan", () => {
    expect(resolveCanvasColor("5")).toBe("#00bfbc");
  });

  it("resolves preset '6' to purple", () => {
    expect(resolveCanvasColor("6")).toBe("#9065c0");
  });

  it("passes through hex values unchanged", () => {
    expect(resolveCanvasColor("#ff00ff")).toBe("#ff00ff");
    expect(resolveCanvasColor("#aabbcc")).toBe("#aabbcc");
  });

  it("returns undefined for undefined input", () => {
    expect(resolveCanvasColor(undefined)).toBeUndefined();
  });

  it("CANVAS_PRESET_COLORS has all 6 entries", () => {
    expect(Object.keys(CANVAS_PRESET_COLORS)).toHaveLength(6);
    for (let i = 1; i <= 6; i++) {
      expect(CANVAS_PRESET_COLORS[String(i)]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

// ---------------------------------------------------------------------------
// serializeCanvas / round-trip
// ---------------------------------------------------------------------------

describe("serializeCanvas", () => {
  it("round-trips a parsed canvas through serialize → parse", () => {
    const original = JSON.stringify({
      nodes: [
        { id: "a", type: "text", x: 10, y: 20, width: 100, height: 50, text: "hi" },
      ],
      edges: [{ id: "e1", fromNode: "a", toNode: "a" }],
    });
    const parsed = parseCanvas(original);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const serialised = serializeCanvas(parsed.canvas);
    const reparsed = parseCanvas(serialised);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.canvas.nodes).toHaveLength(1);
    expect(reparsed.canvas.edges).toHaveLength(1);
  });

  it("produces valid JSON", () => {
    const parsed = parseCanvas(JSON.stringify({ nodes: [], edges: [] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(() => JSON.parse(serializeCanvas(parsed.canvas))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildCanvasEditor
// ---------------------------------------------------------------------------

describe("buildCanvasEditor", () => {
  it("produces independent copies — mutations don't alias source", () => {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "original" }],
        edges: [],
      }),
    );
    expect(src.ok).toBe(true);
    if (!src.ok) return;
    const state = buildCanvasEditor(src.canvas);
    state.nodes[0] = { ...state.nodes[0], x: 999 } as CanvasNode;
    expect(src.canvas.nodes[0].x).toBe(0); // source untouched
  });

  it("starts with empty history and future", () => {
    const src = parseCanvas(JSON.stringify({ nodes: [], edges: [] }));
    expect(src.ok).toBe(true);
    if (!src.ok) return;
    const state = buildCanvasEditor(src.canvas);
    expect(state.history).toHaveLength(0);
    expect(state.future).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — move_node
// ---------------------------------------------------------------------------

describe("applyCanvasOp / move_node", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [{ id: "n1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "A" }],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("moves node to new position", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "move_node", id: "n1", x: 200, y: 300 });
    expect(r.ok).toBe(true);
    expect(state.nodes[0].x).toBe(200);
    expect(state.nodes[0].y).toBe(300);
  });

  it("records history entry", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 50, y: 60 });
    expect(state.history).toHaveLength(1);
  });

  it("clears future on new op", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 10, y: 10 });
    undoCanvasOp(state); // creates future entry
    expect(state.future).toHaveLength(1);
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 20, y: 20 });
    expect(state.future).toHaveLength(0);
  });

  it("returns error for unknown node id", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "move_node", id: "nope", x: 0, y: 0 });
    expect(r.ok).toBe(false);
  });

  it("returns error for non-finite x", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "move_node", id: "n1", x: Number.NaN, y: 0 });
    expect(r.ok).toBe(false);
  });

  it("returns error for non-finite y", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "move_node",
      id: "n1",
      x: 0,
      y: Number.POSITIVE_INFINITY,
    });
    expect(r.ok).toBe(false);
  });

  it("allows negative coordinates", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "move_node", id: "n1", x: -500, y: -200 });
    expect(r.ok).toBe(true);
    expect(state.nodes[0].x).toBe(-500);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — resize_node
// ---------------------------------------------------------------------------

describe("applyCanvasOp / resize_node", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [{ id: "n1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" }],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("updates width and height", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "resize_node", id: "n1", width: 300, height: 200 });
    expect(r.ok).toBe(true);
    expect(state.nodes[0].width).toBe(300);
    expect(state.nodes[0].height).toBe(200);
  });

  it("rejects zero width", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "resize_node", id: "n1", width: 0, height: 100 });
    expect(r.ok).toBe(false);
  });

  it("rejects negative height", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "resize_node", id: "n1", width: 100, height: -1 });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — edit_text
// ---------------------------------------------------------------------------

describe("applyCanvasOp / edit_text", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "t1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "original" },
          { id: "l1", type: "link", x: 0, y: 100, width: 100, height: 50, url: "https://a.com" },
        ],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("updates text content", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "edit_text", id: "t1", text: "updated" });
    expect(r.ok).toBe(true);
    const node = state.nodes.find((n) => n.id === "t1");
    if (node?.type === "text") expect(node.text).toBe("updated");
  });

  it("allows empty string", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "edit_text", id: "t1", text: "" });
    expect(r.ok).toBe(true);
  });

  it("rejects edit_text on a link node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "edit_text", id: "l1", text: "bad" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a text node/);
  });

  it("rejects unknown node id", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "edit_text", id: "nope", text: "x" });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — edit_link
// ---------------------------------------------------------------------------

describe("applyCanvasOp / edit_link", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "l1", type: "link", x: 0, y: 0, width: 100, height: 50, url: "https://old.com" },
          { id: "t1", type: "text", x: 0, y: 100, width: 100, height: 50, text: "hi" },
        ],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("updates url", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "edit_link",
      id: "l1",
      url: "https://new.example.com",
    });
    expect(r.ok).toBe(true);
    const node = state.nodes.find((n) => n.id === "l1");
    if (node?.type === "link") expect(node.url).toBe("https://new.example.com");
  });

  it("rejects edit_link on a text node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "edit_link", id: "t1", url: "https://x.com" });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — edit_group_label
// ---------------------------------------------------------------------------

describe("applyCanvasOp / edit_group_label", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "g1", type: "group", x: 0, y: 0, width: 300, height: 200, label: "Old" },
          { id: "t1", type: "text", x: 10, y: 10, width: 100, height: 50, text: "hi" },
        ],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("updates group label", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "edit_group_label", id: "g1", label: "New Label" });
    expect(r.ok).toBe(true);
    const node = state.nodes.find((n) => n.id === "g1");
    if (node?.type === "group") expect(node.label).toBe("New Label");
  });

  it("rejects on text node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "edit_group_label", id: "t1", label: "x" });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — set_node_color
// ---------------------------------------------------------------------------

describe("applyCanvasOp / set_node_color", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          {
            id: "n1",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            text: "",
            color: "1",
          },
        ],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("sets a preset color", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "set_node_color", id: "n1", color: "3" });
    expect(r.ok).toBe(true);
    expect(state.nodes[0].color).toBe("3");
  });

  it("sets a hex color", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "set_node_color", id: "n1", color: "#aabbcc" });
    expect(r.ok).toBe(true);
    expect(state.nodes[0].color).toBe("#aabbcc");
  });

  it("clears color when undefined", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "set_node_color", id: "n1", color: undefined });
    expect(r.ok).toBe(true);
    expect(state.nodes[0].color).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — add_node / delete_node
// ---------------------------------------------------------------------------

describe("applyCanvasOp / add_node + delete_node", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "A" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "B" },
        ],
        edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("adds a new node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_node",
      node: { id: "c", type: "text", x: 400, y: 0, width: 100, height: 50, text: "C" },
    });
    expect(r.ok).toBe(true);
    expect(state.nodes).toHaveLength(3);
    expect(state.nodes[2].id).toBe("c");
  });

  it("rejects add_node with duplicate id", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_node",
      node: { id: "a", type: "text", x: 0, y: 0, width: 10, height: 10, text: "dup" },
    });
    expect(r.ok).toBe(false);
  });

  it("deletes a node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "delete_node", id: "a" });
    expect(r.ok).toBe(true);
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0].id).toBe("b");
  });

  it("deleting a node removes its edges", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "delete_node", id: "a" });
    expect(state.edges).toHaveLength(0);
  });

  it("returns error deleting unknown node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "delete_node", id: "zzz" });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — add_edge / delete_edge
// ---------------------------------------------------------------------------

describe("applyCanvasOp / add_edge + delete_edge", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "A" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "B" },
        ],
        edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("adds a new edge", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_edge",
      edge: { id: "e2", fromNode: "b", toNode: "a", toEnd: "arrow" },
    });
    expect(r.ok).toBe(true);
    expect(state.edges).toHaveLength(2);
  });

  it("rejects duplicate edge id", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_edge",
      edge: { id: "e1", fromNode: "a", toNode: "b" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects edge with missing fromNode", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_edge",
      edge: { id: "e3", fromNode: "zzz", toNode: "b" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/fromNode/);
  });

  it("rejects edge with missing toNode", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_edge",
      edge: { id: "e3", fromNode: "a", toNode: "zzz" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/toNode/);
  });

  it("deletes an edge", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "delete_edge", id: "e1" });
    expect(r.ok).toBe(true);
    expect(state.edges).toHaveLength(0);
  });

  it("returns error deleting unknown edge", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "delete_edge", id: "nope" });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — edit_edge_label
// ---------------------------------------------------------------------------

describe("applyCanvasOp / edit_edge_label", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
        ],
        edges: [{ id: "e1", fromNode: "a", toNode: "b", label: "old" }],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("sets a new label", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "edit_edge_label", id: "e1", label: "new" });
    expect(r.ok).toBe(true);
    expect(state.edges[0].label).toBe("new");
  });

  it("clears label when undefined", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "edit_edge_label", id: "e1", label: undefined });
    expect(state.edges[0].label).toBeUndefined();
  });

  it("returns error for unknown edge", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "edit_edge_label", id: "nope", label: "x" });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — reorder_edges
// ---------------------------------------------------------------------------

describe("applyCanvasOp / reorder_edges", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
        ],
        edges: [
          { id: "e1", fromNode: "a", toNode: "b" },
          { id: "e2", fromNode: "b", toNode: "a" },
          { id: "e3", fromNode: "a", toNode: "a" },
        ],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("reorders edges to specified order", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "reorder_edges", ids: ["e3", "e1", "e2"] });
    expect(r.ok).toBe(true);
    expect(state.edges.map((e) => e.id)).toEqual(["e3", "e1", "e2"]);
  });

  it("rejects wrong count", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "reorder_edges", ids: ["e1", "e2"] });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown edge id in list", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "reorder_edges",
      ids: ["e1", "e2", "zzz"],
    });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// undoCanvasOp / redoCanvasOp
// ---------------------------------------------------------------------------

describe("undoCanvasOp / redoCanvasOp", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [{ id: "n1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "v0" }],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("undo restores previous state", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "edit_text", id: "n1", text: "v1" });
    const undid = undoCanvasOp(state);
    expect(undid).toBe(true);
    const node = state.nodes[0];
    if (node.type === "text") expect(node.text).toBe("v0");
  });

  it("undo returns false when history is empty", () => {
    const state = makeState();
    expect(undoCanvasOp(state)).toBe(false);
  });

  it("redo re-applies the undone op", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "edit_text", id: "n1", text: "v1" });
    undoCanvasOp(state);
    const redid = redoCanvasOp(state);
    expect(redid).toBe(true);
    const node = state.nodes[0];
    if (node.type === "text") expect(node.text).toBe("v1");
  });

  it("redo returns false when future is empty", () => {
    const state = makeState();
    expect(redoCanvasOp(state)).toBe(false);
  });

  it("multiple undo steps restore all prior states", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 10, y: 0 });
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 20, y: 0 });
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 30, y: 0 });
    undoCanvasOp(state);
    expect(state.nodes[0].x).toBe(20);
    undoCanvasOp(state);
    expect(state.nodes[0].x).toBe(10);
    undoCanvasOp(state);
    expect(state.nodes[0].x).toBe(0);
  });

  it("undo → redo → undo cycle is consistent", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "edit_text", id: "n1", text: "A" });
    applyCanvasOp(state, { type: "edit_text", id: "n1", text: "B" });
    undoCanvasOp(state); // back to A
    redoCanvasOp(state); // forward to B
    undoCanvasOp(state); // back to A
    const node = state.nodes[0];
    if (node.type === "text") expect(node.text).toBe("A");
  });

  it("new op after undo discards redo future", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "edit_text", id: "n1", text: "v1" });
    undoCanvasOp(state);
    expect(state.future).toHaveLength(1);
    applyCanvasOp(state, { type: "edit_text", id: "n1", text: "v2" });
    expect(state.future).toHaveLength(0);
  });

  it("undo after delete_node restores the node and its edges", () => {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
        ],
        edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    applyCanvasOp(state, { type: "delete_node", id: "a" });
    expect(state.nodes).toHaveLength(1);
    expect(state.edges).toHaveLength(0);
    undoCanvasOp(state);
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// canvasEditorToCanvas
// ---------------------------------------------------------------------------

describe("canvasEditorToCanvas", () => {
  it("extracts a plain Canvas that round-trips cleanly", () => {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [{ id: "n1", type: "text", x: 5, y: 10, width: 200, height: 80, text: "hello" }],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 99, y: 77 });
    const canvas = canvasEditorToCanvas(state);
    expect(canvas.nodes[0].x).toBe(99);
    expect(canvas.nodes[0].y).toBe(77);
    // Verify it serialises and re-parses cleanly.
    const reparsed = parseCanvas(serializeCanvas(canvas));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.canvas.nodes[0].x).toBe(99);
  });

  it("does not include history or future in output", () => {
    const src = parseCanvas(JSON.stringify({ nodes: [], edges: [] }));
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    const canvas = canvasEditorToCanvas(state);
    expect(Object.keys(canvas)).toEqual(["nodes", "edges"]);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — resize_node (extended)
// ---------------------------------------------------------------------------

describe("applyCanvasOp / resize_node (extended)", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "n1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "n2", type: "group", x: 200, y: 200, width: 300, height: 150 },
        ],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("records history on resize", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "resize_node", id: "n1", width: 200, height: 80 });
    expect(state.history).toHaveLength(1);
  });

  it("clears future on resize after undo", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "resize_node", id: "n1", width: 150, height: 70 });
    undoCanvasOp(state);
    expect(state.future).toHaveLength(1);
    applyCanvasOp(state, { type: "resize_node", id: "n1", width: 250, height: 90 });
    expect(state.future).toHaveLength(0);
  });

  it("rejects non-finite width (NaN)", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "resize_node", id: "n1", width: NaN, height: 50 });
    expect(r.ok).toBe(false);
  });

  it("rejects non-finite height (Infinity)", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "resize_node",
      id: "n1",
      width: 100,
      height: Infinity,
    });
    expect(r.ok).toBe(false);
  });

  it("does not push history on invalid resize", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "resize_node", id: "n1", width: -10, height: 50 });
    expect(state.history).toHaveLength(0);
  });

  it("resizes a group node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "resize_node",
      id: "n2",
      width: 400,
      height: 200,
    });
    expect(r.ok).toBe(true);
    const node = state.nodes.find((n) => n.id === "n2");
    expect(node?.width).toBe(400);
    expect(node?.height).toBe(200);
  });

  it("rejects resize on unknown node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "resize_node",
      id: "zzz",
      width: 100,
      height: 50,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/i);
  });

  it("allows very large dimensions", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "resize_node",
      id: "n1",
      width: 10000,
      height: 10000,
    });
    expect(r.ok).toBe(true);
    expect(state.nodes[0].width).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — set_node_color (extended)
// ---------------------------------------------------------------------------

describe("applyCanvasOp / set_node_color (extended)", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "link", x: 200, y: 0, width: 100, height: 50, url: "https://x.com" },
        ],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("records history on color set", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "set_node_color", id: "a", color: "2" });
    expect(state.history).toHaveLength(1);
  });

  it("records history on color clear", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "set_node_color", id: "a", color: "4" });
    applyCanvasOp(state, { type: "set_node_color", id: "a", color: undefined });
    expect(state.history).toHaveLength(2);
  });

  it("applying color to node that had no color — color is set", () => {
    const state = makeState();
    expect(state.nodes[0].color).toBeUndefined();
    applyCanvasOp(state, { type: "set_node_color", id: "a", color: "#123456" });
    expect(state.nodes[0].color).toBe("#123456");
  });

  it("returns error for unknown node id", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "set_node_color", id: "zzz", color: "1" });
    expect(r.ok).toBe(false);
  });

  it("can set all 6 preset colors", () => {
    for (let i = 1; i <= 6; i++) {
      const state = makeState();
      const r = applyCanvasOp(state, { type: "set_node_color", id: "a", color: String(i) });
      expect(r.ok).toBe(true);
      expect(state.nodes[0].color).toBe(String(i));
    }
  });

  it("can set color on link node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "set_node_color", id: "b", color: "#ff0000" });
    expect(r.ok).toBe(true);
    const node = state.nodes.find((n) => n.id === "b");
    expect(node?.color).toBe("#ff0000");
  });

  it("undo after color set restores original color", () => {
    const state = makeState();
    // First set a color
    applyCanvasOp(state, { type: "set_node_color", id: "a", color: "1" });
    // Then set a different color
    applyCanvasOp(state, { type: "set_node_color", id: "a", color: "2" });
    undoCanvasOp(state);
    expect(state.nodes[0].color).toBe("1");
    undoCanvasOp(state);
    expect(state.nodes[0].color).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — edit_edge_label (extended)
// ---------------------------------------------------------------------------

describe("applyCanvasOp / edit_edge_label (extended)", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
          { id: "c", type: "text", x: 400, y: 0, width: 100, height: 50, text: "" },
        ],
        edges: [
          { id: "e1", fromNode: "a", toNode: "b" },
          { id: "e2", fromNode: "b", toNode: "c", label: "existing" },
        ],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("sets label on edge with no prior label", () => {
    const state = makeState();
    const r = applyCanvasOp(state, { type: "edit_edge_label", id: "e1", label: "new label" });
    expect(r.ok).toBe(true);
    expect(state.edges[0].label).toBe("new label");
  });

  it("records history on label set", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "edit_edge_label", id: "e1", label: "A" });
    expect(state.history).toHaveLength(1);
  });

  it("undo after edit_edge_label restores previous label", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "edit_edge_label", id: "e2", label: "updated" });
    undoCanvasOp(state);
    expect(state.edges[1].label).toBe("existing");
  });

  it("undo after clearing label restores prior label", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "edit_edge_label", id: "e2", label: undefined });
    undoCanvasOp(state);
    expect(state.edges[1].label).toBe("existing");
  });

  it("multiple label edits on same edge record correct history", () => {
    const state = makeState();
    applyCanvasOp(state, { type: "edit_edge_label", id: "e1", label: "v1" });
    applyCanvasOp(state, { type: "edit_edge_label", id: "e1", label: "v2" });
    undoCanvasOp(state);
    expect(state.edges[0].label).toBe("v1");
    undoCanvasOp(state);
    expect(state.edges[0].label).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — add_node (extended types)
// ---------------------------------------------------------------------------

describe("applyCanvasOp / add_node (extended types)", () => {
  function makeState() {
    const src = parseCanvas(JSON.stringify({ nodes: [], edges: [] }));
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("adds a file node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_node",
      node: { id: "f1", type: "file", x: 0, y: 0, width: 200, height: 100, file: "doc.md" },
    });
    expect(r.ok).toBe(true);
    expect(state.nodes).toHaveLength(1);
    const n = state.nodes[0];
    expect(n.type).toBe("file");
    if (n.type === "file") expect(n.file).toBe("doc.md");
  });

  it("adds a link node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_node",
      node: {
        id: "l1",
        type: "link",
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        url: "https://example.com",
      },
    });
    expect(r.ok).toBe(true);
    const n = state.nodes[0];
    if (n.type === "link") expect(n.url).toBe("https://example.com");
  });

  it("adds a group node", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_node",
      node: {
        id: "g1",
        type: "group",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        label: "My Group",
      },
    });
    expect(r.ok).toBe(true);
    const n = state.nodes[0];
    if (n.type === "group") expect(n.label).toBe("My Group");
  });

  it("adds node with a color attribute", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_node",
      node: {
        id: "n1",
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        text: "colored",
        color: "3",
      },
    });
    expect(r.ok).toBe(true);
    expect(state.nodes[0].color).toBe("3");
  });

  it("added node is independent copy — mutation does not alias original", () => {
    const state = makeState();
    const node = {
      id: "n1",
      type: "text" as const,
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      text: "original",
    };
    applyCanvasOp(state, { type: "add_node", node });
    // Mutate the original object
    node.text = "mutated";
    const stored = state.nodes[0];
    if (stored.type === "text") expect(stored.text).toBe("original");
  });

  it("records history on add_node", () => {
    const state = makeState();
    applyCanvasOp(state, {
      type: "add_node",
      node: { id: "x", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
    });
    expect(state.history).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — delete_node (extended cascades)
// ---------------------------------------------------------------------------

describe("applyCanvasOp / delete_node (cascade edge removal)", () => {
  it("removes all edges where node is fromNode", () => {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
          { id: "c", type: "text", x: 400, y: 0, width: 100, height: 50, text: "" },
        ],
        edges: [
          { id: "e1", fromNode: "a", toNode: "b" },
          { id: "e2", fromNode: "a", toNode: "c" },
          { id: "e3", fromNode: "b", toNode: "c" },
        ],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    applyCanvasOp(state, { type: "delete_node", id: "a" });
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0].id).toBe("e3");
  });

  it("removes all edges where node is toNode", () => {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
          { id: "c", type: "text", x: 400, y: 0, width: 100, height: 50, text: "" },
        ],
        edges: [
          { id: "e1", fromNode: "a", toNode: "c" },
          { id: "e2", fromNode: "b", toNode: "c" },
          { id: "e3", fromNode: "a", toNode: "b" },
        ],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    applyCanvasOp(state, { type: "delete_node", id: "c" });
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0].id).toBe("e3");
  });

  it("deleting a node with no edges leaves edges list intact", () => {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
          { id: "c", type: "text", x: 400, y: 0, width: 100, height: 50, text: "" },
        ],
        edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    applyCanvasOp(state, { type: "delete_node", id: "c" });
    expect(state.edges).toHaveLength(1);
  });

  it("undo after delete restores node and all its edges", () => {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
          { id: "c", type: "text", x: 400, y: 0, width: 100, height: 50, text: "" },
        ],
        edges: [
          { id: "e1", fromNode: "a", toNode: "b" },
          { id: "e2", fromNode: "a", toNode: "c" },
        ],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    applyCanvasOp(state, { type: "delete_node", id: "a" });
    undoCanvasOp(state);
    expect(state.nodes).toHaveLength(3);
    expect(state.edges).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — add_edge (extended)
// ---------------------------------------------------------------------------

describe("applyCanvasOp / add_edge (extended)", () => {
  function makeState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
          { id: "c", type: "text", x: 400, y: 0, width: 100, height: 50, text: "" },
        ],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("adds edge with all optional fields set", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_edge",
      edge: {
        id: "e1",
        fromNode: "a",
        toNode: "b",
        fromSide: "right",
        toSide: "left",
        fromEnd: "none",
        toEnd: "arrow",
        color: "2",
        label: "flow",
      },
    });
    expect(r.ok).toBe(true);
    const e = state.edges[0];
    expect(e.fromSide).toBe("right");
    expect(e.toSide).toBe("left");
    expect(e.fromEnd).toBe("none");
    expect(e.toEnd).toBe("arrow");
    expect(e.color).toBe("2");
    expect(e.label).toBe("flow");
  });

  it("allows self-loop (fromNode === toNode)", () => {
    const state = makeState();
    const r = applyCanvasOp(state, {
      type: "add_edge",
      edge: { id: "loop", fromNode: "a", toNode: "a" },
    });
    expect(r.ok).toBe(true);
  });

  it("records history on add_edge", () => {
    const state = makeState();
    applyCanvasOp(state, {
      type: "add_edge",
      edge: { id: "e1", fromNode: "a", toNode: "b" },
    });
    expect(state.history).toHaveLength(1);
  });

  it("undo after add_edge removes the added edge", () => {
    const state = makeState();
    applyCanvasOp(state, {
      type: "add_edge",
      edge: { id: "e1", fromNode: "a", toNode: "b" },
    });
    undoCanvasOp(state);
    expect(state.edges).toHaveLength(0);
  });

  it("added edge object is an independent copy", () => {
    const state = makeState();
    const edge = { id: "e1", fromNode: "a", toNode: "b", label: "original" };
    applyCanvasOp(state, { type: "add_edge", edge });
    edge.label = "mutated";
    expect(state.edges[0].label).toBe("original");
  });
});

// ---------------------------------------------------------------------------
// applyCanvasOp — reorder_edges (extended)
// ---------------------------------------------------------------------------

describe("applyCanvasOp / reorder_edges (extended)", () => {
  function makeState4Edges() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
        ],
        edges: [
          { id: "e1", fromNode: "a", toNode: "b" },
          { id: "e2", fromNode: "b", toNode: "a" },
          { id: "e3", fromNode: "a", toNode: "a" },
          { id: "e4", fromNode: "b", toNode: "b" },
        ],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("reorders 4 edges to reverse order", () => {
    const state = makeState4Edges();
    const r = applyCanvasOp(state, {
      type: "reorder_edges",
      ids: ["e4", "e3", "e2", "e1"],
    });
    expect(r.ok).toBe(true);
    expect(state.edges.map((e) => e.id)).toEqual(["e4", "e3", "e2", "e1"]);
  });

  it("records history on reorder", () => {
    const state = makeState4Edges();
    applyCanvasOp(state, { type: "reorder_edges", ids: ["e4", "e3", "e2", "e1"] });
    expect(state.history).toHaveLength(1);
  });

  it("undo after reorder restores original order", () => {
    const state = makeState4Edges();
    applyCanvasOp(state, { type: "reorder_edges", ids: ["e4", "e3", "e2", "e1"] });
    undoCanvasOp(state);
    expect(state.edges.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
  });

  it("rejects list with wrong count (too few ids)", () => {
    const state = makeState4Edges();
    const r = applyCanvasOp(state, {
      type: "reorder_edges",
      ids: ["e1", "e2", "e3"],
    });
    // Only 3 ids for 4 edges — wrong count → rejected
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// undo/redo — state machine verifications
// ---------------------------------------------------------------------------

describe("undoCanvasOp / redoCanvasOp (state machine)", () => {
  function makeRichState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "n1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "start" },
          { id: "n2", type: "text", x: 200, y: 0, width: 100, height: 50, text: "other" },
        ],
        edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("undo stack grows monotonically with each op", () => {
    const state = makeRichState();
    for (let i = 1; i <= 5; i++) {
      applyCanvasOp(state, { type: "move_node", id: "n1", x: i * 10, y: 0 });
      expect(state.history).toHaveLength(i);
    }
  });

  it("redo stack grows with each undo", () => {
    const state = makeRichState();
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 10, y: 0 });
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 20, y: 0 });
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 30, y: 0 });
    undoCanvasOp(state);
    expect(state.future).toHaveLength(1);
    undoCanvasOp(state);
    expect(state.future).toHaveLength(2);
    undoCanvasOp(state);
    expect(state.future).toHaveLength(3);
    expect(state.history).toHaveLength(0);
  });

  it("full undo-all → redo-all cycle preserves final state", () => {
    const state = makeRichState();
    applyCanvasOp(state, { type: "edit_text", id: "n1", text: "A" });
    applyCanvasOp(state, { type: "edit_text", id: "n1", text: "B" });
    applyCanvasOp(state, { type: "edit_text", id: "n1", text: "C" });

    // Undo all 3
    undoCanvasOp(state);
    undoCanvasOp(state);
    undoCanvasOp(state);
    const n = state.nodes[0];
    if (n.type === "text") expect(n.text).toBe("start");

    // Redo all 3
    redoCanvasOp(state);
    redoCanvasOp(state);
    redoCanvasOp(state);
    const n2 = state.nodes[0];
    if (n2.type === "text") expect(n2.text).toBe("C");
  });

  it("history and future are empty snapshots after buildCanvasEditor", () => {
    const state = makeRichState();
    expect(state.history).toHaveLength(0);
    expect(state.future).toHaveLength(0);
  });

  it("redo after new op returns false (future was cleared)", () => {
    const state = makeRichState();
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 10, y: 0 });
    undoCanvasOp(state);
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 20, y: 0 });
    // Future was cleared by the new op
    expect(redoCanvasOp(state)).toBe(false);
  });

  it("snapshot in history is a deep copy — later mutations don't alter it", () => {
    const state = makeRichState();
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 50, y: 50 });
    // History[0] records x=0,y=0 snapshot
    const histSnap = state.history[0];
    // Apply another op that modifies nodes
    applyCanvasOp(state, { type: "move_node", id: "n1", x: 100, y: 100 });
    // The snapshot should still record the original position
    expect(histSnap.nodes[0].x).toBe(0);
    expect(histSnap.nodes[0].y).toBe(0);
  });

  it("undo after add_edge restores edges list", () => {
    const state = makeRichState();
    applyCanvasOp(state, {
      type: "add_edge",
      edge: { id: "e2", fromNode: "n1", toNode: "n2" },
    });
    expect(state.edges).toHaveLength(2);
    undoCanvasOp(state);
    expect(state.edges).toHaveLength(1);
  });

  it("undo after delete_edge restores edge", () => {
    const state = makeRichState();
    applyCanvasOp(state, { type: "delete_edge", id: "e1" });
    expect(state.edges).toHaveLength(0);
    undoCanvasOp(state);
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0].id).toBe("e1");
  });

  it("undo after resize_node restores dimensions", () => {
    const state = makeRichState();
    applyCanvasOp(state, { type: "resize_node", id: "n1", width: 500, height: 300 });
    undoCanvasOp(state);
    expect(state.nodes[0].width).toBe(100);
    expect(state.nodes[0].height).toBe(50);
  });

  it("redo after undo of add_node re-adds the node", () => {
    const state = makeRichState();
    applyCanvasOp(state, {
      type: "add_node",
      node: { id: "nx", type: "text", x: 0, y: 0, width: 100, height: 50, text: "new" },
    });
    undoCanvasOp(state);
    expect(state.nodes).toHaveLength(2);
    redoCanvasOp(state);
    expect(state.nodes).toHaveLength(3);
    expect(state.nodes[2].id).toBe("nx");
  });
});

// ---------------------------------------------------------------------------
// buildCanvasEditor (extended)
// ---------------------------------------------------------------------------

describe("buildCanvasEditor (extended)", () => {
  it("node list is a shallow copy — push doesn't affect source canvas", () => {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "hi" }],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    state.nodes.push({
      id: "extra",
      type: "text",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      text: "extra",
    });
    expect(src.canvas.nodes).toHaveLength(1);
  });

  it("edge list is a shallow copy — push doesn't affect source canvas", () => {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
        ],
        edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    state.edges.push({ id: "extra", fromNode: "a", toNode: "b" });
    expect(src.canvas.edges).toHaveLength(1);
  });

  it("builds from an empty canvas without error", () => {
    const src = parseCanvas(JSON.stringify({ nodes: [], edges: [] }));
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    expect(state.nodes).toHaveLength(0);
    expect(state.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// canvasEditorToCanvas (extended)
// ---------------------------------------------------------------------------

describe("canvasEditorToCanvas (extended)", () => {
  it("snapshot taken mid-session reflects current edit state, not original", () => {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [{ id: "n1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "v0" }],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    applyCanvasOp(state, { type: "edit_text", id: "n1", text: "v1" });
    applyCanvasOp(state, { type: "edit_text", id: "n1", text: "v2" });
    const canvas = canvasEditorToCanvas(state);
    const node = canvas.nodes[0];
    if (node.type === "text") expect(node.text).toBe("v2");
  });

  it("mutating returned canvas does not affect editor state", () => {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [{ id: "n1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "hello" }],
        edges: [],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    const canvas = canvasEditorToCanvas(state);
    canvas.nodes[0] = { ...canvas.nodes[0], x: 999 };
    expect(state.nodes[0].x).toBe(0);
  });

  it("returns a canvas with exactly nodes and edges keys", () => {
    const src = parseCanvas(JSON.stringify({ nodes: [], edges: [] }));
    if (!src.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(src.canvas);
    const canvas = canvasEditorToCanvas(state);
    const keys = Object.keys(canvas).sort();
    expect(keys).toEqual(["edges", "nodes"]);
  });
});

// ---------------------------------------------------------------------------
// serializeCanvas (extended)
// ---------------------------------------------------------------------------

describe("serializeCanvas (extended)", () => {
  it("serializes group node with all optional fields", () => {
    const canvas = {
      nodes: [
        {
          id: "g1",
          type: "group" as const,
          x: 0,
          y: 0,
          width: 400,
          height: 300,
          label: "My Group",
          background: "bg.png",
          backgroundStyle: "cover" as const,
        },
      ],
      edges: [],
    };
    const serialised = serializeCanvas(canvas);
    const reparsed = parseCanvas(serialised);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const n = reparsed.canvas.nodes[0];
    expect(n.type).toBe("group");
    if (n.type === "group") {
      expect(n.label).toBe("My Group");
      expect(n.background).toBe("bg.png");
      expect(n.backgroundStyle).toBe("cover");
    }
  });

  it("serializes file node with subpath", () => {
    const canvas = {
      nodes: [
        {
          id: "f1",
          type: "file" as const,
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          file: "note.md",
          subpath: "#section",
        },
      ],
      edges: [],
    };
    const serialised = serializeCanvas(canvas);
    const reparsed = parseCanvas(serialised);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const n = reparsed.canvas.nodes[0];
    if (n.type === "file") expect(n.subpath).toBe("#section");
  });

  it("serializes edge with all optional fields", () => {
    const canvas = {
      nodes: [
        { id: "a", type: "text" as const, x: 0, y: 0, width: 100, height: 50, text: "" },
        { id: "b", type: "text" as const, x: 200, y: 0, width: 100, height: 50, text: "" },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          fromSide: "right" as const,
          toSide: "left" as const,
          fromEnd: "arrow" as const,
          toEnd: "arrow" as const,
          color: "#ff0000",
          label: "data flow",
        },
      ],
    };
    const reparsed = parseCanvas(serializeCanvas(canvas));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const e = reparsed.canvas.edges[0];
    expect(e.fromSide).toBe("right");
    expect(e.fromEnd).toBe("arrow");
    expect(e.label).toBe("data flow");
  });

  it("serialized JSON is pretty-printed (2-space indent)", () => {
    const canvas = { nodes: [], edges: [] };
    const s = serializeCanvas(canvas);
    // Should have newlines and spaces
    expect(s).toContain("\n");
    expect(s).toContain("  ");
  });
});

// ---------------------------------------------------------------------------
// parseCanvas — additional edge cases
// ---------------------------------------------------------------------------

describe("parseCanvas (additional edge cases)", () => {
  it("handles group node with no optional fields", () => {
    const input = JSON.stringify({
      nodes: [{ id: "g1", type: "group", x: 0, y: 0, width: 200, height: 100 }],
      edges: [],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const n = result.canvas.nodes[0];
    expect(n.type).toBe("group");
    if (n.type === "group") {
      expect(n.label).toBeUndefined();
      expect(n.background).toBeUndefined();
    }
  });

  it("parses negative x/y coordinates on nodes", () => {
    const input = JSON.stringify({
      nodes: [{ id: "n1", type: "text", x: -100, y: -200, width: 100, height: 50, text: "" }],
      edges: [],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes[0].x).toBe(-100);
    expect(result.canvas.nodes[0].y).toBe(-200);
  });

  it("parses zero-length text string on text node", () => {
    const input = JSON.stringify({
      nodes: [{ id: "t1", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" }],
      edges: [],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const n = result.canvas.nodes[0];
    if (n.type === "text") expect(n.text).toBe("");
  });

  it("text node missing text field defaults to empty string", () => {
    const input = JSON.stringify({
      nodes: [{ id: "t1", type: "text", x: 0, y: 0, width: 100, height: 50 }],
      edges: [],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const n = result.canvas.nodes[0];
    if (n.type === "text") expect(n.text).toBe("");
  });

  it("edge with color preset '1' is preserved", () => {
    const input = JSON.stringify({
      edges: [{ id: "e1", fromNode: "a", toNode: "b", color: "1" }],
    });
    const result = parseCanvas(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.edges[0].color).toBe("1");
  });

  it("handles large canvas with many nodes and edges", () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      id: `n${i}`,
      type: "text",
      x: i * 200,
      y: 0,
      width: 100,
      height: 50,
      text: `Node ${i}`,
    }));
    const edges = Array.from({ length: 99 }, (_, i) => ({
      id: `e${i}`,
      fromNode: `n${i}`,
      toNode: `n${i + 1}`,
    }));
    const result = parseCanvas(JSON.stringify({ nodes, edges }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodes).toHaveLength(100);
    expect(result.canvas.edges).toHaveLength(99);
  });
});

// ---------------------------------------------------------------------------
// canvasBounds — extended
// ---------------------------------------------------------------------------

describe("canvasBounds (extended)", () => {
  it("handles all nodes at the same position (degenerate case)", () => {
    const nodes = [
      { id: "a", type: "text" as const, x: 50, y: 50, width: 0, height: 0, text: "" },
      { id: "b", type: "text" as const, x: 50, y: 50, width: 0, height: 0, text: "" },
    ];
    const b = canvasBounds(nodes);
    expect(b.minX).toBe(50);
    expect(b.minY).toBe(50);
    expect(b.width).toBe(0);
    expect(b.height).toBe(0);
  });

  it("correctly calculates bounds with negative offsets", () => {
    const nodes = [
      { id: "a", type: "text" as const, x: -100, y: -50, width: 50, height: 30, text: "" },
      { id: "b", type: "text" as const, x: 200, y: 100, width: 100, height: 80, text: "" },
    ];
    const b = canvasBounds(nodes);
    expect(b.minX).toBe(-100);
    expect(b.minY).toBe(-50);
    expect(b.maxX).toBe(300); // 200 + 100
    expect(b.maxY).toBe(180); // 100 + 80
  });

  it("calculates correct bounds with a single large node", () => {
    const nodes = [
      {
        id: "a",
        type: "group" as const,
        x: -500,
        y: -300,
        width: 2000,
        height: 1500,
      },
    ];
    const b = canvasBounds(nodes);
    expect(b.minX).toBe(-500);
    expect(b.maxX).toBe(1500);
    expect(b.width).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Multi-op batch — transaction-like semantics
// ---------------------------------------------------------------------------

describe("multi-op batch transaction semantics", () => {
  function makeBatchState() {
    const src = parseCanvas(
      JSON.stringify({
        nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "A" },
          { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "B" },
        ],
        edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
      }),
    );
    if (!src.ok) throw new Error("parse failed");
    return buildCanvasEditor(src.canvas);
  }

  it("applying a sequence of valid ops all succeed independently", () => {
    const state = makeBatchState();
    const ops = [
      applyCanvasOp(state, { type: "move_node", id: "a", x: 10, y: 10 }),
      applyCanvasOp(state, { type: "edit_text", id: "a", text: "updated A" }),
      applyCanvasOp(state, { type: "set_node_color", id: "a", color: "3" }),
      applyCanvasOp(state, { type: "resize_node", id: "b", width: 150, height: 80 }),
      applyCanvasOp(state, { type: "edit_edge_label", id: "e1", label: "connects" }),
    ];
    expect(ops.every((r) => r.ok)).toBe(true);
    expect(state.history).toHaveLength(5);
  });

  it("state after multi-op batch matches expected final state", () => {
    const state = makeBatchState();
    applyCanvasOp(state, { type: "move_node", id: "a", x: 50, y: 25 });
    applyCanvasOp(state, { type: "edit_text", id: "b", text: "B updated" });
    applyCanvasOp(state, {
      type: "add_node",
      node: { id: "c", type: "text", x: 400, y: 0, width: 100, height: 50, text: "C" },
    });

    expect(state.nodes[0].x).toBe(50);
    expect(state.nodes[0].y).toBe(25);
    const nodeB = state.nodes[1];
    if (nodeB.type === "text") expect(nodeB.text).toBe("B updated");
    expect(state.nodes).toHaveLength(3);
  });

  it("failing op in sequence leaves prior ops applied (no atomicity without rollback)", () => {
    const state = makeBatchState();
    applyCanvasOp(state, { type: "move_node", id: "a", x: 99, y: 99 });
    // This op will fail (wrong node type)
    applyCanvasOp(state, { type: "edit_text", id: "e1", text: "bad" });
    // First op's effect remains
    expect(state.nodes[0].x).toBe(99);
    expect(state.history).toHaveLength(1); // only 1 successful op
  });

  it("full undo of multi-op sequence restores original state exactly", () => {
    const state = makeBatchState();
    applyCanvasOp(state, { type: "move_node", id: "a", x: 10, y: 10 });
    applyCanvasOp(state, { type: "edit_text", id: "a", text: "changed" });
    applyCanvasOp(state, { type: "set_node_color", id: "b", color: "5" });

    // Undo all 3
    undoCanvasOp(state);
    undoCanvasOp(state);
    undoCanvasOp(state);

    expect(state.nodes[0].x).toBe(0);
    const nodeA = state.nodes[0];
    if (nodeA.type === "text") expect(nodeA.text).toBe("A");
    expect(state.nodes[1].color).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round-trip save: edit → serialize → parse → verify
// ---------------------------------------------------------------------------

describe("round-trip: edit → serialize → parse → verify", () => {
  it("node move persists across serialize/parse", () => {
    const initial = JSON.stringify({
      nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "hi" }],
      edges: [],
    });
    const parsed = parseCanvas(initial);
    if (!parsed.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(parsed.canvas);
    applyCanvasOp(state, { type: "move_node", id: "a", x: 123, y: 456 });
    const serialised = serializeCanvas(canvasEditorToCanvas(state));
    const reparsed = parseCanvas(serialised);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.canvas.nodes[0].x).toBe(123);
    expect(reparsed.canvas.nodes[0].y).toBe(456);
  });

  it("text edit persists across serialize/parse", () => {
    const initial = JSON.stringify({
      nodes: [{ id: "t", type: "text", x: 0, y: 0, width: 100, height: 50, text: "old" }],
      edges: [],
    });
    const parsed = parseCanvas(initial);
    if (!parsed.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(parsed.canvas);
    applyCanvasOp(state, { type: "edit_text", id: "t", text: "new text content" });
    const reparsed = parseCanvas(serializeCanvas(canvasEditorToCanvas(state)));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const node = reparsed.canvas.nodes[0];
    if (node.type === "text") expect(node.text).toBe("new text content");
  });

  it("add+delete nodes round-trip correctly", () => {
    const initial = JSON.stringify({
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "A" },
        { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "B" },
      ],
      edges: [],
    });
    const parsed = parseCanvas(initial);
    if (!parsed.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(parsed.canvas);
    applyCanvasOp(state, { type: "delete_node", id: "b" });
    applyCanvasOp(state, {
      type: "add_node",
      node: { id: "c", type: "link", x: 400, y: 0, width: 150, height: 80, url: "https://c.com" },
    });
    const reparsed = parseCanvas(serializeCanvas(canvasEditorToCanvas(state)));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.canvas.nodes).toHaveLength(2);
    const ids = reparsed.canvas.nodes.map((n) => n.id);
    expect(ids).toContain("a");
    expect(ids).toContain("c");
    expect(ids).not.toContain("b");
  });

  it("edge reorder persists across serialize/parse", () => {
    const initial = JSON.stringify({
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "" },
        { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "" },
      ],
      edges: [
        { id: "e1", fromNode: "a", toNode: "b" },
        { id: "e2", fromNode: "b", toNode: "a" },
      ],
    });
    const parsed = parseCanvas(initial);
    if (!parsed.ok) throw new Error("parse failed");
    const state = buildCanvasEditor(parsed.canvas);
    applyCanvasOp(state, { type: "reorder_edges", ids: ["e2", "e1"] });
    const reparsed = parseCanvas(serializeCanvas(canvasEditorToCanvas(state)));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.canvas.edges[0].id).toBe("e2");
    expect(reparsed.canvas.edges[1].id).toBe("e1");
  });
});
