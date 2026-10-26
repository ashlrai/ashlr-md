/**
 * undoStack.ts: the undo and redo of agent edits, per document.
 *
 * The editors' own undo (CodeMirror's history, Milkdown's) belongs to the
 * user's keystrokes, and an edit an agent writes into the document store
 * remounts or replaces the editor's text, so it is not in that history. An
 * agent edit is undone here instead, as one step, whatever the agent
 * changed.
 *
 * Each entry keeps the text before and after the edit and the structured
 * diff between them. Undo when the document is still exactly the edit's
 * result restores the text before it. When the user has typed since, the
 * edit's hunks are inverted and placed in the current text
 * (`applyHunksTo`), so the user's typing survives the undo; an edit whose
 * lines the user has since changed cannot be undone that way and is
 * reported as a conflict, with the document left as it is. Redo is the
 * same, the other way.
 *
 * The stack is bounded by entry count and by the text it holds; the oldest
 * entries go first.
 */

import {
  type AgentHunk,
  applyHunksTo,
  computeAgentDiff,
  invertHunk,
  type StructuredDiff,
} from "./agentEdit";

/** Who made an edit and what it was. */
export interface AgentEditMeta {
  /** The agent (an MCP client name, or "assistant" for the AI sidebar). */
  agentId: string;
  /** A short description for the history list and the undo toast. */
  label: string;
  /**
   * Edits of one group by one agent, each starting where the last ended,
   * coalesce into one entry (an agent's multi-step edit undoes as one).
   */
  group?: string;
}

export interface AgentEditEntry extends AgentEditMeta {
  id: string;
  /** When the edit was recorded (ms since the epoch). */
  at: number;
  /** The document text before the edit. */
  before: string;
  /** The document text the edit produced. */
  after: string;
  /** The diff from `before` to `after`. */
  diff: StructuredDiff;
}

export type HistoryOutcome =
  | {
      ok: true;
      /** The document text after the undo or redo. */
      text: string;
      entry: AgentEditEntry;
      /** True when the document had changed since and the hunks were placed
       * in the current text rather than the stored one restored. */
      rebased: boolean;
    }
  | {
      ok: false;
      reason: "empty" | "conflict";
      /** The entry that could not be undone or redone (none when empty). */
      entry?: AgentEditEntry;
      /** For a conflict: the hunks whose lines have changed since. */
      conflicts?: string[];
    };

export interface UndoStackOptions {
  /** Most entries kept. Default 100. */
  limit?: number;
  /** Most text kept, in UTF-16 code units, over all entries. Default 16 Mi. */
  maxChars?: number;
  /** Coalesce a group's edits made within this many ms. Default 2000. */
  coalesceMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_CHARS = 16 * 1024 * 1024;
const DEFAULT_COALESCE_MS = 2000;

let nextEntryId = 1;

export class AgentUndoStack {
  private undoEntries: AgentEditEntry[] = [];
  private redoEntries: AgentEditEntry[] = [];
  private readonly limit: number;
  private readonly maxChars: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;

  constructor(opts: UndoStackOptions = {}) {
    this.limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    this.maxChars = Math.max(0, opts.maxChars ?? DEFAULT_MAX_CHARS);
    this.coalesceMs = Math.max(0, opts.coalesceMs ?? DEFAULT_COALESCE_MS);
    this.now = opts.now ?? Date.now;
  }

  get canUndo(): boolean {
    return this.undoEntries.length > 0;
  }

  get canRedo(): boolean {
    return this.redoEntries.length > 0;
  }

  get undoDepth(): number {
    return this.undoEntries.length;
  }

  get redoDepth(): number {
    return this.redoEntries.length;
  }

  /** The entry the next undo would undo. */
  peekUndo(): AgentEditEntry | undefined {
    return this.undoEntries[this.undoEntries.length - 1];
  }

  /** The entry the next redo would redo. */
  peekRedo(): AgentEditEntry | undefined {
    return this.redoEntries[this.redoEntries.length - 1];
  }

  /** The undoable entries, oldest first. */
  history(): readonly AgentEditEntry[] {
    return [...this.undoEntries];
  }

  /**
   * Record an edit that changed `before` into `after`. Returns its entry
   * (the one it was coalesced into, when it was), or `null` when nothing
   * changed. A new edit clears the redo stack: redoing past it would
   * replay edits over text they were not made for.
   */
  record(before: string, after: string, meta: AgentEditMeta): AgentEditEntry | null {
    if (before === after) return null;
    const at = this.now();
    this.redoEntries = [];

