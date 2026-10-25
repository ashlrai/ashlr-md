/**
 * shortcutSheet.ts: the rows of the in-app keyboard shortcut cheat sheet
 * (Help > Keyboard shortcuts, mod+/). Built from the command registry, so a
 * new shortcut shows up here the moment it is bound, plus the bindings the
 * editors own outside the registry.
 */

import { COMMAND_GROUPS, type Command } from "./commands";

export interface ShortcutRow {
  title: string;
  /** Registry shortcut strings ("mod+shift+l"); format with formatShortcut. */
  keys: string[];
}

export interface ShortcutGroup {
  group: string;
  rows: ShortcutRow[];
}

/** Bound by the editors themselves, not the registry (docFacts EDITOR_SHORTCUTS). */
export const EDITOR_SHORTCUTS: ShortcutRow[] = [
  { title: "Inline AI rewrite", keys: ["mod+i"] },
];

/** Group order on the sheet: the palette's (COMMAND_GROUPS); unknown groups follow. */
const ORDER: readonly string[] = COMMAND_GROUPS;

export function shortcutSheet(commands: readonly Command[]): ShortcutGroup[] {
  const groups = new Map<string, ShortcutRow[]>();
  const seen = new Set<string>();
  for (const c of commands) {
    if (!c.shortcut || seen.has(c.shortcut)) continue;
    seen.add(c.shortcut);
    const rows = groups.get(c.group) ?? [];
    rows.push({ title: c.title, keys: [c.shortcut] });
    groups.set(c.group, rows);
  }
  const rank = (g: string) => {
    const i = ORDER.indexOf(g);
    return i === -1 ? ORDER.length : i;
  };
  const out = [...groups.entries()]
    .map(([group, rows]) => ({ group, rows }))
    .sort((a, b) => rank(a.group) - rank(b.group));
  const editor = EDITOR_SHORTCUTS.filter((r) => r.keys.every((k) => !seen.has(k)));
  if (editor.length > 0) out.push({ group: "In the editor", rows: editor });
  return out;
}
