#!/usr/bin/env node
// Flags relative Markdown links in the repo's Markdown docs (README.md,
// AGENTS.md, docs/, integrations/, landing/, samples/, ...) that point nowhere:
// a [text](path) or ![alt](src) outside code whose file is missing, and a
// #fragment that names no heading of the target page. Fragments are matched
// against GitHub-style slugs (what rehype-slug + github-slugger write as
// heading ids, here and in the app's read view): lowercased, punctuation but
// `_` and `-` dropped, spaces as hyphens, repeats suffixed -1, -2. Light on
// purpose: a scanner, not a parser.
// Links and headings inside fenced code, inline code spans, HTML comments and a
// leading front matter block are skipped; indented code is not tracked.
// `node_modules`, `target`, `dist` and `__fixtures__` directories and
// dot-directories are not scanned (test fixtures are renderer input, not docs,
// and may contain intentionally broken links). Pass directories as arguments
// to narrow the scan (default: the whole repository, `.`); pass `--external`
// to also check remote http(s) targets with a HEAD request (GET fallback) —
// remote checking is opt-in because it needs the network.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/; // http:, mailto:, tel:, data:, ...
const MARKDOWN = /\.(md|markdown|mdown|mkd|mdx)$/i;
// A line that ends a paragraph by starting a block of its own: an ATX
// heading, a blockquote, a list item (any bullet marker interrupts a
// paragraph; of the ordered markers only `1.`/`1)` does) or a setext
// underline / thematic break (`===`, `---`, `***`, `___`, 3+ of a kind).
const BLOCK_START =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-+*][ \t]|1[.)][ \t]|([*_=-])(?:[ \t]*\1){2,}[ \t]*$)/;

/** `s` percent-decoded, or as written when it is not valid encoding. */
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * `line` without its leading container marks (blockquotes and list items), so
 * `- ````js` ` and `> ````js` ` still open a fence. Deeper structures are not
 * unwrapped past their markers.
 */
export function stripContainers(line) {
  let body = line;
  for (;;) {
    const s = body
      .replace(/^ {0,3}> ?/, '')
      .replace(/^ {0,3}(?:[-*+]|\d+[.)])[ \t]+/, '');
    if (s === body) return body;
    body = s;
  }
}

/**
 * Which characters of `src` a link or a heading cannot start in: fenced code
 * blocks, a leading `---` front matter block, inline code spans (a run of n
 * backticks closed by another run of n; an unmatched run is literal) and HTML
 * comments. Positions keep their source offsets so line numbers still hold.
 */
export function maskCode(src) {
  const masked = new Uint8Array(src.length);
  const lines = src.split('\n');
  const starts = [0];
  let off = 0;
  for (const l of lines) {
    off += l.length + 1;
    starts.push(off);
  }
  const maskLine = (i) => masked.fill(1, starts[i], starts[i + 1] - 1);
  // Front matter: `---` on line 1, closed by `---` or `...`, only when closed.
  let from = 0;
  if (lines[0] === '---') {
    const end = lines.findIndex((l, i) => i > 0 && (l === '---' || l === '...'));
    if (end > 0) {
      for (let i = 0; i <= end; i++) maskLine(i);
      from = end + 1;
    }
  }
  let fence = null;
  for (let i = from; i < lines.length; i++) {
    const body = stripContainers(lines[i]);
    if (fence) {
      maskLine(i);
      if (new RegExp(`^ {0,3}${fence.ch}{${fence.len},}[ \t]*$`).test(body)) fence = null;
      continue;
    }
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(body);
    // An info string on a ``` fence cannot itself contain a backtick.
    if (m && !(m[1][0] === '`' && body.slice(m[0].length).includes('`'))) {
      fence = { ch: m[1][0], len: m[1].length };
      maskLine(i);
    }
  }
  // Inline code spans over what is left.
  let i = 0;
  while (i < src.length) {
    if (masked[i] || src[i] !== '`') {
      i++;
      continue;
    }
    let n = 0;
    while (src[i + n] === '`') n++;
    let j = i + n;
    let found = -1;
    while (j < src.length) {
      // A code span ends with its paragraph: it cannot reach a blank line,
      // an already masked block, or a line that starts a new block (a heading,
      // a quote, a list item, a setext underline or thematic break).
      if (masked[j]) break;
      if (src[j] === '\n') {
        const nl = src.indexOf('\n', j + 1);
        const next = src.slice(j + 1, nl < 0 ? src.length : nl);
        if (BLOCK_START.test(next) || /^[ \t]*$/.test(next)) break;
      }
      if (src[j] === '`') {
        let m = 0;
        while (src[j + m] === '`') m++;
        if (m === n) {
          found = j + m;
          break;
        }
        j += m;
      } else j++;
    }
    if (found < 0) {
      i += n; // an unmatched run is literal text, not a code span
      continue;
    }
    masked.fill(1, i, found);
    i = found;
  }
  // HTML comments.
  for (let s = src.indexOf('<!--'); s >= 0; ) {
    const e = src.indexOf('-->', s + 4);
    if (e < 0) break;
    masked.fill(1, s, e + 3);
    s = src.indexOf('<!--', e + 3);
  }
  return masked;
}

