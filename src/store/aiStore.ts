// AI assistant Zustand store.
//
// Provider preferences persist to localStorage (zustand/persist), but the
// Anthropic API key does NOT — it lives in the OS keychain (see secrets.rs) and
// is loaded into memory at startup via `loadApiKey()`. This keeps the secret out
// of any XSS blast radius. A legacy plaintext key from an older build is
// migrated into the keychain (and stripped from localStorage) on first load.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AICapabilities } from "../ai/types";

/** Keychain account label for the Anthropic key (see secrets.rs `SERVICE`). */
const AI_KEY_ACCOUNT = "anthropic";

/** Write/clear the key in the OS keychain. Returns whether it succeeded. */
async function persistKeyToKeychain(key: string | null): Promise<boolean> {
  try {
    if (key) await invoke("set_ai_key", { account: AI_KEY_ACCOUNT, key });
    else await invoke("delete_ai_key", { account: AI_KEY_ACCOUNT });
    return true;
  } catch {
    // Keychain unavailable (e.g. headless CI) — the key stays in memory only.
    return false;
  }
}

/** Read a legacy plaintext key from the old persisted blob WITHOUT removing it. */
function peekLegacyKey(): string | null {
  try {
    const raw = localStorage.getItem("mdopener-ai");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { apiKey?: unknown } };
    const legacy = parsed?.state?.apiKey;
    return typeof legacy === "string" && legacy.length > 0 ? legacy : null;
  } catch {
    return null;
  }
}

/** Strip the legacy plaintext key from localStorage (only after it's safe). */
function clearLegacyKey(): void {
  try {
    const raw = localStorage.getItem("mdopener-ai");
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: { apiKey?: unknown } };
    if (parsed?.state && "apiKey" in parsed.state) {
      delete parsed.state.apiKey;
      localStorage.setItem("mdopener-ai", JSON.stringify(parsed));
    }
  } catch {
    // Malformed blob — nothing to clear.
  }
}

// ---------------------------------------------------------------------------
// Chat message type (extends AIMessage with UI metadata)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** ISO timestamp for display */
  timestamp: number;
  /** true while the assistant is still streaming this message */
  streaming?: boolean;
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface AIState {
  /** Whether the AI sidebar is open */
  open: boolean;
  /** The resolved provider capabilities, null if not yet detected */
  provider: AICapabilities | null;
  /** The provider id string (e.g. "ollama", "anthropic", "noop") */
  providerId: string | null;
  /** Full chat transcript for the current session */
  messages: ChatMessage[];
  /** true while a generation is in flight */
  busy: boolean;
  /** Anthropic (or future provider) API key — held in memory only; the source
   *  of truth is the OS keychain. Loaded via `loadApiKey()` at startup. */
  apiKey: string | null;
  /** Persisted user preference for which tier to use when multiple available */
  preferredTier: 0 | 1 | 2 | 3 | null;
  /** When true, chat answers are grounded in the user's whole Markdown library. */
  libraryScope: boolean;
  setLibraryScope: (v: boolean) => void;

  // Actions
  toggle(): void;
  open_(): void;
  close(): void;
  setProvider(id: string, caps: AICapabilities): void;
  clearProvider(): void;
  pushMessage(msg: Omit<ChatMessage, "id" | "timestamp">): ChatMessage;
  updateLastAssistantMessage(delta: string): void;
  finalizeLastAssistantMessage(): void;
  clearMessages(): void;
  setBusy(busy: boolean): void;
  setApiKey(key: string | null): void;
  /** Load the key from the OS keychain (migrating any legacy plaintext key). */
  loadApiKey(): Promise<void>;
  setPreferredTier(tier: 0 | 1 | 2 | 3 | null): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useAIStore = create<AIState>()(
  persist(
    (set) => ({
      open: false,
      provider: null,
      providerId: null,
      messages: [],
      busy: false,
      apiKey: null,
      preferredTier: null,
      libraryScope: false,

      toggle() {
        set((s) => ({ open: !s.open }));
      },

      open_() {
        set({ open: true });
      },

      close() {
        set({ open: false });
      },

      setProvider(id, caps) {
        set({ providerId: id, provider: caps });
      },

      clearProvider() {
        set({ providerId: null, provider: null });
      },

      pushMessage(partial) {
        const msg: ChatMessage = {
          id: makeId(),
          timestamp: Date.now(),
          ...partial,
        };
        set((s) => ({ messages: [...s.messages, msg] }));
        return msg;
      },

      /** Append a streaming delta to the last assistant message in place. */
      updateLastAssistantMessage(delta) {
        set((s) => {
          const msgs = [...s.messages];
          // Find last assistant message that is still streaming.
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant" && msgs[i].streaming) {
              msgs[i] = { ...msgs[i], content: msgs[i].content + delta };
              return { messages: msgs };
            }
          }
          // No streaming message found — create one (shouldn't normally happen).
          msgs.push({
            id: makeId(),
            role: "assistant",
            content: delta,
            timestamp: Date.now(),
            streaming: true,
          });
          return { messages: msgs };
        });
      },

      /** Mark the last streaming assistant message as complete. */
      finalizeLastAssistantMessage() {
        set((s) => {
          const msgs = [...s.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant" && msgs[i].streaming) {
              msgs[i] = { ...msgs[i], streaming: false };
              return { messages: msgs };
            }
          }
          return {};
        });
      },

      clearMessages() {
        set({ messages: [] });
      },

      setBusy(busy) {
        set({ busy });
      },

      setApiKey(key) {
        set({ apiKey: key });
        // Source of truth is the keychain, never localStorage.
        void persistKeyToKeychain(key);
      },

      async loadApiKey() {
        // Migrate a legacy plaintext key first. Only scrub it from localStorage
        // AFTER it is confirmed written to the keychain, so a keychain failure
        // can never lose the user's key.
        const legacy = peekLegacyKey();
        if (legacy) {
          set({ apiKey: legacy });
          const ok = await persistKeyToKeychain(legacy);
          if (ok) clearLegacyKey();
          return;
        }
        try {
          const key = await invoke<string | null>("get_ai_key", {
            account: AI_KEY_ACCOUNT,
          });
          if (key) set({ apiKey: key });
        } catch {
          // Keychain unavailable — tier-2 detection just won't auto-resolve.
        }
      },

      setPreferredTier(tier) {
        set({ preferredTier: tier });
      },

      setLibraryScope(libraryScope) {
        set({ libraryScope });
      },
    }),
    {
      name: "mdopener-ai",
      // Only persist non-secret preferences. The API key is NEVER written here —
      // it lives in the OS keychain (see secrets.rs / loadApiKey).
      partialize: (s) => ({
        preferredTier: s.preferredTier,
        libraryScope: s.libraryScope,
      }),
    },
  ),
);
