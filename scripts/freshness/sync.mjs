import { readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const releaseUrl = 'https://github.com/ashlrai/ashlr-md/releases/tag/v';

export async function sources(directory) {
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const tauri = JSON.parse(await readFile(resolve(directory, 'src-tauri/tauri.conf.json'), 'utf8'));
  const changelog = await readFile(resolve(directory, 'CHANGELOG.md'), 'utf8');
  const releases = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+(?:-[\w.-]+)?)\][^\n]*?(\d{4}-\d{2}-\d{2})\s*$/gm)];
  if (!releases.length) throw new Error('CHANGELOG.md has no dated release section');
  const sourceVersion = releases[0][1];
  if (pkg.version !== sourceVersion || tauri.version !== sourceVersion) {
    throw new Error('Release versions disagree: package.json, tauri.conf.json and latest dated changelog release must match');
  }
  // This reviewed receipt advances only after publication is independently
  // verified. A dated source candidate alone is not publication evidence.
  const publishedVersion = JSON.parse(await readFile(resolve(directory, 'scripts/freshness/published.json'), 'utf8')).version;
  if (typeof publishedVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(publishedVersion)) {
    throw new Error('Invalid published release version');
  }
  const published = releases.filter((entry) => entry[1] === publishedVersion);
  if (published.length !== 1) throw new Error('Published release needs exactly one dated changelog entry');
  return { sourceVersion, publishedVersion, publishedDate: published[0][2] };
}

export function blocks({ publishedVersion: version, publishedDate: date }) {
  const url = `${releaseUrl}${version}`;
  return {
    'version-badge': `[![Release: ${version}](https://img.shields.io/badge/release-${version}-0969da.svg)](${url})`,
    'install-snippet': `Download the desired release from [Releases](https://github.com/ashlrai/ashlr-md/releases/latest), replace \`X.Y.Z\` with that download's version, then run the Windows silent installer:\n\n\`\`\`bat\nAshlr_MD_X.Y.Z_x64-setup.exe /S\n\`\`\``,
    'version-table': `| Component | Released version |\n|---|---|\n| Desktop app | ${version} |\n| CLI and MCP sidecars (bundled) | ${version} |\n\nReleased ${date}. [Release notes and downloads](${url}).`,
    'example-release-page': `Example release page for automation (resolve and verify the matching artifact before installing):\n\n\`\`\`sh\nASHLR_MD_RELEASE='https://github.com/ashlrai/ashlr-md/releases/latest'\n\`\`\``,
    'site-download': `            <a class="btn btn-primary" href="${url}">\n              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v13m0 0-4-4m4 4 4-4M3 21h18" stroke-linecap="round" stroke-linejoin="round"/></svg>\n              Download: macOS · Windows · Linux\n            </a>`,
  };
}

async function markdown(directory, relative) {
  const result = [];
  for (const entry of await readdir(resolve(directory, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await markdown(directory, path));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(path);
  }
  return result;
}

export function regenerate(content, templates, path) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const output = [];
  let active;
  for (const line of lines) {
    const begin = /^<!-- fresh:begin ([a-z-]+) -->$/.exec(line);
    const end = line === '<!-- fresh:end -->';
    if (begin) {
      if (active) throw new Error(`${path}: nested freshness block`);
      active = begin[1];
      if (!Object.hasOwn(templates, active)) throw new Error(`${path}: unknown freshness block ${active}`);
      output.push(line, templates[active]);
    } else if (end) {
      if (!active) throw new Error(`${path}: unmatched freshness end`);
      active = undefined;
      output.push(line);
    } else {
      if (line.includes('<!-- fresh:')) throw new Error(`${path}: malformed freshness marker`);
      if (!active) output.push(line);
    }
  }
  if (active) throw new Error(`${path}: unclosed freshness block`);
  return output.join('\n').replaceAll('\n', newline);
}

export async function run(directory = root, check = false) {
  const templates = blocks(await sources(directory));
  const paths = ['README.md', 'CHANGELOG.md', 'landing/index.html', ...await markdown(directory, 'docs'), ...await markdown(directory, 'samples')].sort((a, b) => a < b ? -1 : Number(a > b));
  const changes = [];
  // Validate every file before writing any changes.
  for (const path of paths) {
    const before = await readFile(resolve(directory, path), 'utf8');
    const after = regenerate(before, templates, path);
    if (after !== before) changes.push({ path, after });
  }
  if (!check) {
    for (const { path, after } of changes) await writeFile(resolve(directory, path), after);
  }
  return changes.map(({ path }) => path);
}

export async function cli(check) {
  try {
    const changes = await run(root, check);
    if (check && changes.length) {
      console.error(`Freshness drift: ${changes.join(', ')}. Run bun run fresh:sync.`);
      process.exitCode = 1;
    } else console.log(`Freshness ${check ? 'checked' : 'synced'} (${changes.length} changed files).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) await cli(false);
