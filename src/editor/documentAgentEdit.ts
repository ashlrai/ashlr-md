/**
 * documentAgentEdit.ts: agent edit mode on the open document.
 *
 * The glue between the agent edit store (`agentEditMode.ts`) and the
 * document store: each function reads the open document's live text (the
 * editors report what was just typed first, see `lib/pendingEdits.ts`),
 * runs the store's step against it, and writes the text it answers with
 * `setContent`. A document is known by its path; with no document open
 * (the welcome screen) every function refuses, as the MCP edits do.
 */

import { flushPendingEdits } from "../lib/pendingEdits";
import { useDocumentStore } from "../store/documentStore";
import type { DiffOptions, FindReplaceEdit } from "./agentEdit";
import {
  type AgentEditState,
  type CommitResult,
  type ProposalInput,
  type ProposeResult,
  useAgentEditStore,
} from "./agentEditMode";
import type { AgentEditEntry, AgentEditMeta, HistoryOutcome } from "./undoStack";

type AgentEditStore = { getState: () => AgentEditState };

/** What every function answers when no document is open. */
export const NO_OPEN_DOCUMENT = "No document is open; open one first.";

/** The open document's path and live text, or `null` when none is open. */
export function liveDocument(): { key: string; content: string } | null {
  flushPendingEdits();
  const { path, content } = useDocumentStore.getState();
  return path ? { key: path, content } : null;
}

/** Write `text` into the open document when it changes it. */
function write(current: string, text: string): void {
  if (text !== current) useDocumentStore.getState().setContent(text);
}

/** An agent's change: the whole new text, or find/replace edits. */
export type AgentChange = AgentEditMeta & { diffOptions?: DiffOptions } & (
    | { proposed: string; edits?: undefined }
    | { edits: FindReplaceEdit[]; proposed?: undefined }
  );

export type SubmitResult =
  | {
      ok: true;
      /** `proposed`: waiting for review. `applied`: written (auto mode). */
      status: "proposed" | "applied";
      proposalId?: string;
      entry?: AgentEditEntry | null;
    }
  | { ok: false; error: string; editIndex?: number };

/**
 * Hand an agent's change of the open document to agent edit mode: in
 * `review` mode it becomes the document's proposal; in `auto` mode it is
 * written at once and recorded for undo.
 */
export function submitAgentChange(
  change: AgentChange,
  store: AgentEditStore = useAgentEditStore,
): SubmitResult {
  const doc = liveDocument();
  if (!doc) return { ok: false, error: NO_OPEN_DOCUMENT };
  const state = store.getState();
  const proposed = proposeFor(state, doc, change);
  if (!proposed.ok) return proposed;
  if (state.mode === "review") {
    return { ok: true, status: "proposed", proposalId: proposed.proposal.id };
  }
  // Auto mode: accept every hunk and commit against the same text.
  state.decideAll(doc.key, "accepted");
  const committed = state.commit(doc.key, doc.content);
  if (!committed.ok) return { ok: false, error: committed.error };
  write(doc.content, committed.text);
  return { ok: true, status: "applied", entry: committed.entry };
}

function proposeFor(
  state: AgentEditState,
  doc: { key: string; content: string },
  change: AgentChange,
): ProposeResult {
  const common = {
    docKey: doc.key,
    base: doc.content,
    agentId: change.agentId,
    label: change.label,
    ...(change.group !== undefined ? { group: change.group } : {}),
    ...(change.diffOptions !== undefined ? { diffOptions: change.diffOptions } : {}),
  };
  const input: ProposalInput =
    change.edits !== undefined
      ? { ...common, edits: change.edits }
      : { ...common, proposed: change.proposed };
  return state.propose(input);
}

/** Commit the open document's proposal (its accepted hunks). */
export function commitOpenProposal(
  store: AgentEditStore = useAgentEditStore,
): CommitResult | { ok: false; reason: "no-document"; error: string } {
  const doc = liveDocument();
  if (!doc) return { ok: false, reason: "no-document", error: NO_OPEN_DOCUMENT };
  const result = store.getState().commit(doc.key, doc.content);
  if (result.ok) write(doc.content, result.text);
  return result;
}

/** Undo the open document's last agent edit. */
export function undoAgentEdit(
  store: AgentEditStore = useAgentEditStore,
): HistoryOutcome {
  return stepHistory("undo", store);
}

/** Redo the open document's last undone agent edit. */
export function redoAgentEdit(
  store: AgentEditStore = useAgentEditStore,
): HistoryOutcome {
  return stepHistory("redo", store);
}

function stepHistory(which: "undo" | "redo", store: AgentEditStore): HistoryOutcome {
  const doc = liveDocument();
  if (!doc) return { ok: false, reason: "empty" };
  const outcome = store.getState()[which](doc.key, doc.content);
  if (outcome.ok) write(doc.content, outcome.text);
  return outcome;
}
