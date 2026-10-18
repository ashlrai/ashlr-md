/**
 * The plugin's pure helpers and user-facing strings, kept apart from
 * `main.ts` (which needs the `obsidian` module at runtime) so `npm test` can
 * run them under `node:test`.
 */

/** The extensions Ashlr MD opens from a link (`MD_EXTENSIONS` in the app). */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);

/**
 * Whether Ashlr MD opens a vault file from a link: a Markdown document that
 * is not a dotfile. The app ignores any other link without a word, so
 * offering it for a PDF, an image or a `.canvas` used to do nothing when
 * clicked.
 */
export function isOpenableInAshlr(file: { extension: string; name: string }): boolean {
	return MARKDOWN_EXTENSIONS.has(file.extension.toLowerCase()) && !file.name.startsWith(".");
}

/**
 * Builds the `mdopener://open` URL for the given absolute path and mode.
 * The path is percent-encoded so spaces and special characters are safe.
 */
export function buildUrl(absolutePath: string, mode?: "read" | "edit"): string {
	const modeParam = mode ? `&mode=${mode}` : "";
	return `mdopener://open?path=${encodeURIComponent(absolutePath)}${modeParam}`;
}

/** The command palette names of the plugin's two commands. */
export const OPEN_COMMAND_NAME = "Open current note in Ashlr MD";
export const OPEN_EDIT_COMMAND_NAME = "Open current note in Ashlr MD (edit mode)";

/**
 * The description of the "Open in edit mode by default" setting. It used to
 * point at an "Open in edit mode" command, a name the palette does not list,
 * so searching for it found nothing.
 */
export const EDIT_MODE_SETTING_DESC =
	"When enabled, notes are opened in Ashlr MD's WYSIWYG editor instead of " +
	`read view. You can still use the "${OPEN_EDIT_COMMAND_NAME}" command to ` +
	"force edit mode on a per-note basis.";
