/**
 * MCP edit handlers — set-content, edit (find/replace), atomic-edits,
 * batch-edit, stream-edit, and stream-edit-apply.
 *
 * Each exported function registers a single `listen()` call and returns the
 * resulting Promise<UnlistenFn> so the bridge can collect them for cleanup.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useDocumentStore } from "../../store/documentStore";
import { applyUniqueEdit, computeStreamEditDiff, applyEditAtOccurrence } from "../applyEdit";
import type {
  AtomicEditFileResult,
  AtomicEditsPayload,
  BatchEditOpResult,
  BatchEditPayload,
  EditPayload,
  SetContentPayload,
  StreamEditApplyPayload,
  StreamEditCandidateResult,
  StreamEditPayload,
} from "./types";

// ── mcp://set-content ─────────────────────────────────────────────────────────

export function handleSetContent(syncNow: () => void): Promise<UnlistenFn> {
  return listen<SetContentPayload>("mcp://set-content", async (e) => {
    const { content, save } = e.payload;
    useDocumentStore.getState().setContent(content);
    if (save) {
      await useDocumentStore.getState().save();
    }
    syncNow();
  });
}

// ── mcp://edit ────────────────────────────────────────────────────────────────

export function handleAtomicEdit(syncNow: () => void): Promise<UnlistenFn> {
  return listen<EditPayload>("mcp://edit", async (e) => {
    const { editId, find, replace, save } = e.payload;
    try {
      const liveContent = useDocumentStore.getState().content;
      const outcome = applyUniqueEdit(liveContent, find, replace);
      if (outcome.ok && outcome.content !== undefined) {
        useDocumentStore.getState().setContent(outcome.content);
        if (save) {
          await useDocumentStore.getState().save();
        }
        syncNow();
      }
      await invoke("mcp_edit_result", {
        editId,
        ok: outcome.ok,
        replaced: outcome.replaced,
        error: outcome.error ?? null,
      });
    } catch (err) {
      await invoke("mcp_edit_result", {
        editId,
        ok: false,
        replaced: 0,
        error: `Edit failed in app: ${String(err)}`,
      }).catch((e2) => {
        console.error("[mcp bridge] mcp_edit_result recovery reply failed:", e2);
      });
    }
  });
}

// ── mcp://batch-edit ──────────────────────────────────────────────────────────

export function handleBatchEdit(syncNow: () => void): Promise<UnlistenFn> {
  return listen<BatchEditPayload>("mcp://batch-edit", async (e) => {
    const { batchId, ops } = e.payload;
    const opResults: BatchEditOpResult[] = [];
    const currentPath = useDocumentStore.getState().path;

    const liveOps: typeof ops = [];
    const diskOps: typeof ops = [];
    for (const op of ops) {
      if (currentPath && op.path === currentPath) {
        liveOps.push(op);
      } else {
        diskOps.push(op);
      }
    }

    for (const op of liveOps) {
      const liveContent = useDocumentStore.getState().content;
      const outcome = applyUniqueEdit(liveContent, op.find, op.replace);
      if (outcome.ok && outcome.content !== undefined) {
        useDocumentStore.getState().setContent(outcome.content);
        if (op.save) {
          await useDocumentStore.getState().save();
        }
        syncNow();
      }
      opResults.push({
        path: op.path,
        ok: outcome.ok,
        replaced: outcome.replaced,
        error: outcome.ok ? undefined : outcome.error,
      });
    }

    if (diskOps.length > 0) {
      try {
        const diskResults = await invoke<BatchEditOpResult[]>("apply_batch_edit", {
          ops: diskOps,
        });
        opResults.push(...diskResults);
      } catch (err) {
        const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
        for (const op of diskOps) {
          opResults.push({ path: op.path, ok: false, replaced: 0, error: errStr });
        }
      }
    }

    const allOk = opResults.every((r) => r.ok);
    await invoke("mcp_batch_edit_result", {
      batchId,
      ok: allOk,
      results: opResults,
      error: allOk ? null : "One or more edits failed — see per-file results.",
    }).catch(() => {/* non-fatal */});
  });
}

// ── mcp://atomic-edits ────────────────────────────────────────────────────────

