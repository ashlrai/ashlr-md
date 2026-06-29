// Selection action presets — maps a named action to a system prompt + user
// message template.  Used by SelectionPopover and AISidebar quick buttons.

import type { AIMessage } from "./types";

// ---------------------------------------------------------------------------
// Streaming action API
// ---------------------------------------------------------------------------

export interface StreamingActionOptions {
  /** The selected text (or document content) to transform. */
  text: string;
  /** Which action preset to run. */
  actionId: ActionId;
  /** Optional extra arg forwarded to buildMessages (e.g. target language). */
  arg?: string;
  /** AbortSignal — cancels the stream and rejects the returned AsyncIterable. */
  signal?: AbortSignal;
}

/**
 * Build the messages for an action and return them alongside metadata.
 * Allows callers to feed messages into their own streaming pipeline.
 */
export function buildActionMessages(
  actionId: ActionId,
  text: string,
  arg?: string,
): AIMessage[] {
  const action = AI_ACTIONS.find((a) => a.id === actionId);
  if (!action) throw new Error(`Unknown AI action: ${actionId}`);
  return action.buildMessages(text, arg);
}

/**
 * Create an AsyncIterable<string> that yields token chunks from a provider's
 * generate() method for the given action + text.
 *
 * The caller drives consumption; aborting via `signal` causes the iterator to
 * throw a DOMException("AbortError") at the next `await` point.
 *
 * This is a thin wrapper: actual streaming happens in the provider passed in.
 */
export async function* streamAction(
  generate: (
    messages: AIMessage[],
    opts: { signal?: AbortSignal },
  ) => AsyncGenerator<string>,
  opts: StreamingActionOptions,
): AsyncGenerator<string> {
  const { text, actionId, arg, signal } = opts;

  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const messages = buildActionMessages(actionId, text, arg);

  for await (const chunk of generate(messages, { signal })) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    yield chunk;
  }
}

// ---------------------------------------------------------------------------
// Action definitions
// ---------------------------------------------------------------------------

export type ActionId =
  | "explain"
  | "summarize"
  | "rewrite"
  | "translate"
  | "tldr"
  | "fix-grammar"
  | "concise"
  | "expand"
  | "explain-diff";

export interface AIAction {
  id: ActionId;
  label: string;
  /** Short label for toolbar buttons */
  shortLabel: string;
  /** Emoji/icon hint for display */
  icon: string;
  /** Build the messages array from selected text (and optional extra args) */
  buildMessages(text: string, arg?: string): AIMessage[];
}

// ---------------------------------------------------------------------------
// Helper to build a minimal two-message conversation
// ---------------------------------------------------------------------------

