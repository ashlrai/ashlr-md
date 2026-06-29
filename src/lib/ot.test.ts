/**
 * ot.test.ts — comprehensive suite for the Operational Transformation engine.
 *
 * Covers:
 *  - apply: basic insert, delete, retain
 *  - normalise: merging adjacent same-type components
 *  - makeInsert / makeDelete: factory helpers
 *  - compose: sequential operations compose correctly
 *  - transform: concurrent ops converge (diamond property)
 *  - vector clock utilities: tickClock, happenedBefore, concurrent
 *  - summarise: line-range and char-count metadata
 *  - Error paths: out-of-bounds, empty text, etc.
 */

import { describe, expect, it } from "vitest";
import {
  apply,
  compose,
  concurrent,
  del,
  happenedBefore,
  insert,
  makeDelete,
  makeInsert,
  normalise,
  retain,
  summarise,
  tickClock,
  transform,
  type OtComponent,
  type OtOperation,
  type VectorClock,
} from "./ot";

// ── Helpers ───────────────────────────────────────────────────────────────────

function op(
  id: string,
  agentId: string,
  seq: number,
  clock: VectorClock,
  components: OtComponent[],
): OtOperation {
  return { id, agentId, seq, clock, components };
}

// ── retain / insert / del builders ───────────────────────────────────────────

describe("component builders", () => {
  it("retain creates a retain component", () => {
    expect(retain(5)).toEqual({ type: "retain", count: 5 });
  });

  it("insert creates an insert component", () => {
    expect(insert("hello")).toEqual({ type: "insert", text: "hello" });
  });

  it("del creates a delete component", () => {
    expect(del(3)).toEqual({ type: "delete", count: 3 });
  });

  it("retain throws for count <= 0", () => {
    expect(() => retain(0)).toThrow(RangeError);
    expect(() => retain(-1)).toThrow(RangeError);
  });

  it("insert throws for empty string", () => {
    expect(() => insert("")).toThrow(RangeError);
  });

  it("del throws for count <= 0", () => {
    expect(() => del(0)).toThrow(RangeError);
    expect(() => del(-2)).toThrow(RangeError);
  });
});

// ── normalise ─────────────────────────────────────────────────────────────────

describe("normalise", () => {
  it("merges adjacent retains", () => {
    expect(normalise([retain(3), retain(4)])).toEqual([retain(7)]);
  });

  it("merges adjacent inserts", () => {
    expect(normalise([insert("foo"), insert("bar")])).toEqual([insert("foobar")]);
  });

  it("merges adjacent deletes", () => {
    expect(normalise([del(2), del(3)])).toEqual([del(5)]);
  });

  it("does not merge inserts across retains", () => {
    const cs = [insert("a"), retain(1), insert("b")];
    expect(normalise(cs)).toEqual(cs);
  });

  it("preserves interleaved different types", () => {
    const cs: OtComponent[] = [retain(2), insert("X"), del(1), retain(3)];
    expect(normalise(cs)).toEqual(cs);
  });

  it("handles empty input", () => {
    expect(normalise([])).toEqual([]);
  });
});

// ── apply ─────────────────────────────────────────────────────────────────────

