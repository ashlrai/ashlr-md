/**
 * globalKeys.ts — the app's window-level keydown handler.
 *
 * Driven entirely by the command registry so the keymap is a single source of
 * truth (see src/lib/commands.ts). Each command carries its canonical shortcut
 * string; the event is matched against the live list and the first available
 * command whose shortcut matches runs.
 */

import { useUiStore } from "../store/uiStore";
import { getShortcutCommands } from "./commands";
import { isDismissEscape, matchShortcut } from "./keymap";

export function handleGlobalKeyDown(e: KeyboardEvent): void {
  // Escape leaves Zen mode first; it isn't expressible as a mod-shortcut.
  // Not an Escape that ends an IME composition (isDismissEscape), which
  // used to leave Zen mode while typing in it.
  if (isDismissEscape(e) && useUiStore.getState().zenMode) {
    e.preventDefault();
    useUiStore.getState().closeZen();
    return;
  }
  for (const cmd of getShortcutCommands()) {
    if (cmd.shortcut && matchShortcut(e, cmd.shortcut)) {
      if (cmd.when && !cmd.when()) return; // shortcut owned but unavailable
      e.preventDefault();
      cmd.run();
      return;
    }
  }
}
