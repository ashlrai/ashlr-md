// Outline / table-of-contents panel — left-hand overlay (mirror of the Agent
// Activity drawer). Makes long, agent-generated docs navigable: a scrollable
// tree of headings, click-to-jump, and read-view scrollspy that tracks the
// heading currently at the top of the viewport.
//
// Slug parity with the rendered DOM is handled in ../lib/outline (it reuses the
// same github-slugger the renderer's rehype-slug plugin uses), so anchor jumps
// resolve via document.getElementById(slug).

import { useEffect, useMemo, useRef, useState } from "react";
import "../styles/outline.css";
import { formatShortcut } from "../lib/keymap";
import { type HeadingItem, parseHeadings } from "../lib/outline";
import { useDocumentStore } from "../store/documentStore";
import { useUiStore } from "../store/uiStore";

/** Per-depth indent step (px) for the heading tree. */
const INDENT_STEP = 12;

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Smoothly scroll a rendered heading into view by its slug id. */
function scrollToSlug(slug: string) {
  const el = document.getElementById(slug);
  el?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function Outline() {
  const open = useUiStore((s) => s.outlineOpen);
  const closeOutline = useUiStore((s) => s.closeOutline);

  const content = useDocumentStore((s) => s.content);
  const path = useDocumentStore((s) => s.path);
  const viewMode = useDocumentStore((s) => s.viewMode);

  // Rebuild only when the document content changes.
  const headings = useMemo(() => parseHeadings(content), [content]);

  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Scrollspy (read view only): mark the heading nearest the top of the
  // viewport as active using an IntersectionObserver over the rendered headings.
  // The top-biased rootMargin makes a heading "active" once it reaches roughly
  // the top quarter of the reading surface and stay active until the next one.
  useEffect(() => {
    if (!open || viewMode !== "read" || headings.length === 0) {
      setActiveSlug(null);
      return;
    }
    const body = document.querySelector(".markdown-body");
    if (!body) return;

    const els = headings
      .map((h) => document.getElementById(h.slug))
      .filter((el): el is HTMLElement => el != null);
    if (els.length === 0) return;

    // Track which headings are currently intersecting; the active one is the
    // last (lowest on the page) heading that has crossed the top threshold.
    const visible = new Set<string>();

    const pickActive = () => {
      // Prefer the lowest heading still within the top band.
      let chosen: string | null = null;
      for (const h of headings) {
        if (visible.has(h.slug)) chosen = h.slug;
      }
      // Nothing in the band (e.g. scrolled past all of section): fall back to
      // the last heading above the viewport top.
      if (!chosen) {
        const topY = body.getBoundingClientRect().top;
        let last: string | null = null;
        for (const h of headings) {
          const el = document.getElementById(h.slug);
          if (el && el.getBoundingClientRect().top <= topY + 8) last = h.slug;
        }
        chosen = last ?? headings[0].slug;
      }
      setActiveSlug(chosen);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).id;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        pickActive();
      },
      {
        root: body,
        // Active band: from the top down to ~85% — a heading is "current"
        // while its top sits near the top of the reading surface.
        rootMargin: "0px 0px -85% 0px",
        threshold: 0,
      },
    );

    for (const el of els) observer.observe(el);
    pickActive();

    return () => observer.disconnect();
    // Re-arm when the doc, view, or panel visibility changes (DOM ids change
    // with content; rendered headings only exist in read view).
  }, [open, viewMode, headings]);

  // Keep the active item visible within the outline's own scroll area.
  useEffect(() => {
    if (!activeSlug || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-slug="${CSS.escape(activeSlug)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeSlug]);

  const handleClick = (h: HeadingItem) => {
    if (viewMode === "read") {
      scrollToSlug(h.slug);
      return;
    }
    // In edit/source the rendered anchors don't exist. Switch to read view,
    // then jump once React has rendered the headings (and rehype-slug has
    // written the ids). A double rAF lets the new view paint first.
    useDocumentStore.getState().setViewMode("read");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToSlug(h.slug));
    });
  };

  return (
    <aside
      className={`outline-panel${open ? " outline-panel--open" : ""}`}
      aria-label="Document outline"
      // When the dock is slid off-screen it stays in the DOM; `inert` removes it
      // from the tab order + accessibility tree so closed-panel buttons can't be
      // focused or announced.
      inert={!open}
    >
      <div className="outline-panel__header">
        <div className="outline-panel__title">Outline</div>
        <button
          className="outline-panel__close"
          type="button"
          onClick={closeOutline}
          title={`Close Outline (${formatShortcut("mod+shift+o")})`}
          aria-label="Close Outline"
        >
          <CloseIcon />
        </button>
      </div>

      {!path || headings.length === 0 ? (
        <div className="outline-empty">
          <div className="outline-empty__icon">≡</div>
          <p className="outline-empty__title">No headings</p>
          <p className="outline-empty__body">
            {path
              ? "No headings in this document."
              : "Open a document to see its outline."}
          </p>
        </div>
      ) : (
        <ul className="outline-list" ref={listRef}>
          {headings.map((h) => {
            const isActive = h.slug === activeSlug;
            return (
              <li key={h.slug}>
                <button
                  type="button"
                  className={`outline-item${isActive ? " outline-item--active" : ""}`}
                  data-depth={h.depth}
                  data-slug={h.slug}
                  style={
                    {
                      "--outline-indent": `${(h.depth - 1) * INDENT_STEP}px`,
                    } as React.CSSProperties
                  }
                  onClick={() => handleClick(h)}
                  title={h.text}
                  aria-current={isActive ? "location" : undefined}
                >
                  <span className="outline-item__text">{h.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