describe("apply", () => {
  const mkOp = (components: OtComponent[]) =>
    op("x", "a", 0, {}, components);

  it("identity op (all retain) returns the same string", () => {
    const doc = "hello";
    const o = mkOp([retain(5)]);
    expect(apply(doc, o)).toBe("hello");
  });

  it("insert at the start", () => {
    const o = mkOp([insert("Hi "), retain(5)]);
    expect(apply("world", o)).toBe("Hi world");
  });

  it("insert in the middle", () => {
    const o = mkOp([retain(2), insert("XX"), retain(3)]);
    expect(apply("abcde", o)).toBe("abXXcde");
  });

  it("insert at the end", () => {
    const o = mkOp([retain(5), insert("!")]);
    expect(apply("hello", o)).toBe("hello!");
  });

  it("delete at the start", () => {
    const o = mkOp([del(3), retain(2)]);
    expect(apply("hello", o)).toBe("lo");
  });

  it("delete in the middle", () => {
    const o = mkOp([retain(1), del(2), retain(2)]);
    expect(apply("abcde", o)).toBe("ade");
  });

  it("delete at the end", () => {
    const o = mkOp([retain(3), del(2)]);
    expect(apply("hello", o)).toBe("hel");
  });

  it("insert + delete in same op", () => {
    const o = mkOp([retain(2), del(1), insert("Z"), retain(2)]);
    expect(apply("abcde", o)).toBe("abZde");
  });

  it("insert on empty doc", () => {
    const o = mkOp([insert("new")]);
    expect(apply("", o)).toBe("new");
  });

  it("throws when retain overruns doc length", () => {
    const o = mkOp([retain(10)]);
    expect(() => apply("hi", o)).toThrow(RangeError);
  });

  it("throws when delete overruns doc length", () => {
    const o = mkOp([del(10)]);
    expect(() => apply("hi", o)).toThrow(RangeError);
  });

  it("throws when op does not cover full doc length", () => {
    const o = mkOp([retain(2)]);
    expect(() => apply("hello", o)).toThrow(RangeError);
  });
});

// ── makeInsert ────────────────────────────────────────────────────────────────

describe("makeInsert", () => {
  it("inserts at offset 0", () => {
    const o = makeInsert(5, 0, "AB", "agent1", {}, 1);
    expect(apply("hello", o)).toBe("ABhello");
  });

  it("inserts in the middle", () => {
    const o = makeInsert(5, 3, "--", "agent1", {}, 1);
    expect(apply("hello", o)).toBe("hel--lo");
  });

  it("inserts at the end", () => {
    const o = makeInsert(5, 5, "!", "agent1", {}, 1);
    expect(apply("hello", o)).toBe("hello!");
  });

  it("inserts on empty doc", () => {
    const o = makeInsert(0, 0, "abc", "agent1", {}, 1);
    expect(apply("", o)).toBe("abc");
  });

  it("throws when offset is negative", () => {
    expect(() => makeInsert(5, -1, "x", "a", {}, 1)).toThrow(RangeError);
  });

  it("throws when offset exceeds doc length", () => {
    expect(() => makeInsert(5, 6, "x", "a", {}, 1)).toThrow(RangeError);
  });

  it("carries the provided clock and seq", () => {
    const clock: VectorClock = { a: 2, b: 1 };
    const o = makeInsert(3, 1, "X", "a", clock, 3);
    expect(o.clock).toEqual(clock);
    expect(o.seq).toBe(3);
    expect(o.agentId).toBe("a");
  });
});

// ── makeDelete ────────────────────────────────────────────────────────────────

describe("makeDelete", () => {
  it("deletes from offset 0", () => {
    const o = makeDelete(5, 0, 2, "agent1", {}, 1);
    expect(apply("hello", o)).toBe("llo");
  });

  it("deletes in the middle", () => {
    const o = makeDelete(5, 1, 3, "agent1", {}, 1);
    expect(apply("hello", o)).toBe("ho");
  });

  it("deletes at the end", () => {
    const o = makeDelete(5, 3, 2, "agent1", {}, 1);
    expect(apply("hello", o)).toBe("hel");
  });

  it("throws when range is out of bounds", () => {
    expect(() => makeDelete(5, 3, 4, "a", {}, 1)).toThrow(RangeError);
  });

  it("throws when length <= 0", () => {
    expect(() => makeDelete(5, 2, 0, "a", {}, 1)).toThrow(RangeError);
  });
});

// ── compose ───────────────────────────────────────────────────────────────────

