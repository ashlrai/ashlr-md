// AI Sidebar — right-hand overlay panel.
// Positioned fixed so it doesn't affect Shell layout.
// Provides: privacy badge, provider label, quick-action buttons, chat
// transcript grounded in the current document, and a streaming input.

import { useCallback, useEffect, useRef, useState } from "react";
import { DOC_ACTIONS } from "../../ai/actions";
import {
  detectProvider,
  getCachedProvider,
  NOOP_PROVIDER_ID,
  runSelectionAction,
} from "../../ai/registry";
import type { AIProvider } from "../../ai/types";
import { type LibraryCitation, retrieveLibraryContext } from "../../lib/libraryContext";
import type { ChatMessage } from "../../store/aiStore";
import { useAIStore } from "../../store/aiStore";
import { useDocumentStore } from "../../store/documentStore";
import { memoryBlock } from "../../store/memoryStore";
import { RelatedNotes } from "./RelatedNotes";

// ---------------------------------------------------------------------------
// Max characters of document content we include as system context (~2000 tok)
// ---------------------------------------------------------------------------
const MAX_CONTEXT_CHARS = 8_000;

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

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "system") return null;
  return (
    <div className={`ai-msg ai-msg--${msg.role}`}>
      <span className="ai-msg__label">{msg.role === "user" ? "You" : "Assistant"}</span>
      {msg.role === "assistant" ? (
        // Assistant markdown is rendered as HTML; content is model-generated,
        // not user-supplied. (noDangerouslySetInnerHtml is disabled in biome.json.)
        <div
          className="ai-msg__bubble"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(msg.content, msg.streaming ?? false),
          }}
        />
      ) : (
        <div className="ai-msg__bubble">{msg.content}</div>
      )}
    </div>
  );
}

/** Minimal markdown renderer for assistant bubbles.
 *  We do NOT pull in a full markdown library for the chat — keep it light.
 *  Handles: fenced code blocks, inline code, bold, bullet lists, line breaks.
 */
function renderMarkdown(text: string, streaming: boolean): string {
  let html = text
    // Fenced code blocks
    .replace(/```[\w]*\n([\s\S]*?)```/g, (_m, code: string) => {
      return `<pre><code>${escHtml(code.trimEnd())}</code></pre>`;
    })
    // Inline code
    .replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${escHtml(code)}</code>`)
    // Bold
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    // Unordered list items. Wrap only CONSECUTIVE <li> runs in one <ul> — the
    // old greedy `(<li>.*<\/li>)/gs` spanned from the first to the last item and
    // swallowed any prose/blank lines between two separate lists.
    .replace(/^[ \t]*[-*+] (.+)$/gm, "<li>$1</li>")
    .replace(/(?:<li>.*?<\/li>\n?)+/g, (m) => `<ul>${m.replace(/\n/g, "")}</ul>`)
    // Double newline → paragraph break
    .replace(/\n{2,}/g, "</p><p>")
    // Single newline inside paragraphs
    .replace(/\n/g, "<br>");

  // Wrap in a paragraph unless already structured
  if (!html.startsWith("<")) html = `<p>${html}</p>`;

  // Append blinking cursor while streaming
  if (streaming) html += '<span class="ai-cursor" aria-hidden="true"></span>';

  return html;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// API key entry form (shown when no provider is found)
// ---------------------------------------------------------------------------

function SetupNudge({ onKeySet }: { onKeySet: () => void }) {
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
      <div className="ai-setup-nudge__icon">🤖</div>
      <p className="ai-setup-nudge__title">No AI provider found</p>
      <p className="ai-setup-nudge__body">
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
          Save key &amp; retry
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
  const pushMessage = useAIStore((s) => s.pushMessage);
  const updateLast = useAIStore((s) => s.updateLastAssistantMessage);
  const finalizeLast = useAIStore((s) => s.finalizeLastAssistantMessage);
  const setBusy = useAIStore((s) => s.setBusy);
  const libraryScope = useAIStore((s) => s.libraryScope);
  const setLibraryScope = useAIStore((s) => s.setLibraryScope);

  const docContent = useDocumentStore((s) => s.content);

  const [input, setInput] = useState("");
  const [resolvedProvider, setResolvedProvider] = useState<AIProvider | null>(null);
  const [detecting, setDetecting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isNoop = providerId === NOOP_PROVIDER_ID;

  // Detect provider when sidebar opens. Use the startup-warmed cache for an
  // instant render (no "Detecting…" wall), then refresh silently in the
  // background so a newly-installed Ollama still gets picked up.
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
    detectProvider().then((p) => {
      if (cancelled) return;
      setResolvedProvider(p);
      setProvider(p.id, p.capabilities);
      setDetecting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, setProvider]);

  // Scroll to bottom when messages change.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when sidebar opens.
  useEffect(() => {
    if (open && !isNoop) {
      setTimeout(() => inputRef.current?.focus(), 250);
    }
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

  // Send a chat message.
  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || !resolvedProvider || busy) return;

      pushMessage({ role: "user", content: text.trim() });
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
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== "Aborted") updateLast(`\n\n*Error: ${msg}*`);
      } finally {
        finalizeLast();
        setBusy(false);
        abortRef.current = null;
      }
    },
    [
      resolvedProvider,
      busy,
      pushMessage,
      updateLast,
      finalizeLast,
      setBusy,
      docContent,
      libraryScope,
    ],
  );

  // Run a doc-level quick action.
  const runDocAction = useCallback(
    async (actionId: string) => {
      if (!resolvedProvider || busy) return;
      const action = DOC_ACTIONS.find((a) => a.id === actionId);
      if (!action) return;
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
      pushMessage({ role: "user", content: action.label });
      pushMessage({ role: "assistant", content: "", streaming: true });
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await runSelectionAction(
          resolvedProvider,
          msgs,
          (d) => updateLast(d),
          controller.signal,
        );
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (m !== "Aborted") updateLast(`\n\n*Error: ${m}*`);
      } finally {
        finalizeLast();
        setBusy(false);
        abortRef.current = null;
      }
    },
    [
      resolvedProvider,
      busy,
      docContent,
      pushMessage,
      updateLast,
      finalizeLast,
      setBusy,
    ],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
      setInput("");
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

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
          title="Close AI sidebar (⌘K)"
          aria-label="Close AI sidebar"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Quick action buttons */}
      {!isNoop && provider && (
        <div className="ai-quick-actions" aria-label="Quick actions">
          {DOC_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              className="ai-quick-btn"
              disabled={busy || !docContent}
              onClick={() => runDocAction(a.id)}
              title={a.label}
            >
              {a.icon} {a.label}
            </button>
          ))}
        </div>
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
          onKeySet={() => {
            setDetecting(true);
            detectProvider().then((p) => {
              setResolvedProvider(p);
              setProvider(p.id, p.capabilities);
              setDetecting(false);
            });
          }}
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
                <RelatedNotes />
              </>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
            <div ref={messagesEndRef} />
          </div>

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
