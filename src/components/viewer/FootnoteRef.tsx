/**
 * FootnoteRef.tsx — a GFM footnote reference that previews its definition on
 * hover, so readers don't have to jump to the bottom of the document.
 *
 * The definition lives in the rendered DOM (`<li id="user-content-fn-N">`),
 * already sanitized by the Renderer pipeline, so cloning its HTML into a
 * floating card is safe. The card is portaled to <body> to avoid nesting block
 * content inside the inline <a>.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface FootnoteRefProps {
  href: string;
  children: ReactNode;
  [key: string]: unknown;
}

interface CardState {
  html: string;
  top: number;
  left: number;
}

export function FootnoteRef({ href, children, ...rest }: FootnoteRefProps) {
  const [card, setCard] = useState<CardState | null>(null);
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const def = document.getElementById(href.slice(1));
      if (!def || !anchorRef.current) return;
      // Clone and strip the back-reference arrow(s) before previewing.
      const clone = def.cloneNode(true) as HTMLElement;
      for (const back of clone.querySelectorAll('a[href^="#user-content-fnref"]')) {
        back.remove();
      }
      const rect = anchorRef.current.getBoundingClientRect();
      const left = Math.min(rect.left, window.innerWidth - 360);
      setCard({ html: clone.innerHTML, top: rect.bottom + 6, left: Math.max(8, left) });
    }, 180);
  }, [href]);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setCard(null);
  }, []);

  return (
    <a
      ref={anchorRef}
      href={href}
      className="footnote-ref-link"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      {...rest}
    >
      {children}
      {card &&
        createPortal(
          <span
            className="footnote-hover-card"
            role="tooltip"
            style={{ position: "fixed", top: card.top, left: card.left }}
            // Cloned from the already-sanitized footnote definition in the DOM.
            dangerouslySetInnerHTML={{ __html: card.html }}
          />,
          document.body,
        )}
    </a>
  );
}
