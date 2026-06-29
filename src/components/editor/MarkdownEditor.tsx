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
import { reorderImageInMarkdown } from "../../lib/milkdownImageDragDrop";
import {
  clipboardHasImage,
  handleImagePasteWithSettings,
} from "../../lib/pasteImage";
import {
  applyTableEdit,
  isInsideTable,
  type ColAlignment,
} from "../../lib/tableEditor";
import {
  buildLinkMarkdown,
  buildTableMarkdown,
  continueList,
  detectListContext,
  isUrl,
} from "../../lib/editorShortcuts";
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

// ── Table wizard types ──────────────────────────────────────────────────────────

interface TableWizardState {
  /** Viewport position for the modal. */
  top: number;
  left: number;
  /** Number of data rows requested in the wizard UI. */
  rows: number;
  /** Number of columns requested in the wizard UI. */
  cols: number;
  /** ProseMirror offset where the table should be inserted. */
  cursorOffset: number;
}

// ── Smart link suggestion types ─────────────────────────────────────────────

interface LinkSuggestion {
  /** The normalised URL being suggested. */
  url: string;
  /** The title fetched from the page (or null while loading). */
  title: string | null;
  /** Whether the fetch is still in progress. */
  loading: boolean;
  /** Viewport position for the suggestion pill. */
  top: number;
  left: number;
}

// ── Table UI types ─────────────────────────────────────────────────────────────

interface TableMenuAnchor {
  top: number;
  left: number;
  /** Approximate cursor offset in the body Markdown string at menu-open time. */
  cursorOffset: number;
  /** 0-based data-row index near the cursor (best-effort from DOM heuristic). */
  rowIndex: number;
  /** 0-based column index near the cursor (best-effort from DOM heuristic). */
  colIndex: number;
}

interface TableToolbarAnchor {
  top: number;
  left: number;
  /** Column index the toolbar acts on for alignment. */
  colIndex: number;
  /** Cursor offset for mutation dispatch. */
  cursorOffset: number;
}

