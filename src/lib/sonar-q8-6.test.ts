/**
 * sonar-q8-6.test.ts — coverage for the RQ-MDSONAR6Q8 Sonar security fixes.
 *
 *   S2245  `Math.random()` id generation → `crypto.getRandomValues` via
 *          ./uniqueId (pasteImage, memoryStore, exportTemplates, aiStore and
 *          ai/bridge call sites).
 *   S4036  scripts must not spawn bare command names resolved through PATH —
 *          scripts/tool-path.mjs resolves them to absolute paths first.
 *   S5443  scripts/test-mcp-setup.py must not hard-code paths under publicly
 *          writable directories or read TMP/TMPDIR-style env vars.
 *
 * The last suite re-reads the touched sources so a future regression that
 * reintroduces a flagged pattern fails CI even when Sonar is not running.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolPath } from "../../scripts/tool-path.mjs";
import { useConversationStore, useMemoryStore } from "../store/memoryStore";
import { newTemplateId } from "./exportTemplates";
import { pasteImageFilename } from "./pasteImage";
import { randomBase36, uniqueId } from "./uniqueId";

// Keep real source reads while allowing scoped resolver filesystem fixtures.
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const statSync = vi.fn(original.statSync);
  const accessSync = vi.fn(original.accessSync);
  return {
    ...original,
    statSync,
    accessSync,
    // happy-dom transforms named builtin imports through the default export.
    // Both forms must share the same fixtures, never the host filesystem.
    default: { ...original, statSync, accessSync },
  };
});

// ─── uniqueId / randomBase36 (S2245) ──────────────────────────────────────────

describe("randomBase36", () => {
  it("produces base36 strings of the requested length", () => {
    expect(randomBase36(0)).toBe("");
    expect(randomBase36(40)).toMatch(/^[0-9a-z]{40}$/);
    expect(randomBase36(6)).toMatch(/^[0-9a-z]{6}$/);
  });

  it("draws from the platform CSPRNG and never Math.random()", () => {
    const secure = vi.spyOn(crypto, "getRandomValues");
    const weak = vi.spyOn(Math, "random");
    randomBase36(24);
    expect(secure).toHaveBeenCalled();
    expect(weak).not.toHaveBeenCalled();
    secure.mockRestore();
    weak.mockRestore();
  });

  it("does not repeat across many draws", () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomBase36(8)));
    expect(seen.size).toBe(200);
  });
});

describe("uniqueId", () => {
  it("is prefixed, timestamped and unique", () => {
    const a = uniqueId("x-", 6);
    const b = uniqueId("x-", 6);
    expect(a).toMatch(/^x-\d+-[0-9a-z]{6}$/);
    expect(a).not.toBe(b);
  });
});

// ─── call sites that used Math.random (S2245) ─────────────────────────────────

describe("pasteImageFilename", () => {
  it("keeps the explicit-token contract", () => {
    expect(pasteImageFilename("png", "TOKEN")).toBe("image-TOKEN.png");
  });

  it("generates unique timestamped names without a token", () => {
    const names = new Set(Array.from({ length: 30 }, () => pasteImageFilename("webp")));
    expect(names.size).toBe(30);
    for (const n of names) expect(n).toMatch(/^image-\d+-[0-9A-Z]{4}\.webp$/);
  });
});

describe("memoryStore ids", () => {
  it("memory items get unique mem- ids", () => {
    const store = useMemoryStore.getState();
    store.clear();
    store.add("first fact");
    store.add("second fact");
    const ids = useMemoryStore.getState().items.map((i) => i.id);
    for (const id of ids) expect(id).toMatch(/^mem-\d+-[0-9a-z]{6}$/);
    expect(new Set(ids).size).toBe(2);
  });

  it("sessions and messages get unique sess-/msg- ids", () => {
    const conv = useConversationStore.getState();
    conv.endSession();
    const sessionId = conv.startSession();
    expect(sessionId).toMatch(/^sess-\d+-[0-9a-z]{8}$/);
    const msg = conv.appendMessage("agent", "did a thing");
    expect(msg?.id).toMatch(/^msg-\d+-[0-9a-z]{6}$/);
    expect(msg?.sessionId).toBe(sessionId);
    conv.endSession();
  });
});

describe("newTemplateId", () => {
  it("prefers crypto.randomUUID when present", () => {
    const id = newTemplateId();
    expect(id).toMatch(/^user-/);
    expect(id).not.toMatch(/[<>"'\s]/);
  });

  it("falls back to a unique CSPRNG id when randomUUID is missing", () => {
    const c = globalThis.crypto;
    const had = Object.getOwnPropertyDescriptor(c, "randomUUID");
    Object.defineProperty(c, "randomUUID", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    try {
      const ids = new Set(Array.from({ length: 40 }, () => newTemplateId()));
      expect(ids.size).toBe(40);
      for (const id of ids) expect(id).toMatch(/^user-\d+-[0-9a-z]{6}$/);
    } finally {
      if (had) Object.defineProperty(c, "randomUUID", had);
      else Reflect.deleteProperty(c, "randomUUID");
    }
  });
});

// ─── scripts/tool-path.mjs (S4036) ────────────────────────────────────────────

describe("toolPath", () => {
  const dir = join(tmpdir(), "tool-path-fixture");
  const entries = new Map<string, { directory: boolean; mode: number }>();

  beforeEach(() => {
    // Real temporary files fail X_OK on Linux noexec mounts. Model lookup here
    // so neither mount flags nor installed system tools determine the result.
    entries.clear();
    entries.set(dir, { directory: true, mode: 0o700 });
    vi.mocked(fs.statSync).mockImplementation((path) => {
      const entry = entries.get(String(path));
      if (!entry) throw new Error("ENOENT");
      return {
        mode: entry.mode,
        isDirectory: () => entry.directory,
        isFile: () => !entry.directory,
      } as fs.Stats;
    });
    vi.mocked(fs.accessSync).mockImplementation((path, mode) => {
      expect(mode).toBe(fs.constants.X_OK);
      const entry = entries.get(String(path));
      if (!entry || (entry.mode & 0o111) === 0) throw new Error("EACCES");
    });
  });

  afterEach(async () => {
    const original = await vi.importActual<typeof fs>("node:fs");
    vi.mocked(fs.statSync).mockReset().mockImplementation(original.statSync);
    vi.mocked(fs.accessSync).mockReset().mockImplementation(original.accessSync);
  });

  it("resolves repo-script tools to absolute paths", () => {
    for (const name of ["git", "node"]) {
      const exe = join(dir, name);
      entries.set(exe, { directory: false, mode: 0o755 });
      const p = toolPath(name, { PATH: dir });
      expect(isAbsolute(p), `${name} → ${p}`).toBe(true);
      expect(basename(p)).toBe(name);
      expect(p).toBe(exe);
    }
  });

  it("finds executables in a caller-provided PATH entry", () => {
    const exe = join(dir, "q8tool");
    entries.set(exe, { directory: false, mode: 0o755 });
    expect(toolPath("q8tool", { PATH: dir })).toBe(exe);
  });

  it("prefers trusted system directories over PATH shadows in fixed order", () => {
    for (const path of ["/usr/bin", "/bin", dir]) {
      entries.set(path, { directory: true, mode: 0o755 });
      entries.set(join(path, "git"), { directory: false, mode: 0o755 });
    }
    expect(toolPath("git", { PATH: [dir, "/bin"].join(delimiter) })).toBe(
      join("/usr/bin", "git"),
    );
  });

  it("rejects world-writable system directories too", () => {
    entries.set("/usr/bin", { directory: true, mode: 0o777 });
    entries.set(join("/usr/bin", "git"), { directory: false, mode: 0o755 });
    entries.set(join(dir, "git"), { directory: false, mode: 0o755 });
    expect(toolPath("git", { PATH: dir })).toBe(join(dir, "git"));
  });

  it("refuses executables inside a world-writable PATH entry", () => {
    entries.set(dir, { directory: true, mode: 0o777 });
    entries.set(join(dir, "q8tool"), { directory: false, mode: 0o755 });
    expect(() => toolPath("q8tool", { PATH: dir })).toThrow(/not found/);
    expect(fs.accessSync).not.toHaveBeenCalled();
  });

  it("ignores relative PATH entries and throws when nothing matches", () => {
    entries.set(".", { directory: true, mode: 0o755 });
    entries.set("missing-q8-tool", { directory: false, mode: 0o755 });
    expect(() => toolPath("missing-q8-tool", { PATH: "." })).toThrow(/not found/);
    expect(fs.accessSync).not.toHaveBeenCalled();
  });

  it.each([
    { directory: true, mode: 0o755 },
    { directory: false, mode: 0o644 },
  ])("skips unusable candidates (%j) and continues along PATH", (entry) => {
    entries.set(join(dir, "q8tool"), entry);
    const fallback = join(dir, "fallback");
    entries.set(fallback, { directory: true, mode: 0o755 });
    entries.set(join(fallback, "q8tool"), { directory: false, mode: 0o755 });
    expect(toolPath("q8tool", { PATH: [dir, fallback].join(delimiter) })).toBe(
      join(fallback, "q8tool"),
    );
  });
});

// ─── source guards: the flagged patterns can't silently return ────────────────

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("source guards", () => {
  it("no Math.random() remains in the files S2245 flagged (or their twins)", () => {
    for (const rel of [
      "src/lib/pasteImage.ts",
      "src/lib/exportTemplates.ts",
      "src/store/memoryStore.ts",
      "src/store/aiStore.ts",
      "src/ai/bridge.ts",
    ]) {
      const src = fs.readFileSync(join(repoRoot, rel), "utf8");
      expect(src.includes("Math.random("), rel).toBe(false);
    }
  });

  it("CI scripts never hand child_process a bare command-name literal", () => {
    const bareLiteral =
      /(?<![.\w])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\(\s*['"`]/;
    for (const rel of ["scripts/ci/select.mjs", "scripts/resolve-conflicts.mjs"]) {
      const src = fs.readFileSync(join(repoRoot, rel), "utf8");
      expect(bareLiteral.test(src), rel).toBe(false);
    }
  });

  it("test-mcp-setup.py holds no publicly-writable-dir literals or TMP env reads", () => {
    const src = fs.readFileSync(join(repoRoot, "scripts/test-mcp-setup.py"), "utf8");
    const publicDir =
      /["'](\/tmp|\/var\/tmp|\/usr\/tmp|\/dev\/shm|\/dev\/mqueue|\/run\/lock|\/var\/run\/lock|\/private\/tmp|\/private\/var\/tmp|\/library\/caches|\/users\/shared)\//i;
    const tmpEnv =
      /(?:environ\s*\[|environ\.get\(|getenv\()\s*["'](?:TMP|TMPDIR|TEMPDIR|TEMP)["']/;
    expect(publicDir.test(src)).toBe(false);
    expect(tmpEnv.test(src)).toBe(false);
  });
});
