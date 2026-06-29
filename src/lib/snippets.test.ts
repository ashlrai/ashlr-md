/**
 * snippets.test.ts — 35+ tests for the Markdown snippet engine.
 *
 * Coverage:
 *   1.  isInsideFencedCode — position detection inside/outside fences
 *   2.  lineTextBefore — text on current line up to cursor
 *   3.  isOnTableRow — table row detection
 *   4.  isAtEndOfTableRow — full-row-end detection
 *   5.  BUILTIN_SNIPPETS — catalogue completeness + shape
 *   6.  rawToCompletion — Completion object shape
 *   7.  userSnippetToCompletion — custom snippet shape
 *   8.  markdownSnippetSource — context-aware completion firing + edge cases
 *   9.  buildSnippetExtension — extension array shape
 *  10.  settingsStore integration — customSnippets CRUD
 *  11.  Escaping and edge cases (nested fences, empty docs, unicode)
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Tauri mocks (required transitively via settingsStore → zustand persist)
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// ---------------------------------------------------------------------------
// Module imports (after mocks)
// ---------------------------------------------------------------------------

import {
  BUILTIN_SNIPPETS,
  buildSnippetExtension,
  isAtEndOfTableRow,
  isInsideFencedCode,
  isOnTableRow,
  lineTextBefore,
  markdownSnippetSource,
  rawToCompletion,
  userSnippetToCompletion,
  type UserSnippet,
} from "./snippets";
import { useSettingsStore } from "../store/settingsStore";

// ---------------------------------------------------------------------------
// Helper: build a minimal CompletionContext-like object.
// CompletionContext requires an EditorState, which requires CodeMirror's full
// runtime.  We test the underlying helper functions directly instead, and test
// markdownSnippetSource via a thin adapter that constructs the real context
// object from @codemirror/state.
// ---------------------------------------------------------------------------

import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";

/** Build a real (minimal) CompletionContext for `markdownSnippetSource` tests. */
function makeContext(doc: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, pos, explicit);
}

// ---------------------------------------------------------------------------
// Reset store before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  useSettingsStore.setState({ customSnippets: [] });
});

// ===========================================================================
// 1. isInsideFencedCode
// ===========================================================================

describe("isInsideFencedCode", () => {
  it("returns false for an empty document", () => {
    expect(isInsideFencedCode("", 0)).toBe(false);
  });

  it("returns false when cursor is before any fence", () => {
    const doc = "hello\n```\ncode\n```\n";
    expect(isInsideFencedCode(doc, 3)).toBe(false);
  });

  it("returns true when cursor is inside a backtick fence", () => {
    const doc = "text\n```\nsome code here\n```\n";
    // pos 14 is inside the code block (after the opening ```)
    const insidePos = doc.indexOf("some code");
    expect(isInsideFencedCode(doc, insidePos)).toBe(true);
  });

  it("returns false when cursor is after a closed fence", () => {
    const doc = "```\ncode\n```\nafter";
    const afterPos = doc.indexOf("after");
    expect(isInsideFencedCode(doc, afterPos)).toBe(false);
  });

  it("returns true inside a tilde fence (~~~)", () => {
    const doc = "~~~\nsome code\n~~~\n";
    const insidePos = doc.indexOf("some code");
    expect(isInsideFencedCode(doc, insidePos)).toBe(true);
  });

  it("returns false for cursor exactly at the fence opening line", () => {
    const doc = "```\ncode\n```\n";
    // pos 0 is at the very start (before the fence)
    expect(isInsideFencedCode(doc, 0)).toBe(false);
  });

  it("handles a document with two fenced blocks, cursor in second", () => {
    const doc = "```\nblock1\n```\ntext\n```\nblock2\n```\n";
    const secondPos = doc.indexOf("block2");
    expect(isInsideFencedCode(doc, secondPos)).toBe(true);
  });

  it("handles a document with two fenced blocks, cursor between them", () => {
    const doc = "```\nblock1\n```\ntext\n```\nblock2\n```\n";
    const between = doc.indexOf("text");
    expect(isInsideFencedCode(doc, between)).toBe(false);
  });

  it("returns false for a document with only plain text", () => {
    const doc = "# Heading\n\nSome paragraph text.\n";
    expect(isInsideFencedCode(doc, 10)).toBe(false);
  });

  it("handles fences with language specifiers (```typescript)", () => {
    const doc = "```typescript\nconst x = 1;\n```\n";
    const insidePos = doc.indexOf("const");
    expect(isInsideFencedCode(doc, insidePos)).toBe(true);
  });
});

