/**
 * DiffBlock.tsx — renders a ```diff fenced block with per-hunk Apply/Reject/Copy actions.
 *
 * For each parsed hunk:
 *   - Renders Shiki-highlighted diff lines (reuses highlightCode from shiki.ts).
 *   - Shows a DiffHunkActions strip: Copy hunk, Copy all, Apply, Reject.
 *
 * Apply/Reject flow (OT-backed):
 *   Apply:  builds an OtOperation that replaces `find` with `replace` in the live
 *           document, then calls documentStore.applyOp() for atomic OT patching.
 *           A hunk with a named targetFile falls back to invoke("apply_file_patch")
 *           (Rust CONFINES the write to the open document's folder).
 *   Reject: silently discards the hunk from the UI (marks it "rejected") without
 *           touching document content — equivalent to "don't apply".
 *
 * Undo/redo: the OT op log (documentStore.opLog) records every applied hunk op.
 *   UndoHunk rebuilds the inverse operation (swap find/replace) and re-applies it
 *   via documentStore.applyOp(), maintaining the same OT convergence guarantees.
 *
 * Keyboard shortcuts (when a hunk has focus):
 *   Alt+Y  — apply focused hunk
 *   Alt+N  — reject focused hunk
 *
 * Falls back to a plain <CodeBlock lang="diff"> when parse yields 0 hunks.
 *
 * MCP integration: agents can call apply_diff_hunk(diffId, hunkIndex) via the
 * MCP bridge (mcp://apply-diff-hunk event) to patch docs programmatically.
 */

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ParsedHunk, parseDiffHunks } from "../../lib/diff";
import { highlightCode } from "../../lib/shiki";
import {
  type OtOperation,
  type VectorClock,
  del,
  insert,
  normalise,
  retain,
} from "../../lib/ot";
import { useDocumentStore } from "../../store/documentStore";
import { toast } from "../../store/toastStore";
import { CodeBlock } from "./CodeBlock";

// ---------------------------------------------------------------------------
// OT helpers — build an OT op from a hunk's find/replace relative to content
// ---------------------------------------------------------------------------

/**
 * Build an OtOperation that replaces the first (unique) occurrence of `find`
 * with `replace` within `content`.
 *
 * Returns `null` when `find` is absent or ambiguous.
 */
export function buildHunkOp(
  content: string,
  find: string,
  replace: string,
  agentId: string,
  clock: VectorClock,
  seq: number,
): OtOperation | null {
  if (find === replace) return null; // no-op
  const offset = content.indexOf(find);
  if (offset === -1) return null;
  // Ambiguity check — second occurrence must not exist.
  if (content.indexOf(find, offset + 1) !== -1) return null;

  const components = normalise([
    ...(offset > 0 ? [retain(offset)] : []),
    ...(find.length > 0 ? [del(find.length)] : []),
    ...(replace.length > 0 ? [insert(replace)] : []),
    ...(offset + find.length < content.length
      ? [retain(content.length - offset - find.length)]
      : []),
  ]);

  return {
    id: `${agentId}:${seq}`,
    agentId,
    seq,
    clock,
    components,
  };
}

/**
 * Build the inverse OT operation (undo): replaces `replace` back with `find`
 * in `currentContent` (the post-apply content).
 */
export function buildInverseHunkOp(
  currentContent: string,
  find: string,
  replace: string,
  agentId: string,
  clock: VectorClock,
  seq: number,
): OtOperation | null {
  // The inverse is: find `replace` in the current content, put back `find`.
  return buildHunkOp(currentContent, replace, find, agentId, clock, seq);
}

// A per-session incrementing sequence for locally-generated hunk ops.
let _localSeq = 0;
function nextSeq(): number {
  _localSeq += 1;
  return _localSeq;
}

// ---------------------------------------------------------------------------
// DiffHunkActions — Copy hunk, Copy all, Reject, Apply strip
// ---------------------------------------------------------------------------

