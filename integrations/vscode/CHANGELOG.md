# Changelog

All notable changes to the **Open in Ashlr MD** VS Code extension.

## [Unreleased]

### Fixed

- Only files Ashlr MD opens are handed off: a Markdown extension (`.md`,
  `.markdown`, `.mdown`, `.mkd`, `.mdx`) and a name that is not a dotfile.
  A dotfile, or a file merely in the Markdown language mode, used to be sent
  as a link the app ignores, so nothing opened and nothing said why.

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
