// JSON Canvas 1.0 parser + geometry helpers
// Spec: https://jsoncanvas.org/spec/1.0/
// Dependency-free and pure — no React, no Tauri.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanvasColor = string; // hex "#RRGGBB" OR preset "1".."6"

export interface CanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: "text";
  text: string;
}

export interface CanvasFileNode extends CanvasNodeBase {
  type: "file";
  file: string;
  subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
  type: "link";
  url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: "group";
  label?: string;
  background?: string;
  backgroundStyle?: "cover" | "ratio" | "repeat";
}

export type CanvasNode =
  | CanvasTextNode
  | CanvasFileNode
  | CanvasLinkNode
  | CanvasGroupNode;

export type CanvasSide = "top" | "right" | "bottom" | "left";
export type CanvasEnd = "none" | "arrow";

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toNode: string;
  toSide?: CanvasSide;
  toEnd?: CanvasEnd;
  color?: CanvasColor;
  label?: string;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type CanvasParseResult =
  | { ok: true; canvas: Canvas }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Preset color palette (Obsidian)
// ---------------------------------------------------------------------------

export const CANVAS_PRESET_COLORS: Record<string, string> = {
  "1": "#e93147", // red
  "2": "#ec7500", // orange
  "3": "#e0ac00", // yellow
  "4": "#08b94e", // green
  "5": "#00bfbc", // cyan
  "6": "#9065c0", // purple
};

export function resolveCanvasColor(color: CanvasColor | undefined): string | undefined {
  if (color === undefined) return undefined;
  if (color in CANVAS_PRESET_COLORS) return CANVAS_PRESET_COLORS[color];
  return color; // pass through hex values unchanged
}

// ---------------------------------------------------------------------------
// Internal validation helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

const VALID_SIDES = new Set<string>(["top", "right", "bottom", "left"]);
const VALID_ENDS = new Set<string>(["none", "arrow"]);
const VALID_BG_STYLES = new Set<string>(["cover", "ratio", "repeat"]);

function parseNode(raw: unknown): CanvasNode | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

  const r = raw as Record<string, unknown>;

  // Required base fields
  if (!isString(r.id) || r.id === "") return null;
  if (!isString(r.type)) return null;
  if (!isFiniteNumber(r.x)) return null;
  if (!isFiniteNumber(r.y)) return null;
  if (!isFiniteNumber(r.width)) return null;
  if (!isFiniteNumber(r.height)) return null;

  const base: CanvasNodeBase = {
    id: r.id,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  };
  if (isString(r.color)) base.color = r.color;

  switch (r.type) {
    case "text": {
      const text = isString(r.text) ? r.text : "";
      return { ...base, type: "text", text };
    }
    case "file": {
      if (!isString(r.file)) return null;
      const node: CanvasFileNode = { ...base, type: "file", file: r.file };
      if (isString(r.subpath)) node.subpath = r.subpath;
      return node;
    }
    case "link": {
      if (!isString(r.url)) return null;
      return { ...base, type: "link", url: r.url };
    }
    case "group": {
      const node: CanvasGroupNode = { ...base, type: "group" };
      if (isString(r.label)) node.label = r.label;
      if (isString(r.background)) node.background = r.background;
      if (isString(r.backgroundStyle) && VALID_BG_STYLES.has(r.backgroundStyle))
        node.backgroundStyle = r.backgroundStyle as CanvasGroupNode["backgroundStyle"];
      return node;
    }
    default:
      return null; // unknown type — drop
  }
}

function parseEdge(raw: unknown): CanvasEdge | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

  const r = raw as Record<string, unknown>;

  if (!isString(r.id) || r.id === "") return null;
  if (!isString(r.fromNode) || r.fromNode === "") return null;
  if (!isString(r.toNode) || r.toNode === "") return null;

  const edge: CanvasEdge = {
    id: r.id,
    fromNode: r.fromNode,
    toNode: r.toNode,
  };

  if (isString(r.fromSide) && VALID_SIDES.has(r.fromSide))
    edge.fromSide = r.fromSide as CanvasSide;
  if (isString(r.fromEnd) && VALID_ENDS.has(r.fromEnd))
    edge.fromEnd = r.fromEnd as CanvasEnd;
  if (isString(r.toSide) && VALID_SIDES.has(r.toSide))
    edge.toSide = r.toSide as CanvasSide;
  if (isString(r.toEnd) && VALID_ENDS.has(r.toEnd)) edge.toEnd = r.toEnd as CanvasEnd;
  if (isString(r.color)) edge.color = r.color;
  if (isString(r.label)) edge.label = r.label;

  return edge;
}

