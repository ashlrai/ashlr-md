/**
 * digestStore.ts — the "while you were away" Agent Activity Digest.
 *
 * On launch, finds the Markdown files in the watched folder that changed since
 * the user was last here and asks the on-device AI for a short briefing of what
 * changed + what needs review. This is the recurring ritual that converts a
 * one-shot "an agent wrote me a file" open into a daily return loop — and it
 * runs fully locally by default (Apple FM / Ollama), no data egress.
 */

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { detectProvider, getCachedProvider } from "../ai/registry";
import { listMarkdownFiles, type MdFileInfo } from "../lib/activity";
import { useActivityStore } from "./activityStore";

const MAX_FILES = 8;
const MAX_CHARS_PER_FILE = 2000;
/** Pull enough files that a busy agent session isn't silently truncated. */
const SCAN_LIMIT = 2000;
/** Hard cap so a hung AI backend can't pin the card on "computing" forever. */
const SUMMARY_TIMEOUT_MS = 30_000;

type DigestStatus = "hidden" | "computing" | "ready";

interface DigestState {
  status: DigestStatus;
  changedFiles: MdFileInfo[];
  summary: string;
  /** Monotonic id so a dismissed/superseded run can't overwrite newer state. */
  genId: number;
  /** Build a digest of files changed since `sinceMs`. No-op without a watch. */
  generate: (sinceMs: number) => Promise<void>;
  dismiss: () => void;
}

function fallbackList(files: MdFileInfo[]): string {
  return files
    .slice(0, MAX_FILES)
    .map((f) => `• ${f.name}`)
    .join("\n");
}

async function summarize(files: MdFileInfo[], signal: AbortSignal): Promise<string> {
  // Reuse the startup-warmed provider when available to skip re-detection.
  const provider = getCachedProvider() ?? (await detectProvider());
  const shown = files.slice(0, MAX_FILES);

  // No AI available — fall back to a plain list of what changed.
  if (provider.id === "noop") return fallbackList(shown);

  const parts: string[] = [];
  for (const f of shown) {
    try {
      const file = await invoke<{ content: string }>("read_markdown_file", {
        path: f.path,
      });
      parts.push(`## ${f.name}\n${file.content.slice(0, MAX_CHARS_PER_FILE)}`);
    } catch {
      // Skip unreadable files.
    }
  }
  if (parts.length === 0) return fallbackList(shown);

  const prompt =
    "These Markdown files changed in the user's watched folder since they last " +
    "looked. Write a concise briefing (3 to 5 short lines) of what changed and what " +
    "needs their review. Be specific, lead with the most important change, and " +
    "skip any preamble.\n\n" +
    parts.join("\n\n");

  let out = "";
  for await (const delta of provider.generate([{ role: "user", content: prompt }], {
    signal,
  })) {
    out += delta;
  }
  return out.trim() || fallbackList(shown);
}

export const useDigestStore = create<DigestState>((set, get) => ({
  status: "hidden",
  changedFiles: [],
  summary: "",
  genId: 0,

  generate: async (sinceMs) => {
    // One digest at a time.
    if (get().status === "computing") return;

    const dir = useActivityStore.getState().watchedDir;
    if (!dir) return;

    let files: MdFileInfo[];
    try {
      files = await listMarkdownFiles(dir, SCAN_LIMIT);
    } catch {
      return;
    }
    // Changed since last seen, but never future-dated (clock-skew guard).
    const now = Date.now();
    const changed = files.filter((f) => f.mtimeMs > sinceMs && f.mtimeMs <= now);
    if (changed.length === 0) return;

    const genId = get().genId + 1;
    set({ status: "computing", changedFiles: changed, summary: "", genId });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    let summary: string;
    try {
      summary = await summarize(changed, controller.signal);
    } catch {
      // AI failed/timed out — still surface the file list so the loop isn't lost.
      summary = fallbackList(changed);
    } finally {
      clearTimeout(timer);
    }

    // Ignore the result if the user dismissed or a newer run superseded us.
    if (get().genId !== genId) return;
    set({ status: "ready", summary });
  },

  // Bump genId so any in-flight summarize() result is discarded.
  dismiss: () =>
    set((s) => ({
      status: "hidden",
      changedFiles: [],
      summary: "",
      genId: s.genId + 1,
    })),
}));
