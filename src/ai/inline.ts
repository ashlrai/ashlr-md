// Inline AI transforms — the shared engine behind the editors' in-place
// "AI superpowers". Resolves the active provider, builds messages from an
// action preset, streams the completion, and returns the final text.
//
// Used by both the CodeMirror source editor and the Milkdown WYSIWYG editor
// so transform behaviour (provider resolution, prompts, abort handling) stays
// identical across both surfaces.

import { type ActionId, getAction } from "./actions";
import { detectProvider, NOOP_PROVIDER_ID, runSelectionAction } from "./registry";

/**
 * How long the editors' Retry button waits before it reruns a failed
 * transform. Only one retry is offered, so the pause is a constant.
 */
export const INLINE_RETRY_DELAY_MS = 500;

export class NoProviderError extends Error {
  constructor() {
    super("No AI provider is available.");
    this.name = "NoProviderError";
  }
}

export interface InlineTransformOptions {
  /** The selected text to transform. */
  text: string;
  /** Which action preset to run (e.g. "rewrite", "fix-grammar"). */
  actionId: ActionId;
  /** Optional extra argument forwarded to the action builder (e.g. language). */
  arg?: string;
  /** Called with each streamed delta so the caller can render progress. */
  onDelta?: (delta: string) => void;
  /** Abort the underlying stream (Esc / unmount). */
  signal?: AbortSignal;
}

/**
 * Run an inline transform over `text` and resolve with the final string.
 *
 * Throws:
 *  - {@link NoProviderError} when no AI provider is configured/available, so
 *    callers can show a friendly "set up AI" hint instead of mangling text.
 *  - DOMException("AbortError") when aborted via `signal`.
 *  - Error(...) on any provider/stream failure.
 *
 * Never returns partial junk: callers should only commit the result on a clean
 * resolve, leaving the original text untouched on throw.
 */
export async function runInlineTransform(
  opts: InlineTransformOptions,
): Promise<string> {
  const { text, actionId, arg, onDelta, signal } = opts;

  const provider = await detectProvider();
  if (!provider || provider.id === NOOP_PROVIDER_ID) {
    throw new NoProviderError();
  }

  const action = getAction(actionId);
  const messages = action.buildMessages(text, arg);

  let result = "";
  await runSelectionAction(
    provider,
    messages,
    (delta) => {
      result += delta;
      onDelta?.(delta);
    },
    signal,
  );

  return result.trim();
}
