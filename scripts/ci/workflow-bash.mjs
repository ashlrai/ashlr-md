#!/usr/bin/env node
// workflow-bash - parse-check every workflow `run:` block that executes under
// bash or sh by piping it through `bash -n`.
//
// Why: a missing `"` in auto-tag.yml's "Detect version change" step broke the
// daily Auto-tag run on main (syntax error near unexpected token `('). GitHub
// renders ${{ }} expressions before the shell sees the script, so nothing else
// validates this layer before merge.
//
// Effective-shell resolution per step:
//   • step `shell:` wins - bash and sh are checked, every other value
//     (pwsh, powershell, cmd, python, …) is skipped
//   • no `shell:` → GitHub's default: pwsh on Windows runners, bash elsewhere.
//     A literal Windows `runs-on:` skips; a matrix `runs-on` is checked under
//     bash unless the step is gated to the Windows leg (`if:` containing
//     `matrix.os == 'Windows'`)
//   • ${{ … }} expressions are replaced with `:` before parsing; GitHub
//     substitutes them before bash runs
//
// Exits 1 with ::error:: lines on any bash -n failure.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const BASHISH = new Set(['bash', 'sh']);
// ${{ }} may span lines; non-greedy up to the first `}}`.
const EXPR = /\$\{\{[\s\S]*?\}\}/g;
// Step `if:` restricted to a Windows matrix leg runs under pwsh.
const WINDOWS_LEG = /matrix\.os\s*==\s*'Windows'/;

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Extract every step's run script with the context needed to pick its shell.
 * Deliberately a narrow indentation scan, not a YAML parser: it reads only
 * `runs-on:`, `steps:`, step `- ` items, and the `name`/`shell`/`if`/`run`
 * keys, including `run: |`/`>` block scalars and `- run:` first-key form.
 * @param {string} text workflow YAML source
 * @returns {Array<{name:string,shell:string,ifExpr:string,run:string,runsOn:string,line:number}>}
 */
export function extractRuns(text) {
  const lines = text.split('\n');
  const steps = [];
  let runsOn = '';
  let stepsIndent = -1;
  let itemIndent = -1;
  let step = null;
  let keyIndent = -1;

  const flush = () => {
    if (step && step.run !== null) steps.push(step);
    step = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const ind = indentOf(line);

    if (stepsIndent >= 0 && ind <= stepsIndent) {
      stepsIndent = -1;
      itemIndent = -1;
      flush();
    }

    const runsOnMatch = t.match(/^runs-on:\s*(.+)$/);
    if (stepsIndent < 0 && runsOnMatch) {
      runsOn = runsOnMatch[1].trim();
      continue;
    }

    if (stepsIndent < 0) {
      if (/^steps:\s*$/.test(t)) stepsIndent = ind;
      continue;
    }

    // A `- ` item at the steps' item indent opens a new step; deeper dashes
    // are nested list values.
    if (t.startsWith('- ')) {
      if (itemIndent >= 0 && ind !== itemIndent) continue;
      itemIndent = ind;
      flush();
      step = { name: '', shell: '', ifExpr: '', run: null, runsOn, line: i + 1 };
      keyIndent = ind + 2;
      const first = t.slice(2);
      if (!first) continue;
      handleKey(first, i);
      continue;
    }

    if (!step || ind !== keyIndent) continue;
    handleKey(t, i);
  }
  flush();
  return steps;

  function handleKey(t, i) {
    const m = t.match(/^(name|shell|if|run):\s*(.*)$/);
    if (!m) return;
    const [, key, raw] = m;
    if (key === 'run') {
      if (/^[|>]/.test(raw) || raw === '') {
        // Block scalar: content is every following line deeper than the key.
        const body = [];
        let blockIndent = -1;
        while (i + 1 < lines.length) {
          const l = lines[i + 1];
          if (l.trim() === '') {
            body.push('');
            i++;
            continue;
          }
          const li = indentOf(l);
          if (li <= keyIndent) break;
          if (blockIndent < 0) blockIndent = li;
          body.push(l.slice(blockIndent));
          i++;
        }
        step.run = body.join('\n');
      } else {
        // Single-line scalar; strip one pair of wrapping quotes if present.
        const v = raw.trim();
        step.run =
          v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))
            ? v.slice(1, -1)
            : v;
      }
    } else if (key === 'if') {
      step.ifExpr = raw.trim();
    } else {
      step[key] = raw.trim();
    }
  }
}

/**
 * bash -n each run block whose effective shell is bash or sh.
 * @param {Array} steps from extractRuns
 * @param {{spawn?: Function}} [opts] injectable for tests
 * @returns {{checked:number, skipped:number, failures:Array<{line:number,name:string,stderr:string}>}}
 */
export function checkRuns(steps, opts = {}) {
  const spawn = opts.spawn ?? spawnSync;
  const failures = [];
  let checked = 0;
  let skipped = 0;
  for (const s of steps) {
    const shell = s.shell.toLowerCase().split(/\s+/)[0];
    const bashDefault = !/windows/i.test(s.runsOn) && !WINDOWS_LEG.test(s.ifExpr);
    if (shell ? !BASHISH.has(shell) : !bashDefault) {
      skipped++;
      continue;
    }
    const result = spawn('bash', ['-n'], { input: s.run.replace(EXPR, ':'), encoding: 'utf8' });
    if (result.error) throw result.error;
    checked++;
    if (result.status !== 0) {
      failures.push({
        line: s.line,
        name: s.name || '(unnamed step)',
        stderr: (result.stderr || '').trim().split('\n').slice(0, 2).join('\n'),
      });
    }
  }
  return { checked, skipped, failures };
}

/**
 * CLI entry point.
 * @returns {number} exit code
 */
export function main() {
  const dir = join(ROOT, '.github/workflows');
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  let checked = 0;
  let skipped = 0;
  let failed = 0;
  for (const file of files) {
    const path = join(dir, file);
    const { checked: c, skipped: s, failures } = checkRuns(extractRuns(readFileSync(path, 'utf8')));
    checked += c;
    skipped += s;
    for (const f of failures) {
      failed++;
      process.stderr.write(
        `::error file=.github/workflows/${file},line=${f.line}::run block "${f.name}" fails bash -n: ${f.stderr}\n`,
      );
    }
  }
  process.stderr.write(
    `workflow-bash: ${checked} run blocks bash -n clean, ${skipped} non-bash skipped, ${failed} failed\n`,
  );
  return failed ? 1 : 0;
}

// When run directly, execute CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
