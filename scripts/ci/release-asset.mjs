#!/usr/bin/env node
// Download the latest published release asset for this runner.
// The version is whatever GitHub reports as latest. The suffix is the
// filename INSTALL.md documents for that OS (.deb, NSIS setup, DMG).
import { createWriteStream } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function assetSuffix(platform, arch) {
  if (platform === 'linux') return '_amd64.deb';
  if (platform === 'win32') return '_x64-setup.exe';
  if (platform === 'darwin') return arch === 'arm64' ? '_aarch64.dmg' : '_x64.dmg';
  throw new Error(`no documented installer for ${platform}`);
}

export function pickAsset(assets, platform, arch) {
  const suffix = assetSuffix(platform, arch);
  const matches = assets.filter((asset) => asset.name.endsWith(suffix) && !asset.name.endsWith('.sig'));
  if (matches.length !== 1) {
    const found = matches.map((asset) => asset.name).join(', ') || 'none';
    throw new Error(`expected one ${suffix} asset in the latest release, found ${found}`);
  }
  return matches[0];
}

function output(key, value) {
  const line = `${key}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
}

export async function main(env = process.env, platform = process.platform, arch = process.arch) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ashlr-md-install-smoke',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!response.ok) throw new Error(`latest release lookup failed: HTTP ${response.status}`);
  const release = await response.json();
  const asset = pickAsset(release.assets ?? [], platform, arch);
  const destDir = env.RUNNER_TEMP || tmpdir();
  const dest = join(destDir, asset.name);
  const download = await fetch(asset.browser_download_url);
  if (!download.ok || !download.body) throw new Error(`asset download failed: HTTP ${download.status}`);
  await pipeline(Readable.fromWeb(download.body), createWriteStream(dest));
  process.stderr.write(`release ${release.tag_name} asset ${asset.name}\n`);
  output('asset_path', dest);
  output('release_tag', release.tag_name ?? '');
}

if (process.argv[1] && process.argv[1].endsWith('release-asset.mjs')) {
  main().catch((err) => {
    process.stderr.write(`::error::${String(err.message).replace(/\s+/g, ' ')}\n`);
    process.exit(1);
  });
}
