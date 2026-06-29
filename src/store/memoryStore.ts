/**
 * memoryStore.ts — local AI memory ("it knows my stuff").
 *
 * A small, user-owned set of facts/preferences/projects that gets injected into
 * AI context so the assistant stops asking for the same context and gets more
 * useful the more you use it — the switching-cost moat, kept fully local and
 * fully transparent (view/edit/delete in Settings). Nothing leaves the device.
 *
 * Also contains the conversation session store — a per-session message log
 * used by the `get_conversation_context` and `save_conversation_message` MCP
 * tools to give agents multi-turn memory grounded in the user's actual edits.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { OtLogEntry } from "../lib/ot";

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
  /** Where it came from — typed by the user, or suggested by the AI. */
  source: "user" | "ai";
}

interface MemoryState {
  items: MemoryItem[];
  add: (text: string, source?: "user" | "ai") => void;
  remove: (id: string) => void;
  clear: () => void;
}

function makeId(): string {
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Cap how much memory is injected into a prompt, so it can't grow unbounded. */
const MAX_MEMORY_CHARS = 2_000;

export const useMemoryStore = create<MemoryState>()(
  persist(
    (set) => ({
      items: [],
      add: (text, source = "user") => {
        const t = text.trim();
        if (!t) return;
        set((s) =>
          // Dedup identical facts.
          s.items.some((i) => i.text === t)
            ? s
            : {
                items: [
                  ...s.items,
                  { id: makeId(), text: t, createdAt: Date.now(), source },
                ],
              },
        );
      },
      remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
      clear: () => set({ items: [] }),
    }),
    { name: "mdopener-memory" },
  ),
);

/**
 * Format memory into a system-prompt block, or "" when empty.
 * Bounded to MAX_MEMORY_CHARS so a long memory list can't bloat every prompt
 * (oldest-first; newest items are dropped if over budget).
 */
export function memoryBlock(): string {
  const { items } = useMemoryStore.getState();
  if (items.length === 0) return "";
  const header =
    "What you know about this user (preferences, projects, and facts they asked " +
    "you to remember):\n";
  let body = "";
  for (const i of items) {
    const line = `- ${i.text}\n`;
    if (header.length + body.length + line.length > MAX_MEMORY_CHARS) break;
    body += line;
  }
  return body ? header + body.trimEnd() : "";
}

// ── Conversation session store ─────────────────────────────────────────────────

/**
 * A single message appended to a conversation session by an agent or human.
 *
 * - `agent`   — an action the AI agent took (e.g. "Rewrote introduction").
 * - `human`   — a verdict or comment left by the human (e.g. "Approved").
 * - `system`  — internal bookkeeping (e.g. document path at session start).
 */
export type ConversationRole = "agent" | "human" | "system";

export interface ConversationMessage {
  id: string;
  sessionId: string;
  role: ConversationRole;
  content: string;
  /** Docs that were open / cited when this message was produced. */
  citedDocs: string[];
  timestampMs: number;
}

/** Maximum messages kept per session in-memory (older ones scroll off). */
const MAX_MESSAGES_PER_SESSION = 200;

interface ConversationSessionState {
  /** Active session identifier — set when a new session starts. */
  currentSessionId: string | null;
  /** In-memory message log for the current session. */
  messages: ConversationMessage[];

  /** Start a new session (or resume an existing one by id). */
  startSession: (sessionId?: string) => string;
  /** Append a message to the current session. Returns the new message. */
  appendMessage: (
    role: ConversationRole,
    content: string,
    citedDocs?: string[],
  ) => ConversationMessage | null;
  /** Return the last `n` messages for the current session. */
  getContext: (n?: number) => ConversationMessage[];
  /** Clear all messages for the current session. */
  clearSession: () => void;
  /** End the session (clears currentSessionId). */
  endSession: () => void;
}

function makeSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * useConversationStore — multi-turn agent context for the current session.
 *
 * Persisted to localStorage under "mdopener-conversation" so the in-memory
 * state survives hot-reloads in development.  The Rust MCP layer handles
 * durable disk persistence to `~/.mdopener/sessions/{sessionId}.json`.
 */
export const useConversationStore = create<ConversationSessionState>()(
  persist(
    (set, get) => ({
      currentSessionId: null,
      messages: [],

      startSession: (sessionId) => {
        const id = sessionId ?? makeSessionId();
        set({ currentSessionId: id });
        return id;
      },

      appendMessage: (role, content, citedDocs = []) => {
        const { currentSessionId } = get();
        if (!currentSessionId) return null;

        const msg: ConversationMessage = {
          id: makeMessageId(),
          sessionId: currentSessionId,
          role,
          content: content.trim(),
          citedDocs,
          timestampMs: Date.now(),
        };

        set((s) => {
          const updated = [...s.messages, msg];
          // Keep only the most recent N messages to bound memory usage.
          return {
            messages:
              updated.length > MAX_MESSAGES_PER_SESSION
                ? updated.slice(updated.length - MAX_MESSAGES_PER_SESSION)
                : updated,
          };
        });

        return msg;
      },

      getContext: (n = 20) => {
        const { currentSessionId, messages } = get();
        if (!currentSessionId) return [];
        const session = messages.filter(
          (m) => m.sessionId === currentSessionId,
        );
        return session.slice(Math.max(0, session.length - n));
      },

      clearSession: () => set({ messages: [] }),

      endSession: () => set({ currentSessionId: null }),
    }),
    { name: "mdopener-conversation" },
  ),
);

// ── OT operation log store (session recovery) ──────────────────────────────────

/**
 * Maximum number of log entries retained per document path.
 * Old entries are evicted (oldest-first) once this cap is hit.
 */
const MAX_OT_LOG_PER_DOC = 500;

interface OtLogState {
  /** Persisted log entries keyed by document path. */
  entries: OtLogEntry[];

  /** Append one or more entries; evicts oldest when over cap for a given path. */
  append: (entry: OtLogEntry | OtLogEntry[]) => void;
  /** Return entries for a specific document path. */
  getForDoc: (docPath: string) => OtLogEntry[];
  /** Remove all entries for a specific document path. */
  clearDoc: (docPath: string) => void;
  /** Remove all entries. */
  clearAll: () => void;
}

/**
 * useOtLogStore — persisted OT operation log for session recovery.
 *
 * Stored under "mdopener-ot-log" in localStorage.  Agents reconnecting to a
 * collaborative session can call `getForDoc(path)` to replay the op log from
 * the last known state without re-downloading the full document.
 */
export const useOtLogStore = create<OtLogState>()(
  persist(
    (set, get) => ({
      entries: [],

      append: (entry) => {
        const toAdd = Array.isArray(entry) ? entry : [entry];
        set((s) => {
          let updated = [...s.entries, ...toAdd];
          // Evict oldest entries per doc path if over cap.
          const pathCounts = new Map<string, number>();
          for (const e of updated) {
            pathCounts.set(e.docPath, (pathCounts.get(e.docPath) ?? 0) + 1);
          }
          for (const [docPath, count] of pathCounts) {
            if (count > MAX_OT_LOG_PER_DOC) {
              const overflow = count - MAX_OT_LOG_PER_DOC;
              let removed = 0;
              updated = updated.filter((e) => {
                if (e.docPath === docPath && removed < overflow) {
                  removed++;
                  return false;
                }
                return true;
              });
            }
          }
          return { entries: updated };
        });
      },

      getForDoc: (docPath) =>
        get().entries.filter((e) => e.docPath === docPath),

      clearDoc: (docPath) =>
        set((s) => ({ entries: s.entries.filter((e) => e.docPath !== docPath) })),

      clearAll: () => set({ entries: [] }),
    }),
    { name: "mdopener-ot-log" },
  ),
);
