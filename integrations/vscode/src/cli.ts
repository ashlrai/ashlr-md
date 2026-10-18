/**
 * The `mdopen` CLI fallback, kept apart from `extension.ts` (which needs the
 * `vscode` module) so `npm test` can run it under `node:test`.
 */

import { spawn } from "node:child_process";
import type { OpenMode } from "./links";

/**
 * How the `mdopen` fallback went: `opened` (exit 0), `not-run` (it could
 * not be started at all, so it is missing or not executable), or `failed`
 * (it ran and exited non-zero or was killed), with what it wrote to stderr.
 */
export type CliOutcome =
  | { kind: "opened" }
  | { kind: "not-run" }
  | { kind: "failed"; code: number | null; stderr: string };

/**
 * Spawn `mdopen [--edit] -- <path>`. Only exit status 0 counts as opened (it
 * exits 1 when the file could not be opened); a `mdopen` killed by a signal
 * (a `null` exit code) is a failure. `--` keeps a path that starts with `-`
 * from being read as a flag.
 */
export function openViaCli(
  cliPath: string,
  absolutePath: string,
  mode: OpenMode,
): Promise<CliOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome: CliOutcome) => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    try {
      const flags = mode === "edit" ? ["--edit"] : [];
      const child = spawn(cliPath, [...flags, "--", absolutePath], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < 4096) stderr += chunk;
      });
      child.on("error", () => done({ kind: "not-run" }));
      child.on("close", (code) =>
        done(code === 0 ? { kind: "opened" } : { kind: "failed", code, stderr }),
      );
    } catch {
      done({ kind: "not-run" });
    }
  });
}

/**
 * The error shown when neither the deep link nor `mdopen` opened the file.
 * It used to say, whatever happened, to install Ashlr MD or set
 * `ashlr-md.cliPath`, even when `mdopen` ran and said why it could not open
 * the file, and it named an "Install CLI tool" command the app does not have.
 */
export function cliFailureMessage(cliPath: string, outcome: CliOutcome): string {
  if (outcome.kind === "failed") {
    const reason = outcome.stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .find((l) => l.startsWith("mdopen:"));
    const status =
      outcome.code === null ? "it was stopped" : `it exited with status ${outcome.code}`;
    return reason
      ? `Ashlr MD: could not open the file (${reason}).`
      : `Ashlr MD: could not open the file: \`${cliPath}\` ran but ${status}.`;
  }
  return (
    "Ashlr MD: could not open the file. The mdopener:// link did not open " +
    `and \`${cliPath}\` could not be run. Install Ashlr MD ` +
    "(https://md.ashlr.ai) so the link is registered, or install `mdopen` " +
    "from Ashlr MD (Preferences, Command-line tool, Install mdopen) and set " +
    "`ashlr-md.cliPath` if it is not on your PATH."
  );
}
