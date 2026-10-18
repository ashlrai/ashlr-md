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

`mdopen` opens only Markdown documents (`.md`, `.markdown`, `.mdown`, `.mkd`,
`.mdx`) that are not dotfiles, checked after symlinks are resolved; anything
else exits `1` before the app is contacted. When Ashlr MD is running, `mdopen`
hands it the file over its loopback IPC channel. Otherwise it hands the
`mdopener://` URL to the OS launcher (`open` on macOS,
`xdg-open` then `gio open` on Linux, `rundll32 url.dll,FileProtocolHandler` on Windows) and waits at
most 10 seconds for it. The launcher never gets `mdopen`'s stdin or stdout.

| Exit | Meaning |
|---|---|
| `0` | The running app accepted the file, or the launcher accepted the URL. If the launcher is still running after 10 s, `mdopen` prints `... the open is not confirmed` on stderr and still exits `0`. |
| `1` | Bad usage, a missing or unresolvable path, a file that is not a Markdown document or is a dotfile, the running app refused the file (its reason is on stderr, and the URL scheme is not tried), the running app was reached but failed: it answered with a server error, the connection broke, or it did not answer within 6 s (the URL scheme is not tried, since the app may still open the file, and a `mdopen -` temp file is kept), the launcher failed (no handler for `mdopener://`, no display), or no launcher exists. stderr says which. |

`mdopen --hook` (the Claude Code `PostToolUse` hook) exits `0` and prints
nothing, waiting at most 5 seconds for the launcher. It opens only the Markdown
file a `PostToolUse` payload from `Write`, `Edit` or `MultiEdit` names; a
payload naming another `hook_event_name` or `tool_name`, or whose
`tool_response` reports the tool failed, opens nothing. Run by hand with a
terminal on stdin (nothing piped in), it prints a hint on stderr and exits `0`
at once instead of waiting for a payload. The one exception is a hook command
with another argument (`mdopen --hook notes.md`): the payload comes on stdin,
so that is a usage error, exit `1` with the argument named on stderr.

A caller that wants to know whether the viewer opened must wait for `mdopen` to
exit and check for `0`. Spawning it detached and ignoring the status reports
success on a headless machine, where `mdopen` exits `1`.

### `mdopener-mcp`

Speaks MCP over stdio. `initialize` echoes `2024-11-05`, `2025-03-26` and
`2025-06-18`, and answers any other requested version with `2025-06-18`.
`open_file` accepts only a Markdown document that is not a dotfile and that
exists (checked after symlinks are resolved); any other path is refused with
`isError: true` before the app or the URL scheme is reached, and a running app
that refuses the file is not retried through the URL scheme.
When the app is not running, `open_file` falls back to the URL scheme through
the same launchers as `mdopen` (bounded at 10 seconds). When nothing could
open it, for example on a headless Linux box, the call returns a tool result
with `isError: true` whose text names the launcher outcome. `mode` must be
`read` or `edit`.

Tool failures (app not reachable, a file that cannot be read or written, an
operation the app rejects) come back as a successful `tools/call` result with
`isError: true` and the reason as text, per the MCP spec, so the agent can
read it and act. JSON-RPC errors are kept for protocol problems: an unknown
tool or method, or invalid arguments (`-32602`).

## Detection paths

`mdopen` on `PATH`; macOS `/Applications/Ashlr MD.app` or `~/Applications/Ashlr MD.app`;
Windows `%LOCALAPPDATA%\Ashlr MD\Ashlr MD.exe`; Linux `/usr/bin/md-opener`
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
