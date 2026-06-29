/**
 * ot.ts — Operational Transformation engine for conflict-free multi-agent
 * Markdown editing.
 *
 * ## Model
 *
 * A document is a plain string.  An *operation* is a sequence of *components*
 * that fully describes a transformation of that string:
 *   - retain(n)   — keep the next `n` characters unchanged
 *   - insert(s)   — insert string `s` at the current position
 *   - delete(n)   — delete the next `n` characters
 *
 * An operation is *complete* when the sum of (retain + delete) lengths equals
 * the length of the input string it targets.  The output length is
 * (retain + insert lengths).
 *
 * ## Vector clocks
 *
 * Every `OtOperation` carries a `clock`: a `Record<string, number>` mapping
 * agent ids to their logical timestamp.  The clock reflects the state of the
 * document the operation was composed against.  Concurrent operations have
 * clocks that are neither ≤ nor ≥ each other.
 *
 * ## Transformation
 *
 * `transform(a, b)` produces `[a′, b′]` such that:
 *   - `apply(apply(doc, a), b′) === apply(apply(doc, b), a′)`
 *
 * This is the classic "diamond property" required for OT convergence.
 *
 * ## Usage
 *
 * ```ts
 * // Local edit:
 * const op = makeInsert(cursor, text, agentId);
 * const newContent = apply(content, op);
 *
 * // Remote op arrives concurrently with local op `pending`:
 * const [pending′, remote′] = transform(pending, remoteOp);
 * const newContent = apply(apply(content, remoteOp), pending′);
 * // OR:
 * const newContent = apply(apply(content, pending), remote′);
 * ```
 */

// ── Component types ───────────────────────────────────────────────────────────

export type RetainComponent = { type: "retain"; count: number };
export type InsertComponent = { type: "insert"; text: string };
export type DeleteComponent = { type: "delete"; count: number };
export type OtComponent = RetainComponent | InsertComponent | DeleteComponent;

// ── Operation ─────────────────────────────────────────────────────────────────

/** Vector clock: maps agent id → logical timestamp. */
export type VectorClock = Readonly<Record<string, number>>;

export interface OtOperation {
  /** Unique operation id (agent + sequence). */
  id: string;
  /** The agent that produced this operation. */
  agentId: string;
  /** Sequence number within this agent's log (monotonically increasing). */
  seq: number;
  /**
   * Vector clock BEFORE this operation was applied — i.e. the state against
   * which the operation was composed.
   */
  clock: VectorClock;
  /** The operation components. */
  components: OtComponent[];
  /** Derived metadata for the visual margin badges. */
  summary?: OperationSummary;
}

/** High-level summary extracted for UI display. */
export interface OperationSummary {
  /** First line index (0-based) affected by a non-retain component. */
  firstLine: number;
  /** Last line index (0-based) affected. */
  lastLine: number;
  /** Number of characters inserted. */
  insertedChars: number;
  /** Number of characters deleted. */
  deletedChars: number;
}

// ── Builder helpers ───────────────────────────────────────────────────────────

export function retain(count: number): RetainComponent {
  if (count <= 0) throw new RangeError(`retain count must be > 0, got ${count}`);
  return { type: "retain", count };
}

export function insert(text: string): InsertComponent {
  if (text.length === 0) throw new RangeError("insert text must be non-empty");
  return { type: "insert", text };
}

export function del(count: number): DeleteComponent {
  if (count <= 0) throw new RangeError(`delete count must be > 0, got ${count}`);
  return { type: "delete", count };
}

// ── Normalise ─────────────────────────────────────────────────────────────────

/**
 * Compress adjacent same-type components and strip no-ops (retain/delete 0).
 * Keeps the semantics identical while reducing component count.
 */
export function normalise(components: OtComponent[]): OtComponent[] {
  const out: OtComponent[] = [];
  for (const c of components) {
    const last = out[out.length - 1];
    if (c.type === "retain") {
      if (c.count <= 0) continue;
      if (last?.type === "retain") {
        out[out.length - 1] = { type: "retain", count: last.count + c.count };
      } else {
        out.push({ ...c });
      }
    } else if (c.type === "insert") {
      if (c.text.length === 0) continue;
      if (last?.type === "insert") {
        out[out.length - 1] = { type: "insert", text: last.text + c.text };
      } else {
        out.push({ ...c });
      }
    } else {
      // delete
      if (c.count <= 0) continue;
      if (last?.type === "delete") {
        out[out.length - 1] = { type: "delete", count: last.count + c.count };
      } else {
        out.push({ ...c });
      }
    }
  }
  return out;
}

// ── Apply ─────────────────────────────────────────────────────────────────────

/**
 * Apply an operation to a document string.
 *
 * @throws if the operation is inconsistent with the document length.
 */
