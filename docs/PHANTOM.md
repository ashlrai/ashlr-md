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

## Running under `phantom exec` (Phantom Secrets)

`phantom exec -- <cmd>` does three things:
- It starts `<cmd>` with `phm_` session placeholders instead of real provider keys.
- It points provider base URLs such as `ANTHROPIC_BASE_URL` at a local Phantom proxy: `http://127.0.0.1:<port>/<route>/_phantom/<token>/`.
- On the way out, the proxy swaps each placeholder for the real key.

What Ashlr MD reads, at call time:

| Setting | Used by | Rules |
|---|---|---|
| `ANTHROPIC_BASE_URL` | AI sidebar (Anthropic) | `https://` to any host, or plain `http://` only to `127.0.0.1` or `[::1]`. Anything else is refused before the key is attached. The Phantom proxy URL is loopback http, so it is accepted. |
| `ASHLR_MD_ANTHROPIC_KEY_FROM_ENV` | AI sidebar (Anthropic) | Exactly `1` turns on reading the key from `ANTHROPIC_API_KEY` instead of Settings. Unset, or any other value, means Settings only (the default). |
| `OLLAMA_HOST` | AI sidebar and semantic search (Ollama) | Taken as given: `host`, `host:port`, `:port` or a full URL. |
| `OLLAMA_HOST` | MCP sidecar (`mdopener-mcp`) embeddings | Since #138: `https://` to any host, or plain `http://` only to `127.0.0.1` or `[::1]`. `:port`, `0.0.0.0` and `[::]` map to loopback, and redirects are refused. |

Things to know:
- **The Anthropic key comes from Settings by default.** The app sends the key saved in Settings, which is stored in the OS keychain, and ignores `ANTHROPIC_API_KEY`. To use the `phm_` placeholder from `phantom exec` instead, opt in with `ASHLR_MD_ANTHROPIC_KEY_FROM_ENV=1` (see below).
- **Shell-launched only.** An app launched from the Dock or Start menu does not see variables from your shell or from `phantom exec`. Start its executable from that shell instead: for example `phantom exec -- /usr/bin/md-opener` on a Linux `.deb` install, or the executable inside `Ashlr MD.app/Contents/MacOS/` on macOS. `open -a` hands the launch to the OS and may not pass the variables. These launch forms have not been tested here.
- **The sidecar has no key.** `mdopener-mcp` sends no Anthropic requests and attaches no key to Ollama requests. An agent that runs it under `phantom exec` needs no placeholder for it.
- **No `phm:` references.** Ashlr MD never resolves a `phm:` reference. Do not use `phantom reveal` to copy a key into Settings or into the environment.

### Using `ANTHROPIC_API_KEY` from the environment (opt-in)

```sh
ASHLR_MD_ANTHROPIC_KEY_FROM_ENV=1 phantom exec -- /usr/bin/md-opener
```

With `ASHLR_MD_ANTHROPIC_KEY_FROM_ENV=1`, the AI sidebar takes the Anthropic key from `ANTHROPIC_API_KEY` at request time:
- **Only the environment key is used.** The key saved in Settings is not sent, and there is no fallback to it. Settings shows a note that the environment key is in use.
- **The value stays in the Rust process.** It is never sent to the webview, written to Settings or the keychain, logged, or included in an error message. The webview only learns whether the opt-in is on, whether the key is usable, and whether it is a `phm_` placeholder.
- **A `phm_` placeholder needs the session proxy.** `ANTHROPIC_BASE_URL` must be set and pass the usual rules. It must point at `127.0.0.1` or `[::1]` with a port, and that port must be `PHANTOM_PROXY_PORT` when it is set. Without that, the placeholder would go to the real provider, so the request is refused.
- **A real key** in `ANTHROPIC_API_KEY` is accepted with any `ANTHROPIC_BASE_URL` that passes the usual rules.
- **Refused before any request:** an unset or blank key, a `phm:` reference (Ashlr MD does not resolve references), or a value with spaces or control characters. The reason is shown, but the value never is.
- **Request errors leave out the URL**, so the per-session proxy token in the path is not shown.

The rules and the webview side are covered by tests: `src-tauri/src/base_urls.rs` and `src/ai/anthropicEnvKey.test.ts`. It has not been tested against a live `phantom exec` session.

### LiteLLM

If a LiteLLM proxy sits in front of Anthropic or Ollama, use LiteLLM 1.83.0 or newer, never 1.82.7 or 1.82.8.

- **Why 1.83.0:** `litellm` 1.82.7 and 1.82.8 on PyPI were compromised releases that carried credential-stealing code (GHSA-5mg7-485q-xm76, March 2026). 1.83.0, published to PyPI on 2026-03-31, was the first clean release, built by LiteLLM's rebuilt release pipeline ([LiteLLM security update](https://docs.litellm.ai/blog/security-update-march-2026)).
- **Use a current release, not just 1.83.0.** Later advisories were fixed in later releases (for example GHSA-3cv6-jpf6-8222). On 2026-10-19 the current PyPI release was 1.106.0. Check LiteLLM's security advisories before you pick or upgrade a version.
- **Install it verifiably.** Use a hash-pinned install (`pip install --require-hashes -r requirements.txt`) or the official `ghcr.io/berriai/litellm` image, checked with `cosign verify` as LiteLLM's README shows. Run it in a container that does not mount your home directory or dotfiles.
- Keep the provider keys on the LiteLLM side. Give the agent only the proxy URL and, if the proxy needs one, a proxy key that is separate from the provider keys.

For Ashlr MD, `ANTHROPIC_BASE_URL` points at the gateway root, and the app appends `/v1/messages`, so the gateway must serve the Anthropic Messages API there. Use `https://`, or `http://127.0.0.1:<port>` for a proxy on the same machine. Only the URL handling is covered by tests. The app has not been tested against a live LiteLLM or Phantom proxy.
