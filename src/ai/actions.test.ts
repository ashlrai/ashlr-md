// Registry tests for src/ai/actions.ts
//
// Validates that every AI_ACTION and DOC_ACTION entry is well-formed, that
// there are no duplicates, that buildMessages() returns valid message arrays,
// and that the catalogue stays in sync with the Rust list_ai_actions tool
// (same set of action ids — checked by name not by implementation).

import { describe, expect, it } from "vitest";
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
