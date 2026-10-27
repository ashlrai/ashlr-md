import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { generate, headings, resolveLinks, repository, root, site } from './generate-discovery.mjs';

const read = (path) => readFileSync(resolve(root, path), 'utf8');
const pages = readdirSync(resolve(root, 'landing'), { recursive: true }).filter((path) => path.endsWith('.html'));
const parse = (html) => {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  return new window.DOMParser().parseFromString(html, 'text/html');
};
function validatePage(html, url) {
  const doc = parse(html);
  const canonicals = doc.querySelectorAll('link[rel="canonical"]');
  assert.equal(canonicals.length, 1);
  assert.equal(canonicals[0].getAttribute('href'), url);
  assert.equal(doc.querySelectorAll('h1').length, 1);
  let previous = 0;
  for (const heading of doc.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const level = Number(heading.tagName.slice(1));
    assert.ok(level <= previous + 1, `Heading level skipped: ${heading.textContent}`);
    assert.ok(heading.textContent.trim());
    previous = level;
  }
  for (const selector of ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[property="og:image"]']) {
    assert.equal(doc.querySelectorAll(selector).length, 1);
    assert.ok(doc.querySelector(selector).getAttribute('content').trim());
  }
  assert.equal(doc.querySelector('meta[property="og:url"]').getAttribute('content'), url);
  return doc;
}

test('all landing pages have unique canonical URLs, metadata and semantic headings', () => {
  assert.ok(pages.length > 0);
  for (const page of pages) validatePage(read(`landing/${page}`), new URL(page.replace(/index\.html$/, ''), site).href);
});

test('page validation rejects duplicate canonicals, h1s and skipped headings', () => {
  const html = read('landing/index.html');
  for (const extra of ['<link rel="canonical" href="https://md.ashlr.ai/">', '<h1>Duplicate</h1>', '<h6>Skipped</h6>']) {
    assert.throws(() => validatePage(html.replace('</body>', `${extra}</body>`), site));
  }
});

test('JSON-LD describes the actual app version, license, repository and price', () => {
  const doc = parse(read('landing/index.html'));
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  assert.equal(scripts.length, 1);
  const data = JSON.parse(scripts[0].textContent);
  assert.equal(data['@context'], 'https://schema.org');
  assert.equal(data['@type'], 'SoftwareApplication');
  assert.equal(data.name, 'Ashlr MD');
  assert.equal(data.softwareVersion, JSON.parse(read('package.json')).version);
  assert.match(read('src-tauri/Cargo.toml'), new RegExp(`version = "${data.softwareVersion.replaceAll('.', '\\.')}"`));
  assert.equal(data.license, `${repository}/blob/main/LICENSE`);
  assert.match(read('LICENSE'), /^MIT License/);
  assert.equal(data.subjectOf['@type'], 'SoftwareSourceCode');
  assert.equal(data.subjectOf.codeRepository, repository);
  assert.deepEqual(data.operatingSystem, ['macOS', 'Windows', 'Linux']);
  assert.equal(data.offers.price, 0);
  assert.equal(data.offers.priceCurrency, 'USD');
  assert.match(read('landing/index.html'), /Free, open source/);
});

test('llms.txt parses into a title, summary, sections and resolvable source links', () => {
  const text = read('landing/llms.txt');
  assert.match(text, /^# Ashlr MD\n\n> .+\n/);
  assert.equal(headings(text).filter((h) => h.level === 1).length, 1);
  assert.ok(headings(text).some((h) => h.title === 'Documentation'));
  const links = [...text.matchAll(/^\s*- \[([^\]]+)\]\(([^)]+)\)(?:: .*|)\s*$/gm)];
  assert.ok(links.length > 20);
  const docs = new Set();
  for (const [, title, href] of links) {
    assert.ok(title.trim());
    const url = new URL(href);
    assert.equal(url.protocol, 'https:');
    if (href.startsWith(`${repository}/blob/main/`)) {
      const path = decodeURIComponent(url.pathname.split('/blob/main/')[1]);
      const content = read(path);
      if (url.hash) assert.ok(headings(content).some((h) => h.slug === decodeURIComponent(url.hash.slice(1))), href);
      else { assert.ok(!docs.has(path), `Duplicate canonical docs URL: ${path}`); docs.add(path); }
    } else {
      assert.equal(url.origin, new URL(site).origin);
      read(`landing${url.pathname}`);
    }
  }
  assert.deepEqual([...docs].sort(), ['README.md', ...readdirSync(resolve(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)].sort());
});

test('heading extraction ignores fenced examples and handles duplicate slugs', () => {
  assert.deepEqual(headings('# Title\n````md\n## Hidden\n```\n## Also hidden\n````\n## Hello `world`\n## Hello world\n~~~\n# Hidden\n~~~').map((h) => h.slug), ['title', 'hello-world', 'hello-world-1']);
});

test('sitemap is well-formed XML in the sitemap namespace and covers exactly the site pages', () => {
  // ElementTree rejects malformed XML; HTML DOM parsing does not.
  const urls = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
ns = '{http://www.sitemaps.org/schemas/sitemap/0.9}'
assert root.tag == ns + 'urlset'
assert all(child.tag == ns + 'url' for child in root)
assert all(len(child.findall(ns + 'loc')) == 1 for child in root)
print(json.dumps([child.find(ns + 'loc').text for child in root]))
`, resolve(root, 'landing/sitemap.xml')], { encoding: 'utf8' }));
  assert.equal(new Set(urls).size, urls.length);
  assert.deepEqual(urls.sort(), pages.map((page) => new URL(page.replace(/index\.html$/, ''), site).href).sort());
  assert.equal(read('landing/robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site}sitemap.xml\n`);
});

test('capabilities link to the same canonical docs and distinguish local interfaces from hosted services', () => {
  const data = JSON.parse(read('landing/capabilities.json'));
  assert.equal(data.version, JSON.parse(read('package.json')).version);
  assert.equal(data.license, 'MIT');
  assert.equal(data.repository, repository);
  assert.deepEqual(data.interfaces.map((item) => item.transport), ['stdio', 'command-line']);
  assert.ok(data.limitations.some((item) => item.includes('not a hosted MCP')));
  for (const doc of data.documentation) {
    assert.equal(doc.url, `${repository}/blob/main/${doc.path}`);
    assert.ok(read('landing/llms-full.txt').includes(`Canonical documentation: ${doc.url}`));
    read(doc.path);
  }
});

test('generated artifacts are current, deterministic and contain no em dashes', () => {
  assert.deepEqual(generate(), generate());
  for (const [path, expected] of generate()) {
    assert.equal(read(path), expected, `Run bun run discovery:generate to update ${path}`);
    assert.ok(!expected.includes('\u2014'), path);
  }
});


test('full-text links resolve relative to their source while fenced examples remain intact', () => {
  const source = '[Install](./INSTALL.md)\n[Section](#setup)\n```md\n[Example](./example.md)\n```';
  assert.equal(resolveLinks(source, `${repository}/blob/main/docs/AGENTS.md`),
    `[Install](${repository}/blob/main/docs/INSTALL.md)\n[Section](${repository}/blob/main/docs/AGENTS.md#setup)\n\`\`\`md\n[Example](./example.md)\n\`\`\``);
  assert.ok(read('landing/llms-full.txt').includes(`[Contributing](${repository}/blob/main/CONTRIBUTING.md)`));
});
