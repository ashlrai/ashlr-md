/**
 * activity.ts — thin typed bridge to the Tauri "Agent Activity" backend.
 *
 * Wraps the directory-watch commands and the `activity://file` event stream so
 * the rest of the app never touches `invoke`/`listen` directly. Keeping the
 * Tauri surface in one place means the store and UI stay framework-agnostic and
 * trivially mockable in tests.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A Markdown file surfaced by the watcher / directory listing. */
export interface MdFileInfo {
  /** Absolute path on disk. */
  path: string;
  /** File name (basename), e.g. "PLAN.md". */
  name: string;
  /** Parent directory (absolute). */
  dir: string;
  /** Last-modified time in epoch milliseconds. */
  mtimeMs: number;
  /** Size in bytes. */
  size: number;
}

/** Payload of the `activity://file` event. A superset of {@link MdFileInfo}. */
export interface ActivityEvent extends MdFileInfo {
  /** Whether the watcher saw the file appear or change. */
  kind: "created" | "modified";
}

/** Name of the file-activity event emitted by the backend watcher. */
export const ACTIVITY_EVENT = "activity://file" as const;

// ---------------------------------------------------------------------------
// Command wrappers
// ---------------------------------------------------------------------------

/** Recursively watch `path`; replaces any prior watch. */
export function watchDirectory(path: string): Promise<void> {
  return invoke<void>("watch_directory", { path });
}

/** Stop watching the current directory (if any). */
export function unwatchDirectory(): Promise<void> {
  return invoke<void>("unwatch_directory");
}

/**
 * List Markdown files under `path`, newest first.
 * @param limit Max files to return (backend default is 100).
 */
export function listMarkdownFiles(path: string, limit?: number): Promise<MdFileInfo[]> {
  return invoke<MdFileInfo[]>("list_markdown_files", { path, limit });
}

/** {@link listMarkdownFiles} plus whether the walk was cut short. */
export interface MdFileScan {
  /** The newest files found, newest first. */
  files: MdFileInfo[];
  /**
   * The folder was too large (50,000 entries) or too deep (folders more than
   * 8 levels down) to walk in full, so `files` are the newest of
   * the files the walk reached, not necessarily the folder's newest.
   */
  scanCut: boolean;
}

/** List Markdown files under `path`, newest first, and say if the walk was cut. */
export function scanMarkdownFiles(path: string, limit?: number): Promise<MdFileScan> {
  return invoke<MdFileScan>("scan_markdown_files", { path, limit });
}

// ---------------------------------------------------------------------------
// Event subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe to live file-activity events.
 * @returns A promise resolving to an unlisten function; call it to stop.
 */
export function onActivityFile(cb: (ev: ActivityEvent) => void): Promise<() => void> {
  return listen<ActivityEvent>(ACTIVITY_EVENT, (e) => cb(e.payload));
}