/**
 * The inline link and image destinations of `src` with `masked` positions
 * skipped: `[t](dest)`, `[t](<dest with spaces>)`, `[t](dest "title")` and
 * reference definitions `[t]: dest` (footnotes `[^n]:` are not links). A label
 * may run over line breaks, as in CommonMark; `[t](a b)` is no link, since a
 * bare `b` is no destination and no title. Each hit carries a 1-based line.
 */
export function linkTargets(src, masked = maskCode(src)) {
  const links = [];
  const lineOf = (at) => {
    let line = 1;
    for (let k = src.indexOf('\n'); k >= 0 && k < at; k = src.indexOf('\n', k + 1)) line++;
    return line;
  };
  let i = -1;
  while ((i = src.indexOf('](', i + 1)) !== -1) {
    if (masked[i] || masked[i + 1]) continue;
    // The `[` that opened this `]`, over nested balanced brackets.
    let depth = 0;
    let open = -1;
    for (let k = i - 1; k >= 0; k--) {
      if (masked[k]) continue;
      if (src[k] === ']') depth++;
      else if (src[k] === '[') {
        if (depth === 0) {
          open = k;
          break;
        }
        depth--;
      }
    }
    if (open < 0) continue;
    let j = i + 2;
    while (/[ \t\n]/.test(src[j] ?? '')) j++;
    let dest;
    if (src[j] === '<') {
      const gt = src.indexOf('>', j);
      if (gt < 0) continue;
      dest = src.slice(j + 1, gt);
      j = gt + 1;
    } else {
      const start = j;
      let parens = 0;
      while (j < src.length && !masked[j]) {
        const c = src[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '(') parens++;
        else if (c === ')') {
          if (parens === 0) break;
          parens--;
        } else if (/[ \t\n]/.test(c)) break;
        j++;
      }
      dest = src.slice(start, j).replace(/\\(.)/g, '$1');
    }
    // An optional "title" / 'title' / (title) then the closing paren.
    let k = j;
    while (/[ \t\n]/.test(src[k] ?? '')) k++;
    if (src[k] === '"' || src[k] === "'" || src[k] === '(') {
      const close = src[k] === '(' ? ')' : src[k];
      const end = src.indexOf(close, k + 1);
      if (end < 0) continue;
      k = end + 1;
      while (/[ \t\n]/.test(src[k] ?? '')) k++;
    }
    if (src[k] !== ')') continue;
    links.push({ dest, line: lineOf(i) });
    i = k;
  }
  // Reference definitions: `[label]: dest` outside code.
  let pos = 0;
  for (const l of src.split('\n')) {
    const m = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]*>|\S+)/.exec(l);
    if (m && !m[1].startsWith('^') && !masked[pos]) {
      const d = m[2];
      links.push({ dest: d.startsWith('<') ? d.slice(1, -1) : d, line: lineOf(pos) });
    }
    pos += l.length + 1;
  }
  return links;
}

/**
 * The heading text GitHub/rehype-slug turns into an id: a code span reads as
 * its content, a link as its text, an image as nothing, emphasis marks off.
 * `_` is kept: an intraword underscore is literal in CommonMark and stays in
 * the slug, as in `export_metadata`.
 */