function msg(system: string, user: string): AIMessage[] {
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---------------------------------------------------------------------------
// The action catalogue
// ---------------------------------------------------------------------------

export const AI_ACTIONS: AIAction[] = [
  {
    id: "explain",
    label: "Explain",
    shortLabel: "Explain",
    icon: "💡",
    buildMessages(text) {
      return msg(
        "You are a clear, concise technical explainer. " +
          "Explain the provided text in plain language. " +
          "Be thorough but avoid padding. Use markdown where helpful.",
        `Explain the following:\n\n${text}`,
      );
    },
  },

  {
    id: "summarize",
    label: "Summarize",
    shortLabel: "Summarize",
    icon: "📝",
    buildMessages(text) {
      return msg(
        "You are an expert at summarizing text. " +
          "Produce a concise bullet-point summary capturing the key points. " +
          "Use markdown bullet points.",
        `Summarize the following:\n\n${text}`,
      );
    },
  },

  {
    id: "rewrite",
    label: "Rewrite (clearer)",
    shortLabel: "Rewrite",
    icon: "✏️",
    buildMessages(text) {
      return msg(
        "You are an expert editor. Rewrite the provided text to be clearer " +
          "and more concise while preserving the original meaning and voice. " +
          "Output only the rewritten text — no commentary, no preamble.",
        `Rewrite the following text to be clearer and more concise:\n\n${text}`,
      );
    },
  },

  {
    id: "fix-grammar",
    label: "Fix grammar",
    shortLabel: "Fix",
    icon: "✓",
    buildMessages(text) {
      return msg(
        "You are a meticulous copy editor. Correct spelling, grammar, " +
          "punctuation, and obvious typos in the provided text. Preserve the " +
          "original meaning, tone, wording, and any Markdown formatting. " +
          "Output only the corrected text — no commentary, no preamble.",
        `Fix the grammar and spelling in the following text:\n\n${text}`,
      );
    },
  },

  {
    id: "concise",
    label: "Make concise",
    shortLabel: "Concise",
    icon: "✂️",
    buildMessages(text) {
      return msg(
        "You are an expert editor who tightens prose. Make the provided text " +
          "more concise — remove redundancy and filler while preserving the " +
          "meaning, key facts, voice, and any Markdown formatting. " +
          "Output only the rewritten text — no commentary, no preamble.",
        `Make the following text more concise:\n\n${text}`,
      );
    },
  },

  {
    id: "expand",
    label: "Expand",
    shortLabel: "Expand",
    icon: "➕",
    buildMessages(text) {
      return msg(
        "You are an expert writer. Expand the provided text with helpful " +
          "detail, clarification, and supporting points while keeping the " +
          "original meaning, voice, and any Markdown formatting. Do not invent " +
          "facts. Output only the expanded text — no commentary, no preamble.",
        `Expand the following text with more detail:\n\n${text}`,
      );
    },
  },

  {
    id: "explain-diff",
    label: "Explain changes",
    shortLabel: "Explain changes",
    icon: "🔀",
    // `text` is the version currently in the editor; `arg` is the on-disk
    // version that changed underneath it. We ask the model to explain the
    // difference between the two.
    buildMessages(text, arg = "") {
      return msg(
        "You are a precise technical reviewer. The user has a document open " +
          "with unsaved edits, and the same file changed on disk underneath " +
          "them. You will be given both versions. Explain, in clear bullet " +
          "points, what changed on disk relative to their in-editor version — " +
          "focus on substantive content differences, not whitespace. Be " +
          "concise and use Markdown.",
        "MY CURRENT VERSION (in the editor):\n\n" +
          "```\n" +
          `${text}\n` +
          "```\n\n" +
          "VERSION ON DISK (changed underneath me):\n\n" +
          "```\n" +
          `${arg}\n` +
          "```\n\n" +
          "Explain what changed on disk compared to my current version.",
      );
    },
  },

  {
    id: "translate",
    label: "Translate",
    shortLabel: "Translate",
    icon: "🌐",
    buildMessages(text, arg = "Spanish") {
      return msg(
        `You are a professional translator. Translate the provided text into ${arg}. ` +
          "Output only the translation — no commentary, no preamble.",
        `Translate the following into ${arg}:\n\n${text}`,
      );
    },
  },

  {
    id: "tldr",
    label: "TL;DR",
    shortLabel: "TL;DR",
    icon: "⚡",
    buildMessages(text) {
      return msg(
        "You are an expert at distilling information. " +
          "Produce a single punchy TL;DR sentence (max 2 sentences) that " +
          "captures the essential point of the text.",
        `Write a TL;DR for the following:\n\n${text}`,
      );
    },
  },
];

/** Look up an action by id (throws if not found — should never happen). */
export function getAction(id: ActionId): AIAction {
  const action = AI_ACTIONS.find((a) => a.id === id);
  if (!action) throw new Error(`Unknown AI action: ${id}`);
  return action;
}

// ---------------------------------------------------------------------------
// Document-level action presets (for the AISidebar quick buttons)
// These accept the full document content instead of a selection.
// ---------------------------------------------------------------------------

export interface DocAction {
  id: string;
  label: string;
  icon: string;
  buildMessages(docContent: string): AIMessage[];
}

export const DOC_ACTIONS: DocAction[] = [
  {
    id: "doc-summarize",
    label: "Summarize doc",
    icon: "📝",
    buildMessages(docContent) {
      return msg(
        "You are an expert at summarizing Markdown documents. " +
          "Produce a concise bullet-point summary of the key points. " +
          "Use markdown bullet points. Be helpful and thorough.",
        `Summarize this document:\n\n${docContent}`,
      );
    },
  },
  {
    id: "doc-outline",
    label: "Outline",
    icon: "📋",
    buildMessages(docContent) {
      return msg(
        "You are an expert document analyst. " +
          "Produce a structured outline of the document as a nested markdown list " +
          "reflecting the heading hierarchy. Include one brief sentence per section " +
          "describing its content.",
        `Generate an outline for this document:\n\n${docContent}`,
      );
    },
  },
  {
    id: "doc-explain-selection",
    label: "Explain selection",
    icon: "💡",
    buildMessages(docContent) {
      return msg(
        "You are a clear, concise technical explainer grounded in the document context. " +
          "The user will provide selected text. Explain it in plain language, " +
          "referencing the surrounding document for context as needed.",
        `The document context:\n\n${docContent}`,
      );
    },
  },
];
