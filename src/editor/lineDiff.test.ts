import { describe, expect, it } from "vitest";
import { type DiffOp, diffLines, splitLines } from "./lineDiff";

/** Deterministic PRNG (mulberry32), so a failing fuzz case reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `a` with the script applied: what the diff says `b` is. */
function rebuild(a: readonly string[], ops: DiffOp[]): { a: string[]; b: string[] } {
  const fromA: string[] = [];
  const fromB: string[] = [];
  for (const op of ops) {
    if (op.kind !== "insert") fromA.push(...op.lines);
    if (op.kind !== "delete") fromB.push(...op.lines);
  }
  expect(fromA).toEqual(a);
  return { a: fromA, b: fromB };
}

/** The edit distance (insertions + deletions) by the LCS table. */
function lcsDistance(a: readonly string[], b: readonly string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return a.length + b.length - 2 * dp[a.length][b.length];
}

function editCount(ops: DiffOp[]): number {
  return ops.reduce((n, op) => n + (op.kind === "equal" ? 0 : op.lines.length), 0);
}

describe("splitLines", () => {
  it("keeps each line's break so the lines join back to the text", () => {
    for (const text of [
      "",
      "one",
      "one\n",
      "one\ntwo",
      "one\r\ntwo\r\n",
      "old\rmac\r",
      "mixed\r\nbreaks\nand\rmore",
      "\n\n\n",
      "\r\n\r\n",
      "trailing\r",
    ]) {
      expect(splitLines(text).join("")).toBe(text);
    }
  });

  it("splits on LF, CRLF and a lone CR, and keeps a last line with no break", () => {
    expect(splitLines("a\r\nb\nc\rd")).toEqual(["a\r\n", "b\n", "c\r", "d"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("\n")).toEqual(["\n"]);
  });
});

describe("diffLines", () => {
  it("is all equal for the same lines and empty for two empty lists", () => {
    expect(diffLines([], [])).toEqual([]);
    expect(diffLines(["a\n", "b\n"], ["a\n", "b\n"])).toEqual([
      { kind: "equal", lines: ["a\n", "b\n"] },
    ]);
  });

  it("reports an insertion, a deletion and a replacement", () => {
    expect(diffLines(["a\n", "c\n"], ["a\n", "b\n", "c\n"])).toEqual([
      { kind: "equal", lines: ["a\n"] },
      { kind: "insert", lines: ["b\n"] },
      { kind: "equal", lines: ["c\n"] },
    ]);
    expect(diffLines(["a\n", "b\n", "c\n"], ["a\n", "c\n"])).toEqual([
      { kind: "equal", lines: ["a\n"] },
      { kind: "delete", lines: ["b\n"] },
      { kind: "equal", lines: ["c\n"] },
    ]);
    expect(diffLines(["a\n", "b\n", "c\n"], ["a\n", "B\n", "c\n"])).toEqual([
      { kind: "equal", lines: ["a\n"] },
      { kind: "delete", lines: ["b\n"] },
      { kind: "insert", lines: ["B\n"] },
      { kind: "equal", lines: ["c\n"] },
    ]);
  });

  it("puts a change's deletions before its insertions", () => {
    const ops = diffLines(["x", "a", "y"], ["x", "b", "c", "y"]);
    expect(ops.map((o) => o.kind)).toEqual(["equal", "delete", "insert", "equal"]);
  });

  it("treats a line whose only change is its break as changed", () => {
    const ops = diffLines(splitLines("a\nb\n"), splitLines("a\r\nb\n"));
    expect(ops).toEqual([
      { kind: "delete", lines: ["a\n"] },
      { kind: "insert", lines: ["a\r\n"] },
      { kind: "equal", lines: ["b\n"] },
    ]);
  });

  it("finds a shortest script on random inputs (checked against the LCS table)", () => {
    const next = rng(42);
    const alphabet = ["a", "b", "c", "d", ""];
    for (let round = 0; round < 400; round++) {
      const make = () =>
        Array.from(
          { length: Math.floor(next() * 14) },
          () => alphabet[Math.floor(next() * alphabet.length)],
        );
      const a = make();
      const b = make();
      const ops = diffLines(a, b);
      expect(rebuild(a, ops).b).toEqual(b);
      expect(editCount(ops)).toBe(lcsDistance(a, b));
      // Canonical: no empty runs, no two runs of a kind side by side.
      for (let i = 0; i < ops.length; i++) {
        expect(ops[i].lines.length).toBeGreaterThan(0);
        if (i > 0) expect(ops[i].kind).not.toBe(ops[i - 1].kind);
      }
    }
  });

  it("falls back to one replacement past maxEdits, still a correct diff", () => {
    const a = ["p", "1", "2", "3", "4", "s"];
    const b = ["p", "w", "x", "y", "z", "s"];
    const ops = diffLines(a, b, 2);
    expect(ops).toEqual([
      { kind: "equal", lines: ["p"] },
      { kind: "delete", lines: ["1", "2", "3", "4"] },
      { kind: "insert", lines: ["w", "x", "y", "z"] },
      { kind: "equal", lines: ["s"] },
    ]);
    expect(rebuild(a, ops).b).toEqual(b);
  });

  it("diffs a long document with a small edit quickly", () => {
    const a = Array.from({ length: 50_000 }, (_, i) => `line ${i}\n`);
    const b = [...a];
    b.splice(25_000, 1, "changed\n", "added\n");
    const started = performance.now();
    const ops = diffLines(a, b);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(editCount(ops)).toBe(3);
    expect(rebuild(a, ops).b).toEqual(b);
  });

  it("bounds a total rewrite of a large document", () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `old ${i}\n`);
    const b = Array.from({ length: 20_000 }, (_, i) => `new ${i}\n`);
    const started = performance.now();
    const ops = diffLines(a, b);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(rebuild(a, ops).b).toEqual(b);
  });
});
