# Obsidian compatibility

Ashlr MD reads [Obsidian](https://obsidian.md) vaults and notes natively. Point
it at a `.md` file in your vault and your wikilinks, embeds, highlights,
comments, math, and `.canvas` files all render the way they do in Obsidian's
Reading View — no plugins, no export step.

It is a **respectful guest** in your vault: Ashlr MD resolves links vault-wide,
opens linked notes in tabs, and can hand a note back to Obsidian in one click —
but it **never writes into your `.obsidian/` config folder** (see
[Vault setup](#vault-setup)).

> This is a *compatibility* layer, not a re-implementation of Obsidian. Anything
> not listed under [What's not supported yet](#whats-not-supported-yet) below
> should behave the way you expect; if it doesn't, that's a bug.

---

## Vault setup

A "vault" is just a folder Obsidian manages. Obsidian marks the vault root with a
`.obsidian/` config directory. Ashlr MD uses that same marker to find your vault
so it can resolve `[[wikilinks]]` across the whole tree (not just the current
folder).

**How the vault root is found**, in order of precedence:

1. **Settings override.** If you set a vault folder in **Settings → Vault**, that
   path is always used as the vault root.
2. **Auto-detection.** Otherwise, Ashlr MD walks up from the open document's
   folder looking for the nearest ancestor that contains a `.obsidian/` folder,
   and uses that directory as the vault root.
3. **Fallback.** If neither is found (e.g. a loose `.md` file outside any vault),
   link resolution falls back to the document's own directory.

Setting the override in **Settings → Vault** is useful when you keep notes
outside a formal Obsidian vault, or when you want resolution scoped to a specific
folder regardless of where the open file lives.

### Ashlr MD never writes to `.obsidian/`

Saving a document is **refused** if the target path lands inside an `.obsidian/`
config folder. The guard checks the path textually *and* resolves symlinks, so a
symlinked config dir can't slip a write past it. Your Obsidian settings, themes,
and plugin configuration are never touched by Ashlr MD.

---

## Wikilinks

Type-through `[[...]]` internal links render as clickable links. Click one to
open the resolved note in a tab; a link carrying a `#heading` anchor also scrolls
to that heading once the note loads. Links that don't resolve are styled as
**broken** and disabled, with the unresolved target shown on hover.

### Supported grammar

| Syntax | What it does |
|---|---|
| `[[note]]` | Link to `note`; the link text is `note`. |
| `[[note\|alias]]` | Link to `note`, displayed as `alias`. |
| `[[note#heading]]` | Link to `note` and scroll to the `heading` section. Default text is `note › heading`. |
| `[[note#^block]]` | Link to `note` (the `^block` anchor is preserved; there's no rendered jump target for block refs yet, so it opens the note without scrolling). |
| `[[#heading]]` | The bare-target form follows the same resolution rules; an empty file part doesn't resolve to a note. |

Aliases and a single `#anchor` can be combined, e.g.
`[[note#heading|see the setup]]`.

### How a link resolves (vault-wide, closest match)

Resolution mirrors Obsidian. The `#heading` / `#^block` fragment is stripped
first; only the file part is resolved. Then, in order:

1. **Exact relative path** from the current note's folder
   (e.g. `[[subfolder/note]]`).
2. **Vault-relative path** from the vault root (Obsidian's `[[folder/note]]`
   from the root).
3. **Relative path + a Markdown extension** appended (current folder, then vault
   root). Recognized extensions: `.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`.
4. **Vault-wide name match.** Every Markdown file in the vault whose *name*
   matches (case-insensitively, by file stem) is collected, then the **closest**
   one is chosen: a path that ends with the full link target wins first, then the
   file sharing the longest folder path with the current note (proximity), then
   the shortest path. Ties are broken deterministically, so the same link always
   resolves to the same file.

A target that carries an explicit extension (e.g. an image embed
`![[diagram.png]]`) is matched by **full file name** instead of by Markdown
stem. The vault scan skips hidden folders (including `.obsidian/`),
`node_modules`, and `target`, and is depth- and count-bounded so resolution stays
fast on large vaults.

---

## Embeds & transclusion

Prefix a wikilink with `!` to **embed** the target inline (`![[...]]`). Embeds
render through the same renderer, so nested Markdown, callouts, and math all work
inside an embed. Recursive embeds are capped (depth 3) so an `a → b → a` cycle
can't loop forever.

| Syntax | What it does |
|---|---|
| `![[note]]` | Transclude the **entire** note inline, under a title bar. |
| `![[note#heading]]` | Transclude just that **heading's section** — the heading plus everything under it up to the next same-or-higher-level heading. |
| `![[note#^block]]` | Transclude just the **single block** (paragraph / list item) tagged with that `^block` id; the `^id` marker is stripped from the output. |
| `![[image.png]]` | Embed the image inline. |
| `![[image.png\|300]]` | Embed the image at **300px wide**. |
| `![[image.png\|300x200]]` | Embed the image at **300×200px**. |

Image embeds support `png`, `jpg`/`jpeg`, `gif`, `svg`, `webp`, `bmp`, and
`avif`. Images are read through the Rust core into an inline `data:` URL (so the
webview never needs broad filesystem access) and are capped at 25 MiB per image.
If a partial-embed fragment can't be located, the **full** note is embedded so
the embed still shows something useful.

---

## Highlights, comments & math

| Syntax | Rendering |
|---|---|
| `==highlight==` | Rendered as a highlighted `<mark>`. Empty / whitespace-only delimiters (`== ==`) are left as plain text. |
| `%%comment%%` | **Hidden** in the reading view, matching Obsidian — the delimiters and their content are removed. Inline comments only; comments that span paragraph boundaries are left as-is. |
| `$inline math$` | Inline math via KaTeX. |
| `$$display math$$` | Display (block) math via KaTeX. |

Highlight and comment markers inside code spans / code blocks are treated as
literal text and are never transformed.

---

## Canvas (`.canvas`)

Ashlr MD opens [JSON Canvas](https://jsoncanvas.org) (`.canvas`) files in a
**read-only** viewer. Drag the background to **pan**, scroll to **zoom**, and use
**Fit** (or the `+` / `−` buttons) to frame the whole canvas. The view auto-fits
on open.

**Node types that render:**

| Node | Rendering |
|---|---|
| `text` | The node's Markdown, rendered through the same renderer. |
| `file` | A titled card embedding the linked file's Markdown — or, for an image file, the inline image. The title is a button that opens the file in a tab. |
| `link` | A card showing the external URL. Only `http(s):` and `mailto:` URLs are clickable; anything else (e.g. `javascript:`) is shown as inert text. |
| `group` | A labelled rectangle drawn behind its member nodes. |

**Edges** render as connectors with optional labels and arrowheads (Obsidian's
default arrow-at-destination is honored). Node and edge **colors** use Obsidian's
six-color preset palette as well as raw hex values.

Canvas is read-only: node positions and the canvas file are **never written
back**.

---

## Round-trip: Open in Obsidian

Any open note can be handed back to Obsidian with the **Open in Obsidian**
command (in the command palette, `⌘K`). It launches Obsidian on that exact file
via the `obsidian://open?path=…` URI scheme, so you can edit graph-heavy notes,
run plugins, or use any Obsidian feature, then jump back to Ashlr MD for a fast,
beautiful read. (Obsidian must be installed.)

The companion **[Open in Ashlr MD](../integrations/obsidian/)** Obsidian plugin
closes the loop the other way: a ribbon icon, command, and right-click menu send
the current vault note to Ashlr MD via the `mdopener://` scheme.

---

## What's not supported yet

Ashlr MD aims to *read* a vault faithfully, not to replace Obsidian's editor.
The following are intentionally absent today:

- **Editing or creating canvases.** `.canvas` files are view-only; positions and
  content are never written back.
- **Obsidian community/core plugins** (Dataview, Templater, Tasks, etc.). Ashlr
  MD renders standard Markdown + the syntax documented above; plugin-specific
  query blocks and processors are not evaluated.
- **Block-reference jump targets.** A `[[note#^block]]` link opens the note but
  doesn't scroll to the block (heading anchors *do* scroll). Block *embeds*
  (`![[note#^block]]`) do work.
- **Multi-line / block `%%comments%%`** that span paragraph boundaries — only
  inline comments are hidden.
- **Obsidian-specific frontmatter behaviors** (aliases-as-link-targets, custom
  link-resolution settings, per-vault Markdown extension config). Link resolution
  follows the rules documented above, not your vault's individual settings.

If something in your vault doesn't render the way Obsidian's Reading View shows
it — and it isn't in this list — please
[open an issue](https://github.com/ashlrai/ashlr-md/issues).