export function handleAtomicEdits(syncNow: () => void): Promise<UnlistenFn> {
  return listen<AtomicEditsPayload>("mcp://atomic-edits", async (e) => {
    const { atomicId, entries, save = false } = e.payload;

    const reply = async (
      ok: boolean,
      results: AtomicEditFileResult[],
      error: string | null,
    ) => {
      await invoke("mcp_atomic_edits_result", {
        atomicId,
        ok,
        results,
        error,
      }).catch(() => {/* non-fatal */});
    };

    if (!entries || entries.length === 0) {
      await reply(false, [], "`entries` array must not be empty");
      return;
    }

    // ── Step 1: conflict detection — duplicate paths ──────────────────────────
    const pathCounts = new Map<string, number>();
    for (const entry of entries) {
      pathCounts.set(entry.path, (pathCounts.get(entry.path) ?? 0) + 1);
    }
    const duplicates = [...pathCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([p]) => p);
    if (duplicates.length > 0) {
      const errMsg = `Conflict: the following paths appear more than once — merge edits before submitting: ${duplicates.join(", ")}`;
      const results: AtomicEditFileResult[] = entries.map((en) => ({
        path: en.path,
        ok: false,
        replaced: 0,
        error: duplicates.includes(en.path) ? "Duplicate path in batch" : undefined,
      }));
      await reply(false, results, errMsg);
      return;
    }

    // ── Step 2: topological sort via metadata.dependsOn ──────────────────────
    const pathToIdx = new Map<string, number>(entries.map((en, i) => [en.path, i]));
    const inDegree = new Array<number>(entries.length).fill(0);
    const adjList: number[][] = entries.map(() => []);

    for (let i = 0; i < entries.length; i++) {
      const deps = entries[i].metadata?.dependsOn ?? [];
      for (const dep of deps) {
        const depIdx = pathToIdx.get(dep);
        if (depIdx !== undefined) {
          adjList[depIdx].push(i);
          inDegree[i]++;
        }
      }
    }

    // Kahn's algorithm
    const queue: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (inDegree[i] === 0) queue.push(i);
    }
    const order: number[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      order.push(node);
      for (const next of adjList[node]) {
        inDegree[next]--;
        if (inDegree[next] === 0) queue.push(next);
      }
    }
    if (order.length !== entries.length) {
      await reply(
        false,
        entries.map((en) => ({ path: en.path, ok: false, replaced: 0, error: "Dependency cycle detected" })),
        "Dependency cycle in metadata.dependsOn — cannot determine apply order",
      );
      return;
    }

    // ── Step 3: load all file contents ────────────────────────────────────────
    const currentPath = useDocumentStore.getState().path;
    const contentMap = new Map<string, string>();

    const diskPaths: string[] = [];
    for (const entry of entries) {
      if (currentPath && entry.path === currentPath) {
        contentMap.set(entry.path, useDocumentStore.getState().content);
      } else {
        diskPaths.push(entry.path);
      }
    }

    if (diskPaths.length > 0) {
      try {
        const diskResults = await invoke<Array<{
          path: string;
          ok: boolean;
          content?: string;
          error?: string;
        }>>("read_batch_files", { paths: diskPaths });
        for (const r of diskResults) {
          if (r.ok && r.content !== undefined) {
            contentMap.set(r.path, r.content);
          } else {
            await reply(
              false,
              entries.map((en) => ({
                path: en.path,
                ok: false,
                replaced: 0,
                error: en.path === r.path ? (r.error ?? "Could not read file") : "Aborted — another file in batch could not be read",
              })),
              `Could not read file ${r.path}: ${r.error ?? "unknown error"}`,
            );
            return;
          }
        }
      } catch (err) {
        const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
        await reply(
          false,
          entries.map((en) => ({ path: en.path, ok: false, replaced: 0, error: errStr })),
          `Batch file read failed: ${errStr}`,
        );
        return;
      }
    }

    // ── Step 4: apply edits in dependency order ───────────────────────────────
    const newContents = new Map<string, string>();
    const editResults: AtomicEditFileResult[] = new Array(entries.length);
    let allOk = true;

    for (const idx of order) {
      const entry = entries[idx];
      const content = newContents.get(entry.path) ?? contentMap.get(entry.path) ?? "";
      const outcome = applyUniqueEdit(content, entry.find, entry.replace);
      editResults[idx] = {
        path: entry.path,
        ok: outcome.ok,
        replaced: outcome.replaced,
        error: outcome.error,
      };
      if (outcome.ok && outcome.content !== undefined) {
        newContents.set(entry.path, outcome.content);
      } else {
        allOk = false;
      }
    }

    if (!allOk) {
      for (let i = 0; i < entries.length; i++) {
        if (!editResults[i]) {
          editResults[i] = {
            path: entries[i].path,
            ok: false,
            replaced: 0,
            error: "Aborted — earlier edit in transaction failed",
          };
        }
      }
      await reply(false, editResults, "One or more edits failed — transaction rolled back, no files written");
      return;
    }

    // ── Step 5: write all modified files atomically ───────────────────────────
    const batchEntries: Array<{ path: string; content: string }> = [];
    for (const [p, content] of newContents.entries()) {
      if (!(currentPath && p === currentPath)) {
        batchEntries.push({ path: p, content });
      }
    }

    if (batchEntries.length > 0) {
      try {
        const writeResults = await invoke<Array<{
          path: string;
          ok: boolean;
          error?: string | null;
        }>>("apply_atomic_batch", { entries: batchEntries });

        for (const wr of writeResults) {
          if (!wr.ok) {
            await reply(
              false,
              entries.map((en) => ({
                path: en.path,
                ok: false,
                replaced: 0,
                error: en.path === wr.path
                  ? (wr.error ?? "Write failed")
                  : "Rolled back — another file in batch failed to write",
              })),
              `Atomic write failed for ${wr.path}: ${wr.error ?? "unknown error"}`,
            );
            return;
          }
        }
      } catch (err) {
        const errStr = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
        await reply(
          false,
          entries.map((en) => ({ path: en.path, ok: false, replaced: 0, error: errStr })),
          `Atomic batch write failed: ${errStr}`,
        );
        return;
      }
    }

    // Update live document for the currently-open file.
    if (currentPath && newContents.has(currentPath)) {
      useDocumentStore.getState().setContent(newContents.get(currentPath)!);
      if (save) {
        await useDocumentStore.getState().save();
      }
      syncNow();
    }

    await reply(true, editResults, null);
  });
}

