import { describe, expect, it } from "vitest";
import { applyHunkToContent, parseDiffHunks } from "../lib/diff";
import {
  applyHunksTo,
  applySelectedHunks,
  computeAgentDiff,
  invertHunk,
  locateHunk,
  proposalFromEdits,
  proposalInDocumentStyle,
  renderUnifiedDiff,
} from "./agentEdit";
import { splitLines } from "./lineDiff";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lines = (n: number, tag = "line") =>
  Array.from({ length: n }, (_, i) => `${tag} ${i + 1}\n`).join("");

/** A random edit of `text`: lines replaced, removed and added. */
function mutate(text: string, next: () => number): string {
  const out = splitLines(text);
  const edits = 1 + Math.floor(next() * 4);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(next() * (out.length + 1));
    const r = next();
    if (r < 0.33 && out.length > 0) out.splice(Math.min(at, out.length - 1), 1);
    else if (r < 0.66) out.splice(at, 0, `added ${Math.floor(next() * 1e6)}\n`);
    else if (out.length > 0) out[Math.min(at, out.length - 1)] = `changed ${e}\n`;
  }
  return out.join("");
}

describe("computeAgentDiff", () => {
  it("makes one hunk per change, with context and stats", () => {
    const base = "# Title\n\nalpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n";
    const proposed =
      "# Title\n\nalpha\nBETA\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\n";
    const diff = computeAgentDiff(base, proposed);
    expect(diff.stats).toEqual({ hunks: 2, added: 2, removed: 1 });
    expect(diff.hunks).toEqual([
      {
        id: "hunk-1",
        oldStart: 3,
        oldLines: ["beta\n"],
        newStart: 3,
        newLines: ["BETA\n"],
        before: ["# Title\n", "\n", "alpha\n"],
        after: ["gamma\n", "delta\n", "epsilon\n"],
      },
      {
        id: "hunk-2",
        oldStart: 10,
        oldLines: [],
        newStart: 10,
        newLines: ["iota\n"],
        before: ["zeta\n", "eta\n", "theta\n"],
        after: [],
      },
    ]);
  });

  it("has no hunks when nothing changed", () => {
    expect(computeAgentDiff("same\n", "same\n").hunks).toEqual([]);
  });

  it("never takes context from lines another hunk changes", () => {
    const diff = computeAgentDiff("a\nb\nc\nd\n", "A\nb\nC\nd\n");
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0].after).toEqual(["b\n"]);
    expect(diff.hunks[1].before).toEqual(["b\n"]);
  });

  it("honours the context option", () => {
    const diff = computeAgentDiff(lines(10), lines(10).replace("line 5\n", "five\n"), {
      context: 1,
    });
    expect(diff.hunks[0].before).toEqual(["line 4\n"]);
    expect(diff.hunks[0].after).toEqual(["line 6\n"]);
  });
});

describe("applySelectedHunks", () => {
  const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
  const proposed = "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n";
  const diff = computeAgentDiff(base, proposed);

  it("gives the proposal with every hunk and the base with none", () => {
    expect(applySelectedHunks(diff, new Set(diff.hunks.map((h) => h.id)))).toBe(
      proposed,
    );
    expect(applySelectedHunks(diff, new Set())).toBe(base);
  });

  it("applies only the accepted hunks", () => {
    expect(diff.hunks).toHaveLength(2);
    expect(applySelectedHunks(diff, new Set(["hunk-1"]))).toBe(
      "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n",
    );
    expect(applySelectedHunks(diff, new Set(["hunk-2"]))).toBe(
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n",
    );
  });

  it("round-trips random proposals, CRLF and missing final breaks included", () => {
    const next = rng(7);
    for (let round = 0; round < 200; round++) {
      let base = lines(Math.floor(next() * 30));
      if (next() < 0.3) base = base.replace(/\n/g, "\r\n");
      if (next() < 0.3) base = base.replace(/\r?\n$/, "");
      const proposed = mutate(base, next);
      const context = Math.floor(next() * 4);
      const diff = computeAgentDiff(base, proposed, { context });
      const all = new Set(diff.hunks.map((h) => h.id));
      expect(applySelectedHunks(diff, all)).toBe(proposed);
      expect(applySelectedHunks(diff, new Set())).toBe(base);
      // Any subset applied, then the rest applied on top, gives the proposal.
      // Not with no context: a zero-context insertion goes by its line
      // number alone, which the subset applied first has moved.
      if (context === 0) continue;
      const some = new Set([...all].filter(() => next() < 0.5));
      const partial = applySelectedHunks(diff, some);
      const rest = diff.hunks.filter((h) => !some.has(h.id));
      const finished = applyHunksTo(partial, rest);
      expect(finished.ok && finished.text).toBe(proposed);
    }
  });
});

