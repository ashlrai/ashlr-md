// Living documentation: doc claims checked against the code they describe,
// and marked regions of index/readme files regenerated from their sources.
//
// Two jobs share the `doclive:` marker family:
//
// 1. Drift detection (`check`). A doc section makes claims about code. Claims
//    are declared in the doc itself, one per line:
//
//      <!-- doclive: exists docs/EXAMPLES.md -->
//      <!-- doclive: symbol src/mcp/handlers/edit.ts#NO_DOCUMENT_OPEN -->
//      <!-- doclive: contains src/lib/commands.ts /shortcut: "/ -->
//      <!-- doclive: seq src-tauri/bins/mdopener-mcp/src/lib.rs /name: "([a-z_]+)",/ vs /^\d+\. `([a-z_]+)`/ -->
//      <!-- doclive: set <path> [#symbol] /<code-regex>/ vs /<doc-regex>/ -->
//
//    `seq` requires the items captured on both sides to be equal in order;
//    `set` compares them as multisets. The code regex runs on the whole file
//    (`#symbol` additionally asserts the symbol is defined there); the doc
//    regex runs on the enclosing section's text. Capture group 1 of each
//    match is the item (the whole match when the regex has no group). Regex
//    flags default to `gm`; `g` is always added.
//
//    On top of declared claims, every repo-shaped path in inline code or
//    fenced blocks of the watched docs must exist (resolved from the repo
//    root, the document's directory, or the fence's `cd` target). Every
//    claim maps to its enclosing Markdown section, so drift is reported per
//    section, not per line.
//
// 2. Regeneration (`sync`). Marked blocks in the watched docs are rewritten
//    from their sources, like the freshness blocks:
//
//      <!-- doclive:begin docs-index -->
//      <!-- doclive:end -->
//
//    `docs-index` lists every Markdown file under docs/ with its first
//    heading; `mcp-events` rebuilds the frontend MCP event table in
//    src/mcp/bridge.ts wiring order. `check` fails on drift or bad markers;
//    `sync` rewrites the blocks and still reports claim problems.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headingSlugs, maskCode, stripContainers } from '../check-doc-links.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The docs kept honest: agent-facing prose plus every guide under docs/.
// CHANGELOG.md is historical, samples/ are demo documents, and fixture or
// template trees are not documentation.
export const WATCHED = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'ROADMAP.md',
  'SECURITY.md',
  'llms.txt',
  'llms-full.txt',
  'docs',
  'integrations',
  'landing',
  'scripts',
  'bench',
];

const MARKDOWN = /\.(md|markdown|mdown|mkd|mdx)$/i;
const NEVER_TOP = new Set(['node_modules', 'target', 'dist', '.git']);
const CLAIM_RE = /^[ \t]*<!-- doclive: (.+?) -->[ \t]*$/;
const BLOCK_BEGIN = /^<!-- doclive:begin ([a-z-]+) -->$/;
const BLOCK_END = '<!-- doclive:end -->';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── Line scanner ─────────────────────────────────────────────────────────────

/**
 * Every line of `src` with its fence state: `{ line, text, fence }` where
 * `fence` is 'open' (the ``` line itself), 'code' (inside a fence), 'close'
 * (the closing ``` line) or false (prose). Follows maskCode's rules: fences
 * may hide behind blockquote/list markers, and a ``` info string cannot
 * itself contain a backtick.
 */