    const top = this.peekUndo();
    if (
      top &&
      meta.group !== undefined &&
      top.group === meta.group &&
      top.agentId === meta.agentId &&
      top.after === before &&
      at - top.at <= this.coalesceMs
    ) {
      if (top.before === after) {
        // The group's edits cancel out: nothing is left to undo.
        this.undoEntries.pop();
        return null;
      }
      const merged: AgentEditEntry = {
        ...top,
        label: meta.label,
        at,
        after,
        diff: computeAgentDiff(top.before, after),
      };
      this.undoEntries[this.undoEntries.length - 1] = merged;
      this.trim();
      return merged;
    }

    const entry: AgentEditEntry = {
      ...meta,
      id: `agent-edit-${nextEntryId++}`,
      at,
      before,
      after,
      diff: computeAgentDiff(before, after),
    };
    this.undoEntries.push(entry);
    this.trim();
    return entry;
  }

  /**
   * Undo the last agent edit against `current`, the document's text now.
   * On success the entry moves to the redo stack; on a conflict both
   * stacks are left as they were.
   */
  undo(current: string): HistoryOutcome {
    const entry = this.peekUndo();
    if (!entry) return { ok: false, reason: "empty" };
    const outcome = step(
      current,
      entry.after,
      entry.before,
      invertAll(entry.diff.hunks),
    );
    if (!outcome.ok)
      return { ok: false, reason: "conflict", entry, conflicts: outcome.conflicts };
    this.undoEntries.pop();
    this.redoEntries.push(entry);
    return { ok: true, text: outcome.text, entry, rebased: outcome.rebased };
  }

  /** Redo the last undone agent edit against `current`; see {@link undo}. */
  redo(current: string): HistoryOutcome {
    const entry = this.peekRedo();
    if (!entry) return { ok: false, reason: "empty" };
    const outcome = step(current, entry.before, entry.after, entry.diff.hunks);
    if (!outcome.ok)
      return { ok: false, reason: "conflict", entry, conflicts: outcome.conflicts };
    this.redoEntries.pop();
    this.undoEntries.push(entry);
    return { ok: true, text: outcome.text, entry, rebased: outcome.rebased };
  }

  /** Forget every entry. */
  clear(): void {
    this.undoEntries = [];
    this.redoEntries = [];
  }

  /**
   * Drop the oldest entries past the count and size bounds. Called only
   * from {@link record}, which has just emptied the redo stack, so only
   * undo entries are counted.
   */
  private trim(): void {
    const size = (e: AgentEditEntry) => e.before.length + e.after.length;
    let total = 0;
    for (const e of this.undoEntries) total += size(e);
    // The newest entry is always kept, however large: an edit that cannot
    // be undone at all would be worse than one entry over the bound.
    while (
      this.undoEntries.length > 1 &&
      (this.undoEntries.length > this.limit || total > this.maxChars)
    ) {
      const dropped = this.undoEntries.shift();
      if (dropped) total -= size(dropped);
    }
  }
}

function invertAll(hunks: readonly AgentHunk[]): AgentHunk[] {
  return hunks.map(invertHunk);
}

/**
 * The text that takes `current` from `from` to `to`: `to` itself when the
 * document is still `from`, else `hunks` placed in `current`.
 */
function step(
  current: string,
  from: string,
  to: string,
  hunks: readonly AgentHunk[],
): { ok: true; text: string; rebased: boolean } | { ok: false; conflicts: string[] } {
  if (current === from) return { ok: true, text: to, rebased: false };
  const placed = applyHunksTo(current, hunks);
  if (!placed.ok) return placed;
  return { ok: true, text: placed.text, rebased: true };
}

/**
 * An undo stack per document, keyed by its path. A document's stack is
 * made on first use.
 */
export class AgentEditHistory {
  private readonly stacks = new Map<string, AgentUndoStack>();

  constructor(private readonly opts: UndoStackOptions = {}) {}

  /** The stack of `docKey`, made when it has none. */
  stack(docKey: string): AgentUndoStack {
    let s = this.stacks.get(docKey);
    if (!s) {
      s = new AgentUndoStack(this.opts);
      this.stacks.set(docKey, s);
    }
    return s;
  }

  /** The stack of `docKey` when it has one (no stack is made). */
  peek(docKey: string): AgentUndoStack | undefined {
    return this.stacks.get(docKey);
  }

  /** A document renamed or moved keeps its history under its new path. */
  rename(from: string, to: string): void {
    const s = this.stacks.get(from);
    if (!s || from === to) return;
    this.stacks.delete(from);
    this.stacks.set(to, s);
  }

  /** Forget `docKey`'s history (its tab closed, or it was reloaded from disk). */
  forget(docKey: string): void {
    this.stacks.delete(docKey);
  }

  clear(): void {
    this.stacks.clear();
  }
}
