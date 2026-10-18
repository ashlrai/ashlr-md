// Selection Popover — floating toolbar that appears near text selected inside
// `.markdown-body`.  Clicking an action runs it via the AI sidebar.
//
// Lifecycle:
//   1. Listen for `selectionchange` on the document.
//   2. If the selection is non-empty AND inside `.markdown-body`, show popover
//      anchored above the selection's bounding rect.
//   3. Clicking an action dispatches to the AI store + sidebar, then hides.
//   4. Selection clearing (mousedown elsewhere, Escape) removes the popover.

import { useCallback, useEffect, useRef, useState } from "react";
import { type ActionId, AI_ACTIONS } from "../../ai/actions";
import { describeAIError, NO_PROVIDER_MESSAGE } from "../../ai/errors";
import {
  detectProvider,
  NOOP_PROVIDER_ID,
  runSelectionAction,
} from "../../ai/registry";
import { isDismissEscape } from "../../lib/keymap";
import { useAIStore } from "../../store/aiStore";

interface PopoverPosition {
  top: number;
  left: number;
}

// Actions to show in the popover (subset — keep it tight).
const POPOVER_ACTIONS: ActionId[] = ["explain", "rewrite", "summarize", "translate"];

export function SelectionPopover() {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<PopoverPosition>({ top: 0, left: 0 });
  const [selectedText, setSelectedText] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);

  const open_ = useAIStore((s) => s.open_);
  const providerId = useAIStore((s) => s.providerId);
  const busy = useAIStore((s) => s.busy);
  const pushMessage = useAIStore((s) => s.pushMessage);
  const updateLast = useAIStore((s) => s.updateLastAssistantMessage);
  const finalizeLast = useAIStore((s) => s.finalizeLastAssistantMessage);
  const failLast = useAIStore((s) => s.failLastAssistantMessage);
  const stopLast = useAIStore((s) => s.stopLastAssistantMessage);
  const setBusy = useAIStore((s) => s.setBusy);
  const setAbortController = useAIStore((s) => s.setAbortController);

  /** Returns true if the selection's anchor node is inside `.markdown-body` */
  function isInsideMarkdownBody(sel: Selection): boolean {
    const node = sel.anchorNode;
    if (!node) return false;
    const el =
      node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
    return !!el?.closest(".markdown-body");
  }

  // Recompute popover position and visibility on selection changes.
  const handleSelectionChange = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      setVisible(false);
      return;
    }
    if (!isInsideMarkdownBody(sel)) {
      setVisible(false);
      return;
    }

    const text = sel.toString().trim();
    setSelectedText(text);

    // Use the last range's bounding rect for position.
    const range = sel.getRangeAt(sel.rangeCount - 1);
    const rect = range.getBoundingClientRect();

    // Position the popover above the selection, centred horizontally.
    // We use viewport-relative coords (fixed positioning).
    const POPOVER_H = 38; // approximate height
    const MARGIN = 6;

    let top = rect.top - POPOVER_H - MARGIN;
    // If not enough space above, flip below.
    if (top < 0) top = rect.bottom + MARGIN;

    let left = rect.left + rect.width / 2;
    // Clamp so it doesn't escape viewport; will be adjusted after render.
    left = Math.max(8, left);

    setPos({ top, left });
    setVisible(true);
  }, []);

  // Hide on mousedown outside the popover (but not on the popover itself).
  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (popoverRef.current?.contains(e.target as Node)) return;
    setVisible(false);
  }, []);

  // Hide on Escape, but not on one that ends an IME composition
  // (isDismissEscape).
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (isDismissEscape(e)) setVisible(false);
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleSelectionChange, handleMouseDown, handleKeyDown]);

  // Clamp horizontally after the popover renders so we know its width.
  useEffect(() => {
    if (!visible || !popoverRef.current) return;
    const rect = popoverRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    if (rect.right > vw - 8) {
      setPos((p) => ({ ...p, left: p.left - (rect.right - (vw - 8)) }));
    }
  }, [visible, pos.left]);

  async function runAction(id: ActionId) {
    if (!selectedText || busy) return;
    setVisible(false);

    // Ensure sidebar is open so the user can see the response.
    open_();

    const action = AI_ACTIONS.find((a) => a.id === id);
    if (!action) return;

    // Resolve provider (may be cached).
    let provider = null;
    let detectDetail = "";
    try {
      provider = await detectProvider();
    } catch (e) {
      detectDetail = describeAIError(e).detail;
    }

    pushMessage({
      role: "user",
      content: `${action.label}: "${selectedText.slice(0, 80)}${selectedText.length > 80 ? "…" : ""}"`,
    });

    // No provider: say so in the sidebar with the next step, as the editors'
    // inline AI does, instead of stopping without a word.
    if (!provider || provider.id === NOOP_PROVIDER_ID) {
      pushMessage({
        role: "assistant",
        content: "",
        error: { message: NO_PROVIDER_MESSAGE, detail: detectDetail },
      });
      return;
    }

    const msgs = action.buildMessages(selectedText);
    pushMessage({ role: "assistant", content: "", streaming: true });
    setBusy(true);

    // Registered in the store so the sidebar's Stop button aborts it: it
    // used to be held here alone, and Stop did nothing for a popover action.
    const controller = new AbortController();
    setAbortController(controller);

    try {
      await runSelectionAction(
        provider,
        msgs,
        (delta) => updateLast(delta),
        controller.signal,
      );
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const aborted =
        m === "Aborted" || (e instanceof DOMException && e.name === "AbortError");
      if (aborted) stopLast();
      else failLast(describeAIError(e));
    } finally {
      finalizeLast();
      setBusy(false);
      setAbortController(null);
    }
  }

  if (!visible) return null;

  const isNoProvider = !providerId || providerId === NOOP_PROVIDER_ID;

  return (
    <div
      ref={popoverRef}
      className="ai-selection-popover"
      style={{
        top: pos.top,
        // Centre on the computed left — transform moves it left by 50%.
        left: pos.left,
        transform: "translateX(-50%)",
      }}
      role="toolbar"
      aria-label="AI actions for selection"
    >
      {isNoProvider ? (
        <button
          type="button"
          className="ai-popover-btn"
          onClick={() => {
            setVisible(false);
            open_();
          }}
        >
          ✨ Set up AI
        </button>
      ) : (
        POPOVER_ACTIONS.map((id, i) => {
          const action = AI_ACTIONS.find((a) => a.id === id)!;
          return (
            <span key={id} style={{ display: "contents" }}>
              {i > 0 && <span className="ai-popover-divider" aria-hidden="true" />}
              <button
                type="button"
                className="ai-popover-btn"
                disabled={busy}
                onClick={() => runAction(id)}
                title={action.label}
              >
                {action.icon} {action.shortLabel}
              </button>
            </span>
          );
        })
      )}
    </div>
  );
}