describe("applyHunksTo", () => {
  const base = lines(30);
  const proposed = base.replace("line 10\n", "TEN\n").replace("line 20\n", "TWENTY\n");
  const diff = computeAgentDiff(base, proposed);

  it("applies in place when the document is the base", () => {
    expect(applyHunksTo(base, diff.hunks)).toEqual({
      ok: true,
      text: proposed,
      relocated: false,
    });
  });

  it("finds the hunks again after lines were added above them", () => {
    const current = `new top\nanother\n${base}`;
    const result = applyHunksTo(current, diff.hunks);
    expect(result).toEqual({
      ok: true,
      text: `new top\nanother\n${proposed}`,
      relocated: true,
    });
  });

  it("keeps edits the user made between and around the hunks", () => {
    const current = base
      .replace("line 1\n", "user edit at the top\n")
      .replace("line 15\n", "user edit between\n")
      .replace("line 30\n", "user edit at the end\n");
    const result = applyHunksTo(current, diff.hunks);
    expect(result.ok && result.text).toBe(
      proposed
        .replace("line 1\n", "user edit at the top\n")
        .replace("line 15\n", "user edit between\n")
        .replace("line 30\n", "user edit at the end\n"),
    );
  });

  it("places a hunk whose outer context the user changed (fuzz)", () => {
    const current = base.replace("line 7\n", "user changed this\n");
    const result = applyHunksTo(current, diff.hunks);
    expect(result.ok && result.text).toBe(
      proposed.replace("line 7\n", "user changed this\n"),
    );
  });

  it("is a conflict, and changes nothing, when a hunk's own lines were edited", () => {
    const current = base.replace("line 20\n", "the user rewrote line 20\n");
    expect(applyHunksTo(current, diff.hunks)).toEqual({
      ok: false,
      conflicts: ["hunk-2"],
    });
  });

  it("is a conflict when a hunk could go in two places equally well", () => {
    const d = computeAgentDiff("a\nb\nc\n", "a\nB\nc\n", { context: 1 });
    // "a b c" at lines 0 and 4: "b" at 1 and 5, both 2 from a hint of 3.
    const current = splitLines("a\nb\nc\nq\na\nb\nc\n");
    expect(locateHunk(current, d.hunks[0], 3)).toBeNull();
    // Where the diff put it, the nearer one wins.
    expect(applyHunksTo(current.join(""), d.hunks)).toMatchObject({
      ok: true,
      text: "a\nB\nc\nq\na\nb\nc\n",
    });
  });

  it("prefers the match nearest to where the hunk was", () => {
    const d = computeAgentDiff("a\nb\nc\n", "a\nB\nc\n", { context: 1 });
    const current = splitLines("a\nb\nc\nq\nq\nq\nq\na\nb\nc\n");
    expect(locateHunk(current, d.hunks[0], 1)).toBe(1);
    expect(locateHunk(current, d.hunks[0], 8)).toBe(8);
  });

  it("anchors an insertion by its context", () => {
    const d = computeAgentDiff("a\nb\nc\nd\n", "a\nb\nNEW\nc\nd\n", { context: 1 });
    expect(applyHunksTo("top\na\nb\nc\nd\n", d.hunks)).toEqual({
      ok: true,
      text: "top\na\nb\nNEW\nc\nd\n",
      relocated: true,
    });
    // Both context lines gone: nothing left to find it by.
    expect(applyHunksTo("a\nX\nY\nd\n", d.hunks)).toEqual({
      ok: false,
      conflicts: ["hunk-1"],
    });
  });

  it("places an insertion with no context at its line, moved by the hunks before it", () => {
    const d = computeAgentDiff("", "hello\n");
    expect(d.hunks[0]).toMatchObject({ oldLines: [], before: [], after: [] });
    expect(applyHunksTo("", d.hunks)).toEqual({
      ok: true,
      text: "hello\n",
      relocated: false,
    });
    expect(applyHunksTo("someone typed\n", d.hunks)).toEqual({
      ok: true,
      text: "hello\nsomeone typed\n",
      relocated: false,
    });
    // With context 0 an insertion follows the drift of the hunks placed
    // before it in the same call: line "z" goes after "c" wherever "c" went.
    const z = computeAgentDiff("a\nb\nc\n", "A\nb\nc\nz\n", { context: 0 });
    expect(z.hunks.map((h) => h.oldStart)).toEqual([0, 3]);
    expect(applyHunksTo("q\na\nb\nc\n", z.hunks)).toEqual({
      ok: true,
      text: "q\nA\nb\nc\nz\n",
      relocated: true,
    });
  });

  it("undoes with inverted hunks, keeping the user's edits", () => {
    const next = rng(99);
    for (let round = 0; round < 150; round++) {
      const base = lines(40 + Math.floor(next() * 20));
      // The agent edits the middle; the user then edits far from it.
      const agentLines = splitLines(base);
      agentLines.splice(20, 2, "agent A\n", "agent B\n", "agent C\n");
      const after = agentLines.join("");
      const diff = computeAgentDiff(base, after);

      const userLines = splitLines(after);
      userLines.splice(2, 0, `user ${round}\n`);
      userLines.push("user tail\n");
      const current = userLines.join("");

      const undone = applyHunksTo(current, diff.hunks.map(invertHunk));
      const expected = splitLines(base);
      expected.splice(2, 0, `user ${round}\n`);
      expected.push("user tail\n");
      expect(undone.ok && undone.text).toBe(expected.join(""));
    }
  });
});