export function apply(doc: string, op: OtOperation): string {
  let pos = 0;
  let out = "";
  for (const c of op.components) {
    if (c.type === "retain") {
      if (pos + c.count > doc.length) {
        throw new RangeError(
          `retain(${c.count}) at pos ${pos} exceeds document length ${doc.length}`,
        );
      }
      out += doc.slice(pos, pos + c.count);
      pos += c.count;
    } else if (c.type === "insert") {
      out += c.text;
    } else {
      if (pos + c.count > doc.length) {
        throw new RangeError(
          `delete(${c.count}) at pos ${pos} exceeds document length ${doc.length}`,
        );
      }
      pos += c.count;
    }
  }
  if (pos !== doc.length) {
    throw new RangeError(
      `operation covers ${pos} chars but document is ${doc.length} chars`,
    );
  }
  return out;
}

// ── Compose ───────────────────────────────────────────────────────────────────

/**
 * Compose two sequential operations into one equivalent operation.
 * `a` must have been applied first; `b` targets the result of `apply(doc, a)`.
 */
export function compose(a: OtOperation, b: OtOperation): OtOperation {
  const components = normalise(_composeComponents(a.components, b.components));
  // Merge clocks: take the max of each agent's timestamp.
  const clock: Record<string, number> = { ...a.clock };
  for (const [agent, t] of Object.entries(b.clock)) {
    clock[agent] = Math.max(clock[agent] ?? 0, t);
  }
  return {
    id: `${a.id}+${b.id}`,
    agentId: a.agentId,
    seq: a.seq,
    clock,
    components,
  };
}

/**
 * Compose components using a cursor-based "zipper" over the output-of-a /
 * input-of-b character stream.
 *
 * Key insight: `a` and `b` operate in different spaces.
 *   - `a` maps input doc → intermediate doc.
 *   - `b` maps intermediate doc → output doc.
 *
 * We walk the intermediate doc simultaneously from both sides, consuming
 * characters with a pair of "cursors" (one into `a`'s output, one into
 * `b`'s input).  Inserts from `a` enter the intermediate doc without being
 * consumed by `b`; inserts from `b` leave the intermediate doc without being
 * produced by `a`.
 */
function _composeComponents(a: OtComponent[], b: OtComponent[]): OtComponent[] {
  const out: OtComponent[] = [];

  // Work off flattened char-level queues to avoid partial-component arithmetic.
  // Each entry is a unit: "insert char", "retain 1", or "delete 1".
  // We use iterators over the logical character stream instead to keep it O(n).

  // ── Cursor state ──────────────────────────────────────────────────────────
  let ai = 0; // index into `a`
  let aOff = 0; // offset within a[ai] (for insert.text or retain/delete count)
  let bi = 0;
  let bOff = 0;

  /** Peek at `a`'s current component, accounting for aOff. */
  function peekA(): OtComponent | null {
    while (ai < a.length) {
      const c = a[ai];
      if (c.type === "insert" && aOff >= c.text.length) { ai++; aOff = 0; continue; }
      if (c.type !== "insert" && aOff >= c.count) { ai++; aOff = 0; continue; }
      return c;
    }
    return null;
  }

  /** Peek at `b`'s current component, accounting for bOff. */
  function peekB(): OtComponent | null {
    while (bi < b.length) {
      const c = b[bi];
      if (c.type === "insert" && bOff >= c.text.length) { bi++; bOff = 0; continue; }
      if (c.type !== "insert" && bOff >= c.count) { bi++; bOff = 0; continue; }
      return c;
    }
    return null;
  }

  while (true) {
    const ac = peekA();
    const bc = peekB();

    if (!ac && !bc) break;

    // ── a inserts (unconditionally output; b must account for it) ─────────
    if (ac?.type === "insert") {
      // b may retain or delete from a's inserted text.
      if (bc === null || bc.type === "retain") {
        // How many chars of the insert can we emit now?
        const aAvail = ac.text.length - aOff;
        const bAvail = bc ? bc.count - bOff : aAvail;
        const take = Math.min(aAvail, bAvail);
        out.push({ type: "insert", text: ac.text.slice(aOff, aOff + take) });
        aOff += take;
        if (bc) bOff += take;
        continue;
      } else if (bc.type === "delete") {
        // b deletes what a inserted — cancel.
        const aAvail = ac.text.length - aOff;
        const bAvail = bc.count - bOff;
        const take = Math.min(aAvail, bAvail);
        aOff += take;
        bOff += take;
        continue;
      }
    }

    // ── b inserts (unconditionally output) ────────────────────────────────
    if (bc?.type === "insert") {
      const bAvail = bc.text.length - bOff;
      out.push({ type: "insert", text: bc.text.slice(bOff, bOff + bAvail) });
      bOff += bAvail;
      continue;
    }

    // ── a deletes with b exhausted — trailing deletes must pass through ────
    if (ac?.type === "delete" && !bc) {
      const aAvail = ac.count - aOff;
      out.push({ type: "delete", count: aAvail });
      aOff += aAvail;
      continue;
    }

    if (!ac || !bc) break;
    // At this point neither is an insert (those branches continue above), so
    // both must be retain or delete — both have a `count` field.
    // Cast via unknown to satisfy TS since peekA/peekB return OtComponent.
    const acC = ac as RetainComponent | DeleteComponent;
    const bcC = bc as RetainComponent | DeleteComponent;

    // Both are retain or delete, operating on the same intermediate chars.
    const aAvail = acC.count - aOff;
    const bAvail = bcC.count - bOff;
    const take = Math.min(aAvail, bAvail);

    if (acC.type === "retain" && bcC.type === "retain") {
      out.push({ type: "retain", count: take });
    } else if (acC.type === "retain" && bcC.type === "delete") {
      out.push({ type: "delete", count: take });
    } else if (acC.type === "delete" && bcC.type === "retain") {
      out.push({ type: "delete", count: take });
    } else {
      // delete + delete: a already removed, b targets them — just skip.
    }

    aOff += take;
    bOff += take;
  }

  return out;
}

