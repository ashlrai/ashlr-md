/**
 * sourceSearchBridge.ts — a module-level handle to the active CodeMirror view.
 *
 * Lets command handlers in commands.ts open the source editor's native search
 * panel without importing React or threading refs through the component tree.
 * SourceEditor registers/unregisters its view on mount/unmount.
 */

import type { EditorView } from "@codemirror/view";

let activeView: EditorView | null = null;

export function setSourceView(view: EditorView | null): void {
  activeView = view;
}

export function getSourceView(): EditorView | null {
  return activeView;
}
