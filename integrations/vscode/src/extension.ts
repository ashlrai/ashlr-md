/**
 * Open in Ashlr MD — VS Code extension.
 *
 * Adds a command + editor title-bar button that opens the active Markdown
 * file in the Ashlr MD desktop app.
 *
 * Primary mechanism: the `mdopener://open?path=<encoded-absolute-path>` deep
 * link, opened via `vscode.env.openExternal`. Ashlr MD registers this custom
 * URL scheme and percent-decodes the `path` parameter (see
 * `src-tauri/src/deep_link.rs` + `src-tauri/bins/mdopen/src/main.rs`).
 *
 * Fallback: if the deep link cannot be opened, spawn the `mdopen -- <path>` CLI
 * (configurable via `ashlr-md.cliPath`, default `mdopen` on PATH).
 */

import { spawn } from "node:child_process";
import * as vscode from "vscode";

/** The extensions Ashlr MD opens from a link (`MD_EXTENSIONS` in the app). */
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd", ".mdx"];

/**
 * Builds the `mdopener://open` deep link for an absolute path.
 *
 * The path is encoded with `encodeURIComponent`, matching the Obsidian
 * integration. Ashlr MD's handler percent-decodes the `path` parameter and
 * canonicalizes it, so encoding spaces/special characters here is both safe
 * and required for paths that contain them.
 */
export function buildDeepLink(absolutePath: string): string {
  return `mdopener://open?path=${encodeURIComponent(absolutePath)}`;
}

/**
 * True when Ashlr MD opens the file from a link: a Markdown extension and a
 * name that is not a dotfile, the rule the app applies. The app ignores any
 * other link without a word, so a dotfile (`.notes.md`) or a file VS Code
 * merely shows in the Markdown language mode (a `.txt`) used to be handed
 * off and then nothing opened.
 */
export function isOpenableInAshlr(fsPath: string): boolean {
  const name = fsPath.split(/[\\/]/).pop() ?? "";
  const lower = name.toLowerCase();
  return (
    !name.startsWith(".") &&
    MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
  );
}

/**
 * Fallback: spawn the `mdopen -- <path>` CLI. Resolves true only when it
 * exits 0 (it exits 1 when the file could not be opened); false when it
 * cannot be spawned, exits non-zero, or is killed by a signal (a `null`
 * exit code, which used to count as success), so the caller can surface an
 * error. `--` keeps a path that starts with `-` from being read as a flag.
 */
function openViaCli(cliPath: string, absolutePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };

    try {
      const child = spawn(cliPath, ["--", absolutePath], {
        stdio: "ignore",
      });
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
    } catch {
      done(false);
    }
  });
}

/**
 * Core command: open the active editor's Markdown file in Ashlr MD.
 */
async function openInAshlr(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage(
      "Ashlr MD: no active editor. Open a Markdown file first.",
    );
    return;
  }

  const document = editor.document;

  if (!isOpenableInAshlr(document.uri.fsPath)) {
    vscode.window.showInformationMessage(
      "Ashlr MD: Ashlr MD opens only Markdown files (.md, .markdown, .mdown, " +
        ".mkd, .mdx) that are not dotfiles.",
    );
    return;
  }

  // Untitled / never-saved files have no on-disk path to hand off.
  if (document.isUntitled || document.uri.scheme !== "file") {
    vscode.window.showInformationMessage(
      "Ashlr MD: save the file to disk first, then open it in Ashlr MD.",
    );
    return;
  }

  // Use the on-disk path. Unsaved edits stay in VS Code; Ashlr MD opens the
  // last-saved version on disk (we intentionally do not auto-save here).
  const absolutePath = document.uri.fsPath;
  const deepLink = buildDeepLink(absolutePath);

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
  const cliPath =
    vscode.workspace
      .getConfiguration("ashlr-md")
      .get<string>("cliPath")
      ?.trim() || "mdopen";

  const cliOpened = await openViaCli(cliPath, absolutePath);
  if (cliOpened) {
    return;
  }

  vscode.window.showErrorMessage(
    "Ashlr MD: could not open the file. Make sure Ashlr MD is installed " +
      "(https://md.ashlr.ai) so the mdopener:// scheme is registered, or set " +
      "`ashlr-md.cliPath` to your `mdopen` CLI.",
  );
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("ashlr-md.openInAshlr", openInAshlr),
  );
}

export function deactivate(): void {
  // Nothing to clean up — all disposables are tracked in context.subscriptions.
}
