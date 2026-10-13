# Ashlr MD in Phantom

[Phantom](https://github.com/ashlrai/phantom) ships with Ashlr MD as its out-of-box
Markdown opener. When Phantom opens a `.md` / `.markdown` / `.mdx` file (`phantom open`,
or **Open** in the Phantom web/desktop UI) and Ashlr MD is installed, Phantom hands the
file to Ashlr MD; otherwise it falls back to the user's editor and offers an install.

## Integration contract (stable hooks Phantom relies on)

| Hook | Shape | Notes |
|---|---|---|
| URL scheme | `mdopener://open?path=<url-encoded absolute path>[&mode=edit]` | What Phantom launches. Defined in `src-tauri/tauri.conf.json` (`deep-link.desktop.schemes`). |
| CLI | `mdopen <file.md>` | Phantom treats `mdopen` on `PATH` as "installed". |
| MCP | `mdopener-mcp` → `open_file { path, mode? }` | For agents running under Phantom that want a human to review a document. See [AGENTS.md](./AGENTS.md). |

Detection paths Phantom checks: `mdopen` on `PATH`; macOS `/Applications/Ashlr MD.app` or
`~/Applications/Ashlr MD.app`; Windows `%LOCALAPPDATA%\Programs\Ashlr MD\Ashlr MD.exe`;
Linux `/usr/bin/md-opener` (or `/usr/bin/ashlr-md`) or an `Ashlr MD.desktop` entry. Changing the product name,
bundle path, or the `mdopener` scheme is a breaking change for Phantom — update
the Markdown-opener section of `src/cli/open.ts` in ashlrai/phantom alongside it.

## Opting out (Phantom side)

`"markdownOpener": "editor"` in Phantom's config, or `PHANTOM_ASHLR_MD=0`.
Full details: [phantom/docs/companions/ashlr-md.md](https://github.com/ashlrai/phantom/blob/master/docs/companions/ashlr-md.md).
