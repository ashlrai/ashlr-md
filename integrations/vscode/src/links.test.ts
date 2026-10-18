import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDeepLink,
  handoffRefusal,
  isOpenableInAshlr,
  NOT_OPENABLE_MESSAGE,
  NOT_SAVED_MESSAGE,
} from "./links";

describe("isOpenableInAshlr", () => {
  it("takes every Markdown extension the app opens, in any case", () => {
    for (const p of [
      "/notes/a.md",
      "/notes/a.markdown",
      "/notes/a.mdown",
      "/notes/a.mkd",
      "/notes/a.mdx",
      "/notes/README.MD",
      "C:\\notes\\b.Md",
    ]) {
      assert.equal(isOpenableInAshlr(p), true, p);
    }
  });

  it("refuses dotfiles and other extensions", () => {
    for (const p of [
      "/notes/.notes.md",
      "C:\\notes\\.hidden.mdx",
      "/notes/a.txt",
      "/notes/a.md.bak",
      "/notes/md",
      "/notes/",
    ]) {
      assert.equal(isOpenableInAshlr(p), false, p);
    }
  });

  it("looks at the file name only, not a dotted folder", () => {
    assert.equal(isOpenableInAshlr("/home/me/.config/notes.md"), true);
  });
});

describe("buildDeepLink", () => {
  it("encodes the path", () => {
    assert.equal(
      buildDeepLink("/My Notes/a&b?.md"),
      "mdopener://open?path=%2FMy%20Notes%2Fa%26b%3F.md",
    );
  });

  it("adds &mode=edit only for edit mode", () => {
    assert.equal(
      buildDeepLink("/a.md", "edit"),
      "mdopener://open?path=%2Fa.md&mode=edit",
    );
    assert.equal(buildDeepLink("/a.md", undefined), "mdopener://open?path=%2Fa.md");
  });
});

describe("handoffRefusal", () => {
  // An untitled Markdown buffer is named `Untitled-1`, with no extension, so
  // it was told Ashlr MD opens only Markdown files instead to save first.
  it("tells an untitled or non-file document to save first", () => {
    assert.equal(
      handoffRefusal({ fsPath: "Untitled-1", isUntitled: true, scheme: "untitled" }),
      NOT_SAVED_MESSAGE,
    );
    assert.equal(
      handoffRefusal({ fsPath: "/remote/a.md", isUntitled: false, scheme: "vscode-remote" }),
      NOT_SAVED_MESSAGE,
    );
  });

  it("names the files Ashlr MD opens for any other file, and passes Markdown", () => {
    assert.equal(
      handoffRefusal({ fsPath: "/notes/a.txt", isUntitled: false, scheme: "file" }),
      NOT_OPENABLE_MESSAGE,
    );
    assert.equal(
      handoffRefusal({ fsPath: "/notes/a.md", isUntitled: false, scheme: "file" }),
      undefined,
    );
  });
});
