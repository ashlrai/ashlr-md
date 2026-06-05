import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionId } from "../../ai/actions";
import { NoProviderError, runInlineTransform } from "../../ai/inline";
import { setSourceView } from "../../lib/sourceSearchBridge";
import { useDocumentStore } from "../../store/documentStore";
import { useSettingsStore } from "../../store/settingsStore";
import "../../styles/editor.css";

/**
 * Raw Markdown source editor (CodeMirror 6). Edits the FULL document content
 * losslessly — the escape hatch for footnotes, raw HTML, and anything the
 * WYSIWYG editor would normalize away.
 *
 * Inline AI: with a non-empty selection, a floating action menu offers
 * Rewrite / Fix grammar / Make concise / Expand, and `mod+I` runs Rewrite
 * directly. The selected range is replaced in place, streaming as deltas
 * arrive. Esc cancels (aborting the stream); on error the original text is
 * restored and a small inline message is shown.
 */

/** Actions surfaced in the inline source-editor menu, in display order. */
const INLINE_ACTIONS: { id: ActionId; label: string; icon: string }[] = [
  { id: "rewrite", label: "Rewrite", icon: "✨" },
  { id: "fix-grammar", label: "Fix grammar", icon: "✓" },
  { id: "concise", label: "Make concise", icon: "✂️" },
  { id: "expand", label: "Expand", icon: "➕" },
];

/** A selection range plus the viewport anchor where the menu/pill renders. */
interface InlineAnchor {
  from: number;
  to: number;
  /** viewport-relative coords for fixed positioning */
  top: number;
  left: number;
}

type InlinePhase =
  | { kind: "menu" }
  | { kind: "running"; label: string }
  | { kind: "error"; message: string };

