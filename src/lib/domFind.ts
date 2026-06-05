/**
 * domFind.ts — find-in-page for the rendered read view.
 *
 * Highlights case-insensitive matches inside `.markdown-body` by wrapping them
 * in `<mark class="find-hit">`, skipping code/math/diagram regions, and exposes
 * helpers to navigate and clear. Pure DOM — no React, no editor model.
 */

const HIT = "find-hit";
const ACTIVE = "find-hit--active";
const SKIP_SELECTOR = "pre, code, .katex, .katex-display, .mermaid-block, mark";

function container(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".app-content .markdown-body");
}

/** Remove all highlight marks, restoring the original text nodes. */
export function clearHighlights(): void {
  const root = container();
  if (!root) return;
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
  const needle = query.toLowerCase();

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      const value = node.nodeValue;
      return value && value.toLowerCase().includes(needle)
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
    const lower = value.toLowerCase();
    const frag = document.createDocumentFragment();
    let last = 0;
    let idx = lower.indexOf(needle);
    while (idx !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(value.slice(last, idx)));
      const mark = document.createElement("mark");
      mark.className = HIT;
      mark.textContent = value.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      last = idx + needle.length;
      count++;
      idx = lower.indexOf(needle, last);
    }
    if (last < value.length)
      frag.appendChild(document.createTextNode(value.slice(last)));
    text.parentNode?.replaceChild(frag, text);
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
  marks[index]?.scrollIntoView({ block: "center", behavior: "smooth" });
}
