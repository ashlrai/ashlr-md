// Registry tests for src/ai/actions.ts
//
// Validates that every AI_ACTION and DOC_ACTION entry is well-formed, that
// there are no duplicates, that buildMessages() returns valid message arrays,
// and that the catalogue stays in sync with the Rust list_ai_actions tool
// (same set of action ids — checked by name not by implementation).
//
// Also covers AbortSignal cancellation and abort behaviour for inline transforms
// (15 additional test cases added for the streaming cancellation + retry UX).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Tauri mocks — required by any module that transitively imports aiStore or
// the bridge (which calls invoke / listen from @tauri-apps/api).
// ---------------------------------------------------------------------------

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
import {
  AI_ACTIONS,
  DOC_ACTIONS,
  getAction,
  type AIAction,
  type ActionId,
} from "./actions";

// ---------------------------------------------------------------------------
// Constants — these must be updated if actions.ts changes
// ---------------------------------------------------------------------------

const EXPECTED_SELECTION_IDS: ActionId[] = [
  "explain",
  "summarize",
  "rewrite",
  "fix-grammar",
  "concise",
  "expand",
  "explain-diff",
  "translate",
  "tldr",
];

const EXPECTED_DOC_IDS = ["doc-summarize", "doc-outline", "doc-explain-selection"];

// ---------------------------------------------------------------------------
// AI_ACTIONS (selection-scoped)
// ---------------------------------------------------------------------------

