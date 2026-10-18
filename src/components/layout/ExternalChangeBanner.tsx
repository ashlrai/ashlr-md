import { useState } from "react";
import { getAction } from "../../ai/actions";
import { describeAIError, NO_PROVIDER_EXPLAIN_MESSAGE } from "../../ai/errors";
import {
  detectProvider,
  NOOP_PROVIDER_ID,
  runSelectionAction,
} from "../../ai/registry";
import { useAIStore } from "../../store/aiStore";
import { useDocumentStore } from "../../store/documentStore";

/** Shown when the open file changed on disk while we hold unsaved edits. */
export function ExternalChangeBanner() {
  const accept = useDocumentStore((s) => s.acceptExternalChange);
  const dismiss = useDocumentStore((s) => s.dismissExternalChange);
  const content = useDocumentStore((s) => s.content);
  const pendingDisk = useDocumentStore((s) => s.pendingDisk);

  const openAI = useAIStore((s) => s.open_);
  const pushMessage = useAIStore((s) => s.pushMessage);
  const updateLast = useAIStore((s) => s.updateLastAssistantMessage);
  const finalizeLast = useAIStore((s) => s.finalizeLastAssistantMessage);
  const setBusy = useAIStore((s) => s.setBusy);
  const setProvider = useAIStore((s) => s.setProvider);
  const clearProvider = useAIStore((s) => s.clearProvider);

  const [explaining, setExplaining] = useState(false);

  // Ask the AI to explain how the on-disk version differs from the user's
  // current edits, streaming the answer into the AI sidebar.
  async function explainChanges() {
    if (explaining || pendingDisk == null) return;
    setExplaining(true);

    // Surface in the sidebar even before we know if a provider exists, so the
    // user has somewhere to look; we degrade gracefully below.
    openAI();

    let provider = null;
    let detectDetail = "";
    try {
      provider = await detectProvider();
    } catch (e) {
      detectDetail = describeAIError(e).detail;
    }

    // No provider: record it as a failed turn, which the sidebar's setup
    // panel shows on top of its options. It used to be plain chat text,
    // which that panel hides, so the user saw the panel and no reason.
    // Recording the provider state switches a sidebar that still showed the
    // chat to the panel.
    if (!provider || provider.id === NOOP_PROVIDER_ID) {
      if (provider) setProvider(provider.id, provider.capabilities);
      else clearProvider();
      pushMessage({
        role: "user",
        content: "Explain how the file changed on disk vs. my current edits.",
      });
      pushMessage({
        role: "assistant",
        content: "",
        error: { message: NO_PROVIDER_EXPLAIN_MESSAGE, detail: detectDetail },
      });
      setExplaining(false);
      return;
    }

    const action = getAction("explain-diff");
    const messages = action.buildMessages(content, pendingDisk);

    pushMessage({
      role: "user",
      content: "Explain how the file changed on disk vs. my current edits.",
    });
    pushMessage({ role: "assistant", content: "", streaming: true });
    setBusy(true);

    try {
      await runSelectionAction(provider, messages, (delta) => updateLast(delta));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (m !== "Aborted") updateLast(`\n\n*Error: ${m}*`);
    } finally {
      finalizeLast();
      setBusy(false);
      setExplaining(false);
    }
  }

  return (
    <div className="change-banner">
      <span className="change-banner-text">
        This file changed on disk and you have unsaved edits.
      </span>
      <div className="change-banner-actions">
        <button
          type="button"
          className="banner-btn"
          disabled={explaining || pendingDisk == null}
          onClick={() => void explainChanges()}
        >
          {explaining ? "Explaining…" : "Explain changes"}
        </button>
        <button type="button" className="banner-btn" onClick={() => dismiss()}>
          Keep mine
        </button>
        <button
          type="button"
          className="banner-btn banner-btn-primary"
          onClick={() => accept()}
        >
          Reload from disk
        </button>
      </div>
    </div>
  );
}
