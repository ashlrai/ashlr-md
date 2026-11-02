# Local and custom AI

The AI sidebar, in-app search, and the `mdopener-mcp` sidecar read these settings at call time. Unset or blank means the defaults below.

A desktop app opened from the Dock or the Start menu may not see variables set in a shell profile. To run with Phantom placeholder keys and base URLs, start the process with `phantom exec -- <cmd>`.

## `ANTHROPIC_BASE_URL`

| | |
|---|---|
| Default | `https://api.anthropic.com` |
| Accepted | `https://` to any host, or `http://127.0.0.1` or `http://[::1]` with an optional port |
| Request path | the app appends `/v1/messages` |

Trailing slashes are trimmed. Requests do not follow redirects, so the API key goes only to that host.

These values are refused. The sidebar shows an error, no request is made, and the key is not sent. The error does not repeat the value.

- `http://localhost` or plain `http://` to any host other than `127.0.0.1` and `[::1]`
- any scheme other than `https` and the loopback `http` above
- a malformed URL
- a user name or password in the URL
- a query (`?`) or a fragment (`#`)

This is enough for a gateway such as a LiteLLM proxy or a Phantom proxy. The URL handling is covered by tests. The app has not been tested against one specific gateway product.

## `OLLAMA_HOST`

| | |
|---|---|
| App default | `http://localhost:11434` |
| MCP sidecar default, when unset | `http://127.0.0.1:11434` |
| Accepted shapes | `host`, `host:port`, `:port`, or a full URL |

`:port` means `127.0.0.1:port`. The bind-all addresses `0.0.0.0` and `[::]` mean the matching loopback address.

The app allows a loopback host (`127.0.0.1`, `[::1]`, or `localhost`, written exactly that way). A remote host such as `gpu-box:11434` is refused unless `~/.ashlr/config.json` sets `localInference.allowRemote` to `true` and the URL is `https://`. An environment variable cannot grant that permission.

The MCP sidecar applies the same acceptance rules as `ANTHROPIC_BASE_URL` before that gate: `https://` to any host, or plain `http://` only to `127.0.0.1` or `[::1]`. `http://localhost:11434` is refused there. No request is made. Search falls back to keywords. A search that asked for `semantic: true` says why in its note. The sidecar does not follow redirects from Ollama.

## `localInference`

Add this block to `~/.ashlr/config.json` for a local OpenAI-compatible server (Ollama, oMLX, or a LiteLLM proxy). The shape matches Phantom.

```json
"localInference": {
  "provider": "ollama",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "models": { "coder": "qwen3.8:27b" },
  "allowRemote": false
}
```

- `provider` is `ollama` (default base URL `http://127.0.0.1:11434/v1`), `omlx` (`http://127.0.0.1:8000/v1`), or `openai-compat` (`baseUrl` is required).
- The model defaults to `qwen3.8:27b`. A name containing `abliterat` or `uncensored` is refused.
- The URL must be loopback, written exactly as `127.0.0.1`, `[::1]`, or `localhost`. A remote URL needs `allowRemote: true` and `https://`. Refusals use closed codes (`remote-not-allowed`, `remote-requires-https`, `host-not-canonical`, and the rest) and never repeat the URL.
- No key is sent to this endpoint: no `Authorization` header, no `x-api-key`, no Anthropic key, and no `phm_` placeholder. If a gateway needs a key, run it through `phantom exec --` so the gateway holds the key.
- A valid block is used before any other provider. An invalid block is ignored.
- `mdopener-mcp doctor` checks that the server answers: one loopback-only GET of the model list, no key, 3 second timeout, redirects refused, at most 256 KiB read. It prints a status (`reachable`, `unreachable`, `not-configured`, `config-invalid`, `remote-not-probed`, or `bad-response`). Add `--json` for one JSON object whose `kind` is `ashlr.doctor`.
- `mdopener-mcp setup --local` looks for Ollama on `127.0.0.1:11434` and oMLX on `127.0.0.1:8000`, then prints the next steps, including `ollama pull qwen3.8:27b` (or the configured model) and the `localInference` block with `"offline": true`. It downloads nothing and writes nothing. Add `--json` for one object whose `kind` is `ashlr.setup-local`, with `downloads` false and `writes` false. oMLX has no pull command. It loads models from its dashboard or the folder given to `omlx serve --model-dir`.

```bash
ollama pull qwen3.8:27b
mdopener-mcp doctor --json
mdopener-mcp setup --local --json
```

## Offline mode

Set `"offline": true` on the same block when this machine must not call a cloud model or a model server on another host. Leaving the key out, or setting `false`, changes nothing.

```json
"localInference": {
  "provider": "ollama",
  "offline": true
}
```

While it is on:

- Chat, embeddings, in-app search, and `mdopener-mcp` talk only to loopback: `127.0.0.1`, `[::1]`, and `localhost` (that name is pinned to loopback, with no DNS). `127.0.0.2`, `2130706433`, `localhost.evil.com`, and a trailing dot are refused. A remote `baseUrl` or `OLLAMA_HOST` is refused even when `allowRemote` is true. No environment variable can add a host.
- Anthropic and the hosted Ashlr endpoint are not called, including through a loopback gateway. The error is `Offline mode (localInference.offline in ~/.ashlr/config.json): cloud AI is disabled. No request was sent.` There is no fallback to another cloud provider.
- A loopback Ollama or `localInference` server still works. On-device Apple Foundation Models are unchanged. Requests still send no API key or OAuth token to a local URL, follow no redirects, and do not use a proxy for loopback.
- A value that is present but not a boolean counts as offline. The `localInference` block itself must still be an object or it is invalid and is not used.
- `mdopener-mcp doctor` adds a line: `offline [ok] verified` when offline is on, the configured server is loopback, and it answered the model-list probe. `offline [warn] unverified` means offline is on and no loopback server answered. `offline [info] not enabled` means the flag is off. `doctor --json` adds the same as an `offline` check (`native_status` `verified`, `unverified`, or `not-enabled`) on the `ashlr.doctor` envelope, after the `local-inference` check. `info` does not raise the top-level status.

## On this machine, with no key

On a Mac with Apple Silicon and macOS 26 or later, turn on Apple Intelligence, then restart Ashlr MD. That path uses Apple Foundation Models and needs no account.

On Windows and Linux, install [Ollama](https://ollama.com) or use the `localInference` block above. A cloud model runs only after you add an Anthropic API key in Preferences or opt into a hosted endpoint.
