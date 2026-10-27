/**
 * tabNames.ts — tell apart open documents that share a file name.
 *
 * Tabs show the file name alone, so two `README.md` tabs from different
 * folders looked the same. {@link tabFolderHints} gives each tab whose name
 * another tab shares the fewest trailing folders of its path that tell it
 * apart from the others of that name.
 */

interface NamedTab {
  id: string;
  path: string;
  fileName: string;
}

/** The folders of `path`, without the file name and empty segments. */
function folders(path: string): string[] {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  parts.pop();
  return parts;
}

/**
 * For each tab whose file name (ignoring case) another tab shares, the
 * fewest trailing folders of its path, joined by "/", that no other tab of
 * that name ends in too. Tabs with a name of their own get no entry, nor do
 * tabs no folder can tell apart (an unsaved tab, two tabs of one path).
 */
export function tabFolderHints(tabs: readonly NamedTab[]): Map<string, string> {
  const byName = new Map<string, NamedTab[]>();
  for (const t of tabs) {
    const name = (t.fileName || "Untitled").toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), t]);
  }
  const hints = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const dirs = group.map((t) => folders(t.path));
    const deepest = Math.max(...dirs.map((d) => d.length));
    for (const [i, t] of group.entries()) {
      const own = dirs[i];
      for (let depth = 1; depth <= deepest; depth++) {
        const hint = own.slice(-depth).join("/").toLowerCase();
        const shared = dirs.some(
          (d, j) => j !== i && d.slice(-depth).join("/").toLowerCase() === hint,
        );
        // Out of folders: its whole folder still tells it from a deeper
        // one ("x" beside "a/x"), unless another tab is in that same folder.
        if (!shared || depth >= own.length) {
          const same = dirs.some(
            (d, j) =>
              j !== i && d.join("/").toLowerCase() === own.join("/").toLowerCase(),
          );
          if (own.length > 0 && !same) hints.set(t.id, own.slice(-depth).join("/"));
          break;
        }
      }
    }
  }
  return hints;
}
