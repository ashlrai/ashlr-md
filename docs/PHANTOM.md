# Ashlr MD in Phantom

[Phantom](https://github.com/ashlrai/phantom) uses Ashlr MD as its Markdown viewer.
When Phantom has Markdown to show a human (`phm inbox show <id> --open`,
`phm digest --open`) and Ashlr MD is installed, Phantom hands the file to
Ashlr MD; otherwise it falls back to terminal output.

> **Status on Phantom `master`:** only the inbox/digest viewer seam
> (`src/core/integrations/markdown.ts`, `presentMarkdown`) is merged. It detects
> Ashlr MD with `which mdopen` and runs `mdopen <file>`. The "open any `.md` in
> Ashlr MD" opener for `phantom open` and the web/desktop **Open** action, its
> `"markdownOpener": "editor"` / `PHANTOM_ASHLR_MD=0` opt-outs, and
> `docs/companions/ashlr-md.md` live on Phantom's unmerged
> `feat/ashlr-md-opener` branch, not on `master`.

## Integration contract (stable hooks Phantom relies on)

| Hook | Shape | Notes |
|---|---|---|
| URL scheme | `mdopener://open?path=<url-encoded absolute path>[&mode=edit]` | Defined in `src-tauri/tauri.conf.json` (`deep-link.desktop.schemes`). |
| CLI | `mdopen <file.md>` | Phantom treats `mdopen` on `PATH` as "installed". Exit status below. |
| MCP | `mdopener-mcp` → `open_file { path, mode? }` | For agents running under Phantom that want a human to review a document. See [AGENTS.md](./AGENTS.md). |

### `mdopen` exit status

`mdopen` hands the `mdopener://` URL to the OS launcher (`open` on macOS,
`xdg-open` then `gio open` on Linux, `rundll32 url.dll,FileProtocolHandler` on Windows) and waits at
most 10 seconds for it. The launcher never gets `mdopen`'s stdin or stdout.

| Exit | Meaning |
|---|---|
| `0` | The launcher accepted the URL. If it is still running after 10 s, `mdopen` prints `... the open is not confirmed` on stderr and still exits `0`. |
| `1` | Bad usage, an unresolvable path, the launcher failed (no handler for `mdopener://`, no display), or no launcher exists. stderr says which. |

`mdopen --hook` (the Claude Code `PostToolUse` hook) always exits `0` and prints
nothing, waiting at most 5 seconds for the launcher.

A caller that wants to know whether the viewer opened must wait for `mdopen` to
exit and check for `0`. Spawning it detached and ignoring the status reports
success on a headless machine, where `mdopen` exits `1`.

### `mdopener-mcp`

Speaks MCP over stdio. `initialize` echoes `2024-11-05`, `2025-03-26` and
`2025-06-18`, and answers any other requested version with `2025-06-18`.
When the app is not running, `open_file` falls back to the URL scheme through
the same launchers as `mdopen` (bounded at 10 seconds) and returns a JSON-RPC
error that names the launcher outcome when nothing could open it, for example
on a headless Linux box. `mode` must be `read` or `edit`.

## Detection paths

`mdopen` on `PATH`; macOS `/Applications/Ashlr MD.app` or `~/Applications/Ashlr MD.app`;
Windows `%LOCALAPPDATA%\Programs\Ashlr MD\Ashlr MD.exe`; Linux `/usr/bin/md-opener`
(or `/usr/bin/ashlr-md`) or an `Ashlr MD.desktop` entry.

On a Linux `.deb` install the sidecars (`mdopen`, `mdopener-mcp`) land in
`/usr/lib/Ashlr MD/`, which is not on `PATH`. `mdopen` is on `PATH` only after
**Install mdopen** in Settings (`/usr/local/bin` or `~/.local/bin`) or the
source installer. A detector that only runs `which mdopen` (Phantom `master`)
misses a fresh `.deb` install.

Changing the product name, bundle path, or the `mdopener` scheme is a breaking
change for Phantom; update Phantom's Markdown integration alongside it.

## Opting out (Phantom side)

On the `feat/ashlr-md-opener` branch: `"markdownOpener": "editor"` in Phantom's
config, or `PHANTOM_ASHLR_MD=0`. On `master`, simply omit `--open`.