export function SourceEditor({ initialContent }: { initialContent: string }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const initialRef = useRef(initialContent);
  const theme = useSettingsStore((s) => s.theme);

  const setContent = useDocumentStore((s) => s.setContent);
  const setContentRef = useRef(setContent);
  setContentRef.current = setContent;

  // Inline-AI overlay state (menu / running pill / error), anchored to a range.
  const [anchor, setAnchor] = useState<InlineAnchor | null>(null);
  const [phase, setPhase] = useState<InlinePhase>({ kind: "menu" });
  const abortRef = useRef<AbortController | null>(null);
  // While a transform writes to the doc we suppress menu re-show from the
  // resulting selection churn.
  const runningRef = useRef(false);

  // Compute the viewport anchor for the current selection, or null if empty.
  const anchorForSelection = useCallback((view: EditorView): InlineAnchor | null => {
    const { from, to } = view.state.selection.main;
    if (from === to) return null;
    const start = view.coordsAtPos(from);
    if (!start) return null;
    const MENU_H = 34;
    const MARGIN = 6;
    let top = start.top - MENU_H - MARGIN;
    if (top < 8) {
      const end = view.coordsAtPos(to);
      top = (end ?? start).bottom + MARGIN;
    }
    return { from, to, top, left: Math.max(8, start.left) };
  }, []);

  // Run an inline transform over the current selection, replacing it in place
  // and streaming the result as it arrives.
  const runTransform = useCallback(async (actionId: ActionId, label: string) => {
    const view = viewRef.current;
    if (!view || runningRef.current) return;

    const sel = view.state.selection.main;
    if (sel.from === sel.to) return;
    const original = view.state.sliceDoc(sel.from, sel.to);
    if (!original.trim()) return;

    const controller = new AbortController();
    abortRef.current = controller;
    runningRef.current = true;
    setPhase({ kind: "running", label });

    // The span currently occupied by AI output. Starts as the selection;
    // grows as deltas stream in. We always replace [start, end) so streaming
    // stays one coherent, single-undo edit region.
    const start = sel.from;
    let end = sel.to;
    let acc = "";

    const applyOutput = (next: string) => {
      acc = next;
      view.dispatch({
        changes: { from: start, to: end, insert: acc },
        // Keep the growing output selected so the anchor tracks it.
        selection: { anchor: start, head: start + acc.length },
      });
      end = start + acc.length;
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
      setContentRef.current(view.state.doc.toString());
      setAnchor(null);
      setPhase({ kind: "menu" });
    } catch (e) {
      // Restore the original text on any failure or cancel so nothing is lost.
      try {
        view.dispatch({
          changes: { from: start, to: start + acc.length, insert: original },
          selection: { anchor: start, head: start + original.length },
        });
        setContentRef.current(view.state.doc.toString());
      } catch {
        // View may be gone (unmount) — nothing to restore.
      }

      const aborted = e instanceof DOMException && e.name === "AbortError";
      if (aborted) {
        setAnchor(null);
        setPhase({ kind: "menu" });
      } else if (e instanceof NoProviderError) {
        setPhase({
          kind: "error",
          message: "No AI provider — set one up in the AI sidebar.",
        });
      } else {
        const m = e instanceof Error ? e.message : String(e);
        setPhase({ kind: "error", message: m });
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
    }
  }, []);

  const runTransformRef = useRef(runTransform);
  runTransformRef.current = runTransform;
  const anchorForSelectionRef = useRef(anchorForSelection);
  anchorForSelectionRef.current = anchorForSelection;

  // Create the editor once (per mount; Shell keys mounts by path + nonce).
  useEffect(() => {
    if (!parentRef.current) return;
    const view = new EditorView({
      parent: parentRef.current,
      state: EditorState.create({
        doc: initialRef.current,
        extensions: [
          lineNumbers(),
          history(),
          // Inline-AI keymap runs BEFORE the defaults so mod+I isn't swallowed.
          keymap.of([
            {
              key: "Mod-i",
              preventDefault: true,
              run: (v) => {
                if (v.state.selection.main.empty) return false;
                void runTransformRef.current("rewrite", "Rewriting");
                return true;
              },
            },
            {
              key: "Escape",
              run: () => {
                if (abortRef.current) {
                  abortRef.current.abort();
                  return true;
                }
                return false;
              },
            },
          ]),
          // Native find/replace panel (Mod-f, Mod-Alt-f) anchored at the top.
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of(searchKeymap),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setContentRef.current(u.state.doc.toString());
            // Reflect selection changes in the inline menu, unless a transform
            // is mid-flight (its edits would otherwise re-trigger the menu).
            if (u.selectionSet || u.docChanged || u.geometryChanged) {
              if (runningRef.current) return;
              setAnchor(anchorForSelectionRef.current(u.view));
              setPhase({ kind: "menu" });
            }
          }),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": {
              fontFamily: "var(--mono-font)",
              fontSize: "13.5px",
              lineHeight: "1.65",
            },
            ".cm-content": { padding: "16px 0" },
            "&.cm-focused": { outline: "none" },
            // Match the search panel to the app chrome across themes.
            ".cm-panels": {
              background: "var(--surface)",
              color: "var(--text)",
              borderBottom: "1px solid var(--border)",
            },
            ".cm-panel.cm-search input, .cm-panel.cm-search button": {
              fontSize: "12px",
            },
            ".cm-textfield": {
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border)",
            },
          }),
          themeCompartment.current.of([]),
        ],
      }),
    });
    viewRef.current = view;
    setSourceView(view); // expose to the find/replace commands
    view.focus();
    return () => {
      abortRef.current?.abort();
      setSourceView(null);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Swap the syntax theme without rebuilding the editor (keeps cursor/history).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(
        theme === "midnight" ? oneDark : [],
      ),
    });
  }, [theme]);

  return (
    <div className="source-editor" ref={parentRef}>
      {anchor && (
        <div
          className="inline-ai"
          style={{ top: anchor.top, left: anchor.left }}
          // Keep the editor selection alive when interacting with the menu.
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
              <button
                type="button"
                className="inline-ai-cancel"
                title="Cancel (Esc)"
                onClick={() => abortRef.current?.abort()}
              >
                Esc
              </button>
            </div>
          )}
          {phase.kind === "error" && (
            <div className="inline-ai-error" role="alert">
              {phase.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