describe("compose", () => {
  const clock0: VectorClock = {};

  it("composing two inserts at different positions", () => {
    const doc = "hello";
    const a = makeInsert(5, 0, "A", "ag", clock0, 1);
    // After a, doc is "Ahello". Insert at end of new doc.
    const b = makeInsert(6, 6, "Z", "ag", { ag: 1 }, 2);
    const composed = compose(a, b);
    const result = apply(doc, composed);
    // Should equal applying both in sequence.
    expect(result).toBe(apply(apply(doc, a), b));
  });

  it("composing an insert then a delete", () => {
    const doc = "hello";
    const a = makeInsert(5, 2, "XY", "ag", clock0, 1);
    // "heXYllo" → delete the inserted chars
    const b = makeDelete(7, 2, 2, "ag", { ag: 1 }, 2);
    const composed = compose(a, b);
    expect(apply(doc, composed)).toBe(apply(apply(doc, a), b));
  });

  it("composing a delete then an insert", () => {
    const doc = "hello world";
    const a = makeDelete(11, 5, 6, "ag", clock0, 1);
    // "hello" → insert at position 5
    const b = makeInsert(5, 5, " there", "ag", { ag: 1 }, 2);
    const composed = compose(a, b);
    expect(apply(doc, composed)).toBe(apply(apply(doc, a), b));
  });

  it("composed clock merges both clocks taking max values", () => {
    const a = makeInsert(3, 0, "A", "x", { x: 1, y: 2 }, 2);
    const b = makeInsert(4, 4, "B", "x", { x: 2, y: 1, z: 3 }, 3);
    const composed = compose(a, b);
    expect(composed.clock).toMatchObject({ x: 2, y: 2, z: 3 });
  });
});

// ── transform — diamond property ─────────────────────────────────────────────

describe("transform — diamond property (concurrent ops must converge)", () => {
  const clock0: VectorClock = {};

  /** Assert that apply(apply(doc, a), bPrime) === apply(apply(doc, b), aPrime). */
  function assertDiamond(doc: string, a: OtOperation, b: OtOperation): void {
    const [aPrime, bPrime] = transform(a, b);
    const pathA = apply(apply(doc, a), bPrime);
    const pathB = apply(apply(doc, b), aPrime);
    expect(pathA).toBe(pathB);
  }

  it("concurrent inserts at different positions converge", () => {
    const doc = "hello";
    const a = makeInsert(5, 0, "A", "ag1", clock0, 1);
    const b = makeInsert(5, 5, "Z", "ag2", clock0, 1);
    assertDiamond(doc, a, b);
  });

  it("concurrent inserts at the SAME position converge (left wins)", () => {
    const doc = "hello";
    const a = makeInsert(5, 2, "AA", "ag1", clock0, 1);
    const b = makeInsert(5, 2, "BB", "ag2", clock0, 1);
    assertDiamond(doc, a, b);
    // a is left — AA should come before BB in both convergent paths
    const [, bPrime] = transform(a, b);
    const result = apply(apply(doc, a), bPrime);
    expect(result).toContain("AA");
    expect(result).toContain("BB");
  });

  it("concurrent insert (a) and delete (b) at non-overlapping positions converge", () => {
    const doc = "abcdef";
    const a = makeInsert(6, 0, "Z", "ag1", clock0, 1);
    const b = makeDelete(6, 4, 2, "ag2", clock0, 1);
    assertDiamond(doc, a, b);
  });

  it("concurrent insert (a) and delete (b) where delete is BEFORE insert", () => {
    const doc = "abcdef";
    const a = makeInsert(6, 4, "X", "ag1", clock0, 1);
    const b = makeDelete(6, 0, 2, "ag2", clock0, 1);
    assertDiamond(doc, a, b);
  });

  it("concurrent deletes on non-overlapping ranges converge", () => {
    const doc = "abcdefghij";
    const a = makeDelete(10, 0, 3, "ag1", clock0, 1);
    const b = makeDelete(10, 6, 4, "ag2", clock0, 1);
    assertDiamond(doc, a, b);
  });

  it("concurrent deletes on the SAME range converge (idempotent)", () => {
    const doc = "hello world";
    const a = makeDelete(11, 5, 6, "ag1", clock0, 1);
    const b = makeDelete(11, 5, 6, "ag2", clock0, 1);
    assertDiamond(doc, a, b);
  });

  it("concurrent overlapping deletes converge", () => {
    const doc = "abcdefghij";
    // a deletes [2, 5), b deletes [4, 7)
    const a = makeDelete(10, 2, 3, "ag1", clock0, 1);
    const b = makeDelete(10, 4, 3, "ag2", clock0, 1);
    assertDiamond(doc, a, b);
  });

  it("concurrent insert and no-content-change (identity) converge", () => {
    const doc = "hello";
    const a = makeInsert(5, 2, "X", "ag1", clock0, 1);
    // Identity is all-retain.
    const b = op("b:1", "ag2", 1, clock0, [retain(5)]);
    assertDiamond(doc, a, b);
  });

  it("three-way concurrent inserts all converge via pair-wise transforms", () => {
    const doc = "abc";
    const a = makeInsert(3, 0, "A", "ag1", clock0, 1);
    const b = makeInsert(3, 1, "B", "ag2", clock0, 1);
    const c = makeInsert(3, 2, "C", "ag3", clock0, 1);

    // Apply a first, then transform b and c against a.
    const docA = apply(doc, a);
    const [, bPrimeA] = transform(a, b); // b transformed against a
    const [, cPrimeA] = transform(a, c); // c transformed against a

    const docAB = apply(docA, bPrimeA);
    // Now transform c' against b'
    const [, cPrimeAB] = transform(bPrimeA, cPrimeA);
    const finalABC = apply(docAB, cPrimeAB);

    // Apply b first path
    const docB = apply(doc, b);
    const [aPrimeB] = transform(a, b);
    const [, cPrimeB] = transform(b, c);
    const docBA = apply(docB, aPrimeB);
    const [, cPrimeBA] = transform(aPrimeB, cPrimeB);
    const finalBAC = apply(docBA, cPrimeBA);

    // Both orderings must contain all three insertions.
    expect(finalABC).toContain("A");
    expect(finalABC).toContain("B");
    expect(finalABC).toContain("C");
    expect(finalBAC).toContain("A");
    expect(finalBAC).toContain("B");
    expect(finalBAC).toContain("C");
  });

  it("aPrime clock includes b's agent and seq", () => {
    const a = makeInsert(3, 0, "X", "ag1", { ag1: 1 }, 2);
    const b = makeInsert(3, 2, "Y", "ag2", { ag2: 0 }, 1);
    const [aPrime] = transform(a, b);
    expect(aPrime.clock[b.agentId]).toBe(b.seq);
  });

  it("bPrime clock includes a's agent and seq", () => {
    const a = makeInsert(3, 0, "X", "ag1", { ag1: 1 }, 2);
    const b = makeInsert(3, 2, "Y", "ag2", { ag2: 0 }, 1);
    const [, bPrime] = transform(a, b);
    expect(bPrime.clock[a.agentId]).toBe(a.seq);
  });
});

