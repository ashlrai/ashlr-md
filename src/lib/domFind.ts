/**
 * domFind.ts — find-in-page for the rendered read view.
 *
 * Highlights case-insensitive matches inside `.markdown-body` by wrapping them
 * in `<mark class="find-hit">`, skipping code block/math/diagram regions, and exposes
 * helpers to navigate and clear. Pure DOM — no React, no editor model.
 */

import { smoothScrollBehavior } from "./motion";

const HIT = "find-hit";
const ACTIVE = "find-hit--active";
// Only find's own marks are skipped: a `==highlight==` renders as a
// `<mark class="highlight">`, and skipping every `mark` left its words
// unfound. Inline `code` is searched (an identifier is often written so);
// only code blocks (`pre`, whose highlighted spans are rebuilt) are skipped.
const SKIP_SELECTOR = `pre, .katex, .katex-display, .mermaid-block, mark.${HIT}`;

function container(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".app-content .markdown-body");
}

/**
 * Each text node {@link highlight} split, and the nodes put in its place.
 * The text nodes are React's: clearing puts these very nodes back, so React
 * can still update or remove them. Clearing used to put new text nodes in
 * their place, so a later change to that text (an agent's edit, a reload)
 * went to a node no longer in the page and the read view kept the old text,
 * or React threw removing it.
 */
let split: { text: Text; pieces: Node[] }[] = [];

/** Remove all highlight marks, restoring the original text nodes. */
export function clearHighlights(): void {
  for (const { text, pieces } of split) {
    const first = pieces[0];
    const parent = first?.parentNode;
    if (!parent) continue;
    parent.insertBefore(text, first);
    for (const piece of pieces) piece.parentNode?.removeChild(piece);
  }
  split = [];
  const root = container();
  if (!root) return;
  // Any mark left (its text node was not one this module split) is undone
  // as text.
  const parents = new Set<Node>();
  for (const mark of Array.from(root.querySelectorAll(`mark.${HIT}`))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parents.add(parent);
  }
  // Coalesce adjacent text nodes once per parent (not per mark — avoids O(n²)).
  for (const parent of parents) (parent as Element).normalize();
}

/** Highlight every occurrence of `query`; returns the match count. */
export function highlight(query: string): number {
  clearHighlights();
  const root = container();
  if (!root || !query) return 0;
  // Matched in the text itself, ignoring case: the hits were found in the
  // lowercased text and marked at those offsets in the original, and
  // lowercasing `İ` gives two characters, so in Turkish text every hit after
  // one was marked off by one (`stan` in `İstanbul` marked `tanb`).
  const source = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = new RegExp(source, "iu");
  const all = new RegExp(source, "giu");

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return has.test(node.nodeValue ?? "")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    targets.push(n as Text);
  }

  let count = 0;
  for (const text of targets) {
    const value = text.nodeValue ?? "";
    const frag = document.createDocumentFragment();
    const pieces: Node[] = [];
    let last = 0;
    for (const m of value.matchAll(all)) {
      const idx = m.index ?? 0;
      if (idx > last) frag.appendChild(document.createTextNode(value.slice(last, idx)));
      const mark = document.createElement("mark");
      mark.className = HIT;
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = idx + m[0].length;
      count++;
    }
    if (last < value.length)
      frag.appendChild(document.createTextNode(value.slice(last)));
    pieces.push(...frag.childNodes);
    if (!text.parentNode) continue;
    split.push({ text, pieces });
    text.parentNode.replaceChild(frag, text);
  }
  return count;
}

/** Mark the match at `index` active and scroll it into view. */
export function setActive(index: number): void {
  const root = container();
  if (!root) return;
  const marks = Array.from(root.querySelectorAll<HTMLElement>(`mark.${HIT}`));
  marks.forEach((m, i) => {
    m.classList.toggle(ACTIVE, i === index);
  });
  marks[index]?.scrollIntoView({ block: "center", behavior: smoothScrollBehavior() });
}
