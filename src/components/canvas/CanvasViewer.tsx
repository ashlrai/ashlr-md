/**
 * CanvasViewer.tsx — read-only renderer for Obsidian / JSON Canvas (`.canvas`).
 *
 * Renders the node-and-edge graph on a pannable, zoomable surface:
 *   - text nodes  → Markdown (via the same Renderer)
 *   - file nodes  → inline image, or a titled card embedding the Markdown
 *   - link nodes  → a card with the external URL
 *   - group nodes → a labelled rectangle behind its members
 *   - edges       → SVG connectors with optional arrowheads + labels
 *
 * Read-only: drag the background to pan, scroll to zoom, "Fit" to reset. Node
 * positions are never written back.
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type CanvasBounds,
  type CanvasEdge,
  type CanvasFileNode,
  type CanvasNode,
  type CanvasNodeBase,
  canvasBounds,
  fitTransform,
  nodeAnchor,
  parseCanvas,
  resolveCanvasColor,
  type ViewTransform,
} from "../../lib/canvas";
import { isImageTarget } from "../../lib/transclude";
import { resolveWikilink } from "../../lib/wikilink";
import { useDocumentStore } from "../../store/documentStore";
import { Renderer } from "../viewer/Renderer";
import "../../styles/canvas.css";

const MIN_SCALE = 0.05;
const MAX_SCALE = 2;
const FIT_PADDING = 60;

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
  const parsed = useMemo(() => parseCanvas(content), [content]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewTransform>({ scale: 1, offsetX: 0, offsetY: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const bounds = useMemo(
    () => (parsed.ok ? canvasBounds(parsed.canvas.nodes) : null),
    [parsed],
  );

  // Fit the whole canvas into view (used by the effect below and the Fit button).
  const fit = useMemo(
    () => () => {
      const el = containerRef.current;
      if (!el || !bounds || el.clientWidth === 0 || el.clientHeight === 0) return;
      setView(fitTransform(bounds, el.clientWidth, el.clientHeight, FIT_PADDING));
    },
    [bounds],
  );

  // Auto-fit once per content, when the container actually has a size. In the
  // Tauri webview clientWidth can be 0 on first mount, so we observe resize and
  // fit on the first non-zero layout instead of fitting to a 0-width box (which
  // would leave the canvas stuck at min zoom).
  const fittedRef = useRef(false);
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

  if (!parsed.ok) {
    return (
      <div className="canvas-viewer canvas-viewer--error">
        Couldn't read this canvas: {parsed.error}
      </div>
    );
  }

  const { nodes, edges } = parsed.canvas;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // ── Pan / zoom handlers ────────────────────────────────────────────────────
  const onWheel = (e: React.WheelEvent) => {
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
    // Don't start a pan when interacting with a link/button inside a node.
    if ((e.target as HTMLElement).closest("a,button")) return;
    drag.current = { x: e.clientX, y: e.clientY, ox: view.offsetX, oy: view.offsetY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({
      ...v,
      offsetX: d.ox + (e.clientX - d.x),
      offsetY: d.oy + (e.clientY - d.y),
    }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
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
        <button type="button" onClick={fit} className="canvas-fit-btn">
          Fit
        </button>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pan surface */}
      <div
        ref={containerRef}
        className="canvas-surface"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="canvas-world"
          style={{
            transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`,
          }}
        >
          <CanvasEdges nodes={nodeById} edges={edges} bounds={canvasBounds(nodes)} />
          {nodes.map((n) => (
            <CanvasNodeView key={n.id} node={n} />
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
            id="canvas-arrow"
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
                markerEnd={toArrow ? "url(#canvas-arrow)" : undefined}
                markerStart={fromArrow ? "url(#canvas-arrow)" : undefined}
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

function CanvasNodeView({ node }: { node: CanvasNode }) {
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
        <div className="canvas-node__scroll">
          <Renderer content={node.text} />
        </div>
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
}

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
    (async () => {
      const path = await resolveWikilink(node.file);
      if (!path) {
        if (!cancelled) setResolved(null);
        return;
      }
      if (!cancelled) setAbsPath(path);
      try {
        if (isImage) {
          const url = await invoke<string>("read_image_data_url", { path });
          if (!cancelled) setResolved(url);
        } else {
          const doc = await invoke<{ content: string }>("read_markdown_file", { path });
          if (!cancelled) setResolved(doc.content);
        }
      } catch {
        if (!cancelled) setResolved(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [node.file, isImage]);

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
            onClick={() => useDocumentStore.getState().openPath(absPath)}
            title={`Open ${fileName}`}
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
