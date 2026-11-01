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
  "version": "0.5.0",
  "protocols": { "ashlr.handshake": 1, "mcp": 1 },
  "capabilities": ["mcp-server", "markdown-viewer", "review-annotations", "document-edit", "export", "vault-search", "agent-setup", "doctor-fix"],
  "health": { "status": "ok", "checks": [{ "id": "app-running", "status": "absent" }] },
  "edits": ["~/.mdopener/", "~/.cursor/mcp.json"],
  "receipts": []
}
```

Rules every implementation follows:

- **Fast and local:** no network, no vault or keychain, and no secret values or project contents in the output.
- **Stable shape:** `kind` and `schema_version` identify the contract. New fields may be added in v1; renames or removals bump `schema_version`.
- **Ids:** `capabilities` and check `id`s are kebab-case. `protocols` maps a protocol name to the version spoken.
- **Health:** `health.status` is `ok`, `degraded` (works, something it relies on is missing) or `unknown`. A check status is `ok`, `missing` (counts against health) or `absent` (informational, such as the app not running: several tools then answer from disk).
- **Edits:** paths the CLI may write. `~/` is the home directory; other paths are relative to the project.
- **Receipts:** receipt kinds the CLI emits (none yet; reserved for receipt.v1).

The server answers before reading stdin, and reads neither the IPC token nor any document.
