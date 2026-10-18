/**
 * The extension's pure helpers: which files Ashlr MD opens, and the deep link
 * that opens one. Kept apart from `extension.ts`, which needs the `vscode`
 * module, so `npm test` can run them under `node:test`.
 */

/** The extensions Ashlr MD opens from a link (`MD_EXTENSIONS` in the app). */
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd", ".mdx"];

/** The view to open a file in: the app's edit view, or the view it keeps. */
export type OpenMode = "edit" | undefined;

/**
 * Builds the `mdopener://open` deep link for an absolute path, with
 * `&mode=edit` to open it in edit mode (as the Obsidian integration sends).
 *
 * The path is encoded with `encodeURIComponent`, matching the Obsidian
 * integration. Ashlr MD's handler percent-decodes the `path` parameter and
 * canonicalizes it, so encoding spaces/special characters here is both safe
 * and required for paths that contain them.
 */
export function buildDeepLink(absolutePath: string, mode?: OpenMode): string {
  const modeParam = mode ? `&mode=${mode}` : "";
  return `mdopener://open?path=${encodeURIComponent(absolutePath)}${modeParam}`;
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

/** What the extension says for a file it cannot hand off, by reason. */
export const NOT_SAVED_MESSAGE =
  "Ashlr MD: save the file to disk first, then open it in Ashlr MD.";
export const NOT_OPENABLE_MESSAGE =
  "Ashlr MD: Ashlr MD opens only Markdown files (.md, .markdown, .mdown, " +
  ".mkd, .mdx) that are not dotfiles.";

/**
 * Why the document cannot be handed off to Ashlr MD, or `undefined` when it
 * can. A document with no file on disk is told to save first before its
 * name is judged: an untitled Markdown buffer is named `Untitled-1`, which
 * has no Markdown extension, so it used to be told Ashlr MD opens only
 * Markdown files although it was one.
 */
export function handoffRefusal(doc: {
  fsPath: string;
  isUntitled: boolean;
  scheme: string;
}): string | undefined {
  if (doc.isUntitled || doc.scheme !== "file") return NOT_SAVED_MESSAGE;
  if (!isOpenableInAshlr(doc.fsPath)) return NOT_OPENABLE_MESSAGE;
  return undefined;
}
