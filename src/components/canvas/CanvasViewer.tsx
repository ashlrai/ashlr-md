/**
 * CanvasViewer.tsx — editor for Obsidian / JSON Canvas (`.canvas`).
 *
 * Renders the node-and-edge graph on a pannable, zoomable surface:
 *   - text nodes  → Markdown (via the same Renderer)
 *   - file nodes  → inline image, or a titled card embedding the Markdown
 *   - link nodes  → a card with the external URL
 *   - group nodes → a labelled rectangle behind its members
 *   - edges       → SVG connectors with optional arrowheads + labels
 *
 * Drag nodes to move, drag the background to pan, scroll to zoom. Text nodes
 * have an explicit editor; changes use the document store’s guarded save.
 */

import { invoke } from "@tauri-apps/api/core";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type CanvasBounds,
  type CanvasEdge,
  type CanvasFileNode,
  type CanvasNode,
  type CanvasNodeBase,
  canvasBounds,
  canvasSkippedNotice,
  fitTransform,
  nodeAnchor,
  parseCanvas,
  resolveCanvasColor,
  type ViewTransform,
} from "../../lib/canvas";
import { type CanvasEdit, editCanvas } from "../../lib/canvas-edit";
import { linkOpenError } from "../../lib/docLinks";
import { isActionEnter, isDismissEscape } from "../../lib/keymap";
import { extractSection, isImageTarget } from "../../lib/transclude";
import { resolveWikilink } from "../../lib/wikilink";
import { useDocumentStore } from "../../store/documentStore";
import { toast } from "../../store/toastStore";
import { Renderer } from "../viewer/Renderer";
import "../../styles/canvas.css";

const MIN_SCALE = 0.05;
const MAX_SCALE = 2;
const FIT_PADDING = 60;

// Stable empty references so the parse-failed render path doesn't churn the
// nodes/edges memo identities.
const EMPTY_NODES: CanvasNode[] = [];
const EMPTY_EDGES: CanvasEdge[] = [];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function centerOf(n: CanvasNodeBase) {
  return { x: n.x + n.width / 2, y: n.y + n.height / 2 };
}

/** Only treat web/mail URLs as clickable — a `.canvas` file is untrusted, so a
 *  `javascript:` link node must never become a live href. */
function isSafeUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url.trim());
}

