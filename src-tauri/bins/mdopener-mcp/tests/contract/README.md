# mdopener-mcp contract fixtures

These checked-in JSON files pin the machine-readable output that other tools
read from `mdopener-mcp`: Phantom, the Ashlr companion clients and any agent
that parses `--json`. Every file is read with `include_str!` by a Rust test in
the parent directory, so changing an output without updating its fixture
fails `cargo test`. The tests need no network access, user profile or
credentials; the ones that run the binary point `HOME` at a fresh temporary
directory.

| Fixture | What it pins | Test |
| --- | --- | --- |
| `mcp-tools.v1.json` | Output of `--export-tool-schema`: tool names and complete input schemas | `tool_contract.rs`, `cli_json.rs` |
| `tools-list-fields.v1.json` | The full `tools/list` result with every `description` removed: order, input schemas and annotations | `payload_contract.rs` |
| `doctor.v1.json` | `doctor --json` (local inference and offline status) | `payload_contract.rs` |
| `doctor-fix.v1.json` | `doctor --fix --json` preview in a fresh HOME | `payload_contract.rs` |
| `setup-local.v1.json` | `setup --local --json` for a fixed pair of probe results (Ollama reachable, oMLX not) | `payload_contract.rs` |
| `list-ai-actions.v1.json` | The `list_ai_actions` tool response with `include_prompts: false` | `payload_contract.rs` |
| `ashlr-handshake.v1.json` | The Ashlr handshake v1 contract, vendored from ashlr-stack and pinned by sha256 in the `.sha256` file | `handshake_conformance.rs` |

Run them all from the repository root:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -p mdopener-mcp
```

CI runs the same tests in the "Rust tests (workspace)" step of
`.github/workflows/ci.yml`, and `scripts/ci-local.sh` runs them when Rust
files change.

## Tool schema for Phantom

`mcp-tools.v1.json` is an offline snapshot of the MCP tool names and complete
JSON Schema input schemas. Phantom can vendor this file and read
`tools[].name` and `tools[].inputSchema` without starting Ashlr MD, accessing a
user profile, or obtaining credentials. The root matches the `tools/list`
result shape, with descriptions and annotations omitted. Tools are sorted by
name; schema arrays retain their original order. The v1 suffix versions this
artifact format, not the individual tools or their compatibility.

Export from an installed binary:

```sh
mdopener-mcp --export-tool-schema
```

With `--json`, the same object also carries `kind: "ashlr.tool-schema"`,
`schema_version: 1` and `tool: "ashlr-md"`. The fixture holds the plain form.

After an intentional registry change, review compatibility with Phantom,
regenerate from the repository root, and commit the fixture with the change:

```sh
cargo run --quiet --manifest-path src-tauri/Cargo.toml -p mdopener-mcp -- \
  --export-tool-schema > src-tauri/bins/mdopener-mcp/tests/contract/mcp-tools.v1.json
cargo test --manifest-path src-tauri/Cargo.toml -p mdopener-mcp --test tool_contract
```

The contract tests compare the fixture against the registry, exact CLI output,
and the real stdio `tools/list` response. Any added or removed tool, changed
required argument, property type, enum, default, or nested schema fails the
snapshot comparison. Wording inside input schemas is also captured. Tool
descriptions are outside every fixture, and annotations and presentation
order are pinned only by `tools-list-fields.v1.json`.

## Payload snapshots

`payload_contract.rs` protects the JSON fields and values that clients consume
while letting human-readable descriptions be shortened. The doctor, doctor-fix
and setup-local tests also require compact output: one JSON object followed by
a newline. The `tools/list` test additionally caps the serialized response
below 38,440 bytes.

These fixtures have no generator. When a field change is intended, edit the
fixture by hand in the same commit and check the consumers documented in
[local-ai.md](../../../../../docs/local-ai.md) (doctor and setup),
[doctor-fix.md](../../../../../docs/doctor-fix.md) and the tool reference in
[docs/AGENTS.md](../../../../../docs/AGENTS.md#mcp-tool-reference).

## Handshake contract

`ashlr-handshake.v1.json` is not generated here. Its canonical copy lives in
ashlr-stack's `contract/` directory; `handshake_conformance.rs` checks the
vendored file against the sha256 pin (in both the `.sha256` file and the
`PINNED_SHA256` constant), validates `mdopener-mcp --ashlr-handshake --json`
against it, and runs the command mapped to each gated capability the
handshake advertises. To take a new contract version, copy the file from
ashlr-stack and update both pins. The output itself is described in
[ashlr-handshake.md](../../../../../docs/ashlr-handshake.md).