export function* codeLines(src) {
  const lines = src.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const body = stripContainers(raw.replace(/\r$/, ''));
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.ch}{${fence.len},}[ \t]*$`).test(body)) {
        fence = null;
        yield { line: i + 1, text: raw, fence: 'close' };
      } else {
        yield { line: i + 1, text: raw, fence: 'code' };
      }
      continue;
    }
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(body);
    if (m && !(m[1][0] === '`' && body.slice(m[0].length).includes('`'))) {
      fence = { ch: m[1][0], len: m[1].length };
      yield { line: i + 1, text: raw, fence: 'open' };
      continue;
    }
    yield { line: i + 1, text: raw, fence: false };
  }
}

// ── Markdown sections ────────────────────────────────────────────────────────

/** Heading text with inline markdown reduced to plain text. */
export function plainHeading(raw) {
  return raw
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/!\[(?:\\.|[^\]\\])*\]\([^)]*\)/g, '')
    .replace(/\[(?:\\.|[^\]\\])*\]\([^)]*\)/g, (m) => m.slice(1, m.indexOf('](')))
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~]/g, '')
    .trim();
}

/**
 * The heading-delimited blocks of `src`: `[{ level, title, line, bodyStart,
 * bodyEnd, path }]`, plus a level-0 `(top)` preamble when content precedes
 * the first heading. `line`/`bodyStart`/`bodyEnd` are 1-based; `bodyEnd` is
 * the next heading's line (or lines.length + 1). `path` is the ancestor
 * heading chain for reports. ATX headings only; code, comments and front
 * matter are hidden by maskCode.
 */
export function sections(src) {
  const masked = maskCode(src);
  const lines = src.split('\n');
  const starts = [0];
  let off = 0;
  for (const l of lines) {
    off += l.length + 1;
    starts.push(off);
  }
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    if (masked[starts[i]]) continue;
    const m = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(stripContainers(lines[i]));
    if (!m) continue;
    heads.push({ level: m[1].length, title: plainHeading(m[2]), line: i + 1 });
  }
  const out = [];
  const stack = [];
  for (const h of heads) {
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    const path = [...stack.map((s) => s.title), h.title].join(' > ');
    stack.push({ level: h.level, title: h.title });
    out.push({ ...h, path, bodyStart: h.line + 1 });
  }
  for (let i = 0; i < out.length; i++) {
    out[i].bodyEnd = i + 1 < out.length ? out[i + 1].line : lines.length + 1;
  }
  const first = out.length ? out[0].line : lines.length + 1;
  if (first > 1 || out.length === 0) {
    out.unshift({ level: 0, title: '(top)', line: 1, path: '(top)', bodyStart: 1, bodyEnd: first });
  }
  return out;
}

/** The section containing 1-based `line`. */
export function sectionAt(secs, line) {
  let hit = secs[0];
  for (const s of secs) {
    if (s.line <= line) hit = s;
    else break;
  }
  return hit;
}

/** Section body text (doclive comments stripped), for doc-side regexes. */
function sectionText(lines, sec) {
  return lines
    .slice(sec.bodyStart - 1, sec.bodyEnd - 1)
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '');
}

// ── Declared claims ──────────────────────────────────────────────────────────

/**
 * `<!-- doclive: spec -->` comments, one per line, outside fenced code:
 * `[{ line, spec }]`. Anything else on the line disqualifies it.
 */
export function declaredClaims(src) {
  const out = [];
  for (const { line, text, fence } of codeLines(src)) {
    if (fence) continue;
    const m = CLAIM_RE.exec(text);
    if (m) out.push({ line, spec: m[1].trim() });
  }
  return out;
}

/** Read one `/regex/flags` literal from the front of `text`. */
function takeRegex(text, what) {
  if (!text.startsWith('/')) throw new Error(`${what}: expected /regex/, got ${JSON.stringify(text)}`);
  let i = 1;
  let pat = '';
  while (i < text.length) {
    if (text[i] === '\\') {
      pat += text[i] + (text[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (text[i] === '/') {
      i++;
      let flags = '';
      while (i < text.length && /[a-z]/.test(text[i])) flags += text[i++];
      if (flags === '') flags = 'gm';
      if (!flags.includes('g')) flags += 'g';
      try {
        return [new RegExp(pat, flags), text.slice(i).trim()];
      } catch (error) {
        throw new Error(`${what}: ${error.message}`);
      }
    }
    pat += text[i];
    i++;
  }
  throw new Error(`${what}: unterminated /regex/`);
}

/**
 * Parse one claim spec into `{ probe, path, symbol, codeRe, docRe }`.
 * Throws on malformed specs; the caller reports them as claim problems.
 */
export function parseClaim(spec) {
  const probe = spec.split(/\s+/, 1)[0];
  const rest = spec.slice(probe.length).trim();
  if (probe === 'exists') {
    if (!rest) throw new Error('exists claim needs a path');
    return { probe, path: rest };
  }
  if (probe === 'symbol') {
    const hash = rest.indexOf('#');
    if (hash < 0) throw new Error('symbol claim needs path#name');
    const name = rest.slice(hash + 1);
    if (!IDENT.test(name)) throw new Error(`symbol claim: bad symbol name ${JSON.stringify(name)}`);
    return { probe, path: rest.slice(0, hash), symbol: name };
  }
  if (probe === 'contains') {
    const path = rest.split(/\s+/, 1)[0];
    const [re, tail] = takeRegex(rest.slice(path.length).trim(), 'contains');
    if (tail !== '') throw new Error(`contains claim takes one /regex/, got ${JSON.stringify(tail)}`);
    return { probe, path, codeRe: re };
  }
  if (probe === 'seq' || probe === 'set') {
    const m = /^(\S+?)(?:#([A-Za-z_][A-Za-z0-9_]*))?\s+(.+)$/.exec(rest);
    if (!m) throw new Error(`${probe} claim needs <path> [#symbol] /code-regex/ vs /doc-regex/`);
    const [, path, symbol, regs] = m;
    const [codeRe, afterCode] = takeRegex(regs.trim(), `${probe} code`);
    const vs = /^vs\s+/.exec(afterCode);
    if (!vs) throw new Error(`${probe} claim needs "/code-regex/ vs /doc-regex/"`);
    const [docRe, tail] = takeRegex(afterCode.slice(vs[0].length), `${probe} doc`);
    if (tail !== '') throw new Error(`${probe} claim: unexpected ${JSON.stringify(tail)}`);
    return { probe, path, symbol, codeRe, docRe };
  }
  throw new Error(`unknown doclive probe ${JSON.stringify(probe)}`);
}

