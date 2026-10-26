/**
 * agentEditMode.ts: the state of agent edit mode.
 *
 * In agent edit mode an agent's change to a document is not written at
 * once. It becomes a proposal: the structured diff from the document's
 * text to the agent's (see `agentEdit.ts`), one hunk per change. The user
 * accepts or rejects each hunk, then commits; only the accepted hunks are
 * written, as one edit on the agent undo stack (`undoStack.ts`), so the
 * whole of it undoes in one step whatever the user typed after it. In
 * `auto` mode a change is written at once, and still undoes in one step.
 *
 * The store holds at most one proposal per document (a newer one from any
 * agent replaces it) and knows documents only by key (their path). It
 * never reads or writes a document: callers pass the document's text in
 * and write the text it answers (`documentAgentEdit.ts` does that for the
 * open document).
 */

import { create } from "zustand";
import {
  applyHunksTo,
  applySelectedHunks,
  computeAgentDiff,
  type DiffOptions,
  type FindReplaceEdit,
  proposalFromEdits,
  proposalInDocumentStyle,
  type StructuredDiff,
} from "./agentEdit";
import {
  type AgentEditEntry,
  AgentEditHistory,
  type AgentEditMeta,
  type HistoryOutcome,
} from "./undoStack";

/** `review`: an agent's change waits for the user. `auto`: written at once. */
export type AgentEditModeKind = "review" | "auto";

export type HunkDecision = "pending" | "accepted" | "rejected";

export interface AgentProposal extends AgentEditMeta {
  id: string;
  docKey: string;
  /** When it was proposed (ms since the epoch). */
  createdAt: number;
  diff: StructuredDiff;
  /** Each hunk's decision, by hunk id. Every hunk starts `pending`. */
  decisions: Record<string, HunkDecision>;
}

/** What an agent proposes: the whole new text, or edits that make it. */
export type ProposalInput = AgentEditMeta & {
  docKey: string;
  /** The document's text the proposal is made against. */
  base: string;
  diffOptions?: DiffOptions;
} & (
    | { proposed: string; edits?: undefined }
    | { edits: FindReplaceEdit[]; proposed?: undefined }
  );

export type ProposeResult =
  | { ok: true; proposal: AgentProposal }
  | { ok: false; error: string; editIndex?: number };

export type CommitResult =
  | {
      ok: true;
      /** The document text to write (the text passed in when nothing was accepted). */
      text: string;
      /** The undo entry, or `null` when nothing was written. */
      entry: AgentEditEntry | null;
      /** Hunks written. */
      applied: number;
      /** True when the document had changed since the proposal and the
       * accepted hunks were placed in its current text. */
      rebased: boolean;
    }
  | {
      ok: false;
      reason: "no-proposal" | "conflict";
      error: string;
      /** For a conflict: the accepted hunks whose lines have changed since. */
      conflicts?: string[];
    };

/** Undo and redo depth of a document, for the UI. */
export interface HistoryDepth {
  undo: number;
  redo: number;
}

export interface AgentEditState {
  mode: AgentEditModeKind;
  /** The pending proposal of each document, by key. */
  proposals: Record<string, AgentProposal>;
  /** Each document's undo and redo depth, by key (absent: nothing to undo). */
  depth: Record<string, HistoryDepth>;

