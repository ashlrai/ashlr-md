import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const content = readFileSync(resolve(root, "llms.txt"), "utf8");

describe("llms.txt", () => {
  it("starts with the project name and a one-line summary", () => {
    expect(content).toMatch(/^# Ashlr MD\r?\n\r?\n> \S[^\r\n]*\r?\n/);
  });

  it("links to existing repository files", () => {
    const links = [...content.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
    const prefix = "https://github.com/ashlrai/ashlr-md/blob/main/";
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.startsWith(prefix), link).toBe(true);
      const path = link.slice(prefix.length);
      expect(path).not.toMatch(/(?:^|\/)\.\.(?:\/|$)/);
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }
  });
});
