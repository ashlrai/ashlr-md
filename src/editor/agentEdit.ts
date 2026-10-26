/**
 * agentEdit.ts: structured diffs for agent edit mode.
 *
 * An agent proposes a new text for a document (the whole text, or a list of
 * find/replace edits that produce it). {@link computeAgentDiff} turns the
 * proposal into hunks: each hunk is one change, the lines it removes from
 * the base text and the lines it adds, with up to `context` unchanged lines
 * on each side. The user accepts or rejects hunks one by one;
 * {@link applySelectedHunks} builds the text with only the accepted ones.
 *
 * The document can change while a proposal waits (the user keeps typing).
 * {@link applyHunksTo} then finds each hunk again by its removed lines and
 * its context, near where it was, in the way `patch` does: full context
 * first, then with the outer context lines dropped one at a time. A hunk it
 * cannot place, or can place in two places equally well, is a conflict,
 * and nothing is applied: half a patch is worse than none.
 *
 * Every function here is pure: no store, no editor, no I/O.
 */

import {
  applyEditAtOccurrence,
  applyUniqueEdit,
  inDocumentStyle,
} from "../mcp/applyEdit";
import { DEFAULT_MAX_EDITS, diffLines, splitLines } from "./lineDiff";

// ── Types ────────────────────────────────────────────────────────────────────

/** One change between a base text and a proposed text. */
export interface AgentHunk {
  /** Unique within its diff (`hunk-1`, `hunk-2`, ...), in document order. */
  id: string;
  /** 0-based index of the first removed line in the base (or of the line the
   * insertion goes before, for a pure insertion). */
  oldStart: number;
  /** Lines removed from the base, each with its line break. */
  oldLines: string[];
  /** 0-based index of the first added line in the proposed text. */
  newStart: number;
  /** Lines added, each with its line break. */
  newLines: string[];
  /** Unchanged lines just before the change (at most `context`, and none
   * that another hunk of the diff changes). */
  before: string[];
  /** Unchanged lines just after the change (likewise). */
  after: string[];
}

export interface DiffStats {
  hunks: number;
  added: number;
  removed: number;
}

/** The hunks from `base` to `proposed`. */
export interface StructuredDiff {
  base: string;
  proposed: string;
  hunks: AgentHunk[];
  stats: DiffStats;
}

export interface DiffOptions {
  /** Unchanged lines kept on each side of a hunk (default 3, as `git diff`). */
  context?: number;
  /** Edit distance searched before a coarse diff (see `diffLines`). */
  maxEdits?: number;
}

export const DEFAULT_CONTEXT = 3;

// ── Diff ─────────────────────────────────────────────────────────────────────

/** The structured diff from `base` to `proposed`. */
export function computeAgentDiff(
  base: string,
  proposed: string,
  opts: DiffOptions = {},
): StructuredDiff {
  const context = Math.max(0, opts.context ?? DEFAULT_CONTEXT);
  const a = splitLines(base);
  const b = splitLines(proposed);
  const ops = diffLines(a, b, opts.maxEdits ?? DEFAULT_MAX_EDITS);

  const hunks: AgentHunk[] = [];
  let ai = 0;
  let bi = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === "equal") {
      ai += op.lines.length;
      bi += op.lines.length;
      continue;
    }
    // A change is a delete, an insert, or a delete then an insert.
    const oldLines = op.kind === "delete" ? op.lines : [];
    let newLines = op.kind === "insert" ? op.lines : [];
    if (op.kind === "delete" && ops[i + 1]?.kind === "insert") {
      newLines = ops[i + 1].lines;
      i++;
    }
    hunks.push({
      id: `hunk-${hunks.length + 1}`,
      oldStart: ai,
      oldLines,
      newStart: bi,
      newLines,
      before: [],
      after: [],
    });
    ai += oldLines.length;
    bi += newLines.length;
  }
  // Context is only the unchanged lines between a hunk and its neighbours,
  // never lines another hunk changes: those read the same in the base and
  // the proposed text, so the context also anchors the inverted hunk (undo).
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    const prevEnd = i > 0 ? hunks[i - 1].oldStart + hunks[i - 1].oldLines.length : 0;
    const end = h.oldStart + h.oldLines.length;
    const nextStart = i + 1 < hunks.length ? hunks[i + 1].oldStart : a.length;
    h.before = a.slice(Math.max(prevEnd, h.oldStart - context), h.oldStart);
    h.after = a.slice(end, Math.min(nextStart, end + context));
  }

  return {
    base,
    proposed,
    hunks,
    stats: {
      hunks: hunks.length,
      added: hunks.reduce((n, h) => n + h.newLines.length, 0),
      removed: hunks.reduce((n, h) => n + h.oldLines.length, 0),
    },
  };
}

/**
 * The hunk that undoes `hunk`: it removes what `hunk` added and adds back
 * what it removed. Its context is the same lines, which `hunk` left as they
 * were.
 */
export function invertHunk(hunk: AgentHunk): AgentHunk {
  return {
    ...hunk,
    oldStart: hunk.newStart,
    oldLines: hunk.newLines,
    newStart: hunk.oldStart,
    newLines: hunk.oldLines,
  };
}

