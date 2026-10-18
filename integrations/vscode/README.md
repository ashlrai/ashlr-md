# Open in Ashlr MD: VS Code Extension

Open the active Markdown file in the **[Ashlr MD](https://md.ashlr.ai)** desktop
app (a beautiful, AI-native Markdown app) directly from VS Code.

> **Desktop-only.** Requires Ashlr MD installed so the `mdopener://` URL scheme
> is registered on your machine.

---

## What it does

| Entry point | Action |
|---|---|
| **Editor title-bar button** (link icon, Markdown files only) | Open the active file in Ashlr MD; **Alt/Option-click** opens it in edit mode |
| **Command palette** → "Ashlr MD: Open in Ashlr MD" | Open the active Markdown file (in edit mode when `ashlr-md.openInEditMode` is on) |
| **Command palette** → "Ashlr MD: Open in Ashlr MD (Edit Mode)" | Always open the active Markdown file in edit mode |

The button and commands appear only when a Markdown file is active: one in
the Markdown language mode, or with any extension Ashlr MD opens (`.md`,
`.markdown`, `.mdown`, `.mkd`, `.mdx`), which VS Code may show in another
language mode (`.mdx` usually is):

```
resourceLangId == markdown || resourceExtname =~ /^\.(md|markdown|mdown|mkd|mdx)$/i
```

---

## How it works

The extension resolves the file's absolute on-disk path, URI-encodes it, and
opens the deep link:

```
mdopener://open?path=<encoded-absolute-path>[&mode=edit]
```

via `vscode.env.openExternal`. `&mode=edit` (sent by the edit-mode command,
or by every open when `ashlr-md.openInEditMode` is on) opens the file in
Ashlr MD's edit view, as the Obsidian plugin's edit-mode command does. Ashlr MD registers this custom URL scheme and
brings the file up instantly (cold-starting the app if needed).

**CLI fallback.** If the deep link cannot be opened, the extension falls back to
spawning the bundled `mdopen` CLI:

```
mdopen [--edit] -- <absolute-path>
```

and reports an error unless `mdopen` exits `0` (it exits `1` when the file
could not be opened; a `mdopen` killed by a signal counts as a failure too).
When `mdopen` ran and said why it could not open the file, the error passes
that reason on.

The CLI path is configurable via the **`ashlr-md.cliPath`** setting (default
`mdopen`, resolved on your `PATH`). Install the CLI from inside Ashlr MD:
**Preferences, Command-line tool, Install `mdopen`**.

### Edge cases handled

- **No active editor:** informational message.
- **Not a file Ashlr MD opens:** informational message. Ashlr MD opens only
  Markdown files (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`) that are not
  dotfiles, and ignores a link to any other file, so a dotfile (`.notes.md`)
  or a file merely shown in the Markdown language mode is not handed off.
- **Untitled / never-saved file:** prompts you to save first (there is no
  on-disk path to hand off). Saved-but-dirty files open their last-saved
  on-disk version (the extension does not auto-save).

---

## Requirements

- **Ashlr MD** installed ([download here](https://md.ashlr.ai)) so the
  `mdopener://` scheme is registered.
- VS Code **1.85.0** or later.

---

## Build

```bash
cd integrations/vscode
npm install
npm run compile     # tsc → out/extension.js
npm test            # compile, then run the helper tests with node:test
```

`npm test` runs `src/*.test.ts` (the pure helpers in `src/links.ts`: which
files Ashlr MD opens and the deep link; and the `mdopen` fallback in
`src/cli.ts`) under Node's built-in `node:test`
runner, with no test dependencies; the tests are left out of the `.vsix`.

Or with Bun:

```bash
bun install
bun run compile
```

### Package a `.vsix`

```bash
npm install -g @vscode/vsce   # one-time
npm run package               # → ashlr-md-vscode.vsix
```

---

## Install (from source)

1. Build (see above) so `out/extension.js` exists.
2. Either:
   - Open this `integrations/vscode/` folder in VS Code and press **F5** to
     launch an Extension Development Host, **or**
   - Run `npm run package` and install the resulting `.vsix` via
     **Extensions panel → ⋯ → Install from VSIX…**.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `ashlr-md.cliPath` | `mdopen` | Path to the `mdopen` CLI used as a fallback if the deep link cannot be opened. |
| `ashlr-md.openInEditMode` | `false` | Open files in edit mode by default (`&mode=edit`). The edit-mode command always does. |

---

## Caveats

- **Ashlr MD must be installed.** If the `mdopener://` scheme is not registered
  and the `mdopen` CLI cannot be run, the extension shows an error pointing
  to [md.ashlr.ai](https://md.ashlr.ai) and to where Ashlr MD installs
  `mdopen`.
- **Not published to the Marketplace** yet; install from source / `.vsix`.

---

## License

MIT. Part of the [Ashlr MD](https://github.com/ashlrai/ashlr-md) project.
