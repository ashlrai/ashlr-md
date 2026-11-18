import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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
      // Sibling-product links point outside this repository; only repo files
      // (relative or the blob/main prefix) are checked here.
      if (/^https:\/\//.test(link) && !link.startsWith(prefix)) continue;
      const target = link.startsWith(prefix) ? link.slice(prefix.length) : link;
      const [path, anchor] = target.split("#", 2);
      expect(path, link).not.toMatch(/^[a-z][a-z\d+.-]*:/i);
      expect(isAbsolute(path), link).toBe(false);
      expect(path).not.toMatch(/(?:^|\/)\.\.(?:\/|$)/);
      expect(existsSync(resolve(root, path)), path).toBe(true);
      if (anchor) {
        // GitHub heading slug: lowercase, drop punctuation, spaces to hyphens.
        const slugs = readFileSync(resolve(root, path), "utf8")
          .split(/\r?\n/)
          .filter((line) => /^#{1,6}\s/.test(line))
          .map((line) =>
            line
              .replace(/^#{1,6}\s+/, "")
              .trim()
              .toLowerCase()
              .replace(/[^\p{L}\p{N}\s-]/gu, "")
              .replace(/\s/g, "-"),
          );
        expect(slugs, link).toContain(anchor);
      }
    }
  });
});