// ── Apply against the base ───────────────────────────────────────────────────

/**
 * `diff.base` with only the hunks whose ids are in `accepted` applied. All
 * of them gives `diff.proposed`; none gives `diff.base`.
 */
export function applySelectedHunks(
  diff: StructuredDiff,
  accepted: ReadonlySet<string>,
): string {
  const lines = splitLines(diff.base);
  const out: string[] = [];
  let at = 0;
  for (const h of diff.hunks) {
    for (; at < h.oldStart; at++) out.push(lines[at]);
    // Large rewrites can exceed the engine's function argument limit.
    for (const line of accepted.has(h.id) ? h.newLines : h.oldLines) out.push(line);
    at = h.oldStart + h.oldLines.length;
  }
  for (; at < lines.length; at++) out.push(lines[at]);
  return out.join("");
}

// ── Apply against a changed document ─────────────────────────────────────────

export type ApplyHunksResult =
  | {
      ok: true;
      text: string;
      /** True when some hunk was not where its diff put it. */
      relocated: boolean;
    }
  | {
      ok: false;
      /** Ids of the hunks that could not be placed. */
      conflicts: string[];
    };

/** Where a hunk was found: its removed lines start at `at`. */
interface Placement {
  hunk: AgentHunk;
  at: number;
}

/**
 * Apply `hunks` (in document order, as a diff lists them) to `current`. A
 * hunk goes where its diff put it when its removed lines and context are
 * there; otherwise it is looked for nearby, with less context as needed
 * ({@link locateHunk}). The text is changed only when every hunk is placed
 * and no two overlap.
 */
export function applyHunksTo(
  current: string,
  hunks: readonly AgentHunk[],
): ApplyHunksResult {
  const lines = splitLines(current);
  const placed: Placement[] = [];
  const conflicts: string[] = [];
  // How far the document has moved since the diff, read from the last hunk
  // placed: the next one is looked for that much further down.
  let drift = 0;
  let floor = 0;
  let relocated = false;
  for (const hunk of hunks) {
    const at = locateHunk(lines, hunk, hunk.oldStart + drift, floor);
    if (at === null) {
      conflicts.push(hunk.id);
      continue;
    }
    if (at !== hunk.oldStart) relocated = true;
    placed.push({ hunk, at });
    drift = at - hunk.oldStart;
    floor = at + hunk.oldLines.length;
  }
  if (conflicts.length > 0) return { ok: false, conflicts };

  const out: string[] = [];
  let at = 0;
  for (const p of placed) {
    for (; at < p.at; at++) out.push(lines[at]);
    for (const line of p.hunk.newLines) out.push(line);
    at = p.at + p.hunk.oldLines.length;
  }
  for (; at < lines.length; at++) out.push(lines[at]);
  return { ok: true, text: out.join(""), relocated };
}

/**
 * The line where `hunk`'s removed lines start in `lines`, at or after
 * `floor` (so hunks stay in order and do not overlap), or `null`.
 *
 * Fuzz 0 needs every context line to match; each further level drops one
 * line from the outer end of each side. At each level the match nearest to
 * `hint` wins; two equally near is ambiguous and the hunk is not placed. A
 * pure insertion (no removed lines) needs at least one context line to
 * match. One with no context at all (a diff made with `context: 0`, or an
 * insertion into an empty base) has nothing to look for, so it goes at
 * `hint`, as `patch` places a zero-context hunk by its line number.
 */
export function locateHunk(
  lines: readonly string[],
  hunk: AgentHunk,
  hint: number,
  floor = 0,
): number | null {
  const { oldLines, before, after } = hunk;
  const maxFuzz = Math.max(before.length, after.length);
  const anchorless = oldLines.length === 0 && before.length === 0 && after.length === 0;
  if (anchorless) return Math.min(Math.max(hint, floor, 0), lines.length);

  const lastStart = lines.length - oldLines.length;
  for (let fuzz = 0; fuzz <= maxFuzz; fuzz++) {
    const needBefore = Math.max(0, before.length - fuzz);
    const needAfter = Math.max(0, after.length - fuzz);
    if (oldLines.length === 0 && needBefore === 0 && needAfter === 0) break;

    let best: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    let tie = false;
    const wantBefore = before.slice(before.length - needBefore);
    const wantAfter = after.slice(0, needAfter);
    for (let at = Math.max(0, floor); at <= lastStart; at++) {
      // Past the hint, later candidates can neither beat nor tie this match.
      if (at > hint && at - hint > bestDist) break;
      if (!matchesAt(lines, oldLines, at)) continue;
      if (!matchesAt(lines, wantBefore, at - needBefore)) continue;
      if (!matchesAt(lines, wantAfter, at + oldLines.length)) continue;
      const dist = Math.abs(at - hint);
      if (dist === 0) return at;
      if (dist < bestDist) {
        best = at;
        bestDist = dist;
        tie = false;
      } else if (dist === bestDist) {
        tie = true;
      }
    }
    if (best !== null) return tie ? null : best;
  }
  return null;
}

