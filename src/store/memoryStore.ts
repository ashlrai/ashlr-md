/**
 * memoryStore.ts — local AI memory ("it knows my stuff").
 *
 * A small, user-owned set of facts/preferences/projects that gets injected into
 * AI context so the assistant stops asking for the same context and gets more
 * useful the more you use it — the switching-cost moat, kept fully local and
 * fully transparent (view/edit/delete in Settings). Nothing leaves the device.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
  /** Where it came from — typed by the user, or suggested by the AI. */
  source: "user" | "ai";
}

interface MemoryState {
  items: MemoryItem[];
  add: (text: string, source?: "user" | "ai") => void;
  remove: (id: string) => void;
  clear: () => void;
}

function makeId(): string {
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Cap how much memory is injected into a prompt, so it can't grow unbounded. */
const MAX_MEMORY_CHARS = 2_000;

export const useMemoryStore = create<MemoryState>()(
  persist(
    (set) => ({
      items: [],
      add: (text, source = "user") => {
        const t = text.trim();
        if (!t) return;
        set((s) =>
          // Dedup identical facts.
          s.items.some((i) => i.text === t)
            ? s
            : {
                items: [
                  ...s.items,
                  { id: makeId(), text: t, createdAt: Date.now(), source },
                ],
              },
        );
      },
      remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
      clear: () => set({ items: [] }),
    }),
    { name: "mdopener-memory" },
  ),
);

/**
 * Format memory into a system-prompt block, or "" when empty.
 * Bounded to MAX_MEMORY_CHARS so a long memory list can't bloat every prompt
 * (oldest-first; newest items are dropped if over budget).
 */
export function memoryBlock(): string {
  const { items } = useMemoryStore.getState();
  if (items.length === 0) return "";
  const header =
    "What you know about this user (preferences, projects, and facts they asked " +
    "you to remember):\n";
  let body = "";
  for (const i of items) {
    const line = `- ${i.text}\n`;
    if (header.length + body.length + line.length > MAX_MEMORY_CHARS) break;
    body += line;
  }
  return body ? header + body.trimEnd() : "";
}
