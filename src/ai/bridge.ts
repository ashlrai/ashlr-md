// Thin Tauri bridge — all actual HTTP calls live in Rust (reqwest) to avoid
// CORS and to keep API keys out of the webview process.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAIStore } from "../store/aiStore";
import type { AIMessage } from "./types";

// ---------------------------------------------------------------------------
// Tauri event payloads (must mirror the Rust structs in ai.rs)
// ---------------------------------------------------------------------------

interface DeltaPayload {
  requestId: string;
  delta: string;
}

interface ErrorPayload {
  requestId: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Detection helpers — thin wrappers around the Rust commands
// ---------------------------------------------------------------------------

/**
 * Ask Rust to probe Ollama at localhost:11434.
 * Returns the best available model name, or null if Ollama is not running /
 * has no models installed.
 */
export async function detectOllama(): Promise<string | null> {
  try {
    return await invoke<string | null>("ai_detect_ollama");
  } catch {
    return null;
  }
}

/**
 * Ask whether an Anthropic API key has been stored (via aiStore / localStorage).
 * We just read the store value — the key is never sent to Rust until generation
 * time, so this is a purely local check.
 */
export function detectAnthropicKey(): string | null {
  // The key lives in memory in aiStore (loaded from the OS keychain at startup),
  // never in localStorage. Read it from the store's current state.
  return useAIStore.getState().apiKey ?? null;
}

// ---------------------------------------------------------------------------
// Stream generation
// ---------------------------------------------------------------------------

/**
 * Invoke the Rust `ai_generate` command and forward token deltas to `onDelta`.
 *
 * Contract:
 *  - Rust emits Tauri events on channel "ai://delta", "ai://done", "ai://error".
 *  - Each event payload includes `requestId` so concurrent requests don't cross.
 *  - We register listeners before invoking, then clean up on done/error/abort.
 *
 * @param providerId  "ollama" | "anthropic" | "hosted"
 * @param model       Model name string (e.g. "llama3.2", "claude-haiku-4-5")
 * @param apiKey      Cloud API key — null for local providers
 * @param messages    Full conversation history
 * @param onDelta     Called synchronously for each token delta string
 * @param signal      Optional AbortSignal — cancels the stream
 */
export async function aiGenerateStream(
  providerId: string,
  model: string,
  apiKey: string | null,
  messages: AIMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  // Unique ID so multiple concurrent requests don't collide on events.
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise<void>((resolve, reject) => {
    let unlistenDelta: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;

    function cleanup() {
      unlistenDelta?.();
      unlistenDone?.();
      unlistenError?.();
    }

    // Wire up all three event channels, then invoke.
    Promise.all([
      listen<DeltaPayload>("ai://delta", (e) => {
        if (e.payload.requestId !== requestId) return;
        if (signal?.aborted) return;
        onDelta(e.payload.delta);
      }),
      listen<{ requestId: string }>("ai://done", (e) => {
        if (e.payload.requestId !== requestId) return;
        cleanup();
        resolve();
      }),
      listen<ErrorPayload>("ai://error", (e) => {
        if (e.payload.requestId !== requestId) return;
        cleanup();
        reject(new Error(e.payload.error));
      }),
    ])
      .then(([ul1, ul2, ul3]) => {
        unlistenDelta = ul1;
        unlistenDone = ul2;
        unlistenError = ul3;

        // Handle abort before/during invoke.
        if (signal?.aborted) {
          cleanup();
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }

        signal?.addEventListener("abort", () => {
          cleanup();
          reject(new DOMException("Aborted", "AbortError"));
        });

        // Kick off generation in Rust — returns quickly; results come via events.
        return invoke("ai_generate", {
          provider: providerId,
          model,
          apiKey,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          requestId,
        });
      })
      .catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

// ---------------------------------------------------------------------------
// Apple Foundation Models (Tier 0) — backed by the mdopener-afm Swift sidecar
// ---------------------------------------------------------------------------

/** Probe the on-device model via Rust. Returns the model name, or null. */
export async function detectAfm(): Promise<string | null> {
  try {
    return await invoke<string | null>("afm_detect");
  } catch {
    return null;
  }
}

/**
 * Invoke `afm_generate` and forward deltas. Reuses the same
 * "ai://delta" / "ai://done" / "ai://error" channels as aiGenerateStream.
 */
export async function afmGenerateStream(
  messages: AIMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise<void>((resolve, reject) => {
    let unlistenDelta: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;

    function cleanup() {
      unlistenDelta?.();
      unlistenDone?.();
      unlistenError?.();
    }

    Promise.all([
      listen<DeltaPayload>("ai://delta", (e) => {
        if (e.payload.requestId !== requestId) return;
        if (signal?.aborted) return;
        onDelta(e.payload.delta);
      }),
      listen<{ requestId: string }>("ai://done", (e) => {
        if (e.payload.requestId !== requestId) return;
        cleanup();
        resolve();
      }),
      listen<ErrorPayload>("ai://error", (e) => {
        if (e.payload.requestId !== requestId) return;
        cleanup();
        reject(new Error(e.payload.error));
      }),
    ])
      .then(([ul1, ul2, ul3]) => {
        unlistenDelta = ul1;
        unlistenDone = ul2;
        unlistenError = ul3;

        if (signal?.aborted) {
          cleanup();
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          cleanup();
          reject(new DOMException("Aborted", "AbortError"));
        });

        return invoke("afm_generate", {
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          requestId,
        });
      })
      .catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}
