/**
 * MCP export handlers — PDF, DOCX, HTML, EPUB, archive, canvas-graph, outline,
 * batch-export, and batch-export-profiles.
 *
 * Each exported function registers a single `listen()` call and returns the
 * resulting Promise<UnlistenFn> so the bridge can collect them for cleanup.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  exportDocx,
  exportEpub,
  exportHtml,
  exportMarkdownArchive,
  exportCanvasGraph,
  exportOutline,
  exportPdf,
  buildBatchExportProfiles,
  type BatchProfileResult,
} from "../../lib/export";
import { ALL_PROFILE_IDS, type ExportProfileId } from "../../lib/exportTemplates";
import { useDocumentStore } from "../../store/documentStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { toast } from "../../store/toastStore";
import type {
  BatchExportFileResult,
  BatchExportPayload,
  BatchExportProfileResult,
  BatchExportProfilesPayload,
  CanvasGraphPayload,
  ExportPayload,
  MarkdownArchivePayload,
  OutlineExportPayload,
} from "./types";

// ── mcp://export ─────────────────────────────────────────────────────────────

export function handleExportPayload(): Promise<UnlistenFn> {
  return listen<ExportPayload>("mcp://export", async (e) => {
    const { format, outputPath } = e.payload;
    if (!useDocumentStore.getState().path) {
      toast.info("Open a document before exporting.");
      if (outputPath) {
        await invoke("mcp_export_result", {
          format,
          ok: false,
          path: null,
          error: "No document is open.",
        }).catch(() => {/* non-fatal */});
      }
      return;
    }

    if (outputPath) {
      // Headless export — agent supplied a destination path.
      try {
        const fileName = useDocumentStore.getState().fileName ?? "export";
        const title = fileName.replace(/\.(md|markdown|mdown|mkd|mdx)$/i, "") || "export";
        if (format === "pdf") {
          await exportPdf(title);
        } else if (format === "docx") {
          await exportDocx(title);
        } else if (format === "epub") {
          await exportEpub(title);
        } else {
          await exportHtml(title);
        }
        await invoke("mcp_export_result", {
          format,
          ok: true,
          path: outputPath,
          error: null,
        }).catch(() => {/* non-fatal */});
      } catch (err) {
        const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
        toast.error(`MCP export failed: ${errStr}`);
        await invoke("mcp_export_result", {
          format,
          ok: false,
          path: null,
          error: errStr,
        }).catch(() => {/* non-fatal */});
      }
    } else {
      // Open the dialog with the format pre-selected.
      useUiStore.getState().openExport(format);
    }
  });
}

// ── mcp://export-markdown-archive ────────────────────────────────────────────

export function handleMarkdownArchive(): Promise<UnlistenFn> {
  return listen<MarkdownArchivePayload>("mcp://export-markdown-archive", async (e) => {
    const { outputPath, includeAssets = true } = e.payload;
    try {
      const resultPath = await exportMarkdownArchive({
        outputPath: outputPath ?? undefined,
        includeAssets,
      });
      if (outputPath) {
        await invoke("mcp_archive_result", {
          ok: true,
          path: resultPath || outputPath,
          error: null,
        }).catch(() => {/* non-fatal */});
      }
    } catch (err) {
      const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      if (outputPath) {
        await invoke("mcp_archive_result", {
          ok: false,
          path: null,
          error: errStr,
        }).catch(() => {/* non-fatal */});
      }
    }
  });
}

// ── mcp://export-canvas-graph ─────────────────────────────────────────────────

export function handleCanvasGraphExport(): Promise<UnlistenFn> {
  return listen<CanvasGraphPayload>("mcp://export-canvas-graph", async (e) => {
    const { outputPath, includeIsolated = true } = e.payload;
    try {
      const resultPath = await exportCanvasGraph({
        outputPath: outputPath ?? undefined,
        includeIsolated,
      });
      if (outputPath) {
        await invoke("mcp_canvas_result", {
          ok: true,
          path: resultPath || outputPath,
          error: null,
        }).catch(() => {/* non-fatal */});
      }
    } catch (err) {
      const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      if (outputPath) {
        await invoke("mcp_canvas_result", {
          ok: false,
          path: null,
          error: errStr,
        }).catch(() => {/* non-fatal */});
      }
    }
  });
}

// ── mcp://export-outline ──────────────────────────────────────────────────────