// ---------------------------------------------------------------------------
// parseCanvas
// ---------------------------------------------------------------------------

export function parseCanvas(raw: string): CanvasParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${String(e)}` };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Canvas must be a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : [];
  const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];

  const nodes: CanvasNode[] = [];
  for (const n of rawNodes) {
    const node = parseNode(n);
    if (node !== null) nodes.push(node);
  }

  const edges: CanvasEdge[] = [];
  for (const e of rawEdges) {
    const edge = parseEdge(e);
    if (edge !== null) edges.push(edge);
  }

  return { ok: true, canvas: { nodes, edges } };
}

// ---------------------------------------------------------------------------
// canvasBounds
// ---------------------------------------------------------------------------

export interface CanvasBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export function canvasBounds(nodes: CanvasNode[]): CanvasBounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    const rx = n.x + n.width;
    const ry = n.y + n.height;
    if (rx > maxX) maxX = rx;
    if (ry > maxY) maxY = ry;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

// ---------------------------------------------------------------------------
// fitTransform
// ---------------------------------------------------------------------------

export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

const FIT_SCALE_MIN = 0.05;
const FIT_SCALE_MAX = 2;

export function fitTransform(
  bounds: CanvasBounds,
  viewportW: number,
  viewportH: number,
  padding: number,
): ViewTransform {
  const availW = viewportW - padding * 2;
  const availH = viewportH - padding * 2;

  let scale: number;
  if (bounds.width === 0 && bounds.height === 0) {
    scale = 1;
  } else if (bounds.width === 0) {
    scale = availH / bounds.height;
  } else if (bounds.height === 0) {
    scale = availW / bounds.width;
  } else {
    scale = Math.min(availW / bounds.width, availH / bounds.height);
  }

  // Clamp
  scale = Math.max(FIT_SCALE_MIN, Math.min(FIT_SCALE_MAX, scale));

  // Center content in viewport
  const scaledW = bounds.width * scale;
  const scaledH = bounds.height * scale;
  const offsetX = (viewportW - scaledW) / 2 - bounds.minX * scale;
  const offsetY = (viewportH - scaledH) / 2 - bounds.minY * scale;

  return { scale, offsetX, offsetY };
}

// ---------------------------------------------------------------------------
// buildCanvasGraph (existing read-only helper — kept for CanvasViewer)
// ---------------------------------------------------------------------------

export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export function buildCanvasGraph(canvas: Canvas): CanvasGraph {
  return { nodes: [...canvas.nodes], edges: [...canvas.edges] };
}

// ---------------------------------------------------------------------------
// serializeCanvas — write a Canvas back to JSON string
// ---------------------------------------------------------------------------

export function serializeCanvas(canvas: Canvas): string {
  return JSON.stringify(canvas, null, 2);
}

// ---------------------------------------------------------------------------
// CanvasEditOp — discriminated union of all mutations
// ---------------------------------------------------------------------------

export type CanvasEditOp =
  | { type: "move_node"; id: string; x: number; y: number }
  | { type: "resize_node"; id: string; width: number; height: number }
  | { type: "edit_text"; id: string; text: string }
  | { type: "edit_link"; id: string; url: string }
  | { type: "edit_group_label"; id: string; label: string }
  | { type: "set_node_color"; id: string; color: CanvasColor | undefined }
  | { type: "add_node"; node: CanvasNode }
  | { type: "delete_node"; id: string }
  | { type: "add_edge"; edge: CanvasEdge }
  | { type: "delete_edge"; id: string }
  | { type: "edit_edge_label"; id: string; label: string | undefined }
  | { type: "reorder_edges"; ids: string[] };

// ---------------------------------------------------------------------------
// CanvasEditorState — mutable AST produced by buildCanvasEditor()
// ---------------------------------------------------------------------------

export interface CanvasEditorState {
  /** Ordered node list — mutated by editor operations. */
  nodes: CanvasNode[];
  /** Ordered edge list — mutated by editor operations. */
  edges: CanvasEdge[];
  /** Full undo stack: each entry is a snapshot before the operation. */
  history: Canvas[];
  /** Redo stack: snapshots popped off when a new op is applied. */
  future: Canvas[];
}

// ---------------------------------------------------------------------------
// buildCanvasEditor
// ---------------------------------------------------------------------------

/**
 * Produce an editable AST from a parsed Canvas.  The returned state object
 * is independent of the original — mutations never alias back to the source.
 */
export function buildCanvasEditor(canvas: Canvas): CanvasEditorState {
  return {
    nodes: canvas.nodes.map((n) => ({ ...n })),
    edges: canvas.edges.map((e) => ({ ...e })),
    history: [],
    future: [],
  };
}

// ---------------------------------------------------------------------------
// Internal snapshot helpers
// ---------------------------------------------------------------------------

function snapshot(state: CanvasEditorState): Canvas {
  return {
    nodes: state.nodes.map((n) => ({ ...n })),
    edges: state.edges.map((e) => ({ ...e })),
  };
}

function pushHistory(state: CanvasEditorState): void {
  state.history.push(snapshot(state));
  // New op invalidates any redo future.
  state.future = [];
}

// ---------------------------------------------------------------------------
// applyCanvasOp — apply a single edit operation (mutates state in place)
// ---------------------------------------------------------------------------

export type CanvasOpResult =
  | { ok: true }
  | { ok: false; error: string };

export function applyCanvasOp(
  state: CanvasEditorState,
  op: CanvasEditOp,
): CanvasOpResult {
  switch (op.type) {
    case "move_node": {
      const idx = state.nodes.findIndex((n) => n.id === op.id);
      if (idx === -1) return { ok: false, error: `Node "${op.id}" not found` };
      if (!Number.isFinite(op.x) || !Number.isFinite(op.y))
        return { ok: false, error: "x and y must be finite numbers" };
      pushHistory(state);
      const node = state.nodes[idx];
      state.nodes[idx] = { ...node, x: op.x, y: op.y };
      return { ok: true };
    }
    case "resize_node": {
      const idx = state.nodes.findIndex((n) => n.id === op.id);
      if (idx === -1) return { ok: false, error: `Node "${op.id}" not found` };
      if (!Number.isFinite(op.width) || !Number.isFinite(op.height))
        return { ok: false, error: "width and height must be finite numbers" };
      if (op.width <= 0 || op.height <= 0)
        return { ok: false, error: "width and height must be positive" };
      pushHistory(state);
      const node = state.nodes[idx];
      state.nodes[idx] = { ...node, width: op.width, height: op.height };
      return { ok: true };
    }
    case "edit_text": {
      const idx = state.nodes.findIndex((n) => n.id === op.id);
      if (idx === -1) return { ok: false, error: `Node "${op.id}" not found` };
      const node = state.nodes[idx];
      if (node.type !== "text")
        return { ok: false, error: `Node "${op.id}" is not a text node` };
      pushHistory(state);
      state.nodes[idx] = { ...node, text: op.text };
      return { ok: true };
    }
    case "edit_link": {
      const idx = state.nodes.findIndex((n) => n.id === op.id);
      if (idx === -1) return { ok: false, error: `Node "${op.id}" not found` };
      const node = state.nodes[idx];
      if (node.type !== "link")
        return { ok: false, error: `Node "${op.id}" is not a link node` };
      pushHistory(state);
      state.nodes[idx] = { ...node, url: op.url };
      return { ok: true };
    }
    case "edit_group_label": {
      const idx = state.nodes.findIndex((n) => n.id === op.id);
      if (idx === -1) return { ok: false, error: `Node "${op.id}" not found` };
      const node = state.nodes[idx];
      if (node.type !== "group")
        return { ok: false, error: `Node "${op.id}" is not a group node` };
      pushHistory(state);
      state.nodes[idx] = { ...node, label: op.label };
      return { ok: true };
    }
    case "set_node_color": {
      const idx = state.nodes.findIndex((n) => n.id === op.id);
      if (idx === -1) return { ok: false, error: `Node "${op.id}" not found` };
      pushHistory(state);
      const node = state.nodes[idx];
      const updated = { ...node };
      if (op.color === undefined) {
        delete updated.color;
      } else {
        updated.color = op.color;
      }
      state.nodes[idx] = updated;
      return { ok: true };
    }
    case "add_node": {
      if (state.nodes.some((n) => n.id === op.node.id))
        return { ok: false, error: `Node id "${op.node.id}" already exists` };
      pushHistory(state);
      state.nodes.push({ ...op.node });
      return { ok: true };
    }
    case "delete_node": {
      const idx = state.nodes.findIndex((n) => n.id === op.id);
      if (idx === -1) return { ok: false, error: `Node "${op.id}" not found` };
      pushHistory(state);
      state.nodes.splice(idx, 1);
      // Also remove all edges touching this node.
      state.edges = state.edges.filter(
        (e) => e.fromNode !== op.id && e.toNode !== op.id,
      );
      return { ok: true };
    }
    case "add_edge": {
      if (state.edges.some((e) => e.id === op.edge.id))
        return { ok: false, error: `Edge id "${op.edge.id}" already exists` };
      if (!state.nodes.some((n) => n.id === op.edge.fromNode))
        return { ok: false, error: `fromNode "${op.edge.fromNode}" not found` };
      if (!state.nodes.some((n) => n.id === op.edge.toNode))
        return { ok: false, error: `toNode "${op.edge.toNode}" not found` };
      pushHistory(state);
      state.edges.push({ ...op.edge });
      return { ok: true };
    }
    case "delete_edge": {
      const idx = state.edges.findIndex((e) => e.id === op.id);
      if (idx === -1) return { ok: false, error: `Edge "${op.id}" not found` };
      pushHistory(state);
      state.edges.splice(idx, 1);
      return { ok: true };
    }
    case "edit_edge_label": {
      const idx = state.edges.findIndex((e) => e.id === op.id);
      if (idx === -1) return { ok: false, error: `Edge "${op.id}" not found` };
      pushHistory(state);
      const edge = state.edges[idx];
      const updated = { ...edge };
      if (op.label === undefined) {
        delete updated.label;
      } else {
        updated.label = op.label;
      }
      state.edges[idx] = updated;
      return { ok: true };
    }
    case "reorder_edges": {
      if (op.ids.length !== state.edges.length)
        return {
          ok: false,
          error: `reorder_edges: expected ${state.edges.length} ids, got ${op.ids.length}`,
        };
      const edgeMap = new Map(state.edges.map((e) => [e.id, e]));
      for (const id of op.ids) {
        if (!edgeMap.has(id))
          return { ok: false, error: `reorder_edges: unknown edge id "${id}"` };
      }
      pushHistory(state);
      state.edges = op.ids.map((id) => edgeMap.get(id) as CanvasEdge);
      return { ok: true };
    }
  }
}

// ---------------------------------------------------------------------------
// undoCanvasOp / redoCanvasOp
// ---------------------------------------------------------------------------

export function undoCanvasOp(state: CanvasEditorState): boolean {
  const prev = state.history.pop();
  if (!prev) return false;
  // Push current snapshot onto redo stack before restoring.
  state.future.push(snapshot(state));
  state.nodes = prev.nodes.map((n) => ({ ...n }));
  state.edges = prev.edges.map((e) => ({ ...e }));
  return true;
}

export function redoCanvasOp(state: CanvasEditorState): boolean {
  const next = state.future.pop();
  if (!next) return false;
  state.history.push(snapshot(state));
  state.nodes = next.nodes.map((n) => ({ ...n }));
  state.edges = next.edges.map((e) => ({ ...e }));
  return true;
}

// ---------------------------------------------------------------------------
// canvasEditorToCanvas — extract a plain Canvas for serialization
// ---------------------------------------------------------------------------

export function canvasEditorToCanvas(state: CanvasEditorState): Canvas {
  return {
    nodes: state.nodes.map((n) => ({ ...n })),
    edges: state.edges.map((e) => ({ ...e })),
  };
}

// ---------------------------------------------------------------------------
// nodeAnchor
// ---------------------------------------------------------------------------

export function nodeAnchor(
  node: CanvasNodeBase,
  side: CanvasSide | undefined,
  toward: { x: number; y: number },
): { x: number; y: number } {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;

  const resolvedSide: CanvasSide =
    side ??
    (() => {
      const dx = toward.x - cx;
      const dy = toward.y - cy;
      if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0 ? "right" : "left";
      }
      return dy >= 0 ? "bottom" : "top";
    })();

  switch (resolvedSide) {
    case "top":
      return { x: cx, y: node.y };
    case "bottom":
      return { x: cx, y: node.y + node.height };
    case "left":
      return { x: node.x, y: cy };
    case "right":
      return { x: node.x + node.width, y: cy };
  }
}
