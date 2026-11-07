import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const fixture = mkdtempSync(resolve(root, ".llms-link-test-"));
const fixtureHome = resolve(fixture, "home");
mkdirSync(resolve(fixture, "src/lib"), { recursive: true });
mkdirSync(fixtureHome);
copyFileSync(
  resolve(root, "src/lib/llms-file.test.ts"),
  resolve(fixture, "src/lib/llms-file.test.ts"),
);
writeFileSync(resolve(fixture, "README.md"), "fixture\n");
writeFileSync(
  resolve(fixture, "vitest.config.mjs"),
  'export default { test: { environment: "node", include: ["src/lib/llms-file.test.ts"], maxWorkers: 1, minWorkers: 1 } };\n',
);

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("llms.txt link validation", () => {
  it.each([
    ["README.md", true],
    ["https://github.com/ashlrai/ashlr-md/blob/main/README.md", true],
    ["../README.md", false],
    ["http://other.example/README.md", false],
  ])(
    "checks %s",
    (link, valid) => {
      writeFileSync(
        resolve(fixture, "llms.txt"),
        `# Ashlr MD\n\n> Summary\n\n- [README](${link})\n`,
      );
      const result = spawnSync(
        process.execPath,
        [resolve(root, "node_modules/vitest/vitest.mjs"), "run", "--root", fixture],
        {
          cwd: fixture,
          env: { ...process.env, HOME: fixtureHome, CI: "true", GITHUB_ACTIONS: "true" },
          encoding: "utf8",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(valid ? 0 : 1);
      expect(stripVTControlCharacters(result.stdout + result.stderr)).toContain(
        valid ? "2 passed" : "1 failed | 1 passed",
      );
    },
    30_000,
  );
});
