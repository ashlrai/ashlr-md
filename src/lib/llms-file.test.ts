import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const content = readFileSync(resolve(root, "llms.txt"), "utf8");

describe("llms.txt", () => {
  it("starts with the project name and a one-line summary", () => {
    expect(content).toMatch(/^# Ashlr MD\r?\n\r?\n> \S[^\r\n]*\r?\n/);
  });

  it("links to existing repository files or valid HTTPS URLs", () => {
    const links = [...content.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
    const prefix = "https://github.com/ashlrai/ashlr-md/blob/main/";
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      // Canonical repository URLs still resolve against the local checkout.
      const target = link.startsWith(prefix) ? link.slice(prefix.length) : link;
      if (target.startsWith("https://")) {
        expect(new URL(target).protocol, link).toBe("https:");
        continue;
      }
      const path = target.split("#", 1)[0];
      expect(path, link).not.toMatch(/^[a-z][a-z\d+.-]*:/i);
      expect(isAbsolute(path), link).toBe(false);
      expect(path).not.toMatch(/(?:^|\/)\.\.(?:\/|$)/);
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }
  });
});
