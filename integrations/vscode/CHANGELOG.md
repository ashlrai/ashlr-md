# Changelog

All notable changes to the **Open in Ashlr MD** VS Code extension.

## [Unreleased]

### Added

- Command **Ashlr MD: Open in Ashlr MD (Edit Mode)**
  (`ashlr-md.openInAshlrEditMode`), also on Alt/Option-click of the title-bar
  button, opens the file in Ashlr MD's edit mode (`&mode=edit`, and
  `mdopen --edit` for the fallback), as the Obsidian plugin's edit-mode
  command does. The `ashlr-md.openInEditMode` setting makes edit mode the
  default for the plain command.
- `npm test` compiles the extension and runs tests for its pure helpers
  (`src/links.ts`: `isOpenableInAshlr`, `buildDeepLink`) with Node's built-in
  `node:test`; there were none.

### Fixed

- The title-bar button and the commands are offered for every extension
  Ashlr MD opens (`resourceExtname`), not only for files in the Markdown
  language mode, so an `.mdx` file (which VS Code usually shows as MDX, or as
  plain text) had no button although the app opens it.
- Only files Ashlr MD opens are handed off: a Markdown extension (`.md`,
  `.markdown`, `.mdown`, `.mkd`, `.mdx`) and a name that is not a dotfile.
  A dotfile, or a file merely in the Markdown language mode, used to be sent
  as a link the app ignores, so nothing opened and nothing said why.
- The `mdopen` fallback counts only exit status `0` as opened; a `mdopen`
  killed by a signal used to count as success, so no error was shown. It
  is run as `mdopen -- <path>`.

## [1.0.0]

### Added

- Command **Ashlr MD: Open in Ashlr MD** (`ashlr-md.openInAshlr`) that opens the
  active `.md` / `.markdown` file in the Ashlr MD desktop app.
- Editor title-bar button (link-external icon) shown only when a Markdown file
  is active (`resourceLangId == markdown`).
- Primary open mechanism: the `mdopener://open?path=<encoded-absolute-path>`
  deep link via `vscode.env.openExternal`.
- Fallback: spawn the `mdopen <path>` CLI, configurable via `ashlr-md.cliPath`
  (default `mdopen`).
- Friendly messages for: no active editor, non-Markdown file, and untitled /
  never-saved files (prompts the user to save first).