describe("relocation on repetitive Markdown", () => {
  // Blank lines, bullets and fences repeat everywhere in Markdown, so a
  // hunk's lines and context often match in many places. Placed in the
  // text it was made for, every hunk must still land where it was (the
  // nearest match is at distance 0), forwards and inverted.
  const pool = ["\n", "- item\n", "```\n", "## Notes\n", "text\n", "> quote\n"];

  it("applies forward and inverted hunks back to the exact texts", () => {
    const next = rng(5150);
    for (let round = 0; round < 300; round++) {
      const make = (n: number) =>
        Array.from({ length: n }, () => pool[Math.floor(next() * pool.length)]).join(
          "",
        );
      const base = make(Math.floor(next() * 25));
      const proposed = mutate(base, next);
      const diff = computeAgentDiff(base, proposed, {
        context: Math.floor(next() * 4),
      });
      const forward = applyHunksTo(base, diff.hunks);
      expect(forward).toEqual({ ok: true, text: proposed, relocated: false });
      const inverse = applyHunksTo(proposed, diff.hunks.map(invertHunk));
      expect(inverse.ok && inverse.text).toBe(base);
    }
  });
});

describe("renderUnifiedDiff", () => {
  it("writes git-style hunks that the app's diff viewer applies back", () => {
    const base = lines(40);
    const proposed = base
      .replace("line 3\n", "THREE\n")
      .replace("line 5\n", "FIVE\nFIVE AND A HALF\n")
      .replace("line 30\n", "");
    const diff = computeAgentDiff(base, proposed);
    const text = renderUnifiedDiff(diff, "notes.md");
    expect(text.startsWith("--- a/notes.md\n+++ b/notes.md\n@@ -1,8 +1,9 @@\n")).toBe(
      true,
    );
    // Hunks 1 and 2 are close and share one @@ block; hunk 3 has its own.
    expect(text.match(/^@@/gm)).toHaveLength(2);
    expect(text).toContain("@@ -27,7 +28,6 @@");

    let content = base;
    for (const hunk of parseDiffHunks(text)) {
      expect(hunk.targetFile).toBe("notes.md");
      const applied = applyHunkToContent(content, hunk);
      if (!applied.ok) throw new Error(applied.error);
      content = applied.newContent;
    }
    expect(content).toBe(proposed);
  });

  it("round-trips random diffs through the viewer's parser", () => {
    const next = rng(2024);
    for (let round = 0; round < 150; round++) {
      // Distinct lines, so every hunk's find text is unique, as the viewer needs.
      const base = lines(5 + Math.floor(next() * 40), `r${round}`);
      const proposed = mutate(base, next);
      const text = renderUnifiedDiff(computeAgentDiff(base, proposed), "doc.md");
      let content = base;
      for (const hunk of parseDiffHunks(text)) {
        const applied = applyHunkToContent(content, hunk);
        if (!applied.ok) throw new Error(`round ${round}: ${applied.error}\n${text}`);
        content = applied.newContent;
      }
      expect(content).toBe(proposed);
    }
  });

  it("marks a last line with no line break", () => {
    const text = renderUnifiedDiff(computeAgentDiff("a\nb", "a\nc"), "x.md");
    expect(text).toBe(
      "--- a/x.md\n+++ b/x.md\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n",
    );
  });

  it("numbers an empty side from the line before, as git does", () => {
    expect(renderUnifiedDiff(computeAgentDiff("", "new\n"), "x.md")).toBe(
      "--- a/x.md\n+++ b/x.md\n@@ -0,0 +1,1 @@\n+new\n",
    );
    expect(renderUnifiedDiff(computeAgentDiff("gone\n", ""), "x.md")).toBe(
      "--- a/x.md\n+++ b/x.md\n@@ -1,1 +0,0 @@\n-gone\n",
    );
  });

  it("writes only the chosen hunks, numbered as if only they were applied", () => {
    const base = lines(30);
    const proposed = base.replace("line 2\n", "").replace("line 25\n", "TWENTY-FIVE\n");
    const diff = computeAgentDiff(base, proposed);
    const only = new Set(["hunk-2"]);
    const text = renderUnifiedDiff(diff, "x.md", { only });
    expect(text).toContain("@@ -22,7 +22,7 @@");
    expect(text).not.toContain("-line 2\n");
    let content = base;
    for (const hunk of parseDiffHunks(text)) {
      const applied = applyHunkToContent(content, hunk);
      if (!applied.ok) throw new Error(applied.error);
      content = applied.newContent;
    }
    expect(content).toBe(applySelectedHunks(diff, only));
  });

  it("is empty when there is nothing to write", () => {
    expect(renderUnifiedDiff(computeAgentDiff("a\n", "a\n"))).toBe("");
  });
});