/** Ordered items a regex captures: group 1 of each match, else whole match. */
export function regexItems(text, re) {
  const out = [];
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[0]);
  return out;
}

function insideRoot(root, abs) {
  const rel = relative(root, abs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Repo-root-relative claim path → absolute, or null when it escapes root. */
export function claimPath(root, p) {
  if (!p || /\s/.test(p) || p.startsWith('~') || p.startsWith('/') || /^[a-zA-Z][\w+.-]*:/.test(p)) return null;
  const abs = resolve(root, p);
  return insideRoot(root, abs) ? abs : null;
}

/** Does `name` have a definition in `src`? Language-agnostic patterns. */
export function symbolDefined(src, name, file = '') {
  if (MARKDOWN.test(file)) return headingSlugs(src).has(name);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kw = new RegExp(`\\b(?:fn|def|function|class|struct|enum|trait|interface|type|const|static|let|var|mod|impl|async)\\s+${esc}\\b`);
  if (kw.test(src)) return true;
  if (/\.(json|toml|ya?ml)$/.test(file)) {
    return new RegExp(`^\\s*["']?${esc}["']?\\s*[:=]`, 'm').test(src);
  }
  return false;
}

// ── Inferred path claims ─────────────────────────────────────────────────────

/** Inline code spans of a prose line: `` `…` `` runs, comments removed. */
export function inlineSpans(text) {
  const prose = text.replace(/<!--[\s\S]*?-->/g, '');
  return [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

/** Tokens of a code text: quoted strings stay atomic, then bare words. */
export function* codeTokens(text) {
  const re = /"([^"\n]+)"|'([^'\n]+)'|([^\s"'`()<>{}\[\]|;,]+)/g;
  for (const m of text.matchAll(re)) yield m[1] ?? m[2] ?? m[3];
}

/** Strip surrounding punctuation a sentence leaves on a path token. */
function cleanToken(raw) {
  let t = raw;
  for (;;) {
    const n = t.replace(/^[([{"'`]+/, '').replace(/[)\]}>.,;:!?'"`\r]+$/, '');
    if (n === t) return t;
    t = n;
  }
}

const dirCache = new Map();

// Paths that look repo-shaped but are not files in this tree: release
// artifacts users download (`Ashlr_MD_*.deb`, `./AshlrMD.AppImage`), build
// output under src-tauri/target/, paths inside other AshlrAI repos
// (phantom's docs/ and src/), and the illustrative `./file.md` examples the
// mdlint fixture guides lint. Same role as check-readme-parity's examples.
const CLAIM_EXEMPT = new Set([
  'docs/STANDING-AUTHORITY.md',
  'docs/companions/ashlr-md.md',
  'src/core/integrations/markdown.ts',
  './guide.md',
  './report.md',
  './setup.md',
  './release-notes.md',
  './installation.md',
]);
const CLAIM_EXEMPT_PREFIX = ['src-tauri/target/'];
const ARTIFACT_NAME = /(?:^|\/)Ashlr_?MD[_.]/;

function claimExempt(probe) {
  const base = probe.split('/').pop();
  return CLAIM_EXEMPT.has(probe) ||
    CLAIM_EXEMPT_PREFIX.some((p) => probe.startsWith(p)) ||
    ARTIFACT_NAME.test(probe) || ARTIFACT_NAME.test(base);
}

/** Top-level directory names at `root`, minus generated trees (cached). */
export function rootDirs(root) {
  if (dirCache.has(root)) return dirCache.get(root);
  const out = new Set();
  for (const name of readdirSync(root)) {
    try {
      if (statSync(join(root, name)).isDirectory() && !NEVER_TOP.has(name) && !name.startsWith('.')) out.add(name);
    } catch { /* unreadable entry: not a claim root */ }
  }
  dirCache.set(root, out);
  return out;
}

/**
 * Classify a token as a repo path claim: 'skip' (not repo-shaped), 'ok'
 * (resolves under one of `bases`), or 'missing'. A token is repo-shaped
 * when its first segment is a real top-level directory (or `.`/`..` for
 * document-relative paths), so foreign paths (`sessions/`,
 * `squashfs-root/…`, other repos) never mint claims.
 */
export function pathStatus(token, { root, bases, dirs }) {
  const t = cleanToken(token);
  if (!t.includes('/') || /\s/.test(t)) return 'skip';
  if (/^[a-zA-Z][\w+.-]*:/.test(t)) return 'skip'; // scheme or drive letter
  if (/^[~%$#*]/.test(t) || t.startsWith('/') || t.includes('\\')) return 'skip';
  if (/[*?[\]{}()<>]/.test(t)) return 'skip'; // glob or template
  if (/^\.[^./]/.test(t)) return 'skip'; // hidden name like .obsidian/
  const first = t.split('/')[0];
  const relative = first === '.' || first === '..';
  if (!relative && !dirs.has(first)) return 'skip';
  const wantDir = /\/+\s*$/.test(t);
  const probe = t.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  if (probe === '' || claimExempt(probe)) return 'skip';
  for (const base of bases) {
    const abs = resolve(base, probe);
    if (!insideRoot(root, abs) || !existsSync(abs)) continue;
    if (wantDir && !statSync(abs).isDirectory()) continue;
    return 'ok';
  }
  return 'missing';
}

// Fence info strings whose contents can be shell: `cd` only moves the
// resolution base inside these.
const SHELL_FENCE = new Set(['', 'bash', 'sh', 'zsh', 'fish', 'shell', 'console', 'terminal', 'text', 'plaintext']);

/**
 * Inferred path claims in `src`: `[{ line, token, status }]` for repo-shaped
 * tokens in inline code and fenced blocks, status 'ok' or 'missing' (tokens
 * that are not repo-shaped are not returned). `cd` inside a shell fence
 * moves the resolution base; each fence starts back at the repo root.
 */
export function pathClaims(src, file, root = ROOT) {
  const docDir = dirname(resolve(root, file));
  const dirs = rootDirs(root);
  const out = [];
  let cwd = root;
  let shell = false;
  for (const { line, text, fence } of codeLines(src)) {
    if (fence === 'open') {
      cwd = root;
      const info = /^ {0,3}(?:`{3,}|~{3,})[ \t]*([\w-]*)/.exec(stripContainers(text));
      shell = SHELL_FENCE.has(info?.[1] ?? '');
      continue;
    }
    if (fence === 'close') continue;
    const texts = fence === 'code' ? [text] : inlineSpans(text);
    if (fence === 'code' && shell) {
      const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|$)/.exec(text);
      if (cd) {
        const target = cleanToken(cd[1].replace(/^['"]|['"]$/g, ''));
        const abs = resolve(cwd, target);
        if (insideRoot(root, abs) && existsSync(abs)) cwd = abs;
      }
    }
    const bases = fence === 'code' ? [cwd, docDir, root] : [docDir, root];
    for (const t of texts) {
      for (const token of codeTokens(t)) {
        const status = pathStatus(token, { root, bases, dirs });
        if (status !== 'skip') out.push({ line, token: cleanToken(token), status });
      }
    }
  }
  return out;
}

// ── Claim checking ───────────────────────────────────────────────────────────

function readRoot(root, p) {
  const abs = claimPath(root, p);
  if (!abs) return { abs: null, missing: `bad path ${JSON.stringify(p)}` };
  if (!existsSync(abs)) return { abs, missing: `no such path ${p}` };
  return { abs, missing: null };
}

/** Resolve one parsed claim against the repo; returns problem strings. */
export function checkClaim(root, claim, sec, lines) {
  const at = `doclive:${claim.probe} ${claim.path}${claim.symbol ? `#${claim.symbol}` : ''}`;
  const { abs, missing } = readRoot(root, claim.path);
  if (missing) return [`${at}: ${missing}`];
  if (claim.probe === 'exists') return [];
  const src = readFileSync(abs, 'utf8');
  const problems = [];
  if (claim.symbol && !symbolDefined(src, claim.symbol, claim.path)) {
    problems.push(`${at}: symbol \`${claim.symbol}\` is not defined in ${claim.path}`);
  }
  if (claim.probe === 'contains') {
    claim.codeRe.lastIndex = 0; // /g regexes are stateful across .test calls
    if (!claim.codeRe.test(src)) problems.push(`${at}: ${claim.codeRe} does not match ${claim.path}`);
  } else if (claim.probe === 'seq' || claim.probe === 'set') {
    const codeItems = regexItems(src, claim.codeRe);
    const docItems = regexItems(sectionText(lines, sec), claim.docRe);
    const diff = claim.probe === 'seq' ? seqDiff(codeItems, docItems) : setDiff(codeItems, docItems);
    if (diff) problems.push(`${at}: ${diff}`);
  }
  return problems;
}

function seqDiff(a, b) {
  if (a.length !== b.length) return `ordered lists differ: code has ${a.length} items, section has ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return `ordered lists differ at item ${i + 1}: code "${a[i]}", section "${b[i]}"`;
  }
  return null;
}

function setDiff(a, b) {
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const ca = count(a);
  const cb = count(b);
  const onlyCode = [...ca].filter(([x, n]) => (cb.get(x) ?? 0) < n).map(([x]) => x);
  const onlyDoc = [...cb].filter(([x, n]) => (ca.get(x) ?? 0) < n).map(([x]) => x);
  if (!onlyCode.length && !onlyDoc.length) return null;
  const fmt = (xs) => xs.slice(0, 5).map((x) => `"${x}"`).join(', ') + (xs.length > 5 ? `, +${xs.length - 5} more` : '');
  return `item sets differ: only in code: [${fmt(onlyCode)}]; only in section: [${fmt(onlyDoc)}]`;
}

/**
 * All claim problems under `root`: `[{ file, line, section, claim, reason }]`.
 * Declared claims that fail to parse are reported at their own line.
 */
export function checkClaims(root = ROOT) {
  const problems = [];
  let claims = 0;
  const files = watchedFiles(root);
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const secs = sections(src);
    const push = (line, claim, reason) => {
      const sec = sectionAt(secs, line);
      problems.push({ file: rel, line, section: sec.path, claim, reason });
    };
    for (const { line, spec } of declaredClaims(src)) {
      claims++;
      let claim;
      try {
        claim = parseClaim(spec);
      } catch (error) {
        push(line, `doclive: ${spec}`, error.message);
        continue;
      }
      for (const reason of checkClaim(root, claim, sectionAt(secs, line), lines)) {
        push(line, `doclive: ${spec}`, reason);
      }
    }
    for (const { line, token, status } of pathClaims(src, rel, root)) {
      claims++;
      if (status === 'missing') push(line, `path \`${token}\``, 'no such file or directory');
    }
  }
  return { ok: problems.length === 0, claims, files: files.length, problems };
}

// ── Watched files ────────────────────────────────────────────────────────────

/** The docs `WATCHED` resolves to, sorted, absolute. */
export function watchedFiles(root = ROOT) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.')) continue;
      const p = join(abs, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!NEVER_TOP.has(name)) walk(p);
      } else if (MARKDOWN.test(name) || name === 'llms.txt' || name === 'llms-full.txt') {
        out.push(p);
      }
    }
  };
  for (const entry of WATCHED) {
    const abs = resolve(root, entry);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) walk(abs);
    else out.push(abs);
  }
  return [...new Set(out)].sort();
}

