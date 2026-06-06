import { describe, expect, it } from "vitest";
import type { CanvasNode, CanvasNodeBase } from "./canvas";
import {
  CANVAS_PRESET_COLORS,
  canvasBounds,
  fitTransform,
  nodeAnchor,
  parseCanvas,
  resolveCanvasColor,
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
