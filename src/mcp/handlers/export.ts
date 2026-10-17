/**
 * MCP export handler — PDF, DOCX, HTML and EPUB.
 *
 * Each exported function registers a single `listen()` call and returns the
 * resulting Promise<UnlistenFn> so the bridge can collect them for cleanup.
 *
 * A headless export (one with `outputPath`) carries an `editId`: the IPC
 * `/export` request waits for the outcome on `mcp_edit_result`, so the agent's
 * `export` call gets the error at once instead of timing out. Failures are
 * also toasted for the human. An export for the dialog reports nothing back.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { exportDocx, exportEpub, exportHtml, exportPdf } from "../../lib/export";
import { useDocumentStore } from "../../store/documentStore";
import { toast } from "../../store/toastStore";
import { useUiStore } from "../../store/uiStore";
import type { ExportPayload } from "./types";

// ── mcp://export ─────────────────────────────────────────────────────────────

export function handleExportPayload(): Promise<UnlistenFn> {
  return listen<ExportPayload>("mcp://export", async (e) => {
    const { editId, format, outputPath } = e.payload;
    if (!useDocumentStore.getState().path) {
      toast.info("Open a document before exporting.");
      await replyToExport(editId, "No document is open; open one before exporting.");
      return;
    }

    if (outputPath) {
      // Headless export — agent supplied a destination path.
      try {
        const fileName = useDocumentStore.getState().fileName ?? "export";
        const title =
          fileName.replace(/\.(md|markdown|mdown|mkd|mdx)$/i, "") || "export";
        // html/docx/epub write to the agent's path with no dialog. pdf can only
        // print, so the MCP server never sends a path for it.
        if (format === "pdf") {
          await exportPdf(title);
        } else if (format === "docx") {
          await exportDocx(title, outputPath);
        } else if (format === "epub") {
          await exportEpub(title, outputPath);
        } else {
          await exportHtml(title, outputPath);
        }
        await replyToExport(editId, null);
      } catch (err) {
        const errStr =
          typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
        toast.error(`MCP export failed: ${errStr}`);
        await replyToExport(editId, `Export failed in the app: ${errStr}`);
      }
    } else {
      // Open the dialog with the format pre-selected.
      useUiStore.getState().openExport(format);
    }
  });
}

/**
 * Report a headless export to the IPC `/export` request waiting on
 * `mcp_edit_result` (`error` null once the file is written). Nothing waits
 * when there is no `editId`.
 */
async function replyToExport(
  editId: string | undefined,
  error: string | null,
): Promise<void> {
  if (editId === undefined) return;
  await invoke("mcp_edit_result", {
    editId,
    ok: error === null,
    replaced: error === null ? 1 : 0,
    error,
  }).catch((e2) => {
    console.error("[mcp bridge] mcp_edit_result reply for export failed:", e2);
  });
}