  setMode: (mode: AgentEditModeKind) => void;
  /** Make a proposal (replacing the document's pending one). */
  propose: (input: ProposalInput) => ProposeResult;
  /** Decide one hunk. False when there is no such proposal or hunk. */
  decide: (docKey: string, hunkId: string, decision: HunkDecision) => boolean;
  /** Decide every hunk of a proposal. False when there is none. */
  decideAll: (docKey: string, decision: HunkDecision) => boolean;
  /** The proposal's base with its accepted hunks applied, or `null`. */
  preview: (docKey: string) => string | null;
  /**
   * Write the accepted hunks into `current`, the document's text now, and
   * record them as one undoable edit. The proposal is done with (pending
   * and rejected hunks are dropped), except on a conflict, when it stays
   * for the user to reject the conflicting hunks or discard it.
   */
  commit: (docKey: string, current: string) => CommitResult;
  /** Drop a document's proposal unwritten. */
  discard: (docKey: string) => void;
  /**
   * Record an agent edit written without review (`auto` mode, or an MCP
   * edit), so it undoes in one step. Returns its entry, or `null` when
   * the text did not change.
   */
  record: (
    docKey: string,
    before: string,
    after: string,
    meta: AgentEditMeta,
  ) => AgentEditEntry | null;
  /** Undo the document's last agent edit against `current`. */
  undo: (docKey: string, current: string) => HistoryOutcome;
  /** Redo the document's last undone agent edit against `current`. */
  redo: (docKey: string, current: string) => HistoryOutcome;
  /** Undoable entries of a document, oldest first. */
  historyOf: (docKey: string) => readonly AgentEditEntry[];
  /** A document renamed or moved keeps its proposal and history. */
  renameDoc: (from: string, to: string) => void;
  /** Forget a document's proposal and history. */
  forgetDoc: (docKey: string) => void;
}

export interface AgentEditStoreOptions {
  history?: AgentEditHistory;
  now?: () => number;
}