describe("AI_ACTIONS catalogue", () => {
  it("contains exactly the expected 9 selection actions", () => {
    const ids = AI_ACTIONS.map((a) => a.id);
    expect(ids).toHaveLength(EXPECTED_SELECTION_IDS.length);
    for (const expected of EXPECTED_SELECTION_IDS) {
      expect(ids).toContain(expected);
    }
  });

  it("action ids are unique", () => {
    const ids = AI_ACTIONS.map((a) => a.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("every action has a non-empty label", () => {
    for (const action of AI_ACTIONS) {
      expect(action.label.length, `action '${action.id}' has empty label`).toBeGreaterThan(0);
    }
  });

  it("every action has a non-empty shortLabel", () => {
    for (const action of AI_ACTIONS) {
      expect(
        action.shortLabel.length,
        `action '${action.id}' has empty shortLabel`,
      ).toBeGreaterThan(0);
    }
  });

  it("every action has a non-empty icon", () => {
    for (const action of AI_ACTIONS) {
      expect(action.icon.length, `action '${action.id}' has empty icon`).toBeGreaterThan(0);
    }
  });

  it("every action has a buildMessages function", () => {
    for (const action of AI_ACTIONS) {
      expect(typeof action.buildMessages, `action '${action.id}' missing buildMessages`).toBe(
        "function",
      );
    }
  });

  // ── buildMessages output shape ────────────────────────────────────────────

  it("buildMessages returns exactly [system, user] messages", () => {
    const sampleText = "Hello world test content";
    for (const action of AI_ACTIONS) {
      const messages = action.buildMessages(sampleText);
      expect(messages, `action '${action.id}' should return array`).toBeInstanceOf(Array);
      expect(messages, `action '${action.id}' should return 2 messages`).toHaveLength(2);
      expect(messages[0].role, `action '${action.id}' first message must be system`).toBe(
        "system",
      );
      expect(messages[1].role, `action '${action.id}' second message must be user`).toBe("user");
    }
  });

  it("buildMessages includes the provided text in the user message", () => {
    const sampleText = "unique-marker-xyz-12345";
    for (const action of AI_ACTIONS) {
      // explain-diff and translate use arg differently; skip text check for them
      if (action.id === "explain-diff" || action.id === "translate") continue;
      const messages = action.buildMessages(sampleText);
      expect(
        messages[1].content,
        `action '${action.id}' user message must contain the input text`,
      ).toContain(sampleText);
    }
  });

  it("buildMessages system messages are non-empty", () => {
    for (const action of AI_ACTIONS) {
      const messages = action.buildMessages("any text");
      expect(
        messages[0].content.length,
        `action '${action.id}' system prompt must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("buildMessages user messages are non-empty", () => {
    for (const action of AI_ACTIONS) {
      const messages = action.buildMessages("any text");
      expect(
        messages[1].content.length,
        `action '${action.id}' user message must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  // ── Action-specific edge cases ────────────────────────────────────────────

  it("explain-diff uses arg as the on-disk version", () => {
    const editorVersion = "editor version content";
    const diskVersion = "disk version content";
    const messages = AI_ACTIONS.find((a) => a.id === "explain-diff")!.buildMessages(
      editorVersion,
      diskVersion,
    );
    expect(messages[1].content).toContain(editorVersion);
    expect(messages[1].content).toContain(diskVersion);
  });

  it("explain-diff with no arg still produces a valid message pair", () => {
    const messages = AI_ACTIONS.find((a) => a.id === "explain-diff")!.buildMessages(
      "editor content",
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("translate defaults to Spanish when no arg provided", () => {
    const messages = AI_ACTIONS.find((a) => a.id === "translate")!.buildMessages("hello");
    // Default arg is "Spanish" — both system and user prompt should mention it
    expect(messages[0].content).toContain("Spanish");
    expect(messages[1].content).toContain("Spanish");
  });

  it("translate uses the provided target language", () => {
    const messages = AI_ACTIONS.find((a) => a.id === "translate")!.buildMessages(
      "hello",
      "French",
    );
    expect(messages[0].content).toContain("French");
    expect(messages[1].content).toContain("French");
  });

  it("tldr produces a concise response prompt", () => {
    const messages = AI_ACTIONS.find((a) => a.id === "tldr")!.buildMessages("long content");
    // The system prompt should mention brevity
    expect(messages[0].content.toLowerCase()).toMatch(/tl;dr|sentence|concise|distill/);
  });
});

// ---------------------------------------------------------------------------
// DOC_ACTIONS (document-scoped)
// ---------------------------------------------------------------------------

describe("DOC_ACTIONS catalogue", () => {
  it("contains exactly the expected 3 document actions", () => {
    const ids = DOC_ACTIONS.map((a) => a.id);
    expect(ids).toHaveLength(EXPECTED_DOC_IDS.length);
    for (const expected of EXPECTED_DOC_IDS) {
      expect(ids).toContain(expected);
    }
  });

  it("doc action ids are unique", () => {
    const ids = DOC_ACTIONS.map((a) => a.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("every doc action has a non-empty label", () => {
    for (const action of DOC_ACTIONS) {
      expect(action.label.length, `doc action '${action.id}' has empty label`).toBeGreaterThan(0);
    }
  });

  it("every doc action has a non-empty icon", () => {
    for (const action of DOC_ACTIONS) {
      expect(action.icon.length, `doc action '${action.id}' has empty icon`).toBeGreaterThan(0);
    }
  });

  it("every doc action has a buildMessages function", () => {
    for (const action of DOC_ACTIONS) {
      expect(
        typeof action.buildMessages,
        `doc action '${action.id}' missing buildMessages`,
      ).toBe("function");
    }
  });

  it("doc buildMessages returns [system, user] messages", () => {
    const sampleDoc = "# Title\n\nContent paragraph.";
    for (const action of DOC_ACTIONS) {
      const messages = action.buildMessages(sampleDoc);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[1].role).toBe("user");
    }
  });

  it("doc buildMessages includes doc content in messages", () => {
    const sampleDoc = "unique-doc-marker-abc-99";
    for (const action of DOC_ACTIONS) {
      const messages = action.buildMessages(sampleDoc);
      // Either system or user message must include the doc content
      const combined = messages[0].content + messages[1].content;
      expect(
        combined,
        `doc action '${action.id}' messages must reference the document content`,
      ).toContain(sampleDoc);
    }
  });
});

// ---------------------------------------------------------------------------
// No id overlap between AI_ACTIONS and DOC_ACTIONS
// ---------------------------------------------------------------------------

describe("Action catalogue — cross-set integrity", () => {
  it("selection and document action ids do not overlap", () => {
    const selectionIds = new Set(AI_ACTIONS.map((a) => a.id));
    for (const docAction of DOC_ACTIONS) {
      expect(
        selectionIds.has(docAction.id as ActionId),
        `id '${docAction.id}' exists in both AI_ACTIONS and DOC_ACTIONS`,
      ).toBe(false);
    }
  });

  it("total action count is 12 (9 selection + 3 document)", () => {
    expect(AI_ACTIONS.length + DOC_ACTIONS.length).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// getAction() helper
// ---------------------------------------------------------------------------

describe("getAction()", () => {
  it("returns the correct action for each known id", () => {
    for (const id of EXPECTED_SELECTION_IDS) {
      const action: AIAction = getAction(id);
      expect(action.id).toBe(id);
    }
  });

  it("throws for an unknown id", () => {
    expect(() => getAction("nonexistent" as ActionId)).toThrow(/Unknown AI action/);
  });

  it("returned action is the same reference as in AI_ACTIONS", () => {
    const action = getAction("explain");
    expect(action).toBe(AI_ACTIONS.find((a) => a.id === "explain"));
  });
});

// ---------------------------------------------------------------------------
// AbortSignal / cancellation behaviour — 15 test cases
// These exercise runInlineTransform (inline.ts) and the provider contract
// (registry.ts) using mock providers that honour / ignore AbortSignal.
// ---------------------------------------------------------------------------

import { NoProviderError, runInlineTransform } from "./inline";
import { detectProvider, NOOP_PROVIDER_ID } from "./registry";
import type { AIProvider, AICapabilities, AIMessage } from "./types";

// ---------------------------------------------------------------------------
// Mock provider helpers
// ---------------------------------------------------------------------------

function makeProvider(
  id: string,
  generate: (messages: AIMessage[], opts: { signal?: AbortSignal }) => AsyncGenerator<string>,
): AIProvider {
  return {
    id,
    capabilities: {
      tier: 1,
      modelName: "mock",
      isLocal: true,
      isFree: true,
      streaming: true,
    } satisfies AICapabilities,
    isAvailable: async () => true,
    generate,
  };
}

/** A generator that yields tokens one at a time and checks the signal between each. */
async function* tokenGenerator(
  tokens: string[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  for (const t of tokens) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    yield t;
  }
}

/** A generator that throws immediately with the given error. */
async function* failingGenerator(err: Error): AsyncGenerator<string> {
  throw err;
  // unreachable — needed for TypeScript generator return type
  yield "";
}

/** A generator that never yields (simulates a hanging/slow provider). */
async function* hangingGenerator(signal?: AbortSignal): AsyncGenerator<string> {
  await new Promise<void>((_, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
  yield "";
}

// Mock detectProvider so inline.ts uses our mock instead of probing Tauri.
vi.mock("./registry", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./registry")>();
  return {
    ...orig,
    detectProvider: vi.fn(),
  };
});

const mockedDetectProvider = detectProvider as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Basic abort before generation starts
// ---------------------------------------------------------------------------
describe("AbortSignal cancellation — runInlineTransform", () => {
  it("1. throws AbortError when signal is already aborted before generate()", async () => {
    const controller = new AbortController();
    controller.abort();

    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", async function* (_msgs, opts) {
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        yield "never";
      }),
    );

    await expect(
      runInlineTransform({
        text: "hello",
        actionId: "rewrite",
        signal: controller.signal,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && e.name === "AbortError",
    );
  });

  // ---------------------------------------------------------------------------
  // 2. Abort mid-stream
  // ---------------------------------------------------------------------------
  it("2. stops mid-stream when signal is aborted after first token", async () => {
    const controller = new AbortController();
    const deltas: string[] = [];

    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", async function* (_msgs, opts) {
        yield "first";
        controller.abort(); // abort after yielding first token
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        yield "second"; // must not be reached
      }),
    );

    await expect(
      runInlineTransform({
        text: "hello",
        actionId: "rewrite",
        onDelta: (d) => deltas.push(d),
        signal: controller.signal,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && e.name === "AbortError",
    );

    // Only the first delta should have been emitted.
    expect(deltas).toEqual(["first"]);
  });

  // ---------------------------------------------------------------------------
  // 3. Successful generation with a signal that is never aborted
  // ---------------------------------------------------------------------------
  it("3. completes successfully when signal exists but is never aborted", async () => {
    const controller = new AbortController();

    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", (_msgs, opts) => tokenGenerator(["hello ", "world"], opts.signal)),
    );

    const result = await runInlineTransform({
      text: "test",
      actionId: "explain",
      signal: controller.signal,
    });

    expect(result).toBe("hello world");
  });

  // ---------------------------------------------------------------------------
  // 4. onDelta receives each token before abort
  // ---------------------------------------------------------------------------
  it("4. onDelta is called for each token yielded before abort", async () => {
    const controller = new AbortController();
    const received: string[] = [];

    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", async function* (_msgs, opts) {
        yield "a";
        yield "b";
        controller.abort();
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        yield "c";
      }),
    );

    await expect(
      runInlineTransform({
        text: "t",
        actionId: "summarize",
        onDelta: (d) => received.push(d),
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();

    expect(received).toContain("a");
    expect(received).toContain("b");
    expect(received).not.toContain("c");
  });

  // ---------------------------------------------------------------------------
  // 5. Network/provider error propagates as thrown Error
  // ---------------------------------------------------------------------------
  it("5. propagates a provider network error", async () => {
    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", () => failingGenerator(new Error("Network timeout"))),
    );

    await expect(
      runInlineTransform({ text: "x", actionId: "tldr" }),
    ).rejects.toThrow("Network timeout");
  });

  // ---------------------------------------------------------------------------
  // 6. Provider timeout simulated via hanging generator + abort
  // ---------------------------------------------------------------------------
  it("6. aborting a hanging provider resolves with AbortError", async () => {
    const controller = new AbortController();

    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", (_msgs, opts) => hangingGenerator(opts.signal)),
    );

    // Abort after a tick
    setTimeout(() => controller.abort(), 0);

    await expect(
      runInlineTransform({ text: "x", actionId: "concise", signal: controller.signal }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && e.name === "AbortError",
    );
  });

  // ---------------------------------------------------------------------------
  // 7. NoProviderError when no provider is available
  // ---------------------------------------------------------------------------
  it("7. throws NoProviderError when provider id is noop", async () => {
    mockedDetectProvider.mockResolvedValue({
      id: NOOP_PROVIDER_ID,
      capabilities: { tier: 1, modelName: "None", isLocal: true, isFree: true, streaming: false },
      isAvailable: async () => true,
      async *generate() { yield "noop"; },
    });

    await expect(
      runInlineTransform({ text: "x", actionId: "expand" }),
    ).rejects.toBeInstanceOf(NoProviderError);
  });

  // ---------------------------------------------------------------------------
  // 8. Result is trimmed
  // ---------------------------------------------------------------------------
  it("8. result string is trimmed of leading/trailing whitespace", async () => {
    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", () => tokenGenerator(["  ", "result", "  "])),
    );

    const result = await runInlineTransform({ text: "x", actionId: "fix-grammar" });
    expect(result).toBe("result");
  });

  // ---------------------------------------------------------------------------
  // 9. Multiple deltas accumulate into a single result
  // ---------------------------------------------------------------------------
  it("9. concatenates all deltas into the final result", async () => {
    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", () => tokenGenerator(["Hello", " ", "World", "!"])),
    );

    const result = await runInlineTransform({ text: "x", actionId: "rewrite" });
    expect(result).toBe("Hello World!");
  });

  // ---------------------------------------------------------------------------
  // 10. Signal is forwarded to the provider generate() call
  // ---------------------------------------------------------------------------
  it("10. AbortSignal is passed through to provider.generate()", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", async function* (_msgs, opts) {
        receivedSignal = opts.signal;
        yield "ok";
      }),
    );

    await runInlineTransform({ text: "x", actionId: "explain", signal: controller.signal });
    expect(receivedSignal).toBe(controller.signal);
  });

  // ---------------------------------------------------------------------------
  // 11. Aborting does not call onDelta after the abort
  // ---------------------------------------------------------------------------
  it("11. onDelta is NOT called after abort signal fires", async () => {
    const controller = new AbortController();
    const deltas: string[] = [];

    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", async function* (_msgs, opts) {
        yield "before";
        controller.abort();
        // Simulate provider checking signal and stopping cleanly
        if (opts.signal?.aborted) return;
        yield "after";
      }),
    );

    try {
      await runInlineTransform({
        text: "x",
        actionId: "summarize",
        onDelta: (d) => deltas.push(d),
        signal: controller.signal,
      });
    } catch {
      // expected
    }

    expect(deltas).not.toContain("after");
  });

  // ---------------------------------------------------------------------------
  // 12. Abort with no signal does not throw AbortError
  // ---------------------------------------------------------------------------
  it("12. running without a signal completes normally", async () => {
    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", () => tokenGenerator(["done"])),
    );

    await expect(
      runInlineTransform({ text: "x", actionId: "tldr" }),
    ).resolves.toBe("done");
  });

  // ---------------------------------------------------------------------------
  // 13. A second call after abort succeeds (abort is per-controller)
  // ---------------------------------------------------------------------------
  it("13. a fresh AbortController allows a new request to succeed after a previous abort", async () => {
    const c1 = new AbortController();
    c1.abort();

    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", async function* (_msgs, opts) {
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        yield "fresh";
      }),
    );

    // First call aborted
    await expect(
      runInlineTransform({ text: "x", actionId: "rewrite", signal: c1.signal }),
    ).rejects.toBeDefined();

    // Second call with fresh controller succeeds
    const c2 = new AbortController();
    const result = await runInlineTransform({
      text: "x",
      actionId: "rewrite",
      signal: c2.signal,
    });
    expect(result).toBe("fresh");
  });

  // ---------------------------------------------------------------------------
  // 14. Error message propagated verbatim
  // ---------------------------------------------------------------------------
  it("14. provider error message is propagated verbatim", async () => {
    const specificMsg = "rate limit exceeded (429)";
    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", () => failingGenerator(new Error(specificMsg))),
    );

    await expect(
      runInlineTransform({ text: "x", actionId: "explain" }),
    ).rejects.toThrow(specificMsg);
  });

  // ---------------------------------------------------------------------------
  // 15. Partial result is never returned on abort (throws instead)
  // ---------------------------------------------------------------------------
  it("15. a partial result is never returned — abort always throws", async () => {
    const controller = new AbortController();

    mockedDetectProvider.mockResolvedValue(
      makeProvider("mock", async function* (_msgs, _opts) {
        yield "partial";
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      }),
    );

    let resolved = false;
    await runInlineTransform({
      text: "x",
      actionId: "rewrite",
      signal: controller.signal,
    })
      .then(() => { resolved = true; })
      .catch(() => {});

    expect(resolved).toBe(false);
  });
});