// ── Transform ─────────────────────────────────────────────────────────────────

/**
 * Operational transformation of two *concurrent* operations `a` and `b` that
 * both target the same document state.
 *
 * Returns `[a′, b′]` where:
 *   - `a′` can be applied after `b` (targets the result of applying `b`)
 *   - `b′` can be applied after `a` (targets the result of applying `a`)
 *
 * The "left wins on tie" convention: when both operations insert at the same
 * position, `a` (the local operation) is considered to have happened first.
 */
export function transform(a: OtOperation, b: OtOperation): [OtOperation, OtOperation] {
  const [aComps, bComps] = _transformComponents(a.components, b.components);
  const aPrime: OtOperation = {
    id: `${a.id}′`,
    agentId: a.agentId,
    seq: a.seq,
    clock: { ...b.clock, [b.agentId]: b.seq },
    components: normalise(aComps),
  };
  const bPrime: OtOperation = {
    id: `${b.id}′`,
    agentId: b.agentId,
    seq: b.seq,
    clock: { ...a.clock, [a.agentId]: a.seq },
    components: normalise(bComps),
  };
  return [aPrime, bPrime];
}

function _transformComponents(
  a: OtComponent[],
  b: OtComponent[],
): [OtComponent[], OtComponent[]] {
  const aPrime: OtComponent[] = [];
  const bPrime: OtComponent[] = [];
  let ai = 0;
  let bi = 0;
  let aRem = 0;
  let bRem = 0;

  while (ai < a.length || bi < b.length) {
    const ac = ai < a.length ? a[ai] : null;
    const bc = bi < b.length ? b[bi] : null;

    // ── insert on a ──
    if (ac?.type === "insert") {
      // a′: insert stays (b retained over a's insert position)
      aPrime.push({ ...ac });
      // b′: retain over a's inserted text
      bPrime.push({ type: "retain", count: ac.text.length });
      ai++;
      aRem = 0;
      continue;
    }

    // ── insert on b ──
    if (bc?.type === "insert") {
      // a′: retain over b's inserted text
      aPrime.push({ type: "retain", count: bc.text.length });
      // b′: insert stays
      bPrime.push({ ...bc });
      bi++;
      bRem = 0;
      continue;
    }

    if (!ac || !bc) break;

    const acLen = (ac.type === "retain" || ac.type === "delete") ? ac.count - aRem : 0;
    const bcLen = (bc.type === "retain" || bc.type === "delete") ? bc.count - bRem : 0;
    const take = Math.min(acLen, bcLen);

    if (ac.type === "retain" && bc.type === "retain") {
      aPrime.push({ type: "retain", count: take });
      bPrime.push({ type: "retain", count: take });
    } else if (ac.type === "retain" && bc.type === "delete") {
      // b deletes what a retains — a′ loses those chars, b′ drops the delete
      // (those chars are already gone in a's world).
      bPrime.push({ type: "delete", count: take });
      // a′ gets nothing (chars gone)
    } else if (ac.type === "delete" && bc.type === "retain") {
      aPrime.push({ type: "delete", count: take });
      // b′ gets nothing (chars gone)
    } else if (ac.type === "delete" && bc.type === "delete") {
      // Both delete the same chars — they cancel in both primes.
    }

    const { nextIdx: nai, nextRem: nar } = advance(ai, aRem, take, ac.count);
    ai = nai;
    aRem = nar;
    const { nextIdx: nbi, nextRem: nbr } = advance(bi, bRem, take, bc.count);
    bi = nbi;
    bRem = nbr;
  }

  return [aPrime, bPrime];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Advance index/remainder by `take` chars within a component of length `len`. */
function advance(
  idx: number,
  rem: number,
  take: number,
  len: number,
): { nextIdx: number; nextRem: number } {
  const consumed = rem + take;
  if (consumed >= len) {
    return { nextIdx: idx + 1, nextRem: 0 };
  }
  return { nextIdx: idx, nextRem: consumed };
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/**
 * Build an insert operation from a cursor position + text.
 *
 * @param docLength   Current length of the document.
 * @param offset      Character offset at which to insert.
 * @param text        Text to insert.
 * @param agentId     The agent performing the insert.
 * @param clock       The current vector clock before this operation.
 * @param seq         The agent's current sequence number.
 */
export function makeInsert(
  docLength: number,
  offset: number,
  text: string,
  agentId: string,
  clock: VectorClock,
  seq: number,
): OtOperation {
  if (offset < 0 || offset > docLength) {
    throw new RangeError(`offset ${offset} out of range [0, ${docLength}]`);
  }
  const components: OtComponent[] = [];
  if (offset > 0) components.push(retain(offset));
  components.push(insert(text));
  if (offset < docLength) components.push(retain(docLength - offset));
  return {
    id: `${agentId}:${seq}`,
    agentId,
    seq,
    clock,
    components,
  };
}

/**
 * Build a delete operation from a range [offset, offset+length).
 *
 * @param docLength   Current length of the document.
 * @param offset      Start of the range to delete.
 * @param length      Number of characters to delete.
 * @param agentId     The agent performing the delete.
 * @param clock       The current vector clock before this operation.
 * @param seq         The agent's current sequence number.
 */
export function makeDelete(
  docLength: number,
  offset: number,
  length: number,
  agentId: string,
  clock: VectorClock,
  seq: number,
): OtOperation {
  if (offset < 0 || length <= 0 || offset + length > docLength) {
    throw new RangeError(
      `delete range [${offset}, ${offset + length}) out of range for doc length ${docLength}`,
    );
  }
  const components: OtComponent[] = [];
  if (offset > 0) components.push(retain(offset));
  components.push(del(length));
  if (offset + length < docLength) components.push(retain(docLength - offset - length));
  return {
    id: `${agentId}:${seq}`,
    agentId,
    seq,
    clock,
    components,
  };
}

// ── Vector clock utilities ────────────────────────────────────────────────────

/** Increment an agent's entry in the clock. */
export function tickClock(clock: VectorClock, agentId: string): VectorClock {
  return { ...clock, [agentId]: (clock[agentId] ?? 0) + 1 };
}

/**
 * Returns true if `a` happened-before `b` (all entries of `a` ≤ `b`'s entries).
 */
export function happenedBefore(a: VectorClock, b: VectorClock): boolean {
  for (const [agent, t] of Object.entries(a)) {
    if ((b[agent] ?? 0) < t) return false;
  }
  return true;
}

/**
 * Returns true if `a` and `b` are concurrent (neither happened-before the other).
 */
export function concurrent(a: VectorClock, b: VectorClock): boolean {
  return !happenedBefore(a, b) && !happenedBefore(b, a);
}

// ── Summary extraction ────────────────────────────────────────────────────────

/**
 * Compute an `OperationSummary` for a given operation applied to `doc`.
 * Used by the UI to place margin badges on the affected lines.
 */
export function summarise(op: OtOperation, doc: string): OperationSummary {
  let pos = 0;
  let insertedChars = 0;
  let deletedChars = 0;
  let firstLine = -1;
  let lastLine = -1;

  const markLine = (charPos: number) => {
    const before = doc.slice(0, charPos);
    const line = (before.match(/\n/g) ?? []).length;
    if (firstLine === -1 || line < firstLine) firstLine = line;
    if (line > lastLine) lastLine = line;
  };

  for (const c of op.components) {
    if (c.type === "retain") {
      pos += c.count;
    } else if (c.type === "insert") {
      markLine(pos);
      insertedChars += c.text.length;
      // Also mark lines covered by the inserted text.
      const newlines = (c.text.match(/\n/g) ?? []).length;
      if (newlines > 0) {
        const endLine = firstLine + newlines;
        if (endLine > lastLine) lastLine = endLine;
      }
    } else {
      markLine(pos);
      deletedChars += c.count;
      pos += c.count;
    }
  }

  return {
    firstLine: Math.max(0, firstLine),
    lastLine: Math.max(0, lastLine),
    insertedChars,
    deletedChars,
  };
}
