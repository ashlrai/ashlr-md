// Thin Tauri bridge — all actual HTTP calls live in Rust (reqwest) to avoid
// CORS and to keep API keys out of the webview process.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { recordAbort, recordFailure, recordSuccess } from "../lib/telemetry";
import { uniqueId } from "../lib/uniqueId";
import { useAIStore } from "../store/aiStore";
import type { AIMessage } from "./types";

// ---------------------------------------------------------------------------
// Provider tier map — used for telemetry recording
// ---------------------------------------------------------------------------

const PROVIDER_TIER: Record<string, number> = {
  "apple-fm": 0,
  ollama: 1,
  "local-inference": 1,
  anthropic: 2,
  hosted: 3,
};

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
 * True in offline mode (`localInference.offline` in ~/.ashlr/config.json):
 * every cloud provider is skipped. Fails closed: if the check itself fails,
 * report offline so a cloud request is never made by mistake.
 */
export async function detectOfflineMode(): Promise<boolean> {
  try {
    return (await invoke<boolean>("ai_offline_mode")) === true;
  } catch {
    return true;
  }
}

/** Value-free status of a valid `localInference` block (no URL). */
export interface LocalInferenceStatus {
  /** True when `localInference.offline` is set. Absent means not offline. */
  offline?: boolean;
  provider: string;
  model: string;
  loopback: boolean;
}

/**
 * Ask Rust for the `localInference` block in ~/.ashlr/config.json. Null when
 * it is absent or invalid (an invalid block never routes anywhere).
 */
export async function detectLocalInference(): Promise<LocalInferenceStatus | null> {
  try {
    return await invoke<LocalInferenceStatus | null>("ai_local_inference_status");
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

/**
 * Value-free status of the opt-in that reads the Anthropic key from
 * `ANTHROPIC_API_KEY` (`ASHLR_MD_ANTHROPIC_KEY_FROM_ENV=1`). The key itself
 * never leaves Rust; this only says whether it is on and usable.
 */
export interface AnthropicEnvKeyStatus {
  /** The opt-in is on, so the Settings key is not used. */
  enabled: boolean;
  /** The environment key passes the rules. */
  usable: boolean;
  /** The key is a `phm_` placeholder from `phantom exec`. */
  placeholder: boolean;
  /** Why it cannot be used, when it cannot. Never contains the key. */
  problem: string | null;
}

/** Ask Rust for {@link AnthropicEnvKeyStatus}; null outside Tauri or on error. */
export async function anthropicEnvKeyStatus(): Promise<AnthropicEnvKeyStatus | null> {
  try {
    const s = (await invoke("anthropic_env_key_status")) as
      | Partial<AnthropicEnvKeyStatus>
      | null
      | undefined;
    if (!s || typeof s !== "object" || typeof s.enabled !== "boolean") return null;
    return {
      enabled: s.enabled,
      usable: s.usable === true,
      placeholder: s.placeholder === true,
      problem: typeof s.problem === "string" ? s.problem : null,
    };
  } catch {
    return null;
  }
}

/**
 * Ask whether a hosted (Tier 3) bearer token has been stored (via aiStore).
 * Purely a local in-memory check — the token is loaded from the OS keychain
 * at startup via `loadHostedToken()`.
 */
export function detectHostedToken(): string | null {
  return useAIStore.getState().hostedToken ?? null;
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
  const requestId = uniqueId("", 12);
  const tier = PROVIDER_TIER[providerId] ?? 1;
  const startMs = Date.now();

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
        recordSuccess(providerId, tier, Date.now() - startMs);
        resolve();
      }),
      listen<ErrorPayload>("ai://error", (e) => {
        if (e.payload.requestId !== requestId) return;
        cleanup();
        recordFailure(providerId, tier);
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
          recordAbort(providerId, tier);
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }

        signal?.addEventListener("abort", () => {
          cleanup();
          recordAbort(providerId, tier);
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
        recordFailure(providerId, tier);
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
  const requestId = uniqueId("", 12);
  const providerId = "apple-fm";
  const tier = PROVIDER_TIER[providerId];
  const startMs = Date.now();

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
        recordSuccess(providerId, tier, Date.now() - startMs);
        resolve();
      }),
      listen<ErrorPayload>("ai://error", (e) => {
        if (e.payload.requestId !== requestId) return;
        cleanup();
        recordFailure(providerId, tier);
        reject(new Error(e.payload.error));
      }),
    ])
      .then(([ul1, ul2, ul3]) => {
        unlistenDelta = ul1;
        unlistenDone = ul2;
        unlistenError = ul3;

        if (signal?.aborted) {
          cleanup();
          recordAbort(providerId, tier);
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          cleanup();
          recordAbort(providerId, tier);
          reject(new DOMException("Aborted", "AbortError"));
        });

        return invoke("afm_generate", {
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          requestId,
        });
      })
      .catch((err) => {
        cleanup();
        recordFailure(providerId, tier);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}
