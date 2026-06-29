/**
 * MCP canvas handler — edit-canvas operations on .canvas files.
 *
 * Exported function registers a single `listen()` call and returns the
 * resulting Promise<UnlistenFn> so the bridge can collect them for cleanup.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  applyCanvasOp,
  buildCanvasEditor,
  canvasEditorToCanvas,
  parseCanvas,
  serializeCanvas,
  undoCanvasOp,
  redoCanvasOp,
  type CanvasEditOp,
} from "../../lib/canvas";
import type { EditCanvasPayload } from "./types";

// ── mcp://edit-canvas ─────────────────────────────────────────────────────────

export function handleEditCanvas(): Promise<UnlistenFn> {
  return listen<EditCanvasPayload>("mcp://edit-canvas", async (e) => {
    const { editId, path: canvasPath, ops, undo = 0, redo = 0, save = true } = e.payload;

    const replyOk = async (nodesAffected: number, serialised: string) => {
      await invoke("mcp_edit_canvas_result", {
        editId,
        ok: true,
        path: canvasPath,
        nodesAffected,
        content: serialised,
        error: null,
      }).catch(() => {/* non-fatal */});
    };

    const replyErr = async (error: string) => {
      await invoke("mcp_edit_canvas_result", {
        editId,
        ok: false,
        path: canvasPath,
        nodesAffected: 0,
        content: null,
        error,
      }).catch(() => {/* non-fatal */});
    };

    try {
      if (!canvasPath) {
        await replyErr("`path` is required");
        return;
      }
      if (!Array.isArray(ops) || ops.length === 0) {
        await replyErr("`ops` must be a non-empty array");
        return;
      }

      let rawContent: string;
      try {
        rawContent = await invoke<string>("read_canvas_file", { path: canvasPath });
      } catch (err) {
        const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
        await replyErr(`Could not read canvas file: ${errStr}`);
        return;
      }

      const parsed = parseCanvas(rawContent);
      if (!parsed.ok) {
        await replyErr(`Canvas parse error: ${parsed.error}`);
        return;
      }

      const state = buildCanvasEditor(parsed.canvas);
      const originalNodeCount = state.nodes.length;

      for (let i = 0; i < ops.length; i++) {
        const op = ops[i] as CanvasEditOp;
        const result = applyCanvasOp(state, op);
        if (!result.ok) {
          await replyErr(`Op [${i}] (${op.type}) failed: ${result.error}`);
          return;
        }
      }

      for (let i = 0; i < undo; i++) undoCanvasOp(state);
      for (let i = 0; i < redo; i++) redoCanvasOp(state);

      const canvas = canvasEditorToCanvas(state);
      const serialised = serializeCanvas(canvas);

      if (save) {
        try {
          await invoke("write_canvas_file", { path: canvasPath, content: serialised });
        } catch (err) {
          const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
          await replyErr(`Canvas write failed: ${errStr}`);
          return;
        }
      }

      const nodesAffected = Math.abs(state.nodes.length - originalNodeCount);
      await replyOk(nodesAffected, serialised);
    } catch (err) {
      const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
      await replyErr(`Unexpected error in mcp://edit-canvas: ${errStr}`);
    }
  });
}