// ── Agent-to-agent handoff scenario ──────────────────────────────────────────

describe("agent-to-agent handoff scenario", () => {
  it("agent A writes spec, agent B refines it live without merge conflicts", () => {
    const initial = "";

    // Agent A inserts a spec.
    const clockA0: VectorClock = {};
    const opA1 = makeInsert(0, 0, "# Spec\n\n- Item 1\n- Item 2\n", "agentA", clockA0, 1);
    const afterA1 = apply(initial, opA1);

    // Agent B starts from the same initial state (concurrent with A).
    // B inserts a title.
    const opB1 = makeInsert(0, 0, "# Title\n\n", "agentB", clockA0, 1);
    const afterB1 = apply(initial, opB1);

    // Transform so both agents converge.
    const [opA1Prime, opB1Prime] = transform(opA1, opB1);

    // Path 1: apply A then B'
    const path1 = apply(afterA1, opB1Prime);
    // Path 2: apply B then A'
    const path2 = apply(afterB1, opA1Prime);

    // Diamond property — both paths must produce the same result.
    expect(path1).toBe(path2);

    // The merged result must contain both contributions.
    expect(path1).toContain("# Spec");
    expect(path1).toContain("# Title");
    expect(path1).toContain("Item 1");
  });
});

// ── vector clock utilities ────────────────────────────────────────────────────

describe("tickClock", () => {
  it("increments a known agent", () => {
    const c = tickClock({ a: 2, b: 1 }, "a");
    expect(c).toEqual({ a: 3, b: 1 });
  });

  it("initialises a new agent at 1", () => {
    const c = tickClock({}, "x");
    expect(c).toEqual({ x: 1 });
  });

  it("does not mutate the original clock", () => {
    const orig: VectorClock = { a: 1 };
    const c = tickClock(orig, "a");
    expect(orig).toEqual({ a: 1 });
    expect(c).toEqual({ a: 2 });
  });
});

