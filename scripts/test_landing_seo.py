"""SEO contracts and negative controls, using only the Python standard library."""
from datetime import datetime, timezone
from pathlib import Path
import unittest
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET

from landing_seo import Document, NS, ORIGIN, REPO, ROOT, SITE, canonical, dependencies, lastmod, pages, sitemap, source_path


def claim_errors(html):
    root = Document(html).root
    errors = []
    claims = [node for node in root.all() if 'data-claim' in node.attrs]
    if not claims:
        errors.append('No claim blocks')
    for claim in claims:
        sources = [a for a in claim.all('a') if 'data-source' in a.attrs]
        if not sources:
            errors.append('Claim without a source')
        for source in sources:
            try:
                source_path(source.attrs.get('href', ''))
            except ValueError as error:
                errors.append(str(error))
    # Guide product copy must stay inside an explicitly sourced block.
    if any(n.attrs.get('class') == 'eyebrow' for n in root.all('p')):
        for node in root.all('section'):
            if 'data-claim' not in node.attrs:
                errors.append('Unmarked guide section')
        for node in root.all('p'):
            parent = node.parent
            if parent.tag == 'main' and node.attrs.get('class') != 'eyebrow':
                errors.append('Unsourced guide paragraph')
    return errors


class LandingSEOTests(unittest.TestCase):
    def test_every_claim_has_repository_evidence(self):
        for page in pages():
            with self.subTest(page=page):
                self.assertEqual(claim_errors(page.read_text()), [])

    def test_claim_validator_rejects_missing_and_invalid_sources(self):
        cases = [
            '<section data-claim><p>A claim</p></section>',
            '<section data-claim><a data-source href="https://example.com">Source</a></section>',
            f'<section data-claim><a data-source href="{REPO}missing.md">Source</a></section>',
            f'<section data-claim><a data-source href="{REPO}../../etc/passwd">Source</a></section>',
            '<main><p>A claim</p></main>',
        ]
        for html in cases:
            with self.subTest(html=html):
                self.assertTrue(claim_errors(html))
        valid = f'<section data-claim><a data-source href="{REPO}README.md">Source</a></section>'
        self.assertEqual(claim_errors(valid), [])
        # A new block cannot borrow its sibling's citation.
        self.assertTrue(claim_errors(valid + '<section data-claim>Unsourced</section>'))
        self.assertTrue(claim_errors('<p class="eyebrow">Guide</p><section>Unmarked</section>' + valid))

    def test_unique_canonicals_metadata_and_heading(self):
        titles, descriptions, urls = set(), set(), set()
        for page in pages():
            with self.subTest(page=page):
                root = Document(page.read_text()).root
                links = [n.attrs.get('href') for n in root.all('link') if n.attrs.get('rel') == 'canonical']
                self.assertEqual(links, [canonical(page)])
                self.assertNotIn(links[0], urls)
                urls.add(links[0])
                self.assertEqual(len(list(root.all('h1'))), 1)
                self.assertEqual(len(list(root.all('title'))), 1)
                import re
                title = re.search(r'<title>(.*?)</title>', page.read_text()).group(1)
                self.assertNotIn(title, titles)
                titles.add(title)
                desc = [n.attrs.get('content') for n in root.all('meta') if n.attrs.get('name') == 'description']
                self.assertEqual(len(desc), 1)
                self.assertTrue(desc[0])
                self.assertNotIn(desc[0], descriptions)
                descriptions.add(desc[0])
                og = [n.attrs.get('content') for n in root.all('meta') if n.attrs.get('property') == 'og:url']
                self.assertEqual(og, links)

    def test_internal_links_and_fragments_resolve(self):
        for page in pages():
            for node in Document(page.read_text()).root.all():
                if node.tag not in {'a', 'link', 'img', 'script'}:
                    continue
                href = node.attrs.get('href', node.attrs.get('src', ''))
                url = urlsplit(href)
                if url.scheme or url.netloc or not href:
                    continue
                path = SITE / url.path.lstrip('/') if url.path.startswith('/') else page.parent / url.path
                if not url.path:
                    path = page
                elif path.is_dir():
                    path /= 'index.html'
                with self.subTest(page=page, href=href):
                    self.assertTrue(path.is_file(), str(path))
                    if url.fragment:
                        ids = {n.attrs.get('id') for n in Document(path.read_text()).root.all()}
                        self.assertIn(unquote(url.fragment), ids)

    def test_use_case_links_reach_docs_install_and_each_other(self):
        guides = list((SITE / 'use-cases').rglob('index.html'))
        self.assertGreaterEqual(len(guides), 2)
        self.assertLessEqual(len(guides), 4)
        targets = {canonical(p).removeprefix(ORIGIN) for p in guides} | {'/docs/', '/install/'}
        for page in [SITE / 'index.html', *guides]:
            hrefs = {a.attrs.get('href') for a in Document(page.read_text()).root.all('a')}
            self.assertTrue(targets <= hrefs, str(page))

    def test_sitemap_namespace_urls_dates_and_git_freshness(self):
        xml = (SITE / 'sitemap.xml').read_bytes()
        self.assertEqual(xml, sitemap(), 'Run python3 scripts/landing_seo.py after content commits')
        root = ET.fromstring(xml)
        self.assertEqual(root.tag, f'{{{NS}}}urlset')
        entries = root.findall(f'{{{NS}}}url')
        expected = {canonical(p): p for p in pages()}
        self.assertEqual(len(entries), len(expected))
        self.assertEqual({e.findtext(f'{{{NS}}}loc') for e in entries}, set(expected))
        for entry in entries:
            self.assertEqual([e.tag for e in entry], [f'{{{NS}}}loc', f'{{{NS}}}lastmod'])
            url = entry.findtext(f'{{{NS}}}loc')
            date = entry.findtext(f'{{{NS}}}lastmod')
            self.assertEqual(date, lastmod(expected[url]))
            self.assertLessEqual(datetime.fromisoformat(date), datetime.now(timezone.utc))
            self.assertTrue(url.startswith(ORIGIN + '/'))
            self.assertFalse(urlsplit(url).fragment or urlsplit(url).query)
        self.assertIn('Sitemap: ' + ORIGIN + '/sitemap.xml', (SITE / 'robots.txt').read_text())

    def test_lastmod_tracks_styles_and_evidence(self):
        deps = dependencies(SITE / 'use-cases/markdown-export/index.html')
        self.assertIn('landing/guides.css', deps)
        self.assertIn('src/lib/export.ts', deps)
        self.assertIn('landing/use-cases/markdown-export/index.html', deps)

    def test_no_font_network_or_hidden_content_regressions(self):
        for page in pages():
            text = page.read_text()
            self.assertNotIn('fonts.googleapis.com', text)
            self.assertNotIn('fonts.gstatic.com', text)
            self.assertNotIn('\u2014', text)
            self.assertNotIn('&mdash;', text)
            for image in Document(text).root.all('img'):
                self.assertGreater(int(image.attrs.get('width', 0)), 0)
                self.assertGreater(int(image.attrs.get('height', 0)), 0)
        home = (SITE / 'index.html').read_text()
        self.assertNotIn('IntersectionObserver', home)
        self.assertNotIn('animation: rise', home)
        self.assertNotIn('feTurbulence', home)


if __name__ == '__main__':
    unittest.main()
