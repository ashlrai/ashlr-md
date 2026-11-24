import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetSuffix, pickAsset } from './release-asset.mjs';

const assets = [
  'Ashlr_MD_0.7.5_aarch64.dmg',
  'Ashlr_MD_0.7.5_amd64.AppImage',
  'Ashlr_MD_0.7.5_amd64.deb',
  'Ashlr_MD_0.7.5_x64-setup.exe',
  'Ashlr_MD_0.7.5_x64-setup.exe.sig',
  'Ashlr_MD_0.7.5_x64.dmg',
  'Ashlr_MD_0.7.5_x64_en-US.msi',
].map((name) => ({ name, browser_download_url: `https://example.invalid/${name}` }));

test('each OS picks the documented installer and ignores signatures', () => {
  assert.equal(assetSuffix('linux', 'x64'), '_amd64.deb');
  assert.equal(assetSuffix('win32', 'x64'), '_x64-setup.exe');
  assert.equal(assetSuffix('darwin', 'arm64'), '_aarch64.dmg');
  assert.equal(assetSuffix('darwin', 'x64'), '_x64.dmg');
  assert.equal(pickAsset(assets, 'linux', 'x64').name, 'Ashlr_MD_0.7.5_amd64.deb');
  assert.equal(pickAsset(assets, 'win32', 'x64').name, 'Ashlr_MD_0.7.5_x64-setup.exe');
  assert.equal(pickAsset(assets, 'darwin', 'arm64').name, 'Ashlr_MD_0.7.5_aarch64.dmg');
});

test('a missing documented asset fails instead of guessing another package', () => {
  assert.throws(() => pickAsset(assets.filter((asset) => !asset.name.endsWith('.deb')), 'linux', 'x64'), /expected one _amd64\.deb/);
});