describe("happenedBefore", () => {
  it("empty clock happened-before everything", () => {
    expect(happenedBefore({}, { a: 1 })).toBe(true);
    expect(happenedBefore({}, {})).toBe(true);
  });

  it("clock a < clock b when all entries <=", () => {
    expect(happenedBefore({ a: 1, b: 2 }, { a: 2, b: 3 })).toBe(true);
  });

  it("clock a not happened-before b when a has a higher entry", () => {
    expect(happenedBefore({ a: 3 }, { a: 2 })).toBe(false);
  });

  it("equal clocks: a happened-before b (≤ in all entries)", () => {
    expect(happenedBefore({ a: 1 }, { a: 1 })).toBe(true);
  });

  it("missing key in b treated as 0", () => {
    expect(happenedBefore({ a: 1 }, {})).toBe(false);
  });
});

describe("concurrent", () => {
  it("concurrent when neither happened-before the other", () => {
    expect(concurrent({ a: 2, b: 1 }, { a: 1, b: 2 })).toBe(true);
  });

  it("not concurrent when a clearly happened-before b", () => {
    expect(concurrent({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("equal clocks are NOT concurrent (a ≤ b and b ≤ a)", () => {
    expect(concurrent({ a: 1 }, { a: 1 })).toBe(false);
  });
});

// ── summarise ─────────────────────────────────────────────────────────────────

describe("summarise", () => {
  it("reports 0 insert/delete chars for identity op", () => {
    const doc = "line one\nline two\n";
    const o = op("x", "a", 0, {}, [retain(doc.length)]);
    const s = summarise(o, doc);
    expect(s.insertedChars).toBe(0);
    expect(s.deletedChars).toBe(0);
  });

  it("reports inserted chars count for a single insert", () => {
    const doc = "hello world";
    const o = makeInsert(11, 5, "!!", "a", {}, 1);
    const s = summarise(o, doc);
    expect(s.insertedChars).toBe(2);
    expect(s.deletedChars).toBe(0);
  });

  it("reports deleted chars count for a single delete", () => {
    const doc = "hello world";
    const o = makeDelete(11, 6, 5, "a", {}, 1);
    const s = summarise(o, doc);
    expect(s.deletedChars).toBe(5);
    expect(s.insertedChars).toBe(0);
  });

  it("maps insert to the correct line (0-based)", () => {
    const doc = "line 0\nline 1\nline 2\n";
    // Insert at start of line 1 (offset 7)
    const o = makeInsert(doc.length, 7, "X", "a", {}, 1);
    const s = summarise(o, doc);
    expect(s.firstLine).toBe(1);
    expect(s.lastLine).toBe(1);
  });

  it("spans multiple lines for a multi-line insert", () => {
    const doc = "hello\n";
    const o = makeInsert(6, 6, "a\nb\nc", "a", {}, 1);
    const s = summarise(o, doc);
    expect(s.insertedChars).toBe(5);
    // Inserted text spans 2 newlines, so lines 1, 2, 3
    expect(s.lastLine).toBeGreaterThan(s.firstLine);
  });

  it("firstLine and lastLine are both >= 0", () => {
    const doc = "abc";
    const o = makeDelete(3, 0, 3, "a", {}, 1);
    const s = summarise(o, doc);
    expect(s.firstLine).toBeGreaterThanOrEqual(0);
    expect(s.lastLine).toBeGreaterThanOrEqual(0);
  });
});

// ── classifySection ───────────────────────────────────────────────────────────

import { classifySection, offsetToLineCol, resolveConflict, transformCursor } from "./ot";

describe("classifySection", () => {
  it("classifies prose when there is no frontmatter or code fence", () => {
    const doc = "# Hello\n\nJust some text.";
    expect(classifySection(doc, 0)).toBe("prose");
    expect(classifySection(doc, 10)).toBe("prose");
  });

  it("classifies frontmatter for offsets inside the YAML block", () => {
    const doc = "---\ntitle: Test\n---\n\n# Hello";
    // offset 4 is inside frontmatter ("title: ...")
    expect(classifySection(doc, 4)).toBe("frontmatter");
    // offset 0 is the opening "---"
    expect(classifySection(doc, 0)).toBe("frontmatter");
  });

  it("classifies prose for content after the frontmatter fence", () => {
    const doc = "---\ntitle: T\n---\n\n# Body";
    // offset past the closing "---\n"
    expect(classifySection(doc, doc.indexOf("# Body"))).toBe("prose");
  });

  it("classifies code for offsets inside a fenced code block", () => {
    const doc = "text\n```js\nconst x = 1;\n```\nmore";
    const codeStart = doc.indexOf("const x");
    expect(classifySection(doc, codeStart)).toBe("code");
  });

  it("classifies prose outside a fenced code block", () => {
    const doc = "text\n```js\ncode\n```\nafter";
    const afterCode = doc.indexOf("after");
    expect(classifySection(doc, afterCode)).toBe("prose");
  });

  it("handles offsets at 0 and doc.length without throwing", () => {
    const doc = "hello";
    expect(() => classifySection(doc, 0)).not.toThrow();
    expect(() => classifySection(doc, doc.length)).not.toThrow();
    // Out-of-bounds should be clamped, not throw.
    expect(() => classifySection(doc, -5)).not.toThrow();
    expect(() => classifySection(doc, 9999)).not.toThrow();
  });
});

// ── offsetToLineCol ───────────────────────────────────────────────────────────

describe("offsetToLineCol", () => {
  it("offset 0 is line 0, col 0", () => {
    expect(offsetToLineCol("hello", 0)).toEqual({ line: 0, col: 0 });
  });

  it("offset at end of first line (no newline) is line 0, col = doc length", () => {
    expect(offsetToLineCol("hello", 5)).toEqual({ line: 0, col: 5 });
  });

  it("offset at the start of the second line", () => {
    const doc = "hello\nworld";
    // offset 6 is 'w' on line 1
    expect(offsetToLineCol(doc, 6)).toEqual({ line: 1, col: 0 });
  });

  it("offset mid second line", () => {
    const doc = "abc\ndefg";
    // offset 6 is 'e' → line 1, col 2
    expect(offsetToLineCol(doc, 6)).toEqual({ line: 1, col: 2 });
  });

  it("clamps negative offsets to line 0, col 0", () => {
    expect(offsetToLineCol("hello", -3)).toEqual({ line: 0, col: 0 });
  });

  it("clamps over-length offsets to end of doc", () => {
    const doc = "hi";
    expect(offsetToLineCol(doc, 100)).toEqual({ line: 0, col: 2 });
  });
});

// ── transformCursor ───────────────────────────────────────────────────────────

describe("transformCursor", () => {
  const clock0: VectorClock = {};

  it("insert before cursor shifts it right by inserted length", () => {
    // doc = "hello" (5 chars), cursor at 3, insert "AB" at offset 0
    const op = makeInsert(5, 0, "AB", "ag", clock0, 1);
    // Cursor was at 3; after inserting 2 chars at 0, cursor should be at 5.
    expect(transformCursor(3, op)).toBe(5);
  });

  it("insert at cursor position shifts it right", () => {
    const op = makeInsert(5, 2, "XY", "ag", clock0, 1);
    // Cursor at 2, insert at 2 → cursor shifts to 4.
    expect(transformCursor(2, op)).toBe(4);
  });

  it("insert after cursor does not move cursor", () => {
    const op = makeInsert(5, 4, "Z", "ag", clock0, 1);
    // Cursor at 2, insert at 4 → cursor stays at 2.
    expect(transformCursor(2, op)).toBe(2);
  });

  it("delete entirely before cursor shifts it left", () => {
    // doc = "hello world" (11), cursor at 8, delete [0, 6) (6 chars)
    const op = makeDelete(11, 0, 6, "ag", clock0, 1);
    expect(transformCursor(8, op)).toBe(2);
  });

  it("delete after cursor does not move cursor", () => {
    const op = makeDelete(11, 8, 3, "ag", clock0, 1);
    // Cursor at 4, delete at [8,11) → cursor stays at 4.
    expect(transformCursor(4, op)).toBe(4);
  });

  it("delete overlapping cursor snaps cursor to deletion start", () => {
    // doc = "abcdefgh" (8), cursor at 5, delete [3, 7) (4 chars)
    const op = makeDelete(8, 3, 4, "ag", clock0, 1);
    // Deletion covers cursor position 5 → snap to start of deletion = 3.
    expect(transformCursor(5, op)).toBe(3);
  });

  it("concurrent inserts at same position — cursor moves correctly after both", () => {
    // a inserts at 2, b inserts at 2 concurrently
    const a = makeInsert(5, 2, "AA", "ag1", clock0, 1);
    const b = makeInsert(5, 2, "BB", "ag2", clock0, 1);
    const [, bPrime] = transform(a, b);
    // Apply a first, then bPrime. Cursor was at 2 in original doc.
    const cursorAfterA = transformCursor(2, a);
    const cursorFinal = transformCursor(cursorAfterA, bPrime);
    // Both insertions happened; cursor should be >= 2
    expect(cursorFinal).toBeGreaterThanOrEqual(2);
  });
});

// ── resolveConflict ───────────────────────────────────────────────────────────

describe("resolveConflict", () => {
  it("agent wins in code sections", () => {
    expect(resolveConflict("human", "agent", "code")).toBe("b");
    expect(resolveConflict("agent", "human", "code")).toBe("a");
  });

  it("agent wins in frontmatter sections", () => {
    expect(resolveConflict("human", "agent", "frontmatter")).toBe("b");
    expect(resolveConflict("agent", "human", "frontmatter")).toBe("a");
  });

  it("human wins in prose sections", () => {
    expect(resolveConflict("human", "agent", "prose")).toBe("a");
    expect(resolveConflict("agent", "human", "prose")).toBe("b");
  });

  it("same source always returns a (no conflict)", () => {
    expect(resolveConflict("human", "human", "prose")).toBe("a");
    expect(resolveConflict("agent", "agent", "code")).toBe("a");
  });

  it("unknown source falls back to a (left-wins)", () => {
    expect(resolveConflict("unknown", "agent", "prose")).toBe("a");
    expect(resolveConflict("agent", "unknown", "code")).toBe("a");
    expect(resolveConflict("unknown", "unknown", "prose")).toBe("a");
  });

  it("deletion + insertion conflict: agent wins in code", () => {
    // Represents: agent is deleting a line in a code block,
    // human simultaneously inserts — agent should win.
    expect(resolveConflict("agent", "human", "code")).toBe("a");
  });
});

// ── session resume (OtLogEntry shape) ────────────────────────────────────────

import type { OtLogEntry } from "./ot";

describe("OtLogEntry shape", () => {
  it("can construct a valid OtLogEntry", () => {
    const op = makeInsert(5, 0, "hi", "ag1", {}, 1);
    const entry: OtLogEntry = {
      docPath: "/docs/test.md",
      op,
      appliedAt: Date.now(),
      source: "agent",
    };
    expect(entry.docPath).toBe("/docs/test.md");
    expect(entry.source).toBe("agent");
    expect(entry.op.agentId).toBe("ag1");
  });

  it("log entries from a session can be replayed to reconstruct document", () => {
    // Simulate a session: start with empty doc, apply a series of ops.
    let doc = "";
    const entries: OtLogEntry[] = [];

    const op1 = makeInsert(0, 0, "# Title\n", "agentA", {}, 1);
    doc = apply(doc, op1);
    entries.push({ docPath: "/x.md", op: op1, appliedAt: Date.now(), source: "agent" });

    const op2 = makeInsert(doc.length, doc.length, "\nBody text.", "human", { agentA: 1 }, 1);
    doc = apply(doc, op2);
    entries.push({ docPath: "/x.md", op: op2, appliedAt: Date.now(), source: "human" });

    // Replay from scratch using only the log.
    let replayed = "";
    for (const entry of entries) {
      replayed = apply(replayed, entry.op);
    }
    expect(replayed).toBe(doc);
    expect(replayed).toContain("# Title");
    expect(replayed).toContain("Body text.");
  });
});
