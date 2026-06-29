/**
 * MCP conversation / memory handlers — open, present, ot-op, copy-rich-text,
 * lint-document, and apply-diff-hunk.
 *
 * Each exported function registers a single `listen()` call and returns the
 * resulting Promise<UnlistenFn> so the bridge can collect them for cleanup.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { applyAllFixes, BUILTIN_RULES, lintDocument } from "../../lib/mdlint";
import { copyAsRichText } from "../../lib/copyRichText";
import { summarise, type OtOperation } from "../../lib/ot";
import { parseDiffHunks } from "../../lib/diff";
import { buildHunkOp } from "../../components/viewer/DiffBlock";
import { useDocumentStore } from "../../store/documentStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { toast } from "../../store/toastStore";
import type {
  ApplyDiffHunkPayload,
  CopyRichTextPayload,
  OpenPayload,
  OtOpPayload,
  PresentPayload,
} from "./types";

// ── mcp://open ────────────────────────────────────────────────────────────────

export function handleOpen(): Promise<UnlistenFn> {
  return listen<OpenPayload>("mcp://open", (e) => {
    const { path, mode } = e.payload;
    useDocumentStore
      .getState()
      .openPath(path)
      .then(() => {
        if (mode === "edit") {
          useDocumentStore.getState().setViewMode("edit");
        } else if (mode === "read") {
          useDocumentStore.getState().setViewMode("read");
        }
      });
  });
}

// ── mcp://present ─────────────────────────────────────────────────────────────

export function handlePresent(): Promise<UnlistenFn> {
  return listen<PresentPayload>("mcp://present", (e) => {
    const doc = useDocumentStore.getState();
    const enterPresent = () => {
      useDocumentStore.getState().setViewMode("read");
      useUiStore.getState().openZen();
    };
    const { path } = e.payload;
    if (path) {
      doc
        .openPath(path)
        .then(enterPresent)
        .catch((err) => {
          console.warn("[mcp bridge] mcp://present openPath failed:", err);
        });
    } else if (doc.path) {
      enterPresent();
    }
  });
}

// ── mcp://ot-op ───────────────────────────────────────────────────────────────

export function handleOtOp(syncNow: () => void): Promise<UnlistenFn> {
  return listen<OtOpPayload>("mcp://ot-op", async (e) => {
    const { opId, agentId, seq, clock, components, save } = e.payload;
    const op: OtOperation = { id: opId, agentId, seq, clock, components };
    const currentContent = useDocumentStore.getState().content;
    try {
      op.summary = summarise(op, currentContent);
    } catch {
      // summarise is best-effort — don't block the apply if it fails.
    }
    const ok = useDocumentStore.getState().applyOp(op);
    if (ok) {
      if (save) {
        await useDocumentStore.getState().save();
      }
      syncNow();
      setTimeout(() => {
        useDocumentStore.getState().clearPendingOps();
      }, 4000);
    } else {
      toast.info(`OT op from ${agentId} could not be applied (doc state mismatch).`);
    }
    await invoke("mcp_ot_result", {
      opId,
      ok,
      error: ok ? null : "OT op inconsistent with current document state",
    }).catch((err) => {
      console.error("[mcp bridge] mcp_ot_result reply failed:", err);
    });
  });
}

// ── mcp://copy-rich-text ──────────────────────────────────────────────────────

export function handleCopyRichText(): Promise<UnlistenFn> {
  return listen<CopyRichTextPayload>("mcp://copy-rich-text", async (e) => {
    const { format = "auto" } = e.payload;
    try {
      await copyAsRichText(format);
      await invoke("mcp_copy_rich_text_result", {
        ok: true,
        error: null,
      }).catch(() => {/* non-fatal */});
    } catch (err) {
      const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      await invoke("mcp_copy_rich_text_result", {
        ok: false,
        error: errStr,
      }).catch(() => {/* non-fatal */});
    }
  });
}

