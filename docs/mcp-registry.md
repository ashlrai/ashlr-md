# MCP discovery metadata

[`server.json`](../server.json) describes the MCP server Ashlr MD ships:
[`mdopener-mcp`](../src-tauri/bins/mdopener-mcp/), a Rust binary speaking
JSON-RPC over stdio. The frontend's [`src/mcp/`](../src/mcp/) handles requests
forwarded by the app bridge. It is not a separate MCP server.

Install and connect the bundled binary using the [AI agent guide](AGENTS.md).
Its loopback HTTP connection to the app is private IPC, not a remote MCP endpoint.
The descriptor omits `packages` and `remotes`: the sidecar has no supported
registry package declared here. Publisher metadata records the binary and stdio
transport for discovery; it is not a standard package installation recipe.

## Version and validation

The authoritative server version is `[package].version` in
[`src-tauri/bins/mdopener-mcp/Cargo.toml`](../src-tauri/bins/mdopener-mcp/Cargo.toml).
The binary uses Cargo's `CARGO_PKG_VERSION` for `--version` and the MCP
`initialize` response. Update `server.json` alongside that crate's version.

The [published MCP Registry schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
is vendored unchanged in
[`src/mcp/fixtures/server.schema.2025-12-11.json`](../src/mcp/fixtures/server.schema.2025-12-11.json).
Its SHA-256 is
`3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0`.
The Vitest check validates the full schema with Ajv, checks that pin and the crate
version, and exercises malformed manifests, including URI and nested package
validation. After installing the repo's dependencies, run it offline from the
repository root:

```bash
HOME=$(mktemp -d) bun run test -- src/mcp/registryManifest.test.ts
```

To refresh the fixture, fetch the versioned schema from its official URL, inspect
the upstream changes, then update the fixture, hash, schema URL, and tests
together. Do not edit the fixture to accommodate a failing manifest.

Schema validity proves the descriptor's format. It does not prove public
registry acceptance, package ownership, or publication. Public registry or
marketplace submission requires Mason's approval and is not performed by these
tests.
