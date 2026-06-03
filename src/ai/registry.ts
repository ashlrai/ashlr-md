// Provider registry — builds the provider chain and returns the first
// available provider.  Order: Tier 0 (Apple FM stub) → Tier 1 (Ollama) →
// Tier 2 (Anthropic BYO key) → Tier 3 (hosted stub) → NoOp.

import {
  afmGenerateStream,
  aiGenerateStream,
  detectAfm,
  detectAnthropicKey,
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
// Tier 3 — Hosted / premium endpoint (STUB)
// TODO: activate once the hosted endpoint is live and users have tokens.
//       Endpoint: POST https://api.mdopener.app/v1/chat
//       Auth: Bearer token stored alongside apiKey in aiStore.
// ---------------------------------------------------------------------------

class HostedProvider implements AIProvider {
  readonly id = "hosted";
  readonly capabilities: AICapabilities = {
    tier: 3,
    modelName: "Ashlr MD Cloud",
    isLocal: false,
    isFree: false,
    streaming: true,
  };

  async isAvailable(): Promise<boolean> {
    // TODO: check for a bearer token in aiStore / localStorage.
    return false;
  }

  async *generate(
    _messages: AIMessage[],
    _opts: { signal?: AbortSignal },
  ): AsyncGenerator<string> {
    throw new Error("Hosted provider is not yet active.");
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
      if (await provider.isAvailable()) return provider;
    } catch {
      // A detection error is non-fatal — try the next tier.
    }
  }
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
