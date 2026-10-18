import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cliFailureMessage, openViaCli } from "./cli";

/** A script `node -- <script>` runs in place of a file, standing in for `mdopen`. */
function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ashlr-md-vscode-"));
  const path = join(dir, "fake-mdopen.js");
  writeFileSync(path, body);
  return path;
}

describe("openViaCli", () => {
  it("reports opened on exit 0", async () => {
    const outcome = await openViaCli(process.execPath, script("process.exit(0)"), undefined);
    assert.deepEqual(outcome, { kind: "opened" });
  });

  it("reports a CLI that cannot be started as not run", async () => {
    const outcome = await openViaCli(
      join(tmpdir(), "no-such-mdopen-for-ashlr-md-tests"),
      "/notes/a.md",
      undefined,
    );
    assert.deepEqual(outcome, { kind: "not-run" });
  });

  it("keeps the exit status and stderr of a CLI that failed", async () => {
    const outcome = await openViaCli(
      process.execPath,
      script('process.stderr.write("mdopen: /notes/a.md: No such file\\n"); process.exit(1)'),
      undefined,
    );
    assert.equal(outcome.kind, "failed");
    assert.ok(outcome.kind === "failed" && outcome.code === 1);
    assert.match(outcome.kind === "failed" ? outcome.stderr : "", /No such file/);
  });
});

describe("cliFailureMessage", () => {
  // A `mdopen` that ran and said why it could not open the file used to get
  // the same "install Ashlr MD or set ashlr-md.cliPath" error as a missing one.
  it("passes on what a failed mdopen said, not an install hint", () => {
    const msg = cliFailureMessage("mdopen", {
      kind: "failed",
      code: 1,
      stderr: "mdopen: /notes/a.md: No such file\n",
    });
    assert.equal(msg, "Ashlr MD: could not open the file (mdopen: /notes/a.md: No such file).");
    assert.doesNotMatch(msg, /Install/);
  });

  it("names the exit status when a failed mdopen said nothing", () => {
    assert.match(
      cliFailureMessage("/opt/mdopen", { kind: "failed", code: 2, stderr: "" }),
      /`\/opt\/mdopen` ran but it exited with status 2/,
    );
    assert.match(
      cliFailureMessage("mdopen", { kind: "failed", code: null, stderr: "" }),
      /ran but it was stopped/,
    );
  });

  // The README and the error pointed at an "Install CLI tool" command the
  // app does not have; mdopen is installed from Preferences.
  it("says where to install mdopen when it could not be run", () => {
    const msg = cliFailureMessage("mdopen", { kind: "not-run" });
    assert.match(msg, /https:\/\/md\.ashlr\.ai/);
    assert.match(msg, /Preferences, Command-line tool, Install mdopen/);
    assert.match(msg, /ashlr-md\.cliPath/);
    assert.doesNotMatch(msg, /Install CLI tool/);
    assert.doesNotMatch(msg, /[–—]/);
  });
});