function headingText(raw) {
  return raw
    .replace(/[ \t]+#+[ \t]*$/, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/!\[(?:\\.|[^\]\\])*\]\([^)]*\)/g, '')
    .replace(/\[(?:\\.|[^\]\\])*\]\([^)]*\)/g, (m) => m.slice(1, m.indexOf('](')))
    .replace(/\*\*?|~~|~/g, '')
    .trim();
}

/** The GitHub slug of already-flattened heading `text`. */
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\p{Pd} ]/gu, '')
    .replace(/ /g, '-');
}

/**
 * The slugs a page's `#fragment` anchors can name: every ATX heading (in a
 * blockquote or a list item too, since rehype-slug gives those an id) and every
 * setext heading after a paragraph line, deduplicated `-1`, `-2` as
 * github-slugger does. Lines `maskCode` hides are skipped.
 */
export function headingSlugs(src, masked = maskCode(src)) {
  const slugs = new Set();
  const seen = new Map();
  const add = (text) => {
    const base = slug(headingText(text));
    if (base === '') return;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  };
  const lines = src.split('\n');
  let off = 0;
  let prev = '';
  let prevLive = false;
  for (const l of lines) {
    const start = off;
    off += l.length + 1;
    if (masked[start]) {
      prevLive = false;
      prev = '';
      continue;
    }
    const body = stripContainers(l);
    const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*$)/.exec(body);
    if (m) {
      add(m[2] ?? '');
      prevLive = false;
      prev = '';
      continue;
    }
    // Setext: `===`/`---` under a paragraph line is h1/h2; the same marks
    // after anything else are a thematic break.
    if (/^ {0,3}=+[ \t]*$/.test(l) || /^ {0,3}-+[ \t]*$/.test(l)) {
      if (prevLive) {
        const p = stripContainers(prev).trim();
        if (p !== '' && !/^([*_-][ \t]*){3,}$/.test(p)) add(p);
      }
      prevLive = false;
      prev = '';
      continue;
    }
    prevLive = l.trim() !== '';
    prev = l;
  }
  return slugs;
}

/** The `.md` files under each of `dirs` (relative to `root`), sorted. An entry
 * that is itself a Markdown file is taken as a file, not walked as a
 * directory. */
export function docFiles(root, dirs) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!name.startsWith('.') && name !== 'node_modules' && name !== 'target' && name !== 'dist' && name !== '__fixtures__') walk(p);
        continue;
      }
      if (MARKDOWN.test(name)) out.push(p);
    }
  };
  for (const d of dirs) {
    const abs = resolve(root, d);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) walk(abs);
    else if (MARKDOWN.test(abs)) out.push(abs);
  }
  return out.sort();
}

/**
 * The reason `dest` is broken from the document at `file`, or null. Only
 * fragments of Markdown targets are checked (a code file's `#L10` and a
 * folder page's `#readme` are fine); `slugsFor` caches each file's slug set.
 */
function checkLink(root, file, dest, slugsFor) {
  const d = dest.trim();
  if (d === '') return 'empty destination';
  if (SCHEME.test(d) || d.startsWith('//')) return null; // external: out of scope
  const hash = d.indexOf('#');
  const frag = hash < 0 ? null : decode(d.slice(hash + 1));
  let path = hash < 0 ? d : d.slice(0, hash);
  const query = path.indexOf('?');
  if (query >= 0) path = path.slice(0, query);
  const relPath = decode(path);
  const abs = resolve(dirname(file), relPath);
  if (relPath === '') return checkFrag(frag, slugsFor(file), file, root);
  if (!existsSync(abs)) return `no such file ${relative(root, abs).split(sep).join('/')}`;
  const st = statSync(abs);
  if (st.isDirectory()) {
    if (frag && !/^readme/i.test(frag)) return `a folder page has no #${frag} anchor`;
    return null;
  }
  if (!MARKDOWN.test(abs)) return null;
  return checkFrag(frag, slugsFor(abs), abs, root);
}

