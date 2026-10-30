import { readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const releaseUrl = 'https://github.com/ashlrai/ashlr-md/releases/tag/v';

export async function sources(directory) {
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const tauri = JSON.parse(await readFile(resolve(directory, 'src-tauri/tauri.conf.json'), 'utf8'));
  const changelog = await readFile(resolve(directory, 'CHANGELOG.md'), 'utf8');
  const release = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+(?:-[\w.-]+)?)\][^\n]*?(\d{4}-\d{2}-\d{2})\s*$/gm)][0];
  if (!release) throw new Error('CHANGELOG.md has no dated release section');
  const version = release[1];
  if (pkg.version !== version || tauri.version !== version) {
    throw new Error('Release versions disagree: package.json, tauri.conf.json and latest dated changelog release must match');
  }
  return { version, date: release[2] };
}

export function blocks({ version, date }) {
  const url = `${releaseUrl}${version}`;
  return {
    'version-badge': `[![Release: ${version}](https://img.shields.io/badge/release-${version}-0969da.svg)](${url})`,
    'install-snippet': `Download the [v${version} release](${url}), then run the Windows silent installer:\n\n\`\`\`bat\nAshlr_MD_${version}_x64-setup.exe /S\n\`\`\``,
    'version-table': `| Component | Released version |\n|---|---|\n| Desktop app | ${version} |\n| CLI and MCP sidecars (bundled) | ${version} |\n\nReleased ${date}. [Release notes and downloads](${url}).`,
    'example-version-pin': `Example release pin for automation (update with \`bun run fresh:sync\`):\n\n\`\`\`sh\nASHLR_MD_VERSION='${version}'\nASHLR_MD_RELEASE='${url}'\n\`\`\``,
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
  const paths = ['README.md', 'CHANGELOG.md', ...await markdown(directory, 'docs'), ...await markdown(directory, 'samples')].sort((a, b) => a < b ? -1 : Number(a > b));
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