// ── mcp://stream-edit ─────────────────────────────────────────────────────────

export function handleStreamEdit(syncNow: () => void): Promise<UnlistenFn> {
  return listen<StreamEditPayload>("mcp://stream-edit", async (e) => {
    const {
      editId,
      path: assertPath,
      find,
      replace,
      preview = true,
      previewLines = 5,
    } = e.payload;

    if (assertPath) {
      const openPath = useDocumentStore.getState().path;
      if (!openPath || openPath !== assertPath) {
        await invoke("mcp_stream_edit_preview", {
          editId,
          ok: false,
          diff: "",
          candidates: null,
          matchCount: 0,
          previewLines,
          error: `Path mismatch: '${assertPath}' is not the currently open document.`,
        }).catch(() => {/* non-fatal */});
        return;
      }
    }

    const liveContent = useDocumentStore.getState().content;

    if (!preview) {
      const outcome = applyUniqueEdit(liveContent, find, replace);
      if (outcome.ok && outcome.content !== undefined) {
        useDocumentStore.getState().setContent(outcome.content);
        syncNow();
      }
      await invoke("mcp_stream_edit_preview", {
        editId,
        ok: outcome.ok,
        diff: "",
        candidates: null,
        matchCount: outcome.ok ? 1 : 0,
        previewLines,
        error: outcome.error ?? null,
      }).catch(() => {/* non-fatal */});
      return;
    }

    const label = useDocumentStore.getState().path ?? "document";
    const result = computeStreamEditDiff(liveContent, find, replace, previewLines, label);

    const candidates: StreamEditCandidateResult[] | null =
      result.candidates
        ? result.candidates.map((c) => ({
            matchIndex: c.matchIndex,
            startLine: c.startLine,
            diff: c.diff,
            rank: c.rank,
          }))
        : null;

    await invoke("mcp_stream_edit_preview", {
      editId,
      ok: result.ok,
      diff: result.diff ?? "",
      candidates,
      matchCount: result.matchCount,
      previewLines,
      error: result.error ?? null,
    }).catch(() => {/* non-fatal */});
  });
}

// ── mcp://stream-edit-apply ───────────────────────────────────────────────────

export function handleStreamEditApply(syncNow: () => void): Promise<UnlistenFn> {
  return listen<StreamEditApplyPayload>("mcp://stream-edit-apply", async (e) => {
    const { editId, matchIndex = 0, save = false, path: assertPath } = e.payload;

    if (assertPath) {
      const openPath = useDocumentStore.getState().path;
      if (!openPath || openPath !== assertPath) {
        await invoke("mcp_stream_edit_apply_result", {
          editId,
          ok: false,
          replaced: 0,
          matchIndex,
          error: `Path mismatch: '${assertPath}' is not the currently open document.`,
        }).catch(() => {/* non-fatal */});
        return;
      }
    }

    const applyPayload = e.payload as StreamEditApplyPayload & {
      find?: string;
      replace?: string;
    };
    const find = applyPayload.find ?? "";
    const replace = applyPayload.replace ?? "";

    if (!find) {
      await invoke("mcp_stream_edit_apply_result", {
        editId,
        ok: false,
        replaced: 0,
        matchIndex,
        error: "`find` is required in stream-edit-apply payload.",
      }).catch(() => {/* non-fatal */});
      return;
    }

    const liveContent = useDocumentStore.getState().content;

    try {
      const outcome = applyEditAtOccurrence(liveContent, find, replace, matchIndex);
      if (outcome.ok && outcome.content !== undefined) {
        useDocumentStore.getState().setContent(outcome.content);
        if (save) {
          await useDocumentStore.getState().save();
        }
        syncNow();
      }
      await invoke("mcp_stream_edit_apply_result", {
        editId,
        ok: outcome.ok,
        replaced: outcome.replaced,
        matchIndex,
        error: outcome.error ?? null,
      }).catch(() => {/* non-fatal */});
    } catch (err) {
      await invoke("mcp_stream_edit_apply_result", {
        editId,
        ok: false,
        replaced: 0,
        matchIndex,
        error: `stream-edit-apply failed: ${String(err)}`,
      }).catch(() => {/* non-fatal */});
    }
  });
}