describe("proposalFromEdits", () => {
  const base = "# Plan\n\n- draft the spec\n- review the spec\n";

  it("applies the edits in order, each to the result of the last", () => {
    expect(
      proposalFromEdits(base, [
        { find: "draft", replace: "write" },
        { find: "write the spec", replace: "write the spec today" },
      ]),
    ).toEqual({
      ok: true,
      text: "# Plan\n\n- write the spec today\n- review the spec\n",
    });
  });

  it("takes a matchIndex for a find that is not unique", () => {
    expect(
      proposalFromEdits(base, [{ find: "spec", replace: "SPEC", matchIndex: 1 }]),
    ).toEqual({
      ok: true,
      text: "# Plan\n\n- draft the spec\n- review the SPEC\n",
    });
  });

  it("fails as a whole, naming the edit, when one edit does not apply", () => {
    const result = proposalFromEdits(base, [
      { find: "draft", replace: "write" },
      { find: "spec", replace: "SPEC" },
    ]);
    expect(result).toMatchObject({ ok: false, editIndex: 1 });
    expect(!result.ok && result.error).toMatch(
      /^Edit 2 of 2: `find` string is not unique/,
    );
    expect(proposalFromEdits(base, [])).toMatchObject({ ok: false, editIndex: -1 });
  });

  it("matches an LF find in a CRLF document and writes CRLF", () => {
    const crlf = base.replace(/\n/g, "\r\n");
    const result = proposalFromEdits(crlf, [
      { find: "- draft the spec\n- review", replace: "- draft it\n- check" },
    ]);
    expect(result).toEqual({
      ok: true,
      text: "# Plan\r\n\r\n- draft it\r\n- check the spec\r\n",
    });
  });
});

describe("proposalInDocumentStyle", () => {
  it("writes an agent's LF text in a CRLF document's breaks, with its mark", () => {
    const base = "﻿a\r\nb\r\n";
    const proposed = proposalInDocumentStyle(base, "a\nB\n");
    expect(proposed).toBe("﻿a\r\nB\r\n");
    // So only the changed line is a hunk.
    expect(computeAgentDiff(base, proposed).stats).toEqual({
      hunks: 1,
      added: 1,
      removed: 1,
    });
  });
});