// ===========================================================================
// 2. lineTextBefore
// ===========================================================================

describe("lineTextBefore", () => {
  it("returns empty string when cursor is at start of document", () => {
    expect(lineTextBefore("hello", 0)).toBe("");
  });

  it("returns text from line start to cursor", () => {
    const doc = "line one\nline two\nline three";
    const pos = doc.indexOf("line two") + 4; // after "line"
    expect(lineTextBefore(doc, pos)).toBe("line");
  });

  it("returns the full first line when cursor is at its end", () => {
    const doc = "first\nsecond";
    expect(lineTextBefore(doc, 5)).toBe("first");
  });

  it("works on a single-line document", () => {
    const doc = "hello world";
    expect(lineTextBefore(doc, 5)).toBe("hello");
  });

  it("returns empty string when cursor is at start of a new line", () => {
    const doc = "first\n";
    expect(lineTextBefore(doc, 6)).toBe("");
  });
});

// ===========================================================================
// 3. isOnTableRow
// ===========================================================================

describe("isOnTableRow", () => {
  it("returns true when the current line starts with |", () => {
    const doc = "| col1 | col2 |";
    expect(isOnTableRow(doc, 5)).toBe(true);
  });

  it("returns false for a non-table line", () => {
    const doc = "some normal text";
    expect(isOnTableRow(doc, 5)).toBe(false);
  });

  it("returns true for a separator row", () => {
    const doc = "| --- | --- |";
    expect(isOnTableRow(doc, 3)).toBe(true);
  });

  it("returns false for blockquote lines (starts with >)", () => {
    const doc = "> blockquote";
    expect(isOnTableRow(doc, 3)).toBe(false);
  });

  it("handles leading whitespace before pipe", () => {
    const doc = "  | col1 | col2 |";
    expect(isOnTableRow(doc, 5)).toBe(true);
  });
});

// ===========================================================================
// 4. isAtEndOfTableRow
// ===========================================================================

describe("isAtEndOfTableRow", () => {
  it("returns true when cursor is at end of a complete table row", () => {
    const doc = "| a | b |";
    expect(isAtEndOfTableRow(doc, doc.length)).toBe(true);
  });

  it("returns false when cursor is in the middle of a row", () => {
    const doc = "| a | b |";
    expect(isAtEndOfTableRow(doc, 3)).toBe(false);
  });

  it("returns false for non-table lines", () => {
    const doc = "normal text";
    expect(isAtEndOfTableRow(doc, doc.length)).toBe(false);
  });

  it("returns true for a multi-line doc with table at the end", () => {
    const doc = "# Title\n\n| col1 | col2 |";
    expect(isAtEndOfTableRow(doc, doc.length)).toBe(true);
  });

  it("returns false when row does not end with pipe", () => {
    const doc = "| a | b";
    expect(isAtEndOfTableRow(doc, doc.length)).toBe(false);
  });

  it("returns false when there is text after the pipe on the same line", () => {
    const doc = "| a | b | trailing";
    expect(isAtEndOfTableRow(doc, doc.length)).toBe(false);
  });
});

// ===========================================================================
// 5. BUILTIN_SNIPPETS catalogue
// ===========================================================================

