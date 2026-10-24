// AI Sidebar — right-hand overlay panel.
// Positioned fixed so it doesn't affect Shell layout.
// Provides: privacy badge, provider label, quick-action buttons, chat
// transcript grounded in the current document, and a streaming input.

import { useCallback, useEffect, useRef, useState } from "react";
import { DOC_ACTIONS } from "../../ai/actions";
import { type AIErrorInfo, describeAIError, isMacPlatform } from "../../ai/errors";
import {
  detectProvider,
  getCachedProvider,
  NOOP_PROVIDER_ID,
  runSelectionAction,
} from "../../ai/registry";
import type { AIProvider } from "../../ai/types";
import type { DocType } from "../../lib/docClassifier";
import { formatShortcut, isActionEnter } from "../../lib/keymap";
import { type LibraryCitation, retrieveLibraryContext } from "../../lib/libraryContext";
import { recordAbort, recordFailure, recordSuccess } from "../../lib/telemetry";
import type { ChatMessage } from "../../store/aiStore";
import { useAIStore } from "../../store/aiStore";
import { useDocumentStore } from "../../store/documentStore";
import { memoryBlock } from "../../store/memoryStore";
import { useUiStore } from "../../store/uiStore";
import { renderChatMarkdown } from "./chatMarkdown";
import { RelatedNotes } from "./RelatedNotes";

// ---------------------------------------------------------------------------
// Doc-type context hints
// ---------------------------------------------------------------------------

/** Per-DocType prompt suggestion shown in the empty-state of the sidebar. */
const DOC_TYPE_HINTS: Record<DocType, string | null> = {
  PLAN: "This looks like a project plan. I can help you refine goals, check task completeness, or identify missing milestones.",
  REVIEW:
    "This looks like a review document. I can help you structure feedback, identify blocking vs. non-blocking issues, or draft a summary.",
  SPEC: "This looks like a specification. I can help you check requirement completeness, clarify acceptance criteria, or suggest edge cases.",
  RUNBOOK:
    "This looks like a runbook. I can help you verify step completeness, add rollback steps, or improve troubleshooting coverage.",
  GENERIC: null,
};

/** Renderer hint label shown alongside the doc-type badge in the sidebar. */
const DOC_TYPE_RENDERER_HINT: Record<DocType, string | null> = {
  PLAN: "Tip: switch to the Plan renderer for an interactive task view.",
  REVIEW: "Tip: switch to the Review renderer for a structured findings view.",
  SPEC: "Tip: switch to the Spec renderer for a criteria-tracking view.",
  RUNBOOK: "Tip: switch to the Runbook renderer for a step-by-step execution view.",
  GENERIC: null,
};