function checkFrag(frag, slugs, target, root) {
  if (frag === null || frag === '') return null;
  if (slugs.has(frag) || slugs.has(frag.replace(/^user-content-/, ''))) return null;
  const rel = relative(root, target).split(sep).join('/');
  return `no heading slugs to '#${frag}' in ${rel}`;
}

/**
 * The broken relative links under `root`'s `dirs` (default `docs/`), with the
 * count checked and the unique remote targets seen:
 * `{ broken: [{ file, line, dest, reason }], checked, files,
 *   external: [{ url, file, line }] }`. `external` collects each http(s)
 * destination once, at its first sighting, for `checkExternal` to probe.
 */
export function scan(root, { dirs = ['docs'] } = {}) {
  const cache = new Map();
  const slugsFor = (abs) => {
    if (!cache.has(abs)) cache.set(abs, headingSlugs(readFileSync(abs, 'utf8')));
    return cache.get(abs);
  };
  const files = docFiles(root, dirs);
  const broken = [];
  const externalSeen = new Map();
  let checked = 0;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(root, file).split(sep).join('/');
    const seen = new Set();
    for (const { dest, line } of linkTargets(src)) {
      checked++;
      const key = `${line} ${dest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const trimmed = dest.trim();
      if (/^https?:\/\//i.test(trimmed) && !externalSeen.has(trimmed))
        externalSeen.set(trimmed, { file: rel, line });
      const reason = checkLink(root, file, dest, slugsFor);
      if (reason) broken.push({ file: rel, line, dest, reason });
    }
  }
  return {
    broken,
    checked,
    files: files.length,
    external: [...externalSeen].map(([url, at]) => ({ url, ...at })),
  };
}

/**
 * A reason `url` is unreachable, or null when a request to it comes back under
 * `status < 400`. `HEAD` is tried first and `GET` once after it, so a server
 * that refuses or mishandles HEAD still passes when GET answers; the last
 * failure is reported.
 */
async function probe(url, timeout) {
  let last = null;
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      res.body?.cancel();
      if (res.status < 400) return null;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last =
        e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? `timed out after ${timeout} ms`
          : String(e?.cause?.code ?? e?.message ?? e);
    }
  }
  return last;
}

/**
 * `{url, file, line, reason}` for each collected external URL that did not
 * answer under 400, probed `concurrency` at a time.
 */
export async function checkExternal(external, { timeout = 15000, concurrency = 8 } = {}) {
  const failed = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, external.length) }, async () => {
      while (i < external.length) {
        const item = external[i++];
        const reason = await probe(item.url, timeout);
        if (reason !== null) failed.push({ ...item, reason });
      }
    }),
  );
  return failed;
}

export function report({ broken, checked, files }, dirs = ['docs']) {
  const lines = [
    `relative links in ${dirs.join(', ')}: ${files} file(s), ${checked} link(s) checked, ${broken.length} broken`,
  ];
  for (const b of broken) lines.push(`  BROKEN ${b.file}:${b.line}: (${b.dest}) - ${b.reason}`);
  return { text: lines.join('\n'), failed: broken.length > 0 };
}

/**
 * Exit code of the full check over `root`'s `dirs` (default `['.']`, the whole
 * repository). With `external`, remote http(s) targets are probed too.
 */
export async function main(root, { dirs = ['.'], external = false } = {}) {
  const result = scan(root, { dirs });
  const { text, failed } = report(result, dirs);
  console.log(text);
  if (failed)
    console.error(
      'Fix the path, or point #fragment at a heading of the target (its GitHub-style slug).',
    );
  if (!external) return failed ? 1 : 0;
  const failures = await checkExternal(result.external);
  console.log(
    `external links: ${result.external.length} unique remote URL(s), ${failures.length} broken`,
  );
  for (const f of failures)
    console.log(`  BROKEN ${f.url} - ${f.reason} (first seen ${f.file}:${f.line})`);
  if (failures.length > 0) {
    console.error('A remote URL must answer under 400; fix or update the target.');
    return 1;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  const args = process.argv.slice(2);
  const external = args.includes('--external');
  const dirs = args.filter((a) => a !== '--external');
  main(root, { dirs: dirs.length ? dirs : ['.'], external }).then((code) =>
    process.exit(code),
  );
}
