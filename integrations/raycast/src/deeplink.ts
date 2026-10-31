import { basename } from "node:path";

/** Match the desktop app's Markdown allowlist; reject traversal before encoding. */
export function buildDeepLink(path: string): string {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\\") ||
      path.split("/").some((part) => part === ".." || part === ".") ||
      basename(path).startsWith(".") || !/\.(md|markdown|mdown|mkd|mdx)$/i.test(path)) {
    throw new Error("Expected an absolute Markdown file path without traversal");
  }
  return `mdopener://open?path=${encodeURIComponent(path)}`;
}

/** Spotlight's NUL output preserves spaces, Unicode and newlines in filenames. */
export function parsePaths(output: string): string[] {
  return [...new Set(output.split("\0").filter((path) => {
    try { buildDeepLink(path); return true; } catch { return false; }
  }))];
}
