// Provider registry — builds the provider chain and returns the first
// available provider.  Order: Tier 0 (Apple FM stub) → Tier 1 (Ollama) →
// Tier 2 (Anthropic BYO key) → Tier 3 (hosted stub) → NoOp.

import {
  afmGenerateStream,
  aiGenerateStream,
  detectAfm,
  detectAnthropicKey,
  detectHostedToken,
  detectOllama,
} from "./bridge";
import type { AICapabilities, AIMessage, AIProvider } from "./types";

// ---------------------------------------------------------------------------
// Tier 0 — Apple Foundation Models (on-device, macOS 26+, free & private)
// Backed by the mdopener-afm Swift sidecar via afm_detect / afm_generate.
// Falls through gracefully on older macOS or when the sidecar is unavailable.
// ---------------------------------------------------------------------------

class AppleFMProvider implements AIProvider {
  readonly id = "apple-fm";
  private _modelName = "Apple Foundation Models";

  get capabilities(): AICapabilities {
    return {
      tier: 0,
      modelName: this._modelName,
      isLocal: true,
      isFree: true,
      streaming: true,
    };
  }

  async isAvailable(): Promise<boolean> {
    const model = await detectAfm();
    if (model) {
      this._modelName = model;
      return true;
    }
    return false;
  }

