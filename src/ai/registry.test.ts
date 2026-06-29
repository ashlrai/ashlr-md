// Tests for the HostedProvider (Tier 3) implementation in registry.ts.
//
// All tests run in happy-dom (vitest env). The OS-keychain invoke and Tauri
// event bridge are mocked so these tests run without a Tauri runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/core and @tauri-apps/api/event before any imports that
// pull them in transitively (aiStore → invoke, bridge → listen).
// ---------------------------------------------------------------------------

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// ---------------------------------------------------------------------------
// Now import the modules under test.
// ---------------------------------------------------------------------------

import { useAIStore } from "../store/aiStore";
import { HOSTED_API_URL, detectProvider, NOOP_PROVIDER_ID } from "./registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset the aiStore to a clean state between tests. */
function resetStore() {
  useAIStore.setState({
    open: false,
    provider: null,
    providerId: null,
    messages: [],
    busy: false,
    apiKey: null,
    hostedToken: null,
    preferredTier: null,
    libraryScope: false,
  });
}

/** Build a minimal SSE stream from an array of text deltas. */
function makeSSEStream(deltas: string[], status = 200): Response {
  const lines: string[] = deltas
    .map((d) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`,
    )
    .concat(["data: [DONE]\n\n"]);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });

  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

/** Build a plain (non-streaming) error Response. */
function makeErrorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: "fail" }), { status });
}

// ---------------------------------------------------------------------------
// Token detection + isAvailable()
// ---------------------------------------------------------------------------

describe("HostedProvider — token detection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStore();
  });

  it("isAvailable() returns false when hostedToken is null", async () => {
    // No token in store → hosted provider not available.
    const provider = await detectProvider();
    // The full chain falls through: AFM (no Tauri), Ollama (no Tauri), Anthropic (no key),
    // Hosted (no token) → NoOp.
    expect(provider.id).toBe(NOOP_PROVIDER_ID);
  });

  it("isAvailable() returns true when hostedToken is set", async () => {
    // Plant a hosted token in the store (simulates startup loadHostedToken).
    useAIStore.setState({ hostedToken: "tok-test-abc123" });

    const provider = await detectProvider();
    expect(provider.id).toBe("hosted");
    expect(provider.capabilities.tier).toBe(3);
  });

  it("hosted provider is chosen over noop when only token is present (no Anthropic key)", async () => {
    useAIStore.setState({ hostedToken: "tok-xyz", apiKey: null });
    const provider = await detectProvider();
    expect(provider.id).toBe("hosted");
  });

  it("Anthropic (tier 2) wins over hosted (tier 3) when both keys are present", async () => {
    useAIStore.setState({ hostedToken: "tok-xyz", apiKey: "sk-ant-key" });
    const provider = await detectProvider();
    // Anthropic is earlier in the chain (tier 2 < tier 3).
    expect(provider.id).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// generate() — streaming success
// ---------------------------------------------------------------------------

describe("HostedProvider — generate() streaming", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStore();
    useAIStore.setState({ hostedToken: "tok-stream-test" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("yields all delta tokens from a successful SSE stream", async () => {
    const deltas = ["Hello", ", ", "world", "!"];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeSSEStream(deltas));

    const provider = await detectProvider();
    expect(provider.id).toBe("hosted");

    const collected: string[] = [];
    for await (const chunk of provider.generate(
      [{ role: "user", content: "hi" }],
      {},
    )) {
      collected.push(chunk);
    }

    expect(collected).toEqual(deltas);
  });

  it("sends correct Authorization header and JSON body", async () => {
    const deltas = ["ok"];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeSSEStream(deltas));

    const provider = await detectProvider();
    const messages = [{ role: "user" as const, content: "test" }];
    // Consume the generator.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of provider.generate(messages, {})) {
      /* drain */
    }

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HOSTED_API_URL);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer tok-stream-test",
    );
    const body = JSON.parse(init.body as string) as {
      messages: unknown[];
      stream: boolean;
    };
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(1);
  });

  it("completes cleanly even when [DONE] is the only SSE line", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(body, { status: 200 }),
    );

    const provider = await detectProvider();
    const chunks: string[] = [];
    for await (const c of provider.generate([{ role: "user", content: "x" }], {})) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generate() — error handling
// ---------------------------------------------------------------------------

describe("HostedProvider — generate() error handling", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStore();
    useAIStore.setState({ hostedToken: "tok-err-test" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws with a 401 message when the token is invalid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeErrorResponse(401));

    const provider = await detectProvider();
    await expect(async () => {
      for await (const _ of provider.generate([{ role: "user", content: "x" }], {})) {
        /* drain */
      }
    }).rejects.toThrow(/401/);
  });

  it("throws with the status code on generic HTTP errors (e.g. 500)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeErrorResponse(500));

    const provider = await detectProvider();
    await expect(async () => {
      for await (const _ of provider.generate([{ role: "user", content: "x" }], {})) {
        /* drain */
      }
    }).rejects.toThrow(/500/);
  });

  it("throws when no token is set at generate time", async () => {
    // Clear the token after isAvailable() has already cached it.
    const provider = await detectProvider();
    // Remove the token from the store so generate() can't find it.
    useAIStore.setState({ hostedToken: null });

    await expect(async () => {
      for await (const _ of provider.generate([{ role: "user", content: "x" }], {})) {
        /* drain */
      }
    }).rejects.toThrow(/no bearer token/i);
  });
});

// ---------------------------------------------------------------------------
// generate() — abort signal
// ---------------------------------------------------------------------------

describe("HostedProvider — generate() abort", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStore();
    useAIStore.setState({ hostedToken: "tok-abort-test" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("propagates an AbortError when signal is aborted before fetch returns", async () => {
    const controller = new AbortController();

    // fetch will reject with an AbortError (mimicking browser behaviour).
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("Aborted", "AbortError"),
    );

    controller.abort();

    const provider = await detectProvider();
    await expect(async () => {
      for await (const _ of provider.generate([{ role: "user", content: "x" }], {
        signal: controller.signal,
      })) {
        /* drain */
      }
    }).rejects.toThrow(/Aborted/);
  });

  it("stops yielding and throws AbortError when signal fires mid-stream", async () => {
    const controller = new AbortController();

    // Stream that emits a few chunks then stalls — we abort in between.
    let enqueueMore: (() => void) | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const enc = new TextEncoder();
        // First chunk.
        ctrl.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}\n\n`,
          ),
        );
        // Register a callback to push more data (or close) later.
        enqueueMore = () => {
          ctrl.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "B" } }] })}\n\n`,
            ),
          );
          ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
          ctrl.close();
        };
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(body, { status: 200 }),
    );

    const provider = await detectProvider();
    const chunks: string[] = [];

    // Abort after the first yielded chunk.
    const gen = provider.generate([{ role: "user", content: "x" }], {
      signal: controller.signal,
    });

    const first = await gen.next();
    expect(first.value).toBe("A");
    chunks.push(first.value as string);

    // Abort now, then let the stream continue pushing data.
    controller.abort();
    enqueueMore?.();

    // The generator should throw an AbortError on the next read.
    await expect(gen.next()).rejects.toThrow(/Aborted/);
  });
});

// ---------------------------------------------------------------------------
// aiStore — hostedToken lifecycle
// ---------------------------------------------------------------------------

describe("aiStore — hostedToken lifecycle", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStore();
  });

  it("setHostedToken stores token in memory and calls set_ai_key", () => {
    invokeMock.mockResolvedValue(undefined);
    useAIStore.getState().setHostedToken("tok-abc");
    expect(useAIStore.getState().hostedToken).toBe("tok-abc");
    expect(invokeMock).toHaveBeenCalledWith("set_ai_key", {
      account: "hosted",
      key: "tok-abc",
    });
  });

  it("setHostedToken(null) clears memory and calls delete_ai_key", () => {
    invokeMock.mockResolvedValue(undefined);
    useAIStore.getState().setHostedToken("tok-abc");
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    useAIStore.getState().setHostedToken(null);
    expect(useAIStore.getState().hostedToken).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("delete_ai_key", { account: "hosted" });
  });

  it("loadHostedToken reads token from keychain into memory", async () => {
    invokeMock.mockResolvedValue("tok-from-keychain");
    await useAIStore.getState().loadHostedToken();
    expect(useAIStore.getState().hostedToken).toBe("tok-from-keychain");
    expect(invokeMock).toHaveBeenCalledWith("get_ai_key", { account: "hosted" });
  });

  it("loadHostedToken is a no-op when keychain is unavailable", async () => {
    invokeMock.mockRejectedValue(new Error("keychain unavailable"));
    await expect(useAIStore.getState().loadHostedToken()).resolves.toBeUndefined();
    expect(useAIStore.getState().hostedToken).toBeNull();
  });

  it("loadHostedToken leaves token null when keychain returns null", async () => {
    invokeMock.mockResolvedValue(null);
    await useAIStore.getState().loadHostedToken();
    expect(useAIStore.getState().hostedToken).toBeNull();
  });
});
