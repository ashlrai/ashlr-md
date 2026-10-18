/**
 * Open in Ashlr MD — VS Code extension.
 *
 * Adds commands + an editor title-bar button that open the active Markdown
 * file in the Ashlr MD desktop app, in its read view or (on request, or with
 * `ashlr-md.openInEditMode`) its edit view.
 *
 * Primary mechanism: the `mdopener://open?path=<encoded-absolute-path>[&mode=edit]`
 * deep link, opened via `vscode.env.openExternal`. Ashlr MD registers this custom
 * URL scheme and percent-decodes the `path` parameter (see
 * `src-tauri/src/deep_link.rs` + `src-tauri/bins/mdopen/src/main.rs`).
 *
 * Fallback: if the deep link cannot be opened, spawn the `mdopen [--edit] -- <path>`
 * CLI (configurable via `ashlr-md.cliPath`, default `mdopen` on PATH).
 */

import * as vscode from "vscode";
import { cliFailureMessage, openViaCli } from "./cli";
import { buildDeepLink, handoffRefusal, type OpenMode } from "./links";

export { buildDeepLink, isOpenableInAshlr } from "./links";

/**
 * Core command: open the active editor's Markdown file in Ashlr MD, in edit
 * mode when `mode` says so (else when `ashlr-md.openInEditMode` is on).
 */
async function openInAshlr(mode?: OpenMode): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage(
      "Ashlr MD: no active editor. Open a Markdown file first.",
    );
    return;
  }

  const document = editor.document;

  // A document with no file on disk is told to save first; any other file
  // Ashlr MD does not open is told which files it does.
  const refusal = handoffRefusal({
    fsPath: document.uri.fsPath,
    isUntitled: document.isUntitled,
    scheme: document.uri.scheme,
  });
  if (refusal) {
    vscode.window.showInformationMessage(refusal);
    return;
  }

  // Use the on-disk path. Unsaved edits stay in VS Code; Ashlr MD opens the
  // last-saved version on disk (we intentionally do not auto-save here).
  const absolutePath = document.uri.fsPath;
  const config = vscode.workspace.getConfiguration("ashlr-md");
  const openMode: OpenMode =
    mode ?? (config.get<boolean>("openInEditMode") ? "edit" : undefined);
  const deepLink = buildDeepLink(absolutePath, openMode);

  // Primary path: the mdopener:// deep link.
  try {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(deepLink));
    if (opened) {
      return;
    }
  } catch {
    // Fall through to the CLI fallback.
  }

  // Fallback: spawn the `mdopen` CLI.
  const cliPath = config.get<string>("cliPath")?.trim() || "mdopen";

  const outcome = await openViaCli(cliPath, absolutePath, openMode);
  if (outcome.kind === "opened") {
    return;
  }

  vscode.window.showErrorMessage(cliFailureMessage(cliPath, outcome));
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // Called from a menu, a command receives the resource URI as its first
    // argument, so it is not passed on as the mode.
    vscode.commands.registerCommand("ashlr-md.openInAshlr", () =>
      openInAshlr(),
    ),
    vscode.commands.registerCommand("ashlr-md.openInAshlrEditMode", () =>
      openInAshlr("edit"),
    ),
  );
}

export function deactivate(): void {
  // Nothing to clean up — all disposables are tracked in context.subscriptions.
}