  async *generate(
    messages: AIMessage[],
    opts: { signal?: AbortSignal },
  ): AsyncGenerator<string> {
    const deltas: string[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let error: Error | null = null;

    const flush = () => resolve?.();

    afmGenerateStream(
      messages,
      (delta) => {
        deltas.push(delta);
        flush();
      },
      opts.signal,
    )
      .then(() => {
        done = true;
        flush();
      })
      .catch((e) => {
        error = e instanceof Error ? e : new Error(String(e));
        done = true;
        flush();
      });

    while (true) {
      if (deltas.length > 0) {
        yield deltas.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((r) => {
        resolve = r;
      });
      resolve = null;
    }
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — Ollama (local, free)
// ---------------------------------------------------------------------------

// Model selection happens in Rust (ai_detect_ollama returns the best installed
// model), so no preferred-list is needed here.

class OllamaProvider implements AIProvider {
  readonly id = "ollama";
  private _model: string | null = null;

  get capabilities(): AICapabilities {
    return {
      tier: 1,
      modelName: this._model ?? "ollama",
      isLocal: true,
      isFree: true,
      streaming: true,
    };
  }

  async isAvailable(): Promise<boolean> {
    const model = await detectOllama();
    if (model) {
      this._model = model;
      return true;
    }
    return false;
  }

  async *generate(
    messages: AIMessage[],
    opts: { signal?: AbortSignal },
  ): AsyncGenerator<string> {
    if (!this._model) throw new Error("Ollama: no model detected");
    const deltas: string[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let error: Error | null = null;

    const flush = () => resolve?.();

    const streamPromise = aiGenerateStream(
      "ollama",
      this._model,
      null,
      messages,
      (delta) => {
        deltas.push(delta);
        flush();
      },
      opts.signal,
    );

    streamPromise
      .then(() => {
        done = true;
        flush();
      })
      .catch((e) => {
        error = e instanceof Error ? e : new Error(String(e));
        done = true;
        flush();
      });

    while (true) {
      if (deltas.length > 0) {
        yield deltas.shift()!;
        continue;
      }
      if (done) break;
      // Wait for the next delta or completion.
      await new Promise<void>((r) => {
        resolve = r;
      });
      resolve = null;
    }
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------------
// Tier 2 — Anthropic (bring-your-own key)
// ---------------------------------------------------------------------------

// Easy to change the default model in one place.
export const ANTHROPIC_MODEL = "claude-haiku-4-5";

class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  private _key: string | null = null;

  get capabilities(): AICapabilities {
    return {
      tier: 2,
      modelName: ANTHROPIC_MODEL,
      isLocal: false,
      isFree: false,
      streaming: true,
    };
  }

  async isAvailable(): Promise<boolean> {
    this._key = detectAnthropicKey();
    return !!this._key;
  }

  async *generate(
    messages: AIMessage[],
    opts: { signal?: AbortSignal },
  ): AsyncGenerator<string> {
    const key = this._key ?? detectAnthropicKey();
    if (!key) throw new Error("Anthropic: no API key configured");

    const deltas: string[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let error: Error | null = null;

    const flush = () => resolve?.();

    const streamPromise = aiGenerateStream(
      "anthropic",
      ANTHROPIC_MODEL,
      key,
      messages,
      (delta) => {
        deltas.push(delta);
        flush();
      },
      opts.signal,
    );

    streamPromise
      .then(() => {
        done = true;
        flush();
      })
      .catch((e) => {
        error = e instanceof Error ? e : new Error(String(e));
        done = true;
        flush();
      });

    while (true) {
      if (deltas.length > 0) {
        yield deltas.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((r) => {
        resolve = r;
      });
      resolve = null;
    }
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------------
// Tier 3 — Hosted / premium endpoint
// Endpoint: POST https://api.mdopener.app/v1/chat
// Auth: Bearer token stored in aiStore.hostedToken (OS keychain source of truth).
// Protocol: standard OpenAI-compatible chat completion with SSE streaming.
// ---------------------------------------------------------------------------

export const HOSTED_API_URL = "https://api.mdopener.app/v1/chat";

class HostedProvider implements AIProvider {
  readonly id = "hosted";
  private _token: string | null = null;

  get capabilities(): AICapabilities {
    return {
      tier: 3,
      modelName: "Ashlr MD Cloud",
      isLocal: false,
      isFree: false,
      streaming: true,
    };
  }

  async isAvailable(): Promise<boolean> {
    const token = detectHostedToken();
    if (token) {
      this._token = token;
      return true;
    }
    this._token = null;
    return false;
  }

  async *generate(
    messages: AIMessage[],
    opts: { signal?: AbortSignal },
  ): AsyncGenerator<string> {
    // Always re-read from the store — never use the stale instance cache.
    // This ensures that if the user removes the token after isAvailable() ran,
    // generation correctly refuses rather than using the old cached value.
    const token = detectHostedToken();
    if (!token) throw new Error("Hosted provider: no bearer token configured");

    const response = await fetch(HOSTED_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
      signal: opts.signal,
    });

    if (response.status === 401) {
      throw new Error("Hosted provider: invalid or expired token (401)");
    }
    if (!response.ok) {
      throw new Error(`Hosted provider: request failed with status ${response.status}`);
    }

    const body = response.body;
    if (!body) throw new Error("Hosted provider: empty response body");

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        // Honour abort between chunks.
        if (opts.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines from the buffer.
        const lines = buffer.split("\n");
        // Keep the last (potentially incomplete) chunk in the buffer.
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === ": keep-alive") continue;
          if (!trimmed.startsWith("data:")) continue;

          const data = trimmed.slice("data:".length).trim();
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // Malformed SSE line — skip silently.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Tier ∅ — NoOp sentinel (no providers available)
// ---------------------------------------------------------------------------

class NoOpProvider implements AIProvider {
  readonly id = "noop";
  readonly capabilities: AICapabilities = {
    tier: 1, // Displayed only as fallback; UI checks id === "noop" separately.
    modelName: "None",
    isLocal: true,
    isFree: true,
    streaming: false,
  };

  async isAvailable(): Promise<boolean> {
    return true; // Always available as the final fallback.
  }

  async *generate(
    _messages: AIMessage[],
    _opts: { signal?: AbortSignal },
  ): AsyncGenerator<string> {
    yield "No AI provider is available. Install Ollama or add an Anthropic API key.";
  }
}

// ---------------------------------------------------------------------------
// Singleton provider instances (re-used across calls so detection is cached)
// ---------------------------------------------------------------------------

const PROVIDERS: AIProvider[] = [
  new AppleFMProvider(),
  new OllamaProvider(),
  new AnthropicProvider(),
  new HostedProvider(),
];

const NOOP = new NoOpProvider();

/**
 * The most recently resolved provider, cached so the sidebar can render the
 * right state instantly instead of showing a "Detecting…" wall on every open.
 * Warmed once at startup (see App.tsx).
 */
let cachedProvider: AIProvider | null = null;

/** The last resolved provider, or null if detection hasn't run yet. */
export function getCachedProvider(): AIProvider | null {
  return cachedProvider;
}

// ---------------------------------------------------------------------------
// detectProvider — runs the chain and returns the first available provider
// ---------------------------------------------------------------------------

/**
 * Walk the provider chain in priority order and return the first one that
 * reports isAvailable() === true.  Falls through to NoOp if none do.
 *
 * Called once at sidebar open (and can be re-called to re-probe, e.g. after
 * the user enters an API key).
 */
export async function detectProvider(): Promise<AIProvider> {
  for (const provider of PROVIDERS) {
    try {
      if (await provider.isAvailable()) {
        cachedProvider = provider;
        return provider;
      }
    } catch {
      // A detection error is non-fatal — try the next tier.
    }
  }
  cachedProvider = NOOP;
  return NOOP;
}

// Re-export NoOp id so callers can check for the "no provider" state.
export const NOOP_PROVIDER_ID = NOOP.id;

// ---------------------------------------------------------------------------
// runSelectionAction — convenience runner used by SelectionPopover
// ---------------------------------------------------------------------------

/**
 * Run an action (from actions.ts) against a provider and collect the full
 * response as a string (for popover display).  For chat-style streaming use
 * the provider's generate() iterator directly.
 */
export async function runSelectionAction(
  provider: AIProvider,
  messages: AIMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  for await (const delta of provider.generate(messages, { signal })) {
    onDelta(delta);
  }
}
