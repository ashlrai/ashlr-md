import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

function getLinksFromLlmsFile(filePath: string): Array<{name: string, url: string}> {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const links: Array<{name: string, url: string}> = [];

  for (const line of lines) {
    // Match lines that look like "- [Link Name](url): description"
    const match = line.match(/^\- \[(.*?)\]\((.*?)\):/);
    if (match) {
      const name = match[1];
      // Drop any #anchor: the file must exist (anchors are checked by check:doc-links).
      const url = match[2].split("#")[0];
      links.push({ name, url });
    }
  }

  return links;
}

function isAbsolutePath(url: string): boolean {
  return url.startsWith("/") || url.startsWith("http://") || url.startsWith("https://");
}

function isFileLink(url: string): boolean {
  return url.endsWith(".md") || url.endsWith(".txt") || url.endsWith(".json") || url.endsWith(".mdx");
}

describe("llms.txt link validation", () => {
  it("should validate all links in llms.txt point to existing files or valid routes", () => {
    const links = getLinksFromLlmsFile("llms.txt");
    const errors: string[] = [];

    for (const { name, url } of links) {
      // Skip external URLs
      if (isAbsolutePath(url)) {
        // We can't easily validate external URLs in this test context
        // but we can at least check the URL format is reasonable
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          errors.push(`Invalid absolute URL format in link "${name}": ${url}`);
        }
        continue;
      }

      // For local files, check if they exist
      if (isFileLink(url)) {
        try {
          const filePath = resolve(url);
          // The test will fail if file doesn't exist, which is what we want
          // We don't need to actually read the file here, just ensure it exists
          const fs = require("fs");
          if (!fs.existsSync(filePath)) {
            errors.push(`Missing file referenced in link "${name}": ${url}`);
          }
        } catch (e) {
          errors.push(`Error checking file "${name}": ${url} - ${e.message}`);
        }
      } else {
        // For other local paths, treat as relative to repo root and check file existence
        try {
          const filePath = resolve(url);
          const fs = require("fs");
          if (!fs.existsSync(filePath)) {
            errors.push(`Missing file referenced in link "${name}": ${url}`);
          }
        } catch (e) {
          errors.push(`Error checking file "${name}": ${url} - ${e.message}`);
        }
      }
    }

    // Fail the test if there were any errors
    if (errors.length > 0) {
      const errorMessages = errors.join("\n");
      throw new Error(`Link validation failed:\n${errorMessages}`);
    }
  });

  it("should validate all links in landing/llms.txt point to existing files or valid routes", () => {
    const links = getLinksFromLlmsFile("landing/llms.txt");
    const errors: string[] = [];

    for (const { name, url } of links) {
      // Skip external URLs
      if (isAbsolutePath(url)) {
        // We can't easily validate external URLs in this test context
        // but we can at least check the URL format is reasonable
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          errors.push(`Invalid absolute URL format in link "${name}": ${url}`);
        }
        continue;
      }

      // For local files, check if they exist
      if (isFileLink(url)) {
        try {
          const filePath = resolve(url);
          // The test will fail if file doesn't exist, which is what we want
          const fs = require("fs");
          if (!fs.existsSync(filePath)) {
            errors.push(`Missing file referenced in link "${name}": ${url}`);
          }
        } catch (e) {
          errors.push(`Error checking file "${name}": ${url} - ${e.message}`);
        }
      } else {
        // For other local paths, treat as relative to repo root and check file existence
        try {
          const filePath = resolve(url);
          const fs = require("fs");
          if (!fs.existsSync(filePath)) {
            errors.push(`Missing file referenced in link "${name}": ${url}`);
          }
        } catch (e) {
          errors.push(`Error checking file "${name}": ${url} - ${e.message}`);
        }
      }
    }

    // Fail the test if there were any errors
    if (errors.length > 0) {
      const errorMessages = errors.join("\n");
      throw new Error(`Link validation failed:\n${errorMessages}`);
    }
  });
});
