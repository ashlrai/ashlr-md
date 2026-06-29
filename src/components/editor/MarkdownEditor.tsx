import { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView as ProseView } from "@milkdown/kit/prose/view";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { useCallback, useEffect, useRef, useState } from "react";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import type { ActionId } from "../../ai/actions";
import { NoProviderError, runInlineTransform } from "../../ai/inline";
import { joinFrontmatter, splitFrontmatter } from "../../lib/frontmatter";
import {
  extractImageRefs,
  reorderImageInMarkdown,
} from "../../lib/milkdownImageDragDrop";
import {
  clipboardHasImage,
  handleImagePasteWithSettings,
} from "../../lib/pasteImage";
import { useDocumentStore } from "../../store/documentStore";
import { useSettingsStore } from "../../store/settingsStore";
import "../../styles/editor.css";

/**
 * WYSIWYG Markdown editor (Milkdown Crepe). Frontmatter is split off before
 * editing and re-attached on every change, since Crepe doesn't model it.
 * Mounted fresh per document (keyed by path + reloadNonce in Shell), so the
 * mount-once `useEditor([])` always starts from the latest content.
 *
 * Inline AI: with a non-empty selection, a floating "✨ Rewrite" affordance
 * appears above the selection, and `mod+I` runs Rewrite directly. The selected
 * range is replaced in place with streamed AI output (as plain text, which is
 * the robust path through ProseMirror). Esc cancels; on error the original
 * text is restored and a small inline message is shown.
 */

const INLINE_ACTIONS: { id: ActionId; label: string; icon: string }[] = [
  { id: "rewrite", label: "Rewrite", icon: "✨" },
  { id: "fix-grammar", label: "Fix grammar", icon: "✓" },
  { id: "concise", label: "Make concise", icon: "✂️" },
  { id: "expand", label: "Expand", icon: "➕" },
];

interface InlineAnchor {
  top: number;
  left: number;
}

type InlinePhase =
  | { kind: "menu" }
  | { kind: "running"; label: string; inputTokens: number; outputTokens: number }
  | { kind: "error"; message: string; retryFn: (() => void) | null };

