# Ashlr companion handshake (v1)

`mdopener-mcp --ashlr-handshake` (with or without `--json`) prints one JSON object and exits 0. `phm companions`,
`phm doctor` or an agent can call it instead of parsing `--help`. The same
contract is implemented by `locus`, `stack` (ashlr-stack), `ashlr-plugin` and
`lexicon`, each with `--ashlr-handshake`.

```json
{
  "kind": "ashlr.handshake",
  "schema_version": 1,
  "name": "ashlr-md",
  "command": "mdopener-mcp",
  "version": "0.7.5",
  "protocols": { "ashlr.handshake": 1, "mcp": 1 },
  "capabilities": ["mcp-server", "markdown-viewer", "review-annotations", "document-edit", "export", "vault-search", "agent-setup", "doctor-fix", "local-inference-probe"],
  "health": {
    "status": "ok",
    "checks": [
      { "id": "app-running", "status": "absent" },
      { "id": "local-inference-config", "status": "absent" }
    ]
  },
  "edits": ["~/.mdopener/", "~/.cursor/mcp.json"],
  "receipts": []
}
```

`version` is the installed server's version. `doctor-fix` means
`mdopener-mcp doctor --fix` is available ([doctor-fix.md](./doctor-fix.md)).
`local-inference-probe` means `mdopener-mcp doctor` probes the
`localInference` server ([local-ai.md](./local-ai.md)).

Ashlr MD reports two checks:

| Check `id` | `ok` | `absent` | `missing` |
|---|---|---|---|
| `app-running` | `~/.mdopener/ipc-port` exists, so the app is probably running | the app is not running; several tools then answer from disk | never |
| `local-inference-config` | `~/.ashlr/config.json` has a valid `localInference` block | no config file, or no `localInference` block | the block is invalid, or the file cannot be read as JSON |

`health.status` is `degraded` only when `local-inference-config` is
`missing`; otherwise it is `ok`. The config check reads the file and never
contacts the model server. Run `mdopener-mcp doctor --json` for the probe.

Rules every implementation follows:

- **Fast and local:** no network, no vault or keychain, and no secret values or project contents in the output.
- **Stable shape:** `kind` and `schema_version` identify the contract. New fields may be added in v1; renames or removals bump `schema_version`.
- **Ids:** `capabilities` and check `id`s are kebab-case. `protocols` maps a protocol name to the version spoken.
- **Health:** `health.status` is `ok`, `degraded` (works, something it relies on is missing) or `unknown`. A check status is `ok`, `missing` (counts against health) or `absent` (informational, such as the app not running: several tools then answer from disk).
- **Edits:** paths the CLI may write. `~/` is the home directory; other paths are relative to the project.
- **Receipts:** receipt kinds the CLI emits (none yet; reserved for receipt.v1).

The server answers before reading stdin. It checks whether `~/.mdopener/ipc-port`
exists and reads `~/.ashlr/config.json`. It reads neither the IPC token nor any
document.
