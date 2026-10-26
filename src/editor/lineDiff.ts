/**
 * lineDiff.ts: a line-level Myers diff, the base of agent edit mode.
 *
 * A document is split into lines that keep their own line break
 * ({@link splitLines}), so joining the lines gives back the exact text: a
 * CRLF document, a lone-CR (old Mac) document and a last line with no break
 * all round-trip byte for byte. Two lines are equal only when their text and
 * their break are equal, so an edit that changes only line endings is still
 * an edit.
 *
 * {@link diffLines} trims the common prefix and suffix first (an agent's
 * edit usually touches a few lines of a long document), then runs Myers'
 * O(ND) algorithm on what is left. Past `maxEdits` differing lines it stops
 * searching for the shortest script and reports the middle as one
 * replacement: still a correct diff, just a coarse one, and it bounds the
 * time and memory a rewrite of a huge document can take.
 */

/** One run of a diff: lines kept, removed from `a`, or added from `b`. */
export interface DiffOp {
  kind: "equal" | "delete" | "insert";
  lines: string[];
}

/**
 * `text` as lines that each keep their line break (`\r\n`, `\n` or a lone
 * `\r`). The last line has no break when the text does not end in one. The
 * empty text has no lines. `splitLines(t).join("") === t` always.
 */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 /* \n */) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (c === 13 /* \r */) {
      const end = text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
      out.push(text.slice(start, end));
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Default bound on the edit distance searched before a coarse diff. */
export const DEFAULT_MAX_EDITS = 2000;

/**
 * The diff from `a` to `b`: runs of equal, deleted and inserted lines, in
 * order, with adjacent runs of a kind merged and, within a change, the
 * deletions before the insertions. Applying the deletes and inserts to `a`
 * gives `b`.
 */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
  maxEdits = DEFAULT_MAX_EDITS,
): DiffOp[] {
  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const ops: DiffOp[] = [];
  if (prefix > 0) ops.push({ kind: "equal", lines: a.slice(0, prefix) });
  for (const op of diffMiddle(midA, midB, maxEdits)) ops.push(op);
  if (suffix > 0) ops.push({ kind: "equal", lines: a.slice(a.length - suffix) });
  return canonical(ops);
}

/** The diff of two line lists that share no prefix or suffix. */
function diffMiddle(a: string[], b: string[], maxEdits: number): DiffOp[] {
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return [{ kind: "insert", lines: b }];
  if (b.length === 0) return [{ kind: "delete", lines: a }];

  // Intern lines to integers so the inner loop compares numbers.
  const ids = new Map<string, number>();
  const intern = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const A = Int32Array.from(a, intern);
  const B = Int32Array.from(b, intern);

  const script = myers(A, B, maxEdits);
  if (script === null) {
    return [
      { kind: "delete", lines: a },
      { kind: "insert", lines: b },
    ];
  }
  return script.map((step) => ({
    kind: step.kind,
    lines:
      step.kind === "insert"
        ? b.slice(step.from, step.to)
        : a.slice(step.from, step.to),
  }));
}

/** A run of a Myers script: `[from, to)` in `a` (equal, delete) or `b` (insert). */
interface Step {
  kind: DiffOp["kind"];
  from: number;
  to: number;
}

/**
 * Myers' shortest edit script from `A` to `B`, or `null` when it is longer
 * than `maxEdits`. Each round `d` keeps a copy of the furthest-reaching
 * paths for diagonals `-d..d` (O(D²) memory in all), from which the script
 * is read back.
 */
function myers(A: Int32Array, B: Int32Array, maxEdits: number): Step[] | null {
  const n = A.length;
  const m = B.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxEdits);

  for (let d = 0; d <= limit; d++) {
    const snap = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k++) snap[k + d] = v[off + k];
    trace.push(snap);

    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])
          ? v[off + k + 1]
          : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): Step[] {
  const rev: Step[] = [];
  const push = (kind: Step["kind"], from: number, to: number) => {
    if (to > from) rev.push({ kind, from, to });
  };
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const snap = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && snap[k - 1 + d] < snap[k + 1 + d]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = snap[prevK + d];
    const prevY = prevX - prevK;
    // The snake: equal lines walked after the edit of this round.
    const snakeFrom = down ? prevX : prevX + 1;
    push("equal", snakeFrom, x);
    if (down) push("insert", prevY, prevY + 1);
    else push("delete", prevX, prevX + 1);
    x = prevX;
    y = prevY;
  }
  push("equal", 0, x);
  return rev.reverse();
}

/**
 * Merge adjacent runs of a kind, drop empty runs, and order each change
 * (the runs between two equal runs) as its deletions, then its insertions,
 * so a change reads as "these lines became those".
 */
function canonical(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  let del: string[] = [];
  let ins: string[] = [];
  const flush = () => {
    if (del.length > 0) out.push({ kind: "delete", lines: del });
    if (ins.length > 0) out.push({ kind: "insert", lines: ins });
    del = [];
    ins = [];
  };
  for (const op of ops) {
    if (op.lines.length === 0) continue;
    if (op.kind === "equal") {
      flush();
      const last = out[out.length - 1];
      if (last?.kind === "equal") last.lines = [...last.lines, ...op.lines];
      else out.push({ kind: "equal", lines: [...op.lines] });
    } else if (op.kind === "delete") {
      // Coarse replacements can contain more lines than a JS engine's
      // function argument limit, so do not spread a run into push().
      for (const line of op.lines) del.push(line);
    } else {
      for (const line of op.lines) ins.push(line);
    }
  }
  flush();
  return out;
}