// ── mcp://lint-document ───────────────────────────────────────────────────────

export function handleLintDocument(syncNow: () => void): Promise<UnlistenFn> {
  return listen<{ lintId: string; autoFix?: boolean; content?: string }>(
    "mcp://lint-document",
    async (e) => {
      const { lintId, autoFix = false, content: payloadContent } = e.payload;
      try {
        const doc = payloadContent ?? useDocumentStore.getState().content;
        const { linterConfig } = useSettingsStore.getState();
        const violations = lintDocument(doc, {
          rules: BUILTIN_RULES,
          disabledRules: linterConfig.disabledRules,
        });
        const serialisable = violations.map((v) => ({
          ruleId: v.ruleId,
          message: v.message,
          severity: v.severity,
          range: v.range
            ? {
                fromLine: v.range.from.line,
                fromCol: v.range.from.col,
                toLine: v.range.to.line,
                toCol: v.range.to.col,
              }
            : null,
          fixable: v.fix !== null,
        }));

        let resultContent = doc;
        if (autoFix) {
          resultContent = applyAllFixes(doc, violations);
          if (!payloadContent) {
            useDocumentStore.getState().setContent(resultContent);
            syncNow();
          }
        }

        await invoke("mcp_lint_document_result", {
          lintId,
          ok: true,
          violations: serialisable,
          content: autoFix ? resultContent : null,
          error: null,
        }).catch(() => {/* non-fatal */});
      } catch (err) {
        const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
        await invoke("mcp_lint_document_result", {
          lintId,
          ok: false,
          violations: [],
          content: null,
          error: errStr,
        }).catch(() => {/* non-fatal */});
      }
    },
  );
}

// ── mcp://apply-diff-hunk ─────────────────────────────────────────────────────

export function handleApplyDiffHunk(syncNow: () => void): Promise<UnlistenFn> {
  return listen<ApplyDiffHunkPayload>("mcp://apply-diff-hunk", async (e) => {
    const { diffId, diffText, hunkIndex, save } = e.payload;
    try {
      const hunks = parseDiffHunks(diffText);
      if (hunkIndex < 0 || hunkIndex >= hunks.length) {
        await invoke("mcp_apply_diff_hunk_result", {
          diffId,
          ok: false,
          hunkIndex,
          error: `hunkIndex ${hunkIndex} out of bounds — diff has ${hunks.length} hunk(s)`,
        }).catch(() => {/* non-fatal */});
        return;
      }
      const hunk = hunks[hunkIndex];
      const liveContent = useDocumentStore.getState().content;
      const op = buildHunkOp(liveContent, hunk.find, hunk.replace, "mcp-agent", {}, Date.now());
      if (!op) {
        const occurrences = liveContent.split(hunk.find).length - 1;
        const errMsg = occurrences === 0
          ? "Patch anchor not found in document"
          : "Patch anchor is ambiguous — include more context lines";
        await invoke("mcp_apply_diff_hunk_result", {
          diffId,
          ok: false,
          hunkIndex,
          error: errMsg,
        }).catch(() => {/* non-fatal */});
        return;
      }
      const applied = useDocumentStore.getState().applyOp(op);
      if (!applied) {
        await invoke("mcp_apply_diff_hunk_result", {
          diffId,
          ok: false,
          hunkIndex,
          error: "OT op inconsistent with current document state",
        }).catch(() => {/* non-fatal */});
        return;
      }
      if (save) {
        await useDocumentStore.getState().save();
      }
      syncNow();
      await invoke("mcp_apply_diff_hunk_result", {
        diffId,
        ok: true,
        hunkIndex,
        error: null,
      }).catch(() => {/* non-fatal */});
    } catch (err) {
      const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      await invoke("mcp_apply_diff_hunk_result", {
        diffId,
        ok: false,
        hunkIndex,
        error: errStr,
      }).catch(() => {/* non-fatal */});
    }
  });
}