function CrepeInner({ initialContent }: { initialContent: string }) {
  const fmRef = useRef("");
  const lastBodyRef = useRef("");
  const setContent = useDocumentStore((s) => s.setContent);
  const setContentRef = useRef(setContent);
  setContentRef.current = setContent;
  const pasteImageTarget = useSettingsStore((s) => s.pasteImageTarget);

  // The live ProseMirror view, captured once the editor is created.
  const proseRef = useRef<ProseView | null>(null);

  const [anchor, setAnchor] = useState<InlineAnchor | null>(null);
  const [phase, setPhase] = useState<InlinePhase>({ kind: "menu" });
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  // Position the affordance above the current (non-empty) selection.
  const updateAnchor = useCallback(() => {
    if (runningRef.current) return;
    const view = proseRef.current;
    if (!view) return;
    const { from, to } = view.state.selection;
    if (from === to) {
      setAnchor(null);
      return;
    }
    const start = view.coordsAtPos(from);
    const MENU_H = 34;
    const MARGIN = 6;
    let top = start.top - MENU_H - MARGIN;
    if (top < 8) top = view.coordsAtPos(to).bottom + MARGIN;
    setAnchor({ top, left: Math.max(8, start.left) });
    setPhase({ kind: "menu" });
  }, []);

  // Estimate token count using the 1 token ≈ 4 chars heuristic.
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);

  const runTransform = useCallback(
    async (actionId: ActionId, label: string, retryCount = 0) => {
      const view = proseRef.current;
      if (!view || runningRef.current) return;
      const { from, to } = view.state.selection;
      if (from === to) return;
      const original = view.state.doc.textBetween(from, to, "\n");
      if (!original.trim()) return;

      const inputTokens = estimateTokens(original);
      const controller = new AbortController();
      abortRef.current = controller;
      runningRef.current = true;
      setPhase({ kind: "running", label, inputTokens, outputTokens: 0 });

      // We always replace [start, end) with the accumulated output so streaming
      // stays a single coherent region.
      const start = from;
      let end = to;
      let acc = "";

      const applyOutput = (next: string) => {
        acc = next;
        const tr = view.state.tr.insertText(acc, start, end);
        // Keep the new text selected so the caret/anchor track the output.
        view.dispatch(tr);
        end = start + acc.length;
        setPhase({
          kind: "running",
          label,
          inputTokens,
          outputTokens: estimateTokens(acc),
        });
      };

      try {
        let pending = "";
        await runInlineTransform({
          text: original,
          actionId,
          signal: controller.signal,
          onDelta: (delta) => {
            pending += delta;
            applyOutput(pending);
          },
        });
        setAnchor(null);
        setPhase({ kind: "menu" });
      } catch (e) {
        // Restore the original text on any failure or cancel.
        try {
          const tr = view.state.tr.insertText(original, start, start + acc.length);
          view.dispatch(tr);
        } catch {
          // View may be gone.
        }
        const aborted = e instanceof DOMException && e.name === "AbortError";
        if (aborted) {
          setAnchor(null);
          setPhase({ kind: "menu" });
        } else if (e instanceof NoProviderError) {
          setPhase({
            kind: "error",
            message: "No AI provider — set one up in the AI sidebar.",
            retryFn: null,
          });
        } else {
          const m = e instanceof Error ? e.message : String(e);
          const retryFn =
            retryCount < 1
              ? () => {
                  const delay = 500 * 2 ** retryCount;
                  setTimeout(
                    () => void runTransformRef.current(actionId, label, retryCount + 1),
                    delay,
                  );
                }
              : null;
          setPhase({ kind: "error", message: m, retryFn });
        }
      } finally {
        runningRef.current = false;
        abortRef.current = null;
      }
    },
    [],
  );

  const runTransformRef = useRef(runTransform);
  runTransformRef.current = runTransform;
  const updateAnchorRef = useRef(updateAnchor);
  updateAnchorRef.current = updateAnchor;

  const { loading, get } = useEditor((root) => {
    const { frontmatter, body } = splitFrontmatter(initialContent);
    fmRef.current = frontmatter;
    lastBodyRef.current = body;

    const crepe = new Crepe({ root, defaultValue: body });
    crepe.on((api) => {
      api.markdownUpdated((_ctx, markdown) => {
        // Ignore no-op echoes; only propagate real content changes.
        if (markdown === lastBodyRef.current) return;
        lastBodyRef.current = markdown;
        setContentRef.current(joinFrontmatter(fmRef.current, markdown));
      });
    });
    return crepe;
  }, []);

  // Once the editor has finished loading, capture the ProseMirror view so
  // inline AI can read selections and dispatch in-place replacements.
  useEffect(() => {
    if (loading) return;
    const editor = get();
    if (!editor) return;
    try {
      editor.action((ctx) => {
        proseRef.current = ctx.get(editorViewCtx);
      });
    } catch {
      proseRef.current = null;
    }
  }, [loading, get]);

  // Paste an image → save it to the configured location and insert the Markdown
  // reference at the cursor. Bound on the ProseMirror DOM (capture phase) so it
  // runs before Crepe's own paste handling; non-image pastes fall through
  // untouched.
  useEffect(() => {
    if (loading) return;
    const view = proseRef.current;
    if (!view) return;
    const onPaste = (event: ClipboardEvent) => {
      if (!clipboardHasImage(event.clipboardData)) return;
      event.preventDefault();
      event.stopPropagation();
      void handleImagePasteWithSettings(event.clipboardData, pasteImageTarget).then(
        (markdownRef) => {
          if (!markdownRef) return;
          const { from, to } = view.state.selection;
          // insertText routes the raw Markdown through the editor; Crepe's
          // markdownUpdated listener then re-parses it into a rendered image.
          view.dispatch(view.state.tr.insertText(markdownRef, from, to));
        },
      );
    };
    view.dom.addEventListener("paste", onPaste, true);
    return () => view.dom.removeEventListener("paste", onPaste, true);
  }, [loading, pasteImageTarget]);

  // Drag-drop image reordering — when the user drags an embedded image token
  // within the editor and drops it at a new position, we reorder the image
  // references in the raw Markdown source and push the result to documentStore.
  //
  // We annotate every rendered img element with `data-image-index` (the
  // document-order index into the image list) in a MutationObserver callback,
  // then listen for native dragstart / drop events on the editor DOM.
  useEffect(() => {
    if (loading) return;
    const view = proseRef.current;
    if (!view) return;

    /** Stamp every rendered <img> with its document-order index. */
    const stampImages = () => {
      const imgs = view.dom.querySelectorAll<HTMLImageElement>("img");
      imgs.forEach((img, i) => {
        img.setAttribute("data-image-index", String(i));
        img.setAttribute("draggable", "true");
      });
    };
    stampImages();

    // Re-stamp whenever the editor DOM mutates (new images rendered, etc.).
    const observer = new MutationObserver(stampImages);
    observer.observe(view.dom, { childList: true, subtree: true });

    let dragFromIndex = -1;

    const onDragStart = (event: DragEvent) => {
      let el = event.target as Element | null;
      while (el) {
        const idx = el.getAttribute?.("data-image-index");
        if (idx !== null && idx !== undefined) {
          dragFromIndex = Number(idx);
          event.dataTransfer?.setData("text/x-image-index", idx);
          return;
        }
        el = el.parentElement;
      }
    };

    const onDrop = (event: DragEvent) => {
      if (dragFromIndex < 0) return;
      let el = event.target as Element | null;
      let toIndex = -1;
      while (el) {
        const idx = el.getAttribute?.("data-image-index");
        if (idx !== null && idx !== undefined) {
          toIndex = Number(idx);
          break;
        }
        el = el.parentElement;
      }
      if (toIndex >= 0 && toIndex !== dragFromIndex) {
        event.preventDefault();
        event.stopPropagation();
        // Compute the new Markdown source.
        const { frontmatter, body } = splitFrontmatter(
          useDocumentStore.getState().content,
        );
        const newBody = reorderImageInMarkdown(body, dragFromIndex, toIndex);
        if (newBody !== body) {
          setContentRef.current(joinFrontmatter(frontmatter, newBody));
        }
      }
      dragFromIndex = -1;
    };

    const onDragEnd = () => {
      dragFromIndex = -1;
    };

    view.dom.addEventListener("dragstart", onDragStart as EventListener, true);
    view.dom.addEventListener("drop", onDrop as EventListener, true);
    view.dom.addEventListener("dragend", onDragEnd);

    return () => {
      observer.disconnect();
      view.dom.removeEventListener("dragstart", onDragStart as EventListener, true);
      view.dom.removeEventListener("drop", onDrop as EventListener, true);
      view.dom.removeEventListener("dragend", onDragEnd);
    };
  }, [loading]);

  // Track selection changes (mouse + keyboard) to show/hide the affordance,
  // and bind mod+I / Esc at the document level scoped to focus in this editor.
  useEffect(() => {
    const onSelectionChange = () => {
      const view = proseRef.current;
      // Only react when the ProseMirror view holds focus, so we don't fight
      // the source editor or other surfaces.
      if (!view?.hasFocus()) {
        if (!runningRef.current) setAnchor(null);
        return;
      }
      updateAnchorRef.current();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const view = proseRef.current;
      if (!view?.hasFocus()) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
        if (view.state.selection.from !== view.state.selection.to) {
          e.preventDefault();
          void runTransformRef.current("rewrite", "Rewriting");
        }
      } else if (e.key === "Escape" && abortRef.current) {
        e.preventDefault();
        abortRef.current.abort();
      }
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown, true);
      abortRef.current?.abort();
    };
  }, []);

  return (
    <>
      <Milkdown />
      {anchor && (
        <div
          className="inline-ai"
          style={{ top: anchor.top, left: anchor.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {phase.kind === "menu" && (
            <div
              className="inline-ai-menu"
              role="toolbar"
              aria-label="AI actions for selection"
            >
              {INLINE_ACTIONS.map((a, i) => (
                <span key={a.id} style={{ display: "contents" }}>
                  {i > 0 && <span className="inline-ai-divider" aria-hidden="true" />}
                  <button
                    type="button"
                    className="inline-ai-btn"
                    title={a.label}
                    onClick={() => void runTransform(a.id, a.label)}
                  >
                    <span aria-hidden="true">{a.icon}</span> {a.label}
                  </button>
                </span>
              ))}
            </div>
          )}
          {phase.kind === "running" && (
            <div className="inline-ai-pill" aria-live="polite">
              <span className="inline-ai-spark" aria-hidden="true">
                ✨
              </span>
              {phase.label}…
              <span className="inline-ai-tokens" aria-label="token counts">
                {phase.inputTokens}↓→{phase.outputTokens}
              </span>
              <button
                type="button"
                className="inline-ai-cancel"
                title="Cancel (Esc)"
                aria-label="Abort generation"
                onClick={() => abortRef.current?.abort()}
              >
                ✕ <span className="inline-ai-cancel-hint">Esc</span>
              </button>
            </div>
          )}
          {phase.kind === "error" && (
            <div className="inline-ai-error" role="alert">
              <span className="inline-ai-error-msg">{phase.message}</span>
              {phase.retryFn && (
                <button
                  type="button"
                  className="inline-ai-retry"
                  onClick={() => phase.retryFn?.()}
                >
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function MarkdownEditor({ initialContent }: { initialContent: string }) {
  return (
    <div className="wysiwyg-editor">
      <MilkdownProvider>
        <CrepeInner initialContent={initialContent} />
      </MilkdownProvider>
    </div>
  );
}
