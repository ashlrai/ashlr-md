/**
 * revealLine.ts — show line N of the open document (a search hit's line).
 *
 * In Source view the cursor moves to the line's start and the editor
 * scrolls it into view. In Read view (and a split view's preview) the block
 * that holds the line is scrolled to the top: blocks carry the line they
 * start on (rehype-source-lines), and the last one starting at or before N
 * is taken. The Edit view has no source lines and is left as it is.
 */

import { smoothScrollBehavior } from "./motion";

/** The document's own rendered block holding source line `line`, if any. */
export function blockForLine(line: number, body: ParentNode): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const el of body.querySelectorAll<HTMLElement>("[data-source-line]")) {
    // An embedded note's blocks number its own lines.
    if (el.parentElement?.closest(".wikiembed")) continue;
    const at = Number(el.dataset.sourceLine);
    if (!Number.isFinite(at) || at > line) continue;
    if (!best || at >= Number(best.dataset.sourceLine)) best = el;
  }
  return best;
}

/** Move a CodeMirror editor's cursor to `line` and scroll it into view. */
async function revealInEditor(cm: HTMLElement, line: number): Promise<boolean> {
  // Loaded only here: the editor is a lazy chunk of its own.
  const { EditorView } = await import("@codemirror/view");
  const view = EditorView.findFromDOM(cm);
  if (!view) return false;
  const doc = view.state.doc;
  const pos = doc.line(Math.min(Math.max(1, line), doc.lines)).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  view.focus();
  return true;
}

/**
 * Show `line` (1-based) of the open document once it is rendered (a file
 * opened from a search hit renders after the open resolves). Returns a
 * function that stops waiting.
 */
export function revealLine(line: number): () => void {
  let tries = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const retry = () => {
    if (!stopped && tries++ < 12) timer = setTimeout(tick, 60);
  };
  const tick = () => {
    const content = document.querySelector(".app-content");
    const cm = content?.querySelector<HTMLElement>(".cm-editor");
    if (cm) {
      void revealInEditor(cm, line).then((ok) => {
        if (!ok) retry();
      });
      return;
    }
    // The document's own read view, not a canvas card's renderer.
    const body = content?.querySelector(".reading-surface > .markdown-body");
    const el = body ? blockForLine(line, body) : null;
    if (el) {
      el.scrollIntoView({ behavior: smoothScrollBehavior(), block: "start" });
      return;
    }
    retry();
  };
  // The opened document renders after the open resolves: look once it has.
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