function DocTypeHint({ docType }: { docType: DocType }) {
  const hint = DOC_TYPE_HINTS[docType];
  const rendererHint = DOC_TYPE_RENDERER_HINT[docType];
  if (!hint) return null;
  return (
    <div className="ai-doc-type-hint" data-doc-type={docType} aria-live="polite">
      <div className="ai-doc-type-hint__badge">{docType}</div>
      <p className="ai-doc-type-hint__text">{hint}</p>
      {rendererHint && <p className="ai-doc-type-hint__renderer-tip">{rendererHint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Retry constants
// ---------------------------------------------------------------------------

/** Maximum number of retry attempts after an initial failure. */
export const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Max characters of document content we include as system context (~2000 tok)
// ---------------------------------------------------------------------------
export const MAX_CONTEXT_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Privacy badge
// ---------------------------------------------------------------------------

function PrivacyBadge({ tier, isNoop }: { tier: number; isNoop: boolean }) {
  if (isNoop) {
    return (
      <span className="ai-privacy-badge ai-privacy-badge--none">
        <span className="ai-privacy-badge__dot" />
        No AI
      </span>
    );
  }
  if (tier <= 1) {
    return (
      <span className="ai-privacy-badge ai-privacy-badge--local">
        <span className="ai-privacy-badge__dot" />
        {tier === 0 ? "On-device" : "Local"}
      </span>
    );
  }
  return (
    <span className="ai-privacy-badge ai-privacy-badge--cloud">
      <span className="ai-privacy-badge__dot" />
      Cloud
    </span>
  );
}

// ---------------------------------------------------------------------------
// Individual message bubble
// ---------------------------------------------------------------------------

/** A failed generation: the plain next step first, the raw text collapsed. */
function MessageError({ error }: { error: AIErrorInfo }) {
  return (
    <div className="ai-msg__error" role="alert">
      <p className="ai-msg__error-msg">{error.message}</p>
      {error.command && <code className="ai-msg__error-cmd">{error.command}</code>}
      {error.detail && (
        <details className="ai-msg__error-detail">
          <summary>Details</summary>
          <code>{error.detail}</code>
        </details>
      )}
    </div>
  );
}

/** The error of the last message when it is a failed assistant turn with no
 *  text, which the setup nudge shows instead of the hidden chat. */
function unrunNotice(messages: ChatMessage[]): AIErrorInfo | null {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !last.error || last.content.trim()) return null;
  return last.error;
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "system") return null;
  // A failed or stopped turn with no text shows only its note, not an empty
  // "Assistant" bubble.
  const failedEmpty =
    msg.role === "assistant" && (msg.error || msg.stopped) && !msg.content.trim();
  return (
    <div className={`ai-msg ai-msg--${msg.role}`}>
      <span className="ai-msg__label">{msg.role === "user" ? "You" : "Assistant"}</span>
      {failedEmpty ? null : msg.role === "assistant" ? (
        // Assistant markdown is rendered as HTML. The text is model output and
        // untrusted: renderChatMarkdown escapes all of it before formatting and
        // links only http, https and mailto URLs.
        // (noDangerouslySetInnerHtml is disabled in biome.json.)
        <div
          className="ai-msg__bubble"
          dangerouslySetInnerHTML={{
            __html: renderChatMarkdown(msg.content, msg.streaming ?? false),
          }}
        />
      ) : (
        <div className="ai-msg__bubble">{msg.content}</div>
      )}
      {msg.error && <MessageError error={msg.error} />}
      {msg.stopped && !msg.error && (
        <p className="ai-msg__stopped">
          {msg.content.trim() ? "Stopped." : "Stopped before any answer arrived."}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// API key entry form (shown when no provider is found)
// ---------------------------------------------------------------------------

function SetupNudge({
  onKeySet,
  onCheckAgain,
  stillMissing,
  notice,
}: {
  onKeySet: () => void;
  /** Look for a provider again, say once Ollama is running. */
  onCheckAgain: () => void;
  /** A "Check again" found no provider, so say so instead of nothing. */
  stillMissing: boolean;
  /** The request that just failed for want of a provider (say a selection
   *  popover action), shown on top so the user sees why nothing ran. */
  notice: AIErrorInfo | null;
}) {
  const setApiKey = useAIStore((s) => s.setApiKey);
  const [draft, setDraft] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const key = draft.trim();
    if (!key) return;
    setApiKey(key);
    setDraft("");
    onKeySet();
  }

  return (
    <div className="ai-setup-nudge">
      {notice && (
        <div className="ai-setup-nudge__notice">
          <MessageError error={notice} />
        </div>
      )}
      <div className="ai-setup-nudge__icon">🤖</div>
      <p className="ai-setup-nudge__title">No AI provider found</p>
      <p className="ai-setup-nudge__body">
        {/* The README promises a zero-install on-device model on macOS 26+;
            the nudge used to offer only Ollama and a key, with no word on why
            that model was not found. Ashlr MD checks for it once per launch. */}
        {isMacPlatform() && (
          <>
            On a Mac with Apple Silicon and macOS 26 or later, the built-in on-device
            model needs Apple Intelligence: turn it on in System Settings → Apple
            Intelligence &amp; Siri, then restart Ashlr MD.
            <br />
            <br />
          </>
        )}
        For free local AI, install{" "}
        <a
          href="https://ollama.ai"
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--accent)" }}
        >
          Ollama
        </a>{" "}
        and run <code>ollama pull llama3.2</code>.
        <br />
        <br />
        Or enter an Anthropic API key below for cloud inference.
      </p>
      {/* Detection ran only when the sidebar opened, so a user who started
          Ollama with the panel open had to close and reopen it to be seen. */}
      <button className="ai-recheck-btn" type="button" onClick={onCheckAgain}>
        Check again
      </button>
      {stillMissing && (
        <p className="ai-setup-nudge__still" role="status">
          Still no AI provider found. Start Ollama with a model pulled, or save a key
          below, then check again.
        </p>
      )}
      <form className="ai-key-form" onSubmit={submit}>
        <input
          className="ai-key-input"
          type="password"
          placeholder="sk-ant-…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="ai-key-submit" type="submit" disabled={!draft.trim()}>
          Save key
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SendIcon / StopIcon
// ---------------------------------------------------------------------------

function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.5 8L2.5 3l2.5 5-2.5 5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M5 8h8.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

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

// ---------------------------------------------------------------------------
// AISidebar
// ---------------------------------------------------------------------------

export function AISidebar() {
  const open = useAIStore((s) => s.open);
  const toggle = useAIStore((s) => s.toggle);
  const provider = useAIStore((s) => s.provider);
  const providerId = useAIStore((s) => s.providerId);
  const messages = useAIStore((s) => s.messages);
  const busy = useAIStore((s) => s.busy);
  const setProvider = useAIStore((s) => s.setProvider);
  const clearProvider = useAIStore((s) => s.clearProvider);
  const pushMessage = useAIStore((s) => s.pushMessage);
  const updateLast = useAIStore((s) => s.updateLastAssistantMessage);
  const finalizeLast = useAIStore((s) => s.finalizeLastAssistantMessage);
  const failLast = useAIStore((s) => s.failLastAssistantMessage);
  const stopLast = useAIStore((s) => s.stopLastAssistantMessage);
  const dropFailed = useAIStore((s) => s.dropFailedAssistantMessage);
  const setBusy = useAIStore((s) => s.setBusy);
  const libraryScope = useAIStore((s) => s.libraryScope);
  const setLibraryScope = useAIStore((s) => s.setLibraryScope);
  // Re-detect when a key is added or removed (the setup nudge or Preferences),
  // so a removed key does not leave the sidebar on the Anthropic tier.
  const hasApiKey = useAIStore((s) => !!s.apiKey);

  const docContent = useDocumentStore((s) => s.content);
  const currentDocType = useUiStore((s) => s.currentDocType);

  const [input, setInput] = useState("");
  const [resolvedProvider, setResolvedProvider] = useState<AIProvider | null>(null);
  const [detecting, setDetecting] = useState(false);
  // A "Check again" on the setup panel found no provider.
  const [recheckMissed, setRecheckMissed] = useState(false);
  // retryState: holds the pending retry context when a generation fails.
  const [retryState, setRetryState] = useState<{
    retryCount: number;
    /** Re-run the last failed generation. */
    retry: () => void;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const isNoop = providerId === NOOP_PROVIDER_ID;

  // Detect provider when sidebar opens. Use the startup-warmed cache for an
  // instant render (no "Detecting…" wall), then refresh silently in the
  // background so a newly-installed Ollama still gets picked up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasApiKey is a trigger, a key change re-runs detection
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const cached = getCachedProvider();
    if (cached) {
      setResolvedProvider(cached);
      setProvider(cached.id, cached.capabilities);
      setDetecting(false);
    } else {
      setDetecting(true);
    }
    detectProvider().then(
      (p) => {
        if (cancelled) return;
        setResolvedProvider(p);
        setProvider(p.id, p.capabilities);
        setDetecting(false);
      },
      () => {
        // Detection threw: no provider is known, so show the setup panel
        // rather than "Detecting..." forever or a cached provider's chat.
        if (cancelled) return;
        setResolvedProvider(null);
        clearProvider();
        setDetecting(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, setProvider, clearProvider, hasApiKey]);

  /** Look for a provider again, from the setup panel. Resolves to whether
   *  one was found. */
  async function redetect(): Promise<boolean> {
    setDetecting(true);
    let found = false;
    try {
      const p = await detectProvider();
      setResolvedProvider(p);
      setProvider(p.id, p.capabilities);
      found = p.id !== NOOP_PROVIDER_ID;
    } catch {
      setResolvedProvider(null);
      clearProvider();
    }
    setRecheckMissed(!found);
    setDetecting(false);
    return found;
  }

  // Scroll to bottom when messages change.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when sidebar opens; restore focus to the trigger (the AI toggle
  // button) when it closes so keyboard users aren't stranded.
  useEffect(() => {
    if (!open || isNoop) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    // Restore in cleanup so focus is returned both on close (open → false) AND
    // on unmount while still open (e.g. the tab is closed) — otherwise keyboard
    // focus is stranded on <body>.
    return () => {
      clearTimeout(t);
      if (restoreFocusRef.current?.isConnected) {
        restoreFocusRef.current.focus?.();
        restoreFocusRef.current = null;
      }
    };
  }, [open, isNoop]);

  // Build system context from current document (truncated to MAX_CONTEXT_CHARS).
  function buildSystemContext(): string {
    const truncated =
      docContent.length > MAX_CONTEXT_CHARS
        ? docContent.slice(0, MAX_CONTEXT_CHARS) +
          "\n\n[…document truncated for context…]"
        : docContent;
    return truncated
      ? `You are a helpful assistant embedded in a Markdown editor. ` +
          `The user is currently editing the following document:\n\n---\n${truncated}\n---\n\n` +
          `Answer questions about the document, help improve it, or chat generally. ` +
          `Use markdown in your responses.`
      : `You are a helpful assistant embedded in a Markdown editor. ` +
          `No document is currently open. Help the user with any Markdown or writing task.`;
  }

  // Core generation runner — shared by send() and retry paths.
  // Returns true on success, false on failure (non-abort).
  const runGeneration = useCallback(
    async (
      allMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      citations: LibraryCitation[],
      controller: AbortController,
    ): Promise<boolean> => {
      if (!resolvedProvider) return false;
      const startMs = Date.now();
      try {
        await runSelectionAction(
          resolvedProvider,
          allMessages,
          (delta) => updateLast(delta),
          controller.signal,
        );
        if (citations.length > 0) {
          updateLast(`\n\n*Sources: ${citations.map((c) => c.fileName).join(" · ")}*`);
        }
        // Record success telemetry.
        recordSuccess(
          resolvedProvider.id,
          resolvedProvider.capabilities.tier,
          Date.now() - startMs,
        );
        return true;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const isAbort =
          errMsg === "Aborted" ||
          (e instanceof DOMException && e.name === "AbortError");
        if (isAbort) {
          recordAbort(resolvedProvider.id, resolvedProvider.capabilities.tier);
          stopLast();
        } else {
          recordFailure(resolvedProvider.id, resolvedProvider.capabilities.tier);
          failLast(describeAIError(e));
        }
        return false;
      }
    },
    [resolvedProvider, updateLast, failLast, stopLast],
  );

  // Send a chat message.
  const send = useCallback(
    async (text: string, retryCount = 0) => {
      if (!text.trim() || !resolvedProvider || busy) return;

      // Clear any previous retry state when starting a fresh send.
      if (retryCount === 0) setRetryState(null);

      // A retry re-runs the same turn: replace the failed answer and keep the
      // user's message once (it used to be added again on every retry).
      if (retryCount === 0) pushMessage({ role: "user", content: text.trim() });
      else dropFailed();
      // Placeholder streaming message.
      pushMessage({ role: "assistant", content: "", streaming: true });
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      // System context: current document + what we remember about the user +
      // (optionally) grounded excerpts retrieved from their whole library.
      let systemMsg = buildSystemContext();
      const mem = memoryBlock();
      if (mem) systemMsg += `\n\n${mem}`;
      let citations: LibraryCitation[] = [];
      if (libraryScope) {
        try {
          // Exclude the current doc — it's already in the system context above.
          const here = useDocumentStore.getState().path;
          const lib = await retrieveLibraryContext(text.trim(), here ? [here] : []);
          if (lib.block) {
            systemMsg +=
              `\n\n${lib.block}\n\n` +
              "Ground your answer in these excerpts and name the files you drew from.";
            citations = lib.citations;
          }
        } catch {
          // Retrieval failed — answer without library grounding.
        }
        // The user may have hit Stop during retrieval — bail before generating.
        if (controller.signal.aborted) {
          stopLast();
          finalizeLast();
          setBusy(false);
          abortRef.current = null;
          return;
        }
      }

      // Build full message history.
      const history = useAIStore
        .getState()
        // Skip in-flight messages AND any finalized-but-empty assistant turn
        // (an aborted/failed stream) — providers like Anthropic reject a message
        // with empty content.
        .messages.filter((m) => !m.streaming && m.content.trim() !== "")
        .map((m) => ({
          role: m.role as "user" | "assistant" | "system",
          content: m.content,
        }));

      const allMessages = [
        { role: "system" as const, content: systemMsg },
        ...history.slice(-20), // Keep last 20 to stay within context windows
      ];

      const succeeded = await runGeneration(allMessages, citations, controller);

      finalizeLast();
      setBusy(false);
      abortRef.current = null;

      // On failure (non-abort) offer retry up to MAX_RETRIES times.
      if (!succeeded && !controller.signal.aborted) {
        const nextRetryCount = retryCount + 1;
        if (nextRetryCount <= MAX_RETRIES) {
          setRetryState({
            retryCount: nextRetryCount,
            retry: () => {
              setRetryState(null);
              void send(text, nextRetryCount);
            },
          });
        } else {
          // Exceeded max retries — clear retry state.
          setRetryState(null);
        }
      }
    },
    [
      resolvedProvider,
      busy,
      pushMessage,
      updateLast,
      finalizeLast,
      stopLast,
      dropFailed,
      setBusy,
      docContent,
      libraryScope,
      runGeneration,
    ],
  );

  // Run a doc-level quick action.
  const runDocAction = useCallback(
    async (actionId: string, retryCount = 0) => {
      if (!resolvedProvider || busy) return;
      const action = DOC_ACTIONS.find((a) => a.id === actionId);
      if (!action) return;

      if (retryCount === 0) setRetryState(null);

      const truncated =
        docContent.length > MAX_CONTEXT_CHARS
          ? docContent.slice(0, MAX_CONTEXT_CHARS)
          : docContent;
      // Inject what we remember about the user so quick actions honor it too.
      const mem = memoryBlock();
      const msgs = mem
        ? [
            { role: "system" as const, content: mem },
            ...action.buildMessages(truncated),
          ]
        : action.buildMessages(truncated);
      if (retryCount === 0) pushMessage({ role: "user", content: action.label });
      else dropFailed();
      pushMessage({ role: "assistant", content: "", streaming: true });
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;

      const succeeded = await runGeneration(msgs, [], controller);

      finalizeLast();
      setBusy(false);
      abortRef.current = null;

      // Offer retry on failure (non-abort), up to MAX_RETRIES.
      if (!succeeded && !controller.signal.aborted) {
        const nextRetryCount = retryCount + 1;
        if (nextRetryCount <= MAX_RETRIES) {
          setRetryState({
            retryCount: nextRetryCount,
            retry: () => {
              setRetryState(null);
              void runDocAction(actionId, nextRetryCount);
            },
          });
        } else {
          setRetryState(null);
        }
      }
    },
    [
      resolvedProvider,
      busy,
      docContent,
      pushMessage,
      updateLast,
      finalizeLast,
      dropFailed,
      setBusy,
      runGeneration,
    ],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Not an Enter that commits an IME composition (isActionEnter), which
    // used to send the message half typed.
    if (isActionEnter(e) && !e.shiftKey) {
      e.preventDefault();
      send(input);
      setInput("");
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    // A selection popover action registers its controller in the store.
    useAIStore.getState().abortController?.abort();
    // Clear any pending retry when the user manually stops.
    setRetryState(null);
  }

  // Why the quick actions are disabled, or null when they can run.
  const quickActionBlock = busy
    ? "wait for the current answer to finish, or stop it."
    : !docContent.trim()
      ? "this document has no text to work on."
      : null;

  return (
    <aside
      className={`ai-sidebar${open ? " ai-sidebar--open" : ""}`}
      aria-label="AI assistant"
    >
      {/* Header */}
      <div className="ai-sidebar__header">
        <PrivacyBadge tier={provider?.tier ?? 1} isNoop={isNoop || !provider} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ai-sidebar__title">AI Assistant</div>
          {provider && !isNoop && (
            <div className="ai-provider-label">{provider.modelName}</div>
          )}
        </div>
        <button
          className="ai-sidebar__close"
          type="button"
          onClick={toggle}
          title={`Close AI sidebar (${formatShortcut("mod+l")})`}
          aria-label="Close AI sidebar"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Quick action buttons. A disabled one says why in its tooltip: it
          used to repeat its label, so an empty document's greyed-out buttons
          gave no reason. They show only once a provider is set up. */}
      {!isNoop && provider && (
        <div className="ai-quick-actions" aria-label="Quick actions">
          {DOC_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              className="ai-quick-btn"
              disabled={!!quickActionBlock}
              onClick={() => runDocAction(a.id)}
              title={quickActionBlock ? `${a.label}: ${quickActionBlock}` : a.label}
            >
              {a.icon} {a.label}
            </button>
          ))}
        </div>
      )}

      {/* The document is cut to MAX_CONTEXT_CHARS before it is sent, which
          used to happen with no word, so answers about its end were guesses. */}
      {!isNoop && provider && docContent.length > MAX_CONTEXT_CHARS && (
        <p className="ai-context-note" role="note">
          The AI sees only the first {MAX_CONTEXT_CHARS.toLocaleString("en-US")} of this
          document's {docContent.length.toLocaleString("en-US")} characters.
        </p>
      )}

      {/* Body: nudge or chat */}
      {detecting ? (
        <div className="ai-setup-nudge">
          <div className="ai-setup-nudge__icon" style={{ animation: "none" }}>
            🔍
          </div>
          <p className="ai-setup-nudge__title">Detecting AI…</p>
        </div>
      ) : isNoop || !provider ? (
        <SetupNudge
          notice={unrunNotice(messages)}
          stillMissing={recheckMissed}
          onKeySet={() => void redetect()}
          onCheckAgain={() => void redetect()}
        />
      ) : (
        <>
          {/* Messages */}
          <div className="ai-messages" role="log" aria-live="polite">
            {messages.length === 0 && (
              <>
                <div
                  style={{
                    color: "var(--text-muted)",
                    fontSize: "12.5px",
                    textAlign: "center",
                    marginTop: "20px",
                  }}
                >
                  Ask anything about your document, or use the quick actions above.
                </div>
                {docContent && <DocTypeHint docType={currentDocType} />}
                <RelatedNotes />
              </>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Retry toast — shown after a failed generation (non-abort). */}
          {retryState && (
            <div className="ai-retry-toast" role="alert" aria-live="assertive">
              <span className="ai-retry-toast__msg">
                Generation failed.{" "}
                {retryState.retryCount <= MAX_RETRIES
                  ? `Retry ${retryState.retryCount} of ${MAX_RETRIES}?`
                  : "No more retries."}
              </span>
              {retryState.retryCount <= MAX_RETRIES && (
                <button
                  type="button"
                  className="ai-retry-btn"
                  onClick={retryState.retry}
                  aria-label="Retry failed AI generation"
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                className="ai-retry-dismiss"
                onClick={() => setRetryState(null)}
                aria-label="Dismiss retry"
              >
                ✕
              </button>
            </div>
          )}

          {/* Scope toggle: ground answers in the whole library, not just this doc. */}
          <div className="ai-scope-row">
            <button
              type="button"
              role="switch"
              aria-checked={libraryScope}
              className={`ai-scope-toggle${libraryScope ? " on" : ""}`}
              onClick={() => setLibraryScope(!libraryScope)}
              title={
                libraryScope
                  ? "Answers are grounded in your whole Markdown library"
                  : "Answers use only the current document"
              }
            >
              <span className="ai-scope-dot" aria-hidden="true" />
              {libraryScope ? "My library" : "This doc"}
            </button>
          </div>

          {/* Input row */}
          <div className="ai-input-row">
            <textarea
              ref={inputRef}
              className="ai-input"
              placeholder="Ask about your document… (Enter to send, Shift+Enter for newline)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={busy}
              rows={1}
              aria-label="Chat input"
            />
            {busy ? (
              <button
                type="button"
                className="ai-stop-btn"
                onClick={handleStop}
                title="Stop generation"
                aria-label="Stop generation"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="button"
                className="ai-send-btn"
                onClick={() => {
                  send(input);
                  setInput("");
                }}
                disabled={!input.trim()}
                title="Send (Enter)"
                aria-label="Send message"
              >
                <SendIcon />
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