/** A new agent edit store (the app uses {@link useAgentEditStore}). */
export function createAgentEditStore(opts: AgentEditStoreOptions = {}) {
  const history = opts.history ?? new AgentEditHistory();
  const now = opts.now ?? Date.now;
  let nextProposalId = 1;

  return create<AgentEditState>((set, get) => {
    const depthOf = (docKey: string): HistoryDepth | null => {
      const s = history.peek(docKey);
      return s && (s.undoDepth > 0 || s.redoDepth > 0)
        ? { undo: s.undoDepth, redo: s.redoDepth }
        : null;
    };
    const withDepth = (
      depth: Record<string, HistoryDepth>,
      docKey: string,
    ): Record<string, HistoryDepth> => {
      const { [docKey]: _, ...rest } = depth;
      const d = depthOf(docKey);
      return d ? { ...rest, [docKey]: d } : rest;
    };
    const syncDepth = (docKey: string) =>
      set((s) => ({ depth: withDepth(s.depth, docKey) }));
    const withoutProposal = (docKey: string) => {
      const { [docKey]: _, ...rest } = get().proposals;
      return rest;
    };

    return {
      mode: "review",
      proposals: {},
      depth: {},

      setMode: (mode) => set({ mode }),

      propose: (input) => {
        let proposed: string;
        if (input.edits !== undefined) {
          const made = proposalFromEdits(input.base, input.edits);
          if (!made.ok)
            return { ok: false, error: made.error, editIndex: made.editIndex };
          proposed = made.text;
        } else {
          proposed = proposalInDocumentStyle(input.base, input.proposed);
        }
        if (proposed === input.base) {
          return { ok: false, error: "The proposal does not change the document." };
        }
        const diff = computeAgentDiff(input.base, proposed, input.diffOptions);
        const proposal: AgentProposal = {
          id: `proposal-${nextProposalId++}`,
          docKey: input.docKey,
          agentId: input.agentId,
          label: input.label,
          ...(input.group !== undefined ? { group: input.group } : {}),
          createdAt: now(),
          diff,
          decisions: Object.fromEntries(
            diff.hunks.map((h) => [h.id, "pending" as const]),
          ),
        };
        set((s) => ({ proposals: { ...s.proposals, [input.docKey]: proposal } }));
        return { ok: true, proposal };
      },

      decide: (docKey, hunkId, decision) => {
        const p = get().proposals[docKey];
        if (!p || !(hunkId in p.decisions)) return false;
        set((s) => ({
          proposals: {
            ...s.proposals,
            [docKey]: { ...p, decisions: { ...p.decisions, [hunkId]: decision } },
          },
        }));
        return true;
      },

      decideAll: (docKey, decision) => {
        const p = get().proposals[docKey];
        if (!p) return false;
        const decisions = Object.fromEntries(
          Object.keys(p.decisions).map((id) => [id, decision]),
        );
        set((s) => ({ proposals: { ...s.proposals, [docKey]: { ...p, decisions } } }));
        return true;
      },

      preview: (docKey) => {
        const p = get().proposals[docKey];
        return p ? applySelectedHunks(p.diff, acceptedOf(p)) : null;
      },

      commit: (docKey, current) => {
        const p = get().proposals[docKey];
        if (!p) {
          return {
            ok: false,
            reason: "no-proposal",
            error: "There is no agent proposal for this document.",
          };
        }
        const accepted = acceptedOf(p);
        if (accepted.size === 0) {
          set({ proposals: withoutProposal(docKey) });
          return { ok: true, text: current, entry: null, applied: 0, rebased: false };
        }

        let text: string;
        let rebased = false;
        if (current === p.diff.base) {
          text = applySelectedHunks(p.diff, accepted);
        } else {
          const placed = applyHunksTo(
            current,
            p.diff.hunks.filter((h) => accepted.has(h.id)),
          );
          if (!placed.ok) {
            return {
              ok: false,
              reason: "conflict",
              error: conflictMessage(placed.conflicts.length),
              conflicts: placed.conflicts,
            };
          }
          text = placed.text;
          rebased = true;
        }

        const meta: AgentEditMeta = {
          agentId: p.agentId,
          label: p.label,
          ...(p.group !== undefined ? { group: p.group } : {}),
        };
        const entry = history.stack(docKey).record(current, text, meta);
        set((s) => ({
          proposals: withoutProposal(docKey),
          depth: withDepth(s.depth, docKey),
        }));
        return { ok: true, text, entry, applied: accepted.size, rebased };
      },

      discard: (docKey) => {
        if (get().proposals[docKey]) set({ proposals: withoutProposal(docKey) });
      },

      record: (docKey, before, after, meta) => {
        const entry = history.stack(docKey).record(before, after, meta);
        syncDepth(docKey);
        return entry;
      },

      undo: (docKey, current) => {
        const s = history.peek(docKey);
        const outcome: HistoryOutcome = s
          ? s.undo(current)
          : { ok: false, reason: "empty" };
        if (outcome.ok) syncDepth(docKey);
        return outcome;
      },

      redo: (docKey, current) => {
        const s = history.peek(docKey);
        const outcome: HistoryOutcome = s
          ? s.redo(current)
          : { ok: false, reason: "empty" };
        if (outcome.ok) syncDepth(docKey);
        return outcome;
      },

      historyOf: (docKey) => history.peek(docKey)?.history() ?? [],

      renameDoc: (from, to) => {
        if (from === to) return;
        history.rename(from, to);
        set((s) => {
          const { [from]: moved, ...proposals } = s.proposals;
          const { [from]: _, ...depth } = s.depth;
          return {
            proposals: moved
              ? { ...proposals, [to]: { ...moved, docKey: to } }
              : proposals,
            depth: withDepth(depth, to),
          };
        });
      },

      forgetDoc: (docKey) => {
        history.forget(docKey);
        set((s) => ({
          proposals: withoutProposal(docKey),
          depth: withDepth(s.depth, docKey),
        }));
      },
    };
  });
}

function acceptedOf(p: AgentProposal): Set<string> {
  return new Set(
    Object.entries(p.decisions)
      .filter(([, d]) => d === "accepted")
      .map(([id]) => id),
  );
}

function conflictMessage(n: number): string {
  return n === 1
    ? "One accepted change no longer matches the document: its lines were edited since the proposal. Reject it or discard the proposal."
    : `${n} accepted changes no longer match the document: their lines were edited since the proposal. Reject them or discard the proposal.`;
}

/** The app's agent edit store. */
export const useAgentEditStore = createAgentEditStore();
