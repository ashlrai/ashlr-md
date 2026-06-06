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
