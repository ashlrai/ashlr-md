import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import GithubSlugger from 'github-slugger';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const site = 'https://md.ashlr.ai/';
export const repository = 'https://github.com/ashlrai/ashlr-md';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const clean = (text) => text.replaceAll('\u2014', ':');
const plain = (text) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '').replace(/[*`]/g, '');

// Ignore fenced examples, including longer fences enclosing shorter ones.
export function headings(markdown) {
  const slugger = new GithubSlugger();
  const result = [];
  let fence;
  for (const line of markdown.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      const title = plain(heading[2]);
      result.push({ level: heading[1].length, title, slug: slugger.slug(title) });
    }
  }
  return result;
}

// Resolve prose links without changing executable examples inside fenced blocks.
export function resolveLinks(markdown, base) {
  let fence;
  return markdown.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return line;
    }
    if (marker) { fence = marker[1]; return line; }
    return line.replace(/(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g, (match, prefix, target, suffix) => {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return match;
      return `${prefix}${new URL(target, base).href}${suffix}`;
    });
  }).join('\n');
}

export function generate() {
  const { version } = JSON.parse(read('package.json'));
  const sources = ['README.md', ...readdirSync(resolve(root, 'docs')).filter((name) => name.endsWith('.md')).sort().map((name) => `docs/${name}`)];
  const documents = sources.map((path) => ({ path, url: `${repository}/blob/main/${path}`, content: read(path), headings: headings(read(path)) }));
  const description = 'Ashlr MD is an open-source Markdown desktop app for macOS, Windows, and Linux, with editing, export, local AI, and a bundled MCP server.';
  const metadata = {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication',
    name: 'Ashlr MD', softwareVersion: version, description, url: site,
    license: `${repository}/blob/main/LICENSE`,
    subjectOf: { '@type': 'SoftwareSourceCode', codeRepository: repository },
    operatingSystem: ['macOS', 'Windows', 'Linux'], applicationCategory: 'DeveloperApplication',
    // README and the landing page explicitly describe the desktop app as free.
    offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD', url: `${repository}/releases` },
  };
  const capabilities = {
    schemaVersion: 1, name: metadata.name, version, description, license: 'MIT',
    url: site, repository, operatingSystem: metadata.operatingSystem,
    documentation: documents.map(({ path, url }) => ({ path, url })),
    discovery: { index: `${site}llms.txt`, fullText: `${site}llms-full.txt`, sitemap: `${site}sitemap.xml` },
    capabilities: ['markdown-reading', 'markdown-editing', 'document-export', 'local-ai', 'mcp', 'command-line'],
    interfaces: [
      { name: 'mdopener-mcp', transport: 'stdio', documentation: `${repository}/blob/main/docs/AGENTS.md` },
      { name: 'mdopen', transport: 'command-line', documentation: `${repository}/blob/main/docs/AGENTS.md` },
    ],
    limitations: ['The website is documentation, not a hosted MCP or inference endpoint.', 'Most MCP tools require the installed desktop app. See the agent guide for exceptions.', 'Local AI requires Apple Intelligence or Ollama; optional cloud providers may charge fees.'],
  };
  const intro = `# Ashlr MD\n\n> ${description}\n\nVersion: ${version}. License: MIT. The desktop app is free; optional cloud AI providers may charge fees.\n\n`;
  const index = intro + '## Documentation\n\n' + documents.map((doc) => `- [${doc.headings[0]?.title || doc.path}](${doc.url}): ${doc.path}\n` + doc.headings.filter((h) => h.level === 2).map((h) => `  - [${h.title}](${doc.url}#${h.slug})\n`).join('')).join('') + `\n## Discovery\n\n- [Full documentation](${site}llms-full.txt): Combined source documents.\n- [Capabilities](${site}capabilities.json): Machine-readable interfaces and limitations.\n`;
  // Keep relative source links useful when the combined document is fetched on its own.
  const full = intro + documents.map((doc) => `## Source: ${doc.path}\n\nCanonical documentation: ${doc.url}\n\n` + resolveLinks(doc.content, doc.url)).join('\n\n');
  const html = read('landing/index.html');
  const block = `<!-- discovery:start -->\n    <script type="application/ld+json">\n${JSON.stringify(metadata, null, 2)}\n    </script>\n    <!-- discovery:end -->`;
  const updated = html.includes('<!-- discovery:start -->')
    ? html.replace(/<!-- discovery:start -->[\s\S]*?<!-- discovery:end -->/, block)
    : html.replace('    <link rel="canonical"', `    ${block}\n    <link rel="canonical"`);
  return new Map([
    ['landing/index.html', updated],
    ['landing/llms.txt', clean(index)],
    ['landing/llms-full.txt', clean(full)],
    ['landing/capabilities.json', `${JSON.stringify(capabilities, null, 2)}\n`],
    ['landing/robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${site}sitemap.xml\n`],
    ['landing/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${site}</loc></url>\n</urlset>\n`],
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check');
  for (const [path, content] of generate()) {
    if (check) {
      let actual;
      try { actual = read(path); } catch { /* Report missing outputs as stale. */ }
      if (actual !== content) { console.error(`Stale discovery output: ${path}`); process.exitCode = 1; }
    } else writeFileSync(resolve(root, path), content);
  }
}
