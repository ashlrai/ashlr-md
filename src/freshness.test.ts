// Run the standalone release-freshness checks in the existing full Vitest suite.
// The fast PR gate does not run Vitest; this is exercised by the scheduled and
// manually dispatched full CI suite as well as local `bun run test`.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("release freshness", () => {
  for (const args of [
    ["scripts/freshness/check.mjs"],
    ["--test", "scripts/freshness/freshness.test.mjs"],
  ]) {
    it(`passes node ${args.join(" ")}`, () => {
      const result = spawnSync("node", args, { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    });
  }
});
