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
- **Edits:** paths the companion may write. `~/` is the home directory; other paths are relative to the project. For Ashlr MD, `mdopener-mcp doctor --fix --apply` repairs files under `~/.mdopener/`, and the desktop app's agent setup merges an `ashlr-md` entry into `~/.cursor/mcp.json`.
- **Receipts:** receipt kinds the CLI emits (none yet; reserved for receipt.v1).

The server answers before reading stdin. It checks whether `~/.mdopener/ipc-port`
exists and reads `~/.ashlr/config.json`. It reads neither the IPC token nor any
document.

## Verify a change

Two Rust test sets pin this output:

- The unit tests in
  [`handshake.rs`](../src-tauri/bins/mdopener-mcp/src/handshake.rs) check the
  fields, the health rules and the kebab-case ids.
- [`handshake_conformance.rs`](../src-tauri/bins/mdopener-mcp/tests/handshake_conformance.rs)
  runs `mdopener-mcp --ashlr-handshake --json` in a fresh `HOME` and validates it
  against the v1 contract vendored from ashlr-stack
  ([`ashlr-handshake.v1.json`](../src-tauri/bins/mdopener-mcp/tests/contract/ashlr-handshake.v1.json),
  pinned by sha256). For each gated capability it advertises (today only
  `doctor-fix`), it also runs the contract's command (`doctor --fix --json`) and
  checks the exit code, the JSON keys and that nothing was written.

No pull request job runs either set: `Check (Linux)` runs no Rust tests, and
the full Linux suite runs after merge to `main` and daily. After changing the
handshake, a capability or the contract, run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p mdopener-mcp --lib handshake
cargo test --manifest-path src-tauri/Cargo.toml -p mdopener-mcp --test handshake_conformance
```

To take a new contract version, follow
[the contract fixtures README](../src-tauri/bins/mdopener-mcp/tests/contract/README.md#handshake-contract).
