/**
 * Every Tauri command the MCP bridge invokes must be registered in the app's
 * `generate_handler!` list. An unregistered command rejects at runtime, and
 * the bridge swallows those rejections, so the call fails silently.
 */

import { describe, expect, it } from "vitest";
import libRs from "../../src-tauri/src/lib.rs?raw";

const sources = import.meta.glob<string>(["./**/*.ts", "!./**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

function registeredCommands(): Set<string> {
  const block = libRs.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!block) throw new Error("generate_handler! list not found in lib.rs");
  return new Set([...block[1].matchAll(/([a-z_]+)::([a-z_]+)/g)].map((m) => m[2]));
}

describe("MCP bridge Tauri commands", () => {
  it("invokes only commands the app registers", () => {
    const registered = registeredCommands();
    expect(registered.has("mcp_edit_result")).toBe(true);

    const invoked: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)) {
        invoked.push(`${file}: ${m[1]}`);
      }
    }
    expect(invoked.length).toBeGreaterThan(0);
    const missing = invoked.filter((entry) => !registered.has(entry.split(": ")[1]));
    expect(missing).toEqual([]);
  });
});
