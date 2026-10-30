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

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { toolPath } from "../../scripts/tool-path.mjs";
import { useConversationStore, useMemoryStore } from "../store/memoryStore";
import { newTemplateId } from "./exportTemplates";
import { pasteImageFilename } from "./pasteImage";
import { randomBase36, uniqueId } from "./uniqueId";

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
  it("resolves repo-script tools to absolute paths", () => {
    for (const name of ["git", "node"]) {
      const p = toolPath(name);
      expect(isAbsolute(p), `${name} → ${p}`).toBe(true);
      expect(basename(p)).toBe(name);
    }
  });

  it("finds executables in a caller-provided PATH entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-path-ok-"));
    try {
      const exe = join(dir, "q8tool");
      writeFileSync(exe, "#!/bin/sh\nexit 0\n");
      chmodSync(exe, 0o755);
      expect(toolPath("q8tool", { PATH: dir })).toBe(exe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses executables inside a world-writable PATH entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-path-ww-"));
    chmodSync(dir, 0o777);
    try {
      const exe = join(dir, "q8tool");
      writeFileSync(exe, "#!/bin/sh\nexit 0\n");
      chmodSync(exe, 0o755);
      expect(() => toolPath("q8tool", { PATH: dir })).toThrow(/not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores relative PATH entries and throws when nothing matches", () => {
    expect(() => toolPath("missing-q8-tool", { PATH: "." })).toThrow(/not found/);
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
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(src.includes("Math.random("), rel).toBe(false);
    }
  });

  it("CI scripts never hand child_process a bare command-name literal", () => {
    const bareLiteral =
      /(?<![.\w])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\(\s*['"`]/;
    for (const rel of ["scripts/ci/select.mjs", "scripts/resolve-conflicts.mjs"]) {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(bareLiteral.test(src), rel).toBe(false);
    }
  });

  it("test-mcp-setup.py holds no publicly-writable-dir literals or TMP env reads", () => {
    const src = readFileSync(join(repoRoot, "scripts/test-mcp-setup.py"), "utf8");
    const publicDir =
      /["'](\/tmp|\/var\/tmp|\/usr\/tmp|\/dev\/shm|\/dev\/mqueue|\/run\/lock|\/var\/run\/lock|\/private\/tmp|\/private\/var\/tmp|\/library\/caches|\/users\/shared)\//i;
    const tmpEnv =
      /(?:environ\s*\[|environ\.get\(|getenv\()\s*["'](?:TMP|TMPDIR|TEMPDIR|TEMP)["']/;
    expect(publicDir.test(src)).toBe(false);
    expect(tmpEnv.test(src)).toBe(false);
  });
});