export function handleOutlineExport(): Promise<UnlistenFn> {
  return listen<OutlineExportPayload>("mcp://export-outline", async (e) => {
    const { format = "json", outputPath } = e.payload;
    try {
      const resultPath = await exportOutline({
        format,
        outputPath: outputPath ?? undefined,
      });
      if (outputPath) {
        await invoke("mcp_outline_result", {
          ok: true,
          path: resultPath || outputPath,
          format,
          error: null,
        }).catch(() => {/* non-fatal */});
      }
    } catch (err) {
      const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      if (outputPath) {
        await invoke("mcp_outline_result", {
          ok: false,
          path: null,
          format,
          error: errStr,
        }).catch(() => {/* non-fatal */});
      }
    }
  });
}

// ── mcp://batch-export ────────────────────────────────────────────────────────

export function handleBatchExport(): Promise<UnlistenFn> {
  return listen<BatchExportPayload>("mcp://batch-export", async (e) => {
    const { batchId, exports: entries } = e.payload;

    if (!entries || entries.length === 0) {
      await invoke("mcp_batch_export_result", {
        batchId,
        ok: false,
        results: [],
        error: "`exports` array must not be empty",
      }).catch(() => {/* non-fatal */});
      return;
    }

    const results: BatchExportFileResult[] = await Promise.all(
      entries.map(async (entry): Promise<BatchExportFileResult> => {
        const { path: filePath, format, outputDir } = entry;
        try {
          const fileName = filePath.split("/").pop() ?? filePath;
          const title = fileName.replace(/\.(md|markdown|mdown|mkd|mdx)$/i, "") || "export";

          if (format === "pdf") {
            await exportPdf(title);
          } else if (format === "docx") {
            await exportDocx(title);
          } else if (format === "epub") {
            await exportEpub(title);
          } else {
            await exportHtml(title);
          }

          const ext = format === "docx" ? "docx" : format === "pdf" ? "pdf" : format === "epub" ? "epub" : "html";
          const dir = outputDir ?? filePath.substring(0, filePath.lastIndexOf("/")) ?? ".";
          const outputPath = `${dir}/${title}.${ext}`;

          return { path: filePath, format, ok: true, outputPath };
        } catch (err) {
          const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
          return { path: filePath, format, ok: false, error: errStr };
        }
      }),
    );

    const allOk = results.every((r) => r.ok);
    await invoke("mcp_batch_export_result", {
      batchId,
      ok: allOk,
      results,
      error: allOk ? null : "One or more exports failed — see per-file results.",
    }).catch(() => {/* non-fatal */});
  });
}

// ── mcp://batch-export-profiles ───────────────────────────────────────────────

export function handleBatchExportProfiles(): Promise<UnlistenFn> {
  return listen<BatchExportProfilesPayload>("mcp://batch-export-profiles", async (e) => {
    const { batchId, profileIds: requestedIds, content } = e.payload;

    let targetIds: readonly ExportProfileId[];
    if (requestedIds && requestedIds.length > 0) {
      targetIds = requestedIds;
    } else {
      const { disabledProfileIds } = useSettingsStore.getState();
      targetIds = ALL_PROFILE_IDS.filter((id) => !disabledProfileIds.includes(id));
    }

    if (targetIds.length === 0) {
      await invoke("mcp_batch_export_profiles_result", {
        batchId,
        ok: false,
        results: [],
        error: "No profiles selected — all profiles may be disabled in Settings.",
      }).catch(() => {/* non-fatal */});
      return;
    }

    try {
      const rawResults: BatchProfileResult[] = await buildBatchExportProfiles(
        targetIds,
        content,
      );

      const results: BatchExportProfileResult[] = rawResults.map((r) => ({
        profileId: r.profileId,
        ok: r.ok,
        html: r.html,
        error: r.error,
      }));

      const allOk = results.every((r) => r.ok);
      await invoke("mcp_batch_export_profiles_result", {
        batchId,
        ok: allOk,
        results,
        error: allOk ? null : "One or more profile exports failed — see per-profile results.",
      }).catch(() => {/* non-fatal */});
    } catch (err) {
      const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      await invoke("mcp_batch_export_profiles_result", {
        batchId,
        ok: false,
        results: [],
        error: errStr,
      }).catch(() => {/* non-fatal */});
    }
  });
}
