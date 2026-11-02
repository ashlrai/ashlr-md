import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import manifestText from "../../server.json?raw";
import mcpCargo from "../../src-tauri/bins/mdopener-mcp/Cargo.toml?raw";
import schemaText from "./fixtures/server.schema.2025-12-11.json?raw";

const schemaUrl =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const schemaSha256 = "3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0";
const schema = JSON.parse(schemaText);
const manifest = JSON.parse(manifestText);
// The upstream OpenAPI-generated schema uses annotations such as `example`.
// Disable Ajv's schema-authoring restrictions, retaining draft-07 validation.
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

describe("MCP registry manifest", () => {
  it("pins the unmodified published schema for offline validation", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(schemaText),
    );
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(sha256).toBe(schemaSha256);
    expect(schema.$id).toBe(schemaUrl);
    expect(manifest.$schema).toBe(schemaUrl);
    expect(ajv.validateSchema(schema)).toBe(true);
  });

  it("validates server.json against the published draft-07 schema", () => {
    expect(validate(manifest), ajv.errorsText(validate.errors)).toBe(true);
  });

  it.each([
    "name",
    "description",
    "version",
  ])("rejects a missing required %s", (field) => {
    const invalid = { ...manifest };
    delete invalid[field];
    expect(validate(invalid)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "required",
          params: { missingProperty: field },
        }),
      ]),
    );
  });

  it.each([
    ["name", "ashlr-md", "pattern"],
    ["description", "x".repeat(101), "maxLength"],
    ["version", 4, "type"],
    ["websiteUrl", "not a URI", "format"],
    ["repository", { source: "github" }, "required"],
    ["packages", [{ registryType: "npm", identifier: "fictional" }], "required"],
  ])("rejects invalid %s metadata", (field, value, keyword) => {
    expect(validate({ ...manifest, [field as string]: value })).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword })]),
    );
  });

  it("matches the MCP crate version used by --version and initialize", () => {
    const packageSection = mcpCargo.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
    const version = packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    expect(version).toBeDefined();
    expect(manifest.version).toBe(version);
  });

  it("describes the local stdio sidecar without fabricated install endpoints", () => {
    expect(manifest.name).toBe("io.github.ashlrai/ashlr-md");
    expect(manifest.repository).toEqual({
      url: "https://github.com/ashlrai/ashlr-md",
      source: "github",
      subfolder: "src-tauri/bins/mdopener-mcp",
    });
    expect(manifest).not.toHaveProperty("packages");
    expect(manifest).not.toHaveProperty("remotes");
    expect(
      manifest._meta["io.modelcontextprotocol.registry/publisher-provided"],
    ).toEqual({
      distribution: "bundled-native-binary",
      binary: "mdopener-mcp",
      transport: { type: "stdio" },
    });
    expect(manifestText).not.toMatch(/[\u2013\u2014]/u);
  });
});