// ── CrepeInner ─────────────────────────────────────────────────────────────────

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

  // Table context-menu + toolbar state.
  const [tableMenu, setTableMenu] = useState<TableMenuAnchor | null>(null);
  const [tableToolbar, setTableToolbar] = useState<TableToolbarAnchor | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  // Table wizard state (⌘⇧T when cursor is NOT inside an existing table).
  const [tableWizard, setTableWizard] = useState<TableWizardState | null>(null);

  // Smart link suggestion state (shown after a URL paste).
  const [linkSuggestion, setLinkSuggestion] = useState<LinkSuggestion | null>(null);

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

  // ── Table helpers ────────────────────────────────────────────────────────

  /**
   * Return the approximate character offset in the body Markdown for the
   * current ProseMirror cursor position. We use the raw Markdown string kept
   * in lastBodyRef because Crepe does not expose a direct pos→source map.
   * Heuristic: treat the ProseMirror text offset as a char offset into the
   * body (works well for plain prose; good enough for table cell detection).
   */
  const getBodyCursorOffset = useCallback((): number => {
    const view = proseRef.current;
    if (!view) return 0;
    return view.state.selection.from;
  }, []);

  /**
   * Extract a best-effort [rowIndex, colIndex] from a table cell DOM element.
   * Walks up the DOM from `target` looking for <tr>/<td>/<th> elements.
   */
  function cellIndicesFromTarget(target: Element | null): { row: number; col: number } {
    let el: Element | null = target;
    while (el) {
      if (el.tagName === "TD" || el.tagName === "TH") {
        const cell = el as HTMLTableCellElement;
        const row = cell.closest("tr");
        const table = cell.closest("table");
        if (row && table) {
          const rows = Array.from(table.querySelectorAll("tr"));
          // Skip header row (index 0 is <thead> tr) → data row index
          const rawRowIdx = rows.indexOf(row);
          // rawRowIdx 0 = header, 1 = separator (hidden in Crepe), 2+ = data
          // Crepe renders thead (row 0) and tbody rows (1..n); no sep row in DOM.
          const rowIndex = Math.max(0, rawRowIdx - 1);
          const cells = Array.from(row.querySelectorAll("td, th"));
          const colIndex = cells.indexOf(cell);
          return { row: rowIndex, col: colIndex };
        }
      }
      el = el.parentElement;
    }
    return { row: 0, col: 0 };
  }

  /**
   * Apply a table edit to the current document body and push to document store.
   */
  const dispatchTableEdit = useCallback(
    (cursorOffset: number, edit: Parameters<typeof applyTableEdit>[2]) => {
      const body = lastBodyRef.current;
      const newBody = applyTableEdit(body, cursorOffset, edit);
      if (newBody === body) return;
      lastBodyRef.current = newBody;
      setContentRef.current(joinFrontmatter(fmRef.current, newBody));
    },
    [],
  );

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

  // ── Table context-menu trigger ───────────────────────────────────────────

  useEffect(() => {
    if (loading) return;
    const view = proseRef.current;
    if (!view) return;

    const onContextMenu = (e: MouseEvent) => {
      // Only show table menu when cursor is inside a table cell.
      const body = lastBodyRef.current;
      const offset = getBodyCursorOffset();
      if (!isInsideTable(body, offset)) return;

      e.preventDefault();
      const target = e.target as Element | null;
      const { row, col } = cellIndicesFromTarget(target);
      setTableMenu({
        top: e.clientY,
        left: e.clientX,
        cursorOffset: offset,
        rowIndex: row,
        colIndex: col,
      });
      setTableToolbar(null);
    };

    // Cmd+Shift+T (or Ctrl+Shift+T): opens the table context-menu when the
    // cursor is inside an existing table, or opens the table wizard when not.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!view.hasFocus()) return;

      // ── List continuation (Enter at end of a list item) ────────────────────
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const sel = view.state.selection;
        if (sel.from === sel.to) {
          // Resolve the current line by walking back to the nearest \n.
          const doc = view.state.doc;
          const pos = sel.from;
          // Get the resolved position info to find the line.
          const resolvedPos = doc.resolve(pos);
          const lineStart = resolvedPos.start();
          const lineText = doc.textBetween(lineStart, pos, "\n");
          const listCtx = detectListContext(lineText);
          if (listCtx) {
            e.preventDefault();
            const continuation = continueList(listCtx);
            if (continuation === "") {
              // Empty item — replace the list marker with a blank line.
              const lineEnd = resolvedPos.end();
              view.dispatch(
                view.state.tr.replaceWith(
                  lineStart - 1, // include the preceding newline
                  lineEnd,
                  view.state.schema.text("\n"),
                ),
              );
            } else {
              view.dispatch(view.state.tr.insertText(continuation, pos, pos));
            }
            return;
          }
        }
      }

      // ── Table wizard / table menu (⌘⇧T) ────────────────────────────────────
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "t" || e.key === "T")) {
        const body = lastBodyRef.current;
        const offset = getBodyCursorOffset();
        e.preventDefault();
        const coords = view.coordsAtPos(view.state.selection.from);
        if (isInsideTable(body, offset)) {
          // Inside an existing table → open the table context-menu.
          setTableMenu({
            top: coords.top,
            left: coords.left,
            cursorOffset: offset,
            rowIndex: 0,
            colIndex: 0,
          });
          setTableToolbar(null);
        } else {
          // Not in a table → open the wizard to insert a new table.
          setTableWizard({
            top: coords.top,
            left: Math.max(8, coords.left),
            rows: 3,
            cols: 3,
            cursorOffset: offset,
          });
        }
      }
    };

    // Double-click on a table cell opens the cell toolbar.
    const onDblClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const cell = target.closest("td, th");
      if (!cell) return;
      const body = lastBodyRef.current;
      const offset = getBodyCursorOffset();
      if (!isInsideTable(body, offset)) return;
      const { col } = cellIndicesFromTarget(target);
      const rect = cell.getBoundingClientRect();
      const TOOLBAR_H = 38;
      setTableToolbar({
        top: rect.top - TOOLBAR_H - 6,
        left: rect.left,
        colIndex: col,
        cursorOffset: offset,
      });
      setTableMenu(null);
    };

    // Click elsewhere dismisses both menus, wizard, and link suggestion.
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (
        target?.closest(".table-context-menu") ||
        target?.closest(".table-cell-toolbar") ||
        target?.closest(".table-wizard-modal") ||
        target?.closest(".link-suggestion-pill")
      ) return;
      setTableMenu(null);
      setTableToolbar(null);
      setTableWizard(null);
      setLinkSuggestion(null);
    };

    view.dom.addEventListener("contextmenu", onContextMenu as EventListener);
    document.addEventListener("keydown", onKeyDown, true);
    view.dom.addEventListener("dblclick", onDblClick as EventListener);
    document.addEventListener("click", onDocClick, true);

    return () => {
      view.dom.removeEventListener("contextmenu", onContextMenu as EventListener);
      document.removeEventListener("keydown", onKeyDown, true);
      view.dom.removeEventListener("dblclick", onDblClick as EventListener);
      document.removeEventListener("click", onDocClick, true);
    };
  }, [loading, getBodyCursorOffset]);

  // ── End table helpers ────────────────────────────────────────────────────

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
      // ── Image paste ──────────────────────────────────────────────────────
      if (clipboardHasImage(event.clipboardData)) {
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
        return;
      }

      // ── Smart URL paste ──────────────────────────────────────────────────
      // When the pasted text looks like a plain URL, insert it as-is first,
      // then asynchronously fetch the page title and surface a suggestion pill
      // so the user can convert it to a proper Markdown link.
      const pastedText = event.clipboardData?.getData("text/plain") ?? "";
      if (isUrl(pastedText)) {
        // Let the default paste go through so the raw URL appears in the doc.
        // We'll offer to convert it afterwards.
        const { from, to } = view.state.selection;
        const coords = view.coordsAtPos(from);
        setLinkSuggestion({
          url: pastedText.trim(),
          title: null,
          loading: true,
          top: coords.top - 44,
          left: Math.max(8, coords.left),
        });
        // Fetch the title in the background; update the suggestion when done.
        void buildLinkMarkdown(pastedText).then((mdLink) => {
          setLinkSuggestion((prev) => {
            if (!prev) return null;
            // Extract title from [title](url) format produced by buildLinkMarkdown.
            const titleMatch = /^\[(.+?)\]/.exec(mdLink);
            const resolvedTitle = titleMatch ? titleMatch[1] : null;
            return {
              ...prev,
              title: resolvedTitle !== "Link" ? resolvedTitle : null,
              loading: false,
              // Store cursor range so we can replace the raw URL on accept.
              cursorOffset: from,
              pasteLength: to - from + pastedText.trim().length,
            } as LinkSuggestion & { cursorOffset: number; pasteLength: number };
          });
        });
        // Store cursor position for accept/dismiss to be able to replace text.
        (view as ProseView & { _urlPasteFrom?: number; _urlPasteText?: string })._urlPasteFrom = from;
        (view as ProseView & { _urlPasteFrom?: number; _urlPasteText?: string })._urlPasteText = pastedText.trim();
      }
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

      {/* ── Table context menu ─────────────────────────────────────────── */}
      {tableMenu && (
        <div
          className="table-context-menu"
          style={{ top: tableMenu.top, left: tableMenu.left }}
          onMouseDown={(e) => e.preventDefault()}
          role="menu"
          aria-label="Table actions"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              dispatchTableEdit(tableMenu.cursorOffset, {
                kind: "insertRow",
                atIndex: tableMenu.rowIndex,
                below: false,
              });
              setTableMenu(null);
            }}
          >
            Insert row above
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              dispatchTableEdit(tableMenu.cursorOffset, {
                kind: "insertRow",
                atIndex: tableMenu.rowIndex,
                below: true,
              });
              setTableMenu(null);
            }}
          >
            Insert row below
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              dispatchTableEdit(tableMenu.cursorOffset, {
                kind: "insertCol",
                atIndex: tableMenu.colIndex,
                right: false,
              });
              setTableMenu(null);
            }}
          >
            Insert col left
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              dispatchTableEdit(tableMenu.cursorOffset, {
                kind: "insertCol",
                atIndex: tableMenu.colIndex,
                right: true,
              });
              setTableMenu(null);
            }}
          >
            Insert col right
          </button>
          <div className="table-context-menu-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              dispatchTableEdit(tableMenu.cursorOffset, {
                kind: "deleteRow",
                atIndex: tableMenu.rowIndex,
              });
              setTableMenu(null);
            }}
          >
            Delete row
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              dispatchTableEdit(tableMenu.cursorOffset, {
                kind: "deleteCol",
                atIndex: tableMenu.colIndex,
              });
              setTableMenu(null);
            }}
          >
            Delete col
          </button>
          <div className="table-context-menu-divider" role="separator" />
          {(["left", "center", "right"] as ColAlignment[]).map((align) => (
            <button
              key={align}
              type="button"
              role="menuitem"
              onClick={() => {
                dispatchTableEdit(tableMenu.cursorOffset, {
                  kind: "setAlignment",
                  colIndex: tableMenu.colIndex,
                  alignment: align,
                });
                setTableMenu(null);
              }}
            >
              Align {align}
            </button>
          ))}
        </div>
      )}

      {/* ── Cell formatting toolbar ────────────────────────────────────── */}
      {tableToolbar && (
        <div
          className="table-cell-toolbar"
          style={{ top: tableToolbar.top, left: tableToolbar.left }}
          onMouseDown={(e) => e.preventDefault()}
          role="toolbar"
          aria-label="Cell formatting"
        >
          {/* Bold / Italic / Code — dispatch ProseMirror marks via keyboard */}
          <button
            type="button"
            title="Bold (⌘B)"
            aria-label="Bold"
            className="table-cell-toolbar-btn"
            onClick={() => {
              proseRef.current?.dom.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: "b",
                  metaKey: true,
                  bubbles: true,
                }),
              );
            }}
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            title="Italic (⌘I)"
            aria-label="Italic"
            className="table-cell-toolbar-btn"
            onClick={() => {
              proseRef.current?.dom.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: "i",
                  metaKey: true,
                  bubbles: true,
                }),
              );
            }}
          >
            <em>I</em>
          </button>
          <button
            type="button"
            title="Inline code"
            aria-label="Inline code"
            className="table-cell-toolbar-btn table-cell-toolbar-mono"
            onClick={() => {
              const view = proseRef.current;
              if (!view) return;
              const { from, to } = view.state.selection;
              const text = view.state.doc.textBetween(from, to, "");
              if (text) {
                view.dispatch(
                  view.state.tr.insertText(`\`${text}\``, from, to),
                );
              }
            }}
          >
            {"</>"}
          </button>
          <div className="table-cell-toolbar-divider" aria-hidden="true" />
          {/* Alignment buttons */}
          {(["left", "center", "right"] as ColAlignment[]).map((align) => (
            <button
              key={align}
              type="button"
              title={`Align ${align}`}
              aria-label={`Align column ${align}`}
              className="table-cell-toolbar-btn"
              onClick={() => {
                dispatchTableEdit(tableToolbar.cursorOffset, {
                  kind: "setAlignment",
                  colIndex: tableToolbar.colIndex,
                  alignment: align,
                });
              }}
            >
              {align === "left" ? "⇤" : align === "center" ? "↔" : "⇥"}
            </button>
          ))}
        </div>
      )}

      {/* ── Table wizard modal ────────────────────────────────────────── */}
      {tableWizard && (
        <div
          className="table-wizard-modal"
          style={{ top: tableWizard.top, left: tableWizard.left }}
          onMouseDown={(e) => e.preventDefault()}
          role="dialog"
          aria-label="Insert table"
          aria-modal="true"
        >
          <div className="table-wizard-title">Insert table</div>
          <div className="table-wizard-fields">
            <label className="table-wizard-label">
              Rows
              <input
                className="table-wizard-input"
                type="number"
                min={1}
                max={50}
                value={tableWizard.rows}
                onChange={(e) =>
                  setTableWizard((w) =>
                    w ? { ...w, rows: Math.max(1, Number(e.target.value) || 1) } : null,
                  )
                }
              />
            </label>
            <label className="table-wizard-label">
              Cols
              <input
                className="table-wizard-input"
                type="number"
                min={1}
                max={20}
                value={tableWizard.cols}
                onChange={(e) =>
                  setTableWizard((w) =>
                    w ? { ...w, cols: Math.max(1, Number(e.target.value) || 1) } : null,
                  )
                }
              />
            </label>
          </div>
          <div className="table-wizard-actions">
            <button
              type="button"
              className="table-wizard-btn table-wizard-btn-primary"
              onClick={() => {
                const view = proseRef.current;
                if (!view || !tableWizard) return;
                const tableMd = buildTableMarkdown(tableWizard.rows, tableWizard.cols);
                const { from, to } = view.state.selection;
                // Insert on its own line — prepend/append newlines as needed.
                const docText = view.state.doc.textContent;
                const charBefore = docText[from - 1];
                const prefix = charBefore && charBefore !== "\n" ? "\n\n" : "\n";
                const insert = `${prefix}${tableMd}\n\n`;
                view.dispatch(view.state.tr.insertText(insert, from, to));
                setTableWizard(null);
              }}
            >
              Insert
            </button>
            <button
              type="button"
              className="table-wizard-btn"
              onClick={() => setTableWizard(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Smart link suggestion pill ─────────────────────────────────── */}
      {linkSuggestion && (
        <div
          className="link-suggestion-pill"
          style={{ top: linkSuggestion.top, left: linkSuggestion.left }}
          onMouseDown={(e) => e.preventDefault()}
          role="status"
          aria-live="polite"
        >
          {linkSuggestion.loading ? (
            <span className="link-suggestion-label">Fetching title…</span>
          ) : (
            <>
              <span className="link-suggestion-label">
                {linkSuggestion.title
                  ? `Convert to: [${linkSuggestion.title}](…)`
                  : "Convert to: [Link](…)"}
              </span>
              <button
                type="button"
                className="link-suggestion-accept"
                title="Accept (converts raw URL to Markdown link)"
                onClick={() => {
                  const view = proseRef.current;
                  if (!view || !linkSuggestion) return;
                  const v = view as ProseView & {
                    _urlPasteFrom?: number;
                    _urlPasteText?: string;
                  };
                  const pasteFrom = v._urlPasteFrom;
                  const rawUrl = v._urlPasteText ?? linkSuggestion.url;
                  if (pasteFrom === undefined) {
                    setLinkSuggestion(null);
                    return;
                  }
                  const pasteTo = pasteFrom + rawUrl.length;
                  const label = linkSuggestion.title ?? "Link";
                  // normalise to https:// if www.
                  const norm = /^https?:\/\//i.test(rawUrl)
                    ? rawUrl
                    : `https://${rawUrl}`;
                  const mdLink = `[${label}](${norm})`;
                  view.dispatch(view.state.tr.insertText(mdLink, pasteFrom, pasteTo));
                  setLinkSuggestion(null);
                }}
              >
                ✓ Accept
              </button>
            </>
          )}
          <button
            type="button"
            className="link-suggestion-dismiss"
            title="Dismiss"
            aria-label="Dismiss link suggestion"
            onClick={() => setLinkSuggestion(null)}
          >
            ✕
          </button>
        </div>
      )}

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