// ── Regeneration blocks ──────────────────────────────────────────────────────

/** Blocks that must appear exactly once in their file. */
export const REQUIRED_BLOCKS = {
  'docs/README.md': 'docs-index',
  'docs/AGENTS.md': 'mcp-events',
};

/** First `# heading` outside code/front matter/comments, as plain text. */
function firstHeading(src) {
  const masked = maskCode(src);
  const lines = src.split('\n');
  let off = 0;
  for (const l of lines) {
    const start = off;
    off += l.length + 1;
    if (masked[start]) continue;
    const m = /^ {0,3}# (.+?)[ \t]*$/.exec(l);
    if (m) return plainHeading(m[1]);
  }
  return null;
}

function posixLink(fromFile, toFile) {
  let rel = relative(dirname(fromFile), toFile).split(sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/**
 * `docs-index`: `- [title](path)` for every Markdown file under docs/,
 * except the file holding the block. Titles come from each file's first
 * heading, falling back to the file name.
 */
export function renderDocsIndex(root, containingFile) {
  const docsDir = join(root, 'docs');
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (MARKDOWN.test(name)) files.push(p);
    }
  };
  walk(docsDir);
  files.sort();
  const self = resolve(containingFile);
  const lines = [];
  for (const f of files) {
    if (resolve(f) === self) continue;
    const src = readFileSync(f, 'utf8');
    const title = (firstHeading(src) ?? f.split(sep).pop().replace(/\.[^.]+$/, ''))
      .replace(/[[\]]/g, '');
    lines.push(`- [${title}](${posixLink(self, f)})`);
  }
  return lines.join('\n');
}

