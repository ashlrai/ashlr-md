/**
 * MCP export handler — PDF, DOCX, HTML and EPUB.
 *
 * Each exported function registers a single `listen()` call and returns the
 * resulting Promise<UnlistenFn> so the bridge can collect them for cleanup.
 *
 * Nothing reports back to the MCP server: `/export` returns as soon as the
 * event is emitted, and the `export` tool counts a headless export as done
 * only once a new version of the output file exists. Failures surface to the
 * human as a toast.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { exportDocx, exportEpub, exportHtml, exportPdf } from "../../lib/export";
import { useDocumentStore } from "../../store/documentStore";
import { toast } from "../../store/toastStore";
import { useUiStore } from "../../store/uiStore";
import type { ExportPayload } from "./types";

// ── mcp://export ─────────────────────────────────────────────────────────────

export function handleExportPayload(): Promise<UnlistenFn> {
  return listen<ExportPayload>("mcp://export", async (e) => {
    const { format, outputPath } = e.payload;
    if (!useDocumentStore.getState().path) {
      toast.info("Open a document before exporting.");
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
      } catch (err) {
        const errStr =
          typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
        toast.error(`MCP export failed: ${errStr}`);
      }
    } else {
      // Open the dialog with the format pre-selected.
      useUiStore.getState().openExport(format);
    }
  });
}