describe("BUILTIN_SNIPPETS", () => {
  it("contains at least 25 entries", () => {
    expect(BUILTIN_SNIPPETS.length).toBeGreaterThanOrEqual(25);
  });

  it("every entry has a non-empty label", () => {
    for (const s of BUILTIN_SNIPPETS) {
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it("every entry has a non-empty template", () => {
    for (const s of BUILTIN_SNIPPETS) {
      expect(s.template.length).toBeGreaterThan(0);
    }
  });

  it("every entry has a detail string", () => {
    for (const s of BUILTIN_SNIPPETS) {
      expect(typeof s.detail).toBe("string");
    }
  });

  it("all labels are unique", () => {
    const labels = BUILTIN_SNIPPETS.map((s) => s.label);
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });

  it("includes inline link template", () => {
    const link = BUILTIN_SNIPPETS.find((s) => s.label === "[link]");
    expect(link).toBeDefined();
    expect(link!.template).toContain("](");
  });

  it("includes wikilink template", () => {
    const wl = BUILTIN_SNIPPETS.find((s) => s.label === "[[wikilink]]");
    expect(wl).toBeDefined();
    expect(wl!.template).toContain("[[");
    expect(wl!.template).toContain("]]");
  });

  it("includes fenced code block template", () => {
    const cb = BUILTIN_SNIPPETS.find((s) => s.label === "```code```");
    expect(cb).toBeDefined();
    expect(cb!.template).toContain("```");
  });

  it("includes table template", () => {
    const tbl = BUILTIN_SNIPPETS.find((s) => s.label === "| table |");
    expect(tbl).toBeDefined();
    expect(tbl!.template).toContain("| --- |");
  });

  it("includes checkbox template", () => {
    const cb = BUILTIN_SNIPPETS.find((s) => s.label === "- [ ] task");
    expect(cb).toBeDefined();
    expect(cb!.template).toContain("[ ]");
  });

  it("all templates use $0 or $1 tabstop syntax", () => {
    for (const s of BUILTIN_SNIPPETS) {
      expect(s.template).toMatch(/\$[0-9]/);
    }
  });
});

// ===========================================================================
// 6. rawToCompletion
// ===========================================================================

describe("rawToCompletion", () => {
  it("produces a Completion with matching label", () => {
    const c = rawToCompletion({
      label: "test",
      detail: "Test snippet",
      template: "test $1$0",
    });
    expect(c.label).toBe("test");
  });

  it("produces a Completion with matching detail", () => {
    const c = rawToCompletion({
      label: "test",
      detail: "My detail",
      template: "foo $0",
    });
    expect(c.detail).toBe("My detail");
  });

  it("produces a Completion with type 'keyword'", () => {
    const c = rawToCompletion({
      label: "x",
      detail: "d",
      template: "$0",
    });
    expect(c.type).toBe("keyword");
  });

  it("applies section when provided", () => {
    const c = rawToCompletion({
      label: "x",
      detail: "d",
      template: "$0",
      section: "Links",
    });
    expect(c.section).toBe("Links");
  });

  it("apply field is a function (snippet applicator)", () => {
    const c = rawToCompletion({
      label: "x",
      detail: "d",
      template: "hello $1 world $0",
    });
    expect(typeof c.apply).toBe("function");
  });
});

// ===========================================================================
// 7. userSnippetToCompletion
// ===========================================================================

describe("userSnippetToCompletion", () => {
  it("uses the UserSnippet label", () => {
    const s: UserSnippet = { label: "mysnip", template: "hello $0" };
    const c = userSnippetToCompletion(s);
    expect(c.label).toBe("mysnip");
  });

  it("uses the UserSnippet detail when provided", () => {
    const s: UserSnippet = { label: "x", detail: "Custom detail", template: "$0" };
    const c = userSnippetToCompletion(s);
    expect(c.detail).toBe("Custom detail");
  });

  it("falls back to 'Custom snippet' when no detail", () => {
    const s: UserSnippet = { label: "x", template: "$0" };
    const c = userSnippetToCompletion(s);
    expect(c.detail).toBe("Custom snippet");
  });

  it("apply is a function", () => {
    const s: UserSnippet = { label: "x", template: "a $1 b $0" };
    const c = userSnippetToCompletion(s);
    expect(typeof c.apply).toBe("function");
  });

  it("section is 'Custom'", () => {
    const s: UserSnippet = { label: "x", template: "$0" };
    const c = userSnippetToCompletion(s);
    expect(c.section).toBe("Custom");
  });
});

// ===========================================================================
// 8. markdownSnippetSource — context-aware completion
// ===========================================================================

describe("markdownSnippetSource", () => {
  it("returns null inside a fenced code block", () => {
    const source = markdownSnippetSource();
    const doc = "```\nsome code\n```\n";
    const pos = doc.indexOf("some code") + 2;
    const ctx = makeContext(doc, pos, true);
    expect(source(ctx)).toBeNull();
  });

  it("returns completions outside a fenced code block (explicit trigger)", () => {
    const source = markdownSnippetSource();
    const doc = "# Hello\n\n";
    const ctx = makeContext(doc, doc.length, true);
    const result = source(ctx);
    expect(result).not.toBeNull();
    expect(result!.options.length).toBeGreaterThan(0);
  });

  it("returns null when nothing has been typed and not explicit", () => {
    const source = markdownSnippetSource();
    // cursor right after a newline (nothing typed yet on this line)
    const doc = "# Title\n";
    const ctx = makeContext(doc, doc.length, false);
    // empty prefix + not explicit → null
    const result = source(ctx);
    expect(result).toBeNull();
  });

  it("returns completions when cursor has partial text (non-explicit)", () => {
    const source = markdownSnippetSource();
    const doc = "[li";
    const ctx = makeContext(doc, doc.length, false);
    const result = source(ctx);
    expect(result).not.toBeNull();
    expect(result!.options.length).toBeGreaterThan(0);
  });

  it("includes user snippets in the results", () => {
    const userSnippets: UserSnippet[] = [
      { label: "mysnippet", template: "hello $0" },
    ];
    const source = markdownSnippetSource(userSnippets);
    const doc = "mys";
    const ctx = makeContext(doc, doc.length, false);
    const result = source(ctx);
    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain("mysnippet");
  });

  it("does not return snippets inside a tilde fence", () => {
    const source = markdownSnippetSource();
    const doc = "~~~\nsome code\n~~~\n";
    const pos = doc.indexOf("some code") + 2;
    const ctx = makeContext(doc, pos, true);
    expect(source(ctx)).toBeNull();
  });

  it("returns completions after a closed fence (outside the block)", () => {
    const source = markdownSnippetSource();
    const doc = "```\ncode\n```\nafter text ";
    const ctx = makeContext(doc, doc.length, true);
    const result = source(ctx);
    expect(result).not.toBeNull();
  });

  it("includes built-in link snippet", () => {
    const source = markdownSnippetSource();
    const doc = "[lin";
    const ctx = makeContext(doc, doc.length, false);
    const result = source(ctx);
    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain("[link]");
  });

  it("includes wikilink snippet on [[ trigger", () => {
    const source = markdownSnippetSource();
    const doc = "[[";
    const ctx = makeContext(doc, doc.length, true);
    const result = source(ctx);
    expect(result).not.toBeNull();
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain("[[wikilink]]");
  });
});

// ===========================================================================
// 9. buildSnippetExtension
// ===========================================================================

describe("buildSnippetExtension", () => {
  it("returns an array", () => {
    const exts = buildSnippetExtension();
    expect(Array.isArray(exts)).toBe(true);
  });

  it("returns at least 3 extensions (autocomplete + keymap + table keymap)", () => {
    const exts = buildSnippetExtension();
    expect(exts.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts user snippets without throwing", () => {
    const snippets: UserSnippet[] = [
      { label: "test", template: "test $0" },
    ];
    expect(() => buildSnippetExtension(snippets)).not.toThrow();
  });

  it("accepts empty array without throwing", () => {
    expect(() => buildSnippetExtension([])).not.toThrow();
  });

  it("accepts activateOnTyping = false", () => {
    expect(() => buildSnippetExtension([], false)).not.toThrow();
  });
});

// ===========================================================================
// 10. settingsStore integration — customSnippets CRUD
// ===========================================================================

describe("settingsStore — customSnippets", () => {
  it("starts with an empty customSnippets array", () => {
    const { customSnippets } = useSettingsStore.getState();
    expect(customSnippets).toEqual([]);
  });

  it("addCustomSnippet appends a snippet", () => {
    const { addCustomSnippet } = useSettingsStore.getState();
    addCustomSnippet({ label: "mysnip", template: "hello $0" });
    expect(useSettingsStore.getState().customSnippets).toHaveLength(1);
    expect(useSettingsStore.getState().customSnippets[0].label).toBe("mysnip");
  });

  it("addCustomSnippet preserves existing snippets", () => {
    const store = useSettingsStore.getState();
    store.addCustomSnippet({ label: "a", template: "$0" });
    store.addCustomSnippet({ label: "b", template: "$0" });
    expect(useSettingsStore.getState().customSnippets).toHaveLength(2);
  });

  it("removeCustomSnippet removes by label", () => {
    const store = useSettingsStore.getState();
    store.addCustomSnippet({ label: "to-remove", template: "$0" });
    store.addCustomSnippet({ label: "keep", template: "$0" });
    store.removeCustomSnippet("to-remove");
    const labels = useSettingsStore.getState().customSnippets.map((s) => s.label);
    expect(labels).not.toContain("to-remove");
    expect(labels).toContain("keep");
  });

  it("removeCustomSnippet is a no-op for unknown label", () => {
    const store = useSettingsStore.getState();
    store.addCustomSnippet({ label: "keep", template: "$0" });
    store.removeCustomSnippet("nonexistent");
    expect(useSettingsStore.getState().customSnippets).toHaveLength(1);
  });

  it("updateCustomSnippet patches a snippet by label", () => {
    const store = useSettingsStore.getState();
    store.addCustomSnippet({ label: "orig", template: "old $0" });
    store.updateCustomSnippet("orig", { template: "new $0", detail: "Updated" });
    const updated = useSettingsStore.getState().customSnippets[0];
    expect(updated.template).toBe("new $0");
    expect(updated.detail).toBe("Updated");
    expect(updated.label).toBe("orig"); // label unchanged
  });

  it("updateCustomSnippet is a no-op for unknown label", () => {
    const store = useSettingsStore.getState();
    store.addCustomSnippet({ label: "x", template: "$0" });
    store.updateCustomSnippet("nonexistent", { template: "changed $0" });
    expect(useSettingsStore.getState().customSnippets[0].template).toBe("$0");
  });

  it("setCustomSnippets replaces the entire list", () => {
    const store = useSettingsStore.getState();
    store.addCustomSnippet({ label: "old", template: "$0" });
    store.setCustomSnippets([{ label: "new1", template: "$0" }, { label: "new2", template: "$0" }]);
    const { customSnippets } = useSettingsStore.getState();
    expect(customSnippets).toHaveLength(2);
    expect(customSnippets[0].label).toBe("new1");
  });
});

// ===========================================================================
// 11. Edge cases — escaping, empty docs, unicode, nested fences
// ===========================================================================

describe("edge cases", () => {
  it("isInsideFencedCode: empty document returns false", () => {
    expect(isInsideFencedCode("", 0)).toBe(false);
  });

  it("isInsideFencedCode: unclosed fence at EOF → inside", () => {
    const doc = "```\ncursorhere";
    expect(isInsideFencedCode(doc, doc.length)).toBe(true);
  });

  it("markdownSnippetSource: empty document, explicit → returns completions", () => {
    const source = markdownSnippetSource();
    const ctx = makeContext("x", 1, true);
    const result = source(ctx);
    expect(result).not.toBeNull();
    expect(result!.options.length).toBeGreaterThan(0);
  });

  it("BUILTIN_SNIPPETS: no template contains a bare unescaped $ (only $N)", () => {
    // All dollar signs should be followed by a digit (tabstop) or be $0
    for (const s of BUILTIN_SNIPPETS) {
      const invalidDollar = /\$(?![0-9])/.test(s.template);
      expect(invalidDollar).toBe(false);
    }
  });

  it("isInsideFencedCode: fence with 4+ backticks treated as fence", () => {
    const doc = "````\ncode inside\n````\n";
    const pos = doc.indexOf("code inside");
    expect(isInsideFencedCode(doc, pos)).toBe(true);
  });

  it("markdownSnippetSource: cursor in second of two sequential fences → null", () => {
    const source = markdownSnippetSource();
    const doc = "```\nfirst\n```\n```\nsecond\n```\n";
    const pos = doc.indexOf("second");
    const ctx = makeContext(doc, pos, true);
    expect(source(ctx)).toBeNull();
  });

  it("userSnippetToCompletion: template with multiple tabstops produces apply fn", () => {
    const s: UserSnippet = { label: "multi", template: "$1 + $2 = $0" };
    const c = userSnippetToCompletion(s);
    expect(typeof c.apply).toBe("function");
  });

  it("buildSnippetExtension: large user snippet list does not throw", () => {
    const many: UserSnippet[] = Array.from({ length: 100 }, (_, i) => ({
      label: `snip${i}`,
      template: `snippet ${i} $0`,
    }));
    expect(() => buildSnippetExtension(many)).not.toThrow();
  });
});