/**
 * `mcp-events`: the frontend MCP event table, rows in src/mcp/bridge.ts
 * wiring order (the order handlers are pushed onto `unlisteners`), events
 * in each handler file's listen order.
 */
export function renderMcpEvents(root) {
  const bridge = readFileSync(join(root, 'src/mcp/bridge.ts'), 'utf8');
  const handlerFile = new Map();
  for (const m of bridge.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/handlers\/([\w-]+)["']/g)) {
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      handlerFile.set(name, `${m[2]}.ts`);
    }
  }
  const fileOrder = [];
  for (const m of bridge.matchAll(/unlisteners\.push\(\s*(handle\w+)/g)) {
    const file = handlerFile.get(m[1]);
    if (file && !fileOrder.includes(file)) fileOrder.push(file);
  }
  const rows = [];
  for (const file of fileOrder) {
    const src = readFileSync(join(root, 'src/mcp/handlers', file), 'utf8');
    for (const m of src.matchAll(/listen<[^>]*>\("(mcp:\/\/[^"]+)"/g)) {
      rows.push(`| \`${m[1]}\` | \`${file}\` |`);
    }
  }
  return ['| Event | Handler module |', '|---|---|', ...rows].join('\n');
}

/** Render one named block for the file at `absPath`. */
export function renderBlock(root, name, absPath) {
  if (name === 'docs-index') return renderDocsIndex(root, absPath);
  if (name === 'mcp-events') return renderMcpEvents(root);
  throw new Error(`unknown doclive block ${name}`);
}

/**
 * Rewrite `<!-- doclive:begin name -->` … `<!-- doclive:end -->` regions of
 * `content` via `render(name)`. Same marker discipline as freshness:
 * unknown names, malformed markers, unbalanced or nested blocks throw.
 * `required` maps a repo-relative path to the block name it must hold once.
 */
export function regenerate(content, render, path, required) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  // Markers inside fenced code are documentation examples, not real blocks.
  const fenced = new Set();
  for (const { line, fence } of codeLines(content)) {
    if (fence) fenced.add(line);
  }
  const output = [];
  const found = [];
  let active;
  for (const [i, line] of lines.entries()) {
    if (fenced.has(i + 1)) {
      if (!active) output.push(line);
      continue;
    }
    const begin = BLOCK_BEGIN.exec(line);
    const end = line === BLOCK_END;
    if (begin) {
      if (active) throw new Error(`${path}: nested doclive block`);
      active = begin[1];
      found.push(active);
      output.push(line, render(active));
    } else if (end) {
      if (!active) throw new Error(`${path}: unmatched doclive end`);
      active = undefined;
      output.push(line);
    } else {
      // Whole-line claim comments are legal prose; anything else holding
      // `doclive:` is a malformed marker (claims must be alone on a line).
      if (line.includes('<!-- doclive:') && !CLAIM_RE.test(line)) {
        throw new Error(`${path}: malformed doclive marker`);
      }
      if (!active) output.push(line);
    }
  }
  if (active) throw new Error(`${path}: unclosed doclive block`);
  const need = required?.[path];
  if (need && found.filter((n) => n === need).length !== 1) {
    throw new Error(`${path}: expected exactly one ${need} doclive block`);
  }
  return output.join('\n').replaceAll('\n', newline);
}

