/**
 * CanvasEditor.tsx — interactive editor for JSON Canvas (.canvas) files.
 *
 * Extends the read-only CanvasViewer surface with:
 *   - Drag handles on every node (move by dragging)
 *   - Inline text/link/group-label edit overlays (double-click to edit)
 *   - Toolbar for add/delete node, add/delete edge operations
 *   - Undo / redo (Ctrl+Z / Ctrl+Shift+Z)
 *   - Save callback that serialises the canvas back to disk via Tauri IPC
 *
 * The component is self-contained: it owns a CanvasEditorState and manages
 * all mutations through applyCanvasOp / undoCanvasOp / redoCanvasOp.
 *
 * Security: URL nodes sanitised through isSafeUrl (same guard as CanvasViewer).
 */

import { invoke } from "@tauri-apps/api/core";
import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type CanvasBounds,
  type CanvasEdge,
  type CanvasEditorState,
  type CanvasNode,
  type CanvasNodeBase,
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
  type ViewTransform,
} from "../../lib/canvas";
import "../../styles/canvas.css";
import "../../styles/canvas-editor.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SCALE = 0.05;
const MAX_SCALE = 2;
const FIT_PADDING = 60;

const EMPTY_NODES: CanvasNode[] = [];
const EMPTY_EDGES: CanvasEdge[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function centerOf(n: CanvasNodeBase) {
  return { x: n.x + n.width / 2, y: n.y + n.height / 2 };
}

function isSafeUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url.trim());
}

