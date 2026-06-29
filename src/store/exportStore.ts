/**
 * exportStore.ts — async state tracker for batch document exports.
 *
 * Manages a single active batch export session at a time.  Components subscribe
 * to `useBatchExportStore` for live progress updates; the batch export logic in
 * export.ts writes into this store via the imperative `batchExport` singleton.
 *
 * State machine:
 *   idle → running → (completed | cancelled | error)
 *
 * The store is intentionally lightweight — it does NOT persist to localStorage
 * (exports are ephemeral operations, not user prefs) and does NOT hold file
 * contents (those are streamed through the Tauri invoke layer).
 */

import { create } from "zustand";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Status of one individual document in a batch export. */
export type DocExportStatus = "pending" | "in-flight" | "done" | "failed";

/** Per-document progress entry. */
export interface DocExportProgress {
  /** Unique key: `${path}::${format}` */
  key: string;
  /** Source document path. */
  path: string;
  /** Export format for this entry. */
  format: string;
  /** Current status. */
  status: DocExportStatus;
  /** Output file path once written (populated on success). */
  outputPath?: string;
  /** Error message when status === "failed". */
  error?: string;
  /** Wall-clock ms when the export started (in-flight transition). */
  startedAt?: number;
  /** Wall-clock ms when the export finished (done/failed transition). */
  finishedAt?: number;
}

/** Overall batch status. */
export type BatchStatus = "idle" | "running" | "completed" | "cancelled" | "error";

/** Result returned by exportBatch() on completion. */
export interface BatchExportResult {
  succeeded: number;
  failed: number;
  /** Path to the zip archive, if one was produced. */
  outputPath?: string;
  /** Per-doc results for further inspection. */
  entries: DocExportProgress[];
}

interface ExportState {
  // ── Runtime state ─────────────────────────────────────────────────────────
  status: BatchStatus;
  /** Entries in declaration order — UI renders them in insertion order. */
  entries: DocExportProgress[];
  /** Cancellation flag — set by cancel(); polled by the export loop. */
  cancelRequested: boolean;

  // ── Summary stats (derived but cached to avoid O(n) scans in hot renders) ─
  total: number;
  succeeded: number;
  failed: number;
  /** Number of entries currently in-flight. */
  inFlight: number;

  // ── Profile name shown in the progress modal header ───────────────────────
  activeProfileName: string | null;

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * Initialise a new batch run.  Resets all state and seeds the entries table
   * from the doc/format pairs the caller plans to export.
   */
  startBatch: (
    pairs: Array<{ path: string; format: string }>,
    profileName?: string,
  ) => void;

  /** Transition one entry to "in-flight". */
  markInFlight: (key: string) => void;

  /** Transition one entry to "done". */
  markDone: (key: string, outputPath: string) => void;

  /** Transition one entry to "failed". */
  markFailed: (key: string, error: string) => void;

  /** Signal cancellation — the running export loop checks this flag. */
  cancel: () => void;

  /** Finalise the batch after all entries settle. */
  finishBatch: (outputPath?: string) => void;

  /** Reset to idle (called when the modal is dismissed after completion). */
  reset: () => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useBatchExportStore = create<ExportState>((set) => ({
  status: "idle",
  entries: [],
  cancelRequested: false,
  total: 0,
  succeeded: 0,
  failed: 0,
  inFlight: 0,
  activeProfileName: null,

  startBatch: (pairs, profileName) => {
    const entries: DocExportProgress[] = pairs.map(({ path, format }) => ({
      key: `${path}::${format}`,
      path,
      format,
      status: "pending",
    }));
    set({
      status: "running",
      entries,
      cancelRequested: false,
      total: entries.length,
      succeeded: 0,
      failed: 0,
      inFlight: 0,
      activeProfileName: profileName ?? null,
    });
  },

  markInFlight: (key) =>
    set((s) => {
      const entries = s.entries.map((e) =>
        e.key === key ? { ...e, status: "in-flight" as DocExportStatus, startedAt: Date.now() } : e,
      );
      return { entries, inFlight: s.inFlight + 1 };
    }),

  markDone: (key, outputPath) =>
    set((s) => {
      const entries = s.entries.map((e) =>
        e.key === key
          ? { ...e, status: "done" as DocExportStatus, outputPath, finishedAt: Date.now() }
          : e,
      );
      return { entries, succeeded: s.succeeded + 1, inFlight: Math.max(0, s.inFlight - 1) };
    }),

  markFailed: (key, error) =>
    set((s) => {
      const entries = s.entries.map((e) =>
        e.key === key
          ? { ...e, status: "failed" as DocExportStatus, error, finishedAt: Date.now() }
          : e,
      );
      return { entries, failed: s.failed + 1, inFlight: Math.max(0, s.inFlight - 1) };
    }),

  cancel: () => set({ cancelRequested: true }),

  finishBatch: (outputPath) =>
    set((s) => ({
      status: s.cancelRequested
        ? "cancelled"
        : s.failed > 0
          ? "error"
          : "completed",
      // Store the zip output path by re-using the first entry's outputPath slot
      // or a dedicated field. We attach it as a synthetic entry so the modal can
      // surface it in the success state without adding a separate field.
      entries: outputPath
        ? [
            ...s.entries,
            {
              key: "__zip__",
              path: outputPath,
              format: "zip",
              status: "done",
              outputPath,
            },
          ]
        : s.entries,
    })),

  reset: () =>
    set({
      status: "idle",
      entries: [],
      cancelRequested: false,
      total: 0,
      succeeded: 0,
      failed: 0,
      inFlight: 0,
      activeProfileName: null,
    }),
}));

// ─── Derived selectors (stable, memoised-friendly) ────────────────────────────

/** Returns the zip output path when the batch has completed, or undefined. */
export function selectZipOutputPath(entries: DocExportProgress[]): string | undefined {
  return entries.find((e) => e.key === "__zip__")?.outputPath;
}

/** Returns only the "real" (non-zip-sentinel) entries. */
export function selectRealEntries(entries: DocExportProgress[]): DocExportProgress[] {
  return entries.filter((e) => e.key !== "__zip__");
}

/** Per-format throughput: completed docs per second for each format. */
export function selectThroughput(
  entries: DocExportProgress[],
): Record<string, number> {
  const real = selectRealEntries(entries);
  const byFormat: Record<string, { count: number; totalMs: number }> = {};
  for (const e of real) {
    if (e.status !== "done" || !e.startedAt || !e.finishedAt) continue;
    const fmt = e.format;
    if (!byFormat[fmt]) byFormat[fmt] = { count: 0, totalMs: 0 };
    byFormat[fmt].count += 1;
    byFormat[fmt].totalMs += e.finishedAt - e.startedAt;
  }
  const result: Record<string, number> = {};
  for (const [fmt, { count, totalMs }] of Object.entries(byFormat)) {
    // docs per second; avoid division by zero
    result[fmt] = totalMs > 0 ? (count / totalMs) * 1000 : 0;
  }
  return result;
}