interface DiffHunkActionsProps {
  hunk: ParsedHunk;
  allHunks: ParsedHunk[];
  applied: boolean;
  rejected: boolean;
  undoable: boolean;
  /** Index of this hunk within the parent DiffBlock (for keyboard id) */
  hunkIndex: number;
  onApplied: () => void;
  onRejected: () => void;
  onUndo: () => void;
}

function DiffHunkActions({
  hunk,
  allHunks,
  applied,
  rejected,
  undoable,
  hunkIndex: _hunkIndex,
  onApplied,
  onRejected,
  onUndo,
}: DiffHunkActionsProps) {
  const [copied, setCopied] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const copyAllTimer = useRef<number | undefined>(undefined);

  // ── Copy hunk ─────────────────────────────────────────────────────────────

  const handleCopy = useCallback(async () => {
    const text = [hunk.header, ...buildHunkLines(hunk)].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  }, [hunk]);

  // ── Copy all hunks ────────────────────────────────────────────────────────

  const handleCopyAll = useCallback(async () => {
    const text = allHunks
      .map((h) => [h.header, ...buildHunkLines(h)].join("\n"))
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAll(true);
      window.clearTimeout(copyAllTimer.current);
      copyAllTimer.current = window.setTimeout(() => setCopiedAll(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  }, [allHunks]);

  // ── Reject ────────────────────────────────────────────────────────────────

  const handleReject = useCallback(() => {
    onRejected();
    toast.success("Hunk rejected");
  }, [onRejected]);

  // ── Apply — confirm phase ────────────────────────────────────────────────

  const handleApplyClick = useCallback(() => {
    setConfirming(true);
  }, []);

  const handleCancel = useCallback(() => {
    setConfirming(false);
  }, []);

  const handleConfirm = useCallback(async () => {
    setConfirming(false);
    setApplying(true);
    try {
      const store = useDocumentStore.getState();
      const openPath = store.path;

      if (!hunk.targetFile) {
        // In-document patch via OT.
        const content = store.content;
        const op = buildHunkOp(
          content,
          hunk.find,
          hunk.replace,
          "diff-hunk",
          {},
          nextSeq(),
        );
        if (!op) {
          // Ambiguous or not found.
          const occurrences = content.split(hunk.find).length - 1;
          if (occurrences === 0) {
            toast.error("Patch not found — the document may have already changed.");
          } else {
            toast.error("Patch anchor is ambiguous — include more context lines.");
          }
          return;
        }
        const ok = store.applyOp(op);
        if (!ok) {
          toast.error("Apply failed — OT op was inconsistent with document state.");
          return;
        }
        await store.save();
        toast.success("Hunk applied");
        onApplied();
      } else {
        if (!openPath) {
          toast.error("Open a document first so the patch target can be located.");
          return;
        }
        const sep = openPath.includes("\\") ? "\\" : "/";
        const baseDir = openPath.slice(0, openPath.lastIndexOf(sep)) || sep;
        const resolved = await invoke<string>("apply_file_patch", {
          baseDir,
          target: hunk.targetFile,
          find: hunk.find,
          replace: hunk.replace,
        });
        const name = resolved.slice(resolved.lastIndexOf(sep) + 1);
        toast.success(`Hunk applied to ${name}`);
        onApplied();
      }
    } catch (e) {
      toast.error(`Apply failed: ${String(e)}`);
    } finally {
      setApplying(false);
    }
  }, [hunk, onApplied]);

  // ── Undo ──────────────────────────────────────────────────────────────────

  const handleUndo = useCallback(async () => {
    try {
      const store = useDocumentStore.getState();
      const content = store.content;
      const op = buildInverseHunkOp(content, hunk.find, hunk.replace, "diff-hunk-undo", {}, nextSeq());
      if (!op) {
        toast.error("Undo failed — could not locate the applied text in the document.");
        return;
      }
      const ok = store.applyOp(op);
      if (!ok) {
        toast.error("Undo failed — OT op was inconsistent with document state.");
        return;
      }
      await store.save();
      toast.success("Hunk undone");
      onUndo();
    } catch (e) {
      toast.error(`Undo failed: ${String(e)}`);
    }
  }, [hunk, onUndo]);

  if (applied) {
    return (
      <div className="diff-hunk-actions">
        <span className="diff-applied-label">Applied</span>
        {undoable && (
          <button
            className="diff-undo-btn"
            type="button"
            onClick={handleUndo}
            title="Undo this hunk (Alt+Z)"
          >
            Undo
          </button>
        )}
      </div>
    );
  }

  if (rejected) {
    return (
      <div className="diff-hunk-actions">
        <span className="diff-rejected-label">Rejected</span>
      </div>
    );
  }

  return (
    <div className="diff-hunk-actions">
      {/* Copy hunk */}
      {!confirming && (
        <button
          className={`diff-copy-btn${copied ? " copied" : ""}`}
          type="button"
          onClick={handleCopy}
          title="Copy hunk"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}

      {/* Copy all hunks */}
      {!confirming && allHunks.length > 1 && (
        <button
          className={`diff-copy-btn${copiedAll ? " copied" : ""}`}
          type="button"
          onClick={handleCopyAll}
          title="Copy all hunks"
        >
          {copiedAll ? "Copied all" : "Copy all"}
        </button>
      )}

      {/* Reject button */}
      {!confirming && (
        <button
          className="diff-reject-btn"
          type="button"
          onClick={handleReject}
          title="Reject this hunk (Alt+N)"
        >
          Reject
        </button>
      )}

      {/* Apply button / confirm prompt */}
      {!confirming ? (
        <button
          className={`diff-apply-btn${applying ? " applying" : ""}`}
          type="button"
          onClick={handleApplyClick}
          disabled={applying}
          title="Apply this hunk to the target file (Alt+Y)"
        >
          {applying ? "Applying…" : "Apply"}
        </button>
      ) : (
        <span className="diff-confirm">
          <span className="diff-confirm-label">
            Apply to <strong>{hunk.targetFile ?? "this document"}</strong>?
          </span>
          <button className="diff-confirm-yes" type="button" onClick={handleConfirm}>
            Yes
          </button>
          <button className="diff-confirm-no" type="button" onClick={handleCancel}>
            Cancel
          </button>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SingleHunk — highlighted Shiki output + action strip for one hunk
// ---------------------------------------------------------------------------

interface SingleHunkProps {
  hunk: ParsedHunk;
  allHunks: ParsedHunk[];
  hunkIndex: number;
  onApplied: () => void;
  onRejected: () => void;
  applied: boolean;
  rejected: boolean;
  /** Called after a successful undo to revert the applied state. */
  onUndo: () => void;
}

function SingleHunk({
  hunk,
  allHunks,
  hunkIndex,
  onApplied,
  onRejected,
  applied,
  rejected,
  onUndo,
}: SingleHunkProps) {
  const [html, setHtml] = useState<string | null>(null);
  const isMounted = useRef(true);
  const hunkRef = useRef<HTMLDivElement>(null);

  const hunkText = [hunk.header, ...buildHunkLines(hunk)].join("\n");

  useEffect(() => {
    isMounted.current = true;
    highlightCode(hunkText, "diff")
      .then((result) => {
        if (isMounted.current) setHtml(result);
      })
      .catch(() => {
        if (isMounted.current) setHtml(null);
      });
    return () => {
      isMounted.current = false;
    };
  }, [hunkText]);

  // ── Keyboard shortcuts: Alt+Y (apply), Alt+N (reject) ───────────────────
  useEffect(() => {
    const el = hunkRef.current;
    if (!el) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      // Only fire if this hunk (or a descendant) is focused.
      if (!el.contains(document.activeElement)) return;
      if (applied || rejected) return;

      if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        // Trigger the apply button click to go through confirmation flow.
        const applyBtn = el.querySelector<HTMLButtonElement>(".diff-apply-btn:not(:disabled)");
        applyBtn?.click();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        const rejectBtn = el.querySelector<HTMLButtonElement>(".diff-reject-btn");
        rejectBtn?.click();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [applied, rejected]);

  return (
    <div
      ref={hunkRef}
      className={`diff-hunk${applied ? " diff-hunk--applied" : ""}${rejected ? " diff-hunk--rejected" : ""}`}
      // Make focusable so keyboard shortcuts detect containment.
      tabIndex={-1}
    >
      <div className="diff-hunk-header">
        <span className="diff-hunk-header-text">{hunk.header}</span>
        <DiffHunkActions
          hunk={hunk}
          allHunks={allHunks}
          applied={applied}
          rejected={rejected}
          undoable={applied}
          hunkIndex={hunkIndex}
          onApplied={onApplied}
          onRejected={onRejected}
          onUndo={onUndo}
        />
      </div>
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-plain">
          <code>{hunkText}</code>
        </pre>
      )}
    </div>
  );
}

/**
 * Reconstruct the unified-diff lines for a hunk from its find/replace strings.
 * Context lines (present in both) get a space prefix; removed lines get `-`;
 * added lines get `+`.
 */
export function buildHunkLines(hunk: ParsedHunk): string[] {
  const findLines = hunk.find.split("\n");
  const replaceLines = hunk.replace.split("\n");

  // Compute longest common prefix (context before) and suffix (context after).
  let prefixLen = 0;
  while (
    prefixLen < findLines.length &&
    prefixLen < replaceLines.length &&
    findLines[prefixLen] === replaceLines[prefixLen]
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < findLines.length - prefixLen &&
    suffixLen < replaceLines.length - prefixLen &&
    findLines[findLines.length - 1 - suffixLen] ===
      replaceLines[replaceLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const lines: string[] = [];
  for (let i = 0; i < prefixLen; i++) lines.push(` ${findLines[i]}`);
  for (let i = prefixLen; i < findLines.length - suffixLen; i++)
    lines.push(`-${findLines[i]}`);
  for (let i = prefixLen; i < replaceLines.length - suffixLen; i++)
    lines.push(`+${replaceLines[i]}`);
  for (let i = findLines.length - suffixLen; i < findLines.length; i++)
    lines.push(` ${findLines[i]}`);
  return lines;
}

// ---------------------------------------------------------------------------
// DiffBlock — public component
// ---------------------------------------------------------------------------

interface DiffBlockProps {
  code: string;
  /** Optional stable id for MCP bridge identification (e.g. from the renderer). */
  diffId?: string;
}

export function DiffBlock({ code, diffId: _diffId }: DiffBlockProps) {
  const hunks = parseDiffHunks(code);
  const [appliedSet, setAppliedSet] = useState<Set<number>>(new Set());
  const [rejectedSet, setRejectedSet] = useState<Set<number>>(new Set());

  if (hunks.length === 0) {
    // Fall back to a plain highlighted code block.
    return <CodeBlock code={code} lang="diff" />;
  }

  function markApplied(idx: number) {
    setAppliedSet((prev) => new Set([...prev, idx]));
  }

  function markRejected(idx: number) {
    setRejectedSet((prev) => new Set([...prev, idx]));
  }

  function unmarkApplied(idx: number) {
    setAppliedSet((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  }

  return (
    <div className="code-block" data-lang="diff">
      {hunks.map((hunk, idx) => (
        <SingleHunk
          // biome-ignore lint/suspicious/noArrayIndexKey: hunks are stable within a render
          key={idx}
          hunk={hunk}
          allHunks={hunks}
          hunkIndex={idx}
          applied={appliedSet.has(idx)}
          rejected={rejectedSet.has(idx)}
          onApplied={() => markApplied(idx)}
          onRejected={() => markRejected(idx)}
          onUndo={() => unmarkApplied(idx)}
        />
      ))}
    </div>
  );
}