function generateId(): string {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// useForceUpdate — lightweight re-render trigger
// ---------------------------------------------------------------------------

function useForceUpdate(): () => void {
  const [, dispatch] = useReducer((x: number) => x + 1, 0);
  return dispatch;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CanvasEditorProps {
  /** Raw .canvas file content. */
  content: string;
  /** Absolute file path — used when saving back to disk. */
  filePath?: string;
  /** Called with new serialised content after every successful save. */
  onSave?: (content: string) => void;
  /** Called when unsaved changes status changes. */
  onDirty?: (dirty: boolean) => void;
}

// ---------------------------------------------------------------------------
// CanvasEditor
// ---------------------------------------------------------------------------

export function CanvasEditor({ content, filePath, onSave, onDirty }: CanvasEditorProps) {
  const parsed = useMemo(() => parseCanvas(content), [content]);

  // Editor state lives in a ref — mutations don't re-render on their own;
  // the forceUpdate trigger is called explicitly after each mutation so React
  // batches DOM work correctly.
  const stateRef = useRef<CanvasEditorState | null>(null);
  const forceUpdate = useForceUpdate();
  const [dirty, setDirtyState] = useState(false);

  const setDirty = useCallback(
    (d: boolean) => {
      setDirtyState(d);
      onDirty?.(d);
    },
    [onDirty],
  );

  // Initialise / re-initialise when parsed content changes.
  useEffect(() => {
    if (!parsed.ok) return;
    stateRef.current = buildCanvasEditor(parsed.canvas);
    setDirty(false);
    forceUpdate();
  }, [parsed]); // eslint-disable-line react-hooks/exhaustive-deps

  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewTransform>({ scale: 1, offsetX: 0, offsetY: 0 });

  // Pan drag state.
  const panDrag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // Node drag state.
  const nodeDrag = useRef<{
    id: string;
    startX: number; // pointer start in canvas coords
    startY: number;
    origX: number; // node original position
    origY: number;
  } | null>(null);

  // Edge-add mode: first node selected, waiting for second click.
  const [edgeAddMode, setEdgeAddMode] = useState(false);
  const edgeFromRef = useRef<string | null>(null);

  // Currently editing node (for inline text/link/label overlay).
  const [editingId, setEditingId] = useState<string | null>(null);

  // Selected node / edge id.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const state = stateRef.current;
  const nodes = state?.nodes ?? EMPTY_NODES;
  const edges = state?.edges ?? EMPTY_EDGES;
  const bounds = useMemo(() => canvasBounds(nodes), [nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Fit on first paint.
  const fittedRef = useRef(false);
  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
    setView(fitTransform(bounds, el.clientWidth, el.clientHeight, FIT_PADDING));
  }, [bounds]);

  useEffect(() => {
    fittedRef.current = false;
  }, [content]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const tryFit = () => {
      if (fittedRef.current || el.clientWidth === 0 || el.clientHeight === 0) return;
      fit();
      fittedRef.current = true;
    };
    tryFit();
    const ro = new ResizeObserver(tryFit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, content]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: globalThis.KeyboardEvent) => {
      if (editingId) return; // don't intercept while inline-editing
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (mod && (e.key === "Z" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
      } else if (mod && e.key === "s") {
        e.preventDefault();
        handleSave();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        handleDeleteSelected();
      } else if (e.key === "Escape") {
        setEdgeAddMode(false);
        edgeFromRef.current = null;
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }); // intentionally no dep array — capture latest state each time

  // ── Mutations ───────────────────────────────────────────────────────────────
  function mutate(op: Parameters<typeof applyCanvasOp>[1]): boolean {
    if (!stateRef.current) return false;
    const result = applyCanvasOp(stateRef.current, op);
    if (!result.ok) return false;
    setDirty(true);
    forceUpdate();
    return true;
  }

  function handleUndo() {
    if (!stateRef.current) return;
    if (undoCanvasOp(stateRef.current)) {
      setDirty(true);
      forceUpdate();
    }
  }

  function handleRedo() {
    if (!stateRef.current) return;
    if (redoCanvasOp(stateRef.current)) {
      setDirty(true);
      forceUpdate();
    }
  }

  async function handleSave() {
    if (!stateRef.current) return;
    const serialised = serializeCanvas(canvasEditorToCanvas(stateRef.current));
    if (filePath) {
      try {
        await invoke("write_file", { path: filePath, content: serialised });
      } catch {
        // Silently fall back to calling onSave — let the parent handle storage.
      }
    }
    onSave?.(serialised);
    setDirty(false);
  }

  function handleDeleteSelected() {
    if (!selectedId || !stateRef.current) return;
    const isNode = stateRef.current.nodes.some((n) => n.id === selectedId);
    const isEdge = stateRef.current.edges.some((e) => e.id === selectedId);
    if (isNode) mutate({ type: "delete_node", id: selectedId });
    else if (isEdge) mutate({ type: "delete_edge", id: selectedId });
    setSelectedId(null);
  }

  function handleAddTextNode() {
    const el = containerRef.current;
    if (!el) return;
    // Place new node in the visible centre of the viewport.
    const cx = (el.clientWidth / 2 - view.offsetX) / view.scale;
    const cy = (el.clientHeight / 2 - view.offsetY) / view.scale;
    const id = generateId();
    mutate({
      type: "add_node",
      node: { id, type: "text", x: cx - 100, y: cy - 50, width: 200, height: 100, text: "New note" },
    });
    setSelectedId(id);
  }

  function handleAddLinkNode() {
    const el = containerRef.current;
    if (!el) return;
    const cx = (el.clientWidth / 2 - view.offsetX) / view.scale;
    const cy = (el.clientHeight / 2 - view.offsetY) / view.scale;
    const id = generateId();
    mutate({
      type: "add_node",
      node: { id, type: "link", x: cx - 100, y: cy - 50, width: 200, height: 80, url: "https://" },
    });
    setSelectedId(id);
    setEditingId(id);
  }

  function handleAddGroupNode() {
    const el = containerRef.current;
    if (!el) return;
    const cx = (el.clientWidth / 2 - view.offsetX) / view.scale;
    const cy = (el.clientHeight / 2 - view.offsetY) / view.scale;
    const id = generateId();
    mutate({
      type: "add_node",
      node: { id, type: "group", x: cx - 150, y: cy - 100, width: 300, height: 200, label: "Group" },
    });
    setSelectedId(id);
  }

  function handleStartEdgeAdd() {
    setEdgeAddMode(true);
    edgeFromRef.current = null;
  }

  function handleNodeClickInEdgeMode(nodeId: string) {
    if (!edgeFromRef.current) {
      edgeFromRef.current = nodeId;
    } else {
      if (edgeFromRef.current !== nodeId) {
        const id = `e${generateId()}`;
        mutate({
          type: "add_edge",
          edge: { id, fromNode: edgeFromRef.current, toNode: nodeId, toEnd: "arrow" },
        });
      }
      setEdgeAddMode(false);
      edgeFromRef.current = null;
    }
  }

  // ── Pan / zoom ──────────────────────────────────────────────────────────────
  const onWheel = (e: React.WheelEvent) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setView((v) => {
      const next = clamp(v.scale * (1 - e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
      const wx = (cx - v.offsetX) / v.scale;
      const wy = (cy - v.offsetY) / v.scale;
      return { scale: next, offsetX: cx - wx * next, offsetY: cy - wy * next };
    });
  };

  // Surface pointer events — only start pan if not on a node.
  const onSurfacePointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-canvas-node]") || target.closest("[data-canvas-edge]")) return;
    panDrag.current = { x: e.clientX, y: e.clientY, ox: view.offsetX, oy: view.offsetY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (!edgeAddMode) setSelectedId(null);
  };

  const onSurfacePointerMove = (e: React.PointerEvent) => {
    if (nodeDrag.current) {
      // Delegate to node-level logic (handled via onNodePointerMove).
      return;
    }
    const d = panDrag.current;
    if (!d) return;
    setView((v) => ({
      ...v,
      offsetX: d.ox + (e.clientX - d.x),
      offsetY: d.oy + (e.clientY - d.y),
    }));
  };

  const onSurfacePointerUp = (e: React.PointerEvent) => {
    panDrag.current = null;
    nodeDrag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const zoomBy = (factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    setView((v) => {
      const next = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      const wx = (cx - v.offsetX) / v.scale;
      const wy = (cy - v.offsetY) / v.scale;
      return { scale: next, offsetX: cx - wx * next, offsetY: cy - wy * next };
    });
  };

  // ── Node drag ───────────────────────────────────────────────────────────────
  const onNodePointerDown = useCallback(
    (e: React.PointerEvent, nodeId: string) => {
      if (edgeAddMode) {
        handleNodeClickInEdgeMode(nodeId);
        e.stopPropagation();
        return;
      }
      if ((e.target as HTMLElement).closest("button,a,textarea,input")) return;
      e.stopPropagation();
      const node = stateRef.current?.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      setSelectedId(nodeId);
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const canvasX = (e.clientX - rect.left - view.offsetX) / view.scale;
      const canvasY = (e.clientY - rect.top - view.offsetY) / view.scale;
      nodeDrag.current = {
        id: nodeId,
        startX: canvasX,
        startY: canvasY,
        origX: node.x,
        origY: node.y,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [edgeAddMode, view], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onNodePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = nodeDrag.current;
      if (!d || !stateRef.current) return;
      e.stopPropagation();
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const canvasX = (e.clientX - rect.left - view.offsetX) / view.scale;
      const canvasY = (e.clientY - rect.top - view.offsetY) / view.scale;
      const dx = canvasX - d.startX;
      const dy = canvasY - d.startY;
      const nodeIdx = stateRef.current.nodes.findIndex((n) => n.id === d.id);
      if (nodeIdx === -1) return;
      // Directly update position without going through history mid-drag.
      const node = stateRef.current.nodes[nodeIdx];
      stateRef.current.nodes[nodeIdx] = {
        ...node,
        x: Math.round(d.origX + dx),
        y: Math.round(d.origY + dy),
      };
      forceUpdate();
    },
    [view, forceUpdate],
  );

  const onNodePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = nodeDrag.current;
      if (!d || !stateRef.current) {
        nodeDrag.current = null;
        return;
      }
      e.stopPropagation();
      const node = stateRef.current.nodes.find((n) => n.id === d.id);
      if (node && (node.x !== d.origX || node.y !== d.origY)) {
        // Commit: restore to original then go through history.
        stateRef.current.nodes = stateRef.current.nodes.map((n) =>
          n.id === d.id ? { ...n, x: d.origX, y: d.origY } : n,
        );
        mutate({ type: "move_node", id: d.id, x: node.x, y: node.y });
      }
      nodeDrag.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    },
    [view], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Inline edit ─────────────────────────────────────────────────────────────
  const onNodeDoubleClick = useCallback((nodeId: string) => {
    setEditingId(nodeId);
    setSelectedId(nodeId);
  }, []);

  const commitEdit = useCallback(
    (nodeId: string, value: string) => {
      if (!stateRef.current) return;
      const node = stateRef.current.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      if (node.type === "text") mutate({ type: "edit_text", id: nodeId, text: value });
      else if (node.type === "link") mutate({ type: "edit_link", id: nodeId, url: value });
      else if (node.type === "group") mutate({ type: "edit_group_label", id: nodeId, label: value });
      setEditingId(null);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Edge click ──────────────────────────────────────────────────────────────
  const onEdgeClick = useCallback((edgeId: string) => {
    setSelectedId(edgeId);
  }, []);

  // ── Error state ─────────────────────────────────────────────────────────────
  if (!parsed.ok) {
    return (
      <div className="canvas-viewer canvas-viewer--error">
        Couldn't read this canvas: {parsed.error}
      </div>
    );
  }

  return (
    <div className="canvas-viewer canvas-editor">
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="canvas-toolbar canvas-editor-toolbar">
        <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
          −
        </button>
        <span className="canvas-zoom-label">{Math.round(view.scale * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={fit} className="canvas-fit-btn">
          Fit
        </button>
        <span className="canvas-toolbar-sep" />
        <button
          type="button"
          title="Add text node"
          onClick={handleAddTextNode}
          className="canvas-toolbar-icon"
          aria-label="Add text node"
        >
          T+
        </button>
        <button
          type="button"
          title="Add link node"
          onClick={handleAddLinkNode}
          className="canvas-toolbar-icon"
          aria-label="Add link node"
        >
          🔗
        </button>
        <button
          type="button"
          title="Add group node"
          onClick={handleAddGroupNode}
          className="canvas-toolbar-icon"
          aria-label="Add group node"
        >
          ▣
        </button>
        <button
          type="button"
          title="Add edge (click two nodes)"
          onClick={handleStartEdgeAdd}
          className={`canvas-toolbar-icon${edgeAddMode ? " canvas-toolbar-icon--active" : ""}`}
          aria-label="Add edge"
          aria-pressed={edgeAddMode}
        >
          →
        </button>
        <button
          type="button"
          title="Delete selected (Del)"
          onClick={handleDeleteSelected}
          className="canvas-toolbar-icon canvas-toolbar-delete"
          aria-label="Delete selected"
          disabled={!selectedId}
        >
          🗑
        </button>
        <span className="canvas-toolbar-sep" />
        <button
          type="button"
          title="Undo (Ctrl+Z)"
          onClick={handleUndo}
          className="canvas-toolbar-icon"
          aria-label="Undo"
          disabled={!stateRef.current?.history.length}
        >
          ↩
        </button>
        <button
          type="button"
          title="Redo (Ctrl+Shift+Z)"
          onClick={handleRedo}
          className="canvas-toolbar-icon"
          aria-label="Redo"
          disabled={!stateRef.current?.future.length}
        >
          ↪
        </button>
        <span className="canvas-toolbar-sep" />
        <button
          type="button"
          onClick={handleSave}
          className={`canvas-fit-btn${dirty ? " canvas-save-dirty" : ""}`}
          aria-label="Save canvas"
          title="Save (Ctrl+S)"
        >
          {dirty ? "Save*" : "Save"}
        </button>
      </div>

      {edgeAddMode && (
        <div className="canvas-edge-add-hint">
          {edgeFromRef.current ? "Click target node to complete edge" : "Click source node"}
        </div>
      )}

      {/* ── Canvas surface ────────────────────────────────────────────────── */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pan surface */}
      <div
        ref={containerRef}
        className={`canvas-surface${edgeAddMode ? " canvas-surface--edge-mode" : ""}`}
        onWheel={onWheel}
        onPointerDown={onSurfacePointerDown}
        onPointerMove={(e) => {
          onSurfacePointerMove(e);
          onNodePointerMove(e);
        }}
        onPointerUp={(e) => {
          onSurfacePointerUp(e);
          onNodePointerUp(e);
        }}
        onPointerCancel={(e) => {
          onSurfacePointerUp(e);
          onNodePointerUp(e);
        }}
      >
        <div
          className="canvas-world"
          style={{
            transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`,
          }}
        >
          <CanvasEditorEdges
            nodes={nodeById}
            edges={edges}
            bounds={bounds}
            selectedId={selectedId}
            onEdgeClick={onEdgeClick}
          />
          {nodes.map((n) => (
            <CanvasEditorNodeView
              key={n.id}
              node={n}
              selected={selectedId === n.id}
              editing={editingId === n.id}
              edgeAddMode={edgeAddMode}
              edgeFromId={edgeFromRef.current}
              onPointerDown={onNodePointerDown}
              onPointerMove={onNodePointerMove}
              onPointerUp={onNodePointerUp}
              onDoubleClick={onNodeDoubleClick}
              onCommitEdit={commitEdit}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CanvasEditorEdges
// ---------------------------------------------------------------------------

function CanvasEditorEdges({
  nodes,
  edges,
  bounds,
  selectedId,
  onEdgeClick,
}: {
  nodes: Map<string, CanvasNode>;
  edges: CanvasEdge[];
  bounds: CanvasBounds;
  selectedId: string | null;
  onEdgeClick: (id: string) => void;
}) {
  const markerId = `canvas-arrow-${useId().replace(/:/g, "")}`;

  const drawn = edges
    .map((e) => {
      const from = nodes.get(e.fromNode);
      const to = nodes.get(e.toNode);
      if (!from || !to) return null;
      const a = nodeAnchor(from, e.fromSide, centerOf(to));
      const b = nodeAnchor(to, e.toSide, centerOf(from));
      return { e, a, b };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (drawn.length === 0) return null;

  return (
    <svg
      className="canvas-edges"
      aria-hidden="true"
      style={{
        left: bounds.minX,
        top: bounds.minY,
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
      }}
    >
      <g transform={`translate(${-bounds.minX}, ${-bounds.minY})`}>
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="var(--canvas-edge, var(--text-muted))" />
          </marker>
        </defs>
        {drawn.map(({ e, a, b }) => {
          const isSelected = selectedId === e.id;
          const stroke = resolveCanvasColor(e.color) ?? "var(--canvas-edge, var(--text-muted))";
          const toArrow = e.toEnd !== "none";
          const fromArrow = e.fromEnd === "arrow";
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g
              key={e.id}
              data-canvas-edge={e.id}
              className={`canvas-editor-edge${isSelected ? " canvas-editor-edge--selected" : ""}`}
              onClick={() => onEdgeClick(e.id)}
              style={{ cursor: "pointer" }}
            >
              {/* Wide invisible hit area */}
              <line
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="transparent"
                strokeWidth={12}
              />
              <line
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={isSelected ? "var(--accent)" : stroke}
                strokeWidth={isSelected ? 3 : 2}
                markerEnd={toArrow ? `url(#${markerId})` : undefined}
                markerStart={fromArrow ? `url(#${markerId})` : undefined}
              />
              {e.label && (
                <text x={mx} y={my} className="canvas-edge-label" textAnchor="middle">
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// CanvasEditorNodeView
// ---------------------------------------------------------------------------

interface NodeViewProps {
  node: CanvasNode;
  selected: boolean;
  editing: boolean;
  edgeAddMode: boolean;
  edgeFromId: string | null;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onDoubleClick: (id: string) => void;
  onCommitEdit: (id: string, value: string) => void;
}

const CanvasEditorNodeView = memo(function CanvasEditorNodeView({
  node,
  selected,
  editing,
  edgeAddMode,
  edgeFromId,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onDoubleClick,
  onCommitEdit,
}: NodeViewProps) {
  const color = resolveCanvasColor(node.color);
  const isEdgeSource = edgeFromId === node.id;

  const style: React.CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    ...(color ? { borderColor: color } : {}),
  };

  const className = [
    "canvas-node",
    `canvas-node--${node.type}`,
    selected ? "canvas-node--selected" : "",
    edgeAddMode ? "canvas-node--edge-target" : "",
    isEdgeSource ? "canvas-node--edge-source" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const handlePointerDown = (e: React.PointerEvent) => onPointerDown(e, node.id);
  const handleDoubleClick = () => onDoubleClick(node.id);

  if (node.type === "group") {
    return (
      <div
        className={className}
        style={style}
        data-canvas-node={node.id}
        onPointerDown={handlePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={handleDoubleClick}
      >
        {editing ? (
          <InlineTextEdit
            initialValue={node.label ?? ""}
            onCommit={(v) => onCommitEdit(node.id, v)}
            placeholder="Group label"
            singleLine
          />
        ) : (
          node.label && (
            <div className="canvas-group-label" title="Double-click to edit">
              {node.label}
            </div>
          )
        )}
        {selected && <div className="canvas-node-resize-handle" />}
      </div>
    );
  }

  if (node.type === "text") {
    return (
      <div
        className={className}
        style={style}
        data-canvas-node={node.id}
        onPointerDown={handlePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={handleDoubleClick}
      >
        {editing ? (
          <InlineTextEdit
            initialValue={node.text}
            onCommit={(v) => onCommitEdit(node.id, v)}
            placeholder="Note text…"
          />
        ) : (
          <div className="canvas-node__scroll canvas-node__text-preview">
            {node.text || <span className="canvas-node__muted">(empty)</span>}
          </div>
        )}
        {selected && <div className="canvas-node-resize-handle" />}
      </div>
    );
  }

  if (node.type === "link") {
    return (
      <div
        className={className}
        style={style}
        data-canvas-node={node.id}
        onPointerDown={handlePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={handleDoubleClick}
      >
        {editing ? (
          <InlineTextEdit
            initialValue={node.url}
            onCommit={(v) => onCommitEdit(node.id, v)}
            placeholder="https://…"
            singleLine
          />
        ) : isSafeUrl(node.url) ? (
          <a
            href={node.url}
            target="_blank"
            rel="noreferrer noopener"
            className="canvas-node__link"
            onClick={(e) => e.stopPropagation()}
          >
            {node.url}
          </a>
        ) : (
          <span className="canvas-node__muted">{node.url}</span>
        )}
        {selected && <div className="canvas-node-resize-handle" />}
      </div>
    );
  }

  // file node — not editable (path changes are out-of-scope), show file name.
  return (
    <div
      className={className}
      style={style}
      data-canvas-node={node.id}
      onPointerDown={handlePointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="canvas-node__title">{node.file.split("/").pop() ?? node.file}</div>
      {node.subpath && (
        <div className="canvas-node__scroll canvas-node__muted">{node.subpath}</div>
      )}
      {selected && <div className="canvas-node-resize-handle" />}
    </div>
  );
});

// ---------------------------------------------------------------------------
// InlineTextEdit
// ---------------------------------------------------------------------------

interface InlineTextEditProps {
  initialValue: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  singleLine?: boolean;
}

function InlineTextEdit({ initialValue, onCommit, placeholder, singleLine }: InlineTextEditProps) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => onCommit(value);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === "Escape") {
      onCommit(initialValue); // cancel — restore original
      return;
    }
    if (singleLine && e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    if (!singleLine && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  };

  if (singleLine) {
    return (
      <input
        ref={ref as React.Ref<HTMLInputElement>}
        className="canvas-inline-edit canvas-inline-edit--single"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <textarea
      ref={ref as React.Ref<HTMLTextAreaElement>}
      className="canvas-inline-edit canvas-inline-edit--multi"
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
