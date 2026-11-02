# MCP tool contract for Phantom

`mcp-tools.v1.json` is a checked-in, offline snapshot of the MCP tool names and
complete JSON Schema input schemas. Phantom can vendor this file and read
`tools[].name` and `tools[].inputSchema` without starting Ashlr MD, accessing a
user profile, or obtaining credentials. The root matches the `tools/list`
result shape, with descriptions and annotations omitted. Tools are sorted by
name; schema arrays retain their original order. The v1 suffix versions this
artifact format, not the individual tools or their compatibility.

Export from an installed binary:

```sh
mdopener-mcp --export-tool-schema
```

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
snapshot comparison. Wording inside input schemas is also captured; tool
presentation descriptions and annotations are outside this contract.
