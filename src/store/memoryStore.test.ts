import { beforeEach, describe, expect, it } from "vitest";
import { memoryBlock, useMemoryStore, useConversationStore } from "./memoryStore";

beforeEach(() => {
  useMemoryStore.setState({ items: [] });
  useConversationStore.setState({ currentSessionId: null, messages: [] });
});

describe("memoryStore", () => {
  it("adds a trimmed item", () => {
    useMemoryStore.getState().add("  I like concise answers  ");
    const items = useMemoryStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("I like concise answers");
    expect(items[0].source).toBe("user");
  });

  it("ignores empty/whitespace text", () => {
    useMemoryStore.getState().add("   ");
    expect(useMemoryStore.getState().items).toHaveLength(0);
  });

  it("dedups identical facts", () => {
    const { add } = useMemoryStore.getState();
    add("TypeScript only");
    add("TypeScript only");
    expect(useMemoryStore.getState().items).toHaveLength(1);
  });

  it("removes by id and clears", () => {
    const { add } = useMemoryStore.getState();
    add("a");
    add("b");
    const id = useMemoryStore.getState().items[0].id;
    useMemoryStore.getState().remove(id);
    expect(useMemoryStore.getState().items).toHaveLength(1);
    useMemoryStore.getState().clear();
    expect(useMemoryStore.getState().items).toHaveLength(0);
  });

  it("memoryBlock is empty when no items, formatted otherwise", () => {
    expect(memoryBlock()).toBe("");
    useMemoryStore.getState().add("Project: Ashlr MD");
    const block = memoryBlock();
    expect(block).toContain("- Project: Ashlr MD");
    expect(block.toLowerCase()).toContain("about this user");
  });
});

// ── Conversation session store ─────────────────────────────────────────────────

describe("useConversationStore — session lifecycle", () => {
  it("startSession returns a stable id and sets currentSessionId", () => {
    const id = useConversationStore.getState().startSession();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(useConversationStore.getState().currentSessionId).toBe(id);
  });

  it("startSession with explicit id uses that id", () => {
    const id = useConversationStore.getState().startSession("my-session-42");
    expect(id).toBe("my-session-42");
    expect(useConversationStore.getState().currentSessionId).toBe("my-session-42");
  });

  it("startSession called twice replaces the currentSessionId", () => {
    useConversationStore.getState().startSession("first");
    const second = useConversationStore.getState().startSession("second");
    expect(useConversationStore.getState().currentSessionId).toBe(second);
  });

  it("appendMessage returns null when no session is active", () => {
    const msg = useConversationStore.getState().appendMessage("agent", "hello");
    expect(msg).toBeNull();
  });

  it("appendMessage adds a message to the active session", () => {
    useConversationStore.getState().startSession("s1");
    const msg = useConversationStore.getState().appendMessage("agent", "Step 1 done");
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("agent");
    expect(msg!.content).toBe("Step 1 done");
    expect(msg!.sessionId).toBe("s1");
  });

  it("appendMessage trims whitespace from content", () => {
    useConversationStore.getState().startSession("s2");
    const msg = useConversationStore.getState().appendMessage("human", "  approved  ");
    expect(msg!.content).toBe("approved");
  });

  it("appendMessage records citedDocs", () => {
    useConversationStore.getState().startSession("s3");
    const msg = useConversationStore.getState().appendMessage(
      "agent",
      "Rewrote intro",
      ["/docs/intro.md"],
    );
    expect(msg!.citedDocs).toEqual(["/docs/intro.md"]);
  });

  it("appendMessage assigns a unique id and timestampMs", () => {
    useConversationStore.getState().startSession("s4");
    const a = useConversationStore.getState().appendMessage("agent", "a");
    const b = useConversationStore.getState().appendMessage("human", "b");
    expect(a!.id).not.toBe(b!.id);
    expect(a!.timestampMs).toBeGreaterThan(0);
    expect(b!.timestampMs).toBeGreaterThan(0);
  });

  it("getContext returns the last N messages for the active session", () => {
    useConversationStore.getState().startSession("ctx");
    useConversationStore.getState().appendMessage("system", "doc: /a.md");
    useConversationStore.getState().appendMessage("agent", "Summarised");
    useConversationStore.getState().appendMessage("human", "Looks good");
    const ctx = useConversationStore.getState().getContext(2);
    expect(ctx).toHaveLength(2);
    expect(ctx[0].content).toBe("Summarised");
    expect(ctx[1].content).toBe("Looks good");
  });

  it("getContext returns empty array when no session is active", () => {
    expect(useConversationStore.getState().getContext()).toEqual([]);
  });

  it("getContext returns all messages when n >= message count", () => {
    useConversationStore.getState().startSession("all");
    useConversationStore.getState().appendMessage("agent", "one");
    useConversationStore.getState().appendMessage("agent", "two");
    const ctx = useConversationStore.getState().getContext(100);
    expect(ctx).toHaveLength(2);
  });

  it("clearSession removes messages but keeps currentSessionId", () => {
    useConversationStore.getState().startSession("keep");
    useConversationStore.getState().appendMessage("agent", "msg");
    useConversationStore.getState().clearSession();
    expect(useConversationStore.getState().messages).toHaveLength(0);
    expect(useConversationStore.getState().currentSessionId).toBe("keep");
  });

  it("endSession clears currentSessionId", () => {
    useConversationStore.getState().startSession("end-me");
    useConversationStore.getState().endSession();
    expect(useConversationStore.getState().currentSessionId).toBeNull();
  });

  it("messages from a different session are not included in getContext", () => {
    // Start session A, add a message, then switch to session B
    useConversationStore.getState().startSession("sessionA");
    useConversationStore.getState().appendMessage("agent", "from A");
    useConversationStore.getState().startSession("sessionB");
    useConversationStore.getState().appendMessage("agent", "from B");

    const ctx = useConversationStore.getState().getContext(10);
    expect(ctx).toHaveLength(1);
    expect(ctx[0].content).toBe("from B");
  });

  it("restore: startSession with a known id resumes that session's context", () => {
    // Simulate a prior session already in the store
    const priorMessages = [
      {
        id: "msg-001",
        sessionId: "resume-me",
        role: "agent" as const,
        content: "Prior step",
        citedDocs: [],
        timestampMs: Date.now() - 60_000,
      },
    ];
    useConversationStore.setState({ messages: priorMessages, currentSessionId: null });

    // Resume the session by id
    useConversationStore.getState().startSession("resume-me");
    const ctx = useConversationStore.getState().getContext(10);
    expect(ctx).toHaveLength(1);
    expect(ctx[0].content).toBe("Prior step");
  });

  it("appendMessage after restore extends the existing message list", () => {
    const priorMessages = [
      {
        id: "msg-old",
        sessionId: "extend-me",
        role: "system" as const,
        content: "doc: /x.md",
        citedDocs: [],
        timestampMs: Date.now() - 1000,
      },
    ];
    useConversationStore.setState({ messages: priorMessages, currentSessionId: "extend-me" });

    useConversationStore.getState().appendMessage("agent", "new step");
    const ctx = useConversationStore.getState().getContext(10);
    expect(ctx).toHaveLength(2);
    expect(ctx[0].content).toBe("doc: /x.md");
    expect(ctx[1].content).toBe("new step");
  });
});
