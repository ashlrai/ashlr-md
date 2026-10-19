// Startup semantic re-index, run once a few seconds after launch (App.tsx).
// Opt-in: Settings > Semantic search > "Keep the index fresh automatically"
// (`autoEmbedIndex`). Off means nothing is checked or indexed; the manual
// "Reindex library" button in Settings always works.

import { useRecentStore } from "../store/recentStore";
import { useSettingsStore } from "../store/settingsStore";

/** Full reindex (prunes stale files) of the recents and watched-folder files. */
export async function runStartupEmbedIndex(): Promise<void> {
  if (!useSettingsStore.getState().autoEmbedIndex) return;
  const { embedAvailable, embedIndex } = await import("./embedSearch");
  if (!(await embedAvailable())) return;
  const { useActivityStore } = await import("../store/activityStore");
  // Ensure the watched-folder file list is populated before indexing.
  await useActivityStore.getState().loadFiles();
  const paths = new Set<string>();
  for (const r of useRecentStore.getState().recents) paths.add(r.path);
  for (const f of useActivityStore.getState().files) paths.add(f.path);
  // Full reindex (prune stale files) since this is the complete library.
  if (paths.size > 0) void embedIndex(Array.from(paths), true);
}
