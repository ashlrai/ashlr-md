// tool-path.mjs — resolve executables to absolute paths before spawning them.
//
// `child_process` calls with a bare command name let the OS search PATH
// (Sonar S4036): a directory early in PATH that other users can write to —
// /tmp, a shared CI tool dir — silently supplies a hijacked binary. Resolving
// the tool here keeps the lookup deterministic: fixed system locations are
// tried first, and PATH entries that are relative or world-writable are
// skipped outright since they are the hijack vector, never a legitimate
// install location.

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

// Fixed install locations, preferred over anything PATH provides.
const SYSTEM_DIRS = [
  '/usr/bin',
  '/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/sbin',
  '/sbin',
];

// On POSIX a directory anyone can write to is the hijack vector. Windows has
// no mode bits that map onto this check, so there only the absoluteness of
// the directory is required.
function dirIsUsable(dir) {
  if (!isAbsolute(dir)) return false;
  try {
    const st = statSync(dir);
    return (
      st.isDirectory() &&
      (process.platform === 'win32' || (st.mode & 0o002) === 0)
    );
  } catch {
    return false;
  }
}

/**
 * Resolve `name` (e.g. 'git') to an absolute executable path.
 *
 * Search order: fixed system dirs, then each PATH entry, in order, skipping
 * unusable directories. On Windows the PATHEXT suffixes are tried (in both
 * cases) so 'git' resolves to git.exe/git.cmd the way CreateProcess would.
 *
 * Throws when nothing matches; callers fold that into their usual failure
 * path (select.mjs falls back to the full suite, resolve-conflicts.mjs marks
 * the file as needing a human).
 */
export function toolPath(name, env = process.env) {
  const dirs = new Set([
    ...SYSTEM_DIRS,
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
  ]);
  const pathext = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
  const exts =
    process.platform === 'win32'
      ? ['', ...pathext, ...pathext.map((e) => e.toLowerCase())]
      : [''];
  for (const dir of dirs) {
    if (!dirIsUsable(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not present or not executable here — keep looking.
      }
    }
  }
  throw new Error(
    `tool-path: '${name}' not found in system dirs or a usable PATH entry`,
  );
}