export function CanvasViewer({ content }: { content: string }) {
  const activeId = useDocumentStore((s) => s.activeId);
  const parsed = useMemo(() => parseCanvas(content), [content]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewTransform>({ scale: 1, offsetX: 0, offsetY: 0 });
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    ox: number;
    oy: number;
    scale: number;
    node?: CanvasNode;
    source: string;
    tabId: string | null;
  } | null>(null);
  const [moving, setMoving] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const commit = useCallback(
    (edit: CanvasEdit, source: string, tabId: string | null) => {
      const store = useDocumentStore.getState();
      if (store.activeId !== tabId || store.content !== source) {
        toast.error("Canvas changed during editing. Please try again.");
        return false;
      }
      try {
        const updated = editCanvas(source, edit);
        if (updated === source) return true;
        store.setContent(updated);
        void store.save();
        return true;
      } catch (error) {
        toast.error(`Could not edit canvas: ${String(error)}`);
        return false;
      }
    },
    [],
  );

  const editText = useCallback(
    (id: string, text: string, source: string) =>
      commit({ type: "edit_text", id, text }, source, activeId),
    [commit, activeId],
  );

  // Derive nodes/edges once, then memoize the bounds + id-index so neither is
  // recomputed on every pan tick (each pan fires setView → a full re-render).
  const nodes = useMemo(() => {
    const original = parsed.ok ? parsed.canvas.nodes : EMPTY_NODES;
    return moving && drag.current?.tabId === activeId && drag.current.source === content
      ? original.map((n) => (n.id === moving.id ? { ...n, ...moving } : n))
      : original;
  }, [parsed, moving, activeId, content]);
  const edges = parsed.ok ? parsed.canvas.edges : EMPTY_EDGES;
  const bounds = useMemo(() => canvasBounds(nodes), [nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const notice = parsed.ok ? canvasSkippedNotice(parsed.skipped) : null;

  // Fit the whole canvas into view (used by the effect below and the Fit button).
  const fitView = useMemo(
    () => () => {
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      setView(fitTransform(bounds, el.clientWidth, el.clientHeight, FIT_PADDING));
    },
    [bounds],
  );

  // Auto-fit once per document, when the container actually has a size. In the
  // Tauri webview clientWidth can be 0 on first mount, so we observe resize and
  // fit on the first non-zero layout instead of fitting to a 0-width box (which
  // would leave the canvas stuck at min zoom).
  const fittedRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const tryFit = () => {
      if (
        fittedRef.current === activeId ||
        el.clientWidth === 0 ||
        el.clientHeight === 0
      )
        return;
      fitView();
      fittedRef.current = activeId;
    };
    tryFit();
    const ro = new ResizeObserver(tryFit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitView, activeId]);

  if (!parsed.ok) {
    return (
      <div className="canvas-viewer canvas-viewer--error">
        Couldn't read this canvas: {parsed.error}
      </div>
    );
  }

  // ── Pan / zoom handlers ────────────────────────────────────────────────────
  const onWheel = (e: React.WheelEvent) => {
    if (drag.current || (e.target as HTMLElement).closest("textarea,input")) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setView((v) => {
      const next = clamp(v.scale * (1 - e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
      // Keep the point under the cursor stationary while zooming.
      const wx = (cx - v.offsetX) / v.scale;
      const wy = (cy - v.offsetY) / v.scale;
      return { scale: next, offsetX: cx - wx * next, offsetY: cy - wy * next };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (
      drag.current ||
      e.button !== 0 ||
      (e.target as HTMLElement).closest("a,button,input,textarea,select")
    )
      return;
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-canvas-node]")
      ?.dataset.canvasNode;
    e.preventDefault();
    drag.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      ox: view.offsetX,
      oy: view.offsetY,
      scale: view.scale,
      node: nodeById.get(id ?? ""),
      source: content,
      tabId: activeId,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.node) {
      setMoving({
        id: d.node.id,
        x: d.node.x + (e.clientX - d.x) / d.scale,
        y: d.node.y + (e.clientY - d.y) / d.scale,
      });
      return;
    }
    setView((v) => ({
      ...v,
      offsetX: d.ox + (e.clientX - d.x),
      offsetY: d.oy + (e.clientY - d.y),
    }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setMoving(null);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d.node && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3) {
      commit(
        {
          type: "move_node",
          id: d.node.id,
          x: d.node.x + (e.clientX - d.x) / d.scale,
          y: d.node.y + (e.clientY - d.y) / d.scale,
        },
        d.source,
        d.tabId,
      );
    }
  };
  const cancelDrag = (e: React.PointerEvent) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    setMoving(null);
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

  return (
    <div className="canvas-viewer">
      <div className="canvas-toolbar">
        <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
          −
        </button>
        <span className="canvas-zoom-label">{Math.round(view.scale * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={fitView} className="canvas-fit-btn">
          Fit
        </button>
      </div>
      {notice && (
        <div className="canvas-notice" role="status">
          {notice}
        </div>
      )}
      <div
        ref={containerRef}
        className="canvas-surface"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
      >
        <div
          className="canvas-world"
          style={{
            transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`,
          }}
        >
          <CanvasEdges nodes={nodeById} edges={edges} bounds={bounds} />
          {nodes.map((n) => (
            <CanvasNodeView
              key={`${activeId}:${n.id}`}
              node={n}
              content={content}
              onTextEdit={editText}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Edges ─────────────────────────────────────────────────────────────────────

function CanvasEdges({
  nodes,
  edges,
  bounds,
}: {
  nodes: Map<string, CanvasNode>;
  edges: CanvasEdge[];
  bounds: CanvasBounds;
}) {
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

  // Per-instance marker id — a hardcoded global id would collide when two
  // canvases render at once (split view / tab switch), making one canvas's
  // arrowheads resolve to the other's marker. useId() is unique per component.
  const markerId = `canvas-arrow-${useId().replace(/:/g, "")}`;

  if (drawn.length === 0) return null;

  // Give the SVG a real (non-zero) viewport at the world's bounding box —
  // a 0×0 overflow:visible SVG is not reliably painted in WebKit (macOS), so
  // edges would silently vanish. Content is translated into the SVG's local
  // space so line coords stay in raw canvas coordinates.
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
          const stroke =
            resolveCanvasColor(e.color) ?? "var(--canvas-edge, var(--text-muted))";
          // Obsidian defaults to an arrow at the destination end.
          const toArrow = e.toEnd !== "none";
          const fromArrow = e.fromEnd === "arrow";
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g key={e.id}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={stroke}
                strokeWidth={2}
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

// ── Nodes ─────────────────────────────────────────────────────────────────────

// Memoized: nodes don't change during a pan/zoom (only the world transform
// does), so they never need to re-render on a pan tick.
const CanvasNodeView = memo(function CanvasNodeView({
  node,
  content,
  onTextEdit,
}: {
  node: CanvasNode;
  content: string;
  onTextEdit: (id: string, text: string, source: string) => boolean;
}) {
  const [draft, setDraft] = useState<{ text: string; source: string } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null;
  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);
  const color = resolveCanvasColor(node.color);
  const style: React.CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    ...(color ? { borderColor: color } : {}),
  };

  if (node.type === "group") {
    return (
      <div
        className="canvas-node canvas-node--group"
        style={style}
        data-canvas-node={node.id}
      >
        {node.label && <div className="canvas-group-label">{node.label}</div>}
      </div>
    );
  }

  if (node.type === "text") {
    return (
      <div
        className="canvas-node canvas-node--text"
        style={style}
        data-canvas-node={node.id}
      >
        {draft ? (
          <form
            className="canvas-text-editor"
            onSubmit={(e) => {
              e.preventDefault();
              if (onTextEdit(node.id, draft.text, draft.source)) setDraft(null);
            }}
          >
            <textarea
              ref={editor}
              aria-label="Node text"
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              onKeyDown={(e) => {
                if (isDismissEscape(e)) {
                  e.preventDefault();
                  setDraft(null);
                }
                if (isActionEnter(e) && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div>
              <button type="submit">Save text</button>{" "}
              <button type="button" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <button
              type="button"
              className="canvas-node__edit"
              onClick={() => setDraft({ text: node.text, source: content })}
            >
              Edit text
            </button>
            <div className="canvas-node__scroll">
              <Renderer content={node.text} />
            </div>
          </>
        )}
      </div>
    );
  }

  if (node.type === "link") {
    return (
      <div
        className="canvas-node canvas-node--link"
        style={style}
        data-canvas-node={node.id}
      >
        {isSafeUrl(node.url) ? (
          <a href={node.url} target="_blank" rel="noreferrer noopener">
            {node.url}
          </a>
        ) : (
          <span className="canvas-node__muted">{node.url}</span>
        )}
      </div>
    );
  }

  return <CanvasFileNodeView node={node} style={style} />;
});

function CanvasFileNodeView({
  node,
  style,
}: {
  node: CanvasFileNode;
  style: React.CSSProperties;
}) {
  const isImage = isImageTarget(node.file);
  // undefined = loading, null = unresolved, string = data URL (image) or md text.
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  const [absPath, setAbsPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const path = await resolveWikilink(node.file);
      if (!path) {
        // No title action for a file that no longer resolves: the path
        // resolved for the node's previous file is not this one.
        if (!cancelled) {
          setAbsPath(null);
          setResolved(null);
        }
        return;
      }
      if (!cancelled) setAbsPath(path);
      try {
        if (isImage) {
          const url = await invoke<string>("read_image_data_url", { path });
          if (!cancelled) setResolved(url);
        } else {
          const doc = await invoke<{ content: string }>("read_markdown_file", { path });
          // Honor a `#heading` / `#^block` subpath (JSON Canvas file nodes can
          // scope an embed to a section, just like ![[note#heading]]).
          const text = node.subpath
            ? extractSection(doc.content, node.subpath.replace(/^#/, ""))
            : doc.content;
          if (!cancelled) setResolved(text);
        }
      } catch {
        if (!cancelled) setResolved(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [node.file, node.subpath, isImage]);

  const fileName = node.file.split("/").pop() ?? node.file;

  return (
    <div
      className="canvas-node canvas-node--file"
      style={style}
      data-canvas-node={node.id}
    >
      <div className="canvas-node__title">
        {absPath ? (
          <button
            type="button"
            className="canvas-node__open"
            // A file deleted or moved since the card resolved it is said in
            // a toast; the canvas stays in view. It was replaced by the error.
            // An image is not a document the app can open (reading it as
            // text failed with a toast): its title shows it in its folder.
            onClick={() => {
              if (isImage) {
                // The opener plugin's own command (allowed by opener:default);
                // its JS wrapper is only this call, so it is not a dependency.
                void invoke("plugin:opener|reveal_item_in_dir", {
                  paths: [absPath],
                }).catch((e: unknown) => {
                  toast.error(`Could not show ${fileName} in its folder: ${String(e)}`);
                });
                return;
              }
              void useDocumentStore
                .getState()
                .openPath(absPath, { keepViewOnError: true })
                .then((error) => {
                  if (error !== null) toast.error(linkOpenError(absPath, error));
                });
            }}
            title={isImage ? `Show ${fileName} in its folder` : `Open ${fileName}`}
          >
            {fileName}
          </button>
        ) : (
          fileName
        )}
      </div>
      <div className="canvas-node__scroll">
        {resolved === undefined ? (
          <span className="canvas-node__muted">Loading…</span>
        ) : resolved === null ? (
          <span className="canvas-node__muted">⚠ Missing “{node.file}”</span>
        ) : isImage ? (
          <img className="canvas-node__image" src={resolved} alt={fileName} />
        ) : (
          <Renderer content={resolved} />
        )}
      </div>
    </div>
  );
}