/**
 * Sync pass over the watched docs: `{ changed, problems, ok }`. `changed`
 * lists repo-relative paths whose blocks differ from the render (written
 * only when `write` is true); `problems` collects marker/render errors.
 */
export function syncBlocks(root = ROOT, { write = true } = {}) {
  const changed = [];
  const problems = [];
  for (const file of watchedFiles(root)) {
    const rel = relative(root, file).split(sep).join('/');
    const before = readFileSync(file, 'utf8');
    let after;
    try {
      after = regenerate(before, (name) => renderBlock(root, name, file), rel, REQUIRED_BLOCKS);
    } catch (error) {
      problems.push({ file: rel, reason: error.message });
      continue;
    }
    if (after !== before) {
      changed.push(rel);
      if (write) writeFileSync(file, after);
    }
  }
  return { changed, problems, ok: problems.length === 0 };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function reportClaims(result) {
  const { claims, files, problems } = result;
  console.log(`doclive: ${claims} claims across ${files} docs, ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
  for (const p of problems) {
    console.log(`  ${p.file}:${p.line} § ${p.section}`);
    console.log(`    ${p.claim}`);
    console.log(`    ${p.reason}`);
  }
}

/** `check`: claims + block freshness, read-only. `sync`: rewrite blocks, then check claims. */
export function cli(mode = 'check', argv = process.argv.slice(2)) {
  const root = ROOT;
  const json = argv.includes('--json');
  const blocks = syncBlocks(root, { write: mode === 'sync' });
  const claims = checkClaims(root);
  const drift = mode === 'check' ? blocks.changed : [];
  const ok = claims.ok && blocks.ok && drift.length === 0;
  if (json) {
    console.log(JSON.stringify({
      mode,
      ok,
      claims: { total: claims.claims, files: claims.files, problems: claims.problems },
      blocks: { changed: blocks.changed, drift, problems: blocks.problems },
    }, null, 2));
  } else {
    reportClaims(claims);
    if (mode === 'sync') {
      console.log(`doclive: sync rewrote ${blocks.changed.length} file${blocks.changed.length === 1 ? '' : 's'}${blocks.changed.length ? ` (${blocks.changed.join(', ')})` : ''}.`);
    } else if (drift.length) {
      console.log(`doclive: generated blocks are stale in ${drift.join(', ')}. Run bun run doclive:sync.`);
    } else {
      console.log('doclive: generated blocks are fresh.');
    }
    for (const p of blocks.problems) console.log(`  ${p.file}: ${p.reason}`);
  }
  process.exitCode = ok ? 0 : 1;
}

function realpathSyncSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

if (process.argv[1] && realpathSyncSafe(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli('check');
}
