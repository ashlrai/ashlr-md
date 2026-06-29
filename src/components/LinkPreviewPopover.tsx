/**
 * LinkPreviewPopover.tsx — Obsidian-style inline link preview on hover.
 *
 * Shows a 300px-wide, up-to-200px-tall scrollable card with:
 *   • Internal .md links   → first heading + paragraph (or first 15 lines)
 *                            rendered as markdown via a lightweight renderer.
 *   • External http(s) links → "External link — <domain>" (no network fetch).
 *   • All other hrefs       → nothing shown.
 *
 * The card fades in after a 500 ms hover delay and is portaled to <body> so it
 * never gets clipped by overflow:hidden ancestors. The anchor element is passed
 * as a render-prop child so this component owns the onMouseEnter / onMouseLeave
 * wiring without needing to clone or wrap unknown elements.
 *
 * Usage (inside a link renderer):
 *
 *   <LinkPreviewPopover href={href} currentPath={documentPath}>
 *     {(handlers) => <a href={href} {...handlers}>{children}</a>}
 *   </LinkPreviewPopover>
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type LinkPreviewResult, resolveLinkPreview } from "../lib/linkPreview";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HoverHandlers {
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}

export interface LinkPreviewPopoverProps {
  href: string;
  /** Absolute path of the currently open document — needed for relative resolution. */
  currentPath: string | null;
  children: (handlers: HoverHandlers) => ReactNode;
}

// ---------------------------------------------------------------------------
// Card position
// ---------------------------------------------------------------------------

interface CardPos {
  top: number;
  left: number;
}

function computePosition(rect: DOMRect): CardPos {
  const CARD_WIDTH = 300;
  const MARGIN = 8;
  const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - CARD_WIDTH - MARGIN));
  // Prefer below the link; flip above if not enough space.
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow >= 212 ? rect.bottom + 6 : rect.top - 210;
  return { top, left };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Delay in ms before the popover appears after the cursor enters the link. */
const HOVER_DELAY_MS = 500;

export function LinkPreviewPopover({
  href,
  currentPath,
  children,
}: LinkPreviewPopoverProps) {
  const [preview, setPreview] = useState<LinkPreviewResult | null>(null);
  const [pos, setPos] = useState<CardPos | null>(null);
  const [visible, setVisible] = useState(false);

  const hoverTimer = useRef<number | undefined>(undefined);
  const anchorRectRef = useRef<DOMRect | null>(null);

  // Cleanup on unmount.
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const show = useCallback(
    (rect: DOMRect) => {
      window.clearTimeout(hoverTimer.current);
      anchorRectRef.current = rect;
      hoverTimer.current = window.setTimeout(async () => {
        const result = await resolveLinkPreview(href, currentPath);
        if (!result) return; // "none" kind — don't show anything
        setPreview(result);
        setPos(computePosition(anchorRectRef.current ?? rect));
        setVisible(true);
      }, HOVER_DELAY_MS);
    },
    [href, currentPath],
  );

  const hide = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    setVisible(false);
    setPreview(null);
  }, []);

  const handlers: HoverHandlers = {
    onMouseEnter: (e) => show((e.currentTarget as HTMLElement).getBoundingClientRect()),
    onMouseLeave: hide,
    onFocus: (e) => show((e.currentTarget as HTMLElement).getBoundingClientRect()),
    onBlur: hide,
  };

  return (
    <>
      {children(handlers)}
      {visible && preview && pos &&
        createPortal(
          <LinkPreviewCard preview={preview} pos={pos} />,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface LinkPreviewCardProps {
  preview: LinkPreviewResult;
  pos: CardPos;
}

function LinkPreviewCard({ preview, pos }: LinkPreviewCardProps) {
  return (
    <div
      className="link-preview-card"
      role="tooltip"
      aria-label="Link preview"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: 300,
        maxHeight: 200,
        overflowY: "auto",
        zIndex: 9999,
        // Fade-in handled via CSS animation; fallback inline for envs without the stylesheet.
        animation: "link-preview-fadein 120ms ease-out",
      }}
    >
      {preview.kind === "external" ? (
        <p className="link-preview-card__external">{preview.snippet}</p>
      ) : (
        <div className="link-preview-card__internal">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {preview.snippet}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
