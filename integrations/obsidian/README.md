# Open in Ashlr MD — Obsidian Plugin

Send any note from your [Obsidian](https://obsidian.md) vault to
**[Ashlr MD](https://md.ashlr.ai)** — a beautiful, AI-native Markdown app for
macOS — with a single click or keyboard shortcut.

> **Desktop-only.** Requires Ashlr MD installed so the `mdopener://` URL scheme
> is registered on your Mac.

---

## What it does

| Entry point | Action |
|---|---|
| **Ribbon icon** (left sidebar) | Open the active note in Ashlr MD |
| **Command palette** → "Open current note in Ashlr MD" | Open with your default mode setting |
| **Command palette** → "Open current note in Ashlr MD (edit mode)" | Always open in WYSIWYG edit mode |
| **Right-click a file** in the file explorer | "Open in Ashlr MD" |
| **Right-click** inside the editor | "Open in Ashlr MD" |
| **Settings → Open in Ashlr MD** | Toggle "open in edit mode by default" |

The plugin resolves the vault-relative path to an absolute file-system path and
fires `mdopener://open?path=<encoded-absolute-path>[&mode=edit]`.  Ashlr MD
picks it up instantly via its registered URL scheme.

---

## Requirements

- **macOS** (the plugin sets `isDesktopOnly: true`)
- **Ashlr MD** installed — [download here](https://md.ashlr.ai)
- Obsidian **1.4.0** or later

---

## Build

```bash
cd integrations/obsidian
npm install
npm run build      # produces main.js (minified, CJS)
# or for watch/dev mode:
npm run dev
```

---

## Install manually

1. Build (see above), or download `main.js` from the
   [latest GitHub release](https://github.com/ashlrai/ashlr-md/releases).
2. Create the plugin folder inside your vault:
   ```
   <your-vault>/.obsidian/plugins/ashlr-md/
   ```
3. Copy these three files into that folder:
   ```
   manifest.json
   main.js
   styles.css
   ```
4. In Obsidian: **Settings → Community plugins → Installed plugins** → toggle
   **"Open in Ashlr MD"** on.
5. (Optional) assign a hotkey under **Settings → Hotkeys** — search for
   "Ashlr MD".

---

## Caveats

- **Local vaults only.** The plugin requires a `FileSystemAdapter` to resolve
  the absolute path.  Vaults backed by a remote adapter (e.g. a hypothetical
  cloud-only vault) will see a friendly notice instead of opening.
- **Ashlr MD must be running / installed.** If the URL scheme is not
  registered, macOS will silently do nothing.  Install Ashlr MD from
  [md.ashlr.ai](https://md.ashlr.ai).
- **macOS only.** The `mdopener://` scheme is a macOS-registered URL scheme.
  The plugin's `isDesktopOnly: true` flag prevents it from loading on mobile,
  but it is macOS-specific in practice.

---

## Development

The plugin is plain TypeScript bundled with esbuild — the standard Obsidian
plugin toolchain.  Source entry point: `main.ts`.

```
integrations/obsidian/
├── main.ts           ← plugin source
├── styles.css        ← minimal CSS (Obsidian design tokens)
├── manifest.json     ← plugin metadata
├── versions.json     ← minAppVersion map
├── package.json      ← build deps + scripts
├── tsconfig.json     ← TypeScript config
├── esbuild.config.mjs← bundler config
└── .gitignore
```

---

## License

MIT — part of the [Ashlr MD](https://github.com/ashlrai/ashlr-md) project.
