import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildDeepLink, parsePaths } from "./deeplink";

test("round-trips spaces, Unicode and URL metacharacters", () => {
  for (const path of ["/Users/me/My Notes.md", "/文書/😊 café.markdown", "/tmp/a?#&%2e%2e.md"]) {
    const url = new URL(buildDeepLink(path));
    assert.equal(url.protocol, "mdopener:");
    assert.equal(url.hostname, "open");
    assert.equal(url.searchParams.get("path"), path);
    assert.equal([...url.searchParams].length, 1);
    assert.equal(url.hash, "");
  }
});

test("rejects traversal, relative paths, NUL, dotfiles and non-Markdown", () => {
  for (const path of ["/tmp/../secret.md", "/tmp/./note.md", "../note.md", "note.md",
    "/tmp/..\\secret.md", "/tmp/a\0.md", "/tmp/.hidden.md", "/tmp/a.txt"]) {
    assert.throws(() => buildDeepLink(path));
  }
});

test("parses NUL-separated Spotlight paths, filtering and deduplicating", () => {
  assert.deepEqual(parsePaths("/tmp/a b.md\0/文書/a\nb.MDX\0/tmp/a b.md\0/tmp/../x.md\0/tmp/a.txt\0"),
    ["/tmp/a b.md", "/文書/a\nb.MDX"]);
  assert.deepEqual(parsePaths(""), []);
});