function matchesAt(
  lines: readonly string[],
  want: readonly string[],
  at: number,
): boolean {
  if (at < 0 || at + want.length > lines.length) return false;
  for (let i = 0; i < want.length; i++) {
    if (lines[at + i] !== want[i]) return false;
  }
  return true;
}

// ── Proposals from find/replace edits ────────────────────────────────────────

/** One find/replace edit of a proposal, as the MCP `edit` tools take them. */
export interface FindReplaceEdit {
  find: string;
  replace: string;
  /** Which occurrence of `find` (0-based); omitted means `find` must be unique. */
  matchIndex?: number;
}

export type ProposalTextResult =
  | { ok: true; text: string }
  | { ok: false; error: string; editIndex: number };

/**
 * The text `edits` make of `base`, applied in order (each to the result of
 * the one before), with the MCP edit rules: `find` must match exactly once,
 * or at `matchIndex`, and a line break matches LF or CRLF. One edit that
 * fails fails the proposal, with its index and reason.
 */
export function proposalFromEdits(
  base: string,
  edits: readonly FindReplaceEdit[],
): ProposalTextResult {
  if (edits.length === 0) {
    return { ok: false, error: "A proposal needs at least one edit.", editIndex: -1 };
  }
  let text = base;
  for (let i = 0; i < edits.length; i++) {
    const { find, replace, matchIndex } = edits[i];
    const outcome =
      matchIndex === undefined
        ? applyUniqueEdit(text, find, replace)
        : applyEditAtOccurrence(text, find, replace, matchIndex);
    if (!outcome.ok || outcome.content === undefined) {
      return {
        ok: false,
        error: `Edit ${i + 1} of ${edits.length}: ${outcome.error ?? "not applied."}`,
        editIndex: i,
      };
    }
    text = outcome.content;
  }
  return { ok: true, text };
}

/**
 * A whole proposed text in the style of `base`: an agent writes LF and no
 * byte order mark, so every line of a CRLF document would read as changed.
 */
export function proposalInDocumentStyle(base: string, proposed: string): string {
  return inDocumentStyle(base, proposed);
}

// ── Unified diff rendering ───────────────────────────────────────────────────

/** A line of a unified diff body: its text without its line break. */
function bodyLine(prefix: string, line: string, out: string[]): void {
  const text = line.replace(/\r\n$|\n$|\r$/, "");
  out.push(prefix + text);
  if (text === line) out.push("\\ No newline at end of file");
}

/**
 * `diff` as a unified diff (`git diff` style, with `context` lines around
 * each change): what an agent or a reviewer reads, and what the app's diff
 * viewer (`parseDiffHunks`) takes. Hunks whose contexts meet are written as
 * one. With `only`, just those hunks are written: the diff from the base
 * to `applySelectedHunks(diff, only)`.
 */
export function renderUnifiedDiff(
  diff: StructuredDiff,
  label = "document",
  opts: { context?: number; only?: ReadonlySet<string> } = {},
): string {
  const context = Math.max(0, opts.context ?? DEFAULT_CONTEXT);
  const a = splitLines(diff.base);
  const hunks = opts.only ? diff.hunks.filter((h) => opts.only?.has(h.id)) : diff.hunks;
  if (hunks.length === 0) return "";

  // Group hunks whose context windows touch, as git does.
  const groups: AgentHunk[][] = [];
  for (const h of hunks) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && h.oldStart - (prev.oldStart + prev.oldLines.length) <= 2 * context) {
      last.push(h);
    } else {
      groups.push([h]);
    }
  }

  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
  // The new side's line numbers move by what the earlier written hunks
  // added or removed: the diff is the one from the base to the base with
  // the written hunks applied.
  const shift = new Map<string, number>();
  let delta = 0;
  for (const h of hunks) {
    shift.set(h.id, delta);
    delta += h.newLines.length - h.oldLines.length;
  }

  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    const start = Math.max(0, first.oldStart - context);
    const end = Math.min(a.length, last.oldStart + last.oldLines.length + context);
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let at = start;
    for (const h of group) {
      for (; at < h.oldStart; at++, oldCount++, newCount++) bodyLine(" ", a[at], body);
      for (const l of h.oldLines) bodyLine("-", l, body);
      for (const l of h.newLines) bodyLine("+", l, body);
      oldCount += h.oldLines.length;
      newCount += h.newLines.length;
      at = h.oldStart + h.oldLines.length;
    }
    for (; at < end; at++, oldCount++, newCount++) bodyLine(" ", a[at], body);

    const newStart = start + (shift.get(first.id) ?? 0);
    out.push(`@@ -${rangeOf(start, oldCount)} +${rangeOf(newStart, newCount)} @@`);
    for (const line of body) out.push(line);
  }
  return `${out.join("\n")}\n`;
}

/** A unified diff range: `L,N` 1-based, and for an empty side the line before. */
function rangeOf(start0: number, count: number): string {
  return count === 0 ? `${start0},0` : `${start0 + 1},${count}`;
}
